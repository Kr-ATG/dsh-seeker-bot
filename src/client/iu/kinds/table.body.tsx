/**
 * iu kind **table** 的 React 体（client 专用）。
 *
 * ## Body 契约（见 bodies.ts 头注释）
 *  · 只渲染「Head 之后、FillRow 之前」的正文，不自己画 Head / FillRow；
 *  · DOM 结构与 table.ts 的 `snapshot()` **逐字对齐**：
 *    metrics? → filters? → wrap → table[data-dense][data-zebra]
 *    → thead(tr>th[role=button, tabindex=0, aria-sort][data-active][data-dir][data-align] + 箭头 span)
 *    → tbody(tr.dtt-iu__tr > td.dtt-iu__td[data-type][data-align])；
 *  · 状态一律走 props 的 state / setState（外壳统一持久化），不自己 useState；
 *  · 排序比较器（sortTableRows）、最大值换算（calcColMaxValues）、徽标判断（getCellBadgeVariant）由 table.ts 导出，保证单一来源。
 */

import { memo, useMemo } from 'react'
import type { IuBodyProps } from './bodies.ts'
import type { IuTableSpec, TableState } from './table.ts'
import { calcColMaxValues, getCellBadgeVariant, sortTableRows } from './table.ts'
import { formatNum } from './core.ts'

export const TableBody = memo(function TableBody(
  { spec, state, setState }: IuBodyProps<TableState, IuTableSpec>,
): JSX.Element {
  // 分类过滤
  const filteredRows = useMemo(() => {
    if (!state.filter || state.filter === '全部') return spec.rows
    return spec.rows.filter(row => row.some(cell => String(cell).includes(state.filter!)))
  }, [spec.rows, state.filter])

  // 排序
  const rows = useMemo(
    () => sortTableRows(filteredRows, spec.columns, state.sortKey, state.sortDir),
    [filteredRows, spec.columns, state.sortKey, state.sortDir],
  )

  // 计算每列最大值（bar 列需要）
  const maxMap = useMemo(
    () => calcColMaxValues(spec.rows, spec.columns),
    [spec.rows, spec.columns],
  )

  /** 点表头：同列再点切换升/降序，换列从升序起。 */
  const onSort = (key: string): void => {
    if (state.sortKey === key) setState({ sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' })
    else setState({ sortKey: key, sortDir: 'asc' })
  }

  /** 点分类过滤芯片。 */
  const onFilter = (f: string): void => {
    setState({ filter: (f === '全部' || state.filter === f) ? null : f })
  }

  return (
    <>
      {spec.metrics && spec.metrics.length > 0 && (
        <div className="dtt-iu__metrics">
          {spec.metrics.map((m, i) => (
            <div className="dtt-iu__metric" key={i} data-color={m.color}>
              <span className="dtt-iu__metric-label">{m.label}</span>
              <span className="dtt-iu__metric-val">
                {typeof m.value === 'number' ? formatNum(m.value) : m.value}
              </span>
              {m.sub && <span className="dtt-iu__metric-sub">{m.sub}</span>}
            </div>
          ))}
        </div>
      )}

      {spec.filters && spec.filters.length > 0 && (
        <div className="dtt-iu__filters" role="tablist">
          {spec.filters.map(f => {
            const active = (f === '全部' && !state.filter) || state.filter === f
            return (
              <button
                type="button"
                className="dtt-iu__filter"
                key={f}
                role="tab"
                aria-selected={active}
                data-active={active ? '1' : '0'}
                onClick={() => { onFilter(f) }}
              >
                {f}
              </button>
            )
          })}
        </div>
      )}

      <div className="dtt-iu__table-wrap">
        <table
          className="dtt-iu__table"
          data-dense={spec.dense ? '1' : undefined}
          data-zebra={spec.zebra ? '1' : undefined}
        >
          <thead>
            <tr>
              {spec.columns.map(col => {
                const active = state.sortKey === col.key
                return (
                  <th
                    key={col.key}
                    className="dtt-iu__th"
                    role="button"
                    tabIndex={0}
                    aria-sort={active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    data-active={active ? '1' : undefined}
                    data-dir={active ? state.sortDir : undefined}
                    data-align={col.align}
                    onClick={() => { onSort(col.key) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSort(col.key)
                      }
                    }}
                  >
                    {col.label}<span className="dtt-iu__arrow" aria-hidden="true">▼</span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              let rowVariant: string | null = null
              for (let j = 0; j < spec.columns.length; j++) {
                const v = getCellBadgeVariant(row[j], spec.columns[j])
                if (v) { rowVariant = v; break }
              }
              return (
                <tr className="dtt-iu__tr" key={i}>
                  {spec.columns.map((col, j) => {
                    const cell = row[j] ?? ''
                    let content: JSX.Element | string
                    if (col.type === 'bar') {
                      const numVal = typeof cell === 'number' ? cell : parseFloat(String(cell))
                      const max = maxMap[j] || 1
                      const pct = Number.isFinite(numVal) ? Math.min(100, Math.max(0, (numVal / max) * 100)).toFixed(1) : '0'
                      const displayVal = typeof cell === 'number' ? formatNum(cell) : cell
                      content = (
                        <div className="dtt-iu__bar-wrap">
                          <div className="dtt-iu__bar-track">
                            <div
                              className="dtt-iu__bar-fill"
                              data-variant={rowVariant ?? undefined}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="dtt-iu__bar-num">{displayVal}</span>
                        </div>
                      )
                    } else if (typeof cell === 'number') {
                      content = formatNum(cell)
                    } else {
                      const badgeVariant = getCellBadgeVariant(cell, col)
                      if (badgeVariant !== null) {
                        content = <span className="dtt-iu__badge" data-variant={badgeVariant}>{cell}</span>
                      } else {
                        content = cell
                      }
                    }
                    return (
                      <td className="dtt-iu__td" key={col.key} data-type={col.type} data-align={col.align}>
                        {content}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
})
