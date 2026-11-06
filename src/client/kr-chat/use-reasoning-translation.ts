/**
 * dsh-seeker-bot — KR 思考卡的译文状态机（React 侧）。
 *
 * 职责边界：
 *   · 本文件只管「什么时候发请求、结果怎么落到视图上」；
 *   · 具体的分片规则、服务探测与单片翻译在 reasoning-translate.ts；
 *   · 视图（按钮 / 状态字）由 KrReasoningCard 渲染。
 *
 * 状态机（对齐官方那套的四态口径）：
 *
 *   idle        还没点「查看译文」——不发任何请求。
 *   unavailable 官方翻译服务不可用（bundle 没装 / remote 没挂上 / 配置未接受）。
 *   pending    请求在飞。
 *   ready       全部片段译完。
 *   failed      至少一片失败；**保留原文**，给「重试」。
 *
 * 「状态不撒谎」：pending 期间按钮禁用且显示进行中态；ready 才切视图；
 * failed 立刻退回原文视图并给重试，绝不把半截译文当成译文显示。
 *
 * 自动翻译（用户要求「不用点」）：回合收口时自动翻一次，走模块级串行队列
 * 限流，避免长会话里几十张历史思考卡同时发请求。
 *
 * 串行还是并行：官方是**串行**（每个展开区一个生命周期控制器，逐片处理）。
 * 这里沿用串行 —— 匿名端点（Bing / Google）本来就限流，并行打过去只会提高
 * 失败率；付费 Flash 则是每片一次计费请求，串行还能让前面的失败及时止损。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  probeTranslationLimits,
  resolveTargetLanguage,
  splitIntoChunks,
  translateChunk,
  getActiveLocale,
  type TranslationChunk,
} from './reasoning-translate.ts'

/** 译文层的对外状态。 */
export type TranslationViewState =
  | 'idle'
  | 'unavailable'
  | 'pending'
  | 'ready'
  | 'failed'

/** 译文层的对外形状。 */
export interface ReasoningTranslation {
  /** 当前状态。 */
  readonly state: TranslationViewState
  /** 译文正文（仅 ready 时有值）。 */
  readonly text: string
  /** 已完成片段数 / 总片段数（pending 期间显示进度）。 */
  readonly done: number
  /** 总片段数。 */
  readonly total: number
  /** 发起翻译（幂等：已在跑则忽略）。 */
  readonly start: () => void
  /** 重新翻译（失败后重试用；会清掉本地缓存里这一批）。 */
  readonly retry: () => void
  /** 放弃当前视图（切回原文时取消在途请求）。 */
  readonly cancel: () => void
}

export interface UseReasoningTranslationOptions {
  /** 完整思考原文（多段拼接）。 */
  readonly sourceText: string
  /** 所属会话 id；给上才有官方 Session 级持久化缓存。 */
  readonly sessionId?: string | undefined
  /** 官方翻译服务是否可用（由调用方探测后传入）。 */
  readonly available: boolean
  /**
   * 是否**自动**翻译（不点按钮）。
   *
   * 自动翻译的触发点是**回合收口**（settled 为 true），不是「原文一变就翻」：
   * 流式期思考每秒都在长，按变化触发就是请求风暴（每个 delta 一次全量翻译）。
   * 收口时文本定稿，翻一次就够。
   */
  readonly autoTranslate?: boolean
  /** 回合是否已收口（自动翻译的触发判据）。 */
  readonly settled?: boolean
}

export function useReasoningTranslation(
  options: UseReasoningTranslationOptions,
): ReasoningTranslation {
  const { sourceText, sessionId, available, autoTranslate = false, settled = false } = options
  const [state, setState] = useState<TranslationViewState>('idle')
  const [chunks, setChunks] = useState<readonly TranslationChunk[]>(EMPTY_CHUNKS)
  const [done, setDone] = useState(0)

  /** 在途请求的取消器；换视图 / 卸载时用它掐断。 */
  const abortRef = useRef<AbortController | null>(null)
  /** 本次翻译对应的原文指纹。 */
  const sourceRef = useRef<string>('')
  /** 递增序号：每次 start/retry 都换一代，旧一代的结果直接丢。 */
  const generationRef = useRef(0)
  /** 组件是否仍挂载（排队中的自动翻译靠它跳过已卸载的卡片）。 */
  const aliveRef = useRef(true)

  /*
   * 原文变化 → 只更新快照基准，**不打断任何在跑的翻译**。
   *
   * 这一段是**快照语义**的核心：译文对应的是「开始翻译那一刻的原文」，
   * 不是「最新原文」。
   *
   * ⚠ 早期版本在这里 abort + setState('idle')，看着像「原文变了就作废译文」，
   * 实际效果是**流式期点了按钮，翻译刚开始就被自己掐掉**：思考每长一行，
   * 这个 effect 就跑一次，把 pending 重置成 idle —— 进度条一闪就没了，用户
   * 永远看不到译文。症状是「点了没反应」，根因是把「快照」当成了「跟随」。
   *
   * 现在的口径：翻译已启动（pending / ready）→ 原文再长也不动它，它是一份
   * 完整快照；用户主动重试（failed → retry）→ 那时用的是**最新**原文，
   * 所以重试自然会翻到新的内容。
   */
  useEffect(() => {
    if (sourceRef.current === sourceText) return
    sourceRef.current = sourceText
  }, [sourceText])

  /* 卸载时掐断在途请求：官方那套也是这么收的（关闭思考内容会取消请求）。 */
  useEffect(() => () => {
    aliveRef.current = false
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  /*
   * 取材用的最新原文（ref 形态）：让 run() 既是稳定引用、又能取到当下内容。
   *
   * 直接把 sourceText 放进 useCallback 的依赖会让 run 每次渲染都换新引用，
   * 于是 start / retry 也跟着换 —— 按钮的 onClick 每次渲染都是新函数，
   * 折叠体的高度补间（useHeightAnimation）也会跟着抖。
   *
   * 用 ref 读「点击那一刻」的原文：ref 在**渲染期**就更新（不是 effect 里），
   * 所以它永远是屏幕上的最新值。
   */
  const sourceLatestRef = useRef(sourceText)
  sourceLatestRef.current = sourceText

  const run = useCallback(async (): Promise<void> => {
    if (!available) {
      setState('unavailable')
      return
    }
    /*
     * 取材点：**最新的** sourceText（渲染期更新的 ref）。
     *
     * sourceRef 只在 effect 里更新，而 effect 在渲染**之后**才跑 —— 流式期
     * 每次 delta 都会带来一次「ref 还停在上一次的值」的窗口。从它取材会翻到
     * 略旧的一版原文（与用户点按钮那一刻看到的差最后几行）。
     */
    const text = sourceLatestRef.current
    if (text.trim() === '') {
      setState('idle')
      return
    }

    const limits = await probeTranslationLimits()
    if (limits === null) {
      setState('unavailable')
      return
    }
    const provider = limits.preferences.provider
    const targetLanguage = resolveTargetLanguage(
      limits.preferences.targetLanguage,
      getActiveLocale(),
    )
    const parts = splitIntoChunks(text, limits.maxTextChars)
    if (parts.length === 0) {
      setState('idle')
      return
    }

    const generation = generationRef.current + 1
    generationRef.current = generation
    const controller = new AbortController()
    abortRef.current = controller
    setChunks(parts.map((part, index) => ({
      id: index,
      text: part,
      status: 'pending' as const,
      translation: '',
    })))
    setDone(0)
    setState('pending')

    const collected: string[] = []
    let failed = false
    for (let index = 0; index < parts.length; index += 1) {
      if (generationRef.current !== generation) return
      if (controller.signal.aborted) return
      const translated = await translateChunk(
        { text: parts[index], targetLanguage, provider },
        sessionId,
        controller.signal,
      )
      if (generationRef.current !== generation) return
      if (translated === null) {
        failed = true
        // 失败即停：继续发后面的请求只是在为一份不会被显示的译文付费。
        break
      }
      collected.push(translated)
      /*
       * 把这一片的译文**写回 chunks**。
       *
       * ⚠ 这一行曾缺席，症状极隐蔽：state 顺利走到 ready、按钮文案切到
       * 「查看原文」、但正文一行不变。原因在 text 的推导上——它读的是
       * `chunks.map(chunk => chunk.translation)`，而 collected 只进了局部数组，
       * chunks 里的 translation 字段一直是空串。于是 text 是 N 个空串拼成的
       * '\n'，`text.trim() !== ''` 为假 → showTranslation 恒 false → 译文永远
       * 不显示。state 却是 ready（一切「成功」），所以从状态上看不出任何异常。
       *
       * 「状态与显示对不上」比「翻译失败」难查得多 —— 后者至少会亮红灯。
       */
      setChunks(prev => prev.map((chunk) => (
        chunk.id === index ? { ...chunk, status: 'ready' as const, translation: translated } : chunk
      )))
      setDone(index + 1)
    }
    if (generationRef.current !== generation) return
    if (controller.signal.aborted) return
    abortRef.current = null
    if (failed || collected.length < parts.length) {
      setState('failed')
      return
    }
    setState('ready')
  }, [available, sessionId])

  const start = useCallback((): void => {
    if (state === 'pending') return
    void run()
  }, [run, state])

  const retry = useCallback((): void => {
    if (state === 'pending') return
    void run()
  }, [run, state])

  /*
   * 自动翻译：**回合收口时**翻一次，不点按钮。
   *
   * 为什么等收口而不是「原文一变就翻」：流式期思考每秒都在长，按变化触发
   * 就是请求风暴（每个 delta 一次全量翻译 + 分片）。收口时文本定稿，翻一次
   * 就够 —— 这也是用户读那段思考的时刻。
   *
   * autoRanRef 保证一张卡只自动翻一次：翻过之后原文再变（下一轮又追加了新
   * 思考）不自动重来，要重翻由用户点「重试」。
   *
   * ⚠ 长会话里会同时挂载几十张**历史**思考卡，它们挂载时 settled 已经是
   * true，于是会一起触发自动翻。不拦住就是几十路并发的请求风暴（匿名端点
   * 限流、付费 Flash 计费）。所以走模块级串行队列：同一时刻只有一路在跑，
   * 其余排队；手动点击（start / retry）不进队列 —— 用户主动点的要立即响应。
   */
  const autoRanRef = useRef(false)
  useEffect(() => {
    if (!autoTranslate) return
    if (!settled) return
    if (autoRanRef.current) return
    if (!available) return
    if (sourceLatestRef.current.trim() === '') return
    autoRanRef.current = true
    enqueueAutoTranslate(async () => {
      if (!aliveRef.current) return
      await run()
    })
  }, [autoTranslate, settled, available, run])

  /* 回合又开跑（新一轮）→ 允许收口时再自动翻一次。 */
  useEffect(() => {
    if (!autoTranslate) return
    if (!settled) autoRanRef.current = false
  }, [autoTranslate, settled])

  const cancel = useCallback((): void => {
    abortRef.current?.abort()
    abortRef.current = null
    generationRef.current += 1
  }, [])

  const text = useMemo(() => {
    if (state !== 'ready') return ''
    return chunks.map((chunk: TranslationChunk) => chunk.translation).join('\n')
  }, [chunks, state])

  return {
    state,
    text,
    done,
    total: chunks.length,
    start,
    retry,
    cancel,
  }
}

const EMPTY_CHUNKS: readonly TranslationChunk[] = []

/**
 * 自动翻译的全局串行队列（**跨所有思考卡共享**）。
 *
 * 打开一个长会话时可能同时挂载几十张历史思考卡，若各自并发发起翻译，就是
 * 一次几十路 × 多分片的请求风暴。排成一条 Promise 链：同一时刻只有一路自动
 * 翻译在跑，其余排队。手动点击不进队列（用户主动点的要立刻响应）。
 *
 * `.then(task, task)` 而不是 `.then(task)`：任何一路抛错都不该让整条链断掉，
 * 后面排队的卡片照样能翻。
 */
let autoQueue: Promise<void> = Promise.resolve()
function enqueueAutoTranslate(task: () => Promise<void>): void {
  autoQueue = autoQueue.then(task, task)
}

/** 重探间隔（毫秒）。 */
const PROBE_RETRY_MS = 1500

/** 最多重探多少次（约 20 秒）。官方 bundle 压根没装时不再无限轮询。 */
const MAX_PROBE_ATTEMPTS = 14

/**
 * 官方翻译服务是否可用。
 *
 * 探测一次，全局共享（probeTranslationLimits 内部有模块级缓存）。
 *
 * 返回值三态而不是布尔：**null = 还在探**，此时思考卡不显示「查看译文」按钮
 * （官方客户端也是等首次 provider 发现完成后才注册翻译控件——凭据/模型发现
 * 停滞时，免登录翻译控件可能最多延迟 deepseekTimeoutMs 才出现）。
 */
export function useTranslationAvailability(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    /*
     * 轮询式重探：官方 client 包是**异步** apply 的（它在自己的 apply 里
     * `await ctx.remote.$mount(...)`），本插件的组件完全可能先挂载、remote
     * 命名空间后到。探一次就定性会让翻译按钮整轮都不出现。
     *
     * 探到就停；探不到隔一会儿再探，最多约 20 秒（覆盖官方包 apply 的正常
     * 时延），之后放弃 —— 免得官方 bundle 压根没装时留下一条永久轮询。
     */
    let attempts = 0
    const attempt = (): void => {
      void probeTranslationLimits().then((limits) => {
        if (!alive) return
        if (limits !== null) {
          setAvailable(true)
          return
        }
        if (attempts < MAX_PROBE_ATTEMPTS) {
          attempts += 1
          timer = setTimeout(attempt, PROBE_RETRY_MS)
        }
      })
    }
    attempt()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  return available
}
