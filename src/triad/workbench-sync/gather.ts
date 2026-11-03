/**
 * 工作台本地资产收集与还原（档案、记忆、技能、MCP 配置）。
 *
 * 不碰系统提示词与全局设定。所有写盘走原子写与目录递归保护。
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { getWebuiMemoryStore } from '../memory-store-singleton.js'
import { gatherMcpEntries, mcpPatchSummary, restoreMcpEntries, type GatheredMcp } from './mcp-patch.js'
import {
  gatherProviderAssets,
  liveVendorSummary,
  providerPatchSummary,
  restoreProviderAssets,
  type GatheredProviders,
} from './provider-patch.js'
import { migrateEntries, memoryHome } from '../memory/engine/store.js'
import type { MemoryEntry } from '../memory/types.js'
import { detectMediaType } from '../vault/blobs.js'
import { VaultCipher } from '../vault/crypto.js'
import { VaultStore, vaultHome } from '../vault/store.js'

function dshHome(): string {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh')
}

export function skillsHome(): string {
  return join(dshHome(), 'skills')
}

export interface GatheredVault {
  key?: string
  vaultJson?: string
  blobs?: Array<{ sha256: string; base64: string }>
}

export interface GatheredMemory {
  entriesJson?: string
  stateJson?: string
  projects?: Record<string, string> // projectHash -> meta.json text
  /**
   * 包内自描述的归属分布（schema v6）。
   *
   * 为什么要把「谁的记忆」写进包里：`entries.json` 里的 `owner` 是 `work` /
   * `bot:<id>`，而 Bot 名册住在浏览器 localStorage（不在宿主侧），换机后子 Bot
   * 的 id 与云端并不相同。恢复端拿到这份分布就能在进度与提示里说清「这包里有
   * N 条属于别的 Bot 的记忆」，而不是让它们静默地消失在某次归属过滤里。
   */
  ownerStats?: { work: number; bots: Record<string, number> }
}

export interface GatheredSkills {
  files: Record<string, string> // relativePath -> base64
}

export interface GatheredWorkbenchPayload {
  format: 'dsh-workbench-sync'
  /**
   * 包格式版本。
   *
   * v1：档案 / 记忆 / 技能 / MCP / 供应商（`llm-*`、凭据、能力、代理、密钥环）。
   * v2：记忆带 `ownerStats`（schema v6 归属），供应商带 `liveVendors`（实时语音
   *     Live 供应商，`realtime-config.json`）。
   *
   * 读取端必须容忍缺字段——v1 的包照样能恢复，只是少了这两段。
   */
  version: 1 | 2
  createdAt: string
  vault?: GatheredVault
  memory?: GatheredMemory
  skills?: GatheredSkills
  mcp?: GatheredMcp
  providers?: GatheredProviders
}

/**
 * 统计一批条目的归属分布。
 *
 * `bots` 的 key 用**裸 botId**（去掉 `bot:` 前缀，如 `bot-main-xiaomo`）：它与前端
 * `bot.id` 一致，UI 与日志里能直接对上；归属前缀在 `owner` 字段本身已经表达过了。
 *
 * 调用方负责先按需过滤软废弃条目。归属统计（`ownerStats` / `restoreMemory` 的
 * `work` / `bots` / 本机规模视图）统一只数**活跃条目**：软废弃的记忆已经不在注入
 * 与检索里，把它算进去会让「恢复完成：带回来 2 条 Bot 记忆」和面板上的 1 条对不上。
 * 只有 `restoreMemory().entries` 是落盘总条数（含软废弃），因为它回答的是「文件里
 * 一共写了几条」。
 */
function countOwners(entries: readonly MemoryEntry[]): { work: number; bots: Record<string, number> } {
  let work = 0
  const bots: Record<string, number> = {}
  for (const entry of entries) {
    const owner = entry.owner ?? 'work'
    if (owner.startsWith('bot:')) {
      const botId = owner.slice('bot:'.length)
      bots[botId] = (bots[botId] ?? 0) + 1
    } else {
      work += 1
    }
  }
  return { work, bots }
}

/** 只保留活跃条目（软废弃的 `deprecated === true` 不参与归属统计）。 */
function activeOnly(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return entries.filter(entry => entry.deprecated !== true)
}

/** 归属分布里 Bot 条目的总数（`countOwners` 的 `bots` 求和）。 */
function totalBotEntries(bots: Record<string, number>): number {
  let total = 0
  for (const count of Object.values(bots)) total += count
  return total
}

/** 递归统计目录大小（支持忽略以 . 开头的隐藏目录/回收站）。 */
export async function getDirSize(dirPath: string, ignoreHidden = false): Promise<number> {
  if (!existsSync(dirPath)) return 0
  let total = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (ignoreHidden && entry.name.startsWith('.')) continue
      const full = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += await getDirSize(full, ignoreHidden)
      } else if (entry.isFile()) {
        const s = await stat(full)
        total += s.size
      }
    }
  } catch {
    // 忽略部分临时文件或无权限读取
  }
  return total
}

/** 精准统计纯净核心业务资产体积（排除同步运行历史账本、审计追加日志与回收站，保持数据无变动时体积绝对恒定）。 */
export async function getWorkbenchSizes(): Promise<{
  vaultBytes: number
  memoryBytes: number
  skillsBytes: number
  mcpBytes: number
  mcpEntries: number
  providersBytes: number
  providersCount: number
  /** `web` 条目里当前选的搜索后端（如 `anysearch-auto`），空串表示未配置。 */
  webSearchProvider: string
  /** 记忆条目总数（schema v6：含 Work 与各 Bot 归属）。 */
  memoryEntries: number
  /** `owner = work` 的条目数。 */
  memoryWorkEntries: number
  /** `owner = bot:<id>` 的条目数。 */
  memoryBotEntries: number
  /** 出现过的不同 Bot 归属个数。 */
  memoryBots: number
  /** Live（实时语音）供应商数量。 */
  liveVendors: number
  /** 默认 Live 供应商 id（空串 = 未设置）。 */
  liveDefaultVendor: string
  totalBytes: number
}> {
  // 1. 档案：vault.json + key + blobs/（排除 store/workbench-sync.json 运行历史与 audit.jsonl 审计日志）
  let vaultBytes = 0
  const vRoot = vaultHome()
  if (existsSync(join(vRoot, 'vault.json'))) {
    vaultBytes += (await stat(join(vRoot, 'vault.json')).catch(() => ({ size: 0 }))).size
  }
  if (existsSync(join(vRoot, 'key'))) {
    vaultBytes += (await stat(join(vRoot, 'key')).catch(() => ({ size: 0 }))).size
  }
  const blobsDir = join(vRoot, 'blobs')
  if (existsSync(blobsDir)) {
    vaultBytes += await getDirSize(blobsDir, true)
  }

  // 2. 记忆：entries.json + state.json + projects/（排除日常运行追加的 changes/*.jsonl）
  let memoryBytes = 0
  const mRoot = memoryHome()
  const entriesFile = join(mRoot, 'store', 'entries.json')
  const stateFile = join(mRoot, 'store', 'state.json')
  if (existsSync(entriesFile)) {
    memoryBytes += (await stat(entriesFile).catch(() => ({ size: 0 }))).size
  }
  if (existsSync(stateFile)) {
    memoryBytes += (await stat(stateFile).catch(() => ({ size: 0 }))).size
  }
  const projectsDir = join(mRoot, 'projects')
  if (existsSync(projectsDir)) {
    memoryBytes += await getDirSize(projectsDir, true)
  }

  /*
   * 记忆归属分布（schema v6）。
   *
   * 走 `migrateEntries()` 而不是直接读 `owner` 字段：v5 存量条目没有 owner，归属
   * 只能从 `provenance.sessionId` 推导，绕过归一的话所有老条目都会被算成 work。
   * 软废弃条目（`deprecated === true`）不参与统计——这个视图回答的是「还有效的
   * 记忆有多少条」，回收站里的不该撑数字。
   */
  let memoryEntries = 0
  let memoryWorkEntries = 0
  let memoryBotEntries = 0
  let memoryBots = 0
  if (existsSync(entriesFile)) {
    try {
      const parsed = JSON.parse(await readFile(entriesFile, 'utf8')) as { entries?: unknown }
      const active = activeOnly(migrateEntries(parsed.entries))
      const stats = countOwners(active)
      memoryEntries = active.length
      memoryWorkEntries = stats.work
      memoryBotEntries = totalBotEntries(stats.bots)
      memoryBots = Object.keys(stats.bots).length
    } catch {
      // 读不出来就保持零值：状态视图不该因为一份坏文件整块报错。
    }
  }

  // 3. 技能：skills/ 目录下的自定义技能（排除 .trash 回收站）
  let skillsBytes = 0
  const sRoot = skillsHome()
  if (existsSync(sRoot)) {
    skillsBytes += await getDirSize(sRoot, true)
  }

  // 4. MCP：cordis.patch.yml 里的 mcp-client 条目（不是独立目录，按块字节算）
  const mcp = mcpPatchSummary()

  // 5. 供应商与模型：cordis.patch.yml 里的 llm-* 条目 + .credentials.yaml + 代理/能力
  const providers = providerPatchSummary()

  // 6. Live（实时语音）供应商：realtime-config.json（由 provider-patch 侧读，这里只要规模与默认项）
  const live = liveVendorSummary()

  return {
    vaultBytes,
    memoryBytes,
    skillsBytes,
    mcpBytes: mcp.bytes,
    mcpEntries: mcp.count,
    providersBytes: providers.bytes,
    providersCount: providers.count,
    webSearchProvider: providers.webSearchProvider,
    memoryEntries,
    memoryWorkEntries,
    memoryBotEntries,
    memoryBots,
    liveVendors: live.vendors,
    liveDefaultVendor: live.defaultVendor,
    // 体积口径保持不变：Live 配置的字节数已经算不进任何一项，这里也不重复累加。
    totalBytes: vaultBytes + memoryBytes + skillsBytes + mcp.bytes + providers.bytes,
  }
}

/** 收集本地档案数据。 */
async function gatherVault(store: VaultStore): Promise<GatheredVault> {
  const root = store.root
  const keyFile = store.keyFile
  let key: string | undefined
  if (existsSync(keyFile)) {
    try {
      const keyBuf = await readFile(keyFile)
      key = keyBuf.toString('base64')
    } catch {}
  }
  const vaultJsonFile = join(root, 'vault.json')
  let vaultJson: string | undefined
  if (existsSync(vaultJsonFile)) {
    try {
      vaultJson = await readFile(vaultJsonFile, 'utf8')
    } catch {}
  }

  // 收集图片 blobs
  const blobs: Array<{ sha256: string; base64: string }> = []
  try {
    const snapshot = await store.blobs.snapshot()
    for (const item of snapshot) {
      // BlobStore 的读接口叫 get（不是 read）。之前写成 read → TypeError 被
      // 外层 catch 吞掉，结果「档案云同步」只带记录文本、不带任何图片与文件。
      const buf = await store.blobs.get(item.sha256)
      if (buf !== null && buf.length > 0) {
        blobs.push({ sha256: item.sha256, base64: buf.toString('base64') })
      }
    }
  } catch {}

  return { key, vaultJson, blobs }
}

/** 收集本地记忆数据。 */
async function gatherMemory(): Promise<GatheredMemory> {
  const root = memoryHome()
  const entriesFile = join(root, 'store', 'entries.json')
  const stateFile = join(root, 'store', 'state.json')
  let entriesJson: string | undefined
  let stateJson: string | undefined
  if (existsSync(entriesFile)) {
    try { entriesJson = await readFile(entriesFile, 'utf8') } catch {}
  }
  if (existsSync(stateFile)) {
    try { stateJson = await readFile(stateFile, 'utf8') } catch {}
  }

  const projects: Record<string, string> = {}
  const projectsDir = join(root, 'projects')
  if (existsSync(projectsDir)) {
    try {
      const hashes = await readdir(projectsDir)
      for (const hash of hashes) {
        const metaFile = join(projectsDir, hash, 'meta.json')
        if (existsSync(metaFile)) {
          projects[hash] = await readFile(metaFile, 'utf8')
        }
      }
    } catch {}
  }

  /*
   * 包内归属分布（schema v6）。
   *
   * 走 `migrateEntries()` 而不是直接读 `owner` 字段：v5 及更早的包没有 owner，
   * 归属只能从 `provenance.sessionId` 推导；不归一的话统计出来的永远是 work，
   * 恢复端也就无从知道「这包里其实带着 Bot 记忆」。
   *
   * 软废弃条目不进统计（与 `restoreMemory()` 的返回、本机规模视图同一口径），
   * 解析失败时整段省略——ownerStats 只是提示信息，不值得让它把整个上传流程搞失败。
   */
  let ownerStats: GatheredMemory['ownerStats']
  if (entriesJson !== undefined) {
    try {
      const parsed = JSON.parse(entriesJson) as { entries?: unknown }
      ownerStats = countOwners(activeOnly(migrateEntries(parsed.entries)))
    } catch {}
  }

  return { entriesJson, stateJson, projects, ...(ownerStats !== undefined ? { ownerStats } : {}) }
}

/** 递归收集目录下的所有文件（自动排除以 . 开头的隐藏目录/回收站/系统隐藏文件）。 */
async function collectFilesRecursively(dir: string, baseDir: string, out: Record<string, string>): Promise<void> {
  if (!existsSync(dir)) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    // 排除以 . 开头的隐藏目录（如 .trash, .git 等）与隐藏文件
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFilesRecursively(full, baseDir, out)
    } else if (entry.isFile()) {
      try {
        const rel = relative(baseDir, full).replace(/\\/g, '/')
        const buf = await readFile(full)
        out[rel] = buf.toString('base64')
      } catch {}
    }
  }
}

/** 收集自定义技能文件。 */
async function gatherSkills(): Promise<GatheredSkills> {
  const root = skillsHome()
  const files: Record<string, string> = {}
  if (existsSync(root)) {
    await collectFilesRecursively(root, root, files)
  }
  return { files }
}

/** 整体收集工作台本地资产。 */
export async function gatherWorkbenchAssets(options: {
  includeVault: boolean
  includeMemory: boolean
  includeSkills: boolean
  /** 未显式传入时按「不收」处理（老调用方与测试的兼容口径）。 */
  includeMcp?: boolean
  includeProviders?: boolean
  vaultStore: VaultStore
}): Promise<GatheredWorkbenchPayload> {
  const [vault, memory, skills] = await Promise.all([
    options.includeVault ? gatherVault(options.vaultStore) : undefined,
    options.includeMemory ? gatherMemory() : undefined,
    options.includeSkills ? gatherSkills() : undefined,
  ])
  const mcp = options.includeMcp === true ? gatherMcpEntries() : undefined
  const providers = options.includeProviders === true ? gatherProviderAssets() : undefined

  return {
    format: 'dsh-workbench-sync',
    version: 2,
    createdAt: new Date().toISOString(),
    ...(vault ? { vault } : {}),
    ...(memory ? { memory } : {}),
    ...(skills ? { skills } : {}),
    ...(mcp ? { mcp } : {}),
    ...(providers ? { providers } : {}),
  }
}

/** 还原 MCP 配置（只更新同名 / 新增缺失，不删本机独有条目）。 */
export async function restoreMcp(mcp: GatheredMcp): Promise<{ added: number; updated: number; kept: number }> {
  return restoreMcpEntries(mcp)
}

/** 还原供应商与模型配置（同名更新/缺失新增，保留本机独有配置与密钥）。 */
export async function restoreProviders(providers: GatheredProviders): Promise<{
  patchResult: { added: number; updated: number; kept: number }
  credentialsResult: { added: number; updated: number; kept: number }
  /** Live（实时语音）供应商的合并结果（包格式 v1 无此段时为全零）。 */
  liveResult: { added: number; updated: number; kept: number }
}> {
  return restoreProviderAssets(providers)
}

/** 原子写文本。 */
async function atomicWriteFile(filePath: string, content: Buffer | string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp-' + String(Date.now())
  await writeFile(tmp, content)
  await rename(tmp, filePath).catch(async () => {
    // Windows rename 目标已存在时抛 EPERM，先 unlink
    await unlink(filePath).catch(() => undefined)
    await rename(tmp, filePath)
  })
}

/** 还原档案数据。 */
export async function restoreVault(vault: GatheredVault, store: VaultStore): Promise<{ records: number }> {
  let recordsCount = 0
  if (vault.key) {
    const keyBuf = Buffer.from(vault.key, 'base64')
    const cipher = VaultCipher.fromKey(keyBuf)
    await store.replaceCipher(cipher)
  }
  if (vault.vaultJson) {
    try {
      const parsed = JSON.parse(vault.vaultJson) as { records?: unknown[]; scenes?: unknown[] }
      if (Array.isArray(parsed.records)) {
        const vaultJsonFile = join(store.root, 'vault.json')
        if (existsSync(vaultJsonFile)) {
          await atomicWriteFile(vaultJsonFile + '.bak-before-sync', await readFile(vaultJsonFile)).catch(() => undefined)
        }
        recordsCount = parsed.records.length
        await store.replaceAll({
          records: parsed.records as never,
          ...(Array.isArray(parsed.scenes) ? { scenes: parsed.scenes as never } : {}),
        })
      }
    } catch {}
  }
  if (Array.isArray(vault.blobs)) {
    for (const b of vault.blobs) {
      try {
        const buf = Buffer.from(b.base64, 'base64')
        // putRaw 不校验图片魔数：配置文件 / 订阅这类文本字节也能随同步还原。
        // 图片的 display / thumb 引用仍然按 sha 对得上（索引里记 MIME，页面用
        // /image 按魔数再判一次，不依赖这里的声明）。
        await store.blobs.putRaw(buf, {
          mediaType: detectMediaType(buf) ?? 'application/octet-stream',
          refId: 'sync:' + b.sha256.slice(0, 12),
        })
      } catch {}
    }
  }
  return { records: recordsCount }
}

/**
 * 还原记忆数据（含覆盖前安全备份与孤儿项目目录隔离）。
 *
 * 返回值带上归属统计：`work` / `bots` 是**还原后**（归一 + 归属补齐之后）的分布，
 * 进度与提示文案要用它说清「这次带回来多少条 Bot 记忆」。口径：`entries` 是落盘
 * 总条数（含软废弃），`work` / `bots` 只数活跃条目——与面板的规模视图一致。
 */
export async function restoreMemory(memory: GatheredMemory): Promise<{
  entries: number
  work: number
  bots: number
}> {
  const root = memoryHome()
  let entriesCount = 0
  let workCount = 0
  let botsCount = 0
  if (memory.entriesJson) {
    const entriesFile = join(root, 'store', 'entries.json')
    // 覆盖前自动生成本地安全快照备份，防误操作
    if (existsSync(entriesFile)) {
      await atomicWriteFile(entriesFile + '.bak-before-sync', await readFile(entriesFile)).catch(() => undefined)
    }

    /*
     * 落盘前先归一成 schema v6。
     *
     * 云端包可能是 v5（无 owner、旧 id 算法）。原样搬只会把旧结构留在磁盘上：
     * 宿主 `reload()` 会再跑一遍 `migrateEntries()`，于是内存态里的 id 与磁盘上的
     * 不是同一套，面板按 id 定位条目会找不到（表现为「同步恢复后记忆列表是空的」，
     * 而文件明明有内容）。这里提前归一，磁盘与内存态就是同一份 v6 数据。
     */
    let payload = memory.entriesJson
    let restored: MemoryEntry[] | undefined
    try {
      const parsed = JSON.parse(memory.entriesJson) as { entries?: unknown }
      if (Array.isArray(parsed.entries)) {
        restored = migrateEntries(parsed.entries)
        // 与 MemoryStore.flushNow 的落盘格式保持一致（`{ version: 2, entries }`）。
        payload = `${JSON.stringify({ version: 2, entries: restored }, null, 2)}\n`
      }
    } catch {
      // 解析不了就原样写：宁可让宿主把它当坏文件走恢复链，也不要吞掉用户云端数据。
    }
    await atomicWriteFile(entriesFile, payload)

    if (restored !== undefined) {
      entriesCount = restored.length
      // 归属只数活跃条目：软废弃的不进 work / bots（`entries` 仍是落盘总条数）。
      const stats = countOwners(activeOnly(restored))
      workCount = stats.work
      /*
       * `bot:*` 归属原样保留，不删也不改。
       *
       * 宿主侧拿不到浏览器 localStorage 里的 Bot 名册，认不出这些 id 是预期状态；
       * 这不是清理它们的理由——用户下次进那个 Bot，记忆还得在。
       */
      botsCount = totalBotEntries(stats.bots)
    } else {
      try {
        const parsed = JSON.parse(memory.entriesJson) as { entries?: unknown[] }
        if (Array.isArray(parsed.entries)) entriesCount = parsed.entries.length
      } catch {}
    }
  }
  if (memory.stateJson) {
    const stateFile = join(root, 'store', 'state.json')
    await atomicWriteFile(stateFile, memory.stateJson)
  }
  if (memory.projects) {
    for (const [hash, metaJson] of Object.entries(memory.projects)) {
      const metaFile = join(root, 'projects', hash, 'meta.json')
      await atomicWriteFile(metaFile, metaJson)
    }
    // 孤儿项目目录隔离（云端已无引用的废弃项目）
    try {
      const projectsDir = join(root, 'projects')
      if (existsSync(projectsDir)) {
        const localHashes = await readdir(projectsDir)
        const remoteHashes = new Set(Object.keys(memory.projects))
        for (const h of localHashes) {
          if (!remoteHashes.has(h)) {
            const trashDir = join(root, '.trash')
            await mkdir(trashDir, { recursive: true })
            await rename(join(projectsDir, h), join(trashDir, `${Date.now()}-project-${h}`)).catch(() => undefined)
          }
        }
      }
    } catch {}
  }

  // 通知内存态重载
  const activeStore = getWebuiMemoryStore() as { reload?: () => void } | undefined
  if (activeStore && typeof activeStore.reload === 'function') {
    activeStore.reload()
  }

  return { entries: entriesCount, work: workCount, bots: botsCount }
}

/** 还原技能数据（含孤儿技能安全隔离清理与内置技能防删保护）。 */
export async function restoreSkills(skills: GatheredSkills): Promise<{ files: number; removedSkills: number }> {
  const root = skillsHome()
  if (!existsSync(root)) {
    await mkdir(root, { recursive: true })
  }

  // 1. 整理云端包包含的顶层技能目录
  const remoteTopDirs = new Set<string>()
  for (const relPath of Object.keys(skills.files)) {
    const normalized = relPath.replace(/\\/g, '/')
    const parts = normalized.split('/')
    if (parts.length > 0 && parts[0] && !parts[0].startsWith('.')) {
      remoteTopDirs.add(parts[0])
    }
  }

  // 2. 识别本地需要被清理的孤儿技能目录（在云端包中已被删除的自定义技能）
  let removedCount = 0
  try {
    const localEntries = await readdir(root, { withFileTypes: true })
    const trashRoot = join(root, '.trash')

    for (const entry of localEntries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      // 保护项 1：隐藏目录（.trash 等）不清理
      if (name.startsWith('.')) continue

      const fullPath = join(root, name)
      // 保护项 2：随包分发的内置技能绝对不清理
      const isBundled = existsSync(join(fullPath, '.dsh-seeker-bot-bundled.json'))
      if (isBundled) continue

      // 如果云端包内已不包含该技能目录下的任何文件，说明在云端已被删除
      if (!remoteTopDirs.has(name)) {
        await mkdir(trashRoot, { recursive: true })
        const dest = join(trashRoot, `${Date.now()}-${name}`)
        await rename(fullPath, dest).catch(async () => {
          await cp(fullPath, dest, { recursive: true }).catch(() => undefined)
          await rm(fullPath, { recursive: true, force: true }).catch(() => undefined)
        })
        removedCount++
      }
    }
  } catch {}

  // 3. 写入/恢复云端包内文件
  let count = 0
  for (const [relPath, base64] of Object.entries(skills.files)) {
    const full = join(root, relPath)
    const buf = Buffer.from(base64, 'base64')
    await atomicWriteFile(full, buf)
    count++
  }

  return { files: count, removedSkills: removedCount }
}
