/**
 * Personal Agent — 消息块渲染。
 *
 * text 走轻量 Markdown（**粗体**、`行内代码`、- / 1. 列表、> 引文、空行分段、
 * `![alt](src)` 图片），全程拆成 React 节点，不使用 dangerouslySetInnerHTML。
 * task / interactive / call / journal / voice 分别交给对应的卡片组件；
 * `call-segment` 是语音通话的折叠条（段内消息本身仍是普通 text 气泡，不包卡）。
 *
 * 工具调用的展示分两条路（1.4 / 2.7）：
 *  · 普通工具 → 连续的一组聚成**一行折叠流水**「N 个动作 · 展开」，展开是中文
 *    时间线（几点、做了什么、参数、结果、耗时）。过程默认不占正文，但随时可查；
 *  · computer / browser 类 → 转成**执行态卡**（动作 + 状态 + 步骤 + 截图），
 *    因为它们回答的是「Bot 此刻在替你做什么」，属于正文级信息。
 * 生图 / 生视频仍走各自的点阵卡与播放器（`generate_image` / `generate_video`）。
 *
 * 正文里「整段只有文件路径 / 下载链接」的段落渲染成产出物卡（ArtifactCard），
 * 视频 / 音频 / PDF / Office / 网页都能在对话流里直接预览或下载。
 */
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { usePersonal } from '../store.tsx'
import {
  IconBook,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCpu,
  IconMonitor,
  IconPause,
  IconPhone,
  IconPlay,
  IconTerminal,
  IconWave,
  IconX,
} from '../icons.tsx'
import {
  formatClock,
  formatDuration,
  type ArtifactRef,
  type AppState,
  type ChatSticker,
  type Message,
  type MessageBlock,
  type MessageRole,
  type TaskStep,
  type ToolRun,
} from '../types.ts'
import { CallMessageCard } from '../call/CallMessageCard.tsx'
import { InteractiveCard } from './InteractiveCard.tsx'
import { ConnectorSuggestCard } from './ConnectorSuggestCard.tsx'
import { ArtifactCard } from './ArtifactCard.tsx'
import { VideoGenerationBlock } from './VideoGenerationBlock.tsx'
import { splitStickerMarks, stickerUrl } from '../../../shared/stickers.ts'
import {
  artifactKindOf,
  errorMessageOf,
  extractArtifactPaths,
  parseArtifactParagraph,
  pathKeyOf,
  pathOfFileUrl,
} from './media.ts'
import { isDesktopControlTool, isExecutionToolName, isStandaloneToolRun } from './message-visibility.ts'
import { ImageGenerationCard, DotMatrix } from '../../generated-images/ImageGenerationCard.tsx'
import { textHasMarkdownImage } from '../../generated-images/layout.ts'
/*
 * 生成式 UI 的两个渲染器（```iu 原生卡片 / ```html 沙箱卡片）。
 *
 * 为什么 Bot 半身可以直接复用 Work 的组件：这两个渲染器只依赖 react 与纯函数
 * （scroll-lock / scroll-guard 都没有任何 import），不碰宿主模块表，esbuild
 * 打包时不会把 personal 半身拖进宿主 runtime。
 */
import { IuCard } from '../../iu/IuCard.tsx'
import { HtmlCard } from '../../html-embed/HtmlCard.tsx'
import { splitIu, type IuPart } from '../../iu/parse.ts'
import { splitHtml, type HtmlPart } from '../../html-embed/parse.ts'
// 只借类型：use-generated-images 会拉 @deepseek-ai/dsh-client-runtime 的运行时，
// personal 半身不依赖宿主模块表，必须用 import type 让 esbuild 整条剥掉。
import type { GeneratedImageCall } from '../../generated-images/use-generated-images.ts'

export interface MessageBlockViewProps {
  message: Message
  /**
   * 当前 Bot 的 Pages 运行时缓存。
   *
   * 由 MessageList 从 context 统一传入，而不是本组件自己 usePersonal()：
   * 后者会让**每一条消息**都订阅整份 store，任何流式 delta 都把几百个消息组件
   * 全部重渲染。传引用 + memo 之后，未变化的消息直接跳过。
   */
  pagesByBot?: AppState['pagesByBot']
}

/* ───────────────────────── 轻量 Markdown ───────────────────────── */

/**
 * 图片地址归一化。
 *
 * bot 生图 / 截图工具落盘的文件在 bot 工作区里，模型正文写的是相对路径
 * （例如 `_tmp/out.png`，可能带空格与中文）。这类地址不能直接给 `<img src>`：
 * 浏览器会按**当前页面**解析，指到 DSH Web 根目录去。统一交给宿主文件路由
 * `GET /api/personal-agent/file?path=...`（相对路径以 bot 工作区为基准解析）。
 *
 * 已经是绝对地址的（http(s) / data:）原样返回，不做任何加工。
 */
export function toImageSrc(src: string): string {
  const value = src.trim()
  if (value === '') return ''
  if (/^(?:https?:\/\/|data:)/i.test(value)) return value
  return `/api/personal-agent/file?path=${encodeURIComponent(value)}`
}

/**
 * 一个完整的图片 token：`![alt](src)`。
 *
 * alt 可为空，src 允许空格 / 中文（收口是「除右括号外任意字符」）。同一个正则
 * 用在两处：行内 token 复核（renderInline），以及「整段只有一张图片」的块级
 * 判据（Paragraph）。
 */
const IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)$/

/**
 * 正文图片：加载失败时不留裂图。
 *
 * 为什么需要：bot 工作区的 `_tmp/` 会被清理器定期清掉，旧消息里的图片 URL
 * 过几天就 404。块级图片换成一行「图片已过期」小字（位置和大小都留着，不会
 * 让对话流跳一下），行内图片直接不渲染（句子保持完整），两者都不出现浏览器
 * 的裂图图标。src 变化时（同一位置换了图）重置失败态。
 */
function MarkdownImage({ src, alt, block }: { src: string; alt: string; block?: boolean }): JSX.Element | null {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  if (failed) {
    if (block !== true) return null
    return <span className="pa-md__img-missing">图片已过期</span>
  }
  return (
    <img
      className={block === true ? 'pa-md__img pa-md__img--block' : 'pa-md__img'}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}

/**
 * 正文链接的安全收口。
 *
 * 轻量 Markdown 原先只认图片 / 粗体 / 行内代码，模型写的 `[MDN 文档](url)`
 * 会原样显示成方括号文本——看起来像「渲染坏了」，用户也没法点。
 *
 * 这里只做**语法还原**，不做地址解析：放行 http(s)、mailto 与站内绝对路径
 * （`/api/...` 这类），其余协议（javascript: / data: / vbscript: / file:）
 * 一律返回 null，交回纯文本渲染。模型输出是不可信内容，链接是它最容易
 * 被用来发起「假登录页 / 本地文件读取」的入口，白名单比黑名单可靠。
 */
function safeHref(raw: string): string | null {
  const url = raw.trim()
  if (url === '') return null
  if (/^(?:https?:\/\/|mailto:)/i.test(url)) return url
  if (/^\/[^/]/.test(url)) return url
  return null
}

/** `[文字](url)`：文字不允许嵌套方括号，地址不允许空白与右括号。 */
const LINK_PATTERN = /^\[([^\]]+)\]\(([^)\s]+)\)$/

/**
 * 裸 URL（`https://…`）也顺手接住：模型在正文里直接贴地址是常态，用户消息里
 * 也一样；不能点的地址和不渲染的链接是同一类缺口。只在行内出现时匹配，
 * 行内代码（反引号）里的地址因为先被 code 分支吃掉，不会变成链接。
 */
const BARE_URL = /^https?:\/\/[^\s<>"')]+$/

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  /*
   * 图片优先于粗体 / 行内代码：`![a](b.png)` 里若先匹配星号或反引号，
   * 图片 token 会被切碎成普通文字（现状就是「只显示文字」）。src 允许空格
   * 与中文，所以用「除右括号外任意字符」收口。
   *
   * 顺序（同一轮扫描里靠「先命中者赢」）：图片 → 粗体 → 行内代码 → 链接 →
   * 裸 URL。链接排在行内代码之后，保证 `` `[x](y)` `` 里的字面量不会被
   * 变成可点链接。
   */
  const pattern = /(!\[[^\]]*\]\([^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>"')]+)/g
  let last = 0
  let match: RegExpExecArray | null = pattern.exec(text)
  let index = 0
  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('![')) {
      const image = IMAGE_PATTERN.exec(token)
      const alt = image?.[1] ?? ''
      const src = image?.[2] ?? ''
      nodes.push(<MarkdownImage key={`${keyPrefix}-i-${index}`} src={toImageSrc(src)} alt={alt} />)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-b-${index}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('[')) {
      /*
       * `[文字](url)`：白名单不过就按纯文本吐回原 token —— 不吞内容、不猜意图。
       * 新窗口打开 + noopener：外链不能拿到宿主窗口的 window.opener。
       */
      const link = LINK_PATTERN.exec(token)
      const label = link?.[1] ?? token
      const href = safeHref(link?.[2] ?? '')
      nodes.push(href === null
        ? token
        : (
          <a
            key={`${keyPrefix}-a-${index}`}
            className="pa-md__link"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={href}
          >{label}</a>
        ))
    } else if (BARE_URL.test(token)) {
      nodes.push(
        <a
          key={`${keyPrefix}-u-${index}`}
          className="pa-md__link pa-md__link--bare"
          href={token}
          target="_blank"
          rel="noopener noreferrer"
          title={token}
        >{token}</a>,
      )
    } else {
      nodes.push(<code key={`${keyPrefix}-c-${index}`}>{token.slice(1, -1)}</code>)
    }
    index += 1
    last = match.index + token.length
    match = pattern.exec(text)
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const BULLET = /^\s*(?:[-*·•])\s+(.*)$/
const NUMBERED = /^\s*(\d+)[.、)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/

function trimTrailingBlank(lines: string[]): string[] {
  const next = [...lines]
  while (next.length > 0 && next[next.length - 1].trim() === '') next.pop()
  return next
}

/**
 * 旧页面索引（3.1 Pages）：归一化路径 → 最新版本。
 *
 * 由 MessageBlockView 按「该 Bot 的 Pages 列表里 updatedAt 晚于本条消息」算出来，
 * 一路透传给正文里的产出物卡。用 Map 而不是逐条 find：一条消息里可能贴好几张
 * 页面卡，逐张线性扫列表在长会话里是 O(n²)。
 */
type StalePageMap = ReadonlyMap<string, { url: string; updatedAt: number }>

function Paragraph({ text, prefix, stalePages }: { text: string; prefix: string; stalePages?: StalePageMap }): JSX.Element {
  const lines = trimTrailingBlank(text.split('\n'))
  const filled = lines.filter((line) => line.trim() !== '')
  /*
   * 整段只有一张图片 → 块级渲染（figure：居中、圆角、alt 作小字 caption）。
   * 判据是「段落 trim 后完全等于 ![alt](src)」：这样列表 / 引文里的图片仍走
   * 原来的行内路径，不会被误升级；「文字 + 图片」的段落也保持行内。
   */
  const soleImage = filled.length === 1 ? IMAGE_PATTERN.exec(text.trim()) : null
  if (soleImage !== null) {
    const alt = soleImage[1] ?? ''
    const src = soleImage[2] ?? ''
    return (
      <figure className="pa-md__figure">
        <MarkdownImage src={toImageSrc(src)} alt={alt} block />
        {alt !== '' ? <figcaption className="pa-md__caption">{alt}</figcaption> : null}
      </figure>
    )
  }
  /*
   * 整段只有「文件路径 / 下载链接」→ 产出物卡（视频 / 音频 / PDF / Office）。
   *
   * 判据在 media.ts 的 parseArtifactParagraph：逐行都必须是白名单文件，混进一句
   * 别的话就返回 null 交回普通段落 —— 句子里的路径不会被拆碎成卡片。图片语法
   * （`![alt](…)`）不在此列，上面已经按图片渲染了。
   */
  const artifacts = parseArtifactParagraph(text)
  if (artifacts !== null) {
    return (
      <div className="pa-media-group">
        {artifacts.map((item, index) => (
          <ArtifactCard
            key={`${item.path}-${index}`}
            path={item.path}
            label={item.label}
            stale={stalePages?.get(pathKeyOf(item.path))}
          />
        ))}
      </div>
    )
  }
  if (filled.length > 0 && filled.every((line) => BULLET.test(line))) {
    return (
      <ul>
        {filled.map((line, index) => {
          const body = BULLET.exec(line)?.[1] ?? line
          return <li key={`${prefix}-li-${index}`}>{renderInline(body, `${prefix}-li-${index}`)}</li>
        })}
      </ul>
    )
  }
  if (filled.length > 0 && filled.every((line) => NUMBERED.test(line))) {
    return (
      <ol>
        {filled.map((line, index) => {
          const body = NUMBERED.exec(line)?.[2] ?? line
          return <li key={`${prefix}-li-${index}`}>{renderInline(body, `${prefix}-li-${index}`)}</li>
        })}
      </ol>
    )
  }
  if (filled.length > 0 && filled.every((line) => QUOTE.test(line))) {
    return (
      <blockquote>
        {filled.map((line, index) => {
          const body = QUOTE.exec(line)?.[1] ?? line
          return (
            <span key={`${prefix}-q-${index}`}>
              {renderInline(body, `${prefix}-q-${index}`)}
              {index < filled.length - 1 ? <br /> : null}
            </span>
          )
        })}
      </blockquote>
    )
  }
  return (
    <p>
      {lines.map((line, index) => (
        <span key={`${prefix}-l-${index}`}>
          {renderInline(line, `${prefix}-l-${index}`)}
          {index < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </p>
  )
}

const MarkdownText = memo(function MarkdownText({ text, stalePages }: { text: string; stalePages?: StalePageMap }): JSX.Element {
  const paragraphs = useMemo(() => text.split(/\n{2,}/).filter((part) => part.trim() !== ''), [text])
  return (
    <div className="pa-md">
      {paragraphs.map((part, index) => (
        <Paragraph key={`p-${index}`} text={part} prefix={`p-${index}`} stalePages={stalePages} />
      ))}
    </div>
  )
})

/* ───────────────────── 生成式 UI：围栏切分 ───────────────────── */

/**
 * 把一段正文切成「md 片段 / iu 卡片 / html 卡片」三种片段。
 *
 * 顺序是「先切 ```html，再在剩下的 md 里切 ```iu」：html 围栏内部可能包含任何
 * 字符串（包括长得像 iu 围栏的东西），先整段拿走就不会被 iu 解析器误伤；
 * 反过来 iu 的正文是一行 JSON，不会出现 ```html 围栏。
 *
 * 没有围栏时 `splitHtml` / `splitIu` 各自返回单个 md 片段，所以这个函数对普通
 * 文本是零开销的透传（`RichText` 会据此走原来的 MarkdownText 快路径）。
 */
function splitRich(text: string): Array<IuPart | HtmlPart> {
  const out: Array<IuPart | HtmlPart> = []
  for (const part of splitHtml(text)) {
    if (part.kind === 'html') {
      out.push(part)
      continue
    }
    for (const sub of splitIu(part.text)) out.push(sub)
  }
  return out
}

/**
 * 正文渲染：有围栏时按片段渲染卡片，没有时保持原来的 Markdown 气泡。
 *
 * 之所以在 TextBubble 里整体替换而不是在 Paragraph 里插入：卡片是块级元素，
 * 夹在段落内部会被 `<p>` 的排版规则挤坏；整段切开后每张卡自己占一块。
 */
const RichText = memo(function RichText({ text, stalePages }: { text: string; stalePages?: StalePageMap }): JSX.Element {
  const parts = useMemo(() => splitRich(text), [text])
  const plain = parts.length === 1 && parts[0]?.kind === 'md'
  if (plain) return <MarkdownText text={text} stalePages={stalePages} />
  return (
    <div className="pa-rich">
      {parts.map((part, index) => {
        if (part.kind === 'md') {
          const trimmed = part.text.trim()
          return trimmed === '' ? null : <MarkdownText key={`md-${index}`} text={trimmed} stalePages={stalePages} />
        }
        if (part.kind === 'iu') {
          return part.pending
            ? <IuCard key={`iu-${index}`} pending bytes={part.bytes} />
            : <IuCard key={`iu-${index}`} spec={part.spec} />
        }
        return <HtmlCard key={`html-${index}`} spec={part.spec} pending={part.pending} />
      })}
    </div>
  )
})

/* ───────────────────────── 文本气泡 ───────────────────────── */

const TextBubble = memo(function TextBubble({ text, role, stalePages }: { text: string; role: MessageRole; stalePages?: StalePageMap }): JSX.Element {
  const [open, setOpen] = useState(false)
  const lineCount = useMemo(() => text.split('\n').length, [text])
  /*
   * 带生成式 UI 围栏的消息不折叠：卡片本身有高度，`pa-md--clamp` 会把卡片
   * 截成半截，而且折叠后用户点「展开」才看到卡，等于把交付物藏起来了。
   * 判据用 ``` 而不是跑一遍 splitRich：这是渲染前的快速路径，不需要精确。
   */
  const hasCard = useMemo(() => text.includes('```'), [text])
  const long = role === 'bot' && !hasCard && (lineCount > 8 || text.length > 680)
  const folded = long && !open
  return (
    <div className={`pa-bubble pa-bubble--${role}`}>
      <div className={folded ? 'pa-md pa-md--clamp' : undefined}>
        <RichText text={text} stalePages={stalePages} />
      </div>
      {long ? (
        <div className="pa-foldbar">
          <button className="pa-foldbar__btn" type="button" data-open={open} onClick={() => setOpen((value) => !value)}>
            {open ? '收起' : '展开'}
            <IconChevronDown size={13} />
          </button>
        </div>
      ) : null}
    </div>
  )
})

/* ───────────────────────── Task 卡 ───────────────────────── */

function stepIcon(step: TaskStep): JSX.Element {
  if (step.done) return <IconCircleCheck size={14} />
  return <span className="pa-task__ring" aria-hidden="true" />
}

function TaskCard({ block }: { block: Extract<MessageBlock, { type: 'task' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const status = block.status
  const tone = /失败|异常|阻塞|错误/.test(status) ? 'fail' : /进行|处理|运行|等待|待/.test(status) ? 'running' : 'done'
  return (
    <div
      className="pa-task"
      data-open={open ? 'true' : 'false'}
      data-status={tone}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setOpen((value) => !value)
        }
      }}
    >
      <div className="pa-task__head">
        <span className="pa-task__icon"><IconCircleCheck size={17} /></span>
        <div className="pa-task__main">
          <div className="pa-task__title">{block.title}</div>
          <div className="pa-task__status">{block.status}</div>
        </div>
        <span className="pa-task__toggle">
          {open ? '收起' : '展开'}
          <IconChevronDown size={13} />
        </span>
      </div>
      <div className="pa-task__body">
        <div className="pa-task__inner">
          {block.detail !== undefined && block.detail !== '' ? <div className="pa-task__detail">{block.detail}</div> : null}
          {block.steps.length > 0 ? (
            <ul className="pa-task__steps">
              {block.steps.map((step, index) => (
                <li className="pa-task__step" data-done={step.done ? 'true' : 'false'} key={`${step.text}-${index}`}>
                  {stepIcon(step)}
                  <span>{step.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────── 工具调用卡 ───────────────────────── */

/**
 * 同一个 run.id 会分两次到达：先 running（宿主 tool/call），后 ok / error
 * （tool/result）。消息块数组按到达顺序排，两份快照可能同时留在数组里。
 *
 * 这里按 id 去重：**位置取第一次出现，内容取最后一次**——卡片留在工具真正
 * 开始执行的位置，状态却在原地从 running 变成结果态，不会并排出现两张卡。
 */
function dedupeToolRuns(blocks: MessageBlock[]): MessageBlock[] {
  const deduped: MessageBlock[] = []
  const slotById = new Map<string, number>()
  for (const block of blocks) {
    if (block.type !== 'tool') {
      deduped.push(block)
      continue
    }
    const slot = slotById.get(block.run.id)
    if (slot === undefined) {
      slotById.set(block.run.id, deduped.length)
      deduped.push(block)
    } else {
      deduped[slot] = block
    }
  }
  return deduped
}

/** 耗时：318ms / 1.2s / 12s / 1m05s。 */
function formatToolDuration(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`
  if (value < 60_000) return `${Math.round(value / 1000)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/** 参数 JSON 压成一行摘要：command=npm run build · timeoutMs=120000。 */
function summarizeToolArgs(args: string): string {
  const text = args.trim()
  if (!text.startsWith('{')) return text
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return text
    return Object.entries(parsed as Record<string, unknown>)
      .map(([key, value]) => `${key}=${flattenArgValue(value)}`)
      .join(' · ')
  } catch {
    return text
  }
}

function flattenArgValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat
}

/* ───────────────────────── 生图块（generate_image） ───────────────────────── */

/** 张数夹在 1–4：点阵按 count 画格子，host 传错时不能画出几十个格子。 */
function safeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(4, Math.max(1, Math.round(value)))
}

/** 宽高比夹在 0.2–5（与 generated-images/layout.ts 的 parseImageRequest 同口径）。 */
function safeRatio(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1
  return Math.min(5, Math.max(0.2, value))
}

/** ToolRun → seeker 生图卡的调用快照。 */
function toImageCall(run: ToolRun): GeneratedImageCall {
  return {
    callId: run.id,
    running: run.status === 'running',
    // personal 半身的图片由 host 直接给同源 URL，没有 spill 二次读取这一步。
    loading: false,
    error: run.status === 'error' ? (errorMessageOf(run.result) ?? '图片生成失败') : null,
    prompt: run.prompt ?? null,
    startedAt: run.startedAt,
    model: run.model ?? null,
    urls: run.images ?? [],
    count: safeCount(run.imageCount),
    ratio: safeRatio(run.imageRatio),
  }
}

/** 卡片要求显式传 images；图片在 calls 的 urls 里，这里给一个稳定空数组。 */
const NO_IMAGES: readonly string[] = []

/**
 * bot 对话里的生图块：直接复用 Seeker 主对话的 ImageGenerationCard。
 *
 * 生成中 = 按本次比例 / 张数呼吸的点阵；出图 = 点阵羽化成图片，点开是大图。
 * 外观与交互都跟 Work 模式一致，不在这里复制第二套点阵。
 */
function ImageGenerationBlock({ block }: { block: Extract<MessageBlock, { type: 'tool' }> }): JSX.Element | null {
  const run = block.run
  const call = useMemo(() => toImageCall(run), [run])
  const calls = useMemo<readonly GeneratedImageCall[]>(() => [call], [call])
  // 卡片的空态判据（与 ImageGenerationCard 内部一致）：没图、没在跑、没报错时
  // 什么都不渲染，这里先让位，免得空容器在消息列里留下一个 gap。
  if (call.urls.length === 0 && !call.running && call.error === null) return null
  /*
   * pa-genimg 是定宽容器（样式见 chat.css.ts）：dgi-stage 内部的点阵格子用
   * 百分比定宽，需要一个确定的包含块；直接挂在 flex-start 的消息列里会收缩成
   * max-content。它同时也是「生图块」与其它块之间的间距边界。
   */
  return (
    <div className="pa-genimg">
      <ImageGenerationCard calls={calls} images={NO_IMAGES} running={call.running} />
    </div>
  )
}

/* ───────────────────────── 执行态块（2.7） ───────────────────────── */

/** 执行态卡的动作描述（中文人话，不把工具名当标题）。 */
function executionActionOf(name: string, status?: string): string {
  const key = name.toLowerCase()
  if (isDesktopControlTool(name)) {
    return status === 'running' ? '正在控制电脑' : status === 'error' ? '电脑控制失败' : '控制电脑'
  }
  if (/computer/.test(key)) return status === 'running' ? '正在操作电脑' : '操作电脑'
  if (/browser/.test(key)) return status === 'running' ? '正在操作浏览器' : '操作浏览器'
  if (/screenshot/.test(key)) return '截屏'
  if (/playwright|puppeteer/.test(key)) return status === 'running' ? '正在自动化操作浏览器' : '用浏览器自动化操作'
  return status === 'running' ? '正在执行界面操作' : '执行界面操作'
}

/**
 * 工具块 → 执行态块。
 *
 * computer / browser / 桌面控制 MCP 类调用的「点哪、输什么」对用户没有审计价值，
 * 有价值的是「它正在屏幕上做什么」——所以这类调用不进工具流水，而是渲染成一张执行态卡：
 * 动作 + 状态 + 可展开步骤 + 实时/结果截图。与工具卡的分工见 types.ts 里 execution 的注释。
 */
function toolRunToExecution(run: ToolRun): MessageBlock {
  const action = executionActionOf(run.name, run.status)
  const detail = summarizeToolArgs(run.args ?? '')
  const shot = run.images !== undefined && run.images.length > 0 ? run.images[0] : undefined
  const failure = run.status === 'error' ? errorMessageOf(run.result) : null
  return {
    type: 'execution',
    status: run.status,
    label: action,
    tool: run.name,
    steps: [{
      at: run.endedAt ?? run.startedAt,
      label: detail === '' ? action : `${action}：${detail}`,
      status: run.status,
    }],
    ...(shot !== undefined ? { media: shot } : {}),
    ...(failure !== null ? { error: failure } : {}),
  }
}

/**
 * 执行态块：状态图标 + 中文动作 + 可展开步骤 + 实时/完成画面。
 *
 * 当 Bot 正在调用桌面控制 MCP 时：
 *  - 头部明确显示「正在控制电脑」与动态呼吸灯；
 *  - 实时显示屏幕画面流（低频按需抓屏，不存历史回放，零性能浪费，不污染 Token）；
 *  - 执行完成后冻结在最后画面或工具返回的媒体帧。
 */
function ExecutionBlock({ block }: { block: Extract<MessageBlock, { type: 'execution' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [mediaFailed, setMediaFailed] = useState(false)
  const [liveScreenUrl, setLiveScreenUrl] = useState<string>('')

  const isDesktop = isDesktopControlTool(block.tool ?? '') || /电脑|桌面/i.test(block.label)
  const isRunning = block.status === 'running'
  const media = block.media ?? ''

  useEffect(() => { setMediaFailed(false) }, [media])

  // 当处于桌面控制且正在执行 (running) 时，按需温和轮询宿主实时桌面画面帧（每 1000ms 一次）
  useEffect(() => {
    if (!isDesktop || !isRunning) return

    let canceled = false
    let timer: any = null

    const fetchNextFrame = (): void => {
      if (canceled) return
      const img = new Image()
      const url = `/api/personal-agent/desktop-screen?t=${Date.now()}`
      img.onload = () => {
        if (canceled) return
        setLiveScreenUrl(url)
        // 成功加载后延迟 1000ms 拉下一帧，避免网络请求堆积
        timer = setTimeout(fetchNextFrame, 1000)
      }
      img.onerror = () => {
        if (canceled) return
        // 失败（如暂无权限）时延长至 2500ms 重试
        timer = setTimeout(fetchNextFrame, 2500)
      }
      img.src = url
    }

    fetchNextFrame()

    return () => {
      canceled = true
      if (timer) clearTimeout(timer)
    }
  }, [isDesktop, isRunning])

  const steps = block.steps ?? []
  const expandable = steps.length > 0

  // 优先级：MCP 返回的高清媒体帧优先；若无，且属于桌面控制，则展示实时桌面画面帧
  const displayMedia = (media !== '' && !mediaFailed) ? media : (isDesktop && liveScreenUrl !== '' ? liveScreenUrl : '')
  const isLiveStream = displayMedia === liveScreenUrl && liveScreenUrl !== '' && isRunning
  const mediaKind = displayMedia === '' ? null : artifactKindOf(pathOfFileUrl(displayMedia) ?? displayMedia)
  // 桌面控制 MCP：用户要求极致简要，严格保持「一句话 + 画面」，不展示冗杂的步骤与工具名
  if (isDesktop) {
    const label = isRunning
      ? '正在控制电脑...'
      : block.status === 'error'
        ? '电脑控制中断'
        : '已完成电脑控制'
    return (
      <div className="pa-exec pa-exec--desktop" data-status={block.status}>
        <div className="pa-exec__head pa-exec__head--simple">
          <span className="pa-exec__glyph" aria-hidden="true">
            <IconMonitor size={15} />
          </span>
          <span className="pa-exec__label">{label}</span>
          {isRunning ? (
            <span className="pa-exec__spinner" aria-label="控制中" />
          ) : block.status === 'error' ? (
            <span className="pa-exec__icon" data-state="error"><IconX size={13} /></span>
          ) : (
            <span className="pa-exec__icon" data-state="ok"><IconCheck size={13} /></span>
          )}
        </div>
        {displayMedia !== '' && (mediaKind === 'image' || mediaKind === 'video') ? (
          <div className="pa-exec__media">
            <div className="pa-exec__viewport">
              {isRunning ? (
                <span className="pa-exec__live-tag" title="当前桌面实时画面">
                  <span className="pa-exec__live-dot" />
                  <span>实时画面</span>
                </span>
              ) : null}
              {mediaKind === 'video' ? (
                <video className="pa-exec__shot" src={displayMedia} controls playsInline preload="metadata" />
              ) : (
                <a href={displayMedia} target="_blank" rel="noreferrer" title="查看大图">
                  <img
                    className="pa-exec__shot"
                    src={displayMedia}
                    alt="桌面画面"
                    loading="lazy"
                    decoding="async"
                    onError={() => {
                      if (displayMedia === media) setMediaFailed(true)
                    }}
                  />
                </a>
              )}
            </div>
          </div>
        ) : isRunning ? (
          <div className="pa-exec__media">
            <div className="pa-exec__viewport pa-exec__viewport--loading">
              <span className="pa-exec__loading-text">正在连接桌面画面...</span>
            </div>
          </div>
        ) : null}
        {block.status === 'error' && block.error !== undefined && block.error !== '' ? (
          <div className="pa-exec__error">{block.error}</div>
        ) : null}
      </div>
    )
  }

  const statusText = block.status === 'running' ? '执行中' : block.status === 'error' ? '失败' : '已完成'
  const toggle = (): void => {
    if (expandable) setOpen((value) => !value)
  }
  return (
    <div
      className="pa-exec"
      data-status={block.status}
      data-open={open ? 'true' : 'false'}
      data-expandable={expandable ? 'true' : 'false'}
      data-kind="generic"
    >
      <div
        className="pa-exec__head"
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (!expandable) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggle()
          }
        }}
      >
        <span className="pa-exec__glyph" aria-hidden="true">
          {isDesktop ? <IconMonitor size={15} /> : <IconCpu size={15} />}
        </span>
        <span className="pa-exec__main">
          <span className="pa-exec__label">{block.label}</span>
          <span className="pa-exec__meta">
            {block.tool !== undefined && block.tool !== '' ? <span className="pa-exec__tool">{block.tool}</span> : null}
            <span className="pa-exec__state-text" data-state={block.status}>{statusText}</span>
            {steps.length > 1 ? <span>{steps.length} 步</span> : null}
          </span>
        </span>
        {block.status === 'running'
          ? <span className="pa-exec__spinner" aria-label="执行中" />
          : block.status === 'error'
            ? <span className="pa-exec__icon" data-state="error"><IconX size={13} /></span>
            : <span className="pa-exec__icon" data-state="ok"><IconCheck size={13} /></span>}
        {expandable ? <IconChevronDown size={12} className="pa-exec__caret" /> : null}
      </div>
      {block.status === 'error' && block.error !== undefined && block.error !== ''
        ? <div className="pa-exec__error">{block.error}</div>
        : null}
      {displayMedia !== '' && (mediaKind === 'image' || mediaKind === 'video') ? (
        <div className="pa-exec__media">
          <div className="pa-exec__viewport">
            {isLiveStream ? (
              <span className="pa-exec__live-tag" title="当前桌面实时画面">
                <span className="pa-exec__live-dot" />
                <span>实时画面</span>
              </span>
            ) : null}
            {mediaKind === 'video' ? (
              <video className="pa-exec__shot" src={displayMedia} controls playsInline preload="metadata" />
            ) : (
              <a href={displayMedia} target="_blank" rel="noreferrer" title="查看大图">
                <img
                  className="pa-exec__shot"
                  src={displayMedia}
                  alt={isLiveStream ? '当前屏幕实时画面' : '执行截图'}
                  loading="lazy"
                  decoding="async"
                  onError={() => {
                    if (displayMedia === media) setMediaFailed(true)
                  }}
                />
              </a>
            )}
          </div>
        </div>
      ) : null}
      <div className="pa-exec__body">
        <div className="pa-exec__inner">
          <ol className="pa-exec__steps">
            {steps.map((step, index) => (
              <li className="pa-exec__step" key={`${step.at}-${index}`} data-status={step.status}>
                <span className="pa-exec__step-dot" aria-hidden="true" />
                <span className="pa-exec__step-time">{formatClock(step.at)}</span>
                <span className="pa-exec__step-label">{step.label}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────── 工具产出物（其它工具的 artifacts） ───────────────────────── */

/**
 * 「正在生成文档」的点阵占位。
 *
 * **复用生图卡的整套视觉**（`dgi-stage` 那套类名 + 同一个 DotMatrix）：同一个点阵
 * 格子、同一个头部布局、同一套呼吸动画。用户明确要求「只要是生成的都要这种点阵图」
 * ——同一件事在对话流里应该长同一个样子，而不是生图一套、文档另一套。
 *
 * 文档生成没有专用工具（模型用 `pwsh` / `run_code` 跑脚本）：占位由模型调用
 * `document_progress` 声明驱动，模型漏调时由宿主监听工作区里的文档文件兜底
 * （`ToolRun.docPending`）。完成后这块被产出物卡替换。
 */
function DocumentPendingBlock({ run }: { run: ToolRun }): JSX.Element {
  const label = run.args !== undefined && run.args !== '' ? run.args : run.name
  return (
    <div className="pa-genimg">
      <div className="dgi-stage">
        <header className="dgi-stage__head">
          <span className="dgi-stage__badge" aria-hidden="true">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z" />
              <path d="M13 3.5V9h5" />
            </svg>
          </span>
          <span className="dgi-stage__title">正在生成文档</span>
        </header>
        <p className="dgi-stage__prompt" title={label}>{label}</p>
        <div className="dgi-stage__groups" data-groups={1}>
          <div className="dgi-stage__group">
            <div className="dgi-stage__reveal">
              <div className="dgi-stage__ghost">
                {/* 0.77 ≈ A4 竖版比例，占位格子看起来就像一页纸 */}
                <div className="dgi-stage__cell" style={{ '--dgi-ratio': 0.77 } as CSSProperties}>
                  <DotMatrix cols={9} rows={11} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 普通工具（present / pwsh / run_code …）产出的文件。
 *
 * 为什么保留这一类块：host 在 `tool/result` 时就把工具产出的可预览文件识别出来
 * 放进 `run.artifacts`（present 的参数路径 + 结果文本里的工作区路径，都 stat 过）。
 * 模型调完 `present` 常常只在正文写一句「已交付」，路径不落到文本里 —— 这时
 * 正文的产出物卡（parseArtifactParagraph）就什么也捡不到，文件等于看不见。
 *
 * 注意**只渲染产出物卡、不渲染工具卡**：`pa-tool` 那套执行记录仍然不出现，
 * 「bot 消息里不要出现工具调用卡片」这条约定不变。
 *
 * 与正文去重：正文里已经写出的同一个文件（不管是不是单独成段），这里跳过 ——
 * 否则同一份报告会在对话流里出现两张卡。
 */
function ToolArtifactsBlock({ run, bodyPaths }: { run: ToolRun; bodyPaths: readonly string[] }): JSX.Element | null {
  const artifacts = run.artifacts ?? []
  const cards = useMemo(() => {
    if (artifacts.length === 0) return []
    const bodyKeys = new Set(bodyPaths.map(pathKeyOf))
    const seen = new Set<string>()
    const out: ArtifactRef[] = []
    for (const item of artifacts) {
      const key = pathKeyOf(item.path)
      if (key === '' || bodyKeys.has(key) || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return out
  }, [artifacts, bodyPaths])
  if (cards.length === 0) return null
  return (
    <div className="pa-media-group">
      {cards.map((item) => <ArtifactCard key={item.path} path={item.path} size={item.size} />)}
    </div>
  )
}

/* ───────────────────────── 可审计执行流水（1.4） ───────────────────────── */

/** 工具名 → 中文动作名（审计流水第一列，不把原始工具名当标题）。 */
function toolActionName(name: string): string {
  const key = name.trim().toLowerCase()
  if (/^(?:pwsh|bash|shell|exec|command|terminal|run_code|python|node|powershell)$/.test(key)) return '执行命令'
  if (/^read$/.test(key)) return '读取文件'
  if (/^(?:write|edit|patch|apply_patch|apply|multiedit)$/.test(key)) return '修改文件'
  if (/^(?:grep|search)$/.test(key)) return '搜索内容'
  if (/^(?:glob|ls|list|dir)$/.test(key)) return '查找文件'
  if (/web_search/.test(key)) return '搜索网页'
  if (/(?:web_fetch|fetch|http|curl)/.test(key)) return '抓取网页'
  if (/todo/.test(key)) return '更新待办'
  if (/present/.test(key)) return '交付文件'
  if (/generate_image/.test(key)) return '生成图片'
  if (/generate_video/.test(key)) return '生成视频'
  if (/task_state|working/.test(key)) return '更新任务状态'
  if (/memory/.test(key)) return '查询记忆'
  if (/skill/.test(key)) return '调用技能'
  if (/bot_emit|emit/.test(key)) return '播报消息'
  if (/subagent|agent/.test(key)) return '派给子任务'
  return '调用工具'
}

/** 结果摘要：失败取人话（不是整块 JSON），成功取结果首行。 */
function toolResultSummary(run: ToolRun): string {
  const result = run.result ?? ''
  if (result.trim() === '') return ''
  if (run.status === 'error') return errorMessageOf(result) ?? ''
  const firstLine = result.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
  return firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine
}

/** 一次工具调用在流水里的耗时（host 没给 durationMs 时用起止时间兜底）。 */
function toolElapsed(run: ToolRun): number {
  if (typeof run.durationMs === 'number') return Math.max(0, run.durationMs)
  if (typeof run.endedAt === 'number') return Math.max(0, run.endedAt - run.startedAt)
  return 0
}

/** 折叠行摘要：主要工具名（最多三个）。 */
function trailToolSummary(runs: readonly ToolRun[]): string {
  const names = [...new Set(runs.map((run) => run.name))]
  const head = names.slice(0, 3).join(' · ')
  return names.length > 3 ? `${head} 等` : head
}

/**
 * 整组耗时：逐个累加。
 *
 * 并行调用会被重复计（同一段时间算两遍），但流水要回答的是「大概花了多久」，
 * 精确到毫秒的墙钟时间反而会和单个动作的耗时对不上，用户更容易困惑。
 */
function trailElapsed(runs: readonly ToolRun[]): number {
  return runs.reduce((total, run) => total + toolElapsed(run), 0)
}

/**
 * 一组连续的工具调用 → 一行折叠流水。
 *
 * 折叠行说三件事：几个动作、主要是什么工具、一共多久；展开后是中文时间线
 * （几点、做了什么、参数、结果、耗时）。产出物卡**不折叠**——交付文件是结果，
 * 不该藏在「展开」里（这与 1.4 之前的行为保持一致）。
 */
function ToolTrail({ runs, bodyPaths }: { runs: ToolRun[]; bodyPaths: readonly string[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const running = runs.some((run) => run.status === 'running')
  const failed = runs.some((run) => run.status === 'error')
  const elapsed = trailElapsed(runs)
  const tone = failed ? 'error' : running ? 'running' : 'ok'
  return (
    <div className="pa-trail" data-open={open ? 'true' : 'false'} data-status={tone}>
      <button
        className="pa-trail__head"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="pa-trail__glyph" aria-hidden="true">
          {running ? <span className="pa-trail__spinner" /> : failed ? <IconX size={12} /> : <IconTerminal size={13} />}
        </span>
        <span className="pa-trail__title">{runs.length} 个动作</span>
        <span className="pa-trail__summary" title={trailToolSummary(runs)}>{trailToolSummary(runs)}</span>
        {elapsed > 0 ? <span className="pa-trail__dur">{formatToolDuration(elapsed)}</span> : null}
        <span className="pa-trail__toggle">
          {open ? '收起' : '展开'}
          <IconChevronDown size={12} className="pa-trail__caret" />
        </span>
      </button>
      <div className="pa-trail__body">
        <div className="pa-trail__inner">
          <ol className="pa-trail__list">
            {runs.map((run) => {
              const args = summarizeToolArgs(run.args ?? '')
              const summary = toolResultSummary(run)
              const cost = toolElapsed(run)
              return (
                <li className="pa-trail__step" key={run.id} data-status={run.status}>
                  <span className="pa-trail__dot" aria-hidden="true" />
                  <span className="pa-trail__time">{formatClock(run.startedAt)}</span>
                  <span className="pa-trail__step-body">
                    <span className="pa-trail__step-line">
                      <span className="pa-trail__step-name">{toolActionName(run.name)}</span>
                      {args !== '' ? <span className="pa-trail__step-args" title={args}>{args}</span> : null}
                      {cost > 0 ? <span className="pa-trail__step-dur">{formatToolDuration(cost)}</span> : null}
                    </span>
                    {summary !== '' ? (
                      <span className="pa-trail__step-result" data-tone={run.status === 'error' ? 'error' : undefined}>
                        {summary}
                      </span>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      </div>
      {runs.map((run) => <ToolArtifactsBlock key={`art-${run.id}`} run={run} bodyPaths={bodyPaths} />)}
    </div>
  )
}

/* ───────────────────────── 期刊卡 ───────────────────────── */

/**
 * 聊天里的期刊卡：横向小卡（72x40 封面缩略图 + 「期刊日记」小标 + 标题 +
 * 日期 + 一行摘要 + 打开箭头）。
 *
 * 用 `pa-journal-mini` 而不是旧的 `pa-journal`：旧类名的样式在 chat.css.ts 里
 * （本任务不允许改那个文件），换一套新类名后由 journal.css.ts 统一接管，
 * 避免与聊天样式互相覆盖。颜色走 --pa-* 变量，跟着 Bot 模式亮 / 暗主题走。
 */
function JournalCard({ block }: { block: Extract<MessageBlock, { type: 'journal' }> }): JSX.Element {
  const { actions } = usePersonal()
  const open = (): void => actions.openJournal(block.journalId)
  return (
    <div
      className="pa-journal-mini"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
    >
      <span className="pa-journal-mini__cover">
        {block.image !== undefined && block.image !== '' ? <img src={block.image} alt="" /> : <IconBook size={20} />}
      </span>
      <span className="pa-journal-mini__body">
        <span className="pa-journal-mini__kicker">期刊日记</span>
        <span className="pa-journal-mini__title">{block.title}</span>
        <span className="pa-journal-mini__meta">{block.date}</span>
        <span className="pa-journal-mini__summary">{block.summary}</span>
      </span>
      <span className="pa-journal-mini__open" aria-hidden="true">
        <IconChevronRight size={16} />
      </span>
    </div>
  )
}

/* ───────────────────────── 语音通话折叠条 ───────────────────────── */

/**
 * 一段语音通话的折叠条。
 *
 * 语音通话不再包成一张「通话卡」：段内的转写与产物都是**普通消息**，跟打字聊天
 * 同一个气泡样式。这条只负责把「这一通电话」整段收起来 / 放出来——用户的原话是
 * 「收起只是把之前语音开始到截止这一段收起，而不是改变 UI 样式」，所以它的视觉
 * 必须轻：两条发丝线夹一行小字，像时间分隔标记，而不是第二张卡片。
 *
 * 收起状态存在 `ui.collapsedCallSegments`（纯视图状态，不进 localStorage）。这里
 * 只负责读它决定箭头朝向、点它切换；真正的「段内消息不渲染」在 MessageList 里做
 * （渲染层过滤，段内消息本身一个字节都不改，展开后仍是普通气泡）。
 */
function CallSegmentBar({ block }: { block: Extract<MessageBlock, { type: 'call-segment' }> }): JSX.Element {
  const { ui, actions } = usePersonal()
  // `?? []`：ui 从旧 localStorage 恢复时可能还没有这个字段（新加的视图状态），
  // 直接 .includes 会在首帧抛错、把整个消息列表带崩。
  const collapsed = (ui.collapsedCallSegments ?? []).includes(block.segment)
  const live = block.live === true
  const title = block.engine === 'realtime' ? '实时语音通话' : '语音通话'
  const toggle = (): void => actions.toggleCallSegment(block.segment)
  return (
    <div
      className="pa-callseg"
      data-open={collapsed ? 'false' : 'true'}
      data-live={live ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `展开${title}记录` : `收起${title}记录`}
      title={collapsed ? `展开${title}记录` : `收起${title}记录`}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggle()
        }
      }}
    >
      <span className="pa-callseg__rule" aria-hidden="true" />
      <span className="pa-callseg__label">
        <span className="pa-callseg__icon"><IconPhone size={12} /></span>
        <span className="pa-callseg__title">{title}</span>
        <span className="pa-callseg__meta">
          {live ? (
            <>
              <i className="pa-callseg__pulse" aria-hidden="true" />
              通话中
            </>
          ) : typeof block.durationMs === 'number' ? formatDuration(block.durationMs) : null}
        </span>
        <span className="pa-callseg__count">{block.turns > 0 ? `${block.turns} 条` : null}</span>
        <IconChevronDown size={12} className="pa-callseg__caret" />
      </span>
      <span className="pa-callseg__rule" aria-hidden="true" />
    </div>
  )
}

/* ───────────────────────── 语音条 ───────────────────────── */

/* ───────────────────────── 用户发来的图片 ───────────────────────── */

/**
 * 用户粘贴 / 选择的图片。
 *
 * 消息里只存同源 URL（图片本体在宿主 bot 工作区 uploads/ 下），所以这里直接
 * `<img>` 即可；点开在新标签看原图，不额外做灯箱。
 */
function ImageBlock({ block }: { block: Extract<MessageBlock, { type: 'image' }> }): JSX.Element {
  const image = block.image
  return (
    <a className="pa-image" href={image.url} target="_blank" rel="noreferrer" title={image.name ?? '查看原图'}>
      <img src={image.url} alt={image.name ?? '图片'} loading="lazy" />
    </a>
  )
}

/**
 * 聊天贴纸（表情包）。
 *
 * 与 ImageBlock 刻意不同：点不开、不下载、不加边框——贴纸是语气不是文件。
 * 用 `title` 给一个语义提示，纯装饰的贴纸对读屏用户没有任何信息，所以保留了 alt。
 * 宽高交给 CSS（132px 上限 + 60% 容器宽），图片本身不写死尺寸，避免加载前后的
 * 布局跳动把下面的消息顶一下。
 */
function StickerBlock({ sticker }: { sticker: ChatSticker }): JSX.Element {
  return (
    <img
      className="pa-sticker"
      src={sticker.url}
      alt={sticker.alt}
      title={sticker.alt}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  )
}

function VoiceBlock({ block }: { block: Extract<MessageBlock, { type: 'voice' }> }): JSX.Element {
  const [playing, setPlaying] = useState(false)
  const timerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])
  const toggle = (): void => {
    if (playing) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      setPlaying(false)
      return
    }
    setPlaying(true)
    timerRef.current = window.setTimeout(() => setPlaying(false), Math.max(1200, block.durationMs))
  }
  return (
    <div className="pa-voice" data-playing={playing ? 'true' : 'false'}>
      <div className="pa-voice__row">
        <button className="pa-voice__play" type="button" onClick={toggle} aria-label={playing ? '暂停语音' : '播放语音'}>
          {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
        </button>
        <span className="pa-voice__wave" aria-hidden="true">
          <IconWave size={14} className="pa-voice__glyph" />
          {Array.from({ length: 18 }, (_, index) => <i key={index} />)}
        </span>
        <span className="pa-voice__duration">{formatDuration(block.durationMs)}</span>
      </div>
      {block.transcript !== '' ? <div className="pa-voice__text">{block.transcript}</div> : null}
    </div>
  )
}

/* ───────────────────────── 入口 ───────────────────────── */

function mergeTextBlocks(blocks: MessageBlock[]): MessageBlock[] {
  const merged: MessageBlock[] = []
  for (const block of blocks) {
    const last = merged[merged.length - 1]
    if (block.type === 'text' && last !== undefined && last.type === 'text') {
      merged[merged.length - 1] = { type: 'text', text: `${last.text}\n\n${block.text}` }
    } else {
      merged.push(block)
    }
  }
  return merged
}

export const MessageBlockView = memo(function MessageBlockView({ message, pagesByBot }: MessageBlockViewProps): JSX.Element {
  /*
   * 旧页面索引（3.1）：这个 Bot 的 Pages 里，更新时间**晚于本条消息**的页面 →
   * 本条消息里的同名页面卡是旧版，卡片上标「已更新到下方」。
   *
   * 用消息时间作分界而不是「页面被更新过」：同一轮里最新那条消息的卡片本来就该是
   * 最新版本，不该也挂一个「已更新」——那会让用户以为刚生成的页面也过期了。
   */
  const stalePages = useMemo<StalePageMap>(() => {
    const map = new Map<string, { url: string; updatedAt: number }>()
    for (const page of pagesByBot?.[message.botId] ?? []) {
      if (page.updatedAt <= message.at) continue
      if (page.path === undefined || page.path === '') continue
      map.set(pathKeyOf(page.path), { url: page.url, updatedAt: page.updatedAt })
    }
    return map
  }, [pagesByBot, message.botId, message.at])

  /*
   * 工具调用块默认**不渲染**（用户要求：bot 消息里不要出现工具调用卡片）。
   *
   * 唯一例外是 `generate_image` 与 `generate_video`：用户要求 bot 生图 / 生视频时
   * 像 Seeker 主对话一样出现「呼吸点阵」占位，产出后媒体直接落在对话流里。这两类
   * 块分别交给 ImageGenerationBlock（复用 seeker 的 ImageGenerationCard）与
   * VideoGenerationBlock，外观不是工具卡，所以不违反「不出现工具卡」的约定。
   *
   * host 侧仍然把全部 tool 块放进 blocks——那是这一轮的执行记录，保留下来便于
   * 排查与将来做「执行详情」面板。`dedupeToolRuns` 先跑一遍：同一 callId 的多次
   * 快照（running → ok/error）收敛成一条，生图卡才不会并排出现两张。
   */
  const blocks = useMemo(() => {
    /*
     * 正文里已经有 Markdown 图片时，生图卡只在 running 阶段露脸（点阵占位），
     * ok / error 之后让位给正文图片 —— 否则模型生图后又自己贴一张 ![...]，
     * 同一张图会在对话流里并排出现两遍（用户明确报过「重复了很奇怪」）。
     * 判据与 Seeker 主对话同源：generated-images/layout.ts 的 textHasMarkdownImage。
     */
    const hasBodyImage = message.blocks.some(
      (block) => block.type === 'text' && textHasMarkdownImage(block.text),
    )
    /*
     * computer / browser 类工具先转成执行态块（2.7）。它们表达的不是「调用了一次
     * 工具」，而是「Bot 正在屏幕上替你做一件事」，所以走 execution 通道；转完之后
     * 下面那段工具过滤就与它们无关了（execution 不是 tool 块）。
     */
    const converted = mergeTextBlocks(dedupeToolRuns(message.blocks)).map((block) => (
      block.type === 'tool' && isExecutionToolName(block.run.name) ? toolRunToExecution(block.run) : block
    ))
    return converted.filter((block) => {
      if (block.type !== 'tool') return true
      // 生视频：工具块交给 VideoGenerationBlock（占位 / 播放器 / 任务卡）。
      // 已经结束又没有任何可展示内容的块直接丢掉，否则「pending 但无可见块」
      // 那条空态兜底会被一个渲染成 null 的块占住，三点 typing 永远不出现。
      if (block.run.name === 'generate_video') {
        const run = block.run
        return run.status === 'running'
          || run.status === 'error'
          || (run.videos?.length ?? 0) > 0
          || run.videoTask !== undefined
      }
      if (block.run.name === 'generate_image') return !hasBodyImage || block.run.status === 'running'
      /*
       * 其它工具：**全部保留**（1.4 可审计流水）。
       *
       * 原来这里只保留「产出了可预览文件」的块，其余工具调用完全不渲染 —— 过程
       * 干净了，可审计性也一起没了：用户想复盘「Bot 怎么得出这个结论」时什么都
       * 看不到。现在改成全部保留，渲染层再聚成一行「N 个动作 · 展开」，默认折叠、
       * 点开才是时间线（Grok 的 computer preview 也是点开才看）。
       */
      return true
    })
  }, [message.blocks])

  /*
   * 正文里已经写出来的产出物路径。
   *
   * 用途是去重（生图卡的老规矩，扩到媒体与产出物）：
   *  · 视频卡：模型生完视频常在正文补一句「视频在 _tmp/out.mp4」，若工具卡再播
   *    一遍，同一段视频会在对话流里出现两次；
   *  · 产出物卡：同一份文件既在正文里单独成段、又出现在工具 artifacts 里时，
   *    只留正文那张（位置更贴近模型的叙述）。
   */
  const bodyArtifactPaths = useMemo(() => {
    const paths: string[] = []
    for (const block of message.blocks) {
      if (block.type !== 'text') continue
      for (const path of extractArtifactPaths(block.text)) paths.push(path)
    }
    return paths
  }, [message.blocks])

  /** 正文里的视频路径（VideoGenerationBlock 只关心这一族）。 */
  const bodyVideoPaths = useMemo(
    () => bodyArtifactPaths.filter((path) => artifactKindOf(path) === 'video'),
    [bodyArtifactPaths],
  )

  /*
   * 渲染单元：把**连续**的工具块聚成一组流水，其它块各占一格（1.4）。
   *
   * 分组必须在渲染前做完：在 map 里判断「上一个块是不是工具」只能决定组头长什么样，
   * 组内第二块开始仍会被单独渲染成一行行，流水就散了。
   *
   * 位置必须在下面那个「什么都不剩」的提前 return **之前**：hooks 不能挂在条件
   * 分支上，否则同一条消息从「空」变成「有内容」时 React 会报 rendered fewer
   * hooks than expected（流式回复里这是必然发生的）。
   *
   * ── 2026-11-02 用户明确要求：Bot 消息里不要出现工具卡 ──
   * 普通工具调用一律不渲染，**包括**那行「N 个动作 · 展开」的折叠流水。可审计性
   * 不再放在消息里：computer / browser 类会先转成 execution 块（那是「正在做什么」
   * 的执行态，不是工具卡），其余工具的审计交给右栏与宿主日志。
   * 生图 / 生视频 / 文档占位属于**产物**，不是工具卡，仍然保留（见 isStandaloneToolRun）。
   */
  const units = useMemo(() => {
    const out: MessageBlock[] = []
    for (const block of blocks) {
      if (block.type === 'tool' && !isStandaloneToolRun(block.run)) continue
      /*
       * 贴纸展开：模型在正文里写 `[[sticker:<id>]]`，这里有两条路——
       *  · 只含正常标记 → 拆成「文字 / 贴纸」交替的独立块，贴纸不进气泡；
       *  · 标记里的 id 不认识 → splitStickerMarks 把它原样留在文字里，
       *    用户看到一行方括号，而不是一张破图或一段消失的话。
       * 展开必须放在渲染前（与上面的工具过滤同一个循环），否则一个 text 块里
       * 两张贴纸会被同一个 TextBubble 一次性吃掉。
       */
      if (block.type === 'text' && block.text.includes('[[sticker:')) {
        for (const segment of splitStickerMarks(block.text)) {
          if (segment.kind === 'text') {
            out.push({ type: 'text', text: segment.text })
            continue
          }
          const url = stickerUrl(segment.entry.id)
          if (url === null) continue
          out.push({
            type: 'sticker',
            sticker: { id: segment.entry.id, url, alt: segment.entry.alt, group: segment.entry.group },
          })
        }
        continue
      }
      out.push(block)
    }
    return out
  }, [blocks])

  /*
   * 过滤后什么都不剩的兜底。
   *
   * 流式期间 bot 可能先只调工具（pwsh / read …）还没输出正文：这时 message.blocks
   * 非空，MessageList 已经不画三点 typing 了（它只在 blocks 为空时画），而这些
   * 工具块又被上面过滤掉 —— 不补一个占位，这一段时间消息就是完全空白，用户会
   * 以为「没反应」。pending 结束后仍为空则什么都不渲染。
   */
  if (units.length === 0) {
    if (message.pending !== true) return <></>
    return (
      <div className="pa-bubble pa-bubble--bot pa-typing" aria-label="正在输入">
        <i /><i /><i />
      </div>
    )
  }

  return (
    <>
      {units.map((block, index) => {
        if (block.type === 'text') return <TextBubble key={`text-${index}`} text={block.text} role={message.role} stalePages={stalePages} />
        if (block.type === 'execution') return <ExecutionBlock key={`exec-${index}`} block={block} />
        if (block.type === 'tool') {
          if (block.run.name === 'generate_video') {
            return (
              <VideoGenerationBlock
                key={`genvid-${block.run.id}`}
                block={block}
                bodyPaths={bodyVideoPaths}
              />
            )
          }
          if (block.run.name === 'generate_image') {
            return <ImageGenerationBlock key={`genimg-${block.run.id}`} block={block} />
          }
          // 走到这里的工具只剩「正在生成文档」这一类独立卡片（其余都进了流水组）。
          // 生成中先给一个点阵占位，别让用户对着空白猜。
          return <DocumentPendingBlock key={`docpend-${block.run.id}`} run={block.run} />
        }
        if (block.type === 'task') return <TaskCard key={`task-${index}`} block={block} />
        if (block.type === 'interactive') return <InteractiveCard key={`int-${index}`} message={message} block={block} />
        // 连接器推荐：助手主动推荐「连接你的应用」，点一行跳连接器市场。
        // 它没有提交语义，所以不进 interactive 那条分支（那边会带「已提交」态）。
        if (block.type === 'connectors') return <ConnectorSuggestCard key={`con-${index}`} block={block} />
        // 历史记录里的旧通话卡：**保留**。新通话不再产生 call 块（改走 call-segment
        // 折叠条 + 普通消息），但老会话里存下来的那些仍然要能正常显示。
        if (block.type === 'call') return <CallMessageCard key={`call-${index}`} call={block.call} />
        if (block.type === 'call-segment') return <CallSegmentBar key={`callseg-${block.segment}`} block={block} />
        if (block.type === 'journal') return <JournalCard key={`journal-${index}`} block={block} />
        if (block.type === 'image') return <ImageBlock key={`img-${index}`} block={block} />
        if (block.type === 'sticker') return <StickerBlock key={`sticker-${index}`} sticker={block.sticker} />
        if (block.type === 'voice') return <VoiceBlock key={`voice-${index}`} block={block} />
        /*
         * 走到这里只剩 compaction 标记。它不是卡片：对话流里那行居中小字由
         * MessageList 的 CompactionMark 单独画。这里必须显式返回空，而不是拿
         * VoiceBlock 当兜底 —— 那个组件要 durationMs / transcript，compaction
         * 两个都没有，渲染时会直接崩（类型检查也会报 TS2322）。
         */
        return <></>
      })}
    </>
  )
})
