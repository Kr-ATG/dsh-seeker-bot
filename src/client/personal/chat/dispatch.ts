/**
 * Personal Agent — 「已交给谁」回执的派生与文案（纯函数）。
 *
 * ## 这是什么
 *
 * 主 Bot 用 `coordinate_bots` 派活后，界面上原来只有右栏委派面板知道这件事，
 * 对话流里没有任何痕迹——用户说完「@采集 搜一下」，主 Bot 回一句「交给它了」，
 * 然后就只能盯着空气等。
 *
 * 这里把宿主的 assignment 摘要翻成对话流里的一行状态（截图产品里那条
 * `Messaged 采集`），数据源仍是 `GET /assignments`，不新增任何通道。
 *
 * ## 为什么只取 depth === 0
 *
 * 子 Bot 也能派活（它有自己的 assignment 树）。那些更深层的活儿是「孙子任务」，
 * 出现在主管的对话流里只会让用户以为是自己派的。只展示主管亲手派出去的那一层。
 */
import type { AssignmentStatus, AssignmentView } from '../types.ts'

/** 对话流里的一行投递回执。 */
export interface DispatchView {
  /** assignment id（渲染时的稳定 key）。 */
  id: string
  /** 接活的 Bot 名字。 */
  botName: string
  status: AssignmentStatus
  /** 派活时写的任务正文（截断后展示，遮满屏的 brief 没有意义）。 */
  brief: string
  /** 派发时间（Unix ms），用于插进对话流对应位置。 */
  at: number
  /** 完成后的结果摘要（可选）。 */
  result?: string
}

/** 回执保留多久以内的（毫秒）：跨越好几天的旧委派不该再挂在新对话里。 */
const DISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** 一次最多显示几条（最近的在前）。 */
const DISPATCH_MAX_ITEMS = 6

/** brief / result 的展示上限。 */
const DISPATCH_TEXT_MAX = 120

/**
 * 从某个 Bot 的委派摘要里挑出「主管亲手派出去」的那几条。
 *
 * 过滤条件：`requesterBotId === 当前 Bot` 且 `depth === 0`、且在 24 小时内。
 * 按时间倒序取最近 6 条，再反转成正序（渲染要按时间前后插）。
 */
export function dispatchViewsOf(assignments: readonly AssignmentView[] | undefined, requesterBotId: string, now = Date.now()): DispatchView[] {
  if (!Array.isArray(assignments) || assignments.length === 0) return []
  const views: DispatchView[] = []
  for (const item of assignments) {
    if (item === null || typeof item !== 'object') continue
    if (item.requesterBotId !== requesterBotId) continue
    if (item.depth !== 0) continue
    const at = Number(item.createdAt)
    if (!Number.isFinite(at) || now - at > DISPATCH_MAX_AGE_MS) continue
    views.push({
      id: String(item.id),
      botName: String(item.assigneeName ?? '').trim() || '另一个 Bot',
      status: item.status,
      brief: clip(String(item.brief ?? '')),
      at,
      ...(item.result !== undefined && String(item.result).trim() !== '' ? { result: clip(String(item.result)) } : {}),
    })
  }
  views.sort((left, right) => right.at - left.at)
  return views.slice(0, DISPATCH_MAX_ITEMS).reverse()
}

function clip(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim()
  return value.length > DISPATCH_TEXT_MAX ? `${value.slice(0, DISPATCH_TEXT_MAX - 1)}…` : value
}

/** 回执行上那行字。 */
export function dispatchLabel(view: DispatchView): string {
  const name = view.botName
  switch (view.status) {
    case 'completed':
      return `${name} 已完成`
    case 'failed':
      return `${name} 没做成`
    case 'cancelled':
      return `${name} 的活已取消`
    case 'running':
    case 'waiting':
    case 'needs_input':
    case 'resume':
      return `${name} 正在处理`
    default:
      return `已交给 ${name}`
  }
}

/** 回执行是否还「在跑」（决定圆点是否呼吸）。 */
export function isDispatchOpen(view: DispatchView): boolean {
  return view.status === 'queued' || view.status === 'running' || view.status === 'waiting' || view.status === 'resume'
}
