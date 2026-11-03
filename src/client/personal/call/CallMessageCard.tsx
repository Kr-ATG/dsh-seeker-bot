/**
 * Personal Agent — 通话记录消息卡（**仅历史记录**）。
 *
 * ⚠️ 新通话**不再产生这张卡**：转写与产物现在逐条以**普通消息**实时进对话流，
 * 整段由 `call-segment` 折叠条收起（见 `store.tsx` 的 `startCall` / `finalizeCall`
 * 与 `MessageBlockView.tsx` 的 `CallSegmentBar`）。留这个组件只为一件事：
 * **老会话里已经存下来的 `{ type: 'call' }` 消息仍要能正常渲染**——历史数据不做
 * 迁移，删掉组件会让那些会话直接报错 / 白屏。
 *
 * 默认折叠：电话图标 + 标题 + 来源 + 发生时间 + 最终时长。展开后逐条显示通话转写
 * （我方带麦克风标记，Bot 回复为普通文本），底部可收起。
 *
 * 两种记录都要能渲染：
 *  · 旧半双工记录（`engine` 缺省）——点按录音 → ASR → 模型 → Edge TTS；
 *  · 全双工实时记录（`engine === 'realtime'`）——多显示模型与音色。
 * 历史数据不做迁移，靠字段是否存在区分即可。
 */
import { useState } from 'react'
import { IconChevronDown, IconMic, IconPhone } from '../icons.tsx'
import { formatClock, formatDuration, voiceLabel, type CallInfo } from '../types.ts'

export interface CallMessageCardProps {
  call: CallInfo & { engine?: 'realtime'; model?: string; voice?: string }
}

export function CallMessageCard({ call }: CallMessageCardProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const duration = call.durationMs ?? (call.endedAt !== undefined ? call.endedAt - call.startedAt : Date.now() - call.startedAt)
  const realtime = call.engine === 'realtime'
  const engineDetail = [call.model, call.voice].filter((item): item is string => item !== undefined && item !== '')
  return (
    <div className="pa-callcard" data-open={open ? 'true' : 'false'}>
      <button className="pa-callcard__head" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="pa-callcard__icon"><IconPhone size={16} /></span>
        <span className="pa-callcard__main">
          <span className="pa-callcard__title">{realtime ? '实时语音通话' : '语音通话'}</span>
          <span className="pa-callcard__meta">
            <span className="pa-callcard__source">{realtime ? '实时双工' : '来自通话'}</span>
            <span>{formatClock(call.startedAt)}</span>
            <span>{formatDuration(duration)}</span>
          </span>
        </span>
        <span className="pa-callcard__chevron"><IconChevronDown size={15} /></span>
      </button>
      {open ? (
        <div className="pa-callcard__body">
          {engineDetail.length > 0 ? (
            <div className="pa-callcard__engine">
              {call.model !== undefined && call.model !== '' ? <span>模型 {call.model}</span> : null}
              {/* 落库的是音色 id，展示翻成中文名；空值整段不渲染，避免「音色 」残句 */}
              {voiceLabel(call.voice) !== '' ? <span>音色 {voiceLabel(call.voice)}</span> : null}
            </div>
          ) : null}
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

