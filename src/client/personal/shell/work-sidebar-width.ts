/**
 * dsh-seeker-bot — Bot 侧栏宽度跟随 Work 模式官方侧栏。
 *
 * ── 需求 ──────────────────────────────────────────────────────────────────
 * 用户在 Work 模式把官方左侧栏拖宽（官方范围 264–420px）后，切到 Bot 模式
 * 希望 Bot 自己的左侧栏（Bot 名册那条 `.pa-sidebar`）保持同样宽度 —— 两个
 * 模式之间左右不要跳。早先 `.pa-sidebar` 是写死的 280px，拖过之后切模式会
 * 明显跳一下。
 *
 * ── 为什么读 inline style 而不是 getBoundingClientRect ──────────────────
 * Bot 模式下官方侧栏被本插件的 CSS 锁成 300px（见 mode-switch/styles.ts 的
 * `body[data-skb-mode="bot"] .pI_x6G_frame …` 规则），量出来的 computed width
 * 恒 300，拿不到用户真正拖出来的值。官方把宽度写在侧栏根的 inline `width`
 * 上（同时写 frame 的 grid-template-columns），那条 inline 值不受我们
 * `!important` 影响 —— 读它才是用户拖的值。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────────
 *  · 官方侧栏折叠时（frame 带 `data-sidebar-collapsed`）返回 null：此时官方
 *    是 56px 图标轨道，而 Bot 侧栏折叠态有自己的 64px 规则，不该跟着变窄。
 *  · 读不到 / 数值离谱（<200 或 >520）一律返回 null，调用方回退 280px 默认
 *    值，不会把侧栏压成 0 或者撑满整屏。
 *  · 只在 Bot 模式挂载（PersonalApp 渲染时），不常驻、不干扰 Work。
 */

/** 官方侧栏根节点所在槽位（与 mode-switch 的锚点同一套选择器）。 */
const SIDEBAR_SLOT = '[data-slot="sidebar"]'

/** 官方三栏 frame（宽度同时写在它的 inline grid-template-columns 上）。 */
const FRAME_SELECTOR = '[class*="_frame"]'

/** 官方拖拽范围的宽松上下界：超出这个区间的读数一律当噪声丢掉。 */
const MIN_WIDTH = 200
const MAX_WIDTH = 520

/** 读官方侧栏当前的「用户拖拽值」，读不到返回 null。 */
export function readWorkSidebarWidth(): number | null {
  if (typeof document === 'undefined') return null

  // 折叠态：官方是图标轨道（56px），Bot 侧栏折叠有自己的 64px，别跟着变。
  const frame = document.querySelector<HTMLElement>(FRAME_SELECTOR)
  if (frame !== null && frame.hasAttribute('data-sidebar-collapsed')) return null

  const slot = document.querySelector<HTMLElement>(SIDEBAR_SLOT)
  const root = (slot?.firstElementChild ?? null) as HTMLElement | null
  if (root === null) return null

  const inline = root.style.width
  if (inline !== '' && inline.endsWith('px')) {
    const px = Number.parseFloat(inline)
    if (Number.isFinite(px) && px >= MIN_WIDTH && px <= MAX_WIDTH) return px
  }

  /*
   * 兜底：inline 宽度缺失时（官方换实现）退到实测宽度。Work 模式下它是准的；
   * Bot 模式下会被我们的 300px 锁定带偏，但那时 inline 通常存在，走不到这里。
   */
  const measured = root.getBoundingClientRect().width
  if (measured >= MIN_WIDTH && measured <= MAX_WIDTH) return measured

  return null
}

/**
 * 订阅官方侧栏宽度变化，返回卸载函数。
 *
 * 变化来源有三类：
 *  · 用户在 Work 拖拽官方手柄 → 官方改侧栏根 / frame 的 inline style；
 *  · 窗口尺寸变化导致官方重算（响应式折叠）；
 *  · 官方 React 重建侧栏根（节点被替换，inline 值重挂）。
 *
 * 重算走 rAF 合并：拖拽期官方会连续改 style，逐次回调等于每帧多读几遍布局。
 */
export function installWorkSidebarWidthSync(onChange: (px: number | null) => void): () => void {
  if (typeof document === 'undefined') return () => { /* 无 document：无事可做 */ }

  let last: number | null = null
  let frame: number | null = null

  const emit = (): void => {
    const next = readWorkSidebarWidth()
    if (next === last) return
    last = next
    onChange(next)
  }

  const schedule = (): void => {
    if (frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null
      emit()
    })
  }

  const observers: MutationObserver[] = []
  const watched = new Set<Element>()
  let bound = false

  const watch = (el: Element | null): void => {
    if (el === null || watched.has(el)) return
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(schedule)
    observer.observe(el, {
      attributes: true,
      attributeFilter: ['style', 'data-sidebar-collapsed', 'class'],
    })
    watched.add(el)
    observers.push(observer)
  }

  /**
   * 绑定官方侧栏根与 frame。
   *
   * PersonalApp 的 effect 可能在官方 UI 渲染**之前**就跑（插件 apply 早于官方
   * 界面挂载），那时两个节点都还不存在 —— 直接放弃会让整条同步链永久失效
   * （实测：Bot 模式下 `--pa-sidebar-w` 一直是空，切模式宽度照旧跳）。
   * 所以绑不到就挂一个 body 级观察等它们出现，出现后立刻重绑并补一次读数。
   */
  const bind = (): boolean => {
    const slot = document.querySelector(SIDEBAR_SLOT)
    const root = (slot?.firstElementChild ?? null)
    const frameEl = document.querySelector(FRAME_SELECTOR)
    if (root === null && frameEl === null) return false
    watch(root)
    watch(frameEl)
    bound = true
    return true
  }

  // 首帧先读一次：从 Work 切到 Bot 的那一帧就要用上用户拖出来的宽度。
  emit()

  if (!bind() && typeof MutationObserver !== 'undefined') {
    const waiter = new MutationObserver(() => {
      if (!bind()) return
      waiter.disconnect()
      schedule()
    })
    waiter.observe(document.body, { childList: true, subtree: true })
    observers.push(waiter)
  }

  const onResize = (): void => {
    // 官方 React 可能在切模式时整块重建侧栏：节点换了就重绑一次。
    if (!bound) bind()
    schedule()
  }
  window.addEventListener('resize', onResize)

  return () => {
    if (frame !== null) cancelAnimationFrame(frame)
    window.removeEventListener('resize', onResize)
    for (const observer of observers) observer.disconnect()
    watched.clear()
  }
}
