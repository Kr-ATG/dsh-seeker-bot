/**
 * Personal Agent — 左侧栏。
 *
 * 结构（参考 ref-left.png / ref-top.png）：
 *   顶部图标行（折叠 / 搜索 / +）
 *   Work | Bot 分段控件（Bot 高亮，点 Work 回到官方工作台）
 *   主 Bot（56px 头像 + 名称 + 在线橙点）
 *   按 groups 顺序渲染的子 Bot 列表（34px 头像 / 名称 / 角色 / 最近消息 / 未读）
 *   群聊分组（成员头像叠加）
 *   底部：期刊日记 / 设置
 *
 * 行悬浮显示 ... 菜单：编辑、移动分组、暂停/启用、删除（主 Bot 不显示删除）。
 * 所有写操作都走 store 的 actions，不另造状态层。
 */
import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { BotAvatar } from '../Avatar.tsx'
import {
  IconBook,
  IconCheck,
  IconChevronRight,
  IconEdit,
  IconFolder,
  IconMoon,
  IconMore,
  IconPause,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconSun,
  IconTrash,
  IconUsers,
  IconX,
} from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { DEFAULT_GROUP_ID, type Bot, type Room } from '../types.ts'

type MenuView = 'root' | 'move' | 'delete'

interface RowMenu {
  kind: 'bot' | 'room'
  id: string
  x: number
  y: number
  view: MenuView
}

interface EditDraft {
  id: string
  name: string
  role: string
}

/** 行按钮的键盘激活（Enter / Space）。 */
function rowKeyHandler(run: () => void) {
  return (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      run()
    }
  }
}

/** 两位数补零（设置弹窗的规则时间展示）。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function Sidebar({ onExitWork }: { onExitWork: () => void }): JSX.Element {
  const { state, ui, actions } = usePersonal()
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newRoomOpen, setNewRoomOpen] = useState(false)
  const [newRoomName, setNewRoomName] = useState('')
  const [newRoomMembers, setNewRoomMembers] = useState<string[]>([])

  const mainBot = state.bots.find((bot) => bot.isMain) ?? state.bots[0]
  const sortedGroups = useMemo(
    () => [...state.groups].sort((a, b) => a.order - b.order),
    [state.groups],
  )

  const subBots = state.bots.filter((bot) => !bot.isMain)
  const rooms = state.rooms

  const menuBot = menu !== null && menu.kind === 'bot' ? state.bots.find((bot) => bot.id === menu.id) : undefined
  const menuRoom = menu !== null && menu.kind === 'room' ? state.rooms.find((room) => room.id === menu.id) : undefined

  /* 点击外部 / 滚动时关闭行菜单 */
  useEffect(() => {
    if (menu === null) return undefined
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (target !== null && target.closest('.pa-popover') !== null) return
      setMenu(null)
    }
    const onDismiss = (): void => setMenu(null)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('scroll', onDismiss, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('scroll', onDismiss, true)
    }
  }, [menu])

  const openMenu = (event: ReactMouseEvent<HTMLElement>, kind: RowMenu['kind'], id: string): void => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const width = 184
    const height = kind === 'bot' ? 240 : 160
    const x = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const y = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))
    setMenu({ kind, id, x, y, view: 'root' })
  }

  const setMenuView = (view: MenuView): void => {
    setMenu((prev) => (prev === null ? prev : { ...prev, view }))
  }

  const selectBot = (id: string): void => {
    setMenu(null)
    actions.selectBot(id)
  }

  const selectRoom = (id: string): void => {
    setMenu(null)
    actions.selectRoom(id)
  }

  const openJournal = (): void => {
    actions.openJournal(null)
    actions.setView('journal')
  }

  const openNewRoom = (): void => {
    setNewRoomName('')
    setNewRoomMembers([mainBot.id, ...state.bots.filter((bot) => !bot.isMain).slice(0, 3).map((bot) => bot.id)])
    setNewRoomOpen(true)
  }

  const toggleNewRoomMember = (id: string): void => {
    setNewRoomMembers((prev) => (prev.includes(id) ? prev.filter((memberId) => memberId !== id) : [...prev, id]))
  }

  const submitNewRoom = (): void => {
    if (newRoomMembers.length === 0) {
      actions.toast('群聊至少需要一个成员')
      return
    }
    const id = actions.createRoom(newRoomName.trim() || '新群聊', newRoomMembers)
    setNewRoomOpen(false)
    actions.selectRoom(id)
    actions.toast('群聊已创建')
  }

  const saveEdit = (): void => {
    if (editDraft === null) return
    const target = state.bots.find((bot) => bot.id === editDraft.id)
    if (target === undefined) {
      setEditDraft(null)
      return
    }
    actions.updateBot(editDraft.id, {
      name: editDraft.name.trim() || target.name,
      role: editDraft.role.trim() || target.role,
    })
    actions.toast('已更新 Bot 资料')
    setEditDraft(null)
  }

  const renderBotRow = (bot: Bot): JSX.Element => (
    <div
      key={bot.id}
      className="pa-bot-row"
      data-selected={ui.selectedBotId === bot.id && ui.selectedRoomId === null ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      onClick={() => selectBot(bot.id)}
      onKeyDown={rowKeyHandler(() => selectBot(bot.id))}
    >
      <BotAvatar avatar={bot.avatar} size={34} muted={!bot.enabled} />
      <div className="pa-bot-row__body">
        <div className="pa-bot-row__line1">
          <span className="pa-bot-row__name">{bot.name}</span>
          {bot.role !== bot.name ? <span className="pa-bot-row__role">{bot.role}</span> : null}
        </div>
        <div className="pa-bot-row__summary">{bot.lastMessage ?? bot.description ?? '还没有消息'}</div>
      </div>
      {bot.unread > 0 ? <span className="pa-bot-row__badge">{bot.unread > 99 ? '99+' : bot.unread}</span> : null}
      <button
        className="pa-row-more"
        type="button"
        title="更多操作"
        aria-label="更多操作"
        onClick={(event) => openMenu(event, 'bot', bot.id)}
      >
        <IconMore size={15} />
      </button>
    </div>
  )

  const renderRoomRow = (room: Room): JSX.Element => {
    const members = room.memberIds
      .map((id) => state.bots.find((bot) => bot.id === id))
      .filter((bot): bot is Bot => bot !== undefined)
    return (
      <div
        key={room.id}
        className="pa-bot-row"
        data-selected={ui.selectedRoomId === room.id ? 'true' : 'false'}
        role="button"
        tabIndex={0}
        onClick={() => selectRoom(room.id)}
        onKeyDown={rowKeyHandler(() => selectRoom(room.id))}
      >
        <span className="pa-room-avatars">
          {members.length === 0 ? (
            <span className="pa-room-fallback"><IconUsers size={18} /></span>
          ) : members.slice(0, 3).map((member) => (
            <BotAvatar key={member.id} avatar={member.avatar} size={26} />
          ))}
        </span>
        <div className="pa-bot-row__body">
          <div className="pa-bot-row__line1">
            <span className="pa-bot-row__name">{room.name}</span>
          </div>
          <div className="pa-bot-row__summary">{room.memberIds.length} 个 Bot · 群聊</div>
        </div>
        {room.unread > 0 ? <span className="pa-bot-row__badge">{room.unread > 99 ? '99+' : room.unread}</span> : null}
        <button
          className="pa-row-more"
          type="button"
          title="群聊操作"
          aria-label="群聊操作"
          onClick={(event) => openMenu(event, 'room', room.id)}
        >
          <IconMore size={15} />
        </button>
      </div>
    )
  }

  const renderBotMenu = (bot: Bot): JSX.Element => {
    if (menu?.view === 'move') {
      return (
        <>
          <div className="pa-popover__title">移动到分组</div>
          {sortedGroups.map((group) => (
            <button
              key={group.id}
              className="pa-popover__item"
              type="button"
              onClick={() => {
                actions.moveBot(bot.id, group.id)
                setMenu(null)
                actions.toast(`已移动到「${group.name}」`)
              }}
            >
              <IconFolder size={15} />
              <span>{group.name}</span>
              {bot.groupId === group.id ? <span style={{ marginLeft: 'auto', color: 'var(--pa-accent)' }}><IconCheck size={13} /></span> : null}
            </button>
          ))}
        </>
      )
    }
    if (menu?.view === 'delete') {
      return (
        <div className="pa-popover__confirm">
          确定删除「{bot.name}」？它的独立记忆与例行任务会一并删除。
          <div className="pa-popover__confirm-row">
            <button className="pa-btn pa-btn--ghost" type="button" onClick={() => setMenuView('root')}>取消</button>
            <button
              className="pa-btn pa-btn--danger"
              type="button"
              onClick={() => {
                actions.deleteBot(bot.id)
                setMenu(null)
              }}
            >
              删除
            </button>
          </div>
        </div>
      )
    }
    return (
      <>
        <button
          className="pa-popover__item"
          type="button"
          onClick={() => {
            setEditDraft({ id: bot.id, name: bot.name, role: bot.role })
            setMenu(null)
          }}
        >
          <IconEdit size={15} />
          <span>编辑</span>
        </button>
        <button className="pa-popover__item" type="button" onClick={() => setMenuView('move')}>
          <IconFolder size={15} />
          <span>移动分组</span>
          <span style={{ marginLeft: 'auto', color: 'var(--pa-text-4)' }}><IconChevronRight size={13} /></span>
        </button>
        <button
          className="pa-popover__item"
          type="button"
          onClick={() => {
            actions.setBotEnabled(bot.id, !bot.enabled)
            setMenu(null)
          }}
        >
          {bot.enabled ? <IconPause size={15} /> : <IconPlay size={15} />}
          <span>{bot.enabled ? '暂停' : '启用'}</span>
        </button>
        {!bot.isMain ? (
          <>
            <div className="pa-popover__sep" />
            <button className="pa-popover__item" type="button" data-danger="true" onClick={() => setMenuView('delete')}>
              <IconTrash size={15} />
              <span>删除</span>
            </button>
          </>
        ) : null}
      </>
    )
  }

  const renderRoomMenu = (room: Room): JSX.Element => {
    if (menu?.view === 'delete') {
      return (
        <div className="pa-popover__confirm">
          确定删除群聊「{room.name}」？聊天记录会保留在本地。
          <div className="pa-popover__confirm-row">
            <button className="pa-btn pa-btn--ghost" type="button" onClick={() => setMenuView('root')}>取消</button>
            <button
              className="pa-btn pa-btn--danger"
              type="button"
              onClick={() => {
                actions.deleteRoom(room.id)
                setMenu(null)
                actions.toast('群聊已删除')
              }}
            >
              删除
            </button>
          </div>
        </div>
      )
    }
    return (
      <>
        <button
          className="pa-popover__item"
          type="button"
          onClick={() => {
            actions.openGroupSettings(room.id)
            setMenu(null)
          }}
        >
          <IconSettings size={15} />
          <span>群设置</span>
        </button>
        <div className="pa-popover__sep" />
        <button className="pa-popover__item" type="button" data-danger="true" onClick={() => setMenuView('delete')}>
          <IconTrash size={15} />
          <span>删除群聊</span>
        </button>
      </>
    )
  }

  return (
    <aside className="pa-sidebar">
      <div className="pa-sidebar__top">
        <button
          className="pa-icon-btn pa-icon-btn--bordered"
          type="button"
          title="新建 Bot"
          aria-label="新建 Bot"
          onClick={() => actions.openNewBot(true)}
        >
          <IconPlus size={18} />
        </button>
      </div>

      <div className="pa-mode-seg" role="tablist" aria-label="模式切换">
        <button type="button" role="tab" aria-selected="false" onClick={onExitWork}>Work</button>
        <button type="button" role="tab" aria-selected="true" data-on="true">Bot</button>
      </div>

      <div className="pa-sidebar__scroll">
          <div
            className="pa-mainbot"
            data-selected={ui.selectedBotId === mainBot.id && ui.selectedRoomId === null ? 'true' : 'false'}
            role="button"
            tabIndex={0}
            onClick={() => actions.selectBot(mainBot.id)}
            onKeyDown={rowKeyHandler(() => actions.selectBot(mainBot.id))}
          >
            <BotAvatar avatar={mainBot.avatar} size={48} online={mainBot.status === 'online'} />
            <span className="pa-mainbot__name">{mainBot.name}</span>
            <button
              className="pa-row-more"
              type="button"
              title="更多操作"
              aria-label="主 Bot 更多操作"
              onClick={(event) => openMenu(event, 'bot', mainBot.id)}
            >
              <IconMore size={15} />
            </button>
          </div>

          {sortedGroups.map((group) => {
            const groupBots = subBots.filter((bot) => bot.groupId === group.id)
            if (groupBots.length === 0) return null
            return (
              <div key={group.id}>
                <div className="pa-sec-title">
                  <span>{group.name}</span>
                  <span className="pa-sec-title__count">{groupBots.length}</span>
                </div>
                {groupBots.map((bot) => renderBotRow(bot))}
              </div>
            )
          })}

          <div>
            <div className="pa-sec-title">
              <span>群聊</span>
              <span className="pa-sec-title__count">{rooms.length}</span>
              <button className="pa-sec-add" type="button" title="新建群聊" aria-label="新建群聊" onClick={openNewRoom}>
                <IconPlus size={12} />
              </button>
            </div>
            {rooms.map((room) => renderRoomRow(room))}
          </div>

          {subBots.length === 0 && rooms.length === 0 ? (
            <div className="pa-sidebar-empty">还没有子 Bot。点右上角 + 创建第一个。</div>
          ) : null}
        </div>

      <div className="pa-sidebar__bottom">
        <button className="pa-side-bottom-item" type="button" title="期刊日记" onClick={openJournal}>
          <IconBook size={17} />
          <span>期刊日记</span>
        </button>
        <button className="pa-side-bottom-item" type="button" title="设置" onClick={() => setSettingsOpen(true)}>
          <IconSettings size={17} />
          <span>设置</span>
        </button>
      </div>

      {menu !== null ? (
        <div
          className="pa-popover"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {menu.kind === 'bot' && menuBot !== undefined ? renderBotMenu(menuBot) : null}
          {menu.kind === 'room' && menuRoom !== undefined ? renderRoomMenu(menuRoom) : null}
        </div>
      ) : null}

      {editDraft !== null ? (
        <div
          className="pa-overlay pa-overlay--fixed"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditDraft(null)
          }}
        >
          <div className="pa-modal pa-modal--sm" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pa-modal__head">
              <div className="pa-modal__title">编辑 Bot</div>
              <button className="pa-modal__close" type="button" onClick={() => setEditDraft(null)} aria-label="关闭">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-modal__body">
              <div className="pa-form-row">
                <label className="pa-label">名称</label>
                <input
                  className="pa-field"
                  value={editDraft.name}
                  onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })}
                  placeholder="Bot 名称"
                />
              </div>
              <div className="pa-form-row">
                <label className="pa-label">角色</label>
                <input
                  className="pa-field"
                  value={editDraft.role}
                  onChange={(event) => setEditDraft({ ...editDraft, role: event.target.value })}
                  placeholder="例如：代码审查员"
                />
              </div>
            </div>
            <div className="pa-modal__foot">
              <button className="pa-btn pa-btn--ghost" type="button" onClick={() => setEditDraft(null)}>取消</button>
              <button className="pa-btn pa-btn--primary" type="button" onClick={saveEdit}>保存</button>
            </div>
          </div>
        </div>
      ) : null}

      {newRoomOpen ? (
        <div
          className="pa-overlay pa-overlay--fixed"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setNewRoomOpen(false)
          }}
        >
          <div className="pa-modal pa-modal--sm" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pa-modal__head">
              <div className="pa-modal__title">新建群聊</div>
              <button className="pa-modal__close" type="button" onClick={() => setNewRoomOpen(false)} aria-label="关闭">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-modal__body">
              <div className="pa-form-row">
                <label className="pa-label">群聊名称</label>
                <input
                  className="pa-field"
                  value={newRoomName}
                  onChange={(event) => setNewRoomName(event.target.value)}
                  placeholder="例如：周报小组"
                  autoFocus
                />
              </div>
              <div className="pa-form-row">
                <label className="pa-label">选择成员 · 已选 {newRoomMembers.length} 个</label>
                <div className="pa-member-pick">
                  {state.bots.map((bot) => (
                    <button
                      key={bot.id}
                      className="pa-member-pick__row"
                      type="button"
                      data-on={newRoomMembers.includes(bot.id) ? 'true' : 'false'}
                      onClick={() => toggleNewRoomMember(bot.id)}
                    >
                      <BotAvatar avatar={bot.avatar} size={24} />
                      <span>{bot.name}</span>
                      {newRoomMembers.includes(bot.id) ? <IconCheck size={14} /> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="pa-modal__foot">
              <button className="pa-btn pa-btn--ghost" type="button" onClick={() => setNewRoomOpen(false)}>取消</button>
              <button className="pa-btn pa-btn--primary" type="button" onClick={submitNewRoom}>创建群聊</button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div
          className="pa-overlay pa-overlay--fixed"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false)
          }}
        >
          <div className="pa-modal pa-modal--sm" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pa-modal__head">
              <div className="pa-modal__title">设置</div>
              <button className="pa-modal__close" type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-modal__body">
              <div className="pa-settings-row">
                <div className="pa-settings-row__main">
                  <b>外观主题</b>
                  <span>界面跟随 DSH 的深色 / 浅色主题</span>
                </div>
                <div className="pa-theme-seg">
                  <button
                    type="button"
                    data-on={state.settings.theme === 'auto' ? 'true' : 'false'}
                    onClick={() => {
                      actions.setTheme('auto')
                      actions.toast('已跟随 DSH / 系统主题')
                    }}
                  >
                    <IconRefresh size={13} />跟随
                  </button>
                  <button
                    type="button"
                    data-on={state.settings.theme === 'dark' ? 'true' : 'false'}
                    onClick={() => {
                      actions.setTheme('dark')
                      actions.toast('已选择深色主题')
                    }}
                  >
                    <IconMoon size={13} />深色
                  </button>
                  <button
                    type="button"
                    data-on={state.settings.theme === 'light' ? 'true' : 'false'}
                    onClick={() => {
                      actions.setTheme('light')
                      actions.toast('已选择浅色主题')
                    }}
                  >
                    <IconSun size={13} />浅色
                  </button>
                </div>
              </div>

              <div className="pa-settings-row">
                <div className="pa-settings-row__main">
                  <b>右侧详情栏</b>
                  <span>在聊天区右侧显示 Bot 的详情、资料库与电脑</span>
                </div>
                <button
                  className="pa-switch"
                  type="button"
                  data-on={ui.rightPanelOpen ? 'true' : 'false'}
                  aria-label="切换右侧详情栏"
                  onClick={() => actions.toggleRightPanel(!ui.rightPanelOpen)}
                >
                  <i />
                </button>
              </div>

              <div className="pa-settings-note">
                <b>期刊日记规则</b><br />
                每天 {pad2(state.settings.journalRule.startHour)}:00 – {pad2(state.settings.journalRule.endHour)}:00 之间，
                {state.settings.journalRule.enabled ? '规则已启用' : '规则已停用'}；
                用户静默满 {state.settings.journalRule.idleMinutes} 分钟后，自动汇总前一天的对话生成期刊。
              </div>

              <div className="pa-settings-note">
                <b>Bot 分组</b><br />
                子 Bot 可以移动进不同分组；分组也决定侧栏的层级。
              </div>
              <div className="pa-group-list">
                {sortedGroups.map((group) => {
                  const count = state.bots.filter((bot) => !bot.isMain && bot.groupId === group.id).length
                  return (
                    <div className="pa-group-row" key={group.id}>
                      <span className="pa-group-row__name">{group.name}<em>{count}</em></span>
                      <button
                        className="pa-link-btn"
                        type="button"
                        onClick={() => {
                          const next = window.prompt('新的分组名称', group.name)
                          if (next !== null && next.trim() !== '') {
                            actions.renameGroup(group.id, next.trim())
                            actions.toast('分组已改名')
                          }
                        }}
                      >
                        改名
                      </button>
                      {group.id !== DEFAULT_GROUP_ID ? (
                        <button
                          className="pa-link-btn pa-link-btn--danger"
                          type="button"
                          onClick={() => {
                            actions.deleteGroup(group.id)
                            actions.toast('分组已删除，Bot 已移回「助手」')
                          }}
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
              <div className="pa-group-add">
                <input
                  className="pa-field"
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  placeholder="新建分组名称"
                />
                <button
                  className="pa-btn pa-btn--sm"
                  type="button"
                  onClick={() => {
                    if (newGroupName.trim() === '') return
                    actions.createGroup(newGroupName.trim())
                    setNewGroupName('')
                    actions.toast('分组已创建')
                  }}
                >
                  添加
                </button>
              </div>

              <div className="pa-settings-actions">
                <button
                  className="pa-btn pa-btn--sm"
                  type="button"
                  onClick={() => {
                    const result = actions.runJournalCheck()
                    actions.toast(result.reason)
                  }}
                >
                  <IconRefresh size={13} />立即检查
                </button>
                <button
                  className="pa-btn pa-btn--sm"
                  type="button"
                  onClick={() => {
                    void actions.generateJournal(mainBot.id)
                    setSettingsOpen(false)
                  }}
                >
                  <IconBook size={13} />生成今天的日记
                </button>
              </div>
            </div>
            <div className="pa-modal__foot">
              <button className="pa-btn pa-btn--primary" type="button" onClick={() => setSettingsOpen(false)}>完成</button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  )
}
