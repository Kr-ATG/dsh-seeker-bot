/**
 * 工具 `output.render` 的契约回归测试。
 *
 * ## 为什么专门测这个
 *
 * 2026-11-03 那次「创建一个互联网营销bot」里，`bot_emit` 与 `bot_create` 的返回值
 * 在 PTC（`run_code` 里的 `tools.xxx()`）回传时全部抛
 * `ToolCallError: content.some is not a function`：
 *
 *  - 宿主 `dsh-tools` 的 `createSuccessResult` 把 `output.render(args, value)` 的
 *    返回值**原样**当成 `content`（`snapshotProjection` 只做 JSON 快照，不校验形状）；
 *  - PTC 执行器在 `commit` 里对 `result.content` 调 `.some()` 找图片块；
 *  - 于是 `render` 只要返回字符串而不是 `ContentBlock[]`，那一次工具调用就必然报错。
 *
 * 更隐蔽的是参数错位：`render` 的签名是 `(args, value)`，只写一个参数时拿到的是
 * **arguments** 而不是执行结果，`result.ok` 恒为 `undefined`，文案会永远走失败分支。
 *
 * 这两点都不会在正常路径上冒烟（宿主侧只对 PTC 调用做 `.some()`），所以必须有
 * 回归测试钉住：**返回数组** + **读第二个参数**。
 *
 * ## 断言口径
 *
 * 对每个工具定义：
 *  1. `render` 是函数；
 *  2. 返回值是数组，元素是 `{ type: 'text', text: string }`；
 *  3. 文案取自 `value`（第二个参数）——用一个「args 里没有、value 里才有」的
 *     字段区分：读错参数时文案会退化成兜底句；
 *  4. 成功 / 失败 / 特殊分支各自的文案。
 *
 * 另附一条静态断言：前端认领「正在输入」占位时会把消息挪到队尾（消息顺序回归）。
 *
 * Usage: node scripts/test-tool-output-render.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
const pass = (msg) => console.log('ok    ' + msg)
const fail = (msg) => { console.error('FAIL  ' + msg); failed += 1 }
const assert = (cond, msg) => { if (cond) pass(msg); else fail(msg) }

/** Windows 路径 → import URL 可用的正斜杠形式。 */
const slash = (p) => p.replace(/[\\]/g, '/')

/** 所有由本插件自注册、且会被模型在 PTC 下调用的工具。 */
const EXPECTED = ['bot_emit', 'task_state', 'bot_create', 'coordinate_bots']

const outDir = mkdtempSync(join(tmpdir(), 'dsh-tool-render-'))
let mod

try {
  const entry = join(outDir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export { installBotEmitTool, installTaskStateTool } from '${slash(resolve(ROOT, 'src/host/personal/agent.ts'))}'`,
      `export { installBotCreateTool } from '${slash(resolve(ROOT, 'src/host/personal/bot-create.ts'))}'`,
      `export { installCoordinateTool } from '${slash(resolve(ROOT, 'src/host/personal/runtime/coordinate.ts'))}'`,
      `export { relocateToEnd } from '${slash(resolve(ROOT, 'src/client/personal/chat/message-order.ts'))}'`,
      '',
    ].join('\n'),
    'utf8',
  )
  const bundleFile = join(outDir, 'tool-render.mjs')
  await build({
    entryPoints: [entry],
    outfile: bundleFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  })
  mod = await import(pathToFileURL(bundleFile).href)
} catch (error) {
  console.error('打包失败：', error instanceof Error ? error.message : error)
  process.exit(1)
}

// ── 收集工具定义 ───────────────────────────────────────────────────────
/** 假 agentCtx：只截获 `tools.register` 的入参，不执行任何工具。 */
function capture(install) {
  const captured = []
  const agentCtx = {
    tools: {
      register(definition) {
        captured.push(definition)
        return () => {}
      },
    },
  }
  install(agentCtx)
  return captured
}

const definitions = new Map()
for (const definition of capture((ctx) => mod.installBotEmitTool(ctx, 'bot-main'))) definitions.set(definition.name, definition)
for (const definition of capture((ctx) => mod.installTaskStateTool(ctx, 'bot-main'))) definitions.set(definition.name, definition)
for (const definition of capture((ctx) => mod.installBotCreateTool(ctx, 'bot-main'))) definitions.set(definition.name, definition)
for (const definition of capture((ctx) => mod.installCoordinateTool(ctx, 'bot-main', () => []))) definitions.set(definition.name, definition)

console.log('\n# 注册齐全')
for (const name of EXPECTED) assert(definitions.has(name), `捕获到工具 ${name}`)
assert(definitions.size === EXPECTED.length, `没有多注册意料之外的工具（实际 ${definitions.size} 个）`)

// ── 通用契约 ───────────────────────────────────────────────────────────
console.log('\n# render 契约：返回 ContentBlock[]')

/** 断言一次 render 的输出形状与文案。 */
function check(name, args, value, expectedText) {
  const definition = definitions.get(name)
  if (definition === undefined) { fail(`${name} 没注册，跳过`); return }
  if (typeof definition.output?.render !== 'function') { fail(`${name} 缺 output.render`); return }
  let rendered
  try {
    rendered = definition.output.render(args, value)
  } catch (error) {
    fail(`${name} 的 render 抛错：${error instanceof Error ? error.message : error}`)
    return
  }
  /*
   * 形状：必须是数组。宿主把它原样当 content，PTC 执行器会对它调 `.some()`，
   * 字符串会直接抛 `content.some is not a function`。
   */
  if (!Array.isArray(rendered)) {
    fail(`${name} 的 render 返回了 ${typeof rendered}，必须是数组（PTC 下会 content.some 崩溃）`)
    return
  }
  pass(`${name} 的 render 返回数组`)
  const block = rendered[0]
  assert(
    block !== undefined && block.type === 'text' && typeof block.text === 'string',
    `${name} 的 render 产出 { type: 'text', text }`,
  )
  if (expectedText !== undefined) {
    const actual = block?.text ?? ''
    assert(
      actual === expectedText,
      `${name} 文案正确（期望 ${JSON.stringify(expectedText)}，实际 ${JSON.stringify(actual)}）`,
    )
  }
}

/*
 * args 里**故意不放** value 才有的字段：读错参数（把 args 当 value）时，
 * 文案会退化成兜底句，下面按精确文案断言就能抓住。
 */
const emitArgs = { kind: 'need-input', text: '要建哪一种？', options: ['A', 'B'] }
check('bot_emit', emitArgs, { ok: true, answer: 'A' }, '用户选择了：A')
check('bot_emit', emitArgs, { ok: true, decision: 'allowed' }, '用户允许了这次操作')
check('bot_emit', emitArgs, { ok: true, decision: 'rejected' }, '用户拒绝了这次操作，不要执行')
check('bot_emit', emitArgs, { ok: true }, '已播报')

const stateArgs = { id: 'task-1', title: '建 Bot' }
check('task_state', stateArgs, { ok: true, summary: '任务状态已更新' }, '任务状态已更新')
check('task_state', stateArgs, { ok: false, error: '写盘失败' }, '任务状态没记上：写盘失败')
check('task_state', stateArgs, { ok: true }, '已更新任务状态')

const createArgs = { name: '营销策划', role: '互联网营销' }
check('bot_create', createArgs, { ok: true, bot_id: 'bot-7c96fc34', name: '营销策划' }, '已创建子 Bot「营销策划」（bot-7c96fc34）')
check('bot_create', createArgs, { ok: false, error: '已经有一个叫「营销策划」的 Bot 了。' }, '创建失败：已经有一个叫「营销策划」的 Bot 了。')

const coordinateArgs = { bot_id: 'bot-other', message: '查一下竞品' }
check('coordinate_bots', coordinateArgs, { ok: true, duplicate: false }, '已经派出去了，你可以继续做别的')
check('coordinate_bots', coordinateArgs, { ok: true, duplicate: true }, '这件活刚才已经派过了，等它回来就行')
check('coordinate_bots', coordinateArgs, { ok: false, error: '没有这个 Bot' }, '派活失败：没有这个 Bot')

// ── 前端：认领占位后必须归位 ────────────────────────────────────────────
console.log('\n# 消息顺序：认领占位后归位')

/*
 * 回放 2026-11-03 那次真实的时间线（毫秒取整，只保留顺序关系）：
 *
 *   0.2s   用户消息 + 「正在输入」占位（占位在队尾）
 *   15.6s  问答卡（走常驻 SSE，直接 append）
 *   137.6s 正文（走 /reply/stream，认领占位）
 *
 * 修复前的顺序是 [用户, 正文, 卡片] —— 用户看到的就是「结论在上、提问在下」。
 */
{
  const at = (t) => ({ id: t.id, at: t.at })
  const user = at({ id: 'user-1', at: 200 })
  const placeholder = at({ id: 'pending-1', at: 200 })
  const card = at({ id: 'card-qmsg', at: 15_600 })

  let messages = [user, placeholder]
  messages = [...messages, card]
  assert(
    messages.map((m) => m.id).join(',') === 'user-1,pending-1,card-qmsg',
    '回放前置：卡片追加在占位之后（这是修复前的错位现场）',
  )

  const claimed = mod.relocateToEnd(messages, 'pending-1')
  assert(
    claimed.map((m) => m.id).join(',') === 'user-1,card-qmsg,pending-1',
    '认领后正文落到卡片之后：用户 → 提问卡 → 正文（与真实发生时间一致）',
  )
  assert(messages.length === claimed.length, '归位不增删消息')
  assert(messages[0] === claimed[0], '其它消息保持原引用（不做无谓的深拷贝）')

  assert(mod.relocateToEnd(messages, 'card-qmsg') === messages, '已经在队尾时原样返回同一数组（省一次重渲染）')
  assert(mod.relocateToEnd(messages, '不存在') === messages, 'id 不存在时原样返回')
  assert(mod.relocateToEnd([], 'pending-1').length === 0, '空数组不炸')

  const only = [user]
  assert(mod.relocateToEnd(only, 'user-1') === only, '只有一条时不移动')
}

{
  const source = readFileSync(resolve(ROOT, 'src/client/personal/store.tsx'), 'utf8')
  assert(
    /import \{ relocateToEnd \} from '\.\/chat\/message-order\.ts'/.test(source),
    'store 用的是抽出来的纯函数（不是内联复制的第二份实现）',
  )
  assert(
    /relocate\?: \{ at\?: number; toEnd\?: boolean \}/.test(source),
    'updateMessageBlocks 支持 relocate（改时间戳 + 挪位）',
  )
  assert(
    /toEnd: true/.test(source),
    '认领「正在输入」占位时传了 toEnd（否则正文会排到先到的问答卡上面）',
  )
}

console.log('')
if (failed === 0) {
  console.log('[tool output render] PASS')
  process.exit(0)
}
console.error(`[tool output render] FAILED — ${failed} 项`)
process.exit(1)
