/**
 * dsh-seeker-bot — Bot 产出物目录与扫描的回归测试（scripts/test-bot-outputs.mjs）。
 *
 * 覆盖 `src/host/personal/outputs.ts` 的可观察行为：
 *
 *  1. 目录分配幂等：同一 botId 重复调用返回同一个 folder，映射文件只落一条；
 *  2. 固定 9 个中文分类子目录总是被创建；
 *  3. 改名不迁移文件夹（映射固定）；
 *  4. 重名追加 `-<safeId 后四位>`；
 *  5. 扫描按 mtime 降序，最多 200 条；
 *  6. 跳过隐藏文件（`.` 开头）与 `~$` 临时文件；
 *  7. 分类目录 / 根目录 / 未知子目录的 kind 与 category 映射；
 *  8. 归档复制：`_tmp` 里的交付文件复制进对应分类目录，源文件保留；
 *     重复归档幂等；同名不同大小追加 `-2`；产出物目录内的文件不复制。
 *
 * 环境隔离：DSH_HOME 与 DSH_SEEKER_BOT_WORKSPACE 都指到系统临时目录，
 * 不碰真实的 `~/.dsh` 与 `D:\Seeker-Bot`。
 *
 * 直接用 Node 运行（Node 22.18+ / 24 原生剥离 TS 类型）：
 *   node scripts/test-bot-outputs.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** 测试根目录：所有写入都落在这里，结束时整体删除。 */
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-bot-outputs-test-'))
process.env.DSH_HOME = join(tempRoot, 'dsh-home')
const workspace = join(tempRoot, 'workspace')
process.env.DSH_SEEKER_BOT_WORKSPACE = workspace

let failed = 0
const pass = (msg) => console.log(`✓ ${msg}`)
const fail = (msg) => {
  failed += 1
  console.error(`✗ ${msg}`)
}
const assert = (cond, msg) => {
  if (cond) pass(msg)
  else fail(msg)
}
const assertEqual = (actual, expected, msg) => {
  if (actual === expected) pass(msg)
  else fail(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

const categories = ['图片', '视频', '音频', '文档', '表格', '演示', '网页', 'PDF', '其他']

try {
  const outputs = await import(pathToFileURL(join(ROOT, 'src', 'host', 'personal', 'outputs.ts')).href)
  const mapFile = join(process.env.DSH_HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'bot-output-dirs.json')

  /* ── 1. 目录分配：幂等、持久化、改名不迁移 ─────────────────────────── */

  const alpha = outputs.ensureBotOutputDirs('bot-alpha', '小析')
  assertEqual(alpha.folder, '小析', '首次分配用 Bot 名字作为文件夹名')
  assertEqual(alpha.root, join(workspace, '产出物', '小析'), '产出物根 = <workspace>/产出物/<folder>')

  const alphaAgain = outputs.ensureBotOutputDirs('bot-alpha', '小析')
  assertEqual(alphaAgain.folder, alpha.folder, '重复调用 folder 不变（幂等）')
  assertEqual(alphaAgain.root, alpha.root, '重复调用 root 不变（幂等）')

  assert(existsSync(mapFile), '目录映射文件已落盘')
  const map = JSON.parse(readFileSync(mapFile, 'utf8'))
  assertEqual(map.version, 1, '映射文件 schema version = 1')
  assertEqual(Object.keys(map.bots).length, 1, '映射文件只记录一个 bot')
  assertEqual(map.bots['bot-alpha'], '小析', '映射记录 botId → folder')

  const renamed = outputs.ensureBotOutputDirs('bot-alpha', '改过的名字')
  assertEqual(renamed.folder, '小析', 'Bot 改名不迁移文件夹（映射固定）')

  /* ── 2. 9 个分类子目录 ────────────────────────────────────────────── */

  assertEqual(outputs.BOT_OUTPUT_CATEGORIES.length, 9, '分类目录固定 9 个')
  assertEqual(outputs.BOT_OUTPUT_CATEGORIES.join(','), categories.join(','), '分类目录顺序与契约一致')
  for (const category of categories) {
    const dir = join(alpha.root, category)
    assert(existsSync(dir) && statSync(dir).isDirectory(), `分类子目录已创建：${category}`)
  }
  // 用户手动删掉某个分类目录后，下一次 ensure 要补回来
  rmSync(join(alpha.root, '其他'), { recursive: true, force: true })
  outputs.ensureBotOutputDirs('bot-alpha', '小析')
  assert(existsSync(join(alpha.root, '其他')), '被删掉的分类子目录会在下一次 ensure 时补建')

  /* ── 3. 重名：追加 safeId 后四位 ──────────────────────────────────── */

  const beta = outputs.ensureBotOutputDirs('bot-beta', '小析')
  assertEqual(beta.folder, '小析-beta', '重名文件夹追加 -<safeId 后四位>')
  assertEqual(beta.root, join(workspace, '产出物', '小析-beta'), '重名 bot 的 root 指向去重后的文件夹')
  const betaAgain = outputs.ensureBotOutputDirs('bot-beta', '小析')
  assertEqual(betaAgain.folder, '小析-beta', '重名分配同样幂等')
  assertEqual(JSON.parse(readFileSync(mapFile, 'utf8')).bots['bot-beta'], '小析-beta', '重名映射已持久化')

  /* ── 4. 扫描：mtime 降序、字段形状 ────────────────────────────────── */

  const imageDir = join(alpha.root, '图片')
  const docDir = join(alpha.root, '文档')
  writeFileSync(join(imageDir, 'older.png'), Buffer.from('older-image-bytes'))
  writeFileSync(join(imageDir, 'newer.png'), Buffer.from('newer-image-bytes'))
  writeFileSync(join(docDir, 'middle.md'), Buffer.from('# 中间的文件'))

  const now = Date.now()
  utimesSync(join(imageDir, 'older.png'), new Date(now - 5000), new Date(now - 5000))
  utimesSync(join(docDir, 'middle.md'), new Date(now - 3000), new Date(now - 3000))
  utimesSync(join(imageDir, 'newer.png'), new Date(now - 1000), new Date(now - 1000))

  const firstScan = outputs.scanBotOutputs('bot-alpha', '小析')
  assertEqual(firstScan.ok, true, '扫描成功')
  assertEqual(firstScan.folder, '小析', '扫描结果带 folder')
  assertEqual(firstScan.root, resolve(alpha.root), '扫描结果带绝对 root')
  assertEqual(firstScan.botId, 'bot-alpha', '扫描结果带 botId')
  assert(Array.isArray(firstScan.items), '扫描结果带 items 数组')
  assertEqual(
    firstScan.items.slice(0, 3).map((item) => item.name).join(','),
    'newer.png,middle.md,older.png',
    '扫描按 mtime 降序',
  )

  const newer = firstScan.items.find((item) => item.name === 'newer.png')
  assert(newer !== undefined, '扫描结果包含 newer.png')
  if (newer !== undefined) {
    assertEqual(newer.path, '产出物/小析/图片/newer.png', 'item.path 是相对工作区的正斜杠路径')
    assertEqual(
      newer.url,
      `/api/personal-agent/file?path=${encodeURIComponent(newer.path)}`,
      'item.url 走 /file + encodeURIComponent',
    )
    assertEqual(newer.kind, 'image', 'png → kind=image')
    assertEqual(newer.category, '图片', '分类目录里的 png → category=图片')
    assertEqual(newer.size, Buffer.byteLength('newer-image-bytes'), 'item.size 是真实字节数')
    assert(typeof newer.time === 'number' && newer.time > 0, 'item.time 是毫秒时间戳')
  }
  const middle = firstScan.items.find((item) => item.name === 'middle.md')
  assertEqual(middle?.kind, 'doc', 'md → kind=doc')
  assertEqual(middle?.category, '文档', '分类目录里的 md → category=文档')

  /* ── 5. 跳过隐藏文件与 ~$ 临时文件；根 / 未知子目录也要扫到 ─────────── */

  writeFileSync(join(imageDir, '.hidden.png'), Buffer.from('hidden'))
  writeFileSync(join(imageDir, '~$draft.docx'), Buffer.from('office lock file'))
  writeFileSync(join(alpha.root, '.secret.txt'), Buffer.from('secret'))
  writeFileSync(join(alpha.root, '~$root.docx'), Buffer.from('office lock file'))
  writeFileSync(join(alpha.root, 'loose.pdf'), Buffer.from('%PDF-1.4 loose'))
  const miscDir = join(alpha.root, '杂项')
  mkdirSync(miscDir, { recursive: true })
  writeFileSync(join(miscDir, 'note.txt'), Buffer.from('unknown subdir file'))

  // 各类别映射：各分类目录放一个文件
  const kindFixtures = [
    ['视频', 'clip.mp4', 'video'],
    ['音频', 'voice.mp3', 'audio'],
    ['表格', 'data.csv', 'sheet'],
    ['演示', 'slides.pptx', 'slide'],
    ['网页', 'index.html', 'page'],
    ['其他', 'archive.zip', 'archive'],
    ['PDF', 'manual.pdf', 'pdf'],
  ]
  for (const [category, fileName, kind] of kindFixtures) {
    const dir = join(alpha.root, category)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, fileName), Buffer.from(`fixture:${fileName}`))
    const item = outputs.scanBotOutputs('bot-alpha', '小析').items.find((entry) => entry.name === fileName)
    assertEqual(item?.kind, kind, `${fileName} → kind=${kind}`)
    assertEqual(item?.category, category, `${fileName} → category=${category}`)
  }

  const filtered = outputs.scanBotOutputs('bot-alpha', '小析')
  const names = filtered.items.map((item) => item.name)
  assert(!names.includes('.hidden.png'), '跳过 . 开头的隐藏文件')
  assert(!names.includes('~$draft.docx'), '跳过 ~$ 临时文件')
  assert(!names.includes('.secret.txt'), '跳过根目录的隐藏文件')
  assert(!names.includes('~$root.docx'), '跳过根目录的 ~$ 临时文件')

  const loose = filtered.items.find((item) => item.name === 'loose.pdf')
  assertEqual(loose?.kind, 'pdf', '根目录的 pdf → kind=pdf')
  assertEqual(loose?.category, 'PDF', '根目录文件按扩展名归入默认分类')
  const unknown = filtered.items.find((item) => item.name === 'note.txt')
  assertEqual(unknown?.kind, 'doc', '未知子目录里的 txt → kind=doc')
  assertEqual(unknown?.category, '文档', '未知子目录里的文件按扩展名分类')
  assertEqual(unknown?.path, '产出物/小析/杂项/note.txt', '未知子目录路径保留子目录名')

  // 上限：>200 个文件时只回 200 条（放在独立 bot，避免污染上面的断言）
  const bulk = outputs.ensureBotOutputDirs('bot-bulk', '批量')
  for (let index = 0; index < 205; index += 1) {
    writeFileSync(join(bulk.root, '图片', `bulk-${String(index).padStart(3, '0')}.png`), Buffer.from('x'))
  }
  const bulkScan = outputs.scanBotOutputs('bot-bulk', '批量')
  assertEqual(bulkScan.items.length, 200, '扫描结果最多 200 条')

  /* ── 6. 归档复制：_tmp 里的交付文件 → 分类目录 ─────────────────────── */

  const archiveBot = outputs.ensureBotOutputDirs('bot-archive', '归档员')
  const tmpDir = join(workspace, '_tmp')
  mkdirSync(tmpDir, { recursive: true })
  const sourceImage = join(tmpDir, 'archived-shot.png')
  writeFileSync(sourceImage, Buffer.from('fake png payload for archive test'))

  const archived = outputs.archiveArtifactFile('bot-archive', '归档员', sourceImage)
  assertEqual(archived.ok, true, '归档返回 ok')
  assertEqual(archived.copied, true, '首次归档确实复制了文件')
  assertEqual(archived.path, '产出物/归档员/图片/archived-shot.png', '归档路径按扩展名落到 图片/')
  assert(existsSync(sourceImage), '归档不删除源文件')
  assert(existsSync(join(archiveBot.root, '图片', 'archived-shot.png')), '归档文件出现在图片分类目录')
  const archivedScan = outputs.scanBotOutputs('bot-archive', '归档员')
  assert(
    archivedScan.items.some((item) => item.name === 'archived-shot.png' && item.category === '图片'),
    '归档后的文件能被扫描到（右栏产出物卡可见）',
  )

  // 幂等：同名同大小 → 跳过，不再复制
  const archivedAgain = outputs.archiveArtifactFile('bot-archive', '归档员', sourceImage)
  assertEqual(archivedAgain.ok, true, '重复归档返回 ok')
  assertEqual(archivedAgain.copied, false, '同名同大小视为已归档，跳过复制')
  assertEqual(archivedAgain.path, archived.path, '重复归档返回同一路径')

  // 同名但大小不同 → 追加 -2
  const uploadsDir = join(workspace, 'uploads')
  mkdirSync(uploadsDir, { recursive: true })
  const conflicting = join(uploadsDir, 'archived-shot.png')
  writeFileSync(conflicting, Buffer.from('a completely different payload with another length'))
  const conflict = outputs.archiveArtifactFile('bot-archive', '归档员', conflicting)
  assertEqual(conflict.ok, true, '同名冲突时归档返回 ok')
  assertEqual(conflict.copied, true, '同名冲突时确实复制')
  assertEqual(conflict.path, '产出物/归档员/图片/archived-shot-2.png', '同名冲突追加 -2 后缀')

  // 已经在产出物目录内的文件：不复制
  const alreadyInside = join(archiveBot.root, '文档', 'already.md')
  writeFileSync(alreadyInside, Buffer.from('# 已在产出物目录'))
  const inside = outputs.archiveArtifactFile('bot-archive', '归档员', alreadyInside)
  assertEqual(inside.ok, true, '产出物目录内的文件返回 ok')
  assertEqual(inside.copied, false, '产出物目录内的文件不重复复制')

  // 工作区外的文件：拒绝（避免把系统文件复制进产出物）
  const outsideFile = join(tempRoot, 'outside.png')
  writeFileSync(outsideFile, Buffer.from('outside workspace'))
  const outside = outputs.archiveArtifactFile('bot-archive', '归档员', outsideFile)
  assertEqual(outside.ok, false, '工作区外的文件拒绝归档')

  /* ── 7. runBotTurn 收口接线：artifacts → 自动归档 ───────────────────── */

  /*
   * 上面测的是 archiveArtifactFile 本身；这一段验证 agent.ts 真的在收口时调用它。
   * 用最小 fake ctx / fake agent 驱动 runBotTurn（不依赖真实 DSH）：
   *   · tool/result 文本里出现 `_tmp/run-report.docx` → 被识别成 artifacts；
   *   · turn 收口 → 自动复制进 `产出物/<folder>/文档/`；
   *   · 同时断言提示词里确实有「产出物归档（硬要求）」段（含 9 个分类映射）。
   */
  const { runBotTurn } = await import(pathToFileURL(join(ROOT, 'src', 'host', 'personal', 'agent.ts')).href)

  const runBotId = 'archive-run-bot'
  const runBotName = '归档机器人'
  const runSessionId = `pa-bot-v2-${runBotId}`
  const promptSections = []
  const agentListeners = new Set()
  const runSession = {
    id: runSessionId,
    header: { cwd: workspace },
    append() {},
    surface: { nodes: [] },
  }
  let seq = 0
  const emitEvent = (type, data) => {
    seq += 1
    for (const handler of [...agentListeners]) {
      handler(runSession, { seq, type, time: Date.now(), data })
    }
  }
  const fakeAgent = {
    session: runSession,
    ctx: {
      on(type, handler) {
        if (type !== 'session/event') return () => {}
        agentListeners.add(handler)
        return () => agentListeners.delete(handler)
      },
      systemPrompt: { section(input) { promptSections.push(input) } },
      tools: { register() {} },
    },
    inject() {},
    model: { select() {} },
    followup() {
      emitEvent('tool/call', {
        callId: 'call-archive-1',
        name: 'pwsh',
        arguments: JSON.stringify({ command: 'python make_report.py' }),
      })
      emitEvent('tool/result', {
        message: { toolCallId: 'call-archive-1', content: [{ type: 'text', text: '已生成 _tmp/run-report.docx' }] },
      })
      emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '报告好了。' }] } })
      emitEvent('turn/end', { reason: 'stop' })
    },
  }
  const fakeCtx = {
    on: () => () => {},
    get(name) {
      return name === 'agents' ? fakeCtx.agents : undefined
    },
    agents: {
      get: () => undefined,
      create: async ({ setup }) => {
        if (typeof setup === 'function') await setup(fakeAgent.ctx)
        return { agent: fakeAgent }
      },
    },
  }

  const runDocx = join(workspace, '_tmp', 'run-report.docx')
  writeFileSync(runDocx, Buffer.from('PK fake run docx payload'))
  const turn = await runBotTurn(fakeCtx, {
    botId: runBotId,
    name: runBotName,
    role: '助手',
    description: '',
    instructions: '',
    model: { provider: 'test-provider', model: 'test-model' },
  }, '把结论整理成 Word', () => {})
  assertEqual(turn.ok, true, 'runBotTurn 跑完一轮（fake agent）')

  const identity = promptSections.find((item) => item?.name === 'personal-agent:bot-identity')
  assert(identity !== undefined, 'Bot 身份提示词已注册')
  assert(
    String(identity?.text ?? '').includes('## 产出物归档（硬要求）'),
    '提示词包含「产出物归档（硬要求）」段落',
  )
  for (const category of categories) {
    assert(
      String(identity?.text ?? '').includes(`→ ${category}/`),
      `提示词列出分类映射：${category}`,
    )
  }

  const runRoot = join(workspace, '产出物', outputs.ensureBotOutputDirs(runBotId, runBotName).folder)
  assert(existsSync(join(runRoot, '文档', 'run-report.docx')), 'runBotTurn 收口时把 _tmp 交付文件归档到 文档/')
  assert(existsSync(runDocx), '自动归档后源文件仍在 _tmp（不删除）')
  const runScan = outputs.scanBotOutputs(runBotId, runBotName)
  assert(
    runScan.items.some((item) => item.name === 'run-report.docx' && item.category === '文档'),
    '自动归档的文件出现在产出物扫描结果里',
  )
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发占用：临时目录由系统清理 */
  }
}

if (failed > 0) {
  console.error(`\n[bot outputs] ${failed} 项断言失败`)
  process.exitCode = 1
} else {
  console.log('\n[bot outputs] PASS')
}
