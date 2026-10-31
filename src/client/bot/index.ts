/**
 * dsh-seeker-bot — 侧栏 Work / Bot 双模式与 Bot 名册（client 半身）。
 *
 * ## 结构安全（本次重构的重点）
 *
 * 上一版把 applyMode() → renderList() → innerHTML 重写挂进 MutationObserver
 * 回调：写 DOM 又触发观察器，微任务队列永远清不空，整页主线程卡死。这里不再
 * 依赖「渲染指纹相同就跳过」这一条兜底，而是把职责拆开：
 *
 *  · **MutationObserver 只做两件事**：确认 host 还挂在锚点前、把官方区域按
 *    当前模式隐藏 / 还原。它**永远不重建名册**；
 *  · 名册只在 store 状态变化（refresh / 新建 / 选中 / 切模式）时渲染；
 *  · 渲染函数自身还有指纹与「只写一次」的防御，两层独立。
 *
 * 这样即使官方侧栏反复重建、观察器回调刷屏，也只会走几次幂等的属性检查。
 *
 * ## 功能
 *  · Work / Bot 分段固定在 [data-slot="sidebar.workspaces"] 上方；
 *  · Bot 模式隐藏官方工作区，按置顶 / 分组渲染名册（name / role / 注意力角标 /
 *    主 Bot 星标）；
 *  · 名册顶部「新建 Bot」内联表单；点击行打开已有会话或新建并绑定；
 *  · 行尾齿轮打开详情抽屉（见 drawer.ts）。
 */

import { getService } from '../client-ctx.ts'
import { openSessionById, pushNotice, setSessionNavContext } from '../done-pill/session-nav.ts'
import { bindBotSession, createBot, createBotSession, fetchBotState, setBotUiMode } from './api.ts'
import { closeBotDrawer, openBotDrawer } from './drawer.ts'
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  buildCreateBotInput,
  type AvatarShape,
  type BotRecord,
} from './model.ts'
import { renderRoster } from './roster.ts'
import { getBotConsoleStore } from './store.ts'
import { injectBotStyles } from './styles.ts'

const ANCHOR = '[data-slot="sidebar.workspaces"]'
const HOST_ID = 'skb-sidebar-host'
const HIDE_ATTR = 'data-skb-official-hidden'
const CONTROLLER_KEY = '__dshSeekerBotConsoleV1__'

interface UiWorkspaceLike {
  startSession?: (workspaceId?: string, options?: { prompt?: string; clearPreviousDraft?: boolean }) => void
  selection?: { sessionId?: unknown; getSnapshot?: () => { sessionId?: unknown } | undefined }
}

let hostEl: HTMLElement | null = null
let listEl: HTMLElement | null = null
let statusEl: HTMLElement | null = null
let formEl: HTMLElement | null = null
let actionsEl: HTMLElement | null = null
let nameInputEl: HTMLInputElement | null = null
let roleInputEl: HTMLInputElement | null = null
let shapeSelectEl: HTMLSelectElement | null = null
let colorInputEl: HTMLInputElement | null = null
let modeButtons: HTMLElement[] = []
let creating = false
let statusTimer = 0
let lastStatusText = ''
let lastStatusTone = ''

const stats = { mounts: 0, renders: 0, reconciles: 0 }

function currentWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function showStatus(message: string, tone: 'error' | 'notice'): void {
  const store = getBotConsoleStore()
  if (tone === 'error') {
    store.setError(message)
    try { pushNotice('error', message) } catch { /* 提示条不可用时以名册状态行为准 */ }
  } else {
    store.setNotice(message)
  }
  const win = currentWindow()
  if (win !== undefined) {
    if (statusTimer !== 0) win.clearTimeout(statusTimer)
    statusTimer = win.setTimeout(() => {
      store.clearError()
      store.clearNotice()
    }, tone === 'error' ? 8000 : 4000)
  }
}

function isBefore(node: HTMLElement, anchor: HTMLElement): boolean {
  try {
    if (typeof node.compareDocumentPosition === 'function') {
      return (node.compareDocumentPosition(anchor) & 4) !== 0
    }
  } catch { /* 旧的 WebView 没有该方法 */ }
  const parent = node.parentElement
  if (parent === null || parent !== anchor.parentElement) return false
  const children = Array.from(parent.children)
  const index = children.indexOf(node)
  const anchorIndex = children.indexOf(anchor)
  return index >= 0 && anchorIndex >= 0 && index < anchorIndex
}

/** 当前 uiWorkspace.selection 的 sessionId（兼容 direct / getSnapshot 两种形状）。 */
function selectionId(workspace: UiWorkspaceLike): string | undefined {
  try {
    const selection = workspace.selection
    if (selection === undefined) return undefined
    const snapshot = typeof selection.getSnapshot === 'function' ? selection.getSnapshot() : selection
    const id = snapshot?.sessionId ?? selection.sessionId
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const win = currentWindow()
    if (win !== undefined) win.setTimeout(resolve, ms)
    else setTimeout(resolve, ms)
  })
}

/** 新建会话后等 selection 落位（最多 3s）；读不到就如实失败，不猜。 */
async function waitForSessionId(workspace: UiWorkspaceLike, before: string | undefined): Promise<string | undefined> {
  for (let i = 0; i < 60; i += 1) {
    const current = selectionId(workspace)
    if (current !== undefined && current !== before) return current
    await sleep(50)
  }
  return undefined
}

/** host 会话路由不存在 / 旧宿主时才降级到 uiWorkspace 新建。 */
function sessionRouteMissing(status: number): boolean {
  return status === 0 || status === 404 || status === 405 || status === 501
}

async function createAndBind(bot: BotRecord): Promise<void> {
  const store = getBotConsoleStore()

  /*
   * 主路径：host 的 POST /bots/:id/session。
   * 为什么不让客户端自己 startSession 再读 selection：DSH 0.2.1 的临时 profile
   * 实测 uiWorkspace.selection 读不到新建会话 id（不是所有宿主都暴露该快照），
   * 会出现「会话建出来了但绑不上」。host 侧用官方 sessionController 建会话，
   * 返回 sessionId 且已同时写绑定表，这里只负责把它打开。
   */
  const created = await createBotSession(bot.id)
  if (created.ok) {
    const sessionId = typeof created.data?.sessionId === 'string' ? created.data.sessionId.trim() : ''
    if (sessionId === '') {
      showStatus('host 已创建会话，但没有返回 sessionId，无法打开「' + bot.name + '」的会话', 'error')
      return
    }
    const outcome = openSessionById(sessionId)
    if (!outcome.ok) {
      showStatus('会话已创建，但打开失败：' + (outcome.reason ?? '未知错误'), 'error')
      return
    }
    await store.refresh()
    store.select(bot.id)
    showStatus('已为「' + bot.name + '」新建会话并绑定', 'notice')
    return
  }
  if (!sessionRouteMissing(created.status)) {
    showStatus('创建「' + bot.name + '」的会话失败：' + (created.error ?? '未知错误'), 'error')
    return
  }

  // 降级：旧宿主没有 Bot 会话路由时，仍用 uiWorkspace.startSession + selection 绑定。
  const workspace = getService<UiWorkspaceLike>('uiWorkspace')
  if (workspace === undefined || typeof workspace.startSession !== 'function') {
    showStatus('host 不支持创建 Bot 会话，且 DSH 未提供 uiWorkspace.startSession，无法新建会话', 'error')
    return
  }
  const before = selectionId(workspace)
  try {
    workspace.startSession(undefined, { prompt: '', clearPreviousDraft: false })
  } catch (err) {
    showStatus('新建会话失败：' + errorText(err), 'error')
    return
  }
  const sessionId = await waitForSessionId(workspace, before)
  if (sessionId === undefined) {
    showStatus('已新建会话，但没能读取到会话 id，未绑定到「' + bot.name + '」', 'error')
    return
  }
  const res = await bindBotSession(bot.id, sessionId)
  if (!res.ok) {
    showStatus('会话已创建，但绑定到「' + bot.name + '」失败：' + (res.error ?? '未知错误'), 'error')
    return
  }
  await store.refresh()
  store.select(bot.id)
  showStatus('已为「' + bot.name + '」新建会话并绑定', 'notice')
}

/** 点击一行：先取最新 state 看 sessionIds；有就跳转，没有就新建 + 绑定。 */
async function handleSelect(bot: BotRecord): Promise<void> {
  const store = getBotConsoleStore()
  store.select(bot.id)
  const res = await fetchBotState()
  if (!res.ok) {
    showStatus('读取 Bot 会话失败：' + (res.error ?? '未知错误'), 'error')
    return
  }
  store.applyPayload(res.data ?? {})
  const fresh = store.botById(bot.id) ?? bot
  const sessions = Array.isArray(fresh.sessionIds) ? fresh.sessionIds : []
  const existing = sessions.length > 0 ? sessions[sessions.length - 1] : ''
  if (typeof existing === 'string' && existing !== '') {
    const outcome = openSessionById(existing)
    if (!outcome.ok) showStatus(outcome.reason ?? '打开会话失败', 'error')
    // 打开即视为已读：把名册上的「未读」角标清掉。
    if (fresh.status === 'unread' || fresh.status === 'needs-you') {
      void patchBot(fresh.id, { status: 'idle' }).then(() => store.refresh())
    }
    return
  }
  await createAndBind(fresh)
}

/**
 * 首次使用自动建一个默认主 Bot。
 *
 * 产品口径：新装插件时侧栏不应该只有一句「还没有 Bot」；先给一个可改名的
 * 「Seeker」，用户点开就能用。只做一次（localStorage 标记），用户删掉后不会
 * 再被自动塞回来。创建失败会清掉标记，下次刷新还能重试。
 */
const DEFAULT_BOT_FLAG = 'skb-default-bot-seeded'

async function ensureDefaultBot(): Promise<void> {
  const win = currentWindow()
  if (win === undefined) return
  try {
    if (win.localStorage.getItem(DEFAULT_BOT_FLAG) === '1') return
  } catch { return }
  const store = getBotConsoleStore()
  const snapshot = store.getSnapshot()
  if (!snapshot.ready) return
  if (snapshot.bots.length > 0) {
    try { win.localStorage.setItem(DEFAULT_BOT_FLAG, '1') } catch { /* ignore */ }
    return
  }
  try { win.localStorage.setItem(DEFAULT_BOT_FLAG, '1') } catch { /* ignore */ }
  const res = await createBot({
    name: 'Seeker',
    role: '主 Bot',
    instructions: '你是「Seeker」，用户的主 Bot。先理解用户的目标，再决定自己做还是派给其他 Bot。',
    shape: 'whale',
    color: '#0f1115',
  })
  if (!res.ok) {
    try { win.localStorage.removeItem(DEFAULT_BOT_FLAG) } catch { /* ignore */ }
    return
  }
  await store.refresh()
  const createdId = typeof res.data?.bot?.id === 'string' ? res.data.bot.id : ''
  if (createdId !== '') store.select(createdId)
  showStatus('已创建默认 Bot「Seeker」，点行尾齿轮可改名', 'notice')
}

async function submitNewBot(): Promise<void> {
  if (creating) return
  if (nameInputEl === null || roleInputEl === null || shapeSelectEl === null || colorInputEl === null) return
  const name = nameInputEl.value.trim()
  if (name === '') {
    showStatus('请先填写 Bot 的名字', 'error')
    return
  }
  creating = true
  const store = getBotConsoleStore()
  try {
    const draft = {
      name,
      role: roleInputEl.value.trim() || '通用助手',
      instructions: '',
      shape: shapeSelectEl.value as AvatarShape,
      color: colorInputEl.value,
    }
    const res = await createBot(buildCreateBotInput(draft))
    if (!res.ok) {
      showStatus('创建 Bot 失败：' + (res.error ?? '未知错误'), 'error')
      return
    }
    const createdId = typeof res.data?.bot?.id === 'string' ? res.data.bot.id : ''
    await store.refresh()
    if (createdId !== '') store.select(createdId)
    if (formEl !== null) formEl.setAttribute('data-open', 'false')
    nameInputEl.value = ''
    roleInputEl.value = ''
    showStatus('已创建「' + name + '」', 'notice')
  } catch (err) {
    showStatus('创建 Bot 失败：' + errorText(err), 'error')
  } finally {
    creating = false
  }
}

async function switchMode(next: 'work' | 'bot'): Promise<void> {
  const store = getBotConsoleStore()
  if (store.getSnapshot().mode === next) return
  store.setMode(next)
  if (next === 'work') closeBotDrawer()
  const res = await setBotUiMode(next)
  if (!res.ok) showStatus('模式未保存到服务端：' + (res.error ?? '未知错误'), 'error')
}

function modeButton(mode: 'work' | 'bot', label: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.dataset.mode = mode
  btn.className = 'skb-mode-btn'
  btn.textContent = label
  btn.addEventListener('click', () => { void switchMode(mode) })
  return btn
}

function buildHost(): HTMLElement {
  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'skb-host'

  const segment = document.createElement('div')
  segment.className = 'skb-mode'
  modeButtons = [modeButton('work', 'Work'), modeButton('bot', 'Bot')]
  for (const btn of modeButtons) segment.appendChild(btn)
  host.appendChild(segment)

  const actions = document.createElement('div')
  actions.className = 'skb-actions'
  actionsEl = actions
  const newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'skb-new'
  newBtn.textContent = '＋ 新建 Bot'
  newBtn.addEventListener('click', () => {
    if (formEl === null) return
    const open = formEl.getAttribute('data-open') === 'true'
    formEl.setAttribute('data-open', open ? 'false' : 'true')
    if (!open && nameInputEl !== null) nameInputEl.focus()
  })
  actions.appendChild(newBtn)
  host.appendChild(actions)

  const form = document.createElement('form')
  form.className = 'skb-form'
  form.setAttribute('data-open', 'false')
  form.addEventListener('submit', (event: Event) => {
    event.preventDefault()
    void submitNewBot()
  })

  const row1 = document.createElement('div')
  row1.className = 'skb-form-row'
  nameInputEl = document.createElement('input')
  nameInputEl.className = 'skb-input'
  nameInputEl.placeholder = '名字'
  nameInputEl.setAttribute('aria-label', 'Bot 名字')
  roleInputEl = document.createElement('input')
  roleInputEl.className = 'skb-input'
  roleInputEl.placeholder = '岗位'
  roleInputEl.setAttribute('aria-label', 'Bot 岗位')
  row1.appendChild(nameInputEl)
  row1.appendChild(roleInputEl)
  form.appendChild(row1)

  const row2 = document.createElement('div')
  row2.className = 'skb-form-row'
  shapeSelectEl = document.createElement('select')
  shapeSelectEl.className = 'skb-select'
  shapeSelectEl.setAttribute('aria-label', '头像形状')
  for (const item of AVATAR_SHAPES) {
    const option = document.createElement('option')
    option.value = item.value
    option.textContent = item.label
    shapeSelectEl.appendChild(option)
  }
  colorInputEl = document.createElement('input')
  colorInputEl.type = 'color'
  colorInputEl.className = 'skb-input'
  colorInputEl.value = AVATAR_COLORS[0]
  colorInputEl.setAttribute('aria-label', '头像颜色')
  row2.appendChild(shapeSelectEl)
  row2.appendChild(colorInputEl)
  form.appendChild(row2)

  const formActions = document.createElement('div')
  formActions.className = 'skb-form-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'skb-btn'
  cancel.textContent = '取消'
  cancel.addEventListener('click', () => {
    if (formEl !== null) formEl.setAttribute('data-open', 'false')
  })
  const create = document.createElement('button')
  create.type = 'submit'
  create.className = 'skb-btn skb-btn--primary'
  create.textContent = '创建'
  formActions.appendChild(cancel)
  formActions.appendChild(create)
  form.appendChild(formActions)
  formEl = form
  host.appendChild(form)

  listEl = document.createElement('div')
  listEl.className = 'skb-list'
  host.appendChild(listEl)

  statusEl = document.createElement('div')
  statusEl.className = 'skb-status'
  statusEl.setAttribute('aria-live', 'polite')
  host.appendChild(statusEl)
  lastStatusText = ''
  lastStatusTone = ''
  return host
}

function applyModeDom(): void {
  if (typeof document === 'undefined') return
  const mode = getBotConsoleStore().getSnapshot().mode
  const body = document.body
  if (body !== undefined && body !== null && body.getAttribute('data-skb-mode') !== mode) {
    body.setAttribute('data-skb-mode', mode)
  }
  const anchors = Array.from(document.querySelectorAll(ANCHOR))
  for (const node of anchors) {
    if (mode === 'bot') {
      if (!node.hasAttribute(HIDE_ATTR)) node.setAttribute(HIDE_ATTR, 'true')
    } else if (node.hasAttribute(HIDE_ATTR)) {
      node.removeAttribute(HIDE_ATTR)
    }
  }
}

function updateModeButtons(): void {
  const mode = getBotConsoleStore().getSnapshot().mode
  for (const btn of modeButtons) {
    const className = 'skb-mode-btn' + (btn.dataset.mode === mode ? ' on' : '')
    if (btn.className !== className) btn.className = className
  }
}

function renderStatus(): void {
  if (statusEl === null) return
  const snapshot = getBotConsoleStore().getSnapshot()
  const text = snapshot.error !== '' ? snapshot.error : snapshot.notice
  const tone = snapshot.error !== '' ? 'error' : snapshot.notice !== '' ? 'notice' : ''
  if (text !== lastStatusText) {
    statusEl.textContent = text
    lastStatusText = text
  }
  if (tone !== lastStatusTone) {
    if (tone === '') statusEl.removeAttribute('data-tone')
    else statusEl.setAttribute('data-tone', tone)
    lastStatusTone = tone
  }
}

/** 名册渲染只由状态驱动；观察器永远走不到这里。 */
function renderList(): void {
  if (listEl === null) return
  const snapshot = getBotConsoleStore().getSnapshot()
  const inBot = snapshot.mode === 'bot'
  if (actionsEl !== null) {
    const next = inBot ? '' : 'none'
    if (actionsEl.style.display !== next) actionsEl.style.display = next
  }
  if (formEl !== null) {
    const next = inBot ? '' : 'none'
    if (formEl.style.display !== next) formEl.style.display = next
  }
  if (!inBot) {
    if (listEl.style.display !== 'none') listEl.style.display = 'none'
    return
  }
  if (listEl.style.display !== 'flex') listEl.style.display = 'flex'
  const changed = renderRoster(
    listEl,
    { mode: snapshot.mode, bots: snapshot.bots, selected: snapshot.selected },
    {
      onSelect: (bot) => { void handleSelect(bot) },
      onEdit: (bot) => { openBotDrawer(bot) },
    },
  )
  if (changed) stats.renders += 1
}

/** 旧 bundle 留下的 host：摘掉并清空引用，避免新旧两套 DOM 并存。 */
function discardForeignHost(): void {
  const existing = document.getElementById(HOST_ID)
  if (existing === null || existing === hostEl) return
  try { existing.remove() } catch { /* 已脱离文档 */ }
  hostEl = null
  listEl = null
  statusEl = null
  formEl = null
  nameInputEl = null
  roleInputEl = null
  shapeSelectEl = null
  colorInputEl = null
  modeButtons = []
}

/** 确保 host 在锚点之前（幂等：位置没变就零写入）。 */
function ensureHost(): boolean {
  if (typeof document === 'undefined') return false
  const anchor = document.querySelector(ANCHOR) as HTMLElement | null
  if (anchor === null) return false
  const parent = anchor.parentElement
  if (parent === null) return false
  if (hostEl === null) {
    hostEl = document.getElementById(HOST_ID) as HTMLElement | null
  }
  if (hostEl === null) {
    hostEl = buildHost()
    parent.insertBefore(hostEl, anchor)
    stats.mounts += 1
    return true
  }
  if (hostEl.parentElement !== parent || !isBefore(hostEl, anchor)) {
    parent.insertBefore(hostEl, anchor)
    stats.mounts += 1
  }
  return false
}

/** 同步 DOM 外壳：只在 host 新建时补一次名册，其余交给 store 订阅。 */
function renderFromState(): void {
  ensureHost()
  applyModeDom()
  updateModeButtons()
  renderStatus()
  renderList()
}

/**
 * 观察器回调 / 宿主重建后的对账：只做幂等外壳同步，绝不重建名册。
 * 导出给测试直接调用（等价于 MutationObserver 回调体）。
 */
export function reconcileBotConsole(): void {
  stats.reconciles += 1
  const created = ensureHost()
  applyModeDom()
  updateModeButtons()
  renderStatus()
  if (created) renderList()
}

let scheduled = false

function scheduleReconcile(): void {
  if (scheduled) return
  scheduled = true
  const run = (): void => {
    scheduled = false
    reconcileBotConsole()
  }
  if (typeof queueMicrotask === 'function') queueMicrotask(run)
  else setTimeout(run, 0)
}

/** MutationObserver 的唯一入口（测试模拟 100 次回调也走这里）。 */
export function handleBotConsoleMutations(): void {
  scheduleReconcile()
}

/** 测试探针：mounts / renders / reconciles 计数。 */
export function botConsoleStats(): { mounts: number; renders: number; reconciles: number } {
  return { ...stats }
}

export function applyBotConsole(ctx?: unknown): void {
  if (typeof document === 'undefined') return
  if (ctx !== undefined) {
    try { setSessionNavContext(ctx as { get?(name: string): unknown }) } catch { /* 旧宿主没有该登记口 */ }
  }
  injectBotStyles()
  discardForeignHost()
  const store = getBotConsoleStore()
  const holder = globalThis as unknown as Record<string, unknown>
  const previous = holder[CONTROLLER_KEY] as { token?: number; dispose?: () => void } | undefined
  if (previous !== undefined && typeof previous.dispose === 'function') {
    try { previous.dispose() } catch { /* 旧实例已半死不活 */ }
  }
  const token = typeof previous?.token === 'number' ? previous.token + 1 : 1
  const win = currentWindow()
  const unsubscribe = store.subscribe(() => { renderFromState() })
  const onRefresh = (): void => { void store.refresh() }
  // 5s 轮询：host 由会话事件更新注意力状态，名册要能自己跟上（切回页面立即拉一次）。
  const pollTimer = win === undefined ? 0 : win.setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    void store.refresh()
  }, 5000)
  const onVisible = (): void => { if (typeof document !== 'undefined' && !document.hidden) void store.refresh() }
  if (win !== undefined) win.addEventListener('visibilitychange', onVisible)
  if (win !== undefined) win.addEventListener('skb:refresh', onRefresh)

  let observer: MutationObserver | null = null
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => { handleBotConsoleMutations() })
    try {
      observer.observe(document.body, { childList: true, subtree: true })
    } catch { /* 极端旧环境不支持，只能靠首帧与 store 更新 */ }
  }

  renderFromState()
  void store.refresh().then(() => { void ensureDefaultBot() })

  holder[CONTROLLER_KEY] = {
    token,
    dispose: () => {
      unsubscribe()
      if (observer !== null) observer.disconnect()
      if (win !== undefined) win.removeEventListener('skb:refresh', onRefresh)
      if (win !== undefined) win.removeEventListener('visibilitychange', onVisible)
      if (pollTimer !== 0 && win !== undefined) win.clearInterval(pollTimer)
      if (statusTimer !== 0 && win !== undefined) win.clearTimeout(statusTimer)
    },
  }
}

/** 外部（新建 Bot 后 / host 推状态时）触发刷新。 */
export function refreshBotConsole(): void {
  const win = currentWindow()
  if (win !== undefined) win.dispatchEvent(new Event('skb:refresh'))
  else void getBotConsoleStore().refresh()
}

/** 关闭抽屉（供外部调用，例如切到 Work 模式）。 */
export function closeBotConsoleDrawer(): void {
  closeBotDrawer()
}

/** 兼容旧调用面：原实现里叫 renderList，测试与外部探针可直接渲染名册。 */
export { renderRoster as renderList } from './roster.ts'
