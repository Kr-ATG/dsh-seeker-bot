/**
 * dsh-seeker-bot — Bot 注意力状态（host 半身）。
 *
 * 由会话事件推导名册上的三态：
 *   · turn/start  → working（工作中）
 *   · turn/end    → unread（有新回复未读；用户打开该 Bot 会话后由客户端改回 idle）
 *
 * 只对已绑定 Bot 的会话生效；没绑定就完全放行。写盘前先比对当前状态，
 * 避免每个事件都触发一次 state.json 原子写。
 *
 * @module
 */

import { botForSession, findBot, updateBot, type BotStatus } from './state.js'

interface SessionLike {
  id?: unknown
  sessionId?: unknown
}

interface EventLike {
  type?: unknown
}

function sessionIdOf(session: unknown): string {
  try {
    const record = session as SessionLike
    const id = record?.id ?? record?.sessionId
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

/** 装配注意力状态监听。没有 ctx.on 时静默跳过。 */
export function applyBotAttention(ctx: any): void {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') return
  ctx.on('session/event', (session: unknown, event: unknown) => {
    try {
      const type = (event as EventLike)?.type
      if (type !== 'turn/start' && type !== 'turn/end') return
      const sessionId = sessionIdOf(session)
      if (sessionId === '') return
      const bot = botForSession(sessionId)
      if (bot === null) return
      const next: BotStatus = type === 'turn/start' ? 'working' : 'unread'
      if (bot.status === next) return
      const fresh = findBot(bot.id)
      if (fresh === null || fresh.status === next) return
      updateBot(bot.id, { status: next })
    } catch { /* 事件处理失败不影响会话本身 */ }
  })
}
