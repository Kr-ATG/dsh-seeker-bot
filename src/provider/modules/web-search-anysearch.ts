/**
 * dsh-provider-hub — AnySearch 网页搜索 provider 注册模块（host 半身）。
 *
 * 架构（2026-09-13 起，替代已删除的全局 fetch 透明桥接）：
 *   模型侧 `web_search` 工具（dsh-tool-web）→ `ctx.web` 缝合服务 →
 *   本模块注册的 `anysearch` provider（`./web-search-provider.ts`，
 *   `POST {baseURL}/v1/search`）→ 归一化 `sources[]`。
 * 全程无全局 fetch 劫持；选中哪个后端只由 `web.searchProvider`
 *（base 默认 `deepseek-official`，profile 覆盖为 `anysearch` 即切到本模块）决定。
 *
 * 配置走自有 settings 命名空间 `web-search-anysearch`（Key 默认走
 * `ANYSEARCH_API_KEY` 凭据引用，明文只进凭据库，不进 settings.yaml）。
 * DSH 源码包在已安装位置解析不到（见 build.mjs），settings 接线与凭据引用
 * 全部走 `src/vendor/` 内联叶子；`@deepseek-ai/dsh-web` 仅作类型导入，
 * 构建时即被擦除，零运行时依赖。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import { AnySearchSearchProvider, ANYSEARCH_DEFAULT_BASE_URL } from './web-search-provider.ts'
import type { AnySearchSearchProviderOptions } from './web-search-provider.ts'
import { credentialRef } from '../vendor/credential-ref.ts'
import { launchEnvironmentOf } from '../vendor/launch-environment.ts'
import {
  installSettingsSection,
  sectionSchema,
  settingsNamespace,
} from '../vendor/settings-section.ts'

/** 本模块拥有的 settings 命名空间（与旧独立插件同名，旧设置无缝延续）。 */
export const WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE = 'web-search-anysearch'

/** 默认凭据引用：凭据库 / 环境里的 AnySearch API Key。 */
const DEFAULT_API_KEY_ENV = 'ANYSEARCH_API_KEY'

/** `/v1/search` 之外的 endpoint 基地址覆盖（环境变量，与官方搜索的命名习惯对齐）。 */
const SEARCH_BASE_URL_ENV = 'ANYSEARCH_BASE_URL'

/** settings 段形状（schema 负责校验 + 默认值，未知键丢弃）。 */
export interface AnySearchSection {
  baseURL?: string
  maxResults?: number
  tag?: string
  zone?: string
  language?: string
  /** 明文 key（能用凭据引用就别填这里）。 */
  apiKey?: string
  apiKeyEnv?: string
}

const AnySearchSectionSchema = sectionSchema<AnySearchSection>({
  baseURL: { type: 'string', default: ANYSEARCH_DEFAULT_BASE_URL },
  maxResults: { type: 'number', min: 1, default: 5 },
  tag: { type: 'string' },
  zone: { type: 'string' },
  language: { type: 'string' },
  apiKey: { type: 'string', role: 'secret' },
  apiKeyEnv: { type: 'string', role: 'credential-ref', default: DEFAULT_API_KEY_ENV },
})

/**
 * 把当前权威段投影为 provider 下一次搜索的选项。环境回退只到这里，
 * provider 读到的全是已落定的值。
 */
function resolveOptions(ctx: Context, config: AnySearchSection): AnySearchSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials') as
        | { resolve(ref: unknown): Promise<{ value?: string } | undefined> }
        | undefined
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? ANYSEARCH_DEFAULT_BASE_URL,
    ...(config.maxResults !== undefined ? { maxResults: config.maxResults } : {}),
    ...(config.tag !== undefined && config.tag.length > 0 ? { tag: config.tag } : {}),
    ...(config.zone !== undefined && config.zone.length > 0 ? { zone: config.zone } : {}),
    ...(config.language !== undefined && config.language.length > 0 ? { language: config.language } : {}),
  }
}

/**
 * 注册 `anysearch` 搜索 provider。settings 服务在即挂命名空间并把解析源
 * 指向 scope；服务缺席则回落组合入口，provider 照常可用。
 *
 * 返回构造出的实例，给 `anysearch-auto` 链复用：链不能再挂一次
 * `web-search-anysearch` 命名空间（会撞 settings 的重复注册），只能共用这个实例；
 * 共用同时意味着用户已有的端点 / key / maxResults 配置零迁移。
 *
 * 注册失败不再向上抛：唯一现实的失败原因是 `WEB_DUPLICATE_PROVIDER`（别处已注册了
 * 同名 provider），那既不影响本模块，也不该连带废掉降级链里这一环。记一条 warn
 * 足够，实例照样归链使用。
 * @param ctx - 插件上下文。
 * @returns provider 实例；构造本身失败时 undefined。
 */
export function applyAnySearch(ctx: Context): AnySearchSearchProvider | undefined {
  const entry = AnySearchSectionSchema({})
  let current: () => AnySearchSection = () => entry
  try {
    installSettingsSection(
      ctx,
      settingsNamespace(WEB_SEARCH_ANYSEARCH_SETTINGS_NAMESPACE),
      AnySearchSectionSchema,
      entry,
      {
        setSource: (source) => {
          current = source
        },
        // 注册时不带解析值：provider 每次搜索都重新投影，改设置无需重注册。
        onChange: () => {},
      },
    )
  } catch (error) {
    ctx.logger?.warn?.(`[hub/web-search] 设置命名空间挂载失败，走默认配置：${String(error)}`)
  }
  let provider: AnySearchSearchProvider
  try {
    provider = new AnySearchSearchProvider(() => resolveOptions(ctx, current()))
  } catch (error) {
    ctx.logger?.warn?.(`[hub/web-search] anysearch provider 构造失败：${String(error)}`)
    return undefined
  }
  try {
    ctx.web.registerSearchProvider(provider)
  } catch (error) {
    ctx.logger?.warn?.(`[hub/web-search] anysearch provider 注册失败（降级链仍可使用它）：${String(error)}`)
  }
  return provider
}
