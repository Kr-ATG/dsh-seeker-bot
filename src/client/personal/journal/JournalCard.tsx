/**
 * Personal Agent — 书架封面卡。
 *
 * 左侧书架列表用这一张卡：16:9 封面缩略图（生图结果或 journalCoverSvg 程序化封面）
 * + 期号 / 心情 pill / 标题 / 日期。纯展示 + 点击回调，不依赖 store。
 *
 * 视觉全部交给 journal.css.ts 的 `.pa-journal-card*` 规则，这里只负责结构；
 * 当前正在阅读的一期由 `data-active` 标记（左侧色条 + 描边）。
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
  /** 程序化封面的配色；缺省 dark（与旧外观一致）。 */
  theme?: 'dark' | 'light'
}

/** 封面：优先用生图 / 宿主返回的图，没有就退回程序化 SVG。 */
function coverOf(journal: Journal, theme: 'dark' | 'light'): string {
  if (journal.image !== undefined && journal.image !== '') return journal.image
  return journalCoverSvg({
    title: typeof journal.title === 'string' && journal.title !== '' ? journal.title : '未命名的一期',
    issue: typeof journal.issue === 'string' && journal.issue !== '' ? journal.issue : 'JOURNAL',
  }, theme)
}

export function JournalCard({ journal, onClick, active = false, theme = 'dark' }: JournalCardProps): JSX.Element {
  const cover = coverOf(journal, theme)
  const issue = typeof journal.issue === 'string' && journal.issue !== '' ? journal.issue : 'JOURNAL'
  const title = typeof journal.title === 'string' && journal.title !== '' ? journal.title : '未命名的一期'
  const mood = typeof journal.mood === 'string' ? journal.mood.trim() : ''
  const dateLabel = typeof journal.dateLabel === 'string' && journal.dateLabel !== ''
    ? journal.dateLabel
    : (typeof journal.date === 'string' ? journal.date : '')

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
      aria-label={`${issue} ${title}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <div className="pa-journal-card__cover">
        <img src={cover} alt={title} draggable={false} loading="lazy" />
      </div>
      <div className="pa-journal-card__body">
        <div className="pa-journal-card__top">
          <span className="pa-journal-card__issue">{issue}</span>
          {mood !== '' ? <span className="pa-journal-card__mood">{mood}</span> : null}
        </div>
        <div className="pa-journal-card__title">{title}</div>
        {dateLabel !== '' ? <div className="pa-journal-card__date">{dateLabel}</div> : null}
      </div>
    </div>
  )
}

export default JournalCard
