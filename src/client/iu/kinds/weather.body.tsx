/**
 * iu kind **weather** 的 React 体（client 专用 · 高级通透设计）。
 *
 * ## Body 契约
 *  · DOM 结构与 weather.ts 的 `snapshot()` 严格对齐；
 *  · 纯净无多余灰框，超大纤细温度展示。
 */

import { memo } from 'react'
import type { IuBodyProps } from './bodies.ts'
import type { IuWeatherSpec, IuWeatherState } from './weather.ts'
import { classifyWeather, parseTempParts, renderWeatherSvg } from './weather.ts'

export const WeatherBody = memo(function WeatherBody(
  { spec, state, setState }: IuBodyProps<IuWeatherState, IuWeatherSpec>,
): JSX.Element {
  const wType = classifyWeather(spec.condition)
  const activeDay = state.activeDay ?? null
  const tempParts = parseTempParts(spec.temp)

  const metrics: { label: string; value: string }[] = []
  if (spec.wind) metrics.push({ label: '风向风力', value: spec.wind })
  if (spec.humidity) metrics.push({ label: '相对湿度', value: spec.humidity })
  if (spec.uv) metrics.push({ label: '紫外线', value: spec.uv })
  if (spec.aqi) metrics.push({ label: '空气质量', value: spec.aqi })

  return (
    <div className="dtt-iu__weather" data-cond={wType}>
      {/* 1. 主视觉 Hero */}
      <div className="dtt-iu__whero">
        <div className="dtt-iu__wmain">
          <div className="dtt-iu__wcity-line">
            <span className="dtt-iu__wcity">{spec.city}</span>
            <span className="dtt-iu__wdot">·</span>
            <span className="dtt-iu__wcond">{spec.condition}</span>
            {spec.aqi ? (
              <span className="dtt-iu__waqi-pill">
                <span className="dtt-iu__waqi-dot">●</span> AQI {spec.aqi}
              </span>
            ) : null}
          </div>
          <div className="dtt-iu__wtemp-line">
            <span className="dtt-iu__wbig-temp">{tempParts.num}</span>
            <span className="dtt-iu__wdeg">{tempParts.unit}</span>
          </div>
          {spec.range ? <div className="dtt-iu__wsub">{spec.range}</div> : null}
        </div>
        <div
          className="dtt-iu__wicon-hero"
          dangerouslySetInnerHTML={{ __html: renderWeatherSvg(wType, 56) }}
        />
      </div>

      {/* 2. 四列指标栏（通透无灰框） */}
      {metrics.length > 0 ? (
        <div className="dtt-iu__wmetrics">
          {metrics.map((m, i) => (
            <div key={i} className="dtt-iu__wm-item">
              <span className="dtt-iu__wm-label">{m.label}</span>
              <span className="dtt-iu__wm-val">{m.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* 3. 出行建议 */}
      {spec.tips ? (
        <div className="dtt-iu__wtips">
          <span className="dtt-iu__wtips-icon" aria-hidden="true">💡</span>
          <span className="dtt-iu__wtips-text">{spec.tips}</span>
        </div>
      ) : null}

      {/* 4. 多日预报横列（去灰框，微光高亮） */}
      {Array.isArray(spec.forecast) && spec.forecast.length > 0 ? (
        <div className="dtt-iu__wforecast">
          {spec.forecast.map((f, i) => {
            const itemType = classifyWeather(f.condition)
            const isActive = activeDay === i
            return (
              <div
                key={i}
                className="dtt-iu__wf-col"
                data-index={i}
                data-active={isActive ? 'true' : 'false'}
                onClick={() => { setState({ activeDay: isActive ? null : i }) }}
              >
                <span className="dtt-iu__wf-day">{f.day}</span>
                <div
                  className="dtt-iu__wf-icon"
                  dangerouslySetInnerHTML={{ __html: renderWeatherSvg(itemType, 22) }}
                />
                <span className="dtt-iu__wf-cond">{f.condition}</span>
                <span className="dtt-iu__wf-temp">{f.temp}</span>
                {f.rain ? <span className="dtt-iu__wf-rain">{f.rain}</span> : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
})
