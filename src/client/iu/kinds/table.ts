/**
 * iu kind: **table**（文档式高质感可排序数据表）。
 *
 * 结构照抄 slider.ts（纯逻辑半边）：parse / initState / fillText / snapshot /
 * css / doc + export const tableKind；React 体在 table.body.tsx。
 *
 * 排序比较器（sortTableRows）、徽标判断（getCellBadgeVariant）、
 * 列最大值换算（calcColMaxValues）导出给 Body 用，保证排序与渲染语义单一来源。
 *
 * ⚠ 本文件零 React、零 DOM（host 半身的截图管线要 import 它）。
 */

import type { IuKind, IuSpecBase, IuState } from './contract.ts'
import { arr, boolOrFalse, boolOrTrue, esc, escAttr, formatNum, oneOf, pickAll, str, strOr } from './core.ts'

/** 列类型：text 按字典排、num 按数值排、bar 带迷你占比进度条。 */
export type IuTableColType = 'text' | 'num' | 'bar'

/** 列对齐（parse 时已把缺省解析成具体值：num/bar→right、text→left；数值样文本列自动右对齐）。 */
export type IuTableAlign = 'left' | 'right' | 'center'

/** 一列的定义。 */
export interface IuTableColumn {
  /** 列标识（排序状态引用它；parse 保证非空且全表唯一）。 */
  readonly key: string
  /** 表头文案（≤16 字）。 */
  readonly label: string
  readonly type: IuTableColType
  readonly align: IuTableAlign
}

/** 单元格值：字符串或数字（JSON 里就这两种；其余类型 parse 成空串）。 */
export type IuTableCell = string | number

/** 顶部概览指标项（可选，最多 4 项）。 */
export interface IuTableMetric {
  readonly label: string
  readonly value: string | number
  readonly sub?: string
  readonly color?: 'primary' | 'purple' | 'green' | 'amber'
}

export interface IuTableSpec extends IuSpecBase {
  readonly kind: 'table'
  readonly title: string
  readonly columns: readonly IuTableColumn[]
  /** 每行长度恒等于 columns.length（parse 补齐/截断，缺失补空串）。 */
  readonly rows: readonly (readonly IuTableCell[])[]
  /** 紧凑行高（默认 false）。 */
  readonly dense: boolean
  /** 斑马纹（默认 true，视觉上只保留极淡的一层）。 */
  readonly zebra: boolean
  /** 顶部概览指标卡（可选，最多 4 项）。 */
  readonly metrics?: readonly IuTableMetric[]
  /** 快速分类过滤项（可选，如 ['全部', '系统组件', '开发运行时', ...]）。 */
  readonly filters?: readonly string[]
}

/** table 的本地状态（持久化）：当前按哪列、什么方向排、以及当前选中的过滤分类。 */
export interface TableState extends IuState {
  readonly sortKey: string | null
  readonly sortDir: 'asc' | 'desc'
  readonly filter?: string | null
}

/** 列数上限。 */
const MAX_COLS = 8
/** 行数上限。 */
const MAX_ROWS = 100
/** 单元格文本上限。 */
const MAX_CELL = 60
/** 快照最多渲染前几行。 */
const SNAPSHOT_ROWS = 8

/**
 * 单元格是否呈现为「数字样」。
 *
 * 只用于**推断列的默认对齐**：模型生成表格时常把金额/延迟/倍数写成普通字符串
 * （"$0.025"、"约1767"、"0.1 ms"、"4.2倍"），若整列按文本左对齐，数字会参差
 * 得像草稿。这里允许货币符、千分位、百分号与常见单位，命中率覆盖真实场景；
 * 纯日期（2026-11-05）不会误判成数字。
 */
function looksNumericCell(v: IuTableCell): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  const t = v.trim()
  if (t === '') return false
  return /^[≈~约]?\s*[-+]?(?:[$¥€£]\s*)?(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*(?:%|‰|ms|s|MB\/s|GB\/s|TB\/s|MB|GB|TB|KB|fps|倍|万|亿|k|K|元|美元)?$/i.test(t)
}

function parse(raw: Record<string, unknown>): IuTableSpec | undefined {
  const explicitAlign: boolean[] = []
  const cols = pickAll<IuTableColumn>(raw.columns, MAX_COLS, (it) => {
    const key = str(it.key, 16)
    const label = str(it.label, 16)
    if (key === '' && label === '') return undefined
    const type = oneOf(it.type, ['text', 'num', 'bar'], 'text')
    const rawAlign = it.align
    const hasAlign = rawAlign === 'left' || rawAlign === 'right' || rawAlign === 'center'
    const align = oneOf(rawAlign, ['left', 'right', 'center'], (type === 'num' || type === 'bar') ? 'right' : 'left')
    explicitAlign.push(hasAlign)
    return { key, label: label !== '' ? label : key, type, align }
  })
  if (cols.length === 0) return undefined
  // key 补全与去重
  const seen = new Set<string>()
  const columns = cols.map((c, i) => {
    if (c.key !== '' && !seen.has(c.key)) {
      seen.add(c.key)
      return c
    }
    let key = c.key !== '' ? c.key : `col${i}`
    while (seen.has(key)) key += '~'
    seen.add(key)
    return { ...c, key }
  })
  const rows: (readonly IuTableCell[])[] = []
  for (const rawRow of arr(raw.rows)) {
    if (rows.length >= MAX_ROWS) break
    if (!Array.isArray(rawRow)) continue
    const cells: IuTableCell[] = []
    for (let j = 0; j < columns.length; j += 1) {
      const cell: unknown = rawRow[j]
      cells.push(typeof cell === 'number' && Number.isFinite(cell) ? cell : str(cell, MAX_CELL))
    }
    rows.push(cells)
  }
  if (rows.length === 0) return undefined

  // 未显式声明对齐的文本列：若 ≥60% 的非空单元格是数字样，自动右对齐。
  // 这是「表格看起来专业」收益最高的一条：数字列右对齐 + 等宽数字后，
  // 一列数值的个位/小数点会自然成列，而左对齐的混合文本列保持原样。
  for (let c = 0; c < columns.length; c += 1) {
    if (columns[c].type !== 'text' || explicitAlign[c] === true) continue
    let filled = 0
    let numeric = 0
    for (const row of rows) {
      const v = row[c] ?? ''
      if (typeof v === 'string' && v.trim() === '') continue
      filled += 1
      if (looksNumericCell(v)) numeric += 1
    }
    if (filled >= 2 && numeric / filled >= 0.6) {
      columns[c] = { ...columns[c], align: 'right' }
    }
  }

  // 顶部概览指标项
  const metrics = pickAll<IuTableMetric>(raw.metrics, 4, (it) => {
    const label = str(it.label, 16)
    const value = typeof it.value === 'number' ? it.value : str(it.value, 20)
    if (label === '' && value === '') return undefined
    const sub = str(it.sub, 24)
    const color = oneOf(it.color, ['primary', 'purple', 'green', 'amber'], 'primary')
    return { label, value, sub: sub !== '' ? sub : undefined, color }
  })

  // 快速分类过滤项
  const filters: string[] = []
  for (const item of arr(raw.filters)) {
    if (filters.length >= 8) break
    const s = typeof item === 'string' ? str(item, 16) : (typeof item === 'object' && item !== null ? str((item as Record<string, unknown>).label, 16) : '')
    if (s !== '' && !filters.includes(s)) filters.push(s)
  }

  return {
    kind: 'table',
    title: strOr(raw.title, 40, '数据表'),
    columns,
    rows,
    dense: boolOrFalse(raw.dense),
    zebra: boolOrTrue(raw.zebra),
    metrics: metrics.length > 0 ? metrics : undefined,
    filters: filters.length > 0 ? filters : undefined,
  }
}

function initState(): TableState {
  return { sortKey: null, sortDir: 'asc', filter: null }
}

function cellText(v: IuTableCell): string {
  return typeof v === 'number' ? formatNum(v) : v
}

/**
 * 取单元格的数值语义（排序用）：允许货币符 / 千分位 / ≈约 前缀。
 * 不是数值的（含单位文本、持平、中文）返回 NaN，由排序器排到末尾。
 */
function cellNumber(v: IuTableCell): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN
  const m = v.trim().match(/^[≈~约]?\s*[-+]?(?:[$¥€£]\s*)?([\d,]+(?:\.\d+)?|\.\d+)/)
  if (m === null) return Number.NaN
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : Number.NaN
}

/**
 * 判断单元格是否应呈现为分类微徽标（Badge），并返回语义变体。
 */
export function getCellBadgeVariant(cell: IuTableCell, col: IuTableColumn): string | null {
  if (typeof cell !== 'string') return null
  const t = cell.trim()
  if (t.length < 1 || t.length > 10) return null
  const isCategoryCol = /(性质|类型|类别|分类|状态|标签|组件|控件|tag|type|status|category|role|kind)/i.test(col.label)
    || /(性质|类型|类别|分类|状态|标签|组件|控件|tag|type|status|category|role|kind)/i.test(col.key)
  if (!isCategoryCol && !/(系统|组件|驱动|卸载|工具|开发|运行时|浏览器|输入法|录屏|游戏|平台)/.test(t)) {
    return null
  }
  if (/(系统|组件|驱动)/.test(t)) return 'system'
  if (/(卸载|危险|警告|清理)/.test(t)) return 'warning'
  if (/(开发|运行|代码|sdk)/i.test(t)) return 'dev'
  if (/(工具|小工具|浏览器|输入法|录屏|游戏|平台)/.test(t)) return 'tool'
  return 'neutral'
}

/**
 * 计算各 bar 列的最大有效数值（用于计算占比进度条百分比）。
 */
export function calcColMaxValues(
  rows: readonly (readonly IuTableCell[])[],
  columns: readonly IuTableColumn[],
): Record<number, number> {
  const maxMap: Record<number, number> = {}
  for (let c = 0; c < columns.length; c++) {
    if (columns[c].type === 'bar') {
      let max = 0
      for (let r = 0; r < rows.length; r++) {
        const v = rows[r][c]
        const n = typeof v === 'number' ? v : parseFloat(String(v))
        if (Number.isFinite(n) && n > max) max = n
      }
      maxMap[c] = max > 0 ? max : 1
    }
  }
  return maxMap
}

/**
 * 按列排序 rows（num 与 bar 均走数值排序）。
 *
 * text 列若整列都是数字样（金额 / 百分比 / 带单位数字），也按数值比较——
 * 否则「$0.025 < $0.1」会被字典序排反。
 */
export function sortTableRows(
  rows: readonly (readonly IuTableCell[])[],
  columns: readonly IuTableColumn[],
  sortKey: string | null,
  sortDir: 'asc' | 'desc',
): readonly (readonly IuTableCell[])[] {
  if (sortKey === null) return rows
  const idx = columns.findIndex(c => c.key === sortKey)
  if (idx < 0) return rows
  const numeric = columns[idx].type === 'num' || columns[idx].type === 'bar'
    || rows.every((row) => {
      const v = row[idx] ?? ''
      return (typeof v === 'string' && v.trim() === '') || Number.isFinite(cellNumber(v))
    })
  const dir = sortDir === 'desc' ? -1 : 1
  return rows.slice().sort((a, b) => {
    const av = a[idx] ?? ''
    const bv = b[idx] ?? ''
    if (numeric) {
      const an = cellNumber(av)
      const bn = cellNumber(bv)
      if (Number.isNaN(an) || Number.isNaN(bn)) {
        if (Number.isNaN(an) && Number.isNaN(bn)) return 0
        return Number.isNaN(an) ? 1 : -1
      }
      return an === bn ? 0 : (an < bn ? -1 : 1) * dir
    }
    const cmp = cellText(av).localeCompare(cellText(bv))
    return cmp === 0 ? 0 : (cmp < 0 ? -1 : 1) * dir
  })
}

/** 回填文本。 */
function fillText(spec: IuTableSpec, state: TableState): string {
  const base = `${spec.title}：${spec.rows.length} 行 × ${spec.columns.length} 列`
  const col = spec.columns.find(c => c.key === state.sortKey)
  const filterDesc = state.filter ? `，筛选「${state.filter}」` : ''
  if (col === undefined) return `${base}${filterDesc}`
  return `${base}${filterDesc}，按「${col.label}」${state.sortDir === 'desc' ? '降序' : '升序'}`
}

/**
 * 静态快照（截图用）。DOM 结构与 table.body.tsx 逐字对齐。
 */
function snapshot(spec: IuTableSpec): string {
  let metricsHtml = ''
  if (spec.metrics && spec.metrics.length > 0) {
    const items = spec.metrics.map(m => {
      const sub = m.sub ? `<span class="dtt-iu__metric-sub">${esc(m.sub)}</span>` : ''
      const color = m.color ? ` data-color="${escAttr(m.color)}"` : ''
      return `<div class="dtt-iu__metric"${color}><span class="dtt-iu__metric-label">${esc(m.label)}</span>`
        + `<span class="dtt-iu__metric-val">${esc(typeof m.value === 'number' ? formatNum(m.value) : m.value)}</span>${sub}</div>`
    }).join('')
    metricsHtml = `<div class="dtt-iu__metrics">${items}</div>`
  }

  let filtersHtml = ''
  if (spec.filters && spec.filters.length > 0) {
    const items = spec.filters.map((f, i) =>
      `<button type="button" class="dtt-iu__filter" data-active="${i === 0 ? '1' : '0'}">${esc(f)}</button>`,
    ).join('')
    filtersHtml = `<div class="dtt-iu__filters" role="tablist">${items}</div>`
  }

  const maxMap = calcColMaxValues(spec.rows, spec.columns)

  const head = spec.columns.map(col =>
    `<th class="dtt-iu__th" role="button" tabindex="0" aria-sort="none"`
    + ` data-align="${escAttr(col.align)}">${esc(col.label)}`
    + `<span class="dtt-iu__arrow" aria-hidden="true">▼</span></th>`,
  ).join('')

  const body = spec.rows.slice(0, SNAPSHOT_ROWS).map(row => {
    let rowVariant: string | null = null
    for (let j = 0; j < spec.columns.length; j++) {
      const v = getCellBadgeVariant(row[j], spec.columns[j])
      if (v) { rowVariant = v; break }
    }
    const cells = spec.columns.map((col, j) => {
      const cell = row[j] ?? ''
      let inner = ''
      if (col.type === 'bar') {
        const numVal = typeof cell === 'number' ? cell : parseFloat(String(cell))
        const max = maxMap[j] || 1
        const pct = Number.isFinite(numVal) ? Math.min(100, Math.max(0, (numVal / max) * 100)).toFixed(1) : '0'
        const displayVal = typeof cell === 'number' ? formatNum(cell) : cell
        const variantAttr = rowVariant ? ` data-variant="${escAttr(rowVariant)}"` : ''
        inner = `<div class="dtt-iu__bar-wrap"><div class="dtt-iu__bar-track">`
          + `<div class="dtt-iu__bar-fill"${variantAttr} style="width:${pct}%;"></div>`
          + `</div><span class="dtt-iu__bar-num">${esc(displayVal)}</span></div>`
      } else if (typeof cell === 'number') {
        inner = esc(formatNum(cell))
      } else {
        const badgeVariant = getCellBadgeVariant(cell, col)
        if (badgeVariant !== null) {
          inner = `<span class="dtt-iu__badge" data-variant="${badgeVariant}">${esc(cell)}</span>`
        } else {
          inner = esc(cell)
        }
      }
      return `<td class="dtt-iu__td" data-type="${escAttr(col.type)}" data-align="${escAttr(col.align)}">${inner}</td>`
    }).join('')
    return `<tr class="dtt-iu__tr">${cells}</tr>`
  }).join('')

  const dense = spec.dense ? ' data-dense="1"' : ''
  const zebra = spec.zebra ? ' data-zebra="1"' : ''
  return `${metricsHtml}${filtersHtml}<div class="dtt-iu__table-wrap"><table class="dtt-iu__table"${dense}${zebra}>`
    + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

const CSS = [
  '/* table：文档式高质感数据表 —— 轻表头、发丝分隔线、数字列自动右对齐、指标/过滤精致化 */',
  '/* 顶部指标概览：多个 = 等分小卡；只有一个 = 一行说明（像图表副标题，不做整宽面板） */',
  '.dtt-iu__metrics {',
  '  display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr));',
  '  gap: 10px; margin: 2px 0 10px;',
  '}',
  '.dtt-iu__metric {',
  '  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 8%, transparent);',
  '  border-radius: calc(10px * var(--iu-zoom, 1));',
  '  padding: 9px 11px;',
  '  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 2%, transparent);',
  '  display: flex; flex-direction: column; min-width: 0;',
  '}',
  '.dtt-iu__metric-label {',
  '  font-size: calc(10px * var(--iu-text-scale, 1)); font-weight: 500; letter-spacing: .03em;',
  '  color: var(--dsw-alias-label-tertiary, currentColor);',
  '  margin-bottom: 2px;',
  '}',
  '.dtt-iu__metric-val {',
  '  font-size: calc(15px * var(--iu-text-scale, 1)); font-weight: 600;',
  '  font-variant-numeric: tabular-nums; line-height: 1.35; letter-spacing: -.01em;',
  '  color: var(--dsw-alias-label-primary, currentColor);',
  '}',
  '.dtt-iu__metric-sub {',
  '  font-size: calc(10px * var(--iu-text-scale, 1)); margin-top: 2px; line-height: 1.45;',
  '  color: var(--dsw-alias-label-tertiary, currentColor);',
  '}',
  '.dtt-iu__metric[data-color="purple"] .dtt-iu__metric-val { color: color-mix(in srgb, #8b5cf6 65%, var(--dsw-alias-label-primary, currentColor)); }',
  '.dtt-iu__metric[data-color="green"] .dtt-iu__metric-val { color: color-mix(in srgb, #10b981 55%, var(--dsw-alias-label-primary, currentColor)); }',
  '.dtt-iu__metric[data-color="amber"] .dtt-iu__metric-val { color: color-mix(in srgb, #f59e0b 55%, var(--dsw-alias-label-primary, currentColor)); }',
  '/* 单指标：压成一行说明，宽紧都自然换行 */',
  '.dtt-iu__metric:only-child {',
  '  border: 0; background: transparent; border-radius: 0; padding: 0 2px;',
  '  flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: 2px 8px;',
  '}',
  '.dtt-iu__metric:only-child .dtt-iu__metric-label {',
  '  margin: 0; font-size: calc(10.5px * var(--iu-text-scale, 1));',
  '  color: var(--dsw-alias-label-tertiary, currentColor);',
  '}',
  '.dtt-iu__metric:only-child .dtt-iu__metric-val {',
  '  font-size: calc(12px * var(--iu-text-scale, 1)); font-weight: 500;',
  '  color: var(--dsw-alias-label-secondary, currentColor);',
  '}',
  '.dtt-iu__metric:only-child .dtt-iu__metric-sub {',
  '  margin: 0; font-size: calc(10.5px * var(--iu-text-scale, 1));',
  '  color: var(--dsw-alias-label-tertiary, currentColor);',
  '  flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere;',
  '}',
  '/* 快速分类过滤芯片（Filter Chips） */',
  '.dtt-iu__filters {',
  '  display: flex; gap: 5px; margin-bottom: 8px;',
  '  overflow-x: auto; padding-bottom: 2px;',
  '  -webkit-overflow-scrolling: touch;',
  '}',
  '.dtt-iu__filter {',
  '  background: transparent;',
  '  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 10%, transparent);',
  '  border-radius: 6px; padding: 2px 8px;',
  '  font-size: calc(10.5px * var(--iu-text-scale, 1)); font-weight: 500;',
  '  color: var(--dsw-alias-label-secondary, currentColor);',
  '  cursor: pointer; white-space: nowrap;',
  '  transition: background-color .15s ease, border-color .15s ease, color .15s ease; user-select: none;',
  '}',
  '.dtt-iu__filter:hover {',
  '  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 3%, transparent);',
  '}',
  '.dtt-iu__filter[data-active="1"] {',
  '  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 8%, transparent);',
  '  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 38%, transparent);',
  '  color: var(--dsw-alias-state-business-primary, #60a5fa);',
  '  font-weight: 600;',
  '}',
  '/* 表格主体容器：细发丝框 + 轻圆角，不做重阴影 */',
  '.dtt-iu__table-wrap {',
  '  overflow: hidden; overflow-x: auto;',
  '  margin: calc(12px * var(--iu-text-scale, 1)) 0 calc(8px * var(--iu-text-scale, 1));',
  '  border-radius: calc(12px * var(--iu-zoom, 1));',
  '  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 8.5%, transparent);',
  '  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 1%, transparent);',
  '  box-shadow: none;',
  '  scrollbar-width: thin;',
  '  -webkit-overflow-scrolling: touch;',
  '}',
  '.dtt-iu__table {',
  '  width: 100%; border-collapse: separate; border-spacing: 0;',
  '  font-size: calc(12.5px * var(--iu-text-scale, 1)); line-height: 1.5;',
  '}',
  '/* 表头：文档式灰色小字、无底色填充，只有一条细线分区 */',
  '.dtt-iu__th {',
  '  text-align: left; font-weight: 500; white-space: nowrap; cursor: pointer;',
  '  letter-spacing: .03em; user-select: none;',
  '  padding: 9.5px 12px 8px; font-size: calc(10.5px * var(--iu-text-scale, 1));',
  '  color: color-mix(in srgb, var(--dsw-alias-label-secondary, currentColor) 82%, transparent);',
  '  background: transparent;',
  '  border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 13%, transparent);',
  '  transition: color .18s ease, background-color .18s ease;',
  '}',
  '.dtt-iu__th:first-child { padding-left: calc(15px * var(--iu-text-scale, 1)); }',
  '.dtt-iu__th:last-child { padding-right: calc(15px * var(--iu-text-scale, 1)); }',
  '.dtt-iu__th:hover {',
  '  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 2.2%, transparent);',
  '  color: var(--dsw-alias-label-primary, currentColor);',
  '}',
  '.dtt-iu__th:focus-visible {',
  '  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);',
  '  outline-offset: -2px;',
  '}',
  '.dtt-iu__th[data-active="1"] {',
  '  color: var(--dsw-alias-label-primary, currentColor);',
  '  background: transparent;',
  '}',
  '/* 排序箭头：双三角，静止隐藏（参考图的纯净表头），悬停才浮现 */',
  '.dtt-iu__arrow {',
  '  display: inline-block; position: relative;',
  '  width: 0; height: 0; margin-left: 4px; vertical-align: 0;',
  '  font-size: 0; opacity: 0; color: currentColor;',
  '  transition: opacity .16s ease, color .16s ease;',
  '}',
  '.dtt-iu__arrow::before, .dtt-iu__arrow::after {',
  '  content: ""; position: absolute; left: 50%; width: 0; height: 0; margin-left: -3px;',
  '  border-left: 3px solid transparent; border-right: 3px solid transparent;',
  '}',
  '.dtt-iu__arrow::before { top: -4px; border-bottom: 4px solid currentColor; }',
  '.dtt-iu__arrow::after { top: 1px; border-top: 4px solid currentColor; }',
  '.dtt-iu__th:hover .dtt-iu__arrow { opacity: .55; }',
  '.dtt-iu__th[data-active="1"] .dtt-iu__arrow { opacity: .95; color: var(--dsw-alias-state-business-primary, #4176e6); }',
  '.dtt-iu__th[data-active="1"][data-dir="asc"] .dtt-iu__arrow::after { opacity: .18; }',
  '.dtt-iu__th[data-active="1"][data-dir="desc"] .dtt-iu__arrow::before { opacity: .18; }',
  '/* 斑马纹只留极淡一层；行悬停用中性色，不用品牌蓝 */',
  '.dtt-iu__table[data-zebra="1"] .dtt-iu__tr:nth-child(even) {',
  '  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 1.5%, transparent);',
  '}',
  '.dtt-iu__tr { transition: background-color .14s ease; }',
  '.dtt-iu__tr:hover .dtt-iu__td {',
  '  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 2.6%, transparent);',
  '}',
  '/* 单元格：发丝分隔线，首列主色 */',
  '.dtt-iu__td {',
  '  padding: 8.5px 12px; white-space: nowrap;',
  '  border-bottom: 0;',
  '  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 6.5%, transparent);',
  '  color: var(--dsw-alias-label-secondary, currentColor);',
  '  font-weight: 400;',
  '  transition: background-color .14s ease, color .14s ease;',
  '}',
  '.dtt-iu__tr:last-child .dtt-iu__td { box-shadow: none; }',
  '.dtt-iu__td:first-child {',
  '  padding-left: calc(15px * var(--iu-text-scale, 1));',
  '  font-weight: 500;',
  '  color: var(--dsw-alias-label-primary, currentColor);',
  '}',
  '.dtt-iu__td:last-child { padding-right: calc(15px * var(--iu-text-scale, 1)); }',
  '/* 空单元格给一个弱占位，避免首列为空时整行像缺了行标签 */',
  '.dtt-iu__td:empty::before {',
  '  content: "—"; color: var(--dsw-alias-label-tertiary, currentColor); opacity: .55;',
  '}',
  '/* 数字与右对齐列：等宽数字成列，主色略重 */',
  '.dtt-iu__td[data-align="right"], .dtt-iu__td[data-type="num"] {',
  '  font-variant-numeric: tabular-nums;',
  '  font-weight: 500;',
  '  color: var(--dsw-alias-label-primary, currentColor);',
  '  letter-spacing: -.005em;',
  '}',
  '.dtt-iu__bar-wrap {',
  '  display: flex; align-items: center; gap: 8px;',
  '  min-width: 120px;',
  '}',
  '.dtt-iu__bar-track {',
  '  flex: 1; height: 4px;',
  '  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 9%, transparent);',
  '  border-radius: 3px; overflow: hidden;',
  '}',
  '.dtt-iu__bar-fill {',
  '  height: 100%; border-radius: 3px;',
  '  background: linear-gradient(90deg, var(--dsw-alias-state-business-primary, #3b82f6), #60a5fa);',
  '  transition: width .28s cubic-bezier(.2,.8,.25,1);',
  '}',
  '.dtt-iu__bar-fill[data-variant="system"] { background: linear-gradient(90deg, #8b5cf6, #a78bfa); }',
  '.dtt-iu__bar-fill[data-variant="warning"] { background: linear-gradient(90deg, #f59e0b, #fbbf24); }',
  '.dtt-iu__bar-fill[data-variant="dev"] { background: linear-gradient(90deg, #10b981, #34d399); }',
  '.dtt-iu__bar-num {',
  '  font-variant-numeric: tabular-nums; font-weight: 500;',
  '  min-width: 36px; text-align: right;',
  '  color: var(--dsw-alias-label-primary, currentColor);',
  '}',
  '/* 对齐方式 */',
  '.dtt-iu__th[data-align="right"], .dtt-iu__td[data-align="right"] { text-align: right; }',
  '.dtt-iu__th[data-align="center"], .dtt-iu__td[data-align="center"] { text-align: center; }',
  '/* 紧凑行高 dense */',
  '.dtt-iu__table[data-dense="1"] .dtt-iu__th { padding: 5px 9px; }',
  '.dtt-iu__table[data-dense="1"] .dtt-iu__td { padding: 4.5px 9px; }',
  '/* 分类微徽标：小圆角方块，比大胶囊克制 */',
  '.dtt-iu__badge {',
  '  display: inline-flex; align-items: center;',
  '  padding: .5px 6px; border-radius: 5px;',
  '  font-size: calc(10px * var(--iu-text-scale, 1)); font-weight: 600; line-height: 1.5;',
  '  letter-spacing: .02em; white-space: nowrap;',
  '  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 6%, transparent);',
  '  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 9%, transparent);',
  '  color: var(--dsw-alias-label-secondary, currentColor);',
  '}',
  '.dtt-iu__badge[data-variant="system"] {',
  '  background: color-mix(in srgb, #8b5cf6 12%, transparent);',
  '  border-color: color-mix(in srgb, #8b5cf6 24%, transparent);',
  '  color: color-mix(in srgb, #7c3aed 65%, var(--dsw-alias-label-primary, currentColor));',
  '}',
  '.dtt-iu__badge[data-variant="warning"] {',
  '  background: color-mix(in srgb, #f59e0b 12%, transparent);',
  '  border-color: color-mix(in srgb, #f59e0b 24%, transparent);',
  '  color: color-mix(in srgb, #b45309 65%, var(--dsw-alias-label-primary, currentColor));',
  '}',
  '.dtt-iu__badge[data-variant="dev"] {',
  '  background: color-mix(in srgb, #10b981 12%, transparent);',
  '  border-color: color-mix(in srgb, #10b981 24%, transparent);',
  '  color: color-mix(in srgb, #047857 65%, var(--dsw-alias-label-primary, currentColor));',
  '}',
  '.dtt-iu__badge[data-variant="tool"] {',
  '  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 12%, transparent);',
  '  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 24%, transparent);',
  '  color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #60a5fa) 65%, var(--dsw-alias-label-primary, currentColor));',
  '}',
  '/* 表格卡标题：比通用图注大一档，形成参考图那种标题层级 */',
  'figure.dtt-iu:has(.dtt-iu__table) > .dtt-iu__head { margin-bottom: 8px; }',
  'figure.dtt-iu:has(.dtt-iu__table) > .dtt-iu__head .dtt-iu__title {',
  '  font-size: calc(14.5px * var(--iu-text-scale, 1)); font-weight: 600; letter-spacing: .005em;',
  '}',
  '/* 窄容器：单元格允许换行，表格改固定布局避免把最后几列挤出视口 */',
  '@container iu (max-width: 480px) {',
  '  .dtt-iu__table { table-layout: fixed; font-size: calc(11.5px * var(--iu-text-scale, 1)); }',
  '  .dtt-iu__th:first-child { width: 30%; }',
  '  .dtt-iu__metrics { grid-template-columns: repeat(auto-fit, minmax(86px, 1fr)); gap: 6px; }',
  '  .dtt-iu__metric { padding: 7px 8px; }',
  '  .dtt-iu__metric-val { font-size: calc(13px * var(--iu-text-scale, 1)); }',
  '  .dtt-iu__th, .dtt-iu__td { white-space: normal; overflow-wrap: anywhere; padding: 6px 8px; }',
  '  .dtt-iu__th { padding: 8px 6px 6px; font-size: calc(10px * var(--iu-text-scale, 1)); }',
  '  .dtt-iu__td { padding: 8px 6px; }',
  '  .dtt-iu__th:first-child, .dtt-iu__td:first-child { padding-left: 10px; }',
  '  .dtt-iu__th:last-child, .dtt-iu__td:last-child { padding-right: 10px; }',
  '  .dtt-iu__td[data-align="right"], .dtt-iu__th[data-align="right"] { white-space: nowrap; }',
  '  .dtt-iu__bar-wrap { min-width: 0; gap: 5px; }',
  '  .dtt-iu__bar-num { min-width: 28px; }',
  '  .dtt-iu__table-wrap { border-radius: 10px; }',
  '}',
  '/* 触摸设备没有 hover：排序提示常显 */',
  '@media (hover: none) {',
  '  .dtt-iu__arrow { opacity: .3; }',
  '}',
  '/* 无障碍 */',
  '@media (prefers-reduced-motion: reduce) {',
  '  .dtt-iu__th, .dtt-iu__td { transition: none; }',
  '  .dtt-iu__arrow { transition: none; }',
  '  .dtt-iu__bar-fill { transition: none; }',
  '}',
].join('\n')

export const tableKind: IuKind<TableState, IuTableSpec> = {
  kind: 'table',
  label: '表格',
  parse,
  initState,
  fillText,
  snapshot,
  css: CSS,
  doc: '  · table 数据表：{"kind":"table","title":"华东贵，华北在掉","columns":[{"key":"region","label":"区域"},{"key":"sales","label":"销售额","type":"bar"},{"key":"rate","label":"增长率%","type":"num"}],"rows":[["华东",1280,12],["华北",960,-3],["华南",1105,8],["西南",742,5]],"dense":false,"zebra":true,"metrics":[{"label":"总额","value":"4,087万","sub":"增长8.2%"}],"filters":["全部","华东","华北","华南","西南"]}（columns ≤8：key/label ≤16 字，type=text|num|bar 默认 text、bar 带占比进度条，align=left|right|center 可显式覆盖；未写 type 的文本列若多数单元格是数字/金额/百分比会自动右对齐；metrics ≤4 个指标卡（只有一个时显示为一行说明）；filters ≤8 个过滤芯片；点表头排序、点芯片过滤）。',
}
