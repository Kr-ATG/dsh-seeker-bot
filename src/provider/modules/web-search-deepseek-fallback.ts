/**
 * `DeepSeekFallbackSearchProvider`: `anysearch-auto` 链的最后一环。走 DeepSeek 的
 * Anthropic 兼容 Messages 接口，用原生 `web_search_20250305` 服务端工具做检索。
 *
 * 为什么在本包重写一份而不用宿主那个：宿主的 `@deepseek-ai/dsh-web-search-deepseek`
 * 确实已经注册了同名 provider，但 `ctx.web` 的 registry 是私有 `Map`，**没有任何公开
 * 枚举 API**——链问不到「还有哪些后端」，也无法指名调用某一家（`search()` 只会按
 * `web.searchProvider` 选中一个，而那个已经是链自己）。加上 profile 层解析不到
 * `@deepseek-ai/*` 的运行时产物（见 ../vendor/error.ts 头部注释），所以只能自带一份。
 * 本文件的 wire 形状与响应映射逐字对照宿主实现（`lib/index.js`），差异只两处：
 *   1. 不做 DeepSeek 账号 token 分支（本包链只吃 `DEEPSEEK_API_KEY` 凭据引用）；
 *   2. 失败按 ./web-search-failure.ts 分类，让链能路由。
 *
 * 成本提醒：这一环每次搜索都是一整个模型 turn（`max_uses` 上限 5 次服务端检索），
 * 所以顺序上永远放在最后。
 * @module dsh-provider-hub/web-search-deepseek-fallback
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
  WEB_QUOTA_EXCEEDED,
  WEB_UNAVAILABLE,
  classifyWebFailure,
  parseRetryAfter,
} from './web-search-failure.ts'
import { abortable, isAbortError, searchAborted, throwIfSearchAborted } from './web-search-abort.ts'

/** Stable id this link reports under (it is never registered into `ctx.web`). */
export const DEEPSEEK_FALLBACK_PROVIDER_ID = 'deepseek-official'

/** 辅助检索端点（含 `/v1`），`/messages` 在其后追加；与会话适配器端点相互独立。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** Anthropic 格式的模型名（与仓库 DeepSeek 模型词表一致）。 */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

/** `anthropic-version` 头默认值。 */
export const DEEPSEEK_DEFAULT_API_VERSION = '2023-06-01'

/** Messages 请求的生成 token 上限默认值。 */
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096

/** 单次请求允许的原生检索次数默认值。 */
export const DEEPSEEK_DEFAULT_MAX_USES = 5

/** 取消消息里的 provider 名。 */
const PROVIDER_NAME = 'DeepSeek'

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-seeker-bot-web-search-deepseek/0.1.0'

// ── provider-private wire types（逐字对照宿主 types.ts）───────────────────────

/** A `web_search_result` item inside a `web_search_tool_result` block. */
export interface WebSearchResultItem {
  type: string
  url: string
  title?: string | null
  /** Provider-supplied page age/recency string (mapped to `publishedAt`). */
  page_age?: string | null
}

/** A `web_search_tool_result` content block: the citeable result shape. */
export interface WebSearchToolResultBlock {
  type: 'web_search_tool_result'
  content?: WebSearchResultItem[]
}

/** One citation location inside a `text` block (the snippet source). */
export interface CitationLocation {
  type?: string
  url?: string | null
  cited_text?: string | null
}

/** A `text` content block: the model's prose plus per-URL citations. */
export interface TextBlock {
  type: 'text'
  text?: string | null
  citations?: CitationLocation[]
}

/** Any content block; only `web_search_tool_result` and `text` are consumed. */
export type ContentBlock = WebSearchToolResultBlock | TextBlock | { type: string }

/** DeepSeek's Anthropic Messages response envelope. */
export interface AnthropicResponse {
  content?: ContentBlock[]
}

/** DeepSeek's error response envelope (best-effort; fields vary). */
export interface AnthropicError {
  error?: { message?: string } | string
  message?: string
}

// ── options ───────────────────────────────────────────────────────────────────

/** Resolved provider options (the chain's registration supplies defaults). */
export interface DeepSeekFallbackOptions {
  /** Literal DeepSeek API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current DeepSeek API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/messages` is appended. */
  baseURL: string
  /** Anthropic-format model name. */
  model: string
  /** `anthropic-version` header value. */
  apiVersion: string
  /** Upper bound on generated tokens for the Messages request. */
  maxTokens: number
  /** Maximum `web_search` server-tool uses per request. */
  maxUses: number
}

// ── mapping ───────────────────────────────────────────────────────────────────

/**
 * Build a `url → cited_text` map from every `text` block's `citations[]`. This
 * is the snippet source: Anthropic `web_search_result` items carry
 * `url`/`title`/`page_age` but typically NO inline snippet — the excerpt lives
 * in a separate `text` block's citation, keyed by `url` (first occurrence wins).
 * @param blocks - the response's content blocks; non-`text` blocks are skipped.
 * @returns the `url → cited_text` map (empty when no citations are present).
 */
export function citationSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of block.citations ?? []) {
      if (cite.url !== undefined && cite.url !== null && cite.url.length > 0
        && cite.cited_text !== undefined && cite.cited_text !== null && cite.cited_text.length > 0
        && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text)
      }
    }
  }
  return map
}

/**
 * Map a DeepSeek Anthropic Messages response to a normalized search result. Walks
 * `web_search_tool_result` blocks for citeable items, joins each to its citation
 * excerpt as `snippet`, and dedupes by `url`. The web seam owns the final
 * `maxResults` truncation, so `truncated` is always `false` here.
 * @param response - the parsed Messages response body.
 * @returns the normalized result with deduped, snippet-joined sources.
 * @throws `WEB_UNAVAILABLE` when native search produced no result block — that
 *   means this link could not answer, not that the query is bad, so the chain
 *   may still try another backend.
 */
export function mapAnthropicResponse(response: AnthropicResponse): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter((block): block is WebSearchToolResultBlock => block.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new ClassifiedWebError(
      'DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search',
      WEB_UNAVAILABLE,
    )
  }
  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...((item.title !== undefined && item.title !== null && item.title.length > 0) ? { title: item.title } : {}),
        ...((snippet !== undefined && snippet.length > 0) ? { snippet } : {}),
        ...((item.page_age !== undefined && item.page_age !== null && item.page_age.length > 0) ? { publishedAt: item.page_age } : {}),
      })
    }
  }
  return { sources, truncated: false }
}

/** The DeepSeek-backed fallback link; HTTP redirects and 5xx surface as `WEB_UNAVAILABLE`. */
export class DeepSeekFallbackSearchProvider implements WebSearchProvider {
  readonly id = DEEPSEEK_FALLBACK_PROVIDER_ID

  private readonly resolveOptions: () => DeepSeekFallbackOptions

  /**
   * @param resolveOptions - options for the NEXT operation, snapshotted once at
   * each operation's entry so one search never mixes two settings revisions.
   * 显式赋值而非 parameter property：Node strip-only 模式跑不了后者，单测就得先打包。
   */
  constructor(resolveOptions: () => DeepSeekFallbackOptions) {
    this.resolveOptions = resolveOptions
  }

  available(): boolean {
    const options = this.resolveOptions()
    // 没有可发的凭据就不算可用：链跳过这一环，而不是把它当成一次失败。
    return ((options.apiKey !== undefined && options.apiKey.length > 0) || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
      && isPositiveInteger(options.maxUses)
  }

  /**
   * 凭据预检。`available()` 只能判「有没有解析器」，判不出凭据库里实际有没有
   * `DEEPSEEK_API_KEY`；链先用这里筛一遍，就不会在一个必然报
   * `WEB_PROVIDER_CREDENTIAL_MISSING` 的环上白烧一次往返。不发网络请求。
   * @returns 下一次搜索能不能带上 DeepSeek key。
   */
  async ready(): Promise<boolean> {
    const options = this.resolveOptions()
    if (options.apiKey !== undefined && options.apiKey.length > 0) return true
    if (options.resolveApiKey === undefined) return false
    try {
      const resolved = await options.resolveApiKey()
      return resolved !== undefined && resolved.length > 0
    } catch {
      return false
    }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const endpoint = `${options.baseURL}/messages`
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(PROVIDER_NAME, signal)

    const body = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{
        role: 'user' as const,
        content: [{
          type: 'text' as const,
          text: `Perform a web search for the query: ${request.query}`,
        }],
      }],
      tools: [{
        type: 'web_search_20250305' as const,
        name: 'web_search',
        max_uses: options.maxUses,
      }],
      // 辅助 turn 的文本会被丢弃，reasoning token 没有消费者，所以恒 disabled。
      thinking: { type: 'disabled' as const },
    }

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          'authorization': `Bearer ${apiKey}`,
          'anthropic-version': options.apiVersion,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(PROVIDER_NAME, signal, error)
      throw new ClassifiedWebError(
        `DeepSeek search request failed: ${String(error)}`,
        WEB_UNAVAILABLE,
        undefined,
        { cause: error },
      )
    }

    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'))

    if (!response.ok) {
      const status = response.status
      let message = `DeepSeek API error (HTTP ${status})`
      try {
        const parsed = await response.json() as AnthropicError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = `${message}: ${detail}`
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(PROVIDER_NAME, signal, error)
      }
      // 账户侧配额（insufficient_quota / 402）与模型路由错误在报文里混着，
      // 先按关键词硬命中，其余交给通用分类器。
      const quotaHit = /insufficient_quota|billing|quota exceeded|usage limit/iu.test(message)
      throw new ClassifiedWebError(
        message,
        quotaHit ? WEB_QUOTA_EXCEEDED : classifyWebFailure({
          status,
          message,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        }),
        retryAfterSeconds,
      )
    }

    try {
      return mapAnthropicResponse(await response.json() as AnthropicResponse)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(PROVIDER_NAME, signal, error)
      if (error instanceof WebError) throw error
      throw new ClassifiedWebError(
        `DeepSeek returned an unprocessable response body: ${String(error)}`,
        WEB_UNAVAILABLE,
        undefined,
        { cause: error },
      )
    }
  }

  /**
   * Resolve one operation's API key without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   */
  private async apiKey(options: DeepSeekFallbackOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(PROVIDER_NAME, signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(PROVIDER_NAME, options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(PROVIDER_NAME, signal, error)
      throw new WebError(
        `DeepSeek search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    throw new WebError(
      `DeepSeek search has no API key for "${options.apiKeyEnv ?? 'DEEPSEEK_API_KEY'}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-auto config.`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** True for DeepSeek request limits that can be sent to the Messages API. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
