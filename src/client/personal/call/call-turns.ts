/**
 * 通话转写的顺序还原（纯函数，可离线单测）。
 *
 * ## 为什么顺序会乱
 *
 * 全双工实时通话里，一轮对话的事件到达顺序**不保证**是「用户先说、Bot 后答」：
 *
 * - 服务端 ASR 转写是异步的。官方文档原话：「转录随响应创建异步运行，因此此事件
 *   可能发生在响应事件之前或之后。」于是 `user_transcript` 经常晚于
 *   `bot_transcript_done` 到达。
 * - 如果落库顺序直接跟着事件到达顺序走，通话记录就会变成
 *   「Bot 先答、用户后问」——用户实测截图里就是这个错序。
 *
 * ## 怎么还原
 *
 * 1. **序号**：每条轮次落库时拿一个单调递增的 `seq`。用户那一条的序号在
 *    `speech_stopped`（一定早于模型响应）时就分配好，等转写到了再补上文本，
 *    所以「用户问」天然排在「Bot 答」前面。
 * 2. **配对**：`speech_stopped` 与 `conversation.item.input_audio_transcription.completed`
 *    带同一个 `item_id`，用它对上号，而不是假设 FIFO——用户连说两句时转写也可能
 *    逆序返回。
 * 3. **排序**：渲染前按 `seq` 稳定排序。旧记录没有 `seq`（都是 0），稳定排序保持
 *    原有顺序，不会把历史通话翻乱。
 *
 * 本文件刻意不 import 任何 React/store 依赖：`scripts/test-realtime-client.mjs`
 * 会单独 bundle 它做断言。
 */

/** 带落库序号的轮次（旧记录没有 seq）。 */
interface Sequenced {
  seq?: number
}

/** 一轮「用户说完了」的占位。 */
export interface PendingUserTurn {
  /** 服务端会话项 id；上游没给就是 null。 */
  itemId: string | null
  /** 预分配的落库序号（见文件头）。 */
  seq: number
}

/**
 * 按落库序号稳定排序。
 *
 * 用稳定排序是刻意的：旧通话记录没有 `seq`（全按 0 处理），必须保持它们原来的
 * 顺序，否则翻历史记录会看到顺序被打乱。
 */
export function sortTurns<T extends Sequenced>(turns: readonly T[]): T[] {
  return [...turns].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

/**
 * 从占位队列里取出这条转写对应的那一轮。
 *
 * @param pending 待配对队列（按 `speech_stopped` 到达顺序）。
 * @param itemId 转写事件带来的 `item_id`。
 * @returns 取到的占位（可能为 null）与剩下的队列。
 *
 * 配对不上时退回队首（FIFO）：宁可顺序差一点，也不能把这句话丢掉。
 */
export function takePendingUserTurn<T extends PendingUserTurn>(
  pending: readonly T[],
  itemId?: string,
): { entry: T | null; rest: T[] } {
  if (pending.length === 0) return { entry: null, rest: [] }
  let index = itemId === undefined || itemId === '' ? -1 : pending.findIndex((item) => item.itemId === itemId)
  if (index < 0) index = 0
  return {
    entry: pending[index],
    rest: [...pending.slice(0, index), ...pending.slice(index + 1)],
  }
}
