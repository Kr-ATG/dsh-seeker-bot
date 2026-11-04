#!/usr/bin/env node
/**
 * Personal Agent 接力摘要「前端」自测。
 *
 * 覆盖「整理并开新会话」这条链路的前端部分：
 *  1. **源码断言**：store.tsx 是否接上 /relay/prepare、/relay/commit；消息抽取是否只取
 *     私聊 text 块并限流到 RELAY_MESSAGES_MAX；clearConversation 是否按 relay 分流；
 *     ChatPanel 是否有「整理并开新会话 / 正在整理… / 确认并开新会话 / 直接清空」两段式流程与
 *     摘要预览；chat.css.ts 是否有 pa-relay-preview 样式。
 *  2. **运行时冒烟**：用项目自带 esbuild 把 src/shared/relay.ts 打成一个临时 ESM 包再 import，
 *     验证 normalizeRelayBrief / buildRelayBlock / fallbackRelayBrief 的核心语义。
 *     esbuild 不可用时这一层跳过（不算失败）——静态断言已覆盖交付要求。
 *
 * 运行：node scripts/test-personal-relay-client.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const storePath = join(root, 'src/client/personal/store.tsx')
const chatPanelPath = join(root, 'src/client/personal/chat/ChatPanel.tsx')
const chatCssPath = join(root, 'src/client/personal/chat/chat.css.ts')
const relayContractPath = join(root, 'src/shared/relay.ts')

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

function expectNear(source, anchor, needle, label, distance = 900) {
  const index = source.indexOf(anchor)
  assert.ok(index >= 0, `${label} 找不到锚点：${anchor}`)
  const window = source.slice(index, index + distance)
  assert.ok(window.includes(needle), `${label} 的 ${anchor} 附近没有 ${needle}`)
  ok(label)
}

console.log('[relay-client] 静态断言：store.tsx')

const storeSource = await readFile(storePath, 'utf8')

expectContains(storeSource, "from '../../shared/relay.ts'", 'store 从 shared 导入接力契约（不改契约本体）')
expectContains(storeSource, 'RELAY_MESSAGES_MAX', 'store 使用契约的 RELAY_MESSAGES_MAX 上限')
expectContains(storeSource, 'prepareRelay(botId: string): Promise<{ brief: RelayBrief; degraded: boolean; error?: string } | null>', 'actions 声明 prepareRelay 返回 brief/degraded/error')
expectContains(storeSource, 'const prepareRelay = useCallback(async (botId: string)', 'prepareRelay 有实际实现（不是空声明）')
expectContains(storeSource, "'/api/personal-agent/relay/prepare'", 'prepareRelay 调 POST /relay/prepare')
expectContains(storeSource, 'message.roomId === undefined', '只取私聊消息（群聊不参与）')
expectContains(storeSource, '(message.botId === botId || message.senderId === botId)', '消息按 botId / senderId 归属过滤')
expectContains(storeSource, "message.role !== 'system'", '系统消息不进摘要素材')
expectContains(storeSource, 'message.pending !== true', '生成中的占位消息不进摘要素材')
expectContains(storeSource, '.slice(-RELAY_MESSAGES_MAX)', '只取最近 40 条（slice(-RELAY_MESSAGES_MAX)）')
expectContains(storeSource, ".map((block) => (block.type === 'text' ? block.text : ''))", '只拼接 text 块正文')
expectContains(storeSource, 'provider: bot.model.provider', '请求体带 botModel.provider')
expectContains(storeSource, 'model: bot.model.model', '请求体带 botModel.model')
expectContains(storeSource, 'effort: bot.model.effort', '请求体带 botModel.effort')
expectContains(storeSource, 'degraded: data.degraded === true', '把宿主 degraded 标记透传给确认卡')
expectContains(storeSource, '整理失败', 'prepare 失败时 toast 提示')
expectContains(storeSource, "const clearConversation = useCallback(async (botId: string, options?: { relay?: RelayBrief; keepMessages?: boolean }): Promise<void> => {", 'clearConversation 接受 options.relay')
expectContains(storeSource, "if (options?.relay !== undefined) {", 'clearConversation 按有没有 relay 分流')
expectContains(storeSource, "fetch('/api/personal-agent/relay/commit'", '有 relay 时调 POST /relay/commit')
expectContains(storeSource, 'JSON.stringify({ botId, brief: options.relay })', 'commit 请求体带 botId + brief')
expectContains(storeSource, '已整理上一段对话，并开启新会话', 'commit 成功文案符合验收')
expectContains(storeSource, '宿主侧没清干净', 'commit 失败说明宿主侧未清干净')
expectContains(storeSource, "await fetch('/api/personal-agent/reset'", '没有 relay 时仍走原 /reset 行为')
expectContains(storeSource, 'prepareRelay,\n    clearConversation,', 'actions 对象挂上 prepareRelay')
expectContains(storeSource, 'proactiveNow, prepareRelay, clearConversation,', 'actions useMemo 依赖包含 prepareRelay')

console.log('[relay-client] 静态断言：ChatPanel.tsx')

const chatPanelSource = await readFile(chatPanelPath, 'utf8')

expectContains(chatPanelSource, "import type { RelayBrief } from '../../../shared/relay.ts'", 'ChatPanel 引用共享 RelayBrief 类型')
expectContains(chatPanelSource, '整理并开新会话', '主操作按钮文案「整理并开新会话」')
expectContains(chatPanelSource, '正在整理…', '生成中按钮显示「正在整理…」')
expectContains(chatPanelSource, '确认并开新会话', '摘要就绪后按钮变「确认并开新会话」')
expectContains(chatPanelSource, '直接清空', '保留次操作「直接清空」')
expectContains(chatPanelSource, 'actions.prepareRelay(target.id)', '主操作点击调 actions.prepareRelay')
expectContains(chatPanelSource, 'actions.clearConversation(target.id, { relay: relayBrief, keepMessages: true })', '确认点击调 clearConversation(id, { relay, keepMessages })')
expectContains(chatPanelSource, '模型不可用，已用最近对话生成简易摘要', 'degraded 时提示模型不可用已用简易摘要')
expectContains(chatPanelSource, "relay.status === 'preparing'", '按钮/提示按 preparing 状态切换')
expectContains(chatPanelSource, "disabled={relay.status === 'preparing'}", '生成中主按钮禁用')
expectContains(chatPanelSource, '整理失败，请稍后重试；也可以直接清空对话。', 'prepare 失败显示错误文案且仍可清空')
expectContains(chatPanelSource, 'function RelayPreview({ brief }: { brief: RelayBrief })', '摘要预览抽成 RelayPreview 组件')
expectContains(chatPanelSource, 'group.items.slice(0, 5)', '预览每组最多 5 条')
expectContains(chatPanelSource, "label: '关键决策与约束'", '预览含关键决策与约束组')
expectContains(chatPanelSource, "label: '相关文件'", '预览含相关文件组')
expectContains(chatPanelSource, 'relayRequestRef', '迟到的摘要结果会被请求序号丢弃')
expectContains(chatPanelSource, 'clearTargetRef', '异步回调按当前清空目标校验，避免串 Bot')

console.log('[relay-client] 静态断言：chat.css.ts')

const chatCssSource = await readFile(chatCssPath, 'utf8')
expectContains(chatCssSource, '.pa-relay-preview {', '存在 pa-relay-preview 容器样式')
expectContains(chatCssSource, '.pa-relay-preview__label', '存在字段标签样式')
expectContains(chatCssSource, '.pa-relay-preview__list', '存在列表样式')
expectContains(chatCssSource, 'background: var(--pa-chat-glass);', '预览底色吃 pa-* 变量（主题自适应）')
expectContains(chatCssSource, '.pa-relay-preview__degraded', '存在 degraded 提示样式')

console.log('[relay-client] 运行时冒烟：src/shared/relay.ts')

let runtimeChecked = false
let tempDir = null
try {
  const esbuild = await import('esbuild')
  const build = esbuild.build ?? esbuild.default?.build
  assert.equal(typeof build, 'function', 'esbuild.build 不可用')

  tempDir = await mkdtemp(join(tmpdir(), 'relay-client-test-'))
  const outfile = join(tempDir, 'relay.mjs')
  await build({
    entryPoints: [relayContractPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    logLevel: 'silent',
  })
  const relay = await import(pathToFileURL(outfile).href)

  assert.equal(relay.RELAY_MESSAGES_MAX, 40, '前端最多送 40 条消息')
  assert.equal(relay.RELAY_MAX_ITEMS, 12, '单字段最多 12 条')
  ok('契约常量可被前端消费（RELAY_MESSAGES_MAX / RELAY_MAX_ITEMS）')

  const normalized = relay.normalizeRelayBrief({
    goal: '  把接力摘要接到清空对话流程  ',
    done: ['实现 prepareRelay', '实现 prepareRelay', ''],
    decisions: ['不改 src/shared/relay.ts'],
    pending: ['宿主队友实现 relay 端点'],
    next: ['跑 test-personal-relay-client.mjs'],
    files: ['src/client/personal/store.tsx'],
    updatedAt: 1700000000000,
  })
  assert.ok(normalized !== null, '合法输入应返回 RelayBrief')
  assert.equal(normalized.goal, '把接力摘要接到清空对话流程', 'goal 压缩空白')
  assert.deepEqual(normalized.done, ['实现 prepareRelay'], 'done 去重并过滤空串')
  assert.deepEqual(normalized.decisions, ['不改 src/shared/relay.ts'])
  assert.equal(normalized.updatedAt, 1700000000000)
  ok('normalizeRelayBrief 清洗合法模型输出')

  assert.equal(relay.normalizeRelayBrief({ done: 'not-an-array' }), null, '全空 / 类型错误 → null（调用方走兜底）')
  assert.equal(relay.normalizeRelayBrief(null), null)
  ok('normalizeRelayBrief 对残缺 / 全空输出返回 null')

  const block = relay.buildRelayBlock({
    goal: '目标A',
    done: ['完成A'],
    decisions: ['约束A'],
    pending: ['待办A'],
    next: ['下一步A'],
    files: ['a.ts'],
    updatedAt: 1,
  })
  assert.ok(block.startsWith('【接力摘要 · 上一段对话】'))
  assert.ok(block.includes('目标：目标A'))
  assert.ok(block.includes('已完成：完成A'))
  assert.ok(block.includes('关键决策/约束：约束A'))
  assert.ok(block.includes('未完成：待办A'))
  assert.ok(block.includes('下一步：下一步A'))
  assert.ok(block.includes('相关文件：a.ts'))
  assert.equal(relay.buildRelayBlock(null), '', 'null brief 不注入')
  assert.equal(relay.buildRelayBlock({ goal: '', done: [], decisions: [], pending: [], next: [], files: [], updatedAt: 1 }), '', '空 brief 不注入空块')
  ok('buildRelayBlock 只输出有内容字段且 null/空返回空串')

  assert.equal(relay.fallbackRelayBrief([]), null, '没有消息时没有兜底摘要')
  const fallback = relay.fallbackRelayBrief([
    { role: 'user', text: '帮我修一下接力摘要', at: 1000 },
    { role: 'bot', text: '已定位到 store.tsx', at: 2000 },
    { role: 'bot', text: '正在补 ChatPanel', at: 3000 },
  ])
  assert.ok(fallback !== null)
  assert.equal(fallback.goal, '继续：帮我修一下接力摘要')
  assert.deepEqual(fallback.done, ['正在补 ChatPanel', '已定位到 store.tsx'], 'done 取最近 bot 回复（新的在前）')
  assert.equal(fallback.updatedAt > 0, true)
  ok('fallbackRelayBrief 用最后 user + 最近 bot 生成最低限度摘要')

  runtimeChecked = true
} catch (error) {
  if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
    console.log('  · 跳过运行时冒烟：未找到 esbuild（静态断言已覆盖交付要求）')
  } else {
    throw error
  }
} finally {
  if (tempDir !== null) await rm(tempDir, { recursive: true, force: true })
}

console.log(`[relay-client] 全部通过（${String(passed)} 项断言${runtimeChecked ? '，含运行时' : ''}）`)
