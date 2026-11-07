/**
 * Personal Agent — 「接力摘要」的共享契约。
 *
 * ## 它是什么
 *
 * 一段对话结束（用户手动「整理并开新会话」，将来也可能自动触发）时，把这段
 * 对话整理成一张**结构化交接单**：目标、已完成、关键决策与约束、未完成、
 * 下一步、相关文件。新会话每轮把它注入 context，Bot 就能接着干，而不是从零问
 * 「我们刚才说到哪了」。
 *
 * ## 为什么不是「压缩成 6 句话」
 *
 * 句数是错的度量：6 句里可能三句是寒暄，也可能漏掉第 7 句里的路径/数字。
 * 摘要必须按**字段**写——数字、路径、命名、接口原样保留，下一轮才能直接执行。
 *
 * ## 为什么放 shared
 *
 * 纯逻辑（清洗模型 JSON / 构建注入文本 / 规则兜底）前后端都要用：
 *  · 宿主生成后落盘、注入；
 *  · 前端在「清空对话」确认卡里预览、展示。
 * 一份实现，避免两边字段漂移。
 */

/** 接力摘要：一段对话的「交接单」。 */
export interface RelayBrief {
  /** 这一段对话要完成的目标（一句话，<=120 字）。 */
  goal: string
  /** 已经完成的事（1–8 条，每条 <=120 字）。 */
  done: string[]
  /** 已确认的决策与约束（数字、路径、命名、接口；0–8 条）。 */
  decisions: string[]
  /** 未完成 / 等用户处理（0–8 条）。 */
  pending: string[]
  /** 下一步建议（0–8 条）。 */
  next: string[]
  /** 相关文件 / 命令 / 链接（0–12 条）。 */
  files: string[]
  /** 生成 / 更新时间（毫秒）。 */
  updatedAt: number
  /** 来源统计（宿主生成时填）。 */
  source?: {
    messages: number
    from?: number
    to?: number
  }
  /** 用户是否手动编辑过。 */
  edited?: boolean
}

/** 单条字段的最大条数。 */
export const RELAY_MAX_ITEMS = 12

/** 单条字段的最大字数。 */
export const RELAY_ITEM_MAX_CHARS = 160

/** goal 的最大字数。 */
export const RELAY_GOAL_MAX_CHARS = 200

/** 前端最多送多少条消息去生成（再长既费 token 也没必要）。 */
export const RELAY_MESSAGES_MAX = 40

/** 单条消息送进 prompt 时的最大字数。 */
export const RELAY_MESSAGE_MAX_CHARS = 1500

/** 截断 + 压缩空白。 */
function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 清洗数组字段：只留非空字符串、去重、逐条截断、限制条数。 */
function clipList(value: unknown, maxItems = RELAY_MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const text = clip(item, RELAY_ITEM_MAX_CHARS)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

/* ─────────────── 「下一步」与「已完成」的重合判定 ─────────────── */

/**
 * 归一化：小写 + 去空白 / 标点 / 符号。
 *
 * 只用于重复判定，不影响展示文本。模型写「已核查 Mimi 的 README。」和
 * 「继续核查 Mimi 的 README」，归一化后才看得出是同一个动作。
 */
function foldStep(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 字符 bigram 集合。 */
function stepBigrams(text: string): Set<string> {
  const grams = new Set<string>()
  const folded = foldStep(text)
  for (let index = 0; index + 1 < folded.length; index += 1) grams.add(folded.slice(index, index + 2))
  return grams
}

/** 两个 bigram 集合的交集大小。 */
function stepShared(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const gram of left) {
    if (right.has(gram)) intersection += 1
  }
  return intersection
}

/** Jaccard 相似度；任一为空集合视为 0。 */
function stepSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  const intersection = stepShared(left, right)
  return intersection / (left.size + right.size - intersection)
}

/** 较短一方的 bigram 被覆盖的比例。 */
function stepOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  return stepShared(left, right) / Math.min(left.size, right.size)
}

/**
 * 两条文本里长度 >= minLen 的「极大公共子串」个数。
 *
 * 为什么除了整句相似度还要数这个：中文长句里同一件事经常换个动词重述——
 * 「已把持续盯梢任务派给子 Bot 小秘」与「子 Bot 小秘执行基线检查并持续盯梢」
 * 的 bigram 相似度被语序和虚词稀释到 0.3 以下，但两句话共享「子 Bot 小秘」
 * 「持续盯梢」两个实义片段，足以判定是同一个动作。
 *
 * 计数位置是每个极大公共子串刚达到 minLen 的那一格：更长的匹配不会再计一次，
 * 并且按片段内容去重——「Mimi」在一句里出现三次，也只能算一个实义片段，
 * 否则一个反复出现的专有名词就能把两条无关的句子判成同一件事。
 */
function commonChunks(leftText: string, rightText: string, minLen: number): Set<string> {
  const left = foldStep(leftText)
  const right = foldStep(rightText)
  const chunks = new Set<string>()
  if (left.length < minLen || right.length < minLen) return chunks
  let previous = new Array<number>(right.length + 1).fill(0)
  let current = new Array<number>(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i += 1) {
    current.fill(0)
    const char = left[i - 1]
    for (let j = 1; j <= right.length; j += 1) {
      if (char !== right[j - 1]) continue
      const length = previous[j - 1] + 1
      current[j] = length
      if (length === minLen) chunks.add(left.slice(i - minLen, i))
    }
    const swap = previous
    previous = current
    current = swap
  }
  return chunks
}

/** 整句 bigram Jaccard 达到多少算同一个动作（高置信，长句之间的重合）。 */
export const RELAY_REDO_SIMILARITY = 0.55

/**
 * 短句覆盖率阈值：交集 / 较短一方的 bigram 数。
 *
 * 「执行基线检查」与「已完成基线检查」的 Jaccard 只有 0.375，但短句的
 * 5 个 bigram 里有 3 个被覆盖——这是「换个动词重述同一个动作」的典型形态，
 * Jaccard 会被两边长度差稀释，覆盖率不会。定在 0.6 可以命中它，又不会把
 * 「继续检查新仓库」这类真正增量的动作（覆盖率 0.57）误删。
 */
export const RELAY_REDO_OVERLAP = 0.6

/** 判定同一动作所需的实义公共片段长度（字符）与最小条数。 */
export const RELAY_REDO_CHUNK_LEN = 4
export const RELAY_REDO_CHUNK_COUNT = 2

/**
 * 一条「下一步」是不是已经做过的事。
 *
 * 这是**确定性兜底**：模型经常把「已把任务派给子 Bot」写进 done，又顺手把
 * 「子 Bot 执行基线检查」写进 next——新会话照着 next 做，用户看到的就是
 * 「已经做完的事又做了一遍」。提示词约束能减少发生率，但模型不可靠，这里
 * 再用字面证据兜一层。
 *
 * 判定顺序（便宜的先跑）：完全相同 → 包含关系 → 整句相似度 → 实义片段。
 * 只做保守判定：宁可漏判（模型还能靠注入块的硬约束纠正），也不要把真正
 * 没做的下一步误删掉。
 */
export function isAlreadyDoneStep(step: string, done: readonly string[]): boolean {
  const foldedStep = foldStep(step)
  // 太短的条目（「检查」「继续」）没有动作信息，判定只会制造误伤
  if (foldedStep.length < 4) return false
  const stepGrams = stepBigrams(step)
  for (const item of done) {
    const foldedItem = foldStep(item)
    if (foldedItem === '') continue
    if (foldedStep === foldedItem) return true
    if (foldedStep.length >= 6 && foldedItem.length >= 6
      && (foldedStep.includes(foldedItem) || foldedItem.includes(foldedStep))) return true
    const itemGrams = stepBigrams(item)
    // 预筛：共享 bigram 太少就不可能共享两个实义片段，跳过 O(n·m) 的子串 DP
    const shared = stepShared(stepGrams, itemGrams)
    if (shared < 3) continue
    if (stepSimilarity(stepGrams, itemGrams) >= RELAY_REDO_SIMILARITY) return true
    // 换动词重述：短句大部分 bigram 都被覆盖，但两边长度差把 Jaccard 拉低了
    if (Math.min(foldedStep.length, foldedItem.length) >= 6
      && stepOverlap(stepGrams, itemGrams) >= RELAY_REDO_OVERLAP) return true
    if (commonChunks(step, item, RELAY_REDO_CHUNK_LEN).size >= RELAY_REDO_CHUNK_COUNT) return true
  }
  return false
}

/**
 * 把「下一步」里已经做过的事剔掉。
 *
 * 只清理 next：done 是既成事实不能删，pending 是等外部事件（「等子 Bot 回报」
 * 这类本来就是合法的下一步形态），动它们都会丢信息。
 */
export function reconcileRelayBrief(brief: RelayBrief): RelayBrief {
  if (brief.done.length === 0 || brief.next.length === 0) return brief
  const next = brief.next.filter((step) => !isAlreadyDoneStep(step, brief.done))
  if (next.length === brief.next.length) return brief
  return { ...brief, next }
}

/**
 * 把模型返回的 JSON 洗成合法 RelayBrief。
 *
 * 模型经常漏字段、把数组写成字符串、或者多包一层。这里全部容错：
 *  · goal 为空且所有列表为空 → 返回 null（这份摘要没有价值，调用方走兜底）；
 *  · 任何字段类型不对 → 当成空数组，不抛错。
 */
export function normalizeRelayBrief(raw: unknown, now = Date.now()): RelayBrief | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const brief: RelayBrief = {
    goal: clip(record.goal, RELAY_GOAL_MAX_CHARS),
    done: clipList(record.done),
    decisions: clipList(record.decisions),
    pending: clipList(record.pending),
    next: clipList(record.next),
    files: clipList(record.files),
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.round(record.updatedAt)
      : now,
  }
  if (
    brief.goal === ''
    && brief.done.length === 0
    && brief.decisions.length === 0
    && brief.pending.length === 0
    && brief.next.length === 0
    && brief.files.length === 0
  ) {
    return null
  }
  return brief
}

/**
 * 构建注入文本（每轮进 context）。
 *
 * 格式刻意紧凑：只列有内容的字段，空字段整行省略——它每轮都注入，不能有废话。
 * 返回空串表示没有可注入的摘要，调用方不应注入空块。
 */
export function buildRelayBlock(brief: RelayBrief | null | undefined): string {
  if (brief === null || brief === undefined) return ''
  const lines: string[] = ['【接力摘要 · 上一段对话】']
  /*
   * 有未完成事项 = 同一项工作还在进行。这句必须放在字段最前面：自动整理经常
   * 发生在长期任务中途（已派给子 Bot、正在等外部动静），新会话读到一堆字段时
   * 最容易把它当成「一个新任务」，于是把已经做完的基线检查又跑一遍。
   */
  if (brief.pending.length > 0) lines.push('（同一项工作的延续，不是新任务：从下面「已完成」处接着做）')
  if (brief.goal !== '') lines.push(`目标：${brief.goal}`)
  if (brief.done.length > 0) lines.push(`已完成：${brief.done.join('；')}`)
  if (brief.decisions.length > 0) lines.push(`关键决策/约束：${brief.decisions.join('；')}`)
  if (brief.pending.length > 0) lines.push(`未完成：${brief.pending.join('；')}`)
  if (brief.next.length > 0) lines.push(`下一步：${brief.next.join('；')}`)
  if (brief.files.length > 0) lines.push(`相关文件：${brief.files.join('、')}`)
  if (lines.length === 1) return ''
  /*
   * 尾句是硬约束，不是客套说明：
   *  · 「不要重做 / 不要重新验证 / 不要重复汇报」——用户反馈的原话就是
   *    「已经完成的任务没必要再来一遍」；
   *  · 「只做增量对比」——盯梢这类持续任务本来就该继续，但要对比的是新变化，
   *    不是重建基线；
   *  · next 与 done 冲突时以 done 为准——reconcileRelayBrief 已删掉明显重复的
   *    条目，模型偶尔还会从 pending 或历史里补出来，这里再给一次裁决规则。
   */
  lines.push('（这是上一段对话的整理结果，不是实时数据。上面「已完成」里的事都已经发生：不要重做、不要重新验证、不要向用户重复汇报；对同一对象只做增量对比，不要重建基线。若「下一步」和「已完成」看起来是同一件事，以「已完成」为准——先确认有没有新变化，再决定要不要动手。）')
  return lines.join('\n')
}

/** 生成摘要的输入消息（前端从消息流里抽出来的纯文本）。 */
export interface RelayMessage {
  role: 'user' | 'bot'
  text: string
  /** 消息时间（毫秒，可选）。 */
  at?: number
}

/**
 * 规则兜底：模型不可用时，用最近消息拼一份最低限度的接力摘要。
 *
 * 宁可给一份「粗糙但真实」的交接单，也不要让用户点了整理却什么都没留下。
 * 只做能确定性做到的事：目标取最后一条用户消息，已完成取最近几条 Bot 回复
 * 的开头。不猜测、不编造。
 */
export function fallbackRelayBrief(messages: readonly RelayMessage[], now = Date.now()): RelayBrief | null {
  const cleaned = messages
    .map((message) => ({
      role: message.role,
      text: clip(message.text, RELAY_MESSAGE_MAX_CHARS),
      at: typeof message.at === 'number' && Number.isFinite(message.at) ? message.at : undefined,
    }))
    .filter((message) => message.text !== '')
  if (cleaned.length === 0) return null
  const lastUser = [...cleaned].reverse().find((message) => message.role === 'user')
  const botTexts = [...cleaned].reverse().filter((message) => message.role === 'bot').slice(0, 3)
  const brief: RelayBrief = {
    goal: lastUser === undefined ? '' : clip(`继续：${lastUser.text}`, RELAY_GOAL_MAX_CHARS),
    done: botTexts.length > 0 ? botTexts.map((message) => clip(message.text, 100)) : [],
    decisions: [],
    pending: [],
    next: [],
    files: [],
    updatedAt: now,
    source: {
      messages: cleaned.length,
      ...(cleaned[0]?.at !== undefined ? { from: cleaned[0].at } : {}),
      ...(cleaned[cleaned.length - 1]?.at !== undefined ? { to: cleaned[cleaned.length - 1]?.at } : {}),
    },
  }
  return normalizeRelayBrief(brief, now)
}

/** 测试用：暴露内部实现。 */
export const relayContractTest = {
  clip,
  clipList,
  normalizeRelayBrief,
  buildRelayBlock,
  fallbackRelayBrief,
  isAlreadyDoneStep,
  reconcileRelayBrief,
}
