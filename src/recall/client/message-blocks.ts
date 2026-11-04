/**
 * 用户消息内容块的解析与展示信息（从 recall-node.ts 拆出）
 *
 * 拆出动机：recall-node.ts 长期超 800 行（issue #31 又加分支），而这块是
 * 自包含纯逻辑——块形状、附件引用提取、文件卡片度量，与撤回状态机无关。
 * recall-node 仍 re-export 同名符号，既有 import 路径（含单测）不变。
 */

import type { DraftAttachmentRef } from './draft-fill.js'
import { zhTranslate } from './locales/index.js'
import type { Translate } from './locales/index.js'

// 用户消息内容块（text/image/JSON 等）：只读已知字段，其余透传 unknown
export interface ChatBlock {
  type?: string
  text?: string
  attachment?: unknown
  [key: string]: unknown
}

// 纯函数（模块级导出供单测）：从内容块提取附件引用。只认带非空 attachmentId 的
// image/file 块；缺 name 的由回填侧按 mediaType 派生文件名。
export function attachmentRefsFromBlocks(blocks: ChatBlock[]): DraftAttachmentRef[] {
  const refs: DraftAttachmentRef[] = []
  for (const block of blocks) {
    if (!block || (block.type !== 'image' && block.type !== 'file')) continue
    const ref = block.attachment as { attachmentId?: unknown; name?: unknown } | null | undefined
    if (!ref || typeof ref.attachmentId !== 'string' || ref.attachmentId === '') continue
    // 原始引用对象一并带上：≥0.2.2-alpha.1 的 readAttachment 只认完整引用
    // （裸 id 会被判 INVALID_ATTACHMENT_REF），旧版忽略该字段
    const entry: DraftAttachmentRef = { attachmentId: ref.attachmentId, kind: block.type, attachment: block.attachment }
    if (typeof ref.name === 'string' && ref.name !== '') entry.name = ref.name
    refs.push(entry)
  }
  return refs
}

// 自绘降级路径的块投影（新面主路径由官方 content Factory 直接消费原始 blocks）；
// 契约与动机见各字段注释——投影口径错一处就是可见回归
export interface MessageBlockViews {
  text: string
  images: Array<{ attachment: unknown }>
  files: ChatBlock[]
  rest: ChatBlock[]
}

export function projectMessageBlocks(blocks: ChatBlock[]): MessageBlockViews {
  return {
    text: blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(''),
    // 官方契约：images 传 image 块数组（{attachment}），官方内部取
    // image.attachment.attachmentId —— 不是裸 attachment 对象
    images: blocks.filter((b) => b && b.type === 'image' && b.attachment).map((b) => ({ attachment: b.attachment })),
    // file 块（文档/表格等非图片附件）：官方渲染成文件卡片（图标 + 文件名 +
    // 扩展名/大小）——自绘路径必须复刻，否则它落进 rest 的 JSON 兜底
    files: blocks.filter((b) => b && b.type === 'file'),
    rest: blocks.filter((b) => !b || !(b.type === 'text' && typeof b.text === 'string') && !(b.type === 'image' && b.attachment) && b.type !== 'file'),
  }
}

// 文件卡片的展示信息（官方 UserStyleBubble 对 file 块渲染成「图标 + 文件名 +
// 扩展名/大小」卡片；插件的自定义渲染器必须自己复刻，否则 file 块会落到
// JSON 兜底里变成一坨原文）。
export interface FileCardInfo {
  name: string
  ext: string
  size: string
}

// 扩展名徽标文本：取最后一个点之后的部分，大写并截断到 4 字符（PDF/JSON/DOCX）；
// 无扩展名或点名结尾回退 'FILE'。
function fileExtOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const raw = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : ''
  const ext = raw.replace(/[^a-z0-9]/gi, '').toUpperCase()
  return ext ? ext.slice(0, 4) : 'FILE'
}

// 附件体积文本：官方卡片写「6.7KB」这种紧凑形态（无空格、KB 起一位小数），
// 与设置页磁盘占用的 sizeText（MB 起、带空格）是两种语境，不复用。
function fileCardSizeText(bytes: unknown): string {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : NaN
  if (Number.isNaN(n)) return ''
  if (n < 1024) return String(Math.round(n)) + 'B'
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB'
  return (n / 1073741824).toFixed(1) + 'GB'
}

// 纯函数（模块级导出供单测）：file 块 → 文件卡片信息。只认 type === 'file'；
// 引用形状异常（缺 attachment）时给兜底名，绝不返回 null —— file 块一旦漏回
// JSON 兜底就是「整块原文」的可见回归，宁可渲染一张信息不全的卡片。
// t 缺省 zh 词表（同 summaryText）：兜底名也要可译，但不能逼调用点必传
export function fileCardInfo(block: ChatBlock | null | undefined, t: Translate = zhTranslate): FileCardInfo | null {
  if (!block || block.type !== 'file') return null
  const ref = block.attachment as { name?: unknown; bytes?: unknown } | null | undefined
  const name = ref && typeof ref === 'object' && typeof ref.name === 'string' && ref.name !== '' ? ref.name : t('file.unnamed')
  return { name, ext: fileExtOf(name), size: fileCardSizeText(ref && typeof ref === 'object' ? ref.bytes : undefined) }
}
