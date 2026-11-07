#!/usr/bin/env node
/**
 * 生图来源（供应商 vs magpie-image MCP）策略的纯函数测试。
 *
 * 被测模块：src/provider/image-source.mjs —— 无宿主依赖，直接 import。
 * 覆盖：归一化、两种偏好的工具过滤、两套都没有时的空操作、提示段文案。
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_IMAGE_SOURCE,
  IMAGE_SOURCE_MCP,
  IMAGE_SOURCE_PROVIDER,
  MCP_IMAGE_TOOL_PREFIX,
  PROVIDER_IMAGE_TOOLS,
  filterImageTools,
  imageSourceNotice,
  isMcpImageTool,
  isProviderImageTool,
  normalizeImageSource,
} from '../src/provider/image-source.mjs'

const results = []
function check(name, fn) {
  try { fn(); results.push(['ok', name]) } catch (error) { results.push(['fail', name, error]) }
}

const TOOLS = [
  { name: 'generate_image' },
  { name: 'generate_video' },
  { name: 'mcp__magpie-image__generate_image' },
  { name: 'mcp__magpie-image__generate_video' },
  { name: 'mcp__magpie-image__generation_result' },
  { name: 'read_file' },
]

check('缺省来源是 provider', () => {
  assert.equal(DEFAULT_IMAGE_SOURCE, IMAGE_SOURCE_PROVIDER)
  assert.equal(normalizeImageSource(undefined), IMAGE_SOURCE_PROVIDER)
  assert.equal(normalizeImageSource('nonsense'), IMAGE_SOURCE_PROVIDER)
  assert.equal(normalizeImageSource(IMAGE_SOURCE_MCP), IMAGE_SOURCE_MCP)
})

check('工具名判据', () => {
  assert.equal(isMcpImageTool(MCP_IMAGE_TOOL_PREFIX + 'generate_image'), true)
  assert.equal(isMcpImageTool('generate_image'), false)
  assert.equal(isProviderImageTool('generate_image'), true)
  assert.equal(isProviderImageTool(MCP_IMAGE_TOOL_PREFIX + 'generate_image'), false)
  assert.equal(PROVIDER_IMAGE_TOOLS.length, 2)
})

check('provider 偏好：撤掉 MCP 三个，保留内置两个与其它工具', () => {
  const p = filterImageTools(TOOLS, IMAGE_SOURCE_PROVIDER)
  assert.deepEqual(p.removed.sort(), Object.values(TOOLS)
    .map((t) => t.name).filter((n) => n.startsWith(MCP_IMAGE_TOOL_PREFIX)).sort())
  assert.deepEqual(p.remaining.sort(), ['generate_image', 'generate_video'])
  assert.ok(p.tools.some((t) => t.name === 'read_file'))
  assert.equal(p.tools.length, 1 + 2)
  assert.ok(!p.tools.some((t) => isMcpImageTool(t.name)))
})

check('mcp 偏好：撤掉内置两个，保留 MCP 三个与其它工具', () => {
  const p = filterImageTools(TOOLS, IMAGE_SOURCE_MCP)
  assert.deepEqual(p.removed.sort(), ['generate_image', 'generate_video'])
  assert.deepEqual(p.remaining.sort(), [
    'mcp__magpie-image__generate_image',
    'mcp__magpie-image__generate_video',
    'mcp__magpie-image__generation_result',
  ])
  assert.ok(p.tools.some((t) => t.name === 'read_file'))
  assert.ok(!p.tools.some((t) => isProviderImageTool(t.name)))
})

check('两套都没有：removed 与 remaining 都为空（assemble 出口据此跳过）', () => {
  const p = filterImageTools([{ name: 'read_file' }, { name: 'write_file' }], IMAGE_SOURCE_MCP)
  assert.equal(p.removed.length, 0)
  assert.equal(p.remaining.length, 0)
  assert.equal(p.tools.length, 2)
  assert.equal(filterImageTools(undefined, IMAGE_SOURCE_PROVIDER).tools.length, 0)
})

check('提示段：只说当前可用的那套，并点名另一套不要调', () => {
  const providerNotice = imageSourceNotice(IMAGE_SOURCE_PROVIDER, ['generate_image', 'generate_video'])
  assert.equal(providerNotice.name, 'image-source-preference')
  assert.match(providerNotice.text, /供应商/)
  assert.match(providerNotice.text, /generate_image/)
  assert.match(providerNotice.text, /mcp__magpie-image__/)
  assert.match(providerNotice.text, /不要调用/)

  const mcpNotice = imageSourceNotice(IMAGE_SOURCE_MCP, [MCP_IMAGE_TOOL_PREFIX + 'generate_image'])
  assert.match(mcpNotice.text, /MCP（magpie-image）/)
  assert.match(mcpNotice.text, /mcp__magpie-image__generate_image/)
  assert.match(mcpNotice.text, /不要调用内置 generate_image/)
})

check('提示段：没有可用工具时给出该去哪里开', () => {
  const none = imageSourceNotice(IMAGE_SOURCE_MCP, [])
  assert.match(none.text, /没有可用的生图工具/)
  assert.match(none.text, /连接器/)
  const noneProvider = imageSourceNotice(IMAGE_SOURCE_PROVIDER, [])
  assert.match(noneProvider.text, /勾上「生图」/)
})

const failed = results.filter(([status]) => status === 'fail')
for (const [status, name, error] of results) {
  if (status === 'ok') console.log('ok   ' + name)
  else console.error('FAIL ' + name + '\n     ' + String(error?.stack ?? error))
}
if (failed.length > 0) {
  console.error('\nimage-source: ' + failed.length + ' / ' + results.length + ' failed')
  process.exit(1)
}
console.log('\nimage-source: ' + results.length + ' checks passed')
