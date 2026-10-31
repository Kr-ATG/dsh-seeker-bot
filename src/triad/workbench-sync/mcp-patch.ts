/**
 * 工作台资产云端同步 —— MCP 配置（cordis.patch.yml 的 mcp-client 条目）。
 *
 * 为什么单独成模块：MCP 开关不在 skills 目录里，而是写在 DSH 的插件补丁文件
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 insert 条目中
 * （`disabled: true` 即禁用）。同步设置里的「MCP 配置」勾选项收的就是这些条目。
 *
 * 设计约束（与 mcp-status.ts 的写路径保持同一套语义）：
 *   · 文本级编辑：保留注释、其它插件条目与行尾风格，绝不整体重写 YAML；
 *   · 只碰 `name: @deepseek-ai/dsh-mcp-client` 的条目，其它条目一个字节不动；
 *   · 还原只做「更新同名 / 新增缺失」，绝不删除本机独有的 MCP 条目——
 *     另一台机器上的私有 MCP 不该被云端包抹掉。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const MCP_CLIENT_PKG = '@deepseek-ai/dsh-mcp-client'
/** 与 mcp-status.ts 一致的默认 profile：web 半身补丁文件所在目录。 */
const DEFAULT_PROFILE = 'web'
/** 覆盖写之前的备份（固定名，覆盖式；保留最近一次同步前的版本）。 */
const BACKUP_SUFFIX = '.bak-before-sync'
/** 新建 insert 容器时条目的缩进（对齐真实 cordis.patch.yml 里 insert 下的 4 空格层级）。 */
const NEW_ENTRY_INDENT = 4

function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

/** 某个 profile 的补丁文件路径。 */
export function patchPathForProfile(profile: string): string {
  return join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
}

/**
 * 解析「本机真正在用的」补丁文件：默认 web profile；没有就扫一遍其它 profile，
 * 取第一个确实含有 mcp-client 条目的文件；再没有就退回 web 路径（可能尚不存在）。
 */
function resolvePatchPath(): string {
  const preferred = patchPathForProfile(DEFAULT_PROFILE)
  if (existsSync(preferred)) return preferred
  try {
    const profilesDir = join(dshHome(), 'profiles')
    for (const name of readdirSync(profilesDir)) {
      const candidate = patchPathForProfile(name)
      if (!existsSync(candidate)) continue
      if (readFileSync(candidate, 'utf8').includes(MCP_CLIENT_PKG)) return candidate
    }
  } catch {
    /* profiles 目录不存在：按默认路径处理 */
  }
  return preferred
}

/** 同步包里的一个 MCP 条目。 */
export interface GatheredMcpEntry {
  serverName: string
  entryId: string
  /** 条目原文块（含 `- id:` 首行与其下缩进正文，行尾统一为 \n）。 */
  block: string
}

/** 同步包里的 MCP 配置段。 */
export interface GatheredMcp {
  entries: GatheredMcpEntry[]
  /** 采集来源的 profile 名（还原时优先写回同一 profile）。 */
  profile?: string
}

/** 扫描结果：条目原文 + 在文件中的行位置（编辑定位用）。 */
export interface McpEntryBlock extends GatheredMcpEntry {
  /** 首行 `- id:` 的缩进空格数。 */
  indent: number
  startLine: number
  endLine: number
}

/** 行首缩进宽度（tab 按 1 计，够用：本文件历来只有空格缩进）。 */
function indentWidth(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0
}

/**
 * 块的结束行：从 startLine 往下，遇到「非空且缩进 <= indent」的行即止。
 * 块内空行不算结束（YAML 允许条目内空行），但要记住最后一个有内容的行。
 */
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

/**
 * 扫描补丁文件里的全部 mcp-client 条目。
 *
 * 判据与 mcp-status.ts 的 scanPatchEntries 同源：`- id:` 开头的条目块里同时有
 * `name: …@deepseek-ai/dsh-mcp-client` 与 `serverName: …`。区别是这里保留
 * **整块原文**，因为同步要能把它原样搬到另一台机器。
 */
export function scanMcpEntries(content: string): McpEntryBlock[] {
  if (content === '') return []
  const lines = content.split(/\r?\n/)
  const out: McpEntryBlock[] = []
  for (let i = 0; i < lines.length; i += 1) {
    // 行尾允许跟注释（真实 patch 里 `- id: xxx # 说明` 很常见）
    const idMatch = /^(\s*)- id:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*(?:#.*)?$/.exec(lines[i])
    if (idMatch === null) continue
    const indent = idMatch[1].length
    const end = blockEnd(lines, i, indent)
    const blockLines = lines.slice(i, end + 1)
    const nameLine = blockLines.find((line) => /^\s*name:\s*/.test(line))
    if (nameLine === undefined || !nameLine.includes(MCP_CLIENT_PKG)) continue
    let serverName = ''
    for (const line of blockLines) {
      const match = /^\s*serverName:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*(?:#.*)?$/.exec(line)
      if (match !== null) { serverName = match[1]; break }
    }
    if (serverName === '') continue
    out.push({
      serverName,
      entryId: idMatch[2],
      indent,
      startLine: i,
      endLine: end,
      block: blockLines.join('\n'),
    })
  }
  return out
}

/** 读本机补丁文件里的 MCP 条目（同步包中的 mcp 段）。 */
export function gatherMcpEntries(): GatheredMcp {
  const path = resolvePatchPath()
  const profile = basename(dirname(path))
  if (!existsSync(path)) return { entries: [], profile }
  let content = ''
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return { entries: [], profile }
  }
  const entries = scanMcpEntries(content).map((entry) => ({
    serverName: entry.serverName,
    entryId: entry.entryId,
    block: entry.block,
  }))
  return { entries, profile }
}

/** 本机 MCP 条目的规模（状态面板显示用）。 */
export function mcpPatchSummary(): { path: string; count: number; bytes: number } {
  const path = resolvePatchPath()
  if (!existsSync(path)) return { path, count: 0, bytes: 0 }
  try {
    const entries = scanMcpEntries(readFileSync(path, 'utf8'))
    return {
      path,
      count: entries.length,
      bytes: entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.block, 'utf8'), 0),
    }
  } catch {
    return { path, count: 0, bytes: 0 }
  }
}

/** 把条目块整体重排到目标缩进（保持块内相对缩进不变）。 */
function reindentBlock(block: string, targetIndent: number): string[] {
  const rows = block.split('\n')
  const first = rows[0] ?? ''
  const delta = targetIndent - indentWidth(first)
  if (delta === 0) return rows
  return rows.map((row) => {
    if (row.trim() === '') return row
    if (delta > 0) return ' '.repeat(delta) + row
    const strip = Math.min(-delta, indentWidth(row))
    return row.slice(strip)
  })
}

/** 容器块的结束行（0 缩进行 / 空行即止），与 mcp-status 的删除逻辑同款。 */
function containerEnd(lines: string[], startLine: number): number {
  for (let j = startLine + 1; j < lines.length; j += 1) {
    const line = lines[j]
    if (line.length === 0) return j
    if (!/^[ \t]/.test(line)) return j
  }
  return lines.length
}

/**
 * 找一个可复用的 insert 容器：本机已有的、包含 mcp-client 条目的 `- insert:`。
 * 返回容器内最后一个条目的块尾行与条目缩进；没有则 null（调用方新建容器）。
 */
function findInsertAnchor(lines: string[]): { afterLine: number; indent: number } | null {
  const entries = scanMcpEntries(lines.join('\n'))
  for (const entry of entries) {
    let containerLine = -1
    for (let k = entry.startLine - 1; k >= 0; k -= 1) {
      if (lines[k].trimStart().startsWith('- ')) { containerLine = k; break }
    }
    if (containerLine < 0) continue
    if (!lines[containerLine].trimStart().startsWith('- insert:')) continue
    const end = containerEnd(lines, containerLine)
    let lastEnd = entry.endLine
    for (const other of entries) {
      if (other.startLine > containerLine && other.endLine < end) lastEnd = Math.max(lastEnd, other.endLine)
    }
    return { afterLine: lastEnd, indent: entry.indent }
  }
  return null
}

/** 原子写文本（Windows 上 rename 覆盖会 EPERM，先 unlink）。 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${String(Date.now())}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    try { unlinkSync(path) } catch {}
    renameSync(tmp, path)
  }
}

/**
 * 把云端包里的 MCP 条目合并回本机补丁文件。
 *
 * - 同名 serverName：用云端块替换本机块（开关状态 disabled 随块一起过来）；
 * - 本机缺失：优先追加到已有的 mcp insert 容器末尾，没有就新建 `- insert:`；
 * - 本机独有的条目：原样保留（不删）。
 */
export function restoreMcpEntries(mcp: GatheredMcp | undefined): { added: number; updated: number; kept: number } {
  if (mcp === undefined || !Array.isArray(mcp.entries) || mcp.entries.length === 0) {
    return { added: 0, updated: 0, kept: 0 }
  }
  const profile = typeof mcp.profile === 'string' && mcp.profile !== '' ? mcp.profile : DEFAULT_PROFILE
  const path = patchPathForProfile(profile)
  const existed = existsSync(path)
  let content = ''
  if (existed) {
    try { content = readFileSync(path, 'utf8') } catch { content = '' }
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  let lines = content === '' ? [] : content.split(/\r?\n/)
  let added = 0
  let updated = 0

  for (const entry of mcp.entries) {
    if (typeof entry?.block !== 'string' || entry.block.trim() === '') continue
    const local = scanMcpEntries(lines.join('\n')).find((item) => item.serverName === entry.serverName)
    if (local !== undefined) {
      const replacement = reindentBlock(entry.block, local.indent)
      lines = [...lines.slice(0, local.startLine), ...replacement, ...lines.slice(local.endLine + 1)]
      updated += 1
      continue
    }
    const anchor = findInsertAnchor(lines)
    if (anchor !== null) {
      lines.splice(anchor.afterLine + 1, 0, ...reindentBlock(entry.block, anchor.indent))
    } else {
      if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') lines.push('')
      if (lines.length === 0) lines.push('# 由 dsh-seeker-bot 工作台同步恢复的 MCP 配置')
      lines.push('- insert:', ...reindentBlock(entry.block, NEW_ENTRY_INDENT))
    }
    added += 1
  }

  const next = lines.join(eol)
  const before = scanMcpEntries(content).length
  if (next !== content) {
    // 写不进去就抛错：静默失败会让用户以为「MCP 已恢复」，实际 patch 文件没变。
    mkdirSync(dirname(path), { recursive: true })
    if (existed) copyFileSync(path, path + BACKUP_SUFFIX)
    atomicWrite(path, next)
  }
  return { added, updated, kept: Math.max(0, before - updated) }
}
