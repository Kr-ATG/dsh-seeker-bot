#!/usr/bin/env node
/**
 * dsh-seeker-bot — Bot 宿主会话 header 迁移：补 `origin: 'subagent'`。
 *
 * 背景：Personal Agent 的每个 Bot 在 DSH 宿主里是一个 `pa-bot-v2-<botId>` Session。
 * 旧版本创建时没有 `origin` 字段，官方 Work 的会话列表/搜索会把它当成普通用户
 * 会话列出来（「未分组」里的 Bot 会话）。新版本创建时已带 `origin: 'subagent'`，
 * 官方 `sessionVisible()` 会把它们排除；本脚本负责把**已存在**的旧会话 header
 * 补上同一个标记。
 *
 * 用法：
 *   node scripts/migrate-bot-session-origin.mjs            # 只预览
 *   node scripts/migrate-bot-session-origin.mjs --apply    # 实际迁移（先备份）
 *
 * 运行时机：**DSH 重启后、Bot 尚未打开时**最安全（会话没有 live agent 在追加）。
 * 脚本也会通过 `/api/personal-agent/diagnose` 读取 live 列表，跳过仍在运行的
 * Bot 会话；跳过的那些等下次再跑即可。
 *
 * 物理格式：Session 是 zstd 多帧文件（第一帧 header，后续每帧一段 events）。
 * 只重写第一帧，其余字节原样保留。压缩参数与 DSH 的 compressZstdFrame 对齐
 * （ZSTD_c_checksumFlag = 1）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const APPLY = process.argv.includes('--apply')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const BACKUP_ROOT = join(process.cwd(), '_tmp', 'bot-session-origin-backup')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function scanFrames(buf) {
  const offsets = []
  let index = 0
  while ((index = buf.indexOf(ZSTD_MAGIC, index)) !== -1) {
    offsets.push(index)
    index += 4
  }
  return offsets
}

function decodeHeader(file) {
  const bytes = readFileSync(file)
  const offsets = scanFrames(bytes)
  if (offsets.length === 0) return { error: 'no zstd frame' }
  const end = offsets.length > 1 ? offsets[1] : bytes.length
  const text = zstdDecompressSync(bytes.subarray(0, end)).toString('utf8')
  const line = text.split('\n').find((item) => item.trim() !== '')
  if (line === undefined) return { error: 'empty header frame' }
  try {
    return { header: JSON.parse(line), offsets, bytes }
  } catch {
    return { error: 'bad header json' }
  }
}

async function liveSessionIds() {
  try {
    const res = await fetch('http://127.0.0.1:3080/api/personal-agent/diagnose?botId=bot-main-xiaomo', {
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return new Set()
    const data = await res.json()
    const live = data?.agentsApi?.live
    return new Set(Array.isArray(live) ? live.map(String) : [])
  } catch {
    return new Set()
  }
}

function findAllSessions() {
  const found = []
  if (!existsSync(SESSIONS_ROOT)) return found
  for (const project of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(SESSIONS_ROOT, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory() || !session.name.startsWith('pa-bot-v2-')) continue
      const dir = join(projectDir, session.name)
      // 兼容不同版式：优先当前 generation，其次任意 .jsonl.zstd
      const candidates = readdirSync(dir).filter((name) => name.endsWith('.jsonl.zstd')).sort()
      for (const name of candidates) found.push({ sessionId: session.name, file: join(dir, name) })
    }
  }
  return found
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const live = await liveSessionIds()
const sessions = findAllSessions()
console.log(`DSH_HOME: ${DSH_HOME}`)
console.log(`找到 ${sessions.length} 个 Bot 宿主会话，live ${live.size} 个`)
console.log(`模式: ${APPLY ? 'APPLY（会写盘）' : 'DRY-RUN（只预览）'}`)
console.log('')

let migrated = 0
let skipped = 0
let failed = 0
for (const item of sessions) {
  const decoded = decodeHeader(item.file)
  if (decoded.error !== undefined) {
    console.log(`✗ ${item.sessionId}: 读取失败（${decoded.error}）`)
    failed += 1
    continue
  }
  const { header, offsets, bytes } = decoded
  const tag = `${item.sessionId}  origin=${String(header.origin ?? '(none)')}`
  if (header.origin === 'subagent') {
    console.log(`· ${tag}，已迁移`)
    skipped += 1
    continue
  }
  if (live.has(item.sessionId)) {
    console.log(`! ${tag}，仍在运行（live），跳过`)
    skipped += 1
    continue
  }
  console.log(`→ ${tag}，将补 origin=subagent`)
  if (!APPLY) continue
  try {
    const nextHeader = { ...header, origin: 'subagent' }
    const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(nextHeader)}\n`, 'utf8'), CHECKSUM_OPTIONS)
    const tailStart = offsets.length > 1 ? offsets[1] : bytes.length
    const next = Buffer.concat([headerFrame, bytes.subarray(tailStart)])
    const backup = join(BACKUP_ROOT, timestamp, relative(SESSIONS_ROOT, item.file))
    mkdirSync(dirname(backup), { recursive: true })
    copyFileSync(item.file, backup)
    const temp = `${item.file}.migrating`
    writeFileSync(temp, next)
    renameSync(temp, item.file)
    migrated += 1
    console.log(`  ✓ 已写回（备份 ${backup}）`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ 写回失败: ${String(error?.message ?? error)}`)
  }
}

console.log('')
console.log(`完成：迁移 ${migrated}，跳过 ${skipped}，失败 ${failed}`)
if (!APPLY) console.log('（这是预览；加 --apply 才会写盘）')
