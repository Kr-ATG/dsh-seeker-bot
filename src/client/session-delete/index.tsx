/**
 * dsh-seeker-bot — 会话右键菜单里的「删除会话」。
 *
 * ## 为什么能用官方 slot 而不是 DOM 注入
 *
 * 官方 ui-workspace 把会话行的「...」菜单拆成了 `sidebar.workspaces.session.menu.item`
 * 这个 list 席位：内置的置顶(100)/重命名(200)/分叉(300)/归档(400)/复制 Session ID(450)
 * 都是它的条目，**客户端插件注册的条目按 order 落在对应位置**（见
 * dsh-client-ui-workspace 的 README「管理会话」一节）。所以这里 order 取 425：
 * 紧跟在「归档会话」之后、「复制 Session ID」之前，正是用户要的位置。
 *
 * ## 为什么删除走自己的 host 路由
 *
 * 官方只提供归档（`workspace/archiveSession`），没有删除——归档只把 id 塞进
 * 归档集合，日志目录和记账都留着。真正删除由 host 半身的 `/api/session-admin`
 * 实现（走 `registry.unarchiveSession` + `workspace.detachSession` + 删目录，
 * 不直接改 workspace.json，理由见那个文件的头注释）。
 *
 * ## 为什么确认弹窗挂在常驻宿主上
 *
 * 官方 Menu 是条件渲染的：菜单一关，菜单项组件就被卸载，组件里的 state 连同
 * 刚弹出的确认框一起消失。所以这里拆成两半：
 *   - 菜单项：只投递请求（`requestDeleteSession`）并关菜单；
 *   - 宿主：注册在 `shell.overlay` 席位上常驻，订阅请求后渲染自绘确认弹窗
 *     （`DeleteConfirmDialog`，不用 `window.confirm`——那是 dsh-shell 的系统
 *     弹窗，标题写死成 "dsh-shell"，与主题完全脱节）。
 *
 * ## 菜单项为什么是红的
 *
 * `MenuItemButton` 原生支持 `danger`（官方内置项里删除类动作都这么标），
 * 传了就拿到官方那套危险色（文字 + hover 底色），不需要自己写样式。
 */

import { useEffect, useState } from 'react'
import { IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MenuItemButton } from './menu-item.tsx'
import { DeleteConfirmDialog } from './confirm-dialog.tsx'
import {
  currentDeleteRequest,
  requestDeleteSession,
  settleDeleteRequest,
  subscribeDeleteRequest,
  type DeleteRequest,
} from './store.ts'

/** host 路由前缀（与 src/session-admin/index.ts 保持一致）。 */
const ROUTE = '/api/session-admin'

/** 菜单项 id（与官方内置的 pin/rename/fork/archive/session-id 不冲突）。 */
export const DELETE_MENU_ID = 'session-delete'

/** 排在「归档会话」(400) 之后、「复制 Session ID」(450) 之前。 */
export const DELETE_MENU_ORDER = 425

/** 确认弹窗宿主在 `shell.overlay` 里的 id / order（排在做完胶囊那组 90~94 之后）。 */
export const DELETE_DIALOG_SEAT_ID = 'session-delete-confirm'
export const DELETE_DIALOG_SEAT_ORDER = 95

/**
 * 调 host 删除一个会话。
 *
 * @param id - 形如 `session-<uuid>` 的会话 id。
 * @returns 成功与否，以及给用户看的一句话。
 */
export async function deleteSessionOnHost(id: string): Promise<{ ok: boolean; message: string }> {
  let response: Response
  try {
    response = await fetch(`${ROUTE}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    })
  } catch (error) {
    return { ok: false, message: `删除失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let payload: Record<string, any> = {}
  try {
    payload = await response.json() as Record<string, any>
  } catch {
    return { ok: false, message: `删除失败：宿主返回了无法解析的响应（HTTP ${String(response.status)}）` }
  }
  const results = Array.isArray(payload.results) ? payload.results as Record<string, any>[] : []
  const first = results[0]
  if (payload.ok === true && first?.ok === true) {
    const dirs = typeof first.removedDirs === 'number' ? first.removedDirs : 0
    return {
      ok: true,
      message: dirs > 0
        ? '已永久删除该会话（对话与日志都已移除）'
        : '已清理该会话的注册记录（日志早已不在磁盘上）',
    }
  }
  const reason = typeof first?.error === 'string'
    ? first.error
    : (typeof payload.error === 'string' ? payload.error : `HTTP ${String(response.status)}`)
  return { ok: false, message: `删除失败：${reason}` }
}

/**
 * 轻量 toast：挂一个固定定位的提示条，2.6 秒后自己消失。
 *
 * 不引官方 Toast 的原因：那是需要 Provider 的有状态组件，为一个删除提示
 * 去改插件树不值得；这里只需要「说一句话然后消失」。
 *
 * @param text - 提示文案。
 * @param tone - ok=成功、error=失败。
 */
export function showSessionToast(text: string, tone: 'ok' | 'error'): void {
  if (typeof document === 'undefined') return
  const el = document.createElement('div')
  el.setAttribute('data-dsh-session-toast', '')
  el.textContent = text
  el.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:28px',
    'transform:translateX(-50%)',
    'z-index:2147483000',
    'max-width:min(520px, calc(100vw - 48px))',
    'padding:9px 16px',
    'border-radius:10px',
    'font:500 13px/1.5 var(--dsw-font-family-text, system-ui, sans-serif)',
    'box-shadow:0 6px 24px rgba(0,0,0,.28)',
    'pointer-events:none',
    'opacity:0',
    'transition:opacity .16s ease',
    tone === 'ok'
      ? 'background:var(--dsw-alias-bg-elevated, #1f2329);color:var(--dsw-alias-text-primary, #fff)'
      : 'background:var(--dsw-alias-error-bg, #3a1d1d);color:var(--dsw-alias-error-text, #ffb4b4)',
  ].join(';')
  document.body.appendChild(el)
  requestAnimationFrame(() => { el.style.opacity = '1' })
  window.setTimeout(() => {
    el.style.opacity = '0'
    window.setTimeout(() => { el.remove() }, 220)
  }, 2600)
}

/** 菜单项组件 props（只用到官方 owner share 里的这几项）。 */
interface SessionMenuItemProps {
  readonly sessionId: string
  readonly useMenuOpenState: () => [unknown, (open: boolean) => void]
}

/**
 * 「删除会话」菜单项（危险色）。
 *
 * 点击只做两件事：关菜单、把请求投递给常驻宿主。真正的确认弹窗与删除动作
 * 都在 `DeleteConfirmHost` 里，不受菜单卸载影响。
 *
 * @param props - 官方 slot 注入的 owner share。
 * @returns 菜单行。
 */
function DeleteSessionMenuItem({ sessionId, useMenuOpenState }: SessionMenuItemProps): JSX.Element {
  const [, setMenuOpen] = useMenuOpenState()
  const onSelect = (): void => {
    setMenuOpen(false)
    requestDeleteSession({ sessionId, title: '' })
  }
  return (
    <MenuItemButton danger icon={<IconTrashOutlineRegular size={14} />} onSelect={onSelect}>
      删除会话
    </MenuItemButton>
  )
}

/**
 * 确认弹窗宿主（注册在 `shell.overlay`，常驻）。
 *
 * 订阅模块级请求：有请求就渲染自绘确认框，确认后调 host 删除并 toast 结果。
 *
 * @returns 弹窗或 null。
 */
function DeleteConfirmHost(): JSX.Element | null {
  const [request, setRequest] = useState<DeleteRequest | null>(currentDeleteRequest())

  useEffect(() => subscribeDeleteRequest(setRequest), [])

  if (request === null) return null

  return (
    <DeleteConfirmDialog
      title={request.title}
      onConfirm={() => {
        void deleteSessionOnHost(request.sessionId).then((result) => {
          showSessionToast(result.message, result.ok ? 'ok' : 'error')
        })
      }}
      onClose={settleDeleteRequest}
    />
  )
}

/**
 * 注册菜单项与确认弹窗宿主。
 *
 * @param ctx - client 插件上下文（需要 `slots` 服务，已在入口 inject 里）。
 */
export function applySessionDelete(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: DELETE_MENU_ID,
    order: DELETE_MENU_ORDER,
  }, DeleteSessionMenuItem as never))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: DELETE_DIALOG_SEAT_ID,
    order: DELETE_DIALOG_SEAT_ORDER,
  }, DeleteConfirmHost as never))
}
