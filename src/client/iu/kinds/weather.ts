/**
 * iu kind: **weather**（天气预报与生活气象卡片 · 高级呼吸感设计）。
 *
 * 视觉哲学：
 *  1. **彻底去框感**：告别生硬的「卡中卡」与层层灰色小框，整张卡片通透、轻盈；
 *  2. **大视觉中心 Hero**：超大 46px 极细纯净数字气温，带有手机系统级天气小组件的视觉张力；
 *  3. **指标无框排列**：风向/湿度/紫外线/空气质量采用通透的等宽四列排列，靠留白呼吸；
 *  4. **电影级矢量 SVG 图标**：饱满光影、双层渐变、立体云雨。
 */

import type { IuKind, IuSpecBase, IuState } from './contract.ts'
import { esc, escAttr, str, strOr } from './core.ts'

/** 单天预报数据项。 */
export interface IuWeatherForecastItem {
  readonly day: string
  readonly condition: string
  readonly temp: string
  readonly rain?: string
}

/** 天气卡片 Spec。 */
export interface IuWeatherSpec extends IuSpecBase {
  readonly kind: 'weather'
  readonly city: string
  readonly temp: string
  readonly condition: string
  readonly range?: string
  readonly aqi?: string
  readonly wind?: string
  readonly humidity?: string
  readonly uv?: string
  readonly tips?: string
  readonly forecast: readonly IuWeatherForecastItem[]
}

/** 天气卡片本地状态。 */
export interface IuWeatherState extends IuState {
  readonly activeDay?: number | null
}

export type WeatherType = 'sunny' | 'cloudy' | 'overcast' | 'rain' | 'thunder' | 'snow' | 'fog' | 'wind'

/** 根据中文天气状况描述推断天气类型。 */
export function classifyWeather(condition: string): WeatherType {
  const c = condition.trim().toLowerCase()
  if (c.includes('雷') || c.includes('暴雨')) return 'thunder'
  if (c.includes('雪')) return 'snow'
  if (c.includes('雨')) return 'rain'
  if (c.includes('雾') || c.includes('霾') || c.includes('沙') || c.includes('尘')) return 'fog'
  if (c.includes('风') || c.includes('飑')) return 'wind'
  if (c.includes('阴')) return 'overcast'
  if (c.includes('多云')) return 'cloudy'
  if (c.includes('晴')) return 'sunny'
  return 'cloudy'
}

/** 分离温度数字与单位符号。例如 "21℃" -> { num: "21", unit: "°" } */
export function parseTempParts(raw: string): { num: string; unit: string } {
  const s = raw.trim()
  const m = s.match(/^(-?\d+(?:\.\d+)?)/)
  if (m) {
    return { num: m[1], unit: '°' }
  }
  return { num: s || '--', unit: '' }
}

/** 精致内联 SVG 天气图标。 */
export function renderWeatherSvg(type: WeatherType, size = 48): string {
  switch (type) {
    case 'sunny':
      return [
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" fill="none" class="dtt-iu__wicon" aria-hidden="true">',
        '  <circle cx="24" cy="24" r="11" fill="#f59e0b"/>',
        '  <circle cx="24" cy="24" r="14" fill="#f59e0b" opacity=".18"/>',
        '  <g stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" opacity=".9">',
        '    <line x1="24" y1="4" x2="24" y2="8"/>',
        '    <line x1="24" y1="40" x2="24" y2="44"/>',
        '    <line x1="4" y1="24" x2="8" y2="24"/>',
        '    <line x1="40" y1="24" x2="44" y2="24"/>',
        '    <line x1="9.8" y1="9.8" x2="12.8" y2="12.8"/>',
        '    <line x1="35.2" y1="35.2" x2="38.2" y2="38.2"/>',
        '    <line x1="9.8" y1="38.2" x2="12.8" y2="35.2"/>',
        '    <line x1="35.2" y1="12.8" x2="38.2" y2="9.8"/>',
        '  </g>',
        '</svg>',
      ].join('\n')
    case 'cloudy':
      return [
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" fill="none" class="dtt-iu__wicon" aria-hidden="true">',
        '  <circle cx="19" cy="19" r="8" fill="#f59e0b"/>',
        '  <path d="M16 38h19a8 8 0 0 0 1.5-15.8A10 10 0 0 0 17 19a7 7 0 0 0-1 19z" fill="#94a3b8" opacity=".95"/>',
        '</svg>',
      ].join('\n')
    case 'overcast':
      return [
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" fill="none" class="dtt-iu__wicon" aria-hidden="true">',
        '  <path d="M14 26a7 7 0 0 1 13.3-3A9 9 0 0 1 43 29a7 7 0 0 1-7 7H14a7 7 0 0 1 0-14z" fill="#64748b" opacity=".85"/>',
        '  <path d="M8 33a6 6 0 0 1 11.4-2.6A7.5 7.5 0 0 1 33 35.5a6 6 0 0 1-6 6.5H8a6 6 0 0 1 0-12z" fill="#94a3b8"/>',
        '</svg>',
      ].join('\n')
    case 'rain':
      return [
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" fill="none" class="dtt-iu__wicon" aria-hidden="true">',
        '  <path d="M13 25h22a7.5 7.5 0 0 0 1.5-14.8A9.5 9.5 0 0 0 15 13a6.5 6.5 0 0 0-2 12z" fill="#64748b"/>',
        '  <g stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round">',
        '    <line x1="16" y1="31" x2="13" y2="38"/>',
        '    <line x1="24" y1="31" x2="21" y2="38"/>',
        '    <line x1="32" y1="31" x2="29" y2="38"/>',
        '  </g>',
        '</svg>',
      ].join('\n')
    case 'thunder':
      return [
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" fill="none" class="dtt-iu__wicon" aria-hidden="true">',
        '  <path d="M13 24h22a7.5 7.5 0 0 0 1.5-14.8A9.5 9.5 0 0 0 15 12a6.5 6.5 0 0 0-2 12z" fill="#475569"/>',
        '  <polygon points="25,25 18,34 24,34 21,43 32,31 27,31" fill="#fbbf24"/>',
        '</svg>',
      ].join('\n')
    case 'snow':
      return [
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" fill="none" class="dtt-iu__wicon" aria-hidden="true">',
        '  <path d="M13 24h22a7.5 7.5 0 0 0 1.5-14.8A9.5 9.5 0 0 0 15 12a6.5 6.5 0 0 0-2 12z" fill="#64748b"/>',
        '  <g fill="#7dd3fc">',
        '    <circle cx="16" cy="33" r="2"/>',
        '    <circle cx="24" cy="36" r="2"/>',
        '    <circle cx="32" cy="33" r="2"/>',
        '  </g>',
        '</svg>',
      ].join('\n')
    case 'fog':
      return [
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" fill="none" class="dtt-iu__wicon" aria-hidden="true">',
        '  <g stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round">',
        '    <line x1="10" y1="17" x2="38" y2="17"/>',
        '    <line x1="7" y1="24" x2="41" y2="24"/>',
        '    <line x1="12" y1="31" x2="36" y2="31"/>',
        '  </g>',
        '</svg>',
      ].join('\n')
    case 'wind':
    default:
      return [
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" fill="none" class="dtt-iu__wicon" aria-hidden="true">',
        '  <path d="M8 18h24a4 4 0 1 0-4-4M10 25h27a4.5 4.5 0 1 1-4.5 4.5M8 32h16a3.5 3.5 0 1 0-3.5-3.5" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round" fill="none"/>',
        '</svg>',
      ].join('\n')
  }
}

/** 格式化温度显示。 */
function formatTemp(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(Math.round(raw)) + '℃'
  }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') return '--'
    if (s.endsWith('℃') || s.endsWith('°C') || s.endsWith('°')) return s
    if (/^-?\d+(\.\d+)?$/.test(s)) return s + '℃'
    return s
  }
  return '--'
}

function parse(raw: Record<string, unknown>): IuWeatherSpec | undefined {
  const title = strOr(raw.title, 40, '天气预报')
  const city = strOr(raw.city, 24, '') || title.split(' ')[0] || '本地'
  const temp = formatTemp(raw.temp ?? raw.temperature)
  const condition = strOr(raw.condition ?? raw.weather, 16, '多云')
  const range = str(raw.range ?? raw.tempRange, 24) || undefined
  const aqi = str(raw.aqi ?? raw.air, 20) || undefined
  const wind = str(raw.wind, 20) || undefined
  const humidity = str(raw.humidity, 20) || undefined
  const uv = str(raw.uv, 20) || undefined
  const tips = str(raw.tips ?? raw.tip ?? raw.desc, 120) || undefined

  const rawForecast = Array.isArray(raw.forecast) ? raw.forecast : []
  const forecast: IuWeatherForecastItem[] = []
  for (const item of rawForecast.slice(0, 7)) {
    if (typeof item === 'object' && item !== null) {
      const rec = item as Record<string, unknown>
      const day = strOr(rec.day ?? rec.date, 16, '')
      const cond = strOr(rec.condition ?? rec.weather, 16, '多云')
      const t = formatTemp(rec.temp ?? rec.range)
      const rain = str(rec.rain ?? rec.pop, 12) || undefined
      if (day !== '' || t !== '--') {
        forecast.push({ day: day || '预报', condition: cond, temp: t, ...(rain ? { rain } : {}) })
      }
    }
  }

  return {
    kind: 'weather',
    title,
    city,
    temp,
    condition,
    ...(range ? { range } : {}),
    ...(aqi ? { aqi } : {}),
    ...(wind ? { wind } : {}),
    ...(humidity ? { humidity } : {}),
    ...(uv ? { uv } : {}),
    ...(tips ? { tips } : {}),
    forecast,
  }
}

function initState(_spec: IuWeatherSpec): IuWeatherState {
  return { activeDay: null }
}

function fillText(spec: IuWeatherSpec, _state: IuWeatherState): string {
  const parts = ['[' + spec.city + '天气] 当前' + spec.condition + ' ' + spec.temp]
  if (spec.range) parts.push('(' + spec.range + ')')
  if (spec.aqi) parts.push('空气 ' + spec.aqi)
  if (spec.tips) parts.push(spec.tips)
  return parts.join('，')
}

function snapshot(spec: IuWeatherSpec): string {
  const wType = classifyWeather(spec.condition)
  const iconSvg = renderWeatherSvg(wType, 56)
  const tempParts = parseTempParts(spec.temp)

  const aqiBadge = spec.aqi
    ? '<span class="dtt-iu__waqi-pill"><span class="dtt-iu__waqi-dot">●</span> AQI ' + esc(spec.aqi) + '</span>'
    : ''

  const subLine = spec.range
    ? '<div class="dtt-iu__wsub">' + esc(spec.range) + '</div>'
    : ''

  const heroHtml = [
    '<div class="dtt-iu__whero">',
    '  <div class="dtt-iu__wmain">',
    '    <div class="dtt-iu__wcity-line">',
    '      <span class="dtt-iu__wcity">' + esc(spec.city) + '</span>',
    '      <span class="dtt-iu__wdot">·</span>',
    '      <span class="dtt-iu__wcond">' + esc(spec.condition) + '</span>',
    '      ' + aqiBadge,
    '    </div>',
    '    <div class="dtt-iu__wtemp-line">',
    '      <span class="dtt-iu__wbig-temp">' + esc(tempParts.num) + '</span>',
    '      <span class="dtt-iu__wdeg">' + esc(tempParts.unit) + '</span>',
    '    </div>',
    '    ' + subLine,
    '  </div>',
    '  <div class="dtt-iu__wicon-hero">' + iconSvg + '</div>',
    '</div>',
  ].join('\n')

  const metrics: { label: string; value: string }[] = []
  if (spec.wind) metrics.push({ label: '风向风力', value: spec.wind })
  if (spec.humidity) metrics.push({ label: '相对湿度', value: spec.humidity })
  if (spec.uv) metrics.push({ label: '紫外线', value: spec.uv })
  if (spec.aqi && !heroHtml.includes('waqi-pill')) metrics.push({ label: '空气质量', value: spec.aqi })

  const metricsHtml = metrics.length > 0
    ? '<div class="dtt-iu__wmetrics">' +
      metrics.map((m) => [
        '<div class="dtt-iu__wm-item">',
        '  <span class="dtt-iu__wm-label">' + esc(m.label) + '</span>',
        '  <span class="dtt-iu__wm-val">' + esc(m.value) + '</span>',
        '</div>',
      ].join('')).join('') +
      '</div>'
    : ''

  const tipsHtml = spec.tips
    ? '<div class="dtt-iu__wtips"><span class="dtt-iu__wtips-icon" aria-hidden="true">💡</span><span class="dtt-iu__wtips-text">' + esc(spec.tips) + '</span></div>'
    : ''

  const forecastHtml = Array.isArray(spec.forecast) && spec.forecast.length > 0
    ? '<div class="dtt-iu__wforecast">' +
      spec.forecast.map((f, i) => {
        const itemType = classifyWeather(f.condition)
        const itemSvg = renderWeatherSvg(itemType, 22)
        const rainTag = f.rain ? '<span class="dtt-iu__wf-rain">' + esc(f.rain) + '</span>' : ''
        return [
          '<div class="dtt-iu__wf-col" data-index="' + i + '">',
          '  <span class="dtt-iu__wf-day">' + esc(f.day) + '</span>',
          '  <div class="dtt-iu__wf-icon">' + itemSvg + '</div>',
          '  <span class="dtt-iu__wf-cond">' + esc(f.condition) + '</span>',
          '  <span class="dtt-iu__wf-temp">' + esc(f.temp) + '</span>',
          '  ' + rainTag,
          '</div>',
        ].join('')
      }).join('') +
      '</div>'
    : ''

  return [
    '<div class="dtt-iu__weather" data-cond="' + escAttr(wType) + '">',
    heroHtml,
    metricsHtml,
    tipsHtml,
    forecastHtml,
    '</div>',
  ].join('\n')
}

const CSS = [
  '/* ───────────────────────── iu kind: weather ───────────────────────── */',
  '.dtt-iu__weather { display: flex; flex-direction: column; width: 100%; padding: 2px 0; }',
  '/* 顶部 Hero：通透无生硬内框，左右呼应 */',
  '.dtt-iu__whero { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 2px 0 14px; }',
  '.dtt-iu__wmain { display: flex; flex-direction: column; min-width: 0; }',
  '.dtt-iu__wcity-line { display: flex; align-items: center; gap: 6px; font-size: calc(13px * var(--iu-text-scale, 1)); font-weight: 500; opacity: .85; margin-bottom: 4px; }',
  '.dtt-iu__wcity { font-weight: 600; color: currentColor; letter-spacing: -.01em; }',
  '.dtt-iu__wdot { opacity: .4; font-size: 10px; }',
  '.dtt-iu__wcond { font-weight: 500; opacity: .9; }',
  '.dtt-iu__waqi-pill { display: inline-flex; align-items: center; gap: 4px; font-size: calc(11px * var(--iu-text-scale, 1)); padding: 1.5px 8px;',
  '  border-radius: 999px; background: rgba(16,185,129,.12); color: #10b981; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }',
  '.dtt-iu__waqi-dot { font-size: 8px; line-height: 1; }',
  '/* 核心温度行：超大字号，极致纤细张力 */',
  '.dtt-iu__wtemp-line { display: flex; align-items: baseline; gap: 2px; line-height: 1; }',
  '.dtt-iu__wbig-temp { font-size: calc(52px * var(--iu-text-scale, 1)); font-weight: 260; font-variant-numeric: tabular-nums; letter-spacing: -.04em; color: currentColor; }',
  '.dtt-iu__wdeg { font-size: calc(26px * var(--iu-text-scale, 1)); font-weight: 200; opacity: .55; transform: translateY(-16px); display: inline-block; }',
  '.dtt-iu__wsub { margin-top: 5px; font-size: calc(12px * var(--iu-text-scale, 1)); opacity: .7; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }',
  '.dtt-iu__wicon-hero { display: flex; align-items: center; justify-content: center; flex-shrink: 0; padding-top: 2px;',
  '  filter: drop-shadow(0 4px 14px rgba(245,158,11,.15)); }',
  '/* 四列气象生活指标：极简通透，去除灰色小块框 */',
  '.dtt-iu__wmetrics { display: grid; grid-template-columns: repeat(4, 1fr); padding: 11px 0 12px;',
  '  border-top: .5px solid rgba(127,127,127,.16); border-bottom: .5px solid rgba(127,127,127,.16); margin-bottom: 12px; }',
  '.dtt-iu__wm-item { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; }',
  '.dtt-iu__wm-label { font-size: calc(11px * var(--iu-text-scale, 1)); color: var(--dsw-alias-label-tertiary, currentColor); opacity: .6; }',
  '.dtt-iu__wm-val { font-size: calc(13px * var(--iu-text-scale, 1)); font-weight: 600; font-variant-numeric: tabular-nums; color: currentColor; }',
  '/* 生活贴士：温馨微胶囊 */',
  '.dtt-iu__wtips { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: var(--iu-r-md, 8px);',
  '  background: rgba(245,158,11,.08); color: var(--dsw-alias-label-secondary, currentColor); margin-bottom: 12px; }',
  '.dtt-iu__wtips-icon { font-size: 13px; flex-shrink: 0; opacity: .9; }',
  '.dtt-iu__wtips-text { font-size: calc(11.5px * var(--iu-text-scale, 1)); line-height: 1.4; color: currentColor; opacity: .9; }',
  '/* 多日天气预报横列：自然通透，无灰色硬框，悬停柔和微光 */',
  '.dtt-iu__wforecast { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: thin; }',
  '.dtt-iu__wf-col { flex: 1 1 0; min-width: 58px; display: flex; flex-direction: column; align-items: center; gap: 5px;',
  '  padding: 8px 4px; border-radius: var(--iu-r-md, 8px); background: transparent; border: .5px solid transparent;',
  '  transition: background-color .18s ease, transform .15s ease; cursor: default; }',
  '.dtt-iu__wf-col:hover, .dtt-iu__wf-col[data-active="true"] { background: rgba(127,127,127,.07); border-color: rgba(127,127,127,.12); transform: translateY(-1px); }',
  '.dtt-iu__wf-day { font-size: calc(11.5px * var(--iu-text-scale, 1)); font-weight: 500; opacity: .9; }',
  '.dtt-iu__wf-icon { display: flex; align-items: center; justify-content: center; height: 26px; }',
  '.dtt-iu__wf-cond { font-size: calc(11px * var(--iu-text-scale, 1)); opacity: .75; white-space: nowrap; }',
  '.dtt-iu__wf-temp { font-size: calc(11.5px * var(--iu-text-scale, 1)); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }',
  '.dtt-iu__wf-rain { font-size: 10px; color: #0ea5e9; font-variant-numeric: tabular-nums; }',
  '@media (max-width: 480px) {',
  '  .dtt-iu__wbig-temp { font-size: calc(44px * var(--iu-text-scale, 1)); }',
  '  .dtt-iu__wmetrics { grid-template-columns: repeat(2, 1fr); gap: 8px; }',
  '}',
].join('\n')

export const weatherKind: IuKind<IuWeatherState, IuWeatherSpec> = {
  kind: 'weather',
  label: '天气',
  parse,
  initState,
  fillText,
  snapshot,
  css: CSS,
  doc: '  · weather 天气：{"kind":"weather","city":"北京","temp":"21℃","condition":"晴","range":"12~24℃","aqi":"32 优","wind":"北风 2级","humidity":"38%","tips":"昼夜温差偏大，早晚外出建议备薄外套","forecast":[{"day":"今天","condition":"晴","temp":"12~24℃"},{"day":"明天","condition":"多云","temp":"13~23℃"},{"day":"周六","condition":"小雨","temp":"10~17℃","rain":"75%"}]}（约束：city城市、temp实时大字号气温、condition天气状况、可选range/aqi/wind/humidity/tips、forecast≤7天预报）。',
}
