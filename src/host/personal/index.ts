/**
 * Personal Agent — host 半身。
 *
 * 为前端 Personal Agent 提供真实能力（全部可选，失败时前端自动降级）：
 *
 *   1. POST /api/personal-agent/reply          → 走宿主 ctx.llm.stream 的真实模型回复
 *   2. POST /api/personal-agent/journal/image  → 调用当前生图模型生成期刊宽幅配图（16:9）
 *   3. WS   /api/personal-agent/realtime       → 全双工实时语音（StepFun Realtime 代理，
 *                                                见 ./realtime/；取代了原 Edge TTS 半双工通话）
 *   4. POST /api/personal-agent/asr            → 宿主 speechController（SenseVoice）转写
 *   5. GET  /api/personal-agent/journal/asset  → 已生成期刊配图的静态文件
 *   6. 期刊日记（宿主生成 + 落盘 + 调度，全部实现见 ./journal.ts）：
 *      GET    /api/personal-agent/journal/list     → 全部期刊（按 generatedAt 倒序）
 *      GET    /api/personal-agent/journal/status   → 规则 / 触发日志 / 是否正在生成
 *      POST   /api/personal-agent/journal/generate → 真实模型生成一期并落盘
 *      POST   /api/personal-agent/journal/check    → 规则判定（与调度器 tick 同一实现）
 *      POST   /api/personal-agent/journal/rule     → 保存触发规则
 *      POST   /api/personal-agent/journal/feed     → 同步当天对话素材（48h / 500 条）
 *      DELETE /api/personal-agent/journal?id=      → 删除一期期刊
 *   7. GET  /api/personal-agent/file           → bot 工作区里的媒体文件（图片 / 视频 / 音频 /
 *                                                PDF / Office 文档；视频与音频支持 HTTP Range）
 *   8. GET  /api/personal-agent/office/info    → 产出物可否预览（复用 src/office 的扩展名表）
 *   9. GET  /api/personal-agent/office/page    → Office / PDF 的第 N 页 PNG（复用 src/office 引擎）
 *  10. GET  /api/personal-agent/office/pdf     → 整份 PDF（.pdf 原样转发，Office 走引擎转换）
 *
 * 设计约束：
 *  - 不引入 @deepseek-ai/* 运行时依赖（本仓库 host 产物必须自包含）；
 *  - 所有路由失败一律 JSON，不抛穿；跨站写请求拒绝；
 *  - 大模型回复只回纯文本 blocks；任何异常都让前端回退到本地引擎，不影响演示。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { botWorkspaceDir, cancelBotTurn, ensureBotAgent, getLastTurnDebug, resetBotConversation, runBotTurn, type BotAgentSpec, type PersonalStreamEvent } from './agent.ts'
import { scanBotOutputs } from './outputs.ts'
import { recallBotTurn } from './recall.ts'
import { botRoomOf, buildRoomContextBlock, setBotRoom } from './room-context.ts'
import { addApprovalRule, approvalRulesFile, decideApproval, pendingApprovalCount, readApprovalRules, removeApprovalRule, type ApprovalChoice, type ApprovalRisk } from './approval.ts'
import { answerQuestion, pendingQuestionCount } from './questions.ts'
import { currentSeq, parseSinceByBot, publish, subscribe, subscribeAll } from './events.ts'
import { readCreatedBots, removeCreatedBot } from './bot-create.ts'
import { purgeBot } from './bot-delete.ts'
import { applyPersonalAgentScheduler, nextProactiveAt, nextRoutineAt, normalizeNoDataPolicy, normalizeRetryPolicy, readProactive, readRoutines, readServerMessages, runProactiveNow, writeProactive, writeRoutines, type HostProactive, type HostRoutine } from './scheduler.ts'
import { buildWorkingMemoryBlock, createWorkingMemoryMessage, injectWorkingMemoryIntoAgent, pruneWorkingTasks, readWorkingTasks, resetWorkingMemoryInjection, upsertWorkingTask, workingMemoryFile, type WorkingTask } from './working-memory.ts'
import { clearRelayBrief, generateRelayBrief, injectRelayIntoAgent, readRelayBrief, resetRelayInjection, writeRelayBrief } from './relay.ts'
import { normalizeRelayBrief } from '../../shared/relay.ts'
import { listPages, readPage, writePage } from './pages.ts'
import {
  checkJournalTrigger,
  deleteJournalRecord,
  generateJournalImage,
  generateJournalWithModel,
  isJournalGenerating,
  journalDir,
  readJournalLogs,
  readJournalRuleState,
  readJournals,
  writeJournalFeed,
  writeJournalRuleState,
  type GenerateJournalRequest,
} from './journal.ts'
import type { JournalStatus } from '../../shared/journal.ts'
import { getWebuiMemoryStore } from '../../triad/memory-store-singleton.ts'
import { projectHashOf } from '../../triad/memory/engine/store.ts'
import { decodeDataUrl, extensionFor, looksLikeImage, materializeRoot } from '../../spill/materialize.ts'
import { __test as officeInternals, officeEngineAvailable, renderOfficePages, renderOfficePdf } from '../../office/index.ts'
import { applyPersonalAgentRealtime, type PersonalRealtimeConfig } from './realtime/mount.ts'
import { rememberBotSpec, startPersonalRuntime } from './runtime/host.ts'
import { personalRuntime } from './runtime/registry.ts'

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
 * 工具结果全文的扩展名白名单（**只对 tool-results 根生效**）。
 *
 * 为什么不能把 `.txt` 加进 `MEDIA_CONTENT_TYPES`：那会让 bot 工作区里的任意
 * 文本文件都能通过 `/file` 读出来。工作区是用户的交付物目录，`.txt` 里有可能是
 * 随手记的敏感内容；而 tool-results 是插件自己写的「模型看到的同一段文本」，
 * 前端点「查看完整结果」必须能读回来，两者不是一回事。
 */
const TOOL_RESULT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain; charset=utf-8',
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

/*
 * journalDir() / dshHome() 已搬到 ./journal.ts：期刊的存储、生成、生图现在都在
 * 同一个模块里，index.ts 只 import 它导出的 `journalDir`（/journal/asset 与
 * 文件准入的允许根还要用）。
 */

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

/**
 * 工具结果全文的根目录（与 agent.ts 的 `toolResultFile` 同口径）。
 *
 * 必须与 agent.ts 的落盘路径**逐字对齐**：那边写
 * `<dshHome>/storages/dsh-seeker-bot/personal-agent/tool-results/<sessionId>/<callId>.txt`，
 * 这里少一层目录就会出现「模型说完整结果在某个路径、前端一点就 403」的割裂。
 *
 * 为什么把它加进允许根：工具结果被摘要化（1.3）之后，完整内容只在这里，前端
 * 「查看完整结果」只能靠 `/file` 读回来。但**只放开这一个子树**——
 * `storages/` 下还有记忆库、插件状态等，整目录放开等于开了个任意读。
 */
function toolResultsRoot(): string {
  const env = process.env.DSH_HOME
  const home = typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-seeker-bot', 'personal-agent', 'tool-results')
}

/** 一次路径准入的结果：通过时给绝对路径与命中的允许根，失败时给 HTTP 状态与错误码。 */
type AdmitVerdict =
  | { readonly ok: true; readonly path: string; readonly root: string }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * 把请求里的 `path` 解析成允许根内的绝对路径。
 *
 * 安全面三道闸（缺一道就等于开了个任意文件读）：
 *  1. 相对路径以 bot 工作区为基准解析；绝对路径照收，但**必须**落在允许根
 *     （bot 工作区 / 期刊目录 / 生图落盘根 / 工具结果全文根）之内 —— 解析后的
 *     路径要等于根或在「根 + 分隔符」之内，防止 `..` 与同前缀兄弟目录
 *     （Seeker-Bot2）越界；
 *  2. 扩展名白名单（调用方各自判；工具结果根多认一个 `.txt`）；
 *  3. 必须是存在的普通文件、且在各自的大小上限内（调用方各自判）。
 *
 * 返回命中的 `root` 让调用方做**按根区分的策略**（比如 `.txt` 只在工具结果根
 * 下允许），而不是把不同根的权限混成一张全局白名单。
 */
function admitWorkspaceFile(raw: string): AdmitVerdict {
  if (raw === '') return { ok: false, status: 400, error: 'empty path' }
  const target = resolve(isAbsolute(raw) ? raw : join(botWorkspaceDir(), raw))
  const normalized = normalizeForCompare(target)
  const hit = [botWorkspaceDir(), journalDir(), materializeRoot(), toolResultsRoot()].find((root) => {
    const base = normalizeForCompare(root)
    return normalized === base || normalized.startsWith(`${base}/`)
  })
  if (hit === undefined) return { ok: false, status: 403, error: 'forbidden' }
  return { ok: true, path: target, root: hit }
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
    /**
     * 是不是用户的主 Bot。决定宿主给不给它挂 `bot_create`（创建子 Bot）。
     * 缺省按 `false`——宁可少给一个工具，也不能把全局权限发错人。
     */
    isMain?: boolean
  }
  text?: string
  history?: Array<{ role?: string; text?: string; name?: string }>
  memories?: string[]
  /**
   * 本轮附带的「全量 Bot 花名册」（可选，向后兼容）。
   *
   * 为什么需要：派活时宿主必须知道「子 Bot 是谁」，而 Bot 配置一直由前端持有。
   * 只靠 `/reply` 里那一个 `bot` 缓存，会让「从没跟用户聊过的 Bot」派不出去。
   * 前端带上这份名单后，派活就不再有这个盲区。
   *
   * 只要求身份 + 模型字段；`memories` 不要带——那些每轮变化，缓存旧值会让子 Bot
   * 用上过期的记忆。
   */
  roster?: Array<{
    id?: string
    name?: string
    role?: string
    description?: string
    instructions?: string
    model?: { provider?: string; model?: string; effort?: string }
    isMain?: boolean
  }>
  /**
   * 本轮用户附带的图片（前端先走 /upload 落盘，这里只带相对路径）。
   *
   * bot 的 user 消息只有 text content，没有多模态 image part；所以图片不进
   * 消息体，而是把「落在哪」告诉模型，让它需要时自己 read_image。
   */
  images?: Array<{ path?: string; name?: string }>
  /** 该 bot 自己的工具权限档位（缺省按完全权限）。 */
  permission?: 'full' | 'approval'
  /**
   * 这一轮从哪个群里发起的（群聊回合才有；私聊缺省）。
   *
   * 为什么路由要收它：审批卡 / 问答卡是宿主异步发的，只认 botId，不带群 id 就会
   * 落进该 Bot 的私聊，群聊视图永远看不到那张卡。前端每轮带上来，这里登记进
   * `room-context`，卡片发布时再取回。
   */
  roomId?: string
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
    isMain: bot.isMain === true,
    memories: Array.isArray(body.memories)
      ? body.memories.filter((item): item is string => typeof item === 'string')
      : undefined,
  }
}

/**
 * 把请求带来的「全量 Bot 花名册」记进宿主的配置缓存。
 *
 * 派活要能派给一个**从没在这个对话里出现过**的 Bot，所以不能只靠 `/reply` 里
 * 那一个 `bot` 字段。字段缺失时静默跳过（老前端不带这个字段，行为不变）。
 */
function rememberRoster(roster: ReplyBody['roster']): void {
  if (!Array.isArray(roster)) return
  for (const item of roster) {
    const id = String(item?.id ?? '').trim()
    if (id === '') continue
    rememberBotSpec({
      botId: id,
      name: String(item?.name ?? '助手'),
      role: String(item?.role ?? '通用助手'),
      description: String(item?.description ?? ''),
      instructions: String(item?.instructions ?? ''),
      ...(item?.model === undefined ? {} : { model: item.model }),
      isMain: item?.isMain === true,
    })
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

/* ───────────────────── 记忆写入 / 工作记忆（路线图 0.2）───────────────────── */

/**
 * 把一条内容写进该 Bot 自己的记忆库（owner = `bot:<botId>`，项目 = bot 工作区）。
 *
 * 为什么不让调用方直接调 `/api/dsh-memory/remember`：那条路由要求显式
 * `projectHash`，而前端 / 工作记忆都不该硬编码 bot 工作区的 hash——它随盘符和
 * 安装位置变化，写死一份会在换机器后把记忆写到另一个项目下。这里用
 * `botWorkspaceDir()` 现算，owner 由 botId 推导。
 *
 * 面板「添加记忆」与「工作记忆任务完成后的工作日志」共用这一个实现：两处各写
 * 一份，迟早会出现 owner / provenance 字段漂移，然后一半记忆在面板里看不见。
 *
 * @returns `ok=false` 时 `error` 说明为什么没写进去（引擎未启动 / 写入异常）。
 */
async function rememberBotMemory(
  store: any,
  botId: string,
  content: string,
  options?: { tags?: string[]; importance?: number; source?: string },
): Promise<{ ok: boolean; created: boolean; id: string; error?: string }> {
  if (store === undefined || store === null || typeof store.upsertEntry !== 'function') {
    return { ok: false, created: false, id: '', error: 'memory engine unavailable' }
  }
  try {
    const projectHash = projectHashOf(botWorkspaceDir())
    // 项目档案不存在时补一份，否则面板「项目」列表里看不到 bot 工作区。
    try {
      const meta = typeof store.readProjectMeta === 'function' ? await store.readProjectMeta(projectHash) : undefined
      if (meta === undefined && typeof store.writeProjectMeta === 'function') {
        await store.writeProjectMeta(projectHash, {
          path: botWorkspaceDir(),
          alias: 'Seeker-Bot',
          locked: false,
        })
      }
    } catch {
      /* 档案补写失败不影响记忆本身落库 */
    }
    const { created, entry } = await store.upsertEntry({
      content,
      scope: 'project',
      projectHash,
      owner: `bot:${botId}`,
      tags: options?.tags ?? [],
      importance: typeof options?.importance === 'number' && Number.isFinite(options.importance)
        ? Math.max(1, Math.min(10, Math.round(options.importance)))
        : 8,
      source: options?.source ?? 'manual',
      provenance: { sessionId: `pa-bot-v2-${botId}` },
    })
    return { ok: true, created, id: String(entry?.id ?? '') }
  } catch (error: any) {
    return { ok: false, created: false, id: '', error: String(error?.message ?? error) }
  }
}

/**
 * 在跑一轮回复之前把工作记忆投给 agent（路线图 0.2 的「每轮注入」）。
 *
 * 为什么放在 `runBotTurn` 之前、而不是拼进用户消息：`agent.inject()` 写入的是
 * 「面向模型的上下文」，前端看不到，也不会被记忆提取当成用户原话。先注入、
 * 再 followup 用户消息，模型第一步就能看到任务状态——不依赖历史有没有被压缩。
 *
 * 失败一律吞掉：工作记忆是增强项，它坏了不能连累对话本身（runBotTurn 会
 * 自己把「agent 建不起来」的错误报出来）。
 */
async function injectWorkingMemoryForReply(ctx: any, spec: BotAgentSpec): Promise<void> {
  try {
    const agent = await ensureBotAgent(ctx, spec)
    await injectWorkingMemoryIntoAgent(agent, spec.botId)
    // 接力摘要：手动轮转后的新会话靠它接着上一段干（见 ./relay.ts）
    await injectRelayIntoAgent(agent, spec.botId)
  } catch {
    /* agent 建不起来：交给 runBotTurn 报错 */
  }
}

/**
 * 在跑一轮群聊回复之前，把本群之前的对话作为 developer 消息投给 agent。
 *
 * 为什么需要：每个 Bot 只有一条终身会话，群消息并不在其中——不注入的话，被 @
 * 的成员看不到其他成员说过什么，「多视角评审」会退化成三个互不知情的单聊。
 * 私聊回合（`body.roomId` 缺省）不注入，避免把别处的群上下文串进私聊。
 *
 * 消息结构复用 working-memory 的 `createWorkingMemoryMessage`：同样是面向模型的
 * developer 消息、同样要深冻结，只是内容来源不同。
 *
 * 失败一律吞掉：群上下文是增强项，它坏了不能连累对话本身。
 */
async function injectRoomContextForReply(ctx: any, spec: BotAgentSpec, body: ReplyBody): Promise<void> {
  try {
    const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : ''
    if (roomId === '') return
    const text = buildRoomContextBlock(body.history ?? [])
    if (text === '') return
    const agent = await ensureBotAgent(ctx, spec)
    if (agent === null || typeof agent !== 'object' || typeof agent.inject !== 'function') return
    agent.inject(createWorkingMemoryMessage(text))
  } catch {
    /* 群上下文是增强项：注入失败不影响这一轮对话 */
  }
}

/**
 * 把前端 / 模型传来的任务对象收敛成合法的 `WorkingTask`。
 *
 * 工作记忆是**每轮进上下文**的东西，字段不收敛会一路放大：超长标题白占 token、
 * 坏 status 让注入文本出现「undefined 状态」、非字符串 facts 让 join 出
 * `[object Object]`。这里逐字段夹取，缺 title 返回 null（路由回 400）。
 */
function normalizeWorkingTask(input: unknown, now: number): WorkingTask | null {
  if (input === null || typeof input !== 'object') return null
  const record = input as Record<string, any>
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 200) : ''
  if (title === '') return null
  const rawId = typeof record.id === 'string' ? record.id.trim().slice(0, 64) : ''
  const id = rawId !== '' ? rawId : `task-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const status: WorkingTask['status'] = record.status === 'waiting' || record.status === 'done' || record.status === 'failed'
    ? record.status
    : 'active'

  const steps: WorkingTask['steps'] = Array.isArray(record.steps)
    ? record.steps.slice(0, 20).flatMap((item: unknown): Array<{ label: string; status: 'todo' | 'doing' | 'done' }> => {
      if (item === null || typeof item !== 'object') return []
      const step = item as Record<string, unknown>
      const label = typeof step.label === 'string' ? step.label.trim().slice(0, 120) : ''
      if (label === '') return []
      const stepStatus: 'todo' | 'doing' | 'done' = step.status === 'done' || step.status === 'doing' ? step.status : 'todo'
      return [{ label, status: stepStatus }]
    })
    : []

  const facts: Record<string, string> = {}
  if (record.facts !== null && typeof record.facts === 'object' && !Array.isArray(record.facts)) {
    for (const [key, value] of Object.entries(record.facts as Record<string, unknown>).slice(0, 20)) {
      const safeKey = String(key).trim().slice(0, 40)
      if (safeKey === '') continue
      facts[safeKey] = String(value ?? '').slice(0, 200)
    }
  }

  const stringList = (value: unknown, limit: number, maxLength: number): string[] => (
    Array.isArray(value)
      ? value
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim().slice(0, maxLength))
        .slice(0, limit)
      : []
  )

  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : now
  const ttlRaw = Number(record.ttlDays)
  const ttlDays = Number.isFinite(ttlRaw) ? Math.max(1, Math.min(365, Math.round(ttlRaw))) : undefined
  return {
    id,
    title,
    status,
    steps,
    facts,
    artifacts: stringList(record.artifacts, 20, 500),
    blockers: stringList(record.blockers, 10, 200),
    updatedAt,
    ...(ttlDays !== undefined ? { ttlDays } : {}),
  }
}

/** 把一条完成的任务翻译成「工作日志」记忆正文（标题 + 产出 + 日期）。 */
function workingLogContent(task: WorkingTask, now = Date.now()): string {
  /*
   * 日期用**本地时区**而不是 `toISOString()`：后者是 UTC，东八区晚上 8 点之后
   * 会写成「明天」，用户回看工作日志时日期对不上。
   */
  const date = new Date(now)
  const dateText = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const lines = [`工作日志（${dateText}）：${task.title}`]
  if (task.artifacts.length > 0) lines.push(`产出：${task.artifacts.slice(0, 10).join('、')}`)
  const factText = Object.entries(task.facts).map(([key, value]) => `${key}=${value}`).join('，')
  if (factText !== '') lines.push(`关键数据：${factText}`)
  lines.push('状态：已完成')
  return lines.join('\n')
}


/* ───────────────────────────── 生图 ───────────────────────────── */

/*
 * 生图（期刊封面）已搬到 ./journal.ts。
 *
 * `generateJournalImage` 与它的辅助函数（model-capabilities 读取 / provider 配置
 * 解析 / 凭据解析 / 远程图转 data URL）现在都在那边，index.ts 只保留
 * `/journal/image` 路由并 import 它——同一份逻辑留两处，迟早会漂移成
 * 「按钮生成的图和期刊封面用的模型不一样」。
 */

/*
 * generateJournalImage 的实体在 ./journal.ts（见上方注释）。这里只保留路由，
 * 由路由把请求体转交给它，行为逐字未变。
 */


/* ───────────────────────────── 路由装配 ───────────────────────────── */

/**
 * 把 bot 会话从 Work 的工作区里**摘掉**（会话列表隔离）。
 *
 * 早先这里做的是反过来的事：把每个 `pa-bot-*` 会话 attach 进 Seeker-Bot 工作区，
 * 于是 Bot 的对话出现在 Work 侧栏的会话列表里。既然两边是两套隔离的 agent，
 * 列表就不该混在一起。
 *
 * 光「不再 attach」不够——**历史上已经挂上去的还在**（workspace 的 sessionIds
 * 是持久化的），所以启动时要主动 detach 一遍。
 */
async function detachBotSessions(ctx: any, workspace: any): Promise<void> {
  if (workspace === undefined || workspace === null) return
  if (typeof workspace.detachSession !== 'function') return

  const ids = new Set<string>()
  try {
    const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
    if (typeof persistence?.list === 'function') {
      const list = await persistence.list()
      for (const snapshot of Array.isArray(list) ? list : []) {
        const id = String(snapshot?.header?.id ?? snapshot?.id ?? '')
        if (id.startsWith('pa-bot-')) ids.add(id)
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
        if (id.startsWith('pa-bot-')) ids.add(id)
      }
    }
  } catch {
    /* 忽略 */
  }

  for (const id of ids) {
    try {
      await workspace.detachSession(id)
    } catch {
      /* 单个会话不在该工作区 / 服务拒绝：跳过 */
    }
  }
}

/**
 * 把已有的 bot 会话一次性挂到 Seeker-Bot 工作区下。
 *
 * @deprecated 已停用（2026-11-02）。Bot 与 Work 是两套隔离的 agent，Bot 的会话
 * 不该出现在 Work 侧栏的会话列表里。函数保留只为需要回退时改一行调用即可。
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

/**
 * 把一个新会话挂到 Seeker-Bot 工作区（每轮对话后调用，保证新会话立刻归位）。
 *
 * @deprecated 已停用（2026-11-02），理由同 {@link attachBotSessions}。
 */
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

/* ───────────────────── 压缩事件（路线图 1.1）───────────────────── */

/**
 * 一次压缩的待结算状态。
 *
 * 宿主在压缩事务里先 append `compaction/summary`（摘要内容落地），再 append
 * `compaction/end`（事务结束，失败时带 error）。两个事件都可能单独出现：
 * · 只听 end —— 摘要可能还没解析出来；
 * · 只听 summary —— 进程被杀在两者之间时 end 永远不会来。
 * 所以这里「summary 缓存 + 短兜底定时器 + end 权威结算」，并用 compactionId 去重。
 */
interface PendingCompaction {
  compactionId: string
  summary: string
  shadowedTokenCount?: number
  timer?: NodeJS.Timeout
}

const pendingCompactions = new Map<string, PendingCompaction>()

/** 已经推送过的压缩 id：兜底定时器与 end 都触发时只推一条标记。 */
const settledCompactionIds = new Set<string>()

/** summary 之后等 end 的宽限（end 是同一事务里同步 append 的，正常远小于这个值）。 */
const COMPACTION_SETTLE_MS = 1_500

/** 去重集合上限：压缩是低频事件，200 足够；超了整体清空，不维护 LRU。 */
const COMPACTION_ID_MEMORY = 200

/** `pa-bot-<botId>` → botId；不是 Bot 会话返回 null（Work 会话不归这里管）。 */
function botIdOfSession(sessionId: string): string | null {
  const prefix = 'pa-bot-'
  if (!sessionId.startsWith(prefix)) return null
  const botId = sessionId.slice(prefix.length)
  return botId === '' ? null : botId
}

/**
 * 推送一条压缩事件。
 *
 * 走事件总线（`/events` 的常驻 SSE）而不是 `/reply/stream`：压缩可能发生在后台
 * （例行任务跑长会话时触发压力压缩），那一刻未必有聊天请求连着；事件总线带
 * seq，前端断线重连还能补发。
 *
 * `events.ts` 的 BotEvent 联合类型暂未收录这个事件（本任务的写作用域只有
 * index.ts + pages.ts），所以这里用断言推。前端按 `payload.type` 分支，未知
 * 类型会被安全忽略（store.tsx 只认 message / message-update / journal）。
 */
function publishCompactionEvent(botId: string, payload: {
  compactionId: string
  summary: string
  shadowedTokenCount?: number
  failed?: boolean
}): void {
  if (payload.compactionId !== '') {
    if (settledCompactionIds.has(payload.compactionId)) return
    settledCompactionIds.add(payload.compactionId)
    if (settledCompactionIds.size > COMPACTION_ID_MEMORY) settledCompactionIds.clear()
  }
  publish(botId, {
    type: 'compaction',
    at: Date.now(),
    summary: payload.summary,
    ...(payload.shadowedTokenCount !== undefined ? { shadowedTokenCount: payload.shadowedTokenCount } : {}),
    ...(payload.failed === true ? { failed: true } : {}),
  } as any)
}

/**
 * 监听宿主的压缩生命周期，转成 SSE 事件（路线图 1.1）。
 *
 * 为什么注册在 root ctx：`compaction/*` 是 session 级事件，Bot 的会话与 Work 的
 * 会话走同一条总线，必须按 session id 认领（`pa-bot-` 前缀）才不会把 Work 的
 * 压缩标记推进 Bot 对话里。
 *
 * 失败不抛穿：收不到标记最多是少一个提示，不该连累插件挂载。
 */
function installCompactionWatcher(ctx: any): void {
  if (typeof ctx?.on !== 'function') return
  ctx.on('session/event', (session: any, event: any) => {
    const type = String(event?.type ?? '')
    if (type !== 'compaction/summary' && type !== 'compaction/end') return
    const sessionId = String(session?.id ?? '')
    const botId = botIdOfSession(sessionId)
    if (botId === null) return
    const data = (event?.data ?? {}) as Record<string, any>
    const compactionId = String(data.compactionId ?? '')

    if (type === 'compaction/summary') {
      const previous = pendingCompactions.get(sessionId)
      if (previous?.timer !== undefined) clearTimeout(previous.timer)
      const pending: PendingCompaction = {
        compactionId,
        // 任务要求：取 summary 事件里的摘要，没有就给空字符串
        summary: typeof data.summary === 'string' ? data.summary : '',
        ...(typeof data.shadowedTokenCount === 'number' ? { shadowedTokenCount: data.shadowedTokenCount } : {}),
      }
      /*
       * 兜底定时器：end 迟迟不来（进程被杀 / 宿主版本只发 summary）时，至少让
       * 前端知道「压缩发生过」。unref 不钉住事件循环。
       */
      pending.timer = setTimeout(() => {
        pendingCompactions.delete(sessionId)
        publishCompactionEvent(botId, {
          compactionId: pending.compactionId,
          summary: pending.summary,
          ...(pending.shadowedTokenCount !== undefined ? { shadowedTokenCount: pending.shadowedTokenCount } : {}),
        })
      }, COMPACTION_SETTLE_MS)
      pending.timer.unref?.()
      pendingCompactions.set(sessionId, pending)
      return
    }

    // compaction/end：压缩事务结束（失败时也发，带 error）
    const pending = pendingCompactions.get(sessionId)
    if (pending?.timer !== undefined) clearTimeout(pending.timer)
    pendingCompactions.delete(sessionId)
    publishCompactionEvent(botId, {
      // summary 没赶在 end 之前落地时给空串（前端只显示「上下文已压缩」）
      compactionId: pending !== undefined && pending.compactionId !== '' ? pending.compactionId : compactionId,
      summary: pending?.summary ?? '',
      ...(pending?.shadowedTokenCount !== undefined ? { shadowedTokenCount: pending.shadowedTokenCount } : {}),
      ...(data.error !== undefined ? { failed: true } : {}),
    })
  })
}

export function applyPersonalAgentHost(ctx: any, config?: { personalRealtime?: PersonalRealtimeConfig }): void {
  /*
   * 全双工实时语音（Bot 模式通话）：浏览器同源 WebSocket ⇄ 宿主 ⇄ StepFun Realtime。
   *
   * 它取代了原来的半双工链路（点按录音 → SenseVoice ASR → 模型 → Edge TTS），
   * 所以这里不再有 TTS 路由。凭据/上游/音色由插件 config 的 personalRealtime
   * 或 settings 命名空间 personal-realtime 控制，一个字段都不配也能跑
   * （默认 STEPPLAN_API_KEY + 官方地址 + 模型回退链）。
   *
   * 失败不阻塞插件挂载：实时语音起不来最多是「通话不可用」，不该连累 Bot 模式本身。
   */
  try {
    applyPersonalAgentRealtime(ctx, config?.personalRealtime ?? {})
  } catch (error) {
    console.warn('[personal-agent] 实时语音路由挂载失败（通话将不可用）:', error instanceof Error ? error.message : error)
  }

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
   * 例行任务调度器：宿主侧常驻，页面关掉也照跑。
   *
   * 失败不阻塞插件挂载——调度起不来最多是「例行任务不自动跑」，而整个 Bot 模式
   * 起不来是更严重的故障。留痕是为了让这种情况可排查。
   */
  try {
    const disposeScheduler = applyPersonalAgentScheduler(ctx)
    ctx?.effect?.(() => disposeScheduler)
  } catch (error) {
    console.warn('[personal-agent] 例行任务调度器启动失败（例行任务将不会自动执行）:', error instanceof Error ? error.message : error)
  }

  /*
   * 作业运行时：把 Bot 的执行从「一次函数调用」变成「一条持久记录」。
   *
   * 它是「主 Bot 能给子 Bot 派活、能等结果、进程重启后还知道谁做到哪」的前提。
   * 启动顺序有讲究：`open()` 必须在第一次 tick 之前跑（要做崩溃恢复），
   * `startPersonalRuntime` 内部已经保证。
   *
   * 失败不阻塞插件挂载：运行时起不来最多是「不能派活」，Bot 照常能对话。
   */
  try {
    const started = startPersonalRuntime(ctx)
    if (started !== undefined) {
      ctx?.effect?.(() => started.runtime.close())
    }
  } catch (error) {
    console.warn('[personal-agent] 作业运行时启动失败（Bot 将不能派活）:', error instanceof Error ? error.message : error)
  }

  /*
   * 压缩事件推送（路线图 1.1）：前端据此在对话流里插入「上下文已压缩 · N 条消息
   * 折叠」标记。注册在这里而不是 `/events` 路由里，是因为压缩可能发生在后台
   * （例行任务跑长会话时触发压力压缩），那一刻未必有 HTTP 连接。
   */
  try {
    installCompactionWatcher(ctx)
  } catch (error) {
    console.warn('[personal-agent] 压缩事件监听注册失败（前端不会收到上下文压缩标记）:', error instanceof Error ? error.message : error)
  }

  /*
   * Work 侧栏的工作区列表里**不要出现 Seeker-Bot**。
   *
   * Bot 与 Work 是两套隔离的 agent：Bot 的工作目录（`D:\Seeker-Bot`）只给 bot
   * 干活用，不该在 Work 的工作区列表里占一个条目——那里既没有 Bot 的会话，
   * 也不该成为进入 Bot 世界的入口。
   *
   * 光「不再 create」不够：早先版本登记过，`workspace` 的注册是持久化的。
   * 所以启动时主动把路径等于 bot 工作目录的那条注册删掉（`delete()` 只删注册，
   * 目录和会话日志都保留），顺带把其它工作区里残留的 `pa-bot-*` 会话摘干净。
   */
  try {
    ctx.inject(['workspaceRegistry'], (wsCtx: any) => {
      void (async () => {
        try {
          const registry = wsCtx.workspaceRegistry
          if (registry === undefined || registry === null) return
          const target = botWorkspaceDir()
          const workspaces = typeof registry.list === 'function' ? (registry.list() ?? []) : []
          for (const workspace of workspaces) {
            if (String(workspace?.path ?? '') === target) {
              if (typeof registry.delete === 'function' && typeof workspace.id === 'string') {
                await registry.delete(workspace.id)
              }
              continue
            }
            // 其它工作区：只摘 bot 会话，工作区本身保留
            await detachBotSessions(wsCtx, workspace)
          }
        } catch {
          /* 服务不可用：Bot 本身照常能干活，只是侧栏可能还留着旧条目 */
        }
      })()
    })
  } catch {
    /* workspace 服务不存在：跳过 */
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
              'relay', 'relay/prepare', 'relay/commit',
              'journal/image', 'journal/asset',
              'journal/list', 'journal/status', 'journal/generate', 'journal/check', 'journal/rule', 'journal/feed',
              'asr',
              'realtime', 'realtime/diagnose',
              'file', 'upload', 'outputs',
              'office/info', 'office/page', 'office/pdf',
              'memory/remember',
              'working-memory',
              'approval/rules',
              'pages',
              'events', 'routines', 'messages', 'bots/created', 'bots',
            ],
          })
        }

        /*
         * 常驻事件流（SSE）：bot 在用户没发消息时也能推消息过来。
         *
         * 这是从「请求-响应」跨到 always-on 的唯一硬门槛——例行任务结果、后台发现、
         * 审批到期都靠它落地。`since` 用于断线重连补发（见 events.ts 的有界缓冲）。
         *
         * 注意这里**不走 sendJson**：它要一条不结束的响应。
         */
        if (tail === '/events' && method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const botId = url.searchParams.get('botId') ?? ''
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          /*
           * `botId=*` = 一条连接订阅全部 Bot。
           *
           * 前端原来给每个 Bot 建一条常驻 SSE，而浏览器对同一 origin 的 HTTP/1.1
           * 并发上限只有 6 条：4 个 Bot 就吃掉 4 条，新建 Bot 时前端「关掉全部再建
           * 全部」的瞬时翻倍会顶破上限，之后所有请求排队，界面看起来就是「服务断了」。
           * 合并成一条连接后，Bot 数量与连接数彻底解耦。
           *
           * 补发游标也随之从单个数字变成逐 Bot 的表（`botA:5,botB:3`）：一条连接
           * 覆盖多个通道，而各通道的序号是独立的，共用一个 since 会补错。
           */
          const sinceRaw = url.searchParams.get('since') ?? '0'
          res.writeHead?.(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            // 反代（nginx / Cloudflare）默认缓冲响应体，事件会被攒着不发
            'x-accel-buffering': 'no',
          })
          const write = (payload: unknown): void => {
            try {
              res.write(`data: ${JSON.stringify(payload)}\n\n`)
            } catch {
              /* 连接已断：订阅会在 close 时被清掉 */
            }
          }
          let unsubscribe: () => void
          if (botId === '*') {
            // 合并连接没有「单一序号」可言，hello 只用于告知连接已就绪
            write({ type: 'hello', botId: '*', seq: 0 })
            unsubscribe = subscribeAll(write, parseSinceByBot(sinceRaw))
          } else {
            const sinceNum = Number(sinceRaw)
            const since = Number.isFinite(sinceNum) && sinceNum > 0 ? Math.round(sinceNum) : 0
            // 先把当前序号告诉前端，便于它下次重连时带上 since
            write({ type: 'hello', botId, seq: currentSeq(botId) })
            unsubscribe = subscribe(botId, write, since)
          }
          const heartbeat = setInterval(() => {
            try {
              res.write(': ping\n\n')
            } catch {
              /* 连接已断 */
            }
          }, 25_000)
          // 不把 Node 事件循环钉住：宿主常驻时无所谓，但测试/一次性脚本会退不出去
          heartbeat.unref?.()
          const cleanup = (): void => {
            clearInterval(heartbeat)
            unsubscribe()
            try {
              res.end()
            } catch {
              /* 已结束 */
            }
          }
          req.on?.('close', cleanup)
          req.on?.('error', cleanup)
          return
        }

        /*
         * 宿主建过的子 Bot（`bot_create` 的账本）。
         *
         * 为什么前端要拉一次：SSE 只在页面**开着**的时候才送达。用户关着页面时
         * 主 Bot 照样可能建 Bot（例行任务触发的轮次、手机上另一个窗口），那一次
         * 广播就丢了。启动时拉一遍这个账本，才能把「建过但没见过」的补齐。
         * 前端按 id 去重，重复拉无害。
         */
        if (tail === '/bots/created' && method === 'GET') {
          return sendJson(res, 200, { ok: true, bots: readCreatedBots() })
        }
        /*
         * 前端删掉子 Bot 时顺手抹账本。
         *
         * 不抹的话，下次页面加载 `/bots/created` 会把它重新补回来——用户会看到
         * 一个「删不掉的 Bot」。这是补发机制必须配对的另一半。
         */
        if (tail === '/bots/created' && method === 'DELETE') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const botId = (url.searchParams.get('botId') ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          return sendJson(res, 200, { ok: true, removed: removeCreatedBot(botId) })
        }

        /*
         * 彻底删除一个 Bot：宿主侧的全部残留（会话历史 / 花名册 / 工作记忆 /
         * 产出物映射 / Bot 页面 / 记忆条目 / 例行任务 / 账本）。
         *
         * 为什么不复用上面那条 `DELETE /bots/created`：那条只抹**账本**（防补发），
         * 是「前端已经删了」的配套动作；这条是把 Bot 真正从宿主抹掉。两者语义
         * 差着一个数量级，混在一起会让「只想防补发」的调用意外删光数据。
         *
         * `purgeFiles=1` 才连产出物目录一起删——默认保留用户的文件。
         */
        if (tail === '/bots' && method === 'DELETE') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const botId = (url.searchParams.get('botId') ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          const result = await purgeBot(botId, { purgeFiles: url.searchParams.get('purgeFiles') === '1' })
          return sendJson(res, result.ok ? 200 : 400, result)
        }

        /* 例行任务：前端定义、宿主执行。GET 看当前定义，POST 全量覆盖。 */
        if (tail === '/routines' && method === 'GET') {
          return sendJson(res, 200, { ok: true, routines: readRoutines() })
        }
        if (tail === '/routines' && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const incoming = Array.isArray(body.routines) ? body.routines : []
          const now = Date.now()
          /*
           * 旧定义按 id 建索引：`lastResult` 是宿主自己写回的执行结果，
           * 前端同步定义时不会带它，不继承的话每次保存例行任务都会把界面上
           * 的「部分完成 / 无新数据」徽标抹掉。
           */
          const previousById = new Map(readRoutines().map((routine) => [routine.id, routine]))
          const normalized: HostRoutine[] = []
          for (const raw of incoming) {
            if (raw === null || typeof raw !== 'object') continue
            const item = raw as Record<string, any>
            const id = typeof item.id === 'string' ? item.id.trim() : ''
            const botId = typeof item.botId === 'string' ? item.botId.trim() : ''
            if (id === '' || botId === '') continue
            const scheduleRaw = item.schedule
            if (scheduleRaw === null || typeof scheduleRaw !== 'object') continue
            const kind = scheduleRaw.kind
            if (kind !== 'interval' && kind !== 'daily' && kind !== 'weekly') continue
            const schedule = kind === 'interval'
              ? {
                kind: 'interval' as const,
                everyMinutes: Math.max(1, Math.round(Number(scheduleRaw.everyMinutes) || 60)),
              }
              : kind === 'weekly'
                ? {
                  kind: 'weekly' as const,
                  time: String(scheduleRaw.time ?? '09:00'),
                  weekdays: Array.isArray(scheduleRaw.weekdays)
                    ? scheduleRaw.weekdays.map(Number).filter((day: number) => day >= 1 && day <= 7)
                    : [1],
                }
                : { kind: 'daily' as const, time: String(scheduleRaw.time ?? '09:00') }
            const previous = previousById.get(id)
            normalized.push({
              id,
              botId,
              botName: typeof item.botName === 'string' && item.botName !== '' ? item.botName : 'Bot',
              botRole: typeof item.botRole === 'string' ? item.botRole : '',
              ...(item.botModel !== null && typeof item.botModel === 'object' ? { botModel: item.botModel } : {}),
              name: typeof item.name === 'string' && item.name !== '' ? item.name : '例行任务',
              instruction: typeof item.instruction === 'string' ? item.instruction : '',
              schedule,
              enabled: item.enabled !== false,
              /*
               * 信任设计字段（路线图 3.5）：没传就用缺省值，坏值一律夹取——
               * 一个 NaN 的 retry.max 会让重试循环直接死循环。
               */
              noDataPolicy: normalizeNoDataPolicy(item.noDataPolicy),
              retry: normalizeRetryPolicy(item.retry),
              // 前端带来的 nextAt 只有在「还没到点」时才采信；否则按规则现算，
              // 免得一个过期时间让任务在下一 tick 立刻连跑。
              nextAt: typeof item.nextAt === 'number' && item.nextAt > now
                ? item.nextAt
                : nextRoutineAt({ schedule }, now),
              ...(typeof item.lastRunAt === 'number' ? { lastRunAt: item.lastRunAt } : {}),
              ...(previous?.lastResult !== undefined ? { lastResult: previous.lastResult } : {}),
            })
          }
          writeRoutines(normalized)
          return sendJson(res, 200, { ok: true, count: normalized.length, routines: normalized })
        }

        /* 服务端产生的消息（例行任务结果）：前端离线时错过的那部分在这里补。 */        if (tail === '/messages' && method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const botId = url.searchParams.get('botId')
          return sendJson(res, 200, {
            ok: true,
            messages: readServerMessages(botId === null || botId === '' ? undefined : botId),
          })
        }

        /* 主动询问：前端定义活跃窗口，宿主在窗口内找机会说一句。 */
        if (tail === '/proactive' && method === 'GET') {
          return sendJson(res, 200, { ok: true, configs: readProactive() })
        }
        if (tail === '/proactive' && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const incoming = Array.isArray(body.configs) ? body.configs : []
          const now = Date.now()
          const normalized: HostProactive[] = []
          for (const raw of incoming) {
            if (raw === null || typeof raw !== 'object') continue
            const item = raw as Record<string, any>
            const botId = typeof item.botId === 'string' ? item.botId.trim() : ''
            if (botId === '') continue
            const config: HostProactive = {
              botId,
              botName: typeof item.botName === 'string' && item.botName !== '' ? item.botName : 'Bot',
              botRole: typeof item.botRole === 'string' ? item.botRole : '',
              ...(item.botModel !== null && typeof item.botModel === 'object' ? { botModel: item.botModel } : {}),
              enabled: item.enabled !== false,
              freq: typeof item.freq === 'string' ? item.freq : 'daily',
              from: typeof item.from === 'string' ? item.from : '09:00',
              to: typeof item.to === 'string' ? item.to : '22:00',
              ...(typeof item.lastAt === 'number' ? { lastAt: item.lastAt } : {}),
            }
            // 只采信「还没到点」的 nextAt；过期的按规则现算，否则下一 tick 会连跑
            config.nextAt = typeof item.nextAt === 'number' && item.nextAt > now
              ? item.nextAt
              : nextProactiveAt(config, now)
            normalized.push(config)
          }
          writeProactive(normalized)
          return sendJson(res, 200, { ok: true, count: normalized.length, configs: normalized })
        }
        /*
         * 「现在问一次」：按钮走宿主，与定时那条共用同一份提示词和执行路径——
         * 否则会出现「点按钮的语气和自动发的语气不一样」。
         */
        if (tail === '/proactive/run' && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          const existing = readProactive().find((item) => item.botId === botId)
          const config: HostProactive = existing ?? {
            botId,
            botName: typeof body.botName === 'string' && body.botName !== '' ? body.botName : 'Bot',
            botRole: typeof body.botRole === 'string' ? body.botRole : '',
            ...(body.botModel !== null && typeof body.botModel === 'object' ? { botModel: body.botModel } : {}),
            enabled: false,
            freq: 'manual',
            from: '09:00',
            to: '22:00',
          }
          const result = await runProactiveNow(webCtx, config)
          return sendJson(res, result.ok ? 200 : 502, result)
        }

        /*
         * 审批决定：前端点「允许这次 / 以后都允许 / 拒绝」后回传。
         *
         * 409 是刻意区分的：它表示「这个审批已经超时 / 被中止 / 已被处理」，
         * 前端据此提示「这条已经失效」，而不是假装成功让用户以为生效了。
         *
         * `allow-always` 是新值（路线图 3.2）：先落一条 always-allow 规则，本次
         * 仍按 allowed-once 结算——本次操作本来就要执行，规则只影响以后。
         * 老前端只会发 allow / deny，这条分支对它是死代码，不改变任何行为。
         */
        if (tail === '/approval/decide' && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : ''
          if (approvalId === '') return sendJson(res, 400, { ok: false, error: 'approvalId required' })
          const rawDecision = typeof body.decision === 'string' ? body.decision.trim() : ''
          const decision: ApprovalChoice = rawDecision === 'allow' || rawDecision === 'allowed-once'
            ? 'allowed-once'
            : rawDecision === 'allow-always' || rawDecision === 'always'
              ? 'allowed-always'
              : 'rejected'
          const matched = decideApproval(approvalId, decision)
          return sendJson(res, matched ? 200 : 409, {
            ok: matched,
            decision,
            pending: pendingApprovalCount(),
          })
        }

        /*
         * 审批规则（Always allow / Ask first 的存储，路线图 3.2）。
         *
         * 规则由「以后都允许」按钮自动写入，也允许前端设置页直接管理：
         * GET 看全部规则，POST add / remove。规则文件在插件状态目录下
         * （`~/.dsh/storages/dsh-seeker-bot/personal-agent/approval-rules.json`）。
         */
        if (tail === '/approval/rules' && method === 'GET') {
          return sendJson(res, 200, { ok: true, rules: readApprovalRules(), file: approvalRulesFile() })
        }
        if (tail === '/approval/rules' && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const action = typeof body.action === 'string' && body.action.trim() !== '' ? body.action.trim() : 'add'
          if (action === 'add') {
            const risk: ApprovalRisk | undefined = body.risk === 'irreversible' || body.risk === 'security' || body.risk === 'external'
              ? body.risk
              : undefined
            const rule = addApprovalRule({
              match: typeof body.match === 'string' ? body.match : '',
              decision: body.decision === 'ask' ? 'ask' : 'allow',
              ...(risk !== undefined ? { risk } : {}),
            })
            if (rule === null) return sendJson(res, 400, { ok: false, error: 'match required' })
            return sendJson(res, 200, { ok: true, rule, rules: readApprovalRules() })
          }
          if (action === 'remove') {
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            if (id === '') return sendJson(res, 400, { ok: false, error: 'id required' })
            const removed = removeApprovalRule(id)
            return sendJson(res, removed ? 200 : 404, { ok: removed, rules: readApprovalRules() })
          }
          return sendJson(res, 400, { ok: false, error: 'action must be add or remove' })
        }

        /*
         * 问答回答：前端点了选项后回传。
         *
         * 409 与审批同义——问题已超时 / 被取消 / 已被回答。前端据此提示「这条已经
         * 失效」，而不是假装成功让用户以为答案生效了。
         */
        if (tail === '/question/answer' && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const questionId = typeof body.questionId === 'string' ? body.questionId.trim() : ''
          if (questionId === '') return sendJson(res, 400, { ok: false, error: 'questionId required' })
          const selected = Array.isArray(body.selected)
            ? body.selected
              .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
              .map((item) => item.trim())
            : []
          const custom = typeof body.custom === 'string' ? body.custom.trim() : ''
          const matched = answerQuestion(questionId, selected, custom === '' ? undefined : custom)
          return sendJson(res, matched ? 200 : 409, {
            ok: matched,
            pending: pendingQuestionCount(),
          })
        }

        /*
         * 面板「添加记忆」：写进该 Bot 自己的记忆库（schema v6 的 owner 维度）。
         *
         * 为什么不让前端直接调 `/api/dsh-memory/remember`：那条路由要求显式
         * `projectHash`，而前端不该知道也不该硬编码 bot 工作区的 hash——它随盘符
         * 和安装位置变化，写死一份会在换机器后把记忆写到另一个项目下。
         * 这里用 `botWorkspaceDir()` 现算，owner 由 botId 推导，前端只传内容。
         */
        if (tail === '/memory/remember' && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
          const content = typeof body.content === 'string' ? body.content.trim() : ''
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          if (content === '') return sendJson(res, 400, { ok: false, error: 'content required' })
          const tags = Array.isArray(body.tags)
            ? body.tags
              .filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
              .map((tag) => tag.trim())
              .slice(0, 8)
            : []
          const result = await rememberBotMemory(getWebuiMemoryStore(), botId, content, {
            tags,
            importance: typeof body.importance === 'number' && Number.isFinite(body.importance)
              ? Math.max(1, Math.min(10, Math.round(body.importance)))
              : 8,
            source: 'manual',
          })
          /*
           * 引擎没启动时必须 503，不能假装成功——假装成功会让用户以为记住了，
           * 实际什么也没落库（记忆引擎是独立插件，用户可能把它关掉了）。
           */
          if (!result.ok && result.error === 'memory engine unavailable') {
            return sendJson(res, 503, { ok: false, error: result.error })
          }
          if (!result.ok) return sendJson(res, 500, { ok: false, error: result.error ?? 'remember failed' })
          return sendJson(res, 200, { ok: true, created: result.created, id: result.id })
        }

        /*
         * 工作记忆（路线图 0.2）：Bot 当前的「任务状态」，每轮回复前注入上下文。
         *
         * 与长期记忆的分工：任务态（52 个账号、36 条草稿、做到第几步）只进这里；
         * 偏好 / 事实只进长期记忆。任务 done 后自动沉淀一条带日期的工作日志进
         * 长期记忆——那才是可回看、可检索的部分。
         *
         * GET  ?botId=          → 当前任务列表 + 即将注入的文本（便于面板预览）
         * POST { botId, action: 'upsert', task } → 插入 / 更新一个任务
         * POST { botId, action: 'prune' }        → 清理过期任务
         */
        if ((tail === '/working-memory' || tail === '/working-memory/') && method === 'GET') {
          const botId = (url.searchParams.get('botId') ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          try {
            const tasks = await readWorkingTasks(botId)
            return sendJson(res, 200, {
              ok: true,
              botId,
              tasks,
              // 前端可以直接展示「Bot 这轮会看到什么」，不用自己复刻注入格式
              block: buildWorkingMemoryBlock(tasks),
              file: workingMemoryFile(botId),
            })
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
        if ((tail === '/working-memory' || tail === '/working-memory/') && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          const actionRaw = typeof body.action === 'string' ? body.action.trim() : ''
          // 没显式给 action 时按有没有 task 推断：带任务就是写，否则是清理
          const action = actionRaw !== '' ? actionRaw : (body.task !== undefined ? 'upsert' : 'prune')
          if (action !== 'upsert' && action !== 'prune') {
            return sendJson(res, 400, { ok: false, error: 'action must be upsert or prune' })
          }
          try {
            if (action === 'prune') {
              const tasks = await pruneWorkingTasks(botId)
              return sendJson(res, 200, { ok: true, botId, action, tasks })
            }
            const task = normalizeWorkingTask(body.task, Date.now())
            if (task === null) return sendJson(res, 400, { ok: false, error: 'task.title required' })
            const tasks = await upsertWorkingTask(botId, task)
            /*
             * 任务完成后沉淀「工作日志」进长期记忆（路线图 0.2 的「沉淀」）。
             *
             * 只写标题 + 产出 + 日期：任务的全部步骤与 facts 留在工作记忆里，
             * 长期记忆只负责「这个 Bot 哪天做过什么事」这一层可回看的索引。
             * 记忆引擎不可用时**不影响任务写入**（logged=false 即可），
             * 否则关掉记忆插件的用户连工作记忆都用不了。
             */
            let memoryLogged = false
            if (task.status === 'done') {
              const logged = await rememberBotMemory(
                getWebuiMemoryStore(),
                botId,
                workingLogContent(task),
                { tags: ['工作日志', 'Bot工作记忆'], importance: 6, source: 'bot-working-memory' },
              )
              memoryLogged = logged.ok
            }
            return sendJson(res, 200, { ok: true, botId, action, task, tasks, memoryLogged })
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }

        /*
         * 接力摘要（手动轮转的「整理并开新会话」）：把当前对话整理成结构化交接单，
         * 新会话每轮注入（生成 / 落盘 / 注入实现全部在 ./relay.ts）。
         *
         * 两步式流程对应前端确认卡：
         *  · POST /relay/prepare → 先生成给用户预览（不落盘；模型不可用时 degraded 兜底）
         *  · POST /relay/commit  → 用户确认后落盘 + 清空对话（重置两个注入指纹）
         */
        if ((tail === '/relay' || tail === '/relay/') && method === 'GET') {
          const botId = (url.searchParams.get('botId') ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          try {
            return sendJson(res, 200, { ok: true, brief: await readRelayBrief(botId) })
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
        if ((tail === '/relay/prepare' || tail === '/relay/prepare/') && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
          const botModel = body.botModel !== null && typeof body.botModel === 'object' && !Array.isArray(body.botModel)
            ? body.botModel as { provider?: string; model?: string; effort?: string }
            : undefined
          try {
            const result = await generateRelayBrief(webCtx, {
              botId,
              ...(botModel !== undefined ? { botModel } : {}),
              messages: Array.isArray(body.messages) ? body.messages : [],
            })
            /* messages 为空才是 4xx；模型失败会走 degraded 兜底，仍是 200 */
            return sendJson(res, result.ok ? 200 : 400, result)
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
        if ((tail === '/relay/commit' || tail === '/relay/commit/') && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          const brief = normalizeRelayBrief(body.brief)
          if (brief === null) return sendJson(res, 400, { ok: false, error: 'brief required' })
          try {
            await writeRelayBrief(botId, brief)
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: `接力摘要落盘失败：${String(error?.message ?? error)}` })
          }
          /*
           * 先清两个注入指纹再重置会话：新会话 sessionId 会变，旧指纹命中
           * 「sessionId 包含 botId」的兜底逻辑时会让刚写好的摘要被误判成
           * 「已注入过」而永远不注入。
           */
          resetWorkingMemoryInjection(botId)
          resetRelayInjection(botId)
          const result = await resetBotConversation(webCtx, botId)
          return sendJson(res, result.ok ? 200 : 502, result)
        }
        if ((tail === '/relay' || tail === '/relay/') && method === 'DELETE') {
          const botId = (url.searchParams.get('botId') ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          try {
            await clearRelayBrief(botId)
            resetRelayInjection(botId)
            return sendJson(res, 200, { ok: true })
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }

        /*
         * Pages（路线图 3.1）：可回访的持久页面。
         *
         * 与消息内卡片的区别：卡片是即时的，Pages 是权威副本——Bot 产出报告 /
         * 看板 / 追踪器时除了发卡片，还应写一份到这里，用户以后随时能打开。
         * 存储落在产出物目录（`产出物/<botFolder>/网页/`，见 ./pages.ts），
         * 与工作台共用同一套扫描链路。
         *
         * 为什么 item 返回 html 正文而不是给一个 `/file?path=...html` 的 URL：
         * 同源 `text/html` 会在宿主 origin 下执行任意脚本，等于给 Bot 生成的页面
         * 开一条通往宿主 API 的路。返回内容、由前端用 sandbox iframe 渲染，
         * 沙箱边界交给渲染方，host 不假装安全。
         */
        if ((tail === '/pages' || tail === '/pages/') && method === 'GET') {
          const botId = (url.searchParams.get('botId') ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          try {
            // 列表只给 meta（不含 html）：面板要能一次列几百页而不搬几 MB 正文
            return sendJson(res, 200, { ok: true, botId, pages: listPages(botId) })
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
        if ((tail === '/pages/item' || tail === '/pages/item/') && method === 'GET') {
          const botId = (url.searchParams.get('botId') ?? '').trim()
          const slug = (url.searchParams.get('slug') ?? '').trim().toLowerCase()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          if (slug === '') return sendJson(res, 400, { ok: false, error: 'slug required' })
          try {
            const page = readPage(botId, slug)
            if (page === null) return sendJson(res, 404, { ok: false, error: 'page not found' })
            return sendJson(res, 200, { ok: true, page })
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
        if ((tail === '/pages' || tail === '/pages/') && method === 'POST') {
          const body = await readJsonBody(req) as Record<string, unknown>
          const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          const result = writePage(botId, {
            title: typeof body.title === 'string' ? body.title : '',
            html: typeof body.html === 'string' ? body.html : '',
            ...(typeof body.slug === 'string' ? { slug: body.slug } : {}),
            ...(typeof body.sourceMessageId === 'string' ? { sourceMessageId: body.sourceMessageId } : {}),
            ...(body.share === 'shared' || body.share === 'private' ? { share: body.share } : {}),
          })
          if (!result.ok) {
            // 输入问题回 400，落盘失败才是 500——前端据此决定「提示改输入」还是「重试」
            return sendJson(res, result.error === 'write-failed' ? 500 : 400, {
              ok: false,
              error: result.error,
              message: result.message,
            })
          }
          return sendJson(res, 200, { ok: true, page: result.meta })
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
                const entries: Array<Record<string, unknown>> = []
                for (const model of Array.isArray(models) ? models : []) {
                  const id = String(model?.id ?? '').trim()
                  if (id === '') continue
                  /*
                   * 推理档位：模型正式公布的可选档位（`resolveModelInfo` 读适配器
                   * catalog，纯本地解析，不联网）。Bot 设置卡据此决定「推理强度」
                   * 下拉给哪几档；解析失败或模型不支持推理时留空，界面自动隐藏。
                   */
                  let reasoningEfforts: Array<{ id: string; name: string }> = []
                  let defaultEffort = ''
                  try {
                    if (typeof llm.resolveModelInfo === 'function') {
                      const info = await llm.resolveModelInfo(providerId, id)
                      const efforts = info?.reasoning?.efforts
                      if (Array.isArray(efforts)) {
                        reasoningEfforts = efforts
                          .map((effort: any) => ({
                            id: String(effort?.id ?? '').trim(),
                            name: String(effort?.name ?? effort?.id ?? '').trim(),
                          }))
                          .filter((effort: { id: string }) => effort.id !== '')
                      }
                      const declaredDefault = String(info?.reasoning?.defaultEffort ?? '').trim()
                      if (declaredDefault !== '') defaultEffort = declaredDefault
                    }
                  } catch {
                    /* 单个模型解析失败：只丢档位，不影响模型本身可选 */
                  }
                  entries.push({
                    id,
                    name: String(model?.name ?? id),
                    ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
                    ...(defaultEffort !== '' ? { defaultEffort } : {}),
                  })
                }
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
          /*
           * 清掉工作记忆的注入指纹：会话已经重建，不重置的话内容相同的记忆会被
           * 判定成「已经注入过」而永远不再注入——表现是「清空对话后 Bot 又不知道
           * 自己手上有活了」。
           */
          resetWorkingMemoryInjection(botId)
          /*
           * 接力摘要的注入指纹同理：清空对话后新会话内容不变也要重新注入，
           * 否则「上一段对话的交接单」永远进不了新会话。
           */
          resetRelayInjection(botId)
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
          const messageId = typeof body.messageId === 'string' && body.messageId !== '' ? body.messageId : undefined
          /*
           * 前端只带 botId（撤回是「针对某条消息」，不需要完整 bot 档案）。
           * 这里补一个最小 bot 对象：botId 决定会话身份，name/role 只影响提示词，
           * 撤回不重新组装提示词，所以留默认值即可。
           */
          const spec = toBotSpec({
            bot: { ...(body.bot ?? {}), id: botId },
            permission: body.permission === 'approval' ? 'approval' : 'full',
          })
          const result = await recallBotTurn(webCtx, spec, text, at, messageId)
          return sendJson(res, result.ok ? 200 : 502, result)
        }

        /*
         * 停止当前轮次：前端「停止」按钮 / 卡住自救共用。
         *
         * 为什么必须存在：`runBotTurn` 的 10 分钟超时只结束前端等待，宿主里的
         * agent 轮次不会停。它继续跑工具、占着会话，用户再发消息只能排队——
         * 表现就是「Bot 一直卡着」。这里直接对 running 的 agent 调 cancel。
         */
        if (tail === '/stop' && method === 'POST') {
          const body = await readJsonBody(req)
          const botId = String(body.botId ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'empty botId' })
          const result = cancelBotTurn(webCtx, botId)
          return sendJson(res, result.ok ? 200 : 409, result)
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
          const spec = toBotSpec(body)
          /*
           * 记下这一轮属于哪个群：审批 / 问答卡是异步发的，发布时只能靠 botId
           * 反查。私聊回合 body.roomId 缺省，这里就是删除登记——不删的话后台
           * 例行任务的审批卡会被塞进上一轮那个群。
           */
          setBotRoom(spec.botId, body.roomId)
          /*
           * 工作记忆注入（路线图 0.2）：每轮回复前把「当前任务状态」作为 developer
           * 消息投给 agent。放在 runBotTurn 之前，是因为 `inject()` 不唤醒驱动器——
           * 先注入、再 followup 用户消息，模型第一步就能看到任务进度，不依赖
           * 历史有没有被压缩过。
           */
          await injectWorkingMemoryForReply(webCtx, spec)
          // 群聊回合把本群之前的对话也投进去（成员只有一条终身会话，不注入就互相看不见）；私聊回合内部直接返回
          await injectRoomContextForReply(webCtx, spec, body)

          /*
           * 首选：把这个 bot 接到宿主的真 agent 会话上（能读文件 / 跑命令 / 搜索…）。
           *
           * 失败时**必须把原因带回去**（agentError）：早先这里是个空 catch，
           * 于是「agent 建不起来」在界面上表现为「模型说它没有权限」，排查时
           * 完全看不到真正的错误。
           */
          let agentError = ''
          try {
            const turn = await runBotTurn(webCtx, spec, text, () => {})
            if (turn.ok) {
              // Bot 会话不再挂进 Work 的工作区：两套 agent 的会话列表互相隔离
              return sendJson(res, 200, {
                ok: true,
                blocks: turn.blocks,
                /*
                 * 多消息切分视图：非流式调用方（通话、例行任务、主动询问）也能拿到
                 * 「模型说了几段」而不是一坨 blocks。流式入口由 message 事件承载。
                 */
                messages: turn.messages,
                mode: 'agent',
                sessionId: turn.sessionId,
                ...(turn.userMessageId !== undefined ? { userMessageId: turn.userMessageId } : {}),
              })
            }
            agentError = turn.error ?? 'agent turn 未成功但未给出原因'
          } catch (error: any) {
            agentError = String(error?.message ?? error)
          }

          /*
           * 到此为止，**不再降级成一次纯 LLM 补全**。
           *
           * 旧行为是失败后退回 `ctx.llm.stream` 拼一段文本，界面上照样有东西可看。
           * 代价是「agent 挂了」被伪装成「Bot 正常回复」——实测踩过：一个空壳会话
           * 让每轮都走这条路，Bot 满口答应「我这就建」，却一个文件都产不出来，
           * 而且界面上没有任何报错。失败必须可见，宁可让用户看到红字。
           */
          return sendJson(res, 502, {
            ok: false,
            mode: 'agent',
            error: agentError,
            agentError,
          })
        }

        if (tail === '/reply/stream' && method === 'POST') {
          const body = await readJsonBody(req) as ReplyBody
          const text = withImageHints(String(body.text ?? '').trim(), body.images)
          if (text === '') return sendJson(res, 400, { ok: false, error: 'empty message' })
          const spec = toBotSpec(body)
          // 与 /reply 同一口径：登记本回合的所属群，私聊回合即清除（见 room-context.ts）
          setBotRoom(spec.botId, body.roomId)
          /*
           * 记下这个 Bot 的配置：派活时宿主需要知道「子 Bot 是谁」。
           * 前端每轮都会把完整配置带上来，所以这里缓存天然是新鲜的。
           */
          rememberBotSpec(spec)
          // 全量花名册（可选）：让派活能覆盖「从没聊过的 Bot」
          rememberRoster(body.roster)
          // 工作记忆注入：与 /reply 同一处理，放在开 SSE 之前（避免拖慢首字节）
          await injectWorkingMemoryForReply(webCtx, spec)
          // 群聊历史注入：与 /reply 同一口径，同样放在开 SSE 之前
          await injectRoomContextForReply(webCtx, spec, body)

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
            /*
             * 同步广播到事件总线：多窗口 / 多设备打开同一个 bot 时，任一处发起的
             * 对话其他地方也能看到。只广播 message 系事件——text / tool 是同一批
             * 内容的扁平视图，转发出去前端也不会用。
             */
            const eventBotId = String(body.bot?.id ?? '').trim()
            if (eventBotId === '') return
            /*
             * 群聊回合的消息要带上群 id，否则「多窗口 / 多设备打开同一个 Bot」那条
             * 同步路径会把群消息落到私聊：前端按 message.roomId 归组，广播事件里
             * 没有它，另一处窗口就会多出一条只在私聊可见的重复气泡。
             *
             * 取登记表里的值而不是 body.roomId：后台例行任务（没有 body.roomId）在
             * 同一 Bot 的群回合里发消息时，也该落到那个群（见 room-context.ts）。
             */
            const broadcastRoomId = botRoomOf(eventBotId)
            const roomField = broadcastRoomId !== undefined ? { roomId: broadcastRoomId } : {}
            if (event.type === 'message') {
              publish(eventBotId, { type: 'message', message: event.message, source: 'chat', ...roomField })
            } else if (event.type === 'message-update') {
              publish(eventBotId, { type: 'message-update', message: event.message, source: 'chat', ...roomField })
            }
          }

          /*
           * 把这一轮挂到作业运行时上。
           *
           * 为什么需要：主 Bot 要能派活，`coordinate_bots` 就得有一个父节点可挂；
           * 没有它，派出去的活会变成没人收结果的孤儿。这里只做「记录」——真正的
           * 执行仍然是下面那次 `runBotTurn`，行为不变。
           *
           * 运行时没起来时 `rootAssignment` 是 undefined，对话照常，只是不能派活。
           */
          const runtimeHandle = personalRuntime()
          const rootAssignment = runtimeHandle?.runtime.begin({
            origin: { kind: 'person', source: 'chat', quote: text.slice(0, 400) },
            requester: { kind: 'person' },
            assignee: { botId: spec.botId },
            brief: text,
            level: spec.permission === 'approval' ? 'ask' : 'full',
          })

          let turnOk = false
          let turnText = ''
          try {
            const turn = await runBotTurn(webCtx, spec, text, write)
            turnOk = turn.ok
            turnText = turn.error ?? ''
            /*
             * done 只由 runBotTurn 内部 emit（收口信号），这里**不要**再补一条：
             * 重复的 done 会让前端收口两次。失败路径（agent 建不起来 / 本轮无
             * 输出）由上面 runBotTurn 自己 emit 的 error 事件表达，客户端读到
             * 流结束同样会收口，不依赖这条路由补 done。
             */
            if (!turn.ok && turn.error !== undefined) write({ type: 'error', message: turn.error })
          } catch (error: any) {
            turnText = String(error?.message ?? error)
            write({ type: 'error', message: turnText })
          } finally {
            /*
             * 收尾必须在 finally 里：用户中途断开、模型报错、`runBotTurn` 抛错，
             * 这一轮的作业记录都得有个结局，否则它会永远停在 running 上——下次
             * 启动时会被当成「被切掉的轮次」重跑一遍。
             *
             * 如果这一轮派了活还没回来，`end()` 会把记录转成 waiting，等子活
             * 结算后由运行时唤醒它续跑一轮（那一轮会带着子活的结果）。
             */
            if (runtimeHandle !== undefined && rootAssignment !== undefined) {
              try {
                runtimeHandle.runtime.end(rootAssignment.id, { ok: turnOk, text: turnText })
              } catch (error: any) {
                console.warn('[personal-agent] 收尾作业记录失败:', String(error?.message ?? error))
              }
            }
          }
          try {
            res.end()
          } catch {
            /* 已结束 */
          }
          return
        }

        /* ───────────────────── 期刊日记（宿主生成 / 持久化 / 调度）───────────────────── */

        /*
         * 期刊是「宿主异步产出」的东西：生成一次要调模型（+ 可选生图），可能几十秒。
         * 所以接口拆成「命令」与「查询」两组：POST generate/check 触发动作，
         * GET list/status 读落盘结果。宿主是唯一事实来源，前端只做展示与本地回退。
         *
         * 全部实现见 ./journal.ts（与生成、存储、调度同一模块），这里只做 HTTP 装配。
         */
        if (tail === '/journal/list' && method === 'GET') {
          return sendJson(res, 200, { ok: true, journals: readJournals() })
        }

        if (tail === '/journal/status' && method === 'GET') {
          const state = readJournalRuleState()
          const journals = readJournals()
          const lastGeneratedAt = journals.reduce<number | undefined>(
            (latest, record) => (latest === undefined || record.generatedAt > latest ? record.generatedAt : latest),
            undefined,
          )
          const status: JournalStatus = {
            rule: state.rule,
            logs: readJournalLogs(),
            generating: isJournalGenerating(),
            ...(lastGeneratedAt !== undefined ? { lastGeneratedAt } : {}),
          }
          return sendJson(res, 200, { ok: true, ...status })
        }

        /*
         * 手动生成一期期刊（前端「生成今日期刊」按钮）。
         *
         * 失败必须回 502 + 可读原因，**不能**在这里降级成本地模板——前端拿到失败
         * 后自己会走 buildJournal 回退并 toast 说明，两处各降级一次只会让人分不清
         * 到底是模型失败还是前端没接上。
         */
        if (tail === '/journal/generate' && method === 'POST') {
          const body = await readJsonBody(req)
          const request = body as GenerateJournalRequest
          const result = await generateJournalWithModel(webCtx, request)
          if (result.ok && result.journal !== undefined) {
            // 生成成功要广播：多窗口 / 页面切走再回来都能立刻看到新一期
            publish(result.journal.botId, {
              type: 'journal',
              journal: result.journal,
              source: request.auto === true ? 'auto' : 'manual',
            })
            return sendJson(res, 200, { ok: true, journal: result.journal })
          }
          return sendJson(res, 502, { ok: false, error: result.error ?? '生成失败' })
        }

        /*
         * 规则检查：与调度器 tick 走同一个 `checkJournalTrigger`，两处判定逻辑
         * 必须一致（否则会出现「按钮说该生成、定时器说不该」）。
         * `now` 允许调用方指定（调试 / 测试用），缺省取宿主当前时间。
         */
        if (tail === '/journal/check' && method === 'POST') {
          const body = await readJsonBody(req)
          const now = typeof body.now === 'number' && Number.isFinite(body.now) ? Math.round(body.now) : Date.now()
          const botId = typeof body.botId === 'string' && body.botId.trim() !== '' ? body.botId.trim() : 'main'
          const result = await checkJournalTrigger(webCtx, now, botId)
          return sendJson(res, 200, result)
        }

        if (tail === '/journal/rule' && method === 'POST') {
          const body = await readJsonBody(req)
          // 兼容两种形状：{ rule: {...}, lastUserMessageAt } 或直接 {...rule}
          const ruleRaw = body.rule !== null && typeof body.rule === 'object' ? body.rule : body
          const saved = writeJournalRuleState({
            rule: ruleRaw,
            ...(typeof body.lastUserMessageAt === 'number' && Number.isFinite(body.lastUserMessageAt)
              ? { lastUserMessageAt: body.lastUserMessageAt }
              : {}),
          })
          return sendJson(res, 200, { ok: true, rule: saved.rule })
        }

        if (tail === '/journal/feed' && method === 'POST') {
          const body = await readJsonBody(req)
          writeJournalFeed({
            messages: Array.isArray(body.messages) ? body.messages : [],
            ...(body.stats !== null && typeof body.stats === 'object' ? { stats: body.stats } : {}),
            ...(typeof body.lastUserMessageAt === 'number' && Number.isFinite(body.lastUserMessageAt)
              ? { lastUserMessageAt: body.lastUserMessageAt }
              : {}),
          })
          return sendJson(res, 200, { ok: true })
        }

        if (tail === '/journal' && method === 'DELETE') {
          const id = (url.searchParams.get('id') ?? '').trim()
          if (id === '') return sendJson(res, 400, { ok: false, error: 'id required' })
          const deleted = deleteJournalRecord(id)
          return deleted
            ? sendJson(res, 200, { ok: true })
            : sendJson(res, 404, { ok: false, error: 'not found' })
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
         * 某个 Bot 的产出物清单：右栏「产出物」卡的数据源。
         *
         * 目录约定见 src/host/personal/outputs.ts：每个 bot 一个固定文件夹
         * （`<workspace>/产出物/<botFolder>/`），下面 9 个分类子目录；扫描结果
         * 按 mtime 倒序、最多 200 条。`name` 只在首次分配文件夹名时参与，
         * 缺省时用 botId 兜底，所以前端不传也能拿到（可能已存在的）文件夹。
         *
         * 错误面刻意分两层：缺 botId → 400；分配 / 读取失败 → 500 + `{ok:false}`，
         * 前端据此显示空态而不是一直转圈。
         */
        if ((tail === '/outputs' || tail === '/outputs/') && method === 'GET') {
          const botId = (url.searchParams.get('botId') ?? '').trim()
          if (botId === '') return sendJson(res, 400, { ok: false, error: 'botId required' })
          const name = (url.searchParams.get('name') ?? '').trim()
          try {
            const result = scanBotOutputs(botId, name)
            return sendJson(res, result.ok ? 200 : 500, result)
          } catch (error: any) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
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
         *  2. 扩展名必须在白名单（图片 24MB / 其它媒体 256MB，见 MEDIA_CONTENT_TYPES；
         *     工具结果全文根额外放行 `.txt`，见 TOOL_RESULT_CONTENT_TYPES）；
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
          /*
           * `.txt` 只在**工具结果全文根**下放行（见 TOOL_RESULT_CONTENT_TYPES）：
           * 前端「查看完整结果」要读回来；而 bot 工作区里的 .txt 仍然 403——
           * 不能因为一个展示需求把用户的交付物目录整体放开。
           */
          const toolResultType = normalizeForCompare(admitted.root) === normalizeForCompare(toolResultsRoot())
            ? TOOL_RESULT_CONTENT_TYPES[ext]
            : undefined
          const type = imageType ?? MEDIA_CONTENT_TYPES[ext] ?? toolResultType
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
