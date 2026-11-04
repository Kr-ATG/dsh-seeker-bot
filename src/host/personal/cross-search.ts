/**
 * Personal Agent — 跨 Bot 历史检索（宿主半身）。
 *
 * ## 它解决什么问题
 *
 * 第 3 步的历史检索只在单个 Bot 自己的历史里查。主 Bot 常被问「其他 Bot 之前
 * 讨论过什么 / 团队各自有什么进展」——这些信息散落在每个子 Bot 的历史索引里。
 * 这里提供一条**只读、只出摘要**的跨 Bot 检索通道：主 Bot 能拿到其他 Bot 的
 * 历史线索，但看不到全文，避免把别的会话整段搬进当前上下文。
 *
 * ## 边界
 *
 * - **只有主 Bot 能触发注入**（spec.isMain === true）：子 Bot 之间互相翻历史会
 *   让身份边界变模糊，也会把「谁该知道什么」搅乱。
 * - 只返回每条 ≤200 字的摘要，不返回全文；原文件仍只在本机。
 * - 子 Bot 列表来自宿主的 created-bots 账本（./bot-create.ts）；前端自己建的
 *   Bot 只要走过 bot_create 就在里面。
 *
 * 失败一律吞掉：跨 Bot 检索是增强项，它坏了不能连累对话本身。
 */

import { createHash } from 'node:crypto'
import { readCreatedBots, __resetCreatedBotsCache } from './bot-create.ts'
import { formatHistoryTime, searchHistory } from './history-search.ts'
import { createWorkingMemoryMessage } from './working-memory.ts'

/** 单条跨 Bot 摘要上限（字符）。 */
export const CROSS_HIT_MAX = 200
/** 每个 Bot 最多返回 / 注入几条。 */
export const CROSS_HITS_PER_BOT = 2

/** 跨 Bot 检索命中（只带摘要，不带全文）。 */
export interface CrossBotHit {
  score: number
  role: 'user' | 'bot'
  text: string
  at: number
}

/** 一个 Bot 的检索结果小节。 */
export interface CrossBotSection {
  botId: string
  botName: string
  role: string
  hits: CrossBotHit[]
}

/** searchAcrossBots 的返回值。 */
export interface CrossBotSearchResult {
  ok: true
  total: number
  bots: CrossBotSection[]
}

/** 摘要：压缩空白 + 截到 200 字。 */
function summarizeCrossHit(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, CROSS_HIT_MAX)
}

/**
 * 检索其他 Bot 的历史摘要。
 *
 * @param fromBotId 发起检索的 Bot（结果里排除它自己；主 Bot 通常不在账本里）
 * @param query 用户原话
 * @param limitPerBot 每个 Bot 最多返回几条（默认 2，收敛到 1–10）
 */
export async function searchAcrossBots(
  fromBotId: string,
  query: string,
  limitPerBot = CROSS_HITS_PER_BOT,
): Promise<CrossBotSearchResult> {
  const trimmed = String(query ?? '').trim()
  if (trimmed === '') return { ok: true, total: 0, bots: [] }
  const from = String(fromBotId ?? '').trim()
  const safeLimit = Number.isFinite(limitPerBot)
    ? Math.max(1, Math.min(10, Math.round(limitPerBot)))
    : CROSS_HITS_PER_BOT

  const sections: CrossBotSection[] = []
  for (const record of readCreatedBots()) {
    if (record.id === from) continue
    let found
    try {
      // 先取 3 条再截 limitPerBot：searchHistory 内部已做多样性去重，多取一条做缓冲
      found = await searchHistory(record.id, trimmed, 3)
    } catch {
      continue
    }
    if (!found.ok || found.results.length === 0) continue
    const hits: CrossBotHit[] = []
    for (const hit of found.results.slice(0, safeLimit)) {
      const summary = summarizeCrossHit(hit.text)
      if (summary === '') continue
      hits.push({ score: hit.score, role: hit.role, text: summary, at: hit.at })
    }
    if (hits.length === 0) continue
    sections.push({ botId: record.id, botName: record.name, role: record.role, hits })
  }

  const total = sections.reduce((sum, section) => sum + section.hits.length, 0)
  return { ok: true, total, bots: sections }
}

/** 跨 Bot 检索触发词。 */
const CROSS_TRIGGERS = ['子 Bot', '其他 Bot', '别的 Bot', '团队', '所有 Bot', '分身', '大家', '各自']

/**
 * 用户这句话是不是在问「其他 Bot / 团队」的信息。
 *
 * 匹配前把空白去掉，所以「子 Bot」「子Bot」「其他 Bot」「其他Bot」都命中。
 */
export function shouldSearchAcrossBots(text: string): boolean {
  const source = String(text ?? '')
  if (source === '') return false
  const compact = source.replace(/\s+/g, '')
  return CROSS_TRIGGERS.some((trigger) => compact.includes(trigger.replace(/\s+/g, '')))
}

/**
 * 构建跨 Bot 注入文本：每个 Bot 一节、每节最多 2 条、每条 ≤200 字。
 *
 * 明确标注「来自其他 Bot 的历史摘要，仅供线索」——这些是别的会话的片段，
 * 不是当前对话的事实，模型不能拿它当用户刚说的话。
 */
export function buildCrossBotBlock(bots: CrossBotSection[]): string {
  if (!Array.isArray(bots) || bots.length === 0) return ''
  const lines: string[] = ['【跨 Bot 历史检索 · 仅摘要】']
  let sectionCount = 0
  for (const section of bots) {
    const valid = (Array.isArray(section.hits) ? section.hits : [])
      .slice(0, CROSS_HITS_PER_BOT)
      .map((hit) => ({ ...hit, text: summarizeCrossHit(hit.text) }))
      .filter((hit) => hit.text !== '')
    if (valid.length === 0) continue
    sectionCount += 1
    lines.push('## ' + String(section.botName ?? section.botId) + '（' + String(section.role ?? '') + '）')
    for (const hit of valid) {
      lines.push('- [' + formatHistoryTime(hit.at) + '] ' + (hit.role === 'user' ? '用户' : 'Bot') + '：' + hit.text)
    }
  }
  if (sectionCount === 0) return ''
  lines.push('（来自其他 Bot 的历史摘要，仅供线索）')
  return lines.join('\n')
}

/** 注入函数的 spec 只需要这两个字段（不反向依赖 agent.ts 的大模块）。 */
export interface CrossBotAgentSpec {
  botId: string
  isMain?: boolean
}

/** 每个会话上次注入的跨 Bot 摘要指纹（与 working-memory / relay 同理由）。 */
const injectedHash = new Map<string, string>()

/**
 * 把其他 Bot 的历史摘要注入 agent。
 *
 * 仅 spec.isMain === true 且用户文本命中跨 Bot 触发词时执行；按
 * 「会话 + 内容 sha1」去重；失败吞掉。
 *
 * @returns 是否真的注入了一条
 */
export async function injectCrossBotHistoryIntoAgent(
  agent: any,
  spec: CrossBotAgentSpec,
  userText: string,
): Promise<boolean> {
  if (agent === null || typeof agent !== 'object' || typeof agent.inject !== 'function') return false
  if (spec === null || typeof spec !== 'object' || spec.isMain !== true) return false
  if (!shouldSearchAcrossBots(userText)) return false
  try {
    const found = await searchAcrossBots(spec.botId, userText)
    if (!found.ok || found.bots.length === 0) return false
    const text = buildCrossBotBlock(found.bots)
    if (text === '') return false
    const sessionId = String(agent?.session?.id ?? spec.botId)
    const hash = createHash('sha1').update(text).digest('hex')
    if (injectedHash.get(sessionId) === hash) return false
    agent.inject(createWorkingMemoryMessage(text))
    injectedHash.set(sessionId, hash)
    return true
  } catch {
    /* 检索 / 注入失败：这一轮先不带跨 Bot 摘要 */
    return false
  }
}

/** 清掉某个会话的跨 Bot 注入指纹（清空对话 / 重置 Bot 后调用）。 */
export function resetCrossBotHistoryInjection(sessionIdOrBotId: string): void {
  const key = String(sessionIdOrBotId ?? '')
  if (key === '') {
    injectedHash.clear()
    return
  }
  injectedHash.delete(key)
  for (const sessionId of [...injectedHash.keys()]) {
    if (sessionId.includes(key)) injectedHash.delete(sessionId)
  }
}

/** 测试用：暴露内部实现（含重置 created-bots 的内存缓存）。 */
export const crossSearchTest = {
  searchAcrossBots,
  shouldSearchAcrossBots,
  buildCrossBotBlock,
  injectCrossBotHistoryIntoAgent,
  resetCrossBotHistoryInjection,
  resetCreatedBotsCache: __resetCreatedBotsCache,
}
