/**
 * 全双工实时语音的宿主半身：浏览器同源 WebSocket ⇄ StepFun Realtime API 的薄代理。
 *
 * 这一层只做四件事，其它一概不管（音频采集/播放全在浏览器）：
 *
 * 1. **鉴权与凭据**：API Key 只在这里出现，绝不回传前端。浏览器的 WebSocket 不能
 *    自定义请求头，把 key 放进 URL 又会泄漏到历史/日志/截图，所以必须由宿主代连。
 * 2. **会话配置**：按 Bot 人设拼 `session.update`（音色、VAD、模态、指令）。
 * 3. **事件翻译**：上游事件 → 我们的协议（见 session.ts），下行音频原样转发。
 * 4. **生命周期**：模型回退、30 分钟上限、双向关断、错误分类。
 *
 * 这个文件**不依赖 cordis**：`createRealtimeUpgradeHandler` 是纯函数工厂，
 * 既给 DSH 的 `webServer.registerUpgrade` 用（见 mount.ts），也能在裸
 * `node:http` server 上做端到端测试（见 scripts/test-realtime-proxy.mjs）。
 */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  REALTIME_DEFAULT_UPSTREAM,
  REALTIME_DIAGNOSE_PATH,
  REALTIME_CONFIG_PATH,
  REALTIME_KEY_PATH,
  REALTIME_MAX_SESSION_MS,
  REALTIME_PATH,
  REALTIME_WARN_BEFORE_MS,
  REALTIME_MODELS,
  REALTIME_VENDORS,
  REALTIME_VOICES,
  parseClientMessage,
  speedToSpeechRate,
  type RealtimeAgentSpec,
  type RealtimeArtifact,
  type RealtimeClientMessage,
  type RealtimeConfig,
  type RealtimeVendorRecord,
  REALTIME_DEFAULT_VOICE,
  DEFAULT_REALTIME_VENDORS,
  type RealtimeServerMessage,
  type RealtimeSpeed,
  type RealtimeVendor,
} from '../../../shared/realtime-protocol.ts'
import { acceptUpgrade, isWebSocketUpgrade, type WsPeer } from './ws-frame.ts'
import { connectUpstream, UpstreamError } from './upstream.ts'
import { buildSessionUpdate, IGNORED_UPSTREAM_EVENTS, mapUpstreamEvent, readyMessage, wrapVoiceInstructions } from './session.ts'

/** 宿主侧注入的配置与能力。 */
export interface RealtimeOptions {
  /**
   * 取 API Key。
   * @param keyRef 该供应商 Live 配置里指定的凭据名（留空用宿主默认）。
   * @returns null 表示没配置。
   */
  resolveApiKey: (keyRef?: string) => Promise<string | null>
  /**
   * 按 id 找 Live 供应商。
   *
   * @param id `start.vendor`（Bot 上单独选的）；空/找不到时由实现方回落到全局默认。
   * @returns 找不到返回 null（宿主会回一条「还没有配置任何 Live 供应商」）。
   */
  resolveVendor?: (id?: string) => RealtimeVendorRecord | null
  /** 上游地址，默认 `wss://api.stepfun.com/v1/realtime`。 */
  upstreamUrl?: () => string | undefined
  /** 模型候选（按顺序回退），默认 REALTIME_MODELS。 */
  models?: () => readonly string[] | undefined
  /** 默认音色。 */
  voice?: () => string | undefined
  /** 是否开启上游内置联网搜索（默认开）。 */
  webSearch?: () => boolean | undefined
  /** 语速档位（只能靠 instructions 表达，见 speedInstruction 的注释）。 */
  speed?: () => RealtimeSpeed | undefined
  /**
   * 读某个供应商的 Live 配置（全局默认 + 该供应商覆盖）。
   * @param route 供应商路由 id；不传只读全局默认。
   */
  readConfig?: () => RealtimeConfig
  /** 写配置（给设置页用）。失败要抛出带可读原因的错误。 */
  writeConfig?: (patch: RealtimeConfig) => Promise<void>
  /**
   * 写一条凭据（设置页里让用户直接填 API Key）。
   *
   * @param ref DSH credentials 的引用名（如 `STEPPLAN_API_KEY`）。
   * @param value 密钥明文；实现方负责落到凭据服务，**不要把值回传给前端**。
   */
  writeCredential?: (ref: string, value: string) => Promise<void>
  /**
   * 真正执行一次「语音里交代的任务」（跑 Bot 的 agent loop）。
   *
   * 语音链路本身没有 agent 的工具；模型判定要动手时会调用 `run_task`，宿主把它
   * 交到这里。实现方（mount.ts）负责调 `runBotTurn`、把结果压成一句话、并处理
   * 权限与超时。
   */
  runTask?: (request: {
    callId: string
    task: string
    botId: string
    agent?: RealtimeAgentSpec
    /** 挂断时中止（实现方应把它转给 agent 的取消信号）。 */
    signal?: AbortSignal
    /** 进度回调（工具开始跑时推一句话给前端；可选）。 */
    onProgress?: (note: string) => void
  }) => Promise<{ ok: boolean; summary?: string; error?: string; artifacts?: RealtimeArtifact[] }>
  /** 日志出口。 */
  log?: (message: string) => void
}

/** 诊断信息（不含任何密钥值）。 */
export interface RealtimeDiagnostics {
  configured: boolean
  keyRef: string
  upstream: string
  models: readonly string[]
  voice: string
  /** 最近一次失败（给「为什么打不通」一个答案）。 */
  lastError: { message: string; at: number } | null
}

/**
 * 模块级诊断状态：只留最近一次失败与最近一次凭据探测结果。
 *
 * 为什么放在模块级而不是每个会话里：用户报「点通话没反应」时，前端已经关掉了，
 * 会话对象也回收了，只有这里还留着原因。诊断路由读它。
 *
 * 为什么要缓存凭据探测结果：诊断路由必须**同步**应答（见 createRealtimeDiagnoseHandler
 * 的注释），而凭据解析是异步的。所以解析发生在会话 start 时，这里只记录结论。
 */
const diagnostics: {
  lastError: { message: string; at: number } | null
  keyState: { configured: boolean | null; at: number }
  /**
   * 不认识的上游事件类型计数。
   *
   * 上游换版本改名时（`response.audio.delta` → 别的名字），事件会掉进
   * mapUpstreamEvent 的 default 分支被静默丢弃，表现是「连上了但没声音/没字幕、
   * 零报错」。这个计数器让诊断路由能一眼回答「是不是事件名漂移了」。
   */
  unknownEvents: Map<string, number>
  /**
   * 最近一次工具调用的现场（给诊断路由用）。
   *
   * 为什么留这个：语音里「让它干活」失败时，用户能看到的只有模型的一句「没成功」。
   * 到底是上游没给参数、参数形状不对、还是根本没触发，只有这里能回答。**只留预览，
   * 不留完整参数**（里面可能有用户说的私事）。
   */
  lastFunctionCall: {
    callId: string
    name: string
    source: string
    argsPreview: string
    /** 参数是否为空（空参数是「item.created 早于 delta」的典型症状）。 */
    emptyArgs: boolean
    at: number
  } | null
} = {
  lastError: null,
  keyState: { configured: null, at: 0 },
  unknownEvents: new Map(),
  lastFunctionCall: null,
}

/** 读当前配置（不含 key 值）。 */
export function readRealtimeDiagnostics(options: RealtimeOptions): RealtimeDiagnostics {
  const upstream = options.upstreamUrl?.() ?? REALTIME_DEFAULT_UPSTREAM
  const models = options.models?.() ?? REALTIME_MODELS
  return {
    configured: diagnostics.keyState.configured === true,
    keyRef: 'STEPPLAN_API_KEY',
    upstream,
    models: models.length === 0 ? REALTIME_MODELS : models,
    voice: options.voice?.() ?? '',
    lastError: diagnostics.lastError,
  }
}

/** 把上游地址和模型名拼成最终 URL（地址里已有 model= 时不重复加）。 */
export function buildUpstreamUrl(base: string, model: string): string {
  if (/[?&]model=/.test(base)) return base
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}model=${encodeURIComponent(model)}`
}

/** 一次会话（一个浏览器连接 + 一个上游连接）。 */
class RealtimeBridge {
  private readonly client: WsPeer
  private readonly options: RealtimeOptions
  private upstream: WsPeer | null = null
  private model = ''
  private voice = ''
  private readySent = false
  private responseActive = false
  private closed = false
  private warnTimer: NodeJS.Timeout | null = null
  private endTimer: NodeJS.Timeout | null = null
  /** 会话就绪的兜底定时器（见 announceReady 的注释）。 */
  private readyTimer: NodeJS.Timeout | null = null
  /** 最近一次 session.update 的 event_id（用于识别「是哪条 update 被拒」）。 */
  private updateEventId = ''
  /** 这次 update 有没有带 tools（被拒时才知道该不该降级重发）。 */
  private toolsEnabled = false
  /** 本次会话的供应商（决定采样率、音频格式名、语速表达方式）。 */
  /** 本次会话用的 Live 供应商 id（诊断用）。 */
  private vendorId = ''
  /** 这次 update 有没有注册 `run_task`（同上，降级时一并去掉）。 */
  private agentToolsEnabled = false
  /** start 帧带来的 Bot 定义；语音里「干活」全靠它。 */
  private agentSpec: RealtimeAgentSpec | undefined
  /**
   * 已经在跑 / 跑过的任务 call_id。
   *
   * 上游可能把同一次 function_call 的完成事件发两遍（重连、乱序），没有这个集合
   * 就会把同一个任务跑两遍——生图这种有副作用的操作尤其不能重复。
   */
  private readonly agentTasks = new Set<string>()
  /**
   * 正在收集参数的 function_call：`call_id → { name, args }`。
   *
   * 为什么需要它：`conversation.item.created` 不带 arguments，参数要靠
   * `...arguments.delta` 逐片生成。把 delta 拼起来，才能在 `done` 的 arguments
   * 为空时兜底（部分上游就是这样发的）。
   */
  private readonly pendingCalls = new Map<string, { name: string; args: string }>()
  /** 当前所有在跑的任务共用的取消信号（挂断时一并中止）。 */
  private taskAbort: AbortController | null = null
  /** 下发过的 instructions / voice：降级重发时要原样复用。 */
  private instructions = ''
  /** 用户主动挂断时为真：上游关断不再当作故障。 */
  private stoppedByUser = false
  /**
   * 正在建连中。
   *
   * 必须有这个标志：`start()` 里要先 await 凭据、再 await 上游握手，这两段期间
   * `this.upstream` 仍然是 null。前端重复点击或自动重连连发两条 start 时，只靠
   * `upstream !== null` 短路会**建出两条上游连接**——后一条覆盖前一条，前一条成了
   * 永不关闭的孤儿（持续占 StepFun 并发与计费）。
   */
  private starting = false

  constructor(client: WsPeer, options: RealtimeOptions) {
    this.client = client
    this.options = options
  }

  /** 浏览器发来一条文本控制帧。 */
  async onClientText(raw: string): Promise<void> {
    const message = parseClientMessage(raw)
    if (message === null) return
    try {
      switch (message.type) {
        case 'start':
          await this.start(message)
          return
        case 'audio':
          this.forwardAudio(Buffer.from(String(message.audio ?? ''), 'base64'))
          return
        case 'text':
          this.forwardText(String(message.text ?? ''))
          return
        case 'interrupt':
          this.interrupt()
          return
        case 'stop':
          this.stoppedByUser = true
          this.send({ type: 'closed', reason: '通话已结束' })
          this.shutdown()
          return
        default:
          return
      }
    } catch (error) {
      // 这里兜住任何漏网的异常：调用方是 `void bridge.onClientText(...)`，
      // 一旦 reject 就是 unhandledRejection，而且前端收不到任何消息（表现为
      // 「点通话没反应」）。宁可回一条可读错误，也不要静默卡死。
      const reason = `实时语音处理失败：${error instanceof Error ? error.message : String(error)}`
      diagnostics.lastError = { message: reason, at: Date.now() }
      this.fail(reason, false)
    }
  }

  /** 浏览器发来一段裸 PCM16 二进制：直接转发成 base64 的 append 事件。 */
  onClientBinary(payload: Buffer): void {
    this.forwardAudio(payload)
  }

  /** 浏览器断开。 */
  onClientClose(): void {
    this.shutdown()
  }

  /** 开一次会话：取 key → 连上游（模型回退）→ 下发 session.update。 */
  private async start(message: Extract<RealtimeClientMessage, { type: 'start' }>): Promise<void> {
    if (this.upstream !== null || this.starting) return // 重复 start 忽略（含建连中的重入）
    this.starting = true
    try {
      await this.openSession(message)
    } finally {
      this.starting = false
    }
  }

  /** start 的实际内容（拆出来是为了让 starting 标志的 finally 覆盖整段）。 */
  private async openSession(message: Extract<RealtimeClientMessage, { type: 'start' }>): Promise<void> {
    const log = this.options.log ?? ((): void => {})
    /*
     * 选 Live 供应商：`start.vendor`（Bot 上单独选的）→ 全局默认 → 列表第一条。
     *
     * 这取代了旧版「按聊天供应商 route 取配置、再从三个写死预设里挑一个」的做法——
     * 用户明确否掉了那个设计（那不是新增供应商）。现在供应商是用户自己维护的列表，
     * 一条就是一个能连的 Realtime 端点 + 一把 key + 一个模型。
     */
    const vendor = this.options.resolveVendor?.(message.vendor) ?? null
    if (vendor === null) {
      const reason = '还没有配置任何 Live 供应商：到「设置 → 供应商 → 实时语音」里新增一个'
      diagnostics.lastError = { message: reason, at: Date.now() }
      this.fail(reason, false)
      return
    }
    this.vendorId = vendor.id
    const keyRef = vendor.keyRef
    let key: string | null
    try {
      key = await this.options.resolveApiKey(keyRef)
    } catch (error) {
      // 凭据服务本身炸了（不是「没配」）：必须回一条可读错误，否则前端永远卡在连接中
      const reason = `读取实时语音凭据失败：${error instanceof Error ? error.message : String(error)}`
      diagnostics.keyState = { configured: null, at: Date.now() }
      diagnostics.lastError = { message: reason, at: Date.now() }
      this.fail(reason, false)
      return
    }
    diagnostics.keyState = { configured: key !== null && key.trim() !== '', at: Date.now() }
    if (key === null || key.trim() === '') {
      const reason = `Live 供应商「${vendor.label}」的凭据「${keyRef}」还没配：到「设置 → 供应商 → 实时语音」里粘贴 API Key，或到 DSH 凭据里补上`
      diagnostics.lastError = { message: reason, at: Date.now() }
      this.fail(reason, false)
      return
    }

    const base = vendor.upstream
    /*
     * 音色 / 语速 / 联网是**全局**的（用户明确说新增供应商「只填最少的」：名称、地址、
     * Key、模型，其余用默认）。Bot 上单独设过音色就以 Bot 为准。
     */
    const voice = String(message.voice ?? '').trim() !== ''
      ? String(message.voice).trim()
      : (this.options.voice?.() ?? REALTIME_DEFAULT_VOICE)
    // 模型：start 帧显式指定 > 该 Live 供应商配的模型 > 宿主候选链
    const candidates = String(message.model ?? '').trim() !== ''
      ? [String(message.model).trim()]
      : (String(vendor.model ?? '').trim() !== ''
        ? [String(vendor.model).trim()]
        : (this.options.models?.() ?? REALTIME_MODELS))
    const list = candidates.length === 0 ? REALTIME_MODELS : candidates
    const speed = this.options.speed?.()
    // 千问有真实语速参数；StepFun 只能把语速写进 instructions（见 wrapVoiceInstructions）
    const speechRate = speedToSpeechRate(speed)
    const webSearch = this.options.webSearch?.() !== false
    const instructions = wrapVoiceInstructions(String(message.instructions ?? ''), speed)
    /*
     * Bot 的 agent 定义：语音里「干活」全靠它。没有它就只能注册 web_search，
     * 用户让生成图片时模型会说「我没有这个功能」。
     */
    this.agentSpec = message.agent
    const agentTools = this.agentSpec !== undefined && this.options.runTask !== undefined

    let lastError: Error | null = null
    for (const model of list) {
      const url = buildUpstreamUrl(base, model)
      try {
        this.upstream = await connectUpstream({
          url,
          apiKey: key,
          handlers: {
            onMessage: (text) => this.onUpstreamText(text),
            onClose: (code, reason) => this.onUpstreamClose(code, reason),
            onError: (error) => log(`[realtime] 上游错误：${error.message}`),
          },
        })
        this.model = model
        this.voice = voice
        this.instructions = instructions
        this.toolsEnabled = webSearch
        this.agentToolsEnabled = agentTools
        this.updateEventId = `evt_update_${Date.now().toString(36)}`
        this.upstream.sendText(JSON.stringify(buildSessionUpdate({
          instructions,
          voice,
          webSearch: this.toolsEnabled,
          agentTools,
          eventId: this.updateEventId,
          vendor,
          speechRate,
        })))
        log(`[realtime] 已连接上游 vendor=${vendor} model=${model} voice=${voice} tools=${[
          this.toolsEnabled ? 'web_search' : '',
          agentTools ? 'run_task' : '',
        ].filter((item) => item !== '').join('+') || 'off'}`)
        this.armTimers()
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        const detail = lastError instanceof UpstreamError && lastError.status !== undefined
          ? `HTTP ${lastError.status}`
          : '连接失败'
        log(`[realtime] 模型 ${model} ${detail}：${lastError.message}`)
        // 鉴权类错误换模型也没用，直接停
        if (lastError instanceof UpstreamError && (lastError.status === 401 || lastError.status === 403)) break
      }
    }

    const reason = lastError === null
      ? '实时语音上游不可用'
      : `实时语音连接失败：${lastError.message}`
    diagnostics.lastError = { message: reason, at: Date.now() }
    const retryable = lastError instanceof UpstreamError ? lastError.retryable : false
    this.fail(reason, retryable)
  }

  /** 上游来了一条 JSON 事件。 */
  private onUpstreamText(raw: string): void {
    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed === null || typeof parsed !== 'object') return
      event = parsed as Record<string, unknown>
    } catch {
      return
    }
    const type = typeof event.type === 'string' ? event.type : ''

    /*
     * 会话就绪的时机很关键，不能见 `session.created` 就宣布 ready。
     *
     * `session.created` 是上游在**连接建立时自动发**的，此刻我们刚发出去的
     * `session.update`（VAD 配置、音色、指令）还没生效。此时发 ready，前端会立刻
     * 开始上行音频——那前几百毫秒按的是默认配置（`turn_detection` 默认是关的），
     * 用户开头的几个字会被当成「没人说话」丢掉，表现为「第一句总是缺半句」。
     *
     * 所以：`session.updated` 才算真就绪；万一上游不发 updated（实现差异），
     * 800ms 后兜底宣布，不至于让通话卡在「接通中」。
     */
    if (type === 'session.created') {
      if (!this.readySent && this.readyTimer === null) {
        this.readyTimer = setTimeout(() => {
          this.readyTimer = null
          this.announceReady(event)
        }, 800)
        this.readyTimer.unref?.()
      }
      return
    }
    if (type === 'session.updated') {
      this.announceReady(event)
      return
    }

    if (type === 'response.created') this.responseActive = true

    /*
     * 工具调用的参数收集与执行。
     *
     * 这里踩过一个真实的坑（用户实测截图：模型说「我来生成图片」，然后回「任务描述为空，
     * 没能执行」，连续重试三次都失败）：**`conversation.item.created` 本身不带
     * `arguments`**。官方文档的示例里它只有 `id` / `type` / `status` / `call_id` / `name`，
     * 参数是之后由 `response.function_call_arguments.delta` 逐片生成的，最后
     * `...arguments.done` 才给完整值。所以在 item.created 上就执行，必然拿到空参数。
     *
     * 现在的顺序：
     *   · `...arguments.delta` → 只累积（有些上游的 done 里 arguments 是空的，全靠它兜底）
     *   · `...arguments.done`  → 执行（正常路径）
     *   · `conversation.item.created`(function_call) → 只登记 name/call_id，**不执行**
     *   · `response.done` → 兜底：output 里若还有没执行过的 function_call，用它的 arguments 执行
     */
    if (type === 'response.function_call_arguments.delta') {
      const callId = String(event.call_id ?? '')
      const delta = String(event.delta ?? event.arguments ?? '')
      if (callId !== '' && delta !== '') {
        const current = this.pendingCalls.get(callId) ?? { name: '', args: '' }
        current.args += delta
        this.pendingCalls.set(callId, current)
      }
      return
    }
    if (type === 'response.function_call_arguments.done') {
      this.dispatchFunctionCall(
        String(event.call_id ?? ''),
        String(event.name ?? ''),
        String(event.arguments ?? ''),
        'arguments.done',
      )
      return
    }
    if (type === 'conversation.item.created') {
      const item = event.item
      if (item !== null && typeof item === 'object' && (item as { type?: unknown }).type === 'function_call') {
        const detail = item as Record<string, unknown>
        const callId = String(detail.call_id ?? detail.id ?? '')
        if (callId === '') return
        const inlineArgs = typeof detail.arguments === 'string' ? detail.arguments : ''
        const name = typeof detail.name === 'string' ? detail.name : ''
        if (inlineArgs.trim() !== '') {
          /*
           * 有些上游（以及测试里的假上游）会在 item.created 里直接给完整参数。
           * 有参数就执行——但**只在参数非空时**：真实 StepFun 的 item.created 只有
           * `id/type/status/call_id/name`，此时执行必然拿到空参数。
           */
          this.dispatchFunctionCall(callId, name, inlineArgs, 'item.created')
          return
        }
        // 只登记：此刻还没有参数，等 ...arguments.delta / ...arguments.done 补齐
        const current = this.pendingCalls.get(callId) ?? { name: '', args: '' }
        if (name !== '') current.name = name
        this.pendingCalls.set(callId, current)
        return
      }
      return
    }
    if (type === 'response.done') {
      this.responseActive = false
      /*
       * 兜底一：有些上游只在 `response.done` 的 output 里给出完整的 function_call。
       */
      const response = event.response
      if (response !== null && typeof response === 'object') {
        const output = (response as { output?: unknown }).output
        if (Array.isArray(output)) {
          for (const entry of output) {
            if (entry === null || typeof entry !== 'object') continue
            const detail = entry as Record<string, unknown>
            if (detail.type !== 'function_call') continue
            this.dispatchFunctionCall(
              String(detail.call_id ?? ''),
              String(detail.name ?? ''),
              String(detail.arguments ?? ''),
              'response.done',
            )
          }
        }
      }
      /*
       * 兜底二：整轮都结束了，`pendingCalls` 里还有「参数已拼齐但没等到 done」的调用
       * （有些上游只发 delta + response.done）。不清掉的话这次调用就永远丢了。
       */
      for (const [pendingId, pending] of [...this.pendingCalls.entries()]) {
        if (pending.args.trim() === '') continue
        this.dispatchFunctionCall(pendingId, pending.name, pending.args, 'response.done+delta')
      }
      // 不 return：下面还要把 response_done 转发给前端
    }

    // 「没有正在进行的响应可取消」是打断与 VAD 抢跑的无害竞态，不要弹给用户
    if (type === 'error') {
      const nested = event.error !== null && typeof event.error === 'object' ? event.error as Record<string, unknown> : null
      const message = String(nested?.message ?? event.message ?? '')
      if (message.includes('no ongoing response')) return
      /*
       * 我们发的 session.update 被上游拒了（通常是某个字段它不认识——最可能是
       * `tools` 里内置 web_search 的形状）。这时**降级重发**：去掉 tools 再来一次，
       * 用户至少能通话，只是没有联网搜索。不这么做的话整条会话会停在默认配置上
       * （VAD 没开、音色没设），比没有搜索严重得多。
       */
      const errorEventId = String(nested?.event_id ?? event.event_id ?? '')
      if (errorEventId !== '' && errorEventId === this.updateEventId) {
        diagnostics.unknownEvents.set('session.update 被拒', (diagnostics.unknownEvents.get('session.update 被拒') ?? 0) + 1)
        this.options.log?.(`[realtime] session.update 被上游拒绝：${message}；将去掉 tools 重发`)
        if (this.toolsEnabled) this.resendUpdateWithoutTools(message)
        return
      }
    }

    const mapped = mapUpstreamEvent(event)
    if (mapped !== null) {
      this.send(mapped)
      return
    }
    // 已知忽略的事件不计数；不认识的才记——见 diagnostics.unknownEvents 的注释
    if (type !== '' && !IGNORED_UPSTREAM_EVENTS.has(type)) {
      diagnostics.unknownEvents.set(type, (diagnostics.unknownEvents.get(type) ?? 0) + 1)
      this.options.log?.(`[realtime] 未识别的上游事件：${type}（可能是上游改了事件名，前端将收不到对应数据）`)
    }
  }

  /**
   * `session.update` 被上游拒绝后的降级重发：去掉 tools，其它配置原样再来一次。
   *
   * 只关搜索、不放弃整条会话——VAD 配置和音色比联网重要得多。
   */
  private resendUpdateWithoutTools(reason: string): void {
    const upstream = this.upstream
    if (upstream === null) return
    this.toolsEnabled = false
    this.updateEventId = `evt_update_${Date.now().toString(36)}_nt`
    try {
      upstream.sendText(JSON.stringify(buildSessionUpdate({
        instructions: this.instructions,
        voice: this.voice,
        webSearch: false,
        eventId: this.updateEventId,
      })))
      diagnostics.lastError = {
        message: `内置联网搜索未启用（上游拒绝 tools：${reason}）；通话其余功能正常`,
        at: Date.now(),
      }
    } catch {
      /* 上游已断：onUpstreamClose 会接手 */
    }
  }

  /**
   * 分派一次工具调用（各种上游事件形状最后都汇到这里）。
   *
   * 参数有两条来源，按可靠度取：事件自带的 `arguments` → `pendingCalls` 里由 delta
   * 拼出来的那份。**空参数绝不能直接执行**——那会得到「任务描述为空」这种对用户毫无
   * 意义的失败（实测踩过：模型连试三次，每次都这样）。
   */
  private dispatchFunctionCall(callId: string, name: string, args: string, source = ''): void {
    const log = this.options.log ?? ((): void => {})
    if (callId === '') {
      /*
       * 没有 call_id 就没法回灌结果（`function_call_output` 必须带它），任务注定
       * 执行不了。至少要留痕并告诉前端——静默吞掉会表现成「模型说要干活，然后没下文」。
       */
      const reason = '上游的工具调用缺少 call_id，任务无法执行'
      log(`[realtime] ${reason}（name=${name || '(空)'}）`)
      this.send({ type: 'error', message: reason, retryable: false })
      return
    }
    const pending = this.pendingCalls.get(callId)
    const resolvedName = name !== '' ? name : (pending?.name ?? '')
    const resolvedArgs = args.trim() !== '' ? args : (pending?.args ?? '')
    diagnostics.lastFunctionCall = {
      callId,
      name: resolvedName,
      source,
      argsPreview: resolvedArgs.slice(0, 200),
      emptyArgs: resolvedArgs.trim() === '',
      at: Date.now(),
    }
    if (resolvedName !== 'run_task') {
      if (resolvedName !== '') log(`[realtime] 未知的工具调用：${resolvedName}`)
      return
    }
    this.pendingCalls.delete(callId)
    if (resolvedArgs.trim() === '') {
      /*
       * 参数确实还没到（item.created 早于 delta）。不能在这里判失败：正常时序下
       * 随后就会来 done。真正判失败的地方在 runAgentTask（那里 task 解析完仍为空）。
       * 这里只是把「参数为空」的情况留在日志里，便于排查上游形状差异。
       */
      log(`[realtime] 工具调用 ${callId} 的参数为空（等后续 done/delta 补齐）`)
    }
    void this.runAgentTask(callId, resolvedArgs)
  }

  /**
   * 跑一个语音任务：把 `run_task` 的参数交给 Bot 的 agent loop。
   *
   * 整条链路是**异步**的——任务跑着的时候用户还能继续说话（官方 Voice Agent 的
   * 设计就是「任务运行期间对话仍可继续」），结果回来时再插一轮响应。
   */
  private async runAgentTask(callId: string, rawArgs: string): Promise<void> {
    if (this.agentTasks.has(callId)) return // 幂等：同一 call_id 只跑一次
    this.agentTasks.add(callId)
    const log = this.options.log ?? ((): void => {})

    // 参数一般是 {"task":"..."}；模型偶尔给非 JSON，那就把原文当任务描述（丢掉更糟）
    /*
     * 从 arguments 里抠出任务描述。
     *
     * 宽容度是有意的：模型可能用 `task` 以外的键名（schema 只是建议），也可能把参数
     * 写成非 JSON 的纯文本。任何一种都不该变成「任务描述为空」——那对用户毫无意义
     * （实测踩过：模型连试三次，每次都这么失败）。
     */
    const TASK_KEYS = ['task', 'query', 'prompt', 'description', 'instruction', 'input', 'text', 'content']
    let task = ''
    try {
      const parsed = JSON.parse(rawArgs) as unknown
      if (typeof parsed === 'string') {
        task = parsed
      } else if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        for (const key of TASK_KEYS) {
          const value = record[key]
          if (typeof value === 'string' && value.trim() !== '') {
            task = value
            break
          }
        }
        // 一个认识的键都没有：把整个对象当任务描述（至少别丢信息）
        if (task === '') {
          const values = Object.values(record).filter((value) => typeof value === 'string' && value.trim() !== '')
          task = values.length > 0 ? values.join('\n') : JSON.stringify(record)
        }
      }
    } catch {
      task = rawArgs
    }
    task = task.trim().slice(0, 2000)
    if (task === '') {
      // 到这一步才真的没拿到参数：把「上游没给参数」如实告诉模型，让它重新调用一次，
      // 而不是让用户看到一句无意义的技术错误。
      log(`[realtime] 任务参数为空 call=${callId} raw=${rawArgs.slice(0, 120)}`)
      await this.finishAgentTask(callId, {
        ok: false,
        error: '没有收到任务描述（工具参数是空的）。请重新调用一次 run_task，并在 task 参数里写清要做什么。',
      })
      return
    }

    this.send({ type: 'task_started', callId, task })
    log(`[realtime] 任务开始 call=${callId} task=${task.slice(0, 60)}`)

    const runner = this.options.runTask
    const agent = this.agentSpec
    if (runner === undefined) {
      await this.finishAgentTask(callId, { ok: false, error: '宿主未提供任务执行能力' })
      return
    }
    if (agent === undefined) {
      await this.finishAgentTask(callId, { ok: false, error: '这通电话没有携带 Bot 定义，无法执行任务' })
      return
    }

    this.taskAbort ??= new AbortController()
    let result: { ok: boolean; summary?: string; error?: string; artifacts?: RealtimeArtifact[] }
    try {
      result = await runner({
        callId,
        task,
        botId: agent.botId,
        agent,
        signal: this.taskAbort.signal,
        onProgress: (note) => {
          if (this.closed || note.trim() === '') return
          this.send({ type: 'task_progress', callId, note: note.slice(0, 200) })
        },
      })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (this.closed) return
    log(`[realtime] 任务结束 call=${callId} ok=${result.ok}`)
    await this.finishAgentTask(callId, result)
  }

  /**
   * 把任务结果交回上游，并推给前端。
   *
   * **顺序很重要：先回灌上游、再通知前端**。反过来的话，一旦 sendText 抛错（上游
   * 恰好断了），前端已经显示「任务完成」而模型永远收不到结果——用户会听到沉默，
   * 却以为一切正常。
   *
   * output 写成「给模型看的结果」而不是「给用户看的原文」：模型拿到后会用自己的话
   * 讲一遍，所以这里显式要求口语化、不要念格式。
   */
  private async finishAgentTask(
    callId: string,
    result: { ok: boolean; summary?: string; error?: string; artifacts?: RealtimeArtifact[] },
  ): Promise<void> {
    const upstream = this.upstream
    const output = result.ok
      ? `任务已完成。执行结果：\n${(result.summary ?? '已完成').slice(0, 2000)}\n\n请用一两句口语向用户汇报，不要念出这段格式，也不要重复「任务已完成」这几个字。`
      : `任务执行失败：${result.error ?? '未知原因'}\n\n请用一两句话如实告诉用户失败了以及原因，不要假装成功，也不要说「系统提示」这类话。`
    if (upstream !== null && !this.closed) {
      try {
        upstream.sendText(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output },
        }))
        upstream.sendText(JSON.stringify({ type: 'response.create' }))
      } catch {
        /* 上游已断：onUpstreamClose 会接手 */
      }
    }
    this.send({
      type: 'task_done',
      callId,
      ok: result.ok,
      summary: result.summary,
      error: result.error,
      // 产物一并下发：前端要把它们落成对话流里的图片/文件消息（只让模型念一句不够）
      ...(result.artifacts !== undefined && result.artifacts.length > 0 ? { artifacts: result.artifacts } : {}),
    })
  }

  /**
   * 宣布会话就绪（只发一次）。
   *
   * 上游返回的 `voice` / `model` 优先于我们请求的值：上游可能拒绝我们的音色并
   * 回落到默认值，前端要显示的是**实际生效**的那个，否则用户会以为音色没换成功。
   */
  private announceReady(event: Record<string, unknown>): void {
    if (this.readySent) return
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.readySent = true
    const session = event.session !== null && typeof event.session === 'object'
      ? event.session as Record<string, unknown>
      : null
    if (typeof session?.voice === 'string' && session.voice !== '') this.voice = session.voice
    if (typeof session?.model === 'string' && session.model !== '') this.model = session.model
    this.send(readyMessage({
      model: this.model,
      voice: this.voice,
      maxSessionMs: REALTIME_MAX_SESSION_MS,
      vendor: this.vendorId,
    }))
  }

  /** 上游断开。 */
  private onUpstreamClose(code: number, reason: string): void {
    this.upstream = null
    if (this.closed) return
    if (this.stoppedByUser) {
      this.send({ type: 'closed', reason: '通话已结束' })
    } else if (code === 1000) {
      this.send({ type: 'closed', reason: '上游正常结束会话' })
    } else {
      const message = `实时语音上游断开（${code}${reason === '' ? '' : `：${reason}`}）`
      diagnostics.lastError = { message, at: Date.now() }
      this.send({ type: 'error', message, code, retryable: true })
      this.send({ type: 'closed', reason: message })
    }
    this.shutdown()
  }

  /** 上行音频：PCM16 → base64 → `input_audio_buffer.append`。 */
  private forwardAudio(pcm: Buffer): void {
    if (this.upstream === null || pcm.length === 0) return
    this.upstream.sendText(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcm.toString('base64'),
    }))
  }

  /** 打字输入：走文本消息 + 触发一轮响应。 */
  private forwardText(text: string): void {
    const value = text.trim()
    if (this.upstream === null || value === '') return
    this.upstream.sendText(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: value }],
      },
    }))
    this.upstream.sendText(JSON.stringify({ type: 'response.create' }))
  }

  /**
   * 用户打断。
   *
   * 服务端 VAD 模式下，用户一开口上游自己就会停；这里补一发 `response.cancel`
   * 是为了「用户点了打断按钮但还没出声」这种纯客户端打断。
   *
   * **不判断 `responseActive`**：真实网络里 `response.created` 可能还没到、或者
   * 已经和 `response.done` 交错，靠本地状态判断会漏发。多发一次的代价只是上游回
   * 一条「没有可取消的响应」——那条错误在 onUpstreamText 里被过滤掉了。
   */
  private interrupt(): void {
    if (this.upstream !== null) {
      this.upstream.sendText(JSON.stringify({ type: 'response.cancel' }))
    }
    this.responseActive = false
    this.send({ type: 'interrupted' })
  }

  /** 30 分钟上限：到点前提示，到点前 15 秒收尾。 */
  private armTimers(): void {
    this.disarmTimers()
    this.warnTimer = setTimeout(() => {
      this.send({ type: 'expiring', inMs: REALTIME_WARN_BEFORE_MS })
    }, Math.max(1000, REALTIME_MAX_SESSION_MS - REALTIME_WARN_BEFORE_MS))
    this.endTimer = setTimeout(() => {
      this.send({ type: 'closed', reason: '单次语音通话最长 30 分钟，已自动结束（再拨一次即可继续）' })
      this.shutdown()
    }, Math.max(2000, REALTIME_MAX_SESSION_MS - 15_000))
    this.warnTimer.unref?.()
    this.endTimer.unref?.()
  }

  private disarmTimers(): void {
    if (this.warnTimer !== null) clearTimeout(this.warnTimer)
    if (this.endTimer !== null) clearTimeout(this.endTimer)
    this.warnTimer = null
    this.endTimer = null
  }

  /** 发一条事件给浏览器。 */
  private send(message: RealtimeServerMessage): void {
    if (this.closed) return
    try {
      this.client.sendText(JSON.stringify(message))
    } catch {
      /* 浏览器已断开 */
    }
  }

  /** 报错并关掉这次会话。 */
  private fail(message: string, retryable: boolean): void {
    this.send({ type: 'error', message, retryable })
    this.send({ type: 'closed', reason: message })
    this.shutdown()
  }

  /** 双向关断（幂等）。 */
  shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.disarmTimers()
    // 未完成的工具调用参数一并丢掉：会话已关，再执行也没地方回灌
    this.pendingCalls.clear()
    // 挂断时中止还在跑的 agent 任务：留着它继续跑会白烧模型调用，而且结果没人接收
    if (this.taskAbort !== null) {
      try {
        this.taskAbort.abort()
      } catch {
        /* 已中止 */
      }
      this.taskAbort = null
    }
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    const upstream = this.upstream
    this.upstream = null
    if (upstream !== null) {
      try {
        upstream.close(1000, 'client closed')
      } catch {
        upstream.destroy()
      }
    }
    try {
      this.client.close(1000, 'session closed')
    } catch {
      this.client.destroy()
    }
  }
}

/**
 * 判断升级请求是否来自同源页面（挡跨站 WebSocket 劫持）。
 *
 * 只看 Origin 与 Host 的 host 部分是否一致——与 personal/index.ts 的 `crossSite()`
 * 保持同一口径，避免两套准入规则。
 */
function crossSiteUpgrade(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false // 非浏览器客户端放行（测试/脚本）
  const host = req.headers.host
  try {
    return typeof host !== 'string' || new URL(origin).host !== host
  } catch {
    return true
  }
}

/** 拒绝升级时回一个明确的 HTTP 状态，再断开。 */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
  } catch {
    /* 已断开 */
  }
  socket.destroy()
}

/**
 * 造一个 HTTP upgrade 处理器：可以直接交给 `server.on('upgrade')`，
 * 也可以交给 DSH 的 `webServer.registerUpgrade`。
 */
export function createRealtimeUpgradeHandler(options: RealtimeOptions): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const log = options.log ?? ((): void => {})
  return (req, socket, head) => {
    if (!isWebSocketUpgrade(req)) {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    if (crossSiteUpgrade(req)) {
      log('[realtime] 拒绝跨站 WebSocket 升级')
      // 回 403 而不是静默 destroy：前端能拿到「被拒」而不是一个无原因的 1006，
      // 反代改写 Host 导致的误拒也能从状态码上认出来。
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    let bridge: RealtimeBridge | null = null
    const peer = acceptUpgrade(req, socket, head, {
      onMessage: (text) => {
        void bridge?.onClientText(text)
      },
      onBinary: (payload) => bridge?.onClientBinary(payload),
      onClose: () => bridge?.onClientClose(),
      onError: (error) => log(`[realtime] 浏览器连接错误：${error.message}`),
    })
    bridge = new RealtimeBridge(peer, options)
  }
}

/**
 * 后台探一次凭据并写进诊断缓存（不阻塞调用方）。
 *
 * 挂载时调一次，诊断路由第一次被打开就有结论；否则用户得先发起一次通话才知道
 * 「到底有没有配 key」。
 */
export function primeRealtimeKeyState(options: RealtimeOptions): void {
  void Promise.resolve()
    .then(() => options.resolveApiKey())
    .then((key) => {
      diagnostics.keyState = { configured: key !== null && key.trim() !== '', at: Date.now() }
    })
    .catch(() => {
      diagnostics.keyState = { configured: null, at: Date.now() }
    })
}

/**
 * 造诊断路由的处理器（GET，返回不含密钥的配置与最近失败）。
 *
 * **必须同步写响应**：这个处理器可能被挂在裸 `node:http` server 上，而 server 上
 * 通常已经有一个 `createServer(handler)` 的 404 handler。诊断若在 `await` 里让出
 * 事件循环，404 handler 会先把响应 `end()` 掉，客户端拿到的是空 body（实测踩过）。
 * 所以凭据状态读缓存，真正的解析放在后台刷新。
 */
export function createRealtimeDiagnoseHandler(options: RealtimeOptions): (req: IncomingMessage, res: { statusCode?: number; setHeader: (k: string, v: string) => void; end: (body?: string) => void }) => void {
  return (_req, res) => {
    const payload = {
      ok: true,
      /** true=有凭据；false=没配；null=还没探测过（下次再问，或先发起一次通话）。 */
      configured: diagnostics.keyState.configured,
      keyRef: 'STEPPLAN_API_KEY',
      checkedAt: diagnostics.keyState.at,
      upstream: options.upstreamUrl?.() ?? REALTIME_DEFAULT_UPSTREAM,
      models: options.models?.() ?? REALTIME_MODELS,
      voice: options.voice?.() ?? '',
      lastError: diagnostics.lastError,
      /** 不认识的上游事件类型与次数：非空说明上游可能改了事件名。 */
      unknownEvents: Object.fromEntries(diagnostics.unknownEvents),
      /**
       * 最近一次「语音里让 Bot 干活」的现场。任务失败时先看这里：
       * `emptyArgs: true` 说明上游在参数还没生成时就通知了工具调用。
       */
      lastFunctionCall: diagnostics.lastFunctionCall,
      sampleRate: 24_000,
    }
    try {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    } catch {
      /* 已断开 */
    }
    // 后台刷新凭据状态，供下一次诊断读到；失败也不影响本次响应
    void Promise.resolve()
      .then(() => options.resolveApiKey())
      .then((key) => {
        diagnostics.keyState = { configured: key !== null && key.trim() !== '', at: Date.now() }
      })
      .catch(() => {
        diagnostics.keyState = { configured: null, at: Date.now() }
      })
  }
}

/**
 * 造设置路由的处理器（`GET|POST /api/personal-agent/realtime/config`）。
 *
 * 供应商详情页与 Bot 设置都从这里读写「全局默认」的实时语音配置；Bot 自己的音色
 * 存在 Bot 记录里（前端 localStorage），通话时通过 `start` 帧的 `voice` 覆盖。
 *
 * 只回/收白名单字段，且**永远不返回密钥值**（`keyRef` 只是凭据名）。
 */
export function createRealtimeConfigHandler(options: RealtimeOptions): (req: IncomingMessage, res: import('node:http').ServerResponse) => void {
  const send = (res: import('node:http').ServerResponse, status: number, payload: unknown): void => {
    try {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    } catch {
      /* 已断开 */
    }
  }
  return (req, res) => {
    void (async () => {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method === 'GET' || method === 'HEAD') {
        const config = options.readConfig?.() ?? {}
        send(res, 200, {
          ok: true,
          config,
          voices: REALTIME_VOICES,
          models: options.models?.() ?? REALTIME_MODELS,
          /*
           * 内置预设整份下发：设置页「新增供应商」时可以拿它做模板（选 StepFun 就
           * 自动填好上游地址与凭据名），也可以完全不用它自己填。
           */
          presets: DEFAULT_REALTIME_VENDORS,
          // 设置页要显示「实际能用的默认值」，所以把宿主侧的兜底一并给出
          defaults: {
            voice: options.voice?.() ?? '',
            webSearch: options.webSearch?.() !== false,
            speed: options.speed?.() ?? 'normal',
          },
        })
        return
      }
      if (method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (options.writeConfig === undefined) {
        send(res, 501, { ok: false, error: '当前宿主不支持写入实时语音配置' })
        return
      }
      // 读请求体（上限 64KB：这里只有几个短字段）
      const chunks: Buffer[] = []
      let size = 0
      let tooLarge = false
      await new Promise<void>((resolve) => {
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 64 * 1024) {
            tooLarge = true
            resolve()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', resolve)
        req.on('error', resolve)
      })
      if (tooLarge) {
        send(res, 413, { ok: false, error: '配置过大' })
        return
      }
      let body: Record<string, unknown>
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
        body = parsed as Record<string, unknown>
      } catch {
        send(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      // 只接受白名单字段，其余忽略（防止把任意键写进配置文件）
      const patch: RealtimeConfig = {}
      /*
       * `vendors` 整体覆盖：列表的新增 / 编辑 / 删除都靠它。
       * 逐条在这里过一遍类型，非法条目直接丢弃（半个供应商写进配置只会更难查）。
       */
      if (Array.isArray(body.vendors)) {
        patch.vendors = body.vendors
          .map((raw): RealtimeVendorRecord | null => {
            if (raw === null || typeof raw !== 'object') return null
            const source = raw as Record<string, unknown>
            const id = typeof source.id === 'string' ? source.id.trim() : ''
            const upstream = typeof source.upstream === 'string' ? source.upstream.trim() : ''
            const keyRef = typeof source.keyRef === 'string' ? source.keyRef.trim() : ''
            if (id === '' || upstream === '' || keyRef === '') return null
            const record: RealtimeVendorRecord = {
              id,
              label: typeof source.label === 'string' && source.label.trim() !== '' ? source.label.trim() : id,
              upstream,
              keyRef,
            }
            if (typeof source.model === 'string' && source.model.trim() !== '') record.model = source.model.trim()
            const inputRate = Number(source.inputSampleRate)
            if (Number.isFinite(inputRate) && inputRate >= 8000 && inputRate <= 48000) record.inputSampleRate = Math.round(inputRate)
            const outputRate = Number(source.outputSampleRate)
            if (Number.isFinite(outputRate) && outputRate >= 8000 && outputRate <= 48000) record.outputSampleRate = Math.round(outputRate)
            return record
          })
          .filter((item): item is RealtimeVendorRecord => item !== null)
      }
      if (typeof body.defaultVendor === 'string') patch.defaultVendor = body.defaultVendor.trim()
      if (typeof body.voice === 'string') patch.voice = body.voice.trim()
      if (body.speed === 'slow' || body.speed === 'normal' || body.speed === 'fast') patch.speed = body.speed
      if (typeof body.webSearch === 'boolean') patch.webSearch = body.webSearch
      try {
        await options.writeConfig(patch)
        send(res, 200, { ok: true, config: options.readConfig?.() ?? patch })
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  }
}

/**
 * 造凭据写入路由的处理器（`POST /api/personal-agent/realtime/key`）。
 *
 * 让用户在设置页里**直接填 API Key**，而不是先想办法把它塞进 DSH 凭据库。
 * 三条硬约束：
 *  1. 只写不读——响应体里永远不回显密钥值，只回「写成功了，引用名是 X」；
 *  2. ref 必须是合法标识符（大写字母/数字/下划线），防止拿它当路径或注入；
 *  3. 值长度设上限，避免一次误粘贴几百 KB 把凭据库撑坏。
 */
export function createRealtimeKeyHandler(options: RealtimeOptions): (req: IncomingMessage, res: import('node:http').ServerResponse) => void {
  const send = (res: import('node:http').ServerResponse, status: number, payload: unknown): void => {
    try {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    } catch {
      /* 已断开 */
    }
  }
  return (req, res) => {
    void (async () => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (options.writeCredential === undefined) {
        send(res, 501, { ok: false, error: '当前宿主不支持写入凭据' })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let tooLarge = false
      await new Promise<void>((resolve) => {
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 16 * 1024) {
            tooLarge = true
            resolve()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', resolve)
        req.on('error', resolve)
      })
      if (tooLarge) {
        send(res, 413, { ok: false, error: '请求过大' })
        return
      }
      let body: Record<string, unknown>
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
        body = parsed as Record<string, unknown>
      } catch {
        send(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      const ref = String(body.ref ?? '').trim()
      const value = String(body.value ?? '').trim()
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(ref)) {
        send(res, 400, { ok: false, error: '凭据名只能是大写字母、数字与下划线，且以字母开头' })
        return
      }
      if (value === '') {
        send(res, 400, { ok: false, error: '密钥为空' })
        return
      }
      if (value.length > 4096) {
        send(res, 400, { ok: false, error: '密钥过长' })
        return
      }
      try {
        await options.writeCredential(ref, value)
        // 只回引用名，绝不回显密钥本身
        send(res, 200, { ok: true, ref })
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  }
}

/**
 * 把实时语音路由挂到一个裸 `node:http` server 上（测试与独立部署用）。
 *
 * DSH 里不要用这个——那边用 `webServer.registerUpgrade` + `register`（见 mount.ts），
 * 这样卸载由 cordis 的 effect 管。
 *
 * @returns 卸载函数。
 */
export function attachRealtimeRoutes(server: Server, options: RealtimeOptions): () => void {
  const upgrade = createRealtimeUpgradeHandler(options)
  const diagnose = createRealtimeDiagnoseHandler(options)
  const config = createRealtimeConfigHandler(options)
  const key = createRealtimeKeyHandler(options)

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname = ''
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== REALTIME_PATH) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    upgrade(req, socket, head)
  }

  const onRequest = (req: IncomingMessage, res: import('node:http').ServerResponse): void => {
    let pathname = ''
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return
    }
    if (pathname !== REALTIME_DIAGNOSE_PATH && pathname !== REALTIME_CONFIG_PATH && pathname !== REALTIME_KEY_PATH) return
    // 已经被别的 handler 应答过就不要再写（裸 server 上常见）
    if (res.headersSent || res.writableEnded) return
    if (pathname === REALTIME_CONFIG_PATH) {
      config(req, res)
      return
    }
    if (pathname === REALTIME_KEY_PATH) {
      key(req, res)
      return
    }
    if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
      res.statusCode = 405
      res.end()
      return
    }
    diagnose(req, res)
  }

  server.on('upgrade', onUpgrade)
  /*
   * 用 prependListener 而不是 on：`createServer(handler)` 的那个 handler 是第一个
   * 'request' 监听器，后注册的监听器只能拿到已经被 404 掉的响应。诊断路由必须抢先，
   * 否则外面永远是一条空 body（实测踩过）。
   */
  server.prependListener('request', onRequest)
  return () => {
    server.off('upgrade', onUpgrade)
    server.off('request', onRequest)
  }
}


