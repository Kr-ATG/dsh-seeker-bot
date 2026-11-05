/**
 * dsh-seeker-bot — 节日卡（Festival Card）的**宿主半身**。
 *
 * ## 这是什么
 *
 * 对话完成胶囊上方、每日情报卡旁边的第二类「斜插卡」：按二十四节气与固定公历
 * 节日触发，提前几天出现一张「这个节气吃什么、做什么、有什么讲究」的生活
 * 卡片，配一张从网上检索来的实拍图。
 *
 * ## 为什么整条链路必须在宿主
 *
 * 1. **页面关掉也要跑**：用户第二天早上打开 DSH 就该看到当天的卡，而不是「打开
 *    页面才开始联网」。定时器必须活在常驻进程里（浏览器定时器一关标签页就停）。
 * 2. **浏览器侧拿不到图片搜索**：百度图片接口带反爬与 CORS 限制，前端直接 fetch
 *    会被拦；而且图片要落盘缓存，刷新不该重新下载。
 * 3. **token 只烧一次**：模型生成的文案与检索到的图片都落盘，刷新、换标签页、
 *    清缓存都读同一份文件。
 *
 * ## 链路（模型为主、资料卡兜底，绝不伪造、绝不空手）
 *
 *   ① upcomingFestivals(目标日, FESTIVAL_WINDOW_DAYS) 取窗口内最近一个节气 / 节日（没有则报中文错误）
 *   ② 已有记录且 force != true → 直接复用（不烧 token、不重复下载图片）
 *   ③ 有模型：buildFestivalUserPrompt（资料为准）→ ctx.llm.stream → parseFestivalJson
 *      → sanitizeFestivalRecord；模型不可用 / 输出坏 JSON / 内容为空时**不失败**，
 *      改用 festivalFallbackCard 生成 origin='fallback' 的资料卡
 *   ④ 无论模型还是资料卡，都继续走图片检索：festivalImageQueries(entry, modelQueries)
 *      → 百度图片 JSON 接口 → 筛选 / 下载 / 解码校验 → 落盘
 *        <DSH_HOME>/storages/dsh-seeker-bot/done-pill/festivals/images/<festivalDate>.<ext>
 *   ⑤ 记录落盘 <DSH_HOME>/storages/dsh-seeker-bot/done-pill/festivals/<festivalDate>.json
 *
 * ## 为什么「模型坏了也要出卡」
 *
 * 节日卡的价值一半在「今天是什么日子」这个确定性信息，一半在文案。模型没配好
 * 或返回坏 JSON 时，如果整张卡失败，用户连「立冬是哪天、该吃什么」都看不到。
 * 所以兜底卡用内置资料拼一张能读的卡，记录里 origin='fallback'，前端据此标
 * 「资料卡」——用户一眼能看出文案是资料拼的、不是模型写的。**这不是假成功**。
 *
 * ## 图片抓取失败只让 image=null
 *
 * 图片是最容易失败的一环（百度接口反爬 / 源站 404 / 图片太小 / 格式不支持）。
 * 图片失败只影响卡面配图，前端会用节气大字占位；记录生成与 ok:true 不受影响。
 *
 * ## 数据契约
 *
 * 类型、常量、日期计算、提示词、清洗与兜底卡全部来自 src/shared/festival.ts
 * （两端共享契约）。本文件**不重复定义**任何卡片字段 —— 改字段请改 shared，
 * 不要在这里另起一份：两份字段名漂移会让前端读不到数据，而且不会有任何报错。
 *
 * ## 与 brief（每日情报卡）的关系
 *
 * 实现风格刻意与 src/host/done-pill/brief.ts 对齐（模块级并发锁、剥围栏的
 * JSON 解析、模型路由回退链、中文错误短句、落盘失败不阻塞返回、定时器 unref），
 * 但两者数据互不相干：情报卡是每天一份的新闻日报，节日卡是一个节气一份的
 * 生活卡片，目录、锁与调度判定各自独立。
 */

import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import {
  FESTIVAL_DIR_NAME,
  FESTIVAL_IMAGE_DIR,
  FESTIVAL_IMAGE_DOWNLOAD_TIMEOUT_MS,
  FESTIVAL_IMAGE_GEN_TIMEOUT_MS,
  FESTIVAL_IMAGE_MAX_BYTES,
  FESTIVAL_IMAGE_ROUTE,
  FESTIVAL_IMAGE_SEARCH_TIMEOUT_MS,
  FESTIVAL_ROUTE,
  FESTIVAL_TIMEOUT_MS,
  FESTIVAL_WINDOW_DAYS,
  buildFestivalUserPrompt,
  festivalDateKey,
  festivalDateShort,
  festivalFallbackCard,
  festivalImagePrompt,
  festivalImageQueries,
  festivalNextOf,
  festivalSystemPrompt,
  parseFestivalDate,
  sanitizeFestivalRecord,
  upcomingFestivals,
  type FestivalCard,
  type FestivalEntry,
  type FestivalImage,
  type FestivalRecord,
  type FestivalTodayResponse,
  type GenerateFestivalRequest,
  type GenerateFestivalResult,
} from '../../shared/festival.ts'
import { createUserMessage } from '../../vendor/dsh-llm/index.ts'
import { hostFeatureEnabled } from '../../features/store.ts'
import { rejectCrossSite } from '../../shared/csrf.ts'

/** 路由前缀（挂在对话完成胶囊同一条 /api/dsh-done-pill 下，前端不必记两个前缀）。 */
const ROUTE = FESTIVAL_ROUTE

/** 单张卡片配图的最小字节数：低于这个数基本是缩略图或占位图。 */
const IMAGE_MIN_BYTES = 150 * 1024

/** 图片「像卡片配图」的最小像素（宽 × 高）：再小放大就糊。 */
const IMAGE_MIN_WIDTH = 900
const IMAGE_MIN_HEIGHT = 600

/** 允许的宽高比区间：优先横图 / 方图（竖图放进左栏会被裁得只剩一条）。 */
const IMAGE_MIN_RATIO = 0.75
const IMAGE_MAX_RATIO = 1.7

/** 每组查询最多下载几个候选（前几个不合格就换下一组，避免无限试）。 */
const IMAGE_CANDIDATES_PER_QUERY = 8

/** 百度图片搜索接口（JSON 版，不需要解析 HTML）。 */
const BAIDU_IMAGE_API = 'https://image.baidu.com/search/acjson'

/** 候选标题里出现这些词就不是「实拍生活图」：简笔画 / 素材 / 海报一律不要。 */
const IMAGE_TITLE_BLOCKLIST = /简笔画|插画|卡通|动漫|壁纸|素材|模板|海报|图标|表情|免抠|二维码|教程|做法|步骤|图解|广告/

/** 来源站点黑名单（导购 / 点评站的图往往是摆拍或带水印）。 */
const IMAGE_HOST_BLOCKLIST = /smzdm\.com|dianping\.com|meituan\.com/

/** 常见来源域名的展示名（source 字段给用户看，不直接糊一串 www 域名）。 */
const SOURCE_DISPLAY_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['xiaohongshu.com', '小红书'],
  ['douyin.com', '抖音'],
  ['zhihu.com', '知乎'],
  ['weibo.com', '微博'],
  ['sohu.com', '搜狐'],
  ['sina.com.cn', '新浪'],
  ['sina.cn', '新浪'],
  ['163.com', '网易'],
  ['qq.com', '腾讯网'],
  ['toutiao.com', '今日头条'],
  ['bilibili.com', '哔哩哔哩'],
  ['baidu.com', '百度'],
  ['xinhuanet.com', '新华网'],
  ['people.com.cn', '人民网'],
  ['ifeng.com', '凤凰网'],
  ['thepaper.cn', '澎湃新闻'],
  ['jiemian.com', '界面新闻'],
  ['pconline.com.cn', '太平洋摄影'],
  ['mafengwo.cn', '马蜂窝'],
  ['ctrip.com', '携程'],
]

/** POST body 上限：请求体只有 date / force 两个字段，8KB 已经非常宽裕。 */
const MAX_BODY = 8 * 1024

/** 节日调度：每 30 分钟检查一次（失败重试窗口也是 30 分钟）。 */
const SCHEDULE_INTERVAL_MS = 30 * 60_000

/** 启动后 8 秒补跑一次：宿主重启 / 首次装插件时不必干等 30 分钟。 */
const SCHEDULE_FIRST_DELAY_MS = 8_000

/** 早于这个小时不生成：凌晨没人看卡，也避免与夜间备份/同步抢带宽。 */
const SCHEDULE_START_HOUR = 6

/** 距上次尝试至少隔这么久才重试（模块变量 lastAttemptAt 的时间差口径）。 */
const SCHEDULE_RETRY_GAP_MS = 30 * 60_000

/** 记录保留天数：调度 tick 时清理更早的 json 与图片（防止目录无限增长）。 */
const RETENTION_DAYS = 90

/* ───────────────────────────── 并发锁与失败原因 ───────────────────────────── */

/**
 * 模块级生成锁。
 *
 * 手动「换一张」与 30 分钟调度共用这一把：没有它，用户在按钮上连点两下、或
 * 调度 tick 恰好与手动请求撞上，就会同时跑两次模型 + 两次图片检索（白烧
 * token，后写的文件还会覆盖先写的）。
 */
let generating = false

/**
 * 最近一次生成失败的中文原因（成功时清空）。
 *
 * 前端在空态里要显示「上次为什么没出来」（比如窗口内没有节日），而
 * GET /today 本身不触发生成，没有别的地方能拿到它。
 */
let lastError: string | undefined

/** 节日调度的上次尝试时间（成功失败都算），用于 30 分钟重试间隔。 */
let lastAttemptAt = 0

/** 宿主此刻是否正在生成节日卡（前端骨架 + 转圈用）。 */
export function isFestivalGenerating(): boolean {
  return generating
}

/** 记下失败原因并返回结果。error 是给用户看的中文短句，不是堆栈。 */
function fail(message: string): GenerateFestivalResult {
  lastError = message
  return { ok: false, error: message }
}

/** 把任意抛出物收敛成一行可读文本（日志用）。 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 200 ? message.slice(0, 200) + '…' : message
}

/* ───────────────────────────── 存储路径 ───────────────────────────── */

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 节日卡目录（不建目录的纯计算版本；hasToday 这类只读判定不该有副作用）。 */
function festivalRootDir(): string {
  return join(dshHome(), 'storages', 'dsh-seeker-bot', 'done-pill', FESTIVAL_DIR_NAME)
}

/** 图片目录（不建目录的纯计算版本）。 */
function festivalImageDir(): string {
  return join(festivalRootDir(), FESTIVAL_IMAGE_DIR)
}

/**
 * 某个节日的记录文件路径（按 **festivalDate** 命名，不是生成日期）。
 *
 * 同一个节日从出现到结束始终读同一份记录：提前几天生成，节日当天看到的还是
 * 那份卡（文案与图片不会因为刷新而变）。date 已在 normalizeFestivalDate 里
 * 收敛成 YYYY-MM-DD，这里再兜一层字符集校验，防 ../ 穿越。
 */
function festivalFilePath(festivalDate: string): string {
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(festivalDate) ? festivalDate : festivalDateKey(new Date())
  return join(festivalRootDir(), safe + '.json')
}

/* ───────────────────────────── 读写 ───────────────────────────── */

/** 反序列化一张卡片；坏字段跳过（磁盘文件可能是旧版本写的 / 被手滑改坏）。 */
function normalizeStoredCard(raw: unknown): FestivalCard | null {
  if (raw === null || typeof raw !== 'object') return null
  const card = raw as Record<string, unknown>
  const title = typeof card.title === 'string' ? card.title.trim() : ''
  if (title === '') return null
  const facts: Array<{ label: string; value: string }> = []
  if (Array.isArray(card.facts)) {
    for (const item of card.facts) {
      if (item === null || typeof item !== 'object') continue
      const fact = item as Record<string, unknown>
      const label = typeof fact.label === 'string' ? fact.label.trim() : ''
      const value = typeof fact.value === 'string' ? fact.value.trim() : ''
      if (label !== '' && value !== '') facts.push({ label, value })
      if (facts.length >= 3) break
    }
  }
  return {
    id: typeof card.id === 'string' && card.id !== '' ? card.id : '',
    festivalId: typeof card.festivalId === 'string' ? card.festivalId : '',
    festivalDate: typeof card.festivalDate === 'string' ? card.festivalDate : '',
    name: typeof card.name === 'string' ? card.name : '',
    kind: card.kind === 'festival' ? 'festival' : 'solar-term',
    title,
    lede: typeof card.lede === 'string' ? card.lede : '',
    facts,
    image: normalizeStoredImage(card.image),
  }
}

/** 反序列化配图；形状不对就当没有图（前端用大字占位）。 */
function normalizeStoredImage(raw: unknown): FestivalImage | null {
  if (raw === null || typeof raw !== 'object') return null
  const image = raw as Record<string, unknown>
  const url = typeof image.url === 'string' ? image.url.trim() : ''
  if (url === '') return null
  const out: FestivalImage = { url }
  if (typeof image.file === 'string' && image.file !== '') out.file = image.file
  if (typeof image.caption === 'string' && image.caption !== '') out.caption = image.caption
  if (typeof image.source === 'string' && image.source !== '') out.source = image.source
  if (typeof image.sourceUrl === 'string' && image.sourceUrl !== '' && isHttpUrl(image.sourceUrl)) out.sourceUrl = image.sourceUrl
  if (typeof image.width === 'number' && Number.isFinite(image.width) && image.width > 0) out.width = image.width
  if (typeof image.height === 'number' && Number.isFinite(image.height) && image.height > 0) out.height = image.height
  return out
}

/**
 * 读某个节日的记录；文件缺失 / 损坏 / 没有任何可读卡片时返回 null。
 *
 * 不用 sanitizeFestivalRecord 回读：它会把 image 强制清成 null（那是给模型输出
 * 清洗用的），会把已经落盘的配图丢掉。这里做轻量形状校验即可。
 */
export function readFestivalRecord(festivalDate: string): FestivalRecord | null {
  const file = festivalFilePath(festivalDate)
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null
    if (raw === null || typeof raw !== 'object') return null
    const cards: FestivalCard[] = []
    if (Array.isArray(raw.cards)) {
      for (const item of raw.cards) {
        const card = normalizeStoredCard(item)
        if (card !== null) cards.push(card)
        if (cards.length >= 2) break
      }
    }
    if (cards.length === 0) return null
    const generatedAt = typeof raw.generatedAt === 'number' && Number.isFinite(raw.generatedAt) ? raw.generatedAt : 0
    const recordDate = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : ''
    const fallbackDate = recordDate !== '' ? recordDate : festivalDateKey(new Date())
    return {
      date: fallbackDate,
      dateLabel: typeof raw.dateLabel === 'string' && raw.dateLabel !== '' ? raw.dateLabel : festivalDateShort(fallbackDate),
      festivalDate,
      generatedAt,
      cards,
      ...(typeof raw.model === 'string' && raw.model !== '' ? { model: raw.model } : {}),
      ...(typeof raw.elapsedMs === 'number' && Number.isFinite(raw.elapsedMs) ? { elapsedMs: raw.elapsedMs } : {}),
      origin: raw.origin === 'fallback' ? 'fallback' : 'model',
    }
  } catch {
    return null
  }
}

/**
 * 写一份节日记录（<festivalDate>.json）。
 *
 * 这里**不吞错**：写盘失败必须让调用方知道（否则界面显示「生成成功」、刷新后
 * 卡片消失）。调用方是 generateFestival，失败只留痕不阻塞返回。
 */
function writeFestivalRecord(record: FestivalRecord): void {
  const file = festivalFilePath(record.festivalDate)
  mkdirSync(festivalRootDir(), { recursive: true })
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
}

/** 某个节日是否已经有记录文件（调度去重与前端 hasToday 的判定口径）。 */
export function hasFestivalFor(festivalDate: string): boolean {
  try {
    return existsSync(festivalFilePath(festivalDate))
  } catch {
    return false
  }
}

/**
 * 最近 days 天内生成的节日记录，新的在前。
 *
 * 按 generatedAt 倒序：同一批节日可能提前数天就生成了，按「生成时间」排才
 * 是用户视角的「最近生成的卡」。坏文件跳过而不是整体报错。
 */
export function readFestivalList(days = 30): FestivalRecord[] {
  const limit = Number.isFinite(days) ? Math.max(1, Math.min(RETENTION_DAYS, Math.round(days))) : 30
  let names: string[]
  try {
    names = readdirSync(festivalRootDir()).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
  } catch {
    return []
  }
  const cutoff = festivalDateKey(new Date(Date.now() - limit * 86_400_000))
  const records: FestivalRecord[] = []
  for (const name of names) {
    const record = readFestivalRecord(name.slice(0, -'.json'.length))
    if (record === null) continue
    if (record.date < cutoff) continue
    records.push(record)
  }
  records.sort((a, b) => b.generatedAt - a.generatedAt || b.festivalDate.localeCompare(a.festivalDate))
  return records
}

/**
 * 清理过期记录与图片（保留最近 90 天）。
 *
 * 调度 tick 每次都会跑一遍：先按文件名日期（YYYY-MM-DD 字典序即时间序）判断，
 * 只 stat / unlink 命中的文件，窗口外的 tick 几乎零成本。返回删除的文件数
 * （测试可断言，日志可观测）。
 */
export function cleanupFestivalFiles(now: Date = new Date()): number {
  const cutoff = festivalDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - RETENTION_DAYS))
  let removed = 0
  const root = festivalRootDir()
  try {
    for (const name of readdirSync(root)) {
      const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)
      if (match === null || match[1] >= cutoff) continue
      try {
        rmSync(join(root, name), { force: true })
        removed += 1
      } catch {
        /* 单个文件删不掉不影响其余清理 */
      }
    }
  } catch {
    /* 目录不存在：没有可清理的 */
  }
  const images = festivalImageDir()
  try {
    for (const name of readdirSync(images)) {
      const match = /^(\d{4}-\d{2}-\d{2})\./.exec(name)
      if (match === null || match[1] >= cutoff) continue
      try {
        rmSync(join(images, name), { force: true })
        removed += 1
      } catch {
        /* 同上 */
      }
    }
  } catch {
    /* 目录不存在：没有可清理的 */
  }
  return removed
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

/**
 * 选一个可用的聊天模型。
 *
 * 顺序（与 brief / journal 一致）：
 *   1. 请求里显式指定的 model（provider + model 都有才采信；契约里没有该字段，
 *      但前端未来若要「换一个模型写」可以直接带上）；
 *   2. 宿主的默认模型 ctx.get('agentDefaultModel').currentSelection()；
 *   3. 注册表里的第一个 provider 的第一个 model（保证「至少有个模型能跑」）。
 *
 * 都拿不到返回 null，调用方**不会失败**——按「模型不可用」走资料卡兜底。
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

/* ───────────────────────────── 图片：尺寸解析 ───────────────────────────── */

/** 图片像素尺寸（解码后的真实宽高）。 */
export interface ImageSize {
  width: number
  height: number
}

/**
 * 从图片二进制头里解析真实像素尺寸。
 *
 * 为什么不用现成的 image-size 包：仓库没有这个依赖，为一张卡片配图引入第三方
 * 解码库不划算。这里只解析 PNG / JPEG / GIF / WebP 的文件头 —— 格式全部是
 * 公开且稳定的，几十行足够；解析不出来就拒绝这张图（宁可没图，也不要一张
 * 放大后糊成马赛克的缩略图）。
 */
export function imageSizeOf(buffer: Buffer): ImageSize | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null

  // PNG：8 字节签名 + IHDR（宽高在固定偏移 16 / 20）
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    if (buffer.length < 24) return null
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // GIF：GIF87a / GIF89a + 逻辑屏幕宽高（小端）
  if (buffer.toString('ascii', 0, 3) === 'GIF') {
    if (buffer.length < 10) return null
    const width = buffer.readUInt16LE(6)
    const height = buffer.readUInt16LE(8)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // WebP：RIFF....WEBP + VP8X / VP8 / VP8L 三种块
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && buffer.length >= 30) {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      // 关键帧起始码 9d 01 2a 之后是 14 位宽高
      if (buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
      }
      return null
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const b0 = buffer[21]
      const b1 = buffer[22]
      const b2 = buffer[23]
      const b3 = buffer[24]
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      }
    }
    return null
  }

  // JPEG：扫段找 SOFn（真正的宽高在 SOF 段里）
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xff) {
        offset += 1
        continue
      }
      // 无长度字段的标记：SOI / EOI / 重启标记
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      if (offset + 4 > buffer.length) return null
      const length = buffer.readUInt16BE(offset + 2)
      if (length < 2) return null
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isSof) {
        if (offset + 9 > buffer.length) return null
        const height = buffer.readUInt16BE(offset + 5)
        const width = buffer.readUInt16BE(offset + 7)
        return width > 0 && height > 0 ? { width, height } : null
      }
      offset += 2 + length
    }
    return null
  }

  return null
}

/* ───────────────────────────── 图片：候选筛选 ───────────────────────────── */

/** 百度图片接口的一条候选（只在内部用，字段名映射自对方 JSON）。 */
export interface BaiduImageCandidate {
  /** 图片标题（fromPageTitleEnc，已剥 HTML / 解实体）。 */
  title: string
  /** 原图 URL（replaceUrl[0].ObjURL）。 */
  objUrl: string
  /** 中等尺寸 URL（middleURL）。 */
  middleUrl: string
  /** 缩略图 URL（thumbURL，仅兜底展示用，不参与评分）。 */
  thumbUrl: string
  /** 来源站点域名（fromURLHost）。 */
  fromHost: string
  /** 来源页面 URL（fromURL）。 */
  sourceUrl: string
  /** 元数据宽（可能缺失 / 0）。 */
  metaWidth: number
  /** 元数据高（可能缺失 / 0）。 */
  metaHeight: number
  /** 图片类型（jpeg / png / ...）。 */
  type: string
}

/** 解码 HTML 实体 + 剥标签（百度标题里常有 <strong> 高亮与 &quot;）。 */
function decodeHtml(text: string): string {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 是否是 http(s) URL（百度接口偶尔给空串 / javascript: / data:）。 */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/** 标题命中「不是实拍」词表。 */
export function imageTitleBlocked(title: string): boolean {
  return IMAGE_TITLE_BLOCKLIST.test(title)
}

/** 来源域名命中黑名单。 */
export function imageHostBlocked(host: string): boolean {
  return IMAGE_HOST_BLOCKLIST.test(String(host ?? '').toLowerCase())
}

/** 宽高比是否在「横图 / 方图」区间。 */
export function imageAspectOk(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false
  const ratio = width / height
  return ratio >= IMAGE_MIN_RATIO && ratio <= IMAGE_MAX_RATIO
}

/**
 * 把百度接口的 data[] 归一化成候选数组。
 *
 * 接口末尾常常带一个 null（历史遗留），字段也可能缺：所有字段都防御式读取，
 * 坏候选直接丢，绝不让一个畸形条目把整轮搜图搞崩。
 */
export function normalizeBaiduCandidates(payload: unknown): BaiduImageCandidate[] {
  const root = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const data = Array.isArray(root.data) ? root.data : []
  const out: BaiduImageCandidate[] = []
  /**
   * 标题归一化：先剥 HTML / 解实体，再兜一层 URL 解码。
   *
   * 百度接口的 fromPageTitleEnc 正常是 HTML 实体编码，但中文标题偶尔会被
   * 双重编码成 %E7%AB%8B%E5%86%AC 这种 URL 形式；不做这一步，图注就会是
   * 一串百分号编码（用户看不懂）。解码失败时保持原样，绝不因此丢候选。
   */
  const normalizeTitle = (raw: string): string => {
    let text = decodeHtml(raw)
    if (/%[0-9a-f]{2}/i.test(text)) {
      try {
        const decoded = decodeURIComponent(text)
        if (decoded !== text) text = decodeHtml(decoded)
      } catch {
        /* 非法百分号序列：保留解码前文本 */
      }
    }
    return text
  }
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const replaceUrl = Array.isArray(record.replaceUrl) ? record.replaceUrl : []
    const firstReplace = replaceUrl[0]
    const firstReplaceRecord = firstReplace !== null && typeof firstReplace === 'object' ? (firstReplace as Record<string, unknown>) : {}
    const objUrl = typeof firstReplaceRecord.ObjURL === 'string'
      ? firstReplaceRecord.ObjURL
      : typeof record.objURL === 'string' ? record.objURL : ''
    const middleUrl = typeof record.middleURL === 'string' ? record.middleURL : ''
    const thumbUrl = typeof record.thumbURL === 'string' ? record.thumbURL : ''
    if (!isHttpUrl(objUrl) && !isHttpUrl(middleUrl)) continue
    const metaWidth = Number(record.width)
    const metaHeight = Number(record.height)
    out.push({
      title: normalizeTitle(typeof record.fromPageTitleEnc === 'string' ? record.fromPageTitleEnc : String(record.fromPageTitle ?? '')),
      objUrl: isHttpUrl(objUrl) ? objUrl : '',
      middleUrl: isHttpUrl(middleUrl) ? middleUrl : '',
      thumbUrl: isHttpUrl(thumbUrl) ? thumbUrl : '',
      fromHost: typeof record.fromURLHost === 'string' ? record.fromURLHost : '',
      sourceUrl: typeof record.fromURL === 'string' ? record.fromURL : '',
      metaWidth: Number.isFinite(metaWidth) && metaWidth > 0 ? metaWidth : 0,
      metaHeight: Number.isFinite(metaHeight) && metaHeight > 0 ? metaHeight : 0,
      type: typeof record.type === 'string' ? record.type : '',
    })
  }
  return out
}

/**
 * 候选打分（分越高越先尝试）。
 *
 * 排序偏好：横图/方图 > 元数据达标 > 有原图 > 有中图 > 尺寸大。真正的硬性
 * 条件（文件大小、实际解码像素）在下载后才校验，所以这里只负责「先试谁」。
 */
function candidateScore(candidate: BaiduImageCandidate): number {
  let score = 0
  if (candidate.metaWidth > 0 && candidate.metaHeight > 0) {
    if (imageAspectOk(candidate.metaWidth, candidate.metaHeight)) score += 100
    if (candidate.metaWidth >= IMAGE_MIN_WIDTH && candidate.metaHeight >= IMAGE_MIN_HEIGHT) score += 40
    score += Math.min(20, candidate.metaWidth / 200)
  } else {
    score += 30 // 元数据缺失：不确定，放中间
  }
  if (candidate.objUrl !== '') score += 20
  if (candidate.middleUrl !== '') score += 5
  return score
}

/**
 * 过滤 + 排序候选。
 *
 * 硬过滤：标题黑名单、来源黑名单、元数据明确小于 900×600（「元数据与实际
 * 解码像素都 >= 900×600」的前一半）。元数据缺失不硬拒 —— 交给下载后的实际
 * 解码尺寸兜底。
 */
export function rankBaiduCandidates(candidates: readonly BaiduImageCandidate[]): BaiduImageCandidate[] {
  const filtered: BaiduImageCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.objUrl === '' && candidate.middleUrl === '') continue
    if (imageTitleBlocked(candidate.title)) continue
    if (imageHostBlocked(candidate.fromHost)) continue
    if (
      candidate.metaWidth > 0 &&
      candidate.metaHeight > 0 &&
      (candidate.metaWidth < IMAGE_MIN_WIDTH || candidate.metaHeight < IMAGE_MIN_HEIGHT)
    ) continue
    filtered.push(candidate)
  }
  return filtered
    .map((candidate) => ({ candidate, score: candidateScore(candidate) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.candidate)
}

/** 来源域名 → 展示名（未知域名原样返回去 www 的域名）。 */
export function sourceDisplayName(host: string): string {
  const normalized = String(host ?? '').trim().toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '')
  if (normalized === '') return '网络'
  for (const [domain, name] of SOURCE_DISPLAY_NAMES) {
    if (normalized === domain || normalized.endsWith('.' + domain)) return name
  }
  return normalized
}

/* ───────────────────────────── 图片：下载与落盘 ───────────────────────────── */

/** 下载并通过校验的一张图。 */
export interface DownloadedImage {
  buffer: Buffer
  mime: string
  width: number
  height: number
}

/**
 * 把「整轮生成」的总超时与「单次抓取 / 下载」的超时合成一个信号。
 *
 * AbortSignal.any 是 Node 20+ 的能力；老运行时退回只用总超时信号（宁可慢一点，
 * 也不能因为少一个 API 就把整轮生成搞崩）。
 */
function mergeSignals(signal: AbortSignal, timeout: AbortSignal): AbortSignal {
  const combine = (AbortSignal as any).any
  return typeof combine === 'function' ? combine([signal, timeout]) : signal
}

/** 按文件头判断 MIME（百度的 content-type 常常是 application/octet-stream）。 */
function sniffImageMime(buffer: Buffer, headerType: string | null): string | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  const type = String(headerType ?? '').toLowerCase()
  if (type.startsWith('image/')) return type
  return null
}

/** MIME → 扩展名。 */
function extensionOfMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  return 'bin'
}

/** 单个 URL 的下载 + 全部硬性校验（任一不过返回 null）。 */
async function downloadImage(url: string, signal: AbortSignal): Promise<DownloadedImage | null> {
  try {
    const merged = mergeSignals(signal, AbortSignal.timeout(FESTIVAL_IMAGE_DOWNLOAD_TIMEOUT_MS))
    const response = await fetch(url, {
      signal: merged,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        referer: 'https://image.baidu.com/',
        accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
      },
    })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < IMAGE_MIN_BYTES || buffer.length > FESTIVAL_IMAGE_MAX_BYTES) return null
    const size = imageSizeOf(buffer)
    if (size === null) return null
    if (size.width < IMAGE_MIN_WIDTH || size.height < IMAGE_MIN_HEIGHT) return null
    if (!imageAspectOk(size.width, size.height)) return null
    const mime = sniffImageMime(buffer, response.headers.get('content-type'))
    if (mime === null) return null
    return { buffer, mime, width: size.width, height: size.height }
  } catch {
    return null
  }
}

/* ───────────────────────────── 图片：生图模型 ───────────────────────────── */

/** 读 model-capabilities：优先 settings 命名空间，再退回 ~/.dsh/model-capabilities.json。 */
function readModelCapabilities(ctx: Record<string, any>): Record<string, any> {
  try {
    const section = typeof ctx.settings?.get === 'function' ? ctx.settings.get('model-capabilities') : null
    if (section !== null && typeof section === 'object') return section as Record<string, any>
  } catch { /* 没有 settings 服务 */ }
  try {
    const file = join(dshHome(), 'model-capabilities.json')
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
  } catch { /* 文件损坏按无配置处理 */ }
  return {}
}

/** 按 provider id 取供应商配置（baseURL / apiKeyEnv 等）。 */
function providerProfile(ctx: Record<string, any>, providerId: string): any {
  try {
    const llm = getLlm(ctx)
    const entries = typeof llm?.listConfigurableProviders === 'function' ? (llm.listConfigurableProviders() as any[]) : []
    const entry = (Array.isArray(entries) ? entries : []).find((item: any) => item?.provider === providerId)
    if (entry === undefined) return null
    const section = typeof ctx.settings?.get === 'function' ? ctx.settings.get(entry.settingsNs) : null
    if (section === null || typeof section !== 'object') return null
    let node: any = section
    for (const key of Array.isArray(entry.settingsPath) ? entry.settingsPath : []) {
      if (node !== null && typeof node === 'object' && key in node) node = node[key]
      else return null
    }
    return node !== null && typeof node === 'object' ? node : null
  } catch {
    return null
  }
}

/** 从凭据服务取 API key；取不到返回 null。 */
async function resolveCredential(ctx: Record<string, any>, envName: unknown): Promise<string | null> {
  if (typeof envName !== 'string' || envName === '') return null
  try {
    const credentials = ctx.get?.('credentials') ?? ctx.credentials
    if (credentials === undefined || credentials === null || typeof credentials.resolve !== 'function') return null
    const resolved = await credentials.resolve(envName)
    return resolved !== null && resolved !== undefined ? String(resolved.value) : null
  } catch {
    return null
  }
}

/** 'provider/model' → 两段；不合法返回 null。 */
function splitModelKey(key: unknown): { provider: string; model: string } | null {
  const text = typeof key === 'string' ? key.trim() : ''
  const index = text.indexOf('/')
  if (index <= 0 || index >= text.length - 1) return null
  return { provider: text.slice(0, index), model: text.slice(index + 1) }
}

/** 生图返回 url 时把它下载成字节（部分网关不给 b64_json）。 */
async function fetchImageBytes(url: string, timeoutMs: number): Promise<{ buffer: Buffer; mime: string | null } | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1024) return null
    return { buffer, mime: response.headers.get('content-type') }
  } catch {
    return null
  }
}

/**
 * 用当前配置的生图模型（model-capabilities.imageActive）生成节日配图。
 *
 * 用户 2026-11-05 反馈「百度图片对不上」：立冬搜回来的是生羊肉与食材拼图。
 * 生图模型可以把节气、食物、习俗直接写进提示词，画面可控，所以配图流程
 * 改为**生图优先、搜图降级**。
 *
 * 任何失败（没配生图模型 / 没凭据 / 网关报错 / 返回空 / 字节校验不过）
 * 都只返回 null、不抛——调用方继续走百度搜图，最差也只是无图占位。
 */
async function generateModelImage(
  ctx: Record<string, any>,
  entry: FestivalEntry,
  signal: AbortSignal,
): Promise<DownloadedImage | null> {
  const caps = readModelCapabilities(ctx)
  const active = splitModelKey(caps.imageActive)
  if (active === null) return null
  const profile = providerProfile(ctx, active.provider)
  if (profile === null || typeof profile.baseURL !== 'string' || profile.baseURL === '') {
    ctx.logger?.warn?.('[dsh-seeker-bot] festival 生图：供应商 ' + active.provider + ' 没有 baseURL')
    return null
  }
  const apiKey = await resolveCredential(ctx, profile.apiKeyEnv)
  if (apiKey === null) {
    ctx.logger?.warn?.('[dsh-seeker-bot] festival 生图：缺少凭据 ' + String(profile.apiKeyEnv ?? ''))
    return null
  }
  const imagePath = typeof caps.imagePath === 'string' && caps.imagePath !== '' ? caps.imagePath : 'images/generations'
  const url = String(profile.baseURL).replace(/[\\/]+$/, '') + '/' + imagePath.replace(/^[\\/]+/, '')
  const prompt = festivalImagePrompt(entry)
  const payload: Record<string, unknown> = {
    model: active.model,
    prompt,
    n: 1,
    size: '1024x1536',
    response_format: 'b64_json',
  }
  try {
    const merged = mergeSignals(signal, AbortSignal.timeout(FESTIVAL_IMAGE_GEN_TIMEOUT_MS))
    const call = async (body: Record<string, unknown>): Promise<{ response: Response; rawText: string }> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(body),
        signal: merged,
      })
      return { response, rawText: await response.text() }
    }
    let attempt = await call(payload)
    // 部分 OpenAI 兼容网关不认 size / response_format：按报错自动降参重试一次（与 journal 同款）。
    if (!attempt.response.ok && /size|response_format|unknown|invalid|unsupported/i.test(attempt.rawText)) {
      const relaxed = { ...payload }
      delete relaxed.size
      delete relaxed.response_format
      attempt = await call(relaxed)
    }
    if (!attempt.response.ok) {
      ctx.logger?.warn?.('[dsh-seeker-bot] festival 生图接口 ' + String(attempt.response.status) + '：' + attempt.rawText.slice(0, 200))
      return null
    }
    let data: any
    try { data = JSON.parse(attempt.rawText) } catch { return null }
    const first = Array.isArray(data?.data) ? data.data[0] : undefined
    let buffer: Buffer | null = null
    let headerType: string | null = 'image/png'
    if (first !== undefined && first !== null && typeof first.b64_json === 'string' && first.b64_json.length > 32) {
      buffer = Buffer.from(first.b64_json, 'base64')
    } else if (first !== undefined && first !== null && typeof first.url === 'string' && first.url !== '') {
      const fetched = await fetchImageBytes(first.url, FESTIVAL_IMAGE_DOWNLOAD_TIMEOUT_MS)
      if (fetched !== null) { buffer = fetched.buffer; headerType = fetched.mime }
    }
    if (buffer === null || buffer.length < 16 * 1024) return null
    const mime = sniffImageMime(buffer, headerType)
    if (mime === null) return null
    const size = imageSizeOf(buffer)
    if (size === null || size.width < 512 || size.height < 512) return null
    return { buffer, mime, width: size.width, height: size.height }
  } catch (error) {
    ctx.logger?.warn?.('[dsh-seeker-bot] festival 生图异常：' + describeError(error))
    return null
  }
}

/** 候选取图：优先原图（ObjURL），失败退中图（middleURL）。 */
async function downloadCandidate(candidate: BaiduImageCandidate, signal: AbortSignal): Promise<DownloadedImage | null> {
  const urls = [candidate.objUrl, candidate.middleUrl].filter((url) => isHttpUrl(url))
  for (const url of urls) {
    if (signal.aborted) return null
    const downloaded = await downloadImage(url, signal)
    if (downloaded !== null) return downloaded
  }
  return null
}

/**
 * 把下载好的图片写进 festivals/images/，返回磁盘文件名。
 *
 * 文件名固定为 <festivalDate>.<ext>：同一节日换图（force 重生成）直接覆盖，
 * 同时清掉该日期名下的其他扩展（避免 png / jpg 各留一份）。
 */
function writeFestivalImageFile(festivalDate: string, downloaded: DownloadedImage): string {
  const dir = festivalImageDir()
  mkdirSync(dir, { recursive: true })
  const ext = extensionOfMime(downloaded.mime)
  const file = festivalDate + '.' + ext
  try {
    for (const name of readdirSync(dir)) {
      if (name === file) continue
      if (name.startsWith(festivalDate + '.')) rmSync(join(dir, name), { force: true })
    }
  } catch {
    /* 清理旧图失败不影响写新图 */
  }
  writeFileSync(join(dir, file), downloaded.buffer)
  return file
}

/** 搜一组百度图片候选；失败抛错（调用方按「本组没有图」处理）。 */
async function searchBaiduImages(query: string, signal: AbortSignal): Promise<BaiduImageCandidate[]> {
  const url = BAIDU_IMAGE_API + '?tn=resultjson_com&word=' + encodeURIComponent(query) + '&pn=0&rn=30'
  const merged = mergeSignals(signal, AbortSignal.timeout(FESTIVAL_IMAGE_SEARCH_TIMEOUT_MS))
  const response = await fetch(url, {
    signal: merged,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      referer: 'https://image.baidu.com/',
      accept: 'application/json, text/plain, */*',
    },
  })
  if (!response.ok) throw new Error('百度图片接口 ' + response.status)
  const text = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    // 反爬时可能返回 HTML 验证页：按「本组无候选」处理，不抛
    return []
  }
  return normalizeBaiduCandidates(payload)
}

/**
 * 节日卡配图主流程：按查询词逐组搜、逐候选下载，第一个通过全部校验的即用。
 *
 * 返回的图片**不含 url**（url 要等最终 generatedAt 确定后由调用方拼，
 * 保证 ?v= 与记录里的生成时间一致）。任何一步失败都只返回 null，绝不抛。
 */
async function pickFestivalImage(
  ctx: Record<string, any>,
  entry: FestivalEntry,
  modelQueries: readonly string[],
  festivalDate: string,
  signal: AbortSignal,
): Promise<Omit<FestivalImage, 'url'> | null> {
  /*
   * 1) 生图模型优先（用户 2026-11-05 的要求）：把节气、应季食物、习俗直接
   *    写进提示词，画面可控；百度搜图只能按关键词撞运气，立冬会搜回生羊肉
   *    与食材拼图。生图失败才降到第 2 步的实拍检索。
   */
  try {
    const generated = await generateModelImage(ctx, entry, signal)
    if (generated !== null) {
      const file = writeFestivalImageFile(festivalDate, generated)
      return {
        file,
        caption: entry.name + ' · AI 绘制',
        source: 'AI 生图',
        width: generated.width,
        height: generated.height,
      }
    }
  } catch (error) {
    ctx.logger?.warn?.('[dsh-seeker-bot] festival 生图流程失败，降级到搜图：' + describeError(error))
  }

  // 2) 百度实拍检索兜底。
  const queries = festivalImageQueries(entry, modelQueries)
  for (const query of queries) {
    if (signal.aborted) return null
    let candidates: BaiduImageCandidate[]
    try {
      candidates = await searchBaiduImages(query, signal)
    } catch (error) {
      ctx.logger?.warn?.('[dsh-seeker-bot] festival 图片搜索失败（' + query + '）：' + describeError(error))
      continue
    }
    const ranked = rankBaiduCandidates(candidates).slice(0, IMAGE_CANDIDATES_PER_QUERY)
    if (ranked.length === 0) continue
    for (const candidate of ranked) {
      if (signal.aborted) return null
      const downloaded = await downloadCandidate(candidate, signal)
      if (downloaded === null) continue
      try {
        const file = writeFestivalImageFile(festivalDate, downloaded)
        return {
          file,
          caption: candidate.title.length > 60 ? candidate.title.slice(0, 60) : candidate.title,
          source: sourceDisplayName(candidate.fromHost),
          // 百度的 fromURL 偶尔是加密跳转串（ippr_z2C…），不是 http 地址：
          // 这种值写进记录只会让前端图注链接失效，宁可不写。
          ...(candidate.sourceUrl !== '' && isHttpUrl(candidate.sourceUrl) ? { sourceUrl: candidate.sourceUrl } : {}),
          width: downloaded.width,
          height: downloaded.height,
        }
      } catch (error) {
        ctx.logger?.warn?.('[dsh-seeker-bot] festival 图片落盘失败：' + describeError(error))
      }
    }
  }
  return null
}

/* ───────────────────────────── JSON 解析 ───────────────────────────── */

/**
 * 把模型输出解析成 JSON 对象。
 *
 * 模型经常在 JSON 外面包一层解释或 markdown 围栏，所以：trim → 剥三反引号 json
 * 围栏 → 取第一个大括号到最后一个大括号 → JSON.parse。失败抛**可读中文错误**
 * （调用方会把它变成日志，并走资料卡兜底），不要抛裸 SyntaxError——那在日志里
 * 是一串英文堆栈，排障时看不出是模型的问题。
 */
export function parseFestivalJson(raw: string): Record<string, unknown> {
  let text = String(raw ?? '').trim()
  // \u0060 是反引号：用转义写三反引号围栏，避免把 markdown 的围栏字符直接写进源码。
  const fence = /^\u0060\u0060\u0060(?:json)?\s*([\s\S]*?)\s*\u0060\u0060\u0060$/i.exec(text)
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
    throw new Error('模型返回的 JSON 无法解析：' + String(error?.message ?? error).slice(0, 160))
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型返回的 JSON 不是对象')
  }
  return parsed as Record<string, unknown>
}

/** 从模型 JSON 里收集搜图词（imageQuery 允许字符串或数组）。 */
function imageQueriesOf(payload: Record<string, unknown>): string[] {
  const cards = Array.isArray(payload.cards) ? payload.cards : []
  const out: string[] = []
  for (const raw of cards) {
    if (raw === null || typeof raw !== 'object') continue
    const value = (raw as Record<string, unknown>).imageQuery
    const list = Array.isArray(value) ? value : [value]
    for (const item of list) {
      if (typeof item !== 'string') continue
      const text = item.replace(/\s+/g, ' ').trim()
      if (text === '' || text.length > 60) continue
      if (!out.includes(text)) out.push(text)
    }
  }
  return out.slice(0, 4)
}

/* ───────────────────────────── 归一化 ───────────────────────────── */

/** 校验 / 归一化日期：非法或缺省时退回今天（本地时区）。 */
function normalizeFestivalDate(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(text + 'T12:00:00')
    if (!Number.isNaN(parsed.getTime())) return text
  }
  return festivalDateKey(new Date())
}

/* ───────────────────────────── 生成 ───────────────────────────── */

/**
 * 生成一张节日卡并落盘。
 *
 * 失败路径只有三种：并发锁、窗口内没有节日、兜底卡也拼不出来（理论上不可能）。
 * 模型侧的**任何**问题（没有模型 / stream 抛错 / 输出垃圾 / 清洗后为空）都会
 * 降级成 origin='fallback' 的资料卡，并继续搜图、仍然返回 ok:true —— 这是
 * 产品要的降级，不是失败。
 *
 * @param request.date YYYY-MM-DD；缺省今天（本地时区），测试可注入。
 * @param request.force true = 已有记录也重新生成（换文案 + 换图）。
 */
export async function generateFestival(
  ctx: Record<string, any>,
  request: GenerateFestivalRequest = {},
): Promise<GenerateFestivalResult> {
  if (generating) return { ok: false, error: '正在生成中，请稍候' }

  const date = normalizeFestivalDate(request.date)
  const today = parseFestivalDate(date)
  const entries = upcomingFestivals(today, FESTIVAL_WINDOW_DAYS)
  const entry = entries[0]
  if (entry === undefined) return fail('最近 ' + String(FESTIVAL_WINDOW_DAYS) + ' 天没有节气或节日')

  if (request.force !== true) {
    const existing = readFestivalRecord(entry.date)
    if (existing !== null) {
      lastError = undefined
      return { ok: true, record: existing }
    }
  }

  /*
   * 锁在第一个 await 之前置位：从这一行到 generate 返回之间没有第二次进入的
   * 窗口（Node 单线程，同步代码段不会被另一个请求插入）。
   */
  generating = true
  const startedAt = Date.now()
  const controller = new AbortController()
  // 总超时：模型 + 搜图 + 下载共用一个信号（模型慢到 120s 时用户早以为卡死了）
  const timer = setTimeout(() => controller.abort(), FESTIVAL_TIMEOUT_MS)
  try {
    let record: FestivalRecord | null = null
    let modelQueries: string[] = []
    const llm = getLlm(ctx)
    const route = llm !== undefined && llm !== null && typeof llm.stream === 'function'
      ? await resolveChatModel(ctx, (request as unknown as Record<string, any>).model)
      : null

    if (route === null) {
      ctx.logger?.warn?.('[dsh-seeker-bot] festival：没有可用的聊天模型，使用资料卡兜底')
    } else {
      try {
        let raw = ''
        for await (const chunk of llm.stream({
          provider: route.provider,
          model: route.model,
          messages: [createUserMessage({
            content: [{ type: 'text', text: buildFestivalUserPrompt(entry, today) }],
            // 消息归属写当前实际装载的 bundle id：用量与会话日志按 bundle 聚合
            source: { kind: 'plugin:dsh-seeker-bot', plugin: 'dsh-seeker-bot' },
          })],
          system: festivalSystemPrompt(),
          maxTokens: 2000,
          temperature: 0.8,
          signal: controller.signal,
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
        }
        if (raw.trim() === '') throw new Error('模型没有返回内容')
        const payload = parseFestivalJson(raw)
        modelQueries = imageQueriesOf(payload)
        const generatedAt = Date.now()
        record = sanitizeFestivalRecord(payload, {
          entry,
          origin: 'model',
          model: route.provider + '/' + route.model,
          elapsedMs: generatedAt - startedAt,
          generatedAt,
          today,
        })
        if (record === null) throw new Error('模型返回的卡片内容为空')
      } catch (error) {
        ctx.logger?.warn?.('[dsh-seeker-bot] festival 模型生成失败，改走资料卡：' + describeError(error))
        record = null
        modelQueries = []
      }
    }

    if (record === null) {
      const generatedAt = Date.now()
      record = sanitizeFestivalRecord({ cards: [festivalFallbackCard(entry)] }, {
        entry,
        origin: 'fallback',
        elapsedMs: generatedAt - startedAt,
        generatedAt,
        today,
      })
    }
    if (record === null) return fail('生成失败：节日资料不完整')

    /*
     * 搜图放在最后：模型写文案用掉的 token 与图片无关，图片失败只让 image=null。
     * 即使 controller 已因超时 abort，这里也只会快速返回 null，不会把整张卡拖垮。
     */
    let imageBase: Omit<FestivalImage, 'url'> | null = null
    try {
      imageBase = await pickFestivalImage(ctx, entry, modelQueries, entry.date, controller.signal)
    } catch (error) {
      ctx.logger?.warn?.('[dsh-seeker-bot] festival 搜图失败：' + describeError(error))
    }

    const generatedAt = Date.now()
    const image: FestivalImage | null = imageBase === null
      ? null
      : { ...imageBase, url: FESTIVAL_IMAGE_ROUTE + '/' + entry.date + '?v=' + String(generatedAt) }
    const finalRecord: FestivalRecord = {
      ...record,
      generatedAt,
      elapsedMs: generatedAt - startedAt,
      cards: record.cards.map((card) => ({ ...card, image })),
    }

    try {
      writeFestivalRecord(finalRecord)
    } catch (error) {
      // 落盘失败只留痕：卡片已经生成出来了，至少这一轮该返回给前端
      ctx.logger?.warn?.('[dsh-seeker-bot] festival 落盘失败：' + describeError(error))
    }
    lastError = undefined
    return { ok: true, record: finalRecord }
  } catch (error: any) {
    const aborted = controller.signal.aborted
    const message = aborted
      ? '生成超时（' + String(Math.round(FESTIVAL_TIMEOUT_MS / 1000)) + ' 秒）'
      : '生成失败：' + String(error?.message ?? error)
    return fail(message.slice(0, 300))
  } finally {
    clearTimeout(timer)
    generating = false
  }
}

/* ───────────────────────────── 今日 / 调度 ───────────────────────────── */

/**
 * GET /festival/today 的回包（纯函数，测试可注入 now）。
 *
 * 口径：取**当前窗口内最近的一个节日**，返回它的记录（没生成就是 null）与
 * 下一个节日摘要。没有节日时 record / next 都是 null，前端显示空态。
 */
export function festivalTodayPayload(now: Date = new Date()): FestivalTodayResponse {
  const entries = upcomingFestivals(now, FESTIVAL_WINDOW_DAYS)
  const entry = entries[0]
  if (entry === undefined) {
    return {
      ok: true,
      record: null,
      next: null,
      generating,
      ...(lastError === undefined ? {} : { error: lastError }),
      hasToday: false,
    }
  }
  const record = readFestivalRecord(entry.date)
  return {
    ok: true,
    record,
    next: festivalNextOf(entry, now),
    generating,
    ...(lastError === undefined ? {} : { error: lastError }),
    hasToday: hasFestivalFor(entry.date),
  }
}

/** checkFestivalSchedule 的结果。reason 是给日志 / 排障看的中文短句。 */
export interface FestivalCheckResult {
  ok: boolean
  reason: string
}

/**
 * 检查当前该不该生成节日卡（满足时生成）。
 *
 * 判定顺序（**先便宜后昂贵**）：清理过期文件 → 当前小时 ≥ 6 → 窗口内有没有
 * 节日 → 对应记录是否已有 → 距上次尝试是否满 30 分钟。前几步只读目录 + 纯计算，
 * 窗口外每个 tick 几乎零成本；只有全部通过才会真的联网 + 调模型。
 *
 * @param now 判定用的当前时间（测试可注入）。
 */
export async function checkFestivalSchedule(
  ctx: Record<string, any>,
  now: Date | number = new Date(),
): Promise<FestivalCheckResult> {
  const at = now instanceof Date ? now : new Date(now)
  try {
    cleanupFestivalFiles(at)
  } catch (error) {
    ctx.logger?.warn?.('[dsh-seeker-bot] festival 清理过期文件失败：' + describeError(error))
  }
  const hour = at.getHours()
  if (hour < SCHEDULE_START_HOUR) {
    return { ok: false, reason: '还没到 ' + String(SCHEDULE_START_HOUR) + ' 点' }
  }
  const entries = upcomingFestivals(at, FESTIVAL_WINDOW_DAYS)
  const entry = entries[0]
  if (entry === undefined) return { ok: false, reason: '最近 ' + String(FESTIVAL_WINDOW_DAYS) + ' 天没有节气或节日' }
  if (hasFestivalFor(entry.date)) return { ok: false, reason: entry.date + ' 的节日卡已生成' }
  if (at.getTime() - lastAttemptAt < SCHEDULE_RETRY_GAP_MS) {
    return { ok: false, reason: '距上次尝试不足 30 分钟' }
  }
  lastAttemptAt = at.getTime()

  const result = await generateFestival(ctx, { date: festivalDateKey(at), force: false })
  if (result.ok) {
    const reason = '已生成 ' + entry.date + ' 的节日卡'
    ctx.logger?.info?.('[dsh-seeker-bot] ' + reason)
    return { ok: true, reason }
  }
  const error = result.error ?? '未知原因'
  ctx.logger?.warn?.('[dsh-seeker-bot] festival 生成失败：' + error)
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
 * 超限 / 坏 JSON / 读流出错一律解析成空对象：请求体字段全可选，空对象就是
 * 「用全部缺省值」，没必要为坏请求专门造一种错误（与 brief 同款）。
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

/** 扩展名 → Content-Type。 */
function contentTypeOfFile(file: string): string {
  const ext = extname(file).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'application/octet-stream'
}

/**
 * 图片路由：按 festivalDate 从记录里找 file，流式返回。
 *
 * 记录里只存文件名（不含目录），这里再用 basename 兜一层：即使文件被手滑改成
 * 带路径的字符串，也只会落到 images 目录里。404 一律回明确的 JSON（不是空响应，
 * 前端 img.onerror 时能从 network 面板看出原因）。
 */
function serveFestivalImage(req: any, res: any): void {
  if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  let pathname = ''
  try {
    pathname = new URL(String(req?.url ?? '/'), 'http://localhost').pathname
  } catch {
    sendJson(res, 400, { ok: false, error: '请求地址无效' })
    return
  }
  if (!pathname.startsWith(FESTIVAL_IMAGE_ROUTE + '/')) {
    sendJson(res, 404, { ok: false, error: '图片不存在' })
    return
  }
  const tail = pathname.slice(FESTIVAL_IMAGE_ROUTE.length + 1)
  let festivalDate = ''
  try {
    festivalDate = decodeURIComponent(tail.split('/')[0] ?? '')
  } catch {
    festivalDate = ''
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(festivalDate)) {
    sendJson(res, 404, { ok: false, error: '图片不存在' })
    return
  }
  const record = readFestivalRecord(festivalDate)
  const file = record?.cards.find((card) => card.image?.file !== undefined)?.image?.file
  if (file === undefined || file === '') {
    sendJson(res, 404, { ok: false, error: '图片不存在' })
    return
  }
  const full = join(festivalImageDir(), basename(file))
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(full)
  } catch {
    sendJson(res, 404, { ok: false, error: '图片不存在' })
    return
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { ok: false, error: '图片不存在' })
    return
  }
  try {
    res.writeHead(200, {
      'Content-Type': contentTypeOfFile(full),
      'Content-Length': String(stat.size),
      'Cache-Control': 'public, max-age=86400',
    })
    const stream = createReadStream(full)
    stream.on('error', () => {
      try {
        res.destroy?.()
      } catch {
        /* 客户端已断开 */
      }
    })
    stream.pipe(res)
  } catch {
    sendJson(res, 404, { ok: false, error: '图片不存在' })
  }
}

/* ───────────────────────────── 挂载 ───────────────────────────── */

/**
 * 挂载节日卡的宿主半身（三条 exact 路由 + 一条 prefix 图片路由 + 定时调度）。
 *
 * 路由挂在 /api/dsh-done-pill/festival/* 下（与对话完成胶囊同一前缀），每条
 * 路由各用一个 effect 管生命周期：一条同路径冲突不该拖垮另外三条。
 *
 * 功能开关口径：与 brief 一致，view.festival-card 关掉时**第一行就返回**：
 * 不挂路由、不起定时器，自然也不会联网或产生文件（这是「组件行一关，后台能力
 * 就停」的口径）。入口（done-pill/index.ts）另外还套了一层 try/catch，节日卡
 * 起不来最多是「胶囊左侧少一张卡」，不连累胶囊本身与情报卡。
 */
export function applyFestivalHost(ctx: Record<string, any>): void {
  if (!hostFeatureEnabled('view.festival-card')) return

  ctx.inject(['webServer'], (webCtx: Record<string, any>) => {
    const register = (
      kind: 'exact' | 'prefix',
      path: string,
      label: string,
      handler: (req: any, res: any) => void,
    ): void => {
      webCtx.effect(() => {
        try {
          return webCtx.webServer.register({ kind, path, handler })
        } catch (error) {
          // 路由可能已被同路径的其他插件注册：记警告并继续，不拖垮整个插件加载
          ctx.logger?.warn?.('[dsh-seeker-bot] festival route ' + path + ' 注册失败：' + describeError(error))
          return undefined
        }
      }, 'dsh-seeker-bot: ' + label)
    }

    /* GET /festival/today：前端轮询用。record 为 null 时前端显示空态 / 点此生成。 */
    register('exact', ROUTE + '/today', 'festival today route', (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, festivalTodayPayload(new Date()) as unknown as Record<string, unknown>)
    })

    /* POST /festival/generate：手动生成 / 换一张。即使失败也回 200，原因放 error。 */
    register('exact', ROUTE + '/generate', 'festival generate route', (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // 写路由必须自己补跨站闸门：插件前缀比官方 /api 长，官方那道校验不会执行
      if (rejectCrossSite(req?.headers, (status, payload) => sendJson(res, status, payload))) return
      void (async () => {
        const body = await readJsonBody(req)
        const result = await generateFestival(ctx, body as GenerateFestivalRequest)
        // ok:false 也回 200：错误走 error 字段（与 brief 路由一致），前端按 ok 分支
        sendJson(res, 200, result as unknown as Record<string, unknown>)
      })()
    })

    /* GET /festival/list?days=30：历史节日卡（新的在前），给「往期」视图用。 */
    register('exact', ROUTE + '/list', 'festival list route', (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let days = 30
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const raw = url.searchParams.get('days')
        if (raw !== null && /^\d+$/.test(raw)) days = Number(raw)
      } catch {
        /* URL 解析失败：按默认 30 天 */
      }
      sendJson(res, 200, { ok: true, records: readFestivalList(days) })
    })

    /* prefix /festival/image：按 festivalDate 流式返回磁盘上的配图。 */
    register('prefix', FESTIVAL_IMAGE_ROUTE, 'festival image route', serveFestivalImage)
  })

  /*
   * 节日卡调度定时器。
   *
   * 用 30 分钟 tick 而不是「给每个节日定一个提前几天的闹钟」：宿主可能整夜没开、
   * 也可能凌晨重启，定点闹钟一旦错过就再也不会触发；而 tick 在 6 点后的任意一次
   * 都会补上（窗口内有节日且没有记录就生成）。失败也由 30 分钟的重试间隔自然退避。
   *
   * 两个定时器都要 unref()：默认会把 Node 事件循环钉住，单元测试 / 一次性脚本
   * 会永远退不出去（实测表现为脚本跑完不结束）。
   */
  try {
    ctx?.effect?.(() => {
      const tick = (): void => {
        void checkFestivalSchedule(ctx).catch(() => undefined)
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
    }, 'dsh-seeker-bot: festival schedule')
  } catch (error) {
    ctx.logger?.warn?.('[dsh-seeker-bot] festival 调度器启动失败：' + describeError(error))
  }

  ctx.logger?.info?.('[dsh-seeker-bot] festival mounted: ' + ROUTE + '/today + /generate + /list + ' + FESTIVAL_IMAGE_ROUTE)
}

/* ───────────────────────────── 测试面 ───────────────────────────── */

/** 测试面：只给 scripts/ 里的冒烟用，不是公共 API。 */
export const __festivalTest = {
  normalizeFestivalDate,
  festivalRootDir,
  festivalImageDir,
  festivalFilePath,
  readFestivalRecord,
  readFestivalList,
  writeFestivalRecord,
  cleanupFestivalFiles,
  hasFestivalFor,
  festivalTodayPayload,
  resolveChatModel,
  parseFestivalJson,
  imageQueriesOf,
  imageSizeOf,
  normalizeBaiduCandidates,
  rankBaiduCandidates,
  candidateScore,
  imageTitleBlocked,
  imageHostBlocked,
  imageAspectOk,
  sourceDisplayName,
  searchBaiduImages,
  pickFestivalImage,
  generateModelImage,
  readModelCapabilities,
  providerProfile,
  resolveCredential,
  splitModelKey,
  mergeSignals,
  isFestivalGenerating: () => generating,
}
