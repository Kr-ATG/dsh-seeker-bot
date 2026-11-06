#!/usr/bin/env node
/**
 * Personal Agent 错误提示详情自测。
 *
 * 用户明确要求（2026-11-06）：Bot 聊天里报「本轮被宿主拒绝（pre-step blocked）：
 * 会话状态异常」时，必须显示具体异常，而不是一句笼统话术。
 *
 * 覆盖：
 *  - toUserFacingError 保留 provider 错误原文（message / code），不再只给中文概括；
 *  - describeBlockedTurn 能把 turn/end.reason、会话 header、归档态、pre-step 探针
 *    结果和事件序列拼成可排查的诊断；
 *  - blocked 分支必须接线到 describeBlockedTurn，且旧的笼统话术不再出现。
 *
 * Usage: node scripts/test-personal-error-detail.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-error-detail-'))

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

  check('404 模型不存在：保留 message 与 code', () => {
    const text = host.toUserFacingError('404: {"code":"UNKNOWN_MODEL","message":"magpie knows no model \\"group/auto-qfmodel\\"; did you mean auto/deepseek-v4.1-flash?"}')
    assert.match(text, /模型或接口不存在（404）/)
    assert.match(text, /magpie knows no model/)
    assert.match(text, /UNKNOWN_MODEL/)
  })

  check('400 参数非法：保留 MaxTokens 细节与错误码', () => {
    const text = host.toUserFacingError('400: {"message":"field MaxTokens invalid, should be in [1, 131072]","type":"invalid_request_error","param":"max_tokens","code":"3"}')
    assert.match(text, /具体异常/)
    assert.match(text, /错误码 400/)
    assert.match(text, /MaxTokens invalid/)
    assert.match(text, /\[3\]/)
  })

  check('未知英文错误：原文不再被吞', () => {
    const text = host.toUserFacingError('Something exploded in listener chain')
    assert.match(text, /Something exploded in listener chain/)
  })

  check('中文错误保持原样', () => {
    assert.equal(host.toUserFacingError('无法连接该 Bot 的会话：timeout'), '无法连接该 Bot 的会话：timeout')
  })

  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { archivedSessionIds: ['pa-bot-v2-bot-x'] }
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
  }
  const agent = { session: { header: { id: 'pa-bot-v2-bot-x', origin: 'subagent', delegationDepth: 0 } } }

  check('blocked 诊断：明确说出已归档而不是「会话状态异常」', () => {
    const detail = host.describeBlockedTurn(ctx, agent, 'pa-bot-v2-bot-x', {
      events: ['turn/start', 'turn/end'],
      turnEnd: { reason: { kind: 'blocked' } },
      preStep: { seen: true, rejected: true },
    })
    assert.match(detail, /已被归档/)
    assert.match(detail, /turn\/end\.reason=\{"kind":"blocked"\}/)
    assert.match(detail, /pre-step 阶段被下游监听器拒绝/)
    assert.match(detail, /turn\/start → turn\/end/)
  })

  check('blocked 诊断：pre-step 探针异常会显示原文', () => {
    const detail = host.describeBlockedTurn(ctx, agent, 'pa-bot-v2-bot-x', {
      events: [],
      turnEnd: { reason: { kind: 'blocked' } },
      preStep: { seen: true, rejected: false, error: 'boom: listener failed' },
    })
    assert.match(detail, /pre-step 监听器抛出异常：boom: listener failed/)
  })

  /*
   * 集成：用 fake agent 跑真实的 runBotTurn blocked 分支，确认用户看到的
   * 错误文本不再是「会话状态异常」，而是带 turn/end 原始 reason 与会话 header。
   */
  const HOME = mkdtempSync(join(tmpdir(), 'pa-error-home-'))
  process.env.DSH_HOME = HOME
  const sessionId = 'pa-bot-v2-test-error'
  const listeners = new Set()
  const fakeSession = {
    id: sessionId,
    header: { id: sessionId, origin: 'subagent', delegationDepth: 0 },
    append() {},
  }
  let seq = 0
  const fakeAgent = {
    session: fakeSession,
    status: 'idle',
    ctx: {
      on(type, handler) {
        if (type !== 'session/event') return () => {}
        listeners.add(handler)
        return () => { listeners.delete(handler) }
      },
    },
    model: { select() {} },
    followup() {
      const emit = (type, data) => {
        seq += 1
        for (const handler of [...listeners]) handler(fakeSession, { seq, type, time: Date.now(), data })
      }
      emit('turn/start', { turn: 1 })
      emit('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    },
  }
  const runtimeCtx = {
    agents: { get() { return fakeAgent } },
    on() { return () => {} },
    get() { return undefined },
  }
  const spec = { botId: 'test-error', name: '测试 Bot', role: '测试', description: '', instructions: '', model: { provider: 'test', model: 'test' } }

  const blockedResult = await host.runBotTurn(runtimeCtx, spec, '你好', () => {})
  check('runBotTurn blocked：错误文本带具体 reason 与会话 header', () => {
    assert.equal(blockedResult.ok, false)
    assert.match(String(blockedResult.error), /本轮被宿主拒绝（pre-step blocked）/)
    assert.match(String(blockedResult.error), /turn\/end\.reason=\{"kind":"blocked"\}/)
    assert.match(String(blockedResult.error), /id=pa-bot-v2-test-error/)
    assert.match(String(blockedResult.error), /origin=subagent/)
  })
  rmSync(HOME, { recursive: true, force: true })

  const agentSource = readFileSync(join(HERE, 'src/host/personal/agent.ts'), 'utf8')
  check('blocked 分支接线到 describeBlockedTurn', () => {
    assert.ok(agentSource.includes("reason === 'blocked'"))
    assert.ok(agentSource.includes('describeBlockedTurn(ctx, agent, sessionId, debug)'))
    assert.ok(!agentSource.includes('本轮被宿主拒绝（pre-step blocked）：会话状态异常，建议重启 DSH 或重建该 Bot 会话'))
  })

  const vaultSource = readFileSync(join(HERE, 'src/triad/vault/inject.ts'), 'utf8')
  const memorySource = readFileSync(join(HERE, 'src/triad/memory/engine/inject.ts'), 'utf8')
  check('vault / memory 不再把 next() 异常吞成 reject', () => {
    const vaultBlock = vaultSource.slice(vaultSource.indexOf('async preStepListener'), vaultSource.indexOf('async preStepListener') + 3000)
    const memoryBlock = memorySource.slice(memorySource.indexOf('const preStepListener'), memorySource.indexOf('const preStepListener') + 2000)
    assert.ok(!/catch \(error\)[\s\S]{0,500}return \{ kind: 'reject' \}/.test(vaultBlock), 'vault 仍在把 next() 异常吞成 reject')
    assert.ok(!/catch \(error\)[\s\S]{0,500}return \{ kind: 'reject' \}/.test(memoryBlock), 'memory 仍在把 next() 异常吞成 reject')
    assert.ok(/throw error/.test(vaultBlock), 'vault next() 异常没有上抛')
    assert.ok(/throw error/.test(memoryBlock), 'memory next() 异常没有上抛')
  })

  console.log('')
  if (failed === 0) console.log('PERSONAL ERROR DETAIL VERIFY PASSED (' + String(passed) + ' 项)')
  else { console.log('PERSONAL ERROR DETAIL VERIFY FAILED (' + String(failed) + ')'); process.exitCode = 1 }
} finally {
  rmSync(OUT, { recursive: true, force: true })
}
