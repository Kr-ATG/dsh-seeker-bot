/**
 * 回复气泡朗读（TTS）：把一段文字合成成音频。
 *
 * ## 为什么复用实时语音链路，而不是另接一套 TTS
 *
 * 用户的心智是「我在通话里配好的声音，聊天里朗读也该是同一个」。再让他填一套
 * TTS 模型与音色，等于同一个 Bot 有两个嗓子。所以这里连的是**同一个** Realtime
 * 上游、同一份 Live 供应商配置（见 shared/realtime-protocol.ts 的 REALTIME_TTS_PATH）。
 *
 * ## 一次朗读 = 一次性的实时会话
 *
 * Realtime API 没有「一次性合成」端点，只能开一条会话、让它念完、再关掉：
 *
 *   connectUpstream → session.update（只朗读指令 + 音色）→ 等 session.created
 *     → conversation.item.create(user, text) + response.create
 *     → 收 response.audio.delta（base64 PCM16）→ response.done → 关连接
 *
 * ## 两种交付形态
 *
 * - `synthesizeSpeech`：把整段 PCM 收集起来套 WAV 头一次性返回（旧前端 / 测试用）；
 * - `synthesizeSpeechStream`：**收到一片就交出去一片**，路由层立刻写进 chunked 响应。
 *   用户点喇叭后听到第一个字的时间从「整段合成完」降到「建连 + 首包」，这是实测
 *   「播放延迟太高」的直接解法。
 *
 * ## 与通话的三个关键差异（每一个都对应一类「听起来不对」的故障）
 *
 * 1. **不注册任何 tools**。给朗读会话 web_search / run_task，模型会自作主张去搜，
 *    用户听到的就不是这条回复的内容了。
 * 2. **不带 turn_detection**。一次性合成没有麦克风上行，开 VAD 只会让上游干等一段
 *    永远不会来的语音。
 * 3. **收到 session.created 就发文字，不等 session.updated**（见 `speakOnce` 里的注释）。
 *    旧实现等 updated 才发，白白多花一次往返——正是延迟来源之一。
 *
 * 本文件不依赖 cordis，纯 node 实现，便于离线端到端测试（scripts/test-realtime-tts.mjs）。
 */

import {
  REALTIME_MODELS,
  REALTIME_TTS_MAX_CHARS,
  buildRealtimeUpstreamUrl,
  speakInstructions,
  speedToSpeechRate,
  vendorProfile,
  type RealtimeSpeed,
  type RealtimeTtsRequest,
  type RealtimeVendorProfile,
  type RealtimeVendorRecord,
} from '../../../shared/realtime-protocol.ts'
import { connectUpstream, UpstreamError } from './upstream.ts'
import type { WsPeer, WsPeerHandlers } from './ws-frame.ts'

/** WAV 头的固定字节数（RIFF + fmt + data 三个 chunk 的头）。 */
const WAV_HEADER_BYTES = 44

/**
 * 整次朗读的默认超时。
 *
 * 计时的是**合成耗时**，不是音频时长：上游是流式吐音频的，400 字大概能出 1~2 分钟
 * 音频，但生成通常比实时快好几倍。30 秒是「慢到这个程度就不等了」的兜底；真要放宽
 * 走 `createRealtimeTtsHandler` 的第二个参数（tts.timeoutMs），不用改这里。
 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 连上上游之后，等多久还没收到 `session.created` 就自己发朗读请求。
 *
 * 正常上游在握手完成后立刻推 `session.created`（通常个位数毫秒），这个兜底只防
 * 「某些实现不发 session.created」把整次朗读卡死——不发也就 800ms 后照常出声，
 * 而不是一直等到 30 秒总超时。
 */
const SESSION_READY_FALLBACK_MS = 800

/** 一次非流式朗读的结果。 */
export interface TtsResult {
  /** 完整 WAV（44 字节头 + PCM16 单声道）。 */
  wav: Buffer
  /** 采样率（Hz），与 WAV 头里的一致。 */
  sampleRate: number
  /** 音频时长（毫秒）。 */
  durationMs: number
  /** 实际用的 Live 供应商 id。 */
  vendor: string
  /** 实际用的模型名。 */
  model: string
  /** 实际用的音色 id。 */
  voice: string
  /** 实际朗读的字符数（截断之后）。 */
  chars: number
}

/**
 * 流式朗读的元信息（也是每一片音频回调里的 `meta`）。
 *
 * 音频本身不进这个对象：流式模式下它已经通过 `onChunk` 交给调用方了，再攒一份
 * 只是白占内存——而「不攒」正是流式的意义。
 */
export interface TtsStreamMeta {
  /** 采样率（Hz）。前端据此建播放器 / 重采样。 */
  sampleRate: number
  /** 实际用的 Live 供应商 id。 */
  vendor: string
  /** 实际用的模型名。 */
  model: string
  /** 实际用的音色 id。 */
  voice: string
  /** 实际朗读的字符数（截断之后）。 */
  chars: number
}

/**
 * 朗读失败。
 *
 * `status` 是**建议**回给浏览器的 HTTP 状态码：请求本身有问题（空文本）用 4xx，
 * 上游/配置问题用 502，超时用 504，客户端主动取消用 499。
 *
 * `started` 表示**音频已经开始往外流了**（流式模式）。路由层看到它为真时只能断流，
 * 不能再写 JSON 错误体——那会把「半截 PCM」的响应变成「PCM + JSON」的垃圾数据。
 */
export class TtsError extends Error {
  /** 建议的 HTTP 状态码。 */
  readonly status: number
  /** 是否已经有音频流出去了（流式模式下才可能为真）。 */
  readonly started: boolean

  constructor(message: string, status = 502, started = false) {
    super(message)
    this.name = 'TtsError'
    this.status = status
    this.started = started
  }
}

/**
 * 宿主侧注入的能力。
 *
 * 字段与 `RealtimeOptions` 同名同义，路由层直接透传即可——朗读与通话读的必须是
 * 同一份配置，两边各定义一套只会让「通话里换了音色、朗读没换」变成可能。
 */
export interface TtsOptions {
  /** 取 API Key（与通话同一个解析器，key 只留在宿主进程里）。 */
  resolveApiKey: (keyRef?: string) => Promise<string | null>
  /** 按 id 找 Live 供应商；空/找不到由实现方回落到全局默认。 */
  resolveVendor?: (id?: string) => RealtimeVendorRecord | null
  /** 全局默认音色（Bot / 请求没指定时用）。 */
  voice?: () => string | undefined
  /** 全局语速档位。 */
  speed?: () => RealtimeSpeed | undefined
  /** 模型候选（按顺序回退）。 */
  models?: () => readonly string[] | undefined
  /** 日志出口。 */
  log?: (message: string) => void
  /** 整次朗读的总超时（建连 + 合成），默认 30 秒。 */
  timeoutMs?: number
}

/**
 * 给 PCM16 单声道数据套一个 44 字节的 WAV 头。
 *
 * 为什么自己拼而不引第三方库：宿主 bundle 必须零第三方依赖（见 build.mjs 的
 * external: []），而 WAV 头是公开规范里最没有歧义的一段——44 字节、三个 chunk。
 *
 * 头里的两个长度字段是**最容易写错**的地方：RIFF chunk 的 size 是「文件长度 - 8」，
 * data chunk 的 size 是纯 PCM 字节数（不含头）。写错的表现是浏览器能解码但时长
 * 显示成 0、或播放到一半被截断。
 *
 * @param pcm PCM16 小端单声道数据。
 * @param sampleRate 采样率（Hz）。
 * @returns 完整 WAV 文件内容。
 */
export function encodeWav(pcm: Buffer, sampleRate: number): Buffer {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 24_000
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = rate * blockAlign
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk 长度（PCM 固定 16）
  header.writeUInt16LE(1, 20) // 1 = PCM 整数
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** 一次朗读请求解析后的全部参数（两个入口共用，避免校验逻辑各写一遍漂移）。 */
interface ResolvedSpeech {
  text: string
  vendor: RealtimeVendorRecord
  key: string
  voice: string
  speed: RealtimeSpeed | undefined
  profile: RealtimeVendorProfile
  sampleRate: number
  models: readonly string[]
  timeoutMs: number
}

/**
 * 校验请求并解析出「用哪个供应商 / 哪把 key / 什么音色语速 / 试哪些模型」。
 *
 * @throws {TtsError} 文本为空、没配供应商、没配凭据。
 */
async function resolveSpeech(options: TtsOptions, request: RealtimeTtsRequest): Promise<ResolvedSpeech> {
  /*
   * 文本：先 trim 再截断。
   *
   * 截断放在宿主而不是只靠前端，是因为前端可能来自旧版本页面；而 400 字以上的
   * 正文上游要念一两分钟、响应体涨到几 MB，用户真正想听的也不是整篇长文。
   * 用 UTF-16 长度截断（`slice`）与前端保持同一口径——两边算法不一致时会出现
   * 「前端显示 400 字、宿主实际念了 398 字」这种对不上的怪现象。
   */
  const raw = typeof request.text === 'string' ? request.text.trim() : ''
  if (raw === '') throw new TtsError('没有要朗读的文字', 400)
  const text = raw.length > REALTIME_TTS_MAX_CHARS ? raw.slice(0, REALTIME_TTS_MAX_CHARS) : raw

  /*
   * 供应商：请求里指定的 id → 实现方的全局默认 → 列表第一条（都在 resolveVendor 里）。
   * 朗读不单独存配置，读的就是通话那份 Live 供应商列表。
   */
  const vendor = options.resolveVendor?.(request.vendor) ?? null
  if (vendor === null) {
    throw new TtsError(
      '还没有配置任何 Live 供应商：朗读复用「通话」那套语音配置，先到「设置 → 供应商 → 实时语音」里新增一个',
      502,
    )
  }

  let key: string | null
  try {
    key = await options.resolveApiKey(vendor.keyRef)
  } catch (error) {
    throw new TtsError(`读取语音凭据失败：${error instanceof Error ? error.message : String(error)}`, 502)
  }
  if (key === null || key.trim() === '') {
    throw new TtsError(
      `Live 供应商「${vendor.label}」的凭据「${vendor.keyRef}」还没配：到「设置 → 供应商 → 实时语音」里粘贴 API Key，或到 DSH 凭据里补上`,
      502,
    )
  }

  const profile = vendorProfile(vendor.id)
  const requestedVoice = typeof request.voice === 'string' ? request.voice.trim() : ''
  const configuredVoice = String(options.voice?.() ?? '').trim()
  const voice = requestedVoice !== '' ? requestedVoice : (configuredVoice !== '' ? configuredVoice : profile.defaultVoice)
  /*
   * 语速：请求 > 全局默认 > 正常。只认三个已知档位——JSON 里可能是任意字符串，
   * 直接塞进 speech_rate 会算出 NaN 并被上游拒掉整条 session.update。
   */
  const candidateSpeed = request.speed ?? options.speed?.()
  const speed: RealtimeSpeed | undefined = candidateSpeed === 'slow' || candidateSpeed === 'fast' || candidateSpeed === 'normal'
    ? candidateSpeed
    : undefined
  /*
   * 采样率：Live 供应商上单独配过就以它为准（config-store 允许覆盖），否则用预设。
   * 写进 WAV 头 / 响应头的采样率必须和上游**实际**吐的一致，否则播放会变速。
   */
  const configuredRate = Number(vendor.outputSampleRate)
  const sampleRate = Number.isFinite(configuredRate) && configuredRate > 0
    ? Math.round(configuredRate)
    : profile.outputSampleRate
  /*
   * 模型候选：请求显式指定（只试这一个）→ 该供应商配的模型 → 宿主候选链。
   * 与通话的 start 帧同一套优先级——用户在设置里改了模型，朗读跟着改。
   */
  const explicitModel = typeof request.model === 'string' ? request.model.trim() : ''
  const vendorModel = String(vendor.model ?? '').trim()
  const candidates = explicitModel !== ''
    ? [explicitModel]
    : (vendorModel !== '' ? [vendorModel] : (options.models?.() ?? REALTIME_MODELS))
  const models = candidates.length === 0 ? REALTIME_MODELS : candidates
  const configuredTimeout = Number(options.timeoutMs)
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.round(configuredTimeout)
    : DEFAULT_TIMEOUT_MS
  return { text, vendor, key, voice, speed, profile, sampleRate, models, timeoutMs }
}

/** 这个错误之后还要不要试下一个模型。 */
function shouldTryNextModel(error: Error): boolean {
  // 鉴权类错误换模型也没用（与通话的模型回退同一条规则）
  if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) return false
  // 文本/请求本身的问题重试也只是白烧一次上游调用
  if (error instanceof TtsError && error.status === 400) return false
  // 音频已经流出去一半了，换模型重来只会让用户听到两段拼不上的声音
  if (error instanceof TtsError && error.started) return false
  return true
}

/** 所有模型都失败后，把最后的错误翻成一句可读的中文。 */
function finalTtsError(lastError: Error | null): TtsError {
  if (lastError instanceof TtsError) return lastError
  const reason = lastError === null ? '上游不可用' : lastError.message
  return new TtsError(`朗读失败：${reason}`, 502)
}

/** 把一次模型尝试失败记进日志（两种形态共用，措辞保持一致）。 */
function logModelFailure(log: (message: string) => void, model: string, error: Error): void {
  const detail = error instanceof UpstreamError && error.status !== undefined ? `HTTP ${error.status}` : '失败'
  log(`[tts] 模型 ${model} ${detail}：${error.message}`)
}

/**
 * 把一段文字合成成 WAV（整段返回，旧前端 / 测试用）。
 *
 * @param options 宿主能力（凭据 / 供应商 / 音色 / 语速 / 模型候选）。
 * @param request 朗读请求（文本 + 可选覆盖项）。
 * @returns WAV 与本次合成实际用的参数（前端要显示时长、排查时要看是哪个音色）。
 * @throws {TtsError} 文本为空、没配供应商/凭据、上游报错、超时。
 */
export async function synthesizeSpeech(options: TtsOptions, request: RealtimeTtsRequest): Promise<TtsResult> {
  const log = options.log ?? ((): void => {})
  const resolved = await resolveSpeech(options, request)
  const base = {
    apiKey: resolved.key,
    voice: resolved.voice,
    speed: resolved.speed,
    profile: resolved.profile,
    text: resolved.text,
    timeoutMs: resolved.timeoutMs,
    log,
  }

  let lastError: Error | null = null
  for (const model of resolved.models) {
    try {
      const pcm = await speakOnce({ ...base, model, url: buildRealtimeUpstreamUrl(resolved.vendor.upstream, model) })
      const durationMs = Math.round((pcm.length / 2 / resolved.sampleRate) * 1000)
      log(`[tts] 合成完成 vendor=${resolved.vendor.id} model=${model} voice=${resolved.voice} chars=${resolved.text.length} pcm=${pcm.length} 用时${durationMs}ms`)
      return {
        wav: encodeWav(pcm, resolved.sampleRate),
        sampleRate: resolved.sampleRate,
        durationMs,
        vendor: resolved.vendor.id,
        model,
        voice: resolved.voice,
        chars: resolved.text.length,
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      logModelFailure(log, model, lastError)
      if (!shouldTryNextModel(lastError)) break
    }
  }
  throw finalTtsError(lastError)
}

/**
 * 把一段文字合成成裸 PCM16 流：**每收到一片就回调一片**，不等整段合成完。
 *
 * 这是「播放延迟太高」的解法。非流式要等 `response.done`（整段合成完）才能回包，
 * 用户点喇叭后要干等几秒到几十秒；流式下首字延迟降到「建连 + 首包」。
 *
 * @param options 宿主能力。
 * @param request 朗读请求。
 * @param onChunk 每片 PCM16（小端单声道）回调一次；`meta` 每次都是同一份。
 * @param signal 客户端断开时中止（会关掉上游连接，不留下孤儿会话）。
 * @returns 本次合成实际用的参数。
 * @throws {TtsError} 首包前失败（`started === false`，路由层可以回 JSON）；
 *   首包后失败（`started === true`，路由层只能断流）。
 */
export async function synthesizeSpeechStream(
  options: TtsOptions,
  request: RealtimeTtsRequest,
  onChunk: (chunk: Buffer, meta: TtsStreamMeta) => void,
  signal?: AbortSignal,
): Promise<TtsStreamMeta> {
  const log = options.log ?? ((): void => {})
  const resolved = await resolveSpeech(options, request)
  const base = {
    apiKey: resolved.key,
    voice: resolved.voice,
    speed: resolved.speed,
    profile: resolved.profile,
    text: resolved.text,
    timeoutMs: resolved.timeoutMs,
    log,
    signal,
  }

  let lastError: Error | null = null
  for (const model of resolved.models) {
    const meta: TtsStreamMeta = {
      sampleRate: resolved.sampleRate,
      vendor: resolved.vendor.id,
      model,
      voice: resolved.voice,
      chars: resolved.text.length,
    }
    try {
      await speakOnce({
        ...base,
        model,
        url: buildRealtimeUpstreamUrl(resolved.vendor.upstream, model),
        onChunk: (chunk: Buffer) => {
          /*
           * 回调方（路由层）自己吞掉写失败并 abort；这里再包一层，是为了不让一个
           * 写响应的异常把「上游连接」这条线搞脏——收尾统一走 signal / 超时。
           */
          try {
            onChunk(chunk, meta)
          } catch {
            /* 路由层会 abort，这里忽略 */
          }
        },
      })
      log(`[tts] 流式合成完成 vendor=${resolved.vendor.id} model=${model} voice=${resolved.voice} chars=${resolved.text.length}`)
      return meta
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      logModelFailure(log, model, lastError)
      if (!shouldTryNextModel(lastError)) break
    }
  }
  throw finalTtsError(lastError)
}

/** `speakOnce` 的入参（拆出来只为让主流程短一点）。 */
interface SpeakOnceOptions {
  url: string
  apiKey: string
  model: string
  voice: string
  speed: RealtimeSpeed | undefined
  profile: RealtimeVendorProfile
  text: string
  timeoutMs: number
  log: (message: string) => void
  /** 每收到一片 PCM 就回调（流式）。不传则把整段攒起来返回。 */
  onChunk?: (chunk: Buffer) => void
  /** 客户端断开时中止。 */
  signal?: AbortSignal
}

/**
 * 开一条一次性会话，把文字念完。
 *
 * 全程用「一个 Promise + 事件回调」而不是 async/await 串起来：上游事件是回调进来的，
 * 超时、取消、断开又随时可能先到，谁先到就由谁 settle（settle 一次后其余全部忽略）。
 *
 * @returns 非流式：完整 PCM16；流式：空 Buffer（音频已经通过 onChunk 交出去了）。
 */
function speakOnce(options: SpeakOnceOptions): Promise<Buffer> {
  const { url, apiKey, model, voice, speed, profile, text, timeoutMs, log, onChunk, signal } = options
  const streaming = onChunk !== undefined
  const chunks: Buffer[] = []
  return new Promise<Buffer>((resolve, reject) => {
    let peer: WsPeer | null = null
    let finished = false
    /** 上游连接已建立且 session.update 已发出。 */
    let connected = false
    /** 已经可以发朗读请求（收到 session.created / session.updated，或兜底到点）。 */
    let sessionReady = false
    /** 朗读请求已发出（只发一次）。 */
    let promptSent = false
    /** 是否已经收到过音频（决定错误要不要标 started）。 */
    let gotAudio = false
    let readyTimer: NodeJS.Timeout | null = null
    let totalTimer: NodeJS.Timeout | null = null
    let abortListener: (() => void) | null = null

    const cleanup = (): void => {
      if (readyTimer !== null) {
        clearTimeout(readyTimer)
        readyTimer = null
      }
      if (totalTimer !== null) {
        clearTimeout(totalTimer)
        totalTimer = null
      }
      if (signal !== undefined && abortListener !== null) {
        signal.removeEventListener('abort', abortListener)
        abortListener = null
      }
      const current = peer
      peer = null
      connected = false
      if (current !== null) {
        // 关连接是流程的一部分：每次朗读都新开一条会话，不关就会一直占上游并发
        try {
          current.close(1000, 'tts done')
        } catch {
          current.destroy()
        }
      }
    }

    const fail = (error: Error): void => {
      if (finished) return
      finished = true
      cleanup()
      /*
       * 流式且已经吐过音频：路由层此刻只能断流，再写 JSON 错误体会把「半截 PCM」
       * 变成「PCM + JSON」的垃圾。用 started 标出来，让路由层据此决定收尾方式。
       */
      if (streaming && gotAudio && !(error instanceof TtsError && error.started)) {
        reject(new TtsError(error.message, error instanceof TtsError ? error.status : 502, true))
        return
      }
      reject(error)
    }

    const succeed = (): void => {
      if (finished) return
      finished = true
      cleanup()
      resolve(streaming ? Buffer.alloc(0) : Buffer.concat(chunks))
    }

    /** 真正把朗读请求写出去（会话已连上、且已经可以发）。 */
    const sendPrompt = (): void => {
      if (promptSent || finished || !connected || peer === null) return
      promptSent = true
      peer.sendText(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      }))
      peer.sendText(JSON.stringify({ type: 'response.create' }))
      log(`[tts] 已下发朗读请求 model=${model} chars=${text.length}`)
    }

    /**
     * 宣布会话就绪并立刻发朗读请求。
     *
     * **不等 `session.updated`**：WebSocket 帧在一条连接上严格有序，我们那条
     * `session.update` 一定先于紧接着的 `conversation.item.create` 被上游处理
     * （同一条 TCP 连接、同一个服务端会话，没有乱序可能）。等 updated 只是为了
     * 「确认生效」，代价是整整一次往返——真实上游 100~300ms，正好是用户抱怨的
     * 「点喇叭半天不响」的一部分。
     *
     * 代价：万一上游因为某个字段拒了 session.update（例如音色 id 不存在），这次
     * 朗读会用默认音色念完——声音不对，但至少出声，也不会卡住。比每次都干等
     * 一次往返划算。
     */
    const markSessionReady = (reason: string): void => {
      if (sessionReady) return
      sessionReady = true
      if (readyTimer !== null) {
        clearTimeout(readyTimer)
        readyTimer = null
      }
      log(reason)
      sendPrompt()
    }

    const handlers: WsPeerHandlers = {
      onMessage: (raw: string) => {
        let event: Record<string, unknown>
        try {
          const parsed = JSON.parse(raw) as unknown
          if (parsed === null || typeof parsed !== 'object') return
          event = parsed as Record<string, unknown>
        } catch {
          return
        }
        const type = typeof event.type === 'string' ? event.type : ''
        if (type === 'session.created') {
          markSessionReady('[tts] 收到 session.created，立即下发朗读请求（不等 session.updated）')
          return
        }
        if (type === 'session.updated') {
          // 少数上游可能不发 created；updated 同样说明会话就绪，谁先到用谁
          markSessionReady('[tts] 收到 session.updated，下发朗读请求')
          return
        }
        if (type === 'response.audio.delta') {
          // 下行是 base64 的 PCM16 分片：流式直接转交，非流式攒起来
          const delta = typeof event.delta === 'string'
            ? event.delta
            : (typeof event.audio === 'string' ? event.audio : '')
          if (delta === '') return
          const chunk = Buffer.from(delta, 'base64')
          if (chunk.length === 0) return
          gotAudio = true
          if (onChunk !== undefined) onChunk(chunk)
          else chunks.push(chunk)
          return
        }
        if (type === 'response.done') {
          if (!gotAudio) {
            /*
             * 一轮响应结束了却一帧音频都没有：最常见的原因是模型没按「只朗读」的指令
             * 说话（或音色/模型不支持音频输出）。返回一个只有头的空 WAV 会让前端
             * 播放一段静音、用户以为朗读坏了却没有任何提示。
             */
            fail(new TtsError('朗读失败：上游没有返回音频（模型可能没有按「只朗读」的指令说话）', 502))
            return
          }
          succeed()
          return
        }
        if (type === 'error') {
          // 上游两种错误形状都认（与 session.ts 的 mapUpstreamEvent 同一口径）
          const nested = event.error !== null && typeof event.error === 'object'
            ? event.error as Record<string, unknown>
            : null
          const message = String(nested?.message ?? event.message ?? '上游返回错误')
          fail(new TtsError(`朗读失败：上游报错（${message}）`, 502))
        }
      },
      onClose: (code: number, reason: string) => {
        if (finished) return
        const detail = reason === '' ? String(code) : `${code}：${reason}`
        fail(new TtsError(`朗读中断：上游连接已断开（${detail}）`, 502))
      },
      onError: (error: Error) => {
        // 不在这里 fail：WsPeer 报错后一定会跟着 onClose，那边统一收口
        log(`[tts] 上游连接错误：${error.message}`)
      },
    }

    totalTimer = setTimeout(() => {
      fail(new TtsError(`朗读超时（${Math.round(timeoutMs / 1000)} 秒内没有拿到完整音频）`, 504))
    }, timeoutMs)
    totalTimer.unref?.()

    if (signal !== undefined) {
      abortListener = (): void => {
        fail(new TtsError('朗读已取消（客户端已断开）', 499))
      }
      if (signal.aborted) {
        fail(new TtsError('朗读已取消（客户端已断开）', 499))
        return
      }
      signal.addEventListener('abort', abortListener)
    }

    void (async () => {
      if (finished) return
      try {
        const upstream = await connectUpstream({ url, apiKey, handlers })
        if (finished) {
          upstream.close(1000, 'aborted')
          return
        }
        peer = upstream
        connected = true
        upstream.sendText(JSON.stringify(buildTtsSessionUpdate({
          instructions: speakInstructions(speed),
          voice,
          profile,
          speechRate: speedToSpeechRate(speed),
        })))
        /*
         * 兜底定时器从「连接建立」开始算，而不是从 session.created 开始：上游要是
         * 根本不发 created，我们也得在 800ms 后自己把请求发出去，而不是干等到
         * 30 秒总超时。
         */
        readyTimer = setTimeout(() => {
          readyTimer = null
          markSessionReady('[tts] 上游没有回 session.created，按兜底超时继续')
        }, SESSION_READY_FALLBACK_MS)
        readyTimer.unref?.()
        /*
         * session.created 可能在 connectUpstream 的 head 里就到过（上游把 101 与它
         * 写在同一批字节里）。那种情况下事件回调早于 connected 置真，sendPrompt 当时
         * 直接返回了，这里补发一次。
         */
        if (sessionReady) sendPrompt()
      } catch (error) {
        // UpstreamError 原样抛：外层要靠它的 status 判断「鉴权类错误不换模型」
        if (error instanceof UpstreamError) {
          fail(error)
          return
        }
        fail(error instanceof TtsError
          ? error
          : new TtsError(`朗读失败：${error instanceof Error ? error.message : String(error)}`, 502))
      }
    })()
  })
}

/**
 * 朗读会话的 `session.update` 载荷。
 *
 * 与通话的 `buildSessionUpdate` 是**两份**，不是懒得合并：朗读会话不注册 tools、
 * 不带 turn_detection（原因见文件头）。硬塞进同一个函数只会让两边都多一层
 * 「这次是不是朗读」的分支，读起来更绕。
 */
function buildTtsSessionUpdate(options: {
  instructions: string
  voice: string
  profile: RealtimeVendorProfile
  speechRate: number
}): Record<string, unknown> {
  const { instructions, voice, profile, speechRate } = options
  const isQwen = profile.id === 'qwen'
  const session: Record<string, unknown> = {
    // 同时开文本：部分上游只在文本模态下才保证给音频（与通话同一选择）
    modalities: ['text', 'audio'],
    instructions,
    voice,
    // 格式名各家不同：千问要 pcm，其余按 pcm16（写错不会报错，只会被上游忽略或拒掉整条 update）
    input_audio_format: isQwen ? 'pcm' : 'pcm16',
    output_audio_format: isQwen ? 'pcm' : 'pcm16',
  }
  // 千问有真实语速参数（0.5~2.0）；StepFun 只能靠 instructions（speakInstructions 里已写好）
  if (isQwen) session.speech_rate = Math.min(2, Math.max(0.5, speechRate))
  return { type: 'session.update', session }
}
