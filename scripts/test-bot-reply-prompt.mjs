#!/usr/bin/env node
/**
 * Personal Agent「回复形态提示词」自测：过程安静 + 最终回复提炼重点。
 *
 * 三层检查：
 *  1. **导出契约**：esbuild 打包 agent.ts 后 import，断言 BOT_REPLY_CONTRACT 含
 *     「一次回复的正文最多两段」「不要一句一条地连续播报过程」
 *     「最终回复必须提炼」「3–5 个关键结果」「不要按时间顺序复述步骤」；
 *  2. **buildBotPrompt 源码**：bot_emit 段含「执行过程中不要每做一步就说一句」
 *     「工具调用之间不要输出正文」「bot_emit(kind=finding)」「安静地做」
 *     「做完再一次性说结果」；REPLY → SAFETY → MEMORY → SKILL 拼装顺序不变；
 *  3. **esbuild 冒烟**：打包产物可加载、契约常量可用。
 *
 * 用项目自带 esbuild（与 test-personal-context.mjs 同一手法）；不依赖 lib/ 构建产物。
 *
 * Usage: node scripts/test-bot-reply-prompt.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OUT = mkdtempSync(join(tmpdir(), 'pa-reply-prompt-build-'))
const HOME = mkdtempSync(join(tmpdir(), 'pa-reply-prompt-home-'))
process.env.DSH_HOME = HOME

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  await build({
    entryPoints: [join(HERE, 'src/host/personal/agent.ts')],
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  })
  const agent = await import(pathToFileURL(join(OUT, 'agent.mjs')).href)
  const agentSource = readFileSync(join(HERE, 'src/host/personal/agent.ts'), 'utf8')

  /* ───────────────── BOT_REPLY_CONTRACT ───────────────── */

  console.log('\n[契约 · BOT_REPLY_CONTRACT]')

  check('导出字符串且以「回复格式」段开头', () => {
    assert.equal(typeof agent.BOT_REPLY_CONTRACT, 'string')
    assert.ok(agent.BOT_REPLY_CONTRACT.startsWith('## 回复格式（硬要求，每条都适用）'))
  })

  check('含「一次回复的正文最多两段」「不要一句一条地连续播报过程」', () => {
    const text = agent.BOT_REPLY_CONTRACT
    assert.ok(text.includes('一次回复的正文最多两段'), '缺少「一次回复的正文最多两段」')
    assert.ok(text.includes('不要一句一条地连续播报过程'), '缺少「不要一句一条地连续播报过程」')
  })

  check('含「最终回复必须提炼」「3–5 个关键结果」「不要按时间顺序复述步骤」', () => {
    const text = agent.BOT_REPLY_CONTRACT
    assert.ok(text.includes('最终回复必须提炼'), '缺少「最终回复必须提炼」')
    assert.ok(text.includes('3–5 个关键结果'), '缺少「3–5 个关键结果」')
    assert.ok(text.includes('不要按时间顺序复述步骤'), '缺少「不要按时间顺序复述步骤」')
    assert.ok(text.includes('数字、文件、结论、风险'), '缺少关键结果维度（数字、文件、结论、风险）')
  })

  check('新规则位于「回复格式」段内，不落在卡片段', () => {
    const formatSection = agent.BOT_REPLY_CONTRACT.split('\n\n')[0]
    assert.ok(formatSection.includes('一次回复的正文最多两段'))
    assert.ok(formatSection.includes('最终回复必须提炼'))
    assert.ok(!formatSection.includes('能出卡就出卡'), '回复格式段与卡片段的分界变了')
  })

  check('原有格式约束保留（默认 1–3 句 / 过程不逐条复述 / 最多 1–2 张卡）', () => {
    const text = agent.BOT_REPLY_CONTRACT
    assert.ok(text.includes('默认 1–3 句'))
    assert.ok(text.includes('过程不逐条复述'))
    assert.ok(text.includes('一条回复最多 1–2 张'))
  })

  /* ───────────────── buildBotPrompt · bot_emit 段 ───────────────── */

  console.log('\n[buildBotPrompt · bot_emit 段]')

  check('bot_emit 段含「不要每做一步就说一句」「工具调用之间不要输出正文」', () => {
    const start = agentSource.indexOf("'## 什么时候单独播报（bot_emit）'")
    assert.ok(start >= 0, '找不到「什么时候单独播报（bot_emit）」')
    const end = agentSource.indexOf('BOT_SAFETY_CONTRACT,', start)
    assert.ok(end > start, '找不到 bot_emit 段结束位置')
    const block = agentSource.slice(start, end)
    assert.ok(block.includes('执行过程中不要每做一步就说一句'), '缺少「执行过程中不要每做一步就说一句」')
    assert.ok(block.includes('工具调用之间不要输出正文'), '缺少「工具调用之间不要输出正文」')
    assert.ok(block.includes('bot_emit(kind=finding)'), '缺少 finding 播报约束')
    assert.ok(block.includes('只有真正值得用户立刻知道的发现'), '缺少「只有真正值得用户立刻知道的发现」限定')
  })

  check('bot_emit 段含「安静地做」「做完再一次性说结果」', () => {
    const start = agentSource.indexOf("'## 什么时候单独播报（bot_emit）'")
    const end = agentSource.indexOf('BOT_SAFETY_CONTRACT,', start)
    const block = agentSource.slice(start, end)
    assert.ok(block.includes('安静地做'), '缺少「安静地做」')
    assert.ok(block.includes('做完再一次性说结果'), '缺少「做完再一次性说结果」')
    assert.ok(block.includes('审批、缺关键信息这类必须打断的情况除外'), '缺少审批 / 缺关键信息的例外说明')
  })

  check('bot_emit 段原有说明保留（普通进度不需要调工具 / need-input / approval）', () => {
    const start = agentSource.indexOf("'## 什么时候单独播报（bot_emit）'")
    const end = agentSource.indexOf('BOT_SAFETY_CONTRACT,', start)
    const block = agentSource.slice(start, end)
    assert.ok(block.includes('普通进度不需要调用任何工具'))
    assert.ok(block.includes('kind=need-input'))
    assert.ok(block.includes('kind=approval'))
  })

  /* ───────────────── 契约拼装顺序与互不冲突 ───────────────── */

  console.log('\n[契约拼装与冲突检查]')

  check('buildBotPrompt 仍按 REPLY → SAFETY → MEMORY → SKILL 拼装', () => {
    const promptStart = agentSource.indexOf('function buildBotPrompt(')
    const reply = agentSource.indexOf('BOT_REPLY_CONTRACT,', promptStart)
    const safety = agentSource.indexOf('BOT_SAFETY_CONTRACT,', promptStart)
    const memory = agentSource.indexOf('BOT_MEMORY_CONTRACT,', promptStart)
    const skill = agentSource.indexOf('BOT_SKILL_CONTRACT,', promptStart)
    assert.ok(promptStart >= 0, '找不到 buildBotPrompt')
    assert.ok(reply > promptStart, 'buildBotPrompt 没引用 BOT_REPLY_CONTRACT')
    assert.ok(safety > reply, 'BOT_SAFETY_CONTRACT 顺序不对')
    assert.ok(memory > safety, 'BOT_MEMORY_CONTRACT 顺序不对')
    assert.ok(skill > memory, 'BOT_SKILL_CONTRACT 顺序不对')
  })

  check('安全 / 记忆 / 沉淀契约未被破坏', () => {
    assert.ok(agent.BOT_SAFETY_CONTRACT.includes('授权只来自用户本人'))
    assert.ok(agent.BOT_SAFETY_CONTRACT.includes('bot_emit(kind=approval)'))
    assert.ok(agent.BOT_MEMORY_CONTRACT.includes('记忆：可以查、可以改'))
    assert.ok(agent.BOT_SKILL_CONTRACT.includes('顺手把流程留下来'))
  })

  /* ───────────────── BOT_ELI5_CONTRACT 与 eli5Mode 开关 ───────────────── */

  console.log('\n[契约 · BOT_ELI5_CONTRACT 与开关]')

  check('导出 BOT_ELI5_CONTRACT 字符串且含核心要求', () => {
    assert.equal(typeof agent.BOT_ELI5_CONTRACT, 'string')
    assert.ok(agent.BOT_ELI5_CONTRACT.includes('通俗表达约定（ELI5 模式，默认启用）'))
    assert.ok(agent.BOT_ELI5_CONTRACT.includes('善用生活比喻'))
    assert.ok(agent.BOT_ELI5_CONTRACT.includes('拆解本质'))
  })

  check('buildBotPrompt 源码按 spec.eli5Mode !== false 条件拼接 BOT_ELI5_CONTRACT', () => {
    assert.ok(agentSource.includes("spec.eli5Mode !== false ? BOT_ELI5_CONTRACT : ''"))
  })

  /* ───────────────── 出卡字段速查（2026-11-05 用户实测「问天气不出卡」）───────────────── */

  console.log('\n[契约 · 出卡字段速查]')

  check('导出 BOT 卡片字段速查表且含 weather 完整字段', () => {
    const text = agent.BOT_CARD_CHEATSHEET
    assert.equal(typeof text, 'string')
    // 一句「查天气 → weather」不够：模型必须知道 JSON 长什么样才写得出来。
    assert.ok(text.includes('出卡的 JSON 长什么样'), '缺少速查表标题')
    assert.ok(text.includes('"kind":"weather"'), '速查表缺 weather 示例 JSON')
    assert.ok(text.includes('"city"'), '速查表缺 city 字段')
    assert.ok(text.includes('"temp"'), '速查表缺 temp 字段')
    assert.ok(text.includes('"forecast"'), '速查表缺 forecast 字段')
  })

  check('速查表覆盖 Bot 高频 kind（table / tabs / checklist）', () => {
    const text = agent.BOT_CARD_CHEATSHEET
    assert.ok(text.includes('"kind":"table"'), '缺 table')
    assert.ok(text.includes('"kind":"tabs"'), '缺 tabs')
    assert.ok(text.includes('"kind":"checklist"'), '缺 checklist')
  })

  check('速查表覆盖行情与链接（quote / link）', () => {
    const text = agent.BOT_CARD_CHEATSHEET
    assert.ok(text.includes('"kind":"quote"'), '缺 quote 示例 JSON')
    assert.ok(text.includes('"series"'), 'quote 缺 series 字段（不写就没走势线）')
    assert.ok(text.includes('"kind":"link"'), '缺 link 示例 JSON')
    assert.ok(text.includes('"url"'), 'link 缺 url 字段')
  })

  check('claude 速查表**从注册表取**，不在 agent.ts 里手写第二份', () => {
    // 手写第二份必然漂移：改了 kind 字段、文档还写旧名，卡片静默降级成代码块。
    assert.ok(agentSource.includes("import { iuKindOf } from '../../client/iu/kinds/registry.ts'"), '没 import kind 注册表')
    assert.ok(agentSource.includes("iuKindOf(kind)?.doc"), '速查表必须取注册表的 doc 字段')
    // 反向确认：agent.ts 里不该出现手抄的 weather 示例 JSON 字面量。
    assert.ok(!agentSource.includes('"kind":"weather","city":"北京"'), 'agent.ts 不许手写 weather 示例（会漂移）')
  })

  check('buildBotPrompt 把速查表紧跟在回复契约之后', () => {
    const reply = agentSource.indexOf('BOT_REPLY_CONTRACT,', agentSource.indexOf('function buildBotPrompt('))
    const cheat = agentSource.indexOf('BOT_CARD_CHEATSHEET,', agentSource.indexOf('function buildBotPrompt('))
    assert.ok(reply > 0, 'buildBotPrompt 没接 BOT_REPLY_CONTRACT')
    assert.ok(cheat > reply, '速查表必须排在回复契约之后（先讲该不该出卡，再讲字段怎么填）')
    // 两者之间不该隔进别的契约常量：间隔太远模型容易只读前一段就动笔。
    const between = agentSource.slice(reply, cheat)
    assert.ok(!between.includes('BOT_SAFETY_CONTRACT'), '速查表被安全契约挤到后面去了')
  })

  /* ───────────────── esbuild 冒烟 ───────────────── */

  console.log('\n[esbuild 冒烟]')

  await checkAsync('agent.ts 打包产物可加载、契约常量可用', async () => {
    assert.equal(typeof agent.BOT_REPLY_CONTRACT, 'string')
    assert.ok(agent.BOT_REPLY_CONTRACT.length > 100)
    assert.equal(typeof agent.BOT_SAFETY_CONTRACT, 'string')
    assert.equal(typeof agent.BOT_MEMORY_CONTRACT, 'string')
    assert.equal(typeof agent.BOT_SKILL_CONTRACT, 'string')
  })
} finally {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n[bot-reply-prompt] ${failed} 项失败`)
  process.exit(1)
}
console.log(`\n[bot-reply-prompt] PASS（${passed} 项）`)
