/**
 * `AnySearchSearchProvider`: a `WebSearchProvider` backed by the AnySearch
 * unified search API (`POST /v1/search`). It maps each result's
 * `title`/`url`/`snippet` into the normalized source shape and omits `content`
 * because AnySearch returns per-result body content, not a generated answer.
 *
 * 原为独立插件 dsh-web-search-anysearch 的 host 模块（再上游是 statem-li/dsh-webui
 * 的 `src/provider.ts`），随「供应商中心」融合并入本包；迁移只改了叶子模块的相对
 * 路径（`./vendor/` → `../vendor/`），provider id / UA / 响应映射逐字未动。
 *
 * `WebError` 来自 `../vendor/error.ts` 而非 `@deepseek-ai/dsh-web`：装在 profile
 * node_modules 里的插件解析不到 DSH 源码包（见 vendor 头注释）。
 * @module dsh-provider-hub/web-search-provider
 */

import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '../vendor/credential-ref.ts'
import { WebError } from '../vendor/error.ts'
import { ClassifiedWebError, WEB_UNAVAILABLE, classifyWebFailure, parseRetryAfter } from './web-search-failure.ts'
import { abortable as sharedAbortable, searchAborted as sharedSearchAborted, throwIfSearchAborted as sharedThrowIfAborted, isAbortError } from './web-search-abort.ts'

/** 取消消息里的 provider 名（保持各环消息可辨识）。 */
const PROVIDER_NAME = 'AnySearch'

/** Stable id this provider registers under. */
export const ANYSEARCH_PROVIDER_ID = 'anysearch'

/** Default AnySearch search endpoint base; `/v1/search` is the operation. */
export const ANYSEARCH_DEFAULT_BASE_URL = 'https://api.anysearch.com'

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-web-search-anysearch/0.1.0'

/** Resolved provider options (the plugin's `apply` supplies defaults). */
export interface AnySearchSearchProviderOptions {
  /** Literal AnySearch API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current AnySearch API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/v1/search` is appended. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  maxResults?: number
  /** Optional sub-domain capability tag, e.g. `code.doc`. */
  tag?: string
  /** Optional region, one of `cn` or `intl`. */
  zone?: string
  /** Optional preferred language, e.g. `zh-CN` or `en`. */
  language?: string
}

/** One AnySearch result entry. */
export interface AnySearchResultItem {
  title?: string
  url?: string
  snippet?: string
  /** Per-result body text; the richer of the three text fields. */
  content?: string
  /** Short description, used as the snippet when `snippet` is absent. */
  description?: string
  /** Publication/crawl timestamp, ISO-8601 when present. */
  published_at?: string
}

/** The `data` envelope of a successful AnySearch response. */
export interface AnySearchResponseData {
  results?: AnySearchResultItem[]
  metadata?: {
    total_results?: number
    search_time_ms?: number
  }
}

/** The parsed AnySearch response body. */
export interface AnySearchResponse {
  /** Envelope status: `0`/absent means success; any other value is a business error even when HTTP is 200. */
  code?: number
  /** Envelope error text, present when `code` is non-zero. */
  message?: string
  /**
   * Machine-readable failure class (实测 401 返回 `invalid_api_key`). 额度类失败靠它
   * 与 message 关键词判定，丢了它就等于让降级链瞎眼。
   */
  error_code?: string
  request_id?: string
  /** Nested payload envelope (`data.data.results` / `data.data.metadata`). */
  data?: AnySearchResponseData
  /** Flat payload envelope (`data.results`) accepted for services that skip nesting. */
  results?: AnySearchResultItem[]
}

/**
 * Map an AnySearch response envelope to a normalized search result. Entries
 * without a URL are dropped; `title` and `snippet` are optional on the wire and
 * stay optional here. The web service owns the final `maxResults` truncation,
 * so this provider reports `truncated: false`.
 * @param response - the parsed `POST /v1/search` response body.
 * @returns the normalized result.
 */
export function mapAnySearchResponse(response: AnySearchResponse): WebSearchResult {
  // A non-zero envelope `code` is a business error even when HTTP is 200:
  // swallowing it would surface an empty result set as a successful search.
  if (response.code !== undefined && response.code !== 0) {
    const detail = response.message?.trim()
    const text = detail !== undefined && detail.length > 0 ? detail : `code ${response.code}`
    throw new ClassifiedWebError(
      `AnySearch API ${text}`,
      classifyWebFailure({
        ...((response.error_code === undefined || response.error_code.length === 0)
          ? {} : { errorCode: response.error_code }),
        message: text,
      }),
    )
  }
  const sources: WebSearchSource[] = []
  const results = response.data?.results ?? response.results ?? []
  for (const result of results) {
    const url = result.url
    if (url === undefined || url.length === 0) continue
    const snippet = result.snippet ?? result.description
    sources.push({
      url,
      ...(result.title !== undefined && result.title.length > 0 ? { title: result.title } : {}),
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
      ...(result.published_at !== undefined && result.published_at.length > 0
        ? { publishedAt: result.published_at }
        : {}),
    })
  }
  // AnySearch returns per-result body content, not a generated answer, so
  // `content` is omitted; the web seam truncates by `maxResults`.
  return { sources, truncated: false }
}

/** The AnySearch-backed search provider; HTTP redirects fail as `WEB_UNAVAILABLE`. */
export class AnySearchSearchProvider implements WebSearchProvider {
  readonly id = ANYSEARCH_PROVIDER_ID

  private readonly resolveOptions: () => AnySearchSearchProviderOptions

  /**
   * @param resolveOptions - options for the NEXT operation, snapshotted once at
   * each operation's entry so one search never mixes two settings revisions.
   * 显式赋值而非 parameter property：Node 的 strip-only TS 模式不接受
   * `constructor(private readonly …)`，那样单测就得先打包才跑得动。
   */
  constructor(resolveOptions: () => AnySearchSearchProviderOptions) {
    this.resolveOptions = resolveOptions
  }

  available(): boolean {
    const options = this.resolveOptions()
    // The AnySearch free tier accepts requests without an API key, so a key is
    // not part of usability: a valid endpoint and result bound are enough.
    return URL.canParse(options.baseURL)
      && (options.maxResults === undefined || isPositiveInteger(options.maxResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(signal)
    const maxResults = request.maxResults ?? options.maxResults
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/v1/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
          ...((apiKey !== undefined && apiKey.length > 0) ? { 'authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          query: request.query,
          ...(maxResults !== undefined ? { max_results: maxResults } : {}),
          ...((options.tag !== undefined && options.tag.length > 0) ? { tag: options.tag } : {}),
          ...((options.zone !== undefined && options.zone.length > 0) ? { zone: options.zone } : {}),
          ...((options.language !== undefined && options.language.length > 0) ? { language: options.language } : {}),
        }),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      // 连不上/超时是「这一家此刻不中用」，不是「这个查询不中用」：值得换下一家。
      throw new ClassifiedWebError(
        `AnySearch search request failed: ${String(error)}`,
        WEB_UNAVAILABLE,
        undefined,
        { cause: error },
      )
    }

    if (!response.ok) {
      const status = response.status
      const prefix = `AnySearch API error (HTTP ${status})`
      let message = prefix
      let errorCode: string | undefined
      try {
        const parsed = await response.json() as Partial<AnySearchResponse>
        const detail = parsed.message
        if (detail !== undefined && detail.length > 0) message = `${prefix}: ${detail}`
        errorCode = parsed.error_code
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body can only cost a richer message.
      }
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'))
      throw new ClassifiedWebError(
        message,
        classifyWebFailure({
          status,
          ...(errorCode === undefined || errorCode.length === 0 ? {} : { errorCode }),
          message,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        }),
        retryAfterSeconds,
      )
    }

    try {
      const payload = await response.json() as AnySearchResponse
      return mapAnySearchResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new ClassifiedWebError(
        `AnySearch returned an unprocessable response body: ${String(error)}`,
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
  private async apiKey(options: AnySearchSearchProviderOptions, signal?: AbortSignal): Promise<string | undefined> {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(
        `AnySearch search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    // No literal or ambient key: fall through and serve without `Authorization`,
    // which AnySearch accepts as its anonymous free tier.
    return resolved !== undefined && resolved.length > 0 ? resolved : undefined
  }
}

/**
 * 取消语义转发到 ./web-search-abort.ts。链上三个后端必须共用同一份实现：多一个
 * 副本就多一次「改动时被写歪」的机会，而把用户取消误判成后端故障，会让降级链在
 * 停止生成之后继续往下几家猛打。保留这些同名本地函数只是为了一次都不改调用点。
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return sharedAbortable(PROVIDER_NAME, operation, signal)
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  sharedThrowIfAborted(PROVIDER_NAME, signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return sharedSearchAborted(PROVIDER_NAME, signal, fallback)
}

/** True for a request limit that can be sent to AnySearch (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
