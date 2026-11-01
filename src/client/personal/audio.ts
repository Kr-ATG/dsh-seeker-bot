/**
 * Personal Agent — 语音录制与转写。
 *
 * 关键点：**转写直接走 DSH 官方 speech Remote**（`ctx.remote.speech.transcribe`），
 * 与 Work 模式输入框的麦克风是同一条 ASR 链路（本机 SenseVoice），不依赖浏览器
 * 的 webkitSpeechRecognition，也不需要额外重启宿主。
 *
 * 录音格式与官方 VoiceInput 一致：MediaRecorder 采集 → AudioContext 解码 →
 * OfflineAudioContext 重采样到 16 kHz 单声道 → 编码成 44 字节头的 PCM16 WAV。
 */
import { getClientCtx } from '../client-ctx.ts'

export interface SpeechRemoteResult {
  ok?: boolean
  value?: { text?: string; audioSeconds?: number; inferenceSeconds?: number }
  text?: string
  error?: { message?: string }
}

interface SpeechRemote {
  transcribe?: (request: { audioBase64: string; providerId?: string; language?: string }, signal?: AbortSignal) => Promise<SpeechRemoteResult>
}

function speechRemote(): SpeechRemote | null {
  try {
    const ctx = getClientCtx() as unknown as { remote?: { speech?: SpeechRemote } } | null
    const speech = ctx?.remote?.speech
    return speech !== undefined && typeof speech.transcribe === 'function' ? speech : null
  } catch {
    return null
  }
}

/** 把 PCM16 单声道样本编码成规范 WAV（与官方 VoiceInput 的 encodeWave 同格式）。 */
export function encodeWave(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16e3, true)
  view.setUint32(28, 32e3, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

/** 二进制转 base64（分块避免超长参数爆栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(text)
}

/** 一次录音：start 后由 UI 决定 stop 时机；cancel 随时释放麦克风。 */
export class SpeechRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private levelBuffer: Uint8Array | null = null
  private chunks: Blob[] = []
  private disposed = false

  async start(): Promise<void> {
    if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('当前环境不支持录音')
    }
    if (typeof MediaRecorder === 'undefined') throw new Error('当前环境不支持录音')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      })
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      if (name === 'NotAllowedError') throw new Error('麦克风权限被拒绝，请在浏览器地址栏允许麦克风')
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('没有找到可用的麦克风')
      throw new Error('无法打开麦克风')
    }
    try {
      const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AudioCtor !== undefined) this.context = new AudioCtor()
      this.attachAnalyser()
      this.recorder = new MediaRecorder(this.stream)
      this.chunks = []
      this.recorder.ondataavailable = (event) => {
        if (!this.disposed && event.data.size > 0) this.chunks.push(event.data)
      }
      this.recorder.start()
    } catch (error) {
      await this.cancel()
      throw new Error(`无法开始录音：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 接一条「麦克风 → AnalyserNode」的旁路，用来给录音条画实时波形。
   * 只连 analyser、**不连 destination**，否则会把麦克风原声回放出来。
   */
  private attachAnalyser(): void {
    const context = this.context
    const stream = this.stream
    if (context === null || stream === null) return
    try {
      if (context.state === 'suspended') void context.resume()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.5
      context.createMediaStreamSource(stream).connect(analyser)
      this.analyser = analyser
      this.levelBuffer = new Uint8Array(analyser.fftSize)
    } catch {
      this.analyser = null
      this.levelBuffer = null
    }
  }

  /**
   * 当前麦克风音量，0..1，供录音条实时波形使用。
   *
   * 取时域样本算 RMS 后做一次感知映射：先放大（小声也有起伏）再开方压开，
   * 最后夹到 1，这样安静环境下的气声也能看到明显跳动。
   */
  level(): number {
    const analyser = this.analyser
    const buffer = this.levelBuffer
    if (analyser === null || buffer === null) return 0
    try {
      // TS 5.7 起 Uint8Array 带 buffer 泛型，这里统一收窄到 getByteTimeDomainData 要的形状。
      analyser.getByteTimeDomainData(buffer as Parameters<AnalyserNode['getByteTimeDomainData']>[0])
    } catch {
      return 0
    }
    let sum = 0
    for (let index = 0; index < buffer.length; index += 1) {
      const value = (buffer[index] - 128) / 128
      sum += value * value
    }
    const rms = Math.sqrt(sum / buffer.length)
    return Math.min(1, Math.pow(Math.min(1, rms * 3.4), 0.7))
  }

  /** 结束录音并返回规范 WAV 字节。 */
  async stop(): Promise<Uint8Array> {
    const recorder = this.recorder
    const context = this.context
    if (recorder === null || context === null || recorder.state !== 'recording') {
      await this.cancel()
      throw new Error('没有录到声音')
    }
    try {
      await new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve()
        recorder.onerror = () => reject(new Error('录音被中断'))
        recorder.stop()
      })
      this.stream?.getTracks().forEach((track) => track.stop())
      const blob = new Blob(this.chunks, { type: recorder.mimeType })
      if (blob.size === 0) throw new Error('没有录到声音')
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      const maxSeconds = Math.min(decoded.duration, 120)
      const length = Math.max(1, Math.floor(maxSeconds * 16e3))
      const offline = new OfflineAudioContext(1, length, 16e3)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const rendered = await offline.startRendering()
      return encodeWave(rendered.getChannelData(0))
    } finally {
      await this.release()
    }
  }

  async cancel(): Promise<void> {
    this.disposed = true
    try { if (this.recorder !== null && this.recorder.state === 'recording') this.recorder.stop() } catch { /* 已停止 */ }
    this.stream?.getTracks().forEach((track) => track.stop())
    await this.release()
  }

  private async release(): Promise<void> {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.recorder = null
    this.analyser = null
    this.levelBuffer = null
    this.chunks = []
    const context = this.context
    this.context = null
    try {
      if (context !== null && context.state !== 'closed') await context.close()
    } catch {
      /* AudioContext 已关闭 */
    }
  }
}

/** 转写规范 WAV：优先 DSH speech Remote（与 Work 模式同一链路），失败再走 host 兜底。 */
export async function transcribeWav(wav: Uint8Array, signal?: AbortSignal): Promise<string> {
  const audioBase64 = bytesToBase64(wav)
  const remote = speechRemote()
  let remoteError: string | null = null
  if (remote !== null && typeof remote.transcribe === 'function') {
    try {
      const result = await remote.transcribe({ audioBase64, language: 'zh' }, signal)
      if (result !== null && result !== undefined && result.ok === false) {
        throw new Error(result.error?.message ?? '语音识别失败')
      }
      const text = result?.value?.text ?? result?.text ?? ''
      if (typeof text === 'string' && text.trim() !== '') return text.trim()
      throw new Error('没有识别到语音内容，请再说一次')
    } catch (error) {
      if (signal?.aborted) throw error
      remoteError = error instanceof Error ? error.message : String(error)
    }
  }

  if (typeof location !== 'undefined' && location.protocol !== 'file:') {
    try {
      const response = await fetch('/api/personal-agent/asr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: audioBase64, language: 'zh' }),
        signal,
      })
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string }
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `语音识别服务返回 ${response.status}`)
      if (typeof data.text !== 'string' || data.text.trim() === '') throw new Error('没有识别到语音内容，请再说一次')
      return data.text.trim()
    } catch (error) {
      if (signal?.aborted) throw error
      const hostError = error instanceof Error ? error.message : String(error)
      throw new Error(`语音识别失败：${remoteError !== null ? `${remoteError}；host：${hostError}` : hostError}`)
    }
  }

  throw new Error(`语音识别服务不可用：${remoteError ?? '请在 DSH 应用内使用，或重启 DSH 后再试'}`)
}
