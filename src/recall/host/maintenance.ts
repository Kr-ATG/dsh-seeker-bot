/**
 * dsh-recall-plugin — 快照维护（ctx 绑定的工厂，无模块级副作用）
 *
 * 职责：磁盘占用治理，两件事——
 * 1. 定期 git gc：全量保留策略下把 loose 对象压 pack + 跨版本 delta，
 *    无损（所有 tag 可达对象一个不丢），通常省一半以上空间；
 * 2. 会话删除联动清理：会话日志已从磁盘消失时，删除该会话全部快照 tag
 *    并重写索引，空间由紧随的同一次 gc --prune=now 真正释放。
 *
 * 触发点在每条用户消息快照之后的同一条串行队列里（见 index.js 的事件
 * 接线），因此 gc/清理与快照天然互斥，不存在 git 锁竞态。
 */

// gc 节流阈值来自 config 域（设置页「插件配置」卡片可实时改写 cfg，
// 因此这里按调用时取值而不是工厂创建时快照；环境变量
// DSH_RECALL_GC_SNAPS/GC_HOURS 仍最高优先，见 config.js）：
// 每 gcSnaps 条快照或距上次 gc gcHours 小时，先到先触发。默认「50 条或
// 24 小时」——重活（gc）一天至多一次的量级，轻会话用户也不会等太久。

// gc 失败重试退避（毫秒）：失败（超时/磁盘/杀软）只把 gcLastAt 回拨到
// 「此刻 - gcHours + 退避」，让下一轮在退避窗口后自动重试，而不是推进完整
// gcHours 周期。实测教训：失败推进整天周期会让对象库滚雪球——每次 gc 都更
// 重、更容易超时，最终永远完不成（数 GB loose、in-pack 恒 0）。退避期间
// gcCount 条数门槛照常生效，不会退化成「每条消息都重试」。
// 与 GC_TIMEOUT_MS 同属内部策略常量，不走 Config：回拨量由「gcHours − 退避」
// 决定，退避单开成字段就能配出「退避长于周期」（gcLastAt 落到未来、永不重试）
// 这类无意义组合；同类先例见 scripts.posix.js 的 STALE_LOCK_MIN、snapshots.js
// 的 FUSE_AFTER（合规清单 #3 的豁免面）。
const GC_RETRY_BACKOFF_MS = 1800000

// 单次 gc 超时（毫秒）：GB 级 loose 对象库 repack 可超 10 分钟，被杀的 gc
// 永远完不成；30 分钟给大库足够余量。gc 与快照同在串行队列，只影响维护节奏。
// 此处是把原先内联的 timeoutMs: 600000 具名化，不是新增可调参数；不走 Config
// 的定性同 GC_RETRY_BACKOFF_MS——要改 gc 节奏的用户改 gcHours 即可，超时是被
// 动兜底而非节流旋钮。
const GC_TIMEOUT_MS = 1800000

import type { Runtime, StoreInfo, SnapshotInfo } from '../types/state.js'
import type { HostContext, SessionQueryEngine } from '../types/dsh-contract.js'
import type { ResolvedConfig } from '../types/config.js'
import type { SnapshotsApi } from './snapshots.js'
import type { StoreDumpInfo } from './dump-parse.js'

// P1-3 纯逻辑：按 root 分组选出超限部分的最旧快照（time 升序，time=0 孤儿
// 最旧优先），模块级导出供 tests/unit 直接钉边界；工厂内 enforceLimits 复用。
export interface SnapshotLite {
  id: string
  time: number
}
export function selectOverLimitVictims(snapshots: Map<string, SnapshotInfo>, limit: number): Map<string, SnapshotLite[]> {
  if (!limit || limit <= 0) return new Map() // 0 或负值 = 不限制
  const byRoot = new Map<string, SnapshotLite[]>()
  for (const [id, s] of snapshots.entries()) {
    if (!s || !s.root) continue
    // get-or-create 守卫（A6）：替代原 `get(...)!` 非空断言——断言靠的是
    // 上一行的 has/set，类型层不可见；显式分支让两条路径都自证非空。
    const list = byRoot.get(s.root)
    if (list) list.push({ id, time: s.time })
    else byRoot.set(s.root, [{ id, time: s.time }])
  }
  const victims = new Map<string, SnapshotLite[]>()
  for (const [root, list] of byRoot) {
    if (list.length <= limit) continue
    const excess = list.length - limit
    // 按时间升序排：time=0 最旧，优先清；同时间保插入序（先入先出）
    list.sort((a, b) => (a.time || 0) - (b.time || 0))
    victims.set(root, list.slice(0, excess))
  }
  return victims
}

// S2-3 按时间保留的纯逻辑：retentionDays <= 0 不启用；按 root 分组，
// 命中「time > 0 且早于 cutoff」的入选（time=0 孤儿视为最旧，一并最先
// 清——与 selectOverLimitVictims 同构）。模块级导出供单测钉边界。
export function selectExpiredVictims(snapshots: Map<string, SnapshotInfo>, retentionDays: number, now: number): Map<string, SnapshotLite[]> {
  if (!retentionDays || retentionDays <= 0) return new Map()
  const cutoff = (typeof now === 'number' ? now : Date.now()) - retentionDays * 86400000
  const byRoot = new Map<string, SnapshotLite[]>()
  for (const [id, s] of snapshots.entries()) {
    if (!s || !s.root) continue
    // time=0 孤儿（rebuildOrphans 重建）无真实时间，视为最旧列入
    if (s.time > 0 && s.time >= cutoff) continue
    if (!byRoot.has(s.root)) byRoot.set(s.root, [])
    byRoot.get(s.root)!.push({ id, time: s.time })
  }
  return byRoot
}

export interface MaintenanceApi {
  maybeMaintain(sessionId: string): Promise<void>
  runGc(sessionId: string, force: boolean): Promise<boolean>
  runGcAll(): Promise<boolean>
  enforceLimits(): Promise<number>
  enforceRetention(): Promise<number>
  sweepDeletedSessions(): Promise<void>
}

// M3（issue #18 收尾）：磁盘 store 全集的来源。index.ts 的 dumpStores 一条
// shell 出「容器子目录 + 降级候选目录」的 root.txt/index.json；缺省（单测、
// 无容器）时退化为「只用内存缓存」，磁盘覆盖与空仓回收都不生效——保持旧行为。
export interface MaintenanceDeps {
  dumpStores?: () => Promise<Map<string, StoreDumpInfo>>
}

export function createMaintenance(ctx: HostContext, rt: Runtime, snaps: SnapshotsApi, config: ResolvedConfig, deps: MaintenanceDeps = {}): MaintenanceApi {
  const sessions = ctx.sessions
  const state = rt.state
  // 平台选择的脚本模板（gc/purge 两套模板同名导出）
  const S = rt.scripts

  // 删除一个会话的全部快照：按 root 分组（同一会话可能换过工作目录），
  // tag 分块删除规避命令行长度上限，索引重写交给 snaps.saveIndex。
  // best-effort：单块失败只记日志，剩余块继续；tag 残留由下次清理幂等收尾。
  async function purgeSession(sessionId: string): Promise<number> {
    const byRoot = new Map<string, string[]>()
    for (const [id, s] of state.snapshots.entries()) {
      if (!s || s.sessionId !== sessionId) continue
      // get-or-create 守卫（A6）：替代 `get(...)!` 断言，两条路径各自自证非空
      const list = byRoot.get(s.root)
      if (list) list.push(id)
      else byRoot.set(s.root, [id])
    }
    let purged = 0
    for (const [root, ids] of byRoot) {
      let store: StoreInfo | null = state.stores.get(root) || null
      if (!store) {
        // 冷启动时 store 缓存可能还没建：现场解析一次而不是直接跳过——
        // 跳过会让该 root 的快照永远清不掉（sweep 每轮都 miss）
        try { store = await rt.resolveStore(root) } catch (error) { store = null }
      }
      if (!store || !state.gitExe) continue
      // A3：格式守卫——拒写态下不删 tag（tag 删了而索引写被拒会留下失配状态；
      // 告警由 guard 侧节流 recordError，不中断宿主）
      if (!(await snaps.guardStoreFormat(store))) continue
      try {
        for (let i = 0; i < ids.length; i += 100) {
          await rt.runShell(S.purgeTagsScript(store, state.gitExe, ids.slice(i, i + 100).map((id) => 'snap-' + id)), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
        }
        for (const id of ids) state.snapshots.delete(id)
        await snaps.saveIndex(root, sessionId)
        purged += ids.length
      } catch (error) {
        // 已告警；单个会话清理失败不阻断其余（purged 照常累计已成功的）
        rt.recordError('recall purge session failed: ' + String(error))
      }
    }
    if (purged > 0) console.error('recall purged snapshots of deleted session:', sessionId, purged)
    return purged
  }

  // 扫描索引里出现过的全部会话：不在 sessions 注册表、也不在磁盘会话目录
  // 里的，才认定「已删除」。
  // PF-7：一次 listSessions 建 id 集合替代逐会话 readSession 冷读——后者
  // 对每个非 live 会话解压全量日志且跑在串行队列里，会话多的老工作区 gc
  // 一到就把后续快照/撤回全堵在队尾；listSessions 是「目录级 header 枚举、
  // 不触碰全量日志」（I8：记录 id 在 header.id），一次调用即得全部磁盘
  // 会话 id 集。判定语义与旧「readSession 成败」等价且更保守：归档会话
  // 日志仍在磁盘（集合中保留，不被误清——旧路径同样靠这一点）、日志损坏
  // 但文件在的也保留（purge 不可逆，宁可少清）。
  // 保守闸门保持：sessionQuery 服务（或 listSessions）不存在、枚举抛异常
  // 时整体跳过——无法枚举就无法区分「已删除」和「只是冷着」，误删快照
  // 不可逆，宁可不清理。
  // titles 半项（PF-7 原案）：探针（tests/probe/api-surface.test.js）确认
  // SessionHeader 无 title 字段（标题住在事件日志里）→ 冷标题无法走
  // listSessions，titles 冷读维持 readSession 现状。
  async function sweepDeletedSessions(): Promise<void> {
    const ids = new Set<string>()
    for (const s of state.snapshots.values()) {
      if (s && s.sessionId) ids.add(s.sessionId)
    }
    if (!ids.size) return
    const query = ctx.get<SessionQueryEngine>('sessionQuery')
    if (!query || typeof query.listSessions !== 'function') return
    let diskIds: Set<string>
    try {
      diskIds = new Set(((await query.listSessions()) || [])
        .map((r) => r && r.header && r.header.id)
        .filter((v): v is string => Boolean(v)))
    } catch (error) {
      // 枚举失败整体跳过（宁可不清理，论证见上方注释）
      return
    }
    for (const id of ids) {
      if (sessions.get(id)) continue
      if (diskIds.has(id)) continue
      await purgeSession(id)
    }
  }

  // 存储总量上限（P1-3）：按 root 分组统计，超限按 time 升序删最旧。
  // 调用点（runGc/runGcAll）都在串行队列里，与快照互斥，无 git 锁竞态。
  // 删除前 console.error 留痕（静默删历史撤回点必须可追溯，与 purgeSession
  // 同款）；删除后重写索引。time=0 的孤儿条目（rebuildOrphans 重建）视为
  // 最旧优先清理——它们没有真实时间，先于有时间的快照被清。
  // 分组与选中逻辑在模块级 selectOverLimitVictims（单测直接钉边界）。
  async function enforceLimits() {
    const victimsMap = selectOverLimitVictims(state.snapshots, config.maxSnapshotsPerWorkspace)
    if (!victimsMap.size) return 0
    let dropped = 0
    for (const [root, victims] of victimsMap) {
      let store: StoreInfo | null = state.stores.get(root) || null
      if (!store) {
        // 现场解析失败按无 store 跳过该 root（与 sweepDeletedSessions 同款理由）
        try { store = await rt.resolveStore(root) } catch (error) { store = null }
      }
      if (!store || !state.gitExe) continue
      // A3：格式守卫——拒写态下不删 tag（同 purgeSession 的理由）
      if (!(await snaps.guardStoreFormat(store))) continue
      try {
        for (let i = 0; i < victims.length; i += 100) {
          await rt.runShell(S.purgeTagsScript(store, state.gitExe, victims.slice(i, i + 100).map((v) => 'snap-' + v.id)), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
        }
        for (const v of victims) state.snapshots.delete(v.id)
        await snaps.saveIndex(root, null)
        dropped += victims.length
        console.error('recall enforceLimits dropped ' + victims.length + ' oldest snapshots for: ' + root + ' (max ' + config.maxSnapshotsPerWorkspace + ')')
      } catch (error) {
        // 已告警；单 root 失败继续下一个
        rt.recordError('recall enforceLimits failed for ' + root + ': ' + String(error))
      }
    }
    return dropped
  }

  // 按时间保留（S2-3）：对每个 root 清掉早于保留窗口的快照。结构与
  // enforceLimits 同款（tag 分块删除 + saveIndex + 留痕），与条数上限
  // 各自独立触发，在同一轮 gc 周期里先后执行。时间维度的删除同样
  // 静默丢历史撤回点，故 console.error 留痕与 enforceLimits 一致。
  async function enforceRetention(): Promise<number> {
    const victimsMap = selectExpiredVictims(state.snapshots, config.retentionDays, Date.now())
    if (!victimsMap.size) return 0
    let dropped = 0
    for (const [root, victims] of victimsMap) {
      let store: StoreInfo | null = state.stores.get(root) || null
      if (!store) {
        // 现场解析失败按无 store 跳过该 root（与 enforceLimits 同款理由）
        try { store = await rt.resolveStore(root) } catch (error) { store = null }
      }
      if (!store || !state.gitExe) continue
      // A3：格式守卫——拒写态下不删 tag（同 purgeSession 的理由）
      if (!(await snaps.guardStoreFormat(store))) continue
      try {
        for (let i = 0; i < victims.length; i += 100) {
          await rt.runShell(S.purgeTagsScript(store, state.gitExe, victims.slice(i, i + 100).map((v) => 'snap-' + v.id)), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
        }
        for (const v of victims) state.snapshots.delete(v.id)
        await snaps.saveIndex(root, null)
        dropped += victims.length
        console.error('recall enforceRetention dropped ' + victims.length + ' expired snapshots for: ' + root + ' (retention ' + config.retentionDays + 'd)')
      } catch (error) {
        // 已告警；单 root 失败继续下一个
        rt.recordError('recall enforceRetention failed for ' + root + ': ' + String(error))
      }
    }
    return dropped
  }

  // 维护核心（节流判定 + 清理 + gc）：force 供设置页「立即 gc」手动触发，
  // 跳过阈值检查但仍走同一条串行队列调用方——与快照天然互斥的约束不变。
  // 失败不推进完整 gcHours 周期：只回拨到退避窗口后重试（GC_RETRY_BACKOFF_MS），
  // 避免「失败→整天不重试→对象继续堆积→下次更易失败」的滚雪球；也不清空
  // 时间戳——那会让后续每条消息都重试一次重量级 gc，把队列堵住。
  async function runGc(sessionId: string, force: boolean): Promise<boolean> {
    const root = await rt.resolveRoot(sessionId)
    if (!root) return false
    const store = state.stores.get(root)
    if (!store || !state.gitExe) return false
    const now = Date.now()
    const last = state.gcLastAt.get(store.git) || 0
    const count = (state.gcCount.get(store.git) || 0) + 1
    state.gcCount.set(store.git, count)
    if (!force && count < config.gcSnaps && now - last < config.gcHours * 3600000) return false
    state.gcCount.set(store.git, 0)
    let ok = false
    try {
      await sweepDeletedSessions()
      // P1-3：总量上限清理（sweep 之后、gc 之前）——与快照在同一条串行
      // 队列里，删除 tag 与 gc 互斥，无 git 锁竞态；best-effort，
      // 自身失败不进 catch 的主错误路径（enforceLimits 内部已兜）。
      await enforceLimits()
      // S2-3：按时间保留清理（与条数上限维度各自独立，同条串行队列）
      await enforceRetention()
      await rt.runShell(S.gcScript(store, state.gitExe), { timeoutMs: GC_TIMEOUT_MS, stdoutMaxBytes: 4096 })
      ok = true
    } catch (error) {
      // 已告警；失败不推进完整周期、按退避回拨（理由见函数头注释）
      rt.recordError('recall maintenance failed: ' + String(error))
    }
    state.gcLastAt.set(store.git, ok ? Date.now() : Date.now() - config.gcHours * 3600000 + GC_RETRY_BACKOFF_MS)
    return true
  }

  // 磁盘 store 全集（M3-1）：内存缓存只覆盖「启动预热与历次操作认识过」的
  // 工作区；会话已删、或从未在本进程 init 过的仓库在磁盘上有、内存里没有——
  // 它们恰好是 issue #18 的 GB 级残骸（refs 空 + index 伪可达），此前
  // runGcAll 对它们完全无感。dump 失败按空处理并记错误（与 dumpStores 既有
  // 语义一致：枚举失败不等于「没有数据」，但维护是 best-effort）。
  async function dumpDiskStores(): Promise<Map<string, StoreDumpInfo>> {
    if (typeof deps.dumpStores !== 'function') return new Map()
    try {
      return await deps.dumpStores()
    } catch (error) {
      // 已告警；枚举失败按空 Map 继续（维护 best-effort，见函数头注释）
      rt.recordError('recall disk store dump failed: ' + String(error))
      return new Map()
    }
  }

  // 内存 + 磁盘并集，按 store.git 去重（同一仓库两来源的 git-dir 必然一致）
  function mergeStores(disk: Map<string, StoreDumpInfo>): StoreInfo[] {
    const byGit = new Map<string, StoreInfo>()
    for (const store of state.stores.values()) {
      if (store && store.git) byGit.set(store.git, store)
    }
    for (const dir of disk.keys()) {
      if (!dir) continue
      const store = rt.storeFromDir(dir, false)
      if (store && store.git && !byGit.has(store.git)) byGit.set(store.git, store)
    }
    return Array.from(byGit.values())
  }

  // 该 store 目录是否还挂着内存快照：防「磁盘索引丢了/被隔离，内存却有条目」
  // 这种极端组合被误删（root.txt 的 root 是权威映射，内存 stores 的表是补充）
  function memorySnapshotCount(dir: string, root: string | null): number {
    let n = 0
    for (const snap of state.snapshots.values()) {
      if (!snap) continue
      const owner = state.stores.get(snap.root)
      if ((owner && owner.dir === dir) || (root && snap.root === root)) n++
    }
    return n
  }

  // M3-2：整目录回收——M1 只清对象库（目录与 root.txt 还在），这一步把「确认
  // 没有任何可回退数据」的空仓库目录整个删掉（issue #18 报告者手工做的那步）。
  // 逐条保守判定，任一条不满足就留着：
  //   * 「没有可回退数据」＝ 索引明确为空数组（拍过快照、后来删光了）**或**
  //     indexState 为 absent（建过仓但从没拍过快照——issue #30 遗留的空壳）。
  //     其余一律不删：present/quarantined 的 entries=null 是损坏/隔离现场（待
  //     复查），unknown 是旧版脚本的输出（看不出形态），foreign 不是我们的目录；
  //   * 任何 snap-* tag 存在即代表有可回退快照，不删（以磁盘真值二次确认）；
  //   * 内存里还有该目录/该 root 的快照，不删。
  // 删前留 console.error（不可逆操作必须可追溯，同 purgeSession 的纪律）；
  // best-effort，单条失败只记错误继续。调用点在逐 store gc **之后**：先让 M1
  // 的条件清理把那批伪可达对象回收掉，再删空壳，避免「刚删目录、gc 又对着它跑」。
  async function reapEmptyStores(disk: Map<string, StoreDumpInfo>): Promise<number> {
    if (!state.gitExe) return 0
    let removed = 0
    for (const [dir, info] of disk) {
      if (!dir || !info) continue
      const emptyIndex = Array.isArray(info.entries) && info.entries.length === 0
      const neverCaptured = info.entries === null && info.indexState === 'absent'
      if (!emptyIndex && !neverCaptured) continue
      if (memorySnapshotCount(dir, info.root) > 0) continue
      const store = rt.storeFromDir(dir, false)
      try {
        const tags = S.stripBom(await rt.runShell(S.listTagsScript(store, state.gitExe), { timeoutMs: 60000, stdoutMaxBytes: 4096 }))
        if (String(tags).trim()) continue
        await rt.runShell(S.legacyRmScript(dir), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
        // 内存侧同步摘除：后续操作不该再对着已删目录跑
        for (const [root, st] of state.stores.entries()) {
          if (st && st.dir === dir) state.stores.delete(root)
        }
        state.gcLastAt.delete(store.git)
        state.gcCount.delete(store.git)
        if (info.root) state.indexLoaded.delete(info.root)
        console.error('recall reaped empty store:', dir)
        removed++
      } catch (error) {
        // 已告警；单条目录失败继续下一条（best-effort，见函数头注释）
        rt.recordError('recall reap store failed for ' + dir + ': ' + String(error))
      }
    }
    return removed
  }

  // 全局 gc（设置卡片没有会话上下文）：清理扫描一次 + 逐 store gc（内存 ∪ 磁盘）
  // + 空仓目录回收。逐个 best-effort，单个失败记错误继续。调用方（manage 端点）
  // 把它排进同一条串行队列，与快照天然互斥，无 git 锁竞态。
  async function runGcAll(): Promise<boolean> {
    if (!state.gitExe) return false
    const disk = await dumpDiskStores()
    const stores = mergeStores(disk)
    if (!stores.length) return false
    try {
      await sweepDeletedSessions()
    } catch (error) {
      // 已告警；清扫失败不阻断后续步骤（逐个 best-effort，见函数头注释）
      rt.recordError('recall sweep failed: ' + String(error))
    }
    try {
      // P1-3：全局清理一次（runGcAll 无会话上下文，enforceLimits 自身按
      // root 遍历内存快照，天然覆盖全部已知工作区）
      await enforceLimits()
    } catch (error) {
      // 已告警；该步失败不阻断后续步骤（逐个 best-effort）
      rt.recordError('recall enforceLimits failed: ' + String(error))
    }
    try {
      // S2-3：按时间保留全局清理一次
      await enforceRetention()
    } catch (error) {
      // 已告警；该步失败不阻断后续步骤（逐个 best-effort）
      rt.recordError('recall enforceRetention failed: ' + String(error))
    }
    let done = 0
    for (const store of stores) {
      try {
        await rt.runShell(S.gcScript(store, state.gitExe), { timeoutMs: GC_TIMEOUT_MS, stdoutMaxBytes: 4096 })
        done++
        state.gcLastAt.set(store.git, Date.now())
      } catch (error) {
        // 已告警；失败按退避回拨重试窗口（与 runGc 同款），循环继续下一个 store
        rt.recordError('recall gc failed for ' + (store && store.git) + ': ' + String(error))
        state.gcLastAt.set(store.git, Date.now() - config.gcHours * 3600000 + GC_RETRY_BACKOFF_MS)
      }
      state.gcCount.set(store.git, 0)
    }
    await reapEmptyStores(disk)
    return true
  }

  // 每条消息快照后串行调用（见 index.js 事件接线）
  async function maybeMaintain(sessionId: string): Promise<void> {
    await runGc(sessionId, false)
  }

  // 模块收敛：runGc/runGcAll 之外的内部步骤不对外暴露面；enforceLimits /
  // sweepDeletedSessions 保留导出供单测以工厂形态驱动（注入假 rt/ctx 钉
  // 执行链路；PF-7 sweep 判定矩阵依赖导出）。
  return { maybeMaintain, runGc, runGcAll, enforceLimits, enforceRetention, sweepDeletedSessions }
}
