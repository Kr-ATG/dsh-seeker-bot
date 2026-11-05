/**
 * dsh-memory HTTP API（loopback-only）：/api/dsh-memory/*。
 * 面板数据 + 裁决操作（保留/删除/改标签/移项目/置顶/手动归属）。
 * 与 skill-manager 同款 webServer 路由模式；前缀 /api/dsh-memory 不与其它插件冲突。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { rejectCrossSite } from '../../shared/csrf.ts'
import { applyConfigOverrides, DEFAULT_CONFIG, publicConfig, type ConsolidateResult, type MemoryConfig, type MemoryEntry, type MemoryKind, type MemoryOwner, type OwnerFilter } from './types.js'
import { compileAll } from './engine/compile.js'
import { consolidateAll, consolidateScope } from './engine/consolidate.js'
import { searchEntries } from './engine/retrieval.js'
import { isDeletableToday, isWorkspacePathAlive, localDate, matchesOwner, mergeTags, nowIso, ownerOf, projectHashOf, entryIdOf, summarize, type MemoryStore } from './engine/store.js'

/** Minimal service-shaped view of the webserver route register. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void
      }): () => void
    }
  }
}

const ROUTE_PREFIX = '/api/dsh-memory'

/** 面板条目视图（含 schema v2 元数据：版本 / 置信度 / 确认态 / 类型 / 命中时间）。 */
interface EntryView {
  id: string
  content: string
  scope: 'global' | 'project'
  projectHash: string | null
  /**
   * 归属主体（schema v6）：`work` 或 `bot:<botId>`。
   *
   * 面板据此区分「这条是谁的记忆」——主 Bot 的资料库要列出全部子 Bot 并标注来源，
   * 子 Bot 的资料库只列自己的。缺省语义仍是 `work`，由 `ownerOf()` 统一兜底。
   */
  owner: MemoryOwner
  tags: string[]
  pinned: boolean
  /** true = 已禁用（保留但不参与注入/编译）。 */
  disabled: boolean
  /** true = 已软废弃（retire / revise）。 */
  deprecated: boolean
  importance: number
  layer: 'short' | 'long'
  source: 'extract' | 'manual' | 'bot-working-memory'
  createdAt: string
  updatedAt: string
  /** 条目级版本号（每次内容变更 +1）。 */
  version: number
  /** 置信度 0-1（手动记忆=1）。 */
  confidence: number
  /** 用户是否已显式确认。 */
  verified: boolean
  /** 记忆类型。 */
  kind: MemoryKind
  /** 上次注入命中时间（null=从未命中）。 */
  lastHitAt: string | null
  /** 溯源：产生/最近更新该条目的会话（KR 记忆卡「本会话新增」判定用；旧 host 可能缺省）。 */
  provenance?: { sessionId?: string; turn?: number; userMessageId?: string; snippet?: string }
  /** 待确认（true = 自动抽取但用户尚未确认，不参与检索/注入）。缺省 = 已生效。 */
  pending?: boolean
  /** 进入待确认状态的时间 ISO。 */
  pendingAt?: string
}

/**
 * 解析 API 传入的 owner 过滤值：只认 `work` / `bots` / `bot:<id>`。
 *
 * 非法值一律当作「不传」而不是报错：旧调用方、面板的空串、将来的新字段都可能
 * 出现在这里，静默不过滤的后果只是范围大了（还能救），而抛 400 会让整条操作
 * 直接失败（用户点了「删除今日」什么也没发生，却看不出原因）。
 */
function parseOwnerFilter(value: unknown): OwnerFilter | undefined {
  if (value === 'work' || value === 'bots') return value
  if (typeof value === 'string' && value.startsWith('bot:') && value.length > 4) return value as MemoryOwner
  return undefined
}

/** MemoryKind 取值校验（/update 的 kind 字段）。 */
function isMemoryKindValue(value: unknown): value is MemoryKind {
  return value === 'identity' || value === 'preference' || value === 'fact'
    || value === 'decision' || value === 'gotcha' || value === 'session-summary'
}

function toView(entry: MemoryEntry): EntryView {
  return {
    id: entry.id,
    content: entry.content,
    scope: entry.scope,
    projectHash: entry.projectHash,
    owner: ownerOf(entry),
    tags: entry.tags,
    pinned: entry.pinned,
    disabled: entry.disabled === true,
    deprecated: entry.deprecated === true,
    importance: entry.importance,
    layer: entry.layer,
    source: entry.source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    version: entry.version,
    confidence: entry.confidence,
    verified: entry.verified,
    kind: entry.kind,
    lastHitAt: entry.lastHitAt,
    provenance: entry.provenance,
    // 待确认（v5）：缺省的「已生效」不写进回包，前端按 undefined 处理，
    // 与落盘口径一致（未挂起的条目不占字段）。
    ...(entry.pending === true
      ? { pending: true as const, pendingAt: entry.pendingAt }
      : {}),
  }
}

/** 挂载全部路由。 */
export function mountMemoryRoutes(
  ctx: Context,
  store: MemoryStore,
  config: MemoryConfig,
): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      void handle(ctx, store, config, req, res)
    },
  })
}

async function handle(
  ctx: Context,
  store: MemoryStore,
  config: MemoryConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!loopbackAllowed(req)) {
    json(res, 403, { error: 'loopback-only' })
    return
  }
  // 跨站闸门：loopbackAllowed 只看来源 IP 与 Host，浏览器跨站请求两者都满足，
  // 挡不住 CSRF（实测跨站 POST /delete-today 能真删掉今日记忆）。见 shared/csrf.ts。
  if (rejectCrossSite(req.headers as Record<string, unknown>, (status, payload) => {
    json(res, status, payload)
  })) return
  let url: URL
  let rest: string
  let method: string
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
    rest = url.pathname.slice(ROUTE_PREFIX.length)
    method = req.method ?? 'GET'
  } catch {
    json(res, 400, { error: 'invalid request url' })
    return
  }
  // API 诊断日志（仅 logApiRequests 开启时记录，默认关闭防日志膨胀）。
  const apiStarted = Date.now()
  if (config.logApiRequests) void store.appendApiLog(`${method} ${rest} start`).catch(() => undefined)
  try {
    // ── 查询 ──────────────────────────────────────────────────────────
    if (method === 'GET' && rest === '/list') {
      json(res, 200, await listView(store, url.searchParams))
      return
    }
    if (method === 'GET' && rest === '/related') {
      // 相关记忆：以目标条目内容为 query 走同一套 hybrid 检索（详情面板
      // 「相关记忆」区）。排除自身与已废弃；结果截断到 limit（1-8，默认 3）。
      const entryId = url.searchParams.get('entryId') ?? ''
      const limitRaw = Number(url.searchParams.get('limit') ?? '3')
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(8, Math.round(limitRaw))) : 3
      const entries = await store.readEntries()
      const source = entries.find(entry => entry.id === entryId)
      if (source === undefined) {
        json(res, 200, { entries: [] })
        return
      }
      const matches = searchEntries(
        source.content,
        entries.filter(entry => entry.id !== entryId && entry.deprecated !== true),
        'hybrid',
      ).slice(0, limit)
      json(res, 200, { entries: matches.map(match => toView(match.entry)) })
      return
    }
    if (method === 'GET' && rest === '/projects') {
      const entries = await store.readEntries()
      json(res, 200, { projects: await mergeWorkspaces(store, await store.listProjects(entries)) })
      return
    }
    if (method === 'GET' && rest === '/tags') {
      const entries = await store.readEntries()
      const counts = new Map<string, number>()
      // 已软废弃的条目不贡献分类计数：否则「删除的记忆」仍挂在分类数字上。
      for (const entry of entries) {
        if (entry.deprecated === true) continue
        for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
      json(res, 200, { tags: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })) })
      return
    }
    if (method === 'GET' && rest === '/changes') {
      // date=all → 全部历史变更（面板「变更」Tab 的「全部」筛选）；缺省=当日。
      const raw = url.searchParams.get('date')
      const changes = raw === 'all' ? await store.readChanges() : await store.readChanges(raw ?? localDate())
      json(res, 200, {
        date: raw ?? localDate(),
        changes: changes.sort((a, b) => b.at.localeCompare(a.at)),
      })
      return
    }
    if (method === 'GET' && rest === '/summary') {
      const entries = await store.readEntries()
      const today = localDate()
      json(res, 200, {
        today,
        entryCount: entries.filter(entry => entry.deprecated !== true).length,
        // 与面板项目列表同源（含零记忆的 DSH 工作区），否则「全部项目 N」
        // 和下面列出的项目行数对不上。
        projectCount: (await mergeWorkspaces(store, await store.listProjects(entries))).length,
        todayChanges: (await store.readChanges(today)).length,
        changeCount: (await store.readChanges()).length,
        pinnedCount: entries.filter(entry => entry.pinned && entry.deprecated !== true).length,
        disabledCount: entries.filter(entry => entry.disabled === true).length,
        deprecatedCount: entries.filter(entry => entry.deprecated === true).length,
        longtermCount: entries.filter(entry => entry.layer === 'long' && entry.deprecated !== true).length,
        globalCount: entries.filter(entry => entry.scope === 'global' && entry.deprecated !== true).length,
      })
      return
    }

    // ── 运行时配置（面板设置；改动即时生效并持久化到 config.json） ─────
    if (method === 'GET' && rest === '/config') {
      json(res, 200, { config: publicConfig(config) })
      return
    }
    if (method === 'POST' && rest === '/config') {
      const body = await readBody(req) as Record<string, unknown>
      if (body.reset === true) {
        // 恢复默认：清空 config.json 覆盖层并把运行时配置写回默认值。
        applyConfigOverrides(config, DEFAULT_CONFIG)
        await store.writeConfig({})
        json(res, 200, { ok: true, config: publicConfig(config) })
        return
      }
      // 合并写：与已持久化的覆盖层合并后整体落盘。旧实现只写本次补丁，
      // 改第二个字段会冲掉第一个字段的覆盖，重启后回退默认值。
      const applied = applyConfigOverrides(config, body)
      await store.writeConfig({ ...store.readConfigSync(), ...applied })
      json(res, 200, { ok: true, config: publicConfig(config) })
      return
    }

    // ── 可用模型目录（整理模型下拉候选；registered + configurable 合并） ──
    if (method === 'GET' && rest === '/models') {
      const llm = ctx.get('llm') as
        | {
          listProviders?: () => Array<{ id: string; name?: string }>
          listConfigurableProviders?: () => Array<{ provider: string; name?: string }>
          listModels?: (provider: string) => Promise<Array<{ id: string }>>
        }
        | undefined
      const empty: { models: Array<{ provider: string; providerName: string; models: string[] }> } = { models: [] }
      if (llm === undefined) { json(res, 200, empty); return }
      const byId = new Map<string, string>()
      for (const provider of llm.listProviders?.() ?? []) byId.set(provider.id, provider.name ?? provider.id)
      for (const provider of llm.listConfigurableProviders?.() ?? []) {
        if (!byId.has(provider.provider)) byId.set(provider.provider, provider.name ?? provider.provider)
      }
      const models: Array<{ provider: string; providerName: string; models: string[] }> = []
      for (const [provider, providerName] of byId) {
        try {
          const infos = await llm.listModels?.(provider)
          const ids = (infos ?? []).map(info => info.id).filter(id => typeof id === 'string' && id !== '')
          if (ids.length > 0) models.push({ provider, providerName, models: ids })
        } catch {
          // 单 provider 目录不可用（未配置凭据/NO_ADAPTER）时跳过，不阻断其余目录。
        }
      }
      json(res, 200, { models })
      return
    }

    // ── 记忆注入开关（按会话 + 全局默认） ─────────────────────────────
    // explicit：该会话是否单独设置过（null = 跟随 config.injectDefaultEnabled）。
    if (method === 'GET' && rest === '/inject-state') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const defaultEnabled = config.injectDefaultEnabled !== false
      const explicit = await store.injectStateOf(sessionId)
      // 中文开关状态顺带回传：composer 那个开关每 hover 一次就重发一次
      // /inject-state（历史上打过一分钟 498 次的请求风暴），再加一个独立
      // GET 端点等于把翻倍的轮询量固化下来。合并回包，零新增请求。
      const zhEnabled = await store.isZhInjectEnabled(config.zhInjectDefaultEnabled !== false)
      // html 并进回包（同一理由：composer 的开关浮层一次 hover 就要知道全部通道的状态）。
      const htmlEnabled = await store.isHtmlInjectEnabled(config.htmlInjectDefaultEnabled !== false)
      // team 同理并进回包（同一理由：开关浮层一次 hover 要知道全部通道状态）。
      const teamEnabled = await store.isTeamInjectEnabled(config.teamInjectDefaultEnabled !== false)
      // 自动收口同理并进回包（同一理由：开关浮层一次 hover 要知道全部通道状态）。
      const todoClosureEnabled = await store.isTodoClosureEnabled(config.todoClosureDefaultEnabled !== false)
      // 任务清单纪律通道同理并进回包（同一理由：开关浮层一次 hover 要知道全部通道状态）。
      const todoRuleEnabled = await store.isTodoRuleInjectEnabled(config.todoRuleInjectDefaultEnabled !== false)
      // 动效技能通道同理并进回包（同一理由：开关浮层一次 hover 要知道全部通道状态）。
      const motionEnabled = await store.isMotionInjectEnabled(config.motionInjectDefaultEnabled !== false)
      // 通俗解释（ELI5）通道同理并进回包。
      const eli5Enabled = await store.isEli5InjectEnabled(config.eli5InjectDefaultEnabled !== false)
      /*
       * 工作区「项目记忆记录开关」一并回传（= 项目 meta 的 autoMemory，写入侧闸门）。
       *
       * 为什么挂在 /inject-state 而不是另开端点：这个开关的消费点是**大盘设置
       * 抽屉**，而抽屉本来就在读这份回包。另开一个 GET 等于让抽屉每次打开都多发
       * 一个请求（composer 那张卡已经打过一分钟 498 次的请求风暴，教训在先）。
       *
       * cwd 缺失/空白一律走 null 三件套，**不**凭空造项目：`projectMemoryEnabled:
       * null` 的语义是「不知道是哪个工作区」，UI 据此不渲染开关 —— 拨不动的开关
       * 是骗人（也解释了为什么这里不像 config 那样给个默认 true 兜底）。
       * cwd 存在时先用 projectHashOf 派生 hash，再读真实 meta，因此「没有 meta.json
       * 的新工作区」会如实回 true（默认开），而不是回 null。
       */
      const workspaceCwd = (url.searchParams.get('cwd') ?? '').trim()
      const projectHash = workspaceCwd === '' ? null : projectHashOf(workspaceCwd)
      const projectMemoryEnabled = projectHash === null
        ? null
        : await store.isAutoMemoryEnabled(projectHash)
      json(res, 200, {
        enabled: explicit ?? defaultEnabled,
        defaultEnabled,
        explicit,
        // 与 GET 同名同义，客户端读的是同一份字段（写回包见下面的 POST 分支）。
        projectHash,
        projectPath: projectHash === null ? null : workspaceCwd,
        projectMemoryEnabled,
        zhEnabled,
        htmlEnabled,
        teamEnabled,
        todoClosureEnabled,
        todoRuleEnabled,
        motionEnabled,
        eli5Enabled,
      })
      return
    }
    if (method === 'POST' && rest === '/inject-state') {
      const body = await readBody(req) as Record<string, unknown>
      const sessionId = requireString(body.sessionId, 'sessionId')
      // enabled=null → 清除本会话覆盖（面板「跟随默认」按钮）。
      const enabled = body.enabled === null ? null : body.enabled !== false
      await store.setInjectEnabled(sessionId, enabled)
      const defaultEnabled = config.injectDefaultEnabled !== false
      /*
       * 工作区「项目记忆记录开关」（可选字段）：本端点回包与 GET 同名同义，
       * 所以两个请求共用一份字段推导。
       *
       * **两个字段互不干扰**：只传 enabled 时下面整段是空转，行为与加字段前逐字
       * 一致（注入开关是**读取**侧、每会话；项目记忆开关是**写入**侧、每工作区）。
       *
       * 写侧要求 `projectMemory` 是 boolean 且 cwd 非空 —— 没有工作区就不知道写
       * 哪个项目，静默忽略（不报错）：把一个「关掉当前工作区记录」的意图落到
       * 某个凭空造出来的项目上，比什么都不做更糟。
       */
      const workspaceCwd = (typeof body.cwd === 'string' ? body.cwd : '').trim()
      if (typeof body.projectMemory === 'boolean' && workspaceCwd !== '') {
        const hash = projectHashOf(workspaceCwd)
        const meta = await store.readProjectMeta(hash)
        // 读旧 meta → 只覆盖 autoMemory。整份 replace 会顺手抹掉 path / alias /
        // locked / injectExcluded（改名、锁定归属、排除注入全丢），所以这里必须
        // 展开旧值。meta 不存在时按 /remember 那套建一份最小 meta（含 path）：
        // 新工作区第一次关开关就得能关掉，不能因为「目录里还没有 meta.json」静默失败。
        await store.writeProjectMeta(hash, meta === undefined
          ? { path: workspaceCwd, alias: null, locked: false, autoMemory: body.projectMemory }
          : { ...meta, autoMemory: body.projectMemory })
      }
      // 回读真实值（不是回显请求里的意图值）：写失败/被别的路径改掉时，客户端
      // 立刻能看出开关没落盘，而不是乐观更新后一直显示错的。
      const projectHash = workspaceCwd === '' ? null : projectHashOf(workspaceCwd)
      const projectMemoryEnabled = projectHash === null
        ? null
        : await store.isAutoMemoryEnabled(projectHash)
      json(res, 200, {
        ok: true,
        enabled: enabled ?? defaultEnabled,
        defaultEnabled,
        explicit: enabled !== null,
        projectHash,
        projectPath: projectHash === null ? null : workspaceCwd,
        projectMemoryEnabled,
      })
      return
    }

    // ── 中文记忆独立注入开关（内置能力，全局单值） ─────────────────────
    // builtin:true 恒定回传——这个能力硬编码在插件里，没有卸载/移除入口，
    // 前端据此显示「内置」标记，且不提供任何删除该能力的操作。
    if (method === 'GET' && rest === '/zh-inject-state') {
      const enabled = await store.isZhInjectEnabled(config.zhInjectDefaultEnabled !== false)
      json(res, 200, { enabled, builtin: true })
      return
    }
    if (method === 'POST' && rest === '/zh-inject-state') {
      const body = await readBody(req) as Record<string, unknown>
      const enabled = body.enabled !== false
      await store.setZhInjectEnabled(enabled)
      json(res, 200, { ok: true, enabled, builtin: true })
      return
    }

    // ── 对话内流程图注入开关端点已移除（2026-10-09）──────────────────────
    // /diagram-inject-state GET/POST 随通道一起删除。图形能力改由 iu kind
    // （graph/arch/sequence）承接，注入文档随 html 通道走（默认开）。
    // 旧前端缓存若仍请求该路径会 404——开关行已同步移除，不会再发。

    // ── 对话内 HTML 卡片规范注入开关（内置能力，全局单值） ─────────────
    // builtin:true 恒定回传——这个能力硬编码在插件里，没有卸载/移除入口，
    // 前端据此显示「内置」标记，且不提供任何删除该能力的操作。
    if (method === 'GET' && rest === '/html-inject-state') {
      const enabled = await store.isHtmlInjectEnabled(config.htmlInjectDefaultEnabled !== false)
      json(res, 200, { enabled, builtin: true })
      return
    }
    if (method === 'POST' && rest === '/html-inject-state') {
      const body = await readBody(req) as Record<string, unknown>
      const enabled = body.enabled !== false
      await store.setHtmlInjectEnabled(enabled)
      json(res, 200, { ok: true, enabled, builtin: true })
      return
    }

    // ── 团队协作规范注入开关（内置能力，全局单值） ─────────────────────
    // 与 html 端点同构，builtin:true 恒定——同样硬编码在插件里，无卸载入口。
    if (method === 'GET' && rest === '/team-inject-state') {
      const enabled = await store.isTeamInjectEnabled(config.teamInjectDefaultEnabled !== false)
      json(res, 200, { enabled, builtin: true })
      return
    }
    if (method === 'POST' && rest === '/team-inject-state') {
      const body = await readBody(req) as Record<string, unknown>
      const enabled = body.enabled !== false
      await store.setTeamInjectEnabled(enabled)
      json(res, 200, { ok: true, enabled, builtin: true })
      return
    }

    // ── 回合结束自动收口开关（内置能力，全局单值） ─────────────────────
    // 与上面几个开关同构，builtin:true 恒定——收口逻辑硬编码在插件里（无卸载
    // 入口），只有「开/关」这一种操作。默认开，因此缺字段时按 !== false 兜底。
    if (method === 'GET' && rest === '/todo-closure-state') {
      const enabled = await store.isTodoClosureEnabled(config.todoClosureDefaultEnabled !== false)
      json(res, 200, { enabled, builtin: true })
      return
    }
    if (method === 'POST' && rest === '/todo-closure-state') {
      const body = await readBody(req) as Record<string, unknown>
      const enabled = body.enabled !== false
      await store.setTodoClosureEnabled(enabled)
      json(res, 200, { ok: true, enabled, builtin: true })
      return
    }

    // ── 任务清单纪律规范注入开关（内置能力，全局单值） ────────────────
    // 与 html / team 端点同构，builtin:true 恒定——同样硬编码在插件里，无卸载入口。
    // 2026-10-28 由 /step-inject-state 改名：step 纪律通道整条退役，这条纪律独立。
    if (method === 'GET' && rest === '/todo-rule-inject-state') {
      const enabled = await store.isTodoRuleInjectEnabled(config.todoRuleInjectDefaultEnabled !== false)
      json(res, 200, { enabled, builtin: true })
      return
    }
    if (method === 'POST' && rest === '/todo-rule-inject-state') {
      const body = await readBody(req) as Record<string, unknown>
      const enabled = body.enabled !== false
      await store.setTodoRuleInjectEnabled(enabled)
      json(res, 200, { ok: true, enabled, builtin: true })
      return
    }

    // ── 动效技能强制加载开关（内置能力，全局单值） ────────────────────
    // 与 team / todo-rule 端点同构，builtin:true 恒定——通道硬编码在插件里，无卸载入口。
    // 与其余通道的差别只在默认值：这条**默认关**（升级不改变现状），因此回包缺字段时
    // 客户端按 === true 兜底（见 client/triad/memory/Toggle.tsx 的 normalizeInjectState）。
    if (method === 'GET' && rest === '/motion-inject-state') {
      const enabled = await store.isMotionInjectEnabled(config.motionInjectDefaultEnabled !== false)
      json(res, 200, { enabled, builtin: true })
      return
    }
    if (method === 'POST' && rest === '/motion-inject-state') {
      const body = await readBody(req) as Record<string, unknown>
      const enabled = body.enabled === true
      await store.setMotionInjectEnabled(enabled)
      json(res, 200, { ok: true, enabled, builtin: true })
      return
    }

    // ── 通俗解释（ELI5 模式）规范注入开关（内置能力，全局单值） ─────────
    if (method === 'GET' && rest === '/eli5-inject-state') {
      const enabled = await store.isEli5InjectEnabled(config.eli5InjectDefaultEnabled !== false)
      json(res, 200, { enabled, builtin: true })
      return
    }
    if (method === 'POST' && rest === '/eli5-inject-state') {
      const body = await readBody(req) as Record<string, unknown>
      const enabled = body.enabled === true
      await store.setEli5InjectEnabled(enabled)
      json(res, 200, { ok: true, enabled, builtin: true })
      return
    }

    // ── 裁决操作 ──────────────────────────────────────────────────────
    if (method === 'POST' && rest === '/pin') {
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const pinned = body.pinned !== false
      const entry = await store.patchEntry(entryId, { pinned })
      if (entry === undefined) throw new Error(`记忆不存在：${entryId}`)
      // 不写变更流：变更流驱动入口未读 badge，用户自己点置顶不该给自己刷未读。
      // 但产物要跟上（pinned.md / 注入常驻集合按 pinned 取）。
      await compileAll(store, config)
      json(res, 200, { ok: true, entry: toView(entry) })
      return
    }
    if (method === 'POST' && rest === '/verify') {
      // 显式确认 / 取消确认。patchEntry 不再「编辑即确认」（见 store.patchEntry 注释），
      // 于是 verified=true 只剩这一个入口 —— 没有它，自动提取的条目永远带着
      // 〔待确认〕标记，用户既认可不了也清不掉。
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const verified = body.verified !== false
      const entry = await store.patchEntry(entryId, { verified })
      if (entry === undefined) throw new Error(`记忆不存在：${entryId}`)
      await store.appendChange({
        action: 'update',
        entryId: entry.id,
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: `${verified ? '已确认' : '已取消确认'}：${summarize(entry.content)}`,
      })
      // 与 /pin 同口径：不写变更流（元数据微调不刷未读），但统一走 compileAll 收口。
      await compileAll(store, config)
      json(res, 200, { ok: true, entry: toView(entry) })
      return
    }
    if (method === 'POST' && rest === '/enable') {
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const enabled = body.enabled !== false
      const existing = await store.getEntry(entryId)
      if (existing === undefined) throw new Error(`记忆不存在：${entryId}`)
      const entry = await store.patchEntry(entryId, { disabled: !enabled })
      if (entry === undefined) throw new Error(`记忆不存在：${entryId}`)
      await store.appendChange({
        action: 'update',
        entryId: entry.id,
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: `${enabled ? '启用' : '禁用'}：${summarize(entry.content)}`,
      })
      await compileAll(store, config)
      json(res, 200, { ok: true, entry: toView(entry) })
      return
    }
    if (method === 'POST' && rest === '/update') {
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>> = {}
      if (typeof body.content === 'string' && body.content.trim() !== '') {
        patch.content = body.content.trim()
      }
      if (Array.isArray(body.tags)) {
        patch.tags = body.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').map(tag => tag.trim()).slice(0, 8)
      }
      // 重要度 / 置顶 / 类型 / 层：面板编辑区可直接改（此前只能改内容与标签）。
      //
      // 上界统一为 10（/revise、/remember、模型工具、提取侧全是 1-10）。这里原本是
      // 20，唯一来源是「注入命中加分」这条内部路径会临时把分数顶到 20 封顶；那是
      // 引擎内部行为，不该反过来放宽用户输入的合法区间，否则面板能存进 18 分，
      // 而所有其它入口都把它钳回 10，同一个字段两种口径。
      //
      // 保留一位小数（不取整）：命中加分会产生 9.62 这类值，面板只是编辑内容时
      // 不该顺手把它的精度抹平。
      if (typeof body.importance === 'number' && Number.isFinite(body.importance)) {
        patch.importance = Math.max(1, Math.min(10, Math.round(body.importance * 10) / 10))
      }
      if (typeof body.pinned === 'boolean') patch.pinned = body.pinned
      if (isMemoryKindValue(body.kind)) patch.kind = body.kind
      if (body.layer === 'short' || body.layer === 'long') patch.layer = body.layer
      const before = await store.getEntry(entryId)
      const entry = await store.patchEntry(entryId, patch)
      if (entry === undefined) throw new Error(`记忆不存在：${entryId}`)
      await store.appendChange({
        action: 'update',
        entryId: entry.id,
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: summarize(entry.content),
        before: before?.content,
        after: entry.content,
      })
      await compileAll(store, config)
      json(res, 200, { ok: true, entry: toView(entry) })
      return
    }
    if (method === 'POST' && rest === '/move') {
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const existing = await store.getEntry(entryId)
      if (existing === undefined) throw new Error(`记忆不存在：${entryId}`)
      let scope: 'global' | 'project' = existing.scope
      let projectHash: string | null = existing.projectHash
      if (body.scope === 'global') {
        scope = 'global'
        projectHash = null
      } else if (body.scope === 'project') {
        scope = 'project'
        const rawHash = typeof body.projectHash === 'string' ? body.projectHash.trim() : ''
        const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
        // 12 位 hex 视为项目 hash；否则当作 workspace 路径派生 hash
        // （旧实现把路径原样当 hash 存，会造出以路径为目录名的伪项目）。
        projectHash = /^[0-9a-f]{12}$/i.test(rawHash)
          ? rawHash.toLowerCase()
          : rawHash !== ''
            ? projectHashOf(rawHash)
            : rawPath !== ''
              ? projectHashOf(rawPath)
              : existing.projectHash
        if (projectHash === null) throw new Error('移入项目需要 projectHash 或 path')
        // 目标项目无 meta 时自动创建占位（手动归属）。
        const meta = await store.readProjectMeta(projectHash)
        if (meta === undefined) {
          const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
          const rawHash = typeof body.projectHash === 'string' ? body.projectHash.trim() : ''
          const path = rawPath !== '' ? rawPath : (/^[0-9a-f]{12}$/i.test(rawHash) ? '手动归属' : rawHash)
          await store.writeProjectMeta(projectHash, {
            path: path === '' ? '手动归属' : path,
            alias: null,
            locked: true,
          })
        }
      }
      const entry = await store.patchEntry(entryId, { scope, projectHash })
      if (entry === undefined) throw new Error(`记忆不存在：${entryId}`)
      await store.appendChange({
        action: 'update',
        entryId: entry.id,
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: `移项目：${summarize(entry.content)}`,
        before: existing.content,
        after: entry.content,
      })
      await compileAll(store, config)
      json(res, 200, { ok: true, entry: toView(entry) })
      return
    }
    if (method === 'POST' && rest === '/delete') {
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const existing = await store.getEntry(entryId)
      // 幂等删除：条目已不存在时也返回 ok（面板旧数据/幽灵条目删除不再报错）。
      if (existing === undefined) {
        json(res, 200, { ok: true, alreadyGone: true })
        return
      }
      const ok = await store.removeEntry(entryId)
      if (!ok) {
        json(res, 200, { ok: true, alreadyGone: true })
        return
      }
      // 删除路径：条目已从数组移除，反查不到 owner，必须用删除前的快照显式传入。
      await store.appendChange({
        action: 'delete',
        entryId,
        owner: ownerOf(existing),
        scope: existing.scope,
        projectHash: existing.projectHash,
        summary: `删除：${summarize(existing.content)}`,
      })
      await compileAll(store, config)
      json(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && rest === '/delete-batch') {
      // 批量删除（面板多选）：一次事务删完再编译一次产物。
      const body = await readBody(req) as Record<string, unknown>
      const ids = Array.isArray(body.entryIds)
        ? body.entryIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
        : []
      if (ids.length === 0) throw new Error('entryIds 不能为空')
      const wanted = new Set(ids)
      const removed = await store.mutateEntries(entries => {
        const targets = entries.filter(entry => wanted.has(entry.id))
        for (const target of targets) entries.splice(entries.indexOf(target), 1)
        return targets
      })
      for (const entry of removed) {
        await store.appendChange({
          action: 'delete',
          entryId: entry.id,
          // 删除路径：同上，用 mutateEntries 返回的条目快照显式带出归属。
          owner: ownerOf(entry),
          scope: entry.scope,
          projectHash: entry.projectHash,
          summary: `删除：${summarize(entry.content)}`,
          before: entry.content,
        })
      }
      await compileAll(store, config)
      json(res, 200, { ok: true, deleted: removed.length, missing: ids.length - removed.length })
      return
    }
    if (method === 'POST' && rest === '/delete-today') {
      // 一键删除「今日记忆」：更新时间（缺省按创建时间）落在本地今天、未置顶
      // 且未废弃的条目（口径与面板「今天」分组一致）。可选 scope/projectHash
      // 收窄范围（缺省=全局+全部项目）。置顶是用户显式标记的重要条目，批量
      // 删除时跳过（与 /delete-project 同款豁免）。
      //
      // 可选 owner（2026-11 补）：面板在某个 Bot 的视图里点「删除今日」，只该删
      // 这个归属的今日条目——不加这道过滤会把 Work 与所有 Bot 的今日记忆一起清掉。
      // 语义与 GET /list 一致（`bots` = 所有 Bot），不传 = 不过滤（旧行为不变）。
      const body = await readBody(req) as Record<string, unknown>
      const scope = body.scope === 'global' || body.scope === 'project' ? body.scope : undefined
      const projectHash = typeof body.projectHash === 'string' && body.projectHash.trim() !== ''
        ? body.projectHash.trim()
        : undefined
      const owner = parseOwnerFilter(body.owner)
      const today = localDate()
      const removed = await store.mutateEntries(entries => {
        // 判定收在 store.isDeletableToday 里：唯一判据，回归测试直接断言它。
        const targets = entries.filter(entry => isDeletableToday(entry, { today, scope, projectHash, owner }))
        for (const target of targets) entries.splice(entries.indexOf(target), 1)
        return targets
      })
      for (const entry of removed) {
        await store.appendChange({
          action: 'delete',
          entryId: entry.id,
          // 删除路径：同上，用 mutateEntries 返回的条目快照显式带出归属。
          owner: ownerOf(entry),
          scope: entry.scope,
          projectHash: entry.projectHash,
          summary: `删除今日：${summarize(entry.content)}`,
          before: entry.content,
        })
      }
      await compileAll(store, config)
      json(res, 200, { ok: true, deleted: removed.length })
      return
    }
    if (method === 'POST' && rest === '/revise') {
      // 修订：软废弃旧条目 + 写入后继条目（opencontext oc_memory_revise 语义）。
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      if (content === '') throw new Error('content 不能为空')
      const target = await store.getEntry(entryId)
      if (target === undefined) throw new Error(`记忆不存在：${entryId}`)
      const result = await store.reviseEntry({
        id: entryId,
        content,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        tags: Array.isArray(body.tags)
          ? body.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').map(tag => tag.trim()).slice(0, 8)
          : undefined,
        importance: typeof body.importance === 'number' && Number.isFinite(body.importance)
          ? Math.max(1, Math.min(10, Math.round(body.importance)))
          : undefined,
      })
      if (result === undefined) throw new Error(`记忆不存在或已废弃：${entryId}`)
      await store.appendChange({
        action: 'revise',
        entryId: result.deprecatedId,
        scope: target.scope,
        projectHash: target.projectHash,
        summary: `修订为：${summarize(result.entry.content)}`,
        before: target.content,
        after: result.entry.content,
      })
      await compileAll(store, config)
      json(res, 200, {
        ok: true,
        deprecatedId: result.deprecatedId,
        newId: result.newId,
        entry: toView(result.entry),
      })
      return
    }
    if (method === 'POST' && rest === '/retire') {
      // 软废弃：数据保留但退出检索/注入/编译。
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const entry = await store.retireEntry(entryId, typeof body.reason === 'string' ? body.reason : undefined)
      if (entry === undefined) throw new Error(`记忆不存在：${entryId}`)
      await store.appendChange({
        action: 'retire',
        entryId: entry.id,
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: `废弃：${summarize(entry.content)}`,
        before: entry.content,
      })
      await compileAll(store, config)
      json(res, 200, { ok: true, entry: toView(entry) })
      return
    }
    if (method === 'POST' && rest === '/confirm') {
      // 确认一条待确认记忆：清 pending + 置 verified，此后参与注入与检索。
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const entry = await store.confirmPending(entryId)
      if (entry === undefined) throw new Error(`记忆不存在：${entryId}`)
      await store.appendChange({
        action: 'update',
        entryId: entry.id,
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: `确认生效：${summarize(entry.content)}`,
        after: entry.content,
      })
      await compileAll(store, config)
      json(res, 200, { ok: true, entry: toView(entry) })
      return
    }
    if (method === 'POST' && rest === '/reject') {
      // 拒绝待确认记忆：直接硬删（它从未生效，留回收站记录只是垃圾）。
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const entry = await store.rejectPending(entryId)
      if (entry === undefined) {
        const existing = await store.getEntry(entryId)
        if (existing === undefined) throw new Error(`记忆不存在：${entryId}`)
        throw new Error('该记忆不是待确认状态，拒绝操作被忽略（要删除已生效记忆请用 /delete）')
      }
      // 拒绝是硬删（rejectPending 已把条目摘出数组）：归属只能从返回的条目上取。
      await store.appendChange({
        action: 'delete',
        entryId: entry.id,
        owner: ownerOf(entry),
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: `拒绝待确认：${summarize(entry.content)}`,
        before: entry.content,
      })
      await compileAll(store, config)
      json(res, 200, { ok: true })
      return
    }
    if (method === 'GET' && rest === '/pending') {
      // 待确认列表：面板「待确认」页签的数据源。
      const pending = await store.listPending()
      json(res, 200, { ok: true, entries: pending.map(toView), total: pending.length })
      return
    }
    if (method === 'POST' && rest === '/restore') {
      // 复活已废弃条目（undo retire / undo revise 后继侧）。
      const body = await readBody(req) as Record<string, unknown>
      const entryId = requireString(body.entryId, 'entryId')
      const entry = await store.restoreEntry(entryId)
      if (entry === undefined) throw new Error(`记忆不存在：${entryId}`)
      await store.appendChange({
        action: 'update',
        entryId: entry.id,
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: `恢复：${summarize(entry.content)}`,
        after: entry.content,
      })
      await compileAll(store, config)
      json(res, 200, { ok: true, entry: toView(entry) })
      return
    }
    if (method === 'POST' && rest === '/meta') {
      const body = await readBody(req) as Record<string, unknown>
      const hash = requireString(body.projectHash, 'projectHash')
      const meta = await store.readProjectMeta(hash)
      const next = {
        path: meta?.path ?? (typeof body.path === 'string' && body.path !== '' ? body.path : '手动归属'),
        alias: typeof body.alias === 'string'
          ? (body.alias.trim() === '' ? null : body.alias.trim().slice(0, 64))
          : (meta?.alias ?? null),
        locked: typeof body.locked === 'boolean' ? body.locked : (meta?.locked ?? true),
        autoMemory: typeof body.autoMemory === 'boolean' ? body.autoMemory : (meta?.autoMemory ?? true),
        injectExcluded: typeof body.injectExcluded === 'boolean' ? body.injectExcluded : (meta?.injectExcluded ?? false),
      }
      await store.writeProjectMeta(hash, next)
      json(res, 200, { ok: true, meta: { ...next, hash } })
      return
    }
    if (method === 'POST' && rest === '/delete-project') {
      // 按项目清空全部记忆（仅项目层；全局层不动）。
      // 置顶记忆是用户明确标记的重要条目，批量清空时跳过，避免误删。
      const body = await readBody(req) as Record<string, unknown>
      const projectHash = requireString(body.projectHash, 'projectHash')
      const removed = await store.mutateEntries(entries => {
        const targets = entries.filter(entry =>
          entry.scope === 'project' && entry.projectHash === projectHash && !entry.pinned)
        for (const target of targets) {
          entries.splice(entries.indexOf(target), 1)
        }
        return targets
      })
      for (const entry of removed) {
        await store.appendChange({
          action: 'delete',
          entryId: entry.id,
          // 删除路径：同上，用 mutateEntries 返回的条目快照显式带出归属。
          owner: ownerOf(entry),
          scope: entry.scope,
          projectHash: entry.projectHash,
          summary: `清空项目：${summarize(entry.content)}`,
        })
      }
      await compileAll(store, config)
      json(res, 200, { ok: true, deleted: removed.length })
      return
    }
    if (method === 'POST' && rest === '/prune-project') {
      /*
       * 清理**已失效工作区**的记忆档案（2026-10-23）。
       *
       * 与 /delete-project 的区别：那条清的是记忆条目、档案留着；这条删的是
       * 档案本身（projects/<hash>/，实际只有一个 meta.json），条目按需一并软废弃。
       *
       * 为什么档案会「失效」：档案按 cwd 派生 hash 落盘，永不自动清除。文件夹被
       * 删掉 / 改名 / 挪走之后，meta.json 照样在，于是记忆面板和「工作区记忆」
       * 设置里会永久多出一行不存在的工作区（用户 2026-10-23 问到的那一例）。
       *
       * 安全阀：项目下还有活跃条目时默认**拒绝**（reason=has-entries），必须显式
       * 传 purgeEntries:true。前端据此弹二次确认，避免「只想删掉一行死工作区，
       * 结果把还想要的记忆一起废了」。purge 走的是软废弃（进回收站可恢复），
       * 不是物理删除。
       */
      const body = await readBody(req) as Record<string, unknown>
      const projectHash = requireString(body.projectHash, 'projectHash')
      const meta = await store.readProjectMeta(projectHash)
      if (meta === undefined) {
        // 只存在于工作区注册表、记忆库里没有档案的项目不该由这里删：
        // 注册表归 DSH 管，记忆插件删别人的登记项是越界。
        json(res, 200, { ok: false, reason: 'no-project', entryCount: 0 })
        return
      }
      const owned = (await store.readEntries()).filter(entry =>
        entry.scope === 'project' && entry.projectHash === projectHash && entry.deprecated !== true)
      if (owned.length > 0 && body.purgeEntries !== true) {
        json(res, 200, { ok: false, reason: 'has-entries', entryCount: owned.length })
        return
      }
      for (const entry of owned) {
        const retired = await store.retireEntry(entry.id, '工作区文件夹已不存在，档案清理时一并软废弃')
        if (retired === undefined) continue
        await store.appendChange({
          action: 'retire',
          entryId: entry.id,
          scope: entry.scope,
          projectHash: entry.projectHash,
          summary: `清理失效工作区：${summarize(entry.content)}`,
        })
      }
      const removed = await store.removeProjectDir(projectHash)
      await compileAll(store, config)
      json(res, 200, {
        ok: removed,
        ...(removed ? {} : { reason: 'remove-failed' }),
        removedEntries: owned.length,
      })
      return
    }
    if (method === 'POST' && rest === '/remember') {
      // 手动添加记忆（面板「添加」）：内容/范围/标签/置顶/重要性。
      const body = await readBody(req) as Record<string, unknown>
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      if (content === '') throw new Error('content 不能为空')
      const scope = body.scope === 'global' ? 'global' as const : 'project' as const
      const projectHash = scope === 'project'
        ? (typeof body.projectHash === 'string' && body.projectHash !== '' ? body.projectHash : null)
        : null
      if (scope === 'project' && projectHash === null) {
        throw new Error('项目层记忆需要 projectHash（当前无工作区，请用全局或指定项目）')
      }
      const tags = Array.isArray(body.tags)
        ? body.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').map(tag => tag.trim()).slice(0, 8)
        : []
      const importance = typeof body.importance === 'number' && Number.isFinite(body.importance)
        ? Math.max(1, Math.min(10, Math.round(body.importance))) : 8
      const pinned = body.pinned === true
      /*
       * 归属：面板在哪个 Bot 的记忆页点「添加」，就写到哪个 owner 上。
       * 只接受 `work` 或 `bot:<id>`，其余一律落回 `work`——绝不因为前端传了个
       * 奇怪字符串就把记忆写进一个谁也读不到的归属里。
       */
      const owner: MemoryOwner = typeof body.owner === 'string' && body.owner.startsWith('bot:') && body.owner.length > 4
        ? body.owner as MemoryOwner
        : 'work'
      // 项目层首次落盘时确保 meta 存在。
      if (scope === 'project' && projectHash !== null) {
        const meta = await store.readProjectMeta(projectHash)
        if (meta === undefined) {
          await store.writeProjectMeta(projectHash, {
            path: typeof body.path === 'string' && body.path !== '' ? body.path : '手动归属',
            alias: null,
            locked: false,
          })
        }
      }
      const beforeEntry = await store.getEntry(entryIdOf(content, scope, scope === 'project' ? projectHash : null, owner))
      const { created, entry } = await store.upsertEntry({
        content,
        scope,
        projectHash: scope === 'project' ? projectHash : null,
        owner,
        tags,
        importance,
        pinned,
        source: 'manual',
      })
      await store.appendChange({
        action: created ? 'add' : 'update',
        entryId: entry.id,
        scope: entry.scope,
        projectHash: entry.projectHash,
        summary: summarize(entry.content),
        before: beforeEntry?.content,
        after: entry.content,
      })
      await compileAll(store, config)
      json(res, 200, { ok: true, created, entry: toView(entry) })
      return
    }

    // ── 记忆整理（Memory Dream）与修订回滚 ─────────────────────────────
    if (method === 'POST' && rest === '/consolidate') {
      /*
       * 可选 owner（2026-11 补）：面板在某个 Bot 的记忆页点「整理」时只整理该归属。
       *
       * 不加这道过滤的后果是**跨 owner 合并**：整理集合原本只按 scope 切分，一个
       * 批次里同时有 Work 与多个 Bot 的条目，LLM 把「两台 Bot 各记了一句相似的话」
       * 合并成一条，合并产物落在第一条源条目的归属上——另一台 Bot 的记忆就此消失。
       * 语义与 GET /list 一致（`bots` = 所有 Bot），不传 = 不过滤（旧行为不变）。
       */
      const body = await readBody(req) as Record<string, unknown>
      const scopeRaw = typeof body.scope === 'string' ? body.scope : 'all'
      const owner = parseOwnerFilter(body.owner)
      let results: ConsolidateResult[]
      if (scopeRaw === 'global') {
        results = [await consolidateScope(ctx, store, config, 'global', 'manual', owner)]
      } else if (scopeRaw === 'project') {
        const projectHash = requireString(body.projectHash, 'projectHash')
        results = [await consolidateScope(ctx, store, config, { projectHash }, 'manual', owner)]
      } else {
        results = await consolidateAll(ctx, store, config, 'manual', owner)
      }
      json(res, 200, { ok: true, results })
      return
    }
    if (method === 'GET' && rest === '/revisions') {
      json(res, 200, { revisions: await store.listRevisions() })
      return
    }
    if (method === 'POST' && rest === '/rollback') {
      // 回滚范围由 store.restoreRevision 读快照 meta.scope 自己决定（整理是逐 scope
      // 跑的，整库替换会连带抹掉别的项目在这之后新记下的记忆）。路由侧**不**解析
      // scope：两处各判一次，一旦口径分叉就会出现「面板说只回滚这个项目，实际整库
      // 被覆盖」这类无从复现的破坏性行为。
      const body = await readBody(req) as Record<string, unknown>
      const revisionId = requireString(body.revisionId, 'revisionId')
      const ok = await store.restoreRevision(revisionId)
      if (!ok) throw new Error(`修订不存在：${revisionId}`)
      await compileAll(store, config)
      ctx.logger?.info?.(`[dsh-memory] rolled back to revision ${revisionId}`)
      json(res, 200, { ok: true })
      return
    }

    json(res, 404, { error: `no route for ${method} ${rest}` })
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (config.logApiRequests) void store.appendApiLog(`${method} ${rest} done ${Date.now() - apiStarted}ms`).catch(() => undefined)
  }
}

/** 面板列表视图（scope/项目/搜索/标签过滤）。 */
async function listView(store: MemoryStore, params: URLSearchParams): Promise<{ entries: EntryView[]; projects: ProjectView[] }> {
  const entries = await store.readEntries()
  const scope = params.get('scope')
  const project = params.get('project')
  const owner = params.get('owner')
  const q = params.get('q')?.trim().toLowerCase() ?? ''
  const tag = params.get('tag')
  const includeDeprecated = params.get('includeDeprecated') === '1'

  // 硬过滤：scope / project / owner / tag；deprecated 条目默认不显示（软废弃 = 退出活跃列表）。
  const scoped = entries.filter(entry => {
    if (scope === 'global' && entry.scope !== 'global') return false
    if (scope === 'project' && entry.scope !== 'project') return false
    if (project !== null && project !== '' && entry.projectHash !== project) return false
    // owner 过滤是「子 Bot 只看自己 / 主 Bot 看全部」在面板侧的落点。
    // 特殊值 `bots` = 所有 Bot 的（主 Bot 资料库要一次列出全部子 Bot 并标注来源），
    // 单个 `bot:<id>` 则精确匹配。判据收在 store.matchesOwner（与 /delete-today、
    // /consolidate 共用一份，避免前缀判断在三个入口分叉）。
    if (owner !== null && owner !== '' && !matchesOwner(entry, owner)) return false
    if (tag !== null && tag !== '' && !entry.tags.includes(tag)) return false
    if (!includeDeprecated && entry.deprecated === true) return false
    return true
  })
  // 搜索：走同一套 hybrid 检索（n-gram 相似 + 精确命中加成），
  // 让"打错一个字/换个说法"也能命中——旧实现是逐词子串 AND，
  // 与工具 memory_search 的行为不一致，面板搜不到工具能搜到的条目。
  const matched = q === ''
    ? scoped
    : searchEntries(q, scoped, 'hybrid').filter(match => match.score >= 0.2).map(match => match.entry)
  const views = (q === ''
    ? [...matched].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    // 有查询词时按相关度排序，但置顶条目仍优先（用户明确标记的重要条目）。
    : [...matched].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1)))
    .map(toView)

  return { entries: views, projects: await mergeWorkspaces(store, await store.listProjects(entries)) }
}

/**
 * 项目视图类型（面板返回）。
 *
 * pathMissing：这个工作区的文件夹还在不在（2026-10-23）。项目档案按 cwd 派生 hash
 * 存着、永不自动清除，所以文件夹被删掉之后列表里会永久多出一行死工作区。面板据此
 * 标灰 + 给「清理」，但**不隐藏**：盘没挂载和目录被删在 existsSync 眼里是同一种
 * 结果，隐藏会把可恢复的误判成没了。
 *
 * fromRegistry：这个项目只存在于 DSH 工作区注册表、记忆库里没有档案（没有 meta.json）。
 * 这类行不能由记忆插件清理——注册表归 DSH 管，删别人的登记项是越界。
 */
type ProjectView = { hash: string; path: string; alias: string | null; locked: boolean; autoMemory: boolean; injectExcluded: boolean; entryCount: number; pinnedCount: number; pathMissing: boolean; fromRegistry?: boolean }

/**
 * 合并 DSH 工作区注册表：尚无记忆的新工作区也出现在项目列表（entryCount 0），
 * 让「刚建的工作区」在记忆面板立即可见（无需等第一条记忆写入）。
 */
async function mergeWorkspaces(store: MemoryStore, projects: ProjectView[]): Promise<ProjectView[]> {
  const known = new Set(projects.map(project => project.hash))
  for (const workspace of await store.listDshWorkspaces()) {
    const hash = projectHashOf(workspace.path)
    if (!known.has(hash)) {
      projects.push({
        hash,
        path: workspace.path,
        alias: workspace.title,
        locked: false,
        autoMemory: true,
        injectExcluded: false,
        entryCount: 0,
        pinnedCount: 0,
        // 注册表里的路径同样可能早已失效（DSH 自己也不清理已删工作区）：
        // 标出来但不给清理入口，见 ProjectView.fromRegistry 的注释。
        pathMissing: !isWorkspacePathAlive(workspace.path),
        fromRegistry: true,
      })
      known.add(hash)
    }
  }
  projects.sort((a, b) => a.path.localeCompare(b.path))
  return projects
}

// ── HTTP plumbing（skill-manager 同款） ────────────────────────────────

function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string') return false
  const a = address.toLowerCase()
  if (a === '::1') return true
  const ipv4 = a.startsWith('::ffff:') ? a.slice(7) : a
  const octets = ipv4.split('.')
  return octets.length === 4 && octets[0] === '127'
    && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function hostNameOf(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const host = value.trim().toLowerCase()
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close <= 1) return null
    const suffix = host.slice(close + 1)
    if (suffix !== '' && !/^:\d+$/.test(suffix)) return null
    return host.slice(1, close)
  }
  const firstColon = host.indexOf(':')
  const lastColon = host.lastIndexOf(':')
  if (firstColon !== lastColon) return null
  return firstColon === -1 ? host : host.slice(0, firstColon)
}

function loopbackAllowed(req: IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const host = hostNameOf(req.headers.host)
  if (host === null) return false
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} 不能为空`)
  }
  return value.trim()
}
/** mergeTags 复用导出（tools.ts 已用本地实现，此处仅为 API 一致性保留）。 */
export { mergeTags }
