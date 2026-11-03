/**
 * Personal Agent — 全屏期刊阅读层（编辑杂志风）。
 *
 * 结构是「书架 + 阅读台」：
 *   · 左侧 260px 书架：刊名 / 期数说明 + 按「年 月」分组的封面卡列表，
 *     当前期高亮；顶部按钮可把书架收起，阅读区随之变宽。
 *   · 右侧阅读台：次级 UI 色顶栏（返回对话 / 上一期 / 下一期 / 下载封面 /
 *     规则 / 关闭）+ 居中的纸张。
 *   · 纸张：16:9 封面、期号细线、日期 / 天气 / 心情、衬线大标题、斜体副标题、
 *     首字下沉导语、本期数据、编号章节、当日速览时间线、引文、页脚页码。
 *
 * 主题适配全部走 journal.css.ts 里的 --j-* 变量（亮色象牙纸 / 暗色深墨纸），
 * 组件里不写死任何背景色或文字色。
 *
 * 空态保留「生成今日期刊」按钮（actions.generateJournal）。
 * 响应式：<900px 时书架变成顶部横向滚动条，<640px 标题字号再降一档。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { journalCoverSvg } from '../engine.ts'
import {
  IconArrowLeft,
  IconBook,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconSettings,
  IconSidebar,
  IconSparkles,
  IconX,
} from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import type { Journal } from '../types.ts'
import { JournalCard } from './JournalCard.tsx'
import { JournalRulePanel } from './JournalRulePanel.tsx'
import { injectJournalStyles } from './journal.css.ts'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 当前 Bot 模式的主题：读 `.pa-root[data-pa-theme]`，auto 时由宿主解析后写回这里。 */
function readPaTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark'
  const root = document.querySelector('.pa-root')
  return root !== null && root.getAttribute('data-pa-theme') === 'light' ? 'light' : 'dark'
}

/**
 * 订阅主题变化。
 *
 * 期刊的程序化封面（journalCoverSvg）支持亮 / 暗两套配色，所以纸张与书架卡上的
 * 兜底封面要跟着主题走；主题由 PersonalApp 写到 `.pa-root` 的 data-pa-theme 上，
 * 这里用 MutationObserver 跟着它切换，不额外依赖 store 的 theme 字段（auto 模式
 * 下 store 里存的是 'auto'，拿不到最终解析结果）。
 */
function usePaTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(readPaTheme)
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const root = document.querySelector('.pa-root')
    if (root === null) return undefined
    const sync = (): void => {
      setTheme((prev) => {
        const next = readPaTheme()
        return prev === next ? prev : next
      })
    }
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-pa-theme'] })
    sync()
    return () => observer.disconnect()
  }, [])
  return theme
}

/** 封面：优先生图 / 宿主图片，没有就退回程序化 SVG（按主题取色）。 */
function coverOf(journal: Journal, theme: 'dark' | 'light'): string {
  if (journal.image !== undefined && journal.image !== '') return journal.image
  return journalCoverSvg({
    title: typeof journal.title === 'string' && journal.title !== '' ? journal.title : '未命名的一期',
    issue: typeof journal.issue === 'string' && journal.issue !== '' ? journal.issue : 'JOURNAL',
  }, theme)
}

interface JournalGroup {
  key: string
  label: string
  items: Journal[]
}

/**
 * 按「年 月」分组，保持传入顺序（调用方已按时间倒序）。
 *
 * 旧数据可能没有 date（或格式不合法），这时用 generatedAt 兜底；
 * 两者都拿不到就归到「更早」，保证任何一条记录都能出现在书架上。
 */
function groupJournals(journals: readonly Journal[]): JournalGroup[] {
  const groups: JournalGroup[] = []
  const byKey = new Map<string, JournalGroup>()
  for (const journal of journals) {
    const iso = /^(\d{4})-(\d{2})/.exec(journal.date ?? '')
    let key: string
    let label: string
    if (iso !== null) {
      key = `${iso[1]}-${iso[2]}`
      label = `${iso[1]} 年 ${String(Number(iso[2]))} 月`
    } else {
      const generated = new Date(journal.generatedAt)
      if (Number.isFinite(generated.getTime())) {
        const year = generated.getFullYear()
        const month = generated.getMonth() + 1
        key = `${String(year)}-${pad2(month)}`
        label = `${String(year)} 年 ${String(month)} 月`
      } else {
        key = 'unknown'
        label = '更早'
      }
    }
    let group = byKey.get(key)
    if (group === undefined) {
      group = { key, label, items: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.items.push(journal)
  }
  return groups
}

/** 正文按换行拆段（模型常用空行分段，也有单换行分段的）。 */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function JournalOverlay(): JSX.Element | null {
  const { state, ui, actions, activeBot } = usePersonal()
  const [ruleOpen, setRuleOpen] = useState(false)
  const [shelfOpen, setShelfOpen] = useState(true)
  const [generating, setGenerating] = useState(false)
  const theme = usePaTheme()
  const readerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    injectJournalStyles()
  }, [])

  const visible = ui.view === 'journal' || ui.journalOpenId !== null

  const journals = useMemo(
    () => [...state.journals].sort((a, b) => b.generatedAt - a.generatedAt),
    [state.journals],
  )

  const groups = useMemo(() => groupJournals(journals), [journals])

  const current: Journal | null = useMemo(() => {
    if (ui.journalOpenId !== null) {
      const found = journals.find((journal) => journal.id === ui.journalOpenId)
      if (found !== undefined) return found
    }
    return journals[0] ?? null
  }, [journals, ui.journalOpenId])

  const index = current === null ? -1 : journals.findIndex((journal) => journal.id === current.id)
  const older = index >= 0 && index < journals.length - 1 ? journals[index + 1] : null
  const newer = index > 0 ? journals[index - 1] : null

  const currentCover = useMemo(
    () => (current === null ? '' : coverOf(current, theme)),
    [current, theme],
  )

  const rule = state.settings.journalRule

  /* 打开 / 切期时回到纸面顶部（否则会停在上一期的滚动位置）。 */
  useEffect(() => {
    if (!visible) return
    const node = readerRef.current
    if (node !== null) node.scrollTop = 0
  }, [visible, current?.id])

  /* 键盘：Esc 逐层关闭；左右方向键翻期。 */
  useEffect(() => {
    if (!visible) return undefined
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (ruleOpen) setRuleOpen(false)
        else actions.openJournal(null)
        return
      }
      const target = event.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (event.key === 'ArrowLeft' && older !== null) {
        event.preventDefault()
        actions.openJournal(older.id)
      } else if (event.key === 'ArrowRight' && newer !== null) {
        event.preventDefault()
        actions.openJournal(newer.id)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, ruleOpen, actions, older, newer])

  if (!visible) return null

  const backToChat = (): void => {
    setRuleOpen(false)
    actions.openJournal(null)
    actions.setView('chat')
  }

  const closeOverlay = (): void => {
    setRuleOpen(false)
    actions.openJournal(null)
  }

  const generateToday = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try {
      await actions.generateJournal(activeBot.id)
    } catch {
      actions.toast('生成期刊失败，请稍后再试')
    } finally {
      setGenerating(false)
    }
  }

  const issueRaw = typeof current?.issue === 'string' ? current.issue.trim() : ''
  const issueLabel = issueRaw !== '' ? issueRaw : 'JOURNAL'
  const title = typeof current?.title === 'string' && current.title.trim() !== '' ? current.title : '未命名的一期'
  const dateLabel = current === null
    ? ''
    : (typeof current.dateLabel === 'string' && current.dateLabel !== '' ? current.dateLabel : (current.date ?? ''))
  const weather = typeof current?.weather === 'string' ? current.weather.trim() : ''
  const mood = typeof current?.mood === 'string' ? current.mood.trim() : ''
  const subtitle = typeof current?.subtitle === 'string' ? current.subtitle.trim() : ''
  const summary = typeof current?.summary === 'string' ? current.summary : ''
  const quote = typeof current?.quote === 'string' ? current.quote.trim() : ''
  const stats = current !== null && Array.isArray(current.stats) ? current.stats : []
  const highlights = current !== null && Array.isArray(current.highlights) ? current.highlights : []
  const sections = current !== null && Array.isArray(current.sections) ? current.sections : []
  const hasMeta = dateLabel !== '' || weather !== '' || mood !== ''

  const dateKey = typeof current?.date === 'string' ? current.date : ''
  const downloadName = current === null
    ? 'journal'
    : `journal-${dateKey !== '' ? dateKey : 'undated'}-${issueLabel.replace(/[^a-zA-Z0-9]+/g, '-')}`

  return (
    <div className="pa-journal-overlay" role="dialog" aria-label="期刊日记">
      <div className="pa-journal-shell">
        <aside className="pa-journal-shelf" data-collapsed={shelfOpen ? 'false' : 'true'}>
          <div className="pa-journal-shelf__head">
            <div className="pa-journal-shelf__brand">
              <span className="pa-journal-shelf__mark">
                <IconBook size={16} />
              </span>
              <div className="pa-journal-shelf__titles">
                <div className="pa-journal-shelf__name">期刊日记</div>
                <div className="pa-journal-shelf__issue">Personal Agent · {journals.length} 期</div>
              </div>
            </div>
            <button
              className="pa-journal-shelf__collapse"
              type="button"
              title="收起书架"
              aria-label="收起书架"
              onClick={() => setShelfOpen(false)}
            >
              <IconSidebar size={15} />
            </button>
          </div>

          <div className="pa-journal-shelf__scroll">
            {journals.length === 0 ? (
              <div className="pa-journal-shelf__empty">还没有期刊，生成一期后会出现在这里。</div>
            ) : (
              groups.map((group) => (
                <div className="pa-journal-group" key={group.key}>
                  <div className="pa-journal-group__head">
                    <span className="pa-journal-group__label">{group.label}</span>
                    <span className="pa-journal-group__count">{group.items.length}</span>
                  </div>
                  <div className="pa-journal-group__items">
                    {group.items.map((journal) => (
                      <JournalCard
                        key={journal.id}
                        journal={journal}
                        theme={theme}
                        active={current !== null && journal.id === current.id}
                        onClick={() => actions.openJournal(journal.id)}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="pa-journal-shelf__foot">
            <span>共 {journals.length} 期</span>
            <span>按月归档</span>
          </div>
        </aside>

        <main className="pa-journal-stage">
          <header className="pa-journal-toolbar">
            {!shelfOpen ? (
              <button
                className="pa-journal-iconbtn"
                type="button"
                title="展开书架"
                aria-label="展开书架"
                onClick={() => setShelfOpen(true)}
              >
                <IconSidebar size={16} />
              </button>
            ) : null}
            <button className="pa-journal-back" type="button" title="返回对话" onClick={backToChat}>
              <IconArrowLeft size={15} />
              <span>对话</span>
            </button>
            <div className="pa-journal-toolbar__info">
              <span className="pa-journal-toolbar__label">Personal Journal</span>
              <span className="pa-journal-toolbar__title">
                {current !== null ? `${issueLabel} · ${title}` : '还没有期刊'}
              </span>
            </div>
            <div className="pa-journal-toolbar__nav">
              <button
                className="pa-journal-iconbtn"
                type="button"
                title="上一期"
                aria-label="上一期"
                disabled={older === null}
                onClick={() => { if (older !== null) actions.openJournal(older.id) }}
              >
                <IconChevronLeft size={17} />
              </button>
              <button
                className="pa-journal-iconbtn"
                type="button"
                title="下一期"
                aria-label="下一期"
                disabled={newer === null}
                onClick={() => { if (newer !== null) actions.openJournal(newer.id) }}
              >
                <IconChevronRight size={17} />
              </button>
            </div>
            {current !== null ? (
              <a
                className="pa-journal-iconbtn"
                href={currentCover}
                download={downloadName}
                title="下载这一期封面"
                aria-label="下载这一期封面"
              >
                <IconDownload size={17} />
              </a>
            ) : null}
            <span className="pa-journal-divider" />
            <button
              className="pa-journal-rule-toggle"
              type="button"
              title="期刊触发规则"
              aria-label="期刊触发规则"
              data-on={ruleOpen ? 'true' : 'false'}
              aria-expanded={ruleOpen}
              onClick={() => setRuleOpen((open) => !open)}
            >
              <IconSettings size={14} />
              <span>规则</span>
            </button>
            <button className="pa-journal-iconbtn" type="button" title="关闭" aria-label="关闭期刊" onClick={closeOverlay}>
              <IconX size={17} />
            </button>
          </header>

          <div className="pa-journal-reader" ref={readerRef}>
            {current === null ? (
              <div className="pa-journal-empty">
                <div className="pa-journal-empty__icon">
                  <IconBook size={30} />
                </div>
                <h2 className="pa-journal-empty__title">还没有期刊</h2>
                <p className="pa-journal-empty__text">
                  到达第二天后，在 {rule.startHour}:00–{rule.endHour}:00 之间连续 {rule.idleMinutes} 分钟
                  没有主动对话，它就会自动写一篇总结日记。也可以现在先生成今天的一期。
                </p>
                <button
                  className="pa-journal-empty__btn"
                  type="button"
                  disabled={generating}
                  onClick={() => { void generateToday() }}
                >
                  {generating
                    ? <span className="pa-journal-empty__spinner" aria-hidden="true" />
                    : <IconSparkles size={15} />}
                  {generating ? '正在生成…' : '生成今日期刊'}
                </button>
              </div>
            ) : (
              <article className="pa-journal-paper" key={current.id}>
                <figure className="pa-journal-paper__hero">
                  <img src={currentCover} alt={title} draggable={false} />
                </figure>

                <div className="pa-journal-paper__meta">
                  <span className="pa-journal-meta__issue">{issueLabel}</span>
                  <span className="pa-journal-meta__line" />
                  {hasMeta ? (
                    <span className="pa-journal-meta__tags">
                      {dateLabel !== '' ? <span>{dateLabel}</span> : null}
                      {weather !== '' ? (
                        <>
                          <span className="pa-journal-meta__dot" />
                          <span>{weather}</span>
                        </>
                      ) : null}
                      {mood !== '' ? (
                        <>
                          <span className="pa-journal-meta__dot" />
                          <span>{mood}</span>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </div>

                <h1 className="pa-journal-title">{title}</h1>
                {subtitle !== '' ? <p className="pa-journal-subtitle">{subtitle}</p> : null}
                {summary !== '' ? <p className="pa-journal-summary">{summary}</p> : null}

                {stats.length > 0 ? (
                  <div className="pa-journal-stats">
                    {stats.map((stat, statIndex) => (
                      <div className="pa-journal-stat" key={`${current.id}-stat-${statIndex}`}>
                        <div className="pa-journal-stat__value">{stat.value}</div>
                        <div className="pa-journal-stat__label">{stat.label}</div>
                        {stat.hint !== undefined && stat.hint !== '' ? (
                          <div className="pa-journal-stat__hint">{stat.hint}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {sections.length > 0 ? (
                  <div className="pa-journal-sections">
                    {sections.map((section, sectionIndex) => {
                      const bullets = Array.isArray(section.bullets) ? section.bullets : []
                      const paragraphs = paragraphsOf(typeof section.text === 'string' ? section.text : '')
                      const heading = typeof section.heading === 'string' ? section.heading : ''
                      return (
                        <section className="pa-journal-section" key={`${current.id}-section-${sectionIndex}`}>
                          <div className="pa-journal-section__num">{pad2(sectionIndex + 1)}</div>
                          <div className="pa-journal-section__main">
                            {heading !== '' ? (
                              <h2 className="pa-journal-section__title">{heading}</h2>
                            ) : null}
                            {paragraphs.map((paragraph, paragraphIndex) => (
                              <p className="pa-journal-section__text" key={`${current.id}-section-${sectionIndex}-p-${paragraphIndex}`}>
                                {paragraph}
                              </p>
                            ))}
                            {bullets.length > 0 ? (
                              <ul className="pa-journal-bullets">
                                {bullets.map((bullet, bulletIndex) => (
                                  <li key={`${current.id}-section-${sectionIndex}-b-${bulletIndex}`}>{bullet}</li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        </section>
                      )
                    })}
                  </div>
                ) : null}

                {highlights.length > 0 ? (
                  <section className="pa-journal-highlights">
                    <h2 className="pa-journal-highlights__title">当日速览</h2>
                    <div className="pa-journal-timeline">
                      {highlights.map((highlight, highlightIndex) => (
                        <div className="pa-journal-tl" key={`${current.id}-highlight-${highlightIndex}`}>
                          <div className="pa-journal-tl__time">{highlight.time !== undefined && highlight.time !== '' ? highlight.time : '—'}</div>
                          <div className="pa-journal-tl__axis" aria-hidden="true" />
                          <div className="pa-journal-tl__body">
                            <div className="pa-journal-tl__title">{highlight.title}</div>
                            {highlight.text !== undefined && highlight.text !== '' ? (
                              <div className="pa-journal-tl__text">{highlight.text}</div>
                            ) : null}
                            {highlight.botName !== undefined && highlight.botName !== '' ? (
                              <span className="pa-journal-tl__bot">{highlight.botName}</span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                {quote !== '' ? <blockquote className="pa-journal-quote">{quote}</blockquote> : null}

                <footer className="pa-journal-footer">
                  <span>Personal Agent · Daily Journal</span>
                  <span className="pa-journal-footer__page">
                    PAGE {pad2(index + 1)} / {pad2(journals.length)}
                  </span>
                </footer>
              </article>
            )}
          </div>

          {ruleOpen ? <JournalRulePanel onClose={() => setRuleOpen(false)} /> : null}
        </main>
      </div>
    </div>
  )
}

export default JournalOverlay
