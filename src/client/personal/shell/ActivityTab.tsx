/**
 * Personal Agent — 右栏「动态」分类页。
 *
 * 用户口径（2026-11-04）：右栏增加分类 tab，第一个分类「动态」里要同时看到
 * 「定时任务」与「任务记录」——参考图上半部分是定时任务清单，下半部分是按天
 * 分组的任务流水。
 *
 * 结构：
 *   1. 定时任务区 —— 读 state.routines，按当前 Bot 过滤；可折叠，行 = 圆角图标块
 *      + 名称 + 频率文案；列表为空时整区不渲染，底部「查看全部定时任务」跳到
 *      Bot 设置卡；
 *   2. 任务记录 —— 复用 TaskRecordCard 的 activity 变体（无卡头、按天分组、每组
 *      可折叠），点击行仍打开任务详情。
 *
 * 视觉延续「Bot 右栏去卡框」口径：只用留白、发丝线与圆角图标块分组，不套白底
 * 圆角卡框。所有颜色走 --pa-* token，深浅主题自动跟随。
 */
import { useMemo, useState } from 'react'
import { IconChevronDown, IconClock } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import type { Routine, RoutineSchedule } from '../types.ts'
import { TaskRecordCard } from './TaskRecordCard.tsx'

/** 周几的单字标签：与 Bot 设置卡的「每周一」口径一致。 */
const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六']

/** 两位补零（时间格式化用）。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 一次性任务的具体日期时间。
 *
 * 与「每 30 分钟 / 每天 09:00」不同，一次性任务没有周期可读，日期才是它的
 * 关键信息；今年内省掉年份避免行太长，跨年才补上。
 */
function formatOnceAt(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '时间待定'
  const now = new Date()
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${clock}`
    : `${date.getFullYear()}年${day} ${clock}`
}

/**
 * 定时任务频率的中文展示。
 *
 * 与 Bot 设置卡同一口径（interval / daily / weekly），另外把 once 从「一次性 ·
 * HH:mm」补成带日期的完整文案——右栏清单里没有别的地方能看出它是哪天。
 */
export function routineFrequencyText(schedule: RoutineSchedule): string {
  if (schedule.kind === 'interval') {
    if (schedule.everyMinutes >= 60 && schedule.everyMinutes % 60 === 0) {
      return `每 ${schedule.everyMinutes / 60} 小时`
    }
    return `每 ${schedule.everyMinutes} 分钟`
  }
  if (schedule.kind === 'daily') return `每天 ${schedule.time}`
  if (schedule.kind === 'weekly') {
    const days = schedule.weekdays.map((day) => WEEK_LABELS[day % 7]).join('、')
    return days === '' ? `每周 ${schedule.time}` : `每周${days} ${schedule.time}`
  }
  return `一次性 · ${formatOnceAt(schedule.at)}`
}

/** 排序：启用的在前，其次按下次执行时间，最后按创建时间兜底。 */
function compareRoutines(a: Routine, b: Routine): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
  const aNext = a.nextAt ?? Number.MAX_SAFE_INTEGER
  const bNext = b.nextAt ?? Number.MAX_SAFE_INTEGER
  if (aNext !== bNext) return aNext - bNext
  return a.createdAt - b.createdAt
}

export interface ActivityTabProps {
  /** 当前 Bot id：定时任务与任务记录都按它过滤。 */
  botId: string
  /** 群聊任务作用域；私聊时为空，任务记录只看这个 Bot 的私聊记录。 */
  roomId?: string
}

export function ActivityTab({ botId, roomId }: ActivityTabProps): JSX.Element {
  const { state, actions } = usePersonal()
  /** 定时任务区折叠状态：只属于这一次查看，不落盘。 */
  const [open, setOpen] = useState(true)

  const routines = useMemo(() => {
    const list = state.routines.filter((routine) => routine.botId === botId)
    return [...list].sort(compareRoutines)
  }, [state.routines, botId])

  /*
   * 没有定时任务时整区隐藏（参考图的「空列表不占位」口径）：不要给用户看一个
   * 永远空着的标题，也不要让「查看全部」指向一个没有内容的设置分区。
   */
  return (
    <>
      {routines.length > 0 ? (
        <section className="pa-routines" data-open={open ? 'true' : 'false'} aria-label="定时任务">
          <button
            className="pa-routines__head"
            type="button"
            aria-expanded={open}
            aria-label={open ? '收起定时任务' : '展开定时任务'}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="pa-routines__title">{routines.length} 个定时任务</span>
            <span className="pa-routines__caret" aria-hidden="true">
              <IconChevronDown size={13} />
            </span>
          </button>
          {open ? (
            <div className="pa-routines__body">
              <div className="pa-routines__list">
                {routines.map((routine) => {
                  const freq = routineFrequencyText(routine.schedule)
                  return (
                    <div
                      className="pa-routines__row"
                      key={routine.id}
                      data-enabled={routine.enabled ? 'true' : 'false'}
                      title={`${routine.name}\n${freq}${routine.enabled ? '' : '\n已暂停'}`}
                    >
                      <span className="pa-routines__icon" aria-hidden="true">
                        <IconClock size={14} />
                      </span>
                      <span className="pa-routines__main">
                        <span className="pa-routines__name">
                          {routine.name.trim() !== '' ? routine.name : '未命名定时任务'}
                        </span>
                        <span className="pa-routines__freq">
                          {freq}
                          {routine.enabled ? '' : ' · 已暂停'}
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
              <button
                className="pa-routines__all"
                type="button"
                onClick={() => actions.openBotSettings(botId)}
              >
                查看全部定时任务
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      <TaskRecordCard botId={botId} roomId={roomId} variant="activity" />
    </>
  )
}
