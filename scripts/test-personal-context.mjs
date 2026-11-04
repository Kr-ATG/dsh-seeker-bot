#!/usr/bin/env node
/**
 * Personal Agent「上下文占用」自测。
 *
 * 三层检查：
 *  1. **host 行为**：getBotContextPressure 的正常值（四舍五入、会话透传）、
 *     缺 tokenMeter 服务 / 无会话 / 投影异常 / 无效数值 → null（不抛）；
 *  2. **源码接线**：agent.ts 导出 getBotContextPressure（agentCache 优先 / registry
 *     兜底 / ctx.get + ctx.tokenMeter），index.ts 的 GET /context 路由与 health 登记；
 *  3. **esbuild 冒烟**：把 agent.ts 打包成临时 ESM 模块，产物能 import 且函数可调用。
 *
 * 用项目自带 esbuild（与 test-personal-relay.mjs 同一手法）；不依赖 lib/ 构建产物。
 *
 * Usage: node scripts/test-personal-context.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-context-build-'))
const HOME = mkdtempSync(join(tmpdir(), 'pa-context-home-'))
process.env.DSH_HOME = HOME

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 构造只暴露被 mock 服务的 ctx。
 * @param {object} options
 * @param {any} [options.tokenMeter] ctx.get('tokenMeter') 的返回值
 * @param {any} [options.agents]     ctx.get('agents') 的返回值
 * @param {any} [options.direct]     ctx.tokenMeter 属性（模拟宿主直接挂服务）
 * @param {boolean} [options.hasGet] 是否提供 ctx.get（false = 只有属性访问路径）
 */
function makeCtx({ tokenMeter = undefined, agents = undefined, direct = undefined, hasGet = true } = {}) {
  const ctx = {}
  if (hasGet) {
    ctx.get = (name) => {
      if (name === 'tokenMeter') return tokenMeter
      if (name === 'agents') return agents
      return undefined
    }
  }
  if (agents !== undefined) ctx.agents = agents
  if (direct !== undefined) ctx.tokenMeter = direct
  return ctx
}

function registryOf(map) {
  return {
    get(sessionId) {
      return map[sessionId]
    },
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
  const agent = await import(pathToFileURL(join(OUT, 'agent.mjs')).href)

  /* ───────────────── host · getBotContextPressure ───────────────── */

  console.log('\n[host · getBotContextPressure]')
  const SESSION_ID = 'pa-bot-v2-bot-a'
  let seenSession = null
  const normalMeter = {
    contextPressure(session) {
      seenSession = session
      return { pressureTokens: 123456.7, contextWindow: 1_000_000 }
    },
  }
  const normalAgent = { session: { id: SESSION_ID } }
  const normalRegistry = registryOf({ [SESSION_ID]: normalAgent })

  check('正常值：四舍五入为整数、会话原样透传', () => {
    const result = agent.getBotContextPressure(makeCtx({ tokenMeter: normalMeter, agents: normalRegistry }), 'bot-a')
    assert.deepEqual(result, { usedTokens: 123457, contextWindow: 1_000_000 })
    assert.equal(seenSession, normalAgent.session, 'contextPressure 应收到 agent.session')
  })

  check('缺 tokenMeter 服务 → null', () => {
    assert.equal(agent.getBotContextPressure(makeCtx({ agents: normalRegistry }), 'bot-a'), null)
  })

  check('tokenMeter 没有 contextPressure 方法 → null', () => {
    const meter = { someOtherMethod() {} }
    assert.equal(agent.getBotContextPressure(makeCtx({ tokenMeter: meter, agents: normalRegistry }), 'bot-a'), null)
  })

  check('无会话（registry 没有该 bot）→ null', () => {
    assert.equal(agent.getBotContextPressure(makeCtx({ tokenMeter: normalMeter, agents: registryOf({}) }), 'bot-a'), null)
  })

  check('没有 agents 服务 → null', () => {
    assert.equal(agent.getBotContextPressure(makeCtx({ tokenMeter: normalMeter }), 'bot-a'), null)
  })

  check('contextPressure 抛异常 → null（不抛穿）', () => {
    const meter = {
      contextPressure() {
        throw new Error('projection broken')
      },
    }
    assert.equal(agent.getBotContextPressure(makeCtx({ tokenMeter: meter, agents: normalRegistry }), 'bot-a'), null)
  })

  check('agents.get 抛异常 → null（不抛穿）', () => {
    const agents = {
      get() {
        throw new Error('registry down')
      },
    }
    assert.equal(agent.getBotContextPressure(makeCtx({ tokenMeter: normalMeter, agents }), 'bot-a'), null)
  })

  check('字段缺失 / NaN / 非有限 / contextWindow<=0 → null', () => {
    const cases = [
      { pressureTokens: undefined, contextWindow: 1000 },
      { pressureTokens: 100, contextWindow: undefined },
      { pressureTokens: Number.NaN, contextWindow: 1000 },
      { pressureTokens: 100, contextWindow: 0 },
      { pressureTokens: 100, contextWindow: -1 },
      { pressureTokens: Number.POSITIVE_INFINITY, contextWindow: 1000 },
      { pressureTokens: 100, contextWindow: Number.NaN },
      { pressureTokens: 100, contextWindow: Number.POSITIVE_INFINITY },
    ]
    for (const value of cases) {
      const meter = { contextPressure() { return value } }
      assert.equal(
        agent.getBotContextPressure(makeCtx({ tokenMeter: meter, agents: normalRegistry }), 'bot-a'),
        null,
        JSON.stringify(value),
      )
    }
  })

  check('ctx.get 缺失时用 ctx.tokenMeter 属性兜底', () => {
    const ctx = makeCtx({ agents: normalRegistry, direct: normalMeter, hasGet: false })
    assert.deepEqual(agent.getBotContextPressure(ctx, 'bot-a'), { usedTokens: 123457, contextWindow: 1_000_000 })
  })

  check('ctx.get 返回 null 时回落到 ctx.tokenMeter 属性', () => {
    const ctx = makeCtx({ tokenMeter: null, agents: normalRegistry, direct: normalMeter })
    assert.deepEqual(agent.getBotContextPressure(ctx, 'bot-a'), { usedTokens: 123457, contextWindow: 1_000_000 })
  })

  check('botId 参与会话 id 清洗（不同 bot 不串数据）', () => {
    const meter = {
      contextPressure() {
        return { pressureTokens: 1, contextWindow: 100 }
      },
    }
    assert.equal(agent.getBotContextPressure(makeCtx({ tokenMeter: meter, agents: normalRegistry }), 'other'), null)
  })

  /* ───────────────── 源码接线断言 ───────────────── */

  console.log('\n[源码接线]')
  const agentSource = readFileSync(join(HERE, 'src/host/personal/agent.ts'), 'utf8')
  const indexSource = readFileSync(join(HERE, 'src/host/personal/index.ts'), 'utf8')

  check('agent.ts 导出 getBotContextPressure 且 agentCache 优先 / registry 兜底', () => {
    assert.ok(agentSource.includes('export function getBotContextPressure('), '未导出 getBotContextPressure')
    const start = agentSource.indexOf('export function getBotContextPressure(')
    const body = agentSource.slice(start, start + 2000)
    assert.ok(body.includes('agentCache.get(sessionId)?.agent'), '没有优先读 agentCache')
    assert.ok(body.includes("agents.get(sessionId)"), '没有 registry.get 兜底')
    assert.ok(body.includes("ctx.get('tokenMeter')"), '没有 ctx.get(tokenMeter)')
    assert.ok(body.includes('ctx?.tokenMeter'), '没有 ctx.tokenMeter 兜底')
    assert.ok(body.includes('Number.isFinite'), '没有数值有限性校验')
  })

  check('index.ts 注册 GET /context 并调用 getBotContextPressure', () => {
    assert.ok(indexSource.includes('getBotContextPressure'), 'index.ts 没引用 getBotContextPressure')
    assert.ok(indexSource.includes("(tail === '/context' || tail === '/context/') && method === 'GET'"), '缺少 GET /context 路由')
    assert.ok(indexSource.includes('getBotContextPressure(webCtx, botId)'), '路由没调用 getBotContextPressure')
    assert.ok(indexSource.includes('if (botId === \'\') return sendJson(res, 400, { ok: false, error: \'botId required\' })'), '缺少 botId 必填校验')
    assert.ok(indexSource.includes('return sendJson(res, 200, { ok: true, usage })'), '缺少 ok:true + usage 返回')
  })

  check('index.ts percent 一位小数且 0-100 钳制', () => {
    assert.ok(indexSource.includes('Math.max(0, Math.min(100, ratio))'), 'percent 没有 0-100 钳制')
    assert.ok(indexSource.includes('Math.round(Math.max(0, Math.min(100, ratio)) * 10) / 10'), 'percent 没有保留一位小数')
  })

  check('index.ts health routes 登记 context', () => {
    const healthIndex = indexSource.indexOf("tail === '/health'")
    assert.ok(healthIndex >= 0, '找不到 /health 分支')
    const healthBlock = indexSource.slice(healthIndex, healthIndex + 1500)
    assert.ok(healthBlock.includes("'context'"), 'health routes 缺少 context')
  })

  /* ───────────────── esbuild 冒烟 ───────────────── */

  console.log('\n[esbuild 冒烟]')
  await checkAsync('agent.ts 打包产物导出 getBotContextPressure 且可调用', async () => {
    assert.equal(typeof agent.getBotContextPressure, 'function')
    const result = agent.getBotContextPressure(
      makeCtx({ tokenMeter: normalMeter, agents: normalRegistry }),
      'bot-a',
    )
    assert.deepEqual(result, { usedTokens: 123457, contextWindow: 1_000_000 })
  })
} finally {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n[personal-context] ${failed} 项失败`)
  process.exit(1)
}
console.log(`\n[personal-context] PASS（${passed} 项）`)
