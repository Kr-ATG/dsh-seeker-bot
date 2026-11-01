/**
 * 工作台资产云端同步 —— 供应商与模型配置（Provider Sync）。
 *
 * 涵盖：
 *   1. cordis.patch.yml 中的供应商/模型相关条目（llm-pi-ai、llm-deepseek、agent-default-model 等）；
 *   2. cordis.patch.yml 中的 `web` 条目（网页搜索与抓取后端的选择）；
 *   3. ~/.dsh/.credentials.yaml 中的 API 密钥（refs 字段，端侧加密传输）；
 *   4. ~/.dsh/model-capabilities.json（各模型识图/推理/生图/生视频开关）；
 *   5. ~/.dsh/network-proxy.json（大模型网络代理设置与分流列表）；
 *   6. ~/.dsh/provider-hub-keyring.json（密钥环槽位命名与存档元数据）。
 *
 * 设计约束（与 mcp-patch.ts 一致）：
 *   · 文本级编辑：保留注释、其它插件条目与行尾风格，绝不破坏 YAML；
 *   · 还原只做「更新同名 / 新增缺失」，绝不删除本机独有的条目与凭据；
 *   · 写前自动备份 *.bak-before-sync。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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

export interface GatheredProviders {
  patchEntries: GatheredProviderPatchEntry[]
  profile?: string
  credentialRefs?: Record<string, string>
  modelCapabilitiesJson?: string
  networkProxyJson?: string
  keyringJson?: string
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

  return {
    patchEntries,
    profile,
    ...(credentialRefs && Object.keys(credentialRefs).length > 0 ? { credentialRefs } : {}),
    ...(modelCapabilitiesJson ? { modelCapabilitiesJson } : {}),
    ...(networkProxyJson ? { networkProxyJson } : {}),
    ...(keyringJson ? { keyringJson } : {}),
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

  return { patchResult, credentialsResult }
}
