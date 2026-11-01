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

/** 撤回结果。 */
export interface RecallResult {
  ok: boolean
  /** 被遮蔽的 surface 节点数（用户消息 + 该轮 bot 回复 + 工具结果 + 注入上下文）。 */
  removed?: number
  error?: string
  /** 落盘失败原因（撤回本身已生效，只是重启后会丢）。 */
  flushError?: string
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

/** 撤回一轮对话：把「这条用户消息 + 它之后的 bot 回复」从模型可见 surface 上遮蔽掉。 */
export async function recallBotTurn(
  ctx: any,
  spec: BotAgentSpec,
  text: string,
  at: number,
): Promise<RecallResult> {
  const wanted = String(text ?? '').trim()
  if (wanted === '') return { ok: false, error: '空消息无法撤回' }

  let agent: any
  try {
    agent = await ensureBotAgent(ctx, spec)
  } catch (error: any) {
    return { ok: false, error: `无法连接该 Bot 的会话：${String(error?.message ?? error)}` }
  }

  const session = agent?.session
  const nodes: number[] = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []
  if (nodes.length === 0) return { ok: false, error: '会话里还没有可撤回的消息' }

  // 目标节点：文本相等、且时间最接近前端那条消息的真人输入
  let targetIndex = -1
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

  return { ok: true, removed: range.length, ...(flushError === undefined ? {} : { flushError }) }
}
