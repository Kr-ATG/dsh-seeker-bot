/**
 * Personal Agent — 任务详情卡（右栏「动态」里点一条任务打开）。
 *
 * 版式（用户 2026-11-05 口径）：顶部状态 badge + 任务标题 + 元信息 chips，
 * 下面**左右两栏**——左栏是动作时间线（人话、状态、当前动作高亮），右栏是
 * 「正在运行：xxx」或收工后的摘要与产出物。原始参数 / 命令 / JSON 默认收起，
 * 点开才看；不再像老版那样把工具参数与围栏源码整段铺在单栏里。
 *
 * 数据全部来自 store 的 TaskRecord（steps 由流式事件逐条写入，见 store 的
 * createTaskRecord / upsertTaskToolStep / finishTaskRecord）。本组件只做展示，
 * 不发任何请求：任务在跑时每秒刷新 now，两栏面板跟着 state 实时换到最新动作。
 *
 * 关闭方式：右上角按钮、Esc、点遮罩空白处，三者都走 requestClose —— 先播
 * 240ms 退场再真正 actions.openTaskDetail(null)，不再是硬消失。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconX } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { formatDuration, type TaskRecord } from '../types.ts'
import { TaskActionPane } from './TaskActionPane.tsx'

/** 任务状态的中文标签（badge 文案）。 */
const STATUS_LABEL: Record<TaskRecord['status'], string> = {
  running: '进行中',
  done: '已完成',
  stopped: '已停止',
  failed: '失败',
}

/** 两位补零。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 开始时间：YYYY-MM-DD HH:mm。 */
function formatDateTime(at: number): string {
  const date = new Date(at)
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' '
    + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

export function TaskDetailModal(): JSX.Element | null {
  const { state, ui, actions } = usePersonal()

  /** 当前打开的任务；null / 找不到对应记录时整卡不渲染。 */
  const task = ui.taskDetailId === null
    ? undefined
    : state.tasks.find((item) => item.id === ui.taskDetailId)
  const open = task !== undefined

  /*
   * 运行中的任务每秒刷新一次「耗时」与右栏进度。
   * 只在 running 时开定时器：已完成任务的耗时是固定值，没必要每秒重渲染。
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

  /** 退场状态：关闭时先播 240ms 退场，再真正关（与 modal-animation.ts 对齐）。 */
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)

  const requestClose = useCallback((): void => {
    if (closeTimerRef.current !== null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setClosing(false)
      actions.openTaskDetail(null)
    }, 240)
  }, [actions])

  /* 卸载时清定时器：卡片可能随任务被删而整个消失。 */
  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  /** Esc 关闭（监听挂在 window：焦点在卡内任何位置都能响应）。 */
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, requestClose])

  if (task === undefined) return null

  /*
   * 派生展示值：耗时收口后读 durationMs，running 时用当前时刻实时算；
   * 关联对象被删了退回 id，不能显示空白——用户会以为详情卡坏了。
   */
  const durationMs = task.durationMs !== undefined
    ? task.durationMs
    : Math.max(0, (task.endedAt ?? now) - task.startedAt)
  const room = task.roomId !== undefined
    ? state.rooms.find((item) => item.id === task.roomId)
    : undefined
  const bot = state.bots.find((item) => item.id === task.botId)
  const relatedLabel = task.roomId !== undefined
    ? '群聊 · ' + (room?.name ?? task.roomId)
    : 'Bot · ' + (bot?.name ?? task.botId)
  const outputText = task.outputCount !== undefined ? String(task.outputCount) + ' 个' : '—'
  const taskTitle = task.title.trim() !== '' ? task.title : '未命名任务'

  return (
    <div
      className="pa-taskdetail-overlay"
      role="presentation"
      data-closing={closing ? '1' : undefined}
      onMouseDown={(event) => {
        // 只有点在遮罩本身（不是卡片内部）才关闭
        if (event.target === event.currentTarget) requestClose()
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
            onClick={requestClose}
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="pa-taskdetail__body" ref={bodyRef}>
          <TaskActionPane task={task} now={now} />
        </div>
      </div>
    </div>
  )
}
