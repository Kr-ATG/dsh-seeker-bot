/**
 * Personal Agent — 自动播报的「挑哪几条 + 怎么排队」（纯逻辑，不碰音频）。
 *
 * 为什么单独成模块：这里有两块值得离线测的逻辑，放在 MessageList 的 effect 里
 * 只能靠源码字符串断言，测不出行为：
 *  1. pickAutoSpeakItems：一次 messages 变化里，哪些 bot 消息还没念、当前能不能念；
 *  2. AutoSpeakQueue：多条同时可念时按顺序串行念，而不是让后一条打断前一条。
 *
 * 历史背景（2026-11-07 用户报「语音朗读如果没有回复完，回复的第一条不会自动朗读」）：
 * 旧实现每轮只挑「最后一条能读的 bot 消息」，于是：
 *  · 一轮里 Bot 先发的一条（progress 播报 / 问答卡）被后面的 final 挡住，永远轮不到；
 *  · 这一轮还没结束（末尾还有 pending 消息）时，第一条已经落地的回复也不念；
 *  · 两条同时定稿时只念最后一条。
 * 现在改成**按消息流顺序逐条补播**：所有未播过的消息按先后排进队列，播完一条再播
 * 下一条。自动播报的语义回到「Bot 说过的每一条都念」，而不是「只念最后一句」。
 *
 * 为什么串行（而不是一次 speakText 多条）：speech.ts 是全局唯一播放器，每次
 * speakText 都会停掉正在播的那一条。多条同时到达时逐个调用，用户只会听到最后
 * 半段——串行队列是「每条都完整念完」的唯一做法。
 */
import type { Message } from '../types.ts'

/**
 * 自动播报的 debounce（毫秒）。
 *
 * 流式回复会连续改 messages（每来一段正文就变一次引用），不加防抖就会把半句话
 * 念出去。250ms 是「这一阵安静下来了」的量级：比一次事件循环长，又短到用户
 * 感觉不出延迟。
 */
export const AUTO_SPEAK_DELAY_MS = 250

/** 一条待自动播报的消息（挑选阶段的产物）。 */
export interface AutoSpeakItem {
  /** 前端消息 id；气泡上的喇叭按钮据此显示「正在念这一条」。 */
  id: string
  /** 已经清洗过的可朗读正文（直接交给 speakText）。 */
  text: string
  /** 交给 speakText 的选项（messageId / botId / 音色 / 供应商）。 */
  options: {
    messageId: string
    botId: string
    voice?: string
    vendor?: string
  }
}

/** 挑选参数：开关 + 当前单聊 Bot 的嗓子。 */
export interface AutoSpeakPickOptions {
  /** Bot 的「自动播报」开关。 */
  autoSpeak: boolean
  /** 单聊当前 Bot id（只用于宿主日志与诊断，不参与合成）。 */
  botId: string
  /** 音色 id；留空跟随全局默认。 */
  voice?: string
  /** Live 供应商 id；留空跟随全局默认。 */
  vendor?: string
}

/**
 * 需要用户动作的卡片：问答（need-input）与审批（approval）。
 *
 * 它们走**必播通道**：那张卡就是这一轮的最终内容，宿主正挂着等用户决定。
 * 不播的话，没盯屏幕的用户根本不知道 Bot 在等自己（2026-11-07 用户报
 * 「需要我定的时候需要给朗读出来」）。
 */
export function isAutoSpeakAsk(message: Message): boolean {
  return message.kind === 'need-input' || message.kind === 'approval'
}

/**
 * 挑出本次要补播的消息（**按消息流顺序**，从早到晚）。
 *
 * 规则：
 *  · 只认 bot 消息；已经念过的跳过；
 *  · 问答 / 审批卡必播——不看自动播报开关，也不要求这一轮已定稿（卡落地时
 *    这一轮常常还挂着 pending 的消息，等定稿就等于永远不念）；
 *  · 其它消息：需要自动播报开关打开，且必须已定稿（pending !== true）——
 *    还在生成就念等于念半句，然后被下一段打断；
 *  · 挑不出正文的（空 pending 占位 / 纯工具卡 / 纯生图卡）跳过，**但不标记已播**：
 *    它以后长出正文（流式填进来 / 占位被认领）时还要念。
 *
 * 这里刻意**不**做「只挑最后一条」：那一版会把第一条吞掉，正是本次修复的 bug。
 *
 * @param textOf 把一条消息洗成可朗读文本的纯函数（真实实现是 speech.ts 的
 *               speechTextOf；注入进来是为了让本模块不依赖音频运行时，测试
 *               可以直接喂桩）。
 */
export function pickAutoSpeakItems(
  messages: readonly Message[],
  spoken: ReadonlySet<string>,
  options: AutoSpeakPickOptions,
  textOf: (message: Message) => string,
): AutoSpeakItem[] {
  /*
   * 同轮里还有 pending 消息 = 这一轮还没结束。SSE 落地的消息不带 pending（store 的
   * 常驻 SSE 与 /reply/stream 是两套落地路径），但它们和流式占位共享 turnId；
   * 只看消息自己的 pending 会把这些半截正文念出去，而且念完也不会再补全。
   */
  const pendingTurns = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'bot') continue
    if (message.pending !== true) continue
    if (message.turnId !== undefined) pendingTurns.add(message.turnId)
  }
  const items: AutoSpeakItem[] = []
  for (const message of messages) {
    if (message.role !== 'bot') continue
    if (spoken.has(message.id)) continue
    const ask = isAutoSpeakAsk(message)
    if (!ask && !options.autoSpeak) continue
    /* 半句话不念：还没定稿的普通消息等它定稿（下一轮 messages 变化会再看一次）。 */
    if (!ask && message.pending === true) continue
    /* 同一轮还有 pending：这一轮没收口，正文可能还会长，等收口再念。 */
    if (!ask && message.turnId !== undefined && pendingTurns.has(message.turnId)) continue
    const text = textOf(message)
    if (text === '') continue
    items.push({
      id: message.id,
      text,
      options: {
        messageId: message.id,
        botId: options.botId,
        ...(options.voice !== undefined && options.voice !== '' ? { voice: options.voice } : {}),
        ...(options.vendor !== undefined && options.vendor !== '' ? { vendor: options.vendor } : {}),
      },
    })
  }
  return items
}

/**
 * 一条朗读的执行器（真实实现是 speech.ts 的 speakText；测试注入桩）。
 *
 * 返回值 = 「这一条到底有没有出声」：被浏览器自动播放策略拦住 / 服务不可用 /
 * 文本为空都返回 false。队列据此决定要不要停队、要不要把这条记为已播——否则
 * 一次拦截会把整队消息都标成「念过了」，用户之后再也听不到它们。
 */
export type AutoSpeakRunner = (text: string, options: AutoSpeakItem['options']) => Promise<boolean>

/**
 * 自动播报队列：串行消费，后一条等前一条真的播完再开始。
 *
 * 生命周期由调用方持有（MessageList 用 ref 存一个实例）。reset() 作废整条队列
 * ——用户手动点播 / 点停止、切会话、关开关、离开消息流都该把「还没念的」清掉，
 * 否则用户操作完，后台还在接着一条条念。
 *
 * 注意 reset() 只清队列，**不停**正在播的那一条：停播放器是 stopSpeech 的职责，
 * 队列越权去停会把「用户只是想关掉自动续播、当前这条可以听完」也一起掐掉。
 */
export class AutoSpeakQueue {
  private readonly speak: AutoSpeakRunner
  /**
   * 每一条播完（或确认没出声）的回调。
   *
   * 只有 `played === true` 才能把这条记为「已播」；false 说明被浏览器拦截 / 服务
   * 不可用 / 文本为空——这种消息必须留在「还能再挑」的状态，否则用户点一下喇叭
   * 明明能听，自动播报却因为一次失败永久漏掉它。
   */
  private readonly onResult: ((item: AutoSpeakItem, played: boolean) => void) | undefined
  private items: AutoSpeakItem[] = []
  /**
   * 正在播的那一条。
   *
   * 必须单独记：它已经从 items 里 shift 出去了，既不在排队列表、也还没进
   * spoken（播完才由 onResult 标记）。不记的话，播放期间只要 messages 变一次，
   * 调用方就会把「正在播的这条」当成没念过、重新入队 → 同一条念两遍。
   */
  private current: AutoSpeakItem | null = null
  /** 代次：reset 之后，上一轮的循环必须立刻停（它可能正卡在 await 上）。 */
  private generation = 0
  /** 是否有消费循环在跑（避免重入 / 重复启动）。 */
  private active = false

  constructor(speak: AutoSpeakRunner, onResult?: (item: AutoSpeakItem, played: boolean) => void) {
    this.speak = speak
    this.onResult = onResult
  }

  /** 队列里还有几条没开始念（诊断用）。 */
  get size(): number {
    return this.items.length
  }

  /**
   * 已认领的消息 id：**正在播的那一条 + 排队中还没开播的**。
   *
   * 调用方挑选时要排除它们（否则同一条会在播放期间被反复重挑）。注意必须把
   * `current` 也算上——它已经 shift 出队列，只差 spoken 还没标。
   */
  claimedIds(): string[] {
    const ids = this.items.map((item) => item.id)
    if (this.current !== null) ids.unshift(this.current.id)
    return ids
  }

  /** 入队并自动开始消费（重复调用安全；空数组是空操作）。 */
  enqueue(items: readonly AutoSpeakItem[]): void {
    if (items.length === 0) return
    this.items.push(...items)
    this.start()
  }

  /** 作废整条队列（见类注释：不动正在播的那一条）。 */
  reset(): void {
    this.generation += 1
    this.items.length = 0
  }

  private start(): void {
    if (this.active) return
    this.active = true
    const generation = this.generation
    void this.drain(generation).finally(() => {
      this.active = false
      /*
       * reset 之后又入队了：上一轮循环已经退出，但 active 还没复位时新项只能干等。
       * 这里补一次启动（代次不同才会走到，正常排队不会重复起循环）。
       */
      if (this.items.length > 0 && generation !== this.generation) this.start()
    })
  }

  private async drain(generation: number): Promise<void> {
    while (generation === this.generation) {
      const item = this.items.shift()
      if (item === undefined) return
      this.current = item
      let played = false
      try {
        played = await this.speak(item.text, item.options)
      } catch {
        /*
         * 自动播报失败静默：朗读是锦上添花，弹错只会打扰用户。手动点喇叭的失败
         * 由 SpeakToolButton 自己 toast，不经过这里。
         */
        played = false
      }
      this.current = null
      this.onResult?.(item, played)
      if (!played) {
        /*
         * 没出声（最典型的是浏览器自动播放策略把 AudioContext 拦了）：后面每一条
         * 都会以同样方式失败。整队停掉，别让宿主连续开一堆注定失败的合成请求。
         * 未播项**没有**标已播，下一次 messages 变化还会重新挑——用户点一下喇叭
         * （用户手势）把播放链路恢复后，它们仍然能被念出来。
         */
        this.reset()
        return
      }
    }
  }
}
