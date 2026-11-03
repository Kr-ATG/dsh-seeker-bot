/**
 * 撤回作用域的回归测试。
 *
 * 核心约束：用户连发三句时，从第二句撤回，第三句的记忆 / 工作记忆不能
 * 被时间窗口误伤。覆盖：
 *   - 记忆条目按 (sessionId, turn) 精确匹配；无 turn 的旧 extract 才退回时间窗；
 *   - manual 条目有 turn 时精确删除，没有 turn 的（面板手写）不删；
 *   - 工作记忆任务按 provenance.turn 精确回收，turn+1 的任务保留；
 *   - 撤回后同轮迟到的写入被墓碑拦住。
 *
 * Usage: node scripts/test-personal-recall.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const HERE = process.cwd()
const outdir = mkdtempSync(join(tmpdir(), 'dsh-recall-scope-'))
const home = mkdtempSync(join(tmpdir(), 'dsh-recall-home-'))
process.env.DSH_HOME = home

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  await build({
    entryPoints: [
      join(HERE, 'src/triad/memory/engine/store.ts'),
      join(HERE, 'src/triad/memory/engine/recall-scope.ts'),
      join(HERE, 'src/triad/memory/engine/session-turn.ts'),
      join(HERE, 'src/host/personal/working-memory.ts'),
    ],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    entryNames: '[name]',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  })

  const { MemoryStore } = await import(pathToFileURL(join(outdir, 'store.mjs')).href)
  const { isEntryFromRecalledTurn } = await import(pathToFileURL(join(outdir, 'recall-scope.mjs')).href)
  const { currentTurnOf } = await import(pathToFileURL(join(outdir, 'session-turn.mjs')).href)
  const working = await import(pathToFileURL(join(outdir, 'working-memory.mjs')).href)

  const SESSION = 'pa-bot-v2-bot-a'
  const OTHER = 'pa-bot-v2-bot-b'
  const now = Date.now()
  const scope = { sessionId: SESSION, turn: 2, userMessageId: 'u2', from: now - 1000, to: now + 1000 }

  console.log('\n[1] 记忆条目按消息匹配（steer 插话：第 2、3 句同 turn）')
  const store = new MemoryStore(join(home, 'memories'))
  const put = (content, source, provenance) => store.upsertEntry({
    content,
    scope: 'global',
    projectHash: null,
    owner: 'bot:bot-a',
    source,
    provenance,
  })
  await put('第二句自动抽取', 'extract', { sessionId: SESSION, turn: 2, userMessageId: 'u2' })
  await put('第三句自动抽取', 'extract', { sessionId: SESSION, turn: 2, userMessageId: 'u3' })
  await put('第二句手动记忆', 'manual', { sessionId: SESSION, turn: 2, userMessageId: 'u2' })
  await put('第三句手动记忆', 'manual', { sessionId: SESSION, turn: 2, userMessageId: 'u3' })
  await put('面板手写记忆', 'manual', { sessionId: SESSION })
  await put('旧版无 provenance 自动抽取', 'extract', undefined)
  await put('旧版无 provenance 手动记忆', 'manual', undefined)

  const entries = await store.readEntries()
  const byContent = new Map(entries.map(entry => [entry.content, entry]))
  check('第二句 extract 命中', () => assert.equal(isEntryFromRecalledTurn(byContent.get('第二句自动抽取'), scope), true))
  check('第三句 extract 不受影响', () => assert.equal(isEntryFromRecalledTurn(byContent.get('第三句自动抽取'), scope), false))
  check('第二句 manual 命中', () => assert.equal(isEntryFromRecalledTurn(byContent.get('第二句手动记忆'), scope), true))
  check('第三句 manual 不受影响', () => assert.equal(isEntryFromRecalledTurn(byContent.get('第三句手动记忆'), scope), false))
  check('面板手写（无 turn）不删', () => assert.equal(isEntryFromRecalledTurn(byContent.get('面板手写记忆'), scope), false))
  check('旧版 extract 按时间窗兜底', () => assert.equal(isEntryFromRecalledTurn(byContent.get('旧版无 provenance 自动抽取'), scope), true))
  check('旧版 manual 不按时间窗删', () => assert.equal(isEntryFromRecalledTurn(byContent.get('旧版无 provenance 手动记忆'), scope), false))

  store.markTurnRecalled(SESSION, 2)
  check('markTurnRecalled 只影响同轮', () => {
    assert.equal(store.isTurnRecalled(SESSION, 2), true)
    assert.equal(store.isTurnRecalled(SESSION, 3), false)
    assert.equal(store.isTurnRecalled(OTHER, 2), false)
  })

  const removed = await store.removeEntriesWhere(entry => entry.owner === 'bot:bot-a' && isEntryFromRecalledTurn(entry, scope))
  await store.flush()
  const left = new Set((await store.readEntries()).map(entry => entry.content))
  check(`批量删除条数（实际 ${removed}）`, () => assert.equal(removed, 3))
  check('第二句两条都删了', () => assert.equal(left.has('第二句自动抽取') || left.has('第二句手动记忆'), false))
  check('第三句两条都保留', () => { assert.equal(left.has('第三句自动抽取'), true); assert.equal(left.has('第三句手动记忆'), true) })
  check('面板手写保留', () => assert.equal(left.has('面板手写记忆'), true))

  console.log('\n[2] 工作记忆按轮回收')
  await working.writeWorkingTasks('bot-a', [
    { id: 'task-2', title: '第二句任务', status: 'active', steps: [], facts: {}, artifacts: [], blockers: [], updatedAt: now, provenance: { sessionId: SESSION, turn: 2, userMessageId: 'u2' } },
    { id: 'task-3', title: '第三句任务', status: 'active', steps: [], facts: {}, artifacts: [], blockers: [], updatedAt: now, provenance: { sessionId: SESSION, turn: 2, userMessageId: 'u3' } },
    { id: 'task-other', title: '别的会话', status: 'active', steps: [], facts: {}, artifacts: [], blockers: [], updatedAt: now, provenance: { sessionId: OTHER, turn: 2 } },
    { id: 'task-legacy', title: '旧任务', status: 'active', steps: [], facts: {}, artifacts: [], blockers: [], updatedAt: now },
  ])
  const removedTasks = await working.purgeWorkingTasksForTurn('bot-a', scope)
  const tasks = await working.readWorkingTasks('bot-a')
  const taskIds = new Set(tasks.map(task => task.id))
  check(`删除任务数（实际 ${removedTasks}）`, () => assert.equal(removedTasks, 2))
  check('第二句任务删掉', () => assert.equal(taskIds.has('task-2'), false))
  check('第三句任务保留', () => assert.equal(taskIds.has('task-3'), true))
  check('别的会话保留', () => assert.equal(taskIds.has('task-other'), true))
  check('旧任务按时间窗兜底删掉', () => assert.equal(taskIds.has('task-legacy'), false))
  check('撤回后的注入文本不含第二句任务', () => assert.equal(working.buildWorkingMemoryBlock(tasks).includes('第二句任务'), false))

  try {
    const before = (await working.readWorkingTasks('bot-a')).length
    await working.upsertWorkingTask('bot-a', {
      id: 'late', title: '迟到任务', status: 'active', steps: [], facts: {}, artifacts: [], blockers: [], updatedAt: now,
      provenance: { sessionId: SESSION, turn: 2, userMessageId: 'u2' },
    })
    assert.equal((await working.readWorkingTasks('bot-a')).length, before)
    console.log('  ok   撤回后同轮迟到写入被拦截')
  } catch (error) {
    failed += 1
    console.error(`  FAIL 撤回后同轮迟到写入被拦截\n       ${error instanceof Error ? error.message : String(error)}`)
  }

  console.log('\n[3] turn 读取')
  check('从 turn/start 读取当前 turn', () => {
    const agent = { session: { id: 's', snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 7 } },
    ] } }
    assert.equal(currentTurnOf(agent), 7)
  })
  check('拿不到时返回 0', () => assert.equal(currentTurnOf(undefined), 0))
} finally {
  rmSync(outdir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n[recall-scope] ${failed} 项失败`)
  process.exit(1)
}
console.log('\n[recall-scope] PASS')
