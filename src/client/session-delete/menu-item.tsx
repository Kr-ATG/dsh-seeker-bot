/**
 * dsh-seeker-bot — `MenuItemButton` 的运行时适配层。
 *
 * ## 为什么要单独一个文件
 *
 * 官方会话菜单的内置项是用 `@deepseek-ai/dsh-client-ui-primitives` 的
 * `MenuItemButton` 渲染的（菜单的图标槽、快捷键位、hover/选中态都由它接管）。
 * 这个导出**只存在于发行版 primitives 的模块表里**——`D:\AI\deepseek-harness`
 * 源码仓库的 `ui-primitives/lib/types/index.d.ts` 还没收录它，所以直接
 * `import { MenuItemButton }` 会让 `tsc --noEmit` 报「模块没有导出该成员」。
 *
 * 这里用命名空间 import + 属性取用绕开类型问题：esbuild 不做类型检查，运行时
 * 拿到的是宿主模块表里的真实对象，有就有、没有就走兜底。
 *
 * ## 兜底为什么长这样
 *
 * 兜底只在「宿主 primitives 比预期旧」时触发。此时仍要能点、能读，所以用一个
 * 语义正确的 `<button role="menuitem">`，视觉上尽量贴近官方菜单项（沿用官方
 * `--dsw-*` 变量），但不去猜官方的 class 名——猜错会得到「有样式但全错」的
 * 结果，不如干净的无样式按钮。
 */

import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** `MenuItemButton` 的最小 props 面（只声明本插件用到的那几个）。 */
export interface MenuItemButtonProps {
  readonly icon?: unknown
  readonly shortcut?: unknown
  /** 危险动作：官方内置项里的删除类都标这个，拿到警示色（文字 + hover 底色）。 */
  readonly danger?: boolean
  readonly onSelect?: () => void
  readonly children?: unknown
}

type MenuItemComponent = (props: MenuItemButtonProps) => unknown

/**
 * 兜底按钮：官方 primitives 里没有 `MenuItemButton` 时使用。
 *
 * @param props - 与官方同形的最小 props。
 * @returns 一个语义化的菜单行按钮。
 */
function FallbackMenuItemButton({ icon, danger = false, onSelect, children }: MenuItemButtonProps): unknown {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 10px',
        border: 'none',
        background: 'transparent',
        color: danger ? 'var(--dsw-alias-state-error-primary, #e0434b)' : 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        borderRadius: '6px',
      }}
    >
      <span style={{ display: 'inline-flex', width: '14px', height: '14px', alignItems: 'center', justifyContent: 'center' }}>
        {icon as never}
      </span>
      <span>{children as never}</span>
    </button>
  )
}

/**
 * 实际使用的菜单项组件：优先官方，缺了用兜底。
 *
 * 注意 `(primitives as any)` 的写法是**故意**的：见文件头注释（类型声明缺失）。
 */
export const MenuItemButton: MenuItemComponent =
  (typeof (primitives as Record<string, unknown>).MenuItemButton === 'function'
    ? (primitives as Record<string, unknown>).MenuItemButton
    : FallbackMenuItemButton) as MenuItemComponent
