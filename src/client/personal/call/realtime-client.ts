/**
 * Personal Agent — 全双工实时通话的浏览器端客户端。
 *
 * 这条链路把原来的半双工通话（点按录音 → DSH ASR → 模型回复 → Edge TTS 播放）
 * 整个替换掉：
 *
 *   麦克风 ──裸 PCM16 二进制帧──▶ 同源 WS /api/personal-agent/realtime ──▶ StepFun Realtime
 *   扬声器 ◀──── audio_delta ───── 同源 WS ◀──────────────────────────────┘
 *
 * 职责边界（三者不重叠）：
 *  · 本文件：建连与重连、上下行帧转发、把服务端事件翻译成回调；
 *  · `realtime-audio.ts`：麦克风采集 / 重采样 / 播放队列（MicStreamer / PcmPlayer）；
 *  · `src/shared/realtime-protocol.ts`：协议常量与类型（两端共享，只读）。
 *
 * ## 为什么上行用二进制帧，而不是 {"type":"audio","audio":"<base64>"}
 *
 * 麦克风每 40ms 一片、每片 1920 字节。走 base64 会膨胀 33%（2560 字节），而且每片
 * 都要多一次前端编码 + 宿主解码；连续说话 30 分钟是 45000 片。二进制帧把这两笔
 * 开销全省掉，宿主收到裸 PCM16 直接转发给上游，连 JSON.parse 都不用。
 * 协议两种都收，JSON 那条留给调试与回放。
 *
 * ## 为什么 speech_started 要立刻清空播放
 *
 * 服务端 VAD 判定「用户开始说话」只有一个含义：**用户在打断 Bot**。如果此时还让
 * 播放队列里剩下的几百毫秒音频放完，会有两个后果：
 *   1. 用户听见 Bot 继续说，觉得「打断没生效」；
 *   2. 扬声器外放的声音被麦克风收进去，服务端再判一次语音，形成自激循环。
 * 所以收到 speech_started 的第一件事就是 player.interrupt()（丢队列 + 停源），
 * 而不是等宿主的 interrupted 帧——那要多一个往返，用户已经听见了。
 *
 * ## 语音里「让它干活」
 *
 * Realtime 会话本身**没有** Bot 的 agent 工具：生图、读写文件、跑命令、记忆这些
 * 都在 agent 那一侧。不传 agent 定义时，用户说「帮我生成一张图」，模型只能回
 * 「我这边还没有这个功能」——这是实测过的原话。
 *
 * 所以 `start` 帧会带上 `agent`（Bot 的完整定义，见 `RealtimeStartOptions.agent`）。
 * 宿主把它注册成 `run_task` 工具；模型判定要动手时发起 function call，宿主跑真正
 * 的 agent loop，再用 `task_started / task_progress / task_done` 三个事件把进度与
 * 结果推回浏览器（本文件只做透传，界面在 CallOverlay 里显示）。
 *
 * 关键约定：**任务与对话并行**。任务执行期间麦克风照常上行、播放照常继续，用户
 * 可以随时插话——`task_started` 里刻意不做任何音频操作。
 *
 * ## 重连策略
 *
 * 整通电话**最多自动重连一次**，且只在「可重试」的失败上做：
 *   · 上游网络抖动 / 连接被重置（宿主 error 帧 retryable=true、WS 1006）；
 *   · 建连 15 秒还没收到 ready（宿主路由没挂 / 上游卡住）。
 * 鉴权失败、模型不存在、额度不足这类重试一万次也一样，直接报错让用户处理。
 * 为什么只一次：重连要重建 AudioContext 与麦克风，服务端会话上下文也已经丢了；
 * 无限重连只会让用户对着「重新接通中」的界面干等，一次失败后如实报错更诚实。
 */

import {
  REALTIME_PATH,
  REALTIME_SAMPLE_RATE,
  parseServerMessage,
  type RealtimeAgentSpec,
  type RealtimeArtifact,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
} from '../../../shared/realtime-protocol.ts'
import { MicStreamer, PcmPlayer, base64ToPcm16 } from './realtime-audio.ts'

/** 建连后等 ready 的超时：宿主没挂路由 / 上游卡死时不能无限等。 */
const READY_TIMEOUT_MS = 15_000

/** 自动重连次数上限（见文件头「重连策略」）。 */
const MAX_RECONNECTS = 1

/** 重连前的等待：给宿主释放旧上游会话、给浏览器回收旧 AudioContext 留时间。 */
const RECONNECT_DELAY_MS = 800

/**
 * 上行背压阈值（字节）。
 *
 * WebSocket 的 bufferedAmount 是「已交给内核但还没发出去」的字节数。网络跟不上时
 * 它只增不减，继续塞只会让延迟越积越大（听到的回答和画面字幕差十几秒），最后连
 * 内存一起爆。超过阈值就丢**新**片：丢旧的做不到（已排队），丢新片只是音频有空洞，
 * 服务端 VAD 会当作环境噪声，比无限积压好得多。
 */
const MAX_BUFFERED_BYTES = 512 * 1024

/** 链路状态（与通话的业务阶段分开：业务阶段在 ui.call.status 里）。 */
export type RealtimeLinkState = 'idle' | 'connecting' | 'reconnecting' | 'open' | 'closed'

/** 会话就绪信息（宿主 ready 帧）。 */
export interface RealtimeReadyInfo {
  model: string
  voice: string
  sampleRate: number
  maxSessionMs: number
}

/** 一次可读的链路错误。 */
export interface RealtimeCallError {
  /** 已翻译成中文的原因，可以直接展示给用户。 */
  message: string
  code?: string | number
  /** 是否值得自动重连（见文件头「重连策略」）。 */
  retryable: boolean
}

/** 发起一次实时会话的参数。 */
export interface RealtimeStartOptions {
  botId: string
  /** Bot 人设。语音约束由宿主 `wrapVoiceInstructions` 追加，前端不要重复。 */
  instructions?: string
  voice?: string
  /** 指定模型（只试这一个，不做回退）；留空走宿主的候选链。 */
  model?: string
  /**
   * 用哪个 Live（全双工语音）供应商（`RealtimeVendorRecord.id`）。
   *
   * Bot 上单独选过就传它；不传时宿主回落到全局默认，再没有就取供应商列表第一条。
   * **空值不要写进帧**（见 `sendStart`）：宿主区分「字段缺失」与「显式给空」，
   * 传空串会变成「显式指定一个空 id」，不是「跟随默认」。
   */
  vendor?: string
  /**
   * @deprecated 已废弃，宿主忽略。Live 配置不再按聊天供应商路由读取，改由
   * 「Live 供应商列表 + Bot 上的 `vendor`」决定（见 `src/host/personal/realtime`）。
   * 字段保留只为不破坏调用方，新代码不要依赖它。
   */
  route?: string
  /**
   * Bot 的完整 agent 定义。
   *
   * **Realtime 模型本身没有 agent 的工具**（生图 / 读写文件 / 跑命令 / 记忆），
   * 不带这份定义，用户说「帮我生成一张图」时它只能回「我没有这个功能」。
   * 带上之后宿主会把它注册成 `run_task` 工具：模型判定要动手时发起 function call，
   * 宿主跑真正的 agent loop，结果再回传给模型用语音讲出来。
   *
   * 字段从 localStorage 的 Bot 记录 + 该 Bot 的记忆拼出来（见 store 的 callAgentSpec）。
   */
  agent?: RealtimeAgentSpec
}

/** 事件回调。全部可选：调用方只关心自己需要的那几条。 */
export interface RealtimeCallHandlers {
  /** 链路状态变化。 */
  onLinkState?(state: RealtimeLinkState): void
  /** 会话就绪（可以开始说话/打字了）。 */
  onReady?(info: RealtimeReadyInfo): void
  /** 服务端 VAD 判定用户开始说话（已在内部清空播放队列）。 */
  onSpeechStarted?(): void
  /**
   * 服务端 VAD 判定用户说完。
   *
   * @param itemId 这一轮用户音频的会话项 id。它与随后
   *   `conversation.item.input_audio_transcription.completed` 的 `item_id` 是同一个，
   *   用来把「说完」和「转写」精确配对（ASR 是异步的，转写可能晚于 Bot 的回复到达）。
   */
  onSpeechStopped?(itemId?: string): void
  /**
   * 用户这一轮的 ASR 结果（服务端自动识别）。
   * @param text 转写文本。
   * @param itemId 对应 `onSpeechStopped` 的 itemId，用于还原真实对话顺序。
   */
  onUserTranscript?(text: string, itemId?: string): void
  /**
   * Bot 转写。
   * @param text final=false 时是增量；final=true 时是整段完整转写。
   */
  onBotTranscript?(text: string, final: boolean): void
  /** Bot 的纯文本增量（文本模态开着时才有，用作字幕兜底）。 */
  onBotText?(delta: string): void
  /** 思考过程增量。 */
  onThinkingDelta?(delta: string): void
  /** 思考过程结束（完整文本）。 */
  onThinkingDone?(thinking: string): void
  /** 一轮响应开始。 */
  onResponseCreated?(): void
  /**
   * Bot 真的开始出声了（首个 audio_delta 到达，一轮只回调一次）。
   *
   * 与 `onResponseCreated` 分开：响应开始只说明模型在生成，可能还在思考；界面要
   * 等第一片音频才切「在说」，否则会出现「显示正在说，但一个字都听不到」。
   */
  onSpeakingStart?(): void
  /** 一轮响应结束（completed / cancelled / failed / incomplete）。 */
  onResponseDone?(status: string): void
  /** 打断已生效。 */
  onInterrupted?(): void
  /**
   * 语音里让 Bot 干活了：模型判定要执行实际任务，宿主已把它交给 agent loop 在后台跑。
   *
   * 任务与对话**并行**：执行期间用户还能继续说话（全双工），界面不要锁输入。
   *
   * @param task 任务摘要（模型自己写的，展示给用户看）。
   * @param callId 任务 id，与随后的 progress / done 配对。
   */
  onTaskStarted?(task: string, callId: string): void
  /** 任务进度（工具调用等一句话描述；可选，不是所有 agent 都会给）。 */
  onTaskProgress?(note: string, callId: string): void
  /**
   * 任务结束。
   *
   * @param ok 成功与否。
   * @param text 成功时是一句话结论（summary），失败时是错误原因（error）；
   *   宿主两个都没给就是 undefined。
   * @param callId 对应 `onTaskStarted` 的 id。
   * @param artifacts 这次任务产出的东西（图片 / 视频 / 音频 / 文件）。
   *   调用方要把它们落成**对话流里的消息**——只让模型念一句「生成好了」是不够的，
   *   用户挂断之后要能回头看到那张图。没产物时是 undefined 或空数组。
   */
  onTaskDone?(ok: boolean, text: string | undefined, callId: string, artifacts?: RealtimeArtifact[]): void
  /** 会话即将到期（30 分钟上限）。 */
  onExpiring?(inMs: number): void
  /** 链路错误。retryable 为真时内部会自动重连一次。 */
  onError?(error: RealtimeCallError): void
  /** 链路彻底结束（宿主主动关闭 / 重连也失败）。 */
  onClosed?(reason: string): void
  /** 麦克风不可用（权限拒绝 / 没有设备）。会话仍在，但通话界面只提示重试 / 挂断。 */
  onMicUnavailable?(message: string): void
  /** 麦克风就绪。 */
  onMicReady?(): void
}

/** 拼同源 WebSocket 地址。 */
function realtimeUrl(): string {
  if (typeof location === 'undefined') throw new Error('实时语音只能在浏览器里使用')
  if (location.protocol === 'file:') throw new Error('实时语音需要同源宿主，独立演示页不支持通话')
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}${REALTIME_PATH}`
}

/** 错误文案兜底：宿主已经翻译过一遍，这里只保证空消息也有可读内容。 */
function explainError(message: string, code?: string | number): string {
  const text = message.trim()
  if (text !== '') return text
  return code === undefined ? '实时语音出错' : `实时语音出错（${String(code)}）`
}

/** 简单延时。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 一次实时通话的客户端。
 *
 * 生命周期：`start()` → （ready）→ 说话/打字 → `stop()`。
 * 所有失败都通过 handlers 上报，`start()` 本身不会 reject——调用方是 React 的
 * 点击处理器，抛出去的 rejection 没人接，只会变成控制台噪声。
 */
export class RealtimeCall {
  private readonly handlers: RealtimeCallHandlers
  private options: RealtimeStartOptions | null = null
  private socket: WebSocket | null = null
  private mic: MicStreamer | null = null
  private player: PcmPlayer | null = null
  private link: RealtimeLinkState = 'idle'
  private ready = false
  private stopping = false
  /** 宿主发过 closed 帧（之后的 WS 关闭不再当作异常）。 */
  private serverClosed = false
  /** 收到可重试错误，等 closed/超时后再重连，避免与宿主关连接抢跑。 */
  private pendingRetry = false
  private reconnectAttempts = 0
  private muted = false
  private speakerOn = true
  /**
   * 播放音量（0..1）。跨重连保留：重连会重建 PcmPlayer，新播放器必须沿用用户
   * 在通话界面拖出来的音量，否则每次网络抖一下声音都会跳回 100%。
   */
  private volume = 1
  /** 这一轮是否已经出过声（用于 onSpeakingStart 只回调一次）。 */
  private speaking = false
  /**
   * 上行采样率（Hz）：由宿主 `ready` 帧按供应商下发（千问 16k / StepFun 24k）。
   * 麦克风必须按它重采样，否则声音变调、VAD 时间轴错位。
   */
  private inputSampleRate: number = REALTIME_SAMPLE_RATE
  /** 麦克风权限失败后置真：不再自动重试，等用户点「重试麦克风」。 */
  private micUnavailable = false
  /** 自动播放被浏览器拦过：需要等用户下一次交互才能出声。 */
  private needsGesture = false
  private playRetryAt = 0
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  /** 诊断用：因背压丢掉的音频片数。 */
  private droppedChunks = 0

  constructor(handlers: RealtimeCallHandlers = {}) {
    this.handlers = handlers
  }

  /** 当前链路状态。 */
  get linkState(): RealtimeLinkState {
    return this.link
  }

  /** 是否已经就绪（ready 之后才能说话）。 */
  get isReady(): boolean {
    return this.ready
  }

  /**
   * 发起会话：建 WS → 发 start 帧 → 等 ready → 起麦克风与播放器。
   *
   * 不返回 rejection（见类注释）；失败走 `onError` / `onClosed`。
   */
  async start(options: RealtimeStartOptions): Promise<void> {
    this.options = options
    this.stopping = false
    this.serverClosed = false
    this.pendingRetry = false
    this.reconnectAttempts = 0
    /*
     * 播放器必须在**用户手势链里**建起来：startCall 是点击触发的，此刻同步调用
     * ensureRunning 才能拿到可播放的 AudioContext。等 ready 再建就晚了一次 WS
     * 往返，Chrome 的自动播放策略可能拒绝恢复（表现为「接通了但一点声音都没有」）。
     */
    this.preparePlayer()
    await this.connect()
  }

  /**
   * 建播放器并恢复 AudioContext（幂等）。
   *
   * 失败不致命：`needsGesture` 置真后，每次收到音频会再试一次；用户点一下页面
   * （产生 sticky activation）之后通常就能出声。
   */
  private preparePlayer(): void {
    if (this.player !== null) return
    const player = new PcmPlayer()
    // 先应用音量再起播：第一片音频到达时就是用户上次设定的响度，不会先爆一下 100%
    player.setVolume(this.volume)
    this.player = player
    void player.ensureRunning().catch(() => {
      this.needsGesture = true
    })
  }

  /** 建一条 WS 并发出 start 帧。 */
  private async connect(): Promise<void> {
    if (this.stopping) return
    this.setLink(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting')
    this.ready = false
    // 重连时旧播放器已在 releaseAudio 里关掉，这里重建一个（幂等）
    this.preparePlayer()

    let socket: WebSocket
    try {
      socket = new WebSocket(realtimeUrl())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.handlers.onError?.({ message, retryable: false })
      this.handlers.onClosed?.(message)
      this.shutdown()
      return
    }
    this.socket = socket
    // 宿主只回文本帧；设成 arraybuffer 是为了「将来万一有二进制事件」不被当成 Blob
    socket.binaryType = 'arraybuffer'

    socket.onopen = (): void => {
      if (this.socket !== socket) return
      this.sendStart()
      // start 帧发出去之后才开始等 ready：宿主收到 start 才会去连上游
      this.armReadyTimer()
    }
    socket.onmessage = (event: MessageEvent<unknown>): void => {
      if (this.socket !== socket) return
      this.handleMessage(event)
    }
    socket.onerror = (): void => {
      /*
       * 浏览器出于安全考虑不给任何错误细节（同源策略），这里不报错；
       * 紧接着的 onclose 会带上 code，统一在那里分类。
       */
    }
    socket.onclose = (event: CloseEvent): void => {
      if (this.socket !== socket) return
      this.handleClose(event)
    }
  }

  /** 发 start 帧（带上 Bot 人设、音色覆盖与 agent 定义）。 */
  private sendStart(): void {
    const options = this.options
    if (options === null) return
    const message: RealtimeClientMessage = { type: 'start', botId: options.botId }
    if (options.instructions !== undefined && options.instructions !== '') message.instructions = options.instructions
    if (options.voice !== undefined && options.voice !== '') message.voice = options.voice
    if (options.model !== undefined && options.model !== '') message.model = options.model
    /*
     * Live 供应商：Bot 上单独选过就带上 id；**空值不写帧**，让宿主回落全局默认
     * （`start.vendor` → `defaultVendor` → 列表第一条）。
     */
    if (options.vendor !== undefined && options.vendor !== '') message.vendor = options.vendor
    // 已废弃：只为兼容旧宿主透传，新宿主忽略它（Live 配置由 vendor 决定）
    if (options.route !== undefined && options.route !== '') message.route = options.route
    /*
     * agent 定义每次 start（含重连）都随帧重发：宿主不缓存它，重连后的新会话
     * 同样需要这份定义才能让模型「干活」。空对象没有意义，只认真的带了 botId 的。
     */
    if (options.agent !== undefined && options.agent.botId !== '') message.agent = options.agent
    this.sendJson(message)
  }

  /** 打字输入：走 text 帧，宿主会把它当成一轮用户消息并触发回复。 */
  sendText(text: string): void {
    const value = text.trim()
    if (value === '') return
    // 打字通常意味着用户想打断当前这轮，先把本地播放掐掉
    this.player?.interrupt()
    this.sendJson({ type: 'text', text: value })
  }

  /** 用户主动打断（点按钮）：清本地播放 + 让宿主取消上游响应。 */
  interrupt(): void {
    this.player?.interrupt()
    this.sendJson({ type: 'interrupt' })
  }

  /** 静音：只是不上行有效音频，会话照旧。 */
  setMuted(muted: boolean): void {
    this.muted = muted
    this.mic?.setMuted(muted)
  }

  /** 扬声器开关：关掉时直接丢下行音频，不占解码与内存。 */
  setSpeaker(on: boolean): void {
    this.speakerOn = on
    if (!on) this.player?.interrupt()
  }

  /**
   * 设置播放音量（0..1）。
   *
   * 与扬声器开关的区别：音量 0 仍然保留播放链路（解码、计时、字幕状态都照常），
   * 只是增益归零；扬声器关掉则直接丢音频。通话界面给用户的是前者——拖动条拖到
   * 0 不该让「正在说」的状态判断跟着失效。
   */
  setVolume(volume: number): void {
    const next = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1
    this.volume = next
    this.player?.setVolume(next)
  }

  /** 当前麦克风音量（0..1），供 UI 画波形。 */
  level(): number {
    return this.mic?.level() ?? 0
  }

  /** 麦克风是否可用（不可用时 UI 提示重试 / 挂断；`sendText` 通道仍在，但界面没有入口）。 */
  get microphoneAvailable(): boolean {
    return this.mic !== null
  }

  /** 重试麦克风（用户点了「重试麦克风」）。 */
  async retryMicrophone(): Promise<void> {
    this.micUnavailable = false
    await this.startAudio()
  }

  /** 挂断：通知宿主释放上游 → 停麦克风 → 关播放器 → 断 WS。 */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.clearTimers()
    this.setLink('closed')
    // 先发 stop：宿主收到后回 closed 并关上游；close() 会把已排队数据发完再断
    this.sendJson({ type: 'stop' })
    this.closeSocket()
    await this.releaseAudio()
  }

  /* ------------------------------------------------------------------ */
  /* 内部：消息分发                                                      */
  /* ------------------------------------------------------------------ */

  private handleMessage(event: MessageEvent<unknown>): void {
    if (typeof event.data !== 'string') return
    const message = parseServerMessage(event.data)
    if (message === null) return
    this.dispatch(message)
  }

  private dispatch(message: RealtimeServerMessage): void {
    switch (message.type) {
      case 'ready': {
        this.ready = true
        this.clearReadyTimer()
        /*
         * 上行采样率由宿主按供应商下发（千问 16k / StepFun 24k）。喂错不会报错，
         * 只会变调 + VAD 时间轴错位，所以这里必须用宿主给的值，不能沿用默认。
         */
        const outputRate = typeof message.sampleRate === 'number' && message.sampleRate > 0
          ? message.sampleRate
          : REALTIME_SAMPLE_RATE
        this.inputSampleRate = typeof message.inputSampleRate === 'number' && message.inputSampleRate > 0
          ? message.inputSampleRate
          : outputRate
        this.handlers.onReady?.({
          model: message.model,
          voice: message.voice,
          sampleRate: outputRate,
          maxSessionMs: message.maxSessionMs,
        })
        this.setLink('open')
        void this.startAudio()
        return
      }
      case 'speech_started': {
        // 见文件头：用户一开口就先掐掉本地播放，不等 interrupted 往返
        this.player?.interrupt()
        this.speaking = false
        this.handlers.onSpeechStarted?.()
        return
      }
      case 'speech_stopped': {
        this.handlers.onSpeechStopped?.(message.itemId)
        return
      }
      case 'user_transcript': {
        this.handlers.onUserTranscript?.(message.text, message.itemId)
        return
      }
      case 'bot_transcript_delta': {
        this.handlers.onBotTranscript?.(message.delta, false)
        return
      }
      case 'bot_transcript_done': {
        this.handlers.onBotTranscript?.(message.transcript, true)
        return
      }
      case 'bot_text_delta': {
        this.handlers.onBotText?.(message.delta)
        return
      }
      case 'thinking_delta': {
        this.handlers.onThinkingDelta?.(message.delta)
        return
      }
      case 'thinking_done': {
        this.handlers.onThinkingDone?.(message.thinking)
        return
      }
      case 'audio_delta': {
        this.playAudio(message.audio)
        return
      }
      case 'response_created': {
        this.handlers.onResponseCreated?.()
        return
      }
      case 'response_done': {
        this.speaking = false
        this.handlers.onResponseDone?.(message.status)
        return
      }
      case 'interrupted': {
        this.player?.interrupt()
        this.speaking = false
        this.handlers.onInterrupted?.()
        return
      }
      case 'task_started': {
        /*
         * 任务开始：**不动播放队列、不动麦克风**。任务与对话是并行的——用户可能正
         * 说着下一句，这里掐播放或停麦克风就变成「一让它干活就听不见我说话」。
         */
        this.handlers.onTaskStarted?.(message.task, message.callId)
        return
      }
      case 'task_progress': {
        this.handlers.onTaskProgress?.(message.note, message.callId)
        return
      }
      case 'task_done': {
        // 成功给 summary，失败给 error；宿主两个都没给时回调收到 undefined
        const text = message.ok ? message.summary : message.error
        /*
         * artifacts 原样透传给调用方：本文件不碰渲染，产物怎么落成消息由 store 决定
         * （图片走 image 块、其它走产出物卡）。空数组归一成 undefined，让调用方只判一次。
         */
        const artifacts = message.artifacts !== undefined && message.artifacts.length > 0 ? message.artifacts : undefined
        this.handlers.onTaskDone?.(message.ok === true, text === '' ? undefined : text, message.callId, artifacts)
        return
      }
      case 'expiring': {
        this.handlers.onExpiring?.(message.inMs)
        return
      }
      case 'error': {
        const error: RealtimeCallError = {
          message: explainError(message.message, message.code),
          code: message.code,
          retryable: message.retryable === true,
        }
        this.handlers.onError?.(error)
        /*
         * 可重试错误先挂起，等宿主的 closed 帧到了再重连：
         * 宿主发 error 之后紧接着会发 closed 并关连接，此时立刻重连会和它抢跑，
         * 表现为「刚连上又被上一次的 close 打断」。不可重试的直接结束。
         */
        if (error.retryable) this.pendingRetry = true
        return
      }
      case 'closed': {
        this.serverClosed = true
        const retry = this.pendingRetry && this.canReconnect()
        this.pendingRetry = false
        this.handlers.onClosed?.(message.reason)
        if (retry) void this.reconnect()
        else this.shutdown()
        return
      }
      default:
        return
    }
  }

  /**
   * 下行音频：base64 PCM16 → 播放队列。
   *
   * 扬声器关掉时状态照常切「在说」（它确实在说），但不解码不排队——用户明确表示
   * 不想听，白烧 CPU 与内存没有意义。
   */
  private playAudio(base64: string): void {
    const player = this.player
    if (player === null) return
    // 首片音频到达 = 模型真的开始出声了（response_created 只说明它在生成）
    if (!this.speaking) {
      this.speaking = true
      this.handlers.onSpeakingStart?.()
    }
    if (!this.speakerOn) return
    // 自动播放被拦过：每次收到音频重试恢复（用户随便点一下页面就能出声）
    if (this.needsGesture) {
      const now = Date.now()
      if (now >= this.playRetryAt) {
        this.playRetryAt = now + 2000
        void player.ensureRunning().then(() => {
          this.needsGesture = false
        }).catch(() => undefined)
      }
    }
    try {
      player.enqueue(base64ToPcm16(base64))
    } catch {
      /* 单片坏掉就跳过：不值得为一片音频掐断整通电话 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 内部：音频引擎                                                      */
  /* ------------------------------------------------------------------ */

  private async startAudio(): Promise<void> {
    if (this.stopping) return
    // 播放器通常在 start() 里就建好了（手势链内）；这里只是兜底
    this.preparePlayer()
    if (this.mic !== null || this.micUnavailable) return
    const mic = new MicStreamer(this.inputSampleRate)
    this.mic = mic
    try {
      await mic.start((pcm16) => this.sendAudio(pcm16))
      mic.setMuted(this.muted)
      this.handlers.onMicReady?.()
    } catch (error) {
      this.mic = null
      this.micUnavailable = true
      const message = error instanceof Error ? error.message : String(error)
      // 麦克风挂了不影响会话：用户还能打字，宿主那边照样回语音
      this.handlers.onMicUnavailable?.(message)
    }
  }

  /**
   * 上行一片 PCM16。
   *
   * 用二进制帧（见文件头）；`Int16Array` 交给 WebSocket 时按它的 byteOffset/byteLength
   * 发送，不会带上底层 buffer 的其它字节。
   */
  private sendAudio(pcm16: Int16Array): void {
    const socket = this.socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.droppedChunks += 1
      return
    }
    try {
      socket.send(pcm16)
    } catch {
      /* 正在断开：onclose 会接手 */
    }
  }

  private async releaseAudio(): Promise<void> {
    const mic = this.mic
    this.mic = null
    if (mic !== null) {
      try {
        await mic.stop()
      } catch {
        /* 已经释放 */
      }
    }
    const player = this.player
    this.player = null
    if (player !== null) {
      try {
        await player.close()
      } catch {
        /* 已经关闭 */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 内部：连接生命周期                                                  */
  /* ------------------------------------------------------------------ */

  private handleClose(event: CloseEvent): void {
    this.socket = null
    this.clearReadyTimer()
    if (this.stopping) return
    // 宿主发过 closed：重连与否已在 dispatch('closed') 里决定过
    if (this.serverClosed) return
    const wasReady = this.ready
    this.ready = false
    if (this.canReconnect()) {
      this.handlers.onError?.({
        message: wasReady
          ? `实时语音连接断开（${event.code}），正在重连…`
          : `实时语音连接失败（${event.code}），正在重试…`,
        retryable: true,
      })
      void this.reconnect()
      return
    }
    const suffix = event.reason === '' ? '' : `：${event.reason}`
    this.handlers.onClosed?.(`实时语音连接已断开（${event.code}${suffix}）`)
    this.shutdown()
  }

  private canReconnect(): boolean {
    return !this.stopping && this.reconnectAttempts < MAX_RECONNECTS
  }

  private async reconnect(): Promise<void> {
    if (this.stopping) return
    this.reconnectAttempts += 1
    this.pendingRetry = false
    this.serverClosed = false
    this.ready = false
    this.setLink('reconnecting')
    this.clearTimers()
    this.closeSocket()
    // 先把麦克风与播放器放掉再重连，否则会有两份采集/两份播放叠在一起
    await this.releaseAudio()
    await delay(RECONNECT_DELAY_MS)
    if (this.stopping) return
    await this.connect()
  }

  private armReadyTimer(): void {
    this.clearReadyTimer()
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null
      if (this.ready || this.stopping) return
      const message = `实时语音连接超时（${Math.round(READY_TIMEOUT_MS / 1000)} 秒内没有收到会话就绪）`
      this.handlers.onError?.({ message, retryable: true })
      if (this.canReconnect()) {
        void this.reconnect()
        return
      }
      this.handlers.onClosed?.(message)
      this.shutdown()
    }, READY_TIMEOUT_MS)
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer)
    this.readyTimer = null
  }

  private clearTimers(): void {
    this.clearReadyTimer()
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    try {
      socket.close(1000, 'client hangup')
    } catch {
      /* 已经断开 */
    }
  }

  /** 彻底收尾（幂等）。 */
  private shutdown(): void {
    this.stopping = true
    this.clearTimers()
    this.closeSocket()
    void this.releaseAudio()
    this.setLink('closed')
  }

  private sendJson(message: RealtimeClientMessage): void {
    const socket = this.socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(message))
    } catch {
      /* 正在断开：onclose 会接手 */
    }
  }

  private setLink(state: RealtimeLinkState): void {
    if (this.link === state) return
    this.link = state
    this.handlers.onLinkState?.(state)
  }

  /** 诊断信息（宿主日志 / 控制台排查用，不进 UI）。 */
  diagnostics(): { link: RealtimeLinkState; ready: boolean; droppedChunks: number; mic: boolean; speaker: boolean; muted: boolean } {
    return {
      link: this.link,
      ready: this.ready,
      droppedChunks: this.droppedChunks,
      mic: this.mic !== null,
      speaker: this.speakerOn,
      muted: this.muted,
    }
  }
}
