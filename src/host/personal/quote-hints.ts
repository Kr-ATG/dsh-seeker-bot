/**
 * 把「用户引用了哪条消息」翻成模型能读懂的一段前缀。
 *
 * 为什么必须由宿主来做：前端引用条上只渲染了 80 字摘要（preview），而用户真正
 * 要模型理解的是「我这句话在回哪一条」。前端现在把补全后的引用（完整正文 +
 * role）随 /reply 一起带上来，这里把它拼进本轮 user 文本，模型第一步就能看到。
 *
 * 与 withImageHints 同构：都只拼进发给模型的文本，前端展示的用户消息保持原文
 * （引用条已经单独渲染了，正文里再来一段就是重复）。
 */

/** 引用文本上限：再长会把本轮用户真正的问题挤出上下文。 */
export const QUOTE_HINT_MAX = 2_000

/** 请求体里引用载荷的形状（前端 QuoteRef 的宿主侧镜像，字段一律宽容）。 */
export interface ReplyQuote {
  id?: string
  preview?: string
  text?: string
  role?: string
}

/** 从请求体里取一段可用的引用文本；形状不认识 / 全空时返回 null。 */
function readQuote(quote: unknown): { text: string; role: string } | null {
  if (quote === null || typeof quote !== 'object') return null
  const record = quote as ReplyQuote
  const text = typeof record.text === 'string' && record.text.trim() !== ''
    ? record.text.trim()
    : (typeof record.preview === 'string' ? record.preview.trim() : '')
  if (text === '') return null
  const clamped = text.length > QUOTE_HINT_MAX ? `${text.slice(0, QUOTE_HINT_MAX)}…` : text
  const role = typeof record.role === 'string' ? record.role.trim() : ''
  return { text: clamped, role }
}

/** 被引用消息是谁说的——模型据此判断「那是我自己说的，还是用户说的」。 */
function speakerOf(role: string): string {
  if (role === 'user') return '用户自己之前说的'
  if (role === 'bot') return '你自己（助手）之前说的'
  return '之前的一条消息'
}

/**
 * 把引用拼进本轮用户文本。
 *
 * 没有引用（或引用形状不合法）时**原样返回**：老前端不带这个字段，行为不变。
 *
 * @param text - 本轮用户正文（可能已经带过图片提示）。
 * @param quote - /reply 请求体里的 quote 字段。
 */
export function withQuoteHints(text: string, quote: unknown): string {
  const ref = readQuote(quote)
  if (ref === null) return text
  return [
    '【用户引用了下面这条历史消息】',
    `（${speakerOf(ref.role)}）`,
    ref.text,
    '【引用结束】',
    '用户本轮的正文在最后。其中的「它 / 这个 / 第一条 / 1」等指代，优先按上面被引用的内容理解；如果被引用的是问答卡，括号里的序号就是选项序号。',
    '',
    text,
  ].join('\n')
}
