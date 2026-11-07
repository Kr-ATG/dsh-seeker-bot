/**
 * Personal Agent (Bot 模式) — 原汁原味真实界面快照 HTML 组装器。
 *
 * 核心特性：
 *  1. 外层包含 .card，使宿主截图管线自动准确测量整张长图的高度；
 *  2. 100% 采用真实系统的 PERSONAL_BASE_CSS / PERSONAL_SHELL_CSS / PERSONAL_CHAT_CSS / PERSONAL_CALL_CSS / IU_CSS；
 *  3. 支持指定起止消息（startId ~ endId）、多档快捷条数（10/20/50/全部）、以及手动排除消息；
 *  4. 完整支持语音通话折叠条（call-segment）、通话卡片（call）与通话转写消息；
 *  5. 完整支持 IU 卡片（Weather/Table/Slider/Form/Checklist...全部15种）与 HTML 沙箱卡片内嵌渲染；
 *  6. 解除视口与滚动条限制，左侧栏与右侧聊天按最大内容自然撑开，杜绝截断与遮挡；
 *  7. 过滤空消息与纯工具轮次，防止产生空白灰胶囊。
 */
import { formatClock, formatDuration, type Avatar, type Bot, type Group, type Message, type MessageBlock, type Room } from '../types.ts'
import { PERSONAL_BASE_CSS } from '../base.css.ts'
import { PERSONAL_SHELL_CSS } from '../shell/shell.css.ts'
import { PERSONAL_CHAT_CSS } from '../chat/chat.css.ts'
import { PERSONAL_CALL_CSS } from '../call/call.css.ts'
import { BRAND_WORDMARK_SVG, FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from '../shell/brand-svg.ts'
import { splitIu, type IuPart } from '../../iu/parse.ts'
import { iuKindOf, iuKindsCss } from '../../iu/kinds/registry.ts'
import { IU_CSS } from '../../iu/styles.ts'
import { splitHtml, type HtmlPart } from '../../html-embed/parse.ts'
import { assembleHtmlDocument, MIN_FRAME_HEIGHT } from '../../html-embed/bridge.ts'
import { escapeAttr } from '../../../shared/sanitize-html.ts'

export interface PaShotInput {
  bots: readonly Bot[]
  groups: readonly Group[]
  rooms: readonly Room[]
  messages: readonly Message[]
  activeBot: Bot
  activeRoom: Room | null
  theme: 'light' | 'dark'
  width?: number
  range?: 'all' | 'recent50' | 'recent20' | 'recent10' | 'custom'
  startId?: string
  endId?: string
  excludedIds?: readonly string[]
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function cleanText(text: string): string {
  return text.replace(/\*\*([^\*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/[#_~]/g, '').trim()
}

/** 原版 BotAvatar SVG 生成器 */
function renderAvatarHtml(avatar: Avatar | undefined, size = 34, online = false): string {
  if (!avatar) {
    return '<span class="pa-avatar" style="width:' + size + 'px; height:' + size + 'px;"><div style="width:100%;height:100%;border-radius:50%;background:#4176e6;color:#fff;display:flex;align-items:center;justify-content:center;font-size:' + Math.round(size*0.4) + 'px;font-weight:700;">B</div></span>'
  }
  if (avatar.image && avatar.image.trim() !== '') {
    return '<span class="pa-avatar pa-avatar--image" style="width:' + size + 'px; height:' + size + 'px;">' +
      '<img class="pa-avatar__image" src="' + escapeHtml(avatar.image) + '" alt="" />' +
      '</span>'
  }

  const color = avatar.color || '#4176e6'
  const shape = avatar.shape || 'blob'
  const gradientId = 'pa-av-' + color.replace('#', '') + '-' + shape

  let shapePath = '<path d="M13 34c0-12 8.2-22 19.5-22 12.2 0 19.5 9.2 19.5 21 0 12.6-8 23-19.5 23S13 46 13 34Z" />'
  if (shape === 'whale') shapePath = '<path d="M12 33c0-11 8.4-19 21-19 12 0 20 7.6 20 18 0 7.4-4 12-9.6 14.2l3.4 6.8-9-3.3A37 37 0 0 1 32 51C20 51 12 44 12 33Z" />'
  else if (shape === 'cat') shapePath = '<path d="M14 30 12.4 13l12 6.2a27 27 0 0 1 15.2 0l12-6.2L50 30c0 12-8 21-18 21s-18-9-18-21Z" />'
  else if (shape === 'leaf') shapePath = '<path d="M32 8c14 0 24 9 24 22 0 14-10 24-24 24S8 44 8 30C8 17 18 8 32 8Z" transform="rotate(-12 32 32)" />'
  else if (shape === 'orbit') shapePath = '<g><circle cx="32" cy="32" r="18" /><ellipse cx="32" cy="32" rx="27" ry="9" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="2" /></g>'
  else if (shape === 'spark') shapePath = '<path d="M32 6 38 24 56 32 38 40 32 58 26 40 8 32 26 24Z" />'
  else if (shape === 'ring') shapePath = '<g><circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" stroke-width="9" /></g>'

  const eyesSvg = shape === 'orbit'
    ? '<g><ellipse cx="27" cy="31" rx="2.2" ry="3.4" fill="#101216" opacity=".62" /><ellipse cx="39" cy="31" rx="2.2" ry="3.4" fill="#101216" opacity=".62" /></g>'
    : (shape === 'ring' ? '' : '<g transform="rotate(-8 32 31)"><ellipse cx="27" cy="31" rx="2.5" ry="4.2" fill="#0c0e12" opacity="' + (shape === 'leaf' ? '.45' : '.66') + '" /><ellipse cx="39" cy="31" rx="2.5" ry="4.2" fill="#0c0e12" opacity="' + (shape === 'leaf' ? '.45' : '.66') + '" /></g>')

  return '<span class="pa-avatar" style="width:' + size + 'px; height:' + size + 'px;">' +
    '<svg viewBox="0 0 64 64" fill="none">' +
    '<defs><linearGradient id="' + gradientId + '" x1="12" y1="10" x2="52" y2="56" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0%" stop-color="' + color + '" /><stop offset="100%" stop-color="' + color + '" stop-opacity=".76" />' +
    '</linearGradient></defs>' +
    '<g fill="url(#' + gradientId + ')">' + shapePath + '</g>' +
    eyesSvg +
    '</svg>' +
    '</span>'
}

/** 轻量 Markdown 格式化 */
function formatMarkdown(text: string): string {
  if (!text) return ''
  const codeBlocks: string[] = []
  const fenceRegex = /```([\s\S]*?)```/g
  let safe = text.replace(fenceRegex, (_m, code) => {
    const idx = codeBlocks.length
    codeBlocks.push('<pre class="pa-code-block"><code>' + escapeHtml(code.trim()) + '</code></pre>')
    return '___CODE_BLOCK_' + idx + '___'
  })

  safe = safe.replace(/`([^`\n]+)`/g, (_m, code) => '<code class="pa-inline-code">' + escapeHtml(code) + '</code>')
  safe = safe.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>')

  const linesArr = safe.split(/\r?\n/)
  const out: string[] = []
  let inList = false

  for (const line of linesArr) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) {
        out.push('<ul class="pa-shot-list">')
        inList = true
      }
      out.push('<li>' + trimmed.slice(2) + '</li>')
      continue
    }
    if (inList) {
      out.push('</ul>')
      inList = false
    }

    if (trimmed.startsWith('> ')) {
      out.push('<blockquote class="pa-shot-quote">' + trimmed.slice(2) + '</blockquote>')
      continue
    }

    if (trimmed === '') {
      out.push('<div style="height:6px;"></div>')
      continue
    }

    if (trimmed.startsWith('___CODE_BLOCK_') && trimmed.endsWith('___')) {
      const match = /___CODE_BLOCK_(\d+)___/.exec(trimmed)
      if (match) {
        const idx = Number(match[1])
        out.push(codeBlocks[idx] ?? '')
        continue
      }
    }

    out.push('<p class="pa-shot-p">' + line + '</p>')
  }

  if (inList) out.push('</ul>')

  let result = out.join('\n')
  result = result.replace(/___CODE_BLOCK_(\d+)___/g, (_m, idxStr) => {
    return codeBlocks[Number(idxStr)] ?? ''
  })

  return result
}

/** 将一段富文本切分为 Markdown、IU 卡片、HTML 沙箱卡片三种片段 */
function splitRich(text: string): Array<IuPart | HtmlPart> {
  const out: Array<IuPart | HtmlPart> = []
  for (const part of splitHtml(text)) {
    if (part.kind === 'html') {
      out.push(part)
      continue
    }
    for (const sub of splitIu(part.text, false)) out.push(sub)
  }
  return out
}

/** 渲染富文本内容（支持 Markdown、IU 卡片快照与 HTML 卡片 iframe） */
function renderRichContent(text: string, fidPrefix = 'f'): { html: string; hasHtml: boolean } {
  const parts = splitRich(text)
  let out = ''
  let hasHtml = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.kind === 'md') {
      const trimmed = part.text.trim()
      if (trimmed) out += formatMarkdown(trimmed) + '\n'
    } else if (part.kind === 'iu') {
      const def = iuKindOf(part.spec.kind)
      let snapBody = ''
      if (def && typeof def.snapshot === 'function') {
        try {
          snapBody = def.snapshot(part.spec as any)
        } catch (e) {
          console.warn('[builder] iu snapshot error for', part.spec.kind, e)
        }
      }
      const title = def?.title ? def.title(part.spec as any) : (part.spec.title || def?.label || part.spec.kind)
      out += '<figure class="dtt-iu"><div class="dtt-iu__head"><span class="dtt-iu__title">' + escapeHtml(title) + '</span><span class="dtt-iu__acts"><span class="dtt-iu__badge" style="font-size:11px;opacity:0.7;">' + escapeHtml(def?.label || '卡片') + '</span></span></div><div class="dtt-iu__body">' + snapBody + '</div></figure>\n'
    } else if (part.kind === 'html') {
      hasHtml = true
      const fid = fidPrefix + '_h_' + i
      const doc = assembleHtmlDocument(part.spec.html, fid, { settleAnimations: true })
      out += '<figure class="htmlfence" data-fid="' + fid + '"><iframe srcdoc="' + escapeAttr(doc) + '" title="' + escapeAttr(part.spec.title || 'HTML卡片') + '" scrolling="no" loading="eager" sandbox="allow-scripts allow-popups allow-forms allow-modals allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" style="height:320px; width:100%; border:none; border-radius:10px;"></iframe></figure>\n'
    }
  }
  return { html: out, hasHtml }
}

export function buildPersonalAgentHtml(input: PaShotInput): string {
  const { bots, groups, rooms, messages, activeBot, activeRoom, theme, width = 1440, range = 'all', startId, endId, excludedIds } = input
  const isDark = theme === 'dark'
  const mainBot = bots.find(b => b.isMain) ?? bots[0] ?? activeBot

  // 1. 过滤当前会话消息
  const conversationMessages = messages.filter(m => {
    if (activeRoom !== null) return m.roomId === activeRoom.id
    return m.botId === activeBot.id && !m.roomId
  })

  // 按起止 ID 或范围切片
  let slicedMessages = conversationMessages
  if (startId || endId) {
    let startIdx = 0
    let endIdx = conversationMessages.length - 1
    if (startId) {
      const foundStart = conversationMessages.findIndex(m => m.id === startId)
      if (foundStart !== -1) startIdx = foundStart
    }
    if (endId) {
      const foundEnd = conversationMessages.findIndex(m => m.id === endId)
      if (foundEnd !== -1) endIdx = foundEnd
    }
    if (startIdx > endIdx) {
      const temp = startIdx
      startIdx = endIdx
      endIdx = temp
    }
    slicedMessages = conversationMessages.slice(startIdx, endIdx + 1)
  } else if (range === 'recent10') {
    slicedMessages = conversationMessages.slice(-10)
  } else if (range === 'recent20') {
    slicedMessages = conversationMessages.slice(-20)
  } else if (range === 'recent50') {
    slicedMessages = conversationMessages.slice(-50)
  }

  // 排除用户手动删除/排除的消息
  if (excludedIds && excludedIds.length > 0) {
    const excludeSet = new Set(excludedIds)
    slicedMessages = slicedMessages.filter(m => !excludeSet.has(m.id))
  }

  // 2. 提取最后发言摘要（纯文本化，清除 markdown 标记）
  const lastSummaryMap = new Map<string, string>()
  for (const m of messages) {
    const key = m.roomId ? ('room:' + m.roomId) : ('bot:' + m.botId)
    const textBlock = m.blocks.find(b => b.type === 'text')
    if (textBlock && textBlock.type === 'text' && textBlock.text.trim()) {
      lastSummaryMap.set(key, cleanText(textBlock.text).slice(0, 36))
    }
  }

  // 3. 构建左侧原版侧栏
  const isMainSelected = activeRoom === null && activeBot.id === mainBot.id

  const sortedGroups = [...groups].sort((a, b) => a.order - b.order)
  const groupSectionsHtml = sortedGroups.map(group => {
    const groupBots = bots.filter(b => !b.isMain && (b.groupId ?? 'default') === group.id)
    if (groupBots.length === 0) return ''
    const botRows = groupBots.map(bot => {
      const isSelected = activeRoom === null && activeBot.id === bot.id
      const summary = lastSummaryMap.get('bot:' + bot.id) ?? cleanText(bot.description ?? '还没有消息')
      return [
        '<div class="pa-bot-row" data-selected="' + (isSelected ? 'true' : 'false') + '">',
        renderAvatarHtml(bot.avatar, 34, bot.status === 'online'),
        '  <div class="pa-bot-row__body">',
        '    <div class="pa-bot-row__line1">',
        '      <span class="pa-bot-row__name">' + escapeHtml(bot.name) + '</span>',
        bot.role && bot.role !== bot.name ? ('      <span class="pa-bot-row__role">' + escapeHtml(bot.role) + '</span>') : '',
        '    </div>',
        '    <div class="pa-bot-row__summary">' + escapeHtml(summary) + '</div>',
        '  </div>',
        '</div>'
      ].join('\n')
    }).join('\n')

    return [
      '<div class="pa-sec-title" data-collapsed="false">',
      '  <span class="pa-sec-title__chevron">▾</span>',
      '  <span>' + escapeHtml(group.name) + '</span>',
      '</div>',
      botRows
    ].join('\n')
  }).join('\n')

  // 群聊分组
  const roomRowsHtml = rooms.map(room => {
    const isSelected = activeRoom !== null && activeRoom.id === room.id
    const summary = lastSummaryMap.get('room:' + room.id) ?? (room.memberIds.length + ' 个 Bot · 群聊')
    const memberBots = room.memberIds.map(id => bots.find(b => b.id === id)).filter((b): b is Bot => Boolean(b))
    const memberAvatarsHtml = memberBots.slice(0, 2).map(mb => renderAvatarHtml(mb.avatar, 24)).join('')

    return [
      '<div class="pa-bot-row" data-selected="' + (isSelected ? 'true' : 'false') + '">',
      '  <div class="pa-rail-room" style="width:32px; height:32px; display:flex; align-items:center;">',
      room.avatar ? renderAvatarHtml(room.avatar, 30) : memberAvatarsHtml,
      '  </div>',
      '  <div class="pa-bot-row__body">',
      '    <div class="pa-bot-row__line1">',
      '      <span class="pa-bot-row__name">' + escapeHtml(room.name) + '</span>',
      '    </div>',
      '    <div class="pa-bot-row__summary">' + escapeHtml(summary) + '</div>',
      '  </div>',
      '</div>'
    ].join('\n')
  }).join('\n')

  // 4. 右侧会话消息流
  const chatHeaderTitle = activeRoom ? activeRoom.name : activeBot.name
  const chatHeaderSubtitle = activeRoom
    ? ('群聊 · ' + activeRoom.memberIds.length + ' 个成员')
    : (activeBot.role ? ('在线 · ' + activeBot.role) : '在线')

  const phoneIconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 3.8h3.1l1.4 3.9-2 1.4a12.5 12.5 0 0 0 5.2 5.2l1.4-2 3.9 1.4v3.1a2.4 2.4 0 0 1-2.6 2.4C9.3 18.7 5.3 14.7 2.8 6.4a2.4 2.4 0 0 1 2.4-2.6Z" /></svg>'

  let hasAnyHtmlFence = false
  const validMessagesHtml: string[] = []
  for (let mIdx = 0; mIdx < slicedMessages.length; mIdx++) {
    const msg = slicedMessages[mIdx]
    // 检查是否包含语音通话块
    const callSegBlock = msg.blocks.find(b => b.type === 'call-segment') as { type: 'call-segment'; segment: string; turns: number; durationMs?: number; engine?: string } | undefined
    const callBlock = msg.blocks.find(b => b.type === 'call') as { type: 'call'; call: { startedAt: number; durationMs?: number; endedAt?: number; engine?: string } } | undefined

    // 通话折叠条 (call-segment)
    if (callSegBlock) {
      const isRealtime = callSegBlock.engine === 'realtime'
      const durText = typeof callSegBlock.durationMs === 'number' ? formatDuration(callSegBlock.durationMs) : '通话完成'
      validMessagesHtml.push([
        '<div class="pa-callseg-row">',
        '  <div class="pa-callseg" data-open="true">',
        '    <span class="pa-callseg__rule" aria-hidden="true"></span>',
        '    <span class="pa-callseg__label">',
        '      <span class="pa-callseg__icon">' + phoneIconSvg + '</span>',
        '      <span class="pa-callseg__title">' + (isRealtime ? '实时语音通话' : '语音通话') + '</span>',
        '      <span class="pa-callseg__meta">' + durText + '</span>',
        callSegBlock.turns > 0 ? ('      <span class="pa-callseg__count">' + callSegBlock.turns + ' 条对话</span>') : '',
        '    </span>',
        '    <span class="pa-callseg__rule" aria-hidden="true"></span>',
        '  </div>',
        '</div>'
      ].join('\n'))
      continue
    }

    // 通话卡片 (call)
    if (callBlock && callBlock.call) {
      const isRealtime = callBlock.call.engine === 'realtime'
      const dur = callBlock.call.durationMs ?? (callBlock.call.endedAt ? callBlock.call.endedAt - callBlock.call.startedAt : 0)
      validMessagesHtml.push([
        '<div class="pa-callcard" data-open="false" style="margin: 6px 0;">',
        '  <div class="pa-callcard__head" style="display:flex;align-items:center;gap:10px;">',
        '    <span class="pa-callcard__icon" style="display:inline-flex;color:var(--pa-green, #30d158);">' + phoneIconSvg + '</span>',
        '    <span class="pa-callcard__main">',
        '      <span class="pa-callcard__title" style="font-weight:600;">' + (isRealtime ? '实时语音通话' : '语音通话') + '</span>',
        '      <span class="pa-callcard__meta" style="font-size:12px;color:var(--pa-text-3);display:flex;gap:8px;margin-top:2px;">',
        '        <span style="color:var(--pa-green, #30d158);">来自通话</span>',
        '        <span>' + formatClock(callBlock.call.startedAt) + '</span>',
        '        <span>' + formatDuration(dur) + '</span>',
        '      </span>',
        '    </span>',
        '  </div>',
        '</div>'
      ].join('\n'))
      continue
    }

    // 系统消息
    if (msg.role === 'system') {
      const textPart = msg.blocks.map(b => b.type === 'text' ? b.text : '').join(' ').trim()
      if (!textPart) continue
      validMessagesHtml.push([
        '<div class="pa-msg pa-msg--system">',
        '  <div class="pa-msg__system-text">' + escapeHtml(textPart) + '</div>',
        '</div>'
      ].join('\n'))
      continue
    }

    const isUser = msg.role === 'user'
    const senderBot = isUser ? null : (bots.find(b => b.id === msg.botId) ?? activeBot)
    const senderName = isUser ? '你' : (senderBot?.name ?? 'Bot')

    let textContent = ''
    let thinkingContent = ''
    for (const b of msg.blocks) {
      if (b.type === 'text') textContent += (textContent ? '\n\n' : '') + b.text
      if (b.type === 'thinking' && b.text) thinkingContent += b.text
    }

    // 彻底过滤没有文字和思考过程的空消息/纯工具消息，杜绝空灰胶囊
    if (isUser) {
      if (!textContent.trim()) continue
    } else {
      if (!textContent.trim() && !thinkingContent.trim()) continue
    }

    const isFromCall = msg.callSegment !== undefined || msg.source === 'call'
    const timeStr = msg.at ? new Date(msg.at).toTimeString().slice(0, 5) : ''

    if (isUser) {
      validMessagesHtml.push([
        '<div class="pa-msg pa-msg--user">',
        '  <div class="pa-msg__content">',
        '    <div class="pa-msg__body pa-msg__body--tight">',
        '      <div class="pa-bubble pa-bubble--user">' + escapeHtml(textContent) + '</div>',
        '    </div>',
        '  </div>',
        '</div>'
      ].join('\n'))
      continue
    }

    const thinkingHtml = thinkingContent ? [
      '<div style="margin-bottom:8px; padding:10px 14px; border-radius:12px; background:var(--pa-card-2); border-left:3px solid var(--pa-accent); font-size:12.5px; line-height:1.6;">',
      '  <div style="font-weight:600; color:var(--pa-text-2); margin-bottom:5px; display:flex; align-items:center; gap:6px;"><span style="font-size:14px;">💡</span><span>思考过程</span></div>',
      '  <div style="color:var(--pa-text-3); font-size:12px; line-height:1.55;">' + escapeHtml(thinkingContent.slice(0, 260)) + (thinkingContent.length > 260 ? '…' : '') + '</div>',
      '</div>'
    ].join('\n') : ''

    // 关键升级：富文本渲染（包含 Markdown、IU 卡片快照与 HTML 卡片 iframe）
    const richResult = renderRichContent(textContent, 'pa_msg_' + mIdx)
    if (richResult.hasHtml) hasAnyHtmlFence = true

    validMessagesHtml.push([
      '<div class="pa-msg pa-msg--bot">',
      activeRoom !== null ? ('  <div class="pa-msg__avatar">' + renderAvatarHtml(senderBot?.avatar, 32) + '</div>') : '',
      '  <div class="pa-msg__content">',
      '    <div class="pa-msg__sender">',
      activeRoom !== null ? ('      <span class="pa-msg__sender-name">' + escapeHtml(senderName) + '</span>') : '',
      isFromCall ? ('      <span class="pa-msg__tag">来自通话</span>') : '',
      '    </div>',
      thinkingHtml,
      '    <div class="pa-msg__body pa-msg__body--tight">',
      '      <div class="pa-bubble pa-bubble--bot"><div class="pa-md">' + richResult.html + '</div></div>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n'))
  }

  const messagesHtml = validMessagesHtml.join('\n')
  // 卡顶正中悬浮的 Bot 动图占位（2026-11-07 从右栏迁来）：与真实页面同一判据——
  // 空对话不渲染，否则会和空态中央那枚同一只 Bot 头像重复。导出图只做静态占位。
  const mascotHtml = validMessagesHtml.length > 0
    ? [
      '        <div class="pa-chat__mascot" aria-hidden="true">',
      '          ' + renderAvatarHtml(activeBot.avatar, 92, activeBot.status === 'online'),
      '        </div>',
    ].join('\n') + '\n'
    : ''
  const frameWidth = Math.max(1024, width)

  // 品牌 SVG
  const brandWhaleSvg = '<svg width="24" height="17.65" viewBox="0 0 ' + FISH_LOGO_VIEWBOX.width + ' ' + FISH_LOGO_VIEWBOX.height + '" fill="none" aria-hidden="true"><path d="' + FISH_LOGO_PATH + '" fill="currentColor" /></svg>'
  const brandWordmarkSvg = BRAND_WORDMARK_SVG.replaceAll('dsh-wordmark-whale-clip', 'pa-brand-whale-clip').replaceAll('dsh-wordmark-badge-clip', 'pa-brand-badge-clip')

  // 高度桥接脚本（当正文含有 HTML 卡片时自动等待 iframe 内的内容稳定撑开）
  const embedScript = hasAnyHtmlFence ? [
    '<script>',
    '(function () {',
    '  var DARK = ' + (isDark ? 'true' : 'false') + ';',
    '  var figures = Array.prototype.slice.call(document.querySelectorAll("figure.htmlfence"));',
    '  addEventListener("message", function (event) {',
    '    var data = event.data;',
    '    if (!data || typeof data !== "object" || data.source !== "dsh-html-card") return;',
    '    if (data.kind === "ready") {',
    '      try { event.source.postMessage({ source: "dsh-html-card-host", kind: "theme", dark: DARK }, "*"); } catch (e) {}',
    '      return;',
    '    }',
    '    if (data.kind !== "height") return;',
    '    var h = Math.max(200, Math.min(6000, Math.round(data.height)));',
    '    for (var i = 0; i < figures.length; i += 1) {',
    '      if (figures[i].getAttribute("data-fid") === data.id) {',
    '        var frame = figures[i].querySelector("iframe");',
    '        if (frame) { frame.style.height = h + "px"; frame.setAttribute("data-settled", "1"); }',
    '        break;',
    '      }',
    '    }',
    '  });',
    '})();',
    '</script>'
  ].join('\n') : ''

  return '<!DOCTYPE html>\n' +
'<html lang="zh-CN" data-theme="' + theme + '">\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=' + frameWidth + '">\n' +
'<style>\n' +
PERSONAL_BASE_CSS + '\n' +
PERSONAL_SHELL_CSS + '\n' +
PERSONAL_CHAT_CSS + '\n' +
PERSONAL_CALL_CSS + '\n' +
IU_CSS + '\n' +
iuKindsCss() + '\n' +
'/* 宿主变量映射：让 IU 卡片吃到设计系统色彩 */\n' +
'.card, .pa-root {\n' +
'  --dsw-alias-bg-base: var(--pa-card);\n' +
'  --dsw-alias-bg-layer-1: var(--pa-card);\n' +
'  --dsw-alias-bg-layer-2: var(--pa-card-2);\n' +
'  --dsw-elevation-stroke: 0 0 0 .5px var(--pa-line-2);\n' +
'  --dsw-alias-border-l1: var(--pa-line);\n' +
'  --dsw-alias-border-l2: var(--pa-line-2);\n' +
'  --dsw-alias-border-l2-darkmode-thin: var(--pa-line);\n' +
'  --dsw-alias-label-primary: var(--pa-text);\n' +
'  --dsw-alias-label-secondary: var(--pa-text-2);\n' +
'  --dsw-alias-label-tertiary: var(--pa-text-3);\n' +
'  --dsw-radius-lg: 12px;\n' +
'  --dsw-radius-sm: 8px;\n' +
'  --dsw-alias-state-business-primary: var(--pa-accent);\n' +
'  --dsh-content-font-size: 14px;\n' +
'}\n' +
'.dtt-iu { animation: none !important; margin: 12px 0 !important; width: 100% !important; }\n' +
'figure.htmlfence { margin: 12px 0 !important; padding: 0 !important; border: 1px solid var(--pa-line) !important; border-radius: 12px !important; overflow: hidden !important; }\n' +
'figure.htmlfence iframe { display: block !important; width: 100% !important; border: none !important; }\n' +
'/* 截图专属全景展开适配 */\n' +
'html, body {\n' +
'  margin: 0 !important;\n' +
'  padding: 30px !important;\n' +
'  width: ' + frameWidth + 'px !important;\n' +
'  min-height: auto !important;\n' +
'  height: auto !important;\n' +
'  overflow: visible !important;\n' +
'  background: ' + (isDark ? '#0d0f12' : '#e4e7ed') + ' !important;\n' +
'  display: flex !important;\n' +
'  justify-content: center !important;\n' +
'  align-items: flex-start !important;\n' +
'  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif !important;\n' +
'}\n' +
'.card.pa-shot-frame {\n' +
'  position: static !important;\n' +
'  inset: auto !important;\n' +
'  width: ' + (frameWidth - 60) + 'px !important;\n' +
'  height: auto !important;\n' +
'  min-height: auto !important;\n' +
'  background: var(--pa-main) !important;\n' +
'  border-radius: 16px !important;\n' +
'  border: 1px solid var(--pa-line-2) !important;\n' +
'  box-shadow: 0 24px 64px rgba(0, 0, 0, ' + (isDark ? '0.45' : '0.12') + '), 0 2px 10px rgba(0, 0, 0, 0.08) !important;\n' +
'  overflow: hidden !important;\n' +
'  display: flex !important;\n' +
'  flex-direction: row !important;\n' +
'  align-items: stretch !important;\n' +
'}\n' +
'.pa-shot-frame .pa-sidebar {\n' +
'  position: static !important;\n' +
'  width: 280px !important;\n' +
'  min-width: 280px !important;\n' +
'  flex: 0 0 280px !important;\n' +
'  height: auto !important;\n' +
'  min-height: 100% !important;\n' +
'  overflow: visible !important;\n' +
'  background: var(--pa-sidebar) !important;\n' +
'  /* 侧栏与画布同色，常驻分隔竖线已隐藏（与真实页面一致）；拖拽提示线不受影响。 */\n' +
'  box-shadow: none !important;\n' +
'  display: flex !important;\n' +
'  flex-direction: column !important;\n' +
'}\n' +
'.pa-shot-frame .pa-sidebar__scroll {\n' +
'  flex: none !important;\n' +
'  height: auto !important;\n' +
'  max-height: none !important;\n' +
'  overflow: visible !important;\n' +
'}\n' +
'.pa-shot-frame .pa-app-shell {\n' +
'  flex: 1 !important;\n' +
'  min-width: 0 !important;\n' +
'  display: flex !important;\n' +
'  flex-direction: column !important;\n' +
'  overflow: visible !important;\n' +
'}\n' +
'/* ---------- 对话卡外观（2026-11-07 参考图） ----------\n' +
' * 真实页面已把中列改成「画布 + 四角圆润的浮起卡片 + 悬浮会话头 + 浮起输入框」，\n' +
' * 规则都落在 chat.css.ts 里。截图面板为了长图展开重写了这几块的布局（flex 撑开、\n' +
' * overflow 展开、滚动区不限高），外观必须在这里补回去，否则导出图仍是旧的分栏观感。\n' +
' * 特异性：.pa-shot-frame .x（0,2,0）> 真实的 .x（0,1,0），且写在 PERSONAL_CHAT_CSS\n' +
' * 之后，叠加 !important 后覆盖顺序稳定。\n' +
' */\n' +
'/* 导出图卡面色：只钉对话卡面，不动 --dsw-alias-bg-base（IU 卡片配色依赖它）。\n' +
' * 真实宿主里 --pa-main 取宿主 --dsw-alias-bg-base（暗色约 #181819）；\n' +
' * 截图面板为让 IU 卡片吃到设计系统色，把 --dsw-alias-bg-base 映射到了 --pa-card(#202124)，\n' +
' * 会让 color-mix 出来的卡面偏亮一档（#36373a vs 约 #2f2f30）——这里按真实宿主口径钉住。\n' +
' */\n' +
'.pa-shot-frame {\n' +
'  --pa-chat-surface: color-mix(in srgb, #181819 90%, #ffffff 10%) !important;\n' +
'}\n' +
'.pa-shot-frame[data-pa-theme=\'light\'] {\n' +
'  --pa-chat-surface: #ffffff !important;\n' +
'}\n' +
'.pa-shot-frame .pa-main-col {\n' +
'  flex: 1 !important;\n' +
'  width: 100% !important;\n' +
'  height: auto !important;\n' +
'  min-height: 100% !important;\n' +
'  overflow: visible !important;\n' +
'  display: flex !important;\n' +
'  flex-direction: column !important;\n' +
'  position: relative !important;\n' +
'  /* 画布露出来：卡片四周留 --pa-chat-gap 的缝，四角才看得出圆。 */\n' +
'  padding: var(--pa-chat-gap) !important;\n' +
'  background: var(--pa-chat-bg) !important;\n' +
'}\n' +
'.pa-shot-frame .pa-chat {\n' +
'  flex: 1 !important;\n' +
'  height: auto !important;\n' +
'  min-height: auto !important;\n' +
'  overflow: visible !important;\n' +
'  width: min(100%, 880px) !important;\n' +
'  margin: 0 auto !important;\n' +
'  display: flex !important;\n' +
'  flex-direction: column !important;\n' +
'  /* 卡片本体：卡面底 + 大投影 + 22px 圆角（不画描边，见下一条注释）。\n' +
'   * overflow 仍是 visible（长图要整条撑开、不能被圆角裁掉），圆角视觉由背景绘制保证。 */\n' +
'  position: relative !important;\n' +
'  background: var(--pa-chat-surface) !important;\n' +
'  /* 与真实页面一致：不画 1px 描边（浅色画布上会压出锐利暗边），轮廓靠圆角 + 轻投影。 */\n' +
'  border: 0 !important;\n' +
'  border-radius: var(--pa-chat-radius) !important;\n' +
'  box-shadow: var(--pa-chat-card-shadow) !important;\n' +
'  isolation: isolate !important;\n' +
'}\n' +
'/* 会话头：悬浮的裸内容（与真实页面 2026-11-07 三版一致）—— 没有任何背景层\n' +
' * （无底色 / 描边 / 投影 / 毛玻璃 / 顶部渐隐遮罩），也不拦截指针事件。\n' +
' * 真实规则第二项读 --pa-chat-w（真实页面由拖拽写入）；截图面板把卡片锁成 880px，\n' +
' * 所以宽度按同一口径推算 = min(画布宽 - 2gap - 24, 880 - 24)。 */\n' +
'.pa-shot-frame .pa-chat__header {\n' +
'  position: absolute !important;\n' +
'  top: calc(var(--pa-chat-gap) + 8px) !important;\n' +
'  left: 50% !important;\n' +
'  transform: translateX(-50%) !important;\n' +
'  width: min(calc(100% - var(--pa-chat-gap) * 2 - 24px), calc(880px - 24px)) !important;\n' +
'  height: 46px !important;\n' +
'  z-index: 20 !important;\n' +
'  background: none !important;\n' +
'  border: 0 !important;\n' +
'  border-radius: 0 !important;\n' +
'  box-shadow: none !important;\n' +
'  pointer-events: none !important;\n' +
'}\n' +
'/* 内容容器跟着悬浮条铺满（不再单独按卡片宽算，否则头像与消息列对不齐）。 */\n' +
'.pa-shot-frame .pa-chat__head-inner {\n' +
'  width: 100% !important;\n' +
'  margin: 0 !important;\n' +
'}\n' +
'/* 卡顶最上沿正中悬浮的 Bot 动图（2026-11-07 从右栏迁来，同日再顶到卡片最上层）：\n' +
' * 导出图补一个静态占位节点，几何口径与真实页面一致（absolute / top = 0 = 卡片\n' +
' * 内沿顶端 / 92×92 / left 50% + translateX(-50%) 与卡片同轴），容器全透明、\n' +
' * 不拦截指针。真实规则已带一遍，这里再钉死一次，避免继承差异把占位挤歪。 */\n' +
'.pa-shot-frame .pa-chat__mascot {\n' +
'  position: absolute !important;\n' +
'  top: 0 !important;\n' +
'  left: 50% !important;\n' +
'  transform: translateX(-50%) !important;\n' +
'  width: var(--pa-chat-mascot-size) !important;\n' +
'  height: var(--pa-chat-mascot-size) !important;\n' +
'  z-index: 12 !important;\n' +
'  background: none !important;\n' +
'  border: 0 !important;\n' +
'  box-shadow: none !important;\n' +
'  pointer-events: none !important;\n' +
'}\n' +
'.pa-shot-frame .pa-chat__scroll {\n' +
'  flex: none !important;\n' +
'  height: auto !important;\n' +
'  max-height: none !important;\n' +
'  overflow: visible !important;\n' +
'  /* 导出面板没有 .pa-chat__scroll-inner 结构（消息直接挂在滚动容器下），\n' +
'   * 上下留白只能落在容器自己身上：顶部 114px = 动图 92（top: 0 起，已覆盖会话头\n' +
'   * 那 54px 条）+ 动图到首条消息 22（呼吸），底部 22px 是卡片内边距。\n' +
'   * 窄屏的呼吸回收（18/14）在导出面板不是重点，只写这一档。 */\n' +
'  padding: 114px 30px 22px !important;\n' +
'  display: flex !important;\n' +
'  flex-direction: column !important;\n' +
'  gap: 16px !important;\n' +
'}\n' +
'.pa-shot-frame .pa-composer {\n' +
'  flex: none !important;\n' +
'  position: static !important;\n' +
'  margin: 0 !important;\n' +
'  /* 与真实页面一致：外层只负责留白，可见的「浮起」全部由 .pa-composer__box 承担。 */\n' +
'  padding: 2px 14px 14px !important;\n' +
'  background: transparent !important;\n' +
'}\n' +
'/* 输入区浮起的圆角胶囊：投影读 --pa-chat-input-shadow（真实规则已带，这里再钉一次）。 */\n' +
'.pa-shot-frame .pa-composer__box {\n' +
'  border-radius: 24px !important;\n' +
'  box-shadow: var(--pa-chat-input-shadow) !important;\n' +
'}\n' +
'.pa-code-block {\n' +
'  background: var(--pa-card-2); border-radius: 8px; padding: 10px 14px; margin: 8px 0; overflow-x: auto; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.55;\n' +
'}\n' +
'.pa-inline-code {\n' +
'  background: var(--pa-card-2); padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.92em;\n' +
'}\n' +
'.pa-shot-p { margin: 0 0 6px; }\n' +
'.pa-shot-p:last-child { margin-bottom: 0; }\n' +
'.pa-shot-list { margin: 6px 0 6px 18px; padding-left: 0; }\n' +
'.pa-shot-list li { margin-bottom: 4px; }\n' +
'.pa-shot-quote { border-left: 3px solid var(--pa-accent); padding-left: 10px; color: var(--pa-text-2); margin: 6px 0; }\n' +
'.pa-shot-frame .pa-sidebar__resizer,\n' +
'.pa-shot-frame .pa-chat__resizer,\n' +
'.pa-shot-frame .pa-row-more,\n' +
'.pa-shot-frame .pa-chat__head-actions,\n' +
'.pa-shot-frame .pa-overlay,\n' +
'.pa-shot-frame .pa-toast,\n' +
'.pa-shot-frame .pa-right-reopen,\n' +
'.pa-shot-frame .pa-sidebar-toggle,\n' +
'.pa-shot-frame .pa-msg__tools,\n' +
'.pa-shot-frame .pa-chat__to-bottom-wrap,\n' +
'.pa-shot-frame .pa-composer__plus,\n' +
'.pa-shot-frame .pa-composer__file {\n' +
'  display: none !important;\n' +
'}\n' +
'</style>\n' +
'</head>\n' +
'<body data-skb-mode="bot" data-pa-theme="' + theme + '">\n' +
'<div class="card pa-root pa-shot-frame" data-mode="bot" data-pa-theme="' + theme + '">\n' +
'  <aside class="pa-sidebar">\n' +
'    <div class="pa-sidebar__top">\n' +
'      <span class="pa-brand">' + brandWhaleSvg + '<span class="pa-brand__wordmark" style="height:24px;width:156px;">' + brandWordmarkSvg + '</span></span>\n' +
'    </div>\n' +
'    <div class="pa-mode-seg" role="tablist"><span class="pa-mode-seg__thumb" aria-hidden="true"></span><button type="button">Work</button><button type="button" data-on="true">Bot</button></div>\n' +
'    <div class="pa-sidebar__scroll">\n' +
'      <div class="pa-mainbot" data-selected="' + (isMainSelected ? 'true' : 'false') + '">\n' +
'        ' + renderAvatarHtml(mainBot.avatar, 48, mainBot.status === 'online') + '\n' +
'        <span class="pa-mainbot__name">' + escapeHtml(mainBot.name) + '</span>\n' +
'      </div>\n' +
'      ' + groupSectionsHtml + '\n' +
'      ' + (rooms.length > 0 ? (
        '<div class="pa-sec-title" data-collapsed="false"><span class="pa-sec-title__chevron">▾</span><span>群聊与 Bot</span></div>\n' +
        roomRowsHtml + '\n'
      ) : '') + '\n' +
'    </div>\n' +
'  </aside>\n' +
'  <div class="pa-app-shell">\n' +
'    <main class="pa-main-col">\n' +
'      <header class="pa-chat__header">\n' +
'        <div class="pa-chat__head-inner">\n' +
'          <div class="pa-chat__head-avatar">' + renderAvatarHtml(activeRoom?.avatar ?? activeBot.avatar, 30) + '</div>\n' +
'          <span class="pa-chat__head-name">' + escapeHtml(chatHeaderTitle) + '</span>\n' +
'          <span class="pa-chat__head-sub">' + escapeHtml(chatHeaderSubtitle) + '</span>\n' +
'        </div>\n' +
'      </header>\n' +
'      <div class="pa-chat">\n' +
      mascotHtml +
'        <div class="pa-chat__scroll">\n' +
'          <div class="pa-chat__sep"><span>会话记录</span></div>\n' +
'          ' + (messagesHtml || '<div class="pa-chat-empty__desc" style="text-align:center;padding:40px;">还没有消息</div>') + '\n' +
'        </div>\n' +
'        <div class="pa-composer">\n' +
'          <div class="pa-composer__box">\n' +
'            <div class="pa-composer__plus" style="pointer-events:none;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div>\n' +
'            <textarea class="pa-composer__textarea" readonly rows="1" placeholder="给 ' + escapeHtml(chatHeaderTitle) + ' 发消息"></textarea>\n' +
'            <div class="pa-composer__tools"><button class="pa-composer__send" data-on="true" type="button"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></svg></button></div>\n' +
'          </div>\n' +
'        </div>\n' +
'      </div>\n' +
'    </main>\n' +
'  </div>\n' +
'</div>\n' +
embedScript + '\n' +
'</body>\n' +
'</html>'
}