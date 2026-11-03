/**
 * Personal Agent —— 全双工实时语音的浏览器侧音频引擎。
 *
 * 链路：麦克风 → 24 kHz 单声道 PCM16（40 ms 一片，1920 字节）→ 同源 WebSocket →
 * 宿主 → StepFun Realtime API；反向收到 24 kHz PCM16 分片，排队喂给扬声器。
 *
 * 这个文件只负责「声音进 / 声音出」，不碰 WebSocket、不碰 React：
 *   - `MicStreamer`  采集麦克风，按 40 ms 切 PCM16 片回调；
 *   - `PcmPlayer`    把下行 PCM16 分片串成连续播放，`interrupt()` 立即静音；
 *   - 纯函数与两个小工具类（重采样、分片）不依赖 DOM，Node 里可直接单测。
 *
 * 三个关键决策（改动前先读完再动手）：
 *
 * 1. **为什么是 24 kHz**：StepFun Realtime 的 `input_audio_format` /
 *    `output_audio_format` 只支持 `pcm16`，官方 Realtime Console 也是按 24000
 *    建 AudioContext。上下行必须同一采样率，任一端改了另一端必须同步，否则
 *    变速或服务端 VAD 时间轴错位。常量来自 `shared/realtime-protocol.ts`。
 *
 * 2. **为什么是 40 ms**：官方建议 20~30 ms 频繁提交；块太大会让服务端 VAD 攒够
 *    数据才判断（响应变慢），太小则 WebSocket 帧数暴涨。40 ms 是延迟与开销的
 *    折中，24 kHz 单声道正好每片 960 采样 / 1920 字节。
 *
 * 3. **为什么 AudioWorklet 代码内联成 Blob URL**：客户端半身是 esbuild 单产物
 *    （`lib/client.js`），构建不会把额外的 worklet 文件复制到插件目录；用
 *    `new Blob([源码]) + URL.createObjectURL` 注册一个模块，既不新增构建产物，
 *    也不依赖宿主静态资源路由。AudioWorklet 不可用时退回 ScriptProcessorNode
 *    （主线程、有卡顿，但老浏览器能通）。
 *
 * 注意：浏览器**不保证**遵守 `new AudioContext({ sampleRate: 24000 })`——很多
 * 设备原生 48 kHz，构造出的 context 仍是 48 kHz。所以采集侧必须重采样：worklet
 * 内联代码里做一份，ScriptProcessor 兜底路径用 `PcmResampler` 做一份，两处算法
 * 相同（线性插值 + 跨帧相位保持），改动时请同步。
 */
import {
  REALTIME_BYTES_PER_SAMPLE,
  REALTIME_CHUNK_MS,
  REALTIME_SAMPLE_RATE,
} from '../../../shared/realtime-protocol.ts'

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** 麦克风采集与播放统一采样率（与 Realtime 契约一致，见文件头「为什么是 24 kHz」）。 */
export const AUDIO_SAMPLE_RATE = REALTIME_SAMPLE_RATE

/** 每片采样数：24000 Hz × 40 ms = 960（= REALTIME_CHUNK_BYTES / 2）。 */
export const MIC_CHUNK_SAMPLES = (AUDIO_SAMPLE_RATE * REALTIME_CHUNK_MS) / 1000

/** 每片字节数：960 × 2 = 1920，与共享协议里的 REALTIME_CHUNK_BYTES 相同。 */
export const MIC_CHUNK_BYTES = MIC_CHUNK_SAMPLES * REALTIME_BYTES_PER_SAMPLE

/** 注册到 AudioWorkletGlobalScope 的处理器名字（内联源码里同名，改动时两处一起改）。 */
export const CAPTURE_PROCESSOR_NAME = 'pa-pcm-capture'

/**
 * 下行播放的调度提前量（秒）。
 *
 * `AudioBufferSourceNode.start(when)` 若 `when` 已过去会立刻起播，多个分片各自
 * 「立刻」起播会在接缝处叠音/爆音。留 20 ms 给主线程调度，同时不引入可感知延迟。
 */
const PLAYER_START_LEAD_SECONDS = 0.02

/** ScriptProcessorNode 兜底路径的缓冲大小（1024 样本在 48 kHz 下约 21 ms）。 */
const SCRIPT_PROCESSOR_BUFFER_SIZE = 1024

/** 音量感知映射：先放大再开方压开，安静环境下的气声也能看到明显起伏。 */
function mapLevel(rms: number): number {
  return Math.min(1, Math.pow(Math.min(1, rms * 3.4), 0.7))
}

/* -------------------------------------------------------------------------- */
/* PCM16 编解码（纯函数，Node 可单测）                                          */
/* -------------------------------------------------------------------------- */

/**
 * Float32 [-1, 1] → Int16 PCM。
 *
 * 负半轴乘 32768、正半轴乘 32767：这样 -1 精确映射到 -32768、1 精确映射到
 * 32767，两个端点都能覆盖，不会出现「+1 只能到 32766」的削顶。
 * NaN / ±Infinity 显式处理：AudioWorklet 在个别设备驱动上会吐出 NaN，直接
 * `Math.round(NaN)` 写进 Int16Array 会静默变 0，显式归零让行为可测。
 */
export function float32ToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length)
  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index]
    if (!Number.isFinite(sample)) {
      output[index] = sample === Infinity ? 32767 : sample === -Infinity ? -32768 : 0
      continue
    }
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample
    output[index] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
  }
  return output
}

/** 把 ArrayBuffer 按小端 PCM16 展开；奇数长度丢弃最后那个不完整的字节。 */
function toInt16View(input: Int16Array | ArrayBuffer): Int16Array {
  if (input instanceof Int16Array) return input
  if (!(input instanceof ArrayBuffer)) {
    throw new TypeError('pcm16ToFloat32: 只接受 Int16Array 或 ArrayBuffer')
  }
  const sampleCount = Math.floor(input.byteLength / 2)
  if (sampleCount === 0) return new Int16Array(0)
  // 不能直接 new Int16Array(buffer)：奇数长度会抛 RangeError，且宿主可能传入
  // 一个只读/已对齐的 ArrayBuffer。用 DataView 逐点读小端最稳。
  const view = new DataView(input)
  const samples = new Int16Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true)
  }
  return samples
}

/**
 * Int16 PCM（或裸字节）→ Float32 [-1, 1]。
 *
 * 与 `float32ToPcm16` 对称：负半轴除 32768、正半轴除 32767，保证
 * Int16 → Float32 → Int16 往返无损（测试里锁死了这条性质）。
 * 传 ArrayBuffer 时按小端解析，奇数长度丢弃尾部不完整字节（WebSocket 断包兜底）。
 */
export function pcm16ToFloat32(input: Int16Array | ArrayBuffer): Float32Array {
  const samples = toInt16View(input)
  const output = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]
    output[index] = value < 0 ? value / 32768 : value / 32767
  }
  return output
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64 字符 → 6 bit 值；-1 表示非法字符（用 Int16Array 当查找表）。 */
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index
  }
  return table
})()

/**
 * Int16 PCM → base64（小端字节序）。
 *
 * 不用 `btoa(String.fromCharCode(...bytes))`：长数组展开成函数参数会爆栈，而且
 * 浏览器与 Node 对二进制字符串的处理边界不一致。这里直接按字节查表拼字符串，
 * 两个环境结果完全相同，也不依赖 btoa/atob 是否存在。
 */
export function pcm16ToBase64(input: Int16Array): string {
  const bytes = new Uint8Array(input.length * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < input.length; index += 1) {
    view.setInt16(index * 2, input[index], true)
  }
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index]
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0
    output += BASE64_ALPHABET[b0 >> 2]
    output += BASE64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]
    output += index + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '='
    output += index + 2 < bytes.length ? BASE64_ALPHABET[b2 & 63] : '='
  }
  return output
}

/**
 * base64 → Int16 PCM（小端）。
 *
 * 容错策略：忽略空白（服务端偶尔把 base64 折行）、允许缺省 padding；遇到非法
 * 字符直接抛错而不是静默产出垃圾音频——静默失败会让「听不到声音」变成难查的
 * 玄学问题。奇数字节丢弃尾部不完整采样。
 */
export function base64ToPcm16(input: string): Int16Array {
  const bytes: number[] = []
  let accumulator = 0
  let bits = 0
  let padding = 0
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    if (code === 61) {
      // '=' padding
      padding += 1
      continue
    }
    if (code === 32 || code === 9 || code === 10 || code === 13) continue
    const value = code < 128 ? BASE64_LOOKUP[code] : -1
    if (value < 0) throw new Error('base64ToPcm16: 非法 base64 字符')
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >> bits) & 0xff)
    }
  }
  // 合法的 base64 结尾只可能剩 0/2/4 个 bit；剩 6~7 说明字符数非法（长度 % 4 === 1）。
  if (bits >= 6) throw new Error('base64ToPcm16: base64 长度非法')
  if (padding > 2) throw new Error('base64ToPcm16: base64 padding 非法')
  const sampleCount = Math.floor(bytes.length / 2)
  const samples = new Int16Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    const low = bytes[index * 2]
    const high = bytes[index * 2 + 1]
    const value = (high << 8) | low
    samples[index] = value >= 0x8000 ? value - 0x10000 : value
  }
  return samples
}

/* -------------------------------------------------------------------------- */
/* 重采样与分片（纯逻辑，Node 可单测）                                          */
/* -------------------------------------------------------------------------- */

/**
 * 线性插值重采样器（跨帧保持相位）。
 *
 * 为什么需要它：浏览器不保证 AudioContext 用请求的采样率（48 kHz 设备很常见），
 * 而 Realtime 契约要求 24 kHz。这个类负责把任意输入采样率统一到 24 kHz。
 *
 * 实现要点：`pos` 是「下一个输出样本在 work 坐标系里的浮点位置」。帧末把
 * `floor(pos)` 之后的样本留到下一次（插值需要前一个样本），并把小数相位
 * `pendingPos` 一起带过去——**只保留样本不保留相位会让跨帧处出现 1/ratio 个
 * 采样的时间跳变**，听感上是轻微的咔哒声，且不同帧长下不可复现。
 *
 * worklet 内联源码里有一份等价实现（worklet 作用域无法 import），改动请同步。
 */
export class PcmResampler {
  private readonly ratio: number
  private pending: Float32Array = new Float32Array(0)
  private pendingPos = 0

  constructor(inputRate: number, outputRate: number = AUDIO_SAMPLE_RATE) {
    if (!(inputRate > 0) || !(outputRate > 0)) {
      throw new Error('PcmResampler: 采样率必须为正数')
    }
    this.ratio = inputRate / outputRate
  }

  /** 喂一段输入，返回本次能产出的输出样本（可能为空数组，不保证每次等长）。 */
  push(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0)
    const work = new Float32Array(this.pending.length + input.length)
    work.set(this.pending, 0)
    work.set(input, this.pending.length)
    const output: number[] = []
    let pos = this.pendingPos
    while (pos + 1 < work.length) {
      const index = Math.floor(pos)
      const fraction = pos - index
      output.push(work[index] * (1 - fraction) + work[index + 1] * fraction)
      pos += this.ratio
    }
    const keepFrom = Math.max(0, Math.floor(pos))
    this.pending = work.slice(keepFrom)
    this.pendingPos = pos - keepFrom
    return Float32Array.from(output)
  }

  /** 清空跨帧状态（重新开始一段音频时调用）。 */
  reset(): void {
    this.pending = new Float32Array(0)
    this.pendingPos = 0
  }
}

/**
 * 定长分片器：把连续的 Float32 采样切成 960 个一片的 Int16Array。
 *
 * 只用于 ScriptProcessorNode 兜底路径（worklet 路径在音频线程里已经分好片）。
 * 一次 push 可能产出 0 片或多片，取决于喂进来的样本数。
 */
export class PcmChunker {
  private readonly chunkSamples: number
  private readonly buffer: Float32Array
  private filled = 0

  constructor(chunkSamples: number = MIC_CHUNK_SAMPLES) {
    if (!(chunkSamples > 0) || !Number.isInteger(chunkSamples)) {
      throw new Error('PcmChunker: 每片采样数必须是正整数')
    }
    this.chunkSamples = chunkSamples
    this.buffer = new Float32Array(chunkSamples)
  }

  /** 当前缓冲里已攒了多少个采样（不足一片的部分）。 */
  get pending(): number {
    return this.filled
  }

  /** 喂一段采样，返回本次攒满的所有分片。 */
  push(input: Float32Array): Int16Array[] {
    const chunks: Int16Array[] = []
    let offset = 0
    while (offset < input.length) {
      const take = Math.min(this.chunkSamples - this.filled, input.length - offset)
      this.buffer.set(input.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === this.chunkSamples) {
        chunks.push(float32ToPcm16(this.buffer))
        this.filled = 0
      }
    }
    return chunks
  }

  /** 丢弃不足一片的尾巴（停麦时最后 <40 ms 的残片没有发送价值）。 */
  reset(): void {
    this.filled = 0
  }
}

/* -------------------------------------------------------------------------- */
/* AudioWorklet 内联源码                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 采集处理器的源码字符串（Blob URL 注册）。
 *
 * 约束：
 *   - **不能出现反引号**：这段字符串本身是模板字面量，反引号会让它提前闭合
 *     （项目 build.mjs 里有一条源码级守卫专门拦这个）；
 *   - 只能用保守语法（AudioWorklet 运行时不会经过 esbuild 转译，直接进浏览器）；
 *   - 处理器名字 `pa-pcm-capture` 必须与 CAPTURE_PROCESSOR_NAME 一致。
 *
 * 逻辑与主线程的 PcmResampler + PcmChunker 等价：线性插值重采样、跨帧保留
 * 样本与相位、攒满 960 采样发一片（transferable ArrayBuffer，零拷贝）。
 * 另外每个音频块算一次 RMS 做指数平滑，随分片带上 level 给 UI 波形。
 */
export const CAPTURE_WORKLET_SOURCE = `
class PaPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    var config = (options && options.processorOptions) || {}
    this.targetRate = config.targetRate || 24000
    this.chunkSamples = config.chunkSamples || 960
    this.ratio = sampleRate / this.targetRate
    this.out = new Int16Array(this.chunkSamples)
    this.outCount = 0
    this.pending = new Float32Array(0)
    this.pendingPos = 0
    this.smooth = 0
  }
  emit() {
    var pcm = this.out
    this.out = new Int16Array(this.chunkSamples)
    this.outCount = 0
    var level = Math.min(1, Math.pow(Math.min(1, this.smooth * 3.4), 0.7))
    this.port.postMessage({ type: 'chunk', pcm: pcm.buffer, level: level }, [pcm.buffer])
  }
  pushSample(value) {
    var clamped = value > 1 ? 1 : value < -1 ? -1 : value
    if (clamped !== clamped) clamped = 0
    this.out[this.outCount] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
    this.outCount += 1
    if (this.outCount >= this.chunkSamples) this.emit()
  }
  process(inputs) {
    var input = inputs[0]
    var channel = input && input[0]
    if (!channel || channel.length === 0) return true
    var pendingLength = this.pending.length
    var work = new Float32Array(pendingLength + channel.length)
    work.set(this.pending, 0)
    work.set(channel, pendingLength)
    var pos = this.pendingPos
    while (pos + 1 < work.length) {
      var index = Math.floor(pos)
      var fraction = pos - index
      this.pushSample(work[index] * (1 - fraction) + work[index + 1] * fraction)
      pos += this.ratio
    }
    var keepFrom = Math.floor(pos)
    if (keepFrom < 0) keepFrom = 0
    this.pending = work.slice(keepFrom)
    this.pendingPos = pos - keepFrom
    var sum = 0
    for (var i = 0; i < channel.length; i += 1) sum += channel[i] * channel[i]
    var rms = Math.sqrt(sum / channel.length)
    this.smooth = this.smooth * 0.8 + rms * 0.2
    return true
  }
}
registerProcessor('pa-pcm-capture', PaPcmCaptureProcessor)
`

/* -------------------------------------------------------------------------- */
/* 宿主 API 的最小本地接口（避免 any，也方便测试注入桩）                        */
/* -------------------------------------------------------------------------- */

interface AudioContextCtorLike {
  new (options?: AudioContextOptions): AudioContext
}

interface AudioWorkletNodeLike {
  port: { onmessage: ((event: { data: unknown }) => void) | null }
  connect(destination: AudioNode): void
  disconnect(): void
}

interface AudioWorkletNodeCtorLike {
  new (context: AudioContext, name: string, options?: {
    numberOfInputs?: number
    numberOfOutputs?: number
    channelCount?: number
    processorOptions?: Record<string, unknown>
  }): AudioWorkletNodeLike
}

function resolveAudioContextCtor(): AudioContextCtorLike {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtorLike
    webkitAudioContext?: AudioContextCtorLike
  }
  const ctor = scope.AudioContext ?? scope.webkitAudioContext
  if (ctor === undefined) throw new Error('当前浏览器不支持 Web Audio')
  return ctor
}

function resolveAudioWorkletNodeCtor(): AudioWorkletNodeCtorLike | null {
  if (typeof AudioWorkletNode === 'undefined') return null
  return AudioWorkletNode as unknown as AudioWorkletNodeCtorLike
}

/** 把内联源码注册成 Blob URL；环境不支持时返回 null（调用方回退 ScriptProcessor）。 */
function createWorkletModuleUrl(source: string): string | null {
  try {
    if (typeof Blob === 'undefined' || typeof URL === 'undefined') return null
    if (typeof URL.createObjectURL !== 'function') return null
    return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  } catch {
    return null
  }
}

function revokeWorkletModuleUrl(url: string): void {
  try {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
  } catch {
    /* URL 已被释放 */
  }
}

/** 把 getUserMedia 的 DOMException 名字翻成用户能照做的中文提示。 */
function mediaErrorMessage(error: unknown): string {
  const name = typeof error === 'object' && error !== null
    ? String((error as { name?: unknown }).name ?? '')
    : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝，请在浏览器地址栏允许麦克风'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的麦克风'
  if (name === 'NotReadableError') return '麦克风被其它程序占用，请关闭后重试'
  return '无法打开麦克风'
}

/* -------------------------------------------------------------------------- */
/* MicStreamer                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 麦克风采集器：每 40 ms 回调一片 24 kHz 单声道 PCM16（960 采样）。
 *
 * 用法：
 * ```ts
 * const mic = new MicStreamer()
 * await mic.start((pcm) => socket.send(pcm))   // 必须在用户手势后调用
 * mic.level()                                   // 0..1，给波形
 * mic.setMuted(true)                            // 停止回调但保持连接
 * await mic.stop()                              // 幂等释放
 * ```
 */
export class MicStreamer {
  /**
   * 目标采样率（上行）。
   *
   * 默认 24 kHz（StepFun），但**千问实时语音要求 16 kHz**——喂错不会报错，只会让
   * 声音变调、VAD 时间轴错位（表现为「说完了不响应」）。宿主会在 `ready` 帧里下发
   * `inputSampleRate`，调用方按它构造。
   */
  private readonly targetRate: number
  /** 每片采样数（按目标采样率算 40ms 一片）。 */
  private readonly chunkSamples: number
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNodeLike | null = null
  private scriptNode: ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null
  private resampler: PcmResampler | null = null
  private chunker: PcmChunker | null = null
  private onChunk: ((pcm16: Int16Array) => void) | null = null
  private muted = false
  private running = false
  private latestLevel = 0
  private smoothLevel = 0

  /** 是否已启动（start 成功且尚未 stop）。 */
  get active(): boolean {
    return this.running
  }

  /**
   * @param targetRate 上行目标采样率（Hz）。默认 24 kHz（StepFun）；千问传 16 kHz。
   */
  constructor(targetRate: number = AUDIO_SAMPLE_RATE) {
    this.targetRate = Number.isFinite(targetRate) && targetRate > 0 ? Math.round(targetRate) : AUDIO_SAMPLE_RATE
    // 40ms 一片：24k → 960 采样，16k → 640 采样
    this.chunkSamples = Math.max(1, Math.round((this.targetRate * REALTIME_CHUNK_MS) / 1000))
  }

  /** 是否处于静音状态（采集仍在继续，只是不回调）。 */
  get isMuted(): boolean {
    return this.muted
  }

  /**
   * 打开麦克风并开始回调。重复调用是幂等的：已在运行时只替换回调，不会重复申请设备。
   *
   * 必须在用户手势（点击）之后调用，否则浏览器会挂起 AudioContext 且
   * getUserMedia 也可能被拒绝。
   */
  async start(onChunk: (pcm16: Int16Array) => void): Promise<void> {
    if (this.running) {
      this.onChunk = onChunk
      return
    }
    if (
      typeof navigator === 'undefined'
      || navigator.mediaDevices === undefined
      || typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      throw new Error('当前环境不支持麦克风采集')
    }
    this.onChunk = onChunk
    try {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        })
      } catch (error) {
        throw new Error(mediaErrorMessage(error))
      }
      this.stream = stream

      const Ctor = resolveAudioContextCtor()
      let context: AudioContext
      try {
        context = new Ctor({ sampleRate: this.targetRate })
      } catch {
        // 旧 Safari 不接受 sampleRate 选项：退回设备默认采样率，由重采样统一到 24 kHz。
        context = new Ctor()
      }
      this.context = context
      this.source = context.createMediaStreamSource(stream)

      const workletReady = await this.attachWorklet(context, this.source)
      if (!workletReady) this.attachScriptProcessor(context, this.source)

      if (context.state === 'suspended') {
        try {
          await context.resume()
        } catch {
          // 没有用户手势时浏览器会拒绝；调用方应在点击回调里 start。
        }
      }
      this.muted = false
      this.latestLevel = 0
      this.smoothLevel = 0
      this.running = true
    } catch (error) {
      await this.stop()
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /** 当前麦克风音量 0..1（静音时返回 0，避免 UI 显示「正在说话」却发不出去）。 */
  level(): number {
    if (this.muted) return 0
    return this.latestLevel
  }

  /**
   * 静音 / 取消静音。静音时**停止回调但保持连接**：采集链路继续跑，
   * 只是不再把分片交给调用方，取消静音时没有重新开麦的延迟。
   */
  setMuted(muted: boolean): void {
    this.muted = muted === true
    if (this.muted) this.latestLevel = 0
  }

  /** 释放麦克风、断开节点、关闭 AudioContext。幂等，重复调用安全。 */
  async stop(): Promise<void> {
    this.running = false
    this.onChunk = null
    this.muted = false
    this.latestLevel = 0
    this.smoothLevel = 0
    this.resampler = null
    this.chunker = null

    const workletNode = this.workletNode
    this.workletNode = null
    if (workletNode !== null) {
      try {
        workletNode.port.onmessage = null
      } catch {
        /* 端口已断开 */
      }
      try {
        workletNode.disconnect()
      } catch {
        /* 已断开 */
      }
    }

    const scriptNode = this.scriptNode
    this.scriptNode = null
    if (scriptNode !== null) {
      scriptNode.onaudioprocess = null
      try {
        scriptNode.disconnect()
      } catch {
        /* 已断开 */
      }
    }

    const silentGain = this.silentGain
    this.silentGain = null
    if (silentGain !== null) {
      try {
        silentGain.disconnect()
      } catch {
        /* 已断开 */
      }
    }

    const source = this.source
    this.source = null
    if (source !== null) {
      try {
        source.disconnect()
      } catch {
        /* 已断开 */
      }
    }

    const stream = this.stream
    this.stream = null
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          /* 已停止 */
        }
      }
    }

    const context = this.context
    this.context = null
    if (context !== null && context.state !== 'closed') {
      try {
        await context.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 优先 AudioWorklet（音频线程、不卡主线程）；任何一步失败返回 false 交给兜底。 */
  private async attachWorklet(context: AudioContext, source: MediaStreamAudioSourceNode): Promise<boolean> {
    let node: AudioWorkletNodeLike | null = null
    try {
      const audioWorklet = context.audioWorklet
      if (audioWorklet === undefined || typeof audioWorklet.addModule !== 'function') return false
      const moduleUrl = createWorkletModuleUrl(CAPTURE_WORKLET_SOURCE)
      if (moduleUrl === null) return false
      try {
        await audioWorklet.addModule(moduleUrl)
      } finally {
        // addModule 返回时模块已解析完成，URL 不再需要，立刻释放（失败也释放）。
        revokeWorkletModuleUrl(moduleUrl)
      }
      const Ctor = resolveAudioWorkletNodeCtor()
      if (Ctor === null) return false
      node = new Ctor(context, CAPTURE_PROCESSOR_NAME, {
        // numberOfOutputs: 0 —— 采集节点绝不接 destination，否则麦克风原声会回放。
        // AudioWorklet 只要输入侧有连接就会被音频线程拉取，不需要输出。
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        processorOptions: {
          targetRate: this.targetRate,
          chunkSamples: this.chunkSamples,
        },
      })
      node.port.onmessage = (event: { data: unknown }): void => {
        this.handleWorkletMessage(event.data)
      }
      source.connect(node as unknown as AudioNode)
      this.workletNode = node
      return true
    } catch {
      if (node !== null) {
        try {
          node.disconnect()
        } catch {
          /* 已断开 */
        }
      }
      return false
    }
  }

  /**
   * 兜底路径：ScriptProcessorNode（已废弃、跑在主线程，但兼容性最好）。
   *
   * ScriptProcessor 只有接到 destination 才会触发 onaudioprocess，所以中间串一个
   * gain=0 的节点——既保证回调被调用，又不会把麦克风原声放出来。
   */
  private attachScriptProcessor(context: AudioContext, source: MediaStreamAudioSourceNode): void {
    const processor = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1)
    const gain = context.createGain()
    gain.gain.value = 0
    this.resampler = new PcmResampler(context.sampleRate, this.targetRate)
    this.chunker = new PcmChunker(this.chunkSamples)
    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      this.pushCaptured(event.inputBuffer.getChannelData(0))
    }
    source.connect(processor)
    processor.connect(gain)
    gain.connect(context.destination)
    this.scriptNode = processor
    this.silentGain = gain
  }

  /** ScriptProcessor 路径：重采样 → 算 level → 攒 40 ms 片 → 回调。 */
  private pushCaptured(channel: Float32Array): void {
    const onChunk = this.onChunk
    const resampler = this.resampler
    const chunker = this.chunker
    if (onChunk === null || resampler === null || chunker === null) return
    let sum = 0
    for (let index = 0; index < channel.length; index += 1) {
      sum += channel[index] * channel[index]
    }
    const rms = Math.sqrt(sum / Math.max(1, channel.length))
    this.smoothLevel = this.smoothLevel * 0.8 + rms * 0.2
    this.latestLevel = mapLevel(this.smoothLevel)
    const resampled = resampler.push(channel)
    if (resampled.length === 0) return
    for (const chunk of chunker.push(resampled)) {
      if (this.muted) continue
      onChunk(chunk)
    }
  }

  /** worklet 消息：`{ type: 'chunk', pcm: ArrayBuffer, level: number }`。 */
  private handleWorkletMessage(data: unknown): void {
    const onChunk = this.onChunk
    if (onChunk === null || data === null || typeof data !== 'object') return
    const message = data as { type?: unknown; pcm?: unknown; level?: unknown }
    if (message.type !== 'chunk') return
    if (typeof message.level === 'number' && Number.isFinite(message.level)) {
      this.latestLevel = Math.max(0, Math.min(1, message.level))
    }
    if (this.muted) return
    if (!(message.pcm instanceof ArrayBuffer)) return
    try {
      const samples = new Int16Array(message.pcm)
      if (samples.length > 0) onChunk(samples)
    } catch {
      /* buffer 已被转移或长度非法：丢弃这一片 */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* PcmPlayer                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 下行音频播放器：把 24 kHz PCM16 分片串成连续播放。
 *
 * 关键实现：`nextStartTime` 累加。每个分片用 `AudioBufferSourceNode.start(when)`
 * 排到上一个分片的结束时刻，而不是各自「立刻播」——后者会让相邻分片在音频线程
 * 调度抖动下互相重叠（爆音）或留缝（咔哒）。时间轴只在 `interrupt()` 时重置。
 *
 * 打断：服务端 VAD 判定用户开始说话时，调用方必须立刻 `interrupt()`；这里对
 * 所有已调度（含正在播）的 source 调 `stop()` 并清空队列，`stop()` 在下一个
 * 渲染量子（约 2.7 ms）生效，人耳听不出拖尾。可重复调用。
 */
export class PcmPlayer {
  private readonly sampleRate: number
  private context: AudioContext | null = null
  /**
   * 主输出增益（所有分片都接到它，它再接 destination）。
   *
   * 为什么要一个公共 gain 而不是给每个 source 各接一个：
   *  · AudioBufferSourceNode **没有音量属性**，只能经过 GainNode 调幅；
   *  · 音量拖动条要求「正在播的音频立刻变小声」，逐个 source 改要遍历所有节点，
   *    而 master gain 一次赋值就对全部已调度分片生效；
   *  · 值保存在 `volume` 字段里，重连/换 AudioContext 重建 gain 时能沿用。
   */
  private masterGain: GainNode | null = null
  private volume = 1
  private readonly sources = new Set<AudioBufferSourceNode>()
  private nextStartTime = 0

  constructor(sampleRate: number = AUDIO_SAMPLE_RATE) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : AUDIO_SAMPLE_RATE
  }

  /** 是否还有排队/正在播放的音频。 */
  get playing(): boolean {
    return this.sources.size > 0
  }

  /** 当前播放音量（0..1）。 */
  get currentVolume(): number {
    return this.volume
  }

  /**
   * 设置播放音量（0..1，越界钳制；非法值回落 1）。
   *
   * 0 = 静音但**不中断播放**：音频照常解码与计时，只是增益为 0。这样拖回音量时
   * 不会出现「重新从下一片开始」的断句；也刻意不销毁 AudioContext——销毁后需要
   * 一次用户手势才能恢复，通话里没有这个手势窗口。
   */
  setVolume(volume: number): void {
    const next = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1
    this.volume = next
    const gain = this.masterGain
    if (gain === null) return
    try {
      gain.gain.value = next
    } catch {
      /* 上下文已关闭：等下次 enqueue 重建 */
    }
  }

  /**
   * 用户手势后恢复播放上下文。
   *
   * 浏览器要求 AudioContext 在用户手势里 resume，否则一直 suspended。没有手势时
   * resume 会被拒绝，这里吞掉错误——下一次点击会再调一次。
   */
  async ensureRunning(): Promise<void> {
    const context = this.ensureContext()
    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch {
        /* 浏览器要求用户手势；调用方应在点击回调里调用本方法 */
      }
    }
  }

  /**
   * 排队播放一片 PCM16（Int16Array 或裸小端字节）。
   *
   * 空音频直接忽略；ArrayBuffer 的奇数长度会在解码时丢弃尾部不完整字节。
   * 第一次调用会懒创建 AudioContext（所以要在用户手势后调用 `ensureRunning`）。
   */
  enqueue(pcm16: Int16Array | ArrayBuffer): void {
    const floats = pcm16ToFloat32(pcm16)
    if (floats.length === 0) return
    const context = this.ensureContext()
    const buffer = context.createBuffer(1, floats.length, this.sampleRate)
    buffer.getChannelData(0).set(floats)
    const source = context.createBufferSource()
    source.buffer = buffer
    // 接 master gain（而不是直接 destination）：音量条改的是这一个节点
    source.connect(this.ensureMasterGain(context))
    // 先挂 onended 再 start：极短分片可能在赋值前就播完，导致集合里留下死引用。
    source.onended = (): void => {
      this.sources.delete(source)
    }
    const startAt = Math.max(this.nextStartTime, context.currentTime + PLAYER_START_LEAD_SECONDS)
    source.start(startAt)
    this.nextStartTime = startAt + buffer.duration
    this.sources.add(source)
  }

  /**
   * 立刻停播并清空队列（被打断时调用）。可重复调用。
   *
   * 注意这里**不停用 AudioContext**：打断后通常马上会有新音频进来，保留上下文
   * 才能无缝继续；只把播放时间轴重置回「当前时间 + 提前量」。
   */
  interrupt(): void {
    const sources = [...this.sources]
    this.sources.clear()
    for (const source of sources) {
      try {
        source.stop()
      } catch {
        /* 尚未开始或已结束 */
      }
      try {
        source.disconnect()
      } catch {
        /* 已断开 */
      }
    }
    this.nextStartTime = 0
  }

  /** 释放 AudioContext。幂等；关闭后再次 enqueue 会懒创建新上下文。 */
  async close(): Promise<void> {
    this.interrupt()
    /*
     * 必须把 masterGain 的引用清掉：它属于**旧 AudioContext**，关掉后节点已失效。
     * 留着它的话，下次 enqueue 会连到一个死节点——表现为「通话重连后完全没声音」，
     * 而且不报任何错。
     */
    const gain = this.masterGain
    this.masterGain = null
    if (gain !== null) {
      try {
        gain.disconnect()
      } catch {
        /* 已断开 */
      }
    }
    const context = this.context
    this.context = null
    if (context === null || context.state === 'closed') return
    try {
      await context.close()
    } catch {
      /* 已关闭 */
    }
  }

  /** 懒创建 master gain（按当前 context），并应用保存的音量。 */
  private ensureMasterGain(context: AudioContext): GainNode {
    if (this.masterGain !== null) return this.masterGain
    const gain = context.createGain()
    gain.gain.value = this.volume
    gain.connect(context.destination)
    this.masterGain = gain
    return gain
  }

  private ensureContext(): AudioContext {
    if (this.context !== null) return this.context
    const Ctor = resolveAudioContextCtor()
    let context: AudioContext
    try {
      context = new Ctor({ sampleRate: this.sampleRate })
    } catch {
      // 同上：旧浏览器不接受 sampleRate 选项，AudioBufferSourceNode 会自动重采样。
      context = new Ctor()
    }
    this.context = context
    return context
  }
}
