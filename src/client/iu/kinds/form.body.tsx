/**
 * iu kind **form** 的 React 体（client 专用）。
 *
 * ## Body 契约（务必遵守，见 bodies.ts 头注释）
 *  · 只渲染「Head 之后」的正文，不要自己画 Head；
 *  · 提交按钮由本 Body 自绘（文案 = spec.submitLabel）；
 *  · DOM 结构必须与同名 form.ts 里的 `snapshot()` 逐字对齐；
 *  · 本地状态一律走 props 的 `state` / `setState`，不要自己 useState；
 *  · 下拉框采用 DSH 官方风格自绘弹层（IuFormSelect），彻底替代原生 select 的系统方块白底。
 */

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { IuBodyProps } from './bodies.ts'
import {
  fillText, isFieldEmpty, safeTouched, safeValues,
  type FormState, type IuFormField, type IuFormSpec,
} from './form.ts'

/** 勾选框里的对勾 SVG。 */
function CheckMark(): JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="#fff"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.8 5.2 4 7.4 8.2 2.6" />
    </svg>
  )
}

/** 弹层最大高度（px）。 */
const MAX_POPUP_H = 220

/** DSH 官方质感自绘下拉框（同步坐标测量 + 防误杀关闭 + 主题自适应实心底色）。 */
function IuFormSelect({
  field,
  value,
  invalid,
  onChange,
  onBlur,
}: {
  readonly field: IuFormField
  readonly value: string
  readonly invalid?: boolean | undefined
  readonly onChange: (val: string) => void
  readonly onBlur: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null)

  const isPlaceholder = value === ''
  const display = !isPlaceholder ? value : (field.placeholder !== '' ? field.placeholder : '请选择')

  /** 同步根据触发器位置计算 fixed 坐标（统一使用 top，绝对不产生负向 bottom 偏移）。 */
  const measure = useCallback((): { left: number; top: number; width: number } | null => {
    if (triggerRef.current === null) return null
    const rect = triggerRef.current.getBoundingClientRect()
    const width = Math.max(160, Math.round(rect.width))
    const left = Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - width - 8))
    const below = window.innerHeight - rect.bottom - 4 - 8
    const openUp = below < 140 && rect.top > 160
    const top = openUp
      ? Math.max(8, Math.round(rect.top - 180 - 4))
      : Math.round(rect.bottom + 4)
    return { left, top, width }
  }, [])

  /** 点击触发器：同步求值坐标并展开，首帧即可见，绝无延迟空白。 */
  const toggle = (): void => {
    if (open) {
      setOpen(false)
      onBlur()
      return
    }
    const b = measure()
    if (b !== null) setBox(b)
    setOpen(true)
  }

  // 滚动与窗口缩放时实时重测，跟随卡片走
  useEffect(() => {
    if (!open) return undefined
    const onScroll = (): void => {
      const b = measure()
      if (b !== null) setBox(b)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, measure])

  // 点外部关闭：避开当前点击的同一个事件调用栈
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) === true) return
      if (popupRef.current?.contains(target) === true) return
      setOpen(false)
      onBlur()
    }
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, onBlur])

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      toggle()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      onBlur()
    }
  }

  return (
    <div className="dtt-iu__select-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="dtt-iu__select-btn"
        data-open={open ? '1' : '0'}
        data-empty={isPlaceholder ? '1' : '0'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={field.label}
        aria-invalid={invalid || undefined}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span className="dtt-iu__select-text">{display}</span>
        <span className="dtt-iu__select-arrow" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </span>
      </button>

      {open && box !== null && typeof document !== 'undefined' && createPortal(
        <div
          ref={popupRef}
          className="dtt-iu__select-dropdown"
          role="listbox"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            maxHeight: MAX_POPUP_H,
          }}
        >
          {field.options.map((opt, i) => {
            const isSelected = opt === value
            return (
              <div
                key={i}
                className="dtt-iu__select-item"
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected ? '1' : '0'}
                onClick={() => {
                  onChange(opt)
                  setOpen(false)
                  onBlur()
                }}
              >
                <span className="dtt-iu__select-item-label">{opt}</span>
                {isSelected && (
                  <span className="dtt-iu__select-item-check" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3.5 8.5l3 3 6-6" />
                    </svg>
                  </span>
                )}
              </div>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

/** required 字段为空时的轻量校验文案。 */
function errText(field: IuFormField): string {
  switch (field.type) {
    case 'select': return `请选择「${field.label}」`
    case 'checkbox': return `请勾选「${field.label}」`
    default: return `请填写「${field.label}」`
  }
}

export const FormBody = memo(function FormBody(
  { spec, state, setState, onFill }: IuBodyProps<FormState, IuFormSpec>,
): JSX.Element {
  const values = safeValues(state)
  const touched = safeTouched(state)

  const missing = useMemo(
    () => spec.fields.filter((f) => f.required && isFieldEmpty(f, values[f.id])),
    [spec.fields, values],
  )

  const submit = useCallback((): void => {
    if (missing.length > 0) {
      setState((prev) => {
        const t = safeTouched(prev)
        const next = [...t]
        for (const f of missing) if (!next.includes(f.id)) next.push(f.id)
        return next.length === t.length ? {} : { touched: next }
      })
      return
    }
    if (onFill === undefined) return
    onFill(fillText(spec, state))
  }, [missing, onFill, setState, spec, state])

  const patchValue = useCallback((id: string, v: string | boolean): void => {
    setState(prev => ({ values: { ...safeValues(prev), [id]: v } }))
  }, [setState])

  const touch = useCallback((id: string): void => {
    setState(prev => {
      const t = safeTouched(prev)
      return t.includes(id) ? {} : { touched: [...t, id] }
    })
  }, [setState])

  const patchValueAndTouch = useCallback((id: string, v: string | boolean): void => {
    setState(prev => {
      const t = safeTouched(prev)
      return {
        values: { ...safeValues(prev), [id]: v },
        touched: t.includes(id) ? t : [...t, id],
      }
    })
  }, [setState])

  return (
    <>
      {spec.desc !== '' && <p className="dtt-iu__desc">{spec.desc}</p>}
      <div className="dtt-iu__form">
        {spec.fields.map((f) => {
          const raw = values[f.id]
          const strVal = typeof raw === 'string' ? raw : ''
          const checked = raw === true
          const invalid = f.required && touched.includes(f.id) && isFieldEmpty(f, raw)
          return (
            <div
              className="dtt-iu__field"
              key={f.id}
              data-type={f.type}
              data-required={f.required ? '1' : '0'}
              data-invalid={invalid ? '1' : undefined}
            >
              <label className="dtt-iu__label">
                {f.label}
                {f.required && <span className="dtt-iu__req">*</span>}
              </label>

              {(f.type === 'text' || f.type === 'number') && (
                <input
                  className="dtt-iu__input"
                  type={f.type}
                  value={strVal}
                  placeholder={f.placeholder}
                  aria-label={f.label}
                  aria-invalid={invalid || undefined}
                  onChange={(e) => { patchValue(f.id, e.currentTarget.value) }}
                  onBlur={() => { touch(f.id) }}
                />
              )}

              {f.type === 'textarea' && (
                <textarea
                  className="dtt-iu__textarea"
                  value={strVal}
                  placeholder={f.placeholder}
                  aria-label={f.label}
                  aria-invalid={invalid || undefined}
                  rows={2}
                  onChange={(e) => { patchValue(f.id, e.currentTarget.value) }}
                  onBlur={() => { touch(f.id) }}
                />
              )}

              {f.type === 'select' && (
                <IuFormSelect
                  field={f}
                  value={strVal}
                  invalid={invalid}
                  onChange={(val) => { patchValueAndTouch(f.id, val) }}
                  onBlur={() => { touch(f.id) }}
                />
              )}

              {f.type === 'checkbox' && (
                <button
                  type="button"
                  className="dtt-iu__checkbox"
                  data-on={checked ? '1' : '0'}
                  aria-pressed={checked}
                  aria-label={f.label}
                  onClick={() => { patchValueAndTouch(f.id, !checked) }}
                >
                  <span className="dtt-iu__box" aria-hidden>
                    <CheckMark />
                  </span>
                  <span className="dtt-iu__checkbox-text">{checked ? '是' : '否'}</span>
                </button>
              )}

              {invalid && <div className="dtt-iu__form-err">{errText(f)}</div>}
            </div>
          )
        })}
      </div>
      {onFill !== undefined && (
        <div className="dtt-iu__form-submit">
          <button
            type="button"
            className="dtt-iu__form-submit-btn"
            onClick={submit}
          >
            {spec.submitLabel}
          </button>
        </div>
      )}
    </>
  )
})
