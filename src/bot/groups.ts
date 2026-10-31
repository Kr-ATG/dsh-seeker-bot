/**
 * dsh-seeker-bot — 群组（host 半身）。
 *
 * 群 = 一组 Bot + 一个模型策略。这里只做数据与 @ 路由判定：
 * 用户消息按 @ 决定由谁接；没有 @ 则由群主 Bot（primaryBotId，缺省 botIds[0]）接。
 * 群内模型：model.mode = 'inherit'（各自 Bot 设置）| 'unified'（整群统一）。
 */

import {
  deleteGroupRecord, findBot, findGroup, insertGroup, listGroups, newRecordId,
  updateGroupRecord, type BotGroup, type GroupModel,
} from './state.js'
import { normalizeGroupModel } from './models.js'

export interface GroupMember {
  id: string
  name: string
}

/** decideSpeaker 接受的群形状（真实记录或带 members 的视图）。 */
export interface GroupLike {
  botIds?: readonly string[]
  primaryBotId?: string
  members?: readonly GroupMember[]
}

export interface SpeakerDecision {
  botId: string | null
  mentions: string[]
  reason: 'mention' | 'primary' | 'first' | 'no-members'
}

const MENTION_PATTERN = /@([^\s@，。,.!?！？:：;；、]+)/g

/** 提取消息里的 @ 名（按出现顺序去重）。 */
export function extractMentions(text: string): string[] {
  if (typeof text !== 'string' || text === '') return []
  const out: string[] = []
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1]
    if (name !== undefined && name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * @ 路由纯函数：先按 @ 名精确匹配（也接受 botId），没有命中则由群主/第一个 Bot 接。
 * 不读 state、不产生副作用，便于客户端与测试直接对拍。
 */
export function decideSpeaker(group: GroupLike, text: string): SpeakerDecision {
  const members = Array.isArray(group?.members)
    ? group.members
    : (group?.botIds ?? []).map((id) => ({ id, name: id }))
  const mentions = extractMentions(text)
  for (const mention of mentions) {
    const lower = mention.toLowerCase()
    const hit = members.find((member) => member.id === mention
      || member.name === mention
      || String(member.name).toLowerCase() === lower)
    if (hit !== undefined) return { botId: hit.id, mentions, reason: 'mention' }
  }
  const botIds = group?.botIds ?? []
  if (typeof group?.primaryBotId === 'string' && botIds.includes(group.primaryBotId)) {
    return { botId: group.primaryBotId, mentions, reason: 'primary' }
  }
  if (botIds.length > 0) return { botId: botIds[0], mentions, reason: 'first' }
  return { botId: null, mentions, reason: 'no-members' }
}

/** 把群记录补成带成员名字的视图（路由返回 / 决策用）。 */
export function groupView(group: BotGroup): BotGroup & { members: GroupMember[] } {
  const members = group.botIds.map((id) => ({ id, name: findBot(id)?.name ?? id }))
  return { ...group, members }
}

export interface GroupMutationResult {
  ok: boolean
  group?: BotGroup
  error?: string
}

function asBotIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

export function createGroupFromBody(body: Record<string, unknown>): GroupMutationResult {
  try {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') return { ok: false, error: '群组名称不能为空' }
    const botIds = asBotIds(body.botIds)
    if (botIds.length === 0) return { ok: false, error: '群组至少需要一个 Bot' }
    for (const botId of botIds) {
      if (findBot(botId) === null) return { ok: false, error: 'Bot 不存在：' + botId }
    }
    const primaryRaw = typeof body.primaryBotId === 'string' ? body.primaryBotId.trim() : ''
    const group: BotGroup = {
      id: newRecordId('group'),
      name,
      botIds,
      ...(primaryRaw !== '' && botIds.includes(primaryRaw) ? { primaryBotId: primaryRaw } : { primaryBotId: botIds[0] }),
      model: normalizeGroupModel(body.model),
      createdAt: Date.now(),
    }
    insertGroup(group)
    return { ok: true, group }
  } catch (error) {
    return { ok: false, error: '创建群组失败：' + errorText(error) }
  }
}

export function updateGroupFromBody(id: string, body: Record<string, unknown>): GroupMutationResult {
  try {
    const group = findGroup(id)
    if (group === null) return { ok: false, error: '群组不存在' }
    const patch: Partial<BotGroup> = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') return { ok: false, error: '群组名称不能为空' }
      patch.name = name
    }
    if (body.botIds !== undefined) {
      const botIds = asBotIds(body.botIds)
      if (botIds.length === 0) return { ok: false, error: '群组至少需要一个 Bot' }
      for (const botId of botIds) {
        if (findBot(botId) === null) return { ok: false, error: 'Bot 不存在：' + botId }
      }
      patch.botIds = botIds
    }
    if (body.primaryBotId !== undefined) {
      patch.primaryBotId = typeof body.primaryBotId === 'string' ? body.primaryBotId.trim() : null as unknown as string
    }
    if (body.model !== undefined) patch.model = normalizeGroupModel(body.model) as GroupModel
    const updated = updateGroupRecord(id, patch)
    if (updated === null) return { ok: false, error: '群组不存在' }
    return { ok: true, group: updated }
  } catch (error) {
    return { ok: false, error: '更新群组失败：' + errorText(error) }
  }
}

export function deleteGroupById(id: string): { ok: boolean; error?: string } {
  return deleteGroupRecord(id) ? { ok: true } : { ok: false, error: '群组不存在' }
}

export function listGroupViews(): Array<BotGroup & { members: GroupMember[] }> {
  return listGroups().map(groupView)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
