/**
 * 语音通话快捷键：配置完全交给官方 ctx.shortcuts。
 *
 *  · 注册一条官方命令（id dsh-seeker-bot:toggle-voice-call，默认 Ctrl+Alt+V），
 *    用户在「设置 → 通用 → 快捷键」里改键，官方负责冲突检测 / 持久化 / profile；
 *  · 订阅 shortcuts.catalog，把当前有效绑定同步到运行时偏好（→ 三路触发通道）
 *    和桌面壳的 OS 级 globalShortcut；
 *  · 命令命中时 resolve() 派发 CALL_HOTKEY_FIRE_EVENT，由 React hook 执行 toggle。
 *
 * 不再自设 settings.general.item 设置行、不再写 localStorage：只有一处配置源，
 * 不会出现「官方设置页改了、插件那边没跟」的割裂。
 */
import type { Context as ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CALL_HOTKEY_FIRE_EVENT, DEFAULT_CALL_HOTKEY, fromNormalizedBinding, setCurrentHotkey,
} from './pref.ts'

/** 官方命令 id（同时是 catalog 里的行 id 与偏好文档里的 key）。 */
export const CALL_HOTKEY_COMMAND_ID = 'dsh-seeker-bot:toggle-voice-call'

/** 官方 web 规则允许：含 control 的双修饰组合；非 windows profile 不设默认，交给用户自行绑定。 */
const DEFAULT_BINDING = { code: 'KeyV', modifiers: ['control', 'alt'] } as const

interface CatalogRow {
  id: string
  binding: { code: string; modifiers: readonly string[] } | null
  issue: unknown
  conflicts: readonly unknown[]
}
interface ShortcutsLike {
  register(command: {
    id: string
    label: () => string
    aliases: readonly string[]
    defaults: Record<string, { code: string; modifiers: readonly string[] }>
    regions: readonly string[]
    modals: readonly string[]
    resolve: (context: unknown) => { status: 'handled'; run: () => void }
  }): () => void
  catalog: {
    getSnapshot: () => readonly CatalogRow[]
    subscribe: (listener: () => void) => () => void
  }
}

/** 装配官方命令 + catalog 同步。 @param ctx - client root context。 */
export function applyCallHotkey(ctx: ClientContext): void {
  /* 先给运行时一个可用绑定：即使官方服务不可用，三路通道与 OS 级也有默认键。 */
  setCurrentHotkey(DEFAULT_CALL_HOTKEY)

  /** 在 shortcuts 服务就绪的 scope 里装配命令与 catalog 同步。 */
  const mount = (scope: ClientContext): void => {
    const shortcuts = (scope as unknown as { shortcuts?: ShortcutsLike }).shortcuts
    if (shortcuts === undefined || typeof shortcuts.register !== 'function') return

    let dispose: (() => void) | null = null
    try {
      dispose = shortcuts.register({
        id: CALL_HOTKEY_COMMAND_ID,
        label: () => '语音通话（开始 / 挂断）',
        aliases: ['voice call', '语音通话'],
        defaults: {
          'web:windows': DEFAULT_BINDING,
          'desktop:windows': DEFAULT_BINDING,
        },
        regions: ['page', 'editable', 'terminal'],
        modals: [],
        resolve: () => ({
          status: 'handled',
          run: () => {
            try { window.dispatchEvent(new CustomEvent(CALL_HOTKEY_FIRE_EVENT)) } catch { /* 无 window */ }
          },
        }),
      })
    } catch (error) {
      /* 默认键被别的命令占/规则不放行：保留默认绑定，只是官方设置页里不出现这行 */
      console.warn('[dsh-seeker-bot] 语音通话命令注册失败：', error)
      return
    }

    const catalog = shortcuts.catalog
    if (catalog === undefined || typeof catalog.getSnapshot !== 'function') return
    const sync = (): void => {
      try {
        const row = catalog.getSnapshot().find((item) => item.id === CALL_HOTKEY_COMMAND_ID)
        if (row === undefined || row.binding === null || row.issue !== null || row.conflicts.length > 0) return
        const next = fromNormalizedBinding(row.binding)
        if (next !== null) setCurrentHotkey(next)
      } catch { /* catalog 尚未就绪 */ }
    }
    sync()
    let off: (() => void) | null = null
    try { off = catalog.subscribe(sync) } catch { /* 订阅不可用：至少启动同步了一次 */ }
    try {
      scope.effect(() => () => {
        try { off?.() } catch { /* 已释放 */ }
        try { dispose?.() } catch { /* 已被级联移除 */ }
      })
    } catch { /* 宿主未实现 effect */ }
  }

  /*
   * shortcuts **不在**插件顶层 inject 列表里：cordis 的服务代理对未声明属性
   * 直接抛「cannot get property "shortcuts" without inject」。直接在根 ctx 上
   * 读 ctx.shortcuts 会让整个 applyCallHotkey 被打断（guarded 只记一条 warn），
   * 表现为「设置 → 通用 → 快捷键」里永远没有「语音通话（开始 / 挂断）」这一行。
   * 用延迟注入：宿主没挂 shortcuts 服务时静默降级，页面内与壳子两路仍按默认键工作。
   */
  try {
    ;(ctx as unknown as { inject: (names: string[], callback: (scope: ClientContext) => void) => unknown })
      .inject(['shortcuts'], mount)
  } catch (error) {
    console.warn('[dsh-seeker-bot] 语音通话快捷键注入 shortcuts 服务失败：', error)
  }
}
