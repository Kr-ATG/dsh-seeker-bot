/**
 * 「删除 Bot」在宿主侧的彻底清理（`src/host/personal/bot-delete.ts`）回归测试。
 *
 * 前端的删除按钮原来只摘 `pa:state:v1` 里那一条，宿主侧全是残留。这个模块负责
 * 把那些残留按 Bot 身份清干净。覆盖：
 *
 *  1. 护栏：空 id / 主 Bot 一律拒绝（主 Bot 删掉等于把整个入口弄没了）；
 *  2. 会话历史：`sessions/<工作区>/pa-bot-v2-<id>/` 被删（不删的话同 id 重建会
 *     恢复出上一任的上下文）；
 *  3. 花名册：`forgetBotSpec` 被调用（不摘的话主 Bot 还会往已删除的 Bot 派活）；
 *  4. 工作记忆 / 产出物映射 / Bot 页面 / 账本 都被清掉；
 *  5. 例行任务与主动询问配置里该 Bot 的条目被移除；
 *  6. **产出物目录默认保留**（那是用户的文件），`purgeFiles: true` 才删；
 *  7. 幂等：删两次不报错。
 *
 * ── 为什么用 esbuild 现场打包 ────────────────────────────────────────
 * 源码是 .ts、`lib/index.js` 是整插件单文件，两者都不能按模块 import。这里用
 * esbuild 把被测模块打成一个临时 ESM 包再 import，断言的是**真正会跑的那份源码**。
 *
 * Usage: node scripts/test-bot-delete.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
const pass = (msg) => console.log('ok    ' + msg)
const fail = (msg) => { console.error('FAIL  ' + msg); failed += 1 }
const assert = (cond, msg) => { if (cond) pass(msg); else fail(msg) }
const assertEqual = (actual, expected, msg) => {
  if (actual === expected) pass(msg)
  else fail(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

/** Windows 路径 → import URL 可用的正斜杠形式。 */
const slash = (p) => p.replace(/[\\]/g, '/')

// ── 隔离环境：账本 / 会话 / 产出物全落临时目录，绝不碰真实数据 ──────────
const home = mkdtempSync(join(tmpdir(), 'dsh-bot-delete-home-'))
const workspace = mkdtempSync(join(tmpdir(), 'dsh-bot-delete-ws-'))
process.env.DSH_HOME = home
process.env.DSH_SEEKER_BOT_WORKSPACE = workspace

const stateDir = join(home, 'storages', 'dsh-seeker-bot', 'personal-agent')

const outDir = mkdtempSync(join(tmpdir(), 'dsh-bot-delete-bundle-'))
let mod
try {
  const entry = join(outDir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export { purgeBot } from '${slash(resolve(ROOT, 'src/host/personal/bot-delete.ts'))}'`,
      `export { setBotSpecForgetter } from '${slash(resolve(ROOT, 'src/host/personal/runtime/registry.ts'))}'`,
      `export { scanBotOutputs, botOutputDirsOf } from '${slash(resolve(ROOT, 'src/host/personal/outputs.ts'))}'`,
      `export { listPages } from '${slash(resolve(ROOT, 'src/host/personal/pages.ts'))}'`,
      '',
    ].join('\n'),
    'utf8',
  )
  const bundleFile = join(outDir, 'bot-delete.mjs')
  await build({
    entryPoints: [entry],
    outfile: bundleFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  })
  mod = await import(pathToFileURL(bundleFile).href)
} catch (error) {
  console.error('打包失败：', error instanceof Error ? error.message : error)
  process.exit(1)
}

const { purgeBot, setBotSpecForgetter, scanBotOutputs, botOutputDirsOf, listPages } = mod

/** 造一个「被删 Bot」在宿主侧的全部残留。 */
function seedResidue(botId, { name = '残留助手', folder = '残留助手' } = {}) {
  mkdirSync(stateDir, { recursive: true })
  // 账本
  writeFileSync(join(stateDir, 'created-bots.json'), JSON.stringify([{
    id: botId, name, role: '测试', description: '', instructions: '', createdAt: Date.now(), createdBy: 'bot-main-xiaomo',
  }], null, 2), 'utf8')
  // 产出物映射
  writeFileSync(join(stateDir, 'bot-output-dirs.json'), JSON.stringify({ version: 1, bots: { [botId]: folder } }, null, 2), 'utf8')
  // 工作记忆
  mkdirSync(join(stateDir, 'working-memory'), { recursive: true })
  writeFileSync(join(stateDir, 'working-memory', `${botId}.json`), '[]', 'utf8')
  // 会话历史（两个工作区各一份，模拟切过工作区）
  for (const ws of ['--D-Seeker-Bot--', '--D-Other--']) {
    const dir = join(home, 'sessions', ws, `pa-bot-v2-${botId}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'fake', 'utf8')
  }
  // Bot 页面：在**产出物目录**下的「网页」子目录（不是状态目录）
  const pages = join(workspace, '产出物', folder, '网页')
  mkdirSync(pages, { recursive: true })
  writeFileSync(join(pages, 'a.html'), '<h1>a</h1>', 'utf8')
  // 产出物目录（用户的文件）
  const outputs = join(workspace, '产出物', folder)
  mkdirSync(outputs, { recursive: true })
  writeFileSync(join(outputs, 'report.md'), '# report', 'utf8')
  // 例行任务（`readRoutines` 要求 id / botId / schedule 三件齐全，缺一个就被过滤掉）
  writeFileSync(join(stateDir, 'routines.json'), JSON.stringify([
    { id: 'r1', botId, name: '每日简报', schedule: { kind: 'daily', time: '09:00' } },
  ], null, 2), 'utf8')
  writeFileSync(join(stateDir, 'proactive.json'), JSON.stringify([{ botId, enabled: true }], null, 2), 'utf8')
}

// ── 1. 护栏 ─────────────────────────────────────────────────────────────
console.log('\n# 护栏')

{
  const empty = await purgeBot('')
  assert(empty.ok === false && empty.error.includes('botId'), '空 botId 被拒绝')

  const main = await purgeBot('bot-main-xiaomo')
  assert(main.ok === false, '主 Bot 不能删')
  assert(main.error.includes('主 Bot'), '主 Bot 的拒绝理由说清了原因')
}

// ── 2. 完整清理 ─────────────────────────────────────────────────────────
console.log('\n# 完整清理')

const TARGET = 'bot-aaaabbbb'
seedResidue(TARGET)

// 造一个花名册移除的探针。**要模拟真实语义**：`specCache.forget()` 第二次就
// 删不到了（Map 里已经没这条），所以探针也必须第一次 true、之后 false——否则
// 幂等用例会被探针自己骗过。
const forgotten = []
const forgottenOnce = new Set()
setBotSpecForgetter((botId) => {
  if (forgottenOnce.has(botId)) return false
  forgottenOnce.add(botId)
  forgotten.push(botId)
  return true
})

const result = await purgeBot(TARGET)
assert(result.ok === true, '删除成功')
assert(forgotten.includes(TARGET), '花名册移除通道被调用（否则主 Bot 还能往它派活）')
assert(result.removed.includes('会话历史'), 'removed 里报告了会话历史')
assert(result.removed.includes('工作记忆'), 'removed 里报告了工作记忆')
assert(result.removed.includes('产出物映射'), 'removed 里报告了产出物映射')
assert(result.removed.includes('Bot 页面'), 'removed 里报告了 Bot 页面')
assert(result.removed.includes('创建账本'), 'removed 里报告了创建账本')
assert(result.removed.includes('例行任务'), 'removed 里报告了例行任务')
assert(result.removed.includes('主动询问配置'), 'removed 里报告了主动询问配置')

assert(!existsSync(join(home, 'sessions', '--D-Seeker-Bot--', `pa-bot-v2-${TARGET}`)), '当前工作区的会话目录已删')
assert(!existsSync(join(home, 'sessions', '--D-Other--', `pa-bot-v2-${TARGET}`)), '其它工作区的会话目录也已删（不留孤儿）')
assert(!existsSync(join(stateDir, 'working-memory', `${TARGET}.json`)), '工作记忆文件已删')
assert(!existsSync(join(workspace, '产出物', '残留助手', '网页')), 'Bot 页面目录已删')

{
  const map = JSON.parse(readFileSync(join(stateDir, 'bot-output-dirs.json'), 'utf8'))
  assert(map.bots[TARGET] === undefined, '产出物映射已摘掉')
}
{
  const ledger = JSON.parse(readFileSync(join(stateDir, 'created-bots.json'), 'utf8'))
  assert(!ledger.some((item) => item.id === TARGET), '创建账本里已没有它（下次打开不会被补发建回来）')
}
{
  const routines = JSON.parse(readFileSync(join(stateDir, 'routines.json'), 'utf8'))
  assert(routines.length === 0, '例行任务配置已清空该 Bot 的条目')
}
{
  const proactive = JSON.parse(readFileSync(join(stateDir, 'proactive.json'), 'utf8'))
  assert(proactive.length === 0, '主动询问配置已清空该 Bot 的条目')
}

// ── 3. 产出物目录默认保留 ───────────────────────────────────────────────
console.log('\n# 产出物目录')

{
  const outputDir = join(workspace, '产出物', '残留助手')
  assert(existsSync(join(outputDir, 'report.md')), '产出物文件默认保留（一个按钮不该无声删掉用户的东西）')
  assertEqual(result.outputDir, outputDir, '响应里带回产出物目录的绝对路径（前端据此提示用户）')
  assert(result.outputPurged !== true, '默认没有删文件')
}

// ── 4. purgeFiles 才连文件一起删 ────────────────────────────────────────
console.log('\n# purgeFiles')

const TARGET2 = 'bot-ccccdddd'
seedResidue(TARGET2, { name: '要清空', folder: '要清空' })
const purged = await purgeBot(TARGET2, { purgeFiles: true })
assert(purged.ok === true, '带 purgeFiles 的删除成功')
assert(purged.outputPurged === true, 'outputPurged 标记为 true')
assert(!existsSync(join(workspace, '产出物', '要清空')), '产出物目录被一起删掉')
assert(purged.removed.includes('产出物文件'), 'removed 里报告了产出物文件')

// ── 5. 幂等 ─────────────────────────────────────────────────────────────
console.log('\n# 幂等')

{
  const again = await purgeBot(TARGET)
  assert(again.ok === true, '重复删除同一个 Bot 不报错')
  assertEqual(again.removed.length, 0, `第二次什么也删不到（removed 为空；实际 ${JSON.stringify(again.removed)}）`)
}

// ── 6. 只读接口不会让已删 Bot 复活 ─────────────────────────────────────
console.log('\n# 只读接口不复活')

{
  /*
   * 实测踩到的坑：删掉一个 Bot、重启服务之后，右栏扫一次产出物，它的目录和映射
   * 又被建回来了——因为 `scanBotOutputs` / `pagesDir` 当时走的是
   * `ensureBotOutputDirs`（写路径：分配文件夹 + 补建 9 个分类目录 + 写映射）。
   * 只读接口带写副作用，等于「删了又回来」。
   *
   * 现在读路径一律走只读版本，这里钉住「读完之后映射和目录都没有变化」。
   */
  const GHOST = 'bot-ghost00'
  const mapFile = join(stateDir, 'bot-output-dirs.json')

  assert(botOutputDirsOf(GHOST) === undefined, '前置：这个 Bot 没有映射')

  const scan = scanBotOutputs(GHOST)
  assert(scan.ok === true && Array.isArray(scan.items) && scan.items.length === 0, 'scanBotOutputs 对没有映射的 Bot 返回空清单')

  const afterScan = JSON.parse(readFileSync(mapFile, 'utf8'))
  assert(afterScan.bots[GHOST] === undefined, 'scanBotOutputs 没有写回映射')
  // `sanitizeBotFolderName` 的兜底是 `Bot-<safeId 后四位>`
  assert(!existsSync(join(workspace, '产出物', 'Bot-st00')), 'scanBotOutputs 没有建目录')

  assertEqual(listPages(GHOST).length, 0, 'listPages 对没有映射的 Bot 返回空')
  const afterPages = JSON.parse(readFileSync(mapFile, 'utf8'))
  assert(afterPages.bots[GHOST] === undefined, 'listPages 也没有写回映射')
}

// ── 收尾 ────────────────────────────────────────────────────────────────
try {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
} catch { /* 临时目录清不掉不影响结论 */ }

console.log('')
if (failed === 0) console.log('全部通过')
else { console.error(`${failed} 项失败`); process.exitCode = 1 }
