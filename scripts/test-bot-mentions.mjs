#!/usr/bin/env node
/**
 * 私聊点名派活 + 投递回执的自测。
 *
 * 覆盖四层：
 *  1. **宿主纯函数**（host/personal/mentions.ts）：清洗、上限、上下文措辞；
 *  2. **前端解析**（client/personal/chat/mentions.ts）：@ 的各种边界（全角 / 邮箱 /
 *     最长优先 / 出现顺序 / 上限）；
 *  3. **回执派生**（client/personal/chat/dispatch.ts）：只取主管亲手派的那层、
 *     24 小时窗口、排序与上限、各状态文案；
 *  4. **接线断言**：契约进了 buildBotPrompt、两条路由都调了注入、界面三处都接上了
 *     数据源（这类「改一半」是纯函数测不出来的）。
 *
 * Usage: node scripts/test-bot-mentions.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-mentions-build-'))

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
    entryPoints: {
      'host-mentions': join(HERE, 'src/host/personal/mentions.ts'),
      'client-mentions': join(HERE, 'src/client/personal/chat/mentions.ts'),
      'client-dispatch': join(HERE, 'src/client/personal/chat/dispatch.ts'),
    },
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  })
  const hostMentions = await import(pathToFileURL(join(OUT, 'host-mentions.mjs')).href)
  const clientMentions = await import(pathToFileURL(join(OUT, 'client-mentions.mjs')).href)
  const clientDispatch = await import(pathToFileURL(join(OUT, 'client-dispatch.mjs')).href)

  const agentSource = readFileSync(join(HERE, 'src/host/personal/agent.ts'), 'utf8')
  const hostIndexSource = readFileSync(join(HERE, 'src/host/personal/index.ts'), 'utf8')
  const storeSource = readFileSync(join(HERE, 'src/client/personal/store.tsx'), 'utf8')
  const composerSource = readFileSync(join(HERE, 'src/client/personal/chat/Composer.tsx'), 'utf8')
  const chatPanelSource = readFileSync(join(HERE, 'src/client/personal/chat/ChatPanel.tsx'), 'utf8')
  const messageListSource = readFileSync(join(HERE, 'src/client/personal/chat/MessageList.tsx'), 'utf8')
  const chatCssSource = readFileSync(join(HERE, 'src/client/personal/chat/chat.css.ts'), 'utf8')

  /* ───────────────── 宿主 · normalizeMentionList ───────────────── */

  console.log('\n[宿主 · 点名清洗]')

  check('非数组 / 空数组返回空', () => {
    assert.deepEqual(hostMentions.normalizeMentionList(undefined), [])
    assert.deepEqual(hostMentions.normalizeMentionList(null), [])
    assert.deepEqual(hostMentions.normalizeMentionList('@采集'), [])
    assert.deepEqual(hostMentions.normalizeMentionList([]), [])
  })

  check('缺 id / 缺名字的条目丢弃', () => {
    const list = hostMentions.normalizeMentionList([
      { id: '', name: '采集' },
      { id: 'bot-cai' },
      { id: 'bot-fx', name: '  ' },
      { id: 'bot-cg', name: '程序管理' },
    ])
    assert.deepEqual(list, [{ id: 'bot-cg', name: '程序管理' }])
  })

  check('按 id 去重、一次最多 3 个、裁掉超长字段', () => {
    const list = hostMentions.normalizeMentionList([
      { id: 'bot-a', name: '甲' },
      { id: 'bot-a', name: '甲' },
      { id: 'bot-b', name: '乙' },
      { id: 'bot-c', name: '丙' },
      { id: 'bot-d', name: '丁' },
    ])
    assert.equal(list.length, 3)
    assert.deepEqual(list.map((item) => item.id), ['bot-a', 'bot-b', 'bot-c'])
    const long = hostMentions.normalizeMentionList([{ id: 'x'.repeat(200), name: 'n'.repeat(200) }])
    assert.equal(long[0].id.length, 80)
    assert.equal(long[0].name.length, 40)
  })

  /* ───────────────── 宿主 · 上下文块 ───────────────── */

  console.log('\n[宿主 · 点名上下文]')

  check('空列表不产生上下文（避免注入空块）', () => {
    assert.equal(hostMentions.buildMentionContextBlock([]), '')
  })

  check('上下文带 bot id（派活要用它），并写明用 coordinate_bots', () => {
    const text = hostMentions.buildMentionContextBlock([{ id: 'bot-cai', name: '采集' }])
    assert.ok(text.includes('## 用户这轮点名了谁'))
    assert.ok(text.includes('采集（bot id：bot-cai）'), '缺少带 id 的点名说明')
    assert.ok(text.includes('coordinate_bots'), '没有告诉模型该用哪个工具')
    assert.ok(text.includes('不要自己把活做完再转述'), '缺少「别自己做完再转述」的硬约束')
    assert.ok(text.includes('一句话就能答完'), '缺少「小事自己做」的例外')
  })

  check('多个点名按顺序列出', () => {
    const text = hostMentions.buildMentionContextBlock([
      { id: 'bot-cai', name: '采集' },
      { id: 'bot-fx', name: '分析' },
    ])
    assert.ok(text.includes('采集（bot id：bot-cai）、分析（bot id：bot-fx）'))
  })

  /* ───────────────── 前端 · parseMentions ───────────────── */

  console.log('\n[前端 · @ 解析]')

  const targets = [
    { id: 'bot-cai', name: '采集' },
    { id: 'bot-fx', name: '分析' },
    { id: 'bot-cg', name: '程序管理' },
    { id: 'bot-mo', name: '小墨' },
    { id: 'bot-mo2', name: '小墨助手' },
  ]

  check('基本 @ 命中，返回 id 而不是只给名字', () => {
    assert.deepEqual(clientMentions.parseMentions('让 @采集 搜一下我的博客', targets), [
      { id: 'bot-cai', name: '采集' },
    ])
  })

  check('全角 ＠ 同样认', () => {
    assert.deepEqual(clientMentions.parseMentions('＠分析 出一份报告', targets), [
      { id: 'bot-fx', name: '分析' },
    ])
  })

  check('邮箱 / 紧贴词字符不算点名', () => {
    const list = clientMentions.parseMentions('user@example.com 回一下', [...targets, { id: 'bot-ex', name: 'example.com' }])
    assert.deepEqual(list, [])
    assert.deepEqual(clientMentions.parseMentions('a@分析', targets), [])
  })

  check('@ 与名字之间隔空格不算点名', () => {
    assert.deepEqual(clientMentions.parseMentions('@ 采集 看一下', targets), [])
  })

  check('名字互为子串时最长优先', () => {
    assert.deepEqual(clientMentions.parseMentions('@小墨助手 处理', targets), [
      { id: 'bot-mo2', name: '小墨助手' },
    ])
    assert.deepEqual(clientMentions.parseMentions('@小墨 处理', targets), [
      { id: 'bot-mo', name: '小墨' },
    ])
  })

  check('多个点名按出现顺序返回（不是按名字长度）', () => {
    const list = clientMentions.parseMentions('@分析 先看，再 @采集 去抓', targets)
    assert.deepEqual(list.map((item) => item.id), ['bot-fx', 'bot-cai'])
  })

  check('重复 @ 同一个只算一次、一次最多 3 个', () => {
    assert.deepEqual(clientMentions.parseMentions('@采集 @采集 @采集', targets), [
      { id: 'bot-cai', name: '采集' },
    ])
    const many = clientMentions.parseMentions('@采集 @分析 @程序管理 @小墨', targets)
    assert.equal(many.length, 3)
  })

  check('正文里随口提到名字不算（没有 @ 就不该派活）', () => {
    assert.deepEqual(clientMentions.parseMentions('我记得采集说过这件事', targets), [])
  })

  /* ───────────────── 前端 · 回执派生 ───────────────── */

  console.log('\n[前端 · 投递回执]')

  const now = 1_800_000_000_000
  const assignment = (id, patch = {}) => ({
    id,
    rootId: id,
    depth: 0,
    requesterBotId: 'main',
    requesterName: '主管',
    assigneeBotId: 'bot-cai',
    assigneeName: '采集',
    mode: 'work',
    brief: '搜一下博客文章，整理成清单',
    status: 'running',
    createdAt: now - 60_000,
    ...patch,
  })

  check('只认主管亲手派的那一层（depth 0）', () => {
    const views = clientDispatch.dispatchViewsOf([
      assignment('a1'),
      assignment('a2', { depth: 1 }),
    ], 'main', now)
    assert.deepEqual(views.map((view) => view.id), ['a1'])
  })

  check('别人派的不算、超过 24 小时的旧委派不算', () => {
    const views = clientDispatch.dispatchViewsOf([
      assignment('a1', { requesterBotId: 'bot-fx' }),
      assignment('a2', { createdAt: now - 25 * 60 * 60 * 1000 }),
      assignment('a3', { createdAt: now - 1000 }),
    ], 'main', now)
    assert.deepEqual(views.map((view) => view.id), ['a3'])
  })

  check('按时间升序（渲染要按先后插进对话流）、最多 6 条', () => {
    const list = []
    for (let index = 0; index < 8; index += 1) {
      list.push(assignment(`a${index}`, { createdAt: now - (8 - index) * 1000 }))
    }
    const views = clientDispatch.dispatchViewsOf(list, 'main', now)
    assert.equal(views.length, 6)
    const times = views.map((view) => view.at)
    assert.deepEqual(times, [...times].sort((left, right) => left - right))
  })

  check('缺 assigneeName 时兜底、brief 截断', () => {
    const views = clientDispatch.dispatchViewsOf([
      assignment('a1', { assigneeName: '', brief: '搜'.repeat(400) }),
    ], 'main', now)
    assert.equal(views[0].botName, '另一个 Bot')
    assert.ok(views[0].brief.length <= 120)
  })

  check('状态文案：排队 / 进行中 / 完成 / 失败 / 取消', () => {
    const label = (status) => clientDispatch.dispatchLabel({ id: 'x', botName: '采集', status, brief: '', at: now })
    assert.equal(label('queued'), '已交给 采集')
    assert.equal(label('running'), '采集 正在处理')
    assert.equal(label('completed'), '采集 已完成')
    assert.equal(label('failed'), '采集 没做成')
    assert.equal(label('cancelled'), '采集 的活已取消')
  })

  check('只有非终态才算「在跑」（呼吸点）', () => {
    const open = (status) => clientDispatch.isDispatchOpen({ id: 'x', botName: '采集', status, brief: '', at: now })
    assert.equal(open('queued'), true)
    assert.equal(open('running'), true)
    assert.equal(open('waiting'), true)
    assert.equal(open('completed'), false)
    assert.equal(open('failed'), false)
    assert.equal(open('cancelled'), false)
  })

  /* ───────────────── 接线 ───────────────── */

  console.log('\n[接线检查]')

  check('BOT_ASSIGN_CONTRACT 导出且拼进 buildBotPrompt', () => {
    assert.ok(agentSource.includes('export const BOT_ASSIGN_CONTRACT'))
    assert.ok(agentSource.includes('BOT_ASSIGN_CONTRACT,'), '契约没有被拼进 buildBotPrompt')
    assert.ok(agentSource.includes('用 coordinate_bots 派出去'))
    assert.ok(agentSource.includes('不要自己做完再转述'))
  })

  check('两条回复路由都注入了点名上下文，且只认私聊', () => {
    const calls = hostIndexSource.split('injectMentionContextForReply(webCtx, spec, body)').length - 1
    assert.equal(calls, 2, `/reply 与 /reply/stream 应各调用一次，实际 ${calls}`)
    const block = hostIndexSource.slice(hostIndexSource.indexOf('async function injectMentionContextForReply'))
    assert.ok(block.includes("if (roomId !== '') return"), '群聊回合应当直接返回（@ 在那里是路由信号）')
    assert.ok(block.includes('normalizeMentionList(body.mentions)'))
  })

  check('前端三处都接上了数据源（改一半不会静默失效）', () => {
    assert.ok(storeSource.includes('parseMentions(value, current.bots.filter'), 'sendMessage 没有解析点名')
    assert.ok(storeSource.includes('mentions: opts.mentions'), '请求体没有带上 mentions')
    assert.ok(composerSource.includes('mentionTargets'), '输入框还是只在群聊显示 @')
    assert.ok(chatPanelSource.includes('dispatchViewsOf('), '面板没有派生回执')
    assert.ok(chatPanelSource.includes('dispatches={dispatches}'), '回执没有传进消息流')
    assert.ok(messageListSource.includes('kind === \'dispatch\''), '消息流没有渲染回执行')
    assert.ok(chatCssSource.includes('.pa-dispatch-row'), '回执行没有样式')
  })
} catch (error) {
  failed += 1
  console.error('\n构建或加载失败：', error instanceof Error ? error.message : String(error))
} finally {
  rmSync(OUT, { recursive: true, force: true })
}

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
