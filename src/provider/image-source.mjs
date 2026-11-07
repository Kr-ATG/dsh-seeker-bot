/**
 * 生图工具来源策略 —— 纯函数、无宿主依赖（测试可直接 import 本文件）。
 *
 * 背景：同一个会话里可以同时看到两套生图能力：
 *   1. **供应商**：本插件 provider 侧（src/provider）注册的内置
 *      `generate_image` / `generate_video`，模型取「模型」页供应商卡片里
 *      勾了「生图」并设为当前生图模型的那个（settings 命名空间 model-capabilities）。
 *   2. **MCP**：VPS 上 magpie 的 magpie-image MCP server，工具名带前缀
 *      `mcp__magpie-image__`（generate_image / generate_video / generation_result）。
 *
 * 两套同时可见时模型会在「用哪个」上摇摆，甚至两次都调、同一需求出两张图。
 * 用户要的是显式二选一：设置项 `imageSource`（见
 * POST /api/model-capabilities/settings）。
 *
 * 生效方式：每次 `system-prompt/assemble` 出口按当前偏好撤掉另一套工具
 * （连同它的说明一起消失），模型不会「知道有但看不见」。
 *
 * 语义：
 *   · source=provider → 撤掉 `mcp__magpie-image__*`，只留内置 generate_image/generate_video；
 *   · source=mcp      → 撤掉内置 generate_image/generate_video，只留 MCP 的。
 */

/** 供应商（内置工具）来源。 */
export const IMAGE_SOURCE_PROVIDER = 'provider'
/** MCP（magpie-image）来源。 */
export const IMAGE_SOURCE_MCP = 'mcp'
/** 缺省偏好：保持用户既有习惯（供应商里已经配好生图模型）。 */
export const DEFAULT_IMAGE_SOURCE = IMAGE_SOURCE_PROVIDER

/** 本插件注册的生图 / 生视频工具名（供应商来源）。 */
export const PROVIDER_IMAGE_TOOLS = ['generate_image', 'generate_video']

/** magpie-image MCP 的工具名前缀（serverName = magpie-image）。 */
export const MCP_IMAGE_TOOL_PREFIX = 'mcp__magpie-image__'

/** 把任意输入归一成两种来源之一；非法值回落到缺省。 */
export function normalizeImageSource(value) {
  return value === IMAGE_SOURCE_MCP ? IMAGE_SOURCE_MCP : IMAGE_SOURCE_PROVIDER
}

/** 是否 MCP 侧的生图工具。 */
export function isMcpImageTool(name) {
  return typeof name === 'string' && name.startsWith(MCP_IMAGE_TOOL_PREFIX)
}

/** 是否供应商侧（本插件注册）的生图工具。 */
export function isProviderImageTool(name) {
  return typeof name === 'string' && PROVIDER_IMAGE_TOOLS.includes(name)
}

/**
 * 按当前偏好过滤工具表：保留选中来源的生图工具，撤掉另一来源的那一套。
 *
 * @param {readonly {name?: string}[]} tools 组装结果里的工具 schema 列表
 * @param {string} source 偏好（provider | mcp）
 * @returns {{ tools: any[], removed: string[], remaining: string[] }}
 *   removed = 被撤掉的工具名；remaining = 保留下来的生图工具名（给提示段用）。
 */
export function filterImageTools(tools, source) {
  const preference = normalizeImageSource(source)
  const kept = []
  const removed = []
  const remaining = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = typeof tool?.name === 'string' ? tool.name : ''
    const mcp = isMcpImageTool(name)
    const provider = isProviderImageTool(name)
    const drop = preference === IMAGE_SOURCE_MCP ? provider : mcp
    if (drop) {
      removed.push(name)
    } else {
      kept.push(tool)
      if (mcp || provider) remaining.push(name)
    }
  }
  return { tools: kept, removed, remaining }
}

/**
 * 过滤之后追加的系统提示段。
 *
 * 为什么不只做过滤：模型看不见工具 schema 时容易自己编名字或声称「已经画了」。
 * 这段说明把它钉在当前唯一可用的那套工具上；两套都没装时也说明该去哪里开。
 */
export function imageSourceNotice(source, remaining) {
  const preference = normalizeImageSource(source)
  const names = Array.isArray(remaining) ? remaining : []
  const head = preference === IMAGE_SOURCE_MCP
    ? '本会话的生图 / 生视频工具以 **MCP（magpie-image）** 为准：'
    : '本会话的生图 / 生视频工具以 **供应商（内置工具）** 为准：'
  const lines = [
    head + (names.length > 0
      ? '可用 ' + names.map((name) => '`' + name + '`').join('、') + '。'
      : '当前没有可用的生图工具。'),
    preference === IMAGE_SOURCE_MCP
      ? '不要调用内置 generate_image / generate_video（已被撤掉，调用会失败）。'
      : '不要调用 mcp__magpie-image__* 工具（已被撤掉，调用会失败）。',
  ]
  if (names.length === 0) {
    lines.push(preference === IMAGE_SOURCE_MCP
      ? '如需生图：请用户在「操作间 → 连接器」确认 magpie-image 已安装且启用。'
      : '如需生图：请用户在「模型」页给某个模型勾上「生图」并设为当前生图模型。')
  }
  lines.push('要换来源：在「模型」页 →「生图模型」区块切换「生图来源」。')
  return { name: 'image-source-preference', text: lines.join('\n') }
}
