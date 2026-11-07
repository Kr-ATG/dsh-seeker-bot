/**
 * Personal Agent — 右栏「任务记录」。
 *
 * 回答一个问题：**我和这个 Bot（或这个群）做过哪些事。**
 *
 * 数据源是 store 里的 state.tasks（每轮对话一条 TaskRecord），不是消息流——
 * 任务记录是「做过什么」的索引，与聊天气泡是两套视图。
 *
 * 两种形态（共用同一套过滤 / 分组 / 行结构）：
 *  · card（默认）—— 右栏独立卡：带「任务记录」卡头、整体可折叠、按天分组；
 *  · activity —— 「动态」分类页里的延续列表：没有卡头，按天分组且每组标题可折叠，
 *    空态只留一行轻提示。点击行仍打开任务详情。
 *
 * 2026-11-05 用户口径：「发完消息后，动态里要能实时看到任务的动作进行到哪里」。
 * 所以运行中的任务行不再只给一句结果摘要，而是显示此刻正在做的动作、已完成
 * 动作数与耗时，并可在动态里就地展开整条动作列表（人话标题，原始参数 / 源码
 * 默认收起）。数据本来就由流式事件逐条写进 state.tasks.steps，这里只做展示：
 * 有任务在跑时每秒重渲染一次，不轮询、不发请求。
 *
 * 2026-11-07 用户口径：「这个正在回复改为动态的显示与我们 seeker 操作面板里显示
 * 的动作，因为正在回复看不出来他在做的工作」，以及「文字半截，我需要双行显示」。
 * 于是 live 行的文案改成**具体动作**（与 Seeker 操作面板同一句，见 task-action.ts
 * 的 stepActionViewOf / actionLabelOf），允许折两行，换字时交叉淡入。
 *
 * 过滤规则（两种用法互斥）：
 *  · 传 roomId —— 群聊视角，只看这个群的任务（群任务带 roomId）；
 *  · 只传 botId —— 私聊视角，只看这个 Bot 且不带 roomId 的任务。
 *    群任务不能混进 Bot 的私聊记录里，否则同一个 Bot 在群里的活会出现在它的
 *    私聊时间线上，读起来像「它背着我做了什么」。
 *
 * 最多显示 30 条：右栏是纵向堆叠的窄栏，再多就会把下面的内容挤出视口；更早的
 * 记录属于「回看」，不在右栏的日常扫读范围内。
 */

import { useEffect, useMemo, useState } from 'react'
// 文字交叉淡入：换动作时旧字淡出、新字同时淡入，中间不出现空白帧。
import { useCrossfadeText, useMotionAllowed } from '../../motion-utils.ts'
import { IconChevronDown, IconListTodo } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { formatDuration, type TaskRecord, type TaskRecordStep } from '../types.ts'
// 工具名 → 中文动作只有一份规则表（plain-language）；详情弹窗与动态行共用。
import { actionLabelOf, actionStepsOf, briefOf, doneActionCount, humanizeDetail, liveProgressOf } from './task-action.ts'
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
  if (diff < 60 * 60_000) return String(Math.floor(diff / 60_000)) + ' 分钟前'
  const date = new Date(at)
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/** 完整的本地时间（YYYY-MM-DD HH:mm），用于悬停提示。 */
function fullTimeText(at: number): string {
  const date = new Date(at)
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' '
    + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/** 某一天的分组键（本地日期）。 */
function dayKey(at: number): string {
  const date = new Date(at)
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
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
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

/** 单行摘要：压平空白并截断，避免长回复把行撑成多行。 */
function flatText(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/*
 * 任务行「此刻在做什么」的纯逻辑（actionStepsOf / doneActionCount / liveProgressOf）
 * 已移到 task-action.ts：那里没有 React 依赖，回归脚本（test-task-live-action.mjs）
 * 可以直接真跑，而不是只做源码断言。
 */
/**
 * 任务行的摘要文案。
 *
 * 运行中优先报「此刻在做什么」；收工后才报最终回复，没有回复就报完成动作数。
 * 最终回复先过一遍人话清洗：代码围栏（iu / html 源码）整段去掉，
 * 不再把半截 JSON 摊在动态里（用户口径：小朋友根本看不懂）。
 */
function taskSummary(task: TaskRecord): string {
  if (task.status === 'running') {
    const live = liveProgressOf(task)
    return live !== null ? live.label : '正在思考'
  }
  const reply = humanizeDetail(task.reply ?? '', 240)
  if (reply !== '') return flatText(reply)
  const steps = actionStepsOf(task)
  if (steps.length > 0) return '完成 ' + String(steps.length) + ' 个动作'
  return flatText(task.prompt)
}

/** 任务行：两种形态共用，保证 card / activity 的点击与读屏信息完全一致。 */
function TaskRow({ task, now, onOpen }: {
  task: TaskRecord
  now: number
  onOpen: (id: string) => void
}): JSX.Element {
  const summary = taskSummary(task)
  const live = liveProgressOf(task)
  const elapsed = formatDuration(Math.max(0, now - task.startedAt))
  const ratio = live !== null && live.total > 0
    ? Math.min(100, Math.round((live.done / live.total) * 100))
    : 0
  /*
   * 动作文字的换字节奏比「每秒重渲染」还快：一条工具刚跑完、下一条已经开始。
   * 直接替换就是一次硬闪（旧字瞬失、新字瞬现），读起来像画面在打嗝。
   * 这里两层叠在同一格里做交叉淡入：旧层淡出的同时新层淡入，任何一帧都有字。
   * prefers-reduced-motion（或总开关关闭）时 motion 为假，useCrossfadeText
   * 只留一层、根本不产生动画——直接替换，不做任何过渡。
   */
  const motion = useMotionAllowed(true)
  const liveLabel = live?.label ?? ''
  const labelLayers = useCrossfadeText(liveLabel, motion)
  const aria = '查看任务详情：' + (task.title !== '' ? task.title : '未命名任务')
    + '（' + STATUS_LABEL[task.status]
    + (live !== null
      ? '，' + live.label + (live.total > 0 ? '，已做 ' + String(live.done) + ' 个动作' : '')
      : '')
    + '）'
  return (
    <div className="pa-taskrec__item" data-running={task.status === 'running' ? 'true' : 'false'}>
      <button
        className="pa-taskrec__row"
        type="button"
        title={task.title + '\n' + summary + '\n' + STATUS_LABEL[task.status] + ' · ' + fullTimeText(task.startedAt)}
        aria-label={aria}
        onClick={() => onOpen(task.id)}
      >
        <span className="pa-taskrec__icon-box" aria-hidden="true">
          <TaskStatusGlyph status={task.status} />
        </span>
        <span className="pa-taskrec__main">
          <span className="pa-taskrec__name">{task.title.trim() !== '' ? task.title : '未命名任务'}</span>
          {live !== null ? (
            <>
              <span className="pa-taskrec__live">
                <span className="pa-taskrec__live-dot" aria-hidden="true" />
                {/*
                 * 动作文案允许折两行：用户口径「文字半截，我需要双行显示」。
                 * 手机 397px 宽时这一行右边还有「已做 N/M · 耗时」，两行才读得全
                 * 一个具体动作（如「正在启动第二个 CodeArts 账号登录」）。
                 */}
                <span className="pa-taskrec__live-label">
                  {labelLayers.map((layer) => (
                    <span
                      key={layer.id}
                      className="pa-taskrec__live-text"
                      data-phase={layer.exiting ? 'out' : 'in'}
                      /* 退场层只是视觉残影：读屏只念当前这一句，旧动作不再念一遍。 */
                      aria-hidden={layer.exiting ? true : undefined}
                    >
                      {layer.text}
                    </span>
                  ))}
                </span>
                <span className="pa-taskrec__live-meta">
                  {live.total > 0 ? '已做 ' + String(live.done) + '/' + String(live.total) + ' · ' : ''}
                  {elapsed}
                </span>
              </span>
              <span className="pa-taskrec__progress" aria-hidden="true">
                <span className="pa-taskrec__progress-fill" style={{ width: ratio + '%' }} />
              </span>
            </>
          ) : (
            summary !== '' ? <span className="pa-taskrec__summary">{summary}</span> : null
          )}
          <span className="pa-taskrec__time">{taskTimeText(task.startedAt, now)}</span>
        </span>
      </button>
    </div>
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
  /** 相对时间的基准时刻：有任务在跑时每秒走一格，全收工后回到每分钟。 */
  const [now, setNow] = useState(() => Date.now())

  const hasRunning = state.tasks.some((task) => task.status === 'running')
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), hasRunning ? 1000 : 60_000)
    return () => window.clearInterval(timer)
  }, [hasRunning])

  /*
   * 过滤 + 倒序 + 截断。
   *
   * 用 startedAt 而不是数组顺序：store 里新记录是 unshift 的，看起来已经有序，
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
                    aria-label={collapsed ? '展开' + group.label + '的任务记录' : '收起' + group.label + '的任务记录'}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <span className="pa-taskrec__group-label">{group.label}</span>
                    <span className="pa-taskrec__group-meta">{group.items.length} 条</span>
                    <span className="pa-taskrec__group-caret" aria-hidden="true">
                      <IconChevronDown size={12} />
                    </span>
                  </button>
                  {collapsed ? null : group.items.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      now={now}
                      onOpen={actions.openTaskDetail}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const headerCount = tasks.length + ' 条'

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
                    <TaskRow
                      key={task.id}
                      task={task}
                      now={now}
                      onOpen={actions.openTaskDetail}
                    />
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
