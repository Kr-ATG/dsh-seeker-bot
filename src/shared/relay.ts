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
  if (brief.goal !== '') lines.push(`目标：${brief.goal}`)
  if (brief.done.length > 0) lines.push(`已完成：${brief.done.join('；')}`)
  if (brief.decisions.length > 0) lines.push(`关键决策/约束：${brief.decisions.join('；')}`)
  if (brief.pending.length > 0) lines.push(`未完成：${brief.pending.join('；')}`)
  if (brief.next.length > 0) lines.push(`下一步：${brief.next.join('；')}`)
  if (brief.files.length > 0) lines.push(`相关文件：${brief.files.join('、')}`)
  if (lines.length === 1) return ''
  lines.push('（这是上一段对话的整理结果；需要细节时可回查历史，不要把摘要当实时数据）')
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
}
