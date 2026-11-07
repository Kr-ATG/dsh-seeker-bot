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
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { botAvatarStateOf } from '../avatar-state.ts'
import {
  IconBook,
  IconCamera,
  IconCameraSolid,
  IconChevronRight,
  IconListTodo,
  IconMoreSolid,
  IconPanelRightSolid,
  IconPhoneSolid,
  IconSettings,
  IconTrash,
  IconUsers,
  IconX,
} from '../icons.tsx'
import { PaShotModal } from '../shot/PaShotModal.tsx'
import { blocksToText, usePersonal } from '../store.tsx'
import type { AssignmentView, Bot, Message, TaskRecordStep } from '../types.ts'
import type { RelayBrief } from '../../../shared/relay.ts'
import { AutoSpeakButton } from './AutoSpeakButton.tsx'
import { Composer } from './Composer.tsx'
import { MessageList, jumpToMessage } from './MessageList.tsx'
import { ReminderBand } from './ReminderBand.tsx'
import {
  endOfToday,
  fetchVaultReminder,
  muteReminder,
  restReminderOf,
  routineReminderOf,
  REST_AUTO_HIDE_MS,
  REST_IDLE_RESET_MS,
  REST_MUTE_MS,
  type ReminderActionId,
  type ReminderItem,
} from './reminder.ts'
import { pendingSummaryOf, pendingTasksOf } from './pending.ts'
import { dispatchViewsOf } from './dispatch.ts'
import { evaluateRelayTrigger, normalizeRelayAuto, relayHintKey, type RelayTrigger } from '../relay-trigger.ts'

const MIN_CHAT_WIDTH = 520
const MAX_CHAT_WIDTH = 1600
/** 上下文占用探测：每轮结束后先防抖 800ms，避免流式收尾的连续状态变化打出多次请求。 */
const RELAY_PROBE_DEBOUNCE_MS = 800
/** 两次探测至少隔 3 分钟：占用变化是慢变量，不必每轮都问宿主。 */
const RELAY_PROBE_THROTTLE_MS = 3 * 60_000

/** 任务与委派面板：最多展示多少条记录。 */
const ASSIGNMENT_PANEL_LIMIT = 20
/** 扫多少条最近任务来找「派出去」的步骤。 */
const ASSIGNMENT_TASK_SCAN_LIMIT = 20
/** 「派出去」类工具名（subagent / coordinate_bots 等）。 */
const DISPATCH_TOOL_PATTERN = /^(subagent|subagent_fork|task|coordinate_bots|bot_create)$/i
/** 工具名 → 中文动作（进度条与时间线共用；未收录的原样显示）。 */
const TOOL_ACTION_LABELS: Record<string, string> = {
  subagent: '派子任务',
  subagent_fork: '派子任务',
  task: '派子任务',
  web_search: '搜索网页',
  read: '读取文件',
  run_code: '执行命令',
  pwsh: '执行命令',
  write: '修改文件',
  edit: '修改文件',
  generate_image: '生成图片',
  generate_video: '生成视频',
  bot_create: '创建 Bot',
  coordinate_bots: '派活给其他 Bot',
}

/** 从任务步骤里筛出来的一条「派出去」记录（面板用）。 */
interface DispatchItem {
  key: string
  tool: string
  taskTitle: string
  description: string
  result: string
  status?: 'running' | 'ok' | 'error'
  at: number
  botId?: string
}

export function ChatPanel(): JSX.Element {
  const { state, ui, actions, activeBot, activeRoom, activeMessages, historyMessages } = usePersonal()
  /*
   * 投递回执（对话流里那行「已交给采集」）。
   *
   * 只认「当前 Bot 亲手派出去、且是最外层」的那几条（见 dispatch.ts）：子 Bot 的
   * 孙子任务挂到主管的对话流里，会让用户以为是自己派的。群聊里不显示——多个
   * Bot 同时在说话，一行系统状态挂在哪条下面都不对。
   */
  const dispatches = useMemo(
    () => (activeRoom !== null ? [] : dispatchViewsOf(state.assignmentsByBot?.[activeBot.id], activeBot.id)),
    [activeRoom, state.assignmentsByBot, activeBot.id],
  )
  /*
   * 一轮回复结束（pending 从有到无）时补拉一次委派：派活发生在那一轮中间，
   * 而 3 秒轮询只在该 Bot 已有未结束委派时才启动——不补这一下，第一条回执
   * 要等到用户切走再切回来才出现。
   */
  const anyPending = activeMessages.some((message) => message.role === 'bot' && message.pending === true)
  const pendingWasRef = useRef(false)
  const refreshAssignments = actions.refreshAssignments
  useEffect(() => {
    const was = pendingWasRef.current
    pendingWasRef.current = anyPending
    if (!was || anyPending) return
    if (activeRoom !== null) return
    void refreshAssignments(activeBot.id)
  }, [anyPending, activeRoom, activeBot.id, refreshAssignments])
  const [moreOpen, setMoreOpen] = useState(false)
  const [shotOpen, setShotOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  /*
   * 提醒带（2026-11-07）：动图让位到卡片左侧，右侧长出一块「文字 + 选项」面板。
   *
   * 状态只有三档，全部围绕「同一条时间线」：
   *   · reminder 为 null     —— 不在提醒态，动图在中间，面板不渲染；
   *   · shown === false      —— 面板已挂载但还是收起态（clip 全裁），下一帧才置 true，
   *                             clip-path 才有「从无到有」的过渡；
   *   · closing === true     —— 退场：面板先收 200ms，320ms 后整块卸载（与 CSS 对齐）。
   */
  const [reminder, setReminder] = useState<ReminderItem | null>(null)
  const [reminderShown, setReminderShown] = useState(false)
  const [reminderClosing, setReminderClosing] = useState(false)
  const reminderTimerRef = useRef<number | null>(null)
  /** 当前提醒（异步检查里判断「有没有正在播」，ref 避免闭包读到旧值）。 */
  const reminderRef = useRef<ReminderItem | null>(null)
  /** 对话卡本体：提醒位移量按它的实际宽度算。 */
  const chatCardRef = useRef<HTMLDivElement>(null)
  /** 待清空对话的目标 bot（非 null 时显示确认卡片）。 */
  const [clearTarget, setClearTarget] = useState<Bot | null>(null)
  /** 历史对话面板是否打开（只读回看归档）。 */
  const [historyOpen, setHistoryOpen] = useState(false)
  /** 当前展开预览的归档 id（null = 全部收起）。 */
  const [expandedArchiveId, setExpandedArchiveId] = useState<string | null>(null)
  /** 「任务与委派」面板是否打开（从「更多」菜单进入）。 */
  const [assignmentsOpen, setAssignmentsOpen] = useState(false)
  /**
   * 「整理并开新会话」的摘要状态。
   *
   * idle → preparing（正在调宿主生成）→ ready（卡片内展示预览）/ error（仍允许直接清空）。
   * 状态只活在确认卡打开期间：每次重新打开都重置，避免看到上一个 Bot 的摘要。
   */
  const [relay, setRelay] = useState<
    | { status: 'idle' }
    | { status: 'preparing' }
    | { status: 'ready'; brief: RelayBrief; degraded: boolean; error?: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' })
  /** 摘要请求序号：关闭 / 换目标 / 重新点击后，让迟到的异步结果失效。 */
  const relayRequestRef = useRef(0)
  /** 当前清空目标的最新值（异步回调里读 state 闭包会过期）。 */
  const clearTargetRef = useRef<Bot | null>(null)
  clearTargetRef.current = clearTarget
  /** 摘要就绪时给按钮用；派生出来便于 JSX 里收窄类型。 */
  const relayBrief = relay.status === 'ready' ? relay.brief : null
  const relayDegraded = relay.status === 'ready' && relay.degraded
  /** 当前上下文接力提示（null = 不显示）；点「关闭」后同一档不再出现。 */
  const [relayHint, setRelayHint] = useState<RelayTrigger | null>(null)
  /** 关闭记忆：botId + kind + 百分比十位档，只活在本次页面会话。 */
  const relayHintDismissedRef = useRef<Set<string>>(new Set())
  /** 上次探测的 bot / 时间（3 分钟节流；切 Bot 后重新计时）。 */
  const relayProbeRef = useRef<{ botId: string; at: number }>({ botId: '', at: 0 })
  /** 探测请求序号：切 Bot / 发起新请求后，迟到的旧结果直接丢弃。 */
  const relayProbeTokenRef = useRef(0)
  /** 自动整理是否正在执行（防止同一时刻重复生成摘要 / 重复切会话）。 */
  const autoRelayRunningRef = useRef(false)
  /** 最新 actions：异步回调里用，避免闭包过期；不放进 effect 依赖（防止每帧重跑探测）。 */
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  /** 当前会话 Bot id，异步回调里用它确认还停在同一个聊天里。 */
  const activeBotIdRef = useRef(activeBot.id)
  activeBotIdRef.current = activeBot.id

  /*
   * 退场状态：菜单与确认卡关闭时先播 240ms 动画再真正卸载。
   * 直接 setMoreOpen(false) / setClearTarget(null) 会让浮层一帧内硬消失，
   * 与入场那 160ms / 200ms 的弹出完全不对称。时长与曲线跟
   * src/client/modal-animation.ts 的 MODAL_ANIM_MS 对齐（240ms、
   * 出场用加速曲线 cubic-bezier(0.4, 0, 0.2, 1)）。
   */
  const [menuClosing, setMenuClosing] = useState(false)
  const menuTimerRef = useRef<number | null>(null)
  const [confirmClosing, setConfirmClosing] = useState(false)
  const confirmTimerRef = useRef<number | null>(null)
  const [historyClosing, setHistoryClosing] = useState(false)
  const historyTimerRef = useRef<number | null>(null)
  const [assignmentsClosing, setAssignmentsClosing] = useState(false)
  const assignmentsTimerRef = useRef<number | null>(null)

  /*
   * 退场结束后要执行的动作（打开设置 / 群设置等）。
   *
   * 单独放 ref 而不是闭包捕获：退场途中又点了另一项时，后一项会覆盖前一项，
   * 240ms 后只执行最后选的那条，不会两个面板一起弹出来。
   */
  const menuAfterRef = useRef<(() => void) | undefined>(undefined)

  /** 收起「更多」菜单：先播退场，240ms 后再执行 after（打开设置 / 群设置等）。 */
  const closeMenu = useCallback((after?: () => void): void => {
    // 只有菜单项会带动作；外部点击关闭不能把已排队的动作冲掉。
    if (after !== undefined) menuAfterRef.current = after
    if (menuTimerRef.current !== null) return
    setMenuClosing(true)
    menuTimerRef.current = window.setTimeout(() => {
      menuTimerRef.current = null
      setMenuClosing(false)
      setMoreOpen(false)
      const run = menuAfterRef.current
      menuAfterRef.current = undefined
      run?.()
    }, 240)
  }, [])

  /** 撤销退场：退场途中再点一次「更多」，菜单原地弹回，不必等这 240ms。 */
  const cancelMenuClose = useCallback((): void => {
    if (menuTimerRef.current !== null) {
      window.clearTimeout(menuTimerRef.current)
      menuTimerRef.current = null
    }
    menuAfterRef.current = undefined
    setMenuClosing(false)
  }, [])

  /** 关闭「清空对话」确认卡：先播退场，再执行原来的关闭 / 清空动作。 */
  const closeConfirm = useCallback((after?: () => void): void => {
    if (confirmTimerRef.current !== null) return
    setConfirmClosing(true)
    confirmTimerRef.current = window.setTimeout(() => {
      confirmTimerRef.current = null
      setConfirmClosing(false)
      setClearTarget(null)
      after?.()
    }, 240)
  }, [])

  /** 关闭「历史对话」面板：先播退场，再真正卸载。 */
  const closeHistory = useCallback((after?: () => void): void => {
    if (historyTimerRef.current !== null) return
    setHistoryClosing(true)
    historyTimerRef.current = window.setTimeout(() => {
      historyTimerRef.current = null
      setHistoryClosing(false)
      setHistoryOpen(false)
      setExpandedArchiveId(null)
      after?.()
    }, 240)
  }, [])

  /** 关闭「任务与委派」面板：先播退场，再真正卸载。 */
  const closeAssignments = useCallback((): void => {
    if (assignmentsTimerRef.current !== null) return
    setAssignmentsClosing(true)
    assignmentsTimerRef.current = window.setTimeout(() => {
      assignmentsTimerRef.current = null
      setAssignmentsClosing(false)
      setAssignmentsOpen(false)
    }, 240)
  }, [])

  /*
   * 提醒：出现 / 退场 / 动作。
   *
   * 出现时面板先以「收起态」挂载，再用双 rAF 置 shown=true —— 单 rAF 在部分情况下
   * 会和挂载提交合并进同一帧，clip-path 不会过渡（直接跳到位，等于没有动效）。
   */
  const presentReminder = useCallback((item: ReminderItem): void => {
    if (reminderRef.current !== null) {
      // 已在提醒态：原地换内容，不重播动图位移（动效规格里的「中断」口径）。
      reminderRef.current = item
      setReminder(item)
      return
    }
    reminderRef.current = item
    setReminder(item)
    setReminderShown(false)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => { setReminderShown(true) })
    })
  }, [])

  const closeReminder = useCallback((after?: () => void): void => {
    if (reminderTimerRef.current !== null) return
    setReminderShown(false)
    setReminderClosing(true)
    reminderTimerRef.current = window.setTimeout(() => {
      reminderTimerRef.current = null
      setReminderClosing(false)
      setReminder(null)
      reminderRef.current = null
      after?.()
    }, 320)
  }, [])

  const runReminderAction = useCallback((item: ReminderItem, actionId: ReminderActionId): void => {
    if (actionId === 'run-now' && item.kind === 'routine') {
      actions.runRoutine(item.id.slice('routine:'.length))
      // 立刻跑过之后半小时内不再提同一条：否则任务还在 nextAt 窗口里，会马上又弹。
      muteReminder(item.id, Date.now() + 30 * 60_000)
    } else if (actionId === 'know') {
      /*
       * 「知道了」也要压：休息提示 1 小时（它本来就是「该起来了」），
       * 档案 3 天（不压的话下一轮 5 分钟检查又会捡回来）。
       */
      muteReminder(item.id, item.kind === 'rest' ? Date.now() + REST_MUTE_MS : Date.now() + 3 * 24 * 60 * 60_000)
    } else if (actionId === 'dismiss') {
      // 关掉 = 今天不再提（例行任务）/ 7 天后再提（档案到期）/ 1 小时内不再提（休息）。
      muteReminder(item.id, item.kind === 'routine'
        ? endOfToday()
        : item.kind === 'rest' ? Date.now() + REST_MUTE_MS : Date.now() + 7 * 24 * 60 * 60_000)
    }
    closeReminder()
  }, [actions, closeReminder])

  /*
   * 提醒态的两个几何量，全部由 JS 按卡片真实宽度算一次写成 CSS 变量：
   *   · --pa-remind-w    面板宽（360–720px，宽屏固定 720，窄卡按比例收）；
   *   · --pa-remind-shift 动图让位量 = (面板宽 + 20) / 2 —— 让「角色 + 面板」整组居中。
   * CSS 端只做 transform 平移、不碰 left/width，位移全程在合成层上。
   */
  useEffect(() => {
    const element = chatCardRef.current
    if (element === null) return
    const sync = (): void => {
      const panelWidth = Math.round(Math.min(520, Math.max(320, element.clientWidth * 0.38)))
      element.style.setProperty('--pa-remind-w', `${String(panelWidth)}px`)
      element.style.setProperty('--pa-remind-shift', `${String(Math.round((panelWidth + 20) / 2))}px`)
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /*
   * 提醒来源：例行任务（提前 10 分钟窗口内最近一条）+ 档案到期（宿主清单里最近的）。
   * 启动 2.5s 后查一次（避开首屏渲染高峰），之后每 5 分钟一次。
   * routines 用 ref 读：数组每次渲染都可能重建，直接进依赖会让定时器反复重建。
   */
  const routines = state.routines
  const routinesRef = useRef(routines)
  routinesRef.current = routines
  /*
   * 连续工作时长（休息提示用）：用户超过 REST_IDLE_RESET_MS（15 分钟）没说话，
   * 就当中间离开过，起点重置回现在。lastUserMessageAt 用 ref 读最新值，
   * 不塞进 effect 依赖，避免每轮消息都重建定时器。
   */
  const restSinceRef = useRef<number>(Date.now())
  const lastUserAtRef = useRef<number>(state.lastUserMessageAt)
  lastUserAtRef.current = state.lastUserMessageAt
  useEffect(() => {
    if (activeRoom !== null) return
    let cancelled = false
    const check = async (): Promise<void> => {
      if (cancelled || reminderRef.current !== null) return
      const routine = routineReminderOf(routinesRef.current)
      if (routine !== null) {
        presentReminder(routine)
        return
      }
      const vault = await fetchVaultReminder()
      if (cancelled) return
      if (vault !== null) {
        presentReminder(vault)
        return
      }
      // 休息提示优先级最低：真有任务/档案的事，先把那两件说完。
      const now = Date.now()
      if (now - lastUserAtRef.current > REST_IDLE_RESET_MS) restSinceRef.current = now
      const rest = restReminderOf(now, restSinceRef.current)
      if (rest !== null) presentReminder(rest)
    }
    const kick = window.setTimeout(() => { void check() }, 2500)
    const poll = window.setInterval(() => { void check() }, 5 * 60_000)
    return () => {
      cancelled = true
      window.clearTimeout(kick)
      window.clearInterval(poll)
    }
  }, [activeRoom, presentReminder])

  /*
   * 休息提示「不点 3 分钟自动消失」：只有 rest 类带这个计时——任务/档案提醒要等
   * 用户处理，自己消失等于「提醒了又当没提醒」。自动收的同时压一小时，
   * 否则下一轮检查（5 分钟一次）会立刻把它捡回来。
   */
  const reminderKind = reminder?.kind
  const reminderId = reminder?.id
  useEffect(() => {
    if (reminderKind !== 'rest' || reminderId === undefined) return
    const timer = window.setTimeout(() => {
      muteReminder(reminderId, Date.now() + REST_MUTE_MS)
      closeReminder()
    }, REST_AUTO_HIDE_MS)
    return () => { window.clearTimeout(timer) }
  }, [reminderKind, reminderId, closeReminder])

  /**
   * 点「整理并开新会话」：调 store 生成接力摘要，成功后卡片内展示预览。
   *
   * 请求期间按钮显示「正在整理…」并禁用；失败只显示错误文案，不拦「直接清空」——
   * 宿主模型不可用时，用户至少还能把这段对话清掉。
   */
  const handlePrepareRelay = useCallback((): void => {
    const target = clearTargetRef.current
    if (target === null) return
    relayRequestRef.current += 1
    const requestId = relayRequestRef.current
    setRelay({ status: 'preparing' })
    void (async () => {
      const result = await actions.prepareRelay(target.id)
      // 迟到结果：卡片已关闭 / 换了 Bot / 又点了一次，一律丢弃
      if (relayRequestRef.current !== requestId) return
      if (clearTargetRef.current?.id !== target.id) return
      if (result === null) {
        setRelay({ status: 'error', message: '整理失败，请稍后重试；也可以直接清空对话。' })
        return
      }
      setRelay({
        status: 'ready',
        brief: result.brief,
        degraded: result.degraded,
        ...(typeof result.error === 'string' && result.error !== '' ? { error: result.error } : {}),
      })
    })()
  }, [actions])

  useEffect(() => () => {
    if (menuTimerRef.current !== null) window.clearTimeout(menuTimerRef.current)
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current)
    if (historyTimerRef.current !== null) window.clearTimeout(historyTimerRef.current)
    if (assignmentsTimerRef.current !== null) window.clearTimeout(assignmentsTimerRef.current)
    if (reminderTimerRef.current !== null) window.clearTimeout(reminderTimerRef.current)
  }, [])

  /**
   * 拖拽对话列左右边缘，**只收缩气泡列**（用户 2026-11-07 要求）。
   *
   * 以前拖的是整张对话卡片的宽度：卡片一窄，圆角、投影、悬浮会话头跟着动，
   * 上方布局与整体外观都受影响。现在卡片恒铺满，拖拽只写 `--pa-chat-w`
   * （= 目标气泡列宽，px）：
   *   · CSS 侧 .pa-chat__scroll 的左右边距 = max(基线, (容器宽 − 目标宽)/2)，
   *     于是只有气息列里的气泡收窄；
   *   · 会话头宽度写死在 calc(100% - gap*2 - 24px)，完全不参与；
   *   · 输入框、待处理条、卡片本身都不动。
   *
   * 拖动过程中直接改 CSS 变量、不 setState，松手才写回 `pa:ui:v1`，
   * 避免每帧重渲染整个对话流。
   */
  const startResize = (side: 'left' | 'right', event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const chat = event.currentTarget.closest('.pa-chat')
    const main = chat?.parentElement
    const scroll = chat instanceof HTMLElement ? chat.querySelector('.pa-chat__scroll') : null
    if (!(chat instanceof HTMLElement) || !(main instanceof HTMLElement) || !(scroll instanceof HTMLElement)) return
    const startX = event.clientX
    const scrollStyle = getComputedStyle(scroll)
    /*
     * 边距基线写在 CSS 变量上（宽屏 30 / 中屏 20 / 窄屏 14）：
     * 拖到最宽时气泡列 = 容器宽 − 2×基线，再宽就没有视觉变化，按「满宽」存 0。
     */
    const gutter = Number.parseFloat(scrollStyle.getPropertyValue('--pa-chat-bubble-gutter')) || 30
    const fullContentWidth = Math.max(0, scroll.clientWidth - gutter * 2)
    const upper = Math.min(MAX_CHAT_WIDTH, fullContentWidth)
    const lower = Math.min(MIN_CHAT_WIDTH, upper)
    const startContentWidth = Math.min(
      fullContentWidth,
      Math.max(0,
        scroll.clientWidth
          - Number.parseFloat(scrollStyle.paddingLeft || '0')
          - Number.parseFloat(scrollStyle.paddingRight || '0')),
    )
    let latest = Math.round(startContentWidth)
    const onMove = (moveEvent: MouseEvent): void => {
      // 两侧对称收放：边缘跟手需要 2 倍位移（气泡列左右同时内收）。
      const delta = side === 'left' ? startX - moveEvent.clientX : moveEvent.clientX - startX
      latest = Math.round(Math.min(upper, Math.max(lower, startContentWidth + delta * 2)))
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

  /** 双击恢复满宽（0 = 气泡列不额外收窄）。 */
  const resetChatWidth = (): void => {
    actions.setChatWidth(0)
  }

  const roomBots: Bot[] = activeRoom === null
    ? []
    : activeRoom.memberIds
      .map((id) => state.bots.find((bot) => bot.id === id))
      .filter((bot): bot is Bot => bot !== undefined)
  /** 群聊自定义头像（activeRoom 只裁了 id/name/memberIds，头像要从原始 rooms 里取）。 */
  const roomAvatar = activeRoom === null
    ? undefined
    : state.rooms.find((room) => room.id === activeRoom.id)?.avatar

  const title = activeRoom !== null ? activeRoom.name : activeBot.name
  const subtitle = activeRoom !== null ? `${roomBots.length} 个 Bot · 群聊` : activeBot.role
  const callBotId = activeRoom !== null ? (roomBots.find((bot) => bot.isMain) ?? roomBots[0] ?? activeBot).id : activeBot.id
  const callBot = state.bots.find((bot) => bot.id === callBotId) ?? activeBot
  /*
   * 对话卡顶部悬浮动图的三态（2026-11-07）：从右栏资料区迁到这里，判定口径完全
   * 沿用 botAvatarStateOf —— 群聊看整场群聊、私聊看该 Bot；切换 Bot / 群聊时
   * activeBot / activeRoom / activeMessages 一起变化，状态与取图 URL 自动重算。
   */
  const avatarState = botAvatarStateOf(activeBot, activeMessages, state.tasks, activeRoom?.id)
  /** 当前私聊 Bot 的历史对话归档（新→旧；右栏面板只读回看）。 */
  const archivedSessions = useMemo(() => {
    return (state.archivedSessions ?? [])
      .filter((session) => session.botId === activeBot.id)
      .sort((a, b) => b.archivedAt - a.archivedAt)
  }, [state.archivedSessions, activeBot.id])

  /** 当前会话的任务记录（新→旧）。任务进度条与委派面板的主数据源。 */
  const botTasks = useMemo(() => {
    return state.tasks
      .filter((task) => task.botId === activeBot.id
        && (activeRoom === null ? task.roomId === undefined : task.roomId === activeRoom.id))
      .sort((a, b) => b.startedAt - a.startedAt)
  }, [state.tasks, activeBot.id, activeRoom?.id])

  /** 当前正在跑的一轮任务；没有就是 undefined。 */
  const runningTask = botTasks.find((task) => task.status === 'running')
  /** 面板展示的任务：优先正在跑的，否则最近一条。 */
  const panelTask = runningTask ?? botTasks[0]

  /**
   * 从最近 20 条任务的工具步骤里筛出「派出去」的记录。
   *
   * 主数据源是 TaskRecord.steps——DSH 的 subagent / coordinate_bots / bot_create
   * 都只是工具调用，没有独立的委派表；这里把工具步骤还原成用户能看懂的任务列表。
   */
  const dispatchItems = useMemo(() => {
    const items: DispatchItem[] = []
    for (const task of botTasks.slice(0, ASSIGNMENT_TASK_SCAN_LIMIT)) {
      for (const step of task.steps) {
        if (step.kind !== 'tool' || !DISPATCH_TOOL_PATTERN.test(step.title)) continue
        const parsed = parseDispatchDetail(step)
        items.push({
          key: `${task.id}:${step.id ?? String(step.at)}`,
          tool: step.title,
          taskTitle: task.title,
          description: parsed.description,
          result: parsed.result,
          status: step.status,
          at: step.at,
          ...(parsed.botId !== '' ? { botId: parsed.botId } : {}),
        })
      }
    }
    return items.sort((a, b) => b.at - a.at).slice(0, ASSIGNMENT_PANEL_LIMIT)
  }, [botTasks])

  /** assignments 端点返回的该 Bot 相关委派（新→旧；任务与委派面板的数据源）。 */
  const relatedAssignments = useMemo(() => {
    return (state.assignmentsByBot?.[activeBot.id] ?? [])
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [state.assignmentsByBot, activeBot.id])

  /** 其他 Bot 派给当前 Bot 的活（面板补充区）。 */
  const incomingAssignments = useMemo(() => {
    return relatedAssignments.filter((item) => item.assigneeBotId === activeBot.id)
  }, [relatedAssignments])

  useEffect(() => {
    if (!moreOpen) return undefined
    const close = (event: MouseEvent): void => {
      if (moreRef.current !== null && event.target instanceof Node && moreRef.current.contains(event.target)) return
      closeMenu()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [moreOpen, closeMenu])

  /* Esc 逐层关闭：任务/历史面板、确认卡优先，其次收起「更多」菜单；都走同一个退场。 */
  useEffect(() => {
    if (!moreOpen && clearTarget === null && !historyOpen && !assignmentsOpen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      // 被下层控件（例如 PaSelect 的 Esc）先处理过的事件不再重复响应。
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (assignmentsOpen) closeAssignments()
      else if (historyOpen) closeHistory()
      else if (clearTarget !== null) closeConfirm()
      else closeMenu()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [moreOpen, clearTarget, historyOpen, assignmentsOpen, closeMenu, closeConfirm, closeHistory, closeAssignments])

  /*
   * 上下文接力提示的探测时机：**每轮结束**（最后一条是 bot 消息、没有 pending 占位、
   * 且是单聊）。防抖 800ms 避开流式收尾的连续 messages 更新；3 分钟节流避免每轮都
   * 打一次接口。请求失败静默——提示条是锦上添花，不能因此打断聊天。
   *
   * 判定本身在 relay-trigger.ts（纯逻辑）：hard / soft / idle 三档，mode='off' 不探测。
   * mode='auto'（默认）命中后**自动执行**「整理并开新会话」：生成摘要 → 切换模型
   * 上下文（keepMessages，聊天记录一条不删）→ 继续聊，用户不需要点任何按钮。
   * 只有自动整理失败时才退化成输入框上方的提示条，让用户手动处理。
   */
  useEffect(() => {
    if (activeRoom !== null) {
      setRelayHint(null)
      return undefined
    }
    const last = activeMessages.length > 0 ? activeMessages[activeMessages.length - 1] : undefined
    const hasPending = activeMessages.some((message) => message.pending === true)
    if (last === undefined || last.role !== 'bot' || hasPending) {
      setRelayHint(null)
      return undefined
    }
    let lastUserAt = 0
    for (const message of activeMessages) {
      if (message.role === 'user') lastUserAt = Math.max(lastUserAt, message.at)
    }
    if (lastUserAt === 0) {
      setRelayHint(null)
      return undefined
    }
    const bot = activeBot
    if (normalizeRelayAuto(bot.relayAuto).mode === 'off') {
      setRelayHint(null)
      return undefined
    }
    const messagesSnapshot = activeMessages
    const handle = window.setTimeout(() => {
      const now = Date.now()
      const previousProbe = relayProbeRef.current
      if (previousProbe.botId === bot.id && now - previousProbe.at < RELAY_PROBE_THROTTLE_MS) return
      relayProbeRef.current = { botId: bot.id, at: now }
      const token = relayProbeTokenRef.current + 1
      relayProbeTokenRef.current = token
      void (async () => {
        try {
          const response = await fetch(`/api/personal-agent/context?botId=${encodeURIComponent(bot.id)}`)
          if (!response.ok) return
          const data = (await response.json()) as {
            ok?: boolean
            usage?: { usedTokens: number; contextWindow: number; percent: number } | null
          }
          // 迟到的结果 / 已经切到别的 Bot：直接丢弃，别把 A 的占用提示挂到 B 上。
          if (token !== relayProbeTokenRef.current) return
          if (activeBotIdRef.current !== bot.id) return
          const trigger = evaluateRelayTrigger({
            usage: data.ok === true ? data.usage ?? null : null,
            lastUserAt,
            now: Date.now(),
            messages: messagesSnapshot,
            settings: bot.relayAuto,
          })
          if (trigger === null) {
            setRelayHint(null)
            return
          }
          /*
           * 自动整理并开新会话（默认行为，用户不手动点）：
           *  1. 生成结构化接力摘要（模型调用，可能十几秒）；
           *  2. clearConversation(keepMessages: true)：只重置宿主模型上下文，
           *     前端聊天记录一条不删，追加系统提示后继续聊。
           * 失败（模型不可用 / 宿主未连接）才退化成提示条，让用户手动决定。
           */
          if (normalizeRelayAuto(bot.relayAuto).mode !== 'off') {
            if (autoRelayRunningRef.current) return
            autoRelayRunningRef.current = true
            try {
              const result = await actionsRef.current.prepareRelay(bot.id)
              if (result !== null) {
                await actionsRef.current.clearConversation(bot.id, {
                  relay: result.brief,
                  keepMessages: true,
                })
                setRelayHint(null)
                return
              }
            } finally {
              autoRelayRunningRef.current = false
            }
          }
          if (relayHintDismissedRef.current.has(`${bot.id}:${relayHintKey(trigger)}`)) return
          setRelayHint(trigger)
        } catch {
          /* 宿主未就绪 / 网络失败：静默，下一轮再试 */
        }
      })()
    }, RELAY_PROBE_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [activeMessages, activeBot, activeRoom])

  const handleCall = (): void => {
    if (ui.call.status !== 'idle') {
      actions.minimizeCall(false)
      return
    }
    actions.startCall(callBotId)
  }

  /** 菜单项点击：等菜单退场播完再执行动作，避免「面板已经换了、菜单还在飞」。 */
  const runMenuAction = (action: () => void): void => {
    closeMenu(action)
  }

  return (
    <>
      {/*
       * 会话头刻意放在对话列（.pa-chat）**外面**：它的下边框要横跨整个主列。
       * 放在 .pa-chat 里时，对话列一旦被拖窄（--pa-chat-w < 100%），边框就跟着缩，
       * 两端与左右侧栏之间露出一截缺口——用户实测点名要它「永远占满」。
       * 头部内容再套一层 .pa-chat__head-inner 按对话列宽度居中，对齐方式保持不变。
       */}
      {/* 会话头在提醒态**不动**（2026-11-07 用户要求「左侧的这个别动」）：
          面板只占中间那一段，与左右两端的头像/名称、按钮组水平方向不重叠。 */}
      <header className="pa-chat__header">
        <div className="pa-chat__head-inner">
        <div className="pa-chat__head-avatar">
          {activeRoom !== null ? (
            roomAvatar !== undefined ? (
              <BotAvatar avatar={roomAvatar} size={28} />
            ) : (
              <div className="pa-chat__stack">
                {roomBots.slice(0, 3).map((bot) => (
                  <BotAvatar key={bot.id} avatar={bot.avatar} size={20} />
                ))}
              </div>
            )
          ) : (
            <BotAvatar avatar={activeBot.avatar} size={28} motionState={activeBot.isMain ? 'idle' : undefined} />
          )}
        </div>
        <div className="pa-chat__head-text">
          <div className="pa-chat__head-name">{title}</div>
          <div className="pa-chat__head-sub">{subtitle}</div>
        </div>
        <div className="pa-chat__head-actions">
          {/*
           * 自动播报开关放在通话按钮左侧：两者都是「这个 Bot 的嘴」，并排成一组。
           * 群聊里组件自己返回 null——自动播报只在单聊生效（见 MessageList）。
           */}
          <AutoSpeakButton />
          <button
            className="pa-chat__head-btn"
            type="button"
            data-on={ui.call.status !== 'idle' ? 'true' : 'false'}
            title={ui.call.status !== 'idle' ? '返回通话' : `呼叫 ${callBot.name}`}
            aria-label={ui.call.status !== 'idle' ? '返回通话' : `呼叫 ${callBot.name}`}
            onClick={handleCall}
          >
            <IconPhoneSolid size={19} />
          </button>
          <button
            className="pa-chat__head-btn"
            type="button"
            title="一键截图（左侧名册 + 右侧会话）"
            aria-label="一键截图"
            onClick={() => setShotOpen(true)}
          >
            <IconCameraSolid size={19} />
          </button>
          {/*
           * 右侧详情栏切换（2026-11-07 从设置面板迁来这里）。
           *
           * 用户原话：「bot 设置的改到对话界面的更多的左侧，并且不是开关，变成切换」。
           *  · 位置：紧贴「更多」左边，与通话 / 截图同为 32px 小方块，不额外加容器；
           *  · 形态：按钮式切换，**不是滑块开关** —— 展开时 data-on 点亮品牌色，
           *    收起时与其它按钮同色，用户一眼能读出「现在开没开」；
           *  · 状态唯一来源：ui.rightPanelOpen。按钮本身不存状态，右栏的显隐、
           *    图标点亮、aria-pressed 永远同一帧变化（状态不撒谎）。
           */}
          <button
            className="pa-chat__head-btn"
            type="button"
            title={ui.rightPanelOpen ? '收起右侧详情栏' : '展开右侧详情栏'}
            aria-label="右侧详情栏"
            aria-pressed={ui.rightPanelOpen}
            data-on={ui.rightPanelOpen ? 'true' : 'false'}
            onClick={() => actions.toggleRightPanel()}
          >
            <IconPanelRightSolid size={19} />
          </button>
          <div className="pa-chat__more" ref={moreRef}>
            <button
              className="pa-chat__head-btn"
              type="button"
              title="更多"
              aria-label="更多"
              aria-expanded={moreOpen}
              onClick={() => {
                // 退场途中再点一次：撤销退场原地弹回，而不是等它消失后再开。
                if (menuClosing) {
                  cancelMenuClose()
                  return
                }
                if (moreOpen) closeMenu()
                else setMoreOpen(true)
              }}
            >
              <IconMoreSolid size={19} />
            </button>
            {moreOpen ? (
              <div className="pa-chat__menu" role="menu" data-closing={menuClosing ? '1' : undefined}>
                {activeRoom !== null ? (
                  <button type="button" role="menuitem" onClick={() => runMenuAction(() => actions.openGroupSettings(activeRoom.id))}>
                    <IconUsers size={14} />
                    群聊设置
                  </button>
                ) : null}
                {/*
                 * Bot 设置只在私聊里给：群聊是群聊，它的设置入口是上面那条
                 * 「群聊设置」；在群聊里再摆一个「Bot 设置」，用户会以为改的是
                 * 整个群（实际只改 callBot 一个成员），点进去还会看到「子 Bot 管理」
                 * 这种只属于单个 Bot 的段落。
                 */}
                {activeRoom === null ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction(() => actions.openBotSettings(callBot.id))}
                  >
                    <IconSettings size={14} />
                    Bot 设置
                  </button>
                ) : null}
                {/*
                 * 历史对话：开新会话时旧消息会归档到 state.archivedSessions，
                 * 这里提供只读回看入口（群聊没有归档概念，只在私聊显示）。
                 */}
                {activeRoom === null ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction(() => {
                      // 每次重新打开都从全部收起开始，避免展开态跨会话残留
                      setExpandedArchiveId(null)
                      setHistoryOpen(true)
                    })}
                  >
                    <IconBook size={14} />
                    历史对话
                  </button>
                ) : null}
                {/*
                 * 任务与委派面板的入口：原先挂在输入框上方的任务进度条已移除，
                 * 面板本身保留（当前任务时间线 / 派出的任务 / 其他 Bot 派来的活），
                 * 改从这里打开。右栏的 TaskRecordCard 是另一张只读卡，与此面板不冲突。
                 */}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runMenuAction(() => {
                    // 打开前补拉一次委派摘要，面板里看到的是最新状态（轮询只在有非终态时跑）
                    void actions.refreshAssignments(activeBot.id)
                    setAssignmentsOpen(true)
                  })}
                >
                  <IconListTodo size={14} />
                  任务与委派
                </button>
                <button type="button" role="menuitem" onClick={() => runMenuAction(() => { void actions.generateJournal(callBotId) })}>
                  <IconBook size={14} />
                  生成今日期刊
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runMenuAction(() => setShotOpen(true))}
                >
                  <IconCamera size={14} />
                  一键截图
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
                      // 每次打开都重置整理状态，避免看到上一次（甚至另一个 Bot）的摘要。
                      relayRequestRef.current += 1
                      setRelay({ status: 'idle' })
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

      <div className="pa-chat" ref={chatCardRef} data-reminding={reminder !== null && !reminderClosing ? 'true' : 'false'}>
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
        {/*
         * 对话卡**最上沿**正中悬浮的 Bot 三态动图（2026-11-07 用户先要求「把右侧
         * 侧边栏的动图也移动到对话，放在对话的正上方中间悬浮」，再要求「把中间这个
         * 动图移动到最上面」——现在 top: 0，顶到卡片内沿顶端、与会话头同一水平线）
         * ——与右栏资料区原来那枚完全同一枚（同一个 avatarState / BotAvatar / 92px 尺寸）。
         *
         * 悬浮层语义：绝对定位、不占布局高度、容器完全透明、pointer-events: none，
         * 消息从它后面穿过。位置与首条消息的让位都在 chat.css.ts 的
         * .pa-chat__mascot / .pa-chat__scroll-inner（--pa-chat-mascot-*）里推导。
         */}
        {/*
         * 空对话不渲染这枚悬浮动图：MessageList 的空态本来就在卡片中央画了同一只
         * Bot 头像（.pa-chat-empty__avatar），两处同时出现会变成两只一样的角色。
         * 判据用 historyMessages（与 MessageList 的 messages.length === 0 同一份数据）。
         */}
        {historyMessages.length > 0 ? (
          <div className="pa-chat__mascot" aria-hidden="true">
            <BotAvatar avatar={activeBot.avatar} size={92} muted={!activeBot.enabled} motionState={avatarState} />
          </div>
        ) : null}
        {/*
         * 提醒带：面板与动图同一条时间线——动图在 [data-reminding] 下往左让，
         * 面板从它右侧 clip 揭示出来（见 chat.css.ts 的「提醒态」段）。
         * 会话头同时淡出让位；处理完一起收回、动图滑回中线。
         */}
        {reminder !== null ? (
          <ReminderBand
            item={reminder}
            shown={reminderShown}
            closing={reminderClosing}
            onAction={(actionId) => { runReminderAction(reminder, actionId) }}
          />
        ) : null}
        {/* 消息流吃完整历史，自己按页懒加载；其它面板继续用 activeMessages 的最近 200 条。 */}
        <MessageList messages={historyMessages} bot={activeBot} room={activeRoom} dispatches={dispatches} />
        <PendingBar messages={activeMessages} />
        {relayHint !== null ? (
          <div className="pa-relay-hint" role="status" data-kind={relayHint.kind}>
            <span className="pa-relay-hint__dot" aria-hidden="true" />
            <div className="pa-relay-hint__body">
              <span className="pa-relay-hint__title">{relayHint.title}</span>
              <span className="pa-relay-hint__detail">{relayHint.detail}</span>
            </div>
            <button
              className="pa-relay-hint__go"
              type="button"
              onClick={() => {
                // 复用第 1 步的「整理并开新会话」确认卡：这里只打开，不自动整理 / 清空。
                relayRequestRef.current += 1
                setRelay({ status: 'idle' })
                setClearTarget(activeBot)
                setRelayHint(null)
              }}
            >
              去整理
            </button>
            <button
              className="pa-relay-hint__close"
              type="button"
              title="关闭提示"
              aria-label="关闭提示"
              onClick={() => {
                // 同一 kind + 百分比档位本次会话不再弹（组件内 state 即可，不落盘）。
                relayHintDismissedRef.current.add(`${activeBot.id}:${relayHintKey(relayHint)}`)
                setRelayHint(null)
              }}
            >
              <IconX size={12} />
            </button>
          </div>
        ) : null}
        <Composer />

      {clearTarget !== null ? (
        <div
          className="pa-overlay"
          data-closing={confirmClosing ? '1' : undefined}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeConfirm()
          }}
        >
          <div className="pa-modal pa-confirm" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pa-modal__head">
              <div className="pa-modal__title">对话管理</div>
              <button className="pa-modal__close" type="button" onClick={() => closeConfirm()} aria-label="关闭">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-modal__body">
              <p className="pa-confirm__lead">
                把与「{clearTarget.name}」的对话整理成接力摘要，然后开启新会话？
              </p>
              <p className="pa-confirm__hint">
                聊天记录会继续留在对话流里，随时可以往上翻阅；只切换模型上下文（摘要会带进新会话，{clearTarget.name} 能接着上次的进度继续做）。选「直接清空」才会删除聊天记录（会先归档到「历史对话」，可找回）。
              </p>
              {relay.status === 'preparing' ? (
                <p className="pa-relay-preview__status">正在整理…（模型生成可能需要十几秒）</p>
              ) : null}
              {relay.status === 'error' ? (
                <p className="pa-relay-preview__error">{relay.message}</p>
              ) : null}
              {relay.status === 'ready' ? (
                <div className="pa-relay-preview">
                  {relayDegraded ? (
                    <p className="pa-relay-preview__degraded">
                      模型不可用，已用最近对话生成简易摘要
                      {relay.status === 'ready' && typeof relay.error === 'string' && relay.error !== ''
                        ? `（${relay.error.slice(0, 120)}）`
                        : ''}
                    </p>
                  ) : null}
                  <RelayPreview brief={relay.brief} />
                </div>
              ) : null}
            </div>
            <div className="pa-modal__foot">
              <button className="pa-btn pa-btn--ghost" type="button" onClick={() => closeConfirm()}>
                取消
              </button>
              <button
                className="pa-btn pa-btn--danger"
                type="button"
                title="清空当前会话并删除聊天记录（会先归档到「历史对话」，可找回）"
                onClick={() => {
                  const target = clearTarget
                  // 「直接清空」不带 relay，走宿主 /reset；但前端 clearConversation 同样先归档，
                  // 历史记录不会丢。清空动作等退场播完再执行：卡片滑出时背景消息同步刷新，不会先闪一下空流。
                  closeConfirm(() => {
                    void actions.clearConversation(target.id)
                  })
                }}
              >
                直接清空
              </button>
              {relayBrief !== null ? (
                <button
                  className="pa-btn pa-btn--primary"
                  type="button"
                  onClick={() => {
                    const target = clearTarget
                    // keepMessages: 只切换模型上下文（宿主落盘摘要 + reset 会话），
                    // 对话流里的聊天记录一条不删，用户继续往上翻。
                    closeConfirm(() => {
                      void actions.clearConversation(target.id, { relay: relayBrief, keepMessages: true })
                    })
                  }}
                >
                  确认并开新会话
                </button>
              ) : (
                <button
                  className="pa-btn pa-btn--primary"
                  type="button"
                  disabled={relay.status === 'preparing'}
                  onClick={handlePrepareRelay}
                >
                  {relay.status === 'preparing' ? '正在整理…' : '整理并开新会话'}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {historyOpen ? (
        <div
          className="pa-overlay"
          data-closing={historyClosing ? '1' : undefined}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeHistory()
          }}
        >
          <div className="pa-modal pa-archive" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pa-modal__head">
              <div className="pa-modal__title">历史对话 · {activeBot.name}</div>
              <button className="pa-modal__close" type="button" onClick={() => closeHistory()} aria-label="关闭">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-modal__body">
              {archivedSessions.length === 0 ? (
                <p className="pa-archive__empty">还没有历史对话。点「直接清空」时，当前对话会归档在这里，可随时找回。</p>
              ) : (
                <ul className="pa-archive__list">
                  {archivedSessions.map((session) => {
                    const expanded = expandedArchiveId === session.id
                    return (
                      <li key={session.id} className="pa-archive__item" data-open={expanded ? '1' : undefined}>
                        <div className="pa-archive__row">
                          <button
                            className="pa-archive__summary"
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setExpandedArchiveId(expanded ? null : session.id)}
                          >
                            <span className="pa-archive__title">{session.title}</span>
                            <span className="pa-archive__meta">
                              {formatArchiveTime(session.archivedAt)} · {session.messageCount} 条消息
                              {session.relay !== undefined ? <span className="pa-archive__badge">含接力摘要</span> : null}
                            </span>
                          </button>
                          <button
                            className="pa-archive__delete"
                            type="button"
                            title="删除这条历史对话"
                            aria-label="删除这条历史对话"
                            onClick={() => {
                              actions.deleteArchivedSession(session.id)
                              actions.toast('已删除历史对话')
                              if (expanded) setExpandedArchiveId(null)
                            }}
                          >
                            <IconTrash size={14} />
                          </button>
                        </div>
                        {expanded ? (
                          <div className="pa-archive__preview">
                            {session.relay !== undefined ? (
                              <div className="pa-archive__relay">
                                <RelayPreview brief={session.relay} />
                              </div>
                            ) : null}
                            <div className="pa-archive__messages">
                              {session.messages.map((message) => (
                                <ArchiveMessage key={message.id} message={message} />
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {assignmentsOpen ? (
        <div
          className="pa-overlay"
          data-closing={assignmentsClosing ? '1' : undefined}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAssignments()
          }}
        >
          <div className="pa-modal pa-assign" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pa-modal__head">
              <div className="pa-modal__title">任务与委派 · {activeBot.name}</div>
              <button className="pa-modal__close" type="button" onClick={() => closeAssignments()} aria-label="关闭">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-modal__body">
              {panelTask === undefined && dispatchItems.length === 0 && relatedAssignments.length === 0 ? (
                <p className="pa-assign__empty">还没有任务与委派记录。Bot 执行任务或派出子任务时，会在这里显示。</p>
              ) : (
                <>
                  {panelTask !== undefined ? (
                    <section className="pa-assign__section">
                      <div className="pa-assign__section-title">
                        {panelTask.status === 'running' ? '当前任务' : '最近任务'} · {panelTask.title}
                      </div>
                      <div className="pa-assign__timeline">
                        {panelTask.steps.slice(-20).map((step, index) => (
                          <div className="pa-assign__step" key={step.id ?? `${step.kind}-${String(index)}`}>
                            <span className="pa-assign__dot" data-status={step.status ?? 'neutral'} aria-hidden="true" />
                            <span className="pa-assign__step-title">{stepActionLabel(step)}</span>
                            {step.status !== undefined ? (
                              <span className="pa-assign__step-status">{stepStatusLabel(step.status)}</span>
                            ) : null}
                            <span className="pa-assign__step-time">{formatStepClock(step.at)}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {dispatchItems.length > 0 ? (
                    <section className="pa-assign__section">
                      <div className="pa-assign__section-title">派出的任务</div>
                      <div className="pa-assign__list">
                        {dispatchItems.map((item) => {
                          const targetBotId = item.botId
                          return (
                            <div className="pa-assign__item" key={item.key}>
                              <div className="pa-assign__row">
                                <span className="pa-assign__tool">{toolActionLabel(item.tool)}</span>
                                <span className="pa-assign__status" data-status={item.status ?? 'neutral'}>
                                  {stepStatusLabel(item.status) || '—'}
                                </span>
                              </div>
                              <div className="pa-assign__brief">
                                {item.description !== '' ? `派给：${truncateText(item.description, 60)}` : `派给：${toolActionLabel(item.tool)}`}
                              </div>
                              {item.result !== '' ? <div className="pa-assign__result">{truncateText(item.result, 200)}</div> : null}
                              {targetBotId !== undefined && targetBotId !== '' && targetBotId !== activeBot.id ? (
                                <button
                                  className="pa-assign__open"
                                  type="button"
                                  onClick={() => {
                                    actions.selectBot(targetBotId)
                                    closeAssignments()
                                  }}
                                >
                                  打开会话
                                </button>
                              ) : null}
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  ) : null}
                  {incomingAssignments.length > 0 ? (
                    <section className="pa-assign__section">
                      <div className="pa-assign__section-title">其他 Bot 派来的活</div>
                      <div className="pa-assign__list">
                        {incomingAssignments.slice(0, ASSIGNMENT_PANEL_LIMIT).map((item) => (
                          <div className="pa-assign__item" key={item.id}>
                            <div className="pa-assign__row">
                              <span className="pa-assign__direction">来自 {item.requesterName !== '' ? item.requesterName : item.requesterBotId}</span>
                              <span className="pa-assign__status" data-status={item.status}>{assignmentStatusLabel(item.status)}</span>
                            </div>
                            <div className="pa-assign__brief">
                              {item.brief !== '' ? truncateText(item.brief, 60) : '（无说明）'}
                            </div>
                            <div className="pa-assign__meta">{formatAssignmentMeta(item)}</div>
                            {item.result !== undefined && item.result !== '' ? (
                              <div className="pa-assign__result">{truncateText(item.result, 200)}</div>
                            ) : null}
                            {item.requesterBotId !== '' && item.requesterBotId !== activeBot.id ? (
                              <button
                                className="pa-assign__open"
                                type="button"
                                onClick={() => {
                                  actions.selectBot(item.requesterBotId)
                                  closeAssignments()
                                }}
                              >
                                打开会话
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
      <PaShotModal open={shotOpen} onClose={() => setShotOpen(false)} />
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

/* ───────────────────────── 接力摘要预览 ───────────────────────── */

/**
 * 「整理并开新会话」确认卡里的摘要预览。
 *
 * 只展示有内容的字段，每个列表最多 5 条——卡片宽度有限，完整摘要已经由宿主落盘，
 * 这里的作用是让用户在清空前**确认它整理对了**，不是阅读器。
 */
function RelayPreview({ brief }: { brief: RelayBrief }): JSX.Element | null {
  const groups: Array<{ key: string; label: string; items: string[] }> = [
    { key: 'done', label: '已完成', items: brief.done },
    { key: 'decisions', label: '关键决策与约束', items: brief.decisions },
    { key: 'pending', label: '未完成', items: brief.pending },
    { key: 'next', label: '下一步', items: brief.next },
    { key: 'files', label: '相关文件', items: brief.files },
  ]
  const visible = groups
    .map((group) => ({ ...group, items: group.items.slice(0, 5) }))
    .filter((group) => group.items.length > 0)
  if (brief.goal === '' && visible.length === 0) return null
  return (
    <>
      {brief.goal !== '' ? (
        <div className="pa-relay-preview__group">
          <div className="pa-relay-preview__label">目标</div>
          <div className="pa-relay-preview__goal">{brief.goal}</div>
        </div>
      ) : null}
      {visible.map((group) => (
        <div key={group.key} className="pa-relay-preview__group">
          <div className="pa-relay-preview__label">{group.label}</div>
          <ul className="pa-relay-preview__list">
            {group.items.map((item, index) => (
              <li key={group.key + '-' + String(index)}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

/* ───────────────────────── 历史对话只读预览 ───────────────────────── */

/**
 * 历史对话面板里的一条只读消息。
 *
 * 只复用聊天气泡的左右布局与配色（user 右 / bot 左 / system 居中），不挂
 * 撤回、引用、待办等交互——归档是回看场景，不是可以继续操作的会话。
 */
function ArchiveMessage({ message }: { message: Message }): JSX.Element | null {
  const text = blocksToText(message.blocks).trim()
  if (text === '') return null
  if (message.role === 'system') return <div className="pa-archive__system">{text}</div>
  const side = message.role === 'user' ? 'user' : 'bot'
  return (
    <div className={`pa-msg pa-msg--${side} pa-archive__msg`}>
      <div className="pa-msg__content">
        <div className="pa-msg__body pa-msg__body--tight">
          <div className={`pa-bubble pa-bubble--${side}`}>{text}</div>
        </div>
      </div>
    </div>
  )
}

/** 历史对话列表里的归档时间（本地时区，精确到分钟）。 */
function formatArchiveTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* ───────────────────────── 任务与委派辅助 ───────────────────────── */

/** 工具名 → 中文动作（未收录的原样返回）。 */
function toolActionLabel(name: string): string {
  return TOOL_ACTION_LABELS[name.toLowerCase()] ?? name
}

/** 任务步骤 → 人类可读的动作标题（工具名做中文映射，过程文字原样）。 */
function stepActionLabel(step: TaskRecordStep): string {
  return step.kind === 'tool' ? toolActionLabel(step.title) : step.title
}

/** 步骤状态 → 中文（无状态 = 空串，时间线上不显示状态 pill）。 */
function stepStatusLabel(status?: 'running' | 'ok' | 'error'): string {
  if (status === 'running') return '进行中'
  if (status === 'error') return '失败'
  if (status === 'ok') return '完成'
  return ''
}

/** 委派状态 → 中文（与状态徽标的配色档位一一对应）。 */
function assignmentStatusLabel(status: AssignmentView['status']): string {
  switch (status) {
    case 'queued': return '排队'
    case 'running': return '进行中'
    case 'needs_input': return '等输入'
    case 'waiting': return '等待子活'
    case 'resume': return '待继续'
    case 'completed': return '完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    default: return status
  }
}

/** 截断一段展示文本（压平空白、保留可读前缀）。 */
function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 把秒数写成「N 秒 / N 分 M 秒」。 */
function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${String(minutes)} 分` : `${String(minutes)} 分 ${String(rest)} 秒`
}

/** 步骤时间（本地时区，精确到秒）。 */
function formatStepClock(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 委派面板里的耗时或创建时间。 */
function formatAssignmentMeta(item: AssignmentView): string {
  if (item.finishedAt !== undefined && item.createdAt > 0) {
    const seconds = Math.max(0, Math.round((item.finishedAt - item.createdAt) / 1000))
    return `耗时 ${formatElapsedSeconds(seconds)}`
  }
  return formatArchiveTime(item.createdAt)
}

/**
 * 从 TaskRecordStep.detail 里尽量解析派活参数。
 *
 * detail 是宿主截断到 220 字的 args / result：可能是 JSON（subagent 的 prompt /
 * description、coordinate_bots 的 bot_id），也可能已经是纯文本结果。能解析就取
 * 人读字段，解析不了就把原文当结果摘要。
 */
function parseDispatchDetail(step: TaskRecordStep): { description: string; result: string; botId: string } {
  const raw = step.detail?.trim() ?? ''
  if (raw === '') return { description: '', result: '', botId: '' }
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(raw) as unknown
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
  } catch {
    /* detail 被截断 / 不是 JSON：退回原文展示 */
  }
  const pickString = (...keys: string[]): string => {
    if (parsed === null) return ''
    for (const key of keys) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return ''
  }
  const description = pickString('description', 'prompt', 'message')
  const botId = pickString('bot_id', 'botId', 'assignee_bot_id', 'assigneeBotId')
  const explicitResult = pickString('result', 'output', 'summary')
  // 解析成功但没 result 字段时，不把 args JSON 当结果展示（那是参数不是结果）
  const result = explicitResult !== '' ? explicitResult : (parsed === null && step.status !== 'running' ? raw : '')
  return { description, result, botId }
}
