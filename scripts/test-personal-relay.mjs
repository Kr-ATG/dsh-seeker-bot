#!/usr/bin/env node
/**
 * Personal Agent「接力摘要」自测。
 *
 * 三层检查：
 *  1. **shared 纯逻辑**：normalizeRelayBrief 的合法 / 缺字段 / 非字符串数组 /
 *     全空→null / 超长截断；buildRelayBlock 的空摘要→'' 与字段顺序；
 *     fallbackRelayBrief 的空输入→null 与「最后 user + 最近 bot」规则；
 *     reconcileRelayBrief 把「下一步 = 已完成」的重复动作剔掉（含换动词重述），
 *     同时不误删专有名词反复出现的合法下一步。
 *  2. **host 行为**：用临时 DSH_HOME 测 relay 文件的 write / read / clear（含
 *     botId 文件名清洗、source / edited 保留）；mock agent.inject 测「内容变化
 *     才注入、相同内容不重复、reset 后重新注入」；mock llm.stream 测模型成功、
 *     模型抛错 / 坏 JSON 的 degraded 兜底、空素材的 ok:false。
 *  3. **源码接线**：index.ts 的 /relay/prepare、/relay/commit、/reset 分支与
 *     每轮注入；scheduler.ts、realtime/mount.ts 的 injectRelayIntoAgent；
 *     journal.ts 的 getLlm / resolveChatModel 导出。
 *
 * 用项目自带 esbuild 把 TS 打成临时 ESM 模块（与 test-personal-recall-host.mjs
 * 同一手法）；不依赖 lib/ 构建产物，任何时刻都能跑。
 *
 * Usage: node scripts/test-personal-relay.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-relay-build-'))
const HOME = mkdtempSync(join(tmpdir(), 'pa-relay-home-'))
process.env.DSH_HOME = HOME

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

try {
  await build({
    entryPoints: {
      'shared-relay': join(HERE, 'src/shared/relay.ts'),
      'host-relay': join(HERE, 'src/host/personal/relay.ts'),
    },
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  })
  const shared = await import(pathToFileURL(join(OUT, 'shared-relay.mjs')).href)
  const host = await import(pathToFileURL(join(OUT, 'host-relay.mjs')).href)

  /* ───────────────── shared · normalizeRelayBrief ───────────────── */

  console.log('\n[shared · normalizeRelayBrief]')
  check('合法输入完整保留', () => {
    const brief = shared.normalizeRelayBrief({
      goal: '完成宿主侧接力摘要',
      done: ['写了 relay.ts'],
      decisions: ['存储路径 personal-agent/relay/<botId>.json'],
      pending: ['跑测试'],
      next: ['通知 Lead'],
      files: ['src/host/personal/relay.ts'],
      updatedAt: 1_700_000_000_000,
    })
    assert.equal(brief.goal, '完成宿主侧接力摘要')
    assert.deepEqual(brief.done, ['写了 relay.ts'])
    assert.deepEqual(brief.decisions, ['存储路径 personal-agent/relay/<botId>.json'])
    assert.deepEqual(brief.pending, ['跑测试'])
    assert.deepEqual(brief.next, ['通知 Lead'])
    assert.deepEqual(brief.files, ['src/host/personal/relay.ts'])
    assert.equal(brief.updatedAt, 1_700_000_000_000)
  })
  check('缺字段 → 空数组 + 当前时间', () => {
    const brief = shared.normalizeRelayBrief({ goal: '只有目标' }, 12_345)
    assert.equal(brief.goal, '只有目标')
    assert.deepEqual(brief.done, [])
    assert.deepEqual(brief.decisions, [])
    assert.deepEqual(brief.pending, [])
    assert.deepEqual(brief.next, [])
    assert.deepEqual(brief.files, [])
    assert.equal(brief.updatedAt, 12_345)
  })
  check('非字符串 / 空串 / 重复项被丢弃', () => {
    const brief = shared.normalizeRelayBrief({ done: ['a', 42, ' a ', 'a', '', null, 'b', { x: 1 }] })
    assert.deepEqual(brief.done, ['a', 'b'])
  })
  check('全空 / 非对象 → null', () => {
    assert.equal(shared.normalizeRelayBrief({}), null)
    assert.equal(shared.normalizeRelayBrief({ goal: '', done: [], decisions: [], pending: [], next: [], files: [] }), null)
    assert.equal(shared.normalizeRelayBrief(null), null)
    assert.equal(shared.normalizeRelayBrief(undefined), null)
    assert.equal(shared.normalizeRelayBrief([]), null)
    assert.equal(shared.normalizeRelayBrief('not object'), null)
  })
  check('超长截断（goal / 单条 / 条数）', () => {
    const longGoal = 'g'.repeat(500)
    const longItem = 'i'.repeat(500)
    const brief = shared.normalizeRelayBrief({
      goal: longGoal,
      done: Array.from({ length: 20 }, (_, index) => `${index}-${longItem}`),
    })
    assert.ok(brief.goal.length <= shared.RELAY_GOAL_MAX_CHARS + 1, `goal 长度 ${brief.goal.length}`)
    assert.ok(brief.goal.endsWith('…'))
    assert.equal(brief.done.length, shared.RELAY_MAX_ITEMS)
    assert.ok(brief.done[0].length <= shared.RELAY_ITEM_MAX_CHARS + 1, `条目长度 ${brief.done[0].length}`)
  })

  /* ───────────────── shared · buildRelayBlock ───────────────── */

  console.log('\n[shared · buildRelayBlock]')
  check('空摘要 → 空串', () => {
    assert.equal(shared.buildRelayBlock(null), '')
    assert.equal(shared.buildRelayBlock(undefined), '')
    assert.equal(shared.buildRelayBlock({
      goal: '', done: [], decisions: [], pending: [], next: [], files: [], updatedAt: 1,
    }), '')
  })
  check('字段顺序固定且内容齐全', () => {
    const block = shared.buildRelayBlock({
      goal: '目标A',
      done: ['完成1'],
      decisions: ['决定1'],
      pending: ['待办1'],
      next: ['下一步1'],
      files: ['a.ts'],
      updatedAt: 1,
    })
    assert.ok(block.startsWith('【接力摘要 · 上一段对话】'))
    const order = ['目标：', '已完成：', '关键决策/约束：', '未完成：', '下一步：', '相关文件：']
    let last = -1
    for (const label of order) {
      const index = block.indexOf(label)
      assert.ok(index > last, `${label} 顺序不对（${index} <= ${last}）`)
      last = index
    }
    for (const text of ['目标A', '完成1', '决定1', '待办1', '下一步1', 'a.ts']) {
      assert.ok(block.includes(text), `缺少 ${text}`)
    }
  })

  check('注入块带「不要重做」硬约束与「延续」声明', () => {
    const block = shared.buildRelayBlock({
      goal: '盯梢 Mimi',
      done: ['基线检查已完成'],
      decisions: [],
      pending: ['等待项目出现实质动静'],
      next: [],
      files: [],
      updatedAt: 1,
    })
    assert.ok(block.includes('同一项工作的延续，不是新任务'), '有未完成事项时应声明是同一项工作的延续')
    assert.ok(block.includes('不要重做'), '缺少「不要重做」硬约束')
    assert.ok(block.includes('不要重新验证'), '缺少「不要重新验证」硬约束')
    assert.ok(block.includes('增量对比'), '缺少「只做增量对比」约束')
    // 没有未完成事项时不该声称「延续」：那是一次已经收尾的对话
    const finished = shared.buildRelayBlock({
      goal: '收尾', done: ['跑完测试'], decisions: [], pending: [], next: [], files: [], updatedAt: 1,
    })
    assert.ok(!finished.includes('同一项工作的延续'), '没有 pending 时不应声明延续')
  })

  /* ───────────────── shared · reconcileRelayBrief ───────────────── */

  console.log('\n[shared · reconcileRelayBrief]')
  check('「下一步」里已经做完的动作被剔除', () => {
    const brief = shared.reconcileRelayBrief(shared.normalizeRelayBrief({
      goal: '盯梢 Mimi 直到有动静',
      done: ['已把持续盯梢任务完整派给子Bot小秘，并明确长期节奏'],
      decisions: ['发现新仓库 / 代码 / 官网上线才算有动静'],
      pending: ['等待项目出现实质进展'],
      next: ['子Bot小秘执行基线检查并持续盯梢', '一旦 Mimi 有实质动静就汇报给用户'],
    }))
    assert.deepEqual(brief.next, ['一旦 Mimi 有实质动静就汇报给用户'])
  })
  check('换动词重述的同一动作也能识别', () => {
    assert.equal(shared.isAlreadyDoneStep('执行基线检查', ['已完成基线检查']), true)
  })
  check('专有名词反复出现不算同一件事（不误删合法下一步）', () => {
    const done = ['确认项目名为秘秘（Mimi），作者组织为 Mimi-personal-agent']
    assert.equal(shared.isAlreadyDoneStep('一旦 Mimi 有实质动静，第一时间汇报给用户', done), false)
  })
  check('next / done 任一为空时原样返回', () => {
    const noDone = { goal: 'x', done: [], decisions: [], pending: [], next: ['做事'], files: [], updatedAt: 1 }
    assert.equal(shared.reconcileRelayBrief(noDone), noDone)
    const noNext = { goal: 'x', done: ['做完了'], decisions: [], pending: [], next: [], files: [], updatedAt: 1 }
    assert.equal(shared.reconcileRelayBrief(noNext), noNext)
  })

  /* ───────────────── shared · fallbackRelayBrief ───────────────── */

  console.log('\n[shared · fallbackRelayBrief]')
  check('空消息 → null', () => {
    assert.equal(shared.fallbackRelayBrief([]), null)
    assert.equal(shared.fallbackRelayBrief([{ role: 'user', text: '   ' }]), null)
  })
  check('取最后 user + 最近 bot', () => {
    const brief = shared.fallbackRelayBrief([
      { role: 'user', text: '第一问', at: 1000 },
      { role: 'bot', text: '回复一', at: 2000 },
      { role: 'user', text: '最后的问题', at: 3000 },
      { role: 'bot', text: '最近的回复', at: 4000 },
    ], 999)
    assert.ok(brief.goal.includes('最后的问题'))
    assert.deepEqual(brief.done, ['最近的回复', '回复一'])
    assert.equal(brief.updatedAt, 999)
  })

  /* ───────────────── host · 存储读写 ───────────────── */

  console.log('\n[host · relay 文件读写]')
  const sample = {
    goal: '接力目标',
    done: ['a'],
    decisions: ['b'],
    pending: ['c'],
    next: ['d'],
    files: ['e.ts'],
    updatedAt: 111,
    source: { messages: 2, from: 100, to: 200 },
    edited: true,
  }
  await checkAsync('write / read：DSH_HOME 隔离、source / edited 保留', async () => {
    await host.writeRelayBrief('bot-a', sample)
    const file = host.relayFile('bot-a')
    assert.equal(file, join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'relay', 'bot-a.json'))
    assert.ok(existsSync(file), `文件不存在：${file}`)
    const read = await host.readRelayBrief('bot-a')
    assert.equal(read.goal, '接力目标')
    assert.deepEqual(read.done, ['a'])
    assert.equal(read.updatedAt, 111)
    assert.deepEqual(read.source, { messages: 2, from: 100, to: 200 })
    assert.equal(read.edited, true)
  })
  await checkAsync('botId 文件名清洗（不允许路径穿越）', async () => {
    const file = host.relayFile('../evil/../bot id')
    const dir = join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'relay')
    assert.ok(file.startsWith(dir), `文件跑出 relay 目录：${file}`)
    assert.ok(!file.includes('..'), `文件名未清洗：${file}`)
  })
  await checkAsync('读取旧摘要时清掉「下一步 = 已完成」的重复项', async () => {
    // 模拟提示词修复之前落盘的文件：done 里写完了基线检查，next 里又写了一遍
    writeFileSync(host.relayFile('bot-legacy'), JSON.stringify({
      goal: '旧摘要',
      done: ['已完成基线检查'],
      decisions: [],
      pending: [],
      next: ['执行基线检查', '等子 Bot 回报'],
      files: [],
      updatedAt: 5,
    }), 'utf8')
    const read = await host.readRelayBrief('bot-legacy')
    assert.deepEqual(read.next, ['等子 Bot 回报'], '读旧文件也应剔掉重复的下一步')
    await host.clearRelayBrief('bot-legacy')
  })
  await checkAsync('clear 后读回 null、文件消失', async () => {
    await host.clearRelayBrief('bot-a')
    assert.equal(await host.readRelayBrief('bot-a'), null)
    assert.equal(existsSync(host.relayFile('bot-a')), false)
    // 再清一次不应抛（force: true）
    await host.clearRelayBrief('bot-a')
  })

  /* ───────────────── host · 注入去重 ───────────────── */

  console.log('\n[host · injectRelayIntoAgent 去重]')
  await checkAsync('内容变化才注入、相同内容不重复', async () => {
    const injected = []
    const agent = { session: { id: 'sess-1' }, inject(message) { injected.push(message) } }
    const base = { goal: '第一版', done: [], decisions: [], pending: [], next: [], files: [], updatedAt: 1 }
    await host.writeRelayBrief('bot-inject', base)
    assert.equal(await host.injectRelayIntoAgent(agent, 'bot-inject'), true)
    assert.equal(injected.length, 1)
    // v4 会话把注入消息统一落成 user/message，role 必须是 user（见 agent.ts 注释）
    assert.equal(injected[0].role, 'user')
    assert.equal(injected[0].source.kind, 'plugin:dsh-seeker-bot')
    assert.ok(injected[0].content[0].text.includes('第一版'))
    assert.equal(await host.injectRelayIntoAgent(agent, 'bot-inject'), false)
    assert.equal(injected.length, 1)
    await host.writeRelayBrief('bot-inject', { ...base, goal: '第二版' })
    assert.equal(await host.injectRelayIntoAgent(agent, 'bot-inject'), true)
    assert.equal(injected.length, 2)
    assert.ok(injected[1].content[0].text.includes('第二版'))
  })
  await checkAsync('resetRelayInjection 后相同内容重新注入', async () => {
    const injected = []
    // 真实会话 id 形状是 pa-bot-v2-<botId>，reset 传 botId 时靠 includes 命中
    const agent = { session: { id: 'pa-bot-v2-bot-reset' }, inject(message) { injected.push(message) } }
    const brief = { goal: '重置测试', done: [], decisions: [], pending: [], next: [], files: [], updatedAt: 2 }
    await host.writeRelayBrief('bot-reset', brief)
    assert.equal(await host.injectRelayIntoAgent(agent, 'bot-reset'), true)
    assert.equal(await host.injectRelayIntoAgent(agent, 'bot-reset'), false)
    host.resetRelayInjection('pa-bot-v2-bot-reset')
    assert.equal(await host.injectRelayIntoAgent(agent, 'bot-reset'), true)
    // 传 botId 也要能命中（/reset 与 /relay/commit 只有 botId）
    host.resetRelayInjection('bot-reset')
    assert.equal(await host.injectRelayIntoAgent(agent, 'bot-reset'), true)
  })
  await checkAsync('没有摘要 / agent 不支持 inject → false', async () => {
    assert.equal(await host.injectRelayIntoAgent({ session: { id: 'sess-x' } }, 'bot-none'), false)
    assert.equal(await host.injectRelayIntoAgent(null, 'bot-none'), false)
    await host.writeRelayBrief('bot-none', { goal: '有摘要', done: [], decisions: [], pending: [], next: [], files: [], updatedAt: 3 })
    assert.equal(await host.injectRelayIntoAgent({ session: { id: 'sess-x' } }, 'bot-none'), false)
    await host.clearRelayBrief('bot-none')
  })

  /* ───────────────── host · 模型生成与降级 ───────────────── */

  console.log('\n[host · generateRelayBrief]')
  const MESSAGES = [
    { role: 'user', text: '把接力摘要做出来，存到 personal-agent/relay 下面。', at: 1000 },
    { role: 'bot', text: '已完成 relay.ts 的存储与注入。', at: 2000 },
  ]
  await checkAsync('模型成功路径：brief + model + degraded:false', async () => {
    let lastOptions = null
    const llm = {
      stream: async function* (options) {
        lastOptions = options
        yield { type: 'text-delta', text: '{"goal":"做接力摘要","done":["写完 relay.ts"],' }
        yield { type: 'text-delta', text: '"decisions":["路径 personal-agent/relay"],"pending":[],"next":[],"files":["src/host/personal/relay.ts"]}' }
      },
    }
    const ctx = { get(name) { return name === 'llm' ? llm : undefined } }
    const result = await host.generateRelayBrief(ctx, {
      botModel: { provider: 'test', model: 'm1' },
      messages: MESSAGES,
    })
    assert.equal(result.ok, true)
    assert.equal(result.degraded, false)
    assert.equal(result.model, 'test/m1')
    assert.equal(result.brief.goal, '做接力摘要')
    assert.deepEqual(result.brief.files, ['src/host/personal/relay.ts'])
    assert.equal(lastOptions.system, host.relaySystemPrompt())
    assert.ok(lastOptions.messages[0].content[0].text.includes('接力摘要'))
  })
  await checkAsync('模型抛错 → fallback + degraded:true + 可读原因', async () => {
    const llm = { stream: async function* () { throw new Error('网关 502') } }
    const ctx = { get(name) { return name === 'llm' ? llm : undefined } }
    const result = await host.generateRelayBrief(ctx, {
      botModel: { provider: 'test', model: 'm1' },
      messages: MESSAGES,
    })
    assert.equal(result.ok, true)
    assert.equal(result.degraded, true)
    assert.ok(result.error.includes('网关 502'))
    assert.ok(result.brief.goal.includes('接力摘要'))
  })
  await checkAsync('模型返回坏 JSON → fallback + degraded:true', async () => {
    const llm = {
      stream: async function* () {
        yield { type: 'text-delta', text: '抱歉，我不能输出 JSON。' }
      },
    }
    const ctx = { get(name) { return name === 'llm' ? llm : undefined } }
    const result = await host.generateRelayBrief(ctx, {
      botModel: { provider: 'test', model: 'm1' },
      messages: MESSAGES,
    })
    assert.equal(result.ok, true)
    assert.equal(result.degraded, true)
    assert.ok(result.error.includes('JSON'))
  })
  await checkAsync('没有可用 llm → fallback 兜底', async () => {
    const result = await host.generateRelayBrief({ get() { return undefined } }, { messages: MESSAGES })
    assert.equal(result.ok, true)
    assert.equal(result.degraded, true)
    assert.ok(result.error.includes('llm'))
  })
  await checkAsync('模型把已完成的动作写进 next → 生成时被清掉', async () => {
    const llm = {
      stream: async function* () {
        yield {
          type: 'text-delta',
          text: '{"goal":"继续盯梢","done":["已把持续盯梢任务派给子Bot小秘"],"decisions":[],'
            + '"pending":["等待动静"],"next":["子Bot小秘执行基线检查并持续盯梢","等子Bot回报后汇报给用户"],"files":[]}',
        }
      },
    }
    const ctx = { get(name) { return name === 'llm' ? llm : undefined } }
    const result = await host.generateRelayBrief(ctx, {
      botModel: { provider: 'test', model: 'm1' },
      messages: MESSAGES,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.brief.next, ['等子Bot回报后汇报给用户'], '重复的 next 应在生成结果里就消失')
  })
  await checkAsync('messages 为空 → ok:false', async () => {
    const result = await host.generateRelayBrief({ get() { return undefined } }, { messages: [] })
    assert.equal(result.ok, false)
    assert.equal(result.error, '没有可整理的对话')
  })

  /* ───────────────── 源码接线断言 ───────────────── */

  console.log('\n[源码接线]')
  const indexSource = readFileSync(join(HERE, 'src/host/personal/index.ts'), 'utf8')
  const schedulerSource = readFileSync(join(HERE, 'src/host/personal/scheduler.ts'), 'utf8')
  const mountSource = readFileSync(join(HERE, 'src/host/personal/realtime/mount.ts'), 'utf8')
  const journalSource = readFileSync(join(HERE, 'src/host/personal/journal.ts'), 'utf8')

  check('index.ts 有 GET/POST/DELETE relay 端点', () => {
    assert.ok(indexSource.includes("(tail === '/relay' || tail === '/relay/') && method === 'GET'"), '缺少 GET /relay')
    assert.ok(indexSource.includes("(tail === '/relay/prepare' || tail === '/relay/prepare/') && method === 'POST'"), '缺少 POST /relay/prepare')
    assert.ok(indexSource.includes("(tail === '/relay/commit' || tail === '/relay/commit/') && method === 'POST'"), '缺少 POST /relay/commit')
    assert.ok(indexSource.includes("(tail === '/relay' || tail === '/relay/') && method === 'DELETE'"), '缺少 DELETE /relay')
  })
  check('index.ts 导入并调用 relay 全套能力', () => {
    assert.ok(indexSource.includes("from './relay.ts'"), '没有 import ./relay.ts')
    assert.ok(indexSource.includes('readRelayBrief(botId)'), 'GET /relay 没读摘要')
    assert.ok(indexSource.includes('await generateRelayBrief(webCtx'), 'prepare 没调生成')
    assert.ok(indexSource.includes('await writeRelayBrief(botId, brief)'), 'commit 没落盘')
    assert.ok(indexSource.includes('await clearRelayBrief(botId)'), 'DELETE 没清文件')
  })
  check('index.ts /reset 分支调用 resetRelayInjection', () => {
    const resetIndex = indexSource.indexOf("tail === '/reset'")
    assert.ok(resetIndex >= 0, '找不到 /reset 分支')
    const block = indexSource.slice(resetIndex, resetIndex + 1400)
    assert.ok(block.includes('resetRelayInjection(botId)'), '/reset 分支缺少 resetRelayInjection')
  })
  check('index.ts 每轮注入 await injectRelayIntoAgent', () => {
    assert.ok(indexSource.includes('await injectRelayIntoAgent(agent, spec.botId)'), '缺少每轮注入')
  })
  check('scheduler.ts 注入 relay', () => {
    assert.ok(schedulerSource.includes("from './relay.ts'"), 'scheduler 没有 import relay')
    assert.ok(schedulerSource.includes('await injectRelayIntoAgent(agent, spec.botId)'), 'scheduler 缺少注入调用')
  })
  check('realtime/mount.ts 注入 relay', () => {
    assert.ok(mountSource.includes("from '../relay.ts'"), 'mount 没有 import relay')
    assert.ok(mountSource.includes('await injectRelayIntoAgent(liveAgent, spec.botId)'), 'mount 缺少注入调用')
  })
  check('journal.ts 导出 getLlm / resolveChatModel', () => {
    assert.ok(journalSource.includes('export function getLlm('), 'getLlm 未导出')
    assert.ok(journalSource.includes('export async function resolveChatModel('), 'resolveChatModel 未导出')
  })
} finally {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n[personal-relay] ${failed} 项失败`)
  process.exit(1)
}
console.log(`\n[personal-relay] PASS（${passed} 项）`)
