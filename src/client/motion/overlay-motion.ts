/**
 * dsh-seeker-bot — **浮层动效的全局唯一来源**。
 *
 * ## 为什么要有这个文件
 *
 * 之前动效是「每个浮层自己写一份 keyframes」：审计出的 60 个浮层里，
 * 入场时长从 120ms 到 380ms 不等、曲线各写各的，退场更是 39 个干脆没有。
 * 每新增一个弹窗就要再抄一遍 keyframes，抄错时长/曲线没人看得出来，只是「手感不一样」。
 *
 * 这个模块把动效收成一处：
 *
 *   1. **一份样式表**（`ensureOverlayMotionStyles()` 幂等注入）；
 *   2. **两套用法**：
 *      · 老 API：`.dsh-modal-slide-in` 这类 class（已有组件继续用，行为不变）；
 *      · 新 API：`data-motion` / `data-motion-kind` / `data-motion-mask` 属性驱动 ——
 *        **新增浮层不用写任何 keyframes**，挂属性即可；
 *   3. **一个 hook**：`useOverlayMotion(open, onClose, kind)`，返回 closing 状态机与
 *      要挂到根节点/遮罩上的属性。
 *
 * ## 新增一个浮层的完整步骤（不需要写 CSS）
 *
 * ```tsx
 * const { closing, requestClose, cardAttrs, maskAttrs } = useOverlayMotion(open, () => setOpen(false), 'modal')
 * // 所有关闭入口都调 requestClose（✕ / Esc / 点遮罩 / 确认后关闭）
 * return open || closing ? createPortal(
 *   <div className="my-mask" {...maskAttrs}>
 *     <div className="my-card" {...cardAttrs}>…</div>
 *   </div>,
 *   document.body,
 * ) : null
 * ```
 *
 * ## 规格（与 docs/MOTION.md 一致）
 *
 * | 阶段 | 时长 | 曲线 | 形态 |
 * |---|---|---|---|
 * | 入场 | 240ms | `cubic-bezier(0.2, 0.8, 0.2, 1)` 减速 | modal 自下 24px / popover 8px+缩放 / drawer 自右 56px |
 * | 退场 | 240ms | `cubic-bezier(0.4, 0, 0.2, 1)` 加速 | modal 下沉 14px+scale .97 / drawer 右移 46px |
 * | 遮罩 | 240ms | `ease` | 只做 opacity |
 *
 * 入场用 `backwards` 而不是 `both`：`both` 会在动画结束后残留 transform，
 * 使该层成为后代 `position:fixed` 元素的包含块（浮层里的 tooltip 会整体偏移）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** 浮层形态：决定入场/退场用哪条 keyframes 及对应的体量阶梯。 */
export type OverlayMotionKind = 'modal' | 'popover' | 'drawer' | 'sheet' | 'toast'

/**
 * 动效体量阶梯配置（Motion Tier）：
 *  - S 档（popover / toast）：小面积贴身浮层，响应极快（入场 160ms，退场 120ms）
 *  - M 档（drawer / sheet）：中型面板 / 侧滑抽屉，干脆利落（入场 240ms，退场 200ms）
 *  - L 档（modal / page）：大模态弹窗 / 全屏卡片 / 页面切换，平稳舒缓（入场 300ms，退场 260ms）
 */
export const MOTION_TIERS = {
  sm: { in: 160, out: 120 },
  md: { in: 240, out: 200 },
  lg: { in: 300, out: 260 },
} as const

export const KIND_TO_TIER: Record<OverlayMotionKind, 'sm' | 'md' | 'lg'> = {
  popover: 'sm',
  toast: 'sm',
  drawer: 'md',
  sheet: 'md',
  modal: 'lg',
}

/** 读某个形态默认对应的退场时长（ms），供状态机精准对齐。 */
export function getMotionExitDuration(kind: OverlayMotionKind): number {
  const tier = KIND_TO_TIER[kind] ?? 'lg'
  return MOTION_TIERS[tier].out
}

/** 全局大模态默认入场时长（ms）：300ms 柔和减速进场。 */
export const OVERLAY_MOTION_IN_MS = MOTION_TIERS.lg.in

/** 全局大模态默认退场时长（ms）：260ms 加速收起。 */
export const OVERLAY_MOTION_OUT_MS = MOTION_TIERS.lg.out

/** 兼容历史常量：默认等于大模态退场时长（260ms）。 */
export const OVERLAY_MOTION_MS = OVERLAY_MOTION_OUT_MS

const STYLE_ID = 'dsh-overlay-motion-styles'

/**
 * 全局样式表。
 *
 * 注意 keyframes 名与老 API 的 class 名（`dsh-modal-*`）**必须保持原样**：
 * 已接入的老组件（shot / tool-summary / session-delete / triad / kr-chat…）都在用，
 * 改名等于把它们全部静默打断。
 */
const CSS = `
/* ── 入场 ────────────────────────────────────────────────────────────── */
@keyframes dsh-modal-slide-in { from { opacity: 0; transform: translateY(24px) scale(.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes dsh-motion-modal-in { from { opacity: 0; transform: translateY(24px) scale(.95); } to { opacity: 1; transform: none; } }
@keyframes dsh-motion-popover-in { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
@keyframes dsh-motion-drawer-in { from { opacity: 0; transform: translateX(56px); } to { opacity: 1; transform: none; } }
@keyframes dsh-motion-sheet-in { from { opacity: 0; transform: translateY(64px); } to { opacity: 1; transform: none; } }
@keyframes dsh-motion-toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

/* ── 退场 ────────────────────────────────────────────────────────────── */
@keyframes dsh-modal-slide-out { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(14px) scale(.97); } }
@keyframes dsh-motion-modal-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(14px) scale(.97); } }
@keyframes dsh-motion-popover-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(6px) scale(.97); } }
@keyframes dsh-motion-drawer-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(46px); } }
@keyframes dsh-motion-sheet-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(48px); } }
@keyframes dsh-motion-toast-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(8px); } }

/* ── 遮罩 ────────────────────────────────────────────────────────────── */
@keyframes dsh-modal-mask-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsh-modal-mask-out { from { opacity: 1; } to { opacity: 0; } }

/* ── 页面转场（不是浮层：整页视图的进入） ──────────────────────────────
   进入工作台某页、切 Bot 模式的视图、从列表进到详情页 —— 这些是「页面」不是
   「浮层」，没有关闭态，只有入场。统一用减速曲线 + 轻微上浮，幅度刻意小：
   整页位移大了会晕，这里只是让切换「有落点」而不是硬切。
   · data-page-motion="in"：容器自身入场
   · data-page-motion="stagger"：子块按 --i 依次上浮（列表/卡片组用） */
@keyframes dsh-page-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes dsh-page-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
/* 纯位移变体：**不碰 opacity**。给「整层替换」用（Work ⇄ Bot 切换）——
   这类容器自己铺满视口，淡入会在前几帧透出底下另一套界面，看起来就是「闪一下」。
   只位移时上层始终不透明，透不出任何东西。 */
@keyframes dsh-page-slide { from { transform: translateY(10px); } to { transform: none; } }
[data-page-motion='in'] {
  animation: dsh-page-in 300ms cubic-bezier(.2,.8,.2,1) backwards;
}
[data-page-motion='slide'] {
  animation: dsh-page-slide 300ms cubic-bezier(.2,.8,.2,1) backwards;
}
[data-page-motion='stagger'] > * {
  animation: dsh-page-rise 300ms cubic-bezier(.2,.8,.2,1) backwards;
  animation-delay: calc(var(--i, 0) * 24ms);
}

/* ── 老 API：class 驱动（已有组件在用，行为保持不变） ────────────────── */
/* L 档：大模态弹窗（300ms / 260ms） */
.dsh-modal-slide-in { animation: dsh-modal-slide-in 300ms cubic-bezier(.16,1,.3,1) backwards; }
.dsh-modal-slide-out { animation: dsh-modal-slide-out 260ms cubic-bezier(.4,0,.2,1) both; }
/* S 档：贴身小浮层（160ms / 120ms） */
.dsh-modal-side-in { animation: dsh-motion-popover-in 160ms cubic-bezier(.2,.8,.2,1) backwards; }
.dsh-modal-side-out { animation: dsh-motion-popover-out 120ms cubic-bezier(.4,0,.2,1) both; }
/* M 档：侧滑抽屉（240ms / 200ms） */
.dsh-modal-drawer-in { animation: dsh-motion-drawer-in 240ms cubic-bezier(.2,.8,.2,1) backwards; }
.dsh-modal-drawer-out { animation: dsh-motion-drawer-out 200ms cubic-bezier(.4,0,.2,1) both; }
/* 遮罩入场与退场 */
.dsh-modal-mask-in { animation: dsh-modal-mask-in 300ms ease backwards; }
.dsh-modal-mask-out { animation: dsh-modal-mask-out 260ms ease both; }
.dsh-modal-slide-in .dsh-modal-stagger,
.dsh-modal-side-in .dsh-modal-stagger,
.dsh-modal-drawer-in .dsh-modal-stagger {
  animation: dsh-motion-popover-in 300ms cubic-bezier(.2,.8,.2,1) backwards;
  animation-delay: 60ms;
}

/* ── 新 API：属性驱动（根据形态自动匹配 S / M / L 动效阶梯） ───────────
   根节点挂 data-motion="in|out" + data-motion-kind="modal|popover|drawer|sheet|toast"；
   遮罩挂 data-motion-mask="in|out"。由属性直接匹配对应体量的时长与关键帧。 */
[data-motion='in'] {
  animation-timing-function: cubic-bezier(.16,1,.3,1);
  animation-fill-mode: backwards;
}
[data-motion='out'] {
  animation-timing-function: cubic-bezier(.4,0,.2,1);
  animation-fill-mode: both;
}

/* S 档：贴身小浮层（popover / toast）── 160ms 入场 / 120ms 退场 */
[data-motion-kind='popover'][data-motion='in'],
[data-motion-kind='toast'][data-motion='in'] {
  animation-duration: 160ms;
}
[data-motion-kind='popover'][data-motion='out'],
[data-motion-kind='toast'][data-motion='out'] {
  animation-duration: 120ms;
}

/* M 档：中型抽屉 / 全屏 sheet ── 240ms 入场 / 200ms 退场 */
[data-motion-kind='drawer'][data-motion='in'],
[data-motion-kind='sheet'][data-motion='in'] {
  animation-duration: 240ms;
}
[data-motion-kind='drawer'][data-motion='out'],
[data-motion-kind='sheet'][data-motion='out'] {
  animation-duration: 200ms;
}

/* L 档：大模态弹窗（modal）── 300ms 柔和进场 / 260ms 加速收起 */
[data-motion-kind='modal'][data-motion='in'] {
  animation-duration: 300ms;
}
[data-motion-kind='modal'][data-motion='out'] {
  animation-duration: 260ms;
}

[data-motion-kind='modal'][data-motion='in'] { animation-name: dsh-motion-modal-in; }
[data-motion-kind='modal'][data-motion='out'] { animation-name: dsh-motion-modal-out; }
[data-motion-kind='popover'][data-motion='in'] { animation-name: dsh-motion-popover-in; }
[data-motion-kind='popover'][data-motion='out'] { animation-name: dsh-motion-popover-out; }
[data-motion-kind='drawer'][data-motion='in'] { animation-name: dsh-motion-drawer-in; }
[data-motion-kind='drawer'][data-motion='out'] { animation-name: dsh-motion-drawer-out; }
[data-motion-kind='sheet'][data-motion='in'] { animation-name: dsh-motion-sheet-in; }
[data-motion-kind='sheet'][data-motion='out'] { animation-name: dsh-motion-sheet-out; }
[data-motion-kind='toast'][data-motion='in'] { animation-name: dsh-motion-toast-in; }
[data-motion-kind='toast'][data-motion='out'] { animation-name: dsh-motion-toast-out; }
[data-motion-mask='in'] { animation: dsh-modal-mask-in 300ms ease backwards; }
[data-motion-mask='out'] { animation: dsh-modal-mask-out 260ms ease both; }

/* ── 减弱动效：属性驱动与 class 驱动一起关掉 ────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  .dsh-modal-slide-in, .dsh-modal-slide-out, .dsh-modal-side-in, .dsh-modal-side-out,
  .dsh-modal-drawer-in, .dsh-modal-drawer-out, .dsh-modal-mask-in, .dsh-modal-mask-out,
  [data-motion='in'], [data-motion='out'], [data-motion-mask='in'], [data-motion-mask='out'],
  [data-page-motion='in'], [data-page-motion='slide'], [data-page-motion='stagger'] > *,
  .dsh-modal-slide-in .dsh-modal-stagger, .dsh-modal-side-in .dsh-modal-stagger,
  .dsh-modal-drawer-in .dsh-modal-stagger {
    animation: none;
  }
}
`

/** 幂等注入全局动效样式表（apply 期调一次即可）。 */
export function ensureOverlayMotionStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.dataset.plugin = 'dsh-seeker-bot'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** 页面转场：整页视图进入时挂这个属性（配合 key={viewId} 让动画重播）。 */
export const PAGE_MOTION_IN = { 'data-page-motion': 'in' } as const

/**
 * 页面转场（纯位移，不淡入）：给「整层替换」的容器用 —— 典型是 Work ⇄ Bot 切换。
 * 这类容器自己铺满视口，淡入会在前几帧透出底下另一套界面（用户看到的「闪一下」）。
 */
export const PAGE_MOTION_SLIDE = { 'data-page-motion': 'slide' } as const

/** 页面转场（错峰）：容器挂这个，子块用 style={{ '--i': index }} 依次上浮。 */
export const PAGE_MOTION_STAGGER = { 'data-page-motion': 'stagger' } as const

/** 属性驱动用法下，卡片根节点要挂的属性。 */
export interface OverlayMotionAttrs {
  'data-motion': 'in' | 'out'
  'data-motion-kind': OverlayMotionKind
}

/** 属性驱动用法下，遮罩要挂的属性。 */
export interface OverlayMaskAttrs {
  'data-motion-mask': 'in' | 'out'
}

/**
 * 浮层开合状态机：关闭时先置 closing 播完退场，再真正 onClose。
 *
 * 与老的两份 `useModalClose` 是同一套语义（含「退场中重开要能取消」与
 * 「closing 收口必须发生在动画结束那一刻」这两个历史坑），区别只是它同时
 * 返回要挂到 DOM 上的属性，新增浮层不用再手拼 class。
 *
 * @param open 当前是否打开（外部状态）
 * @param onClose 退场播完后真正关闭的回调
 * @param kind 形态，决定用哪条 keyframes
 * @param durationMs 时长，默认与 CSS 一致（240ms）
 */
export function useOverlayMotion(
  open: boolean,
  onClose: () => void,
  kind: OverlayMotionKind = 'modal',
  customDurationMs?: number,
): {
  closing: boolean
  requestClose: () => void
  cancelClose: () => void
  cardAttrs: OverlayMotionAttrs
  maskAttrs: OverlayMaskAttrs
} {
  const durationMs = customDurationMs ?? getMotionExitDuration(kind)
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<number | null>(null)
  const closingRef = useRef(false)

  // 打开（含重新打开）时在绘制前复位，避免一帧透明闪现。
  useLayoutEffect(() => {
    if (open) {
      closingRef.current = false
      setClosing(false)
    }
  }, [open])

  const requestClose = useCallback((): void => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    timerRef.current = window.setTimeout(() => {
      closingRef.current = false
      setClosing(false)
      onClose()
    }, durationMs)
  }, [onClose, durationMs])

  /** 撤销尚未播完的退场（退场途中被重新打开时调用，否则定时器会把刚开的面板关掉）。 */
  const cancelClose = useCallback((): void => {
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

  return {
    closing,
    requestClose,
    cancelClose,
    cardAttrs: { 'data-motion': closing ? 'out' : 'in', 'data-motion-kind': kind },
    maskAttrs: { 'data-motion-mask': closing ? 'out' : 'in' },
  }
}
