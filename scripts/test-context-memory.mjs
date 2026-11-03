/**
 * 上下文与记忆控制的端到端验证（不依赖真实 DSH 宿主）。
 *
 * 覆盖路线图里四条链路的**真实文件读写**，而不是纯函数 mock：
 *   - 0.2 工作记忆：写入 → 读回 → 注入文本 → 过期清理
 *   - 3.1 Pages：写入 → 列表 → 读取 → 更新版本递增 → slug 校验
 *   - 1.1 compaction 事件：publish / subscribe / seq 单调
 *   - 1.3 工具结果清理：超过 14 天的 session 目录被 prune
 *
 * 为什么单独成脚本：这四条链路分别落在 host / memory / client 三个半身，
 * 各自的单元测试都只覆盖自己那一段；这里用真实临时目录把它们串起来跑一遍，
 * 相当于「没有真实宿主时的端到端」。
 *
 * 用法：node scripts/test-context-memory.mjs（先 npm run build 不需要，本脚本直接跑 .ts）
 */
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pa-ctx-home-'))
process.env.DSH_SEEKER_BOT_WORKSPACE = mkdtempSync(join(tmpdir(), 'pa-ctx-ws-'))

const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href)

const wm = await load('src/host/personal/working-memory.ts')
const pages = await load('src/host/personal/pages.ts')
const events = await load('src/host/personal/events.ts')
const agent = await load('src/host/personal/agent.ts')

let failed = 0
const check = (cond, label) => {
  if (cond) console.log(`✓ ${label}`)
  else {
    failed += 1
    console.error(`✗ ${label}`)
  }
}

const BOT = 'bot-main-test'

/* ───────────────────────── 0.2 工作记忆 ───────────────────────── */
console.log('\n[0.2] 工作记忆')

await wm.upsertWorkingTask(BOT, {
  id: 'task-outbound',
  title: 'Q4 外呼名单',
  status: 'active',
  steps: [
    { label: '拉账号', status: 'done' },
    { label: '生成草稿', status: 'doing' },
    { label: '人工审批', status: 'todo' },
  ],
  facts: { accounts: '52', drafts: '36' },
  artifacts: ['产出物/小析/文档/名单.xlsx'],
  blockers: ['等你登录 Salesforce'],
  updatedAt: Date.now(),
})

const tasks = await wm.readWorkingTasks(BOT)
check(tasks.length === 1, '写入后能读回')
check(tasks[0].facts.accounts === '52', '关键数据保留')

const block = wm.buildWorkingMemoryBlock(tasks)
check(block.includes('Q4 外呼名单'), '注入文本含任务标题')
check(block.includes('accounts=52') && block.includes('drafts=36'), '注入文本含关键数据')
check(block.includes('等你登录 Salesforce'), '注入文本含待办')
check(block.includes('不是实时数据'), '注入文本带记忆定位标注')

// 过期清理：done 且超过 ttl 的任务应被清掉
await wm.upsertWorkingTask(BOT, {
  id: 'task-old',
  title: '上周的活',
  status: 'done',
  steps: [],
  facts: {},
  artifacts: [],
  blockers: [],
  updatedAt: Date.now() - 30 * 86_400_000,
  ttlDays: 7,
})
const kept = await wm.pruneWorkingTasks(BOT)
check(kept.length === 1 && kept[0].id === 'task-outbound', 'done 超过 ttl 的任务被清理，活跃任务保留')

/* ───────────────────────── 3.1 Pages ───────────────────────── */
console.log('\n[3.1] Pages')

const created = pages.writePage(BOT, {
  title: '销售看板',
  html: '<!doctype html><html><body><h1>v1</h1></body></html>',
  sourceMessageId: 'msg-1',
})
check(created.ok === true, 'Pages 写入成功')
const slug = created.ok ? created.meta.slug : ''
check(slug !== '' && pages.isValidSlug(slug), '自动生成的 slug 合法')

const list = pages.listPages(BOT)
check(list.length === 1, '列表命中 1 条')
check(list[0]?.title === '销售看板', '列表标题正确')
check(!('html' in (list[0] ?? {})), '列表不携带 html（省流量）')

const record = pages.readPage(BOT, slug)
check(record !== null && record.html.includes('<h1>v1</h1>'), '单页读取内容正确')
check(record?.meta.version === 1, '初始版本为 1')

const updated = pages.writePage(BOT, {
  slug,
  title: '销售看板',
  html: '<!doctype html><html><body><h1>v2</h1></body></html>',
})
check(updated.ok === true && updated.meta.version === 2, '同 slug 更新版本递增到 2')
check(pages.readPage(BOT, slug)?.html.includes('<h1>v2</h1>'), '更新后读到新内容')
check(pages.readPage(BOT, slug)?.meta.createdAt === record?.meta.createdAt, '更新保留 createdAt')

check(!pages.isValidSlug('../etc/passwd'), 'slug 校验拒绝路径穿越')
check(pages.readPage(BOT, '../etc/passwd') === null, '非法 slug 读取返回 null')
const bad = pages.writePage(BOT, { title: '', html: 'x' })
check(bad.ok === false && bad.error === 'invalid-title', '空标题被拒（400 语义）')

/* ───────────────────────── 1.1 compaction 事件 ───────────────────────── */
console.log('\n[1.1] compaction 事件')

const received = []
const unsubscribe = events.subscribe(BOT, (event) => received.push(event))
const published = events.publish(BOT, {
  type: 'compaction',
  summary: '前面 20 条消息被折叠成摘要',
  shadowedTokenCount: 12345,
})
check(received.length === 1, '订阅者收到事件')
check(received[0]?.type === 'compaction', '事件类型正确')
check(received[0]?.summary === '前面 20 条消息被折叠成摘要', '摘要透传')
check(typeof published.seq === 'number' && published.seq >= 1, '事件带单调 seq')
unsubscribe()
events.publish(BOT, { type: 'compaction', summary: 'second' })
check(received.length === 1, '退订后不再收到')
check(events.currentSeq(BOT) >= 2, 'seq 继续单调递增')

/* ───────────────────────── 1.3 工具结果清理 ───────────────────────── */
console.log('\n[1.3] 工具结果清理')

const toolRoot = join(process.env.DSH_HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'tool-results')
const oldSession = join(toolRoot, 'pa-bot-old')
mkdirSync(oldSession, { recursive: true })
const oldFile = join(oldSession, 'call-1.txt')
writeFileSync(oldFile, 'x'.repeat(2048), 'utf8')
const oldTime = new Date(Date.now() - 30 * 86_400_000)
utimesSync(oldFile, oldTime, oldTime)

const freshSession = join(toolRoot, 'pa-bot-fresh')
mkdirSync(freshSession, { recursive: true })
writeFileSync(join(freshSession, 'call-2.txt'), 'y'.repeat(64), 'utf8')

await agent.pruneToolResults(Date.now(), { maxAgeMs: 14 * 86_400_000 })
check(!existsSync(oldSession), '超过 14 天的 session 目录被清理')
check(existsSync(freshSession), '新 session 目录保留')

/* ───────────────────────── 汇总 ───────────────────────── */
console.log('')
if (failed === 0) {
  console.log('PASS 上下文与记忆端到端（工作记忆 / Pages / compaction / 工具结果清理）')
  process.exit(0)
}
console.error(`FAIL ${failed} 项`)
process.exit(1)
