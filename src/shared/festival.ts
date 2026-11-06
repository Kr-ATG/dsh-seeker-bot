/**
 * dsh-seeker-bot — 节日卡（Festival Card）的**两端共享契约**。
 *
 * 这是胶囊上方第二类斜插卡片的唯一数据模型：
 *   · 宿主半身用它计算「窗口内还有什么节气 / 节日」、生成文案、抓图落盘；
 *   · 浏览器半身用它渲染半截标签、倒计时与展开后的左图右文大卡。
 *
 * 本文件只放**类型、常量、日期计算、提示词与纯函数**：两端都要 import，
 * 不能出现 node:/DOM 依赖，也不能有任何副作用。
 *
 * ## 与「每日情报卡」的区别
 *
 *   情报卡：每天一张，内容是当天外部世界的新闻（AI / 世界 / 国内），来源是 RSS。
 *   节日卡：按**节气 / 节日**触发，提前几天出现在胶囊上沿，内容是「这个节气
 *           吃什么、做什么、有什么讲究」，并配一张由生图模型现画的图。
 *
 * 两者共用「斜插小标签 + 从屏幕正中划出的期刊式大卡」这套交互语言，但数据
 * 互不相干：节日卡没有 entry 列表，只有一张「左图右文」的生活卡片。
 *
 * ## 日期表口径
 *
 * 节气日期不是「每年固定」的，所以按年内置 2026 / 2027 两年（来源：紫金山
 * 天文台口径的公开节气表）。表缺年份时只返回固定公历节日，不猜、不估算
 * ——错一天的节日卡比没有卡更糟。
 */

import {
  FIXED_FESTIVAL_PROFILES,
  SOLAR_TERM_PROFILES,
  type FixedFestivalProfile,
  type SolarTermProfile,
} from './festival-data.ts'

/* ───────────────────────────── 数据模型 ───────────────────────────── */

/** 节日类型：二十四节气 or 固定公历节日。 */
export type FestivalKind = 'solar-term' | 'festival'

/** 一个带日期的节气 / 节日条目。 */
export interface FestivalEntry {
  /** 稳定 id，如 lidong。 */
  id: string
  /** 名称，如「立冬」。 */
  name: string
  kind: FestivalKind
  /** 公历日期 YYYY-MM-DD。 */
  date: string
  season: 'spring' | 'summer' | 'autumn' | 'winter'
  imagery: string
  blurb: string
  customs: string[]
  foods: string[]
}

/** 卡片里的一条「标签 + 内容」（如「北方 · 吃饺子」）。 */
export interface FestivalFact {
  /** 2–6 字小标签。 */
  label: string
  /** 4–24 字内容。 */
  value: string
}

/** 卡片配图（宿主落盘后回填给前端）。 */
export interface FestivalImage {
  /** 前端可直接放进 img.src 的同源 URL。 */
  url: string
  /** 仅宿主使用：图片在 festivals/images/ 下的文件名（前端忽略）。 */
  file?: string
  /** 图注（图片原始标题 / 来源说明）。 */
  caption?: string
  /** 来源站点展示名（如「百家号」）。 */
  source?: string
  /** 来源页面 URL（可选，前端不强制外链）。 */
  sourceUrl?: string
  width?: number
  height?: number
}

/** 一张节日卡。 */
export interface FestivalCard {
  /** 稳定 id：festivalDate-festivalId。 */
  id: string
  festivalId: string
  /** 节日日期 YYYY-MM-DD（前端据此算「今天 / 明天 / 还有 N 天」）。 */
  festivalDate: string
  /** 节日名，如「立冬」。 */
  name: string
  kind: FestivalKind
  /** 大标题：10–40 字，具体、有生活细节。 */
  title: string
  /** 导语：40–160 字，写吃什么、做什么、南北差异。 */
  lede: string
  /** 2–3 条「标签 + 内容」。 */
  facts: FestivalFact[]
  /** 配图；抓图失败时为 null，前端用节气大字占位。 */
  image: FestivalImage | null
}

/** 某个节日的节日卡记录（一个节日一份，文件按 festivalDate 命名）。 */
export interface FestivalRecord {
  /** 生成日期 YYYY-MM-DD。 */
  date: string
  /** 生成日期展示串，如 11 月 5 日 · 周四。 */
  dateLabel: string
  /** 这张卡对应的节日日期 YYYY-MM-DD。 */
  festivalDate: string
  generatedAt: number
  /** 1–2 张卡（通常一张；两个节日挨得很近时最多两张）。 */
  cards: FestivalCard[]
  /** 实际使用的模型（provider/model）；无模型时省略。 */
  model?: string
  /** 生成耗时（ms）。 */
  elapsedMs?: number
  /** model = 模型撰写；fallback = 模型不可用时按内置资料兜底。 */
  origin: 'model' | 'fallback'
}

/** 下一个即将到来的节日（空态标签用）。 */
export interface FestivalNext {
  festivalId: string
  name: string
  festivalDate: string
  /** 展示日期，如 2026 年 11 月 7 日，周六。 */
  dateLabel: string
  /** 「今天 / 明天 / 还有三天」。 */
  countdown: string
}

/** GET /api/dsh-done-pill/festival/today 的回包。 */
export interface FestivalTodayResponse {
  ok: boolean
  record: FestivalRecord | null
  /** 窗口内最近的下一个节日；没有时 null。 */
  next: FestivalNext | null
  /** 宿主此刻是否正在生成。 */
  generating?: boolean
  /** 最近一次失败的中文原因。 */
  error?: string
  hasToday?: boolean
}

/** POST /api/dsh-done-pill/festival/generate 的请求体。 */
export interface GenerateFestivalRequest {
  /** YYYY-MM-DD；缺省今天（本地时区），测试可注入。 */
  date?: string
  /** true = 已有记录也重新生成（换文案 + 换图）。 */
  force?: boolean
}

/** 生成结果。失败时 error 是给用户看的中文短句。 */
export interface GenerateFestivalResult {
  ok: boolean
  record?: FestivalRecord
  error?: string
}

/* ───────────────────────────── 常量 ───────────────────────────── */

/** 落盘目录名：<DSH_HOME>/storages/dsh-seeker-bot/done-pill/festivals/。 */
export const FESTIVAL_DIR_NAME = 'festivals'

/** 图片子目录名（与 json 同属 festivals 目录）。 */
export const FESTIVAL_IMAGE_DIR = 'images'

/** 路由前缀。 */
export const FESTIVAL_ROUTE = '/api/dsh-done-pill/festival'

/** 图片路由前缀（/image/<festivalDate>）。 */
export const FESTIVAL_IMAGE_ROUTE = '/api/dsh-done-pill/festival/image'

/**
 * 提前多少天开始在胶囊上出现。
 *
 * 用户 2026-11-05 明确要求「前三天」：太早出现会连续十来天占着胶囊上沿，
 * 而且生图成本按天算——提前 3 天开始，节日当天仍在窗口内。
 */
export const FESTIVAL_WINDOW_DAYS = 3

/** 一张记录最多几张卡。 */
export const FESTIVAL_MAX_CARDS = 2

/** 生成总超时（ms）：模型写文案 + 生图共用一个 AbortController。 */
export const FESTIVAL_TIMEOUT_MS = 240_000

/** 生图单次超时（ms）：生图模型比聊天模型慢，但要给总超时留余量。 */
export const FESTIVAL_IMAGE_GEN_TIMEOUT_MS = 180_000

/** 单张图片下载超时（ms）。 */
export const FESTIVAL_IMAGE_DOWNLOAD_TIMEOUT_MS = 20_000

/* ───────────────────────────── 节气日期表 ───────────────────────────── */

/**
 * 2026 / 2027 二十四节气公历日期表（值：MM-DD）。
 *
 * 口径：北京时间。来源为公开的紫金山天文台节气表（2026 年立冬 11 月 7 日
 * 17:52，与用户参考图一致）。不要用「每年差不多」去推别的年份：节气在
 * 公历上会前后浮动一两天，猜错会直接给用户一张错误的卡。
 */
export const SOLAR_TERM_DATES: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  2026: {
    xiaohan: '01-05',
    dahan: '01-20',
    lichun: '02-04',
    yushui: '02-18',
    jingzhe: '03-05',
    chunfen: '03-20',
    qingming: '04-05',
    guyu: '04-20',
    lixia: '05-05',
    xiaoman: '05-21',
    mangzhong: '06-05',
    xiazhi: '06-21',
    xiaoshu: '07-07',
    dashu: '07-23',
    liqiu: '08-07',
    chushu: '08-23',
    bailu: '09-07',
    qiufen: '09-23',
    hanlu: '10-08',
    shuangjiang: '10-23',
    lidong: '11-07',
    xiaoxue: '11-22',
    daxue: '12-07',
    dongzhi: '12-22',
  },
  2027: {
    xiaohan: '01-05',
    dahan: '01-20',
    lichun: '02-04',
    yushui: '02-19',
    jingzhe: '03-06',
    chunfen: '03-21',
    qingming: '04-05',
    guyu: '04-20',
    lixia: '05-06',
    xiaoman: '05-21',
    mangzhong: '06-06',
    xiazhi: '06-21',
    xiaoshu: '07-07',
    dashu: '07-23',
    liqiu: '08-08',
    chushu: '08-23',
    bailu: '09-08',
    qiufen: '09-23',
    hanlu: '10-08',
    shuangjiang: '10-23',
    lidong: '11-07',
    xiaoxue: '11-22',
    daxue: '12-07',
    dongzhi: '12-22',
  },
}

/* ───────────────────────────── 日期工具 ───────────────────────────── */

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本地时区的日期键（YYYY-MM-DD）；用 toISOString 会在 UTC+8 的凌晨算成昨天。 */
export function festivalDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

/** 解析 YYYY-MM-DD 成本地正午（避免 UTC 切日）。非法输入退回今天正午。 */
export function parseFestivalDate(date: string): Date {
  const parsed = new Date(date + 'T12:00:00')
  return Number.isNaN(parsed.getTime()) ? new Date(new Date().setHours(12, 0, 0, 0)) : parsed
}

/** 展示日期：2026 年 11 月 7 日，周六。 */
export function festivalDateLabel(date: string): string {
  const parsed = parseFestivalDate(date)
  return parsed.getFullYear() + ' 年 ' + (parsed.getMonth() + 1) + ' 月 ' + parsed.getDate() + ' 日，' + (WEEKDAY_LABELS[parsed.getDay()] ?? '')
}

/** 短日期：11 月 7 日 · 周六。 */
export function festivalDateShort(date: string): string {
  const parsed = parseFestivalDate(date)
  return (parsed.getMonth() + 1) + ' 月 ' + parsed.getDate() + ' 日 · ' + (WEEKDAY_LABELS[parsed.getDay()] ?? '')
}

/** 两个日期之间相差几天（本地正午口径，自然日）。 */
export function festivalDayDiff(from: Date, to: string): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12, 0, 0, 0)
  const end = parseFestivalDate(to)
  return Math.round((end.getTime() - start.getTime()) / 86_400_000)
}

const CHINESE_NUMBERS = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十']

/** 倒计时：今天 / 明天 / 还有三天（0–10 天用中文数字，超出用阿拉伯数字）。 */
export function festivalCountdownLabel(date: string, today: Date = new Date()): string {
  const diff = festivalDayDiff(today, date)
  if (diff <= 0) return '今天'
  if (diff === 1) return '明天'
  if (diff <= 10) return '还有' + (CHINESE_NUMBERS[diff] ?? String(diff)) + '天'
  return '还有 ' + String(diff) + ' 天'
}

/** 卡片顶部眉标：立冬 · 还有三天。 */
export function festivalKicker(entry: Pick<FestivalEntry, 'name' | 'date'>, today: Date = new Date()): string {
  return entry.name + ' · ' + festivalCountdownLabel(entry.date, today)
}

/* ───────────────────────────── 目录与窗口 ───────────────────────────── */

function entryOfSolarTerm(profile: SolarTermProfile, year: number, monthDay: string): FestivalEntry {
  return {
    id: profile.id,
    name: profile.name,
    kind: 'solar-term',
    date: String(year) + '-' + monthDay,
    season: profile.season,
    imagery: profile.imagery,
    blurb: profile.blurb,
    customs: [...profile.customs],
    foods: [...profile.foods],
  }
}

function entryOfFixedFestival(profile: FixedFestivalProfile, year: number): FestivalEntry {
  const month = String(profile.month).padStart(2, '0')
  const day = String(profile.day).padStart(2, '0')
  return {
    id: profile.id,
    name: profile.name,
    kind: 'festival',
    date: String(year) + '-' + month + '-' + day,
    season: fixedSeason(profile.month),
    imagery: profile.imagery,
    blurb: profile.blurb,
    customs: [...profile.customs],
    foods: [...profile.foods],
  }
}

/** 公历节日按月份归季（只用于卡片配色，不参与日期）。 */
function fixedSeason(month: number): FestivalEntry['season'] {
  if (month >= 3 && month <= 5) return 'spring'
  if (month >= 6 && month <= 8) return 'summer'
  if (month >= 9 && month <= 11) return 'autumn'
  return 'winter'
}

/**
 * 某年的全部节日 / 节气，按日期升序。
 *
 * 节气年份表缺失时只返回固定公历节日（不会用估算补节气）。
 */
export function festivalCatalog(year: number): FestivalEntry[] {
  const entries: FestivalEntry[] = []
  const profileById = new Map(SOLAR_TERM_PROFILES.map(profile => [profile.id, profile]))
  const termDates = SOLAR_TERM_DATES[year]
  if (termDates !== undefined) {
    for (const [id, monthDay] of Object.entries(termDates)) {
      const profile = profileById.get(id)
      if (profile !== undefined) entries.push(entryOfSolarTerm(profile, year, monthDay))
    }
  }
  for (const profile of FIXED_FESTIVAL_PROFILES) entries.push(entryOfFixedFestival(profile, year))
  entries.sort((a, b) => a.date.localeCompare(b.date))
  return entries
}

/**
 * 从 from 当天起、往后 withinDays 天内（含今天与最后一天）的节日，按日期升序。
 *
 * 跨年：12 月底查窗口时会自动把下一年的目录并进来（若下一年有节气表）。
 * 表缺下一年时只并固定节日（元旦），不会因为缺表就抛错。
 */
export function upcomingFestivals(from: Date = new Date(), withinDays = FESTIVAL_WINDOW_DAYS): FestivalEntry[] {
  const year = from.getFullYear()
  const catalogs = [...festivalCatalog(year), ...festivalCatalog(year + 1)]
  const seen = new Set<string>()
  const result: FestivalEntry[] = []
  for (const entry of catalogs) {
    const key = entry.kind + ':' + entry.id + ':' + entry.date
    if (seen.has(key)) continue
    seen.add(key)
    const diff = festivalDayDiff(from, entry.date)
    if (diff < 0 || diff > withinDays) continue
    result.push(entry)
  }
  result.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  return result
}

/** 下一个节日的轻量描述（空态标签 / 手动生成前置提示用）。 */
export function festivalNextOf(entry: FestivalEntry, today: Date = new Date()): FestivalNext {
  return {
    festivalId: entry.id,
    name: entry.name,
    festivalDate: entry.date,
    dateLabel: festivalDateLabel(entry.date),
    countdown: festivalCountdownLabel(entry.date, today),
  }
}

/* ───────────────────────────── 配图提示词 ───────────────────────────── */

/**
 * 生成节日卡配图的提示词（生图模型优先）。
 *
 * 配图**只走生图模型**：把节气名、应季食物、习俗与意象写进同一段提示词，
 * 画面才可控（网上按关键词搜图会搜回生羊肉 / 食材拼图）。竖幅是因为大卡左栏
 * 是 46% 宽、560px 高的竖图（1024×1536 正好）。
 *
 * 水印：主流生图模型常带自己的水印，提示词里明确写「不要文字 / 水印 / logo」，
 * 效果因模型而异；卡片底部有一条渐变图注，能盖住靠近底边的水印。
 */
export function festivalImagePrompt(entry: FestivalEntry): string {
  return [
    '写实的中式生活摄影：' + entry.name + '时节的应景画面。',
    '主体：' + entry.foods.slice(0, 2).join('、') + '。',
    '场景透出「' + entry.customs.slice(0, 2).join('、') + '」的日常气息；意境：' + entry.imagery + '。',
    '暖色自然光，浅景深，旧木桌或中式厨房，细节真实，质感像杂志内页的节气美食摄影。',
    '竖幅构图；画面中不要出现任何文字、水印、logo、边框、二维码。',
  ].join('')
}

/* ───────────────────────────── 提示词 ───────────────────────────── */

/**
 * 生成节日卡的 system 提示词。
 *
 * 核心约束：资料为准、只输出 JSON、写得像生活杂志而不是百科。
 * 参考用户给的样例：「立冬的羊肉汤，四川人最后涮的是豌豆尖」——标题要落到
 * 具体的食物、地域、场景，而不是「立冬到了，注意保暖」。
 */
export function festivalSystemPrompt(): string {
  return [
    '你是一位中文生活杂志的节气编辑，负责为用户写一张「节日卡」。',
    '你只能依据下面给出的【节气资料】写作：不得编造资料里没有的日期、习俗、食物或历史典故。',
    '',
    '写作要求：',
    '- 全部用简体中文，语气克制、具体、有生活气；不要客服腔，也不要百科腔。',
    '- title：12–26 个字，像杂志标题。必须落到具体的食物、器皿、地域或场景上（参考「立冬的羊肉汤，四川人最后涮的是豌豆尖」）；不要「XX 节气到了 / 注意保暖 / 万物复苏」这类空话。',
    '- lede：40–90 个字，写这个节气 / 节日这天吃什么、做什么、南北方有什么不同；可以有一句时令感受，但不要抒情过头。',
    '- facts：2–3 条 { label, value }。label 2–6 个字（如「北方」「南方」「此时」「老话说」），value 4–24 个字，必须来自资料。',
    '',
    '输出格式（硬要求）：',
    '- 只输出一个 JSON 对象，不要 markdown 代码围栏，不要解释、前言、后记。',
    '- 字段名严格使用：cards。cards 是数组（本次只写 1 项）。',
    '- 每项 { title, lede, facts }。facts 是数组，每项 { label, value }。',
    'JSON 形状：',
    '{"cards":[{"title":"","lede":"","facts":[{"label":"","value":""}]}]}',
  ].join('\n')
}

/** 组装节日卡生成的 user 提示词（节日资料 + 今天日期 + 只输出 JSON）。 */
export function buildFestivalUserPrompt(entry: FestivalEntry, today: Date = new Date()): string {
  return [
    '今天：' + festivalDateKey(today) + '（' + (WEEKDAY_LABELS[today.getDay()] ?? '') + '）',
    '即将到来的：' + entry.name + '（' + (entry.kind === 'solar-term' ? '二十四节气' : '节日') + '）',
    '日期：' + festivalDateLabel(entry.date) + '（' + festivalCountdownLabel(entry.date, today) + '）',
    '',
    '【节气资料】',
    '名称：' + entry.name,
    '意象：' + entry.imagery,
    '释义：' + entry.blurb,
    '习俗：' + entry.customs.join('、'),
    '应季食物：' + entry.foods.join('、'),
    '',
    '请按 system 里的规格写 1 张卡，只输出 JSON。',
  ].join('\n')
}

/* ───────────────────────────── 清洗 ───────────────────────────── */

function textOf(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

function shortOf(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

function factsOf(value: unknown): FestivalFact[] {
  const list = Array.isArray(value) ? value : []
  const facts: FestivalFact[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = shortOf(record.label, 8)
    const content = textOf(record.value, 40)
    if (label === '' || content === '') continue
    facts.push({ label, value: content })
    if (facts.length >= 3) break
  }
  return facts
}

/**
 * 把模型输出清洗成一份合法的节日卡记录；没有合格卡片时返回 null。
 *
 * 图像字段留 null：图片由宿主半身在清洗后调用生图模型生成，再回填到记录里。
 */
export function sanitizeFestivalRecord(
  payload: unknown,
  meta: {
    entry: FestivalEntry
    origin: 'model' | 'fallback'
    model?: string
    elapsedMs?: number
    generatedAt?: number
    today?: Date
  },
): FestivalRecord | null {
  if (payload === null || typeof payload !== 'object') return null
  const rawCards = (payload as Record<string, unknown>).cards
  const list = Array.isArray(rawCards) ? rawCards : []
  const cards: FestivalCard[] = []
  for (const rawCard of list) {
    if (rawCard === null || typeof rawCard !== 'object') continue
    const card = rawCard as Record<string, unknown>
    const title = textOf(card.title, 60)
    if (title === '') continue
    cards.push({
      id: meta.entry.date + '-' + meta.entry.id,
      festivalId: meta.entry.id,
      festivalDate: meta.entry.date,
      name: meta.entry.name,
      kind: meta.entry.kind,
      title,
      lede: textOf(card.lede, 200),
      facts: factsOf(card.facts),
      image: null,
    })
    if (cards.length >= FESTIVAL_MAX_CARDS) break
  }
  if (cards.length === 0) return null
  const generatedAt = meta.generatedAt ?? Date.now()
  const today = meta.today ?? new Date()
  return {
    date: festivalDateKey(today),
    dateLabel: festivalDateShort(festivalDateKey(today)),
    festivalDate: meta.entry.date,
    generatedAt,
    cards,
    ...(meta.model !== undefined && meta.model !== '' ? { model: meta.model } : {}),
    ...(meta.elapsedMs !== undefined ? { elapsedMs: meta.elapsedMs } : {}),
    origin: meta.origin,
  }
}

/**
 * 模型不可用时的兜底卡：只用内置资料拼一张能读的卡。
 *
 * 这不是假成功：记录里 origin='fallback'，前端据此在卡上标「资料卡」，
 * 用户一眼能看出文案是资料拼的、不是模型写的。
 */
export function festivalFallbackCard(entry: FestivalEntry): FestivalCard {
  return {
    id: entry.date + '-' + entry.id,
    festivalId: entry.id,
    festivalDate: entry.date,
    name: entry.name,
    kind: entry.kind,
    title: entry.name + '，' + (entry.foods[0] ?? '应季而食'),
    lede: entry.blurb + (entry.customs.length > 0 ? '老话说，这天的讲究是「' + entry.customs.join('、') + '」。' : ''),
    facts: [
      { label: '时节', value: festivalDateLabel(entry.date) },
      ...(entry.foods.length > 0 ? [{ label: '吃什么', value: entry.foods.slice(0, 2).join('、') }] : []),
      ...(entry.customs.length > 0 ? [{ label: '做什么', value: entry.customs.slice(0, 2).join('、') }] : []),
    ],
    image: null,
  }
}

/** 一张卡的无障碍标签。 */
export function festivalCardAriaLabel(card: FestivalCard, today: Date = new Date()): string {
  return '节日卡：' + card.name + ' · ' + festivalCountdownLabel(card.festivalDate, today) + '，' + card.title
}
