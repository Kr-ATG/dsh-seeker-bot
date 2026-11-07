/**
 * Personal Agent — 消息流。
 *
 * 日期/时间分隔胶囊 + Bot 左侧消息（32px 头像、发送者名称、深灰圆角气泡或卡片）
 * + 用户右侧灰蓝气泡 + system 居中提示。每条消息入场 pa-rise，延迟按 index*20ms。
 *
 * 用户消息带「撤回」入口：hover / 键盘聚焦时在气泡左侧浮现一枚小胶囊，点一下
 * 就在这条消息下方**原地**展开两枚按钮（确认撤回 / 取消），不弹窗、不遮罩、
 * 不带标题与说明——点撤回只是要一个「再确认一次」的落点，弹窗太重。确认后走
 * actions.recallMessage：删这一轮的消息与记忆、插一条系统提示，并尽力通知宿主
 * 撤掉模型上下文。bot 消息不给撤回入口（撤回是「我说错话了」的语义）。
 *
 * 语音通话按「段」折叠：通话里说的每句话、让它干活产出的图片，都以**普通消息**
 * 进入对话流（同一个气泡样式），只是带上 `callSegment` 标记归属。段首有一条
 * `call-segment` 折叠条，收起时这里整段跳过（只留折叠条），展开时什么都不用做——
 * 段内消息本来就是普通气泡，不额外包卡片。
 *
 * 朗读（见 speech.ts）：bot 消息的气泡侧边、引用按钮之后有一枚喇叭按钮，点一下
 * 就用「通话里设置的音色与供应商」把这条念出来；会话头打开「自动播报」后
 * 新回复也会自动念（只在单聊、且没有通话进行时，理由见自动播放那段注释）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { IconBell, IconBellOff, IconChevronDown, IconQuote, IconSparkles, IconStop, IconUndo, IconVolume, IconX } from '../icons.tsx'
import { formatClock, type Bot, type Message, type MessageBlock, type ProactiveMarkKind } from '../types.ts'
import { usePersonal } from '../store.tsx'
import { getSpeechState, speakText, speechTextOf, stopSpeech, useSpeechState } from '../speech.ts'
import { MessageBlockView } from './MessageBlockView.tsx'
import { installScrollDamping } from './scroll-damping.ts'
import {
  LOAD_OLDER_THRESHOLD,
  MESSAGE_INSERT_CHUNK,
  MESSAGE_PAGE_SIZE,
  resolveMessageWindow,
  shouldFillViewport,
  shouldLoadOlder,
} from './message-window.ts'
import { hasRenderableContent } from './message-visibility.ts'
import { pendingTasksOf } from './pending.ts'
import { dispatchLabel, isDispatchOpen, type DispatchView } from './dispatch.ts'

export interface MessageListProps {
  messages: Message[]
  bot: Bot
  room: { id: string; name: string; memberIds: string[] } | null
  /**
   * 投递回执（「已交给采集」那一行）。
   *
   * 不进 messages：它不是一条消息，没有正文、不参与轮次统计、也不进模型上下文。
   * 数据源与右栏委派面板同一条 GET /assignments（见 dispatch.ts）。
   */
  dispatches?: DispatchView[]
}

function dayStart(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayLabel(at: number): string {
  const now = new Date()
  const diff = Math.round((dayStart(now.getTime()) - dayStart(at)) / 86_400_000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  const date = new Date(at)
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

function shouldShowSeparator(previous: Message | undefined, current: Message): boolean {
  if (previous === undefined) return true
  if (dayStart(previous.at) !== dayStart(current.at)) return true
  return current.at - previous.at > 10 * 60_000
}

function separatorLabel(previous: Message | undefined, current: Message): string {
  if (previous === undefined || dayStart(previous.at) !== dayStart(current.at)) {
    return `${dayLabel(current.at)} ${formatClock(current.at)}`
  }
  return formatClock(current.at)
}

function systemText(message: Message): string {
  const text = message.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((part) => part !== '')
    .join(' ')
  return text === '' ? '系统消息' : text
}

function sourceLabel(message: Message): string | null {
  if (message.source === 'routine') return '例行任务'
  if (message.source === 'proactive') return '主动消息'
  if (message.source === 'call') return '来自通话'
  if (message.source === 'control') return '系统'
  return null
}

/**
 * 这条消息是不是「语音通话折叠条」本身。
 *
 * 折叠条是一条**分隔标记**，不是一条聊天记录：它只装 `call-segment` 块，没有正文。
 * 走普通气泡分支会多出一个头像、发送者名和一层背景，看起来就像「又换了一种 UI」
 * ——用户抱怨的正是这个。所以这里给它一条轻量行（只有那行小字），头像与气泡都不画。
 */
function isCallSegmentMarker(message: Message): boolean {
  return message.blocks.length > 0 && message.blocks.every((block) => block.type === 'call-segment')
}

/**
 * 跳到某条消息（待处理上浮条与引用条共用）。
 *
 * 消息容器在渲染时带 `id="pa-msg-<前端消息 id>"`。滚动 + 一次性高亮描边：
 * 高亮用 CSS 类而不是 state，它只是视觉提示，不值得为它重渲染整条消息流。
 */
export function jumpToMessage(id: string): void {
  const element = document.getElementById(`pa-msg-${id}`)
  if (element !== null) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element.classList.add('pa-flash')
    window.setTimeout(() => element.classList.remove('pa-flash'), 1600)
    return
  }
  /*
   * 目标在当前渲染窗口之外（消息流懒加载只渲染最近几页）：交给 MessageList
   * 的监听器先扩窗，等目标真正进 DOM 后再滚。直接 return 会让引用条 / 待处理条
   * 点旧消息时毫无反应。
   */
  window.dispatchEvent(new CustomEvent('pa:jump-to-message', { detail: { id } }))
}

/**
 * 一条消息的可引用摘要（引用条上那行字）。
 *
 * 只取「一眼能认出是哪条」的内容：正文、交互卡提问、图片占位。整条消息里可能
 * 只有工具流水，那就用「N 个动作」兜底 —— 引用条不能空着，否则用户不知道自己
 * 引用的是哪一条。
 */
function messagePreview(message: Message): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text.trim())
    else if (block.type === 'interactive' && block.prompt !== undefined && block.prompt.trim() !== '') parts.push(block.prompt.trim())
    else if (block.type === 'image') parts.push('[图片]')
    else if (block.type === 'journal') parts.push(block.title)
    else if (block.type === 'execution') parts.push(block.label)
    if (parts.join(' ').length > 60) break
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (text === '') {
    const tools = message.blocks.filter((block) => block.type === 'tool').length
    if (tools > 0) return `${tools} 个动作`
    return '（无文字内容）'
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

/* ───────────────────────── 朗读（自动朗读 / 气泡喇叭） ───────────────────────── */

/**
 * 自动朗读的 debounce（毫秒）。
 *
 * 流式回复会连续改 messages（每来一段正文就变一次引用），不加防抖就会把半句话
 * 念出去、然后被下一段打断。250ms 是「这一阵安静下来了」的量级：比一次事件循环
 * 长，又短到用户感觉不出延迟。
 */
const AUTO_SPEAK_DELAY_MS = 250

/**
 * 气泡上的「朗读」按钮（引用按钮之后）。
 *
 * 单独抽成组件而不是内联：它要订阅朗读状态（useSpeechState），内联的话每次播放
 * 开始 / 结束都会让**整条消息流**重渲染；抽出来之后只有这一枚按钮跟着变。
 * 文本清洗也放这里 useMemo —— 长会话里每条 bot 消息渲染时都洗一遍 Markdown 是纯浪费。
 */
function SpeakToolButton({ message, bot, onError }: {
  message: Message
  bot: Bot
  /**
   * 手动点播失败时的回调。
   *
   * 自动朗读失败要静默（那是背景行为，弹错只会打扰用户），但**用户自己点的**
   * 按钮失败了必须说一声——否则点了没反应，看起来像功能坏了。
   */
  onError?: (message: string) => void
}): JSX.Element | null {
  const speech = useSpeechState()
  const text = useMemo(() => speechTextOf(message), [message])
  // 没有可朗读的正文（纯工具卡 / 生图卡）就不给入口：按钮点了也没声音
  if (text === '') return null
  const active = speech.messageId === message.id && (speech.speaking || speech.loading)
  return (
    <button
      className="pa-msg__tool"
      type="button"
      data-speaking={active ? 'true' : 'false'}
      title={active ? '停止朗读' : '朗读这条消息'}
      aria-label={active ? '停止朗读' : '朗读这条消息'}
      onClick={() => {
        if (active) {
          stopSpeech()
          return
        }
        void speakText(text, {
          messageId: message.id,
          botId: message.senderId ?? message.botId,
          // 音色 / 供应商跟这条消息的发送者走：群聊里不同 Bot 有各自的嗓子
          ...(bot.voice !== undefined && bot.voice !== '' ? { voice: bot.voice } : {}),
          ...(bot.liveVendor !== undefined && bot.liveVendor !== '' ? { vendor: bot.liveVendor } : {}),
        }).then(() => {
          const error = getSpeechState().error
          if (error !== null) onError?.(error)
        })
      }}
    >
      {active ? <IconStop size={16} /> : <IconVolume size={18} strokeWidth={2} />}
    </button>
  )
}

/* ───────────────────────── 主动消息的提醒标记 ───────────────────────── */

/**
 * 「主动消息」标签后的提醒标记控件。
 *
 * 默认收起成一枚低对比小胶囊（小铃铛 +「标记」），不抢「主动消息」标签的注意力；
 * 已标记时直接显示当前状态（「继续提醒」/「不再提醒」），不点开也能看出结论。
 * 点开后的菜单用 absolute 定位挂在控件上，不参与「标签行」的布局。
 *
 * 关闭路径两条：点击控件外部（mousedown）与 Esc。菜单项点完即收起——这个动作
 * 轻、可逆，不需要二次确认。
 */
function ProactiveMarkButton({ message }: { message: Message }): JSX.Element {
  const { actions } = usePersonal()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const mark = message.proactiveMark
  const label = mark === 'keep' ? '继续提醒' : mark === 'mute' ? '不再提醒' : '标记'
  const title = mark === undefined ? '标记这条主动消息的提醒方式' : '修改提醒标记'

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node && rootRef.current.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const choose = (kind: ProactiveMarkKind | null): void => {
    setOpen(false)
    actions.setProactiveMark(message.id, kind)
  }

  return (
    <span className="pa-msg__mark" data-mark={mark ?? 'none'} data-open={open ? 'true' : 'false'} ref={rootRef}>
      <button
        className="pa-msg__mark-btn"
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {mark === 'mute' ? <IconBellOff size={11} /> : <IconBell size={11} />}
        <span>{label}</span>
        <IconChevronDown size={9} className="pa-msg__mark-caret" />
      </button>
      {open ? (
        <span className="pa-msg__mark-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            data-active={mark === 'keep' ? 'true' : undefined}
            onClick={() => choose('keep')}
          >
            <IconBell size={12} />
            继续提醒
          </button>
          <button
            type="button"
            role="menuitem"
            data-active={mark === 'mute' ? 'true' : undefined}
            onClick={() => choose('mute')}
          >
            <IconBellOff size={12} />
            不再提醒
          </button>
          {mark !== undefined ? (
            <button type="button" role="menuitem" className="pa-msg__mark-clear" onClick={() => choose(null)}>
              <IconX size={11} />
              清除标记
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

/* ───────────────────────── 压缩标记（1.1） ───────────────────────── */

/**
 * 「上下文已压缩」标记。
 *
 * **不是卡片**：一行居中小字（两侧发丝线），有摘要时点开看摘要。用户不知道历史
 * 什么时候被压缩，而 Bot 的连续性恰恰依赖压缩策略——这个标记就是让「它忘掉了
 * 什么」变得可见。没有 summary 时不可点（点了也没内容，不如不显示可点态）。
 */
function CompactionMark({ block }: { block: Extract<MessageBlock, { type: 'compaction' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = block.summary !== undefined && block.summary !== ''
  const label = block.folded !== undefined && block.folded > 0
    ? `上下文已压缩 · ${block.folded} 条消息折叠`
    : '上下文已压缩'
  return (
    <div
      className="pa-compaction"
      data-open={open ? 'true' : 'false'}
      data-expandable={expandable ? 'true' : 'false'}
    >
      <button
        className="pa-compaction__line"
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        title={expandable ? (open ? '收起压缩摘要' : '展开压缩摘要') : undefined}
        onClick={() => {
          if (expandable) setOpen((value) => !value)
        }}
      >
        <span className="pa-compaction__rule" aria-hidden="true" />
        <span className="pa-compaction__label">{label}</span>
        {expandable ? <IconChevronDown size={11} className="pa-compaction__caret" /> : null}
        <span className="pa-compaction__rule" aria-hidden="true" />
      </button>
      {expandable ? (
        <div className="pa-compaction__body">
          <div className="pa-compaction__inner">
            <div className="pa-compaction__summary">{block.summary}</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ───────────────────────── 投递回执 ───────────────────────── */

/**
 * 「已交给采集」这一行。
 *
 * 它回答的是派活之后用户最先冒出来的那个疑问：**活到底出没出去、现在到哪了**。
 * 之前这件事只有右栏委派面板知道，对话流里主 Bot 说一句「交给它了」就没了下文，
 * 用户只能盯着空气等。
 *
 * 刻意做成一行小字而不是气泡：它不是任何一方说的话，是系统状态。data-status
 * 让失败态能单独染成告警色。
 */
function DispatchRow({ view }: { view: DispatchView }): JSX.Element {
  const open = isDispatchOpen(view)
  return (
    <div
      className="pa-dispatch-row"
      data-state={open ? 'open' : 'done'}
      data-status={view.status}
      title={view.brief !== '' ? `任务：${view.brief}` : undefined}
    >
      <span className="pa-dispatch__dot" aria-hidden="true" />
      <span className="pa-dispatch__label">{dispatchLabel(view)}</span>
    </div>
  )
}

/* ───────────────────────── 轮次容器（2.8） ───────────────────────── */

/** 一个渲染组：同一轮的 bot 消息聚在一起；没有 turnId 的消息各自成组。 */
interface MessageGroup {
  key: string
  turnId?: string
  messages: Message[]
}

/**
 * 渲染单元。
 *
 * 轮次容器**不做包裹 div**：这一轮的头（发丝线 + 时间 + 状态）和尾（结算小字）
 * 各自是一条独立元素，中间就是普通消息。理由有两个：
 *  · 视觉上「发丝线 + 留白」本身就界定了边界，再套一层外框会变成大卡片；
 *  · 消息外层带着 `id="pa-msg-…"`（待办上浮 / 引用跳转靠它），包进容器后
 *    scrollIntoView 仍能用，但容器一旦折叠，跳转会落到一个不可见的元素上。
 */
type RenderItem =
  | { kind: 'message'; key: string; message: Message; hideSeparator?: boolean }
  | { kind: 'dispatch'; key: string; dispatch: DispatchView }
  | { kind: 'turn-head'; key: string; turnId: string; startLabel: string; running: boolean; collapsible: boolean }
  | { kind: 'turn-foot'; key: string; turnId: string; stats: { messages: number; outputs: number; pending: number } }
  | { kind: 'turn-collapsed'; key: string; turnId: string; count: number }

/**
 * 按 turnId 把可见消息分组。
 *
 * 只有 bot 消息参与轮次（用户消息是「提问」，不属于 Bot 这一轮的输出）。同一
 * turnId 的消息必须**连续**才合并：执行中用户插话（2.4 重定向）会打断容器，
 * 这是有意的——那一轮确实被用户的话切成了两段。
 *
 * 老数据没有 turnId：每条各自成组、按原样渲染，不报错。
 */
function groupMessages(messages: readonly Message[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const message of messages) {
    const turnId = message.role === 'bot' ? message.turnId : undefined
    const last = groups[groups.length - 1]
    if (turnId !== undefined && last !== undefined && last.turnId === turnId) {
      last.messages.push(message)
      continue
    }
    groups.push({
      key: turnId !== undefined ? `turn:${turnId}` : message.id,
      ...(turnId !== undefined ? { turnId } : {}),
      messages: [message],
    })
  }
  return groups
}

/**
 * 轮次结算：N 条消息 · M 个产出 · K 个待办。
 *
 * 产出按**文件路径去重**：一次交付在 tool 块的多次快照（running → ok）里会重复
 * 出现，直接累加会把 1 个文件算成 3 个。图片块与执行截图没有路径，按个数算。
 */
function turnStatsOf(messages: readonly Message[]): { messages: number; outputs: number; pending: number } {
  const artifacts = new Set<string>()
  let outputs = 0
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool') {
        for (const artifact of block.run.artifacts ?? []) artifacts.add(artifact.path)
      } else if (block.type === 'image') {
        outputs += 1
      } else if (block.type === 'execution' && block.media !== undefined && block.media !== '') {
        outputs += 1
      }
    }
  }
  return {
    messages: messages.length,
    outputs: outputs + artifacts.size,
    pending: pendingTasksOf(messages).length,
  }
}

export function MessageList({ messages, bot, room, dispatches = [] }: MessageListProps): JSX.Element {
  const { state, ui, actions } = usePersonal()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  /** 消息流是否有内容（空态与列表态是两棵树，切换时带动效重新安装）。 */
  const hasMessages = messages.length > 0
  /** 是否已经滚到底部附近（false 时浮出「回到最新」按钮）。 */
  const [atBottom, setAtBottom] = useState(true)
  /** atBottom 的同步镜像：滚动事件每帧都来，值没变就不要进 React setState。 */
  const atBottomRef = useRef(true)
  /** 待撤回的消息（非 null 时在这条消息下方原地显示两枚确认按钮）。 */
  const [recallTarget, setRecallTarget] = useState<Message | null>(null)

  /* Esc 收起原地确认：不弹窗也要留一条键盘退出路径。 */
  useEffect(() => {
    if (recallTarget === null) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setRecallTarget(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [recallTarget])
  /**
   * 已收起的轮次（turnId）。
   *
   * 纯视图状态、不持久化：刷新后默认展开更符合直觉（收起的轮次里往往有用户要回看
   * 的结论）。用 Set 而不是数组：逐条 includes 在长会话里是 O(n²)。
   */
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(() => new Set())

  /*
   * 已收起的通话段 → Set。
   *
   * 逐条消息去 `collapsedCallSegments.includes(...)` 是 O(n²)：消息上千条的会话里
   * 每条都要扫一遍数组。这里按 ui 引用建一次 Set，渲染时 O(1) 查，整趟过滤 O(n)。
   * `?? []` 兜住「store 还没初始化这个字段」的中间态（旧 localStorage / 首帧）。
   */
  const collapsedSegments = useMemo(
    () => new Set(ui.collapsedCallSegments ?? []),
    [ui.collapsedCallSegments],
  )

  const botsById = useMemo(() => {
    const map = new Map<string, Bot>()
    for (const item of state.bots) map.set(item.id, item)
    return map
  }, [state.bots])

  /* ───────────────────── 消息流懒加载窗口（2026-11-07） ───────────────────── */
  /** 始终指向最新的 messages，供事件回调（滚动 / 跳转）读取，不依赖闭包快照。 */
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  /**
   * 窗口锚点：渲染窗口第一条消息的 id；null = 跟随最新一页。
   *
   * 用 id 而不是下标：新消息追加时下标会整体后移，锚点 id 不变，用户正在
   * 翻看的旧消息不会被新消息挤走；某条消息被撤回后 id 消失时自动退回最新页。
   */
  const [renderStartId, setRenderStartId] = useState<string | null>(null)
  /** 窗口终点锚点；null = 一直显示到最新。跳转旧消息时用它把窗口限制成一页，避免全量渲染。 */
  const [renderEndId, setRenderEndId] = useState<string | null>(null)
  const windowRange = useMemo(
    () => resolveMessageWindow(
      messages.length,
      renderStartId,
      renderEndId,
      (id) => messages.findIndex((message) => message.id === id),
    ),
    [messages, renderStartId, renderEndId],
  )
  const windowMessages = useMemo(
    () => messages.slice(windowRange.start, windowRange.end),
    [messages, windowRange.start, windowRange.end],
  )
  const hasOlder = windowRange.start > 0
  /** 事件回调读最新窗口与加载状态（避免把整份消息数组塞进 event listener 依赖）。 */
  const windowStartRef = useRef(windowRange.start)
  windowStartRef.current = windowRange.start
  const hasOlderRef = useRef(hasOlder)
  hasOlderRef.current = hasOlder
  /** 是否正在扩窗（防止同一轮 scroll 事件重复加载）。 */
  const loadingOlderRef = useRef(false)
  /** 本轮扩窗的目标起点下标（分批插入，逐帧推进到这里）。 */
  const pendingLoadTargetRef = useRef<number | null>(null)
  /** 分批插入的下一批 rAF。 */
  const chunkRafRef = useRef(0)
  /**
   * 初始贴底完成之前不要触发上滑加载。
   *
   * 首帧渲染完、自动贴底还没跑的那一瞬间 scrollTop 是 0，scroll 事件会把
   * stickRef 判成 false；若此时就允许加载，会在用户还没看到界面时白扩一页。
   */
  const readyForLazyRef = useRef(false)
  /** 上一次 scrollTop，用来判断这次 scroll 是用户往上翻还是程序贴底。 */
  const lastScrollTopRef = useRef(0)
  /**
   * 下一次 messages 变化是否强制贴底。
   *
   * 开关会话 / 首次挂载时浏览器可能先抛一个 scrollTop=0~几 px 的 scroll 事件，
   * 把 stickRef 提前判成 false；没有这个标记，打开长会话会停在顶部而不是末尾。
   */
  const forceScrollRef = useRef(true)
  /**
   * 扩窗前的视口锚点：记录当前视口里第一条消息的 id 与屏幕坐标。
   *
   * 扩窗后在 DOM 里找回同一条消息，用它的位移补偿 scrollTop——比直接看
   * scrollHeight 差值可靠：图片 / 字体晚加载导致的高度变化也能锚住。
   */
  const pendingPreserveRef = useRef<{
    anchorId: string | null
    anchorTop: number
    top: number
    height: number
  } | null>(null)
  /** 要跳转的消息 id：目标不在窗口里时先扩窗，渲染完再滚。 */
  const pendingJumpRef = useRef<string | null>(null)
  /** 点「回到最新」后，等窗口切回最新一页再滚到底。 */
  const pendingBackToLatestRef = useRef(false)
  /** 阻尼句柄：扩窗改 scrollTop 前先让它让位。 */
  const dampingHandleRef = useRef<{ sync: () => void } | null>(null)

  useEffect(() => {
    stickRef.current = true
    forceScrollRef.current = true
    // 切会话时停掉正在念的那一条：用户已经在看别的对话，旧消息继续响很怪
    stopSpeech()
    // 切会话重置懒加载窗口：新会话从最新一页开始，不继承上一个会话滚到哪。
    setRenderStartId(null)
    setRenderEndId(null)
    pendingPreserveRef.current = null
    pendingJumpRef.current = null
    pendingBackToLatestRef.current = false
    loadingOlderRef.current = false
    pendingLoadTargetRef.current = null
    if (chunkRafRef.current !== 0) {
      window.cancelAnimationFrame(chunkRafRef.current)
      chunkRafRef.current = 0
    }
    readyForLazyRef.current = false
    lastScrollTopRef.current = 0
  }, [room?.id, bot.id])

  /*
   * 通话一开就停掉朗读：扬声器要留给通话，两边同时出声会互相盖住。
   * 只拦「通话开始」这一刻，通话中用户仍然可以手动点喇叭（那是显式操作）。
   */
  useEffect(() => {
    if (ui.call.status !== 'idle') stopSpeech()
  }, [ui.call.status])

  // 消息流卸载（切去期刊页等）时收声：已经离开对话了还继续念属于失控
  useEffect(() => {
    return () => {
      stopSpeech()
      if (chunkRafRef.current !== 0) window.cancelAnimationFrame(chunkRafRef.current)
    }
  }, [])

  /*
   * 滚动阻尼（2026-11-07）：轮滑的平滑惯性 + 到顶/到底的橡皮筋回弹。
   *
   * 生命周期跟着「空态 ↔ 列表态」切换走：两棵树的滚动容器不是同一个 DOM 节点，
   * 不在切换时重装就会把监听留在已经脱离文档的旧节点上（阻尼从此消失）。
   * installScrollDamping 自己会在 prefers-reduced-motion 下退化成原生滚动。
   */
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return undefined
    const handle = installScrollDamping(element)
    dampingHandleRef.current = handle
    return () => {
      if (dampingHandleRef.current === handle) dampingHandleRef.current = null
      handle.destroy()
    }
  }, [hasMessages])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return undefined
    let frame = 0
    const shouldStick = stickRef.current || forceScrollRef.current
    if (shouldStick) {
      forceScrollRef.current = false
      frame = window.requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight
        stickRef.current = true
        lastScrollTopRef.current = element.scrollTop
      })
    }
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [messages, room?.id, bot.id])

  /*
   * 自动朗读（会话头的「自动播报」开关；问答卡另有必播通道，见下）。
   *
   * 只在单聊里生效：群聊是多个 Bot 轮流说话，自动念会变成抢话；通话进行中也不念
   * ——那条链路本来就在播语音，再叠一层会撞在一起。
   *
   * 三条防呆：
   *  · 首次挂载 / 切换会话时把已有消息全部标记成「已播」，否则一刷新就把最后一条
   *    历史回复念一遍（这是最容易吓到用户的一种）；
   *  · debounce：流式回复会连续改 messages，等这一阵安静下来再播；
   *  · 每轮只播最后一条，且还没定稿的 pending 消息不播（念了就是半句话）。
   *
   * **问答 / 审批卡必播，不看自动播报开关**：这类消息就是这一轮的最终内容，宿主
   * 正挂在那里等用户决定。不播的话，没盯着屏幕的用户根本不知道 Bot 在等自己——
   * 「需要你定」却静悄悄，是这个功能最没意义的形态（2026-11-07 用户报）。
   */
  const autoSpeak = bot.autoSpeak === true
  const autoSpeakRef = useRef(autoSpeak)
  const spokenRef = useRef<{ key: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    const key = room === null ? `bot:${bot.id}` : `room:${room.id}`
    const spoken = spokenRef.current
    if (spoken === null || spoken.key !== key) {
      // 换了会话：把这一屏现有的消息全部记为已播，不补念历史
      spokenRef.current = { key, ids: new Set(messages.map((message) => message.id)) }
      autoSpeakRef.current = autoSpeak
      return
    }
    if (autoSpeakRef.current !== autoSpeak) {
      // 开关刚拨动：把当前消息记为已播，拨开关这个动作本身不触发朗读
      autoSpeakRef.current = autoSpeak
      for (const message of messages) spoken.ids.add(message.id)
      return
    }
    if (room !== null || ui.call.status !== 'idle') return
    const timer = window.setTimeout(() => {
      /*
       * 从尾部找「已经能读」的一条 bot 消息（messages 可能是上千条历史，复制整份
       * 数组再 reverse 是白费，所以倒序扫）。
       *
       * 空 blocks 的 pending 占位必须跳过：它只是一句「正在输入」，念出来是噪音，
       * 而且它常常排在刚落地的问答卡后面——不跳过的话，倒着找第一条 bot 就会撞上
       * 这个空占位，卡片永远轮不到朗读。
       */
      let last: Message | undefined
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const candidate = messages[index]
        if (candidate?.role !== 'bot') continue
        if (candidate.pending === true && candidate.blocks.length === 0) continue
        last = candidate
        break
      }
      if (last === undefined || spoken.ids.has(last.id)) return
      /** 等你决定的卡片：问答（need-input）与审批（approval）。 */
      const ask = last.kind === 'need-input' || last.kind === 'approval'
      if (!ask) {
        if (!autoSpeak) return
        // 半句话不念：pending 的消息还在生成，念了就是半句被下一段打断
        if (last.pending === true) return
      }
      const text = speechTextOf(last)
      if (text === '') return
      spoken.ids.add(last.id)
      void speakText(text, {
        messageId: last.id,
        botId: last.botId,
        ...(bot.voice !== undefined && bot.voice !== '' ? { voice: bot.voice } : {}),
        ...(bot.liveVendor !== undefined && bot.liveVendor !== '' ? { vendor: bot.liveVendor } : {}),
      })
    }, AUTO_SPEAK_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [messages, room?.id, autoSpeak, bot.id, bot.voice, bot.liveVendor, ui.call.status])

  /**
   * 插入一批旧消息（最多 MESSAGE_INSERT_CHUNK 条），并记录插入前的视口锚点。
   *
   * 只改 renderStartId，不动 messages 数据本身——历史数据一直在 state 里，
   * 这里懒的是**渲染量**，不是网络请求。
   */
  const insertOlderChunk = (nextStart: number): void => {
    const element = scrollRef.current
    const anchor = messagesRef.current[nextStart]
    if (element === null || anchor === undefined) {
      loadingOlderRef.current = false
      pendingLoadTargetRef.current = null
      return
    }
    /*
     * 找视口里第一条还看得见的消息当锚点。用 getBoundingClientRect 而不是
     * offsetTop：外层有 padding、transform 与滚动偏移，offset 系不可靠。
     */
    let anchorId: string | null = null
    let anchorTop = 0
    const viewportTop = element.getBoundingClientRect().top
    for (const node of element.querySelectorAll('[id^="pa-msg-"]')) {
      const rect = node.getBoundingClientRect()
      if (rect.bottom > viewportTop + 1) {
        anchorId = node.id.slice('pa-msg-'.length)
        anchorTop = rect.top
        break
      }
    }
    pendingPreserveRef.current = {
      anchorId,
      anchorTop,
      top: element.scrollTop,
      height: element.scrollHeight,
    }
    setRenderStartId(anchor.id)
  }

  /** 继续把本轮扩窗补到目标起点（每帧最多一批）。 */
  const continueOlderLoad = (): void => {
    const target = pendingLoadTargetRef.current
    if (target === null) {
      loadingOlderRef.current = false
      return
    }
    const current = windowStartRef.current
    if (current <= target) {
      pendingLoadTargetRef.current = null
      loadingOlderRef.current = false
      return
    }
    insertOlderChunk(Math.max(target, current - MESSAGE_INSERT_CHUNK))
  }

  /**
   * 向前扩一页。
   *
   * 不是一次 setState 塞 40 条，而是 10 条一批、每批让出一帧：复杂消息
   * （图片 / 卡片 / iframe）一次性渲染 40 条可能产生上百 ms 的长任务，手感
   * 就是「滚一下卡一下」。分批后单帧成本被摊平，视口锚定保证不跳。
   */
  const loadOlder = (): void => {
    if (loadingOlderRef.current) return
    const current = windowStartRef.current
    const target = Math.max(0, current - MESSAGE_PAGE_SIZE)
    if (target >= current) return
    loadingOlderRef.current = true
    pendingLoadTargetRef.current = target
    continueOlderLoad()
  }

  /*
   * 扩窗后的视口锚定。
   *
   * 在消息流顶部插入 40 条消息会把 scrollHeight 撑大一截；如果不补偿，用户
   * 眼前的正文会瞬间被顶下去，看起来像「点了一下跳了 40 条」。这里把差值补回
   * scrollTop：新内容长在视口上方，用户盯着的仍是原来那条。
   *
   * 同时处理两种「窗口不够用」：
   *   · 消息很短、40 条填不满一屏 → 继续补页，直到出现滚动条或历史取尽；
   *   · 跳转到窗口外的旧消息 → 等它渲染出来后 scrollIntoView + 高亮。
   */
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (pendingBackToLatestRef.current) {
      pendingBackToLatestRef.current = false
      loadingOlderRef.current = false
      pendingLoadTargetRef.current = null
      if (chunkRafRef.current !== 0) {
        window.cancelAnimationFrame(chunkRafRef.current)
        chunkRafRef.current = 0
      }
      // instant：取消可能还在跑的 scrollIntoView 平滑动画，直接落到真正的最新。
      element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
      lastScrollTopRef.current = element.scrollTop
      stickRef.current = true
      readyForLazyRef.current = true
      return
    }
    const pending = pendingPreserveRef.current
    if (pending !== null) {
      pendingPreserveRef.current = null
      let delta = element.scrollHeight - pending.height
      if (pending.anchorId !== null) {
        const anchor = document.getElementById(`pa-msg-${pending.anchorId}`)
        if (anchor !== null) delta = anchor.getBoundingClientRect().top - pending.anchorTop
      }
      if (delta !== 0) {
        dampingHandleRef.current?.sync()
        const previous = element.style.scrollBehavior
        element.style.scrollBehavior = 'auto'
        element.scrollTop = pending.top + delta
        element.style.scrollBehavior = previous
      }
    }
    /*
     * 分批插入未完：每批 DOM 提交后先让浏览器画一帧（rAF），再补下一批。
     * 不能在这里直接 setState 连发——React 会把多批合进同一次提交，长任务
     * 等于没拆。
     */
    if (loadingOlderRef.current && pendingLoadTargetRef.current !== null) {
      if (windowStartRef.current > pendingLoadTargetRef.current) {
        if (chunkRafRef.current === 0) {
          chunkRafRef.current = window.requestAnimationFrame(() => {
            chunkRafRef.current = 0
            continueOlderLoad()
          })
        }
        return
      }
      pendingLoadTargetRef.current = null
      loadingOlderRef.current = false
    }
    if (shouldFillViewport({
      hasOlder: hasOlderRef.current,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      loading: loadingOlderRef.current,
    })) {
      loadOlder()
      return
    }
    const jumpId = pendingJumpRef.current
    if (jumpId !== null) {
      const target = document.getElementById(`pa-msg-${jumpId}`)
      if (target !== null) {
        pendingJumpRef.current = null
        // 跨窗口跳转用 instant：目标刚渲染、布局还在变，平滑动画容易被后续
        // 布局调整打断，落点反而不可控。
        target.scrollIntoView({ behavior: 'instant', block: 'center' })
        target.classList.add('pa-flash')
        window.setTimeout(() => target.classList.remove('pa-flash'), 1600)
      }
    }
  }, [windowRange.start, windowRange.end, windowMessages.length])

  /** 跳转到窗口外的旧消息：先扩窗，等目标渲染出来再滚（jumpToMessage 的兜底）。 */
  useEffect(() => {
    const onJump = (event: Event): void => {
      const detail = (event as CustomEvent<{ id?: unknown }>).detail
      const id = detail?.id
      if (typeof id !== 'string' || id === '') return
      const source = messagesRef.current
      const index = source.findIndex((message) => message.id === id)
      if (index < 0) return
      if (index >= windowStartRef.current) {
        const target = document.getElementById(`pa-msg-${id}`)
        if (target !== null) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' })
          target.classList.add('pa-flash')
          window.setTimeout(() => target.classList.remove('pa-flash'), 1600)
          return
        }
      }
      /*
       * 窗口限制成一页：目标居中，终点也钉在 id 上。只把 start 往前挪会让
       * 「目标 → 最新」之间的全部消息都渲染出来，几千条时跳一下直接卡死。
       */
      const half = Math.floor(MESSAGE_PAGE_SIZE / 2)
      const startIndex = Math.max(0, index - half)
      const endIndex = Math.min(source.length - 1, startIndex + MESSAGE_PAGE_SIZE - 1)
      const startAnchor = source[startIndex]
      const endAnchor = source[endIndex]
      if (startAnchor === undefined || endAnchor === undefined) return
      pendingJumpRef.current = id
      pendingPreserveRef.current = null
      loadingOlderRef.current = false
      pendingLoadTargetRef.current = null
      if (chunkRafRef.current !== 0) {
        window.cancelAnimationFrame(chunkRafRef.current)
        chunkRafRef.current = 0
      }
      setRenderStartId(startAnchor.id)
      setRenderEndId(endAnchor.id)
    }
    window.addEventListener('pa:jump-to-message', onJump)
    return () => window.removeEventListener('pa:jump-to-message', onJump)
  }, [])

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    /*
     * 只有「用户往上翻」才允许懒加载：scrollTop 变小就是向上。
     *
     * 不能只看 scrollTop 是否接近顶部——首屏自动贴底、容器重建、浏览器恢复
     * 滚动位置都会产生 top≈0 的 scroll 事件；若把它当用户意图，会在用户还
     * 没来得及看界面时白扩一两页，懒加载就失效了。
     */
    if (element.scrollTop < lastScrollTopRef.current - 2) readyForLazyRef.current = true
    lastScrollTopRef.current = element.scrollTop
    /*
     * 「底部」必须同时满足：滚到了当前渲染窗口末尾、且窗口末尾就是最新一条。
     * 跳转到旧消息时窗口终点被钉住，滚到窗口底也不等于「回到最新」。
     */
    const atRealBottom = distance < 160 && windowRange.end >= messages.length
    stickRef.current = atRealBottom
    /*
     * 「回到最新」按钮的显隐：贴底 24px 以内且窗口真的到最新（隐藏），否则浮出来。
     * 用独立阈值而不是复用 stickRef 的 160px：吸附要在接近底部时就生效，
     * 按钮则要在真的翻远了才出现，两个判定不该共用一个数。
     */
    const nextAtBottom = distance < 24 && windowRange.end >= messages.length
    if (atBottomRef.current !== nextAtBottom) {
      atBottomRef.current = nextAtBottom
      setAtBottom(nextAtBottom)
    }
    if (readyForLazyRef.current && shouldLoadOlder({
      hasOlder: hasOlderRef.current,
      atBottom: stickRef.current,
      loading: loadingOlderRef.current,
      scrollTop: element.scrollTop,
      threshold: LOAD_OLDER_THRESHOLD,
    })) {
      loadOlder()
    }
  }

  /** 一键回到最新：恢复最新一页窗口并滚到底（否则下一条新消息不会跟着滚）。 */
  const scrollToBottom = (): void => {
    const element = scrollRef.current
    if (element === null) return
    stickRef.current = true
    readyForLazyRef.current = true
    loadingOlderRef.current = false
    pendingLoadTargetRef.current = null
    if (chunkRafRef.current !== 0) {
      window.cancelAnimationFrame(chunkRafRef.current)
      chunkRafRef.current = 0
    }
    /*
     * 如果当前是跳转旧消息留下的有界窗口，先切回「最新一页」：直接滚当前
     * scrollHeight 只会滚到那页历史的底部，不是真正的最新。
     */
    pendingBackToLatestRef.current = true
    setRenderStartId(null)
    setRenderEndId(null)
    // 窗口本来就是最新一页时上面两个 setState 不会触发重渲染，直接滚即可。
    if (windowRange.end >= messages.length) {
      pendingBackToLatestRef.current = false
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    }
  }

  const suggestions = room !== null
    ? ['先同步一下各自的进度', '把今天的任务分一下', '有什么需要我拍板的？']
    : ['今天的计划是什么？', '帮我整理一下最近的进展', '设一条每天 09:00 的例行任务']

  /*
   * 可见消息：先过滤，再分组。
   *
   * 过滤放在分组之前，是因为时间分隔与动画延迟都按「可见序列」算：拿原始 messages
   * 的下标去取 previous，遇到被跳过的消息（收起的通话段 / 空消息）就会算错分隔位置。
   *
   * 「有没有内容」统一交给 message-visibility.ts 的 hasRenderableContent：它和
   * MessageBlockView 的渲染规则同源——普通工具块（run_code / pwsh …）不渲染，所以
   * 纯工具进度消息（host 会给一次纯工具调用单开一条 kind=progress 消息）既不该进
   * 消息流，也不该被 turnStatsOf 算进「N 条消息」。旧判据把任何 tool 块都当可见，
   * 用户因此看到「2 条消息」却只有 1 条正文（真实报障）。
   *
   * pending 消息不走这个判据：它还没定稿，哪怕暂时只有被过滤掉的工具块，也要留在
   * 流里显示「正在输入」的三点占位（见 MessageBlockView 的空态兜底）。
   */
  const visible = useMemo(() => windowMessages.filter((message) => {
    if (message.callSegment !== undefined && collapsedSegments.has(message.callSegment)) return false
    if (message.role === 'bot' && message.pending !== true && !hasRenderableContent(message)) return false
    return true
  }), [windowMessages, collapsedSegments])

  const visibleIndex = useMemo(() => {
    const map = new Map<string, number>()
    visible.forEach((message, index) => map.set(message.id, index))
    return map
  }, [visible])

  const groups = useMemo(() => groupMessages(visible), [visible])

  const toggleTurn = (turnId: string): void => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(turnId)) next.delete(turnId)
      else next.add(turnId)
      return next
    })
  }

  const items = useMemo<RenderItem[]>(() => {
    const out: RenderItem[] = []
    for (const group of groups) {
      const turnId = group.turnId
      if (turnId === undefined) {
        const single = group.messages[0]
        if (single !== undefined) out.push({ kind: 'message', key: single.id, message: single })
        continue
      }
      const first = group.messages[0]
      /*
       * 单条消息的轮次（最常见的一问一答）不画轮次头尾。
       *
       * 头只是一行「时间 ── 完成」，尾只是一句「1 条消息」——对读者没有任何
       * 信息量，却把本来连续的对话切成一段段，每句回复下面都挂一条小字。
       * 只有**多消息**（模型一段话说几遍 / 带工具卡）、或有产出 / 待办的轮次
       * 才值得包一层，那时头尾才真的在说明「这一轮做了什么」。
       */
      const stats = turnStatsOf(group.messages)
      if (group.messages.length === 1 && stats.outputs === 0 && stats.pending === 0) {
        const only = group.messages[0]
        if (only !== undefined) out.push({ kind: 'message', key: only.id, message: only })
        continue
      }
      const firstIndex = first === undefined ? 0 : (visibleIndex.get(first.id) ?? 0)
      const previous = firstIndex > 0 ? visible[firstIndex - 1] : undefined
      const startAt = first?.at ?? Date.now()
      /*
       * 轮次头接管了第一条消息的时间分隔，所以分隔胶囊在组内第一条上不再重复画。
       * 跨天 / 首条时头里要带上日期，否则「19:00」脱离了上下文就不知道是哪天。
       */
      const startLabel = previous === undefined || dayStart(previous.at) !== dayStart(startAt)
        ? `${dayLabel(startAt)} ${formatClock(startAt)}`
        : formatClock(startAt)
      const running = group.messages.some((message) => message.pending === true)
      out.push({
        kind: 'turn-head',
        key: `head:${turnId}`,
        turnId,
        startLabel,
        running,
        collapsible: group.messages.length > 1,
      })
      if (collapsedTurns.has(turnId)) {
        out.push({ kind: 'turn-collapsed', key: `collapsed:${turnId}`, turnId, count: group.messages.length })
        continue
      }
      group.messages.forEach((message, index) => {
        out.push({ kind: 'message', key: message.id, message, ...(index === 0 ? { hideSeparator: true } : {}) })
      })
      out.push({ kind: 'turn-foot', key: `foot:${turnId}`, turnId, stats })
    }
    /*
     * 投递回执按时间插进对话流：派活发生在主管那一轮中间，回执就该出现在它被
     * 派出去的那一刻，而不是永远追加在末尾（主 Bot 后面再回几句，回执会被顶到
     * 最后，看起来像「刚刚才派」）。dispatches 已按 at 升序（见 dispatch.ts）。
     */
    for (const view of dispatches) {
      const index = out.findIndex((item) => item.kind === 'message' && item.message.at > view.at)
      out.splice(index < 0 ? out.length : index, 0, { kind: 'dispatch', key: `dispatch:${view.id}`, dispatch: view })
    }
    return out
  }, [groups, collapsedTurns, visible, visibleIndex, dispatches])

  if (messages.length === 0) {
    return (
      <div className="pa-chat__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="pa-chat-empty">
          <div className="pa-chat-empty__avatar">
            <BotAvatar avatar={bot.avatar} size={64} motionState={bot.isMain ? 'idle' : undefined} />
          </div>
          <div className="pa-chat-empty__title">{room !== null ? room.name : bot.name}</div>
          <div className="pa-chat-empty__desc">
            {room !== null
              ? `这是 ${room.name}，群里有 ${room.memberIds.length} 个 Bot。直接说你的想法，成员会各自接话。`
              : `我是 ${bot.name}，${bot.role}。${bot.description !== '' ? bot.description : '可以直接告诉我你想先处理哪件事。'}`}
          </div>
          <div className="pa-chat-empty__chips">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                className="pa-chat-empty__chip"
                type="button"
                onClick={() => actions.sendMessage(suggestion, room !== null ? { roomId: room.id } : { botId: bot.id })}
              >
                <IconSparkles size={13} />
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="pa-chat__scroll" ref={scrollRef} onScroll={onScroll}>
        {/*
         * 越界位移的两层结构：clip 层把 transform 产生的「滚动溢出」挡在滚动容器
         * 之外（否则 Chromium 认为 scrollHeight 变小，底部越界会被当场夹回去，
         * 橡皮筋完全失效）；inner 层才是真正被 translate 的内容层。
         */}
        <div className="pa-chat__scroll-clip">
          <div className="pa-chat__scroll-inner">
            {/*
             * 顶部提示：还有更早的消息没有渲染。它同时是「上滑加载」的可见提示，
             * 滚到接近顶部时会自动扩窗，用户不需要点按钮。
             */}
            {hasOlder ? (
              <div className="pa-chat__load-older" role="status">
                上滑加载更早消息
              </div>
            ) : null}
            {items.map((item) => {
              /*
               * 轮次头 / 尾 / 收起提示：都不包消息，各自是一条独立元素（理由见
               * RenderItem 的注释）。头尾各一条发丝线，中间就是普通消息。
               */
              if (item.kind === 'dispatch') {
                return <DispatchRow key={item.key} view={item.dispatch} />
              }
              if (item.kind === 'turn-head') {
                return (
                  <div className="pa-turn__head" key={item.key} data-state={item.running ? 'running' : 'done'}>
                    <span className="pa-turn__time">{item.startLabel}</span>
                    <span className="pa-turn__rule" aria-hidden="true" />
                    <span className="pa-turn__state">{item.running ? '进行中' : '完成'}</span>
                    {item.collapsible ? (
                      <button
                        className="pa-turn__toggle"
                        type="button"
                        aria-expanded="true"
                        title="收起这一轮"
                        onClick={() => toggleTurn(item.turnId)}
                      >
                        收起
                        <IconChevronDown size={11} />
                      </button>
                    ) : null}
                  </div>
                )
              }
              if (item.kind === 'turn-foot') {
                return (
                  <div className="pa-turn__foot" key={item.key}>
                    <span>{item.stats.messages} 条消息</span>
                    {item.stats.outputs > 0 ? <span>{item.stats.outputs} 个产出</span> : null}
                    {item.stats.pending > 0 ? <span>{item.stats.pending} 个待办</span> : null}
                  </div>
                )
              }
              if (item.kind === 'turn-collapsed') {
                return (
                  <button
                    className="pa-turn__collapsed"
                    key={item.key}
                    type="button"
                    title="展开这一轮"
                    onClick={() => toggleTurn(item.turnId)}
                  >
                    这一轮有 {item.count} 条消息，已收起
                    <IconChevronDown size={11} />
                  </button>
                )
              }
              const message = item.message
              const index = visibleIndex.get(message.id) ?? 0
              const previous = index > 0 ? visible[index - 1] : undefined
              const separator = item.hideSeparator !== true && shouldShowSeparator(previous, message)
              const style = { animationDelay: `${Math.min(index, 12) * 20}ms` }
              /*
               * 通话折叠条：轻量分隔行，不带头像 / 气泡 / 撤回入口。
               * 它与段内消息共享同一个「消息」容器，所以时间分隔胶囊照常出现在它上方。
               */
              if (isCallSegmentMarker(message)) {
                return (
                  <div key={message.id}>
                    {separator ? <div className="pa-chat__sep"><span>{separatorLabel(previous, message)}</span></div> : null}
                    <div className="pa-callseg-row" style={style}>
                      <MessageBlockView message={message} pagesByBot={state.pagesByBot} />
                    </div>
                  </div>
                )
              }
              /*
               * 压缩标记（1.1）：不画时间分隔胶囊——它自己就是「某一个时刻」的标记，
               * 再套一层时间分隔会变成两条并排的小字。
               */
              const compaction = message.blocks.find(
                (block): block is Extract<MessageBlock, { type: 'compaction' }> => block.type === 'compaction',
              )
              if (compaction !== undefined) {
                return (
                  <div key={message.id} className="pa-compaction-row" style={style}>
                    <CompactionMark block={compaction} />
                  </div>
                )
              }
              if (message.role === 'system') {
                return (
                  <div key={message.id}>
                    {separator ? <div className="pa-chat__sep"><span>{separatorLabel(previous, message)}</span></div> : null}
                    <div className="pa-msg pa-msg--system" style={style}>
                      <div className="pa-msg__system-text">{systemText(message)}</div>
                    </div>
                  </div>
                )
              }
              const sender = message.role === 'bot'
                ? (botsById.get(message.senderId ?? message.botId) ?? bot)
                : bot
              const senderName = message.senderName ?? sender.name
              const tag = sourceLabel(message)
              /** 引用条数据（2.3）；没引用时 undefined。 */
              const replyTo = message.replyTo
              /*
               * 多消息类别：need-input / approval 是「等用户动作」的卡片，finding 是
               * 需要留意的提示。只在 bot 消息上生效——用户消息永远没有 kind。
               */
              const kindClass = message.role === 'bot' && message.kind !== undefined
                ? ` pa-msg--${message.kind}`
                : ''
              const kindLabel = message.role === 'bot' && message.kind === 'need-input'
                ? '需要你定'
                : message.role === 'bot' && message.kind === 'approval'
                  ? '待确认'
                  : message.role === 'bot' && message.kind === 'finding'
                    ? '发现'
                    : null
              /*
               * 纯文本消息（只有一段正文，或者还没吐字的 typing 气泡）：气泡容器收成
               * 气泡宽度，侧边操作图标才能贴住气泡右沿。卡片类消息（交互卡 / 生图卡 /
               * 任务卡）保持整列宽度，它们自己要按 100% 算宽度。
               */
              const tight = message.blocks.length === 0
                || (message.blocks.length === 1 && message.blocks[0]?.type === 'text')
              return (
                <div key={message.id} id={`pa-msg-${message.id}`}>
                  {separator ? <div className="pa-chat__sep"><span>{separatorLabel(previous, message)}</span></div> : null}
                  <div className={`pa-msg pa-msg--${message.role}${kindClass}`} style={style}>
                    {/*
                     * 头像只留给群聊。单聊里整条流都是同一个 bot，每句都挂一次头像
                     * 只会把气泡往右推一截；群聊里它仍然是「谁在说话」的第一眼线索。
                     */}
                    {message.role === 'bot' && room !== null ? (
                      <div className="pa-msg__avatar">
                        <BotAvatar avatar={sender.avatar} size={32} />
                      </div>
                    ) : null}
                    <div className="pa-msg__content">
                      {/*
                       * 气泡上方只留「来源 / 类别」标签（来自通话、需要你定…）。
                       * 发送者名字同样只在群聊里出现：单聊里它每句重复一遍，是纯噪音。
                       * 一个标签都没有时整行不渲染，消息就是干净的一条气泡。
                       */}
                      {message.role === 'bot' && (room !== null || kindLabel !== null || tag !== null) ? (
                        <div className="pa-msg__sender">
                          {room !== null ? <span className="pa-msg__sender-name">{senderName}</span> : null}
                          {kindLabel !== null ? <span className={`pa-msg__kind pa-msg__kind--${message.kind}`}>{kindLabel}</span> : null}
                          {tag !== null && kindLabel === null ? <span className="pa-msg__tag">{tag}</span> : null}
                          {message.role === 'bot' && message.source === 'proactive' ? <ProactiveMarkButton message={message} /> : null}
                        </div>
                      ) : null}
                      {/*
                       * 引用条（2.3）：一条浅色细条，左侧一道竖线。点它跳回被引用的消息——
                       * 多条消息的流里，光看摘要没法确认「引用的是哪一条」。
                       */}
                      {replyTo !== undefined ? (
                        <button
                          className="pa-quote"
                          type="button"
                          title="跳到被引用的消息"
                          onClick={() => jumpToMessage(replyTo.id)}
                        >
                          <span className="pa-quote__rule" aria-hidden="true" />
                          <span className="pa-quote__label">引用</span>
                          <span className="pa-quote__text">{replyTo.preview}</span>
                        </button>
                      ) : null}
                      {/*
                       * 气泡 + 侧边操作图标包进同一个定位容器：图标要相对**气泡**垂直居中。
                       * 直接挂内容列的话，有「来自通话」标签或引用条时内容列被顶高一截，
                       * 图标会浮到气泡中心上方（用户反馈「有的居中有的没居中」）。
                       */}
                      <div className={`pa-msg__body${tight ? ' pa-msg__body--tight' : ''}`}>
                        {/*
                         * pending 只说明「这一轮还没结束」，不代表「还没有内容」：
                         * 流式回复里 text / tool 事件一到，pending 消息的 blocks 就已经有
                         * 东西了（正文逐段出现、生图点阵卡实时出现），这时要渲染真实内容，
                         * 不能再盖一层三点 typing。只有 blocks 还空着才显示「正在输入」。
                         */}
                        {message.pending === true && message.blocks.length === 0 ? (
                          <div className="pa-bubble pa-bubble--bot pa-typing" aria-label="正在输入">
                            <i /><i /><i />
                          </div>
                        ) : (
                          <MessageBlockView message={message} pagesByBot={state.pagesByBot} />
                        )}
                        {/*
                         * 气泡侧边的操作图标：hover / 键盘聚焦才浮现，纯图标不带文字。
                         * bot 消息挂在气泡右侧（气泡左对齐，右边是空白），用户消息挂在左侧。
                         * 引用两边都有（把自己刚说的话带进上下文同样成立）；朗读只对 bot 消息；
                         * 撤回只对自己的消息。
                         * 绝对定位不占布局：常驻占位会把气泡和消息间距一起撑开。
                         */}
                        <div className="pa-msg__tools">
                          <button
                            className="pa-msg__tool"
                            type="button"
                            title="引用"
                            aria-label="引用这条消息"
                            onClick={() => actions.setReplyTo({ id: message.id, preview: messagePreview(message) })}
                          >
                            <IconQuote size={18} strokeWidth={2} />
                          </button>
                          {/*
                           * 朗读按钮紧跟在引用之后（用户要求「引用后面加扬声器标识」）。
                           * 只有 bot 消息有：自己的话不需要听一遍，念自己的消息还会让人
                           * 以为是在放语音输入。文本为空的消息由组件自己返回 null。
                           */}
                          {message.role === 'bot' ? <SpeakToolButton message={message} bot={sender} onError={actions.toast} /> : null}
                          {message.role === 'user' ? (
                            <button
                              className="pa-msg__tool"
                              type="button"
                              title="撤回"
                              aria-label="撤回这条消息"
                              onClick={() => setRecallTarget((prev) => (prev?.id === message.id ? null : message))}
                            >
                              <IconUndo size={18} strokeWidth={2} />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {/*
                       * 撤回原地确认：不弹窗、不遮罩，就贴在这条消息下面给两枚按钮。
                       * 用户要的就是「点一下确认 / 取消」，标题、说明、关闭 X 一律不要。
                       */}
                      {message.role === 'user' && recallTarget?.id === message.id ? (
                        <div className="pa-recall-inline" role="group" aria-label="确认撤回这条消息">
                          <button
                            className="pa-btn pa-btn--ghost pa-btn--sm"
                            type="button"
                            onClick={() => setRecallTarget(null)}
                          >
                            取消
                          </button>
                          <button
                            className="pa-btn pa-btn--danger pa-btn--sm"
                            type="button"
                            onClick={() => {
                              setRecallTarget(null)
                              actions.recallMessage(message.id)
                            }}
                          >
                            确认撤回
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/*
       * 一键回到最新：悬浮在**输入框上方右侧**（不是消息流右上角）。
       *
       * 外面这层是 0 高度的定位桩，放在滚动容器和输入框之间；按钮 absolute 挂在它
       * 上面往上浮，不占任何布局高度——输入框高度会随引用条 / 待处理条 / 语音条
       * 变化，写死 bottom 迟早错位。
       * 不做常驻：它恰恰是在「我翻远了、想回去」时才需要，常驻只会一直压在消息上。
       */}
      <div className="pa-chat__to-bottom-wrap">
        <button
          className="pa-chat__to-bottom"
          type="button"
          title="回到最新"
          aria-label="回到最新"
          data-on={atBottom ? 'false' : 'true'}
          onClick={scrollToBottom}
        >
          <IconChevronDown size={18} />
        </button>
      </div>

    </>
  )
}
