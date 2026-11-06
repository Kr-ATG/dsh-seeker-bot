/**
 * dsh-seeker-bot — iu 原生交互卡片（iu 围栏的渲染器 / 外壳）。
 *
 * 与 HtmlCard 的差异只在载体：这里是原生 React 组件（无 iframe、无沙箱），
 * 状态在本地 + localStorage 持久化，主题与动效跟随宿主。安全上没有新边界：
 * 所有渲染都是宿主自己的 DOM，不执行模型给的代码。
 *
 * ## 外壳只做三件事（kind 的差异全在 registry / bodies 里）
 *
 *  1. **Head**：标题 + 角标（角标文案读 registry 的 label，两处渲染同源）；
 *  2. **状态容器**：按围栏内容哈希做持久化 key（见 state.ts），把 state/setState
 *     注入 Body——Body 自己不持有 useState，刷新页面状态不丢；
 *  3. **Body 路由**：按 spec.kind 从 bodies.ts 取 React 体渲染（未知 kind → 不渲染）。
 *
 * 曾经还有第 4 件 **FillRow**（底栏「填入输入框」），已按要求整块移除：外壳
 * 不再画任何底栏动作区，右下角不再有实心蓝按钮。注意与 html 卡片区分——
 * html 卡片里的 `window.__dshFill` 是**模型自己页面里**调用的桥，那套仍然有效，
 * 只是不再有插件替它画按钮。
 *
 * **唯一例外是 form**：它由 Body 自绘一个提交按钮（文案 = spec.submitLabel），
 * 因为表单填完没有出口就是废卡。外壳不为此复活整层底栏——需要动作入口的 kind
 * 自己长一个，外壳不必知道谁需要。
 *
 * 新增一个 kind **不需要碰本文件**：只要它注册进 registry.ts（纯逻辑）与
 * bodies.ts（React 体），外壳自动接住。这正是老结构「一个 kind 改四处」的解药。
 *
 * ## 字号轴
 *
 * 基座 CSS（styles.ts）在 .dtt-iu 上定义 --iu-text-scale = 官方正文字号 / 14，
 * 各 kind 的字号写 calc(Npx * var(--iu-text-scale,1))，于是卡片文字跟随官方
 * 「设置 → 字号」无级缩放，不需要 JS 监听。
 *
 * ## 宽度轴（卡片级，不是视口级）
 *
 * 基座 CSS 给 .dtt-iu 挂 container-type: inline-size / container-name: iu，
 * kinds 侧的窄卡降级写 @container iu (max-width:Npx)，量的是这张卡自己的实宽。
 * 外壳再用 ResizeObserver 把实测宽写进根节点 inline 变量 --iu-card-w（px）与
 * data-iu-w（narrow/mid/wide）；两者都不经 JS 传给 Body，kind 该用哪把尺子自己选。
 * 全屏层是 portal 到 body 的独立实例，各自测量、各自写，不共用内嵌卡的读数。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { IuSpecBase } from './kinds/contract.ts'
import type { IuState } from './kinds/contract.ts'
import { iuKindOf } from './kinds/registry.ts'
import { IU_BODIES } from './kinds/bodies.ts'
import { iuStateKey, readIuState, writeIuState } from './state.ts'
import { lockBodyScroll } from '../shared/scroll-lock.ts'

/** 图标：全屏（四角外扩）。 */
function ExpandIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2.4H2.4V6" />
      <path d="M10 13.6h3.6V10" />
      <path d="M13.6 6V2.4H10" />
      <path d="M2.4 10v3.6H6" />
    </svg>
  )
}

/** 填入输入框的回调（父组件用 inputActions.setDraft 实现，拿不到时回退剪贴板）。 */
export type IuFillFn = (text: string) => boolean

// ── 向后兼容的回写文案 wrapper ────────────────────────────────────────────
// 历史上这些函数从本文件导出、smoke 直接断言其文案。重构后 fillText 收敛到各
// kind 模块（签名 (spec, state)），这里保留旧签名的薄 wrapper：把标量/Set/数组
// 入参转成对应 kind 的 state 形状，再委派 registry。公开 API 与 smoke 断言零改动。

/** slider：旧签名 (spec, value)。 */
export function sliderFillText(spec: unknown, value: number): string {
  return callFill('slider', spec, { value })
}
/** checklist：旧签名 (spec, Set<下标>)。 */
export function checklistFillText(spec: unknown, checked: ReadonlySet<number>): string {
  return callFill('checklist', spec, { checked: [...checked].sort((a, b) => a - b) })
}
/** tabs：旧签名 (spec, 活动页下标)。 */
export function tabsFillText(spec: unknown, active: number): string {
  return callFill('tabs', spec, { active })
}
/** piano：旧签名 (spec, 弹过的音名数组)。 */
export function pianoFillText(spec: unknown, played: readonly string[]): string {
  return callFill('piano', spec, { played })
}

function callFill(kind: string, spec: unknown, state: IuState): string {
  const mod = iuKindOf(kind)
  if (mod === undefined || typeof spec !== 'object' || spec === null) return ''
  // spec 已是宽松对象；fillText 内部只读它认的字段，缺字段自有兜底。
  return mod.fillText(spec as never, state as never)
}

/**
 * 卡片动作按钮：只剩**全屏**。
 *
 * 缩放档位（100% / 115% … / 180% 那枚循环按钮）已按用户要求整块移除：
 * 卡片就是正文的一部分，字号本该跟随官方「设置 → 字号」走（--iu-text-scale
 * 那条轴），再挂一个自成一档的百分比按钮，等于在正文里宣告「这是一块可被
 * 查看器管理的组件」。全屏保留——看板 / 大表格在对话流宽度里铺不开，是刚需。
 */
function CardActions({ onFullscreen }: {
  readonly onFullscreen: () => void
}): JSX.Element {
  return (
    <span className="dtt-iu__acts">
      <button
        type="button"
        className="dtt-iu__act"
        title="全屏"
        aria-label="全屏查看"
        onClick={onFullscreen}
      >
        <ExpandIcon />
      </button>
    </span>
  )
}

/**
 * 卡头：标题 + 右侧动作（只剩全屏）。
 *
 * kind 类型角标（"表格" / "清单" 那枚小胶囊）已按要求移除——卡片只挑最必要的
 * 信息显示，右上角不再挂类型标签。注册表里的 label 字段保留（对外契约、注入
 * 文档与冒烟仍引用），只是不再渲染到卡头上。
 */
function Head({ title, actions }: {
  readonly title: string
  readonly actions?: JSX.Element | undefined
}): JSX.Element {
  return (
    <div className="dtt-iu__head">
      <span className="dtt-iu__title">{title}</span>
      {actions}
    </div>
  )
}

function pendingStage(bytes: number): JSX.Element {
  return (
    <div className="dtt-iu__stage--pending" aria-busy="true" aria-live="polite">
      {/* 等待态文案：**不暴露「卡片/生成/组件」这些机制词**。
          用户此刻看到的应该是「助手正在把这段内容铺开」，而不是「一块 UI 正在被构建」——
          后者是一台机器在干活的口吻，落在一段正在生长的正文里会把人从阅读里拽出来。 */}
      <div className="dtt-iu__pending">
        <span className="dtt-iu__pending-dot" />
        <span className="dtt-iu__pending-text">正在整理…</span>
      </div>
      <div className="dtt-iu__pending-track"><span className="dtt-iu__pending-bar" /></div>
      <span className="dtt-iu__pending-text">{bytes} 字</span>
    </div>
  )
}

/**
 * 卡片根节点：把「自身实测宽度」写进根节点，供 kinds 侧的 @container iu 与
 * data-iu-w 分档消费。
 *
 * ⚠ 量的是**这张卡自己**的宽度，不是浏览器视口：卡片宽度由对话流决定（侧栏
 * 折叠、窗口缩放、全屏进出都会变），媒体查询量视口会漏掉这些变化。全屏层是
 * createPortal 到 body 的独立实例，所以每个根节点各自挂一份 observer，不能
 * 由内嵌卡代测。
 *
 * 照 section.tsx 的范式：读数去抖、只在结果翻转时动 DOM、卸载清理。去抖取
 * 120ms（约 8 帧）——比设置页三栏切换短，因为这里不搬动整列内容，只更新一个
 * 变量和一个档位属性；既滤掉拖拽侧栏时的连续抖动，又不让人看出延迟。
 * ⚠ 宽度/档位切换**不加 transition**：布局属性连续改会触发布局重算，容器查询
 * 的切换应当是即时确定的。
 */
function IuRoot({ className, children }: {
  readonly className: string
  readonly children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    let timer: number | undefined
    let lastW = -1
    const apply = (): void => {
      const w = Math.round(el.getBoundingClientRect().width)
      // 实测宽只在变化时写：去抖后仍可能重复报到同一宽度，无脑 setProperty
      // 会让每次回调都碰一次 inline style。
      if (w !== lastW) {
        lastW = w
        el.style.setProperty('--iu-card-w', `${w}px`)
      }
      // 档位只在跨阈值时改（<520 / 520–860 / >860），同样避免无谓的 DOM 写入。
      const next = w < 520 ? 'narrow' : w <= 860 ? 'mid' : 'wide'
      if (el.dataset.iuW !== next) el.dataset.iuW = next
    }
    apply()
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => { timer = undefined; apply() }, 120)
    })
    observer.observe(el)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [])
  return <figure ref={ref} className={className}>{children}</figure>
}

/** 持久化写入的节流窗口（拖动滑块会高频 setState，逐次写会拖慢主线程）。 */
const PERSIST_DEBOUNCE = 400

/** 全屏灯箱退场时长（ms），必须与样式表 dtt-iu-fs-out 的 .26s 一致。 */
const FS_EXIT_MS = 260

/**
 * iu 原生交互卡片外壳。
 *
 * pending 只在流式期出现（半截 JSON 不渲染）；非法 spec 由 parse 层挡掉，
 * 这里收到的一定是合法结构。未知 kind（registry/bodies 查不到）→ 不渲染，
 * 与老实现「不认识就交给 markdown」语义一致（那种围栏根本到不了这里）。
 */
export const IuCard = memo(function IuCard({ spec, pending = false, bytes = 0, onFill }: {
  readonly spec?: IuSpecBase | undefined
  readonly pending?: boolean
  readonly bytes?: number
  readonly onFill?: IuFillFn | undefined
}): JSX.Element | null {
  if (pending || spec === undefined) {
    return (
      <IuRoot className="dtt-iu dtt-iu--pending">
        {pendingStage(bytes)}
      </IuRoot>
    )
  }
  // hooks 必须在任何提前 return 之后仍保持稳定调用——但 pending 分支不触发任何
  // hook（它在 hooks 之前 return）。为遵守 hooks 规则，把真正的有状态渲染拆到
  // 子组件 IuCardLive：pending 走无 hook 的静态分支，定稿走 IuCardLive。
  return <IuCardLive spec={spec} onFill={onFill} />
})

/**
 * 定稿卡片的有状态渲染（拆出来是为了让 pending 分支不触发 hooks）。
 *
 * 持久化 key = 围栏内容（spec）的稳定哈希：内容一样就是同一张卡（跨刷新、
 * 跨重渲染恢复状态），内容变了就是新卡（不会把旧状态错套到新数据上）。
 */
function IuCardLive({ spec, onFill }: {
  readonly spec: IuSpecBase
  readonly onFill?: IuFillFn | undefined
}): JSX.Element | null {
  const mod = useMemo(() => iuKindOf(spec.kind), [spec.kind])
  const bodyMod = useMemo(() => IU_BODIES.get(spec.kind), [spec.kind])
  // spec 是 parse 产出的纯数据对象，JSON.stringify 顺序稳定 → 哈希稳定。
  const stateKey = useMemo(() => iuStateKey(JSON.stringify(spec)), [spec])

  const [state, setStateRaw] = useState<IuState>(() => {
    if (mod === undefined) return {}
    const base = mod.initState(spec as never) as IuState
    // 合并持久化状态：以 base 为底，覆盖上存过的字段（脏字段由各 kind 的
    // Body/fillText 自行容错；这里只做浅合并，不深校验）。
    const stored = readIuState(stateKey)
    return stored === undefined ? base : { ...base, ...stored }
  })

  // stateKey 变化（同一位置内容被替换）→ 重新初始化，别把旧卡状态留给新卡。
  const prevKey = useRef(stateKey)
  useEffect(() => {
    if (prevKey.current === stateKey) return
    prevKey.current = stateKey
    if (mod === undefined) return
    const base = mod.initState(spec as never) as IuState
    const stored = readIuState(stateKey)
    setStateRaw(stored === undefined ? base : { ...base, ...stored })
  }, [stateKey, mod, spec])

  // 持久化：跟随 state 变化，节流写（卸载时 flush 掉最后一笔）。
  const timerRef = useRef<number | null>(null)
  const latestRef = useRef(state)
  latestRef.current = state
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      writeIuState(stateKey, latestRef.current)
    }, PERSIST_DEBOUNCE)
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
        writeIuState(stateKey, latestRef.current)
      }
    }
  }, [state, stateKey])

  const setState = useCallback((patch: Partial<IuState> | ((prev: IuState) => Partial<IuState>)): void => {
    setStateRaw((prev) => {
      const p = typeof patch === 'function' ? patch(prev) : patch
      return { ...prev, ...p }
    })
  }, [])

  /*
   * 全屏是唯一剩下的卡片动作（缩放档位已整块移除，理由见 CardActions 注释）。
   *
   * ⚠ 全屏**不持久化**（曾经持久化过，是个 bug）：全屏态会给 body 挂
   * `overflow:hidden`，若刷新后自动恢复成全屏，用户会看到「整页滚不动」——
   * 而且他并不知道是自己上次开了全屏。全屏是「当下这一眼」的临时状态，
   * 每次进页面都从关闭开始。
   */
  const [fullscreen, setFullscreen] = useState(false)

  const enterFullscreen = useCallback((): void => { setFullscreen(true) }, [])
  const exitFullscreen = useCallback((): void => { setFullscreen(false) }, [])

  /*
   * 灯箱退场状态机：先播 260ms 淡出 + 缩回，再真正卸掉全屏层。
   *
   * 入场是 .26s 的 dtt-iu-fs-in（淡入 + scale .99 → 1），但退场原先是直接
   * setFullscreen(false) —— 全屏层瞬间从 DOM 消失，和入场不对等，读起来像被
   * 掐断。这里补一条同长的 dtt-iu-fs-out（淡出 + scale 1 → .97），播完再卸载。
   * 期间 body 滚动锁仍由 fullscreen 的 effect 持有，到点才释放，不会中途闪一下。
   */
  const [fsClosing, setFsClosing] = useState(false)
  const fsCloseTimerRef = useRef<number | null>(null)
  const requestExitFullscreen = useCallback((): void => {
    // 已在退场中：忽略重复请求（连点关闭 / Esc 连按）。
    if (fsCloseTimerRef.current !== null) return
    setFsClosing(true)
    fsCloseTimerRef.current = window.setTimeout(() => {
      fsCloseTimerRef.current = null
      setFsClosing(false)
      exitFullscreen()
    }, FS_EXIT_MS)
  }, [exitFullscreen])

  // 卸载时掐掉未完成的定时器，否则回调会打到已卸载的组件上。
  useEffect(() => () => {
    if (fsCloseTimerRef.current !== null) window.clearTimeout(fsCloseTimerRef.current)
  }, [])

  /*
   * 全屏时锁背景滚动，Esc 退出。
   *
   * 用共用的引用计数锁（shared/scroll-lock.ts）：多张卡片同时开全屏时，
   * 先关的那个不会把后开的那个的锁一起放开。锁的释放由 lockBodyScroll 返回的
   * 释放函数负责，**无论组件怎么卸载都会被 effect cleanup 调到**。
   */
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (event: KeyboardEvent): void => {
      // Esc 与关闭按钮走同一条退场链路，保证两条入口的动画一致。
      if (event.key === 'Escape') requestExitFullscreen()
    }
    const release = lockBodyScroll()
    document.addEventListener('keydown', onKey)
    return () => {
      release()
      document.removeEventListener('keydown', onKey)
    }
  }, [fullscreen, requestExitFullscreen])

  if (mod === undefined || bodyMod === undefined) return null
  const Body = bodyMod.Body
  const bodyNode = (
    <Body spec={spec as never} state={state} setState={setState} onFill={onFill} />
  )
  return (
    <>
      <IuRoot className="dtt-iu">
        <Head
          title={spec.title}
          actions={<CardActions onFullscreen={enterFullscreen} />}
        />
        {bodyNode}
      </IuRoot>
      {fullscreen && typeof document !== 'undefined' && createPortal(
        <div
          className="dtt-iu-fs"
          data-closing={fsClosing ? '1' : undefined}
          role="dialog"
          aria-modal="true"
          aria-label={spec.title}
        >
          <div className="dtt-iu-fs__bar">
            <span className="dtt-iu-fs__title">{spec.title}</span>
            <span className="dtt-iu-fs__acts">
              <button
                type="button"
                className="dtt-iu-fs__btn"
                title="关闭（Esc）"
                onClick={requestExitFullscreen}
              >
                关闭
              </button>
            </span>
          </div>
          <div className="dtt-iu-fs__stage">
            {/* 全屏里再渲染一份卡片：与内嵌卡共享 state，改一边两边同步。 */}
            <IuRoot className="dtt-iu dtt-iu--fs">
              <Head title={spec.title} />
              {bodyNode}
            </IuRoot>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
