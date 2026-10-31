/**
 * dsh-seeker-bot — 右栏 Bot 面板的连接层与挂载控制器。
 *
 * Bootstrap 参照 kr-chat-controller：
 *  · createRoot 一个**独立容器**（id 为 dsh-bot-panel-container），绝不与
 *    KrAgentPanel 共用 #dsh-kr-panel-container —— 同一容器重复 createRoot
 *    会让两棵 React 树互相覆盖；
 *  · ErrorBoundary 只包本面板，渲染崩溃不拖垮整页；
 *  · 只在 Bot 模式挂载；切回 Work 就 unmount + 移除容器（不是 display:none）。
 *
 * 面板挂载期间给 body 加 data-skb-panel="on"，配合样式隐藏 KR 大盘，保证右栏
 * 同一时刻只显示一套。
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ErrorBoundary } from '../error-boundary.tsx'
import { useSubagentCatalog } from '../kr-chat/subagent-catalog.ts'
import { useSubagentOutputs } from '../kr-chat/use-subagent-outputs.ts'
import { useSessionOutputs } from '../kr-chat/use-session-outputs.ts'
import { mergeOutputs, EMPTY_OUTPUTS } from '../kr-chat/outputs.ts'
import { latestChatSessionId, subscribeLatestChatSnapshot } from '../tool-summary/TurnProcessShadowView.tsx'
import { openSubagentSession } from '../kr-chat/subagent-catalog.ts'
import { tryOpenInSidebar } from '../open-preview.ts'
import { openWithDefaultApp } from '../open-default-app.ts'
import { workspaceCwdOf } from '../client-ctx.ts'
import { panelShouldMount } from './model.ts'
import { BotPanelView } from './panel-view.tsx'
import { getBotConsoleStore } from './store.ts'
import { injectBotStyles } from './styles.ts'

const PANEL_KEY = '__dshSeekerBotPanelHostV1__'
const CONTAINER_ID = 'dsh-bot-panel-container'

/** 当前会话 id 跟随官方会话身份（订阅快照 + 1s 低频兜底）。 */
function useLatestSessionId(): string | null {
  const [sessionId, setSessionId] = useState<string | null>(latestChatSessionId)
  useEffect(() => {
    const sync = (): void => {
      setSessionId((previous) => previous === latestChatSessionId ? previous : latestChatSessionId)
    }
    const unsubscribe = subscribeLatestChatSnapshot(sync)
    const timer = typeof window === 'undefined' ? 0 : window.setInterval(sync, 1000)
    sync()
    return () => {
      unsubscribe()
      if (timer !== 0) window.clearInterval(timer)
    }
  }, [])
  return sessionId
}

/** 取数连接层：数据口径与 KrSubagentsCard / KrOutputsCard 完全同源。 */
function BotPanelConnected(): ReactElement {
  const sessionId = useLatestSessionId()
  const catalog = useSubagentCatalog(sessionId)
  const subagentOutputs = useSubagentOutputs(catalog.rows)
  const persistedOutputs = useSessionOutputs(sessionId)
  const outputs = mergeOutputs(
    { items: persistedOutputs },
    { items: subagentOutputs },
  )
  const openSubagent = (row: (typeof catalog.rows)[number]): void => { openSubagentSession(row) }
  const openOutput = (item: (typeof outputs.items)[number]): void => {
    const owner = item.sessionId ?? sessionId
    if (tryOpenInSidebar(item.path, { sessionId: owner, cwd: workspaceCwdOf(owner) })) return
    void openWithDefaultApp(item.path)
  }
  return (
    <BotPanelView
      sessionId={sessionId}
      catalog={catalog}
      outputs={outputs.items.length > 0 ? outputs : EMPTY_OUTPUTS}
      onOpenSubagent={openSubagent}
      onOpenOutput={openOutput}
    />
  )
}

interface PanelHandle {
  token: number
  dispose: () => void
}

export function applyBotPanel(ctx?: unknown): void {
  void ctx
  if (typeof document === 'undefined') return
  injectBotStyles()
  const holder = globalThis as unknown as Record<string, unknown>
  const previous = holder[PANEL_KEY] as PanelHandle | undefined
  if (previous !== undefined && typeof previous.dispose === 'function') {
    try { previous.dispose() } catch { /* 旧实例已经停了 */ }
  }
  const token = typeof previous?.token === 'number' ? previous.token + 1 : 1
  const store = getBotConsoleStore()
  let root: Root | null = null
  let container: HTMLElement | null = null
  let disposed = false

  const teardown = (): void => {
    if (root !== null) {
      try { root.unmount() } catch { /* 根已经卸载 */ }
      root = null
    }
    if (container !== null) {
      try { container.remove() } catch { /* 已脱离文档 */ }
      container = null
    }
    const body = document.body
    if (body !== undefined && body !== null && body.getAttribute('data-skb-panel') === 'on') {
      body.removeAttribute('data-skb-panel')
    }
  }

  const sync = (): void => {
    if (disposed) return
    const mode = store.getSnapshot().mode
    if (!panelShouldMount(mode)) {
      teardown()
      return
    }
    const content = document.querySelector('[data-conversation-content]') as HTMLElement | null
    if (content === null) {
      teardown()
      return
    }
    if (container !== null && (!container.isConnected || container.parentElement !== content)) {
      if (root !== null) {
        try { root.unmount() } catch { /* 旧根已失效 */ }
        root = null
      }
      try { container.remove() } catch { /* 已脱离文档 */ }
      container = null
    }
    if (container === null) {
      container = document.createElement('div')
      container.id = CONTAINER_ID
      container.className = 'skb-bot-panel-host'
      content.appendChild(container)
    }
    if (root === null) {
      root = createRoot(container)
      root.render(
        <ErrorBoundary label="bot panel">
          <BotPanelConnected />
        </ErrorBoundary>,
      )
    }
    const body = document.body
    if (body !== undefined && body !== null && body.getAttribute('data-skb-panel') !== 'on') {
      body.setAttribute('data-skb-panel', 'on')
    }
  }

  const unsubscribe = store.subscribe(sync)
  const win = typeof window === 'undefined' ? undefined : window
  const timer = win === undefined ? 0 : win.setInterval(sync, 500)
  sync()

  holder[PANEL_KEY] = {
    token,
    dispose: () => {
      disposed = true
      unsubscribe()
      if (timer !== 0 && win !== undefined) win.clearInterval(timer)
      teardown()
    },
  }
}
