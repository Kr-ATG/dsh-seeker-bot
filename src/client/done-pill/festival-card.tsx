/**
 * dsh-seeker-bot — 节日卡（Festival Card）— 斜插在完成胶囊左侧的节日小纸片 + 左图右文大卡。
 *
 * ## 形态（与每日情报卡同构，但方向相反）
 *
 * 1. **半截态 = 白色小卡**：绝对定位在胶囊上沿中段（left:30%），宽度随内容
 *    自适应（约 70px）、高 36px、底边压进胶囊 15px（只露出 21px），旋转 -6°。
 *    里面横排「节日名（立冬 / 冬至 / 小寒）+ 圆形倒计时徽标（还有几天）」；
 *    最多两张，第二张 -10°、向右下错开 10px，像两张卡片一起插在胶囊上沿。
 * 2. **点一下 = 弹出浮层**：portal 到 document.body 的 fixed 遮罩 + 大卡，
 *    宽 min(760px,100%)、高 min(560px,82vh)，左 46% 实拍封面（底部半透明图注）、
 *    右 54% 米白纸色文字区（眉标 / 宋体大标题 / 导语 / key-value 行）。
 *
 * ## 数据
 *
 * 全部来自宿主半身（与 shared/festival.ts 的契约）：
 *   · GET  /api/dsh-done-pill/festival/today    —— 最近一张节日卡（可能为 null）
 *   · POST /api/dsh-done-pill/festival/generate —— 触发生成（body 为 {}）
 * 挂载后立刻拉一次，之后前台 60s / 后台 5 分钟；生成中额外加快到 6s。
 * 跨日用独立的 60s 哨兵检测（后台轮询 5 分钟一次，跨日不能等那么久）。
 *
 * ## 依赖方向（硬约束）
 *
 * **不 import ./pill**：胶囊样式表由 pill.tsx 全局注入，本组件只复用它的
 * --dpl-* 变量（见 festival-styles.ts）。两边互相 import 会形成循环依赖。
 * 组件自己也不持有配色与字号常量，所有视觉规则在 festival-styles.ts。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  festivalCardAriaLabel,
  festivalDateKey,
  festivalDayDiff,
  festivalKicker,
  type FestivalCard as FestivalCardData,
  type FestivalNext,
  type FestivalRecord,
  type FestivalTodayResponse,
  type GenerateFestivalResult,
} from '../../shared/festival.ts'
import { ensureFestivalStyles } from './festival-styles'

/** 今天的节日卡（GET）。 */
const TODAY_ROUTE = '/api/dsh-done-pill/festival/today'
/** 触发生成（POST，body 为 {}）。 */
const GENERATE_ROUTE = '/api/dsh-done-pill/festival/generate'
/** 当前展示第几张卡的 localStorage 键（跨刷新保持翻页位置）。 */
const CARD_KEY = 'dsh.festivalCard.card'
/** 前台轮询间隔（ms）。 */
const POLL_MS = 60_000
/** 后台（窗口隐藏）轮询间隔（ms）：降到 5 分钟，但不停掉。 */
const POLL_MS_HIDDEN = 300_000
/** 生成中轮询间隔（ms）：用户刚点过，值得密一点看结果。 */
const POLL_MS_GENERATING = 6_000
/** 跨日哨兵间隔（ms）：独立于主轮询，保证跨日不会被后台 5 分钟拖住。 */
const DAY_CHECK_MS = 60_000
/** 失败原因最多显示多少个字（浮层状态行）。 */
const ERROR_MAX = 48

/** 读翻页位置；非法值一律归零。 */
function loadCardIndex(): number {
  try {
    const raw = localStorage.getItem(CARD_KEY)
    if (raw === null) return 0
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  } catch {
    return 0
  }
}

/** 写翻页位置；存储不可用（隐私模式 / 配额满）时静默。 */
function saveCardIndex(index: number): void {
  try {
    localStorage.setItem(CARD_KEY, String(index))
  } catch { /* 忽略：翻页位置丢了不影响阅读 */ }
}

/** 压平空白并截断（状态行容不下换行）。 */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max) + '…'
}

/** 从任意 JSON 里安全取 error 字段（模型 / 宿主的错误文案不可控）。 */
function errorTextOf(value: unknown): string {
  if (value === null || typeof value !== 'object') return ''
  const text = (value as { error?: unknown }).error
  return typeof text === 'string' ? text.trim() : ''
}

/** 图注展示名：优先来源站点名，其次图片原始标题；都没有就不显示图注。 */
function imageSourceOf(image: FestivalCardData['image']): string {
  if (image === null) return ''
  const source = typeof image.source === 'string' ? image.source.trim() : ''
  if (source !== '') return source
  return typeof image.caption === 'string' ? image.caption.trim() : ''
}

/** 图注链接：只接受 http(s) 绝对地址，其他值一律当纯文本。 */
function imageSourceUrlOf(image: FestivalCardData['image']): string {
  if (image === null) return ''
  const url = typeof image.sourceUrl === 'string' ? image.sourceUrl.trim() : ''
  return /^https?:\/\//i.test(url) ? url : ''
}

export interface FestivalCardProps {
  /** 胶囊大小缩放（--dps）。 */
  scale: number
  /** 官方字号比例（--dpt）。 */
  ratio: number
  /** 宽栏（true）还是 56px 窄轨（false）。 */
  wide: boolean
}

/**
 * 小标签的几何样式：两个缩放维度 + 固定斜角。
 *
 * 旋转角内联而不是写在样式表里：它要跟 --dps / --dpt 一起下发（父容器漏设
 * 变量时也能正确缩放），内联最直接。+30° / +44° 让「斜插」一眼可见。
 */
function rootStyle(scale: number, ratio: number, index: number): CSSProperties {
  return {
    '--dps': String(scale),
    '--dpt': String(ratio),
    // 两张卡两个角度：前卡 -6°、后卡 -10°。与右侧情报卡同一个「白色小卡
    // 轻轻插在胶囊上沿」的观感；用户给的参考是轻微逆时针，不是 +30° 那种
    // 竖着插的窄书签。
    transform: index === 0 ? 'rotate(-6deg)' : 'rotate(-10deg)',
  } as unknown as CSSProperties
}

/**
 * 斜插半截节日卡。
 *
 * 窄轨（wide === false）返回 null：56px 的 rail 上只有 36px 图标钮，没有
 * 地方插一张卡片。此时不渲染、也不发请求（轮询 effect 里同样早退）。
 */
export function FestivalCard(props: FestivalCardProps): JSX.Element | null {
  const wide = props.wide !== false
  // 数值兜底：父容器传 NaN / 0 时退回 1，避免 CSS 变量变成非法值后
  // 所有 calc() 一起失效（那会让卡片塌成一团）。
  const scale = Number.isFinite(props.scale) && props.scale > 0 ? props.scale : 1
  const ratio = Number.isFinite(props.ratio) && props.ratio > 0 ? props.ratio : 1

  const [record, setRecord] = useState<FestivalRecord | null>(null)
  const [next, setNext] = useState<FestivalNext | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  /** 正在播放退场动画：为 true 的这 260ms 里卡片还在，只是开始缩小淡出。 */
  const [closing, setClosing] = useState(false)
  const [cardIndex, setCardIndex] = useState<number>(() => loadCardIndex())
  /** 当前卡的图片加载失败：改用 .fc-cover[data-empty] 的节日大字占位。 */
  const [imageFailed, setImageFailed] = useState(false)

  /** 退场动画的卸载定时器（重复关闭 / 卸载时要清掉）。 */
  const closeTimerRef = useRef<number | null>(null)
  /** 前卡标签节点（点外面判断用；两张标签都能用 closest 命中）。 */
  const tabRef = useRef<HTMLButtonElement | null>(null)
  /** 浮层节点（判断「点外面」用）。 */
  const popRef = useRef<HTMLDivElement | null>(null)
  /** 最近一次渲染出来的浮层节点：卸载时用它克隆「幽灵副本」播退场动画。 */
  const lastPopRef = useRef<HTMLDivElement | null>(null)

  /** 卸载后不再 setState（请求回来时组件可能已经没了）。 */
  const mountedRef = useRef(true)
  /** 生成中的同步镜像：轮询回调与点击回调都要读它，state 会晚一帧。 */
  const generatingRef = useRef(false)
  /** 上一次看到的日期键：跨日哨兵据此判断是否需要立刻重拉。 */
  const dayRef = useRef<string>(festivalDateKey(new Date()))

  const cards = record !== null ? record.cards : []
  const safeIndex = cards.length === 0 ? 0 : Math.min(Math.max(cardIndex, 0), cards.length - 1)
  const card: FestivalCardData | null = cards.length === 0 ? null : (cards[safeIndex] ?? null)
  const activeCardId = card !== null ? card.id : ''

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    generatingRef.current = generating
  }, [generating])

  // 换卡时重置图片失败态：上一张图坏了不能连累下一张。
  useEffect(() => {
    setImageFailed(false)
  }, [activeCardId])

  /** 拉一次今日节日卡。失败不清空已画出的卡（宿主路由可能还没上线）。 */
  const loadToday = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(TODAY_ROUTE, { cache: 'no-store' })
      if (!response.ok) throw new Error('http ' + String(response.status))
      const raw: unknown = await response.json()
      if (raw === null || typeof raw !== 'object') throw new Error('bad payload')
      const data = raw as FestivalTodayResponse
      if (data.ok !== true) throw new Error('bad payload')
      if (!mountedRef.current) return
      setRecord(data.record ?? null)
      setNext(data.next ?? null)
      setGenerating(data.generating === true)
      setError(typeof data.error === 'string' ? data.error : '')
      setLoaded(true)
    } catch {
      // 首轮失败也要标记「已尝试」：否则卡片永远停在骨架态，用户既看不到
      // 「节日卡整理中」，也没法点按触发生成。
      if (mountedRef.current) setLoaded(true)
    }
  }, [])

  /** 手动生成 / 重试：POST 一个空对象，宿主按默认日期与模型生成。 */
  const generate = useCallback(async (): Promise<void> => {
    if (generatingRef.current) return
    generatingRef.current = true
    setGenerating(true)
    setError('')
    try {
      const response = await fetch(GENERATE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      const raw: unknown = await response.json()
      const data = raw as GenerateFestivalResult | null
      if (data !== null && data !== undefined && data.ok === true && data.record !== undefined && data.record !== null) {
        if (!mountedRef.current) return
        setRecord(data.record)
        setError('')
        setCardIndex(0)
        saveCardIndex(0)
      } else if (mountedRef.current) {
        const message = errorTextOf(data)
        setError(message !== '' ? message : '生成失败，稍后再试')
      }
    } catch {
      if (mountedRef.current) setError('网络请求失败，稍后再试')
    } finally {
      generatingRef.current = false
      if (mountedRef.current) setGenerating(false)
    }
  }, [])

  // 轮询：立即拉一次 → 按前台 / 后台 / 生成中三档安排下一次；可见性变化
  // 立刻补拉；跨日由独立哨兵触发（见 DAY_CHECK_MS）。
  useEffect(() => {
    if (!wide) return
    let stopped = false
    let timer: number | null = null
    let inFlight = false

    const schedule = (): void => {
      if (stopped) return
      if (timer !== null) window.clearTimeout(timer)
      const hidden = typeof document !== 'undefined' && document.hidden
      const delay = generatingRef.current ? POLL_MS_GENERATING : hidden ? POLL_MS_HIDDEN : POLL_MS
      timer = window.setTimeout(() => { void run() }, delay)
    }

    const run = async (): Promise<void> => {
      if (stopped || inFlight) return
      inFlight = true
      try {
        await loadToday()
      } finally {
        inFlight = false
      }
      if (!stopped) schedule()
    }

    void run()

    const onVisibility = (): void => {
      if (stopped) return
      if (document.hidden) schedule()
      else void run()
    }
    document.addEventListener('visibilitychange', onVisibility)

    const dayTimer = window.setInterval(() => {
      const today = festivalDateKey(new Date())
      if (today === dayRef.current) return
      dayRef.current = today
      // 跨日：卡序号归零（昨天的第 2 张不该延续到今天），并立刻重拉。
      setCardIndex(0)
      saveCardIndex(0)
      void run()
    }, DAY_CHECK_MS)

    return () => {
      stopped = true
      if (timer !== null) window.clearTimeout(timer)
      window.clearInterval(dayTimer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [wide, loadToday])

  /** 翻页（1–2 张卡循环）：同步写 localStorage，刷新后停在原位置。 */
  const changeCard = useCallback((delta: number): void => {
    const total = record !== null ? record.cards.length : 0
    if (total <= 1) return
    setCardIndex((previous) => {
      const nextIndex = ((previous + delta) % total + total) % total
      saveCardIndex(nextIndex)
      return nextIndex
    })
  }, [record])

  /** 鼠标滚轮切换卡片（防抖冷却 380ms，支持右栏长滚动保护）。 */
  const wheelLockRef = useRef(false)
  const wheelTimerRef = useRef<number | null>(null)

  const handleWheel = useCallback((event: React.WheelEvent): void => {
    const total = record !== null ? record.cards.length : 0
    if (total <= 1) return

    const target = event.target as HTMLElement | null
    const scrollable = target !== null ? target.closest('.fc-paper') as HTMLElement | null : null
    if (scrollable !== null && scrollable.scrollHeight > scrollable.clientHeight) {
      const isDown = event.deltaY > 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 2
      const atTop = scrollable.scrollTop <= 2
      if (isDown && !atBottom) return
      if (!isDown && !atTop) return
    }

    if (Math.abs(event.deltaY) < 16) return

    if (wheelLockRef.current) return
    wheelLockRef.current = true
    if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current)
    wheelTimerRef.current = window.setTimeout(() => {
      wheelLockRef.current = false
    }, 380)

    const step = event.deltaY > 0 ? 1 : -1
    changeCard(step)
  }, [record, changeCard])

  useEffect(() => () => {
    if (wheelTimerRef.current !== null) {
      window.clearTimeout(wheelTimerRef.current)
      wheelTimerRef.current = null
    }
  }, [])

  /**
   * 关闭浮层。**所有关闭路径都必须走这里**，包括点外面 —— 否则那条路径
   * 就是直接卸载，没有退场动效。
   *
   * 不是立刻卸载：先置 closing 让 CSS 播完退场动画（260ms，加速曲线），
   * 再真正 setOpen(false)。
   */
  const close = useCallback((): void => {
    if (closeTimerRef.current !== null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      if (!mountedRef.current) return
      setClosing(false)
      setOpen(false)
    }, 260)
  }, [])

  /** Escape 关闭：挂在 document 上，焦点不在弹层里时也能生效。 */
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open, close])

  /**
   * 点浮层外面关闭 —— 同样走 close()，所以也有退场动效。
   *
   * 用 pointerdown（而不是 click）：浮层里的按钮按下后可能触发重渲染，
   * click 阶段节点已变，判断会失准。捕获阶段监听，保证先于业务点击执行。
   * 标签点击不触发关闭（两张标签都要算「里面」）。
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (popRef.current !== null && popRef.current.contains(target)) return
      if (tabRef.current !== null && tabRef.current.contains(target)) return
      if (target.closest('.dsh-festival-card') !== null) return
      close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open, close])

  // 组件卸载时清掉退场定时器（否则回调会打在已卸载的组件上）。
  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  /**
   * 组件卸载时，如果浮层还开着，留一个「幽灵副本」把退场动画播完。
   *
   * 切换会话、把胶囊切成悬浮形态、关掉功能开关、页面导航 —— 这些场景里
   * 父组件直接卸载，React 不会给组件任何「先播完动画再走」的机会。这里在
   * cleanup 里把当前节点 clone 一份挂到 body 上，加上 data-closing 播那
   * 260ms，播完自己移除。用 lastPopRef 而不是 popRef：React 卸载时先 detach
   * ref 再移除 DOM，cleanup 执行时 popRef.current 往往已经是 null。
   */
  useEffect(() => () => {
    const el = lastPopRef.current
    lastPopRef.current = null
    if (el === null || typeof document === 'undefined') return
    try {
      const ghost = el.cloneNode(true) as HTMLElement
      ghost.setAttribute('data-closing', '1')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.style.pointerEvents = 'none'
      document.body.appendChild(ghost)
      window.setTimeout(() => { ghost.remove() }, 320)
    } catch { /* 克隆失败就算了：宁可硬消失，也不要抛错 */ }
  }, [])

  // 正常关闭后清掉指向已卸载节点的引用，避免组件之后卸载时误克隆一个旧浮层。
  useEffect(() => {
    if (open) return
    lastPopRef.current = null
  }, [open])

  // 窄轨没有插卡的位置：hooks 已全部执行（React 规则），这里直接不渲染。
  if (!wide) return null

  // 样式表在首帧渲染前注入一次：放在 return 之前而不是 effect 里，避免
  // 第一帧无样式（卡片会先闪一下白底大块再缩成半截）。
  ensureFestivalStyles()

  /** 视图状态：骨架 → 有卡 / 空 / 生成中 / 失败。 */
  const view: 'skeleton' | 'ready' | 'generating' | 'error' | 'empty' = !loaded
    ? 'skeleton'
    : card !== null
      ? 'ready'
      : generating
        ? 'generating'
        : error !== ''
          ? 'error'
          : 'empty'

  const now = new Date()
  const ariaLabel = card !== null
    ? festivalCardAriaLabel(card)
    : view === 'skeleton'
      ? '节日卡：正在加载'
      : view === 'generating'
        ? '节日卡：正在准备'
        : view === 'error'
          ? '节日卡：准备失败，点按重试'
          : next !== null
            ? '节日卡：下一个节日 ' + next.name + '，点按生成'
            : '节日卡：最近没有临近的节日'

  /** 圆形徽标：倒计时数字（今天「今」、明天 1、还有 N 天 N，超过 9 写 9+）。 */
  const countOf = (item: { festivalDate: string } | undefined): string => {
    if (view !== 'ready' || item === undefined) return '·'
    const diff = festivalDayDiff(now, item.festivalDate)
    if (diff <= 0) return '今'
    return diff > 9 ? '9+' : String(diff)
  }

  /**
   * 标签列表：有卡时一张卡一个标签（最多 2 个，半叠放），没卡时一个占位标签。
   *
   * 占位标签在冷启动 / 失败时固定写「节气」；空态若知道下一个节日，就直接
   * 显示它的名字——用户点它就是要生成这一张。
   */
  const tabs = cards.length > 0
    ? cards.map((item, index) => ({
      key: item.id,
      index,
      label: item.name.slice(0, 4),
      badge: countOf(item),
      ariaLabel: festivalCardAriaLabel(item),
    }))
    : [{
      key: 'placeholder',
      index: 0,
      label: view === 'skeleton' || view === 'error' ? '节气' : (next !== null ? next.name.slice(0, 4) : '节气'),
      badge: '·',
      ariaLabel,
    }]

  /**
   * 点标签 / 回车 / 空格：打开浮层（不是「原位撑大」）。
   *
   * 没卡的时候顺手触发生成：用户点它就是想看内容，让他在浮层里看到
   * 「正在准备节日卡…」比点了没反应好。首轮拉取还没回来时不触发（多半是误触）。
   */
  const activate = (): void => {
    // 退场动画还没播完又被点开：取消卸载，直接留在原地重新入场。
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setClosing(false)
    setOpen(true)
    if (card !== null) return
    if (!loaded) return
    if (generatingRef.current || generating) return
    void generate()
  }

  let statusTitle = ''
  let statusSub = ''
  if (view === 'generating') {
    statusTitle = '正在准备节日卡…'
    statusSub = '搜集资料与配图，通常一分钟内'
  } else if (view === 'error') {
    statusTitle = '节日卡没做出来'
    statusSub = truncate(error, ERROR_MAX) + ' · 点此重试'
  } else if (view === 'empty') {
    statusTitle = next !== null ? '下一个节日：' + next.name : '最近没有临近的节日'
    statusSub = next !== null
      ? next.dateLabel + ' · ' + next.countdown + '，点此生成这张卡'
      : '最近三天里没有节气或节日，稍后再来看看'
  }

  const image = card !== null ? card.image : null
  const caption = imageSourceOf(image)
  const captionUrl = imageSourceUrlOf(image)
  const coverEmpty = image === null || imageFailed

  let body: JSX.Element | null = null
  if (view === 'skeleton') {
    body = (
      <div className="fc-skeleton" aria-hidden>
        <span className="fc-skeleton-line" data-w="1" />
        <span className="fc-skeleton-line" data-w="2" />
        <span className="fc-skeleton-line" data-w="3" />
      </div>
    )
  } else if (card !== null && record !== null) {
    const kickerText = festivalKicker({ name: card.name, date: card.festivalDate }, now)
    body = (
      <>
        {/* 左栏：实拍封面 + 底部半透明图注；无图 / 加载失败时大字占位。 */}
        <div className="fc-cover" data-empty={coverEmpty ? '1' : undefined}>
          {!coverEmpty && image !== null && (
            <img
              className="fc-cover-img"
              src={image.url}
              alt=""
              decoding="async"
              onError={() => { setImageFailed(true) }}
            />
          )}
          <div className="fc-cover-name" aria-hidden>{card.name}</div>
          {!coverEmpty && caption !== '' && (
            <div className="fc-caption">
              图片来源：
              {captionUrl !== '' ? (
                <a href={captionUrl} target="_blank" rel="noreferrer" onClick={(event) => { event.stopPropagation() }}>
                  {caption}
                </a>
              ) : caption}
            </div>
          )}
        </div>

        {/* 右栏：眉标 / 宋体大标题 / 导语 / key-value 行 / 翻页。 */}
        <div className="fc-paper">
          <div className="fc-kicker">
            <span className="fc-kicker-text">{kickerText}</span>
            {record.origin === 'fallback' && <span className="fc-origin">资料卡</span>}
          </div>
          <h2 className="fc-title">{card.title}</h2>
          {card.lede !== '' && <p className="fc-lede">{card.lede}</p>}
          {card.facts.length > 0 && (
            <div className="fc-facts">
              {card.facts.map((fact, index) => (
                <div className="fc-fact" key={fact.label + ':' + String(index)}>
                  <span className="fc-fact-label">{fact.label}</span>
                  <span className="fc-fact-value">{fact.value}</span>
                </div>
              ))}
            </div>
          )}
          {cards.length > 1 && (
            <div className="fc-page">
              <button
                type="button"
                className="fc-page-btn"
                aria-label="上一张节日卡"
                onClick={(event) => { event.stopPropagation(); changeCard(-1) }}
              >
                ‹
              </button>
              <span className="fc-page-label">{String(safeIndex + 1) + ' / ' + String(cards.length)}</span>
              <button
                type="button"
                className="fc-page-btn"
                aria-label="下一张节日卡"
                onClick={(event) => { event.stopPropagation(); changeCard(1) }}
              >
                ›
              </button>
            </div>
          )}
          <div className="fc-progress" aria-hidden>
            {cards.map((item, index) => (
              <span key={item.id} data-on={index === safeIndex ? '1' : undefined} />
            ))}
          </div>
        </div>
      </>
    )
  } else {
    body = (
      <div className="fc-status">
        <span className="fc-status-title">{statusTitle}</span>
        <span className="fc-status-sub" data-error={view === 'error' ? '1' : '0'}>{statusSub}</span>
        {view === 'generating' && <span className="fc-loading" aria-hidden />}
      </div>
    )
  }

  return (
    <>
      {/*
       * 半截态：斜插在胶囊左侧的白色小卡，最多两张半叠放。
       * 后卡先渲染（DOM 在前、z-index 更低），前卡压在它上面；两张角度不同
       *（-6° / -10°），第二张向右下错开 10px，底边压进胶囊 15px。
       */}
      {tabs.map((tab) => (
        <button
          key={tab.key}
          ref={tab.index === 0 ? tabRef : undefined}
          type="button"
          className="dsh-festival-card"
          data-stack={tab.index === 0 ? 'front' : 'back'}
          style={rootStyle(scale, ratio, tab.index)}
          data-state={view}
          aria-label={tab.ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={tab.ariaLabel}
          onClick={() => {
            setCardIndex(tab.index)
            saveCardIndex(tab.index)
            activate()
          }}
        >
          <span className="fc-tab">{tab.label}</span>
          <span
            className="fc-count"
            data-live={view === 'generating' ? '1' : undefined}
            data-empty={view === 'empty' || view === 'error' || view === 'skeleton' ? '1' : undefined}
            aria-hidden
          >
            {tab.badge}
          </span>

        </button>
      ))}
      {/*
       * 划出层：点标签后 portal 到 body 的「左图右文」大卡，从屏幕正中划出。
       * 挂 .dsh-done-pill 是为了继承 --dpl-* 配色（portal 之后不是胶囊的后代）；
       * --dps / --dpt 也挂在这里，卡片内部的 calc() 才跟着胶囊缩放走。
       */}
      {open && createPortal(
        <div
          className="dsh-done-pill fc-modal"
          data-closing={closing ? '1' : undefined}
          style={{ '--dps': String(scale), '--dpt': String(ratio) } as unknown as CSSProperties}
          role="presentation"
          onClick={close}
        >
          <div
            ref={(node) => {
              popRef.current = node
              // 幽灵副本要克隆的是 .fc-modal（data-closing 挂在它上面），
              // 不是这张 sheet —— 用 closest 往上找，挂载时 DOM 已经连接。
              const root = node === null ? null : node.closest('.fc-modal')
              if (root instanceof HTMLElement) lastPopRef.current = root
            }}
            className="fc-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            onWheel={handleWheel}
            onClick={(event) => { event.stopPropagation() }}
          >
            <button
              type="button"
              className="fc-close"
              aria-label="关闭节日卡"
              onClick={(event) => { event.stopPropagation(); close() }}
            >
              ✕
            </button>
            {body}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
