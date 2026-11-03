/**
 * Personal Agent — 应用外壳与挂载入口。
 *
 * Bot 模式下渲染一个覆盖整个 DSH Web 视口的全屏应用；Work 模式保持官方界面。
 * 组件按区域拆分：Sidebar（shell/）、ChatPanel（chat/）、RightPanel（shell/）、
 * CallOverlay（call/）、JournalOverlay（journal/）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { setUiMode } from '../mode-switch/index.ts'
import { ensureOverlayMotionStyles } from '../motion/overlay-motion.ts'
import { PersonalProvider, usePersonal } from './store.tsx'
import { injectPersonalBaseStyles } from './base.css.ts'
import { injectIuStyles } from '../iu/styles.ts'
import { injectHtmlEmbedStyles } from '../html-embed/styles.ts'
import { Sidebar } from './shell/Sidebar.tsx'
import { RightPanel } from './shell/RightPanel.tsx'
import { installWorkSidebarWidthSync, readWorkSidebarWidth } from './shell/work-sidebar-width.ts'
import { NewBotModal } from './shell/NewBotModal.tsx'
import { GroupSettings } from './shell/GroupSettings.tsx'
import { BotSettingsCard } from './shell/BotSettingsCard.tsx'
import { TaskDetailModal } from './shell/TaskDetailModal.tsx'
import { ChatPanel } from './chat/ChatPanel.tsx'
import { CallOverlay } from './call/CallOverlay.tsx'
import { JournalOverlay } from './journal/JournalOverlay.tsx'
import { injectShellStyles } from './shell/shell.css.ts'
import { injectOutputsStyles } from './shell/outputs.css.ts'
import { injectSettingsStyles } from './shell/settings.css.ts'
import { injectTaskStyles } from './shell/tasks.css.ts'
import { injectChatStyles } from './chat/chat.css.ts'
import { injectCallStyles } from './call/call.css.ts'
import { injectJournalStyles } from './journal/journal.css.ts'

export interface PersonalAppProps {
  /** 强制 Bot 模式（独立演示页使用）。 */
  forceMode?: boolean
  onExitWork?: () => void
}

/**
 * 注意：这里不再用 useBodyMode() 参与显隐判断。
 *
 * 2026-11-03 起 PersonalApp 常驻 DOM，Work / Bot 的显示切换完全由 CSS 的
 * body[data-skb-mode] 属性选择器完成（见 base.css.ts 顶部）。React 状态只在
 * 主题、侧栏宽度这类不影响首帧显隐的地方使用 —— 若把显隐挂在 React state 上，
 * 切换又要等一次 MutationObserver → setState，空白帧会回来。
 */

/** 读 DSH / 系统当前主题：优先 DSH 的 body/html 属性，其次系统配色。 */
function detectTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark'
  const html = document.documentElement
  const body = document.body
  if (html.hasAttribute('data-ds-dark-theme') || body.hasAttribute('data-ds-dark-theme')) return 'dark'
  const declared = body.getAttribute('data-theme') ?? html.getAttribute('data-theme')
  if (declared === 'dark' || declared === 'light') return declared
  if (html.classList.contains('dark') || body.classList.contains('dark')) return 'dark'
  if (html.classList.contains('light') || body.classList.contains('light')) return 'light'
  // DSH 的浅色主题不带任何属性（只移除 data-ds-dark-theme），所以读 body 的
  // 实际底色来判断；比 prefers-color-scheme 更可靠（DSH 的“跟随系统”已由宿主解析）。
  try {
    const color = window.getComputedStyle(body).backgroundColor
    const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(color)
    if (match !== null) {
      const alpha = match[4] === undefined ? 1 : Number(match[4])
      if (alpha > 0.2) {
        const r = Number(match[1])
        const g = Number(match[2])
        const b = Number(match[3])
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        return luminance > 0.55 ? 'light' : 'dark'
      }
    }
  } catch {
    /* 计算样式不可用 */
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

/**
 * 是否运行在 dsh-shell 的 Electron iframe 里。
 *
 * 壳子的 topbar 有一块 320×44 的 `-webkit-app-region: drag` 拖拽区覆盖在
 * 页面顶部（见 dsh-shell 的 topbar.html），落在里面的点击会被窗口拖拽吃掉。
 *
 * 品牌行右侧的收起按钮（x244 y22 28×28）上半截正落在这块热区里。**不再靠
 * 加高顶部栏来躲它**——那会让 Bot 侧栏的品牌行比 Work 模式低一大截（用户实测
 * 多出一条空隙）。现在布局与浏览器里完全一致，只由 CSS 给按钮向下补一块透明
 * 热区（y44 以下可点），视觉零差异。
 */
function isEmbeddedShell(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.top !== window.self && /Electron/i.test(navigator.userAgent)
  } catch {
    return false
  }
}

/** 跟随 DSH 主题变化（属性变更 + 系统配色变更）。 */
function useDetectedTheme(): 'dark' | 'light' {  const [theme, setTheme] = useState<'dark' | 'light'>(() => detectTheme())
  useEffect(() => {
    if (typeof document === 'undefined') return
    const sync = (): void => setTheme((prev) => {
      const next = detectTheme()
      return prev === next ? prev : next
    })
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'data-theme', 'class'],
    })
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'data-theme', 'class'],
    })
    let media: MediaQueryList | null = null
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
      media.addEventListener('change', sync)
    } catch {
      /* 旧浏览器不支持 matchMedia 监听 */
    }
    sync()
    return () => {
      observer.disconnect()
      media?.removeEventListener('change', sync)
    }
  }, [])
  return theme
}

/**
 * 提示卡（toast）：store 到点会把 ui.toast 直接置 null，这里在组件内部补一段
 * 240ms 退场——文案先留着播完动画，再真正从 DOM 摘掉。store 的 linger 计时
 * 逻辑不动（它只决定「什么时候该消失」，动画归这里）。
 */
function ToastCard({ text }: { text: string | null }): JSX.Element | null {
  const [shown, setShown] = useState<string | null>(text)
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  const shownRef = useRef<string | null>(text)

  useEffect(() => {
    if (text !== null) {
      // 新提示（含替换上一条）：撤掉退场，立刻换成新文案。
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      setClosing(false)
      shownRef.current = text
      setShown(text)
      return
    }
    if (shownRef.current === null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      shownRef.current = null
      setClosing(false)
      setShown(null)
    }, 240)
  }, [text])

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  /*
   * 渲染时直接用最新的 text 兜底：新 toast 不必等 effect 跑完才出现（少一帧延迟）。
   * 退场时 text 已经变 null，靠 shown 留住旧文案播完动画。
   */
  const content = text ?? shown
  if (content === null) return null
  return (
    // key 跟着文案走：连续两条 toast 会重新挂载，入场动画重新播一次。
    <div
      className="pa-toast"
      key={content}
      data-closing={closing && text === null ? '1' : undefined}
    >
      {content}
    </div>
  )
}

export function PersonalApp({ forceMode = false, onExitWork }: PersonalAppProps): JSX.Element {
  const { state, ui, actions } = usePersonal()
  const detectedTheme = useDetectedTheme()
  const theme = state.settings.theme === 'auto' ? detectedTheme : state.settings.theme

  /*
   * Bot 侧栏宽度跟随 Work 模式官方侧栏（用户 2026-11-02 要求「两个模式保持一致」）。
   *
   * 值来自官方侧栏根的 inline width —— Bot 模式下那条 inline 仍是用户在 Work
   * 拖出来的 px（我们的 300px 锁定只改 computed 宽度，不改 inline），所以切过来
   * 时能拿到真实拖拽值。读不到就保持 null，CSS 回退官方默认的 280px。
   */
  /*
   * 宽度直接写 pa-root 的 CSS 变量，不再走 React state。
   *
   * 为什么不 setState：PersonalApp 现在常驻 DOM，Work 模式也活着；若每次官方
   * 侧栏拖拽都 setState，会以每帧一次的频率重渲染整棵（隐藏中的）Bot 树，
   * Work 模式拖侧栏会被拖慢。这里只在首帧读一次做初始值，之后用同步链直接
   * 改 style 属性 —— 对 DOM 是一次属性写入，零 React 渲染。
   */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const initialSidebarWidth = useState(() => readWorkSidebarWidth())[0]
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null || initialSidebarWidth === null) return
    el.style.setProperty('--pa-sidebar-w', `${initialSidebarWidth}px`)
  }, [initialSidebarWidth])
  useEffect(() => {
    return installWorkSidebarWidthSync((px) => {
      const el = rootRef.current
      if (el === null) return
      if (px === null) el.style.removeProperty('--pa-sidebar-w')
      else el.style.setProperty('--pa-sidebar-w', `${px}px`)
    })
  }, [])

  /*
   * 常驻 DOM（2026-11-03 用户要求「Work 与 Bot 切换不要出现一闪」）。
   *
   * 旧实现在 Work 模式 return null，切换要走「MutationObserver → setState →
   * React 重新挂载整棵 PersonalApp」——实测点击 Bot 后约有 3~4 帧（60~100ms）
   * 侧栏只剩官方空壳（品牌行已被 mode-switch 隐藏、Bot 侧栏还没挂出来），
   * 看起来就是左侧整块闪一下白。
   *
   * 现在 React 树始终挂载，Work / Bot 的显隐完全交给 CSS 的 body[data-skb-mode]
   * 属性选择器（见 base.css.ts 顶部的 .pa-root 规则）：点下去 body 属性同步
   * 变化，同一帧内对应界面就位，不经过 React 渲染，所以没有空白帧。
   * forceMode（独立演示页）不受 body 模式影响，用 data-force-mode 豁免。
   */
  const exitToWork = onExitWork ?? ((): void => {
    setUiMode('work')
    document.body.setAttribute('data-skb-mode', 'work')
    window.dispatchEvent(new Event('skb:mode'))
  })

  return (
    <div
      ref={rootRef}
      className="pa-root"
      data-mode="bot"
      data-force-mode={forceMode ? 'true' : 'false'}
      data-pa-theme={theme}
      data-shell-embed={isEmbeddedShell() ? 'true' : 'false'}
      data-call-minimized={ui.call.status !== 'idle' && ui.call.minimized ? 'true' : 'false'}
    >
      <Sidebar onExitWork={exitToWork} />
      {/*
       * 右栏宽度走 CSS 变量：拖拽时 RightPanel 直接改这个变量（不触发 React
       * 重渲染），松手才写回 store；窄屏由 shell.css.ts 的媒体查询接管。
       */}
      <div className="pa-app-shell" style={{ '--pa-right-w': `${ui.rightPanelWidth}px` } as CSSProperties}>
        {/*
         * 主列**不加页面转场**（2026-11-04 按用户要求移除）。
         *
         * 曾经挂过 PAGE_MOTION_IN / PAGE_MOTION_SLIDE，但 .pa-root 在 Work 模式下是
         * display:none，切回 Bot 时子树动画从头播 —— 主列铺满视口，任何入场（哪怕
         * 只是位移）都会让「切模式」多出一段本不该有的过程，用户看到的就是「闪一下」。
         *
         * 整层替换（Work ⇄ Bot）本来就该是瞬时的：两套界面同色同布局，硬切没有
         * 突兀感，反而加动效才突兀。页面转场留给真正的「页内视图切换」
         * （工作台各页、右栏面板、记忆/画廊/系统提示词页内切换）。
         *
         * 同理也不能给主列加 key 重播：换 Bot / 换群聊只换内容，Composer 的草稿
         * 存在组件本地 state，重挂载会把没发出去的字丢掉。
         */}
        <main
          className="pa-main-col"
          style={{ '--pa-chat-w': ui.chatWidth > 0 ? `${ui.chatWidth}px` : '100%' } as CSSProperties}
        >
          <ChatPanel />
        </main>
        {ui.rightPanelOpen ? <RightPanel /> : null}
      </div>
      <NewBotModal />
      <GroupSettings />
      <BotSettingsCard />
      <TaskDetailModal />
      <JournalOverlay />
      <CallOverlay />
      <ToastCard text={ui.toast} />
      {!ui.rightPanelOpen ? (
        <button
          className="pa-right-reopen"
          type="button"
          title="展开右栏"
          onClick={() => actions.toggleRightPanel(true)}
        >
          <span />
        </button>
      ) : null}
    </div>
  )
}

/* ───────────────────────────── DSH 挂载 ───────────────────────────── */

const ROOT_ID = 'skb-personal-agent-root'
const CONTROLLER_KEY = '__dshSeekerPersonalAgentV1__'

interface Mounted {
  root: Root
  host: HTMLElement
  dispose: () => void
}

/** 挂载 Personal Agent 应用（Bot 模式生效）。 */
export function applyPersonalAgent(_ctx?: unknown): void {
  if (typeof document === 'undefined') return
  /*
   * 全局动效样式（浮层 + 页面转场）由 client/index.ts 在 apply 期注入；
   * 这里再调一次是幂等的兜底：Bot 模式的页面转场属性就写在本文件与 shell/
   * 里，若哪天挂载顺序变了、或有人单独 import 这套组件，动画不能静默消失
   * （属性还在、样式没注入 = 页面完全不动，最难排查）。
   */
  ensureOverlayMotionStyles()
  injectPersonalBaseStyles()
  injectShellStyles()
  injectOutputsStyles()
  injectSettingsStyles()
  injectTaskStyles()
  injectChatStyles()
  injectCallStyles()
  injectJournalStyles()
  /*
   * 生成式 UI 的两套样式（```iu 原生卡片 / ```html 沙箱卡片）。
   *
   * 它们的 CSS 里对宿主主题变量（--dsw-* / --dsh-content-font-size）都写了
   * fallback，所以在 Bot 这套 --pa-* 主题下也能正常显示，只是颜色跟随默认值。
   * 后续如果要让卡片完全贴合 Bot 主题，在这里补一层变量映射即可。
   */
  injectIuStyles()
  injectHtmlEmbedStyles()

  const holder = globalThis as unknown as Record<string, unknown>
  const previous = holder[CONTROLLER_KEY] as Mounted | undefined
  if (previous !== undefined) {
    try { previous.dispose() } catch { /* 旧实例已失效 */ }
  }

  const stale = document.getElementById(ROOT_ID)
  if (stale !== null) stale.remove()

  const host = document.createElement('div')
  host.id = ROOT_ID
  host.setAttribute('data-skb-personal', 'true')
  document.body.appendChild(host)

  const root = createRoot(host)
  /*
   * Bot 模式下首帧必须同步渲染完（2026-11-03，配合「切换不要一闪」）。
   *
   * 页面启动时如果上次停在 Bot 模式，applyModeSwitch 会先把官方侧栏内容
   * 隐藏；而 createRoot().render() 默认是并发调度，React 树要等下一帧才
   * commit，这中间会出现一段只有空侧栏的空白帧（左侧品牌也没了）。用
   * flushSync 把首次 render 压进当前任务，第一帧就是完整 Bot 界面。
   * Work 模式同样同步渲染：PersonalApp 常驻但被 CSS 隐藏，代价只是启动时
   * 多渲染一次（比「用户首屏内点 Bot 时撞上未完成渲染」安全）。
   */
  const renderApp = (): void => {
    root.render(
      <PersonalProvider>
        <PersonalApp />
      </PersonalProvider>,
    )
  }
  try {
    flushSync(renderApp)
  } catch {
    // 极端环境（React 版本不支持 / 在渲染周期内调用）退回异步渲染：
    // 退化为旧行为，但不能因为首帧优化把整个 Personal Agent 挂死。
    renderApp()
  }

  const dispose = (): void => {
    try { root.unmount() } catch { /* 已卸载 */ }
    host.remove()
  }
  holder[CONTROLLER_KEY] = { root, host, dispose } satisfies Mounted
}

/** 卸载（测试 / 热更新用）。 */
export function unmountPersonalAgent(): void {
  const holder = globalThis as unknown as Record<string, unknown>
  const previous = holder[CONTROLLER_KEY] as Mounted | undefined
  if (previous !== undefined) {
    try { previous.dispose() } catch { /* ignore */ }
    delete holder[CONTROLLER_KEY]
  }
}
