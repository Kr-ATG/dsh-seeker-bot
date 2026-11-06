/**
 * Personal Agent — 音量滑条（通话弹层与会话头自动播报浮层共用）。
 *
 * ## 物理阻尼手感（HarmonyOS 引力动效体系）
 *  · 滚轮（Wheel）：支持鼠标滚轮滚动调节，带有物理质量惯性与临界阻尼减速（damping fraction 0.88），
 *    连滚平滑加速，停止后自然阻尼收敛制动，彻底消除机械跳变；
 *  · 点击（Click）：点击滑道任意位置时，滑块以弹簧阻尼曲线平滑滑入，非瞬移跳变；
 *  · 拖拽（Drag）与抛滑（Fling）：拖动顺滑跟手，松手时若带手势速度则继承速度抛滑，
 *    在弹簧阻尼下柔和制动；
 *  · 边界阻尼（Boundary Resistance）：到头（0% / 100%）继续推滚产生微弹性阻抗后自动回正；
 *  · 触压反馈（Press Feedback）：按住时 thumb 阻尼放大至 1.24 并扩散立体微光阴影，松手平滑回弹。
 *
 * ## 为什么自绘轨道
 * 用户要求「拖动条要有明显的粗细变化」：**已选段（当前音量）粗、未选段细**，
 * 用粗细而不是颜色表达音量位置——此前已按用户要求把填充色去掉，现在把「哪一段
 * 是亮的」这层信息交给粗细承担，两段都保持单色。
 *
 * 原生 `input[type=range]` 的 track 伪元素只能画一条等高的线，画不出两段不同
 * 粗细；所以视觉层拆成两个节点（粗填充段 / 细剩余段）画在 range 下面，
 * range 本身仍是真的 range——键盘步进、触摸拖动、无障碍语义一项不少。
 *
 * ## 几何对齐（改样式时必须保留）
 * 圆点直径 14px → 圆点中心的可移动区间是「控件宽度 - 14px」，即左右各内缩 7px。
 * 自绘轨道用同样的 7px 内缩，百分比才与 range 的值一一对应；改了圆点尺寸就要
 * 同步改 base.css 里 `.pa-vs__track` 的左右内缩与 `.pa-vs__input` 的 thumb 尺寸。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

export interface VolumeSliderProps {
  /** 0–100 的整数百分比（组件内部再钳一次，防止调用方传越界值）。 */
  value: number
  /** 拖动 / 键盘调节后的新百分比（0–100）。 */
  onChange: (value: number) => void
  /** 读屏用的控件名（如「通话音量」「朗读音量」）。 */
  ariaLabel: string
  /** 读屏读到的当前值描述（如「静音」「50%」）。 */
  valueText: string
}

/** 弹簧物理参数：对齐 HarmonyOS 官方引力动效 responsiveSpringMotion。 */
const SPRING_RESPONSE = 0.22 // 响应周期 220ms
const SPRING_DAMPING = 0.88 // 阻尼比 0.88（极微弱超调，顺滑减速平稳停住）
const OMEGA = (2 * Math.PI) / SPRING_RESPONSE
const STIFFNESS = OMEGA * OMEGA
const DAMPING = 2 * SPRING_DAMPING * OMEGA

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export function VolumeSlider({ value, onChange, ariaLabel, valueText }: VolumeSliderProps): JSX.Element {
  const initialPercent = clamp(Math.round(value), 0, 100)
  const [percent, setPercent] = useState(initialPercent)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 物理动力学状态引用
  const currentValRef = useRef(initialPercent)
  const targetValRef = useRef(initialPercent)
  const velocityRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number | null>(null)
  const lastEmittedRef = useRef(initialPercent)

  // 拖拽与手势采样
  const isDraggingRef = useRef(false)
  const dragSamplesRef = useRef<{ x: number; time: number }[]>([])

  // 停止弹簧动画
  const stopSpring = useCallback((): void => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    lastTimeRef.current = null
  }, [])

  // 触发弹簧动画循环
  const startSpring = useCallback((): void => {
    if (rafIdRef.current !== null) return

    // 检查减少动态效果偏好
    let reducedMotion = false
    try {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      reducedMotion = false
    }

    if (reducedMotion) {
      currentValRef.current = targetValRef.current
      velocityRef.current = 0
      const rounded = clamp(Math.round(targetValRef.current), 0, 100)
      setPercent(rounded)
      if (rootRef.current) {
        rootRef.current.style.setProperty('--pa-vs-fill', `${rounded}%`)
      }
      if (inputRef.current) {
        inputRef.current.value = String(rounded)
      }
      if (rounded !== lastEmittedRef.current) {
        lastEmittedRef.current = rounded
        onChange(rounded)
      }
      return
    }

    lastTimeRef.current = performance.now()

    const step = (now: number): void => {
      if (lastTimeRef.current === null) lastTimeRef.current = now
      const dt = Math.min((now - lastTimeRef.current) / 1000, 0.032)
      lastTimeRef.current = now

      let cur = currentValRef.current
      const target = targetValRef.current
      let vel = velocityRef.current

      // 物理弹簧计算
      const displacement = cur - target
      const springForce = -STIFFNESS * displacement - DAMPING * vel
      vel += springForce * dt
      cur += vel * dt

      // 边界阻尼（Boundary Resistance）：越界时施加弹性制动回弹
      if (cur < 0) {
        vel *= 0.5
        cur += (0 - cur) * 0.3
      } else if (cur > 100) {
        vel *= 0.5
        cur += (100 - cur) * 0.3
      }

      currentValRef.current = cur
      velocityRef.current = vel

      // 绘制当前帧渲染状态
      const displayClamped = clamp(cur, 0, 100)
      if (rootRef.current) {
        rootRef.current.style.setProperty('--pa-vs-fill', `${displayClamped.toFixed(2)}%`)
      }
      const rounded = clamp(Math.round(displayClamped), 0, 100)
      if (inputRef.current && !isDraggingRef.current) {
        inputRef.current.value = String(rounded)
      }

      // 触发外部回调
      if (rounded !== lastEmittedRef.current) {
        lastEmittedRef.current = rounded
        onChange(rounded)
      }

      // 收敛判定：位移与速度均极微小时平稳收尾
      const settled = Math.abs(cur - target) < 0.05 && Math.abs(vel) < 0.1
      if (settled) {
        currentValRef.current = target
        velocityRef.current = 0
        setPercent(Math.round(target))
        if (rootRef.current) {
          rootRef.current.style.setProperty('--pa-vs-fill', `${target}%`)
        }
        if (inputRef.current) {
          inputRef.current.value = String(Math.round(target))
        }
        rafIdRef.current = null
        lastTimeRef.current = null
      } else {
        rafIdRef.current = requestAnimationFrame(step)
      }
    }

    rafIdRef.current = requestAnimationFrame(step)
  }, [onChange])

  // 外部传入 value 更新时的同步
  useEffect(() => {
    const nextVal = clamp(Math.round(value), 0, 100)
    if (!isDraggingRef.current && Math.abs(nextVal - targetValRef.current) > 0.5) {
      targetValRef.current = nextVal
      startSpring()
    }
  }, [value, startSpring])

  // 组件卸载时清理定时器与动画帧
  useEffect(() => () => {
    stopSpring()
  }, [stopSpring])

  // 原生 wheel 滚轮事件监听：赋予平滑阻尼手感
  useEffect(() => {
    const rootEl = rootRef.current
    if (!rootEl) return

    const handleWheel = (event: WheelEvent): void => {
      // 阻止外部页面滚动
      event.preventDefault()
      event.stopPropagation()

      // 滚轮步长动态阻尼映射
      const deltaY = event.deltaY
      const stepMagnitude = Math.max(2, Math.min(6, Math.abs(deltaY) / 18))
      const direction = deltaY < 0 ? 1 : -1 // 向上滚增加音量，向下滚降低音量
      const delta = direction * stepMagnitude

      // 注入速度冲量以增强机械动量阻尼感
      velocityRef.current += delta * 12
      targetValRef.current = clamp(targetValRef.current + delta, 0, 100)

      startSpring()
    }

    rootEl.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      rootEl.removeEventListener('wheel', handleWheel)
    }
  }, [startSpring])

  // 原生 range 的 change 事件
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const next = Number(event.target.value)
    targetValRef.current = clamp(next, 0, 100)

    if (isDraggingRef.current) {
      // 拖拽过程中直接贴手更新
      currentValRef.current = targetValRef.current
      velocityRef.current = 0
      setPercent(Math.round(targetValRef.current))
      if (rootRef.current) {
        rootRef.current.style.setProperty('--pa-vs-fill', `${targetValRef.current}%`)
      }
      if (targetValRef.current !== lastEmittedRef.current) {
        lastEmittedRef.current = targetValRef.current
        onChange(targetValRef.current)
      }
    } else {
      // 非拖拽（如键盘步进、点击跳转）：启动弹簧阻尼平滑滑入
      startSpring()
    }
  }, [onChange, startSpring])

  // 指针按下：开始采样跟踪速度
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLInputElement>): void => {
    isDraggingRef.current = true
    stopSpring()
    dragSamplesRef.current = [{ x: event.clientX, time: performance.now() }]
  }, [stopSpring])

  // 指针移动：记录瞬时速度滑动窗口
  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLInputElement>): void => {
    if (!isDraggingRef.current) return
    const now = performance.now()
    dragSamplesRef.current.push({ x: event.clientX, time: now })
    if (dragSamplesRef.current.length > 5) {
      dragSamplesRef.current.shift()
    }
  }, [])

  // 指针释放：计算手势末速度并实现抛滑速度继承（Velocity Handoff）
  const handlePointerUp = useCallback((): void => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false

    const samples = dragSamplesRef.current
    if (samples.length >= 2) {
      const first = samples[0]
      const last = samples[samples.length - 1]
      const dt = (last.time - first.time) / 1000
      if (dt > 0.01 && dt < 0.25) {
        const width = rootRef.current?.clientWidth || 120
        const dxPercent = ((last.x - first.x) / width) * 100
        const gestureVelocity = dxPercent / dt // 百分比/秒
        // 若具有显著滑动末速度，注入物理阻尼系统实现抛滑柔和制动
        if (Math.abs(gestureVelocity) > 25) {
          velocityRef.current = gestureVelocity * 0.35
          targetValRef.current = clamp(targetValRef.current + gestureVelocity * 0.12, 0, 100)
        }
      }
    }

    startSpring()
  }, [startSpring])

  return (
    <div
      className="pa-vs"
      ref={rootRef}
      style={{ '--pa-vs-fill': `${percent}%` } as CSSProperties}
    >
      {/* 视觉层：粗的已选段 + 细的未选段。纯装饰，交互全交给下面的 range。 */}
      <div className="pa-vs__track" aria-hidden="true">
        <span className="pa-vs__fill" />
        <span className="pa-vs__rest" />
      </div>
      <input
        ref={inputRef}
        className="pa-vs__input"
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label={ariaLabel}
        aria-valuetext={valueText}
        onChange={handleChange}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  )
}
