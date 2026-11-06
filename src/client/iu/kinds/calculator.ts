/**
 * iu kind: **calculator**（即时微计算器 / 参数联动推演）。
 *
 * 专门面向「即时生成工具（Make a tool for the moment）」场景：
 * 账单 AA 分摊、贷款试算、服务费测算、投资复利、云资源配额成本等。
 *
 * 纯逻辑半边：零 React、零 DOM、安全无 eval 算术求值。
 */

import type { IuKind, IuSpecBase, IuState } from './contract.ts'
import { esc, formatNum, num, pickAll, str } from './core.ts'

export interface IuCalcInput {
  readonly id: string
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly unit: string
}

export interface IuCalcOutput {
  readonly id?: string
  readonly label: string
  readonly calc: string
  readonly unit: string
  readonly highlight?: boolean
}

export interface IuCalculatorSpec extends IuSpecBase {
  readonly kind: 'calculator'
  readonly title: string
  readonly desc: string
  readonly inputs: readonly IuCalcInput[]
  readonly outputs: readonly IuCalcOutput[]
  readonly submitLabel: string
}

export interface CalculatorState extends IuState {
  readonly values: Record<string, number>
}

/** 安全递归下降算术求值器（零 eval，防除零，防 NaN）。 */
export function evaluateCalc(expr: string, vars: Record<string, number>): number {
  let pos = 0
  const s = expr.replace(/\s+/g, '')

  function parseExpression(): number {
    let res = parseTerm()
    while (pos < s.length && (s[pos] === '+' || s[pos] === '-')) {
      const op = s[pos++]
      const right = parseTerm()
      if (op === '+') res += right
      else res -= right
    }
    return res
  }

  function parseTerm(): number {
    let res = parseFactor()
    while (pos < s.length && (s[pos] === '*' || s[pos] === '/' || s[pos] === '%')) {
      const op = s[pos++]
      const right = parseFactor()
      if (op === '*') res *= right
      else if (op === '/') res = right !== 0 ? res / right : 0
      else if (op === '%') res = right !== 0 ? res % right : 0
    }
    return res
  }

  function parseFactor(): number {
    if (pos >= s.length) return 0
    if (s[pos] === '-') {
      pos++
      return -parseFactor()
    }
    if (s[pos] === '+') {
      pos++
      return parseFactor()
    }
    if (s[pos] === '(') {
      pos++
      const val = parseExpression()
      if (pos < s.length && s[pos] === ')') pos++
      return val
    }

    const numMatch = s.slice(pos).match(/^[0-9]+(\.[0-9]+)?/)
    if (numMatch) {
      pos += numMatch[0].length
      return parseFloat(numMatch[0])
    }

    const idMatch = s.slice(pos).match(/^[a-zA-Z_][a-zA-Z0-9_]*/)
    if (idMatch) {
      const id = idMatch[0]
      pos += id.length
      if (pos < s.length && s[pos] === '(') {
        pos++
        const args: number[] = []
        if (pos < s.length && s[pos] !== ')') {
          args.push(parseExpression())
          while (pos < s.length && s[pos] === ',') {
            pos++
            args.push(parseExpression())
          }
        }
        if (pos < s.length && s[pos] === ')') pos++

        if (id === 'round') return Math.round(args[0] ?? 0)
        if (id === 'floor') return Math.floor(args[0] ?? 0)
        if (id === 'ceil') return Math.ceil(args[0] ?? 0)
        if (id === 'abs') return Math.abs(args[0] ?? 0)
        if (id === 'min') return Math.min(...args)
        if (id === 'max') return Math.max(...args)
        return args[0] ?? 0
      }
      return vars[id] ?? 0
    }

    pos++
    return 0
  }

  const result = parseExpression()
  return Number.isFinite(result) ? result : 0
}

function parse(raw: Record<string, unknown>): IuCalculatorSpec | undefined {
  const title = str(raw.title, 40) || '计算器'
  const desc = str(raw.desc, 100)
  const submitLabel = str(raw.submitLabel, 16) || '填入输入框'

  const inputs = pickAll<IuCalcInput>(raw.inputs, 8, (it, idx) => {
    const id = str(it.id, 16) || ('v' + (idx + 1))
    const label = str(it.label, 20) || id
    let min = num(it.min, -1000000000, 1000000000, 0)
    let max = num(it.max, -1000000000, 1000000000, 100)
    if (!(max > min)) max = min + 10
    const stepRaw = num(it.step, 0, 1000000, 1)
    const step = stepRaw > 0 ? stepRaw : 1
    const value = Math.min(max, Math.max(min, num(it.value, min, max, min)))
    const unit = str(it.unit, 8)
    return { id, label, value, min, max, step, unit }
  })

  if (inputs.length === 0) return undefined

  const outputs = pickAll<IuCalcOutput>(raw.outputs, 6, (it, idx) => {
    const label = str(it.label, 20) || ('结果' + (idx + 1))
    const calc = str(it.calc, 120)
    if (calc === '') return undefined
    const unit = str(it.unit, 8)
    const highlight = !!it.highlight
    const id = str(it.id, 16)
    return { id: id !== '' ? id : undefined, label, calc, unit, highlight }
  })

  if (outputs.length === 0) return undefined

  return {
    kind: 'calculator',
    title,
    desc,
    inputs,
    outputs,
    submitLabel
  }
}

function initState(spec: IuCalculatorSpec): CalculatorState {
  const values: Record<string, number> = {}
  for (const inp of spec.inputs) {
    values[inp.id] = inp.value
  }
  return { values }
}

export function fillText(spec: IuCalculatorSpec, state: CalculatorState): string {
  const inStr = spec.inputs
    .map(i => `${i.label} ${formatNum(state.values[i.id] ?? i.value)}${i.unit}`)
    .join('，')
  const outStr = spec.outputs
    .map(o => {
      const v = evaluateCalc(o.calc, state.values)
      return `${o.label} ${formatNum(v)}${o.unit}`
    })
    .join('，')
  return `${spec.title}：${inStr} → ${outStr}`
}

function snapshot(spec: IuCalculatorSpec): string {
  const desc = spec.desc !== '' ? `<p class="dtt-iu__desc">${esc(spec.desc)}</p>` : ''
  const vars: Record<string, number> = {}
  for (const i of spec.inputs) vars[i.id] = i.value

  const outsHtml = spec.outputs.map(o => {
    const v = evaluateCalc(o.calc, vars)
    const hl = o.highlight ? ' dtt-iu__calc-out--hl' : ''
    return `<div class="dtt-iu__calc-out${hl}">
      <span class="dtt-iu__calc-out-label">${esc(o.label)}</span>
      <span class="dtt-iu__calc-out-val">${formatNum(v)}${esc(o.unit)}</span>
    </div>`
  }).join('')

  const inpsHtml = spec.inputs.map(i => {
    return `<div class="dtt-iu__calc-in-row">
      <div class="dtt-iu__calc-in-head">
        <span>${esc(i.label)}</span>
        <span class="dtt-iu__calc-in-val">${formatNum(i.value)}${esc(i.unit)}</span>
      </div>
      <input type="range" class="dtt-iu__range" min="${i.min}" max="${i.max}" step="${i.step}" value="${i.value}" disabled />
    </div>`
  }).join('')

  return `${desc}
  <div class="dtt-iu__calc-outputs">${outsHtml}</div>
  <div class="dtt-iu__calc-inputs">${inpsHtml}</div>`
}

const css = `
.dtt-iu__calc-outputs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}
.dtt-iu__calc-out {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsh-fill, rgba(140, 140, 160, 0.08));
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid transparent;
  transition: all 0.2s ease;
}
.dtt-iu__calc-out--hl {
  background: rgba(59, 130, 246, 0.12);
  border-color: rgba(59, 130, 246, 0.35);
}
.dtt-iu__calc-out-label {
  font-size: 11px;
  color: var(--dsh-muted, rgba(140, 145, 160, 0.8));
}
.dtt-iu__calc-out-val {
  font-size: 18px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsh-accent, #3b82f6);
}
.dtt-iu__calc-inputs {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dtt-iu__calc-in-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dtt-iu__calc-in-head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.dtt-iu__calc-in-val {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dtt-iu__calc-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed var(--dsh-border, rgba(140, 140, 160, 0.2));
}
.dtt-iu__calc-btn {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid rgba(59, 130, 246, 0.4);
  background: rgba(59, 130, 246, 0.12);
  color: var(--dsh-accent, #3b82f6);
  transition: all 0.15s ease;
}
.dtt-iu__calc-btn:hover {
  background: rgba(59, 130, 246, 0.22);
}
`

const doc = `· calculator 计算器：{"kind":"calculator","title":"AA分账计算器","inputs":[{"id":"total","label":"账单总额","value":1280,"min":0,"max":10000,"step":10,"unit":"元"},{"id":"count","label":"人数","value":6,"min":1,"max":20,"unit":"人"}],"outputs":[{"label":"人均应付","calc":"total/count","unit":"元","highlight":true}],"desc":"拖动调节人数与总额"}（约束：inputs≤8、outputs≤6、calc支持四则运算与round/floor/min/max等，支持submitLabel）`

export const calculatorKind: IuKind<CalculatorState, IuCalculatorSpec> = {
  kind: 'calculator',
  label: '计算器',
  parse,
  initState,
  fillText,
  snapshot,
  css: css,
  doc: doc
}
