#!/usr/bin/env node
/**
 * Personal Agent — 通话时长口径一致性自测。
 *
 * 背景（用户报的 bug）：一通 16.5 秒的实时语音通话，对话流折叠条显示 `00:16`，
 * 挂断提示却写「通话已结束 · 17 秒」。原因是同一个 `durationMs` 被两种口径格式化：
 *
 *   · 折叠条 / 通话弹层 / 右栏计时 —— `formatDuration` 走 `Math.floor`（00:16）
 *   · 挂断 toast —— 就地 `Math.round(durationMs / 1000)`（17 秒）
 *
 * 修复口径：`formatDurationSeconds(ms)` 成为全应用唯一的「毫秒 → 整秒」入口，
 * `formatDuration` 复用它，任何「N 秒」文案也必须用它。本测试锁死这条约定。
 *
 * 两层检查：
 *  1. **静态断言**：读 `types.ts` / `store.tsx` 源码，确认口径统一、旧写法已消失；
 *  2. **运行时断言**：用项目自带 esbuild 把 `types.ts` 打成临时 ESM，直接调函数，
 *     验证 floor 语义 + `formatDuration` 与秒数永不漂移。esbuild 不可用时跳过。
 *
 * 运行：`node scripts/test-call-duration.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const typesPath = join(root, 'src/client/personal/types.ts')
const storePath = join(root, 'src/client/personal/store.tsx')
const blockViewPath = join(root, 'src/client/personal/chat/MessageBlockView.tsx')

let passed = 0
let skipped = 0

function ok(label) {
  passed += 1
  console.log(`  ✓ ${label}`)
}

function skip(label) {
  skipped += 1
  console.log(`  - 跳过：${label}`)
}

function expectContains(source, needle, label) {
  assert.ok(source.includes(needle), `${label} 缺少关键实现：${needle}`)
  ok(label)
}

function expectAbsent(source, needle, label) {
  assert.ok(!source.includes(needle), `${label} 不应再出现：${needle}`)
  ok(label)
}

// ── 1. 静态断言：口径统一在 types.ts，调用方不再就地取整 ──
console.log('[call-duration] 静态断言')

const typesSource = await readFile(typesPath, 'utf8')
const storeSource = await readFile(storePath, 'utf8')
const blockViewSource = await readFile(blockViewPath, 'utf8')

expectContains(typesSource, 'export function formatDurationSeconds', 'types 导出唯一的毫秒→整秒入口 formatDurationSeconds')
expectContains(typesSource, 'const total = formatDurationSeconds(ms)', 'formatDuration 复用 formatDurationSeconds（不再各自 floor）')
// 裸毫秒取整只允许出现在 formatDurationSeconds 里：formatDuration 自己的函数体必须干净。
// （分钟那一层 `Math.floor(total / 60)` 是 mm:ss 组装需要的，不算违规。）
const formatDurationBody = typesSource.slice(typesSource.indexOf('export function formatDuration('))
expectAbsent(formatDurationBody, 'Math.floor(ms', 'formatDuration 函数体内不再自己对毫秒取整')
expectContains(typesSource, '向下取整', 'formatDurationSeconds 注明 floor 语义')

expectContains(storeSource, '${formatDurationSeconds(durationMs)} 秒', '挂断提示的秒数走 formatDurationSeconds')
expectAbsent(storeSource, 'Math.round(durationMs / 1000)', '挂断提示不再就地 Math.round（这就是 00:16 vs 17 秒的根因）')
expectContains(storeSource, 'formatDurationSeconds,', 'store 从 types 显式导入 formatDurationSeconds')

expectContains(blockViewSource, 'formatDuration(block.durationMs)', '对话流折叠条用 formatDuration 显示时长')
expectContains(blockViewSource, 'formatDuration(', 'MessageBlockView 从 types 导入 formatDuration')

// ── 2. 运行时断言：floor 语义 + 两条显示路径永不漂移 ──
console.log('[call-duration] 运行时断言')

let tempDir = null
try {
  const esbuild = await import('esbuild')
  const build = esbuild.build ?? esbuild.default?.build
  assert.equal(typeof build, 'function', 'esbuild.build 不可用')

  tempDir = await mkdtemp(join(tmpdir(), 'call-duration-test-'))
  const outfile = join(tempDir, 'types.mjs')
  await build({
    entryPoints: [typesPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  })
  const types = await import(pathToFileURL(outfile).href)
  const { formatDuration, formatDurationSeconds } = types
  assert.equal(typeof formatDuration, 'function', 'formatDuration 未导出')
  assert.equal(typeof formatDurationSeconds, 'function', 'formatDurationSeconds 未导出')

  // 2.1 用户截图里的那个时刻：16.5 秒。折叠条 00:16，提示必须也是 16 秒。
  assert.equal(formatDurationSeconds(16_500), 16, '16.5 秒应算 16 秒（floor）')
  assert.equal(formatDuration(16_500), '00:16', '16.5 秒的 mm:ss 是 00:16')
  assert.equal(
    `通话已结束 · ${formatDurationSeconds(16_500)} 秒`,
    '通话已结束 · 16 秒',
    '挂断提示与折叠条同口径（原来这里会是 17 秒）',
  )
  ok('16.5 秒：折叠条 00:16 与提示「16 秒」一致')

  // 2.2 边界：不足 1 秒 / 正好 1 秒 / 59.999 秒 / 正好 1 分钟 / 超 1 小时。
  const cases = [
    [0, 0, '00:00'],
    [999, 0, '00:00'],
    [1000, 1, '00:01'],
    [16_999, 16, '00:16'],
    [59_999, 59, '00:59'],
    [60_000, 60, '01:00'],
    [3_599_000, 3599, '59:59'],
    [3_600_000, 3600, '60:00'],
  ]
  for (const [ms, seconds, clock] of cases) {
    assert.equal(formatDurationSeconds(ms), seconds, `${ms}ms 的整秒数应为 ${seconds}`)
    assert.equal(formatDuration(ms), clock, `${ms}ms 的 mm:ss 应为 ${clock}`)
  }
  ok('边界值 0 / 999 / 1000 / 59999 / 60000 / 1h 全部按 floor 一致')

  // 2.3 非法值兜底：负时长与 NaN 不能显示成 NaN 或负数。
  assert.equal(formatDurationSeconds(-500), 0, '负时长兜底 0')
  assert.equal(formatDurationSeconds(Number.NaN), 0, 'NaN 兜底 0')
  assert.equal(formatDuration(Number.NaN), '00:00', 'NaN 的 mm:ss 兜底 00:00')
  ok('负时长 / NaN 兜底为 0，不会渲染出 NaN 或负数')

  // 2.4 穷举一致性：mm:ss 换算回来的秒数必须恒等于 formatDurationSeconds。
  //     这条直接锁死「两条显示路径各自取整」的回归——步长取 137ms 避免整齐对齐掩盖误差。
  for (let ms = 0; ms <= 200_000; ms += 137) {
    const clock = formatDuration(ms)
    const match = /^(\d{2,}):(\d{2})$/.exec(clock)
    assert.ok(match !== null, `${ms}ms 的 mm:ss 格式不对：${clock}`)
    const fromClock = Number(match[1]) * 60 + Number(match[2])
    assert.equal(fromClock, formatDurationSeconds(ms), `${ms}ms：mm:ss 与整秒数漂移了（${clock} vs ${formatDurationSeconds(ms)}）`)
  }
  ok('0–200 秒按 137ms 步长穷举：mm:ss 与整秒数恒等')
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package) 'esbuild'/.test(String(error?.message))) {
    skip('未找到 esbuild，运行时断言跳过（静态断言已覆盖口径统一）')
  } else {
    throw error
  }
} finally {
  if (tempDir !== null) await rm(tempDir, { recursive: true, force: true })
}

console.log(`\n[call-duration] 通过 ${passed} 项${skipped > 0 ? `，跳过 ${skipped} 项` : ''}`)
