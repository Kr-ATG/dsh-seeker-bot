/**
 * dsh-recall-plugin — client util（纯函数模块级导出 + 有状态工厂）
 *
 * 纯函数（clockText/sizeText/bytesToMb/buildTree）模块级导出，供单测直接
 * import 与工厂复用；api/toast/ensureInit 有闭包状态（每会话 init 缓存、
 * 提示节流、当前语言），由 buildUtil() 工厂生产，避免模块级可变状态（HMR
 * 假设）。文案一律经 locales 词典层取词（A4）：纯函数不收词表参数时按 zh
 * 渲染，组件侧统一吃 util.t。
 */

import type { ManageListItem, RecallNotifyArgs, RecallScope } from '../types/api.js'
import { hasTranslation, resolveLocale, translate, zhTranslate } from './locales/index.js'
import type { DictParams, Locale, Translate } from './locales/index.js'

// React 以参数逐层注入（同形态复刻的依赖注入形态）：参数类型即 React 全量
// 命名空间类型（@types/react 是唯一用途，import type 运行时零依赖）
export type ReactApi = typeof import('react')

// 树形结构（buildTree 产出：工作区 → 会话 → 快照三级）
export interface TreeWorkspace {
  root: string | null
  name: string
  sessions: TreeSession[]
}
export interface TreeSession {
  root: string | null
  sessionId: string | null
  title: string | null
  items: ManageListItem[]
}

// 消息时间：当天只显示时分，跨天显示月/日 时分
export function clockText(ms: unknown): string {
  try {
    // time 字段缺失或非法时返回空串：Invalid Date 不会 throw，
    // 不拦会渲染出 "NaN/NaN NaN:NaN" 这样的坏时间戳
    if (!ms || isNaN(new Date(ms as number | string).getTime())) return ''
    const d = new Date(ms as number | string)
    const now = new Date()
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return sameDay ? hh + ':' + mm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + ':' + mm
  } catch (e) {
    // 防御性兜底：脏时间戳/宿主 Date 异常都回落空串（见上方注释）
    return ''
  }
}

// 字节大小展示：KB/MB/GB 边界与格式
export function sizeText(bytes: unknown): string {
  const n = Number(bytes)
  if (!bytes || n <= 0) return '0 MB'
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

// ConfigForm 的字节↔MB 换算：持久化与 schema 都是字节，只在 display/input
// 层换算成人工友好的 MB 小数；round 2 位去尾零，避免默认值裸奔成一长串
export function bytesToMb(bytes: unknown): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  return String(Math.round((n / 1048576) * 100) / 100)
}

// 把扁平列表组装成树（工作区 → 会话 → 快照三级）。同一快照只属于一个
// 工作区/会话，root 或 sessionId 缺失时归入「未知」节点，避免行凭空消失。
// 构建期会话以 Map 暂存（按键快速归组），收尾统一转数组供渲染。
// t 可省略（缺省 zh 词表）：单测与「没有 util 实例」的调用点不因缺词表而崩。
export function buildTree(list: ManageListItem[] | null | undefined, t: Translate = zhTranslate): TreeWorkspace[] {
  const workspaces = new Map<string, { root: string | null; name: string; sessions: Map<string, TreeSession> }>()
  for (const it of list || []) {
    const rootKey = it.root || 'unknown-root'
    // get-or-create 守卫（A6）：一次取值建/取同用，替代 `get(...)!` 断言
    let ws = workspaces.get(rootKey)
    if (!ws) {
      ws = { root: it.root || null, name: it.workspace || t('tree.unknownWorkspace'), sessions: new Map() }
      workspaces.set(rootKey, ws)
    }
    const sidKey = it.sessionId || 'unknown-session'
    if (!ws.sessions.has(sidKey)) ws.sessions.set(sidKey, { root: ws.root, sessionId: it.sessionId || null, title: it.sessionTitle || null, items: [] })
    // get-or-create 守卫（A6）：替代 `get(...)!` 断言
    const session = ws.sessions.get(sidKey)
    if (session) session.items.push(it)
  }
  const wsList: TreeWorkspace[] = Array.from(workspaces.values()).map((ws) => ({ root: ws.root, name: ws.name, sessions: Array.from(ws.sessions.values()) }))
  wsList.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  for (const ws of wsList) {
    ws.sessions.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    for (const s of ws.sessions) s.items.sort((a, b) => (b.time || 0) - (a.time || 0))
  }
  return wsList
}

// 端点 URL 的基址解析。为什么不用根绝对路径 '/api/recall/x'：dsh 0.1.7-rc.1 起官方
// 支持「Web 挂在反向代理子路径」——index.html 由 dsh-host-frontend-static 注入
// <base href="./">，官方客户端一律以 document.baseURI 为基址解析服务端路径
// （见 dsh-api-gateway 的 remoteStreamUrl），前端资源也全部改成相对路径。根绝对
// 路径在根部署下等价，但在子路径部署下会越过前缀打到代理未映射的根（实测经
// 子路径代理 404，而带前缀的同一路径 200）。故与官方同构：按当前文档基址解析。
// base 显式入参只为单测注入（浏览器内省略即取 document.baseURI）；解析失败
// （非浏览器环境、异常 baseURI）回落到原根绝对路径，保持旧行为不倒退。
export function recallApiUrl(name: string, base?: string): string {
  const root = base ?? (typeof document === 'undefined' ? '' : document.baseURI)
  if (!root) return '/api/recall/' + name
  try {
    const baseUrl = new URL(root)
    // 基址不以 / 结尾时按目录补斜杠：用户直接敲 /dsh（漏尾斜杠）时 baseURI 是
    // '.../dsh'，不补的话相对解析会把 dsh 当文件名、把子路径前缀整个吞掉。
    // 官方客户端直接用 document.baseURI 会有同样的坑，这里只做无损加固。
    if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/'
    return new URL('api/recall/' + name, baseUrl).href
  } catch (e) {
    // 解析失败回落原根绝对路径（见上方注释：保持旧行为不倒退）
    return '/api/recall/' + name
  }
}

// ---- 撤回终态上报（issue #19）----

// buildRecallNotify 的「撤回结果」输入：与规格语义决策表（plan-recall-event
// §一）一一对应。STALE 自动重预览是中间态，不构成 outcome——类型上就没有
// 该分支，接线处不会为它构造调用，编译器替人守住「STALE 不上报」。
export type RecallNotifyOutcome =
  | { outcome: 'execute-rejected'; cutSeq: number | null; code?: string; error?: string }
  | { outcome: 'execute-threw'; cutSeq: number | null; error: string }
  | { outcome: 'fork-failed'; cutSeq: number | null; error: string }
  | { outcome: 'complete'; cutSeq: number | null; childSessionId: string | null; count: number; chatReverted: boolean; archiveRequested: boolean }

// 纯函数：按撤回结果组装 notify 上报载荷（事件名/version/time 由 host 补，
// client 只报业务事实）。组装与发送分离——五处上报点只管 fire-and-forget，
// 六场景矩阵的字段语义在单测直钉，不用为改字段语义去驱动整条撤回链。
export function buildRecallNotify(
  base: { sessionId: string; messageId: string; scope: RecallScope },
  o: RecallNotifyOutcome
): RecallNotifyArgs {
  if (o.outcome === 'complete') {
    return {
      status: 'complete',
      sessionId: base.sessionId,
      messageId: base.messageId,
      scope: base.scope,
      cutSeq: o.cutSeq,
      childSessionId: o.childSessionId,
      count: o.count,
      chatReverted: o.chatReverted,
      archiveRequested: o.archiveRequested,
    }
  }
  const stage = o.outcome === 'fork-failed' ? 'fork' : 'execute'
  const code = o.outcome === 'execute-rejected' && typeof o.code === 'string' && o.code ? o.code : undefined
  return {
    status: 'failed',
    stage,
    sessionId: base.sessionId,
    messageId: base.messageId,
    scope: base.scope,
    cutSeq: o.cutSeq,
    ...(code ? { code } : {}),
    error: typeof o.error === 'string' && o.error ? o.error : String(o.error || 'recall failed'),
  }
}

// 设置卡片三处共用的状态形状（busy 进行中 / message 反馈 / error 是否错误）
export interface CardStatusState {
  busy: boolean
  message: string
  error: boolean
}

// V3 成功消息自动消退（ExcludeCard/ManageCard/ConfigForm 共用，落在 util.ts
// 因为三卡片已在 S1 拆分到不同文件，放任一卡片文件都会造成跨域引用）。
// 只清成功消息（4s）：错误常驻供从容处理；busy 中的「保存中…」不清。
// timer 以 setState 函数式更新 + 原文比对兜底：以最后一次 setState 为准，
// 期间若又写入新消息则跳过清空；卸载时由 effect 清理函数取消。
export function useAutoDismissMessage(
  React: ReactApi,
  state: CardStatusState,
  setState: (updater: (prev: CardStatusState) => CardStatusState) => void
): void {
  React.useEffect(() => {
    if (!state.message || state.error || state.busy) return
    const timer = setTimeout(() => {
      setState((prev) => (
        prev.message === state.message && !prev.error && !prev.busy
          ? Object.assign({}, prev, { message: '' })
          : prev
      ))
    }, 4000)
    return () => clearTimeout(timer)
  }, [state.message, state.error, state.busy])
}

// buildUtil 工厂产出（各组件依赖注入消费面；api 的返回类型随调用点泛型推断）
export interface UtilApi {
  api<T = unknown>(name: string, args?: unknown): Promise<T>
  messageFor(res: unknown, fallback: string): string
  showNotice(kind: string, text: string): void
  showThrottledToast(text: string): void
  ensureInit(sessionId: string | null | undefined): Promise<unknown>
  clockText(ms: unknown): string
  writeClipboard(text: string): Promise<boolean>
  sizeText(bytes: unknown): string
  bytesToMb(bytes: unknown): string
  // t 可选：缺省 zh 词表（A4），组件侧统一传 util.t 拿到当前语言
  buildTree(list: ManageListItem[] | null | undefined, t?: Translate): TreeWorkspace[]
  // A4：词表取词与语言切换（locale 偏好由 Host config 下发，见 ensureInit）
  t: Translate
  setLocalePref(pref: unknown): void
  pluginConfig: { refillDraft: boolean; archiveOriginal: boolean }
}

export function buildUtil(): UtilApi {
  // 当前语言：初始按 auto 解析（navigator.language），随后由 init 响应与
  // 设置页 config-get 覆写——同一页面内改语言只影响设置页（保存后重渲染），
  // 聊天半的会话文案在下一次 init（页面重载）后跟进（v1 明示限制，见 README）
  let locale: Locale = resolveLocale('auto')
  function t(key: string, params?: DictParams): string {
    return translate(locale, key, params)
  }
  function setLocalePref(pref: unknown): void {
    locale = resolveLocale(pref)
  }

  // Host HTTP API（动态插件的 harness RPC 在此换成 fetch 调用）；路径经
  // recallApiUrl 按文档基址解析，子路径部署（官方 rc.1 支持）才可达
  function api<T = unknown>(name: string, args?: unknown): Promise<T> {
    return fetch(recallApiUrl(name), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args || {})
    }).then((r) => r.json())
  }

  // 机器码 → 人文案映射（H3/A4）：host 端点 code 仍是线上契约（machine），
  // 展示层文案改由 locales 词典的 `err.<code>` 承载（双语）；词典只收 host
  // 侧文案静态的码，动态细节码（ROLLBACK_FAILED 的救援结果等）不设条目——
  // hasTranslation 未命中即回落 host message，宁中英混排也不吞排障细节。
  function messageFor(res: unknown, fallback: string): string {
    if (!res) return fallback
    const code = (res as { code?: unknown }).code
    const key = code ? 'err.' + String(code) : ''
    if (key && hasTranslation(key)) return t(key)
    // message/error 均为 unknown（端点返回形状宽松），取首个 truthy 并 String 化
    const m = (res as { message?: unknown }).message
    const e = (res as { error?: unknown }).error
    return String(m || e || fallback)
  }

  // 降级提示：每个种类每次页面加载只弹一次（Set 去重），避免切会话时反复
  // 打扰。纯 DOM 直插（与剪贴板同样的零依赖思路），7 秒后自动淡出。
  const noticeShown = new Set<string>()
  // toast 挂载本体：两类提示（降级/快照反馈）共用的纯 DOM 实现
  function mountToast(text: string): void {
    if (typeof document === 'undefined') return
    try {
      const el = document.createElement('div')
      el.className = 'dsh-recall-toast'
      const tag = document.createElement('span')
      tag.className = 'dsh-recall-toast-tag'
      tag.textContent = t('toast.tag')
      const body = document.createElement('span')
      body.textContent = text
      el.appendChild(tag)
      el.appendChild(body)
      el.addEventListener('click', () => dismiss(), { once: true })
      document.body.appendChild(el)
      requestAnimationFrame(() => el.classList.add('dsh-recall-toast-in'))
      const timer = setTimeout(dismiss, 7000)
      let dismissed = false
      function dismiss() {
        if (dismissed) return
        dismissed = true
        clearTimeout(timer)
        el.classList.remove('dsh-recall-toast-in')
        setTimeout(() => el.remove(), 300)
      }
    } catch (e) { /* 提示失败不影响主流程 */ }
  }
  function showNotice(kind: string, text: string): void {
    if (noticeShown.has(kind)) return
    noticeShown.add(kind)
    mountToast(text)
  }
  // 快照失败/跳过提示（issue #7 失败可见性）：与降级提示不同，这类事件
  // 会在持续故障期间随每条消息反复发生——按「文本前缀 + 时间窗」节流，
  // 同一故障 10 分钟内至多打扰一次；不同错误各自独立计数。Map 规模封顶后
  // 整体清空：提示是尽力而为的可见性，不是需要精确保留的状态。
  const toastLastShown = new Map<string, number>()
  function showThrottledToast(text: string): void {
    const key = String(text).slice(0, 80)
    const now = Date.now()
    if (now - (toastLastShown.get(key) || 0) < 10 * 60 * 1000) return
    if (toastLastShown.size > 50) toastLastShown.clear()
    toastLastShown.set(key, now)
    mountToast(text)
  }

  // 每个会话只向 Host 注册一次（预热其根目录解析缓存）。
  // 返回 init 的 promise：Host 端 init 要跑数条 PowerShell（建仓/loadIndex），
  // snapshot-info 必须等它完成后再查，否则冷启动时索引尚未载入会误判
  // has:false 且不再重试，撤回按钮将永不出现。
  // init 顺带下发插件行为开关（refillDraft 等），存进 pluginConfig 供撤回
  // 执行链读取——设置页改配置 + 重启后随下一次 init 刷新。
  const pluginConfig = { refillDraft: true, archiveOriginal: true }
  const initMap = new Map<string, Promise<unknown>>()
  function ensureInit(sessionId: string | null | undefined): Promise<unknown> {
    if (!sessionId) return Promise.resolve()
    const cached = initMap.get(sessionId)
    if (cached) return cached
    const done = api<import('../types/api.js').InitResponse>('init', { sessionId }).then((res) => {
      if (res && res.config && typeof res.config === 'object') {
        const cfg = res.config as { refillDraft?: unknown; archiveOriginal?: unknown; locale?: unknown }
        if (typeof cfg.refillDraft === 'boolean') pluginConfig.refillDraft = cfg.refillDraft
        if (typeof cfg.archiveOriginal === 'boolean') pluginConfig.archiveOriginal = cfg.archiveOriginal
        // A4：init 是每会话必经的预热通道，语言偏好随之落地；老 Host 不下发
        // 该字段（undefined）时解析回落 auto（按 navigator.language）
        setLocalePref(cfg.locale)
      }
      const notice = res && res.notice
      if (notice && notice.unsupported) {
        showNotice('unsupported', t('notice.unsupported'))
      }
      if (notice && notice.gitMissing) {
        showNotice('git', t('notice.gitMissing'))
      }
      if (notice && notice.homeFallback) {
        showNotice('home', t('notice.homeFallback'))
      }
      // issue #18：工作区根自身是构建产物目录时不建快照（Host 侧 captureSnapshot
      // 早退）。A4 起 Host 另下发 artifactSeg（命中段名）供 client 本地取词——
      // 优先按它渲染；老 Host 只给拼好的中文字段（buildRootNotice），保留一个
      // 版本周期的回落
      if (notice && typeof notice.buildRootArtifactSeg === 'string' && notice.buildRootArtifactSeg) {
        showNotice('buildRoot', t('notice.buildRoot', { seg: notice.buildRootArtifactSeg }))
      } else if (notice && notice.buildRootNotice) {
        showNotice('buildRoot', String(notice.buildRootNotice).slice(0, 140))
      }
    }).catch(() => {
      // init 失败（如页面先于 Host API 就绪加载）时清掉标记：否则本会话内被
      // 判定“已初始化”，撤回按钮永不出现；清掉后下一条消息挂载会重试
      initMap.delete(sessionId)
    })
    initMap.set(sessionId, done)
    return done
  }

  // 复制按钮走浏览器剪贴板；无 primitives 依赖，直接调用并带降级
  function writeClipboard(text: string): Promise<boolean> {
    try {
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(() => true, () => false)
      }
    } catch (e) { /* fall through */ }
    try {
      if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
        const el = document.createElement('textarea')
        el.value = text
        el.setAttribute('readonly', '')
        el.style.position = 'fixed'
        el.style.left = '-9999px'
        document.body.appendChild(el)
        el.select()
        try {
          return Promise.resolve(document.execCommand('copy'))
        } finally {
          el.remove()
        }
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(false)
  }

  return { api, messageFor, showNotice, showThrottledToast, ensureInit, clockText, writeClipboard, sizeText, bytesToMb, buildTree, t, setLocalePref, pluginConfig }
}
