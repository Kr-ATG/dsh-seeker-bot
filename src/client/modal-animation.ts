/**
 * 弹窗开合动画（KR 主区）—— **样式与 keyframes 已收敛到 motion/overlay-motion.ts**。
 *
 * 这个文件现在只保留「老 API 的薄壳」：`modalAnimClass` 这类 class 名与
 * `useModalClose` 状态机继续可用，但样式表只有全局那一份（`dsh-overlay-motion-styles`）。
 *
 * 为什么收敛：审计发现同一个插件里有三份几乎一样的动效实现（主区一份、sidebar 一份、
 * 各组件自研若干），入场时长从 120ms 到 380ms 不等。新增浮层每次都要再抄一遍
 * keyframes，抄错没人看得出来，只是「手感不一样」。现在：
 *
 *   · **新增浮层**：用 `useOverlayMotion` + `data-motion` 属性（见 motion/overlay-motion.ts），
 *     一个 keyframes 都不用写；
 *   · **老组件**：继续用下面的 `modalAnimClass` / `modalMaskAnimClass` / `useModalClose`，
 *     class 名与行为完全不变。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ensureOverlayMotionStyles, OVERLAY_MOTION_MS } from './motion/overlay-motion'

/** 动画时长（ms）：与全局动效层同源，改那边一处即可。 */
export const MODAL_ANIM_MS = OVERLAY_MOTION_MS

/** 注入弹窗动画样式（幂等）——样式表已收敛到 motion/overlay-motion.ts。 */
export function ensureModalAnimStyles(): void {
  ensureOverlayMotionStyles()
}

/** 卡片动画 class（open 阶段滑入，closing 阶段滑出）。 */
export function modalAnimClass(closing: boolean): string {
  return closing ? 'dsh-modal-slide-out' : 'dsh-modal-slide-in'
}

/** 卡片动画 class——右侧滑入变体（贴入口弹出的 popover 卡片用）。 */
export function modalSideAnimClass(closing: boolean): string {
  return closing ? 'dsh-modal-side-out' : 'dsh-modal-side-in'
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
 * 与 triad/triad-modal-animation.ts 里的同名函数是同一套逻辑的两份拷贝
 * （KR 主区走这里，sidebar 走那份），改一处务必同步另一处。
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
      // 只在「下次打开时」复位是不够的——入口的 onClick 形如
      // `if (open || closing) { requestClose(); return }`，closing 卡在 true
      // 就再也走不到 setOpen(true)，而 requestClose 开头又被 closingRef
      // 挡住，两处一起死锁，弹窗再也打不开。
      closingRef.current = false
      setClosing(false)
      onClose()
    }, durationMs)
  }, [onClose, durationMs])

  /**
   * 撤销一次尚未播完的退场，面板原地弹回。
   *
   * 少了它，「点关闭后马上再点开」会落在退场动画那 200ms 窗口里，
   * 被 requestClose 开头的 early return 吞掉——用户看到的就是按钮失灵。
   * 此处也要清掉定时器，否则 onClose 仍会在窗口结束时把已经弹回的面板
   * 关掉。
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
