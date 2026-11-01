/**
 * 网页搜索失败的统一分类叶（`anysearch-auto` 链的唯一路由依据）。
 *
 * 为什么要这一层：`ctx.web` 的 seam 只会选中一个 provider，一次失败就是一次失败
 *（见宿主 `WebRuntime.search()`：`selectSearchProvider().search()`，没有重试也没有
 * 降级）。想做「额度没了自动切下一家」，只能由插件自己判断「这次失败值不值得换一家
 * 再打一遍」。判断依据必须集中在一处，否则每加一个后端就多一套 if。
 *
 * 分类结果写进 `WebError.code`（宿主类型注释明确 `code` 是 machine-routable 的
 * open string，「Consumers must tolerate provider-specific codes」），链只读 code，
 * 不再解析各家的报文形状。
 *
 * 实测依据（2026-11-01，本机直连）：
 *   AnySearch  401 `{"code":-1,"message":"Invalid API key.","error_code":"invalid_api_key"}`
 *   AnySearch  400 `{"code":-1,"message":"Query is required."}`（缺 query，换后端也必败）
 *   AnySearch  匿名限流头是静态值（连打 14 次 `X-Ratelimit-Remaining` 恒为 8），
 *              所以「还剩多少额度」不可预判，只能由真失败驱动。
 *   Tavily     432 Key/Plan limit、433 PayGo limit、429 速率限制（带 Retry-After）、
 *              401 无效 key、434 flex tier capacity、`{"detail":{"error":"..."}}`
 * @module dsh-provider-hub/web-search-failure
 */

import { WebError } from '../vendor/error.ts'

/** 后端拒绝服务且短期内不会自行恢复：额度/套餐上限用尽。 */
export const WEB_QUOTA_EXCEEDED = 'WEB_QUOTA_EXCEEDED'
/** 速率过快：稍后重试即可，冷却以秒计。 */
export const WEB_RATE_LIMITED = 'WEB_RATE_LIMITED'
/** 凭据被拒：切走并冷却，等用户换 key。 */
export const WEB_AUTH_FAILED = 'WEB_AUTH_FAILED'
/** 上游自身故障（5xx/网络/容量）：可以换一家试试，但不冷却。 */
export const WEB_UNAVAILABLE = 'WEB_UNAVAILABLE'
/**
 * 这一环压根没有凭据可发（各家 provider 解析不到 `apiKey` 时都抛这个码）。
 *
 * 为什么必须算「可切」：`available()` 是同步的、且不得读凭据（宿主契约写明它
 * "must not make network calls"，而凭据库是异步的），所以「有解析器」的环一律先算
 * 可用；真没配 key 的那一刻只有抛这个码才知道。它若不切，整条链就停在第一个没配
 * key 的后备环上——用户要的「额度没了自动切」当场退化成「换家报错」。
 */
export const WEB_PROVIDER_CREDENTIAL_MISSING = 'WEB_PROVIDER_CREDENTIAL_MISSING'

/** 链认识的、值得换后端重试一次的失败 code（`WEB_ABORTED` 与未知 code 都不在此列）。 */
const FALLBACKABLE_CODES: readonly string[] = [
  WEB_QUOTA_EXCEEDED,
  WEB_RATE_LIMITED,
  WEB_AUTH_FAILED,
  WEB_UNAVAILABLE,
  WEB_PROVIDER_CREDENTIAL_MISSING,
]

/**
 * 带分类结果的 `WebError`：链只认 `code`，但冷却时长需要后端给的 `Retry-After`，
 * 于是把它挂在错误实例上一起传下去，而不是塞进 message 让链再解析文本。
 *
 * 不改 `../vendor/error.ts`：那个文件是宿主叶子的逐字副本（头部注释写明了 vendor
 * 理由），加字段会让它不再是副本。
 */
export class ClassifiedWebError extends WebError {
  /** `Retry-After` 头（秒）；后端没给就没有。 */
  readonly retryAfterSeconds?: number

  /**
   * @param message - 面向人（和模型）的失败说明。
   * @param code - {@link classifyWebFailure} 归出的稳定分类。
   * @param retryAfterSeconds - 后端建议的重试等待秒数。
   * @param options - 保留原始 cause 用。
   */
  constructor(
    message: string,
    code: string,
    retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, code, options)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** 一次失败的可读线索，由 provider 从自己的报文里抽出来。 */
export interface WebFailureSignal {
  /** HTTP 状态码；纯本地失败（DNS/连接）没有。 */
  status?: number
  /** 后端自带的机器可读错误码（AnySearch 的 `error_code`、Tavily 的 detail 前缀等）。 */
  errorCode?: string
  /** 后端或本地生成的可读消息，用于关键词兜底判定。 */
  message?: string
  /** `Retry-After` 头（秒）；链据此决定 `WEB_RATE_LIMITED` 的冷却时长。 */
  retryAfterSeconds?: number
}

/** 命中额度类语义的关键词（英文报文 + 中文报文都要兜住）。 */
const QUOTA_PATTERNS = [
  'quota',
  'credit',
  'out of funds',
  'insufficient',
  'payment required',
  'billing',
  'usage limit',
  'plan limit',
  'pay-as-you-go',
  'paygo',
  'exceeds your',
  '额度',
  '余额',
  '欠费',
  '套餐',
]

/** 命中凭据类语义的关键词。 */
const AUTH_PATTERNS = [
  'invalid api key',
  'invalid_api_key',
  'missing or invalid api key',
  'unauthorized',
  'forbidden',
  'authentication',
  'api key',
]

/** 命中速率类语义的关键词。 */
const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'excessive requests',
  'capacity exceeded',
  'flex tier',
]

/** 命中「这次查询本身不对」的关键词：换后端重打只是白烧一次额度。 */
const FATAL_PATTERNS = [
  'query is required',
  'is invalid',
  'must be',
  'not supported for',
  'unsupported',
  'validation error',
  'input should be',
]

function hasAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

/**
 * 把一次后端失败归到一个可路由的 code。
 *
 * 判定顺序：状态码优先（最可信），报文关键词兜底，最后才是「未知」。
 * 未知一律返回 `WEB_PROVIDER_ERROR` 由调用方原样抛出——链看见不认识的 code
 * 就不切换，宁可如实报错，也不把用户的拼写错误变成三次跨网请求。
 * @param signal - 该后端这次失败的可读线索。
 * @returns 写进 `WebError.code` 的稳定分类。
 */
export function classifyWebFailure(signal: WebFailureSignal): string {
  const status = signal.status
  const errorCode = (signal.errorCode ?? '').toLowerCase()
  const message = (signal.message ?? '').toLowerCase()
  const text = `${errorCode} ${message}`

  // 1) 状态码：明确的额度码先落地，Tavily 用 432/433 而不是 402 表达「用完额度」。
  if (status !== undefined) {
    if (status === 402 || status === 432 || status === 433) return WEB_QUOTA_EXCEEDED
    if (status === 429 || status === 434) return WEB_RATE_LIMITED
    if (status === 401 || status === 403) return WEB_AUTH_FAILED
    // 客户端错误且报文没有额度/凭据线索时，视为查询本身有问题，不切。
    if (status >= 400 && status < 500) {
      if (hasAny(text, QUOTA_PATTERNS)) return WEB_QUOTA_EXCEEDED
      if (hasAny(text, RATE_LIMIT_PATTERNS)) return WEB_RATE_LIMITED
      if (hasAny(text, FATAL_PATTERNS)) return 'WEB_PROVIDER_ERROR'
      // 4xx 里剩下的（404/405/415 这类端点配错）换后端也不会成功，如实报错。
      if (!hasAny(text, AUTH_PATTERNS)) return 'WEB_PROVIDER_ERROR'
      return WEB_AUTH_FAILED
    }
    if (status >= 500) return WEB_UNAVAILABLE
  }

  // 2) 没有状态码（fetch 抛异常、业务 code 非零但 HTTP 200）：只看报文关键词。
  if (hasAny(text, QUOTA_PATTERNS)) return WEB_QUOTA_EXCEEDED
  if (hasAny(text, RATE_LIMIT_PATTERNS)) return WEB_RATE_LIMITED
  if (hasAny(text, AUTH_PATTERNS)) return WEB_AUTH_FAILED
  if (hasAny(text, FATAL_PATTERNS)) return 'WEB_PROVIDER_ERROR'

  // 3) 兜底：拿不到状态码的失败按上游不可用处理（网络抖动是这类最多的一种）。
  return status === undefined ? WEB_UNAVAILABLE : 'WEB_PROVIDER_ERROR'
}

/**
 * 该 code 是否值得换下一个后端再打一次。
 * @param code - `WebError.code`。
 * @returns true 表示链可以继续降级。
 */
export function isFallbackableCode(code: string): boolean {
  return FALLBACKABLE_CODES.includes(code)
}

/**
 * 该分类下这一环应冷却多久（毫秒）。设计意图：
 *   - 额度：短期内不会自己回来，冷却要长（默认 30 分钟），否则每次搜索都先撞一下；
 *   - 凭据：用户可能中途换 key，10 分钟；
 *   - 速率：优先听 `Retry-After`，没有就 60 秒；
 *   - 上游故障：不冷却，下一次照常先试它（它可能已经恢复，且它结果质量最好）。
 * @param code - `WebError.code` 分类。
 * @param retryAfterSeconds - 后端给的 `Retry-After`（秒）。
 * @param quotaCooldownMs - 额度类冷却时长（可被链配置覆盖）。
 * @returns 冷却毫秒数；0 表示不冷却。
 */
export function cooldownOf(code: string, retryAfterSeconds: number | undefined, quotaCooldownMs: number): number {
  switch (code) {
    case WEB_QUOTA_EXCEEDED:
      return quotaCooldownMs
    case WEB_AUTH_FAILED:
      return 10 * 60 * 1000
    case WEB_RATE_LIMITED: {
      const seconds = retryAfterSeconds
      if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
        return Math.min(Math.floor(seconds), 15 * 60) * 1000
      }
      return 60 * 1000
    }
    default:
      return 0
  }
}

/**
 * 从 `Retry-After` 头解析秒数。只支持 delta-seconds 形式：HTTP-date 形式在实际
 * 后端里几乎不出现，解析它带来的错误比收益大。
 * @param header - 原始头值。
 * @returns 秒数；无法解析时 undefined。
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (header === undefined || header === null) return undefined
  const trimmed = header.trim()
  if (trimmed.length === 0) return undefined
  const seconds = Number(trimmed)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
