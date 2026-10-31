/**
 * dsh-seeker-bot — 工作区实时回显抓帧路由（host 半身）。
 *
 * ## 为什么需要它
 *
 * 用户需求：「在操作面板右侧有一个回显画面实时的，右下角增加放大标识用于弹出放大回显画面，
 * 点击画面就跟那个浏览器标识一样的功能，打开ego的工作区」。
 * 2026-10-31 用户再次明确：「修复操作面板的浏览器回显问题，显示会话关联的工作空间」。
 *
 * ## 架构纪律（改前必读）
 *
 * 1. **回显的真相源是 ego 的 TaskSpace，不是桌面窗口**。
 *    ego 是一个多标签浏览器：窗口当前激活的标签可能是用户的私人页面（magpie 等），
 *    而本会话的 Agent 工作空间可能躺在后台标签里。窗口抓帧（PrintWindow）只能拿到
 *    激活标签，既会错显，也会在用户切换标签时闪烁。唯一可靠的画面来源是
 *    `listTaskSpaces() → taskSpace(id) → page.cdp('Page.captureScreenshot')`：
 *    它按任务空间取页面，不受标签激活状态影响，也不会抓到浏览器外壳。
 *
 * 2. **绝对严禁在此路由中每次请求都 execFile/spawn 起 cmd.exe**：
 *    Windows 控制台子系统启动会闪现黑色 CMD 窗口（严重打扰用户），用户已明确反馈过。
 *    调用 ego-browser 一律走 `execFile('ego-browser', [...], { windowsHide: true })`，
 *    不存在 cmd.exe、不存在可见控制台。
 *
 * 3. **会话关联优先于「随便找个窗口」**：
 *    路由接收 `session` 与 `hint`（从会话工具调用里提取的 taskSpace 名称/ID）。
 *    服务端按以下顺序定位：
 *      a. 本会话已绑定且仍然存在的 agent space（持久绑定，切轮次不丢）；
 *      b. hint 精确/包含匹配的 agent space；
 *      c. 当前机器上唯一一个 agent-owned space（仅在没有其他会话占用时）。
 *    找不到就返回 `no-workspace`，客户端隐藏视口 —— 绝不拿用户私人页面充数。
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rejectCrossSite } from '../shared/csrf.ts'
import { sessionIdOfExecution } from '../browser-activity/tools.ts'
import { captureFrame, captureProcessFrame, getCaptureLastErrorCode, getLastHiddenInfo } from '../host/done-pill/rec-capture.js'

export const ECHO_VIEWPORT_FRAME_ROUTE = '/api/chat-flow/echo-viewport/frame'
export const ECHO_VIEWPORT_SPACE_ROUTE = '/api/chat-flow/echo-viewport/space-frame'

/** ego listTaskSpaces() 返回的一条空间记录（只保留用得到的字段）。 */
export interface WorkspaceSpaceEntry {
  readonly id: number
  readonly name: string
  readonly taskId: string
  readonly createdBy: string
  readonly ownership: string
  readonly recentTabTitles: readonly string[]
}

/** 一次工作空间抓帧的成功结果。 */
export interface WorkspaceFrame {
  readonly ok: true
  readonly spaceId: number
  readonly name: string
  readonly title: string
  readonly url: string
  readonly w: number
  readonly h: number
  /** base64 编码的 JPEG 图片。 */
  readonly data: string
}

/** 一次工作空间抓帧的失败结果。 */
export interface WorkspaceFrameError {
  readonly ok: false
  readonly code: 'no-workspace' | 'workspace-closed' | 'ego-unavailable' | 'capture-failed'
  readonly message: string
}

export type WorkspaceFrameResult = WorkspaceFrame | WorkspaceFrameError

/** 判断一条空间记录是否 Agent 工作空间（插件只回显这类空间）。 */
export function isAgentSpace(space: WorkspaceSpaceEntry): boolean {
  if (space === null || typeof space !== 'object') return false
  return space.createdBy === 'agent' || space.ownership === 'agent'
}

function normalizeSpaceRecord(raw: unknown): WorkspaceSpaceEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = Number(record.id)
  if (!Number.isFinite(id) || id < 0) return null
  const titles = Array.isArray(record.recentTabTitles)
    ? record.recentTabTitles.filter((item): item is string => typeof item === 'string')
    : []
  return {
    id: Math.round(id),
    name: typeof record.name === 'string' ? record.name : '',
    taskId: typeof record.taskId === 'string' ? record.taskId : '',
    createdBy: typeof record.createdBy === 'string' ? record.createdBy : '',
    ownership: typeof record.ownership === 'string' ? record.ownership : '',
    recentTabTitles: titles,
  }
}

/**
 * 从任意文本（工具参数、脚本内容、工具结果）里抽出工作空间线索。
 *
 * 为什么要从工具参数里找：agent 打开工作空间必须写一段 ego-browser 脚本，脚本里必然
 * 出现 `taskSpace("taobao")` 或 `claimTaskSpace(6)`。这些片段会留在 write/run_code/pwsh
 * 的参数里。把它们按会话记下来，回显就能认出「这个会话关联哪个空间」，且不依赖
 * 持久化日志或额外的 agent 配合。
 */
export function extractWorkspaceHints(text: string): string[] {
  if (typeof text !== 'string' || text === '') return []
  // 工具参数是 JSON 字符串，脚本里的引号/换行被转义过；先还原再匹配。
  const decoded = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
  const out: string[] = []
  const push = (value: string | undefined): void => {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed === '' || trimmed.length > 120) return
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  let match: RegExpExecArray | null = null
  const taskSpaceRe = /taskSpace\s*\(\s*["']([^"']{1,120})["']/g
  while ((match = taskSpaceRe.exec(decoded)) !== null) push(match[1])
  const claimRe = /(?:claimTaskSpace|takeOverTaskSpace)\s*\(\s*(\d{1,8})\s*\)/g
  while ((match = claimRe.exec(decoded)) !== null) push(match[1])
  const taskIdRe = /"taskId"\s*:\s*"([^"]{1,120})"/g
  while ((match = taskIdRe.exec(decoded)) !== null) push(match[1])
  const spaceIdRe = /"spaceId"\s*:\s*(\d{1,8})/g
  while ((match = spaceIdRe.exec(decoded)) !== null) push(match[1])
  const createdRe = /Task space created,\s*id:\s*(\d{1,8})/gi
  while ((match = createdRe.exec(decoded)) !== null) push(match[1])
  return out
}

/**
 * 在 agent space 列表里按线索选一个工作空间。
 *
 * 纯函数，方便冒烟直接喂假数据对拍。返回 null 表示「无法确定」，调用方必须返回
 * no-workspace 让视口隐藏 —— 宁可少显示，也绝不显示错的空间。
 */
export function pickWorkspaceSpace(
  spaces: readonly WorkspaceSpaceEntry[],
  hints: readonly string[],
): { space: WorkspaceSpaceEntry; matchedBy: 'exact' | 'id' | 'contains' | 'single' } | null {
  const agentSpaces = spaces.filter((space) => isAgentSpace(space))
  if (agentSpaces.length === 0) return null
  const cleanHints = hints.map((hint) => hint.trim()).filter((hint) => hint !== '')
  // 数组末尾是最新的线索（WorkspaceLink 与客户端都按「新→后」追加）：从后往前试，
  // 这样同一会话先后打开多个工作空间时，回显跟随最近打开的那个。
  for (const hint of [...cleanHints].reverse()) {
    const lower = hint.toLowerCase()
    const exact = agentSpaces.find((space) =>
      space.name.toLowerCase() === lower || space.taskId.toLowerCase() === lower)
    if (exact !== undefined) return { space: exact, matchedBy: 'exact' }
    const numeric = Number(hint)
    if (Number.isFinite(numeric) && numeric >= 0 && String(Math.round(numeric)) === hint.trim()) {
      const byId = agentSpaces.find((space) => space.id === Math.round(numeric))
      if (byId !== undefined) return { space: byId, matchedBy: 'id' }
    }
    const contains = agentSpaces.find((space) => {
      const name = space.name.toLowerCase()
      if (name.length >= 2 && (name.includes(lower) || lower.includes(name))) return true
      return space.recentTabTitles.some((title) => {
        const t = title.toLowerCase()
        return t.length >= 2 && (t.includes(lower) || lower.includes(t))
      })
    })
    if (contains !== undefined) return { space: contains, matchedBy: 'contains' }
  }
  if (agentSpaces.length === 1) return { space: agentSpaces[0], matchedBy: 'single' }
  return null
}

/** 每个会话记住的工具线索（内存态；插件重启后由新的工具调用重新填充）。 */
export class WorkspaceLink {
  private readonly hintsBySession = new Map<string, string[]>()

  remember(sessionId: string, text: string): void {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof text !== 'string' || text === '') return
    const found = extractWorkspaceHints(text)
    if (found.length === 0) return
    const previous = this.hintsBySession.get(sessionId) ?? []
    const merged = [...previous]
    for (const hint of found) {
      const index = merged.indexOf(hint)
      if (index >= 0) merged.splice(index, 1)
      merged.push(hint)
    }
    this.hintsBySession.set(sessionId, merged.slice(-16))
  }

  hintsOf(sessionId: string): string[] {
    return this.hintsBySession.get(sessionId) ?? []
  }

  forget(sessionId: string): void {
    this.hintsBySession.delete(sessionId)
  }

  dispose(): void {
    this.hintsBySession.clear()
  }
}

/** 当前 apply 安装的线索表；路由闭包只读它。 */
let activeWorkspaceLink: WorkspaceLink | null = null

/** 包装一次 execFile 调用为 Promise（windowsHide 永远为 true）。 */
function execFileHidden(file: string, args: readonly string[], timeoutMs: number, maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args as string[], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve(String(stderr || '') + String(stdout || ''))
    })
  })
}

/**
 * 查询 ego 当前的任务空间列表。
 *
 * ego-browser 的 embedded Node runtime 把脚本 stdout 写回自己的 stderr，所以
 * 用显式标记从 stderr 里取 JSON。
 */
export async function listWorkspaceSpaces(): Promise<WorkspaceSpaceEntry[]> {
  const code = 'listTaskSpaces().then((spaces) => process.stderr.write("DSH_SPACES:" + JSON.stringify(spaces) + "\\n"))'
  try {
    const output = await execFileHidden('ego-browser', ['nodejs', '-e', code], 6000, 4 * 1024 * 1024)
    const line = output.split(/\r?\n/).find((item) => item.includes('DSH_SPACES:'))
    if (line === undefined) return []
    const payload = line.slice(line.indexOf('DSH_SPACES:') + 'DSH_SPACES:'.length).trim()
    const parsed = JSON.parse(payload) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeSpaceRecord).filter((space): space is WorkspaceSpaceEntry => space !== null)
  } catch {
    return []
  }
}

/**
 * 对指定 TaskSpace 截一帧（后台标签也能截）。
 *
 * 输出走临时文件：JPEG 走二进制文件，元数据走 JSON 文件；ego-browser 的标准输出
 * 通道不可靠（见 listWorkspaceSpaces 的说明），而且 base64 大字符串过命令行也危险。
 */
export async function captureWorkspaceFrame(spaceId: number, maxW = 400): Promise<WorkspaceFrame | null> {
  if (!Number.isFinite(spaceId) || spaceId < 0) return null
  const safeMaxW = Math.max(120, Math.min(1600, Math.round(maxW)))
  let dir = ''
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-echo-'))
    const jpgPath = join(dir, 'frame.jpg')
    const metaPath = join(dir, 'meta.json')
    const scriptPath = join(dir, 'capture.mjs')
    const options = { spaceId: Math.round(spaceId), maxW: safeMaxW, jpgPath: jpgPath.replace(/\\/g, '/'), metaPath: metaPath.replace(/\\/g, '/') }
    const script = [
      "import fs from 'node:fs';",
      'const opts = ' + JSON.stringify(options) + ';',
      'try {',
      '  const task = await taskSpace(opts.spaceId);',
      '  const pages = await task.pages();',
      '  let page = pages.length > 0 ? pages[0] : null;',
      '  if (page === null) {',
      '    const tabs = await task.tabs();',
      '    const candidate = tabs.find((tab) => tab.active) ?? tabs[0];',
      '    page = candidate ? candidate.page : null;',
      '  }',
      '  if (page === null) {',
      "    fs.writeFileSync(opts.metaPath, JSON.stringify({ ok: false, code: 'no-page' }));",
      '    process.exit(0);',
      '  }',
      '  let viewport = { width: 1280, height: 800 };',
      '  try {',
      '    const info = await page.info();',
      '    if (info && info.viewport && info.viewport.width > 0 && info.viewport.height > 0) {',
      '      viewport = { width: info.viewport.width, height: info.viewport.height };',
      '    }',
      '  } catch {}',
      '  const scale = Math.min(1, opts.maxW / Math.max(1, viewport.width));',
      '  const shot = await page.cdp("Page.captureScreenshot", {',
      '    format: "jpeg", quality: 72, captureBeyondViewport: false,',
      '    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale },',
      '  });',
      '  fs.writeFileSync(opts.jpgPath, Buffer.from(shot.data, "base64"));',
      '  const title = await page.title();',
      '  const url = await page.url();',
      '  fs.writeFileSync(opts.metaPath, JSON.stringify({',
      '    ok: true, spaceId: task.spaceId, name: task.name, title, url,',
      '    w: Math.max(1, Math.round(viewport.width * scale)),',
      '    h: Math.max(1, Math.round(viewport.height * scale)),',
      '  }));',
      '} catch (error) {',
      '  try { fs.writeFileSync(opts.metaPath, JSON.stringify({ ok: false, code: "capture-failed", message: String((error && error.message) || error) })); } catch {}',
      '}',
    ].join('\n')
    writeFileSync(scriptPath, script, 'utf8')
    await execFileHidden('ego-browser', ['nodejs', '-e', "await import('file:///" + scriptPath.replace(/\\/g, '/') + "')"], 8000, 8 * 1024 * 1024)
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
    if (meta.ok !== true) return null
    const data = readFileSync(jpgPath).toString('base64')
    if (data === '') return null
    return {
      ok: true,
      spaceId: Number(meta.spaceId) || Math.round(spaceId),
      name: typeof meta.name === 'string' ? meta.name : '',
      title: typeof meta.title === 'string' ? meta.title : '',
      url: typeof meta.url === 'string' ? meta.url : '',
      w: Number(meta.w) || 0,
      h: Number(meta.h) || 0,
      data,
    }
  } catch {
    return null
  } finally {
    if (dir !== '') {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结果 */ }
    }
  }
}

/** 空间列表缓存（截图按 1fps 轮询；每帧都查一次列表太浪费，2.5 秒足够新鲜）。 */
interface SpaceCacheEntry {
  at: number
  promise: Promise<WorkspaceSpaceEntry[]>
}
let spaceCache: SpaceCacheEntry | null = null

function listWorkspaceSpacesCached(): Promise<WorkspaceSpaceEntry[]> {
  const now = Date.now()
  if (spaceCache !== null && now - spaceCache.at < 2500) return spaceCache.promise
  const promise = listWorkspaceSpaces().catch(() => [] as WorkspaceSpaceEntry[])
  spaceCache = { at: now, promise }
  return promise
}

/** 会话 → 工作空间绑定（内存态；空间 finish 后自动失效）。 */
const boundSpaceBySession = new Map<string, number>()
const boundSessionBySpace = new Map<number, string>()

function bindSessionSpace(sessionId: string, spaceId: number): void {
  if (sessionId === '') return
  const previous = boundSpaceBySession.get(sessionId)
  if (previous !== undefined && previous !== spaceId) boundSessionBySpace.delete(previous)
  boundSpaceBySession.set(sessionId, spaceId)
  boundSessionBySpace.set(spaceId, sessionId)
}

function unbindSession(sessionId: string): void {
  const previous = boundSpaceBySession.get(sessionId)
  if (previous !== undefined) boundSessionBySpace.delete(previous)
  boundSpaceBySession.delete(sessionId)
}

/** 对外暴露的测试/诊断面：清空所有内存绑定。 */
export function resetWorkspaceBindings(): void {
  boundSpaceBySession.clear()
  boundSessionBySpace.clear()
  spaceCache = null
}

function sendJson(res: any, code: number, body: Record<string, unknown>): void {
  try {
    const text = JSON.stringify(body)
    if (typeof res.writeHead === 'function') {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
    } else if (typeof res.setHeader === 'function') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
    }
    res.end?.(text)
  } catch {
    /* 客户端连接关闭时忽略 */
  }
}

/** 工作空间抓帧依赖面（测试可注入假实现）。 */
export interface EchoSpaceDeps {
  listSpaces: () => Promise<WorkspaceSpaceEntry[]>
  capture: (spaceId: number, maxW: number) => Promise<WorkspaceFrame | null>
  hintsOf: (sessionId: string) => string[]
}

const defaultSpaceDeps: EchoSpaceDeps = {
  listSpaces: () => listWorkspaceSpacesCached(),
  capture: (spaceId, maxW) => captureWorkspaceFrame(spaceId, maxW),
  hintsOf: (sessionId) => activeWorkspaceLink?.hintsOf(sessionId) ?? [],
}

/**
 * 工作空间回显路由：`GET /api/chat-flow/echo-viewport/space-frame`。
 *
 * 查询参数：
 *   - `session`：会话 id（用于会话绑定 + 读取该会话的工具线索）；
 *   - `hint`：客户端补充的线索，逗号分隔（可选）；
 *   - `maxW`：返回图片的最大宽度（默认 400，放大弹窗用 1280）。
 */
export async function handleEchoViewportSpaceRoute(
  req: any,
  res: any,
  deps: EchoSpaceDeps = defaultSpaceDeps,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: 'Method Not Allowed' })
    return
  }
  if (rejectCrossSite(req.headers, (status, payload) => sendJson(res, status, payload))) return

  let sessionId = ''
  let clientHints: string[] = []
  let maxW = 400
  let strict = false
  try {
    const query = String(req.url ?? '').split('?')[1] ?? ''
    const params = new URLSearchParams(query)
    sessionId = (params.get('session') ?? '').trim()
    const hint = (params.get('hint') ?? '').trim()
    if (hint !== '') {
      clientHints = hint.split(',').map((item) => item.trim()).filter((item) => item !== '')
    }
    const mw = Number(params.get('maxW'))
    if (Number.isFinite(mw) && mw > 0) maxW = Math.min(Math.round(mw), 1600)
    strict = params.get('strict') === '1'
  } catch {
    /* 查询参数坏掉时按无参处理 */
  }

  let spaces: WorkspaceSpaceEntry[] = []
  try {
    spaces = await deps.listSpaces()
  } catch {
    spaces = []
  }

  const hints = [
    ...(sessionId !== '' ? deps.hintsOf(sessionId) : []),
    ...clientHints,
  ]
  const agentSpaces = spaces.filter((space) => isAgentSpace(space))

  // 先清掉已经消失的空间绑定（工作空间被 finish 后必须能立刻隐藏/重绑）。
  for (const [session, spaceId] of boundSpaceBySession) {
    if (!agentSpaces.some((space) => space.id === spaceId)) {
      boundSpaceBySession.delete(session)
      boundSessionBySpace.delete(spaceId)
    }
  }

  const hintPick = pickWorkspaceSpace(agentSpaces, hints)
  let picked: { space: WorkspaceSpaceEntry; matchedBy: 'bound' | 'exact' | 'id' | 'contains' | 'single' } | null = null
  if (sessionId !== '') {
    const boundId = boundSpaceBySession.get(sessionId)
    const bound = boundId === undefined ? undefined : agentSpaces.find((space) => space.id === boundId)
    if (boundId !== undefined && bound === undefined) unbindSession(sessionId)
    /*
     * 1) 本会话已绑定的空间优先（切轮次/刷新都稳定）；
     * 2) 但如果本会话出现了**新的明确线索**（exact/id）指向另一个现存空间，
     *    说明用户刚又打开了一个工作空间 —— 回显应该跟到最新的那个。
     *    只认 exact/id，contains 太模糊，不能用来改绑。
     */
    if (bound !== undefined) {
      const switchToHint = hintPick !== null
        && hintPick.space.id !== bound.id
        && (hintPick.matchedBy === 'exact' || hintPick.matchedBy === 'id')
        && (boundSessionBySpace.get(hintPick.space.id) === undefined || boundSessionBySpace.get(hintPick.space.id) === sessionId)
      picked = switchToHint ? hintPick : { space: bound, matchedBy: 'bound' }
    } else {
      picked = hintPick
    }
  } else {
    picked = hintPick
  }

  // 严格模式：Bot 面板不接受「唯一空间」兜底，避免把用户私人页面当成 Bot 工作区。
  if (picked !== null && strict && picked.matchedBy === 'single') picked = null

  if (picked === null) {
    sendJson(res, 200, {
      ok: false,
      code: 'no-workspace',
      message: agentSpaces.length === 0 ? '本会话尚未打开工作空间' : '未找到与本会话关联的工作空间',
    })
    return
  }

  // 3) 一个空间同时只归一个会话，防止两个会话错显同一个工作空间。
  const owner = boundSessionBySpace.get(picked.space.id)
  if (owner !== undefined && owner !== sessionId) {
    sendJson(res, 200, {
      ok: false,
      code: 'no-workspace',
      message: '该工作空间属于其他会话',
    })
    return
  }

  const frame = await deps.capture(picked.space.id, maxW)
  if (frame === null) {
    sendJson(res, 200, {
      ok: false,
      code: 'capture-failed',
      message: '抓取工作空间画面失败',
    })
    return
  }
  bindSessionSpace(sessionId, picked.space.id)
  sendJson(res, 200, { ...frame, at: Date.now() })
}

/**
 * 路由请求处理：窗口抓帧（旧版，保留给非 ego 浏览器场景）。
 */
export async function handleEchoViewportFrameRoute(req: any, res: any): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: 'Method Not Allowed' })
    return
  }

  // 跨站闸门防护
  if (rejectCrossSite(req.headers, (status, payload) => sendJson(res, status, payload))) {
    return
  }

  let processNames = 'ego,chrome,msedge'
  let maxW = 600
  let hwnd = 0
  let taskQuery = ''

  try {
    const query = String(req.url ?? '').split('?')[1] ?? ''
    const params = new URLSearchParams(query)
    const p = params.get('process')
    if (p && p.trim()) processNames = p.trim()
    const q = params.get('query') || params.get('task')
    if (q && q.trim()) taskQuery = q.trim()
    const mw = Number(params.get('maxW'))
    if (Number.isFinite(mw) && mw > 0) maxW = Math.min(Math.round(mw), 2560)
    const h = Number(params.get('hwnd'))
    if (Number.isFinite(h) && h > 0) hwnd = Math.round(h)
  } catch {
    /* ignore query parse errors */
  }

  // 1. 若客户端指定了 hwnd，走常驻管道直抓
  if (hwnd > 0) {
    try {
      const direct = await captureFrame(hwnd, maxW)
      if (direct && direct.data) {
        sendJson(res, 200, {
          ok: true,
          hwnd,
          process: processNames.split(',')[0] ?? 'ego',
          title: '',
          w: direct.w,
          h: direct.h,
          data: direct.data,
          at: Date.now(),
        })
        return
      }
    } catch {
      /* 直抓失败回退到按进程名查找 */
    }
  }

  // 2. 走常驻管道按进程名定位窗口并穿透抓取网页视口（Chrome_RenderWidgetHostHWND）
  try {
    const frame = await captureProcessFrame(processNames, maxW, taskQuery)
    if (frame && frame.data) {
      sendJson(res, 200, {
        ok: true,
        hwnd: frame.hwnd,
        process: frame.process,
        title: frame.title || '工作区',
        w: frame.w,
        h: frame.h,
        data: frame.data,
        at: Date.now(),
      })
      return
    }
  } catch (err: any) {
    sendJson(res, 200, {
      ok: false,
      code: 'capture_failed',
      message: err?.message || '抓取工作区画面异常',
    })
    return
  }

  const errCode = getCaptureLastErrorCode() || 'window-not-found'
  const hiddenInfo = getLastHiddenInfo()
  sendJson(res, 200, {
    ok: false,
    code: errCode,
    hwnd: hiddenInfo?.hwnd ?? 0,
    process: hiddenInfo?.process ?? '',
    title: hiddenInfo?.title ?? '',
    message: errCode === 'window-hidden' ? '工作区窗口已最小化' : '未检测到运行中的工作区或浏览器窗口',
  })
}

/** 从一次 tools/execute 里安全地收集线索文本。 */
function hintTextOfExecution(exec: unknown): string {
  try {
    const args = (exec as { arguments?: unknown } | null | undefined)?.arguments
    if (args === undefined || args === null) return ''
    if (typeof args === 'string') return args
    return JSON.stringify(args)
  } catch {
    return ''
  }
}

/**
 * 注册工作区实时回显路由。
 */
export function applyEchoViewport(webCtx: any): void {
  const link = new WorkspaceLink()
  activeWorkspaceLink = link

  // 观察 tools/execute：把每次调用参数里的 taskSpace 名称按会话记下来。
  try {
    const on = webCtx?.on
    if (typeof on === 'function') {
      on('tools/execute', (async (exec: unknown, next: () => Promise<unknown>): Promise<unknown> => {
        try {
          const sessionId = sessionIdOfExecution(exec)
          if (sessionId !== '') link.remember(sessionId, hintTextOfExecution(exec))
        } catch {
          /* 线索收集失败绝不影响真实工具调用 */
        }
        return next()
      }) as never)
    }
  } catch {
    /* 观察器挂不上时，客户端的 hint 参数仍可用 */
  }

  try {
    webCtx.effect(() => () => {
      link.dispose()
      resetWorkspaceBindings()
      if (activeWorkspaceLink === link) activeWorkspaceLink = null
    }, 'dsh-seeker-bot: echo-viewport workspace link')
  } catch {
    /* effect 不可用时至少路由仍能工作 */
  }

  try {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ECHO_VIEWPORT_FRAME_ROUTE,
      handler: (req: any, res: any) => {
        void handleEchoViewportFrameRoute(req, res)
      },
    }), 'dsh-seeker-bot: echo-viewport frame route')
  } catch {
    /* webServer 不可用时静默 */
  }

  try {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ECHO_VIEWPORT_SPACE_ROUTE,
      handler: (req: any, res: any) => {
        void handleEchoViewportSpaceRoute(req, res)
      },
    }), 'dsh-seeker-bot: echo-viewport space route')
  } catch {
    /* webServer 不可用时静默 */
  }
}
