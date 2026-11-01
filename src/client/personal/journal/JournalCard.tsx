/**
 * Personal Agent — 期刊封面卡。
 *
 * 左侧期刊列表与聊天里的 journal 消息块共用这一张卡：
 * 16:9 封面（生图结果或 journalCoverSvg 程序化封面）+ 期号 / 日期 / 标题。
 * 纯展示 + 点击回调，不依赖 store，任何容器都能放。
 */
import type { KeyboardEvent } from 'react'
import { journalCoverSvg } from '../engine.ts'
import type { Journal } from '../types.ts'

export interface JournalCardProps {
  journal: Journal
  /** 点击整张卡（打开这一期）。 */
  onClick?: () => void
  /** 是否为当前正在阅读的一期。 */
  active?: boolean
}

export function JournalCard({ journal, onClick, active = false }: JournalCardProps): JSX.Element {
  const cover = journal.image !== undefined && journal.image !== ''
    ? journal.image
    : journalCoverSvg(journal)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (onClick === undefined) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onClick()
    }
  }

  return (
    <div
      className="pa-journal-card"
      data-active={active ? 'true' : 'false'}
      role={onClick !== undefined ? 'button' : undefined}
      tabIndex={onClick !== undefined ? 0 : undefined}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <div className="pa-journal-card__cover">
        <img src={cover} alt={journal.title} draggable={false} loading="lazy" />
      </div>
      <div className="pa-journal-card__body">
        <div className="pa-journal-card__meta">
          <span className="pa-journal-card__issue">{journal.issue}</span>
          <span className="pa-journal-card__date">{journal.dateLabel}</span>
        </div>
        <div className="pa-journal-card__title">{journal.title}</div>
      </div>
    </div>
  )
}

export default JournalCard
