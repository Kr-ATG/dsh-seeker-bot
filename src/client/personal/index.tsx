/**
 * Personal Agent — 应用外壳与挂载入口。
 *
 * Bot 模式下渲染一个覆盖整个 DSH Web 视口的全屏应用；Work 模式保持官方界面。
 * 组件按区域拆分：Sidebar（shell/）、ChatPanel（chat/）、RightPanel（shell/）、
 * CallOverlay（call/）、JournalOverlay（journal/）。
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setUiMode } from '../mode-switch/index.ts'
import { PersonalProvider, usePersonal } from './store.tsx'
import { injectPersonalBaseStyles } from './base.css.ts'
import { injectIuStyles } from '../iu/styles.ts'
import { injectHtmlEmbedStyles } from '../html-embed/styles.ts'
import { Sidebar } from './shell/Sidebar.tsx'
import { RightPanel } from './shell/RightPanel.tsx'
import { installWorkSidebarWidthSync } from './shell/work-sidebar-width.ts'
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

function useBodyMode(): 'work' | 'bot' {
  const [mode, setMode] = useState<'work' | 'bot'>(() => {
    if (typeof document === 'undefined') return 'work'
    return document.body.getAttribute('data-skb-mode') === 'bot' ? 'bot' : 'work'
  })
  useEffect(() => {
    if (typeof document === 'undefined') return
    const sync = (): void => {
      const next = document.body.getAttribute('data-skb-mode') === 'bot' ? 'bot' : 'work'
      setMode((prev) => (prev === next ? prev : next))
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-skb-mode'] })
    const handler = (): void => sync()
    window.addEventListener('skb:mode', handler)
    sync()
    return () => {
      observer.disconnect()
      window.removeEventListener('skb:mode', handler)
    }
  }, [])
  return mode
}

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

export function PersonalApp({ forceMode = false, onExitWork }: PersonalAppProps): JSX.Element | null {
  const mode = useBodyMode()
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
  const [workSidebarWidth, setWorkSidebarWidth] = useState<number | null>(null)
  /*
   * 依赖 mode：每次切进 Bot 都重新装一次。
   *
   * 官方侧栏的 inline width 只在用户拖拽那一刻变，切模式时读到的是当时的拖拽
   * 值；重装还能顺带重绑 React 在切模式时可能重建过的侧栏节点（旧节点上的
   * MutationObserver 会跟着失效）。
   */
  useEffect(() => {
    if (mode !== 'bot') return
    return installWorkSidebarWidthSync(setWorkSidebarWidth)
  }, [mode])

  if (!forceMode && mode !== 'bot') return null

  const exitToWork = onExitWork ?? ((): void => {
    setUiMode('work')
    document.body.setAttribute('data-skb-mode', 'work')
    window.dispatchEvent(new Event('skb:mode'))
  })

  return (
    <div
      className="pa-root"
      data-mode="bot"
      data-pa-theme={theme}
      data-shell-embed={isEmbeddedShell() ? 'true' : 'false'}
      data-call-minimized={ui.call.status !== 'idle' && ui.call.minimized ? 'true' : 'false'}
      style={
        workSidebarWidth === null
          ? undefined
          : ({ '--pa-sidebar-w': `${workSidebarWidth}px` } as CSSProperties)
      }
    >
      <Sidebar onExitWork={exitToWork} />
      {/*
       * 右栏宽度走 CSS 变量：拖拽时 RightPanel 直接改这个变量（不触发 React
       * 重渲染），松手才写回 store；窄屏由 shell.css.ts 的媒体查询接管。
       */}
      <div className="pa-app-shell" style={{ '--pa-right-w': `${ui.rightPanelWidth}px` } as CSSProperties}>
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
      {ui.toast !== null ? <div className="pa-toast">{ui.toast}</div> : null}
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
  root.render(
    <PersonalProvider>
      <PersonalApp />
    </PersonalProvider>,
  )

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
