/**
 * iu kind: **chart**（现代交互式动态图表看板）。
 *
 * 专门面向「数据对比与图表联动」场景：
 * 柱状对比（Bar）、趋势折线（Line）、环形占比（Donut）与明细表（Table）平滑切换。
 * 遵循用户最喜爱的现代交互看板风格：顶部指标卡、微徽标、Chips 视图切换、纯内联高质感 SVG。
 *
 * 纯逻辑半边：零 React、零外部依赖。
 */

import type { IuKind, IuSpecBase, IuState } from './contract.ts'
import { arr, esc, formatNum, num, pickAll, str } from './core.ts'

export type ChartMode = 'bar' | 'line' | 'donut'

export interface IuChartMetric {
  readonly label: string
  readonly value: string
  readonly sub?: string
}

export interface IuChartSeries {
  readonly name: string
  readonly color?: string
  readonly data: readonly number[]
}

export interface IuChartSpec extends IuSpecBase {
  readonly kind: 'chart'
  readonly title: string
  readonly desc: string
  readonly mode: ChartMode
  readonly allowSwitch: boolean
  readonly unit: string
  readonly categories: readonly string[]
  readonly series: readonly IuChartSeries[]
  readonly metrics: readonly IuChartMetric[]
}

export interface ChartState extends IuState {
  readonly currentMode: 'bar' | 'line' | 'donut' | 'table'
  readonly hoverIndex: number | null
}

const DEFAULT_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']

function parse(raw: Record<string, unknown>): IuChartSpec | undefined {
  const title = str(raw.title, 40) || '数据看板'
  const desc = str(raw.desc, 100)
  const unit = str(raw.unit, 8)
  const allowSwitch = raw.allowSwitch !== false

  const rawMode = str(raw.mode, 8)
  const mode: ChartMode = (rawMode === 'line' || rawMode === 'donut') ? rawMode : 'bar'

  // x 轴标签 / 维度（最多 12 项，纯字符串数组）
  const rawCats = arr(raw.categories)
  const categories: string[] = []
  for (let i = 0; i < Math.min(rawCats.length, 12); i++) {
    const val = str(rawCats[i], 24)
    if (val !== '') categories.push(val)
  }
  if (categories.length === 0) return undefined

  // 数据系列（最多 4 组）
  const series = pickAll<IuChartSeries>(raw.series, 4, (s, sIdx) => {
    const name = str(s.name, 16) || ('系列' + (sIdx + 1))
    const color = str(s.color, 24) || DEFAULT_PALETTE[sIdx % DEFAULT_PALETTE.length]
    const rawData = Array.isArray(s.data) ? s.data : []
    const data = categories.map((_, i) => num(rawData[i], -1000000000, 1000000000, 0))
    return { name, color, data }
  })
  if (series.length === 0) return undefined

  // 顶部指标卡（最多 4 项）
  const metrics = pickAll<IuChartMetric>(raw.metrics, 4, (m) => {
    const label = str(m.label, 16)
    const value = str(m.value, 20)
    if (label === '' && value === '') return undefined
    const sub = str(m.sub, 24)
    return { label, value, sub: sub !== '' ? sub : undefined }
  })

  return {
    kind: 'chart',
    title,
    desc,
    mode,
    allowSwitch,
    unit,
    categories,
    series,
    metrics
  }
}

function initState(spec: IuChartSpec): ChartState {
  return {
    currentMode: spec.mode,
    hoverIndex: null
  }
}

export function fillText(spec: IuChartSpec, _state: ChartState): string {
  const s0 = spec.series[0]
  if (!s0) return spec.title
  const details = spec.categories.map((c, i) => `${c}: ${formatNum(s0.data[i] ?? 0)}${spec.unit}`).join('，')
  return `${spec.title}（${details}）`
}

function snapshot(spec: IuChartSpec): string {
  const desc = spec.desc !== '' ? `<p class="dtt-iu__desc">${esc(spec.desc)}</p>` : ''

  const metricsHtml = spec.metrics.length > 0
    ? `<div class="dtt-iu__chart-metrics">${spec.metrics.map(m => `
        <div class="dtt-iu__chart-metric">
          <span class="dtt-iu__chart-m-label">${esc(m.label)}</span>
          <span class="dtt-iu__chart-m-val">${esc(m.value)}</span>
          ${m.sub ? `<span class="dtt-iu__chart-m-sub">${esc(m.sub)}</span>` : ''}
        </div>
      `).join('')}</div>`
    : ''

  return `${desc}${metricsHtml}<div class="dtt-iu__chart-container"><div class="dtt-iu__chart-snapshot-stub">📊 ${esc(spec.title)}（${spec.categories.length} 个数据点）</div></div>`
}

const css = `
.dtt-iu__chart-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.dtt-iu__chart-metric {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsh-fill, rgba(140, 140, 160, 0.08));
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dtt-iu__chart-m-label {
  font-size: 11px;
  color: var(--dsh-muted, rgba(140, 145, 160, 0.8));
}
.dtt-iu__chart-m-val {
  font-size: 16px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dtt-iu__chart-m-sub {
  font-size: 10px;
  color: var(--dsh-muted, rgba(140, 145, 160, 0.65));
}
.dtt-iu__chart-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.dtt-iu__chart-pills {
  display: flex;
  gap: 4px;
  background: rgba(140, 140, 160, 0.1);
  padding: 2px;
  border-radius: 6px;
}
.dtt-iu__chart-pill {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--dsh-muted, currentColor);
  transition: all 0.15s ease;
}
.dtt-iu__chart-pill--active {
  background: #3b82f6;
  color: #fff;
  font-weight: 600;
}
.dtt-iu__chart-container {
  width: 100%;
  overflow: hidden;
  position: relative;
}
.dtt-iu__chart-svg {
  width: 100%;
  height: auto;
  display: block;
}
.dtt-iu__chart-snapshot-stub {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--dsh-muted, rgba(140, 140, 160, 0.8));
}
`

const doc = `· chart 图表：{"kind":"chart","title":"各季度收入对比","categories":["Q1","Q2","Q3","Q4"],"series":[{"name":"收入","data":[120,150,180,210]}],"unit":"万","mode":"bar","metrics":[{"label":"总收入","value":"660万","sub":"同比+15%"}]}（约束：categories≤12、series≤4、mode=bar|line|donut、metrics≤4、支持无缝切换明细表）`

export const chartKind: IuKind<ChartState, IuChartSpec> = {
  kind: 'chart',
  label: '图表',
  parse,
  initState,
  fillText,
  snapshot,
  css: css,
  doc: doc
}
