/**
 * dsh-seeker-bot — 「删除会话」的专项测试（纯判据 + 路由集成）。
 *
 * ## 为什么这组判据必须钉住
 *
 * 删除是**不可逆**操作，而它的失败方式几乎全是静默的：
 *   · id 校验写松了 → 拼出来的磁盘路径可以穿到 DSH_HOME 之外（删错东西）；
 *   · 活会话没挡住 → 宿主那边还持有写句柄，删目录后下一次 flush 报错；
 *   · 归档集合没同步 → 日志删了、`archivedSessionIds` 里还留着，侧栏筛「已归档」
 *     会冒出一行点开就报错的死会话；
 *   · 顺序反过来（先删磁盘再解记账）→ 记账那步失败就留下死行。
 *
 * 这些在界面上都只有一个笼统的「失败」或干脆没反应，所以逐条断言。
 *
 * ## 为什么用假 ctx 而不是起真宿主
 *
 * `applySessionAdmin` 只依赖三个服务面（webServer.register / workspaceRegistry /
 * sessions），用最小 stub 就能把整条 HTTP → 删除逻辑跑通，且不碰真实的
 * `~/.dsh`。磁盘那部分用 `DSH_HOME` 指向临时目录隔离。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const toUrl = (rel) => new URL(rel, 'file:///' + ROOT.replace(/\\/g, '/') + '/').href

// 隔离：所有磁盘操作都落在临时 DSH_HOME 下，绝不碰用户真实的 ~/.dsh。
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-session-admin-test-'))
process.env.DSH_HOME = sandbox

const mod = await import(toUrl('src/session-admin/index.ts'))
const { locateSessionDirs, applySessionAdmin, __test } = mod

let failures = 0
function check(label, condition, detail) {
  if (condition) { console.log('  ok   ' + label); return }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
}

/**
 * 造一个会话日志目录：`<DSH_HOME>/sessions/<project>/<name>/`。
 *
 * @param project - projectKey 目录名。
 * @param uuid - 会话 uuid。
 * @param prefixed - true 时目录名用 `session-<uuid>`（新格式），false 用裸 uuid（历史格式）。
 */
function makeSessionDir(project, uuid, prefixed = false) {
  const dir = join(sandbox, 'sessions', project, prefixed ? `session-${uuid}` : uuid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), '{"type":"meta"}\n', 'utf8')
  return dir
}

const UUID_A = '11111111-2222-4333-8444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ID_A = `session-${UUID_A}`
const ID_B = `session-${UUID_B}`

console.log('[session-admin] 会话 id 形状')
{
  check('带前缀的合法 uuid 通过', __test.SESSION_ID_RE.test(ID_A) === true)
  // 运行时 registry 返回的是**裸 uuid**（zod 的 brandString 剥了前缀），
  // 磁盘存档才是混合格式。只认带前缀那一版时，/list 返回的 id 会被自己拒掉，
  // 表现为「dirs 全是 0、点删除回 400」——功能装好了一用就废（2026-11-03 实测）。
  check('裸 uuid 也通过（运行时格式）', __test.SESSION_ID_RE.test(UUID_A) === true)
  check('大写十六进制通过', __test.SESSION_ID_RE.test(`session-${UUID_A.toUpperCase()}`) === true)
  check('路径穿越不通过', __test.SESSION_ID_RE.test('session-../../evil') === false)
  check('裸 uuid 路径穿越不通过', __test.SESSION_ID_RE.test('../../evil') === false)
  check('反斜杠不通过', __test.SESSION_ID_RE.test('session-..\\..\\evil') === false)
  check('斜杠不通过', __test.SESSION_ID_RE.test('session-1111/2222') === false)
  check('空串不通过', __test.SESSION_ID_RE.test('') === false)
  check('批量上限是 500', __test.MAX_DELETE_IDS === 500)
  // 两种入参都必须归一成同一个磁盘目录名，否则裸 uuid 会被 slice 掉前 8 个字符。
  check('sessionUuidOf 剥前缀', __test.sessionUuidOf(ID_A) === UUID_A)
  check('sessionUuidOf 裸 uuid 原样', __test.sessionUuidOf(UUID_A) === UUID_A)
}

console.log('[session-admin] 磁盘目录定位')
{
  const dirA = makeSessionDir('--D-AI-demo--', UUID_A)
  const dirB = makeSessionDir('--D-AI-other--', UUID_B)

  const foundA = await locateSessionDirs(ID_A)
  check('能定位到会话目录', foundA.length === 1 && resolve(foundA[0]) === resolve(dirA), JSON.stringify(foundA))
  check('定位结果不串会话', !foundA.includes(dirB))

  // 运行时格式（裸 uuid）必须定位到同一个目录。
  const foundBare = await locateSessionDirs(UUID_A)
  check('裸 uuid 能定位到同一目录',
    foundBare.length === 1 && resolve(foundBare[0]) === resolve(dirA), JSON.stringify(foundBare))

  const foundMissing = await locateSessionDirs('session-99999999-9999-4999-8999-999999999999')
  check('不存在的会话返回空数组', foundMissing.length === 0)

  const foundEvil = await locateSessionDirs('session-../../evil')
  check('非法 id 直接返回空（不拼路径）', foundEvil.length === 0)
}

// 磁盘目录名也有两种格式（本机实测并存）：
//   新格式 `--C-Users-Anti-.dsh-bot-workspace--/session-<uuid>/`
//   历史格式 `--D-AI-dsh-seeker-bot--/<uuid>/`
// 只认一种时，另一半会话「删除成功但日志还躺在磁盘上」——最隐蔽的假成功。
console.log('[session-admin] 磁盘目录名两种格式')
{
  const UUID_P = 'pppppppp-1111-4222-8333-444444444444'.replace(/p/g, 'a')
  const dirPrefixed = makeSessionDir('--D-AI-new--', UUID_P, true)
  const found = await locateSessionDirs(UUID_P)
  check('带 session- 前缀的目录能定位',
    found.length === 1 && resolve(found[0]) === resolve(dirPrefixed), JSON.stringify(found))
  check('带前缀目录用带前缀 id 也能定位',
    (await locateSessionDirs(`session-${UUID_P}`)).length === 1)
}

/* ───────────────── 路由集成（假 ctx） ───────────────── */

/** 最小 webServer 面：记录注册的 route，返回 disposer。 */
/**
 * 最小 registry / sessions 面。
 *
 * @param archived - 初始归档集合。
 * @param workspaces - 工作区记账。
 * @param live - 驻留在 sessions store 里的会话（**不再**决定能否删除，仅用于验证
 *   我们不再拿它当判据）。
 * @param active - 有活动的会话 → `archiveSession` 抛 WorkspaceActiveSessionError。
 * @param unknown - 注册表里有但日志不在磁盘的会话 → `archiveSession` 抛
 *   WorkspaceUnknownSessionError（僵尸记账，删除应放行）。
 */
function makeFakeCtx({ archived = [], workspaces = [], live = new Set(), active = new Set(), unknown = new Set() } = {}) {
  const routes = []
  const state = {
    archived: new Set(archived),
    pinned: new Set(),
    workspaces: workspaces.map((ws) => ({
      title: ws.title,
      sessionIds: [...ws.sessionIds],
      async detachSession(id) {
        const at = this.sessionIds.indexOf(id)
        if (at >= 0) this.sessionIds.splice(at, 1)
        state.detached.push(id)
      },
    })),
    detached: [],
    unarchived: [],
    unpinned: [],
    archivedCalls: [],
  }
  /** 造一个与官方同形的具名错误（跨包 instanceof 不可靠，代码按 name 判）。 */
  const namedError = (name, message, extra = {}) => {
    const error = new Error(message)
    error.name = name
    return Object.assign(error, extra)
  }
  const registry = {
    get archivedSessionIds() { return [...state.archived] },
    get pinnedSessionIds() { return [...state.pinned] },
    list: () => state.workspaces,
    async archiveSession(id) {
      state.archivedCalls.push(id)
      // 已归档：官方是 no-op，不检查活动、不写盘。
      if (state.archived.has(id)) return
      if (unknown.has(id)) {
        throw namedError('WorkspaceUnknownSessionError', `cannot archive session '${id}': no such session`)
      }
      if (active.has(id)) {
        throw namedError('WorkspaceActiveSessionError', `cannot archive session '${id}': the session is active (turn)`, {
          sessionId: id,
          activity: [{ kind: 'turn' }],
        })
      }
      state.archived.add(id)
    },
    async unarchiveSession(id) {
      if (!state.archived.has(id)) return
      state.archived.delete(id)
      state.unarchived.push(id)
    },
    async unpinSession(id) {
      if (!state.pinned.has(id)) return
      state.pinned.delete(id)
      state.unpinned.push(id)
    },
  }
  const ctx = {
    inject(names, callback) { callback(webCtx) },
    workspaceRegistry: registry,
    sessions: { get: (id) => (live.has(id) ? { id } : undefined) },
  }
  const webCtx = {
    ...ctx,
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) { return fn() },
  }
  return { ctx, webCtx, routes, state }
}

/** 造一个 async-iterable 的假请求。 */
function makeReq({ method = 'GET', url = '/', headers = {}, body = undefined } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 造一个记录结果的假响应。 */
function makeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    _headers: {},
    _body: '',
    setHeader(name, value) { this._headers[name.toLowerCase()] = value },
    end(chunk) {
      this._body = chunk === undefined ? '' : String(chunk)
      this.headersSent = true
    },
    get json() {
      try { return JSON.parse(this._body) } catch { return undefined }
    },
  }
  return res
}

/** 调一次路由（handler 是 fire-and-forget，等一个 tick 再读响应）。 */
async function call(route, req) {
  const res = makeRes()
  route.handler(req, res)
  for (let i = 0; i < 50 && !res.headersSent; i += 1) {
    await new Promise((r) => setTimeout(r, 4))
  }
  return res
}

console.log('[session-admin] 路由注册')
{
  const { ctx, routes } = makeFakeCtx()
  applySessionAdmin(ctx)
  check('注册了 prefix /api/session-admin',
    routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/api/session-admin',
    JSON.stringify(routes.map((r) => `${r.kind} ${r.path}`)))
}

console.log('[session-admin] /list')
{
  const { ctx, routes, state } = makeFakeCtx({
    archived: [ID_A, ID_B],
    workspaces: [{ title: 'Demo', sessionIds: [ID_A] }],
  })
  applySessionAdmin(ctx)
  const route = routes[0]

  const res = await call(route, makeReq({ url: '/api/session-admin/list' }))
  const payload = res.json
  check('/list 回 200', res.statusCode === 200, String(res.statusCode))
  check('/list 只列归档（默认）', payload?.sessions?.length === 2, JSON.stringify(payload?.sessions))
  check('/list 带归档总数', payload?.archivedTotal === 2)
  check('/list 标出所属工作区', payload?.sessions?.find((s) => s.id === ID_A)?.workspace === 'Demo')
  check('/list 标出目录数', payload?.sessions?.find((s) => s.id === ID_A)?.dirs === 1,
    JSON.stringify(payload?.sessions?.find((s) => s.id === ID_A)))

  const resAll = await call(route, makeReq({ url: '/api/session-admin/list?scope=all' }))
  check('/list?scope=all 含未归档会话',
    resAll.json?.sessions?.length === 2, JSON.stringify(resAll.json?.sessions))

  // 跨站必须被挡（插件前缀绕开了官方那道 Origin 校验）。
  const resCross = await call(route, makeReq({
    url: '/api/session-admin/list',
    headers: { origin: 'https://evil.example.com' },
  }))
  check('跨站请求 403', resCross.statusCode === 403, String(resCross.statusCode))
  void state
}

console.log('[session-admin] /delete 参数校验')
{
  const { ctx, routes } = makeFakeCtx({ archived: [ID_A] })
  applySessionAdmin(ctx)
  const route = routes[0]

  const resEmpty = await call(route, makeReq({ method: 'POST', url: '/api/session-admin/delete', body: { ids: [] } }))
  check('空 ids 400', resEmpty.statusCode === 400, String(resEmpty.statusCode))

  const resBad = await call(route, makeReq({
    method: 'POST', url: '/api/session-admin/delete', body: { ids: ['session-../../evil'] },
  }))
  check('非法 id 400', resBad.statusCode === 400, String(resBad.statusCode))
  check('非法 id 不回成功', resBad.json?.ok !== true)

  const resTooMany = await call(route, makeReq({
    method: 'POST',
    url: '/api/session-admin/delete',
    body: { ids: Array.from({ length: 501 }, () => ID_A) },
  }))
  check('超过 500 条 400', resTooMany.statusCode === 400, String(resTooMany.statusCode))
}

console.log('[session-admin] /delete 正常链路')
{
  const { ctx, routes, state } = makeFakeCtx({
    archived: [ID_A],
    workspaces: [{ title: 'Demo', sessionIds: [ID_A, ID_B] }],
  })
  applySessionAdmin(ctx)
  const route = routes[0]

  const res = await call(route, makeReq({
    method: 'POST', url: '/api/session-admin/delete', body: { ids: [ID_A] },
  }))
  const payload = res.json
  check('删除成功回 200', res.statusCode === 200, String(res.statusCode))
  check('deleted 计数为 1', payload?.deleted === 1, JSON.stringify(payload))
  check('保持归档（列表立即隐藏）', state.archived.has(ID_A) === true)
  check('没有再 unarchive（保持归档）', state.unarchived.includes(ID_A) === false)
  check('从工作区记账移除', state.detached.includes(ID_A))
  check('同工作区其它会话不受影响',
    state.workspaces[0].sessionIds.includes(ID_B) === true &&
    state.workspaces[0].sessionIds.includes(ID_A) === false,
    JSON.stringify(state.workspaces[0].sessionIds))
  check('磁盘目录已删除', existsSync(join(sandbox, 'sessions', '--D-AI-demo--', UUID_A)) === false)
  check('removedDirs 计数正确', payload?.results?.[0]?.removedDirs === 1, JSON.stringify(payload?.results))
}

// 运行时真实格式：registry 返回的是**裸 uuid**（zod brandString 剥了 `session-` 前缀），
// 所以前端点删除时 POST 的也是裸 uuid。这条必须单独跑一遍——只测带前缀那条会漏掉
// 「裸 uuid 被 slice 掉前 8 字符、定位不到目录」这个真实 bug（2026-11-03 实测）。
console.log('[session-admin] /delete 裸 uuid（运行时真实格式）')
{
  const UUID_C = 'cccccccc-dddd-4eee-8fff-111111111111'
  makeSessionDir('--D-AI-bare--', UUID_C)
  const { ctx, routes, state } = makeFakeCtx({
    archived: [UUID_C],
    workspaces: [{ title: 'Bare', sessionIds: [UUID_C] }],
  })
  applySessionAdmin(ctx)
  const route = routes[0]

  const res = await call(route, makeReq({
    method: 'POST', url: '/api/session-admin/delete', body: { ids: [UUID_C] },
  }))
  const payload = res.json
  check('裸 uuid 删除成功（不被当成非法 id）', res.statusCode === 200 && payload?.deleted === 1,
    `${String(res.statusCode)} ${JSON.stringify(payload)}`)
  check('裸 uuid 保持归档', state.archived.has(UUID_C) === true)
  check('裸 uuid 没有再 unarchive', state.unarchived.includes(UUID_C) === false)
  check('裸 uuid 从工作区记账移除', state.detached.includes(UUID_C))
  check('裸 uuid 的磁盘目录已删除',
    existsSync(join(sandbox, 'sessions', '--D-AI-bare--', UUID_C)) === false)
}

// 判据从「sessions store 里有没有驻留」改成「registry 报不报活动」。
// 前者太宽：DSH 会 retain 所有打开过的会话，用户界面上根本没有「关闭」入口，
// 结果是「什么会话都删不掉」（2026-11-03 用户实测：提示『会话仍在运行』）。
console.log('[session-admin] /delete 真正在跑的会话才拒绝')
{
  // 必须是**未归档**的会话才会触发归档探针（已归档的跳过活动检查，
  // 因为归档当时已经检查过、且归档后 pre-step gate 会阻止它被唤醒）。
  const { ctx, routes, state } = makeFakeCtx({
    archived: [],
    active: new Set([ID_B]),
  })
  applySessionAdmin(ctx)
  const route = routes[0]

  const res = await call(route, makeReq({
    method: 'POST', url: '/api/session-admin/delete', body: { ids: [ID_B] },
  }))
  const payload = res.json
  check('活动会话删除失败', payload?.deleted === 0, JSON.stringify(payload))
  check('活动会话没有被写进归档集合', state.archived.has(ID_B) === false)
  check('活动会话目录未被删', existsSync(join(sandbox, 'sessions', '--D-AI-other--', UUID_B)) === true)
  check('失败原因可读且点名活动',
    typeof payload?.results?.[0]?.error === 'string'
      && payload.results[0].error.includes('运行')
      && payload.results[0].error.includes('turn'),
    JSON.stringify(payload?.results?.[0]))
}

// 未归档的空闲会话：删除前会先归档（探针通过）再走清理，必须能删。
console.log('[session-admin] /delete 未归档的空闲会话可删除')
{
  const UUID_F = 'ffffffff-1111-4222-8333-444444444444'.replace(/f/g, 'b')
  makeSessionDir('--D-AI-live--', UUID_F)
  const { ctx, routes, state } = makeFakeCtx({
    archived: [],
    workspaces: [{ title: 'Live', sessionIds: [UUID_F] }],
  })
  applySessionAdmin(ctx)
  const route = routes[0]

  const res = await call(route, makeReq({
    method: 'POST', url: '/api/session-admin/delete', body: { ids: [UUID_F] },
  }))
  const payload = res.json
  check('未归档空闲会话 → 删除成功', payload?.deleted === 1, JSON.stringify(payload))
  check('未归档空闲会话 → 先调过 archiveSession', state.archivedCalls.includes(UUID_F))
  check('未归档空闲会话 → 保持归档（列表立即隐藏）', state.archived.has(UUID_F) === true)
  check('未归档空闲会话 → 目录已删',
    existsSync(join(sandbox, 'sessions', '--D-AI-live--', UUID_F)) === false)
}

// 反向判据：会话**驻留**在 sessions store 里（打开过）但 registry 报无活动，
// 必须能删掉。这是用户实际卡住的那条路径。
console.log('[session-admin] /delete 驻留但空闲的会话可删除')
{
  const UUID_D = 'dddddddd-eeee-4fff-8aaa-222222222222'
  makeSessionDir('--D-AI-idle--', UUID_D)
  const { ctx, routes, state } = makeFakeCtx({
    archived: [UUID_D],
    live: new Set([UUID_D]),
    workspaces: [{ title: 'Idle', sessionIds: [UUID_D] }],
  })
  applySessionAdmin(ctx)
  const route = routes[0]

  const res = await call(route, makeReq({
    method: 'POST', url: '/api/session-admin/delete', body: { ids: [UUID_D] },
  }))
  const payload = res.json
  check('驻留但空闲 → 删除成功', payload?.deleted === 1, JSON.stringify(payload))
  check('驻留但空闲 → 目录已删',
    existsSync(join(sandbox, 'sessions', '--D-AI-idle--', UUID_D)) === false)
  check('驻留但空闲 → 记账已清', state.detached.includes(UUID_D))
}

// 僵尸记账：注册表里**已归档**、日志早就不在磁盘上（本机实测 18 条）。
// 已归档的跳过探针，dirs=0 属于正常，必须放行清理（否则永远清不掉）。
console.log('[session-admin] /delete 僵尸记账放行')
{
  const UUID_E = 'eeeeeeee-ffff-4aaa-8bbb-333333333333'
  const { ctx, routes, state } = makeFakeCtx({
    archived: [UUID_E],
    unknown: new Set([UUID_E]),
  })
  applySessionAdmin(ctx)
  const route = routes[0]

  const res = await call(route, makeReq({
    method: 'POST', url: '/api/session-admin/delete', body: { ids: [UUID_E] },
  }))
  const payload = res.json
  check('僵尸记账 → 删除成功', payload?.deleted === 1, JSON.stringify(payload))
  check('僵尸记账 → 仍在归档集合', state.archived.has(UUID_E) === true)
}

// 回归判据（2026-11-03 用户实测踩到）：**未归档**会话定位不到日志目录时，
// 绝不能继续 detach —— 那会让会话从原工作区掉进「未分组」、还留在列表里。
// 正确行为是中止，并把探针写进归档集合的 id 回滚掉。
console.log('[session-admin] /delete 未归档却定位不到目录 → 中止且不 detach')
{
  const UUID_G = '99999999-8888-4777-8666-555555555555'
  const { ctx, routes, state } = makeFakeCtx({
    archived: [],
    workspaces: [{ title: 'Ghost', sessionIds: [UUID_G] }],
  })
  applySessionAdmin(ctx)
  const route = routes[0]

  const res = await call(route, makeReq({
    method: 'POST', url: '/api/session-admin/delete', body: { ids: [UUID_G] },
  }))
  const payload = res.json
  check('定位不到目录 → 删除失败', payload?.deleted === 0, JSON.stringify(payload))
  check('定位不到目录 → 没有 detach（不会掉进未分组）', state.detached.includes(UUID_G) === false)
  check('定位不到目录 → 工作区记账原样保留',
    state.workspaces[0].sessionIds.includes(UUID_G) === true, JSON.stringify(state.workspaces[0].sessionIds))
  check('定位不到目录 → 探针归档已回滚', state.archived.has(UUID_G) === false)
  check('失败原因点明「未分组」风险',
    typeof payload?.results?.[0]?.error === 'string' && payload.results[0].error.includes('未分组'),
    JSON.stringify(payload?.results?.[0]))
}

// 收尾：删掉临时沙箱（不留在 %TEMP% 里）。
rmSync(sandbox, { recursive: true, force: true })

console.log('')
if (failures === 0) {
  console.log('TEST PASSED — session-admin')
  process.exit(0)
} else {
  console.log(`TEST FAILED — ${String(failures)} 项不通过`)
  process.exit(1)
}
