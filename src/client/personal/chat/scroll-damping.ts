/**
 * dsh-seeker-bot — Bot 消息流滚动阻尼（2026-11-07）。
 *
 * 用户报障：「BOT 消息页面上滑下滑没有阻尼感」。
 *
 * 原生滚动在桌面端的两个问题：
 *   · 鼠标滚轮一格是 **离散跳变**（Windows / Chromium 一次 100px，瞬间落位），
 *     没有中间帧，看起来就是「一卡一卡」；
 *   · 滚到顶 / 底是**硬截断**，继续滚什么都不会发生，手指/滚轮还在动但画面死了。
 *
 * 这里给滚动容器装一套轻量物理层（不替换原生滚动，只接管 wheel 的输入相位）：
 *
 *   1. 跟手：wheel 事件到达即更新目标位置，下一帧开始移动（滚轮不是拖拽，
 *      一帧内的响应已经等价于零延迟）；
 *   2. 平滑阻尼：当前位移用指数衰减追目标（时间常数 {@link SCROLL_TAU}），
 *      连续滚轮会累积目标、速度不断层，停手后自然收口，不「急刹车」；
 *   3. 端点阻尼：到顶 / 底后继续滚，不再硬截断。越界量先按 {@link rubberBandOffset}
 *      压缩成 0~{@link RUBBER_BAND_MAX}px 的内容位移（显控比 0.32 + 0.72 次幂，
 *      越拉越沉；方向由 {@link pullOffsetOf} 取反，顶部下让、底部上让），停手
 *      {@link SCROLL_IDLE_MS} 后用 response 0.35s / 阻尼比 0.8 的弹簧回弹归零；
 *   4. 不撒谎：滚动条、键盘、scrollIntoView、程序贴底这些「外部滚动」一律识别并
 *      立即让位（stop + 同步），不和浏览器原生滚动抢控制权。
 *
 * 只接管 wheel：键盘翻页 / 滚动条拖拽 / 触摸屏惯性走浏览器原生，行为不变。
 * 系统开启「减少动态效果」时整体退化为原生滚动。
 *
 * 视觉位移通过容器的 CSS 变量 {@link SCROLL_PULL_VAR} 交给 CSS：
 * `.pa-chat__scroll-inner { transform: translate3d(0, var(--pa-scroll-pull, 0px), 0) }`。
 * 用 transform 而不是 padding：不触发布局重算，且不会改变 scrollHeight。
 *
 * @module
 */

/** 停手后多久开始越界回弹（ms）。 */
export const SCROLL_IDLE_MS = 110

/** 主滚动跟随的时间常数（秒）。越小越跟手，越大越「沉」。 */
export const SCROLL_TAU = 0.1

/**
 * 连续高频输入（触控板 / 高精度滚轮）使用的时间常数（秒）。
 *
 * 离散滚轮一格 100px，可以放心用 0.1s 的阻尼滑过去；触控板一次双指滑动会连续
 * 派发几十个小 delta，若同样用 0.1s，内容会稳定落后手指约「速度 × τ」（1000px/s
 * 时就是 100px），看起来像在冰面上打滑。连续输入把 τ 收到 0.05，既有轻微阻尼，
 * 又保持跟手。
 */
export const SCROLL_TAU_CONTINUOUS = 0.05

/** 越界位移的视觉上限（px）。 */
export const RUBBER_BAND_MAX = 22

/** 越界位移衰减系数（显控比，0.2~0.35 是官方推荐的橡皮筋区间）。 */
export const RUBBER_BAND_FACTOR = 0.32

/** 越界位移的幂次（小于 1）：越往后每 px 的收益越小，越拉越沉。 */
export const RUBBER_BAND_POWER = 0.72

/** 回弹弹簧的响应周期（秒）。 */
export const REBOUND_RESPONSE = 0.35

/** 回弹弹簧的阻尼比（0.8 = 轻微超调，回弹有生命感但不晃）。 */
export const REBOUND_DAMPING = 0.8

/** 容器上承载越界位移的 CSS 变量名。 */
export const SCROLL_PULL_VAR = '--pa-scroll-pull'

/** 认定「这一下是外部滚动」的像素阈值（滚动条 / 键盘 / 程序跳转）。 */
const EXTERNAL_SCROLL_EPSILON = 2

/** 行高换算：deltaMode=1（行）时一行的像素估值。 */
const LINE_HEIGHT_PX = 16

/**
 * 越界位移映射：把「手指/滚轮已经越过的原始距离」压成实际视觉位移。
 *
 * 0 → 0，单调递增、上凸（越拉越沉），最后夹在 {@link RUBBER_BAND_MAX}。
 * 正负号保留原方向；真正用于视觉位移时再经 {@link pullOffsetOf} 取反。
 *
 * 例：raw=100 → 100^0.72 × 0.32 ≈ 8.8px；raw=-300 → ≈ -19.6px。
 */
export function rubberBandOffset(raw: number): number {
  if (!Number.isFinite(raw) || raw === 0) return 0
  const sign = raw < 0 ? -1 : 1
  const magnitude = Math.min(RUBBER_BAND_MAX, Math.pow(Math.abs(raw), RUBBER_BAND_POWER) * RUBBER_BAND_FACTOR)
  return sign * magnitude
}

/**
 * wheel 的 deltaY 归一化到像素。
 *
 * Chromium 在 Windows 上：鼠标滚轮 deltaMode=0（像素，通常 ±100）；
 * Firefox / 旧环境可能给 deltaMode=1（行）或 2（页）。
 */
export function normalizeWheelDelta(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (!Number.isFinite(deltaY)) return 0
  if (deltaMode === 1) return deltaY * LINE_HEIGHT_PX
  if (deltaMode === 2) return deltaY * Math.max(1, pageHeight)
  return deltaY
}

/**
 * 越界位移的**视觉**方向。
 *
 * pullRaw 记录的是「虚拟滚动位置越过边界的量」：顶部越界为负、底部越界为正。
 * 但视觉上要反过来——顶部继续上拉时内容应向下让出空白（正 translateY），
 * 底部继续下拉时内容应向上让出空白（负 translateY）。
 */
export function pullOffsetOf(raw: number): number {
  return -rubberBandOffset(raw)
}

/** 把 EventTarget 收窄成 HTMLElement（测试桩也能过：只要求有 parentElement 字段）。 */
function elementOf(target: EventTarget | null): HTMLElement | null {
  if (target === null || typeof target !== 'object') return null
  const node = target as HTMLElement
  if (typeof node.parentElement === 'undefined') return null
  return node
}

/**
 * 找 event.target 与滚动根之间「还能继续滚」的内层滚动区。
 *
 * 消息里的代码块 / 工具输出都是独立 overflow:auto 容器：滚轮到它们身上时
 * 必须让原生滚动先吃掉，否则会把它们的滚动抢到消息流上（用户想横/纵向看
 * 一段长代码，结果整个对话在动）。到达内层边界后自然冒泡回消息流。
 */
export function findInnerScrollable(target: EventTarget | null, root: HTMLElement, deltaY: number): HTMLElement | null {
  let node = elementOf(target)
  while (node !== null && node !== root) {
    const parent = elementOf(node.parentElement)
    /*
     * 先看几何再看 computed style：绝大多数祖先（span / p / 气泡）根本没有
     * 纵向溢出，scrollHeight 判定就能排除；反过来先 getComputedStyle 会在
     * 每一次 wheel 里对整条祖先链做样式重算——消息 DOM 很深时就是滚动卡顿
     * 的元凶。
     */
    if (typeof node.scrollHeight === 'number'
      && typeof node.clientHeight === 'number'
      && node.scrollHeight > node.clientHeight + 1) {
      let overflowY = ''
      try {
        overflowY = getComputedStyle(node).overflowY
      } catch {
        overflowY = ''
      }
      const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
      if (scrollable) {
        const max = node.scrollHeight - node.clientHeight
        const canConsume = deltaY > 0 ? node.scrollTop < max - 1 : node.scrollTop > 1
        if (canConsume) return node
      }
    }
    node = parent
  }
  return null
}

/** 安装选项。 */
export interface ScrollDampingOptions {
  /** false 时完全不接管（默认 true）。 */
  enabled?: boolean
}

/** 句柄：用于卸载与外部同步。 */
export interface ScrollDampingHandle {
  /** 卸载：摘监听、停动画、还原容器内联样式。幂等。 */
  destroy(): void
  /**
   * 立即让位：放弃进行中的动画，把内部状态同步成 DOM 当前 scrollTop。
   * 外部代码（或测试）在程序化滚动前调用可避免一帧的抢写。
   */
  sync(): void
}

/** 空句柄（不满足接管条件 / 已降级时返回）。 */
const NOOP_HANDLE: ScrollDampingHandle = {
  destroy: () => {},
  sync: () => {},
}

/**
 * 在滚动容器上安装阻尼物理层。
 *
 * 只接管 wheel；滚动条拖拽、键盘、触摸屏不受影响。返回的句柄务必在组件
 * 卸载时 destroy()，否则容器被替换后会留下监听与 rAF。
 */
export function installScrollDamping(scroller: HTMLElement, options: ScrollDampingOptions = {}): ScrollDampingHandle {
  if (options.enabled === false) return NOOP_HANDLE
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return NOOP_HANDLE

  /* 系统要求减少动态效果：滚动本身就是动效，直接退回原生。 */
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return NOOP_HANDLE
  } catch {
    /* matchMedia 不可用时按不减弱处理 */
  }

  /*
   * CSS 的 scroll-behavior 平时保持原样（默认是 smooth，供「回到最新 / 跳转消息 /
   * 消息贴底」这些程序滚动使用）。只有物理层真正接管帧循环的这段时间才临时把
   * 内联样式改成 auto —— 否则我们每帧写 scrollTop 都会被浏览器再包一层补间，
   * 和阻尼引擎打架。动画收口后立即还原，程序滚动的手感不受影响。
   */
  const previousScrollBehavior = scroller.style.scrollBehavior
  let behaviorOverridden = false
  const beginAutoBehavior = (): void => {
    if (behaviorOverridden) return
    scroller.style.scrollBehavior = 'auto'
    behaviorOverridden = true
  }
  const endAutoBehavior = (): void => {
    if (!behaviorOverridden) return
    scroller.style.scrollBehavior = previousScrollBehavior
    behaviorOverridden = false
  }
  scroller.setAttribute('data-pa-scroll-damping', '')

  let destroyed = false
  let rafId = 0
  let lastTs = 0
  /** 当前渲染位置（scrollTop 的连续值）。 */
  let current = scroller.scrollTop
  /** 目标位置（已按边界裁剪）。 */
  let target = current
  /** 最近一帧写进 DOM 的 scrollTop，用来识别外部滚动。 */
  let lastWritten = current
  /** 滚动上限缓存（在安装 / resize 时刷新，wheel 与 rAF 里不读布局）。 */
  let maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  /** 视口高度缓存：wheel 的 deltaMode=page 换算要用，不能每事件读 clientHeight。 */
  let viewportHeight = scroller.clientHeight
  /** 越界原始位移（未压缩）。 */
  let pullRaw = 0
  /** 越界实际视觉位移（压缩后）。 */
  let pull = 0
  /** 回弹弹簧速度（px/s）。 */
  let pullVelocity = 0
  /** 是否处于松手回弹阶段。 */
  let rebounding = false
  let idleTimer = 0
  /** 当前帧使用的跟随时间常数（离散滚轮 / 连续输入两档）。 */
  let activeTau = SCROLL_TAU
  /** 上一次 wheel 的时间戳，用来区分「一格一格」与「连续滑动」。 */
  let lastWheelAt = 0
  /** 上一次强制测量 maxScroll 的时间（懒加载后内容高度会变，每 250ms 兜底刷新一次）。 */
  let lastMaxRefreshAt = 0

  const clearIdle = (): void => {
    if (idleTimer !== 0) {
      window.clearTimeout(idleTimer)
      idleTimer = 0
    }
  }

  const applyPull = (): void => {
    scroller.style.setProperty(SCROLL_PULL_VAR, pull.toFixed(3) + 'px')
    /*
     * 只有真的在越界时才有 transform 层：常驻 translate3d(0,0,0) 会把整条
     * 消息列表提成一个大合成层，长会话里 GPU 纹理巨大，反而拖慢滚动。
     */
    if (Math.abs(pull) > 0.05) scroller.setAttribute('data-pa-scroll-pulling', '')
    else scroller.removeAttribute('data-pa-scroll-pulling')
  }

  const refreshMax = (): void => {
    viewportHeight = scroller.clientHeight
    maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (target > maxScroll) target = maxScroll
    if (current > maxScroll) current = maxScroll
    if (pullRaw > 0 && target < maxScroll - 1) pullRaw = 0
    else if (pullRaw < 0 && target > 1) pullRaw = 0
    if (maxScroll <= 0) {
      pullRaw = 0
      pull = 0
      pullVelocity = 0
      rebounding = false
      applyPull()
    }
  }

  const stopRaf = (): void => {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  const settle = (): void => {
    stopRaf()
    endAutoBehavior()
    lastTs = 0
  }

  /** 一帧物理步进。 */
  const step = (ts: number): void => {
    rafId = 0
    if (destroyed) return
    const dt = lastTs === 0 ? 1 / 60 : Math.min(0.064, Math.max(0.001, (ts - lastTs) / 1000))
    lastTs = ts
    beginAutoBehavior()

    /* ---- 1. 主滚动：指数阻尼追随目标 ---- */
    const diff = target - current
    if (Math.abs(diff) > 0.25) {
      const alpha = 1 - Math.exp(-dt / activeTau)
      current += diff * alpha
      if (Math.abs(target - current) <= 0.25) current = target
      lastWritten = current
      scroller.scrollTop = current
    } else if (current !== target) {
      current = target
      lastWritten = current
      scroller.scrollTop = current
    }

    /* ---- 2. 越界位移：回弹弹簧 / 追随压缩值 ---- */
    if (rebounding) {
      /*
       * 定步长子步积分：rAF 的 dt 在掉帧时可能到 60ms，直接积弹簧会炸；
       * 4ms 子步在 60/120Hz 下都稳定，且回弹只有 ~0.35s，开销可忽略。
       */
      const stiffness = Math.pow((2 * Math.PI) / REBOUND_RESPONSE, 2)
      const damping = 2 * REBOUND_DAMPING * Math.sqrt(stiffness)
      let remaining = dt
      while (remaining > 0) {
        const h = Math.min(0.004, remaining)
        const acceleration = -stiffness * pull - damping * pullVelocity
        pullVelocity += acceleration * h
        pull += pullVelocity * h
        remaining -= h
      }
      if (Math.abs(pull) < 0.08 && Math.abs(pullVelocity) < 0.8) {
        pull = 0
        pullVelocity = 0
        rebounding = false
      }
      applyPull()
    } else {
      const pullTarget = pullOffsetOf(pullRaw)
      if (Math.abs(pullTarget - pull) > 0.05) {
        /* 压缩值本身也做一点点平滑：手指快速拉到头时不会「啪」地变成极限。 */
        const alpha = 1 - Math.exp(-dt / 0.07)
        pull += (pullTarget - pull) * alpha
        applyPull()
      } else if (pull !== pullTarget) {
        pull = pullTarget
        applyPull()
      }
    }

    /* ---- 3. 收口判定：主滚动贴住目标、越界位移也追平（回弹中则等它归零） ---- */
    const mainSettled = Math.abs(target - current) <= 0.25
    const pullSettled = !rebounding && Math.abs(pullOffsetOf(pullRaw) - pull) <= 0.05
    if (mainSettled && pullSettled) {
      settle()
      return
    }
    schedule()
  }

  const schedule = (): void => {
    if (rafId !== 0 || destroyed) return
    rafId = requestAnimationFrame(step)
  }

  /** 松手一段时间后，把越界位移弹回去。 */
  const armIdleRebound = (): void => {
    clearIdle()
    idleTimer = window.setTimeout(() => {
      idleTimer = 0
      if (destroyed) return
      if (Math.abs(pullRaw) > 0.01 || Math.abs(pull) > 0.01) {
        pullRaw = 0
        pullVelocity = 0
        rebounding = true
        schedule()
      }
    }, SCROLL_IDLE_MS)
  }

  const onWheel = (event: WheelEvent): void => {
    if (destroyed) return
    /* Ctrl + wheel 是缩放（浏览器 / 触控板捏合），不接管。 */
    if (event.ctrlKey || event.metaKey) return
    /* 横向手势放行（触控板左右划）。 */
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return

    const deltaY = normalizeWheelDelta(event.deltaY, event.deltaMode, viewportHeight)
    if (deltaY === 0) return
    /* 内层可滚动区域还能吃下这一滚：让给它。 */
    if (findInnerScrollable(event.target, scroller, deltaY) !== null) return

    /*
     * 不在这里每 wheel 读一次 scrollHeight/clientHeight：复合消息的布局成本
     * 远高于一次事件本身，高频滚轮会被强制同步布局拖成卡顿。尺寸变化交给
     * ResizeObserver 维护（装在第一层 clip 上，内容增高/换会话都会回调）；
     * 这里只做低频兜底（每 250ms 一次），避免懒加载后缓存短暂过期。
     */
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (maxScroll <= 0 || nowMs - lastMaxRefreshAt > 250) {
      refreshMax()
      lastMaxRefreshAt = nowMs
    }
    if (maxScroll <= 0) return

    event.preventDefault()
    beginAutoBehavior()
    rebounding = false
    pullVelocity = 0

    /*
     * 连续输入判定：两次 wheel 间隔小于 45ms 视为触控板/高精度滚轮的连续滑动，
     * 用更小的时间常数跟手；离散滚轮（间隔通常 60ms 以上）用完整阻尼滑行。
     */
    const gap = lastWheelAt === 0 ? Number.POSITIVE_INFINITY : nowMs - lastWheelAt
    lastWheelAt = nowMs
    activeTau = gap < 45 ? SCROLL_TAU_CONTINUOUS : SCROLL_TAU

    /*
     * 反向滚动时先把越界量吃掉，再滚动内容：在顶部向下滚 100px 而越界 -20px
     * 时，用户看到的是「先弹回 20 再往下滚 80」，而不是一边拉伸一边滚。
     */
    let delta = deltaY
    if (pullRaw !== 0 && delta * pullRaw < 0) {
      const absorb = Math.min(Math.abs(delta), Math.abs(pullRaw))
      pullRaw += -Math.sign(pullRaw) * absorb
      delta += -Math.sign(delta) * absorb
    }

    const virtual = target + delta
    target = Math.max(0, Math.min(maxScroll, virtual))
    pullRaw += virtual - target

    schedule()
    armIdleRebound()
  }

  const syncFromDom = (): void => {
    const actual = scroller.scrollTop
    stopRaf()
    endAutoBehavior()
    lastTs = 0
    lastWheelAt = 0
    current = actual
    target = actual
    lastWritten = actual
    pullRaw = 0
    pull = 0
    pullVelocity = 0
    rebounding = false
    clearIdle()
    applyPull()
  }

  const onScroll = (): void => {
    if (destroyed) return
    /*
     * 自己写的 scrollTop 也可能触发 scroll 事件，所以用「最近一次写入值」比对
     * 而不是布尔标志（scroll 事件是异步派发的，标志早就复位了）。
     *
     * 动画进行中放宽到 8px：浏览器会对 scrollTop 做像素/边界夹取，1~2px 的
     * 取整差很常见；若每次都当成「外部滚动」同步一遍，动画会被自己打断，
     * 表现就是滚一下卡一下。真正的用户接管（滚动条拖拽）由 pointerdown 处理。
     */
    const difference = Math.abs(scroller.scrollTop - lastWritten)
    if (rafId !== 0 && difference <= 8) return
    if (difference > EXTERNAL_SCROLL_EPSILON) syncFromDom()
  }

  /*
   * 按下（滚动条拖拽 / 触摸拖动 / 选择文本）立即让位：用户的手优先于惯性。
   * 用 pointerdown 而不是 mousedown，触摸设备也覆盖。
   */
  const onPointerDown = (): void => {
    if (destroyed) return
    if (rafId !== 0) syncFromDom()
  }

  let resizeObserver: ResizeObserver | null = null
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      if (destroyed) return
      refreshMax()
      if (pullRaw !== 0 || pull !== 0) schedule()
    })
    try {
      resizeObserver.observe(scroller)
      const inner = scroller.firstElementChild
      if (inner !== null) resizeObserver.observe(inner)
    } catch {
      /* 测试桩 / 老浏览器：忽略观察失败 */
    }
  }

  scroller.addEventListener('wheel', onWheel, { passive: false })
  scroller.addEventListener('scroll', onScroll, { passive: true })
  scroller.addEventListener('pointerdown', onPointerDown, { passive: true })

  return {
    destroy(): void {
      if (destroyed) return
      destroyed = true
      stopRaf()
      clearIdle()
      resizeObserver?.disconnect()
      resizeObserver = null
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('pointerdown', onPointerDown)
      endAutoBehavior()
      scroller.removeAttribute('data-pa-scroll-damping')
      scroller.removeAttribute('data-pa-scroll-pulling')
      try {
        scroller.style.removeProperty(SCROLL_PULL_VAR)
      } catch {
        /* 测试桩不支持 removeProperty 时忽略 */
      }
    },
    sync: syncFromDom,
  }
}