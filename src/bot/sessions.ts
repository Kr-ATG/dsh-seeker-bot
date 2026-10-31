/**
 * dsh-seeker-bot — Bot 会话绑定（host 半身）。
 *
 * 每个 Bot 的会话都在 DSH 自己的会话存储里，这里只维护「sessionId → botId」
 * 绑定表（落在 state.json 的 sessions 字段），并负责按 Bot 的工作目录创建会话。
 *
 * 创建路径有两个可用面（按优先级）：
 *   1. ctx.sessionController.create({ workspaceId | cwd }) —— 官方 Host API，
 *      产生可见会话；
 *   2. ctx.sessions.create(undefined, { meta: { cwd } }) —— 低层 SessionStore，
 *      只在没有 sessionController 的裸组合里兜底。
 * 两者都拿不到时返回可读错误，绝不抛穿路由。
 */

import { existsSync, mkdirSync } from 'node:fs'
import {
  bindSession, findBot, listSessionsForBot, resolveBotWorkspace, seekerbotDir,
  type BotRecord,
} from './state.js'

/** 从 host ctx 读服务。cordis 的 ctx 是 Proxy：未 inject 的属性直读会抛，
 * 所以统一先走 ctx.get（不要求 inject），再对测试桩做直读兜底。 */
export function serviceOf(ctx: any, name: string): any {
  try {
    if (ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function') {
      const found = ctx.get(name)
      if (found !== undefined && found !== null) return found
    }
  } catch { /* 未注册的服务在 cordis 里可能抛，按不可用处理 */ }
  try {
    return ctx === null || ctx === undefined ? undefined : ctx[name]
  } catch {
    return undefined
  }
}

function ensureDir(dir: string): boolean {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

export interface SessionCreationResult {
  ok: boolean
  sessionId?: string
  workspaceId?: string
  workspacePath?: string
  /** workspace = 走官方 Workspace 记录；cwd = 只给目录。 */
  mode?: 'workspace' | 'cwd'
  error?: string
}

/**
 * 为 Bot 创建一个新会话并建立绑定。
 *
 * 工作目录：bot.workspace 非空时用它；否则用共享的 ${DSH_HOME}/seekerbot。
 * 若 workspaceRegistry 可用，优先把共享目录注册成 'seekerbot' 工作区，
 * 再让 sessionController 以 workspaceId 建会话（Bot 列表里能看到这个工作区）。
 */
export async function createBotSession(ctx: any, bot: BotRecord): Promise<SessionCreationResult> {
  try {
    const dir = resolveBotWorkspace(bot)
    if (!ensureDir(dir)) {
      return { ok: false, error: '无法创建 Bot 工作目录：' + dir }
    }

    let workspaceId = ''
    const registry = serviceOf(ctx, 'workspaceRegistry')
    if (bot.workspace === '' && registry !== undefined && typeof registry.create === 'function') {
      try {
        const workspace = await registry.create(dir, bot.memoryWorkspace || 'seekerbot')
        const rawId = workspace?.id ?? workspace?.workspaceId
        if (typeof rawId === 'string' && rawId !== '') workspaceId = rawId
      } catch {
        // 注册工作区失败不阻塞：退回 cwd 模式（会话仍然可用）。
        workspaceId = ''
      }
    }

    let sessionId = ''
    const controller = serviceOf(ctx, 'sessionController')
    if (controller !== undefined && typeof controller.create === 'function') {
      const request = workspaceId !== '' ? { workspaceId } : { cwd: dir }
      const created = await controller.create(request)
      const raw = created?.sessionId ?? created?.id
      if (typeof raw === 'string' && raw !== '') sessionId = raw
    } else {
      const store = serviceOf(ctx, 'sessions')
      if (store === undefined || typeof store.create !== 'function') {
        return {
          ok: false,
          error: '会话服务不可用：未找到 ctx.sessionController 或 ctx.sessions，无法创建 Bot 会话',
        }
      }
      const created = await store.create(undefined, { meta: { cwd: dir } })
      const raw = created?.id ?? created?.sessionId
      if (typeof raw === 'string' && raw !== '') sessionId = raw
    }

    if (sessionId === '') return { ok: false, error: '会话服务没有返回 sessionId' }
    if (!bindSession(sessionId, bot.id)) return { ok: false, error: 'Bot 不存在，无法绑定会话' }
    return {
      ok: true,
      sessionId,
      ...(workspaceId !== '' ? { workspaceId } : {}),
      workspacePath: dir,
      mode: workspaceId !== '' ? 'workspace' : 'cwd',
    }
  } catch (error) {
    return { ok: false, error: '创建 Bot 会话失败：' + errorText(error) }
  }
}

/** 某 Bot 的会话列表（绑定表与 Bot.sessionIds 的并集）。 */
export function sessionsOfBot(botId: string): Array<{ sessionId: string; botId: string }> {
  return listSessionsForBot(botId)
}

/** POST /session/bind 的实现：把已有会话绑到 Bot。 */
export function bindSessionToBot(sessionId: string, botId: string): { ok: boolean; error?: string } {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, error: 'sessionId 不能为空' }
  }
  if (typeof botId !== 'string' || botId.trim() === '') {
    return { ok: false, error: 'botId 不能为空' }
  }
  const bot = findBot(botId.trim())
  if (bot === null) return { ok: false, error: 'Bot 不存在' }
  bindSession(sessionId.trim(), botId.trim())
  return { ok: true }
}

/** 共享记忆工作区目录（供其它模块与测试使用）。 */
export function memoryWorkspacePath(): string {
  return seekerbotDir()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
