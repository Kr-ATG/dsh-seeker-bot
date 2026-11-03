/**
 * 任务状态图标（细线 SVG）——任务概览卡与右栏任务记录卡共用这一套。
 *
 * 用户口径（2026-11-02）：「不要用绿色橙色代表，用这种 SVG 代表」。所以状态
 * 一律靠**形状**区分（空心圆 / 勾 / 叉 / 齿轮），颜色只走 currentColor，
 * 由调用方的容器给中性灰阶；深浅主题都跟着文字色走，不需要另配颜色。
 *
 * 运行中的齿轮（用户口径 2026-11-03）：「换成一个 svg 不需要替换，svg 要动态地、
 * 流畅地表达正在执行中」。早先是两个 SVG 帧交替淡入淡出，换帧那一下是一次跳变，
 * 读起来像「闪」而不是「转」。现在只有一个 SVG（齿轮轮廓 + 中心孔），交给 CSS
 * 匀速旋转（tasks.css.ts 的 pa-status-spin）：360° 与 0° 是同一张图，首尾重合，
 * 循环处没有接缝，转速恒定也就没有顿挫。
 *
 * 为什么抽成独立文件：同一套图标要出现在两个组件里（TaskDetailModal 的左栏、
 * TaskRecordCard 的每行），复制两份必然漂移——用户改了一处、另一处还是旧图标。
 */

import type { TaskRecord } from '../types.ts'

/** 图标统一尺寸（16px，放在 16 / 18px 容器里居中）。 */
export const STATUS_ICON_SIZE = 16

/**
 * 齿轮轮廓（16 单位坐标系，中心 8,8）。
 *
 * 7 齿、齿顶半径 6.25、齿根 4.55、齿顶占齿距 38%：齿顶比齿根略窄，缩到 16px 才是
 * 齿轮而不是「一圈花瓣」；7 是质数，转一整圈里没有任何一帧与上一帧重合，「在转」
 * 比 8 齿（每 45° 就与自身重合一次）更连贯。坐标是离线算好写死的，运行时不做三角计算。
 */
const GEAR_PATH = 'M 6.75 3.63 L 9.72 1.99 L 11.63 2.91 L 10.64 4.30 L 12.20 6.25 L 13.77 5.60 L 14.24 7.66 L 12.54 7.76 L 11.99 10.19 L 13.48 11.01 L 12.15 12.67 L 11.02 11.40 L 8.77 12.48 L 9.06 14.16 L 6.94 14.16 L 7.23 12.48 L 4.98 11.40 L 3.85 12.67 L 2.52 11.01 L 4.01 10.19 L 3.46 7.76 L 1.76 7.66 L 2.23 5.60 L 3.80 6.25 L 5.36 4.30 L 4.37 2.91 L 6.28 1.99 L 6.75 3.63 L 9.25 3.63 Z'

/** 待开始 / 中性：空心圆。 */
export function StatusCircleGlyph(): JSX.Element {
  return (
    <svg width={STATUS_ICON_SIZE} height={STATUS_ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** 完成：圆圈 + 勾。 */
export function StatusCheckGlyph(): JSX.Element {
  return (
    <svg width={STATUS_ICON_SIZE} height={STATUS_ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.4 8.15 7.15 9.9 10.6 6.35"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 失败 / 中断：圆圈 + 叉。 */
export function StatusCrossGlyph(): JSX.Element {
  return (
    <svg width={STATUS_ICON_SIZE} height={STATUS_ICON_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.1 6.1 9.9 9.9M9.9 6.1 6.1 9.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 正在执行：单个 SVG 齿轮，靠匀速旋转表达（不换帧、不改颜色）。
 *
 * 一个 <svg> 里只有两条线：齿轮轮廓 + 中心孔。动效完全由外层 CSS 驱动
 * （.pa-status-running svg 的 pa-status-spin），组件本身是纯静态结构——
 * 不挂 requestAnimationFrame、不做状态更新，任务卡里同时有好几行 running
 * 也只是一层合成动画。prefers-reduced-motion 下停转，静态齿轮仍读得出「进行中」。
 */
export function StatusRunningGlyph(): JSX.Element {
  return (
    <span className="pa-status-running" aria-hidden="true">
      <svg width={STATUS_ICON_SIZE} height={STATUS_ICON_SIZE} viewBox="0 0 16 16" fill="none">
        <path d={GEAR_PATH} stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
        <circle cx="8" cy="8" r="2.05" stroke="currentColor" strokeWidth="1.35" />
      </svg>
    </span>
  )
}

/**
 * 任务级状态图标（右栏任务记录卡的每一行）。
 *
 * 与概览步骤的区别只在数据来源：这里读的是 TaskRecord.status（running / done /
 * stopped / failed），不是模型给的计划步骤。进行中用转动的齿轮、完成用勾选圈；
 * 停止用空心圆（中性），不显示成失败。
 */
export function TaskStatusGlyph({ status }: { status: TaskRecord['status'] }): JSX.Element {
  if (status === 'running') return <StatusRunningGlyph />
  if (status === 'done') return <StatusCheckGlyph />
  if (status === 'failed') return <StatusCrossGlyph />
  return <StatusCircleGlyph />
}
