/**
 * Personal Agent — 任务动作面板（左右两栏）。
 *
 *  · 左栏：一条条动作，说人话、带状态，当前正在做的那条高亮；点任意一条右栏切过去。
 *  · 右栏：除了动作名与进度，还要有「这一步做了什么 / 查到了什么」的人话正文；
 *          收工后显示「摘要」＋ 最终回复 ＋ 产出物格子。
 *  · 只说人话：代码围栏、JSON 骨架、工具参数在 task-action.ts 里清洗掉，
 *    右栏不留展开入口，也不留一片空白。
 *
 * 用在全屏任务详情卡里（左右两栏）。数据来自 TaskRecord.steps（流式事件逐条追加），
 * 本组件只读：now 由宿主每秒推进，运行中未手动选中时右栏自动跟随最新动作，
 * 因此是实时的。
 */
import { useMemo, useState } from 'react'
import { IconFile } from '../icons.tsx'
import { formatDuration, type TaskRecord, type TaskRecordStep } from '../types.ts'
import { actionLabelOf, briefOf, humanizeDetail } from './task-action.ts'
import {
  StatusCheckGlyph,
  StatusCircleGlyph,
  StatusCrossGlyph,
  StatusRunningGlyph,
} from './status-glyph.tsx'

/** 只把真正干活的步骤算动作：工具调用、阶段说明、产出物。 */
export function actionStepsOf(task: TaskRecord): TaskRecordStep[] {
  return task.steps.filter((step) => step.kind === 'tool' || step.kind === 'text' || step.kind === 'output')
}

type StepState = 'running' | 'error' | 'done'

function stateOf(step: TaskRecordStep): StepState {
  if (step.status === 'running') return 'running'
  if (step.status === 'error') return 'error'
  return 'done'
}

function StepGlyph({ state }: { state: StepState }): JSX.Element {
  if (state === 'running') return <StatusRunningGlyph />
  if (state === 'error') return <StatusCrossGlyph />
  if (state === 'done') return <StatusCheckGlyph />
  return <StatusCircleGlyph />
}

/** 收工后的产出物格子：最多 4 个，其余折成 +N。 */
function OutputChips({ steps }: { steps: TaskRecordStep[] }): JSX.Element | null {
  const outputs = steps.filter((step) => step.kind === 'output')
  if (outputs.length === 0) return null
  const shown = outputs.slice(0, 4)
  return (
    <div className="pa-actions__outputs">
      <div className="pa-actions__outputs-title">产出物 {outputs.length} 个</div>
      <div className="pa-actions__outputs-grid">
        {shown.map((step, index) => (
          <span className="pa-actions__output" key={step.id ?? String(index)} title={step.title}>
            <IconFile size={13} />
            <span>{step.title}</span>
          </span>
        ))}
        {outputs.length > shown.length ? (
          <span className="pa-actions__output-more">+{outputs.length - shown.length}</span>
        ) : null}
      </div>
    </div>
  )
}

export interface TaskActionPaneProps {
  task: TaskRecord
  /** 当前时刻（ms），由宿主每秒推进；计时与进度都读它。 */
  now: number
}

export function TaskActionPane({ task, now }: TaskActionPaneProps): JSX.Element {
  const steps = useMemo(() => actionStepsOf(task), [task.steps])
  /** 最后一条还在跑的动作下标；-1 表示此刻没有。 */
  const runningIndex = useMemo(() => {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].status === 'running') return i
    }
    return -1
  }, [steps])
  /** 手动选中的动作；null = 运行中自动跟随最新动作 / 收工看摘要。 */
  const [selected, setSelected] = useState<number | null>(null)
  const activeIndex = selected !== null && selected < steps.length
    ? selected
    : (task.status === 'running' ? runningIndex : -1)
  const active = activeIndex >= 0 ? steps[activeIndex] : undefined
  const done = steps.reduce((n, step) => n + (stateOf(step) === 'done' ? 1 : 0), 0)
  const ratio = steps.length > 0 ? Math.min(100, Math.round((done / steps.length) * 100)) : 0
  const elapsed = formatDuration(Math.max(0, now - task.startedAt))
  /** 收工后的摘要：最终回复也要清掉代码围栏，别露出半截源码。 */
  const reply = humanizeDetail(task.reply ?? '', 260)
  /*
   * 右栏正文只讲这一步自己：工具结果按它自己的字段说人话，
   * 过程文字 / 产出物步骤用自己的正文，绝不复用后面那一步的总结。
   * 全部取不到时给一句明白话，绝不留一片空白。
   */
  const bodyText = active !== undefined
    ? humanizeDetail(active.detail ?? '', 260)
    : reply

  return (
    <div className="pa-actions" data-status={task.status}>
      <aside className="pa-actions__list" aria-label="动作步骤">
        {steps.length === 0 ? (
          <div className="pa-actions__empty">还没有动作，马上开始…</div>
        ) : steps.map((step, index) => {
          const state = stateOf(step)
          const brief = briefOf(step.detail ?? '')
          const key = step.id ?? (String(step.at) + '-' + String(index))
          return (
            <button
              className="pa-actions__step"
              type="button"
              key={key}
              data-state={state}
              data-active={index === activeIndex ? 'true' : 'false'}
              aria-current={state === 'running' ? 'step' : undefined}
              onClick={() => setSelected(index)}
            >
              <span className="pa-actions__step-glyph" aria-hidden="true"><StepGlyph state={state} /></span>
              <span className="pa-actions__step-main">
                <span className="pa-actions__step-label">{actionLabelOf(step)}</span>
                {brief !== '' ? <span className="pa-actions__step-brief">{brief}</span> : null}
              </span>
              {state === 'running' ? <span className="pa-actions__step-now">进行中</span> : null}
            </button>
          )
        })}
      </aside>

      <section className="pa-actions__detail">
        {active !== undefined ? (
          <>
            <div className="pa-actions__kicker">
              {task.status === 'running' && activeIndex === runningIndex ? '正在运行' : '这一步'}
            </div>
            <div className="pa-actions__title">{actionLabelOf(active)}</div>
            <div className="pa-actions__meta">
              第 {activeIndex + 1} / {steps.length} 个动作 · 已完成 {done} 个 · 用时 {elapsed}
            </div>
            <div className="pa-actions__progress"><span style={{ width: ratio + '%' }} /></div>
            <p className="pa-actions__desc">
              {bodyText !== '' ? bodyText : '这一步没有留下文字说明。'}
            </p>
          </>
        ) : (
          <>
            <div className="pa-actions__kicker">摘要</div>
            <p className="pa-actions__desc">
              {reply !== '' ? reply : '完成 ' + String(steps.length) + ' 个动作'}
            </p>
            <OutputChips steps={steps} />
          </>
        )}
      </section>
    </div>
  )
}
