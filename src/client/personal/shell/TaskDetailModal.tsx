/**
 * Personal Agent — 任务详情卡（Work 模式过程时间线）。
 *
 * 从右栏「任务记录」点一行打开：`ui.taskDetailId` 指向 `state.tasks` 里的一条，
 * 本组件按它渲染全屏遮罩 + 居中大卡。没有对应任务时直接不渲染（不占 DOM）。
 *
 * 版式照 Work 模式的回合过程（用户 2026-11-02 口径）：单栏时间线，每条步骤是
 * 「左侧细线图标 + 灰色小标题 + 下面一段正文」：
 *  · start  → 已开始（正文 = 用户请求原文）；
 *  · tool   → 按工具类型给图标 + 中文动作标题（已读取文件 / 正在执行命令…），
 *             下面一行参数摘要；完整参数与结果默认折叠，点整行展开；
 *  · text   → 分析（正文 = 模型的过程说明）；
 *  · output → 文件名（正文 = 产出物路径 / 大小）；
 *  · end    → 任务完成 / 任务已停止 / 任务失败（正文 = 失败原因）；
 *  · 底部   → 最终回复（有 reply 时）与「深度求索中，用时 X」（running 时）。
 *
 * 顶部只保留状态 badge、任务标题与一行元信息 chips；不再使用 task.overview
 * （模型的任务计划已改由提示词与 store 写成过程步骤，UI 以 steps 为准）。
 *
 * 数据全部来自 store 的 TaskRecord（steps 由流式事件逐条写入，见 store 的
 * createTaskRecord / upsertTaskToolStep / finishTaskRecord），本组件只做展示，
 * 不发任何请求。
 *
 * 关闭方式：右上角按钮、Esc、点遮罩空白处，三者都调 actions.openTaskDetail(null)。
 */

import { useEffect, useRef, useState } from 'react'
import {
  IconBook,
  IconFile,
  IconImage,
  IconListTodo,
  IconMemory,
  IconSearch,
  IconTerminal,
  IconX,
} from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { formatDuration, type TaskRecord, type TaskRecordStep } from '../types.ts'
import {
  STATUS_ICON_SIZE,
  StatusCheckGlyph,
  StatusCircleGlyph,
  StatusCrossGlyph,
  StatusRunningGlyph,
} from './status-glyph.tsx'

/** 任务状态的中文标签（badge 文案）。 */
const STATUS_LABEL: Record<TaskRecord['status'], string> = {
  running: '进行中',
  done: '已完成',
  stopped: '已停止',
  failed: '失败',
}

/**
 * 工具名 → 中文动作（动词短语）。
 *
 * 放在组件内部而不是引 plain-language.ts：这里只需要「过程时间线」这一种语气，
 * 引入通用文案表反而要处理它那套更长的模板。规则按前缀 / 精确名匹配，命中第一条。
 */
const TOOL_ACTION_RULES: Array<{ test: RegExp; action: string }> = [
  { test: /^(read|read_file|read_text_file|view)$/i, action: '读取文件' },
  { test: /^(write|write_file|create_file)$/i, action: '写入文件' },
  { test: /^(edit|edit_file|str_replace_editor|apply_patch|replace)$/i, action: '修改文件' },
  { test: /^(grep|glob|find|search|search_files)$/i, action: '搜索内容' },
  { test: /^(pwsh|bash|shell|exec_command|run_command|terminal)$/i, action: '执行命令' },
  { test: /^web_search$/i, action: '搜索网络' },
  { test: /^web_fetch$/i, action: '读取网页' },
  { test: /^generate_image$/i, action: '生成图片' },
  { test: /^generate_video$/i, action: '生成视频' },
  { test: /^memory_/i, action: '检索记忆' },
  { test: /^(task_state|todo_write)$/i, action: '更新任务清单' },
]

/** 两位补零。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 开始时间：YYYY-MM-DD HH:mm。 */
function formatDateTime(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 工具名 → 中文动作；不认识的工具统一「执行操作」。 */
function toolActionOf(name: string): string {
  const trimmed = name.trim()
  for (const rule of TOOL_ACTION_RULES) {
    if (rule.test.test(trimmed)) return rule.action
  }
  return '执行操作'
}

/**
 * 工具步骤的标题：完成「已读取文件」、进行中「正在读取文件」、失败「读取文件失败」。
 *
 * 用「已 / 正在 / 失败」而不是状态色：与 status-glyph 的中性图标同一口径，
 * 灰度截图与色觉差异下也能读。
 */
function toolTitleOf(step: TaskRecordStep): string {
  const action = toolActionOf(step.title)
  if (step.status === 'running') return `正在${action}`
  if (step.status === 'error') return `${action}失败`
  return `已${action}`
}

/** 工具类型图标（细线）：文件 / 终端 / 搜索 / 网页 / 图片 / 记忆 / 清单 / 其他。 */
function ToolGlyph({ name }: { name: string }): JSX.Element {
  const lower = name.trim().toLowerCase()
  if (/^(read|read_file|read_text_file|view|write|write_file|create_file|edit|edit_file|str_replace_editor|apply_patch|replace)$/.test(lower)) {
    return <IconFile size={STATUS_ICON_SIZE} />
  }
  if (/^(grep|glob|find|search|search_files|web_search)$/.test(lower)) {
    return <IconSearch size={STATUS_ICON_SIZE} />
  }
  if (/^(pwsh|bash|shell|exec_command|run_command|terminal)$/.test(lower)) {
    return <IconTerminal size={STATUS_ICON_SIZE} />
  }
  if (lower === 'web_fetch') return <IconBook size={STATUS_ICON_SIZE} />
  if (/^(generate_image|generate_video)$/.test(lower)) return <IconImage size={STATUS_ICON_SIZE} />
  if (lower.startsWith('memory_')) return <IconMemory size={STATUS_ICON_SIZE} />
  if (lower === 'task_state' || lower === 'todo_write') return <IconListTodo size={STATUS_ICON_SIZE} />
  return <IconTerminal size={STATUS_ICON_SIZE} />
}

/** 非工具步骤的图标：start 空心圆、text 勾、output 文件、end 按任务状态。 */
function EventGlyph({ step, taskStatus }: {
  step: TaskRecordStep
  taskStatus: TaskRecord['status']
}): JSX.Element {
  if (step.kind === 'output') return <IconFile size={STATUS_ICON_SIZE} />
  if (step.kind === 'text') return <StatusCheckGlyph />
  if (step.kind === 'end') {
    if (taskStatus === 'done') return <StatusCheckGlyph />
    if (taskStatus === 'failed') return <StatusCrossGlyph />
    return <StatusCircleGlyph />
  }
  return <StatusCircleGlyph />
}

/** 非工具步骤的灰色小标题。 */
function eventTitleOf(step: TaskRecordStep, taskStatus: TaskRecord['status']): string {
  if (step.kind === 'start') return '已开始'
  if (step.kind === 'text') return '分析'
  if (step.kind === 'output') return step.title.trim() !== '' ? step.title : '产出物'
  if (step.kind === 'end') {
    if (taskStatus === 'done') return '任务完成'
    if (taskStatus === 'stopped') return '任务已停止'
    if (taskStatus === 'failed') return '任务失败'
    return '收尾'
  }
  const title = step.title.trim()
  return title !== '' ? title : '过程'
}

/**
 * 工具步骤的折叠区：摘要一行 + 「展开」，点整行切换。
 *
 * 工具输出动辄几十行，全展开会把时间线撑爆；折叠后先给参数摘要，需要审计时再
 * 展开。展开内容用等宽字体并限高（50vh），长日志也不会把弹卡变成终端。
 */
function ToolDetail({ detail }: { detail: string }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const summary = detail.replace(/\s+/g, ' ').trim()
  if (summary === '') return null
  return (
    <div className="pa-taskdetail__tool" data-open={open ? 'true' : 'false'}>
      <button
        className="pa-taskdetail__tool-head"
        type="button"
        aria-expanded={open}
        aria-label={open ? '收起工具参数与结果' : '展开工具参数与结果'}
        title={detail}
        onClick={() => setOpen((value) => !value)}
      >
        <code className="pa-taskdetail__tool-summary">{summary}</code>
        <span className="pa-taskdetail__tool-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open ? <pre className="pa-taskdetail__tool-body">{detail}</pre> : null}
    </div>
  )
}

/**
 * 时间线里的一条事件。
 *
 * 工具步骤与普通步骤共用外层结构（图标 + 标题 + 正文），只在正文渲染上分叉：
 * 工具是「摘要 + 折叠全文」，其余是直接展示的段落。
 */
function TaskEvent({ step, taskStatus, errorText }: {
  step: TaskRecordStep
  taskStatus: TaskRecord['status']
  errorText: string
}): JSX.Element {
  if (step.kind === 'tool') {
    return (
      <div className="pa-taskdetail__event" data-kind="tool" data-status={step.status}>
        <div className="pa-taskdetail__event-head">
          <span className="pa-taskdetail__glyph"><ToolGlyph name={step.title} /></span>
          <span className="pa-taskdetail__event-title">{toolTitleOf(step)}</span>
        </div>
        <ToolDetail detail={step.detail ?? ''} />
      </div>
    )
  }
  const detail = step.detail !== undefined ? step.detail.trim() : ''
  /*
   * 收尾步骤的正文是失败原因：store 会写进 end.detail，缺失时退回 task.error，
   * 免得「任务失败」下面什么都没有。
   */
  const text = detail !== '' ? detail : (step.kind === 'end' ? errorText : '')
  const status = step.kind === 'end'
    ? (taskStatus === 'done' ? 'ok' : taskStatus === 'failed' ? 'error' : 'stopped')
    : undefined
  return (
    <div className="pa-taskdetail__event" data-kind={step.kind} data-status={status}>
      <div className="pa-taskdetail__event-head">
        <span className="pa-taskdetail__glyph"><EventGlyph step={step} taskStatus={taskStatus} /></span>
        <span className="pa-taskdetail__event-title">{eventTitleOf(step, taskStatus)}</span>
      </div>
      {text !== '' ? <div className="pa-taskdetail__event-text">{text}</div> : null}
    </div>
  )
}

export function TaskDetailModal(): JSX.Element | null {
  const { state, ui, actions } = usePersonal()

  /** 当前打开的任务；null / 找不到对应记录时整卡不渲染。 */
  const task = ui.taskDetailId === null
    ? undefined
    : state.tasks.find((item) => item.id === ui.taskDetailId)
  const open = task !== undefined

  /*
   * 运行中的任务每秒刷新一次「耗时」。
   *
   * 只在 running 时开定时器：已完成任务的耗时是固定值，没必要为它每秒重渲染。
   * now 同时兜底 durationMs 缺失的旧数据。
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open || task?.status !== 'running') return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open, task?.status])

  /** 正文滚动容器：切换任务时收回顶部，否则会停在旧任务的过程位置。 */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (bodyRef.current !== null) bodyRef.current.scrollTop = 0
  }, [ui.taskDetailId])

  /** Esc 关闭（监听挂在 window：焦点在卡内任何位置都能响应）。 */
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') actions.openTaskDetail(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, actions])

  if (task === undefined) return null

  /*
   * 派生展示值。
   *  · 耗时：收口后读 durationMs；running 时用当前时刻实时算。
   *  · 关联对象：群任务显示群名，私聊显示 Bot 名；对象被删了退回 id，
   *    不能显示空白——用户会以为详情卡坏了。
   */
  const durationMs = task.durationMs !== undefined
    ? task.durationMs
    : Math.max(0, (task.endedAt ?? now) - task.startedAt)
  const room = task.roomId !== undefined
    ? state.rooms.find((item) => item.id === task.roomId)
    : undefined
  const bot = state.bots.find((item) => item.id === task.botId)
  const relatedLabel = task.roomId !== undefined
    ? `群聊 · ${room?.name ?? task.roomId}`
    : `Bot · ${bot?.name ?? task.botId}`
  const outputText = task.outputCount !== undefined ? `${task.outputCount} 个` : '—'
  const taskTitle = task.title.trim() !== '' ? task.title : '未命名任务'
  const reasonText = task.error !== undefined ? task.error.trim() : ''
  const replyText = task.reply !== undefined ? task.reply.trim() : ''
  const hasSteps = task.steps.length > 0

  return (
    <div
      className="pa-taskdetail-overlay"
      role="presentation"
      onMouseDown={(event) => {
        // 只有点在遮罩本身（不是卡片内部）才关闭
        if (event.target === event.currentTarget) actions.openTaskDetail(null)
      }}
    >
      <div
        className="pa-taskdetail-card"
        role="dialog"
        aria-modal="true"
        aria-label="任务详情"
      >
        <div className="pa-taskdetail__head">
          <div className="pa-taskdetail__head-main">
            <span className="pa-taskdetail__badge" data-status={task.status}>
              {STATUS_LABEL[task.status]}
            </span>
            <div className="pa-taskdetail__name">{taskTitle}</div>
            <div className="pa-taskdetail__meta">
              <span className="pa-taskdetail__meta-item">
                <span className="pa-taskdetail__meta-key">耗时</span>
                <span className="pa-taskdetail__meta-val">{formatDuration(durationMs)}</span>
              </span>
              <span className="pa-taskdetail__meta-item">
                <span className="pa-taskdetail__meta-key">开始</span>
                <span className="pa-taskdetail__meta-val">{formatDateTime(task.startedAt)}</span>
              </span>
              <span className="pa-taskdetail__meta-item" title={relatedLabel}>
                <span className="pa-taskdetail__meta-key">关联</span>
                <span className="pa-taskdetail__meta-val">{relatedLabel}</span>
              </span>
              <span className="pa-taskdetail__meta-item">
                <span className="pa-taskdetail__meta-key">产出物</span>
                <span className="pa-taskdetail__meta-val">{outputText}</span>
              </span>
            </div>
          </div>
          <button
            className="pa-taskdetail__close"
            type="button"
            title="关闭"
            aria-label="关闭任务详情"
            onClick={() => actions.openTaskDetail(null)}
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="pa-taskdetail__body" ref={bodyRef}>
          {hasSteps ? (
            <div className="pa-taskdetail__timeline">
              {task.steps.map((step, index) => (
                <TaskEvent
                  key={`${task.id}:${step.kind}:${step.id ?? `idx-${index}`}`}
                  step={step}
                  taskStatus={task.status}
                  errorText={reasonText}
                />
              ))}
            </div>
          ) : null}

          {!hasSteps && replyText === '' && task.status !== 'running' ? (
            <div className="pa-taskdetail__empty">这一轮还没有记录到过程</div>
          ) : null}

          {replyText !== '' ? (
            <div className="pa-taskdetail__reply">
              <div className="pa-taskdetail__reply-title">最终回复</div>
              <div className="pa-taskdetail__reply-text">{task.reply}</div>
            </div>
          ) : null}

          {task.status === 'running' ? (
            <div className="pa-taskdetail__running">
              <StatusRunningGlyph />
              <span>深度求索中，用时 {formatDuration(durationMs)}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
