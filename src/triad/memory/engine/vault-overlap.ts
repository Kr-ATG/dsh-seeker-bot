/**
 * 记忆 × 档案（vault）去重：注入前把「档案已经覆盖」的记忆条目剔掉。
 *
 * ## 为什么需要
 *
 * 两套注入各自独立（`vault/inject.ts` 与 `memory/inject.ts` 都注册 agent/pre-step），
 * 于是同一件事会在上下文里出现两遍：档案里有「GitHub · Kr-ATG：用户名 Kr-ATG」，
 * 记忆库里还躺着一条「用户的 GitHub 账号是 Kr-ATG」。重复本身不致命，但两条
 * 内容一旦分叉（档案改过、记忆没改），模型会拿到两个互相矛盾的值，而它无从
 * 判断哪条新——这正是 0.4「记忆不是实时数据」想避免的坑。档案是用户手维护的
 * 结构化数据，冲突时该信档案，所以这里直接让记忆让位。
 *
 * ## 口径（按内容前缀匹配，宁可漏剔不可误剔）
 *
 * 只认两种强信号：
 *  ① 记忆内容里出现某条档案的**完整标题 / 副标题**（≥4 字符）——「VPS · 172.245.214.98」
 *     这种标题本身就是唯一的，命中即同一条记录；
 *  ② 记忆**开头**（前 24 字符）出现「字段名 + ：/是/为」——「GitHub 密码是 …」这种写法。
 *
 * 不做「包含任意字段名就剔」：字段名「密码」「电话」只有两三个字，几乎每段关于
 * 账户的记忆里都会出现，按它剔会把整类记忆清空。
 *
 * ## 为什么读 vault 的存储而不是等它的注入文本
 *
 * pre-step 链上 vault 跑在记忆**之前**（它用 prepend 且注册更晚，见 triad/host.ts），
 * 所以记忆侧拿到的 `decision.messages` 里没有本轮 vault 注入；而记忆主注入发生在
 * 会话首步，那时历史里也还没有 vault 的首轮注入——等它出现，要判定的那一轮已经过了。
 * 所以这里直接读 vault 的存储（走 VaultStore 的只读探针，复用它的解析与容错），
 * 只取标题与字段名，**不碰任何敏感值**（cipher 传 null，解不出来也不需要解）。
 *
 * ## 边界
 *
 * 档案注入被关掉（`autoInject: false`）时**不做去重**：那时档案根本不出现在上下文，
 * 再剔记忆等于把这类事实从模型眼前彻底抹掉。读取失败（没有 vault.json / 文件损坏 /
 * schema 更新只读）同样原样放行——去重是优化，不能因为它让记忆注入失败。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { VaultStore, vaultHome } from '../../vault/store.js'

/**
 * 覆盖信息缓存时长。
 *
 * pre-step 每个 step 都会调，而档案变化是「用户手动改」级别的低频事件；
 * 30 秒的陈旧窗口对去重完全够用（最坏情况：刚改完档案，这半分钟里记忆里那条
 * 还会多出现一次，下个 step 就没了）。
 */
const CACHE_TTL_MS = 30_000

/** 前缀窗口：只在这一段里找「字段名 + 连接符」。 */
const PREFIX_WINDOW = 24

/** 字段名后面紧跟这些才算「在陈述该字段的值」。 */
const FIELD_CONNECTORS = ['：', ':', '是', '为', '=', '＝']

/** 档案覆盖标识（只含非敏感的名字，不含任何字段值）。 */
export interface VaultCoverage {
  /** 档案会出现在上下文里（autoInject 未关闭且库非空）。 */
  active: boolean
  /** 记录标题 / 副标题（≥4 字符）。 */
  titles: string[]
  /** 字段显示名（≥2 字符）。 */
  fieldLabels: string[]
}

const EMPTY_COVERAGE: VaultCoverage = { active: false, titles: [], fieldLabels: [] }

let cached: { at: number; coverage: VaultCoverage } | null = null
let probe: VaultStore | null = null

/**
 * 读档案覆盖标识（带 30 秒缓存）。
 *
 * 每次读都重新建实例是浪费的：VaultStore 构造虽轻，但 listRecords 会读整份
 * vault.json 并跑一遍迁移。缓存一个探针实例即可——它是只读的，与运行中的
 * vault 实例共享同一份磁盘文件，互不影响（vault 有 debounce 写，盘上可能旧
 * 几百毫秒，去重不需要更精确）。
 */
async function loadCoverage(): Promise<VaultCoverage> {
  const now = Date.now()
  if (cached !== null && now - cached.at < CACHE_TTL_MS) return cached.coverage
  let coverage = EMPTY_COVERAGE
  try {
    /*
     * 没有档案库就直接返回：`new VaultStore(null)` 首次运行时会在 loadNow 里
     * **写一份空库**（vault.json + 内置场景），而记忆侧这个探针是只读的——
     * 不该因为用户从没用过档案，就在他的 DSH_HOME 里凭空造一个 vault 目录。
     */
    if (!existsSync(join(vaultHome(), 'vault.json'))) {
      cached = { at: now, coverage }
      return coverage
    }
    probe ??= new VaultStore(null)
    const override = await probe.readConfigOverride()
    // 明确关掉档案注入时不剔：档案不进上下文，记忆再剔就等于这类事实彻底消失。
    if (override.autoInject !== false) {
      const records = await probe.listRecords()
      const titles: string[] = []
      const fieldLabels: string[] = []
      for (const record of records) {
        // 归档记录不注入（vault/inject.ts 的 active 口径），也不该拿来做去重——
        // 否则「档案里已归档的旧记录」会把仍然有效的记忆剔掉。
        if (record.archived === true) continue
        const title = record.title.trim()
        if (title.length >= 4) titles.push(title)
        const subtitle = typeof record.subtitle === 'string' ? record.subtitle.trim() : ''
        if (subtitle.length >= 4) titles.push(subtitle)
        for (const field of record.fields) {
          const label = field.label.trim()
          if (label.length >= 2) fieldLabels.push(label)
        }
      }
      coverage = { active: titles.length > 0 || fieldLabels.length > 0, titles, fieldLabels }
    }
  } catch {
    // 读不出来（首次运行没有 vault.json / 文件损坏 / 未来 schema 只读）：
    // 不做去重，记忆原样注入。去重是优化，不能让它成为注入失败点。
    coverage = EMPTY_COVERAGE
  }
  cached = { at: now, coverage }
  return coverage
}

/**
 * 这条记忆是否已被档案覆盖。
 *
 * 纯函数，便于单测；coverage 由 loadCoverage 提供。
 */
export function isCoveredByVault(content: string, coverage: VaultCoverage): boolean {
  if (!coverage.active) return false
  const text = content.trim()
  if (text === '') return false
  // ① 完整标题命中：标题本身就是唯一标识，不需要再看位置。
  for (const title of coverage.titles) {
    if (text.includes(title)) return true
  }
  // ② 开头窗口里的「字段名 + 连接符」：只在开头找，避免把正文里顺带提到的
  //    字段名（「密码别写进日志」这类规则）也当成档案事实剔掉。
  const head = text.slice(0, PREFIX_WINDOW)
  for (const label of coverage.fieldLabels) {
    const at = head.indexOf(label)
    if (at === -1) continue
    const rest = head.slice(at + label.length).trimStart()
    if (rest === '' || FIELD_CONNECTORS.some(connector => rest.startsWith(connector))) return true
  }
  return false
}

/**
 * 过滤掉已被档案覆盖的条目。
 *
 * 读不到档案覆盖信息时**原样返回**（见模块头「边界」）。
 */
export async function filterCoveredByVault<T extends { content: string }>(entries: T[]): Promise<T[]> {
  if (entries.length === 0) return entries
  const coverage = await loadCoverage()
  if (!coverage.active) return entries
  return entries.filter(entry => !isCoveredByVault(entry.content, coverage))
}

/** 清空缓存（测试用；也供将来的「档案变更后立即重算」入口调用）。 */
export function resetVaultCoverageCache(): void {
  cached = null
}
