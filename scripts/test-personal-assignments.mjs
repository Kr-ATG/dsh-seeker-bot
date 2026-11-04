#!/usr/bin/env node
/**
 * Personal Agent「作业运行时 assignments 查询」自测。
 *
 * 三层检查：
 *  1. **summarizeAssignments（fake runtime 的 list 快照）**：
 *     - 过滤：派给当前 Bot / 当前 Bot 派出去 / 无关记录；
 *     - 排序：createdAt 倒序；上限 50 条；
 *     - 截断：brief / result 超 300 只留前 300 + 省略号；
 *     - 摘要字段完整、名称映射（roster 命中 / botId 兜底 / 用户 / 例行任务）；
 *     - 空列表 / 空 botId。
 *  2. **HTTP 路由**：fake ctx 下 applyPersonalAgentHost（把 runtime/host.ts 打桩，
 *     不启动真实 runtime）后，GET /assignments 缺 botId → 400、运行时不可用 →
 *     { ok:true, assignments:[] }、GET /health 的 routes 含 assignments。
 *  3. **源码断言**：RuntimeHandle.list / host.ts 注册 list: () => store.all() /
 *     index.ts 路由、health 与摘要实现。
 *
 * 用项目自带 esbuild（与 test-personal-relay.mjs 同一手法）；不依赖 lib/ 构建产物。
 *
 * Usage: node scripts/test-personal-assignments.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-assignments-build-'))
const HOME = mkdtempSync(join(tmpdir(), 'pa-assignments-home-'))
const WORKSPACE = mkdtempSync(join(tmpdir(), 'pa-assignments-ws-'))
process.env.DSH_HOME = HOME
process.env.DSH_SEEKER_BOT_WORKSPACE = WORKSPACE

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 一条形状完整的 Assignment（只填列表/摘要用得到的字段）。 */
function makeAssignment(overrides = {}) {
  return {
    id: 'a-1',
    rootId: 'a-1',
    depth: 0,
    origin: { kind: 'person', source: 'chat' },
    requester: { kind: 'person' },
    assignee: { botId: 'bot-a' },
    mode: 'work',
    reply: 'resume',
    brief: '做一件小事',
    status: 'queued',
    level: 'full',
    levelSource: 'own',
    executions: 0,
    restarts: 0,
    createdAt: 1000,
    lastActivityAt: 1000,
    result: '',
    version: 1,
    ...overrides,
  }
}

try {
  /*
   * runtime/host.ts 打桩：它的 startPersonalRuntime 会创建真实 RuntimeStore 并写
   * 用户目录。路由测试只需要「运行时不可用」这条路径，打桩后 personalRuntime()
   * 保持 undefined，测试不碰真实 ~/.dsh。
   */
  const hostStub = join(OUT, 'runtime-host-stub.mjs')
  writeFileSync(
    hostStub,
    'export function rememberBotSpec() {}\nexport function startPersonalRuntime() { return undefined }\n',
    'utf8',
  )

  await build({
    entryPoints: [join(HERE, 'src/host/personal/index.ts')],
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
    plugins: [{
      name: 'stub-runtime-host',
      setup(build) {
        build.onResolve({ filter: /runtime\/host\.ts$/ }, () => ({ path: hostStub }))
      },
    }],
  })
  const index = await import(pathToFileURL(join(OUT, 'index.mjs')).href)
  const agentSource = readFileSync(join(HERE, 'src/host/personal/index.ts'), 'utf8')
  const registrySource = readFileSync(join(HERE, 'src/host/personal/runtime/registry.ts'), 'utf8')
  const runtimeHostSource = readFileSync(join(HERE, 'src/host/personal/runtime/host.ts'), 'utf8')

  /* ───────────────── summarizeAssignments · 过滤与排序 ───────────────── */

  console.log('\n[summarizeAssignments · 过滤与排序]')
  const ROSTER = [
    { id: 'bot-a', name: '小A' },
    { id: 'bot-b', name: '小B' },
  ]
  const FILTER_ITEMS = [
    makeAssignment({ id: 'assigned-to-a', requester: { kind: 'person' }, assignee: { botId: 'bot-a' }, createdAt: 100 }),
    makeAssignment({ id: 'sent-by-a', requester: { kind: 'bot_turn', botId: 'bot-a' }, assignee: { botId: 'bot-b' }, createdAt: 300 }),
    makeAssignment({ id: 'unrelated', requester: { kind: 'bot_turn', botId: 'bot-c' }, assignee: { botId: 'bot-d' }, createdAt: 200 }),
    makeAssignment({ id: 'done-for-a', requester: { kind: 'person' }, assignee: { botId: 'bot-a' }, createdAt: 400, status: 'completed', outcome: 'done' }),
    makeAssignment({ id: 'old-from-a', requester: { kind: 'bot_turn', botId: 'bot-a' }, assignee: { botId: 'bot-b' }, createdAt: 50, status: 'running' }),
  ]
  const fakeRuntime = { list: () => FILTER_ITEMS }

  check('过滤：派给当前 bot / 当前 bot 派出 / 无关记录剔除', () => {
    const result = index.summarizeAssignments(fakeRuntime.list(), 'bot-a', ROSTER)
    assert.deepEqual(result.map((item) => item.id), ['done-for-a', 'sent-by-a', 'assigned-to-a', 'old-from-a'])
  })

  check('排序：createdAt 倒序', () => {
    const result = index.summarizeAssignments(fakeRuntime.list(), 'bot-a', ROSTER)
    const times = result.map((item) => item.createdAt)
    assert.deepEqual(times, [400, 300, 100, 50])
  })

  check('空列表 / 空 botId / 坏记录 → 空数组或跳过', () => {
    assert.deepEqual(index.summarizeAssignments([], 'bot-a', ROSTER), [])
    assert.deepEqual(index.summarizeAssignments(fakeRuntime.list(), '', ROSTER), [])
    const withBad = [null, 42, { id: 'no-shape' }, ...FILTER_ITEMS]
    assert.deepEqual(
      index.summarizeAssignments(withBad, 'bot-a', ROSTER).map((item) => item.id),
      ['done-for-a', 'sent-by-a', 'assigned-to-a', 'old-from-a'],
    )
  })

  /* ───────────────── summarizeAssignments · 摘要与截断 ───────────────── */

  console.log('\n[summarizeAssignments · 摘要与截断]')
  const LONG_BRIEF = 'b'.repeat(400)
  const LONG_RESULT = 'r'.repeat(500)
  const detailItem = makeAssignment({
    id: 'detail-1',
    rootId: 'root-1',
    parentId: 'parent-1',
    depth: 2,
    requester: { kind: 'bot_turn', botId: 'bot-a' },
    assignee: { botId: 'bot-b' },
    mode: 'consult',
    brief: LONG_BRIEF,
    doneWhen: '完成标准X',
    status: 'running',
    outcome: undefined,
    createdAt: 2000,
    startedAt: 2100,
    lastActivityAt: 2200,
    finishedAt: undefined,
    result: LONG_RESULT,
  })

  check('brief / result 各截 300 字并带省略号', () => {
    const [summary] = index.summarizeAssignments([detailItem], 'bot-a', ROSTER)
    assert.equal(summary.brief.length, 301)
    assert.ok(summary.brief.endsWith('…'))
    assert.equal(summary.result.length, 301)
    assert.ok(summary.result.endsWith('…'))
  })

  check('摘要字段齐全（id / rootId / parentId / depth / 状态 / 时间戳）', () => {
    const [summary] = index.summarizeAssignments([detailItem], 'bot-a', ROSTER)
    assert.equal(summary.id, 'detail-1')
    assert.equal(summary.rootId, 'root-1')
    assert.equal(summary.parentId, 'parent-1')
    assert.equal(summary.depth, 2)
    assert.equal(summary.mode, 'consult')
    assert.equal(summary.doneWhen, '完成标准X')
    assert.equal(summary.status, 'running')
    assert.equal(summary.outcome, null)
    assert.equal(summary.createdAt, 2000)
    assert.equal(summary.startedAt, 2100)
    assert.equal(summary.lastActivityAt, 2200)
    assert.equal(summary.finishedAt, null)
  })

  check('名称映射：roster 命中用 name，未命中回退 botId', () => {
    const [summary] = index.summarizeAssignments([detailItem], 'bot-a', ROSTER)
    assert.equal(summary.requesterBotId, 'bot-a')
    assert.equal(summary.requesterName, '小A')
    assert.equal(summary.assigneeBotId, 'bot-b')
    assert.equal(summary.assigneeName, '小B')
    const [fallback] = index.summarizeAssignments([detailItem], 'bot-a', [])
    assert.equal(fallback.requesterName, 'bot-a')
    assert.equal(fallback.assigneeName, 'bot-b')
  })

  check('人 / 例行任务请求者的显示名', () => {
    const items = [
      makeAssignment({ id: 'person-req', requester: { kind: 'person' }, assignee: { botId: 'bot-a' } }),
      makeAssignment({ id: 'routine-req', requester: { kind: 'routine_run' }, assignee: { botId: 'bot-a' } }),
    ]
    const result = index.summarizeAssignments(items, 'bot-a', [])
    assert.equal(result[0].requesterBotId, null)
    assert.equal(result[0].requesterName, '用户')
    assert.equal(result[1].requesterName, '例行任务')
  })

  check('最多返回最近 50 条', () => {
    const many = Array.from({ length: 60 }, (_, i) => makeAssignment({
      id: `m-${i}`,
      requester: { kind: 'person' },
      assignee: { botId: 'bot-a' },
      createdAt: i + 1,
    }))
    const result = index.summarizeAssignments(many, 'bot-a', [])
    assert.equal(result.length, 50)
    assert.equal(result[0].createdAt, 60)
    assert.equal(result[49].createdAt, 11)
  })

  /* ───────────────── HTTP 路由 ───────────────── */

  console.log('\n[HTTP 路由]')
  const routes = []
  const ctx = {
    inject(_deps, cb) { cb(ctx) },
    effect(fn) { fn(); return () => {} },
    webServer: { register(route) { routes.push(route); return () => {} } },
    get(name) {
      if (name === 'credentials') return ctx.credentials
      if (name === 'llm') return ctx.llm
      if (name === 'settings') return ctx.settings
      return undefined
    },
    credentials: { resolve: async () => ({ value: 'test-key' }) },
    settings: { get() { return {} } },
    llm: {
      listProviders: () => [{ id: 'alymagpie' }],
      listModels: async () => [{ id: 'auto/deepseek-v4.1-flash' }],
      resolveModelInfo: async () => ({}),
      stream: async function* () { yield { type: 'text-delta', text: 'x' } },
    },
    speechController: { transcribe: async () => ({ text: 'x' }) },
  }
  index.applyPersonalAgentHost(ctx)
  const route = routes.find((item) => item.path === '/api/personal-agent')
  assert.ok(route !== undefined, 'personal-agent 路由未注册')

  function request(url, method = 'GET') {
    return new Promise((resolvePromise) => {
      const req = {
        url,
        method,
        headers: {},
        on(event, handler) {
          if (event === 'data') handler(Buffer.from('{}'))
          if (event === 'end') handler()
        },
        destroy() {},
      }
      let status = 0
      const res = {
        set statusCode(value) { status = value },
        get statusCode() { return status },
        setHeader() {},
        end(chunk) {
          const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
          resolvePromise({ status, text: payload.toString('utf8') })
        },
      }
      void route.handler(req, res)
    })
  }

  await checkAsync('GET /assignments 缺 botId → 400', async () => {
    const res = await request('/api/personal-agent/assignments')
    assert.equal(res.status, 400)
    assert.deepEqual(JSON.parse(res.text), { ok: false, error: 'botId required' })
  })

  await checkAsync('GET /assignments 运行时不可用 → 200 + 空列表', async () => {
    const res = await request('/api/personal-agent/assignments?botId=bot-a')
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text), { ok: true, assignments: [] })
  })

  await checkAsync('GET /health routes 含 assignments', async () => {
    const res = await request('/api/personal-agent/health')
    assert.equal(res.status, 200)
    assert.ok(JSON.parse(res.text).routes.includes('assignments'))
  })

  /* ───────────────── 源码接线断言 ───────────────── */

  console.log('\n[源码接线]')

  check('RuntimeHandle 增加 list(): readonly Assignment[]', () => {
    assert.ok(registrySource.includes('list: () => readonly Assignment[]'), 'RuntimeHandle 缺少 list')
  })

  check('host.ts registerRuntime 注册 list: () => store.all()', () => {
    assert.ok(runtimeHostSource.includes('list: () => store.all()'), 'host.ts 未注册 list')
  })

  check('index.ts 有 GET /assignments 路由与摘要实现', () => {
    assert.ok(agentSource.includes("(tail === '/assignments' || tail === '/assignments/') && method === 'GET'"), '缺少 GET /assignments 路由')
    assert.ok(agentSource.includes("error: 'botId required'"), '缺少 botId 必填校验')
    assert.ok(agentSource.includes('summarizeAssignments(personalRuntime()?.list?.() ?? [], botId)'), '路由没调用 summarizeAssignments')
    assert.ok(agentSource.includes('export function summarizeAssignments('), 'summarizeAssignments 未导出')
    assert.ok(agentSource.includes('.slice(0, 50)'), '缺少 50 条上限')
    assert.ok(agentSource.includes('clipAssignmentText(item.brief, 300)'), 'brief 未截 300')
    assert.ok(agentSource.includes('clipAssignmentText(item.result, 300)'), 'result 未截 300')
  })

  check('index.ts health routes 登记 assignments', () => {
    const healthIndex = agentSource.indexOf("tail === '/health'")
    assert.ok(healthIndex >= 0, '找不到 /health 分支')
    const healthBlock = agentSource.slice(healthIndex, healthIndex + 1600)
    assert.ok(healthBlock.includes("'assignments'"), 'health routes 缺少 assignments')
  })

  /* ───────────────── esbuild 冒烟 ───────────────── */

  console.log('\n[esbuild 冒烟]')

  await checkAsync('打包产物导出 summarizeAssignments 且可调用', async () => {
    assert.equal(typeof index.summarizeAssignments, 'function')
    const [summary] = index.summarizeAssignments([detailItem], 'bot-a', ROSTER)
    assert.equal(summary.id, 'detail-1')
    assert.equal(summary.requesterName, '小A')
  })
} finally {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WORKSPACE, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n[personal-assignments] ${failed} 项失败`)
  process.exit(1)
}
console.log(`\n[personal-assignments] PASS（${passed} 项）`)
