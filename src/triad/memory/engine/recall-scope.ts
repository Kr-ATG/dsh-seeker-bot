/**
 * 撤回作用域：判断一条长期记忆是否属于被撤回的那一次用户发言。
 *
 * 为什么不能继续用「消息时间 -1 分钟 ~ +10 分钟」：
 * 用户连发三句时，三句往往都挤在这个窗口里。撤回第二句会把第三句刚抽取的
 * 记忆一起删掉。现在抽取与 memory_remember 都会写 `provenance.userMessageId`
 * （拿不到时退回 turn），撤回按消息 id 精确匹配；只有旧数据才退回时间窗口。
 */

import type { MemoryEntry } from '../types.js'

/** 一次撤回对应的精确范围。 */
export interface RecalledTurnScope {
  /** 宿主会话 id（如 pa-bot-v2-bot-main-xiaomo）。 */
  sessionId: string
  /** 该轮的 turn 号（从 1 开始）。 */
  turn: number
  /**
   * 被撤回的那条真人消息 id。
   *
   * Bot 允许执行中插话：第 2、3 句会在同一个 turn 里。有它时按消息精确匹配，
   * 第 3 句的记忆不会被第 2 句的撤回带走。
   */
  userMessageId?: string
  /** 该轮开始时间（毫秒），只用于兼容没有 provenance 的旧条目。 */
  from: number
  /** 该轮结束时间（毫秒），只用于兼容没有 provenance 的旧条目。 */
  to: number
}

/**
 * 一条记忆是否属于被撤回的那一次用户发言。
 *
 * 规则：
 *  · 有 `provenance.userMessageId`：必须同 sessionId 且消息 id 完全相等。
 *  · 没有消息 id、有 `provenance.turn`：同 sessionId 且 turn 相等。
 *  · 没有 turn 的 `extract` / `bot-working-memory`：退回时间窗口（旧数据兼容）。
 *  · 没有 turn 的 `manual`：可能是用户在面板里手写的，**不删**——一次撤回不该
 *    顺手删掉用户亲手记的东西。
 */
export function isEntryFromRecalledTurn(entry: MemoryEntry, scope: RecalledTurnScope): boolean {
  const provenance = entry.provenance
  const sameSession = typeof provenance?.sessionId === 'string' && provenance.sessionId === scope.sessionId

  if (sameSession && typeof provenance?.userMessageId === 'string' && scope.userMessageId !== undefined) {
    return provenance.userMessageId === scope.userMessageId
  }
  if (sameSession && typeof provenance?.turn === 'number') {
    return provenance.turn === scope.turn
  }

  const source = String(entry.source ?? '')
  if (source !== 'extract' && source !== 'bot-working-memory') return false
  // 旧抽取条目可能没有 sessionId；有 sessionId 时必须匹配，避免跨会话误删。
  if (provenance?.sessionId !== undefined && !sameSession) return false

  const created = Date.parse(String(entry.createdAt ?? ''))
  return Number.isFinite(created) && created >= scope.from && created <= scope.to
}
