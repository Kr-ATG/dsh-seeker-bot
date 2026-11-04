/**
 * 面向模型的「消息文本」：把一条消息的 blocks 压成模型能读懂的一段话。
 *
 * 与 `blocksToText`（侧栏摘要 / 任务标题用）的区别：
 *  · 这里**展开交互卡的选项**。原来 history 与引用条都只取 interactive 块的
 *    prompt，用户回一句「1」时模型看到的是一条没有选项的提问，只能回「没看到
 *    前文的选项」——指代因此彻底断掉；
 *  · 这里保留「用户已选 / 已填」的结果，模型才知道上一轮那个待办已经结掉；
 *  · 侧栏摘要需要的是「一行能认出是哪条」，所以那边继续用 blocksToText，不改。
 *
 * 纯函数，不碰 React / DOM，便于 node 侧自测。
 */
import type { Message, MessageBlock, QuoteRef } from './types'

/** 投给模型的一条引用文本上限：再长会把本轮用户真正的问题挤出上下文。 */
export const REFERENCE_TEXT_MAX = 2_000

/** history 里「这条消息引用了什么」的前缀上限（跨轮只留个线索，不必全文）。 */
export const HISTORY_QUOTE_MAX = 800

/** 按上限截断，截断处补省略号；空白归一成单行换行之外的空格。 */
export function clampModelText(text: string, max: number): string {
  const flat = text.replace(/\r\n/g, '\n').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}…`
}

/** 交互卡（选项 / 按钮 / 表单）的可读文本。 */
function interactiveText(block: Extract<MessageBlock, { type: 'interactive' }>): string {
  const lines: string[] = []
  const prompt = block.prompt?.trim() ?? ''
  if (prompt !== '') lines.push(prompt)
  const ui = block.ui
  if (ui.kind === 'options' || ui.kind === 'buttons') {
    const options = ui.options.map((option, index) => {
      const label = option.label.trim()
      const description = option.description?.trim() ?? ''
      return `（${index + 1}）${label}${description === '' ? '' : ` — ${description}`}`
    })
    if (options.length > 0) {
      lines.push(`选项：${options.join('；')}`)
      // 「1」「第一个」「第一个选项」这类回复全靠这句才对得上号
      lines.push('（用户可能直接回序号来选其中一项）')
    }
  } else if (ui.kind === 'form') {
    const fields = ui.fields.map((field) => field.label.trim()).filter((label) => label !== '')
    if (fields.length > 0) lines.push(`表单字段：${fields.join(' / ')}`)
  }
  const result = block.result?.trim() ?? ''
  if (result !== '') lines.push(`用户已选 / 已填：${result}`)
  return lines.join('\n')
}

/**
 * 一条消息的可读文本（投给模型的那一份）。
 *
 * 工具块与压缩标记不产出文字：它们不是对话内容，塞进上下文只是噪音。
 */
export function modelTextOf(blocks: MessageBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = block.text.trim()
      if (text !== '') parts.push(text)
    } else if (block.type === 'image') {
      parts.push('[图片]')
    } else if (block.type === 'interactive') {
      const text = interactiveText(block)
      if (text !== '') parts.push(text)
    } else if (block.type === 'task') {
      const detail = block.detail?.trim() ?? ''
      parts.push(`[任务] ${block.title}${detail === '' ? '' : ` — ${detail}`}`)
    } else if (block.type === 'journal') {
      parts.push(`[期刊] ${block.title}`)
    } else if (block.type === 'voice') {
      const transcript = block.transcript.trim()
      parts.push(transcript === '' ? '[语音]' : `[语音] ${transcript}`)
    } else if (block.type === 'execution') {
      parts.push(`[执行] ${block.label}`)
    } else if (block.type === 'call' || block.type === 'call-segment') {
      parts.push('语音通话')
    } else if (block.type === 'connectors') {
      const title = block.title?.trim() ?? ''
      parts.push(title === '' ? '[推荐连接应用]' : `[推荐连接应用] ${title}`)
    }
  }
  return parts.join('\n').trim()
}

/** 被引用消息的完整文本（已截断）；空消息给一句占位，引用条上不能是无字的。 */
export function quoteTextOf(message: Message): string {
  const text = clampModelText(modelTextOf(message.blocks), REFERENCE_TEXT_MAX)
  return text === '' ? '（这条消息没有文字内容）' : text
}

/**
 * 把输入框挂着的引用（id + preview）补全成发请求用的载荷。
 *
 * 为什么必须查一次 messages：preview 是渲染用的 80 字摘要，交互卡的选项根本
 * 不在里面。被引用消息已经不在当前会话（归档 / 撤回）时退回 preview——至少
 * 让模型知道用户指的是哪句话，而不是完全丢掉引用。
 */
export function buildQuoteRef(
  messages: Message[],
  replyTo: { id: string; preview: string } | null | undefined,
): QuoteRef | undefined {
  if (replyTo === null || replyTo === undefined) return undefined
  const id = String(replyTo.id ?? '').trim()
  if (id === '') return undefined
  const preview = String(replyTo.preview ?? '').trim()
  const quoted = messages.find((message) => message.id === id)
  if (quoted === undefined) return { id, preview, text: preview }
  return {
    id: quoted.id,
    preview: preview === '' ? quoteTextOf(quoted) : preview,
    role: quoted.role,
    text: quoteTextOf(quoted),
  }
}

/**
 * 给宿主 history 用的一条消息文本。
 *
 * 带引用关系一起投过去：下一轮（或上下文压缩后）宿主重新读这段历史时，仍能看出
 * 「这句话是在回哪一条」，而不是只剩一句没头没尾的「1」。
 */
export function historyTextOf(message: Message): string {
  const text = modelTextOf(message.blocks)
  const replyTo = message.replyTo
  if (replyTo === undefined) return text
  const quoted = clampModelText(replyTo.text ?? replyTo.preview ?? '', HISTORY_QUOTE_MAX)
  if (quoted === '') return text
  return `（引用了一条消息：「${quoted}」）\n${text}`
}
