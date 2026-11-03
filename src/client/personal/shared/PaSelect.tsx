/**
 * Personal Agent — 自绘下拉（替换原生 select 的选项弹层）。
 *
 * ## 为什么必须自己画
 *
 * 原生 `<select>` 展开后的 option 列表是**浏览器自己渲染的原生控件**，不在文档流里，
 * CSS 完全碰不到：`appearance: none`、`option { background }`、`::-ms-expand` 在
 * Chromium 里全部无效。结果就是白底 + 系统蓝高亮 + 方角，跟这套玻璃面板完全不搭。
 * 唯一解法是自己画一个。
 *
 * ## 定位方案：portal 到 .pa-root + position: fixed
 *
 * 两个坑必须同时绕开：
 *  1. 通话弹层的 `.pa-call` 是 `overflow-y: auto`，绝对定位的弹层会被直接裁掉一半；
 *  2. 弹层还要能盖住 `.pa-call-overlay`（z-index 70）等弹窗。
 *
 * 所以弹层**不放在触发器旁边**，而是 portal 到最近的 `.pa-root`，并用 `position: fixed`
 * + `getBoundingClientRect()` 算坐标：
 *  · fixed 的 containing block 是视口，祖先的 `overflow` 裁不到它；
 *  · portal 到 `.pa-root` 而不是 `document.body`，是为了**继承 --pa-* 主题变量**
 *    （body 拿不到 .pa-root 上定义的那套色板，弹层会变成无色块）；
 *  · 向下空间不足时改为贴触发器上沿（用 `bottom` 定位，不必先知道弹层实际高度）。
 *
 * 滚动 / 窗口尺寸变化时重新测量（capture 阶段监听，能收到任意滚动容器的滚动）。
 *
 * ## 交互
 *
 * 焦点**始终留在触发器**上（标准 combobox 模式），用 `aria-activedescendant` 指向
 * 当前高亮项；↑↓ 移动、Enter 选中、Esc 关闭、Tab 关闭。关闭走 `pointerdown`
 * 而不是 `click`：click 会和触发器自己的 onClick 抢时序（先关再开，看起来像没反应）。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevronDown } from '../icons.tsx'

/** 一个选项。`hint` 显示在右侧小字（音色的「适用场景」用它）。 */
export interface PaSelectOption {
  value: string
  label: string
  hint?: string
}

export interface PaSelectProps {
  value: string
  options: readonly PaSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** value 为空且没有对应选项时显示的文案。 */
  placeholder?: string
  ariaLabel?: string
  /** 加到根元素上的类名，用来沿用调用方的排版（宽度 / 高度档位）。 */
  className?: string
}

/** 弹层与触发器之间的间距（px）。 */
const GAP = 4
/** 弹层最大高度（px）；超过就内部滚动。 */
const MAX_POPUP_HEIGHT = 260
/** 判断「该向上翻」时，向下空间低于这个值就算不够。 */
const MIN_DOWNWARD = 160

interface PopupBox {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

export function PaSelect(props: PaSelectProps): JSX.Element {
  const { value, options, onChange, disabled = false, placeholder, ariaLabel, className } = props
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const baseId = useId()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [box, setBox] = useState<PopupBox | null>(null)
  /** 弹层挂载点：最近的 .pa-root（继承主题变量），拿不到再退 body。 */
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  )
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined
  const display = selected?.label ?? (placeholder !== undefined && placeholder !== '' ? placeholder : '请选择')

  useEffect(() => {
    if (typeof document === 'undefined') return
    const trigger = triggerRef.current
    const root = trigger?.closest('.pa-root')
    setPortalTarget(root instanceof HTMLElement ? root : document.body)
  }, [])

  /** 按触发器的实时位置算弹层坐标（fixed 坐标系）。 */
  const measure = useCallback((): void => {
    const trigger = triggerRef.current
    if (trigger === null) return
    const rect = trigger.getBoundingClientRect()
    /*
     * 宽度：至少 200px。紧凑档触发器只有 ~150px 宽，弹层跟着它做会窄到把 hint 截掉；
     * 但也不能超出视口，所以再夹一次（向右放不下时整体左移）。
     */
    const width = Math.min(Math.max(rect.width, 200), window.innerWidth - 16)
    const left = Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - width - 8))
    // 留 8px 贴边余量，弹层不顶到视口边缘
    const below = window.innerHeight - rect.bottom - GAP - 8
    const above = rect.top - GAP - 8
    const openUp = below < Math.min(MAX_POPUP_HEIGHT, MIN_DOWNWARD) && above > below
    const maxHeight = Math.max(96, Math.min(MAX_POPUP_HEIGHT, openUp ? above : below))
    setBox({
      left,
      width: Math.round(width),
      // 向上翻时用 bottom 定位：弹层高度自适应，不必先量出真实高度
      ...(openUp
        ? { bottom: Math.round(window.innerHeight - rect.top + GAP) }
        : { top: Math.round(rect.bottom + GAP) }),
      maxHeight: Math.round(maxHeight),
    })
  }, [])

  /* 打开后立刻测一次（用 layout effect：避免先出现在错误位置再跳过去）。 */
  useLayoutEffect(() => {
    if (!open) return
    measure()
  }, [open, measure])

  /* 滚动 / 改窗口尺寸时跟着走；capture 才能收到 .pa-call 这类内部滚动容器的滚动。 */
  useEffect(() => {
    if (!open) return undefined
    const update = (): void => measure()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, measure])

  /* 点外部关闭：pointerdown 比 click 早，不会和触发器自己的 onClick 抢时序。 */
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) === true) return
      if (popupRef.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  const openMenu = useCallback((): void => {
    if (disabled) return
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }, [disabled, selectedIndex])

  const moveActive = useCallback((delta: number): void => {
    if (options.length === 0) return
    setActiveIndex((prev) => {
      const base = prev < 0 ? (selectedIndex >= 0 ? selectedIndex : 0) : prev
      return (base + delta + options.length) % options.length
    })
  }, [options.length, selectedIndex])

  const choose = useCallback((index: number): void => {
    setOpen(false)
    const option = options[index]
    if (option === undefined) return
    // 选同一项不回调：避免调用方把「没变化」当成一次保存（音色会 toast 提示）
    if (option.value !== value) onChange(option.value)
  }, [onChange, options, value])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openMenu()
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveActive(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        moveActive(-1)
        return
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        return
      case 'End':
        event.preventDefault()
        setActiveIndex(options.length - 1)
        return
      case 'Enter':
        event.preventDefault()
        choose(activeIndex)
        return
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        return
      case 'Tab':
        // Tab 离开时收起，不拦默认行为（焦点该照常走）
        setOpen(false)
        return
      default:
        return
    }
  }

  const optionId = (index: number): string => `${baseId}-opt-${index}`
  const activeOptionId = open && activeIndex >= 0 && activeIndex < options.length ? optionId(activeIndex) : undefined

  const popup = open && box !== null && portalTarget !== null
    ? createPortal(
      <div
        ref={popupRef}
        className="pa-select__popup"
        role="listbox"
        aria-label={ariaLabel}
        style={{
          left: box.left,
          width: box.width,
          maxHeight: box.maxHeight,
          ...(box.top !== undefined ? { top: box.top } : {}),
          ...(box.bottom !== undefined ? { bottom: box.bottom } : {}),
        }}
      >
        {options.map((option, index) => {
          const isSelected = option.value === value
          const isActive = index === activeIndex
          return (
            <div
              key={`${index}-${option.value}`}
              id={optionId(index)}
              className="pa-select__option"
              role="option"
              aria-selected={isSelected}
              data-active={isActive ? 'true' : 'false'}
              data-selected={isSelected ? 'true' : 'false'}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className="pa-select__option-main">
                <span className="pa-select__option-label">{option.label}</span>
                {option.hint !== undefined && option.hint !== ''
                  ? <span className="pa-select__option-hint">{option.hint}</span>
                  : null}
              </span>
              <span className="pa-select__option-check">{isSelected ? <IconCheck size={13} /> : null}</span>
            </div>
          )
        })}
      </div>,
      portalTarget,
    )
    : null

  return (
    <div className={className === undefined ? 'pa-select' : `pa-select ${className}`}>
      <button
        ref={triggerRef}
        className="pa-select__trigger"
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-activedescendant={activeOptionId}
        disabled={disabled}
        data-open={open ? 'true' : 'false'}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="pa-select__value" data-empty={selected === undefined ? 'true' : 'false'}>{display}</span>
        <span className="pa-select__chevron"><IconChevronDown size={13} /></span>
      </button>
      {popup}
    </div>
  )
}
