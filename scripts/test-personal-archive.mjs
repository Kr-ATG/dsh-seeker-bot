#!/usr/bin/env node
/**
 * Personal Agent 历史对话归档自测。
 *
 * 背景：用户反馈点「整理并开新会话」/「直接清空」后聊天记录消失。设计原则：
 * 清模型上下文 ≠ 清聊天记录——当前会话可以清空，旧消息先归档到
 * AppState.archivedSessions，ChatPanel「历史对话」面板只读回看。
 *
 * 本脚本做纯源码断言 + esbuild 语法冒烟：
 *  1. types.ts 有 ArchivedSession（含 relay?: RelayBrief）与 archivedSessions；
 *  2. store.tsx 有归档上限常量、normalizeArchivedSessions 清洗、archiveConversation、
 *     deleteArchivedSession；clearConversation 先归档再清空；
 *  3. ChatPanel.tsx 有「历史对话」菜单项、只读面板（列表 / 展开预览 / 删除 / 空态 /
 *     含接力摘要标记）以及新的清空确认卡文案；
 *  4. chat.css.ts 有 pa-archive 系列样式与窄屏适配；
 *  5. esbuild transform store.tsx / ChatPanel.tsx 语法冒烟。
 *
 * 运行：node scripts/test-personal-archive.mjs
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

console.log('[personal-archive] 静态断言：types.ts')

const typesSource = await readFile(typesPath, 'utf8')

expectContains(typesSource, "import type { RelayBrief } from '../../shared/relay.ts'", 'types 导入共享 RelayBrief 类型')
expectContains(typesSource, 'export interface ArchivedSession {', 'types 定义 ArchivedSession')
expectContains(typesSource, 'relay?: RelayBrief', 'ArchivedSession 带可选 relay 摘要')
expectContains(typesSource, 'archivedSessions?: ArchivedSession[]', 'AppState 带可选 archivedSessions（旧数据缺省）')
expectContains(typesSource, 'messageCount: number', 'ArchivedSession 有 messageCount')
expectContains(typesSource, 'archivedAt: number', 'ArchivedSession 有 archivedAt')

console.log('[personal-archive] 静态断言：store.tsx')

const storeSource = await readFile(storePath, 'utf8')

expectContains(storeSource, 'const MAX_ARCHIVED_SESSIONS = 30', '最多保留 30 个归档')
expectContains(storeSource, 'const ARCHIVED_SESSION_MESSAGES_MAX = 500', '每个归档最多 500 条消息')
expectContains(storeSource, 'const ARCHIVED_SESSION_TITLE_MAX = 30', '归档标题截前 30 字')
expectContains(storeSource, 'function normalizeArchivedSessions(raw: unknown): ArchivedSession[]', '存在 normalizeArchivedSessions 清洗函数')
expectContains(storeSource, 'normalizeArchivedSessions(raw.archivedSessions)', 'normalizeState 接入 archivedSessions')
expectContains(storeSource, 'slice(-ARCHIVED_SESSION_MESSAGES_MAX)', '每个归档只保留最近 500 条消息')
expectContains(storeSource, '.slice(0, MAX_ARCHIVED_SESSIONS)', '归档总数只保留最近 30 个')
expectContains(storeSource, 'function buildArchivedSession(', '存在 buildArchivedSession 构造函数')
expectContains(storeSource, "truncate(blocksToText(firstUser.blocks), ARCHIVED_SESSION_TITLE_MAX)", '标题取首条 user 消息正文前 30 字')
expectContains(storeSource, "'未命名对话'", '没有 user 消息时标题兜底「未命名对话」')
expectContains(storeSource, 'const archiveConversation = useCallback((botId: string, relay?: RelayBrief): string | null => {', '存在 archiveConversation 内部函数')
expectContains(storeSource, 'archivedSessions: [record, ...(prev.archivedSessions ?? [])].slice(0, MAX_ARCHIVED_SESSIONS)', 'archiveConversation 把归档插到列表头并限 30 个')
expectContains(storeSource, 'const deleteArchivedSession = useCallback((id: string): void => {', '存在 deleteArchivedSession action')
expectContains(storeSource, 'deleteArchivedSession,', 'actions 对象与依赖挂上 deleteArchivedSession')

// clearConversation：先归档再清空
const clearStart = storeSource.indexOf('const clearConversation = useCallback')
assert.ok(clearStart >= 0, '找不到 clearConversation 实现')
const clearEndMarker = '}, [toast, archiveConversation])'
const clearEnd = storeSource.indexOf(clearEndMarker, clearStart)
assert.ok(clearEnd >= 0, '找不到 clearConversation 结尾（依赖应含 archiveConversation）')
const clearBlock = storeSource.slice(clearStart, clearEnd + clearEndMarker.length)
const archiveCallIndex = clearBlock.indexOf('archiveConversation(botId, options?.relay)')
const clearMessagesIndex = clearBlock.indexOf('messages: prev.messages.filter')
assert.ok(archiveCallIndex >= 0, 'clearConversation 没有调用 archiveConversation')
assert.ok(clearMessagesIndex > archiveCallIndex, 'clearConversation 必须先归档再清空本地消息')
ok('clearConversation 先归档再清空本地消息')

// 归档范围：只收私聊消息
expectContains(storeSource, 'message.roomId === undefined', '归档只取私聊消息（群聊不参与）')
expectContains(storeSource, '(message.botId === botId || message.senderId === botId)', '归档按 botId / senderId 归属过滤')
expectContains(storeSource, '.sort((a, b) => a.at - b.at)', '归档消息按 at 升序')

console.log('[personal-archive] 静态断言：ChatPanel.tsx')

const chatPanelSource = await readFile(chatPanelPath, 'utf8')

expectContains(chatPanelSource, '历史对话', '更多菜单有「历史对话」入口')
expectContains(chatPanelSource, 'const [historyOpen, setHistoryOpen] = useState(false)', '历史面板有打开状态')
expectContains(chatPanelSource, 'const [expandedArchiveId, setExpandedArchiveId] = useState<string | null>(null)', '历史面板有展开的归档状态')
expectContains(chatPanelSource, '历史对话 · {activeBot.name}', '面板标题为「历史对话 · {bot.name}」')
expectContains(chatPanelSource, '还没有历史对话。开新会话时，旧对话会自动归档在这里。', '历史面板有空态文案')
expectContains(chatPanelSource, 'className="pa-archive__list"', '历史面板有归档列表')
expectContains(chatPanelSource, 'className="pa-archive__preview"', '历史面板有展开预览')
expectContains(chatPanelSource, '含接力摘要', '归档有「含接力摘要」标记')
expectContains(chatPanelSource, 'RelayPreview brief={session.relay}', '有 relay 时复用 RelayPreview 展示摘要')
expectContains(chatPanelSource, 'actions.deleteArchivedSession(session.id)', '每行删除调 deleteArchivedSession')
expectContains(chatPanelSource, "actions.toast('已删除历史对话')", '删除后有 toast')
expectContains(chatPanelSource, '原对话会归档到「历史对话」，可随时回看；选「直接清空」也会先归档，不会丢记录。', '清空确认卡文案说明归档可回看、直接清空也不丢记录')
expectContains(chatPanelSource, 'title="清空当前会话，旧对话会归档到历史对话"', '「直接清空」按钮补充归档说明')
expectContains(chatPanelSource, 'function ArchiveMessage({ message }: { message: Message }): JSX.Element | null {', '存在只读消息预览组件')

console.log('[personal-archive] 静态断言：chat.css.ts')

const chatCssSource = await readFile(chatCssPath, 'utf8')

expectContains(chatCssSource, '.pa-archive {', '存在历史面板容器样式')
expectContains(chatCssSource, '.pa-archive__empty {', '存在空态样式')
expectContains(chatCssSource, '.pa-archive__list {', '存在列表样式')
expectContains(chatCssSource, '.pa-archive__item {', '存在归档行样式')
expectContains(chatCssSource, '.pa-archive__preview {', '存在展开预览样式')
expectContains(chatCssSource, '.pa-archive__delete {', '存在删除按钮样式')
expectContains(chatCssSource, '@media (max-width: 680px)', '存在窄屏适配')

console.log('[personal-archive] 语法冒烟：esbuild transform')

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

console.log(`[personal-archive] 全部通过（${String(passed)} 项断言${syntaxChecked ? '，含语法冒烟' : ''}）`)
