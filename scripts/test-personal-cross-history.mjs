#!/usr/bin/env node
/**
 * Personal Agent「跨 Bot 历史检索」自测（第 4 步）。
 *
 * 覆盖：
 *  1. **跨 Bot 聚合**：临时 DSH_HOME 写 created-bots.json（两个子 Bot）+ 两个 Bot
 *     的 history 文件；searchAcrossBots 聚合各 Bot 命中、botName/role 正确、
 *     摘要 ≤200 字、排除 fromBotId、无子 Bot / 无结果返回空。
 *  2. **触发词与注入**：shouldSearchAcrossBots 全部触发词（含无空格变体）；
 *     非主 Bot 不注入、主 Bot 命中注入、无结果不注入、相同内容去重、reset 后重注。
 *  3. **IDF / rerank / 多样性**：构造「高频常见词」与「低频精确词」的对照数据，
 *     断言 IDF 加权后精确词排前；完整短语命中排前；同 Bot 重复内容只留一条。
 *  4. **源码接线**：index.ts 的 /history/cross-search 路由、health 登记与注入调用。
 *
 * 用项目自带 esbuild 把 TS 打成临时 ESM 模块（与其它 personal 测试同一手法）；
 * 不依赖 lib/ 构建产物。
 *
 * Usage: node scripts/test-personal-cross-history.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-cross-build-'))
const HOME = mkdtempSync(join(tmpdir(), 'pa-cross-home-'))
process.env.DSH_HOME = HOME

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') throw new Error('异步用例请使用 checkAsync')
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (error instanceof Error ? error.message : String(error)))
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (error instanceof Error ? error.message : String(error)))
  }
}

try {
  await build({
    entryPoints: {
      cross: join(HERE, 'src/host/personal/cross-search.ts'),
      history: join(HERE, 'src/host/personal/history-search.ts'),
    },
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  })
  const cross = await import(pathToFileURL(join(OUT, 'cross.mjs')).href)
  const history = await import(pathToFileURL(join(OUT, 'history.mjs')).href)

  const now = Date.now()
  const DAY = 86_400_000
  const dataDir = join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent')
  const createdBotsFile = join(dataDir, 'created-bots.json')

  /** 写 created-bots.json 并清掉 bot-create 的内存缓存（否则读到旧账本）。 */
  function writeCreatedBots(records) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(createdBotsFile, JSON.stringify(records, null, 2), 'utf8')
    cross.crossSearchTest.resetCreatedBotsCache()
  }
  function botRecord(id, name, role) {
    return { id, name, role, description: '', instructions: '', createdAt: 1, createdBy: 'bot-main' }
  }

  /* ───────────────── 无子 Bot ───────────────── */

  console.log('\n[跨 Bot 聚合]')

  await checkAsync('无子 Bot 时返回空数组', async () => {
    rmSync(createdBotsFile, { force: true })
    cross.crossSearchTest.resetCreatedBotsCache()
    const result = await cross.searchAcrossBots('bot-main', '团队进展')
    assert.equal(result.ok, true)
    assert.equal(result.total, 0)
    assert.deepEqual(result.bots, [])
  })

  // 两个子 Bot + 两个 Bot 的历史
  writeCreatedBots([
    botRecord('bot-alpha', '调研助手', '竞品调研'),
    botRecord('bot-beta', '写作助手', '内容创作'),
  ])
  await history.upsertHistoryMessages('bot-alpha', [
    { id: 'a1', role: 'user', text: '团队里讨论过竞品方案：先用访谈验证需求。', at: now - 2 * DAY },
    { id: 'a2', role: 'bot', text: '竞品调研结论：A 产品定价偏高，B 产品功能更全。', at: now - 2 * DAY + 1000 },
    { id: 'a3', role: 'user', text: 'ALPHA_LONG ' + '长'.repeat(500) + ' 这是很长的一条摘要测试。', at: now - 3 * DAY },
    { id: 'a4', role: 'user', text: '完全无关的天气记录。', at: now - 4 * DAY },
  ])
  await history.upsertHistoryMessages('bot-beta', [
    { id: 'b1', role: 'user', text: '团队讨论过写作规范：标题要短，先给结论。', at: now - 5 * DAY },
    { id: 'b2', role: 'bot', text: '写作助手已完成三篇稿子，等待审阅。', at: now - 5 * DAY + 1000 },
    { id: 'b3', role: 'user', text: '团队讨论记录二：标题风格要统一。', at: now - 6 * DAY },
    { id: 'b4', role: 'user', text: '团队讨论记录三：正文用短句。', at: now - 7 * DAY },
    { id: 'b5', role: 'user', text: '团队讨论记录四：结尾加行动项。', at: now - 8 * DAY },
  ])

  await checkAsync('两个子 Bot 的命中都聚合，botName/role 正确', async () => {
    const result = await cross.searchAcrossBots('bot-main', '团队讨论')
    assert.equal(result.ok, true)
    assert.equal(result.bots.length, 2)
    const names = result.bots.map((section) => section.botName)
    assert.deepEqual(names, ['调研助手', '写作助手'])
    assert.equal(result.bots[0].role, '竞品调研')
    assert.equal(result.bots[1].role, '内容创作')
    assert.equal(result.total, result.bots.reduce((sum, section) => sum + section.hits.length, 0))
    assert.ok(result.total >= 2)
    const alphaHit = result.bots[0].hits[0]
    assert.equal(alphaHit.role, 'user')
    assert.ok(alphaHit.text.includes('团队'))
  })

  await checkAsync('摘要 ≤200 字（不返回全文）', async () => {
    const result = await cross.searchAcrossBots('bot-main', 'ALPHA_LONG')
    assert.equal(result.bots.length, 1)
    const hit = result.bots[0].hits[0]
    assert.equal(hit.text.length, 200)
    assert.ok(!hit.text.includes('长'.repeat(201)))
  })

  await checkAsync('排除 fromBotId 自己', async () => {
    const result = await cross.searchAcrossBots('bot-alpha', '团队讨论')
    assert.equal(result.bots.length, 1)
    assert.equal(result.bots[0].botId, 'bot-beta')
    assert.ok(result.bots.every((section) => section.botId !== 'bot-alpha'))
  })

  await checkAsync('无结果返回空数组', async () => {
    const result = await cross.searchAcrossBots('bot-main', '量子火箭zx')
    assert.equal(result.ok, true)
    assert.equal(result.total, 0)
    assert.deepEqual(result.bots, [])
  })

  await checkAsync('limitPerBot 限制每个 Bot 的返回条数', async () => {
    const result = await cross.searchAcrossBots('bot-main', '团队讨论', 1)
    assert.equal(result.bots.length, 2)
    for (const section of result.bots) {
      assert.equal(section.hits.length, 1, section.botId + ' 应只返回 1 条')
    }
  })

  /* ───────────────── 触发词 ───────────────── */

  console.log('\n[触发词 · shouldSearchAcrossBots]')

  check('全部触发词命中（含无空格变体）', () => {
    const triggers = ['子 Bot', '其他 Bot', '别的 Bot', '团队', '所有 Bot', '分身', '大家', '各自']
    for (const trigger of triggers) {
      assert.equal(cross.shouldSearchAcrossBots('请问' + trigger + '的情况'), true, '触发词未命中：' + trigger)
    }
    assert.equal(cross.shouldSearchAcrossBots('子Bot们怎么看'), true)
    assert.equal(cross.shouldSearchAcrossBots('其他Bot有进展吗'), true)
    assert.equal(cross.shouldSearchAcrossBots('所有Bot的总结'), true)
  })

  check('普通文本 / 空文本不触发', () => {
    assert.equal(cross.shouldSearchAcrossBots('今天天气怎么样'), false)
    assert.equal(cross.shouldSearchAcrossBots(''), false)
    assert.equal(cross.shouldSearchAcrossBots(undefined), false)
  })

  /* ───────────────── 注入 ───────────────── */

  console.log('\n[注入 · injectCrossBotHistoryIntoAgent]')

  await checkAsync('非主 Bot 即使命中触发词也不注入', async () => {
    const calls = []
    const agent = { session: { id: 'pa-bot-v2-bot-alpha' }, inject(message) { calls.push(message) } }
    const injected = await cross.injectCrossBotHistoryIntoAgent(agent, { botId: 'bot-alpha', isMain: false }, '其他 Bot 讨论过什么')
    assert.equal(injected, false)
    assert.equal(calls.length, 0)
  })

  await checkAsync('主 Bot 命中触发词且检索到结果时注入 developer 摘要', async () => {
    const calls = []
    const agent = { session: { id: 'pa-bot-v2-bot-main' }, inject(message) { calls.push(message) } }
    const injected = await cross.injectCrossBotHistoryIntoAgent(agent, { botId: 'bot-main', isMain: true }, '其他 Bot 的历史里讨论过什么')
    assert.equal(injected, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].role, 'developer')
    assert.ok(calls[0].content[0].text.includes('【跨 Bot 历史检索 · 仅摘要】'))
    assert.ok(calls[0].content[0].text.includes('来自其他 Bot 的历史摘要，仅供线索'))
    assert.ok(Object.isFrozen(calls[0]))
  })

  await checkAsync('无结果不注入', async () => {
    const calls = []
    const agent = { session: { id: 'pa-bot-v2-bot-main-empty' }, inject(message) { calls.push(message) } }
    const injected = await cross.injectCrossBotHistoryIntoAgent(agent, { botId: 'bot-main', isMain: true }, '其他 Bot 的量子火箭zx')
    assert.equal(injected, false)
    assert.equal(calls.length, 0)
  })

  await checkAsync('相同内容不重复注入；reset 后可重注', async () => {
    const calls = []
    const sessionId = 'pa-bot-v2-bot-main-dedupe'
    const agent = { session: { id: sessionId }, inject(message) { calls.push(message) } }
    const text = '团队各自讨论过什么'
    const first = await cross.injectCrossBotHistoryIntoAgent(agent, { botId: 'bot-main', isMain: true }, text)
    assert.equal(first, true)
    const again = await cross.injectCrossBotHistoryIntoAgent(agent, { botId: 'bot-main', isMain: true }, text)
    assert.equal(again, false, '相同内容不应重复注入')
    assert.equal(calls.length, 1)
    cross.resetCrossBotHistoryInjection(sessionId)
    const afterReset = await cross.injectCrossBotHistoryIntoAgent(agent, { botId: 'bot-main', isMain: true }, text)
    assert.equal(afterReset, true, 'reset 后应允许重新注入')
    assert.equal(calls.length, 2)
  })

  await checkAsync('agent 不支持 inject 不抛错', async () => {
    assert.equal(await cross.injectCrossBotHistoryIntoAgent({}, { botId: 'bot-main', isMain: true }, '团队进展'), false)
    assert.equal(await cross.injectCrossBotHistoryIntoAgent(null, { botId: 'bot-main', isMain: true }, '团队进展'), false)
  })

  /* ───────────────── buildCrossBotBlock ───────────────── */

  console.log('\n[注入文本 · buildCrossBotBlock]')

  check('每 Bot ≤2 条、≤200 字、只列有命中的 Bot、带来源提示', () => {
    const block = cross.buildCrossBotBlock([
      {
        botId: 'x',
        botName: '助手X',
        role: '测试',
        hits: [
          { score: 1, role: 'user', text: 'a'.repeat(300), at: now },
          { score: 0.9, role: 'bot', text: '第二条', at: now },
          { score: 0.8, role: 'user', text: '第三条不该出现', at: now },
        ],
      },
      { botId: 'y', botName: '助手Y', role: '另一个', hits: [] },
    ])
    assert.ok(block.startsWith('【跨 Bot 历史检索 · 仅摘要】'))
    assert.ok(block.includes('## 助手X（测试）'))
    assert.ok(!block.includes('## 助手Y'))
    assert.ok(!block.includes('第三条不该出现'))
    assert.ok(block.includes('a'.repeat(200)))
    assert.ok(!block.includes('a'.repeat(201)))
    assert.ok(block.includes('来自其他 Bot 的历史摘要，仅供线索'))
    assert.equal(cross.buildCrossBotBlock([]), '')
  })

  /* ───────────────── IDF / rerank / 多样性 ───────────────── */

  console.log('\n[IDF / rerank / 多样性]')

  await checkAsync('IDF：高频常见词不压过低频精确词', async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({
      id: 'f' + index,
      role: 'user',
      text: '方案更新：第' + index + '版方案说明。',
      at: now - 175 * DAY - index * 1000,
    }))
    await history.upsertHistoryMessages('bot-idf', [
      ...filler,
      { id: 'idf-a', role: 'user', text: '方案方案方案', at: now },
      { id: 'idf-b', role: 'user', text: '存储', at: now - 170 * DAY },
    ])
    const result = await history.searchHistory('bot-idf', '方案 存储', 5)
    assert.equal(result.results[0].id, 'idf-b', '低频的「存储」应排在高频的「方案」前面')
    const a = result.results.find((item) => item.id === 'idf-a')
    const b = result.results.find((item) => item.id === 'idf-b')
    assert.ok(a !== undefined && b !== undefined)
    assert.ok(b.score > a.score, 'IDF 加权后 idf-b 分数应更高')
  })

  await checkAsync('rerank：完整短语命中排前', async () => {
    await history.upsertHistoryMessages('bot-ranker', [
      { id: 'exact', role: 'user', text: '量子纠缠方案', at: now - 100 * DAY },
      { id: 'partial', role: 'user', text: '量子纠缠和方案讨论', at: now },
    ])
    const result = await history.searchHistory('bot-ranker', '量子纠缠方案', 5)
    assert.equal(result.results[0].id, 'exact', '完整短语应排在更零散的命中前面')
  })

  await checkAsync('多样性：同 Bot 内重复内容只留一条', async () => {
    await history.upsertHistoryMessages('bot-diversity', [
      { id: 'dup1', role: 'user', text: '进度播报：任务已经完成百分之九十，正在做最后检查。', at: now - DAY },
      { id: 'dup2', role: 'bot', text: '进度播报：任务已经完成百分之九十，正在做最后检查。', at: now },
    ])
    const result = await history.searchHistory('bot-diversity', '进度播报', 5)
    assert.equal(result.results.length, 1, '重复内容应只保留一条')
    assert.equal(result.results[0].id, 'dup2', '应保留更新（分数更高）的那条')
  })

  /* ───────────────── 源码接线 ───────────────── */

  console.log('\n[源码接线]')

  check('index.ts 注册跨 Bot 路由、health 与注入调用', () => {
    const source = readFileSync(join(HERE, 'src/host/personal/index.ts'), 'utf8')
    assert.ok(source.includes("from './cross-search.ts'"), 'index.ts 应导入 cross-search')
    assert.ok(source.includes("tail === '/history/cross-search'"), '缺少 GET /history/cross-search 路由')
    assert.ok(source.includes("'history/index', 'history/search', 'history/cross-search'"), 'health 应登记跨 Bot 路由')
    assert.ok(source.includes('await injectCrossBotHistoryIntoAgent(agent, spec, userText)'), 'injectWorkingMemoryForReply 应调用跨 Bot 注入')
  })

  check('cross-search.ts 只返回摘要并标注来源', () => {
    const source = readFileSync(join(HERE, 'src/host/personal/cross-search.ts'), 'utf8')
    assert.ok(source.includes('CROSS_HIT_MAX = 200'))
    assert.ok(source.includes('slice(0, CROSS_HIT_MAX)'))
    assert.ok(source.includes('来自其他 Bot 的历史摘要，仅供线索'))
    assert.ok(source.includes('readCreatedBots()'))
  })

  check('history-search.ts 含 IDF 与 Jaccard 实现', () => {
    const source = readFileSync(join(HERE, 'src/host/personal/history-search.ts'), 'utf8')
    assert.ok(source.includes('Math.log((total + 1) / (df + 1)) + 1'), '缺少 IDF 权重公式')
    assert.ok(source.includes('jaccardSimilarity'), '缺少 Jaccard 去重')
    assert.ok(source.includes('RERANK_POOL'))
  })

  /* ───────────────── 汇总 ───────────────── */

  console.log('\n' + '─'.repeat(48))
  console.log('通过 ' + passed + '，失败 ' + failed)
  if (failed > 0) process.exitCode = 1
} finally {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}
