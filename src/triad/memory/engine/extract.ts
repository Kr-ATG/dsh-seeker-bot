/**
 * dsh-memory 提取引擎：turn/end 捕获的本轮对话增量窗口 → LLM 结构化提取候选。
 * 输入是「增量窗口」（本 turn 的 user/assistant 文本），不重读整会话。
 * LLM 失败/超时一律跳过本轮，绝不阻塞对话。
 */

import { BlockAssembler, createUserMessage } from '../../../vendor/dsh-llm/index.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ExtractCandidate, MemoryConfig, MemoryEntry } from '../types.js'
import { semanticSimilarity } from './retrieval.js'
import { summarize } from './store.js'

/** 插件用最小 agent 面（避免深层类型依赖）。 */
export interface MinimalAgent {
  readonly id: string
  readonly options: { provider?: string; model?: string }
  readonly session: {
    readonly id: string
    readonly header?: { cwd?: string }
  }
}

/** 提取超时（毫秒）。 */
const EXTRACT_TIMEOUT_MS = 30_000

/**
 * 提取诊断落盘能力（结构类型，只取 store 的日志方法）。
 * 为什么不用整个 MemoryStore：提取引擎只需要「写一行日志」这一个能力，
 * 收窄参数类型可以避免 store.ts 与 extract.ts 之间长出双向的类型依赖。
 */
export interface ExtractLogSink {
  appendExtractLog(message: string): Promise<void>
}

/**
 * 单轮提取的结果语义。
 *
 * 为什么要四态而不是「有候选 / 没候选」：旧实现把所有路径都塌缩成返回空数组，
 * 于是「模型明确说没啥可记」和「LLM 挂了 / 输出截断 / JSON 解析不出来」在
 * 调用方看来完全一样，只能一起记进失败退避计数——实测 55% 的正常空结果把
 * 会话打成降频态，覆盖率被系统性压低，而真正的失败反而淹没在噪音里。
 *   ok        = 拿到可用候选
 *   ok-empty  = 调用成功但确实没有值得记的内容（正常，应清零失败计数）
 *   parse-fail= 调用成功但输出无法解析成约定结构（失败）
 *   llm-error = 抛错 / 超时 / finish≠stop / 无模型路由（失败）
 */
export type ExtractOutcome = 'ok' | 'ok-empty' | 'parse-fail' | 'llm-error'

/** 提取结果（extractCandidatesWithOutcome 的返回）。 */
export interface ExtractResult {
  candidates: ExtractCandidate[]
  outcome: ExtractOutcome
  /** outcome 为 llm-error / parse-fail 时的原始原因摘要（供调用方落盘；ok/ok-empty 缺省）。 */
  error?: string
}

/**
 * 解析 LLM 输出为候选列表（内部实现）。
 * 返回值三态：undefined=解析失败（不是合法 JSON / 结构不符），
 * []=解析成功但模型判定没有值得记的内容，非空=候选。
 */
function parseExtractPayload(raw: string): ExtractCandidate[] | undefined {
  let text = raw.trim()
  // 剥 markdown code fence。
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  if (fence !== null) text = fence[1]!.trim()
  // 去 BOM / 多余空白。
  text = text.replace(/^\uFEFF/, '').trim()
  // 找最外层 JSON 对象。
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const memories = (parsed as { memories?: unknown }).memories
  if (!Array.isArray(memories)) return undefined
  const out: ExtractCandidate[] = []
  for (const item of memories) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    if (content === '') continue
    const scope = record.scope === 'global' ? 'global' : 'project'
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
        .map(tag => tag.trim())
        .slice(0, 8)
      : []
    const importance = typeof record.importance === 'number' && Number.isFinite(record.importance)
      ? Math.max(1, Math.min(10, Math.round(record.importance)))
      : 5
    /*
     * ttlDays 只认 1-90 的整数：模型偶尔会输出 0（「永久」的另一种写法）、
     * 负数或小数。0 / 负数按「没填」处理（永久），越界的正数钳到 90 天——
     * 90 天是「临时」这个概念的上界，再长就该走正常记忆而不是 TTL。
     */
    const rawTtl = typeof record.ttlDays === 'number' && Number.isFinite(record.ttlDays)
      ? Math.round(record.ttlDays)
      : 0
    const ttlDays = rawTtl > 0 ? Math.min(90, Math.max(1, rawTtl)) : undefined
    out.push({ content, scope, tags, importance, ...(ttlDays === undefined ? {} : { ttlDays }) })
  }
  return out
}

/** 兼容入口：解析失败与空结果都返回 []（既有调用方语义不变）。 */
export function parseExtractOutput(raw: string): ExtractCandidate[] {
  return parseExtractPayload(raw) ?? []
}

/** 提取 prompt：把「闲聊」与「值得记忆」分开，输出结构化 JSON。 */
export function extractSystemPrompt(): string {
  return [
    'You are a memory extractor for an AI assistant. Read the conversation transcript and extract information worth remembering across sessions.',
    'Return ONLY a JSON object in this exact shape (no markdown, no commentary):',
    '{"memories":[{"content":"...","scope":"global"|"project","tags":["..."],"importance":1,"ttlDays":7}]}',
    'Rules:',
    '- Extract only DURABLE cross-session knowledge: user identity, stable preferences, hard-won gotchas, architectural decisions, non-obvious constraints. Litmus test: would a session a month later still act on this? If not, skip it.',
    '- NEVER extract session work logs: commit hashes, push/release announcements, version bumps, "已修复并推送", build/deploy results, file-change lists, intermediate debugging steps, transient bug states. Git and the issue tracker already record those.',
    '- NEVER extract facts trivially derivable from the workspace: package.json contents, dependency lists, directory layouts, file paths, config values the model can simply read again.',
    /*
     * 上面那条「不要记路径」有个必须留的例外：**本轮产出的交付物**。
     * 起因是工具结果现在会进转录（1.2），但 prompt 里一刀切禁止路径，于是
     * 「Bot 刚生成了 report.html」这类唯一值得记的事实被规则自己挡掉——用户
     * 下一轮问「上次那个文件在哪」，记忆库里什么都没有。口径按「产出 vs 读到」
     * 划：产出物记一次（路径 + 是什么），只是读过/搜到的路径仍然不记。
     */
    '- Exception worth remembering: deliverables this task produced (files the assistant created or updated, with their absolute paths and what they are). The user will ask "where is that file" in a later session. Record each deliverable once; do NOT record paths that were merely read, searched, or listed.',
    '- NEVER extract generic programming knowledge, framework docs, or explanations the model already knows.',
    '- Skip small talk, greetings, chit-chat, and content with no lasting value.',
    '- scope: "global" for user identity/preferences/working style; "project" for workspace/project-specific content.',
    '- tags: 1-4 short category tags in the same language as the content (e.g. 技术, 踩坑, 架构, 偏好).',
    '- importance: integer 1-10. 8-10 = durable facts/decisions a future session will act on; anything below 8 is treated as session-scoped noise and dropped. When unsure, score low or skip.',
    /*
     * ── 临时信息（ttlDays）────────────────────────────────────────────
     *
     * 抽取管线里有一类内容在写下那一刻是真的、过几天就是错的：「今天要发 36 条」
     * 「这周先按 A 方案」「临时把端口改成 8080」。它们能过「一个月后还会不会依据
     * 它行动」这一关——因为提问时看起来确实重要——却会在下周变成误导性事实：
     * 模型照着一条过期的「今天要发 36 条」去安排工作。
     *
     * 所以给模型两条路，而不是让它硬判「记 / 不记」：能给出有效期的标 ttlDays
     * （注入侧到点自动过滤），给不出有效期的**宁可不入库**。一句过期的「今天」
     * 比缺一条更糟：缺的那条模型会重新问，过期的那条它会当真。
     */
    '- Temporary facts: if the information only holds for a limited time (e.g. "ship 36 items today", "use plan A this week", "port temporarily changed to 8080"), set "ttlDays" to how many days it stays true (integer 1-90). If you cannot bound it, do NOT extract it — an expired "today" fact is worse than a missing one, because a later session will act on it as if it were current.',
    '- content: write in the original language of the conversation, one complete concise sentence or bullet.',
    '- NEVER extract project instruction files (AGENTS.md, CLAUDE.md), the skill catalog (available skills list), or any skill content: those are auto-injected by the harness and must NOT be stored as memory.',
    '- If nothing is worth remembering, return {"memories":[]}.',
  ].join('\n')
}

/** 组装提取请求的 user 消息（JSON 包裹转录文本，防结构性破坏）。 */
export function extractUserPrompt(transcript: string): string {
  return `Extract memories from this conversation transcript (JSON string):\n${JSON.stringify(transcript)}`
}

/**
 * 通过 DSH 现有模型通道提取候选，并给出可区分的四态结果。
 *
 * 失败一律不抛（提取是尽力而为的副产物，绝不能阻塞对话），但必须把失败原因
 * 如实回传：调用方据此把「正常空结果」与「真失败」分开记两套退避计数。
 *
 * @param log 可选日志下沉口。给了就在失败路径落一行 extract.log——线上只有
 *   debug 日志时，根本分不清「LLM 挂了」和「这轮没啥可记」。
 */
export async function extractCandidatesWithOutcome(
  ctx: Context,
  agent: MinimalAgent,
  transcript: string,
  config: MemoryConfig,
  log?: ExtractLogSink,
): Promise<ExtractResult> {
  /** 失败路径统一收口：落诊断日志 + 返回四态。日志 fire-and-forget，绝不反向打断提取。 */
  const fail = (outcome: ExtractOutcome, detail: string): ExtractResult => {
    if (log !== undefined) {
      // 两层兜底缺一不可：
      // 1) .catch 接住 appendExtractLog 内部 mkdir/appendFile 的异步失败（未处理 rejection
      //    在 Node 24 默认终止进程）；
      // 2) try/catch 接住日志口自身同步抛错的情况——诊断日志无论怎么写不进去，
      //    都不能把「本轮提取失败」升级成「整个会话崩掉」。
      try {
        void log.appendExtractLog(`${outcome}: ${detail}`).catch(() => { /* 异步写失败就当没有 */ })
      } catch { /* 同步抛错同样忽略 */ }
    }
    return { candidates: [], outcome, error: detail }
  }
  if (transcript.trim() === '') return { candidates: [], outcome: 'ok-empty' }
  const llm = ctx.get('llm')
  if (llm === undefined) return fail('llm-error', 'llm service not available on context')
  const route = await resolveRoute(ctx, agent)
  if (route === undefined) return fail('llm-error', 'no LLM route (agent options unset and agentDefaultModel selection empty)')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS)
  try {
    const options = {
      provider: route.provider,
      model: route.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: extractUserPrompt(clipTranscript(transcript, config.extractMaxChars)) }],
        source: { kind: 'plugin:dsh-memory', plugin: 'dsh-memory' },
      })],
      system: extractSystemPrompt(),
      // 推理模型需要空间输出 JSON：text + reasoning 都会产生，上限调高。
      maxTokens: 2048,
      signal: controller.signal,
    }
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk)
    }
    const finish = assembler.finish
    // finish≠stop 表示超时中断或输出被截断：模型根本没走完，算真失败而不是「没内容」。
    if (finish.kind !== 'stop') return fail('llm-error', `finish=${finish.kind} (timeout or truncated output)`)
    // 同时聚合 text 与 reasoning 块：部分推理模型（route=bai 等）在低 token
    // 预算下可能只产出 reasoning 而 text 为空，导致解析出 0 候选。
    const text = assembler.blocks()
      .filter(block => block.type === 'text' || block.type === 'reasoning')
      .map(block => (block as { text?: string }).text ?? '')
      .join(' ')
    const parsed = parseExtractPayload(text)
    // 解析不出来 ≠ 没内容：模型可能只吐了半截 JSON 或压根没按格式来，
    // 这属于失败（要退避降频），不能混进「正常空结果」。
    if (parsed === undefined) {
      return fail('parse-fail', `unparsable output (${text.length} chars): ${text.slice(0, 200)}`)
    }
    // 应用 importance 下限 + 敏感凭据过滤（token/密钥/私钥绝不入库）。
    const candidates = parsed.filter(candidate =>
      candidate.importance >= config.minImportance && !isSensitiveContent(candidate.content))
    // 过滤后为空仍算 ok-empty：调用与解析都成功，只是没有可入库的候选，
    // 这不是模型故障，不该推高失败计数。
    return candidates.length === 0
      ? { candidates: [], outcome: 'ok-empty' }
      : { candidates, outcome: 'ok' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.debug?.(`[dsh-memory] extract failed: ${message}`)
    return fail('llm-error', message)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 兼容入口：只要候选列表（既有调用方语义不变）。
 * 新代码请改用 extractCandidatesWithOutcome——否则又退回「失败与空结果不可区分」。
 */
export async function extractCandidates(
  ctx: Context,
  agent: MinimalAgent,
  transcript: string,
  config: MemoryConfig,
  log?: ExtractLogSink,
): Promise<ExtractCandidate[]> {
  const result = await extractCandidatesWithOutcome(ctx, agent, transcript, config, log)
  return result.candidates
}

/** 敏感凭据模式（自动提取时命中即丢弃，防止密钥/token 入库）。 */
const SENSITIVE_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /sk-[A-Za-z0-9_-]{20,}/i, // OpenAI 等
  /AKIA[0-9A-Z]{16}/, // AWS access key
  /xox[baprs]-[A-Za-z0-9-]{20,}/i, // Slack tokens
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i, // 私钥块
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[=:]\s*[^\s,，。；;]{8,}/i,
]

/** 检测内容是否包含敏感凭据。 */
export function isSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(text))
}

/** 解析 LLM 路由：agent 显式配置优先，回退默认模型选择（consolidate 复用）。 */
export async function resolveRoute(
  ctx: Context,
  agent: MinimalAgent,
): Promise<{ provider: string; model: string } | undefined> {
  if (agent.options.provider !== undefined && agent.options.model !== undefined
    && agent.options.provider !== '' && agent.options.model !== '') {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel !== undefined) {
    try {
      const selection = defaultModel.currentSelection() as { provider?: string; model?: string }
      if (selection.provider !== undefined && selection.model !== undefined) {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // fall through
    }
  }
  return undefined
}

/** 单条工具结果收进提取素材时的截断长度。 */
const TOOL_RESULT_CLIP = 2000

/**
 * 一回合里工具行合计的字符预算。
 *
 * 与单条上限分开：单条 2000 只保证「不爆」，十几次工具调用照样能堆到几万字符，
 * 而提取请求的预算（extractMaxChars，默认 6000）比这还小——不在这里收口，
 * 最后仍会被整份转录的裁剪规则切掉，只是切得没有章法。
 */
const TOOL_LINES_BUDGET = 4000

/**
 * 中间过程类工具：结果只代表「过程状态」，不是本轮最终产出。
 *
 * 两类：
 *  · 状态类（清单 / 待办）：每轮都在变，写进记忆只会得到一堆过期快照；
 *  · 可重新取回的派生物（读文件、搜索、目录树、检索命中）：提取 prompt 本身就
 *    禁止把「工作区里能直接读到的内容」写成记忆，整段灌进去只会诱发这类候选，
 *    还把真正的事实挤出预算。
 *
 * 它们的**路径**仍然要留（见 transcriptFromEvents），只是正文不收。
 */
const INTERMEDIATE_TOOLS = new Set([
  // 状态类
  'todo_write', 'todo_read', 'todo_list', 'task_state',
  // 可重新取回的派生物
  'read', 'grep', 'glob', 'ls', 'list_dir', 'list_files',
  'memory_search', 'memory_pending', 'memory_list',
  // 过程播报：给用户推的进度消息，正文里没有新事实
  'bot_emit', 'progress',
])

/** 工具名归一：去掉 mcp 前缀与命名空间，只留最后一段小写名（mcp__amap__maps_geo → maps_geo）。 */
function baseToolName(name: string): string {
  const lower = name.trim().toLowerCase()
  const parts = lower.split(/__|[.:/]/).filter(part => part !== '')
  return parts.length === 0 ? lower : parts[parts.length - 1]!
}

/** 截断单条工具结果（压平空白后截断：工具输出里的大段缩进/空行没有信息量）。 */
function clipToolResult(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= TOOL_RESULT_CLIP
    ? flat
    : `${flat.slice(0, TOOL_RESULT_CLIP)}…[truncated ${flat.length - TOOL_RESULT_CLIP} chars]`
}

/**
 * 绝对路径提取：只认「盘符开头」或「至少两段的 / 开头」。
 *
 * 为什么不收相对路径：提取素材里没有可靠的工作区基准（同一段文本可能来自
 * 子代理、另一个工作区），猜一个基准只会写出错路径——错路径比没路径更糟。
 */
const ABSOLUTE_PATH_RE = /[A-Za-z]:[\\/][^\s"'`<>|?*，。；：、（）【】]+|\/(?:[\w.@-]+\/)+[\w.@-]+/g

/** 从工具结果里抽文件路径（去重、限 8 条）。 */
function filePathsIn(text: string, limit = 8): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(ABSOLUTE_PATH_RE)) {
    // 句末标点常被正则吞进来（"…report.html."），去掉尾部的标点/括号。
    const path = match[0].replace(/[.,;:)\]}>]+$/, '')
    if (path.length < 4) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 按预算裁剪整份转录：保留头 60% + 尾 40%。
 *
 * 为什么不是只取头部（原来的做法）：工具结果落在转录末尾，而「上次那个文件
 * 在哪」这类问题的线索只在那里——只取头部等于把它们全切掉，纳入工具结果的
 * 改造就白做了。头部保 60%：用户/助手对话仍是提取的主料，得占大头。
 */
function clipTranscript(transcript: string, max: number): string {
  if (transcript.length <= max) return transcript
  const head = Math.floor(max * 0.6)
  const tail = max - head
  const omitted = transcript.length - max
  return `${transcript.slice(0, head)}\n…[middle omitted: ${omitted} chars]…\n${transcript.slice(-tail)}`
}

/** 从事件流维护的 turn 缓冲里取文本（extract 输入）。 */
export function transcriptFromEvents(events: Array<{ type: string; data: unknown }>): string {
  /*
   * ── 为什么把工具结果也收进来（1.2）──────────────────────────────────
   *
   * 原来只收 user/assistant 的正文，于是「Bot 刚生成了 report.html」这件事在
   * 提取素材里**完全不存在**——文件路径只出现在工具结果里。用户下一轮问
   * 「上次那个文件在哪」，模型手里没有任何线索。
   *
   * 但工具结果不能整段收：读文件、跑命令的结果动辄上万字符，而提取要的是
   * 「一个月后还会依据它行动」的结论，不是过程日志。所以三条收窄规则：
   *   ① 单条截断（TOOL_RESULT_CLIP），
   *   ② 一回合合计预算（TOOL_LINES_BUDGET，超了从最早的开始丢），
   *   ③ 中间过程类工具只留路径（INTERMEDIATE_TOOLS）。
   */
  /** 行 + 是否工具行：预算裁剪时只有工具行会被丢，对话正文一行不删。 */
  const lines: Array<{ text: string; tool: boolean }> = []
  /** callId → 工具名：tool/result 自己不带工具名，只能靠 tool/call 配对。 */
  const toolNames = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as { callId?: unknown; name?: unknown }
      if (typeof data?.callId === 'string' && typeof data.name === 'string') toolNames.set(data.callId, data.name)
      continue
    }
    if (event.type === 'tool/result') {
      const data = event.data as {
        message?: { toolCallId?: unknown; content?: unknown }
      }
      const text = textOfContent(data?.message?.content).trim()
      if (text === '') continue
      const callId = typeof data?.message?.toolCallId === 'string' ? data.message.toolCallId : ''
      const rawName = callId === '' ? undefined : toolNames.get(callId)
      const name = typeof rawName === 'string' && rawName !== '' ? baseToolName(rawName) : ''
      if (INTERMEDIATE_TOOLS.has(name)) {
        const paths = filePathsIn(text)
        // 中间过程类整段跳过，只留路径：路径才是「上次那个文件在哪」的答案。
        if (paths.length === 0) continue
        lines.push({ text: `Tool(${name}) paths: ${paths.join(' ')}`, tool: true })
        continue
      }
      lines.push({ text: `Tool(${name === '' ? 'unknown' : name}): ${clipToolResult(text)}`, tool: true })
      continue
    }
    if (event.type === 'user/message') {
      const message = event.data as { role?: string; content?: unknown; source?: { kind?: string } }
      // 跳过注入类上下文消息（这些由 DSH/插件自动注入，重复提取成记忆只会造成噪音与冲突）：
      // - plugin：本插件记忆、openviking recall 等插件注入
      // - agent-instructions：AGENTS.md / 项目指令文件自动注入
      // - skill-catalog：DSH 技能目录（可用技能列表）自动注入
      // - skill-invocation：用户触发加载的技能内容
      // - compact-checkpoint：DSH 官方上下文压缩后的摘要。它是模型对早前对话的
      //   二次转述，既不是用户原话也不再是原始信息；当成 User 消息再提炼一遍，
      //   等于把摘要的摘要写进记忆库，二手转述会一轮轮稀释掉原始事实。
      const injectedKinds = ['plugin', 'agent-instructions', 'skill-catalog', 'skill-invocation', 'compact-checkpoint']
      if (typeof message.source?.kind === 'string' && (injectedKinds.includes(message.source.kind) || message.source.kind.startsWith('plugin:'))) continue
      lines.push({ text: `User: ${textOfContent(message.content)}`, tool: false })
    } else if (event.type === 'assistant/message') {
      const data = event.data as { message?: { content?: unknown } }
      lines.push({ text: `Assistant: ${textOfContent(data.message?.content)}`, tool: false })
    }
  }
  // 工具行预算：从最近往前装，装不下的（更早的）丢掉。一回合里最后的工具结果
  // 才是本轮真正的产出，前面的多半是查资料的过程。
  const kept = new Set<number>()
  let budget = TOOL_LINES_BUDGET
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.tool) continue
    if (line.text.length > budget) continue
    budget -= line.text.length
    kept.add(index)
  }
  return lines
    .filter((line, index) => !line.tool || kept.has(index))
    .map(line => line.text)
    .join('\n')
}

/** 把 ContentBlock[] 或字符串平铺为文本。 */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n').trim()
}
/** 语义去重阈值：候选与已有条目 n-gram 相似度 ≥ 该值视为重复，跳过入库（降 churn）。 */
const DUP_SIMILARITY_THRESHOLD = 0.75

/** 候选内容是否与某条已有记忆高度重复（提取去重）。 */
export function isDuplicateContent(content: string, existing: MemoryEntry[], threshold = DUP_SIMILARITY_THRESHOLD): boolean {
  const trimmed = content.trim()
  if (trimmed === '') return true
  for (const entry of existing) {
    // 软废弃条目不参与去重：已退出活跃生命周期，新提取的相似内容应可重新入库。
    if (entry.deprecated === true) continue
    if (entry.content.trim() === trimmed) return true
    if (semanticSimilarity(trimmed, entry.content) >= threshold) return true
  }
  return false
}
