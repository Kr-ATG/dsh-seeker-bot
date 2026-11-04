/**
 * dsh-recall-plugin — 用户消息内容投影与渲染面判据（client 纯函数）
 *
 * 插件接管了 conversation.chat.node 的用户节点渲染，内容渲染分两条路：
 * - 新面（≥0.2.1-alpha.3）：整条内容交给官方 conversation.chat.user.content
 *   Factory（官方 UserStyleBubble 的同款调用），文本/图片/文件卡片/未知块/
 *   引用摘要全部官方渲染，插件只保留动作行（官方没有用户消息动作行 slot）。
 * - 旧面（≤0.2.1-alpha.2）：官方只有 renderMessageImages 图片闭包，文本/文件/
 *   JSON 由插件自绘——该路径同时作为新面 Factory 不可用时的兜底。
 *
 * 判据的教训（issue #23）：不能以 renderFactorySlot 是否存在判新面——0.2.0-rc.2
 * 已下发该函数但 conversation.user.* 槽位尚未引入，误判会切到不存在的槽位上，
 * 正文渲染成空、零报错（静默空白）。renderMessageImages 只存在于 ≤0.2.1-alpha.2，
 * 与新槽位引入版本互斥，以它判定旧面才可靠。
 */

import type { ChatBlock } from './recall-node.js'

// 官方 content Factory 名（ui-chat contract/slots.d.ts 的 SlotFactoryMap 声明）
export const USER_CONTENT_FACTORY = 'conversation.chat.user.content'

// 附件描述符（官方 UserContentAttachment 两支）：image 走官方图片管线
// （conversation.chat.user.images slot），file 走官方 fileCard
export type UserContentAttachment =
  | { type: 'image'; image: { attachment: unknown } }
  | { type: 'file'; file: unknown }

export interface UserContentProjection {
  text: string
  attachments: UserContentAttachment[]
  extraBlocks: ChatBlock[]
}

// 官方 contentParts（ui-chat 0.2.1-alpha.4 产物）的逐字复刻：text 块拼接、
// image/file 转附件描述符、其余块原样进 extraBlocks——官方 UserContent 用
// JsonBlock 呈现它们，未知块不会被静默丢弃。官方未导出该函数（包内私有），
// 复刻面仅此三分派；官方升级改派系时 tests/probe 的双面断言负责报红。
export function projectUserContent(blocks: ChatBlock[]): UserContentProjection {
  const texts: string[] = []
  const attachments: UserContentAttachment[] = []
  const extraBlocks: ChatBlock[] = []
  for (const block of blocks) {
    const b = block
    if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b && b.type === 'image' && b.attachment !== undefined) attachments.push({ type: 'image', image: { attachment: b.attachment } })
    else if (b && b.type === 'file' && b.attachment !== undefined) attachments.push({ type: 'file', file: b.attachment })
    else extraBlocks.push(block)
  }
  return { text: texts.join(''), attachments, extraBlocks }
}

// 官方 UserStyleBubble 的 facts 装配：referenceLabels/skillNames 仅在存在时并入。
// 官方 UserMessageNodeView 不传调用方 facts，故空对象即官方默认语义（whitespace
// 折叠等规则读不到 flag 即禁用，与旧面显示逐字一致）。
export function userContentFacts(referenceLabels: unknown, skillNames: unknown): Record<string, unknown> {
  const facts: Record<string, unknown> = {}
  if (referenceLabels !== undefined) facts.sessionLabels = referenceLabels
  if (skillNames !== undefined) facts.skillNames = skillNames
  return facts
}

export type UserContentFace = 'legacy' | 'factory'

// 两面判据（见文件头）：旧面闭包在场即旧面；否则 renderFactorySlot + loadImage
// 齐全才算新面；两者皆缺按旧面降级（纯文本自绘，图片静默跳过）
export function resolveUserContentFace(props: { renderMessageImages?: unknown; renderFactorySlot?: unknown; loadImage?: unknown }): UserContentFace {
  if (typeof props.renderMessageImages === 'function') return 'legacy'
  if (typeof props.renderFactorySlot === 'function' && typeof props.loadImage === 'function') return 'factory'
  return 'legacy'
}

export interface OfficialContentResult {
  ok: boolean
  node?: unknown
  error?: unknown
}

// 调用官方 content Factory 渲染整条内容（新面主路径）。ok=false 有两种来源：
// 槽位未注册（render 返回空，如 0.2.0-rc.2 等「有 renderFactorySlot、无槽位」的
// 中间版本）或调用抛错——调用方据 ok=false 回落自绘，绝不让内容静默空白
export function renderOfficialUserContent(
  renderFactorySlot: unknown,
  blocks: ChatBlock[],
  data: { referenceLabels?: unknown; skillNames?: unknown },
  loadImage: unknown,
  interactive: boolean,
): OfficialContentResult {
  if (typeof renderFactorySlot !== 'function') return { ok: false }
  const projected = projectUserContent(blocks)
  const content: Record<string, unknown> = {
    text: projected.text,
    attachments: projected.attachments,
    extraBlocks: projected.extraBlocks,
  }
  if (data.referenceLabels !== undefined) content.referenceLabels = data.referenceLabels
  try {
    const render = renderFactorySlot as (name: string, input: unknown) => unknown
    const node = render(USER_CONTENT_FACTORY, {
      content,
      loadImage,
      facts: userContentFacts(data.referenceLabels, data.skillNames),
      interactive,
    })
    if (node === null || node === undefined || node === false) return { ok: false }
    return { ok: true, node }
  } catch (error) {
    return { ok: false, error }
  }
}
