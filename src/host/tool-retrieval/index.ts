/**
 * MCP 工具的按需注入（Tool RAG）——host 半身的装配入口。
 *
 * ## 为什么在 root ctx 上挂
 *
 * 检索要同时覆盖 **Work 会话**和 **Bot 会话**。Bot 的 turn 由本插件驱动，能在
 * 入口拿到用户原话；Work 的 turn 是宿主发起的，插件拿不到。两者唯一的共同点是
 * 都会走 `system-prompt/assemble` 这条 waterfall，所以钩子挂在 **root ctx**
 * （不带作用域 = 对所有 agent 生效），按 agent 的会话 id 隔离状态。
 *
 * 这与 `tools-gate` 的位置一致（它也在 root ctx），区别在于闸门是**显式开关**、
 * 本模块是**按意图检索**：闸门管「整组能力要不要进请求」，本模块管「这一轮
 * 具体哪些 MCP 工具值得进请求」。
 *
 * ## 意图从哪来
 *
 * - **Bot**：`runBotTurn` 入口调用 `noteQuery()` 记录用户原话（最准的来源）；
 * - **Work**：没有入口，退回到 `agent.session.deriveMessages()` 读最近几条用户
 *   消息（见 `readSessionQuery`）。
 *
 * 两者写进同一份按会话 id 的状态表，因此同一个会话里 Bot 与 Work 不会互相污染。
 *
 * ## 失败策略
 *
 * 任何一步出错都原样放行（全量注入）。省 token 是收益，少工具是事故——
 * 收益可以放弃，事故不能有。
 *
 * @module
 */

import { DEFAULT_RETRIEVAL, noteQuery, pinTool, projectTools, readSessionQuery, retrievalState, searchPool } from './engine.ts'
import type { RetrievalConfig } from './engine.ts'

/** 日志面（方法与 cordis logger 同形，全部可选）。 */
export interface RetrievalLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
}

/** 本模块用到的全部 ctx 面。刻意不引 `@deepseek-ai/cordis` 类型（host 产物必须自包含）。 */
export interface RetrievalHostContext {
  on?(
    event: string,
    listener: (assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ): void
  inject?(names: string[], callback: (ctx: never) => void): void
  logger?: RetrievalLogger
}

/** 装配选项。 */
export interface RetrievalApplyOptions {
  /** 总开关（部署配置可关）。关掉 = 回到全量注入。 */
  enabled?: boolean
  /** 覆盖默认阈值。 */
  config?: Partial<RetrievalConfig>
}

/** 模块级开关：`setToolRetrievalEnabled` 可运行时改。 */
let retrievalEnabled = true

/** 运行时开关（部署配置 / 诊断用）。 */
export function setToolRetrievalEnabled(value: boolean): void {
  retrievalEnabled = value
}

/** 读当前是否启用（测试与诊断用）。 */
export function toolRetrievalEnabled(): boolean {
  return retrievalEnabled
}

/** 模型主动检索工具的公开名。 */
export const SEARCH_TOOL = 'search_tools'

/**
 * 注册 `search_tools`：模型主动把工具捞回来的兜底通道。
 *
 * ## 为什么必须有
 *
 * 关键词检索必然漏召回——业界实测在几千工具规模下命中率只有 56%~64%，连
 * `Gmail_SendEmail` 这种最常用的都搜不到。漏召回的代价是模型**去编**：它会
 * 声称自己调用了不存在的工具，或者干脆换个说法糊弄过去。所以除了自动检索，
 * 必须再给模型一条「我自己知道缺什么，我来要」的路。
 *
 * 命中结果写进 `pinned`，下一步组装时**强制注入**，不受打分影响。
 * 返回值只给名称 + 描述（**不给 schema**）——目的是让模型知道「有这个」，
 * 而不是把省下来的 schema 又从工具结果里塞回去。
 *
 * 注册在 root ctx（global 层），因此 Work 与 Bot 都有这条通道。
 */
function registerSearchTool(ctx: RetrievalHostContext): void {
  if (typeof ctx.inject !== 'function') {
    ctx.logger?.warn?.('[tool-retrieval] inject unavailable: search_tools 未注册（模型无法主动捞工具）')
    return
  }
  try {
    ctx.inject(['tools'], (toolsCtx: never) => {
      const scoped = toolsCtx as unknown as {
        tools?: { register?: (definition: unknown) => () => void; schemas?: (scope?: unknown) => unknown }
        effect?: (fn: () => () => void, label?: string) => void
      }
      const tools = scoped.tools
      if (tools === undefined || typeof tools.register !== 'function') {
        ctx.logger?.warn?.('[tool-retrieval] tools service unavailable: search_tools 未注册')
        return
      }
      const definition = {
        name: SEARCH_TOOL,
        description: [
          '检索当前**未注入**的 MCP 工具（按需加载），命中的工具会在下一步出现在你的工具列表里。',
          '只在自动注入的工具不够用时调用：比如你需要查地图/发邮件/查资料，但工具列表里没有对应的 MCP 工具。',
          '返回的是工具名称与用途，不含参数；拿到名称后下一步就能直接调用它。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要做什么，用自然语言描述（中文即可），例如「查天气」「发邮件」' },
            limit: { type: 'number', description: '最多返回几个（默认 8，上限 20）' },
          },
          required: ['query'],
        },
        output: {
          schema: { type: 'string' },
          // 第一个参数是 arguments，第二个才是执行结果；写成单参数会拿到 args
          render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value ?? '') }],
        },
        async execute(args: unknown, exec: unknown) {
          const query = String((args as { query?: unknown } | undefined)?.query ?? '').trim()
          if (query === '') return '请给出 query：你想做什么。'
          const rawLimit = Number((args as { limit?: unknown } | undefined)?.limit)
          const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20) : 8
          const agent = (exec as { agent?: unknown } | undefined)?.agent
          const sessionId = typeof (agent as { session?: { id?: unknown } } | undefined)?.session?.id === 'string'
            ? String((agent as { session: { id: string } }).session.id)
            : ''
          /*
           * 工具表从调用方 agent 的作用域读（含 preset 挂载的 agent 层工具）；
           * 拿不到时退回 global 视图——MCP 工具注册在 global 层，退回去也仍能检索到。
           */
          let schemas: readonly unknown[] = []
          try {
            const scopedSchemas = tools.schemas?.(agent)
            if (Array.isArray(scopedSchemas)) schemas = scopedSchemas
            else {
              const globalSchemas = tools.schemas?.()
              if (Array.isArray(globalSchemas)) schemas = globalSchemas
            }
          } catch {
            schemas = []
          }
          const hits = searchPool(schemas as never, query, { ...DEFAULT_RETRIEVAL, enabled: retrievalEnabled }, limit)
          if (hits.length === 0) {
            return `没有找到与「${query}」匹配的可检索工具。可能本会话没有连接这类 MCP server，或者换个说法（例如直接说工具名）。`
          }
          if (sessionId !== '') for (const hit of hits) pinTool(sessionId, hit.name)
          const lines = hits.map((hit) => `- ${hit.name}：${String(hit.description ?? '').trim().slice(0, 120)}`)
          return [`找到 ${hits.length} 个，下一步它们会出现在你的工具列表里，直接调用即可：`, ...lines].join('\n')
        },
      }
      if (typeof scoped.effect === 'function') scoped.effect(() => tools.register!(definition), 'dsh-seeker-bot: search_tools')
      else tools.register(definition)
    })
  } catch (error) {
    ctx.logger?.warn?.(
      `[tool-retrieval] search_tools 注册失败（模型只能用自动注入的工具）: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * 装配按需注入。在 host 的 apply 同步路径上调用一次即可。
 *
 * @param ctx host 上下文（只需 `on` 与 `logger`）。
 * @param options 装配选项。
 */
export function applyToolRetrieval(ctx: RetrievalHostContext, options: RetrievalApplyOptions = {}): void {
  if (options.enabled === false) retrievalEnabled = false
  const config: RetrievalConfig = {
    ...DEFAULT_RETRIEVAL,
    ...options.config,
    enabled: retrievalEnabled && (options.config?.enabled ?? true),
  }

  if (typeof ctx?.on !== 'function') {
    ctx?.logger?.warn?.('[tool-retrieval] ctx.on unavailable: MCP 按需注入未启用（工具全量注入）')
    return
  }

  try {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next()
      if (result === null || typeof result !== 'object') return result
      if (!retrievalEnabled) return result

      const agent = (context as { agent?: unknown } | undefined)?.agent
      if (agent === undefined || agent === null) return result

      /*
       * 状态按会话 id 隔离。拿不到会话 id 时原样放行：用空串当 key 会让所有
       * agent 共享一份意图，一个会话的搜索把另一个会话的工具集改掉——比不省
       * token 严重得多。
       */
      const session = (agent as { session?: { id?: unknown } }).session
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (sessionId === '') return result

      /*
       * 意图来源优先级：
       * 1. 会话历史里的最近用户消息（Work 与 Bot 都适用，且总是最新）；
       * 2. 没有历史（首轮组装）时，用 `noteQuery` 预先记下的原话（Bot 的
       *    runBotTurn 会在 followup 之前记一条）。
       *
       * 两者都空时 `projectTools` 会原样放行——「没有意图」不等于「什么都不需要」。
       */
      const sessionQuery = readSessionQuery(session)
      if (sessionQuery !== '') noteQuery(sessionId, sessionQuery)
      else if (retrievalState(sessionId).tokenCount === 0) return result

      const projection = projectTools(
        {
          tools: Array.isArray((result as { tools?: unknown }).tools) ? (result as { tools: never[] }).tools : [],
          sections: Array.isArray((result as { sections?: unknown }).sections) ? (result as { sections: never[] }).sections : [],
        },
        sessionId,
        config,
      )
      if (projection.removed.length === 0) return result
      return {
        ...(result as Record<string, unknown>),
        tools: projection.tools,
        sections: projection.sections,
      }
    })
    ctx.logger?.info?.(
      `[tool-retrieval] MCP 按需注入已启用（每轮最多 ${config.maxRetrieved} 个、每组最多 ${config.maxPerGroup} 个）`,
    )
  } catch (error) {
    ctx.logger?.warn?.(
      `[tool-retrieval] 装配失败，MCP 工具将全量注入: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    )
  }

  /*
   * 兜底检索工具独立装配：它注册到 global 层，与上面的组装钩子是两回事，
   * 任何一侧失败都不该拖垮另一侧（钩子挂了仍然全量注入，工具挂了仍然自动检索）。
   */
  if (retrievalEnabled) registerSearchTool(ctx)
}
