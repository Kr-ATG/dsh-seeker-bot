/**
 * dsh-seeker-bot — Bot 控制台 HTTP 客户端。
 *
 * 所有请求都收敛在这里：同源、JSON、失败不抛（返回 { ok, status, error }），
 * 调用方负责把错误变成**可见提示**，不允许静默。路由前缀与 host 半身一致。
 */

import type { BotStatePayload } from './model.ts'

const PREFIX = '/api/seeker-bot'

export interface ApiResult<T = any> {
  readonly ok: boolean
  readonly status: number
  readonly data?: T
  readonly error?: string
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

async function request<T = any>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  if (typeof fetch !== 'function') {
    return { ok: false, status: 0, error: '当前环境没有 fetch' }
  }
  try {
    const res = await fetch(PREFIX + path, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...init,
    })
    let data: any = null
    try { data = await res.json() } catch { data = null }
    if (!res.ok) {
      const message = data && typeof data.error === 'string' && data.error !== ''
        ? data.error
        : 'HTTP ' + res.status
      return { ok: false, status: res.status, data, error: message }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, error: errorText(err) }
  }
}

/** 读整份状态（Bot 列表 / 分组 / ui 模式）。 */
export function fetchBotState(): Promise<ApiResult<BotStatePayload>> {
  return request<BotStatePayload>('/state')
}

/** 新建 Bot。 */
export function createBot(input: Record<string, unknown>): Promise<ApiResult<{ ok?: boolean; bot?: any }>> {
  return request('/bots', { method: 'POST', body: JSON.stringify(input) })
}

/**
 * 由 host 为 Bot 创建会话（官方 sessionController，产生可见的 seekerbot 工作区会话）。
 * 成功返回 sessionId；404 / 405 / 网络不可用时调用方降级到 uiWorkspace.startSession。
 */
export function createBotSession(botId: string): Promise<ApiResult<{ ok?: boolean; sessionId?: string; workspaceId?: string; workspacePath?: string }>> {
  return request('/bots/' + encodeURIComponent(botId) + '/session', { method: 'POST', body: '{}' })
}

/** 更新 Bot（全量 patch 也安全，host 只吃白名单字段）。 */
export function patchBot(id: string, patch: Record<string, unknown>): Promise<ApiResult<{ ok?: boolean; bot?: any }>> {
  return request('/bots/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) })
}

/** 删除 Bot（只删档案，不删会话）。 */
export function deleteBot(id: string): Promise<ApiResult<{ ok?: boolean }>> {
  return request('/bots/' + encodeURIComponent(id), { method: 'DELETE' })
}

/** 置为主 Bot。 */
export function setPrimaryBot(id: string): Promise<ApiResult<{ ok?: boolean; bot?: any }>> {
  return request('/bots/' + encodeURIComponent(id) + '/primary', { method: 'POST', body: '{}' })
}

/** 暂停 / 恢复：优先走动作路由，老 host 没有动作路由时退回 PATCH。 */
export async function setBotPaused(id: string, paused: boolean): Promise<ApiResult> {
  const action = paused ? 'pause' : 'resume'
  const res = await request('/bots/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: '{}' })
  if (res.ok || res.status !== 404) return res
  return patchBot(id, { paused })
}

/** 绑定会话：主路由 /session/bind，兼容旧版 /bots/:id/session/bind。 */
export async function bindBotSession(botId: string, sessionId: string): Promise<ApiResult> {
  const body = JSON.stringify({ botId, sessionId })
  const res = await request('/session/bind', { method: 'POST', body })
  if (res.ok || res.status !== 404) return res
  return request('/bots/' + encodeURIComponent(botId) + '/session/bind', { method: 'POST', body })
}

/** 持久化侧栏模式（失败时调用方负责提示，不阻塞本地切换）。 */
export function setBotUiMode(mode: 'work' | 'bot'): Promise<ApiResult<{ ok?: boolean; mode?: string }>> {
  return request('/ui/mode', { method: 'POST', body: JSON.stringify({ mode }) })
}

/* ───────────────────────────── 日程（原班次） ───────────────────────────── */

/** 日程触发方式（与 host 的 RoutineTrigger 同形）。 */
export interface RoutineTriggerView {
  type: 'schedule' | 'webhook' | 'manual'
  cron?: string
  everySeconds?: number
  timezone?: string
}

/** 一条日程（只声明客户端用到的字段）。 */
export interface RoutineView {
  id: string
  botId: string
  name: string
  instruction: string
  enabled: boolean
  key: string
  scheduleId?: string
  triggers: RoutineTriggerView[]
  runs?: Array<{ at: number; status: string; trigger: string; reason?: string }>
  createdAt?: number
  updatedAt?: number
}

export function fetchRoutines(botId: string): Promise<ApiResult<{ ok?: boolean; routines: RoutineView[] }>> {
  return request('/routines?botId=' + encodeURIComponent(botId))
}

export function createRoutine(input: Record<string, unknown>): Promise<ApiResult<{ ok?: boolean; routine: RoutineView; schedule?: unknown }>> {
  return request('/routines', { method: 'POST', body: JSON.stringify(input) })
}

export function patchRoutine(id: string, patch: Record<string, unknown>): Promise<ApiResult<{ ok?: boolean; routine: RoutineView }>> {
  return request('/routines/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteRoutine(id: string): Promise<ApiResult<{ ok?: boolean }>> {
  return request('/routines/' + encodeURIComponent(id), { method: 'DELETE' })
}

export function testRoutine(id: string): Promise<ApiResult<{ ok?: boolean; delivered?: boolean; reason?: string }>> {
  return request('/routines/' + encodeURIComponent(id) + '/test', { method: 'POST', body: '{}' })
}

/** 主动找我诊断：返回此刻是否会发、为什么（不真正发消息）。 */
export function testProactive(botId: string): Promise<ApiResult<{ ok?: boolean; willSend?: boolean; reason?: string; candidateCount?: number; event?: unknown }>> {
  return request('/bots/' + encodeURIComponent(botId) + '/proactive/test', { method: 'POST', body: '{}' })
}

/** Bot 工作区文件树（右栏「文件」卡）。 */
export interface BotTreeEntry {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  children?: BotTreeEntry[]
}

export function fetchBotTree(botId: string): Promise<ApiResult<{ ok?: boolean; root?: string; entries?: BotTreeEntry[] }>> {
  return request('/computer/tree?botId=' + encodeURIComponent(botId))
}
