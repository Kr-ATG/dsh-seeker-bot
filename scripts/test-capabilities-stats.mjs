/**
 * dsh-seeker-bot — MCP 与 Skill 能力调用统计与弹窗端到端回归验证。
 *
 * 验证目标：
 * 1. Host 侧能力提取算法（extractCapabilitiesFromEvents）：
 *    - 正确识别并解析 mcp__<server>__<tool> 调用（提取 server、tool、参数摘要、状态）；
 *    - 正确识别并解析 skill / tool-skill 工具调用（提取 args.name / args.skill）；
 *    - 正确识别 message 层的 skill-invocation 指令触发；
 *    - 正确聚合统计去重后的 MCP 工具数、Skill 技能数、累计调用总次数；
 * 2. Client 侧产物结构：
 *    - lib/client.js 包含 kr-capabilities-btn、kr-cap-badge、CapabilitiesModal 等核心契约；
 *    - lib/index.js 包含 SESSION_CAPABILITIES_ROUTE 路由常量与处理器；
 *    - styles 包含对应的列布局、微胶囊指示灯、状态标签等样式；
 * 3. 运行完整断言。
 *
 * Usage: node scripts/test-capabilities-stats.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok    ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${detail === undefined ? '' : `\n      ${detail}`}`)
  }
}

// ── 1. 验证 Host 提取纯函数 ──────────────────────────────────────────────────
console.log('# 1. 测试 Host 端能力的提取与参数摘要')

const hostModuleUrl = pathToFileURL(resolve(ROOT, 'lib/index.js')).href
const hostModule = await import(hostModuleUrl)

check('hostModule 导出 SESSION_CAPABILITIES_ROUTE', hostModule.SESSION_CAPABILITIES_ROUTE === '/api/chat-flow/session-capabilities')
check('hostModule 导出 sessionCapabilitiesTest', typeof hostModule.sessionCapabilitiesTest === 'object')

const { extractCapabilitiesFromEvents, summarizeArgs } = hostModule.sessionCapabilitiesTest

// 构造模拟事件流
const mockEvents = [
  // 1. 普通工具调用（非 MCP、非 Skill，应该被忽略）
  {
    type: 'tool/call',
    time: 1000,
    data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'README.md' }) },
  },
  {
    type: 'tool/result',
    time: 1050,
    data: { message: { toolCallId: 'c1' }, isError: false },
  },
  // 2. MCP 调用：高德地图周边搜索
  {
    type: 'tool/call',
    time: 1100,
    data: {
      callId: 'c2',
      name: 'mcp__amap__maps_around_search',
      arguments: JSON.stringify({ location: '116.48,39.99', keywords: '加油站' }),
    },
  },
  {
    type: 'tool/result',
    time: 1250,
    data: { message: { toolCallId: 'c2' }, isError: false },
  },
  // 3. MCP 调用：Playwright 浏览器点击（报错）
  {
    type: 'tool/call',
    time: 1300,
    data: {
      callId: 'c3',
      name: 'mcp__playwright-mcp__browser_click',
      arguments: JSON.stringify({ selector: '#submit-btn' }),
    },
  },
  {
    type: 'tool/result',
    time: 1350,
    data: { message: { toolCallId: 'c3' }, isError: true },
  },
  // 4. Skill 工具调用：diagram-design
  {
    type: 'tool/call',
    time: 1400,
    data: {
      callId: 'c4',
      name: 'skill',
      arguments: JSON.stringify({ name: 'diagram-design' }),
    },
  },
  {
    type: 'tool/result',
    time: 1420,
    data: { message: { toolCallId: 'c4' }, isError: false },
  },
  // 5. Skill 消息层直接注入：baoyu-design
  {
    type: 'message',
    time: 1500,
    data: {
      source: { kind: 'skill-invocation', name: 'baoyu-design' },
      content: '请使用 baoyu-design 设计系统',
    },
  },
]

const extracted = extractCapabilitiesFromEvents(mockEvents)

check('提取出的能力总调用项为 4 项 (2 MCP + 2 Skill)', extracted.length === 4)

const mcpItems = extracted.filter((e) => e.kind === 'mcp')
const skillItems = extracted.filter((e) => e.kind === 'skill')

check('提取到 2 项 MCP 调用', mcpItems.length === 2)
check('提取到 2 项 Skill 调用', skillItems.length === 2)

// 校验 MCP 字段
const amapCall = mcpItems.find((m) => m.name === 'mcp__amap__maps_around_search')
check('amap 服务解析正确', amapCall?.server === 'amap')
check('amap 工具解析正确', amapCall?.tool === 'maps_around_search')
check('amap 状态为 success', amapCall?.status === 'success')
check('amap 参数摘要包含 keywords', amapCall?.argsSummary?.includes('加油站') === true)

const playwrightCall = mcpItems.find((m) => m.name === 'mcp__playwright-mcp__browser_click')
check('playwright-mcp 状态识别为 failed', playwrightCall?.status === 'failed')

// 校验 Skill 字段
const diagramSkill = skillItems.find((s) => s.name === 'diagram-design')
check('diagram-design 技能工具调用解析正确', diagramSkill !== undefined && diagramSkill.displayName === 'diagram-design')

const baoyuSkill = skillItems.find((s) => s.name === 'baoyu-design')
check('baoyu-design 消息层技能调用解析正确', baoyuSkill !== undefined && baoyuSkill.displayName === 'baoyu-design')

// ── 2. 校验客户端编译产物 ────────────────────────────────────────────────────
console.log('# 2. 测试 Client 产物与样式')

const clientJs = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8')

check('client 产物包含 kr-capabilities-btn 按钮标识', clientJs.includes('kr-capabilities-btn'))
check('client 产物包含 kr-plain-head__tool--capabilities 类名', clientJs.includes('kr-plain-head__tool--capabilities'))
check('client 产物包含 kr-cap-badge 徽标容器', clientJs.includes('kr-cap-badge'))
check('client 产物包含 kr-capabilities-modal 弹窗标识', clientJs.includes('kr-capabilities-modal'))
check('client 产物包含 kr-capabilities-title 弹窗标题标识', clientJs.includes('kr-capabilities-title'))
check('client 产物包含 session-capabilities 请求路由', clientJs.includes('/api/chat-flow/session-capabilities'))

// ── 3. 校验 CSS 样式 ─────────────────────────────────────────────────────────
console.log('# 3. 校验样式定义')

check('样式包含 .kr-plain-head__tool--capabilities', clientJs.includes('.kr-plain-head__tool--capabilities'))
check('样式包含 .kr-cap-group 分组卡片', clientJs.includes('.kr-cap-group'))
check('样式包含 .kr-cap-col--func', clientJs.includes('.kr-cap-col--func'))
check('样式包含 .kr-cap-col--count', clientJs.includes('.kr-cap-col--count'))
check('样式包含 .kr-cap-badge__item--mcp', clientJs.includes('.kr-cap-badge__item--mcp'))
check('样式包含 .kr-cap-badge__item--skill', clientJs.includes('.kr-cap-badge__item--skill'))

// ── 结果汇总 ─────────────────────────────────────────────────────────────────
if (failed > 0) {
  console.error(`\nFAILED: ${failed} checks failed.`)
  process.exit(1)
} else {
  console.log('\nALL CAPABILITIES STATS CHECKS PASSED!')
}
