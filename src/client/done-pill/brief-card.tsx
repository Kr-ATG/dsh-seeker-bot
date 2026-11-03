/**
 * dsh-seeker-bot — 每日情报卡（Daily Brief）— 斜插在对话完成胶囊上的小标签 + 弹出卡。
 *
 * ## 形态（两段式，不是一个会撑大的卡）
 *
 * 1. **半截态 = 小标签**：绝对定位在胶囊左上角，宽度只有胶囊的 1/5（约 50px）、
 *    露出约 28px，旋转 -7deg，只写一个栏目短标签（AI / 世界 / 国内）和一个
 *    状态小圆点。它是一张「斜插的纸片书签」，不是阅读面。
 * 2. **点一下 = 弹出浮层**：portal 到 document.body 的 fixed 浮层（320px 宽、
 *    最多 420px 高、内部滚动），里面才是完整日报卡：栏目 / 大标题 / 导语 /
 *    3–5 条编号条目 / 来源外链 / 「继续聊这个」/ 1–2 张翻页。
 *
 * 为什么不做「hover 原位撑大」：第一版就是那样，实测一张纸直接盖住半个侧栏，
 * 太重也太吵。小标签 + 独立浮层才是用户要的形态（点开才看内容）。
 *
 * ## 数据
 *
 * 全部来自宿主半身（与 shared/brief.ts 的契约）：
 *   · GET  /api/dsh-done-pill/brief/today    —— 今天的简报（可能为 null）
 *   · POST /api/dsh-done-pill/brief/generate —— 触发生成（body 为 {}）
 * 挂载后立刻拉一次，之后前台 60s / 后台 5 分钟；生成中额外加快到 6s，
 * 否则用户要干等一分钟才看到结果。跨日用独立的 60s 哨兵检测（后台轮询
 * 5 分钟一次，跨日不能等那么久），一旦跨日立刻重拉并把卡序号归零。
 *
 * ## 依赖方向（硬约束）
 *
 * **不 import ./pill**：胶囊样式表由 pill.tsx 全局注入，本组件只复用它的
 * --dpl-* 变量（见 brief-styles.ts）。两边互相 import 会形成循环依赖，
 * esbuild 打包顺序一变就是运行时 undefined。
 *
 * 组件自己也不持有配色与字号常量：所有视觉规则在 brief-styles.ts，组件只
 * 负责状态（data-state）、几何变量（--dps / --dpt）与内联的旋转角。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  briefCardAriaLabel,
  briefCardChatPrompt,
  briefDateKey,
  type BriefCard,
  type BriefRecord,
  type BriefTodayResponse,
  type GenerateBriefResult,
} from '../../shared/brief.ts'
import { ensureBriefStyles } from './brief-styles'

/** 今天的简报（GET）。 */
const TODAY_ROUTE = '/api/dsh-done-pill/brief/today'
/** 触发生成（POST，body 为 {}）。 */
const GENERATE_ROUTE = '/api/dsh-done-pill/brief/generate'
/** 当前展示第几张卡的 localStorage 键（跨刷新保持翻页位置）。 */
const CARD_KEY = 'dsh.dailyBrief.card'
/** 前台轮询间隔（ms）。 */
const POLL_MS = 60_000
/** 后台（窗口隐藏）轮询间隔（ms）：降到 5 分钟，但不停掉。 */
const POLL_MS_HIDDEN = 300_000
/** 生成中轮询间隔（ms）：用户刚点过「生成」，值得密一点看结果。 */
const POLL_MS_GENERATING = 6_000
/** 跨日哨兵间隔（ms）：独立于主轮询，保证跨日不会被后台 5 分钟拖住。 */
const DAY_CHECK_MS = 60_000
/** 失败原因最多显示多少个字（半截卡只有一行小字）。 */
const ERROR_MAX = 40

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

/** 压平空白并截断（半截卡的一行小字容不下换行）。 */
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

export interface BriefCardProps {
  /** 胶囊大小缩放（--dps）。 */
  scale: number
  /** 官方字号比例（--dpt）。 */
  ratio: number
  /** 宽栏（true）还是 56px 窄轨（false）。 */
  wide: boolean
  /** 「继续聊这个」：把提示词写进输入框（父组件实现）。 */
  onChat: (text: string) => void
}

/**
 * 小标签的几何样式：两个缩放维度 + 固定斜角。
 *
 * 旋转角内联而不是写在样式表里：它要跟 --dps / --dpt 一起下发（父容器漏设
 * 变量时也能正确缩放），内联最直接。-38deg 让「斜插」一眼可见：角度小到
 * 7deg 时只是一张稍微歪了一点的方块，看起来像普通标签而不是插进去的纸片。
 */
function rootStyle(scale: number, ratio: number, index: number): CSSProperties {
  return {
    '--dps': String(scale),
    '--dpt': String(ratio),
    // 两张卡两个角度：前卡 -30°、后卡 -44°（夹角 14°）。角度不同才有
    // 「两张纸片各插各的」错落感；同角度叠放看起来只是一张厚纸。
    // 整体偏左（逆时针）——角度再小就只是「歪了一点的方块」，不像插进去。
    transform: index === 0 ? 'rotate(-30deg)' : 'rotate(-44deg)',
  } as unknown as CSSProperties
}

/**
 * 斜插半截情报卡。
 *
 * 窄轨（wide === false）返回 null：56px 的 rail 上只有 36px 图标钮，没有
 * 地方插一张卡片。此时不渲染、也不发请求（轮询 effect 里同样早退）。
 */
export function BriefCard(props: BriefCardProps): JSX.Element | null {
  const wide = props.wide !== false
  // 数值兜底：父容器传 NaN / 0 时退回 1，避免 CSS 变量变成非法值后
  // 所有 calc() 一起失效（那会让卡片塌成一团）。
  const scale = Number.isFinite(props.scale) && props.scale > 0 ? props.scale : 1
  const ratio = Number.isFinite(props.ratio) && props.ratio > 0 ? props.ratio : 1

  const [brief, setBrief] = useState<BriefRecord | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  /** 正在播放退场动画：为 true 的这 190ms 里卡片还在，只是开始缩小淡出。 */
  const [closing, setClosing] = useState(false)
  const [cardIndex, setCardIndex] = useState<number>(() => loadCardIndex())

  /** 退场动画的卸载定时器（重复关闭 / 卸载时要清掉）。 */
  const closeTimerRef = useRef<number | null>(null)
  /** 标签节点（点外面判断用）。 */
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
  const dayRef = useRef<string>(briefDateKey(new Date()))

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    generatingRef.current = generating
  }, [generating])

  /**
   * 点外面关闭浮层。
   *
   * 用 pointerdown（而不是 click）：浮层里的按钮按下后可能触发重渲染，
   * click 阶段节点已变，判断会失准。捕获阶段监听，保证先于业务点击执行。
   */
  /** 拉一次今日简报。失败不清空已画出的卡（宿主路由可能还没上线）。 */
  const loadToday = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(TODAY_ROUTE, { cache: 'no-store' })
      if (!response.ok) throw new Error('http ' + String(response.status))
      const raw: unknown = await response.json()
      if (raw === null || typeof raw !== 'object') throw new Error('bad payload')
      const data = raw as BriefTodayResponse
      if (data.ok !== true) throw new Error('bad payload')
      if (!mountedRef.current) return
      setBrief(data.brief ?? null)
      setGenerating(data.generating === true)
      setError(typeof data.error === 'string' ? data.error : '')
      setLoaded(true)
    } catch {
      // 首轮失败也要标记「已尝试」：否则卡片永远停在骨架态，用户既看不到
      // 「今日情报整理中」，也没法点按触发生成。
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
      const data = raw as GenerateBriefResult | null
      if (data !== null && data !== undefined && data.ok === true && data.brief !== undefined && data.brief !== null) {
        if (!mountedRef.current) return
        setBrief(data.brief)
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
      const today = briefDateKey(new Date())
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
    const total = brief?.cards.length ?? 0
    if (total <= 1) return
    setCardIndex((previous) => {
      const next = ((previous + delta) % total + total) % total
      saveCardIndex(next)
      return next
    })
  }, [brief])

  // 窄轨没有插卡的位置：hooks 已全部执行（React 规则），这里直接不渲染。
  if (!wide) return null

  // 样式表在首帧渲染前注入一次：放在 return 之前而不是 effect 里，避免
  // 第一帧无样式（卡片会先闪一下白底大块再缩成半截）。
  ensureBriefStyles()

  const cards = brief?.cards ?? []
  const safeIndex = cards.length === 0 ? 0 : Math.min(Math.max(cardIndex, 0), cards.length - 1)
  const card: BriefCard | null = cards.length === 0 ? null : (cards[safeIndex] ?? null)

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

  const ariaLabel = card !== null
    ? briefCardAriaLabel(card)
    : view === 'skeleton'
      ? '每日情报卡：正在加载今日情报'
      : view === 'generating'
        ? '每日情报卡：正在联网整理今日情报'
        : view === 'error'
          ? '每日情报卡：整理失败，点按重试'
          : '每日情报卡：今日尚未生成，点按生成'

  const metaText = brief !== null
    ? (cards.length > 1 ? brief.dateLabel + ' · ' + String(cards.length) + ' 张' : brief.dateLabel)
    : ''

  /**
   * 标签列表：有卡时一张卡一个标签（最多 2 个，半叠放），没卡时一个占位标签。
   *
   * 短栏目名取 kicker 的第一段（「AI · 前沿」→「AI」），最长 3 个字 ——
   * 标签只有 38px 宽，再多就放不下了。
   */
  const tabs = cards.length > 0
    ? cards.map((item, index) => ({
      key: item.id,
      index,
      label: (item.kicker.split('·')[0]?.trim() || '情报').slice(0, 3),
      ariaLabel: briefCardAriaLabel(item),
    }))
    : [{ key: 'placeholder', index: 0, label: '情报', ariaLabel }]

  /**
   * 点标签 / 回车 / 空格：打开浮层（不是「原位撑大」）。
   *
   * 没卡的时候顺手触发生成：用户点它就是想看内容，让他在浮层里看到
   * 「正在联网整理…」比点了没反应好。首轮拉取还没回来时不触发（多半是误触）。
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

  /**
   * 关闭浮层。**所有关闭路径都必须走这里**，包括点外面 —— 否则那条路径
   * 就是直接卸载，没有退场动效（第一版点外面用的裸 setOpen(false)，用户
   * 一眼就看出「点外面消失得很生硬」）。
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

  /**
   * 点浮层外面关闭 —— 同样走 close()，所以也有退场动效。
   *
   * 用 pointerdown（而不是 click）：浮层里的按钮按下后可能触发重渲染，
   * click 阶段节点已变，判断会失准。捕获阶段监听，保证先于业务点击执行。
   *
   * 必须定义在 close 之后（依赖它）：写在前面会因为 const 暂时性死区拿不到。
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (popRef.current !== null && popRef.current.contains(target)) return
      if (tabRef.current !== null && tabRef.current.contains(target)) return
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
   * 为什么需要：切换会话、把胶囊切成悬浮形态、关掉功能开关、页面导航 ——
   * 这些场景里父组件直接卸载，React 不会给组件任何「先播完动画再走」的机会，
   * 卡片会硬生生消失。这里在 cleanup 里把当前节点 clone 一份挂到 body 上，
   * 加上 data-closing 播那 260ms，播完自己移除。
   *
   * 用 lastPopRef 而不是 popRef：React 卸载时先 detach ref 再移除 DOM，
   * cleanup 执行时 popRef.current 往往已经是 null。
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

  let statusTitle = ''
  let statusSub = ''
  if (view === 'empty') {
    statusTitle = '今日情报整理中'
    statusSub = '点此生成 · 联网搜索后撰写'
  } else if (view === 'generating') {
    statusTitle = '正在联网整理…'
    statusSub = '搜索 + 撰写，通常一分钟内'
  } else if (view === 'error') {
    statusTitle = '情报卡没整理出来'
    statusSub = truncate(error, ERROR_MAX) + ' · 点此重试'
  }

  /** 浮层头：栏目名 + 未联网角标 + 日期 + 关闭。所有状态共用同一条头。 */
  const sheetHead = (
    <div className="db-head">
      <span className="db-kicker">{card !== null ? card.kicker : '每日情报'}</span>
      {/* 未联网：模型只凭自身知识写的，用弱色角标提示可信度差异，
          不用警告色——这不是错误，只是来源不同。 */}
      {brief !== null && brief.origin === 'model' && <span className="db-offline">未联网</span>}
      <span className="db-meta">{metaText}</span>
      <button type="button" className="db-close" aria-label="关闭情报卡" onClick={close}>✕</button>
    </div>
  )

  let body: JSX.Element
  if (view === 'skeleton') {
    body = (
      <div className="db-skeleton" aria-hidden>
        <span className="db-skeleton-line" data-w="1" />
        <span className="db-skeleton-line" data-w="2" />
      </div>
    )
  } else if (card !== null && brief !== null) {
    // 期刊式两栏：左栏主题（大标题 / 导语 / 动作），右栏编号条目。
    body = (
      <div className="db-body">
        <div className="db-col-left">
          <div className="db-title">{card.title}</div>
          {card.lede !== '' && <div className="db-lede">{card.lede}</div>}
          <div className="db-actions">
            <button
              type="button"
              className="db-chat"
              onClick={() => {
                props.onChat(briefCardChatPrompt(card))
                close()
              }}
            >
              继续聊这个
            </button>
            <span className="db-spacer" />
            {cards.length > 1 && (
              <span className="db-pager">
                <button
                  type="button"
                  className="db-pager-btn"
                  aria-label="上一张情报卡"
                  onClick={() => { changeCard(-1) }}
                >
                  ‹
                </button>
                <span className="db-pager-label">{String(safeIndex + 1) + ' / ' + String(cards.length)}</span>
                <button
                  type="button"
                  className="db-pager-btn"
                  aria-label="下一张情报卡"
                  onClick={() => { changeCard(1) }}
                >
                  ›
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="db-col-right">
          {card.entries.length > 0 && (
            <div className="db-entries">
              {card.entries.map((entry) => (
                <div className="db-entry" key={entry.order}>
                  <span className="db-no">{String(entry.order).padStart(2, '0')}</span>
                  <div className="db-entry-main">
                    <span className="db-entry-title">{entry.title}</span>
                    {entry.text !== '' && <span className="db-entry-text">{entry.text}</span>}
                    {(entry.tag !== undefined || entry.source !== undefined || entry.url !== undefined) && (
                      <span className="db-entry-foot">
                        {entry.tag !== undefined && <span className="db-entry-tag">{entry.tag}</span>}
                        {entry.url !== undefined ? (
                          <a
                            className="db-entry-src"
                            data-link="1"
                            href={entry.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {entry.source !== undefined ? entry.source : '原文'}
                          </a>
                        ) : entry.source !== undefined ? (
                          <span className="db-entry-src">{entry.source}</span>
                        ) : null}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  } else {
    body = (
      <>
        <div className="db-status">
          <span className="db-status-title">{statusTitle}</span>
          <span className="db-status-sub" data-error={view === 'error' ? '1' : '0'}>{statusSub}</span>
        </div>
        {view === 'generating' && <span className="db-progress" aria-hidden />}
      </>
    )
  }

  return (
    <>
      {/*
       * 半截态：斜插在胶囊 2/3 处的小标签，最多两张半叠放。
       * 后卡先渲染（DOM 在前、z-index 更低），前卡压在它上面；两张角度不同
       * （-23° / -34°），错开 10px，看起来像两张纸片一起插在胶囊后面。
       */}
      {tabs.map((tab) => (
        <button
          key={tab.key}
          ref={tab.index === 0 ? tabRef : undefined}
          type="button"
          className="dsh-daily-brief"
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
          <span className="db-tab">{tab.label}</span>
          {tab.index === 0 && (
            <span
              className="db-pip"
              data-live={view === 'generating' ? '1' : undefined}
              data-empty={view === 'empty' || view === 'error' ? '1' : undefined}
              aria-hidden
            />
          )}
        </button>
      ))}
      {/*
       * 划出层：点标签后 portal 到 body 的「期刊式」大卡，从屏幕正中划出。
       * 挂 .dsh-done-pill 是为了继承 --dpl-* 配色（portal 之后不是胶囊的后代）；
       * --dps / --dpt 也挂在这里，卡片内部的 calc() 才跟着胶囊缩放走。
       */}
      {open && createPortal(
        <div
          className="dsh-done-pill db-modal"
          data-closing={closing ? '1' : undefined}
          style={{ '--dps': String(scale), '--dpt': String(ratio) } as unknown as CSSProperties}
          role="presentation"
          onClick={close}
        >
          <div
            ref={(node) => {
              popRef.current = node
              // 幽灵副本要克隆的是 .db-modal（data-closing 挂在它上面），
              // 不是这张 sheet —— 用 closest 往上找，挂载时 DOM 已经连接。
              const root = node === null ? null : node.closest('.db-modal')
              if (root instanceof HTMLElement) lastPopRef.current = root
            }}
            className="db-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            onClick={(event) => { event.stopPropagation() }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                close()
              }
            }}
          >
            {sheetHead}
            {body}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

