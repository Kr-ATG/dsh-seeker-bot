/**
 * dsh-seeker-bot — KR 思考卡译文层回归测试（纯 Node ESM）。
 *
 * 测三层，每一层错了都不会抛错、只会表现为「译文不出来 / 出来是乱的 /
 * 缓存永远不命中」，所以只能断言：
 *
 *  1. **分片规则**（reasoning-translate.ts）：
 *     · 每片长度不超过官方 maxTextChars（host 侧按这个数判超限）；
 *     · 分片边界按行切（同一段文本两次切分结果一致 → 官方 Session 缓存能命中）；
 *     · 超长单行按码点硬切，不拆代理对（拆了就是乱码）；
 *     · 空文本不产生任何请求。
 *  2. **目标语言解析**：preferences.targetLanguage 非 auto 时逐字照用；
 *     auto 时跟随界面语言。
 *  3. **视图接线**（KrReasoningCard.tsx / ThinkingStepNodeView.tsx）：
 *     · 思考卡拿到 sessionId（否则官方缓存永远不命中）；
 *     · 切换按钮阻止冒泡（不点一下顺手把卡片收起来）；
 *     · 失败态保留原文。
 *
 * Usage: node scripts/test-reasoning-translation.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
const check = (condition, message) => {
  if (condition) console.log('ok    ' + message)
  else {
    failed += 1
    console.error('FAIL  ' + message)
  }
}
const readText = (relative) => readFileSync(join(ROOT, relative), 'utf8')

/** 子进程加载 TS 源并返回最后一行 JSON。 */
function runTsProbe(label, code) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env },
  })
  if (result.error !== undefined) throw new Error(label + ' 子进程启动失败：' + result.error.message)
  if (result.status !== 0) {
    throw new Error(
      label + ' 子进程退出码 ' + String(result.status)
      + '\n--- stderr ---\n' + result.stderr
      + '\n--- stdout ---\n' + result.stdout,
    )
  }
  const lines = String(result.stdout).split(/\r?\n/).filter((line) => line.trim() !== '')
  return JSON.parse(lines[lines.length - 1] ?? 'null')
}

// ── 1. 分片规则与语言解析（跑真实模块）──────────────────────────────
const moduleUrl = pathToFileURL(join(ROOT, 'src/client/kr-chat/reasoning-translate.ts')).href
const probeCode = [
  "const mod = await import(MODULE_URL)",
  "const out = {}",
  "const limit = 400",
  "const long = Array.from({ length: 200 }, (_, i) => 'line-' + i + ' ' + 'x'.repeat(30)).join('\\n')",
  "const chunks = mod.splitIntoChunks(long, limit)",
  "out.chunkCount = chunks.length",
  "out.maxChunkLen = Math.max(...chunks.map((c) => c.length))",
  "out.allWithinLimit = chunks.every((c) => c.length <= limit)",
  "out.stable = JSON.stringify(chunks) === JSON.stringify(mod.splitIntoChunks(long, limit))",
  "out.joinedLines = chunks.join('\\n').split('\\n').length",
  "out.emptyChunks = mod.splitIntoChunks('   \\n  ', limit).length",
  "const emoji = '\\u{1F600}'.repeat(500)",
  "const emojiChunks = mod.splitIntoChunks(emoji, limit)",
  "out.emojiChunks = emojiChunks.length",
  "out.emojiReconstruct = emojiChunks.join('') === emoji",
  "out.emojiWhole = emojiChunks.every((c) => !/\\uD83C(?:[\\uDC00-\\uDFFF]|$)/.test(c.slice(-1)))",
  "out.explicit = mod.resolveTargetLanguage('zh-CN', 'en')",
  "out.autoWithLocale = mod.resolveTargetLanguage('auto', 'ja')",
  "out.autoFallback = typeof mod.resolveTargetLanguage('auto', undefined)",
  "out.effectiveLimit = mod.effectiveLimit(4000)",
  "console.log(JSON.stringify(out))",
].join('\n').replace('MODULE_URL', JSON.stringify(moduleUrl))
const probe = runTsProbe('reasoning-translate', probeCode)

check(probe.chunkCount > 1, '长思考被切成多片（实际 ' + probe.chunkCount + ' 片）')
check(probe.allWithinLimit === true, '每片长度都不超过官方上限（实际最长 ' + probe.maxChunkLen + '）')
check(probe.stable === true, '分片边界稳定：同样输入两次切分结果一致（官方缓存靠这个命中）')
check(probe.joinedLines === 200, '切分后行数不丢内容（200 行进 / 出）')
check(probe.emptyChunks === 0, '空文本不产生任何请求')
check(probe.emojiChunks > 1, '超长单行被硬切成多片')
check(probe.emojiWhole === true, '硬切不拆代理对（不会产生半个 emoji）')
check(probe.emojiReconstruct === true, '硬切后拼回原文完全一致')
check(probe.explicit === 'zh-CN', '显式目标语言逐字照用（不跟随界面语言）')
check(probe.autoWithLocale === 'ja', 'auto 时跟随界面语言')
check(typeof probe.autoFallback === 'string', 'auto 且读不到界面语言时有兜底')
check(probe.effectiveLimit < 4000 && probe.effectiveLimit > 3000, '实际分片上限在官方上限之下留了余量（' + probe.effectiveLimit + '）')

// ── 2. 视图接线（静态断言）────────────────────────────────────────
const card = readText('src/client/kr-chat/KrReasoningCard.tsx')
const step = readText('src/client/thinking/ThinkingStepNodeView.tsx')
const hook = readText('src/client/kr-chat/use-reasoning-translation.ts')
const styles = readText('src/client/kr-chat/styles.ts')
const translate = readText('src/client/kr-chat/reasoning-translate.ts')

check(/sessionId=\{bodySessionId/.test(step), '思考卡拿得到会话 id（否则官方缓存永远不命中）')
check(/event\.stopPropagation\(\)/.test(card), '切换按钮阻止冒泡（点它不会顺手收起卡片）')
check(/useTranslationAvailability/.test(card), '思考卡接了服务可用性探测（不可用时不露出按钮）')
check(/showTranslation/.test(card), '视图区分原文 / 译文两侧')
check(/翻译失败，显示原文/.test(card), '失败态明说「显示原文」（不拿半截译文顶替）')
check(/\.kr-reasoning-translate\s*\{/.test(styles), '切换按钮有样式（不是裸按钮）')
check(/getService<[^>]*>\(`remote\.\$\{namespace\}`\)|getService\(`remote\.\$\{namespace\}`\)/.test(translate), 'remote 命名空间走 ctx.get(\'remote.<ns>\')（属性访问会撞 inject 闸门）')
check(/\.kr-reasoning-translate-status\s*\{/.test(styles), '状态提示有样式')
check(/state !== 'ready'/.test(hook), '译文未就绪时不切视图（状态不撒谎）')
check(/failed/.test(hook), '失败态被识别')

// ── 3. 自动翻译（用户要求「不用点」）──────────────────────────────
const autoStore = readText('src/client/kr-chat/auto-translate.ts')
const clientEntry = readText('src/client/index.ts')
const panel = readText('src/client/kr-chat/KrPanelSettings.tsx')

check(/autoTranslate:\s*autoTranslateOn/.test(card), '思考卡把自动翻译接到状态机')
check(/settled:\s*summarizing/.test(card), '自动翻译以「回合收口」为触发点（不是原文一变就翻）')
check(/useAutoTranslate/.test(card), '思考卡订阅自动翻译偏好（别的窗口改了也跟随）')
check(/installAutoTranslate/.test(clientEntry), '自动翻译偏好在 apply 时初始化（读盘 + 跨窗口监听）')
check(/STORAGE_KEY/.test(autoStore) && /localStorage/.test(autoStore), '自动翻译偏好落 localStorage（纯客户端表现偏好）')
check(/setAutoTranslateEnabled/.test(panel), '大盘设置提供自动翻译开关写入口')
check(/autoTranslateOn/.test(panel), '大盘设置订阅自动翻译偏好')
check(/enqueueAutoTranslate/.test(hook), '自动翻译走全局串行队列（长会话不并发风暴）')
check(/chunk\.id === index/.test(hook), '每片译文写回 chunks（否则 state=ready 却仍显示原文）')
check(/wasReadyRef/.test(card), '译文就绪后自动切到译文视图（不用再点一次）')
check(!/console\.debug/.test(hook), '译文层没有遗留临时诊断日志')

if (failed > 0) {
  console.error('\nFAILED — ' + failed + ' 项')
  process.exit(1)
}
console.log('\nALL PASSED')
