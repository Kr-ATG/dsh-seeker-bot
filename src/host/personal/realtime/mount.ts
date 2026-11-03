/**
 * 把实时语音接进 DSH 宿主（cordis 适配层）。
 *
 * 与 index.ts 分开的原因：index.ts 是纯 node 实现（可离线端到端测试），这里只做
 * 「从 cordis 服务里拿凭据/设置 → 注册路由 → 卸载时回收」这三件与框架相关的事。
 * 混在一起会让测试被迫造一个假 ctx。
 *
 * ## 配置从哪来（优先级从高到低）
 *
 * 1. **插件 config**（profile 的 `cordis.patch.yml` 里本插件行下的 `personalRealtime:`）——
 *    显式配置，改完重启宿主即生效，适合写进版本库/同步：
 *
 * ```yaml
 * - id: dsh-seeker-bot
 *   config:
 *     personalRealtime:
 *       keyRef: STEPPLAN_API_KEY
 *       upstream: wss://api.stepfun.com/v1/realtime
 *       model: stepaudio-3-realtime-preview   # 留空则用默认回退链
 *       voice: linjiajiejie
 *       webSearch: false
 * ```
 *
 * 2. **settings 命名空间 `personal-realtime`**（运行时设置，无需重启）。
 * 3. 内置默认值：`STEPPLAN_API_KEY` + 官方地址 + 模型回退链 + 音色 `linjiajiejie`。
 *
 * 全部字段都可选：一个都不配也能跑。
 */

import { pickVendor, readUserConfig, writeUserConfig } from './config-store.ts'
import { ensureBotAgent, runBotTurn, type BotAgentSpec, type BotPermission, type PersonalStreamEvent, type TurnResult } from '../agent.ts'
import { injectWorkingMemoryIntoAgent } from '../working-memory.ts'
import {
  REALTIME_DEFAULT_KEY_REF,
  REALTIME_DEFAULT_UPSTREAM,
  REALTIME_CONFIG_PATH,
  REALTIME_DIAGNOSE_PATH,
  REALTIME_KEY_PATH,
  REALTIME_MODELS,
  REALTIME_PATH,
  type RealtimeArtifact,
  type RealtimeConfig,
} from '../../../shared/realtime-protocol.ts'
import { createRealtimeConfigHandler, createRealtimeKeyHandler, createRealtimeDiagnoseHandler, createRealtimeUpgradeHandler, primeRealtimeKeyState, type RealtimeOptions } from './index.ts'

/** 插件 config 里本模块的配置形状（全部可选）。 */
export interface PersonalRealtimeConfig {
  keyRef?: string
  upstream?: string
  model?: string
  voice?: string
  webSearch?: boolean
}

/**
 * 用户级配置的落盘位置与读写（实现见 config-store.ts）。
 *
 * 抽到单独文件是为了能被 `scripts/test-realtime-proxy.mjs` 用 `DSH_HOME` 隔离测试。
 */

/**
 * 取一个非空字符串：**用户设置优先，其次插件 config（部署级）**。
 *
 * 顺序不能反：用户在界面上改了值，必须立刻生效；插件 config 只是「没配时的兜底」。
 * 两者都空就返回 null，让调用方落到内置默认。
 */
function pickString(
  config: PersonalRealtimeConfig,
  configKey: keyof PersonalRealtimeConfig,
  user: RealtimeConfig,
  userKey: keyof RealtimeConfig,
): string | null {
  const fromUser = user[userKey]
  if (typeof fromUser === 'string' && fromUser.trim() !== '') return fromUser.trim()
  const fromConfig = config[configKey]
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim()
  return null
}

/**
 * 从 agent 的一轮结果里收集产物（图片 / 视频 / 文件）。
 *
 * 宿主的 blocks 里，生图/生视频产物挂在 `{ type:'tool', run: { images, videos } }`
 * 上（`ToolRun.images` / `.videos` 是同源 URL 列表）。前端拿到 `task_done.artifacts`
 * 后会把它们落成对话流里的普通图片消息——用户要能在对话里看到那张图、点开看大图，
 * 只让模型念一句「生成好了」是不够的。
 */
function collectArtifacts(result: TurnResult): RealtimeArtifact[] {
  const artifacts: RealtimeArtifact[] = []
  const seen = new Set<string>()
  const push = (kind: RealtimeArtifact['kind'], url: unknown): void => {
    if (typeof url !== 'string' || url === '') return
    if (seen.has(url)) return
    seen.add(url)
    artifacts.push({ kind, url })
  }
  for (const block of result.blocks) {
    if (block === null || typeof block !== 'object') continue
    if ((block as { type?: unknown }).type !== 'tool') continue
    const run = (block as { run?: unknown }).run
    if (run === null || typeof run !== 'object') continue
    const images = (run as { images?: unknown }).images
    if (Array.isArray(images)) for (const url of images) push('image', url)
    const videos = (run as { videos?: unknown }).videos
    if (Array.isArray(videos)) for (const url of videos) push('video', url)
  }
  return artifacts
}

/**
 * 把 agent 的一轮结果压成「一句话结论」。
 *
 * 语音模型拿到这段后会用自己的话转述，所以不需要保留 Markdown / 工具细节，只取
 * 文本块、截断到 1500 字。没有文本块时给一句占位——否则模型会收到空结果，只能
 * 说「不知道」，用户会以为任务没执行。
 */
function summarizeTurn(result: TurnResult): string {
  const texts: string[] = []
  for (const block of result.blocks) {
    if (block === null || typeof block !== 'object') continue
    if ((block as { type?: unknown }).type !== 'text') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string' && text.trim() !== '') texts.push(text.trim())
  }
  const joined = texts.join('\n').trim()
  return joined === '' ? '任务已完成（没有可转述的文本结果，产物已在工作区）' : joined.slice(0, 1500)
}

/**
 * 挂载实时语音路由。
 *
 * webServer / credentials 任一缺失时静默跳过（cordis 的延迟注入天然如此），
 * 不影响 Bot 模式的其它能力。
 */
export function applyPersonalAgentRealtime(ctx: any, config: PersonalRealtimeConfig = {}): void {
  ctx.inject(['webServer', 'credentials'], (webCtx: any) => {
    const log = (message: string): void => {
      try {
        console.warn(`[dsh-seeker-bot]${message}`)
      } catch {
        /* 日志不可用 */
      }
    }

    const options: RealtimeOptions = {
      /*
       * 凭据解析：**只有这里能碰到 key**。
       *
       * 每次 start 都重新解析一次，而不是缓存：用户可能在设置里换 key，重启太重，
       * 缓存会让「改了没生效」变成一个很难查的问题。credentials.resolve 本身有缓存。
       */
      resolveApiKey: async (keyRef) => {
        // 供应商 Live 配置里指定的凭据名优先（`?route=stepplan` 那套），否则用全局/部署配置
        const user = readUserConfig()
        const ref = (typeof keyRef === 'string' && keyRef.trim() !== '' ? keyRef.trim() : null)
          ?? pickString(config, 'keyRef', user, 'keyRef')
          ?? REALTIME_DEFAULT_KEY_REF
        try {
          const resolved = await webCtx.credentials?.resolve?.(ref)
          const value = resolved?.value
          return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
        } catch {
          return null
        }
      },
      upstreamUrl: () => {
        const user = readUserConfig()
        return pickString(config, 'upstream', user, 'upstream') ?? REALTIME_DEFAULT_UPSTREAM
      },
      models: () => {
        const user = readUserConfig()
        const single = pickString(config, 'model', user, 'model')
        return single === null ? REALTIME_MODELS : [single]
      },
      voice: () => {
        const user = readUserConfig()
        return pickString(config, 'voice', user, 'voice') ?? ''
      },
      webSearch: () => {
        /*
         * **默认开**：语音会话里模型没有别的联网手段（Bot 在聊天里能调的 agent
         * 工具不在 Realtime 会话里），关掉就等于用户问实时信息时只能听「我查不了」。
         * 用户设置优先（false 才关），其次插件 config，都没有就是开。
         */
        const user = readUserConfig()
        if (typeof user.webSearch === 'boolean') return user.webSearch
        if (config.webSearch === false) return false
        return true
      },
      speed: () => {
        const user = readUserConfig()
        const value = user.speed
        return value === 'slow' || value === 'fast' || value === 'normal' ? value : 'normal'
      },
      /*
       * 设置页读到的配置：**一份全局配置 + 用户自己维护的 Live 供应商列表**。
       * 注意这里不含任何密钥值，只有凭据名。
       */
      readConfig: () => {
        const user = readUserConfig()
        const out: RealtimeConfig = { vendors: user.vendors }
        if (user.defaultVendor !== undefined && user.defaultVendor !== '') out.defaultVendor = user.defaultVendor
        const voice = pickString(config, 'voice', user, 'voice')
        if (voice !== null) out.voice = voice
        const speed = user.speed
        if (speed === 'slow' || speed === 'fast' || speed === 'normal') out.speed = speed
        if (typeof user.webSearch === 'boolean') out.webSearch = user.webSearch
        return out
      },
      /*
       * 设置页写入：落到插件自己的 `realtime-config.json`（**不改插件 config**——
       * 那是部署配置，用户改界面不该动它）。`vendors` 整体覆盖（增删改都靠它）。
       */
      writeConfig: async (patch) => {
        writeUserConfig(patch)
      },
      /*
       * 选 Live 供应商：Bot 上选的 id → 全局默认 → 列表第一条。
       */
      resolveVendor: (id) => pickVendor(readUserConfig(), id),
      /*
      /*
       * 让用户在设置页直接填 API Key。
       *
       * 走 DSH 的 credentials 服务（不是自己存文件）：key 由凭据库加密保管，也不会
       * 出现在本插件的配置文件里。响应只回引用名，绝不回显值。
       */
      writeCredential: async (ref, value) => {
        const credentials = webCtx.credentials
        if (typeof credentials?.set !== 'function') {
          throw new Error('宿主凭据服务不支持写入（credentials.set 不存在）')
        }
        await credentials.set(ref, value)
      },
      /*
       * 语音里「干活」的执行器：跑 Bot 真正的 agent loop。
       *
       * 语音链路（Realtime）本身没有任何 agent 工具，模型判定要动手时调 `run_task`，
       * 最终落到这里。执行期间对话照常进行（官方 Voice Agent 的设计），结果回来
       * 由模型用语音转述。
       *
       * 三条边界：
       *  - **权限**：用 Bot 自己的 `permission` 档位跑，和聊天里完全一致（不做降级，
       *    否则语音就成了绕过审批的后门）。
       *  - **超时**：180 秒。生图 / 长命令可能慢，但不能无限挂着——到点回一句
       *    「超时了」，让模型有话说，而不是让用户干等。
       *  - **结果截断**：agent 正文可能几千字，塞给语音模型既烧 token 又让它念很久，
       *    这里截到 1500 字并让它自己总结。
       */
      runTask: async ({ task, agent, signal, onProgress }) => {
        if (agent === undefined) return { ok: false, error: '没有 Bot 定义，无法执行任务' }
        const spec: BotAgentSpec = {
          botId: agent.botId,
          name: agent.name,
          role: agent.role,
          description: agent.description,
          instructions: agent.instructions,
          model: agent.model,
          permission: agent.permission as BotPermission | undefined,
          memories: agent.memories,
        }
        const emit = (event: PersonalStreamEvent): void => {
          if (event.type !== 'tool') return
          if (event.run.status !== 'running') return
          onProgress?.(`正在使用 ${event.run.name}`)
        }
        /*
         * 工作记忆注入（与 index.ts 的 /reply 同一套）。
         *
         * 语音里让 Bot「动手」时，它同样需要知道手上有什么活、做到哪一步——
         * 否则用户说「接着弄昨天那个」时，通话里的 Bot 会像第一次听说。
         * `agent.inject()` 写的是面向模型的上下文：不显示给用户，也不会被
         * 记忆提取当成用户原话。
         *
         * 失败一律吞掉：注入失败最多是这轮少一点上下文，绝不能连累通话本身
         * （`runBotTurn` 自己会把 agent 建不起来的错误报出来）。
         */
        try {
          const liveAgent = await ensureBotAgent(webCtx, spec)
          await injectWorkingMemoryIntoAgent(liveAgent, spec.botId)
        } catch {
          /* agent 建不起来：交给 runBotTurn 报错 */
        }
        const timeout = AbortSignal.timeout(180_000)
        // AbortSignal.any：挂断（signal）与超时任一触发都要停
        const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
        try {
          const result = await runBotTurn(webCtx, spec, task, emit, combined)
          if (!result.ok) return { ok: false, error: result.error ?? '执行失败（agent 未给出原因）' }
          return { ok: true, summary: summarizeTurn(result), artifacts: collectArtifacts(result) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // 中止（挂断 / 超时）时给一句人话，别把 AbortError 原文抛给模型
          return { ok: false, error: message.toLowerCase().includes('abort') ? '任务被中止（超时或通话已结束）' : message }
        }
      },
      log,
    }

    // 升级路由：一条连接只能有一个协议主人，重复注册会抛（webServer 自己会挡）
    webCtx.effect(() => webCtx.webServer.registerUpgrade({
      path: REALTIME_PATH,
      handler: createRealtimeUpgradeHandler(options),
    }), 'dsh-seeker-bot: realtime voice upgrade route')

    // 诊断路由：只读、不含密钥，用来回答「为什么打不通」
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: REALTIME_DIAGNOSE_PATH,
      handler: createRealtimeDiagnoseHandler(options),
    }), 'dsh-seeker-bot: realtime voice diagnose route')

    // 设置路由：供应商详情页与 Bot 设置读写全局默认（模型 / 音色 / 语速 / 联网）
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: REALTIME_CONFIG_PATH,
      handler: createRealtimeConfigHandler(options),
    }), 'dsh-seeker-bot: realtime voice config route')

    // 凭据写入：设置页里直接填 API Key（只写不读，响应不回显密钥）
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: REALTIME_KEY_PATH,
      handler: createRealtimeKeyHandler(options),
    }), 'dsh-seeker-bot: realtime voice key route')

    /*
     * 挂载时先探一次凭据，让诊断路由第一次被打开就有结论（否则它是 null，
     * 得先发起一次通话才知道有没有配 key）。
     */
    primeRealtimeKeyState(options)
  })
}

