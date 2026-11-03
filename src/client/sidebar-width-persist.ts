/**
 * dsh-seeker-bot — 左侧栏拖拽宽度的持久化。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 官方 layout store 是 **transient** 的（见 dsh-client-ui-layout 的 stores.d.ts：
 * 「Transient layout preferences」），侧栏宽度只活在当前这一页：刷新、重开客户端、
 * 甚至关掉再展开侧栏，都会回到契约默认的 280px。用户拖了半天，重开就没了。
 *
 * 官方对外只暴露 `ctx.layout.toggleSidebar()`（service.d.ts），**没有 setSidebar**，
 * 所以拿不到「设置宽度」的公开入口。这里只能自己记 + 自己写回官方那两处 inline
 * style —— 那正是官方拖拽时写的位置：
 *
 *   · frame 的 inline `grid-template-columns` 第一列（真正决定列宽的）
 *   · 侧栏根的 inline `width`（内容自己的宽度，缺了会与列宽不一致）
 *
 * ── 三个职责 ──────────────────────────────────────────────────────────────
 *  1. **记录**：用户在官方拖拽手柄上松手后，把当时的宽度写进 localStorage。
 *  2. **恢复**：启动时把存下来的宽度写回那两处 inline style（等官方 DOM 就绪再写，
 *     否则会被首次渲染覆盖）。
 *  3. **守护**：官方在窗口 resize / 折叠展开时会用 store 里的值（280）重写这两处
 *     style —— 非拖拽状态下发现「当前值 ≠ 存的值」就写回，否则用户每次调窗口
 *     大小都会把宽度弄丢。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────────
 *  · 只在 200–520px 之间记录 / 恢复（官方拖拽范围是 264–420，留余量给不同版本）；
 *  · 官方侧栏折叠（frame 带 data-sidebar-collapsed）时既不记录也不恢复 ——
 *    折叠态是 56px 图标轨道，不是用户拖出来的值；
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

/** 合法宽度区间：超出视为脏数据，不记也不恢复。 */
const MIN_WIDTH = 200
const MAX_WIDTH = 520

/** 全局单例槽位（live reload 时先 dispose 旧实例）。 */
const CONTROLLER_KEY = '__dshSeekerSidebarWidthPersistV1__'

/** 拖拽松手后等一帧再读：官方那条 width 有 150ms 过渡，立刻读会拿到中间值。 */
const SETTLE_MS = 220

function currentDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const px = Number.parseFloat(raw)
    if (!Number.isFinite(px) || px < MIN_WIDTH || px > MAX_WIDTH) return null
    return px
  } catch {
    return null
  }
}

function storeWidth(px: number): void {
  if (!Number.isFinite(px) || px < MIN_WIDTH || px > MAX_WIDTH) return
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(px)))
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
 * 把宽度写回官方那两处 inline style。
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
 * 装上持久化。返回卸载函数。
 */
function install(): () => void {
  const doc = currentDocument()
  if (doc === undefined) return () => { /* 无 document：无事可做 */ }

  let dragging = false
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let restoreTimer: ReturnType<typeof setTimeout> | null = null
  let restoring = false
  const observers: MutationObserver[] = []

  /**
   * 守护：非拖拽状态下，官方把宽度改回 store 值（280）时写回用户存的值。
   *
   * 写回自身会再触发一次 style 观察，但下一轮读到「当前值 === 存的值」就停，
   * 不会自激。
   */
  const guard = (): void => {
    if (dragging || restoring) return
    if (isCollapsed()) return
    const want = readStoredWidth()
    if (want === null) return
    const now = readInlineWidth()
    if (now === want) return
    applyWidthToDom(want)
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
    commitAfterDrag()
  }

  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerUp, true)

  /**
   * 启动恢复：官方 React 挂载完成前写 DOM 会被首次渲染覆盖，所以轮询到
   * frame 与侧栏根都出现、且 inline 列定义可读为止（最多约 6 秒），写一次就停。
   */
  const tryRestore = (): void => {
    if (restoring) return
    const want = readStoredWidth()
    if (want === null) return
    if (isCollapsed()) return
    restoring = true
    if (!applyWidthToDom(want)) {
      restoring = false
      return
    }
    // 官方可能在下一帧又渲染一次，隔两帧再确认一次就收手。
    setTimeout(() => {
      restoring = false
      guard()
    }, 120)
  }

  let tries = 0
  const restoreTick = (): void => {
    restoreTimer = null
    if (readStoredWidth() === null) return
    tryRestore()
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
        if (dragging || restoring) return
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
    if (dragging) return
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
 * 纯 DOM + localStorage：不依赖任何 DSH 服务，Work / Bot 两个模式都生效
 * （Bot 侧栏的宽度由 work-sidebar-width.ts 读官方 inline 值，恢复后自然跟随）。
 */
export function applySidebarWidthPersist(_ctx?: unknown): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const holder = globalThis as unknown as Record<string, unknown>
  const previous = holder[CONTROLLER_KEY] as { dispose?: () => void } | undefined
  if (previous !== undefined && typeof previous.dispose === 'function') {
    try { previous.dispose() } catch { /* 旧实例已失效 */ }
  }
  holder[CONTROLLER_KEY] = { dispose: install() }
}
