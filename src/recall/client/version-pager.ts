/**
 * dsh-recall-plugin — 版本翻页器 ‹ X/N ›（assistant-actions 槽）
 *
 * 每次撤回/编辑重发都会 fork 出新会话，同一段对话于是有多个真实版本。翻页器
 * 挂在回合末尾的官方操作区，点击在家族成员间切换：归档当前、解档目标、打开
 * 目标。为什么必须「归档当前」——侧栏同时出现两个同名会话时用户无法分辨哪个
 * 是当前分支，官方 fork 出来的会话也共享同一标题。
 *
 * 只在最后一个回合显示：家族是会话级的，历史回合各挂一个控件会让同一页出现
 * 多个入口，点哪个都切到同一处，纯噪音。
 */

import type { ReactApi, UtilApi } from './util.js'
import type { ClientUiWorkspaceService, ClientWorkspacesService } from '../types/client-contract.js'
import { activeSession, familyOf } from './version-tree.js'
import type { VersionFamily } from './version-tree.js'

// 当前会话 id：消息节点渲染时写进共享位；万一 pager 先于消息挂载（或节点被
// 官方缓存复用），回落到 DOM 上消息行留的 data-recall-session 标记
function currentSessionId(): string {
  if (activeSession.id) return activeSession.id
  if (typeof document === 'undefined') return ''
  const rows = document.querySelectorAll('[data-recall-session]')
  const last = rows.length > 0 ? rows[rows.length - 1] : null
  return last ? (last.getAttribute('data-recall-session') || '') : ''
}

// turn-tail 的属性值是回合号（data-turn-tail={turn}），这里只用它的存在性做
// 文档顺序比较：最后一个 turn-tail 即「当前会话的最后一轮」
function isLastTurnTail(node: Element | null): boolean {
  if (!node || typeof document === 'undefined') return false
  const own = node.closest('[data-turn-tail]')
  if (!own) return false
  const all = document.querySelectorAll('[data-turn-tail]')
  return all.length === 0 || all[all.length - 1] === own
}

function scrollerOf(node: Element | null): HTMLElement | null {
  let cur: Element | null = node ? node.parentElement : null
  while (cur) {
    if (cur instanceof HTMLElement && cur.scrollHeight > cur.clientHeight) {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(cur) : null
      if (style && /(auto|scroll)/.test(style.overflowY)) return cur
    }
    cur = cur.parentElement
  }
  return null
}

// 视口锚定：记下「首个仍然可见的消息行」及其相对视口顶部的位置，切换后按同一
// 行重新对齐。切版本时消息内容不同，行高必然不同，只靠 scrollTop 会跳位。
function captureAnchor(): { key: string; top: number } | null {
  if (typeof document === 'undefined') return null
  const rows = document.querySelectorAll('[data-chat-anchor-key]')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as HTMLElement
    const rect = row.getBoundingClientRect()
    if (rect.bottom > 0) {
      const key = row.getAttribute('data-chat-anchor-key') || ''
      return key ? { key, top: rect.top } : null
    }
  }
  return null
}

function restoreAnchor(scroller: HTMLElement | null, anchor: { key: string; top: number } | null): void {
  if (!scroller || !anchor || typeof document === 'undefined') return
  const rows = document.querySelectorAll('[data-chat-anchor-key]')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as HTMLElement
    if (row.getAttribute('data-chat-anchor-key') !== anchor.key) continue
    const delta = row.getBoundingClientRect().top - anchor.top
    if (Math.abs(delta) > 1) scroller.scrollTop += delta
    return
  }
}

export interface VersionPagerApi {
  // sessionId 由槽的 inject(sessionId) 注入（官方 assistant-actions 契约），
  // messageId 是槽 props 本身
  VersionPager: (props: { messageId?: string; sessionId?: string }) => import('react').ReactNode
}

export function buildVersionPager(
  React: ReactApi,
  util: UtilApi,
  workspacesSvc: ClientWorkspacesService,
  uiWorkspaceSvc?: ClientUiWorkspaceService
): VersionPagerApi {
  const { t, showThrottledToast } = util

  function VersionPager(props: { messageId?: string; sessionId?: string }): import('react').ReactNode {
    const ref = React.useRef<HTMLDivElement | null>(null)
    const [family, setFamily] = React.useState<VersionFamily | null>(null)
    const [visible, setVisible] = React.useState(false)
    const [busy, setBusy] = React.useState(false)

    // 家族数据在 fork 成功时写入 localStorage；挂载与消息变化时重读即可覆盖
    // 「刚提交完编辑、翻页器随新消息重挂」这条路径。延后一拍再判「是否最后一
    // 个回合」：新 turn-tail 可能在本组件首次 effect 之后才插进文档
    React.useEffect(() => {
      const measure = () => {
        setFamily(familyOf((props && props.sessionId) || currentSessionId()))
        setVisible(isLastTurnTail(ref.current))
      }
      measure()
      const timer = setTimeout(measure, 60)
      return () => clearTimeout(timer)
    }, [props && props.messageId])

    const show = Boolean(family && family.ids.length >= 2 && visible)
    if (!show || !family) {
      // 容器必须照常渲染（空则 CSS :empty 隐藏）：若这里返回 null，ref 永不
      // 挂载，「我是最后一个回合吗」的第一步就量不到自己
      return React.createElement('div', { className: 'dsh-recall-pager', ref })
    }

    const total = family.ids.length
    const index = family.index
    const go = (delta: number) => {
      if (busy) return
      const target = family.ids[index + delta]
      if (!target) return
      const current = activeSession.id || family.ids[index]
      if (!current || current === target) return
      setBusy(true)
      const scroller = scrollerOf(ref.current)
      const anchor = captureAnchor()
      const done = () => setBusy(false)
      // 归档当前 + 解档目标 + 打开目标：官方没有「切换到归档会话」的单步动作，
      // 必须先解档（归档会话不是合法的导航目标，直接 open 会落空态）
      Promise.resolve()
        .then(() => (workspacesSvc && typeof workspacesSvc.archiveSession === 'function')
          ? workspacesSvc.archiveSession(current)
          : undefined)
        .then(() => (uiWorkspaceSvc && typeof uiWorkspaceSvc.unarchiveSession === 'function')
          ? uiWorkspaceSvc.unarchiveSession(target)
          : undefined)
        .then(() => {
          if (uiWorkspaceSvc && typeof uiWorkspaceSvc.openSession === 'function') uiWorkspaceSvc.openSession(target)
          // 会话内容异步替换：两次尝试覆盖「先渲染骨架、后补齐内容」的两拍
          setTimeout(() => restoreAnchor(scroller, anchor), 80)
          setTimeout(() => restoreAnchor(scroller, anchor), 320)
        })
        .catch((error) => {
          // 归档可能被官方拒绝（目标会话仍有活动在跑），把原因讲清楚
          showThrottledToast(t('toast.pagerFailed', { error: String(error).slice(0, 120) }))
        })
        .then(done, done)
    }

    return React.createElement('div', { className: 'dsh-recall-pager', ref, 'data-busy': busy ? 'true' : undefined },
      React.createElement('button', {
        type: 'button',
        className: 'dsh-recall-pager-btn',
        'aria-label': t('pager.prev'),
        title: t('pager.prev'),
        disabled: busy || index <= 0,
        onClick: () => go(-1),
      }, '\u2039'),
      React.createElement('span', { className: 'dsh-recall-pager-count', 'aria-label': t('pager.label', { n: index + 1, total }) }, (index + 1) + '/' + total),
      React.createElement('button', {
        type: 'button',
        className: 'dsh-recall-pager-btn',
        'aria-label': t('pager.next'),
        title: t('pager.next'),
        disabled: busy || index >= total - 1,
        onClick: () => go(1),
      }, '\u203a')
    )
  }

  return { VersionPager }
}
