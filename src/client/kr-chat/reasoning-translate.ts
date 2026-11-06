/**
 * dsh-seeker-bot — KR 思考卡的译文层（原文 / 译文双视图）。
 *
 * 为什么自己写一层，而不直接用官方那套：
 *
 * 官方 @deepseek-ai/dsh-experimental-client-ui-cot-translation 把翻译控件挂在
 * **官方 ReasoningRow 的展开体**里（走 conversation.chat.reasoning.body 槽）。
 * 而 KR（Seeker）视图的思考卡是本插件自己画的 —— KrReasoningCard 直接从
 * assistant-step 座位渲染 .kr-card--reasoning，根本不经过官方 ReasoningRow，
 * 于是官方那枚「查看译文」按钮在 KR 模式下永远不出现。
 *
 * 所以这里复用官方**服务层**、自绘**视图层**：
 *   · 服务层：ctx.remote.cotTranslation（官方 client 包通过 remote.$mount 装好的
 *     命名空间）。它背后是官方 @deepseek-ai/dsh-experimental-translator：
 *     匿名端点（Bing / Google）与付费 DeepSeek Flash、Session 级持久化缓存、
 *     请求长度上限、失败分类，全是官方那套，不重写。
 *   · 视图层：下面的分片调度 + 原文/译文切换。
 *
 * 三条硬约束（都来自官方实现的既成事实，不是本模块的选择）：
 *
 *  1. **provider 与目标语言由宿主配置决定**，客户端不能自选。官方 host 端
 *     resolveSelected() 会校验 request.provider 必须等于已接受的值，且
 *     targetLanguage 非 auto 时必须逐字相等。所以本模块先 limits() 读回
 *     「已接受的偏好」，再照着发；preferences.targetLanguage === "auto" 时
 *     才由客户端按界面语言给出目标语言（官方客户端同一口径）。
 *  2. **单次请求长度有上限**（translator 的 maxTextChars，默认 4000 UTF-16
 *     代码单元）。整段思考动辄上万字，必须分片。
 *  3. **缓存按 Session 持久化**：host 侧按 原文 + 语言 + provider + 配方 做
 *     身份，命中即零请求。分片边界必须稳定，否则同一段思考每次都换分片、
 *     缓存永远不命中 —— 所以分片按行边界切，不按字符硬切（除超长单行）。
 *
 * 分片的粒度是「块」而不是「行」：译文的换行数与原文不一定一致，按行对齐会
 * 串位。块级替换才是稳的。
 */
import { getService } from '../client-ctx.ts'

/** 官方 remote 的调用结果形态（成功 / 失败二分）。 */
export interface RemoteResultLike<T> {
  readonly ok?: boolean
  readonly value?: T
  readonly error?: unknown
}

/** 官方 limits() 的回包形状。 */
export interface TranslationLimits {
  /** 单次请求的 UTF-16 代码单元上限。 */
  readonly maxTextChars: number
  /** 宿主已接受的偏好。 */
  readonly preferences: {
    readonly provider: string
    readonly targetLanguage: string
  }
  /** 当前可用的翻译服务。 */
  readonly availableProviders: readonly string[]
}

/** 官方 translate() 的入参形状。 */
export interface TranslationRequestLike {
  readonly text: string
  readonly targetLanguage: string
  readonly sourceLanguage?: string
  readonly provider?: string
  readonly sessionId?: string
}

/** 官方 remote 命名空间的最小可读面。 */
export interface CotTranslationRemoteLike {
  limits?: (signal?: AbortSignal) => Promise<RemoteResultLike<TranslationLimits>>
  translate?: (
    request: TranslationRequestLike,
    signal?: AbortSignal,
  ) => Promise<RemoteResultLike<string>>
}

/** 一个待译片段的状态。 */
export type ChunkStatus = 'pending' | 'ready' | 'failed'

/** 一个待译片段。 */
export interface TranslationChunk {
  /** 片段在全文中的序号（全文不变时稳定）。 */
  readonly id: number
  /** 原文（可能含换行）。 */
  readonly text: string
  /** 翻译状态。 */
  readonly status: ChunkStatus
  /** 译文（status 为 ready 时有值）。 */
  readonly translation: string
}

/**
 * 保守的分片上限：官方 maxTextChars 之上留一截余量。
 *
 * 余量不是给「翻译膨胀」留的（host 按提交原文的长度判超限），而是给
 * 「行尾空白 + 分片拼接时的换行」留的：分片边界按行切，块文本里带着换行符，
 * 正好落在上限上会在 host 侧被判超限。
 */
export function effectiveLimit(maxTextChars: number): number {
  if (!Number.isFinite(maxTextChars) || maxTextChars <= 0) return 3500
  /*
   * 余量取「上限的 10%」与「400 字符」里的小者 —— 不能写成固定下限。
   *
   * 写成 `Math.max(500, limit * 0.9)` 时，上限本身小于 556 的场景会**反超**：
   * limit=400 算出 500，比官方上限还大，host 侧直接判超限，整次翻译失败。
   * 余量只用来给「行尾空白 + 拼接换行」留位，小上限下少留一点即可。
   */
  const margin = Math.min(Math.floor(maxTextChars * 0.1), 400)
  return Math.max(1, maxTextChars - margin)
}

/**
 * 按字符（Unicode 码点，不拆代理对）切超长单行。
 *
 * 代理对被拆开会产生半个 UTF-16 字符，翻译端拿到的是乱码。这里用
 * Array.from 按码点切，保证每一片都是完整字符。
 */
function splitLongLine(line: string, limit: number): string[] {
  /*
   * 按 **UTF-16 代码单元** 切，而不是按码点数。
   *
   * host 侧判超限用的是 `text.length`（UTF-16 代码单元数），不是码点数。
   * 一个代理对字符（emoji 等）占 2 个代码单元却只算 1 个码点：按码点切出来
   * 的每片在 .length 上仍是上限的两倍，host 照样判超限。
   *
   * 切点必须落在**码点边界**上：按码点遍历（Array.from）拿到完整字符，
   * 再按它的 UTF-16 长度累加 —— 代理对永远不会被劈成两半。
   */
  const points = Array.from(line)
  if (line.length <= limit) return [line]
  const pieces: string[] = []
  let buffer = ''
  let units = 0
  for (const point of points) {
    const width = point.length
    if (units + width > limit && buffer !== '') {
      pieces.push(buffer)
      buffer = ''
      units = 0
    }
    buffer += point
    units += width
  }
  if (buffer !== '') pieces.push(buffer)
  return pieces
}

/**
 * 把完整思考文本切成若干块，每块长度不超过 limit。
 *
 * 规则：
 *  · 按行边界累积 —— 分片稳定，官方 Session 缓存才命中；
 *  · 单行超限时按码点硬切（这一块无法按行切，否则会超限）；
 *  · 空文本返回空数组（不发请求）。
 */
export function splitIntoChunks(text: string, maxTextChars: number): string[] {
  const limit = effectiveLimit(maxTextChars)
  const trimmed = text.trim()
  if (trimmed === '') return []
  const chunks: string[] = []
  let buffer = ''
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trimEnd()
    if (line === '') continue
    if (line.length > limit) {
      if (buffer !== '') {
        chunks.push(buffer)
        buffer = ''
      }
      for (const piece of splitLongLine(line, limit)) chunks.push(piece)
      continue
    }
    if (buffer === '') {
      buffer = line
      continue
    }
    // 加上这一行会超限就先收口；再 +1 是给块内换行符留位。
    if (buffer.length + line.length + 1 > limit) {
      chunks.push(buffer)
      buffer = line
      continue
    }
    buffer = buffer + '\n' + line
  }
  if (buffer !== '') chunks.push(buffer)
  return chunks
}

/**
 * 界面语言 → 目标语言标签。
 *
 * 官方口径：preferences.targetLanguage === "auto" 时跟随界面语言。本模块取
 * 官方 locale 服务的 active 值（读不到再退 navigator.language）。
 */
export function resolveTargetLanguage(
  accepted: string,
  localeActive: string | undefined,
): string {
  if (accepted !== 'auto') return accepted
  const fallback = typeof navigator !== 'undefined' ? navigator.language : 'zh'
  const active = localeActive ?? fallback
  return active === '' ? fallback : active
}

/**
 * 模块级本地缓存：同一片段文本在同一次会话里只发一次请求。
 *
 * 官方 host 侧已有 Session 级持久化缓存（命中即零请求），这一层只是把
 * 「同一批片段被重复调度」挡在 RPC 之前 —— 展开一次思考、再收起、再展开，
 * 组件重挂载会让调度重跑，本地缓存直接命中。
 */
const localCache = new Map<string, string>()

/** 本地缓存键：provider + 目标语言 + 原文。 */
function cacheKey(provider: string, targetLanguage: string, text: string): string {
  return provider + '\u0000' + targetLanguage + '\u0000' + text
}

/** 清空本地缓存（会话身份变化或测试用）。 */
export function clearLocalTranslationCache(): void {
  localCache.clear()
}

/**
 * 读官方 remote 命名空间；读不到返回 null（官方 bundle 未启用）。
 *
 * 走本插件自己的 client-ctx（根上下文），不是插件 ctx：cordis 的 ctx 是
 * Proxy，未在 inject 白名单里声明的属性**一读就抛**。根上下文是例外，且
 * 本插件现有的 speech remote（personal/audio.ts）也是这条路径。
 */
export function getCotTranslationRemote(): CotTranslationRemoteLike | null {
  const ns = readRemoteNamespace('cotTranslation') as CotTranslationRemoteLike | undefined
  if (ns === undefined || ns === null) return null
  if (typeof ns.translate !== 'function' || typeof ns.limits !== 'function') return null
  return ns
}

/**
 * 读客户端 remote 上的某个命名空间。
 *
 * **只有 `ctx.get('remote.<namespace>')` 这一条路能走通**（实测）：
 *
 *   · `ctx.get('remote').cotTranslation` —— 抛「cannot get property
 *     "remote.cotTranslation" without inject」。remote 服务是 traceable
 *     proxy，属性访问走 cordis 的 inject 闸门，而命名空间是以
 *     `remote.<namespace>` 整体注册的独立服务，属性访问找不到它；
 *   · `ctx.remote.cotTranslation` —— 同样撞 inject 闸门；
 *   · `ctx.get('remote.cotTranslation')` —— 直接命中该服务，正常返回。
 *
 * 所以这里只走服务读取，不做属性兜底（属性兜底必然抛，白包一层 try）。
 */
function readRemoteNamespace(namespace: string): unknown {
  try {
    return getService(`remote.${namespace}`)
  } catch {
    return undefined
  }
}

/** 官方 locale 服务的当前语言（读不到返回 undefined）。 */
export function getActiveLocale(): string | undefined {
  try {
    /* 同样走服务读取：ctx.locale 也会撞 inject 闸门（见 readRemoteNamespace）。 */
    const locale = getService<{ getSnapshot?: () => { active?: string } }>('locale')
    const active = locale?.getSnapshot?.()?.active
    return typeof active === 'string' && active !== '' ? active : undefined
  } catch {
    return undefined
  }
}

/**
 * limits() 的模块级缓存：**只缓存成功结果**。
 *
 * 官方客户端自己也是这么做的（limits 读一次，之后用 store 快照）。每张思考卡
 * 各探一次会打出成倍的 RPC。
 *
 * 失败（null）**不缓存**：官方 client 包是异步 apply 的（它在自己的 apply 里
 * `await ctx.remote.$mount(...)`），本插件的组件可能先挂载、remote 命名空间后
 * 到。把「还没到」记成「永久不可用」会让翻译按钮整轮都不出现。
 */
let limitsPromise: Promise<TranslationLimits | null> | null = null

/** 探测超时：官方 limits() 会等原生 provider 发现，最长可能拖到 deepseekTimeoutMs。 */
const LIMITS_PROBE_TIMEOUT_MS = 8000

/**
 * 探测官方翻译服务的可用性与限制；不可用返回 null（不抛）。
 *
 * 超时也返回 null（不缓存），让调用方有机会稍后重试。
 */
export function probeTranslationLimits(): Promise<TranslationLimits | null> {
  if (limitsPromise !== null) return limitsPromise
  const pending = (async () => {
    const remote = getCotTranslationRemote()
    if (remote === null) return null
    try {
      const result = await withTimeout(
        Promise.resolve(remote.limits?.()),
        LIMITS_PROBE_TIMEOUT_MS,
      )
      if (result === undefined || result?.ok !== true) return null
      const value = result.value
      if (value === undefined || value === null) return null
      return value
    } catch {
      return null
    }
  })()
  limitsPromise = pending
  // 失败不留在缓存里：等命名空间到位后还能再探。
  void pending.then((value) => {
    if (value === null && limitsPromise === pending) limitsPromise = null
  }, () => {
    if (limitsPromise === pending) limitsPromise = null
  })
  return pending
}

/** 给一个 promise 加超时（不抛，只返回 null）。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 重置 limits 探测缓存（官方配置变更后可用）。 */
export function resetTranslationLimitsProbe(): void {
  limitsPromise = null
}

/**
 * 翻译一个片段。
 *
 * @param request - 原文、语言与 provider。
 * @param sessionId - 所属会话；给上才有官方 Session 缓存。
 * @param signal - 取消信号（组件卸载 / 视图切回原文时取消在途请求）。
 * @returns 译文；失败返回 null（调用方保留原文并标记 failed）。
 */
export async function translateChunk(
  request: TranslationRequestLike,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const provider = request.provider ?? ''
  const cached = localCache.get(cacheKey(provider, request.targetLanguage, request.text))
  if (cached !== undefined) return cached

  const remote = getCotTranslationRemote()
  if (remote === null) return null
  try {
    const result = await remote.translate?.(
      sessionId === undefined ? request : { ...request, sessionId },
      signal,
    )
    if (result === undefined || result?.ok !== true) return null
    const value = result.value
    if (typeof value !== 'string' || value === '') return null
    localCache.set(cacheKey(provider, request.targetLanguage, request.text), value)
    return value
  } catch {
    return null
  }
}
