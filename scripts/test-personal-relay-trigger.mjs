#!/usr/bin/env node
/**
 * Personal Agent 上下文接力触发自测（第 2 步）。
 *
 * 两层：
 *  1. **运行时冒烟**：用项目自带 esbuild 把 src/client/personal/relay-trigger.ts 打成
 *     临时 ESM 包再 import，覆盖 normalizeRelayAuto / looksLikeTopicSwitch /
 *     evaluateRelayTrigger / relayHintKey 的核心语义。
 *  2. **源码断言**：ChatPanel 是否接上 /api/personal-agent/context 与 pa-relay-hint、
 *     「去整理」是否只调 setClearTarget（不自动清空）；BotSettingsCard 是否有
 *     「上下文接力」与 relayAuto；store / types / chat.css 是否补齐对应字段与样式。
 *
 * 运行：node scripts/test-personal-relay-trigger.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const relayPath = join(root, 'src/client/personal/relay-trigger.ts')
const typesPath = join(root, 'src/client/personal/types.ts')
const storePath = join(root, 'src/client/personal/store.tsx')
const chatPanelPath = join(root, 'src/client/personal/chat/ChatPanel.tsx')
const chatCssPath = join(root, 'src/client/personal/chat/chat.css.ts')
const botSettingsPath = join(root, 'src/client/personal/shell/BotSettingsCard.tsx')

let passed = 0

function ok(label) {
  passed += 1
  console.log('  ✓ ' + label)
}

function expectContains(source, needle, label) {
  assert.ok(source.includes(needle), label + ' 缺少关键实现：' + needle)
  ok(label)
}

console.log('[relay-trigger] 运行时冒烟：src/client/personal/relay-trigger.ts')

let runtimeChecked = false
let tempDir = null
try {
  const esbuild = await import('esbuild')
  const build = esbuild.build ?? esbuild.default?.build
  assert.equal(typeof build, 'function', 'esbuild.build 不可用')

  tempDir = await mkdtemp(join(tmpdir(), 'relay-trigger-test-'))
  const outfile = join(tempDir, 'relay-trigger.mjs')
  await build({
    entryPoints: [relayPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    logLevel: 'silent',
  })
  const relay = await import(pathToFileURL(outfile).href)
  const {
    DEFAULT_RELAY_AUTO,
    normalizeRelayAuto,
    looksLikeTopicSwitch,
    evaluateRelayTrigger,
    relayHintKey,
  } = relay

  /* ── normalizeRelayAuto ─────────────────────────────────────────────── */
  assert.deepEqual(DEFAULT_RELAY_AUTO, { mode: 'prompt', softRatio: 0.3, hardRatio: 0.6, idleHours: 8 })
  ok('DEFAULT_RELAY_AUTO 为 prompt / 0.3 / 0.6 / 8')
  assert.deepEqual(normalizeRelayAuto(undefined), DEFAULT_RELAY_AUTO)
  assert.deepEqual(normalizeRelayAuto(null), DEFAULT_RELAY_AUTO)
  assert.deepEqual(normalizeRelayAuto({}), DEFAULT_RELAY_AUTO)
  assert.deepEqual(normalizeRelayAuto('bad-shape'), DEFAULT_RELAY_AUTO)
  ok('缺失 / 非对象设置回落到默认值')

  const badMode = normalizeRelayAuto({ mode: 'bogus', softRatio: -1, hardRatio: 9, idleHours: 0 })
  assert.equal(badMode.mode, 'prompt')
  assert.equal(badMode.softRatio, 0.05)
  assert.equal(badMode.hardRatio, 0.95)
  assert.equal(badMode.idleHours, 1)
  ok('mode 非法回 prompt，比例 / 小时数钳到下限')

  const high = normalizeRelayAuto({ mode: 'auto', softRatio: 0.999, hardRatio: 0.001, idleHours: 999 })
  assert.equal(high.mode, 'auto')
  assert.equal(high.softRatio, 0.95)
  assert.equal(high.hardRatio, 0.05)
  assert.equal(high.idleHours, 72)
  ok('合法 mode 保留，比例 / 小时数钳到上限')

  const numericStrings = normalizeRelayAuto({ softRatio: '0.42', hardRatio: '0.7', idleHours: '12' })
  assert.equal(numericStrings.softRatio, 0.42)
  assert.equal(numericStrings.hardRatio, 0.7)
  assert.equal(numericStrings.idleHours, 12)
  ok('数字字符串也能归一化（设置卡 input 直接透传）')

  /* ── looksLikeTopicSwitch ───────────────────────────────────────────── */
  const switchedMessages = [
    { role: 'user', text: '帮我排查数据库连接池报错的原因' },
    { role: 'bot', text: '先检查最大连接数和空闲超时设置' },
    { role: 'user', text: '推荐几家附近适合聚餐的川菜馆' },
  ]
  assert.equal(looksLikeTopicSwitch(switchedMessages), true)
  ok('换话题（bigram 相似度 < 0.06）返回 true')

  const sameTopicMessages = [
    { role: 'user', text: '帮我排查数据库连接池报错的原因' },
    { role: 'bot', text: '先检查最大连接数和空闲超时设置' },
    { role: 'user', text: '数据库连接池最大连接数该怎么配置' },
  ]
  assert.equal(looksLikeTopicSwitch(sameTopicMessages), false)
  ok('同一话题（高重叠）返回 false')

  assert.equal(looksLikeTopicSwitch([
    { role: 'user', text: '帮我排查数据库连接池报错的原因' },
    { role: 'bot', text: '先检查最大连接数和空闲超时设置' },
    { role: 'user', text: '继续刚才数据库连接池那个问题' },
  ]), false)
  ok('含延续词（继续 / 刚才）不算换话题')

  assert.equal(looksLikeTopicSwitch([
    { role: 'user', text: '帮我排查数据库连接池报错的原因' },
    { role: 'user', text: '好的' },
  ]), false)
  ok('最后一条 user 少于 6 字返回 false')

  assert.equal(looksLikeTopicSwitch([{ role: 'user', text: '推荐几家附近适合聚餐的川菜馆' }]), false)
  ok('没有历史消息时不判换话题')

  const blockMessages = [
    { role: 'user', blocks: [{ type: 'text', text: '帮我排查数据库连接池报错的原因' }] },
    { role: 'bot', blocks: [{ type: 'text', text: '先检查最大连接数和空闲超时设置' }] },
    { role: 'user', blocks: [{ type: 'text', text: '推荐几家附近适合聚餐的川菜馆' }] },
  ]
  assert.equal(looksLikeTopicSwitch(blockMessages), true)
  ok('兼容 Message.blocks 形态（不只 text 字段）')

  /* ── evaluateRelayTrigger ───────────────────────────────────────────── */
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  const usage = (percent) => ({ usedTokens: Math.round(percent * 1000), contextWindow: 100000, percent })
  const recent = now - 60_000

  assert.equal(evaluateRelayTrigger({
    usage: usage(90), lastUserAt: recent, now, messages: switchedMessages, settings: DEFAULT_RELAY_AUTO,
  }).kind, 'hard')
  ok('hard 优先：占用 90% 命中硬阈值')

  assert.equal(evaluateRelayTrigger({
    usage: usage(90), lastUserAt: recent, now, messages: switchedMessages,
    settings: { ...DEFAULT_RELAY_AUTO, mode: 'off' },
  }), null)
  ok('mode=off 一律返回 null')

  assert.equal(evaluateRelayTrigger({
    usage: null, lastUserAt: recent, now, messages: switchedMessages, settings: DEFAULT_RELAY_AUTO,
  }), null)
  ok('usage 为 null 返回 null')

  const hard = evaluateRelayTrigger({
    usage: usage(70), lastUserAt: recent, now, messages: sameTopicMessages, settings: DEFAULT_RELAY_AUTO,
  })
  assert.equal(hard.kind, 'hard')
  assert.equal(hard.percent, 70)
  assert.ok(hard.title.length > 0 && hard.detail.includes('70%'))
  ok('hard 不看话题，且文案带百分比')

  assert.equal(evaluateRelayTrigger({
    usage: usage(40), lastUserAt: recent, now, messages: sameTopicMessages, settings: DEFAULT_RELAY_AUTO,
  }), null)
  ok('soft 档位：未换话题时不提示')

  const soft = evaluateRelayTrigger({
    usage: usage(40), lastUserAt: recent, now, messages: switchedMessages, settings: DEFAULT_RELAY_AUTO,
  })
  assert.equal(soft.kind, 'soft')
  assert.equal(soft.percent, 40)
  ok('soft 档位：达到软阈值 + 换话题才提示')

  const idle = evaluateRelayTrigger({
    usage: usage(25), lastUserAt: now - 9 * 3_600_000, now, messages: [], settings: DEFAULT_RELAY_AUTO,
  })
  assert.equal(idle.kind, 'idle')
  assert.ok(idle.title.includes('9'))
  assert.equal(idle.percent, 25)
  ok('idle：空闲 9 小时且占用 25% 命中')

  assert.equal(evaluateRelayTrigger({
    usage: usage(10), lastUserAt: now - 9 * 3_600_000, now, messages: [], settings: DEFAULT_RELAY_AUTO,
  }), null)
  ok('idle：占用低于 20% 不提示')

  assert.equal(evaluateRelayTrigger({
    usage: usage(30), lastUserAt: now - 3 * 3_600_000, now, messages: [],
    settings: { ...DEFAULT_RELAY_AUTO, idleHours: 2 },
  }).kind, 'idle')
  ok('idle：自定义空闲小时数生效')

  assert.equal(evaluateRelayTrigger({
    usage: usage(70), lastUserAt: recent, now, messages: [],
    settings: { ...DEFAULT_RELAY_AUTO, mode: 'auto' },
  }).kind, 'hard')
  ok('mode=auto 目前与 prompt 一样（只判定，不自动清空）')

  const fallbackRatio = evaluateRelayTrigger({
    usage: { usedTokens: 65000, contextWindow: 100000 }, lastUserAt: recent, now,
    messages: [], settings: DEFAULT_RELAY_AUTO,
  })
  assert.equal(fallbackRatio.kind, 'hard')
  assert.equal(fallbackRatio.percent, 65)
  ok('usage 缺 percent 时用 usedTokens / contextWindow 兜底')

  /* ── relayHintKey ───────────────────────────────────────────────────── */
  assert.equal(relayHintKey({ kind: 'soft', percent: 62 }), relayHintKey({ kind: 'soft', percent: 67 }))
  assert.notEqual(relayHintKey({ kind: 'soft', percent: 62 }), relayHintKey({ kind: 'hard', percent: 62 }))
  assert.notEqual(relayHintKey({ kind: 'soft', percent: 59 }), relayHintKey({ kind: 'soft', percent: 60 }))
  ok('关闭记忆键按 kind + 百分比十位档位分组')

  runtimeChecked = true
} catch (error) {
  if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) {
    console.log('  · 跳过运行时冒烟：未找到 esbuild（静态断言已覆盖交付要求）')
  } else {
    throw error
  }
} finally {
  if (tempDir !== null) await rm(tempDir, { recursive: true, force: true })
}

console.log('[relay-trigger] 静态断言：types.ts / store.tsx')

const typesSource = await readFile(typesPath, 'utf8')
expectContains(typesSource, 'export interface RelayAuto', 'types 定义 RelayAuto')
expectContains(typesSource, 'relayAuto?: RelayAuto', 'Bot 带可选的 relayAuto 字段')

const storeSource = await readFile(storePath, 'utf8')
expectContains(storeSource, "from './relay-trigger.ts'", 'store 从 relay-trigger 导入 normalizeRelayAuto')
expectContains(storeSource, 'relayAuto: normalizeRelayAuto(bot.relayAuto)', 'normalizeState 给每个 Bot 补 relayAuto 默认值')

console.log('[relay-trigger] 静态断言：ChatPanel.tsx')

const chatPanelSource = await readFile(chatPanelPath, 'utf8')
expectContains(chatPanelSource, "from '../relay-trigger.ts'", 'ChatPanel 引用纯逻辑模块')
expectContains(chatPanelSource, 'evaluateRelayTrigger(', 'ChatPanel 调 evaluateRelayTrigger')
expectContains(chatPanelSource, 'normalizeRelayAuto(', 'ChatPanel 用 normalizeRelayAuto 读设置')
expectContains(chatPanelSource, '/api/personal-agent/context?botId=', '每轮结束探测 GET /api/personal-agent/context')
expectContains(chatPanelSource, 'RELAY_PROBE_DEBOUNCE_MS = 800', '探测防抖 800ms')
expectContains(chatPanelSource, 'RELAY_PROBE_THROTTLE_MS = 3 * 60_000', '探测节流 3 分钟')
expectContains(chatPanelSource, 'className="pa-relay-hint"', '渲染 pa-relay-hint 提示条')
expectContains(chatPanelSource, '去整理', '提示条有「去整理」按钮')
expectContains(chatPanelSource, 'setClearTarget(activeBot)', '「去整理」复用现有确认卡（setClearTarget(activeBot)）')
expectContains(chatPanelSource, 'relayHintDismissedRef', '关闭后记住档位，本次会话不再弹')
expectContains(chatPanelSource, "last.role !== 'bot'", '只在每轮结束（最后一条是 bot）时探测')
expectContains(chatPanelSource, 'message.pending === true', '有 pending 占位时不探测')

console.log('[relay-trigger] 静态断言：BotSettingsCard.tsx')

const botSettingsSource = await readFile(botSettingsPath, 'utf8')
expectContains(botSettingsSource, '上下文接力', '设置卡有「上下文接力」区块')
expectContains(botSettingsSource, 'relayAuto:', '保存进 bot.relayAuto')
expectContains(botSettingsSource, 'normalizeRelayAuto(bot.relayAuto)', '设置卡复用 normalizeRelayAuto')
expectContains(botSettingsSource, 'RELAY_MODE_OPTIONS', '有模式下拉（关闭 / 仅提示 / 自动提示）')
expectContains(botSettingsSource, '软阈值', '有软阈值输入')
expectContains(botSettingsSource, '硬阈值', '有硬阈值输入')
expectContains(botSettingsSource, '空闲小时数', '有空闲小时数输入')
expectContains(botSettingsSource, '不会自动清空对话', '文案说明自动提示目前只提示不自动清空')

console.log('[relay-trigger] 静态断言：chat.css.ts')

const chatCssSource = await readFile(chatCssPath, 'utf8')
expectContains(chatCssSource, '.pa-relay-hint {', '存在 pa-relay-hint 容器样式')
expectContains(chatCssSource, '.pa-relay-hint__go', '存在「去整理」按钮样式')
expectContains(chatCssSource, '.pa-relay-hint__close', '存在关闭按钮样式')
expectContains(chatCssSource, 'background: var(--pa-chat-glass);', '提示条底色吃 pa-* 变量（主题自适应）')
expectContains(chatCssSource, ".pa-relay-hint[data-kind='hard']", 'hard 档位有独立强调色')

console.log('[relay-trigger] 全部通过（' + String(passed) + ' 项断言' + (runtimeChecked ? '，含运行时' : '') + '）')
