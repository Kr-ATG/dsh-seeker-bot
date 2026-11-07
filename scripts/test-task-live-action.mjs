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
 *  4. **双行 + 交叉淡入**：窄屏（397px）读得全，换动作时不硬闪。
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
      `export { actionLabelOf, stepActionViewOf, toolActionOf, briefOf } from '${slash(resolve(ROOT, 'src/client/personal/shell/task-action.ts'))}'`,
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

const { plainActionOf, actionLabelOf, stepActionViewOf, toolActionOf, briefOf } = mod

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

console.log('[task-live-action] 源码契约')
{
  const card = read('src/client/personal/shell/TaskRecordCard.tsx')
  // 注释里允许引用用户口径（说明为什么删掉），这里钉死的是**不再把它当文案**。
  check(!/['"\u2018\u2019]正在整理回复/.test(card), '动态卡不再有「正在整理回复…」兜底')
  check(card.includes('useCrossfadeText') && card.includes('useMotionAllowed'), '换动作走交叉淡入（motion-utils）')
  check(card.includes('正在思考'), '没有任何动作时给「正在思考」，不是「正在处理」')
  check(card.includes('briefOf('), '没有 running 动作时取最后一条过程说明的首句')
  check(card.includes('actionLabelOf('), 'running 动作走 actionLabelOf（同一份规则表）')

  const action = read('src/client/personal/shell/task-action.ts')
  check(action.includes("from '../../kr-chat/plain-language.ts'"), '动作规则表复用 plain-language（只有一份）')
  check(action.includes('export function stepActionViewOf('), '对外导出 stepActionViewOf')
  check(action.includes('step.action') && action.includes('actionHideVerb'), '优先用 host 算好的 action')

  const css = read('src/client/personal/shell/tasks.css.ts')
  check(css.includes('-webkit-line-clamp: 2'), '动作文案最多两行（窄屏读得全）')
  check(css.includes('pa-taskrec-live-in') && css.includes('pa-taskrec-live-out'), '交叉淡入关键帧存在')
  // 窄容器（手机分栏 / 用户拖窄右栏）下 meta 必须换行，不能把动作压成竖排几字。
  check(/flex-wrap:\s*wrap/.test(css) && /flex:\s*1 1 120px/.test(css), '窄容器下 meta 换行、动作不被压扁')
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
