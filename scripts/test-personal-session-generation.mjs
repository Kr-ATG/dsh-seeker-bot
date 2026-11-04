#!/usr/bin/env node
/**
 * Personal Agent「会话代数」自测。
 *
 * 背景：每次「整理并开新会话」给 Bot 分配新的一代会话 id（pa-bot-v2-<botId>-gN），
 * 旧会话文件保留为历史归档。这样即使宿主 registry 里还留着没有 dispose 句柄的
 * 旧 agent，新会话也不会撞同一个 id、不会 pre-step blocked。
 *
 * 覆盖：0 代命名、bump 新旧 id、连续 bump、Bot 隔离、落盘后重载保持；
 * 以及源码接线（resetBotConversation 调 bump、不再删会话目录；bot-delete 按前缀清
 * 所有代；前端自动整理前检查 pending）。
 *
 * Usage: node scripts/test-personal-session-generation.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-gen-build-'))
const HOME = mkdtempSync(join(tmpdir(), 'pa-gen-home-'))
process.env.DSH_HOME = HOME

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

try {
  await build({
    entryPoints: [join(HERE, 'src/host/personal/agent.ts')],
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  })
  const host = await import(pathToFileURL(join(OUT, 'agent.mjs')).href)

  check('0 代会话 id 是 pa-bot-v2-<botId>', () => {
    assert.equal(host.botSessionId('bot-gen'), 'pa-bot-v2-bot-gen')
  })

  check('bump 返回旧 id 与新 id', () => {
    const result = host.bumpBotSessionGeneration('bot-gen')
    assert.deepEqual(result, { from: 'pa-bot-v2-bot-gen', to: 'pa-bot-v2-bot-gen-g1' })
    assert.equal(host.botSessionId('bot-gen'), 'pa-bot-v2-bot-gen-g1')
  })

  check('连续 bump 递增代数', () => {
    const result = host.bumpBotSessionGeneration('bot-gen')
    assert.equal(result.from, 'pa-bot-v2-bot-gen-g1')
    assert.equal(result.to, 'pa-bot-v2-bot-gen-g2')
  })

  check('不同 Bot 的代数互相隔离', () => {
    assert.equal(host.botSessionId('bot-other'), 'pa-bot-v2-bot-other')
    host.bumpBotSessionGeneration('bot-other')
    assert.equal(host.botSessionId('bot-other'), 'pa-bot-v2-bot-other-g1')
    assert.equal(host.botSessionId('bot-gen'), 'pa-bot-v2-bot-gen-g2')
  })

  check('代数已落盘', () => {
    const file = join(HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'session-generations.json')
    assert.ok(existsSync(file), '代数文件不存在')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(parsed['bot-gen'], 2)
    assert.equal(parsed['bot-other'], 1)
  })

  check('清空缓存后重新读盘仍保持代数', () => {
    host.resetSessionGenerationsCacheForTest()
    assert.equal(host.botSessionId('bot-gen'), 'pa-bot-v2-bot-gen-g2')
  })

  const agentSource = readFileSync(join(HERE, 'src/host/personal/agent.ts'), 'utf8')
  const resetStart = agentSource.indexOf('export async function resetBotConversation')
  const resetBlock = agentSource.slice(resetStart, resetStart + 5000)
  check('resetBotConversation 使用 bumpBotSessionGeneration', () => {
    assert.ok(resetBlock.includes('bumpBotSessionGeneration(botId)'))
  })
  check('resetBotConversation 不再删除会话目录（旧会话保留为历史）', () => {
    assert.ok(!resetBlock.includes('sessionDirsFor(sessionId)'), '仍在按 sessionId 删除会话目录')
    assert.ok(!resetBlock.includes('rmSync(dir'), '仍在 rmSync 会话目录')
  })

  const botDeleteSource = readFileSync(join(HERE, 'src/host/personal/bot-delete.ts'), 'utf8')
  check('bot-delete 按前缀清理所有代的会话目录', () => {
    assert.ok(botDeleteSource.includes('name.startsWith(`${base}-g`)'))
  })

  const storeSource = readFileSync(join(HERE, 'src/client/personal/store.tsx'), 'utf8')
  check('前端自动整理前检查进行中的回复', () => {
    assert.ok(storeSource.includes('有回复正在进行，稍后再自动整理'))
    assert.ok(storeSource.includes("stateRef.current.messages.some((message) => message.pending === true)"))
  })

  console.log('')
  if (failed === 0) console.log('SESSION GENERATION VERIFY PASSED (' + String(passed) + ' 项)')
  else { console.log('SESSION GENERATION VERIFY FAILED (' + String(failed) + ')'); process.exitCode = 1 }
} finally {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}
