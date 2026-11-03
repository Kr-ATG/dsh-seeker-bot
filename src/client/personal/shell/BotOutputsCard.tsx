/**
 * dsh-seeker-bot — Bot 右栏「产出物」卡。
 *
 * 回答一个问题：**这个 Bot 的产出物文件夹里现在有哪些成品。**
 *
 * 形态对齐 Work 右栏的 `KrOutputsCard`（src/client/kr-chat/KrOutputsCard.tsx）：
 *   · 卡头：盒子图标 +「产出物」+「N 项 · M 类」，整行可点折叠；
 *   · 正文：按类别分组（图片 / 视频 / 音频 / 网页 / PDF / 演示 / 表格 / 文档 /
 *     压缩包 / 其他），组标题是一条发丝线 + 类名 + 计数；
 *   · 每行：按类型画的 SVG 缩略图 + 文件名 + 具体时间（MM-DD HH:mm）；
 *   · 点击行打开预览弹层：图片 img / 视频 video / 音频 audio / pdf、网页 iframe，
 *     其余类型给一个「在新窗口打开」链接。预览完全在本文件内实现，不依赖官方
 *     right sidebar API —— Personal Agent 是独立壳层，不能假设官方渲染器存在。
 *
 * 数据来自 `GET /api/personal-agent/outputs?botId=&name=`；host 已按 mtime 倒序
 * 返回（最多 200 条），前端再做一次稳定排序只为了刷新事件乱序时也不翻转。
 *
 * **没有产出时整张卡不渲染**（与 Work 右栏同一口径）。但「加载中」和「接口失败」
 * 不能把卡整个吞掉：前者要让用户知道在读取，后者要给一行轻提示，否则看起来像
 * 右栏坏了。加载完成且确实为空（且无错误）才 return null。
 *
 * 监听 window 的 `pa:outputs-refresh` 事件重新拉取。事件 detail 可以带
 * `{ botId }` 只刷新指定 Bot；不带则刷新当前卡。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { BotOutputItem, BotOutputKind, BotOutputsResponse } from '../types.ts'

/** 分组展示顺序：与 Work 右栏的 OUTPUT_KIND_ORDER 对齐，只保留 Personal Agent 的十类。 */
const KIND_ORDER: readonly BotOutputKind[] = [
  'image', 'video', 'audio', 'page', 'pdf', 'slide', 'sheet', 'doc', 'archive', 'file',
]

/** 类别中文名（同时用作分组标题）。 */
const KIND_LABEL: Record<BotOutputKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  page: '网页',
  pdf: 'PDF',
  slide: '演示',
  sheet: '表格',
  doc: '文档',
  archive: '压缩包',
  file: '其他',
}

/** 时间戳 → `MM-DD HH:mm`（本机时区）。非法时间返回空串，行尾就不画时间。 */
function formatOutputTime(time: number): string {
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export interface BotOutputsCardProps {
  /** 当前 Bot id（接口查询键）。 */
  readonly botId: string
  /** 当前 Bot 显示名（接口按名字分配产出物文件夹；改名不迁移映射）。 */
  readonly botName: string
}

/**
 * 独立演示页（`file://` 直接打开 dist/personal-agent/index.html）没有宿主。
 *
 * 这种环境里 `/api/personal-agent/outputs` 必然失败，而「失败」在真实 DSH 里
 * 是一条需要告诉用户的轻提示。演示页不该常驻一行「读取产出物失败」——它看起来
 * 像功能坏了，实际只是没有后端。所以 file: 协议下直接视为「这个 Bot 没有产出物」：
 * 不发请求、不显示错误行，清单为空时整卡 return null（与空产出物同口径）。
 *
 * 真实 DSH 环境（http/https）不走这条分支，失败时仍保留一行轻提示。
 */
function isHostlessDemo(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'file:'
}

/**
 * 类别 → 28px SVG 缩略图。
 *
 * 与 Work 右栏同一套图形语言：只画一眼能认出的轮廓（山峦 / 胶片 / 声波 /
 * 折角纸 / 格线 / 投屏 / 拉链箱 / 浏览器窗口），颜色交给 CSS 按 data-kind 给，
 * 形状才是类型判据。`currentColor` + opacity 让图形随深浅主题自动适配。
 *
 * 导出给「页面」卡（PagesCard）复用：同一右栏里两张卡的缩略图必须长得像一套。
 */
export function OutputThumb({ kind }: { readonly kind: BotOutputKind }): ReactElement {
  const common = {
    width: 28,
    height: 28,
    viewBox: '0 0 28 28',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const

  switch (kind) {
    case 'image':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3.5" y="6" width="21" height="16" rx="2.6" opacity=".28" fill="currentColor" stroke="none" />
          <circle cx="10" cy="11.5" r="1.9" />
          <path d="M5 19.4 10.6 14l3.6 3.4 2.9-2.6 5.9 5.4" />
        </svg>
      )
    case 'video':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3.5" y="6" width="21" height="16" rx="2.6" opacity=".28" fill="currentColor" stroke="none" />
          <path d="M11.6 11.2v5.6l4.9-2.8z" fill="currentColor" stroke="none" />
          <path d="M6.6 6v16M21.4 6v16" opacity=".55" />
        </svg>
      )
    case 'audio':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3.5" y="6" width="21" height="16" rx="2.6" opacity=".28" fill="currentColor" stroke="none" />
          <path d="M9.2 11.4v5.2M14 9.6v8.8M18.8 12.4v3.2" strokeWidth="1.8" />
        </svg>
      )
    case 'pdf':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M7 4.6h9.2L21 9.4v14H7z" opacity=".28" fill="currentColor" stroke="none" />
          <path d="M7 4.6h9.2L21 9.4v14H7z" />
          <path d="M16.2 4.6v4.8H21" />
          <path d="M7 16.6h14" strokeWidth="2.6" opacity=".8" />
        </svg>
      )
    case 'doc':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M7 4.6h9.2L21 9.4v14H7z" opacity=".28" fill="currentColor" stroke="none" />
          <path d="M7 4.6h9.2L21 9.4v14H7z" />
          <path d="M16.2 4.6v4.8H21" />
          <path d="M10.4 14.4h7.2M10.4 18h5" opacity=".7" />
        </svg>
      )
    case 'sheet':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="4.6" y="6" width="18.8" height="16" rx="2" opacity=".28" fill="currentColor" stroke="none" />
          <rect x="4.6" y="6" width="18.8" height="16" rx="2" />
          <path d="M4.6 11.4h18.8M4.6 17h18.8" opacity=".7" />
          <path d="M11.6 6v16M17.8 6v16" opacity=".5" />
        </svg>
      )
    case 'slide':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="4.6" y="6.6" width="18.8" height="13" rx="2" opacity=".28" fill="currentColor" stroke="none" />
          <rect x="4.6" y="6.6" width="18.8" height="13" rx="2" />
          <path d="M14 19.6v3.4M10.4 23h7.2" />
          <path d="M12.4 10.6v5l4.4-2.5z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'archive':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="4.6" y="6" width="18.8" height="16" rx="2.2" opacity=".28" fill="currentColor" stroke="none" />
          <rect x="4.6" y="6" width="18.8" height="16" rx="2.2" />
          <path d="M14 6v9" opacity=".7" />
          <path d="M11.6 8.6h4.8M11.6 11.2h4.8" opacity=".7" />
          <rect x="12.2" y="13.6" width="3.6" height="3.4" rx="1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'page':
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3.5" y="6" width="21" height="16" rx="2.6" opacity=".28" fill="currentColor" stroke="none" />
          <rect x="3.5" y="6" width="21" height="16" rx="2.6" />
          <path d="M3.5 11.2h21" opacity=".7" />
          <circle cx="7" cy="8.6" r=".9" fill="currentColor" stroke="none" />
          <path d="M7 14.6h9M7 18h13" opacity=".7" />
        </svg>
      )
    default:
      return (
        <svg {...common} aria-hidden="true">
          <path d="M7 4.6h9.2L21 9.4v14H7z" opacity=".28" fill="currentColor" stroke="none" />
          <path d="M7 4.6h9.2L21 9.4v14H7z" />
          <path d="M16.2 4.6v4.8H21" />
        </svg>
      )
  }
}

/** 预览弹层正文：按类型选原生播放器 / iframe / 打开链接。 */
function PreviewBody({ item }: { readonly item: BotOutputItem }): ReactElement {
  switch (item.kind) {
    case 'image':
      return <img className="pa-out-preview__img" src={item.url} alt={item.name} />
    case 'video':
      return <video className="pa-out-preview__media" src={item.url} controls playsInline />
    case 'audio':
      return (
        <div className="pa-out-preview__audio">
          <audio src={item.url} controls />
        </div>
      )
    case 'pdf':
    case 'page':
      return <iframe className="pa-out-preview__frame" src={item.url} title={item.name} />
    default:
      return (
        <div className="pa-out-preview__file">
          <span className="pa-out-preview__file-icon" data-kind={item.kind}>
            <OutputThumb kind={item.kind} />
          </span>
          <div className="pa-out-preview__file-name">{item.name}</div>
          <a className="pa-out-preview__open" href={item.url} target="_blank" rel="noreferrer">
            在新窗口打开
          </a>
        </div>
      )
  }
}

/**
 * 轻量预览弹层。
 *
 * 不使用官方 right sidebar：Personal Agent 的产出物 URL 是它自己的
 * `/api/personal-agent/file`，官方渲染器不认识。整个弹层渲染在卡片内部，
 * `position: fixed` 覆盖视口；Escape、点遮罩、点关闭按钮都能退出。
 */
function OutputPreview({ item, onClose }: {
  readonly item: BotOutputItem
  readonly onClose: () => void
}): ReactElement {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  const time = formatOutputTime(item.time)

  return (
    <div
      className="pa-out-preview"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="pa-out-preview__panel" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pa-out-preview__head">
          <span className="pa-out-preview__name" title={item.name}>{item.name}</span>
          <span className="pa-out-preview__meta">
            {KIND_LABEL[item.kind]}{time === '' ? '' : ` · ${time}`}
          </span>
          {/*
           * 页面（3.1 Pages）：预览层里是 iframe，要整屏看 / 分享时走这个入口。
           * 只给 page 类型——其它类型要么有原生播放器，要么在正文里已经有下载入口。
           */}
          {item.kind === 'page' ? (
            <a className="pa-out-preview__open" href={item.url} target="_blank" rel="noreferrer">
              打开页面
            </a>
          ) : null}
          <button
            className="pa-out-preview__close"
            type="button"
            title="关闭预览"
            aria-label="关闭预览"
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="pa-out-preview__body">
          <PreviewBody item={item} />
        </div>
      </div>
    </div>
  )
}

export const BotOutputsCard = memo(function BotOutputsCard({
  botId,
  botName,
}: BotOutputsCardProps): ReactElement | null {
  /** file:// 演示页无宿主：初始就不进入「读取中」，首帧直接走空清单口径。 */
  const hostlessDemo = isHostlessDemo()
  const [items, setItems] = useState<BotOutputItem[]>([])
  const [loading, setLoading] = useState(!hostlessDemo)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(true)
  const [preview, setPreview] = useState<BotOutputItem | null>(null)
  /** 手动刷新计数：window 事件只负责 +1，真正的拉取统一走下面这个 effect。 */
  const [refreshTick, setRefreshTick] = useState(0)
  /** 上一轮请求的 botId：切换 Bot 时清掉旧清单，同一 Bot 刷新则保留旧清单避免闪空。 */
  const lastBotRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    const switched = lastBotRef.current !== botId
    lastBotRef.current = botId
    if (switched) {
      setItems([])
      setError(null)
      // 切换 Bot 时把上一台 Bot 的预览弹层一起关掉，避免看到别人的文件。
      setPreview(null)
    }

    /*
     * 独立演示页：接口必然失败，不请求、不报错。清单保持为空 + error 为 null，
     * 渲染层会按「没有产出物」整卡 return null（见下方 early return）。
     */
    if (hostlessDemo) {
      setItems([])
      setError(null)
      setLoading(false)
      return () => { alive = false }
    }

    setLoading(true)

    const load = async (): Promise<void> => {
      try {
        const query = `botId=${encodeURIComponent(botId)}&name=${encodeURIComponent(botName)}`
        const response = await fetch(`/api/personal-agent/outputs?${query}`, { cache: 'no-store' })
        const payload = (await response.json()) as BotOutputsResponse
        if (!alive) return
        if (payload.ok === false) {
          setError(typeof payload.error === 'string' && payload.error !== '' ? payload.error : '读取产出物失败')
          return
        }
        if (Array.isArray(payload.items)) {
          setItems(payload.items)
          setError(null)
          return
        }
        setError('读取产出物失败')
      } catch {
        if (alive) setError('读取产出物失败')
      } finally {
        if (alive) setLoading(false)
      }
    }

    void load()
    return () => { alive = false }
  }, [botId, botName, refreshTick, hostlessDemo])

  /** `pa:outputs-refresh`：host 在文件系统变化 / 每轮回复收口后广播。 */
  useEffect(() => {
    const onRefresh = (event: Event): void => {
      const detail = (event as CustomEvent<{ botId?: string }>).detail
      if (detail !== undefined && detail !== null && typeof detail.botId === 'string' && detail.botId !== botId) return
      setRefreshTick((value) => value + 1)
    }
    window.addEventListener('pa:outputs-refresh', onRefresh)
    return () => { window.removeEventListener('pa:outputs-refresh', onRefresh) }
  }, [botId])

  /** 时间倒序（host 已排好，这里兜底；相同时间保持原顺序）。 */
  const sortedItems = useMemo(
    () => [...items].sort((a, b) => b.time - a.time),
    [items],
  )

  const groups = useMemo(() => {
    const buckets = new Map<BotOutputKind, BotOutputItem[]>()
    for (const kind of KIND_ORDER) buckets.set(kind, [])
    for (const item of sortedItems) {
      const bucket = buckets.get(item.kind)
      if (bucket !== undefined) bucket.push(item)
    }
    return KIND_ORDER
      .map((kind) => ({ kind, label: KIND_LABEL[kind], items: buckets.get(kind) ?? [] }))
      .filter((group) => group.items.length > 0)
  }, [sortedItems])

  const closePreview = useCallback(() => { setPreview(null) }, [])

  const toggleOpen = useCallback(() => { setOpen((value) => !value) }, [])

  // 加载完成、无错误且确实没有产出：整张卡不渲染（与 Work 右栏同一口径）。
  // 加载中 / 失败时保留卡头与一行轻提示，不让右栏看起来像坏了。
  if (!loading && error === null && sortedItems.length === 0) return null

  const header = `${sortedItems.length} 项 · ${groups.length} 类`

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
          {/* 「做出来了什么」：打开的盒子，东西从里面露出来。与 Work 右栏同一枚图标。 */}
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.1 5.2 8 2.4l5.9 2.8v5.6L8 13.6 2.1 10.8z" />
            <path d="M2.1 5.2 8 8l5.9-2.8" />
            <path d="M8 8v5.6" />
          </svg>
        </span>
        <span className="pa-out-head__title">产出物</span>
        <span className="pa-out-head__meta">{header}</span>
        <span className="pa-out-head__chev" data-open={open ? 'true' : 'false'} aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="m4.4 6.2 3.6 3.6 3.6-3.6" />
          </svg>
        </span>
      </div>

      {open ? (
        <div className="pa-out-body">
          {loading && sortedItems.length === 0 ? (
            <div className="pa-out-state">正在读取产出物…</div>
          ) : null}
          {error !== null ? (
            <div className="pa-out-state pa-out-state--error" title={error}>{error}</div>
          ) : null}
          {sortedItems.length > 0 ? (
            <div className="pa-out-list">
              {groups.map((group) => (
                <div className="pa-out-group" key={group.kind} data-kind={group.kind} role="group" aria-label={`${group.label}，${group.items.length} 项`}>
                  <div className="pa-out-group__head">
                    <span className="pa-out-group__name">{group.label}</span>
                    <span className="pa-out-group__rule" aria-hidden="true" />
                    <span className="pa-out-group__count">{group.items.length}</span>
                  </div>
                  {group.items.map((item) => (
                    <button
                      className="pa-out-row"
                      type="button"
                      key={item.path}
                      data-kind={item.kind}
                      title={item.path}
                      onClick={() => setPreview(item)}
                    >
                      <span className="pa-out-row__thumb" data-kind={item.kind} aria-hidden="true">
                        <OutputThumb kind={item.kind} />
                      </span>
                      <span className="pa-out-row__name">{item.name}</span>
                      <span className="pa-out-row__time">{formatOutputTime(item.time)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {preview !== null ? <OutputPreview item={preview} onClose={closePreview} /> : null}
    </div>
  )
})
