/**
 * Personal Agent — 消息流。
 *
 * 日期/时间分隔胶囊 + Bot 左侧消息（32px 头像、发送者名称、深灰圆角气泡或卡片）
 * + 用户右侧灰蓝气泡 + system 居中提示。每条消息入场 pa-rise，延迟按 index*20ms。
 *
 * 用户消息带「撤回」入口：hover / 键盘聚焦时在气泡左侧浮现一枚小胶囊，点开是
 * 自绘确认卡（与「清空对话」同一套 pa-overlay + pa-modal + pa-confirm，不用原生
 * confirm —— 原生对话框会带 dsh-shell 标题、样式完全脱离界面）。确认后走
 * actions.recallMessage：删这一轮的消息与记忆、插一条系统提示，并尽力通知宿主
 * 撤掉模型上下文。bot 消息不给撤回入口（撤回是「我说错话了」的语义）。
 */
import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { IconRefresh, IconSparkles, IconX } from '../icons.tsx'
import { formatClock, type Bot, type Message } from '../types.ts'
import { usePersonal } from '../store.tsx'
import { MessageBlockView } from './MessageBlockView.tsx'

export interface MessageListProps {
  messages: Message[]
  bot: Bot
  room: { id: string; name: string; memberIds: string[] } | null
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

export function MessageList({ messages, bot, room }: MessageListProps): JSX.Element {
  const { state, actions } = usePersonal()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  /** 待撤回的消息（非 null 时显示确认卡）。 */
  const [recallTarget, setRecallTarget] = useState<Message | null>(null)

  const botsById = useMemo(() => {
    const map = new Map<string, Bot>()
    for (const item of state.bots) map.set(item.id, item)
    return map
  }, [state.bots])

  useEffect(() => {
    stickRef.current = true
  }, [room?.id, bot.id])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null || !stickRef.current) return
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages])

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 160
  }

  const suggestions = room !== null
    ? ['先同步一下各自的进度', '把今天的任务分一下', '有什么需要我拍板的？']
    : ['今天的计划是什么？', '帮我整理一下最近的进展', '设一条每天 09:00 的例行任务']

  if (messages.length === 0) {
    return (
      <div className="pa-chat__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="pa-chat-empty">
          <div className="pa-chat-empty__avatar">
            <BotAvatar avatar={bot.avatar} size={64} online={bot.status === 'online'} />
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
        {messages.map((message, index) => {
          const previous = index > 0 ? messages[index - 1] : undefined
          const separator = shouldShowSeparator(previous, message)
          const style = { animationDelay: `${Math.min(index, 12) * 20}ms` }
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
          return (
            <div key={message.id}>
              {separator ? <div className="pa-chat__sep"><span>{separatorLabel(previous, message)}</span></div> : null}
              <div className={`pa-msg pa-msg--${message.role}`} style={style}>
                {message.role === 'bot' ? (
                  <div className="pa-msg__avatar">
                    <BotAvatar avatar={sender.avatar} size={32} />
                  </div>
                ) : null}
                <div className="pa-msg__content">
                  {message.role === 'bot' ? (
                    <div className="pa-msg__sender">
                      <span className="pa-msg__sender-name">{senderName}</span>
                      {tag !== null ? <span className="pa-msg__tag">{tag}</span> : null}
                    </div>
                  ) : null}
                  {/*
                   * 撤回入口：只在用户消息上出现（bot / system 消息没有「撤回」语义）。
                   * 绝对定位挂在气泡外侧，不占布局位置——否则每条用户消息都会因为
                   * 这枚按钮常年内缩一截。可见性交给 CSS（hover / focus-within）。
                   */}
                  {message.role === 'user' ? (
                    <button
                      className="pa-msg__recall"
                      type="button"
                      title="撤回这条消息"
                      aria-label="撤回这条消息"
                      onClick={() => setRecallTarget(message)}
                    >
                      <IconRefresh size={11} />
                      撤回
                    </button>
                  ) : null}
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
                    <MessageBlockView message={message} />
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/*
       * 撤回确认卡。与 ChatPanel 的「清空对话」同一套写法（pa-overlay + pa-modal +
       * pa-confirm），只是把状态放在消息流里——入口就在这条消息上。
       * 挂成 .pa-chat 的直接子节点（而不是消息滚动区里），否则 overlay 会跟着
       * 消息流一起滚动、还会被滚动容器的 overflow 裁掉。
       */}
      {recallTarget !== null ? (
        <div
          className="pa-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRecallTarget(null)
          }}
        >
          <div className="pa-modal pa-confirm" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pa-modal__head">
              <div className="pa-modal__title">撤回消息</div>
              <button className="pa-modal__close" type="button" onClick={() => setRecallTarget(null)} aria-label="关闭">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-modal__body">
              <p className="pa-confirm__lead">撤回这条消息？</p>
              <p className="pa-confirm__hint">
                这条消息和它之后、下一条消息之前的回复会一起删掉，这一轮记进它记忆里的内容也会清掉。此操作不可撤销。
              </p>
            </div>
            <div className="pa-modal__foot">
              <button className="pa-btn pa-btn--ghost" type="button" onClick={() => setRecallTarget(null)}>
                取消
              </button>
              <button
                className="pa-btn pa-btn--danger"
                type="button"
                onClick={() => {
                  const target = recallTarget
                  setRecallTarget(null)
                  actions.recallMessage(target.id)
                }}
              >
                撤回
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
