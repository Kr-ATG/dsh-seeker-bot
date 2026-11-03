/**
 * 档案弹窗外壳。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────
 * 档案里有几处「一次性的整块任务」需要同一个壳：新建记录、到期提醒、备份与恢复。
 * 各自写一遍 backdrop + 居中 + 点外部关闭 + 定位，迟早会有一处忘了某个细节
 * （最典型的是漏掉「点遮罩关闭」或把 fixed 写回去）。
 *
 * ── 为什么是 absolute 而不是 fixed ──────────────────────────────────
 * 这个页面挂在官方 main 槽位里。fixed 会连侧栏与顶栏一起盖住，用户在那几十秒
 * 里既切不了会话也看不见导航；absolute 只覆盖 .dsh-vault 这一屏，语义是「在
 * 这块区域里居中弹出来」。代价是它必须是 .dsh-vault 的后代——调用点都在
 * Panel 的同一层 JSX 里，这一点由结构保证。
 *
 * ── 遮罩只吃点击，不压暗 ────────────────────────────────────────────
 * 旧版那层 22% 文字色盖在列表上，就是用户说的「灰蒙蒙」。现在遮罩几乎是透明
 * 的：它的职责只有「点空白处关闭」和「把焦点圈在这一块」，视觉上的层级完全
 * 交给弹窗自己的描边与投影。
 */

import type { JSX, ReactNode } from 'react'
import { ensureModalAnimStyles, modalMaskAnimClass } from '../triad-modal-animation.js'
import { css } from './styles.js'

export interface VaultModalProps {
  /** 无障碍名称（读屏软件念的那句「这是什么对话框」）。 */
  label: string
  /** 点遮罩 / 按 Esc 时调用。 */
  onClose: () => void
  /**
   * 是否处于退场中（由调用方的 useModalClose 给出）。
   *
   * 为什么计时器归调用方、壳只收一个布尔：这层壳没有自己的 open 状态，
   * 渲染与卸载由调用方的条件（reminderOpen 之类）决定；壳里再起一个计时器
   * 也拦不住调用方把整棵子树摘掉。所以调用方用共享状态机计时，壳只负责把
   * closing 翻译成遮罩淡出与卡片 pop-out 两个动画类。
   *
   * 省略时按 false 处理：保持「点一下就消失」的旧行为，还没接入状态机的
   * 调用点不受影响。
   */
  closing?: boolean
  children: ReactNode
}

/**
 * 居中弹窗。
 *
 * Esc 交给调用方：同一个页面上可能同时存在「弹窗」与「原地展开的详情」，什么
 * 时候该关哪个由 Panel 那一个 keydown 统一裁决（顺序＝层叠顺序）。这里再挂一
 * 个监听会导致一次 Esc 关掉两层。
 */
export function VaultModal({ label, onClose, closing = false, children }: VaultModalProps): JSX.Element {
  // 遮罩的淡入/淡出 keyframes 在 triad 的共享样式表里，这里保证它已注入（幂等）。
  ensureModalAnimStyles()
  return (
    <div
      // 遮罩：入场淡入 + 退场淡出都由共享的 modalMaskAnimClass 决定（240ms）。
      className={css.backdrop + ' ' + modalMaskAnimClass(closing)}
      // 只在点到遮罩本身时关闭。用 target 判断而不是 stopPropagation：弹窗内部
      // 有些自绘控件会自己冒泡，冒到遮罩上就误关了。
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      aria-hidden="true"
    >
      <div
        className={css.modal}
        // 卡片：退场标记交给样式表（.dsh-vault-modal[data-closing="true"]），
        // 用属性而不是再挂一个动画类，是为了让退场规则的 specificity 稳定压过
        // 本文件里的入场声明——不依赖两张样式表的注入先后。
        data-closing={closing ? 'true' : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        // 弹窗内部的点击一律不往上走（保险：上面的 target 判断已经兜住了）。
        onClick={(event) => { event.stopPropagation() }}
      >
        {children}
      </div>
    </div>
  )
}
