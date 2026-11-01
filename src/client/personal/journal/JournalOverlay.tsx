/**
 * Personal Agent — 全屏期刊阅读层。
 *
 * 触发条件：ui.view === 'journal' 或 ui.journalOpenId !== null。
 * 结构：深色遮罩 → 左侧 280px 期刊列表（全部期刊倒序，封面卡）+
 * 右侧阅读器（顶栏 + 米白纸张）。纸张按杂志排版：16:9 宽幅配图、
 * 期号细线、日期、衬线大标题、副标题、首字下沉摘要、两栏正文、粗线引文、
 * 刊头页脚。无图时用 journalCoverSvg(journal) 程序化封面。
 *
 * 顶栏：返回对话 / 上一期 / 下一期 / 下载 / 规则 / 关闭。
 * 空态：显示「生成今日期刊」，直接调 actions.generateJournal(activeBot.id)。
 */
import { useEffect, useMemo, useState } from 'react'
import { journalCoverSvg } from '../engine.ts'
import {
  IconArrowLeft,
  IconBook,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconSettings,
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

export function JournalOverlay(): JSX.Element | null {
  const { state, ui, actions, activeBot } = usePersonal()
  const [ruleOpen, setRuleOpen] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    injectJournalStyles()
  }, [])

  const visible = ui.view === 'journal' || ui.journalOpenId !== null

  const journals = useMemo(
    () => [...state.journals].sort((a, b) => b.generatedAt - a.generatedAt),
    [state.journals],
  )

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

  useEffect(() => {
    if (!visible) return undefined
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (ruleOpen) {
        setRuleOpen(false)
        return
      }
      actions.openJournal(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [visible, ruleOpen, actions])

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

  const cover = current === null
    ? ''
    : (current.image !== undefined && current.image !== ''
      ? current.image
      : journalCoverSvg(current))

  return (
    <div className="pa-journal-overlay" role="dialog" aria-label="期刊日记">
      <div className="pa-journal-shell">
        <aside className="pa-journal-aside">
          <div className="pa-journal-aside-head">
            <div className="pa-journal-aside-title">
              <IconBook size={15} />
              期刊日记
            </div>
            <div className="pa-journal-aside-sub">{journals.length} 期 · 按时间倒序</div>
          </div>
          <div className="pa-journal-list">
            {journals.length === 0 ? (
              <div className="pa-journal-aside-empty">还没有期刊</div>
            ) : (
              journals.map((journal) => (
                <JournalCard
                  key={journal.id}
                  journal={journal}
                  active={current !== null && journal.id === current.id}
                  onClick={() => actions.openJournal(journal.id)}
                />
              ))
            )}
          </div>
        </aside>

        <main className="pa-journal-main">
          <header className="pa-journal-topbar">
            <button className="pa-journal-back" type="button" title="返回对话" onClick={backToChat}>
              <IconArrowLeft size={16} />
              <span>对话</span>
            </button>
            <div className="pa-journal-topbar__info">
              <span className="pa-journal-topbar__label">Personal Journal</span>
              <span className="pa-journal-topbar__title">
                {current !== null ? `${current.issue} · ${current.title}` : '还没有期刊'}
              </span>
            </div>
            <div className="pa-journal-topbar__nav">
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
                href={cover}
                download={`journal-${current.date}-${current.issue.replace(/[^a-zA-Z0-9]+/g, '-')}`}
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

          <div className="pa-journal-scroll">
            {current === null ? (
              <div className="pa-journal-empty">
                <div className="pa-journal-empty__icon">
                  <IconBook size={30} />
                </div>
                <h2 className="pa-journal-empty__title">还没有期刊</h2>
                <p className="pa-journal-empty__text">
                  到达第二天后，在 0:00–8:00 之间连续 30 分钟没有主动对话，它就会自动写一篇总结日记。
                  也可以现在先生成今天的一期。
                </p>
                <button
                  className="pa-journal-empty__btn"
                  type="button"
                  disabled={generating}
                  onClick={() => { void generateToday() }}
                >
                  <IconSparkles size={15} />
                  {generating ? '正在生成…' : '生成今日期刊'}
                </button>
              </div>
            ) : (
              <article className="pa-journal-paper" key={current.id}>
                <figure className="pa-journal-hero">
                  <img src={cover} alt={current.title} />
                </figure>

                <div className="pa-journal-kicker">{current.issue}</div>

                <div className="pa-journal-date">
                  <span>{current.dateLabel}</span>
                  {current.weather !== undefined && current.weather !== '' ? (
                    <>
                      <span className="pa-journal-date__sep" />
                      <span>{current.weather}</span>
                    </>
                  ) : null}
                  {current.mood !== undefined && current.mood !== '' ? (
                    <>
                      <span className="pa-journal-date__sep" />
                      <span>{current.mood}</span>
                    </>
                  ) : null}
                </div>

                <h1 className="pa-journal-title">{current.title}</h1>
                {current.subtitle !== undefined && current.subtitle !== '' ? (
                  <p className="pa-journal-subtitle">{current.subtitle}</p>
                ) : null}

                <p className="pa-journal-summary">{current.summary}</p>

                <div className="pa-journal-body">
                  {current.sections.map((section, sectionIndex) => (
                    <section className="pa-journal-section" key={`${current.id}-section-${sectionIndex}`}>
                      <h2 className="pa-journal-section-title">{section.heading}</h2>
                      <p>{section.text}</p>
                    </section>
                  ))}
                </div>

                {current.quote !== undefined && current.quote !== '' ? (
                  <blockquote className="pa-journal-quote">{current.quote}</blockquote>
                ) : null}

                <footer className="pa-journal-footer">
                  <span>PERSONAL AGENT · DAILY JOURNAL</span>
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
