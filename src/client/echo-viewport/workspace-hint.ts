/**
 * dsh-seeker-bot — 从会话工具调用里提取「工作空间线索」。
 *
 * 操作面板的回显要显示「会话关联的工作空间」，但 DSH 会话本身没有显式的
 * ego TaskSpace id。可靠的事实藏在工具调用参数里：agent 打开工作空间必须写
 * 一段 ego-browser 脚本，脚本里必然出现 taskSpace("taobao") 或
 * claimTaskSpace(6)。这里把这些片段抽出来，作为服务端匹配空间的线索。
 *
 * 纯函数，不读 DOM、不发请求，方便冒烟直接断言。
 *
 * @module
 */

import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { resultParagraphs, toolArgsRaw } from '../tool-summary/activity-view-model.ts'

/** 最多保留多少条线索（越靠后越新）。 */
const MAX_HINTS = 8

/** 从一段文本（通常是工具参数的 JSON 字符串）里抽出工作空间线索。 */
export function extractWorkspaceHints(text: string): string[] {
  if (typeof text !== 'string' || text === '') return []
  const decoded = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
  const out: string[] = []
  const push = (value: string | undefined): void => {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed === '' || trimmed.length > 120) return
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  let match: RegExpExecArray | null = null
  const taskSpaceRe = /taskSpace\s*\(\s*["']([^"']{1,120})["']/g
  while ((match = taskSpaceRe.exec(decoded)) !== null) push(match[1])
  const claimRe = /(?:claimTaskSpace|takeOverTaskSpace)\s*\(\s*(\d{1,8})\s*\)/g
  while ((match = claimRe.exec(decoded)) !== null) push(match[1])
  const taskIdRe = /"taskId"\s*:\s*"([^"]{1,120})"/g
  while ((match = taskIdRe.exec(decoded)) !== null) push(match[1])
  const spaceIdRe = /"spaceId"\s*:\s*(\d{1,8})/g
  while ((match = spaceIdRe.exec(decoded)) !== null) push(match[1])
  const createdRe = /Task space created,\s*id:\s*(\d{1,8})/gi
  while ((match = createdRe.exec(decoded)) !== null) push(match[1])
  return out
}

/** 合并若干线索列表：保持顺序、去重、截断到最后 MAX_HINTS 条。 */
export function mergeWorkspaceHints(...lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  const out: string[] = []
  for (const list of lists) {
    if (list === undefined) continue
    for (const item of list) {
      const trimmed = item.trim()
      if (trimmed === '') continue
      const index = out.indexOf(trimmed)
      if (index >= 0) out.splice(index, 1)
      out.push(trimmed)
    }
  }
  return out.length > MAX_HINTS ? out.slice(out.length - MAX_HINTS) : out
}

/**
 * 从当前轮次的工具调用节点里收集工作空间线索。
 *
 * tools 是 KrAgentPanel 的 collectTurnNodes 输出（按时间升序）。参数与结果都扫：
 * 参数里有脚本源码，结果里可能有 ego 回执的 spaceId: 6。
 */
export function collectWorkspaceHints(tools: readonly ChatNode<'tool-call'>[]): string[] {
  const hints: string[] = []
  for (const node of tools) {
    let argsText = ''
    try {
      argsText = toolArgsRaw(node.data.root)
    } catch {
      argsText = ''
    }
    for (const hint of extractWorkspaceHints(argsText)) hints.push(hint)
    let resultText = ''
    try {
      resultText = resultParagraphs(node.data.root)
    } catch {
      resultText = ''
    }
    if (resultText !== '') {
      for (const hint of extractWorkspaceHints(resultText)) hints.push(hint)
    }
  }
  return mergeWorkspaceHints(hints)
}
