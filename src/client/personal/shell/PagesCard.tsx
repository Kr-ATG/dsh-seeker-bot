/**
 * dsh-seeker-bot — Bot 右栏「页面」卡（3.1 Pages）。
 *
 * 与「产出物」卡的分工：产出物回答「文件夹里有什么文件」，页面回答「Bot 交付过
 * 哪些**可回访的持久页面**」。同一 slug 反复更新只保留一条（host 按 slug 覆盖），
 * 所以列表很短、每行带更新时间——用户点开的是**最新版**，而不是消息里那张旧卡。
 *
 * 数据来自 `GET /api/personal-agent/pages`，由 store 的 `refreshPages` 拉取并写回
 * `state.pagesByBot`：消息里的旧页面卡（ArtifactCard）也要读同一份列表判断
 * 「这张卡是否已被更新过」。host 路由还没就绪时列表为空 → 整卡不渲染（静默降级）。
 *
 * 视觉复用产出物卡的 `pa-out-*` 类：同一右栏里两张卡必须长得像一套，不另造外框。
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { usePersonal } from '../store.tsx'
import type { PageItem } from '../types.ts'
import { OutputThumb } from './BotOutputsCard.tsx'

/** 时间戳 → `MM-DD HH:mm`（本机时区）；非法时间返回空串，行尾就不画时间。 */
function formatPageTime(time: number): string {
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 页面预览弹层。
 *
 * 直接 iframe 打开宿主给的页面 URL：Pages 的成品就是网页，不需要「先下载再打开」。
 * 结构沿用产出物卡的 `pa-out-preview-*`（fixed 覆盖视口、点遮罩 / Escape 关闭）。
 */
function PagePreview({ page, onClose }: { readonly page: PageItem; readonly onClose: () => void }): ReactElement {
  /*
   * 退场状态：关闭时先播 240ms 退场（遮罩淡出 + 面板下沉缩小），播完再真正卸载。
   *
   * 原来三条入口都直接 onClose()，父层的 preview 一置 null 这层就被摘掉——入场是
   * 160ms 淡入 + 190ms 弹入，出场却是硬消失。时长与曲线对齐 modal-animation.ts
   * 的 MODAL_ANIM_MS（240ms、出场加速曲线），与插件其它弹层同一套手感。
   */
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)

  /** 关闭：先播 240ms 退场，再真正卸载（直接 onClose 会硬消失）。 */
  const requestClose = useCallback((): void => {
    if (closeTimerRef.current !== null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setClosing(false)
      onClose()
    }, 240)
  }, [onClose])

  /*
   * 卸载收尾：清定时器；如果退场还没播完就被强行摘掉（切 Bot 后清单清空、
   * 整卡早退都会这样），仍要把父层的 preview 一并收干净——否则它会留在
   * 父层 state 里，下次清单回来时这张旧预览会自己弹开。
   */
  useEffect(() => () => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
    onClose()
  }, [onClose])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        requestClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [requestClose])

  const time = formatPageTime(page.updatedAt)

  return (
    <div
      className="pa-out-preview"
      role="dialog"
      aria-modal="true"
      aria-label={page.title}
      data-closing={closing ? '1' : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div className="pa-out-preview__panel" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pa-out-preview__head">
          <span className="pa-out-preview__name" title={page.title}>{page.title}</span>
          <span className="pa-out-preview__meta">页面{time === '' ? '' : ` · ${time}`}</span>
          <a className="pa-out-preview__open" href={page.url} target="_blank" rel="noreferrer">
            打开页面
          </a>
          <button
            className="pa-out-preview__close"
            type="button"
            title="关闭预览"
            aria-label="关闭预览"
            onClick={requestClose}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="pa-out-preview__body">
          <iframe className="pa-out-preview__frame" src={page.url} title={page.title} />
        </div>
      </div>
    </div>
  )
}

export interface PagesCardProps {
  /** 当前 Bot id（`state.pagesByBot` 的查询键）。 */
  readonly botId: string
}

export const PagesCard = memo(function PagesCard({ botId }: PagesCardProps): ReactElement | null {
  const { state } = usePersonal()
  const [open, setOpen] = useState(true)
  const [preview, setPreview] = useState<PageItem | null>(null)

  /*
   * 拉取统一由 store 负责（切 Bot + pa:outputs-refresh 事件），这里只读。
   * 两处各拉一次会不同步：消息里的旧页面卡（ArtifactCard）读的是同一份
   * `state.pagesByBot`，它拿不到卡片内部自己发的请求结果。
   */
  const closePreview = useCallback(() => { setPreview(null) }, [])
  const toggleOpen = useCallback(() => { setOpen((value) => !value) }, [])

  const items = state.pagesByBot?.[botId] ?? []
  // 没有页面 / host 未就绪：整张卡不渲染（与「没有产出物」同口径，不占右栏）
  if (items.length === 0) return null

  return (
    <div className="pa-out-card">
      <div
        className="pa-out-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggleOpen}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggleOpen()
          }
        }}
      >
        <span className="pa-out-head__icon">
          {/* 页面：浏览器窗口轮廓，与产出物卡里「网页」分类同一枚图形语言 */}
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="1.8" />
            <path d="M2 6.2h12" />
            <circle cx="4.2" cy="4.6" r=".55" fill="currentColor" stroke="none" />
            <circle cx="6" cy="4.6" r=".55" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <span className="pa-out-head__title">页面</span>
        <span className="pa-out-head__meta">{items.length} 个</span>
        <span className="pa-out-head__chev" data-open={open ? 'true' : 'false'} aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="m4.4 6.2 3.6 3.6 3.6-3.6" />
          </svg>
        </span>
      </div>

      {open ? (
        <div className="pa-out-body">
          <div className="pa-out-list">
            {items.map((page) => (
              <button
                className="pa-out-row"
                type="button"
                key={page.slug}
                data-kind="page"
                title={page.path ?? page.slug}
                onClick={() => setPreview(page)}
              >
                <span className="pa-out-row__thumb" data-kind="page" aria-hidden="true">
                  <OutputThumb kind="page" />
                </span>
                <span className="pa-out-row__name">{page.title}</span>
                <span className="pa-out-row__time">{formatPageTime(page.updatedAt)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {preview !== null ? <PagePreview page={preview} onClose={closePreview} /> : null}
    </div>
  )
})
