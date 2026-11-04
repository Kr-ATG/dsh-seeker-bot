/**
 * dsh-recall-plugin — client 快照树管理卡片（S1 拆分）
 *
 * 从 settings-cards.ts 按域拆出的「快照管理」卡片：列表（时间倒序）/ 磁盘
 * 占用 / 单条删除 / 手动 gc / 最近错误，以及 F1 版本家族聚族用的纯函数
 * groupByLineage。拆分动机：settings-cards 逼近 800 行红线，而快照树是四段
 * 中最大的一块（约 400 行），先拆再为其他域留位（U1/U5 表单项后续还要加）。
 * 纯移动，零行为变化；依赖注入 React 与 util（api/clockText/sizeText/
 * buildTree），sessionsSvc 用于「切换到该版本会话」。
 */

import type { ReactApi, UtilApi, TreeWorkspace, TreeSession } from './util.js'
import { useAutoDismissMessage } from './util.js'
import { hasTranslation } from './locales/index.js'
import type { ClientSessionsService, ClientUiWorkspaceService, ClientWorkspacesService } from '../types/client-contract.js'
import type { ManageListItem, ManageResponse, ManageListOk, ManageTitlesOk, ManageMessagesOk, ManageUsageOk, ManageLineageOk, StatusErrorItem, StatusResponse } from '../types/api.js'
import type { LineageEntry } from '../types/payloads.js'

// F1：按 fork lineage 计算会话的版本家族。lineage 是 [{childId, parentId}]，
// 返回 Map<sessionId, {family: string[], index: number}>——family 是按 fork
// 顺序（parent→child）排列的家族链，index 从 1 起（v1/v2/v3）。仅 ≥2 成员的
// 家族有映射；单会话无版本概念。纯函数、渲染期零副作用，供单测钉边界。
export interface FamilyInfo {
  family: string[]
  index: number
}

export function groupByLineage(ids: Array<string | null | undefined>, lineage: LineageEntry[] | null | undefined): Map<string, FamilyInfo> {
  const childOf = new Map<string, string>()    // childId -> parentId（回溯根用）
  const childrenOf = new Map<string, string[]>() // parentId -> [childIds]（向下收集链用）
  for (const e of lineage || []) {
    if (e && e.childId && e.parentId) {
      const child = String(e.childId)
      const parent = String(e.parentId)
      childOf.set(child, parent)
      const kids = childrenOf.get(parent) || []
      kids.push(child)
      childrenOf.set(parent, kids)
    }
  }
  const idSet = new Set((ids || []).map((v) => String(v)))
  const result = new Map<string, FamilyInfo>()
  const assigned = new Set<string>()
  for (const id of idSet) {
    if (assigned.has(id)) continue
    // 回溯到链根（父不在集合里的节点）
    let root = id
    const seen = new Set<string>()
    while (childOf.has(root) && idSet.has(childOf.get(root) as string) && !seen.has(root)) {
      seen.add(root)
      root = childOf.get(root) as string
    }
    // 从根向下按 childrenOf BFS 收集整条家族链（线性链退化为顺序遍历）
    const chain: string[] = []
    const queue: string[] = [root]
    while (queue.length) {
      const cur = queue.shift()
      if (!cur || !idSet.has(cur) || assigned.has(cur)) continue
      chain.push(cur)
      assigned.add(cur)
      for (const k of childrenOf.get(cur) || []) queue.push(k)
    }
    if (chain.length > 1) {
      chain.forEach((sid, i) => result.set(sid, { family: chain, index: i + 1 }))
    }
  }
  return result
}

export function buildSnapshotManager(React: ReactApi, util: UtilApi, sessionsSvc: ClientSessionsService, workspacesSvc?: ClientWorkspacesService, uiWorkspaceSvc?: ClientUiWorkspaceService): { ManageCard: () => import('react').ReactNode } {
  const { api, clockText, sizeText, buildTree, messageFor, t } = util

  // 树行内的删除按钮：垃圾桶图标 + 稳定命中区，紧贴会话/快照名渲染（不再排到
  // 行尾——文本 chip 逐行右对齐成一列，用户实测反馈容易点错行）。颜色随主题：
  // 静息 label-tertiary、hover 转 error + 危险底色，靠「悬停才显红」压住多行
  // 红色噪音（安全语义由确认条承担）。stroke 用 currentColor，不写死图标源
  // 里的 #d0021b
  function DeleteButton(props: { title: string; onClick: () => void }): import('react').ReactNode {
    return React.createElement('button', {
      type: 'button',
      className: 'dsh-recall-icon-btn dsh-recall-icon-btn-danger',
      title: props.title,
      'aria-label': props.title,
      // 阻止冒泡：行本身可点（展开/收起），删除按钮不该顺带折叠该行
      onClick: (e: import('react').MouseEvent) => { e.stopPropagation(); props.onClick() },
    }, React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 48 48', fill: 'none', 'aria-hidden': true },
      React.createElement('path', { d: 'M9 10V44H39V10H9Z', stroke: 'currentColor', strokeWidth: 4, strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M20 20V33', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M28 20V33', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M4 10H44', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M16 10L19.289 4H28.7771L32 10H16Z', stroke: 'currentColor', strokeWidth: 4, strokeLinejoin: 'round' })
    ))
  }

  // 树折叠钮的 chevron 图标：与 SectionToggle/卡片头同一枚 SVG（字符 ▸/▾ 跨
  // 平台字形粗细不一），收起 = 向下字形 rotate(-90deg) 朝右，展开 = 不旋转；
  // 过渡挂在 svg 上（.16s，同官方 chevron 动效档），按钮自身保持无 transform
  function chevronIcon(open: boolean): import('react').ReactNode {
    return React.createElement('svg', {
      width: 12, height: 12, viewBox: '0 0 16 16',
      style: { transition: 'transform .16s', transform: open ? 'none' : 'rotate(-90deg)' }
    }, React.createElement('path', {
      d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round'
    }))
  }

  // 快照管理卡片：列表（时间倒序）/ 磁盘占用 / 单条删除 / 手动 gc / 最近错误。
  // 全部操作走 Host 的 manage/status 端点（串行队列在 Host 侧保证）。
  function ManageCard() {
    const [items, setItems] = React.useState<ManageListItem[] | null>(null)
    // 列表读取失败（issue #30 遗留项）：旧行为是静默空树，用户只能翻日志。
    // null=没失败；字符串=失败文案（DUMP_FAILED 走 err.* 词典，其余回落 host message）
    const [listError, setListError] = React.useState<string | null>(null)
    const [usage, setUsage] = React.useState<number | null>(null)
    const [errors, setErrors] = React.useState<StatusErrorItem[] | null>(null)
    const [state, setState] = React.useState({ busy: false, message: '', error: false })
    // V3：成功消息 4s 后自动消退（错误常驻），共享 hook 见 util.ts
    useAutoDismissMessage(React, state, setState)
    // 快照全量计数与当前拉取上限：Host 按 limit 切片返回，total 是全量
    const [limit, setLimit] = React.useState(200)
    const [total, setTotal] = React.useState(0)
    const [health, setHealth] = React.useState<{ gitAvailable: boolean; homeStores: number; fallbackStores: number } | null>(null)
    const [query, setQuery] = React.useState('')
    const [showAllErrors, setShowAllErrors] = React.useState(false)
    const [titlesPending, setTitlesPending] = React.useState(false)
    // F1：fork lineage（childId ↔ parentId 撤回链），来自 manage op='lineage'
    const [lineage, setLineage] = React.useState<LineageEntry[]>([])

    function fetchTitles(list: ManageListItem[] | null | undefined): void {
      const missing = Array.from(new Set(
        (list || []).filter((it) => it.sessionId && !it.sessionTitle).map((it) => it.sessionId)
      )).slice(0, 100)
      if (!missing.length) { setTitlesPending(false); return }
      setTitlesPending(true)
      api<ManageTitlesOk>('manage', { op: 'titles', sessionIds: missing }).then((res) => {
        const map = res && res.ok ? res.titles : null
        if (map) {
          setItems((prev) => (prev || []).map((it) => (
            it.sessionId && map[it.sessionId] ? Object.assign({}, it, { sessionTitle: map[it.sessionId] }) : it
          )))
        }
        setTitlesPending(false)
      }).catch(() => setTitlesPending(false)) // 标题补齐失败静默（叶子留白，属渐进增强）
    }

    // 消息文本补齐：只请求 live 拿不到文本的快照；同一会话多条消息在 Host 端
    // 共享一次 readSession，避免为每条消息重复解压大日志。
    function fetchMessages(list: ManageListItem[] | null | undefined): void {
      const requests = (list || [])
        .filter((it) => it.sessionId && it.id && !Object.prototype.hasOwnProperty.call(it, 'messageText'))
        .map((it) => ({ sessionId: it.sessionId, messageId: it.id }))
        .slice(0, 200)
      if (!requests.length) return
      api<ManageMessagesOk>('manage', { op: 'messages', requests }).then((res) => {
        const map = res && res.ok ? res.messageTexts : null
        if (map) {
          setItems((prev) => (prev || []).map((it) => (
            it.id && Object.prototype.hasOwnProperty.call(map, it.id) ? Object.assign({}, it, { messageText: map[it.id] }) : it
          )))
        }
      }).catch(() => {}) // 消息文本补齐失败静默（列表已渲染，属渐进增强）
    }

    // 手动刷新：不能把 refresh 直接交给 onClick——事件对象会被当成 overLimit
    // 透传进请求载荷（JSON.stringify 事件 -> 循环引用抛错，按钮整只失效）
    function refresh(overLimit?: number): void {
      const useLimit = overLimit || limit
      // 响应可能是 ErrBody（DUMP_FAILED 等）：类型上显式带错误支，避免把
      // 「读取失败」当成「加载中」一直转骨架
      api<ManageListOk | { ok: false; code?: string; message?: string }>('manage', { op: 'list', limit: useLimit }).then((res) => {
        if (res && res.ok) {
          setListError(null)
          setItems(res.items || [])
          setTotal(typeof res.total === 'number' ? res.total : (res.items || []).length)
          fetchTitles(res.items || [])
          fetchMessages(res.items || [])
          // PF-6：stale 表示响应来自旧缓存、有新快照未入列表——静默再拉
          // 一次让新快照渐进补上。再拉仍 stale 时止步不更新（不循环，防
          // 抖动），等用户下次手动刷新。
          if (res.stale) {
            api<ManageListOk>('manage', { op: 'list', limit: useLimit }).then((res2) => {
              if (res2 && res2.ok && !res2.stale) {
                setItems(res2.items || [])
                setTotal(typeof res2.total === 'number' ? res2.total : (res2.items || []).length)
                fetchTitles(res2.items || [])
                fetchMessages(res2.items || [])
              }
            }).catch(() => {}) // 二段刷新失败静默（旧列表仍可用；不循环重试，等手动刷新）
          }
        } else if (res) {
          // 读取失败：把 items 从 null 置空（否则骨架条永远在转，形似「还在加载」），
          // 并在树位置显示可重试的失败提示——旧行为只有一棵空树
          setListError(messageFor(res, t('manage.loadFailed')))
          setItems([])
          setTotal(0)
        }
        // F1：加载 fork lineage（版本家族），列表成功后异步补齐，不阻塞首屏
        api<ManageLineageOk>('manage', { op: 'lineage' }).then((res) => {
          if (res && res.ok && Array.isArray(res.lineage)) setLineage(res.lineage)
        }).catch(() => {}) // lineage 补齐失败静默（树退化为无版本家族标记）
        // 列表返回后再补 usage/status：首次冷启动时磁盘占用和错误日志都各要
        // 一条 shell，和 list 并发会抢资源拖慢首屏；延后到列表渲染后。
        api<ManageUsageOk>('manage', { op: 'usage' }).then((res) => {
          if (res && res.ok) {
            setUsage(res.bytes || 0)
            setHealth({ gitAvailable: res.gitAvailable !== false, homeStores: res.homeStores || 0, fallbackStores: res.fallbackStores || 0 })
          }
        }).catch(() => {}) // usage 补齐失败静默（占用留空，不打断列表）
        api<StatusResponse>('status', {}).then((res) => {
          if (res && res.ok) setErrors(res.errors || [])
        }).catch(() => {}) // status 补齐失败静默（错误列表留空，下次刷新补）
      }).catch(() => {
        // list 失败时仍尝试补 usage/status，避免整卡全空
        api<ManageUsageOk>('manage', { op: 'usage' }).then((res) => {
          if (res && res.ok) {
            setUsage(res.bytes || 0)
            setHealth({ gitAvailable: res.gitAvailable !== false, homeStores: res.homeStores || 0, fallbackStores: res.fallbackStores || 0 })
          }
        }).catch(() => {}) // 降级分支同上：补齐失败静默，不叠加错误态
        api<StatusResponse>('status', {}).then((res) => {
          if (res && res.ok) setErrors(res.errors || [])
        }).catch(() => {}) // 降级分支同上：错误列表留空即可
      })
    }

    React.useEffect(() => { refresh() }, [])

    function clearErrors(): void {
      setErrors([])
      api<unknown>('status', { op: 'clear' }).catch(() => {}) // 清除失败静默：本地已清空，刷新后回显仍可再清
    }

    // doneKey 是词表键（不是文案）：调用点只报「哪一种操作完成了」，文案随
    // 当前语言在 run 内取词——模块里不再散落半句中文
    function run(op: string, extra: Record<string, unknown> | null | undefined, doneKey: string): void {
      if (state.busy) return
      setState({ busy: true, message: t('manage.busy'), error: false })
      api<ManageResponse>('manage', Object.assign({ op }, extra || {})).then((res) => {
        if (res && res.ok) {
          const deleted = (res as { deleted?: unknown }).deleted
          setState({ busy: false, message: typeof deleted === 'number' ? t('manage.deletedCount', { deleted }) : t(doneKey), error: false })
          refresh()
        } else {
          setState({ busy: false, message: (res && ((res as { message?: string }).message || (res as { error?: string }).error)) || t('common.opFailed'), error: true })
        }
      }).catch((e) => setState({ busy: false, message: String(e), error: true })) // 操作异常落错误态（与 ok=false 同显式面）
    }

    const [expanded, setExpanded] = React.useState(() => new Set())
    const [confirming, setConfirming] = React.useState<{ kind: string; key?: string; extra?: Record<string, unknown>; text?: string } | null>(null)

    // V9：四种删除确认统一为 ConfirmRow——「确认」=danger chip（危险操作
    // 语义一致），「取消」=普通 chip；原位展开不弹窗（既定交互维持）
    function ConfirmRow(props: { text: string; onConfirm: () => void; onCancel: () => void }): import('react').ReactNode {
      return React.createElement('div', { className: 'dsh-recall-tree-confirm' },
        props.text,
        React.createElement('button', { type: 'button', className: 'dsh-recall-ex-chip dsh-recall-ex-chip-danger', onClick: props.onConfirm }, t('common.confirm')),
        React.createElement('button', { type: 'button', className: 'dsh-recall-ex-chip', onClick: props.onCancel }, t('common.cancel'))
      )
    }

    function renderDeleteAllConfirm(): import('react').ReactNode {
      if (!confirming || confirming.kind !== 'all') return null
      return React.createElement(ConfirmRow, {
        text: t('manage.confirm.all'),
        onConfirm: () => {
          setConfirming(null)
          run('deleteAll', {}, 'manage.done.deleteAll')
        },
        onCancel: () => setConfirming(null)
      })
    }

    function toggle(key: string): void {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    }

    const q = query.trim().toLowerCase()
    const filteredItems = q
      ? (items || []).filter((it) =>
          (it.workspace || '').toLowerCase().indexOf(q) >= 0 ||
          (it.sessionTitle || '').toLowerCase().indexOf(q) >= 0 ||
          (it.messageText || '').toLowerCase().indexOf(q) >= 0 ||
          String(it.id || '').toLowerCase().indexOf(q) >= 0
        )
      : items
    const tree = buildTree(filteredItems, t)
    // F1：版本家族映射 + 可切换会话（在官方列表且未归档的）。versionMap
    // 用全部快照会话 id 与 lineage 推导；sessions.list 快照同步读取——「切换」
    // 只在会话可导航时渲染，判据两半：会话在官方列表里，且不在归档集合里。
    // 归档会话不是合法的主视图选择（官方 clearMain 把它清成空态），而
    // 0.1.6-alpha.2 起 sessions.list 含归档会话，故归档集合另从 workspaces 快照读。
    const allSessionIds = Array.from(new Set((items || []).map((it) => it.sessionId).filter(Boolean)))
    const versionMap = groupByLineage(allSessionIds, lineage)
    let listById: Record<string, unknown> | null = null
    try {
      if (sessionsSvc && sessionsSvc.list && typeof sessionsSvc.list.getSnapshot === 'function') {
        const snapshot = sessionsSvc.list.getSnapshot()
        listById = (snapshot && snapshot.byId) || null
      }
    } catch (e) { listById = null } // 读取失败按 null：下方 switchable 判据保守不渲染「切换」
    let archivedIds: Set<string> | null = null
    try {
      const snapshot = workspacesSvc && workspacesSvc.list && typeof workspacesSvc.list.getSnapshot === 'function'
        ? workspacesSvc.list.getSnapshot()
        : null
      archivedIds = new Set((snapshot && snapshot.archivedSessionIds) || [])
    } catch (e) { archivedIds = null } // 读取失败按 null：归档检查跳过（退回「在册即可切换」的旧语义）

    // text 传词表键（渲染时才取词）：确认行的说明文案同样随语言
    function confirmDelete(kind: string, key: string, extra: Record<string, unknown>, textKey: string): void {
      setConfirming({ kind, key, extra, text: textKey })
    }
    function renderConfirm(kind: string, key: string, extra: Record<string, unknown>, textKey: string): import('react').ReactNode {
      if (!confirming || confirming.kind !== kind || confirming.key !== key) return null
      return React.createElement(ConfirmRow, {
        text: t(textKey),
        onConfirm: () => {
          const c = confirming
          setConfirming(null)
          run('delete', c.extra, 'manage.done.delete')
        },
        onCancel: () => setConfirming(null)
      })
    }
    // 叶子节点：展开箭头占位 + 时间 + 消息内容摘要（截断 ID）+ 删除图标。
    function renderLeaf(it: ManageListItem): import('react').ReactNode {
      const key = 'snap-' + it.id
      const text = it.messageText
      const title = text || it.id
      const label = text
        ? clockText(it.time) + '  ' + text
        : clockText(it.time) + '  ' + it.id.slice(0, 12) + '…'
      return React.createElement('div', { className: 'dsh-recall-tree-node', key: key },
        React.createElement('div', { className: 'dsh-recall-tree-row', title: title },
          React.createElement('span', { className: 'dsh-recall-tree-toggle-placeholder' }),
          React.createElement('span', { className: 'dsh-recall-tree-label' },
            React.createElement('span', { className: 'dsh-recall-tree-title' }, label),
            // issue #31：仅消息条目没有文件树，标出来——否则用户会以为这条能回退文件
            it.files === false
              ? React.createElement('span', { className: 'dsh-recall-tree-tag', key: 'message-only' }, t('tree.messageOnly'))
              : null,
            // 删除紧贴本条消息摘要（而非行尾）：按行扫读时动作落在「看的那一行」，
            // 不必横跳到右侧同列按钮再回读行号
            React.createElement(DeleteButton, {
              title: t('tree.delete.snapshot.title'),
              onClick: () => confirmDelete('snapshot', key, { messageId: it.id, root: it.root || null }, 'tree.delete.snapshot.confirm')
            })
          )
        ),
        renderConfirm('snapshot', key, { messageId: it.id, root: it.root || null }, 'tree.delete.snapshot.confirm')
      )
    }
    // 会话节点：折叠按钮 + 标题 + 版本/快照数 + 删除图标（贴行内），切换 chip 居尾；子节点为叶子。
    function renderSession(s: TreeSession): import('react').ReactNode {
      const key = 'session-' + (s.root || '') + '-' + s.sessionId
      const open = expanded.has(key)
      const label = s.title || (titlesPending && s.sessionId ? '…' : t('tree.deletedSession'))
      const version = s.sessionId ? versionMap.get(String(s.sessionId)) : null
      const switchable = Boolean(s.sessionId && listById && listById[s.sessionId] && !(archivedIds && archivedIds.has(String(s.sessionId))))
      return React.createElement('div', { className: 'dsh-recall-tree-node', key: key },
        // 整行可点即展开/收起（用户实测反馈：只能精确命中箭头才展开）；行内的
        // 图标/芯片按钮各自 stopPropagation，避免连带折叠。折叠钮仍是键盘与
        // 读屏的可达入口（aria-expanded 播报），行点击只是给鼠标补命中区
        React.createElement('div', { className: 'dsh-recall-tree-row dsh-recall-tree-row-toggle', onClick: () => toggle(key) },
          // V2：折叠钮 span→button——Tab/Enter/Space 可达，读屏经 aria-expanded
          // 与 aria-label 播报展开语义与节点名；CSS 已做 button 重置防视觉回归。
          React.createElement('button', {
            type: 'button',
            className: 'dsh-recall-tree-toggle',
            'aria-expanded': open,
            'aria-label': t(open ? 'tree.collapse' : 'tree.expand', { label }),
            onClick: (e: import('react').MouseEvent) => { e.stopPropagation(); toggle(key) }
          }, chevronIcon(open)),
          React.createElement('span', { className: 'dsh-recall-tree-label', title: s.sessionId || '' },
            React.createElement('span', { className: 'dsh-recall-tree-title' }, label),
            version ? React.createElement('span', { className: 'dsh-recall-tree-meta', title: t('tree.family.title', { chain: version.family.join(' → ') }) }, 'v' + version.index + '/' + version.family.length) : null,
            React.createElement('span', { className: 'dsh-recall-tree-meta' }, t('tree.snapCount', { n: s.items.length })),
            s.sessionId ? React.createElement(DeleteButton, {
              title: t('tree.delete.session.title'),
              onClick: () => confirmDelete('session', key, { scope: 'session', sessionId: s.sessionId, root: s.root || null }, 'tree.delete.session.confirm')
            }) : null
          ),
          // 「切换」留在行尾单占右侧：它是导航动作（离开当前视图），与行内
          // 删除的危险动作分开摆放，避免两类语义在同一个位置上误点
          switchable ? React.createElement('button', {
            type: 'button',
            className: 'dsh-recall-ex-chip',
            title: t('tree.switch.title'),
            onClick: (ev: import('react').MouseEvent) => { ev.stopPropagation(); try {
              // 打开会话：0.1.6-alpha.2 起 ISessions 移除 open（导航归视图所有
              // 者），优先 ui-workspace 的 openSession；旧版回退 sessions.open
              if (uiWorkspaceSvc && typeof uiWorkspaceSvc.openSession === 'function') uiWorkspaceSvc.openSession(s.sessionId as string)
              else if (typeof sessionsSvc.open === 'function') sessionsSvc.open(s.sessionId as string)
            } catch (e) { /* 会话已不可切换则静默 */ } }
          }, t('tree.switch')) : null
        ),
        open ? React.createElement('div', { className: 'dsh-recall-tree-children' }, ...s.items.map(renderLeaf)) : null,
        s.sessionId ? renderConfirm('session', key, { scope: 'session', sessionId: s.sessionId, root: s.root || null }, 'tree.delete.session.confirm') : null
      )
    }
    // 工作区节点：折叠按钮 + 文件夹名 + 会话数/快照数 + 删除图标（贴行内）。
    function renderWorkspace(ws: TreeWorkspace): import('react').ReactNode {
      const key = 'ws-' + ws.root
      const open = expanded.has(key)
      const sessionCount = ws.sessions.length
      const snapCount = ws.sessions.reduce((n, s) => n + s.items.length, 0)
      return React.createElement('div', { className: 'dsh-recall-tree-node', key: key },
        // 整行可点即展开/收起，语义与 renderSession 一致
        React.createElement('div', { className: 'dsh-recall-tree-row dsh-recall-tree-row-toggle', onClick: () => toggle(key) },
          // V2：工作区折叠钮同 renderSession——span→button 键盘化，aria 语义并列播报
          React.createElement('button', {
            type: 'button',
            className: 'dsh-recall-tree-toggle',
            'aria-expanded': open,
            'aria-label': t(open ? 'tree.collapse' : 'tree.expand', { label: ws.name }),
            onClick: (e: import('react').MouseEvent) => { e.stopPropagation(); toggle(key) }
          }, chevronIcon(open)),
          React.createElement('span', { className: 'dsh-recall-tree-label', title: ws.root || '' },
            React.createElement('span', { className: 'dsh-recall-tree-name' }, ws.name),
            React.createElement('span', { className: 'dsh-recall-tree-meta' }, t('tree.wsCount', { n: sessionCount, m: snapCount })),
            ws.root ? React.createElement(DeleteButton, {
              title: t('tree.delete.workspace.title'),
              onClick: () => confirmDelete('workspace', key, { scope: 'workspace', root: ws.root }, 'tree.delete.workspace.confirm')
            }) : null
          )
        ),
        open ? React.createElement('div', { className: 'dsh-recall-tree-children' }, ...ws.sessions.map(renderSession)) : null,
        ws.root ? renderConfirm('workspace', key, { scope: 'workspace', root: ws.root }, 'tree.delete.workspace.confirm') : null
      )
    }
    const treeNodes = tree.map(renderWorkspace)

    // 计数用 Host 返回的全量 total 而非已加载条数
    const loaded = items ? items.length : null
    const countText = loaded === null
      ? t('manage.countLoading')
      : t('manage.countLoaded', { total }) + (limit < total ? t('manage.countShown', { shown: loaded }) : '')
    // 最近错误区：payload 带 kind 时按 kind 取本地词（hint 只是 Host 侧的
    // 中文回落，dict 命中就不必再展示）；未分类错误（kind 缺失/'unknown'）与
    // 未命中词表的 kind 一律回落 host 的 message/hint 原文，保住细节。
    // 原始 message 始终挂在 title 上——本地化换的是「给人看的那行」，
    // 排障要的全文仍一键可查
    function errorLine(e: StatusErrorItem, key: number): import('react').ReactNode {
      const kindKey = e.kind ? 'errorKind.' + e.kind : ''
      const localized = kindKey !== '' && hasTranslation(kindKey)
      const base = localized
        ? t(kindKey) + (typeof e.count === 'number' && e.count > 1 ? t('manage.errors.dup', { n: e.count }) : '')
        : String(e.hint || e.message || '')
      return React.createElement('div', { className: 'dsh-recall-ex-note', key, title: e.message || '' }, clockText(e.time) + '  ' + base)
    }

    function loadMore(): void {
      const next = Math.min(Math.max(total, limit), 2000)
      if (next <= limit) return
      setLimit(next)
      refresh(next)
    }

    return React.createElement('div', { className: 'dsh-recall-ex-card' },
      // 不再渲染「快照管理」内标题：折叠头（SectionToggle）已承担分区标题
      // 角色，展开后再出现同名大标题是纯重复（实测观感噪音）；计数 note 紧跟
      // 折叠头，信息层级 = 折叠头（标题）→ 计数/健康（摘要）→ 搜索 → 树。
      React.createElement('div', { className: 'dsh-recall-ex-note' },
        usage === null
          ? countText + t('manage.countEnd')
          : countText + t('manage.usageSuffix', { size: sizeText(usage) })
      ),
      // V6 健康行徽章化：git 状态用彩色 pill（成功/失败，官方状态行配对），
      // 从普通 note 提升为卡片顶部横幅（渲染在搜索框与树之前）；存储计数
      // 维持文字，避免 pill 堆叠丢失信息。
      health ? React.createElement('div', { className: 'dsh-recall-ex-note', key: 'health' },
        React.createElement('span', {
          className: 'dsh-recall-health-pill ' + (health.gitAvailable ? 'dsh-recall-health-pill-ok' : 'dsh-recall-health-pill-bad'),
          title: t('manage.health.gitTitle')
        }, t(health.gitAvailable ? 'manage.health.gitOk' : 'manage.health.gitBad')),
        t('manage.health.stores', { n: health.homeStores }) + (health.fallbackStores ? t('manage.health.storesFallback', { n: health.fallbackStores }) : '')
      ) : null,
      // 搜索行：图标绝对定位在框内左侧（pointer-events:none 不挡点击），输入框
      // 靠 padding-left 让出图标位；高度由 CSS 的 .dsh-recall-search 覆写加高 20%
      React.createElement('div', { className: 'dsh-recall-search' },
        React.createElement('svg', {
          className: 'dsh-recall-search-icon', width: 16, height: 16, viewBox: '0 0 48 48',
          fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true
        },
          React.createElement('path', { d: 'M21 38C30.3888 38 38 30.3888 38 21C38 11.6112 30.3888 4 21 4C11.6112 4 4 11.6112 4 21C4 30.3888 11.6112 38 21 38Z' }),
          React.createElement('path', { d: 'M26.657 14.3431C25.2093 12.8954 23.2093 12 21.0001 12C18.791 12 16.791 12.8954 15.3433 14.3431' }),
          React.createElement('path', { d: 'M33.2216 33.2217L41.7069 41.707' })
        ),
        React.createElement('input', {
          className: 'dsh-recall-ex-input',
          placeholder: t('manage.search.placeholder'),
          'aria-label': t('manage.search.aria'),
          value: query,
          spellCheck: false,
          onChange: (e) => setQuery(e.target.value),
        })
      ),
      // 读取失败提示：role=alert 让读屏立即播报；「重试」复用 refresh，不新造入口
      listError
        ? React.createElement('div', { key: 'list-error', className: 'dsh-recall-list-error', role: 'alert' },
            React.createElement('span', { className: 'dsh-recall-list-error-text' }, listError),
            React.createElement('button', { type: 'button', className: 'dsh-recall-ex-chip', onClick: () => refresh() }, t('common.retry'))
          )
        : null,
      // V3 加载骨架：items===null 表示首查未回——用 5 条 pulse 灰条占位替代
      // 打开快照管理时的一段空白；aria-hidden 纯装饰不打扰读屏
      items === null
        ? React.createElement('div', { className: 'dsh-recall-tree-skeleton', 'aria-hidden': true },
            ...[1, 2, 3, 4, 5].map((n) => React.createElement('div', { key: 'sk-' + n, className: 'dsh-recall-tree-skeleton-row' }))
          )
        : null,
      treeNodes.length > 0 ? React.createElement('div', { className: 'dsh-recall-tree' }, ...treeNodes) : null,
      items && items.length === 0 && !q
        ? React.createElement('div', { className: 'dsh-recall-empty', key: 'empty' }, t('manage.empty'))
        : null,
      q && filteredItems && filteredItems.length === 0
        ? React.createElement('div', { className: 'dsh-recall-empty', key: 'no-match' }, t('manage.emptyFiltered'))
        : null,
      renderDeleteAllConfirm(),
      // V6：错误区从卡片最底上移到操作区上方（fail-loud 可见性）；标题
      // error 色带条数徽章，时间戳格式维持原样
      errors && errors.length > 0
        ? React.createElement('div', { key: 'errors' },
            React.createElement('div', { className: 'dsh-recall-errors-title' }, t('manage.errors.title', { n: errors.length })),
            (showAllErrors ? errors : errors.slice(0, 5)).map(errorLine),
            React.createElement('div', { className: 'dsh-recall-panel-actions' },
              errors.length > 5 ? React.createElement('button', { type: 'button', className: 'dsh-recall-ex-chip', onClick: () => setShowAllErrors((v) => !v) }, showAllErrors ? t('manage.errors.collapse') : t('manage.errors.expand', { n: errors.length })) : null,
              React.createElement('button', { type: 'button', className: 'dsh-recall-ex-chip', onClick: clearErrors }, t('manage.errors.clear'))
            )
          )
        : null,
      React.createElement('div', { className: 'dsh-recall-panel-actions' },
        state.message ? React.createElement('span', { role: 'status', 'aria-live': 'polite', className: 'dsh-recall-ex-status' + (state.error ? ' dsh-recall-ex-status-error' : ' dsh-recall-ex-status-success') }, (state.error ? t('common.errorPrefix') : '') + state.message) : null,
        limit < total ? React.createElement('button', {
          type: 'button',
          className: 'dsh-recall-btn',
          disabled: state.busy,
          onClick: loadMore
        }, t('manage.loadMore')) : null,
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn', disabled: state.busy, onClick: () => refresh() }, t('manage.refresh')),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-recall-btn',
          disabled: state.busy,
          title: t('manage.gc.title'),
          onClick: () => run('gc', {}, 'manage.done.gc')
        }, t('manage.gc')),
        // V5：全部删除固定为操作区最后一个按钮（排在立即 gc 之后）——即使
        // 「加载更多」出现/消失也不漂移；danger 与普通按钮间在 panel-actions
        // 统一 gap:8px 之上再加 btn-gap 的 8px 物理间隔，危险按钮与常规按钮
        // 拉开距离防误点
        React.createElement('button', {
          type: 'button',
          className: 'dsh-recall-btn dsh-recall-btn-danger dsh-recall-btn-gap',
          disabled: state.busy,
          title: t('manage.deleteAll.title'),
          onClick: () => setConfirming({ kind: 'all' })
        }, t('manage.deleteAll'))
      )
    )
  }

  return { ManageCard }
}