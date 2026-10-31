/**
 * dsh-seeker-bot — Bot host 核心回归测试（桩 ctx + 真 HTTP）。
 *
 * 覆盖 task-1 的验收面：
 *   1. v1 → v2 迁移（字段补齐、session 绑定反推、备份文件、磁盘写回）；
 *   2. Bot 建/改/删/主 Bot 补位/复制/暂停恢复；
 *   3. 会话创建与绑定（workspaceRegistry → workspaceId 路径、session 列表、手动绑定）；
 *   4. 岗位注入段（名字/岗位/instructions/记忆与外部写操作边界/图表偏好，取不到 sessionId 放行）；
 *   5. 模型优先级（群 unified > Bot > 默认）与官方 selectModel 写入；
 *   6. 日程 CRUD + 官方 schedule 包装 + webhook 403 / 200 / 429 与 failed run；
 *   7. 群组 @ 路由决策（纯函数 + HTTP）；
 *   8. 主动找我配置与判定（skipped 如实返回）；
 *   9. 同源校验、404/400 错误一律 JSON、/ui/mode 与 /health 兼容。
 *
 * 用 esbuild 把 src/bot/index.ts 打成临时 ESM，再在临时 DSH_HOME 上跑真 HTTP。
 * 这样测的是源码当时的行为，不依赖 lib/index.js 是否已重新构建。
 *
 * Usage: node scripts/test-bot-host.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const require = createRequire(import.meta.url)

const WORK = join(ROOT, '_tmp', 'bot-host-test-' + process.pid + '-' + Math.random().toString(36).slice(2, 8))
const DSH_HOME = join(WORK, 'dsh-home')
process.env.DSH_HOME = DSH_HOME

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
}

/* ───────────────────────── 1. 预置 v1 state.json ───────────────────────── */

const stateDir = join(DSH_HOME, 'storages', 'dsh-seeker-bot')
mkdirSync(stateDir, { recursive: true })
writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
  version: 1,
  bots: [{
    id: 'bot-v1',
    name: '老搭档',
    role: '研究员',
    avatar: { shape: 'whale', color: '#0f1115' },
    instructions: 'v1 指令',
    primary: true,
    pinned: false,
    section: '项目',
    hidden: false,
    paused: false,
    notification: true,
    sessionIds: ['sess-old'],
    createdAt: 123,
    createdBy: null,
    status: 'idle',
  }],
  groups: [],
  ui: { mode: 'bot' },
}, null, 2), 'utf8')

/* ───────────────────────── 2. 打包 Bot 模块 ─────────────────────────────── */

const esbuild = require('esbuild')
const bundleFile = join(WORK, 'bot-host.mjs')
await esbuild.build({
  entryPoints: [resolve(ROOT, 'src/bot/index.ts')],
  outfile: bundleFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
})
const mod = await import(pathToFileURL(bundleFile).href)
const { applyBotHost, __test } = mod

/* ───────────────────────── 3. 桩 ctx + 真 HTTP ──────────────────────────── */

const listeners = new Map()
const calls = {
  sessionCreate: [],
  selectModel: [],
  workspaceCreate: [],
  scheduleCreate: [],
  scheduleList: [],
  scheduleUpdate: [],
  scheduleDelete: [],
}
const services = {
  sessionController: {
    async create(request) {
      calls.sessionCreate.push(request)
      return { sessionId: 'session-created-' + calls.sessionCreate.length }
    },
    async selectModel(request) {
      calls.selectModel.push(request)
      return { selected: { provider: request.provider, model: request.model } }
    },
    // 刻意不提供 prompt：日程 test 必须如实返回「没有可驱动 agent」。
  },
  workspaceRegistry: {
    async create(dir, title) {
      calls.workspaceCreate.push({ dir, title })
      return { id: 'ws-seekerbot-1', title, path: dir }
    },
  },
  schedule: {
    async create(sessionId, request) {
      calls.scheduleCreate.push({ sessionId, request })
      return { id: 'sched-1', kind: 'cron', title: request.title, prompt: request.prompt, scheduledAt: new Date().toISOString() }
    },
    async list(request) {
      calls.scheduleList.push(request)
      return [{
        id: 'sched-1',
        kind: 'cron',
        title: '每日晨报',
        prompt: '汇总昨天的进展',
        expression: '0 9 * * *',
        timeZone: 'Asia/Shanghai',
        scheduledAt: '2026-11-01T01:00:00.000Z',
      }]
    },
    async update(request) {
      calls.scheduleUpdate.push(request)
      return { id: request.id, updated: true, record: { ...request.expected, title: request.title, prompt: request.prompt } }
    },
    async delete(request) {
      calls.scheduleDelete.push(request)
      return { id: request.id, deleted: true }
    },
  },
}

let registeredRoute = null
const ctx = {
  logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get(name) {
    return services[name]
  },
  on(event, listener) {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return () => {}
  },
  inject(_names, callback) { callback(ctx) },
  webServer: {
    register(spec) { registeredRoute = spec; return () => {} },
  },
}

applyBotHost(ctx)
__test.prompt.applyBotPrompt(ctx)

if (registeredRoute === null || typeof registeredRoute.handler !== 'function') {
  console.error('FAIL  applyBotHost 没有注册 /api/seeker-bot 路由')
  process.exit(1)
}
const handler = registeredRoute.handler
const server = createServer((req, res) => handler(req, res))
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const base = 'http://127.0.0.1:' + server.address().port

async function request(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(base + path, init)
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 会在断言里体现 */ }
  return { status: response.status, json, text }
}

/* ───────────────────────── 4. 断言 ──────────────────────────────────────── */

console.log('[bot-host] v1 → v2 迁移')
{
  const state = await request('GET', '/state')
  check('GET /state 200 且 version=2', state.status === 200 && state.json?.version === 2, JSON.stringify(state.json))
  const migrated = state.json?.bots?.find((bot) => bot.id === 'bot-v1')
  check('迁移保留 v1 Bot 与名字', migrated?.name === '老搭档' && migrated?.role === '研究员')
  check('迁移补齐 workspace/description/skills', migrated?.workspace === '' && migrated?.description === '' && Array.isArray(migrated?.skills) && migrated.skills.length === 0)
  check('迁移补齐 memoryWorkspace=seekerbot', migrated?.memoryWorkspace === 'seekerbot')
  check('迁移补齐 output/proactive 默认值', migrated?.output?.charts === true && migrated?.output?.pages === true && migrated?.proactive?.enabled === false)
  check('迁移从 sessionIds 反推绑定表', state.json?.sessions?.['sess-old'] === 'bot-v1')
  check('迁移生成 .v1-backup-* 备份', readdirSync(stateDir).some((name) => name.startsWith('state.json.v1-backup-')))
  const disk = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
  check('迁移后磁盘 state.json 已是 version=2', disk.version === 2)
  check('/state 暴露 routines/rules/usage/sessions', Array.isArray(disk.routines) && Array.isArray(disk.rules) && typeof disk.usage === 'object' && typeof disk.sessions === 'object')
}

console.log('[bot-host] Bot CRUD / 主 Bot 补位 / 复制 / 暂停')
let botA
let botB
let botCopy
{
  const createA = await request('POST', '/bots', { name: '小明', role: '工程师', description: '负责实现' })
  check('POST /bots 201', createA.status === 201)
  botA = createA.json.bot
  check('非首个 Bot 不是主', botA.primary === false)
  const createB = await request('POST', '/bots', { name: '小红', role: '设计师' })
  botB = createB.json.bot
  check('创建第二个 Bot', createB.status === 201 && botB.name === '小红')

  const patch = await request('PATCH', '/bots/' + botA.id, { name: '小明2', description: '改过的描述' })
  check('PATCH /bots 改名+描述', patch.status === 200 && patch.json.bot.name === '小明2' && patch.json.bot.description === '改过的描述')

  const primary = await request('POST', '/bots/' + botA.id + '/primary')
  check('POST /bots/:id/primary', primary.status === 200 && primary.json.bot.primary === true)
  const afterPrimary = await request('GET', '/state')
  check('旧主 Bot 取消主位', afterPrimary.json.bots.find((bot) => bot.id === 'bot-v1').primary === false)

  const duplicate = await request('POST', '/bots/' + botB.id + '/duplicate')
  check('POST /bots/:id/duplicate 201', duplicate.status === 201)
  botCopy = duplicate.json.bot
  check('复制不拷贝 sessionIds 且不是主', Array.isArray(botCopy.sessionIds) && botCopy.sessionIds.length === 0 && botCopy.primary === false)
  check('复制名字带「副本」', String(botCopy.name).includes('副本'))

  const pause = await request('POST', '/bots/' + botB.id + '/pause')
  check('POST /bots/:id/pause', pause.status === 200 && pause.json.bot.paused === true)
  const resume = await request('POST', '/bots/' + botB.id + '/resume')
  check('POST /bots/:id/resume', resume.status === 200 && resume.json.bot.paused === false)

  const del = await request('DELETE', '/bots/' + botA.id)
  check('DELETE 主 Bot 200', del.status === 200)
  const afterDelete = await request('GET', '/state')
  check('删主 Bot 后自动补位', afterDelete.json.bots.length > 0 && afterDelete.json.bots.some((bot) => bot.primary === true))
}

console.log('[bot-host] 会话创建与绑定')
let sessionId = ''
{
  const created = await request('POST', '/bots/' + botB.id + '/session')
  check('POST /bots/:id/session 201', created.status === 201, created.text)
  sessionId = created.json?.sessionId ?? ''
  check('返回 sessionId', typeof sessionId === 'string' && sessionId.startsWith('session-created-'))
  check('共享工作区走 workspaceId', calls.sessionCreate.at(-1)?.workspaceId === 'ws-seekerbot-1', JSON.stringify(calls.sessionCreate.at(-1)))
  check('workspaceRegistry.create(dir, seekerbot)', calls.workspaceCreate.at(-1)?.title === 'seekerbot' && String(calls.workspaceCreate.at(-1)?.dir).endsWith('seekerbot'))
  check('共享目录已创建', existsSync(join(DSH_HOME, 'seekerbot')))

  const list = await request('GET', '/bots/' + botB.id + '/sessions')
  check('GET /bots/:id/sessions 含新会话', list.status === 200 && list.json.sessions.some((item) => item.sessionId === sessionId))
  const bind = await request('POST', '/session/bind', { sessionId: 'session-manual', botId: botB.id })
  check('POST /session/bind 200', bind.status === 200 && bind.json.ok === true)
  const stateBound = await request('GET', '/state')
  check('绑定表持久化', stateBound.json.sessions['session-manual'] === botB.id)
  check('Bot.sessionIds 同步', stateBound.json.bots.find((bot) => bot.id === botB.id).sessionIds.includes('session-manual'))

  const noService = await __test.sessions.createBotSession({}, botB)
  check('无会话服务时返回可读错误', noService.ok === false && String(noService.error).includes('会话服务不可用'))
}

console.log('[bot-host] 岗位注入段')
{
  const assemble = listeners.get('system-prompt/assemble')?.[0]
  check('applyBotPrompt 注册 assemble 监听', typeof assemble === 'function')
  const upstream = { sections: [{ name: 'base', text: 'BASE' }] }
  const result = await assemble(upstream, { agent: { session: { id: sessionId } } }, async () => upstream)
  const joined = result.sections.map((section) => String(section.text)).join('\n')
  check('保留原有段', result.sections[0]?.name === 'base' && result.sections[0]?.text === 'BASE')
  check('追加 # 你的身份', joined.includes('# 你的身份'))
  check('身份含名字与岗位', joined.includes('你是「小红」') && joined.includes('岗位：设计师'))
  check('身份含 instructions', joined.includes('你是「小红」，岗位：设计师。'))
  check('身份含记忆不是事实源', joined.includes('记忆不是事实源'))
  check('身份含外部写操作边界', joined.includes('未经批准不要执行外部写操作'))
  check('图表偏好注入', joined.includes('数据类回答优先用图表') && joined.includes('```iu') && joined.includes('```html'))

  const noSession = await assemble(upstream, {}, async () => upstream)
  check('取不到 sessionId 静默放行', noSession.sections.length === 1)
  const nullContext = await assemble(upstream, null, async () => upstream)
  check('context 为 null 不抛穿', nullContext.sections.length === 1)

  await request('PATCH', '/bots/' + botB.id, { output: { charts: false, pages: false } })
  const noOutput = await assemble({ sections: [] }, { agent: { session: { id: sessionId } } }, async () => ({ sections: [] }))
  check('output 全关时不追加产出偏好', !noOutput.sections.some((section) => String(section.text).includes('图表')))
  await request('PATCH', '/bots/' + botB.id, { output: { charts: true, pages: true } })
}

console.log('[bot-host] 模型优先级')
let groupId = ''
{
  const set = await request('PATCH', '/bots/' + botB.id, { model: { provider: 'deepseek', model: 'deepseek-chat', effort: 'high' } })
  check('PATCH bot.model', set.status === 200 && set.json.bot.model.provider === 'deepseek')
  const resolvedBot = await request('GET', '/models/resolve?session=' + encodeURIComponent(sessionId))
  check('Bot 级模型生效', resolvedBot.json.model.source === 'bot' && resolvedBot.json.model.provider === 'deepseek')

  const group = await request('POST', '/groups', {
    name: '项目群',
    botIds: [botB.id, botCopy.id],
    model: { mode: 'unified', provider: 'grok', model: 'grok-4', effort: 'low' },
  })
  check('POST /groups 201', group.status === 201, group.text)
  groupId = group.json.group.id
  check('群视图带 members 名字', Array.isArray(group.json.group.members) && group.json.group.members.some((member) => member.name === '小红'))
  const resolvedGroup = await request('GET', '/models/resolve?session=' + encodeURIComponent(sessionId))
  check('群统一模型优先于 Bot', resolvedGroup.json.model.source === 'group' && resolvedGroup.json.model.provider === 'grok')

  const applied = await __test.models.applyModelPrefsToSession(ctx, sessionId)
  check('applyModelPrefsToSession 写入官方 selectModel', applied.applied === true && calls.selectModel.at(-1)?.provider === 'grok' && calls.selectModel.at(-1)?.reasoningEffort === 'low', JSON.stringify(applied))

  const inherit = await request('PATCH', '/groups/' + groupId, { model: { mode: 'inherit' } })
  check('PATCH /groups 改 inherit', inherit.status === 200)
  const resolvedInherit = await request('GET', '/models/resolve?session=' + encodeURIComponent(sessionId))
  check('inherit 时回落到 Bot 模型', resolvedInherit.json.model.source === 'bot' && resolvedInherit.json.model.provider === 'deepseek')
}

console.log('[bot-host] 日程 CRUD 与 webhook 限流')
{
  const created = await request('POST', '/routines', {
    botId: botB.id,
    name: '每日晨报',
    instruction: '汇总昨天的进展',
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
  })
  check('POST /routines 201', created.status === 201, created.text)
  const routine = created.json.routine
  check('生成 webhook key', typeof routine.key === 'string' && routine.key.length >= 16)
  check('包装官方 schedule.create', created.json.schedule?.ok === true && routine.scheduleId === 'sched-1')
  check('cron 与 timezone 传给官方服务', calls.scheduleCreate.at(-1)?.request?.cron?.expression === '0 9 * * *' && calls.scheduleCreate.at(-1)?.request?.cron?.time_zone === 'Asia/Shanghai')

  const list = await request('GET', '/routines?botId=' + botB.id)
  check('GET /routines 含新日程', list.status === 200 && list.json.routines.some((item) => item.id === routine.id))

  const patched = await request('PATCH', '/routines/' + routine.id, { name: '每日晚报', instruction: '汇总今天的进展' })
  check('PATCH /routines 200', patched.status === 200 && patched.json.routine.name === '每日晚报')
  check('包装官方 schedule.update', patched.json.schedule?.ok === true && calls.scheduleUpdate.length === 1)

  const tested = await request('POST', '/routines/' + routine.id + '/test')
  check('POST /routines/:id/test 200 且如实未投递', tested.status === 200 && tested.json.delivered === false && String(tested.json.reason).includes('没有可驱动'))
  const runsAfterTest = await request('GET', '/routines/' + routine.id + '/runs')
  check('test 写运行记录', runsAfterTest.json.runs.length === 1 && runsAfterTest.json.runs[0].trigger === 'test')

  const forbidden = await request('POST', '/webhook/' + routine.id + '/wrong-key')
  check('webhook 错误 key 403', forbidden.status === 403 && forbidden.json?.ok === false)
  const accepted = await request('POST', '/webhook/' + routine.id + '/' + routine.key)
  check('webhook 正确 key 200（只代表已接受）', accepted.status === 200 && accepted.json?.accepted === true)
  const limited = await request('POST', '/webhook/' + routine.id + '/' + routine.key)
  check('webhook 最小间隔 429', limited.status === 429 && limited.json?.rateLimited === true)
  const runsAfterLimit = await request('GET', '/routines/' + routine.id + '/runs')
  check('429 写入 failed run', runsAfterLimit.json.runs.some((run) => run.status === 'failed'))
  check('运行记录保留上限 20', runsAfterLimit.json.runs.length <= 20)

  const removed = await request('DELETE', '/routines/' + routine.id)
  check('DELETE /routines 200 且删除官方任务', removed.status === 200 && calls.scheduleDelete.length === 1)
}

console.log('[bot-host] 群组 @ 路由')
{
  const mention = await request('POST', '/groups/' + groupId + '/decide', { text: '@小红 看一下这个' })
  check('群 @ 命中 Bot', mention.status === 200 && mention.json.decision.botId === botB.id && mention.json.decision.reason === 'mention', mention.text)
  const noMention = await request('POST', '/groups/' + groupId + '/decide', { text: '大家好' })
  check('群无 @ 回落群主/第一个 Bot', noMention.json.decision.botId === botB.id)
  const pure = __test.groups.decideSpeaker({ botIds: ['a', 'b'], primaryBotId: 'b', members: [{ id: 'a', name: '阿' }, { id: 'b', name: '贝' }] }, '@贝 你好')
  check('decideSpeaker 纯函数 @ 优先', pure.botId === 'b' && pure.reason === 'mention')
  const purePrimary = __test.groups.decideSpeaker({ botIds: ['a', 'b'], primaryBotId: 'b' }, '你好')
  check('decideSpeaker 无 @ 用 primaryBotId', purePrimary.botId === 'b' && purePrimary.reason === 'primary')
  const empty = __test.groups.decideSpeaker({ botIds: [] }, '你好')
  check('decideSpeaker 空群返回 null', empty.botId === null && empty.reason === 'no-members')
}

console.log('[bot-host] 主动找我')
{
  const initial = await request('GET', '/bots/' + botB.id + '/proactive')
  check('GET proactive 默认关闭', initial.status === 200 && initial.json.proactive.enabled === false)
  const disabled = await request('POST', '/bots/' + botB.id + '/proactive/test', {
    events: [{ type: 'routine.failed', fingerprint: 'fp-1', title: '失败' }],
  })
  check('proactive/test 默认 disabled 且 skipped', disabled.status === 200 && disabled.json.willSend === false && disabled.json.skipped === true && disabled.json.reason === 'disabled', disabled.text)

  const set = await request('POST', '/bots/' + botB.id + '/proactive', { enabled: true, freq: '4h', from: '00:00', to: '23:59' })
  check('POST proactive 配置', set.status === 200 && set.json.bot.proactive.enabled === true)
  const candidate = await request('POST', '/bots/' + botB.id + '/proactive/test', {
    events: [{ type: 'routine.failed', fingerprint: 'fp-2', title: '失败', severity: 3 }],
  })
  check('窗口内且有候选 → willSend', candidate.json.willSend === true && candidate.json.reason === 'candidate' && candidate.json.skipped === true)

  const outside = __test.proactive.inProactiveWindow('09:00', '18:00', new Date(2026, 0, 1, 7, 30))
  check('窗口判断：窗口外 false', outside === false)
  const crossMidnight = __test.proactive.inProactiveWindow('22:00', '06:00', new Date(2026, 0, 1, 23, 0))
  check('窗口判断：跨午夜 true', crossMidnight === true)

  __test.proactive.__resetProactiveSeen()
  const event = { type: 'routine.failed', fingerprint: 'fp-x', severity: 3 }
  __test.proactive.markProactiveSeen(__test.proactive.fingerprintOf(event))
  const duplicated = __test.proactive.evaluateProactive({ enabled: true, freq: '4h', from: '00:00', to: '23:59' }, [event])
  check('24h 指纹去重', duplicated.willSend === false && duplicated.reason === 'duplicated')
  __test.proactive.__resetProactiveSeen()
}

console.log('[bot-host] 规则 / 用量 / 兼容端点')
{
  const put = await request('PUT', '/rules', {
    rules: [
      { pattern: 'bash:*', action: 'ask' },
      { pattern: '', action: 'allow' },
    ],
  })
  check('PUT /rules 过滤空 pattern', put.status === 200 && put.json.rules.length === 1 && put.json.rules[0].action === 'ask')
  const get = await request('GET', '/rules')
  check('GET /rules', get.status === 200 && get.json.rules.length === 1)
  const usage = await request('GET', '/usage')
  check('GET /usage', usage.status === 200 && typeof usage.json.usage === 'object')
  const health = await request('GET', '/health')
  check('GET /health 兼容', health.status === 200 && health.json.ok === true && health.json.plugin === 'dsh-seeker-bot')
}

console.log('[bot-host] 同源校验与错误 JSON')
{
  const cross = await request('POST', '/bots', { name: '恶意' }, { origin: 'http://evil.example' })
  check('跨站写 403 JSON', cross.status === 403 && cross.json?.ok === false && typeof cross.json.error === 'string')
  const crossRules = await request('PUT', '/rules', { rules: [] }, { origin: 'http://evil.example' })
  check('跨站 PUT /rules 同样 403', crossRules.status === 403 && crossRules.json?.ok === false)
  const sameOrigin = await request('POST', '/bots', { name: '同源测试' }, { origin: base })
  check('同源写放行', sameOrigin.status === 201)
  if (sameOrigin.status === 201) await request('DELETE', '/bots/' + sameOrigin.json.bot.id)
  const notFound = await request('GET', '/nope')
  check('未知路由 404 JSON', notFound.status === 404 && notFound.json?.ok === false)
  const badBind = await request('POST', '/session/bind', { sessionId: '', botId: botB.id })
  check('空 sessionId 400 JSON', badBind.status === 400 && badBind.json?.ok === false)
  const modeBot = await request('POST', '/ui/mode', { mode: 'bot' })
  check('POST /ui/mode bot', modeBot.status === 200 && modeBot.json.mode === 'bot')
  const modeWork = await request('POST', '/ui/mode', { mode: 'work' })
  check('POST /ui/mode work', modeWork.status === 200 && modeWork.json.mode === 'work')
}

/* ───────────────────────── 5. 收尾 ──────────────────────────────────────── */

await new Promise((resolveClose) => server.close(resolveClose))

if (failures > 0) {
  console.error('FAIL ' + failures + ' / ' + checks + ' 项断言失败；现场保留在 ' + WORK)
  process.exit(1)
}
try { rmSync(WORK, { recursive: true, force: true }) } catch { /* ignore */ }
console.log('PASS ' + checks + ' 项断言全部通过（dsh-seeker-bot bot host core）')
