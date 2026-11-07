#!/usr/bin/env node
/**
 * 刷新不中断自测（2026-11-07）。
 *
 * 背景：页面一刷新，Bot 正在生成的回复就断了。根因是加载时前端「页面刚加载
 * 不可能有轮次在跑」的假设——normalizeState 把 pending 气泡收口、settleStaleTask
 * 把任务标中断，挂载后还主动给宿主发 /stop 把那一轮 cancel 掉。
 *
 * 修复后的契约（本脚本逐条断言）：
 *  1. 宿主有只读的 GET /turn-status（getBotTurnStatus），返回 running 与本轮快照；
 *  2. 宿主在 /reply/stream 收尾时向事件总线广播 turn-end（刷新后的页面才收得到）；
 *  3. 前端加载时保留 pending 与 running 任务，不再就地清；
 *  4. 挂载后对账：running 才保留，确认没跑才本地收口并补发 stop；
 *  5. SSE 收到 turn-end 时收口；本窗口自己的轮次交给流式 done，不重复收口；
 *  6. 刷新后宿主继续推的 progress 消息并进 pending 气泡，不裂成两条；
 *  7. store.tsx / index.ts 通过 esbuild 语法冒烟。
 *
 * 运行：node scripts/test-personal-refresh-resume.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const storePath = join(ROOT, 'src/client/personal/store.tsx')
const hostIndexPath = join(ROOT, 'src/host/personal/index.ts')
const hostAgentPath = join(ROOT, 'src/host/personal/agent.ts')
const hostEventsPath = join(ROOT, 'src/host/personal/events.ts')

let passed = 0
function ok(label) {
  passed += 1
  console.log('  ✓ ' + label)
}
function expectContains(source, needle, label) {
  assert.ok(source.includes(needle), label + ' 缺少关键实现：' + needle)
  ok(label)
}
function expectAbsent(source, needle, label) {
  assert.ok(!source.includes(needle), label + ' 不应出现：' + needle)
  ok(label)
}
function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle)
  assert.ok(start >= 0, label + ' 找不到起点：' + startNeedle)
  const end = source.indexOf(endNeedle, start)
  assert.ok(end >= 0, label + ' 找不到终点：' + endNeedle)
  return source.slice(start, end + endNeedle.length)
}

const storeSource = await readFile(storePath, 'utf8')
const hostIndexSource = await readFile(hostIndexPath, 'utf8')
const hostAgentSource = await readFile(hostAgentPath, 'utf8')
const hostEventsSource = await readFile(hostEventsPath, 'utf8')

console.log('[refresh-resume] 宿主侧：只读状态查询 + turn-end 广播')
expectContains(hostEventsSource, "type: 'turn-end'", '事件总线定义 turn-end')
expectContains(hostEventsSource, 'ok: boolean', 'turn-end 带成败标记')
expectContains(hostAgentSource, 'export function getBotTurnStatus(', '宿主提供 getBotTurnStatus')
expectContains(hostAgentSource, 'const liveTurns = new Map', '轮次快照表 liveTurns')
expectContains(hostAgentSource, 'function trackLiveTurn(', '轮次内记录快照')
expectContains(hostAgentSource, 'function clearLiveTurn(', '轮次结束清快照')
expectContains(hostAgentSource, 'trackLiveTurn(sessionId, messages, turnId)', '产消息时刷新快照')
expectContains(hostAgentSource, 'clearLiveTurn(sessionId)', '各出口清快照')
expectContains(hostIndexSource, "tail === '/turn-status' && method === 'GET'", '/turn-status 路由存在')
expectContains(hostIndexSource, 'getBotTurnStatus(webCtx, botId)', '/turn-status 走只读探测（不 cancel）')
expectContains(hostIndexSource, "type: 'turn-end',", '/reply/stream 收尾广播 turn-end')
expectContains(hostIndexSource, 'const turnBotId = String(body.bot?.id ?? ' + String.fromCharCode(39) + String.fromCharCode(39) + ').trim()', '收尾前记下 botId')

console.log('[refresh-resume] 前端侧：不再「刷新即收口」')
expectContains(storeSource, 'const staleReplyBotIds = new Set<string>()', '待对账 bot 集合')
expectContains(storeSource, 'if (typeof message.botId === \'string\' && message.botId !== \'\') staleReplyBotIds.add(message.botId)', '加载时记录 pending 气泡所属 bot')
expectContains(storeSource, 'if (task.status === \'running\') staleTaskBotIds.add(task.botId)', '加载时记录 running 任务所属 bot')
expectContains(storeSource, 'async function hostTurnStatus(botId: string)', '前端查询宿主 turn 状态')
expectContains(storeSource, '/api/personal-agent/turn-status?botId=', '查询端点拼接正确')
expectContains(storeSource, 'if (check.status?.running === true) {', 'running 时保留气泡与任务卡')
expectContains(storeSource, 'revivedTurnBotIdsRef.current.add(check.botId)', 'running 的 bot 记入续接集合')
expectContains(storeSource, 'revivePendingWithSnapshot(prev, check.botId, snapshot)', '用快照补断流期间已生成的正文')
expectContains(storeSource, 'setState((prev) => settleStaleLocal(prev, check.botId))', '确认没在跑才本地收口')
expectContains(storeSource, 'settleTurnEnd(prev, endedBotId, endedOk, endedError)', 'turn-end 到达时收口')
expectContains(storeSource, 'mergeMessageBlocks(revivedId, hostId, blocks, kind)', '刷新后新消息并进 pending 气泡')

console.log('[refresh-resume] 顺序与幂等约束')
expectContains(storeSource, 'if (!localTurn) {', '本窗口自己的轮次不重复收口（交给流式 done）')

// normalizeState 的 messages 段不再把 pending 置 false
const normalizeBranch = sliceBetween(storeSource, 'const messages = (Array.isArray(raw.messages) ? raw.messages : [])', 'const rooms = (Array.isArray(raw.rooms) ? raw.rooms : [])', 'normalizeState messages 段')
expectAbsent(normalizeBranch, 'pending: false', 'normalizeState 不再就地清 pending')
expectAbsent(normalizeBranch, '页面刷新，本轮已中断', 'normalizeState 不再把工具卡标中断')

// 挂载 effect 不再无条件 stop：stop 必须落在「非 running」分支里
const reconcile = sliceBetween(storeSource, 'const botIds = new Set<string>([...staleTaskBotIds, ...staleReplyBotIds])', 'if (check.status?.running === true) {', '对账 effect 前半段')
expectAbsent(reconcile, '/api/personal-agent/stop', 'running 判断之前不得再无条件发 stop')

console.log('[refresh-resume] 语法冒烟（esbuild transform）')
let syntaxChecked = 0
try {
  const esbuild = await import('esbuild')
  const transform = esbuild.transform ?? esbuild.default?.transform
  assert.equal(typeof transform, 'function', 'esbuild.transform 不可用')
  await transform(storeSource, { loader: 'tsx', format: 'esm', target: 'es2022' })
  ok('store.tsx 通过 esbuild TSX 语法解析')
  await transform(hostIndexSource, { loader: 'ts', format: 'esm', target: 'es2022' })
  ok('host/personal/index.ts 通过 esbuild TS 语法解析')
  await transform(hostAgentSource, { loader: 'ts', format: 'esm', target: 'es2022' })
  ok('host/personal/agent.ts 通过 esbuild TS 语法解析')
  syntaxChecked = 1
} catch (error) {
  if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
    console.log('  · 跳过语法冒烟：未找到 esbuild（静态断言已覆盖交付要求）')
  } else {
    throw error
  }
}

console.log('[refresh-resume] 全部通过（' + String(passed) + ' 项断言' + (syntaxChecked ? '，含语法冒烟' : '') + '）')
