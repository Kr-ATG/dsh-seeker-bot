/**
 * Personal Agent — Pages（可回访的持久页面）。
 *
 * ## 为什么需要它
 *
 * 对话里的 ```html / ```iu 卡片是**消息内、一次性**的：刷新、翻页、换设备之后
 * 就找不回来了。而 Bot 真正有价值的产出（周报、看板、追踪器）需要能回访、
 * 能更新、能分享——这就是 Pages 这一层（路线图 3.1）。
 *
 * 两层分工不能互相替代：
 *   · 消息内卡片 = 即时交互（点一下、看一眼）；
 *   · Pages      = 权威副本（随时打开，旧卡可以标「已更新到最新版」）。
 *
 * ## 存储
 *
 * 复用产出物目录，不新开根目录（路线图 5.2 的约定）：
 *
 *   <botWorkspaceDir>/产出物/<botFolder>/网页/<slug>.html
 *   <botWorkspaceDir>/产出物/<botFolder>/网页/<slug>.meta.json
 *
 * `<botFolder>` 由 `outputs.ts` 的 `ensureBotOutputDirs` 统一分配（如「小析」），
 * 映射落在 `bot-output-dirs.json`。这样 Pages 与其它产出物出现在同一个工作台、
 * 同一套扫描链路里（`.html` 已映射成 `page` 类型）。
 *
 * ## 为什么不直接给一个 `/file?path=...html` 的 URL
 *
 * 同源 `text/html` 会在宿主 origin 下执行任意脚本，等于给 Bot 生成的页面开了
 * 一条通往宿主 API 的路。所以这里**只返回内容**（`readPage`），由前端用
 * `sandbox` iframe 渲染——沙箱属性是渲染方必须承担的边界，不能靠 host 假装安全。
 *
 * ## meta 字段
 *
 * `{ slug, title, createdAt, updatedAt, version, sourceMessageId?, share, bytes }`
 *
 * · `version` 每次写入 +1（首次为 1），前端据此判断「消息里那张卡是不是旧版」；
 * · `sourceMessageId` 记录是哪条 Bot 消息生成了这个页面；
 * · `share` 目前只是状态位（`private` / `shared`），分享链接的发放由后续实现，
 *   这里先把状态落盘，避免以后改存储格式。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { botOutputDirsOf, ensureBotOutputDirs } from './outputs.ts'

/** 页面 HTML 的字节上限：报告 / 看板这个量级足够，防止一次写入把磁盘写爆。 */
const MAX_PAGE_BYTES = 2 * 1024 * 1024

/** 标题长度上限（meta 与列表都要展示，太长会挤爆卡片）。 */
const MAX_TITLE_LENGTH = 120

/** 来源消息 id 的长度上限（防脏数据）。 */
const MAX_SOURCE_MESSAGE_ID_LENGTH = 120

/** 分享状态。 */
export type PageShareState = 'private' | 'shared'

/** 页面元数据（与 `<slug>.meta.json` 逐字对应）。 */
export interface PageMeta {
  slug: string
  title: string
  createdAt: number
  updatedAt: number
  /** 版本号：每次 `writePage` 更新 +1，首次为 1。 */
  version: number
  /** 来源消息 id（哪条 Bot 消息生成了这个页面）。 */
  sourceMessageId?: string
  /** 分享状态（目前只存状态，分享链接由后续实现）。 */
  share: PageShareState
  /** HTML 字节数（列表直接展示，避免前端再读一次文件）。 */
  bytes: number
}

/** 单页（meta + 正文）。 */
export interface PageRecord {
  meta: PageMeta
  html: string
}

/** 列表项：与 meta 同构，单独起名是为了让调用方明确「这里没有 html」。 */
export type PageSummary = PageMeta

/** `writePage` 的失败原因（路由据此决定 400 / 500）。 */
export type PageWriteError =
  | 'invalid-slug'
  | 'invalid-title'
  | 'invalid-html'
  | 'too-large'
  | 'write-failed'

/** `writePage` 的结果：成功给 meta，失败给可读原因。 */
export type PageWriteResult =
  | { ok: true; meta: PageMeta }
  | { ok: false; error: PageWriteError; message: string }

/** 写入 / 更新一页的入参。 */
export interface WritePageInput {
  /** 缺省时由标题生成（中文标题生成不出 ASCII 时用 `page-<时间戳>`）。 */
  slug?: string
  title: string
  html: string
  sourceMessageId?: string
  share?: PageShareState
}

/**
 * slug 白名单：只允许 `[a-z0-9-]`，且不能以连字符开头。
 *
 * 严格到「一个字符都不放松」是有意的：slug 直接参与文件名拼接，任何 `.`、`/`、
 * `\`、`%` 都可能变成路径穿越或编码歧义的入口。`[a-z0-9-]` 之外一律拒绝，
 * 后面的 `resolve + startsWith` 只是双保险。
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(slug ?? ''))
}

/**
 * 某个 Bot 的 Pages 目录。
 *
 * 调用 `ensureBotOutputDirs` 会顺带补建 9 个分类目录（幂等），所以第一次访问
 * Pages 时目录一定存在，不用调用方各自 mkdir。
 */
export function pagesDir(botId: string): string {
  const id = String(botId ?? '').trim()
  if (id === '') throw new Error('botId required')
  const dirs = ensureBotOutputDirs(id)
  return join(dirs.root, '网页')
}

/**
 * 只读的 Pages 目录：**不创建、不分配**，目录不存在时返回 `undefined`。
 *
 * 读接口（{@link listPages} / {@link readPage}）必须用它。走 `pagesDir` 的话，
 * 一个「列出页面」的请求会顺带调 `ensureBotOutputDirs`——给一个已删除的 Bot
 * 重新分配文件夹、建 9 个分类目录、写回映射，删了等于没删（实测踩过）。
 *
 * 写路径（{@link writePage}）仍然用 `pagesDir`：那次调用本来就要建目录。
 */
export function pagesDirIfExists(botId: string): string | undefined {
  const dirs = botOutputDirsOf(botId)
  if (dirs === undefined) return undefined
  const dir = join(dirs.root, '网页')
  return existsSync(dir) ? dir : undefined
}

/** 某页的 html 绝对路径（已过 slug 白名单，仅供诊断 / 测试）。 */
export function pageHtmlPath(botId: string, slug: string): string {
  return join(pagesDir(botId), `${slug}.html`)
}

/** 某页的 meta 绝对路径（同上）。 */
export function pageMetaPath(botId: string, slug: string): string {
  return join(pagesDir(botId), `${slug}.meta.json`)
}

/**
 * 由标题生成 slug。
 *
 * 中文标题 ASCII 化之后是空串——这是常态而不是异常（Bot 的产出标题大多是中文）。
 * 兜底用**标题的短 hash** 而不是时间戳：
 * · 同一标题两次写入会得到同一个 base，`uniqueSlug` 能按 `-2`、`-3` 加序号
 *   （用户看到的是「周报」「周报-2」这种可理解的命名）；
 * · 时间戳兜底会让「同标题新建」每次都变成一串看不懂的随机 id。
 *
 * 真正决定可读性的是 meta.title，slug 只承担「稳定、可做 URL」的职责。
 */
export function slugifyTitle(title: string): string {
  const ascii = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  if (ascii !== '') return ascii
  const digest = createHash('sha1').update(String(title ?? '')).digest('hex').slice(0, 8)
  return `page-${digest}`
}

/** 自动生成的 slug 撞车时加序号（明确传 slug 的走覆盖更新，不加序号）。 */
function uniqueSlug(dir: string, base: string): string {
  let candidate = base
  for (let index = 2; index <= 99; index += 1) {
    if (!existsSync(join(dir, `${candidate}.html`)) && !existsSync(join(dir, `${candidate}.meta.json`))) {
      return candidate
    }
    candidate = `${base}-${index}`
  }
  // 循环结束后 candidate 是 base-99：它也要检查，否则第 100 个同名页会掉进
  // 时间戳兜底（虽然几乎不会撞，但「兜底也可能撞」不该成为覆盖已有页的入口）
  if (!existsSync(join(dir, `${candidate}.html`)) && !existsSync(join(dir, `${candidate}.meta.json`))) {
    return candidate
  }
  // 极端情况（99 个同名页）：退化成带时间戳的 slug，绝不覆盖已有页面
  return `${base}-${Date.now().toString(36)}`
}

/** 把任意 JSON 收敛成合法 meta；字段缺失 / 类型不对时返回 null（由调用方兜底）。 */
function normalizeMeta(raw: unknown, slug: string): PageMeta | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, MAX_TITLE_LENGTH) : ''
  if (title === '') return null
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt
  const version = typeof record.version === 'number' && Number.isFinite(record.version) ? Math.max(1, Math.round(record.version)) : 1
  const bytes = typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? Math.max(0, Math.round(record.bytes)) : 0
  const share: PageShareState = record.share === 'shared' ? 'shared' : 'private'
  const sourceMessageId = typeof record.sourceMessageId === 'string' && record.sourceMessageId.trim() !== ''
    ? record.sourceMessageId.trim().slice(0, MAX_SOURCE_MESSAGE_ID_LENGTH)
    : undefined
  return {
    slug,
    title,
    createdAt,
    updatedAt,
    version,
    ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
    share,
    bytes,
  }
}

/** 读一页的 meta；文件不存在 / 坏数据返回 null（不抛，列表里跳过这一页）。 */
function readMeta(dir: string, slug: string): PageMeta | null {
  try {
    const file = join(dir, `${slug}.meta.json`)
    if (!existsSync(file)) return null
    return normalizeMeta(JSON.parse(readFileSync(file, 'utf8')), slug)
  } catch {
    return null
  }
}

/**
 * 没有 meta 的 html 兜底合成一份。
 *
 * 用户（或 Bot 的其它工具）可能直接把 html 丢进「网页」目录——这些文件也应该
 * 出现在 Pages 列表里，否则「产出物工作台」和「Pages」会各显示一半。兜底值取
 * 文件系统时间戳，version 固定 1（没有版本历史可言）。
 */
function synthesizeMeta(dir: string, slug: string): PageMeta {
  let createdAt = Date.now()
  let bytes = 0
  try {
    const info = statSync(join(dir, `${slug}.html`))
    createdAt = info.mtimeMs
    bytes = info.size
  } catch {
    /* 文件在扫描与 stat 之间被删：用当前时间兜底 */
  }
  return {
    slug,
    title: slug,
    createdAt,
    updatedAt: createdAt,
    version: 1,
    share: 'private',
    bytes,
  }
}

/**
 * 列出某个 Bot 的全部页面（按更新时间倒序）。
 *
 * 只认 `<slug>.html` + 合法 slug：`网页` 目录里可能有 Bot 随手写的临时文件，
 * 名字带空格 / 中文的不进 Pages（它们仍然会出现在产出物扫描里）。
 */
export function listPages(botId: string): PageSummary[] {
  const dir = pagesDirIfExists(botId)
  if (dir === undefined) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const pages: PageSummary[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.html')) continue
    const slug = name.slice(0, -'.html'.length)
    if (!isValidSlug(slug)) continue
    pages.push(readMeta(dir, slug) ?? synthesizeMeta(dir, slug))
  }
  pages.sort((a, b) => b.updatedAt - a.updatedAt)
  return pages
}

/**
 * 读一页（meta + html）。
 *
 * @returns 页面不存在 / slug 非法时返回 null（路由回 404）。
 */
export function readPage(botId: string, slug: string): PageRecord | null {
  if (!isValidSlug(slug)) return null
  const dir = pagesDirIfExists(botId)
  if (dir === undefined) return null
  const file = join(dir, `${slug}.html`)
  if (!existsSync(file)) return null
  try {
    const html = readFileSync(file, 'utf8')
    const meta = readMeta(dir, slug) ?? synthesizeMeta(dir, slug)
    return { meta, html }
  } catch {
    return null
  }
}

/**
 * 写入 / 更新一页。
 *
 * 语义：
 * · 传了 `slug` —— 明确指定（同 slug 视为更新，version +1）；
 * · 没传 `slug` —— 按标题生成，撞车时加序号（**不会**误覆盖别人的页面）。
 *
 * 先写 html 再写 meta：meta 是索引，后写才能保证「列表里出现的页一定读得到
 * 正文」；反过来（meta 先落地、html 写失败）会出现点开就 404 的死链接。
 */
export function writePage(botId: string, input: WritePageInput): PageWriteResult {
  const title = String(input?.title ?? '').trim()
  if (title === '') return { ok: false, error: 'invalid-title', message: 'title required' }
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: 'invalid-title', message: `title 超过 ${MAX_TITLE_LENGTH} 字` }
  }
  const html = typeof input?.html === 'string' ? input.html : ''
  if (html.trim() === '') return { ok: false, error: 'invalid-html', message: 'html required' }
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > MAX_PAGE_BYTES) {
    return { ok: false, error: 'too-large', message: `html 超过 ${Math.round(MAX_PAGE_BYTES / 1024)}KB` }
  }

  let dir: string
  try {
    dir = pagesDir(botId)
  } catch (error: any) {
    return { ok: false, error: 'write-failed', message: String(error?.message ?? error) }
  }

  const explicitSlug = typeof input?.slug === 'string' ? input.slug.trim().toLowerCase() : ''
  let slug: string
  if (explicitSlug !== '') {
    if (!isValidSlug(explicitSlug)) {
      return { ok: false, error: 'invalid-slug', message: 'slug 只允许 a-z0-9-，且不能以 - 开头' }
    }
    slug = explicitSlug
  } else {
    slug = uniqueSlug(dir, slugifyTitle(title))
  }

  // 双保险：slug 已过白名单，这里再确认解析结果没跑出页面目录
  const htmlPath = resolve(dir, `${slug}.html`)
  if (!htmlPath.startsWith(resolve(dir) + sep)) {
    return { ok: false, error: 'invalid-slug', message: 'path escape' }
  }

  const previous = readMeta(dir, slug)
  const now = Date.now()
  const sourceMessageId = typeof input?.sourceMessageId === 'string' && input.sourceMessageId.trim() !== ''
    ? input.sourceMessageId.trim().slice(0, MAX_SOURCE_MESSAGE_ID_LENGTH)
    : previous?.sourceMessageId
  const share: PageShareState = input?.share === 'shared' || input?.share === 'private'
    ? input.share
    : (previous?.share ?? 'private')
  const meta: PageMeta = {
    slug,
    title,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    version: (previous?.version ?? 0) + 1,
    ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
    share,
    bytes,
  }

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(htmlPath, html, 'utf8')
    writeFileSync(join(dir, `${slug}.meta.json`), JSON.stringify(meta, null, 2), 'utf8')
  } catch (error: any) {
    return { ok: false, error: 'write-failed', message: String(error?.message ?? error) }
  }
  return { ok: true, meta }
}

/** 测试用：暴露内部实现。 */
export const pagesTest = {
  pagesDir,
  pageHtmlPath,
  pageMetaPath,
  isValidSlug,
  slugifyTitle,
  listPages,
  readPage,
  writePage,
  MAX_PAGE_BYTES,
}
