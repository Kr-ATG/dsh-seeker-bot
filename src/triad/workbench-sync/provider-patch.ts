/**
 * 工作台资产云端同步 —— 供应商与模型配置（Provider Sync）。
 *
 * 涵盖：
 *   1. cordis.patch.yml 中的供应商/模型相关条目（llm-pi-ai、llm-deepseek、agent-default-model 等）；
 *   2. cordis.patch.yml 中的 `web` 条目（网页搜索与抓取后端的选择）；
 *   3. ~/.dsh/.credentials.yaml 中的 API 密钥（refs 字段，端侧加密传输）；
 *   4. ~/.dsh/model-capabilities.json（各模型识图/推理/生图/生视频开关）；
 *   5. ~/.dsh/network-proxy.json（大模型网络代理设置与分流列表）；
 *   6. ~/.dsh/provider-hub-keyring.json（密钥环槽位命名与存档元数据）；
 *   7. ~/.dsh/storages/dsh-seeker-bot/personal-agent/realtime-config.json
 *      （Live / 实时语音供应商，宿主 `src/host/personal/realtime/config-store.ts` 落盘）。
 *
 * 设计约束（与 mcp-patch.ts 一致）：
 *   · 文本级编辑：保留注释、其它插件条目与行尾风格，绝不破坏 YAML；
 *   · 还原只做「更新同名 / 新增缺失」，绝不删除本机独有的条目与凭据；
 *   · 写前自动备份 *.bak-before-sync。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_REALTIME_VENDORS,
  REALTIME_DEFAULT_KEY_REF,
  REALTIME_DEFAULT_UPSTREAM,
  type RealtimeSpeed,
} from '../../shared/realtime-protocol.ts'

/** 目标条目的固定 ID 列表（同时用于探测 profile 所在目录）。 */
export const TARGET_PROVIDER_IDS = ['llm-pi-ai', 'llm-deepseek', 'agent-default-model']

/**
 * 除 llm 供应商外，还要一起漫游的「能力型」条目。
 *
 * `web` 是网页搜索与抓取的落点：`searchProvider` 决定走哪条搜索降级链
 * （本机是 `anysearch-auto`，即 AnySearch → Tavily → DeepSeek），`fetchProvider`
 * 决定网页抓取后端。不带上它，换机后搜索会悄悄退回 base bundle 的默认值
 * （`deepseek-official`），用户辛苦配好的「额度没了自动切」等于白做，而且
 * 表现为「能搜但一直在烧官方额度」——最难排查的一类静默回退。
 *
 * 单独的 `web-search-auto` 设置段（链顺序、冷却时长）目前没有 UI 写入入口，
 * 用默认值就够，不进同步范围。
 */
export const TARGET_CAPABILITY_IDS = ['web']

/** 扫描时要认的全部条目 id（供应商 + 能力型）。 */
const SCANNED_ENTRY_IDS: readonly string[] = [...TARGET_PROVIDER_IDS, ...TARGET_CAPABILITY_IDS]

const DEFAULT_PROFILE = 'web'
const BACKUP_SUFFIX = '.bak-before-sync'

function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

export function patchPathForProfile(profile: string): string {
  return join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
}

function resolvePatchPath(): string {
  const preferred = patchPathForProfile(DEFAULT_PROFILE)
  if (existsSync(preferred)) return preferred
  try {
    const profilesDir = join(dshHome(), 'profiles')
    for (const name of readdirSync(profilesDir)) {
      const candidate = patchPathForProfile(name)
      if (!existsSync(candidate)) continue
      const content = readFileSync(candidate, 'utf8')
      if (TARGET_PROVIDER_IDS.some((id) => content.includes(id))) return candidate
    }
  } catch {
    // profiles 目录不存在时退回默认路径
  }
  return preferred
}

function credentialsPath(): string {
  return join(dshHome(), '.credentials.yaml')
}

function modelCapabilitiesPath(): string {
  return join(dshHome(), 'model-capabilities.json')
}

function networkProxyPath(): string {
  return join(dshHome(), 'network-proxy.json')
}

function keyringPath(): string {
  return join(dshHome(), 'provider-hub-keyring.json')
}

export interface GatheredProviderPatchEntry {
  id: string
  block: string
}

/**
 * 一条 Live（实时语音）供应商记录，与宿主 `realtime-config.json` 的 `vendors[]` 同构。
 *
 * 为什么单独成段而不是塞进 `llm-*` 补丁条目：Live 供应商**不在** `cordis.patch.yml`
 * 里——它是本插件自己的 `~/.dsh/storages/dsh-seeker-bot/personal-agent/realtime-config.json`
 * （宿主 `src/host/personal/realtime/config-store.ts` 负责落盘与旧格式迁移）。
 * 不带上它，换机后「实时语音」页会退回内置预设：供应商列表空、音色语速全默认，
 * 而用户配过的 key（在 `.credentials.yaml` 的 refs 里）却还在——表现为「有 key 但
 * 没有供应商能用」，比彻底没配更难排查。
 */
export interface GatheredLiveVendor {
  id: string
  label: string
  upstream: string
  keyRef: string
  model?: string
  inputSampleRate?: number
  outputSampleRate?: number
}

/** Live 供应商整份配置（vendors + 通话默认）。 */
export interface GatheredLiveVendors {
  vendors: GatheredLiveVendor[]
  /** 默认供应商 id；空串/缺失 = 未显式设置（用第一条）。 */
  defaultVendor?: string
  /** 默认音色 id。 */
  voice?: string
  speed?: 'slow' | 'normal' | 'fast'
  webSearch?: boolean
}

export interface GatheredProviders {
  patchEntries: GatheredProviderPatchEntry[]
  profile?: string
  credentialRefs?: Record<string, string>
  modelCapabilitiesJson?: string
  networkProxyJson?: string
  keyringJson?: string
  /**
   * Live（实时语音）供应商配置（包格式 v2 起）。
   *
   * `undefined` = 本机没有这个文件（或读不出来）；空 `vendors: []` 是**有效状态**
   * （用户把供应商全删了），两者不能混为一谈。
   */
  liveVendors?: GatheredLiveVendors
}

export interface ProviderEntryBlock extends GatheredProviderPatchEntry {
  indent: number
  startLine: number
  endLine: number
}

function indentWidth(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0
}

function blockEnd(lines: string[], startLine: number, indent: number): number {
  let last = startLine
  for (let j = startLine + 1; j < lines.length; j += 1) {
    const line = lines[j]
    if (line.trim() === '') continue
    if (indentWidth(line) <= indent) break
    last = j
  }
  return last
}

/** 扫描补丁文件中的目标提供商相关块。 */
export function scanProviderPatchEntries(content: string): ProviderEntryBlock[] {
  if (content === '') return []
  const lines = content.split(/\r?\n/)
  const out: ProviderEntryBlock[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const idMatch = /^(\s*)- id:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*(?:#.*)?$/.exec(lines[i])
    if (idMatch === null) continue
    const entryId = idMatch[2]
    if (!SCANNED_ENTRY_IDS.includes(entryId)) continue

    const indent = idMatch[1].length
    const end = blockEnd(lines, i, indent)
    const blockLines = lines.slice(i, end + 1)
    out.push({
      id: entryId,
      indent,
      startLine: i,
      endLine: end,
      block: blockLines.join('\n'),
    })
  }
  return out
}

/** 解析 .credentials.yaml 里的 refs 凭据。 */
export function parseCredentialRefs(content: string): Record<string, string> {
  const refs: Record<string, string> = {}
  if (!content) return refs
  const match = /(?:^|\n)refs:\s*\r?\n([\s\S]*?)(?=\r?\n\S|$)/.exec(content)
  if (!match) return refs
  const lines = match[1].split(/\r?\n/)
  for (const line of lines) {
    const m = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    // 去除外层引号
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1)
    }
    refs[key] = val
  }
  return refs
}

/** 收集本地全部供应商与模型资产。 */
export function gatherProviderAssets(): GatheredProviders {
  const patchPath = resolvePatchPath()
  const profile = basename(dirname(patchPath))
  let patchEntries: GatheredProviderPatchEntry[] = []
  if (existsSync(patchPath)) {
    try {
      const content = readFileSync(patchPath, 'utf8')
      patchEntries = scanProviderPatchEntries(content).map((e) => ({
        id: e.id,
        block: e.block,
      }))
    } catch {}
  }

  // 凭据
  let credentialRefs: Record<string, string> | undefined
  const credPath = credentialsPath()
  if (existsSync(credPath)) {
    try {
      const raw = readFileSync(credPath, 'utf8')
      credentialRefs = parseCredentialRefs(raw)
    } catch {}
  }

  // 模型能力
  let modelCapabilitiesJson: string | undefined
  const mcPath = modelCapabilitiesPath()
  if (existsSync(mcPath)) {
    try {
      modelCapabilitiesJson = readFileSync(mcPath, 'utf8')
    } catch {}
  }

  // 网络代理
  let networkProxyJson: string | undefined
  const npPath = networkProxyPath()
  if (existsSync(npPath)) {
    try {
      networkProxyJson = readFileSync(npPath, 'utf8')
    } catch {}
  }

  // 密钥环
  let keyringJson: string | undefined
  const krPath = keyringPath()
  if (existsSync(krPath)) {
    try {
      keyringJson = readFileSync(krPath, 'utf8')
    } catch {}
  }

  // Live（实时语音）供应商：文件不存在时**不写这个键**（条件展开），否则恢复端会把
  // 「本机没有这个文件」误当成「云端把供应商清空了」。
  const liveVendors = gatherLiveVendors()

  return {
    patchEntries,
    profile,
    ...(credentialRefs && Object.keys(credentialRefs).length > 0 ? { credentialRefs } : {}),
    ...(modelCapabilitiesJson ? { modelCapabilitiesJson } : {}),
    ...(networkProxyJson ? { networkProxyJson } : {}),
    ...(keyringJson ? { keyringJson } : {}),
    ...(liveVendors !== undefined ? { liveVendors } : {}),
  }
}

/** 本机供应商配置规模与条目数（状态视图用）。 */
export function providerPatchSummary(): {
  path: string
  count: number
  bytes: number
  keysCount: number
  /** `web` 条目里选的搜索后端，例如 `anysearch-auto`；没配或读不到时为空串。 */
  webSearchProvider: string
} {
  const patchPath = resolvePatchPath()
  let count = 0
  let bytes = 0
  let keysCount = 0
  let webSearchProvider = ''

  if (existsSync(patchPath)) {
    try {
      const content = readFileSync(patchPath, 'utf8')
      const entries = scanProviderPatchEntries(content)
      for (const e of entries) {
        bytes += Buffer.byteLength(e.block, 'utf8')
        if (e.id === 'llm-pi-ai') {
          // 统计 llm-pi-ai 下定义的 provider 数量
          const providerMatches = e.block.match(/^\s{4,6}[A-Za-z0-9_-]+:\s*$/gm)
          count += providerMatches ? providerMatches.length : 1
        } else if (e.id === 'llm-deepseek') {
          count += 1
        } else if (e.id === 'web') {
          // 只读值，不回写：搜索后端是本机现状，不是可编辑字段。
          const match = /^\s+searchProvider:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/m.exec(e.block)
          if (match !== null && match[1] !== undefined) webSearchProvider = match[1]
        }
      }
    } catch {}
  }

  const credPath = credentialsPath()
  if (existsSync(credPath)) {
    try {
      const raw = readFileSync(credPath, 'utf8')
      const refs = parseCredentialRefs(raw)
      keysCount = Object.keys(refs).length
      bytes += Buffer.byteLength(raw, 'utf8')
    } catch {}
  }

  const mcPath = modelCapabilitiesPath()
  if (existsSync(mcPath)) {
    try { bytes += readFileSync(mcPath).length } catch {}
  }
  const npPath = networkProxyPath()
  if (existsSync(npPath)) {
    try { bytes += readFileSync(npPath).length } catch {}
  }
  const krPath = keyringPath()
  if (existsSync(krPath)) {
    try { bytes += readFileSync(krPath).length } catch {}
  }
  /*
   * Live（实时语音）供应商配置也算供应商规模。
   *
   * 不带上它，同步设置页会出现自相矛盾的一行：体积按「技能 + MCP + 供应商」算，
   * 而旁边又写着「Live 供应商 N 家」——那几家的配置字节不在体积里。文件很小
   * （几百字节），但口径不一致比数字小更让人怀疑「是不是没同步上」。
   */
  const livePath = liveVendorsPath()
  if (existsSync(livePath)) {
    try { bytes += readFileSync(livePath).length } catch {}
  }

  return { path: patchPath, count: Math.max(count, 1), bytes, keysCount, webSearchProvider }
}

/** 原子写文件并自动创建父目录。 */
function atomicWrite(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmpPath = `${targetPath}.tmp-${Date.now()}`
  writeFileSync(tmpPath, content, 'utf8')
  try {
    renameSync(tmpPath, targetPath)
  } catch {
    try { unlinkSync(targetPath) } catch {}
    renameSync(tmpPath, targetPath)
  }
}

/** 备份原文件。 */
function backupBeforeSync(filePath: string): void {
  if (existsSync(filePath)) {
    try { copyFileSync(filePath, `${filePath}${BACKUP_SUFFIX}`) } catch {}
  }
}

/** 还原 cordis.patch.yml 中的供应商条目（同名覆盖更新，缺失新增追加）。 */
export function restoreProviderPatchEntries(
  entries: GatheredProviderPatchEntry[],
  preferredProfile?: string,
): { added: number; updated: number; kept: number } {
  if (!entries || entries.length === 0) return { added: 0, updated: 0, kept: 0 }
  const targetPath = preferredProfile ? patchPathForProfile(preferredProfile) : resolvePatchPath()

  let original = ''
  if (existsSync(targetPath)) {
    try { original = readFileSync(targetPath, 'utf8') } catch {}
  }

  // 空文件时直接格式化为顶级 YAML 数组
  if (original.trim() === '') {
    const blocks = entries.map((e) => e.block.trimEnd()).join('\n\n')
    atomicWrite(targetPath, blocks.endsWith('\n') ? blocks : `${blocks}\n`)
    return { added: entries.length, updated: 0, kept: 0 }
  }

  backupBeforeSync(targetPath)
  const existing = scanProviderPatchEntries(original)
  const existingMap = new Map<string, ProviderEntryBlock>()
  for (const b of existing) {
    existingMap.set(b.id, b)
  }

  const lines = original.split(/\r?\n/)
  const edits: Array<{ startLine: number; endLine: number; replacement: string[] }> = []
  let updated = 0
  let added = 0
  const appended: string[] = []

  for (const incoming of entries) {
    const current = existingMap.get(incoming.id)
    if (current !== undefined) {
      // 存在同名条目：就地更新块内容
      edits.push({
        startLine: current.startLine,
        endLine: current.endLine,
        replacement: incoming.block.split('\n'),
      })
      updated += 1
    } else {
      // 本机缺失：追加到末尾
      appended.push(incoming.block.trimEnd())
      added += 1
    }
  }

  // 按从后往前的顺序应用行替换
  edits.sort((a, b) => b.startLine - a.startLine)
  for (const edit of edits) {
    lines.splice(edit.startLine, edit.endLine - edit.startLine + 1, ...edit.replacement)
  }

  if (appended.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('')
    }
    for (const blk of appended) {
      lines.push(blk)
      lines.push('')
    }
  }

  const nextContent = lines.join('\n').replace(/\n{3,}/g, '\n\n')
  atomicWrite(targetPath, nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`)
  return { added, updated, kept: existing.length - updated }
}

/** 还原 .credentials.yaml 凭据（同名更新/缺失新增，保留本机独有 refs）。 */
export function restoreCredentialRefs(incomingRefs: Record<string, string>): { added: number; updated: number; kept: number } {
  if (!incomingRefs || Object.keys(incomingRefs).length === 0) return { added: 0, updated: 0, kept: 0 }
  const targetPath = credentialsPath()

  let original = ''
  if (existsSync(targetPath)) {
    try { original = readFileSync(targetPath, 'utf8') } catch {}
  }

  if (original.trim() === '') {
    // 全新创建
    const rows = ['refs:']
    for (const [k, v] of Object.entries(incomingRefs)) {
      rows.push(`  ${k}: '${v.replace(/'/g, "''")}'`)
    }
    rows.push('version: 1')
    atomicWrite(targetPath, rows.join('\n') + '\n')
    return { added: Object.keys(incomingRefs).length, updated: 0, kept: 0 }
  }

  backupBeforeSync(targetPath)
  const currentRefs = parseCredentialRefs(original)
  let added = 0
  let updated = 0
  let kept = 0

  for (const k of Object.keys(currentRefs)) {
    if (!(k in incomingRefs)) kept += 1
  }

  // 检查是否已有 refs: 块
  const refsMatch = /(?:^|\n)(refs:\s*\r?\n)/.exec(original)
  if (!refsMatch) {
    // 原文件无 refs 块，追加
    const rows = ['refs:']
    for (const [k, v] of Object.entries(incomingRefs)) {
      rows.push(`  ${k}: '${v.replace(/'/g, "''")}'`)
      added += 1
    }
    const newContent = `${original.trimEnd()}\n\n${rows.join('\n')}\n`
    atomicWrite(targetPath, newContent)
    return { added, updated, kept }
  }

  // 有 refs 块：进行行级替换与插入
  const lines = original.split(/\r?\n/)
  let inRefs = false
  const updatedKeys = new Set<string>()

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (inRefs) {
      if (/^\S/.test(line)) {
        // 遇到非缩进行，refs 块结束
        inRefs = false
        continue
      }
      const m = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
      if (m) {
        const key = m[1]
        if (key in incomingRefs) {
          const newVal = incomingRefs[key]
          lines[i] = `  ${key}: '${newVal.replace(/'/g, "''")}'`
          updatedKeys.add(key)
          updated += 1
        }
      }
    }
  }

  // 对于传入但在原 refs 中不存在的 key，追加到 refs 块末尾
  const missingKeys = Object.keys(incomingRefs).filter((k) => !updatedKeys.has(k))
  if (missingKeys.length > 0) {
    // 寻找 refs 块的插入点（最后一个缩进行之后）
    let insertLine = -1
    inRefs = false
    for (let i = 0; i < lines.length; i += 1) {
      if (/^refs:\s*$/.test(lines[i])) {
        inRefs = true
        insertLine = i
        continue
      }
      if (inRefs) {
        if (/^\s+/.test(lines[i])) {
          insertLine = i
        } else if (/^\S/.test(lines[i])) {
          break
        }
      }
    }

    const newRows: string[] = []
    for (const k of missingKeys) {
      newRows.push(`  ${k}: '${incomingRefs[k].replace(/'/g, "''")}'`)
      added += 1
    }

    if (insertLine >= 0) {
      lines.splice(insertLine + 1, 0, ...newRows)
    }
  }

  atomicWrite(targetPath, lines.join('\n') + '\n')
  return { added, updated, kept }
}

/** 还原 JSON 配置文件（做浅合并保护本机独有字段）。 */
function restoreJsonFile(targetPath: string, incomingJson?: string, mergeKey?: string): boolean {
  if (!incomingJson) return false
  let incomingObj: any
  try {
    incomingObj = JSON.parse(incomingJson)
  } catch {
    return false
  }

  backupBeforeSync(targetPath)
  if (!existsSync(targetPath)) {
    atomicWrite(targetPath, JSON.stringify(incomingObj, null, 2) + '\n')
    return true
  }

  try {
    const localObj = JSON.parse(readFileSync(targetPath, 'utf8'))
    let merged: any
    if (mergeKey && typeof localObj === 'object' && typeof incomingObj === 'object') {
      merged = {
        ...incomingObj,
        [mergeKey]: {
          ...(localObj[mergeKey] || {}),
          ...(incomingObj[mergeKey] || {}),
        },
      }
    } else if (typeof localObj === 'object' && typeof incomingObj === 'object') {
      merged = { ...localObj, ...incomingObj }
    } else {
      merged = incomingObj
    }
    atomicWrite(targetPath, JSON.stringify(merged, null, 2) + '\n')
    return true
  } catch {
    atomicWrite(targetPath, JSON.stringify(incomingObj, null, 2) + '\n')
    return true
  }
}

/** 完整还原供应商资产。 */
export async function restoreProviderAssets(data: GatheredProviders): Promise<{
  patchResult: { added: number; updated: number; kept: number }
  credentialsResult: { added: number; updated: number; kept: number }
  liveResult: { added: number; updated: number; kept: number }
}> {
  const patchResult = restoreProviderPatchEntries(data.patchEntries || [], data.profile)
  const credentialsResult = data.credentialRefs
    ? restoreCredentialRefs(data.credentialRefs)
    : { added: 0, updated: 0, kept: 0 }

  if (data.modelCapabilitiesJson) {
    restoreJsonFile(modelCapabilitiesPath(), data.modelCapabilitiesJson, 'flags')
  }
  if (data.networkProxyJson) {
    restoreJsonFile(networkProxyPath(), data.networkProxyJson)
  }
  if (data.keyringJson) {
    restoreJsonFile(keyringPath(), data.keyringJson)
  }
  const liveResult = data.liveVendors
    ? restoreLiveVendors(data.liveVendors)
    : { added: 0, updated: 0, kept: 0 }

  return { patchResult, credentialsResult, liveResult }
}

/* ────────────────── Live（实时语音）供应商 ────────────────── */

/**
 * Live 供应商配置文件路径。
 *
 * 与宿主 `src/host/personal/realtime/config-store.ts` 的 `userConfigFile()` **必须
 * 一致**：那边是唯一写入方，这里只做搬运。两边漂移的表现是「同步成功但实时语音
 * 页永远是空的」——文件写到别处去了，没有任何报错。
 */
export function liveVendorsPath(): string {
  return join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent', 'realtime-config.json')
}

/*
 * 下面这段归一/合并逻辑是宿主 `src/host/personal/realtime/config-store.ts` 的
 * **同构最小实现**，故意不 import 宿主文件：`src/triad/**` 不向 `src/host/**` 引依赖
 * （反向同理），否则打包图里会出现一条 triad ← host 的回边，拆包时先炸的是它。
 * 两边函数一一对应，改一边必须同步另一边：
 *
 *   | 本文件                                     | 宿主 config-store.ts                     |
 *   | ------------------------------------------ | ---------------------------------------- |
 *   | liveVendorsPath()                          | userConfigFile()                         |
 *   | readLiveConfigFile()                       | readRaw()                                |
 *   | normalizeLiveVendor()                      | normalizeVendor()                        |
 *   | mergeIntoLivePresets()                     | mergeIntoPresets()                       |
 *   | sameLiveEndpoint() / dedupeLiveByEndpoint()| sameEndpoint() / dedupeByEndpoint()      |
 *   | migrateLiveVendors()                       | migrateVendors()                         |
 *   | normalizeLiveConfig()                      | readUserConfig()                         |
 *   | restoreLiveVendors() 的落盘段              | writeUserConfig()                        |
 *
 * 漂移的典型表现是「同步显示成功，但本机实时语音页少几条供应商」，两边都不报错。
 */

/** 磁盘上的 Live 配置原始结构（含旧版本遗留字段）。字段一律按 unknown 处理，读时逐个校验。 */
type StoredLiveConfig = Record<string, unknown>

interface LiveConfigSnapshot {
  /** 文件原文（`liveVendorSummary()` 计字节用）。 */
  text: string
  /** 解析后的对象；文件能读但不是合法 JSON 对象时为 `undefined`。 */
  value: StoredLiveConfig | undefined
}

/**
 * 读 `realtime-config.json` 的原文与解析结果。
 *
 * 返回 `undefined` 只表示「文件不存在或读不出来」（权限 / 目录缺失）；文件存在但
 * JSON 坏了会返回 `{ text, value: undefined }`——状态视图据此仍能计出文件体积，
 * 而采集端把「读不出内容」统一当 `undefined`（不往包里塞一份残缺配置）。
 */
function readLiveConfigFile(): LiveConfigSnapshot | undefined {
  const file = liveVendorsPath()
  if (!existsSync(file)) return undefined
  try {
    const text = readFileSync(file, 'utf8')
    let value: StoredLiveConfig | undefined
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        value = parsed as StoredLiveConfig
      }
    } catch {
      // 坏 JSON：当「读不出来」处理，由调用方决定返回 undefined 还是零值。
      value = undefined
    }
    return { text, value }
  } catch {
    return undefined
  }
}

/** 校验一条 Live 供应商（对齐宿主 `normalizeVendor()`：缺关键字段整条丢弃）。 */
function normalizeLiveVendor(raw: unknown): GatheredLiveVendor | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as StoredLiveConfig
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  const upstream = typeof source.upstream === 'string' ? source.upstream.trim() : ''
  const keyRef = typeof source.keyRef === 'string' ? source.keyRef.trim() : ''
  // 半个供应商（没端点 / 没凭据引用）渲染出来只会更难排查，直接丢掉。
  if (id === '' || upstream === '' || keyRef === '') return null
  const label = typeof source.label === 'string' ? source.label.trim() : ''
  const vendor: GatheredLiveVendor = { id, label: label === '' ? id : label, upstream, keyRef }
  // model 空串 = 走宿主候选链，不落字段。
  if (typeof source.model === 'string' && source.model.trim() !== '') vendor.model = source.model.trim()
  // 采样率只认 8000–48000 并取整（宿主同一区间）：喂错不会报错，只会变调 + VAD 时间轴错位。
  const inputRate = Number(source.inputSampleRate)
  if (Number.isFinite(inputRate) && inputRate >= 8000 && inputRate <= 48000) vendor.inputSampleRate = Math.round(inputRate)
  const outputRate = Number(source.outputSampleRate)
  if (Number.isFinite(outputRate) && outputRate >= 8000 && outputRate <= 48000) vendor.outputSampleRate = Math.round(outputRate)
  return vendor
}

/** 两个上游地址是否指向同一端点（忽略大小写与结尾斜杠）——同宿主 `sameEndpoint()`。 */
function sameLiveEndpoint(a: string, b: string): boolean {
  const norm = (value: string): string => value.trim().toLowerCase().replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/**
 * 按上游地址去重，保留第一条——同宿主 `dedupeByEndpoint()`。
 *
 * 同一个端点用一把 key 连，列表里重复一条没有任何意义；旧版按 route 迁移出来的
 * `stepplan` 与内置预设 `stepfun` 就是这种「同名两条」的来源。
 */
function dedupeLiveByEndpoint(vendors: GatheredLiveVendor[]): GatheredLiveVendor[] {
  const seen = new Set<string>()
  const out: GatheredLiveVendor[] = []
  for (const vendor of vendors) {
    const key = vendor.upstream.trim().toLowerCase().replace(/\/+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(vendor)
  }
  return out
}

/**
 * 以内置预设为基底，用迁移出来的记录覆盖同 id / 同端点的那条——同宿主 `mergeIntoPresets()`。
 *
 * 为什么不是「迁移出几条就只返回几条」：旧配置里通常只存了用户用过的那一家，直接
 * 返回一条会让他以为另一家的预设丢了。而只按 id 匹配又会让「旧 route 迁移出来的
 * stepplan」与「预设 stepfun」并存成两条同名供应商（用户实测截图里就是这个），
 * 所以 id 匹配不到时再按上游地址找。
 */
function mergeIntoLivePresets(migrated: GatheredLiveVendor[]): GatheredLiveVendor[] {
  const base = DEFAULT_REALTIME_VENDORS.map((item) => ({ ...item }))
  for (const item of migrated) {
    let index = base.findIndex((entry) => entry.id === item.id)
    if (index < 0) index = base.findIndex((entry) => sameLiveEndpoint(entry.upstream, item.upstream))
    if (index >= 0) base[index] = item
    else base.push(item)
  }
  return base
}

/**
 * 把磁盘上的任意形状归一成 `vendors[]`——判定顺序与宿主 `migrateVendors()` 一致：
 *
 *   1. 新结构 `vendors[]`：直接用（**空数组也尊重**，不塞回预设）；
 *   2. 旧格式 A：单份 `vendor/model/keyRef/upstream`；
 *   3. 旧格式 B：`routes.<provider>` 分存，取第一个有内容的（用内置预设 id 覆盖
 *      route 名，否则同一端点会以两个 id 并存）；
 *   4. 全新：内置预设。
 *
 * 各分支最后统一按 upstream 去重（幂等：宿主在 1 分支做，2/3 分支由 mergeIntoPresets
 * 保证不重复，这里再兜一次）。
 */
function migrateLiveVendors(raw: StoredLiveConfig): GatheredLiveVendor[] {
  // 1) 新格式：直接用。空数组也尊重——用户把供应商全删了就该是空的，不能偷偷塞回预设。
  if (Array.isArray(raw.vendors)) {
    const list = (raw.vendors as unknown[])
      .map((item) => normalizeLiveVendor(item))
      .filter((item): item is GatheredLiveVendor => item !== null)
    return dedupeLiveByEndpoint(list)
  }

  // 2) 旧格式 A：单份 vendor/model/keyRef/upstream
  //    注意判据与宿主一致：只要 `vendor` 是字符串（哪怕空串）就进这一支——宿主那边
  //    也是这么写的，空串会迁移出一条 id=default、上游/凭据取预设的供应商。
  const legacyVendor = typeof raw.vendor === 'string' ? raw.vendor : ''
  if (typeof raw.vendor === 'string' || typeof raw.upstream === 'string' || typeof raw.keyRef === 'string') {
    const preset = DEFAULT_REALTIME_VENDORS.find((item) => item.id === legacyVendor)
    const migrated = normalizeLiveVendor({
      id: legacyVendor !== '' ? legacyVendor : 'default',
      label: preset?.label ?? (legacyVendor !== '' ? legacyVendor : '默认'),
      upstream: typeof raw.upstream === 'string' && raw.upstream !== '' ? raw.upstream : (preset?.upstream ?? REALTIME_DEFAULT_UPSTREAM),
      keyRef: typeof raw.keyRef === 'string' && raw.keyRef !== '' ? raw.keyRef : (preset?.keyRef ?? REALTIME_DEFAULT_KEY_REF),
      model: typeof raw.model === 'string' ? raw.model : preset?.model,
      inputSampleRate: preset?.inputSampleRate,
      outputSampleRate: preset?.outputSampleRate,
    })
    if (migrated !== null) return dedupeLiveByEndpoint(mergeIntoLivePresets([migrated]))
  }

  // 3) 旧格式 B：按聊天供应商分存（routes.*）——挑第一个能归一出来的
  const routes = raw.routes
  if (routes !== undefined && routes !== null && typeof routes === 'object' && !Array.isArray(routes)) {
    for (const [route, scoped] of Object.entries(routes as StoredLiveConfig)) {
      if (scoped === null || typeof scoped !== 'object' || Array.isArray(scoped)) continue
      const item = scoped as StoredLiveConfig
      const scopedVendor = typeof item.vendor === 'string' ? item.vendor : ''
      const preset = DEFAULT_REALTIME_VENDORS.find((entry) => entry.id === scopedVendor)
      const migrated = normalizeLiveVendor({
        // 用预设 id 而不是聊天供应商 route：否则同一端点会以两个 id 并存（两条 StepFun）。
        id: preset?.id ?? route,
        label: preset?.label ?? route,
        upstream: typeof item.upstream === 'string' && item.upstream !== '' ? item.upstream : (preset?.upstream ?? REALTIME_DEFAULT_UPSTREAM),
        keyRef: typeof item.keyRef === 'string' && item.keyRef !== '' ? item.keyRef : (preset?.keyRef ?? REALTIME_DEFAULT_KEY_REF),
        model: item.model ?? preset?.model,
        inputSampleRate: preset?.inputSampleRate,
        outputSampleRate: preset?.outputSampleRate,
      })
      if (migrated !== null) return dedupeLiveByEndpoint(mergeIntoLivePresets([migrated]))
    }
  }

  // 4) 全新（或旧字段全空）：内置预设
  return DEFAULT_REALTIME_VENDORS.map((item) => ({ ...item }))
}

/** 语速只认三档（宿主 `readUserConfig()` 的同一判据），其余值当未设置。 */
function normalizeLiveSpeed(raw: unknown): RealtimeSpeed | undefined {
  return raw === 'slow' || raw === 'normal' || raw === 'fast' ? raw : undefined
}

/** 原始结构 → 归一后的整份配置（对应宿主 `readUserConfig()`）。 */
function normalizeLiveConfig(raw: StoredLiveConfig): GatheredLiveVendors {
  const vendors = migrateLiveVendors(raw)
  const out: GatheredLiveVendors = { vendors }
  /*
   * 通话默认项**原样带上**：空串照带（= 用户显式清空，宿主读的时候会回落到第一条 /
   * 默认音色），缺失才不带。恢复端据此区分「云端没带这个字段」与「云端带了个空」，
   * 否则用户「把音色清回默认」的操作同步到另一台机器上会被静默忽略。
   */
  if (typeof raw.defaultVendor === 'string') out.defaultVendor = raw.defaultVendor
  if (typeof raw.voice === 'string') out.voice = raw.voice
  const speed = normalizeLiveSpeed(raw.speed)
  if (speed !== undefined) out.speed = speed
  if (typeof raw.webSearch === 'boolean') out.webSearch = raw.webSearch
  return out
}

/**
 * 收集本机 Live 供应商配置。
 *
 * 旧结构（`routes.*` 分存、或单份 `vendor/model/keyRef/upstream`）在这里就归一成
 * `vendors[]`，不要原样打包：换机后旧结构虽然能被宿主迁移，但包里的语义会变成
 * 「一份旧格式」，恢复端还得再猜一次。归一逻辑与 `config-store.ts` 的
 * `migrateVendors()` 保持同一套判定顺序（新格式 → 单份 → routes → 内置预设）。
 *
 * @returns 本机没有该文件时返回 `undefined`（区别于「文件存在但供应商为空」）。
 */
export function gatherLiveVendors(): GatheredLiveVendors | undefined {
  const snapshot = readLiveConfigFile()
  // 文件不存在 / 读不出来 / 坏 JSON：一律 undefined（=「本机没有可搬运的配置」）。
  // 注意与「文件存在但 vendors 为空」区分：后者是有效状态（用户把供应商删光了），
  // 必须原样打包，否则恢复端会把云端那份空列表当成「没配过」再塞回内置预设。
  if (snapshot === undefined || snapshot.value === undefined) return undefined
  return normalizeLiveConfig(snapshot.value)
}

/** 本机 Live 供应商规模与默认项（状态视图用，读不出来时给零值）。 */
export function liveVendorSummary(): { vendors: number; defaultVendor: string; bytes: number } {
  try {
    const snapshot = readLiveConfigFile()
    if (snapshot === undefined) return { vendors: 0, defaultVendor: '', bytes: 0 }
    // bytes 算文件原文（含旧结构遗留字段）：用户看的是「这份配置占多少空间」。
    const bytes = Buffer.byteLength(snapshot.text, 'utf8')
    if (snapshot.value === undefined) return { vendors: 0, defaultVendor: '', bytes }
    // 数量与默认项都用**归一后**的结果：旧 routes 结构归一出来的是几条预设，
    // 直接数 raw.vendors.length 会恒为 0，面板上就成了「配了却显示 0 条」。
    const config = normalizeLiveConfig(snapshot.value)
    return { vendors: config.vendors.length, defaultVendor: config.defaultVendor ?? '', bytes }
  } catch {
    // 状态视图绝不因为读配置失败而抛错（否则整块同步面板会跟着白）。
    return { vendors: 0, defaultVendor: '', bytes: 0 }
  }
}

/**
 * 还原 Live 供应商配置（按 vendor id 合并）。
 *
 * 与 MCP / 供应商补丁同一条安全口径：云端同名覆盖、本机缺失的新增、**本机独有的
 * 供应商绝不删除**；`defaultVendor` / `voice` / `speed` / `webSearch` 由云端覆盖
 * （云端没带就保留本机值）。写前备份 `*.bak-before-sync`，落盘一律用新结构
 * （顺带清掉旧字段，避免下一次读取还要再迁移一遍）。
 */
export function restoreLiveVendors(incoming: GatheredLiveVendors): { added: number; updated: number; kept: number } {
  if (incoming === null || incoming === undefined) return { added: 0, updated: 0, kept: 0 }
  const targetPath = liveVendorsPath()

  // ── 1. 读本机现状（坏 JSON 当空）──────────────────────────────
  let localRaw: StoredLiveConfig | undefined
  if (existsSync(targetPath)) {
    try {
      const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        localRaw = parsed as StoredLiveConfig
      }
    } catch {
      // 坏 JSON：当「本机没有配置」处理，恢复完顺手把它写回合法结构。
      localRaw = undefined
    }
  }
  /*
   * 本机已有的供应商列表：有 `vendors` 或旧格式字段时才走迁移，**空对象不播种内置
   * 预设**——恢复场景下云端才是权威，把预设当成「本机独有」混进合并结果只会凭空多出
   * 几条没人配过的条目。（宿主下次读这份文件时自己仍会播种，最终视图不受影响。）
   */
  const localRoutes = localRaw?.routes
  const hasLocalContent = localRaw !== undefined
    && (Array.isArray(localRaw.vendors)
      || typeof localRaw.vendor === 'string'
      || typeof localRaw.upstream === 'string'
      || typeof localRaw.keyRef === 'string'
      || (localRoutes !== undefined && localRoutes !== null && typeof localRoutes === 'object' && !Array.isArray(localRoutes)))
  const localVendors = hasLocalContent && localRaw !== undefined ? migrateLiveVendors(localRaw) : []

  // 本地按 id 去重（保留首次出现的顺序）：合并结果里不允许出现两条同 id。
  const localById = new Map<string, GatheredLiveVendor>()
  const localOrder: string[] = []
  for (const vendor of localVendors) {
    if (localById.has(vendor.id)) continue
    localById.set(vendor.id, vendor)
    localOrder.push(vendor.id)
  }

  // ── 2. 云端条目也过一遍校验（包里可能是旧版本 / 手改过的数据）──
  const incomingVendors: unknown[] = Array.isArray(incoming.vendors) ? incoming.vendors : []
  const incomingById = new Map<string, GatheredLiveVendor>()
  for (const item of incomingVendors) {
    const vendor = normalizeLiveVendor(item)
    if (vendor === null || incomingById.has(vendor.id)) continue
    incomingById.set(vendor.id, vendor)
  }

  // ── 3. 合并：本机顺序为基底，同名覆盖、缺失新增、本机独有保留 ──
  const merged: GatheredLiveVendor[] = []
  let updated = 0
  let kept = 0
  for (const id of localOrder) {
    const remote = incomingById.get(id)
    if (remote !== undefined) {
      merged.push(remote)
      updated += 1
    } else {
      merged.push(localById.get(id) as GatheredLiveVendor)
      kept += 1
    }
  }
  let added = 0
  for (const [id, vendor] of incomingById) {
    if (localById.has(id)) continue
    merged.push(vendor)
    added += 1
  }

  // ── 4. 落盘：新结构 + 清掉旧字段（与宿主 writeUserConfig 写回行为一致）──
  // 保留文件里的未知字段（宿主 writeUserConfig 也是 `{...raw}` 后再删旧字段），
  // 避免把未来版本新增的字段悄悄抹掉。
  backupBeforeSync(targetPath)
  const next: StoredLiveConfig = { ...(localRaw ?? {}) }
  next.vendors = merged
  // 云端没带（undefined）就保留本机值；带了空串照存——空串 = 用户显式清空，宿主读的时候
  // 会回落到第一条 / 默认音色，与宿主 `writeUserConfig()` 的「undefined 跳过、空串照存」一致。
  if (typeof incoming.defaultVendor === 'string') next.defaultVendor = incoming.defaultVendor
  if (typeof incoming.voice === 'string') next.voice = incoming.voice
  const speed = normalizeLiveSpeed(incoming.speed)
  if (speed !== undefined) next.speed = speed
  if (typeof incoming.webSearch === 'boolean') next.webSearch = incoming.webSearch
  // 迁移完成后把旧字段清掉，避免下次读到两份互相矛盾的配置。
  delete next.routes
  delete next.vendor
  delete next.model
  delete next.keyRef
  delete next.upstream
  atomicWrite(targetPath, `${JSON.stringify(next, null, 2)}\n`)
  return { added, updated, kept }
}

