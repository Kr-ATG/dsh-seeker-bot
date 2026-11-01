/**
 * Personal Agent — 消息块渲染。
 *
 * text 走轻量 Markdown（**粗体**、`行内代码`、- / 1. 列表、> 引文、空行分段、
 * `![alt](src)` 图片），全程拆成 React 节点，不使用 dangerouslySetInnerHTML。
 * task / interactive / call / journal / voice 分别交给对应的卡片组件。
 *
 * 工具调用块默认不渲染，唯一例外是 `generate_image` 与 `generate_video`：前者复用
 * Seeker 主对话的 ImageGenerationCard（按比例呼吸点阵 → 出图羽化 → 画廊/lightbox），
 * 后者交给 VideoGenerationBlock（同款点阵占位 → 原生播放器）；两者都不是工具卡外观。
 *
 * 正文里「整段只有文件路径 / 下载链接」的段落渲染成产出物卡（ArtifactCard），
 * 视频 / 音频 / PDF / Office 都能在对话流里直接预览或下载。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePersonal } from '../store.tsx'
import {
  IconBook,
  IconCheck,
  IconChevronDown,
  IconCircleCheck,
  IconCpu,
  IconFile,
  IconFolder,
  IconImage,
  IconListTodo,
  IconPause,
  IconPlay,
  IconSearch,
  IconTerminal,
  IconWave,
  IconX,
} from '../icons.tsx'
import {
  formatDuration,
  type ArtifactRef,
  type Message,
  type MessageBlock,
  type MessageRole,
  type TaskStep,
  type ToolRun,
} from '../types.ts'
import { CallMessageCard } from '../call/CallMessageCard.tsx'
import { InteractiveCard } from './InteractiveCard.tsx'
import { ArtifactCard } from './ArtifactCard.tsx'
import { VideoGenerationBlock } from './VideoGenerationBlock.tsx'
import {
  artifactKindOf,
  errorMessageOf,
  extractArtifactPaths,
  parseArtifactParagraph,
  pathKeyOf,
} from './media.ts'
import { ImageGenerationCard } from '../../generated-images/ImageGenerationCard.tsx'
import { textHasMarkdownImage } from '../../generated-images/layout.ts'
// 只借类型：use-generated-images 会拉 @deepseek-ai/dsh-client-runtime 的运行时，
// personal 半身不依赖宿主模块表，必须用 import type 让 esbuild 整条剥掉。
import type { GeneratedImageCall } from '../../generated-images/use-generated-images.ts'

export interface MessageBlockViewProps {
  message: Message
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

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  /*
   * 图片优先于粗体 / 行内代码：`![a](b.png)` 里若先匹配星号或反引号，
   * 图片 token 会被切碎成普通文字（现状就是「只显示文字」）。src 允许空格
   * 与中文，所以用「除右括号外任意字符」收口。
   */
  const pattern = /(!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g
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

function Paragraph({ text, prefix }: { text: string; prefix: string }): JSX.Element {
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
          <ArtifactCard key={`${item.path}-${index}`} path={item.path} label={item.label} />
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

function MarkdownText({ text }: { text: string }): JSX.Element {
  const paragraphs = useMemo(() => text.split(/\n{2,}/).filter((part) => part.trim() !== ''), [text])
  return (
    <div className="pa-md">
      {paragraphs.map((part, index) => <Paragraph key={`p-${index}`} text={part} prefix={`p-${index}`} />)}
    </div>
  )
}

/* ───────────────────────── 文本气泡 ───────────────────────── */

function TextBubble({ text, role }: { text: string; role: MessageRole }): JSX.Element {
  const [open, setOpen] = useState(false)
  const lineCount = useMemo(() => text.split('\n').length, [text])
  const long = role === 'bot' && (lineCount > 8 || text.length > 680)
  const folded = long && !open
  return (
    <div className={`pa-bubble pa-bubble--${role}`}>
      <div className={folded ? 'pa-md pa-md--clamp' : undefined}>
        <MarkdownText text={text} />
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
}

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

/** 工具名 → 图标（沿用 icons.tsx 的线性图标，禁止 emoji）。 */
function ToolGlyph({ name }: { name: string }): JSX.Element {
  const key = name.toLowerCase()
  if (/todo|task|plan|checklist/.test(key)) return <IconListTodo size={14} />
  if (/search|web|browse|fetch|http|url/.test(key)) return <IconSearch size={14} />
  if (/image|screenshot|vision|photo/.test(key)) return <IconImage size={14} />
  if (/pwsh|bash|shell|exec|command|terminal|run_code|python|node/.test(key)) return <IconTerminal size={14} />
  if (/glob|ls\b|list|dir|folder/.test(key)) return <IconFolder size={14} />
  if (/read|write|edit|file|patch|apply/.test(key)) return <IconFile size={14} />
  return <IconCpu size={14} />
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

function ToolStatus({ run }: { run: ToolRun }): JSX.Element {
  if (run.status === 'running') {
    return (
      <span className="pa-tool__state" data-state="running" aria-label="执行中">
        <i className="pa-tool__spinner" aria-hidden="true" />
      </span>
    )
  }
  if (run.status === 'error') {
    return (
      <span className="pa-tool__state" data-state="error">
        <IconX size={12} />
        <span>失败</span>
        {typeof run.durationMs === 'number' ? <span className="pa-tool__dur">{formatToolDuration(run.durationMs)}</span> : null}
      </span>
    )
  }
  return (
    <span className="pa-tool__state" data-state="ok">
      {typeof run.durationMs === 'number'
        ? <span className="pa-tool__dur">{formatToolDuration(run.durationMs)}</span>
        : <IconCheck size={12} />}
    </span>
  )
}

function ToolCard({ block }: { block: Extract<MessageBlock, { type: 'tool' }> }): JSX.Element {
  const run = block.run
  const [open, setOpen] = useState(false)
  const args = run.args ?? ''
  const result = run.result ?? ''
  const expandable = args !== '' || result !== ''
  const summary = useMemo(() => summarizeToolArgs(args), [args])
  const toggle = (): void => {
    if (expandable) setOpen((value) => !value)
  }
  return (
    <div
      className="pa-tool"
      data-status={run.status}
      data-open={open ? 'true' : 'false'}
      data-expandable={expandable ? 'true' : 'false'}
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
      <div className="pa-tool__head">
        <span className="pa-tool__glyph"><ToolGlyph name={run.name} /></span>
        <span className="pa-tool__name">{run.name}</span>
        {summary !== '' ? <span className="pa-tool__args" title={summary}>{summary}</span> : null}
        <ToolStatus run={run} />
        {expandable ? <IconChevronDown size={12} className="pa-tool__caret" /> : null}
      </div>
      <div className="pa-tool__body">
        <div className="pa-tool__inner">
          {args !== '' ? (
            <div className="pa-tool__section">
              <div className="pa-tool__label">参数</div>
              <div className="pa-tool__code">{args}</div>
            </div>
          ) : null}
          {result !== '' ? (
            <div className="pa-tool__section">
              <div className="pa-tool__label">结果</div>
              <div className="pa-tool__code" data-tone={run.status === 'error' ? 'error' : undefined}>{result}</div>
            </div>
          ) : null}
          {run.status === 'running' && result === '' ? <div className="pa-tool__running">执行中…</div> : null}
        </div>
      </div>
    </div>
  )
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

/* ───────────────────────── 工具产出物（其它工具的 artifacts） ───────────────────────── */

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

/* ───────────────────────── 期刊卡 ───────────────────────── */

function JournalCard({ block }: { block: Extract<MessageBlock, { type: 'journal' }> }): JSX.Element {
  const { actions } = usePersonal()
  const open = (): void => actions.openJournal(block.journalId)
  return (
    <div
      className="pa-journal"
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
      <span className="pa-journal__cover">
        {block.image !== undefined && block.image !== '' ? <img src={block.image} alt="" /> : <IconBook size={24} />}
      </span>
      <span className="pa-journal__body">
        <span className="pa-journal__kicker">期刊日记</span>
        <span className="pa-journal__title">{block.title}</span>
        <span className="pa-journal__date">{block.date}</span>
        <span className="pa-journal__summary">{block.summary}</span>
      </span>
      <button
        className="pa-journal__open"
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          open()
        }}
      >
        打开
      </button>
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

export function MessageBlockView({ message }: MessageBlockViewProps): JSX.Element {
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
    return mergeTextBlocks(dedupeToolRuns(message.blocks)).filter((block) => {
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
      // 其它工具：只有「产出了可预览文件」才保留，而且只渲染产出物卡（不是工具卡）。
      return (block.run.artifacts?.length ?? 0) > 0
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
   * 过滤后什么都不剩的兜底。
   *
   * 流式期间 bot 可能先只调工具（pwsh / read …）还没输出正文：这时 message.blocks
   * 非空，MessageList 已经不画三点 typing 了（它只在 blocks 为空时画），而这些
   * 工具块又被这里过滤掉 —— 不补一个占位，这一段时间消息就是完全空白，用户会
   * 以为「没反应」。pending 结束后仍为空则什么都不渲染。
   */
  if (blocks.length === 0) {
    if (message.pending !== true) return <></>
    return (
      <div className="pa-bubble pa-bubble--bot pa-typing" aria-label="正在输入">
        <i /><i /><i />
      </div>
    )
  }

  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'text') return <TextBubble key={`text-${index}`} text={block.text} role={message.role} />
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
          // 其它工具：只出产出物卡（工具卡本身不渲染，见 ToolArtifactsBlock）。
          return <ToolArtifactsBlock key={`toolart-${block.run.id}`} run={block.run} bodyPaths={bodyArtifactPaths} />
        }
        if (block.type === 'task') return <TaskCard key={`task-${index}`} block={block} />
        if (block.type === 'interactive') return <InteractiveCard key={`int-${index}`} message={message} block={block} />
        if (block.type === 'call') return <CallMessageCard key={`call-${index}`} call={block.call} />
        if (block.type === 'journal') return <JournalCard key={`journal-${index}`} block={block} />
        if (block.type === 'image') return <ImageBlock key={`img-${index}`} block={block} />
        return <VoiceBlock key={`voice-${index}`} block={block} />
      })}
    </>
  )
}
