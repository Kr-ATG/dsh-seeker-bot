/**
 * dsh-seeker-bot — 操作面板右侧实时回显视口组件。
 *
 * 2026-10-31 重构：画面来源从「桌面窗口抓帧」改成「会话关联的 ego TaskSpace 页面」。
 *
 * 为什么要换：ego 是多标签浏览器，窗口当前激活的标签经常是用户自己的私人页面
 * （magpie 等）；窗口抓帧会把这种无关页面当成本会话的工作空间显示，用户已明确
 * 反馈「怎么画面还是非会话关联的工作空间的」。而 TaskSpace 截图按任务空间取页面，
 * 后台标签也能截，且天然剥离浏览器外壳与标签栏。
 *
 * 用户纪律：
 *  · 「当关联会话的工作空间关闭应该不显示回显」→ 拿不到工作空间时直接 return null；
 *  · 「右上角的3个标识应该一直保持在右上角不要挪动位置」→ 由 SeekerHead 的
 *    data-browser-on 控制，只有本组件真正可见时才会展开三栏。
 *
 * @module
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, MouseEvent } from 'react'
import { activateBrowserWindow } from '../browser-flag/activate.ts'
import { fetchEchoSpaceFrame, type EchoSpaceFrameSuccess } from './api.ts'
import { KrEchoModal } from './KrEchoModal.tsx'

export interface KrEchoViewportProps {
  /** 当前会话 id（服务端用它读取会话线索并维护会话↔空间绑定）。 */
  readonly sessionId?: string | null
  /** 从会话工具调用里提取的工作空间线索（taskSpace 名称 / spaceId）。 */
  readonly workspaceHints?: readonly string[]
  /** 本会话是否在用浏览器（父级控制是否挂载本组件）。 */
  readonly browserOn?: boolean
  /** 真实可见性变化通知：只有拿到工作空间画面才为 true。 */
  readonly onVisibleChange?: (visible: boolean) => void
}

/** ego-browser 背后的桌面进程候选（点击画面时按序尝试置顶）。 */
const ACTIVATE_CANDIDATES = ['ego', 'chrome', 'msedge'] as const

/** 小视口轮询间隔：有画面 1200ms，无画面 2500ms，长期无空间降到 8s。 */
const POLL_ACTIVE_MS = 1200
const POLL_IDLE_MS = 2500
const POLL_SLOW_MS = 8000

export const KrEchoViewport = memo(function KrEchoViewport({
  sessionId = null,
  workspaceHints = [],
  browserOn = false,
  onVisibleChange,
}: KrEchoViewportProps): ReactElement | null {
  const [frame, setFrame] = useState<EchoSpaceFrameSuccess | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [flash, setFlash] = useState<'ok' | 'fail' | null>(null)
  const failCountRef = useRef(0)
  const busyRef = useRef(false)
  const flashTimerRef = useRef(0)
  const pollTimerRef = useRef(0)
  const onVisibleChangeRef = useRef(onVisibleChange)
  onVisibleChangeRef.current = onVisibleChange
  const hintsRef = useRef(workspaceHints)
  hintsRef.current = workspaceHints
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const frameRef = useRef(frame)
  frameRef.current = frame

  // 提示词数组的引用每次渲染都可能变；用内容指纹稳定 poll 的依赖。
  const hintsKey = useMemo(() => (workspaceHints ?? []).join('\u0001'), [workspaceHints])

  const poll = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    const res = await fetchEchoSpaceFrame({
      session: sessionRef.current,
      hints: hintsRef.current,
      maxW: 400,
    })
    if (res.ok) {
      setFrame(res)
      failCountRef.current = 0
      onVisibleChangeRef.current?.(true)
      return
    }
    failCountRef.current += 1
    // 连续两帧拿不到工作空间（尚未打开 / 已关闭 / ego 未启动）→ 彻底隐藏。
    if (failCountRef.current >= 2) {
      setFrame(null)
      onVisibleChangeRef.current?.(false)
    }
  }, [hintsKey])

  useEffect(() => {
    let disposed = false
    const schedule = (delay: number): void => {
      if (disposed) return
      if (pollTimerRef.current !== 0) window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = window.setTimeout(() => { void run() }, delay)
    }
    const run = async (): Promise<void> => {
      if (disposed) return
      if (typeof document !== 'undefined' && document.hidden) {
        schedule(POLL_IDLE_MS)
        return
      }
      await poll()
      if (disposed) return
      const fail = failCountRef.current
      // 无帧时不是一直 2.5 秒空转：连续 10 次拿不到工作空间后降到 8 秒。
      const delay = frameRef.current !== null
        ? POLL_ACTIVE_MS
        : fail >= 10 ? POLL_SLOW_MS : POLL_IDLE_MS
      schedule(delay)
    }
    void run()
    const onVisibilityChange = (): void => {
      if (!document.hidden) schedule(0)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      if (pollTimerRef.current !== 0) window.clearTimeout(pollTimerRef.current)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [poll, browserOn])

  // 卸载时通知父级收起三栏网格。
  useEffect(() => () => {
    onVisibleChangeRef.current?.(false)
  }, [])

  // 点击回显视口主体 → 激活 ego 窗口。
  const onViewportClick = useCallback((e: MouseEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    void activateBrowserWindow(ACTIVATE_CANDIDATES).then((ok) => {
      if (flashTimerRef.current !== 0) window.clearTimeout(flashTimerRef.current)
      setFlash(ok ? 'ok' : 'fail')
      flashTimerRef.current = window.setTimeout(() => setFlash(null), ok ? 700 : 2000)
    }).finally(() => {
      window.setTimeout(() => { busyRef.current = false }, 500)
    })
  }, [])

  useEffect(() => () => {
    if (flashTimerRef.current !== 0) window.clearTimeout(flashTimerRef.current)
  }, [])

  const onZoomClick = useCallback((e: MouseEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    setModalOpen(true)
  }, [])

  // 核心纪律：没有工作空间画面就彻底不渲染 —— 不显示占位框、不显示空边框。
  if (frame === null) return null

  const name = frame.name !== '' ? frame.name : '工作空间'
  const title = `${name} · ${frame.title || '点击进入工作区'}`

  return (
    <>
      <div
        className="kr-echo-viewport"
        data-flash={flash ?? undefined}
        title={title}
        aria-label={title}
        role="button"
        tabIndex={0}
        onClick={onViewportClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onViewportClick(e as unknown as MouseEvent)
          }
        }}
      >
        <div className="kr-echo-viewport__badge">
          <span className="kr-echo-viewport__dot" />
          <span className="kr-echo-viewport__badge-text">{name}</span>
        </div>

        <img
          src={'data:image/jpeg;base64,' + frame.data}
          alt={frame.title || name}
          className="kr-echo-viewport__img"
        />

        <button
          type="button"
          className="kr-echo-viewport__zoom"
          title="弹出放大回显画面"
          aria-label="弹出放大回显画面"
          onClick={onZoomClick}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 2h4v4" />
            <path d="M14 2 9.5 6.5" />
            <path d="M6 14H2v-4" />
            <path d="M2 14l4.5-4.5" />
          </svg>
        </button>
      </div>

      <KrEchoModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onActivate={() => void activateBrowserWindow(ACTIVATE_CANDIDATES)}
        initialFrame={frame}
        sessionId={sessionId}
        workspaceHints={workspaceHints}
      />
    </>
  )
})
