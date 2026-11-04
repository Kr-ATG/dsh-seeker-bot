/**
 * Personal Agent — 上下文接力触发判定（纯逻辑，可单测）。
 *
 * 这个文件只回答一个问题：**现在该不该提示用户「整理并开新会话」？**
 * 它不碰 React、不读 localStorage、不发请求，输入全是普通对象，方便
 * scripts/test-personal-relay-trigger.mjs 用 esbuild 直接打包跑断言。
 *
 * 三个触发档位（按优先级）：
 *  · hard  上下文占用已经越过硬阈值——先提示，避免下一轮直接超窗；
 *  · soft  越过软阈值，且最后一条用户消息看起来像换了话题——旧上下文帮不上忙；
 *  · idle  空闲超过设定小时数且占用仍不低——隔太久回来，先整理更省 token。
 *
 * 设置里的 mode='auto' 当前与 'prompt' 完全一致：只提示，不自动清空。
 * 真正清空必须由用户点确认卡（见 ChatPanel 的 handlePrepareRelay / clearConversation）。
 */
import type { RelayAuto } from './types.ts'

/** 上下文占用（宿主 GET /api/personal-agent/context 的 usage）。 */
export interface RelayContextUsage {
  usedTokens: number
  contextWindow: number
  /** 0–100 的占用百分比（宿主已算好）。 */
  percent: number
}

/** 命中后的提示条数据。 */
export interface RelayTrigger {
  kind: 'hard' | 'soft' | 'idle'
  /** 整数百分比（0–100），用于文案与关闭记忆的档位。 */
  percent: number
  title: string
  detail: string
}

/**
 * 判定用的最小消息形状。
 *
 * 真实 Message 的正文在 blocks 里；测试 / 其他调用方也可以直接给 text。
 * 两种形态都接住，避免纯逻辑模块反向依赖整份 Message 类型。
 */
export interface RelayMessageLike {
  role?: string
  text?: string
  blocks?: ReadonlyArray<{ type?: string; text?: string }>
}

/**
 * 默认设置：占用到 30% 且像换话题、60% 硬阈值、或空闲 8 小时——命中后**自动**
 * 生成接力摘要并切换模型上下文（聊天记录保留在对话流里，不删）。
 *
 * mode='off' 才关闭；'prompt' 是旧版本的「仅提示」，已统一升级为自动整理。
 */
export const DEFAULT_RELAY_AUTO: RelayAuto = {
  mode: 'auto',
  softRatio: 0.3,
  hardRatio: 0.6,
  idleHours: 8,
}

/** 比例钳制范围：低于 5% 等于永远弹，高于 95% 等于永远不弹，都没有意义。 */
export const RELAY_MIN_RATIO = 0.05
export const RELAY_MAX_RATIO = 0.95
/** 空闲小时数钳制范围。 */
export const RELAY_MIN_IDLE_HOURS = 1
export const RELAY_MAX_IDLE_HOURS = 72

/**
 * 容错归一化：localStorage 里可能是旧数据、手改数据或空值。
 *
 * mode 只有两档：'off'（关闭）与 'auto'（自动整理）。旧版本存过的 'prompt'
 * 与其他非法值一律升级为 'auto'——「整理并开新会话」是系统自动行为，不再需要
 * 用户手动确认；想完全关闭就选「关闭」。
 * 比例钳到 0.05–0.95，空闲小时钳到 1–72。数字字符串也接受，方便设置卡
 * 直接把 input 的值丢进来。
 */
export function normalizeRelayAuto(value: unknown): RelayAuto {
  const raw = value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  const mode = raw.mode === 'off' ? 'off' : 'auto'
  return {
    mode,
    softRatio: clampNumber(raw.softRatio, RELAY_MIN_RATIO, RELAY_MAX_RATIO, DEFAULT_RELAY_AUTO.softRatio),
    hardRatio: clampNumber(raw.hardRatio, RELAY_MIN_RATIO, RELAY_MAX_RATIO, DEFAULT_RELAY_AUTO.hardRatio),
    idleHours: clampNumber(raw.idleHours, RELAY_MIN_IDLE_HOURS, RELAY_MAX_IDLE_HOURS, DEFAULT_RELAY_AUTO.idleHours),
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * 延续词：出现任意一个就认为用户在顺着上一段说，不能判成「换话题」。
 *
 * 「这个 / 还有 / 然后」这类词没有主题信息，却是多轮对话里最常见的衔接词；
 * 宁可漏判一次换话题，也不要在用户说「继续刚才那个」时弹整理提示。
 */
const CONTINUATION_WORDS: readonly string[] = [
  '继续', '接着', '刚才', '上面', '之前', '还有', '然后', '这个', '这些',
  '刚刚', '上一', '前面', '上述', '同样', '还是', '补充', '再说', '基于',
]

/** 从一条最小消息里取正文：优先 text，其次拼接 text 块。 */
function textOfMessage(message: RelayMessageLike | undefined): string {
  if (message === undefined) return ''
  if (typeof message.text === 'string' && message.text.trim() !== '') return message.text
  const blocks = Array.isArray(message.blocks) ? message.blocks : []
  return blocks
    .map((block) => (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/** 归一化：小写 + 去掉空白 / 标点 / 符号，减少格式差异对 bigram 的干扰。 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 字符 bigram 集合。 */
function charBigrams(text: string): Set<string> {
  const normalized = normalizeText(text)
  const grams = new Set<string>()
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    grams.add(normalized.slice(index, index + 2))
  }
  return grams
}

/** Jaccard 相似度：交集 / 并集；任一为空数组视为 0。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const gram of a) {
    if (b.has(gram)) intersection += 1
  }
  return intersection / (a.size + b.size - intersection)
}

/**
 * 最后一条用户消息是不是在「换话题」。
 *
 * 判据：取最后一条用户消息（至少 6 个字，太短没有主题信号）与它之前最近
 * 6 条消息文本逐一算字符 bigram Jaccard 相似度，**最大值**低于 0.06 视为
 * 换话题。取最大值而不是拼接后的整体：只要其中一条旧消息与当前话题相关，
 * 就说明上下文仍然有用，不该催用户整理。
 *
 * 含延续词（继续 / 接着 / 刚才…）直接判 false，不做相似度计算。
 */
export function looksLikeTopicSwitch(messages: readonly RelayMessageLike[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return false
  const latest = textOfMessage(messages[lastUserIndex]).trim()
  if (latest.length < 6) return false
  if (CONTINUATION_WORDS.some((word) => latest.includes(word))) return false

  const previousTexts: string[] = []
  for (let index = lastUserIndex - 1; index >= 0 && previousTexts.length < 6; index -= 1) {
    const text = textOfMessage(messages[index]).trim()
    if (text !== '') previousTexts.push(text)
  }
  if (previousTexts.length === 0) return false

  const latestBigrams = charBigrams(latest)
  if (latestBigrams.size === 0) return false
  let maxSimilarity = 0
  for (const previous of previousTexts) {
    maxSimilarity = Math.max(maxSimilarity, jaccard(latestBigrams, charBigrams(previous)))
  }
  return maxSimilarity < 0.06
}

/** usage → 0–1 比例；宿主没给 percent 时用 usedTokens / contextWindow 兜底。 */
function usageRatio(usage: RelayContextUsage): number {
  if (typeof usage.percent === 'number' && Number.isFinite(usage.percent)) {
    return usage.percent / 100
  }
  const used = typeof usage.usedTokens === 'number' && Number.isFinite(usage.usedTokens) ? usage.usedTokens : 0
  const window = typeof usage.contextWindow === 'number' && Number.isFinite(usage.contextWindow) ? usage.contextWindow : 0
  return window > 0 ? used / window : 0
}

export interface EvaluateRelayTriggerInput {
  usage: RelayContextUsage | null | undefined
  /** 最后一条用户消息的时间戳（ms）；没有用户消息传 0。 */
  lastUserAt: number
  /** 当前时间（ms）；显式传入方便测试。 */
  now: number
  messages: readonly RelayMessageLike[]
  /** Bot 的 relayAuto 设置，缺失 / 坏值走 normalizeRelayAuto。 */
  settings?: unknown
}

/**
 * 计算当前该不该提示。命中返回提示条数据，否则 null。
 *
 * 优先级：hard > soft > idle。mode='off' 或拿不到 usage 时一律 null；
 * idle 额外要求占用 >= 20%（上下文很空的时候，只是隔得久没必要整理）。
 */
export function evaluateRelayTrigger(input: EvaluateRelayTriggerInput): RelayTrigger | null {
  const settings = normalizeRelayAuto(input.settings)
  if (settings.mode === 'off') return null
  if (input.usage === null || input.usage === undefined) return null
  const ratio = usageRatio(input.usage)
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  const percent = Math.round(ratio * 100)
  if (percent <= 0) return null

  if (ratio >= settings.hardRatio) {
    return {
      kind: 'hard',
      percent,
      title: '上下文快满了',
      detail: `已占用 ${String(percent)}%，现在整理并开新会话最稳`,
    }
  }
  if (ratio >= settings.softRatio && looksLikeTopicSwitch(input.messages)) {
    return {
      kind: 'soft',
      percent,
      title: '像是换了个话题',
      detail: `上下文已占用 ${String(percent)}%，开个新会话更清爽`,
    }
  }
  if (ratio >= 0.2 && input.lastUserAt > 0) {
    const idleMs = input.now - input.lastUserAt
    if (idleMs >= settings.idleHours * 3_600_000) {
      const hours = Math.max(1, Math.round(idleMs / 3_600_000))
      return {
        kind: 'idle',
        percent,
        title: `隔了 ${String(hours)} 小时没聊`,
        detail: `上下文已占用 ${String(percent)}%，整理一下再继续更省 token`,
      }
    }
  }
  return null
}

/**
 * 关闭记忆键：同一 kind + 百分比十位档位视为「同一条提示」。
 *
 * 关闭一次后，本次页面会话不再弹同一档（例如 62% 与 67% 都算 60 档），
 * 避免阈值附近每轮都冒出来打扰人。调用方再拼上 botId 区分不同会话。
 */
export function relayHintKey(trigger: Pick<RelayTrigger, 'kind' | 'percent'>): string {
  const bucket = Math.min(10, Math.max(0, Math.floor(trigger.percent / 10)))
  return `${trigger.kind}:${String(bucket)}`
}
