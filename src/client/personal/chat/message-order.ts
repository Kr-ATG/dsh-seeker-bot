/**
 * Personal Agent — 消息流的顺序工具（纯函数，可离线测）。
 *
 * ## 为什么单独一个文件
 *
 * 「认领『正在输入』占位后把它挪到队尾」这条规则，逻辑本身只有三行，但它是
 * **消息顺序正确性的唯一支点**：写错或漏写，界面就会出现「结论在上、提问在下」
 * 这种颠倒（实测 2026-11-03「创建一个互联网营销bot」，见 {@link relocateToEnd}）。
 * 埋在 store 的 setState 闭包里既没法单独测，也没法被 review 一眼看明白。
 *
 * 这里只放不依赖 React、不依赖时间的纯函数：输入输出都是消息数组，行为完全
 * 由参数决定。
 */

/** 消息数组里最小可辨识的形状（只要求有 id）。 */
export interface OrderableMessage {
  readonly id: string
}

/**
 * 把指定 id 的消息挪到队尾；找不到或已经在队尾时**原样返回同一个数组**。
 *
 * ## 它修的是什么
 *
 * 「正在输入」占位是在**用户发消息那一刻**插进消息流的，位置固定在当时的队尾。
 * 可这一轮里还有另一类消息走的是**常驻 SSE**（问答卡 / 审批卡 / 例行任务结果）
 * ——它们由 `appendMessage` 直接追加，追加时会落在占位**后面**。
 *
 * 于是同一轮里出现这种错位：
 *
 * ```
 * 0.2s   用户消息 + 占位（队尾）
 * 15.6s  问答卡 → SSE 追加        → [用户, 占位, 卡片]
 * 137.6s 正文   → 认领占位、填回原位 → [用户, 正文, 卡片]   ← 顺序反了
 * ```
 *
 * 占位承载的永远是「这一轮**最新**到达的那条消息」，所以认领时它就该待在队尾：
 *
 * ```
 * 137.6s 认领 → 摘出占位、追加到队尾 → [用户, 卡片, 正文]   ← 与真实时间一致
 * ```
 *
 * ## 为什么返回同一个数组而不是总拷贝
 *
 * 调用方（`updateMessageBlocks`）在 `setState` 里判断「引用没变就跳过」，返回同一
 * 个引用能让 React 省掉一次无意义的重渲染；也让「没有发生移动」这件事在调用方
 * 一眼可见。
 *
 * @param messages - 当前消息数组（不修改原数组）。
 * @param id - 要挪到队尾的消息 id。
 * @returns 新数组；不需要移动时返回**原数组引用**。
 */
export function relocateToEnd<T extends OrderableMessage>(
  messages: readonly T[],
  id: string,
): readonly T[] {
  const index = messages.findIndex((message) => message.id === id)
  if (index < 0 || index === messages.length - 1) return messages
  const next = [...messages]
  const [claimed] = next.splice(index, 1)
  if (claimed !== undefined) next.push(claimed)
  return next
}
