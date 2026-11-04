#!/usr/bin/env node
/**
 * Personal Agent「历史会话检索」自测。
 *
 * 覆盖三层：
 *  1. **存储**：临时 DSH_HOME 下的 history/<botId>.json —— upsert 按 id 去重、
 *     同 id 新内容覆盖、文本截 1000 字、上限 2000 条保留最新、按 botId 隔离、
 *     坏文件不抛错。
 *  2. **检索**：中文 2-gram / 英文小写 token；中文查询命中、英文查询命中、
 *     无结果、limit 收敛、时间衰减（新消息分数更高）、2000 条检索 < 500ms。
 *  3. **注入与接线**：shouldSearchHistory 触发词表；injectHistoryIntoAgent 的
 *     命中注入 / 无触发不注入 / 相同内容不重复 / reset 后重注 / agent 不支持
 *     inject 不抛错；以及 index.ts 的路由与两个调用点源码断言。
 *
 * 用项目自带 esbuild 把 TS 打成临时 ESM 模块（与 test-personal-relay.mjs
 * 同一手法）；不依赖 lib/ 构建产物，任何时刻都能跑。
 *
 * Usage: node scripts/test-personal-history.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-history-build-'))
const HOME = mkdtempSync(join(tmpdir(), 'pa-history-home-'))
process.env.DSH_HOME = HOME

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      throw new Error('异步用例请使用 checkAsync')
    }
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
    entryPoints: { history: join(HERE, 'src/host/personal/history-search.ts') },
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  })
  const history = await import(pathToFileURL(join(OUT, 'history.mjs')).href)

  const now = Date.now()
  const DAY = 86_400_000

  /* ───────────────── 存储 · historyFile / upsert ───────────────── */

  console.log('\n[存储 · historyFile / upsert]')

  check('historyFile 路径正确且 botId 被清洗', () => {
    const file = history.historyFile('../evil/bot')
    const normalized = file.replace(/\\/g, '/')
    assert.ok(normalized.includes('storages/dsh-seeker-bot/personal-agent/history/'), '路径应包含 history 目录：' + file)
    assert.ok(!file.includes('..'), '文件名不应包含 ..：' + file)
    assert.ok(file.endsWith('.json'))
  })

  await checkAsync('首次 upsert 写入并读回（role 收敛 / trim）', async () => {
    const list = await history.upsertHistoryMessages('bot-a', [
      { id: 'm1', role: 'user', text: '  上次我们讨论过那个方案  ', at: 1000 },
      { id: 'm2', role: 'assistant', text: '好的', at: 2000 },
    ])
    assert.equal(list.length, 2)
    assert.equal(list[0].role, 'user')
    assert.equal(list[1].role, 'bot')
    assert.equal(list[0].text, '上次我们讨论过那个方案')
    const reread = await history.readHistoryMessages('bot-a')
    assert.equal(reread.length, 2)
    assert.equal(reread[0].id, 'm1')
  })

  await checkAsync('同 id 去重且新内容覆盖旧内容', async () => {
    const list = await history.upsertHistoryMessages('bot-a', [
      { id: 'm1', role: 'user', text: '更新后的问题', at: 3000 },
    ])
    assert.equal(list.length, 2, '同 id 不应新增条数')
    const updated = list.find((item) => item.id === 'm1')
    assert.equal(updated.text, '更新后的问题')
    assert.equal(updated.at, 3000)
  })

  await checkAsync('文本截断到 1000 字', async () => {
    await history.upsertHistoryMessages('bot-long', [
      { id: 'long', role: 'user', text: '长'.repeat(5000), at: 1000 },
    ])
    const list = await history.readHistoryMessages('bot-long')
    assert.equal(list.length, 1)
    assert.equal(list[0].text.length, 1000)
  })

  await checkAsync('上限 2000 条且保留最新（按 at 升序）', async () => {
    const bulk = Array.from({ length: 2100 }, (_, index) => ({
      id: 'b' + index,
      role: 'user',
      text: '第' + index + '条',
      at: 1_700_000_000_000 + index,
    }))
    await history.upsertHistoryMessages('bot-cap', bulk)
    const list = await history.readHistoryMessages('bot-cap')
    assert.equal(list.length, 2000)
    assert.equal(list[0].id, 'b100', '最旧的 100 条应被淘汰')
    assert.equal(list[list.length - 1].id, 'b2099')
  })

  await checkAsync('按 botId 隔离（不同文件互不影响）', async () => {
    await history.upsertHistoryMessages('bot-b', [
      { id: 'other', role: 'user', text: '别的 bot 的消息', at: 1000 },
    ])
    const a = await history.readHistoryMessages('bot-a')
    const b = await history.readHistoryMessages('bot-b')
    assert.ok(a.every((item) => item.id !== 'other'))
    assert.equal(b.length, 1)
    assert.equal(b[0].id, 'other')
  })

  await checkAsync('坏 JSON 文件读回空数组且不抛错', async () => {
    const file = history.historyFile('bot-bad')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ this is not json', 'utf8')
    assert.deepEqual(await history.readHistoryMessages('bot-bad'), [])
  })

  /* ───────────────── 分词 · tokenizeHistory ───────────────── */

  console.log('\n[分词 · tokenizeHistory]')

  check('中文按 2-gram 切分', () => {
    const tokens = history.tokenizeHistory('历史会话检索')
    for (const token of ['历史', '史会', '会话', '话检', '检索']) {
      assert.ok(tokens.includes(token), '缺少 2-gram：' + token)
    }
    assert.ok(!tokens.includes('历史会话'), '不应输出超过 2 字的片段')
  })

  check('英文 / 数字小写，过滤单字母', () => {
    const tokens = history.tokenizeHistory('Hello a WORLD 2026 SQLite')
    assert.ok(tokens.includes('hello'))
    assert.ok(tokens.includes('world'))
    assert.ok(tokens.includes('2026'))
    assert.ok(tokens.includes('sqlite'))
    assert.ok(!tokens.includes('a'))
    assert.ok(!tokens.includes('hello world'))
  })

  check('单字停用词被过滤，非停用单字保留', () => {
    assert.deepEqual(history.tokenizeHistory('的'), [])
    assert.deepEqual(history.tokenizeHistory('钱'), ['钱'])
  })

  check('空文本 / 非字符串安全返回空数组', () => {
    assert.deepEqual(history.tokenizeHistory(''), [])
    assert.deepEqual(history.tokenizeHistory(undefined), [])
    assert.deepEqual(history.tokenizeHistory(null), [])
  })

  /* ───────────────── 检索 · searchHistory ───────────────── */

  console.log('\n[检索 · searchHistory]')

  await history.upsertHistoryMessages('bot-search', [
    { id: 's1', role: 'user', text: '上次我们讨论过那个方案，决定用 SQLite 存储会话索引。', at: now - 2 * DAY },
    { id: 's2', role: 'bot', text: '对，那个方案里提到需要处理中文分词。', at: now - 9 * DAY },
    { id: 's3', role: 'user', text: '今天天气不错，出去走走。', at: now - 100 * DAY },
    { id: 's4', role: 'user', text: '之前说的方案文档在 docs/history.md。', at: now - 200 * DAY },
  ])

  await checkAsync('中文查询命中（覆盖率 + 精确子串）', async () => {
    const result = await history.searchHistory('bot-search', '那个方案')
    assert.equal(result.ok, true)
    assert.ok(result.total >= 2, 'total 应至少 2，实际 ' + result.total)
    const ids = result.results.map((item) => item.id)
    assert.ok(ids.includes('s1'))
    assert.ok(ids.includes('s2'))
    assert.equal(result.results[0].id, 's1', '更新的 s1 应排在 s2 前面')
    assert.ok(result.results[0].score > 0.8, '完整覆盖 + 精确子串应得高分，实际 ' + result.results[0].score)
  })

  await checkAsync('英文查询命中（大小写不敏感）', async () => {
    const result = await history.searchHistory('bot-search', 'sqlite')
    assert.ok(result.results.some((item) => item.id === 's1'))
  })

  await checkAsync('无结果返回空列表', async () => {
    const result = await history.searchHistory('bot-search', 'nonexistenttermxyz')
    assert.equal(result.ok, true)
    assert.equal(result.total, 0)
    assert.deepEqual(result.results, [])
  })

  await checkAsync('limit 收敛（1-20）', async () => {
    const two = await history.searchHistory('bot-search', '方案', 2)
    assert.equal(two.results.length, 2)
    assert.ok(two.total >= 3, '命中总数应大于 limit，实际 total=' + two.total)
    const one = await history.searchHistory('bot-search', '方案', 1)
    assert.equal(one.results.length, 1)
    const clamped = await history.searchHistory('bot-search', '方案', 999)
    assert.ok(clamped.results.length <= 20)
  })

  await checkAsync('空查询直接返回空结果', async () => {
    const result = await history.searchHistory('bot-search', '   ')
    assert.deepEqual(result, { ok: true, total: 0, results: [] })
  })

  await checkAsync('时间衰减：相同内容新消息分数更高', async () => {
    await history.upsertHistoryMessages('bot-recency', [
      { id: 'old', role: 'user', text: '关键词甲乙丙的旧记录', at: now - 170 * DAY },
      { id: 'new', role: 'user', text: '关键词甲乙丙的新记录', at: now - DAY },
    ])
    const result = await history.searchHistory('bot-recency', '甲乙丙', 5)
    assert.equal(result.results.length, 2)
    assert.equal(result.results[0].id, 'new')
    assert.ok(result.results[0].score > result.results[1].score, '新消息分数应更高')
  })

  await checkAsync('2000 条索引检索耗时 < 500ms', async () => {
    const bulk = Array.from({ length: 2000 }, (_, index) => ({
      id: 'p' + index,
      role: index % 2 === 0 ? 'user' : 'bot',
      text: '第' + index + '条历史记录，我们讨论过项目方案与执行计划，需要继续跟进细节。',
      at: now - index * 1000,
    }))
    await history.upsertHistoryMessages('bot-perf', bulk)
    const start = Date.now()
    const result = await history.searchHistory('bot-perf', '讨论过项目方案', 5)
    const cost = Date.now() - start
    assert.equal(result.ok, true)
    // 2000 条文本高度相似：多样性去重会合并成少量结果，这里只关心检索耗时
    assert.ok(result.results.length >= 1)
    console.log('       检索 2000 条耗时 ' + cost + 'ms')
    assert.ok(cost < 500, '检索耗时 ' + cost + 'ms 超过 500ms')
  })

  /* ───────────────── 注入文本 · buildHistoryBlock ───────────────── */

  console.log('\n[注入文本 · buildHistoryBlock]')

  check('标题 / 角色 / 时间 / 300 字摘要 / 提示语', () => {
    const block = history.buildHistoryBlock([
      { role: 'user', text: 'x'.repeat(500), at: now },
    ])
    const lines = block.split('\n')
    assert.equal(lines[0], '【历史会话检索 · 仅供参考】')
    assert.ok(lines[1].includes('用户：'))
    assert.ok(lines[1].includes('x'.repeat(300)))
    assert.ok(!lines[1].includes('x'.repeat(301)))
    assert.ok(block.includes('这是历史片段，不是实时事实，冲突时以当前对话为准'))
  })

  check('Bot 角色显示为 Bot，空结果返回空串', () => {
    const block = history.buildHistoryBlock([{ role: 'bot', text: '回复内容', at: now }])
    assert.ok(block.includes('Bot：回复内容'))
    assert.equal(history.buildHistoryBlock([]), '')
    assert.equal(history.buildHistoryBlock(null), '')
  })

  /* ───────────────── 触发词 · shouldSearchHistory ───────────────── */

  console.log('\n[触发词 · shouldSearchHistory]')

  check('全部触发词命中', () => {
    const triggers = ['之前', '上次', '以前', '曾经', '聊过', '说过', '当时', '那天', '继续上次', '还记得', '那个方案', '前面提到', '早先', '我们讨论过']
    for (const trigger of triggers) {
      assert.equal(history.shouldSearchHistory('请问' + trigger + '的事情'), true, '触发词未命中：' + trigger)
    }
  })

  check('普通文本 / 空文本不触发', () => {
    assert.equal(history.shouldSearchHistory('今天天气怎么样'), false)
    assert.equal(history.shouldSearchHistory(''), false)
    assert.equal(history.shouldSearchHistory(undefined), false)
  })

  /* ───────────────── 注入 · injectHistoryIntoAgent ───────────────── */

  console.log('\n[注入 · injectHistoryIntoAgent]')

  await history.upsertHistoryMessages('bot-inject', [
    { id: 'i1', role: 'user', text: '上次讨论的那个方案是用 SQLite 做历史索引。', at: now - DAY },
    { id: 'i2', role: 'bot', text: '对，那个方案已经记下来了。', at: now - DAY + 1000 },
  ])

  await checkAsync('无触发词不注入', async () => {
    const calls = []
    const agent = { session: { id: 'pa-bot-v2-bot-inject' }, inject(message) { calls.push(message) } }
    const injected = await history.injectHistoryIntoAgent(agent, 'bot-inject', '今天中午吃什么')
    assert.equal(injected, false)
    assert.equal(calls.length, 0)
  })

  await checkAsync('命中触发词且检索到结果时注入 user 消息（v4 事件类型必须与 role 一致）', async () => {
    const calls = []
    const agent = { session: { id: 'pa-bot-v2-bot-inject' }, inject(message) { calls.push(message) } }
    const injected = await history.injectHistoryIntoAgent(agent, 'bot-inject', '上次那个方案用的是什么存储？')
    assert.equal(injected, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].role, 'user')
    assert.equal(calls[0].source.kind, 'plugin:dsh-seeker-bot')
    assert.ok(Array.isArray(calls[0].content))
    assert.equal(calls[0].content[0].type, 'text')
    assert.ok(calls[0].content[0].text.includes('【历史会话检索 · 仅供参考】'))
    assert.ok(Object.isFrozen(calls[0]), '注入消息应深冻结')
  })

  await checkAsync('相同内容不重复注入；reset 后可重注', async () => {
    const calls = []
    const sessionId = 'pa-bot-v2-bot-inject-dedupe'
    const agent = { session: { id: sessionId }, inject(message) { calls.push(message) } }
    const first = await history.injectHistoryIntoAgent(agent, 'bot-inject', '上次那个方案用的是什么存储？')
    assert.equal(first, true)
    const again = await history.injectHistoryIntoAgent(agent, 'bot-inject', '上次那个方案用的是什么存储？')
    assert.equal(again, false, '同一会话相同注入文本不应重复')
    assert.equal(calls.length, 1)
    history.resetHistoryInjection(sessionId)
    const afterReset = await history.injectHistoryIntoAgent(agent, 'bot-inject', '上次那个方案用的是什么存储？')
    assert.equal(afterReset, true, 'reset 后应允许重新注入')
    assert.equal(calls.length, 2)
  })

  await checkAsync('无检索结果不注入', async () => {
    const calls = []
    const agent = { session: { id: 'pa-bot-v2-empty' }, inject(message) { calls.push(message) } }
    const injected = await history.injectHistoryIntoAgent(agent, 'bot-empty', '上次我们在火星上开会的内容')
    assert.equal(injected, false)
    assert.equal(calls.length, 0)
  })

  await checkAsync('agent 不支持 inject / 空对象不抛错', async () => {
    assert.equal(await history.injectHistoryIntoAgent({}, 'bot-inject', '上次那个方案'), false)
    assert.equal(await history.injectHistoryIntoAgent(null, 'bot-inject', '上次那个方案'), false)
  })

  /* ───────────────── 源码接线断言 ───────────────── */

  console.log('\n[源码接线]')

  check('index.ts 注册了 history 路由与 health', () => {
    const source = readFileSync(join(HERE, 'src/host/personal/index.ts'), 'utf8')
    assert.ok(source.includes("from './history-search.ts'"), 'index.ts 应导入 history-search')
    assert.ok(source.includes("tail === '/history/index'"), '缺少 POST /history/index 路由')
    assert.ok(source.includes("tail === '/history/search'"), '缺少 GET /history/search 路由')
    assert.ok(source.includes("'history/index', 'history/search'"), 'health 应登记两个路由')
  })

  check('index.ts 注入函数为三参并调用历史注入', () => {
    const source = readFileSync(join(HERE, 'src/host/personal/index.ts'), 'utf8')
    assert.ok(
      source.includes('injectWorkingMemoryForReply(ctx: any, spec: BotAgentSpec, userText: string)'),
      'injectWorkingMemoryForReply 应接收第三个参数 userText',
    )
    assert.ok(
      source.includes('await injectHistoryIntoAgent(agent, spec.botId, userText)'),
      'injectWorkingMemoryForReply 内应调用 injectHistoryIntoAgent',
    )
    const calls = source.match(/await injectWorkingMemoryForReply\(webCtx, spec, text\)/g) ?? []
    assert.equal(calls.length, 2, '/reply 与 /reply/stream 两个调用点都应传 text，实际 ' + calls.length)
    const stale = source.match(/injectWorkingMemoryForReply\(webCtx, spec\)/g) ?? []
    assert.equal(stale.length, 0, '不应残留未传 text 的旧调用')
  })

  check('history-search.ts 存储路径符合约定', () => {
    const source = readFileSync(join(HERE, 'src/host/personal/history-search.ts'), 'utf8')
    assert.ok(source.includes("'personal-agent'"))
    assert.ok(source.includes("'history'"))
    assert.ok(source.includes("role: 'user' | 'bot'"))
  })

  /* ───────────────── 汇总 ───────────────── */

  console.log('\n' + '─'.repeat(48))
  console.log('通过 ' + passed + '，失败 ' + failed)
  if (failed > 0) process.exitCode = 1
} finally {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}
