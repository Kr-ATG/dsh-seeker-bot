/**
 * Personal Agent — host 半身。
 *
 * 为前端 Personal Agent 提供三件真实能力（全部可选，失败时前端自动降级）：
 *
 *   1. POST /api/personal-agent/reply          → 走宿主 ctx.llm.stream 的真实模型回复
 *   2. POST /api/personal-agent/journal/image  → 调用当前生图模型生成期刊宽幅配图（16:9）
 *   3. POST /api/personal-agent/tts            → Edge 在线 TTS（本机 edge-tts CLI）转 mp3
 *   4. POST /api/personal-agent/asr            → 宿主 speechController（SenseVoice）转写
 *   5. GET  /api/personal-agent/journal/asset  → 已生成期刊配图的静态文件
 *   6. GET  /api/personal-agent/file           → bot 工作区里的媒体文件（图片 / 视频 / 音频 /
 *                                                PDF / Office 文档；视频与音频支持 HTTP Range）
 *   7. GET  /api/personal-agent/office/info    → 产出物可否预览（复用 src/office 的扩展名表）
 *   8. GET  /api/personal-agent/office/page    → Office / PDF 的第 N 页 PNG（复用 src/office 引擎）
 *   9. GET  /api/personal-agent/office/pdf     → 整份 PDF（.pdf 原样转发，Office 走引擎转换）
 *
 * 设计约束：
 *  - 不引入 @deepseek-ai/* 运行时依赖（本仓库 host 产物必须自包含）；
 *  - 所有路由失败一律 JSON，不抛穿；跨站写请求拒绝；
 *  - 大模型回复只回纯文本 blocks；任何异常都让前端回退到本地引擎，不影响演示。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { botWorkspaceDir, ensureBotAgent, getLastTurnDebug, resetBotConversation, runBotTurn, type BotAgentSpec, type PersonalStreamEvent } from './agent.ts'
import { recallBotTurn } from './recall.ts'
import { decodeDataUrl, extensionFor, looksLikeImage, materializeRoot } from '../../spill/materialize.ts'
import { __test as officeInternals, officeEngineAvailable, renderOfficePages, renderOfficePdf } from '../../office/index.ts'

const ROUTE = '/api/personal-agent'
const MAX_BODY = 32 * 1024 * 1024
const DEFAULT_PROVIDER = 'alymagpie'
const DEFAULT_MODEL = 'auto/deepseek-v4.1-flash'

/** 图片文件路由的单文件上限（与生图落盘口径一致）。 */
const MAX_IMAGE_FILE_BYTES = 24 * 1024 * 1024

/**
 * 媒体文件（视频 / 音频 / 文档）的单文件上限。
 *
 * 图片保持 24MB —— 生图落盘口径就是那个量级；视频动辄几十上百 MB，用同一个
 * 上限会让「生成了视频但打不开」。所以按族分开：图片 24MB，其它媒体 256MB。
 */
const MAX_MEDIA_FILE_BYTES = 256 * 1024 * 1024

/** Office 预览的源文件上限（与 src/office/index.ts 的 MAX_SOURCE_BYTES 同口径）。 */
const MAX_OFFICE_FILE_BYTES = 64 * 1024 * 1024

/** Office 预览单次最多翻到第几页（与 src/office/index.ts 的 MAX_PAGES 一致）。 */
const MAX_OFFICE_PAGES = 12

/** 用户粘贴图片的单张上限：解码后字节数（base64 串长度按 1.5 倍另算）。 */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024
/** 上传请求里 data URL 的字符数上限（先挡在解码之前，避免白解一遍大字符串）。 */
const MAX_UPLOAD_DATA_URL_CHARS = 18 * 1024 * 1024

/** 图片路由的扩展名白名单 → content-type（键为小写扩展名）。 */
const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * 媒体路由的扩展名白名单 → content-type（键为小写扩展名）。
 *
 * 为什么 mov 声明成 `video/mp4`：Chromium 对 QuickTime 容器本身是能解的（实测同一份
 * t.mov：声明 video/mp4 → loadeddata；声明 video/quicktime → 直接失败）。详见
 * `src/client/sidebar-media/index.tsx` 的注释 —— 两处必须同一口径，否则「侧栏能放、
 * bot 对话里放不了」。
 *
 * 文档类放进来是因为对话流里的产出物卡片要能直接打开 / 预览：PDF 交给浏览器自带
 * 查看器，Office 走 `/office/pdf` 转成 PDF 再内嵌。
 */
const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  // mov 声明成 mp4：QuickTime 容器 Chromium 能解，但只认 video/mp4 这个 MIME（实测）。
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.zip': 'application/zip',
}

/**
 * 可渲染的 Office / PDF 扩展名表：**直接用 src/office 的那一份**。
 *
 * 各留一份拷贝迟早漂移（office 那边加一个格式，这边仍判「不可渲染」），所以从
 * office 模块的 `__test` 面取；不改 office 模块本身（只 import 它的导出）。
 */
const OFFICE_RENDERABLE_EXT: ReadonlySet<string> = officeInternals.RENDERABLE_EXT


/**
 * 路径比较用的归一化：解析成绝对路径、统一正斜杠、去尾分隔符、转小写。
 *
 * Windows 文件系统不区分大小写（`D:\Seeker-Bot` 与 `d:\seeker-bot` 是同一个
 * 目录），而允许根与请求路径来自两处独立拼装，大小写很容易不一致；不统一的话
 * 合法路径会被误判成越界。
 */
function normalizeForCompare(value: string): string {
  return resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

function journalDir(): string {
  const dir = join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent', 'journals')
  mkdirSync(dir, { recursive: true })
  return dir
}

function sendJson(res: any, status: number, payload: unknown): void {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {
    /* 客户端已断开 */
  }
}

function readJsonBody(req: any): Promise<Record<string, any>> {
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
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolvePromise({})
      }
    })
    req.on('error', () => resolvePromise({}))
  })
}

function crossSite(req: any): boolean {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return false
  const host = req.headers?.host
  try {
    const parsed = new URL(origin)
    return typeof host !== 'string' || parsed.host !== host
  } catch {
    return true
  }
}

/* ───────────────────── 文件 / 媒体路由的准入与工具 ───────────────────── */

/** 一次路径准入的结果：通过时给绝对路径，失败时给 HTTP 状态与错误码。 */
type AdmitVerdict =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * 把请求里的 `path` 解析成允许根内的绝对路径。
 *
 * 安全面三道闸（缺一道就等于开了个任意文件读）：
 *  1. 相对路径以 bot 工作区为基准解析；绝对路径照收，但**必须**落在允许根
 *     （bot 工作区 / 期刊目录 / 生图落盘根）之内 —— 解析后的路径要等于根或
 *     在「根 + 分隔符」之内，防止 `..` 与同前缀兄弟目录（Seeker-Bot2）越界；
 *  2. 扩展名白名单（调用方各自判）；
 *  3. 必须是存在的普通文件、且在各自的大小上限内（调用方各自判）。
 */
function admitWorkspaceFile(raw: string): AdmitVerdict {
  if (raw === '') return { ok: false, status: 400, error: 'empty path' }
  const target = resolve(isAbsolute(raw) ? raw : join(botWorkspaceDir(), raw))
  const normalized = normalizeForCompare(target)
  const allowed = [botWorkspaceDir(), journalDir(), materializeRoot()].some((root) => {
    const base = normalizeForCompare(root)
    return normalized === base || normalized.startsWith(`${base}/`)
  })
  if (!allowed) return { ok: false, status: 403, error: 'forbidden' }
  return { ok: true, path: target }
}

/** stat 一个普通文件；失败（不存在 / 是目录 / 无权限）返回 null。 */
function statFile(target: string): { size: number } | null {
  try {
    const info = statSync(target)
    return info.isFile() ? { size: info.size } : null
  } catch {
    return null
  }
}

/** 单区间 Range 的解析结果：区间 / 不可满足 / 不支持（按「无 Range」处理）。 */
type RangeVerdict = { readonly start: number; readonly end: number } | 'unsatisfiable' | null

/**
 * 解析 `Range: bytes=start-end`（只支持单区间）。
 *
 * 视频 / 音频的 seek 完全依赖它：浏览器先发一个 Range 探长度、拖动进度条时再发
 * 若干个小片段。没有 206 就只能从头播，也不能拖。
 *
 * @param value - `req.headers.range` 原值。
 * @param total - 文件总字节数。
 * @returns 闭区间 [start, end]；`unsatisfiable` = 越界（回 416）；
 *   `null` = 没有 Range / 语法不支持（多区间、非 bytes 单位）→ 回 200 全量。
 */
function parseRangeHeader(value: unknown, total: number): RangeVerdict {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^bytes=/i.test(text)) return null
  const spec = text.slice('bytes='.length).trim()
  // 多区间（`bytes=0-1,5-9`）不支持：忽略整个 Range，按 200 全量回。
  if (spec === '' || spec.includes(',')) return null
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (match === null) return null
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (startText === '' && endText === '') return null
  if (total <= 0) return 'unsatisfiable'

  let start: number
  let end: number
  if (startText === '') {
    // `bytes=-N`：最后 N 字节（Chrome 对媒体尾部探测会用这种写法）。
    const suffix = Number(endText)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(startText)
    end = endText === '' ? total - 1 : Number(endText)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) return null
    if (end < start) return 'unsatisfiable'
    if (start >= total) return 'unsatisfiable'
    end = Math.min(end, total - 1)
  }
  return { start, end }
}

/** Office 渲染异常的 HTTP 状态（与 src/office/index.ts 的 fail() 同口径）。 */
function officeErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'engine-unavailable') return 503
  if (message === 'unsupported-format') return 415
  if (message === 'not-found') return 404
  if (message === 'input-too-large') return 413
  return 500
}

/** Office 渲染异常 → `{ ok:false, error }` 里的 error 文案（不泄堆栈）。 */
function officeErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'engine-unavailable') return 'engine-unavailable'
  if (message === 'unsupported-format') return 'unsupported-format'
  if (message === 'not-found') return 'not-found'
  if (message === 'input-too-large') return 'input-too-large'
  return `render-failed: ${message.slice(0, 200)}`
}

/**
 * Office 预览的完整准入：路径 + 扩展名 + 大小。
 *
 * 与 `/file` 共用 {@link admitWorkspaceFile} 的路径闸门，再叠两条：扩展名必须在
 * `src/office` 的 RENDERABLE_EXT 里、文件 ≤64MB（引擎那条路是 LibreOffice 转换，
 * 大文件会把串行队列堵死）。
 */
function admitOfficeFile(raw: string): { readonly ok: true; readonly path: string; readonly ext: string } | { readonly ok: false; readonly status: number; readonly error: string } {
  const admitted = admitWorkspaceFile(raw)
  if (!admitted.ok) return admitted
  const ext = extname(admitted.path).toLowerCase()
  if (!OFFICE_RENDERABLE_EXT.has(ext)) return { ok: false, status: 415, error: 'unsupported-format' }
  const info = statFile(admitted.path)
  if (info === null) return { ok: false, status: 404, error: 'not-found' }
  if (info.size > MAX_OFFICE_FILE_BYTES) return { ok: false, status: 413, error: 'input-too-large' }
  return { ok: true, path: admitted.path, ext }
}


/* ───────────────────────────── LLM 回复 ───────────────────────────── */

interface ReplyBody {
  bot?: {
    id?: string
    name?: string
    role?: string
    description?: string
    instructions?: string
    model?: { provider?: string; model?: string; effort?: string }
  }
  text?: string
  history?: Array<{ role?: string; text?: string }>
  memories?: string[]
  /**
   * 本轮用户附带的图片（前端先走 /upload 落盘，这里只带相对路径）。
   *
   * bot 的 user 消息只有 text content，没有多模态 image part；所以图片不进
   * 消息体，而是把「落在哪」告诉模型，让它需要时自己 read_image。
   */
  images?: Array<{ path?: string; name?: string }>
  /** 该 bot 自己的工具权限档位（缺省按完全权限）。 */
  permission?: 'full' | 'approval'
}

/**
 * 把前端传来的 bot 描述收敛成 agent 会话的配置。
 *
 * botId 决定会话身份与工作目录，所以必须稳定：前端没给 id 时用名字兜底，
 * 保证同一个 bot 每次落在同一个会话上。
 */
function toBotSpec(body: ReplyBody): BotAgentSpec {
  const bot = body.bot ?? {}
  const rawId = String(bot.id ?? '').trim()
  const fallbackId = `name-${String(bot.name ?? 'main')}`
  return {
    botId: rawId !== '' ? rawId : fallbackId,
    name: String(bot.name ?? '助手'),
    role: String(bot.role ?? '通用助手'),
    description: String(bot.description ?? ''),
    instructions: String(bot.instructions ?? ''),
    model: bot.model,
    permission: body.permission === 'approval' ? 'approval' : 'full',
    memories: Array.isArray(body.memories)
      ? body.memories.filter((item): item is string => typeof item === 'string')
      : undefined,
  }
}

/**
 * 把「本轮用户发了图」翻成模型能执行的一段提示。
 *
 * 为什么是路径而不是多模态：bot 的 user 消息由 `createUserMessage` 构造，只有
 * text content；图片已经在 /upload 落盘到 bot 工作区，所以这里把绝对路径写清楚，
 * 模型需要看内容时自己 read_image。前端展示的用户消息不含这段前缀。
 *
 * @param text - 用户输入的正文（可能为空：只发图不打字）。
 * @param images - /reply 带来的图片路径列表。
 * @returns 拼好提示的文本；没有图片时原样返回。
 */
function withImageHints(text: string, images: unknown): string {
  if (!Array.isArray(images) || images.length === 0) return text
  const list: Array<{ path: string; name: string }> = []
  for (const item of images) {
    const record = item as { path?: unknown; name?: unknown } | null
    if (record === null || typeof record !== 'object') continue
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    if (path === '') continue
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : path
    list.push({ path, name })
    if (list.length >= 6) break
  }
  if (list.length === 0) return text
  const lines = list.map((item, index) => {
    const absolute = resolve(isAbsolute(item.path) ? item.path : join(botWorkspaceDir(), item.path))
    return `  ${index + 1}. ${item.name} → ${absolute}`
  })
  return [
    `【用户发来 ${list.length} 张图片】`,
    ...lines,
    '需要看图片内容时，用 read_image 读取上面的绝对路径；用户的问题见下方正文。',
    '',
    text,
  ].join('\n')
}

function registeredProvider(ctx: any, wanted: string | undefined): string | undefined {
  try {
    const providers = ctx.llm.listProviders() as Array<{ id?: string }>
    const ids = providers.map((item) => String(item.id ?? ''))
    if (wanted !== undefined && ids.includes(wanted)) return wanted
    if (ids.includes(DEFAULT_PROVIDER)) return DEFAULT_PROVIDER
    return ids[0]
  } catch {
    return wanted
  }
}

async function collectLlmText(ctx: any, options: any): Promise<string> {
  let text = ''
  let reasoning = ''
  const stream = ctx.llm.stream(options)
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
  }
  return text.trim() || ''
}

async function generateReply(ctx: any, body: ReplyBody): Promise<{ ok: boolean; blocks?: any[]; error?: string; model?: string }> {
  const bot = body.bot ?? {}
  const text = withImageHints(String(body.text ?? '').trim(), body.images)
  if (text === '') return { ok: false, error: 'empty message' }

  const provider = registeredProvider(ctx, bot.model?.provider)
  if (provider === undefined || provider === '') return { ok: false, error: 'no LLM provider registered' }
  let model = String(bot.model?.model ?? '').trim()
  if (model === '' || provider !== bot.model?.provider) {
    try {
      const models = await ctx.llm.listModels(provider)
      model = String(models?.[0]?.id ?? DEFAULT_MODEL)
    } catch {
      model = DEFAULT_MODEL
    }
  }

  const memories = Array.isArray(body.memories) ? body.memories.filter((item) => typeof item === 'string').slice(-10) : []
  const historyLines = Array.isArray(body.history)
    ? body.history
        .filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '')
        .slice(-14)
        .map((item) => {
          const text = String(item.text ?? '')
          return `${item.role === 'user' ? '用户' : '你'}：${text.replace(/\s+/g, ' ').slice(0, 400)}`
        })
    : []
  const now = new Date()
  const timeText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  const system = [
    `你是「${String(bot.name ?? '助手')}」，岗位：${String(bot.role ?? '通用助手')}。`,
    String(bot.description ?? '') !== '' ? `档案：${String(bot.description)}` : '',
    String(bot.instructions ?? '') !== '' ? `行为约定：${String(bot.instructions)}` : '',
    memories.length > 0 ? `你记得关于用户的事：\n- ${memories.join('\n- ')}` : '',
    `现在是 ${timeText}（Asia/Shanghai）。`,
    /*
     * 与 agent 路径（host/personal/agent.ts 的 buildBotPrompt）保持同一份契约：
     * bot 是聊天，不是交报告。两处漂移会让「同一个 bot 换个入口就换了语气」。
     */
    '你在跟用户聊天，不是在交报告。回复硬要求：',
    '- 简体中文，默认 1–3 句，最多两小段；先给结论或直接回答，再补一句必要说明。',
    '- 不用加粗当小标题，不用多级清单、表格、代码块，不写「首先 / 其次 / 综上」这类汇报腔。',
    '- 不贴文件路径、命令、参数、URL；用户明确要看才贴。',
    '- 过程一句带过（「我看了下」），不要逐条复述步骤；结尾最多一句下一步或一个具体问题。',
    '不要声称自己已经执行了你没有真正执行的操作；可以说明下一步计划，或提出一个具体问题。',
  ].filter((line) => line !== '').join('\n')

  const prompt = [
    historyLines.length > 0 ? `最近的对话（供你参考语气和上下文）：\n${historyLines.join('\n')}` : '',
    `用户现在说：${text}`,
    '请直接回复用户。',
  ].filter((line) => line !== '').join('\n\n')

  try {
    const reply = await collectLlmText(ctx, {
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 1200,
      temperature: 0.8,
    })
    if (reply === '') return { ok: false, error: 'empty model reply', model: `${provider}/${model}` }
    return { ok: true, blocks: [{ type: 'text', text: reply }], model: `${provider}/${model}` }
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error), model: `${provider}/${model}` }
  }
}

/* ───────────────────────────── 生图 ───────────────────────────── */

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

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 256) return null
    const type = response.headers.get('content-type') ?? 'image/png'
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

async function generateJournalImage(ctx: any, body: { prompt?: string; title?: string; date?: string }): Promise<{ ok: boolean; image?: string; error?: string; model?: string }> {
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
        signal: AbortSignal.timeout(180_000),
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
      image = (await fetchImageAsDataUrl(first.url)) ?? ''
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

/* ───────────────────────────── Edge TTS ───────────────────────────── */

function runEdgeTts(text: string, voice: string): Promise<{ ok: boolean; audio?: string; error?: string }> {
  return new Promise((resolvePromise) => {
    const out = join(tmpdir(), `pa-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`)
    const command = process.platform === 'win32' ? 'edge-tts.exe' : 'edge-tts'
    execFile(command, ['--voice', voice, '--text', text, '--write-media', out], { timeout: 45_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        resolvePromise({ ok: false, error: `${error.message}${stderr ? ` — ${String(stderr).slice(0, 200)}` : ''}` })
        return
      }
      try {
        const buffer = readFileSync(out)
        resolvePromise({ ok: true, audio: `data:audio/mpeg;base64,${buffer.toString('base64')}` })
      } catch (readError: any) {
        resolvePromise({ ok: false, error: String(readError?.message ?? readError) })
      }
    })
  })
}

/* ───────────────────────────── 路由装配 ───────────────────────────── */

/**
 * 把已有的 bot 会话一次性挂到 Seeker-Bot 工作区下。
 *
 * 侧栏的工作区分组看的是 `workspace.sessionIds`，而官方 Web 会话由
 * `session-controller` 负责 attachSession——我们直接调 `ctx.agents.create()`
 * 建的会话绕过了那条路，所以历史会话全掉进「未分组」。这里在启动时补挂一遍，
 * 用户不用重建对话。
 */
async function attachBotSessions(ctx: any, workspace: any): Promise<void> {
  if (workspace === undefined || workspace === null) return
  if (typeof workspace.attachSession !== 'function') return

  const ids: string[] = []
  try {
    const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
    if (typeof persistence?.list === 'function') {
      const list = await persistence.list()
      for (const snapshot of Array.isArray(list) ? list : []) {
        const id = String(snapshot?.header?.id ?? snapshot?.id ?? '')
        if (id !== '') ids.push(id)
      }
    }
  } catch {
    /* 列举失败：只处理实时注册表里的 */
  }
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (typeof agents?.list === 'function') {
      for (const agent of agents.list() ?? []) {
        const id = String(agent?.session?.id ?? agent?.id ?? '')
        if (id !== '') ids.push(id)
      }
    }
  } catch {
    /* 忽略 */
  }

  for (const id of [...new Set(ids)].filter((item) => item.startsWith('pa-bot-'))) {
    try {
      await workspace.attachSession(id)
    } catch {
      /* 单个会话挂接失败（cwd 不匹配 / 目录不存在）：跳过，不影响其它 */
    }
  }
}

/** 把一个新会话挂到 Seeker-Bot 工作区（每轮对话后调用，保证新会话立刻归位）。 */
async function attachOneSession(ctx: any, sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined || sessionId === '') return
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (typeof registry?.list !== 'function') return
    const target = botWorkspaceDir()
    const workspaces = registry.list() ?? []
    const workspace = workspaces.find((item: any) => String(item?.path ?? '') === target)
    if (workspace !== undefined && typeof workspace.attachSession === 'function') {
      await workspace.attachSession(sessionId)
    }
  } catch {
    /* 挂接失败不影响对话本身 */
  }
}

export function applyPersonalAgentHost(ctx: any): void {
  /*
   * 先把 bot 的共享工作目录建出来：所有 bot 与群聊都在这个文件夹里干活
   * （用户要求）。放在插件挂载时做，而不是等第一次对话——这样用户打开文件管理器
   * 就能看到它，不用先跟 bot 说一句话。
   */
  try {
    botWorkspaceDir()
  } catch {
    /* 建目录失败（权限等）：不阻塞其它路由，首次对话时会再试 */
  }

  /*
   * 把这个目录登记成 DSH 的 workspace，让它出现在侧栏「工作区」列表里。
   *
   * `meta.cwd` 只决定 agent 在哪干活，**不会**让目录出现在侧栏——那是
   * workspaceRegistry 的职责。create() 对已登记的目录幂等（直接返回现有项目），
   * 所以每次启动调用都安全。
   */
  try {
    ctx.inject(['workspaceRegistry'], (wsCtx: any) => {
      void (async () => {
        try {
          const workspace = await wsCtx.workspaceRegistry.create(botWorkspaceDir(), 'Seeker-Bot')
          /*
           * 光登记工作区还不够：**会话也要挂进去**，否则侧栏会把它们归到「未分组」。
           *
           * 官方 Web 会话由 `session-controller` 负责 attachSession；我们是用
           * `ctx.agents.create()` 直接建的会话，绕过了那条路径，所以得自己补。
           * 这里把历史遗留的 `pa-bot-*` 会话一次性补挂，用户不用重建对话。
           */
          await attachBotSessions(wsCtx, workspace)
        } catch {
          /* 注册失败（目录被占 / 服务拒绝）：不影响 Bot 本身能干活 */
        }
      })()
    })
  } catch {
    /* workspace 服务不存在：跳过，只是侧栏看不到这个工作区 */
  }

  let speechController: any = null
  try {
    ctx.inject(['speechController'], (speechCtx: any) => {
      speechController = speechCtx.speechController
    })
  } catch {
    /* speech 服务不存在：ASR 路由返回降级 */
  }

  ctx.inject(['webServer', 'llm', 'credentials', 'settings'], (webCtx: any) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req: any, res: any) => {
        void handle(webCtx, req, res)
      },
    }), 'dsh-seeker-bot: personal-agent routes')

    async function handle(webCtx: any, req: any, res: any): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const tail = url.pathname.slice(ROUTE.length) || '/'
      const method = String(req.method ?? 'GET').toUpperCase()

      try {
        if (method !== 'GET' && method !== 'HEAD' && crossSite(req)) {
          return sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
        }
        if (tail === '/health' && method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            routes: [
              'reply', 'reply/stream', 'reset', 'recall', 'models',
              'journal/image', 'journal/asset', 'tts', 'asr',
              'file', 'upload',
              'office/info', 'office/page', 'office/pdf',
            ],
          })
        }

        /*
         * 可用模型清单：给 Bot 设置里的模型选择器用。
         * 直接读宿主的 llm 注册表，所以用户在供应商中心新加的模型会立刻出现。
         */
        if (tail === '/models' && method === 'GET') {
          try {
            const llm = typeof webCtx.get === 'function' ? webCtx.get('llm') : webCtx.llm
            if (llm === undefined || llm === null) return sendJson(res, 503, { ok: false, error: 'llm service unavailable' })
            const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
            const groups: Array<Record<string, unknown>> = []
            for (const provider of providers) {
              const providerId = String(provider?.id ?? '')
              if (providerId === '') continue
              try {
                const models = await llm.listModels(providerId)
                const entries = (Array.isArray(models) ? models : []).map((model: any) => ({
                  id: String(model?.id ?? ''),
                  name: String(model?.name ?? model?.id ?? ''),
                })).filter((model: any) => model.id !== '')
                if (entries.length === 0) continue
                groups.push({
                  provider: providerId,
                  name: String(provider?.name ?? providerId),
                  models: entries,
                })
              } catch {
                /* 单个供应商列举失败：跳过它，不影响其它分组 */
              }
            }
            return sendJson(res, 200, { ok: true, groups })
          } catch (error: any) {
            return sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
          }
        }

        /*
         * 清空某个 bot 的全部对话：dispose 活着的 agent + 删持久化会话。
         * 前端负责清自己 localStorage 里的消息，这里负责宿主侧的「记忆」。
         */
        if (tail === '/reset' && method === 'POST') {
          const body = await readJsonBody(req)
          const botId = String(body.botId ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'empty botId' })
          const result = await resetBotConversation(webCtx, botId)
          return sendJson(res, result.ok ? 200 : 502, result)
        }

        /*
         * 撤回一条用户消息：把「这条消息 + 它之后的 bot 回复」从该 bot 会话的
         * 模型可见 surface 上遮蔽掉（日志保留，后续上下文不再包含）。
         *
         * 前端已经先做完本地撤回（删消息 + 删记忆 + 系统提示），这里失败只是
         * 「上下文没撤回来」，所以 502 带上可读原因，前端静默忽略即可。
         */
        if (tail === '/recall' && method === 'POST') {
          const body = await readJsonBody(req)
          const botId = String(body.botId ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'empty botId' })
          const text = String(body.text ?? '')
          const at = typeof body.at === 'number' && Number.isFinite(body.at) ? body.at : Date.now()
          /*
           * 前端只带 botId（撤回是「针对某条消息」，不需要完整 bot 档案）。
           * 这里补一个最小 bot 对象：botId 决定会话身份，name/role 只影响提示词，
           * 撤回不重新组装提示词，所以留默认值即可。
           */
          const spec = toBotSpec({
            bot: { ...(body.bot ?? {}), id: botId },
            permission: body.permission === 'approval' ? 'approval' : 'full',
          })
          const result = await recallBotTurn(webCtx, spec, text, at)
          return sendJson(res, result.ok ? 200 : 502, result)
        }

        /*
         * 诊断入口：一次性回答「bot 到底卡在哪」。
         *
         * 排查 agent 链路时最痛苦的是错误被降级吞掉，界面上只看到「模型说它
         * 没有权限」。这里把宿主服务是否存在、建 agent 的真实报错、栈顶几帧
         * 全部吐出来，重启一次就能定位，不用反复猜。
         */
        if (tail === '/diagnose' && method === 'GET') {
          const botId = url.searchParams.get('botId') ?? 'diagnose'
          const report: Record<string, any> = { services: {}, agent: null }
          for (const name of ['agents', 'permissionPresets', 'systemPrompt', 'workingDirectory', 'sessionProjections', 'sessions', 'tools']) {
            try {
              const service = typeof webCtx.get === 'function' ? webCtx.get(name) : undefined
              report.services[name] = service === undefined || service === null
                ? 'missing'
                : `present (${Object.prototype.toString.call(service).slice(8, -1)})`
            } catch (error: any) {
              report.services[name] = `error: ${String(error?.message ?? error)}`
            }
          }
          try {
            const agents = typeof webCtx.get === 'function' ? webCtx.get('agents') : undefined
            report.agentsApi = agents === undefined ? 'missing' : {
              create: typeof agents.create,
              resume: typeof agents.resume,
              get: typeof agents.get,
              list: typeof agents.list,
              live: typeof agents.list === 'function' ? (agents.list() ?? []).map((item: any) => String(item?.session?.id ?? item?.id ?? '')) : null,
            }
          } catch (error: any) {
            report.agentsApi = `error: ${String(error?.message ?? error)}`
          }
          // 最近一轮实际收到了哪些会话事件——判断「监听挂没挂上」的唯一证据
          report.lastTurn = getLastTurnDebug()
          try {
            const agent = await ensureBotAgent(webCtx, {
              botId,
              name: '诊断 Bot',
              role: '诊断',
              description: '',
              instructions: '',
              permission: 'full',
            })
            report.agent = {
              ok: true,
              sessionId: String(agent?.session?.id ?? ''),
              cwd: String(agent?.session?.header?.cwd ?? ''),
            }
          } catch (error: any) {
            report.agent = {
              ok: false,
              error: String(error?.message ?? error),
              name: String(error?.name ?? ''),
              stack: String(error?.stack ?? '').split('\n').slice(0, 8),
            }
          }
          return sendJson(res, 200, report)
        }

        /*
         * 模型目录：给 Bot 设置里的「模型」选择器用。
         *
         * 前端拿不到 ctx.llm（那是宿主服务），所以由这里按 provider 分组吐出来。
         * 某个 provider 取模型失败不影响其它组——界面至少能选到能用的那些。
         */
        if (tail === '/models' && method === 'GET') {
          try {
            const llm = webCtx.llm
            const rawProviders = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
            const groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> = []
            for (const provider of rawProviders) {
              const id = String(provider?.id ?? '').trim()
              if (id === '') continue
              let models: Array<{ id: string; name: string }> = []
              try {
                const list = await llm.listModels(id)
                models = (Array.isArray(list) ? list : [])
                  .map((model: any) => ({
                    id: String(model?.id ?? ''),
                    name: String(model?.name ?? model?.id ?? ''),
                  }))
                  .filter((model) => model.id !== '')
              } catch {
                models = []
              }
              if (models.length === 0) continue
              groups.push({ id, name: String(provider?.name ?? id), models })
            }
            return sendJson(res, 200, { ok: true, providers: groups })
          } catch (error: any) {
            return sendJson(res, 200, { ok: false, providers: [], error: String(error?.message ?? error) })
          }
        }

        if (tail === '/reply' && method === 'POST') {
          const body = await readJsonBody(req) as ReplyBody
          const text = withImageHints(String(body.text ?? '').trim(), body.images)
          if (text === '') return sendJson(res, 400, { ok: false, error: 'empty message' })

          /*
           * 首选：把这个 bot 接到宿主的真 agent 会话上（能读文件 / 跑命令 / 搜索…）。
           *
           * 失败时**必须把原因带回去**（agentError）：早先这里是个空 catch，
           * 于是「agent 建不起来」在界面上表现为「模型说它没有权限」，排查时
           * 完全看不到真正的错误。
           */
          let agentError = ''
          try {
            const turn = await runBotTurn(webCtx, toBotSpec(body), text, () => {})
            if (turn.ok) {
              // 把这一轮用的会话挂进 Seeker-Bot 工作区，避免新会话掉到「未分组」
              await attachOneSession(webCtx, turn.sessionId)
              return sendJson(res, 200, {
                ok: true,
                blocks: turn.blocks,
                mode: 'agent',
                sessionId: turn.sessionId,
              })
            }
            agentError = turn.error ?? 'agent turn 未成功但未给出原因'
          } catch (error: any) {
            agentError = String(error?.message ?? error)
          }

          // 降级：一次 LLM 补全（旧行为，保证界面上还有东西可看）
          const result = await generateReply(webCtx, body)
          return sendJson(res, result.ok ? 200 : 502, { ...result, mode: 'chat', agentError })
        }

        if (tail === '/reply/stream' && method === 'POST') {
          const body = await readJsonBody(req) as ReplyBody
          const text = withImageHints(String(body.text ?? '').trim(), body.images)
          if (text === '') return sendJson(res, 400, { ok: false, error: 'empty message' })

          res.statusCode = 200
          res.setHeader('content-type', 'text/event-stream; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.setHeader('connection', 'keep-alive')
          res.setHeader('x-accel-buffering', 'no')

          const write = (event: PersonalStreamEvent): void => {
            try {
              res.write(`data: ${JSON.stringify(event)}\n\n`)
            } catch {
              /* 客户端已断开：忽略后续写入 */
            }
          }

          try {
            const turn = await runBotTurn(webCtx, toBotSpec(body), text, write)
            /*
             * done 只由 runBotTurn 内部 emit（收口信号），这里**不要**再补一条：
             * 重复的 done 会让前端收口两次。失败路径（agent 建不起来 / 本轮无
             * 输出）由上面 runBotTurn 自己 emit 的 error 事件表达，客户端读到
             * 流结束同样会收口，不依赖这条路由补 done。
             */
            if (!turn.ok && turn.error !== undefined) write({ type: 'error', message: turn.error })
          } catch (error: any) {
            write({ type: 'error', message: String(error?.message ?? error) })
          }
          try {
            res.end()
          } catch {
            /* 已结束 */
          }
          return
        }

        if ((tail === '/journal/image' || tail === '/journal/image/') && method === 'POST') {
          const body = await readJsonBody(req)
          const result = await generateJournalImage(webCtx, body)
          return sendJson(res, result.ok ? 200 : 502, result)
        }

        if (tail === '/journal/asset' && method === 'GET') {
          const name = url.searchParams.get('name') ?? ''
          if (!/^[A-Za-z0-9._-]+$/.test(name)) return sendJson(res, 400, { ok: false, error: 'bad name' })
          const file = resolve(journalDir(), name)
          if (!file.startsWith(resolve(journalDir()) + sep) || !existsSync(file)) {
            return sendJson(res, 404, { ok: false, error: 'not found' })
          }
          const ext = extname(file).toLowerCase()
          const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
          res.statusCode = 200
          res.setHeader('content-type', type)
          res.setHeader('cache-control', 'private, max-age=86400')
          res.end(readFileSync(file))
          return
        }

        /*
         * 媒体文件：bot 工作区里图片 / 视频 / 音频 / PDF / Office 文档的同源访问入口。
         *
         * 图片来自生图落盘（见 host/personal/agent.ts 的 materializeGeneratedImages），
         * 视频来自生视频落盘（materializeGeneratedVideos），文档则是 bot 干活时的真实
         * 产出物。前端直接拿 URL 当 `<img src>` / `<video src>` / iframe，不必把几 MB
         * 的 base64 塞进消息体。
         *
         * 安全面三道闸（缺一道就等于开了个任意文件读）：
         *  1. 路径必须落在允许根内（见 admitWorkspaceFile）；
         *  2. 扩展名必须在白名单（图片 24MB / 其它媒体 256MB，见 MEDIA_CONTENT_TYPES）；
         *  3. 必须是存在的普通文件，且不超过对应族的大小上限。
         *
         * **Range 支持是视频的硬需求**：Chromium 的 `<video>` 靠 206 才能 seek 与
         * 拖进度条；只回 200 全量时播放器只能从头播到底。
         */
        if (tail === '/file' && method === 'GET') {
          const admitted = admitWorkspaceFile(url.searchParams.get('path') ?? '')
          if (!admitted.ok) return sendJson(res, admitted.status, { ok: false, error: admitted.error })
          const target = admitted.path

          const ext = extname(target).toLowerCase()
          const imageType = IMAGE_CONTENT_TYPES[ext]
          const type = imageType ?? MEDIA_CONTENT_TYPES[ext]
          if (type === undefined) return sendJson(res, 403, { ok: false, error: 'forbidden' })

          const info = statFile(target)
          if (info === null) return sendJson(res, 404, { ok: false, error: 'not found' })
          const limit = imageType === undefined ? MAX_MEDIA_FILE_BYTES : MAX_IMAGE_FILE_BYTES
          if (info.size > limit) return sendJson(res, 413, { ok: false, error: 'too large' })

          let bytes: Buffer
          try {
            bytes = readFileSync(target)
          } catch {
            return sendJson(res, 404, { ok: false, error: 'not found' })
          }

          /*
           * Range 解析用**实际读到的字节数**（而不是 stat 的大小）：两者理论上一致，
           * 但文件在 stat 与 read 之间被改写时，以字节数为准才不会回一个越界的
           * content-range（浏览器会直接判播放器错误）。
           */
          const range = parseRangeHeader(req.headers?.range, bytes.byteLength)
          if (range === 'unsatisfiable') {
            res.setHeader('accept-ranges', 'bytes')
            res.setHeader('content-range', `bytes */${bytes.byteLength}`)
            return sendJson(res, 416, { ok: false, error: 'range not satisfiable' })
          }

          res.setHeader('content-type', type)
          // 媒体文件名多半是内容 sha1：同一 URL 永远同一份内容，可以放心缓存一天。
          res.setHeader('cache-control', 'private, max-age=86400')
          res.setHeader('accept-ranges', 'bytes')
          if (range !== null) {
            const slice = bytes.subarray(range.start, range.end + 1)
            res.statusCode = 206
            res.setHeader('content-range', `bytes ${range.start}-${range.end}/${bytes.byteLength}`)
            res.setHeader('content-length', String(slice.byteLength))
            res.end(slice)
            return
          }
          res.statusCode = 200
          res.setHeader('content-length', String(bytes.byteLength))
          res.end(bytes)
          return
        }

        /* ───────────── Office / PDF 预览（复用 src/office 的渲染引擎）───────────── */

        /**
         * 探测一个产出物能不能就地预览。
         *
         * 判据刻意分两层：
         *  · 扩展名不在 RENDERABLE_EXT → `renderable:false`（200，不是错误：前端
         *    据此显示「下载 / 打开」而不是预览按钮）；
         *  · PDF 恒可渲染（浏览器自带查看器，不需要引擎）；Office 需要 LibreOffice
         *    引擎在场，缺引擎时也回 `renderable:false` —— 否则前端会挂一个点了没
         *    反应的预览按钮。
         */
        if ((tail === '/office/info' || tail === '/office/info/') && method === 'GET') {
          const admitted = admitWorkspaceFile(url.searchParams.get('path') ?? '')
          if (!admitted.ok) return sendJson(res, admitted.status, { ok: false, error: admitted.error })
          const info = statFile(admitted.path)
          if (info === null) return sendJson(res, 404, { ok: false, error: 'not-found' })
          if (info.size > MAX_OFFICE_FILE_BYTES) return sendJson(res, 413, { ok: false, error: 'input-too-large' })
          const ext = extname(admitted.path).toLowerCase()
          if (!OFFICE_RENDERABLE_EXT.has(ext)) return sendJson(res, 200, { ok: true, renderable: false })
          if (ext === '.pdf') return sendJson(res, 200, { ok: true, renderable: true })
          try {
            return sendJson(res, 200, { ok: true, renderable: await officeEngineAvailable() })
          } catch {
            return sendJson(res, 200, { ok: true, renderable: false })
          }
        }

        /** 第 N 页 PNG：画廊缩略图与弹窗翻页共用（客户端就是一个 `<img>`）。 */
        if ((tail === '/office/page' || tail === '/office/page/') && method === 'GET') {
          const admitted = admitOfficeFile(url.searchParams.get('path') ?? '')
          if (!admitted.ok) return sendJson(res, admitted.status, { ok: false, error: admitted.error })
          const requested = Number(url.searchParams.get('page') ?? '1')
          const page = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_OFFICE_PAGES, Math.round(requested))) : 1
          try {
            const rendered = await renderOfficePages(admitted.path, [page])
            const entry = rendered.pages.find((candidate) => candidate.page === page) ?? rendered.pages[0]
            if (entry === undefined) return sendJson(res, 404, { ok: false, error: 'page-not-found' })
            const bytes = readFileSync(entry.file)
            res.statusCode = 200
            res.setHeader('content-type', 'image/png')
            res.setHeader('content-length', String(bytes.byteLength))
            res.setHeader('cache-control', 'private, max-age=300')
            res.setHeader('x-content-type-options', 'nosniff')
            // 页数随头部回传：前端不必再单独探一次 info 就能画「1 / N」。
            res.setHeader('x-dsh-page', String(entry.page))
            res.setHeader('x-dsh-page-count', String(rendered.pageCount))
            res.end(bytes)
            return
          } catch (error: any) {
            return sendJson(res, officeErrorStatus(error), { ok: false, error: officeErrorText(error) })
          }
        }

        /** 整份 PDF：`.pdf` 原样转发；Office 走引擎转换（结果在 office 模块里落盘缓存）。 */
        if ((tail === '/office/pdf' || tail === '/office/pdf/') && method === 'GET') {
          const admitted = admitOfficeFile(url.searchParams.get('path') ?? '')
          if (!admitted.ok) return sendJson(res, admitted.status, { ok: false, error: admitted.error })
          try {
            const file = await renderOfficePdf(admitted.path)
            const bytes = readFileSync(file)
            res.statusCode = 200
            res.setHeader('content-type', 'application/pdf')
            res.setHeader('content-length', String(bytes.byteLength))
            res.setHeader('cache-control', 'private, max-age=300')
            res.setHeader('x-content-type-options', 'nosniff')
            res.end(bytes)
            return
          } catch (error: any) {
            return sendJson(res, officeErrorStatus(error), { ok: false, error: officeErrorText(error) })
          }
        }

        /**
         * 用户粘贴 / 选择的图片：前端把 clipboard 里的图转成 data URL 发过来，
         * 这里校验魔数后写进 bot 工作区的 uploads/，返回同源 URL 与相对路径。
         *
         * 为什么落盘而不是把 base64 塞进消息体：localStorage 里几张图就撑满配额；
         * 落盘后消息只存 URL，回读交给 /file（文件名是内容摘要，可放心缓存）。
         */
        if (tail === '/upload' && method === 'POST') {
          const body = await readJsonBody(req)
          const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
          if (dataUrl === '') return sendJson(res, 400, { ok: false, error: '没有收到图片数据' })
          if (dataUrl.length > MAX_UPLOAD_DATA_URL_CHARS) return sendJson(res, 413, { ok: false, error: '图片太大（上限 12MB）' })
          const bytes = decodeDataUrl(dataUrl)
          if (bytes === null) return sendJson(res, 400, { ok: false, error: '图片解码失败' })
          if (bytes.byteLength > MAX_UPLOAD_BYTES) return sendJson(res, 413, { ok: false, error: '图片太大（上限 12MB）' })
          if (!looksLikeImage(bytes)) return sendJson(res, 400, { ok: false, error: '只支持 PNG / JPEG / GIF / WebP' })

          const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 16)
          const fileName = `upload-${digest}.${extensionFor(dataUrl)}`
          const dir = join(botWorkspaceDir(), 'uploads')
          try {
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, fileName), bytes)
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
          const relative = `uploads/${fileName}`
          return sendJson(res, 200, {
            ok: true,
            path: relative,
            url: `${ROUTE}/file?path=${encodeURIComponent(relative)}`,
            name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 120) : fileName,
            bytes: bytes.byteLength,
          })
        }

        if (tail === '/tts' && method === 'POST') {
          const body = await readJsonBody(req)
          const text = String(body.text ?? '').trim().slice(0, 600)
          if (text === '') return sendJson(res, 400, { ok: false, error: 'empty text' })
          const voice = typeof body.voice === 'string' && body.voice !== '' ? body.voice : 'zh-CN-XiaoxiaoNeural'
          const result = await runEdgeTts(text, voice)
          return sendJson(res, result.ok ? 200 : 502, result)
        }

        if (tail === '/asr' && method === 'POST') {
          const body = await readJsonBody(req)
          const audioBase64 = typeof body.audio === 'string' ? body.audio : ''
          if (audioBase64 === '') return sendJson(res, 400, { ok: false, error: 'empty audio' })
          if (speechController === null || typeof speechController.transcribe !== 'function') {
            return sendJson(res, 503, { ok: false, error: 'speech service unavailable' })
          }
          try {
            const request: Record<string, unknown> = { audioBase64 }
            // SenseVoice 只接受它声明过的语言代码；不传时由 provider 自动识别，
            // 不能默认 zh-CN（会直接报 does not support language）。
            if (typeof body.language === 'string' && body.language.trim() !== '') request.language = body.language.trim()
            const transcript = await speechController.transcribe(
              request,
              AbortSignal.timeout(60_000),
            )
            const text = typeof transcript?.text === 'string' ? transcript.text : String(transcript?.transcript ?? '')
            return sendJson(res, 200, { ok: true, text })
          } catch (error: any) {
            return sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
          }
        }

        return sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error: any) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
  })
}
