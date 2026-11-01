/**
 * Personal Agent — 聊天主面板。
 *
 * 会话头（44px 头像 / 名称 / 角色或群成员数 / 呼叫 / 更多）+ 消息流 + 输入框。
 * 群聊时头部显示成员头像叠加，消息流按 senderName 显示发送者。
 */
import { useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { IconBook, IconMessage, IconMore, IconPhone, IconTrash, IconUsers, IconX } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import type { Bot } from '../types.ts'
import { Composer } from './Composer.tsx'
import { MessageList } from './MessageList.tsx'

export function ChatPanel(): JSX.Element {
  const { state, ui, actions, activeBot, activeRoom, activeMessages } = usePersonal()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  /** 待清空对话的目标 bot（非 null 时显示确认卡片）。 */
  const [clearTarget, setClearTarget] = useState<Bot | null>(null)

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
    <div className="pa-chat">
      <header className="pa-chat__header">
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
                <button type="button" role="menuitem" onClick={() => runMenuAction(() => actions.toggleRightPanel(true))}>
                  <IconUsers size={14} />
                  查看详情
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
      </header>

      <MessageList messages={activeMessages} bot={activeBot} room={activeRoom} />
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
  )
}
