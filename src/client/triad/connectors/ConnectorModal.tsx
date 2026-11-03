/**
 * dsh-seeker-bot — 「连接器」弹窗卡片（MCP 页面）。
 *
 * 用户要求（2026-11-03）：「MCP页面变成弹窗卡片」。
 * 以前点「MCP服务器」胶囊会走 openWorkbench('connectors')，整个主区变成连接器
 * 工作台页；现在改成 portal 到 body 的居中弹窗卡片：
 *   · 遮罩 + 居中卡片（桌面 1040×860 上限，随视口夹紧；窄屏走全屏 sheet）；
 *   · 卡片顶部是 MCP 服务器标题 + 关闭按钮，内容复用 ConnectorsPanel 的
 *     搜索 / 分类 / 卡片网格 / 详情抽屉（inCard 模式隐藏页内大标题，避免双层标题）；
 *   · 点遮罩、按 Esc、点关闭都能关；打开时焦点移进卡片，关闭后还给胶囊。
 *   · z-index 高过 Personal Agent 的 .pa-root，Bot 模式下也能正常盖在 Bot 上。
 *
 * 复用 PopoverShell 的 modal 形态（见 ../popover-shell.tsx）：它统一处理
 * portal / 遮罩 / Esc / 焦点归还 / 开合动画，这里只负责内容和标题。
 */
import { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConnectorsPanel } from './Panel.js'
import { ensureShellStyles, PopoverShell, PshBody, PshHead } from '../popover-shell.js'
import { ensureModalAnimStyles, useModalClose } from '../triad-modal-animation.js'

/** 连接器弹窗属性。 */
export interface ConnectorModalProps {
  /** 是否打开（父组件持有；关闭动画结束后父组件才把它置 false）。 */
  open: boolean
  /** 请求关闭（遮罩 / Esc / 关闭钮统一走这里）。 */
  onClose: () => void
}

/**
 * 渲染连接器弹窗卡片。
 * @param props 打开状态与关闭回调。
 * @returns 弹窗；未打开时 null。
 */
export function ConnectorModal({ open, onClose }: ConnectorModalProps): JSX.Element | null {
  ensureShellStyles()
  ensureModalAnimStyles()
  const { closing, requestClose } = useModalClose(open, onClose)
  if (!open) return null
  return (
    <PopoverShell
      variant="modal"
      solid
      closing={closing}
      onClose={requestClose}
      ariaLabel="MCP 服务器"
    >
      <PshHead title="MCP 服务器" closeLabel="关闭" onClose={requestClose} />
      <PshBody>
        <ConnectorsPanel embedded inCard onClose={requestClose} />
      </PshBody>
    </PopoverShell>
  )
}

/* ───────────────────── 全局单例宿主（任何模块都能打开） ───────────────────── */

/**
 * 弹窗的「想不想开」状态放在模块级，而不是某颗胶囊组件的 state 里。
 *
 * 原因：打开连接器的入口不止侧栏胶囊——Bot 对话里的「连接你的应用」推荐卡
 * （personal/chat/ConnectorSuggestCard.tsx）也要打开同一个弹窗。弹窗必须比
 * 入口活得久：Bot 侧栏折叠时胶囊会卸载，不能把弹窗一起带走。
 */
let modalWanted = false
/** 订阅者（目前只有宿主组件）。 */
const modalListeners = new Set<(open: boolean) => void>()

/** 通知宿主重启渲染。 */
function emitModal(): void {
  for (const listener of [...modalListeners]) {
    try { listener(modalWanted) } catch (error) { console.error('[dsh-seeker-bot] connector modal listener failed:', error) }
  }
}

/** 打开连接器弹窗（任何入口都可调用；已打开时是 no-op）。 */
export function openConnectorModal(): void {
  if (modalWanted) return
  modalWanted = true
  emitModal()
}

/** 请求关闭连接器弹窗（关闭动画由 ConnectorModal 内部状态机负责）。 */
export function closeConnectorModal(): void {
  if (!modalWanted) return
  modalWanted = false
  emitModal()
}

/** 订阅弹窗开关（宿主组件用）。 */
function subscribeConnectorModal(listener: (open: boolean) => void): () => void {
  modalListeners.add(listener)
  listener(modalWanted)
  return () => { modalListeners.delete(listener) }
}

/** 全局宿主的 React 根组件：只负责把模块状态折成 ConnectorModal 的 props。 */
function ConnectorModalHost(): JSX.Element | null {
  const [open, setOpen] = useState(modalWanted)
  useEffect(() => subscribeConnectorModal(setOpen), [])
  return <ConnectorModal open={open} onClose={closeConnectorModal} />
}

/** 宿主节点 id（挂到 body，避免被任何侧栏/面板的 React 重渲染回收）。 */
const MODAL_HOST_ID = 'dsh-mcp-modal-host'
let modalHostEl: HTMLDivElement | null = null
let modalHostRoot: Root | null = null

/**
 * 挂载全局连接器弹窗宿主（幂等单例）。由工作台座位在 apply 阶段调用。
 *
 * 宿主常驻（关闭时只渲染 null），换来的是「任何入口随时 openConnectorModal()」
 * 都不需要自己管理 React root；卸载时整体回收，热重载不残留。
 * @returns 清理函数（交给 ctx.effect）。
 */
export function attachConnectorModalHost(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (modalHostEl !== null) return () => { /* 已挂载：由首个清理器统一回收 */ }
  const el = document.createElement('div')
  el.id = MODAL_HOST_ID
  el.dataset.plugin = 'dsh-seeker-bot'
  document.body.appendChild(el)
  modalHostEl = el
  modalHostRoot = createRoot(el)
  modalHostRoot.render(<ConnectorModalHost />)
  return () => {
    modalWanted = false
    if (modalHostRoot !== null) {
      try { modalHostRoot.unmount() } catch { /* 根已分离：忽略 */ }
    }
    modalHostRoot = null
    modalHostEl?.remove()
    modalHostEl = null
  }
}
