/**
 * dsh-seeker-bot — 消息流懒加载窗口测试（2026-11-07）。
 *
 * 覆盖：
 *   1. 纯函数：初始只取最新一页、锚点扩窗、锚点丢失回落、上滑阈值、短内容自动补页；
 *   2. 源码守卫：MessageList 确实用窗口渲染、store 暴露完整历史、ChatPanel 把
 *      完整历史交给消息流、MessageBlockView 已 memo 并接 pagesByBot。
 *
 * 不依赖浏览器 / React：窗口计算抽在 chat/message-window.ts，Node 24 原生剥离类型。
 */
import { readFileSync } from 'node:fs'

const fails = []
function need(condition, label) {
  if (condition) console.log('ok    ' + label)
  else { fails.push(label); console.log('FAIL  ' + label) }
}

const mod = await import('../src/client/personal/chat/message-window.ts')

/* ---------- 1. 纯函数 ---------- */

const messages = Array.from({ length: 120 }, (_, index) => ({ id: 'm' + String(index) }))
const indexOf = (id) => messages.findIndex((message) => message.id === id)

need(mod.MESSAGE_PAGE_SIZE === 40, '每页 40 条')
need(mod.MESSAGE_INSERT_CHUNK === 10, '旧消息分批插入每批 10 条')
need(mod.LOAD_OLDER_THRESHOLD === 160, '距顶 160px 内触发加载')

const initial = mod.resolveMessageWindow(messages.length, null, null, indexOf)
need(initial.start === 80 && initial.end === 120, '初始窗口只渲染最近 40 条（120 → 80..120）')

const short = mod.resolveMessageWindow(8, null, null, () => -1)
need(short.start === 0 && short.end === 8, '消息不足一页时全量渲染（8 条）')

const empty = mod.resolveMessageWindow(0, null, null, () => -1)
need(empty.start === 0 && empty.end === 0, '空对话窗口为 0..0')

const anchored = mod.resolveMessageWindow(messages.length, 'm21', null, indexOf)
need(anchored.start === 21 && anchored.end === 120, '带锚点时从锚点一直渲染到最新')

const missing = mod.resolveMessageWindow(messages.length, 'not-exist', null, indexOf)
need(missing.start === 80 && missing.end === 120, '锚点消息被撤回 / 清理时回落到最新一页')

const jumpWindow = mod.resolveMessageWindow(messages.length, 'm20', 'm59', indexOf)
need(jumpWindow.start === 20 && jumpWindow.end === 60, '跳转旧消息时是有界窗口（20..60），不渲染整段历史')

const jumpNearEnd = mod.resolveMessageWindow(messages.length, 'm101', 'm119', indexOf)
need(jumpNearEnd.start === 101 && jumpNearEnd.end === 120, '跳转到靠后消息时窗口贴合末尾')

const firstPage = mod.olderPageAnchor(messages, 80)
need(firstPage !== null && firstPage.id === 'm40' && firstPage.start === 40, '上滑扩窗锚点再往前一页（80 → m40/40）')

const secondPage = mod.olderPageAnchor(messages, 40)
need(secondPage !== null && secondPage.id === 'm0' && secondPage.start === 0, '第二页扩到最早（40 → m0/0）')

need(mod.olderPageAnchor(messages, 0) === null, '已经在最早一条时不再产生扩窗锚点')
need(mod.olderPageAnchor([], 0) === null, '空数组安全返回 null')

need(mod.shouldLoadOlder({ hasOlder: true, atBottom: false, loading: false, scrollTop: 80 }), '上滑到阈值内且还有更早消息 → 加载')
need(!mod.shouldLoadOlder({ hasOlder: false, atBottom: false, loading: false, scrollTop: 80 }), '没有更早消息 → 不加载')
need(!mod.shouldLoadOlder({ hasOlder: true, atBottom: true, loading: false, scrollTop: 80 }), '还在底部（初始贴底那一帧）→ 不加载')
need(!mod.shouldLoadOlder({ hasOlder: true, atBottom: false, loading: true, scrollTop: 80 }), '正在加载 → 不重复触发')
need(!mod.shouldLoadOlder({ hasOlder: true, atBottom: false, loading: false, scrollTop: 400 }), '离开顶部阈值 → 不加载')

need(mod.shouldFillViewport({ hasOlder: true, scrollHeight: 600, clientHeight: 800, loading: false }), '40 条填不满一屏 → 继续补页')
need(!mod.shouldFillViewport({ hasOlder: true, scrollHeight: 900, clientHeight: 800, loading: false }), '已经能滚动 → 不补页')
need(!mod.shouldFillViewport({ hasOlder: false, scrollHeight: 600, clientHeight: 800, loading: false }), '没有更早消息 → 不补页')
need(!mod.shouldFillViewport({ hasOlder: true, scrollHeight: 0, clientHeight: 0, loading: false }), '容器还没布局（clientHeight=0）→ 不补页')
need(!mod.shouldFillViewport({ hasOlder: true, scrollHeight: 0, clientHeight: 800, loading: false }), '内容还没测量（scrollHeight=0）→ 不补页')

/* ---------- 2. 源码守卫 ---------- */

const listSource = readFileSync(new URL('../src/client/personal/chat/MessageList.tsx', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('../src/client/personal/store.tsx', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('../src/client/personal/chat/ChatPanel.tsx', import.meta.url), 'utf8')
const blockSource = readFileSync(new URL('../src/client/personal/chat/MessageBlockView.tsx', import.meta.url), 'utf8')

need(listSource.includes('resolveMessageWindow('), 'MessageList 用窗口函数计算渲染范围')
need(listSource.includes('continueOlderLoad'), '旧消息分批插入（每批让出一帧）')
need(listSource.includes('pa-chat__load-older'), 'MessageList 渲染「上滑加载更早消息」提示')
need(listSource.includes('pendingPreserveRef'), '扩窗后补偿 scrollTop（视口不跳）')
need(listSource.includes("'pa:jump-to-message'"), '窗口外的跳转交给 MessageList 扩窗处理')
need(storeSource.includes('historyMessages'), 'store 暴露完整历史 historyMessages')
need(storeSource.includes('conversationMessages.slice(-200)'), 'activeMessages 仍保留最近 200 条给头像 / 待办等消费者')
need(panelSource.includes('historyMessages'), 'ChatPanel 把完整历史交给 MessageList')
need(blockSource.includes('memo(function MessageBlockView'), 'MessageBlockView 已 memo（未变消息跳渲染）')
need(blockSource.includes('pagesByBot?: AppState'), 'MessageBlockView 通过 pagesByBot prop 读页面缓存')

console.log('')
if (fails.length > 0) {
  console.log('MESSAGE LAZY LOAD TEST FAILED — ' + String(fails.length) + ' 个断言未通过')
  process.exit(1)
}
console.log('MESSAGE LAZY LOAD TEST PASSED — 最新一页起步 + 上滑扩窗 + 视口锚定 + 消费端隔离')