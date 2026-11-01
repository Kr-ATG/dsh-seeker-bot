/**
 * `FallbackSearchProvider`: 把多个 `WebSearchProvider` 串成一条按失败类别降级的链，
 * 对 `ctx.web` 只暴露一个 id（`anysearch-auto`）。
 *
 * 为什么必须自己写：宿主的 seam 在设计上拒绝优先级链——`WebRuntime.search()` 就是
 * `selectSearchProvider().search()` 一行，`web.searchProvider` 的类型注释两次写明
 * 它「pin which provider」且「NOT a hidden priority chain」；registry 还是私有 `Map`，
 * 插件既枚举不到别的后端，也没法指名调用某一家。所以「额度没了自动切」只能由插件
 * 在**自己拥的那几个实现**之间完成，宿主那边永远只看到一个 provider。
 *
 * 三条语义决定（都是踩出来的，不是随手写的）：
 *   1. **取消绝不降级**。用户停止生成时每一环都必须以 `WEB_ABORTED` 立刻退出；
 *      把它当成「这家不行」会导致继续往下几家猛打，既烧额度又产出无人认领的结果。
 *   2. **只有「换一家可能成」的失败才切**。额度/凭据/速率/上游故障可切；
 *      400 这类「查询本身不对」不可切——换后端只是白烧一次额度并拖慢回答。
 *      分类见 ./web-search-failure.ts。
 *   3. **熔断分级**。额度耗尽不会自己回来，冷却 30 分钟，避免每次搜索都先撞一下；
 *      上游 5xx 不冷却，下次照常先试它（它结果最好，且可能已经恢复）。
 *      全部环都在冷却时忽略冷却重走一遍，否则一次网络抖动就能把链永久锁死。
 *
 * 一个诚实的限制：`WebSearchResult` 只有 `sources/content/truncated`，没有字段能携带
 * 「这次实际用了哪家」，所以实际后端只进日志（`onEvent`），对话卡片上的来源标签不变。
 * @module dsh-provider-hub/web-search-chain
 */

import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@deepseek-ai/dsh-web'
import { WebError } from '../vendor/error.ts'
import {
  ClassifiedWebError,
  WEB_QUOTA_EXCEEDED,
  WEB_UNAVAILABLE,
  cooldownOf,
  isFallbackableCode,
} from './web-search-failure.ts'

/** 链对外的注册 id（profile 里 `web.searchProvider: anysearch-auto` 即启用）。 */
export const AUTO_PROVIDER_ID = 'anysearch-auto'

/** 额度类失败的默认冷却时长：按天/月重置的额度，短时间内重试没有意义。 */
export const DEFAULT_QUOTA_COOLDOWN_MS = 30 * 60 * 1000

/** 链上的一环。 */
export interface ChainLink {
  /** 日志与诊断里显示的后端名。 */
  readonly id: string
  readonly provider: WebSearchProvider
}

/** 链的一次可观察事件（只进日志，不进模型可见文本）。 */
export type ChainEvent =
  /** 某一环失败，链决定切到下一环（或决定不切）。 */
  | { kind: 'fallback'; from: string; code: string; reason: string; cooldownMs: number; to: string | undefined }
  /** 链选中某一环开始请求（用于确认降级后的实际后端）。 */
  | { kind: 'attempt'; id: string }
  /** 某一环成功返回，链结束。 */
  | { kind: 'success'; id: string; sources: number; attempted: readonly string[] }

/** FallbackSearchProvider 的构造选项。 */
export interface FallbackSearchProviderOptions {
  /**
   * 本轮的下一次搜索该按什么顺序走链——**thunk 而不是数组**：settings 段会在两次
   * 搜索之间变化，为了换一个顺序就重注册 provider，会让 seam 的选择过程对用户
   *  observable 成一次闪烁（宿主 deepseek provider 的注释写的正是这条）。
   * 顺序即优先级：第一个可用的环先试。
   */
  resolveLinks: () => readonly ChainLink[]
  /**
   * 额度类冷却毫秒；缺省 30 分钟。和 `resolveLinks` 一样接受 thunk：设置段会在两次
   * 搜索之间变化，把数值在注册时固化就等于让用户改完还得重启。
   */
  quotaCooldownMs?: number | (() => number)
  /** 时钟注入点，测试用。 */
  now?: () => number
  /** 链的可观察事件（注册模块拿它写 ctx.logger）。 */
  onEvent?: (event: ChainEvent) => void
}

/** 某一环本轮的失败记录，用于全失败时聚合成一条人话。 */
interface LinkFailure {
  id: string
  code: string
  message: string
}

/** 多后端链：一次搜索按序走链，命中可降级失败就切下一环。 */
export class FallbackSearchProvider implements WebSearchProvider {
  readonly id = AUTO_PROVIDER_ID

  /** 各环的冷却到期时间戳（毫秒）。不在表里 = 没在冷却。 */
  private readonly cooling = new Map<string, number>()

  private readonly resolveLinks: () => readonly ChainLink[]
  private readonly resolveQuotaCooldown: () => number
  private readonly now: () => number
  private readonly onEvent: ((event: ChainEvent) => void) | undefined

  /**
   * @param options - 链的顺序投影、冷却时长、时钟与事件回调。
   */
  constructor(options: FallbackSearchProviderOptions) {
    this.resolveLinks = options.resolveLinks
    const quota = options.quotaCooldownMs
    this.resolveQuotaCooldown = typeof quota === 'function'
      ? quota
      : () => (typeof quota === 'number' ? quota : DEFAULT_QUOTA_COOLDOWN_MS)
    this.now = options.now ?? (() => Date.now())
    this.onEvent = options.onEvent
  }

  /** 任一后端可用即算链可用（宿主选中一个 provider 后只看这个总闸）。 */
  available(): boolean {
    return this.snapshotLinks().some((link) => this.providerAvailable(link))
  }

  /**
   * 只要链上还有任何一环「有可能」搜到东西就报 ready：宿主用它决定这次模型请求
   * 要不要挂 `web_search` 工具，误报 false 会让模型整个 turn 都看不见搜索能力。
   * 冷却中的环也算数——冷却只是别再白撞，不代表彻底不能搜。
   * @param llmProvider - 本次模型请求所在的供应商路由 id。
   * @returns 是否能鉴权发起一次搜索。
   */
  async ready(llmProvider: string | undefined): Promise<boolean> {
    for (const link of this.snapshotLinks()) {
      if (!this.providerAvailable(link)) continue
      if (await this.linkReady(link, llmProvider)) return true
    }
    return false
  }

  /**
   * 按序走链跑一次搜索。
   * @param request - 查询与可选的结果条数上限。
   * @param signal - 外层取消信号，原样透传给每一环。
   * @returns 第一个成功环的结果。
   * @throws `WebError`：取消、不可降级失败、或全链失败（message 汇总每一环原因）。
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // 一次操作一个快照：中途改了 order 不得让这次搜索混用两个顺序。
    const links = this.snapshotLinks()
    const order = await this.attemptOrder(links, signal)
    if (order.length === 0) {
      throw new WebError(
        `no usable web search backend is registered for "${this.id}" (configured chain: ${links.map((link) => link.id).join(', ') || 'empty'})`,
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }

    const failures: LinkFailure[] = []
    const attempted: string[] = []

    for (const [index, link] of order.entries()) {
      throwIfAborted(signal)
      attempted.push(link.id)
      this.emit({ kind: 'attempt', id: link.id })
      try {
        const result = await link.provider.search(request, signal)
        this.emit({ kind: 'success', id: link.id, sources: result.sources.length, attempted })
        return result
      } catch (error: unknown) {
        // 取消不是失败：立刻原样上抛，绝不换一家再打。
        if (isAborted(error)) throw asWebError(error)
        const failure = toLinkFailure(link.id, error)
        failures.push(failure)
        if (!isFallbackableCode(failure.code)) {
          // 这次查询本身有问题（400/404/4xx 配错）：换后端也必败，如实报错。
          throw asWebError(error)
        }
        const cooldownMs = cooldownOf(failure.code, retryAfterOf(error), this.quotaCooldown())
        if (cooldownMs > 0) this.cooling.set(link.id, this.now() + cooldownMs)
        const next = order[index + 1]
        this.emit({
          kind: 'fallback',
          from: link.id,
          code: failure.code,
          reason: failure.message,
          cooldownMs,
          to: next === undefined ? undefined : next.id,
        })
      }
    }

    throw aggregateError(failures)
  }

  /**
   * 投影额度冷却时长。配置函数抛错就退回默认值：冷却是省钱手段，不该有让一次搜索
   * 直接崩掉的权力。
   * @returns 冷却毫秒数。
   */
  private quotaCooldown(): number {
    try {
      const value = this.resolveQuotaCooldown()
      return Number.isFinite(value) && value >= 0 ? value : DEFAULT_QUOTA_COOLDOWN_MS
    } catch {
      return DEFAULT_QUOTA_COOLDOWN_MS
    }
  }

  /**
   * 投影本轮的链顺序。配置读取本身抛错时回退到空链——链宁可报
   * `WEB_PROVIDER_UNAVAILABLE` 也不该在设置写入的瞬间把异常原样甩给模型。
   * @returns 当前设置解析出的环顺序。
   */
  private snapshotLinks(): readonly ChainLink[] {
    try {
      return this.resolveLinks()
    } catch {
      return []
    }
  }

  /**
   * 本轮的尝试顺序：可用、未冷却、且「凭据预检通过」的环在前。
   *
   * 两道兜底都是为了防止「链自己把用户锁死」：全部环在冷却时忽略冷却重走；全部环
   * 预检不过时照样试一遍。`available()` 是同步的、不能读异步凭据库，所以没配 key
   * 的后备环在这一关总是看起来可用——真出事要等它抛 `WEB_PROVIDER_CREDENTIAL_MISSING`，
   * 于是这里先用 `ready()` 预检，省掉一次必败的往返。
   * @param links - 本轮的链快照。
   * @param signal - 外层取消信号：预检也得能被取消打断。
   * @returns 本轮要依次尝试的环。
   */
  private async attemptOrder(links: readonly ChainLink[], signal?: AbortSignal): Promise<ChainLink[]> {
    const usable = links.filter((link) => this.providerAvailable(link))
    const stamp = this.now()
    const fresh = usable.filter((link) => (this.cooling.get(link.id) ?? 0) <= stamp)
    const pool = fresh.length > 0 ? fresh : usable
    const credentialed: ChainLink[] = []
    for (const link of pool) {
      throwIfAborted(signal)
      if (await this.linkReady(link, undefined)) credentialed.push(link)
    }
    return credentialed.length > 0 ? credentialed : pool
  }

  private providerAvailable(link: ChainLink): boolean {
    try {
      return link.provider.available()
    } catch {
      // 一个后端的本地检查抛了，不能把整条链判死。
      return false
    }
  }

  private async linkReady(link: ChainLink, llmProvider: string | undefined): Promise<boolean> {
    try {
      return await (link.provider.ready?.(llmProvider) ?? Promise.resolve(true))
    } catch {
      return false
    }
  }

  private emit(event: ChainEvent): void {
    if (this.onEvent === undefined) return
    try {
      this.onEvent(event)
    } catch {
      // 日志实现抛错不得影响搜索本身。
    }
  }

  /** 清空熔断状态（改了配置或用户手动重试时用）。 */
  reset(): void {
    this.cooling.clear()
  }

  /** 当前各环的冷却剩余（毫秒），诊断用；0 表示没在冷却。 */
  coolingRemaining(): Record<string, number> {
    const stamp = this.now()
    const out: Record<string, number> = {}
    for (const [id, until] of this.cooling) {
      const left = until - stamp
      if (left > 0) out[id] = left
    }
    return out
  }
}

/** True when the caller cancelled this operation (not a backend failure). */
function isAborted(error: unknown): boolean {
  return error instanceof WebError && error.code === 'WEB_ABORTED'
}

/** 某一环抛出的取消错误原样上抛；其余保留 message 与 code。 */
function asWebError(error: unknown): WebError {
  if (error instanceof WebError) return error
  return new WebError(String(error), 'WEB_PROVIDER_ERROR', { cause: error })
}

/** 取出后端建议的重试等待秒数（只有 ClassifiedWebError 携带）。 */
function retryAfterOf(error: unknown): number | undefined {
  return error instanceof ClassifiedWebError ? error.retryAfterSeconds : undefined
}

/**
 * 归一化一次环失败。非 `WebError` 的抛法说明该环自己没兜住（实现缺陷或底层库抛的
 * 原始异常），对用户来说表现就是「这家不中用」，所以按上游故障处理：切走，但不冷却。
 */
function toLinkFailure(id: string, error: unknown): LinkFailure {
  if (error instanceof WebError) {
    return { id, code: error.code, message: error.message }
  }
  return { id, code: WEB_UNAVAILABLE, message: String(error) }
}

/** 全链失败：聚合每一环的原因，让模型能告诉用户「三家分别是怎么倒下的」。 */
function aggregateError(failures: readonly LinkFailure[]): WebError {
  const detail = failures
    .map((failure) => `  - ${failure.id} [${failure.code}]: ${failure.message}`)
    .join('\n')
  // 用最后一个可路由 code 作为聚合 code：额度类最接近用户真正该处理的事。
  const quotaHit = failures.some((failure) => failure.code === WEB_QUOTA_EXCEEDED)
  const last = failures[failures.length - 1]
  const code = quotaHit
    ? WEB_QUOTA_EXCEEDED
    : last === undefined
      ? 'WEB_PROVIDER_ERROR'
      : last.code
  return new WebError(
    `web search failed on all ${String(failures.length)} configured backends:\n${detail}`,
    code,
  )
}

/** 取消先行检查：链可能在任何一环之前就被停掉。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new WebError('web search aborted', 'WEB_ABORTED', { cause: signal.reason })
  }
}
