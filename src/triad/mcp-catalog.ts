/**
 * mcp-catalog — 「连接器」工作台的宿主侧。
 *
 * 三件事：
 *  1. GET  /api/triad/mcp-catalog          读出随包分发的精选目录
 *  2. GET  /api/chat-flow/mcp-icons/<file> 把自托管图标以正确 MIME 吐给浏览器
 *  3. POST /api/triad/mcp-catalog/install  一键安装：写 cordis.patch.yml 里的
 *                                          @deepseek-ai/dsh-mcp-client 实例
 *
 * 为什么目录走随包静态文件而不是在线市场：
 * 主流开源 agent（Cline 用 cline.github.io/marketplace/catalog.json、Hermes 用仓库里
 * 的 optional-mcps/）全部是「自建精选 + 人工审核」，没有一家接第三方全量市场。
 * 我们也照这个来：目录进仓库，图标自托管，条目数控制在几十条并逐条验过包能装。
 *
 * 为什么图标不走 base64 内联：
 * 56 个图标合计约 700KB，内联进 client 产物会让每次冷启动都多传一份；走独立路由
 * 后是浏览器原生图片加载 + 长缓存，且只有真正打开连接器页才拉。
 *
 * 安装为什么写 cordis.patch.yml：
 * 与 src/triad/mcp-status.ts 的启停/删除同源——同一个文件、同一种条目、同一套
 * 语义（serverName 唯一、disabled 标记）。面板里已装的条目立刻能看到新装的。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { setGateDefaultEnabled } from '../tools-gate/index.ts'

const CATALOG_ROUTE = '/api/triad/mcp-catalog'
const ICON_ROUTE = '/api/chat-flow/mcp-icons'
const MCP_CLIENT_PKG = '@deepseek-ai/dsh-mcp-client'
const PROFILE_NAME = 'web'
const BACKUP_SUFFIX = '.bak-last-install'

/** 目录条目里声明的环境变量字段。 */
export interface CatalogEnvField {
  name: string
  required?: boolean
  label?: string
  secret?: boolean
  url?: string
}

/**
 * 「点一下就开始授权」的声明（目前只有 Gmail 这类需要本地 OAuth 回调的条目用）。
 *
 * 为什么要声明在目录里而不是让前端传命令：spawn 一个进程是敏感操作，
 * 能跑什么必须由随包分发的目录决定，前端只能点「对这条执行它的授权」。
 */
export interface CatalogAuthorize {
  /** 可执行文件（只认白名单里的 npx / uvx / node）。 */
  command: string
  /** 参数。 */
  args?: string[]
  /** 必须先存在的文件（支持 ~ 展开）；没有就不启动，直接提示去准备。 */
  requiresFile?: string
  /** 那个文件是什么（给用户看的名字）。 */
  requiresLabel?: string
  /** 去哪拿这个文件。 */
  setupUrl?: string
  /** 授权命令会自己开浏览器，完成后凭据写到哪里（提示语用）。 */
  doneHint?: string
}

/** 插件条目：type='plugin' 时直接写进 patch 的 cordis 插件行，不走 mcp-client。 */
export interface CatalogPluginEntry {
  /** loader 条目 id（patch 里 `- id:` 的值，全局唯一）。 */
  id: string
  /** npm 包名（`@deepseek-ai/...`）。 */
  name: string
  /** 可选 config 段（扁平键值）。 */
  config?: Record<string, string | number | boolean>
}

/** 安装方式：本地 stdio、远程 streamable-http，或 DSH 官方插件（cordis 条目）。 */
export interface CatalogInstall {
  type: 'stdio' | 'http' | 'plugin'
  command?: string
  args?: string[]
  url?: string
  env?: CatalogEnvField[]
  auth?: string
  /**
   * type='plugin'：要写进 patch 的插件条目（通常两条：本体 + 提供方）。
   *
   * 为什么不复用 mcp-client：官方 browser-use / computer-use 是 cordis 插件，
   * 各自注册 `browserUse` / `computerUse` 服务与一批工具，而不是一个 MCP
   * server 进程。用 mcp-client 包一层既起不来也拿不到它们的系统权限。
   */
  entries?: CatalogPluginEntry[]
  /** type='plugin'：安装前必须已经在 profile 里装好的 npm 包（缺了就提示，不假装能装）。 */
  requiresPackages?: string[]
}

/** 目录条目（字段与 assets/mcp-catalog/catalog.json 对齐）。 */
export interface CatalogEntry {
  id: string
  name: string
  nameEn?: string
  tagline?: string
  description?: string
  category?: string
  region?: 'cn' | 'global'
  author?: string
  repo?: string
  install: CatalogInstall
  /** 可选的「点一下开始授权」声明。 */
  authorize?: CatalogAuthorize
  iconFile?: string
  iconMime?: string
  verified?: boolean
  featured?: boolean
}

/** 目录文件整体形状。 */
export interface CatalogFile {
  version: number
  generatedAt: string
  counts: { total: number; cn: number; global: number }
  categories: Array<{ id: string; label: string; count: number }>
  entries: CatalogEntry[]
}

function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

function patchFilePath(): string {
  return join(dshHome(), 'profiles', PROFILE_NAME, 'cordis.patch.yml')
}

/**
 * 解析包根下的资产绝对路径。
 * 兼容 esbuild 单文件产物（.. 即包根）与 tsc 保留目录结构（../.. 才是包根）。
 */
function resolveAsset(rel: string): string | null {
  const candidates = [
    join(fileURLToPath(new URL('..', import.meta.url)), ...rel.split('/')),
    join(fileURLToPath(new URL('../..', import.meta.url)), ...rel.split('/')),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

let catalogCache: { at: number; value: CatalogFile } | null = null
const CATALOG_TTL_MS = 60 * 1000

/** 读目录（1 分钟内复用；文件随包固定，缓存只是省 IO）。 */
function readCatalog(): CatalogFile | null {
  if (catalogCache !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
  const path = resolveAsset('assets/mcp-catalog/catalog.json')
  if (path === null) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as CatalogFile
    catalogCache = { at: Date.now(), value }
    return value
  } catch {
    return null
  }
}

/**
 * 按 id 精确取目录条目（Bot 主动推荐连接器时用）。
 *
 * 为什么保持入参顺序：模型给的顺序就是它认为的推荐优先级（最该连的排最前），
 * 按目录顺序重排等于把那个判断丢掉，卡片第一行可能变成最不相关的那条。
 *
 * 未知 id 静默丢弃而不是报错：模型可能记错名字、也可能自己编一个，报错会让它
 * 以为工具坏了、下次干脆不推荐。少一条比一张报错卡片好。
 */
export function findCatalogEntries(ids: readonly string[]): CatalogEntry[] {
  if (ids.length === 0) return []
  const catalog = readCatalog()
  if (catalog === null) return []
  const byId = new Map<string, CatalogEntry>()
  for (const entry of catalog.entries) byId.set(entry.id, entry)
  const found: CatalogEntry[] = []
  for (const id of ids) {
    const entry = byId.get(id)
    if (entry !== undefined) found.push(entry)
  }
  return found
}

/** 图标精确文件名表（只认目录里出现过的文件名，杜绝路径穿越）。 */
function iconFiles(): Set<string> {
  const catalog = readCatalog()
  const set = new Set<string>()
  for (const entry of catalog?.entries ?? []) {
    if (typeof entry.iconFile === 'string' && entry.iconFile !== '') set.add(entry.iconFile)
  }
  return set
}

/* ───────────────────────── 安装：写 cordis.patch.yml ───────────────────────── */

/** YAML 标量转义（单引号风格，内部单引号翻倍）。 */
function yamlString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/** serverName 必须匹配 [A-Za-z0-9_-]{1,32}；目录 id 里有点号的统一换成短横线。 */
function toServerName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32)
}

/** 已装条目的块信息（供去重、覆盖更新、卸载与回填表单使用）。 */
interface InstalledEntry {
  serverName: string
  /** 条目块首行（- id: 那一行）。 */
  idLine: number
  /** 条目块结束行（不含）。 */
  blockEnd: number
  /** 所属 insert 容器起始行；-1 表示没有容器。 */
  insertLine: number
  /** 该 insert 容器内的条目数（用于判断删完要不要连容器一起删）。 */
  insertItemCount: number
  /** 条目里已写入的 env（前端据此把密钥回填进输入框）。 */
  env: Record<string, string>
}

/**
 * 扫描 patch 里的 mcp-client 条目块。
 *
 * 块边界：从 - id: 行往下，遇到 0 缩进行或同级 - 行为止 —— 与 mcp-status.ts 的
 * 删除逻辑同一判据。两处必须一致，否则会出现「面板删得掉、市场删不掉」。
 */
function scanInstalledEntries(content: string): Map<string, InstalledEntry> {
  const lines = content.split(/\r?\n/)
  const map = new Map<string, InstalledEntry>()
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trimStart()
    if (!trimmed.startsWith('- id:')) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.trim() === '') continue
      if (!/^[ \t]/.test(line)) { end = j; break }
      if (line.trimStart().startsWith('- ')) { end = j; break }
    }
    let isMcp = false
    let serverName = ''
    const env: Record<string, string> = {}
    let inEnv = false
    let envIndent = 0
    for (let j = i + 1; j < end; j += 1) {
      const raw = lines[j]
      const line = raw.trimStart()
      const indent = raw.length - line.length
      if (line.startsWith('name:') && line.includes(MCP_CLIENT_PKG)) isMcp = true
      const m = /^serverName:\s*([A-Za-z0-9_-]+)/.exec(line)
      if (m !== null && serverName === '') serverName = m[1]
      if (line.trim() === 'env:') { inEnv = true; envIndent = indent; continue }
      if (inEnv) {
        if (indent <= envIndent) { inEnv = false; continue }
        const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
        if (kv !== null) {
          let value = kv[2].trim()
          if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'")
          else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
          env[kv[1]] = value
        }
      }
    }
    if (!isMcp || serverName === '') continue
    let insertLine = -1
    for (let k = i - 1; k >= 0; k -= 1) {
      if (lines[k].trim() === '') continue
      if (/^[ \t]/.test(lines[k])) continue
      if (lines[k].trimStart().startsWith('- insert:')) insertLine = k
      break
    }
    let insertItemCount = 0
    if (insertLine >= 0) {
      for (let k = insertLine + 1; k < lines.length; k += 1) {
        const line = lines[k]
        if (line.trim() === '') continue
        if (!/^[ \t]/.test(line)) break
        if (line.trimStart().startsWith('- ')) insertItemCount += 1
      }
    }
    map.set(serverName, { serverName, idLine: i, blockEnd: end, insertLine, insertItemCount, env })
  }
  return map
}

/**
 * 从 patch 里删掉一个条目块（连同它的注释抬头与只剩一条的 insert 容器）。
 *
 * 为什么要连容器一起删：我们生成的是「一条 insert 只装一个条目」的形态，
 * 只删条目会留下一个空的 - insert:，下次启动 loader 会抱怨空插入块。
 */
function removeEntryBlock(content: string, entry: InstalledEntry): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  let from = entry.idLine
  let to = entry.blockEnd
  if (entry.insertLine >= 0 && entry.insertItemCount === 1) {
    from = entry.insertLine
    let end = lines.length
    for (let j = entry.insertLine + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === '') { end = j; break }
      if (!/^[ \t]/.test(lines[j])) { end = j; break }
    }
    to = end
  }
  // 把紧贴在上方的两行注释与本块前的空行一并带走，避免留下孤儿注释
  let start = from
  while (start > 0 && /^#\s*(MCP 连接器|卸载：)/.test(lines[start - 1].trim())) start -= 1
  if (start > 0 && lines[start - 1].trim() === '') start -= 1
  lines.splice(start, to - start)
  return lines.join(eol)
}

/* ─────────────────── 官方插件条目（type='plugin'）─────────────────── */

/** patch 里一条已存在的插件条目。 */
interface InstalledPluginEntry {
  id: string
  /** `- id:` 行号。 */
  startLine: number
  /** 条目块结束行（不含）。 */
  endLine: number
  /** 所属 insert 容器起始行；-1 表示没有容器。 */
  insertLine: number
}

/**
 * 扫描 patch 里的官方插件条目（只认传入的 id 白名单）。
 *
 * 为什么不复用 scanInstalledEntries：那个只认 `name: '@deepseek-ai/dsh-mcp-client'`
 * 的条目。官方插件行没有 mcp-client 包装，是 `- id: computer-use` +
 * `name: '@deepseek-ai/dsh-computer-use'` 的裸形态，扫描判据完全不同。
 *
 * 白名单是必须的：patch 里到处是 `- id: xxx` 形式的条目（ui-settings-general、
 * agent-default-model 等），不按目录声明的 id 过滤会把它们当成连接器条目删掉。
 */
function scanPluginEntries(content: string, ids: ReadonlySet<string>): Map<string, InstalledPluginEntry> {
  const lines = content.split(/\r?\n/)
  const map = new Map<string, InstalledPluginEntry>()
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^\s*-\s*id:\s*([A-Za-z0-9_-]+)\s*$/.exec(lines[i])
    if (head === null) continue
    const id = head[1]!
    if (!ids.has(id)) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!
      if (line.trim() === '') continue
      if (!/^[ \t]/.test(line)) { end = j; break }
      if (line.trimStart().startsWith('- ')) { end = j; break }
    }
    let insertLine = -1
    for (let k = i - 1; k >= 0; k -= 1) {
      if (lines[k]!.trim() === '') continue
      if (/^[ \t]/.test(lines[k]!)) continue
      if (lines[k]!.trimStart().startsWith('- insert:')) insertLine = k
      break
    }
    map.set(id, { id, startLine: i, endLine: end, insertLine })
  }
  return map
}

/** 数一个 insert 容器里的条目数。 */
function countInsertItems(lines: readonly string[], insertLine: number): number {
  let count = 0
  for (let k = insertLine + 1; k < lines.length; k += 1) {
    const line = lines[k]!
    if (line.trim() === '') continue
    if (!/^[ \t]/.test(line)) break
    if (line.trimStart().startsWith('- ')) count += 1
  }
  return count
}

/** 一个 insert 容器的结束行（不含）。 */
function insertBlockEnd(lines: readonly string[], insertLine: number): number {
  for (let j = insertLine + 1; j < lines.length; j += 1) {
    const line = lines[j]!
    if (line.trim() === '') return j
    if (!/^[ \t]/.test(line)) return j
  }
  return lines.length
}

/**
 * 从 patch 里摘掉指定的官方插件条目。
 *
 * 两种情况：
 *  - 条目所在的 insert 块**全部**都是要删的条目 → 连块带抬头注释一起删
 *    （留下空 `- insert:` 会让 loader 抱怨空插入块）；
 *  - 块里还有别的条目 → 只删这几行，容器留着。
 *
 * 从后往前删，避免前面的行号被前面的 splice 带偏。
 */
function removePluginEntries(content: string, ids: ReadonlySet<string>): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const found = scanPluginEntries(content, ids)
  if (found.size === 0) return content

  // 按 insert 容器分组
  const byInsert = new Map<number, InstalledPluginEntry[]>()
  for (const item of found.values()) {
    const list = byInsert.get(item.insertLine) ?? []
    list.push(item)
    byInsert.set(item.insertLine, list)
  }

  const ranges: Array<{ from: number; to: number; keep?: string[] }> = []
  for (const [insertLine, items] of byInsert) {
    if (insertLine < 0) {
      for (const item of items) ranges.push({ from: item.startLine, to: item.endLine })
      continue
    }
    if (countInsertItems(lines, insertLine) === items.length) {
      // 整个块都要删：把紧贴上方的注释与空行一并带走。
      //
      // 但块**内部**的注释要留下：用户在这段里手写过恢复说明（换后端怎么配、
      // 依赖装回来要几步），删掉就再也找不回来了。注释留在原位不影响 loader
      // （YAML 注释不参与解析），比「干净」重要。
      const to = insertBlockEnd(lines, insertLine)
      const kept = lines.slice(insertLine + 1, to).filter((line) => /^\s*#/.test(line))
      let from = insertLine
      while (from > 0 && /^#/.test(lines[from - 1]!.trim())) from -= 1
      if (from > 0 && lines[from - 1]!.trim() === '') from -= 1
      ranges.push(kept.length > 0 ? { from, to, keep: kept } : { from, to })
    } else {
      for (const item of items) ranges.push({ from: item.startLine, to: item.endLine })
    }
  }

  ranges.sort((a, b) => b.from - a.from)
  for (const range of ranges) lines.splice(range.from, range.to - range.from, ...(range.keep ?? []))
  return lines.join(eol)
}

/**
 * 生成一条 mcp-client 条目（4 空格缩进，挂在 insert 块下）。
 *
 * ⚠ 字段必须包在 config: 下。cordis 的 loader 只把 config 段传给插件的 apply
 * 第二参；平铺在条目里的字段会被丢掉，apply 收到 undefined，插件启动即抛
 * "Cannot read properties of undefined (reading 'reconnect')" —— 条目看着加载了，
 * 但一个工具都注册不上。
 */
function buildEntryYaml(entry: CatalogEntry, serverName: string, envValues: Record<string, string>): string {
  const lines: string[] = []
  const inst = entry.install
  lines.push('    - id: mcp-' + serverName)
  lines.push('      name: ' + yamlString(MCP_CLIENT_PKG))
  lines.push('      config:')
  if (inst.type === 'http' && typeof inst.url === 'string' && inst.url !== '') {
    lines.push('        transport: streamable-http')
    lines.push('        serverName: ' + serverName)
    lines.push('        url: ' + yamlString(inst.url))
  } else {
    lines.push('        transport: stdio')
    lines.push('        serverName: ' + serverName)
    lines.push('        command: ' + yamlString(inst.command ?? 'npx'))
    const args = (inst.args ?? []).map((arg) => yamlString(arg))
    lines.push('        args: [' + args.join(', ') + ']')
    const envKeys = Object.keys(envValues)
    if (envKeys.length > 0) {
      lines.push('        env:')
      for (const key of envKeys) lines.push('          ' + key + ': ' + yamlString(envValues[key]!))
    }
  }
  lines.push('        failOnStartupError: false')
  return lines.join('\n')
}

/** YAML 标量：字符串走单引号转义，布尔/数字原样输出。 */
function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'string') return yamlString(value)
  return String(value)
}

/**
 * 生成一条 cordis 插件条目（官方包，不是 mcp-client）。
 *
 * 形态与用户手工 insert 的一致：
 *     - id: computer-use
 *       name: '@deepseek-ai/dsh-computer-use'
 */
function buildPluginYaml(plugin: CatalogPluginEntry): string {
  const lines: string[] = []
  lines.push('    - id: ' + plugin.id)
  lines.push('      name: ' + yamlString(plugin.name))
  if (plugin.config !== undefined) {
    lines.push('      config:')
    for (const [key, value] of Object.entries(plugin.config)) {
      lines.push('        ' + key + ': ' + yamlScalar(value))
    }
  }
  return lines.join('\n')
}

export interface InstallResult {
  ok: boolean
  error?: string
  serverName?: string
  alreadyInstalled?: boolean
  /** 本次是覆盖更新（已装过、参数被改写）。 */
  updated?: boolean
  /** 条目里当前写入的 env（前端用来回填输入框）。 */
  env?: Record<string, string>
  patchFile?: string
  /**
   * 写入后是否需要重启宿主才生效。
   *
   * 实测：web profile 的 patchReload 是 live，增删 mcp-client 条目后 loader 会在
   * 3–4 秒内重新应用 patch，`/api/triad/mcp-status` 的 serverCount 立刻跟着变，
   * **不需要重启**。保留这个字段只为兼容旧前端与将来 patchReload 被关掉的情况。
   */
  needsRestart?: boolean
}

/** 一键安装：校验参数 → 去重 → 备份 → 追加 insert 块。 */
function installEntry(body: { id?: unknown; env?: unknown; overwrite?: unknown }): InstallResult {
  const id = typeof body.id === 'string' ? body.id : ''
  if (id === '') return { ok: false, error: 'id required' }
  const catalog = readCatalog()
  if (catalog === null) return { ok: false, error: 'catalog missing from package' }
  const entry = catalog.entries.find((item) => item.id === id)
  if (entry === undefined) return { ok: false, error: 'unknown connector: ' + id }

  // 官方插件类条目走另一条落地路径：写 cordis 插件行，不是 mcp-client 实例。
  if (entry.install.type === 'plugin') return installPluginEntry(entry, body.overwrite === true)

  const serverName = toServerName(entry.id)
  const envValues: Record<string, string> = {}
  const inputEnv = (body.env ?? {}) as Record<string, unknown>
  for (const field of entry.install.env ?? []) {
    const raw = inputEnv[field.name]
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') {
      if (field.required === true) return { ok: false, error: 'missing required field: ' + (field.label ?? field.name) }
      continue
    }
    envValues[field.name] = value
  }

  // 配置里带双花括号占位符的：{{VAR}} 用 env 值替换，{{PLUGIN_DIR}} 换成插件包根目录
  // （随包分发的本地 MCP server 要靠它拼出绝对路径，DSH 的 stdio 配置不认相对路径）。
  const pluginDir = (() => {
    try {
      // 末尾的分隔符要去掉：拼 '{{PLUGIN_DIR}}/assets/x' 时否则会出现 "D:\a\b\/assets"
      return fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
    } catch {
      return ''
    }
  })()
  const resolved: CatalogEntry = { ...entry, install: { ...entry.install } }
  if (Array.isArray(entry.install.args)) {
    resolved.install.args = entry.install.args.map((arg) =>
      arg
        .replace(/\{\{PLUGIN_DIR\}\}/g, pluginDir)
        .replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (all, key: string) => envValues[key] ?? all))
  }

  const patchPath = patchFilePath()
  let content = ''
  if (existsSync(patchPath)) {
    content = readFileSync(patchPath, 'utf8')
  } else {
    mkdirSync(dirname(patchPath), { recursive: true })
    content = '# DSH web profile patch（由 dsh-seeker-bot 连接器市场创建）\n'
  }

  const installed = scanInstalledEntries(content)
  const existing = installed.get(serverName)
  // 已装且没要求覆盖：原样返回，前端据此把按钮切成「已安装」
  if (existing !== undefined && body.overwrite !== true) {
    return { ok: true, serverName, alreadyInstalled: true, patchFile: patchPath, env: existing.env }
  }
  // 覆盖更新：先把旧块摘掉再追加，避免同一 serverName 出现两条
  const base = existing !== undefined ? removeEntryBlock(content, existing) : content

  const eol = base.includes('\r\n') ? '\r\n' : '\n'
  const block = [
    '',
    '# MCP 连接器：' + entry.name + '（dsh-seeker-bot 连接器市场安装）',
    '# 卸载：删除下面整个 insert 块。',
    '- insert:',
    buildEntryYaml(resolved, serverName, envValues),
    '',
  ].join(eol)

  try {
    if (existsSync(patchPath)) copyFileSync(patchPath, patchPath + BACKUP_SUFFIX)
    writeFileSync(patchPath, base.replace(/\s*$/, '') + eol + block, 'utf8')
  } catch (error) {
    return { ok: false, error: 'write failed: ' + (error instanceof Error ? error.message : String(error)) }
  }
  catalogCache = null
  return { ok: true, serverName, updated: existing !== undefined, env: envValues, patchFile: patchPath, needsRestart: false }
}

/* ─────────────────── 官方插件类条目的安装 / 卸载 ─────────────────── */

/** profile 的 node_modules 根（与 patch 同一个 profile）。 */
function profileModulesDir(): string {
  return join(dshHome(), 'profiles', PROFILE_NAME, 'node_modules')
}

/** 检查哪些官方包在 profile 里还没装（连接器不替用户装包，只如实提示）。 */
function missingPackages(packages: readonly string[]): string[] {
  const missing: string[] = []
  for (const pkg of packages) {
    if (!existsSync(join(profileModulesDir(), ...pkg.split('/'), 'package.json'))) missing.push(pkg)
  }
  return missing
}

/**
 * 安装一条官方插件类条目：把它的 cordis 插件行写进 patch。
 *
 * 与 mcp-client 条目的三点差别：
 *  1. 已装判定看 patch 里有没有**同 id 的插件行**（用户可能已经手工 insert 过，
 *     再写一次会 duplicate loader entry id 直接崩）；
 *  2. 包缺失时拒绝并说清缺哪个 —— 官方这些包不在 npm 公开源发最新版，
 *     连接器没法替用户装，只能提示；
 *  3. 装完顺手把闸门部署默认打开：否则插件在跑、工具却被挡在请求之外，
 *     用户会得到「装了但模型看不见」的哑状态。
 */
function installPluginEntry(entry: CatalogEntry, overwrite: boolean): InstallResult {
  const plugins = entry.install.entries ?? []
  if (plugins.length === 0) return { ok: false, error: 'plugin entry declares no entries' }

  const missing = missingPackages(entry.install.requiresPackages ?? [])
  if (missing.length > 0) {
    return {
      ok: false,
      error: '这个能力要先装好官方包：' + missing.join('、')
        + '。在 profile 目录执行 `dsh plugin add <包名>`（或 npm i）后再点安装。',
    }
  }

  const patchPath = patchFilePath()
  let content = ''
  if (existsSync(patchPath)) {
    content = readFileSync(patchPath, 'utf8')
  } else {
    mkdirSync(dirname(patchPath), { recursive: true })
    content = '# DSH web profile patch（由 dsh-seeker-bot 连接器市场创建）\n'
  }

  const ids = new Set(plugins.map((plugin) => plugin.id))
  const installed = scanPluginEntries(content, ids)
  const pending = plugins.filter((plugin) => !installed.has(plugin.id))

  if (pending.length === 0 && !overwrite) {
    setGateDefaultEnabled(entry.id, true)
    return { ok: true, serverName: toServerName(entry.id), alreadyInstalled: true, patchFile: patchPath }
  }

  // 覆盖更新：先把已存在的同 id 条目摘掉再重写（config 可能变了）
  const base = overwrite && installed.size > 0 ? removePluginEntries(content, ids) : content
  const eol = base.includes('\r\n') ? '\r\n' : '\n'
  const block = [
    '',
    '# DSH 官方能力：' + entry.name + '（dsh-seeker-bot 连接器市场安装）',
    '# 卸载：在连接器面板里点卸载，或删除下面整个 insert 块。',
    '- insert:',
    ...pending.map(buildPluginYaml),
    '',
  ].join(eol)

  try {
    if (existsSync(patchPath)) copyFileSync(patchPath, patchPath + BACKUP_SUFFIX)
    writeFileSync(patchPath, base.replace(/\s*$/, '') + eol + block, 'utf8')
  } catch (error) {
    return { ok: false, error: 'write failed: ' + (error instanceof Error ? error.message : String(error)) }
  }
  catalogCache = null
  setGateDefaultEnabled(entry.id, true)
  return {
    ok: true,
    serverName: toServerName(entry.id),
    updated: installed.size > 0,
    patchFile: patchPath,
    needsRestart: false,
  }
}

/** 卸载一条官方插件类条目：把它的 cordis 插件行从 patch 里摘掉。 */
function uninstallPluginEntry(entry: CatalogEntry): InstallResult {
  const ids = new Set((entry.install.entries ?? []).map((plugin) => plugin.id))
  const patchPath = patchFilePath()
  if (!existsSync(patchPath)) return { ok: false, error: 'patch file not found' }
  const content = readFileSync(patchPath, 'utf8')
  if (scanPluginEntries(content, ids).size === 0) return { ok: false, error: 'not installed: ' + entry.id }
  try {
    copyFileSync(patchPath, patchPath + BACKUP_SUFFIX)
    writeFileSync(patchPath, removePluginEntries(content, ids), 'utf8')
  } catch (error) {
    return { ok: false, error: 'write failed: ' + (error instanceof Error ? error.message : String(error)) }
  }
  catalogCache = null
  setGateDefaultEnabled(entry.id, false)
  return { ok: true, serverName: toServerName(entry.id), patchFile: patchPath, needsRestart: false }
}

/**
 * 某条官方插件类条目当前是否已写进 patch。
 *
 * 给 host 启动时定闸门默认值用：装了 → 默认注入工具，没装 → 继续挡在请求外。
 * 目录读不到、patch 不存在、条目不是 plugin 类，一律 false（失败即「没装」，
 * 宁可少占上下文也不误开）。
 */
export function isPluginInstalled(id: string): boolean {
  const catalog = readCatalog()
  const entry = catalog?.entries.find((item) => item.id === id)
  if (entry === undefined || entry.install.type !== 'plugin') return false
  const ids = new Set((entry.install.entries ?? []).map((plugin) => plugin.id))
  if (ids.size === 0) return false
  const patchPath = patchFilePath()
  if (!existsSync(patchPath)) return false
  try {
    return scanPluginEntries(readFileSync(patchPath, 'utf8'), ids).size === ids.size
  } catch {
    return false
  }
}

/** 卸载：把该条目的 mcp-client 块从 patch 里摘掉。 */
function uninstallEntry(body: { id?: unknown }): InstallResult {
  const id = typeof body.id === 'string' ? body.id : ''
  if (id === '') return { ok: false, error: 'id required' }
  const catalog = readCatalog()
  const catalogEntry = catalog?.entries.find((item) => item.id === id)
  if (catalogEntry !== undefined && catalogEntry.install.type === 'plugin') return uninstallPluginEntry(catalogEntry)
  const serverName = toServerName(id)
  const patchPath = patchFilePath()
  if (!existsSync(patchPath)) return { ok: false, error: 'patch file not found' }
  const content = readFileSync(patchPath, 'utf8')
  const existing = scanInstalledEntries(content).get(serverName)
  if (existing === undefined) return { ok: false, error: 'not installed: ' + id }
  try {
    copyFileSync(patchPath, patchPath + BACKUP_SUFFIX)
    writeFileSync(patchPath, removeEntryBlock(content, existing), 'utf8')
  } catch (error) {
    return { ok: false, error: 'write failed: ' + (error instanceof Error ? error.message : String(error)) }
  }
  return { ok: true, serverName, patchFile: patchPath, needsRestart: false }
}

/** 授权命令白名单（spawn 是敏感操作，只认这几个）。 */
const ALLOWED_AUTH_COMMANDS = new Set(['npx', 'uvx', 'node', 'python', 'python3', 'mcp-remote', 'agently-cli'])

export interface AuthorizeResult {
  ok: boolean
  /** 已拉起授权进程。 */
  started?: boolean
  /** 前置文件缺失，需要用户先准备。 */
  needsSetup?: boolean
  requiresFile?: string
  requiresLabel?: string
  setupUrl?: string
  message?: string
}

/** 展开 ~ 开头的主目录路径。 */
function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1).replace(/^[\\/]/, '')) : path
}

/**
 * 点一下开始授权：spawn 目录里声明的那条命令，让它在后台把浏览器弹出来。
 *
 * 为什么只能跑目录声明的命令：前端能传的只有一个 id，命令、参数、前置文件
 * 全部来自随包分发的 catalog.json。否则这就是一个「任意命令执行」接口。
 *
 * 为什么 detached + stdio:ignore：授权命令自己会开浏览器、自己起本地回调端口，
 * 然后一直挂着等回调；被 DSH 的进程树管着的话，DSH 一退出它就断，用户回来
 * 看不到结果。detached + unref 让它独立跑完。
 */
function authorizeEntry(body: { id?: unknown }): AuthorizeResult {
  const id = typeof body.id === 'string' ? body.id : ''
  if (id === '') return { ok: false, message: 'id required' }
  const catalog = readCatalog()
  if (catalog === null) return { ok: false, message: 'catalog missing from package' }
  const entry = catalog.entries.find((item) => item.id === id)
  if (entry === undefined) return { ok: false, message: 'unknown connector: ' + id }
  const auth = entry.authorize
  if (auth === undefined) return { ok: false, message: '这个连接器没有授权步骤' }
  if (!ALLOWED_AUTH_COMMANDS.has(auth.command)) {
    return { ok: false, message: '不支持的授权命令: ' + auth.command }
  }

  if (typeof auth.requiresFile === 'string' && auth.requiresFile !== '') {
    const file = expandHome(auth.requiresFile)
    if (!existsSync(file)) {
      return {
        ok: false,
        needsSetup: true,
        requiresFile: auth.requiresFile,
        requiresLabel: auth.requiresLabel,
        setupUrl: auth.setupUrl,
        message: '还缺「' + (auth.requiresLabel ?? auth.requiresFile) + '」，准备好再点授权。',
      }
    }
  }

  try {
    const child = spawn(auth.command, auth.args ?? [], {
      detached: true,
      stdio: 'ignore',
      // Windows 上 npx 是 npx.cmd，不套 shell 会 ENOENT
      shell: process.platform === 'win32',
      cwd: homedir(),
    })
    child.unref()
  } catch (error) {
    return { ok: false, message: '启动授权命令失败: ' + (error instanceof Error ? error.message : String(error)) }
  }
  return {
    ok: true,
    started: true,
    message: auth.doneHint ?? '授权窗口已启动，按浏览器里的提示完成登录。',
  }
}

/**
 * 已装状态 + 当前 env（详情弹窗打开时拉一次）。
 *
 * 只回传目录里存在的条目；patch 里手工加的、目录外的 mcp-client 不在这里出现
 * （那些由「SKILL 面板 → MCP」那套视图负责）。
 */
function readState(): { ok: boolean; items: Record<string, { serverName: string; env: Record<string, string> }> } {
  const patchPath = patchFilePath()
  const items: Record<string, { serverName: string; env: Record<string, string> }> = {}
  if (!existsSync(patchPath)) return { ok: true, items }
  const content = readFileSync(patchPath, 'utf8')
  const installed = scanInstalledEntries(content)
  const catalog = readCatalog()
  for (const entry of catalog?.entries ?? []) {
    const serverName = toServerName(entry.id)
    // 官方插件类条目：patch 里出现它的全部插件行才算已装（少一条就是没装好）。
    if (entry.install.type === 'plugin') {
      const ids = new Set((entry.install.entries ?? []).map((plugin) => plugin.id))
      if (ids.size > 0 && scanPluginEntries(content, ids).size === ids.size) {
        items[entry.id] = { serverName, env: {} }
      }
      continue
    }
    const hit = installed.get(serverName)
    if (hit !== undefined) items[entry.id] = { serverName, env: hit.env }
  }
  return { ok: true, items }
}

/* ───────────────────────────── HTTP 路由 ───────────────────────────── */

/** loopback 校验（与 mcp-status / memory 同款）。 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string') return false
  const a = address.toLowerCase()
  if (a === '::1') return true
  const ipv4 = a.startsWith('::ffff:') ? a.slice(7) : a
  const octets = ipv4.split('.')
  return octets.length === 4 && octets[0] === '127' && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function hostNameOf(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const host = value.trim().toLowerCase()
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close <= 1) return null
    const suffix = host.slice(close + 1)
    if (suffix !== '' && !/^:\d+$/.test(suffix)) return null
    return host.slice(1, close)
  }
  const firstColon = host.indexOf(':')
  const lastColon = host.lastIndexOf(':')
  if (firstColon !== lastColon) return null
  return firstColon === -1 ? host : host.slice(0, firstColon)
}

function loopbackAllowed(req: { socket: { remoteAddress?: string }; headers: { host?: string } }): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const host = hostNameOf(req.headers.host)
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function writeJson(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(value))
}

/** 读请求体（限制 64KB，防滥用）。 */
function readBody(req: { on: (event: string, handler: (chunk?: unknown) => void) => void }): Promise<string> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: string[] = []
    req.on('data', (chunk?: unknown) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      size += text.length
      if (size > 65536) { resolve(''); return }
      chunks.push(text)
    })
    req.on('end', () => { resolve(chunks.join('')) })
    req.on('error', () => { resolve('') })
  })
}

/** 注册目录 / 图标 / 安装三条路由。 */
export function applyMcpCatalog(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CATALOG_ROUTE,
    handler: (req: any, res: any) => {
      void (async () => {
        if (!loopbackAllowed(req)) { writeJson(res, 403, { error: 'loopback-only' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === CATALOG_ROUTE || url.pathname === CATALOG_ROUTE + '/') {
          const catalog = readCatalog()
          if (catalog === null) { writeJson(res, 500, { error: 'catalog missing from package' }); return }
          writeJson(res, 200, catalog)
          return
        }
        if (url.pathname === CATALOG_ROUTE + '/state') {
          writeJson(res, 200, readState())
          return
        }
        if (url.pathname === CATALOG_ROUTE + '/install') {
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
          const raw = await readBody(req)
          let body: { id?: unknown; env?: unknown; overwrite?: unknown } = {}
          try { body = JSON.parse(raw) as { id?: unknown; env?: unknown; overwrite?: unknown } } catch { /* 空体按缺参处理 */ }
          writeJson(res, 200, installEntry(body))
          return
        }
        if (url.pathname === CATALOG_ROUTE + '/uninstall') {
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
          const raw = await readBody(req)
          let body: { id?: unknown } = {}
          try { body = JSON.parse(raw) as { id?: unknown } } catch { /* 空体按缺参处理 */ }
          writeJson(res, 200, uninstallEntry(body))
          return
        }
        if (url.pathname === CATALOG_ROUTE + '/authorize') {
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
          const raw = await readBody(req)
          let body: { id?: unknown } = {}
          try { body = JSON.parse(raw) as { id?: unknown } } catch { /* 空体按缺参处理 */ }
          writeJson(res, 200, authorizeEntry(body))
          return
        }
        writeJson(res, 404, { error: 'no route for ' + url.pathname })
      })()
    },
  }), 'dsh-mcp-catalog: routes')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ICON_ROUTE,
    handler: (req: any, res: any) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const name = decodeURIComponent(url.pathname.slice(ICON_ROUTE.length).replace(/^\/+/, ''))
      if (!iconFiles().has(name)) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'unknown icon' }))
        return
      }
      const path = resolveAsset('assets/mcp-catalog/icons/' + name)
      if (path === null) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'icon missing from package' }))
        return
      }
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      const mime = ext === 'svg' ? 'image/svg+xml' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ext === 'ico' ? 'image/x-icon' : 'image/png'
      let buf: Buffer
      try {
        buf = readFileSync(path)
      } catch {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'icon unreadable' }))
        return
      }
      res.writeHead(200, {
        'content-type': mime,
        'content-length': String(buf.length),
        'cache-control': 'public, max-age=604800',
      })
      res.end(buf)
    },
  }), 'dsh-mcp-catalog: icons')
}