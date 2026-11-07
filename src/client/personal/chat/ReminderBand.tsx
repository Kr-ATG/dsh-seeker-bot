/**
 * Personal Agent — 提醒条（动图让位到左侧后，在它右边出现的一条极简提示）。
 *
 * 形态（2026-11-07 用户定的）：一行胶囊，从左到右是
 *   状态点 → 倒计时（例行任务，秒级跳动 / 档案则显示「还剩 N 天」）→ 任务名 → 立即执行 → 关闭。
 * 没有卡头小标签、说明段落、三颗按钮——提醒只需要回答「还有多久」和「现在就跑」。
 *
 * 动效：clip-path 从左向右揭示（300ms），倒计时每秒刷新本身就是持续动效；
 * shown / closing 由父层控制，这里不写任何时长，避免和 CSS 抢时序。
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { IconX } from '../icons.tsx'
import { formatCountdown, type ReminderActionId, type ReminderItem } from './reminder.ts'

export interface ReminderBandProps {
  item: ReminderItem
  /** 是否已展开（父层 rAF 后置 true）。 */
  shown: boolean
  /** 是否正在播退场。 */
  closing: boolean
  onAction: (actionId: ReminderActionId) => void
}

/** 时间戳 → HH:mm（提醒条里的到点时间）。 */
function clockOf(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function ReminderBand({ item, shown, closing, onAction }: ReminderBandProps): JSX.Element {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (item.dueAt === undefined) return
    // 每秒只改一个 state（倒计时文本），重渲染范围就是这条提示本身。
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [item.dueAt])

  const countdown = item.dueAt === undefined ? null : formatCountdown(item.dueAt - now)
  /*
   * 到点时间（09:00）必须和倒计时一起出现：只给「还剩 08:00」用户不知道是几点的事，
   * 只给「09:00」又不知道还有多久。两个并排，一眼就能对上。
   */
  const atLabel = item.dueAt === undefined ? null : clockOf(item.dueAt)
  const primary = item.actions[0]
  const order = (index: number): CSSProperties => ({ '--i': index } as CSSProperties)

  return (
    <div
      className="pa-chat__remind"
      data-shown={shown ? 'true' : 'false'}
      data-closing={closing ? 'true' : 'false'}
      data-tone={item.tone}
      role="status"
      aria-live="polite"
    >
      <span className="pa-chat__remind__dot" style={order(0)} aria-hidden="true" />
      {/*
       * 两个时间数字并排容易混淆（倒计时 08:00 / 开始 09:00）：倒计时前面挂一个
       * 「还剩」，开始时间后面挂一个「开始」，各自说清自己是什么。
       */}
      {countdown !== null ? <span className="pa-chat__remind__pre" style={order(1)}>还剩</span> : null}
      <span className="pa-chat__remind__count" data-live={countdown !== null ? 'true' : 'false'} style={order(2)}>
        {countdown ?? item.badge ?? ''}
      </span>
      {atLabel !== null ? (
        <span className="pa-chat__remind__at" style={order(3)}>{atLabel} 开始</span>
      ) : null}
      <span className="pa-chat__remind__title" style={order(4)} title={item.title}>{item.title}</span>
      {primary !== undefined ? (
        <button
          className="pa-chat__remind__act"
          type="button"
          data-primary="true"
          style={order(5)}
          onClick={() => { onAction(primary.id) }}
        >
          {primary.label}
        </button>
      ) : null}
      <button
        className="pa-chat__remind__close"
        type="button"
        aria-label="关闭提醒"
        title="关闭"
        style={order(6)}
        onClick={() => { onAction('dismiss') }}
      >
        <IconX size={13} />
      </button>
    </div>
  )
}
