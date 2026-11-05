/**
 * Personal Agent — Bot 设置卡（右侧滑出）。
 *
 * 入口：Sidebar 的 Bot 行「...」菜单、ChatPanel 的「更多」菜单，都只调用
 * `actions.openBotSettings(botId)`；本组件读 `ui.botSettingsOpen` 自己决定开不开，
 * 所以任何地方都不需要再维护一份「设置弹窗开没开」的局部状态。
 *
 * 结构：遮罩 `.pa-sheet-overlay` + 右贴边全高容器 `.pa-sheet`（样式见 settings.css.ts）。
 * 分区依次是：基本资料 / 模型 / 语音通话 / 工具权限 / 主动询问 / 例行任务 /
 * 上下文接力 / 子 Bot 管理（仅主 Bot）/ 记忆 / 产出物文件夹。
 *
 * 保存口径：
 *  · 基本资料（名称、角色、简介、行为约定）走「保存资料」按钮——一次提交四个字段，
 *    避免每敲一个字就写一次 localStorage；
 *  · 其余开关 / 下拉 / 权限档位都是即改即存（`actions.updateBot`），下一轮对话生效；
 *  · 记忆与产出物是宿主侧数据，直接走 HTTP 接口，不写本地 state。
 *    「记忆」分区顶部那一行「记忆检索刷新间隔」也是宿主配置：它是记忆引擎的
 *    运行时旋钮（`retrievalRefreshTurns`，存在宿主 config.json），走
 *    `GET/POST /api/dsh-memory/config`，改完即时生效、跨 Bot 共用。
 *
 * 迁移来源：`RightPanel.tsx` 旧「详情 / 资料库」tab 里的模型、音色、供应商、权限、
 * 主动询问、例行任务、子 Bot 管理、记忆；视觉从居中弹窗改成右侧滑出卡片。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { BotAvatar } from '../Avatar.tsx'
import {
  IconClock,
  IconCpu,
  IconEdit,
  IconFolder,
  IconMemory,
  IconMessage,
  IconPause,
  IconPhone,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconTerminal,
  IconTrash,
  IconUsers,
  IconX,
} from '../icons.tsx'
import { AvatarPicker } from '../shared/AvatarPicker.tsx'
import { ModelPicker } from '../shared/ModelPicker.tsx'
import { PaSelect, type PaSelectOption } from '../shared/PaSelect.tsx'
import { useModelGroups } from '../shared/useModelGroups.ts'
import { useLiveVendors, usePersonal } from '../store.tsx'
import {
  formatClock,
  liveVendorOptions,
  voiceLabel,
  type Bot,
  type BotPermission,
  type MemoryEntry,
  type RelayAuto,
  type RoutineSchedule,
} from '../types.ts'
import { normalizeRelayAuto } from '../relay-trigger.ts'
import { REALTIME_DEFAULT_VOICE, REALTIME_VOICES } from '../../../shared/realtime-protocol.ts'
import { createMemoryApi, type MemoryEntryView } from '../../triad/memory/api.ts'

/** 产出物接口的本地视图（只关心根路径与错误）。 */
interface OutputsState {
  loading: boolean
  root: string | null
  error: string | null
}

/**
 * 音色选项。
 *
 * 首项把「跟随全局默认」后面挂上当前内置默认音色名，用户不用去设置里翻
 * 才知道默认是哪把嗓子；`hint` 显示在选项右侧（适用场景）。
 */
const VOICE_OPTIONS: PaSelectOption[] = [
  { value: '', label: `跟随全局默认（${voiceLabel(REALTIME_DEFAULT_VOICE)}）` },
  ...REALTIME_VOICES.map((item) => ({ value: item.id, label: item.label, hint: item.hint })),
]

/** 上下文接力方式（默认「自动整理」）。 */
const RELAY_MODE_OPTIONS: PaSelectOption[] = [
  { value: 'off', label: '关闭' },
  { value: 'auto', label: '自动整理', hint: '默认' },
]

function relayModeLabel(mode: RelayAuto['mode']): string {
  return mode === 'off' ? '已关闭' : '自动整理'
}

/**
 * 设置卡的分类页签。
 *
 * 9 个分区一列排下来要滚好几屏：想改「记忆检索间隔」得先翻过语音、权限、
 * 例行任务。改成左侧导航 + 右侧面板后，每一屏只放一件事。
 *
 * `mainOnly` 的页（团队 / 子 Bot 管理）只有主 Bot 有——子 Bot 打开自己的
 * 设置卡时，这一项既不该出现，也不该留下一个永远点不进去的空页。
 */
type BotTabId =
  | 'profile'
  | 'model'
  | 'voice'
  | 'permission'
  | 'automation'
  | 'team'
  | 'memory'
  | 'outputs'

interface BotTab {
  id: BotTabId
  label: string
  icon: ReactNode
  mainOnly?: boolean
}

const BOT_TABS: BotTab[] = [
  { id: 'profile', label: '资料', icon: <IconSparkles size={14} /> },
  { id: 'model', label: '模型', icon: <IconCpu size={14} /> },
  { id: 'voice', label: '语音', icon: <IconPhone size={14} /> },
  { id: 'permission', label: '权限', icon: <IconTerminal size={14} /> },
  { id: 'automation', label: '自动化', icon: <IconClock size={14} /> },
  { id: 'team', label: '团队', icon: <IconUsers size={14} />, mainOnly: true },
  { id: 'memory', label: '记忆', icon: <IconMemory size={14} /> },
  { id: 'outputs', label: '产出', icon: <IconFolder size={14} /> },
]

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']

/** 权限档位的中文名（旧数据没有该字段时按完全权限显示）。 */
function permissionLabel(permission: BotPermission | undefined): string {
  return permission === 'approval' ? '审批模式' : '完全权限'
}

/** 引擎条目 → 面板展示形状（与旧 RightPanel 同一层映射）。 */
function toDisplayMemory(entry: MemoryEntryView): MemoryEntry {
  const owner = entry.owner ?? 'work'
  return {
    id: entry.id,
    botId: owner.startsWith('bot:') ? owner.slice(4) : '',
    text: entry.content,
    tags: entry.tags,
    createdAt: Date.parse(entry.createdAt) || Date.now(),
  }
}

/** 例行任务频率的中文展示。 */
function routineFrequency(schedule: RoutineSchedule): string {
  if (schedule.kind === 'interval') {
    if (schedule.everyMinutes % 60 === 0) return `每 ${schedule.everyMinutes / 60} 小时`
    return `每 ${schedule.everyMinutes} 分钟`
  }
  if (schedule.kind === 'daily') return `每天 ${schedule.time}`
  if (schedule.kind === 'weekly') {
    const days = schedule.weekdays.map((day) => WEEK_LABELS[day % 7]).join('、')
    return `每周${days} ${schedule.time}`
  }
  return `一次性 · ${formatClock(schedule.at)}`
}

/** 下次执行时间：今天 / 明天 / 月-日 + 时分。 */
function formatNextAt(at?: number): string {
  if (at === undefined) return '未安排'
  const target = new Date(at)
  const now = new Date()
  const sameDay = target.getFullYear() === now.getFullYear()
    && target.getMonth() === now.getMonth()
    && target.getDate() === now.getDate()
  if (sameDay) return `今天 ${formatClock(at)}`
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const isTomorrow = target.getFullYear() === tomorrow.getFullYear()
    && target.getMonth() === tomorrow.getMonth()
    && target.getDate() === tomorrow.getDate()
  if (isTomorrow) return `明天 ${formatClock(at)}`
  return `${target.getMonth() + 1}-${target.getDate()} ${formatClock(at)}`
}

/** 记忆时间的相对展示。 */
function relativeTime(at: number): string {
  const diff = Date.now() - at
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 48 * 60 * minute) return '昨天'
  return `${Math.floor(diff / (24 * 60 * minute))} 天前`
}

/** 卡内分区：图标 + 标题 + 右侧小字 + 内容。 */
function SheetSection(props: {
  icon: ReactNode
  title: string
  extra?: string
  children: ReactNode
}): JSX.Element {
  const { icon, title, extra, children } = props
  return (
    <section className="pa-sheet-sec">
      <div className="pa-sheet-sec__head">
        <span className="pa-sheet-sec__icon">{icon}</span>
        <span className="pa-sheet-sec__title">{title}</span>
        {extra !== undefined && extra !== '' ? <span className="pa-sheet-sec__extra">{extra}</span> : null}
      </div>
      {children}
    </section>
  )
}

/**
 * 「上下文接力」设置块。
 *
 * 四个字段即改即存（走 actions.updateBot）。数字输入和记忆刷新间隔同一套草稿口径：
 * 失焦 / 回车才提交，避免「删空重打」的中间态写进配置；越界值按
 * normalizeRelayAuto 的规则钳制（5%–95% / 1–72 小时）。
 *
 * 「自动整理」是系统行为：命中阈值时自动生成接力摘要并切换模型上下文，聊天记录
 * 继续留在对话流里；用户不需要点任何确认按钮。只有选「关闭」才完全停用。
 */
function RelayAutoSettings({ bot }: { bot: Bot }): JSX.Element {
  const { actions } = usePersonal()
  const current = normalizeRelayAuto(bot.relayAuto)
  const [softDraft, setSoftDraft] = useState(() => String(Math.round(current.softRatio * 100)))
  const [hardDraft, setHardDraft] = useState(() => String(Math.round(current.hardRatio * 100)))
  const [idleDraft, setIdleDraft] = useState(() => String(Math.round(current.idleHours)))

  /* 外部改了 bot.relayAuto（另一个窗口 / 另一处设置）时，回填草稿。 */
  useEffect(() => {
    const next = normalizeRelayAuto(bot.relayAuto)
    setSoftDraft(String(Math.round(next.softRatio * 100)))
    setHardDraft(String(Math.round(next.hardRatio * 100)))
    setIdleDraft(String(Math.round(next.idleHours)))
  }, [bot.id, bot.relayAuto])

  const apply = (patch: Partial<RelayAuto>): void => {
    actions.updateBot(bot.id, { relayAuto: { ...normalizeRelayAuto(bot.relayAuto), ...patch } })
  }

  const commitRatio = (key: 'softRatio' | 'hardRatio', raw: string): void => {
    const parsed = Number(raw)
    const fallback = normalizeRelayAuto(bot.relayAuto)
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      if (key === 'softRatio') setSoftDraft(String(Math.round(fallback.softRatio * 100)))
      else setHardDraft(String(Math.round(fallback.hardRatio * 100)))
      return
    }
    const ratio = Math.min(0.95, Math.max(0.05, parsed / 100))
    if (key === 'softRatio') {
      setSoftDraft(String(Math.round(ratio * 100)))
      apply({ softRatio: ratio })
    } else {
      setHardDraft(String(Math.round(ratio * 100)))
      apply({ hardRatio: ratio })
    }
  }

  const commitIdle = (raw: string): void => {
    const parsed = Number(raw)
    const fallback = normalizeRelayAuto(bot.relayAuto)
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      setIdleDraft(String(Math.round(fallback.idleHours)))
      return
    }
    const hours = Math.min(72, Math.max(1, Math.round(parsed)))
    setIdleDraft(String(hours))
    apply({ idleHours: hours })
  }

  return (
    <SheetSection icon={<IconRefresh size={13} />} title="上下文接力" extra={relayModeLabel(current.mode)}>
      <div className="pa-bset-row">
        <div className="pa-bset-row__main">
          <b>接力方式</b>
          <span>上下文占用偏高、隔太久或像换了话题时，自动整理上一段并切换新会话（聊天记录保留）</span>
        </div>
        <PaSelect
          className="pa-select--compact"
          value={current.mode}
          options={RELAY_MODE_OPTIONS}
          ariaLabel="上下文接力提示方式"
          onChange={(next) => {
            if (next === 'off' || next === 'auto') apply({ mode: next })
          }}
        />
      </div>
      <div className="pa-bset-row">
        <div className="pa-bset-row__main">
          <b>软阈值</b>
          <span>占用达到该比例且看起来换了话题时自动整理</span>
        </div>
        <label className="pa-bset-num">
          <input
            type="number"
            inputMode="numeric"
            min={5}
            max={95}
            step={5}
            value={softDraft}
            aria-label="上下文接力软阈值（百分比）"
            onChange={(event) => setSoftDraft(event.target.value)}
            onBlur={(event) => commitRatio('softRatio', event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRatio('softRatio', event.currentTarget.value)
              }
            }}
          />
          <span className="pa-bset-num__unit">%</span>
        </label>
      </div>
      <div className="pa-bset-row">
        <div className="pa-bset-row__main">
          <b>硬阈值</b>
          <span>占用达到该比例就直接自动整理，不再判断话题</span>
        </div>
        <label className="pa-bset-num">
          <input
            type="number"
            inputMode="numeric"
            min={5}
            max={95}
            step={5}
            value={hardDraft}
            aria-label="上下文接力硬阈值（百分比）"
            onChange={(event) => setHardDraft(event.target.value)}
            onBlur={(event) => commitRatio('hardRatio', event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRatio('hardRatio', event.currentTarget.value)
              }
            }}
          />
          <span className="pa-bset-num__unit">%</span>
        </label>
      </div>
      <div className="pa-bset-row">
        <div className="pa-bset-row__main">
          <b>空闲小时数</b>
          <span>隔这么久没说话且上下文仍有占用时自动整理</span>
        </div>
        <label className="pa-bset-num">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={72}
            step={1}
            value={idleDraft}
            aria-label="上下文接力空闲小时数"
            onChange={(event) => setIdleDraft(event.target.value)}
            onBlur={(event) => commitIdle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitIdle(event.currentTarget.value)
              }
            }}
          />
          <span className="pa-bset-num__unit">小时</span>
        </label>
      </div>
      <p className="pa-sheet-hint">
        自动整理由系统在命中阈值时执行：生成接力摘要并切换模型上下文，聊天记录继续留在对话流里，不需要手动确认；只有自动整理失败时才会出现提示条让你手动处理。
      </p>
    </SheetSection>
  )
}

export function BotSettingsCard(): JSX.Element | null {
  const { state, ui, actions } = usePersonal()
  const botId = ui.botSettingsOpen
  const bot = botId !== null ? state.bots.find((item) => item.id === botId) ?? null : null

  /*
   * 退场状态：关闭时先播 240ms 退场（遮罩淡出 + 卡片下沉 14px 并缩到 0.97），
   * 播完才真正 actions.openBotSettings(null) 卸载。直接置 null 的话卡片会硬
   * 消失，和入场那 180ms 的弹入完全不对称。
   *
   * 时长与曲线跟 src/client/modal-animation.ts 的 MODAL_ANIM_MS 对齐
   * （240ms / cubic-bezier(0.4, 0, 0.2, 1)），整套插件才是同一套手感；
   * 具体关键帧在 settings.css.ts 的 .pa-sheet-overlay[data-closing='1'] 里。
   */
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)

  /*
   * 当前页签（左侧导航选中哪一页，右侧就只渲染那一页）。
   *
   * 不写进 localStorage：设置卡是「打开 → 改一件事 → 关掉」的短任务，
   * 每次都从「资料」开始更符合预期；记住上次停在「记忆」反而让人每次
   * 打开都要先找一下资料在哪。
   */
  const [tab, setTab] = useState<BotTabId>('profile')
  /** 右侧面板的滚动容器：换页签后回到顶部，别让人接着上一页的位置读。 */
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /** 关闭：先播 240ms 退场，再真正卸载（直接置 null 会硬消失）。 */
  const requestClose = useCallback((): void => {
    if (closeTimerRef.current !== null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setClosing(false)
      actions.openBotSettings(null)
    }, 240)
  }, [actions])

  /* 卸载时清计时器：退场播到一半被外部卸载（切 Work / 关插件）时别留悬空回调。 */
  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  /* ── 表单草稿（只有基本资料需要显式保存） ── */
  const [draft, setDraft] = useState({ name: '', role: '', description: '', instructions: '' })
  /* ── 例行任务新建表单（内联展开） ── */
  const [routineOpen, setRoutineOpen] = useState(false)
  const [routineName, setRoutineName] = useState('')
  const [routineInstruction, setRoutineInstruction] = useState('')
  const [routineFreq, setRoutineFreq] = useState<'daily' | 'interval' | 'weekly'>('daily')
  const [routineTime, setRoutineTime] = useState('09:00')
  /* ── 子 Bot 管理的行内编辑 / 删除确认 ── */
  const [editingSub, setEditingSub] = useState<{ id: string; name: string } | null>(null)
  const [deleteBotId, setDeleteBotId] = useState<string | null>(null)
  /* ── 记忆 ── */
  const [memoryQuery, setMemoryQuery] = useState('')
  const [memoryFilter, setMemoryFilter] = useState<string | null>(null)
  const [newMemory, setNewMemory] = useState('')
  const [engineMemories, setEngineMemories] = useState<MemoryEntryView[]>([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  /*
   * 记忆检索刷新间隔（`retrievalRefreshTurns`，单位「轮」）。
   *
   * 这是宿主记忆引擎的**运行时配置**，不是 Bot 自己的字段：存在宿主
   * `config.json` 里，通过 `GET/POST /api/dsh-memory/config` 读写。因此这里
   * 不写 localStorage、也不进 `state`——面板只是它的一扇窗。
   *
   * `null` = 还没读到（host 未就绪 / 首次加载）。此时输入框留空并显示占位
   * 「默认 5」：宁可显示「不知道当前值」，也不拿默认值冒充用户配置。
   */
  const [refreshTurns, setRefreshTurns] = useState<number | null>(null)
  const [refreshDraft, setRefreshDraft] = useState('')
  const [refreshSaving, setRefreshSaving] = useState(false)
  /* ── 产出物文件夹 ── */
  const [outputs, setOutputs] = useState<OutputsState>({ loading: false, root: null, error: null })

  /*
   * 记忆引擎客户端。与旧 RightPanel 一样：面板只是宿主记忆引擎的视图，
   * 不读 localStorage 的 `state.memories`（两套库各存一份会互相打架）。
   */
  const memoryApi = useMemo(() => createMemoryApi(), [])
  /* Live 供应商列表：宿主配置，打开设置卡时拉一次；读不到就降级为置灰下拉。 */
  const liveVendors = useLiveVendors(bot !== null)
  /* 宿主可用模型（供应商 → 模型）：打开设置卡时拉一次，读不到就显示空态。 */
  const modelGroupsState = useModelGroups(bot !== null)
  const modelGroups = modelGroupsState.groups
  const liveVendorChoices = useMemo(
    () => liveVendorOptions(liveVendors.vendors, bot?.liveVendor, liveVendors.defaultVendor),
    [liveVendors.vendors, liveVendors.defaultVendor, bot?.liveVendor],
  )
  const sortedGroups = useMemo(
    () => [...state.groups].sort((a, b) => a.order - b.order),
    [state.groups],
  )
  const routines = bot !== null ? state.routines.filter((routine) => routine.botId === bot.id) : []
  const subBots = state.bots.filter((item) => !item.isMain)
  /*
   * 记忆的归属范围（与旧 RightPanel 一致）：
   *   - 子 Bot 只看自己的；
   *   - 主 Bot 默认看全部子 Bot（`bots` 聚合），可切到「Work 全局」。
   */
  const memoryOwner = bot !== null && bot.isMain
    ? (memoryFilter === 'work' ? 'work' : 'bots')
    : `bot:${bot?.id ?? ''}`

  /* 切换 Bot 时回填草稿、收起上一台 Bot 的临时表单与确认态。 */
  useEffect(() => {
    if (botId === null) return
    const target = state.bots.find((item) => item.id === botId)
    if (target === undefined) return
    setDraft({
      name: target.name,
      role: target.role,
      description: target.description,
      instructions: target.instructions,
    })
    setRoutineOpen(false)
    setRoutineName('')
    setRoutineInstruction('')
    setRoutineFreq('daily')
    setRoutineTime('09:00')
    setEditingSub(null)
    setDeleteBotId(null)
    setMemoryQuery('')
    setMemoryFilter(null)
    setNewMemory('')
    // 换一台 Bot 就回到第一页：上一台停在「记忆」不该带到这一台。
    setTab('profile')
  }, [botId])

  /* 拉产出物根目录（只取 root；文件列表由右栏 BotOutputsCard 负责）。 */
  useEffect(() => {
    if (botId === null) return undefined
    const target = state.bots.find((item) => item.id === botId)
    if (target === undefined) return undefined
    let alive = true
    setOutputs({ loading: true, root: null, error: null })
    void (async () => {
      try {
        const query = new URLSearchParams({ botId: target.id })
        if (target.name !== '') query.set('name', target.name)
        const res = await fetch(`/api/personal-agent/outputs?${query.toString()}`)
        const data = (await res.json()) as { ok?: boolean; root?: string; error?: string }
        if (!alive) return
        if (data.ok === true && typeof data.root === 'string' && data.root !== '') {
          setOutputs({ loading: false, root: data.root, error: null })
        } else {
          setOutputs({ loading: false, root: null, error: data.error ?? '还没有产出物文件夹' })
        }
      } catch (error) {
        if (!alive) return
        // 网络层失败（宿主未连接 / 路由未挂载）与「目录不存在」分开说，别把
        // `Failed to fetch` 这种浏览器原文直接糊到界面上。
        setOutputs({
          loading: false,
          root: null,
          error: `读不到产出物文件夹（宿主未连接或接口暂不可用：${error instanceof Error ? error.message : String(error)}）`,
        })
      }
    })()
    return () => { alive = false }
  }, [botId])

  const reloadMemories = useCallback(async (): Promise<void> => {
    if (botId === null) return
    setMemoryLoading(true)
    try {
      const response = await memoryApi.list(
        memoryOwner === 'work' ? { owner: 'work', scope: 'global' } : { owner: memoryOwner },
      )
      setEngineMemories(response.entries)
    } catch {
      // 引擎不可用（宿主没起来 / 路由没挂）时留空，不阻塞设置卡其余部分。
      setEngineMemories([])
    } finally {
      setMemoryLoading(false)
    }
  }, [botId, memoryApi, memoryOwner])

  useEffect(() => { void reloadMemories() }, [reloadMemories])

  /*
   * 读记忆引擎的运行时配置（只取检索刷新间隔）。
   *
   * 为什么单独一个 effect、不并进 reloadMemories：那一条按 Bot 归属重拉，
   * 而配置是**全局单值**（不分 Bot），打开设置卡拉一次就够。
   * 读不到（host 未就绪 / 路由没挂）时保持 null：输入框留空、占位「默认 5」，
   * 不拿默认值冒充用户已经配置过的值。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await fetch('/api/dsh-memory/config', { cache: 'no-store' })
        if (!response.ok) return
        const data = (await response.json()) as { config?: { retrievalRefreshTurns?: unknown } }
        const value = data.config?.retrievalRefreshTurns
        if (!alive || typeof value !== 'number' || !Number.isFinite(value)) return
        setRefreshTurns(value)
        setRefreshDraft(String(value))
      } catch {
        /* host 未就绪：保持空，界面显示「默认 5」而不是编一个值 */
      }
    })()
    return () => { alive = false }
  }, [])

  /**
   * 提交检索刷新间隔。
   *
   * 值域按产品口径收窄到 1–50（host 侧 `CONFIG_NUMBER_BOUNDS` 上限是 100）：
   * 超过 50 轮基本等于「这一辈子不刷新」，留着只会让人误以为改大了更省。
   * 失败回滚草稿并 toast——写没写进去必须让人知道，不能假装成功。
   */
  const commitRefreshTurns = (): void => {
    const parsed = Number(refreshDraft)
    if (refreshDraft.trim() === '' || !Number.isFinite(parsed)) {
      setRefreshDraft(refreshTurns === null ? '' : String(refreshTurns))
      return
    }
    const next = Math.min(50, Math.max(1, Math.round(parsed)))
    setRefreshDraft(String(next))
    if (next === refreshTurns) return
    setRefreshSaving(true)
    void fetch('/api/dsh-memory/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retrievalRefreshTurns: next }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = (await response.json()) as { config?: { retrievalRefreshTurns?: unknown } }
        const saved = data.config?.retrievalRefreshTurns
        // host 会把值钳制到自己的合法域，以它回传的为准
        if (typeof saved === 'number' && Number.isFinite(saved)) {
          setRefreshTurns(saved)
          setRefreshDraft(String(saved))
          return
        }
        setRefreshTurns(next)
      })
      .catch(() => {
        actions.toast('记忆设置保存失败')
        setRefreshDraft(refreshTurns === null ? '' : String(refreshTurns))
      })
      .finally(() => { setRefreshSaving(false) })
  }

  /* Esc 关闭；PaSelect 自己已经处理过 Esc 时会 preventDefault，这里跳过。 */
  useEffect(() => {
    if (botId === null) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      // 走 requestClose 而不是直接置 null：Esc 也要播完退场再卸载。
      if (event.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [botId, requestClose])

  /*
   * Bot 被删除后 `ui.botSettingsOpen` 会残留一个不存在的 id。
   * 组件这时 return null 不渲染，但 store 里仍是非 null——用户再点别的 Bot
   * 才会覆盖它；这里主动清掉，避免状态里留一个指向已删除对象的悬空值。
   *
   * 这一条不走 requestClose：它清理的是「指向已删除对象的悬空状态」，此刻
   * bot 已经是 null、组件本来就渲染不出任何东西，没有可播的退场动画。
   */
  useEffect(() => {
    if (botId === null) return
    if (!state.bots.some((item) => item.id === botId)) actions.openBotSettings(null)
  }, [botId, state.bots, actions])

  /** 记忆列表：过滤 + 排序（主 Bot 可切来源）。 */
  const memories = useMemo<MemoryEntry[]>(() => {
    const base = engineMemories.map(toDisplayMemory)
    const query = memoryQuery.trim().toLowerCase()
    return base
      .filter((memory) => memoryFilter === null || memoryFilter === 'work' || memory.botId === memoryFilter)
      .filter((memory) => query === ''
        || memory.text.toLowerCase().includes(query)
        || memory.tags.some((tag) => tag.toLowerCase().includes(query)))
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [engineMemories, memoryFilter, memoryQuery])

  /*
   * 可用页签：子 Bot 没有「团队」页（那是主 Bot 管子 Bot 的地方）。
   *
   * 依赖写 `bot?.isMain` 而不是 `bot`：只有身份变了才需要重算，
   * 改个名字 / 换个音色不该让左侧导航重建一遍。
   */
  const availableTabs = useMemo(
    () => BOT_TABS.filter((item) => item.mainOnly !== true || bot?.isMain === true),
    [bot?.isMain],
  )
  /*
   * 当前页签的兜底：`tab` 可能指向一个已经不可用的页（开着「团队」页时
   * 从主 Bot 切到子 Bot），这时按「资料」渲染，而不是留一片空白。
   */
  const activeTab: BotTabId = availableTabs.some((item) => item.id === tab) ? tab : 'profile'

  /* 换页签后把右侧面板滚回顶部（内容长度差很大，不重置会停在中段）。 */
  useEffect(() => {
    const body = bodyRef.current
    if (body !== null) body.scrollTop = 0
  }, [activeTab])

  /* ── 以下都是「打开状态下」才用得到的派生值 / 事件处理 ── */
  if (bot === null) return null

  const updateDraft = (patch: Partial<typeof draft>): void => {
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  const saveProfile = (): void => {
    actions.updateBot(bot.id, {
      name: draft.name.trim() || bot.name,
      role: draft.role.trim() || bot.role,
      description: draft.description.trim(),
      instructions: draft.instructions.trim(),
    })
    actions.toast('Bot 资料已保存')
  }

  /** 当前模型（provider/model）的选择键。 */
  const modelValue = `${bot.model.provider}/${bot.model.model}`
  /** 当前选中的模型条目（带推理档位元数据；宿主没给列表时为 undefined）。 */
  const currentModel = modelGroups
    .flatMap((group) => group.models.map((item) => ({ ...item, provider: group.provider })))
    .find((item) => `${item.provider}/${item.id}` === modelValue)
  /** 当前模型（provider/model）的人类可读名。 */
  const modelLabel = currentModel?.name ?? bot.model.model

  /*
   * 推理档位：只列模型自己公布的档位，另加一项「跟随默认」（不下发 effort，
   * 由宿主用模型默认档）。模型没公布档位（或宿主未提供模型列表）时不渲染这一行，
   * 不拿一套固定档位冒充能力。
   */
  const effortChoices: PaSelectOption[] = currentModel === undefined || (currentModel.reasoningEfforts ?? []).length === 0
    ? []
    : [
        { value: '', label: '跟随默认' },
        ...(currentModel.reasoningEfforts ?? []).map((effort) => ({ value: effort.id, label: effort.name })),
      ]
  /** 当前值不在公布档位里（旧数据 / 换过模型）时按「跟随默认」展示，不编一个假选项。 */
  const effortValue = effortChoices.some((option) => option.value === (bot.model.effort ?? ''))
    ? (bot.model.effort ?? '')
    : ''

  const handleModelChange = (provider: string, model: string): void => {
    /*
     * 换模型时保留推理强度有个前提：新模型必须公布同一个档位。
     * `updateBot` 对 `model` 是整体替换，不带上就会被清掉——那样用户刚选的
     * 档位会悄悄丢回宿主默认，表现是「改了设置但下一轮没变化」。
     */
    const next = modelGroups
      .flatMap((group) => group.models.map((item) => ({ ...item, provider: group.provider })))
      .find((item) => item.provider === provider && item.id === model)
    const nextEfforts = (next?.reasoningEfforts ?? []).map((effort) => effort.id)
    const keepEffort = bot.model.effort !== undefined && bot.model.effort !== '' && nextEfforts.includes(bot.model.effort)
      ? bot.model.effort
      : undefined
    actions.updateBot(bot.id, {
      model: {
        provider,
        model,
        ...(keepEffort !== undefined ? { effort: keepEffort } : {}),
      },
    })
  }

  /** 推理强度即改即存；空值 = 跟随模型默认（不下发 reasoningEffort）。 */
  const handleEffortChange = (next: string): void => {
    actions.updateBot(bot.id, {
      model: next === ''
        ? { provider: bot.model.provider, model: bot.model.model }
        : { provider: bot.model.provider, model: bot.model.model, effort: next },
    })
  }

  const openRoutineForm = (): void => {
    setRoutineName('')
    setRoutineInstruction('')
    setRoutineFreq('daily')
    setRoutineTime('09:00')
    setRoutineOpen(true)
  }

  const submitRoutine = (): void => {
    const name = routineName.trim()
    if (name === '') return
    const schedule: RoutineSchedule = routineFreq === 'interval'
      ? { kind: 'interval', everyMinutes: 120 }
      : routineFreq === 'weekly'
        ? { kind: 'weekly', time: routineTime || '10:00', weekdays: [1] }
        : { kind: 'daily', time: routineTime || '09:00' }
    actions.createRoutine({
      botId: bot.id,
      name,
      instruction: routineInstruction.trim(),
      schedule,
    })
    setRoutineOpen(false)
  }

  const saveSubName = (target: Bot): void => {
    if (editingSub === null) return
    actions.updateBot(target.id, { name: editingSub.name.trim() || target.name })
    actions.toast('已更新子 Bot 名称')
    setEditingSub(null)
  }

  const botName = (id: string): string => state.bots.find((item) => item.id === id)?.name ?? '未知 Bot'

  /**
   * 导航项右侧的小角标：有数量才显示，空的时候不挂一个「0」占位。
   *
   * 只给「条数会变、且用户会关心规模」的三页配角标：记忆、例行任务、子 Bot。
   * 资料 / 模型这些没有可数的东西，硬凑一个数字只是噪音。
   */
  const tabBadge = (id: BotTabId): string | undefined => {
    if (id === 'automation' && routines.length > 0) return String(routines.length)
    if (id === 'team' && subBots.length > 0) return String(subBots.length)
    if (id === 'memory' && memories.length > 0) return String(memories.length)
    return undefined
  }

  /**
   * 左侧导航的键盘操作：上下 / 左右移动、Home / End 跳到首尾。
   *
   * 这是 WAI-ARIA tablist 的惯例动作，缺了它键盘用户按方向键没反应，
   * 只能靠 Tab 逐个穿过 8 个页签。焦点跟着选中项走，否则按完方向键
   * 焦点还留在旧页签上，再按一次又跳回去。
   */
  const onNavKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const { key } = event
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowLeft'
      && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return
    event.preventDefault()
    const index = availableTabs.findIndex((item) => item.id === activeTab)
    const last = availableTabs.length - 1
    let next = index
    if (key === 'ArrowDown' || key === 'ArrowRight') next = index >= last ? 0 : index + 1
    else if (key === 'ArrowUp' || key === 'ArrowLeft') next = index <= 0 ? last : index - 1
    else if (key === 'Home') next = 0
    else next = last
    const target = availableTabs[next]
    if (target === undefined) return
    setTab(target.id)
    document.getElementById(`pa-bset-tab-${target.id}`)?.focus()
  }

  const addMemory = (): void => {
    const text = newMemory.trim()
    if (text === '') return
    setNewMemory('')
    /*
     * 写进宿主记忆引擎（owner = 当前 Bot），不写 localStorage。
     * 走 personal-agent 自己的路由而不是 /api/dsh-memory/remember：后者要前端传
     * projectHash，而 bot 工作区的 hash 只有 host 算得准。
     */
    void fetch('/api/personal-agent/memory/remember', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: bot.id, content: text, tags: ['手动'] }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return reloadMemories()
      })
      .catch(() => actions.toast('记忆保存失败'))
  }

  const removeMemory = (id: string): void => {
    void memoryApi.deleteEntry(id)
      .then(() => reloadMemories())
      .catch(() => actions.toast('删除记忆失败'))
  }

  const openOutputsFolder = (): void => {
    const root = outputs.root
    if (root === null) return
    void fetch('/api/chat-flow/open-path', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`)
        actions.toast('已打开产出物文件夹')
      })
      .catch((error: unknown) => {
        actions.toast(`打开文件夹失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /*
   * 退场只加一个 data-closing，动画由 settings.css.ts 里
   * .pa-sheet-overlay[data-closing='1'] 的后代选择器接管（特异性高于入场规则），
   * 所以入场 class 不用拆，两者不会同时抢同一个 animation 属性。
   */
  return (
    <div
      className="pa-sheet-overlay pa-sheet-overlay--dialog"
      data-closing={closing ? '1' : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <aside
        className="pa-sheet pa-sheet--dialog pa-sheet--tabs"
        role="dialog"
        aria-modal="true"
        aria-label={`${bot.name} 设置`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="pa-sheet__head">
          <BotAvatar avatar={bot.avatar} size={34} online={bot.status === 'online'} muted={!bot.enabled} />
          <div className="pa-sheet__head-text">
            <div className="pa-sheet__title">{bot.name}</div>
            <div className="pa-sheet__sub">Bot 设置 · {bot.role}</div>
          </div>
          <button className="pa-sheet__close" type="button" onClick={requestClose} title="关闭" aria-label="关闭设置">
            <IconX size={16} />
          </button>
        </div>

        {/*
         * 左导航 + 右面板。
         *
         * 只渲染当前页签那一份 JSX（而不是把 9 个分区都挂上再用 display:none
         * 藏起来）：记忆列表可能有几十条，藏在 DOM 里既白占内存，也会让屏幕
         * 阅读器把看不见的分区念出来。key={activeTab} 让换页时面板重建一次，
         * 顺带把入场动画重新播一遍。
         *
         * 面板 id 固定为 pa-bset-pane、所有页签的 aria-controls 都指向它：
         * 只有一个面板在用，id 跟着页签变的话，没被选中的那些 aria-controls
         * 就会指向一个不存在的元素（屏幕阅读器只能忽略，关系是断的）。
         * 面板自己的 aria-labelledby 仍然跟着当前页签走，读出来是「记忆 面板」。
         */}
        <div className="pa-sheet__main">
          <nav
            className="pa-bset-nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Bot 设置分类"
            onKeyDown={onNavKeyDown}
          >
            {availableTabs.map((item) => {
              const on = item.id === activeTab
              const badge = tabBadge(item.id)
              return (
                <button
                  key={item.id}
                  id={`pa-bset-tab-${item.id}`}
                  className="pa-bset-nav__item"
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-controls="pa-bset-pane"
                  tabIndex={on ? 0 : -1}
                  data-on={on ? 'true' : 'false'}
                  onClick={() => setTab(item.id)}
                >
                  <span className="pa-bset-nav__icon">{item.icon}</span>
                  <span className="pa-bset-nav__label">{item.label}</span>
                  {/*
                    * 角标对读屏隐藏：视觉上是「团队 · 1」，读出来会变成
                    * 「团队一」这种把数字并进名字的怪句子。页签名本身才是
                    * 读屏需要的那个词，数量只是辅助。
                    */}
                  {badge === undefined ? null : (
                    <span className="pa-bset-nav__badge" aria-hidden="true">{badge}</span>
                  )}
                </button>
              )
            })}
          </nav>

          <div className="pa-sheet__body pa-bset-panes" ref={bodyRef}>
            <div
              key={activeTab}
              className="pa-bset-pane"
              id="pa-bset-pane"
              role="tabpanel"
              aria-labelledby={`pa-bset-tab-${activeTab}`}
              tabIndex={0}
            >
          {/* 1. 基本资料（资料页） */}
          {activeTab === 'profile' ? (
          <SheetSection icon={<IconSparkles size={13} />} title="基本资料">
            <div className="pa-sheet-field-row">
              <label className="pa-sheet-label">头像</label>
              {/*
               * 头像改完立刻生效，不等「保存资料」：它是纯视觉字段，用户在预览里
               * 看到什么样、侧栏就该是什么样；混进表单草稿反而要再点一次保存。
               */}
              <AvatarPicker
                value={bot.avatar}
                onChange={(avatar) => {
                  actions.updateBot(bot.id, { avatar })
                  actions.toast('头像已更新')
                }}
              />
            </div>
            <div className="pa-sheet-field-row">
              <label className="pa-sheet-label" htmlFor="pa-bset-name">名称</label>
              <input
                id="pa-bset-name"
                className="pa-field"
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                placeholder="Bot 名称"
              />
            </div>
            <div className="pa-sheet-field-row">
              <label className="pa-sheet-label" htmlFor="pa-bset-role">角色</label>
              <input
                id="pa-bset-role"
                className="pa-field"
                value={draft.role}
                onChange={(event) => updateDraft({ role: event.target.value })}
                placeholder="例如：代码审查员"
              />
            </div>
            <div className="pa-sheet-field-row">
              <label className="pa-sheet-label" htmlFor="pa-bset-desc">简介</label>
              <textarea
                id="pa-bset-desc"
                className="pa-field"
                value={draft.description}
                onChange={(event) => updateDraft({ description: event.target.value })}
                placeholder="一句话介绍这个 Bot 的定位"
                rows={2}
              />
            </div>
            <div className="pa-sheet-field-row">
              <label className="pa-sheet-label" htmlFor="pa-bset-inst">行为约定</label>
              <textarea
                id="pa-bset-inst"
                className="pa-field"
                value={draft.instructions}
                onChange={(event) => updateDraft({ instructions: event.target.value })}
                placeholder="例如：先给结论，再给依据；写文件前先说明路径。"
                rows={3}
              />
            </div>
            <div className="pa-bset-row" style={{ marginTop: 14, marginBottom: 8 }}>
              <div className="pa-bset-row__main">
                <b>通俗解释 (ELI5 模式)</b>
                <span>像跟5岁小孩或非专业朋友聊天一样，用生活化比喻和大白话解释复杂抽象概念；专业或编程类 Bot 可随时关闭</span>
              </div>
              <button
                className="pa-bset-switch"
                type="button"
                data-on={bot.eli5Mode !== false ? 'true' : 'false'}
                aria-label={bot.eli5Mode !== false ? '关闭通俗解释模式' : '开启通俗解释模式'}
                onClick={() => {
                  const next = bot.eli5Mode === false ? true : false
                  actions.updateBot(bot.id, { eli5Mode: next })
                  actions.toast(next ? '已开启通俗解释 (ELI5)' : '已关闭通俗解释 (ELI5)')
                }}
              >
                <i />
              </button>
            </div>
            <div className="pa-sheet-inline-actions">
              <button className="pa-btn pa-btn--primary pa-btn--sm" type="button" onClick={saveProfile}>
                保存资料
              </button>
            </div>
          </SheetSection>
          ) : null}

          {/* 2. 模型（模型页） */}
          {activeTab === 'model' ? (
          <SheetSection icon={<IconCpu size={13} />} title="模型" extra={modelLabel}>
            {modelGroups.length === 0 ? (
              <div className="pa-sheet-empty">
                {modelGroupsState.loading ? '正在读取模型列表…' : '宿主未提供模型列表（跟随默认模型）'}
              </div>
            ) : (
              <ModelPicker
                groups={modelGroups}
                value={{ provider: bot.model.provider, model: bot.model.model }}
                onChange={(next) => handleModelChange(next.provider, next.model)}
              />
            )}
            {effortChoices.length > 0 ? (
              <div className="pa-sheet-field-row" style={{ marginTop: 11 }}>
                <label className="pa-sheet-label">推理强度</label>
                <PaSelect
                  value={effortValue}
                  options={effortChoices}
                  ariaLabel="推理强度"
                  onChange={handleEffortChange}
                />
                <p className="pa-sheet-hint">
                  档位越高，模型思考越久、回答越稳；「跟随默认」使用模型自己的默认档。下一轮对话生效。
                </p>
              </div>
            ) : null}
            <p className="pa-sheet-hint">选择后立即保存；下一轮对话开始生效，不影响已经开始的回合。</p>
          </SheetSection>
          ) : null}

          {/* 3. 语音通话（语音页） */}
          {activeTab === 'voice' ? (
          <SheetSection
            icon={<IconPhone size={13} />}
            title="语音通话"
            extra={bot.voice === undefined || bot.voice === '' ? '跟随默认' : voiceLabel(bot.voice)}
          >
            <div className="pa-sheet-field-row">
              <label className="pa-sheet-label">音色</label>
              <PaSelect
                value={bot.voice ?? ''}
                options={VOICE_OPTIONS}
                ariaLabel="通话音色"
                onChange={(next) => actions.updateBot(bot.id, { voice: next })}
              />
              <p className="pa-sheet-hint">
                语音通话与「自动朗读」共用这套音色，下一通电话 / 下一次朗读生效。自动播报开关在聊天会话头（通话按钮左侧）。
              </p>
            </div>
            <div className="pa-sheet-field-row">
              <label className="pa-sheet-label">Live 供应商</label>
              <PaSelect
                value={bot.liveVendor ?? ''}
                options={liveVendorChoices}
                ariaLabel="通话供应商"
                disabled={liveVendors.vendors === null || liveVendors.vendors.length === 0}
                onChange={(next) => actions.updateBot(bot.id, { liveVendor: next })}
              />
              <p className={liveVendors.error === null ? 'pa-sheet-hint' : 'pa-sheet-hint pa-sheet-hint--warn'}>
                {liveVendors.error !== null
                  ? `读不到 Live 供应商列表（${liveVendors.error}），先按全局默认接通话；重启宿主后再试。`
                  : liveVendors.loading || liveVendors.vendors === null
                    ? '正在读取供应商列表…'
                    : liveVendors.vendors.length === 0
                      ? '还没有配置任何 Live 供应商：到「设置 → 供应商 → 实时语音」里新增一个。'
                      : '语音通话与「自动朗读」共用这家供应商，下一通电话 / 下一次朗读生效。'}
              </p>
            </div>
            {/*
             * 「自动朗读回复」的开关不在这一页（2026-11-05 撤掉）：它已经挪到聊天
             * 会话头——通话按钮左侧的喇叭按钮，悬停还能调朗读音量。这一页只留音色
             * 与供应商：「配声音」是长期设置，「拨开关」是天天要做的动作，后者该在
             * 一眼就能看到的地方。同一份字段只由 AutoSpeakButton 维护，这里不再重复。
             */}
          </SheetSection>
          ) : null}

          {/* 4. 工具权限（权限页） */}
          {activeTab === 'permission' ? (
          <SheetSection
            icon={<IconTerminal size={13} />}
            title="工具权限"
            extra={permissionLabel(bot.permission)}
          >
            <div className="pa-bset-perm">
              {(['full', 'approval'] as const).map((value) => (
                <button
                  key={value}
                  className="pa-bset-perm__opt"
                  type="button"
                  data-on={(bot.permission ?? 'full') === value ? 'true' : 'false'}
                  onClick={() => actions.updateBot(bot.id, { permission: value })}
                >
                  {value === 'full' ? '完全权限' : '审批模式'}
                </button>
              ))}
            </div>
            <p className="pa-sheet-hint">
              {(bot.permission ?? 'full') === 'full'
                ? '能读写文件、执行命令、联网检索，不再逐次确认。'
                : '写文件 / 跑命令前先问你一次；只读操作直接放行。'}
            </p>
          </SheetSection>
          ) : null}

          {/*
           * 5. 主动询问 + 6. 例行任务（自动化页）。
           * 这两块都回答同一个问题「Bot 什么时候自己动起来」，放一页里连着看，
           * 不用在两个页签之间来回跳着配。
           */}
          {activeTab === 'automation' ? (
          <>
          <SheetSection
            icon={<IconMessage size={13} />}
            title="主动询问"
            extra={bot.proactive.enabled ? '已开启' : '已关闭'}
          >
            <div className="pa-bset-row">
              <div className="pa-bset-row__main">
                <b>主动找我</b>
                <span>每天 {bot.proactive.from}–{bot.proactive.to} · 可以随时主动发起一条询问</span>
              </div>
              <button
                className="pa-bset-switch"
                type="button"
                data-on={bot.proactive.enabled ? 'true' : 'false'}
                aria-label={bot.proactive.enabled ? '关闭主动询问' : '开启主动询问'}
                onClick={() => actions.updateBot(bot.id, {
                  proactive: { ...bot.proactive, enabled: !bot.proactive.enabled },
                })}
              >
                <i />
              </button>
            </div>
            <div className="pa-sheet-inline-actions">
              <button className="pa-btn pa-btn--sm" type="button" onClick={() => actions.proactiveNow(bot.id)}>
                <IconPhone size={12} />现在问一次
              </button>
            </div>
          </SheetSection>

          {/* 6. 例行任务 */}
          <SheetSection
            icon={<IconClock size={13} />}
            title="例行任务"
            extra={routines.length > 0 ? `${routines.length} 项` : ''}
          >
            {routines.length === 0 ? (
              <div className="pa-sheet-empty" style={{ marginBottom: 8 }}>还没有例行任务。</div>
            ) : routines.map((routine) => (
              <div className="pa-bset-routine" key={routine.id}>
                <div className="pa-bset-routine__head">
                  <span className="pa-bset-routine__name">{routine.name}</span>
                  <button
                    className="pa-bset-switch"
                    type="button"
                    data-on={routine.enabled ? 'true' : 'false'}
                    aria-label={routine.enabled ? '暂停例行任务' : '启用例行任务'}
                    onClick={() => actions.toggleRoutine(routine.id)}
                  >
                    <i />
                  </button>
                </div>
                <div className="pa-bset-routine__meta">
                  {routineFrequency(routine.schedule)} · 下次 {formatNextAt(routine.nextAt)}
                </div>
                <div className="pa-bset-routine__actions">
                  <button className="pa-bset-linkbtn" type="button" onClick={() => actions.runRoutine(routine.id)}>
                    <IconPlay size={11} />立即运行
                  </button>
                  <button
                    className="pa-bset-linkbtn pa-bset-linkbtn--danger"
                    type="button"
                    onClick={() => actions.deleteRoutine(routine.id)}
                  >
                    <IconTrash size={11} />删除
                  </button>
                </div>
              </div>
            ))}

            {routineOpen ? (
              <div className="pa-bset-inline-form">
                <div className="pa-sheet-field-row">
                  <label className="pa-sheet-label">名称</label>
                  <input
                    autoFocus
                    className="pa-field"
                    value={routineName}
                    onChange={(event) => setRoutineName(event.target.value)}
                    placeholder="例如：每日邮件汇总"
                  />
                </div>
                <div className="pa-sheet-field-row">
                  <label className="pa-sheet-label">指令</label>
                  <textarea
                    className="pa-field"
                    value={routineInstruction}
                    onChange={(event) => setRoutineInstruction(event.target.value)}
                    placeholder="到点后让 Bot 做什么？"
                    rows={2}
                  />
                </div>
                <div className="pa-sheet-field-row">
                  <label className="pa-sheet-label">频率</label>
                  <select
                    className="pa-field"
                    value={routineFreq}
                    onChange={(event) => setRoutineFreq(event.target.value as 'daily' | 'interval' | 'weekly')}
                  >
                    <option value="daily">每天</option>
                    <option value="interval">每 2 小时</option>
                    <option value="weekly">每周一</option>
                  </select>
                </div>
                {routineFreq !== 'interval' ? (
                  <div className="pa-sheet-field-row">
                    <label className="pa-sheet-label">时间</label>
                    <input
                      className="pa-field"
                      type="time"
                      value={routineTime}
                      onChange={(event) => setRoutineTime(event.target.value)}
                    />
                  </div>
                ) : null}
                <div className="pa-sheet-inline-actions">
                  <button className="pa-btn pa-btn--ghost pa-btn--sm" type="button" onClick={() => setRoutineOpen(false)}>
                    取消
                  </button>
                  <button
                    className="pa-btn pa-btn--primary pa-btn--sm"
                    type="button"
                    disabled={routineName.trim() === ''}
                    onClick={submitRoutine}
                  >
                    创建
                  </button>
                </div>
              </div>
            ) : (
              <button className="pa-bset-add" type="button" onClick={openRoutineForm}>
                <IconPlus size={13} />新建例行任务
              </button>
            )}
          </SheetSection>

          {/* 7. 上下文接力（第 2 步）：提示方式 + 软/硬阈值 + 空闲小时数 */}
          <RelayAutoSettings bot={bot} />
          </>
          ) : null}

          {/* 7. 子 Bot 管理（仅主 Bot；团队页） */}
          {activeTab === 'team' && bot.isMain ? (
            <SheetSection
              icon={<IconUsers size={13} />}
              title="子 Bot 管理"
              extra={subBots.length > 0 ? `${subBots.length} 个` : ''}
            >
              {subBots.length === 0 ? (
                <div className="pa-sheet-empty">还没有子 Bot。点侧栏顶部的 + 新建一个。</div>
              ) : subBots.map((item) => (
                <div className="pa-bset-subrow" key={item.id}>
                  <div className="pa-bset-subrow__top">
                    <BotAvatar avatar={item.avatar} size={30} online={item.status === 'online'} muted={!item.enabled} />
                    <div className="pa-bset-subrow__main">
                      {editingSub !== null && editingSub.id === item.id ? (
                        <input
                          autoFocus
                          className="pa-bset-mini-input"
                          value={editingSub.name}
                          onChange={(event) => setEditingSub({ ...editingSub, name: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') saveSubName(item)
                            if (event.key === 'Escape') {
                              // preventDefault 让设置卡的 Esc 监听跳过：这里只取消改名，
                              // 不应该顺手把整张卡关掉。
                              event.preventDefault()
                              setEditingSub(null)
                            }
                          }}
                        />
                      ) : (
                        <div className="pa-bset-subrow__name">{item.name}</div>
                      )}
                      <div className="pa-bset-subrow__meta">
                        {item.enabled ? '运行中' : '已暂停'} · {item.role}
                      </div>
                    </div>
                  </div>
                  <div className="pa-bset-subrow__ops">
                    {deleteBotId === item.id ? (
                      <>
                        <span className="pa-bset-confirm-text">删除该 Bot？它的独立记忆与例行任务会一并删除。</span>
                        <button
                          className="pa-bset-mini-btn pa-bset-mini-btn--danger"
                          type="button"
                          onClick={() => {
                            actions.deleteBot(item.id)
                            setDeleteBotId(null)
                          }}
                        >
                          确认
                        </button>
                        <button className="pa-bset-mini-btn" type="button" onClick={() => setDeleteBotId(null)}>
                          取消
                        </button>
                      </>
                    ) : editingSub !== null && editingSub.id === item.id ? (
                      <>
                        <button className="pa-bset-mini-btn" type="button" onClick={() => saveSubName(item)}>保存</button>
                        <button className="pa-bset-mini-btn" type="button" onClick={() => setEditingSub(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <select
                          className="pa-bset-mini-select"
                          value={item.groupId}
                          aria-label="移动分组"
                          onChange={(event) => {
                            actions.moveBot(item.id, event.target.value)
                            actions.toast('已移动分组')
                          }}
                        >
                          {sortedGroups.map((group) => (
                            <option key={group.id} value={group.id}>{group.name}</option>
                          ))}
                        </select>
                        <button className="pa-bset-mini-btn" type="button" onClick={() => actions.startCall(item.id)}>
                          <IconPhone size={11} />呼叫
                        </button>
                        <button
                          className="pa-bset-mini-btn"
                          type="button"
                          onClick={() => actions.setBotEnabled(item.id, !item.enabled)}
                        >
                          {item.enabled ? <IconPause size={11} /> : <IconPlay size={11} />}
                          {item.enabled ? '暂停' : '启用'}
                        </button>
                        <button
                          className="pa-bset-mini-btn"
                          type="button"
                          onClick={() => setEditingSub({ id: item.id, name: item.name })}
                        >
                          <IconEdit size={11} />改名
                        </button>
                        <button
                          className="pa-bset-mini-btn pa-bset-mini-btn--danger"
                          type="button"
                          onClick={() => setDeleteBotId(item.id)}
                        >
                          <IconTrash size={11} />删除
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </SheetSection>
          ) : null}

          {/* 8. 记忆（记忆页） */}
          {activeTab === 'memory' ? (
          <SheetSection
            icon={<IconMemory size={13} />}
            title="记忆"
            extra={memories.length > 0 ? `${memories.length} 条` : ''}
          >
            {/*
             * 记忆检索刷新间隔（宿主记忆引擎的运行时配置，全局单值、不分 Bot）。
             * 放在列表上方：它是「这套记忆怎么工作」的旋钮，不是某一条记忆的属性。
             *
             * 交互照 Work 侧记忆设置页的 NumberRow（草稿 + 失焦/Enter 提交）：
             * 那个组件在 src/client/triad/memory/SettingsTab.tsx，personal 这半边
             * 不能跨模块 import 它的样式模块；这里用设置卡现有的 pa-bset-row 行
             * 加一个数字输入实现，交互口径保持一致。
             */}
            <div className="pa-bset-row">
              <div className="pa-bset-row__main">
                <b>记忆检索刷新间隔</b>
                <span>每几轮重新检索一次相关记忆；越小越新鲜，越大越省 token</span>
              </div>
              <label className="pa-bset-num" data-saving={refreshSaving ? 'true' : 'false'}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={50}
                  step={1}
                  value={refreshDraft}
                  placeholder="默认 5"
                  aria-label="记忆检索刷新间隔（轮）"
                  disabled={refreshSaving}
                  onChange={(event) => setRefreshDraft(event.target.value)}
                  onBlur={commitRefreshTurns}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitRefreshTurns()
                    }
                  }}
                />
                <span className="pa-bset-num__unit">轮</span>
              </label>
            </div>
            <div className="pa-bset-mem-search">
              <IconSearch size={13} />
              <input
                value={memoryQuery}
                onChange={(event) => setMemoryQuery(event.target.value)}
                placeholder="搜索记忆内容或标签"
                aria-label="搜索记忆"
              />
            </div>
            {bot.isMain ? (
              <div className="pa-bset-filters">
                <button
                  className="pa-bset-filter-chip"
                  type="button"
                  data-on={memoryFilter === null ? 'true' : 'false'}
                  onClick={() => setMemoryFilter(null)}
                >
                  全部 Bot
                </button>
                <button
                  className="pa-bset-filter-chip"
                  type="button"
                  data-on={memoryFilter === 'work' ? 'true' : 'false'}
                  onClick={() => setMemoryFilter('work')}
                >
                  Work 全局
                </button>
                {state.bots.map((item) => (
                  <button
                    key={item.id}
                    className="pa-bset-filter-chip"
                    type="button"
                    data-on={memoryFilter === item.id ? 'true' : 'false'}
                    onClick={() => setMemoryFilter(item.id)}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            ) : null}
            {memories.length === 0 ? (
              <div className="pa-sheet-empty">{memoryLoading ? '正在读取记忆…' : '还没有匹配的记忆。'}</div>
            ) : memories.map((memory) => (
              <div className="pa-bset-mem-card" key={memory.id}>
                <div className="pa-bset-mem-text">{memory.text}</div>
                {memory.tags.length > 0 ? (
                  <div className="pa-bset-mem-tags">
                    {memory.tags.map((tag) => <span className="pa-bset-mem-tag" key={tag}>{tag}</span>)}
                  </div>
                ) : null}
                <div className="pa-bset-mem-meta">
                  {/* work 条目的 owner 不是 Bot，来源直接标 Work，别显示成「未知 Bot」。 */}
                  {bot.isMain ? <span className="pa-bset-mem-src">{memory.botId === '' ? 'Work' : botName(memory.botId)}</span> : null}
                  <span>{relativeTime(memory.createdAt)}</span>
                </div>
                <button
                  className="pa-bset-mem-del"
                  type="button"
                  title="删除记忆"
                  aria-label="删除记忆"
                  onClick={() => removeMemory(memory.id)}
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}
            <div className="pa-bset-mem-add">
              <textarea
                value={newMemory}
                onChange={(event) => setNewMemory(event.target.value)}
                placeholder="添加一条记忆，例如：偏好先看结论…"
                aria-label="添加记忆"
                rows={2}
              />
              <button
                type="button"
                disabled={newMemory.trim() === ''}
                onClick={addMemory}
                title="添加记忆"
                aria-label="添加记忆"
              >
                <IconPlus size={15} />
              </button>
            </div>
          </SheetSection>
          ) : null}

          {/* 9. 产出物（产出页） */}
          {activeTab === 'outputs' ? (
          <SheetSection
            icon={<IconFolder size={13} />}
            title="产出物"
            extra={outputs.root !== null ? '已就绪' : ''}
          >
            {outputs.loading ? (
              <div className="pa-sheet-empty">正在读取产出物文件夹…</div>
            ) : outputs.root !== null ? (
              <div className="pa-bset-output">
                <div className="pa-bset-output__label">这个 Bot 的产出物根目录（按分类建子文件夹）</div>
                <code className="pa-bset-output__path">{outputs.root}</code>
                <div className="pa-bset-output__actions">
                  <button className="pa-btn pa-btn--sm" type="button" onClick={openOutputsFolder}>
                    <IconFolder size={13} />打开文件夹
                  </button>
                </div>
              </div>
            ) : (
              <div className="pa-sheet-empty">{outputs.error ?? '还没有产出物文件夹'}</div>
            )}
          </SheetSection>
          ) : null}
            </div>
          </div>
        </div>

        <div className="pa-sheet__foot">
          <button className="pa-btn pa-btn--primary" type="button" onClick={requestClose}>完成</button>
        </div>
      </aside>
    </div>
  )
}
