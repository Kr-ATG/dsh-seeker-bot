/**
 * Personal Agent — Bot 设置卡（右侧滑出）。
 *
 * 入口：Sidebar 的 Bot 行「...」菜单、ChatPanel 的「更多」菜单，都只调用
 * `actions.openBotSettings(botId)`；本组件读 `ui.botSettingsOpen` 自己决定开不开，
 * 所以任何地方都不需要再维护一份「设置弹窗开没开」的局部状态。
 *
 * 结构：遮罩 `.pa-sheet-overlay` + 右贴边全高容器 `.pa-sheet`（样式见 settings.css.ts）。
 * 分区依次是：基本资料 / 模型 / 语音通话 / 工具权限 / 主动询问 / 例行任务 /
 * 子 Bot 管理（仅主 Bot）/ 记忆 / 产出物文件夹。
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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
  IconSearch,
  IconSparkles,
  IconTerminal,
  IconTrash,
  IconUsers,
  IconX,
} from '../icons.tsx'
import { PaSelect, type PaSelectOption } from '../shared/PaSelect.tsx'
import { useLiveVendors, usePersonal } from '../store.tsx'
import {
  formatClock,
  liveVendorOptions,
  voiceLabel,
  type Bot,
  type BotPermission,
  type MemoryEntry,
  type RoutineSchedule,
} from '../types.ts'
import { REALTIME_DEFAULT_VOICE, REALTIME_VOICES } from '../../../shared/realtime-protocol.ts'
import { createMemoryApi, type MemoryEntryView } from '../../triad/memory/api.ts'

/** 宿主 `/api/personal-agent/models` 返回的一组模型（按供应商分组）。 */
interface ModelGroup {
  provider: string
  name: string
  models: Array<{ id: string; name: string }>
}

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

export function BotSettingsCard(): JSX.Element | null {
  const { state, ui, actions } = usePersonal()
  const botId = ui.botSettingsOpen
  const bot = botId !== null ? state.bots.find((item) => item.id === botId) ?? null : null

  /* ── 表单草稿（只有基本资料需要显式保存） ── */
  const [draft, setDraft] = useState({ name: '', role: '', description: '', instructions: '' })
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([])
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
  }, [botId])

  /* 拉一次宿主可用模型（供应商 + 模型）。失败就保持空，选择器显示空态。 */
  useEffect(() => {
    if (botId === null) return undefined
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/personal-agent/models')
        if (!res.ok) return
        const data = (await res.json()) as { ok?: boolean; groups?: ModelGroup[] }
        if (alive && data.ok === true && Array.isArray(data.groups)) setModelGroups(data.groups)
      } catch {
        /* 宿主不可用 / 独立演示页：不显示模型列表 */
      }
    })()
    return () => { alive = false }
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
      if (event.key === 'Escape') actions.openBotSettings(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [botId, actions])

  /*
   * Bot 被删除后 `ui.botSettingsOpen` 会残留一个不存在的 id。
   * 组件这时 return null 不渲染，但 store 里仍是非 null——用户再点别的 Bot
   * 才会覆盖它；这里主动清掉，避免状态里留一个指向已删除对象的悬空值。
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

  /* ── 以下都是「打开状态下」才用得到的派生值 / 事件处理 ── */
  if (bot === null) return null

  const close = (): void => actions.openBotSettings(null)

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

  /** 当前模型（provider/model）的人类可读名。 */
  const modelValue = `${bot.model.provider}/${bot.model.model}`
  const modelLabel = modelGroups
    .flatMap((group) => group.models.map((item) => ({ value: `${group.provider}/${item.id}`, name: item.name })))
    .find((item) => item.value === modelValue)?.name ?? bot.model.model

  const handleModelChange = (value: string): void => {
    // provider 不含 `/`，model 可能含（例如 auto/deepseek-v4.1-flash），按第一个 `/` 切
    const slash = value.indexOf('/')
    if (slash <= 0 || slash >= value.length - 1) return
    actions.updateBot(bot.id, {
      model: { provider: value.slice(0, slash), model: value.slice(slash + 1) },
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

  return (
    <div
      className="pa-sheet-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <aside
        className="pa-sheet"
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
          <button className="pa-sheet__close" type="button" onClick={close} title="关闭" aria-label="关闭设置">
            <IconX size={16} />
          </button>
        </div>

        <div className="pa-sheet__body">
          {/* 1. 基本资料 */}
          <SheetSection icon={<IconSparkles size={13} />} title="基本资料">
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
            <div className="pa-sheet-inline-actions">
              <button className="pa-btn pa-btn--primary pa-btn--sm" type="button" onClick={saveProfile}>
                保存资料
              </button>
            </div>
          </SheetSection>

          {/* 2. 模型 */}
          <SheetSection icon={<IconCpu size={13} />} title="模型" extra={modelLabel}>
            {modelGroups.length === 0 ? (
              <div className="pa-sheet-empty">宿主未提供模型列表（跟随默认模型）</div>
            ) : (
              <select
                className="pa-bset-model"
                value={modelValue}
                onChange={(event) => handleModelChange(event.target.value)}
                aria-label="模型"
              >
                {modelGroups.map((group) => (
                  <optgroup key={group.provider} label={group.name}>
                    {group.models.map((item) => (
                      <option key={`${group.provider}/${item.id}`} value={`${group.provider}/${item.id}`}>
                        {item.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            <p className="pa-sheet-hint">选择后立即保存；下一轮对话开始生效，不影响已经开始的回合。</p>
          </SheetSection>

          {/* 3. 语音通话 */}
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
                只影响语音通话的音色，下一通电话生效；聊天文字回复不受影响。
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
                      : '只影响语音通话连哪家 Live 供应商，下一通电话生效。'}
              </p>
            </div>
          </SheetSection>

          {/* 4. 工具权限 */}
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

          {/* 5. 主动询问 */}
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

          {/* 7. 子 Bot 管理（仅主 Bot） */}
          {bot.isMain ? (
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

          {/* 8. 记忆 */}
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

          {/* 9. 产出物文件夹 */}
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
        </div>

        <div className="pa-sheet__foot">
          <button className="pa-btn pa-btn--primary" type="button" onClick={close}>完成</button>
        </div>
      </aside>
    </div>
  )
}
