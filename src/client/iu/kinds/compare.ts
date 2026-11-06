/**
 * iu kind: compare（产品对比 · 按容器宽铺列 / 窄档纵向堆卡）。
 *
 * 纯逻辑半边：零 React、零 DOM（host 半身的截图管线要 import 它）。
 * React 体见 compare.body.tsx。
 *
 * 三条硬纪律：
 *  · 本文件不写模板字面量（连注释里的反引号都不出现）：build.mjs 的
 *    assertCssTemplateDelimiters 会逐条扫源码，多余定界符会让产物加载即报错。
 *    一律数组 join + 字符串拼接；模型文本全部走 esc / escAttr。
 *  · snapshot() 与 Body 的 class / 层级逐字对齐，共用同一份 CSS。
 *  · 图片用背景图层而非 img 标签：一层首字占位常驻、一层背景图覆盖，
 *    外链加载失败时背景层透明、占位自然可见，无 JS 也不空白。
 */

import type { IuKind, IuSpecBase, IuState } from './contract.ts'
import { arr, boolOrFalse, esc, escAttr, str, strOr } from './core.ts'

/** 单引号字符（拼 CSS url 用；避免源码里出现转义反斜杠）。 */
const APOS = String.fromCharCode(39)
/** 换行字符（数组 join 用；同上）。 */
const NL = String.fromCharCode(10)

/** 单个产品列。 */
export interface IuCompareProduct {
  readonly name: string
  readonly image?: string
  readonly price?: string
  readonly source?: string
  readonly rating?: string
  readonly badge?: string
  readonly highlight?: boolean
  readonly values: readonly string[]
}

export interface IuCompareSpec extends IuSpecBase {
  readonly kind: 'compare'
  readonly title: string
  readonly desc: string
  readonly rows: readonly string[]
  readonly products: readonly IuCompareProduct[]
}

/** 本地状态：选中列下标 + 只看差异开关（外壳持久化）。 */
export interface CompareState extends IuState {
  readonly selected: number
  readonly diffOnly: boolean
}

/**
 * 图片 URL 只收 http(s) 与 data:image，字符白名单挡住属性 / CSS 注入。
 * 白名单排除引号、括号、尖括号、反斜杠与空白，url(...) 拼接才安全。
 */
export function compareImageUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (s.length < 10 || s.length > 2000) return undefined
  if (!/^[A-Za-z0-9:/._?&=%+,;~#@!$-]+$/.test(s)) return undefined
  if (/^https?:[/][/]/i.test(s) || /^data:image[/]/i.test(s)) return s
  return undefined
}

/** 名称首字（无图时的占位；Array.from 处理代理对与 emoji）。 */
export function compareInitial(name: string): string {
  const s = (name || '').trim()
  if (s === '') return '?'
  const first = Array.from(s)[0]
  return first === undefined ? '?' : first
}

/** 背景图层的 CSS url(...) 值（Body 与 snapshot 共用同一份拼法）。 */
export function comparePhotoUrl(image: string): string {
  return 'url(' + APOS + image + APOS + ')'
}

/** 每行是否「所有产品值完全相同」（只看差异的判据，Body 与 snapshot 共用）。 */
export function compareSameRows(spec: IuCompareSpec): boolean[] {
  return spec.rows.map((_r, ri) => {
    if (spec.products.length < 2) return false
    const first = spec.products[0]?.values[ri] ?? '—'
    return spec.products.every(p => (p.values[ri] ?? '—') === first)
  })
}

/** 钳位选中下标（脏 state 防御：持久化层读回的可能是任何旧形状）。 */
export function compareSelected(v: unknown, count: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  const i = Math.trunc(v)
  return i >= 0 && i < count ? i : 0
}

/** 来源与评分的合并文案（两边共用，避免各写一份漂移）。 */
export function compareMeta(p: IuCompareProduct): string {
  const bits: string[] = []
  if (p.source !== undefined && p.source !== '') bits.push(p.source)
  if (p.rating !== undefined && p.rating !== '') bits.push(p.rating)
  return bits.join(' · ')
}

function parse(raw: Record<string, unknown>): IuCompareSpec | undefined {
  const title = strOr(raw.title, 40, '产品对比')
  const desc = str(raw.desc, 120)

  // rows 缺省时按 values 的最大长度补，避免整张规格表空掉；上限 8 行。
  const rowsRaw = arr(raw.rows).slice(0, 8).map((r, i) => str(r, 40) || ('规格 ' + (i + 1)))
  let maxValues = 0
  for (const item of arr(raw.products)) {
    if (typeof item !== 'object' || item === null) continue
    const vals = arr((item as Record<string, unknown>).values)
    if (vals.length > maxValues) maxValues = vals.length
  }
  const rowCount = rowsRaw.length > 0 ? rowsRaw.length : Math.min(8, maxValues)
  const rows: string[] = []
  for (let i = 0; i < rowCount; i += 1) rows.push(rowsRaw[i] ?? ('规格 ' + (i + 1)))

  const products: IuCompareProduct[] = []
  for (const item of arr(raw.products)) {
    if (products.length >= 4) break
    if (typeof item !== 'object' || item === null) continue
    const it = item as Record<string, unknown>
    const name = str(it.name, 60)
    if (name === '') continue
    const rawVals = arr(it.values).slice(0, rowCount)
    const values: string[] = []
    for (let i = 0; i < rowCount; i += 1) values.push(str(rawVals[i], 80) || '—')
    const image = compareImageUrl(it.image)
    const price = str(it.price, 40)
    const source = str(it.source, 40)
    const rating = str(it.rating, 40)
    const badge = str(it.badge, 12)
    products.push({
      name,
      values,
      ...(image !== undefined ? { image } : {}),
      ...(price !== '' ? { price } : {}),
      ...(source !== '' ? { source } : {}),
      ...(rating !== '' ? { rating } : {}),
      ...(badge !== '' ? { badge } : {}),
      ...(boolOrFalse(it.highlight) ? { highlight: true } : {}),
    })
  }
  if (products.length === 0) return undefined
  return { kind: 'compare', title, desc, rows, products }
}

function initState(spec: IuCompareSpec): CompareState {
  const hi = spec.products.findIndex(p => p.highlight === true)
  return { selected: hi >= 0 ? hi : 0, diffOnly: false }
}

function fillText(spec: IuCompareSpec, state: CompareState): string {
  const i = compareSelected(state?.selected, spec.products.length)
  const p = spec.products[i]
  if (p === undefined) return spec.title
  const parts: string[] = []
  for (let ri = 0; ri < spec.rows.length; ri += 1) {
    parts.push((spec.rows[ri] ?? '') + '：' + (p.values[ri] ?? '—'))
  }
  const head = spec.title + ' — ' + p.name + (p.price !== undefined ? '（' + p.price + '）' : '')
  return parts.length === 0 ? head : head + '：' + parts.join('；')
}

/**
 * 静态快照（截图管线用，按初始状态定格：选中列 = initState、差异开关关）。
 * DOM 与 compare.body.tsx 逐字对齐：desc → cmp → toolbar → grid → col(head + specs)。
 */
function snapshot(spec: IuCompareSpec): string {
  const same = compareSameRows(spec)
  const selected = compareSelected(initState(spec).selected, spec.products.length)
  const out: string[] = []
  if (spec.desc !== '') out.push('<p class="dtt-iu__desc">' + esc(spec.desc) + '</p>')
  out.push('<div class="dtt-iu__cmp" data-diff="0">')
  out.push('<div class="dtt-iu__cmp-toolbar">')
  out.push('<span class="dtt-iu__cmp-hint">点列头聚焦产品</span>')
  out.push('<button type="button" class="dtt-iu__cmp-diff" data-on="0" aria-pressed="false">只看差异</button>')
  out.push('</div>')
  out.push('<div class="dtt-iu__cmp-grid">')
  for (let i = 0; i < spec.products.length; i += 1) {
    const p = spec.products[i]
    if (p === undefined) continue
    const activeAttr = i === selected ? ' data-active="1"' : ''
    out.push('<div class="dtt-iu__cmp-col"' + activeAttr + '>')
    out.push('<button type="button" class="dtt-iu__cmp-head" aria-pressed="' + (i === selected ? 'true' : 'false') + '">')
    out.push('<span class="dtt-iu__cmp-media">')
    out.push('<span class="dtt-iu__cmp-initial">' + esc(compareInitial(p.name)) + '</span>')
    if (p.image !== undefined) {
      out.push('<span class="dtt-iu__cmp-photo" style="background-image:' + comparePhotoUrl(escAttr(p.image)) + '"></span>')
    }
    out.push('</span>')
    out.push('<span class="dtt-iu__cmp-name">' + esc(p.name) + '</span>')
    if (p.price !== undefined) out.push('<span class="dtt-iu__cmp-price">' + esc(p.price) + '</span>')
    const meta = compareMeta(p)
    if (meta !== '') out.push('<span class="dtt-iu__cmp-meta">' + esc(meta) + '</span>')
    if (p.badge !== undefined) out.push('<span class="dtt-iu__cmp-badge">' + esc(p.badge) + '</span>')
    out.push('</button>')
    out.push('<div class="dtt-iu__cmp-specs">')
    for (let ri = 0; ri < spec.rows.length; ri += 1) {
      const sameAttr = same[ri] ? ' data-same="1"' : ''
      out.push('<div class="dtt-iu__cmp-row"' + sameAttr + '>')
      out.push('<span class="dtt-iu__cmp-label">' + esc(spec.rows[ri] ?? '') + '</span>')
      out.push('<span class="dtt-iu__cmp-val">' + esc(p.values[ri] ?? '—') + '</span>')
      out.push('</div>')
    }
    out.push('</div>')
    out.push('</div>')
  }
  out.push('</div>')
  out.push('</div>')
  return out.join('')
}

/** 本 kind 专属样式（与基座 IU_CSS 一起注入；截图页内联同一份）。 */
const CSS = [
  '/* compare：产品对比。宽档按容器宽铺列、窄档纵向堆卡，全程不横向裁切。 */',
  '.dtt-iu__cmp { width: 100%; }',
  '.dtt-iu__cmp-toolbar { display: flex; flex-wrap: wrap; align-items: center;',
  '  justify-content: space-between; gap: 8px; margin: 6px 0 10px; }',
  '.dtt-iu__cmp-hint { font-size: calc(11px * var(--iu-text-scale, 1)); opacity: .55; }',
  '.dtt-iu__cmp-diff { font: inherit; font-size: calc(11.5px * var(--iu-text-scale, 1)); font-weight: 500;',
  '  padding: 3px 11px; border-radius: 999px; cursor: pointer; color: inherit;',
  '  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 16%, transparent);',
  '  background: transparent; }',
  '.dtt-iu__cmp-diff[data-on="1"] { color: var(--dsw-alias-state-business-primary, #4176e6);',
  '  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 45%, transparent);',
  '  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 10%, transparent); }',
  '.dtt-iu__cmp-diff:focus-visible, .dtt-iu__cmp-head:focus-visible {',
  '  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6); outline-offset: 2px; }',
  '/* 宽档：列数由容器宽决定（auto-fit 折叠空列），不写死 3 列、不 overflow 裁列。 */',
  '.dtt-iu__cmp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));',
  '  gap: 10px; align-items: start; }',
  '.dtt-iu__cmp-col { min-width: 0; display: flex; flex-direction: column; box-sizing: border-box;',
  '  border-radius: 10px; border: 1px solid transparent; }',
  '.dtt-iu__cmp-col[data-active="1"] {',
  '  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 42%, transparent);',
  '  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 4%, transparent); }',
  '.dtt-iu__cmp-head { display: flex; flex-direction: column; align-items: flex-start; gap: 4px;',
  '  width: 100%; box-sizing: border-box; padding: 8px; border: 0; border-radius: 10px;',
  '  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }',
  '.dtt-iu__cmp-media { position: relative; display: block; width: 100%; aspect-ratio: 16 / 9;',
  '  border-radius: 8px;',
  '  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 6%, transparent); }',
  '.dtt-iu__cmp-initial { position: absolute; inset: 0; display: flex; align-items: center;',
  '  justify-content: center; font-size: calc(28px * var(--iu-text-scale, 1)); font-weight: 600; opacity: .28; }',
  '/* 背景图层：加载失败时该层透明，首字占位自然可见（无 JS、无破图图标）。 */',
  '.dtt-iu__cmp-photo { position: absolute; inset: 0; border-radius: inherit;',
  '  background-size: contain; background-position: center; background-repeat: no-repeat; }',
  '.dtt-iu__cmp-name { font-size: calc(13.5px * var(--iu-text-scale, 1)); font-weight: 600;',
  '  line-height: 1.35; overflow-wrap: anywhere; }',
  '.dtt-iu__cmp-price { font-size: calc(15px * var(--iu-text-scale, 1)); font-weight: 700;',
  '  font-variant-numeric: tabular-nums; }',
  '.dtt-iu__cmp-meta { font-size: calc(11px * var(--iu-text-scale, 1)); opacity: .6; overflow-wrap: anywhere; }',
  '.dtt-iu__cmp-badge { align-self: flex-start; font-size: calc(10.5px * var(--iu-text-scale, 1));',
  '  font-weight: 600; padding: 1px 8px; border-radius: 999px;',
  '  color: var(--dsw-alias-state-business-primary, #4176e6);',
  '  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 12%, transparent); }',
  '.dtt-iu__cmp-specs { display: flex; flex-direction: column; padding: 0 8px 8px; }',
  '.dtt-iu__cmp-row { display: flex; flex-direction: column; gap: 2px;',
  '  min-height: calc(40px * var(--iu-text-scale, 1)); box-sizing: border-box; padding: 6px 4px;',
  '  border-top: .5px solid color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 10%, transparent); }',
  '.dtt-iu__cmp-row:hover {',
  '  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 5%, transparent); }',
  '.dtt-iu__cmp-label { font-size: calc(10.5px * var(--iu-text-scale, 1)); line-height: 1.3;',
  '  opacity: .55; overflow-wrap: anywhere; }',
  '.dtt-iu__cmp-val { font-size: calc(12.5px * var(--iu-text-scale, 1)); font-weight: 500; overflow-wrap: anywhere; }',
  '/* 只看差异：隐藏所有产品值完全一致的规格行。 */',
  '.dtt-iu__cmp[data-diff="1"] .dtt-iu__cmp-row[data-same="1"] { display: none; }',
  '/* 窄档：每产品一张完整小卡，规格改成 label / value 两栏，彻底不横向裁切。 */',
  '@container iu (max-width: 560px) {',
  '  .dtt-iu__cmp-grid { grid-template-columns: 1fr; gap: 12px; }',
  '  .dtt-iu__cmp-col { padding: 2px;',
  '    border-color: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 12%, transparent); }',
  '  .dtt-iu__cmp-row { flex-direction: row; align-items: baseline; gap: 10px; min-height: 0; }',
  '  .dtt-iu__cmp-label { flex: 0 0 38%; opacity: .7; }',
  '  .dtt-iu__cmp-val { flex: 1 1 auto; min-width: 0; }',
  '}',
  '/* 无障碍：本卡无入场动画，宽度与断点切换即时确定，不加 transition。 */',
  '@media (prefers-reduced-motion: reduce) {',
  '  .dtt-iu__cmp-col, .dtt-iu__cmp-row, .dtt-iu__cmp-diff { transition: none; }',
  '}',
].join(NL)

const doc = '  · compare 产品对比：{"kind":"compare","title":"Mac mini 怎么选","products":[{"name":"Apple Mac mini","price":"$899.00","source":"Apple","rating":"4.8","badge":"性价比","values":["M6 12-Core","16GB","入门开发"]},{"name":"Mac mini CTO","price":"$1,049.00","values":["M6 12-Core","24GB","轻量容器"]}],"rows":["处理器","内存","适用场景"]}（products 2–4 个、rows≤8 行；每个产品 values 按 rows 顺序给，缺的补「—」；可选 image 为 http(s) 或 data: URL、price、source、rating、badge、highlight；点列头聚焦某列、「只看差异」隐藏同值行；宽档按容器宽铺列、窄档纵向堆卡，不裁列）。'

export const compareKind: IuKind<CompareState, IuCompareSpec> = {
  kind: 'compare',
  label: '产品对比',
  parse,
  initState,
  fillText,
  snapshot,
  css: CSS,
  doc: doc,
}
