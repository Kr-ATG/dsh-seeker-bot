/**
 * Personal Agent — 历史会话检索（宿主半身）。
 *
 * ## 它解决什么问题
 *
 * Bot 会话虽然终身，但上下文会被压缩、用户也会手动开新会话。用户问「上次我们
 * 讨论过的那个方案」时，模型很可能已经看不到那段历史。这里把前端增量同步来的
 * 消息落到本地索引；每轮回复前只在用户文本命中检索词时查一次，把最相关的几条
 * 历史片段作为 developer 消息投给 agent（模型可见、用户不可见）。
 *
 * ## 与其它记忆模块的分工
 *
 * - 长期记忆：偏好 / 事实，跨会话、按语义检索（memory 引擎负责）。
 * - 工作记忆：当前任务状态，每轮都注入（见 ./working-memory.ts）。
 * - 接力摘要：手动轮转时的结构化交接单（见 ./relay.ts）。
 * - 历史检索：**按需**捞原始对话片段——用户明确提到「之前 / 上次」时才查，
 *   不命中检索词就完全不注入，避免白占上下文。
 *
 * ## 存储
 *
 * `~/.dsh/storages/dsh-seeker-bot/personal-agent/history/<botId>.json`
 * 结构 `{ version: 1, updatedAt, messages: [{ id, role: 'user' | 'bot', text, at }] }`，
 * 保留最近 2000 条（按 at 升序）。botId 清洗规则与 working-memory / relay 一致。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createWorkingMemoryMessage } from './working-memory.ts'

/** 单条消息文本上限（字符）。消息再长，检索时也只需要开头一段。 */
export const HISTORY_TEXT_MAX = 1000
/** 每个 Bot 保留的消息条数上限。 */
export const HISTORY_MESSAGES_MAX = 2000
/** 命中结果默认返回条数。 */
export const HISTORY_SEARCH_LIMIT = 5
/** 时间衰减窗口：半年内线性，越新越高。 */
const RECENCY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000

/** 一条历史消息（前端同步 / 索引落盘的最小单位）。 */
export interface HistoryMessage {
  id: string
  role: 'user' | 'bot'
  text: string
  at: number
}

/** 落盘结构。 */
interface HistoryFile {
  version: 1
  updatedAt: number
  messages: HistoryMessage[]
}

/** 检索结果里的一条。 */
export interface HistorySearchHit {
  score: number
  id: string
  role: HistoryMessage['role']
  text: string
  at: number
}

/** searchHistory 的返回值（ok 恒为 true，接口形状与其它路由保持一致）。 */
export interface HistorySearchResult {
  ok: true
  total: number
  results: HistorySearchHit[]
}

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/**
 * 某个 Bot 的历史索引文件。
 *
 * botId 来自前端（可能由用户命名），必须做文件名清洗，否则 `../` 之类会把
 * 读写带出 history 目录。清洗规则与 working-memory.ts / relay.ts 完全一致。
 */
export function historyFile(botId: string): string {
  const safe = String(botId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'main'
  return join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent', 'history', `${safe}.json`)
}

/** 收敛单条消息：角色只认 user / bot / assistant，文本截断，at 必须是正整数毫秒。 */
function normalizeHistoryMessage(item: unknown, index: number, now: number): HistoryMessage | null {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as Record<string, unknown>
  const role: HistoryMessage['role'] | null = record.role === 'user'
    ? 'user'
    : record.role === 'bot' || record.role === 'assistant'
      ? 'bot'
      : null
  if (role === null) return null
  const text = typeof record.text === 'string' ? record.text.trim().slice(0, HISTORY_TEXT_MAX) : ''
  if (text === '') return null
  const at = typeof record.at === 'number' && Number.isFinite(record.at) && record.at > 0
    ? Math.round(record.at)
    : now
  const rawId = typeof record.id === 'string' ? record.id.trim().slice(0, 128) : ''
  const id = rawId !== '' ? rawId : `h-${at.toString(36)}-${index.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return { id, role, text, at }
}

/** 批量收敛 + 按 at 升序 + 保留最近 HISTORY_MESSAGES_MAX 条。 */
function normalizeHistoryMessages(input: unknown, now = Date.now()): HistoryMessage[] {
  if (!Array.isArray(input)) return []
  const cleaned: HistoryMessage[] = []
  input.forEach((item, index) => {
    const message = normalizeHistoryMessage(item, index, now)
    if (message !== null) cleaned.push(message)
  })
  cleaned.sort((a, b) => a.at - b.at)
  return cleaned.length > HISTORY_MESSAGES_MAX ? cleaned.slice(-HISTORY_MESSAGES_MAX) : cleaned
}

function emptyHistoryFile(): HistoryFile {
  return { version: 1, updatedAt: 0, messages: [] }
}

/** 读完整索引（文件不存在 / 坏 JSON 都返回空，不让索引问题挡住对话）。 */
async function readHistoryData(botId: string): Promise<HistoryFile> {
  try {
    const raw = await readFile(historyFile(botId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyHistoryFile()
    const record = parsed as Record<string, unknown>
    return {
      version: 1,
      updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
      messages: normalizeHistoryMessages(record.messages),
    }
  } catch {
    return emptyHistoryFile()
  }
}

/** 读某个 Bot 的历史消息（按 at 升序）。 */
export async function readHistoryMessages(botId: string): Promise<HistoryMessage[]> {
  return (await readHistoryData(botId)).messages
}

/** 全量写回（调用方负责串行）；写入前再收敛一次，防止手改文件把脏数据带进来。 */
export async function writeHistoryMessages(botId: string, messages: unknown[]): Promise<void> {
  const file = historyFile(botId)
  const cleaned = normalizeHistoryMessages(messages)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, updatedAt: Date.now(), messages: cleaned }, null, 2), 'utf8')
  tokenCache.delete(botId)
}

/**
 * 增量写入一批消息（前端每次把新产生的消息推上来）。
 *
 * 按 id 去重：同一条消息被前端重复同步（网络重试 / 多窗口）时不会膨胀；
 * 同 id 内容更新时以新内容为准。最后按 at 升序保留最近 2000 条。
 *
 * @returns 合并后的完整消息列表（供路由返回总数）
 */
export async function upsertHistoryMessages(botId: string, messages: unknown[]): Promise<HistoryMessage[]> {
  const incoming = normalizeHistoryMessages(messages)
  if (incoming.length === 0) return (await readHistoryData(botId)).messages
  const current = (await readHistoryData(botId)).messages
  const byId = new Map<string, HistoryMessage>()
  for (const message of current) byId.set(message.id, message)
  for (const message of incoming) byId.set(message.id, message)
  const merged = [...byId.values()].sort((a, b) => a.at - b.at)
  const kept = merged.length > HISTORY_MESSAGES_MAX ? merged.slice(-HISTORY_MESSAGES_MAX) : merged
  await writeHistoryMessages(botId, kept)
  return kept
}

/* ───────────────────────────── 分词与检索 ───────────────────────────── */

/** 单字停用词：只在「孤立单字」token 层面过滤，不影响 2-gram。 */
const STOP_SINGLE_CHARS = new Set('的了呢吗我你他她它这那在有和就都也还又很等'.split(''))

/**
 * 把文本切成检索 token。
 *
 * - 中文：连续汉字段按 2-gram（「历史会话」→ 历史 / 史会 / 会话）；
 *   单字段只在不是停用词时保留（「钱」这种单字查询仍可检索）。
 * - 英文 / 数字：按词小写，长度 >= 2（「a」「I」这类单字母没有检索价值）。
 *
 * 返回去重后的 token（保持首次出现顺序），查询与索引共用同一套规则。
 */
export function tokenizeHistory(text: string): string[] {
  const source = String(text ?? '')
  if (source === '') return []
  const tokens: string[] = []
  const push = (token: string): void => {
    if (token !== '') tokens.push(token)
  }
  for (const segment of source.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (segment.length === 1) {
      if (!STOP_SINGLE_CHARS.has(segment)) push(segment)
      continue
    }
    for (let index = 0; index + 1 < segment.length; index += 1) push(segment.slice(index, index + 2))
  }
  for (const word of source.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (word.length >= 2) push(word)
  }
  return [...new Set(tokens)]
}

/** 每条消息的 token 集合缓存：文件未变化时不必每轮重新切 2000 条。 */
const tokenCache = new Map<string, { stamp: string; tokens: Map<string, Set<string>> }>()

function tokenStampOf(file: HistoryFile): string {
  const last = file.messages[file.messages.length - 1]
  return `${file.updatedAt}:${file.messages.length}:${last?.id ?? ''}:${last?.at ?? 0}`
}

/** 取某个 Bot 的 token 索引（带缓存；写路径会清掉对应条目）。 */
function tokensForFile(botId: string, file: HistoryFile): Map<string, Set<string>> {
  const stamp = tokenStampOf(file)
  const cached = tokenCache.get(botId)
  if (cached !== undefined && cached.stamp === stamp) return cached.tokens
  const tokens = new Map<string, Set<string>>()
  for (const message of file.messages) tokens.set(message.id, new Set(tokenizeHistory(message.text)))
  tokenCache.set(botId, { stamp, tokens })
  return tokens
}

/** 候选池大小：先按旧规则（非加权覆盖率）取前 20，再做轻量 rerank。 */
const RERANK_POOL = 20
/** 多样性阈值：同一 Bot 内两条结果 token 集 Jaccard 超过它视为重复。 */
const DIVERSITY_JACCARD = 0.8

/** 两个 token 集的 Jaccard 相似度（空集按 0 处理，避免除零）。 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let intersection = 0
  for (const token of small) {
    if (large.has(token)) intersection += 1
  }
  return intersection / (a.size + b.size - intersection)
}

/** 候选（带 rerank 需要的中间量；tokens 只用于多样性判断，不返回前端）。 */
interface RankedCandidate {
  id: string
  role: HistoryMessage['role']
  text: string
  at: number
  tokens: Set<string>
  baseScore: number
  weightedCoverage: number
  exact: number
  recency: number
}

/**
 * 在某个 Bot 的历史索引里检索（内存打分，最多 2000 条，目标 < 500ms）。
 *
 * 两段式打分（第 4 步增强，不引入 embedding）：
 *  1. 候选：旧规则「覆盖率 * 0.7 + 精确子串 * 0.2 + recency * 0.1」取前 20；
 *  2. rerank：「IDF 加权覆盖率 * 0.6 + 精确短语 * 0.25 + recency * 0.15」重排。
 *
 * IDF 权重 = log((N+1)/(df+1)) + 1：像「存在」「完全」这种满屏都是的 bigram
 * 权重自动变低，命中真正少见的词（如「量子纠缠」）才容易排前面。
 * 同一 Bot 内近似重复（token 集 Jaccard > 0.8，比如重复的进度播报）只留最高分。
 * 只返回至少命中一个 token（或整句子串）的消息——没命中的消息不该因为
 * 「时间新」被带进来。
 */
export async function searchHistory(botId: string, query: string, limit = HISTORY_SEARCH_LIMIT): Promise<HistorySearchResult> {
  const trimmed = String(query ?? '').trim()
  if (trimmed === '') return { ok: true, total: 0, results: [] }
  const file = await readHistoryData(botId)
  if (file.messages.length === 0) return { ok: true, total: 0, results: [] }

  const queryTokens = tokenizeHistory(trimmed)
  const needle = trimmed.toLowerCase()
  const tokenMap = tokensForFile(botId, file)
  const total = file.messages.length

  /*
   * IDF：df 是「命中该 token 的消息数」。查询 token 在语料里完全没出现时
   * df=0、权重最大，但它不可能命中任何消息，只会把所有人的加权覆盖率一起
   * 拉低——排序不受影响，属于可接受的代价。
   */
  const tokenWeights = new Map<string, number>()
  let weightSum = 0
  for (const token of queryTokens) {
    let df = 0
    for (const message of file.messages) {
      const messageTokens = tokenMap.get(message.id) ?? new Set(tokenizeHistory(message.text))
      if (messageTokens.has(token)) df += 1
    }
    const weight = Math.log((total + 1) / (df + 1)) + 1
    tokenWeights.set(token, weight)
    weightSum += weight
  }

  const now = Date.now()
  const candidates: RankedCandidate[] = []
  for (const message of file.messages) {
    const messageTokens = tokenMap.get(message.id) ?? new Set(tokenizeHistory(message.text))
    let matched = 0
    let matchedWeight = 0
    for (const token of queryTokens) {
      if (messageTokens.has(token)) {
        matched += 1
        matchedWeight += tokenWeights.get(token) ?? 0
      }
    }
    const coverage = queryTokens.length > 0 ? matched / queryTokens.length : 0
    const weightedCoverage = weightSum > 0 ? matchedWeight / weightSum : 0
    const exact = needle !== '' && message.text.toLowerCase().includes(needle) ? 1 : 0
    // 一个 token 都没命中、整句也不是子串：与查询无关，不进入候选
    if (matched === 0 && exact === 0) continue
    const age = Math.max(0, now - message.at)
    const recency = Math.max(0, Math.min(1, 1 - age / RECENCY_WINDOW_MS))
    candidates.push({
      id: message.id,
      role: message.role,
      text: message.text,
      at: message.at,
      tokens: messageTokens,
      baseScore: coverage * 0.7 + exact * 0.2 + recency * 0.1,
      weightedCoverage,
      exact,
      recency,
    })
  }

  // 第一段：旧规则排序，只把前 20 送进 rerank（2000 条里重排全部没必要）
  candidates.sort((a, b) => b.baseScore - a.baseScore || b.at - a.at)
  const reranked = candidates.slice(0, RERANK_POOL).map((candidate) => ({
    ...candidate,
    score: Math.round((candidate.weightedCoverage * 0.6 + candidate.exact * 0.25 + candidate.recency * 0.15) * 10_000) / 10_000,
  }))
  reranked.sort((a, b) => b.score - a.score || b.at - a.at)

  // 第二段：同一 Bot 内的近似重复只保留分数最高的一条
  const diverse: typeof reranked = []
  for (const candidate of reranked) {
    if (diverse.some((kept) => jaccardSimilarity(kept.tokens, candidate.tokens) > DIVERSITY_JACCARD)) continue
    diverse.push(candidate)
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.round(limit))) : HISTORY_SEARCH_LIMIT
  return {
    ok: true,
    total: candidates.length,
    results: diverse.slice(0, safeLimit).map((candidate) => ({
      score: candidate.score,
      id: candidate.id,
      role: candidate.role,
      text: candidate.text,
      at: candidate.at,
    })),
  }
}

/* ───────────────────────────── 注入 ───────────────────────────── */

/** 本地时间格式：YYYY-MM-DD HH:mm（历史注入与跨 Bot 摘要共用）。 */
export function formatHistoryTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '未知时间'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 构建注入文本；空结果返回空串（调用方据此跳过注入）。
 *
 * 每条只留 300 字摘要：历史片段是线索，不是让模型复读的全文。
 */
export function buildHistoryBlock(results: Array<Pick<HistoryMessage, 'role' | 'text' | 'at'>>): string {
  if (!Array.isArray(results) || results.length === 0) return ''
  const lines: string[] = ['【历史会话检索 · 仅供参考】']
  for (const item of results) {
    const summary = String(item.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (summary === '') continue
    lines.push(`[${formatHistoryTime(item.at)}] ${item.role === 'user' ? '用户' : 'Bot'}：${summary}`)
  }
  if (lines.length === 1) return ''
  lines.push('（这是历史片段，不是实时事实，冲突时以当前对话为准）')
  return lines.join('\n')
}

/** 用户这句话是否在「翻旧账」——只有命中才值得查一次索引。 */
const HISTORY_TRIGGERS = [
  '之前',
  '上次',
  '以前',
  '曾经',
  '聊过',
  '说过',
  '当时',
  '那天',
  '继续上次',
  '还记得',
  '那个方案',
  '前面提到',
  '早先',
  '我们讨论过',
]

/** 判断是否触发历史检索（任一关键词命中即 true）。 */
export function shouldSearchHistory(text: string): boolean {
  const source = String(text ?? '')
  if (source === '') return false
  return HISTORY_TRIGGERS.some(trigger => source.includes(trigger))
}

/**
 * 每个会话上次注入的历史检索指纹（与 working-memory / relay 同理由）。
 *
 * 历史检索是按需触发的：用户连续两轮都问「上次那个方案」，检索结果往往一模一样；
 * 不去重会在历史里堆多份相同的 developer 消息，既费 token 又像在反复强调。
 */
const injectedHash = new Map<string, string>()

/**
 * 把命中的历史片段注入 agent。
 *
 * - 只有 shouldSearchHistory(userText) 为 true 才查索引；
 * - 检索结果为空 / 构建文本为空就不注入；
 * - 按「会话 + 内容 sha1」去重，resetHistoryInjection 可清。
 *
 * 失败一律吞掉：历史检索是增强项，它坏了不能连累对话本身。
 *
 * @returns 是否真的注入了一条
 */
export async function injectHistoryIntoAgent(agent: any, botId: string, userText: string): Promise<boolean> {
  if (agent === null || typeof agent !== 'object' || typeof agent.inject !== 'function') return false
  if (!shouldSearchHistory(userText)) return false
  try {
    const found = await searchHistory(botId, userText, HISTORY_SEARCH_LIMIT)
    if (!found.ok || found.results.length === 0) return false
    const text = buildHistoryBlock(found.results)
    if (text === '') return false
    const sessionId = String(agent?.session?.id ?? botId)
    const hash = createHash('sha1').update(text).digest('hex')
    if (injectedHash.get(sessionId) === hash) return false
    agent.inject(createWorkingMemoryMessage(text))
    injectedHash.set(sessionId, hash)
    return true
  } catch {
    /* 检索 / 注入失败：这一轮先不带历史片段 */
    return false
  }
}

/**
 * 清掉某个会话的注入指纹（清空对话 / 重置 Bot 后调用）。
 *
 * 不清的话，重置后的新会话内容相同会被判定成「已注入过」而永远不注入。
 */
export function resetHistoryInjection(sessionIdOrBotId: string): void {
  const key = String(sessionIdOrBotId ?? '')
  if (key === '') {
    injectedHash.clear()
    return
  }
  injectedHash.delete(key)
  // 调用方可能传 botId（清空对话后按 Bot 重置），把对应会话一起清掉
  for (const sessionId of [...injectedHash.keys()]) {
    if (sessionId.includes(key)) injectedHash.delete(sessionId)
  }
}

/** 测试用：暴露内部实现。 */
export const historySearchTest = {
  historyFile,
  readHistoryMessages,
  writeHistoryMessages,
  upsertHistoryMessages,
  tokenizeHistory,
  searchHistory,
  buildHistoryBlock,
  shouldSearchHistory,
  injectHistoryIntoAgent,
  resetHistoryInjection,
}
