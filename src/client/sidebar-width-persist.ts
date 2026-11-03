/**
 * dsh-seeker-bot — 左侧栏拖拽宽度的持久化。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 官方 layout store 是 **transient** 的（见 dsh-client-ui-layout 的 stores.d.ts：
 * 「Transient layout preferences」），侧栏宽度只活在当前这一页：刷新、重开客户端、
 * 甚至关掉再展开侧栏，都会回到契约默认的 280px。用户拖了半天，重开就没了。
 *
 * ── 2026-11-03 修复：宽度必须写进官方 store，不能只写 DOM ────────────────
 * 早先这里只改官方那两处 inline style（frame 的 grid-template-columns 第一列 +
 * 侧栏根 width）。DOM 确实变宽了，但官方 React store 里的 `layoutInfo.sidebar`
 * 仍是 280px —— 官方拖拽手柄的位置 `left` 是按 store 值渲染的，于是出现：
 *
 *   · 侧栏实际宽 341px，手柄却停在 x=280px（侧栏内部 61px 处）；
 *   · 用户按习惯把鼠标放到侧栏右边缘（视觉上的拖拽线）时，那里根本没有手柄，
 *     拖不动；必须猜到手柄藏在哪里才拖得到，拖动起点还会跳 61px；
 *   · guard 每次把 DOM 宽度写回，官方下一次渲染又把 store 值写回来，互相打架。
 *
 * 官方对外只暴露 `ctx.layout.toggleSidebar()`（service.d.ts），没有 setSidebar；
 * 但 `ctx.layout` 的运行时实例上挂着 store 的完整 action 集（`panels`，
 * 见 LayoutController 的构造函数），其中就有 `setSidebar(px)`。这里优先走它：
 * store 一更新，frame 的 grid 列、侧栏根 inline width、**官方拖拽手柄的 left**
 * 全部由 React 一起重渲染，三者永远一致。
 *
 * DOM 直写只作为旧宿主 / 独立演示页的兜底保留。
 *
 * ── 四个职责 ──────────────────────────────────────────────────────────────
 *  1. **记录**：用户在官方拖拽手柄上松手后，把当时的宽度写进 localStorage。
 *  2. **恢复**：启动时把存下来的宽度写回官方 store（或旧宿主的 inline style）。
 *  3. **守护**：官方在窗口 resize / 折叠展开时会用 store 里的值（280）重写几何 ——
 *     非拖拽状态下发现「当前值 ≠ 存的值」就写回，否则用户每次调窗口大小都会把
 *     宽度弄丢。
 *  4. **对外**：`setSidebarWidth` / `persistSidebarWidth` / `readStoredSidebarWidth`
 *     供 Bot 模式的 `.pa-sidebar` 拖拽手柄复用 —— 两个模式共用同一个宽度与存储。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────────
 *  · 只记录 / 恢复官方 sidebar 的拖拽范围（264–420px，见 columns.d.ts 的
 *    SIDEBAR_MIN / SIDEBAR_MAX）；超出视为脏数据，读取时 clamp 回范围。
 *  · 官方侧栏折叠（frame 带 data-sidebar-collapsed）时既不记录也不恢复 ——
 *    折叠态是 56px 图标轨道，不是用户拖出来的值。
 *  · 存储不可用（隐私模式 / 配额满）时静默降级为「不持久化」，不抛错。
 */

/** localStorage 键：与 `dsh-seeker-bot.ui-mode` 同族命名。 */
const STORAGE_KEY = 'dsh-seeker-bot.sidebar-width'

/** 官方三栏 frame（宽度写在它的 inline grid-template-columns 第一列）。 */
const FRAME_SELECTOR = '[class*="_frame"]'

/** 官方侧栏槽位（根节点在它下面）。 */
const SIDEBAR_SLOT = '[data-slot="sidebar"]'

/** 官方侧栏拖拽手柄（用来判断「用户正在拖」）。 */
const HANDLE_SELECTOR = '[class*="_handle"]'

/** 合法宽度区间：与官方 sidebar 拖拽范围一致（264–420）。 */
export const MIN_SIDEBAR_WIDTH = 264
export const MAX_SIDEBAR_WIDTH = 420
/** 官方默认宽度（收起后再展开 / 双击手柄恢复时用）。 */
export const DEFAULT_SIDEBAR_WIDTH = 280

/** 全局单例槽位（live reload 时先 dispose 旧实例）。 */
const CONTROLLER_KEY = '__dshSeekerSidebarWidthPersistV1__'

/** 拖拽松手后等一帧再读：官方那条 width 有 150ms 过渡，立刻读会拿到中间值。 */
const SETTLE_MS = 220

/** 官方 layout store 里 sidebar 动作的最小面（运行时从 ctx.layout.panels 取得）。 */
interface LayoutPanelsLike {
  setSidebar?: (px: number) => void
}

/** install 时保存的 client ctx：layout 服务可能晚于插件 apply 就绪，查询时重试。 */
let savedCtx: unknown = null

/** 已解析到的官方 store action 集（一次解析，长期复用）。 */
let layoutPanels: LayoutPanelsLike | null = null

function currentDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** 把宽度钳进官方拖拽范围。 */
export function clampSidebarWidth(px: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, px))
}

/**
 * 找官方 layout store 的 action 集。
 *
 * 两个来源按优先级：install 时拿到的 ctx（正式路径），以及挂在 window 上的
 * `__dshClientCtx__`（插件的 apply 会写它；Bot 侧栏这类没有 ctx 参数的调用方
 * 走这条）。两者都拿不到时返回 null，调用方退回 DOM 直写。
 */
function resolveLayoutPanels(ctx?: unknown): LayoutPanelsLike | null {
  const candidates: unknown[] = []
  if (ctx !== undefined && ctx !== null) candidates.push((ctx as { layout?: { panels?: unknown } }).layout?.panels)
  const globalCtx = (globalThis as { __dshClientCtx__?: { layout?: { panels?: unknown } } }).__dshClientCtx__
  if (globalCtx !== undefined) candidates.push(globalCtx?.layout?.panels)
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object'
      && typeof (candidate as LayoutPanelsLike).setSidebar === 'function') {
      return candidate as LayoutPanelsLike
    }
  }
  return null
}

function storePanels(): LayoutPanelsLike | null {
  if (layoutPanels !== null) return layoutPanels
  layoutPanels = resolveLayoutPanels(savedCtx)
  return layoutPanels
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const px = Number.parseFloat(raw)
    if (!Number.isFinite(px)) return null
    return clampSidebarWidth(px)
  } catch {
    return null
  }
}

function storeWidth(px: number): void {
  if (!Number.isFinite(px)) return
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(clampSidebarWidth(px))))
  } catch {
    /* 隐私模式 / 配额满：静默降级 */
  }
}

/** 官方侧栏根（`.hHd-Xa_root`），宽度就写在它的 inline style 上。 */
function sidebarRoot(): HTMLElement | null {
  const doc = currentDocument()
  if (doc === undefined) return null
  const slot = doc.querySelector<HTMLElement>(SIDEBAR_SLOT)
  return (slot?.firstElementChild ?? null) as HTMLElement | null
}

/** 官方侧栏是否处于折叠态（图标轨道，不是用户拖的值）。 */
function isCollapsed(): boolean {
  const doc = currentDocument()
  if (doc === undefined) return false
  const frame = doc.querySelector<HTMLElement>(FRAME_SELECTOR)
  return frame !== null && frame.hasAttribute('data-sidebar-collapsed')
}

/** 官方拖拽手柄是否正在拖动（比鼠标事件更可靠：官方自己维护这个标记）。 */
function isOfficialDragging(): boolean {
  const doc = currentDocument()
  if (doc === undefined) return false
  const frame = doc.querySelector<HTMLElement>(FRAME_SELECTOR)
  return frame !== null && frame.hasAttribute('data-dragging')
}

/** 读当前 inline 宽度（不是 computed —— Bot 模式下 computed 被插件 CSS 锁成 300）。 */
function readInlineWidth(): number | null {
  const root = sidebarRoot()
  if (root === null) return null
  const inline = root.style.width
  if (inline === '' || !inline.endsWith('px')) return null
  const px = Number.parseFloat(inline)
  return Number.isFinite(px) ? px : null
}

/**
 * 把宽度写回官方那两处 inline style（旧宿主兜底）。
 *
 * @param px - 目标宽度（px）。
 * @returns 是否两处都写到了（DOM 还没就绪时返回 false，调用方可稍后重试）。
 */
function applyWidthToDom(px: number): boolean {
  const doc = currentDocument()
  if (doc === undefined) return false
  const root = sidebarRoot()
  if (root === null) return false

  let ok = true
  const frame = doc.querySelector<HTMLElement>(FRAME_SELECTOR)
  if (frame !== null) {
    const columns = frame.style.gridTemplateColumns
    if (columns !== '') {
      // 只替换第一列，保留后面的 center / rightbar 两列原样。
      const next = columns.replace(/^\s*[\d.]+px/, `${px}px`)
      if (next !== columns) frame.style.gridTemplateColumns = next
    } else {
      // frame 还没拿到 inline 列定义：等官方首次渲染，别硬写坏它。
      ok = false
    }
  } else {
    ok = false
  }

  const want = `${px}px`
  if (root.style.width !== want) root.style.width = want
  return ok
}

/**
 * 设置左侧栏宽度（公开 API，Bot 侧栏拖拽也会用）。
 *
 * @param px - 目标宽度；会先钳进官方范围。
 * @returns 是否成功写进官方 layout store。false 表示宿主没有这条通道
 *          （独立演示页 / 未来版本改了内部结构），调用方应自行改 CSS 变量兜底。
 */
export function setSidebarWidth(px: number): boolean {
  const target = clampSidebarWidth(px)
  const panels = storePanels()
  if (panels !== null && typeof panels.setSidebar === 'function') {
    try {
      panels.setSidebar(target)
      return true
    } catch {
      /* 回退 DOM 直写 */
    }
  }
  applyWidthToDom(target)
  return false
}

/** 读用户保存的左侧栏宽度（没有有效值返回 null，调用方自行回退 280）。 */
export function readStoredSidebarWidth(): number | null {
  return readStoredWidth()
}

/** 写用户保存的左侧栏宽度（自动钳进官方范围）。 */
export function persistSidebarWidth(px: number): void {
  storeWidth(px)
}

/**
 * 把宽度写进官方 UI：优先 store（手柄 / grid / 侧栏根一起动），否则 DOM。
 *
 * @returns 是否两处都写到了（DOM 兜底需要 DOM 就绪；store 通道总是 true）。
 */
function applyWidth(px: number): boolean {
  const target = clampSidebarWidth(px)
  const panels = storePanels()
  if (panels !== null && typeof panels.setSidebar === 'function') {
    try {
      panels.setSidebar(target)
      return true
    } catch {
      /* 回退 DOM 直写 */
    }
  }
  return applyWidthToDom(target)
}

/**
 * 装上持久化。返回卸载函数。
 */
function install(): () => void {
  const doc = currentDocument()
  if (doc === undefined) return () => { /* 无 document：无事可做 */ }

  let dragging = false
  /** 拖拽结束后的静默窗口：等官方处理完 pointerup / 最终 onDrag / React 提交。 */
  let settleUntil = 0
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let restoreTimer: ReturnType<typeof setTimeout> | null = null
  let restoring = false
  const observers: MutationObserver[] = []

  const inSettleWindow = (): boolean => nowMs() < settleUntil

  /**
   * 守护：非拖拽状态下，官方把宽度改回 store 值（280）时写回用户存的值。
   *
   * 写回自身会再触发一次 style 观察，但下一轮读到「当前值 === 存的值」就停，
   * 不会自激。
   */
  const guard = (): void => {
    if (dragging || restoring || inSettleWindow()) return
    if (isOfficialDragging()) return
    if (isCollapsed()) return
    const want = readStoredWidth()
    if (want === null) return
    const now = readInlineWidth()
    if (now !== null && Math.abs(now - want) < 0.5) return
    applyWidth(want)
  }

  /** 拖拽松手后记录：等过渡走完再读，避免存成中间值。 */
  const commitAfterDrag = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (isCollapsed()) return
      const px = readInlineWidth()
      if (px !== null) storeWidth(px)
    }, SETTLE_MS)
  }

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null
    if (target === null || target.closest(HANDLE_SELECTOR) === null) return
    dragging = true
  }
  const onPointerUp = (): void => {
    if (!dragging) return
    dragging = false
    /*
     * 关键时序：window 的捕获阶段 pointerup 先于官方手柄自己的 pointerup 执行，
     * 官方会在后者里提交最终 dx。若此时 guard 立刻工作，它会拿着**旧**的
     * localStorage 值把刚拖出来的宽度直接写回去 —— 用户看到的就是「一松手就弹回」。
     * 所以松手后开一个比 commit 更长的静默窗口，等最终宽度落盘再恢复守护。
     */
    settleUntil = nowMs() + SETTLE_MS + 120
    commitAfterDrag()
  }

  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerUp, true)

  /**
   * 启动恢复：等官方 React 挂载完成再写（首渲染会覆盖提前写入的几何）。
   *
   * store 通道可用时其实不必等 DOM —— 但官方 store 在插件 apply 阶段可能还没
   * 座位，所以仍然轮询，直到 applyWidth 成功或次数用尽（约 6 秒）。
   */
  const tryRestore = (): boolean => {
    if (restoring) return false
    const want = readStoredWidth()
    if (want === null) return false
    if (isCollapsed()) return false
    restoring = true
    if (!applyWidth(want)) {
      restoring = false
      return false
    }
    // 官方可能在下一帧又渲染一次，隔两帧再确认一次就收手。
    setTimeout(() => {
      restoring = false
      guard()
    }, 120)
    return true
  }

  let tries = 0
  const restoreTick = (): void => {
    restoreTimer = null
    if (readStoredWidth() === null) return
    const applied = tryRestore()
    // 写成功就停止轮询：store 通道下重复 setSidebar 会派发无意义的重渲染。
    if (applied) return
    tries += 1
    if (tries >= 30) return
    restoreTimer = setTimeout(restoreTick, 200)
  }
  restoreTimer = setTimeout(restoreTick, 120)

  // 观察官方那两处 style：resize / 折叠展开 / React 重渲染都可能改写它们。
  if (typeof MutationObserver !== 'undefined') {
    const watch = (el: Element | null): void => {
      if (el === null) return
      const observer = new MutationObserver(() => {
        if (dragging || restoring || inSettleWindow()) return
        guard()
      })
      observer.observe(el, { attributes: true, attributeFilter: ['style'] })
      observers.push(observer)
    }
    const doc2 = currentDocument()
    if (doc2 !== undefined) {
      watch(doc2.querySelector(FRAME_SELECTOR))
      watch(sidebarRoot())
    }
  }

  const onResize = (): void => {
    if (dragging || inSettleWindow()) return
    guard()
  }
  window.addEventListener('resize', onResize)

  return () => {
    if (settleTimer !== null) clearTimeout(settleTimer)
    if (restoreTimer !== null) clearTimeout(restoreTimer)
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('pointercancel', onPointerUp, true)
    window.removeEventListener('resize', onResize)
    for (const observer of observers) observer.disconnect()
  }
}

/**
 * 挂载左侧栏宽度持久化。
 *
 * @param ctx - client 上下文；用于拿官方 layout store 的 setSidebar。
 *   Bot 侧栏的拖拽手柄也复用同一个存储键与 store 通道（见
 *   shell/Sidebar.tsx 的 startResize）。
 */
export function applySidebarWidthPersist(ctx?: unknown): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  savedCtx = ctx
  layoutPanels = resolveLayoutPanels(ctx)
  const holder = globalThis as unknown as Record<string, unknown>
  const previous = holder[CONTROLLER_KEY] as { dispose?: () => void } | undefined
  if (previous !== undefined && typeof previous.dispose === 'function') {
    try { previous.dispose() } catch { /* 旧实例已失效 */ }
  }
  holder[CONTROLLER_KEY] = { dispose: install() }
}
