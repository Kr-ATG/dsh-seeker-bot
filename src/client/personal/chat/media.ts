/**
 * Personal Agent — 对话里的媒体 / 产出物纯函数。
 *
 * 这里只放**不碰 DOM、不碰 React** 的判定与拼接逻辑，原因与项目里其它纯逻辑
 * 模块一致：这类判错不会抛异常，只会让卡片悄悄不出现 / 出现错的文件 —— 必须能
 * 被 node 直接 import 后逐条断言（见 _tmp/test-chat-media.mjs）。
 *
 * 三块内容：
 *
 *  1. **类型归族**：`artifactKindOf` 按扩展名把文件分成
 *     video / audio / pdf / doc / sheet / slide / image / file 八族，决定卡片图标
 *     与预览方式；扩展名白名单只有这一处定义，别的地方一律复用它。
 *  2. **地址拼接**：`fileUrlOf` 与三个 `office*Url` 拼宿主的同源路由。
 *     相对路径一律交给 `/api/personal-agent/file?path=...`（以 bot 工作区为基准），
 *     不能直接塞进 `<img src>` —— 浏览器会按当前页面解析，指到 DSH Web 根目录去。
 *  3. **正文里的产出物识别**：`extractArtifactPaths`（散在句子里的路径，用于工具卡
 *     去重）与 `parseArtifactParagraph`（整段只有文件路径 / 下载链接，用于渲染
 *     产出物卡）。模型写路径的姿势五花八门（Markdown 链接、反引号、Windows 绝对
 *     路径、中文名带空格），这两条是全部判据的收口处。
 */
import type { ArtifactKind } from '../types.ts'

/* ───────────────────────── 扩展名 → 归族 ───────────────────────── */

/**
 * 扩展名白名单（小写、不含点）。
 *
 * 只收「对话里真会出现、且浏览器能直接看」的那一族：音视频、PDF、Office 三件套、
 * 图片、压缩包。像 `.exe` / `.dll` / `.log` 这类既不预览也不该给下载按钮的，
 * 一律不认 —— 否则模型随手写的 `C:\Windows\notepad.exe` 会变成一张卡片。
 */
const KIND_BY_EXT: Readonly<Record<string, ArtifactKind>> = {
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  ods: 'sheet',
  ppt: 'slide',
  pptx: 'slide',
  odp: 'slide',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  zip: 'file',
}

/** 白名单扩展名（长到短排序，拼正则时先用长的，避免 doc 抢掉 docx）。 */
export const ARTIFACT_EXTENSIONS: readonly string[] = Object.keys(KIND_BY_EXT)
  .sort((a, b) => b.length - a.length || a.localeCompare(b))

/** 一段文本里最多认几个产出物（模型爱在末尾贴一长串路径）。 */
const MAX_ARTIFACT_PATHS = 8

/** 单个路径的最大长度；超了基本就是整段话被误当成路径。 */
const MAX_PATH_LENGTH = 260

/**
 * 去掉 URL 的查询串（`/api/personal-agent/file?path=x.pdf` 要取到 `x.pdf`）。
 *
 * 只在「问号后面确实像查询串」（带 = 或 &）时裁，避免把文件名里的问号误伤
 * （Windows 文件名不允许问号，但 macOS/Linux 允许）。
 */
function stripQuery(value: string): string {
  const index = value.indexOf('?')
  if (index < 0) return value
  const tail = value.slice(index + 1)
  if (!tail.includes('=') && !tail.includes('&')) return value
  return value.slice(0, index)
}

/** 文件名（含扩展名，不含目录）。`D:\a\b.docx` → `b.docx`。 */
export function fileNameOf(pathOrName: string): string {
  if (typeof pathOrName !== 'string') return ''
  const value = stripQuery(pathOrName.trim())
  const parts = value.split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? '' : (parts[parts.length - 1] as string)
}

/** 扩展名（小写、不含点）；没有扩展名时返回空串。 */
export function fileExtOf(pathOrName: string): string {
  if (typeof pathOrName !== 'string') return ''
  const base = fileNameOf(pathOrName)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** 按扩展名判断产出物归族；不在白名单里返回 null。 */
export function artifactKindOf(pathOrName: string): ArtifactKind | null {
  const ext = fileExtOf(pathOrName)
  if (ext === '') return null
  return KIND_BY_EXT[ext] ?? null
}

/* ───────────────────────── 同源地址 ───────────────────────── */

/**
 * 文件 → 宿主文件路由（相对路径以 bot 工作区为基准解析）。
 *
 * 已经是绝对地址（http(s) / data:）的原样返回：host 给的 `videos` / `images`
 * 就是同源 URL，不能二次编码。空串返回空串（调用方据此不渲染）。
 */
export function fileUrlOf(path: string): string {
  const value = typeof path === 'string' ? path.trim() : ''
  if (value === '') return ''
  if (/^(?:https?:\/\/|data:)/i.test(value)) return value
  return `/api/personal-agent/file?path=${encodeURIComponent(value)}`
}

function officeUrlOf(path: string, action: string, extra = ''): string {
  const value = typeof path === 'string' ? path.trim() : ''
  if (value === '') return ''
  return `/api/personal-agent/office/${action}?path=${encodeURIComponent(value)}${extra}`
}

/** Office 文档某一页的页图（PNG）。 */
export function officePageUrl(path: string, page = 1): string {
  const safe = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1
  return officeUrlOf(path, 'page', `&page=${safe}`)
}

/** Office 文档转成的 PDF（供 iframe 内嵌查看器用）。 */
export function officePdfUrl(path: string): string {
  return officeUrlOf(path, 'pdf')
}

/** Office 文档的元信息（页数 / 转换状态）。 */
export function officeInfoUrl(path: string): string {
  return officeUrlOf(path, 'info')
}

/**
 * 同源文件 URL → 原始路径（`/api/personal-agent/file?path=_tmp%2Fa.mp4` →
 * `_tmp/a.mp4`）。不是带 path 查询的 URL 时返回 null。
 */
export function pathOfFileUrl(url: string): string | null {
  const value = typeof url === 'string' ? url.trim() : ''
  const query = value.indexOf('?')
  if (query < 0) return null
  for (const part of value.slice(query + 1).split('&')) {
    if (!part.startsWith('path=')) continue
    const raw = part.slice('path='.length)
    if (raw === '') return null
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

/**
 * 路径比较用的归一化键：分隔符统一成 `/`、去掉 `./`、压缩重复斜杠、转小写。
 *
 * 用途只有一个 —— 判断「工具卡里的视频」与「正文里写的视频」是不是同一个文件。
 * Windows 文件系统大小写不敏感，这里统一小写；不同盘符/不同相对写法仍会判成
 * 两个（宁可多显示一张卡，也不要漏掉用户真想看的视频）。
 */
export function pathKeyOf(path: string): string {
  const value = typeof path === 'string' ? path.trim() : ''
  if (value === '') return ''
  let key = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (key.startsWith('./')) key = key.slice(2)
  return key.toLowerCase()
}

/* ───────────────────────── 杂项格式化 ───────────────────────── */

/** 字节数 → `1.2 MB` / `820 KB` / `96 B`（host 没给 size 时不要调用）。 */
export function formatFileSize(bytes: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * 从失败的工具结果里抠一句人话。
 *
 * 宿主的工具失败时结果通常是 `{"ok":false,"error":"…"}`，也可能是一段纯文本
 * 报错（网关 4xx / 超时）。取不到就返回 null，由调用方兜底成「…生成失败」——
 * 不要把一整块 JSON 塞进卡片。
 */
export function errorMessageOf(result: string | null | undefined): string | null {
  const text = (result ?? '').trim()
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      for (const key of ['error', 'message', 'detail', 'reason']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
    }
  } catch {
    /* 非 JSON：继续按纯文本取首行 */
  }
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
  if (firstLine === '') return null
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine
}

/* ───────────────────────── 路径扫描 ───────────────────────── */

interface PathHit {
  /** 在原文里的起始下标（用于按出现顺序排序）。 */
  readonly index: number
  /** 原始路径字符串（不做任何改写）。 */
  readonly value: string
}

/**
 * 路径 token 的边界字符（出现即终止）。
 *
 * 反引号用 \x60 写，避免在源码里出现裸反引号（本项目样式表都是模板字符串，
 * 构建期有反引号守卫；纯函数里也统一避开，少一类误判）。
 */
const PATH_BOUNDARY = /[\s"'\x60<>|*?\[\]{},;=，。、；：！？（）【】《》“”‘’…—·]/

/** 这个字符可以出现在路径 token 内部吗（冒号单独判，只认盘符）。 */
function isPathChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === '') return false
  if (ch === ':') return false
  return !PATH_BOUNDARY.test(ch)
}

/** `text[index]` 是不是盘符冒号（`D:\…` 里的那个）。 */
function isDriveColon(text: string, index: number): boolean {
  const letter = text[index - 1]
  if (letter === undefined || !/[A-Za-z]/.test(letter)) return false
  const before = text[index - 2]
  return before === undefined || !isPathChar(before)
}

/**
 * 从 `index` 往前扩到路径 token 的开头。
 *
 * 单独处理冒号是必须的：`D:\…` 要吃掉冒号，而 `http://…` 不能 —— 后者一旦把
 * 冒号吃进来，整串 URL 尾巴会被当成一个本地路径（`//host/a.mp4`），于是对话里
 * 每一条外链视频都会多出一张打不开的卡片。
 */
function expandPathStart(text: string, index: number): number {
  let start = index
  let guard = 0
  while (start > 0 && guard < 4096) {
    const ch = text[start - 1] as string
    if (ch === ':') {
      if (!isDriveColon(text, start - 1)) break
      start -= 1
      guard += 1
      continue
    }
    if (!isPathChar(ch)) break
    start -= 1
    guard += 1
  }
  return start
}

/**
 * 词首是否明显是路径前缀（用于把「带空格的路径」整条捡回来）。
 *
 * 两种都认：① 以盘符 / 根斜杠 / `~` / `./` `../` 开头（`D:\AI\我的`）；
 * ② 词里已经带目录分隔符（`_tmp/我的`）。纯中文句子（`报告已生成`）两条都不满足，
 * 所以不会被误并进路径。
 */
function looksLikePathPrefix(word: string): boolean {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/.test(word)) return true
  return /[\\/]/.test(word)
}

/**
 * 把 `D:\AI\我的 报告.docx` 这种**带空格**的路径整条捡回来。
 *
 * 空格是路径 token 的天然边界，但中文文件名里空格很常见。判据是「空格前面那个
 * 词本身明显是路径前缀」（盘符 / 根斜杠 / `./` `../` `~/`），这样
 * `报告已生成 _tmp/x.docx` 里的 `报告已生成` 不会被误并进来 —— 它不满足前缀判据。
 */
function mergeSpacedPrefix(text: string, start: number, end: number): number {
  let current = start
  for (let round = 0; round < 3; round += 1) {
    if (current <= 0) break
    if (text[current - 1] !== ' ') break
    const wordEnd = current - 1
    const wordStart = expandPathStart(text, wordEnd)
    if (wordStart >= wordEnd) break
    if (!looksLikePathPrefix(text.slice(wordStart, wordEnd))) break
    if (end - wordStart > MAX_PATH_LENGTH) break
    current = wordStart
  }
  return current
}

/**
 * 这个路径是不是落在一条 URL 里（`https://host/a/b.mp4` 的尾巴）。
 *
 * 判据：同一「非空白词」里往前找得到 `://`。只看同一段连续文本是必要的 ——
 * 正文里「链接：https://… 本地文件：D:\x.pdf」这种同行混排很常见，不能因为
 * 前半句有 URL 就把后半句的本地路径也毙掉。
 */
function inUrlContext(text: string, start: number): boolean {
  let index = start
  let guard = 0
  while (index > 0 && guard < 512) {
    const ch = text[index - 1] as string
    if (/\s/.test(ch)) return false
    if (ch === '/' && text[index - 2] === '/' && text[index - 3] === ':') return true
    index -= 1
    guard += 1
  }
  return false
}

/** 一条候选字符串是否够格当产出物路径。 */
function isPlausiblePath(value: string): boolean {
  const path = value.trim()
  if (path === '' || path.length > MAX_PATH_LENGTH) return false
  if (/[\r\n]/.test(path)) return false
  if (/^(?:https?:\/\/|data:|mailto:|javascript:)/i.test(path)) return false
  if (path.startsWith('//')) return false
  if (path.startsWith('#')) return false
  const name = fileNameOf(path)
  if (name === '' || name === '.' || name === '..') return false
  // 隐藏文件 / 隐藏目录（.env、.git/config.pdf）不给卡片：模型提到它们的语境
  // 通常不是产出物。`./x` 与 `../x` 是相对路径写法，不算隐藏名。
  if (name.startsWith('.')) return false
  if (path.startsWith('.') && !path.startsWith('./') && !path.startsWith('../')) return false
  return artifactKindOf(path) !== null
}

/** 正则里的扩展名分支（长的在前，`doc` 不会抢掉 `docx`）。 */
const EXT_ALTERNATION = ARTIFACT_EXTENSIONS.join('|')

/** 带扩展名结尾的位置：`.pdf` / `.docx` 等，后面不能再接字母数字。 */
function extensionPattern(): RegExp {
  return new RegExp(`\\.(?:${EXT_ALTERNATION})(?![A-Za-z0-9])`, 'gi')
}

/**
 * 裸路径扫描：先找「以白名单扩展名结尾」的位置，再往前扩出 token。
 *
 * 反过来（先切词再看扩展名）不行：路径里允许中文、空格、括号，很难用字符类
 * 一次描述清楚；从扩展名往回扩则天然收口在「扩展名必须在末尾」这条硬约束上。
 */
function collectBarePaths(text: string): PathHit[] {
  const hits: PathHit[] = []
  const pattern = extensionPattern()
  let match: RegExpExecArray | null = pattern.exec(text)
  while (match !== null) {
    const dotIndex = match.index
    const end = dotIndex + match[0].length
    let start = expandPathStart(text, dotIndex)
    // 句读里的左括号会被当成路径字符（`(1).docx` 这种文件名很常见），
    // 扩到句首时再剥掉，`(见 _tmp/x.docx)` 才不会带上括号。
    while (start < dotIndex && text[start] === '(') start += 1
    start = mergeSpacedPrefix(text, start, end)
    const value = text.slice(start, end)
    if (isPlausiblePath(value) && !inUrlContext(text, start)) {
      hits.push({ index: start, value })
    }
    match = pattern.exec(text)
  }
  return hits
}

/** Markdown 链接的地址（含 `![…](…)` 图片语法；图片也是一种文件路径）。 */
function cleanLinkTarget(raw: string): string {
  let value = raw.trim()
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim()
  // 去掉可选 title：`path "标题"` / `path '标题'`
  const titled = /^(.*?)\s+["'][^"']*["']$/.exec(value)
  if (titled !== null && titled[1] !== undefined) value = titled[1].trim()
  return value
}

const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\(([^)\n]+)\)/g

function collectMarkdownLinkPaths(text: string): PathHit[] {
  const hits: PathHit[] = []
  const pattern = new RegExp(MARKDOWN_LINK.source, 'g')
  let match: RegExpExecArray | null = pattern.exec(text)
  while (match !== null) {
    const value = cleanLinkTarget(match[2] ?? '')
    if (isPlausiblePath(value)) hits.push({ index: match.index, value })
    match = pattern.exec(text)
  }
  return hits
}

/**
 * 从一段文本里找本地文件路径：Markdown 链接 + 裸路径（Windows 绝对路径、
 * 相对路径、反引号/引号包起来的路径）。
 *
 * 返回**原始路径字符串**（不改写、不绝对化），按出现顺序去重，最多 8 个。
 * 用途是「工具卡里的媒体与正文重复时去重」，所以宁可少认也不要认错 ——
 * URL、隐藏文件、非白名单扩展名、明显是句子的片段一律排除。
 */
export function extractArtifactPaths(text: string): string[] {
  if (typeof text !== 'string' || text.trim() === '') return []
  const hits = [...collectMarkdownLinkPaths(text), ...collectBarePaths(text)]
  hits.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const out: string[] = []
  for (const hit of hits) {
    if (seen.has(hit.value)) continue
    seen.add(hit.value)
    out.push(hit.value)
    if (out.length >= MAX_ARTIFACT_PATHS) break
  }
  return out
}

/* ───────────────────────── 整段产出物 ───────────────────────── */

/** 段落里识别出的一个产出物。 */
export interface ParagraphArtifact {
  /** 原始路径字符串。 */
  readonly path: string
  /** Markdown 链接的 label（裸路径没有）。 */
  readonly label?: string
}

/** 列表项前缀（`- ` / `* ` / `1. ` / `1、`）。 */
const LIST_PREFIX = /^(?:[-*·•]|\d{1,3}[.、)])\s+/

/** 路径前缀（盘符 / 根斜杠 / `~` / `./` `../` / 任意目录段）。 */
const PATH_PREFIX = /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/]|[^\\/\s]+[\\/])/

/**
 * 整行是不是「就是一条路径」。
 *
 * 与 `extractArtifactPaths` 的区别：那里是在句子里捞路径（宽松），这里要判定
 * 整行**只有**路径（严格）。所以带空格的行必须满足两个条件才认：以路径前缀
 * 开头、且不含中文句读 —— 否则「产物在 _tmp/x.docx」会被整行当成路径。
 */
function matchBarePathLine(line: string): string | null {
  const value = line.trim()
  if (value === '' || value.length > MAX_PATH_LENGTH) return null
  if (!isPlausiblePath(value)) return null
  if (!/\s/.test(value)) return value
  if (!PATH_PREFIX.test(value)) return null
  if (/[，。；：！？、“”‘’]/.test(value)) return null
  return value
}

/**
 * 段落级产出物识别：整段只有 Markdown 链接 / 裸路径时，返回这些文件。
 *
 * 用途是「产出物卡」：模型把交付文件单独写成一行的场景（列表、下载链接）很常见，
 * 渲染成卡片能直接预览 / 下载。只要段落里混了一句别的话就返回 null，交回普通
 * 段落渲染 —— 绝不把句子拆碎。
 */
export function parseArtifactParagraph(text: string): ParagraphArtifact[] | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return null
  const out: ParagraphArtifact[] = []
  for (const raw of lines) {
    const line = raw.replace(LIST_PREFIX, '').trim()
    const link = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/.exec(line)
    if (link !== null) {
      const path = cleanLinkTarget(link[2] ?? '')
      if (!isPlausiblePath(path)) return null
      const label = (link[1] ?? '').trim()
      out.push(label === '' ? { path } : { path, label })
    } else {
      const path = matchBarePathLine(line)
      if (path === null) return null
      out.push({ path })
    }
    if (out.length > MAX_ARTIFACT_PATHS) return null
  }
  return out.length === 0 ? null : out
}
