/**
 * 消息可见性判据（src/client/personal/chat/message-visibility.ts）的离线测试。
 *
 * 为什么需要它：同一条判据同时驱动「消息流过滤」与「轮次统计」两件事，而修复前
 * 的真实故障正是两边口径不一致——一条只有 17 个 run_code 工具块（kind=progress）
 * 的消息渲染为空，却被旧判据算进「2 条消息」，用户只看到 1 条正文。
 *
 * 这里用 esbuild 现场打包真实模块（该模块只依赖类型，没有任何 React / 宿主依赖），
 * 逐类覆盖「哪些块渲染后有内容」：
 *  · text：trim 后非空才算；
 *  · tool：只有 computer / browser 一族（会转执行态卡）与生图 / 生视频 / 文档
 *    生成占位算可见；run_code / pwsh 等普通工具一律不算；
 *  · image / interactive / journal / compaction 等其余块类型算可见。
 *
 * 另加源码断言：MessageList 必须引用 hasRenderableContent，渲染层不能再留第二份
 * 本地判据（否则两边以后还会分叉）。
 *
 * 用法：node scripts/test-message-visibility.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

// 产物落到项目的 _tmp/ 下（该目录由工作区清理器回收），不要污染 scripts/
mkdirSync(resolve(ROOT, '_tmp', 'build'), { recursive: true })
const outfile = resolve(ROOT, '_tmp', 'build', 'personal-message-visibility.mjs')
await build({
  entryPoints: [resolve(ROOT, 'src/client/personal/chat/message-visibility.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: ['es2020'],
  logLevel: 'silent',
})

const { isExecutionToolName, isStandaloneToolRun, hasRenderableContent } = await import(pathToFileURL(outfile).href)

const failures = []
const check = (name, condition, extra) => {
  if (condition) {
    console.log('ok    ' + name)
    return
  }
  failures.push(name)
  const suffix = extra === undefined || extra === '' ? '' : ' — ' + extra
  console.log('FAIL  ' + name + suffix)
}

/* ------------------------------------------------------------------ */
/* 测试数据工厂                                                        */
/* ------------------------------------------------------------------ */

/** 造一条 bot 消息；测试只关心 blocks，其余字段给最小可用值。 */
const msg = (blocks) => ({ id: 'msg-test', botId: 'bot-test', role: 'bot', at: 0, blocks })

/** 造一个工具块。 */
const tool = (name, status = 'ok', extra = {}) => ({ type: 'tool', run: { id: 'run-' + name + '-' + status, name, status, startedAt: 0, ...extra } })

/** 真实故障里的形状：17 个 run_code 快照，kind=progress，没有正文。 */
const pureRunCodeMessage = msg(Array.from({ length: 17 }, () => tool('run_code')))

/* ------------------------------------------------------------------ */
/* 1. hasRenderableContent：纯工具 / 空文本 / 正常文本                    */
/* ------------------------------------------------------------------ */

check('纯 run_code 工具消息（17 个快照）→ 不可见', hasRenderableContent(pureRunCodeMessage) === false)
check('单条 run_code 工具消息 → 不可见', hasRenderableContent(msg([tool('run_code')])) === false)
check('pwsh / read / grep 等普通工具 → 不可见',
  hasRenderableContent(msg([tool('pwsh'), tool('read'), tool('grep')])) === false)
check('空 text → 不可见', hasRenderableContent(msg([{ type: 'text', text: '' }])) === false)
check('纯空白 text → 不可见',
  hasRenderableContent(msg([{ type: 'text', text: '   ' }, { type: 'text', text: '\n\t ' }])) === false)
check('空 blocks → 不可见', hasRenderableContent(msg([])) === false)
check('正常 text → 可见', hasRenderableContent(msg([{ type: 'text', text: '你好' }])) === true)
check('text 前后空白但中间有字 → 可见', hasRenderableContent(msg([{ type: 'text', text: '  你好  ' }])) === true)
check('多段 text 中有一段非空 → 可见',
  hasRenderableContent(msg([{ type: 'text', text: ' ' }, { type: 'text', text: '正文' }])) === true)
check('tool + 空 text 混合 → 不可见',
  hasRenderableContent(msg([tool('run_code'), { type: 'text', text: '  ' }])) === false)
check('tool + 正常 text 混合 → 可见',
  hasRenderableContent(msg([tool('run_code'), { type: 'text', text: '正文' }])) === true)

/* ------------------------------------------------------------------ */
/* 2. execution 块与 computer / browser 工具                            */
/* ------------------------------------------------------------------ */

check('execution 块 → 可见', hasRenderableContent(msg([{ type: 'execution', status: 'ok', label: '操作浏览器' }])) === true)
check('computer 工具 → 可见', hasRenderableContent(msg([tool('computer')])) === true)
check('browser 工具 → 可见', hasRenderableContent(msg([tool('browser')])) === true)
check('screenshot 工具 → 可见', hasRenderableContent(msg([tool('screenshot')])) === true)
check('playwright 工具 → 可见', hasRenderableContent(msg([tool('playwright')])) === true)
check('puppeteer 工具 → 可见', hasRenderableContent(msg([tool('puppeteer')])) === true)
check('chrome 工具 → 可见', hasRenderableContent(msg([tool('chrome')])) === true)
check('devtools 工具 → 可见', hasRenderableContent(msg([tool('devtools')])) === true)
check('cdp 工具 → 可见', hasRenderableContent(msg([tool('cdp')])) === true)
check('大写的 Browser 工具 → 可见', hasRenderableContent(msg([tool('Browser.open')])) === true)
check('带前后空格的 computer 工具 → 可见', hasRenderableContent(msg([tool('  computer  ')])) === true)

/* ------------------------------------------------------------------ */
/* 3. 独立卡片工具：generate_image / generate_video / docPending          */
/* ------------------------------------------------------------------ */

check('generate_image（已完成）→ 可见', hasRenderableContent(msg([tool('generate_image', 'ok')])) === true)
check('generate_video（已完成）→ 可见', hasRenderableContent(msg([tool('generate_video', 'ok')])) === true)
check('generate_image（生成中）→ 可见', hasRenderableContent(msg([tool('generate_image', 'running')])) === true)
check('docPending + running → 可见',
  hasRenderableContent(msg([tool('run_code', 'running', { docPending: true })])) === true)
check('docPending 但已完成 → 不可见',
  hasRenderableContent(msg([tool('run_code', 'ok', { docPending: true })])) === false)
check('docPending=false + running → 不可见',
  hasRenderableContent(msg([tool('run_code', 'running', { docPending: false })])) === false)
check('只有空 text + generate_image → 可见',
  hasRenderableContent(msg([{ type: 'text', text: '' }, tool('generate_image', 'running')])) === true)

/* ------------------------------------------------------------------ */
/* 4. 其余块类型一律可见                                                */
/* ------------------------------------------------------------------ */

check('image 块 → 可见',
  hasRenderableContent(msg([{ type: 'image', image: { url: 'u', path: 'p' } }])) === true)
check('interactive 块 → 可见',
  hasRenderableContent(msg([{ type: 'interactive', prompt: '选一个', ui: { kind: 'buttons', options: [] } }])) === true)
check('journal 块 → 可见',
  hasRenderableContent(msg([{ type: 'journal', journalId: 'j', title: '今天的日记', date: '2026-11-04', summary: '摘要' }])) === true)
check('compaction 块 → 可见',
  hasRenderableContent(msg([{ type: 'compaction', at: 0, folded: 3 }])) === true)
check('task 块 → 可见',
  hasRenderableContent(msg([{ type: 'task', title: '任务', status: '进行中', steps: [] }])) === true)
check('voice 块 → 可见',
  hasRenderableContent(msg([{ type: 'voice', durationMs: 1200, transcript: '你好' }])) === true)
check('call 块 → 可见',
  hasRenderableContent(msg([{ type: 'call', call: {} }])) === true)
check('call-segment 块 → 可见',
  hasRenderableContent(msg([{ type: 'call-segment', segment: 's1', startedAt: 0, turns: 2 }])) === true)
check('connectors 块 → 可见',
  hasRenderableContent(msg([{ type: 'connectors', items: [] }])) === true)

/* ------------------------------------------------------------------ */
/* 5. 工具判据的独立行为                                                */
/* ------------------------------------------------------------------ */

check('isExecutionToolName(computer) → true', isExecutionToolName('computer') === true)
check('isExecutionToolName(  Browser ) → true', isExecutionToolName('  Browser ') === true)
check('isExecutionToolName(run_code) → false', isExecutionToolName('run_code') === false)
check('isExecutionToolName(generate_image) → false', isExecutionToolName('generate_image') === false)
check('isExecutionToolName(pwsh) → false', isExecutionToolName('pwsh') === false)
check('isExecutionToolName(空串) → false', isExecutionToolName('') === false)

check('isStandaloneToolRun(generate_image) → true',
  isStandaloneToolRun({ id: 'r1', name: 'generate_image', status: 'ok', startedAt: 0 }) === true)
check('isStandaloneToolRun(generate_video / error) → true',
  isStandaloneToolRun({ id: 'r2', name: 'generate_video', status: 'error', startedAt: 0 }) === true)
check('isStandaloneToolRun(docPending + running) → true',
  isStandaloneToolRun({ id: 'r3', name: 'run_code', status: 'running', startedAt: 0, docPending: true }) === true)
check('isStandaloneToolRun(docPending + ok) → false',
  isStandaloneToolRun({ id: 'r4', name: 'run_code', status: 'ok', startedAt: 0, docPending: true }) === false)
check('isStandaloneToolRun(普通工具) → false',
  isStandaloneToolRun({ id: 'r5', name: 'run_code', status: 'running', startedAt: 0 }) === false)

/* ------------------------------------------------------------------ */
/* 6. 源码接线断言（防止以后又出现第二份本地判据）                        */
/* ------------------------------------------------------------------ */

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')

const visibilitySrc = read('src/client/personal/chat/message-visibility.ts')
check('message-visibility.ts 导出 isExecutionToolName', visibilitySrc.includes('export function isExecutionToolName'))
check('message-visibility.ts 导出 isStandaloneToolRun', visibilitySrc.includes('export function isStandaloneToolRun'))
check('message-visibility.ts 导出 hasRenderableContent', visibilitySrc.includes('export function hasRenderableContent'))

const messageListSrc = read('src/client/personal/chat/MessageList.tsx')
check('MessageList 引用 hasRenderableContent', messageListSrc.includes('hasRenderableContent'))
check('MessageList 从共享模块引入判据', messageListSrc.includes("from './message-visibility.ts'"))
check('MessageList 不再使用旧宽松判据 hasVisibleContent', !messageListSrc.includes('hasVisibleContent'))
check('MessageList 的 visible 过滤调用 hasRenderableContent', messageListSrc.includes('!hasRenderableContent(message)'))

const messageBlockViewSrc = read('src/client/personal/chat/MessageBlockView.tsx')
check('MessageBlockView 从共享模块引入判据',
  messageBlockViewSrc.includes("import { isExecutionToolName, isStandaloneToolRun } from './message-visibility.ts'"))
check('MessageBlockView 不再定义本地 isExecutionTool', !messageBlockViewSrc.includes('function isExecutionTool('))
check('MessageBlockView 不再定义本地 isStandaloneTool', !messageBlockViewSrc.includes('function isStandaloneTool('))

console.log('')
if (failures.length === 0) {
  console.log('MESSAGE VISIBILITY VERIFY PASSED')
} else {
  console.log('MESSAGE VISIBILITY VERIFY FAILED (' + failures.length + '): ' + failures.join(', '))
  process.exitCode = 1
}
