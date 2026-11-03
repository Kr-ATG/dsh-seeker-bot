/**
 * Personal Agent — 聊天主面板。
 *
 * 会话头（44px 头像 / 名称 / 角色或群成员数 / 呼叫 / 更多）+ 消息流 + 输入框。
 * 群聊时头部显示成员头像叠加，消息流按 senderName 显示发送者。
 *
 * 消息流与输入框之间还挂着一条**待处理上浮条**（2.6）：need-input / approval 是
 * 「等用户动作」的消息，但它们会随对话流滚出视口，用户切回来时常常忘了还有一张卡
 * 在等自己。这条把最新的一条钉在输入框上方，点击跳回原消息。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { IconBook, IconChevronRight, IconClock, IconMessage, IconMore, IconPhone, IconSettings, IconTrash, IconUsers, IconX } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import type { Bot, Message } from '../types.ts'
import { Composer } from './Composer.tsx'
import { MessageList, jumpToMessage } from './MessageList.tsx'
import { pendingSummaryOf, pendingTasksOf } from './pending.ts'

const MIN_CHAT_WIDTH = 520
const MAX_CHAT_WIDTH = 1600

export function ChatPanel(): JSX.Element {
  const { state, ui, actions, activeBot, activeRoom, activeMessages } = usePersonal()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  /** 待清空对话的目标 bot（非 null 时显示确认卡片）。 */
  const [clearTarget, setClearTarget] = useState<Bot | null>(null)

  /**
   * 拖拽对话列左右边缘调整宽度。
   *
   * 只改中间 `.pa-chat` 的宽度（`--pa-chat-w`），左右侧栏保持原样——用户明确
   * 要求「不要被侧边栏影响」。拖动过程中直接改 CSS 变量、不 setState，松手才
   * 写回 `pa:ui:v1`，避免每帧重渲染整个对话流。
   */
  const startResize = (side: 'left' | 'right', event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const chat = event.currentTarget.closest('.pa-chat')
    const main = chat?.parentElement
    if (!(chat instanceof HTMLElement) || !(main instanceof HTMLElement)) return
    const startX = event.clientX
    const startWidth = chat.getBoundingClientRect().width
    const mainWidth = main.getBoundingClientRect().width
    const upper = Math.min(MAX_CHAT_WIDTH, mainWidth)
    const lower = Math.min(MIN_CHAT_WIDTH, upper)
    let latest = Math.round(startWidth)
    const onMove = (moveEvent: MouseEvent): void => {
      // 两侧对称收放：边缘跟手需要 2 倍位移（居中列两边同时移动）。
      const delta = side === 'left' ? startX - moveEvent.clientX : moveEvent.clientX - startX
      latest = Math.round(Math.min(upper, Math.max(lower, startWidth + delta * 2)))
      main.style.setProperty('--pa-chat-w', `${latest}px`)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.removeAttribute('data-pa-resizing')
      actions.setChatWidth(latest >= upper - 1 ? 0 : latest)
    }
    document.body.setAttribute('data-pa-resizing', 'true')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 双击恢复自动铺满（0 = 不限制宽度）。 */
  const resetChatWidth = (): void => {
    actions.setChatWidth(0)
  }

  const roomBots: Bot[] = activeRoom === null
    ? []
    : activeRoom.memberIds
      .map((id) => state.bots.find((bot) => bot.id === id))
      .filter((bot): bot is Bot => bot !== undefined)

  const title = activeRoom !== null ? activeRoom.name : activeBot.name
  const subtitle = activeRoom !== null ? `${roomBots.length} 个 Bot · 群聊` : activeBot.role
  const callBotId = activeRoom !== null ? (roomBots.find((bot) => bot.isMain) ?? roomBots[0] ?? activeBot).id : activeBot.id
  const callBot = state.bots.find((bot) => bot.id === callBotId) ?? activeBot

  useEffect(() => {
    if (!moreOpen) return undefined
    const close = (event: MouseEvent): void => {
      if (moreRef.current !== null && event.target instanceof Node && moreRef.current.contains(event.target)) return
      setMoreOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [moreOpen])

  const handleCall = (): void => {
    if (ui.call.status !== 'idle') {
      actions.minimizeCall(false)
      return
    }
    actions.startCall(callBotId)
  }

  const runMenuAction = (action: () => void): void => {
    setMoreOpen(false)
    action()
  }

  return (
    <>
      {/*
       * 会话头刻意放在对话列（.pa-chat）**外面**：它的下边框要横跨整个主列。
       * 放在 .pa-chat 里时，对话列一旦被拖窄（--pa-chat-w < 100%），边框就跟着缩，
       * 两端与左右侧栏之间露出一截缺口——用户实测点名要它「永远占满」。
       * 头部内容再套一层 .pa-chat__head-inner 按对话列宽度居中，对齐方式保持不变。
       */}
      <header className="pa-chat__header">
        <div className="pa-chat__head-inner">
        <div className="pa-chat__head-avatar">
          {activeRoom !== null ? (
            <div className="pa-chat__stack">
              {roomBots.slice(0, 3).map((bot) => (
                <BotAvatar key={bot.id} avatar={bot.avatar} size={20} />
              ))}
            </div>
          ) : (
            <BotAvatar avatar={activeBot.avatar} size={28} online={activeBot.status === 'online'} />
          )}
        </div>
        <div className="pa-chat__head-text">
          <div className="pa-chat__head-name">{title}</div>
          <div className="pa-chat__head-sub">{subtitle}</div>
        </div>
        <div className="pa-chat__head-actions">
          <button
            className="pa-chat__head-btn"
            type="button"
            data-on={ui.call.status !== 'idle' ? 'true' : 'false'}
            title={ui.call.status !== 'idle' ? '返回通话' : `呼叫 ${callBot.name}`}
            aria-label={ui.call.status !== 'idle' ? '返回通话' : `呼叫 ${callBot.name}`}
            onClick={handleCall}
          >
            <IconPhone size={18} />
          </button>
          <div className="pa-chat__more" ref={moreRef}>
            <button
              className="pa-chat__head-btn"
              type="button"
              title="更多"
              aria-label="更多"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <IconMore size={18} />
            </button>
            {moreOpen ? (
              <div className="pa-chat__menu" role="menu">
                {activeRoom !== null ? (
                  <button type="button" role="menuitem" onClick={() => runMenuAction(() => actions.openGroupSettings(activeRoom.id))}>
                    <IconUsers size={14} />
                    群聊设置
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runMenuAction(() => actions.openBotSettings(callBot.id))}
                >
                  <IconSettings size={14} />
                  Bot 设置
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runMenuAction(() => {
                    /*
                     * 任务记录是右栏的一张卡，不另开弹层：先把右栏打开，
                     * 再 toast 告诉用户去哪看——右栏关着时点「任务记录」
                     * 如果不打开右栏，会看起来什么都没发生。
                     */
                    actions.toggleRightPanel(true)
                    actions.toast('任务记录在右侧栏')
                  })}
                >
                  <IconClock size={14} />
                  任务记录
                </button>
                <button type="button" role="menuitem" onClick={() => runMenuAction(() => actions.proactiveNow(callBotId))}>
                  <IconMessage size={14} />
                  让 {callBot.name} 主动说一句
                </button>
                <button type="button" role="menuitem" onClick={() => runMenuAction(() => { void actions.generateJournal(callBotId) })}>
                  <IconBook size={14} />
                  生成今日期刊
                </button>
                {activeRoom === null ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="pa-chat__menu-danger"
                    onClick={() => runMenuAction(() => {
                      /*
                       * 打开自绘确认卡片，而不是 window.confirm——原生对话框会带上
                       * "dsh-shell" 这种页面标题、样式完全脱离 Bot 界面，很突兀。
                       * 群聊下不提供：那会连带清掉其他成员的发言。
                       */
                      setClearTarget(activeBot)
                    })}
                  >
                    <IconTrash size={14} />
                    清空对话
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        </div>
      </header>

      <div className="pa-chat">
        {/* 对话列两侧拖拽手柄：悬停亮线，拖动调宽度，双击恢复铺满。 */}
        <div
          className="pa-chat__resizer pa-chat__resizer--left"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整对话宽度"
          title="拖拽调整对话宽度（双击恢复铺满）"
          onMouseDown={(event) => startResize('left', event)}
          onDoubleClick={resetChatWidth}
        />
        <div
          className="pa-chat__resizer pa-chat__resizer--right"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整对话宽度"
          title="拖拽调整对话宽度（双击恢复铺满）"
          onMouseDown={(event) => startResize('right', event)}
          onDoubleClick={resetChatWidth}
        />
        <MessageList messages={activeMessages} bot={activeBot} room={activeRoom} />
        <PendingBar messages={activeMessages} />
        <Composer />

      {clearTarget !== null ? (
        <div
          className="pa-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setClearTarget(null)
          }}
        >
          <div className="pa-modal pa-confirm" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pa-modal__head">
              <div className="pa-modal__title">清空对话</div>
              <button className="pa-modal__close" type="button" onClick={() => setClearTarget(null)} aria-label="关闭">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-modal__body">
              <p className="pa-confirm__lead">清空与「{clearTarget.name}」的全部对话？</p>
              <p className="pa-confirm__hint">
                界面上的消息和它记住的上下文会一起清掉。清空后它不会再提起之前聊过的内容，此操作不可撤销。
              </p>
            </div>
            <div className="pa-modal__foot">
              <button className="pa-btn pa-btn--ghost" type="button" onClick={() => setClearTarget(null)}>
                取消
              </button>
              <button
                className="pa-btn pa-btn--danger"
                type="button"
                onClick={() => {
                  const target = clearTarget
                  setClearTarget(null)
                  void actions.clearConversation(target.id)
                }}
              >
                清空
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </>
  )
}

/* ───────────────────────── 待处理上浮条（2.6） ───────────────────────── */

/**
 * 待处理上浮条：输入框上方常驻一行，显示最新一条待办。
 *
 * 为什么只显示最新一条而不是全部：三条并排会把输入框往上顶掉一大截，而用户要的
 * 只是「别忘了还有事等你」。剩下几项用「还有 N 项」带过，点进去自然能看到原消息。
 *
 * 判据（pendingTasksOf / pendingSummaryOf）在 `pending.ts`：轮次结算行（2.8）
 * 用的是同一份口径，两处不能各写一套。
 */
function PendingBar({ messages }: { messages: Message[] }): JSX.Element | null {
  const tasks = useMemo(() => pendingTasksOf(messages), [messages])
  if (tasks.length === 0) return null
  const latest = tasks[tasks.length - 1]
  if (latest === undefined) return null
  const approval = latest.kind === 'approval'
  const summary = pendingSummaryOf(latest)
  /*
   * 跳转：消息容器在 MessageList 里带 `id="pa-msg-<前端消息 id>"`。
   * 滚动与高亮都收在 MessageList 的 jumpToMessage 里（引用条用的是同一个）。
   */
  const jump = (): void => jumpToMessage(latest.id)
  return (
    <button
      className="pa-pending"
      type="button"
      data-kind={approval ? 'approval' : 'need-input'}
      onClick={jump}
      title={summary}
    >
      <span className="pa-pending__dot" aria-hidden="true" />
      <span className="pa-pending__label">{approval ? '待确认' : '需要你定'}</span>
      <span className="pa-pending__text">{summary}</span>
      {tasks.length > 1 ? <span className="pa-pending__count">还有 {tasks.length - 1} 项</span> : null}
      <span className="pa-pending__jump">
        查看
        <IconChevronRight size={12} />
      </span>
    </button>
  )
}
