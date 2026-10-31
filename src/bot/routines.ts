/**
 * dsh-seeker-bot — 「日程」业务层（host 半身）。
 *
 * 对外文案一律叫「日程」；数据结构里字段名仍是 routine/routines（兼容客户端）。
 *
 * 能力：
 *   - CRUD，并尽力包装官方 ctx.schedule.create/update/delete（服务不可用时只存本地，
 *     不阻塞任何请求）；
 *   - 最近 20 次运行记录（含成功 / 失败原因）；
 *   - POST /routines/:id/test 立即跑一次（没有可驱动的 agent 时如实 skipped）；
 *   - POST /webhook/:id/:key：恒定时间比较 key + 内存令牌桶限流
 *     （全局 300/h、单日程 200/h、最小间隔 5 分钟；超限 429 并写 failed run）。
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  appendRoutineRun, findBot, findRoutine, insertRoutine, updateRoutineRecord,
  deleteRoutineRecord, newRoutineKey, newRecordId,
  type BotRecord, type RoutineRecord, type RoutineRun, type RoutineTrigger,
} from './state.js'
import { serviceOf } from './sessions.js'

/** 运行历史保留条数（与 state.ts 的裁剪一致）。 */
export const MAX_RUNS = 20

/** webhook 限流参数。 */
export const WEBHOOK_LIMITS = {
  globalPerHour: 300,
  routinePerHour: 200,
  minIntervalMs: 5 * 60 * 1000,
} as const

/* ───────────────────────────────── 输入校验 ─────────────────────────────── */

export interface RoutineCreateInput {
  botId: string
  name: string
  instruction: string
  enabled: boolean
  key: string
  cron?: string
  timezone?: string
  everySeconds?: number
}

export interface RoutineUpdateInput {
  name?: string
  instruction?: string
  enabled?: boolean
  cron?: string
  timezone?: string
  everySeconds?: number
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 系统本地时区（避免把非上海用户默认排到 Asia/Shanghai）。 */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

export function parseRoutineCreate(body: Record<string, unknown>): { ok: true; value: RoutineCreateInput } | { ok: false; error: string } {
  const botId = textOf(body.botId ?? body.bot)
  if (botId === '') return { ok: false, error: 'botId 不能为空' }
  const name = textOf(body.name ?? body.title)
  if (name === '') return { ok: false, error: '日程名称不能为空' }
  const instruction = textOf(body.instruction ?? body.prompt)
  if (instruction === '') return { ok: false, error: '日程内容不能为空' }
  const cron = textOf(body.cron)
  const timezone = textOf(body.timezone ?? body.timeZone) || localTimeZone()
  const everyRaw = body.everySeconds ?? body.every_seconds
  let everySeconds: number | undefined
  if (typeof everyRaw === 'number' && Number.isFinite(everyRaw) && everyRaw > 0) everySeconds = Math.floor(everyRaw)
  // 允许只建 webhook 日程：不强制 cron。
  const key = textOf(body.key) || newRoutineKey()
  return {
    ok: true,
    value: {
      botId,
      name,
      instruction,
      enabled: body.enabled === false ? false : true,
      key,
      ...(cron !== '' ? { cron } : {}),
      timezone,
      ...(everySeconds !== undefined ? { everySeconds } : {}),
    },
  }
}

export function parseRoutineUpdate(body: Record<string, unknown>): { ok: true; value: RoutineUpdateInput } | { ok: false; error: string } {
  const out: RoutineUpdateInput = {}
  if (body.name !== undefined || body.title !== undefined) {
    const name = textOf(body.name ?? body.title)
    if (name === '') return { ok: false, error: '日程名称不能为空' }
    out.name = name
  }
  if (body.instruction !== undefined || body.prompt !== undefined) {
    const instruction = textOf(body.instruction ?? body.prompt)
    if (instruction === '') return { ok: false, error: '日程内容不能为空' }
    out.instruction = instruction
  }
  if (typeof body.enabled === 'boolean') out.enabled = body.enabled
  if (body.cron !== undefined) out.cron = textOf(body.cron)
  if (body.timezone !== undefined || body.timeZone !== undefined) out.timezone = textOf(body.timezone ?? body.timeZone)
  if (body.everySeconds !== undefined || body.every_seconds !== undefined) {
    const raw = body.everySeconds ?? body.every_seconds
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) out.everySeconds = Math.floor(raw)
  }
  return { ok: true, value: out }
}

/** 根据输入生成触发方式列表：定时（可无）+ webhook。 */
function buildTriggers(input: { cron?: string; everySeconds?: number; timezone?: string }): RoutineTrigger[] {
  const triggers: RoutineTrigger[] = []
  if (input.cron !== undefined || input.everySeconds !== undefined) {
    triggers.push({
      type: 'schedule',
      ...(input.cron !== undefined ? { cron: input.cron } : {}),
      ...(input.everySeconds !== undefined ? { everySeconds: input.everySeconds } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    })
  }
  triggers.push({ type: 'webhook' })
  return triggers
}

/* ───────────────────────────── 官方 schedule 包装 ─────────────────────────── */

export interface ScheduleApplyResult {
  ok: boolean
  scheduleId?: string
  error?: string
}

function scheduleTriggerOf(routine: RoutineRecord): Extract<RoutineTrigger, { type: 'schedule' }> | null {
  for (const trigger of routine.triggers) {
    if (trigger.type === 'schedule') return trigger
  }
  return null
}

function lastSessionIdOf(bot: BotRecord): string {
  return bot.sessionIds.length > 0 ? bot.sessionIds[bot.sessionIds.length - 1] : ''
}

/** 尽力把日程包装成官方 schedule 任务；失败只返回原因，不抛。 */
export async function createScheduleForRoutine(ctx: any, routine: RoutineRecord, bot: BotRecord): Promise<ScheduleApplyResult> {
  try {
    const schedule = serviceOf(ctx, 'schedule')
    if (schedule === undefined || typeof schedule.create !== 'function') {
      return { ok: false, error: '官方日程服务不可用（ctx.schedule 未注册）' }
    }
    const trigger = scheduleTriggerOf(routine)
    if (trigger === null) return { ok: false, error: '该日程没有定时触发，仅支持 webhook / 手动' }
    const sessionId = lastSessionIdOf(bot)
    if (sessionId === '') return { ok: false, error: 'Bot 还没有会话，日程已保存但定时尚未启用' }
    const request: Record<string, unknown> = {
      title: routine.name.slice(0, 120),
      prompt: routine.instruction,
    }
    if (typeof trigger.cron === 'string' && trigger.cron !== '') {
      request.cron = { expression: trigger.cron, time_zone: trigger.timezone ?? localTimeZone() }
    } else if (typeof trigger.everySeconds === 'number' && trigger.everySeconds > 0) {
      request.every_seconds = trigger.everySeconds
    } else {
      return { ok: false, error: '日程缺少 cron 或 everySeconds' }
    }
    const record = await schedule.create(sessionId, request)
    const scheduleId = typeof record?.id === 'string' ? record.id : ''
    if (scheduleId === '') return { ok: false, error: '官方日程服务没有返回 id' }
    return { ok: true, scheduleId }
  } catch (error) {
    return { ok: false, error: '创建官方日程失败：' + errorText(error) }
  }
}

/** 尽力把本地修改同步到官方 schedule（compare-and-update 需要先读 expected）。 */
export async function updateScheduleForRoutine(ctx: any, routine: RoutineRecord, bot: BotRecord): Promise<ScheduleApplyResult> {
  try {
    const schedule = serviceOf(ctx, 'schedule')
    if (schedule === undefined || typeof schedule.update !== 'function' || typeof schedule.list !== 'function') {
      return { ok: false, error: '官方日程服务不可用（ctx.schedule 未注册）' }
    }
    if (typeof routine.scheduleId !== 'string' || routine.scheduleId === '') {
      return { ok: false, error: '该日程还没有官方任务' }
    }
    const sessionId = lastSessionIdOf(bot)
    if (sessionId === '') return { ok: false, error: 'Bot 还没有会话' }
    const list = await schedule.list({ sessionId })
    const expected = Array.isArray(list) ? list.find((item: any) => String(item?.id) === routine.scheduleId) : undefined
    if (expected === undefined) return { ok: false, error: '官方日程记录不存在（可能已被删除）' }
    const trigger = scheduleTriggerOf(routine)
    const change = trigger !== null && typeof trigger.cron === 'string' && trigger.cron !== ''
      ? { kind: 'cron', cron: { expression: trigger.cron, time_zone: trigger.timezone ?? localTimeZone() } }
      : trigger !== null && typeof trigger.everySeconds === 'number' && trigger.everySeconds > 0
        ? { kind: 'every', every_seconds: trigger.everySeconds }
        : undefined
    const result = await schedule.update({
      sessionId,
      id: routine.scheduleId,
      expected,
      title: routine.name.slice(0, 120),
      prompt: routine.instruction,
      ...(change !== undefined ? { change } : {}),
    })
    if (result !== null && typeof result === 'object' && result.updated === false) {
      return { ok: false, error: '官方日程更新被拒绝：' + String(result.code ?? 'unknown') }
    }
    return { ok: true, scheduleId: routine.scheduleId }
  } catch (error) {
    return { ok: false, error: '更新官方日程失败：' + errorText(error) }
  }
}

/** 尽力删除官方 schedule 任务。 */
export async function deleteScheduleForRoutine(ctx: any, routine: RoutineRecord, bot: BotRecord): Promise<ScheduleApplyResult> {
  try {
    const schedule = serviceOf(ctx, 'schedule')
    if (schedule === undefined || typeof schedule.delete !== 'function') return { ok: false, error: '官方日程服务不可用' }
    if (typeof routine.scheduleId !== 'string' || routine.scheduleId === '') return { ok: true }
    const sessionId = lastSessionIdOf(bot)
    if (sessionId === '') return { ok: false, error: 'Bot 还没有会话' }
    await schedule.delete({ sessionId, id: routine.scheduleId })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: '删除官方日程失败：' + errorText(error) }
  }
}

/* ───────────────────────────────── 业务 CRUD ────────────────────────────── */

export interface RoutineMutationResult {
  ok: boolean
  routine?: RoutineRecord
  schedule?: ScheduleApplyResult
  error?: string
}

export async function createRoutine(ctx: any, body: Record<string, unknown>): Promise<RoutineMutationResult> {
  try {
    const parsed = parseRoutineCreate(body)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const bot = findBot(parsed.value.botId)
    if (bot === null) return { ok: false, error: 'Bot 不存在' }
    const now = Date.now()
    const routine: RoutineRecord = {
      id: newRecordId('routine'),
      botId: bot.id,
      name: parsed.value.name,
      instruction: parsed.value.instruction,
      enabled: parsed.value.enabled,
      key: parsed.value.key,
      triggers: buildTriggers(parsed.value),
      runs: [],
      createdAt: now,
      updatedAt: now,
    }
    insertRoutine(routine)
    const schedule = await createScheduleForRoutine(ctx, routine, bot)
    if (schedule.ok && schedule.scheduleId !== undefined) {
      updateRoutineRecord(routine.id, { scheduleId: schedule.scheduleId })
    }
    return { ok: true, routine: findRoutine(routine.id) ?? routine, schedule }
  } catch (error) {
    return { ok: false, error: '创建日程失败：' + errorText(error) }
  }
}

export async function updateRoutine(ctx: any, id: string, body: Record<string, unknown>): Promise<RoutineMutationResult> {
  try {
    const routine = findRoutine(id)
    if (routine === null) return { ok: false, error: '日程不存在' }
    const bot = findBot(routine.botId)
    if (bot === null) return { ok: false, error: 'Bot 不存在' }
    const parsed = parseRoutineUpdate(body)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const patch: Record<string, unknown> = {}
    if (parsed.value.name !== undefined) patch.name = parsed.value.name
    if (parsed.value.instruction !== undefined) patch.instruction = parsed.value.instruction
    if (parsed.value.enabled !== undefined) patch.enabled = parsed.value.enabled
    if (parsed.value.cron !== undefined || parsed.value.everySeconds !== undefined || parsed.value.timezone !== undefined) {
      const trigger = scheduleTriggerOf(routine) ?? { type: 'schedule' as const }
      const next: RoutineTrigger = {
        type: 'schedule',
        cron: parsed.value.cron !== undefined ? parsed.value.cron : trigger.cron,
        ...(parsed.value.everySeconds !== undefined
          ? { everySeconds: parsed.value.everySeconds }
          : trigger.everySeconds !== undefined ? { everySeconds: trigger.everySeconds } : {}),
        ...(parsed.value.timezone !== undefined
          ? { timezone: parsed.value.timezone }
          : trigger.timezone !== undefined ? { timezone: trigger.timezone } : {}),
      }
      const triggers = routine.triggers.filter((item) => item.type !== 'schedule')
      triggers.unshift(next)
      patch.triggers = triggers
    }
    updateRoutineRecord(id, patch as Partial<RoutineRecord>)
    const updated = findRoutine(id) ?? routine
    let schedule: ScheduleApplyResult
    if (updated.scheduleId !== undefined) {
      schedule = await updateScheduleForRoutine(ctx, updated, bot)
    } else if (scheduleTriggerOf(updated) !== null) {
      schedule = await createScheduleForRoutine(ctx, updated, bot)
      if (schedule.ok && schedule.scheduleId !== undefined) updateRoutineRecord(id, { scheduleId: schedule.scheduleId })
    } else {
      schedule = { ok: true }
    }
    return { ok: true, routine: findRoutine(id) ?? updated, schedule }
  } catch (error) {
    return { ok: false, error: '更新日程失败：' + errorText(error) }
  }
}

export async function removeRoutine(ctx: any, id: string): Promise<{ ok: boolean; error?: string; schedule?: ScheduleApplyResult }> {
  try {
    const routine = findRoutine(id)
    if (routine === null) return { ok: false, error: '日程不存在' }
    const bot = findBot(routine.botId)
    const schedule = bot === null ? { ok: true } : await deleteScheduleForRoutine(ctx, routine, bot)
    deleteRoutineRecord(id)
    return { ok: true, schedule }
  } catch (error) {
    return { ok: false, error: '删除日程失败：' + errorText(error) }
  }
}

/* ───────────────────────────── 投递（尽力驱动 agent） ────────────────────── */

export interface RoutineDelivery {
  ok: boolean
  reason: string
}

/** 把日程内容投递给 Bot 的最近一个会话；没有可驱动 agent 时如实失败（不抛）。 */
export async function deliverRoutine(ctx: any, routine: RoutineRecord, bot: BotRecord): Promise<RoutineDelivery> {
  const sessionId = lastSessionIdOf(bot)
  if (sessionId === '') return { ok: false, reason: 'Bot 还没有会话，无法投递' }
  const controller = serviceOf(ctx, 'sessionController')
  if (controller === undefined || typeof controller.prompt !== 'function') {
    return { ok: false, reason: '没有可驱动的 agent（sessionController.prompt 不可用）' }
  }
  try {
    await controller.prompt({
      requestId: 'routine-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: routine.instruction }],
    })
    return { ok: true, reason: '已投递到 Bot 会话' }
  } catch (error) {
    return { ok: false, reason: '投递失败：' + errorText(error) }
  }
}

/** POST /routines/:id/test：立即跑一次（记录一条 test run）。 */
export async function testRoutine(ctx: any, id: string): Promise<{ ok: boolean; error?: string; delivered?: boolean; reason?: string; routine?: RoutineRecord }> {
  try {
    const routine = findRoutine(id)
    if (routine === null) return { ok: false, error: '日程不存在' }
    const bot = findBot(routine.botId)
    if (bot === null) return { ok: false, error: 'Bot 不存在' }
    const delivery = await deliverRoutine(ctx, routine, bot)
    appendRoutineRun(id, {
      at: Date.now(),
      status: delivery.ok ? 'succeeded' : 'skipped',
      trigger: 'test',
      reason: delivery.reason,
    })
    return { ok: true, delivered: delivery.ok, reason: delivery.reason, routine: findRoutine(id) ?? routine }
  } catch (error) {
    return { ok: false, error: '测试日程失败：' + errorText(error) }
  }
}

/* ───────────────────────────────── webhook 限流 ─────────────────────────── */

export interface WebhookLimiterOptions {
  globalPerHour?: number
  routinePerHour?: number
  minIntervalMs?: number
  now?: () => number
}

export type LimiterVerdict = { ok: true } | { ok: false; reason: string }

/** 内存滑动窗口限流器（进程重启归零，符合「内存令牌桶」语义）。 */
export class WebhookLimiter {
  private readonly globalPerHour: number
  private readonly routinePerHour: number
  private readonly minIntervalMs: number
  private readonly now: () => number
  private globalHits: number[] = []
  private readonly perRoutine = new Map<string, number[]>()
  private readonly lastHit = new Map<string, number>()

  constructor(options: WebhookLimiterOptions = {}) {
    this.globalPerHour = options.globalPerHour ?? WEBHOOK_LIMITS.globalPerHour
    this.routinePerHour = options.routinePerHour ?? WEBHOOK_LIMITS.routinePerHour
    this.minIntervalMs = options.minIntervalMs ?? WEBHOOK_LIMITS.minIntervalMs
    this.now = options.now ?? (() => Date.now())
  }

  take(routineId: string): LimiterVerdict {
    const now = this.now()
    const hourAgo = now - 60 * 60 * 1000
    this.globalHits = this.globalHits.filter((at) => at > hourAgo)
    const hits = (this.perRoutine.get(routineId) ?? []).filter((at) => at > hourAgo)
    if (this.globalHits.length >= this.globalPerHour) {
      this.perRoutine.set(routineId, hits)
      return { ok: false, reason: '全局限流：每小时最多 ' + this.globalPerHour + ' 次' }
    }
    if (hits.length >= this.routinePerHour) {
      this.perRoutine.set(routineId, hits)
      return { ok: false, reason: '单日程限流：每小时最多 ' + this.routinePerHour + ' 次' }
    }
    const last = this.lastHit.get(routineId)
    if (last !== undefined && now - last < this.minIntervalMs) {
      this.perRoutine.set(routineId, hits)
      return { ok: false, reason: '最小间隔限制：同一日程 ' + Math.round(this.minIntervalMs / 60000) + ' 分钟内只能触发一次' }
    }
    hits.push(now)
    this.perRoutine.set(routineId, hits)
    this.globalHits.push(now)
    this.lastHit.set(routineId, now)
    return { ok: true }
  }
}

/** 进程级共享限流器（webhook 路由使用）。 */
export const webhookLimiter = new WebhookLimiter()

/** 恒定时间比较 webhook key（先 sha256 定长再 timingSafeEqual，长度差也不泄漏）。 */
export function safeEqual(expected: string, provided: string): boolean {
  try {
    const a = createHash('sha256').update(String(expected ?? '')).digest()
    const b = createHash('sha256').update(String(provided ?? '')).digest()
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export interface WebhookResult {
  status: number
  body: Record<string, unknown>
}

/** POST /webhook/:id/:key 的完整处理（永远返回 JSON 状态，不抛）。 */
export async function handleWebhookRequest(ctx: any, routineId: string, key: string): Promise<WebhookResult> {
  try {
    const routine = findRoutine(routineId)
    if (routine === null) return { status: 404, body: { ok: false, error: '日程不存在' } }
    if (!routine.enabled) return { status: 409, body: { ok: false, error: '日程已暂停' } }
    if (!safeEqual(routine.key, key)) return { status: 403, body: { ok: false, error: 'webhook key 无效' } }
    const verdict = webhookLimiter.take(routine.id)
    if (!verdict.ok) {
      appendRoutineRun(routine.id, {
        at: Date.now(),
        status: 'failed',
        trigger: 'webhook',
        reason: verdict.reason,
      })
      return { status: 429, body: { ok: false, error: verdict.reason, rateLimited: true } }
    }
    const bot = findBot(routine.botId)
    const delivery = bot === null
      ? { ok: false, reason: 'Bot 不存在' }
      : await deliverRoutine(ctx, routine, bot)
    appendRoutineRun(routine.id, {
      at: Date.now(),
      status: delivery.ok ? 'succeeded' : 'accepted',
      trigger: 'webhook',
      reason: delivery.reason,
    })
    return {
      status: 200,
      body: {
        ok: true,
        accepted: true,
        delivered: delivery.ok,
        reason: delivery.reason,
        routineId,
      },
    }
  } catch (error) {
    return { status: 500, body: { ok: false, error: '内部错误：' + errorText(error) } }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
