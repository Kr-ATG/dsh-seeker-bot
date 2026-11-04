#!/usr/bin/env node
/**
 * Personal Agent「删除 Bot」清理自测。
 *
 * 背景（2026-11-04 用户实测）：删掉子 Bot 后，会话目录清了，但 gallery 状态、
 * 会话代数、tool-results、relay/history 摘要、产出物映射、派活任务记录都还在；
 * 前端「历史对话」里也留着一条孤儿归档。这个用例用真实临时 DSH_HOME 构造这些
 * 残留，调用真实 purgeBot，逐项断言删干净 + 幂等。
 *
 * Usage: node scripts/test-personal-bot-purge.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-purge-build-'))
const HOME = mkdtempSync(join(tmpdir(), 'pa-purge-home-'))
const WORKSPACE = mkdtempSync(join(tmpdir(), 'pa-purge-work-'))
process.env.DSH_HOME = HOME
process.env.DSH_SEEKER_BOT_WORKSPACE = WORKSPACE

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
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

const BOT = 'bot-purge-test'
const SESSION = 'pa-bot-v2-' + BOT

function write(file, text) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

try {
  await build({
    entryPoints: [join(HERE, 'src/host/personal/bot-delete.ts')],
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  })
  const host = await import(pathToFileURL(join(OUT, 'bot-delete.mjs')).href)

  // ── fixture ──────────────────────────────────────────────────────────
  const sessionsRoot = join(HOME, 'sessions', '--D-Seeker-Bot--')
  for (const name of [SESSION, SESSION + '-g1', SESSION + '-g2']) {
    write(join(sessionsRoot, name, 'session.v4.jsonl.zstd'), 'fixture')
  }
  write(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'session-generations.json'), JSON.stringify({ [BOT]: 3 }))
  write(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'relay', BOT + '.json'), '{"brief":1}')
  write(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'history', BOT + '.json'), '{"messages":[]}')
  write(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'working-memory', BOT + '.json'), '{"tasks":[]}')
  write(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'tool-results', SESSION + '-g1', 'out.txt'), 'tool result')
  write(join(HOME, 'storages', 'triad-gallery', SESSION + '.json'), '{"state":{}}')
  write(join(HOME, 'storages', 'triad-gallery', SESSION + '-g1.json'), '{"state":{}}')
  write(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'bot-output-dirs.json'), JSON.stringify({ version: 1, bots: { [BOT]: 'PurgeTest' } }))

  await checkAsync('purgeBot 清掉会话目录（所有代数）', async () => {
    const result = await host.purgeBot(BOT)

    globalThis.__DEBUG_RESULT__ = result
    assert.equal(result.ok, true, JSON.stringify(result))
    for (const name of [SESSION, SESSION + '-g1', SESSION + '-g2']) {
      assert.equal(existsSync(join(sessionsRoot, name)), false, '会话目录未删：' + name)
    }
    assert.ok(result.removed.includes('会话历史'))
  })

  check('gallery / 代数 / relay / history / tool-results / 产出物映射 / 工作记忆都清掉', () => {
    assert.equal(existsSync(join(HOME, 'storages', 'triad-gallery', SESSION + '.json')), false, 'gallery 基础状态未删')
    assert.equal(existsSync(join(HOME, 'storages', 'triad-gallery', SESSION + '-g1.json')), false, 'gallery -g1 状态未删')
    assert.equal(existsSync(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'relay', BOT + '.json')), false, 'relay 摘要未删')
    assert.equal(existsSync(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'history', BOT + '.json')), false, 'history 索引未删')
    assert.equal(existsSync(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'tool-results', SESSION + '-g1')), false, 'tool-results 未删')
    assert.equal(existsSync(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'working-memory', BOT + '.json')), false, '工作记忆未删')
    const map = JSON.parse(readFileSync(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'bot-output-dirs.json'), 'utf8'))
    assert.equal(Object.hasOwn(map.bots, BOT), false, '产出物映射未删')
    const generations = JSON.parse(readFileSync(join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'session-generations.json'), 'utf8'))
    assert.equal(Object.hasOwn(generations, BOT), false, '会话代数未删')
  })

  await checkAsync('幂等：第二次调用不再报错、没有可删项', async () => {
    const again = await host.purgeBot(BOT)
    assert.equal(again.ok, true)
    assert.equal(again.removed.length, 0, JSON.stringify(again.removed))
  })

  await checkAsync('主 Bot 拒绝删除', async () => {
    const result = await host.purgeBot('bot-main-xiaomo')
    assert.equal(result.ok, false)
    assert.match(String(result.error), /主 Bot/)
  })

  const botDeleteSource = readFileSync(join(HERE, 'src/host/personal/bot-delete.ts'), 'utf8')
  check('源码接线：gallery / tool-results / relay / history / 代数都出现在 purgeBot', () => {
    for (const marker of ['triad-gallery', 'tool-results', 'relay', 'history', 'forgetBotSessionGeneration', 'personalRuntime']) {
      assert.ok(botDeleteSource.includes(marker), '缺少 ' + marker)
    }
  })
  const runtimeSource = readFileSync(join(HERE, 'src/host/personal/runtime/store.ts'), 'utf8')
  check('RuntimeStore 提供 forgetBot', () => {
    assert.ok(runtimeSource.includes('forgetBot(botId: string): number'))
  })
  const hostSource = readFileSync(join(HERE, 'src/host/personal/runtime/host.ts'), 'utf8')
  check('host 注册 forgetBot', () => {
    assert.ok(hostSource.includes('forgetBot: (botId) => store.forgetBot(botId)'))
  })
  const storeSource = readFileSync(join(HERE, 'src/client/personal/store.tsx'), 'utf8')
  check('前端删除 Bot 时清历史对话归档', () => {
    assert.ok(storeSource.includes('archivedSessions: prev.archivedSessions.filter((session) => session.botId !== id)'))
  })

  console.log('')
  if (failed === 0) console.log('BOT PURGE VERIFY PASSED (' + String(passed) + ' 项)')
  else { console.log('BOT PURGE VERIFY FAILED (' + String(failed) + ')'); process.exitCode = 1 }
} finally {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WORKSPACE, { recursive: true, force: true })
}
