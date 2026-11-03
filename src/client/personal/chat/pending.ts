/**
 * Personal Agent — 「等用户动作」的判定。
 *
 * 两个地方都要回答同一个问题：**还有几条消息在等用户处理？**
 *  · 输入框上方的待处理上浮条（2.6，ChatPanel）；
 *  · 轮次结算行「N 条消息 · M 个产出 · K 个待办」（2.8，MessageList）。
 *
 * 判据放在这里而不是各写一份：两处对「算不算待办」的口径一旦漂移，就会出现
 * 「上浮条说有 1 项、轮次结算说 0 个待办」这种自相矛盾的界面。
 */
import type { Message } from '../types.ts'

/** 一条消息的首句摘要（上浮条只放得下一行）。 */
export function firstLineOf(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const cut = (flat.split(/[。！？!?；;\n]/u)[0] ?? flat).trim()
  const value = cut === '' ? flat : cut
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 还没被用户处理掉的 need-input / approval 消息。
 *
 * 两条判据，分别对应两种提问形态：
 *  · 带交互卡（options / buttons / form）—— 看卡自己的 `submitted`，提交过就不再提醒；
 *  · 纯文本提问 —— 没有「已处理」标记，用「用户之后有没有再说话」兜底：用户已经
 *    回了话，这张提问就不该继续挂着。
 */
export function pendingTasksOf(messages: readonly Message[]): Message[] {
  let lastUserAt = 0
  for (const message of messages) {
    if (message.role === 'user') lastUserAt = Math.max(lastUserAt, message.at)
  }
  return messages.filter((message) => {
    if (message.role !== 'bot') return false
    if (message.kind !== 'need-input' && message.kind !== 'approval') return false
    const interactive = message.blocks.find((block) => block.type === 'interactive')
    if (interactive !== undefined) return interactive.submitted !== true
    return message.at > lastUserAt
  })
}

/** 上浮条上那一行字：优先正文首句，其次交互卡的提问，最后给一句兜底文案。 */
export function pendingSummaryOf(message: Message): string {
  for (const block of message.blocks) {
    if (block.type === 'text') {
      const text = firstLineOf(block.text)
      if (text !== '') return text
    }
    if (block.type === 'interactive' && block.prompt !== undefined) {
      const text = firstLineOf(block.prompt)
      if (text !== '') return text
    }
  }
  return message.kind === 'approval' ? '有一个操作等你确认' : '有一个问题等你回答'
}
