/**
 * dsh-seeker-bot — 「删除会话」的待确认请求（模块级单例）。
 *
 * ## 为什么状态不能放在菜单项组件里
 *
 * 删除的确认弹窗必须**在菜单关闭之后**还活着。但官方 Menu 是条件渲染的：
 * `open=false` 时整棵子树卸载，菜单项组件里的 `useState` 会随之丢掉——弹窗
 * 刚打开就被卸载，用户只看到闪一下。
 *
 * 所以把「待确认的会话」提到模块级：菜单项只负责**投递请求**，真正的弹窗由
 * 一个常驻宿主（注册在 `shell.overlay` 席位上）渲染。请求的生命周期与菜单
 * 组件完全解耦。
 *
 * 这个 store 刻意保持极小（一个 pending + 一组订阅者），不做持久化、不跨页：
 * 刷新后残留一条「待删除」提示毫无意义，反而会让人误以为删过了。
 */

/** 一条待确认的删除请求。 */
export interface DeleteRequest {
  /** 形如 `session-<uuid>`。 */
  readonly sessionId: string
  /** 会话标题（弹窗里展示，让用户确认删的是哪一条；取不到时为空串）。 */
  readonly title: string
}

/** 当前待确认请求（null = 没有）。 */
let pending: DeleteRequest | null = null

/** 订阅者集合（宿主组件据此重绘）。 */
const listeners = new Set<(request: DeleteRequest | null) => void>()

/**
 * 读当前待确认请求（供宿主首帧初始化）。
 * @returns 待确认请求，或 null。
 */
export function currentDeleteRequest(): DeleteRequest | null {
  return pending
}

/**
 * 订阅请求变化。
 * @param listener - 每次变化时调用。
 * @returns 取消订阅。
 */
export function subscribeDeleteRequest(listener: (request: DeleteRequest | null) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 广播当前状态。 */
function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener(pending)
    } catch {
      // 单个订阅者抛错不影响其余订阅者。
    }
  }
}

/**
 * 投递一条删除请求（菜单项点击时调用）。
 * @param request - 要确认的会话。
 */
export function requestDeleteSession(request: DeleteRequest): void {
  pending = request
  emit()
}

/** 结算当前请求（确认或取消后调用，关闭弹窗）。 */
export function settleDeleteRequest(): void {
  if (pending === null) return
  pending = null
  emit()
}
