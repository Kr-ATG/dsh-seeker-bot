/**
 * dsh-seeker-bot — Git 工作台「快速提交」弹窗。
 *
 * 与「开启会话」不同：这条路**不经过 agent loop**，直接把当前仓库的
 * `git add -A` / `git commit` / `git push` 交给 host 的脚本化路由执行，
 * 用于「已经改完，只想快速落一个 commit」的场景。
 *
 * 交互约定：
 *   · 打开即请求 AI 按真实 diff 生成 commit message，可改、可重新生成；
 *   · 提交中禁止关闭；成功 / 失败 / 推送失败都有明确反馈；
 *   · 成功后通知调用方刷新 Git 大盘（列状态从「待提交」回到「干净」）。
 *
 * 样式见 kr-chat/styles.ts 的 .kr-git-quick-* 段；浮层开合动画复用全局
 * dsh-modal-slide-* / dsh-modal-mask-*（modal-animation.ts 的 useModalClose）。
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ensureModalAnimStyles, modalAnimClass, modalMaskAnimClass, useModalClose } from '../modal-animation.ts'
import type { GitRosterItem } from './git-roster-store.ts'

export interface GitQuickCommitModalProps {
  /** 当前要提交的仓库（来自 Git 大盘快照）。 */
  readonly item: GitRosterItem
  /** 退场动画播完、真正卸载时触发。 */
  readonly onClose: () => void
  /** 提交成功（或至少 commit 成功）后触发，用于刷新大盘。 */
  readonly onCommitted: () => void
}

/** 提交阶段。 */
type Phase = 'idle' | 'committing' | 'done' | 'error' | 'warning'

interface CommitResponse {
  readonly ok?: boolean
  readonly hash?: string
  readonly pushed?: boolean
  readonly output?: string
  readonly error?: string
}

interface MessageResponse {
  readonly ok?: boolean
  readonly message?: string
  readonly error?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function GitQuickCommitModal({
  item,
  onClose,
  onCommitted,
}: GitQuickCommitModalProps): ReactElement {
  ensureModalAnimStyles()
  const { closing, requestClose } = useModalClose(true, onClose)

  const [message, setMessage] = useState('')
  const [generating, setGenerating] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [statusText, setStatusText] = useState('')
  const [pushRemote, setPushRemote] = useState(true)
  const [showFiles, setShowFiles] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const editedRef = useRef(false)
  const autoRequestedRef = useRef(false)
  const autoCloseTimerRef = useRef<number | null>(null)
  const aliveRef = useRef(true)
  const requestCloseRef = useRef(requestClose)

  requestCloseRef.current = requestClose

  const busy = phase === 'committing'
  const finished = phase === 'done' || phase === 'warning'

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (autoCloseTimerRef.current !== null) {
        window.clearTimeout(autoCloseTimerRef.current)
        autoCloseTimerRef.current = null
      }
    }
  }, [])

  // Esc 关闭（提交中不响应）。快照里的弹窗是独立 portal，不会和 Git 大盘的
  // Esc 监听互相抢：大盘侧在快速提交打开时会让出自己的 Escape。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return
      event.stopPropagation()
      requestCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [busy])

  /** 请求 host 用当前默认模型生成 commit message。 */
  const requestMessage = useCallback(async (force: boolean): Promise<void> => {
    setGenerating(true)
    setStatusText('')
    try {
      const response = await fetch('/api/chat-flow/git-commit-message', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ cwd: item.path }),
      })
      const payload = await response.json() as MessageResponse
      if (!aliveRef.current) return
      if (payload.ok === true && typeof payload.message === 'string' && payload.message.trim() !== '') {
        if (force || !editedRef.current) {
          setMessage(payload.message.trim())
          if (force) editedRef.current = false
        }
      } else if (payload.ok !== true) {
        setStatusText(payload.error ?? '生成提交信息失败，可手动填写')
      }
    } catch (error) {
      if (aliveRef.current) setStatusText(`生成提交信息失败：${errorText(error)}`)
    } finally {
      if (aliveRef.current) setGenerating(false)
    }
  }, [item.path])

  // 打开即自动生成一次；StrictMode 的双执行用 ref 挡住。
  useEffect(() => {
    if (autoRequestedRef.current) return
    autoRequestedRef.current = true
    void requestMessage(false)
    const timer = window.setTimeout(() => { textareaRef.current?.focus() }, 80)
    return () => { window.clearTimeout(timer) }
  }, [requestMessage])

  const handleMessageChange = (value: string): void => {
    editedRef.current = true
    setMessage(value)
  }

  const handleSubmit = useCallback(async (): Promise<void> => {
    const finalMessage = message.trim()
    if (finalMessage === '' || busy || generating) return
    if (autoCloseTimerRef.current !== null) {
      window.clearTimeout(autoCloseTimerRef.current)
      autoCloseTimerRef.current = null
    }
    setPhase('committing')
    setStatusText(pushRemote ? '正在执行 git add / commit / push…' : '正在执行 git add / commit…')
    try {
      const response = await fetch('/api/chat-flow/git-commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ cwd: item.path, message: finalMessage, push: pushRemote }),
      })
      const payload = await response.json() as CommitResponse
      if (!aliveRef.current) return
      if (payload.ok === true) {
        onCommitted()
        if (pushRemote && payload.pushed === false) {
          setPhase('warning')
          setStatusText(payload.output ?? '提交成功，但推送到远程失败')
          return
        }
        setPhase('done')
        setStatusText(payload.output ?? '提交成功')
        autoCloseTimerRef.current = window.setTimeout(() => {
          autoCloseTimerRef.current = null
          if (aliveRef.current) requestCloseRef.current()
        }, 1200)
      } else {
        setPhase('error')
        setStatusText(payload.error ?? '提交失败')
      }
    } catch (error) {
      if (aliveRef.current) {
        setPhase('error')
        setStatusText(`提交失败：${errorText(error)}`)
      }
    }
  }, [message, busy, generating, pushRemote, item.path, onCommitted])

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget && !busy) requestClose()
  }

  return createPortal(
    <div
      className={`kr-git-quick-overlay ${modalMaskAnimClass(closing)}`}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kr-git-quick-title"
    >
      <div
        className={`kr-git-quick-modal ${modalAnimClass(closing)}`}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        <div className="kr-git-quick__header">
          <div className="kr-git-quick__title-row">
            <svg className="kr-git-quick__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 1.5 3 8.2h3.4L5.8 14.5 13 7.3H9.2L8 1.5Z" />
            </svg>
            <span id="kr-git-quick-title" className="kr-git-quick__title">快速提交</span>
            <span className="kr-git-quick__repo" title={item.path}>{item.name}</span>
            {item.branch !== undefined && <span className="kr-git-quick__branch" title={`分支: ${item.branch}`}>{item.branch}</span>}
          </div>
          <button
            type="button"
            className="kr-git-quick__close"
            onClick={() => { if (!busy) requestClose() }}
            disabled={busy}
            title="关闭 (Esc)"
            aria-label="关闭快速提交"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
              <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
            </svg>
          </button>
        </div>

        <div className="kr-git-quick__body">
          <div className="kr-git-quick__summary">
            <div className="kr-git-quick__summary-main">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9.5 1.5H3.5a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V6L9.5 1.5z" />
                <polyline points="9.5 1.5 9.5 6 14 6" />
              </svg>
              <span>工作区待提交：<strong>{item.pendingCount}</strong> 项</span>
            </div>
            <button
              type="button"
              className="kr-git-quick__files-toggle"
              onClick={() => setShowFiles((value) => !value)}
              aria-expanded={showFiles}
            >
              <span>{showFiles ? '收起说明' : '提交范围'}</span>
              <svg className={`kr-git-quick__chevron ${showFiles ? 'kr-git-quick__chevron--up' : ''}`} width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="4 6 8 10 12 6" />
              </svg>
            </button>
          </div>
          {showFiles && (
            <div className="kr-git-quick__scope">
              将提交该仓库全部改动（<code>git add -A</code>），并生成一条本地 commit；
              {pushRemote ? '随后推送到当前跟踪的远程分支。' : '不推送远程。'}
            </div>
          )}

          <div className="kr-git-quick__field">
            <div className="kr-git-quick__field-head">
              <label htmlFor="kr-git-quick-message" className="kr-git-quick__label">Commit Message</label>
              <button
                type="button"
                className="kr-git-quick__ai"
                onClick={() => { void requestMessage(true) }}
                disabled={generating || busy}
                title="根据当前仓库的真实 diff 重新生成"
              >
                <svg className={generating ? 'kr-git-quick__spin' : undefined} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 1v4M8 11v4M1 8h4M11 8h4M3 3l2.8 2.8M10.2 10.2l2.8 2.8M3 13l2.8-2.8M10.2 5.8l2.8-2.8" />
                </svg>
                <span>{generating ? '分析改动中…' : 'AI 重新生成'}</span>
              </button>
            </div>
            <textarea
              id="kr-git-quick-message"
              ref={textareaRef}
              className="kr-git-quick__textarea"
              rows={6}
              value={message}
              disabled={busy || finished}
              placeholder={generating ? '正在根据真实改动生成提交信息…' : '输入 Commit Message，或点「AI 重新生成」'}
              onChange={(event) => handleMessageChange(event.target.value)}
              onKeyDown={(event) => {
                // Ctrl/Cmd + Enter = 确认提交（对话框常规快捷键）。
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void handleSubmit()
                }
              }}
            />
          </div>

          <label className="kr-git-quick__check">
            <input
              type="checkbox"
              checked={pushRemote}
              disabled={busy || finished}
              onChange={(event) => setPushRemote(event.target.checked)}
            />
            <span>提交后推送到远程仓库（git push）</span>
          </label>

          {(statusText !== '' || phase !== 'idle') && (
            <div
              className={`kr-git-quick__status ${
                phase === 'error'
                  ? 'kr-git-quick__status--error'
                  : phase === 'warning'
                    ? 'kr-git-quick__status--warning'
                    : phase === 'done'
                      ? 'kr-git-quick__status--done'
                      : ''
              }`}
              role="status"
              aria-live="polite"
            >
              {(busy || generating) && (
                <svg className="kr-git-quick__spin" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" strokeDasharray="28" strokeDashoffset="10" />
                </svg>
              )}
              {phase === 'done' && (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3.5 8.5l3 3 6-6" />
                </svg>
              )}
              {(phase === 'error' || phase === 'warning') && (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.25" />
                  <line x1="8" y1="5" x2="8" y2="8.5" />
                  <circle cx="8" cy="11" r="0.5" fill="currentColor" />
                </svg>
              )}
              <span>{statusText || (generating ? '正在根据真实改动生成提交信息…' : '')}</span>
            </div>
          )}
        </div>

        <div className="kr-git-quick__footer">
          {finished ? (
            <button type="button" className="kr-git-quick__btn kr-git-quick__btn--primary" onClick={() => requestClose()}>
              关闭
            </button>
          ) : (
            <>
              <button type="button" className="kr-git-quick__btn" onClick={() => { if (!busy) requestClose() }} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="kr-git-quick__btn kr-git-quick__btn--primary"
                onClick={() => { void handleSubmit() }}
                disabled={busy || generating || message.trim() === ''}
              >
                {busy ? '正在提交…' : pushRemote ? '提交并推送' : '仅本地提交'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
