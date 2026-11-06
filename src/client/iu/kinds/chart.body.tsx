/**
 * iu kind **chart** 的 React 体（client 专用）。
 *
 * 现代交互式动态图表看板：
 *  · 柱状图 / 折线图 / 环形图 / 明细表 一键平滑切换；
 *  · 顶部指标卡、微动效 hover 聚焦；
 *  · 纯内联 SVG，无外部重型图表库依赖。
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { IuBodyProps } from './bodies.ts'
import type { ChartMode, ChartState, IuChartSpec } from './chart.ts'
import { formatNum } from './core.ts'

export const ChartBody = memo(function ChartBody(
  { spec, state, setState }: IuBodyProps<ChartState, IuChartSpec>,
): JSX.Element {
  const currentMode = state.currentMode
  const hoverIndex = state.hoverIndex
  const s0 = spec.series[0]
  const data = s0?.data ?? []
  const maxVal = Math.max(...data, 1)

  // 坐标系按「卡片容器实测宽」推导，而不是视口宽度：卡片宽度由对话流决定，
  // 侧栏折叠 / 窗口缩放 / 全屏进出都会变，只有 ResizeObserver 量到的是图表
  // 容器自己的实宽。SSR 与截图链路没有 ResizeObserver 时兜底 500（旧版写死值），
  // 挂载后先同步量一次，避免 500 兜底带来的可见高度跳变。
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [svgW, setSvgW] = useState(500)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = (w: number) => {
      if (w > 0) setSvgW(Math.max(240, Math.round(w)))
    }
    measure(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) measure(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const svgH = 200
  const padL = svgW < 360 ? 28 : 40
  const padR = svgW < 360 ? 12 : 20
  const padT = 20
  const padB = 30
  const chartW = Math.max(1, svgW - padL - padR)
  const chartH = svgH - padT - padB

  const barWidth = Math.min(36, Math.max(6, (chartW / (spec.categories.length || 1)) * 0.6))
  // 窄容器抽稀类目标签：按图表可用宽估算能放下的标签数，隔 N 个显示一个，
  // 首个始终保留，避免 12 个类目在窄卡里挤成一团（不改数据，只改标签密度）。
  const labelEvery = Math.max(1, Math.ceil(
    spec.categories.length / Math.max(1, Math.floor(chartW / 56)),
  ))

  // 折线图坐标计算
  const linePoints = useMemo(() => {
    return data.map((v, i) => {
      const x = padL + (i + 0.5) * (chartW / data.length)
      const y = padT + chartH - (v / maxVal) * chartH
      return { x, y, v, cat: spec.categories[i] }
    })
  }, [data, maxVal, chartW, chartH, padL, padT, spec.categories])

  const linePathD = useMemo(() => {
    if (linePoints.length === 0) return ''
    return linePoints.reduce((acc, p, i) => {
      return i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`
    }, '')
  }, [linePoints])

  const areaPathD = useMemo(() => {
    if (linePoints.length === 0) return ''
    const firstX = linePoints[0].x
    const lastX = linePoints[linePoints.length - 1].x
    const baseY = padT + chartH
    return `${linePathD} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`
  }, [linePathD, linePoints, padT, chartH])

  // 环形图计算 (Donut)
  const totalVal = useMemo(() => data.reduce((a, b) => a + Math.max(0, b), 0), [data])
  const donutSlices = useMemo(() => {
    if (totalVal <= 0) return []
    let curAngle = -Math.PI / 2
    const cx = 250, cy = 100, rOuter = 75, rInner = 45
    return data.map((v, i) => {
      const sliceVal = Math.max(0, v)
      const angle = (sliceVal / totalVal) * Math.PI * 2
      const startAngle = curAngle
      const endAngle = curAngle + angle
      curAngle = endAngle

      const x1 = cx + rOuter * Math.cos(startAngle)
      const y1 = cy + rOuter * Math.sin(startAngle)
      const x2 = cx + rOuter * Math.cos(endAngle)
      const y2 = cy + rOuter * Math.sin(endAngle)
      const x3 = cx + rInner * Math.cos(endAngle)
      const y3 = cy + rInner * Math.sin(endAngle)
      const x4 = cx + rInner * Math.cos(startAngle)
      const y4 = cy + rInner * Math.sin(startAngle)

      const largeArc = angle > Math.PI ? 1 : 0
      const d = [
        `M ${x1} ${y1}`,
        `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2}`,
        `L ${x3} ${y3}`,
        `A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4} ${y4}`,
        'Z',
      ].join(' ')

      const color = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'][i % 6]
      return { d, color, val: v, cat: spec.categories[i], pct: Math.round((sliceVal / totalVal) * 100) }
    })
  }, [data, totalVal, spec.categories])

  return (
    <>
      {spec.desc !== '' && <p className="dtt-iu__desc">{spec.desc}</p>}

      {/* 顶部指标卡看板 */}
      {spec.metrics.length > 0 && (
        <div className="dtt-iu__chart-metrics">
          {spec.metrics.map((m, i) => (
            <div key={i} className="dtt-iu__chart-metric">
              <span className="dtt-iu__chart-m-label">{m.label}</span>
              <span className="dtt-iu__chart-m-val">{m.value}</span>
              {m.sub && <span className="dtt-iu__chart-m-sub">{m.sub}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 视图切换 Chips */}
      {spec.allowSwitch && (
        <div className="dtt-iu__chart-toolbar">
          <span style={{ fontSize: 11, color: 'var(--dsh-muted, rgba(140,140,160,0.8))' }}>
            {hoverIndex !== null && spec.categories[hoverIndex]
              ? `聚焦: ${spec.categories[hoverIndex]} (${formatNum(data[hoverIndex] ?? 0)}${spec.unit})`
              : '点击切换视图形态'}
          </span>
          <div className="dtt-iu__chart-pills">
            {(['bar', 'line', 'donut', 'table'] as const).map(m => (
              <button
                key={m}
                type="button"
                className={`dtt-iu__chart-pill${currentMode === m ? ' dtt-iu__chart-pill--active' : ''}`}
                onClick={() => setState({ currentMode: m })}
              >
                {m === 'bar' ? '柱状' : m === 'line' ? '折线' : m === 'donut' ? '环图' : '明细'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 图表主区域 */}
      <div className="dtt-iu__chart-container" ref={containerRef}>
        {currentMode === 'bar' && (
          <svg className="dtt-iu__chart-svg" viewBox={`0 0 ${svgW} ${svgH}`}>
            {/* 刻度背景横虚线 */}
            {[0, 0.5, 1].map((pct, idx) => {
              const y = padT + chartH * (1 - pct)
              return (
                <g key={idx}>
                  <line
                    x1={padL}
                    y1={y}
                    x2={svgW - padR}
                    y2={y}
                    stroke="rgba(140, 140, 160, 0.15)"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={padL - 6}
                    y={y + 3}
                    textAnchor="end"
                    fontSize="9"
                    fill="rgba(140, 140, 160, 0.6)"
                  >
                    {formatNum(maxVal * pct)}
                  </text>
                </g>
              )
            })}

            {/* 柱子 */}
            {data.map((v, i) => {
              const colH = Math.max(2, (v / maxVal) * chartH)
              const x = padL + (i + 0.5) * (chartW / data.length) - barWidth / 2
              const y = padT + chartH - colH
              const isHover = hoverIndex === i
              const color = s0?.color || '#3b82f6'

              return (
                <g
                  key={i}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setState({ hoverIndex: i })}
                  onMouseLeave={() => setState({ hoverIndex: null })}
                >
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={colH}
                    rx="4"
                    ry="4"
                    fill={color}
                    opacity={hoverIndex === null || isHover ? 1 : 0.4}
                    style={{ transition: 'all 0.2s ease' }}
                  />
                  {isHover && (
                    <text
                      x={x + barWidth / 2}
                      y={y - 5}
                      textAnchor="middle"
                      fontSize="10"
                      fontWeight="bold"
                      fill={color}
                    >
                      {formatNum(v)}{spec.unit}
                    </text>
                  )}
                  <text
                    x={x + barWidth / 2}
                    y={svgH - 10}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--dsh-muted, currentColor)"
                  >
                    {i % labelEvery === 0 ? spec.categories[i] : ''}
                  </text>
                </g>
              )
            })}
          </svg>
        )}

        {currentMode === 'line' && (
          <svg className="dtt-iu__chart-svg" viewBox={`0 0 ${svgW} ${svgH}`}>
            <defs>
              <linearGradient id="chartAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
              </linearGradient>
            </defs>
            {/* 背景横线 */}
            {[0, 0.5, 1].map((pct, idx) => {
              const y = padT + chartH * (1 - pct)
              return (
                <line
                  key={idx}
                  x1={padL}
                  y1={y}
                  x2={svgW - padR}
                  y2={y}
                  stroke="rgba(140, 140, 160, 0.15)"
                  strokeDasharray="3 3"
                />
              )
            })}
            {/* 面积与折线 */}
            <path d={areaPathD} fill="url(#chartAreaGrad)" />
            <path
              d={linePathD}
              fill="none"
              stroke="#3b82f6"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* 节点 */}
            {linePoints.map((p, i) => {
              const isHover = hoverIndex === i
              return (
                <g
                  key={i}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setState({ hoverIndex: i })}
                  onMouseLeave={() => setState({ hoverIndex: null })}
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isHover ? 6 : 4}
                    fill="#3b82f6"
                    stroke="#fff"
                    strokeWidth="2"
                    style={{ transition: 'all 0.15s ease' }}
                  />
                  {isHover && (
                    <text
                      x={p.x}
                      y={p.y - 8}
                      textAnchor="middle"
                      fontSize="10"
                      fontWeight="bold"
                      fill="#3b82f6"
                    >
                      {formatNum(p.v)}{spec.unit}
                    </text>
                  )}
                  <text
                    x={p.x}
                    y={svgH - 10}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--dsh-muted, currentColor)"
                  >
                    {i % labelEvery === 0 ? p.cat : ''}
                  </text>
                </g>
              )
            })}
          </svg>
        )}

        {currentMode === 'donut' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <svg style={{ width: 'min(100%, 220px)', height: 'auto' }} viewBox="150 0 200 200">
              {donutSlices.map((s, i) => (
                <path
                  key={i}
                  d={s.d}
                  fill={s.color}
                  opacity={hoverIndex === null || hoverIndex === i ? 1 : 0.45}
                  style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                  onMouseEnter={() => setState({ hoverIndex: i })}
                  onMouseLeave={() => setState({ hoverIndex: null })}
                />
              ))}
              <text x="250" y="96" textAnchor="middle" fontSize="11" fill="var(--dsh-muted, rgba(140,140,160,0.8))">
                {hoverIndex !== null && donutSlices[hoverIndex]
                  ? donutSlices[hoverIndex].cat
                  : '合计总额'}
              </text>
              <text x="250" y="115" textAnchor="middle" fontSize="15" fontWeight="bold" fill="currentColor">
                {hoverIndex !== null && donutSlices[hoverIndex]
                  ? `${formatNum(donutSlices[hoverIndex].val)}${spec.unit}`
                  : `${formatNum(totalVal)}${spec.unit}`}
              </text>
            </svg>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
              {donutSlices.slice(0, 5).map((s, i) => (
                <div
                  key={i}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                  onMouseEnter={() => setState({ hoverIndex: i })}
                  onMouseLeave={() => setState({ hoverIndex: null })}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
                  <span>{s.cat}</span>
                  <span style={{ fontWeight: 600, color: 'var(--dsh-muted, currentColor)' }}>{s.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {currentMode === 'table' && (
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--dsh-border, rgba(140,140,160,0.2))' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>维度</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>数值</th>
                  <th style={{ width: '35%', textAlign: 'left', padding: '6px 8px' }}>占比</th>
                </tr>
              </thead>
              <tbody>
                {spec.categories.map((cat, i) => {
                  const val = data[i] ?? 0
                  const pct = Math.max(0, Math.min(100, Math.round((val / (maxVal || 1)) * 100)))
                  return (
                    <tr
                      key={i}
                      style={{ borderBottom: '1px solid rgba(140,140,160,0.1)' }}
                    >
                      <td style={{ padding: '6px 8px', fontWeight: 500 }}>{cat}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                        {formatNum(val)}{spec.unit}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <div style={{ height: 6, width: '100%', background: 'rgba(140,140,160,0.15)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: '#3b82f6', borderRadius: 3 }} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
})
