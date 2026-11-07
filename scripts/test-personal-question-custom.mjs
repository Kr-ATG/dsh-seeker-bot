/**
 * Bot 问答卡的卡片形态测试（纯函数，不依赖真实 DSH）。
 *
 * 2026-11-07 用户报：「Bot 的『需要你确认』没有自定义输入框吗」。
 * 排查结论：前端 InteractiveCard 早就实现了 allowCustom（「其他（自己输入）」），
 * 但 host 侧 buildQuestionMessage 从来没打开过它——卡片只有模型给的选项，
 * 用户想说的答案不在选项里就无路可走。而 SPEC 6.4.2 明确写了这个形态。
 *
 * 这里钉住三件事（都不抛错，判错只能靠人眼，所以必须断言）：
 *   1. 有选项的问答卡带 allowCustom，选项原样保留；
 *   2. 无选项的开放问题也走 options 形态（选项为空 + allowCustom）——
 *      以前只给一个「知道了」，点下去等于告诉模型「用户答了知道了」；
 *   3. 审批卡（allowCustom=false）不带自定义入口：审批只回答「准不准」，
 *      自由输入会把授权风险交给一句随手打的文字。
 */
import assert from 'node:assert/strict'
import { personalQuestionMessage } from '../lib/index.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✓ ' + name)
  } catch (error) {
    console.error('  ✗ ' + name)
    throw error
  }
}

/** 从消息里取唯一那个 interactive 块。 */
function interactiveOf(message) {
  const blocks = message.blocks.filter((block) => block.type === 'interactive')
  assert.equal(blocks.length, 1, '一张问答卡只该有一个 interactive 块，实际 ' + blocks.length)
  return blocks[0]
}

console.log('\n[问答卡 · 有选项]')
check('带选项的问答卡打开 allowCustom，选项原样保留', () => {
  const message = personalQuestionMessage('q-test-1', [{
    id: 'which',
    question: '你说的 superagent 项目是指哪个？',
    header: '需要你确认',
    options: [
      { label: 'dsh-superagent-prototype' },
      { label: 'Superagent（开源 AI agent 平台）' },
      { label: '字节跳动 DeerFlow 2.0' },
    ],
  }])
  const block = interactiveOf(message)
  assert.equal(block.ui.kind, 'options')
  assert.equal(block.ui.allowCustom, true)
  assert.equal(block.ui.title, '需要你确认')
  assert.deepEqual(block.ui.options.map((option) => option.label), [
    'dsh-superagent-prototype',
    'Superagent（开源 AI agent 平台）',
    '字节跳动 DeerFlow 2.0',
  ])
  assert.equal(message.kind, 'need-input')
  assert.equal(message.id, 'qmsg-q-test-1')
})

console.log('\n[问答卡 · 无选项]')
check('开放问题也走 options + allowCustom（不再是只能点的「知道了」）', () => {
  const message = personalQuestionMessage('q-test-2', [{ id: 'open', question: '你的项目叫什么名字？' }])
  const block = interactiveOf(message)
  assert.equal(block.ui.kind, 'options')
  assert.equal(block.ui.allowCustom, true)
  assert.deepEqual(block.ui.options, [])
})

check('无选项时 header 缺省仍是「需要你确认」', () => {
  const block = interactiveOf(personalQuestionMessage('q-test-3', [{ id: 'open', question: 'x' }]))
  assert.equal(block.ui.title, '需要你确认')
})

console.log('\n[审批卡 · 不给自由输入]')
check('allowCustom=false 时既不带自定义入口，选项也原样保留', () => {
  const message = personalQuestionMessage('q-test-4', [{
    id: 'approval',
    question: '要删除这张表吗？',
    options: [{ label: '允许' }, { label: '拒绝' }],
  }], false)
  const block = interactiveOf(message)
  assert.equal(block.ui.kind, 'options')
  assert.equal(block.ui.allowCustom, undefined)
  assert.deepEqual(block.ui.options.map((option) => option.label), ['允许', '拒绝'])
})

check('allowCustom=false 且无选项时退回「知道了」按钮（空白卡片没法点）', () => {
  const block = interactiveOf(personalQuestionMessage('q-test-5', [{ id: 'x', question: 'x' }], false))
  assert.equal(block.ui.kind, 'buttons')
  assert.deepEqual(block.ui.options.map((option) => option.label), ['知道了'])
})

console.log('\n[文案拼装]')
check('detail 追加在问题后面、多问题给一句说明', () => {
  const message = personalQuestionMessage('q-test-6', [
    { id: 'a', question: '选哪个？', detail: '可以随时改。', options: [{ label: 'A' }] },
    { id: 'b', question: '第二个问题' },
  ])
  const block = interactiveOf(message)
  assert.equal(block.prompt, '选哪个？\n\n可以随时改。\n\n另有 1 个问题，回答后继续。')
})

console.log('\n✓ 问答卡形态：' + passed + ' 条断言通过')
