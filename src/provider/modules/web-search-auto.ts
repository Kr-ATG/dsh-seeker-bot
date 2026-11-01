/**
 * dsh-seeker-bot — `anysearch-auto` 链的注册模块（host 半身）。
 *
 * 它把三个后端串成一条按失败类别降级的链，并以**单个** provider 的身份注册进
 * `ctx.web`（id = `anysearch-auto`）。宿主那边永远只看得到一个 provider，所以这套
 * 降级完全不需要改宿主——宿主的 seam 注释里写死了「不是隐藏优先级链」，链只能长在
 * 插件这一侧。
 *
 * 启用方式（profile 覆盖，一行；改回 `anysearch` 即回退，不动 base）：
 *
 *   web:
 *     searchProvider: anysearch-auto
 *
 * 链的顺序、冷却时长与两个后备后端的端点/凭据引用都在自有 settings 命名空间
 * `web-search-auto` 里。明文 key 一律不落 settings.yaml，只走凭据引用
 * （`TAVILY_API_KEY` / `DEEPSEEK_API_KEY`），与 `web-search-anysearch` 的约定一致。
 *
 * anysearch 环**复用 `applyAnySearch` 已经构造好的实例**：那个模块已经挂过
 * `web-search-anysearch` 命名空间，这里再挂一次会撞 settings 的重复注册；复用实例
 * 也意味着用户已有的 AnySearch 配置（端点、key、maxResults）零迁移。
 * @module dsh-provider-hub/web-search-auto
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import type { ChainLink, ChainEvent } from './web-search-chain.ts'
import { FallbackSearchProvider, AUTO_PROVIDER_ID } from './web-search-chain.ts'
import type { AnySearchSearchProvider } from './web-search-provider.ts'
import { TAVILY_DEFAULT_BASE_URL, TavilySearchProvider } from './web-search-tavily.ts'
import type { TavilySearchDepth } from './web-search-tavily.ts'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekFallbackSearchProvider,
} from './web-search-deepseek-fallback.ts'
import { credentialRef } from '../vendor/credential-ref.ts'
import type { CredentialRef } from '../vendor/credential-ref.ts'
import { launchEnvironmentOf } from '../vendor/launch-environment.ts'
import {
  installSettingsSection,
  sectionSchema,
  settingsNamespace,
} from '../vendor/settings-section.ts'

/** 本模块拥有的 settings 命名空间。 */
export const WEB_SEARCH_AUTO_SETTINGS_NAMESPACE = 'web-search-auto'

/** 链对外的 provider id（`web.searchProvider` 填它即启用）。 */
export const WEB_SEARCH_AUTO_PROVIDER_ID = AUTO_PROVIDER_ID

/** 默认链顺序：结果质量优先、贵的兜底放最后（DeepSeek 那环每次是一个完整模型 turn）。 */
export const AUTO_DEFAULT_ORDER = 'anysearch,tavily,deepseek'

/** 额度类失败的默认冷却分钟数。 */
export const AUTO_DEFAULT_QUOTA_COOLDOWN_MINUTES = 30

/** 环境变量覆盖名（与 `ANYSEARCH_BASE_URL` 的命名习惯对齐）。 */
const TAVILY_BASE_URL_ENV = 'TAVILY_BASE_URL'
const DEEPSEEK_SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

/** order 里可用的环名 → 实际后端的别名表。 */
const LINK_ALIASES: Record<string, string> = {
  anysearch: 'anysearch',
  tavily: 'tavily',
  deepseek: 'deepseek-official',
  'deepseek-official': 'deepseek-official',
}

/** settings 段形状。boolean 表达不了的开关（如 include_answer）留在代码常量里。 */
export interface AutoSection {
  /** 逗号分隔的链顺序；未知名字会被跳过并记一次日志。 */
  order?: string
  /** 额度/套餐耗尽后该环的冷却分钟数。 */
  quotaCooldownMinutes?: number
  tavilyBaseURL?: string
  /** 明文 Tavily key（能用凭据引用就别填这里）。 */
  tavilyApiKey?: string
  tavilyApiKeyEnv?: string
  tavilySearchDepth?: string
  tavilyLanguage?: string
  deepseekBaseURL?: string
  /** 明文 DeepSeek key（能用凭据引用就别填这里）。 */
  deepseekApiKey?: string
  deepseekApiKeyEnv?: string
  deepseekModel?: string
  deepseekApiVersion?: string
  deepseekMaxTokens?: number
  deepseekMaxUses?: number
}

const AutoSectionSchema = sectionSchema<AutoSection>({
  order: { type: 'string', default: AUTO_DEFAULT_ORDER },
  quotaCooldownMinutes: { type: 'number', min: 1, default: AUTO_DEFAULT_QUOTA_COOLDOWN_MINUTES },
  tavilyBaseURL: { type: 'string', default: TAVILY_DEFAULT_BASE_URL },
  tavilyApiKey: { type: 'string', role: 'secret' },
  tavilyApiKeyEnv: { type: 'string', role: 'credential-ref', default: 'TAVILY_API_KEY' },
  tavilySearchDepth: { type: 'string', default: 'basic' },
  tavilyLanguage: { type: 'string' },
  deepseekBaseURL: { type: 'string', default: DEEPSEEK_DEFAULT_BASE_URL },
  deepseekApiKey: { type: 'string', role: 'secret' },
  deepseekApiKeyEnv: { type: 'string', role: 'credential-ref', default: 'DEEPSEEK_API_KEY' },
  deepseekModel: { type: 'string', default: DEEPSEEK_DEFAULT_MODEL },
  deepseekApiVersion: { type: 'string', default: DEEPSEEK_DEFAULT_API_VERSION },
  deepseekMaxTokens: { type: 'number', min: 1, default: DEEPSEEK_DEFAULT_MAX_TOKENS },
  deepseekMaxUses: { type: 'number', min: 1, default: DEEPSEEK_DEFAULT_MAX_USES },
})

/** applyWebSearchAuto 的依赖注入。 */
export interface WebSearchAutoDeps {
  /** `applyAnySearch` 构造出的实例；缺席则该环不入链（链退化为两级）。 */
  anysearch?: AnySearchSearchProvider | undefined
}

/**
 * 凭据解析：优先宿主 credentials 服务，缺席时回落启动环境。与
 * `web-search-anysearch.ts` 的 resolveOptions 同一套顺序，保证三个后端的
 * key 读取语义一模一样。
 * @param ctx - 插件上下文。
 * @param ref - 凭据引用（环境变量风格的名字）。
 * @returns 一次搜索的 key 解析器。
 */
function makeCredentialResolver(ctx: Context, ref: CredentialRef): () => Promise<string | undefined> {
  return async () => {
    const credentials = ctx.get('credentials') as
      | { resolve(ref: unknown): Promise<{ value?: string } | undefined> }
      | undefined
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    const ambient = launchEnvironmentOf(ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
}

/** 读取一个环境变量覆盖值（没有就 undefined）。 */
function environmentValue(ctx: Context, name: string): string | undefined {
  const ambient = launchEnvironmentOf(ctx).get(name)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/**
 * 注册 `anysearch-auto`：一条 AnySearch → Tavily → DeepSeek 的降级链。
 *
 * 与包内其它模块一样「注册时不带解析值」：三个后端的选项都在 thunk 里每次搜索重新
 * 投影，改了 settings 立刻生效，不需要重注册 provider（重注册会让 seam 的选择过程
 * 在用户眼里闪一下）。
 * @param ctx - 插件上下文（需要 `web` 与可选的 `settings` / `credentials`）。
 * @param deps - anysearch 环的实例来源。
 * @returns 注册进去的链实例（测试与诊断用）。
 */
export function applyWebSearchAuto(ctx: Context, deps: WebSearchAutoDeps = {}): FallbackSearchProvider {
  const entry = AutoSectionSchema({})
  let current: () => AutoSection = () => entry
  try {
    installSettingsSection(
      ctx,
      settingsNamespace(WEB_SEARCH_AUTO_SETTINGS_NAMESPACE),
      AutoSectionSchema,
      entry,
      {
        setSource: (source) => {
          current = source
        },
        onChange: () => {},
      },
    )
  } catch (error) {
    ctx.logger?.warn?.(`[hub/web-search-auto] 设置命名空间挂载失败，走默认配置：${String(error)}`)
  }

  // 三个后端实例只构造一次；它们的选项由 thunk 在每次搜索时投影。
  const tavily = new TavilySearchProvider(() => resolveTavilyOptions(ctx, current()))
  const deepseek = new DeepSeekFallbackSearchProvider(() => resolveDeepSeekOptions(ctx, current()))
  const known: Record<string, ChainLink> = { tavily: { id: 'tavily', provider: tavily } }
  if (deps.anysearch !== undefined) {
    known['anysearch'] = { id: 'anysearch', provider: deps.anysearch }
  }
  known['deepseek-official'] = { id: 'deepseek-official', provider: deepseek }

  // 拼不出来的名字只警告一次：order 写错是配置问题，不该每次搜索都刷一遍日志。
  // 注意必须在「别名查表之前」就把它留下来汇报——直接在 map+filter 里丢掉，
  // 用户写错环名时得到的是「链静默变短」，那是最难查的一类故障（单测正是为此而写）。
  const warned = new Set<string>()
  const resolveLinks = (): readonly ChainLink[] => {
    // 名字原样保留用于回显（用户要能在日志里认出自己写的那个词），查表才转小写。
    const requested = (current().order ?? AUTO_DEFAULT_ORDER)
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
    const links: ChainLink[] = []
    for (const name of requested) {
      const key = name.toLowerCase()
      const resolved = LINK_ALIASES[key]
      if (resolved === undefined) {
        if (!warned.has(key)) {
          warned.add(key)
          ctx.logger?.warn?.(`[hub/web-search-auto] 链上没有名为 "${name}" 的后端，已跳过`)
        }
        continue
      }
      const link = known[resolved]
      if (link === undefined) {
        if (!warned.has(resolved)) {
          warned.add(resolved)
          ctx.logger?.warn?.(`[hub/web-search-auto] 后端 "${resolved}" 本次不可用（缺少 anysearch 实例），已跳过`)
        }
        continue
      }
      if (!links.some((existing) => existing.id === link.id)) links.push(link)
    }
    return links
  }

  const chain = new FallbackSearchProvider({
    resolveLinks,
    quotaCooldownMs: () => (current().quotaCooldownMinutes ?? AUTO_DEFAULT_QUOTA_COOLDOWN_MINUTES) * 60 * 1000,
    onEvent: (event) => logChainEvent(ctx, event),
  })

  ctx.web.registerSearchProvider(chain)
  return chain
}

/**
 * 降级事件只进日志（用户选的是「不打扰」）：切环与全链失败用 warn，正常成功压到
 * debug——模型可见文本里没有「本次实际后端」的容身之处（`WebSearchResult` 只有
 * sources/content/truncated），所以这是唯一能告诉运维「今天用的是哪家」的通道。
 * @param ctx - 插件上下文。
 * @param event - 链事件。
 */
function logChainEvent(ctx: Context, event: ChainEvent): void {
  const logger = ctx.logger
  if (logger === undefined) return
  switch (event.kind) {
    case 'fallback':
      logger.warn?.(
        `[hub/web-search-auto] ${event.from} 失败（${event.code}），`
        + `${event.cooldownMs > 0 ? `冷却 ${String(Math.round(event.cooldownMs / 1000))}s 后` : '不冷却，下次仍先试它'}${event.to === undefined ? '且链已走尽' : `切到 ${event.to}`}：${event.reason}`,
      )
      return
    case 'success':
      if (event.attempted.length > 1) {
        logger.info?.(`[hub/web-search-auto] 本次搜索实际由 ${event.id} 返回 ${String(event.sources)} 条（依次试过：${event.attempted.join(', ')}）`)
      } else {
        logger.debug?.(`[hub/web-search-auto] ${event.id} 直接成功，${String(event.sources)} 条`)
      }
      return
    case 'attempt':
      logger.debug?.(`[hub/web-search-auto] 尝试 ${event.id}`)
      return
  }
}

/** 把当前设置段投影为 Tavily 环下一次搜索的选项。 */
function resolveTavilyOptions(ctx: Context, config: AutoSection) {
  const apiKeyEnv = credentialRef(config.tavilyApiKeyEnv ?? 'TAVILY_API_KEY')
  const literalApiKey = config.tavilyApiKey !== undefined && config.tavilyApiKey.length > 0
    ? config.tavilyApiKey
    : undefined
  const depth = config.tavilySearchDepth ?? 'basic'
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    resolveApiKey: makeCredentialResolver(ctx, apiKeyEnv),
    apiKeyEnv,
    baseURL: config.tavilyBaseURL ?? environmentValue(ctx, TAVILY_BASE_URL_ENV) ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: isTavilyDepth(depth) ? depth : 'basic',
    ...(config.tavilyLanguage !== undefined && config.tavilyLanguage.length > 0
      ? { language: config.tavilyLanguage }
      : {}),
  }
}

/** 把当前设置段投影为 DeepSeek 环下一次搜索的选项。 */
function resolveDeepSeekOptions(ctx: Context, config: AutoSection) {
  const apiKeyEnv = credentialRef(config.deepseekApiKeyEnv ?? 'DEEPSEEK_API_KEY')
  const literalApiKey = config.deepseekApiKey !== undefined && config.deepseekApiKey.length > 0
    ? config.deepseekApiKey
    : undefined
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    resolveApiKey: makeCredentialResolver(ctx, apiKeyEnv),
    apiKeyEnv,
    baseURL: config.deepseekBaseURL
      ?? environmentValue(ctx, DEEPSEEK_SEARCH_BASE_URL_ENV)
      ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: config.deepseekModel ?? DEEPSEEK_DEFAULT_MODEL,
    apiVersion: config.deepseekApiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: config.deepseekMaxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: config.deepseekMaxUses ?? DEEPSEEK_DEFAULT_MAX_USES,
  }
}

/** 只接受 Tavily 文档里的四个深度档，写错的值回落到 basic（1 credit）。 */
function isTavilyDepth(value: string): value is TavilySearchDepth {
  return value === 'basic' || value === 'advanced' || value === 'fast' || value === 'ultra-fast'
}
