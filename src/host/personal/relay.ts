/**
 * Personal Agent — 「接力摘要」的宿主半身。
 *
 * ## 它解决什么问题
 *
 * Bot 会话手动轮转（「整理并开新会话」）时，旧会话里的目标、已完成的事、
 * 关键决策、待办与文件路径不能跟着一起消失——否则新会话的 Bot 只能从零问
 * 「我们刚才说到哪了」。这里负责把共享契约（`src/shared/relay.ts`）落成
 * 宿主能力：
 *
 *   1. **生成**：`ctx.llm.stream` 读真实对话素材，按字段整理成 `RelayBrief`；
 *      模型不可用 / 输出坏 JSON 时退到规则兜底（`fallbackRelayBrief`），
 *      标记 `degraded:true`——宁可给一份粗糙但真实的交接单，也不让用户点了
 *      整理却什么都没留下。
 *   2. **落盘**：`<DSH_HOME>/storages/dsh-seeker-bot/personal-agent/relay/<botId>.json`，
 *      与 working-memory 同级；刷新页面 / 重启宿主都不丢。
 *   3. **注入**：每轮回复前把摘要作为 developer 消息投给 agent（不显示给用户、
 *      不会被记忆提取当成用户原话），按「会话 + 内容 sha1」去重，避免历史里
 *      堆十份一样的 developer 消息。
 *
 * 字段定义全部来自 shared，本文件不重复定义——两份字段名漂移会让前端读不到
 * 数据，而且不会有任何报错。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  RELAY_MESSAGE_MAX_CHARS,
  RELAY_MESSAGES_MAX,
  buildRelayBlock,
  fallbackRelayBrief,
  normalizeRelayBrief,
  reconcileRelayBrief,
  type RelayBrief,
  type RelayMessage,
} from '../../shared/relay.ts'
import { createUserMessage } from '../../vendor/dsh-llm/index.ts'
import { getLlm, parseJournalJson, resolveChatModel } from './journal.ts'

/** 生成超时：模型调用最多 90 秒（与期刊生成同口径，推理模型偶尔慢但不该无限挂起）。 */
const GENERATE_TIMEOUT_MS = 90_000

/* ───────────────────────────── 存储 ───────────────────────────── */

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/**
 * 某个 Bot 的接力摘要文件。
 *
 * botId 来自前端（可能由用户命名），必须做文件名清洗，否则 `../` 之类会
 * 把读写带出 relay 目录。清洗规则与 working-memory.ts 完全一致，保持两个
 * 存储目录的命名可对照。
 */
export function relayFile(botId: string): string {
  const safe = String(botId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'main'
  return join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent', 'relay', `${safe}.json`)
}

/** 把落盘 JSON 里的扩展字段（source / edited）补回清洗后的 brief。 */
function restoreBriefExtras(brief: RelayBrief, raw: Record<string, unknown>): RelayBrief {
  const source = raw.source
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>
    const count = typeof record.messages === 'number' && Number.isFinite(record.messages)
      ? Math.max(0, Math.round(record.messages))
      : undefined
    const from = typeof record.from === 'number' && Number.isFinite(record.from) ? Math.round(record.from) : undefined
    const to = typeof record.to === 'number' && Number.isFinite(record.to) ? Math.round(record.to) : undefined
    if (count !== undefined) {
      brief.source = {
        messages: count,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      }
    }
  }
  if (raw.edited === true) brief.edited = true
  return brief
}

/**
 * 读某个 Bot 的接力摘要。
 *
 * 文件不存在 / 坏 JSON / 内容全空都返回 null（不阻塞对话）；读出来的内容再
 * 走一次 normalizeRelayBrief，防止手改文件把前端弄崩。
 */
export async function readRelayBrief(botId: string): Promise<RelayBrief | null> {
  try {
    const raw = await readFile(relayFile(botId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const brief = normalizeRelayBrief(parsed)
    if (brief === null) return null
    /*
     * 旧文件里可能还留着「下一步 = 已完成」的重复条目（生成提示词修复之前落盘的）。
     * 读的时候统一清一次，否则这次修复只对之后新生成的摘要生效，正在跑的会话
     * 仍会被旧摘要诱导重做。
     */
    return restoreBriefExtras(reconcileRelayBrief(brief), parsed as Record<string, unknown>)
  } catch {
    return null
  }
}

/** 全量写回（调用方负责串行）。 */
export async function writeRelayBrief(botId: string, brief: RelayBrief): Promise<void> {
  const file = relayFile(botId)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(brief, null, 2), 'utf8')
}

/** 删除某个 Bot 的接力摘要（文件不存在不算错）。 */
export async function clearRelayBrief(botId: string): Promise<void> {
  await rm(relayFile(botId), { force: true })
}

/* ───────────────────────────── 提示词 ───────────────────────────── */

/**
 * 接力摘要生成的 system 提示词。
 *
 * 核心约束与期刊一致：**只依据素材、只输出 JSON**；额外强调「数字 / 路径 /
 * 命名原样保留」——交接单的价值就在这些下一轮能直接执行的细节上，改一个字
 * 都可能让新会话找错文件。
 */
export function relaySystemPrompt(): string {
  return [
    '你是一位资深中文助理，负责把一段即将结束的对话整理成「接力摘要」，交给下一个会话继续执行。',
    '你只能依据下面提供的对话素材整理：不得编造素材里没有的事实、数字、人名、时间、文件路径或结论。',
    '数字、文件路径、命令、接口名、变量名、命名必须原样保留：不要改写、不要翻译、不要补全。',
    '素材不足以支撑某个字段时，对应字段给空数组或空字符串，不要补空话套话。',
    '',
    '最重要的一条：下一个会话会照着这份摘要继续干活，所以**已经做完的事不能被写成待办**。',
    'done 与 next / pending 必须互斥：同一个动作只能出现在一个字段里。',
    '如果上一段已经把某件事派给子 Bot、已经建好定时检查、或者正在等外部事件，把它写进 done（写明「已启动」），next 里只写后续动作（等回报、做增量对比、向用户汇报），绝不能再写一次「执行检查」「重新开始」「重建基线」这类重复动作。',
    '',
    '字段要求：',
    '- goal：这一段对话要完成的目标（一句话，<=120 字）。',
    '- done：已经完成的事（1–8 条，每条 <=120 字）。已经启动并在进行的持续任务也算完成，不要因为它还在等结果就写进 next。',
    '- decisions：已确认的决策与约束（数字、路径、命名、接口；0–8 条）。用户明确确认过的口径（例如「什么情况算有动静」）必须原样记在这里，下一个会话不用再问一遍。',
    '- pending：未完成 / 等外部事件或用户处理的事（0–8 条）。',
    '- next：下一步建议（0–8 条）。只写**还没开始**的动作；已经被 done 覆盖的动作一条都不能再写。',
    '- files：相关的文件 / 命令 / 链接（0–12 条，保持原文）。',
    '',
    '输出格式（硬要求）：',
    '- 只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释、前言、后记。',
    '- 字段名必须严格使用：goal, done, decisions, pending, next, files。',
    '- 你回复的第一个字符就是 {，最后一个字符就是 }。',
    'JSON 形状：',
    '{"goal":"","done":[""],"decisions":[""],"pending":[""],"next":[""],"files":[""]}',
  ].join('\n')
}

/** 清洗前端送来的消息：角色收敛、空白压缩、单条截断、最多取最近 40 条。 */
function normalizeRelayMessages(input: unknown): RelayMessage[] {
  if (!Array.isArray(input)) return []
  const cleaned: RelayMessage[] = []
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const role: RelayMessage['role'] | null = record.role === 'user'
      ? 'user'
      : record.role === 'bot' || record.role === 'assistant'
        ? 'bot'
        : null
    if (role === null) continue
    const text = typeof record.text === 'string'
      ? record.text.replace(/\s+/g, ' ').trim().slice(0, RELAY_MESSAGE_MAX_CHARS)
      : ''
    if (text === '') continue
    const at = typeof record.at === 'number' && Number.isFinite(record.at) ? Math.round(record.at) : undefined
    cleaned.push({
      role,
      text,
      ...(at !== undefined ? { at } : {}),
    })
  }
  return cleaned.slice(-RELAY_MESSAGES_MAX)
}

/** 组装接力摘要生成的 user 提示词：对话素材 + 「请只输出 JSON」。 */
export function buildRelayUserPrompt(messages: RelayMessage[]): string {
  const cleaned = normalizeRelayMessages(messages)
  const lines = cleaned.map((message) => `[${message.role === 'user' ? '用户' : 'Bot'}] ${message.text}`)
  return [
    '【对话素材】',
    lines.length === 0 ? '（素材为空）' : lines.join('\n'),
    '',
    '请只输出 JSON。',
  ].join('\n')
}

/* ───────────────────────────── 生成 ───────────────────────────── */

/** `POST /relay/prepare` 的请求体（字段都可选，宿主做运行时校验）。 */
export interface GenerateRelayRequest {
  botId?: string
  botModel?: { provider?: string; model?: string; effort?: string }
  messages?: RelayMessage[]
}

/** 生成结果。失败时 error 是给用户看的中文短句，不是堆栈。 */
export interface GenerateRelayResult {
  ok: boolean
  brief?: RelayBrief
  model?: string
  degraded?: boolean
  error?: string
}

/** 模型不可用时的降级：有素材就一定有兜底摘要。 */
function degradedResult(messages: RelayMessage[], reason: string): GenerateRelayResult {
  const brief = fallbackRelayBrief(messages)
  if (brief === null) return { ok: false, error: '没有可整理的对话' }
  return {
    ok: true,
    brief,
    degraded: true,
    error: `模型整理失败，已用最近对话生成基础摘要：${reason.slice(0, 200)}`,
  }
}

/**
 * 用真实模型把一段对话整理成接力摘要。
 *
 * 失败路径优先走 `fallbackRelayBrief`（`degraded:true` + 可读原因），
 * 只有「完全没有素材」才返回 `ok:false`——用户在清空对话前点「整理」，
 * 必须拿到点什么才能确认下一步。
 */
/** 一次路由的模型调用（失败抛错，由 generateRelayBrief 决定是否换下一个路由）。 */
async function runRelayModelOnce(
  llm: any,
  route: { provider: string; model: string; effort?: string },
  messages: RelayMessage[],
): Promise<{ brief: RelayBrief; model: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS)
  timer.unref?.()
  try {
    let raw = ''
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: buildRelayUserPrompt(messages) }],
        // 消息归属写当前实际装载的 bundle id：用量与会话日志按 bundle 聚合
        source: { kind: 'plugin:dsh-seeker-bot', plugin: 'dsh-seeker-bot' },
      })],
      system: relaySystemPrompt(),
      maxTokens: 2000,
      temperature: 0.3,
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
    }
    if (raw.trim() === '') throw new Error('模型没有返回内容')

    const payload = parseJournalJson(raw)
    const normalized = normalizeRelayBrief(payload)
    if (normalized === null) throw new Error('模型返回的接力摘要为空')
    /*
     * 确定性兜底：提示词已经要求 done / next 互斥，但模型仍会把「已派给子 Bot」
     * 写进 done 又把「子 Bot 执行检查」写进 next。这里按字面证据再清一遍，
     * 保证落盘和新会话注入的都是「已完成不会出现在下一步」的版本。
     */
    const brief = reconcileRelayBrief(normalized)
    return { brief, model: `${route.provider}/${route.model}` }
  } catch (error: any) {
    throw new Error(controller.signal.aborted
      ? `生成超时（${String(Math.round(GENERATE_TIMEOUT_MS / 1000))} 秒）`
      : String(error?.message ?? error))
  } finally {
    clearTimeout(timer)
  }
}

export async function generateRelayBrief(ctx: any, request: GenerateRelayRequest): Promise<GenerateRelayResult> {
  const messages = normalizeRelayMessages(request.messages)
  if (messages.length === 0) return { ok: false, error: '没有可整理的对话' }

  const llm = getLlm(ctx)
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    return degradedResult(messages, '宿主未提供 llm 服务')
  }

  /*
   * 路由候选：Bot 自己的模型 → 宿主默认模型（去重）。
   *
   * 为什么要多试一次：模型偶发返回空内容 / 坏 JSON / 网关抖动时，只试一次就
   * 掉进规则兜底，用户拿到的是一份粗糙摘要；而换默认模型重试的成功率很高，
   * 多花几秒远比「点了整理得到一段截断的原文」值得。两条都失败才降级。
   */
  const routes: Array<{ provider: string; model: string; effort?: string }> = []
  const primary = await resolveChatModel(ctx, request.botModel)
  if (primary !== null) routes.push(primary)
  if (request.botModel !== undefined) {
    const fallback = await resolveChatModel(ctx)
    if (fallback !== null && !routes.some((route) => route.provider === fallback.provider && route.model === fallback.model)) {
      routes.push(fallback)
    }
  }
  if (routes.length === 0) return degradedResult(messages, '未配置可用的聊天模型')

  let lastError = ''
  for (const route of routes) {
    try {
      const result = await runRelayModelOnce(llm, route, messages)
      return { ok: true, brief: result.brief, model: result.model, degraded: false }
    } catch (error: any) {
      lastError = String(error?.message ?? error)
    }
  }
  return degradedResult(messages, lastError)
}

/* ───────────────────────────── 注入 ───────────────────────────── */

/**
 * 每个会话上次注入的接力摘要指纹。
 *
 * 为什么必须去重：摘要是「一段对话的交接单」，在新会话里每轮都会重建同一段
 * 文本；不去重就会在历史里堆十份一模一样的 developer 消息——既费 token，
 * 又会让模型以为你在反复强调同一件事（与 working-memory.ts 同一个理由）。
 */
const injectedHash = new Map<string, string>()

/** 深冻结一条要进会话日志的消息（与 agent.ts 的 createContextMessage 同契约）。 */
function freezeDeep(value: any): any {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) freezeDeep(value[key])
  return Object.freeze(value)
}

/**
 * 构造一条注入消息：面向模型的上下文，不显示给用户。
 *
 * role 必须是 `user`：agent-loop 会把 claim 到的注入消息 append 成
 * `user/message`，v4 校验要求事件类型与 role 一致（developer 角色配
 * user/message 会整轮报错，用户看到「本轮没有产生任何输出」）。
 */
export function createRelayMessage(text: string): any {
  return freezeDeep({
    id: `pa-relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin:dsh-seeker-bot',
      plugin: 'dsh-seeker-bot',
      form: 'snapshot',
      sections: [{ name: '接力摘要', text }],
    },
  })
}

/**
 * 把该 Bot 的接力摘要注入 agent（每轮回复前调用）。
 *
 * 调用点与 working-memory 相同：`runBotTurn` 之前。`agent.inject()` 写入的是
 * 「面向模型的上下文」，不会唤醒驱动器，会落在下一个被接纳的步骤里。
 *
 * 失败一律吞掉：接力摘要是增强项，它坏了不能连累对话本身。
 *
 * @returns 是否真的注入了一条（false = 没摘要 / 内容没变 / agent 不支持 inject）。
 */
export async function injectRelayIntoAgent(agent: any, botId: string): Promise<boolean> {
  if (agent === null || typeof agent !== 'object' || typeof agent.inject !== 'function') return false
  const brief = await readRelayBrief(botId)
  const text = buildRelayBlock(brief)
  if (text === '') return false
  const sessionId = String(agent?.session?.id ?? botId)
  const hash = createHash('sha1').update(text).digest('hex')
  if (injectedHash.get(sessionId) === hash) return false
  try {
    agent.inject(createRelayMessage(text))
    injectedHash.set(sessionId, hash)
    return true
  } catch {
    /* inject 不可用：这一轮先不带接力摘要 */
    return false
  }
}

/**
 * 清掉某个会话的注入指纹（清空对话 / 轮转后代调用）。
 *
 * 不清的话，重置后的新会话内容相同会被判定成「已注入过」而永远不注入——
 * 表现是「开新会话后 Bot 又不知道上一段干到哪了」。
 */
export function resetRelayInjection(sessionIdOrBotId: string): void {
  const key = String(sessionIdOrBotId ?? '')
  if (key === '') {
    injectedHash.clear()
    return
  }
  injectedHash.delete(key)
  // 调用方可能传 botId（/reset 与 /relay/commit 只有 botId），把对应会话一起清掉
  for (const sessionId of [...injectedHash.keys()]) {
    if (sessionId.includes(key)) injectedHash.delete(sessionId)
  }
}

/** 测试用：暴露内部实现。 */
export const relayTest = {
  relayFile,
  readRelayBrief,
  writeRelayBrief,
  clearRelayBrief,
  relaySystemPrompt,
  buildRelayUserPrompt,
  generateRelayBrief,
  injectRelayIntoAgent,
  resetRelayInjection,
  normalizeRelayMessages,
}
