/**
 * dsh-memory 文件存储层：entries.json / state.json / changes/<date>.jsonl /
 * 各层 md 产物。所有写入走「tmp + rename」原子写，防止半写损坏。
 * 数据根：${DSH_HOME:-~/.dsh}/memories/dsh-memory/（与 memory-evolve 遗留数据同根目录、不同前缀，互不读写）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type {
  ChangeRecord,
  MemoryConfig,
  MemoryEntry,
  MemoryKind,
  MemoryOwner,
  OwnerFilter,
  ProjectMeta,
  RevisionMeta,
  SessionTickerState,
  StoreState,
} from '../types.js'

/** 数据根目录。 */
export function memoryHome(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'memories', 'dsh-memory')
}

/**
 * 工作区路径现在还找不找得到。
 *
 * 用途只有一个：把**文件夹已经不在**的项目从「活工作区」里区分出来。项目档案
 * （projects/<hash>/meta.json）不会随文件夹消失而消失——它按 cwd 派生 hash 存着，
 * 目录被人删掉、改名叫、或者整个挪走之后，档案仍然躺在盘上，于是面板里会永久
 * 多出一行「工作区」，用户对着一个不存在的目录拨开关（实测 2026-10-23 用户问到
 * 《这个文件夹不是没了吗，怎么还会有工作区》）。
 *
 * 只做 existsSync 而不 stat 类型：移动硬盘没插、网络盘没挂的时候同样返回 false，
 * 那正是需要提示用户的状态（这一行拨了不会生效），而不是误报。所以面板据此
 * **标灰**而不是隐藏——盘挂回来重新拉一次就恢复，档案一条不丢。
 */
export function isWorkspacePathAlive(path: string): boolean {
  if (typeof path !== 'string' || path.trim() === '') return false
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** workspace 路径 → 项目目录 hash（sha1 前 12 位）。 */
export function projectHashOf(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12)
}

/**
 * 记忆条目稳定 id：`mem_<sha1(owner|scope|projectHash|content)>`，同内容同归属合并。
 *
 * **owner 必须参与 key**（schema v6）：所有 bot 共用 `D:\Seeker-Bot` 这一个工作区，
 * `projectHash` 对它们完全相同。若 id 不含 owner，两个 bot 记下同一句话会被合并成
 * 一条，隔离就无从谈起。缺省 `work` 让所有既有调用点保持原有语义。
 *
 * 代价：存量条目的 id 会随本次升级整体变化，需要 `scripts/migrate-memory-owner.mjs`
 * 一次性重算；`legacyEntryIdOf()` 保留旧算法，供迁移脚本与兼容读取使用。
 */
export function entryIdOf(
  content: string,
  scope: 'global' | 'project',
  projectHash: string | null,
  owner: MemoryOwner = 'work',
): string {
  const key = `${owner}\u0000${scope}\u0000${projectHash ?? ''}\u0000${content.trim()}`
  return `mem_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

/**
 * schema v5 及更早的条目 id 算法（不含 owner）。
 *
 * 只用于两件事：迁移脚本读旧 id、以及迁移尚未跑完时 `getEntry()` 的回退查找。
 * 新代码一律用 `entryIdOf()`，不要再用它生成 id。
 */
export function legacyEntryIdOf(
  content: string,
  scope: 'global' | 'project',
  projectHash: string | null,
): string {
  const key = `${scope}\u0000${projectHash ?? ''}\u0000${content.trim()}`
  return `mem_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

/** 条目的归属（缺省 = work，兼容 schema v5 及更早）。 */
export function ownerOf(entry: Pick<MemoryEntry, 'owner'>): MemoryOwner {
  return entry.owner ?? 'work'
}

/**
 * owner 过滤判据：`bots` = 所有 Bot（`bot:` 前缀），其余走精确匹配。
 *
 * 面板 / API 里凡是要「按归属收窄」的地方都走这一条（GET /list、POST /delete-today、
 * POST /consolidate），避免三处各写一份前缀判断——那种分叉最难发现：某处把
 * `bots` 当成字面归属，结果一个 Bot 都匹配不上，表现为「过滤后啥都没有」。
 */
export function matchesOwner(entry: Pick<MemoryEntry, 'owner'>, owner: string): boolean {
  const current = ownerOf(entry)
  return owner === 'bots' ? current.startsWith('bot:') : current === owner
}

/** 按 owner 过滤条目集合（整理输入等批量场景）；owner 缺省 = 不过滤。 */
export function filterByOwner<T extends Pick<MemoryEntry, 'owner'>>(entries: T[], owner?: string): T[] {
  return owner === undefined ? entries : entries.filter(entry => matchesOwner(entry, owner))
}

/**
 * 条目集合里出现过的归属（去重；`work` 排最前，其余按字典序）。
 *
 * 用途：每日整理按 owner 分组（ticker 的 runDailyCompile）。所有 Bot 与 Work 共用
 * 同一个工作目录（projectHash 完全相同），只按 scope 切分时一个批次里会同时有多个
 * 归属的条目，LLM 一次 merge 就把两台 Bot 的相似记忆合成一条，合并产物落在第一条
 * 源条目的归属上——另一方的记忆凭空消失。无人值守路径同样不能跨归属合批。
 *
 * 排序固定（work 在前）只为让日志与调试输出稳定；每日只跑一次，排序开销可忽略。
 * 空集合返回空数组：调用方据此跳过整个整理步骤，不发空请求。
 */
export function ownerGroupsOf(entries: Array<Pick<MemoryEntry, 'owner'>>): MemoryOwner[] {
  const seen = new Set<MemoryOwner>()
  for (const entry of entries) seen.add(ownerOf(entry))
  return [...seen].sort((a, b) => (a === 'work' ? -1 : b === 'work' ? 1 : a.localeCompare(b)))
}

/**
 * 「今日记忆」的可删除判定（面板「删除今日」与 POST /delete-today 共用）。
 *
 * 口径：置顶与已软废弃的条目一律跳过（前者是用户显式标记，后者已在回收站）；
 * scope / projectHash / owner 只在明确传入时收窄（owner 语义见 matchesOwner）。
 *
 * 为什么放这里而不是留在 api.ts 里内联：它是「哪些条目会被删」的唯一判据，
 * 必须能被回归测试直接断言（api.ts 是 HTTP 层，单独测要起服务器）。
 */
export function isDeletableToday(entry: MemoryEntry, options: {
  /** 本地日期 YYYY-MM-DD，由调用方算好传进来（避免同一批过滤跨过零点）。 */
  today: string
  scope?: 'global' | 'project'
  projectHash?: string
  owner?: string
}): boolean {
  if (entry.pinned || entry.deprecated === true) return false
  if (options.scope !== undefined && entry.scope !== options.scope) return false
  if (options.scope === 'project' && options.projectHash !== undefined && entry.projectHash !== options.projectHash) return false
  if (options.owner !== undefined && !matchesOwner(entry, options.owner)) return false
  const stamp = entry.updatedAt ?? entry.createdAt
  const time = Date.parse(stamp)
  // updatedAt/createdAt 是 UTC ISO，用 localDate 换算成本地日期再比对。
  return !Number.isNaN(time) && localDate(new Date(time)) === options.today
}

/**
 * 条目是否已过期（临时信息 TTL，见 MemoryEntry.ttlDays）。
 *
 * 判据从**创建时间**起算，不是最近更新/命中：ttlDays 表达的是「这件事本身的有效
 * 期」（今天要发多少条），不会因为被读了一次就续命。createdAt 解析失败时一律按
 * 未过期处理——宁可多注入一条，也不要把一条正常记忆因为时间戳坏了永久藏起来。
 */
export function isExpired(entry: Pick<MemoryEntry, 'createdAt' | 'ttlDays'>, now = Date.now()): boolean {
  const ttl = entry.ttlDays
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) return false
  const created = Date.parse(entry.createdAt)
  if (Number.isNaN(created)) return false
  return now - created > ttl * 86_400_000
}

/**
 * 会话 id → 记忆归属。
 *
 * Personal Agent 的会话 id 形如 `pa-bot-v2-<botId>`（见 `src/host/personal/agent.ts`
 * 的 `SESSION_PREFIX`）。这里用宽松正则（`pa-bot-` 前缀 + 可选版本段）而不是写死
 * `pa-bot-v2-`：bot 侧换前缀是发生过的事（v2 就是为了绕开坏会话），写死会让升级
 * 那天所有 bot 记忆静默退回 `work`，而那是最难发现的一类回归。
 *
 * 匹配不上的一律视为 Work 会话——这是安全侧默认：宁可把 bot 记忆当成 Work 的
 * （主 bot 和 Work 都看得到），也不要把 Work 记忆误判成某个 bot 的（那会让它在
 * 其他会话里凭空消失）。
 */
export function ownerOfSessionId(sessionId: string | undefined | null): MemoryOwner {
  if (typeof sessionId !== 'string') return 'work'
  const match = /^pa-bot-(?:v\d+-)?(.+)$/.exec(sessionId.trim())
  if (match === null) return 'work'
  const botId = match[1].trim()
  /*
   * `pa-bot-v2-` 这种残缺 id 会因正则回溯落到 botId = `v2-`（可选组放弃匹配，
   * 整段塞进捕获组）。它不是合法 botId，认下来会得到一个永远没人用的归属，
   * 所以显式拒绝：只有「版本段」没有「实体 id」一律当 Work。
   */
  if (botId === '' || /^v\d+-$/.test(botId)) return 'work'
  return `bot:${botId}`
}

/**
 * 模型工具 memory_consolidate 的归属收窄：Bot 会话返回自己的归属，
 * Work 会话返回 undefined（= 全量，保持原有语义）。
 *
 * 为什么 Work 不收窄、Bot 收窄：用户是主人，Work 侧「整理全部记忆」是原有语义，
 * 收窄会让他以为机器人漏整理了；而 Bot 是**分身**，它没有资格替主人整理别的分身
 * 的记忆——一次跨 owner 的 merge 会把两台 Bot 的相似记忆合成一条，合并产物落在
 * 第一条源条目的归属上，另一方的记忆就此消失。
 *
 * 拿不到会话 id 时同样返回 undefined：宁可退回全量（还能救），也不要猜一个归属
 * 把整理范围静默缩小。
 */
export function consolidateOwnerForSessionId(sessionId: string | undefined | null): OwnerFilter | undefined {
  const owner = ownerOfSessionId(sessionId)
  return owner === 'work' ? undefined : owner
}

/** 校验落盘数据里的 owner 是否合法（脏数据一律当作缺失，由会话溯源兜底）。 */
function isMemoryOwner(value: unknown): value is MemoryOwner {
  return typeof value === 'string' && (value === 'work' || (value.startsWith('bot:') && value.length > 4))
}

/** 本地日期 YYYY-MM-DD。 */
export function localDate(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** ISO 时间（本地时区偏移保留）。 */
export function nowIso(): string {
  return new Date().toISOString()
}

// ── 持久化韧性：快照链 + 读回校验 + 三级恢复 ──────────────────────────
//
// 背景：原来只有「tmp + rename」的原子写。原子写保证的是「要么旧内容、要么
// 新内容，不会有半截」，它**不保证新内容写对了**——实测出过
// `EPERM: rename state.json.tmp -> state.json`（Windows 上目标文件被别的
// 进程短暂占用），以及历史上 entries.json 整份变成 NUL 的事故。前者当场抛错
// 还好，后者是**静默**的：文件还在、大小也没归零，只是内容不再是 JSON，
// 下次启动 readJsonSync 吞掉异常返回 fallback → 整库记忆凭空消失，且没有任何
// 一处报错。这份数据没有远程副本，丢了就是丢了。
//
// 三道防线，对应三种不同的坏法：
//   ① 写前快照：覆盖之前把**旧的好文件**复制一份 `.bak-<ISO>`，留 3 代。
//      治「新内容坏 / 写入过程中断电」。
//   ② 写后读回校验：写完重新读一遍，确认内容完好。治「rename 成功但落盘内容
//      不对」（磁盘满、杀软改写、NUL 填充）。不通过就抛错，绝不静默成功。
//   ③ 加载恢复链：主文件坏 → 依次试快照（新到旧）→ 全坏则把坏文件改名成
//      `.corrupt-<ISO>` 留证（**不清空、不覆盖**），以空库启动并大声报错。
//
// 两条刻意的取舍：
//   · **只对 entries.json / state.json 这类 JSON 开快照**，md 产物与 changes
//     JSONL 不开——前者可从 entries 重建，后者是只追加的流水，快照纯属浪费。
//     atomicWriteText 因此保留 snapshot=false 的快速路径。
//   · 快照只在「现有文件完好」时做。现有文件已经坏了还复制一份，只会把更早
//     的好快照挤出保留窗口——这正是「快照链被坏数据占满」的经典死法。

/** 快照保留代数。3 代覆盖「连续三次写坏」的极端情况，再多只是在堆历史垃圾。 */
const SNAPSHOT_KEEP = 3

/** 判断一份载荷是否完好：能 JSON.parse，且不是 NUL 主导。 */
function isHealthyPayload(raw: string): boolean {
  if (raw.length === 0) return false
  // NUL 主导 = 典型文件系统事故（断电/杀软）。先判这个，是为了让错误信息说人话
  // ——「内容被 NUL 填充」比「Unexpected token」有用得多。
  const nulCount = (raw.match(/\0/g) ?? []).length
  if (nulCount / raw.length > 0.1) return false
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

/** 列出某文件的快照（新 → 旧）。 */
function listSnapshots(file: string): string[] {
  const dir = dirname(file)
  const prefix = basename(file) + '.bak-'
  try {
    return readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .sort()
      .reverse()
      .map(name => join(dir, name))
  } catch {
    return []
  }
}

/** 剪枝快照：只留最新 keep 代。失败不影响主流程。 */
function pruneSnapshots(file: string, keep = SNAPSHOT_KEEP): void {
  for (const stale of listSnapshots(file).slice(keep)) {
    try { unlinkSync(stale) } catch { /* 被占用/已删，忽略 */ }
  }
}

/**
 * 写前快照：把当前磁盘上的**好文件**复制一份。
 *
 * 文件不存在（首次写）、或现有内容已经坏了（复制坏数据会挤掉更早的好快照）
 * 都直接跳过。快照失败也不阻断写入——最坏是回到「只有原子写」的旧水位。
 */
function snapshotBeforeWrite(file: string): void {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (!isHealthyPayload(raw)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    copyFileSync(file, file + '.bak-' + stamp)
    pruneSnapshots(file)
  } catch {
    // 快照失败不阻断写入。
  }
}

/**
 * 写后读回校验：确认刚落盘的内容确实完好。
 *
 * 只对 JSON 调用（isJson=true）。校验失败时把文件恢复成快照里的上一代——
 * 留着坏文件比退回上一个好版本更糟。恢复也失败就算了，至少错误抛出去了。
 */
async function verifyAfterWrite(file: string, expectedBytes: number): Promise<void> {
  let actual: string
  try {
    actual = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error('atomicWrite: 写入后读回失败（' + file + '）：' + (error instanceof Error ? error.message : String(error)))
  }
  // 字节数先比一遍：NUL 填充/截断这类问题在 parse 之前就能看出来，
  // 且能区分「内容被改」与「内容压根没写完」。
  if (Buffer.byteLength(actual, 'utf8') !== expectedBytes) {
    await restoreFromSnapshot(file)
    throw new Error(
      'atomicWrite: 写后字节数不符（' + file + '，期望 ' + expectedBytes + '，实际 ' + Buffer.byteLength(actual, 'utf8') + '），已尝试回滚到上一份快照',
    )
  }
  if (!isHealthyPayload(actual)) {
    await restoreFromSnapshot(file)
    throw new Error('atomicWrite: 写后内容损坏（' + file + '），已尝试回滚到上一份快照')
  }
}

/** 把文件恢复成最新一份完好快照（读回校验失败时用）。失败静默——错误由调用方抛。 */
async function restoreFromSnapshot(file: string): Promise<void> {
  for (const snapshot of listSnapshots(file)) {
    try {
      if (!isHealthyPayload(readFileSync(snapshot, 'utf8'))) continue
      await copyFile(snapshot, file)
      return
    } catch {
      continue
    }
  }
}
/**
 * 原子写文本：tmp + rename（同一目录内）。
 *
 * 临时名必须**每次唯一**。曾经这里写死 `${file}.tmp`，于是两个并发写同一文件时：
 * A 写完 tmp → B 把 tmp 截断重写 → A rename(tmp, file) 成功（落盘的却是 B 的
 * 内容）→ B rename(tmp, file) 抛 ENOENT。记忆库同一路径的并发写是常态
 * （面板改一条记忆的 compileAll 与会话结束触发的 final compile 并不共享
 * ticker 那条串行队列，两个 HTTP 请求在各 await 处随时交错），用户会看到
 * 一句完全不知所云的「ENOENT: rename ... memory.md.tmp」——而记忆其实已经
 * 进 entries.json 了，只是产物没编译出来。
 *
 * 拼上 pid + 随机段之后，同一路径的并发写互不干扰：各自的 tmp 独立，A 落盘
 * 的是 A 的内容，B 落盘的是 B 的内容，最后一个 rename 的胜出即最新写入。
 */
export async function atomicWriteText(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temp, content, 'utf8')
    await rename(temp, file)
  } catch (error) {
    // 写一半失败时别把 tmp 留在盘上（下次启动会以为有历史残留）。
    try { await unlink(temp) } catch { /* 已被 rename 走或从不存在 */ }
    throw error
  }
}

/**
 * 原子写 JSON：在原子写之上再叠「写前快照 + 写后读回校验」。
 *
 * 只给 JSON 用：md 产物与 changes JSONL 不开快照（前者可从 entries 重建，
 * 后者是只追加的流水，快照纯属浪费）；读回校验也只对 JSON 有意义——
 * 它的判据是「能不能 parse」，对 md 无从判断。
 */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`
  snapshotBeforeWrite(file)
  await atomicWriteText(file, content)
  await verifyAfterWrite(file, Buffer.byteLength(content, 'utf8'))
}

/** 读取 JSON，缺失/损坏返回 fallback。 */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** 追加一行 JSONL（追加本身用 appendFile；损坏容忍，读侧幂等）。 */
export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  const { appendFile } = await import('node:fs/promises')
  await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

/** 读取 JSONL（容忍坏行），返回 { entries, seq }。 */
export async function readJsonl<T>(file: string): Promise<T[]> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch {
      // 单条解析失败跳过，不中断批次。
    }
  }
  return out
}

/** 修订版本保留上限（滚动清理，超过只保留最近 N 个）。 */
const REVISION_KEEP = 20

/**
 * perSession 保留上限。
 *
 * state.json 实测被 1585 个会话记录撑到 205KB，而每个会话只存一个 turnCount，
 * 全仓零清理。真正还会被再次读写的会话只有最近活跃的那几十个，裁到 500 条
 * 既保住热点，又给这个文件一个确定的上界（否则它只随使用时长单调增长）。
 */
const PER_SESSION_KEEP = 500

/**
 * perSession 裁剪 + 废弃字段剥离（原地修改传入的 state）。
 *
 * 淘汰口径：turnCount 降序保留前 PER_SESSION_KEEP 个，同轮数按会话 id 稳定排序。
 * state.json 里没有时间戳字段，turnCount 是唯一持久化的活跃度信号——为排序专门
 * 加一个 lastSeenAt 反而要把每个会话记录撑大一圈，得不偿失。
 *
 * 剥离 lastInjectedStep：该字段随「注入改为每会话仅首步一次」而废弃，types.ts
 * 已删除；老 state.json 里仍留着它，不剥就会跟着每次写盘一直回写到磁盘上。
 * 用黑名单式 delete 而不是白名单重建，是为了将来给 SessionTickerState 加字段时
 * 不会因为这里忘了同步而把新字段静默丢掉。
 */
function prunePerSessionState(state: StoreState): void {
  // 坏文件（perSession 被写成数组/字符串）先兜回空表：后面所有索引访问都按对象来。
  const raw = state.perSession as unknown
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    state.perSession = {}
    return
  }
  const perSession = raw as Record<string, SessionTickerState | null | undefined>
  // 删除走 unknown 索引：值类型含 undefined 的索引签名允许 delete，但显式断言
  // 不依赖这条细则，读代码的人也不必先确认 TS 版本行为。
  const mutable = perSession as unknown as Record<string, unknown>
  const keys = Object.keys(perSession)
  const kept: Array<{ key: string; turnCount: number }> = []
  for (const key of keys) {
    const value = perSession[key]
    // 坏数据（null / 非对象）直接丢掉：读侧任何 .turnCount 都会炸。
    if (value === null || typeof value !== 'object') {
      delete mutable[key]
      continue
    }
    delete (value as unknown as Record<string, unknown>).lastInjectedStep
    kept.push({ key, turnCount: Number.isFinite(value.turnCount) ? value.turnCount : 0 })
  }
  if (kept.length <= PER_SESSION_KEEP) return
  kept.sort((a, b) => b.turnCount - a.turnCount || a.key.localeCompare(b.key))
  const next: Record<string, SessionTickerState> = {}
  for (const { key } of kept.slice(0, PER_SESSION_KEEP)) {
    next[key] = perSession[key] as SessionTickerState
  }
  state.perSession = next
}

/**
 * MemoryStore：所有记忆数据的读写入口。
 * 线程模型：调用方（ticker / turn/end 捕获）通过同一实例串行化写入，
 * 内部只保证单文件操作的原子性。
 */
export class MemoryStore {
  readonly root: string

  /** 回刷 debounce（毫秒）：合并短窗口内的多次写。 */
  private static readonly FLUSH_DEBOUNCE_MS = 500

  /** 内存态条目（权威副本；磁盘 entries.json 是它的节流回刷镜像）。 */
  private entries: MemoryEntry[] = []
  /** 内存态是否落后于磁盘（有待回刷）。 */
  private dirty = false
  /** 节流回刷计时器。 */
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 已撤回的轮次（`sessionId#turn`）。
   *
   * 记忆提取是 turn/end 之后的异步任务，撤回可能发生在它真正落库之前。
   * 记下墓碑后，抽取侧在候选写入前后都能看到并跳过；同一进程内有效。
   */
  private readonly recalledTurns = new Set<string>()
  /**
   * 已撤回的真人消息（`sessionId#userMessageId`）。
   *
   * Bot 允许执行中插话：第 2、3 句可能在同一个 turn 里。只按 turn 立墓碑会把
   * 第 3 句的抽取也一起跳过，所以能拿到消息 id 时优先按消息立墓碑。
   */
  private readonly recalledMessages = new Set<string>()

  /** 构造时加载失败的说明（空串 = 正常）。供 index.ts 打日志用。 */
  readonly loadWarning: string

  /**
   * 记忆**内容**版本号：任何改变「会进上下文的记忆内容」的写操作 +1。
   *
   * 为什么需要它：注入按设计每会话只在首步做一次（见 inject.ts），于是面板上
   * 新加/改过/删掉的记忆在**当前会话里永远不生效**——注入是记忆唯一的出口，
   * 出口关着，用户改了也白改。注入侧拿这个版本号跟「上次注入时的版本」比，
   * 变了就重新注入一次（一轮最多一次）。
   *
   * 只记「内容」不记「访问」：命中加分（applyHits）与整理标记（markConsolidated）
   * 虽然也走写路径，但都不改变注入文本——把它们算进来会让每次注入都触发下一轮
   * 重注，等于取消「仅首步注入」，token 成本翻倍。
   *
   * 随 entries.json 一起落盘：内存态是权威副本，落盘只为跨进程单调不回退
   * （重启后从盘上读回，不会回到 0 而让旧会话误判成「内容变了」）。
   */
  private revisionValue = 0

  /** 当前记忆内容版本号（同步可读：注入侧在 pre-step 里逐 step 比较）。 */
  get revision(): number {
    return this.revisionValue
  }

  constructor(root = memoryHome()) {
    this.root = root
    const { data, warning } = loadEntriesWithRecovery(this.entriesFile())
    this.loadWarning = warning
    this.entries = migrateEntries(data.entries)
    this.revisionValue = revisionOf(data)
  }

  /** 重新载入磁盘上的 entries.json，同步更新内存态（用于从云端同步还原后热生效）。 */
  reload(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.dirty = false
    const { data } = loadEntriesWithRecovery(this.entriesFile())
    this.entries = migrateEntries(data.entries)
    /*
     * 重新载入意味着「盘上的记忆整体换了一份」（云端还原、手工改文件、另一进程
     * 写入），即使盘上的 revision 不比内存大也必须让版本号变化：否则正在跑的
     * 会话会认为上下文里的记忆副本仍然有效，热还原对它完全不可见。
     */
    const diskRevision = revisionOf(data)
    this.revisionValue = diskRevision > this.revisionValue ? diskRevision : this.revisionValue + 1
  }

  // ── 路径 ────────────────────────────────────────────────────────────

  entriesFile(): string {
    return join(this.root, 'store', 'entries.json')
  }

  stateFile(): string {
    return join(this.root, 'store', 'state.json')
  }

  configFile(): string {
    return join(this.root, 'store', 'config.json')
  }

  /** 读运行时配置覆盖（config.json；缺失返回空）。 */
  readConfigSync(): Partial<MemoryConfig> {
    return readJsonSync<Partial<MemoryConfig>>(this.configFile(), {})
  }

  /** 写运行时配置覆盖（面板设置持久化）。 */
  async writeConfig(config: Partial<MemoryConfig>): Promise<void> {
    await atomicWriteJson(this.configFile(), config)
  }

  changesFile(date: string): string {
    return join(this.root, 'changes', `${date}.jsonl`)
  }

  globalDir(): string {
    return join(this.root, 'global')
  }

  projectDir(hash: string): string {
    return join(this.root, 'projects', hash)
  }

  dailyFile(date: string): string {
    return join(this.root, 'daily', `${date}.md`)
  }

  // ── 条目 ────────────────────────────────────────────────────────────

  /** 全量条目索引（内存快照的浅拷贝，避免外部误改内存态）。 */
  async readEntries(): Promise<MemoryEntry[]> {
    return [...this.entries]
  }

  /** 节流回刷：标记 dirty 并在 debounce 后落盘（合并写放大）。 */
  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushNow().catch(() => undefined)
    }, MemoryStore.FLUSH_DEBOUNCE_MS)
  }

  /**
   * 立即落盘。
   *
   * dirty 的清除必须排在写盘**之后**：原来写成「先 dirty=false 再 await」，
   * 于是写盘失败时这批增量只留在内存里，而唯一能兜底的 dispose → flush()
   * 会撞上 flushNow 开头的 `if (!this.dirty) return` 直接空转——脏标记早就
   * 没了，那批数据再也写不出去。用户在面板上刚记下的东西随进程退出蒸发，
   * 且没有任何报错。
   *
   * 串行化：多个调用方（ticker 的节流 flush、手动 flush、dispose 的 flush）
   * 可能同时进来，加一把 in-flight 锁让它们排队，避免后一次拿着旧的
   * entries 快照把前一次刚落盘的新内容盖回去。
   */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flushNow()
  }

  private flushInFlight: Promise<void> = Promise.resolve()

  private async flushNow(): Promise<void> {
    if (!this.dirty) return
    const run = this.flushInFlight.then(async () => {
      if (!this.dirty) return
      // revision 与条目同一次写盘落下去：分成两个文件会出现「内容已更新、版本号
      // 还是旧的」的中间态，重启后版本号倒退，注入侧的重注判定就失准。
      await atomicWriteJson(this.entriesFile(), {
        version: 2,
        entries: this.entries,
        revision: this.revisionValue,
      })
      this.dirty = false
    })
    // 无论成败都让队列继续，但错误要原样抛给调用方去记日志/重试。
    this.flushInFlight = run.catch(() => undefined)
    return run
  }

  /**
   * 修改内存态条目（fn 原地修改传入数组或返回替换数组），随后节流回刷。
   * 单线程下内存数组的同步操作天然原子，无需额外写串行队列。
   *
   * 默认推进 revision（记忆内容变了，已注入的副本就过时了）。`bumpRevision: false`
   * 只留给**不改变注入内容**的记账写：命中加分、整理标记——它们每次注入都会跑，
   * 算成内容变更等于每轮都重注。
   */
  async mutateEntries<T>(
    fn: (entries: MemoryEntry[]) => Promise<T> | T,
    options?: { bumpRevision?: boolean },
  ): Promise<T> {
    const result = await fn(this.entries)
    if (options?.bumpRevision !== false) this.revisionValue += 1
    this.scheduleFlush()
    return result
  }

  async getEntry(id: string): Promise<MemoryEntry | undefined> {
    return this.entries.find(entry => entry.id === id)
  }

  /**
   * 新增或更新（同 id 合并）。返回 { created, entry }。
   * 同时按去重逻辑：新增时若同内容（同 scope+projectHash）已存在则合并为 update。
   */
  async upsertEntry(next: {
    content: string
    scope: 'global' | 'project'
    projectHash: string | null
    /**
     * 归属主体（schema v6）。缺省 `work`。
     *
     * 只影响「这条记忆属于谁」：id 会带上它，所以同一句话在两个 bot 下是两条。
     * 调用方**不要**为了让主 bot 看得到而写成别的 owner——可见性由读取侧推导。
     */
    owner?: MemoryOwner
    tags?: string[]
    pinned?: boolean
    importance?: number
    lastHitAt?: string | null
    layer?: 'short' | 'long'
    source?: 'extract' | 'manual' | 'bot-working-memory'
    kind?: MemoryKind
    confidence?: number
    provenance?: { sessionId?: string; turn?: number; userMessageId?: string; snippet?: string }
    /** 待确认（true = 挂起，不参与检索/注入/编译）。缺省 = 直接生效。 */
    pending?: boolean
    /**
     * 有效期天数（可选，见 MemoryEntry.ttlDays）。
     *
     * 只在**明确传值**时改：undefined 表示「不关心」——一次普通 upsert（面板改
     * 标签、提取重复命中）不该顺手把用户手动设过的 ttlDays 抹掉。要清空传 0。
     */
    ttlDays?: number
  }): Promise<{ created: boolean; entry: MemoryEntry }> {
    return this.mutateEntries(entries => {
      const id = entryIdOf(next.content, next.scope, next.projectHash, next.owner)
      const existing = entries.find(entry => entry.id === id)
      const now = nowIso()
      let entry: MemoryEntry
      if (existing !== undefined) {
        // 同内容条目已存在：若它处于软废弃状态，重新写入视为「复活」。
        const revived = existing.deprecated === true
          ? { ...existing, deprecated: undefined, deprecatedAt: undefined, deprecatedReason: undefined, supersededBy: undefined }
          : existing
        entry = {
          ...revived,
          content: next.content,
          tags: mergeTags(revived.tags, next.tags),
          pinned: next.pinned ?? revived.pinned,
          importance: Math.max(revived.importance, next.importance ?? revived.importance),
          layer: next.layer ?? revived.layer,
          updatedAt: now,
          version: revived.version + 1,
          // 更新分支同样刷新溯源：本会话既动了它，本会话就该看得见（KR 记忆卡
          // 按 provenance.sessionId 判定「本会话新增/更新」）。
          provenance: next.provenance ?? revived.provenance,
          // pending 只在调用方**明确**传值时改：undefined 表示「不关心」而非
          // 「改成已生效」，否则一次普通的 upsert（比如面板改标签）会顺手把
          // 待确认条目放行——那是把确认权白白送掉。
          ...(next.pending === undefined
            ? {}
            : next.pending
              ? { pending: true as const, pendingAt: revived.pendingAt ?? now }
              : { pending: undefined, pendingAt: undefined }),
          // ttlDays 同款语义：undefined = 不关心（保留原值），0 = 显式清空。
          ...(next.ttlDays === undefined
            ? {}
            : next.ttlDays > 0 ? { ttlDays: next.ttlDays } : { ttlDays: undefined }),
        }
        entries.splice(entries.indexOf(existing), 1, entry)
        return { created: false, entry }
      }
      entry = {
        id,
        content: next.content,
        scope: next.scope,
        projectHash: next.scope === 'project' ? next.projectHash : null,
        owner: next.owner,
        tags: next.tags ?? [],
        pinned: next.pinned ?? false,
        createdAt: now,
        updatedAt: now,
        importance: next.importance ?? 10,
        lastHitAt: null,
        layer: next.layer ?? 'short',
        source: next.source ?? 'extract',
        version: 1,
        confidence: next.confidence ?? (next.source === 'manual' ? 1 : 0.6),
        verified: next.source === 'manual',
        kind: next.kind ?? inferKind(next.tags),
        provenance: next.provenance,
        embedding: undefined,
        ...(next.pending === true ? { pending: true as const, pendingAt: now } : {}),
        ...(typeof next.ttlDays === 'number' && next.ttlDays > 0 ? { ttlDays: next.ttlDays } : {}),
      }
      entries.push(entry)
      return { created: true, entry }
    })
  }

  /**
   * 替换单条（用于裁决操作：改内容/标签/移项目/置顶/启用）。返回新条目；不存在返回 undefined。
   *
   * id 是 content+scope+projectHash 的稳定派生值，所以内容或归属变化时必须重算 id，
   * 否则 id 与内容脱钩：后续 upsertEntry（提取/手动添加）算出的新 id 找不到本条，
   * 会把同一条记忆再插一遍（面板出现重复条目）。若新 id 已存在（改成了与另一条
   * 完全相同的内容），把两条合并为一条，保留较高的 importance 与并集标签。
   */
  async patchEntry(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): Promise<MemoryEntry | undefined> {
    return this.mutateEntries(entries => {
      const index = entries.findIndex(entry => entry.id === id)
      if (index === -1) return undefined
      const current = entries[index]
      // 编辑 ≠ 确认：verified 的语义是「用户显式确认过这条内容」，而手改一个
      // 标签、点一下置顶、移个项目都不构成确认。旧实现无条件写 true，于是面板
      // 上「待确认」标记只要被编辑过一次就永久消失，用户再也分不清哪些内容是
      // 模型自己写的。patch 没带 verified 时展开语义会保留原值，不必显式赋值；
      // 真要确认，由调用方在 patch 里显式传 verified: true。
      const merged: MemoryEntry = {
        ...current,
        ...patch,
        id,
        updatedAt: nowIso(),
        version: current.version + 1,
      }
      if (merged.scope === 'global') merged.projectHash = null
      const nextId = entryIdOf(merged.content, merged.scope, merged.projectHash, ownerOf(merged))
      if (nextId === id) {
        entries[index] = merged
        return merged
      }
      // 内容/归属变了 → 换 id；撞上已有同内容条目则合并。
      const clashIndex = entries.findIndex((entry, at) => at !== index && entry.id === nextId)
      const updated: MemoryEntry = { ...merged, id: nextId }
      if (clashIndex === -1) {
        entries[index] = updated
        return updated
      }
      const clash = entries[clashIndex]
      const combined: MemoryEntry = {
        ...updated,
        tags: mergeTags(clash.tags, updated.tags),
        pinned: clash.pinned || updated.pinned,
        importance: Math.max(clash.importance, updated.importance),
        layer: clash.layer === 'long' || updated.layer === 'long' ? 'long' : 'short',
        createdAt: clash.createdAt < updated.createdAt ? clash.createdAt : updated.createdAt,
        version: Math.max(clash.version, updated.version) + 1,
      }
      entries[clashIndex] = combined
      entries.splice(index, 1)
      return combined
    })
  }

  /** 删除条目。返回是否删除成功。 */
  async removeEntry(id: string): Promise<boolean> {
    return this.mutateEntries(entries => {
      const index = entries.findIndex(entry => entry.id === id)
      if (index === -1) return false
      entries.splice(index, 1)
      return true
    })
  }

  /** 批量删除满足条件的条目；返回删除条数。 */
  async removeEntriesWhere(predicate: (entry: MemoryEntry) => boolean): Promise<number> {
    return this.mutateEntries(entries => {
      let removed = 0
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (!predicate(entries[index])) continue
        entries.splice(index, 1)
        removed += 1
      }
      return removed
    })
  }

  /** 标记某一轮已撤回：抽取侧看到后不再写入该轮的记忆。 */
  markTurnRecalled(sessionId: string | undefined, turn: number | undefined): void {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (typeof turn !== 'number' || !Number.isInteger(turn) || turn <= 0) return
    this.recalledTurns.add(`${sessionId}#${turn}`)
  }

  /** 某一轮是否已撤回。 */
  isTurnRecalled(sessionId: string | undefined, turn: number | undefined): boolean {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (typeof turn !== 'number' || !Number.isInteger(turn) || turn <= 0) return false
    return this.recalledTurns.has(`${sessionId}#${turn}`)
  }

  /** 标记某条真人消息已撤回（steer 插话场景，精确到消息而不是整轮）。 */
  markMessageRecalled(sessionId: string | undefined, userMessageId: string | undefined): void {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (typeof userMessageId !== 'string' || userMessageId === '') return
    this.recalledMessages.add(`${sessionId}#${userMessageId}`)
  }

  /** 某条真人消息是否已撤回。 */
  isMessageRecalled(sessionId: string | undefined, userMessageId: string | undefined): boolean {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (typeof userMessageId !== 'string' || userMessageId === '') return false
    return this.recalledMessages.has(`${sessionId}#${userMessageId}`)
  }

  /**
   * 清掉某会话的撤回墓碑（清空对话后调用）。
   *
   * 会话重置后 turn 号会从 1 重新开始；不清的话新会话的同一 turn 会被旧墓碑
   * 误判成「已撤回」，表现为「这个 Bot 从此不再抽取记忆」。
   */
  clearTurnRecalls(sessionId?: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') {
      this.recalledTurns.clear()
      this.recalledMessages.clear()
      return
    }
    const prefix = `${sessionId}#`
    for (const key of [...this.recalledTurns]) {
      if (key.startsWith(prefix)) this.recalledTurns.delete(key)
    }
    for (const key of [...this.recalledMessages]) {
      if (key.startsWith(prefix)) this.recalledMessages.delete(key)
    }
  }

  /**
   * 软废弃一条记忆（retire，无后继）：数据保留但默认不再检索/注入/编译。
   * 已废弃条目重复 retire 是幂等 no-op。
   */
  async retireEntry(id: string, reason?: string): Promise<MemoryEntry | undefined> {
    return this.mutateEntries(entries => {
      const index = entries.findIndex(entry => entry.id === id)
      if (index === -1) return undefined
      const current = entries[index]
      if (current.deprecated === true) return current
      const entry: MemoryEntry = {
        ...current,
        deprecated: true,
        deprecatedAt: nowIso(),
        deprecatedReason: reason?.trim() !== '' ? reason?.trim() : undefined,
        supersededBy: undefined,
        updatedAt: nowIso(),
        version: current.version + 1,
      }
      entries[index] = entry
      return entry
    })
  }

  /**
   * 修订一条记忆（revise，软废弃 + 后继）：把旧内容软废弃，写入新内容作为后继。
   * 参考 opencontext 的 oc_memory_revise 语义：{ deprecatedId, newId }。
   *
   * 后继条目复用 upsertEntry 的稳定 id 派生：新内容与库中已有条目撞 id 时
   * 直接复用（不重复插入）；旧条目标记 supersededBy 指向后继。
   * 内容未变化时视为 no-op（不产生废弃条目）。
   */
  async reviseEntry(input: {
    id: string
    content: string
    reason?: string
    tags?: string[]
    importance?: number
    kind?: MemoryKind
    provenance?: { sessionId?: string; turn?: number; userMessageId?: string; snippet?: string }
  }): Promise<{ deprecatedId: string; newId: string; entry: MemoryEntry } | undefined> {
    const content = input.content.trim()
    if (content === '') throw new Error('content 不能为空')
    const target = await this.getEntry(input.id)
    if (target === undefined) return undefined
    if (target.deprecated === true) return undefined

    const nextId = entryIdOf(content, target.scope, target.projectHash, ownerOf(target))
    // 内容没变（或只是空白差异）：无修订空间。
    if (nextId === input.id) return undefined

    // 先软废弃旧条目（supersededBy 指向后继 id；后继撞已有条目时指向已有条目）。
    await this.mutateEntries(entries => {
      const index = entries.findIndex(entry => entry.id === input.id)
      if (index === -1) return
      const current = entries[index]
      entries[index] = {
        ...current,
        deprecated: true,
        deprecatedAt: nowIso(),
        deprecatedReason: input.reason?.trim() !== '' ? input.reason?.trim() : undefined,
        supersededBy: nextId,
        updatedAt: nowIso(),
        version: current.version + 1,
      }
    })

    // 后继条目：继承旧条目的归属/层/来源/置信度/置顶，内容与标签为新的。
    // 溯源不继承：后继是本会话写下的新内容，记本会话（provenance 是「谁写的」，
    // 不是「最初由谁产生」——后者在旧条目的废弃记录里）。
    const { entry } = await this.upsertEntry({
      content,
      scope: target.scope,
      projectHash: target.projectHash,
      tags: input.tags,
      pinned: target.pinned,
      importance: input.importance ?? target.importance,
      layer: target.layer,
      source: target.source,
      kind: input.kind ?? target.kind,
      confidence: target.confidence,
      provenance: input.provenance,
    })
    return { deprecatedId: input.id, newId: entry.id, entry }
  }

  /** 复活一条已废弃的记忆（undo retire / undo revise 的后继侧）。 */
  async restoreEntry(id: string): Promise<MemoryEntry | undefined> {
    return this.mutateEntries(entries => {
      const index = entries.findIndex(entry => entry.id === id)
      if (index === -1) return undefined
      const current = entries[index]
      if (current.deprecated !== true) return current
      const entry: MemoryEntry = {
        ...current,
        deprecated: undefined,
        deprecatedAt: undefined,
        deprecatedReason: undefined,
        supersededBy: undefined,
        updatedAt: nowIso(),
        version: current.version + 1,
      }
      entries[index] = entry
      return entry
    })
  }


  /**
   * 确认一条待确认（pending）记忆：清掉 pending 标记，同时置 verified=true。
   *
   * 为什么确认要连带 verified：用户点「确认」表达的就是「这条内容我认可」，
   * 与 memory_verify 的语义完全一致。分两步置位只会让面板出现「已确认但未验证」
   * 这种没人看得懂的状态。
   *
   * 对非 pending 条目调用是幂等的（直接返回原条目），重复确认不会报错——
   * 面板双击、两个标签页同时点，都是常态。
   */
  async confirmPending(id: string): Promise<MemoryEntry | undefined> {
    return this.mutateEntries(entries => {
      const index = entries.findIndex(entry => entry.id === id)
      if (index === -1) return undefined
      const current = entries[index]
      if (current.pending !== true) return current
      const entry: MemoryEntry = {
        ...current,
        pending: undefined,
        pendingAt: undefined,
        verified: true,
        updatedAt: nowIso(),
        version: current.version + 1,
      }
      entries[index] = entry
      return entry
    })
  }

  /**
   * 拒绝一条待确认记忆：直接硬删。
   *
   * 为什么不走软废弃：pending 条目从未生效过（没进过任何上下文），不承载历史，
   * 留一条 deprecated 记录只会在回收站里堆垃圾。用户点「不要」的意图就是「这条
   * 从来没存在过」。
   *
   * 只删 pending 的：对已生效条目误调会返回 undefined 而不动数据——拒绝是危险
   * 操作，必须只能作用于「本来就还没生效」的东西（对齐 engram_reject 的同一约束）。
   */
  async rejectPending(id: string): Promise<MemoryEntry | undefined> {
    return this.mutateEntries(entries => {
      const index = entries.findIndex(entry => entry.id === id)
      if (index === -1) return undefined
      const current = entries[index]
      if (current.pending !== true) return undefined
      entries.splice(index, 1)
      return current
    })
  }

  /** 全部待确认条目（面板「待确认」页签与过期清理用）。 */
  async listPending(): Promise<MemoryEntry[]> {
    return this.entries.filter(entry => entry.pending === true)
  }
  /** 注入命中刷新（原子）：给命中的条目加分并刷新 lastHitAt，返回刷新条数。 */
  async applyHits(hitIds: Set<string>, bonus: number): Promise<number> {
    return this.mutateEntries(entries => {
      let count = 0
      for (const entry of entries) {
        if (!hitIds.has(entry.id)) continue
        entry.importance = Math.min(20, Math.round((entry.importance + bonus) * 100) / 100)
        entry.lastHitAt = nowIso()
        count += 1
      }
      return count
    }, { bumpRevision: false }) // 加分不改变注入文本：算成内容变更会让每次注入都触发下一轮重注
  }

  /**
   * 标记一批条目「刚被 LLM 整理处理过」，返回命中条数。
   *
   * 为什么要这个时间戳：整理集合原本按 updatedAt 降序取前 N 条，而整理自己产出的
   * 合并/晋升条目又会刷新 updatedAt —— 刚整理完的永远排最前，老条目永远轮不到
   * （饥饿）。改成按 lastConsolidatedAt 升序（null 最优先）后，每条都能被均匀轮转。
   *
   * 走 mutateEntries 复用同一条节流回刷队列，不另开写盘路径。
   * 目标 id 不存在时静默跳过：整理过程会重算 id（内容变则 id 变），调用方手里的
   * 是整理前的 id，部分失配属正常，不该让整批标记失败。
   */
  async markConsolidated(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const target = new Set(ids)
    return this.mutateEntries(entries => {
      const now = nowIso()
      let count = 0
      for (const entry of entries) {
        if (!target.has(entry.id)) continue
        entry.lastConsolidatedAt = now
        count += 1
      }
      return count
    }, { bumpRevision: false }) // 整理标记同样只是记账，内容没变
  }

  /** 原子替换全部条目（ticker 每日编译等批量场景；fn 返回新数组）。 */
  async replaceEntries(fn: (entries: MemoryEntry[]) => Promise<MemoryEntry[]> | MemoryEntry[]): Promise<MemoryEntry[]> {
    const next = await fn(this.entries)
    this.entries = next
    // 批量替换（含历史版本回滚、整理产出）必然改变注入内容，直接推进版本号。
    this.revisionValue += 1
    this.scheduleFlush()
    return next
  }

  // ── 变更流 ──────────────────────────────────────────────────────────

  /**
   * 追加一条变更记录。
   *
   * **owner 在这里自动补全**（schema v6），调用方一般不用管：显式传入优先，
   * 否则按 `entryId` 反查条目取 `ownerOf()`，查不到兜底 `work`。
   *
   * 为什么补在写入侧而不是逐个调用点：全仓 31 处调用绝大多数是「条目还在库里」
   * 的普通变更，反查一定成功；只有**删除路径**（条目已从数组里移除，反查必失败）
   * 和 consolidate 的汇总记录（entryId 为空串，无从反查）必须由调用方在删除前
   * 取出 owner 显式传——否则 Bot 的删除记录会被兜底成 `work`，混进 Work 的变更页。
   */
  async appendChange(change: Omit<ChangeRecord, 'id' | 'at'>): Promise<ChangeRecord> {
    const record: ChangeRecord = {
      ...change,
      // 显式值优先（删除路径的唯一正确来源）；反查兜底让普通变更免于逐点改造。
      owner: change.owner ?? await this.ownerOfEntryId(change.entryId),
      id: `chg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      at: nowIso(),
    }
    await appendJsonl(this.changesFile(localDate()), record)
    return record
  }

  /**
   * 按条目 id 反查归属，供 `appendChange` 自动补 owner。
   *
   * 查不到兜底 `work` 的两种情形都是正常的：consolidate 汇总记录 entryId 为空串，
   * 删除路径的条目已经不在数组里（那些调用点必须自己显式传 owner）。
   * 这里**不做**会话溯源兜底（`ownerOfSessionId`）——变更记录不带 sessionId，
   * 拿不到会话身份，硬猜只会把 Work 的删除记成某个 Bot 的。
   */
  private async ownerOfEntryId(entryId: string): Promise<MemoryOwner> {
    if (typeof entryId !== 'string' || entryId === '') return 'work'
    const entry = await this.getEntry(entryId)
    return entry === undefined ? 'work' : ownerOf(entry)
  }

  async readChanges(date?: string): Promise<ChangeRecord[]> {
    if (date !== undefined) return readJsonl<ChangeRecord>(this.changesFile(date))
    const dir = join(this.root, 'changes')
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const dates = files
      .filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort()
    const all: ChangeRecord[] = []
    for (const file of dates) {
      all.push(...await readJsonl<ChangeRecord>(join(dir, file)))
    }
    return all
  }

  // ── ticker 状态 ─────────────────────────────────────────────────────

  /**
   * 追加一行日志（按分类落独立文件 + 大小轮转，防无界增长）。
   * kind: extract=提取诊断 / consolidate=整理诊断 / api=API 请求（默认关闭）/ error=插件错误。
   * 轮转：当前文件 ≥ 10MB 时改名成带时间戳归档，只保留最近 5 个归档。
   */
  private async appendLog(kind: 'extract' | 'consolidate' | 'api' | 'error', line: string): Promise<void> {
    const { appendFile, stat, rename, readdir, unlink } = await import('node:fs/promises')
    const logDir = join(this.root, 'log')
    const file = join(logDir, `${kind}.log`)
    await mkdir(logDir, { recursive: true })
    const maxBytes = 10 * 1024 * 1024
    const keep = 5
    try {
      const info = await stat(file)
      if (info.size >= maxBytes) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        try { await rename(file, join(logDir, `${kind}.${stamp}.log`)) } catch { /* 忽略 */ }
        try {
          const names = (await readdir(logDir))
            .filter(name => name.startsWith(`${kind}.`) && name.endsWith('.log'))
            .sort()
          const excess = names.slice(0, Math.max(0, names.length - keep))
          for (const name of excess) {
            try { await unlink(join(logDir, name)) } catch { /* 忽略 */ }
          }
        } catch { /* 忽略 */ }
      }
    } catch { /* 文件不存在，直接追加 */ }
    await appendFile(file, `${line}\n`, 'utf8')
  }

  /** 插件错误日志（本插件 async 任务失败；DSH 控制台日志不落盘）。 */
  async appendErrorLog(stage: string, message: string): Promise<void> {
    await this.appendLog('error', `[${nowIso()}] ${stage}: ${message}`)
  }

  /** 提取诊断日志（turn= 开始/结束/耗时/候选数，排查提取卡死）。 */
  async appendExtractLog(message: string): Promise<void> {
    await this.appendLog('extract', `[${nowIso()}] ${message}`)
  }

  /**
   * 整理诊断日志：consolidate 引擎的每次「为什么没整理/整理成什么」都落盘。
   * 引擎 debug 级日志不进 DSH 控制台（不落盘），此前 consolidate 静默
   * skip/失败时磁盘上毫无痕迹，无法区分「无需整理」与「路由拿不到模型」。
   */
  async appendConsolidateLog(message: string): Promise<void> {
    await this.appendLog('consolidate', `[${nowIso()}] ${message}`)
  }

  /** API 请求诊断日志（默认关闭；仅 config.logApiRequests 开启时由 api.ts 调用）。 */
  async appendApiLog(message: string): Promise<void> {
    await this.appendLog('api', `[${nowIso()}] ${message}`)
  }

  /**
   * 读 ticker 状态。
   *
   * 读侧就做裁剪（而不是只在写侧）：所有写路径都是「readState → 改 → writeState」，
   * 只要读出来的快照已经是裁剪过的，下一次写盘就自然把上界落地——不必为清理
   * 额外造一条写路径。代价只是每次读多一次 O(n) 排序（n 是会话数，量级 1e3）。
   */
  async readState(): Promise<StoreState> {
    const state = await readJson<StoreState>(this.stateFile(), {
      schemaVersion: 1,
      perSession: {},
      lastDailyDate: null,
    })
    if (state.perSession === undefined || state.perSession === null) state.perSession = {}
    prunePerSessionState(state)
    return state
  }

  /** 写 ticker 状态（写前同样裁剪：调用方可能自己拼了一个未裁剪的 state）。 */
  async writeState(state: StoreState): Promise<void> {
    prunePerSessionState(state)
    await atomicWriteJson(this.stateFile(), state)
  }

  // ── 记忆注入开关（按会话，内存缓存 + state.json 持久化） ───────────

  /** 注入被关闭的会话 id（内存缓存；null = 未加载）。 */
  private injectDisabledCache: Set<string> | null = null
  /** 注入被显式开启的会话 id（内存缓存；null = 未加载）。 */
  private injectForcedCache: Set<string> | null = null

  private async ensureInjectCaches(): Promise<{ disabled: Set<string>; forced: Set<string> }> {
    if (this.injectDisabledCache === null || this.injectForcedCache === null) {
      const state = await this.readState()
      this.injectDisabledCache = new Set(Array.isArray(state.injectDisabled) ? state.injectDisabled : [])
      this.injectForcedCache = new Set(Array.isArray(state.injectForced) ? state.injectForced : [])
    }
    return { disabled: this.injectDisabledCache, forced: this.injectForcedCache }
  }

  /**
   * 该会话的显式开关；未单独设置返回 null（调用方回退 config.injectDefaultEnabled）。
   * 关闭列表优先于开启列表：同时出现按更保守的「不注入」处理。
   */
  async injectStateOf(sessionId: string): Promise<boolean | null> {
    const { disabled, forced } = await this.ensureInjectCaches()
    if (disabled.has(sessionId)) return false
    if (forced.has(sessionId)) return true
    return null
  }

  /** 该会话是否启用记忆注入（未单独设置时用 fallback，即配置默认值）。 */
  async isInjectEnabled(sessionId: string, fallback = true): Promise<boolean> {
    return (await this.injectStateOf(sessionId)) ?? fallback
  }

  /**
   * 设置该会话的记忆注入开关（持久化到 state.json；调用频率极低，直接写）。
   * null = 清除本会话覆盖，回到 config.injectDefaultEnabled（面板「跟随默认」）。
   */
  async setInjectEnabled(sessionId: string, enabled: boolean | null): Promise<void> {
    const { disabled, forced } = await this.ensureInjectCaches()
    const nextDisabled = new Set(disabled)
    const nextForced = new Set(forced)
    if (enabled === null) {
      nextDisabled.delete(sessionId)
      nextForced.delete(sessionId)
    } else if (enabled) {
      nextDisabled.delete(sessionId)
      nextForced.add(sessionId)
    } else {
      nextForced.delete(sessionId)
      nextDisabled.add(sessionId)
    }
    this.injectDisabledCache = nextDisabled
    this.injectForcedCache = nextForced
    const state = await this.readState()
    state.injectDisabled = [...nextDisabled]
    state.injectForced = [...nextForced]
    await this.writeState(state)
  }

  // ── 中文记忆独立注入开关（全局单值） ──────────────────────────────

  /**
   * 中文记忆注入是否开启（三态：state 显式值 ?? 调用方给的 fallback）。
   *
   * 刻意做成**全局单值**而不是会话级：主注入的会话级覆盖是为了让不同会话
   * 临时收放上下文；中文偏好记忆是跨会话恒定的语言契约，逐会话开关只会
   * 制造「这个会话说中文、下个会话说英文」的割裂。
   */
  async isZhInjectEnabled(fallback: boolean): Promise<boolean> {
    const state = await this.readState()
    return typeof state.zhInjectEnabled === 'boolean' ? state.zhInjectEnabled : fallback
  }

  /** 写中文记忆注入开关（全局单值；直接落盘，调用频率极低）。 */
  async setZhInjectEnabled(enabled: boolean): Promise<void> {
    const state = await this.readState()
    state.zhInjectEnabled = enabled
    await this.writeState(state)
  }

  // ── 对话内 HTML 卡片能力规范注入开关（全局单值） ────────────────────
  // 历史注记：曾有 diagram 注入开关（isDiagramInjectEnabled / setDiagramInjectEnabled），
  // 2026-10-09 随图形 iu kind（graph/arch/sequence）上线整体移除。
  // 旧状态文件里残留的 diagramInjectEnabled 字段无人读取，无害。

  /**
   * html 围栏规范注入是否开启（三态：state 显式值 ?? 调用方给的 fallback）。
   *
   * 与中文通道同样是**全局单值**：它是「本客户端支持什么呈现能力」的声明，
   * 不是逐会话的上下文松紧，逐会话开关只会制造「这个会话能出卡、下个不能」
   * 的不可预期。iu kind 的能力文档随本通道注入。
   */
  async isHtmlInjectEnabled(fallback: boolean): Promise<boolean> {
    const state = await this.readState()
    return typeof state.htmlInjectEnabled === 'boolean' ? state.htmlInjectEnabled : fallback
  }

  /** 写 html 规范注入开关（全局单值；直接落盘，调用频率极低）。 */
  async setHtmlInjectEnabled(enabled: boolean): Promise<void> {
    const state = await this.readState()
    state.htmlInjectEnabled = enabled
    await this.writeState(state)
  }

  // ── 团队协作规范注入开关（全局单值） ────────────────────────────────

  /**
   * 团队协作注入是否开启（三态：state 显式值 ?? 调用方给的 fallback）。
   *
   * 与 diagram / html 通道同样是**全局单值**：它投的是「这活该怎么组织」的
   * 静态纪律，跨会话恒定，逐会话开关只会制造「这个会话组队、下个不组」的
   * 不可预期。
   */
  async isTeamInjectEnabled(fallback: boolean): Promise<boolean> {
    const state = await this.readState()
    return typeof state.teamInjectEnabled === 'boolean' ? state.teamInjectEnabled : fallback
  }

  /** 写团队协作注入开关（全局单值；直接落盘，调用频率极低）。 */
  async setTeamInjectEnabled(enabled: boolean): Promise<void> {
    const state = await this.readState()
    state.teamInjectEnabled = enabled
    await this.writeState(state)
  }

  // ── 回合结束自动收口开关（全局单值） ────────────────────────────────

  /**
   * 回合结束自动收口是否开启（三态：state 显式值 ?? 调用方给的 fallback）。
   *
   * 与上面四条注入通道同样是**全局单值**：收口是一条流程纪律，不描述任何单个
   * 会话的内容，逐会话开关只会制造「这个会话收、下个不收」的不可预期。
   */
  async isTodoClosureEnabled(fallback: boolean): Promise<boolean> {
    const state = await this.readState()
    return typeof state.todoClosureEnabled === 'boolean' ? state.todoClosureEnabled : fallback
  }

  // ── 动效技能强制加载开关（全局单值） ──────────────────────────────

  /**
   * 动效技能强制加载是否开启（三态：state 显式值 ?? 调用方给的 fallback）。
   *
   * 与上面四条注入通道同构，但**默认关**：它不声明任何能力，只是把「涉及动效时
   * 先加载 harmonyos-motion」从概率行为变成确定性行为，属于用户主动打开的偏好。
   * 全局单值同理：模型该不该先加载技能是跨会话恒定的习惯，不该逐会话割裂。
   */
  async isMotionInjectEnabled(fallback: boolean): Promise<boolean> {
    const state = await this.readState()
    return typeof state.motionInjectEnabled === 'boolean' ? state.motionInjectEnabled : fallback
  }

  /** 写动效技能强制加载开关（全局单值；直接落盘，调用频率极低）。 */
  async setMotionInjectEnabled(enabled: boolean): Promise<void> {
    const state = await this.readState()
    state.motionInjectEnabled = enabled
    await this.writeState(state)
  }

  // ── 通俗解释（ELI5 模式）规范注入开关（全局单值） ─────────────────

  /**
   * 通俗解释规范注入是否开启（三态：state 显式值 ?? 调用方给的 fallback）。
   *
   * 默认关（由 config.eli5InjectDefaultEnabled 决定）：它不声明工具能力，属于用户
   * 主动打开的解释风格偏好；开启后每会话首步注入通俗易懂、多打日常比喻的规约。
   */
  async isEli5InjectEnabled(fallback: boolean): Promise<boolean> {
    const state = await this.readState()
    return typeof state.eli5InjectEnabled === 'boolean' ? state.eli5InjectEnabled : fallback
  }

  /** 写通俗解释规范注入开关（全局单值；直接落盘，调用频率极低）。 */
  async setEli5InjectEnabled(enabled: boolean): Promise<void> {
    const state = await this.readState()
    state.eli5InjectEnabled = enabled
    await this.writeState(state)
  }

  /** 写回合结束自动收口开关（全局单值；直接落盘，调用频率极低）。 */
  async setTodoClosureEnabled(enabled: boolean): Promise<void> {
    const state = await this.readState()
    state.todoClosureEnabled = enabled
    await this.writeState(state)
  }

  // ── 任务清单纪律规范注入开关（全局单值） ──────────────────────────

  /**
   * 任务清单纪律注入是否开启（三态：state 显式值 ?? 调用方给的 fallback）。
   *
   * 与 zh / html / team 同样是**全局单值**：它投的是「清单怎么列、怎么收尾」的
   * 静态纪律，跨会话恒定，逐会话开关只会制造「这个会话收、下个不收」的
   * 不可预期。
   */
  async isTodoRuleInjectEnabled(fallback: boolean): Promise<boolean> {
    const state = await this.readState()
    return typeof state.todoRuleInjectEnabled === 'boolean' ? state.todoRuleInjectEnabled : fallback
  }

  /** 写任务清单纪律注入开关（全局单值；直接落盘，调用频率极低）。 */
  async setTodoRuleInjectEnabled(enabled: boolean): Promise<void> {
    const state = await this.readState()
    state.todoRuleInjectEnabled = enabled
    await this.writeState(state)
  }

  // ── 项目 meta ───────────────────────────────────────────────────────

  async readProjectMeta(hash: string): Promise<ProjectMeta | undefined> {
    const meta = await readJson<ProjectMeta | null>(join(this.projectDir(hash), 'meta.json'), null)
    return meta ?? undefined
  }

  async writeProjectMeta(hash: string, meta: ProjectMeta): Promise<void> {
    await atomicWriteJson(join(this.projectDir(hash), 'meta.json'), meta)
  }

  /**
   * 删掉某项目的档案目录（projects/<hash>/，实际只有 meta.json）。
   *
   * 只删档案，**不动条目**：条目住在 store/entries.json 里，由调用方决定要不要
   * 一起软废弃（见 /prune-project）。目录不存在时按成功返回——清理一个幽灵
   * 项目点两次，第二次不该报错。
   */
  async removeProjectDir(hash: string): Promise<boolean> {
    try {
      await rm(this.projectDir(hash), { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  /** 该工作区是否开启自动记忆（默认 true；meta 缺失或字段未写视为开启）。 */
  async isAutoMemoryEnabled(hash: string): Promise<boolean> {
    const meta = await this.readProjectMeta(hash)
    return meta?.autoMemory !== false
  }

  /**
   * 该工作区是否被排除出记忆注入（默认 false；meta 缺失或字段未写视为不排除）。
   * 注入引擎在 pre-step 时用它跳过被排除项目的会话——自动提取、手动记忆、
   * 检索与面板展示均不受影响。
   */
  async isInjectExcluded(hash: string): Promise<boolean> {
    const meta = await this.readProjectMeta(hash)
    return meta?.injectExcluded === true
  }

  /**
   * projects/ 下的全部目录名（hash），含 meta.json 缺失的裸目录。
   * 编译时用它找出「条目已被删光、md 产物却还留着旧内容」的项目。
   */
  async listProjectHashes(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, 'projects'), { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      return []
    }
  }

  /**
   * 列出全部项目（含 meta 与统计）。
   *
   * entryCount / pinnedCount 只数活跃条目：已软废弃（回收站里的）不计。
   * 早先这里把 deprecated 一并算进去，导致「全部记忆 5」与「某项目 8」
   * 自相矛盾——删掉的记忆在项目计数里阴魂不散。
   *
   * pathMissing（2026-10-23）：meta.path 指向的文件夹还在不在。档案是按 cwd
   * 派生 hash 存的**永不清除的路由记录**，文件夹删掉之后它照样留在盘上，于是
   * 面板会列出一个不存在的工作区。这里只如实标出来，不替调用方做隐藏决定——
   * 隐藏会让「盘没挂载」和「目录真被删了」两种情况看起来一样。
   */
  async listProjects(entries: MemoryEntry[]): Promise<Array<ProjectMeta & { hash: string; entryCount: number; pinnedCount: number; autoMemory: boolean; injectExcluded: boolean; pathMissing: boolean }>> {
    const dir = join(this.root, 'projects')
    let hashes: string[]
    try {
      hashes = (await readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      hashes = []
    }
    const projects: Array<ProjectMeta & { hash: string; entryCount: number; pinnedCount: number; autoMemory: boolean; injectExcluded: boolean; pathMissing: boolean }> = []
    for (const hash of hashes) {
      const meta = await this.readProjectMeta(hash)
      if (meta === undefined) continue
      const owned = entries.filter(entry =>
        entry.scope === 'project' && entry.projectHash === hash && entry.deprecated !== true)
      projects.push({
        hash,
        path: meta.path,
        alias: meta.alias,
        locked: meta.locked,
        autoMemory: meta.autoMemory !== false,
        injectExcluded: meta.injectExcluded === true,
        entryCount: owned.length,
        pinnedCount: owned.filter(entry => entry.pinned).length,
        pathMissing: !isWorkspacePathAlive(meta.path),
      })
    }
    projects.sort((a, b) => a.path.localeCompare(b.path))
    return projects
  }

  /**
   * 读取 DSH 工作区注册表（${DSH_HOME}/storages/workspace.json），容错返回空。
   * 用于让「尚无记忆的新工作区」也出现在面板项目列表（entryCount 0）。
   */
  async listDshWorkspaces(): Promise<Array<{ path: string; title: string }>> {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const file = join(dshHome, 'storages', 'workspace.json')
    const raw = await readJson<{ tables?: { workspaces?: Record<string, { path?: string; title?: string }> } }>(file, {})
    const table = raw?.tables?.workspaces
    if (typeof table !== 'object' || table === null) return []
    const out: Array<{ path: string; title: string }> = []
    for (const record of Object.values(table)) {
      if (typeof record === 'object' && record !== null && typeof record.path === 'string' && record.path !== '') {
        out.push({ path: record.path, title: typeof record.title === 'string' && record.title !== '' ? record.title : record.path })
      }
    }
    return out
  }

  // ── 修订版本（consolidate 回滚锚点） ────────────────────────────────

  revisionsDir(): string {
    return join(this.root, 'revisions')
  }

  /**
   * 写入一个修订快照（整理前调用），返回修订 id。
   *
   * 快照仍是**全量** entries，但 meta.scope 记下这次整理动的是哪个范围
   * （global / project:<hash> / all）——回滚时据此只覆盖该范围，见 restoreRevision。
   * 不做「只存本 scope 条目」的瘦身：条目会跨 scope 迁移（面板「移项目」），
   * 只存本 scope 的话回滚时找不到那些被移走/移入的条目，反而要猜。
   */
  async writeRevision(input: { entries: MemoryEntry[]; scope: string; trigger: 'daily' | 'manual' }): Promise<string> {
    const id = `rev_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const meta: RevisionMeta = {
      id,
      at: nowIso(),
      entryCount: input.entries.length,
      scope: input.scope,
      trigger: input.trigger,
    }
    await atomicWriteJson(join(this.revisionsDir(), `${id}.json`), { version: 1, meta, entries: input.entries })
    await this.pruneRevisions(REVISION_KEEP)
    return id
  }

  /** 列出修订版本（新 → 旧）。 */
  async listRevisions(): Promise<RevisionMeta[]> {
    const dir = this.revisionsDir()
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const metas: RevisionMeta[] = []
    for (const file of files) {
      if (!/^rev_[0-9a-z]+_[0-9a-z]+\.json$/.test(file)) continue
      const data = await readJson<{ meta?: RevisionMeta }>(join(dir, file), {})
      if (data.meta !== undefined && typeof data.meta.id === 'string') metas.push(data.meta)
    }
    return metas.sort((a, b) => b.at.localeCompare(a.at))
  }

  /** 读修订快照的全部条目；不存在返回 null。 */
  async readRevisionEntries(id: string): Promise<MemoryEntry[] | null> {
    const data = await readJson<{ entries?: MemoryEntry[] } | null>(join(this.revisionsDir(), `${id}.json`), null)
    if (data === null || !Array.isArray(data.entries)) return null
    return data.entries
  }

  /** 读修订快照的元数据（回滚要据此判断范围）；不存在返回 null。 */
  async readRevisionMeta(id: string): Promise<RevisionMeta | null> {
    const data = await readJson<{ meta?: RevisionMeta } | null>(join(this.revisionsDir(), `${id}.json`), null)
    const meta = data?.meta
    if (meta === undefined || meta === null || typeof meta.id !== 'string') return null
    return meta
  }

  /**
   * 回滚到某修订。返回是否成功。
   *
   * 按快照 meta.scope 只替换该范围内的条目，其余 scope 原样保留：
   * 整理是逐 scope 跑的（consolidateScope 一次只动 global 或某个 project），
   * 而快照存的是全量。整库替换等于把「整理 A 项目之后、B 项目里新记下的记忆」
   * 一起抹掉——用户回滚一次整理，丢掉的是完全无关的另一个项目的记忆。
   * scope === 'all' 才是真的整库整理，此时保留原有的整库回滚语义。
   */
  async restoreRevision(id: string): Promise<boolean> {
    const entries = await this.readRevisionEntries(id)
    if (entries === null) return false
    const meta = await this.readRevisionMeta(id)
    // 老快照（本改动之前写入）没有 scope 语义保证时按整库回滚，保持旧行为。
    const scope = meta?.scope ?? 'all'
    if (scope === 'all') {
      await this.replaceEntries(() => entries)
      return true
    }
    const matcher = scopeMatcher(scope)
    if (matcher === null) {
      // 认不出的 scope 标签：退回整库回滚，宁可多覆盖也不要「回滚了却没变化」。
      await this.replaceEntries(() => entries)
      return true
    }
    // 收窄后另存一个非空局部量：下面要在两个箭头函数闭包里用它，
    // 不依赖「TS 是否保留闭包内 const 窄化」这条细则。
    const belongs: (entry: MemoryEntry) => boolean = matcher
    const scoped = entries.filter(belongs)
    // 保留侧再按 id 剔一遍：id 含 scope+projectHash，正常情况两侧不会撞，但快照是
    // 磁盘文件（可能被旧版本或手工改出重复 id）。一旦撞上，数组里同一个 id 出现
    // 两次，后续按 id 查找永远命中先出现的那个旧版本——表现为「改了没反应」。
    const scopedIds = new Set(scoped.map(entry => entry.id))
    await this.replaceEntries(current => [
      // 先保留当前库中不属于该 scope 的条目（含回滚之后新增的），
      // 再用快照里属于该 scope 的条目覆盖该范围。
      ...current.filter(entry => !belongs(entry) && !scopedIds.has(entry.id)),
      ...scoped,
    ])
    return true
  }

  /** 滚动清理：只保留最近 keep 个修订。 */
  async pruneRevisions(keep: number): Promise<void> {
    const metas = await this.listRevisions()
    if (metas.length <= keep) return
    for (const meta of metas.slice(keep)) {
      try {
        await unlink(join(this.revisionsDir(), `${meta.id}.json`))
      } catch {
        // 已不存在则忽略。
      }
    }
  }

  // ── md 产物（compile.ts 调用） ─────────────────────────────────────

  /** 写任意 md 产物（原子）。 */
  async writeArtifact(path: string, content: string): Promise<void> {
    await atomicWriteText(join(this.root, path), content)
  }

  /** 写项目层产物。 */
  async writeProjectArtifacts(hash: string, artifacts: { memory?: string; facts?: string; pinned?: string }): Promise<void> {
    const dir = this.projectDir(hash)
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(artifacts)) {
      if (content === undefined) continue
      await atomicWriteText(join(dir, `${name}.md`), content)
    }
  }

  /** 写全局层产物。 */
  async writeGlobalArtifacts(artifacts: { identity?: string; facts?: string; pinned?: string }): Promise<void> {
    const dir = this.globalDir()
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(artifacts)) {
      if (content === undefined) continue
      await atomicWriteText(join(dir, `${name}.md`), content)
    }
  }
}

/**
 * 把修订快照的 scope 标签解析成「这条条目是否属于该范围」的判定函数。
 *
 * 标签格式由 consolidate.ts 的 scopeLabel 产出：global / project:<hash> / all。
 * 认不出（旧版本写入的自由文本、hash 为空）时返回 null，调用方据此退回整库回滚——
 * 与其按猜出来的范围「回滚了却没变化」，不如老实按老行为整库恢复。
 */
function scopeMatcher(scope: string): ((entry: MemoryEntry) => boolean) | null {
  if (scope === 'global') return entry => entry.scope === 'global'
  if (scope.startsWith('project:')) {
    const hash = scope.slice('project:'.length).trim()
    if (hash === '') return null
    return entry => entry.scope === 'project' && entry.projectHash === hash
  }
  return null
}

/** 合并标签（保留旧标签 + 新标签，去重，上限 8）。 */
export function mergeTags(existing: string[], next: string[] | undefined, max = 8): string[] {
  const out: string[] = []
  for (const tag of [...existing, ...(next ?? [])]) {
    const t = String(tag).trim()
    if (t === '') continue
    if (!out.includes(t)) out.push(t)
    if (out.length >= max) break
  }
  return out
}

/** 摘要（截断 80 字）。 */
export function summarize(content: string, max = 80): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

// ── schema v1 → v2 迁移与记忆类型推断 ────────────────────────────────

/**
 * entries.json 的落盘载荷。
 *
 * `revision` 是后加的可选字段（旧文件没有），语义见 `MemoryStore.revision`。
 */
interface EntriesPayload {
  version: 1 | 2
  entries: unknown
  /** 记忆内容版本号；缺失按 0 读。 */
  revision?: unknown
}

/** 加载结果：数据 + 需要人看见的告警（空 = 一切正常）。 */
interface LoadOutcome {
  data: EntriesPayload
  warning: string
}

const EMPTY_STORE: EntriesPayload = { version: 2, entries: [], revision: 0 }

/** 从落盘载荷里取 revision（脏数据 / 旧文件一律按 0）。 */
function revisionOf(data: EntriesPayload): number {
  const value = data.revision
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 加载 entries.json，带三级恢复链。
 *
 *   ① 主文件完好 → 直接用；
 *   ② 主文件坏 → 依次试 .bak 快照（新到旧），用第一份完好的；
 *   ③ 全坏 → 主文件改名成 .corrupt-<ISO> 留证（**不删、不覆盖**），返回空库。
 *
 * 为什么不静默 fallback：原来 readJsonSync 吞掉异常返回空数组，于是「文件坏了」
 * 与「库本来就是空的」在调用方完全无法区分——两者的处置天差地别（前者要告警+
 * 人工介入，后者完全正常）。这里把结论塞进 warning 里带出去，由 index.ts 打日志。
 *
 * 为什么留证而不是删掉坏文件：坏文件里可能还有部分可解析的行，人工能捞。
 * 直接删掉才是真的丢。
 */
function loadEntriesWithRecovery(file: string): LoadOutcome {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    // 读取失败分两种：文件不存在（首次运行，完全正常）与权限/IO 问题（要告警）。
    return { data: EMPTY_STORE, warning: existsSync(file) ? 'entries.json 存在但读取失败，按空库启动' : '' }
  }
  if (isHealthyPayload(raw)) {
    try {
      return { data: JSON.parse(raw) as EntriesPayload, warning: '' }
    } catch {
      // isHealthyPayload 已经 parse 过一遍，这里不该失败；真失败了按坏文件处理。
    }
  }
  // 主文件坏：找最新一份完好快照。
  for (const snapshot of listSnapshots(file)) {
    try {
      const backupRaw = readFileSync(snapshot, 'utf8')
      if (!isHealthyPayload(backupRaw)) continue
      const data = JSON.parse(backupRaw) as EntriesPayload
      // 恢复后立刻把主文件写回好的内容，否则下一次写又会以坏文件为基线做快照。
      try {
        renameSync(file, file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-'))
      } catch { /* 改名失败就让它被覆盖，至少数据是对的 */ }
      try {
        copyFileSync(snapshot, file)
      } catch { /* 复制失败不阻断：内存里已经是对的，下次 flush 会重写 */ }
      const n = Array.isArray((data as { entries?: unknown }).entries) ? (data as { entries: unknown[] }).entries.length : 0
      return {
        data,
        warning: 'entries.json 损坏，已从快照 ' + basename(snapshot) + ' 恢复（' + n + ' 条）；坏文件已改名保留',
      }
    } catch {
      continue
    }
  }
  // 全坏：留证，空库启动。
  const corrupt = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')
  try {
    renameSync(file, corrupt)
  } catch { /* 改名失败也别拦着启动 */ }
  return {
    data: EMPTY_STORE,
    warning: 'entries.json 与全部快照均损坏，已改名保留为 ' + basename(corrupt) + '，本次以空库启动',
  }
}
/** 同步读 JSON（构造时用，容错返回 fallback）。 */
function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** 校验是否为合法 MemoryKind。 */
function isMemoryKind(value: unknown): value is MemoryKind {
  return value === 'identity' || value === 'preference' || value === 'fact'
    || value === 'decision' || value === 'gotcha' || value === 'session-summary'
}

/** 由标签推断记忆类型（v1 无 kind 字段时的迁移兜底）。 */
function inferKind(tags: string[] | undefined): MemoryKind {
  const lower = (tags ?? []).map(tag => String(tag).toLowerCase())
  if (lower.some(tag => tag === '身份' || tag === 'identity')) return 'identity'
  if (lower.some(tag => tag === '偏好' || tag === 'preference' || tag === '风格' || tag === 'style' || tag === '习惯' || tag === 'habit')) return 'preference'
  if (lower.some(tag => tag === '踩坑' || tag === 'gotcha' || tag === '坑')) return 'gotcha'
  if (lower.some(tag => tag === '决策' || tag === 'decision')) return 'decision'
  return 'fact'
}

/**
 * 存量条目迁移（v1 → v2 → … → v6）：白名单式重建 + 补 owner + 重算 id（容错坏行）。
 *
 * 导出供 workbench-sync 还原时归一，保证磁盘/内存态与云端包版本一致：云端包可能是
 * v5（无 owner、旧 id 算法），落盘前不跑一遍这里，`reload()` 后内存态会按新算法
 * 重算出一套与磁盘不同的 id。
 *
 * ## schema v6：owner 与 id 重算
 *
 * v6 起 id 含 owner（`mem_sha1(owner|scope|projectHash|content)`）。所以每次加载都要
 * 把 id 归位——这既是升级迁移，也是幂等校验：算出来一样就不动。
 *
 * 归属判定顺序：落盘字段（合法才认）→ `provenance.sessionId` → `work`。
 * 之所以允许落盘字段优先，是因为「同内容不同归属」在 v6 是合法状态（两个 bot 各记
 * 一条），不能让迁移把它们合并。
 *
 * `supersededBy` 存的是**别的条目的 id**，id 一变软废弃链就会指向不存在的条目，
 * 表现为「被取代的旧记忆在面板里既不在正文也不在回收站」。所以第二遍统一改指。
 */
export function migrateEntries(entries: unknown): MemoryEntry[] {
  if (!Array.isArray(entries)) return []
  const out: MemoryEntry[] = []
  /** 旧 id → 新 id：用于重写 supersededBy。 */
  const idRemap = new Map<string, string>()
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Partial<MemoryEntry>
    if (typeof entry.id !== 'string' || typeof entry.content !== 'string') continue
    const source = entry.source === 'manual' ? 'manual' as const : 'extract' as const
    const scope = entry.scope === 'global' ? 'global' as const : 'project' as const
    const projectHash = scope === 'project' ? (typeof entry.projectHash === 'string' ? entry.projectHash : null) : null
    const owner = isMemoryOwner(entry.owner) ? entry.owner : ownerOfSessionId(entry.provenance?.sessionId)
    const id = entryIdOf(entry.content, scope, projectHash, owner)
    if (id !== entry.id) idRemap.set(entry.id, id)
    out.push({
      id,
      content: entry.content,
      scope,
      projectHash,
      owner,
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      pinned: entry.pinned === true,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : nowIso(),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : nowIso(),
      importance: typeof entry.importance === 'number' ? entry.importance : 10,
      lastHitAt: typeof entry.lastHitAt === 'string' ? entry.lastHitAt : null,
      layer: entry.layer === 'long' ? 'long' : 'short',
      source,
      version: typeof entry.version === 'number' ? entry.version : 1,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : (source === 'manual' ? 1 : 0.6),
      verified: entry.verified === true || source === 'manual',
      kind: isMemoryKind(entry.kind) ? entry.kind : inferKind(entry.tags),
      provenance: entry.provenance,
      embedding: Array.isArray(entry.embedding) ? entry.embedding : undefined,
      // 整理轮转时间戳：白名单式重建，这里漏带一次，老数据每次读盘都会丢该字段，
      // 表现为「整理永远从最早那批开始」的饥饿修不掉。未整理过时留 undefined，
      // JSON.stringify 会忽略它，正好等于「没整理过」的语义。
      lastConsolidatedAt: typeof entry.lastConsolidatedAt === 'string' ? entry.lastConsolidatedAt : undefined,
      // schema v7：临时信息有效期（仅正数保留；undefined=永久，落盘不冗余）。
      // 与 lastConsolidatedAt 同一个坑：白名单重建漏带一次，ttlDays 会在下次
      // 重启时静默消失，过期的「今天要发 36 条」又会被当成永久事实注入。
      ...(typeof entry.ttlDays === 'number' && Number.isFinite(entry.ttlDays) && entry.ttlDays > 0
        ? { ttlDays: entry.ttlDays }
        : {}),
      // disabled 是可选字段：仅 true 时保留（undefined=启用，落盘不冗余）。
      ...(entry.disabled === true ? { disabled: true } : {}),
      // schema v5：待确认字段（仅 pending=true 时保留，undefined=已生效）。
      // 与 disabled 同一口径：缺省的「已生效」不写进 JSON，避免全库条目多两个字段。
      ...(entry.pending === true
        ? {
            pending: true as const,
            pendingAt: typeof entry.pendingAt === 'string' ? entry.pendingAt : nowIso(),
          }
        : {}),
      // schema v3：软废弃字段（仅真实废弃时保留）。
      ...(entry.deprecated === true
        ? {
            deprecated: true as const,
            deprecatedAt: typeof entry.deprecatedAt === 'string' ? entry.deprecatedAt : nowIso(),
            ...(typeof entry.deprecatedReason === 'string' && entry.deprecatedReason !== ''
              ? { deprecatedReason: entry.deprecatedReason }
              : {}),
            ...(typeof entry.supersededBy === 'string' ? { supersededBy: entry.supersededBy } : {}),
          }
        : {}),
    })
  }
  /*
   * 第二遍：软废弃链改指新 id。
   * 只有真的发生过 id 变化时才需要；没有变化时整段是零开销的空转。
   */
  if (idRemap.size > 0) {
    for (const entry of out) {
      if (typeof entry.supersededBy !== 'string') continue
      const mapped = idRemap.get(entry.supersededBy)
      if (mapped !== undefined) entry.supersededBy = mapped
    }
  }
  return out
}
