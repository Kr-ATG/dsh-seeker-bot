#!/usr/bin/env node
/**
 * Personal Agent SSE 路径 progress 合并自测。
 *
 * 背景：host 的「多消息切分」会把模型每段正文变成一条独立 progress 消息。
 * /reply/stream 路径有 2.5 progress 合并（lastProgressId + mergeMessageBlocks），
 * 但页面实时接收走常驻 SSE（/api/personal-agent/events），SSE 的 message 分支
 * 原来直接 appendMessage，导致每条 progress 都独立落地（一句一个气泡）。
 *
 * 本脚本做纯源码断言 + esbuild 语法冒烟：
 *  1. 存在 sseProgressChains（按 botId 记录 progress 合并链）；
 *  2. SSE 收到新 progress 消息才尝试合并，复用 mergeMessageBlocks / hostMessageIds；
 *  3. 合并条件含 turnId 兼容校验与链头消息 kind 校验；
 *  4. 非 progress 消息落地即断链（delete），新 progress 落地后建链（set）；
 *  5. message-update 的 known → updateMessageBlocks 分支保持原样；
 *  6. /reply/stream 既有的 lastProgressId 合并链未被破坏；
 *  7. esbuild transform store.tsx 语法冒烟。
 *
 * 运行：node scripts/test-personal-sse-merge.mjs
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

console.log('[sse-merge] 静态断言：store.tsx 常驻 SSE progress 合并')

const storeSource = await readFile(storePath, 'utf8')

// —— 合并链 ref ——
expectContains(
  storeSource,
  'const sseProgressChains = useRef<Map<string, { messageId: string; turnId?: string }>>(new Map())',
  '存在按 botId 记录 progress 合并链的 sseProgressChains ref',
)

// —— SSE 消息处理段（从 message / message-update 入口到新消息 append） ——
const sseMessageBranch = sliceBetween(
  storeSource,
  "if (payload?.type !== 'message' && payload?.type !== 'message-update') return",
  "const id = shortId('msg')",
  'SSE message 分支',
)

// progress 合并只在 payload.type === 'message' 时进行（message-update 保持原样）
expectContains(sseMessageBranch, "if (payload.type === 'message' && kind === 'progress')", 'SSE 只对新的 message 事件尝试合并 progress')
expectContains(sseMessageBranch, 'const chain = sseProgressChains.current.get(botId)', '按 botId 取当前 progress 合并链')
expectContains(sseMessageBranch, 'mergeMessageBlocks(chain.messageId, hostId, blocks, kind)', '复用 mergeMessageBlocks 把 blocks 并进链头消息')
expectContains(sseMessageBranch, 'hostMessageIds.current.set(hostId, chain.messageId)', '被合并的 host 消息映射到链头前端消息 id')
expectContains(sseMessageBranch, 'const target = stateRef.current.messages.find((message) => message.id === chain.messageId)', '合并前确认链头消息仍在 state 里')
expectContains(sseMessageBranch, "turnCompatible && target !== undefined && target.kind === 'progress'", '合并条件包含 turnId 兼容与链头 kind 校验')

// turnId 兼容：任一方缺省或相等
expectContains(
  sseMessageBranch,
  'const turnCompatible = chain.turnId === undefined || turnId === undefined || chain.turnId === turnId',
  'turnId 兼容规则：任一方 undefined 或相等',
)

// 合并后直接 return，不再走 append
const mergeCallIndex = sseMessageBranch.indexOf('mergeMessageBlocks(chain.messageId, hostId, blocks, kind)')
const mergeReturnIndex = sseMessageBranch.indexOf('return', mergeCallIndex)
assert.ok(mergeReturnIndex > mergeCallIndex, 'mergeMessageBlocks 之后应 return，不再 append 新气泡')
ok('合并 progress 后 return，不再新建气泡')

// 非 progress 断链在 known 检查之前
const deleteIndex = sseMessageBranch.indexOf("if (kind !== 'progress') sseProgressChains.current.delete(botId)")
const knownIndex = sseMessageBranch.indexOf('const known = hostMessageIds.current.get(hostId)')
assert.ok(deleteIndex >= 0, '缺少非 progress 断链 delete 调用')
assert.ok(knownIndex >= 0, '缺少 hostMessageIds known 检查')
assert.ok(deleteIndex < knownIndex, '非 progress 断链必须先于 known 分支执行')
ok('非 progress 消息先断链，再走原 known / append 逻辑')

// progress 合并块在 known 之后：hostId 已落地的不重复合并
const progressMergeIndex = sseMessageBranch.indexOf("if (payload.type === 'message' && kind === 'progress')")
assert.ok(progressMergeIndex > knownIndex, 'progress 合并分支必须放在 known 检查之后（只处理新消息）')
ok('progress 合并只处理 hostId 未见过的新消息')

// 新 progress 落地后建链
expectContains(
  storeSource,
  'sseProgressChains.current.set(botId, { messageId: id, ...(turnId !== undefined ? { turnId } : {}) })',
  '新 progress 消息落地后成为新的链头',
)

// message-update 的 known → updateMessageBlocks 分支保持原样（mergedSegments 按 hostId 换段）
expectContains(
  sseMessageBranch,
  'updateMessageBlocks(known, blocks, kind, hostId, replyTo, turnId, undefined, eventRoomId)',
  'message-update 的 known 分支保持原样（按 hostId 换段）',
)

// —— /reply/stream 既有合并链未被破坏 ——
expectContains(storeSource, 'let lastProgressId: string | null = null', '/reply/stream 的 lastProgressId 合并链仍在')
expectContains(
  storeSource,
  'mergeMessageBlocks(lastProgressId, hostMessage.id, hostMessage.blocks, hostMessage.kind)',
  '/reply/stream 仍复用 mergeMessageBlocks',
)

// —— SSE effect 仍连接常驻事件流 ——
const sseEffect = sliceBetween(storeSource, 'const source = new EventSource(', 'return () => source.close()', 'SSE effect')
expectContains(sseEffect, '/api/personal-agent/events?botId=*', 'SSE 仍连接常驻事件流')

// —— 语法冒烟（可选）：esbuild transform 不解析依赖，只验证 TSX 语法 ——
console.log('[sse-merge] 语法冒烟：store.tsx（esbuild transform）')

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

console.log(`[sse-merge] 全部通过（${String(passed)} 项断言${syntaxChecked ? '，含语法冒烟' : ''}）`)
