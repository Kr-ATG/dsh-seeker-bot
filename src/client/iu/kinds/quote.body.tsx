/**
 * iu kind **quote** 的 React 体（client 专用 · 数值 + 趋势）。
 *
 * ## Body 契约
 *  · 只渲染正文：卡片头（标题 + 角标）由外壳 IuCard 统一渲染，这里不包最外层
 *    容器、不自绘 Head；
 *  · DOM 结构与 quote.ts 的 snapshot() 逐字对齐（class 名、层级、顺序全同），
 *    两边共用 quote.ts 里那一份 CSS —— 结构一旦分叉，截图就会「长得不一样」；
 *  · SVG 用 JSX 直接写（不走 dangerouslySetInnerHTML），几何全部来自 quote.ts 的
 *    sparklinePath / sparkAreaPath / SPARK_VIEWBOX：曲线坐标只允许有一份算法；
 *  · 渐变 id 由 sparkGradientId 生成（与 snapshot 同一个函数），同页多张卡不会
 *    互相串色。
 */

import { memo } from 'react'
import type { IuBodyProps } from './bodies.ts'
import type { IuQuoteSpec, IuQuoteState } from './quote.ts'
import {
  inferDirection,
  sparkAreaPath,
  sparkGradientId,
  sparklinePath,
  SPARK_HEIGHT,
  SPARK_VIEWBOX,
  SPARK_WIDTH,
} from './quote.ts'

export const QuoteBody = memo(function QuoteBody(
  { spec }: IuBodyProps<IuQuoteState, IuQuoteSpec>,
): JSX.Element {
  const dir = spec.direction ?? inferDirection(spec.change, spec.changePct)
  const series = spec.series ?? []
  const hasSeries = series.length > 0
  const hasChange = spec.change !== undefined && spec.change !== ''
  const hasPct = spec.changePct !== undefined && spec.changePct !== ''
  const gradId = hasSeries ? sparkGradientId(spec) : ''
  const lineD = hasSeries ? sparklinePath(series, SPARK_WIDTH, SPARK_HEIGHT) : ''
  const areaD = hasSeries ? sparkAreaPath(series, SPARK_WIDTH, SPARK_HEIGHT) : ''
  const metrics = spec.metrics ?? []
  const showName = spec.name !== spec.title
  const codeText = spec.code !== undefined && spec.code !== '' ? spec.code : ''

  return (
    <div className="dtt-iu__quote" data-dir={dir}>
      {/*
        标的行：名称 + 代码（可省）。
        **名称与卡头重复时不画**——parse 里 title 缺省回退成 name，最常见的写法
        是「只给 name」，卡头已经是这个名字，正文再写一遍就是同一个名字出现两行。
        名字省掉时把代码挪到价格行末尾，别让它跟着消失。
      */}
      {showName ? (
        <div className="dtt-iu__qhead">
          <span className="dtt-iu__qname">{spec.name}</span>
          {spec.code !== undefined && spec.code !== '' ? (
            <span className="dtt-iu__qcode">{spec.code}</span>
          ) : null}
        </div>
      ) : null}

      {/* 2. 主数字行：价格 + 单位 + 涨跌（方向色） */}
      <div className="dtt-iu__qprice-row">
        <span className="dtt-iu__qprice">{spec.price}</span>
        {spec.unit !== undefined && spec.unit !== '' ? (
          <span className="dtt-iu__qunit">{spec.unit}</span>
        ) : null}
        {hasChange || hasPct ? (
          <span className="dtt-iu__qdelta">
            {hasChange ? <span className="dtt-iu__qchg">{spec.change}</span> : null}
            {hasPct ? <span className="dtt-iu__qpct">{spec.changePct}</span> : null}
          </span>
        ) : null}
        {/* 名称被卡头吃掉时，代码作为价格行的尾注保留 */}
        {!showName && codeText !== '' ? (
          <span className="dtt-iu__qcode dtt-iu__qcode--inline">{codeText}</span>
        ) : null}
      </div>

      {/* 3. 迷你走势：方向色描边 + SVG 内部渐变填充 */}
      {hasSeries ? (
        <div className="dtt-iu__qchart">
          <svg
            className="dtt-iu__qspark"
            viewBox={SPARK_VIEWBOX}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop className="dtt-iu__qstop-top" offset="0%" />
                <stop className="dtt-iu__qstop-bottom" offset="100%" />
              </linearGradient>
            </defs>
            {areaD !== '' ? (
              <path className="dtt-iu__qarea" d={areaD} fill={'url(#' + gradId + ')'} />
            ) : null}
            <path className="dtt-iu__qline" d={lineD} />
          </svg>
        </div>
      ) : null}

      {/* 4. 指标格：横向等分，无灰底方框 */}
      {metrics.length > 0 ? (
        <div className="dtt-iu__qmetrics">
          {metrics.map((m, i) => (
            <div key={i} className="dtt-iu__qm-item">
              <span className="dtt-iu__qm-label">{m.label}</span>
              <span className="dtt-iu__qm-val">{m.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* 5. 备注 */}
      {spec.note !== undefined && spec.note !== '' ? (
        <div className="dtt-iu__qnote">{spec.note}</div>
      ) : null}
    </div>
  )
})
