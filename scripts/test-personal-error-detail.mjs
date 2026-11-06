#!/usr/bin/env node
/**
 * Personal Agent 错误提示详情自测。
 *
 * 用户明确要求（2026-11-06）：Bot 聊天里报「本轮被宿主拒绝（pre-step blocked）：
 * 会话状态异常」时，必须显示具体异常，而不是一句笼统话术。
 *
 * 覆盖：
 *  - toUserFacingError 把常见 provider 错误翻译成**中文**具体原因（模型名等专有
 *    标识保留），界面不出现英文句子；
 *  - describeBlockedTurn 用中文说清会话状态、归档态、步骤前置检查结果与事件序列；
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

  check('404 模型不存在：翻译成中文且保留模型标识', () => {
    const text = host.toUserFacingError('404: {"code":"UNKNOWN_MODEL","message":"magpie knows no model \\"group/auto-qfmodel\\"; did you mean auto/deepseek-v4.1-flash?"}')
    assert.match(text, /模型不存在或未配置/)
    assert.match(text, /group\/auto-qfmodel/)
    assert.ok(!/knows no model/i.test(text), '界面仍出现英文原文：' + text)
  })

  check('400 参数非法：翻译成中文且指出字段与范围', () => {
    const text = host.toUserFacingError('400: {"message":"field MaxTokens invalid, should be in [1, 131072]","type":"invalid_request_error","param":"max_tokens","code":"3"}')
    assert.match(text, /具体异常/)
    assert.match(text, /错误码 400/)
    assert.match(text, /参数 MaxTokens 取值非法/)
    assert.match(text, /1, 131072/)
    assert.ok(!/should be in|invalid/i.test(text), '界面仍出现英文原文：' + text)
  })

  check('模型未配置：翻译成中文', () => {
    const text = host.toUserFacingError('pi-ai provider "sensenova" has no configured model "sensenova-6.8-flash-lite"')
    assert.match(text, /模型提供方 sensenova 未配置模型 sensenova-6\.8-flash-lite/)
    assert.ok(!/provider|configured model/i.test(text), '界面仍出现英文原文：' + text)
  })

  check('未知英文错误：给中文兜底，不贴英文原文', () => {
    const text = host.toUserFacingError('Something exploded in listener chain')
    assert.match(text, /模型调用失败/)
    assert.ok(!/Something exploded/i.test(text), '界面仍出现英文原文：' + text)
  })

  check('中文错误保留中文主体，夹带的英文异常翻成中文', () => {
    const text = host.toUserFacingError('无法连接该 Bot 的会话：timeout')
    assert.match(text, /无法连接该 Bot 的会话：/)
    assert.match(text, /模型请求超时/)
    assert.ok(!/timeout/i.test(text), '界面仍出现英文原文：' + text)
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

  check('blocked 诊断：中文说出已归档而不是「会话状态异常」', () => {
    const detail = host.describeBlockedTurn(ctx, agent, 'pa-bot-v2-bot-x', {
      events: ['turn/start', 'turn/end'],
      turnEnd: { reason: { kind: 'blocked' } },
      preStep: { seen: true, rejected: true },
    })
    assert.match(detail, /已被归档/)
    assert.match(detail, /宿主未提供拒绝原因/)
    assert.match(detail, /步骤前置检查被下游插件拒绝/)
    assert.match(detail, /回合开始 → 回合结束/)
    assert.ok(!/turn\/|reason=|origin=/i.test(detail), 'blocked 诊断仍出现英文技术串：' + detail)
  })

  check('blocked 诊断：步骤前置检查异常也翻译成中文', () => {
    const detail = host.describeBlockedTurn(ctx, agent, 'pa-bot-v2-bot-x', {
      events: [],
      turnEnd: { reason: { kind: 'blocked' } },
      preStep: { seen: true, rejected: false, error: 'boom: listener failed' },
    })
    assert.match(detail, /步骤前置检查抛出异常：上游返回未知错误（详情见宿主日志）/)
    assert.ok(!/boom|listener failed/i.test(detail), 'blocked 诊断仍出现英文原文：' + detail)
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
  check('runBotTurn blocked：错误文本为中文且带具体会话信息', () => {
    assert.equal(blockedResult.ok, false)
    assert.match(String(blockedResult.error), /本轮被宿主拒绝（pre-step blocked）/)
    assert.match(String(blockedResult.error), /宿主未提供拒绝原因/)
    assert.match(String(blockedResult.error), /会话标识 pa-bot-v2-test-error/)
    assert.match(String(blockedResult.error), /来源：子代理会话/)
    assert.match(String(blockedResult.error), /回合开始 → 回合结束/)
    assert.ok(!/turn\/end|origin=|id=/.test(String(blockedResult.error)), '仍出现英文技术串：' + String(blockedResult.error))
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
