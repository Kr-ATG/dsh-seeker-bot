/**
 * Personal Agent — 期刊日记（Journal）的**宿主半身**。
 *
 * ## 为什么期刊要搬到宿主
 *
 * 旧实现是前端 `buildJournal()` 里的模板文案：标题从固定数组里随机抽、摘要只是
 * 「今天与 XX 交换了 N 条消息」的套话，跟真实对话内容没有关系。用户看到的是一本
 * 看似精致、实则空洞的假杂志。这里把整条链路搬到宿主：
 *
 *   1. **真实模型生成**：用 `ctx.llm.stream` 读当天真实对话素材写一期日报，
 *      提示词要求「只依据素材、不得编造事实/数字」；
 *   2. **落盘持久化**：`<DSH_HOME>/storages/dsh-seeker-bot/personal-agent/journals/`
 *      下一天一个 JSON，刷新、清缓存、换标签页都不会丢；
 *   3. **调度器定时触发**：`scheduler.ts` 的 30s tick 调 `checkJournalTrigger()`，
 *      页面关掉也照跑（这是「Personal Agent 常驻」的核心卖点之一）。
 *
 * ## 数据契约
 *
 * 所有类型都来自 `src/shared/journal.ts`（两端共享契约），本文件**不重复定义**
 * 期刊字段，只补充宿主侧特有的请求 / 结果形状。改字段请改 shared，不要在这里
 * 另起一份——两份字段名漂移会让前端读不到数据，而且不会有任何报错。
 *
 * ## 存储布局（全部在 personal-agent 目录下）
 *
 *   journals/<id>.json   一期期刊（id = journal-<date>-<hash>，同一天同一 bot 稳定）
 *   journal-rule.json    触发规则 + 最近一条用户消息时间
 *   journal-feed.json    前端同步上来的当天素材（48h / 500 条，写入时裁剪）
 *   journal-logs.json    触发日志（最多 40 条，最新在前）
 *
 * 设计约束：
 *  - 落盘失败、生图失败都**不阻塞**期刊本身：封面只是装饰，image 留空前端会回退；
 *  - 模型输出不可控，解析与清洗层永远给出确定性结果（`sanitizeJournalRecord` 不抛）；
 *  - 并发保护是模块级单锁：手动生成与调度自动生成共用同一把锁，避免同一天写两期。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import {
  formatJournalFeedForPrompt,
  journalDateKey,
  journalDateLabel,
  journalIssue,
  normalizeJournalRule,
  sanitizeJournalRecord,
  type JournalFeed,
  type JournalFeedMessage,
  type JournalFeedStats,
  type JournalRecord,
  type JournalRule,
  type JournalTriggerLog,
} from '../../shared/journal.ts'
import { createUserMessage } from '../../vendor/dsh-llm/index.ts'
import { publish } from './events.ts'

/** 宿主路由前缀（与 index.ts 的 ROUTE 同值；封面落盘后要拼同源 asset URL）。 */
const ROUTE = '/api/personal-agent'

/** 生成超时：模型调用最多 90 秒（推理模型偶尔慢，但不该无限挂起）。 */
const GENERATE_TIMEOUT_MS = 90_000

/**
 * 封面生成超时。
 *
 * 比 /journal/image 路由默认的 180s 短得多：封面是**可选装饰**，一次期刊生成
 * 不该被生图网关拖到三分钟——用户点了「生成期刊」后会以为界面卡死。
 */
const COVER_TIMEOUT_MS = 60_000

/** 素材保留窗口：只留最近 48 小时。 */
const FEED_RETENTION_MS = 48 * 60 * 60 * 1000

/** 素材最多保留多少条消息（防止一整天的高频对话把 JSON 撑爆）。 */
const FEED_MESSAGE_LIMIT = 500

/** 触发日志最多保留多少条。 */
const LOG_LIMIT = 40

/** 单条素材正文的存储上限（prompt 侧还会再按 600 字/条裁剪）。 */
const FEED_TEXT_LIMIT = 4000

/* ───────────────────────────── 并发锁 ───────────────────────────── */

/**
 * 模块级生成锁。
 *
 * 手动「生成期刊」与调度器的自动检查共用这一把：没有它，用户在按钮上连点两下、
 * 或调度 tick 恰好与手动请求撞上，就会同时跑两次模型并写两份同 id 文件（后写的
 * 覆盖先写的，白烧一次 token）。
 */
let generating = false

/** 宿主此刻是否正在生成期刊（前端按钮转圈 / status 接口用）。 */
export function isJournalGenerating(): boolean {
  return generating
}

/* ───────────────────────────── 存储路径 ───────────────────────────── */

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** personal-agent 的数据目录（与 routines / server-messages 同级）。 */
function dataDir(): string {
  const dir = join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 期刊与封面图的存放目录（`<DSH_HOME>/storages/dsh-seeker-bot/personal-agent/journals/`）。 */
export function journalDir(): string {
  const dir = join(dataDir(), 'journals')
  mkdirSync(dir, { recursive: true })
  return dir
}

function ruleFile(): string {
  return join(dataDir(), 'journal-rule.json')
}

function feedFile(): string {
  return join(dataDir(), 'journal-feed.json')
}

function logsFile(): string {
  return join(dataDir(), 'journal-logs.json')
}

/* ───────────────────────────── JSON 读写 ───────────────────────────── */

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as T
    return parsed ?? fallback
  } catch {
    // 文件损坏时退回空值：一本坏掉的日志不能把整个期刊服务带崩
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  } catch {
    /* 落盘失败不影响本轮：下次同步会重写 */
  }
}

/* ───────────────────────────── 期刊记录 ───────────────────────────── */

/** 把任意 id 收敛成安全的文件名片段（防 `../` 把文件写到目录外）。 */
function safeJournalId(id: unknown): string {
  return String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120)
}

/**
 * 进程内「已确认存在期刊」的日期缓存。
 *
 * 调度器每 30 秒 tick 一次，触发窗口又常常是 8 小时——每次都扫一遍 journals
 * 目录（一年下来几百个文件）纯属浪费。这里只缓存「已有」这个方向：一旦某天
 * 的期刊被写出来，后续检查直接命中内存；删除记录时清空缓存，保证删掉后能重新
 * 生成。
 */
const knownJournalDates = new Set<string>()

function dateCacheKey(botId: string, date: string): string {
  return `${botId}|${date}`
}

/** 某一 bot 的某一天是否已经有期刊。 */
function hasJournalForDate(botId: string, date: string): boolean {
  const key = dateCacheKey(botId, date)
  if (knownJournalDates.has(key)) return true
  try {
    const found = readJournals().some((record) => record.botId === botId && record.date === date)
    if (found) knownJournalDates.add(key)
    return found
  } catch {
    return false
  }
}

/**
 * 读取全部期刊，按 `generatedAt` 倒序（最新在前）。
 *
 * 损坏的单个文件跳过而不是整体报错：一个手滑改坏的 JSON 不该让整个书架打不开。
 */
export function readJournals(): JournalRecord[] {
  const dir = journalDir()
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'))
  } catch {
    return []
  }
  const records: JournalRecord[] = []
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown> | null
      if (raw === null || typeof raw !== 'object') continue
      // sanitize 不读 record.model，这里显式带上，避免回读后丢失「这期用的哪个模型」
      const model = typeof raw.model === 'string' && raw.model !== '' ? raw.model : undefined
      const record = sanitizeJournalRecord(raw, model === undefined ? {} : { model })
      if (record !== null) records.push(record)
    } catch {
      /* 损坏文件跳过 */
    }
  }
  records.sort((a, b) => b.generatedAt - a.generatedAt || b.date.localeCompare(a.date))
  return records
}

/**
 * 写一期期刊（`<id>.json`）。
 *
 * 这里**不吞错**：写盘失败必须让调用方知道（否则界面显示「生成成功」、刷新后
 * 期刊消失）。调用方是 generateJournalWithModel，失败会转成可读错误。
 */
export function writeJournalRecord(record: JournalRecord): void {
  const id = safeJournalId(record.id)
  if (id === '') throw new Error('期刊 id 非法')
  const file = join(journalDir(), `${id}.json`)
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
  knownJournalDates.add(dateCacheKey(record.botId, record.date))
}

/** 删除一期期刊（只删记录文件；封面图是内容寻址的，留给目录自己回收）。 */
export function deleteJournalRecord(id: string): boolean {
  const safe = safeJournalId(id)
  if (safe === '') return false
  const file = join(journalDir(), `${safe}.json`)
  // `rmSync(force: true)` 对不存在的文件不抛错，所以先判存在——路由要靠这个
  // 返回值区分「删掉了」与「本来就没有」（404 而不是假装成功）
  if (!existsSync(file)) return false
  try {
    rmSync(file, { force: true })
    // 删掉后可能允许重新生成：清掉「已生成」缓存，否则调度器会一直跳过
    knownJournalDates.clear()
    return true
  } catch {
    return false
  }
}

/* ───────────────────────────── 规则状态 ───────────────────────────── */

/** `journal-rule.json` 的完整内容。 */
export interface JournalRuleState {
  rule: JournalRule
  /** 最近一条用户主动消息的时间（宿主判断「静默」用）。 */
  lastUserMessageAt?: number
  updatedAt: number
}

/** 读取规则状态；文件缺失 / 损坏时回落到 `DEFAULT_JOURNAL_RULE`。 */
export function readJournalRuleState(): JournalRuleState {
  const raw = readJson<Record<string, unknown>>(ruleFile(), {})
  const lastUserMessageAt = typeof raw.lastUserMessageAt === 'number' && Number.isFinite(raw.lastUserMessageAt)
    ? raw.lastUserMessageAt
    : undefined
  return {
    rule: normalizeJournalRule(raw.rule),
    ...(lastUserMessageAt !== undefined ? { lastUserMessageAt } : {}),
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  }
}

/**
 * 保存规则状态。
 *
 * `lastUserMessageAt` 未提供时**保留旧值**：前端偶尔只同步规则本身，若这里把它
 * 清空，「静默」判定会退化成「永远静默满足」，可能在用户正聊着的时候生成期刊。
 */
export function writeJournalRuleState(state: { rule: JournalRule; lastUserMessageAt?: number }): JournalRuleState {
  const previous = readJournalRuleState()
  const lastUserMessageAt = typeof state.lastUserMessageAt === 'number' && Number.isFinite(state.lastUserMessageAt)
    ? Math.round(state.lastUserMessageAt)
    : previous.lastUserMessageAt
  const next: JournalRuleState = {
    rule: normalizeJournalRule(state.rule),
    ...(lastUserMessageAt !== undefined ? { lastUserMessageAt } : {}),
    updatedAt: Date.now(),
  }
  writeJson(ruleFile(), next)
  return next
}

/* ───────────────────────────── 对话素材 ───────────────────────────── */

/** 把任意来源（HTTP body / 磁盘）的消息洗成合法素材；坏条目直接丢弃。 */
function normalizeMessages(raw: unknown): JournalFeedMessage[] {
  if (!Array.isArray(raw)) return []
  const messages: JournalFeedMessage[] = []
  /*
   * 遍历上限按「条数上限的 4 倍」兜底：正常同步不会超过 48h 的量，但 HTTP body
   * 理论上可以有任意多条；先按时间排序再取最近 500 条，才是「保留最近」的语义
   * （按输入顺序截断会丢掉最新的那部分）。
   */
  const scanLimit = FEED_MESSAGE_LIMIT * 4
  for (const item of raw) {
    if (messages.length >= scanLimit) break
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const role = record.role === 'user' ? 'user' : record.role === 'bot' ? 'bot' : null
    if (role === null) continue
    const at = typeof record.at === 'number' && Number.isFinite(record.at) ? Math.round(record.at) : 0
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (at <= 0 || text === '') continue
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, 80) : ''
    const botId = typeof record.botId === 'string' ? record.botId.trim().slice(0, 64) : ''
    const botName = typeof record.botName === 'string' ? record.botName.trim().slice(0, 40) : ''
    messages.push({
      ...(id !== '' ? { id } : {}),
      ...(botId !== '' ? { botId } : {}),
      ...(botName !== '' ? { botName } : {}),
      role,
      at,
      text: text.slice(0, FEED_TEXT_LIMIT),
    })
  }
  messages.sort((a, b) => a.at - b.at)
  return messages.slice(-FEED_MESSAGE_LIMIT)
}

function normalizeStats(raw: unknown): JournalFeedStats | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0)
  return {
    messages: count(record.messages),
    userMessages: count(record.userMessages),
    botMessages: count(record.botMessages),
    activeBots: count(record.activeBots),
    memories: count(record.memories),
    routines: count(record.routines),
  }
}

/** 读取前端同步上来的当天素材。 */
export function readJournalFeed(): JournalFeed {
  const raw = readJson<Record<string, unknown>>(feedFile(), {})
  const messages = normalizeMessages(raw.messages)
  const stats = normalizeStats(raw.stats)
  const lastUserMessageAt = typeof raw.lastUserMessageAt === 'number' && Number.isFinite(raw.lastUserMessageAt)
    ? Math.round(raw.lastUserMessageAt)
    : undefined
  const syncedAt = typeof raw.syncedAt === 'number' && Number.isFinite(raw.syncedAt) ? raw.syncedAt : undefined
  return {
    messages,
    ...(stats !== undefined ? { stats } : {}),
    ...(lastUserMessageAt !== undefined ? { lastUserMessageAt } : {}),
    ...(syncedAt !== undefined ? { syncedAt } : {}),
  }
}

/**
 * 保存素材并裁剪：只留最近 48h、最多 500 条。
 *
 * 裁剪放在**写入时**而不是读取时：前端每 5 秒可能同步一次，文件必须始终是有界的，
 * 否则连续几天的长对话会把 JSON 撑到几十 MB，之后每次 tick 读它都要卡一下。
 */
export function writeJournalFeed(feed: JournalFeed): void {
  const now = Date.now()
  const cutoff = now - FEED_RETENTION_MS
  const messages = normalizeMessages(feed.messages)
    .filter((message) => message.at >= cutoff)
    .slice(-FEED_MESSAGE_LIMIT)
  const stats = normalizeStats(feed.stats)
  const lastUserMessageAt = typeof feed.lastUserMessageAt === 'number' && Number.isFinite(feed.lastUserMessageAt)
    ? Math.round(feed.lastUserMessageAt)
    : lastUserMessageAtOf(messages)
  writeJson(feedFile(), {
    messages,
    ...(stats !== undefined ? { stats } : {}),
    ...(lastUserMessageAt !== undefined ? { lastUserMessageAt } : {}),
    syncedAt: now,
  })
}

/** 素材里最后一条用户消息的时间（没有就 undefined）。 */
function lastUserMessageAtOf(messages: JournalFeedMessage[]): number | undefined {
  let latest: number | undefined
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (latest === undefined || message.at > latest) latest = message.at
  }
  return latest
}

/* ───────────────────────────── 触发日志 ───────────────────────────── */

/** 读取触发日志（最新在前，最多 40 条）。 */
export function readJournalLogs(): JournalTriggerLog[] {
  const raw = readJson<unknown>(logsFile(), [])
  if (!Array.isArray(raw)) return []
  const logs: JournalTriggerLog[] = []
  for (const item of raw.slice(0, LOG_LIMIT)) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.reason !== 'string' || record.reason === '') continue
    const journalId = typeof record.journalId === 'string' && record.journalId !== ''
      ? record.journalId.slice(0, 80)
      : ''
    logs.push({
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
      ok: record.ok === true,
      reason: record.reason.slice(0, 300),
      ...(journalId !== '' ? { journalId } : {}),
    })
  }
  return logs
}

/** 追加一条触发日志（最新在前，最多 40 条）。 */
export function appendJournalLog(log: JournalTriggerLog): void {
  const entry: JournalTriggerLog = {
    at: typeof log.at === 'number' && Number.isFinite(log.at) ? Math.round(log.at) : Date.now(),
    ok: log.ok === true,
    reason: String(log.reason ?? '').slice(0, 300),
    ...(typeof log.journalId === 'string' && log.journalId !== '' ? { journalId: log.journalId.slice(0, 80) } : {}),
  }
  const logs = [entry, ...readJournalLogs()].slice(0, LOG_LIMIT)
  writeJson(logsFile(), logs)
}

/* ───────────────────────────── 生图（封面） ───────────────────────────── */

function readModelCapabilities(ctx: any): Record<string, any> {
  // 优先 settings 命名空间；失败再读 ~/.dsh/model-capabilities.json
  try {
    const section = typeof ctx.settings?.get === 'function' ? ctx.settings.get('model-capabilities') : null
    if (section && typeof section === 'object') return section as Record<string, any>
  } catch { /* ignore */ }
  try {
    const file = join(dshHome(), 'model-capabilities.json')
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
  } catch { /* ignore */ }
  return {}
}

function providerProfile(ctx: any, providerId: string): any {
  try {
    const entries = ctx.llm.listConfigurableProviders() as any[]
    const entry = entries.find((item) => item.provider === providerId)
    if (!entry) return null
    const section = typeof ctx.settings?.get === 'function' ? ctx.settings.get(entry.settingsNs) : null
    if (!section || typeof section !== 'object') return null
    let node: any = section
    for (const key of Array.isArray(entry.settingsPath) ? entry.settingsPath : []) {
      if (node && typeof node === 'object' && key in node) node = node[key]
      else return null
    }
    return node && typeof node === 'object' ? node : null
  } catch {
    return null
  }
}

async function resolveCredential(ctx: any, envName: unknown): Promise<string | null> {
  if (typeof envName !== 'string' || envName === '') return null
  try {
    const credentials = ctx.get?.('credentials') ?? ctx.credentials
    if (!credentials || typeof credentials.resolve !== 'function') return null
    const resolved = await credentials.resolve(envName)
    return resolved ? String(resolved.value) : null
  } catch {
    return null
  }
}

function splitKey(key: string): { provider: string; model: string } | null {
  const index = key.indexOf('/')
  if (index <= 0 || index >= key.length - 1) return null
  return { provider: key.slice(0, index), model: key.slice(index + 1) }
}

async function fetchImageAsDataUrl(url: string, timeoutMs = 120_000): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 256) return null
    const type = response.headers.get('content-type') ?? 'image/png'
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/** 一次生图请求的参数（`/journal/image` 路由与期刊封面共用）。 */
export interface GenerateImageRequest {
  prompt?: string
  title?: string
  date?: string
  /** 覆盖默认 180s 超时（期刊封面用更短的超时，见 COVER_TIMEOUT_MS）。 */
  timeoutMs?: number
}

/** 生图结果（与 index.ts 原实现逐字对齐，行为不变）。 */
export interface GenerateImageResult {
  ok: boolean
  image?: string
  error?: string
  model?: string
}

/**
 * 调用当前配置的生图模型生成期刊宽幅配图（16:9）。
 *
 * 自 `index.ts` 搬来，行为逐字未变（多了一个可选的 `timeoutMs`，缺省仍是 180s）：
 * 读 model-capabilities → 解析 provider 配置与凭据 → POST 网关 → data URL 落盘
 * 到 journals 目录 → 返回同源 asset URL。失败一律 `ok:false` + 可读原因，不抛。
 */
export async function generateJournalImage(ctx: any, body: GenerateImageRequest): Promise<GenerateImageResult> {
  const caps = readModelCapabilities(ctx)
  const activeKey = typeof caps.imageActive === 'string' ? caps.imageActive : ''
  const active = splitKey(activeKey)
  if (active === null) return { ok: false, error: '尚未配置生图模型（model-capabilities.imageActive 为空）' }
  const profile = providerProfile(ctx, active.provider)
  if (!profile || typeof profile.baseURL !== 'string' || profile.baseURL === '') {
    return { ok: false, error: `生图 provider "${active.provider}" 未配置 baseURL` }
  }
  const apiKey = await resolveCredential(ctx, profile.apiKeyEnv)
  if (apiKey === null) return { ok: false, error: `未找到生图凭据 ${String(profile.apiKeyEnv ?? '')}` }
  const imagePath = typeof caps.imagePath === 'string' && caps.imagePath !== '' ? caps.imagePath : 'images/generations'
  const url = `${String(profile.baseURL).replace(/[\\/]+$/, '')}/${imagePath.replace(/^[\\/]+/, '')}`
  const prompt = String(body.prompt ?? '').trim()
  if (prompt === '') return { ok: false, error: '缺少生图提示词' }
  const timeoutMs = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) && body.timeoutMs > 0
    ? Math.round(body.timeoutMs)
    : 180_000

  const payload: Record<string, unknown> = {
    model: active.model,
    prompt,
    n: 1,
    size: '1792x1024',
    response_format: 'b64_json',
  }
  try {
    const call = async (requestBody: Record<string, unknown>): Promise<{ response: Response; rawText: string }> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { response, rawText: await response.text() }
    }
    let attempt = await call(payload)
    // 部分 OpenAI 兼容网关不认 size / response_format：按报错自动降参重试一次。
    if (!attempt.response.ok && /size|response_format|unknown|invalid|unsupported/i.test(attempt.rawText)) {
      const relaxed = { ...payload }
      delete relaxed.size
      delete relaxed.response_format
      attempt = await call(relaxed)
    }
    const { response, rawText } = attempt
    if (!response.ok) {
      return { ok: false, error: `生图接口 ${response.status}：${rawText.slice(0, 240)}` }
    }
    let data: any
    try { data = JSON.parse(rawText) } catch { return { ok: false, error: '生图接口返回非 JSON' } }
    const first = Array.isArray(data?.data) ? data.data[0] : undefined
    let image = ''
    if (first && typeof first.b64_json === 'string' && first.b64_json.length > 32) {
      image = `data:image/png;base64,${first.b64_json}`
    } else if (first && typeof first.url === 'string' && first.url !== '') {
      image = (await fetchImageAsDataUrl(first.url, timeoutMs)) ?? ''
      if (image === '') image = first.url
    }
    if (image === '') return { ok: false, error: '生图接口返回空结果' }
    let imageUrl = image
    if (image.startsWith('data:')) {
      const comma = image.indexOf(',')
      const meta = image.slice(5, comma)
      const mime = meta.split(';')[0] || 'image/png'
      const ext = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png'
      const hash = createHash('sha1').update(image).digest('hex').slice(0, 16)
      const file = join(journalDir(), `journal-${hash}${ext}`)
      if (!existsSync(file)) writeFileSync(file, Buffer.from(image.slice(comma + 1), 'base64'))
      imageUrl = `${ROUTE}/journal/asset?name=${encodeURIComponent(file.split(sep).pop() as string)}`
    }
    return { ok: true, image: imageUrl, model: `${active.provider}/${active.model}` }
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/* ───────────────────────────── 模型路由 ───────────────────────────── */

interface ResolvedChatModel {
  provider: string
  model: string
  effort?: string
}

function getLlm(ctx: any): any {
  try {
    return ctx.get?.('llm') ?? ctx.llm
  } catch {
    return undefined
  }
}

/**
 * 选一个可用的聊天模型。
 *
 * 顺序（与任务契约一致）：
 *   1. 前端指定的 `body.botModel`（provider + model 都有才采信）；
 *   2. 宿主的默认模型 `ctx.get('agentDefaultModel').currentSelection()`；
 *   3. 注册表里的第一个 provider 的第一个 model（保证「至少有个模型能跑」）。
 *
 * 都拿不到返回 null，调用方给出「未配置可用的聊天模型」——**不能**静默降级成
 * 模板文案，那会让「模型不可用」伪装成「生成成功」。
 */
async function resolveChatModel(
  ctx: any,
  wanted?: { provider?: string; model?: string; effort?: string },
): Promise<ResolvedChatModel | null> {
  const wantedProvider = String(wanted?.provider ?? '').trim()
  const wantedModel = String(wanted?.model ?? '').trim()
  if (wantedProvider !== '' && wantedModel !== '') {
    const effort = String(wanted?.effort ?? '').trim()
    return effort !== '' ? { provider: wantedProvider, model: wantedModel, effort } : { provider: wantedProvider, model: wantedModel }
  }
  try {
    const defaults = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const selection = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined
    const provider = String(selection?.provider ?? '').trim()
    const model = String(selection?.model ?? '').trim()
    if (provider !== '' && model !== '') {
      const effort = String(selection?.reasoningEffort ?? selection?.effort ?? '').trim()
      return effort !== '' ? { provider, model, effort } : { provider, model }
    }
  } catch {
    /* 宿主没有默认模型服务：继续走注册表 */
  }
  try {
    const llm = getLlm(ctx)
    const providers = typeof llm?.listProviders === 'function' ? (llm.listProviders() as any[]) : []
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = String(provider?.id ?? '').trim()
      if (id === '') continue
      const models = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
      const first = (Array.isArray(models) ? models : [])
        .map((model: any) => String(model?.id ?? '').trim())
        .find((model) => model !== '')
      if (first !== undefined) return { provider: id, model: first }
    }
  } catch {
    /* 列举失败：按「没有可用模型」处理 */
  }
  return null
}

/* ───────────────────────────── 提示词 ───────────────────────────── */

/**
 * 期刊生成的 system 提示词。
 *
 * 核心约束只有两条：**只依据素材**、**只输出 JSON**。其余是字段规格——模型
 * 不按规格写时 sanitize 层会兜底，但兜底出来的是「能渲染但不好看」的期刊，
 * 所以规格要写清楚。
 */
export function journalSystemPrompt(): string {
  return [
    '你是一位资深中文杂志编辑，负责为一位用户编写「个人日报」。',
    '你只能依据下面提供的当天对话素材写作：不得编造素材里没有的事实、数字、人名、时间或事件。',
    '素材不足以支撑某个章节时，宁可写短、写少，也不要补空话套话。',
    '',
    '写作要求：',
    '- 全部用简体中文，语气克制、具体，像一本真正的日报；不要客服腔，不要「首先 / 其次 / 综上」。',
    '- title：8–16 个字，给这一天一个角度（不要「XX 日报 / 统计 / 总结」这类公文后缀）。',
    '- subtitle：一句话副题，12–28 字。',
    '- summary：60–140 字导语，概括这一天真正发生了什么。',
    '- mood：一个词或短语（如「忙碌而有序」）；weather：只有素材里出现天气信息时才填。',
    '- quote：从当天对话里挑一句最有代表性的话（可略作整理，但不得改变原意）；没有合适的话就不填。',
    '- sections：3–4 个章节，每节 { heading, text, bullets? }；heading 4–12 字；text 80–260 字；bullets 可选，最多 4 条。',
    '- stats：3–5 个 { label, value, hint? }；数字必须来自素材统计，不得虚构。',
    '- highlights：最多 6 个 { time?, title, text?, botName? }，按时间顺序；time 用素材里的 HH:MM。',
    '- imagePrompt：16:9 编辑插画提示词，描述画面内容与风格，不要包含任何文字排版要求。',
    '',
    '输出格式（硬要求）：',
    '- 只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释、前言、后记。',
    '- 字段名必须严格使用：title, subtitle, summary, mood, weather, quote, sections, stats, highlights, imagePrompt。',
    '- 你回复的第一个字符就是 {，最后一个字符就是 }。',
    'JSON 形状：',
    '{"title":"","subtitle":"","summary":"","mood":"","weather":"","quote":"","sections":[{"heading":"","text":"","bullets":[""]}],"stats":[{"label":"","value":"","hint":""}],"highlights":[{"time":"","title":"","text":"","botName":""}],"imagePrompt":""}',
  ].join('\n')
}

/** 把日期字符串解析成本地正午的 Date（避免 UTC 切日差一天）。 */
function parseJournalDate(date: string): Date {
  const parsed = new Date(`${date}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

/** 组装期刊生成的 user 提示词：日期 + 当天素材 + 「请只输出 JSON」。 */
function buildJournalUserPrompt(feed: JournalFeed, date: string): string {
  const body = formatJournalFeedForPrompt(feed)
  return [
    `日期：${date}（${journalDateLabel(parseJournalDate(date))}）`,
    '',
    '【当天素材】',
    body === '' ? '（素材为空）' : body,
    '',
    '请只输出 JSON。',
  ].join('\n')
}

/* ───────────────────────────── JSON 解析 ───────────────────────────── */

/**
 * 把模型输出解析成 JSON 对象。
 *
 * 模型经常在 JSON 外面包一层解释或 markdown 围栏，所以：trim → 剥 ```json 围栏 →
 * 取第一个 `{` 到最后一个 `}` → JSON.parse。失败抛**可读错误**（调用方会把它变成
 * 502 的 error 字段），不要抛裸 SyntaxError——那在界面上是一串英文堆栈。
 */
export function parseJournalJson(raw: string): Record<string, unknown> {
  let text = String(raw ?? '').trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  if (fence !== null) text = fence[1].trim()
  text = text.replace(/^\uFEFF/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('模型没有返回 JSON（输出里找不到对象）')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (error: any) {
    throw new Error(`模型返回的 JSON 无法解析：${String(error?.message ?? error).slice(0, 160)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型返回的 JSON 不是对象')
  }
  return parsed as Record<string, unknown>
}

/* ───────────────────────────── 生成 ───────────────────────────── */

/** `POST /journal/generate` 的请求体（字段都可选，宿主逐个做运行时校验）。 */
export interface GenerateJournalRequest {
  botId?: string
  botName?: string
  botRole?: string
  botModel?: { provider?: string; model?: string; effort?: string }
  /** `YYYY-MM-DD`；缺省今天（本地时区）。 */
  date?: string
  auto?: boolean
  messages?: JournalFeedMessage[]
  stats?: JournalFeedStats
  lastUserMessageAt?: number
}

/** 生成结果。失败时 error 是给用户看的中文短句，不是堆栈。 */
export interface GenerateJournalResult {
  ok: boolean
  journal?: JournalRecord
  error?: string
}

/** 校验 / 归一化日期：非法或缺省时退回今天（本地时区）。 */
function normalizeDate(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T12:00:00`)
    if (!Number.isNaN(parsed.getTime())) return text
  }
  return journalDateKey(new Date())
}

/** 生成稳定的期刊 id：同一天同一 bot 永远同一个 id（重试覆盖而不是产生两期）。 */
function journalIdFor(botId: string, date: string): string {
  const digest = createHash('sha1').update(`${botId}|${date}`).digest('hex').slice(0, 8)
  const day = date.replace(/[^0-9-]/g, '') || journalDateKey(new Date())
  return `journal-${day}-${digest}`
}

/** 算期号：同 bot 下日期早于本期的期刊条数 + 1。 */
function journalIssueFor(botId: string, date: string, selfId: string): string {
  let index = 0
  try {
    for (const record of readJournals()) {
      if (record.botId !== botId) continue
      if (record.id === selfId) continue
      if (record.date < date) index += 1
    }
  } catch {
    index = 0
  }
  return journalIssue(index)
}

/** body.messages 非空时优先于本地 feed（手动生成路径会带上当天消息投影）。 */
function feedOf(request: GenerateJournalRequest): JournalFeed {
  const messages = normalizeMessages(request.messages)
  if (messages.length > 0) {
    const stats = normalizeStats(request.stats)
    const lastUserMessageAt = typeof request.lastUserMessageAt === 'number' && Number.isFinite(request.lastUserMessageAt)
      ? Math.round(request.lastUserMessageAt)
      : lastUserMessageAtOf(messages)
    return {
      messages,
      ...(stats !== undefined ? { stats } : {}),
      ...(lastUserMessageAt !== undefined ? { lastUserMessageAt } : {}),
    }
  }
  return readJournalFeed()
}

/** 生成封面；任何失败都返回空串（期刊本身照常交付）。 */
async function generateJournalCover(ctx: any, record: JournalRecord): Promise<string> {
  const prompt = String(record.imagePrompt ?? '').trim()
  if (prompt === '') return ''
  try {
    const result = await generateJournalImage(ctx, {
      prompt,
      title: record.title,
      date: record.date,
      timeoutMs: COVER_TIMEOUT_MS,
    })
    return result.ok && typeof result.image === 'string' ? result.image : ''
  } catch {
    return ''
  }
}

/**
 * 用真实模型生成一期期刊并落盘。
 *
 * 失败路径全部返回 `{ ok:false, error }`（不抛）：路由层据此回 502，前端据此回退
 * 本地模板并 toast 说明。**绝不**在这里降级成模板文案——那会让用户以为模型真的
 * 写了一期，实际拿到的是空话。
 */
export async function generateJournalWithModel(ctx: any, request: GenerateJournalRequest): Promise<GenerateJournalResult> {
  if (generating) return { ok: false, error: '正在生成中，请稍候' }
  const botId = String(request.botId ?? '').trim() || 'main'
  const date = normalizeDate(request.date)
  const feed = feedOf(request)
  if (feed.messages.length === 0) return { ok: false, error: '当天没有可总结的对话素材' }

  const llm = getLlm(ctx)
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    return { ok: false, error: '宿主未提供 llm 服务' }
  }
  const route = await resolveChatModel(ctx, request.botModel)
  if (route === null) return { ok: false, error: '未配置可用的聊天模型' }
  const modelLabel = `${route.provider}/${route.model}`

  generating = true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS)
  try {
    let raw = ''
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: buildJournalUserPrompt(feed, date) }],
        // 消息归属写当前实际装载的 bundle id：用量与会话日志按 bundle 聚合
        source: { kind: 'plugin:dsh-seeker-bot', plugin: 'dsh-seeker-bot' },
      })],
      system: journalSystemPrompt(),
      maxTokens: 3000,
      temperature: 0.6,
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
    }
    if (raw.trim() === '') return { ok: false, error: '模型没有返回内容' }

    const payload = parseJournalJson(raw)
    const generatedAt = Date.now()
    const id = journalIdFor(botId, date)
    const record = sanitizeJournalRecord(payload, {
      id,
      botId,
      date,
      dateLabel: journalDateLabel(parseJournalDate(date)),
      issue: journalIssueFor(botId, date, id),
      generatedAt,
      auto: request.auto === true,
      origin: 'host',
      model: modelLabel,
    })
    if (record === null) return { ok: false, error: '模型返回的期刊内容为空' }

    // 封面是装饰：失败就留空，前端会用本地 SVG 封面兜底
    const cover = await generateJournalCover(ctx, record)
    if (cover !== '') record.image = cover

    writeJournalRecord(record)
    return { ok: true, journal: record }
  } catch (error: any) {
    const aborted = controller.signal.aborted
    const message = aborted
      ? `生成超时（${String(Math.round(GENERATE_TIMEOUT_MS / 1000))} 秒）`
      : String(error?.message ?? error)
    return { ok: false, error: message.slice(0, 300) }
  } finally {
    clearTimeout(timer)
    generating = false
  }
}

/* ───────────────────────────── 触发检查 ───────────────────────────── */

/** `checkJournalTrigger` 的结果。reason 是给日志 / toast 看的中文短句。 */
export interface JournalCheckResult {
  ok: boolean
  reason: string
  journalId?: string
}

/**
 * 「没有素材」日志的去重集合。
 *
 * 触发窗口通常有好几小时、tick 每 30 秒一次，如果每次空素材都写一条日志，
 * 40 条上限会在半小时内被同一句话填满，真正有价值的历史记录全被挤掉。
 * 每个「bot + 目标日期」只记一条。
 */
const emptyFeedLogged = new Set<string>()

/**
 * 检查期刊规则并（满足时）生成昨日期刊。
 *
 * 判定顺序（与旧前端逻辑一致）：
 *   enabled → 窗口 hour ∈ [startHour, endHour) → 静默 → 昨日是否已有 → feed 是否有素材。
 *
 * **先做便宜判定**：前两步只读一个小 JSON + 纯计算，窗口外 / 规则关闭时每 30 秒
 * 的 tick 几乎零成本；只有进入窗口后才读 feed 与 journals 目录。
 *
 * @param now 判定用的当前时间（测试可注入）。
 * @param botId 目标 Bot（缺省主 Bot 'main'）。
 */
export async function checkJournalTrigger(ctx: any, now = Date.now(), botId = 'main'): Promise<JournalCheckResult> {
  if (generating) return { ok: false, reason: '正在生成中，请稍候' }
  const state = readJournalRuleState()
  const rule = state.rule
  if (!rule.enabled) return { ok: false, reason: '期刊规则未启用' }

  const hour = new Date(now).getHours()
  if (hour < rule.startHour || hour >= rule.endHour) {
    const pad = (value: number): string => String(value).padStart(2, '0')
    return { ok: false, reason: `不在触发窗口（${pad(rule.startHour)}:00–${pad(rule.endHour)}:00）` }
  }

  const feed = readJournalFeed()
  const lastUserMessageAt = typeof feed.lastUserMessageAt === 'number'
    ? feed.lastUserMessageAt
    : (typeof state.lastUserMessageAt === 'number' ? state.lastUserMessageAt : lastUserMessageAtOf(feed.messages))
  if (lastUserMessageAt !== undefined && now - lastUserMessageAt < rule.idleMinutes * 60_000) {
    return { ok: false, reason: `用户 ${String(rule.idleMinutes)} 分钟内还在对话，暂不生成` }
  }

  // 按本地时区切日：用 toISOString 会在 UTC+8 的 0–8 点把日期算成「今天」
  const targetDate = journalDateKey(new Date(now - 86_400_000))
  if (hasJournalForDate(botId, targetDate)) {
    return { ok: false, reason: `${targetDate} 的期刊已生成` }
  }

  if (feed.messages.length === 0) {
    const key = dateCacheKey(botId, targetDate)
    if (!emptyFeedLogged.has(key)) {
      emptyFeedLogged.add(key)
      appendJournalLog({ at: now, ok: false, reason: '当天没有可总结的对话' })
    }
    return { ok: false, reason: '当天没有可总结的对话' }
  }

  const result = await generateJournalWithModel(ctx, {
    botId,
    // 主 Bot 的默认名（旧名「小墨助手」已由前端 normalizeState 迁移为 Seeker）
    botName: 'Seeker',
    date: targetDate,
    auto: true,
    messages: feed.messages,
    ...(feed.stats !== undefined ? { stats: feed.stats } : {}),
    ...(lastUserMessageAt !== undefined ? { lastUserMessageAt } : {}),
  })

  if (result.ok && result.journal !== undefined) {
    const reason = `已生成 ${targetDate} 的期刊`
    appendJournalLog({ at: Date.now(), ok: true, reason, journalId: result.journal.id })
    // 调度生成也要推给在线前端：页面开着时能立刻看到「昨日期刊已生成」
    publish(botId, { type: 'journal', journal: result.journal, source: 'auto' })
    return { ok: true, reason, journalId: result.journal.id }
  }

  const error = result.error ?? '未知原因'
  appendJournalLog({ at: Date.now(), ok: false, reason: `生成失败：${error}` })
  return { ok: false, reason: error }
}

/** 测试面：只给 scripts/ 里的冒烟用，不是公共 API。 */
export const __journalTest = {
  journalIdFor,
  normalizeDate,
  normalizeMessages,
  feedOf,
  dataDir,
  journalDir,
  knownJournalDates,
}
