/**
 * dsh-seeker-bot — 主动找我（host 半身）。
 *
 * 目标：只在「有新信息」时打扰用户。这里实现三件事：
 *   1. 配置（enabled / freq / from / to / lastAt）的读写；
 *   2. 事件指纹去重（24h 内同一事件只发一次）；
 *   3. 时间窗口判断与候选事件排序，供 POST /bots/:id/proactive/test 诊断。
 *
 * 注意：本模块不真正发消息。没有可驱动的 agent 时 test 端点如实返回
 * skipped，绝不假装已发送。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  findBot, listRoutines, loadState, updateBot, type BotProactive, type BotRecord,
} from './state.js'
import { serviceOf } from './sessions.js'

export const PROACTIVE_SEEN_TTL_MS = 24 * 60 * 60 * 1000

export interface ProactiveEvent {
  type: string
  fingerprint?: string
  title?: string
  at?: number
  severity?: number
}

export interface ProactiveDecision {
  willSend: boolean
  reason: string
  event?: ProactiveEvent
  /** 本模块只做判定；真正投递属于后续链路。 */
  skipped: true
  note: string
}

const seen = new Map<string, number>()

/** 事件指纹：显式 fingerprint 优先，否则用 type/title/时间窗拼一个稳定哈希。 */
export function fingerprintOf(event: ProactiveEvent, now = Date.now()): string {
  if (typeof event?.fingerprint === 'string' && event.fingerprint !== '') return event.fingerprint
  const bucket = event?.at !== undefined ? Math.floor(event.at / PROACTIVE_SEEN_TTL_MS) : Math.floor(now / PROACTIVE_SEEN_TTL_MS)
  const source = [event?.type ?? '', event?.title ?? '', String(bucket)].join('|')
  return createHash('sha1').update(source).digest('hex')
}

export function pruneSeen(now = Date.now()): void {
  for (const [fingerprint, at] of seen) {
    if (now - at > PROACTIVE_SEEN_TTL_MS) seen.delete(fingerprint)
  }
}

export function isDuplicate(fingerprint: string, now = Date.now()): boolean {
  const at = seen.get(fingerprint)
  if (at === undefined) return false
  if (now - at > PROACTIVE_SEEN_TTL_MS) {
    seen.delete(fingerprint)
    return false
  }
  return true
}

export function markProactiveSeen(fingerprint: string, now = Date.now()): void {
  seen.set(fingerprint, now)
}

/** 仅测试用：清空去重表。 */
export function __resetProactiveSeen(): void {
  seen.clear()
}

/** 解析 HH:mm；坏格式返回 null。 */
export function parseHm(text: string): number | null {
  if (typeof text !== 'string') return null
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim())
  if (match === null) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** 判断当前时刻是否落在 from-to 窗口（支持跨午夜；配置坏了不挡）。 */
export function inProactiveWindow(from: string, to: string, now: Date = new Date()): boolean {
  const start = parseHm(from)
  const end = parseHm(to)
  if (start === null || end === null) return true
  const current = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true
  if (start < end) return current >= start && current <= end
  return current >= start || current <= end
}

function isProactiveEvent(value: unknown): value is ProactiveEvent {
  return value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).type === 'string'
}

/** 纯判定：配置 + 事件 → 是否该发、为什么。会读去重表但不写。 */
export function evaluateProactive(
  config: BotProactive | undefined,
  events: readonly ProactiveEvent[],
  now = Date.now(),
): ProactiveDecision {
  const base = { skipped: true as const, note: '仅做判定，不会真正发送消息' }
  if (config === undefined || config.enabled !== true) return { ...base, willSend: false, reason: 'disabled' }
  if (config.freq === 'off') return { ...base, willSend: false, reason: 'freq-off' }
  if (!inProactiveWindow(config.from, config.to, new Date(now))) {
    return { ...base, willSend: false, reason: 'outside-window' }
  }
  const candidates = events.filter(isProactiveEvent)
  if (candidates.length === 0) return { ...base, willSend: false, reason: 'no-candidates' }
  const fresh = candidates.filter((event) => !isDuplicate(fingerprintOf(event, now), now))
  if (fresh.length === 0) return { ...base, willSend: false, reason: 'duplicated' }
  fresh.sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0) || (b.at ?? 0) - (a.at ?? 0))
  return { ...base, willSend: true, reason: 'candidate', event: fresh[0] }
}

/** 收集某 Bot 近 24h 的候选事件（目前：失败的日程运行 + 等待拍板）。 */
export function collectProactiveEvents(botId: string, now = Date.now()): ProactiveEvent[] {
  const events: ProactiveEvent[] = []
  for (const routine of listRoutines(botId)) {
    for (const run of routine.runs) {
      if (run.status !== 'failed') continue
      if (now - run.at > PROACTIVE_SEEN_TTL_MS) continue
      events.push({
        type: 'routine.failed',
        fingerprint: 'routine:' + routine.id + ':' + run.at,
        title: '日程「' + routine.name + '」运行失败',
        at: run.at,
        severity: 3,
      })
    }
  }
  const bot = findBot(botId)
  if (bot !== null && bot.status === 'needs-you') {
    events.push({
      type: 'bot.needs-you',
      fingerprint: 'bot:' + botId + ':needs-you:' + Math.floor(now / PROACTIVE_SEEN_TTL_MS),
      title: '「' + bot.name + '」在等你拍板',
      at: now,
      severity: 2,
    })
  }
  return events
}

export interface ProactiveTestResult extends ProactiveDecision {
  candidateCount: number
  lastAt: number | null
}

/** POST /bots/:id/proactive/test 的判定面：可带 events 覆盖候选。 */
export function testProactive(bot: BotRecord, inputEvents: unknown, now = Date.now()): ProactiveTestResult {
  const events = Array.isArray(inputEvents)
    ? inputEvents.filter(isProactiveEvent)
    : collectProactiveEvents(bot.id, now)
  const decision = evaluateProactive(bot.proactive, events, now)
  return {
    ...decision,
    candidateCount: events.length,
    lastAt: typeof bot.proactive?.lastAt === 'number' ? bot.proactive.lastAt : null,
  }
}

/** 写主动找我配置（PATCH 语义，未传字段保持原值）。 */
export function setProactiveConfig(botId: string, value: unknown): BotRecord | null {
  return updateBot(botId, { proactive: value })
}

/** 记录一次真正发送（供后续投递链路调用），刷新 lastAt 与去重表。 */
export function recordProactiveSent(botId: string, event: ProactiveEvent, now = Date.now()): BotRecord | null {
  pruneSeen(now)
  markProactiveSeen(fingerprintOf(event, now), now)
  return updateBot(botId, { proactive: { ...(findBot(botId)?.proactive ?? {}), lastAt: now } })
}

/* ───────────────────── 真正的投递：定时器 + sessionController.prompt ───────────────────── */

/** 频率 → 最小间隔（毫秒）。自定义 cron 暂按 daily 处理，避免静默变成「每轮都发」。 */
export function proactiveIntervalMs(freq: string | undefined): number {
  switch (freq) {
    case '2h': return 2 * 60 * 60 * 1000
    case '4h': return 4 * 60 * 60 * 1000
    case 'weekly': return 7 * 24 * 60 * 60 * 1000
    case 'daily':
    default: return 24 * 60 * 60 * 1000
  }
}

export interface ProactiveTickResult {
  botId: string
  botName: string
  action: 'sent' | 'skipped' | 'error'
  reason: string
  event?: ProactiveEvent
}

/**
 * 跑一轮主动找我：遍历开启了 proactive 的 Bot，有「值得说的新事件」才发。
 *
 * 发送链路走官方 sessionController.prompt（与用户手动发消息同一条入口），
 * 因此消息会正常进入该 Bot 的会话、参与系统提示与用量统计。
 * 没有会话 / 没有 prompt 服务时如实 skipped，不写 lastAt（下次还能重试）。
 */
export async function runProactiveTick(ctx: any, now = Date.now()): Promise<ProactiveTickResult[]> {
  const results: ProactiveTickResult[] = []
  let bots: BotRecord[] = []
  try { bots = loadState().bots } catch { return results }
  for (const bot of bots) {
    const config = bot.proactive
    if (config === undefined || config.enabled !== true) continue
    if (bot.paused === true) continue
    const interval = proactiveIntervalMs(config.freq)
    if (typeof config.lastAt === 'number' && now - config.lastAt < interval) continue
    const events = collectProactiveEvents(bot.id, now)
    const decision = evaluateProactive(config, events, now)
    if (!decision.willSend || decision.event === undefined) continue
    const sessionId = Array.isArray(bot.sessionIds) && bot.sessionIds.length > 0
      ? bot.sessionIds[bot.sessionIds.length - 1] as string
      : ''
    if (sessionId === '') {
      results.push({ botId: bot.id, botName: bot.name, action: 'skipped', reason: 'no-session', event: decision.event })
      continue
    }
    const controller = serviceOf(ctx, 'sessionController')
    if (controller === undefined || typeof controller.prompt !== 'function') {
      results.push({ botId: bot.id, botName: bot.name, action: 'skipped', reason: 'no-prompt-service', event: decision.event })
      continue
    }
    try {
      await controller.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '主动汇报：' + (decision.event.title ?? '有新的变化') + '。请用三句话告诉我最要紧的变化和下一步。' }],
      })
      recordProactiveSent(bot.id, decision.event, now)
      results.push({ botId: bot.id, botName: bot.name, action: 'sent', reason: 'candidate', event: decision.event })
    } catch (error) {
      results.push({ botId: bot.id, botName: bot.name, action: 'error', reason: error instanceof Error ? error.message : String(error), event: decision.event })
    }
  }
  return results
}

/**
 * 启动常驻定时器（默认 60s 一次）。返回停止函数，交给 ctx.effect 回收。
 * 定时器本身不抛：每轮内部失败都转成结果列表，不影响宿主。
 */
export function startProactiveScheduler(ctx: any, intervalMs = 60_000): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void runProactiveTick(ctx).catch(() => {}).finally(() => { running = false })
  }, Math.max(15_000, intervalMs))
  try { (timer as { unref?: () => void }).unref?.() } catch { /* 浏览器/测试桩没有 unref */ }
  return () => { clearInterval(timer) }
}
