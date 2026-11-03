/**
 * Personal Agent — 撤回一轮对话（host 侧）。
 *
 * ## 为什么单独一个文件
 *
 * 撤回是「会话上下文手术」：读 surface、算区间、追加 replace 事件、落盘。
 * 它与 agent.ts 里「建会话 / 跑一轮」的职责不同，独立出来更好读，也避免和
 * 那边频繁的改动互相踩。
 *
 * ## 机制
 *
 * Session 日志是 append-only 的事实记录（崩溃恢复、审计靠它），没有删除 API。
 * 但 surface（模型可见消息序列）支持 `replace`——compaction 用的同一机制：
 * 追加一条新节点，把指定区间整体替换掉。之后 `deriveMessages()` 重建历史时
 * 这些内容就不在了。所以「撤回」= 日志保留 + 上下文消失。
 *
 * ## 语义边界
 *
 * 只影响**之后的模型上下文**：模型在产生那条回复的那一步已经看过原文，
 * 这里保证的是「后续对话不再带着它」。真正的遗忘要靠用户清空对话。
 *
 * ## 定位
 *
 * 前端只有本地消息（localStorage），没有 session seq，所以按「真人输入
 * （`source.kind === 'user'`）+ 文本完全相等 + 时间最接近」反查。撤回范围 =
 * 该节点到下一条真人输入之前（含 assistant / tool / 注入上下文节点）。
 */
import { randomUUID } from 'node:crypto'
import { ensureBotAgent, type BotAgentSpec } from './agent.ts'
import { purgeWorkingTasksForTurn } from './working-memory.ts'
import { getWebuiMemoryStore } from '../../triad/memory-store-singleton.ts'
import { isEntryFromRecalledTurn, type RecalledTurnScope } from '../../triad/memory/engine/recall-scope.ts'

/** 撤回结果。 */
export interface RecallResult {
  ok: boolean
  /** 被遮蔽的 surface 节点数（用户消息 + 该轮 bot 回复 + 工具结果 + 注入上下文）。 */
  removed?: number
  /** 同时从记忆引擎删掉的条目数（「连记忆一起」那一半）。 */
  memoriesRemoved?: number
  /** 同时从工作记忆删掉的任务数（按 sessionId + turn 精确回收）。 */
  workingTasksRemoved?: number
  /** 被撤回的轮次号（0 = 未能定位，只按时间窗口兼容旧数据）。 */
  turn?: number
  /** 被撤回的真人消息 id（有它时记忆 / 工作记忆按消息精确回收）。 */
  userMessageId?: string
  error?: string
  /** 落盘失败原因（撤回本身已生效，只是重启后会丢）。 */
  flushError?: string
}

/**
 * 删掉这一轮被写进记忆引擎的条目。
 *
 * ## 为什么不再用 `[消息时间-1分钟, +10分钟]`
 *
 * 用户连发三句时，三句都在这个窗口里；撤回第二句会把第三句刚抽取的记忆
 * 一起删掉。现在按 `(sessionId, turn)` 精确回收：抽取与 `memory_remember`
 * 都写 `provenance.turn`，只有没有 turn 的旧数据才退回该轮的精确起止时间。
 *
 * 记忆引擎不在线时返回 0（撤回上下文那部分已经完成）。
 */
async function purgeTurnMemories(botId: string, scope: RecalledTurnScope): Promise<number> {
  const store = getWebuiMemoryStore() as {
    readEntries?: () => Promise<any[]>
    removeEntry?: (id: string) => Promise<boolean>
    removeEntriesWhere?: (predicate: (entry: any) => boolean) => Promise<number>
    flush?: () => Promise<void>
    markTurnRecalled?: (sessionId: string, turn: number) => void
    markMessageRecalled?: (sessionId: string, userMessageId: string) => void
  } | undefined
  if (store === undefined) return 0
  const owner = `bot:${botId}`
  const belongs = (entry: any): boolean => (entry?.owner ?? 'work') === owner && isEntryFromRecalledTurn(entry, scope)
  try {
    // 先立墓碑：抽取任务可能正在 LLM 里跑，落库前后都会查这个标记。
    // 有消息 id 时按消息立（steer 场景只挡这一条），否则退回整轮。
    if (scope.userMessageId !== undefined && typeof store.markMessageRecalled === 'function') {
      store.markMessageRecalled(scope.sessionId, scope.userMessageId)
    } else {
      store.markTurnRecalled?.(scope.sessionId, scope.turn)
    }
    let removed = 0
    if (typeof store.removeEntriesWhere === 'function') {
      removed = await store.removeEntriesWhere(belongs)
    } else if (typeof store.readEntries === 'function' && typeof store.removeEntry === 'function') {
      // 兼容旧 store：逐条删。
      for (const entry of await store.readEntries()) {
        if (!belongs(entry)) continue
        try {
          if (await store.removeEntry(String(entry.id))) removed += 1
        } catch {
          /* 单条删除失败不影响其余条目与撤回本身 */
        }
      }
    }
    // 撤回是「删掉就要落盘」的动作，不能只等 debounce。
    if (typeof store.flush === 'function') await store.flush()
    return removed
  } catch {
    /* 引擎读失败：撤回上下文那部分已经完成，记忆这半只能尽力 */
    return 0
  }
}

/** 撤回占位消息的文本：模型看到它就知道这一段被用户撤掉了。 */
const RECALL_PLACEHOLDER = '[用户撤回了这一段对话，请忽略此前这些内容]'

/** 从一条消息事件里抽纯文本。 */
function textOf(event: any): string {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => String(block.text))
    .join('')
    .trim()
}

/** 是不是「一轮对话的起点」：真人输入。注入上下文（agent-instructions / runtime-context / system-reminder）不算。 */
function isHumanTurn(event: any): boolean {
  return event?.type === 'user/message' && event?.data?.source?.kind === 'user'
}

/**
 * 找某个 surface 节点所属的 turn 号与该轮开始时间。
 *
 * assistant/message 自己带 `data.turn`，但「刚发完消息还没回复就撤回」时区间里
 * 只有 user 节点，拿不到 turn。这时从 session 日志里向前找最近的 turn/start。
 */
function turnStartForSeq(session: any, seq: number): { turn: number; time: number } {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    let turn = 0
    let time = 0
    for (const event of events) {
      if (typeof event?.seq === 'number' && event.seq >= seq) break
      if (event?.type !== 'turn/start') continue
      const value = Number(event?.data?.turn ?? 0)
      if (Number.isInteger(value) && value > 0) {
        turn = value
        time = typeof event.time === 'number' ? event.time : 0
      }
    }
    return { turn, time }
  } catch {
    return { turn: 0, time: 0 }
  }
}

/** 撤回一轮对话：把「这条用户消息 + 它之后的 bot 回复」从模型可见 surface 上遮蔽掉。 */
export async function recallBotTurn(
  ctx: any,
  spec: BotAgentSpec,
  text: string,
  at: number,
  messageId?: string,
): Promise<RecallResult> {
  const wanted = String(text ?? '').trim()
  const wantedId = String(messageId ?? '').trim()
  if (wanted === '' && wantedId === '') return { ok: false, error: '空消息无法撤回' }

  let agent: any
  try {
    agent = await ensureBotAgent(ctx, spec)
  } catch (error: any) {
    return { ok: false, error: `无法连接该 Bot 的会话：${String(error?.message ?? error)}` }
  }

  const session = agent?.session
  const nodes: number[] = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []
  if (nodes.length === 0) return { ok: false, error: '会话里还没有可撤回的消息' }

  // 目标节点：优先按 host 消息 id 精确匹配；旧消息 / 群聊其他 bot 没有同一 id 时，
  // 退回「文本相等 + 时间最接近」。
  let targetIndex = -1
  if (wantedId !== '') {
    for (let index = 0; index < nodes.length; index += 1) {
      const event = session.eventAt(nodes[index])
      if (!isHumanTurn(event)) continue
      if (String(event?.data?.id ?? '') !== wantedId) continue
      targetIndex = index
      break
    }
  }
  if (targetIndex < 0 && wanted !== '') {
    let bestDelta = Number.POSITIVE_INFINITY
    for (let index = 0; index < nodes.length; index += 1) {
      const event = session.eventAt(nodes[index])
      if (!isHumanTurn(event)) continue
      if (textOf(event) !== wanted) continue
      const delta = Math.abs((typeof event.time === 'number' ? event.time : 0) - at)
      if (delta < bestDelta) {
        bestDelta = delta
        targetIndex = index
      }
    }
  }
  if (targetIndex < 0) return { ok: false, error: '会话里找不到这条消息（可能已被撤回或清空）' }

  // 区间终点：下一条真人输入之前的最后一个节点（没有下一条就到最后）
  let endIndex = nodes.length - 1
  for (let index = targetIndex + 1; index < nodes.length; index += 1) {
    if (isHumanTurn(session.eventAt(nodes[index]))) {
      endIndex = index - 1
      break
    }
  }
  if (endIndex < targetIndex) return { ok: false, error: '撤回范围为空' }

  const startSeq = nodes[targetIndex]
  const endSeq = nodes[endIndex]
  const range = nodes.slice(targetIndex, endIndex + 1)

  // turn/step 沿用区间里最后一个带它们的节点（assistant/message），缺省 0
  let turn = 0
  let step = 0
  for (const seq of range) {
    const data: any = session.eventAt(seq)?.data
    if (typeof data?.turn === 'number') turn = data.turn
    if (typeof data?.step === 'number') step = data.step
  }
  // 只有 user 节点（还没回复）时区间里没有 turn，从日志里补；同时拿到该轮开始时间。
  const turnStart = turnStartForSeq(session, startSeq)
  if (turn === 0 && turnStart.turn > 0) turn = turnStart.turn

  /*
   * 记忆 / 工作记忆的精确作用域。
   *
   * `from` 用该轮 turn/start 的时间（拿不到时用本条用户消息时间）；`to` 只用
   * 撤回区间最后一个节点的时间——下一句用户的 turn 在这之后，因此不会被误删。
   * ±少量毫秒的余量只为吸收抽取落库与事件时间的抖动，不会跨到下一轮。
   */
  const rangeTimes = range
    .map((seq) => session.eventAt(seq)?.time)
    .filter((time: unknown): time is number => typeof time === 'number' && Number.isFinite(time))
  const firstTime = rangeTimes.length > 0 ? Math.min(...rangeTimes) : at
  const lastTime = rangeTimes.length > 0 ? Math.max(...rangeTimes) : at
  const scope: RecalledTurnScope = {
    sessionId: String(session?.id ?? ''),
    turn,
    ...(typeof session.eventAt(startSeq)?.data?.id === 'string' && session.eventAt(startSeq).data.id !== ''
      ? { userMessageId: String(session.eventAt(startSeq).data.id) }
      : {}),
    from: Math.min(firstTime, turnStart.time > 0 ? turnStart.time : firstTime) - 1_000,
    to: lastTime + 2_000,
  }

  try {
    session.append(
      'developer/message',
      {
        turn,
        step,
        message: {
          id: `pa-recall-${randomUUID()}`,
          role: 'developer',
          content: [{ type: 'text', text: RECALL_PLACEHOLDER }],
          /*
           * source.kind 必须是「producer 自己的 kind」。`plugin` 是 v3 的旧包装，
           * v4 格式在落盘时会拒绝（实测报 `format v4 developer message requires
           * ... a producer-owned source`），导致 flush 失败、撤回重启即丢。
           */
          source: { kind: 'plugin:dsh-seeker-bot' },
        },
      },
      {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        // 必须覆盖被遮蔽区间里的**每一个** surface 节点，宿主会逐项校验
        sourceEventSeqs: range,
      },
    )
  } catch (error: any) {
    return { ok: false, error: `撤回失败：${String(error?.message ?? error)}` }
  }

  /*
   * 落盘。append 只写进内存日志，持久化由 SessionStore 负责；不 flush 的话
   * 进程重启后这条 replace 就丢了——表现是「撤回当场有效，重启后又想起来了」。
   * flush 失败不影响本次撤回（内存里已经生效），所以只记不抛。
   */
  let flushError: string | undefined
  try {
    const store = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined
    if (typeof store?.flush === 'function') await store.flush(session)
    else flushError = 'sessions 服务不可用（没有 flush）'
  } catch (error: any) {
    flushError = String(error?.message ?? error)
  }

  /*
   * 记忆 / 工作记忆那一半：只清「这一轮」写下的东西。
   *
   * 放在上下文遮蔽成功之后——撤回的核心承诺是「后续上下文不再带着它」，
   * 记忆清理是附加动作，失败也不该把整个撤回判成失败。
   */
  const memoriesRemoved = await purgeTurnMemories(spec.botId, scope)
  let workingTasksRemoved = 0
  try {
    workingTasksRemoved = await purgeWorkingTasksForTurn(spec.botId, scope)
  } catch {
    /* 工作记忆是附加项：文件读写失败不影响「上下文已撤回」的结论 */
  }

  return {
    ok: true,
    removed: range.length,
    memoriesRemoved,
    workingTasksRemoved,
    turn,
    ...(scope.userMessageId !== undefined ? { userMessageId: scope.userMessageId } : {}),
    ...(flushError === undefined ? {} : { flushError }),
  }
}
