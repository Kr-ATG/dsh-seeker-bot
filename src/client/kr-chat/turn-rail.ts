/**
 * dsh-seeker-bot — 官方轮次导航轨在 Seeker 窄栏里的恢复（2026-11-07）。
 *
 * 现象：Work 模式官方 ChatView 右侧那列「每轮一条短横线」的轮次导航（官方
 * 组件名 TurnNavigator），在「对话」tab 里正常，切到「Seeker」tab 就整块没了。
 *
 * 根因（浏览器实测）：官方给导航轨本体写了一条容器查询 ——
 *     @container (width<=900px) { .frame { display: none } }
 * 官方「对话」tab 的对话列宽 1157px，导航轨正常；Seeker 视图要把中心栏让
 * 一半给右侧大盘，官方 ChatView 只剩 ~712px ≤ 900px，于是官方自己把它隐藏。
 * 这是官方对窄对话列的响应式取舍，不是插件弄坏的 —— 但用户要的是「Seeker
 * 视图里也得有」，所以在这里把它放回来。
 *
 * 做法：**只给官方导航轨本体打一枚 data-dsh-turn-rail 属性**，显隐交给
 * styles.ts 里一条只在 body[data-dsh-kr-chat="true"] 下生效的 !important 规则。
 * 不碰官方其它任何规则，也不依赖官方 hash 类名（每次构建都会变）。
 *
 * 识别方式（按稳定性排序）：
 *   1. nav 的 aria-label 命中本轮读到的「轮次导航 / turn navigation」；
 *   2. 兜底用结构特征：父级是 inline-size 容器 + 自身 contain:layout ——
 *      这一组只属于官方 TurnNavigator（槽位 .slot{container-type:inline-size}，
 *      frame 上 contain:layout）。
 *
 * 生命周期：会话切换 / 视图重建会把导航轨整个换掉，所以每 500ms 对账一次
 * （新节点标记、消失节点清理），与 scrollbar-autohide.ts 的重挂策略一致。
 */

/** 打在官方轮次导航轨本体上的标记属性；显隐规则见 styles.ts。 */
export const TURN_RAIL_ATTR = 'data-dsh-turn-rail'

/** 掉线重挂检查间隔（ms）。 */
const WATCH_INTERVAL_MS = 500

/** 官方 aria-label 的已确认文案（小写比较，中 / 英）。 */
const RAIL_LABELS = ['轮次导航', 'turn navigation']

/** 读计算样式；测试里 window 会被替换成 fake 实现。 */
function styleOf(element: Element): CSSStyleDeclaration {
  return window.getComputedStyle(element)
}

/**
 * 判断一个 nav 是不是官方轮次导航轨。
 * @param nav - 候选 nav 元素（官方 ChatView 里可能有多个 nav：面板 / 面包屑 / 导航轨）。
 */
export function isTurnRail(nav: HTMLElement): boolean {
  const label = (nav.getAttribute?.('aria-label') ?? '').toLowerCase()
  for (const text of RAIL_LABELS) {
    if (label.includes(text)) return true
  }
  const slot = nav.parentElement
  if (slot === null || slot === undefined) return false
  if (styleOf(slot).containerType !== 'inline-size') return false
  return String(styleOf(nav).contain ?? '').includes('layout')
}

/**
 * 在当前文档里接管官方轮次导航轨的显隐。
 * @returns 卸载函数（交给 useEffect / ctx.effect 回收）。
 */
export function installTurnRailReveal(): () => void {
  const marked = new Set<HTMLElement>()
  let disposed = false
  let watcher = 0

  const sync = (): void => {
    if (disposed) return
    const current = new Set<HTMLElement>()
    document.querySelectorAll('nav').forEach((node) => {
      const nav = node as HTMLElement
      if (isTurnRail(nav)) current.add(nav)
    })
    for (const nav of [...marked]) {
      if (!current.has(nav)) {
        nav.removeAttribute(TURN_RAIL_ATTR)
        marked.delete(nav)
      }
    }
    for (const nav of current) {
      if (marked.has(nav)) continue
      nav.setAttribute(TURN_RAIL_ATTR, '')
      marked.add(nav)
    }
    watcher = window.setTimeout(sync, WATCH_INTERVAL_MS)
  }

  sync()

  return () => {
    disposed = true
    if (watcher !== 0) window.clearTimeout(watcher)
    for (const nav of marked) nav.removeAttribute(TURN_RAIL_ATTR)
    marked.clear()
  }
}

/** 对账间隔，测试用。 */
export const TURN_RAIL_WATCH_INTERVAL_MS = WATCH_INTERVAL_MS
