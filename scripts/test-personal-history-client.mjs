#!/usr/bin/env node
/**
 * Personal Agent 历史消息增量同步（前端）自测。
 *
 * 覆盖第 3 步「历史消息增量同步到宿主索引」的客户端部分（纯源码断言，不启动浏览器）：
 *  1. store.tsx 接入 POST /api/personal-agent/history/index；
 *  2. PersonalProvider 内有防抖 1500ms 的同步 effect，监听 state.messages；
 *  3. 只取 Bot 私聊（roomId === undefined）、非 system、非 pending、text 块拼接非空的
 *     最近 500 条；
 *  4. 每个 Bot 只发一次请求，请求体为 { botId, messages }，role 映射 user / bot；
 *  5. 失败静默（catch 不 toast）、指纹相同跳过、卸载清理 timer。
 *  6. 可选语法冒烟：用项目自带 esbuild 对 store.tsx 做 TSX 语法解析。
 *
 * 运行：node scripts/test-personal-history-client.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const storePath = join(ROOT, 'src/client/personal/store.tsx')

let passed = 0

function ok(label) {
  passed += 1
  console.log(`  ✓ ${label}`)
}

function expectContains(source, needle, label) {
  assert.ok(source.includes(needle), `${label} 缺少关键实现：${needle}`)
  ok(label)
}

function expectAbsent(source, needle, label) {
  assert.ok(!source.includes(needle), `${label} 不应出现：${needle}`)
  ok(label)
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle)
  assert.ok(start >= 0, `${label} 找不到起点：${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert.ok(end >= 0, `${label} 找不到终点：${endNeedle}`)
  return source.slice(start, end + endNeedle.length)
}

console.log('[personal-history-client] 静态断言：store.tsx 历史索引同步')

const storeSource = await readFile(storePath, 'utf8')

// —— 端点与契约 ——
assert.equal(
  (storeSource.match(/'\/api\/personal-agent\/history\/index'/g) ?? []).length,
  1,
  '历史索引端点应只在一处定义（pushHistoryIndex）',
)
ok('store 只引用一次 POST /api/personal-agent/history/index')

const pushStart = storeSource.indexOf('async function pushHistoryIndex')
assert.ok(pushStart >= 0, '找不到 pushHistoryIndex 实现')
const pushEnd = storeSource.indexOf('\n}\n', pushStart)
assert.ok(pushEnd >= 0, 'pushHistoryIndex 函数体未正常闭合')
const pushFn = storeSource.slice(pushStart, pushEnd + 3)
expectContains(pushFn, "await fetch('/api/personal-agent/history/index'", 'pushHistoryIndex 调用宿主历史索引端点')
expectContains(pushFn, "method: 'POST'", '历史索引接口用 POST')
expectContains(pushFn, "headers: { 'content-type': 'application/json' }", '请求头为 JSON')
expectContains(pushFn, 'JSON.stringify({ botId, messages: batch })', '请求体是 { botId, messages }')
expectContains(pushFn, 'catch {', 'history/index 请求包在 try/catch 里')
expectAbsent(pushFn, 'toast(', '失败静默：catch 分支不调 toast')

// —— 防抖常量 / 条数上限 ——
expectContains(storeSource, 'const HISTORY_SYNC_DEBOUNCE_MS = 1_500', '防抖常量为 1500ms')
expectContains(storeSource, 'const HISTORY_SYNC_MESSAGES_MAX = 500', '每个 Bot 最多同步 500 条')

// —— 同步 effect ——
const effectBlock = sliceBetween(
  storeSource,
  '/*\n   * 历史消息增量同步到宿主索引（第 3 步）。',
  '}, [state.messages])',
  '历史同步 effect',
)
expectContains(effectBlock, 'if (isDemoMode()) return undefined', '演示页不发起宿主请求')
expectContains(effectBlock, 'const fingerprint = historySyncFingerprint(latestMessages)', '防抖回调里按消息指纹判断是否需要同步')
expectContains(effectBlock, 'if (fingerprint === lastHistorySyncRef.current) return', '指纹相同跳过，避免重复 POST')
expectContains(effectBlock, 'if (historySyncTimerRef.current !== null) window.clearTimeout(historySyncTimerRef.current)', '防抖前清理旧 timer')
expectContains(effectBlock, 'window.setTimeout(() => {', '用 setTimeout 做防抖')
expectContains(effectBlock, '}, HISTORY_SYNC_DEBOUNCE_MS)', '防抖时长使用 1500ms 常量')
expectContains(effectBlock, 'const groups = collectHistoryIndexGroups(latestMessages)', '同步时按 Bot 分组抽取消息')
expectContains(effectBlock, 'for (const group of groups) void pushHistoryIndex(group.botId, group.messages)', '每个 Bot 只发一次请求')
expectContains(effectBlock, 'lastHistorySyncRef.current = fingerprint', '发送时更新指纹 ref')

// —— 消息抽取：过滤条件 + text 拼接 + 最近 500 条 ——
const collectStart = storeSource.indexOf('function collectHistoryIndexGroups')
assert.ok(collectStart >= 0, '找不到 collectHistoryIndexGroups 实现')
const collectEnd = storeSource.indexOf('\n}\n', collectStart)
const collectFn = storeSource.slice(collectStart, collectEnd + 3)
expectContains(collectFn, 'if (message.roomId !== undefined) continue', '只取私聊（群聊不参与）')
expectContains(collectFn, "if (message.role === 'system') continue", '系统消息不同步')
expectContains(collectFn, 'if (message.pending === true) continue', '生成中的占位消息不同步')
const textStart = storeSource.indexOf('function historyIndexText')
assert.ok(textStart >= 0, '找不到 historyIndexText 实现')
const textEnd = storeSource.indexOf('\n}\n', textStart)
const textFn = storeSource.slice(textStart, textEnd + 3)
expectContains(textFn, ".map((block) => (block.type === 'text' ? block.text : ''))", '只拼接 text 块正文')
expectContains(textFn, ".filter((part) => part !== '')", '过滤空 text 块')
expectContains(textFn, ".join('\\n')", '多段正文用换行拼接')
expectContains(textFn, '.trim()', '正文去首尾空白')
expectContains(collectFn, 'if (text === \'\') continue', '正文为空的消息不同步')
expectContains(collectFn, 'grouped.get(message.botId)', '按 botId 分组')
expectContains(collectFn, 'messages: batch.slice(-HISTORY_SYNC_MESSAGES_MAX)', '每个 Bot 取最近 500 条')
expectContains(collectFn, "role: message.role === 'user' ? 'user' : 'bot'", 'role 映射为宿主契约的 user / bot')
expectContains(collectFn, 'id: message.id', '消息带 id（宿主按 id 去重）')
expectContains(collectFn, 'at: message.at', '消息带 at 时间戳')

// —— 指纹 / timer ref / 卸载清理 ——
expectContains(storeSource, 'const lastHistorySyncRef = useRef<string>(\'\')', '用 ref 记录上次同步的消息指纹')
expectContains(storeSource, 'const historySyncTimerRef = useRef<number | null>(null)', '防抖 timer 用 ref 持有')
expectContains(storeSource, 'function historySyncFingerprint(messages: Message[]): string', '存在消息指纹函数')
const cleanupBlock = sliceBetween(
  storeSource,
  'useEffect(() => () => {',
  'if (callDraftTimerRef.current !== null) clearTimeout(callDraftTimerRef.current)',
  '卸载清理 effect',
)
expectContains(cleanupBlock, 'if (historySyncTimerRef.current !== null) {', '卸载时检查历史同步 timer')
expectContains(cleanupBlock, 'window.clearTimeout(historySyncTimerRef.current)', '卸载时清理历史同步 timer')

// —— 语法冒烟（可选）：esbuild transform 不解析依赖，只验证 TSX 语法 ——
console.log('[personal-history-client] 语法冒烟：store.tsx（esbuild transform）')

let syntaxChecked = false
try {
  const esbuild = await import('esbuild')
  const transform = esbuild.transform ?? esbuild.default?.transform
  assert.equal(typeof transform, 'function', 'esbuild.transform 不可用')
  await transform(storeSource, { loader: 'tsx', format: 'esm', target: 'es2022' })
  syntaxChecked = true
  ok('store.tsx 通过 esbuild TSX 语法解析')
} catch (error) {
  if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
    console.log('  · 跳过语法冒烟：未找到 esbuild（静态断言已覆盖交付要求）')
  } else {
    throw error
  }
}

console.log(`[personal-history-client] 全部通过（${String(passed)} 项断言${syntaxChecked ? '，含语法冒烟' : ''}）`)
