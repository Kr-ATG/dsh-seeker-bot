/**
 * dsh-seeker-bot — 消息流分页窗口（2026-11-07）。
 *
 * 聊天记录多了之后，一次性把几百上千条消息交给 React 渲染会明显卡顿：每条
 * 消息都带 Markdown、卡片、图片、悬停操作条，真实 DOM 成本远高于一个普通
 * 列表项。这里只做「窗口计算」这一件事，把渲染量压到一页以内；真正的滚动
 * 加载由 MessageList 驱动（上滑到接近顶部时再向前扩一页）。
 *
 * 设计要点：
 *   · 窗口以「锚点消息 id」为准，而不是固定下标：新消息追加时锚点不变，
 *     用户正在翻看的旧消息不会被新消息挤走；
 *   · 初始（renderStartId === null）跟随最新一页，打开会话就是对话末尾；
 *   · 锚点消息被撤回 / 清理掉时自动退回最新一页，不会白屏。
 *
 * @module
 */

/** 每次渲染 / 上滑加载的消息条数。 */
export const MESSAGE_PAGE_SIZE = 40

/**
 * 上滑补历史时的单批插入条数。
 *
 * 40 条一次性 setState 会让 React 在复杂消息（图片 / 卡片 / iframe）上产生
 * 一个几十到上百 ms 的长任务，手感就是「滚一下卡住」。拆成 10 条一批、
 * 每批之间让出一帧，插入成本被摊平，视口仍用消息 id 锚定所以不会跳。
 */
export const MESSAGE_INSERT_CHUNK = 10

/** 距滚动容器顶部多少 px 内触发「加载更早消息」。 */
export const LOAD_OLDER_THRESHOLD = 160

/** 一个左闭右开的渲染窗口（以筛选后的当前会话消息数组为基准）。 */
export interface MessageWindow {
  /** 窗口第一条消息的下标。 */
  readonly start: number
  /** 窗口结束下标（不含）。 */
  readonly end: number
}

/**
 * 计算当前渲染窗口。
 *
 * @param total - 当前会话消息总数
 * @param renderStartId - 窗口起点消息 id；null 表示「从最新一端倒推一页」
 * @param renderEndId   - 窗口终点消息 id（含）；null 表示一直渲染到最新一条
 * @param indexOf       - 在当前消息数组里查 id 下标（由调用方提供，避免本模块依赖完整 Message）
 * @param pageSize      - 每页条数
 *
 * 组合语义：
 *   · start=null / end=null  → 最新一页（打开会话的默认状态）
 *   · start=非空 / end=null  → 上滑加载过若干页，一直显示到最新
 *   · start=非空 / end=非空  → 跳转到旧消息时的有界窗口（不把整段历史都渲染出来）
 */
export function resolveMessageWindow(
  total: number,
  renderStartId: string | null,
  renderEndId: string | null,
  indexOf: (id: string) => number,
  pageSize: number = MESSAGE_PAGE_SIZE,
): MessageWindow {
  if (!Number.isFinite(total) || total <= 0) return { start: 0, end: 0 }
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : MESSAGE_PAGE_SIZE

  let end = total
  if (renderEndId !== null) {
    const endIndex = indexOf(renderEndId)
    if (Number.isFinite(endIndex) && endIndex >= 0 && endIndex < total) end = endIndex + 1
  }

  let start = Math.max(0, end - safePageSize)
  if (renderStartId !== null) {
    const startIndex = indexOf(renderStartId)
    if (Number.isFinite(startIndex) && startIndex >= 0 && startIndex < end) start = Math.floor(startIndex)
  }
  if (start >= end) start = Math.max(0, end - safePageSize)
  return { start, end }
}

/**
 * 上滑时向前扩一页的锚点。
 *
 * 返回 null 表示已经到最早一条，没有更早的消息可加载。
 */
export function olderPageAnchor(
  messages: ReadonlyArray<{ readonly id: string }>,
  start: number,
  pageSize: number = MESSAGE_PAGE_SIZE,
): { readonly id: string; readonly start: number } | null {
  if (!Number.isFinite(start) || start <= 0 || messages.length === 0) return null
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : MESSAGE_PAGE_SIZE
  const nextStart = Math.max(0, Math.floor(start) - safePageSize)
  const anchor = messages[nextStart]
  if (anchor === undefined || typeof anchor.id !== 'string' || anchor.id === '') return null
  return { id: anchor.id, start: nextStart }
}

/**
 * 判断这次 scroll 该不该触发加载更早消息。
 *
 * 三个前提缺一不可：
 *   · 还有更早的消息（hasOlder）；
 *   · 不在底部（atBottom）——初始自动贴底那一帧不能误触发；
 *   · 不在加载中（loading）——防止一次滚动事件里重复扩窗。
 */
export function shouldLoadOlder(input: {
  readonly hasOlder: boolean
  readonly atBottom: boolean
  readonly loading: boolean
  readonly scrollTop: number
  readonly threshold?: number
}): boolean {
  if (!input.hasOlder || input.atBottom || input.loading) return false
  const threshold = input.threshold === undefined ? LOAD_OLDER_THRESHOLD : input.threshold
  return input.scrollTop <= threshold
}

/**
 * 窗口内容还不够撑出滚动条时，是否应该继续补页。
 *
 * 消息很短时 40 条可能连一屏都填不满；用户没有滚动条可拖，就永远触发不了
 * 「上滑加载」。这个判据让 MessageList 在布局后自动补到能滚动为止。
 */
export function shouldFillViewport(input: {
  readonly hasOlder: boolean
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly loading: boolean
}): boolean {
  if (!input.hasOlder || input.loading) return false
  /*
   * clientHeight=0 说明滚动容器还没参与布局（首帧 / 父级 display:none）。
   * 这时不能把「0 高度」误判成「填不满一屏」连续补页——会让初始渲染量
   * 从一页膨胀到好几页，懒加载直接失效。
   */
  if (input.clientHeight <= 0 || input.scrollHeight <= 0) return false
  return input.scrollHeight <= input.clientHeight + 4
}
