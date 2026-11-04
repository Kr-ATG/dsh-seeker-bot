#!/usr/bin/env node
/**
 * Personal Agent 任务进度条与委派面板（第 5 步·前端）自测。
 *
 * 数据源主次（用户补充）：
 *  · 主：当前 Bot 的 TaskRecord（state.tasks 里 botId 匹配、status==='running' 的最新一条）；
 *    委派列表从最近 20 条任务的 TaskRecord.steps 里筛 subagent / coordinate_bots 等工具步骤；
 *  · 补充：GET /api/personal-agent/assignments?botId= 返回的 AssignmentView（其他 Bot 派来的活）。
 *
 * 本脚本做源码断言 + esbuild TSX 语法冒烟：
 *  1. types.ts 有 AssignmentView（字段齐全）与 assignmentsByBot；
 *  2. store.tsx 有 refreshAssignments、3 秒轮询、非终态判断、document.hidden 暂停；
 *  3. ChatPanel.tsx 有 pa-taskbar、「第 N 步」、工具中文映射、任务与委派面板、
 *     派出的任务（TaskRecord.steps）、其他 Bot 派来的活、打开会话、空态；
 *  4. chat.css.ts 有 taskbar / assign 系列样式与窄屏适配；
 *  5. esbuild transform store.tsx / ChatPanel.tsx 语法冒烟。
 *
 * 运行：node scripts/test-personal-assignments-client.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const typesPath = join(ROOT, 'src/client/personal/types.ts')
const storePath = join(ROOT, 'src/client/personal/store.tsx')
const chatPanelPath = join(ROOT, 'src/client/personal/chat/ChatPanel.tsx')
const chatCssPath = join(ROOT, 'src/client/personal/chat/chat.css.ts')

let passed = 0

function ok(label) {
  passed += 1
  console.log(`  ✓ ${label}`)
}

function expectContains(source, needle, label) {
  assert.ok(source.includes(needle), `${label} 缺少关键实现：${needle}`)
  ok(label)
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle)
  assert.ok(start >= 0, `${label} 找不到起点：${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert.ok(end >= 0, `${label} 找不到终点：${endNeedle}`)
  return source.slice(start, end + endNeedle.length)
}

console.log('[personal-assignments-client] 静态断言：types.ts')

const typesSource = await readFile(typesPath, 'utf8')

expectContains(typesSource, 'export interface AssignmentView {', 'types 定义 AssignmentView')
expectContains(typesSource, 'requesterBotId: string', 'AssignmentView 带 requesterBotId')
expectContains(typesSource, 'assigneeBotId: string', 'AssignmentView 带 assigneeBotId')
expectContains(typesSource, "status: AssignmentStatus", 'AssignmentView 带 status')
expectContains(typesSource, 'result?: string', 'AssignmentView 带可选 result')
expectContains(typesSource, 'assignmentsByBot?: Record<string, AssignmentView[]>', 'AppState 带可选 assignmentsByBot')
expectContains(typesSource, 'export type AssignmentStatus =', 'types 定义 AssignmentStatus')

console.log('[personal-assignments-client] 静态断言：store.tsx')

const storeSource = await readFile(storePath, 'utf8')

expectContains(storeSource, 'const ASSIGNMENT_POLL_MS = 3_000', '轮询间隔为 3 秒')
expectContains(storeSource, "export function isOpenAssignment(status: AssignmentView['status']): boolean", '存在非终态判断 isOpenAssignment')
expectContains(storeSource, "'queued',", '非终态包含 queued')
expectContains(storeSource, "'running',", '非终态包含 running')
expectContains(storeSource, "'needs_input',", '非终态包含 needs_input')
expectContains(storeSource, "'waiting',", '非终态包含 waiting')
expectContains(storeSource, "'resume',", '非终态包含 resume')
expectContains(storeSource, 'function normalizeAssignmentView(raw: unknown): AssignmentView | null', '存在宿主返回数据清洗函数')
expectContains(storeSource, 'const refreshAssignments = useCallback(async (botId: string): Promise<void> => {', '存在 refreshAssignments action')
expectContains(storeSource, '/api/personal-agent/assignments?botId=', 'refreshAssignments 调 assignments 端点')
expectContains(storeSource, 'assignmentsByBot: {', 'refreshAssignments 写入 assignmentsByBot')
expectContains(storeSource, 'const hasOpenAssignments =', '存在 hasOpenAssignments 派生判断')
expectContains(storeSource, '}, ASSIGNMENT_POLL_MS)', '轮询使用 3 秒常量')
expectContains(storeSource, 'document.hidden', '轮询在 document.hidden 时暂停')
expectContains(storeSource, "document.addEventListener('visibilitychange'", '监听 visibilitychange 恢复轮询')
expectContains(storeSource, 'refreshAssignments(botId: string): Promise<void>', 'PersonalActions 声明 refreshAssignments')
expectContains(storeSource, 'refreshAssignments,', 'actions 对象与依赖挂上 refreshAssignments')

const pollBlock = sliceBetween(
  storeSource,
  'const refreshAssignments = useCallback',
  'const clearUnread = useCallback',
  'refreshAssignments 轮询段',
)
const immediatePullIndex = pollBlock.indexOf('void refreshAssignments(ui.selectedBotId)')
const intervalIndex = pollBlock.indexOf('window.setInterval(() => {')
assert.ok(immediatePullIndex >= 0, '缺少 activeBot 变化立即拉一次')
assert.ok(intervalIndex >= 0, '缺少 3 秒 setInterval 轮询')
assert.ok(immediatePullIndex < intervalIndex, '应立即拉一次在前、轮询在后')
ok('activeBot 变化立即拉一次 + 有非终态时 3 秒轮询')

console.log('[personal-assignments-client] 静态断言：ChatPanel.tsx（主数据源：TaskRecord）')

const chatSource = await readFile(chatPanelPath, 'utf8')

expectContains(chatSource, "const runningTask = botTasks.find((task) => task.status === 'running')", '主数据源：running TaskRecord')
expectContains(chatSource, '任务进行中 ·', '任务进度条有「任务进行中」文案')
expectContains(chatSource, '第 ${String(currentStepIndex + 1)} 步', '进度条显示第 N 步')
expectContains(chatSource, 'formatTaskElapsed(runningTask.startedAt)', '进度条显示耗时')
expectContains(chatSource, 'currentStepIndex', '当前动作取 steps 索引')

for (const [name, label] of [
  ['subagent', '派子任务'],
  ['web_search', '搜索网页'],
  ['read', '读取文件'],
  ['run_code', '执行命令'],
  ['write', '修改文件'],
  ['generate_image', '生成图片'],
  ['bot_create', '创建 Bot'],
  ['coordinate_bots', '派活给其他 Bot'],
]) {
  expectContains(chatSource, `${name}: '${label}'`, `工具 ${name} 映射为「${label}」`)
}

expectContains(chatSource, 'const DISPATCH_TOOL_PATTERN = /^(subagent|subagent_fork|task|coordinate_bots|bot_create)$/i', '派活步骤的工具有正则过滤')
expectContains(chatSource, 'const parsed = parseDispatchDetail(step)', '从步骤 detail 解析派活信息')
expectContains(chatSource, 'function parseDispatchDetail(step: TaskRecordStep)', '存在 parseDispatchDetail 实现')
expectContains(chatSource, "'description', 'prompt', 'message'", '从 detail 解析 description / prompt / message')
expectContains(chatSource, "'bot_id', 'botId', 'assignee_bot_id', 'assigneeBotId'", '从 detail 解析 bot_id')
expectContains(chatSource, 'pa-taskbar', '存在 pa-taskbar 进度条')
expectContains(chatSource, '任务与委派 · {activeBot.name}', '面板标题「任务与委派 · {bot.name}」')
expectContains(chatSource, '派出的任务', '面板有「派出的任务」区块')
expectContains(chatSource, '其他 Bot 派来的活', 'assignments 端点作为「其他 Bot 派来的活」补充')
expectContains(chatSource, '打开会话', '委派行有「打开会话」')
expectContains(chatSource, 'actions.selectBot(', '打开会话调用 actions.selectBot')
expectContains(chatSource, '还没有任务与委派记录。Bot 执行任务或派出子任务时，会在这里显示。', '面板有空态文案')
expectContains(chatSource, "case 'queued': return '排队'", '状态文案：排队')
expectContains(chatSource, "case 'running': return '进行中'", '状态文案：进行中')
expectContains(chatSource, "case 'needs_input': return '等输入'", '状态文案：等输入')
expectContains(chatSource, "case 'waiting': return '等待子活'", '状态文案：等待子活')
expectContains(chatSource, "case 'completed': return '完成'", '状态文案：完成')
expectContains(chatSource, "case 'failed': return '失败'", '状态文案：失败')
expectContains(chatSource, "case 'cancelled': return '已取消'", '状态文案：已取消')

console.log('[personal-assignments-client] 静态断言：chat.css.ts')

const cssSource = await readFile(chatCssPath, 'utf8')

expectContains(cssSource, '.pa-taskbar {', '存在任务进度条样式')
expectContains(cssSource, '.pa-taskbar__dot {', '存在进度条状态点样式')
expectContains(cssSource, '.pa-assign {', '存在任务与委派面板样式')
expectContains(cssSource, '.pa-assign__timeline {', '存在任务时间线样式')
expectContains(cssSource, '.pa-assign__list {', '存在委派列表样式')
expectContains(cssSource, ".pa-assign__status[data-status='running']", '存在 running 状态配色')
expectContains(cssSource, '.pa-assign__open {', '存在打开会话按钮样式')
expectContains(cssSource, '@media (max-width: 680px)', '存在窄屏适配')

console.log('[personal-assignments-client] 语法冒烟：esbuild transform')

let syntaxChecked = false
try {
  const esbuild = await import('esbuild')
  const transform = esbuild.transform ?? esbuild.default?.transform
  assert.equal(typeof transform, 'function', 'esbuild.transform 不可用')
  for (const file of [storePath, chatPanelPath]) {
    const source = await readFile(file, 'utf8')
    await transform(source, { loader: 'tsx', format: 'esm', target: 'es2022' })
  }
  syntaxChecked = true
  ok('store.tsx / ChatPanel.tsx 通过 esbuild TSX 语法解析')
} catch (error) {
  if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
    console.log('  · 跳过语法冒烟：未找到 esbuild（静态断言已覆盖交付要求）')
  } else {
    throw error
  }
}

console.log(`[personal-assignments-client] 全部通过（${String(passed)} 项断言${syntaxChecked ? '，含语法冒烟' : ''}）`)
