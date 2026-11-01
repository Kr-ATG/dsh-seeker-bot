/**
 * Personal Agent — 右侧详情栏。
 *
 * 结构（参考 ref-right.png）：
 *   顶部通话收起条（仅在通话最小化时出现）
 *   64px 头像 + 名称 + 角色 + 分享 / 关闭
 *   详情 / 资料库 / 电脑 三个 tab
 *
 * 详情：任务卡（从最近消息的 task block 汇总）、例行任务、主 Bot 的子 Bot 管理。
 * 资料库：记忆搜索 + 列表 + 添加 + 删除；主 Bot 可查看全部 Bot 的记忆并标注来源。
 * 电脑：静态工作区文件树 + 终端片段。
 */
import { useEffect, useMemo, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import {
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconCpu,
  IconEdit,
  IconExpand,
  IconFile,
  IconFolder,
  IconPause,
  IconPhone,
  IconPhoneOff,
  IconPlay,
  IconPlus,
  IconSearch,
  IconShare,
  IconSparkles,
  IconTerminal,
  IconTrash,
  IconUsers,
  IconX,
} from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import {
  formatClock,
  formatDuration,
  type Bot,
  type BotPermission,
  type RoutineSchedule,
  type TaskStep,
} from '../types.ts'

type RightTab = 'detail' | 'library' | 'computer'

/** 权限档位的中文名（旧数据没有该字段时按完全权限显示）。 */
function permissionLabel(permission: BotPermission | undefined): string {
  return permission === 'approval' ? '审批模式' : '完全权限'
}

interface TaskItem {
  key: string
  title: string
  status: string
  detail?: string
  steps: TaskStep[]
  at: number
}

interface TreeItem {
  name: string
  children?: TreeItem[]
}

const FILE_TREE: TreeItem[] = [
  {
    name: 'workspace',
    children: [
      {
        name: 'reports',
        children: [
          { name: '2026-10-31-personal-agent.md' },
          { name: 'weekly', children: [{ name: '2026-W44.md' }, { name: '2026-W43.md' }] },
        ],
      },
      { name: 'notes', children: [{ name: 'ideas.md' }, { name: 'meeting-notes.md' }] },
      { name: 'src', children: [{ name: 'client' }, { name: 'host' }] },
      { name: 'README.md' },
    ],
  },
]

const TERMINAL_LINES = [
  '$ cd ~/workspace && npm run build:personal-demo',
  '  building client bundle...',
  '  ✓ 128 modules transformed',
  '  dist/personal-agent/index.html  42.8 kB',
  '',
  '$ git status --short',
  '  M src/client/personal/shell/RightPanel.tsx',
  '  M src/client/personal/shell/shell.css.ts',
]

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']

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

export function RightPanel(): JSX.Element {
  const { state, ui, actions, activeBot } = usePersonal()
  /** 当前 tab；store 的 rightTab 是唯一来源。 */
  const tab: RightTab = ui.rightTab

  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>({})
  const [routineOpen, setRoutineOpen] = useState(false)
  /**
   * 宿主可用的模型清单（按供应商分组）。
   *
   * 直接读 `/api/personal-agent/models`，它背后是宿主的 llm 注册表——所以用户在
   * 供应商中心新加一个模型，这里刷新一下就出现，不用改代码。宿主不可用时保持空数组，
   * 选择器退化成「跟随默认」而不是报错。
   */
  const [modelGroups, setModelGroups] = useState<Array<{
    provider: string
    name: string
    models: Array<{ id: string; name: string }>
  }>>([])
  const [routineName, setRoutineName] = useState('')
  const [routineInstruction, setRoutineInstruction] = useState('')
  const [routineFreq, setRoutineFreq] = useState<'daily' | 'interval' | 'weekly'>('daily')
  const [routineTime, setRoutineTime] = useState('09:00')
  const [editingSub, setEditingSub] = useState<{ id: string; name: string } | null>(null)
  const [deleteBotId, setDeleteBotId] = useState<string | null>(null)
  const [memoryQuery, setMemoryQuery] = useState('')
  const [memoryFilter, setMemoryFilter] = useState<string | null>(null)
  const [newMemory, setNewMemory] = useState('')
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({
    '/workspace': true,
    '/workspace/reports': true,
  })
  const [now, setNow] = useState(() => Date.now())

  /* 通话计时每秒钟刷新一次。 */
  useEffect(() => {
    if (ui.call.status === 'idle') return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ui.call.status])

  /* 切换 Bot 时收起上一台 Bot 的编辑 / 删除确认。 */
  useEffect(() => {
    setEditingSub(null)
    setDeleteBotId(null)
    setExpandedTasks({})
    setMemoryQuery('')
    setMemoryFilter(null)
  }, [activeBot.id])

  /* 拉一次宿主可用模型（供应商 + 模型）。失败就保持空，选择器退化成「跟随默认」。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/personal-agent/models')
        if (!res.ok) return
        const data = await res.json() as { ok?: boolean; groups?: Array<{ provider: string; name: string; models: Array<{ id: string; name: string }> }> }
        if (alive && data.ok === true && Array.isArray(data.groups)) setModelGroups(data.groups)
      } catch {
        /* 宿主不可用 / 独立演示页：不显示选择器内容 */
      }
    })()
    return () => { alive = false }
  }, [])

  /** 当前模型（provider/model）与它的人类可读名，用于标题行显示。 */
  const currentModelValue = `${activeBot.model.provider}/${activeBot.model.model}`
  const currentModelLabel = modelGroups
    .flatMap((group) => group.models.map((item) => ({ value: `${group.provider}/${item.id}`, name: item.name })))
    .find((item) => item.value === currentModelValue)?.name ?? activeBot.model.model

  const sortedGroups = useMemo(
    () => [...state.groups].sort((a, b) => a.order - b.order),
    [state.groups],
  )

  /** 从当前 Bot 的最近消息里汇总 task block（不含群聊）。 */
  const tasks = useMemo<TaskItem[]>(() => {
    const items: TaskItem[] = []
    for (const message of state.messages) {
      if (message.botId !== activeBot.id || message.roomId !== undefined) continue
      message.blocks.forEach((block, index) => {
        if (block.type !== 'task') return
        items.push({
          key: `${message.id}:${index}`,
          title: block.title,
          status: block.status,
          detail: block.detail,
          steps: block.steps,
          at: message.at,
        })
      })
    }
    items.sort((a, b) => b.at - a.at)
    return items.slice(0, 5)
  }, [state.messages, activeBot.id])

  const routines = state.routines.filter((routine) => routine.botId === activeBot.id)
  const subBots = state.bots.filter((bot) => !bot.isMain)

  const botName = (id: string): string => state.bots.find((bot) => bot.id === id)?.name ?? '未知 Bot'

  const memories = useMemo(() => {
    const base = activeBot.isMain
      ? state.memories
      : state.memories.filter((memory) => memory.botId === activeBot.id)
    const query = memoryQuery.trim().toLowerCase()
    return base
      .filter((memory) => memoryFilter === null || memory.botId === memoryFilter)
      .filter((memory) => query === ''
        || memory.text.toLowerCase().includes(query)
        || memory.tags.some((tag) => tag.toLowerCase().includes(query)))
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [state.memories, activeBot.id, activeBot.isMain, memoryFilter, memoryQuery])

  const callBot = ui.call.botId !== null ? state.bots.find((bot) => bot.id === ui.call.botId) : undefined

  const toggleTask = (key: string): void => {
    setExpandedTasks((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const openRoutineModal = (): void => {
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
      botId: activeBot.id,
      name,
      instruction: routineInstruction.trim(),
      schedule,
    })
    setRoutineOpen(false)
  }

  const handleShare = (): void => {
    try {
      void navigator.clipboard.writeText(window.location.href)
        .then(() => actions.toast('链接已复制'))
        .catch(() => actions.toast('分享链接已生成'))
    } catch {
      actions.toast('分享链接已生成')
    }
  }

  const saveSubName = (bot: Bot): void => {
    if (editingSub === null) return
    actions.updateBot(bot.id, { name: editingSub.name.trim() || bot.name })
    actions.toast('已更新子 Bot 名称')
    setEditingSub(null)
  }

  const addMemory = (): void => {
    const text = newMemory.trim()
    if (text === '') return
    actions.addMemory(activeBot.id, text)
    setNewMemory('')
  }

  const togglePath = (path: string): void => {
    setExpandedPaths((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  const renderTree = (items: TreeItem[], prefix: string, depth: number): JSX.Element[] => items.flatMap((item) => {
    const path = `${prefix}/${item.name}`
    const children = item.children
    const isFolder = children !== undefined
    const open = expandedPaths[path] ?? depth === 0
    const row = (
      <button
        key={path}
        className="pa-tree__row"
        type="button"
        data-file={isFolder ? 'false' : 'true'}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={isFolder ? () => togglePath(path) : undefined}
      >
        <span className="pa-tree__caret" data-open={open ? 'true' : 'false'}>
          {isFolder ? <IconChevronRight size={11} /> : null}
        </span>
        {isFolder ? <IconFolder size={14} /> : <IconFile size={14} />}
        <span className="pa-tree__name">{item.name}</span>
      </button>
    )
    if (!isFolder || !open || children === undefined) return [row]
    return [row, ...renderTree(children, path, depth + 1)]
  })

  const tabButton = (value: RightTab, label: string): JSX.Element => (
    <button
      className="pa-right__tab"
      type="button"
      data-on={tab === value ? 'true' : 'false'}
      onClick={() => actions.setRightTab(value)}
    >
      {label}
    </button>
  )

  return (
    <aside className="pa-right">
      {ui.call.status !== 'idle' && ui.call.minimized ? (
        <div className="pa-call-bar">
          {callBot !== undefined ? <BotAvatar avatar={callBot.avatar} size={28} online /> : null}
          <div className="pa-call-bar__text">
            <b>通话中 · {formatDuration(now - ui.call.startedAt)}</b>
            {callBot?.name ?? '语音通话'}
          </div>
          <button
            className="pa-call-bar__btn"
            type="button"
            title="展开通话"
            aria-label="展开通话"
            onClick={() => actions.minimizeCall(false)}
          >
            <IconExpand size={14} />
          </button>
          <button
            className="pa-call-bar__btn pa-call-bar__btn--hangup"
            type="button"
            title="挂断"
            aria-label="挂断"
            onClick={() => actions.endCall()}
          >
            <IconPhoneOff size={14} />
          </button>
        </div>
      ) : null}

      <div className="pa-right__head">
        <div className="pa-right__actions">
          <button className="pa-icon-btn" type="button" title="分享" aria-label="分享" onClick={handleShare}>
            <IconShare size={15} />
          </button>
          <button
            className="pa-icon-btn"
            type="button"
            title="关闭详情"
            aria-label="关闭详情"
            onClick={() => actions.toggleRightPanel(false)}
          >
            <IconX size={15} />
          </button>
        </div>
        <div className="pa-right__avatar">
          <BotAvatar avatar={activeBot.avatar} size={64} online={activeBot.status === 'online'} />
        </div>
        <div className="pa-right__name">{activeBot.name}</div>
        <div className="pa-right__role">{activeBot.role}</div>
      </div>

      <div className="pa-right__tabs" role="tablist" aria-label="详情分区">
        {tabButton('detail', '详情')}
        {tabButton('library', '资料库')}
        {tabButton('computer', '电脑')}
      </div>

      <div className="pa-right__body">
        {tab === 'detail' ? (
          <>
            <div className="pa-right-sec">
              <IconCpu size={13} />
              <span>编码</span>
              <span className="pa-right-sec__count">{tasks.length > 0 ? `${tasks.length} 项` : ''}</span>
            </div>
            {tasks.length === 0 ? (
              <div className="pa-empty-card">这个 Bot 还没有任务卡。在对话里给它派个任务试试。</div>
            ) : tasks.map((task) => {
              const open = expandedTasks[task.key] === true
              return (
                <div className="pa-task-card" data-open={open ? 'true' : 'false'} key={task.key}>
                  <button className="pa-task-card__head" type="button" onClick={() => toggleTask(task.key)}>
                    <span className="pa-task-ico"><IconCircleCheck size={16} /></span>
                    <span className="pa-task-main">
                      <span className="pa-task-title">{task.title}</span>
                      <span className="pa-task-sub">{task.status}</span>
                    </span>
                    <span className="pa-task-caret"><IconChevronRight size={14} /></span>
                  </button>
                  {open ? (
                    <div className="pa-task-steps">
                      {task.detail !== undefined && task.detail !== '' ? (
                        <div style={{ color: 'var(--pa-text-3)', lineHeight: 1.55 }}>{task.detail}</div>
                      ) : null}
                      {task.steps.map((step, index) => (
                        <div className="pa-task-step" data-done={step.done ? 'true' : 'false'} key={`${task.key}-${index}`}>
                          <IconCircleCheck size={12} />
                          <span>{step.text}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}

            <div className="pa-right-sec">
              <IconSparkles size={13} />
              <span>模型</span>
              <span className="pa-right-sec__count">{currentModelLabel}</span>
            </div>
            <div className="pa-routine">
              {modelGroups.length > 0 ? (
                <select
                  className="pa-field pa-model-select"
                  value={currentModelValue}
                  onChange={(event) => {
                    const [provider, model] = event.target.value.split('/')
                    if (provider === undefined || model === undefined) return
                    actions.updateBot(activeBot.id, { model: { provider, model } })
                  }}
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
              ) : (
                <div className="pa-empty-card">宿主未提供模型列表（跟随默认）</div>
              )}
              <div className="pa-routine__meta">
                选择后立即保存到这个 Bot；下一轮对话开始生效，不影响已经开始的回合。
              </div>
            </div>

            <div className="pa-right-sec">
              <IconTerminal size={13} />
              <span>工具权限</span>
              <span className="pa-right-sec__count">{permissionLabel(activeBot.permission)}</span>
            </div>
            <div className="pa-routine">
              <div className="pa-perm">
                {(['full', 'approval'] as const).map((value) => (
                  <button
                    key={value}
                    className="pa-perm__opt"
                    type="button"
                    data-on={(activeBot.permission ?? 'full') === value ? 'true' : 'false'}
                    onClick={() => actions.updateBot(activeBot.id, { permission: value })}
                  >
                    {value === 'full' ? '完全权限' : '审批模式'}
                  </button>
                ))}
              </div>
              <div className="pa-routine__meta">
                {(activeBot.permission ?? 'full') === 'full'
                  ? '能读写文件、执行命令、联网检索，不再逐次确认。'
                  : '写文件 / 跑命令前先问你一次；只读操作直接放行。'}
              </div>
            </div>

            <div className="pa-right-sec">
              <IconPhone size={13} />
              <span>主动询问</span>
              <span className="pa-right-sec__count">{activeBot.proactive.enabled ? '已开启' : '已关闭'}</span>
            </div>
            <div className="pa-routine">
              <div className="pa-routine__head">
                <span className="pa-routine__name">主动找我</span>
                <button
                  className="pa-switch"
                  type="button"
                  data-on={activeBot.proactive.enabled ? 'true' : 'false'}
                  aria-label={activeBot.proactive.enabled ? '关闭主动询问' : '开启主动询问'}
                  onClick={() => actions.updateBot(activeBot.id, {
                    proactive: { ...activeBot.proactive, enabled: !activeBot.proactive.enabled },
                  })}
                >
                  <i />
                </button>
              </div>
              <div className="pa-routine__meta">
                每天 {activeBot.proactive.from}–{activeBot.proactive.to} · 可以随时主动发起一条询问
              </div>
              <div className="pa-routine__actions">
                <button className="pa-link-btn" type="button" onClick={() => actions.proactiveNow(activeBot.id)}>
                  <IconPhone size={11} />现在问一次
                </button>
              </div>
            </div>

            <div className="pa-right-sec">
              <IconClock size={13} />
              <span>例行任务</span>
              <span className="pa-right-sec__count">{routines.length > 0 ? `${routines.length} 项` : ''}</span>
            </div>
            {routines.length === 0 ? (
              <div className="pa-empty-card">请在聊天中设置例行任务。</div>
            ) : routines.map((routine) => (
              <div className="pa-routine" key={routine.id}>
                <div className="pa-routine__head">
                  <span className="pa-routine__name">{routine.name}</span>
                  <button
                    className="pa-switch"
                    type="button"
                    data-on={routine.enabled ? 'true' : 'false'}
                    aria-label={routine.enabled ? '暂停例行任务' : '启用例行任务'}
                    onClick={() => actions.toggleRoutine(routine.id)}
                  >
                    <i />
                  </button>
                </div>
                <div className="pa-routine__meta">
                  {routineFrequency(routine.schedule)} · 下次 {formatNextAt(routine.nextAt)}
                </div>
                <div className="pa-routine__actions">
                  <button className="pa-link-btn" type="button" onClick={() => actions.runRoutine(routine.id)}>
                    <IconPlay size={11} />立即运行
                  </button>
                  <button
                    className="pa-link-btn pa-link-btn--danger"
                    type="button"
                    onClick={() => actions.deleteRoutine(routine.id)}
                  >
                    <IconTrash size={11} />删除
                  </button>
                </div>
              </div>
            ))}
            <button className="pa-add-dashed" type="button" onClick={openRoutineModal}>
              <IconPlus size={13} />新建例行任务
            </button>

            {activeBot.isMain && subBots.length > 0 ? (
              <>
                <div className="pa-right-sec">
                  <IconUsers size={13} />
                  <span>子 Bot 管理</span>
                  <span className="pa-right-sec__count">{subBots.length} 个</span>
                </div>
                <div className="pa-submanage">
                  {subBots.map((bot) => (
                    <div className="pa-submanage__row" key={bot.id}>
                      <div className="pa-submanage__top">
                        <BotAvatar avatar={bot.avatar} size={30} online={bot.status === 'online'} muted={!bot.enabled} />
                        <div className="pa-submanage__main">
                          {editingSub !== null && editingSub.id === bot.id ? (
                            <input
                              autoFocus
                              className="pa-mini-input"
                              value={editingSub.name}
                              onChange={(event) => setEditingSub({ ...editingSub, name: event.target.value })}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') saveSubName(bot)
                                if (event.key === 'Escape') setEditingSub(null)
                              }}
                            />
                          ) : (
                            <div className="pa-submanage__name">{bot.name}</div>
                          )}
                          <div className="pa-submanage__meta">
                            {bot.enabled ? '运行中' : '已暂停'} · {bot.role}
                          </div>
                        </div>
                      </div>
                      <div className="pa-submanage__ops">
                        {deleteBotId === bot.id ? (
                          <>
                            <span style={{ flex: 1, fontSize: '10.5px', color: 'var(--pa-text-3)' }}>删除该 Bot？</span>
                            <button
                              className="pa-mini-btn pa-mini-btn--danger"
                              type="button"
                              onClick={() => {
                                actions.deleteBot(bot.id)
                                setDeleteBotId(null)
                              }}
                            >
                              确认
                            </button>
                            <button className="pa-mini-btn" type="button" onClick={() => setDeleteBotId(null)}>取消</button>
                          </>
                        ) : editingSub !== null && editingSub.id === bot.id ? (
                          <>
                            <button className="pa-mini-btn" type="button" onClick={() => saveSubName(bot)}>保存</button>
                            <button className="pa-mini-btn" type="button" onClick={() => setEditingSub(null)}>取消</button>
                          </>
                        ) : (
                          <>
                            <select
                              className="pa-mini-select"
                              value={bot.groupId}
                              aria-label="移动分组"
                              onChange={(event) => {
                                actions.moveBot(bot.id, event.target.value)
                                actions.toast('已移动分组')
                              }}
                            >
                              {sortedGroups.map((group) => (
                                <option key={group.id} value={group.id}>{group.name}</option>
                              ))}
                            </select>
                            <button
                              className="pa-mini-btn"
                              type="button"
                              onClick={() => actions.startCall(bot.id)}
                            >
                              <IconPhone size={11} />呼叫
                            </button>
                            <button
                              className="pa-mini-btn"
                              type="button"
                              onClick={() => actions.setBotEnabled(bot.id, !bot.enabled)}
                            >
                              {bot.enabled ? <IconPause size={11} /> : <IconPlay size={11} />}
                              {bot.enabled ? '暂停' : '启用'}
                            </button>
                            <button
                              className="pa-mini-btn"
                              type="button"
                              onClick={() => setEditingSub({ id: bot.id, name: bot.name })}
                            >
                              <IconEdit size={11} />改名
                            </button>
                            <button
                              className="pa-mini-btn pa-mini-btn--danger"
                              type="button"
                              onClick={() => setDeleteBotId(bot.id)}
                            >
                              <IconTrash size={11} />删除
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {tab === 'library' ? (
          <>
            <div className="pa-mem-search">
              <IconSearch size={13} />
              <input
                value={memoryQuery}
                onChange={(event) => setMemoryQuery(event.target.value)}
                placeholder="搜索记忆内容或标签"
                aria-label="搜索记忆"
              />
            </div>
            {activeBot.isMain ? (
              <div className="pa-mem-filters">
                <button
                  className="pa-filter-chip"
                  type="button"
                  data-on={memoryFilter === null ? 'true' : 'false'}
                  onClick={() => setMemoryFilter(null)}
                >
                  全部 Bot
                </button>
                {state.bots.map((bot) => (
                  <button
                    key={bot.id}
                    className="pa-filter-chip"
                    type="button"
                    data-on={memoryFilter === bot.id ? 'true' : 'false'}
                    onClick={() => setMemoryFilter(bot.id)}
                  >
                    {bot.name}
                  </button>
                ))}
              </div>
            ) : null}
            {memories.length === 0 ? (
              <div className="pa-right__empty">还没有匹配的记忆。</div>
            ) : memories.map((memory) => (
              <div className="pa-mem-card" key={memory.id}>
                <div className="pa-mem-text">{memory.text}</div>
                {memory.tags.length > 0 ? (
                  <div className="pa-mem-tags">
                    {memory.tags.map((tag) => <span className="pa-mem-tag" key={tag}>{tag}</span>)}
                  </div>
                ) : null}
                <div className="pa-mem-meta">
                  {activeBot.isMain ? <span className="pa-mem-src">{botName(memory.botId)}</span> : null}
                  <span>{relativeTime(memory.createdAt)}</span>
                </div>
                <button
                  className="pa-mem-del"
                  type="button"
                  title="删除记忆"
                  aria-label="删除记忆"
                  onClick={() => actions.deleteMemory(memory.id)}
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}
            <div className="pa-mem-add">
              <textarea
                value={newMemory}
                onChange={(event) => setNewMemory(event.target.value)}
                placeholder="添加一条记忆，例如：偏好先看结论…"
                aria-label="添加记忆"
                rows={2}
              />
              <button type="button" disabled={newMemory.trim() === ''} onClick={addMemory} title="添加记忆" aria-label="添加记忆">
                <IconPlus size={15} />
              </button>
            </div>
          </>
        ) : null}

        {tab === 'computer' ? (
          <>
            <div className="pa-right-sec">
              <IconFolder size={13} />
              <span>工作区</span>
              <span className="pa-right-sec__count">workspace</span>
            </div>
            <div className="pa-tree">{renderTree(FILE_TREE, '', 0)}</div>
            <div className="pa-right-sec">
              <IconTerminal size={13} />
              <span>终端</span>
            </div>
            <pre className="pa-term">{TERMINAL_LINES.join('\n')}</pre>
          </>
        ) : null}
      </div>

      {routineOpen ? (
        <div
          className="pa-overlay pa-overlay--fixed"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRoutineOpen(false)
          }}
        >
          <div className="pa-modal pa-modal--sm" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pa-modal__head">
              <div className="pa-modal__title">新建例行任务</div>
              <button className="pa-modal__close" type="button" onClick={() => setRoutineOpen(false)} aria-label="关闭">
                <IconX size={16} />
              </button>
            </div>
            <div className="pa-modal__body">
              <div className="pa-form-row">
                <label className="pa-label">名称</label>
                <input
                  className="pa-field"
                  value={routineName}
                  onChange={(event) => setRoutineName(event.target.value)}
                  placeholder="例如：每日邮件汇总"
                />
              </div>
              <div className="pa-form-row">
                <label className="pa-label">指令</label>
                <textarea
                  className="pa-field"
                  value={routineInstruction}
                  onChange={(event) => setRoutineInstruction(event.target.value)}
                  placeholder="到点后让 Bot 做什么？"
                />
              </div>
              <div className="pa-form-row">
                <label className="pa-label">频率</label>
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
                <div className="pa-form-row">
                  <label className="pa-label">时间</label>
                  <input
                    className="pa-field"
                    type="time"
                    value={routineTime}
                    onChange={(event) => setRoutineTime(event.target.value)}
                  />
                </div>
              ) : null}
            </div>
            <div className="pa-modal__foot">
              <button className="pa-btn pa-btn--ghost" type="button" onClick={() => setRoutineOpen(false)}>取消</button>
              <button
                className="pa-btn pa-btn--primary"
                type="button"
                disabled={routineName.trim() === ''}
                onClick={submitRoutine}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  )
}
