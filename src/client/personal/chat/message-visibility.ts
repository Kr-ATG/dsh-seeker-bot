/**
 * Personal Agent — 消息「渲染后是否有内容」的共享判据。
 *
 * 为什么单独抽成一个模块：同一条判据有两个消费者——
 *  · MessageBlockView 决定一个块能不能渲染（2026-11-02 起普通工具卡不再显示）；
 *  · MessageList 决定一条消息要不要进对话流、要不要计入轮次结算的「N 条消息」。
 *
 * 两边各写一份的后果不是「样式不一致」，而是**统计口径和肉眼所见对不上**：一条
 * 只有 run_code 工具块（kind=progress）的消息渲染出来是空白，却会被旧判据当成
 * 可见消息，轮次脚就出现「2 条消息」而用户只看到 1 条正文（真实报障）。
 * 判据必须只有一个来源。
 *
 * 这里只依赖 Message / ToolRun 的类型，不 import 任何 React 组件，离线测试
 * （scripts/test-message-visibility.mjs）可以直接用 esbuild 打包来跑。
 */
import type { Message, ToolRun } from '../types.ts'

/**
 * 解析 MCP 工具名：`mcp__<service>__<tool>`。
 */
export function parseMcpToolName(name: string): { service: string; tool: string } | null {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null
  const parts = name.split('__')
  if (parts.length < 3) return null
  return {
    service: parts[1].trim().toLowerCase(),
    tool: parts.slice(2).join('__').trim().toLowerCase(),
  }
}

/**
 * 判断是否属于「桌面控制/电脑操作」工具（含 MCP 工具与原生工具）。
 *
 * 涵盖：desktop-control、computer-use、mouse、keyboard、screen_capture、
 * pyautogui、robotjs、nutjs、osworld 等桌面控制 MCP 工具。
 */
export function isDesktopControlTool(name: string): boolean {
  if (typeof name !== 'string' || name.trim() === '') return false
  const trimmed = name.trim().toLowerCase()
  const mcp = parseMcpToolName(trimmed)
  if (mcp !== null) {
    const combined = `${mcp.service}_${mcp.tool}`
    return /(?:desktop|computer|mouse|keyboard|screen|pyautogui|nutjs|robotjs|osworld|windows[-_]control|system[-_]control|cua)/i.test(combined)
  }
  return /(?:desktop|computer|mouse_|keyboard_|screenshot)/i.test(trimmed)
}

/**
 * 工具名 → 是否属于「在屏幕上操作（电脑桌面或浏览器）」这一类执行态工具。
 *
 * computer / browser / 桌面控制 MCP 等转成执行态卡，回答「Bot 此刻在替你做什么」。
 * 普通工具（run_code / pwsh / read …）不在此列。
 */
export function isExecutionToolName(name: string): boolean {
  if (typeof name !== 'string' || name.trim() === '') return false
  const trimmed = name.trim().toLowerCase()
  if (isDesktopControlTool(trimmed)) return true
  const mcp = parseMcpToolName(trimmed)
  if (mcp !== null) {
    const combined = `${mcp.service}_${mcp.tool}`
    return /(?:browser|playwright|puppeteer|chrome|devtools|cdp|stagehand|ego)/i.test(combined)
  }
  return /^(?:computer|browser|screenshot|playwright|puppeteer|chrome|devtools|cdp)/i.test(trimmed)
}

/**
 * 这一组里是不是有「独立卡片」工具：生图 / 生视频 / 正在生成文档。
 *
 * 这几类有自己的展示形态（点阵占位、播放器、产出物卡），不是普通工具卡，
 * 所以即使 2026-11-02 之后普通工具不再渲染，它们仍然保留。
 */
export function isStandaloneToolRun(run: ToolRun): boolean {
  if (run.name === 'generate_image' || run.name === 'generate_video') return true
  return run.docPending === true && run.status === 'running'
}

/**
 * 这条消息渲染出来会不会有东西。
 *
 * 与 MessageBlockView 的渲染规则一一对应：
 *  · text：trim 后非空才算（纯空白气泡是空气泡）；
 *  · tool：只有会转成执行态卡的 computer / browser / 桌面控制 MCP 一族、以及生图 / 生视频 /
 *    文档生成占位卡算可见；其余普通工具（run_code / pwsh / read …）不渲染；
 *  · 其余块类型（image / execution / task / interactive / journal / voice /
 *    compaction / call / call-segment / connectors …）都是显式可见的块。
 *
 * 注意 pending 不在这里判断：MessageList 里「正在输入」的三点占位另有分支，
 * pending 消息即使暂时没有内容也要留在流里（见 MessageList 的 visible 过滤）。
 */
export function hasRenderableContent(message: Message): boolean {
  return message.blocks.some((block) => {
    if (block.type === 'text') return block.text.trim() !== ''
    if (block.type === 'tool') {
      return isExecutionToolName(block.run.name) || isStandaloneToolRun(block.run)
    }
    return true
  })
}
