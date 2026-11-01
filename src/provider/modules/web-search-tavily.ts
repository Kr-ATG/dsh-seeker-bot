/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by Tavily Search
 * (`POST {baseURL}/search`)——`anysearch-auto` 链的第二环。
 *
 * 为什么需要它：AnySearch 的免费档打满后不会自己回来，而 `ctx.web` 的 seam 不会
 * 降级（宿主 `WebRuntime.search()` 只选中一家、失败即失败）。本包要自动切换，就得
 * 自己拥有至少一个后备实现。
 *
 * 契约来源（2026-11-01 抓的官方 OpenAPI）：
 *   - 认证只有 bearer：`Authorization: Bearer tvly-…`，没有匿名档，所以没有 key
 *     时 `available()` 直接 false，让链跳过这一环而不是白打一次。
 *   - `max_results` 合法区间 **0–20**，越界是 400（400 属于「换后端也必败」，
 *     所以必须在这里钳制，不能把 `dsh-tool-web` 传下来的大 bound 原样发出去）。
 *   - `search_depth` 计费：basic/fast/ultra-fast 1 credit，advanced 2 credit；
 *     默认 basic，别默认 advanced 白烧一倍额度。
 *   - 额度耗尽用的是 **432 / 433**（不是 402/429），429 是速率、带 `Retry-After`；
 *     错误体形如 `{"detail":{"error":"…"}}`。分类见 ./web-search-failure.ts。
 *   - `include_answer` 返回的 `answer` 正好是 seam 里 `WebSearchResult.content`
 *     想要的「provider-generated answer text」，所以打开。
 *   - `published_date` 是 RFC-1123（`Tue, 11 Mar 2025 17:00:00 GMT`），而 seam 的
 *     `publishedAt` 要求 ISO-8601，必须转换，否则就是把契约里的类型写脏。
 * @module dsh-provider-hub/web-search-tavily
 */

import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '../vendor/credential-ref.ts'
import { WebError } from '../vendor/error.ts'
import {
  ClassifiedWebError,
  WEB_UNAVAILABLE,
  classifyWebFailure,
  parseRetryAfter,
} from './web-search-failure.ts'
import { abortable, isAbortError, searchAborted, throwIfSearchAborted } from './web-search-abort.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily search endpoint base; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** 取消消息里的 provider 名（保持各环消息可辨识）。 */
const PROVIDER_NAME = 'Tavily'

/** Tavily 接受的 `max_results` 上界；越界请求会被判 400。 */
const TAVILY_MAX_RESULTS_CEILING = 20

/** Tavily 接受的 `max_results` 下界（1 条起步；0 会返回空结果集，没有意义）。 */
const TAVILY_MAX_RESULTS_FLOOR = 1

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-seeker-bot-web-search-tavily/0.1.0'

/** Latency/relevance 档位，同时决定扣几个 credit。 */
export type TavilySearchDepth = 'basic' | 'advanced' | 'fast' | 'ultra-fast'

/** Resolved provider options (the chain's registration supplies defaults). */
export interface TavilySearchProviderOptions {
  /** Literal Tavily API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Tavily API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  maxResults?: number
  /** 检索深度；默认 `basic`（1 credit）。`advanced` 收 2 credits。 */
  searchDepth?: TavilySearchDepth
  /** 是否带上 Tavily 生成的短答案（映射到 `content`）。默认 true。 */
  includeAnswer?: boolean
  /** 语言/地区偏好（Tavily 的 `language`，ISO 639-1 或英文名）。 */
  language?: string
}

/** One Tavily result entry. */
export interface TavilyResultItem {
  title?: string
  url?: string
  /** 该源的正文摘录（500–800 字符），比 snippet 更饱满。 */
  content?: string
  score?: number
  raw_content?: string | null
  /** RFC-1123  publication/updated 时间；`include_published_date` 或 `topic: news` 时才有。 */
  published_date?: string | null
}

/** The parsed Tavily response body. */
export interface TavilyResponse {
  query?: string
  /** LLM 生成的短答案（`include_answer` 打开时）。 */
  answer?: string | null
  results?: TavilyResultItem[]
  images?: unknown[]
  response_time?: number
  usage?: { credits?: number }
  request_id?: string
}

/** Tavily 的 `{"detail":{"error":"…"}}` 错误体。 */
export interface TavilyErrorBody {
  detail?: { error?: string } | string
}

/**
 * 把 Tavily 的 RFC-1123 日期转成 seam 要求的 ISO-8601。解析不动就整个字段省略——
 * seam 的类型注释写明 `publishedAt` 是 "provider-supplied ISO-8601 string"，
 * 原样塞进 `Tue, 11 Mar 2025 …` 等于让 seam 说谎。
 */
export function toIsoPublishedAt(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value.length === 0) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

/** Clamp a caller's result bound into the range Tavily accepts (0–20). */
export function clampTavilyMaxResults(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) return undefined
  if (value > TAVILY_MAX_RESULTS_CEILING) return TAVILY_MAX_RESULTS_CEILING
  return value < TAVILY_MAX_RESULTS_FLOOR ? TAVILY_MAX_RESULTS_FLOOR : value
}

/**
 * Map a Tavily response to a normalized search result. Entries without a URL are
 * dropped; `content` carries Tavily's generated answer when requested. The web
 * seam owns the final `maxResults` truncation, so this reports `truncated: false`.
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result.
 */
export function mapTavilyResponse(response: TavilyResponse): WebSearchResult {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const result of response.results ?? []) {
    const url = result.url
    if (url === undefined || url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const publishedAt = toIsoPublishedAt(result.published_date)
    sources.push({
      url,
      ...((result.title !== undefined && result.title.length > 0) ? { title: result.title } : {}),
      ...((result.content !== undefined && result.content.length > 0) ? { snippet: result.content } : {}),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  const answer = response.answer
  return {
    ...((answer !== undefined && answer !== null && answer.length > 0) ? { content: answer } : {}),
    sources,
    truncated: false,
  }
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_UNAVAILABLE`. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  private readonly resolveOptions: () => TavilySearchProviderOptions

  /**
   * @param resolveOptions - options for the NEXT operation, snapshotted once at
   * each operation's entry so one search never mixes two settings revisions.
   * 显式赋值而非 parameter property：Node strip-only 模式跑不了后者，单测就得先打包。
   */
  constructor(resolveOptions: () => TavilySearchProviderOptions) {
    this.resolveOptions = resolveOptions
  }

  available(): boolean {
    const options = this.resolveOptions()
    // Tavily 没有匿名档：没有可发的凭据就不算可用，链会跳过这一环而不是白打一次。
    return URL.canParse(options.baseURL)
      && ((options.apiKey !== undefined && options.apiKey.length > 0) || options.resolveApiKey !== undefined)
  }

  /**
   * 凭据预检：`available()` 是同步的、判不出「凭据库里到底有没有这个 key」，只看
   * 有没有解析器；宿主正是靠 `ready()` 决定这次模型请求要不要挂 `web_search` 工具。
   * 降级链也会先用它筛掉没配 key 的环，省掉一次必败往返。不发网络请求。
   * @returns 下一次搜索能不能带上 Tavily key。
   */
  async ready(): Promise<boolean> {
    const options = this.resolveOptions()
    if (options.apiKey !== undefined && options.apiKey.length > 0) return true
    if (options.resolveApiKey === undefined) return false
    try {
      const resolved = await options.resolveApiKey()
      return resolved !== undefined && resolved.length > 0
    } catch {
      // 读不到凭据按没配处理：与宿主 deepseek provider 的 searchConfigured 同一取向。
      return false
    }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(PROVIDER_NAME, signal)
    const maxResults = clampTavilyMaxResults(request.maxResults ?? options.maxResults)
    const searchDepth = options.searchDepth ?? 'basic'
    const includeAnswer = options.includeAnswer ?? true

    let response: Response
    try {
      response = await fetch(`${options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
          'authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: request.query,
          ...(maxResults !== undefined ? { max_results: maxResults } : {}),
          search_depth: searchDepth,
          include_answer: includeAnswer,
          ...(options.language !== undefined && options.language.length > 0 ? { language: options.language } : {}),
        }),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(PROVIDER_NAME, signal, error)
      throw new ClassifiedWebError(
        `Tavily search request failed: ${String(error)}`,
        WEB_UNAVAILABLE,
        undefined,
        { cause: error },
      )
    }

    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'))

    if (!response.ok) {
      const status = response.status
      const prefix = `Tavily API error (HTTP ${status})`
      let message = prefix
      try {
        const parsed = await response.json() as TavilyErrorBody
        const detail = typeof parsed.detail === 'string' ? parsed.detail : parsed.detail?.error
        if (detail !== undefined && detail.length > 0) message = `${prefix}: ${detail}`
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(PROVIDER_NAME, signal, error)
        // 错误体读不动不影响判定：状态码本身已经足够分类。
      }
      throw new ClassifiedWebError(
        message,
        classifyWebFailure({
          status,
          message,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        }),
        retryAfterSeconds,
      )
    }

    try {
      return mapTavilyResponse(await response.json() as TavilyResponse)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(PROVIDER_NAME, signal, error)
      throw new ClassifiedWebError(
        `Tavily returned an unprocessable response body: ${String(error)}`,
        WEB_UNAVAILABLE,
        undefined,
        { cause: error },
      )
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   */
  private async apiKey(options: TavilySearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(PROVIDER_NAME, signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(PROVIDER_NAME, options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(PROVIDER_NAME, signal, error)
      throw new WebError(
        `Tavily search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    throw new WebError(
      `Tavily search has no API key for "${options.apiKeyEnv ?? 'TAVILY_API_KEY'}"; store it through the credentials service or set a literal "apiKey" in the web-search-auto config.`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}
