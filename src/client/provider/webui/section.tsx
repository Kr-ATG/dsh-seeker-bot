/**
 * dsh-seeker-bot — 「供应商」设置页（原 dsh-provider-hub 的独立设置页）。
 *
 * **座位回到官方「设置」弹窗**的 `settings.section`（2026-10-05 用户点名：
 * 「还是把供应商配置和代理放在设置里面吧」）。此前一轮曾把整页搬进工作台
 * 一个 Tab，现按用户要求撤回——工作台不再有「供应商」Tab，设置导航里也没有
 * 官方「模型」页（hideOfficialModelsNav 恢复），两页管同一件事只会让用户
 * 不知道该点哪个。
 *
 * 左导航（ChatProviderList：已配置/目录预设/添加自定义）+ 右详情
 * （ChatProviderDetail：API Key、Base URL、协议、模型列表 + 获取可用模型 +
 * 🔍 检测推理等级）。底部含生图 / 生视频两块，
 * 以及**网络代理**全宽区块（总开关 + 地址 + 连通性自检 + 生效范围）。
 *
 * 官方设置弹窗 800×800 原样沿用（2026-10-31 用户点名「不要缩放了」：此前这一页
 * 被撑到 1680 宽并吃满视口，打开/切走时整页放大又缩回）。页面内部布局按容器实宽
 * 自适应：窄屏纵向堆叠，宽屏三栏（阈值见 WIDE_LAYOUT_PX）。
 *
 * 推理检测走本插件新版 `/api/detect-capability`：默认先测 max，网关拒绝且
 * 错误里带合法值表时直接按表填入并自动落盘（含 OpenAI 系 off:'none'）。
 * createElement 风格（不转 JSX，由 esbuild 处理）。
 */
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only：拉入 shell 的 SlotMap 合并声明（settings.section 整页槽）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ChatProviderList } from './chat/ChatProviderList.tsx'
import { ChatProviderDetail } from './chat/ChatProviderDetail.tsx'
import type { ChatProviderMode, ChatProviderTarget } from './chat/ChatProviderDetail.tsx'
import { ModelsSettingsStore, deriveKeyRef } from './chat/store.ts'
import type { ModelsSettingsState, ProviderRow } from './chat/store.ts'
import { inlineCapGroupStyle, inlineCapPillOnStyle, inlineCapPillStyle } from './chat/ModelListEditor.tsx'
import { injectStyles, hideOfficialModelsNav } from './styles.ts'
import { ImageModelBlock } from './image/ImageModelBlock.tsx'
import { VideoModelBlock } from './video/VideoModelBlock.tsx'
import { LiveVendorList } from './voice/LiveVendorList.tsx'
import { LiveVendorDetail } from './voice/LiveVendorDetail.tsx'
import { useLiveVendorStore } from './voice/store.ts'
import { createLegacyApi } from './api-adapter.ts'
import { ProxyPanel } from '../panel/proxy-panel.tsx'
import { getService } from '../../client-ctx.js'
import { FeatureGate, featureEnabledNow, onFeatureChange } from '../../features/gate.tsx'

/** 供应商页需要的依赖（由 settings.section 的 inject 面提供）。 */
export interface SupplierInjected {
  controller: ModelsSettingsStore
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
}

/**
 * 构造供应商页依赖（wire 面 + 快照 store + 三处远程事件订阅）。
 *
 * 由 {@link applySupplierSection} 在插件 apply 时调一次，store 随插件生命周期
 * 存活——页面只是渲染它，切走再切回来不重建（重建会丢掉已加载的供应商目录）。
 * @param ctx - client root context。
 * @returns 依赖对象与订阅清理函数。
 */
export function createSupplierInjected(ctx: ClientContext): { injected: SupplierInjected; dispose: () => void } {
  // wire 面经适配器装进旧信封（connection.api 已不存在，见 api-adapter）。
  //
  // 取服务必须用 `ctx.get('remote.llm')` 这种**完整子服务名**逐个读：cordis 的
  // ctx 对 `remote.llm` / `remote.settings` / `remote.credentials` 各自做
  // inject 检查，先取 `remote` 再点 `.llm` 会抛
  // `cannot get property "remote.llm" without inject`（页面实测）。
  const api = createLegacyApi({
    remote: {
      settings: getService('remote.settings'),
      credentials: getService('remote.credentials'),
      llm: getService('remote.llm'),
      $on: remoteOn(),
    },
    configForms: getService('configForms'),
    settingsScope: getService('settingsScope'),
  } as any)
  const controller = new ModelsSettingsStore(api)
  const refresh = (): void => {
    if (controller.store.getSnapshot().status === 'idle') return
    void controller.load()
  }
  const on = remoteOn()
  const disposers = [
    on?.('settings/document-updated', refresh),
    on?.('credentials/reference-updated', refresh),
    on?.('llm/adapters-updated', refresh),
  ]
  return {
    injected: { controller, api },
    dispose: () => { for (const dispose of disposers) { try { dispose?.() } catch { /* 忽略 */ } } },
  }
}

/**
 * 取 `remote.$on`（事件订阅面）。
 *
 * `$on` 是 remote 服务自身的方法而不是子服务，但在它的对象上做属性访问仍可能
 * 撞上 cordis 的 inject 代理，所以单独包一层 try/catch；取不到时页面只是不再
 * 自动刷新，仍可手动重试。
 * @returns 事件订阅函数，或 undefined。
 */
function remoteOn(): ((event: string, fn: () => void) => () => void) | undefined {
  try {
    const remote = getService<any>('remote')
    return typeof remote?.$on === 'function' ? remote.$on.bind(remote) : undefined
  } catch {
    return undefined
  }
}

/** uSES 桥：把 snapshot store 订阅成 React 状态。 */
function useSnapshot<T>(store: { subscribe(fn: () => void): () => void; getSnapshot(): T }): T {
  return useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.getSnapshot(),
  )
}

/** 从 ProviderRow 构造详情目标（credentialRef 仅页面惯例引用下可写才带上）。 */
function targetOf(row: ProviderRow, mode: ChatProviderMode): ChatProviderTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef && row.credential?.configured === true && row.credential.writable ? managedRef : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(row.entry.declared === true ? { declared: true } : {}),
    mode,
  }
}

/** 自定义提供方目标：route id 由卡片内输入，写入 pi-ai 命名空间。 */
const CUSTOM_TARGET: ChatProviderTarget = {
  provider: '',
  displayName: '',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers'],
  mode: 'custom',
}

/** 左导航固定宽度（宽度滑动过渡由 .phub-navwrap 的 transition 承担）。 */
const NAV_WIDTH = 232

/* 两栏布局：左栏 flex-start（它自己 sticky 且限高），右栏 stretch 撑满。
   flexWrap 常开：窄屏时模型设置卡靠换行落到第二行（全宽），宽屏时成为第三列。
   这样 .phub-blocks 的 DOM 位置**始终在 hub 内部**——原先按 wide 在「hub 内」
   与「hub 后」两处渲染，切档时 React 会卸载重建整棵模型卡子树（重新拉一次
   模型目录），观感上就是「放大时第三列啪地插进来」。 */
const hubLayoutStyle: Record<string, string | number> = {
  display: 'flex', alignItems: 'flex-start', gap: 16, minWidth: 0, width: '100%', flexWrap: 'wrap',
}

const detailColStyle: Record<string, string | number> = {
  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignSelf: 'stretch',
}

/* 详情面板：规格由 .phub-panel 承担（与底部模型卡的 .phub-block 同一套 token），
   这里只补 flex 让它填满左栏高度。
   限高走 --phub-max-h（弹窗加高后由 styles.ts 定义在 dialog 上、继承下来）：
   写死 100vh-150px 在 1080p 上算出 930px，比弹窗内容区还高，结果是内外两条
   滚动条打架；取不到变量时回落到同一算式，老宿主不会因此没有限高。 */
const detailPanelStyle: Record<string, string | number> = {
  display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, flex: 1,
  maxHeight: 'var(--phub-max-h, calc(100vh - 150px))', overflowY: 'auto', overflowX: 'hidden',
}

/* 右侧面板工具条：返回列表在左、关闭在右（打开详情时左栏收起，返回入口必须在
   面板里，否则用户会被困在详情里）。 */
const panelToolbarStyle: Record<string, string | number> = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: -6,
}

/* 返回供应商列表：文字小按钮，与官方 linkButton 同量级（28px 高、无边框）。 */
const panelBackBtnStyle: Record<string, string | number> = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  height: 28, padding: '0 8px', border: 'none', borderRadius: 6, background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #4e5969)', fontSize: 12, lineHeight: '20px', cursor: 'pointer',
}

/* 右侧面板关闭按钮：28×28 图标钮。 */
const panelCloseBtnStyle: Record<string, string | number> = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 28, height: 28, padding: 0,
  border: 'none', borderRadius: 6, background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary, #8f959e)',
  fontSize: 14, lineHeight: '20px', cursor: 'pointer', flex: 'none',
}

/* 占位卡：规格由 .phub-placeholder 承担（虚线 + 淡入），这里只留结构。 */
const placeholderStyle: Record<string, string | number> = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
}

/**
 * 渲染「供应商」设置页（settings.section 座位）。
 *
 * 依赖由 `applySupplierSection` 经 slot 的 `inject` 面传进来（store 是插件级
 * 单例，不随页面挂卸重建）；缺依赖时渲染 null，不炸整个设置弹窗。
 * @param props - settings.section 注入的依赖。
 * @returns 供应商页面。
 */
export function SupplierSection(props: Partial<SupplierInjected> = {}): unknown {
  const { controller, api } = props
  useEffect(() => {
    injectStyles()
  }, [])
  if (controller === undefined || api === undefined) return null
  return h(Loaded, { injected: { controller, api } })
}

/**
 * 渲染期门：供应商组件行关闭时整页不渲染（设置导航里也不再出现）。
 *
 * 与 hideOfficialModelsNav 的联动在 applySupplierSection 里：关闭时把官方
 * 「模型」页恢复回来，否则用户既没有供应商页、也没有官方模型页，等于把模型
 * 配置入口整个藏掉。
 */
function SupplierSectionGated(props: Partial<SupplierInjected> = {}): unknown {
  return h(FeatureGate, { feature: 'host.provider-hub' }, h(SupplierSection, props))
}

/**
 * 注册「供应商」设置页，并隐藏官方「模型」页导航项。
 *
 * 座位参数（id `provider-hub` / order 10 / label「供应商」）与迁进工作台之前
 * **逐字一致**，老用户升级零迁移。
 * @param ctx - client root context。
 */
export function applySupplierSection(ctx: ClientContext): void {
  ctx.effect(() => {
    const removeStyles = injectStyles()
    // 官方「模型」页的隐藏跟随供应商组件行：关掉供应商行时把它恢复，
    // 否则设置里两个模型配置入口同时消失（供应商页被 gate、官方页被藏）。
    let stopHide: (() => void) | null = null
    const syncHide = (enabled: boolean): void => {
      if (enabled) {
        if (stopHide === null) stopHide = hideOfficialModelsNav()
      } else {
        stopHide?.()
        stopHide = null
      }
    }
    syncHide(featureEnabledNow('host.provider-hub'))
    const off = onFeatureChange('host.provider-hub', syncHide)
    return () => { off(); removeStyles(); stopHide?.(); stopHide = null }
  }, 'dsh-seeker-bot: supplier styles + hide official models')

  ctx.effect(() => {
    const built = createSupplierInjected(ctx)
    const injected = (): SupplierInjected => built.injected
    const unregister = ctx.slots.inject('settings.section', () =>
      ctx.slots.register({
        name: 'settings.section',
        id: 'provider-hub',
        order: 10,
        label: '供应商',
        inject: injected,
      }, SupplierSectionGated),
    )
    return () => {
      try { (unregister as unknown as () => void)?.() } catch { /* 已被级联移除 */ }
      built.dispose()
    }
  }, 'dsh-seeker-bot: supplier settings section')
}

/** 三栏布局的宽度阈值（px）：低于它模型设置卡回到上下堆叠。 */
const WIDE_LAYOUT_PX = 1280

/** 供应商页的两种配置模式（页面级切换，左右两栏整体换内容）。 */
type HubMode = 'chat' | 'live'

/**
 * 模式分段控件的两项（顺序即展示顺序）。
 *
 * 「模型」是这一页的原职，放前面；「实时语音」是第二套内容——左栏换成 Live 供应商
 * 列表、右栏换成它的编辑表单，页面骨架与交互方式一字不动。
 */
const HUB_MODES: readonly { id: HubMode; label: string; title: string }[] = [
  { id: 'chat', label: '模型', title: '模型：聊天供应商的 API Key、Base URL、协议与模型列表' },
  { id: 'live', label: '实时语音', title: '实时语音：Live 供应商（Realtime 端点 + key + 模型）与通话默认' },
]

function Loaded({ injected }: { injected: SupplierInjected }): unknown {
  const { controller, api } = injected
  const state: ModelsSettingsState = useSnapshot(controller.store)
  /*
   * 宽屏三栏 / 窄屏堆叠。
   *
   * 用 ResizeObserver 量容器实宽而不是媒体查询：容器宽度取决于侧边栏折叠、
   * 窗口大小与设置弹窗自身宽度，媒体查询量的是视口，与容器宽度不是一回事。
   * 观察自己（.phub-host）才是「这个页面有没有地方并排」的真答案。
   *
   * 读数**去抖 450ms**：容器宽度会随窗口、侧栏折叠与（若将来放宽）弹窗尺寸变化，
   * 跨过阈值时立刻切档会让第三列「啪」地插进来。去抖后只在宽度稳定下来才重新
   * 判定，配合 .phub-blocks 的 phub-col-in 读起来是内容被推开，而不是被瞬移。
   *
   * 注：弹窗现在固定官方 800×800（用户 2026-10-31 要求不要缩放），容器实宽约
   * 750，1280 阈值不会触发，宽屏三栏目前是休眠分支；保留它是因为布局本身与
   * 弹窗尺寸解耦，将来放宽弹窗即可恢复。
   */
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const el = hostRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    let timer: number | undefined
    const apply = (): void => {
      const next = el.getBoundingClientRect().width >= WIDE_LAYOUT_PX
      setWide((current) => (current === next ? current : next))
    }
    apply()
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => { timer = undefined; apply() }, 450)
    })
    observer.observe(el)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [addingCustom, setAddingCustom] = useState(false)
  /*
   * 页面模式：「模型」/「实时语音」。
   *
   * 用户 2026-11-02 原话：「模式切换应该是在右上角打开配置文件左侧，并且还是沿用
   * 左侧供应商与添加供应商的方式，只不过是里面的内容全部换掉了」。
   *
   * ⚠ 那个「打开配置文件」按钮是**官方设置弹窗 header** 渲染的，不在我们的代码里
   * （插件只接管内容区 `settings.section` 座位）。所以能做到的最近位置是**内容区
   * 顶部右对齐**——视觉上紧贴官方按钮下方一行，这是这套座位下物理上最近的地方。
   */
  const [mode, setMode] = useState<HubMode>('chat')
  /*
   * Live 供应商的共享 store。**始终调用**（hooks 不能条件调用），但只在「实时语音」
   * 模式渲染；切换模式时清掉选中态与未保存草稿，两套内容不串台。
   */
  const live = useLiveVendorStore()
  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])
  /** 切换模式：左右两栏整体换内容，并清掉各自的选中态（不跨模式保留详情）。 */
  const switchMode = (next: HubMode): void => {
    if (next === mode) return
    setMode(next)
    setSelected(undefined)
    setAddingCustom(false)
    live.resetSelection()
    // 切到实时语音时重拉一次 Live 列表：store 随页面常驻，长时间停在模型模式时
    // 配置可能已被别的窗口改过（旧块每次进入都拉一次，行为保持一致）。
    if (next === 'live') live.reload()
  }
  const closeDetail = (changed: boolean): void => {
    setSelected(undefined)
    setAddingCustom(false)
    if (changed) void controller.load()
  }
  const selectedRow = selected !== undefined ? state.rows.find(r => r.entry.provider === selected) : undefined
  let detail: unknown
  if (addingCustom) {
    detail = h(ChatProviderDetail, { key: 'custom', state, target: CUSTOM_TARGET, api, onClose: closeDetail })
  } else if (selectedRow !== undefined) {
    detail = h(ChatProviderDetail, {
      key: selectedRow.entry.provider, state,
      target: targetOf(selectedRow, selectedRow.configured ? 'edit' : 'adopt'),
      api, onClose: closeDetail,
    })
  } else {
    detail = h('div', { style: placeholderStyle }, [
      h('p', { key: 'a', style: { margin: 0, fontSize: 13, fontWeight: 500 } }, '从左侧选择一个提供方'),
      h('p', { key: 'b', style: { margin: 0, fontSize: 12 } }, '查看或编辑 API Key、Base URL 与模型列表'),
    ])
  }
  const hasDetail = addingCustom || selectedRow !== undefined
  // 详情滑入：key 随目标变化重播 phub-slide-in（打开/切换/关闭回占位都滑一次）。
  const animKey = addingCustom ? 'custom' : (selected ?? 'placeholder')
  const animDetail = h('div', { key: `anim:${animKey}`, className: 'phub-detail-in' }, [detail])
  /**
   * 详情面板顶部工具条：返回列表在左、关闭在右。
   *
   * 打开详情时左栏收起（800×800 弹窗里两栏并排太挤），返回入口必须在面板里，
   * 否则用户会被困在详情里。两种模式共用同一套按钮，只是回调不同。
   */
  const renderToolbar = (onBack: () => void): unknown => h('div', { key: 'toolbar', style: panelToolbarStyle }, [
    h('button', {
      key: 'back', type: 'button', title: '返回供应商列表',
      style: panelBackBtnStyle, onClick: onBack,
    }, '← 供应商列表'),
    h('button', {
      key: 'close', type: 'button', title: '关闭', 'aria-label': '关闭',
      style: panelCloseBtnStyle, onClick: onBack,
    }, '✕'),
  ])
  const chatPanelBody = hasDetail
    ? [renderToolbar(() => { closeDetail(false) }), animDetail]
    : [animDetail]
  /*
   * 实时语音模式的右栏：选中项的编辑表单；未选中时是占位 + 「通话默认（全局）」。
   * 全局设置在两种状态下都渲染——音色 / 语速 / 联网不属于任何一条供应商，
   * 但用户切到这一页就要能改。
   */
  const liveHasDetail = live.editing !== null
  const liveAnimKey = live.editing === null ? 'placeholder' : (live.editing.id ?? 'new')
  const liveAnimDetail = h('div', { key: `anim:live:${liveAnimKey}`, className: 'phub-detail-in' }, [
    h(LiveVendorDetail, { key: 'live-detail', store: live }),
  ])
  const livePanelBody = liveHasDetail
    ? [renderToolbar(() => { live.cancelEdit() }), liveAnimDetail]
    : [liveAnimDetail]
  // 左栏固定宽度（工作台里不再受设置弹窗宽度约束，也不需要收窄态）。
  const navStyle: Record<string, string | number> = {
    flex: `0 0 ${NAV_WIDTH}px`,
    width: NAV_WIDTH,
  }
  // 辅助视觉模型块已删（用户 2026-10-31：主模型都能看图，不需要单独配视觉模型）。
  const blocks = h('div', { key: 'blocks', className: 'phub-blocks' }, [
    h(ImageModelBlock, { key: 'image' }),
    h(VideoModelBlock, { key: 'video' }),
  ])
  // 代理：用户 2026-10-05 明确「不需要一个单独分类，放这两个卡片的下方」——
  // 整页宽度的独立区块，与「列表 + 详情」和模型设置卡都不并列。
  const proxyBlock = h('div', { key: 'proxy', className: 'phub-proxy phub-block-in' }, [
    h(ProxyPanel),
  ])
  /*
   * 模式切换：**放在左栏标题的位置**，替换原来的「模型供应商」文字。
   *
   * 用户 2026-11-02：「切换按钮替换这个文字」——所以它不再是内容区顶部单独一行，
   * 而是作为两个列表的 headerSlot 传进去（聊天列表与 Live 列表共用同一个控件）。
   */
  const modeSwitchNode = h('div', {
    key: 'group', className: 'dsh-cap-group', style: inlineCapGroupStyle,
    role: 'group', 'aria-label': '配置模式',
  }, HUB_MODES.map(item => h('button', {
    key: item.id,
    type: 'button',
    className: 'dsh-cap-pill',
    'aria-pressed': mode === item.id,
    style: mode === item.id ? inlineCapPillOnStyle : inlineCapPillStyle,
    title: item.title,
    onClick: () => { switchMode(item.id) },
  }, item.label)))
  const navNode = mode === 'chat'
    ? h(ChatProviderList, {
      key: 'nav', state, selected,
      onSelect: (p: string) => { setSelected(p); setAddingCustom(false) },
      onAddCustom: () => { setAddingCustom(true) },
      onRetry: () => { void controller.load() },
      headerSlot: modeSwitchNode,
    })
    : h(LiveVendorList, { key: 'nav-live', store: live, headerSlot: modeSwitchNode })
  // 右栏：模型模式沿用原详情面板（占位时虚线），Live 模式始终是实面板
  // （里面除了表单/占位还有「通话默认（全局）」）。
  const detailNode = mode === 'chat'
    ? h('div', {
      key: 'panel',
      className: hasDetail ? 'phub-panel' : 'phub-panel phub-placeholder',
      style: detailPanelStyle,
    }, chatPanelBody)
    : h('div', { key: 'panel-live', className: 'phub-panel', style: detailPanelStyle }, livePanelBody)
  // 打开详情时收起左栏（800×800 弹窗里两栏并排太挤，收起后右侧独占整行）。
  const editingNow = mode === 'chat' ? hasDetail : liveHasDetail
  return h('div', {
    className: 'phub-host',
    ref: hostRef,
    'data-wide': wide ? 'true' : undefined,
    'data-mode': mode,
    'data-editing': editingNow ? 'true' : undefined,
  }, [
    h('div', { key: 'hub', className: 'phub-hub', style: hubLayoutStyle }, [
      h('div', { key: 'navWrap', className: 'phub-navwrap', style: navStyle }, [navNode]),
      h('div', { key: 'detail', style: detailColStyle }, [detailNode]),
      // 模型设置卡：宽屏成为第三列，窄屏被 flexWrap 挤到第二行（全宽）。
      // 两种形态共用同一份 DOM，切档不重建子树。生图/生视频属于聊天模型那套，
      // 「实时语音」模式下整体不渲染。
      mode === 'chat' ? blocks : null,
    ]),
    // 代理同理：它是聊天请求的出口，实时语音走宿主自己的上游地址，摆在这里只会
    // 让人以为它对这个模式也生效。
    mode === 'chat' ? proxyBlock : null,
  ])
}