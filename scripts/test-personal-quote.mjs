#!/usr/bin/env node
/**
 * Personal Agent「引用回复进模型上下文」自测。
 *
 * 背景（2026-11-04 用户反馈「bot 的引用有问题」）：界面上有引用条，但 `/reply`
 * 请求体里从来没有 quote —— 模型只收到一句「1」，只能回「没看到前文的选项」。
 * 本测试钉死修复后的三层契约：
 *
 *  1. **前端取文本**（model-text.ts）：交互卡的选项必须展开（含序号提示）；
 *     buildQuoteRef 用完整正文 + role 补全引用，找不到被引用消息时退回 preview；
 *     historyTextOf 给历史消息带上「引用了一条消息」前缀。
 *  2. **宿主拼提示**（quote-hints.ts）：withQuoteHints 把引用拼在本轮正文之前，
 *     无引用 / 形状非法时原样返回；超长按 QUOTE_HINT_MAX 截断。
 *  3. **接线**：store.tsx 的请求体带 quote、sendMessage 用 buildQuoteRef、history
 *     用 historyTextOf；index.ts 的 ReplyBody 收 quote，两条回复路由都套
 *     withQuoteHints。
 *
 * 用项目自带 esbuild 打包两个纯函数模块后直接调用（与 test-personal-context.mjs
 * 同一手法）；不依赖 lib/ 构建产物。
 *
 * Usage: node scripts/test-personal-quote.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-quote-build-'))
const HOME = mkdtempSync(join(tmpdir(), 'pa-quote-home-'))
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

try {
  await build({
    entryPoints: [join(HERE, 'src/client/personal/model-text.ts'), join(HERE, 'src/host/personal/quote-hints.ts')],
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  })
  const client = await import(pathToFileURL(join(OUT, 'client/personal/model-text.mjs')).href)
  const host = await import(pathToFileURL(join(OUT, 'host/personal/quote-hints.mjs')).href)

  console.log('\n[前端 · modelTextOf]')

  check('交互卡的选项按序号展开，并提示用户可以回序号', () => {
    const text = client.modelTextOf([
      {
        type: 'interactive',
        prompt: '先让我把哪块接过来做实？',
        ui: {
          kind: 'options',
          options: [
            { id: 'a', label: '盯服务器和代理', description: 'VPS/节点存活' },
            { id: 'b', label: '打理 Magpie 网关' },
          ],
        },
      },
    ])
    assert.ok(text.includes('先让我把哪块接过来做实？'), '缺少卡片提问')
    assert.ok(text.includes('（1）盯服务器和代理 — VPS/节点存活'), '第 1 个选项没有带序号展开')
    assert.ok(text.includes('（2）打理 Magpie 网关'), '第 2 个选项没有带序号展开')
    assert.ok(text.includes('用户可能直接回序号'), '缺少「可以回序号」的提示')
    assert.ok(!text.includes('交互卡片'), '不该退回「交互卡片」占位')
  })

  check('选中结果写进文本', () => {
    const text = client.modelTextOf([
      { type: 'interactive', ui: { kind: 'buttons', options: [{ id: 'a', label: '继续' }] }, result: '继续' },
    ])
    assert.ok(text.includes('用户已选 / 已填：继续'))
  })

  check('正文 / 图片 / 表单字段都有可读文本，工具块不产出文字', () => {
    const text = client.modelTextOf([
      { type: 'text', text: '帮我看下这个' },
      { type: "image", image: { path: "a.png", name: "a.png" } },
      { type: 'tool', run: { id: 't', name: 'read' } },
    ])
    assert.ok(text.includes('帮我看下这个'))
    assert.ok(text.includes('[图片]'))
    assert.ok(!text.includes('read'), '工具块不该进模型文本')
  })

  console.log('\n[前端 · buildQuoteRef]')

  const messages = [
    {
      id: 'm1',
      role: 'bot',
      blocks: [
        { type: 'text', text: '在我开始之前，想先确认一下：你希望我优先做什么？' },
        {
          type: 'interactive',
          ui: { kind: 'options', options: [{ id: 'a', label: '盯服务器和代理' }, { id: 'b', label: '打理 Magpie 网关' }] },
        },
      ],
    },
    { id: 'm2', role: 'user', blocks: [{ type: 'text', text: '1' }] },
  ]

  check('引用被补全成完整正文 + role（不是 80 字摘要）', () => {
    const quote = client.buildQuoteRef(messages, { id: 'm1', preview: '在我开始之前，想先确认一下' })
    assert.ok(quote !== undefined, '应该返回引用载荷')
    assert.equal(quote.id, 'm1')
    assert.equal(quote.role, 'bot')
    assert.ok(quote.text.includes('（1）盯服务器和代理'), '引用文本里必须带选项')
    assert.ok(quote.text.includes('你希望我优先做什么？'))
    assert.equal(quote.preview, '在我开始之前，想先确认一下')
  })

  check('被引用消息已不在当前会话时退回 preview', () => {
    const quote = client.buildQuoteRef(messages, { id: 'gone', preview: '已经删掉的一句话' })
    assert.equal(quote.text, '已经删掉的一句话')
    assert.equal(quote.role, undefined)
  })

  check('没有引用 / 空 id 时返回 undefined', () => {
    assert.equal(client.buildQuoteRef(messages, null), undefined)
    assert.equal(client.buildQuoteRef(messages, undefined), undefined)
    assert.equal(client.buildQuoteRef(messages, { id: '  ', preview: 'x' }), undefined)
  })

  console.log('\n[前端 · historyTextOf]')

  check('带引用的历史消息保留引用关系', () => {
    const text = client.historyTextOf({
      id: 'm3',
      role: 'user',
      blocks: [{ type: 'text', text: '1' }],
      replyTo: { id: 'm1', preview: '选项卡', text: '（1）盯服务器和代理；（2）打理 Magpie 网关' },
    })
    assert.ok(text.startsWith('（引用了一条消息：'), '历史文本缺少引用前缀')
    assert.ok(text.includes('（1）盯服务器和代理'))
    assert.ok(text.endsWith('1'), '用户原话要留在最后')
  })

  check('没有引用时历史文本保持原文', () => {
    const text = client.historyTextOf({ id: 'm4', role: 'user', blocks: [{ type: 'text', text: '你好' }] })
    assert.equal(text, '你好')
  })

  console.log('\n[文案 · clampModelText]')

  check('超长引用按 REFERENCE_TEXT_MAX 截断并补省略号', () => {
    assert.equal(client.REFERENCE_TEXT_MAX, 2_000)
    const long = client.quoteTextOf({
      id: 'm5', role: 'user', blocks: [{ type: 'text', text: 'x'.repeat(5_000) }],
    })
    assert.equal(long.length, client.REFERENCE_TEXT_MAX + 1)
    assert.ok(long.endsWith('…'))
  })

  check('空消息给占位而不是空引用', () => {
    const text = client.quoteTextOf({ id: 'm6', role: 'bot', blocks: [] })
    assert.ok(text.includes('没有文字内容'))
  })

  console.log('\n[宿主 · withQuoteHints]')

  check('引用拼在本轮正文之前，正文保持原样在最后', () => {
    const out = host.withQuoteHints('1', { role: 'bot', text: '（1）盯服务器和代理；（2）打理 Magpie 网关' })
    assert.ok(out.startsWith('【用户引用了下面这条历史消息】'))
    assert.ok(out.includes('你自己（助手）之前说的'))
    assert.ok(out.includes('（1）盯服务器和代理'))
    assert.ok(out.includes('【引用结束】'))
    assert.ok(out.endsWith('1'), '用户正文必须在最后')
  })

  check('用户说的消息标注为「用户自己之前说的」', () => {
    const out = host.withQuoteHints('这个改一下', { role: 'user', text: '登录页那个按钮' })
    assert.ok(out.includes('用户自己之前说的'))
    assert.ok(out.endsWith('这个改一下'))
  })

  check('只有 preview 时也能兜住（老前端 / 被引用消息已删）', () => {
    const out = host.withQuoteHints('1', { preview: '在我开始之前，想先确认一下' })
    assert.ok(out.includes('在我开始之前，想先确认一下'))
    assert.ok(out.includes('之前的一条消息'))
  })

  check('无引用 / 形状非法时原样返回', () => {
    assert.equal(host.withQuoteHints('你好', undefined), '你好')
    assert.equal(host.withQuoteHints('你好', null), '你好')
    assert.equal(host.withQuoteHints('你好', { id: 'x' }), '你好')
    assert.equal(host.withQuoteHints('你好', 'not-an-object'), '你好')
  })

  check('超长引用按 QUOTE_HINT_MAX 截断', () => {
    assert.equal(host.QUOTE_HINT_MAX, 2_000)
    const out = host.withQuoteHints('收尾', { role: 'user', text: 'y'.repeat(5_000) })
    const body = out.slice(out.indexOf('\n') + 1)
    assert.ok(out.includes('…'))
    assert.ok(body.length < 5_000)
    assert.ok(out.endsWith('收尾'))
  })

  console.log('\n[接线 · store.tsx]')

  const storeSource = readFileSync(join(HERE, 'src/client/personal/store.tsx'), 'utf8')
  const requestBody = storeSource.slice(
    storeSource.indexOf('function replyRequestBody'),
    storeSource.indexOf('async function hostReply'),
  )

  check('请求体带 quote（引用真正投给宿主）', () => {
    assert.ok(requestBody.includes('...(opts.quote !== undefined ? { quote: opts.quote } : {})'), '请求体缺少 quote 字段')
    assert.ok(requestBody.includes('text: historyTextOf(msg)'), 'history 还在用 blocksToText，交互卡选项仍会丢')
  })

  check('sendMessage 用 buildQuoteRef 补全引用，并贯通到两条回复路径', () => {
    assert.ok(storeSource.includes('const quote = buildQuoteRef(current.messages, opts.replyTo ?? uiRef.current.replyTo)'))
    assert.ok(storeSource.includes('...(quote !== undefined ? { replyTo: quote } : {})'), '用户消息没有落完整引用')
    assert.ok(storeSource.includes('...(target.quote !== undefined ? { quote: target.quote } : {})'), 'replyAsBot 没有透传引用')
    // 群聊 / 单聊两条路径的 replyAsBot 调用都要把 quote 放进 target
    const calls = storeSource.split('\n').filter((line) => line.includes('replyAsBot(') && line.includes('{ quote }'))
    assert.ok(calls.length >= 2, '群聊 / 单聊两条路径都要带 quote')
  })

  console.log('\n[接线 · index.ts]')

  const hostSource = readFileSync(join(HERE, 'src/host/personal/index.ts'), 'utf8')

  check('ReplyBody 收 quote，两条回复路由都套 withQuoteHints', () => {
    assert.ok(hostSource.includes('quote?: { id?: string; preview?: string; text?: string; role?: string }'), 'ReplyBody 缺少 quote')
    const withQuote = hostSource.match(/withQuoteHints\(withImageHints\(/g) ?? []
    assert.equal(withQuote.length, 2, '应正好两处（/reply 与 /reply/stream）')
    assert.ok(hostSource.includes("import { withQuoteHints } from './quote-hints.ts'"), '没有导入 withQuoteHints')
  })

  check('任务记录仍用用户原文（不被引用前缀污染）', () => {
    assert.ok(hostSource.includes('const userText = String(body.text ?? \'\').trim()'))
    assert.ok(hostSource.includes('brief: briefText'), '任务 brief 应使用用户原文')
  })

  if (failed > 0) {
    console.error(`\n[personal-quote] ${passed} passed, ${failed} failed`)
    process.exitCode = 1
  } else {
    console.log(`\n[personal-quote] all ${passed} checks passed`)
  }
} finally {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}
