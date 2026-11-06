/**
 * iu kind **checklist** 的 React 体（client 专用）。
 *
 * 支持两种模式：
 *  1. interactive: true（默认）：可勾选、带进度条与已完成计数；
 *  2. interactive: false：只读步骤/建议清单，仅供审阅浏览，不带勾选框与催促进度。
 */

import { memo } from 'react'
import type { IuBodyProps } from './bodies.ts'
import type { IuChecklistSpec, ChecklistState } from './checklist.ts'

export const ChecklistBody = memo(function ChecklistBody(
  { spec, state, setState }: IuBodyProps<ChecklistState, IuChecklistSpec>,
): JSX.Element {
  const checked = new Set(state.checked)
  const toggle = (i: number): void => {
    setState((prev) => {
      const set = new Set(prev.checked)
      if (set.has(i)) set.delete(i)
      else set.add(i)
      return { checked: [...set].sort((a, b) => a - b) }
    })
  }

  // 只读步骤模式：纯浏览、不打勾、无 0/N 催促
  if (spec.interactive === false) {
    return (
      <div className="dtt-iu__checklist-static">
        {spec.items.map((item, i) => (
          <div key={i} className="dtt-iu__check dtt-iu__check--static">
            <span className="dtt-iu__step-num" aria-hidden="true">{i + 1}</span>
            <span>
              <b>{item.label}</b>
              {item.desc !== '' && <small>{item.desc}</small>}
            </span>
          </div>
        ))}
      </div>
    )
  }

  const pct = spec.items.length === 0 ? 0 : (checked.size / spec.items.length) * 100
  return (
    <>
      <div className="dtt-iu__progress" aria-hidden>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="dtt-iu__count">{checked.size}/{spec.items.length} 已完成</div>
      <div>
        {spec.items.map((item, i) => (
          <button
            key={i}
            type="button"
            className="dtt-iu__check"
            data-on={checked.has(i) ? '1' : undefined}
            aria-pressed={checked.has(i)}
            onClick={() => { toggle(i) }}
          >
            <span className="dtt-iu__box" aria-hidden>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.8 5.2 4 7.4 8.2 2.6" />
              </svg>
            </span>
            <span>
              <b>{item.label}</b>
              {item.desc !== '' && <small>{item.desc}</small>}
            </span>
          </button>
        ))}
      </div>
    </>
  )
})
