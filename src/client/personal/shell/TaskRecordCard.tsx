/**
 * Personal Agent — 右栏「任务记录」。
 *
 * 回答一个问题：**我和这个 Bot（或这个群）做过哪些事。**
 *
 * 数据源是 store 里的 `state.tasks`（每轮对话一条 TaskRecord），不是消息流——
 * 任务记录是「做过什么」的索引，与聊天气泡是两套视图。
 *
 * 两种形态（共用同一套过滤 / 分组 / 行结构）：
 *  · card（默认）—— 右栏独立卡：带「任务记录」卡头、整体可折叠、按天分组；
 *  · activity —— 「动态」分类页里的延续列表：没有卡头，按天分组且每组标题可折叠，
 *    空态只留一行轻提示。点击行仍打开任务详情。
 *
 * 过滤规则（两种用法互斥）：
 *  · 传 `roomId` —— 群聊视角，只看这个群的任务（群任务带 roomId）；
 *  · 只传 `botId` —— 私聊视角，只看这个 Bot 且不带 roomId 的任务。
 *    群任务不能混进 Bot 的私聊记录里，否则同一个 Bot 在群里的活会出现在它的
 *    私聊时间线上，读起来像「它背着我做了什么」。
 *
 * 最多显示 30 条：右栏是纵向堆叠的窄栏，再多就会把下面的内容挤出视口；更早的
 * 记录属于「回看」，不在右栏的日常扫读范围内。
 */

import { useEffect, useMemo, useState } from 'react'
import { IconChevronDown, IconListTodo } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import type { TaskRecord } from '../types.ts'
import { TaskStatusGlyph } from './status-glyph.tsx'

/**
 * 卡内最多展示多少条任务。
 *
 * 用户口径（2026-11-02）：「每一次对话都要有一个详细的任务概览卡片」——
 * 卡里按天分组铺开最近 30 轮，早期的仍然能在任务详情里回看；只留 8 条会
 * 让稍早的对话直接从右栏消失，看起来像「那一轮没被记录」。
 */
const MAX_VISIBLE_TASKS = 30

/** 任务状态的展示文案（状态点之外给读屏与悬停提示用）。 */
const STATUS_LABEL: Record<TaskRecord['status'], string> = {
  running: '进行中',
  done: '已完成',
  stopped: '已停止',
  failed: '失败',
}

/** 两位补零（时间格式化用）。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 任务列表里的相对时间：刚刚 / N 分钟前 / HH:mm。
 *
 * 超过一小时就显示钟点——任务记录通常是一天之内的事，钟点比「3 小时前」
 * 更容易和对话里的时间对上。跨天的完整日期放在 title 里，悬停可见。
 */
function taskTimeText(at: number, now: number): string {
  const diff = Math.max(0, now - at)
  if (diff < 60_000) return '刚刚'
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 完整的本地时间（YYYY-MM-DD HH:mm），用于悬停提示。 */
function fullTimeText(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 某一天的分组键（本地日期）。 */
function dayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 分组标题：今天 / 昨天 / MM-DD。
 *
 * 图一（用户参考图）就是按天分组的：任务记录是「我这几天让它干了什么」的流水，
 * 日期是扫读时最先要找的锚点。今年内的日期不再重复年份。
 */
function dayLabel(at: number): string {
  const today = new Date()
  const key = dayKey(at)
  if (key === dayKey(today.getTime())) return '今天'
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (key === dayKey(yesterday.getTime())) return '昨天'
  const date = new Date(at)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 单行摘要：压平空白并截断，避免长回复把行撑成多行。 */
function flatText(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 任务行的摘要文案：优先用最终回复，其次最后一个工具结果，最后退回请求原文。
 *
 * 与图一一致：标题说明「做什么」，摘要说明「结果怎么样」——只有标题+时间的
 * 列表，用户得逐条点开才知道每轮发生了什么。
 */
function taskSummary(task: TaskRecord): string {
  const reply = task.reply?.trim() ?? ''
  if (reply !== '') return flatText(reply)
  const lastDetail = [...task.steps].reverse().find((step) => step.kind === 'tool' && (step.detail ?? '') !== '')
  if (lastDetail?.detail !== undefined) return flatText(lastDetail.detail)
  if (task.status === 'running') {
    const lastStep = task.steps[task.steps.length - 1]
    return lastStep ? flatText(lastStep.title) : '正在处理…'
  }
  return flatText(task.prompt)
}

/** 任务行：两种形态共用，保证 card / activity 的点击与读屏信息完全一致。 */
function TaskRow({ task, now, onOpen }: {
  task: TaskRecord
  now: number
  onOpen: (id: string) => void
}): JSX.Element {
  const timeText = taskTimeText(task.startedAt, now)
  const summary = taskSummary(task)
  return (
    <button
      className="pa-taskrec__row"
      type="button"
      title={`${task.title}\n${summary}\n${STATUS_LABEL[task.status]} · ${fullTimeText(task.startedAt)}`}
      aria-label={`查看任务详情：${task.title}（${STATUS_LABEL[task.status]}）`}
      onClick={() => onOpen(task.id)}
    >
      <span className="pa-taskrec__icon-box" aria-hidden="true">
        <TaskStatusGlyph status={task.status} />
      </span>
      <span className="pa-taskrec__main">
        <span className="pa-taskrec__name">{task.title.trim() !== '' ? task.title : '未命名任务'}</span>
        {summary !== '' ? <span className="pa-taskrec__summary">{summary}</span> : null}
        <span className="pa-taskrec__time">{timeText}</span>
      </span>
    </button>
  )
}

export interface TaskRecordCardProps {
  /** 私聊任务：只看这个 Bot 的任务（与 roomId 二选一）。 */
  botId?: string
  /** 群聊任务：只看这个群的任务；有值时忽略 botId。 */
  roomId?: string
  /**
   * 展示形态：
   *  · card（默认）—— 右栏独立卡，保留「任务记录」卡头与整体折叠；
   *  · activity —— 「动态」分类页里的延续列表，不要卡头，按天分组且每组可折叠。
   */
  variant?: 'card' | 'activity'
}

export function TaskRecordCard({ botId, roomId, variant = 'card' }: TaskRecordCardProps): JSX.Element {
  const { state, actions } = usePersonal()
  /** 折叠状态只属于「这一次想看不想看」，不落盘；切换会话回到展开态。 */
  const [open, setOpen] = useState(true)
  /** activity 变体里每个日组的折叠状态：key = YYYY-MM-DD，缺省展开。 */
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({})
  /** 相对时间的基准时刻：每分钟走一格，避免「刚刚」挂十分钟不动。 */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  /*
   * 过滤 + 倒序 + 截断。
   *
   * 用 `startedAt` 而不是数组顺序：store 里新记录是 unshift 的，看起来已经有序，
   * 但历史状态经过 localStorage 迁移 / 撤回过滤后不保证顺序，这里显式排一次。
   *
   * **只显示有实质动作的轮次**（有工具调用 / 过程说明 / 产出）：用户口径
   * （2026-11-02）「不是每一个对话都需要给一个任务记录」——纯寒暄、一句问答
   * 不该在卡里留一条空壳；store 收口时也会把这类记录删掉，这里再过滤一次是
   * 为了兜住「运行中还没产生任何动作」的中间态。
   */
  const tasks = useMemo(() => {
    const roomScope = roomId !== undefined && roomId !== ''
    const list = state.tasks.filter((task) => (roomScope
      ? task.roomId === roomId
      : task.botId === botId && task.roomId === undefined)
      && task.steps.some((step) => step.kind === 'tool' || step.kind === 'text' || step.kind === 'output'))
    return [...list]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_VISIBLE_TASKS)
  }, [state.tasks, botId, roomId])

  /** 按天分组（保持倒序）：一天一组，日期作为标题行。 */
  const groups = useMemo(() => {
    const result: Array<{ key: string; label: string; items: TaskRecord[] }> = []
    for (const task of tasks) {
      const key = dayKey(task.startedAt)
      const current = result[result.length - 1]
      if (current !== undefined && current.key === key) current.items.push(task)
      else result.push({ key, label: dayLabel(task.startedAt), items: [task] })
    }
    return result
  }, [tasks])

  /** 切换某个日组的展开 / 收起。 */
  const toggleGroup = (key: string): void => {
    setClosedGroups((prev) => ({ ...prev, [key]: prev[key] !== true }))
  }

  /*
   * activity 变体：没有「任务记录」卡头，任务记录直接接在定时任务区下面。
   * 每个日期组标题是一个按钮（chevron 可折叠），行结构复用 pa-taskrec__row。
   */
  if (variant === 'activity') {
    return (
      <div className="pa-taskrec pa-taskrec--activity" data-variant="activity">
        {tasks.length === 0 ? (
          <div className="pa-taskrec__empty pa-taskrec__empty--activity">
            还没有任务记录，和这个 Bot 聊一句就会开始记录
          </div>
        ) : (
          <div className="pa-taskrec__list pa-taskrec__list--activity">
            {groups.map((group) => {
              const collapsed = closedGroups[group.key] === true
              return (
                <div className="pa-taskrec__group" key={group.key} data-open={collapsed ? 'false' : 'true'}>
                  <button
                    className="pa-taskrec__group-head"
                    type="button"
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? `展开${group.label}的任务记录` : `收起${group.label}的任务记录`}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <span className="pa-taskrec__group-label">{group.label}</span>
                    <span className="pa-taskrec__group-meta">{group.items.length} 条</span>
                    <span className="pa-taskrec__group-caret" aria-hidden="true">
                      <IconChevronDown size={12} />
                    </span>
                  </button>
                  {collapsed ? null : group.items.map((task) => (
                    <TaskRow key={task.id} task={task} now={now} onOpen={actions.openTaskDetail} />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const headerCount = `${tasks.length} 条`

  return (
    <div className="pa-taskrec" data-open={open ? 'true' : 'false'}>
      <button
        className="pa-taskrec__head"
        type="button"
        aria-expanded={open}
        aria-label={open ? '收起任务记录' : '展开任务记录'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="pa-taskrec__icon">
          {/* 「做过什么」：一张带勾的清单。与产出物卡的盒子、记忆卡的大脑区分开。 */}
          <IconListTodo size={15} />
        </span>
        <span className="pa-taskrec__title">任务记录</span>
        <span className="pa-taskrec__meta">{headerCount}</span>
        <span className="pa-taskrec__caret">
          <IconChevronDown size={13} />
        </span>
      </button>

      {open ? (
        <div className="pa-taskrec__body">
          {tasks.length === 0 ? (
            <div className="pa-taskrec__empty">需要时模型会自己开一条任务记录（纯寒暄不会开）</div>
          ) : (
            <div className="pa-taskrec__list">
              {groups.map((group) => (
                <div className="pa-taskrec__group" key={group.key}>
                  <div className="pa-taskrec__group-label">{group.label}</div>
                  {group.items.map((task) => (
                    <TaskRow key={task.id} task={task} now={now} onOpen={actions.openTaskDetail} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
