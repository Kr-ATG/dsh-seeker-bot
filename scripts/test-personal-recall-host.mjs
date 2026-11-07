/**
 * `recallBotTurn` 的集成测试（不依赖真实 DSH / 真实 memory 插件）。
 *
 * 用一个假的 session 事件流证明：
 *   - 撤回第二句时，replace 只覆盖第二句那一轮（到第三句之前）；
 *   - 记忆只删第二句那一轮的 extract / manual；
 *   - 工作记忆只删第二句那一轮的任务，第三句任务保留。
 *
 * Usage: node scripts/test-personal-recall-host.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const HERE = process.cwd()
const outdir = mkdtempSync(join(tmpdir(), 'dsh-recall-host-'))
const home = mkdtempSync(join(tmpdir(), 'dsh-recall-host-home-'))
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
  const agentStub = join(outdir, 'agent-stub.mjs')
  const storeStub = join(outdir, 'store-stub.mjs')
  writeFileSync(agentStub, 'export async function ensureBotAgent(ctx) { return ctx.__agent }\n', 'utf8')
  writeFileSync(storeStub, 'export function getWebuiMemoryStore() { return globalThis.__memoryStore }\n', 'utf8')

  await build({
    entryPoints: [
      join(HERE, 'src/host/personal/recall.ts'),
      join(HERE, 'src/host/personal/working-memory.ts'),
    ],
    outdir,
    entryNames: '[name]',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
    plugins: [{
      name: 'stub-agent-and-store',
      setup(build) {
        build.onResolve({ filter: /(^|\/)agent\.ts$/ }, () => ({ path: agentStub }))
        build.onResolve({ filter: /memory-store-singleton\.ts$/ }, () => ({ path: storeStub }))
      },
    }],
  })

  const { recallBotTurn } = await import(pathToFileURL(join(outdir, 'recall.mjs')).href)
  const working = await import(pathToFileURL(join(outdir, 'working-memory.mjs')).href)

  const now = Date.now()
  const log = []
  const push = (type, time, data, extra = {}) => {
    const seq = log.length
    log.push({ type, seq, time, data, ...extra })
    return seq
  }
  // 第 1 句（turn 1）之前的 turn/start 让扫描能拿到 turn 2 的起始时间
  push('turn/start', now - 10_000, { turn: 1 })
  const u1 = push('user/message', now - 9_000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } })
  const a1 = push('assistant/message', now - 8_000, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复1' }] } })
  push('turn/end', now - 7_900, { turn: 1 })
  /*
   * 第 2、3 句是同一个 turn：模拟「Bot 还在跑时用户插话」（agent.steer）。
   * 撤回第 2 句时，第 3 句必须原样保留。
   */
  push('turn/start', now - 6_000, { turn: 2 })
  const u2 = push('user/message', now - 5_000, { id: 'u2', role: 'user', content: [{ type: 'text', text: '第二句' }], source: { kind: 'user' } })
  const a2 = push('assistant/message', now - 4_000, { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复2' }] } })
  const u3 = push('user/message', now - 3_000, { id: 'u3', role: 'user', content: [{ type: 'text', text: '第三句' }], source: { kind: 'user' } })
  const a3 = push('assistant/message', now - 2_500, { turn: 2, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '回复3' }] } })
  push('turn/end', now - 2_000, { turn: 2 })

  const session = {
    id: 'pa-bot-v2-bot-a',
    surface: { nodes: [u1, a1, u2, a2, u3, a3] },
    eventAt(seq) { return log[seq] },
    snapshotEvents() { return log },
    append(type, data, opts = {}) {
      const seq = log.length
      log.push({ type, seq, time: Date.now(), data, ...opts })
      return log[seq]
    },
  }

  const memoryEntries = [
    { id: 'mem-2-extract', owner: 'bot:bot-a', source: 'extract', content: '第二句自动', createdAt: new Date(now - 4_500).toISOString(), provenance: { sessionId: 'pa-bot-v2-bot-a', turn: 2, userMessageId: 'u2' } },
    { id: 'mem-2-manual', owner: 'bot:bot-a', source: 'manual', content: '第二句手动', createdAt: new Date(now - 4_400).toISOString(), provenance: { sessionId: 'pa-bot-v2-bot-a', turn: 2, userMessageId: 'u2' } },
    { id: 'mem-3-extract', owner: 'bot:bot-a', source: 'extract', content: '第三句自动', createdAt: new Date(now - 2_200).toISOString(), provenance: { sessionId: 'pa-bot-v2-bot-a', turn: 2, userMessageId: 'u3' } },
    { id: 'mem-3-manual', owner: 'bot:bot-a', source: 'manual', content: '第三句手动', createdAt: new Date(now - 2_100).toISOString(), provenance: { sessionId: 'pa-bot-v2-bot-a', turn: 2, userMessageId: 'u3' } },
  ]
  const memoryStore = {
    entries: memoryEntries,
    marked: null,
    markTurnRecalled(sessionId, turn) { this.marked = ['turn', sessionId, turn] },
    markMessageRecalled(sessionId, userMessageId) { this.marked = ['message', sessionId, userMessageId] },
    async removeEntriesWhere(predicate) {
      const before = this.entries.length
      this.entries = this.entries.filter(entry => !predicate(entry))
      return before - this.entries.length
    },
    async flush() {},
  }
  globalThis.__memoryStore = memoryStore

  // 工作记忆：第二句 / 第三句任务各一条（同 turn）
  await working.writeWorkingTasks('bot-a', [
    { id: 'task-2', title: '第二句任务', status: 'active', steps: [], facts: {}, artifacts: [], blockers: [], updatedAt: now - 4_500, provenance: { sessionId: 'pa-bot-v2-bot-a', turn: 2, userMessageId: 'u2' } },
    { id: 'task-3', title: '第三句任务', status: 'active', steps: [], facts: {}, artifacts: [], blockers: [], updatedAt: now - 2_200, provenance: { sessionId: 'pa-bot-v2-bot-a', turn: 2, userMessageId: 'u3' } },
  ])

  const ctx = { __agent: { session }, get(name) { return name === 'sessions' ? { flush: async () => true } : undefined } }
  const result = await recallBotTurn(ctx, { botId: 'bot-a' }, '第二句', now - 5_000, 'u2')

  console.log('\n[recallBotTurn · steer 同 turn]')
  check('撤回成功', () => assert.equal(result.ok, true))
  check('识别到 turn=2', () => assert.equal(result.turn, 2))
  check('按消息 id 定位（u2）', () => assert.equal(result.userMessageId, 'u2'))
  check('记忆只删第二句两条', () => assert.equal(result.memoriesRemoved, 2))
  check('第三句记忆保留', () => {
    const ids = new Set(memoryStore.entries.map(entry => entry.id))
    assert.equal(ids.has('mem-2-extract'), false)
    assert.equal(ids.has('mem-2-manual'), false)
    assert.equal(ids.has('mem-3-extract'), true)
    assert.equal(ids.has('mem-3-manual'), true)
  })
  const tasks = await working.readWorkingTasks('bot-a')
  check('第三句任务仍在（工作记忆）', () => assert.equal(tasks.some(task => task.id === 'task-3'), true))
  check('第二句任务已删（工作记忆）', () => assert.equal(tasks.some(task => task.id === 'task-2'), false))
  const replace = log.find(event => event.type === 'user/message' && event.surfaceOp !== undefined)
  check('replace 覆盖第二句区间', () => {
    assert.equal(replace.surfaceOp.op, 'replace')
    assert.equal(replace.surfaceOp.startSeq, u2)
    assert.equal(replace.surfaceOp.endSeq, a2)
  })
  check('replace 不碰第三句', () => assert.equal([replace.surfaceOp.startSeq, replace.surfaceOp.endSeq].includes(u3), false))
  /*
   * 2026-11-07 回归锁：撤回节点必须是 user/message 且**不带 turn/step**。
   * 以前写成 developer/message 时，撤回「发完还没被回复」的消息会写出 step: 0，
   * v4 格式校验随后抛 `developer/message step must be positive`，整轮直接失败。
   */
  check('撤回占位是 user/message 且不带 turn/step', () => {
    assert.equal(replace.type, 'user/message')
    assert.equal(replace.data.role, 'user')
    assert.equal(Object.hasOwn(replace.data, 'turn'), false)
    assert.equal(Object.hasOwn(replace.data, 'step'), false)
    assert.equal(replace.data.source.kind, 'plugin:dsh-seeker-bot')
  })
} finally {
  rmSync(outdir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n[recall-host] ${failed} 项失败`)
  process.exit(1)
}
console.log('\n[recall-host] PASS')
