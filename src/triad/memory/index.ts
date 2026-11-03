/**
 * dsh-memory 插件入口（host half）：本地文件记忆引擎。
 * 挂载：
 * - session/event → turn/end 捕获 → LLM 提取候选 → 直接入库 + changes 变更流
 * - ticker → 每 N 轮增量编译 / 会话结束 final 编译 / 每日编译（衰减+折叠+滚出+daily）
 * - agent/pre-step → 记忆注入（带来源 user message，绝不写 system prompt）
 *   外带三条内置通道：zh 中文偏好 / html+iu 卡片规范 / team 团队协作
 *   （diagram 流程图通道已于 2026-10-09 随图形 iu kind 上线整体移除；
 *    Agent 邮箱声明通道已于 2026-11 随邮箱功能整体移除）
 * - tools → memory_search / memory_remember / memory_pin / memory_tag / memory_forget
 * - webServer → /api/dsh-memory/*（面板数据 + 裁决操作）
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountMemoryRoutes } from './api.js'
import { compileAll, workspaceHashOf } from './engine/compile.js'
import { prepareMemoryContent } from './engine/content-hygiene.js'
import { extractCandidatesWithOutcome, isDuplicateContent, transcriptFromEvents } from './engine/extract.js'
import { createMemoryInjector } from './engine/inject.js'
import { MemoryStore, entryIdOf, ownerOf, ownerOfSessionId, summarize } from './engine/store.js'
import { createTodoClosure, type TurnStoppingAgent } from './engine/todo-closure.js'
import { setWebuiMemoryStore } from '../memory-store-singleton.js'
import { createTicker } from './engine/ticker.js'
import { registerMemoryTools } from './tools.js'
import { applyConfigOverrides, DEFAULT_CONFIG, type ExtractCandidate, type MemoryConfig, type SessionTickerState } from './types.js'

/** Stable Cordis plugin name。 */
export const name = 'dsh-memory'

/** 硬依赖服务。 */
export const inject = ['webServer', 'tools']

/** 最小 agent 面（供提取与 ticker）。 */
interface LiveAgent {
  readonly id: string
  readonly options: { provider?: string; model?: string }
  readonly session: {
    readonly id: string
    readonly header?: { cwd?: string }
  }
}

/** 解析插件配置（config.json 运行时覆盖 + cordis.patch.yml，后者优先）。 */
function resolveConfig(input: Partial<MemoryConfig> | undefined, persisted?: Partial<MemoryConfig>): MemoryConfig {
  const config: MemoryConfig = { ...DEFAULT_CONFIG }
  // 先应用 config.json（用户运行时设置），再应用 cordis.patch.yml（代码级配置优先）。
  if (persisted !== undefined) applyConfigOverrides(config, persisted)
  applyConfigOverrides(config, input)
  return config
}

/** 应用入口。 */
export function applyMemory(ctx: Context, input: Partial<MemoryConfig> | undefined): void {
  const store = new MemoryStore()
  // 单例共享：store 是「内存态权威副本 + 全量回刷磁盘」的设计，二次实例化会
  // 各持一份内存态互相覆盖丢数据。webui 内部模块（如 tmp-cleaner 托管置顶
  // 记忆）经共享单例复用本实例，绝不自行 new MemoryStore()。
  // 注意：不能挂到 ctx 上——harness rc.8 起的 cordis 对未 declare/provide 的
  // ctx 属性赋值直接 throw（cannot set property without provide），曾导致启动崩溃。
  setWebuiMemoryStore(store)
  const config = resolveConfig(input, store.readConfigSync())
  const logError = (stage: string, error: unknown): void => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    ctx.logger?.warn?.(`[dsh-memory] ${stage}: ${message}`)
    // 落盘错误日志：DSH 控制台日志不落盘，重启后据此排查崩溃根因。
    void store.appendErrorLog(stage, message).catch(() => undefined)
  }

  // 错误处理：所有 fire-and-forget 的 async 任务统一走 ticker.enqueueSafe / 显式 catch，
  // 失败经 logError 记录到 errors.log。不再注册全局 uncaughtException/unhandledRejection
  // （避免接管 Node 崩溃语义，也避免把其它插件的错误灌进本插件日志）。

  // ── ticker：轮数 / 会话结束 / 每日（内部串行队列） ──────────────────
  const ticker = createTicker(ctx, store, config)
  ctx.effect(() => ticker.dispose, 'dsh-memory: ticker')

  // ── pre-step 注入（prepend：在下游贡献之后追加到最终 messages） ──────
  const injector = createMemoryInjector(store, config, ctx.logger)
  ctx.on('agent/pre-step', ((
    payload: { agent: LiveAgent; messages: unknown[]; signal: AbortSignal },
    next: () => Promise<{ kind: 'enter'; messages: unknown[] } | { kind: 'reject' }>,
  ) => injector.preStepListener(payload, next)) as never, { prepend: true })
  ctx.on('agent/disposed', ({ agent }) => {
    injector.disposeSession(agent.session.id)
  })

  // ── 模型工具 ─────────────────────────────────────────────────────────
  const toolsDispose = registerMemoryTools(ctx, store, config)
  ctx.effect(() => toolsDispose, 'dsh-memory: tools')

  // ── 回合结束自动收口（agent/turn-stopping）────────────────────────────
  // 为什么是 turn-stopping 而不是 session/event：见 engine/todo-closure.ts 的
  // 模块头注释（append 的 reenter 守卫 + todo/write 要求 turn 仍 open）。
  //
  // 装配与运行都独立隔离：这一块挂了只是「清单里的 in_progress 不收口」，
  // 绝不能把记忆引擎一起带走——所以挂载包 try/catch，监听器内部自己也全程
  // try/catch（turn-stopping 是 serial + awaited，抛错会毁掉用户的整个回合）。
  try {
    const closure = createTodoClosure(ctx, store, config, ctx.logger)
    ctx.effect(() => closure.dispose, 'dsh-memory: todo closure')
    ctx.on('agent/turn-stopping', ((payload: { agent: TurnStoppingAgent }) => closure.listener(payload)) as never)
    ctx.logger?.debug?.('[dsh-memory] todo closure mounted')
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-memory] todo closure failed to mount: ${error instanceof Error ? error.message : String(error)}`)
  }

  // ── HTTP API ─────────────────────────────────────────────────────────
  const routesDispose = mountMemoryRoutes(ctx, store, config)
  ctx.effect(() => routesDispose, 'dsh-memory: routes')

  // ── turn/end 捕获：提取（增量窗口） + ticker ────────────────────────
  const turnBuffers = new Map<string, Array<{ type: string; data: unknown }>>()

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      turnBuffers.set(session.id, [])
      // 新的一轮：清掉「本轮已重注过」的标记，让记忆变更在下一轮还能再触发一次
      // 重注（inject.ts 的 noteTurnStart 注释里说明了为什么需要区分轮次）。
      injector.noteTurnStart(session.id)
      return
    }
    // 压缩后重新注入：注入按设计只在会话首步做一次，而官方压缩
    // （compaction/summary + compaction/end）把早期消息块投影成一条摘要替换掉，
    // 插件注入的那条 user message 没有任何「豁免压缩」的标记——长会话压一次，
    // 记忆就永久从上下文里消失了（后面每一轮都靠 stepCounters 判定「已注入过」
    // 而静默跳过）。清掉本会话的 4 个 stepCounters，让压缩后的下一 step 重新注入。
    //
    // 两个事件都接是刻意的：summary 是内容真正落地的那一刻，end 是压缩事务结束
    // 的那一刻（失败时也发，带 error）。只听 summary 会漏掉「压缩失败但历史已被
    // 截断」的路径，只听 end 则可能早于摘要可用。disposeSession 幂等，重复清无害。
    if (event.type === 'compaction/summary' || event.type === 'compaction/end') {
      injector.disposeSession(session.id)
      ctx.logger?.debug?.('[dsh-memory] step counters reset after ' + event.type + ': ' + session.id)
      return
    }
    if (event.type === 'turn/end') {
      const buffer = turnBuffers.get(session.id) ?? []
      turnBuffers.delete(session.id)
      const turnNumber = (event.data as { turn?: number }).turn ?? 0
      // ticker 调度（计数/每日/增量编译/会话结束 final）——串行队列内。
      // 关键：Node 24 默认 unhandled rejection 会 throw 并杀死进程，
      // 所有 fire-and-forget 的 promise 必须显式 catch。
      void ticker.onTurnEnd(session.id, { id: session.id }).catch(error => logError('ticker.onTurnEnd', error))
      // 提取（LLM 失败跳过本轮，绝不阻塞；写入走同一条串行队列）。
      const agents = ctx.get('agents')
      const agent = agents?.get(session.id) as LiveAgent | undefined
      if (agent === undefined) return
      void ticker.enqueue(async () => {
        await extractTurn(ctx, store, config, agent, buffer, turnNumber)
      }).catch(error => logError('extractTurn', error))
      return
    }
    // 工具调用与结果也进缓冲：文件路径、执行结论只出现在工具结果里，而它们
    // 正是「上次那个文件在哪」这类问题的答案（收窄与截断规则见 extract.ts 的
    // transcriptFromEvents：中间过程类只留路径、单条 2000 字符、回合内合计预算）。
    if (event.type === 'user/message' || event.type === 'assistant/message'
      || event.type === 'tool/call' || event.type === 'tool/result') {
      const buffer = turnBuffers.get(session.id)
      if (buffer === undefined) return
      buffer.push({ type: event.type, data: event.data })
    }
  })

  // 退出前回刷内存态到磁盘（节流窗口内的写不丢）。
  //
  // 必须显式 catch：flush 走的是 mkdir/writeFile/rename 三个可抛的 fs 调用
  // （Windows 上 rename 覆盖被占用文件会 EPERM/EBUSY），任何一条失败都会以
  // 未处理 rejection 冒泡，而 Node 24 对此的默认行为是终止进程——插件卸载
  // 路径反而成了崩溃点，与上面 103-104 行自己定的规矩相悖。退出路径上的落盘
  // 失败只该记一条日志，不该升级成进程级故障。
  ctx.effect(
    () => () => { void store.flush().catch(error => logError('flush on dispose', error)) },
    'dsh-memory: flush on dispose',
  )

  ctx.logger?.info?.('[dsh-memory] memory engine mounted')
}

/**
 * 一轮里按「真人 user/message」切段。
 *
 * Bot 允许用户在执行中插话（`agent.steer()`）：第 2 句还没跑完时第 3 句就会
 * 作为同一个 turn 的 user/message 进来。如果整轮只抽一次，候选只能记一个
 * `turn`，撤回第 2 句时无法区分第 3 句的记忆。切段后每段各抽一次，provenance
 * 带上该段起点的 userMessageId，撤回就能按消息精确回收。
 */
interface TurnSegment {
  /** 该段起点的真人消息 id；拿不到时缺省，撤回侧退回 turn / 时间。 */
  userMessageId?: string
  events: Array<{ type: string; data: unknown }>
}

function splitTurnBuffer(buffer: Array<{ type: string; data: unknown }>): TurnSegment[] {
  const segments: TurnSegment[] = []
  let current: TurnSegment | null = null
  let leading: Array<{ type: string; data: unknown }> = []
  for (const event of buffer) {
    const data = event.data as { id?: unknown; source?: { kind?: unknown } } | undefined
    const isHuman = event.type === 'user/message' && data?.source?.kind === 'user'
    if (isHuman) {
      if (current !== null) segments.push(current)
      current = {
        ...(typeof data?.id === 'string' && data.id !== '' ? { userMessageId: data.id } : {}),
        events: [...leading, event],
      }
      leading = []
      continue
    }
    if (current !== null) current.events.push(event)
    else leading.push(event)
  }
  if (current !== null) segments.push(current)
  else if (leading.length > 0) segments.push({ events: leading })
  return segments
}

/**
 * 这一段是否已被撤回。
 *
 * 优先按消息墓碑判断（steer 场景下同一 turn 里只撤第 2 句，第 3 句的段必须
 * 继续抽取）；没有消息墓碑时才看整轮墓碑（旧数据 / 拿不到消息 id 的撤回）。
 */
function isRecalledSegment(
  store: MemoryStore,
  sessionId: string,
  turn: number,
  userMessageId: string | undefined,
): boolean {
  if (store.isMessageRecalled(sessionId, userMessageId)) return true
  return store.isTurnRecalled(sessionId, turn)
}

/** 一轮的提取与入库（提取频率由 extractEveryTurns 控制）。 */
async function extractTurn(
  ctx: Context,
  store: MemoryStore,
  config: MemoryConfig,
  agent: LiveAgent,
  buffer: Array<{ type: string; data: unknown }>,
  turnNumber: number,
): Promise<void> {
  /*
   * 该轮已被撤回：不要再调用模型提取。撤回可能发生在 turn/end 之后、本条
   * 提取任务真正执行之前——这时 buffer 里还留着被撤回的对话，如果照常跑，
   * 记忆会在撤回之后又被写回来。
   */
  if (store.isTurnRecalled(agent.session.id, turnNumber)) return
  const segments = splitTurnBuffer(buffer)
    .map(segment => ({ ...segment, transcript: transcriptFromEvents(segment.events) }))
    .filter(segment => segment.transcript.trim() !== '')
    .filter(segment => !isRecalledSegment(store, agent.session.id, turnNumber, segment.userMessageId))
  if (segments.length === 0) return
  const totalChars = segments.reduce((total, segment) => total + segment.transcript.length, 0)
  // 工作区自动记忆开关：该工作区关闭自动记忆时跳过提取（手动记忆/注入不受影响）。
  // cwd 判定失败（hash=null）时同样跳过——无法查开关就宁可不记，避免关了开关
  // 的项目因 cwd 缺失而把记忆以 global 层漏进来。
  const workspaceHash = workspaceHashOf(agent.session.header)
  if (workspaceHash === null || !(await store.isAutoMemoryEnabled(workspaceHash))) {
    ctx.logger?.debug?.(`[dsh-memory] extract skipped (auto-memory off or no cwd): ${workspaceHash ?? 'null'}`)
    return
  }
  // 频率控制：turn 编号对 extractEveryTurns 取模（turn 从 1 开始）。
  if (config.extractEveryTurns > 1 && turnNumber % config.extractEveryTurns !== 1) return

  // 失败退避：连续 3 次**真失败**（LLM 抛错 / 超时 / finish≠stop / 输出解析不出来）
  // 后降频为每 10 轮一次，避免模型 API 不稳定时每轮都白烧一次调用。
  //
  // 只看 extractFailStreak，不看 extractEmptyStreak：「模型说这轮没啥可记」是正常
  // 且被 prompt 鼓励的克制行为，拿它降频等于惩罚正确判断。旧实现把两者合并计数，
  // 实测 55% 的正常空结果把会话打进了降频态，覆盖率被系统性压低。
  const tickerState = await store.readState()
  const sessionState = tickerState.perSession[agent.id]
  if ((sessionState?.extractFailStreak ?? 0) >= 3 && turnNumber % 10 !== 1) return

  // 提取诊断：开始/结束都落盘，据此确认提取是否卡死（LLM 流不结束）或未被调用。
  //
  // 两处都必须显式 catch：appendExtractLog 内部有 mkdir / appendFile 两个可抛的
  // fs 调用（EACCES / ENOSPC / Windows 上被别的进程占住导致的 EBUSY），漏接的
  // 后果是「诊断日志写不进去」这种无害故障直接把整个 DSH 带走（未处理 rejection
  // 会终止进程）。每轮对话都会走到这两行。
  const startedAt = Date.now()
  const logLine = (line: string): void => {
    void store.appendExtractLog(line).catch(() => { /* 诊断日志写不进去就当没有 */ })
  }
  logLine(`turn=${turnNumber} chars=${totalChars} route=${agent.options.provider ?? 'default'} start`)
  // 四态结果（ok / ok-empty / parse-fail / llm-error）必须分开记：旧实现把所有
  // 路径塌缩成空数组，于是「模型说没啥可记」和「LLM 挂了」在退避逻辑里等价，
  // 正常空结果把会话打成降频态，而真失败反倒淹没在噪音里。
  //
  // 诊断日志下沉给 extract 自己写（log 参数）：失败路径也要留痕，否则线上只有
  // debug 日志时根本分不清「没调用」和「调用了但挂了」。
  const batches: Array<{ userMessageId?: string; candidates: ExtractCandidate[] }> = []
  let anyCandidates = false
  let anyFailed = false
  for (const segment of segments) {
    const result = await extractCandidatesWithOutcome(ctx, agent, segment.transcript, config, store)
    if (result.candidates.length > 0) anyCandidates = true
    if (result.outcome === 'parse-fail' || result.outcome === 'llm-error') anyFailed = true
    batches.push({ ...(segment.userMessageId !== undefined ? { userMessageId: segment.userMessageId } : {}), candidates: result.candidates })
  }
  const outcome = anyCandidates ? 'ok' : anyFailed ? 'llm-error' : 'ok-empty'
  logLine(`turn=${turnNumber} done ${Date.now() - startedAt}ms outcome=${outcome} candidates=${batches.reduce((total, batch) => total + batch.candidates.length, 0)}`)
  ctx.logger?.debug?.(`[dsh-memory] extract turn=${turnNumber} chars=${totalChars} outcome=${outcome} candidates=${batches.reduce((total, batch) => total + batch.candidates.length, 0)} route=${agent.options.provider ?? 'default'}`)
  if (!anyCandidates) {
    // 只有真失败才推高退避计数；正常空结果单独记，只用来观察「这个会话不太产
    // 记忆」的趋势，不参与降频判定。两者一旦有结果就互相清零，语义不重叠。
    const failed = anyFailed
    const latest = await store.readState()
    const per: SessionTickerState = latest.perSession[agent.id] ?? { turnCount: 0 }
    if (failed) {
      per.extractFailStreak = (per.extractFailStreak ?? 0) + 1
      per.extractEmptyStreak = 0
    } else {
      per.extractEmptyStreak = (per.extractEmptyStreak ?? 0) + 1
    }
    latest.perSession[agent.id] = per
    await store.writeState(latest)
    return
  }

  let added = 0
  let updated = 0
  let deduped = 0
  let rejected = 0
  /*
   * 本轮抽取的记忆归属：`pa-bot-v2-<botId>` → `bot:<botId>`，其余 → `work`。
   *
   * 整个 turn 只算一次（一个会话的归属不会中途变），并且**所有写入路径都必须带它**：
   * 改造前 bot 的对话会被抽成 Work 的项目记忆（两者共用 `D:\Seeker-Bot` 之外的
   * 判断只有 cwd，而 bot 的 cwd 是固定的），于是 Work 模式里突然冒出 bot 的闲聊。
   */
  const owner = ownerOfSessionId(agent.session.id)
  // 语义去重：读一次已有条目作快照；候选与已有高度重复则跳过（降 churn）。
  const existingEntries = await store.readEntries()
  for (const batch of batches) {
    if (isRecalledSegment(store, agent.session.id, turnNumber, batch.userMessageId)) continue
    for (const rawCandidate of batch.candidates) {
      // 候选循环里再查一次：LLM 提取可能跑几秒，期间用户可能刚好撤回。
      if (isRecalledSegment(store, agent.session.id, turnNumber, batch.userMessageId)) break
      // 内容卫生：先清洗形式噪声，再硬拒确定垃圾（占位词 / 纯称呼元信息 / 空）。
      // 放在去重之前是刻意的：清洗会改内容，先洗后比才能让「同一句话带不带 markdown
      // 残符」落进同一个 id（entryIdOf 由 content 推导，洗与不洗会得到两个不同的 id，
      // 于是同一句话能存两条）。拒绝则连比都不用比。
      const prepared = prepareMemoryContent(rawCandidate.content)
      if ('rejected' in prepared) {
        rejected += 1
        ctx.logger?.debug?.(`[dsh-memory] candidate rejected (${prepared.rejected}): ${rawCandidate.content.slice(0, 60)}`)
        continue
      }
      const candidate = { ...rawCandidate, content: prepared.content }
      // 工作区判定失败 → 回退 global（design §8）。
      let scope: 'global' | 'project' = candidate.scope
      let hash: string | null = null
      if (scope === 'project') {
        hash = workspaceHashOf(agent.session.header)
        if (hash === null) scope = 'global'
      }
      // 语义去重：跳过与已有记忆高度重复的候选（不写 change，避免提取→consolidate 再删的浪费）。
      // 去重范围必须与写入范围一致：同 owner 同 scope 同项目才算「已有」，
      // 否则两个 bot 说同一句话会互相把对方的候选判成重复而都不落库。
      const sameScope = existingEntries.filter(entry =>
        ownerOf(entry) === owner
        && entry.scope === scope
        && (scope === 'global' || entry.projectHash === hash))
      if (isDuplicateContent(candidate.content, sameScope)) {
        deduped += 1
        continue
      }
      // 变更对比：update 时记录旧内容（before，必须在 upsert 前读取）。
      const beforeEntry = await store.getEntry(entryIdOf(candidate.content, scope, hash, owner))
      const { created, entry } = await store.upsertEntry({
        content: candidate.content,
        scope,
        projectHash: hash,
        owner,
        tags: candidate.tags,
        importance: candidate.importance,
        source: 'extract',
        // 溯源：记下产生该条目的会话与轮次（KR 右栏记忆卡按 sessionId 判定
        // 「本会话新增」，不再用浏览器时间基线猜）。userMessageId 用于 steer
        // 插话场景：同一个 turn 里第 2/3 句都能按消息精确撤回。
        provenance: {
          sessionId: agent.session.id,
          turn: turnNumber,
          ...(batch.userMessageId !== undefined ? { userMessageId: batch.userMessageId } : {}),
        },
        // 待确认制：开启时自动抽取的条目挂 pending，不检索/不注入/不编译，
        // 等用户在面板确认。关闭时（默认）直接生效，保持旧行为。
        pending: config.extractRequireConfirm === true ? true : undefined,
        // 临时信息有效期（「今天要发 36 条」这类）：入库但到点后不再注入。
        // 缺省不传 = 永久有效；提取 prompt 已要求模型对能界定有效期的内容标它。
        ttlDays: candidate.ttlDays,
      })
      /*
       * 落库后再查一次：撤回可能发生在上面的 await 期间。新条目直接删掉；
       * 更新已有条目的情况保留旧条目内容（无法无损回滚时不把旧记忆一起误删）。
       */
      if (isRecalledSegment(store, agent.session.id, turnNumber, batch.userMessageId)) {
        if (created) await store.removeEntry(entry.id)
        continue
      }
      existingEntries.push(entry)
      // 项目层首次落盘时确保 meta.json 存在（否则面板项目列表看不到该项目）。
      if (scope === 'project' && hash !== null) {
        const meta = await store.readProjectMeta(hash)
        if (meta === undefined) {
          await store.writeProjectMeta(hash, {
            path: agent.session.header?.cwd ?? '未知工作区',
            alias: null,
            locked: false,
          })
        }
      }
      if (created) added += 1
      else updated += 1
      await store.appendChange({
        action: created ? 'add' : 'update',
        entryId: entry.id,
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: summarize(entry.content),
        before: beforeEntry?.content,
        after: entry.content,
      })
    }
  }
  // 成功（有候选）：两套计数一起清零——有产出就既不是失败、也不再是连续空结果。
  const successState = await store.readState()
  const successPer: SessionTickerState = successState.perSession[agent.id] ?? { turnCount: 0 }
  successPer.extractFailStreak = 0
  successPer.extractEmptyStreak = 0
  successState.perSession[agent.id] = successPer
  await store.writeState(successState)
  // 有新增/更新时刷新产物（增量编译）。
  if (added + updated > 0) {
    await compileAll(store, config)
    ctx.logger?.debug?.(`[dsh-memory] extracted ${added} new, ${updated} updated, ${deduped} deduped, ${rejected} rejected`)
  }
}
