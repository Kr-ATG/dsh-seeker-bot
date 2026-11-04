/**
 * dsh-recall-plugin — Host 入口（持久插件形态，bundle 行挂载）
 *
 * 职责：装配各域模块（config / store / snapshots / maintenance / session-info /
 * routes-core / routes-manage），经 connection 的载体无关 fetch 路由注册
 * /api/recall/* API 供 Client 半调用，并接线 session/event 快照触发与启动预热。
 *
 * 这是持久 npm 插件包的主入口（exports["."]），由 cordis.patch.yml 的
 * insert 行挂载进 profile composition，DSH 重启后自动生效。业务逻辑已拆到
 * lib/ 各域模块（routes-core / routes-manage / session-info），本文件只做
 * 接线与 store 发现/执行工具，不承载端点业务。
 *
 * ── 移植说明（vendor 进 dsh-seeker-bot，MIT，见 LICENSE）──────────────
 * 本目录是从开源插件 dsh-recall-plugin 原样移植的 host 半身，作为本插件的
 * 内嵌功能（不再独立发布成插件包）。业务逻辑、脚模板、错误码、文案、默认值
 * 一律未改；只做五处接缝适配，每处都有「接缝适配 ①②③④」中文注释：
 *   ① 删除 '@deepseek-ai/dsh-settings' 裸导入，改传空模块桩
 *      （host 产物必须自包含，见 build.mjs 的 assertHostExternals）；
 *   ② 导出改名：apply → applyRecallHost、inject → recallInjects、
 *      Config → RecallConfig、name → recallHostId（避免与宿主入口同名混淆）；
 *   ③ 第二参数放宽为 unknown 并归一化（宿主传 recall 段 / 整包 config / undefined）；
 *   ④ 配置持久化改「本插件文件源」（src/recall/host/config-file.ts）：设置页的
 *      读写与热更不再依赖官方 settings 面（宿主没有给 loader 导出 recall 的
 *      Config schema，settings.update 必失败——「保存」点了没反应属静默失效），
 *      三层优先级固定为「文件 > profile 行 config > DEFAULTS」；
 *   ⑤ 其它目录内相对 import（'./config.js' 形态）保持原样，由 esbuild 与 tsc
 *      各自解析到同名 .ts（已验证）。
 * 宿主侧接线（src/host.ts，不归本目录）：
 *   ctx.inject([...recallInjects], (c) => applyRecallHost(c, rawConfig?.recall ?? rawConfig ?? {}))
 */

import { createConfig, Config, DEFAULTS, unwrapConfig } from './config.js'
// 接缝适配 ④（本仓库新增）：配置持久化文件源。用户设置页保存的配置不再只压
// 在官方 settings 面上（宿主入口没有向 loader 导出 recall 的 Config schema，
// settings.update(宿主 ns, recall patch) 大概率不可用），改由本插件的
// config.json 承担；官方 settings 接入保留，只是不再是唯一通路。
import { readConfigFile } from './config-file.js'
import { installSettingsNamespace } from './settings-bridge.js'
import { parseStoresDump, parseExcludeDump } from './dump-parse.js'

// dump 解析纯函数住 dump-parse.js（避免 routes-manage 反向 import index 的
// 循环依赖），这里 re-export 保持既有 import 路径稳定
export { parseStoresDump, parseExcludeDump }
import { createRuntime } from './store.js'
import { createSnapshots, rescueRollback } from './snapshots.js'
import { createMaintenance } from './maintenance.js'
import { createSessionInfo, titleFromEvents, messageTextFromEvents } from './session-info.js'
import { createRoutesCore } from './routes-core.js'
import { createRoutesManage } from './routes-manage.js'
import { createIntentJournal } from './intent-journal.js'
import { createEnsureRootReady } from './root-ready.js'
import { createQueues } from './queues.js'
// 接缝适配 ①（移植进 dsh-seeker-bot）：原样删除
//   import * as dshSettings from '@deepseek-ai/dsh-settings'
// 为什么删：本仓库的 host 产物是 build.mjs 打出的单文件 ESM（src/host.ts →
// lib/index.js），@deepseek-ai/* 除 schemastery / cosmokit 被 alias 到 src/vendor
// 内联外一律 external，而 assertHostExternals + HOST_RUNTIME_EXTERNAL_ALLOWLIST
// 不允许产物里残留任何裸包 import（allowlist 目前只有 undici / cpu-features）；
// 且本机 DSH 0.2.1-alpha.2 的 profile node_modules 里没有这个包的 lib/index.js，
// 裸 node 运行时解析必炸（与 src/vendor/README.md 记录的 dsh-util-crypto 同因）。
// 降级依据：dshSettings 在 settings-bridge.ts 里只有一个消费点——
// `typeof dshSettings.installSettingsSection === 'function'`，对应的是
// 0.1.1-rc.2 及以前的「旧面独立函数」辅助（0.1.2-alpha.2 起官方已移除）。
// 空模块桩上该属性不存在 → 判定为 false → 直接落到 ctx.inject(['settings']) 分支。
// 影响面：**仅**这条旧面独立函数路径跳过；新面（0.1.7+ 的 volatile 热更）与旧
// provider 的 installSection / register 两条分支走运行时注入的 ctx.settings，
// 完全不受影响（三分支分派见 settings-bridge.ts 文件头）。
import * as E from './errors.js'
import type { DshSettingsModule } from './settings-bridge.js'
import type { HostContext, SessionQueryEngine } from '../types/dsh-contract.js'
import type { Runtime, StoreInfo } from '../types/state.js'
import type { StoreDumpInfo } from './dump-parse.js'
import type { ResolvedConfig } from '../types/config.js'
import type { ManageListItem } from '../types/api.js'

// 接缝适配 ①：空模块桩，满足 SettingsBridgeDeps.dshSettings 的类型面。
// 运行时零依赖——类型面本身（settings-bridge.ts 里
// `type DshSettingsModule = typeof import('@deepseek-ai/dsh-settings')`）是纯类型
// 位置，esbuild 会整体剥离，产物里不会留下这条裸包 import（自检脚本已断言）。
const dshSettings = {} as unknown as DshSettingsModule

// 接缝适配 ②（移植进 dsh-seeker-bot 的内嵌功能）：导出改名。
// 本文件不再是 cordis 插件入口——它被宿主入口 src/host.ts 当作一段装配函数
// 调用，而 src/host.ts 自己就有 `export const name = 'dsh-seeker-bot'`、
// `export function apply`。留着同名导出会让「谁是插件入口 / 谁的名字生效」
// 产生语义混淆，故名字统一前缀 recall。原值原样保留，只换标识符。
export const recallHostId = 'dsh-recall-plugin'

// 硬依赖：shell（PowerShell 执行）、sessions（会话/沙箱策略）、agents（dsh-base
// 无条件装配的 agent 注册表，P0-1 运行中 agent 拦截读运行状态所需——cordis 4
// 要求服务在 inject 中声明才可经 ctx.agents 访问，漏声明会抛
// "cannot get property ... without inject" 导致检查静默 fail-open，冒烟发现）。
// Client 半的 API 通道走 connection 的载体无关 fetch 路由，刻意不进硬声明：
// 桌面端 composition 禁用 webserver row，硬依赖会让 fiber 永久 pending
// （「entry did not activate」）；connection 用 ctx.inject 可选注入——服务缺席
// （旧版 dsh）时静默降级为「无 API 通道」，host 侧快照与维护不受影响。
// 其余服务按需 ctx.get。
// 接缝适配 ②：原 `export const inject` 改名 recallInjects（值原样），供宿主
// 入口 src/host.ts 组装：ctx.inject([...recallInjects], (c) => applyRecallHost(c, rawConfig))。
// 标成普通 string[] 而不是 as const：cordis 的 inject(names: string[]) 只收可变数组。
export const recallInjects: string[] = ['shell', 'sessions', 'agents']

// 入口配置 schema：cordis 加载器据此校验 insert 行 config 并填充默认值，
// 非法配置在插件加载时响亮失败（官方「插件配置」文档要求）。
// 接缝适配 ②：改名 RecallConfig（原 Config）。导出名与宿主入口/其它模块的
// 同名符号解耦；模块内部（settings-bridge.ts 的注册接线）仍从 config.ts 取
// 原名 Config，schema 实体自始至终只有一份。
export { Config as RecallConfig }
// 默认值单源（与 schema default 同源，见 config.ts 注释）：导出给冒烟钉「撤回
// 默认只撤对话」这条语义——写反了不会抛错，只会表现为「点撤回又把工作区改回
// 去了」，只能靠断言。
export { DEFAULTS as RecallDefaults }

/**
 * 接缝适配 ③：插件 config → recall 配置段的归一化。
 *
 * 宿主里的调用形态是 `applyRecallHost(c, rawConfig?.recall ?? rawConfig ?? {})`，
 * 但也有可能被直接传入整个插件 config（recall 配置挂在 `recall` 段下）。三种
 * 入参都必须落到同一条解析链上——不能因为多包了一层对象就把用户配置读成默认值：
 *   · undefined / null / 非对象 → {}（createConfig 的既有语义：全落 DEFAULTS）
 *   · 带 recall 段的对象        → 该段（整包 config 的形态）
 *   · 直接的配置对象            → 原样（调用方已取过段，或 config 本就是扁平形态）
 *
 * 为什么优先取段而不是原样透传：createConfig 只认 recall 的字段名，传入整包
 * config 时其它字段会被忽略，但 recall 字段若住在 `recall` 子对象里就一个都读
 * 不到——表现为「用户配了却全按默认值跑」，属静默降级。反过来不会误判：recall
 * 的配置字段里没有名为 recall 的对象字段。
 *
 * 注意这里**不** unwrap volatile ref：readSettings 活绑定与 loader/volatile-update
 * 的重读都依赖同一引用，解 ref 的职责留在 createConfig 之前那一层（unwrapConfig）。
 */
/**
 * 接缝适配 ④：把「组合 base」与「文件层」叠成当前生效配置。
 *
 * 只做浅合并、**不** unwrap volatile ref：base 在 0.1.7 新面下字段可能是
 * Volatile ref，展开成普通值会丢引用（之后 loader 提交新值就热更不进来）；
 * 解 ref 的职责统一留在 createConfig 之前那一层（unwrapConfig，参考实现纪律）。
 *
 * 每次调用都重读文件（不缓存）：文件只有设置页保存时才会变，读一次是几 KB 的
 * 本地 IO，换来「保存即生效、多进程各读各的」两条正确性，比缓存划算。
 */
function readEffectiveConfig(base: ResolvedConfig): ResolvedConfig {
  const fileLayer = readConfigFile()
  // base 可能是 volatile ref 化对象（字段值不是普通值），文件层是普通 JSON
  // 值——两者都是「可能只含部分字段」的松散形状，只能经 unknown 桥接回
  // ResolvedConfig；真实形状由 createConfig 的逐字段判定兜底（它本就不信任
  // 传入值，非法/缺失一律回落默认）。
  const merged: Record<string, unknown> = {
    ...(base as unknown as Record<string, unknown>),
    ...(fileLayer as unknown as Record<string, unknown>),
  }
  return merged as unknown as ResolvedConfig
}

function pickRecallConfig(raw: unknown): ResolvedConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {} as ResolvedConfig
  const segment = (raw as { recall?: unknown }).recall
  if (segment && typeof segment === 'object' && !Array.isArray(segment)) {
    return segment as ResolvedConfig
  }
  return raw as ResolvedConfig
}

// 接缝适配 ③（apply → applyRecallHost，第二参数放宽为 unknown）：
// 🚫 为什么不能直接沿用 `config: ResolvedConfig`：宿主内嵌调用时传的是
//    `rawConfig?.recall ?? rawConfig ?? {}`——未配置时可能是 undefined，
//    undefined 在 ResolvedConfig 类型下是编译错误（运行时倒是能跑，因为
//    unwrapConfig 对非对象输入返回 {}、createConfig({}) 落到 DEFAULTS）。
// ✅ 归一化收口在本函数第一行：pickRecallConfig(rawConfig) 把
//    「undefined / {} / 整个插件 config / 其中的 recall 段」统一收敛成一个
//    形状合规的配置对象，再交给与原来完全相同的
//    createConfig(unwrapConfig(...)) —— 配置解析链路一字未改。
// config 由宿主插件 loader 的 config 键下发（schema 默认值兜底），
// 设置页「插件配置」卡片的用户覆盖经 settings namespace 热更新进 cfg
// （接线见 settings-bridge.ts 的 installSettingsNamespace）
/** 某条 agent 记录是否就是 sessionId 这个会话自己的（纯判据，供冒烟直接钉）。 */
export function isSelfAgentBusy(list: unknown, sessionId: string | null): boolean {
  if (!sessionId) return false
  for (const agent of Array.isArray(list) ? list : []) {
    const a = agent as { id?: unknown; status?: string; session?: { header?: { id?: unknown } } } | null
    if (!a || a.status !== 'running') continue
    // agent.id 是发起会话 id（参考实现同款判据）；session.header.id 是更权威
    // 的会话身份，两代 DSH 上二者未必同时在场，任一匹配即算自己。
    if (String(a.id) === String(sessionId)) return true
    const sid = a.session && a.session.header && a.session.header.id
    if (sid && String(sid) === String(sessionId)) return true
  }
  return false
}

/**
 * 是否有**别的**会话的 agent 在同一个工作区里跑（纯判据，供冒烟直接钉）。
 * 自己的那条不算 cross——否则 self/cross 会重复报同一个原因、前端提示指错对象。
 */
export function isCrossAgentBusy(
  list: unknown,
  sessionId: string | null,
  root: string | null,
  normalize: (path: string) => string,
): boolean {
  if (!root) return false
  for (const agent of Array.isArray(list) ? list : []) {
    const a = agent as {
      id?: unknown
      status?: string
      session?: { header?: { id?: unknown; cwd?: unknown } }
    } | null
    if (!a || a.status !== 'running') continue
    if (sessionId) {
      if (String(a.id) === String(sessionId)) continue
      const sid = a.session && a.session.header && a.session.header.id
      if (sid && String(sid) === String(sessionId)) continue
    }
    // 跨会话同工作区：另一会话的 agent 在同一个目录跑会与文件回退互相覆盖
    const cwd = a.session && a.session.header && a.session.header.cwd
    if (typeof cwd === 'string' && cwd && normalize(cwd) === normalize(root)) return true
  }
  return false
}

export function applyRecallHost(ctx: HostContext, rawConfig?: unknown): void {
  // 接缝适配 ③：参数归一化（见上方 applyRecallHost 注释与 pickRecallConfig 实现）。
  // 接缝适配 ④：组合 base 单独留一份引用——它同时是 readSettings 的来源。
  const baseConfig = pickRecallConfig(rawConfig)
  // 接缝适配 ④：再叠加文件层（用户设置页保存的配置）。**三层优先级**：
  //   文件（用户显式覆盖） > profile 行 config（组合 base） > DEFAULTS
  // 为什么文件优先：设置页保存是用户当下的显式意图，profile 行是部署默认值；
  // 反过来的话用户改完设置、重启一次就被 profile 行的旧值盖回去（静默回滚）。
  const config = readEffectiveConfig(baseConfig)
  // unwrapConfig：0.1.7 新面下 config 的 volatile 字段是 Volatile ref（本机实测
  // apply 期 config.flag 即 ref），不过一层就解不出来——createConfig 的 typeof/
  // pickNumber 判定会把 ref 当非法值静默回退默认值，profile 行里的用户配置全丢。
  const cfg = createConfig(unwrapConfig(config))
  const rt = createRuntime(ctx, cfg)
  const snaps = createSnapshots(ctx, rt, cfg)
  // dumpStores 是下方同作用域的函数声明（提升可见）：M3 起「立即 gc」按磁盘
  // 枚举补齐 store 全集 + 回收空仓目录——内存缓存覆盖不到会话已删的残骸
  const maint = createMaintenance(ctx, rt, snaps, cfg, { dumpStores })
  const state = rt.state

  // ---- settings 接入：hooks 与 resolved 回填留在本文件（routes-manage 的
  // deps 消费 readSettings 活绑定，A1）；两代面分派与三条旧面注册路径在
  // settings-bridge.ts（dshSettings 参数注入，单测可在 CI 直测注册 entry）----
  // 接缝适配 ④：readSettings 改为「每次重算」的活绑定（组合 base + 文件层）。
  // 原来是 `() => config`（apply 期快照），文件源把它写进 config.json 之后，
  // 任何按旧快照重算都读不到新值——保存成功却要重启才生效，等于半失效。
  let readSettings: () => unknown = () => readEffectiveConfig(baseConfig)
  function applyResolvedConfig(resolved: unknown): void {
    // 接缝适配 ④：resolved 只是 loader 侧的组合 base（settings 热更 /
    // config-set / config-reset 传进来的值），用户层在文件里——重算时必须
    // 再叠加一次文件层且文件优先；否则「保存成功 → 热更回填」会把刚写进
    // 文件的值又抹回 base 默认值，用户看到的就是「点了保存却没保住」。
    const merged = readEffectiveConfig(pickRecallConfig(resolved))
    // 先解 volatile ref 再走 createConfig：新面下 resolved 的字段是 Volatile
    // 对象，不解会把用户覆盖值静默读成默认值（见 unwrapConfig 注释）。
    Object.assign(cfg, createConfig(unwrapConfig(merged)))
  }
  const settingsHooks = {
    setSource: (fn: () => unknown) => { readSettings = fn },
    onChange: () => applyResolvedConfig(readSettings()),
  }
  // settings 接线本体（两代面分派 + 三条旧面注册路径 + 新面 volatile 热更挂接）：
  // dshSettings 经参数注入——接线模块不 import 私有 peer，CI 单测可直测
  // 注册 entry 的解 volatile ref 行为（c3cc8a7 回归钉）。接线抛错按 skip 记录。
  // 接缝适配 ④：installSettingsNamespace **保留**（它只做 settings 面的
  // namespace / volatile 热更接线，本身无副作用：空桩上没有旧面独立函数，
  // 新面探针在宿主 ns 上能挂就挂、挂不上就静默 return），但配置读写与热更
  // 不再依赖它——读写在 config-file.ts（端点直接读写 config.json），热更走
  // 上面 applyResolvedConfig 的活绑定。结论：settings 面完全不可用时（本插件
  // 内嵌形态的常态），设置卡片依然能保存、能恢复默认、能即时生效。
  installSettingsNamespace({
    ctx, dshSettings, config, settingsHooks, applyResolvedConfig,
    recordError: (message) => rt.recordError(message),
  })

  // 平台门控：win32 走 PowerShell 模板，linux/darwin 走 bash 模板。
  // 其余平台干净短路：init 返回 unsupported，Client 弹一次性提示。
  const supported = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin'

  // 请求体上限：端点里 exclude-set 接受用户任意文本，无上限时可被无限
  // POST 撑爆内存。1MB 远超正常配置体量，超限干净报错而不是悄悄截断。
  // connection 的 buffered 模式另有部署级上限（默认 300MiB），此处保留插件
  // 自己的更严语义——两道闸互不冲突。
  const MAX_BODY_BYTES = 1048576

  // 快照管理列表的结果缓存（apply 级跨请求共享）：30s 缓存让二次打开即时；
  // delete 与新快照落地时失效。listCache/excludeCache 是可变 holder——routes
  // 层改属性（items/payload），本文件的事件接线读同一引用。
  // PF-6：事件接线不再清空 items 而是 stale 标记——list 端点先用旧 items
  // 立即应答（对话中打开快照管理不再等全量 dump），后台 dump 更新缓存
  // （refreshing 持有进行中的 promise 做 in-flight 去重，stale 期间重复
  // list 不重复起进程）；Client 收到 stale 标记静默再拉一次。
  const listCache = { at: 0, items: null, stale: false, refreshing: null }
  // 排除配置枚举缓存（30s）：exclude-set 成功写入后立即失效。
  const excludeCache = { at: 0, payload: null }
  // 全量磁盘占用缓存（30s，PF-3）：删除/gc 后失效（占用变化必须立即可见），
  // 每条消息不失效——快照带来的增量由 TTL 到期自然覆盖，不然 TTL 形同虚设。
  const usageCache = { at: 0, payload: null }

  // 会话标题/文本两段式读取（live 秒回，冷会话由 Client 异步补齐）
  const sessionInfo = createSessionInfo(ctx)

  // 响应统一 JSON，content-type 与原 sendJson 同款（含 charset）——客户端按
  // r.json() 解析，编码声明与迁移前保持一致。
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  // 统一错误映射：业务失败与系统异常分离，文案与诊断解耦。code 给
  // Client 做分支判断，message 直接展示。
  function errBody(error: unknown): { ok: false; code: string; message: string } {
    // error 可能是 Error 实例或裸值：message 字段按未知形状断言读取
    const e = error as { message?: string } | null | undefined
    const text = String(e && e.message ? e.message : error)
    if (text === E.RECALL_BODY_TOO_LARGE) return { ok: false, code: E.RECALL_BODY_TOO_LARGE, message: '请求体超过 1MB 上限' }
    return { ok: false, code: E.RECALL_ERROR, message: text }
  }

  // 任务队列按工作区隔离（queue.ts 实现，动机见其文件头）：同一 root 串行
  // ——add/preview/回滚/删除都在写同一个 git index；不同 root 并行——一个慢
  // 快照不再堵住其他会话的撤回按钮。跨 root 的批量操作走 enqueueMany。
  const queues = createQueues(process.platform === 'win32')

  // 通用并发限制器：冷会话标题/消息文本补齐会 readSession 整日志解压，
  // 全量 Promise.all 会同时压垮磁盘/CPU，限制同时最多 concurrency 个任务。
  async function runLimited<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<void> {
    const limit = concurrency > 0 ? concurrency : 4
    let index = 0
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (index < tasks.length) {
        const task = tasks[index++]
        if (task) await task()
      }
    })
    await Promise.all(workers)
  }

  // 归一化 cwd/root 路径用于跨会话同工作区比对：Windows 大小写不敏感 +
  // 去掉尾部分隔符，避免 D:\Foo 与 d:\foo\ 误判为不同目录。
  function normalizeWorkdir(path: string): string {
    if (!path) return ''
    const p = String(path)
    if (process.platform === 'win32') {
      // 2026-11-04 补强：win32 上正/反斜杠混用很常见（shell 输出的 root 与
      // Node 的 cwd 可能一边用 \ 一边用 /），只比大小写与尾分隔符会让同一个
      // 目录被当成两个，护栏就该拦的没拦。统一成 \ + 小写后比。
      const n = p.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
      return n || '\\'
    }
    return p.replace(/\/+$/, '') || '/'
  }

  // 回退前重保护检查（P0-1）：目标工作区有 agent 正在跑时拒绝预览/撤回。
  // 保守策略——不做自动取消，仅拦下操作并提示先停止。守卫式访问只为防御
  // 「未来版本改名 / agent 服务未装配」，失败视为「不忙」（fail-open）。
  //
  // 2026-11-04 拆分（本仓库移植后修的用户现场问题）：原实现把两种「忙」揉成
  // 一个布尔，于是用户看到一条死路——日志里「Agent 正在运行中，请先停止后再
  // 撤回」，而他既没在跑这个会话、也没法去停「别的会话」。两种忙的危险面
  // 完全不同：
  //   · self  = 目标会话**自己**的 agent 在跑。fork 出的子会话会继承种子，
  //     原会话归档后那个 agent 还会继续往已归档的日志里写 → 必须拦，且与
  //     撤回范围无关（session-only 也拦）。
  //   · cross = 同工作区**别的**会话 agent 在跑。它只与「文件回退」冲突
  //     （回退会覆盖对方正在改的文件）；「仅撤回对话」零 git 写操作，完全
  //     不波及它 → 不该拦。
  // 拆分后由 routes-core 按 scope 分流：session-only 只查 self，both 查两者。
  function agentBusySelf(sessionId: string | null): boolean {
    if (!sessionId) return false
    let reg: unknown = null
    try { reg = ctx.agents } catch (error) { return false } // 服务缺席按不忙（fail-open，见上方注释）
    const service = reg as { list?: () => unknown[]; get?: (id: string) => unknown } | null
    if (!service) return false
    try {
      if (typeof service.list === 'function') return isSelfAgentBusy(service.list(), sessionId)
      if (typeof service.get === 'function') {
        const agent = service.get(sessionId) as { status?: string } | null | undefined
        return Boolean(agent && agent.status === 'running')
      }
    } catch (error) { /* fail-open：服务形状对不上时按不忙处理 */ }
    return false
  }

  function agentBusyCross(sessionId: string | null, root: string | null): boolean {
    if (!root) return false
    let reg: unknown = null
    try { reg = ctx.agents } catch (error) { return false }
    const service = reg as { list?: () => unknown[] } | null
    if (!service || typeof service.list !== 'function') return false
    try {
      return isCrossAgentBusy(service.list(), sessionId, root, normalizeWorkdir)
    } catch (error) { /* fail-open */ }
    return false
  }

  /** 合并语义（两种忙都算）：intent-journal 的「跨会话同工作区」判据与
   *  旧调用点仍用它，行为与原实现逐字等价。 */
  function agentBusy(sessionId: string | null, root: string | null): boolean {
    return agentBusySelf(sessionId) || agentBusyCross(sessionId, root)
  }

  // 枚举当前全部已知 exclude 文件并按路径去重。exclude-get 直接消费结果；
  // exclude-set 用它做路径白名单校验，堵死「借 API 写任意文件」的通道。
  async function listExcludeFiles() {
    const roots = new Set(state.stores.keys())
    for (const session of ctx.sessions.list()) {
      const cwd = session && session.header && session.header.cwd
      if (cwd) roots.add(cwd)
    }
    const byFile = new Map()
    await Promise.all(Array.from(roots).map(async (root) => {
      try {
        const store = await rt.resolveStore(root)
        if (store && !byFile.has(store.excludeFile)) byFile.set(store.excludeFile, { store, roots: [] })
        byFile.get(store.excludeFile).roots.push(root)
      } catch (error) {
        /* 单个根解析失败只影响它自己，不拖垮整个列表 */
      }
    }))
    // 磁盘兜底：冷启动时会话注册表为空（惰性载入），但 home 容器目录可能
    // 早已存在（历史快照）。容器在 ⇒ 共享 exclude.txt 可编辑。
    try {
      const container = await rt.resolveHomeContainer()
      if (container) {
        const probe = rt.scripts.stripBom(await rt.runShell(rt.scripts.dirExistsScript(container), { stdoutMaxBytes: 4096 })).trim()
        if (probe === 'YES') {
          const excludeFile = container + (rt.isWin ? '\\' : '/') + 'exclude.txt'
          if (!byFile.has(excludeFile)) {
            // 伪 store：仅承载 readExclude/writeExclude 用到的 excludeFile 与 home
            byFile.set(excludeFile, { store: { dir: container, home: true, excludeFile }, roots: [] })
          }
        }
      }
    } catch (error) {
      /* 兜底失败退回注册表结果 */
    }
    return byFile
  }

  // 工作区 cwd 全集：live 注册表只是子集，sessionQuery.listSessions 是
  // 「live + 磁盘冷元数据」的完整语料。manage list 与 delete 兜底共用。
  async function collectCwds() {
    const cwds = new Set()
    for (const session of ctx.sessions.list()) {
      const cwd = session && session.header && session.header.cwd
      if (cwd) cwds.add(cwd)
    }
    try {
      const querySvc = ctx.get<SessionQueryEngine>('sessionQuery')
      if (querySvc && typeof querySvc.listSessions === 'function') {
        for (const record of await querySvc.listSessions()) {
          const cwd = record && record.header && record.header.cwd
          if (cwd) cwds.add(cwd)
        }
      }
    } catch (error) { /* 冷元数据不可用时退回 live 注册表 */ }
    return cwds
  }

  // 一条 shell dump 全部 store 元数据（容器子目录 + 降级候选目录的 STATE /
  // root.txt / index.json / lineage.json），manage list 与 delete 兜底共用。
  // 失败一律 fail-loud：先记「最近错误」再抛，由调用方决定降级还是摆到用户面前
  // （旧行为是静默返回空 Map——issue #30 里树连提示都没有，只能翻日志）。
  async function dumpStores(): Promise<Map<string, StoreDumpInfo>> {
    const container = await rt.resolveHomeContainer()
    const extras = Array.from(await collectCwds()).map((cwd) => cwd + (rt.isWin ? '\\' : '/') + '.dsh-recall-snapshots')
    try {
      const text = rt.scripts.stripBom(await rt.runShell(rt.scripts.storesDumpScript(container || '', extras), { timeoutMs: 120000, stdoutMaxBytes: 8388608 }))
      return parseStoresDump(text)
    } catch (error) {
      const detail = String((error as Error && (error as Error).stack) || error)
      console.error('recall stores dump failed:', detail)
      // 设置页「最近错误」是用户唯一能自查的面，dump 失败必须落进去
      rt.recordError('recall stores dump failed: ' + detail)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  // 磁盘反查某快照归属的 store：dump 全部 index 后按 id 查找。delete 的
  // 兜底路径用它消灭「列表可见但内存缺失 ⇒ 误报不存在」。
  async function locateSnapshotOnDisk(id: string): Promise<{ store: StoreInfo; root: string } | null> {
    if (!id) return null
    // dump 失败这里降级为「找不到」：失败原因已进最近错误，单条删除还有内存命中
    // 路径，不该因为一次枚举失败把用户挡在错误码前
    let dump: Map<string, StoreDumpInfo>
    try { dump = await dumpStores() } catch (error) { return null }
    const hints = new Map()
    for (const [root, st] of state.stores.entries()) {
      if (st && st.dir) hints.set(st.dir, root)
    }
    for (const [dir, info] of dump) {
      const hit = (info.entries || []).find((e) => e && e.id === id)
      if (!hit) continue
      // root 优先取 root.txt 权威值（info.root），index.json 条目的 hit.root
      // 可能有丢反斜杠的历史坏数据（否则解析到错误 hash 的 store 删错目录）
      const root = info.root || hints.get(dir) || (typeof hit.root === 'string' && hit.root) || null
      if (!root) continue
      try {
        const store = await rt.resolveStore(root)
        if (store) return { store, root }
      } catch (error) { /* 单个 root 解析失败继续找 */ }
    }
    return null
  }

  // 收集全量快照记录（内存 + 磁盘 dump 并集），供树形管理的按工作区/会话
  // 批量删除使用。去重只按 id——同一消息 ID 全局唯一。
  async function collectAllSnapshotRecords() {
    const records = new Map()
    function add(id: string, root: string | null, sessionId: string | null, time: unknown): void {
      if (!id || typeof id !== 'string') return
      const old = records.get(id)
      if (!old) {
        records.set(id, {
          id,
          root: root || null,
          sessionId: sessionId || null,
          time: typeof time === 'number' ? time : 0
        })
        return
      }
      // 同一消息 ID 可能出现磁盘先占位、内存后补全的情况：用更全的
      // root/sessionId/time 覆盖旧值，避免树形节点归到「未知」导致批量
      // 删除按工作区/会话匹配不到。
      if (!old.root && root) old.root = root
      if (!old.sessionId && sessionId) old.sessionId = sessionId
      if (!old.time && time) old.time = time
    }
    for (const [id, s] of state.snapshots.entries()) {
      if (s) add(id, s.root, s.sessionId, s.time)
    }
    const dump = await dumpStores()
    const hints = new Map()
    for (const [root, st] of state.stores.entries()) {
      if (st && st.dir) hints.set(st.dir, root)
    }
    for (const [dir, info] of dump) {
      const baseRoot = info.root || hints.get(dir) || null
      for (const e of info.entries || []) {
        if (!e || typeof e.id !== 'string') continue
        // root 优先取 root.txt 权威值（info.root）——index.json 条目的 e.root
        // 可能带历史丢反斜杠的坏数据（删除/展示按错误 root 解析错 store）
        add(e.id, baseRoot || (typeof e.root === 'string' && e.root) || null, e.sessionId, e.time)
      }
    }
    return records
  }

  // ---- A2 操作意图 journal（崩溃恢复 + U4 留痕）----
  // 恢复期动作经 deps 注入既有机制，不在 journal 模块复制实现：diff 复用
  // snaps.diffFor（幂等判定）、reset 复用 H1 的 rescueScript + RESCUE_OK
  // 哨兵、护栏复用 agentBusy（root 单参调用：sessionId 传 null 即「跨会话
  // 同工作区」判定）。
  const intentJournal = createIntentJournal({
    runShell: rt.runShell,
    writeTextViaShell: rt.writeTextViaShell,
    scripts: rt.scripts,
    isWin: rt.isWin,
    recordError: rt.recordError,
    workspaceMatchesTag: async (messageId) => {
      // diff 无差异 = 工作区已与 snap-<messageId> 一致（回退实际已完成）。
      // diffFor 返回 null（快照不在内存索引）按「未完成」保守进救援判定。
      const d = await snaps.diffFor(messageId)
      return Boolean(d && d.total === 0 && d.changes.length === 0)
    },
    resetToSafety: async (store, safetyId, root) => {
      // 与 rescueRollback 同款复位：rescueScript（reset --hard 完整 tag 名）
      // + RESCUE_OK 哨兵校验；失败按 false 交 journal 记录（保留记录、下次
      // 启动重试），不在这里编排手动命令——逃生门在撤回结果面板里。
      try {
        const out = await rt.runShell(rt.scripts.rescueScript(root, store, state.gitExe || '', 'snap-' + safetyId), { timeoutMs: 600000, stdoutMaxBytes: 65536 })
        return String(out || '').indexOf('RESCUE_OK') >= 0
      } catch (error) {
        // 复位命令失败：交 journal 统一记录（fail-loud），此处不重复告警
        return false
      }
    },
    agentBusy: (root) => agentBusy(null, root),
  })

  // ---- 根就绪链（预热与 init 共用，in-flight 去重）----
  // 实现与「产物 root 早退」判据住 root-ready.ts（独立成模块才能被单测直接
  // 钉住）；这里只做装配，链本体对预热与 init 端点完全同一条。
  const ensureRootReady = createEnsureRootReady({ rt, snaps, journal: intentJournal, cfg })

  // ---- 端点表组装：核心路由 + 管理路由，合并进单一 endpoints 对象，
  // 由下方 connection exact 路由逐端点注册（端点名 = /api/recall/ 后第一段，
  // 无跨域命名冲突）。
  const deps = {
    ctx, rt, snaps, maint, state, cfg, supported,
    enqueueFor: queues.enqueueFor, enqueueMany: queues.enqueueMany,
    agentBusy, agentBusySelf, agentBusyCross, runLimited, ensureRootReady, errBody,
    // 拆分后的两个判据单独下发：routes-core 按撤回范围分流（session-only 只查
    // self，both 两者都查）。agentBusy 保留给旧调用点与 intent-journal。
    listExcludeFiles, dumpStores, locateSnapshotOnDisk, collectAllSnapshotRecords,
    listCache, excludeCache, usageCache, sessionInfo, titleFromEvents, messageTextFromEvents,
    // readSettings 传活绑定而非当前引用（A1）：dsh-settings 服务晚挂载时
    // setSource 会重绑定 readSettings——按值捕获的副本停在旧闭包（入口
    // config），config-reset 会按旧值「恢复默认」。活绑定让消费者每次调用
    // 都取到当前闭包。
    applyResolvedConfig, readSettings: () => readSettings(), DEFAULTS, rescueRollback, intentJournal, E,
    // issue #19 撤回终态事件广播：闭包注入保持 ctx 不解构纪律，routes 域
    // 不直接持有 ctx；单测可注入桩断言事件名与 payload
    emitEvent: (event: string, payload: unknown) => ctx.emit(event, payload),
  }
  const endpoints = {
    ...createRoutesCore(deps),
    ...createRoutesManage(deps),
  }

  // 端点分发：connection 的载体无关 exact 路由（web 与桌面端共用同一份注册）。
  // web 端由 client-connection 把 /api 前缀挂到 webServer 之下，桌面端由
  // dsh-desktop-host 用 createSharedFetchHandler('/api') 直接分发——客户端的
  // 请求路径 /api/recall/<name> 与方法 POST 在两种环境完全一致。
  const handleRecall = async (request: Request): Promise<Response> => {
    const name = new URL(request.url).pathname.replace(/^\/api\/recall\/?/, '').split('/')[0] ?? ''
    const endpoint = (endpoints as Record<string, (args: unknown) => Promise<unknown>>)[name]
    if (!endpoint) {
      // exact 路由未命中时宿主直接 404；本分支只在 pathname 形态异常时兜底
      return jsonResponse({ ok: false, code: E.RECALL_UNKNOWN_ENDPOINT, message: 'unknown endpoint: ' + name })
    }
    try {
      const text = await request.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error(E.RECALL_BODY_TOO_LARGE)
      const args = text.trim() ? JSON.parse(text) : {}
      return jsonResponse(await endpoint(args))
    } catch (error) {
      // 端点抛错统一转错误响应体（errBody 归一 code/message，不落诊断）
      return jsonResponse(errBody(error))
    }
  }

  // connection 可选注入：register 的注册本体挂在 connection 插件 fiber 上
  // （实现里 owner = this.ctx，不是调用者），返回值必须用 effect 包裹——否则
  // HMR 重载会撞「exact Fetch route ... is already registered」；disposer 是
  // 异步的，cordis 的 effect cleanup 会等待它完成。
  ctx.inject(['connection'], (connectionCtx) => {
    for (const name of Object.keys(endpoints)) {
      connectionCtx.effect(() => connectionCtx.connection.fetch.register({
        path: '/api/recall/' + name,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handleRecall,
      }))
    }
  })

  // 快照事件与启动预热仅在受支持平台注册（见上方 supported 短路说明）
  if (!supported) return

  // 每条用户消息触发快照（子代理会话跳过）；快照完成后接一次维护
  // （定期 gc / 会话清理）——两者排进**该会话工作区**的队列，与同仓库的
  // 其他写操作互斥，但不再挡住别的会话（issue #29 的队列堵塞项）。
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'user/message') return
    const data = event.data
    if (!data || typeof data.id !== 'string' || !data.id) return
    const source = data.source
    if (!source || source.kind !== 'user') return
    if (session && session.header && session.header.origin === 'subagent') return
    const messageId = data.id
    const time = event.time
    // root 解析有缓存（首次才跑 shell）；解析失败时 key 退化为全局链——
    // 宁可串行，也不能让同一个仓库并发出两把写锁。
    void (async () => {
      const root = await rt.resolveRoot(session.id)
      // 快照总开关：cfg 按调用时读取，设置页热更即时生效。关闭时只冻结新建，
      // maybeMaintain 照常跑——已停增的存储仍需被 gc/清理治理。
      await queues.enqueueFor(root, async () => {
        if (cfg.snapshotEnabled) await snaps.captureSnapshot(session.id, messageId, time)
      })
      await queues.enqueueFor(root, () => maint.maybeMaintain(session.id))
      // PF-6：不清 items 只标 stale——列表先按旧数据应答、后台补新（见 listCache 注释）
      listCache.stale = true
    })().catch((error) => rt.recordError('recall snapshot error: ' + String(error))) // 事件触发不阻塞宿主，失败只进错误缓冲
  })

  // 启动预热：所有已存在工作区解析存储、重建索引与孤儿快照，并清理旧版
  // 项目内 blobs 目录（home 可用时）。不触发维护（开机预热应尽量轻）。
  ;(async () => {
    // 预热是唯一在 apply 期就执行 shell 命令的路径：cordis 按 fiber 逐个
    // apply，recall 可能先于 pwsh-sandbox 的 subprocess 注入链完成，此刻
    // runShell 会命中「cannot get required service \"subprocess\" in inactive
    // context」（cordis 无 ready 事件，只能轮询探活）。探活用 UTF8_PRELUDE
    // 这类纯编码模板常量（空执行、无副作用），就绪后预热照跑；10s 内未
    // 就绪则放弃预热——与原先 .catch 吞错放弃同语义，只是不再刷启动噪音。
    let shellReady = false
    for (let i = 0; i < 20 && !shellReady; i++) {
      try {
        await rt.runShell(rt.scripts.UTF8_PRELUDE, { timeoutMs: 10000, stdoutMaxBytes: 4096 })
        shellReady = true
      } catch { await new Promise((resolve) => setTimeout(resolve, 500)) } // 未就绪：500ms 后重试（20 次窗口，理由见上方注释）
    }
    if (!shellReady) return
    const warmupRoots = new Map()
    for (const session of ctx.sessions.list()) {
      const cwd = session && session.header && session.header.cwd
      if (cwd && !warmupRoots.has(cwd)) warmupRoots.set(cwd, session.id)
    }
    const querySvc = ctx.get<SessionQueryEngine>('sessionQuery')
    if (querySvc && typeof querySvc.listSessions === 'function') {
      try {
        const records = await querySvc.listSessions()
        for (const record of records || []) {
          // listSessions 记录形如 {header, live, persisted}，会话 id 在
          // header.id——此前误用顶层 record.id（恒 undefined），预热重建的
          // 孤儿快照 sessionId 记为空，树形管理里会落进「已删除会话」。
          const id = record && record.header && record.header.id ? record.header.id : null
          const cwd = record && record.header && record.header.cwd
          if (cwd && !warmupRoots.has(cwd)) warmupRoots.set(cwd, id)
        }
      } catch (error) { /* 冷元数据不可用则退回 live 注册表 */ }
    }
    // issue #24：预热链限流两路并发——每个工作区一条链、每链数条 shell 命令
    // （每条一个 pwsh 进程），7 个工作区全并发会在启动期叠出数十个进程把
    // 单核打满。链本体经 ensureRootReady 与 init 端点共享（同 root 只跑一次）。
    const warmupTasks = Array.from(warmupRoots, ([cwd, sessionId]) => () =>
      ensureRootReady(cwd, sessionId || '')
        .then(() => {})
        .catch(() => {}) // 预热链失败整体吞掉（不刷启动噪音，原语义）
    )
    await runLimited(warmupTasks, 2)
  })().catch((error) => {
    // 预热整体自吞 + 留诊断（不写 recordError：预热是纯优化，宿主退出期/启动竞态
    // 都会命中，写进用户可见的「最近错误」只会是噪音——那条通道只收用户可行动的
    // 环境失败）。为什么必须接这个 catch：宿主可能在预热途中卸载（headless 打印
    // 帮助后立即退出、HMR、门禁 dispose），此刻 ctx.sessions 抛「inactive context」，
    // 未接的 rejection 会被 cordis 加载器记成 fatal load failure 而打断宿主退出
    // （2026-09-30 headless 实弹；详见 plan-warmup-unhandled-rejection）。
    console.error('recall warmup skipped:', error)
  })
}
