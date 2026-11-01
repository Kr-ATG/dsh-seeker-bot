/**
 * dsh-seeker-bot — 侧栏 Work / Bot 模式切换。
 *
 * ## 当前行为（2026-11-01 起 Bot 模式重新开放）
 *
 *  · 分段控件在品牌行下方：Work 回到官方工作台，Bot 打开本插件的全屏
 *    Personal Agent（左侧 Bot 名册 + 中部聊天 + 右侧详情）。
 *  · 模式写入 localStorage 的 `dsh-seeker-bot.ui-mode`，刷新后保持。
 *  · body 上的 `data-skb-mode` 是唯一判据：Work 时官方侧栏原样显示；Bot 时
 *    官方侧栏内容让位（全屏应用会覆盖整个视口）。
 *  · 本控件本身不请求任何 host 接口。
 *
 * ## 结构安全（沿用原 Bot 控制台踩过的坑）
 *
 * 上一版把「写 DOM」挂进 MutationObserver 回调，写 DOM 又触发观察器，微任务
 * 队列永远清不空、整页主线程卡死。这里仍然把职责拆开：
 *
 *  · 观察器只做幂等对账：宿主丢了就补挂、模式属性不一致就同步；
 *  · 每次写 DOM 前先判断值是否真的不同（位置用 previousElementSibling 判断，
 *    不用 nextSibling——React 可能在节点间插空白文本节点，用 nextSibling 会
 *    把「位置正确」误判成「位置不对」，从而每次对账都移动节点、无限触发观察器）；
 *  · 对账用 microtask 合并，一帧内的多次 DOM 变更只跑一次。
 */

import { injectModeSwitchStyles } from './styles.ts'

export type UiMode = 'work' | 'bot'

/** 侧栏宿主的 DOM id（沿用原 Bot 控制台的 id，样式类名不变）。 */
export const MODE_SWITCH_HOST_ID = 'skb-bot-console-host'
/** localStorage 键：刷新 / 重启后保持上次选中的模式。 */
export const UI_MODE_KEY = 'dsh-seeker-bot.ui-mode'
/** body 上的模式属性（CSS 的唯一判据）。 */
export const MODE_ATTR = 'data-skb-mode'

/**
 * Bot 模式开关（2026-11-01 重新开放 Personal Agent 后为 true）。
 *
 * 置为 false 会回到「Bot 不可点、模式恒为 Work」的旧行为：{@link setUiMode}
 * 对 bot 直接拒绝、{@link readUiMode} 无论存过什么都返回 work。Bot 模式的分段
 * 与侧栏让位样式始终保留，改常量即可切换，不影响其它代码。
 */
export const BOT_MODE_ENABLED = true

/** Bot 按钮的悬浮说明（禁用态下告诉用户为什么点不动）。 */
const BOT_DISABLED_TITLE = 'Bot 模式暂不可用，当前固定在 Work'

const ANCHOR = '[data-slot="sidebar.workspaces"]'
const HIDE_ATTR = 'data-skb-native-hide'
const CONTROLLER_KEY = '__dshSeekerModeSwitchV1__'
const LOGO_ROW_CLASS = 'hHd-Xa_logoRow'
const NAV_SECTIONS_ID = 'dsh-sidebar-nav-sections'

let mode: UiMode = 'work'
let hostEl: HTMLElement | null = null
let segRoot: HTMLElement | null = null
let segButtons: HTMLButtonElement[] = []

function currentDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document
}

function currentWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window
}

/**
 * 读启动模式。
 *
 * Bot 模式关闭时**恒为 work**：早先版本可能把 bot 写进 localStorage，只返回 work
 * 会让侧栏第一帧按 bot 摆一次再切回来（闪一下空白）。所以顺手把那条旧记录改写
 * 成 work——下次启动读到的是干净值。
 */
export function readUiMode(): UiMode {
  const fallback: UiMode = 'work'
  try {
    const storage = currentWindow()?.localStorage
    if (storage === undefined) return fallback
    const stored = storage.getItem(UI_MODE_KEY)
    if (!BOT_MODE_ENABLED && stored === 'bot') storage.setItem(UI_MODE_KEY, 'work')
    return BOT_MODE_ENABLED && stored === 'bot' ? 'bot' : fallback
  } catch {
    return fallback
  }
}

/** 写模式偏好；存储不可用时只影响本次会话，不抛错。 */
export function writeUiMode(next: UiMode): void {
  try {
    currentWindow()?.localStorage?.setItem(UI_MODE_KEY, next)
  } catch {
    /* 隐私模式 / 存储配额满：静默降级 */
  }
}

/** 当前模式（模块内状态，DOM 与它保持同步）。 */
export function currentUiMode(): UiMode {
  return mode
}

/**
 * 切换模式：更新内存 → 持久化 → 立刻重绘分段与侧栏外壳。
 *
 * Bot 模式关闭时对 bot **直接拒绝**（不是静默切完再切回）：调用它的唯一入口是
 * 分段按钮的点击回调，禁用态下那个回调本来就点不到，这里的第二道闸只是防止
 * 将来新增调用方绕过 UI 把模式切走。
 */
export function setUiMode(next: UiMode): void {
  if (next !== 'work' && next !== 'bot') return
  if (next === 'bot' && !BOT_MODE_ENABLED) return
  if (mode === next) return
  mode = next
  writeUiMode(next)
  renderSeg()
  applyModeDom()
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined && className !== '') node.className = className
  return node
}

/** 侧栏根节点（官方 SidebarRoot 的 flex 容器）。 */
function sidebarRoot(): HTMLElement | null {
  const doc = currentDocument()
  if (doc === undefined) return null
  const sidebar = doc.querySelector('[data-slot="sidebar"]') as HTMLElement | null
  const first = (sidebar?.firstElementChild ?? null) as HTMLElement | null
  if (first !== null) return first
  // 兼容旧外壳 / 单测桩：锚点所在容器就是侧栏根。
  const anchor = doc.querySelector(ANCHOR) as HTMLElement | null
  return (anchor?.parentElement ?? null) as HTMLElement | null
}

/** 官方品牌行（分段控件插在它后面）。 */
function logoRowOf(rootEl: HTMLElement): HTMLElement | null {
  for (const child of Array.from(rootEl.children)) {
    const className = (child as HTMLElement).className
    if (typeof className === 'string' && className.split(/\s+/).includes(LOGO_ROW_CLASS)) {
      return child as HTMLElement
    }
  }
  return null
}

/** 构建 Work / Bot 分段（结构沿用原 Bot 控制台，样式类名不变）。 */
function buildSeg(): HTMLElement {
  const rootEl = element('div', 'skb-console')
  const seg = element('div', 'skb-seg')
  seg.setAttribute('data-mode', mode)
  const thumb = element('span', 'skb-seg__thumb')
  thumb.setAttribute('aria-hidden', 'true')
  seg.appendChild(thumb)
  segButtons = []
  for (const item of [{ mode: 'work' as const, label: 'Work' }, { mode: 'bot' as const, label: 'Bot' }]) {
    const button = element('button', 'skb-seg__btn') as HTMLButtonElement
    button.type = 'button'
    button.setAttribute('data-mode', item.mode)
    button.textContent = item.label
    /*
     * Bot 那一半注册为**禁用按钮**（2026-10-31 用户要求）。
     *
     * 光有 disabled 不够：分段控件是自绘的热区，用户拿鼠标点上去仍然会有按下动画
     * 的错觉。所以三重一起上 —— disabled 属性（浏览器级拦截）、aria-disabled
     * （读屏与测试可断言）、title（点不动时能看到原因）。
     * 点击回调**根本不再注册**：没有监听器的按钮，无论谁怎么点都不会改模式。
     */
    if (item.mode === 'bot' && !BOT_MODE_ENABLED) {
      button.disabled = true
      button.setAttribute('aria-disabled', 'true')
      button.title = BOT_DISABLED_TITLE
    } else {
      button.addEventListener('click', () => { setUiMode(item.mode) })
    }
    segButtons.push(button)
    seg.appendChild(button)
  }
  rootEl.appendChild(seg)
  segRoot = seg
  return rootEl
}

/** 把选中态刷到分段上（值没变就不写 DOM）。 */
function renderSeg(): void {
  if (segRoot === null) return
  if (segRoot.getAttribute('data-mode') !== mode) segRoot.setAttribute('data-mode', mode)
  for (const button of segButtons) {
    const on = button.getAttribute('data-mode') === mode
    const className = 'skb-seg__btn' + (on ? ' on' : '')
    if (button.className !== className) button.className = className
    if (on) button.setAttribute('aria-selected', 'true')
    else button.removeAttribute('aria-selected')
  }
}

/** 确保宿主挂在侧栏里、且紧贴品牌行之后。 */
function ensureHost(): boolean {
  const doc = currentDocument()
  if (doc === undefined) return false
  const rootEl = sidebarRoot()
  if (rootEl === null) return false
  let created = false
  if (hostEl === null) hostEl = doc.getElementById(MODE_SWITCH_HOST_ID) as HTMLElement | null
  if (hostEl === null) {
    hostEl = element('div', 'skb-console-host')
    hostEl.id = MODE_SWITCH_HOST_ID
    hostEl.appendChild(buildSeg())
    created = true
  }
  const logo = logoRowOf(rootEl)
  /*
   * 位置判断用 previousElementSibling / firstElementChild，而不是 nextSibling：
   * 官方侧栏节点之间可能有空白文本节点，nextSibling 会把「位置正确」误判成
   * 「位置不对」，于是每次对账都 insertBefore 一次 → 观察器再触发 → 死循环。
   */
  const placed = logo !== null
    ? hostEl.parentElement === rootEl && hostEl.previousElementSibling === logo
    : hostEl.parentElement === rootEl && rootEl.firstElementChild === hostEl
  if (!placed) rootEl.insertBefore(hostEl, logo !== null ? logo.nextSibling : rootEl.firstChild)
  return created
}

/** 按模式隐藏 / 还原官方侧栏内容（属性驱动，切回 Work 能精确还原）。 */
function applyModeDom(): void {
  const doc = currentDocument()
  if (doc === undefined) return
  const body = doc.body
  if (body !== null && body !== undefined && body.getAttribute(MODE_ATTR) !== mode) {
    body.setAttribute(MODE_ATTR, mode)
  }
  const hide = (el: Element | null, on: boolean): void => {
    if (el === null) return
    if (on) {
      if (!el.hasAttribute(HIDE_ATTR)) el.setAttribute(HIDE_ATTR, 'true')
    } else if (el.hasAttribute(HIDE_ATTR)) {
      el.removeAttribute(HIDE_ATTR)
    }
  }
  const rootEl = sidebarRoot()
  if (rootEl !== null) {
    for (const child of Array.from(rootEl.children)) {
      // 宿主自己永远保留（Bot 模式下侧栏就只剩它）
      if (child === hostEl) {
        hide(child, false)
        continue
      }
      hide(child, mode === 'bot')
    }
  }
  hide(doc.getElementById(NAV_SECTIONS_ID), mode === 'bot')
  // 官方工作区行（锚点）在 Bot 模式整体让位。
  for (const node of Array.from(doc.querySelectorAll(ANCHOR))) hide(node, mode === 'bot')
}

/** 幂等对账：宿主 + 选中态 + 模式外壳。 */
export function reconcileModeSwitch(): void {
  ensureHost()
  renderSeg()
  applyModeDom()
}

let scheduled = false

function scheduleReconcile(): void {
  if (scheduled) return
  scheduled = true
  const run = (): void => {
    scheduled = false
    reconcileModeSwitch()
  }
  if (typeof queueMicrotask === 'function') queueMicrotask(run)
  else setTimeout(run, 0)
}

/** MutationObserver 的唯一入口（测试模拟多次回调也走这里）。 */
export function handleModeSwitchMutations(): void {
  scheduleReconcile()
}

/**
 * 挂载 Work / Bot 切换。
 *
 * 不依赖任何 DSH 服务：只需要 document。live reload 时旧实例先 dispose，
 * 避免两个观察器同时改 DOM。
 */
export function applyModeSwitch(_ctx?: unknown): void {
  const doc = currentDocument()
  if (doc === undefined) return
  injectModeSwitchStyles()
  mode = readUiMode()

  const holder = globalThis as unknown as Record<string, unknown>
  const previous = holder[CONTROLLER_KEY] as { dispose?: () => void } | undefined
  if (previous !== undefined && typeof previous.dispose === 'function') {
    try { previous.dispose() } catch { /* 旧实例已失效 */ }
  }

  // 旧 bundle 留下的宿主（监听器绑在旧实例上）先摘掉，重建一份干净的。
  const stale = doc.getElementById(MODE_SWITCH_HOST_ID)
  if (stale !== null) {
    try { stale.remove() } catch { /* 已脱离文档 */ }
  }
  hostEl = null
  segRoot = null
  segButtons = []
  reconcileModeSwitch()

  let observer: MutationObserver | null = null
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => { handleModeSwitchMutations() })
    try {
      observer.observe(doc.body, { childList: true, subtree: true })
    } catch {
      /* 极端旧环境不支持：只能靠首帧与显式调用 */
    }
  }

  holder[CONTROLLER_KEY] = {
    dispose: () => {
      if (observer !== null) observer.disconnect()
      if (hostEl !== null) {
        try { hostEl.remove() } catch { /* 已脱离文档 */ }
      }
      hostEl = null
      segRoot = null
      segButtons = []
    },
  }
}
