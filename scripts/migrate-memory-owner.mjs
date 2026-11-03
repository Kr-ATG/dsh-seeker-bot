#!/usr/bin/env node
/**
 * 记忆归属迁移（schema v5 → v6）：给存量条目补 `owner` 并按新规则重算 id。
 *
 * ## 为什么必须重算 id
 *
 * v5 的 id 是 `mem_sha1(scope | projectHash | content)`，不含归属。改造后所有
 * Personal Agent 的 bot 共用同一个工作目录（`D:\Seeker-Bot`），`projectHash`
 * 完全相同——id 里不带 owner 的话，两个 bot 记下同一句话会被合并成一条，
 * 「子 bot 记忆隔离」就无从谈起。所以 v6 的 id 是
 * `mem_sha1(owner | scope | projectHash | content)`。
 *
 * ## 归属怎么判定
 *
 * 只看 `provenance.sessionId`：
 *   - `pa-bot-v2-<botId>` → `bot:<botId>`（正则允许版本段变化）
 *   - 其它 / 缺失       → `work`
 *
 * 缺失溯源时默认 work 是刻意的安全侧选择：Work 会话与主 Bot 都能看到 work
 * 条目，而误判成某个 bot 会让它在别的会话里凭空消失。
 *
 * ## 用法
 *
 *   node scripts/migrate-memory-owner.mjs          # dry-run：只报告，不写盘
 *   node scripts/migrate-memory-owner.mjs --apply  # 备份后落盘
 *
 * 脚本幂等：id 已经是新算法结果的条目会被跳过，重复执行不会产生二次变更。
 */

import { createHash } from 'node:crypto'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const memoryHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const storeDir = join(memoryHome, 'memories', 'dsh-memory', 'store')
const entriesPath = join(storeDir, 'entries.json')

/** 会话 id → 归属。与 src/triad/memory/engine/store.ts 的 ownerOfSessionId 同规则。 */
function ownerOfSessionId(sessionId) {
  if (typeof sessionId !== 'string') return 'work'
  const match = /^pa-bot-(?:v\d+-)?(.+)$/.exec(sessionId.trim())
  if (match === null) return 'work'
  const botId = match[1].trim()
  // 残缺 id（`pa-bot-v2-`）会回溯成 `v2-`：只有版本段没有实体 id，当 Work。
  if (botId === '' || /^v\d+-$/.test(botId)) return 'work'
  return `bot:${botId}`
}

/** 新 id 算法（含 owner）。 */
function entryIdOf(content, scope, projectHash, owner) {
  const key = `${owner}\u0000${scope}\u0000${projectHash ?? ''}\u0000${String(content).trim()}`
  return `mem_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

/** 旧 id 算法（不含 owner），用于判断某条是否已经迁移过。 */
function legacyEntryIdOf(content, scope, projectHash) {
  const key = `${scope}\u0000${projectHash ?? ''}\u0000${String(content).trim()}`
  return `mem_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function main() {
  const apply = process.argv.includes('--apply')

  if (!existsSync(entriesPath)) {
    console.error(`找不到 ${entriesPath}`)
    process.exit(1)
  }

  const raw = await readFile(entriesPath, 'utf8')
  const doc = JSON.parse(raw)
  const entries = Array.isArray(doc) ? doc : doc.entries
  if (!Array.isArray(entries)) {
    console.error('entries.json 结构无法识别（既不是数组也没有 entries 字段）')
    process.exit(1)
  }

  const report = {
    total: entries.length,
    byOwner: new Map(),
    idChanged: 0,
    alreadyMigrated: 0,
    conflicts: [],
    preview: [],
  }

  const nextEntries = []
  const seenIds = new Map()

  for (const entry of entries) {
    const owner = entry.owner ?? ownerOfSessionId(entry.provenance?.sessionId)
    const scope = entry.scope === 'global' ? 'global' : 'project'
    const projectHash = scope === 'project' ? (entry.projectHash ?? null) : null
    const nextId = entryIdOf(entry.content, scope, projectHash, owner)
    const legacyId = legacyEntryIdOf(entry.content, scope, projectHash)

    report.byOwner.set(owner, (report.byOwner.get(owner) ?? 0) + 1)

    if (entry.id === nextId) {
      report.alreadyMigrated += 1
    } else if (entry.id === legacyId) {
      report.idChanged += 1
      if (report.preview.length < 5) {
        const head = String(entry.content).replace(/\s+/g, ' ').slice(0, 40)
        report.preview.push({ from: entry.id, to: nextId, owner, scope, head })
      }
    } else {
      // 既不是旧 id 也不是新 id：可能是手工改过或更早的算法，仍按新规则归位并记录。
      report.idChanged += 1
      if (report.preview.length < 5) {
        const head = String(entry.content).replace(/\s+/g, ' ').slice(0, 40)
        report.preview.push({ from: `${entry.id}（非标准）`, to: nextId, owner, scope, head })
      }
    }

    const next = { ...entry, id: nextId }
    // work 是缺省语义，显式写出来让后续读取不必再猜；bot 归属必须落盘。
    next.owner = owner
    if (scope === 'global') next.projectHash = null

    const clash = seenIds.get(nextId)
    if (clash !== undefined) {
      report.conflicts.push({
        id: nextId,
        a: String(clash.content).slice(0, 40),
        b: String(next.content).slice(0, 40),
      })
    } else {
      seenIds.set(nextId, next)
    }

    nextEntries.push(next)
  }

  // ── 报告 ────────────────────────────────────────────────────────
  console.log(`\n记忆归属迁移 ${apply ? '【APPLY】' : '【DRY-RUN，不写盘】'}`)
  console.log(`数据文件：${entriesPath}`)
  console.log(`条目总数：${report.total}`)
  console.log('\n归属分布：')
  for (const [owner, count] of [...report.byOwner.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${owner.padEnd(16)} ${count}`)
  }
  console.log(`\nid 需要重算：${report.idChanged}`)
  console.log(`已迁移（幂等跳过）：${report.alreadyMigrated}`)
  if (report.preview.length > 0) {
    console.log('\nid 变化示例：')
    for (const item of report.preview) {
      console.log(`  ${item.from} → ${item.to}  [${item.owner}/${item.scope}] ${item.head}`)
    }
  }
  if (report.conflicts.length > 0) {
    console.error(`\n发现 ${report.conflicts.length} 组 id 冲突，已中止：`)
    for (const item of report.conflicts) console.error(`  ${item.id}: 「${item.a}」 vs 「${item.b}」`)
    process.exit(2)
  }

  if (!apply) {
    console.log('\n未写盘。确认无误后加 --apply 执行。')
    return
  }

  if (report.idChanged === 0) {
    console.log('\n没有需要变更的条目，未写盘。')
    return
  }

  // ── 备份 + 原子写 ───────────────────────────────────────────────
  const backupPath = `${entriesPath}.bak-migrate-${stamp()}`
  await copyFile(entriesPath, backupPath)
  console.log(`\n已备份：${backupPath}`)

  const out = Array.isArray(doc) ? nextEntries : { ...doc, entries: nextEntries }
  const tmpPath = `${entriesPath}.tmp-${process.pid}`
  await writeFile(tmpPath, JSON.stringify(out, null, 2), 'utf8')
  await rename(tmpPath, entriesPath)

  // 回读校验：条目数与内容哈希必须与预期一致。
  const check = JSON.parse(await readFile(entriesPath, 'utf8'))
  const checkEntries = Array.isArray(check) ? check : check.entries
  if (checkEntries.length !== nextEntries.length) {
    console.error(`写后校验失败：条目数 ${checkEntries.length} != ${nextEntries.length}，备份在 ${backupPath}`)
    process.exit(3)
  }
  const mismatch = nextEntries.findIndex((entry, index) => checkEntries[index]?.id !== entry.id)
  if (mismatch !== -1) {
    console.error(`写后校验失败：第 ${mismatch} 条 id 不一致，备份在 ${backupPath}`)
    process.exit(3)
  }

  console.log(`完成：${report.idChanged} 条已重算 id 并补 owner，校验通过。`)
  console.log('注意：宿主进程若正在运行，需重启后才会读到新的 entries（内存态会被回刷覆盖）。')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
