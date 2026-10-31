/**
 * dsh-seeker-bot — 放大回显画面全屏模态弹窗组件。
 *
 * @module
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { fetchEchoSpaceFrame, type EchoSpaceFrameSuccess } from './api.ts'

export interface KrEchoModalProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onActivate: () => void
  readonly initialFrame?: EchoSpaceFrameSuccess | null
  readonly sessionId?: string | null
  readonly workspaceHints?: readonly string[]
}

/** 放大弹窗轮询间隔（高清 1280px，比小视口稍慢一点省 CPU）。 */
const MODAL_POLL_MS = 900

export const KrEchoModal = memo(function KrEchoModal({
  open,
  onClose,
  onActivate,
  initialFrame = null,
  sessionId = null,
  workspaceHints = [],
}: KrEchoModalProps): ReactElement | null {
  const [frame, setFrame] = useState<EchoSpaceFrameSuccess | null>(initialFrame)
  const [activateFlash, setActivateFlash] = useState(false)
  const timerRef = useRef(0)
  const hintsRef = useRef(workspaceHints)
  hintsRef.current = workspaceHints
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  const poll = useCallback(async () => {
    if (document.hidden) return
    const res = await fetchEchoSpaceFrame({
      session: sessionRef.current,
      hints: hintsRef.current,
      maxW: 1280,
    })
    if (res.ok) setFrame(res)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    void poll()
    timerRef.current = window.setInterval(() => { void poll() }, MODAL_POLL_MS)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      if (timerRef.current !== 0) window.clearInterval(timerRef.current)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, poll, onClose])

  const handleActivateClick = useCallback((e: MouseEvent): void => {
    e.stopPropagation()
    onActivate()
    setActivateFlash(true)
    window.setTimeout(() => setActivateFlash(false), 800)
  }, [onActivate])

  if (!open || typeof document === 'undefined') return null

  const name = frame?.name !== undefined && frame.name !== '' ? frame.name : '工作空间'
  const subtitle = frame?.title !== undefined && frame.title !== '' ? frame.title : (frame?.url ?? '')
  const hasImage = Boolean(frame?.data)

  return createPortal(
    <div
      className="kr-echo-modal__mask"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="放大回显画面"
    >
      <div className="kr-echo-modal__dialog" onClick={(e) => e.stopPropagation()}>
        <div className="kr-echo-modal__header">
          <div className="kr-echo-modal__title-group">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="10" rx="1.5" />
              <path d="M2 6h12" />
            </svg>
            <span className="kr-echo-modal__title">工作空间实时回显</span>
            <span className="kr-echo-modal__subtitle" title={subtitle}>
              {name}{subtitle !== '' ? ' · ' + subtitle : ''}
            </span>
          </div>

          <div className="kr-echo-modal__actions">
            <button
              type="button"
              className="kr-echo-modal__btn"
              onClick={handleActivateClick}
              title="切换到 ego 工作空间窗口"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 2h3v3" />
                <path d="M14 2 8 8" />
                <path d="M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9" />
              </svg>
              <span>{activateFlash ? '已置顶窗口' : '进入工作区'}</span>
            </button>

            <button
              type="button"
              className="kr-echo-modal__close"
              onClick={onClose}
              title="关闭 (Esc)"
              aria-label="关闭放大回显"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
              </svg>
            </button>
          </div>
        </div>

        <div className="kr-echo-modal__body" onClick={handleActivateClick}>
          {hasImage ? (
            <img
              src={'data:image/jpeg;base64,' + frame!.data}
              alt={frame!.title || name}
              className="kr-echo-modal__big-img"
              title="点击直接切到工作空间窗口"
            />
          ) : (
            <div className="kr-echo-modal__empty">
              <svg width="32" height="32" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
                <path d="M2 6.5h12" />
                <circle cx="4.5" cy="4.5" r=".75" fill="currentColor" />
                <circle cx="7" cy="4.5" r=".75" fill="currentColor" />
              </svg>
              <span>正在连接工作空间画面...</span>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
})
