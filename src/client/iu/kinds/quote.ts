/**
 * iu kind: **quote**（行情卡：一个当前价 + 一条走势 + 一组指标）。
 *
 * 为什么需要它：原 13 种 kind 里没有任何一种能画「折线走势」——gauge 只能显示
 * 单点，table 只有数字没有趋势。于是「股价 / 汇率 / 体重 / 粉丝数」这类
 * 「数值 + 趋势」的查询，模型只能写成一段文字。这张卡补的就是这个缺口。
 *
 * 视觉结构（自上而下，Body 与 snapshot 逐字同构）：
 *   1. 标的行：名称（中等字号、稍重）+ 代码（小字、弱化、可省）；
 *   2. 主数字行：字重 300 的超大当前价 + 单位，紧邻涨跌额与涨跌幅（方向色）；
 *   3. 迷你走势：方向色描边 + 同色渐变填充，渐变定义在 SVG 内部，零外部资源；
 *   4. 指标格：横向等分，靠留白与一条发丝线分组，**不给每格灰底方框**；
 *   5. 备注：一行小字，弱化色。
 *
 * ## 涨跌配色（本卡唯一一处「文化相关」的设计决策）
 *
 * 选的是 **A 股 / 中国大陆市场惯例：红涨绿跌**。
 *  · 理由：这张卡的默认用户读中文，看的标的多是 A 股、场内基金、人民币汇率、
 *    国内销量 / 播放量这类「涨了是好事」的数值；红涨绿跌是他们的第一直觉。
 *    若照搬欧美惯例（绿涨红跌），同一张卡会被读反 —— 红色 -3% 属于「看起来
 *    对、读出来错」的那类错误，比丑更糟。
 *  · 落点：方向色**只作用于涨跌数字与走势图**。--q-dir 在根节点一处定义，
 *    由 [data-dir="up|down|flat"] 三档驱动（up 红 #ef4444 系 / down 绿
 *    #10b981 系 / flat 中性灰）。名称、价格、指标、备注一律 currentColor 或
 *    主题令牌，深浅主题都不依赖写死的底色。
 *  · 卡内没有任何底色 / 圆角 / 阴影面，分组只靠留白与 .5px 发丝线（不做卡中卡）。
 *
 * ## 两个半身的契约（同 weather / gauge）
 *
 *  · 本文件是**纯逻辑半边**：零 React、零 DOM。截图管线（host 半身）与能力注入
 *    文档都消费这里；React 体在 quote.body.tsx。
 *  · snapshot() 用数组 join 与 + 拼串，**不用模板字面量**（build.mjs 的源码守卫
 *    会扫到它们）。
 *  · 几何只有一份：sparklinePath / sparkAreaPath / SPARK_VIEWBOX 由 Body 与
 *    snapshot 共用 —— 两边各算一套坐标，迟早漂移成「截图里的曲线和对话流里
 *    不是同一条」。渐变 id 也由同一个 sparkGradientId 生成，保证两处逐字一致。
 */

import type { IuKind, IuSpecBase, IuState } from './contract.ts'
import { arr, esc, escAttr, oneOf, pickAll, str, strOr } from './core.ts'

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 涨跌方向；围栏里缺省时由 change / changePct 的符号推断。 */
export type QuoteDirection = 'up' | 'down' | 'flat'

/** 方向白名单（写成别值时回落到推断结果，不拒绝整卡）。 */
export const QUOTE_DIRECTIONS = ['up', 'down', 'flat'] as const

/** 一个指标格（小字标签 + 数值，各占一行）。 */
export interface IuQuoteMetric {
  readonly label: string
  readonly value: string
}

/** 行情卡 Spec。 */
export interface IuQuoteSpec extends IuSpecBase {
  readonly kind: 'quote'
  /** 标的名称：贵州茅台 / 美元人民币 / 体重。 */
  readonly name: string
  /** 代码或符号：600519 / USDCNY（可省）。 */
  readonly code?: string
  /** 当前价，如 "1680.50"（字符串，可带千分位）。 */
  readonly price: string
  /** 涨跌额，如 "+12.30"（可省）。 */
  readonly change?: string
  /** 涨跌幅，如 "+0.74%"（可省）。 */
  readonly changePct?: string
  /** 方向；缺省从 change / changePct 的符号推断。 */
  readonly direction?: QuoteDirection
  /** 单位：元 / 美元 / kg（可省）。 */
  readonly unit?: string
  /** 开 / 高 / 低 / 成交量，最多 4 项。 */
  readonly metrics?: ReadonlyArray<IuQuoteMetric>
  /** 迷你走势数据点，最多 60 个（只保留最后 60 个）。 */
  readonly series?: ReadonlyArray<number>
  /** 一句话备注，最多 80 字。 */
  readonly note?: string
}

/** 行情卡本地状态：这张卡没有交互状态。 */
export type IuQuoteState = IuState

/* ------------------------------------------------------------------ */
/* 几何（纯函数；Body 与 snapshot 共用，禁止在别处重算）                  */
/* ------------------------------------------------------------------ */

/** 走势图坐标系的宽度（viewBox 单位）。 */
export const SPARK_WIDTH = 100

/** 走势图坐标系的高度（viewBox 单位）。 */
export const SPARK_HEIGHT = 40

/** svg 的 viewBox 字符串（Body 与 snapshot 共用，不在两处各写一遍）。 */
export const SPARK_VIEWBOX = '0 0 ' + SPARK_WIDTH + ' ' + SPARK_HEIGHT

/** 迷你走势最多保留的数据点。 */
export const QUOTE_SERIES_LIMIT = 60

/** 上下留白占高度的比例与上限（防止描边在顶 / 底被切掉）。 */
const SPARK_PAD_RATIO = 0.12
const SPARK_PAD_MAX = 6

/** 两位小数（序列化进 SVG 属性，避免超长浮点尾巴与 NaN）。 */
function r2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

/**
 * 走势线路径（SVG path 的 d 字符串）。
 *
 * 坐标映射：x 按下标等分整宽（首点贴左缘、末点贴右缘），y 按数值线性映射到
 * [pad, height - pad]（值越大越靠上）。全部数值相等时压在中线 —— 不能除以
 * 零；跨度溢出成 Infinity 时同样回中线（NaN 会让整条 path 失效）。
 *
 * 单点数据返回一条水平线（宽度铺满），不返回空串：只有 1 个点时「没有趋势」
 * 仍然应该被画成一条可见的线，而不是让整块区域消失。
 *
 * @param series - 走势数据点（有限数值）。
 * @param width - 坐标系宽度（viewBox 单位）。
 * @param height - 坐标系高度（viewBox 单位）。
 */
export function sparklinePath(series: readonly number[], width: number, height: number): string {
  const n = series.length
  if (n === 0 || !(width > 0) || !(height > 0)) return ''

  const pad = Math.min(height * SPARK_PAD_RATIO, SPARK_PAD_MAX)
  const usable = Math.max(height - pad * 2, 0)

  let min = series[0] as number
  let max = min
  for (const v of series) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min
  const safeSpan = Number.isFinite(span) && span > 0 ? span : 0

  const yOf = (v: number): number => {
    if (safeSpan === 0) return pad + usable / 2
    return pad + (1 - (v - min) / safeSpan) * usable
  }
  const xOf = (i: number): number => {
    if (n === 1) return width / 2
    return (i / (n - 1)) * width
  }

  if (n === 1) {
    const y = r2(yOf(series[0] as number))
    return 'M 0 ' + y + ' L ' + r2(width) + ' ' + y
  }

  const parts: string[] = []
  for (let i = 0; i < n; i += 1) {
    parts.push((i === 0 ? 'M' : 'L') + r2(xOf(i)) + ' ' + r2(yOf(series[i] as number)))
  }
  return parts.join(' ')
}

/**
 * 走势填充路径（同一条线向下闭合成面积）。
 *
 * 内部调用 sparklinePath，绝不另算一套坐标；线路径为空（0 / 1 个点）时返回
 * 空串，调用方跳过 area 的 path 即可。
 */
export function sparkAreaPath(series: readonly number[], width: number, height: number): string {
  if (series.length < 2) return ''
  const line = sparklinePath(series, width, height)
  if (line === '') return ''
  return line + ' L ' + r2(width) + ' ' + r2(height) + ' L 0 ' + r2(height) + ' Z'
}

/** FNV-1a 32 位哈希（只为生成稳定、合法的 SVG 渐变 id）。 */
function hashKey(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/**
 * 渐变 id。
 *
 * 为什么必须按标的派生：同一条对话流里可能同时挂着多张 quote 卡，若都用固定
 * id，后定义的渐变会覆盖先定义的那一份，另一张卡的填充就会串成别人家的颜色。
 * 这里用「名称 + 代码 + 价格 + 序列」做哈希：Body 与 snapshot 输出同一个
 * 字符串（逐字对齐），不同标的 / 不同数据几乎不可能撞。
 */
export function sparkGradientId(spec: IuQuoteSpec): string {
  const series = spec.series ?? []
  return 'dtt-iu-qfill-' + hashKey(spec.name + '|' + (spec.code ?? '') + '|' + spec.price + '|' + series.join(','))
}

/** 字符串里能读出的方向（+1 / -1 / 0）。 */
function signOf(raw: string | undefined): number {
  if (raw === undefined) return 0
  const s = raw.trim()
  if (s === '') return 0
  const head = s.charAt(0)
  if (head === '+' || head === '＋') return 1
  if (head === '-' || head === '−' || head === '－') return -1
  if (s.includes('跌') || s.includes('↓') || s.includes('▼')) return -1
  if (s.includes('涨') || s.includes('↑') || s.includes('▲')) return 1
  const m = s.match(/\d+(?:\.\d+)?/)
  if (m !== null) {
    const n = Number(m[0])
    if (Number.isFinite(n) && n > 0) return 1
  }
  return 0
}

/**
 * 从涨跌额 / 涨跌幅推断方向。
 *
 * 先看涨跌额（更直接），再看涨跌幅；两者都读不出符号时按「平」处理。
 * 0.00 与空串都算平 —— 不能把「没有涨跌」误读成上涨。
 */
export function inferDirection(change?: string, changePct?: string): QuoteDirection {
  const a = signOf(change)
  if (a > 0) return 'up'
  if (a < 0) return 'down'
  const b = signOf(changePct)
  if (b > 0) return 'up'
  if (b < 0) return 'down'
  return 'flat'
}

/* ------------------------------------------------------------------ */
/* 解析（钳位，不拒绝整卡）                                              */
/* ------------------------------------------------------------------ */

/** 文本字段：字符串原样去空白截断；有限数字转字符串（模型常把价格写成数字）。 */
function text(v: unknown, max: number): string {
  if (typeof v === 'number' && Number.isFinite(v)) return str(String(v), max)
  return str(v, max)
}

/** 走势序列：过滤非有限值，只留**最后** limit 个（趋势卡关心的是当下）。 */
function parseSeries(v: unknown, limit: number): number[] {
  const all: number[] = []
  for (const item of arr(v)) {
    if (typeof item === 'number' && Number.isFinite(item)) all.push(item)
  }
  return all.length > limit ? all.slice(all.length - limit) : all
}

function parse(raw: Record<string, unknown>): IuQuoteSpec {
  // 名称与价格缺失时不拒绝整卡：名称回退到标题再回退「行情」，价格回退「—」
  // （契约要求「钳位而不是拒绝」，一张缺价的卡也比整条围栏回退成代码块好）。
  const name = text(raw.name ?? raw.label, 24) || text(raw.title, 24) || '行情'
  const title = strOr(raw.title, 40, name)
  const code = text(raw.code ?? raw.symbol ?? raw.ticker, 24)
  const price = text(raw.price ?? raw.last ?? raw.value, 24) || '—'
  const change = text(raw.change ?? raw.delta ?? raw.chg, 16)
  const changePct = text(raw.changePct ?? raw.changePercent ?? raw.pct, 16)
  const unit = text(raw.unit, 8)
  const note = text(raw.note ?? raw.remark ?? raw.tips, 80)

  // 方向：显式值合法时优先（模型自己判断过），否则按符号推断。
  const direction = oneOf<QuoteDirection>(
    raw.direction ?? raw.dir,
    QUOTE_DIRECTIONS,
    inferDirection(change, changePct),
  )

  // 指标：取**前** 4 个合格项；label 与 value 全空的对象跳过，缺一半的补占位。
  const metrics = pickAll<IuQuoteMetric>(raw.metrics, 4, (it) => {
    const label = text(it.label ?? it.name ?? it.key, 12)
    const value = text(it.value ?? it.val, 16)
    if (label === '' && value === '') return undefined
    return { label: label === '' ? '指标' : label, value: value === '' ? '—' : value }
  })

  const series = parseSeries(raw.series ?? raw.trend ?? raw.points, QUOTE_SERIES_LIMIT)

  return {
    kind: 'quote',
    title,
    name,
    ...(code !== '' ? { code } : {}),
    price,
    ...(change !== '' ? { change } : {}),
    ...(changePct !== '' ? { changePct } : {}),
    direction,
    ...(unit !== '' ? { unit } : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
    ...(series.length > 0 ? { series } : {}),
    ...(note !== '' ? { note } : {}),
  }
}

/** 这张卡没有交互状态。 */
function initState(_spec: IuQuoteSpec): IuQuoteState {
  return {}
}

/**
 * 回写文本：必须含真实数值。
 * 形如「贵州茅台（600519）1680.50 元（+12.30 +0.74%）」。
 */
function fillText(spec: IuQuoteSpec, _state: IuQuoteState): string {
  const head = spec.code !== undefined && spec.code !== '' ? spec.name + '（' + spec.code + '）' : spec.name
  const price = spec.unit !== undefined && spec.unit !== '' ? spec.price + ' ' + spec.unit : spec.price
  const delta: string[] = []
  if (spec.change !== undefined && spec.change !== '') delta.push(spec.change)
  if (spec.changePct !== undefined && spec.changePct !== '') delta.push(spec.changePct)
  let out = head + ' ' + price
  if (delta.length > 0) out += '（' + delta.join(' ') + '）'
  if (spec.note !== undefined && spec.note !== '') out += '，' + spec.note
  return out
}

/* ------------------------------------------------------------------ */
/* 静态快照（截图管线用；DOM 必须与 quote.body.tsx 逐字对齐）             */
/* ------------------------------------------------------------------ */

/**
 * 拼静态 HTML。
 *
 * 纪律（违反任一条都会在截图里露馅）：
 *  · 所有模型文本走 esc，属性走 escAttr（截图页跑在 --disable-web-security 的
 *    无头 Chrome 里，模型文本逃出标签上下文就等于任意脚本）；
 *  · 只用数组 join 与 + 拼串，不写模板字面量；
 *  · class 名 / 层级 / 顺序与 Body 完全一致 —— 两边共用同一份 CSS，
 *    结构分叉就是「同一张卡两个样子」。
 */
function snapshot(spec: IuQuoteSpec): string {
  const dir = spec.direction ?? inferDirection(spec.change, spec.changePct)
  const parts: string[] = []

  parts.push('<div class="dtt-iu__quote" data-dir="' + escAttr(dir) + '">')

  /*
   * 1. 标的行：名称 + 代码（可省）。
   *
   * **名称与卡片头重复时不画**：parse 里 title 缺省回退成 name，所以模型最常见的
   * 写法是「只给 name」——那张卡的卡头就是「贵州茅台」，正文再写一遍就是同一个
   * 名字出现两行（实测截图里一眼可见，用户会当成排版 bug）。
   * 名字被省掉时，代码不能跟着消失：挪到价格行末尾当小字尾注。
   */
  const showName = spec.name !== spec.title
  const codeText = spec.code !== undefined && spec.code !== '' ? spec.code : ''
  if (showName) {
    parts.push('<div class="dtt-iu__qhead">')
    parts.push('<span class="dtt-iu__qname">' + esc(spec.name) + '</span>')
    if (codeText !== '') parts.push('<span class="dtt-iu__qcode">' + esc(codeText) + '</span>')
    parts.push('</div>')
  }

  // 2. 主数字行：价格 + 单位 + 涨跌（方向色）
  const hasChange = spec.change !== undefined && spec.change !== ''
  const hasPct = spec.changePct !== undefined && spec.changePct !== ''
  parts.push('<div class="dtt-iu__qprice-row">')
  parts.push('<span class="dtt-iu__qprice">' + esc(spec.price) + '</span>')
  if (spec.unit !== undefined && spec.unit !== '') {
    parts.push('<span class="dtt-iu__qunit">' + esc(spec.unit) + '</span>')
  }
  if (hasChange || hasPct) {
    parts.push('<span class="dtt-iu__qdelta">')
    if (hasChange) parts.push('<span class="dtt-iu__qchg">' + esc(spec.change) + '</span>')
    if (hasPct) parts.push('<span class="dtt-iu__qpct">' + esc(spec.changePct) + '</span>')
    parts.push('</span>')
  }
  // 名称被卡头吃掉时，代码作为价格行的尾注保留（否则「600519」彻底消失）
  if (!showName && codeText !== '') {
    parts.push('<span class="dtt-iu__qcode dtt-iu__qcode--inline">' + esc(codeText) + '</span>')
  }
  parts.push('</div>')

  // 3. 迷你走势（有 series 才画）：渐变定义在 SVG 内部，不引外部资源
  const series = spec.series ?? []
  if (series.length > 0) {
    const gradId = sparkGradientId(spec)
    const lineD = sparklinePath(series, SPARK_WIDTH, SPARK_HEIGHT)
    const areaD = sparkAreaPath(series, SPARK_WIDTH, SPARK_HEIGHT)
    parts.push('<div class="dtt-iu__qchart">')
    parts.push('<svg class="dtt-iu__qspark" viewBox="' + SPARK_VIEWBOX + '" preserveAspectRatio="none" aria-hidden="true">')
    parts.push('<defs>')
    parts.push('<linearGradient id="' + escAttr(gradId) + '" x1="0" y1="0" x2="0" y2="1">')
    parts.push('<stop class="dtt-iu__qstop-top" offset="0%"></stop>')
    parts.push('<stop class="dtt-iu__qstop-bottom" offset="100%"></stop>')
    parts.push('</linearGradient>')
    parts.push('</defs>')
    if (areaD !== '') {
      parts.push('<path class="dtt-iu__qarea" d="' + escAttr(areaD) + '" fill="url(#' + escAttr(gradId) + ')"></path>')
    }
    parts.push('<path class="dtt-iu__qline" d="' + escAttr(lineD) + '"></path>')
    parts.push('</svg>')
    parts.push('</div>')
  }

  // 4. 指标格（有 metrics 才画）：横向等分，无灰底方框
  if (spec.metrics !== undefined && spec.metrics.length > 0) {
    parts.push('<div class="dtt-iu__qmetrics">')
    for (const m of spec.metrics) {
      parts.push('<div class="dtt-iu__qm-item">')
      parts.push('<span class="dtt-iu__qm-label">' + esc(m.label) + '</span>')
      parts.push('<span class="dtt-iu__qm-val">' + esc(m.value) + '</span>')
      parts.push('</div>')
    }
    parts.push('</div>')
  }

  // 5. 备注
  if (spec.note !== undefined && spec.note !== '') {
    parts.push('<div class="dtt-iu__qnote">' + esc(spec.note) + '</div>')
  }

  parts.push('</div>')
  return parts.join('')
}

/* ------------------------------------------------------------------ */
/* 样式                                                                 */
/* ------------------------------------------------------------------ */

const CSS = [
  '/* ───────────────────────── iu kind: quote ───────────────────────── */',
  '/* 涨跌配色：**A 股 / 中国大陆市场惯例——红涨绿跌**（与欧美「绿涨红跌」相反）。',
  '   默认用户读中文、看的标的多是 A 股 / 场内基金 / 人民币汇率 / 国内指标，',
  '   红涨绿跌才是第一直觉；照搬欧美配色会让同一张卡被读反。方向色只落在涨跌',
  '   数字与走势图上（--q-dir 一处定义、data-dir 三档驱动），其余文字一律',
  '   currentColor 或主题令牌，深浅主题都不依赖写死的底色。 */',
  '.dtt-iu__quote { display: flex; flex-direction: column; width: 100%; padding: 2px 0;',
  '  --q-dir: var(--dsw-alias-label-secondary, currentColor); }',
  '.dtt-iu__quote[data-dir="up"] { --q-dir: #ef4444; }',
  '.dtt-iu__quote[data-dir="down"] { --q-dir: #10b981; }',
  '.dtt-iu__quote[data-dir="flat"] { --q-dir: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }',
  '/* 1. 标的行：名称中等字号、稍重；代码小字弱化（可省） */',
  '.dtt-iu__qhead { display: flex; align-items: baseline; gap: 8px; min-width: 0; }',
  '.dtt-iu__qname { font-size: calc(15px * var(--iu-text-scale, 1)); font-weight: 600;',
  '  letter-spacing: -.01em; color: currentColor; white-space: nowrap;',
  '  overflow: hidden; text-overflow: ellipsis; }',
  '.dtt-iu__qcode { font-size: calc(11.5px * var(--iu-text-scale, 1)); font-weight: 500;',
  '  letter-spacing: .04em; color: var(--dsw-alias-label-tertiary, currentColor);',
  '  font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }',
  '/* 2. 主数字行：超大 · 极细 · 等宽；单位与涨跌紧随其右，涨跌小一档、方向色 */',
  '.dtt-iu__qprice-row { display: flex; align-items: baseline; flex-wrap: wrap;',
  '  column-gap: 5px; row-gap: 4px; margin-top: 7px; }',
  '.dtt-iu__qprice { font-size: calc(44px * var(--iu-text-scale, 1)); font-weight: 300;',
  '  line-height: 1.02; letter-spacing: -.035em; color: currentColor;',
  '  font-variant-numeric: tabular-nums; }',
  '.dtt-iu__qunit { font-size: calc(12px * var(--iu-text-scale, 1)); font-weight: 500;',
  '  letter-spacing: .02em; color: var(--dsw-alias-label-tertiary, currentColor); }',
  '.dtt-iu__qdelta { display: inline-flex; align-items: baseline; gap: 8px; margin-left: 7px;',
  '  font-size: calc(15px * var(--iu-text-scale, 1)); font-weight: 600;',
  '  letter-spacing: -.01em; font-variant-numeric: tabular-nums; color: var(--q-dir); }',
  '/* 3. 迷你走势：方向色描边 + 同色顶部渐隐填充。',
  '   渐变由 SVG 内部的 linearGradient 定义（stop 走 currentColor），不引外部资源。',
  '   入场只有透明度（起点 .72 已经可见）——截图 / 节流定格时绝不会是一片空白。 */',
  '.dtt-iu__qchart { margin-top: 13px; }',
  '.dtt-iu__qspark { display: block; width: 100%; height: calc(54px * var(--iu-text-scale, 1));',
  '  color: var(--q-dir); overflow: visible;',
  '  animation: dtt-iu-qspark-in .42s cubic-bezier(.2,.8,.25,1) both; }',
  '@keyframes dtt-iu-qspark-in { from { opacity: .72 } to { opacity: 1 } }',
  '.dtt-iu__qarea { stroke: none; }',
  '.dtt-iu__qstop-top { stop-color: currentColor; stop-opacity: .28; }',
  '.dtt-iu__qstop-bottom { stop-color: currentColor; stop-opacity: 0; }',
  '.dtt-iu__qline { fill: none; stroke: currentColor; stroke-width: 1.6;',
  '  stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }',
  '/* 4. 指标格：横向等分，只靠上方一条发丝线与留白分组——不加灰底方框 */',
  '.dtt-iu__qmetrics { display: flex; align-items: flex-start; gap: 14px; margin-top: 14px;',
  '  padding-top: 11px; border-top: .5px solid rgba(127,127,127,.16); }',
  '.dtt-iu__qm-item { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 3px; }',
  '.dtt-iu__qm-label { font-size: calc(11px * var(--iu-text-scale, 1)); letter-spacing: .02em;',
  '  color: var(--dsw-alias-label-tertiary, currentColor); white-space: nowrap;',
  '  overflow: hidden; text-overflow: ellipsis; }',
  '.dtt-iu__qm-val { font-size: calc(13.5px * var(--iu-text-scale, 1)); font-weight: 600;',
  '  letter-spacing: -.01em; color: currentColor; font-variant-numeric: tabular-nums;',
  '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '/* 5. 备注：一行小字，弱化 */',
  '.dtt-iu__qnote { margin-top: 12px; font-size: calc(11.5px * var(--iu-text-scale, 1));',
  '  line-height: 1.55; color: var(--dsw-alias-label-tertiary, currentColor); }',
  '/* 窄屏：主数字降一档，指标格折成 2×2，不做横排挤压 */',
  '@media (max-width: 480px) {',
  '  .dtt-iu__qprice { font-size: calc(38px * var(--iu-text-scale, 1)); }',
  '  .dtt-iu__qmetrics { flex-wrap: wrap; row-gap: 10px; }',
  '  .dtt-iu__qm-item { flex: 1 1 40%; }',
  '}',
  '/* 无障碍：关掉装饰性入场动画（本卡没有依赖动画才可见的内容） */',
  '@media (prefers-reduced-motion: reduce) {',
  '  .dtt-iu__qspark { animation: none; }',
  '}',
].join('\n')

/* ------------------------------------------------------------------ */
/* kind 模块                                                            */
/* ------------------------------------------------------------------ */

export const quoteKind: IuKind<IuQuoteState, IuQuoteSpec> = {
  kind: 'quote',
  label: '行情',
  parse,
  initState,
  fillText,
  snapshot,
  css: CSS,
  doc: '  · quote 行情：{"kind":"quote","name":"贵州茅台","code":"600519","price":"1680.50","change":"+12.30","changePct":"+0.74%","unit":"元","metrics":[{"label":"开盘","value":"1670.00"},{"label":"最高","value":"1692.00"},{"label":"最低","value":"1668.00"},{"label":"成交","value":"3.2万手"}],"series":[1668,1672,1670,1680,1686,1680.5],"note":"放量突破月线"}（约束：name标的名称、price当前价（字符串，可带千分位，缺省不拒绝整卡）、可选code/change/changePct/unit/note（note≤80）、direction=up|down|flat（缺省按change/changePct的符号推断，红涨绿跌）、metrics≤4项（label小字+value数值，各一行）、series≤60个数字（超出只留最后60个）画迷你走势）。',
}
