/**
 * iu kind **calculator** 的 React 体（client 专用）。
 *
 * ## Body 契约
 *  · 只渲染「Head 之后」的正文；
 *  · DOM 结构与同名 calculator.ts 里的 `snapshot()` 逐字对齐；
 *  · 本地状态一律走 props 的 `state` / `setState`，刷新持久化。
 */

import { memo, useCallback } from 'react'
import type { IuBodyProps } from './bodies.ts'
import {
  evaluateCalc,
  fillText,
  type CalculatorState,
  type IuCalculatorSpec,
} from './calculator.ts'
import { formatNum } from './core.ts'

export const CalculatorBody = memo(function CalculatorBody(
  { spec, state, setState, onFill }: IuBodyProps<CalculatorState, IuCalculatorSpec>,
): JSX.Element {
  const values = state.values

  const handleInputChange = useCallback((id: string, val: number) => {
    setState(prev => ({
      values: {
        ...prev.values,
        [id]: val,
      },
    }))
  }, [setState])

  const handleFill = useCallback(() => {
    const text = fillText(spec, state)
    if (onFill) {
      onFill(text)
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
    }
  }, [spec, state, onFill])

  return (
    <>
      {spec.desc !== '' && <p className="dtt-iu__desc">{spec.desc}</p>}
      
      {/* 动态计算结果输出展示 */}
      <div className="dtt-iu__calc-outputs">
        {spec.outputs.map((o, idx) => {
          const val = evaluateCalc(o.calc, values)
          const isHl = !!o.highlight
          return (
            <div
              key={o.id || idx}
              className={`dtt-iu__calc-out${isHl ? ' dtt-iu__calc-out--hl' : ''}`}
            >
              <span className="dtt-iu__calc-out-label">{o.label}</span>
              <span className="dtt-iu__calc-out-val">
                {formatNum(val)}{o.unit}
              </span>
            </div>
          )
        })}
      </div>

      {/* 交互输入滑块与数值调节 */}
      <div className="dtt-iu__calc-inputs">
        {spec.inputs.map(inp => {
          const curVal = values[inp.id] ?? inp.value
          return (
            <div key={inp.id} className="dtt-iu__calc-in-row">
              <div className="dtt-iu__calc-in-head">
                <span>{inp.label}</span>
                <span className="dtt-iu__calc-in-val">
                  {formatNum(curVal)}{inp.unit}
                </span>
              </div>
              <input
                type="range"
                className="dtt-iu__range"
                min={inp.min}
                max={inp.max}
                step={inp.step}
                value={curVal}
                aria-label={inp.label}
                onChange={e => handleInputChange(inp.id, Number(e.currentTarget.value))}
              />
            </div>
          )
        })}
      </div>

      {/* 结果回写动作按钮 */}
      {onFill !== undefined && (
        <div className="dtt-iu__calc-actions">
          <button
            type="button"
            className="dtt-iu__calc-btn"
            onClick={handleFill}
          >
            {spec.submitLabel}
          </button>
        </div>
      )}
    </>
  )
})
