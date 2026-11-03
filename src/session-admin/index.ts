/**
 * dsh-seeker-bot — 会话管理（真正删除会话）：`/api/session-admin/*`。
 *
 * ## 为什么需要这一层
 *
 * DSH 官方只提供「归档」，没有「删除」：`workspaceRegistry.archiveSession()`
 * 只把会话 id 塞进 registry 的 `archivedSessionIds`，会话日志目录与工作区记账
 * 全都留着（本机已经堆了 1029 条归档，磁盘白占）。用户要的是**永久删除**：
 * 对话与记录一起消失、进不了回收站。
 *
 * ## 为什么不直接改 workspace.json
 *
 * `$DSH_HOME/storages/workspace.json` 看起来很好改，但宿主进程在内存里持有
 * 同一份 registry 状态（storage-domain 的 domain table）。直接改文件的话，
 * 下一次任何写入（新建会话 / 归档 / 重命名 / 拖排序）都会把**内存里的旧状态
 * 整体回写**，我们删掉的条目会原地复活。所以这里**全部走官方服务层**：
 *
 *   1. `registry.unarchiveSession(id)` —— 从归档集合移除（在集合里才写）；
 *   2. `registry.unpinSession(id)`     —— 从置顶集合移除（置顶与归档互斥）；
 *   3. `workspace.detachSession(id)`   —— 从工作区 `sessionIds` 记账移除；
 *   4. 删除磁盘上的 `<DSH_HOME>/sessions/<projectKey>/<uuid>/` 目录。
 *
 * 1~3 都走 storage-domain，内存与磁盘同步更新，且会触发 `changed` 帧让
 * 官方侧栏自己刷新——不需要重启宿主，也不需要前端手动重载。
 *
 * ## 拒绝删除的情形
 *
 * 只有**真正在跑工作**的会话会被拒绝：判据不是「在 sessions store 里驻留」
 * （那太宽——DSH 会 retain 所有打开过的会话，用户根本没有「关闭」入口），
 * 而是官方 registry 的活动检查（`archiveSession` 的
 * `workspace/session-activity` waterfall）。详见 `deleteOne` 的头注释。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import { rejectCrossSite } from '../shared/csrf.ts'

/** 路由前缀（比官方 `/api` 长，longest-prefix-wins 派发到本 handler）。 */
const ROUTE_PREFIX = '/api/session-admin'

/**
 * 合法会话 id 形状：`session-<uuid v4 形状>`。
 *
 * 只放行这个形状有两个作用：① 拒绝一切非法输入；② 因为它严格排除了
 * `/`、`\`、`..`，后面拿它拼磁盘路径时天然没有路径穿越风险（`uuid` 段
 * 只允许十六进制与连字符）。
 */
/**
 * 合法会话 id 形状：`<uuid>` 或 `session-<uuid>`。
 *
 * ## 为什么两种都要收（2026-11-03 实测踩到）
 *
 * **运行时 registry 用的是裸 uuid**：`workspaceRegistry.archivedSessionIds`
 * 经 zod 的 `sessionId = z.string().transform(brandString)` 后返回
 * `078ca79a-6133-4340-be38-87d1874481ca` 这种形式，**没有** `session-` 前缀。
 * 而磁盘上的 `$DSH_HOME/storages/workspace.json` 是**混合格式**（实测 1029 条
 * 归档里 1011 条带前缀、18 条是裸 uuid，属于历史版本遗留）。
 *
 * 只认带前缀那一版时，`/list` 返回的裸 uuid 会被本校验拒掉：表现为
 * `dirs` 全是 0、点删除回 400「非法会话 id」——功能看着装好了，一用就废。
 *
 * 安全性没有放松：两种形式都严格排除了 `/`、`\`、`..`，uuid 段只允许十六进制
 * 与连字符，拼磁盘路径时天然没有穿越风险。
 */
const SESSION_ID_RE = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 单次删除上限：菜单是逐条删，批量面板（后续）也不会一次上千。 */
const MAX_DELETE_IDS = 500

/** DSH 主目录（与 host 各模块同口径：环境变量优先）。 */
function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 会话日志根目录：`<DSH_HOME>/sessions`。 */
function sessionsRoot(): string {
  return join(dshHome(), 'sessions')
}

/**
 * 把会话 id 归一成磁盘目录名（裸 uuid）。
 *
 * 两种入参都接受：`session-<uuid>`（磁盘存档格式）与 `<uuid>`（运行时格式）。
 *
 * @param sessionId - 已通过 {@link SESSION_ID_RE} 的 id。
 * @returns 裸 uuid。
 */
export function sessionUuidOf(sessionId: string): string {
  return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
}

/**
 * 把会话 id 解析成磁盘上所有可能的会话目录。
 *
 * 目录布局照抄官方 `listProjectDirs`/`listSessionDirs`：
 * `<DSH_HOME>/sessions/<projectKey>/<uuid>/`。同一个会话只会落在一个 projectKey
 * 下，但这里仍然全量扫一遍再返回数组——项目目录编码规则将来若变，扫到的都删掉
 * 即可，不必依赖对 projectKey 编码的假设。
 *
 * @param sessionId - `<uuid>` 或 `session-<uuid>`。
 * @returns 存在的会话目录绝对路径（可能为空：日志已被手工删掉）。
 */
export async function locateSessionDirs(sessionId: string): Promise<string[]> {
  if (!SESSION_ID_RE.test(sessionId)) return []
  const uuid = sessionUuidOf(sessionId)
  const root = sessionsRoot()
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  /*
   * 目录名也**有两种格式**（2026-11-03 实测本机）：
   *   `--C-Users-Anti-.dsh-bot-workspace--/session-9b29781b-...`
   *   `--D-AI-dsh-seeker-bot--/0329e2e3-...`
   * 前者是带 `session-` 前缀的新格式，后者是裸 uuid 的历史遗留。两种都必须试：
   * 只试一种时，另一半会话「点删除成功但日志还在磁盘上」，属于最隐蔽的假成功。
   */
  const candidates = [uuid, `session-${uuid}`]
  const found: string[] = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const name of candidates) {
      const dir = join(root, project.name, name)
      try {
        // 只认目录：同名文件不是会话日志。
        const entries = await readdir(dir, { withFileTypes: true })
        void entries
        found.push(dir)
      } catch {
        // 该 project 下没有这个会话：正常情况，继续下一个候选。
      }
    }
  }
  return found
}

/** 写 JSON 响应（带 no-store，避免删除结果被缓存）。 */
function json(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 读 JSON 请求体（上限 1MB；本接口只收 id 数组）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buf.length
    if (total > 1024 * 1024) throw new Error('请求体过大')
    chunks.push(buf)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/* ───────────────────────── 挂载 ───────────────────────── */

/**
 * 挂载会话管理路由。
 *
 * 延迟注入 `workspaceRegistry`：服务缺失时回调不执行，路由不注册（前端探测
 * 不到就不显示菜单项），**不会**在 apply 同步路径上读 Proxy 抛错连累整棵插件树。
 *
 * 刻意**不**注入 `sessions`：活动判断走的是 registry 的
 * `archiveSession` 探针（见 `deleteOne`），不需要 sessions store——少一个依赖，
 * 就少一种「服务没就绪 → 整个功能静默不挂」的可能。
 *
 * @param ctx - 插件 host 上下文。
 */
export function applySessionAdmin(ctx: Record<string, any>): void {
  ctx.inject(['webServer', 'workspaceRegistry'], (webCtx: any) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void handle(webCtx, req, res)
      },
    }), 'dsh-seeker-bot: session-admin routes')
  })
}

/* ───────────────────────── 分派 ───────────────────────── */

async function handle(ctx: any, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 跨站闸门：插件前缀比官方 /api 长，官方那道 Origin 校验不会执行。
  if (rejectCrossSite(req.headers as Record<string, unknown>, (status, payload) => {
    json(res, status, payload)
  })) return

  let url: URL
  let rest: string
  let method: string
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
    rest = url.pathname.slice(ROUTE_PREFIX.length)
    method = req.method ?? 'GET'
  } catch {
    json(res, 400, { ok: false, error: '请求地址无法解析' })
    return
  }

  try {
    if (method === 'GET' && rest === '/list') {
      await handleList(ctx, url, res)
      return
    }
    if (method === 'POST' && rest === '/delete') {
      await handleDelete(ctx, req, res)
      return
    }
    json(res, 404, { ok: false, error: '未知接口' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    json(res, 500, { ok: false, error: message })
  }
}

/* ───────────────────────── 列表 ───────────────────────── */

interface SessionSummary {
  readonly id: string
  readonly archived: boolean
  readonly pinned: boolean
  /** 所在工作区标题（不在任何工作区时为 null）。 */
  readonly workspace: string | null
  /** 磁盘上找到的会话目录数（0 = 日志已不在，只剩注册表记账）。 */
  readonly dirs: number
}

/**
 * 列出会话（默认只列归档的，`?scope=all` 列全部）。
 *
 * 数据源就是 registry 的实时状态（归档集合 + 各工作区记账），不读磁盘
 * 索引——这样列出来的每一条都保证「删得动」。
 */
async function handleList(ctx: any, url: URL, res: ServerResponse): Promise<void> {
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'archived'
  const registry = ctx.workspaceRegistry
  const archived = new Set<string>(registry.archivedSessionIds as readonly string[])
  const pinned = new Set<string>(collectPinned(registry))

  const owner = new Map<string, string>()
  for (const workspace of registry.list() as readonly any[]) {
    for (const id of workspace.sessionIds as readonly string[]) owner.set(id, workspace.title)
  }

  const ids = scope === 'all'
    ? [...new Set<string>([...archived, ...owner.keys()])]
    : [...archived]

  const sessions: SessionSummary[] = []
  for (const id of ids) {
    sessions.push({
      id,
      archived: archived.has(id),
      pinned: pinned.has(id),
      workspace: owner.get(id) ?? null,
      dirs: (await locateSessionDirs(id)).length,
    })
  }
  // 稳定排序：先按是否归档（未归档在前），再按 id，方便前端分页。
  sessions.sort((a, b) => (a.archived === b.archived ? a.id.localeCompare(b.id) : a.archived ? 1 : -1))
  json(res, 200, {
    ok: true,
    scope,
    total: sessions.length,
    archivedTotal: archived.size,
    sessions,
  })
}

/**
 * 读置顶集合。
 *
 * registry 没暴露 `pinnedSessionIds` 的 getter（只在 state 里），这里做
 * 三重兜底：公开 getter → 内部 state → 空集。拿不到就当没置顶，不影响删除
 * （删除前仍会调 `unpinSession`，那一步自己会在集合里就移除）。
 */
function collectPinned(registry: any): readonly string[] {
  try {
    const direct = registry?.pinnedSessionIds
    if (direct !== undefined && direct !== null && typeof direct[Symbol.iterator] === 'function') {
      return [...direct] as string[]
    }
  } catch { /* 读不到继续兜底 */ }
  try {
    const state = registry?.state
    const list = state?.pinnedSessionIds
    if (Array.isArray(list)) return list as string[]
  } catch { /* 读不到就空集 */ }
  return []
}

/* ───────────────────────── 删除 ───────────────────────── */

interface DeleteResult {
  readonly id: string
  readonly ok: boolean
  readonly error?: string
  readonly removedDirs?: number
  /** 删除前是否在归档集合里（前端据此判断要不要刷新「已归档」筛选）。 */
  readonly wasArchived?: boolean
}

/**
 * 永久删除一批会话。
 *
 * 顺序是刻意的：**先解除注册表记账，再删磁盘**。反过来做的话，删完目录若
 * 注册表那步失败，侧栏会留一行点开就报错的死会话；而按现在的顺序，最坏
 * 情况只是「记账没了、目录还在」，属于可重试的无害残留。
 */
async function handleDelete(ctx: any, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (error) {
    json(res, 400, { ok: false, error: error instanceof Error ? error.message : '请求体无法解析' })
    return
  }
  const raw = body.ids
  if (!Array.isArray(raw) || raw.length === 0) {
    json(res, 400, { ok: false, error: 'ids 必须是非空数组' })
    return
  }
  if (raw.length > MAX_DELETE_IDS) {
    json(res, 400, { ok: false, error: `单次最多删除 ${String(MAX_DELETE_IDS)} 条` })
    return
  }
  const ids = raw.filter((item): item is string => typeof item === 'string')
  const invalid = ids.filter((id) => !SESSION_ID_RE.test(id))
  if (invalid.length > 0) {
    json(res, 400, { ok: false, error: `非法会话 id：${invalid.slice(0, 3).join(', ')}` })
    return
  }

  const results: DeleteResult[] = []
  for (const id of ids) {
    results.push(await deleteOne(ctx, id))
  }
  const deleted = results.filter((item) => item.ok).length
  json(res, 200, {
    ok: deleted === results.length,
    deleted,
    failed: results.length - deleted,
    results,
  })
}

/**
 * 删一条：活动检查 → 解除归档/置顶 → 解除工作区记账 → 删目录。
 *
 * ## 为什么用「归档试探」而不是 `ctx.sessions.get()`
 *
 * 最早这里判的是 `ctx.sessions.get(id) !== undefined`，结果**几乎删不掉任何会话**：
 * DSH 的 sessions store 会**驻留**所有打开过的会话（retain），它们明明空闲，
 * 却全被判成「仍在运行」——用户点了删除只得到一句「会话仍在运行，请先归档或
 * 关闭后再删除」，而「关闭」在界面上根本没有对应操作（2026-11-03 用户实测反馈）。
 *
 * 官方 registry 自己就有精确的活动检查：`archiveSession(id)` 不带 `stopActivity`
 * 时会问一次 `workspace/session-activity` waterfall，**有任何活动就抛
 * `WorkspaceActiveSessionError`（并列出是哪些活动），且一个字节都不写**。所以：
 *
 *   - 未归档的会话 → 先 `archiveSession(id)` 当探针：
 *       抛 Active → 真在跑，拒绝（文案里带上具体活动）；
 *       抛 Unknown → 日志已不在磁盘（僵尸记账），放行继续清理；
 *       成功 → 已归档，继续下面的删除流程；
 *   - 已归档的会话 → 跳过（归档当时已经过活动检查，且归档后 agent 的 pre-step
 *     gate 会阻止它被重新唤醒，不会再有新活动）。
 *
 * 这样「打开过但空闲」的会话能正常删掉，真正在跑回合的会话仍然被挡住。
 */
async function deleteOne(ctx: any, id: string): Promise<DeleteResult> {
  const registry = ctx.workspaceRegistry
  const wasArchived = (registry.archivedSessionIds as readonly string[]).includes(id)

  // ① 未归档的会话先归档：既做活动检查，也让后续删除有个一致的起点。
  if (!wasArchived) {
    try {
      await registry.archiveSession(id)
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name
      if (name === 'WorkspaceActiveSessionError') {
        const activity = (error as { activity?: readonly { kind?: unknown }[] }).activity ?? []
        const kinds = activity
          .map((entry) => (typeof entry?.kind === 'string' ? entry.kind : ''))
          .filter((kind) => kind !== '')
        return {
          id,
          ok: false,
          error: kinds.length > 0
            ? `会话正在运行（${kinds.join('、')}），请等它结束，或先归档（归档会询问是否停止这些工作）`
            : '会话正在运行，请等它结束，或先归档（归档会询问是否停止这些工作）',
          wasArchived,
        }
      }
      // 注册表里有这条、但日志已经不在磁盘上（历史遗留的僵尸记账）：
      // 不影响后续清理，继续走 detach + 删目录（删不到东西也算清理成功）。
      if (name !== 'WorkspaceUnknownSessionError') {
        return { id, ok: false, error: `归档检查失败：${messageOf(error)}`, wasArchived }
      }
    }
  }

  /*
   * ② 先定位日志目录，再决定动不动记账。
   *
   * 顺序是刻意的（2026-11-03 用户实测踩到）：早先的写法是「先 detach 记账、再删
   * 目录」，结果上一版定位逻辑只试了裸 uuid 目录名、找不到 `session-<uuid>` 那种
   * 目录——**目录没删、记账已经清了**，会话于是从原工作区掉进「未分组」，还留在
   * 列表里。先删磁盘再动记账，任何一步失败都不会让会话变成半截状态。
   */
  let dirs: string[] = []
  try {
    dirs = await locateSessionDirs(id)
  } catch (error) {
    await rollbackArchive(registry, id, wasArchived)
    return { id, ok: false, error: `定位日志目录失败：${messageOf(error)}`, wasArchived }
  }

  /*
   * 未归档的会话一定有日志（它正显示在列表里）。找不到目录说明**定位失败**，
   * 此时绝不能继续 detach —— 那正是「掉进未分组」的成因。中止并回滚探针归档。
   *
   * 已归档的会话允许没有目录：本机实测有 18 条「注册表里有、日志早没了」的
   * 僵尸记账，它们的正确处置就是清掉记账（dirs=0 属于正常）。
   */
  if (!wasArchived && dirs.length === 0) {
    await rollbackArchive(registry, id, wasArchived)
    return {
      id,
      ok: false,
      error: '没找到这个会话的日志目录，已取消删除（避免只清记账、把会话丢进「未分组」）',
      wasArchived,
      removedDirs: 0,
    }
  }

  // ③ 删磁盘：先删，失败就中止且回滚归档（会话保持原样，可以重试）。
  try {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  } catch (error) {
    await rollbackArchive(registry, id, wasArchived)
    return { id, ok: false, error: `删除日志目录失败：${messageOf(error)}`, wasArchived, removedDirs: 0 }
  }

  /*
   * ④ **保持归档状态，不 unarchive**（2026-11-03 关键修正）。
   *
   * 早先的写法是删完再 `unarchiveSession` 把它放回未归档集合，结果会话**继续
   * 显示在侧栏**——因为会话列表来自 `sessionQuery.listSessions()` 的**内存索引**，
   * 删磁盘不会同步那个索引，只有重启宿主重建索引才会消失。用户实测「刷新没用，
   * 必须重启才行」就是这个原因。
   *
   * 归档集合不一样：它是 registry 的实时状态，写入会推 changed 帧给客户端，
   * 侧栏**立刻**按「隐藏已归档」把它藏起来。所以：删完磁盘后保持归档，
   * 列表立即干净，不需要重启、也不需要刷新页面。
   *
   * 代价是 `archivedSessionIds` 里会留一条「日志已删」的记录（僵尸归档）。
   * 它不可见、不占空间，且 `/list` 会把它的 `dirs` 标成 0，后续批量面板可以清。
   */
  try {
    await registry.unpinSession?.(id)
  } catch { /* 没置顶时某些版本会抛，忽略：删除不依赖它 */ }
  try {
    for (const workspace of registry.list() as readonly any[]) {
      const owned = workspace.sessionIds as readonly string[]
      if (!owned.includes(id)) continue
      await workspace.detachSession(id)
    }
  } catch (error) {
    return { id, ok: false, error: `解除工作区记账失败：${messageOf(error)}`, wasArchived, removedDirs: dirs.length }
  }

  return { id, ok: true, wasArchived, removedDirs: dirs.length }
}

/**
 * 回滚「归档探针」：删除中途失败时，把探针写进归档集合的 id 放回去，
 * 免得会话既没删掉、又从列表里消失（那会让人以为删成功了）。
 *
 * @param registry - workspace registry。
 * @param id - 会话 id。
 * @param wasArchived - 删除前是否已归档（已归档的保持原状，不回滚）。
 */
async function rollbackArchive(registry: any, id: string, wasArchived: boolean): Promise<void> {
  if (wasArchived) return
  try {
    if ((registry.archivedSessionIds as readonly string[]).includes(id)) {
      await registry.unarchiveSession(id)
    }
  } catch {
    // 回滚失败不改变调用方的错误返回：主因是删除失败，不是回滚。
  }
}

/** 错误信息提取（不抛）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 供冒烟对拍：纯逻辑部分（id 形状 / 目录解析约定）。 */
export const __test = { SESSION_ID_RE, MAX_DELETE_IDS, dshHome, sessionsRoot, sessionUuidOf }
