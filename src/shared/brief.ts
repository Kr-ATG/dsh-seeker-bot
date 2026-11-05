/**
 * dsh-seeker-bot — 每日情报卡（Daily Brief）的**两端共享契约**。
 *
 * 这里是「对话完成胶囊上方那张斜插半截卡片」的数据模型唯一来源：
 *   · 宿主半身用它生成 / 落盘 / 调度简报（src/host/done-pill/brief.ts）；
 *   · 浏览器半身用它渲染斜插卡与展开态（src/client/done-pill/brief-card.tsx）。
 *
 * 本文件只放**类型、常量与纯函数**：两端都要 import，不能出现 node:/DOM 依赖，
 * 也不能有任何副作用（与 shared/journal.ts 同一约束）。
 *
 * ## 这个功能解决什么
 *
 * 用户要的是一张「每天自动换的日报卡」：内容必须与 AI 相关，或与世界 / 国内
 * 重大事件相关；来源不靠某个难找的 RSS，而是**宿主侧先联网搜索、再让模型整理**
 * （ctx.web.search + ctx.llm.stream）。于是这里的数据模型要能承载两种形态：
 *
 *   1. **斜插半截卡**（默认态）：只露 kicker + 大标题 + 导语的第一行；
 *   2. **展开态**：一张完整日报卡 = 栏目名 + 大标题 + 导语 + 3–5 条编号条目。
 *
 * 卡片的形态抄的是「杂志栏目」：kicker 是两段式栏目名（「AI · 前沿」），
 * 大标题是这一天的一个角度，条目是当天真正发生的事。模型只负责从搜索素材里
 * 挑与写，**不允许编造素材里没有的事实**——清洗层（sanitizeBriefRecord）兜底。
 *
 * ## 失败与降级
 *
 * 联网搜索不可用（没装搜索 provider / 全部失败）时**不伪造**：生成结果会带
 * `origin: 'model'`，前端据此在卡上标「未联网 · 模型知识」，让用户一眼看出
 * 这条消息的可信度与联网时不同。搜索成功则 origin 为 'web'，并带 sources 计数。
 */

/* ───────────────────────────── 数据模型 ───────────────────────────── */

/** 一条日报条目（图一右侧那种「01 标题 + 两行说明」）。 */
export interface BriefEntry {
  /** 1-based 序号；清洗层会重排，模型给乱序也没关系。 */
  order: number
  /** 条目标题：一句话说清发生了什么，8–28 字。 */
  title: string
  /** 条目说明：30–90 字，补充背景 / 影响。 */
  text: string
  /** 来源媒体名或域名（如「机器之心」「reuters.com」），可省略。 */
  source?: string
  /** 原文链接（来自搜索结果，必须是素材里真实出现过的 URL）。 */
  url?: string
  /** 领域标签：AI / 世界 / 国内（用于卡内小色标，可省略）。 */
  tag?: string
}

/**
 * 一张日报卡。
 *
 * 字段刻意与「期刊」区分开：期刊是**回顾个人当天**，情报卡是**展望外部世界**。
 * 两者共用同一套「卡片 + 编号条目」的视觉语言，但数据不共享（期刊有 mood /
 * quote / stats，情报卡只有 kicker / title / lede / entries）。
 */
export interface BriefCard {
  /** 稳定 id（`<date>-<序号>`），前端翻页与已读记忆按它索引。 */
  id: string
  /** 栏目名：两段式，用「·」分隔，如「AI · 前沿」「世界 · 要闻」「国内 · 动向」。 */
  kicker: string
  /** 大标题：给这一天一个角度，10–24 字，不要「XX 日报 / 汇总」这类公文后缀。 */
  title: string
  /** 导语：40–90 字，概括这张卡在讲什么。 */
  lede: string
  /** 3–5 条编号条目。 */
  entries: BriefEntry[]
  /** 主题色 id（可选，前端按它挑色标；缺省由前端按 index 轮换）。 */
  accent?: string
}

/** 一天的简报：1–2 张卡。 */
export interface BriefRecord {
  /** ISO 日期（本地时区），如 `2026-11-03`。 */
  date: string
  /** 展示日期，如 `11 月 3 日 · 周一`。 */
  dateLabel: string
  generatedAt: number
  /** 1–2 张卡；至少 1 张，否则这份简报视为无效。 */
  cards: BriefCard[]
  /** 实际使用的模型（provider/model）。 */
  model?: string
  /** 数据来源：web = 联网搜索 + 模型整理；model = 仅模型知识（未联网）。 */
  origin: 'web' | 'model'
  /** 本次搜索命中的来源条数（origin=model 时为 0）。 */
  sources: number
  /** 生成耗时（ms），前端「生成中」进度与日志用。 */
  elapsedMs?: number
  /** 生成时用的搜索查询（排障用，前端不渲染）。 */
  queries?: string[]
}

/* ───────────────────────────── 数据源 ───────────────────────────── */

/**
 * 一条抓取到的素材（RSS 条目或搜索结果，统一成同一形状）。
 *
 * `lane` 是它属于哪个栏目：AI / 世界 / 国内。模型据此把素材分到两张卡里，
 * 而不是自己猜「这条算 AI 还是算世界」。
 */
export interface BriefSourceItem {
  title: string
  url: string
  /** 摘要 / 正文前几行（已去 HTML 标签）。 */
  snippet?: string
  /** 发布时间（ISO 8601；源没给就省略）。 */
  publishedAt?: string
  /** 来源名（如「量子位」「BBC 中文」）。 */
  feed?: string
  lane: 'ai' | 'world' | 'china'
}

/** 一个 RSS 源。 */
export interface BriefFeed {
  id: string
  /** 展示名（卡片上的来源标注用）。 */
  label: string
  url: string
  lane: 'ai' | 'world' | 'china'
}

/**
 * 内置 RSS 源。
 *
 * ## 为什么是 RSS 而不是「只用搜索」
 *
 * 实测（2026-11-03）宿主搜索链对「今天的新闻」召回很差：中文日期查询返回的是
 * 2015 年招标公告、2024 年旧闻合集，真正当天的大事反而排不上。而新闻站的 RSS
 * 是**结构化、带 pubDate、每天滚动更新**的，一次抓取就能拿到 10–20 条真实标题，
 * 解析只需要几十行正则。
 *
 * 所以管线是「RSS 为主、搜索为辅」：
 *   1. 并行抓下面几个源（ctx.web.fetch，单源失败不影响别的）；
 *   2. 素材不足（< 6 条）时再用 briefQueries 走 ctx.web.search 补；
 *   3. 两路都空 → origin='model'，模型只用自身知识写，前端标「未联网」。
 *
 * 源的选择标准：**能稳定返回 RSS/Atom XML、覆盖中文或英文、更新频率高**。
 * 36氪 / 联合早报 / 机器之心的 feed 实测要么反爬（返回 HTML 验证页）要么 404，
 * 已剔除；将来加源只要往这个数组里塞一行，解析层不用改。
 */
export const BRIEF_FEEDS: readonly BriefFeed[] = [
  // ── 国外核心模型与产品首发源（聚焦 OpenAI / Claude / Gemini / Grok 及全球开源） ──
  { id: 'openai-news', label: 'OpenAI 官方', url: 'https://openai.com/news/rss.xml', lane: 'ai' },
  { id: 'techcrunch-ai', label: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', lane: 'ai' },
  { id: 'marktechpost', label: 'MarkTechPost AI', url: 'https://www.marktechpost.com/category/technology/artificial-intelligence/feed/', lane: 'ai' },
  { id: 'arstechnica-ai', label: 'Ars Technica AI', url: 'https://arstechnica.com/tag/ai/feed/', lane: 'ai' },
  { id: 'infoq-ai', label: 'InfoQ AI', url: 'https://www.infoq.cn/feed', lane: 'ai' },
  { id: 'qbitai', label: '量子位', url: 'https://www.qbitai.com/feed', lane: 'ai' },
  // ── 世界与重大要闻源 ──
  { id: 'bbc-zh', label: 'BBC 中文', url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml', lane: 'world' },
  { id: 'nyt-zh', label: '纽约时报中文网', url: 'https://cn.nytimes.com/rss/', lane: 'world' },
  { id: 'wsj-world', label: 'WSJ 世界', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', lane: 'world' },
]

/** 单个源最多取几条（防止一个源把素材撑爆）。 */
export const BRIEF_FEED_ITEMS = 6

/** 素材总量上限（拼进提示词前的硬上限）。 */
export const BRIEF_SOURCE_LIMIT = 48

/* ───────────────────────────── 宿主 → 前端 ───────────────────────────── */

/** `GET /api/dsh-done-pill/brief/today` 的回包。 */
export interface BriefTodayResponse {
  ok: boolean
  /** 今天的简报；还没生成时为 null（前端显示「整理中 / 点此生成」）。 */
  brief: BriefRecord | null
  /** 宿主此刻是否正在生成（前端据此显示骨架 + 转圈）。 */
  generating?: boolean
  /** 最近一次生成失败的中文原因（前端在空态里显示）。 */
  error?: string
  /** 当天是否已经生成过（调度去重口径与宿主一致）。 */
  hasToday?: boolean
}

/** `POST /api/dsh-done-pill/brief/generate` 的请求体（字段全可选）。 */
export interface GenerateBriefRequest {
  /** `YYYY-MM-DD`；缺省今天（本地时区）。 */
  date?: string
  /** true = 即使今天已有简报也重新生成（手动「换一批」）。 */
  force?: boolean
  /** 指定模型（缺省走宿主默认模型 / 注册表第一个）。 */
  model?: { provider?: string; model?: string; effort?: string }
  /** 覆盖搜索查询（测试与「换个角度」用）。 */
  queries?: string[]
}

/** 生成结果。失败时 error 是给用户看的中文短句，不是堆栈。 */
export interface GenerateBriefResult {
  ok: boolean
  brief?: BriefRecord
  error?: string
}

/* ───────────────────────────── 常量 ───────────────────────────── */

/** 每日简报的落盘目录名（宿主：`<DSH_HOME>/storages/dsh-seeker-bot/done-pill/briefs/`）。 */
export const BRIEF_DIR_NAME = 'briefs'

/** 一天的卡片数量上限（用户要「一个或两个」）。 */
export const BRIEF_MAX_CARDS = 2

/** 单张卡的条目数上下限。 */
export const BRIEF_MIN_ENTRIES = 3
export const BRIEF_MAX_ENTRIES = 5

/** 搜索查询条数上限（每条一次 ctx.web.search）。 */
export const BRIEF_MAX_QUERIES = 5

/** 搜索结果每条保留的最大字符数（拼进提示词前裁剪，防止素材把上下文撑爆）。 */
export const BRIEF_SNIPPET_LIMIT = 220

/** 生成超时（ms）：搜索 + 模型两段共用一个 AbortController。 */
export const BRIEF_TIMEOUT_MS = 150_000

/** 搜索单次超时（ms）：单条查询失败不拖垮整轮。 */
export const BRIEF_SEARCH_TIMEOUT_MS = 20_000

/* ───────────────────────────── 纯函数 ───────────────────────────── */

/** 本地时区的日期键（`YYYY-MM-DD`）。用 toISOString 会在 UTC+8 的 0–8 点算成昨天。 */
export function briefDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 展示日期：`11 月 3 日 · 周一`。非法输入退回原串。 */
export function briefDateLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return `${parsed.getMonth() + 1} 月 ${parsed.getDate()} 日 · ${WEEKDAY_LABELS[parsed.getDay()] ?? ''}`
}

/** 解析 `YYYY-MM-DD` 成本地正午的 Date（避免 UTC 切日差一天）。 */
export function parseBriefDate(date: string): Date {
  const parsed = new Date(`${date}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

/**
 * 搜索兜底查询。
 *
 * 只在 RSS 抓到的素材不足（< 6 条）时才走搜索。**不要指望它给出「今天的新闻」**：
 * 实测宿主搜索链对中文日期查询的召回很差（2026-11-03 实测返回 2015 年招标公告、
 * 2024 年旧闻合集）。查询写得更「新闻化」、少带具体日期，召回反而干净一点；
 * 真正保证时效的是 BRIEF_FEEDS 的 RSS（带 pubDate，可过滤）。
 */
export function briefQueries(date: Date): string[] {
  return [
    'OpenAI ChatGPT o1 o3 最新发布',
    'Claude Anthropic Sonnet 新模型',
    'Gemini Google xAI Grok 最新模型产品',
    '今日 世界 国内 重大要闻',
  ]
}

/** 把一条素材裁成提示词里的一段（栏目标记 + 标题 + 摘要 + URL，超长截断）。 */
export function briefSourceLine(source: {
  title?: string
  url: string
  snippet?: string
  summary?: string
  lane?: 'ai' | 'world' | 'china'
}): string {
  const title = String(source.title ?? '').trim() || source.url
  const body = String(source.summary ?? source.snippet ?? '').replace(/\s+/g, ' ').trim()
  const clipped = body.length > BRIEF_SNIPPET_LIMIT ? `${body.slice(0, BRIEF_SNIPPET_LIMIT)}…` : body
  const lane = source.lane === 'ai' ? '[AI] ' : source.lane === 'china' ? '[国内] ' : source.lane === 'world' ? '[世界] ' : ''
  return clipped === '' ? `- ${lane}${title}（${source.url}）` : `- ${lane}${title}：${clipped}（${source.url}）`
}

/* ───────────────────────────── RSS 解析 ───────────────────────────── */

/** 去掉 CDATA 包裹、HTML 标签与常见实体，压成一行纯文本。 */
function feedText(raw: string): string {
  let text = String(raw ?? '')
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  text = text.replace(/<[^>]*>/g, ' ')
  text = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&amp;/g, '&')
  return text.replace(/\s+/g, ' ').trim()
}

/** 取第一个匹配标签的内部文本（RSS 2.0 与 Atom 的标签名混着试）。 */
function feedTag(block: string, names: readonly string[]): string {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
    if (match !== null) return match[1]
  }
  return ''
}

/** 发布时间归一成 ISO 8601；解析不了就省略（不让假日期进素材）。 */
function feedIso(raw: string): string | undefined {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined
  const time = Date.parse(text)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/**
 * 解析一个 RSS 2.0 / Atom 源，提取条目。
 *
 * **绝不抛异常**：源站可能返回验证页、半截 XML、甚至 HTML 错误页。解析层只做
 * 「能提取就提取」，提取不到返回空数组，调用方据此降级到搜索。
 *
 * @param xml 源站返回的正文
 * @param feed 源定义（决定 lane 与展示名）
 * @param limit 最多取几条（默认 BRIEF_FEED_ITEMS）
 */
export function parseBriefFeed(xml: string, feed: BriefFeed, limit = BRIEF_FEED_ITEMS): BriefSourceItem[] {
  const source = String(xml ?? '')
  const blocks = source.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? []
  const items: BriefSourceItem[] = []
  for (const block of blocks) {
    if (items.length >= limit) break
    const title = feedText(feedTag(block, ['title']))
    if (title === '') continue
    // RSS 的 link 是文本节点；Atom 的是 <link href="…"/>（且可能多个，取第一个 http）
    let url = feedText(feedTag(block, ['link']))
    if (!/^https?:\/\//i.test(url)) {
      for (const match of block.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)) {
        if (/^https?:\/\//i.test(match[1])) { url = match[1]; break }
      }
    }
    if (!/^https?:\/\//i.test(url)) continue
    const snippet = feedText(feedTag(block, ['description', 'summary', 'content:encoded', 'content']))
    const publishedAt = feedIso(feedText(feedTag(block, ['pubDate', 'published', 'updated', 'dc:date'])))
    items.push({
      title,
      url: url.length > 500 ? url.slice(0, 500) : url,
      ...(snippet !== '' ? { snippet } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      feed: feed.label,
      lane: feed.lane,
    })
  }
  return items
}

/**
 * 素材是否落在最近 `days` 天内。
 *
 * 没有发布时间的一律保留（宁可多给模型几条，也不要因为源站缺字段就丢掉当天新闻）；
 * 有明确发布时间且过旧的才过滤——WSJ 这类源的 RSS 会混进几个月前的旧闻。
 */
export function briefSourceIsRecent(item: BriefSourceItem, days: number, now = Date.now()): boolean {
  if (item.publishedAt === undefined) return true
  const time = Date.parse(item.publishedAt)
  if (!Number.isFinite(time)) return true
  return now - time <= days * 86_400_000
}

/* ───────────────────────────── 提示词 ───────────────────────────── */

/**
 * 生成每日简报的 system 提示词。
 *
 * 核心约束三条：**只依据素材**、**只输出 JSON**、**两条线各一张卡**。
 * 其余是字段规格——模型不按规格写时清洗层会兜底，但兜底出来的卡「能渲染、
 * 不好看」，所以规格要写清楚。
 */
export function briefSystemPrompt(): string {
  return [
    '你是一位资深中文科技媒体的要闻编辑，负责为用户编写「每日情报卡」。',
    '你只能依据下面提供的【联网素材】写作：不得编造素材里没有的事实、数字、人名、时间或事件。',
    '素材不足以支撑某个栏目时，宁可少写条目，也不要补空话套话。',
    '',
    '栏目要求（必须两张卡，顺序固定）：',
    '1. 第一张卡讲 AI 前沿模型与产品：必须优先聚焦 OpenAI（GPT/o系列/ChatGPT）、Claude（Anthropic）、Gemini（Google）、Grok（xAI）等核心主流模型发布、重大产品功能升级与生态突破；若素材中有上述头部厂商的动态，必须优先采选为条目；kicker 用「AI · 模型」或「AI · 某某」；',
    '2. 第二张卡讲世界或国内重大事件：政治、经济、冲突、灾害、监管、社会事件均可，kicker 用「世界 · 某某」或「国内 · 某某」。',
    '',
    '写作要求：',
    '- 全部用简体中文（素材可能是繁体或英文，一律转写成简体中文），语气克制、具体，像一本真正的要闻周刊；不要客服腔，不要「首先 / 其次 / 综上」。',
    '- kicker：两段式栏目名，用「·」分隔，总长 4–10 字。',
    '- title：10–24 个字，给这一天一个角度；不要「XX 日报 / 汇总 / 盘点」这类公文后缀。',
    '- lede：40–90 字导语，说清这张卡在讲什么，不要重复条目内容。',
    '- entries：3–5 条，按重要性降序；每条 { title, text, source, url, tag }：',
    '  · title 8–28 字，一句话说清发生了什么；',
    '  · text 30–90 字，补充背景或影响；',
    '  · source 写来源媒体名或域名（必须来自素材）；url 必须逐字复制素材里的链接；',
    '  · tag 只能是「AI」「世界」「国内」之一。',
    '',
    '输出格式（硬要求）：',
    '- 只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释、前言、后记。',
    '- 字段名必须严格使用：cards。cards 是数组，每项 { kicker, title, lede, entries }。',
    '- 你回复的第一个字符就是 {，最后一个字符就是 }。',
    'JSON 形状：',
    '{"cards":[{"kicker":"","title":"","lede":"","entries":[{"title":"","text":"","source":"","url":"","tag":""}]}]}',
  ].join('\n')
}

/**
 * 组装简报生成的 user 提示词：日期 + 分栏素材 + 「请只输出 JSON」。
 *
 * 素材按 lane 分组列出（AI / 世界 / 国内），模型据此把条目分到两张卡里，
 * 不需要自己猜「这条算 AI 还是算世界」。
 *
 * @param sources 抓取 / 搜索到的素材；为空时提示词会说明「本次没有联网素材」，
 *   调用方据此把 origin 记成 'model'（模型只能用自身知识，前端会标注）。
 */
export function buildBriefUserPrompt(sources: ReadonlyArray<BriefSourceItem>, date: string): string {
  const lanes: Array<{ lane: 'ai' | 'world' | 'china'; label: string }> = [
    { lane: 'ai', label: 'AI 方向' },
    { lane: 'world', label: '世界方向' },
    { lane: 'china', label: '国内方向' },
  ]
  const groups = lanes
    .map(({ lane, label }) => {
      const items = sources.filter(source => source.lane === lane)
      return items.length === 0 ? '' : `— ${label}（${String(items.length)} 条）—\n${items.map(item => briefSourceLine(item)).join('\n')}`
    })
    .filter(group => group !== '')
  return [
    `日期：${date}（${briefDateLabel(date)}）`,
    '',
    sources.length === 0
      ? '【联网素材】\n（本次没有抓到任何联网素材。请只用你确定的事实写，宁可条目少，不要编造。）'
      : `【联网素材】共 ${String(sources.length)} 条：\n${groups.join('\n')}`,
    '',
    '注意：素材的发布时间可能不是今天，也可能混有旧闻。优先选与今天最接近、信息最新的一条；',
    '素材里没有明确日期时，条目正文不要写「今天 / 昨日」这类时间词。',
    '',
    '请只输出 JSON。',
  ].join('\n')
}

/* ───────────────────────────── 清洗 ───────────────────────────── */

function textOf(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 截断但保留「不补省略号」的场景（kicker / tag 这类短字段）。 */
function shortOf(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

/** 只接受 http(s) 链接；其它（javascript: / data: / 相对路径）一律丢弃。 */
function urlOf(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^https?:\/\//i.test(text)) return undefined
  return text.length > 500 ? text.slice(0, 500) : text
}

/**
 * 把模型输出清洗成一张合法卡片；不合格返回 null。
 *
 * **绝不抛异常**：模型输出不可控，任何字段都可能缺 / 类型错 / 超长。清洗层
 * 只保证「能渲染」，不做内容判断——内容是否成立由提示词约束 + 用户自己看。
 */
export function sanitizeBriefCard(raw: unknown, index: number, date: string): BriefCard | null {
  if (raw === null || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const kicker = shortOf(item.kicker, 16)
  const title = textOf(item.title, 40)
  const lede = textOf(item.lede, 160)
  if (title === '') return null

  const rawEntries = Array.isArray(item.entries) ? item.entries : []
  const entries: BriefEntry[] = []
  for (const entryRaw of rawEntries) {
    if (entryRaw === null || typeof entryRaw !== 'object') continue
    const entry = entryRaw as Record<string, unknown>
    const entryTitle = textOf(entry.title, 60)
    if (entryTitle === '') continue
    const tagRaw = shortOf(entry.tag, 8)
    const tag = tagRaw === 'AI' || tagRaw === '世界' || tagRaw === '国内' ? tagRaw : undefined
    entries.push({
      order: entries.length + 1,
      title: entryTitle,
      text: textOf(entry.text, 240),
      ...(shortOf(entry.source, 40) !== '' ? { source: shortOf(entry.source, 40) } : {}),
      ...(urlOf(entry.url) !== undefined ? { url: urlOf(entry.url) as string } : {}),
      ...(tag !== undefined ? { tag } : {}),
    })
    if (entries.length >= BRIEF_MAX_ENTRIES) break
  }
  if (entries.length < BRIEF_MIN_ENTRIES) return null

  return {
    id: `${date}-${String(index + 1)}`,
    kicker: kicker === '' ? (index === 0 ? 'AI · 前沿' : '世界 · 要闻') : kicker,
    title,
    lede,
    entries,
    ...(shortOf(item.accent, 16) !== '' ? { accent: shortOf(item.accent, 16) } : {}),
  }
}

/**
 * 把模型输出清洗成一份简报；没有任何合格卡片时返回 null。
 *
 * @param meta 宿主补齐的字段（日期 / 模型 / 来源类型 / 耗时 / 查询）。
 */
export function sanitizeBriefRecord(
  payload: unknown,
  meta: {
    date: string
    model?: string
    origin: 'web' | 'model'
    sources: number
    elapsedMs?: number
    queries?: string[]
    generatedAt?: number
  },
): BriefRecord | null {
  if (payload === null || typeof payload !== 'object') return null
  const rawCards = (payload as Record<string, unknown>).cards
  const list = Array.isArray(rawCards) ? rawCards : []
  const cards: BriefCard[] = []
  for (const rawCard of list) {
    const card = sanitizeBriefCard(rawCard, cards.length, meta.date)
    if (card === null) continue
    cards.push(card)
    if (cards.length >= BRIEF_MAX_CARDS) break
  }
  if (cards.length === 0) return null
  return {
    date: meta.date,
    dateLabel: briefDateLabel(meta.date),
    generatedAt: meta.generatedAt ?? Date.now(),
    cards,
    origin: meta.origin,
    sources: Math.max(0, Math.round(meta.sources)),
    ...(meta.model !== undefined && meta.model !== '' ? { model: meta.model } : {}),
    ...(meta.elapsedMs !== undefined ? { elapsedMs: meta.elapsedMs } : {}),
    ...(meta.queries !== undefined && meta.queries.length > 0 ? { queries: meta.queries } : {}),
  }
}

/** 一张卡的话题提示词：把卡里的条目整理成一段可发给模型的话。 */
export function briefCardChatPrompt(card: BriefCard): string {
  const lines = card.entries.map(entry => `${String(entry.order)}. ${entry.title}${entry.source !== undefined ? `（${entry.source}）` : ''}`)
  return [
    `我看到一张「${card.kicker}」情报卡，标题是「${card.title}」。`,
    card.lede,
    '',
    '里面的几条是：',
    ...lines,
    '',
    '请帮我挑最值得关注的一条展开讲讲：它为什么重要、对我意味着什么，如果我有兴趣可以怎么跟进。',
  ].join('\n')
}

/** 卡片的无障碍标签（斜插半截卡只露半截，读屏要靠它）。 */
export function briefCardAriaLabel(card: BriefCard): string {
  return `情报卡：${card.kicker} · ${card.title}，共 ${String(card.entries.length)} 条`
}
