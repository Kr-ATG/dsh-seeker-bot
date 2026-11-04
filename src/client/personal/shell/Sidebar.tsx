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
 * 行悬浮显示 ... 菜单，只留两个动作：置顶 / 删除（群聊行是「解散群聊」）。
 * 设置、移动分组、暂停/启用都收进 Bot 设置卡与群聊设置卡，侧栏菜单不再重复。
 * 所有写操作都走 store 的 actions，不另造状态层。
 *
 * 设置入口：Bot 行的「设置」调用 `actions.openBotSettings(botId)`，由
 * BotSettingsCard 自己渲染右侧滑出卡；群聊行的「群设置」同理。本文件不再
 * 维护「编辑 Bot」弹窗（旧 editDraft 已删除），底部「设置」也改成同一套
 * `pa-sheet` 滑出卡。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { BotAvatar } from '../Avatar.tsx'
import {
  IconBook,
  IconBot,
  IconChevronRight,
  IconMoon,
  IconMore,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconSun,
  IconTrash,
  IconUsers,
  IconX,
} from '../icons.tsx'
import { PaSelect, type PaSelectOption } from '../shared/PaSelect.tsx'
import { ConnectorPill } from '../../triad/connectors/sidebar-pill.js'
import { blocksToText, usePersonal } from '../store.tsx'
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
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  persistSidebarWidth,
  setSidebarWidth,
} from '../../sidebar-width-persist.ts'

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

type MenuView = 'root' | 'delete'

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

/** 某一天 0 点的时间戳（只比日期，不比时分）。 */
function dayStartOf(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 完整的本地时间（YYYY-MM-DD HH:mm），用于行的悬停提示。 */
function fullTimeText(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 侧栏行右上角的最新时间：刚刚 / N 分钟前 / HH:mm / 昨天 / M/D / YYYY/M/D。
 *
 * 比会话头那套更短：侧栏一行只有两百来像素，还要和名字、角色、摘要抢宽度。
 * 所以同一天只给钟点（行内上下文足够判断今天），跨天才补日期；「N 分钟前」
 * 也只在 1 小时内用，再久就退回钟点，避免把摘要挤成省略号。
 */
function rowTimeText(at: number, now: number): string {
  const diff = Math.max(0, now - at)
  if (diff < 60_000) return '刚刚'
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(at)
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const today = new Date(now)
  const dayDiff = Math.round((dayStartOf(now) - dayStartOf(at)) / 86_400_000)
  if (dayDiff === 0) return clock
  if (dayDiff === 1) return '昨天'
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/**
 * 置顶优先的稳定排序：只把 pinned 的提到前面，其余保持原顺序。
 *
 * 用 sort 的稳定性（ES2019 起规范保证）而不是自己写分区逻辑：取消置顶后
 * 会话会回到它原来的位置，不会因为「排过一次」就漂到末尾。
 */
function pinnedFirst<T extends { pinned?: boolean }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true))
}

/** 「群聊」区块在 ui.collapsedSections 里的 id（Bot 分组直接用 group.id）。 */
const ROOMS_SECTION = 'rooms'

export function Sidebar({ onExitWork }: { onExitWork: () => void }): JSX.Element {
  const { state, ui, actions } = usePersonal()
  /**
   * 相对时间的基准时刻（刚刚 / N 分钟前）：每 30 秒走一格。
   *
   * 侧栏行的时间是常驻信息，不刷新的话「刚刚」会一直挂在那里，用户会以为
   * 刚才又说了话。
   */
  const [now, setNow] = useState(() => Date.now())
  const [menu, setMenu] = useState<RowMenu | null>(null)
  /** 顶部「+」弹出的新建菜单；right/y 是视口坐标（fixed 定位，右缘贴住按钮）。 */
  const [createMenu, setCreateMenu] = useState<{ right: number; y: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /*
   * 全局设置抽屉的退场状态：关闭时先播 240ms 退场（遮罩淡出 + 抽屉右移 46px），
   * 播完才 setSettingsOpen(false) 卸载。之前直接置 false，抽屉会硬消失，和入场
   * 那 220ms 的右滑入场完全不对称。
   *
   * 时长与曲线跟 src/client/modal-animation.ts 的 MODAL_ANIM_MS 对齐
   * （240ms / cubic-bezier(0.4, 0, 0.2, 1)）；关键帧在 settings.css.ts 的
   * .pa-sheet-overlay[data-closing='1'] 里，三张设置卡共用同一套。
   */
  const [settingsClosing, setSettingsClosing] = useState(false)
  const settingsCloseTimerRef = useRef<number | null>(null)

  /** 关闭设置抽屉：先播 240ms 退场再卸载（Esc / 点遮罩 / 关闭按钮 / 完成 都走这里）。 */
  const requestCloseSettings = useCallback((): void => {
    if (settingsCloseTimerRef.current !== null) return
    setSettingsClosing(true)
    settingsCloseTimerRef.current = window.setTimeout(() => {
      settingsCloseTimerRef.current = null
      setSettingsClosing(false)
      setSettingsOpen(false)
    }, 240)
  }, [])

  /* 侧栏卸载（切 Work / 关插件）时清掉计时器，别留一个会去 setState 的悬空回调。 */
  useEffect(() => () => {
    if (settingsCloseTimerRef.current !== null) window.clearTimeout(settingsCloseTimerRef.current)
  }, [])

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

  /**
   * 每个会话（Bot / 群聊）的「最后一句」：侧栏名字下方的摘要。
   *
   * 为什么直接遍历消息流、不读 bot.lastMessage / room.lastMessage：
   *  · 那两个字段只在消息**首次 append** 时写一次，流式更新（message-update）
   *    不会刷新它们，于是摘要会一直停在第一句话；
   *  · 群聊行原来干脆不显示摘要，写的是「N 个 Bot · 群聊」。
   * 这里按 at 取最新一条有正文的消息；纯工具调用 / 空占位的消息跳过，
   * 不会把摘要清成空白。消息多时是一次 O(n) 遍历，但只在 messages 变化时重算。
   */
  const conversationMeta = useMemo(() => {
    const out = new Map<string, { text: string; at: number; unread: number }>()
    for (const message of state.messages) {
      const key = message.roomId !== undefined ? `room:${message.roomId}` : `bot:${message.botId}`
      const at = message.at ?? 0
      let entry = out.get(key)
      if (entry === undefined) {
        entry = { text: '', at: 0, unread: 0 }
        out.set(key, entry)
      }
      const text = blocksToText(message.blocks).replace(/\s+/g, ' ').trim()
      // 摘要只被「有正文」的消息改写；纯工具调用 / 空占位不动它，免得上一条正文被清空
      if (text !== '' && at >= entry.at) entry.text = text
      if (at >= entry.at) entry.at = at
    }
    /*
     * 未读：已读时刻（ui.readAt）之后的 bot 消息，按轮次去重。
     *
     * 按 turnId 去重而不是按条数：一轮回复在多消息模式下可能落好几条
     * （进度 + 结论），逐条累加会让角标显示「3」而用户只收到一句回复。
     */
    const readAt = ui.readAt ?? {}
    const unreadTurns = new Map<string, Set<string>>()
    for (const message of state.messages) {
      if (message.role !== 'bot') continue
      const key = message.roomId !== undefined ? `room:${message.roomId}` : `bot:${message.botId}`
      if ((message.at ?? 0) <= (readAt[key] ?? 0)) continue
      let turns = unreadTurns.get(key)
      if (turns === undefined) {
        turns = new Set()
        unreadTurns.set(key, turns)
      }
      turns.add(message.turnId ?? message.id)
    }
    for (const [key, turns] of unreadTurns) {
      const entry = out.get(key)
      if (entry !== undefined) entry.unread = turns.size
    }
    return out
  }, [state.messages, ui.readAt])

  const subBots = state.bots.filter((bot) => !bot.isMain)
  const rooms = state.rooms

  const menuBot = menu !== null && menu.kind === 'bot' ? state.bots.find((bot) => bot.id === menu.id) : undefined
  const menuRoom = menu !== null && menu.kind === 'room' ? state.rooms.find((room) => room.id === menu.id) : undefined

  /* 相对时间走格：30 秒一跳，让「刚刚 / N 分钟前」不会停在旧值上。 */
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

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
      // 走 requestCloseSettings 而不是直接置 false：Esc 也要播完退场再卸载。
      if (event.key === 'Escape') requestCloseSettings()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [settingsOpen, requestCloseSettings])

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

  const renderBotRow = (bot: Bot): JSX.Element => {
    /*
     * 摘要优先用消息流里算出来的最后一句；回退顺序是 lastMessage → description
     * → 空态文案。description 只在「一次都没聊过」时才有机会出现。
     */
    const meta = conversationMeta.get(`bot:${bot.id}`)
    const summary = meta !== undefined && meta.text !== ''
      ? meta.text
      : bot.lastMessage ?? bot.description ?? '还没有消息'
    const unread = meta?.unread ?? 0
    return (
    <div
      key={bot.id}
      className="pa-bot-row"
      data-selected={ui.selectedBotId === bot.id && ui.selectedRoomId === null ? 'true' : 'false'}
      data-unread={unread > 0 ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      onClick={() => selectBot(bot.id)}
      onKeyDown={rowKeyHandler(() => selectBot(bot.id))}
    >
      <BotAvatar avatar={bot.avatar} size={34} muted={!bot.enabled} />
      <div className="pa-bot-row__body">
        <div className="pa-bot-row__line1">
          <span className="pa-bot-row__name">{bot.name}</span>
          {bot.pinned ? (
            <span className="pa-bot-row__pin" title="已置顶"><IconPin size={11} /></span>
          ) : null}
          {bot.role !== bot.name ? <span className="pa-bot-row__role">{bot.role}</span> : null}
          {bot.lastAt !== undefined ? (
            <span
              className="pa-bot-row__time"
              title={`最近一条消息：${fullTimeText(bot.lastAt)}`}
            >
              {rowTimeText(bot.lastAt, now)}
            </span>
          ) : null}
        </div>
        <div className="pa-bot-row__summary" title={summary}>{summary}</div>
      </div>
      {unread > 0 ? <span className="pa-bot-row__badge">{unread > 99 ? '99+' : unread}</span> : null}
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
  }

  const renderRoomRow = (room: Room): JSX.Element => {
    /*
     * 群聊行的摘要同样是「最后一句」：之前写死「N 个 Bot · 群聊」，用户扫一眼
     * 完全看不出这个群最近聊了什么。成员数改放 title（悬停可见）。
     */
    const meta = conversationMeta.get(`room:${room.id}`)
    const summary = meta !== undefined && meta.text !== ''
      ? meta.text
      : room.lastMessage ?? `${room.memberIds.length} 个 Bot · 群聊`
    const unread = meta?.unread ?? 0
    const members = room.memberIds
      .map((id) => state.bots.find((bot) => bot.id === id))
      .filter((bot): bot is Bot => bot !== undefined)
    return (
      <div
        key={room.id}
        className="pa-bot-row"
        data-selected={ui.selectedRoomId === room.id ? 'true' : 'false'}
        data-unread={unread > 0 ? 'true' : 'false'}
        role="button"
        tabIndex={0}
        onClick={() => selectRoom(room.id)}
        onKeyDown={rowKeyHandler(() => selectRoom(room.id))}
      >
        {room.avatar !== undefined ? (
          <BotAvatar avatar={room.avatar} size={34} />
        ) : (
          <span className="pa-room-avatars">
            {members.length === 0 ? (
              <span className="pa-room-fallback"><IconUsers size={18} /></span>
            ) : members.slice(0, 3).map((member) => (
              <BotAvatar key={member.id} avatar={member.avatar} size={26} />
            ))}
          </span>
        )}
        <div className="pa-bot-row__body">
          <div className="pa-bot-row__line1">
            <span className="pa-bot-row__name">{room.name}</span>
            {room.pinned === true ? (
              <span className="pa-bot-row__pin" title="已置顶"><IconPin size={11} /></span>
            ) : null}
            {room.lastAt !== undefined ? (
              <span
                className="pa-bot-row__time"
                title={`最近一条消息：${fullTimeText(room.lastAt)}`}
              >
                {rowTimeText(room.lastAt, now)}
              </span>
            ) : null}
          </div>
          <div
            className="pa-bot-row__summary"
            title={`${summary}（${room.memberIds.length} 个 Bot · 群聊）`}
          >
            {summary}
          </div>
        </div>
        {unread > 0 ? <span className="pa-bot-row__badge">{unread > 99 ? '99+' : unread}</span> : null}
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
            actions.setBotPinned(bot.id, !bot.pinned)
            setMenu(null)
            actions.toast(bot.pinned ? `已取消置顶「${bot.name}」` : `已置顶「${bot.name}」`)
          }}
        >
          <IconPin size={15} />
          <span>{bot.pinned ? '取消置顶' : '置顶'}</span>
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
          确定解散群聊「{room.name}」？聊天记录会保留在本地。
          <div className="pa-popover__confirm-row">
            <button className="pa-btn pa-btn--ghost" type="button" onClick={() => setMenuView('root')}>取消</button>
            <button
              className="pa-btn pa-btn--danger"
              type="button"
              onClick={() => {
                actions.deleteRoom(room.id)
                setMenu(null)
                actions.toast('群聊已解散')
              }}
            >
              解散
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
            actions.setRoomPinned(room.id, room.pinned !== true)
            setMenu(null)
            actions.toast(room.pinned === true ? `已取消置顶「${room.name}」` : `已置顶「${room.name}」`)
          }}
        >
          <IconPin size={15} />
          <span>{room.pinned === true ? '取消置顶' : '置顶'}</span>
        </button>
        <div className="pa-popover__sep" />
        <button className="pa-popover__item" type="button" data-danger="true" onClick={() => setMenuView('delete')}>
          <IconTrash size={15} />
          <span>解散群聊</span>
        </button>
      </>
    )
  }

  /** 收起的分区（Bot 分组 id + 'rooms'）；旧 ui 没有这个字段时按全部展开。 */
  const collapsedSections = ui.collapsedSections ?? []
  const collapsed = ui.sidebarCollapsed

  /**
   * 拖拽右边缘调整左侧栏宽度（2026-11-03 用户反馈「左侧侧边栏无法拖拽」）。
   *
   * 与 RightPanel 同一套手法：拖动过程直接改 .pa-root 的 --pa-sidebar-w
   * （每帧 setState 会让整棵 Bot 树重渲染，手感发涩），松手才落盘：
   *  · persistSidebarWidth 写 localStorage —— 刷新后由 sidebar-width-persist 恢复；
   *  · setSidebarWidth 同步官方 layout store —— 切回 Work 模式时官方侧栏同宽，
   *    官方自己的拖拽手柄位置也一起对齐（只改 DOM 会让手柄停在 store 的旧值上，
   *    正是 Work 模式里「手柄不在侧栏边界、拖不动」的根因）。
   *
   * 折叠态（64px 图标轨道）不提供手柄：那个宽度不是用户拖出来的值。
   */
  const startResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const sidebar = document.querySelector('.pa-sidebar')
    const root = document.querySelector('.pa-root')
    if (!(sidebar instanceof HTMLElement) || !(root instanceof HTMLElement)) return
    const startX = event.clientX
    const startWidth = sidebar.getBoundingClientRect().width
    // 侧栏隐藏（Work 模式下 pa-root 是 display:none）或尚未布局时宽度为 0：
    // 不进入拖拽，避免把宽度误设成下限。
    if (!(startWidth > 0)) return
    let latest = startWidth
    const onMove = (moveEvent: MouseEvent): void => {
      const next = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + (moveEvent.clientX - startX)),
      )
      latest = next
      root.style.setProperty('--pa-sidebar-w', `${next}px`)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.removeAttribute('data-pa-sidebar-resizing')
      persistSidebarWidth(latest)
      setSidebarWidth(latest)
    }
    document.body.setAttribute('data-pa-sidebar-resizing', 'true')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 双击手柄恢复默认宽度（与 Work 模式官方默认 280px 一致）。 */
  const resetSidebarWidth = (): void => {
    const root = document.querySelector('.pa-root')
    if (root instanceof HTMLElement) {
      root.style.setProperty('--pa-sidebar-w', `${DEFAULT_SIDEBAR_WIDTH}px`)
    }
    persistSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
  }

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
          {(conversationMeta.get(`bot:${bot.id}`)?.unread ?? 0) > 0
            ? <span className="pa-rail-dot" aria-hidden="true" />
            : null}
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
            {room.avatar !== undefined ? (
              <BotAvatar avatar={room.avatar} size={22} />
            ) : (
              <span className="pa-rail-room">
                {members.length === 0 ? (
                  <IconUsers size={18} />
                ) : members.slice(0, 2).map((member) => (
                  <BotAvatar key={member.id} avatar={member.avatar} size={22} />
                ))}
              </span>
            )}
            {(conversationMeta.get(`room:${room.id}`)?.unread ?? 0) > 0
              ? <span className="pa-rail-dot" aria-hidden="true" />
              : null}
          </button>
        )
      })}
    </div>
  )

  /*
   * 页面转场：侧栏与主区同步入场。
   *
   * 侧栏是「这一页」的左半边，只让主区动、侧栏硬切，切到 Bot 时会先看到
   * 一块已经到位的名册、再等主区浮上来，反而更碎。两者挂同一份属性，
   * 同一个 240ms 里一起上浮，读起来就是「整页进来了」。
   *
   * 重播时机同主列：靠 .pa-root 的 display:none → flex 重放（见 index.tsx）。
   */
  return (
    <aside className="pa-sidebar" data-collapsed={collapsed ? 'true' : 'false'}>
      {/* 右边缘拖拽手柄：调宽度，松手同步官方 store；双击恢复默认。 */}
      <div
        className="pa-sidebar__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整侧栏宽度"
        title="拖拽调整宽度（双击恢复默认）"
        onMouseDown={startResize}
        onDoubleClick={resetSidebarWidth}
      />
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
            {/* 尺寸对齐官方折叠态：railMark 24px、hover 的 panelIcon 18px
                （见 dsh-client-ui-sidebar 的 SidebarRoot：renderSlot size 24、
                IconPanelLeftOutlineRegular size wide ? 16 : 18）。 */}
            <span className="pa-sidebar-toggle__mark"><BrandMark size={24} /></span>
            <span className="pa-sidebar-toggle__icon"><IconPanelLeft size={18} /></span>
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
          {/*
            高亮块是独立 thumb（2026-11-04）：与官方 .skb-seg 同构，切换模式时
            由 mode-switch/index.ts 的 playThumbSlide 驱动一次左右滑动，而不是
            给按钮换背景色。按钮只负责文字与点击热区。
          */}
          <span className="pa-mode-seg__thumb" aria-hidden="true" />
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
            {/*
             * 主 Bot 卡片不给「...」菜单：它固定排在第一位（置顶没有意义）、
             * 不能删除，菜单里没有一项适用。它的设置在会话头「更多 → Bot 设置」。
             */}
          </div>

          {sortedGroups.map((group) => {
            const groupBots = pinnedFirst(subBots.filter((bot) => bot.groupId === group.id))
            if (groupBots.length === 0) return null
            const sectionCollapsed = collapsedSections.includes(group.id)
            return (
              <div key={group.id}>
                <button
                  className="pa-sec-title"
                  type="button"
                  data-collapsed={sectionCollapsed ? 'true' : 'false'}
                  aria-expanded={!sectionCollapsed}
                  title={sectionCollapsed ? `展开「${group.name}」` : `收起「${group.name}」`}
                  onClick={() => actions.toggleSection(group.id)}
                >
                  <IconChevronRight size={12} className="pa-sec-title__chevron" />
                  <span>{group.name}</span>
                </button>
                {sectionCollapsed ? null : groupBots.map((bot) => renderBotRow(bot))}
              </div>
            )
          })}

          <div>
            {(() => {
              const roomsCollapsed = collapsedSections.includes(ROOMS_SECTION)
              return (
                <>
                  <button
                    className="pa-sec-title"
                    type="button"
                    data-collapsed={roomsCollapsed ? 'true' : 'false'}
                    aria-expanded={!roomsCollapsed}
                    title={roomsCollapsed ? '展开群聊' : '收起群聊'}
                    onClick={() => actions.toggleSection(ROOMS_SECTION)}
                  >
                    <IconChevronRight size={12} className="pa-sec-title__chevron" />
                    <span>群聊</span>
                  </button>
                  {roomsCollapsed ? null : pinnedFirst(rooms).map((room) => renderRoomRow(room))}
                </>
              )
            })()}
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
              <IconBook size={18} />
              <span>期刊日记</span>
            </button>
            {/* 最下面一行 = 设置 + 右侧「MCP服务器」胶囊（与 Work 侧栏账号行同款入口）。
                Bot 侧栏有自己的 64px 折叠态（collapsed 分支只画图标），所以这里
                传 checkRail={false}——rail 判据只属于 Work 的官方侧栏。 */}
            <div className="pa-sidebar__bottom-row">
              <button className="pa-side-bottom-item" type="button" title="设置" onClick={() => setSettingsOpen(true)}>
                <IconSettings size={18} />
                <span>设置</span>
              </button>
              <ConnectorPill checkRail={false} />
            </div>
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

      {/*
        退场只加一个 data-closing，动画由 settings.css.ts 里
        .pa-sheet-overlay[data-closing='1'] 的后代选择器接管（特异性高于入场规则），
        入场 class 不用拆，两者不会同时抢同一个 animation 属性。
      */}
      {settingsOpen ? (
        <div
          className="pa-sheet-overlay"
          data-closing={settingsClosing ? '1' : undefined}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) requestCloseSettings()
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
              <button className="pa-sheet__close" type="button" onClick={requestCloseSettings} title="关闭" aria-label="关闭设置">
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
                    // 生成日记后收起设置卡：同样先播退场再卸载。
                    requestCloseSettings()
                  }}
                >
                  <IconBook size={13} />生成今天的日记
                </button>
              </div>
            </div>
            <div className="pa-sheet__foot">
              <button className="pa-btn pa-btn--primary" type="button" onClick={requestCloseSettings}>完成</button>
            </div>
          </aside>
        </div>
      ) : null}
    </aside>
  )
}
