/**
 * Personal Agent — Bot 产出物目录与扫描（host 半身）。
 *
 * ## 职责
 *
 * 每个 Bot 有一个**固定**的产出物文件夹：`<botWorkspaceDir>/产出物/<botFolder>/`。
 * 本文件负责三件事：
 *
 *  1. **目录分配**：根据 Bot 名字生成可读文件夹名（sanitize、重名去重），把
 *     `botId → folder` 的映射持久化到
 *     `<DSH_HOME>/storages/dsh-seeker-bot/personal-agent/bot-output-dirs.json`；
 *  2. **分类子目录**：固定创建 9 个中文分类目录（图片 / 视频 / 音频 / 文档 /
 *     表格 / 演示 / 网页 / PDF / 其他），Bot 每轮开始时保证它们存在；
 *  3. **扫描**：递归两层（分类目录 + 根/未知子目录）收集文件，跳过隐藏文件与
 *     `~$` 临时文件，按 mtime 降序返回，供右栏「产出物」卡渲染。
 *
 * ## 约束
 *
 * 本文件属于 host 产物，**不能 import `@deepseek-ai/*`**，只依赖 Node 内置模块。
 * 目录解析（DSH_HOME / botWorkspaceDir）与 `agent.ts` 同口径：
 *  - `DSH_HOME` 环境变量优先，否则 `~/.dsh`；
 *  - bot 工作区由 `DSH_SEEKER_BOT_WORKSPACE` 覆盖，Windows 有 D 盘用
 *    `D:\Seeker-Bot`，否则 `~/Seeker-Bot`。
 *
 * 两份实现（本文件与 agent.ts）刻意保持一致而不是互相 import：agent.ts 会
 * import 本文件来建目录，反向 import 会形成循环依赖。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

/** 产出物类型（与前端 `BotOutputKind` / `src/client/personal/types.ts` 逐字对齐）。 */
export type BotOutputKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'page'
  | 'archive'
  | 'file'

/** 固定 9 个分类子目录（顺序即界面上常见的分组顺序）。 */
export const BOT_OUTPUT_CATEGORIES = [
  '图片',
  '视频',
  '音频',
  '文档',
  '表格',
  '演示',
  '网页',
  'PDF',
  '其他',
] as const

export type BotOutputCategory = (typeof BOT_OUTPUT_CATEGORIES)[number]

/** 扩展名 → 展示类型（host 与前端共用同一张表的口径）。 */
const KIND_BY_EXT: Readonly<Record<string, BotOutputKind>> = {
  // image
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.svg': 'image',
  '.avif': 'image',
  // video
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.mkv': 'video',
  // audio
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.aac': 'audio',
  // pdf
  '.pdf': 'pdf',
  // document
  '.doc': 'doc',
  '.docx': 'doc',
  '.odt': 'doc',
  '.rtf': 'doc',
  '.txt': 'doc',
  '.md': 'doc',
  // spreadsheet
  '.xls': 'sheet',
  '.xlsx': 'sheet',
  '.ods': 'sheet',
  '.csv': 'sheet',
  // slide
  '.ppt': 'slide',
  '.pptx': 'slide',
  '.odp': 'slide',
  // web page
  '.html': 'page',
  '.htm': 'page',
  // archive（没有独立分类，归入「其他」）
  '.zip': 'archive',
  '.rar': 'archive',
  '.7z': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
}

/** 类型 → 默认分类目录。 */
const CATEGORY_BY_KIND: Readonly<Record<BotOutputKind, BotOutputCategory>> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  pdf: 'PDF',
  doc: '文档',
  sheet: '表格',
  slide: '演示',
  page: '网页',
  archive: '其他',
  file: '其他',
}

/** 扫描结果上限（契约：最多 200 条）。 */
export const MAX_BOT_OUTPUT_ITEMS = 200

/** 契约里的单个产出物条目。 */
export interface BotOutputItem {
  /** 相对 bot 工作区的正斜杠路径，如 `产出物/小析/图片/a.png`。 */
  path: string
  /** 同源访问地址（`/api/personal-agent/file?path=...`）。 */
  url: string
  /** 文件名（含扩展名）。 */
  name: string
  /** 展示类型。 */
  kind: BotOutputKind
  /** 字节数。 */
  size: number
  /** mtime（毫秒时间戳），用于倒序排列。 */
  time: number
  /** 分类目录名（用于前端按类别分组）。 */
  category: BotOutputCategory
}

/** `GET /api/personal-agent/outputs` 的完整响应。 */
export interface BotOutputScanResult {
  ok: boolean
  botId?: string
  folder?: string
  root?: string
  items?: BotOutputItem[]
  error?: string
}

/** `ensureBotOutputDirs` 的返回值（folder 是映射里持久化的那个名字）。 */
export interface BotOutputDirs {
  folder: string
  root: string
}

interface BotOutputDirMap {
  version: 1
  bots: Record<string, string>
}

/** `DSH_HOME` 口径（与 agent.ts 的 dshHome 一致）。 */
function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/**
 * bot 共享工作区（与 agent.ts 的 botWorkspaceDir 同口径）。
 *
 * 测试可用 `DSH_SEEKER_BOT_WORKSPACE` 指到临时目录，避免污染 `D:\Seeker-Bot`。
 */
export function botWorkspaceDir(): string {
  const override = process.env.DSH_SEEKER_BOT_WORKSPACE
  let dir: string
  if (typeof override === 'string' && override.trim() !== '') {
    dir = override.trim()
  } else if (process.platform === 'win32' && existsSync('D:\\')) {
    dir = join('D:\\', 'Seeker-Bot')
  } else {
    dir = join(homedir(), 'Seeker-Bot')
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 所有 Bot 产出物的根目录：`<workspace>/产出物`。 */
export function botOutputsRoot(): string {
  return join(botWorkspaceDir(), '产出物')
}

/** 目录映射文件的绝对路径。 */
export function botOutputMapFile(): string {
  return join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent', 'bot-output-dirs.json')
}

/** 把任意 botId 收敛成安全的路径 / 会话 id 片段（与 agent.ts 的 safeId 同规则）。 */
function safeId(botId: string): string {
  const cleaned = String(botId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)
  return cleaned === '' ? 'main' : cleaned
}

/**
 * Bot 名字 → 可读文件夹名。
 *
 * 契约：去掉 `<>:"/\|?*` 与控制字符，trim，≤32 字符。额外去掉结尾的点和空格
 * （Windows 上这类目录名会被系统静默改写，映射就会对不上实际目录）。
 * 名字为空 / 全是非法字符时用 botId 末四位兜底，避免所有 Bot 都挤进 `Bot-main`。
 */
export function sanitizeBotFolderName(name: string, botId = ''): string {
  const cleaned = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 32)
    .trim()
  if (cleaned !== '') return cleaned
  return `Bot-${safeId(botId).slice(-4)}`
}

/** 读目录映射文件；文件不存在 / 损坏 / 形状不对时返回空映射。 */
function readMap(): BotOutputDirMap {
  try {
    const raw = JSON.parse(readFileSync(botOutputMapFile(), 'utf8')) as unknown
    if (raw === null || typeof raw !== 'object') return { version: 1, bots: {} }
    const botsRaw = (raw as Record<string, unknown>).bots
    if (botsRaw === null || typeof botsRaw !== 'object' || Array.isArray(botsRaw)) {
      return { version: 1, bots: {} }
    }
    const bots: Record<string, string> = {}
    for (const [botId, folder] of Object.entries(botsRaw as Record<string, unknown>)) {
      if (typeof folder !== 'string') continue
      const value = folder.trim()
      if (value === '') continue
      bots[botId] = value
    }
    return { version: 1, bots }
  } catch {
    return { version: 1, bots: {} }
  }
}

/** 写目录映射文件（临时文件 + rename，避免写到一半崩溃后留下坏 JSON）。 */
function writeMap(map: BotOutputDirMap): void {
  const file = botOutputMapFile()
  mkdirSync(join(file, '..'), { recursive: true })
  const text = `${JSON.stringify({ version: 1, bots: map.bots }, null, 2)}\n`
  const temp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, file)
  } catch {
    // Windows 上目标被占用 / rename 失败：退回直接覆盖写。映射丢了至多重新分配
    // 一个文件夹（同名时仍会命中唯一性检查），不会破坏已有文件。
    try {
      writeFileSync(file, text, 'utf8')
    } catch {
      /* 目录只读：由调用方决定如何降级 */
    }
  }
}

/**
 * 只读：某个 Bot 当前分配的产出物文件夹名。
 *
 * 与 {@link ensureBotOutputDirs} 的区别是**它什么也不创建、什么也不写**。
 * 删除流程需要它：先算出目录在哪，再决定删不删；如果走 `ensureBotOutputDirs`，
 * 在映射已被摘掉的情况下会重新分配一个文件夹并写回映射——等于把刚清掉的东西
 * 又建回来了（实测踩过）。
 */
export function botOutputFolderOf(botId: string): string | undefined {
  const id = String(botId ?? '').trim()
  if (id === '') return undefined
  return readMap().bots[id]
}

/**
 * 抹掉某个 Bot 的目录映射，返回它原来用的文件夹名。
 *
 * 只删**映射**，不删目录：产出物是用户让它生成的真实文件，一个「删除 Bot」的
 * 按钮不该无声抹掉它们。真要连文件一起删由调用方拿返回的 folder 自己决定。
 *
 * 没有映射时返回 undefined（Bot 从未产出过东西，或已经删过一次）。
 */
export function forgetBotOutputDir(botId: string): string | undefined {
  const id = String(botId ?? '').trim()
  if (id === '') return undefined
  const map = readMap()
  const folder = map.bots[id]
  if (folder === undefined) return undefined
  delete map.bots[id]
  writeMap(map)
  return folder
}

/**
 * 给一个新 Bot 分配文件夹名。
 *
 * 同名的处理：追加 `-<safeId 后四位>`；极端情况下仍有冲突就继续追加序号。
 * 只和**其它 Bot** 的 folder 比较——已有映射的 Bot 永远沿用原值（改名不迁移目录）。
 */
function allocateFolder(botId: string, name: string | undefined, map: BotOutputDirMap): string {
  const base = sanitizeBotFolderName(name ?? '', botId)
  const used = new Set(
    Object.entries(map.bots)
      .filter(([id]) => id !== botId)
      .map(([, folder]) => folder),
  )
  if (!used.has(base)) return base
  const suffix = safeId(botId).slice(-4)
  let candidate = `${base}-${suffix}`
  let index = 2
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}-${index}`
    index += 1
  }
  return candidate
}

/**
 * 确保某个 Bot 的产出物目录存在，并返回它的文件夹名与绝对根路径。
 *
 * 幂等：同一 botId 重复调用永远得到同一个 folder；分类子目录每次都会补建
 * （用户手动删掉某个分类目录后，下一轮对话会自动恢复）。
 *
 * @param botId - Bot id（决定持久化映射的 key）。
 * @param name - Bot 显示名（仅首次分配时参与生成 folder；改名不迁移）。
 * @throws botId 为空、或目录 / 映射文件无法创建时抛错（由路由转成 `{ok:false}`）。
 */
export function ensureBotOutputDirs(botId: string, name?: string): BotOutputDirs {
  const id = String(botId ?? '').trim()
  if (id === '') throw new Error('botId required')

  const map = readMap()
  let folder = map.bots[id]
  if (folder === undefined || folder.trim() === '') {
    folder = allocateFolder(id, name, map)
    map.bots[id] = folder
    writeMap(map)
  }

  const root = join(botOutputsRoot(), folder)
  mkdirSync(root, { recursive: true })
  for (const category of BOT_OUTPUT_CATEGORIES) {
    mkdirSync(join(root, category), { recursive: true })
  }
  return { folder, root }
}

/**
 * 只读地拿一个 Bot 的产出物目录：**不分配、不建目录、不写映射**。
 *
 * 为什么必须有它：`ensureBotOutputDirs` 是**写**路径（分配文件夹、补建 9 个分类
 * 目录、落映射）。只读接口如果也走它，一个「看一眼产出物清单」的请求就会给一个
 * **已经不存在的 Bot** 重新分配文件夹并写回映射——用户删掉的 Bot 会因此复活
 * （实测：删完重启，右栏扫一次产出物，目录和映射就又回来了）。
 *
 * 没有映射 = 这个 Bot 从没产出过东西，返回 `undefined`。
 */
export function botOutputDirsOf(botId: string): BotOutputDirs | undefined {
  const id = String(botId ?? '').trim()
  if (id === '') return undefined
  const folder = readMap().bots[id]
  if (folder === undefined || folder.trim() === '') return undefined
  return { folder, root: join(botOutputsRoot(), folder) }
}

/** 按文件名后缀判断展示类型（未知一律 file）。 */
export function outputKindFor(fileName: string): BotOutputKind {
  return KIND_BY_EXT[extname(String(fileName ?? '')).toLowerCase()] ?? 'file'
}

/** 按文件名后缀判断应归档的分类目录。 */
export function outputCategoryFor(fileName: string): BotOutputCategory {
  return CATEGORY_BY_KIND[outputKindFor(fileName)]
}

/** 隐藏文件 / `~$` 临时文件：不展示、不计入产出物。 */
function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~$')
}

/** 某个目录名是否是固定分类之一。 */
function categoryOf(name: string): BotOutputCategory | null {
  return (BOT_OUTPUT_CATEGORIES as readonly string[]).includes(name)
    ? (name as BotOutputCategory)
    : null
}

/**
 * 扫描某个 Bot 的产出物目录。
 *
 * 遍历范围（递归两层）：
 *  - `<root>/<分类目录>/**` 里的文件；
 *  - `<root>/**` 根目录与未知子目录里的文件（未知子目录也扫一层，避免用户手动
 *    放进去的文件消失）。
 *
 * 过滤：隐藏文件（`.` 开头）、`~$` 临时文件、目录本身。排序：mtime 降序；
 * 最多 {@link MAX_BOT_OUTPUT_ITEMS} 条。
 *
 * 读不到目录 / 分配失败时返回 `{ ok:false, error }`，由路由映射成 500 JSON。
 */
export function scanBotOutputs(botId: string, name?: string): BotOutputScanResult {
  const id = String(botId ?? '').trim()
  if (id === '') return { ok: false, error: 'botId required' }

  /*
   * 只读路径：**绝不能**调 `ensureBotOutputDirs`。
   *
   * 它是写路径——会分配文件夹、补建 9 个分类目录、把映射写回去。挂在「读清单」
   * 上的后果是：用户删掉一个 Bot 之后，前端只要扫一次产出物，这个 Bot 的目录和
   * 映射就被重新建出来，删了跟没删一样（实测踩过）。
   *
   * 没有映射就是「从没产出过东西」，直接给空清单。`name` 参数因此不再参与——
   * 保留它只是为了不破坏调用方签名。
   */
  void name
  const dirs = botOutputDirsOf(id)
  if (dirs === undefined) return { ok: true, botId: id, items: [] }

  const workspace = botWorkspaceDir()
  const root = dirs.root
  const items: BotOutputItem[] = []

  /**
   * 读一层目录；`depth` 0 = 产出物根，1 = 分类/未知子目录。
   * 子目录里的再下一层目录不进入（契约的「两层」是 root + 一层子目录）。
   */
  const visit = (dir: string, depth: number, inheritedCategory: BotOutputCategory | null): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error: any) {
      if (depth === 0) throw error
      return
    }
    for (const entry of entries) {
      const entryName = String(entry.name ?? '')
      if (entryName === '' || isIgnoredName(entryName)) continue
      const full = join(dir, entryName)
      if (entry.isDirectory()) {
        if (depth >= 1) continue
        const subCategory = categoryOf(entryName)
        visit(full, depth + 1, subCategory)
        continue
      }
      if (!entry.isFile()) continue
      let info: Stats
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      const kind = outputKindFor(entryName)
      const rel = relative(workspace, full).replace(/\\/g, '/')
      if (rel === '' || rel.startsWith('..')) continue
      items.push({
        path: rel,
        url: `/api/personal-agent/file?path=${encodeURIComponent(rel)}`,
        name: entryName,
        kind,
        size: info.size,
        time: Math.round(info.mtimeMs),
        // 分类目录里的文件按目录分组（即使扩展名不符也尊重用户的手动摆放）；
        // 根 / 未知子目录里的文件按扩展名归到默认分类。
        category: inheritedCategory ?? CATEGORY_BY_KIND[kind],
      })
    }
  }

  try {
    visit(root, 0, null)
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error) }
  }

  items.sort((left, right) => right.time - left.time)
  return {
    ok: true,
    botId: id,
    folder: dirs.folder,
    root: resolve(dirs.root),
    items: items.slice(0, MAX_BOT_OUTPUT_ITEMS),
  }
}

/* ───────────────────────── 交付物归档（收口时调用） ───────────────────────── */

/** 归档单文件上限：与 /file 的媒体上限一致（256MB）。 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

/** `archiveArtifactFile` 的返回结构。 */
export interface BotOutputArchiveResult {
  ok: boolean
  /** 归档后的相对 bot 工作区正斜杠路径（成功 / 已在产出物目录内时有值）。 */
  path?: string
  /** true = 本次复制了；false = 已在产出物目录内或已存在同大小文件（跳过）。 */
  copied?: boolean
  error?: string
}

/** 路径比较归一化（与 agent.ts / index.ts 同口径）。 */
function normalizeForCompare(value: string): string {
  return resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 把一个交付文件归档复制到该 Bot 的产出物目录（不删除源文件）。
 *
 * ## 为什么需要
 *
 * 模型干活时常把文件写到 `_tmp/` 或工作区根目录，而右栏「产出物」卡只扫描
 * `<workspace>/产出物/<botFolder>/`。没有这一步，用户明明收到了文件，卡片却是空的。
 *
 * ## 规则
 *
 *  - 只接受 **bot 工作区内**的普通文件（绝对路径或相对工作区的路径都行）；
 *  - 源文件已经在本 Bot 的产出物目录内 → 不复制，返回 `copied:false`；
 *  - 按扩展名归到对应分类目录；目标同名且**大小相同** → 视为已归档，跳过；
 *    同名但大小不同 → 依次尝试 `名字-2.扩展名`、`名字-3.扩展名`…；
 *  - 单文件超过 256MB 不复制（与 `/file` 的媒体上限一致）。
 *
 * 复制失败不抛错，返回 `{ ok:false, error }`，由调用方决定是否忽略。
 */
export function archiveArtifactFile(
  botId: string,
  name: string | undefined,
  absPath: string,
): BotOutputArchiveResult {
  const id = String(botId ?? '').trim()
  if (id === '') return { ok: false, error: 'botId required' }
  const raw = String(absPath ?? '').trim()
  if (raw === '') return { ok: false, error: 'empty path' }

  let source: string
  try {
    source = resolve(isAbsolute(raw) ? raw : join(botWorkspaceDir(), raw))
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error) }
  }

  const workspace = botWorkspaceDir()
  const workspaceKey = normalizeForCompare(workspace)
  const sourceKey = normalizeForCompare(source)
  if (sourceKey !== workspaceKey && !sourceKey.startsWith(`${workspaceKey}/`)) {
    return { ok: false, error: 'outside workspace' }
  }

  let info: Stats
  try {
    info = statSync(source)
  } catch {
    return { ok: false, error: 'not found' }
  }
  if (!info.isFile()) return { ok: false, error: 'not a file' }
  if (info.size > MAX_ARCHIVE_BYTES) return { ok: false, error: 'too large' }

  let dirs: BotOutputDirs
  try {
    dirs = ensureBotOutputDirs(id, name)
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error) }
  }

  const rootKey = normalizeForCompare(dirs.root)
  if (sourceKey === rootKey || sourceKey.startsWith(`${rootKey}/`)) {
    return { ok: true, path: relative(workspace, source).replace(/\\/g, '/'), copied: false }
  }

  const category = CATEGORY_BY_KIND[outputKindFor(source)]
  const destDir = join(dirs.root, category)
  mkdirSync(destDir, { recursive: true })
  const fileName = basename(source)
  const extension = extname(fileName)
  const stem = extension === '' ? fileName : fileName.slice(0, fileName.length - extension.length)

  let dest = join(destDir, fileName)
  let index = 2
  for (;;) {
    if (!existsSync(dest)) break
    let existing: Stats | null = null
    try {
      existing = statSync(dest)
    } catch {
      existing = null
    }
    if (existing !== null && existing.isFile() && existing.size === info.size) {
      // 同名同大小：基本可以断定就是同一份文件（上一轮已经归档过），跳过。
      return { ok: true, path: relative(workspace, dest).replace(/\\/g, '/'), copied: false }
    }
    if (index > 100) return { ok: false, error: 'name conflict' }
    dest = join(destDir, `${stem}-${index}${extension}`)
    index += 1
  }

  try {
    copyFileSync(source, dest)
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  return { ok: true, path: relative(workspace, dest).replace(/\\/g, '/'), copied: true }
}
