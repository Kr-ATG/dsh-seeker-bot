#!/usr/bin/env node
/**
 * Personal Agent 期刊「前端数据层」自测。
 *
 * 两层检查：
 *  1. **静态断言**：读 `store.tsx` / `engine.ts` / `types.ts` 源码，确认宿主 API
 *     对接、本地回退、双主题封面、SSE 期刊分支、file:// 跳过等关键实现都在；
 *     这些是纯字符串断言，不依赖构建产物，任何时候都能跑。
 *  2. **运行时断言**：用项目自带的 esbuild 把 `engine.ts` 打成临时 ESM 模块，
 *     直接构造 AppState 调 `journalFeedFromState` / `buildJournal` / `journalFeedForSync` /
 *     `journalCoverSvg`，验证「真实统计 + 真实摘录」与双主题配色确实生效。
 *     esbuild 不可用时这一层跳过（不算失败）——静态断言已经覆盖交付要求。
 *
 * 运行：`node scripts/test-personal-journal-client.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const enginePath = join(root, 'src/client/personal/engine.ts')
const storePath = join(root, 'src/client/personal/store.tsx')
const typesPath = join(root, 'src/client/personal/types.ts')

let passed = 0

function ok(label) {
  passed += 1
  console.log(`  ✓ ${label}`)
}

function expectContains(source, needle, label) {
  assert.ok(source.includes(needle), `${label} 缺少关键实现：${needle}`)
  ok(label)
}

function expectAbsent(source, needle, label) {
  assert.ok(!source.includes(needle), `${label} 不应再出现：${needle}`)
  ok(label)
}

function expectNear(source, anchor, needle, label, distance = 500) {
  const index = source.indexOf(anchor)
  assert.ok(index >= 0, `${label} 找不到锚点：${anchor}`)
  const window = source.slice(index, index + distance)
  assert.ok(window.includes(needle), `${label} 的 ${anchor} 附近没有 ${needle}`)
  ok(label)
}

console.log('[journal-client] 静态断言')

const engineSource = await readFile(enginePath, 'utf8')
const storeSource = await readFile(storePath, 'utf8')
const typesSource = await readFile(typesPath, 'utf8')

// ── engine.ts：真实数据本地回退 + 双主题封面 ──
expectContains(engineSource, 'export function journalFeedFromState', 'engine 导出当天素材投影 journalFeedFromState')
expectContains(engineSource, 'export function journalFeedForSync', 'engine 导出 48h 同步素材 journalFeedForSync')
expectContains(engineSource, 'origin: \'local\'', '本地回退期刊标记 origin=local')
expectContains(engineSource, '安静的一天', '没有消息时如实使用「安静的一天」')
expectContains(engineSource, 'journalDateKey(date)', '本地期刊日期用本地时区 journalDateKey')
expectContains(engineSource, 'journalIssue(state.journals.length)', '本地期刊期号用 shared 的 journalIssue')
expectContains(engineSource, 'label: \'对话消息\'', 'stats 含「对话消息」')
expectContains(engineSource, 'label: \'活跃 Bot\'', 'stats 含「活跃 Bot」')
expectContains(engineSource, 'label: \'新增记忆\'', 'stats 含「新增记忆」')
expectContains(engineSource, 'label: \'例行任务\'', 'stats 含「例行任务」')
expectContains(engineSource, '原声摘录', 'sections 含真实摘录段')
expectContains(engineSource, 'theme: \'dark\' | \'light\' = \'dark\'', 'journalCoverSvg 支持 dark/light 且默认 dark')
expectContains(engineSource, '#2f4a6b', '亮色封面使用深蓝线网络')
expectContains(engineSource, '#faf5ec', '亮色封面使用米白纸张底色')
expectAbsent(engineSource, 'JOURNAL_TITLES', '旧的随机标题数组已删除')
expectAbsent(engineSource, 'JOURNAL_OPENINGS', '旧的随机开场白数组已删除')

// ── store.tsx：宿主 API 对接 / 回退 / SSE / 同步 ──
expectContains(storeSource, '/api/personal-agent/journal/list', 'store 对接 GET /journal/list')
expectContains(storeSource, '/api/personal-agent/journal/status', 'store 对接 GET /journal/status')
expectContains(storeSource, '/api/personal-agent/journal/generate', 'store 对接 POST /journal/generate')
expectContains(storeSource, '/api/personal-agent/journal/check', 'store 对接 POST /journal/check')
expectContains(storeSource, '/api/personal-agent/journal/rule', 'store 对接 POST /journal/rule')
expectContains(storeSource, '/api/personal-agent/journal/feed', 'store 对接 POST /journal/feed')
expectContains(storeSource, 'journalFeedFromState(state, botId, date)', 'generateJournal 先构建当天素材')
expectContains(storeSource, 'journalFeedForSync(stateRef.current, MAIN_BOT_ID)', 'feed 同步使用 48h 素材')
expectContains(storeSource, '宿主模型不可用，已生成本地版期刊', '宿主失败时 toast 说明本地回退')
expectContains(storeSource, 'payload?.type === \'journal\'', 'SSE 增加期刊事件分支')
expectContains(storeSource, 'sanitizeHostJournal(payload.journal)', 'SSE 期刊事件先 sanitize')
expectContains(storeSource, '昨日期刊已生成', '自动生成期刊时 toast 提示')
expectContains(storeSource, 'mergeJournals(prev.journals, journals)', '宿主期刊合并进本地 state')
expectContains(storeSource, 'mergeJournalLogs(prev.journalLogs, status.logs)', '宿主触发日志合并进 state')
expectContains(storeSource, 'journalLogs: mergeJournalLogs(prev.journalLogs, status.logs)', '启动同步合并日志')
expectContains(storeSource, 'upsertJournal(prev.journals, record)', '生成期刊按 id upsert，不重复 append')
expectContains(storeSource, 'journalCheckInFlightRef', '宿主检查做并发保护')
expectContains(storeSource, 'runJournalCheck(nowOverride?: number): { ok: boolean; reason: string; journalId?: string }', 'runJournalCheck 保持同步签名（不破坏调用方）')
expectContains(storeSource, 'journalRule: normalizeJournalRule(raw.settings?.journalRule)', '旧 localStorage 规则走 normalizeJournalRule')
expectContains(storeSource, '5_000', 'feed 同步 5 秒防抖')
expectContains(storeSource, '1_000', 'rule 同步 1 秒防抖')

// 所有新增宿主调用在 file:// 下必须跳过
for (const fn of [
  'hostJournalList',
  'hostJournalStatus',
  'hostJournalGenerate',
  'hostJournalCheck',
  'hostJournalRule',
  'hostJournalFeed',
]) {
  expectNear(storeSource, `async function ${fn}`, 'isDemoMode()', `${fn} 在 file:// 下跳过`)
}
expectNear(storeSource, 'if (isDemoMode()) return undefined', 'hostJournalList()', '启动同步在 file:// 下跳过')

// ── types.ts：期刊类型收口，没有重复定义 ──
expectContains(typesSource, 'JournalRecord as Journal', 'types 继续从 shared re-export Journal')
expectContains(typesSource, 'journalRule: JournalRule', 'PersonalSettings.journalRule 是 shared 的 JournalRule')
expectContains(typesSource, 'JournalStatus', 'types re-export JournalStatus')
expectContains(typesSource, 'journalStatus?:', 'AppState 暴露宿主期刊状态 journalStatus（规则面板读它）')
expectContains(storeSource, 'journalStatus: { generating: false', '生成 / SSE 之后更新 journalStatus')
expectAbsent(typesSource, 'interface Journal {', 'types 没有重复定义 Journal')

// ── 运行时断言（esbuild 可用时） ──
console.log('[journal-client] 运行时断言')

let runtimeChecked = false
let tempDir = null
try {
  const esbuild = await import('esbuild')
  const build = esbuild.build ?? esbuild.default?.build
  assert.equal(typeof build, 'function', 'esbuild.build 不可用')

  tempDir = await mkdtemp(join(tmpdir(), 'journal-client-test-'))
  const outfile = join(tempDir, 'engine.mjs')
  await build({
    entryPoints: [enginePath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  })
  const engine = await import(pathToFileURL(outfile).href)

  const day = (hour, minute) => new Date(2026, 10, 1, hour, minute, 0).getTime()
  const baseState = {
    version: 2,
    bots: [
      { id: 'bot-main', name: 'Seeker', role: '主助手', description: '', instructions: '', groupId: 'g', isMain: true, status: 'online', unread: 0, pinned: false, enabled: true, model: { provider: 'p', model: 'm' }, skills: [], proactive: { enabled: false, freq: 'daily', from: '09:00', to: '18:00' }, createdAt: 0, createdBy: null, avatar: { shape: 'blob', color: '#2f6bff' } },
      { id: 'bot-research', name: '调研员', role: '资料整理', description: '', instructions: '', groupId: 'g', isMain: false, status: 'online', unread: 0, pinned: false, enabled: true, model: { provider: 'p', model: 'm' }, skills: [], proactive: { enabled: false, freq: 'daily', from: '09:00', to: '18:00' }, createdAt: 0, createdBy: null, avatar: { shape: 'leaf', color: '#30d158' } },
    ],
    groups: [],
    rooms: [],
    messages: [
      { id: 'm1', botId: 'bot-main', role: 'user', at: day(9, 10), blocks: [{ type: 'text', text: '帮我把期刊界面重写一下，期刊要能引用真实对话。' }] },
      { id: 'm2', botId: 'bot-main', role: 'bot', at: day(9, 12), blocks: [{ type: 'text', text: '好，我先整理期刊的素材，再把界面重写成编辑杂志风。' }] },
      { id: 'm3', botId: 'bot-main', role: 'user', at: day(10, 5), blocks: [{ type: 'text', text: '期刊的封面也要支持亮色主题。' }] },
      { id: 'm4', botId: 'bot-main', role: 'bot', at: day(10, 8), blocks: [{ type: 'text', text: '收到，期刊封面会出深色和亮色两套。' }] },
      { id: 'm5', botId: 'bot-research', role: 'bot', at: day(11, 0), blocks: [{ type: 'text', text: '我这边整理了三条期刊相关的资料。' }] },
      // 期刊卡不是对话素材：必须被跳过
      { id: 'm6', botId: 'bot-main', role: 'bot', at: day(12, 0), blocks: [{ type: 'journal', journalId: 'j-old', title: '上一期', date: '2026-10-31', summary: 'x' }] },
    ],
    memories: [{ id: 'mem1', botId: 'bot-main', text: '用户喜欢编辑杂志风', tags: [], createdAt: day(9, 30) }],
    routines: [{ id: 'rt1', botId: 'bot-main', name: '晨间简报', instruction: 'x', schedule: { kind: 'daily', time: '09:00' }, enabled: true, createdAt: 0, runs: [] }],
    calls: [],
    journals: [],
    journalLogs: [],
    tasks: [],
    settings: { theme: 'auto', showRightPanel: true, journalRule: { enabled: true, startHour: 0, endHour: 8, idleMinutes: 30 } },
    lastUserMessageAt: day(10, 5),
  }

  // journalFeedFromState：只收当天 user/bot 的 text 块
  const feed = engine.journalFeedFromState(baseState, 'bot-main', new Date(2026, 10, 1, 12, 0, 0))
  assert.equal(feed.messages.length, 5, 'feed 应包含 5 条有正文的消息（期刊卡被跳过）')
  assert.ok(feed.messages.every((message) => message.role === 'user' || message.role === 'bot'))
  assert.ok(feed.messages.every((message) => message.text.length <= 600))
  assert.equal(feed.stats.messages, 5)
  assert.equal(feed.stats.userMessages, 2)
  assert.equal(feed.stats.botMessages, 3)
  assert.equal(feed.stats.activeBots, 2)
  assert.equal(feed.stats.memories, 1)
  assert.equal(feed.stats.routines, 1)
  ok('journalFeedFromState 统计真实消息 / 活跃 Bot / 记忆 / 例行任务')

  // buildJournal：真实统计 + 真实摘录
  const journal = engine.buildJournal(baseState, 'bot-main', { date: new Date(2026, 10, 1, 12, 0, 0) })
  assert.equal(journal.date, '2026-11-01')
  assert.equal(journal.dateLabel, '2026 年 11 月 1 日')
  assert.equal(journal.issue, 'No. 001')
  assert.equal(journal.origin, 'local')
  assert.equal(journal.auto, false)
  assert.ok(journal.title.includes('期刊'), `标题应引用当天高频话题，实际：${journal.title}`)
  assert.ok(journal.summary.includes('5 条消息'), `摘要应引用真实消息数，实际：${journal.summary}`)
  assert.ok(journal.summary.includes('2 个助手'), `摘要应引用真实活跃 Bot 数，实际：${journal.summary}`)
  assert.ok(journal.summary.includes('期刊'), `摘要应引用真实话题，实际：${journal.summary}`)
  assert.equal(journal.stats.length, 4)
  assert.deepEqual(journal.stats.map((item) => item.label), ['对话消息', '活跃 Bot', '新增记忆', '例行任务'])
  assert.deepEqual(journal.stats.map((item) => item.value), ['5', '2', '1', '1'])
  assert.ok(journal.sections.length >= 3, '至少 3 段正文')
  const quoteSection = journal.sections.find((section) => section.heading === '原声摘录')
  assert.ok(quoteSection !== undefined, '存在「原声摘录」段')
  assert.ok(quoteSection.text.includes('帮我把期刊界面重写'), '摘录引用真实用户原话')
  assert.ok(quoteSection.text.includes('Seeker'), '摘录引用真实 Bot 回复')
  assert.ok(typeof journal.quote === 'string' && journal.quote.includes('帮我把期刊界面重写'), 'quote 用真实用户原话')
  assert.equal(journal.weather, undefined, '不再编造天气')
  assert.ok(Array.isArray(journal.highlights) && journal.highlights.length > 0 && journal.highlights.length <= 5, 'highlights 1–5 条')
  for (const highlight of journal.highlights) {
    assert.match(highlight.time ?? '', /^\d{2}:\d{2}$/, 'highlight 时间是 HH:MM')
    assert.ok(highlight.title.length <= 25, 'highlight 标题截断到 24 字')
    assert.ok(highlight.botName === '你' || typeof highlight.botName === 'string', 'highlight 带发送者')
  }
  ok('buildJournal 用真实统计 / 真实摘录生成标题、摘要、章节、stats、highlights')

  // 没有素材时如实记录
  const emptyState = { ...baseState, messages: [], memories: [], routines: [], calls: [] }
  const emptyJournal = engine.buildJournal(emptyState, 'bot-main', { date: new Date(2026, 10, 1, 12, 0, 0) })
  assert.equal(emptyJournal.title, '安静的一天')
  assert.ok(emptyJournal.summary.includes('没有新的对话'))
  assert.equal(emptyJournal.sections.length, 3)
  assert.equal(emptyJournal.quote, undefined)
  assert.deepEqual(emptyJournal.highlights, [])
  assert.deepEqual(emptyJournal.stats.map((item) => item.value), ['0', '0', '0', '0'])
  ok('没有素材时标题 / 摘要 / 章节如实留白，不编造内容')

  // 指定日期只统计当天
  const yesterdayJournal = engine.buildJournal(baseState, 'bot-main', { date: new Date(2026, 9, 31, 12, 0, 0) })
  assert.equal(yesterdayJournal.title, '安静的一天', '前一天没有消息时不应把今天的素材算进来')
  assert.equal(yesterdayJournal.date, '2026-10-31')
  ok('buildJournal 严格按指定日期（本地 0:00–24:00）取素材')

  // journalFeedForSync：48h 消息 + 昨天统计
  const syncFeed = engine.journalFeedForSync(baseState, 'bot-main', new Date(2026, 10, 2, 1, 0, 0))
  assert.equal(syncFeed.messages.length, 5, '48h 窗口包含昨天的消息')
  assert.equal(syncFeed.stats.messages, 5, 'stats 用昨天的统计')
  assert.equal(syncFeed.lastUserMessageAt, baseState.lastUserMessageAt)
  assert.equal(typeof syncFeed.syncedAt, 'number')
  ok('journalFeedForSync 同步最近 48h 消息 + 昨天统计')

  // journalCoverSvg：双主题且默认保持旧外观
  const dark = engine.journalCoverSvg(journal)
  const darkExplicit = engine.journalCoverSvg(journal, 'dark')
  const light = engine.journalCoverSvg(journal, 'light')
  assert.ok(dark.startsWith('data:image/svg+xml'))
  assert.equal(dark, darkExplicit, '单参调用与显式 dark 完全一致（旧调用兼容）')
  assert.notEqual(dark, light, '亮色与暗色封面必须不同')
  const darkSvg = decodeURIComponent(dark.split(',')[1])
  const lightSvg = decodeURIComponent(light.split(',')[1])
  assert.ok(darkSvg.includes('#0d1424'), '暗色封面保持深蓝底色')
  assert.ok(lightSvg.includes('#faf5ec'), '亮色封面使用米白底色')
  assert.ok(lightSvg.includes('#2f4a6b'), '亮色封面使用深蓝线网络')
  ok('journalCoverSvg 支持 dark/light 两套配色，单参调用保持旧外观')

  runtimeChecked = true
} catch (error) {
  if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
    console.log('  · 跳过运行时断言：未找到 esbuild（静态断言已覆盖交付要求）')
  } else {
    throw error
  }
} finally {
  if (tempDir !== null) await rm(tempDir, { recursive: true, force: true })
}

console.log(`[journal-client] 全部通过（${String(passed)} 项断言${runtimeChecked ? '，含运行时' : ''}）`)
