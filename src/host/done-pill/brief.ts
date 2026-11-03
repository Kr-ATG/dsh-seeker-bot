/**
 * dsh-seeker-bot — 每日情报卡（Daily Brief）的**宿主半身**。
 *
 * ## 这是什么
 *
 * 对话完成胶囊上方那张「斜插半截卡」的内容来源：每天一份「AI 前沿 + 世界/国内
 * 要闻」的日报。数据是**宿主先抓新闻站 RSS（不够再用联网搜索补）、再让模型整理
 * 成结构化 JSON** —— 素材保证「今天真的发生了」，模型负责「挑出值得说的、写成
 * 能读的」。
 *
 * ## 为什么整条链路必须在宿主
 *
 * 1. **页面关掉也要跑**：用户第二天打开 DSH 就该看到当天的卡，而不是「打开页面
 *    才开始联网」。定时器必须活在常驻进程里（浏览器定时器一关标签页就停）。
 * 2. **浏览器侧拿不到搜索**：`ctx.web` 是宿主服务，前端只能经宿主路由间接用。
 * 3. **token 只烧一次**：生成结果落盘，刷新、换标签页、清缓存都读同一份文件。
 *
 * ## 链路（RSS 为主、搜索兜底，逐段降级，绝不伪造）
 *
 *   ① 并行 ctx.web.fetch 抓 BRIEF_FEEDS 的 RSS（单源 15s 超时）→ parseBriefFeed
 *      → 过滤 3 天前的旧闻 → 按 URL 去重
 *   ② 素材不足 6 条时用 ctx.web.search 补（见下面的「为什么 RSS 是主通道」）
 *   ③ buildBriefUserPrompt（按 lane 分组）→ ctx.llm.stream → parseBriefJson
 *      → sanitizeBriefRecord → 落盘
 *        `<DSH_HOME>/storages/dsh-seeker-bot/done-pill/briefs/<date>.json`
 *
 * ## 为什么 RSS 是主通道、搜索只是兜底
 *
 * 实测（2026-11-03）宿主搜索链对「今天的新闻」召回很差：中文日期查询
 * 「今天 世界 重大新闻 11月3日」返回的是 2015 年招标公告、2024 年旧闻合集，
 * 真正当天的大事反而排不上。而新闻站 RSS 是**结构化、带 pubDate、每天滚动
 * 更新**的，一次抓取就有 10–20 条真实标题，解析只需要几十行正则。
 *
 * 所以管线是「RSS 为主、搜索为辅」：搜索只负责补 RSS 没覆盖到的角度，
 * 时效性由 RSS 的 pubDate 过滤保证。
 *
 * 两路都空（没装 web 服务 / 全部超时）时**不伪造**：素材为空，模型只能凭自身
 * 知识写，记录里 origin='model'、sources=0，前端据此在卡上标「未联网 · 模型
 * 知识」，让用户一眼看出这条消息的可信度与联网时不同。
 *
 * ## 数据契约
 *
 * 类型、常量、提示词与清洗函数全部来自 `src/shared/brief.ts`（两端共享契约）。
 * 本文件**不重复定义**任何卡片字段 —— 改字段请改 shared，不要在这里另起一份：
 * 两份字段名漂移会让前端读不到数据，而且不会有任何报错。
 *
 * ## 与 journal（期刊日记）的关系
 *
 * 实现风格刻意与 `src/host/personal/journal.ts` 对齐（模块级并发锁、剥围栏的
 * JSON 解析、模型路由回退链、中文错误短句、落盘失败不阻塞返回），但**不 import
 * 它**：journal 绑 botId 语境（一个 Bot 一本期刊），情报卡是全机一份，两者的目录、
 * 锁与调度判定都不该互相牵连。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BRIEF_DIR_NAME,
  BRIEF_FEEDS,
  BRIEF_FEED_ITEMS,
  BRIEF_MAX_QUERIES,
  BRIEF_SEARCH_TIMEOUT_MS,
  BRIEF_SOURCE_LIMIT,
  BRIEF_TIMEOUT_MS,
  briefDateKey,
  briefQueries,
  briefSourceIsRecent,
  briefSystemPrompt,
  buildBriefUserPrompt,
  parseBriefDate,
  parseBriefFeed,
  sanitizeBriefRecord,
  type BriefFeed,
  type BriefRecord,
  type BriefSourceItem,
  type BriefTodayResponse,
  type GenerateBriefRequest,
  type GenerateBriefResult,
} from '../../shared/brief.ts'
import { createUserMessage } from '../../vendor/dsh-llm/index.ts'
import { hostFeatureEnabled } from '../../features/store.ts'
import { rejectCrossSite } from '../../shared/csrf.ts'

/** 路由前缀（挂在对话完成胶囊同一条 /api/dsh-done-pill 下，前端不必记两个前缀）。 */
const ROUTE = '/api/dsh-done-pill/brief'

/** 单条搜索查询要回多少条结果（搜索只是兜底，不需要太多）。 */
const SEARCH_MAX_RESULTS = 8

/**
 * 单个 RSS 源抓取的超时（ms）。
 *
 * 比搜索的 20s 短：抓 RSS 就是一次 GET，源站 15 秒还不回基本可以判死；五个源
 * 并行，最坏情况也只是多等 15 秒，不该拖到总超时的 150 秒。
 */
const FEED_TIMEOUT_MS = 15_000

/**
 * 素材新鲜度窗口（天）。
 *
 * WSJ / NYT 的 feed 会混进几个月前的旧闻，不筛的话模型会把卡写成「旧闻回顾」。
 * 3 天是宽严折中：跨周末的新闻仍能覆盖，两个月前的肯定丢掉。
 */
const FEED_RECENT_DAYS = 3

/**
 * RSS 素材少于这个条数时才走搜索兜底。
 *
 * RSS 正常能抓到 20–40 条，够用就不烧搜索额度（也避开召回差的搜索链）；
 * 抓不到（离线 / 源站全挂）才让搜索补几条，至少别让模型完全瞎写。
 */
const SEARCH_FALLBACK_MIN = 6

/** POST body 上限：请求体只有几个可选字段，8KB 已经非常宽裕。 */
const MAX_BODY = 8 * 1024

/** 每日调度：每 30 分钟检查一次（失败重试窗口也是 30 分钟）。 */
const SCHEDULE_INTERVAL_MS = 30 * 60_000

/** 启动后 8 秒补跑一次：宿主重启 / 首次装插件时不必干等 30 分钟。 */
const SCHEDULE_FIRST_DELAY_MS = 8_000

/** 早于这个小时不生成：凌晨没人看卡，也避免与夜间备份/同步抢带宽。 */
const SCHEDULE_START_HOUR = 6

/** 距上次尝试至少隔这么久才重试（模块变量 lastAttemptAt 的时间差口径）。 */
const SCHEDULE_RETRY_GAP_MS = 30 * 60_000

/* ───────────────────────────── 并发锁与失败原因 ───────────────────────────── */

/**
 * 模块级生成锁。
 *
 * 手动「换一批」与每日调度共用这一把：没有它，用户在按钮上连点两下、或调度
 * tick 恰好与手动请求撞上，就会同时跑两次搜索 + 两次模型（白烧 token，后写的
 * 文件还会覆盖先写的）。
 */
let generating = false

/**
 * 最近一次生成失败的中文原因（成功时清空）。
 *
 * 为什么要留一份模块变量：前端在空态里要显示「上次为什么没出来」（比如模型
 * 未配置、超时），而 GET /brief/today 本身不触发生成，没有别的地方能拿到它。
 */
let lastError: string | undefined

/** 每日调度的上次尝试时间（成功失败都算），用于 30 分钟重试间隔。 */
let lastAttemptAt = 0

/** 宿主此刻是否正在生成简报（前端骨架 + 转圈用）。 */
export function isBriefGenerating(): boolean {
  return generating
}

/** 记下失败原因并返回结果。error 是给用户看的中文短句，不是堆栈。 */
function fail(message: string): GenerateBriefResult {
  lastError = message
  return { ok: false, error: message }
}

/** 把任意抛出物收敛成一行可读文本（日志用）。 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 200)}…` : message
}

/* ───────────────────────────── 存储路径 ───────────────────────────── */

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 简报目录（不建目录的纯计算版本；hasToday 这类只读判定不该有副作用）。 */
function briefRootDir(): string {
  return join(dshHome(), 'storages', 'dsh-seeker-bot', 'done-pill', BRIEF_DIR_NAME)
}

/** 简报目录（会 mkdir：写盘前必须存在）。 */
export function briefDir(): string {
  const dir = briefRootDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 某天的简报文件路径。
 *
 * `date` 已经在 normalizeBriefDate 里收敛成 `YYYY-MM-DD`，这里再兜一层字符集
 * 校验：文件名是唯一能从外部（HTTP body）影响路径的地方，防 `../` 穿越。
 */
function briefFilePath(date: string): string {
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : briefDateKey(new Date())
  return join(briefRootDir(), `${safe}.json`)
}

/* ───────────────────────────── 读写 ───────────────────────────── */

/**
 * 读某天的简报；文件缺失 / 损坏 / 字段全坏时返回 null。
 *
 * 回读也走 sanitizeBriefRecord：磁盘上的文件可能是旧版本写的、也可能被手滑改坏，
 * 一个坏字段不该让前端整块崩掉（与 journal 的回读口径一致）。meta 里的 model /
 * origin / sources 等由文件本身补回来，否则回读后会丢失「这份是不是联网写的」。
 */
function readBriefRecord(date: string): BriefRecord | null {
  const file = briefFilePath(date)
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null
    if (raw === null || typeof raw !== 'object') return null
    const queries = Array.isArray(raw.queries)
      ? raw.queries.filter((item): item is string => typeof item === 'string')
      : undefined
    return sanitizeBriefRecord(raw, {
      date,
      ...(typeof raw.model === 'string' && raw.model !== '' ? { model: raw.model } : {}),
      origin: raw.origin === 'web' ? 'web' : 'model',
      sources: typeof raw.sources === 'number' && Number.isFinite(raw.sources) ? raw.sources : 0,
      ...(typeof raw.elapsedMs === 'number' && Number.isFinite(raw.elapsedMs) ? { elapsedMs: raw.elapsedMs } : {}),
      ...(queries !== undefined && queries.length > 0 ? { queries } : {}),
      ...(typeof raw.generatedAt === 'number' && Number.isFinite(raw.generatedAt) ? { generatedAt: raw.generatedAt } : {}),
    })
  } catch {
    return null
  }
}

/**
 * 写一份简报（`<date>.json`）。
 *
 * 这里**不吞错**：写盘失败必须让调用方知道（否则界面显示「生成成功」、刷新后
 * 卡片消失）。调用方是 generateBrief，失败只留痕不阻塞返回。
 */
function writeBriefRecord(record: BriefRecord): void {
  const file = briefFilePath(record.date)
  mkdirSync(briefRootDir(), { recursive: true })
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
}

/** 今天（本地时区）的简报；还没生成时为 null。 */
export function readBriefToday(): BriefRecord | null {
  return readBriefRecord(briefDateKey(new Date()))
}

/** 某一天是否已经有简报文件（调度去重与前端 hasToday 的判定口径）。 */
export function hasBriefForDate(date: string): boolean {
  try {
    return existsSync(briefFilePath(date))
  } catch {
    return false
  }
}

/**
 * 最近 `days` 天的简报，新的在前。
 *
 * 按文件名（`YYYY-MM-DD` 字典序即时间序）倒序取前 N 个：没有生成的日子自然不
 * 占名额（不会出现「7 天里 5 天是空洞」的情况）。单个坏文件跳过而不是整体报错。
 */
export function readBriefList(days = 7): BriefRecord[] {
  const limit = Number.isFinite(days) ? Math.max(1, Math.min(90, Math.round(days))) : 7
  let names: string[]
  try {
    names = readdirSync(briefRootDir()).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
  } catch {
    return []
  }
  names.sort((a, b) => b.localeCompare(a))
  const records: BriefRecord[] = []
  for (const name of names.slice(0, limit)) {
    const record = readBriefRecord(name.slice(0, -'.json'.length))
    if (record !== null) records.push(record)
  }
  return records
}

/* ───────────────────────────── 模型路由 ───────────────────────────── */

interface ResolvedChatModel {
  provider: string
  model: string
  effort?: string
}

function getLlm(ctx: Record<string, any>): any {
  try {
    return ctx.get?.('llm') ?? ctx.llm
  } catch {
    return undefined
  }
}

function getWeb(ctx: Record<string, any>): any {
  try {
    return ctx.get?.('web') ?? ctx.web
  } catch {
    return undefined
  }
}

/**
 * 选一个可用的聊天模型。
 *
 * 顺序（与契约一致）：
 *   1. 前端指定的 `request.model`（provider + model 都有才采信）；
 *   2. 宿主的默认模型 `ctx.get('agentDefaultModel').currentSelection()`；
 *   3. 注册表里的第一个 provider 的第一个 model（保证「至少有个模型能跑」）。
 *
 * 都拿不到返回 null，调用方给出「未配置可用的聊天模型」——**不能**静默降级成
 * 模板文案，那会让「模型不可用」伪装成「生成成功」。
 */
async function resolveChatModel(
  ctx: Record<string, any>,
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

/* ───────────────────────────── 素材采集 ───────────────────────────── */

/**
 * 把「整轮生成」的总超时与「单次抓取 / 单条查询」的超时合成一个信号。
 *
 * AbortSignal.any 是 Node 20+ 的能力；老运行时退回只用总超时信号（宁可慢一点，
 * 也不能因为少一个 API 就把整轮生成搞崩）。
 */
function mergeSignals(signal: AbortSignal, timeout: AbortSignal): AbortSignal {
  const combine = (AbortSignal as any).any
  return typeof combine === 'function' ? combine([signal, timeout]) : signal
}

/**
 * 抓一个 RSS 源并解析成素材。
 *
 * 单源自带 15s 超时（与总超时信号合并）：一个源站卡住（反爬返回半截响应 /
 * DNS 黑洞）不该让整轮生成陪着等满 150 秒——少一个源的素材，总比一张卡都
 * 出不来好。
 *
 * 正文不论 body.kind 是 text 还是 html 都直接当字符串交给解析层：RSS 的
 * Content-Type 五花八门（text/xml、application/rss+xml、甚至 text/html），
 * 宿主 seam 归一后可能落到任一支，按 kind 分流只会白丢素材。
 */
async function fetchOneFeed(web: any, feed: BriefFeed, signal: AbortSignal): Promise<BriefSourceItem[]> {
  const merged = mergeSignals(signal, AbortSignal.timeout(FEED_TIMEOUT_MS))
  const result = await web.fetch({ url: feed.url }, merged)
  const body = result?.body
  const content = typeof body?.content === 'string' ? body.content : ''
  if (content === '') return []
  return parseBriefFeed(content, feed, BRIEF_FEED_ITEMS)
}

/**
 * 并行抓全部 RSS 源，过滤旧闻、按 URL 去重。
 *
 * 失败语义：单个源失败 / 超时 / 返回验证页**只记日志不中断**（Promise.allSettled，
 * parseBriefFeed 本身也绝不抛）。全部失败等价于「没有 RSS 素材」，调用方会走
 * 搜索兜底或标 origin='model'，而不是报错。
 */
async function fetchFeedSources(ctx: Record<string, any>, signal: AbortSignal): Promise<BriefSourceItem[]> {
  const web = getWeb(ctx)
  if (web === undefined || web === null || typeof web.fetch !== 'function') {
    ctx.logger?.warn?.('[dsh-seeker-bot] brief：宿主没有可用的 web fetch 服务，跳过 RSS 抓取')
    return []
  }
  const settled = await Promise.allSettled(BRIEF_FEEDS.map((feed) => fetchOneFeed(web, feed, signal)))
  const seen = new Set<string>()
  const sources: BriefSourceItem[] = []
  settled.forEach((result, index) => {
    const feed = BRIEF_FEEDS[index]
    if (result.status === 'rejected') {
      ctx.logger?.warn?.(`[dsh-seeker-bot] brief 抓取 ${feed?.label ?? feed?.id ?? ''} 失败：${describeError(result.reason)}`)
      return
    }
    for (const item of result.value) {
      if (sources.length >= BRIEF_SOURCE_LIMIT) break
      // 旧闻直接丢：不筛的话模型会把几个月前的事写成「今天发生」
      if (!briefSourceIsRecent(item, FEED_RECENT_DAYS)) continue
      if (seen.has(item.url)) continue
      seen.add(item.url)
      sources.push(item)
    }
  })
  return sources
}

/**
 * 搜索兜底时按查询下标分栏。
 *
 * 搜索结果的 lane 不好判断（同一条结果可能既算 AI 也算世界），按查询下标分是
 * 这里能给出的最稳口径——查询本身就是按栏目写的（briefQueries 的顺序是
 * AI、AI、世界、国内）。
 */
function laneOfQuery(index: number): 'ai' | 'world' | 'china' {
  if (index <= 1) return 'ai'
  return index === 2 ? 'world' : 'china'
}

/**
 * 单条搜索查询：自带 20s 超时，结果映射成统一素材形状。
 *
 * 搜索只是兜底通道，这里不追求质量，只保证「形状对、能进提示词」。
 */
async function searchOne(web: any, query: string, index: number, signal: AbortSignal): Promise<BriefSourceItem[]> {
  const merged = mergeSignals(signal, AbortSignal.timeout(BRIEF_SEARCH_TIMEOUT_MS))
  const result = await web.search({ query, maxResults: SEARCH_MAX_RESULTS }, merged)
  const list = Array.isArray(result?.sources) ? result.sources : []
  const lane = laneOfQuery(index)
  const sources: BriefSourceItem[] = []
  for (const item of list) {
    const url = typeof item?.url === 'string' ? item.url.trim() : ''
    if (url === '') continue
    const title = typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : url
    const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
    const snippet = typeof item.snippet === 'string' ? item.snippet.trim() : ''
    const body = summary !== '' ? summary : snippet
    const publishedAt = typeof item.publishedAt === 'string' ? item.publishedAt.trim() : ''
    sources.push({
      title,
      url,
      ...(body !== '' ? { snippet: body } : {}),
      ...(publishedAt !== '' ? { publishedAt } : {}),
      lane,
    })
  }
  return sources
}

/**
 * 并行跑搜索兜底；失败 / 超时只记日志不中断。
 *
 * @param customQueries 调用方指定的查询（「换个角度」与测试用）；没给就用
 *   briefQueries 的默认四条。
 * @returns sources 与本次**真正发出**的查询（记录进 BriefRecord.queries 排障用）。
 */
async function searchFallbackSources(
  ctx: Record<string, any>,
  date: Date,
  signal: AbortSignal,
  customQueries?: string[],
): Promise<{ sources: BriefSourceItem[]; queries: string[] }> {
  const queries = customQueries !== undefined && customQueries.length > 0
    ? customQueries.slice(0, BRIEF_MAX_QUERIES)
    : briefQueries(date).slice(0, BRIEF_MAX_QUERIES)
  const web = getWeb(ctx)
  if (web === undefined || web === null || typeof web.search !== 'function') {
    ctx.logger?.warn?.('[dsh-seeker-bot] brief：宿主没有可用的 web 搜索服务，搜索兜底跳过')
    return { sources: [], queries }
  }
  const settled = await Promise.allSettled(queries.map((query, index) => searchOne(web, query, index, signal)))
  const seen = new Set<string>()
  const sources: BriefSourceItem[] = []
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      ctx.logger?.warn?.(`[dsh-seeker-bot] brief 搜索失败（${queries[index] ?? ''}）：${describeError(result.reason)}`)
      return
    }
    for (const item of result.value) {
      if (sources.length >= BRIEF_SOURCE_LIMIT) break
      if (seen.has(item.url)) continue
      seen.add(item.url)
      sources.push(item)
    }
  })
  return { sources, queries }
}

/**
 * 采集一份简报的素材：RSS 主通道 → 不够再用搜索补 → 合并去重截上限。
 *
 * 返回的 queries 只用于排障记录：没触发搜索兜底时是空数组（别在记录里塞没真跑
 * 过的查询，那会让「为什么这条素材没进卡」的排查跑偏）。
 *
 * 素材为空不是错误：调用方据此把 origin 记成 'model'（前端标「未联网」），
 * 模型仍会凭自身知识写——这是产品要的降级，不是失败。
 */
async function collectBriefSources(
  ctx: Record<string, any>,
  date: Date,
  signal: AbortSignal,
  customQueries?: string[],
): Promise<{ sources: BriefSourceItem[]; queries: string[] }> {
  const feedSources = await fetchFeedSources(ctx, signal)
  let searchSources: BriefSourceItem[] = []
  let queries: string[] = []
  if (feedSources.length < SEARCH_FALLBACK_MIN) {
    const fallback = await searchFallbackSources(ctx, date, signal, customQueries)
    searchSources = fallback.sources
    queries = fallback.queries
  }
  const seen = new Set<string>()
  const merged: BriefSourceItem[] = []
  for (const item of [...feedSources, ...searchSources]) {
    if (merged.length >= BRIEF_SOURCE_LIMIT) break
    if (seen.has(item.url)) continue
    seen.add(item.url)
    merged.push(item)
  }
  return { sources: merged, queries }
}

/* ───────────────────────────── 归一化 ───────────────────────────── */

/** 校验 / 归一化日期：非法或缺省时退回今天（本地时区）。 */
function normalizeBriefDate(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T12:00:00`)
    if (!Number.isNaN(parsed.getTime())) return text
  }
  return briefDateKey(new Date())
}

/**
 * 归一化调用方指定的搜索查询。
 *
 * 返回 undefined 表示「没指定」——这时才用 briefQueries 的默认兜底查询。
 * 不要在这里直接填默认值：搜索兜底只在 RSS 素材不足时才跑，没跑搜索却把
 * 默认查询记进 BriefRecord.queries，会让排障信息说谎。
 */
function normalizeBriefQueries(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const list = raw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '')
    .map((item) => item.slice(0, 200))
  return list.length > 0 ? list.slice(0, BRIEF_MAX_QUERIES) : undefined
}

/* ───────────────────────────── JSON 解析 ───────────────────────────── */

/**
 * 把模型输出解析成 JSON 对象。
 *
 * 模型经常在 JSON 外面包一层解释或 markdown 围栏，所以：trim → 剥三反引号 json
 * 围栏 → 取第一个 `{` 到最后一个 `}` → JSON.parse。失败抛**可读中文错误**（调用方会
 * 把它变成 error 字段），不要抛裸 SyntaxError——那在界面上是一串英文堆栈。
 */
export function parseBriefJson(raw: string): Record<string, unknown> {
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

/**
 * 生成一份每日简报并落盘。
 *
 * 失败路径全部返回 `{ ok:false, error }`（不抛）：路由层据此回 200 + error 字段，
 * 前端据此在空态里显示中文原因。**绝不**在这里降级成模板文案——那会让用户以为
 * 模型真的写了一期，实际拿到的是空话。
 *
 * @param request.force true = 当天已有简报也重新生成（手动「换一批」）；
 *   缺省 false 时若当天已有则直接复用，避免重复点击白烧 token。
 */
export async function generateBrief(
  ctx: Record<string, any>,
  request: GenerateBriefRequest = {},
): Promise<GenerateBriefResult> {
  if (generating) return { ok: false, error: '正在生成中，请稍候' }

  const date = normalizeBriefDate(request.date)
  if (request.force !== true) {
    const existing = readBriefRecord(date)
    if (existing !== null) return { ok: true, brief: existing }
  }

  const customQueries = normalizeBriefQueries(request.queries)

  const llm = getLlm(ctx)
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    return fail('宿主未提供 llm 服务')
  }
  const route = await resolveChatModel(ctx, request.model)
  if (route === null) return fail('未配置可用的聊天模型')

  generating = true
  const startedAt = Date.now()
  const controller = new AbortController()
  // 总超时：抓取 / 搜索 + 模型共用一个信号（模型侧慢到 150s 时用户早以为卡死了）
  const timer = setTimeout(() => controller.abort(), BRIEF_TIMEOUT_MS)
  try {
    // 先采集素材（RSS 主 + 搜索兜底）再问模型：素材为空也继续
    // （origin 会记成 model，前端标注「未联网」）
    const collected = await collectBriefSources(ctx, parseBriefDate(date), controller.signal, customQueries)
    const sources = collected.sources
    const origin: 'web' | 'model' = sources.length > 0 ? 'web' : 'model'

    let raw = ''
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: buildBriefUserPrompt(sources, date) }],
        // 消息归属写当前实际装载的 bundle id：用量与会话日志按 bundle 聚合
        source: { kind: 'plugin:dsh-seeker-bot', plugin: 'dsh-seeker-bot' },
      })],
      system: briefSystemPrompt(),
      maxTokens: 4000,
      temperature: 0.7,
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
    }
    if (raw.trim() === '') return fail('模型没有返回内容')

    const payload = parseBriefJson(raw)
    const generatedAt = Date.now()
    const record = sanitizeBriefRecord(payload, {
      date,
      model: `${route.provider}/${route.model}`,
      origin,
      sources: sources.length,
      elapsedMs: generatedAt - startedAt,
      queries: collected.queries,
      generatedAt,
    })
    if (record === null) return fail('模型返回的卡片内容为空')

    try {
      writeBriefRecord(record)
    } catch (error) {
      // 落盘失败只留痕：卡片已经生成出来了，至少这一轮该返回给前端
      ctx.logger?.warn?.(`[dsh-seeker-bot] brief 落盘失败：${describeError(error)}`)
    }
    lastError = undefined
    return { ok: true, brief: record }
  } catch (error: any) {
    const aborted = controller.signal.aborted
    // 超时与模型侧报错都收敛成「中文短句 + 原因」：界面直接显示这一句
    const message = aborted
      ? `生成超时（${String(Math.round(BRIEF_TIMEOUT_MS / 1000))} 秒）`
      : `生成失败：${String(error?.message ?? error)}`
    return fail(message.slice(0, 300))
  } finally {
    clearTimeout(timer)
    generating = false
  }
}

/* ───────────────────────────── 每日调度 ───────────────────────────── */

/** `checkBriefSchedule` 的结果。reason 是给日志 / 排障看的中文短句。 */
export interface BriefCheckResult {
  ok: boolean
  reason: string
}

/**
 * 检查今天该不该生成简报（满足时生成）。
 *
 * 判定顺序（**先便宜后昂贵**）：当前小时 ≥ 6 → 当天是否已有文件 → 距上次尝试是否
 * 满 30 分钟。前三步只读一个小目录 + 纯计算，窗口外每 30 分钟的 tick 几乎零成本；
 * 只有全部通过才会真的联网 + 调模型。
 *
 * @param now 判定用的当前时间（测试可注入）。
 */
export async function checkBriefSchedule(
  ctx: Record<string, any>,
  now: Date | number = new Date(),
): Promise<BriefCheckResult> {
  const at = now instanceof Date ? now : new Date(now)
  const hour = at.getHours()
  if (hour < SCHEDULE_START_HOUR) {
    return { ok: false, reason: `还没到 ${String(SCHEDULE_START_HOUR)} 点` }
  }
  const date = briefDateKey(at)
  if (hasBriefForDate(date)) return { ok: false, reason: `${date} 的简报已生成` }
  if (at.getTime() - lastAttemptAt < SCHEDULE_RETRY_GAP_MS) {
    return { ok: false, reason: '距上次尝试不足 30 分钟' }
  }
  lastAttemptAt = at.getTime()

  const result = await generateBrief(ctx, { date, force: false })
  if (result.ok) {
    const reason = `已生成 ${date} 的简报`
    ctx.logger?.info?.(`[dsh-seeker-bot] ${reason}`)
    return { ok: true, reason }
  }
  const error = result.error ?? '未知原因'
  ctx.logger?.warn?.(`[dsh-seeker-bot] brief 生成失败：${error}`)
  return { ok: false, reason: error }
}

/* ───────────────────────────── HTTP 工具 ───────────────────────────── */

function sendJson(res: any, status: number, payload: Record<string, unknown>): void {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  } catch {
    /* 客户端已断开 */
  }
}

/**
 * 读 POST body（≤ MAX_BODY）。
 *
 * 超限 / 坏 JSON / 读流出错一律解析成 `{}`：请求体字段全可选，空对象就是
 * 「用全部缺省值」，没必要为坏请求专门造一种错误（与 personal/index.ts 同款）。
 */
function readJsonBody(req: any): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolvePromise({})
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
        resolvePromise(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {})
      } catch {
        resolvePromise({})
      }
    })
    req.on('error', () => resolvePromise({}))
  })
}

/* ───────────────────────────── 挂载 ───────────────────────────── */

/**
 * 挂载每日情报卡的宿主半身（三条路由 + 每日调度）。
 *
 * 功能开关 `view.daily-brief` 关掉时**第一行就返回**：不挂路由、不起定时器，
 * 自然也不会烧 token 或产生文件（这是「组件行一关，后台能力就停」的口径）。
 *
 * 路由挂在 `/api/dsh-done-pill/brief/*` 下（与对话完成胶囊同一前缀），每条路由
 * 各用一个 effect 管生命周期：一条同路径冲突不该拖垮另外两条。
 */
export function applyBriefHost(ctx: Record<string, any>): void {
  if (!hostFeatureEnabled('view.daily-brief')) return

  ctx.inject(['webServer'], (webCtx: Record<string, any>) => {
    const register = (path: string, label: string, handler: (req: any, res: any) => void): void => {
      webCtx.effect(() => {
        try {
          return webCtx.webServer.register({ kind: 'exact', path, handler })
        } catch (error) {
          // 路由可能已被同路径的其他插件注册：记警告并继续，不拖垮整个插件加载
          ctx.logger?.warn?.(`[dsh-seeker-bot] brief route ${path} 注册失败：${describeError(error)}`)
          return undefined
        }
      }, `dsh-seeker-bot: ${label}`)
    }

    /* GET /brief/today：前端轮询用。brief 为 null 时前端显示「整理中 / 点此生成」。 */
    register(`${ROUTE}/today`, 'brief today route', (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const today = briefDateKey(new Date())
      const brief = readBriefRecord(today)
      const payload: BriefTodayResponse = {
        ok: true,
        brief,
        generating,
        ...(lastError === undefined ? {} : { error: lastError }),
        // hasToday 按「文件是否存在」判定：回读可能因坏文件返回 null，
        // 但「今天生成过」这件事本身对调度去重和前端提示都还有意义。
        hasToday: hasBriefForDate(today),
      }
      sendJson(res, 200, payload as unknown as Record<string, unknown>)
    })

    /* POST /brief/generate：手动生成 / 换一批。即使失败也回 200，原因放 error。 */
    register(`${ROUTE}/generate`, 'brief generate route', (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // 写路由必须自己补跨站闸门：插件前缀比官方 /api 长，官方那道校验不会执行
      if (rejectCrossSite(req?.headers, (status, payload) => sendJson(res, status, payload))) return
      void (async () => {
        const body = await readJsonBody(req)
        const result = await generateBrief(ctx, body as GenerateBriefRequest)
        // ok:false 也回 200：错误走 error 字段（与 journal 路由一致），前端按 ok 分支
        sendJson(res, 200, result as unknown as Record<string, unknown>)
      })()
    })

    /* GET /brief/list?days=7：历史简报（新的在前），给「往期」视图用。 */
    register(`${ROUTE}/list`, 'brief list route', (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let days = 7
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const raw = url.searchParams.get('days')
        if (raw !== null && /^\d+$/.test(raw)) days = Number(raw)
      } catch {
        /* URL 解析失败：按默认 7 天 */
      }
      sendJson(res, 200, { ok: true, briefs: readBriefList(days) })
    })
  })

  /*
   * 每日调度定时器。
   *
   * 用 30 分钟 tick 而不是「定一个每天 06:00 的闹钟」：宿主可能整夜没开、也可能
   * 凌晨重启，定点闹钟一旦错过就再也不会触发；而 tick 在 6 点后的任意一次都会
   * 补上（当天没有文件就生成）。失败也由 30 分钟的重试间隔自然退避。
   *
   * 两个定时器都要 unref()：默认会把 Node 事件循环钉住，单元测试 / 一次性脚本
   * 会永远退不出去（实测表现为脚本跑完不结束）。
   */
  try {
    ctx?.effect?.(() => {
      const tick = (): void => {
        void checkBriefSchedule(ctx).catch(() => undefined)
      }
      const timer = setInterval(tick, SCHEDULE_INTERVAL_MS)
      timer.unref?.()
      // 启动 8 秒后补跑一次：宿主重启 / 首次装插件时不必干等 30 分钟
      const initial = setTimeout(tick, SCHEDULE_FIRST_DELAY_MS)
      initial.unref?.()
      return () => {
        clearInterval(timer)
        clearTimeout(initial)
      }
    }, 'dsh-seeker-bot: brief daily schedule')
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-seeker-bot] brief 调度器启动失败：${describeError(error)}`)
  }

  ctx.logger?.info?.(`[dsh-seeker-bot] brief mounted: ${ROUTE}/today + /generate + /list`)
}

/* ───────────────────────────── 测试面 ───────────────────────────── */

/** 测试面：只给 scripts/ 里的冒烟用，不是公共 API。 */
export const __briefTest = {
  normalizeBriefDate,
  normalizeBriefQueries,
  briefFilePath,
  briefRootDir,
  readBriefRecord,
  resolveChatModel,
  fetchFeedSources,
  searchFallbackSources,
  collectBriefSources,
  laneOfQuery,
}
