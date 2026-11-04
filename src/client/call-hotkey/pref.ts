/**
 * 语音通话快捷键：运行时偏好。
 *
 * 配置源**只有官方 ctx.shortcuts 的命令绑定**（见 index.ts 的 catalog 订阅），
 * 这里不做 localStorage、不画设置行——用户在「设置 → 通用 → 快捷键」里改键，
 * 官方负责冲突检测 / 持久化 / 跨设备 profile，本模块只负责：
 *  · 物理码 NormalizedBinding ↔ 组合键 CallHotkey ↔ Electron accelerator 的转换；
 *  · 把当前绑定广播给三条触发通道，并同步给桌面壳的 OS 级 globalShortcut。
 */
import { useEffect, useState } from 'react'

export interface CallHotkey {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/**
 * 默认 Ctrl+Alt+V。
 * 为什么不用 Alt+V：官方 web 快捷键规则里单 alt + 字母是 unsupported-browser，
 * 注册不进官方命令；含 control 的双修饰组合才被 isWebBindingAllowed 放行。
 */
export const DEFAULT_CALL_HOTKEY: CallHotkey = {
  key: 'v', ctrl: true, alt: true, shift: false, meta: false,
}

/** 官方命令命中后 resolve() 派发的事件名（apply 层与 React hook 共用）。 */
export const CALL_HOTKEY_FIRE_EVENT = 'dsh:call-hotkey-fire'
const CHANGE_EVENT = 'dsh-seeker-bot:call-hotkey-change'

let current: CallHotkey = DEFAULT_CALL_HOTKEY

export function getCurrentHotkey(): CallHotkey { return current }

/** catalog 变化（或启动时）调用：广播给三路监听 + 同步壳子 OS 级热键。 */
export function setCurrentHotkey(h: CallHotkey): void {
  current = h
  try { window.dispatchEvent(new CustomEvent<CallHotkey>(CHANGE_EVENT, { detail: h })) } catch { /* 无 window */ }
  syncCallHotkeyToShell(h)
}

/** 官方 NormalizedBinding（物理码）→ 我们的组合键；认不出的码返回 null。 */
export function fromNormalizedBinding(binding: { code: string; modifiers: readonly string[] }): CallHotkey | null {
  const code = binding.code
  let key: string
  if (/^Key[A-Z]$/u.test(code)) key = code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/u.test(code)) key = code.slice(5)
  else if (/^F([1-9]|1[0-2])$/u.test(code)) key = code
  else if (code === 'Comma') key = ','
  else if (code === 'Period') key = '.'
  else if (code === 'Slash') key = '/'
  else if (code === 'Backslash') key = '\\'
  else if (code === 'Backquote') key = '`'
  else return null
  const mods = new Set(binding.modifiers)
  const h: CallHotkey = {
    key,
    ctrl: mods.has('control'), alt: mods.has('alt'),
    shift: mods.has('shift'), meta: mods.has('meta'),
  }
  return hasModifier(h) ? h : null
}

export function hasModifier(h: CallHotkey): boolean {
  return h.ctrl || h.alt || h.shift || h.meta
}

/** 从一次按键事件里抽出组合键；只按修饰键 / 拿不到 key 时返回 null。 */
export function hotkeyFromEvent(e: KeyboardEvent): CallHotkey | null {
  if (e.key === '' || e.key === undefined) return null
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return null
  return {
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
    ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey,
  }
}

export function hotkeyMatches(e: KeyboardEvent, h: CallHotkey): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  return key === h.key
    && e.ctrlKey === h.ctrl && e.altKey === h.alt
    && e.shiftKey === h.shift && e.metaKey === h.meta
}

/** 展示用：'Ctrl + Alt + V'。 */
export function formatHotkey(h: CallHotkey): string {
  const parts: string[] = []
  if (h.ctrl) parts.push('Ctrl')
  if (h.alt) parts.push('Alt')
  if (h.shift) parts.push('Shift')
  if (h.meta) parts.push('Win')
  parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key)
  return parts.join(' + ')
}

/** 转成 Electron globalShortcut 的 accelerator：'Ctrl+Alt+V' / 'Ctrl+Shift+F8'。 */
export function toAccelerator(h: CallHotkey): string {
  const parts: string[] = []
  if (h.ctrl) parts.push('Ctrl')
  if (h.alt) parts.push('Alt')
  if (h.shift) parts.push('Shift')
  if (h.meta) parts.push('Meta')
  parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key)
  return parts.join('+')
}

/** 把当前绑定推给桌面壳主进程，重新注册 OS 级热键（浏览器里 top===self 时不发）。 */
export function syncCallHotkeyToShell(h: CallHotkey): void {
  try {
    if (window.top !== window.self) {
      window.top.postMessage({ type: 'dsh:set-call-hotkey', accelerator: toAccelerator(h) }, '*')
    }
  } catch { /* 跨源受限：仅 OS 级不生效，页面内两路仍在 */ }
}

/** React 侧订阅当前绑定（改键由官方设置页驱动，这里只读）。 */
export function useCallHotkey(): CallHotkey {
  const [value, setValue] = useState<CallHotkey>(() => getCurrentHotkey())
  useEffect(() => {
    const onChange = (): void => { setValue(getCurrentHotkey()) }
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [])
  return value
}

