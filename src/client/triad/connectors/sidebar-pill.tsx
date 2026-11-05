/**
 * dsh-seeker-bot — 侧栏底部「MCP 连接器」胶囊（连接器的常驻入口）。
 *
 * 用户要求（2026-11-03）：
 * 「把操作间的连接器的菜单变成一个胶囊卡片放在左侧侧边栏最下面的右侧位置，
 *   胶囊里左侧是文字『MCP服务器』右侧是已经安装的几个 mcp 图标圆形半叠放，
 *   超过 3 个后面就显示 ... 代表更多」。
 * 2026-11-05：胶囊与弹窗标题由「MCP服务器」统一改为「MCP 连接器」——
 * 与弹窗内的「连接器」面板、安装按钮、功能开关同名，不再用「服务器」。
 *
 * ── 为什么挂在官方设置行里，而不是注册一个 slot ──────────────────────
 * 官方 ui-sidebar 的底部（footArea）只有两条纵向排列的槽位：
 *   footerActions → `sidebar.footer.action`（对话动态胶囊那一行）
 *   settingsArea  → `sidebar.settings`（账号 / 设置行）
 * 没有「设置行右侧」的槽位。而用户要的位置就是最下面那一行（账号行）的右侧，
 * 所以沿用本插件对官方 DOM 的既有做法（见 hub/nav-sections.tsx 的
 * ensureHostPlaced）：把自己的宿主裸节点插进 `[data-slot="sidebar.settings"]`
 * 的 triggerRow 末尾；triggerRow 本身是 flex，宿主里的胶囊天然靠右。
 * 只**追加**节点，不改官方任何节点、不改它的结构；官方 React 重渲染把宿主
 * 摘掉时由 MutationObserver + 1.5s 低频轮询补位（与 nav-sections 同一套）。
 *
 * ── 数据口径 ─────────────────────────────────────────────────────────
 * 「已安装 MCP」的唯一真相是宿主 `/api/triad/mcp-status`：它合并了
 * cordis.patch.yml 里的 mcp-client 条目与运行时注册的工具（含 disabled 标记）。
 * 图标来自 `/api/triad/mcp-catalog` 的 iconFile；serverName 与目录 id 的换算
 * 规则与宿主 toServerName() 完全一致（非 [A-Za-z0-9_-] 换成短横线、截 32 位），
 * 目录里没有的 server（用户手写配置）回落到首字母圆标。
 *
 * ── 与操作间菜单的关系 ───────────────────────────────────────────────
 * hub/nav-sections.tsx 的 registerDefaultEntries() 已不再注册
 * `workbench-connectors`（连接器不再出现在操作间列表里），入口只剩这颗胶囊
 * 与工作台页面本身。点击胶囊 = 打开居中的连接器弹窗卡片（见 ConnectorModal.tsx）。
 */
import { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ErrorBoundary } from '../../error-boundary.js'
import { useFeature } from '../../features/gate.tsx'
import { useRail } from '../sidebar-nav.js'
import { WORKBENCH_TAB_FEATURE } from '../hub/row-flyout.js'
import { openConnectorModal } from './ConnectorModal.js'
import {
  mergeInstalledIcons,
  type InstalledMcpIcon,
  type McpCatalogPayload,
  type McpStatusPayload,
} from './sidebar-pill-model.js'

/** 宿主节点 id（本模块创建；display:contents 让胶囊直接成为 triggerRow 的 flex 项）。 */
const HOST_ID = 'dsh-mcp-pill-host'
/** 官方设置行槽位：内容为 display:contents 的包裹层。 */
const SETTINGS_SLOT_SELECTOR = '[data-slot="sidebar.settings"]'
/** triggerRow 的类名带 CSS Modules 哈希前缀，用属性包含匹配（前缀会变）。 */
const TRIGGER_ROW_SELECTOR = '[class*="_triggerRow"]'
/** 已安装 MCP 的刷新间隔（ms）：本机接口，低频轮询只为「装完立刻能看到」。 */
const POLL_MS = 8000
/** 胶囊右侧最多展示几个圆形图标；其余收进末尾的省略号。 */
const MAX_AVATARS = 3

/** 当前活跃挂载器的清理函数（单例；HMR / 双 apply 只保留一份）。 */
let attachedCleanup: (() => void) | null = null

/** 拉一次「已安装 MCP」清单（失败静默返回空数组：胶囊退化成只有文字）。 */
async function fetchInstalledMcps(): Promise<InstalledMcpIcon[]> {
  try {
    const [statusRes, catalogRes] = await Promise.all([
      fetch('/api/triad/mcp-status', { headers: { accept: 'application/json' }, cache: 'no-store' }),
      fetch('/api/triad/mcp-catalog', { headers: { accept: 'application/json' }, cache: 'no-store' }),
    ])
    if (!statusRes.ok) return []
    const status = (await statusRes.json()) as McpStatusPayload
    const catalog = catalogRes.ok ? ((await catalogRes.json()) as McpCatalogPayload) : {}
    return mergeInstalledIcons(status, catalog)
  } catch {
    return []
  }
}

/**
 * 订阅已安装 MCP 清单。
 *
 * 挂载即拉 + 8s 轮询 + 页面重新可见时补拉：安装/卸载发生在连接器页，用户回到
 * 侧栏时最多 8s 就能看到图标变化；再快就会让一个纯装饰胶囊变成请求噪音。
 * @param active 胶囊是否真的可见（组件开关打开且非 rail）。不可见时**停止轮询**
 *   ——胶囊不画，两个接口没必要每 8 秒各拉一次（hooks 不能条件调用，只能在
 *   effect 内部门控）。
 * @returns 当前已安装 MCP 清单。
 */
function useInstalledMcps(active: boolean): InstalledMcpIcon[] {
  const [items, setItems] = useState<InstalledMcpIcon[]>([])
  useEffect(() => {
    if (!active) return undefined
    let stopped = false
    let inFlight = false
    const tick = (): void => {
      if (inFlight) return
      inFlight = true
      void fetchInstalledMcps()
        .then((next) => { if (!stopped) setItems(next) })
        .finally(() => { inFlight = false })
    }
    tick()
    const timer = window.setInterval(tick, POLL_MS)
    const onVisibility = (): void => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])
  return items
}

/**
 * 一颗圆形图标：图片加载失败（或目录没图标）时回落成首字母圆标。
 *
 * 圆与圆之间用侧栏底色描边（--dsw-specific-sidebar-fill）分隔，形成
 * 「半叠放」的咬合感；承载叠放间距的是 CSS 的 margin-left:-6px。
 */
function AvatarIcon({ item }: { item: InstalledMcpIcon }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const showImage = item.iconUrl !== null && !broken
  return (
    <span
      className="dmp-av"
      data-disabled={item.disabled ? 'true' : undefined}
      title={item.disabled ? item.name + '（已禁用）' : item.name}
    >
      {showImage
        ? <img src={item.iconUrl ?? ''} alt="" loading="lazy" onError={() => { setBroken(true) }} />
        : <span className="dmp-av-fallback" aria-hidden="true">{item.fallback}</span>}
    </span>
  )
}

/** 胶囊属性。 */
export interface ConnectorPillProps {
  /**
   * 是否用**官方侧栏**的 rail 折叠态作为消失判据。
   *
   * Work 侧栏（独立 root，挂在官方 settings 行）默认 true：折叠态连账号行都只剩
   * 一个头像，塞不下「MCP 连接器」这几个字，胶囊整颗让位。
   * Bot 侧栏（Personal App 的 64px 图标轨道）有自己的 collapsed 状态，整行不渲染
   * 胶囊即可；此时传 false——否则官方侧栏恰好被折叠时，Bot 里的胶囊会被误藏。
   */
  checkRail?: boolean
}

/**
 * 胶囊本体。
 *
 * rail（56px 折叠态）下整颗让位：折叠态连账号行都只剩一个头像，塞不下
 * 「MCP 连接器」这几个字；展开侧栏后点胶囊即可。
 * @returns 胶囊按钮；rail 时 null。
 */
export function ConnectorPill({ checkRail = true }: ConnectorPillProps = {}): JSX.Element | null {
  // 组件开关（work.connectors）：关掉连接器时这颗入口同一拍消失，
  // 不会留下一个点进去空白弹窗的死胶囊（与工作台其它入口共用同一份开关）。
  const enabled = useFeature(WORKBENCH_TAB_FEATURE.connectors)
  const rail = useRail()
  const active = enabled && (!checkRail || !rail)
  const items = useInstalledMcps(active)
  if (!active) return null
  // 名称多了以后原生 tooltip / aria-label 会拖得很长：只报前 5 个 + 总数。
  const names = items.map((item) => item.name)
  const nameList = names.slice(0, 5).join('、') + (names.length > 5 ? ' 等 ' + String(names.length) + ' 个' : '')
  const summary = items.length === 0
    ? '还没有已安装的 MCP 连接器，点击打开连接器'
    : '已安装 ' + String(items.length) + ' 个 MCP：' + nameList
  const visible = items.slice(0, MAX_AVATARS)
  return (
    <button
      type="button"
      className="dmp-pill"
      data-mcp-pill="true"
      title={summary}
      aria-label={'MCP 连接器：' + summary}
      onClick={openConnectorModal}
    >
      <span className="dmp-label">MCP 连接器</span>
      {items.length > 0 && (
        <span className="dmp-stack" aria-hidden="true">
          {visible.map((item) => <AvatarIcon key={item.key} item={item} />)}
          {items.length > MAX_AVATARS ? <span className="dmp-more">…</span> : null}
        </span>
      )}
    </button>
  )
}

/* ───────────────────────────── 样式 ───────────────────────────── */

const STYLE_ID = 'dsh-mcp-pill-styles'

/**
 * 胶囊样式：中性灰阶（与侧栏其它控件同一套语言），不引入第二枚强调色。
 *
 * 尺寸按设置行 44px 高反推：胶囊 29px 高、图标 18px，和账号头像（20px）同一档；
 * 字号 12px 比账号名（14px）低一档，视觉上明确是「附注」而不是第二个账号。
 * Work 侧栏：亮/暗各一套显式色值（见下），只把「圆环分隔色」交给官方
 * --dsw-specific-sidebar-fill。
 * Bot 侧栏：胶囊也在 Personal App 的底部出现（用户 2026-11-03 追加要求
 * 「bot模式下也要这个」），那边自带 --pa-* 亮/暗两套变量，所以再补一组
 * .pa-root 作用域的颜色，跟随 Bot 主题而不是官方 body 属性。
 */
const SHEET = `
/* 宿主：display:contents，让胶囊直接成为官方 triggerRow 的 flex 项；空态不占位 */
#${HOST_ID}{display:contents}
.dmp-pill{flex:0 1 auto;order:1;min-width:0;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;
  height:29px;margin-left:auto;padding:0 10px 0 12px;border-radius:999px;
  border:.5px solid rgba(0,0,0,.045);background:rgba(38,49,72,.06);color:#61666b;
  font-family:inherit;font-size:12px;font-weight:500;
  line-height:17px;white-space:nowrap;cursor:pointer;user-select:none;
  transition:background-color 140ms ease,color 140ms ease,border-color 140ms ease}
.dmp-pill:hover{background:rgba(38,49,72,.10);border-color:rgba(0,0,0,.10);color:#0f1115}
.dmp-pill:active{background:rgba(38,49,72,.14)}
/* 深色主题：显式两套（与 row-flyout / done-pill 同用的 body[data-ds-dark-theme] 判据）。
   背景/文字不走 --dsw-alias-interactive-*：实测该 token 在侧栏底部读到的继承值
   与胶囊实际计算值不同步（切主题时背景不跟着变），显式色值最稳。 */
body[data-ds-dark-theme] .dmp-pill{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.10);color:#cfd3d6}
body[data-ds-dark-theme] .dmp-pill:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.18);color:#f9fafb}
body[data-ds-dark-theme] .dmp-pill:active{background:rgba(255,255,255,.16)}
.dmp-pill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4d6bfe);
  outline-offset:2px}
.dmp-label{flex:0 1 auto;min-width:0;letter-spacing:.01em;max-width:96px;overflow:hidden;text-overflow:ellipsis}
.dmp-stack{flex:none;display:inline-flex;align-items:center}
.dmp-av{position:relative;flex:none;width:18px;height:18px;box-sizing:border-box;border-radius:50%;
  border:2px solid var(--dsw-specific-sidebar-fill,#fff);background:rgba(127,127,127,.14);
  overflow:hidden;display:inline-flex;align-items:center;justify-content:center;
  color:#61666b;font-size:9.5px;line-height:1;font-weight:600;
  transition:opacity 140ms ease}
body[data-ds-dark-theme] .dmp-av{background:rgba(255,255,255,.12);border-color:#1b1b1c;color:#b8bcc1}
.dmp-av + .dmp-av,.dmp-more{margin-left:-6px}
.dmp-av img{width:100%;height:100%;object-fit:cover;display:block}
.dmp-av[data-disabled='true']{opacity:.42}
.dmp-av-fallback{transform:translateY(.5px)}
.dmp-more{flex:none;width:18px;height:18px;box-sizing:border-box;border-radius:50%;
  border:2px solid var(--dsw-specific-sidebar-fill,#fff);background:rgba(127,127,127,.20);
  display:inline-flex;align-items:center;justify-content:center;
  color:#8a8a8a;font-size:10px;line-height:1;letter-spacing:0}
.dmp-pill:hover .dmp-more{background:rgba(127,127,127,.28)}
body[data-ds-dark-theme] .dmp-more{background:rgba(255,255,255,.16);border-color:#1b1b1c;color:#b8bcc1}
body[data-ds-dark-theme] .dmp-pill:hover .dmp-more{background:rgba(255,255,255,.22)}
/* Bot 侧栏：颜色跟随 Personal App 的 --pa-* 变量（它有独立的亮/暗两套主题，
   不能只看 body[data-ds-dark-theme]）。
   ⚠ 这里必须把 height / padding / font-size / font-weight / border 整套显式重写：
   Personal 基础样式里有一条 ".pa-root button { font: inherit; padding: 0; border: 0 }"
   （特异性 0,1,1），会压掉胶囊自己的 .dmp-pill（0,1,0）——Bot 版内边距归零、
   字重变 400、字号变成继承的 14px，和 Work 版（固定 12px）视觉大小不一致。
   胶囊是同一颗控件，两处必须统一成同一套像素规格（用户 2026-11-03 反馈）。 */
body .pa-root .dmp-pill{height:29px;padding:0 10px 0 12px;font-size:12px;font-weight:500;
  line-height:17px;box-sizing:border-box;margin-right:-4px;
  border:.5px solid rgba(0,0,0,.045);background:rgba(38,49,72,.06);color:#61666b}
body .pa-root .dmp-pill:hover{background:rgba(38,49,72,.10);border-color:rgba(0,0,0,.10);color:#0f1115}
body .pa-root .dmp-pill:active{background:rgba(38,49,72,.14)}
body .pa-root .dmp-av{border-color:var(--dsw-specific-sidebar-fill,#fff);
  background:rgba(127,127,127,.14);color:#61666b}
body .pa-root .dmp-more{border-color:var(--dsw-specific-sidebar-fill,#fff);
  background:rgba(127,127,127,.20);color:#8a8a8a}
body .pa-root .dmp-pill:hover .dmp-more{background:rgba(127,127,127,.28)}
/* Bot 深色主题：与 Work 的深色胶囊同一套色值（官方 body 属性 + .pa-root 双重作用域，
   特异性高于上面的亮色规则）。 */
body[data-ds-dark-theme] .pa-root .dmp-pill{background:rgba(255,255,255,.07);
  border-color:rgba(255,255,255,.10);color:#cfd3d6}
body[data-ds-dark-theme] .pa-root .dmp-pill:hover{background:rgba(255,255,255,.12);
  border-color:rgba(255,255,255,.18);color:#f9fafb}
body[data-ds-dark-theme] .pa-root .dmp-pill:active{background:rgba(255,255,255,.16)}
body[data-ds-dark-theme] .pa-root .dmp-av{border-color:#1b1b1c;background:rgba(255,255,255,.12);color:#b8bcc1}
body[data-ds-dark-theme] .pa-root .dmp-more{border-color:#1b1b1c;background:rgba(255,255,255,.16);color:#b8bcc1}
body[data-ds-dark-theme] .pa-root .dmp-pill:hover .dmp-more{background:rgba(255,255,255,.22)}
@media (prefers-reduced-motion:reduce){.dmp-pill,.dmp-av{transition:none}}
`

/** 注入胶囊样式（幂等，按内容比对判重——升级后旧样式也要能换掉）。 */
function ensureMcpPillStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) {
    if (existing.textContent !== SHEET) existing.textContent = SHEET
    return
  }
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.dataset.plugin = 'dsh-seeker-bot'
  tag.textContent = SHEET
  document.head.appendChild(tag)
}

/* ───────────────────────────── 挂载 ───────────────────────────── */

/** 找到官方设置行的 triggerRow（找不到返回 null，绝不抛）。 */
function findSettingsRow(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const slot = document.querySelector(SETTINGS_SLOT_SELECTOR)
  if (slot === null) return null
  const row = slot.querySelector(TRIGGER_ROW_SELECTOR)
  return row instanceof HTMLElement ? row : null
}

/**
 * 挂载侧栏底部 MCP 胶囊（幂等单例）。返回清理函数交给 `ctx.effect`。
 *
 * 三条就位通道（与 hub/nav-sections.tsx 完全同一套，缺一条就有可见空窗）：
 *  1. 立即 place()（插件晚于官方侧栏渲染时一拍到位）；
 *  2. 设置行还没出现时盯 body 子树等它出现（5s 硬超时，官方 DOM 大改版不永久挂载）；
 *  3. 1.5s 低频兜底（父节点被整体替换、HMR、React 重建等观察失联场景）。
 *
 * 宿主是插进官方 React 树的裸节点，官方设置组件任何一次重渲染都可能把它
 * 回收——所以还要盯着 triggerRow 的直接父节点补位（只观察 childList）。
 * @returns 清理函数。
 */
export function attachConnectorPill(): () => void {
  if (typeof document === 'undefined') return () => {}
  // 单例守卫：HMR / 双 apply 时同一 host 上出现两个 React root 会互相打架
  // （React 告警、双份轮询与观察，清理后另一个指向已移除节点 → 胶囊空白）。
  if (attachedCleanup !== null) return attachedCleanup
  ensureMcpPillStyles()

  let root: Root | null = null
  let rootEl: HTMLDivElement | null = null
  let rowObserver: MutationObserver | undefined
  let observedRow: HTMLElement | null = null
  let anchorObserver: MutationObserver | undefined
  let anchorDeadline = 0
  let anchorGaveUp = false
  let timer = 0
  let disposed = false

  const host = (): HTMLDivElement | null => document.getElementById(HOST_ID) as HTMLDivElement | null

  const render = (): void => {
    const el = host()
    if (el === null) return
    // root 必须跟着宿主节点走：官方整体重建 settings 子树后，旧宿主脱离文档，
    // 只认「root 已存在」会一直往旧节点渲染，新宿主永远空白（复核 P1）。
    if (root === null || rootEl !== el) {
      if (root !== null) {
        try { root.unmount() } catch { /* 旧根已随节点脱离，忽略 */ }
      }
      root = createRoot(el)
      rootEl = el
    }
    root.render(
      <ErrorBoundary label="MCP 胶囊" fallback={null}>
        <ConnectorPill />
      </ErrorBoundary>,
    )
  }

  /** 把宿主补到 triggerRow 末尾（幂等：位置没变时不动 DOM）。 */
  const ensurePlaced = (): boolean => {
    const row = findSettingsRow()
    if (row === null) return false
    let el = host()
    if (el === null) {
      el = document.createElement('div')
      el.id = HOST_ID
      el.dataset.plugin = 'dsh-seeker-bot'
    }
    // 只补「不在行里」的情况：视觉位置交给 CSS 的 order（胶囊恒排最后），
    // 不再为了永远做最后一个子节点而跟官方后来插入的 indicator 抢位置
    // （复核 P2-3：否则官方 indicator 从 null 变节点时会看到胶囊跳一格）。
    if (el.parentElement !== row) row.appendChild(el)
    return true
  }

  /** 盯 triggerRow 的子节点：本插件宿主被 React 摘掉时立刻补回。 */
  const watchRow = (): void => {
    const row = findSettingsRow()
    if (row === null) return
    if (rowObserver !== undefined && observedRow === row) return
    rowObserver?.disconnect()
    observedRow = row
    rowObserver = new MutationObserver(() => {
      if (disposed) return
      if (!row.contains(host())) place()
    })
    rowObserver.observe(row, { childList: true })
  }

  /** 设置行还没出现时盯 body 子树等它出现（5s 硬超时）。 */
  const stopAnchorWatch = (): void => {
    anchorObserver?.disconnect()
    anchorObserver = undefined
    if (anchorDeadline !== 0) {
      window.clearTimeout(anchorDeadline)
      anchorDeadline = 0
    }
  }

  const watchAnchor = (): void => {
    if (anchorGaveUp || anchorObserver !== undefined || typeof MutationObserver === 'undefined') return
    anchorObserver = new MutationObserver(() => { place() })
    anchorObserver.observe(document.body, { childList: true, subtree: true })
    anchorDeadline = window.setTimeout(() => {
      anchorDeadline = 0
      anchorGaveUp = true
      stopAnchorWatch()
    }, 5000)
  }

  const place = (): void => {
    if (disposed) return
    if (!ensurePlaced()) {
      watchAnchor()
      return
    }
    stopAnchorWatch()
    render()
    watchRow()
  }

  place()
  timer = window.setInterval(place, 1500)

  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    window.clearInterval(timer)
    stopAnchorWatch()
    rowObserver?.disconnect()
    rowObserver = undefined
    observedRow = null
    if (root !== null) {
      try { root.unmount() } catch { /* 卸载失败也要继续摘宿主 */ }
    }
    root = null
    rootEl = null
    host()?.remove()
    if (attachedCleanup === cleanup) attachedCleanup = null
  }
  attachedCleanup = cleanup
  return cleanup
}
