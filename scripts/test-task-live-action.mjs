#!/usr/bin/env node
/**
 * dsh-seeker-bot — Bot「动态」运行中动作行回归测试（纯 Node ESM）。
 *
 * ── 这个脚本防的是什么 ──────────────────────────────────────────────
 * 2026-11-07 用户口径：「bot 的动态的这个正在回复改为动态的显示与我们 seeker
 * 操作面板里显示的动作，因为正在回复看不出来他在做的工作」。
 *
 * 修完之后的契约：
 *  1. **同一句动作**：host 用完整工具参数算出「启动第二个 CodeArts 账号登录」
 *     （规则表只有一份：src/client/kr-chat/plain-language.ts 的 toPlainStep），
 *     前端动态行直接显示它 —— 与 Seeker 操作面板逐字一致；
 *  2. **泛化兜底消失**：TaskRecordCard 不再有「正在整理回复…」；
 *  3. **历史数据兼容**：旧 TaskRecordStep 没有 action 字段时，前端从
 *     工具名 + detail 回退解析，仍然给出具体动作；
 *  4. **双行 + 交叉淡入**：窄屏（397px）读得全，换动作时不硬闪；
 *  5. **耗时在右上角**（2026-11-07 用户口径：「已做去掉，做了多长时间放在
 *     右上角，完成后也显示做了多长时间」）：行内不再渲染「已做 N/M」，
 *     mm:ss 挂在标题行右端；运行中实时走格，收工后仍是落盘的总用时，
 *     没有用时数据的行不显示（不硬凑 00:00）。
 *
 * 断言分三层：
 *  · 纯函数（esbuild 打包后真跑）：plainActionOf / stepActionViewOf /
 *    actionLabelOf / toolActionOf；
 *  · 源码契约：store 接线、host 接线、不再出现旧兜底文案；
 *  · 样式契约：双行 clamp、交叉淡入关键帧、prefers-reduced-motion 兜底。
 *
 * Usage: node scripts/test-task-live-action.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
let total = 0
const pass = (msg) => { total += 1; console.log('ok    ' + msg) }
const fail = (msg) => { total += 1; failed += 1; console.error('FAIL  ' + msg) }
const check = (cond, msg, detail) => {
  if (cond) pass(msg)
  else fail(msg + (detail === undefined ? '' : ' — ' + detail))
}

const slash = (p) => p.replace(/[\\]/g, '/')
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

/* ── 1. 纯函数：真跑 host 与 client 的动作翻译 ─────────────────────── */
const outDir = mkdtempSync(join(tmpdir(), 'dsh-task-live-action-'))
let mod
{
  const entry = join(outDir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export { plainActionOf } from '${slash(resolve(ROOT, 'src/host/personal/tool-action.ts'))}'`,
      `export { actionLabelOf, stepActionViewOf, toolActionOf, briefOf, liveProgressOf, elapsedTextOf } from '${slash(resolve(ROOT, 'src/client/personal/shell/task-action.ts'))}'`,
      '',
    ].join('\n'),
    'utf8',
  )
  const bundle = join(outDir, 'entry.mjs')
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  })
  mod = await import(pathToFileURL(bundle).href)
}

const { plainActionOf, actionLabelOf, stepActionViewOf, toolActionOf, briefOf, liveProgressOf, elapsedTextOf } = mod

const toolStep = (over = {}) => ({
  at: 0,
  id: 'call-1',
  kind: 'tool',
  title: 'pwsh',
  status: 'running',
  ...over,
})

console.log('[task-live-action] host 侧：完整参数 → 一句人话动作')
{
  const term = plainActionOf('pwsh', {
    command: 'Start-Process msedge ...',
    description: '启动第二个 CodeArts 账号登录',
  })
  check(term.action === '启动第二个 CodeArts 账号登录', '终端族取 description 当动作', term.action)
  check(term.hideVerb === true, '终端族标 hideVerb（显示时不拼「正在」）')

  const search = plainActionOf('web_search', { queries: ['CodeArts 账号登录 流程'] })
  check(search.action === '搜索网络 CodeArts 账号登录 流程', '搜索带完整关键词', search.action)
  check(search.hideVerb === false, '搜索不标 hideVerb')

  const readOne = plainActionOf('read', { file_path: 'D:/AI/dsh-seeker-bot/src/host/personal/tool-action.ts' })
  check(readOne.action === '查看文件 tool-action.ts', '读文件只留文件名', readOne.action)

  let threw = false
  let malformed
  try {
    malformed = plainActionOf('pwsh', undefined)
    plainActionOf('', null)
    plainActionOf(123, [])
    plainActionOf('unknown_tool', 'not-an-object')
  } catch (error) {
    threw = true
  }
  check(threw === false, '畸形参数绝不抛')
  check(typeof malformed?.action === 'string' && malformed.action !== '', '畸形参数仍有兜底动作', String(malformed?.action))
}

console.log('[task-live-action] 动态行：running / done / error 的显示口径')
{
  const running = actionLabelOf(toolStep({ status: 'running' }))
  check(running !== '' && !running.includes('正在在'),
    '没有 detail 的终端族不叠字（不出现「正在在电脑上操作」）', running)

  const withAction = toolStep({
    action: '启动第二个 CodeArts 账号登录',
    actionHideVerb: true,
  })
  check(actionLabelOf(withAction) === '启动第二个 CodeArts 账号登录',
    '运行中·终端族：短语本身即完整人话，不拼「正在」', actionLabelOf(withAction))
  check(actionLabelOf({ ...withAction, status: 'ok' }) === '启动第二个 CodeArts 账号登录',
    '完成·终端族：也不拼「已」', actionLabelOf({ ...withAction, status: 'ok' }))

  const nonHide = toolStep({ action: '查看文件 agent.ts' })
  check(actionLabelOf({ ...nonHide, status: 'running' }) === '正在查看文件 agent.ts',
    '运行中·普通族：拼「正在」', actionLabelOf({ ...nonHide, status: 'running' }))
  check(actionLabelOf({ ...nonHide, status: 'ok' }) === '已查看文件 agent.ts',
    '完成·普通族：拼「已」', actionLabelOf({ ...nonHide, status: 'ok' }))
  check(actionLabelOf({ ...nonHide, status: 'error' }) === '查看文件 agent.ts，没做成',
    '失败：人话原因，不出现英文错误码', actionLabelOf({ ...nonHide, status: 'error' }))
}

console.log('[task-live-action] 历史数据：没有 action 字段时从 detail 回退')
{
  const legacy = toolStep({
    detail: JSON.stringify({ command: 'x', description: '启动第二个 CodeArts 账号登录' }),
  })
  const view = stepActionViewOf(legacy)
  check(view.action === '启动第二个 CodeArts 账号登录', '老记录仍能读出具体动作', view.action)
  check(view.hideVerb === true, '老记录也认得出终端族')

  const half = toolStep({ detail: '{"command":"Get-ChildItem D:/AI/dsh' })
  let threw = false
  try { stepActionViewOf(half) } catch { threw = true }
  check(threw === false, '半截 JSON 的 detail 不抛、走兜底')

  const textStep = { at: 0, kind: 'text', title: '分析', detail: '我先看看这个项目的目录结构，再决定从哪里改。' }
  check(actionLabelOf(textStep) === '分析', '过程说明仍返回它的步骤名（不被工具规则污染）')
  check(briefOf(textStep.detail).length > 0, '过程说明能取到首句（动态行的第二档文案）')
}

console.log('[task-live-action] 动态行：此刻在做什么（四档，越具体越优先）')
{
  const taskOf = (steps, status = 'running') => ({ id: 't', botId: 'b', title: 't', prompt: 'p', status, startedAt: 0, steps })
  const start = { at: 0, kind: 'start', title: '开始处理' }

  const runningTask = liveProgressOf(taskOf([
    start,
    { at: 1, kind: 'tool', id: 'c1', title: 'pwsh', status: 'running', action: '启动第二个 CodeArts 账号登录', actionHideVerb: true },
  ]))
  check(runningTask !== null && runningTask.label === '启动第二个 CodeArts 账号登录',
    '第一档：有动作在跑 → 直接说那个动作', runningTask?.label)

  const finishedTask = liveProgressOf(taskOf([
    start,
    { at: 1, kind: 'tool', id: 'c1', title: 'web_fetch', status: 'ok', action: '读取网页 github.com' },
    { at: 2, kind: 'tool', id: 'c2', title: 'read', status: 'ok', action: '查看文件 README.md' },
  ]))
  check(finishedTask !== null && finishedTask.label === '刚才查看文件 README.md',
    '第三档（用户二次反馈那条）：动作都做完但本轮还在跑 → 显示刚做完的那一步，不是「正在思考」', finishedTask?.label)
  check(finishedTask !== null && finishedTask.done === 2 && finishedTask.total === 2,
    '内部计数仍给对（只供进度条算比例，不再当「已做 2/2」文案渲染）',
    finishedTask === null ? 'null' : String(finishedTask.done) + '/' + String(finishedTask.total))

  const textTask = liveProgressOf(taskOf([
    start,
    { at: 1, kind: 'text', title: '分析', detail: '我先去看看这个 superagent 项目解决了什么问题，再决定怎么跟进。' },
  ]))
  check(textTask !== null && textTask.label.startsWith('我先去看看'),
    '第二档：有过程说明 → 取它的首句', textTask?.label)

  const outputTask = liveProgressOf(taskOf([
    start,
    { at: 1, kind: 'output', title: 'report.docx', status: 'ok' },
  ]))
  check(outputTask !== null && outputTask.label === '刚才产出 report.docx',
    '产出物单独说「刚才产出 xxx」', outputTask?.label)

  const emptyTask = liveProgressOf(taskOf([start]))
  check(emptyTask !== null && emptyTask.label === '正在思考',
    '第四档：一条动作都没有才说「正在思考」', emptyTask?.label)

  check(liveProgressOf(taskOf([], 'done')) === null, '已收口的任务不再返回活信息')
}

console.log('[task-live-action] 动态行：右上角耗时（做了多长时间）')
{
  const taskOf = (over) => ({
    id: 't', botId: 'b', title: 't', prompt: 'p', status: 'running', startedAt: 1000, steps: [],
    ...over,
  })

  check(elapsedTextOf(taskOf({ status: 'running' }), 1000 + 72_400) === '01:12',
    '运行中：按当前时刻实时走格（mm:ss）', elapsedTextOf(taskOf({ status: 'running' }), 1000 + 72_400))
  check(elapsedTextOf(taskOf({ status: 'done', durationMs: 46_000 }), 9_999_999) === '00:46',
    '收工后：仍显示总用时，不再依赖 now', elapsedTextOf(taskOf({ status: 'done', durationMs: 46_000 }), 9_999_999))
  check(elapsedTextOf(taskOf({ status: 'done', endedAt: 31_000 }), 0) === '00:30',
    '老数据没有 durationMs：回退 endedAt - startedAt', elapsedTextOf(taskOf({ status: 'done', endedAt: 31_000 }), 0))
  check(elapsedTextOf(taskOf({ status: 'failed', endedAt: 9_000 }), 0) === '00:08',
    '失败的行同样给耗时（与 done 一视同仁）', elapsedTextOf(taskOf({ status: 'failed', endedAt: 9_000 }), 0))
  check(elapsedTextOf(taskOf({ status: 'done' }), 0) === null,
    '两样都没有：不硬凑 00:00，行上不显示')
  check(elapsedTextOf(taskOf({ status: 'done', durationMs: -50 }), 0) === '00:00',
    '脏数据（负时长）收成 00:00，不出现负号')
  check(elapsedTextOf(taskOf({ status: 'running', startedAt: 5_000 }), 4_000) === '00:00',
    '现在早于开始时刻也不出负数')
}

console.log('[task-live-action] 源码契约')
{
  const card = read('src/client/personal/shell/TaskRecordCard.tsx')
  // 注释里允许引用用户口径（说明为什么删掉），这里钉死的是**不再把它当文案**。
  check(!/['"\u2018\u2019]正在整理回复/.test(card), '动态卡不再有「正在整理回复…」兜底')
  check(card.includes('useCrossfadeText') && card.includes('useMotionAllowed'), '换动作走交叉淡入（motion-utils）')
  check(card.includes('正在思考'), '没有任何动作时给「正在思考」，不是「正在处理」')
  check(card.includes('liveProgressOf'), '动态卡使用 task-action 的 liveProgressOf（纯函数，可被测试真跑）')
  check(!card.includes("'已做 '"), '行内不再渲染「已做 N/M」（用户口径：已做去掉）')
  check(card.includes('elapsedTextOf') && card.includes('pa-taskrec__elapsed'),
    '耗时挂在标题行右上角，值来自 task-action 的 elapsedTextOf')
  check(!card.includes('pa-taskrec__live-meta'), '动作行尾不再挂 meta（已做 / 耗时都已挪走）')

  const action = read('src/client/personal/shell/task-action.ts')
  check(action.includes("from '../../kr-chat/plain-language.ts'"), '动作规则表复用 plain-language（只有一份）')
  check(action.includes('export function stepActionViewOf('), '对外导出 stepActionViewOf')
  check(action.includes('export function liveProgressOf('), '活信息逻辑在纯模块里导出（回归脚本可直接跑）')
  check(action.includes('export function elapsedTextOf('), '耗时口径在纯模块里导出（运行中 / 收工后 / 老数据三档可测）')
  check(action.includes("label = '刚才'") || action.includes("'刚才' + view.action"), '第四档：动作都完成时显示「刚才 + 动作」')
  check(action.includes('step.action') && action.includes('actionHideVerb'), '优先用 host 算好的 action')

  const css = read('src/client/personal/shell/tasks.css.ts')
  check(css.includes('-webkit-line-clamp: 2'), '动作文案最多两行（窄屏读得全）')
  check(css.includes('pa-taskrec-live-in') && css.includes('pa-taskrec-live-out'), '交叉淡入关键帧存在')
  // 标题行 = 标题 + 右上角耗时；耗时 flex:none 不被挤掉，标题自己出省略号。
  check(/\.pa-taskrec__top\s*\{[^}]*display:\s*flex/.test(css), '标题行是 flex（标题左、耗时右）')
  check(/\.pa-taskrec__elapsed\s*\{[^}]*tabular-nums/.test(css),
    '右上角耗时是等宽数字（每秒走格时宽度不跳）')
  check(!/已做 N\/M · 耗时/.test(css), '样式注释里的旧「已做 N/M · 耗时」口径已清理')
  check(/prefers-reduced-motion: reduce[\s\S]*pa-taskrec__live-text/.test(css), '减少动态效果时关闭换字动画')

  const store = read('src/client/personal/store.tsx')
  check(store.includes('actionHideVerb'), 'store 把 ToolRun.action 写进任务步骤')
  check(/run\.action !== undefined/.test(store), 'store 只在 action 非空时写字段（旧宿主兼容）')

  const hostAgent = read('src/host/personal/agent.ts')
  check((hostAgent.match(/plainActionOf\(/g) ?? []).length >= 2, 'host 在 tool/call 与 PTC 两条路径都算动作')
  check(hostAgent.includes("from './tool-action.ts'"), 'host 引用 tool-action.ts')
  const toolAction = read('src/host/personal/tool-action.ts')
  check(toolAction.includes("from '../../client/kr-chat/plain-language.ts'"), 'host 与前端共用同一份规则表')
  check(/export function plainActionOf\(/.test(toolAction), 'host 导出 plainActionOf')

  const types = read('src/client/personal/types.ts')
  check(types.includes('action?: string') && types.includes('actionHideVerb?: true'), 'TaskRecordStep / ToolRun 契约字段存在')
}

if (failed > 0) {
  console.error('\n[task-live-action] FAILED ' + String(failed) + '/' + String(total))
  process.exit(1)
}
console.log('\n[task-live-action] all ' + String(total) + ' checks passed')
