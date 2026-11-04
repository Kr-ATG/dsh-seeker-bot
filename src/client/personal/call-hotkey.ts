/**
 * 语音通话全局快捷键：一个组合键切换「开始通话 / 挂断」。
 *
 * 三条触发通道，最终都汇到同一个 fire()（350ms 去重，防止同时命中两次）：
 *  1. 页面内 keydown（Web 模式 / 焦点在内容 iframe 时）；
 *  2. 壳子 topbar 转发来的 dsh:hotkey-down（窗口级：焦点在标题栏时）；
 *  3. 壳子主进程 globalShortcut 命中后推来的 dsh:call-hotkey（OS 级：窗口没焦点、
 *     人在别的软件里按也能触发）。
 *
 * 监听挂在常驻 DOM 的 PersonalApp 上——Work 模式下 .pa-root 只是被 CSS 隐藏，
 * React 树仍活着，所以热键在 Work 里照样能拨通主 Bot。
 * 组合键偏好见 ../../call-hotkey/pref.ts（设置页与这里共用一份）。
 */
import { useEffect, useRef } from 'react'
import { currentUiMode, setUiMode } from '../mode-switch/index.ts'
import { usePersonal } from './store.tsx'
import type { Bot } from './types.ts'
import {
  CALL_HOTKEY_FIRE_EVENT, hasModifier, hotkeyMatches, syncCallHotkeyToShell, useCallHotkey,
} from '../call-hotkey/pref.ts'

/** 当前是不是 Work 模式：body 属性是 CSS 的唯一判据，模块状态只作兜底。 */
function isWorkMode(): boolean {
  try {
    const attr = document.body.getAttribute('data-skb-mode')
    return (attr ?? currentUiMode()) !== 'bot'
  } catch {
    return currentUiMode() !== 'bot'
  }
}

/** 只接顶层壳页的消息：iframe 里的沙箱卡片也会 postMessage，不能让它们拨电话。 */
function fromShell(event: MessageEvent): boolean {
  try {
    return event.source === window.top || event.source === window.parent
  } catch {
    return false
  }
}

/**
 * 目标 Bot：
 *  · Work 模式 → 主 Bot，并切到 Bot 模式（通话浮层挂在 .pa-root 上，Work 下
 *    整棵 .pa-root 被 display:none，不切模式通话界面根本不可见）；顺手把选中
 *    的会话也切到主 Bot，挂断后看到的就是这通电话的对话流。
 *  · Bot 模式私聊 → 当前选中的那个 Bot（「在哪个 bot 界面就通话哪个」）。
 *  · Bot 模式群聊 → 群成员里的主 Bot，退而求其次取第一个成员 / 当前 Bot，
 *    与 ChatPanel 呼叫按钮的 callBotId 同一套口径。
 */
export function useCallHotkeyToggle(): void {
  const ctx = usePersonal()
  const hotkey = useCallHotkey()
  const latest = useRef({ ctx, hotkey })
  latest.current = { ctx, hotkey }

  useEffect(() => {
    /* 启动同步：壳子主进程默认注册 Alt+V，用户改过键要在这里纠正过来。 */
    syncCallHotkeyToShell(latest.current.hotkey)

    let lastFire = 0
    const fire = (): void => {
      const now = Date.now()
      if (now - lastFire < 350) return
      lastFire = now
      const cur = latest.current.ctx

      /* 项目统一判据：status !== 'idle' 就是通话中（'ended' 只进通话记录）。 */
      if (cur.ui.call.status !== 'idle') {
        cur.actions.endCall()
        return
      }

      let botId: string
      if (isWorkMode()) {
        const main = cur.state.bots.find((bot) => bot.isMain) ?? cur.state.bots[0]
        if (main === undefined) return
        botId = main.id
        cur.actions.selectBot(botId)
        setUiMode('bot')
      } else {
        const room = cur.ui.selectedRoomId !== null
          ? cur.state.rooms.find((item) => item.id === cur.ui.selectedRoomId)
          : undefined
        if (room !== undefined) {
          const members: Bot[] = []
          for (const id of room.memberIds) {
            const found = cur.state.bots.find((bot) => bot.id === id)
            if (found !== undefined) members.push(found)
          }
          botId = (members.find((bot) => bot.isMain) ?? members[0] ?? cur.activeBot).id
        } else {
          botId = cur.activeBot.id
        }
      }
      cur.actions.startCall(botId)
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const hk = latest.current.hotkey
      if (e.repeat || e.defaultPrevented) return
      if (!hotkeyMatches(e, hk)) return
      /*
       * 双保险：合法热键必带修饰键；将来若放开单键，输入框内一律不响应，
       * 免得打字打到一半把通话拨出去。
       */
      const target = e.target as HTMLElement | null
      const editing = target !== null && (
        target.isContentEditable === true
        || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
      )
      if (editing && !hasModifier(hk)) return
      e.preventDefault()
      e.stopPropagation()
      fire()
    }

    const onMessage = (event: MessageEvent): void => {
      if (!fromShell(event)) return
      const data = event.data as Record<string, unknown> | null
      if (data === null || typeof data !== 'object') return
      /* OS 级：主进程已经按 accelerator 匹配过，直接触发。 */
      if (data.type === 'dsh:call-hotkey') { fire(); return }
      /* 窗口级：topbar 把原始按键转过来，这里用同一份偏好匹配。 */
      if (data.type === 'dsh:hotkey-down' && typeof data.key === 'string') {
          const gesture = {
          key: data.key,
          ctrlKey: data.ctrl === true, altKey: data.alt === true,
          shiftKey: data.shift === true, metaKey: data.meta === true,
        } as KeyboardEvent
        if (hotkeyMatches(gesture, latest.current.hotkey)) fire()
      }
    }

    /* 官方 ctx.shortcuts 命令命中（resolve() 派发）——第四路，仍汇到同一个 fire()。 */
    const onFire = (): void => { fire() }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('message', onMessage)
    window.addEventListener(CALL_HOTKEY_FIRE_EVENT, onFire)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('message', onMessage)
      window.removeEventListener(CALL_HOTKEY_FIRE_EVENT, onFire)
    }
  }, [])
}