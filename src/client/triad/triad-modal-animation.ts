/**
 * 弹窗开合动画（sidebar / 工作台）—— **样式与 keyframes 已收敛到 motion/overlay-motion.ts**。
 *
 * 这个文件现在只保留「老 API 的薄壳」：`modalAnimClass` / `modalDrawerAnimClass` 等
 * class 名与 `useModalClose` 状态机继续可用，但样式表只有全局那一份
 * （`dsh-overlay-motion-styles`，见 src/client/motion/overlay-motion.ts）。
 *
 * 收敛前这里是第二份拷贝（多一个 drawer 变体），注释里互相提醒「改一处务必同步
 * 另一处」——现在两份都只是薄壳，keyframes 只有一份，不会再漂移。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ensureOverlayMotionStyles, OVERLAY_MOTION_MS, OVERLAY_MOTION_IN_MS, OVERLAY_MOTION_OUT_MS } from '../motion/overlay-motion'

/** 全局入场时长（ms）：300ms。 */
export const MODAL_ANIM_IN_MS = OVERLAY_MOTION_IN_MS
/** 全局退场时长（ms）：260ms。 */
export const MODAL_ANIM_OUT_MS = OVERLAY_MOTION_OUT_MS
/** 动画时长（ms）：与退场计时一致（260ms），改全局动效层一处即可。 */
export const MODAL_ANIM_MS = OVERLAY_MOTION_MS

/** 注入弹窗动画样式（幂等）——样式表已收敛到 motion/overlay-motion.ts。 */
export function ensureModalAnimStyles(): void {
  ensureOverlayMotionStyles()
}

/** 卡片动画 class（open 阶段滑入，closing 阶段滑出）。 */
export function modalAnimClass(closing: boolean): string {
  return closing ? 'dsh-modal-slide-out' : 'dsh-modal-slide-in'
}

/** 卡片动画 class——右侧滑入变体（贴入口弹出的 popover 卡片用，现仅兼容保留）。 */
export function modalSideAnimClass(closing: boolean): string {
  return closing ? 'dsh-modal-side-out' : 'dsh-modal-side-in'
}

/** 卡片动画 class——会话式右侧抽屉变体（用量/技能/记忆面板用：自右向左滑入）。 */
export function modalDrawerAnimClass(closing: boolean): string {
  return closing ? 'dsh-modal-drawer-out' : 'dsh-modal-drawer-in'
}

/** 遮罩动画 class（自定义弹窗才有遮罩，如用量工作台）。 */
export function modalMaskAnimClass(closing: boolean): string {
  return closing ? 'dsh-modal-mask-out' : 'dsh-modal-mask-in'
}

/** 内容容器 class：卡片滑入后错落跟进（配合 modalAnimClass 使用）。 */
export const modalStaggerClass = 'dsh-modal-stagger'

/**
 * 弹窗关闭动画状态机：先置 closing 播放收回动画，结束后再真正 onClose。
 *
 * 收口必须发生在动画结束的那一刻，而不只是「下次打开时」：入口的
 * onClick 是 `if (open || closing) { requestClose(); return }`，所以
 * closing 一旦停在 true，再点就永远走 requestClose 分支；而
 * requestClose 开头是 `if (closingRef.current) return`，那个 ref 同样
 * 停在 true。两处一起卡死，弹窗再也打不开——曾只在「用量」入口暴露，
 * 因为它是唯一点开后再关、然后立刻重试的。
 * `open` 时的复位保留：它负责「连点两次、第二次在退场中就重开」时
 * 跳过剩余动画。
 */
export function useModalClose(open: boolean, onClose: () => void, durationMs = MODAL_ANIM_MS): { closing: boolean; requestClose: () => void; cancelClose: () => void } {
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<number | null>(null)
  const closingRef = useRef(false)

  // 打开（含重新打开）时重置关闭态：在绘制前同步复位，避免一帧透明闪现。
  useLayoutEffect(() => {
    if (open) {
      closingRef.current = false
      setClosing(false)
    }
  }, [open])

  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    timerRef.current = window.setTimeout(() => {
      // 退场播完：把两个标志一起收口，状态机才回到「已关闭、可重开」。
      closingRef.current = false
      setClosing(false)
      onClose()
    }, durationMs)
  }, [onClose, durationMs])

  /**
   * 撤销一次尚未播完的退场，面板原地弹回。
   *
   * 少了它，「点关闭后马上再点开」会落在退场动画那 200ms 窗口里，
   * 被 requestClose 开头的 `if (closingRef.current) return` 吞掉——用户
   * 看到的就是按钮失灵。此处也要清掉定时器，否则 onClose 仍会在窗口
   * 结束时把已经弹回的面板关掉。
   */
  const cancelClose = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    closingRef.current = false
    setClosing(false)
  }, [])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  return { closing, requestClose, cancelClose }
}
