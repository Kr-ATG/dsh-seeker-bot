/**
 * 实时会话的「翻译层」：StepFun 上游事件 ⇄ 我们自己的协议（src/shared/realtime-protocol.ts）。
 *
 * 为什么不把上游 JSON 原样透传给浏览器：
 *
 * 1. 上游事件字段名与语义会随版本漂移（`transcript` / `text` / `delta` 各有出处），
 *    原样透传等于把「StepFun 协议细节」焊进前端，换模型就得改 UI。
 * 2. 浏览器只需要少量事件；把 `rate_limits.updated`、`content_part.*` 这些也推过去
 *    只是白烧带宽、还要前端写一堆空分支。
 * 3. 映射函数是纯函数，可以离线单测——不用起网络就能验证「上游这么发，前端收到什么」。
 *
 * 反过来（浏览器 → 上游）的映射也在这里，因为两边要保证对称，拆开容易漏。
 */

import {
  REALTIME_SAMPLE_RATE,
  speedInstruction,
  vendorProfile,
  type RealtimeServerMessage,
  type RealtimeSpeed,
  type RealtimeVendor,
} from '../../../shared/realtime-protocol.ts'

/** 上游事件的最小形状（只声明我们真正读的字段）。 */
interface UpstreamEvent {
  type?: unknown
  [key: string]: unknown
}

/** 从事件里安全地取字符串字段。 */
function textOf(event: UpstreamEvent, key: string): string {
  const value = event[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 我们**故意**不转发给浏览器的上游事件。
 *
 * 用途：把「已知忽略」和「不认识」区分开。上游换版本改名时（比如把
 * `response.audio.delta` 改成 `response.output_audio.delta`），事件会掉进
 * default 分支被静默丢弃——表现是「有声音没字幕」或「完全没声，且零报错」，
 * 这种故障最难查。宿主会把不在这个集合里的未知事件类型计数进诊断路由，
 * 于是「连上了但没声音」能一眼看出是事件名漂移，而不是网络问题。
 */
export const IGNORED_UPSTREAM_EVENTS: ReadonlySet<string> = new Set([
  'session.created',
  'session.updated',
  'input_audio_buffer.committed',
  'input_audio_buffer.cleared',
  'conversation.item.created',
  'conversation.item.deleted',
  'conversation.item.input_audio_transcription.delta',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.audio.done',
  'response.text.done',
  'response.cancel',
  'response.cancelled',
  'rate_limits.updated',
])

/**
 * 把一条上游事件翻译成浏览器侧协议事件。
 * @param event 上游 JSON 事件。
 * @returns 要转发给浏览器的事件；返回 null 表示这条事件前端不需要。
 */
export function mapUpstreamEvent(event: UpstreamEvent): RealtimeServerMessage | null {
  const type = typeof event.type === 'string' ? event.type : ''
  switch (type) {
    case 'input_audio_buffer.speech_started': {
      const atMs = event.audio_start_ms
      return {
        type: 'speech_started',
        itemId: textOf(event, 'item_id') || undefined,
        atMs: typeof atMs === 'number' ? atMs : Number(atMs) || undefined,
      }
    }
    case 'input_audio_buffer.speech_stopped':
      return { type: 'speech_stopped', itemId: textOf(event, 'item_id') || undefined }

    // 用户这一轮的 ASR：服务端自动识别，不需要本地 SenseVoice
    case 'conversation.item.input_audio_transcription.completed': {
      const transcript = textOf(event, 'transcript')
      if (transcript.trim() === '') return null
      return { type: 'user_transcript', itemId: textOf(event, 'item_id') || undefined, text: transcript }
    }

    // Bot 语音的转写（边听边看字幕）
    case 'response.audio_transcript.delta': {
      const delta = textOf(event, 'delta')
      if (delta === '') return null
      return { type: 'bot_transcript_delta', itemId: textOf(event, 'item_id') || undefined, delta }
    }
    case 'response.audio_transcript.done': {
      const transcript = textOf(event, 'transcript')
      if (transcript.trim() === '') return null
      return { type: 'bot_transcript_done', itemId: textOf(event, 'item_id') || undefined, transcript }
    }

    // 文本模态的增量（modalities 同时开了 text 时才有；用来补字幕空缺）
    case 'response.text.delta': {
      const delta = textOf(event, 'delta')
      if (delta === '') return null
      return { type: 'bot_text_delta', itemId: textOf(event, 'item_id') || undefined, delta }
    }

    // 边想边说：思考过程
    case 'response.thinking.delta': {
      const delta = textOf(event, 'delta')
      if (delta === '') return null
      return { type: 'thinking_delta', delta }
    }
    case 'response.thinking.done': {
      const thinking = textOf(event, 'thinking')
      if (thinking === '') return null
      return { type: 'thinking_done', thinking }
    }

    // 下行音频：base64 的 24k 单声道 PCM16，原样转发（浏览器自己解码）
    case 'response.audio.delta': {
      const audio = textOf(event, 'delta')
      if (audio === '') return null
      return { type: 'audio_delta', itemId: textOf(event, 'item_id') || undefined, audio }
    }

    case 'response.created':
      return { type: 'response_created' }

    case 'response.done': {
      const response = event.response
      const status = response !== null && typeof response === 'object'
        ? String((response as { status?: unknown }).status ?? 'completed')
        : 'completed'
      return { type: 'response_done', status }
    }

    case 'error': {
      // 上游有两种错误形状：文档里是 { error: { type, code, message } }，
      // 少数情况下是扁平 { code, message }。两种都认。
      const nested = event.error
      const detail = nested !== null && typeof nested === 'object' ? nested as Record<string, unknown> : null
      const message = String(detail?.message ?? event.message ?? '实时语音上游返回错误')
      const code = detail?.code ?? event.code
      return {
        type: 'error',
        message,
        code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
        // 上游中途报错多数是这一轮请求的问题（比如音频不完整），重连整条会话意义不大
        retryable: false,
      }
    }

    // 其余（session.created/updated、input_audio_buffer.committed/cleared、
    // conversation.item.created/deleted、response.output_item.*、content_part.*、
    // rate_limits.updated）前端不需要单独处理
    default:
      return null
  }
}

/**
 * 拼 `session.update` 的 session 载荷。
 *
 * 几个参数是踩过坑的选择，改之前先读注释：
 *
 * - `modalities: ['text','audio']` —— 同时开文本，字幕才有 `response.text.*` 兜底；
 *   只开 audio 时某些模型不保证给 transcript。
 * - `turn_detection.silence_duration_ms = 800` —— 官方默认 100ms 太激进，用户稍微
 *   想一下就被判「说完了」，会截断句子。800ms 接近人与人对话的自然停顿。
 * - `prefix_padding_ms = 500` —— 官方默认值，保留一点前置音频，避免吃掉第一个字。
 * - `energy_awakeness_threshold = 2500` —— 官方默认；环境噪声大的机器上可以调高。
 * - `voice` 一旦本轮生成过音频就不可改（官方限制），所以只在 start 时下发一次。
 * - `webSearch` **默认开**。语音会话里模型没有任何别的联网手段——Bot 在聊天里能调
 *   的是 DSH agent 的 `web_search` 工具，而 Realtime 会话是另一条独立链路，agent 的
 *   工具根本不在里面。不开这个内置工具，用户问「今天 GitHub 有什么更新」时模型只能
 *   回「我这边没法联网」，实测体验极差（用户当场追问「step 不是有内置联网搜索吗」）。
 *   代价是它可能自己发起搜索、多几百毫秒延迟——这个代价值得。
 */
export function buildSessionUpdate(options: {
  instructions: string
  voice: string
  /** 是否开启内置联网搜索工具（默认开，见上面的注释）。 */
  webSearch?: boolean
  /** 自定义 silence_duration_ms（调试用）。 */
  silenceDurationMs?: number
  /** 给这次 update 一个 id，便于上游拒绝时精确识别是哪条被拒（见 index.ts 的降级逻辑）。 */
  eventId?: string
  /**
   * 是否注册 `run_task`（把任务交回 Bot 的 agent loop）。
   * 只有 start 帧带了 Bot 定义时才为真——没有 agent 时注册了也执行不了。
   */
  agentTools?: boolean
  /**
   * 供应商（决定几处**不兼容**的字段写法，见下）。
   *
   * 各家虽然都自称 OpenAI Realtime 兼容，但实测差异点集中在这三处：
   * - 音频格式名：StepFun 要 `pcm16`，千问要 `pcm`；
   * - VAD 阈值字段：StepFun 是 `energy_awakeness_threshold`(0~5000)，
   *   千问是 `threshold`(0~1)；
   * - 语速：千问有真实参数 `speech_rate`，StepFun 只能靠 instructions。
   */
  vendor?: RealtimeVendor
  /** 千问的语速数值（0.5~2.0）。仅 `speedMode === 'speech_rate'` 时使用。 */
  speechRate?: number
}): Record<string, unknown> {
  const {
    instructions,
    voice,
    webSearch = true,
    silenceDurationMs = 800,
    eventId,
    agentTools = false,
    vendor = 'stepfun',
    speechRate,
  } = options
  const profile = vendorProfile(vendor)
  const isQwen = profile.id === 'qwen'
  const session: Record<string, unknown> = {
    modalities: ['text', 'audio'],
    instructions,
    voice,
    // 格式名各家不同：写错不会报错，只会被上游当成未知格式忽略或拒掉整条 update
    input_audio_format: isQwen ? 'pcm' : 'pcm16',
    output_audio_format: isQwen ? 'pcm' : 'pcm16',
    turn_detection: isQwen
      ? {
        type: 'server_vad',
        // 千问的阈值是 0~1 的比例，不是 StepFun 那种 0~5000 的能量值
        threshold: 0.5,
        silence_duration_ms: silenceDurationMs,
      }
      : {
        type: 'server_vad',
        prefix_padding_ms: 500,
        silence_duration_ms: silenceDurationMs,
        energy_awakeness_threshold: 2500,
      },
  }
  // 千问有真实语速参数（0.5~2.0）；StepFun 没有，只能靠 instructions（见 wrapVoiceInstructions）
  if (isQwen && typeof speechRate === 'number' && Number.isFinite(speechRate)) {
    session.speech_rate = Math.min(2, Math.max(0.5, speechRate))
  }
  /*
   * tools 只在真有工具时才带上：`tools: []` 这种空数组上游未必接受，而「没有这个
   * 字段」是各家都认的写法。timeout_seconds 官方默认 3 秒，搜索类请求偏紧，给到 6。
   */
  const tools: unknown[] = []
  if (webSearch) {
    tools.push({
      type: 'web_search',
      function: {
        description: '联网搜索最新信息。当用户问到实时动态、新闻、版本发布、价格、天气等需要最新数据的问题时使用。',
        options: { top_k: 5, timeout_seconds: 6 },
      },
    })
  }
  /*
   * run_task：把「真正动手」交回 Bot 的 agent loop。
   *
   * 为什么必须有它：Realtime 会话是**独立链路**，Bot 在聊天里能调的 agent 工具
   * （生图 / 生视频 / 读写文件 / 跑命令 / 记忆）一个都不在里面。没有这个工具时，
   * 用户说「帮我生成一张图」，模型只能回「我没有这个功能」——这正是用户实测
   * 截图里的场景。
   *
   * description 决定模型会不会用它，所以写得比较「会劝」：明确列出该用的场景，
   * 也明确排除闲聊，避免它把每句话都当成任务去跑 agent（那会让每轮都卡几秒）。
   */
  if (agentTools) {
    tools.push({
      type: 'function',
      function: {
        name: 'run_task',
        description: [
          '把任务交给背后的执行助手去真正完成。',
          '当用户要求你做实际的事——生成图片或视频、查资料并整理、读写本地文件、运行命令、查看工作区、记住/回忆事情——时调用它。',
          '闲聊、常识问答、情绪回应、单纯解释概念，不要调用。',
          '参数 task 用一句话说清「做什么 + 要什么产出」，执行助手看不到你们的对话上下文。',
          '调用后任务在后台跑，期间你还可以继续和用户说话；结果会以工具结果的形式回到你手里，届时用一两句口语汇报。',
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: '要执行的任务，一句话说清目标与产出，例如「生成一张海边日落的插画，16:9」。',
            },
          },
          required: ['task'],
        },
      },
    })
  }
  if (tools.length > 0) session.tools = tools
  return eventId === undefined
    ? { type: 'session.update', session }
    : { event_id: eventId, type: 'session.update', session }
}

/**
 * 语音通话的系统指令包装：把 Bot 的人设塞进去，再压一层「这是语音通话」的约束。
 *
 * 不做这层包装的后果很直观：模型会把 Markdown、列表、代码块念出来（「星号星号
 * 加粗星号星号」），或者一次说几百字——屏幕上看着没事，耳朵里是灾难。
 *
 * 倒数第二条是**中性**的联网提示：它不说「你有搜索工具」（工具万一被上游拒掉，
 * 模型会开始胡说），只说「先查、查不到再如实说」，两种情况都成立。
 */
export function wrapVoiceInstructions(persona: string, speed?: RealtimeSpeed): string {
  const trimmed = persona.trim()
  const constraints = [
    '现在是一次实时语音通话，你说的每句话都会被直接念出来给用户听。',
    '请用口语、短句回答，通常 1~3 句就够，不要长篇大论。',
    '绝对不要输出 Markdown 标记、列表符号、代码块、表格或表情符号——它们会被逐字念出来。',
    '需要分点时用「第一、第二」这样的口语连接词。',
    '遇到需要最新信息的问题（新闻、版本发布、实时动态、价格、天气等），先用你能用的工具去查，查不到再如实说明，不要凭空猜测，也不要一上来就说自己不能联网。',
    '如果用户让你做实际的事（生成图片、查资料整理、读写文件、跑命令等），先判断你手上有没有对应工具：有就直接做；没有就用 run_task 交给执行助手，不要说「我没有这个功能」。',
    '听不清或没听懂时直接说，不要猜。',
  ]
  // 语速只能靠指令表达（Realtime API 没有 speed 参数，见 speedInstruction 的注释）
  const pace = speedInstruction(speed)
  if (pace !== '') constraints.splice(1, 0, pace)
  const body = constraints.join('\n')
  return trimmed === '' ? body : `${trimmed}\n\n${body}`
}

/** 会话就绪事件的载荷（`session.created` 之后、`session.update` 生效时发一次）。 */
export function readyMessage(options: {
  model: string
  voice: string
  maxSessionMs: number
  /** 供应商（决定前端按哪个采样率采集）。 */
  vendor?: RealtimeVendor
}): RealtimeServerMessage {
  const profile = vendorProfile(options.vendor)
  return {
    type: 'ready',
    model: options.model,
    voice: options.voice,
    sampleRate: profile.outputSampleRate,
    // 上行采样率必须下发：千问要 16k、StepFun 要 24k，前端按这个重采样
    inputSampleRate: profile.inputSampleRate,
    vendor: profile.id,
    maxSessionMs: options.maxSessionMs,
  }
}
