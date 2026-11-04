/**
 * 消息撤回（vendor 移植自 dsh-recall-plugin）装配冒烟。
 *
 * 这里不跑快照本体（它要真 git + 真 shell + 真会话），只钉四件**错了不会抛错、
 * 只会静默失效**的事：
 *   1. host 产物导出 applyRecallHost / recallInjects / RecallConfig，插件形状合法；
 *   2. 用最小假 ctx 调 applyRecallHost 不抛错，且 /api/recall/* 端点确实注册
 *      （端点表漏一个 = 客户端点「撤回」永远 404）；
 *   3. session/event 监听确实装上（漏装 = 每条消息都不产生快照，按钮永远不出现）；
 *   4. client 产物里撤回模块真的被打进去（槽位 id / 版本翻页器 / CSS 降级都带
 *      过去），并且主 bundle 的 apply 里挂了 ctx.inject 三个服务。
 *
 * 真实链路（快照 → 清单 → 回退 → fork）需要真宿主，见 README「消息撤回」一节
 * 的手工验收步骤；本冒烟只做装配层回归。
 *
 * Usage: node scripts/test-recall.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const HOST = resolve(ROOT, 'lib/index.js')
const CLIENT = resolve(ROOT, 'lib/client.js')

let failed = 0
const fail = (msg) => { console.error('FAIL  ' + msg); failed++ }
const pass = (msg) => { console.log('ok    ' + msg) }
const assert = (cond, msg, detail) => { if (cond) pass(msg); else fail(msg + (detail ? '  | ' + detail : '')) }

// 隔离 DSH_HOME：host 的召回模块会解析 home 容器路径、可能建目录；绝不碰用户真实 ~/.dsh。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-recall-smoke-home-'))
process.env.DSH_HOME = HOME
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 清理失败不改断言 */ } })

if (!existsSync(HOST) || !existsSync(CLIENT)) {
  console.error('FAIL  lib/index.js 或 lib/client.js 不存在，先跑 node build.mjs')
  process.exit(1)
}

// ── 1. host 导出形状 ────────────────────────────────────────────────────
const mod = await import(pathToFileURL(HOST).href)
assert(typeof mod.applyRecallHost === 'function', 'host: 导出 applyRecallHost(ctx, rawConfig)')
assert(Array.isArray(mod.recallInjects) && mod.recallInjects.length === 3
  && mod.recallInjects.includes('shell') && mod.recallInjects.includes('sessions') && mod.recallInjects.includes('agents'),
'most: recallInjects = shell/sessions/agents', JSON.stringify(mod.recallInjects))
assert(mod.RecallConfig !== undefined, 'host: 导出 RecallConfig（Schemastery schema）')
// 2026-11-04：默认语义 = 「只撤回对话」——文件回退关闭 + 不写文件快照。
// 这两条默认值写反了不会抛错，只会表现为「点撤回又把工作区改回去了」。
const defaults = mod.RecallDefaults || {}
assert(defaults.fileRollbackEnabled === false, 'config 默认: fileRollbackEnabled=false（撤回不动项目文件）', JSON.stringify(defaults.fileRollbackEnabled))
assert(defaults.messageOnly === true, 'config 默认: messageOnly=true（不写文件快照）', JSON.stringify(defaults.messageOnly))
assert(mod.name === 'dsh-seeker-bot', 'host: 插件名仍是 dsh-seeker-bot', String(mod.name))

// ── 2. 最小假 ctx 驱动 applyRecallHost ──────────────────────────────────
const routes = []
const events = []
const effects = []
function makeConnectionCtx() {
  return {
    effect: (fn) => { const d = fn(); effects.push(typeof d) },
    connection: {
      fetch: {
        register: (route) => { routes.push(route); return () => {} },
      },
    },
  }
}
const settingsStub = {
  writable: true,
  describe: () => [{ ns: 'dsh-seeker-bot' }],
  update: async () => {},
}
const ctx = {
  logger: { warn: () => {}, info: () => {}, error: () => {} },
  effect: (fn) => { const d = fn(); effects.push(typeof d); return () => {} },
  on: (name, handler) => { events.push({ name, handler }) },
  emit: () => {},
  get: () => undefined,
  inject: (deps, cb) => {
    if (deps.includes('connection')) cb(makeConnectionCtx())
    // settings 桩按 0.1.7+ 新面（describe/update，无 installSection/register）。
    // ns 解析要靠 ctx.fiber.entry（新面 ns = profile entry id），这里把本包
    // 在 cordis.patch.yml 里的 insert 行 id 摆上，验证「热更监听真的会挂」。
    if (deps.includes('settings')) cb({ settings: settingsStub, effect: () => () => {} })
  },
  fiber: { entry: { id: 'include:dsh-seeker-bot', options: { id: 'dsh-seeker-bot' } } },
  agents: { list: () => [] },
  sessions: { list: () => [] },
  shell: { resolve: () => ({}), execute: async () => ({ result: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }) },
  // 参考实现里 runtime 需要编码模板 / 平台判定；这里给最小占位让它走到「预热因
  // shell 未就绪而放弃」的正常降级路径，不为了冒烟伪造整条 shell 链。
  get 'sessionQuery'() { return undefined },
}

let applied = null
try {
  mod.applyRecallHost(ctx, {})
  applied = true
  pass('host: applyRecallHost(ctx, {}) 同步路径不抛错')
} catch (error) {
  fail('host: applyRecallHost(ctx, {}) 抛错  | ' + (error && error.stack ? String(error.stack).split('\n').slice(0, 3).join(' ') : String(error)))
}

const names = routes.map((r) => String(r && r.path).replace(/^\/api\/recall\//, ''))
const expected = ['init', 'snapshot-info', 'preview', 'execute', 'status', 'lineage-record', 'notify']
for (const name of expected) {
  assert(names.includes(name), 'host: 注册 /api/recall/' + name, 'got=' + names.join(','))
}
assert(routes.length >= 12, 'host: 端点表规模合理（>=12 条）', 'got=' + routes.length)
assert(routes.every((r) => r.path === undefined || String(r.path).startsWith('/api/recall/')), 'host: 端点路径全部在 /api/recall/ 下')
assert(routes.every((r) => Array.isArray(r.methods) && r.methods.length > 0), 'host: 每个端点都声明了 methods')
assert(routes.every((r) => typeof r.fetch === 'function'), 'host: 每个端点都带 fetch handler')

// session/event 监听：撤回的全部触发点都在这里
const sessionEvt = events.find((e) => e.name === 'session/event')
assert(Boolean(sessionEvt), 'host: 监听 session/event（快照触发点）')
assert(Boolean(events.find((e) => e.name === 'loader/volatile-update')), 'host: 监听 loader/volatile-update（settings 热更）')

// 触发一次 session/event，确认 handler 是同步安全的（真快照走异步队列，此处只验
// 它不会把异常抛回宿主：抛了会毁掉每条用户消息的派发）。
try {
  sessionEvt.handler({ id: 'smoke-session', header: { cwd: ROOT } }, { type: 'user/message', time: Date.now(), data: { id: 'smoke-msg-1', source: { kind: 'user' } } })
  pass('host: session/event 处理器同步返回不抛错')
} catch (error) {
  fail('host: session/event 处理器抛错  | ' + String(error && error.message || error))
}

// ── 2b. Agent 忙判据的 self / cross 分流（2026-11-04 用户现场回归钉）────────
// 起因：用户点「↶ 撤回」被「Agent 正在运行中，请先停止后再撤回」挡住，而他
// 既没在跑那个会话、也无从停止「同工作区的另一个会话」——上游把两种忙揉成
// 一个布尔，连带拦掉了不碰文件的「仅撤回对话」。这里钉住拆分后的判据。
const norm = (p) => process.platform === 'win32'
  ? (String(p).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '') || '\\')
  : (String(p).replace(/\/+$/, '') || '/')
const agents = [
  { id: 's-self', status: 'running', session: { header: { id: 's-self', cwd: 'D:\\W' } } },
  { id: 's-other', status: 'running', session: { header: { id: 's-other', cwd: 'D:\\W' } } },
  { id: 's-idle', status: 'idle', session: { header: { id: 's-idle', cwd: 'D:\\W' } } },
  { id: 's-elsewhere', status: 'running', session: { header: { id: 's-elsewhere', cwd: 'D:\\OTHER' } } },
]
assert(typeof mod.isSelfAgentBusy === 'function' && typeof mod.isCrossAgentBusy === 'function', 'host: 导出 self/cross 两个忙判据')
assert(mod.isSelfAgentBusy(agents, 's-self') === true, 'self: 自己这个会话在跑 → 忙')
assert(mod.isSelfAgentBusy(agents, 's-idle') === false, 'self: 空闲会话不算忙')
assert(mod.isSelfAgentBusy(agents, 's-missing') === false, 'self: 不在列表的会话不算忙')
assert(mod.isCrossAgentBusy(agents, 's-self', 'D:\\W', norm) === true, 'cross: 同工作区别的会话在跑 → 命中')
assert(mod.isCrossAgentBusy(agents, 's-other', 'D:\\W', norm) === true, 'cross: 换一个会话视角同样命中')
assert(mod.isCrossAgentBusy(agents, 's-elsewhere', 'D:\\OTHER', norm) === false, 'cross: 会话自己跑不算跨会话忙')
assert(mod.isCrossAgentBusy([{ id: 's-y', status: 'running', session: { header: { cwd: 'd:/w/' } } }], 's-x', 'D:\\W', norm) === true, 'cross: 大小写 / 正反斜杠 / 尾分隔符归一后仍命中')
assert(mod.isCrossAgentBusy(agents, 's-self', null, norm) === false, 'cross: 没有工作区根时不判 cross')

// ── 3. client 产物里的撤回模块 ──────────────────────────────────────────
const client = readFileSync(CLIENT, 'utf8')
const markers = [
  ['recall-version-pager', '版本翻页器槽位 id'],
  ['conversation.chat.node', '用户消息节点座位'],
  ['/api/recall/', '客户端 API 前缀'],
  ['dsh-recall:versions:', '版本家族 localStorage 键'],
  ['dsh-recall-snapshots', '快照存储目录名（配置文案/默认值）'],
]
for (const [needle, what] of markers) {
  assert(client.includes(needle), 'client: 产物含 ' + what + '（' + needle + '）')
}
// 2026-11-04：Work 模式的「编辑并重发」已按用户要求删除。这几条是反向断言——
// 上游升级若把编辑卡整块带回来，这里会先响，而不是等用户又看到 ✎ 按钮。
for (const needle of ['buildEditFlow', 'dsh-recall-composer', 'action.edit']) {
  assert(!client.includes(needle), 'client: 产物不含编辑重发残留（' + needle + '）')
}
assert(client.includes('applyRecallClient'), 'client: 产物含 applyRecallClient 入口')
assert(!client.includes("id:'dsh-recall-plugin'") && !client.includes('id: "dsh-recall-plugin"'),
  'client: 不再注册独立 ModuleLoader id（撤回随主 bundle 挂载）')
assert(client.includes('dsh-seeker-bot'), 'client: plugins.bundle.config 的 key 用本包名')

// ── 4. 主入口接线：ctx.inject 三个延迟服务 ──────────────────────────────
const entry = readFileSync(resolve(ROOT, 'src/client/index.ts'), 'utf8')
for (const svc of ['workspaces', 'uiWorkspace', 'timer']) {
  assert(entry.includes("'" + svc + "'"), 'client 入口: 撤回模块延迟注入声明了 ' + svc)
}

if (failed > 0) {
  console.error('\nSMOKE FAILED — ' + failed + ' 项')
  process.exit(1)
}
console.log('\nSMOKE PASSED — lib/index.js + lib/client.js（撤回装配层）')
