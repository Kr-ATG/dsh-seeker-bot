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
 * 行悬浮显示 ... 菜单：设置、移动分组、暂停/启用、删除（主 Bot 不显示删除）。
 * 所有写操作都走 store 的 actions，不另造状态层。
 *
 * 设置入口：Bot 行的「设置」调用 `actions.openBotSettings(botId)`，由
 * BotSettingsCard 自己渲染右侧滑出卡；群聊行的「群设置」同理。本文件不再
 * 维护「编辑 Bot」弹窗（旧 editDraft 已删除），底部「设置」也改成同一套
 * `pa-sheet` 滑出卡。
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
  IconBot,
  IconCheck,
  IconChevronRight,
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
import { PaSelect, type PaSelectOption } from '../shared/PaSelect.tsx'
import { usePersonal } from '../store.tsx'
import { DEFAULT_GROUP_ID, voiceLabel, type Bot, type Room } from '../types.ts'
import { BrandMark, BrandWordmark, IconPanelLeft } from './Brand.tsx'
import { NewRoomModal } from './NewRoomModal.tsx'
import {
  REALTIME_CONFIG_PATH,
  REALTIME_DEFAULT_VOICE,
  REALTIME_SPEED_LABELS,
  REALTIME_VOICES,
  type RealtimeSpeed,
} from '../../../shared/realtime-protocol.ts'

/**
 * 全局音色选项（底部「设置 → 通话音色」用）。
 *
 * 空串 = 清掉宿主配置、回内置默认音色（`REALTIME_DEFAULT_VOICE`）。
 * Bot 自己的音色下拉在 BotSettingsCard 里，文案不同（「跟随全局默认」），
 * 混用会让用户以为「这里选默认」等于「这个 Bot 不发声」，所以分开定义。
 */
const GLOBAL_VOICE_OPTIONS: PaSelectOption[] = [
  { value: '', label: `默认（${voiceLabel(REALTIME_DEFAULT_VOICE)}）` },
  ...REALTIME_VOICES.map((item) => ({ value: item.id, label: item.label, hint: item.hint })),
]

type MenuView = 'root' | 'move' | 'delete'

interface RowMenu {
  kind: 'bot' | 'room'
  id: string
  x: number
  y: number
  view: MenuView
}

/** 全局实时语音设置（宿主持久化，和 Bot 自己的音色互不影响）。 */
interface RealtimeForm {
  /** 音色 id；空串 = 宿主默认。 */
  voice: string
  speed: RealtimeSpeed
}

/**
 * `GET|POST /api/personal-agent/realtime/config` 的响应（只声明这里用到的字段）。
 *
 * 宿主永远不返回密钥值，`config` 里只有白名单字段。`defaults` 是宿主侧**实际生效**
 * 的兜底值：`defaults.voice` 是已配置的全局音色（没配过就是空串），`defaults.speed`
 * 恒为三档之一。注意「默认音色」在界面上固定显示 `REALTIME_DEFAULT_VOICE` 的名字——
 * 清空配置后宿主回落到的是内置默认，而不是 `defaults.voice`。
 */
interface RealtimeConfigResponse {
  ok?: boolean
  error?: string
  config?: { voice?: string; speed?: RealtimeSpeed }
  defaults?: { voice?: string; speed?: RealtimeSpeed }
}

/** 语速三档的展示顺序（慢 → 正常 → 快）。 */
const SPEED_ORDER: readonly RealtimeSpeed[] = ['slow', 'normal', 'fast']

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
  /** 顶部「+」弹出的新建菜单；right/y 是视口坐标（fixed 定位，右缘贴住按钮）。 */
  const [createMenu, setCreateMenu] = useState<{ right: number; y: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newRoomOpen, setNewRoomOpen] = useState(false)
  /* 设置弹层里的「通话音色 / 语速」：null = 还没从宿主读回来 */
  const [realtime, setRealtime] = useState<RealtimeForm | null>(null)
  const [realtimeError, setRealtimeError] = useState<string | null>(null)
  const [realtimeBusy, setRealtimeBusy] = useState(false)

  const mainBot = state.bots.find((bot) => bot.isMain) ?? state.bots[0]
  const sortedGroups = useMemo(
    () => [...state.groups].sort((a, b) => a.order - b.order),
    [state.groups],
  )

  const subBots = state.bots.filter((bot) => !bot.isMain)
  const rooms = state.rooms

  const menuBot = menu !== null && menu.kind === 'bot' ? state.bots.find((bot) => bot.id === menu.id) : undefined
  const menuRoom = menu !== null && menu.kind === 'room' ? state.rooms.find((room) => room.id === menu.id) : undefined

  /* 点击外部 / 滚动 / Esc 时关闭行菜单 */
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

  /*
   * 顶部「+」新建菜单：点外面、点 Esc、滚动或缩放都关闭。
   * 触发按钮自身不参与「点外面」判断，否则 mousedown 先关、click 又开，菜单会闪。
   */
  useEffect(() => {
    if (createMenu === null) return undefined
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (target !== null && (
        target.closest('.pa-create-menu') !== null
        || target.closest('[data-pa-create-trigger]') !== null
      )) return
      setCreateMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCreateMenu(null)
    }
    const onDismiss = (): void => setCreateMenu(null)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('scroll', onDismiss, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('scroll', onDismiss, true)
    }
  }, [createMenu])

  /* 设置卡：Esc 关闭（PaSelect 自己处理过 Esc 时会 preventDefault，避免一次按键关两层）。 */
  useEffect(() => {
    if (!settingsOpen) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  /*
   * 打开「设置」时从宿主读一次全局实时语音配置回填。
   *
   * 为什么不放进 AppState：这份配置由宿主持久化（settings 里的
   * personal-realtime.*），多设备 / 多标签页共享同一份；再塞一份进 localStorage
   * 就会出现两处真相。读写都走同一个 HTTP 接口，界面只做临时草稿。
   */
  useEffect(() => {
    if (!settingsOpen) return undefined
    let alive = true
    setRealtimeError(null)
    setRealtimeBusy(true)
    void (async () => {
      try {
        const res = await fetch(REALTIME_CONFIG_PATH, { headers: { accept: 'application/json' } })
        const data = (await res.json()) as RealtimeConfigResponse
        if (data.ok !== true) throw new Error(data.error ?? `读取失败（HTTP ${res.status}）`)
        if (!alive) return
        // 宿主 speed 恒为三档之一（默认 normal）；voice 空串 = 没配过，跟随默认
        setRealtime({ voice: data.config?.voice ?? '', speed: data.config?.speed ?? data.defaults?.speed ?? 'normal' })
      } catch (error) {
        if (!alive) return
        // 宿主不可用 / 独立演示页：行仍可点，但要让用户看见「读不到」而不是假装默认值
        setRealtimeError(error instanceof Error ? error.message : String(error))
      } finally {
        if (alive) setRealtimeBusy(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [settingsOpen])

  /**
   * 写全局实时语音配置。
   *
   * 乐观更新 + 失败回滚：下拉 / 分段按钮点下去要立刻有反馈，但宿主拒绝时界面
   * 不能停在「已保存」的假象上——错误同时落到行下方红字与 toast。
   * `voice: ''` 是宿主白名单里的「清掉，回默认」语义。
   */
  const saveRealtime = async (patch: { voice?: string; speed?: RealtimeSpeed }): Promise<void> => {
    const previous = realtime
    if (previous === null) return
    setRealtime({ ...previous, ...patch })
    setRealtimeBusy(true)
    setRealtimeError(null)
    try {
      const res = await fetch(REALTIME_CONFIG_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = (await res.json()) as RealtimeConfigResponse
      if (data.ok !== true) throw new Error(data.error ?? `保存失败（HTTP ${res.status}）`)
      actions.toast(
        patch.speed !== undefined
          ? `通话语速已设为「${REALTIME_SPEED_LABELS[patch.speed]}」`
          : '通话音色已更新',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setRealtime(previous)
      setRealtimeError(message)
      actions.toast(`通话设置保存失败：${message}`)
    } finally {
      setRealtimeBusy(false)
    }
  }

  /** 设置行副标题：当前音色的场景提示（没选就是「跟随宿主默认」）。 */
  const realtimeVoiceHint = realtime === null
    ? '正在读取宿主默认值…'
    : (REALTIME_VOICES.find((item) => item.id === realtime.voice)?.hint ?? '不指定音色，跟随宿主默认')

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

  /** 顶部「+」：贴按钮左下方展开，右缘与按钮对齐。 */
  const toggleCreateMenu = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (createMenu !== null) {
      setCreateMenu(null)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setCreateMenu({ right: Math.max(8, window.innerWidth - rect.right), y: rect.bottom + 8 })
  }

  /** 新建菜单里的两个入口：都先收起菜单，再打开对应弹窗。 */
  const openNewBot = (): void => {
    setCreateMenu(null)
    actions.openNewBot(true)
  }

  const openNewRoom = (): void => {
    setCreateMenu(null)
    setNewRoomOpen(true)
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
            actions.openBotSettings(bot.id)
            setMenu(null)
          }}
        >
          <IconSettings size={15} />
          <span>设置</span>
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

  const collapsed = ui.sidebarCollapsed

  /** 折叠态点头像：先切到那个会话，再展开侧栏（否则用户看不到切换结果）。 */
  const pickFromRail = (run: () => void): void => {
    run()
    actions.toggleSidebar(true)
  }

  /**
   * 折叠态（64px 图标轨道）。
   *
   * 与 Work 模式官方侧栏折叠后的 rail 同构：只留头像 / 图标，文字让位给
   * hover 提示。主 Bot 与每个子 Bot 都是可点的头像，群聊用成员头像叠加。
   */
  const renderRail = (): JSX.Element => (
    <div className="pa-sidebar__rail">
      <button
        className="pa-rail-item"
        type="button"
        title={`${mainBot.name}（主 Bot）`}
        aria-label={`${mainBot.name}（主 Bot）`}
        data-selected={ui.selectedBotId === mainBot.id && ui.selectedRoomId === null ? 'true' : 'false'}
        onClick={() => pickFromRail(() => actions.selectBot(mainBot.id))}
      >
        <BotAvatar avatar={mainBot.avatar} size={32} online={mainBot.status === 'online'} />
      </button>

      {subBots.length > 0 || rooms.length > 0 ? <div className="pa-rail-sep" /> : null}

      {subBots.map((bot) => (
        <button
          key={bot.id}
          className="pa-rail-item"
          type="button"
          title={`${bot.name} · ${bot.role}`}
          aria-label={`${bot.name} · ${bot.role}`}
          data-selected={ui.selectedBotId === bot.id && ui.selectedRoomId === null ? 'true' : 'false'}
          onClick={() => pickFromRail(() => actions.selectBot(bot.id))}
        >
          <BotAvatar avatar={bot.avatar} size={30} muted={!bot.enabled} />
          {bot.unread > 0 ? <span className="pa-rail-dot" aria-hidden="true" /> : null}
        </button>
      ))}

      {rooms.map((room) => {
        const members = room.memberIds
          .map((id) => state.bots.find((bot) => bot.id === id))
          .filter((bot): bot is Bot => bot !== undefined)
        return (
          <button
            key={room.id}
            className="pa-rail-item"
            type="button"
            title={`${room.name} · ${room.memberIds.length} 个 Bot`}
            aria-label={`${room.name} · ${room.memberIds.length} 个 Bot`}
            data-selected={ui.selectedRoomId === room.id ? 'true' : 'false'}
            onClick={() => pickFromRail(() => actions.selectRoom(room.id))}
          >
            <span className="pa-rail-room">
              {members.length === 0 ? (
                <IconUsers size={18} />
              ) : members.slice(0, 2).map((member) => (
                <BotAvatar key={member.id} avatar={member.avatar} size={22} />
              ))}
            </span>
            {room.unread > 0 ? <span className="pa-rail-dot" aria-hidden="true" /> : null}
          </button>
        )
      })}
    </div>
  )

  return (
    <aside className="pa-sidebar" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="pa-sidebar__top">
        {collapsed ? (
          <button
            className="pa-sidebar-toggle pa-sidebar-toggle--rail"
            type="button"
            title="展开侧边栏"
            aria-label="展开侧边栏"
            aria-expanded="false"
            onClick={() => actions.toggleSidebar(true)}
          >
            <span className="pa-sidebar-toggle__mark"><BrandMark size={20} /></span>
            <span className="pa-sidebar-toggle__icon"><IconPanelLeft size={16} /></span>
          </button>
        ) : (
          <>
            <span className="pa-brand">
              <BrandMark size={24} />
              <BrandWordmark height={24} />
            </span>
            <button
              className="pa-sidebar-toggle"
              type="button"
              title="收起侧边栏"
              aria-label="收起侧边栏"
              aria-expanded="true"
              onClick={() => actions.toggleSidebar(false)}
            >
              <IconPanelLeft size={16} />
            </button>
          </>
        )}
      </div>

      {collapsed ? null : (
        <div className="pa-mode-seg" role="tablist" aria-label="模式切换">
          <button type="button" role="tab" aria-selected="false" onClick={onExitWork}>Work</button>
          <button type="button" role="tab" aria-selected="true" data-on="true">Bot</button>
        </div>
      )}

      {collapsed ? renderRail() : (
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
            {/*
             * 新建入口：用户要求从顶部挪到主 Bot 卡片的右下角（2026-11-02）。
             * 放在这里而不是主区：新建出来的对象是 Bot / 群聊，归属侧栏名册，
             * 与主 Bot 卡片同区才符合「在这里长出新东西」的直觉。
             */}
            <button
              className="pa-mainbot__add"
              type="button"
              title="添加 Bot 或群聊"
              aria-label="添加 Bot 或群聊"
              aria-haspopup="menu"
              aria-expanded={createMenu !== null}
              data-open={createMenu !== null ? 'true' : 'false'}
              data-pa-create-trigger="true"
              onClick={toggleCreateMenu}
            >
              <IconPlus size={16} />
            </button>
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
            </div>
            {rooms.map((room) => renderRoomRow(room))}
          </div>

          {subBots.length === 0 && rooms.length === 0 ? (
            <div className="pa-sidebar-empty">还没有内容。点主 Bot 右下角的 + 新建 Bot 或群聊。</div>
          ) : null}
        </div>
      )}

      <div className="pa-sidebar__bottom" data-collapsed={collapsed ? 'true' : 'false'}>
        {collapsed ? (
          <>
            <button className="pa-rail-btn" type="button" title="期刊日记" aria-label="期刊日记" onClick={openJournal}>
              <IconBook size={18} />
            </button>
            <button className="pa-rail-btn" type="button" title="设置" aria-label="设置" onClick={() => setSettingsOpen(true)}>
              <IconSettings size={18} />
            </button>
          </>
        ) : (
          <>
            <button className="pa-side-bottom-item" type="button" title="期刊日记" onClick={openJournal}>
              <IconBook size={17} />
              <span>期刊日记</span>
            </button>
            <button className="pa-side-bottom-item" type="button" title="设置" onClick={() => setSettingsOpen(true)}>
              <IconSettings size={17} />
              <span>设置</span>
            </button>
          </>
        )}
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

      {createMenu !== null ? (
        <div
          className="pa-popover pa-create-menu"
          style={{ right: createMenu.right, top: createMenu.y }}
          role="menu"
          aria-label="新建"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="pa-create-menu__title">新建</div>
          <button className="pa-create-item" type="button" role="menuitem" onClick={openNewBot}>
            <span className="pa-create-item__icon pa-create-item__icon--bot">
              <IconBot size={19} />
            </span>
            <span className="pa-create-item__text">
              <b>添加 Bot</b>
              <span>创建一个专职子助手</span>
            </span>
            <IconChevronRight size={14} className="pa-create-item__arrow" />
          </button>
          <button className="pa-create-item" type="button" role="menuitem" onClick={openNewRoom}>
            <span className="pa-create-item__icon pa-create-item__icon--room">
              <IconUsers size={19} />
            </span>
            <span className="pa-create-item__text">
              <b>添加群聊</b>
              <span>多个 Bot 一起协作</span>
            </span>
            <IconChevronRight size={14} className="pa-create-item__arrow" />
          </button>
        </div>
      ) : null}

      <NewRoomModal open={newRoomOpen} onClose={() => setNewRoomOpen(false)} />

      {settingsOpen ? (
        <div
          className="pa-sheet-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false)
          }}
        >
          <aside
            className="pa-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="设置"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="pa-sheet__head">
              <div className="pa-sheet__head-text">
                <div className="pa-sheet__title">设置</div>
                <div className="pa-sheet__sub">外观 · 右栏 · 通话 · 分组 · 期刊</div>
              </div>
              <button className="pa-sheet__close" type="button" onClick={() => setSettingsOpen(false)} title="关闭" aria-label="关闭设置">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-sheet__body">
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
                  <span>在聊天区右侧显示 Bot 浏览器、产出物与任务记录</span>
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

              <div className="pa-settings-row">
                <div className="pa-settings-row__main">
                  <b>通话音色</b>
                  <span>{realtimeVoiceHint}</span>
                </div>
                <PaSelect
                  className="pa-select--compact"
                  value={realtime?.voice ?? ''}
                  options={GLOBAL_VOICE_OPTIONS}
                  disabled={realtime === null || realtimeBusy}
                  ariaLabel="通话音色"
                  onChange={(next) => {
                    // 空值 = 清掉宿主配置、回内置默认音色（REALTIME_DEFAULT_VOICE）
                    void saveRealtime({ voice: next })
                  }}
                />
              </div>

              <div className="pa-settings-row">
                <div className="pa-settings-row__main">
                  <b>通话语速</b>
                  <span>通过 instructions 描述给模型，实际听感可能有细微差异</span>
                </div>
                <div className="pa-theme-seg">
                  {SPEED_ORDER.map((speed) => (
                    <button
                      key={speed}
                      type="button"
                      data-on={(realtime?.speed ?? 'normal') === speed ? 'true' : 'false'}
                      disabled={realtime === null || realtimeBusy}
                      onClick={() => {
                        void saveRealtime({ speed })
                      }}
                    >
                      {REALTIME_SPEED_LABELS[speed]}
                    </button>
                  ))}
                </div>
              </div>

              {realtimeError !== null ? (
                <div className="pa-settings-error">通话设置没读写成功：{realtimeError}</div>
              ) : null}

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
            <div className="pa-sheet__foot">
              <button className="pa-btn pa-btn--primary" type="button" onClick={() => setSettingsOpen(false)}>完成</button>
            </div>
          </aside>
        </div>
      ) : null}
    </aside>
  )
}
