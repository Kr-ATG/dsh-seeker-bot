/**
 * Personal Agent — 通话记录消息卡。
 *
 * 默认折叠：电话图标 + 「语音通话」+ 来源「来自通话」+ 发生时间 + 最终时长。
 * 展开后逐条显示通话转写（我方带麦克风标记，Bot 回复为普通文本），底部可收起。
 */
import { useState } from 'react'
import { IconChevronDown, IconMic, IconPhone } from '../icons.tsx'
import { formatClock, formatDuration, type CallInfo } from '../types.ts'

export interface CallMessageCardProps {
  call: CallInfo
}

export function CallMessageCard({ call }: CallMessageCardProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const duration = call.durationMs ?? (call.endedAt !== undefined ? call.endedAt - call.startedAt : Date.now() - call.startedAt)
  return (
    <div className="pa-callcard" data-open={open ? 'true' : 'false'}>
      <button className="pa-callcard__head" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="pa-callcard__icon"><IconPhone size={16} /></span>
        <span className="pa-callcard__main">
          <span className="pa-callcard__title">语音通话</span>
          <span className="pa-callcard__meta">
            <span className="pa-callcard__source">来自通话</span>
            <span>{formatClock(call.startedAt)}</span>
            <span>{formatDuration(duration)}</span>
          </span>
        </span>
        <span className="pa-callcard__chevron"><IconChevronDown size={15} /></span>
      </button>
      {open ? (
        <div className="pa-callcard__body">
          {call.turns.length === 0 ? <div className="pa-callcard__empty">本次通话没有转写记录</div> : null}
          {call.turns.map((turn) => (
            <div className="pa-callcard__turn" data-role={turn.role} key={turn.id}>
              <div className="pa-callcard__turn-label">
                {turn.role === 'user' ? <IconMic size={11} /> : null}
                <span>{turn.role === 'user' ? '我 · 语音' : '对方'}</span>
                <span className="pa-callcard__turn-time">{formatClock(turn.at)}</span>
              </div>
              <div className="pa-callcard__turn-text">{turn.text}</div>
            </div>
          ))}
          <button className="pa-callcard__collapse" type="button" onClick={() => setOpen(false)}>收起</button>
        </div>
      ) : null}
    </div>
  )
}
