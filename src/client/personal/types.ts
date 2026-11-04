/**
 * Personal Agent — 共享类型（前端 + 独立演示页）。
 *
 * 所有展示型数据结构都收敛在这里：Bot / 分组 / 群聊 / 消息块 / 记忆 / 例行任务 /
 * 通话 / 期刊。store 与各组件只依赖本文件，不各自发明字段。
 */
import { REALTIME_VOICES, type RealtimeVendorRecord } from '../../shared/realtime-protocol.ts'
// 这里必须拿到**本地绑定**：下面那段 `export type { … } from` 只做再导出，不会在当前
// 作用域建名，AppState 里直接写 Journal / JournalTriggerLog 会报「找不到名字」。
import type { JournalRecord as Journal, JournalRule, JournalTriggerLog } from '../../shared/journal.ts'

export type AvatarShape = 'blob' | 'whale' | 'cat' | 'orbit' | 'leaf' | 'spark' | 'ring'

export interface Avatar {
  shape: AvatarShape
  color: string
  /** 可选第二色，用于 blob 高光 / 渐变 */
  tint?: string
  /**
   * 本地导入的图片（data URL，压到 160×160 的 JPEG，约 10–20KB）。
   *
   * 有值时优先渲染图片；形状与颜色留着当回退——用户移除图片后立刻回到原来
   * 那个 SVG 头像，不用重新挑一遍。存进 localStorage，跟 Bot 数据一起持久化。
   */
  image?: string
}

export interface BotModel {
  provider: string
  model: string
  /**
   * 推理强度档位（模型公布的可选 id，如 `high` / `max`）。
   * 缺省或空串 = 不下发 `reasoningEffort`，跟随模型自己的默认档。
   * 可选值来自宿主 `/api/personal-agent/models` 返回的 `reasoningEfforts`。
   */
  effort?: string
}

export type BotStatus = 'online' | 'busy' | 'idle'

/**
 * Bot 的工具权限档位（决定它跑命令 / 写文件时被怎么对待）。
 *
 * - `full`     完全权限：沙箱 `danger-full-access` + 审批 `never`，不打断
 * - `approval` 审批模式：沙箱 `workspace-write` + 审批 `ask`，危险动作先问
 *
 * 落到宿主是 Session 上的 `sandbox/mode` 与 `approval/policy` 两条事件，因此
 * 每个 bot 的档位互相隔离，重启后仍然保持（见 host/personal/agent.ts）。
 */
export type BotPermission = 'full' | 'approval'

export interface ProactiveConfig {
  enabled: boolean
  /** daily | hourly | manual */
  freq: string
  from: string
  to: string
  lastAt?: number
}

/**
 * 上下文接力（自动提示整理并开新会话）设置。
 *
 * mode:
 *  · off    完全关闭，不探测上下文占用；
 *  · prompt 仅提示（默认）：命中阈值时在输入框上方出一条提示，由用户点「去整理」；
 *  · auto   自动提示——目前与 prompt 行为一致，只提示，不会自动清空会话。
 * softRatio / hardRatio 是 0–1 的占用比例，idleHours 是空闲小时数。
 */
export interface RelayAuto {
  mode: 'off' | 'prompt' | 'auto'
  softRatio: number
  hardRatio: number
  idleHours: number
}

export interface Bot {
  id: string
  name: string
  role: string
  description: string
  instructions: string
  avatar: Avatar
  groupId: string
  isMain: boolean
  status: BotStatus
  unread: number
  pinned: boolean
  enabled: boolean
  model: BotModel
  skills: string[]
  /**
   * 这个 Bot 通话时用的音色（StepFun realtime 的 voice id）。
   *
   * **留空 / 缺省 = 跟随全局默认**：通话 `start` 帧不带 `voice` 时，宿主用设置里的
   * `personal-realtime.voice`，再兜底 `REALTIME_DEFAULT_VOICE`。旧数据没有这个字段，
   * 读出来就是 `undefined`，按「跟随全局默认」处理即可，不需要迁移。
   */
  voice?: string
  /**
   * 这个 Bot 通话时用哪个 Live（全双工语音）供应商（`RealtimeVendorRecord.id`）。
   *
   * **留空 / 缺省 = 跟随全局默认**：通话 `start` 帧不带 `vendor` 时，宿主用设置里的
   * `defaultVendor`，再兜底供应商列表的第一条。与 `voice` 同一套约定——旧数据读出来
   * 是 `undefined`，按「跟随全局默认」处理即可，不需要迁移。
   */
  liveVendor?: string
  /**
   * 自动朗读回复：新回复到达后自动用「通话里设置的音色与供应商」念出来。
   *
   * **默认关**（旧数据没有这个字段 = 不朗读）：朗读会占用扬声器、在安静场合
   * 很打扰，属于「用户明确打开才生效」的增强。只影响**文字回复**的朗读，
   * 不影响语音通话本身——通话那条链路本来就在播语音。
   */
  autoSpeak?: boolean
  /** 工具权限档位；旧数据没有这个字段时按 `full` 处理。 */
  permission?: BotPermission
  /**
   * 上下文接力自动提示设置；旧数据没有这个字段 = 走默认值（仅提示）。
   *
   * 只影响「要不要在输入框上方提示整理」，不会自动清空任何会话。
   */
  relayAuto?: RelayAuto
  proactive: ProactiveConfig
  createdAt: number
  createdBy: string | null
  lastMessage?: string
  lastAt?: number
}

export interface BotGroup {
  id: string
  name: string
  order: number
}

export interface Room {
  id: string
  name: string
  memberIds: string[]
  unread: number
  /**
   * 置顶：侧栏「群聊」区块里排到最前（旧数据没有这个字段 = 不置顶）。
   *
   * 与 Bot.pinned 同一套语义：只影响侧栏排序，不动 createdAt 之类的原始顺序，
   * 取消置顶后就回到原来的位置。
   */
  pinned?: boolean
  /**
   * 群聊自己的头像（与 Bot.avatar 同一套结构）。
   *
   * 缺省 = 用成员头像叠加（旧行为）；用户选了头像后侧栏 / 会话头 / 轨道都改用它。
   */
  avatar?: Avatar
  lastMessage?: string
  lastAt?: number
  modelMode: 'inherit' | 'unified'
  unifiedModel?: BotModel
  createdAt: number
}

export type MessageRole = 'user' | 'bot' | 'system'
export type MessageSource = 'chat' | 'call' | 'routine' | 'proactive' | 'system' | 'control' | 'compaction'

export interface UiOption {
  id: string
  label: string
  description?: string
}

export interface UiField {
  id: string
  label: string
  type: 'text' | 'select' | 'time' | 'textarea' | 'checkbox'
  placeholder?: string
  options?: string[]
  required?: boolean
}

export type InteractiveUi =
  | { kind: 'options'; title?: string; options: UiOption[]; multi?: boolean; allowCustom?: boolean }
  | { kind: 'buttons'; title?: string; options: UiOption[] }
  | { kind: 'form'; title: string; submitLabel?: string; fields: UiField[] }

export interface TaskStep {
  text: string
  done: boolean
}

export interface CallTurn {
  id: string
  role: 'user' | 'bot'
  text: string
  at: number
  /**
   * 落库序号（通话内单调递增）。
   *
   * 为什么需要它：服务端 ASR 转写是异步的，`user_transcript` 常常晚于 Bot 的转写
   * 到达；用户轮次的序号在 `speech_stopped` 时就分配好，渲染前按它排序才能还原
   * 「用户问 → Bot 答」的真实顺序。旧记录没有这个字段（按 0 处理，稳定排序保原序）。
   */
  seq?: number
}

/**
 * 实时通话的业务阶段。
 *
 * 与旧版 `idle | ringing | active | ended` 的关系：
 *  · `ringing` 保留 = 正在接通（WS 建连 + 等宿主 ready）；
 *  · `listening / thinking / speaking` 取代原来的单一 `active` —— 全双工链路里
 *    「在听 / 在想 / 在说」是三种完全不同的状态，界面上要能一眼分辨；
 *  · `ended` 只在落通话记录的瞬间用一下，随后立刻回 `idle`。
 *
 * 判定「有没有通话在进行」仍然只认 `status !== 'idle'`，所以 ChatPanel /
 * RightPanel 里那些旧判断不用改。
 */
export type CallStatus = 'idle' | 'ringing' | 'listening' | 'thinking' | 'speaking' | 'ended'

/** 实时链路的连接状态（比业务阶段更底层：重连时业务阶段可能还是 listening）。 */
export interface RealtimeCallState {
  /** connecting = 正在建连；open = 已就绪；reconnecting = 断线重连中；closed = 已关闭。 */
  phase: 'connecting' | 'open' | 'reconnecting' | 'closed'
  /** 宿主确认的模型名（ready 之前为空串）。 */
  model: string
  /** 当前音色（ready 之前是本地默认值）。 */
  voice: string
  /** 下行/上行采样率（ready 帧给，缺省不显示）。 */
  sampleRate?: number
  /** 距会话到期剩余毫秒（宿主 expiring 帧之后才有）。 */
  expiresInMs?: number
  /** 最近一次可读错误（已经过宿主翻译）。 */
  error?: string
  /** 麦克风是否已就绪。undefined = 还在打开（权限弹窗 / 设备初始化）。 */
  micReady?: boolean
  /** 麦克风不可用的原因；有值时提示用户「可以打字」。 */
  micError?: string
  /**
   * 语音里「让 Bot 干活」的当前任务（宿主 task_started / task_progress / task_done）。
   *
   * 只留**最近一条**：模型连续发起多个任务时，新任务直接覆盖旧任务的展示位
   * （旧任务的迟到事件按 callId 丢弃，见 store 的 onTaskProgress / onTaskDone）。
   *
   * 它纯粹是展示态：任务执行期间用户仍然可以说话、打字、打断，界面不得因为
   * 这个字段去禁用麦克风或输入框（全双工是这条链路的硬约定）。
   */
  task?: CallTaskState
}

/**
 * 一次「让 Bot 干活」的任务状态。
 *
 * 三个宿主事件各对应一种 phase：
 *  · `task_started`  → phase=running（agent 已在后台跑）；
 *  · `task_progress` → 仍在 running，只更新 note；
 *  · `task_done`     → phase=done / failed，note 变成一句话结论或错误原因。
 *
 * 任务结束后状态**不会立刻消失**：界面先停留几秒让用户读完结论，再淡出
 * （时长见 store 的 CALL_TASK_LINGER_MS / CALL_TASK_FAIL_LINGER_MS）。
 */
export interface CallTaskState {
  /** 宿主分配的任务 id（三个 task 事件靠它配对）。 */
  callId: string
  /** 任务摘要（`task_started.task` 原文，模型自己写的）。 */
  label: string
  /** running = 后台执行中；done = 成功；failed = 失败。 */
  phase: 'running' | 'done' | 'failed'
  /**
   * 一句话补充：
   *  · running 时是进度 note（可能没有）；
   *  · done 时是结论 summary；
   *  · failed 时是错误原因 error。
   */
  note?: string
  /** 任务开始时间戳。 */
  startedAt: number
  /** 结束时间戳（done / failed 才有）。 */
  endedAt?: number
  /**
   * 正在淡出（store 在移除前先置真，界面据此做透明度 / 高度过渡）。
   *
   * 为什么要分两步：直接从 DOM 里删掉一块正在显示的内容会「啪」一下消失，
   * 下面所有元素还会跟着跳一格。先淡出再移除，视觉上才收得干净。
   */
  fading?: boolean
}

/**
 * 通话弹层的完整 UI 状态。
 *
 * 抽成独立接口是为了让 store 与组件共用同一份定义，也方便测试直接构造。
 * `botDraft` / `thinkingDraft` 是**未定稿的流式内容**（每条 delta 都在变），
 * 与 `liveTurns` 里的定稿轮次分开存：定稿的才进通话记录。
 */
export interface PersonalCallUi {
  status: CallStatus
  botId: string | null
  startedAt: number
  muted: boolean
  speaker: boolean
  /**
   * 通话音量（0..1）：通话界面音量拖动条的值，控制 Bot 声音的播放增益。
   *
   * 只影响**下行**（听 Bot 说话），不改变上行麦克风——上行已经有浏览器的
   * autoGainControl，再叠一层增益会干扰服务端 VAD 与 ASR。
   * 跨通话记住：`startCall` 从 localStorage 读回上次的值（见 store 的 loadCallVolume）。
   */
  volume: number
  minimized: boolean
  liveTurns: CallTurn[]
  /** 等待模型回复时的「正在思考」状态（兼容旧字段，thinking 阶段置真）。 */
  thinking?: boolean
  realtime: RealtimeCallState
  /** Bot 正在说的字幕（bot_transcript_delta 累积；done 后落到 liveTurns）。 */
  botDraft: string
  /** Bot 这一轮的思考过程（thinking_delta 累积，可折叠展示）。 */
  thinkingDraft: string
}

/** 空闲通话状态。单一来源，避免 store 里多处手抄导致字段漂移。 */
export function createIdleCallUi(): PersonalCallUi {
  return {
    status: 'idle',
    botId: null,
    startedAt: 0,
    muted: false,
    speaker: true,
    volume: 1,
    minimized: false,
    liveTurns: [],
    thinking: false,
    /*
     * 这里刻意**不带 task**：新一通电话从「没有任务」开始，上一通残留的任务状态
     * 不能漏进来（否则挂断再拨会看到一条不存在的「正在执行」）。字段可选，
     * 缺省即无任务。
     */
    realtime: { phase: 'closed', model: '', voice: '' },
    botDraft: '',
    thinkingDraft: '',
  }
}

export interface CallInfo {
  id: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  turns: CallTurn[]
}

/**
 * 期刊（Journal）相关结构统一从**两端共享契约** re-export。
 *
 * 为什么收口到 `src/shared/journal.ts`：宿主按同一套结构生成并落盘期刊，前端只负责
 * 渲染与本地回退。两边各写一份类型迟早漂移，表现成「宿主返回的字段前端不认识」。
 * 组件从这里 import 即可，不必各自去够 shared 目录。
 */
export type {
  JournalFeed,
  JournalFeedMessage,
  JournalFeedStats,
  JournalHighlight,
  JournalRecord as Journal,
  JournalRule,
  JournalSection,
  JournalStat,
  JournalStatus,
  JournalTriggerLog,
} from '../../shared/journal.ts'

export type ToolRunStatus = 'running' | 'ok' | 'error'

/**
 * 工具产出的可预览文件类型（按扩展名归族，决定卡片图标与预览方式）。
 *
 * `page` 是 `.html` / `.htm`（3.1 Pages）：渲染成「页面卡」并给「打开页面」入口，
 * 与 Bot 产出物工作台的 `BotOutputKind.page` 对齐。
 */
export type ArtifactKind = 'video' | 'audio' | 'pdf' | 'doc' | 'sheet' | 'slide' | 'image' | 'page' | 'file'

/**
 * 一个可预览的产出物（bot 工作区里的真实文件）。
 *
 * host 在 `tool/result`、`present` 参数与正文路径里识别出来，前端渲染成卡片：
 *  · 视频（mp4/webm/mov/m4v）→ `<video controls>`（走 `/file`，支持 Range）；
 *  · PDF → 内嵌 iframe（浏览器自带查看器）；
 *  · Office（doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp）→ 页图缩略图 + PDF 预览；
 *  · 音频（mp3/wav/m4a/ogg）→ `<audio controls>`；
 *  · 其它 → 打开 / 下载。
 */
export interface ArtifactRef {
  /** 相对 bot 工作区的路径（正斜杠；绝对路径原样）。 */
  path: string
  /** 同源 URL：`/api/personal-agent/file?path=...`。 */
  url: string
  /** 文件名（含扩展名）。 */
  name: string
  /** 展示类型。 */
  kind: ArtifactKind
  /** 字节数（host 能 stat 时给）。 */
  size?: number
}

/**
 * 一次工具调用的可展示快照（bot 真跑工具时才有）。
 *
 * `id` 与宿主 `tool/call` 事件的 callId 对应，前端按 id 就地更新同一张卡片：
 * 先 `running`，结果到达后变 `ok` / `error` 并补上 `result` 与耗时。
 *
 * ## 生图 / 生视频 / 产出物字段
 *
 * 宿主在 `tool/result` 时就把结果里的媒体解析出来、落盘到 bot 工作区，并把
 * 可直接 `<img src>` / `<video src>` 的同源 URL 放进对应字段。这样前端不必
 * 拿到 2~3MB 的 base64 JSON，也不会因为 `result` 被截断而丢图/丢视频：
 *
 *  · `images`     —— host 已落盘的图片 URL 列表（缺省 = 还没出图）；
 *  · `imageCount` —— 本次请求要生成几张（1–4，点阵占位按它画几个格子）；
 *  · `imageRatio` —— 本次请求的宽高比（宽 / 高，点阵按它排版）；
 *  · `videos`     —— host 已落盘的视频 URL 列表（生视频用）；
 *  · `videoTask`  —— 网关返回异步任务时的 id / 状态（此时没有可播放文件）；
 *  · `artifacts`  —— 工具产出的可预览文件（present / pwsh / run_code 落盘产物）；
 *  · `prompt`     —— 完整提示词（实时卡副标题用，未截断）；
 *  · `model`      —— 生图/生视频模型名（结果解析后才有）。
 *
 * 媒体 URL 的形状由 host 路由 `GET /api/personal-agent/file?path=<相对路径>`
 * 提供：相对路径以 bot 工作区（`D:\Seeker-Bot`）为基准，绝对路径必须在
 * 允许根内；图片/视频/音频/文档扩展名各有白名单，视频支持 Range。
 */
export interface ToolRun {
  id: string
  /** 工具名，例如 pwsh / read / web_search */
  name: string
  /** 参数摘要（已截断，用于卡片标题行） */
  args?: string
  status: ToolRunStatus
  /** 结果摘要（已截断） */
  result?: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  /** 生图专用：host 已落盘图片的同源 URL 列表。 */
  images?: string[]
  /** 生图专用：本次请求的张数（1–4，缺省 1）。 */
  imageCount?: number
  /** 生图专用：本次请求的宽高比（宽 / 高，缺省 1）。 */
  imageRatio?: number
  /** 生视频专用：host 已落盘视频的同源 URL 列表。 */
  videos?: string[]
  /** 生视频专用：网关返回的是异步任务时，任务 id 与状态（没有可播放文件）。 */
  videoTask?: { id: string; status: string }
  /** 工具产出的可预览文件（present / pwsh / run_code 等落盘产物）。 */
  artifacts?: ArtifactRef[]
  /** 生图/生视频专用：完整提示词（实时卡副标题用，未截断）。 */
  prompt?: string
  /** 生图/生视频专用：模型名（如 sensenova/sensenova-u1.5-lite）。 */
  model?: string
  /**
   * host 猜「这一轮在生成文档」时打的标记（按工具名 + 参数关键词判定）。
   *
   * 文档生成没有专用工具（模型用 pwsh / run_code 跑脚本），前端只能靠这个标记
   * 在生成期间先挂一张点阵占位，否则用户要对着空白等半分钟。
   */
  docPending?: boolean
}

/* -------------------------------------------------------------------------- */
/* 产出物（右栏「产出物」卡：从 Bot 产出物文件夹扫描出来的真实文件）             */
/* -------------------------------------------------------------------------- */

/** 产出物类别（与 Work 右栏的 OutputKind 同构，去掉 model3d / installer）。 */
export type BotOutputKind =
  | 'image' | 'video' | 'audio' | 'pdf' | 'doc'
  | 'sheet' | 'slide' | 'page' | 'archive' | 'file'

/**
 * 一条产出物。
 *
 * 与 `ArtifactRef` 的区别：`ArtifactRef` 是「工具卡的附件」（可能是 `_tmp` 里
 * 的临时文件），这里的条目**全部来自该 Bot 的产出物文件夹**——用户能直接在
 * 磁盘上找到、也能按修改时间排序。两者共用 `/api/personal-agent/file` 打开。
 */
export interface BotOutputItem {
  /** 相对 bot 工作区的路径（正斜杠）。 */
  path: string
  /** 同源 URL：`/api/personal-agent/file?path=...`。 */
  url: string
  /** 文件名（含扩展名）。 */
  name: string
  /** 展示类型。 */
  kind: BotOutputKind
  /** 字节数（host stat 得到时给）。 */
  size?: number
  /** 文件修改时间（Unix ms）——右栏按它倒序。 */
  time: number
  /** 分类文件夹名（图片 / 视频 / 文档…）。 */
  category: string
}

/** 产出物接口响应（`GET /api/personal-agent/outputs`）。 */
export interface BotOutputsResponse {
  ok?: boolean
  error?: string
  botId?: string
  /** Bot 的产出物目录名（`产出物/<folder>`）。 */
  folder?: string
  /** 产出物根目录的绝对路径（设置卡里展示、可打开）。 */
  root?: string
  items?: BotOutputItem[]
}

/* -------------------------------------------------------------------------- */
/* Pages（3.1：可回访的持久页面）                                              */
/* -------------------------------------------------------------------------- */

/**
 * 一条 Pages。
 *
 * 与 `BotOutputItem` 的区别：产出物是「文件夹里有什么文件」，Pages 是「Bot 交付过
 * 哪些页面」——同一 slug 反复更新只保留一条（`updatedAt` 更新），前端据此判断
 * 消息里那张旧页面卡是否已经过期，并显示「已更新到下方」。
 *
 * 字段按 host 路由约定设计（`GET /api/personal-agent/pages`）；host 还没就绪时
 * 前端拿不到数据，右栏不渲染这张卡（静默降级，不报错）。
 */
export interface PageItem {
  /** 稳定 id（host 给；没有就用 slug 兜底）。 */
  id?: string
  /** 页面 slug：同一 slug 的更新覆盖旧版。 */
  slug: string
  /** 页面标题（列表与预览层标题用）。 */
  title: string
  /** 相对 bot 工作区的路径（用来和消息里的文件卡对上）。 */
  path?: string
  /** 同源 URL（点击预览 / 打开页面用）。 */
  url: string
  /** 最近更新时间（Unix ms）。 */
  updatedAt: number
  /** 创建时间（Unix ms）。 */
  createdAt?: number
  /** 首次生成它的消息 id（可选，前端可据此定位来源）。 */
  sourceMessageId?: string
}

/** Pages 接口响应（`GET /api/personal-agent/pages`）。 */
export interface PagesResponse {
  ok?: boolean
  error?: string
  items?: PageItem[]
}

/* -------------------------------------------------------------------------- */
/* 任务记录（每轮对话一条，Muse 式任务列表 + 详情卡）                          */
/* -------------------------------------------------------------------------- */

/**
 * 任务执行详情里的一步。
 *
 * 数据来源是这一轮的真实事件流：开始、每次工具调用（running → ok/error）、
 * 最终回复、收口。渲染成右侧时间线，用户点开任务详情就能回看「它到底做了
 * 什么」，而不必翻对话里的工具折叠。
 */
export interface TaskRecordStep {
  /** 事件发生时间（Unix ms）。 */
  at: number
  /**
   * 工具调用 id（只有 kind='tool' 才有）。
   *
   * 同一个工具可能在一轮里被调用多次（连续 read 三个文件），只按工具名匹配会
   * 把几条执行记录并成一条；用宿主的 callId 才能一一对应。
   */
  id?: string
  /** start = 开始处理；tool = 工具调用；text = 阶段文本；output = 产出物；end = 收口。 */
  kind: 'start' | 'tool' | 'text' | 'output' | 'end'
  /** 主文案（工具名 / 阶段名 / 产出文件名）。 */
  title: string
  /** 补充说明（参数摘要、结果摘要、错误原因）。 */
  detail?: string
  /** 工具步骤的执行状态。 */
  status?: 'running' | 'ok' | 'error'
}

/**
 * 任务概览里的一步（来自模型的 `task_state` 工作记忆，不是执行轨迹）。
 *
 * 用户口径（2026-11-02）：「每一次对话都要有详细的任务概览」——模型每轮会用
 * `task_state` 写一份「任务标题 + 步骤清单」，前端把它原样收进 TaskRecord，
 * 任务概览卡左栏优先展示这份清单；没有时回退到执行轨迹（steps）。
 */
export interface TaskOverviewStep {
  /** 步骤名（模型写的中文短句）。 */
  label: string
  /** 步骤状态（与 working-memory.ts 的 WorkingTaskStep 逐字对齐）。 */
  status: 'todo' | 'doing' | 'done'
}

/**
 * 一条任务记录。
 *
 * 每个用户回合（user 消息 → bot 回复完成）生成一条：主题自动描述用户意图，
 * 执行详情由这一轮的工具事件与最终回复汇总而来。任务记录是**前端会话状态**
 * （localStorage），与宿主 agent 会话相互独立；它回答的是「我和这个 Bot 做过
 * 哪些事」，不是「模型上下文里有什么」。
 */
export interface TaskRecord {
  id: string
  botId: string
  /** 群聊任务带 roomId（私聊省略）。 */
  roomId?: string
  /** 自动描述的任务主题（短句）。 */
  title: string
  /** 用户原始请求文本（纯图片消息给「[图片]」）。 */
  prompt: string
  /**
   * 任务状态。
   *
   * `stopped` 是**用户主动点停止**（与 `failed` 分开）：停止是正常操作，
   * 不该显示成「失败」红色，也不该让用户以为出了错。宿主侧对应
   * `POST /api/personal-agent/stop`（cancelBotTurn），前端同时中止流式读取。
   */
  status: 'running' | 'done' | 'stopped' | 'failed'
  startedAt: number
  endedAt?: number
  durationMs?: number
  /** 执行详情时间线。 */
  steps: TaskRecordStep[]
  /**
   * 任务概览：模型通过 `task_state` 写下的步骤清单（todo / doing / done）。
   *
   * **任务详情卡已不再展示它**（2026-11-02 改为 Work 式过程时间线，读 `steps`）：
   * 这个字段保留是为了兼容旧数据与宿主工作记忆的展示口径，UI 不再引用。
   * `steps` 才是任务详情卡的数据源（工具调用、过程说明、产出物、收尾）。
   */
  overview?: TaskOverviewStep[]
  /** 这一轮的产出物数量。 */
  outputCount?: number
  /** bot 最终回复的纯文本摘要。 */
  reply?: string
  /** 失败原因。 */
  error?: string
}

/**
 * 用户发来的一张图片。
 *
 * `url` 是同源地址（`/api/personal-agent/file?path=uploads/…`），消息里直接
 * `<img src>`；`path` 是相对 bot 工作区的路径，随 `/reply` 一起带给宿主，
 * 由宿主写进 user 消息提示模型去 `read_image`——所以两个字段缺一不可。
 */
export interface ChatImage {
  url: string
  path: string
  name?: string
}

/**
 * 助手主动推荐的一个「可连接的应用」。
 *
 * 字段与宿主连接器目录（assets/mcp-catalog/catalog.json）对齐但**只取展示所需**：
 * 对话流里的推荐卡不负责安装，装不装、怎么授权都在连接器市场里做，所以这里不带
 * install / authorize 这些重字段——目录更新时前端也不会因为字段变多而失效。
 *
 * `icon` 是 catalog 的 `iconFile` 文件名（如 gmail.png），不是完整 URL：图标由宿主
 * 路由 `/api/chat-flow/mcp-icons/<文件名>` 统一提供，客户端拼路径，宿主换存储位置
 * 时前端不用跟着改。
 */
export interface ConnectorItem {
  /** catalog id（gmail / notion / feishu …），点击后据此在市场上定位。 */
  id: string
  /** 展示名。 */
  name: string
  /** 一句话说明（catalog 的 tagline）。 */
  description?: string
  /** catalog 的 iconFile 文件名（如 gmail.png）；缺省时用名称首字母占位。 */
  icon?: string
  /** 已经连上了：卡片上标「已连接」并降透明度，但仍可点开去管理。 */
  installed?: boolean
}

export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; image: ChatImage }
  | { type: 'tool'; run: ToolRun }
  /**
   * 执行态块：bot 在电脑 / 浏览器里操作时，对话流里那张「正在做什么」的卡片。
   *
   * 与 `tool` 块的区别：`tool` 是工具调用卡（默认折叠、面向审计），
   * `execution` 是**面向观看**的执行态（当前动作 + 状态 + 可展开步骤 + 可选画面），
   * 对应 gorkbot 里那张 Computer 气泡。工具块不跨消息的约束同样适用。
   */
  | {
      type: 'execution'
      /** 执行状态：跑 / 成 / 败。 */
      status: 'running' | 'ok' | 'error'
      /** 中文动作描述（「在浏览器里打开 Salesforce」）。 */
      label: string
      /** 来源工具名（computer / browser 等），用于图标与归类。 */
      tool?: string
      /** 步骤流水（点开才看）。 */
      steps?: Array<{ at: number; label: string; status: 'running' | 'ok' | 'error' }>
      /** 截图 / 录像的同源 URL（可选）。 */
      media?: string
      /** 失败原因。 */
      error?: string
    }
  | { type: 'task'; title: string; status: string; detail?: string; steps: TaskStep[] }
  | {
      type: 'interactive'
      prompt?: string
      ui: InteractiveUi
      submitted?: boolean
      result?: string
      resultAt?: number
    }
  | { type: 'call'; call: CallInfo }
  /**
   * 一段语音通话的**折叠标记**。
   *
   * 语音通话不再包成一张「通话卡」：转写以**普通消息**实时进对话流（和打字聊天同一个
   * 气泡样式），这段标记消息放在这段之前，负责「收起 / 展开」这一整段。
   *
   * 为什么这么改：用户要的是「对话还是之前的 UI 形式，收起只是把这一段收起」——
   * 原来的通话卡是另一种样式，展开后看起来跟聊天记录不是一回事。
   */
  | {
    type: 'call-segment'
    /** 段 id：同段内的转写消息共享它（`Message.callSegment`），折叠时一起隐藏。 */
    segment: string
    startedAt: number
    endedAt?: number
    durationMs?: number
    engine?: 'realtime'
    model?: string
    voice?: string
    /** 段内轮次数（折叠条上显示「12 条」）。 */
    turns: number
    /** 还在通话中：折叠条显示「通话中」而不是时长。 */
    live?: boolean
  }
  | { type: 'journal'; journalId: string; title: string; date: string; image?: string; summary: string }
  | { type: 'voice'; durationMs: number; transcript: string }
  /**
   * 上下文压缩标记（1.1）。
   *
   * 宿主 compaction 发生时推一条 `{ type: 'compaction', at, summary? }`，前端落成
   * 一条 `role: 'system'`、`source: 'compaction'` 的消息。它**不是卡片**：对话流里
   * 只是一行居中小字，点开才看摘要。用户不知道历史什么时候被压缩，Bot 的连续性
   * 却依赖压缩策略——这个标记就是让「它忘掉了什么」变得可见。
   */
  | {
    type: 'compaction'
    /** 压缩发生时间（Unix ms）。 */
    at: number
    /** 折叠了多少条消息（host 能算出来时给；没有就不显示数字）。 */
    folded?: number
    /** 人工可读摘要（host 生成时给；没有则不可展开）。 */
    summary?: string
  }
  /**
   * 助手主动推荐「连接你的应用」：标题 + 一句说明 + 若干应用行。
   *
   * 为什么单独做成一个块而不是复用 `interactive`：推荐卡**不需要用户作答**，
   * 点一下就跳去连接器市场；套进交互卡会带上「已提交」语义，等于强迫用户在
   * 对话里做一次选择。它更像一段带图标的正文，只是可点。
   *
   * `picked` 是「上次点过哪条」的持久化提示（消息落库时由宿主带上，可缺省）；
   * 本轮点击的标记只活在组件本地 state 里，不回写 store —— 用户点完已经跳到
   * 连接器市场，对话流里只需当场给个「已打开」的反馈，不必为一条消息写盘。
   */
  | {
      type: 'connectors'
      /** 区块标题，如「连接你的应用」。 */
      title?: string
      /** 标题下的一句说明（可选）。 */
      prompt?: string
      items: ConnectorItem[]
      /** 用户点过哪一条（点击后置真，渲染成「已打开」态）。 */
      picked?: string
    }

/**
 * 一条 bot 消息的类别（与 host `BotMessage.kind` 对齐）。
 *
 * 它决定外观而不只是标签：`need-input` / `approval` 是需要用户动作的卡片，
 * `finding` 是需要注意的高亮，`progress` / `final` 是普通对话气泡。
 *
 * `connector-suggest` 是「连接你的应用」推荐卡专用的一档：那张卡本身就是正文
 * （`.pa-con` 自带背景与圆角），外层再套气泡就是卡片套卡片；但它也**不该**沿用
 * `finding` 的橙色左边线与「发现」角标——推荐应用不是告警，静一点才对。
 */
export type BotMessageKind = 'progress' | 'finding' | 'need-input' | 'approval' | 'connector-suggest' | 'final'

export interface Message {
  id: string
  botId: string
  roomId?: string
  role: MessageRole
  /** 群聊里标识发送者 */
  senderId?: string
  senderName?: string
  at: number
  blocks: MessageBlock[]
  source?: MessageSource
  /** 正在生成中的占位（前端展示 typing） */
  pending?: boolean
  /** 多消息类别（缺省 = 普通对话气泡）。 */
  kind?: BotMessageKind
  /**
   * 所属轮次 id（host 下发）。
   *
   * 同一次用户回合里产生的所有 bot 消息共享它；前端按它把多条消息归成
   * 一个轮次容器（进度 / 结算 / 折叠）。老数据没有这个字段，按单条渲染。
   */
  turnId?: string
  /**
   * 引用回复：这条消息是在回复哪一条。
   *
   * 多条消息的流里，用户想针对第 3 条回复时，只靠上下文猜会指代漂移；
   * 记下被引用消息的 id 与一小段摘要，界面上渲染成引用条。
   */
  replyTo?: { id: string; preview: string }
  /**
   * 合并后的 progress 消息里，各条 host 消息各自贡献的 blocks。
   *
   * 为什么需要这张分段表：连续 progress 合并成一条气泡后，`blocks` 是几段拼起来
   * 的扁平数组；而 host 的 `message-update` 只更新其中**一条** host 消息。没有分段
   * 信息，一次更新就会把整条消息覆盖成单段，前面几条进度的内容凭空消失。
   *
   * 只在流式期间有意义（刷新后不再有 message-update），所以持久化前会被剥掉，
   * 见 store 的保存 effect——否则同样的 blocks 在 localStorage 里存两份。
   */
  mergedSegments?: Record<string, MessageBlock[]>
  /**
   * host 侧这条消息的原始 id。
   *
   * 前端自己的 `id` 是 `shortId('msg')` 生成的，与 host 无关。但「审批卡 / 问答卡」
   * 必须凭 host id 才能回传（`apmsg-<approvalId>` / `qmsg-<questionId>`），
   * 所以原始 id 要随消息一起存下来——否则点击时判断不出该回传给谁。
   */
  hostId?: string
  /**
   * 所属语音通话段 id（见 `MessageBlock` 的 `call-segment`）。
   *
   * 同一通电话的转写消息与产物消息共享它：折叠该段时这些消息一起隐藏，展开时恢复
   * 普通气泡渲染——它们本身就是普通消息，只是被标记了归属。
   */
  callSegment?: string
}

export interface MemoryEntry {
  id: string
  botId: string
  text: string
  tags: string[]
  createdAt: number
  pinned?: boolean
  source?: string
}

export type RoutineSchedule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: number[] }
  | { kind: 'once'; at: number }

export interface RoutineRun {
  at: number
  status: 'ok' | 'failed' | 'running'
  note?: string
}

export interface Routine {
  id: string
  botId: string
  name: string
  instruction: string
  schedule: RoutineSchedule
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  nextAt?: number
  runs: RoutineRun[]
}

export interface CallRecord extends CallInfo {
  botId: string
  roomId?: string
  status: 'ringing' | 'active' | 'ended'
  /** 旧半双工链路的 TTS 文本；历史记录兼容用，新记录不再写。 */
  ttsText?: string
  /**
   * 链路来源。
   *
   * 缺省 = 旧半双工记录（点按录音 → ASR → 模型 → Edge TTS），历史通话卡照旧渲染；
   * `realtime` = 全双工实时通话。加了它历史数据不用迁移，新记录也能显示「实时双工」标签。
   */
  engine?: 'realtime'
  /** 通话用的模型 / 音色（新记录才有，历史卡副标题用）。 */
  model?: string
  voice?: string
}

export interface PersonalSettings {
  /** auto = 跟随 DSH / 系统主题；dark/light = 用户手动覆盖。 */
  theme: 'auto' | 'dark' | 'light'
  showRightPanel: boolean
  /**
   * 期刊触发规则。
   *
   * 类型来自 `src/shared/journal.ts`（`JournalRule`），宿主调度器读的是同一份结构；
   * 旧 localStorage 里可能是缺字段 / 越界的对象，`normalizeState` 会用
   * `normalizeJournalRule` 洗成合法值，所以这里不需要再声明兼容字段。
   */
  journalRule: JournalRule
}

export interface PersonalUi {
  selectedBotId: string
  selectedRoomId: string | null
  view: 'chat' | 'journal'
  /**
   * 左侧栏是否收起（折叠成 64px 图标轨道）。
   *
   * 与 Work 模式的官方侧栏折叠是同一套语义：顶部品牌行右侧那枚面板按钮切换，
   * 状态跟着用户走（存进 `pa:ui:v1`），刷新 / 重开页面保持。折叠只改布局宽度，
   * 不改变当前选中的 Bot / 群聊，所以不需要在折叠时动 `selectedBotId`。
   */
  sidebarCollapsed: boolean
  /**
   * 收起的分区 id 列表（侧栏手风琴）：Bot 分组用 group.id，群聊区块用 'rooms'。
   *
   * 为什么放 ui 而不是 BotGroup 上：折叠是「这一次想不想看」，不是 Bot 数据；
   * 而且群聊区块没有 group 实体，放同一份列表里两处才能共用一套交互。
   * 存进 `pa:ui:v1`，刷新 / 重开页面保持。
   */
  collapsedSections: string[]
  /**
   * 各会话的「已读时刻」：key 为 `bot:<id>` / `room:<id>`，值是切进该会话的时间。
   *
   * 侧栏用它判断「有没有新回复」——比维护 unread 计数稳：流式回复是多条消息、
   * 还可能先来一条 pending 占位，按条累加既会漏（占位不计）也会虚高（一轮多条）。
   * 用「消息 at > 已读时刻」判定，流式过程中就能亮起来，切进会话即清零。
   */
  readAt: Record<string, number>
  rightPanelOpen: boolean
  /**
   * 右栏宽度（px）。用户拖拽右栏左边缘调整，松手后写进 `pa:ui:v1`。
   *
   * 为什么放 ui：这是「这一次用起来顺手」的视图偏好，与 Bot 数据无关；
   * 刷新 / 重开页面都要保持（用户口径：「允许拖拽并且记忆位置」）。
   * 窄屏（≤1200px）由 CSS 媒体查询固定宽度，这里的值只在宽屏生效。
   */
  rightPanelWidth: number
  /**
   * 对话主列宽度（px）；0 = 自动铺满（默认）。
   *
   * 用户从对话流两侧拖拽调整：只改中间对话区宽度，左右侧栏宽度不变。
   * 拖拽过程直接改 `--pa-chat-w`，松手后写进 `pa:ui:v1`。
   */
  chatWidth: number
  /**
   * 旧右栏 tab（详情/资料库/电脑）。
   *
   * v3 起右栏只剩浏览器 + 产出物 + 任务记录，不再使用 tab；字段保留只为兼容
   * localStorage 里已经存过的 `pa:ui:v1`，读写都按可选值处理。
   */
  rightTab: 'detail' | 'library' | 'computer'
  /** 当前打开的 Bot 设置卡（null = 关闭）。 */
  botSettingsOpen: string | null
  /** 当前打开的任务详情卡（TaskRecord.id；null = 关闭）。 */
  taskDetailId: string | null
  newBotOpen: boolean
  groupSettingsOpen: string | null
  journalOpenId: string | null
  call: PersonalCallUi
  search: string
  toast: string | null
  /**
   * 已收起的语音通话段 id。
   *
   * 收起只影响「段内那些消息渲不渲染」，不改它们的样式：展开后还是普通聊天气泡。
   * 放 ui 而不是 state：这是纯视图状态，不该进 localStorage 跟着会话一起存。
   */
  collapsedCallSegments: string[]
  /**
   * 正在引用回复的那条消息（null = 没有引用）。
   *
   * 同样放 ui 而不是 state：它只是「输入框当前带着一条引用」的临时状态，发出去就
   * 清掉，刷新后也不该恢复（恢复出一条指向旧消息的引用反而更困惑）。
   */
  replyTo: { id: string; preview: string } | null
}

export interface AppState {
  version: 2
  bots: Bot[]
  groups: BotGroup[]
  rooms: Room[]
  messages: Message[]
  memories: MemoryEntry[]
  routines: Routine[]
  calls: CallRecord[]
  journals: Journal[]
  journalLogs: JournalTriggerLog[]
  /**
   * 宿主期刊状态（规则面板显示「生成中 / 最近一次生成时间」）。
   *
   * 由启动时的 `GET /journal/status` 同步写入；字段可选——旧 localStorage 没有就
   * 当作「未知」，界面按 false / 不显示处理，不需要迁移脚本。这里只存展示需要的
   * 两项：完整触发日志在 `journalLogs`，规则在 `settings.journalRule`。
   */
  journalStatus?: {
    generating: boolean
    lastGeneratedAt?: number
  }
  /** 每个用户回合一条的任务记录（v3 新增；旧状态缺省为空数组）。 */
  tasks: TaskRecord[]
  /**
   * 每个 Bot 的 Pages 列表（3.1）。
   *
   * 由右栏「页面」卡挂载时拉取、写回这里：消息里的旧页面卡（ArtifactCard）也要读
   * 它判断「这张卡是不是已经被更新过」。**只是运行时缓存，不落盘**——Pages 的权威
   * 源是宿主，每次打开右栏重新拉；持久化它既不会被 normalizeState 恢复，又白占
   * localStorage（见 store 的保存 effect）。host 没就绪时保持 undefined，
   * 读的地方一律兜底成空数组。
   */
  pagesByBot?: Record<string, PageItem[]>
  settings: PersonalSettings
  lastUserMessageAt: number
}

export interface NewBotInput {
  name?: string
  role?: string
  description?: string
  instructions?: string
  color?: string
  shape?: AvatarShape
  /** 完整头像（含本地图片）；给定时优先于 color / shape。 */
  avatar?: Avatar
  groupId?: string
  /** 通话音色；留空 = 跟随全局默认（见 `Bot.voice`）。 */
  voice?: string
  /** 通话用的 Live 供应商 id；留空 = 跟随全局默认（见 `Bot.liveVendor`）。 */
  liveVendor?: string
}

export const MAIN_BOT_ID = 'bot-main-xiaomo'
export const DEFAULT_GROUP_ID = 'group-assistants'
export const GROUP_ROOM_ID = 'room-weekly'

export const MODEL_FALLBACK: BotModel = {
  provider: 'alymagpie',
  model: 'auto/deepseek-v4.1-flash',
  effort: 'max',
}

/**
 * 毫秒 → **已经完整走过的整秒数**（向下取整）。
 *
 * 这是全应用唯一的「时长换秒」口径：`formatDuration`（mm:ss）与各处「N 秒」文案
 * 都必须走它，不要再各自 `Math.round(ms / 1000)`。
 *
 * 为什么是向下取整而不是四舍五入：计时器每秒刷新一次，16.5 秒时它显示 00:16
 * （已经走完 16 秒）；若挂断提示用四舍五入就变成「17 秒」，同一通电话在两处
 * 显示两个数——用户看到的就是「时间不一致」。iOS / 微信的通话时长同样是向下取整。
 */
export function formatDurationSeconds(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor(ms / 1000))
}

export function formatDuration(ms: number): string {
  const total = formatDurationSeconds(ms)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatClock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatDateLabel(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

export function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 把音色 id 翻成给人看的中文名。
 *
 * 界面上要显示「邻家姐姐」而不是 `linjiajiejie`；清单直接取共享协议常量
 * （`REALTIME_VOICES`），不另抄一份。未知 id（复刻音色 / 上游新增）原样返回，
 * 空值返回空串——调用方据此决定整行显不显示，避免出现「音色 」这种残句。
 */
export function voiceLabel(id: string | undefined): string {
  if (id === undefined || id === '') return ''
  const found = REALTIME_VOICES.find((item) => item.id === id)
  return found === undefined ? id : found.label
}

/* -------------------------------------------------------------------------- */
/* Live 供应商（Bot 设置里的「通话供应商」下拉）                                */
/* -------------------------------------------------------------------------- */

/** Bot 设置里「通话供应商」下拉的一项（结构上兼容 `PaSelectOption`）。 */
export interface LiveVendorOption {
  value: string
  label: string
  hint?: string
}

/**
 * `GET /api/personal-agent/realtime/config` 的响应（只声明本处用到的字段）。
 *
 * `config.vendors` 是用户在「设置 → 供应商 → 实时语音」里维护的那份独立列表；
 * 这里只读，增删改在设置页。
 */
export interface RealtimeVendorsResponse {
  ok?: boolean
  error?: string
  config?: {
    vendors?: RealtimeVendorRecord[]
    /** 全局默认供应商 id（Bot 没单独选时宿主用它）。 */
    defaultVendor?: string
  }
}

/** 取上游地址的主机名（下拉右侧小字用）；地址不合法就返回空串，不抛错。 */
function upstreamHost(upstream: string): string {
  try {
    return new URL(upstream).host
  } catch {
    return ''
  }
}

/**
 * 把宿主返回的 Live 供应商列表翻成下拉选项。
 *
 * 首项固定是「跟随全局默认」——空串表示「这个 Bot 不单独选」，与 `Bot.voice` 同一口径。
 * 两处兜底：
 *  · 全局默认供应商本身在列表里时，把它的名字挂进首项，用户不用去设置页翻；
 *  · Bot 选过的供应商已被删除（列表里没有这个 id）时补一项「已删除的供应商」，
 *    否则下拉会显示成空白，看起来像「从来没选过」。
 */
export function liveVendorOptions(
  vendors: readonly RealtimeVendorRecord[] | null,
  selectedId: string | undefined,
  defaultVendor?: string,
): LiveVendorOption[] {
  const list = vendors ?? []
  const byId = new Map(list.map((vendor) => [vendor.id, vendor]))
  const fallbackLabel = defaultVendor === undefined || defaultVendor === ''
    ? ''
    : (byId.get(defaultVendor)?.label ?? defaultVendor)
  const options: LiveVendorOption[] = [
    { value: '', label: fallbackLabel === '' ? '跟随全局默认' : `跟随全局默认（${fallbackLabel}）` },
  ]
  for (const vendor of list) {
    const model = vendor.model ?? ''
    const host = upstreamHost(vendor.upstream)
    options.push({
      value: vendor.id,
      label: vendor.label,
      ...(model !== '' ? { hint: model } : host !== '' ? { hint: host } : {}),
    })
  }
  if (selectedId !== undefined && selectedId !== '' && !byId.has(selectedId)) {
    // 列表没读到（null）时不能断言「被删了」，只能说「已选但列表读不到」
    options.push(vendors === null
      ? { value: selectedId, label: `已选：${selectedId}（列表读不到）` }
      : { value: selectedId, label: `已删除的供应商（${selectedId}）`, hint: '设置里已经没有这一条' })
  }
  return options
}

/**
 * 当前选中的 Live 供应商的短标签（详情栏右上角那行小字用）。
 *
 * 与 `liveVendorOptions` 分开：下拉里要带括号说明，这里只要一个能塞进一行的短语。
 */
export function liveVendorSummary(
  vendors: readonly RealtimeVendorRecord[] | null,
  selectedId: string | undefined,
  defaultVendor?: string,
): string {
  const list = vendors ?? []
  if (selectedId === undefined || selectedId === '') {
    if (defaultVendor === undefined || defaultVendor === '') return '跟随默认'
    const fallback = list.find((vendor) => vendor.id === defaultVendor)
    if (fallback !== undefined) return `跟随默认（${fallback.label}）`
    // 列表没读到时无法确认全局默认叫什么，不硬编 id 免得像是「已失效」
    return vendors === null ? '跟随默认' : `跟随默认（${defaultVendor}）`
  }
  const hit = list.find((vendor) => vendor.id === selectedId)
  if (hit !== undefined) return hit.label
  return vendors === null ? `已选：${selectedId}` : `已删除（${selectedId}）`
}
