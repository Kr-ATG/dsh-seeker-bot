/**
 * Personal Agent — 文字朗读（把回复气泡里的正文念出来）。
 *
 * 语音合成走宿主端点 POST /api/personal-agent/tts（契约见
 * src/shared/realtime-protocol.ts）：复用「通话已经配好的那套模型 / 音色 / 供应商」
 * 而不是另配一套 TTS —— 同一个 Bot 只该有一个嗓子，用户也不用填第二份音色。
 *
 * ## 两种响应形态（按 content-type 自动分流）
 *
 *  · **流式**（REALTIME_TTS_STREAM_MIME + REALTIME_TTS_SAMPLE_RATE_HEADER）：
 *    body 是裸 PCM16 小端分片，宿主收到首片上游音频就回包。前端用通话同款
 *    PcmPlayer 边收边播 —— 首字延迟从「整段合成时间」降到「建连 + 首包」。
 *    用户反馈的「播放延迟太高」根因就在这里：以前等整段 WAV 回来才出声。
 *  · **整段 WAV**（audio/wav）：旧宿主忽略 stream 字段时的回包，仍走
 *    decodeAudioData + BufferSource，保证老宿主不会被新前端打断。
 *
 * 为什么是模块级单例（而不是组件里的 useState）：
 *  · 播放是**全局唯一**的：同一时刻只该有一条消息在念，新播放要能停掉旧的；
 *  · 状态要跨组件读：气泡上的喇叭按钮、消息流的自动播放 effect 都要知道
 *    「现在在念哪一条」。
 * 所以这里是一个极小的外部 store（subscribe / getSnapshot），组件用
 * useSyncExternalStore 订阅（与 tool-calls-visible、features/store 同一套写法）。
 *
 * 失败口径：**朗读是锦上添花，不能挡路**。浏览器拦自动播放（没有用户手势时
 * AudioContext 起不来）属于正常现象，静默回到空闲、不弹错；只有请求 / 解码
 * 真的失败才把可读中文原因放进 error 供诊断。
 */
import { useSyncExternalStore } from 'react'
import {
  REALTIME_TTS_MAX_CHARS,
  REALTIME_TTS_PATH,
  REALTIME_TTS_SAMPLE_RATE_HEADER,
  REALTIME_TTS_STREAM_MIME,
  type RealtimeSpeed,
  type RealtimeTtsRequest,
} from '../../shared/realtime-protocol.ts'
import { AUDIO_SAMPLE_RATE, PcmPlayer } from './call/realtime-audio.ts'
import type { Message } from './types.ts'

/**
 * 整条消息的朗读总上限（字符）。
 *
 * 早先这里是 240，而且**只截一次**：455 字的回复念到第 240 字就停，用户听到
 * 「实践上我给你两个数」戛然而止，还以为 Bot 卡死了。240 这个数字本身没有错——
 * 它想避免「一条消息念两分钟」——错的是拿它当硬截断。现在它只作为整条消息的
 * 兜底上限（2000 字，正常人也不会连续听八分钟），真正解决「念不完」的是下面的
 * SPEECH_CHUNK_CHARS 分段：把整条消息切成小段逐段合成、逐段播完。
 */
export const SPEECH_MAX_CHARS = 2000

/**
 * 单段朗读上限（字符）。
 *
 * 宿主端点自己有 REALTIME_TTS_MAX_CHARS（400）的硬截断：一次请求超过 400 字，
 * 宿主管线只会合成前 400 字。前端把整条消息切成 <= 380 字的小段逐段请求，
 * 每段都完整落在宿主上限内，于是整条消息可以完整念完，而不是在某个数字处
 * 戛然而止。取 380 而不是 400 是给中文标点 / 编码边界留余量。
 */
export const SPEECH_CHUNK_CHARS = 380

/**
 * 等待播放队列排空的轮询间隔（毫秒）。
 *
 * PcmPlayer 只暴露 playing 布尔值、没有「播完」事件，只能轮询。80ms 是「状态
 * 切回空闲」的观感阈值（再长用户会觉得按钮反应慢），又不会把主线程刷爆。
 */
const PLAYER_IDLE_POLL_MS = 80

/** 朗读状态快照（组件用 useSpeechState 订阅）。 */
export interface SpeechState {
  /** 正在出声（音频已经开始播放）。 */
  speaking: boolean
  /** 正在请求 / 解码 / 等首片（还没出声）。 */
  loading: boolean
  /** 最近一次失败的可读原因；null = 没有错误。 */
  error: string | null
  /**
   * 正在朗读（或正在加载）的那条消息 id；null = 空闲。
   *
   * 为什么要它：气泡上的喇叭按钮要判断「这一条是不是我正在念的那一条」才能切成
   * 停止态。只给 speaking 布尔值的话，整屏所有按钮会一起变成停止图标。
   */
  messageId: string | null
}

/** speakText 的可选参数（全部可选：不给时宿主按「Bot 设置 → 全局默认」解析）。 */
export interface SpeakOptions {
  /** 发起朗读的消息 id（气泡按钮据此显示播放中 / 停止态）。 */
  messageId?: string
  /** Bot id（只用于宿主日志与诊断，不参与合成）。 */
  botId?: string
  /** Live 供应商 id（RealtimeVendorRecord.id）。 */
  vendor?: string
  /** 音色 id；留空用全局默认。 */
  voice?: string
  /** 语速档位；留空用全局默认。 */
  speed?: RealtimeSpeed
}

/* -------------------------------------------------------------------------- */
/* 状态（外部 store）                                                          */
/* -------------------------------------------------------------------------- */

/** 空闲状态。**单一来源**：多处手写对象字面量迟早字段漂移。 */
function idleState(): SpeechState {
  return { speaking: false, loading: false, error: null, messageId: null }
}

let state: SpeechState = idleState()

/** 订阅者（组件用 useSyncExternalStore 接）。 */
const listeners = new Set<() => void>()

/** 写状态：只在真的有变化时通知（getSnapshot 返回稳定引用，避免无谓重渲染）。 */
function patchState(patch: Partial<SpeechState>): void {
  const next: SpeechState = { ...state, ...patch }
  if (
    next.speaking === state.speaking
    && next.loading === state.loading
    && next.error === state.error
    && next.messageId === state.messageId
  ) {
    return
  }
  state = next
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      // 单个订阅者炸了不能连累其它订阅者（与 tool-calls-visible 同一口径）
      console.error('[personal-speech] listener error', error)
    }
  }
}

/** 读当前快照（useSyncExternalStore 的 getSnapshot；必须返回稳定引用）。 */
export function getSpeechState(): SpeechState {
  return state
}

/** 订阅状态变化（useSyncExternalStore 的 subscribe）。 */
export function subscribeSpeech(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 组件用的朗读状态。 */
export function useSpeechState(): SpeechState {
  return useSyncExternalStore(subscribeSpeech, getSpeechState, getSpeechState)
}

/* -------------------------------------------------------------------------- */
/* 旧 WAV 路径的 AudioContext（流式路径用 PcmPlayer 自己的上下文）              */
/* -------------------------------------------------------------------------- */

/** AudioContext 构造器的最小本地接口（避免 any，也方便测试注入桩）。 */
interface AudioContextCtorLike {
  new (options?: AudioContextOptions): AudioContext
}

function resolveAudioContextCtor(): AudioContextCtorLike | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtorLike
    webkitAudioContext?: AudioContextCtorLike
  }
  return scope.AudioContext ?? scope.webkitAudioContext ?? null
}

/**
 * 复用的 AudioContext（整段 WAV 路径用）。
 *
 * 为什么不像通话那样每条消息新建再关：浏览器要求 AudioContext 在**用户手势**里
 * 才能 resume，频繁销毁重建会让自动播放那一路永远拿不到手势窗口。保留一个上下文，
 * 只是每次换 source，点一次喇叭就能响。
 *
 * 它同时是「浏览器允不允许出声」的判据：页面级自动播放策略对所有 AudioContext
 * 一致，这里拿不到 running，就说明整条朗读链路都会被拦，直接静默收工。
 */
let context: AudioContext | null = null

/** 主增益（所有 source 都接它，它接 destination）。保留引用是为了换上下文时能丢掉。 */
let gain: GainNode | null = null

/**
 * 朗读音量（0..1）的落盘键。
 *
 * 单独存一个键、不并进 Bot 数据：音量是「在这台机器上把声音放多大」的偏好，
 * 与是哪个 Bot 无关；换 Bot / 开新会话不该把耳朵的音量一起换掉。命名与通话音量
 * （store 的 `pa:call-volume:v1`）同一套约定。
 */
const SPEECH_VOLUME_KEY = 'pa:speech-volume:v1'

/** 读回上次的朗读音量；没存过 / 数据损坏 / 越界一律回落 1（满音量）。 */
function loadSpeechVolume(): number {
  // 离线测试（node）里没有 localStorage：整条朗读链路照样要能加载
  if (typeof localStorage === 'undefined') return 1
  try {
    const raw = localStorage.getItem(SPEECH_VOLUME_KEY)
    if (raw === null) return 1
    const value = Number(raw)
    if (!Number.isFinite(value)) return 1
    return Math.max(0, Math.min(1, value))
  } catch {
    return 1
  }
}

/**
 * 当前朗读音量（0..1）。
 *
 * 两条播放路径共用一个值：整段 WAV（旧宿主）走本模块的 `gain`，流式 PCM
 * （新宿主）走 PcmPlayer 自己的增益——不统一的话，同一句话在换宿主机型时
 * 音量会莫名其妙变一个样。
 */
let volume = loadSpeechVolume()

/** 当前正在播放的 WAV 节点（null = 没有在播）。 */
let source: AudioBufferSourceNode | null = null

/**
 * 正在等「这一条 WAV 播完」的兑现函数（null = 没有人在等）。
 *
 * playBuffer 现在返回 Promise（speakText 要等这一段真的播完才请求下一段），
 * 而停止 / 打断时 onended 可能永远不会触发：必须由 stopPlayback 主动兑现，
 * 否则等待方会永久悬挂，整条朗读流程（以及它的 catch/finally）都收不了尾。
 */
let finishPlayback: (() => void) | null = null

/**
 * 播放代次。
 *
 * 每次 speakText / stopSpeech 都自增；异步流程（fetch → 解码 / 读流 → 播放）每一步
 * 之后都要拿它比对：**用户已经点了别的消息 / 点了停止，这条迟到的响应就不该再响**。
 * 只靠「停掉 source」不够——那时音频还在路上，根本没有 source 可停。
 */
let generation = 0

/**
 * 在途的合成请求。
 *
 * 用户连点几条消息时，前一条的 fetch 还在路上：不取消的话宿主会同时开好几条
 * 上游会话（每条都要计费），它们的音频回来之后也只会被丢弃。取消是「点了停止
 * 就真的不再合成」的唯一做法——只停本地播放，服务端还在白跑。
 */
let requestAbort: AbortController | null = null

/** 取消在途请求（没有在途请求时是空操作）。 */
function abortRequest(): void {
  const controller = requestAbort
  requestAbort = null
  if (controller === null) return
  try {
    controller.abort()
  } catch {
    /* 已经结束了 */
  }
}

/** 懒创建 / 重建 AudioContext；浏览器没有 Web Audio 时返回 null。 */
function ensureContext(): AudioContext | null {
  if (context !== null && context.state !== 'closed') return context
  if (context !== null) {
    // 旧上下文已被浏览器关掉（页面休眠后偶发）：连同它的 gain 一起丢掉重建
    gain = null
    context = null
  }
  const Ctor = resolveAudioContextCtor()
  if (Ctor === null) return null
  try {
    context = new Ctor()
  } catch {
    context = null
  }
  return context
}

/** 懒创建主增益（按当前 context）并接到 destination。 */
function ensureGain(audioContext: AudioContext): GainNode {
  if (gain !== null) return gain
  const node = audioContext.createGain()
  // 沿用当前音量：重建上下文（页面休眠后被浏览器关掉）不该让音量突然变满
  node.gain.value = volume
  node.connect(audioContext.destination)
  gain = node
  return node
}

/** 兑现「当前 WAV 播完」的等待者（没有等待者时是空操作；多次调用安全）。 */
function resolvePlayback(): void {
  const finish = finishPlayback
  finishPlayback = null
  if (finish === null) return
  finish()
}

/** 停掉当前正在播的 WAV 那一条（不清状态、不自增代次，调用方负责）。 */
function stopPlayback(): void {
  const current = source
  source = null
  /*
   * 先兑现等待者：playBuffer 的 Promise 只有在 onended 时才 resolve，而被停止的
   * 节点接不到 onended（下面把回调摘掉了），不主动兑现就会永久悬挂。
   */
  resolvePlayback()
  if (current === null) return
  // 摘 onended：被新播放打断的旧节点不该把状态改回空闲（那时新的一条正在播）
  try {
    current.onended = null
  } catch {
    /* 节点已失效 */
  }
  try {
    current.stop()
  } catch {
    /* 还没开始或已经播完 */
  }
  try {
    current.disconnect()
  } catch {
    /* 已断开 */
  }
}

/* -------------------------------------------------------------------------- */
/* 流式路径的 PcmPlayer 单例                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 流式 PCM 播放器（模块级单例）。
 *
 * 复用同一个实例而不是每条消息 new 一个：PcmPlayer 内部持有 AudioContext 与
 * 「下一片该在什么时刻播」的时间轴，重建就等于换一个上下文（又要一次手势才能
 * resume），而流式播放恰恰最依赖上下文已经就绪。
 */
let player: PcmPlayer | null = null

/** 当前播放器是按哪个采样率建的（响应头变了要重建，否则会变速）。 */
let playerSampleRate = 0

/** 取（或重建）流式播放器。 */
function ensurePlayer(sampleRate: number): PcmPlayer {
  if (player !== null && playerSampleRate === sampleRate) return player
  if (player !== null) {
    /*
     * 采样率变了（换了供应商 / 宿主升级）：旧播放器的时间轴是按旧采样率排的，
     * 继续喂新数据会整体变速。close 是异步释放，这里不 await —— 这条路径马上
     * 就要用新实例，旧实例的引用已经丢弃，GC 前它的上下文会被关掉。
     */
    const stale = player
    player = null
    void stale.close().catch(() => undefined)
  }
  player = new PcmPlayer(sampleRate)
  playerSampleRate = sampleRate
  // 新播放器默认满音量：不在这里套用，用户上次调小的音量会在重连后失效
  player.setVolume(volume)
  return player
}

/** 停掉流式播放队列（不清状态、不自增代次，调用方负责）。 */
function stopPlayer(): void {
  const current = player
  if (current === null) return
  try {
    current.interrupt()
  } catch {
    /* 播放器已释放 */
  }
}

/* -------------------------------------------------------------------------- */
/* 音量                                                                        */
/* -------------------------------------------------------------------------- */

/** 读当前朗读音量（0..1）；界面用它初始化滑块的初值。 */
export function getSpeechVolume(): number {
  return volume
}

/**
 * 设置朗读音量（0..1）：立即作用到两条播放路径，并跨会话记住。
 *
 * 对**正在播**的那一条也生效：滑块拖到一半时声音就该跟着变小，而不是
 * 「下一句才变」——调音量是这个控件唯一的存在理由，延后生效等于没做。
 * 非数字 / 越界按 1（满音量）处理，与 `loadSpeechVolume` 和通话音量同一口径。
 */
export function setSpeechVolume(next: number): void {
  volume = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 1
  if (gain !== null) {
    try {
      gain.gain.value = volume
    } catch {
      // 旧上下文已被浏览器关掉：下次 ensureGain 重建时会用新的 volume
    }
  }
  if (player !== null) {
    try {
      player.setVolume(volume)
    } catch {
      // 播放器已释放：下次 ensurePlayer 重建时会用新的 volume
    }
  }
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SPEECH_VOLUME_KEY, String(volume))
  } catch {
    /* 配额满 / 隐私模式禁用 localStorage：只影响下次的默认值 */
  }
}

/* -------------------------------------------------------------------------- */
/* 停止 / 预热                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 停止朗读（幂等）。
 *
 * 也用于「用户点气泡上的停止按钮」：连同正在路上的请求一起作废（generation 自增 +
 * abort fetch），否则点了停止之后音频还是会在半秒后响起来。流式路径还要清掉
 * PcmPlayer 已经排队的 PCM —— 那边是「边收边播」，停止时队列里通常还有好几秒。
 */
export function stopSpeech(): void {
  generation += 1
  abortRequest()
  stopPlayback()
  stopPlayer()
  patchState(idleState())
}

/**
 * 在用户手势里预热播放链路。
 *
 * 自动朗读发生在「消息到达」这一刻，不是用户手势——浏览器可能把这时新建的
 * AudioContext 判成 suspended 并拒绝 resume，表现就是「开关打开了但从来没响过」。
 * 发送消息 / 点喇叭都是手势，在那时先把**两条路径**的上下文都建好并恢复：
 *  · 整段 WAV 路径用本模块的 AudioContext；
 *  · 流式路径用 PcmPlayer 自己的 AudioContext（不预热的话它会在非手势时刻新建）。
 */
export function primeSpeech(): void {
  const audioContext = ensureContext()
  if (audioContext !== null && audioContext.state === 'suspended') {
    void audioContext.resume().catch(() => undefined)
  }
  const pcmPlayer = ensurePlayer(AUDIO_SAMPLE_RATE)
  void pcmPlayer.ensureRunning().catch(() => undefined)
}

/* -------------------------------------------------------------------------- */
/* 播放                                                                       */
/* -------------------------------------------------------------------------- */

/** 把失败响应翻成一句中文（宿主失败体形如 { ok:false, error }）。 */
async function failureReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') return body.error
  } catch {
    /* 不是 JSON（网关 502 页面等）：退回状态码 */
  }
  if (response.status === 404) return '朗读接口不存在（宿主可能还是旧版本，重启后再试）'
  if (response.status === 401 || response.status === 403) return '朗读被拒绝（检查 Live 供应商的 API Key）'
  return `朗读失败（HTTP ${response.status}）`
}

/** 把异常翻成用户能照做的一句话（网络层失败尤其需要翻译）。 */
function readableSpeechError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message
    if (error.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(message)) {
      return '连不上朗读服务（宿主没启动或接口不可达）'
    }
    if (error.name === 'AbortError') return '朗读已取消'
    return message === '' ? '朗读失败' : message
  }
  return '朗读失败'
}

/** decodeAudioData 的 Promise 包装（老 Safari 只支持回调形式，统一用回调收口）。 */
function decodeAudio(audioContext: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    try {
      audioContext.decodeAudioData(
        data,
        (buffer) => resolve(buffer),
        () => reject(new Error('朗读服务返回的音频无法解码')),
      )
    } catch (error) {
      reject(error instanceof Error ? error : new Error('朗读服务返回的音频无法解码'))
    }
  })
}

/** 句子边界：句末标点与换行（换行在清洗后通常已压成空格，纯函数仍要支持）。 */
const SENTENCE_BREAK_CHARS = new Set(['。', '！', '？', '；', '\n', '!', '?', ';'])

/** 次级断句：句内停顿（逗号 / 顿号），超长句靠它二次切分。 */
const CLAUSE_BREAK_CHARS = new Set(['，', '、', ','])

/**
 * 按句边界截断（找不到句末标点才硬切）。
 *
 * 用于整条消息的兜底上限：宁可少念最后半句，也不要念到一半突然停——
 * 用户听到的「半句话」和「停在句号后」是完全不同的体验。
 */
function truncateSpeechText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const window = text.slice(0, limit)
  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (SENTENCE_BREAK_CHARS.has(window.charAt(index))) {
      return `${window.slice(0, index + 1)}…`
    }
  }
  return `${window.slice(0, limit)}…`
}

/** 把一个超长句按逗号 / 顿号切成若干 <= limit 的小段（单个分句仍超长时硬切）。 */
function splitLongSentence(sentence: string, limit: number): string[] {
  const clauses: string[] = []
  let start = 0
  for (let index = 0; index < sentence.length; index += 1) {
    if (CLAUSE_BREAK_CHARS.has(sentence.charAt(index))) {
      clauses.push(sentence.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < sentence.length) clauses.push(sentence.slice(start))

  const pieces: string[] = []
  let current = ''
  const flush = (): void => {
    const text = current.trim()
    if (text !== '') pieces.push(text)
    current = ''
  }
  for (const clause of clauses) {
    if (current.length + clause.length <= limit) {
      current += clause
      continue
    }
    flush()
    if (clause.length <= limit) {
      current = clause
      continue
    }
    // 极端情况：整段没有标点（或单个分句就超长）——只能硬切，保证每段不超上限
    for (let offset = 0; offset < clause.length; offset += limit) {
      const slice = clause.slice(offset, offset + limit)
      if (slice.trim() !== '') pieces.push(slice.trim())
    }
  }
  flush()
  return pieces
}

/**
 * 把朗读文本切成若干不超过 max 字的片段（导出给测试与以后的预览逻辑用）。
 *
 * 为什么要分段：宿主的 TTS 端点有 REALTIME_TTS_MAX_CHARS（400）硬截断，
 * 前端早先又在 240 字处截一次，于是长回复永远念不完。把整条消息按语义切成
 * 小段、逐段请求逐段播放，既绕开两处上限，也保证每段都能完整念出来。
 *
 * 切分顺序（尽量保住语义完整）：
 *  1. 先按句末标点（。！？；换行）切句，相邻短句合并到不超过 max；
 *  2. 单句仍超长时按逗号 / 顿号二次切；
 *  3. 连分句都超长（极端无标点）才硬切。
 *
 * 保证：每段长度 <= max；除首尾空白外不丢字（切分只做 trim）。
 */
export function splitSpeechChunks(text: string, max: number = SPEECH_CHUNK_CHARS): string[] {
  const source = text.replace(/\r\n?/g, '\n').trim()
  if (source === '') return []
  // max 非法时按 1 处理，避免死循环 / 无限切分
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1

  const sentences: string[] = []
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    if (!SENTENCE_BREAK_CHARS.has(source.charAt(index))) continue
    const sentence = source.slice(start, index + 1)
    if (sentence.trim() !== '') sentences.push(sentence)
    start = index + 1
  }
  const tail = source.slice(start)
  if (tail.trim() !== '') sentences.push(tail)

  const chunks: string[] = []
  let current = ''
  const flush = (): void => {
    const piece = current.trim()
    if (piece !== '') chunks.push(piece)
    current = ''
  }
  for (const sentence of sentences) {
    if (current.length + sentence.length <= limit) {
      current += sentence
      continue
    }
    flush()
    if (sentence.trim().length <= limit) {
      current = sentence
      continue
    }
    for (const piece of splitLongSentence(sentence, limit)) chunks.push(piece)
  }
  flush()
  return chunks
}

/** 朗读前的二次压缩 + 句边界截断（调用方可能直接传原始 Markdown）。 */
function limitSpeechText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return truncateSpeechText(collapsed, SPEECH_MAX_CHARS)
}

/** 响应体形态：流式 PCM / 整段 WAV / JSON（失败体）。 */
type SpeechResponseKind = 'stream' | 'wav' | 'json'

/**
 * 按 content-type 判断响应体形态。
 *
 * 为什么必须按 content-type 而不是只看请求里传了 stream：旧宿主会**忽略** stream
 * 字段照旧回整段 WAV，新前端不能因此播不出来。反过来，宿主报错时回的是 JSON，
 * 也不能拿 decodeAudioData 去啃。
 *
 * 兜底走 WAV：content-type 缺失（某些反代 / 老宿主）时最可能是整段 WAV，
 * 交给 decodeAudioData 试一次比直接报错更有用。
 */
function responseKind(response: Response): SpeechResponseKind {
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  if (type.includes(REALTIME_TTS_STREAM_MIME)) return 'stream'
  if (type.includes('application/json')) return 'json'
  return 'wav'
}

/** 读响应头里的 PCM 采样率（缺省 / 非法值回落到通话同款 24000）。 */
function parseSampleRate(raw: string | null): number {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : AUDIO_SAMPLE_RATE
}

/** 等一小会儿（轮询播放队列用）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 等播放队列排空。
 *
 * 为什么不能读完流就回空闲：读流结束只代表音频**全部入队**了，队列里往往还有
 * 几秒没播完。这时把状态切回空闲，气泡上的按钮会提前变回喇叭，用户再点一下
 * 就会从半句话重新开始。
 *
 * 超时是防御：AudioContext 若被浏览器挂起（自动播放策略 / 系统休眠），队列里的
 * source 永远不会结束，playing 会一直是 true；按音频总时长 + 余量封顶，避免状态
 * 卡死在 speaking 上。
 */
async function waitPlayerIdle(pcmPlayer: PcmPlayer, token: number, samples: number, sampleRate: number): Promise<void> {
  const estimatedMs = sampleRate > 0 ? (samples / sampleRate) * 1000 : 0
  const deadline = Date.now() + Math.max(30_000, estimatedMs + 15_000)
  while (token === generation && pcmPlayer.playing && Date.now() < deadline) {
    await delay(PLAYER_IDLE_POLL_MS)
  }
}

/**
 * 旧宿主路径：整段 WAV 解码后一次播完。
 *
 * 返回的 Promise 在 onended 时 resolve（被 stopPlayback 打断时也由它兑现），
 * speakText 靠它实现「这一段播完再请求下一段」；状态收尾统一由 speakText 做，
 * 这里不再自己 patchState(idleState())——否则分段朗读时第一段播完就会闪回空闲。
 */
async function playBuffer(audioContext: AudioContext, buffer: AudioBuffer, token: number): Promise<void> {
  const node = audioContext.createBufferSource()
  node.buffer = buffer
  node.connect(ensureGain(audioContext))
  const finished = new Promise<void>((resolve) => {
    const settle = (): void => {
      if (finishPlayback === settle) finishPlayback = null
      resolve()
    }
    finishPlayback = settle
    node.onended = (): void => {
      // 只有「当前这一条」播完才清引用；被打断的旧节点由新播放接管
      if (token === generation) source = null
      settle()
    }
  })
  source = node
  try {
    node.start()
  } catch (error) {
    source = null
    resolvePlayback()
    throw error instanceof Error ? error : new Error('朗读播放失败')
  }
  patchState({ speaking: true, loading: false, error: null })
  await finished
}

/**
 * 流式路径：边读边喂 PcmPlayer。
 *
 * 关键点：
 *  · 首片一入队就切 speaking（loading 只到首片为止）——这就是「边收边播」的全部意义；
 *  · 块边界可能把 PCM16 的一个采样切成两半（两字节一个采样），所以跨块要留 carry，
 *    否则每读一块都会把采样数错开一位，听起来是持续的爆音；
 *  · 读完不是结束，还要等队列播完（见 waitPlayerIdle）。
 */
async function playSpeechStream(response: Response, token: number): Promise<void> {
  const body = response.body
  if (body === null) throw new Error('朗读服务没有返回音频流')
  const sampleRate = parseSampleRate(response.headers.get(REALTIME_TTS_SAMPLE_RATE_HEADER))
  const pcmPlayer = ensurePlayer(sampleRate)
  // 懒创建它自己的 AudioContext 并 resume（没有手势时内部吞掉错误，
  // 但外层已经在 speakText 里做过一次「浏览器允不允许出声」的判定）
  await pcmPlayer.ensureRunning()
  if (token !== generation) return

  const reader = body.getReader()
  let carry = new Uint8Array(0)
  let samples = 0
  let started = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (token !== generation) return
      if (done) break
      if (value === undefined || value.length === 0) continue
      const merged = new Uint8Array(carry.length + value.length)
      merged.set(carry, 0)
      merged.set(value, carry.length)
      const usable = merged.length - (merged.length % 2)
      if (usable > 0) {
        // 契约写的是小端 PCM16；浏览器（含所有主流移动端）都是小端，直接按平台字节序解释
        pcmPlayer.enqueue(new Int16Array(merged.buffer, merged.byteOffset, usable / 2))
        samples += usable / 2
        if (!started) {
          started = true
          patchState({ speaking: true, loading: false, error: null })
        }
      }
      carry = merged.slice(usable)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 已经释放 / 还有未完成的 read */
    }
  }
  if (token !== generation) return
  if (!started) throw new Error('朗读服务没有返回音频')
  await waitPlayerIdle(pcmPlayer, token, samples, sampleRate)
  /*
   * 这里不再 patchState(idleState())：分段朗读时这只是整条消息中的一段，
   * 播完要保持在 speaking，等 speakText 循环把全部段都播完再统一回空闲。
   * （旧实现是单段一次请求，所以才会在这里收尾；现在收尾职责上移。）
   */
}

/**
 * 朗读一段文字（同一时刻只播一条，新播放自动停掉旧的）。
 *
 * 长文本会按 splitSpeechChunks 切成多段：逐段请求、**等这一段真的播完**再请求
 * 下一段，段与段之间保持 speaking 状态，全部播完才统一回到空闲。
 * 每个异步步骤前后都检查 generation token：用户停止 / 点了另一条时立刻中断。
 *
 * @param text 要念的文字（会再压缩空白、按句边界截断到 SPEECH_MAX_CHARS）。
 * @param options 供应商 / 音色 / 消息 id；全部可选。
 */
export async function speakText(text: string, options: SpeakOptions = {}): Promise<void> {
  const spoken = limitSpeechText(text)
  if (spoken === '') return
  // 单段上限再和宿主契约取小：不管宿主上限怎么变，都不会发一个会被它截断的请求
  const chunks = splitSpeechChunks(spoken, Math.min(SPEECH_CHUNK_CHARS, REALTIME_TTS_MAX_CHARS))
  if (chunks.length === 0) return

  const token = (generation += 1)
  /*
   * 先停旧的：用户点了另一条，那条就该立刻闭嘴，而不是等新的请求回来。
   * 在途请求也一并取消——否则宿主会同时合成好几段，白烧上游调用。
   */
  abortRequest()
  stopPlayback()
  stopPlayer()
  patchState({ speaking: false, loading: true, error: null, messageId: options.messageId ?? null })

  /*
   * 先确认浏览器允许出声，再发请求。
   *
   * 页面级自动播放策略对所有 AudioContext 一致：这里的上下文起不来（没有用户手势），
   * 流式路径的 PcmPlayer 也一样起不来。提前返回既省一次上游合成，也避免「状态在
   * speaking、实际没声音」的假象。
   */
  const audioContext = ensureContext()
  if (audioContext === null) {
    // 没有 Web Audio：静默放弃（朗读是增强功能，不值得弹一条错误挡住用户）
    patchState(idleState())
    return
  }
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume()
    } catch {
      /* 浏览器拒绝：按被拦处理，走下面的静默失败 */
    }
  }
  if (token !== generation) return
  if (audioContext.state !== 'running') {
    patchState(idleState())
    return
  }

  const controller = new AbortController()
  requestAbort = controller
  try {
    for (const chunk of chunks) {
      // 每一段开始前都看一眼：上一段播放期间用户可能已经点了停止 / 另一条
      if (token !== generation) return

      const body: RealtimeTtsRequest = {
        text: chunk,
        // 新前端总是要流式：首包即出声，这是「播放延迟太高」的修复本体
        stream: true,
        ...(options.botId !== undefined && options.botId !== '' ? { botId: options.botId } : {}),
        ...(options.vendor !== undefined && options.vendor !== '' ? { vendor: options.vendor } : {}),
        ...(options.voice !== undefined && options.voice !== '' ? { voice: options.voice } : {}),
        ...(options.speed !== undefined ? { speed: options.speed } : {}),
      }
      const response = await fetch(REALTIME_TTS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      // 等待期间用户可能已经点了别的消息 / 点了停止：迟到的响应直接丢弃
      if (token !== generation) return
      if (!response.ok) throw new Error(await failureReason(response))

      const kind = responseKind(response)
      if (kind === 'json') {
        // 200 却是 JSON：宿主把错误塞进了正常响应（新宿主的失败体也可能这么回）
        throw new Error(await failureReason(response))
      }
      if (kind === 'stream') {
        await playSpeechStream(response, token)
      } else {
        // 旧宿主：整段 WAV（或没带 content-type 的二进制）
        const data = await response.arrayBuffer()
        if (token !== generation) return
        if (data.byteLength === 0) throw new Error('朗读服务没有返回音频')
        const buffer = await decodeAudio(audioContext, data)
        if (token !== generation) return
        await playBuffer(audioContext, buffer, token)
      }
      /*
       * 这一段播完了。段间保持 speaking：下一段的请求 / 解码期间用户仍该看到
       * 「正在朗读」，否则按钮会闪回喇叭、状态也会来回跳。
       */
      if (token !== generation) return
      patchState({ speaking: true, loading: false, error: null, messageId: options.messageId ?? null })
    }
    // 所有段都播完才统一收尾（中途停止的路径由 stopSpeech 自己收状态）
    if (token !== generation) return
    patchState(idleState())
  } catch (error) {
    if (token !== generation) return
    // 流式路径可能已经出过声：出错时把队列也收掉，避免半句卡在播放队列里
    stopPlayer()
    patchState({ speaking: false, loading: false, error: readableSpeechError(error), messageId: null })
  } finally {
    // 只清理自己那条：期间可能已经有新的 speakText 把 requestAbort 换成了新句柄
    if (requestAbort === controller) requestAbort = null
  }
}

/* -------------------------------------------------------------------------- */
/* 文本清洗（把 Markdown 正文变成能念的句子）                                   */
/* -------------------------------------------------------------------------- */

/**
 * 把一段 Markdown 正文洗成「能念出来」的纯文本。
 *
 * 为什么要洗：模型回复里混着代码块、表格、加粗星号、链接地址。直接丢给 TTS，
 * 用户会听到「星号星号 重点 星号星号」「h t t p s 冒号斜杠斜杠」——那不是在念
 * 内容，是在念排版。规则只保留「读者会念出来的东西」：
 *  · 代码块整段去掉（念函数定义没有任何意义）；
 *  · 行内代码只去反引号、保留文字（命令是用户真的要听的内容）；
 *  · 链接只留链接文字、图片整段去掉；
 *  · 标题 / 列表 / 引用 / 表格的 Markdown 符号去掉；
 *  · 最后压缩空白，超过整条消息上限时按句边界截断（不切在半句中间）。
 *
 * 导出它而不是只导出 speechTextOf：测试要能直接喂字符串，别的地方（比如以后的
 * 朗读预览）也用得上。
 */
export function cleanSpeechText(raw: string): string {
  let text = raw
  // 代码块（含围栏标记与内容）整段丢掉
  text = text.replace(/```[\s\S]*?```/g, ' ')
  // 行内代码：只去反引号，保留里面的字
  text = text.replace(/`([^`]*)`/g, '$1')
  // 图片：alt 往往是文件名，念出来毫无意义
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  // 链接：保留链接文字，丢掉地址
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // HTML 标签（模型偶尔会夹 br / b 之类）
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  // 表格分隔行（|---|:--:|）整行丢掉
  text = text.replace(/^[ \t]*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
  // 表格的竖线换成空格（保留单元格文字）
  text = text.replace(/\|/g, ' ')
  // 行首的 Markdown 标记：标题 #、引用 >、无序列表 - * +、有序列表 1.
  text = text.replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '')
  // 加粗 / 斜体 / 删除线的星号与下划线
  text = text.replace(/[*_~]{1,3}/g, '')
  // 压缩空白：TTS 不在乎换行，连续空白只会变成奇怪的停顿
  text = text.replace(/\s+/g, ' ').trim()
  // 超过整条消息上限时按句边界收尾：念到句号停，比念到一半突然断掉自然得多
  if (text.length > SPEECH_MAX_CHARS) return truncateSpeechText(text, SPEECH_MAX_CHARS)
  return text
}

/**
 * 一条消息的可朗读文本（空串 = 这条消息不可朗读）。
 *
 * 只取 text 块：工具卡、生图卡、交互卡都不是「一段话」，念出来只会是噪音。
 * 多段正文按行拼接，交给 cleanSpeechText 统一压缩。
 */
export function speechTextOf(message: Message): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text)
  }
  if (parts.length === 0) return ''
  return cleanSpeechText(parts.join('\n'))
}
