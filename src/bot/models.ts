/**
 * dsh-seeker-bot — 模型偏好（host 半身）。
 *
 * 两层存储：
 *   - Bot 级：bot.model = { provider, model, effort }；
 *   - 群级：group.model = { mode:'inherit' } | { mode:'unified', provider, model, effort }。
 *
 * 优先级：群设置（unified）> Bot 设置 > 全局默认（不写，交给 DSH 自己的默认）。
 * DSH 的模型选择是 per-session 的：真正写入走官方 sessionController.selectModel；
 * 拿不到该服务时只返回状态，绝不阻塞会话创建或其它能力。
 */

import {
  findBot, listGroups, updateBot, updateGroupRecord, botIdForSession,
  type BotModelPrefs, type GroupModel,
} from './state.js'
import { serviceOf } from './sessions.js'

export interface ResolvedModel {
  provider: string | null
  model: string | null
  effort: string | null
  /** 设置来源：group = 群统一；bot = Bot 设置；default = 未设置。 */
  source: 'group' | 'bot' | 'default'
  botId: string | null
  groupId?: string
}

function hasRoute(prefs: { provider?: string; model?: string } | undefined): boolean {
  return prefs !== undefined
    && typeof prefs.provider === 'string' && prefs.provider !== ''
    && typeof prefs.model === 'string' && prefs.model !== ''
}

/**
 * 解析某会话最终生效的模型偏好（纯逻辑，只读 state）。
 *
 * 群 unified 必须 provider 与 model 同时有值才覆盖 Bot；只有半截的设置视为未设置，
 * 这样群配置不会把 Bot 的可用模型打成空。
 */
export function resolveModelFor(sessionId: string): ResolvedModel {
  const botId = botIdForSession(sessionId)
  if (botId !== null) {
    for (const group of listGroups()) {
      if (!group.botIds.includes(botId)) continue
      const model = group.model
      if (model !== undefined && model.mode === 'unified' && hasRoute(model)) {
        return {
          provider: model.provider ?? null,
          model: model.model ?? null,
          effort: typeof model.effort === 'string' && model.effort !== '' ? model.effort : null,
          source: 'group',
          botId,
          groupId: group.id,
        }
      }
    }
    const bot = findBot(botId)
    if (bot !== null && hasRoute(bot.model)) {
      return {
        provider: bot.model?.provider ?? null,
        model: bot.model?.model ?? null,
        effort: typeof bot.model?.effort === 'string' && bot.model.effort !== '' ? bot.model.effort : null,
        source: 'bot',
        botId,
      }
    }
  }
  return { provider: null, model: null, effort: null, source: 'default', botId }
}

/** 写 Bot 级模型偏好；返回更新后的 Bot（不存在返回 null）。 */
export function setBotModel(botId: string, model: unknown): ReturnType<typeof findBot> {
  return updateBot(botId, { model })
}

/** 写群级模型偏好。 */
export function setGroupModel(groupId: string, model: unknown): ReturnType<typeof updateGroupRecord> {
  return updateGroupRecord(groupId, { model: normalizeGroupModel(model) })
}

/** 把任意输入归一成群模型设置（兼容客户端直接传 {provider,model,effort}）。 */
export function normalizeGroupModel(value: unknown): GroupModel {
  if (value === null || typeof value !== 'object') return { mode: 'inherit' }
  const raw = value as Record<string, unknown>
  if (raw.mode === 'inherit') return { mode: 'inherit' }
  const mode = raw.mode === 'unified' || raw.provider !== undefined || raw.model !== undefined ? 'unified' : 'inherit'
  if (mode === 'inherit') return { mode: 'inherit' }
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  const effort = typeof raw.effort === 'string' ? raw.effort.trim() : ''
  return {
    mode: 'unified',
    ...(provider !== '' ? { provider } : {}),
    ...(model !== '' ? { model } : {}),
    ...(effort !== '' ? { effort } : {}),
  }
}

export interface ModelApplyResult {
  ok: boolean
  applied: boolean
  sessionId: string
  resolved: ResolvedModel
  reason?: string
}

/** 把解析出的偏好写到某个会话（拿不到官方 model 服务时如实返回状态，不抛）。 */
export async function applyModelPrefsToSession(ctx: any, sessionId: string): Promise<ModelApplyResult> {
  const resolved = resolveModelFor(sessionId)
  if (resolved.source === 'default' || resolved.provider === null || resolved.model === null) {
    return { ok: true, applied: false, sessionId, resolved, reason: '该会话没有 Bot/群模型偏好' }
  }
  const controller = serviceOf(ctx, 'sessionController')
  if (controller === undefined || typeof controller.selectModel !== 'function') {
    return { ok: false, applied: false, sessionId, resolved, reason: '官方模型服务不可用（sessionController.selectModel 未注册）' }
  }
  try {
    await controller.selectModel({
      sessionId,
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.effort !== null ? { reasoningEffort: resolved.effort } : {}),
    })
    return { ok: true, applied: true, sessionId, resolved }
  } catch (error) {
    return { ok: false, applied: false, sessionId, resolved, reason: errorText(error) }
  }
}

export interface ModelPrefsHandle {
  /** 对单个会话尝试应用偏好（永不 reject）。 */
  applyToSession(sessionId: string): Promise<ModelApplyResult>
}

/**
 * 装配模型偏好：监听 session/created 时尝试写入（拿不到服务就只返回状态）。
 * 路由在创建 Bot 会话后也会显式调用一次，两条路径互不依赖。
 */
export function applyBotModelPrefs(ctx: any): ModelPrefsHandle {
  const applyToSession = async (sessionId: string): Promise<ModelApplyResult> => {
    try {
      return await applyModelPrefsToSession(ctx, sessionId)
    } catch (error) {
      return {
        ok: false,
        applied: false,
        sessionId,
        resolved: { provider: null, model: null, effort: null, source: 'default', botId: null },
        reason: errorText(error),
      }
    }
  }
  try {
    if (ctx !== null && typeof ctx === 'object' && typeof ctx.on === 'function') {
      ctx.on('session/created', (session: any) => {
        try {
          const sessionId = typeof session?.id === 'string' ? session.id : (typeof session?.sessionId === 'string' ? session.sessionId : '')
          if (sessionId !== '') void applyToSession(sessionId)
        } catch { /* 事件处理失败不影响会话创建 */ }
      })
    }
  } catch { /* 事件面不可用：交给路由显式调用 */ }
  return { applyToSession }
}

/** 读 Bot 当前的模型偏好（路由 GET 用）。 */
export function botModelOf(botId: string): BotModelPrefs | null {
  const bot = findBot(botId)
  return bot?.model ?? null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
