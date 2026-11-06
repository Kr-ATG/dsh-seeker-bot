/**
 * iu kind compare 的 React 体（client 专用）。
 *
 * 选中列与「只看差异」开关都走 props.state / setState（外壳统一持久化），
 * DOM 与 compare.ts 的 snapshot() 逐字对齐：desc → cmp → toolbar → grid → col(head + specs)。
 */

import { memo } from 'react'
import type { IuBodyProps } from './bodies.ts'
import type { CompareState, IuCompareSpec } from './compare.ts'
import { compareInitial, compareMeta, comparePhotoUrl, compareSameRows, compareSelected } from './compare.ts'

export const CompareBody = memo(function CompareBody(
  { spec, state, setState }: IuBodyProps<CompareState, IuCompareSpec>,
): JSX.Element {
  const selected = compareSelected(state?.selected, spec.products.length)
  const diffOnly = state?.diffOnly === true
  const same = compareSameRows(spec)
  return (
    <>
      {spec.desc !== '' && <p className="dtt-iu__desc">{spec.desc}</p>}
      <div className="dtt-iu__cmp" data-diff={diffOnly ? '1' : '0'}>
        <div className="dtt-iu__cmp-toolbar">
          <span className="dtt-iu__cmp-hint">点列头聚焦产品</span>
          <button
            type="button"
            className="dtt-iu__cmp-diff"
            data-on={diffOnly ? '1' : '0'}
            aria-pressed={diffOnly}
            onClick={() => { setState({ diffOnly: !diffOnly }) }}
          >
            只看差异
          </button>
        </div>
        <div className="dtt-iu__cmp-grid">
          {spec.products.map((p, i) => {
            const active = i === selected
            const meta = compareMeta(p)
            return (
              <div key={i} className="dtt-iu__cmp-col" data-active={active ? '1' : undefined}>
                <button
                  type="button"
                  className="dtt-iu__cmp-head"
                  aria-pressed={active}
                  onClick={() => { setState({ selected: i }) }}
                >
                  <span className="dtt-iu__cmp-media">
                    <span className="dtt-iu__cmp-initial">{compareInitial(p.name)}</span>
                    {p.image !== undefined && (
                      <span className="dtt-iu__cmp-photo" style={{ backgroundImage: comparePhotoUrl(p.image) }} />
                    )}
                  </span>
                  <span className="dtt-iu__cmp-name">{p.name}</span>
                  {p.price !== undefined && <span className="dtt-iu__cmp-price">{p.price}</span>}
                  {meta !== '' && <span className="dtt-iu__cmp-meta">{meta}</span>}
                  {p.badge !== undefined && <span className="dtt-iu__cmp-badge">{p.badge}</span>}
                </button>
                <div className="dtt-iu__cmp-specs">
                  {spec.rows.map((r, ri) => (
                    <div key={ri} className="dtt-iu__cmp-row" data-same={same[ri] ? '1' : undefined}>
                      <span className="dtt-iu__cmp-label">{r}</span>
                      <span className="dtt-iu__cmp-val">{p.values[ri] ?? '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
})
