/**
 * Personal Agent — 共享类型（前端 + 独立演示页）。
 *
 * 所有展示型数据结构都收敛在这里：Bot / 分组 / 群聊 / 消息块 / 记忆 / 例行任务 /
 * 通话 / 期刊。store 与各组件只依赖本文件，不各自发明字段。
 */

export type AvatarShape = 'blob' | 'whale' | 'cat' | 'orbit' | 'leaf' | 'spark' | 'ring'

export interface Avatar {
  shape: AvatarShape
  color: string
  /** 可选第二色，用于 blob 高光 / 渐变 */
  tint?: string
}

export interface BotModel {
  provider: string
  model: string
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
  /** 工具权限档位；旧数据没有这个字段时按 `full` 处理。 */
  permission?: BotPermission
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
  collapsed?: boolean
}

export interface Room {
  id: string
  name: string
  memberIds: string[]
  unread: number
  lastMessage?: string
  lastAt?: number
  modelMode: 'inherit' | 'unified'
  unifiedModel?: BotModel
  createdAt: number
}

export type MessageRole = 'user' | 'bot' | 'system'
export type MessageSource = 'chat' | 'call' | 'routine' | 'proactive' | 'system' | 'control'

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
}

export interface CallInfo {
  id: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  turns: CallTurn[]
}

export interface JournalSection {
  heading: string
  text: string
}

export type ToolRunStatus = 'running' | 'ok' | 'error'

/** 工具产出的可预览文件类型（按扩展名归族，决定卡片图标与预览方式）。 */
export type ArtifactKind = 'video' | 'audio' | 'pdf' | 'doc' | 'sheet' | 'slide' | 'image' | 'file'

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

export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; image: ChatImage }
  | { type: 'tool'; run: ToolRun }
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
  | { type: 'journal'; journalId: string; title: string; date: string; image?: string; summary: string }
  | { type: 'voice'; durationMs: number; transcript: string }

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
  ttsText?: string
}

export interface Journal {
  id: string
  botId: string
  title: string
  subtitle?: string
  date: string
  dateLabel: string
  issue: string
  summary: string
  sections: JournalSection[]
  quote?: string
  mood?: string
  weather?: string
  image?: string
  imagePrompt?: string
  generatedAt: number
  auto?: boolean
}

export interface JournalTriggerLog {
  at: number
  ok: boolean
  reason: string
  journalId?: string
}

export interface PersonalSettings {
  /** auto = 跟随 DSH / 系统主题；dark/light = 用户手动覆盖。 */
  theme: 'auto' | 'dark' | 'light'
  showRightPanel: boolean
  journalRule: { enabled: boolean; startHour: number; endHour: number; idleMinutes: number }
}

export interface PersonalUi {
  selectedBotId: string
  selectedRoomId: string | null
  view: 'chat' | 'journal'
  rightPanelOpen: boolean
  rightTab: 'detail' | 'library' | 'computer'
  newBotOpen: boolean
  groupSettingsOpen: string | null
  journalOpenId: string | null
  call: {
    status: 'idle' | 'ringing' | 'active' | 'ended'
    botId: string | null
    startedAt: number
    muted: boolean
    speaker: boolean
    minimized: boolean
    liveTurns: CallTurn[]
    /** 等待模型回复时的「正在思考」状态。 */
    thinking?: boolean
  }
  search: string
  toast: string | null
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
  groupId?: string
}

export const MAIN_BOT_ID = 'bot-main-xiaomo'
export const DEFAULT_GROUP_ID = 'group-assistants'
export const GROUP_ROOM_ID = 'room-weekly'

export const MODEL_FALLBACK: BotModel = {
  provider: 'alymagpie',
  model: 'auto/deepseek-v4.1-flash',
  effort: 'max',
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
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
