/**
 * Personal Agent — 应用外壳与挂载入口。
 *
 * Bot 模式下渲染一个覆盖整个 DSH Web 视口的全屏应用；Work 模式保持官方界面。
 * 组件按区域拆分：Sidebar（shell/）、ChatPanel（chat/）、RightPanel（shell/）、
 * CallOverlay（call/）、JournalOverlay（journal/）。
 */
import { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setUiMode } from '../mode-switch/index.ts'
import { PersonalProvider, usePersonal } from './store.tsx'
import { injectPersonalBaseStyles } from './base.css.ts'
import { Sidebar } from './shell/Sidebar.tsx'
import { RightPanel } from './shell/RightPanel.tsx'
import { NewBotModal } from './shell/NewBotModal.tsx'
import { GroupSettings } from './shell/GroupSettings.tsx'
import { ChatPanel } from './chat/ChatPanel.tsx'
import { CallOverlay } from './call/CallOverlay.tsx'
import { JournalOverlay } from './journal/JournalOverlay.tsx'
import { injectShellStyles } from './shell/shell.css.ts'
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

/** 跟随 DSH 主题变化（属性变更 + 系统配色变更）。 */
function useDetectedTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => detectTheme())
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
      data-call-minimized={ui.call.status !== 'idle' && ui.call.minimized ? 'true' : 'false'}
    >
      <Sidebar onExitWork={exitToWork} />
      <div className="pa-app-shell">
        <main className="pa-main-col">
          <ChatPanel />
        </main>
        {ui.rightPanelOpen ? <RightPanel /> : null}
      </div>
      <NewBotModal />
      <GroupSettings />
      <JournalOverlay />
      <CallOverlay />
      {ui.toast !== null ? <div className="pa-toast">{ui.toast}</div> : null}
      {!ui.rightPanelOpen ? (
        <button
          className="pa-right-reopen"
          type="button"
          title="展开详情"
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
  injectChatStyles()
  injectCallStyles()
  injectJournalStyles()

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
