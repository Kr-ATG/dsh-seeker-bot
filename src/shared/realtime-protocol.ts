/**
 * Personal Agent 全双工实时语音 —— 宿主半身与浏览器半身共享的协议契约。
 *
 * 这条链路替掉了原来的半双工通话（点按录音 → ASR → 模型 → Edge TTS 播放）：
 *
 *   浏览器（麦克风 / 扬声器）
 *        │  同源 WebSocket：/api/personal-agent/realtime
 *        ▼
 *   DSH 宿主（本文件对端的薄代理：鉴权、注入 API Key、下发 session 配置、转发事件）
 *        │  wss://api.stepfun.com/v1/realtime?model=...
 *        ▼
 *   StepFun Realtime API（服务端 VAD、自动 ASR、流式音频、可打断）
 *
 * 为什么必须有宿主这一跳：StepFun 用 `Authorization: Bearer <key>` 鉴权，而浏览器
 * 的 WebSocket 构造函数**不支持自定义请求头**。把 key 放进 URL query 会把它暴露给
 * 前端、浏览器历史、反代日志和截图。所以 key 只留在宿主进程里，浏览器只连本机
 * 同源端点。这条规则不要为了省事打破。
 *
 * 本文件只放**常量与类型**：两端都要 import 它，所以不能出现任何 node: 依赖，
 * 也不能有副作用。
 */

/**
 * 音频采样率：**24000 Hz 单声道 PCM16（小端）**。
 *
 * 输入与输出同一个采样率，官方 Realtime 文档的 `input_audio_format` /
 * `output_audio_format` 只支持 `pcm16`，官方 Realtime Console 也是按 24000
 * 建 AudioContext 的。两端任何一处改了这个值，另一处必须同步，否则会听到
 * 变速（采样率对不上）或 VAD 完全失效（时间轴对不上）。
 */
export const REALTIME_SAMPLE_RATE = 24000

/**
 * 上行音频分片时长（毫秒）。
 *
 * 官方建议 20~30ms 频繁提交：块太大会让服务端 VAD 攒够数据才判断，响应变慢；
 * 太小则 WebSocket 帧数暴涨。40ms 是延迟与开销的折中，配合 24kHz 单声道正好
 * 每片 1920 字节 PCM。
 */
export const REALTIME_CHUNK_MS = 40

/** 单片 PCM16 的字节数（REALTIME_CHUNK_MS 毫秒 × 24000 Hz × 2 字节）。 */
export const REALTIME_CHUNK_BYTES = (REALTIME_SAMPLE_RATE * REALTIME_CHUNK_MS) / 1000 * 2

/** 单个 PCM 采样点的字节数（PCM16）。 */
export const REALTIME_BYTES_PER_SAMPLE = 2

/**
 * 模型候选：按顺序尝试。
 *
 * `stepaudio-3-realtime-preview` 是文档主推的全双工模型（限免期名字，到期后
 * 官方会下线预览版并换成付费正式名），`stepaudio-2.5-realtime` 是当前已配置好
 * 的稳定版。第一个握手失败（模型不存在 / 无权限 / 限免结束）就换下一个，
 * 全部失败才把错误抛给用户。
 */
export const REALTIME_MODELS: readonly string[] = [
  'stepaudio-3-realtime-preview',
  'stepaudio-2.5-realtime',
]

/**
 * 默认音色：`linjiajiejie`（邻家姐姐）。
 *
 * Bot 模式是情感陪伴/语音助手场景，官方对这个音色的推荐场景正是「情感陪伴、
 * 语音助手」。注意 voice 一旦本轮生成过音频就不能再改（官方限制），要换只能
 * 重开一次会话。
 */
export const REALTIME_DEFAULT_VOICE = 'linjiajiejie'

/** 宿主默认上游地址。Step Plan 网关若不通，可在设置里改成这个官方地址。 */
export const REALTIME_DEFAULT_UPSTREAM = 'wss://api.stepfun.com/v1/realtime'

/** 宿主默认取哪一条凭据（DSH credentials 服务里的 ref）。 */
export const REALTIME_DEFAULT_KEY_REF = 'STEPPLAN_API_KEY'

/** 宿主注册的升级端点路径（浏览器连这个同源地址）。 */
export const REALTIME_PATH = '/api/personal-agent/realtime'

/** 诊断端点：不建连，只报告「有没有 key / 上游是谁 / 上次失败原因」。 */
export const REALTIME_DIAGNOSE_PATH = '/api/personal-agent/realtime/diagnose'

/** 设置端点：读写全局默认的实时语音配置（模型 / 音色 / 语速 / 联网 / 凭据 / 上游）。 */
export const REALTIME_CONFIG_PATH = '/api/personal-agent/realtime/config'

/**
 * 凭据写入端点：让用户直接在设置页填 API Key。
 *
 * 为什么要它：以前只能填「凭据名」（DSH credentials 里的引用名），用户还得先想办法
 * 把 key 塞进凭据库——做不到就只能找开发者改配置。这个端点把 key 直接写进凭据库，
 * 页面本身**永远不回显密钥值**。
 */
export const REALTIME_KEY_PATH = '/api/personal-agent/realtime/key'

/**
 * 初始的 Live 供应商列表（用户第一次打开设置页时看到的）。
 *
 * 它只是**初始值**，不是白名单：用户可以改、删、加任意条。宿主读到配置文件里没有
 * `vendors` 时用这份播种，写回文件后就以文件为准。
 */
export const DEFAULT_REALTIME_VENDORS: readonly RealtimeVendorRecord[] = [
  {
    id: 'stepfun',
    label: 'StepFun 阶跃星辰',
    upstream: 'wss://api.stepfun.com/v1/realtime',
    keyRef: 'STEPPLAN_API_KEY',
    model: 'stepaudio-3-realtime-preview',
    inputSampleRate: 24000,
    outputSampleRate: 24000,
  },
  {
    id: 'qwen',
    label: '千问 Qwen',
    upstream: 'wss://maas.qianwenaiapi.com/api-ws/v1/realtime',
    keyRef: 'QWEN_API_KEY',
    // 千问实时语音：输入 16k、输出 24k（官方文档明确写的，别想当然用 24k）
    inputSampleRate: 16000,
    outputSampleRate: 24000,
  },
]

/**
 * 单次会话最长时长（毫秒）。
 *
 * 官方硬限制 30 分钟。留 15 秒余量在到期前主动提示并收尾，避免用户说到一半
 * 被服务端直接掐断。
 */
export const REALTIME_MAX_SESSION_MS = 30 * 60 * 1000

/** 距到期多久开始提示（毫秒）。 */
export const REALTIME_WARN_BEFORE_MS = 60 * 1000

/* -------------------------------------------------------------------------- */
/* 浏览器 → 宿主                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 浏览器发给宿主的控制帧。
 *
 * 音频不走 JSON 的 `audio` 字段时也可以用二进制帧（裸 PCM16），宿主两种都收：
 * 二进制省掉 base64 的 33% 膨胀与编解码开销，适合麦克风连续上行；`audio`
 * 字段留给调试与回放。
 */
export type RealtimeClientMessage =
  /**
   * 开一次会话。宿主收到后取凭据、连上游、下发 `session.update`。
   *
   * `instructions` 是 Bot 的人设（宿主侧的 Bot 角色描述 + 语音通话的附加约束），
   * 由前端拼好后整段下发；宿主不再二次加工，只做长度上限保护。
   */
  | {
    type: 'start'
    botId: string
    instructions?: string
    /** 覆盖默认音色。 */
    voice?: string
    /** 覆盖模型候选（只试这一个，不做回退）。 */
    model?: string
    /**
     * 用哪个 Live 供应商（`RealtimeVendorRecord.id`）。
     *
     * Bot 上单独选过就传它，否则传全局默认，再没有宿主会取列表第一个。
     */
    vendor?: string
    /**
     * Bot 的 chat provider 路由 id（`stepplan` / `alymagpie` …）。
     *
     * 宿主按它读**该供应商**的实时语音配置（上游地址 / 凭据名 / 模型 / 音色 / 语速）。
     * 不带时回退 `agent.model.provider`，再没有就用全局默认。
     *
     * 为什么需要它：供应商在「普通 / Live」两种模式间切换时，Live 那套配置应该跟着
     * 供应商走，而不是所有供应商共用一份——否则在阿里喜鹊的详情页会看到 Step-Plan
     * 的音色与上游地址。
     */
    route?: string
    /**
     * Bot 的完整 agent 定义。
     *
     * 语音里让它「干活」（生成图片、查资料、读写文件、执行命令）时，宿主要靠这份
     * 定义跑真正的 agent loop——**Realtime 会话本身没有 agent 的工具**，不传这份
     * 定义，模型只能说「我没有这个功能」。
     *
     * 前端从 localStorage 的 Bot 记录里取，字段与 `src/host/personal/agent.ts` 的
     * `BotAgentSpec` 对齐（这里不 import 它：shared 不能依赖宿主代码）。
     */
    agent?: RealtimeAgentSpec
  }
  /** 追加一段上行音频：base64 编码的 24k 单声道 PCM16。 */
  | { type: 'audio'; audio: string }
  /** 打字输入：走 `conversation.item.create` + `response.create`。 */
  | { type: 'text'; text: string }
  /** 用户主动打断：取消当前响应并清空上游输入缓冲。 */
  | { type: 'interrupt' }
  /** 挂断：宿主关上游、释放会话。 */
  | { type: 'stop' }

/** 一个任务产物（语音里让 Bot 干活生成的东西）。 */
export interface RealtimeArtifact {
  kind: 'image' | 'video' | 'audio' | 'file'
  /** 同源 URL（宿主 `/api/personal-agent/file` 路由）或 data URL。 */
  url: string
  /** 文件名（卡片标题用）。 */
  name?: string
}

/**
 * Bot 的 agent 定义（语音里「干活」时用）。
 *
 * 字段刻意与 `BotAgentSpec` 同名同义，宿主侧直接透传即可。
 */
export interface RealtimeAgentSpec {
  botId: string
  name: string
  role: string
  description: string
  /** Bot 的人设（完整版，含能力说明）。 */
  instructions: string
  model?: { provider?: string; model?: string; effort?: string }
  /** 工具权限档位（'full' | 'approval'）。 */
  permission?: string
  /** 该 Bot 的记忆（前端持有，每次带上来）。 */
  memories?: string[]
}

/* -------------------------------------------------------------------------- */
/* 宿主 → 浏览器                                                               */
/* -------------------------------------------------------------------------- */

/** 宿主发给浏览器的帧。 */
export type RealtimeServerMessage =
  /** 会话就绪：上游 `session.created` 之后、`session.update` 生效后发一次。 */
  | {
    type: 'ready'
    model: string
    voice: string
    /** 下行采样率（播放用）。 */
    sampleRate: number
    /**
     * **上行采样率**（麦克风采集必须按它重采样）。
     *
     * 不同供应商要求不同（千问 16k、StepFun 24k），喂错不会报错，只会变调 + VAD
     * 时间轴错位。老宿主不发这个字段时，前端按 `sampleRate` 兜底。
     */
    inputSampleRate?: number
    /** 当前生效的供应商（`stepfun` / `qwen` / `custom`）。 */
    vendor?: RealtimeVendor
    maxSessionMs: number
  }
  /** 服务端 VAD 判定用户开始说话 —— 浏览器收到后必须立刻清空播放队列（打断）。 */
  | { type: 'speech_started'; itemId?: string; atMs?: number }
  /** 用户说完（VAD 判定语音结束）。 */
  | { type: 'speech_stopped'; itemId?: string }
  /** 用户这一轮的 ASR 结果（服务端自动识别，无需本地 ASR）。 */
  | { type: 'user_transcript'; itemId?: string; text: string }
  /** Bot 语音的转写增量（用于边听边看字幕）。 */
  | { type: 'bot_transcript_delta'; itemId?: string; delta: string }
  /** Bot 语音的完整转写。 */
  | { type: 'bot_transcript_done'; itemId?: string; transcript: string }
  /** Bot 的纯文本增量（文本模态也开着时才有）。 */
  | { type: 'bot_text_delta'; itemId?: string; delta: string }
  /** 边想边说：思考过程增量。 */
  | { type: 'thinking_delta'; delta: string }
  /** 思考过程结束（完整文本）。 */
  | { type: 'thinking_done'; thinking: string }
  /** 下行音频增量：base64 编码的 24k 单声道 PCM16。 */
  | { type: 'audio_delta'; itemId?: string; audio: string }
  /** 模型开始一轮响应。 */
  | { type: 'response_created' }
  /** 一轮响应结束（status: completed / cancelled / failed / incomplete）。 */
  | { type: 'response_done'; status: string }
  /** 打断已生效（宿主已向上游发了 `response.cancel`）。 */
  | { type: 'interrupted' }
  /**
   * 语音里让 Bot 干活了：模型判定要执行实际任务（生图 / 查资料 / 读写文件 / 跑命令），
   * 宿主已经把任务交给 Bot 的 agent loop 在后台跑。
   *
   * 任务与对话是**并行**的：执行期间用户还能继续说话，结果回来时模型会用语音接上。
   */
  | { type: 'task_started'; callId: string; task: string }
  /** 任务进度（工具调用等一句话描述；可选，不是所有 agent 都会给）。 */
  | { type: 'task_progress'; callId: string; note: string }
  /** 任务结束：成功给 summary（一句话结论），失败给 error。 */
  | {
    type: 'task_done'
    callId: string
    ok: boolean
    summary?: string
    error?: string
    /**
     * 这次任务产出的东西（图片 / 视频 / 文件）。
     *
     * 为什么要在协议里带上：语音里让它生图，用户要能在**对话流**里看到那张图、
     * 点开看大图——只让模型念一句「生成好了」是不够的。前端拿到后把它们落成
     * 普通消息的 image / artifact 块。
     */
    artifacts?: RealtimeArtifact[]
  }
  /** 会话即将到期（30 分钟上限），前端应提示用户。 */
  | { type: 'expiring'; inMs: number }
  /**
   * 出错。`retryable` 为真时前端可以自动重连（例如上游连接被对端重置），
   * 为假时必须让用户看见原因（缺 key、模型无权限、余额不足）。
   */
  | { type: 'error'; message: string; code?: string | number; retryable?: boolean }
  /** 会话关闭。reason 是给人看的一句话。 */
  | { type: 'closed'; reason: string }

/* -------------------------------------------------------------------------- */
/* 音色与语速（供应商设置页 / Bot 设置共用同一份清单）                          */
/* -------------------------------------------------------------------------- */

/** 一个可选音色。 */
export interface RealtimeVoiceOption {
  /** 传给上游 `session.update.voice` 的值。 */
  id: string
  /** 中文名（给用户看）。 */
  label: string
  /** 适用场景的一句话提示。 */
  hint?: string
}

/**
 * 官方音色清单（来自 StepFun TTS / Realtime 文档的「官方音色清单」）。
 *
 * 不同 realtime 模型支持的音色不完全一致（比如 `step-audio-2-mini` 只支持
 * `qingchunshaonv` 与 `wenrounansheng`），上游若拒绝某个音色会在 `session.updated`
 * 里回落到默认值——宿主会把**实际生效**的音色回传给界面，所以用户能看到真实结果。
 *
 * 复刻音色（自定义 voice id）不在这个清单里：设置界面允许手填 id。
 */
export const REALTIME_VOICES: readonly RealtimeVoiceOption[] = [
  { id: 'linjiajiejie', label: '邻家姐姐', hint: '情感陪伴、语音助手（默认）' },
  { id: 'qingchunshaonv', label: '清纯少女', hint: '语音助手、客服' },
  { id: 'linjiameimei', label: '邻家妹妹', hint: '视频配音、口播' },
  { id: 'wenrounansheng', label: '温柔男声', hint: '通用、陪伴' },
  { id: 'elegantgentle-female', label: '高雅女声', hint: '通用、专业感' },
  { id: 'livelybreezy-female', label: '活力女声', hint: '活泼、营销' },
  { id: 'magnetic-voiced-male', label: '磁性男声', hint: '有声书、视频配音' },
]

/** 语速档位。 */
export type RealtimeSpeed = 'slow' | 'normal' | 'fast'

/** 语速档位的中文名（设置界面直接用）。 */
export const REALTIME_SPEED_LABELS: Readonly<Record<RealtimeSpeed, string>> = {
  slow: '慢一点',
  normal: '正常',
  fast: '快一点',
}

/**
 * 把语速档位翻成一句指令。
 *
 * **Realtime API 没有独立的语速参数**（`session.update` 只认 modalities /
 * instructions / voice / turn_detection / 音频格式 / tools），所以语速只能通过
 * instructions 描述。这不是完美等价——模型可能不完全照做——但比没有强，而且
 * 不会因为塞了不存在的字段导致整条 `session.update` 被上游拒绝。
 */
export function speedInstruction(speed: RealtimeSpeed | undefined): string {
  if (speed === 'slow') return '语速比平常慢一点，把每个字说清楚。'
  if (speed === 'fast') return '语速可以稍快一些，保持利落。'
  return ''
}

/**
 * 一个**实时语音（Live）供应商**——用户可自由增删的实体。
 *
 * 与聊天供应商是**两个独立的列表**：聊天供应商管文字模型，Live 供应商管全双工语音。
 * 一个 Live 供应商就是「一个能连的 Realtime 端点 + 一把 key + 一个模型」。
 *
 * 以前的做法是把 Live 配置塞在每个聊天供应商详情页里用一个下拉切换，用户明确否掉了：
 * 那不是「新增供应商」，只是从三个写死的预设里挑一个。
 */
export interface RealtimeVendorRecord {
  /** 稳定 id（小写 slug，如 `stepfun` / `my-live`）。 */
  id: string
  /** 显示名（用户自己起）。 */
  label: string
  /** 上游 WS 地址（`wss://…`）。 */
  upstream: string
  /** 凭据引用名（DSH credentials 里的名字，如 `STEPPLAN_API_KEY`）。 */
  keyRef: string
  /** 指定模型；留空走宿主候选链（第一个能连上的就用）。 */
  model?: string
  /** 上行采样率 Hz；留空按 24000。喂错不报错，只会变调。 */
  inputSampleRate?: number
  /** 下行采样率 Hz；留空按 24000。 */
  outputSampleRate?: number
}

/** 供应商 / Bot 设置页读到的实时语音配置（字段全部可选）。 */
export interface RealtimeConfig {
  /**
   * Live 供应商列表（用户自己维护的那份）。
   *
   * 留空 = 还没配过，宿主会回落到内置预设（见 `REALTIME_VENDORS`）。
   */
  vendors?: RealtimeVendorRecord[]
  /** 默认用哪个 Live 供应商（Bot 没单独选时用它的 id）。 */
  defaultVendor?: string
  /** 音色 id；留空用宿主默认。 */
  voice?: string
  /** 语速档位。 */
  speed?: RealtimeSpeed
  /** 是否开启内置联网搜索（默认开）。 */
  webSearch?: boolean
  /**
   * @deprecated 旧版「单个预设供应商」字段，只用于读旧配置文件时迁移。
   * 新配置请用 `vendors` + `defaultVendor`。
   */
  vendor?: RealtimeVendor
  /** @deprecated 旧版单供应商下的模型覆盖；迁移进 `vendors[].model`。 */
  model?: string
  /** @deprecated 旧版单供应商下的凭据名；迁移进 `vendors[].keyRef`。 */
  keyRef?: string
  /** @deprecated 旧版单供应商下的上游地址；迁移进 `vendors[].upstream`。 */
  upstream?: string
}

/* -------------------------------------------------------------------------- */
/* 供应商预设                                                                  */
/* -------------------------------------------------------------------------- */

/** 内置的实时语音供应商。 */
export type RealtimeVendor = 'stepfun' | 'qwen' | 'custom'

/** 一个供应商的默认参数与能力。 */
export interface RealtimeVendorProfile {
  id: RealtimeVendor
  label: string
  /** 默认上游 WS 地址。 */
  upstream: string
  /** 默认凭据引用名。 */
  keyRef: string
  /**
   * 上行采样率（Hz）。
   *
   * **必须与供应商要求一致**：喂错采样率不会报错，只会让声音变调（放慢/加速），
   * 而且 VAD 的时间轴也会跟着错，表现是「说完了不响应」。千问要求 16k，
   * StepFun 是 24k——这是接第二家供应商时最容易踩的坑。
   */
  inputSampleRate: number
  /** 下行采样率（Hz）。 */
  outputSampleRate: number
  /**
   * 语速怎么表达：
   * - `speech_rate`：上游有真实参数（千问的 `session.speech_rate`，0.5~2.0）；
   * - `instructions`：只能写进系统指令（StepFun）。
   */
  speedMode: 'speech_rate' | 'instructions'
  /** 模型候选（按顺序回退）。 */
  models: readonly string[]
  /** 音色清单。 */
  voices: readonly RealtimeVoiceOption[]
  /** 默认音色。 */
  defaultVoice: string
}

/** 千问实时语音的系统音色（Qwen-Audio Realtime 系列）。 */
export const QWEN_REALTIME_VOICES: readonly RealtimeVoiceOption[] = [
  { id: 'longanqian_v3.1', label: '龙安千（3.1 默认）', hint: '通用、自然' },
  { id: 'longanlingxin', label: '龙安凌心', hint: '清亮女声' },
  { id: 'longanlingxi', label: '龙安凌希', hint: '温柔女声' },
  { id: 'longanxiaoxin', label: '龙安小欣', hint: '活泼女声' },
  { id: 'longanlufeng', label: '龙安陆风', hint: '沉稳男声' },
]

/**
 * 供应商预设表。
 *
 * 新增一家供应商时在这里加一条即可：上游地址、采样率、语速表达方式、音色清单、
 * 模型候选都收敛在这，宿主与前端都从这里读，不再各写一份。
 */
export const REALTIME_VENDORS: Readonly<Record<RealtimeVendor, RealtimeVendorProfile>> = {
  stepfun: {
    id: 'stepfun',
    label: 'StepFun 阶跃星辰',
    upstream: 'wss://api.stepfun.com/v1/realtime',
    keyRef: 'STEPPLAN_API_KEY',
    inputSampleRate: 24000,
    outputSampleRate: 24000,
    speedMode: 'instructions',
    models: ['stepaudio-3-realtime-preview', 'stepaudio-2.5-realtime'],
    voices: [
      { id: 'linjiajiejie', label: '邻家姐姐', hint: '情感陪伴、语音助手（默认）' },
      { id: 'qingchunshaonv', label: '清纯少女', hint: '语音助手、客服' },
      { id: 'linjiameimei', label: '邻家妹妹', hint: '视频配音、口播' },
      { id: 'wenrounansheng', label: '温柔男声', hint: '通用、陪伴' },
      { id: 'elegantgentle-female', label: '高雅女声', hint: '通用、专业感' },
      { id: 'livelybreezy-female', label: '活力女声', hint: '活泼、营销' },
      { id: 'magnetic-voiced-male', label: '磁性男声', hint: '有声书、视频配音' },
    ],
    defaultVoice: 'linjiajiejie',
  },
  qwen: {
    id: 'qwen',
    label: '千问 Qwen',
    upstream: 'wss://maas.qianwenaiapi.com/api-ws/v1/realtime',
    keyRef: 'QWEN_API_KEY',
    // 千问实时语音：输入 16k、输出 24k（官方文档明确写的，别想当然用 24k）
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    speedMode: 'speech_rate',
    models: ['qwen3.8-omni-flash-realtime', 'qwen-audio-3.1-realtime-plus'],
    voices: QWEN_REALTIME_VOICES,
    defaultVoice: 'longanqian_v3.1',
  },
  custom: {
    id: 'custom',
    label: '自定义（OpenAI Realtime 兼容）',
    upstream: 'wss://api.stepfun.com/v1/realtime',
    keyRef: 'STEPPLAN_API_KEY',
    inputSampleRate: 24000,
    outputSampleRate: 24000,
    speedMode: 'instructions',
    models: ['stepaudio-3-realtime-preview', 'stepaudio-2.5-realtime'],
    voices: [
      { id: 'linjiajiejie', label: '邻家姐姐', hint: '情感陪伴、语音助手（默认）' },
      { id: 'qingchunshaonv', label: '清纯少女', hint: '语音助手、客服' },
      { id: 'linjiameimei', label: '邻家妹妹', hint: '视频配音、口播' },
      { id: 'wenrounansheng', label: '温柔男声', hint: '通用、陪伴' },
      { id: 'elegantgentle-female', label: '高雅女声', hint: '通用、专业感' },
      { id: 'livelybreezy-female', label: '活力女声', hint: '活泼、营销' },
      { id: 'magnetic-voiced-male', label: '磁性男声', hint: '有声书、视频配音' },
    ],
    defaultVoice: 'linjiajiejie',
  },
}

/** 取供应商预设（未知/空值回退 stepfun）。 */
export function vendorProfile(vendor: RealtimeVendor | string | undefined): RealtimeVendorProfile {
  if (vendor === 'qwen') return REALTIME_VENDORS.qwen
  if (vendor === 'custom') return REALTIME_VENDORS.custom
  return REALTIME_VENDORS.stepfun
}

/** 语速档位 → 千问 `speech_rate` 数值（0.5~2.0，默认 1.0）。 */
export function speedToSpeechRate(speed: RealtimeSpeed | undefined): number {
  if (speed === 'slow') return 0.85
  if (speed === 'fast') return 1.15
  return 1
}

/** 解析一行文本帧；不是本协议的 JSON 就返回 null（调用方丢弃即可）。 */
export function parseServerMessage(raw: string): RealtimeServerMessage | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || typeof value !== 'object') return null
    const type = (value as { type?: unknown }).type
    if (typeof type !== 'string' || type === '') return null
    return value as RealtimeServerMessage
  } catch {
    return null
  }
}

/** 解析一行客户端控制帧；不是本协议的 JSON 就返回 null。 */
export function parseClientMessage(raw: string): RealtimeClientMessage | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || typeof value !== 'object') return null
    const type = (value as { type?: unknown }).type
    if (typeof type !== 'string' || type === '') return null
    return value as RealtimeClientMessage
  } catch {
    return null
  }
}
