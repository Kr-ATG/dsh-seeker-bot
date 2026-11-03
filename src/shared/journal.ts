/**
 * Personal Agent — 期刊日记（Journal）的**两端共享契约**。
 *
 * 这里是期刊数据模型的唯一来源：
 *   · 宿主半身用它生成 / 落盘 / 调度期刊（src/host/personal/journal.ts）；
 *   · 浏览器半身用它渲染阅读器、本地回退与消息卡（src/client/personal/journal/*）。
 *
 * 本文件只放**类型、常量与纯函数**：两端都要 import，不能出现 node:/DOM 依赖，
 * 也不能有任何副作用（与 shared/realtime-protocol.ts 同一约束）。
 *
 * ## 为什么期刊要重写成宿主生成
 *
 * 旧实现是前端 `buildJournal()` 里的模板文案：标题从固定数组里随机抽、摘要只是
 * 「今天与 XX 交换了 N 条消息」的套话，跟真实对话内容没有关系。用户看到的是一本
 * 看似精致、实则空洞的假杂志。现在的契约要求：
 *   1. 期刊正文必须由模型**基于当天真实对话素材**生成（宿主调用 ctx.llm.stream）；
 *   2. 失败时前端可以回退本地模板，但必须用真实统计与真实摘录，且标记 origin='local'；
 *   3. 期刊落盘到宿主（~/.dsh/storages/dsh-seeker-bot/personal-agent/journals/），
 *      刷新、清缓存、换标签页都不会丢。
 */

/** 期刊正文里的一段。 */
export interface JournalSection {
  heading: string
  /** 正文（支持换行；渲染端按空行分段）。 */
  text: string
  /** 可选的要点列表（模型没给就不渲染）。 */
  bullets?: string[]
}

/** 「本期数据」里的一个数字块。 */
export interface JournalStat {
  label: string
  value: string
  /** 次级说明，例如「较前日 +12%」。 */
  hint?: string
}

/** 「当日速览」时间线上的一个事件。 */
export interface JournalHighlight {
  /** 发生时间，如「09:40」；模型给不出就省略。 */
  time?: string
  title: string
  /** 一句话说明。 */
  text?: string
  /** 相关 Bot 名称。 */
  botName?: string
}

/**
 * 一期期刊。
 *
 * 与旧版 localStorage 数据兼容：新增字段全部可选，旧记录直接按「没有这些字段」
 * 渲染即可，不需要迁移脚本。
 */
export interface JournalRecord {
  id: string
  botId: string
  title: string
  subtitle?: string
  /** ISO 日期（本地时区），如 `2026-11-01`。 */
  date: string
  /** 展示日期，如 `2026 年 11 月 1 日`。 */
  dateLabel: string
  /** 期号，如 `No. 016`。 */
  issue: string
  summary: string
  sections: JournalSection[]
  quote?: string
  mood?: string
  weather?: string
  /** 封面图（宿主同源 URL、data URL 或 SVG data URL）。 */
  image?: string
  /** 生图提示词（重试 / 补图时用）。 */
  imagePrompt?: string
  generatedAt: number
  /** true = 宿主调度自动生成；false/缺省 = 用户手动触发。 */
  auto?: boolean
  /** 「本期数据」数字块。 */
  stats?: JournalStat[]
  /** 「当日速览」时间线。 */
  highlights?: JournalHighlight[]
  /** 生成来源：host = 模型生成并落盘；local = 前端模板回退。 */
  origin?: 'host' | 'local'
  /** 实际使用的模型（host 生成才有）。 */
  model?: string
}

/** 期刊触发规则（与前端 PersonalSettings.journalRule 对齐）。 */
export interface JournalRule {
  enabled: boolean
  /** 触发窗口起始小时（含），0–23。 */
  startHour: number
  /** 触发窗口结束小时（不含），1–24。 */
  endHour: number
  /** 用户静默满多少分钟后才允许生成。 */
  idleMinutes: number
}

/** 同步给宿主的一条对话投影（只用于生成期刊，不是消息库）。 */
export interface JournalFeedMessage {
  id?: string
  botId?: string
  botName?: string
  role: 'user' | 'bot'
  /** 毫秒时间戳。 */
  at: number
  /** 纯文本内容（渲染端已把 blocks 拍平）。 */
  text: string
}

/** 当天素材的统计（前端算好传给宿主，避免宿主再猜）。 */
export interface JournalFeedStats {
  /** 全部消息数（用户 + Bot）。 */
  messages: number
  userMessages: number
  botMessages: number
  /** 当天有对话的 Bot 数。 */
  activeBots: number
  /** 当天新增记忆数（没有就 0）。 */
  memories: number
  /** 启用的例行任务数（没有就 0）。 */
  routines: number
}

/** 一次同步的完整素材包。 */
export interface JournalFeed {
  messages: JournalFeedMessage[]
  stats?: JournalFeedStats
  /** 最近一条用户主动消息的时间（宿主判断「静默」用）。 */
  lastUserMessageAt?: number
  syncedAt?: number
}

/** 一次触发检查的记录（规则面板展示）。 */
export interface JournalTriggerLog {
  at: number
  ok: boolean
  reason: string
  journalId?: string
}

/** `GET /journal/status` 的响应体。 */
export interface JournalStatus {
  rule: JournalRule
  logs: JournalTriggerLog[]
  /** 宿主正在生成中（前端按钮转圈用）。 */
  generating: boolean
  lastGeneratedAt?: number
}

/** 默认规则：与旧版一致（第二天 0:00–8:00、静默 30 分钟）。 */
export const DEFAULT_JOURNAL_RULE: JournalRule = {
  enabled: true,
  startHour: 0,
  endHour: 8,
  idleMinutes: 30,
}

/** 期刊规则的单次触发窗口上限：超过 12 小时的窗口大概率是配置错误。 */
export const JOURNAL_MAX_WINDOW_HOURS = 12

function asString(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 把任意来源（localStorage / HTTP body）的规则洗成合法值。 */
export function normalizeJournalRule(raw: unknown): JournalRule {
  const record = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const startHour = clampInt(record.startHour, 0, 23, DEFAULT_JOURNAL_RULE.startHour)
  const maxEnd = Math.min(24, startHour + JOURNAL_MAX_WINDOW_HOURS)
  const endHour = clampInt(record.endHour, Math.max(1, startHour + 1), Math.max(1, maxEnd), DEFAULT_JOURNAL_RULE.endHour)
  return {
    enabled: record.enabled !== false,
    startHour,
    endHour: Math.max(endHour, startHour + 1),
    idleMinutes: clampInt(record.idleMinutes, 0, 24 * 60, DEFAULT_JOURNAL_RULE.idleMinutes),
  }
}

function sanitizeSections(raw: unknown): JournalSection[] {
  if (!Array.isArray(raw)) return []
  const sections: JournalSection[] = []
  for (const item of raw.slice(0, 6)) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const heading = asString(record.heading, 60)
    const text = asString(record.text, 2400)
    if (heading === '' && text === '') continue
    const bullets = Array.isArray(record.bullets)
      ? record.bullets.map((bullet) => asString(bullet, 240)).filter((bullet) => bullet !== '').slice(0, 8)
      : []
    sections.push({
      heading: heading === '' ? `第 ${String(sections.length + 1)} 节` : heading,
      text,
      ...(bullets.length > 0 ? { bullets } : {}),
    })
  }
  return sections
}

function sanitizeStats(raw: unknown): JournalStat[] {
  if (!Array.isArray(raw)) return []
  const stats: JournalStat[] = []
  for (const item of raw.slice(0, 6)) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = asString(record.label, 20)
    const value = asString(record.value, 20)
    if (label === '' || value === '') continue
    const hint = asString(record.hint, 40)
    stats.push({ label, value, ...(hint !== '' ? { hint } : {}) })
  }
  return stats
}

function sanitizeHighlights(raw: unknown): JournalHighlight[] {
  if (!Array.isArray(raw)) return []
  const highlights: JournalHighlight[] = []
  for (const item of raw.slice(0, 10)) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title = asString(record.title, 80)
    if (title === '') continue
    const time = asString(record.time, 12)
    const text = asString(record.text, 260)
    const botName = asString(record.botName, 40)
    highlights.push({
      title,
      ...(time !== '' ? { time } : {}),
      ...(text !== '' ? { text } : {}),
      ...(botName !== '' ? { botName } : {}),
    })
  }
  return highlights
}

export interface SanitizeJournalOptions {
  id?: string
  botId?: string
  date?: string
  dateLabel?: string
  issue?: string
  generatedAt?: number
  auto?: boolean
  origin?: 'host' | 'local'
  model?: string
}

/**
 * 把模型返回的 JSON（或旧数据）洗成一期合法期刊。
 *
 * 返回 null = 连标题与正文都没有，无法成为一期期刊（调用方应回退或报错）。
 * 这里**不抛异常**：模型输出不可控，清洗层必须永远能给出确定性结果。
 */
export function sanitizeJournalRecord(raw: unknown, options: SanitizeJournalOptions = {}): JournalRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const title = asString(record.title, 80)
  const summary = asString(record.summary, 600)
  const sections = sanitizeSections(record.sections)
  if (title === '' && summary === '' && sections.length === 0) return null

  const now = Date.now()
  const generatedAt = typeof options.generatedAt === 'number'
    ? options.generatedAt
    : (typeof record.generatedAt === 'number' ? record.generatedAt : now)
  const date = options.date ?? asString(record.date, 32) ?? ''
  const dateLabel = options.dateLabel ?? asString(record.dateLabel, 40) ?? ''
  const issue = options.issue ?? asString(record.issue, 24) ?? ''

  return {
    id: options.id ?? (asString(record.id, 64) || `journal-${now.toString(36)}`),
    botId: options.botId ?? asString(record.botId, 64) ?? 'main',
    title: title === '' ? '未命名的一期' : title,
    ...(asString(record.subtitle, 120) !== '' ? { subtitle: asString(record.subtitle, 120) } : {}),
    date,
    dateLabel,
    issue,
    summary: summary === '' ? (sections[0]?.text ?? '') : summary,
    sections,
    ...(asString(record.quote, 400) !== '' ? { quote: asString(record.quote, 400) } : {}),
    ...(asString(record.mood, 40) !== '' ? { mood: asString(record.mood, 40) } : {}),
    ...(asString(record.weather, 40) !== '' ? { weather: asString(record.weather, 40) } : {}),
    ...(asString(record.image, 2_000_000) !== '' ? { image: asString(record.image, 2_000_000) } : {}),
    ...(asString(record.imagePrompt, 1_200) !== '' ? { imagePrompt: asString(record.imagePrompt, 1_200) } : {}),
    generatedAt,
    auto: options.auto ?? record.auto === true,
    ...(sanitizeStats(record.stats).length > 0 ? { stats: sanitizeStats(record.stats) } : {}),
    ...(sanitizeHighlights(record.highlights).length > 0 ? { highlights: sanitizeHighlights(record.highlights) } : {}),
    origin: options.origin ?? (record.origin === 'host' || record.origin === 'local' ? record.origin : undefined),
    ...(options.model !== undefined ? { model: options.model } : {}),
  }
}

/** 本地时区的 `YYYY-MM-DD`（不能用 toISOString，它按 UTC 切日会错一天）。 */
export function journalDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${String(y)}-${m}-${d}`
}

/** 展示用日期：`2026 年 11 月 1 日`。 */
export function journalDateLabel(date: Date): string {
  return `${String(date.getFullYear())} 年 ${String(date.getMonth() + 1)} 月 ${String(date.getDate())} 日`
}

/** 期号：按时间升序的第 index+1 期。 */
export function journalIssue(index: number): string {
  return `No. ${String(Math.max(1, index + 1)).padStart(3, '0')}`
}

/** 期刊正文素材的纯文本长度上限（防止把整天的超长对话塞爆上下文）。 */
export const JOURNAL_FEED_TEXT_LIMIT = 12_000

/** 把素材拍成给模型看的纯文本（host 生成 prompt 用，前端本地回退也可复用）。 */
export function formatJournalFeedForPrompt(feed: JournalFeed): string {
  const stats = feed.stats
  const lines: string[] = []
  if (stats !== undefined) {
    lines.push(
      `【当天统计】消息 ${String(stats.messages)} 条（用户 ${String(stats.userMessages)} / Bot ${String(stats.botMessages)}），`
      + `活跃 Bot ${String(stats.activeBots)} 个，新增记忆 ${String(stats.memories)} 条，启用例行任务 ${String(stats.routines)} 条。`,
    )
  }
  const messages = [...feed.messages].sort((a, b) => a.at - b.at)
  let budget = JOURNAL_FEED_TEXT_LIMIT
  for (const message of messages) {
    if (budget <= 0) break
    const text = message.text.trim().replace(/\s+/g, ' ')
    if (text === '') continue
    const clipped = text.slice(0, Math.min(600, budget))
    budget -= clipped.length
    const time = new Date(message.at)
    const hh = String(time.getHours()).padStart(2, '0')
    const mm = String(time.getMinutes()).padStart(2, '0')
    const who = message.role === 'user' ? '用户' : (message.botName ?? 'Bot')
    lines.push(`[${hh}:${mm}] ${who}：${clipped}`)
  }
  return lines.join('\n')
}
