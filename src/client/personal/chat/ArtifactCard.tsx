/**
 * Personal Agent — 产出物卡（对话流里的文件）。
 *
 * 模型产出 Office / PDF / 视频之后，正文里往往只留一行路径或一个下载链接
 * （`_tmp/季度报告.docx`、`[下载](_tmp/out.pdf)`）。这行字原来就是纯文本，
 * 用户得自己复制路径去文件管理器里找 —— 这里把它渲染成一张卡：图标 + 文件名 +
 * 类型 + 大小 + 「预览 / 下载」。
 *
 * 预览方式按归族分派（判据全在 media.ts，组件只负责外观）：
 *
 *  · image / video / audio —— 原生 <img> / <video controls> / <audio controls>；
 *  · pdf                  —— 内嵌 iframe，交给浏览器自带的 PDF 查看器；
 *  · page（`.html`）       —— 内嵌 iframe 直接看成品页面，另给「打开页面」入口
 *                            （3.1 Pages：可回访的持久页面，不是普通文件）；
 *  · doc / sheet / slide  —— 先给一张首页页图（宿主把 Office 转成 PNG），
 *                            再挂一个转成 PDF 的 iframe；两个都是宿主路由，
 *                            页图失败时退成图标占位，不出现裂图；
 *  · file（zip 等）        —— 不给预览，只给下载。
 *
 * 预览面板默认收起：一条消息里可能连着三四个产出物，全展开会把对话流顶掉。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDown, IconDownload, IconExpand } from '../icons.tsx'
import {
  artifactKindOf,
  fileExtOf,
  fileNameOf,
  fileUrlOf,
  formatFileSize,
  officePageUrl,
  officePdfUrl,
} from './media.ts'
import type { ArtifactKind } from '../types.ts'

/** 归族 → 中文类型标签（卡片副标题用）。 */
const KIND_LABEL: Readonly<Record<ArtifactKind, string>> = {
  video: '视频',
  audio: '音频',
  pdf: 'PDF',
  doc: '文档',
  sheet: '表格',
  slide: '演示',
  image: '图片',
  page: '页面',
  file: '文件',
}

/** 归族 → 内联图标（24×24、1.6 描边，与 icons.tsx 同一套线性风格）。 */
const GLYPHS: Readonly<Record<ArtifactKind, ReactNode>> = {
  video: (
    <>
      <rect x="2.6" y="5.6" width="13" height="12.8" rx="3" />
      <path d="m15.6 10.2 5.8-3.4v10.4l-5.8-3.4" />
      <path d="m7.4 9.6 3.6 2.4-3.6 2.4Z" />
    </>
  ),
  audio: (
    <>
      <path d="M9.4 17.6V7.2l8.4-1.9v10.3" />
      <circle cx="6.8" cy="17.9" r="2.6" />
      <circle cx="15.2" cy="16" r="2.6" />
    </>
  ),
  pdf: (
    <>
      <path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M13 3.5V9h5" />
      <circle cx="10.4" cy="15.8" r="1.9" />
    </>
  ),
  doc: (
    <>
      <path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M13 3.5V9h5" />
      <path d="M8.4 13.2h7M8.4 16.6h4.6" />
    </>
  ),
  sheet: (
    <>
      <path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M13 3.5V9h5" />
      <path d="M8 12.6h8v5.6H8z" />
      <path d="M8 15.4h8M11.6 12.6v5.6" />
    </>
  ),
  slide: (
    <>
      <rect x="3" y="4.2" width="18" height="12.2" rx="2.2" />
      <path d="M12 16.4v3.2M8.8 19.6h6.4" />
      <path d="m10.6 8.4 3.4 1.9-3.4 1.9Z" />
    </>
  ),
  image: (
    <>
      <rect x="3.2" y="4.5" width="17.6" height="15" rx="2.5" />
      <circle cx="8.8" cy="9.8" r="1.6" />
      <path d="m4.6 17.8 4.6-4.6 3.6 3.1 2.6-2.4 4 3.9" />
    </>
  ),
  // 网页 / 页面（3.1 Pages）：浏览器窗口轮廓 + 标题栏三个点。
  page: (
    <>
      <rect x="3" y="4.6" width="18" height="14.8" rx="2.4" />
      <path d="M3 9.2h18" />
      <circle cx="6" cy="6.9" r="0.8" />
      <circle cx="8.6" cy="6.9" r="0.8" />
      <circle cx="11.2" cy="6.9" r="0.8" />
      <path d="M6.4 12.4h9.2M6.4 15.6h6" />
    </>
  ),
  file: (
    <>
      <path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M13 3.5V9h5" />
    </>
  ),
}

/** 归族图标。 */
function ArtifactGlyph({ kind, size = 18 }: { kind: ArtifactKind; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[kind]}
    </svg>
  )
}

/** Office 三件套的页图 + PDF 预览（这两个都走宿主路由，失败时只降级不报错）。 */
function OfficePreview({ path, name, kind }: { path: string; name: string; kind: ArtifactKind }): JSX.Element {
  const [pageFailed, setPageFailed] = useState(false)
  useEffect(() => { setPageFailed(false) }, [path])
  return (
    <>
      {pageFailed ? (
        <div className="pa-media__thumb-missing">
          <ArtifactGlyph kind={kind} size={22} />
          <span>首页预览暂不可用，可直接下载</span>
        </div>
      ) : (
        <img
          className="pa-media__thumb"
          src={officePageUrl(path)}
          alt={`${name} 首页`}
          loading="lazy"
          decoding="async"
          onError={() => setPageFailed(true)}
        />
      )}
      {/*
       * PDF iframe 是「真预览」：页图只给第一页，翻页/搜索要交给浏览器的 PDF
       * 查看器。宿主转换失败时 iframe 里是错误页，不额外弹错 —— 卡片顶部还有
       * 下载按钮，用户不会被卡死。
       */}
      <iframe className="pa-media__frame" src={officePdfUrl(path)} title={`${name} 预览`} loading="lazy" />
    </>
  )
}

/** 预览正文：按归族分派。`full=true` 用于全屏预览层（Office 只给 PDF iframe，不再叠首页图）。 */
function ArtifactPreview({ path, name, kind, full = false }: { path: string; name: string; kind: ArtifactKind; full?: boolean }): JSX.Element | null {
  const url = fileUrlOf(path)
  if (kind === 'image') {
    return <img className="pa-media__image" src={url} alt={name} loading="lazy" decoding="async" />
  }
  if (kind === 'video') {
    return <video className="pa-media__video" src={url} controls preload="metadata" playsInline />
  }
  if (kind === 'audio') {
    return <audio className="pa-media__audio" src={url} controls preload="metadata" />
  }
  if (kind === 'pdf') {
    return <iframe className="pa-media__frame" src={url} title={`${name} 预览`} loading="lazy" />
  }
  /*
   * 页面（3.1 Pages）：`.html` 直接 iframe 渲染 —— 它就是给人看的成品，
   * 不需要「先下载再用浏览器打开」这一道。头部另有「打开页面」入口，
   * 需要整屏 / 分享时走它。
   */
  if (kind === 'page') {
    return <iframe className="pa-media__frame" src={url} title={`${name} 预览`} loading="lazy" />
  }
  if (kind === 'doc' || kind === 'sheet' || kind === 'slide') {
    // 全屏层里首页图是多余的（用户已经在看大图），只要 PDF 查看器
    if (full) return <iframe className="pa-media__frame pa-media__frame--full" src={officePdfUrl(path)} title={`${name} 预览`} />
    return <OfficePreview path={path} name={name} kind={kind} />
  }
  return null
}

export interface ArtifactCardProps {
  /** 原始路径（相对 bot 工作区，或绝对路径）。 */
  readonly path: string
  /** Markdown 链接的 label（`[下载报告](…)` 里的「下载报告」），可省。 */
  readonly label?: string | undefined
  /** 字节数；只有 host 的 ArtifactRef 带 size 时才有。 */
  readonly size?: number | undefined
  /**
   * 这个页面已经有更新版本（3.1 Pages）。
   *
   * 由 MessageBlockView 按「该 Bot 的 Pages 列表里同一路径的 updatedAt 晚于本条
   * 消息时间」算出来。只做提示、不做版本 diff：用户点它打开最新版，旧卡片留在
   * 原位作为历史记录。
   */
  readonly stale?: { url: string; updatedAt: number } | undefined
}

/**
 * 一张产出物卡。
 *
 * 路径不在白名单里（`artifactKindOf` 返回 null）时按「文件」渲染，而不是返回
 * null：调用方既然把它当产出物传进来，留一张能下载的通用卡比让它凭空消失好。
 */
export function ArtifactCard({ path, label, size, stale }: ArtifactCardProps): JSX.Element {
  const kind = artifactKindOf(path) ?? 'file'
  const name = fileNameOf(path) || path
  const ext = fileExtOf(path).toUpperCase()
  const url = fileUrlOf(path)
  const [open, setOpen] = useState(false)
  /** 全屏预览层：点缩略图打开，点遮罩关闭。 */
  const [lightbox, setLightbox] = useState(false)

  /*
   * 灯箱的退场状态：关闭时先播 240ms 退场（遮罩淡出 + 面板下沉缩小），播完再卸载。
   *
   * 两条入口（点遮罩 / 关闭按钮）原来都直接 setLightbox(false)，灯箱在下一帧就没了，
   * 而入场有 160ms 弹入——一关就是硬消失。时长与曲线对齐 modal-animation.ts 的
   * MODAL_ANIM_MS（240ms、出场加速曲线），与插件其它浮层同一套手感。
   */
  const [lightboxClosing, setLightboxClosing] = useState(false)
  const lightboxTimerRef = useRef<number | null>(null)

  /** 关闭灯箱：先播 240ms 退场，再真正卸载（直接置 false 会硬消失）。 */
  const requestLightboxClose = useCallback((): void => {
    if (lightboxTimerRef.current !== null) return
    setLightboxClosing(true)
    lightboxTimerRef.current = window.setTimeout(() => {
      lightboxTimerRef.current = null
      setLightboxClosing(false)
      setLightbox(false)
    }, 240)
  }, [])

  /* 卸载时清定时器：整条消息被移除时卡片会直接消失，别让回调打在已卸载的组件上。 */
  useEffect(() => () => {
    if (lightboxTimerRef.current !== null) window.clearTimeout(lightboxTimerRef.current)
  }, [])

  const [thumbFailed, setThumbFailed] = useState(false)
  useEffect(() => { setThumbFailed(false) }, [path])
  const previewable = kind !== 'file'
  const meta = [ext, KIND_LABEL[kind], typeof size === 'number' ? formatFileSize(size) : '']
    .filter((part) => part !== '')
    .join(' · ')
  /*
   * 常显缩略图：文档 / 表格 / 演示 / PDF 出首页页图，图片直接用它自己。
   *
   * 用户要的是「文件生成完，一眼看见它长什么样」，而不是先点「预览」再等一张图。
   * 视频与音频没有可靠的静态首帧，仍然走折叠预览。
   */
  const thumbUrl = kind === 'image'
    ? url
    : (kind === 'doc' || kind === 'sheet' || kind === 'slide' || kind === 'pdf')
      ? officePageUrl(path)
      : ''
  const hasThumb = thumbUrl !== '' && !thumbFailed
  return (
    <>
      <div className="pa-media" data-kind={kind} data-open={open ? 'true' : 'false'} data-thumb={hasThumb ? 'true' : 'false'}>
        <div className="pa-media__head">
          <span className="pa-media__icon" data-kind={kind}>
            <ArtifactGlyph kind={kind} size={17} />
          </span>
          <div className="pa-media__main">
            <div className="pa-media__name" title={path}>{name}</div>
            <div className="pa-media__meta">
              {label !== undefined && label !== '' ? <span className="pa-media__label">{label}</span> : null}
              <span className="pa-media__kind">{meta}</span>
              {/*
               * 旧页面提示（3.1）：同一页面已被更新过。给「打开最新版」的入口而不是
               * 隐藏旧卡片——对话流是历史记录，用户回看时仍需要知道当时展示的是什么。
               */}
              {stale !== undefined ? (
                <a
                  className="pa-media__stale"
                  href={stale.url}
                  target="_blank"
                  rel="noreferrer"
                  title="这个页面有更新版本，打开最新版"
                >
                  已更新到下方
                </a>
              ) : null}
            </div>
          </div>
          <div className="pa-media__actions">
            {kind === 'page' ? (
              <a className="pa-media__btn" href={url} target="_blank" rel="noreferrer" title={`在新窗口打开 ${name}`}>
                <IconExpand size={12} />
                <span>打开页面</span>
              </a>
            ) : null}
            {previewable ? (
              <button
                className="pa-media__btn"
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
              >
                {open ? '收起' : '预览'}
                <IconChevronDown size={12} className="pa-media__caret" />
              </button>
            ) : null}
            <a className="pa-media__btn" href={url} download={name} title={`下载 ${name}`}>
              <IconDownload size={12} />
              <span>下载</span>
            </a>
          </div>
        </div>
        {hasThumb ? (
          <button
            className="pa-media__thumbwrap"
            type="button"
            onClick={() => setLightbox(true)}
            title={`打开 ${name} 预览`}
            aria-label={`打开 ${name} 预览`}
          >
            <img
              className="pa-media__thumb"
              src={thumbUrl}
              alt={`${name} 首页预览`}
              loading="lazy"
              decoding="async"
              onError={() => setThumbFailed(true)}
            />
            <span className="pa-media__thumbhint">点击查看</span>
          </button>
        ) : null}
        {open && previewable ? (
          <div className="pa-media__preview">
            <ArtifactPreview path={path} name={name} kind={kind} />
          </div>
        ) : null}
      </div>
      {lightbox ? (
        <div
          className="pa-media__lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${name} 预览`}
          data-closing={lightboxClosing ? '1' : undefined}
          onClick={requestLightboxClose}
        >
          {/* 阻止冒泡：点内容区不该关掉整个预览层 */}
          <div className="pa-media__lightbox-inner" onClick={(event) => event.stopPropagation()}>
            <div className="pa-media__lightbox-head">
              <span className="pa-media__lightbox-title" title={path}>{name}</span>
              <a className="pa-media__btn" href={url} download={name} title={`下载 ${name}`}>
                <IconDownload size={12} />
                <span>下载</span>
              </a>
              <button className="pa-media__btn" type="button" onClick={requestLightboxClose} aria-label="关闭预览">
                关闭
              </button>
            </div>
            <div className="pa-media__lightbox-body">
              <ArtifactPreview path={path} name={name} kind={kind} full />
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
