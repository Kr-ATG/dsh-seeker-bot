/**
 * Personal Agent — 全局状态与动作（前端）。
 *
 * 设计原则：
 *  - 单一 AppState + 派生选择器；所有写操作集中在这里，组件只读 state / 调 actions。
 *  - 持久化到 localStorage（pa:state:v1）；首次运行注入 seed。
 *  - 消息回复默认走本地引擎；若 host `/api/personal-agent/reply` 可用，则用真实模型结果替换。
 *  - 定时器（例行任务 / 日记触发）挂在 Provider 上，页面开着就会真实跑。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  buildJournal,
  BOT_COLORS,
  firstBotMessage,
  followUpForAnswer,
  generateReply,
  journalCoverSvg,
  journalFeedForSync,
  journalFeedFromState,
  memoryFromText,
  NEW_BOT_SUGGESTIONS,
  nextRoutineAt,
  proactiveMessage,
  randomBotAppearance,
} from './engine.ts'
import { buildQuoteRef, historyTextOf } from './model-text.ts'
import { resolveRoomTrigger } from './room-trigger.ts'
import { parseMentions, type MentionTarget } from './chat/mentions.ts'
import { shouldStartNext } from './room-queue.ts'
import { normalizeRelayAuto } from './relay-trigger.ts'
import { BOT_ROSTER_EVENT } from '../triad/hub/memory-bot-source.tsx'
import {
  createInitialState,
  createMainBot,
  LEGACY_SEED_BOT_IDS,
  LEGACY_SEED_GROUP_IDS,
  LEGACY_SEED_JOURNAL_IDS,
  LEGACY_SEED_ROOM_IDS,
  LEGACY_SEED_ROUTINE_IDS,
} from './seed.ts'
import {
  DEFAULT_GROUP_ID,
  MAIN_BOT_ID,
  MODEL_FALLBACK,
  createIdleCallUi,
  formatDurationSeconds,
  shortId,
  type AppState,
  type ArchivedSession,
  type ArtifactRef,
  type AssignmentView,
  type Avatar,
  type Bot,
  type BotModel,
  type BotMessageKind,
  type CallRecord,
  type ChatImage,
  type InteractiveUi,
  type Journal,
  type Message,
  type MessageBlock,
  type NewBotInput,
  type PageItem,
  type PagesResponse,
  type PersonalCallUi,
  type PersonalUi,
  type ProactiveMarkKind,
  type QuoteRef,
  type RealtimeVendorsResponse,
  type Routine,
  type TaskOverviewStep,
  type TaskRecord,
  type TaskRecordStep,
  type ToolRun,
} from './types.ts'
import {
  journalDateKey,
  journalDateLabel,
  journalIssue,
  normalizeJournalRule,
  sanitizeJournalRecord,
  type JournalFeed,
  type JournalFeedStats,
  type JournalRule,
  type JournalStatus,
  type JournalTriggerLog,
} from '../../shared/journal.ts'
import {
  REALTIME_CONFIG_PATH,
  REALTIME_DEFAULT_VOICE,
  type RealtimeAgentSpec,
  type RealtimeArtifact,
  type RealtimeVendorRecord,
} from '../../shared/realtime-protocol.ts'
import {
  RELAY_MESSAGES_MAX,
  normalizeRelayBrief,
  type RelayBrief,
  type RelayMessage,
} from '../../shared/relay.ts'
import { RealtimeCall, type RealtimeCallHandlers } from './call/realtime-client.ts'
import { sortTurns, takePendingUserTurn, type PendingUserTurn } from './call/call-turns.ts'
import { relocateToEnd } from './chat/message-order.ts'

/**
 * 是不是独立演示页（`npm run build:personal-demo` 产出的单文件）。
 *
 * 这是**唯一允许走本地模板引擎**的条件：演示页没有宿主，本来就没有 agent 可接，
 * 用模板是为了让界面可体验。在 DSH 里运行时一律不降级——失败就报错。
 *
 * 为什么这么严：本地模板引擎会产出「看起来正常的回复」，一旦它在真实环境里兜底，
 * 「agent 挂了」就会表现成「Bot 正常回你，只是什么都不做」。实测踩过——一个空壳
 * 会话让每轮都静默降级，Bot 满口答应「我这就建」，却一个文件都产不出来，
 * 界面上没有任何报错。
 */
function isDemoMode(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'file:'
}

/**
 * 前端兜底错误文案：界面只显示中文。
 *
 * host 的 SSE error 事件已经是中文；这里覆盖的是「网络 / 降级链自身抛错」这类
 * 前端异常（fetch failed、timeout 等英文原文），避免聊天窗直接显示英文。
 */
function userFacingErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/[\u4e00-\u9fa5]/.test(text)) return text
  if (/(fetch|network|failed to fetch|timeout|econnrefused|enotfound)/i.test(text)) {
    return '网络请求失败，请稍后重试'
  }
  return '请求失败，请稍后重试'
}

/**
 * 流式字幕合并窗口（毫秒）。
 *
 * 全双工的转写增量是几十毫秒一条；每条都 setUi 会让整个 Bot 应用（含 200 条消息
 * 的列表）每帧重渲染一次，通话时明显掉帧。120ms 合并一次 ≈ 8fps，肉眼看是连续的，
 * 重渲染成本降到原来的 1/4。定稿（done）时立即 flush，不会出现「说完了字还差半句」。
 */
const CALL_DRAFT_FLUSH_MS = 120

/**
 * 语音任务结束后，状态条在界面上停留多久（毫秒）。
 *
 * 成功 6 秒、失败 11 秒：成功只要扫一眼结论，失败得让人读完原因（失败还额外 toast
 * 一次，见 startCall 的 onTaskDone）。停留结束后先淡出 CALL_TASK_FADE_MS 再移除。
 */
const CALL_TASK_LINGER_MS = 6_000
const CALL_TASK_FAIL_LINGER_MS = 11_000

/** 任务状态条的淡出时长（毫秒），与 call.css.ts 里 .pa-call__task 的 transition 对齐。 */
const CALL_TASK_FADE_MS = 600

/**
 * 拼实时通话的 `instructions`：**只放 Bot 人设**。
 *
 * 语音通话的约束（口语短句、不要念 Markdown 之类）由宿主 `wrapVoiceInstructions`
 * 统一追加（见 host/personal/realtime/session.ts）。前端不要重复写一份——两边都写
 * 会让模型收到两段几乎一样的话，行为上表现为「它把同一件事嘱咐了两遍」。
 */
function callInstructions(bot: Bot): string {
  const lines = [`你是「${bot.name}」${bot.role.trim() === '' ? '。' : `，${bot.role.trim()}。`}`]
  if (bot.description.trim() !== '') lines.push(bot.description.trim())
  if (bot.instructions.trim() !== '') lines.push(bot.instructions.trim())
  return lines.join('\n')
}

/**
 * 拼实时通话的 agent 定义（语音里「让它干活」时宿主拿它跑真正的 agent loop）。
 *
 * 为什么必须带：Realtime 会话本身**没有** agent 的工具（生图 / 读写文件 / 跑命令 /
 * 记忆），不带这份定义时用户说「帮我生成一张图」，模型只能回「我这边目前还没有
 * 直接生成图片的功能」——这是用户实测到的原话。
 *
 * 取数方式刻意与 `replyRequestBody` 保持一致（同一个 Bot 记录 + 同一批记忆），否则
 * 会出现「同一个 Bot 打字时是一个人格、说话干活时是另一个人格」。字段：
 *  · botId / name / role / description / instructions —— 直接取 Bot 记录；
 *  · model —— Bot 选的模型（含 effort），宿主据此跑任务；
 *  · permission —— 工具权限档位，旧数据缺省按 `full`（与 replyRequestBody 同款兜底）；
 *  · memories —— `state.memories` 里属于这个 Bot 的文本。
 */
function callAgentSpec(bot: Bot, state: AppState): RealtimeAgentSpec {
  const memories = state.memories
    .filter((entry) => entry.botId === bot.id)
    .map((entry) => entry.text.trim())
    .filter((text) => text !== '')
    // 只带最近 40 条：start 是 WS 文本帧，把上百条记忆全塞进去只会拖慢握手，对任务没有增益
    .slice(-40)
  return {
    botId: bot.id,
    name: bot.name,
    role: bot.role,
    description: bot.description,
    instructions: bot.instructions,
    model: {
      provider: bot.model.provider,
      model: bot.model.model,
      ...(bot.model.effort !== undefined && bot.model.effort !== '' ? { effort: bot.model.effort } : {}),
    },
    permission: bot.permission ?? 'full',
    ...(memories.length > 0 ? { memories } : {}),
  }
}

/**
 * 通话段标记块。
 *
 * `MessageBlock` 里它是匿名成员（没有单独命名），函数签名需要它，所以在这里取出来。
 */
type CallSegmentBlock = Extract<MessageBlock, { type: 'call-segment' }>

/**
 * 把一条「属于某个通话段」的消息插到段里的**正确位置**（不是简单追加）。
 *
 * 为什么不能追加：ASR 是异步的，`user_transcript` 经常晚于 Bot 的转写到达。按到达
 * 顺序落库，对话流就会变成「Bot 先答、用户后问」——这正是 `call-turns.ts` 在通话
 * 弹层里修过的问题。转写现在实时进对话流，同一个坑会原样复现，所以插入位置要按
 * 落库序号（`seqById`）算。
 *
 * 规则：插到段内**第一条序号比它大**的消息之前；段内没有更大的就插到段尾。
 * 产物消息没有序号（它们不是一轮对话），会被自然跳过——新转写插到段尾时排在产物之后，
 * 与「先出结果、后说话」的真实顺序一致。
 *
 * @param messages 现有消息（不修改原数组）。
 * @param message  要插入的消息。
 * @param segment  段 id。
 * @param seq      这条消息的落库序号。
 * @param seqById  段内消息 id → 落库序号。
 */
function insertCallMessage(
  messages: Message[],
  message: Message,
  segment: string,
  seq: number,
  seqById: Map<string, number>,
): Message[] {
  const markerIndex = messages.findIndex((item) => item.blocks.some(
    (block) => block.type === 'call-segment' && block.segment === segment,
  ))
  // 段标记不见了（历史数据被清、或段标记还没写）：退回追加，宁可顺序差也不能丢消息
  if (markerIndex < 0) return [...messages, message]
  let segmentEnd = markerIndex
  while (segmentEnd + 1 < messages.length && messages[segmentEnd + 1].callSegment === segment) segmentEnd += 1
  let insertAt = segmentEnd + 1
  for (let index = markerIndex + 1; index <= segmentEnd; index += 1) {
    const itemSeq = seqById.get(messages[index].id)
    if (itemSeq !== undefined && itemSeq > seq) {
      insertAt = index
      break
    }
  }
  const next = [...messages]
  next.splice(insertAt, 0, message)
  return next
}

/**
 * 从宿主的文件 URL 里取回工作区路径。
 *
 * 宿主给的是 `/api/personal-agent/file?path=<相对路径>`，而 `ChatImage.path` /
 * `ArtifactRef.path` 要的是路径本身（随消息带给宿主、也用于去重）。取不到 `path`
 * 参数时（data URL、外链）退回文件名，至少不是空串。
 */
function artifactPathOf(artifact: RealtimeArtifact): string {
  const query = artifact.url.indexOf('?')
  if (query >= 0) {
    const path = new URLSearchParams(artifact.url.slice(query + 1)).get('path')
    if (path !== null && path !== '') return path
  }
  return artifact.name !== undefined && artifact.name !== '' ? artifact.name : artifact.url
}

/** 产物卡的显示名：优先宿主给的文件名，其次从路径里取末段，最后按类型兜底。 */
function artifactNameOf(artifact: RealtimeArtifact): string {
  if (artifact.name !== undefined && artifact.name !== '') return artifact.name
  /*
   * data URL / 外链没有文件名可解析：直接按类型兜底。
   * 不排除的话会把 `data:video/mp4;base64,AAAA` 的末段 `mp4;base64,AAAA` 当文件名
   * 显示出来（实测就是这么冒出来的）。
   */
  const path = artifact.url.startsWith('data:') ? '' : artifactPathOf(artifact)
  const slash = path.lastIndexOf('/')
  const base = slash >= 0 ? path.slice(slash + 1) : path
  if (base !== '') return base
  if (artifact.kind === 'video') return '视频'
  if (artifact.kind === 'audio') return '音频'
  return '文件'
}

const STORAGE_KEY = 'pa:state:v1'
const UI_KEY = 'pa:ui:v1'

/*
 * 右栏宽度：默认 300px，可拖拽范围 240–640。
 *
 * 上限按「聊天区至少还能放下两三条消息」定：再宽会把中间的对话压成一条缝。
 * 窄屏由 shell.css.ts 的媒体查询接管固定宽度，这里的值只在宽屏生效。
 */
const DEFAULT_RIGHT_WIDTH = 300
const MIN_RIGHT_WIDTH = 240
const MAX_RIGHT_WIDTH = 640

/** 把任意来源的宽度收敛到合法范围；非数字回落默认值。 */
function clampRightWidth(value: unknown): number {
  const width = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(width)) return DEFAULT_RIGHT_WIDTH
  return Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, Math.round(width)))
}

/*
 * 对话主列宽度：0 = 自动铺满；手动拖拽后保存具体像素。
 *
 * 只限制中间对话列，左右侧栏保持各自宽度——侧栏折叠 / 拖拽不会改变这里的值。
 */
const MIN_CHAT_WIDTH = 520
const MAX_CHAT_WIDTH = 1600

/** 把对话宽度收敛到合法范围；0 / 非数字 / 负值都表示「自动铺满」。 */
function clampChatWidth(value: unknown): number {
  const width = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(width) || width <= 0) return 0
  return Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, Math.round(width)))
}

/**
 * 通话音量（0..1）单独存一个键。
 *
 * 为什么不并进 `UI_KEY`：`ui.call` 在挂断时会被整体重置成 idle（finalizeCall），
 * 音量混在里面会被重置冲掉；而用户显然希望「这通调小了，下一通还是这么小」。
 */
const CALL_VOLUME_KEY = 'pa:call-volume:v1'

/** 读回上次的通话音量；没存过 / 数据损坏 / 越界一律回落 1（满音量）。 */
function loadCallVolume(): number {
  try {
    const raw = localStorage.getItem(CALL_VOLUME_KEY)
    if (raw === null) return 1
    const value = Number(raw)
    if (!Number.isFinite(value)) return 1
    return Math.max(0, Math.min(1, value))
  } catch {
    return 1
  }
}

/** 记住通话音量（配额满时静默失败：只影响下次的默认值）。 */
function saveCallVolume(volume: number): void {
  try {
    localStorage.setItem(CALL_VOLUME_KEY, String(volume))
  } catch {
    /* 配额满 / 隐私模式禁用 localStorage */
  }
}

/** 任务记录最多保留多少条（只留最近 300 轮，避免 localStorage 无限膨胀）。 */
const MAX_TASK_RECORDS = 300

/**
 * 一条任务最多保留多少个执行步骤。
 *
 * 真实 agent 一轮可能跑几十个工具调用，300 条任务 × 几十步会把 localStorage
 * 撑到配额上限（那时连消息都写不进去）。保留 start + 最近 60 步足够回看，
 * 更早的中间步骤本来也不是用户关心的。
 */
const MAX_TASK_STEPS = 60

/* ---------- 历史对话归档（开新会话保留聊天记录） ---------- */

/**
 * 最多保留多少个历史对话归档。
 *
 * 归档是「冷数据」：用户要能回看，但不该让 localStorage 无限膨胀。30 个归档
 * 已经远超真实回看需求，再多只保留最近的。
 */
const MAX_ARCHIVED_SESSIONS = 30

/** 每个归档最多保留的消息条数（更早的消息没有回看价值，优先保最新上下文）。 */
const ARCHIVED_SESSION_MESSAGES_MAX = 500

/** 归档标题最大字数（首条 user 消息正文截断）。 */
const ARCHIVED_SESSION_TITLE_MAX = 30

/* ---------- 任务与委派（第 5 步） ---------- */

/** 有非终态委派时的轮询间隔（毫秒）。 */
const ASSIGNMENT_POLL_MS = 3_000

/** 每个 Bot 最多缓存多少条委派摘要（与宿主返回的最近 50 条对齐）。 */
const ASSIGNMENT_LIST_MAX = 50

/** 追加一步并做条数裁剪：保留第一条（start），超出时丢最早的工具步骤。 */
function pushTaskStep(steps: TaskRecordStep[], step: TaskRecordStep): TaskRecordStep[] {
  const next = [...steps, step]
  if (next.length <= MAX_TASK_STEPS) return next
  const [first, ...rest] = next
  return [first, ...rest.slice(rest.length - (MAX_TASK_STEPS - 1))]
}

/**
 * 从用户消息自动生成任务主题。
 *
 * 为什么用规则而不是再调一次模型：任务记录是每一轮都有的基础能力，额外一次
 * LLM 调用会让每条消息都变慢、也增加失败面。规则做三件事就够用：
 *  1. 去掉「请 / 帮我 / 麻烦 / 能不能 / 我想…」这类请求套话；
 *  2. 取第一句（句号 / 问号 / 换行都算断句）；
 *  3. 压到 24 个汉字以内，超长补省略号。
 *
 * 太短的寒暄（「好的」「收到」「继续」）不构成主题，交给完成时的 bot 回复首句兜底。
 *
 * @param text - 用户消息纯文本。
 * @param hasImages - 本条消息是否带图（纯图片消息文字为空）。
 * @returns 可上屏的任务主题。
 */
export function autoTaskTitle(text: string, hasImages = false): string {
  const raw = text.replace(/\s+/g, ' ').trim()
  if (raw === '') return hasImages ? '处理图片' : '未命名任务'
  let value = raw
  // 请求套话可能叠着出现（「麻烦帮我」），循环剥到不再命中为止。
  for (let index = 0; index < 4; index += 1) {
    const next = value.replace(/^(?:请|帮我|帮忙|麻烦你?|能不能|可不可以|可以帮我|可以|我想让|我想要|我要|我想|给我)\s*/u, '')
    if (next === value) break
    value = next
  }
  const first = value.split(/[。！？!?；;\n]/u)[0] ?? value
  const cleaned = first
    .replace(/[，,、\s]*(?:一下|吧|好吗|可以吗|谢谢你?)[。.!！?？]*$/u, '')
    .trim()
  const final = cleaned === '' ? value : cleaned
  return final.length > 24 ? `${final.slice(0, 24)}…` : final
}

/**
 * 这句用户消息是不是「不构成任务主题」的寒暄 / 确认。
 *
 * 只覆盖高频的短句；长句哪怕以「好的」开头也不该被误判。
 */
export function isTrivialTaskPrompt(text: string): boolean {
  const value = text.replace(/\s+/g, '').trim()
  if (value === '') return true
  if (value.length > 6) return false
  return /^(好的?|好|嗯+|哦+|收到|知道了|行|可以|继续|谢谢|辛苦了|ok|OK)$/u.test(value)
}

/** 从消息 blocks 里汇总工具调用（任务详情用）。 */
function toolRunsOfBlocks(blocks: readonly MessageBlock[]): ToolRun[] {
  const runs: ToolRun[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    if (block.type !== 'tool') continue
    if (seen.has(block.run.id)) continue
    seen.add(block.run.id)
    runs.push(block.run)
  }
  return runs
}

/* ───────────────────── 任务概览（task_state） ───────────────────── */

/** 模型写任务概览用的工具名（宿主 working-memory 的写入通道）。 */
const TASK_STATE_TOOL = 'task_state'

/** 步骤条数上限：与宿主 working-memory 的 WORKING_TASK_MAX_STEPS 对齐。 */
const TASK_OVERVIEW_MAX_STEPS = 20

/** 允许的步骤状态；模型传别的值一律按 todo 处理。 */
const TASK_OVERVIEW_STATUSES: ReadonlyArray<TaskOverviewStep['status']> = ['todo', 'doing', 'done']

/**
 * 把任意形状的 steps 收敛成 TaskOverviewStep[]。
 *
 * 不信任模型输入：既可能传 `["查账号","发邮件"]` 这种纯字符串数组，也可能带
 * 多余字段 / 非法 status。一条有效条目都洗不出来就返回 null——调用方据此保留
 * 旧清单，避免把「半份 / 空清单」写进任务记录。
 */
function normalizeOverviewSteps(raw: unknown): TaskOverviewStep[] | null {
  if (!Array.isArray(raw)) return null
  const steps: TaskOverviewStep[] = []
  for (const item of raw.slice(0, TASK_OVERVIEW_MAX_STEPS)) {
    if (typeof item === 'string') {
      const label = item.trim().slice(0, 80)
      if (label !== '') steps.push({ label, status: 'todo' })
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const label = String(record.label ?? '').trim().slice(0, 80)
    if (label === '') continue
    const statusRaw = String(record.status ?? '').trim()
    const status = TASK_OVERVIEW_STATUSES.includes(statusRaw as TaskOverviewStep['status'])
      ? statusRaw as TaskOverviewStep['status']
      : 'todo'
    steps.push({ label, status })
  }
  return steps.length > 0 ? steps : null
}

/**
 * 从 task_state 的 args 里取步骤清单。
 *
 * args 正常是 JSON 字符串（也兼容宿主直接给对象）。**末尾带省略号的一律不收**：
 * 宿主给工具卡做摘要时会把 args clip 到 180 字符，长参数只剩半截 JSON——拿半份
 * 清单覆盖上一次的完整清单，比不更新更糟。
 */
function overviewStepsFromArgs(raw: unknown): TaskOverviewStep[] | null {
  if (raw === undefined || raw === null) return null
  let value: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '' || text.endsWith('…')) return null
    try {
      value = JSON.parse(text)
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  // 少数链路会把 steps 再序列化一层字符串
  if (typeof record.steps === 'string') {
    try {
      return normalizeOverviewSteps(JSON.parse(record.steps))
    } catch {
      return null
    }
  }
  return normalizeOverviewSteps(record.steps)
}

/**
 * 从 task_state 的工具结果里兜底还原步骤。
 *
 * 为什么需要它：args 被 clip 到 180 字符后经常不是合法 JSON，而结果摘要
 * （`title（status）：✓a ▸b ·c；facts…`）是宿主按**完整**任务生成的，步骤
 * 反而齐全。只在 args 解析不出步骤时用。
 */
function overviewStepsFromResult(raw: unknown): TaskOverviewStep[] | null {
  if (raw === undefined || raw === null) return null
  const text = typeof raw === 'string' ? raw : String(raw)
  if (text.trim() === '') return null
  let summary = text
  // 结果可能是完整 JSON：优先取 summary 字段；截断的 JSON 直接按文本兜底
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (typeof parsed.summary === 'string' && parsed.summary !== '') summary = parsed.summary
  } catch {
    /* 被截断：按文本兜底 */
  }
  /*
   * describeWorkingTask 的格式：`title（status）：✓a ▸b ·c；facts…`
   * 中文冒号后是步骤区，分号后是 facts（不取）。符号映射：✓=done / ▸=doing / ·=todo。
   */
  const colon = summary.indexOf('：')
  const body = (colon >= 0 ? summary.slice(colon + 1) : summary).split('；')[0]
  const steps: TaskOverviewStep[] = []
  const pattern = /[✓▸·]\s*([^✓▸·]+)/g
  let match: RegExpExecArray | null = pattern.exec(body)
  while (match !== null) {
    const label = match[1].trim().slice(0, 80)
    const mark = match[0].trim().slice(0, 1)
    if (label !== '') {
      steps.push({ label, status: mark === '✓' ? 'done' : mark === '▸' ? 'doing' : 'todo' })
    }
    if (steps.length >= TASK_OVERVIEW_MAX_STEPS) break
    match = pattern.exec(body)
  }
  /*
   * 结果本身也可能被 clip（末尾带省略号）：最后一条 label 可能是半截文字，
   * 丢掉它——宁可少一条，不要写一条假的。
   */
  if (text.endsWith('…') && steps.length > 0) steps.pop()
  return steps.length > 0 ? steps : null
}

/** 从消息 blocks 里取最后一段正文（任务「最终回复」用）。 */
function lastTextOfBlocks(blocks: readonly MessageBlock[]): string {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block.type === 'text' && block.text.trim() !== '') return block.text.trim()
  }
  return ''
}

/** 从消息 blocks 里数产出物（工具 artifacts + 正文里出现过的文件路径）。 */
function outputCountOfBlocks(blocks: readonly MessageBlock[]): number {
  const paths = new Set<string>()
  for (const block of blocks) {
    if (block.type === 'tool') {
      for (const artifact of block.run.artifacts ?? []) paths.add(artifact.path.replace(/\\/g, '/').toLowerCase())
    }
  }
  return paths.size
}

/**
 * 把 blocks 里还在 running 的工具调用标成中断。
 *
 * 用户点了停止之后，宿主不会再发这个工具的结束事件——留着 running 就是一张永远
 * 转圈的卡。`ToolRunStatus` 只有 running / ok / error，没有 'stopped'，所以用
 * 'error' 承载「中断」：它确实不是正常完成。已经拿到的结果一律保留，只有完全
 * 没有结果的才补一句「已停止」，免得卡片看起来像工具自己崩了。
 */
function interruptRunningBlocks(blocks: readonly MessageBlock[]): MessageBlock[] {
  const at = Date.now()
  let changed = false
  const next = blocks.map((block) => {
    if (block.type !== 'tool' || block.run.status !== 'running') return block
    changed = true
    const run = block.run
    return {
      type: 'tool' as const,
      run: {
        ...run,
        status: 'error' as const,
        endedAt: run.endedAt ?? at,
        durationMs: run.durationMs ?? Math.max(0, at - run.startedAt),
        ...(run.result !== undefined && run.result !== '' ? {} : { result: '已停止' }),
      },
    }
  })
  // 没有 running 就返回原数组元素（浅拷贝一次即可，避免改到调用方的数组）
  return changed ? next : [...blocks]
}

/**
 * 「说停止」算不算真的停止。
 *
 * ## 为什么需要（2026-11-02 实测）
 *
 * 主 Bot 正在跑长任务时，用户在输入框发一句「停止」。前端照常把这句话投给宿主，
 * 而宿主对运行中的插话走的是 `steer`（改方向）——模型回一句「收到，我按你说的
 * 调整方向」，任务继续跑，右栏任务记录还是「进行中」。用户以为自己停了，
 * 实际上只是给正在跑的任务改了个方向。
 *
 * ## 判据为什么收得这么窄
 *
 * 只认**整句就是一个停止词**（去掉标点和空白后精确匹配）。带宾语或成句的
 * （「停止发邮件，改成发微信」「先停一下，等我看完」）仍然是改方向，交给宿主
 * steer 才对——把这些也拦成停止，用户想插话就插不进去了。
 */
const STOP_COMMANDS: ReadonlySet<string> = new Set([
  '停止',
  '停下',
  '停下来',
  '停',
  '暂停',
  '中止',
  '终止',
  '取消',
  '取消吧',
  '别做了',
  '别干了',
  '不做了',
  'stop',
  'cancel',
  'abort',
])

/** 整句是否只是一个停止词（忽略大小写、标点、空白）。 */
function isStopCommand(text: string): boolean {
  const flat = text
    .replace(/[\s。．.!！?？,，、;；:：~～…·"'"'()（）\[\]【】]+/g, '')
    .toLowerCase()
  return flat !== '' && STOP_COMMANDS.has(flat)
}

/**
 * 一轮正在跑的回复（输入框停止键的作用对象）。
 *
 * 只活在内存 ref 里，不进 state / localStorage：停止键要回答的是「现在能不能停」，
 * 不是「上次停过没有」。`abort()` 幂等——连点两次停止不该报错。
 */
interface RunningReplyTurn {
  botId: string
  /** 群聊轮次带 roomId（私聊省略）。 */
  roomId?: string
  /**
   * 这一轮对应的任务记录 id。
   *
   * 停止键靠它区分「有活着的轮次会自己收口」和「孤儿任务记录」：后者没有
   * abort 会来调用 finishTaskRecord，必须由 stopReply 直接收口（见那里的
   * orphanTasks）。没有这个字段时，只能按 botId 粗筛，同一 bot 的多条
   * running 记录分不清谁是谁。
   */
  taskId: string
  abort(): void
}

/**
 * 群聊里等上一位发言结束时，最多等多久。
 *
 * 到点就放行下一位：某一位卡住（宿主没回、工具跑飞）不能把后面所有人一起冻住。
 * 宁可让下一位看不到完整的前文，也不能让群里半天没有动静。
 */
const SERIAL_WAIT_TIMEOUT_MS = 180_000

/**
 * 已排期但还没启动的回复（群聊成员是排队串行启动的）。
 *
 * 停止键只能 abort「已经开始」的轮次；还在等前一位收口的成员如果不拦，
 * 用户点完停止过几百毫秒又会冒出一条新回复，看起来像没停掉。
 */
interface ScheduledReply {
  botId: string
  roomId?: string
  cancelled: boolean
  /**
   * 是否已经真正启动过。
   *
   * 排队时不能用「它现在不在 runningReplyTurnsRef 里」判断「它已经说完了」——
   * 排在第三位的成员第一次检查时，第二位可能还在等第一位，压根没启动过，
   * 这时判成「已结束」会让第三位和第二位同时开口。
   */
  started: boolean
}

type AnswerValue = string | string[] | Record<string, string>

export interface PersonalActions {
  selectBot(id: string): void
  selectRoom(id: string): void
  setView(view: 'chat' | 'journal'): void
  setTheme(theme: 'auto' | 'dark' | 'light'): void
  setRightTab(tab: PersonalUi['rightTab']): void
  toggleRightPanel(open?: boolean): void
  /**
   * 设置右栏宽度（px）。
   *
   * 拖拽过程中由 RightPanel 直接改 CSS 变量（不经过 React 重渲染），松手才
   * 调这个 action 落进 `pa:ui:v1`——每帧都写 store 会让整棵 Bot 界面重渲染。
   * 传进来的值会被 clamp 到 240–640。
   */
  setRightPanelWidth(width: number): void
  /**
   * 设置对话主列宽度（px）；0 = 自动铺满。
   *
   * 与右栏同理：拖拽过程直接改 CSS 变量，松手才落库，避免每帧重渲染。
   * 只影响中间对话列，左右侧栏宽度不受影响。
   */
  setChatWidth(width: number): void
  /**
   * 收起 / 展开左侧栏（与 Work 模式官方侧栏的折叠语义一致）。
   *
   * 不传参 = 取反；传布尔值用于「明确要收起 / 展开」的场景（例如折叠轨道里点
   * 主 Bot 头像时顺带展开）。纯视图动作：只写 `ui.sidebarCollapsed`。
   */
  toggleSidebar(open?: boolean): void
  /**
   * 收起 / 展开侧栏里的一个分区（Bot 分组用 group.id，群聊区块用 'rooms'）。
   *
   * 纯视图动作：只写 `ui.collapsedSections`，不动分组数据与选中的会话。
   */
  toggleSection(sectionId: string): void
  openNewBot(open: boolean): void
  /** 打开某个 Bot 的设置卡（null = 关闭）。 */
  openBotSettings(botId: string | null): void
  openGroupSettings(roomId: string | null): void
  /** 打开某条任务记录的详情卡（null = 关闭）。 */
  openTaskDetail(taskId: string | null): void
  openJournal(id: string | null): void
  sendMessage(text: string, opts?: { botId?: string; roomId?: string; images?: ChatImage[]; replyTo?: { id: string; preview: string } }): void
  /**
   * 停止当前会话正在进行的回复（输入框停止键）。
   *
   * 中止前端流式读取 + 通知宿主 cancel 这一轮，并把 pending 消息与任务记录
   * 收口成 stopped；群聊会停掉该群里所有正在回复的成员（含还在错峰等待的）。
   */
  stopReply(): void
  /**
   * 设置 / 取消「正在引用回复的那条消息」。
   *
   * 只是输入框的临时状态：用户点某条消息的「回复」后输入框上方出现引用条，
   * 发送或手动取消时清空。不进 localStorage（刷新后指向旧消息更困惑）。
   */
  setReplyTo(target: { id: string; preview: string } | null): void
  createBot(input: NewBotInput): Promise<Bot>
  updateBot(id: string, patch: Partial<Bot>): void
  deleteBot(id: string): void
  setBotEnabled(id: string, enabled: boolean): void
  /**
   * 置顶 / 取消置顶一个子 Bot：只影响它在所属分组里的排序（置顶的排最前），
   * 不动 groupId 与创建顺序，取消后回到原位。
   */
  setBotPinned(id: string, pinned: boolean): void
  moveBot(id: string, groupId: string): void
  createGroup(name: string): void
  renameGroup(id: string, name: string): void
  deleteGroup(id: string): void
  createRoom(name: string, memberIds: string[], avatar?: Avatar): string
  updateRoom(id: string, patch: Partial<{ name: string; memberIds: string[]; avatar: Avatar; modelMode: 'inherit' | 'unified'; unifiedModel: BotModel }>): void
  /** 置顶 / 取消置顶一个群聊：侧栏「群聊」区块里置顶的排最前。 */
  setRoomPinned(id: string, pinned: boolean): void
  deleteRoom(id: string): void
  answerInteractive(messageId: string, value: AnswerValue): void
  /**
   * 撤回一条用户消息：删掉这一轮的界面消息与本地记忆，插一条系统提示，
   * 并尽力通知宿主把模型上下文也遮蔽掉（失败静默，不影响本地结果）。
   */
  recallMessage(messageId: string): void
  /**
   * 给一条主动消息打 / 改 / 清提醒标记。
   *
   * kind=null 表示清除标记。本地立即生效；非演示模式下再尽力同步给宿主，
   * 宿主失败只 toast 提示「仅保存在本地」，不回滚本地状态。
   */
  setProactiveMark(messageId: string, kind: ProactiveMarkKind | null): void
  addMemory(botId: string, text: string, tags?: string[]): void
  deleteMemory(id: string): void
  createRoutine(input: { botId: string; name: string; instruction: string; schedule: Routine['schedule'] }): void
  toggleRoutine(id: string): void
  runRoutine(id: string): void
  deleteRoutine(id: string): void
  proactiveNow(botId: string): void
  /**
   * 把某个 bot 的最近私聊整理成「接力摘要」，供「整理并开新会话」确认卡预览。
   *
   * 只送最近 `RELAY_MESSAGES_MAX` 条带正文的消息（text 块拼接）；宿主不可用时
   * 返回 null（已 toast 过原因），调用方仍可退回「直接清空」。
   */
  prepareRelay(botId: string): Promise<{ brief: RelayBrief; degraded: boolean; error?: string } | null>
  /**
   * 清空某个 bot 的全部对话（界面消息 + 宿主侧 agent 会话）。
   *
   * 传 `options.relay` 时走「整理并开新会话」：先让宿主落盘摘要并 reset，界面
   * 清理与重载逻辑不变；不传时保持原来的 /reset 行为。
   */
  clearConversation(botId: string, options?: { relay?: RelayBrief }): Promise<void>
  /**
   * 删除一条历史对话归档。
   *
   * 只删前端本地记录（不动宿主会话文件）；历史面板是低频只读场景，不做二次确认。
   */
  deleteArchivedSession(id: string): void
  /**
   * 拉取某个 Bot 的 Pages（3.1）。
   *
   * 失败静默：host 路由还没就绪、或这个 Bot 一个页面都没交付过，在界面上是同一个
   * 结果——右栏不出现「页面」卡。不 toast、不记错误，也不阻塞其它渲染。
   */
  refreshPages(botId: string): Promise<void>
  /**
   * 拉取某个 Bot 的任务与委派摘要（第 5 步；面板与进度条用）。
   *
   * 只做前端缓存、失败静默；宿主没升级时面板保持空态，不影响聊天。
   */
  refreshAssignments(botId: string): Promise<void>
  generateJournal(botId: string, opts?: { auto?: boolean; date?: Date }): Promise<Journal>
  runJournalCheck(nowOverride?: number): { ok: boolean; reason: string; journalId?: string }
  startCall(botId: string): void
  endCall(): void
  /**
   * 通话里发一条文字：全双工链路下它走 `text` 帧，宿主会把它当成一轮用户消息
   * 并触发回复。
   *
   * **界面上已经没有入口了**——通话弹层底部的输入框与发送按钮已按用户反馈整块
   * 移除（横跨整宽、和居中成组的胶囊控件不协调）。action 与宿主 text 帧能力保留，
   * 将来若有别的入口（快捷回复、通知回执）可以直接接上。
   */
  callUserTurn(text: string): void
  /** 用户主动打断 Bot（清本地播放 + 让宿主取消上游响应）。 */
  interruptCall(): void
  /** 麦克风权限被拒后重试一次（会话仍在，失败可以直接挂断）。 */
  retryCallMicrophone(): void
  /**
   * 当前麦克风音量（0..1），供通话弹层画波形。
   *
   * 设计成「拉取式」而不是每帧 setState：波形是 60fps 的，走 state 会把整棵应用
   * 拖到掉帧。调用方在 requestAnimationFrame 里读，不触发任何渲染。
   */
  callLevel(): number
  setCallMuted(muted: boolean): void
  setCallSpeaker(speaker: boolean): void
  /**
   * 设置通话音量（0..1）：控制 Bot 声音的播放增益，实时生效并跨通话记住。
   *
   * 只影响下行；上行麦克风走浏览器 autoGainControl，不在这里调（叠增益会干扰
   * 服务端 VAD 与 ASR）。
   */
  setCallVolume(volume: number): void
  minimizeCall(minimized: boolean): void
  /**
   * 收起 / 展开一段语音通话（段 id 见 `MessageBlock` 的 `call-segment`）。
   *
   * 纯视图动作：段内消息不改不删，只是渲染层在收起时跳过它们。
   */
  toggleCallSegment(segment: string): void
  toast(text: string): void
  clearUnread(id: string, kind?: 'bot' | 'room'): void
}

interface PersonalContextValue {
  state: AppState
  ui: PersonalUi
  actions: PersonalActions
  activeBot: Bot
  activeRoom: { id: string; name: string; memberIds: string[] } | null
  activeMessages: Message[]
}

const PersonalContext = createContext<PersonalContextValue | null>(null)

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AppState
      if (parsed && Array.isArray(parsed.bots)) {
        return normalizeState(parsed)
      }
    }
  } catch {
    /* 损坏的本地状态一次性丢弃 */
  }
  return createInitialState()
}

/**
 * 清洗 localStorage 里的历史对话归档。
 *
 * 历史面板是只读回看场景，坏数据不能把整个 store 拖垮：
 *  · 非数组 → 空数组（旧 localStorage 没这个字段）；
 *  · 缺 id / botId / messages 的条目直接丢弃；
 *  · messages 只认有 id 与 at 的消息，并按 at 升序；
 *  · title 缺失 / 空白 → 「未命名对话」；
 *  · 每个归档只留最近 ARCHIVED_SESSION_MESSAGES_MAX 条，整体按 archivedAt 倒序
 *    留最近 MAX_ARCHIVED_SESSIONS 个。
 */
function normalizeArchivedSessions(raw: unknown): ArchivedSession[] {
  if (!Array.isArray(raw)) return []
  const out: ArchivedSession[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, any>
    const id = typeof record.id === 'string' ? record.id : ''
    const botId = typeof record.botId === 'string' ? record.botId : ''
    if (id === '' || botId === '' || !Array.isArray(record.messages)) continue
    const messages = (record.messages as any[])
      .filter((message) => message !== null
        && typeof message === 'object'
        && typeof message.id === 'string'
        && message.id !== ''
        && typeof message.at === 'number'
        && Number.isFinite(message.at))
      .sort((a: any, b: any) => a.at - b.at)
      .slice(-ARCHIVED_SESSION_MESSAGES_MAX)
    if (messages.length === 0) continue
    const firstAt = messages[0].at
    const lastAt = messages[messages.length - 1].at
    const startedAt = typeof record.startedAt === 'number' && Number.isFinite(record.startedAt) ? record.startedAt : firstAt
    const endedAt = typeof record.endedAt === 'number' && Number.isFinite(record.endedAt) ? record.endedAt : lastAt
    const archivedAt = typeof record.archivedAt === 'number' && Number.isFinite(record.archivedAt) ? record.archivedAt : endedAt
    const rawTitle = typeof record.title === 'string' ? record.title.trim() : ''
    const relay = record.relay === undefined ? null : normalizeRelayBrief(record.relay)
    out.push({
      id,
      botId,
      title: rawTitle !== '' ? truncate(rawTitle, ARCHIVED_SESSION_TITLE_MAX) : '未命名对话',
      startedAt,
      endedAt,
      messageCount: messages.length,
      messages,
      ...(relay !== null ? { relay } : {}),
      archivedAt,
    })
  }
  return out
    .sort((a, b) => b.archivedAt - a.archivedAt)
    .slice(0, MAX_ARCHIVED_SESSIONS)
}

/**
 * 构造一条历史对话归档（不写 state；写盘由调用方决定）。
 *
 * 归档范围与 clearConversation 的清理范围严格一致：只收该 bot 的私聊消息
 * （roomId === undefined），按 at 升序；空对话不产生归档。title 取首条 user
 * 消息正文前 ARCHIVED_SESSION_TITLE_MAX 字（没有 user 消息则「未命名对话」）。
 */
function buildArchivedSession(
  botId: string,
  messages: Message[],
  relay?: RelayBrief,
  now = Date.now(),
): ArchivedSession | null {
  const own = messages
    .filter((message) => message.roomId === undefined
      && (message.botId === botId || message.senderId === botId))
    .sort((a, b) => a.at - b.at)
  if (own.length === 0) return null
  const kept = own.slice(-ARCHIVED_SESSION_MESSAGES_MAX)
  const firstUser = kept.find((message) => message.role === 'user')
  const title = firstUser !== undefined ? truncate(blocksToText(firstUser.blocks), ARCHIVED_SESSION_TITLE_MAX) : ''
  return {
    id: shortId('arc'),
    botId,
    title: title !== '' ? title : '未命名对话',
    startedAt: kept[0].at,
    endedAt: kept[kept.length - 1].at,
    messageCount: kept.length,
    messages: kept,
    ...(relay !== undefined ? { relay } : {}),
    archivedAt: now,
  }
}

/* ---------- 任务与委派：状态与数据清洗 ---------- */

/** 委派的非终态（仍在进行中的状态）；其余三个 completed / failed / cancelled 是终态。 */
const OPEN_ASSIGNMENT_STATUSES: ReadonlySet<AssignmentView['status']> = new Set([
  'queued',
  'running',
  'needs_input',
  'waiting',
  'resume',
])

/** 一条委派是否仍在进行中（任务进度条与 3 秒轮询共用同一口径）。 */
export function isOpenAssignment(status: AssignmentView['status']): boolean {
  return OPEN_ASSIGNMENT_STATUSES.has(status)
}

/** 宿主可能返回的委派状态全集（洗数据时拒绝未知值）。 */
const ALL_ASSIGNMENT_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'needs_input',
  'waiting',
  'resume',
  'completed',
  'failed',
  'cancelled',
])

/**
 * 洗一条宿主返回的委派摘要。
 *
 * 缺 id、且双方 botId 都为空的条目丢弃（既定位不到对话也画不出方向）；
 * 可选字段按类型兜底——host 版本比前端新 / 旧时，面板不能因为一个字段缺失崩掉。
 */
function normalizeAssignmentView(raw: unknown): AssignmentView | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, any>
  const id = typeof record.id === 'string' ? record.id : ''
  if (id === '') return null
  const requesterBotId = typeof record.requesterBotId === 'string' ? record.requesterBotId : ''
  const assigneeBotId = typeof record.assigneeBotId === 'string' ? record.assigneeBotId : ''
  if (requesterBotId === '' && assigneeBotId === '') return null
  const numberOr = (value: unknown): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  )
  const startedAt = numberOr(record.startedAt)
  const lastActivityAt = numberOr(record.lastActivityAt)
  const finishedAt = numberOr(record.finishedAt)
  return {
    id,
    rootId: typeof record.rootId === 'string' && record.rootId !== '' ? record.rootId : id,
    ...(typeof record.parentId === 'string' && record.parentId !== '' ? { parentId: record.parentId } : {}),
    depth: typeof record.depth === 'number' && Number.isFinite(record.depth) ? record.depth : 0,
    requesterBotId,
    requesterName: typeof record.requesterName === 'string' && record.requesterName !== '' ? record.requesterName : requesterBotId,
    assigneeBotId,
    assigneeName: typeof record.assigneeName === 'string' && record.assigneeName !== '' ? record.assigneeName : assigneeBotId,
    mode: record.mode === 'consult' || record.mode === 'notify' ? record.mode : 'work',
    brief: typeof record.brief === 'string' ? record.brief : '',
    ...(typeof record.doneWhen === 'string' && record.doneWhen !== '' ? { doneWhen: record.doneWhen } : {}),
    status: typeof record.status === 'string' && ALL_ASSIGNMENT_STATUSES.has(record.status)
      ? record.status as AssignmentView['status']
      : 'queued',
    ...(typeof record.outcome === 'string' && record.outcome !== '' ? { outcome: record.outcome } : {}),
    createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(typeof record.result === 'string' && record.result !== '' ? { result: record.result } : {}),
  }
}

/**
 * 迁移 / 清理旧版演示状态。
 *
 * 2026-11-01 用户要求「移除所有假的 bot，初始化主 bot」：旧版种子里的七个演示
 * 子 Bot、协作小组、示例期刊、示例记忆与示例例行任务全部清掉；只保留主 Bot
 * 和用户自己创建的 Bot / 群聊 / 记忆 / 任务。旧版 `version:1` 一并升级到 2。
 */
function normalizeState(parsed: AppState): AppState {
  const legacyBots = new Set<string>(LEGACY_SEED_BOT_IDS)
  const legacyRooms = new Set<string>(LEGACY_SEED_ROOM_IDS)
  const legacyGroups = new Set<string>(LEGACY_SEED_GROUP_IDS)
  const legacyRoutines = new Set<string>(LEGACY_SEED_ROUTINE_IDS)
  const legacyJournals = new Set<string>(LEGACY_SEED_JOURNAL_IDS)
  const raw = parsed as unknown as Record<string, any>

  let bots = (Array.isArray(raw.bots) ? raw.bots : [])
    .filter((bot: any) => bot && typeof bot.id === 'string' && !legacyBots.has(bot.id))
    // 旧数据没有 permission 字段：补成完全权限（与「bot 是 agent」的默认预期一致）；
    // autoSpeak 同理——旧数据缺省即「不自动朗读」，只认显式 true。
    .map((bot: any) => ({
      ...bot,
      unread: 0,
      permission: bot.permission === 'approval' ? 'approval' : 'full',
      autoSpeak: bot.autoSpeak === true,
      // 上下文接力设置：旧数据没有该字段 / 被手改成坏值，一律归一化回合法域。
      relayAuto: normalizeRelayAuto(bot.relayAuto),
    }))
  if (!bots.some((bot: Bot) => bot.isMain)) bots = [createMainBot(), ...bots]
  /*
   * 主 Bot 改名迁移：旧版本默认叫「小墨助手」，现在统一叫 Seeker。
   *
   * 只改**还是旧默认名**的那一个——用户自己起过名字的不动，否则就是替用户做主。
   * 迁移放在 normalizeState（每次加载都会跑），所以老 localStorage 也能跟着更新。
   */
  bots = bots.map((bot: Bot) => (
    bot.isMain === true && bot.name === '小墨助手' ? { ...bot, name: 'Seeker' } : bot
  ))
  const groups = (Array.isArray(raw.groups) ? raw.groups : [])
    .filter((group: any) => group && typeof group.id === 'string' && !legacyGroups.has(group.id))
  if (!groups.some((group: any) => group.id === DEFAULT_GROUP_ID)) {
    groups.unshift({ id: DEFAULT_GROUP_ID, name: '助手', order: 0 })
  }
  const groupIds = new Set(groups.map((group: any) => group.id))
  bots = bots.map((bot: Bot) => (groupIds.has(bot.groupId) ? bot : { ...bot, groupId: DEFAULT_GROUP_ID }))

  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .filter((message: any) => message
      && !legacyBots.has(message.botId)
      && !legacyRooms.has(message.roomId)
      && !String(message.id ?? '').startsWith('m-'))
    /*
     * 刷新时的 pending 清理：页面刚加载不可能有正在进行的流，历史里残留的
     * `pending: true` 只可能是上次异常收口留下的（实测会永远显示「正在输入」）。
     * 一并把 running 的工具卡标成中断，避免刷新后还在转圈。
     */
    .map((message: any) => {
      if (message?.pending !== true) return message
      return {
        ...message,
        pending: false,
        blocks: (Array.isArray(message.blocks) ? message.blocks : []).map((block: any) => (
          block?.type === 'tool' && block.run?.status === 'running'
            ? { ...block, run: { ...block.run, status: 'error', result: '页面刷新，本轮已中断' } }
            : block
        )),
      }
    })

  const rooms = (Array.isArray(raw.rooms) ? raw.rooms : [])
    .filter((room: any) => room && typeof room.id === 'string' && !legacyRooms.has(room.id))
    .map((room: any) => ({
      ...room,
      memberIds: (Array.isArray(room.memberIds) ? room.memberIds : []).filter((id: string) => !legacyBots.has(id)),
    }))
    .filter((room: any) => room.memberIds.length > 0)

  const memories = (Array.isArray(raw.memories) ? raw.memories : [])
    .filter((entry: any) => entry
      && !legacyBots.has(entry.botId)
      && entry.id !== 'mem-main-1'
      && entry.id !== 'mem-main-2')
  const routines = (Array.isArray(raw.routines) ? raw.routines : [])
    .filter((routine: any) => routine
      && !legacyBots.has(routine.botId)
      && !legacyRoutines.has(routine.id))
  const calls = (Array.isArray(raw.calls) ? raw.calls : [])
    .filter((call: any) => call && !legacyBots.has(call.botId))
  const journals = (Array.isArray(raw.journals) ? raw.journals : [])
    .filter((journal: any) => journal
      && !legacyBots.has(journal.botId)
      && !legacyJournals.has(journal.id))

  // 主 Bot 的 lastMessage / lastAt 从清理后的消息重新算，避免还挂着演示摘要。
  bots = bots.map((bot: Bot) => {
    const own = messages.filter((message: Message) => message.botId === bot.id).sort((a: Message, b: Message) => a.at - b.at)
    const last = own.length > 0 ? own[own.length - 1] : undefined
    return {
      ...bot,
      lastMessage: last !== undefined ? truncate(blocksToText(last.blocks)) : undefined,
      lastAt: last?.at,
    }
  })

  const settings = {
    // v1 的「深色/浅色」是旧版设置弹窗的假选择（只 toast 不生效），迁移时改回跟随；
    // v2 用户手动选过才保留。
    theme: raw.version === 1
      ? 'auto'
      : (raw.settings?.theme === 'dark' || raw.settings?.theme === 'light' || raw.settings?.theme === 'auto' ? raw.settings.theme : 'auto'),
    showRightPanel: raw.settings?.showRightPanel !== false,
    /*
     * 期刊规则统一走 shared 的 `normalizeJournalRule`：旧 localStorage 里可能是缺字段 /
     * 越界（例如 endHour 小于 startHour）的对象，直接塞给宿主会让调度器判不出触发窗口。
     */
    journalRule: normalizeJournalRule(raw.settings?.journalRule),
  }
  const lastUserMessageAt = messages
    .filter((message: Message) => message.role === 'user')
    .reduce((max: number, message: Message) => Math.max(max, message.at), 0)
  /*
   * 任务记录：v3 新增。旧状态没有这个字段 → 空数组；旧演示 Bot 的任务一并清掉。
   * 只按时间倒序保留最近 300 条，其余丢给 localStorage 容错。
   */
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .filter((task: any) => task
      && typeof task.id === 'string'
      && typeof task.botId === 'string'
      && !legacyBots.has(task.botId)
      && Array.isArray(task.steps))
    .sort((a: TaskRecord, b: TaskRecord) => b.startedAt - a.startedAt)
    .slice(0, MAX_TASK_RECORDS)
    // 旧数据可能超出步数上限：加载时裁掉中间步骤，避免撑爆 localStorage
    .map((task: TaskRecord) => (task.steps.length > MAX_TASK_STEPS
      ? { ...task, steps: [task.steps[0], ...task.steps.slice(-(MAX_TASK_STEPS - 1))] }
      : task))
    /*
     * 僵尸任务收口：与上面消息 `pending` 清理同一口径——页面刚加载不可能有轮次
     * 在跑，还挂着 running 的一定是上次异常收口留下的。**必须在加载时清掉**：
     * 右栏任务记录读的是 `TaskRecord.status`，与消息的 pending 是两套数据，
     * 只清一边会让界面永远转着一个齿轮（见 settleStaleTask 的说明）。
     */
    .map((task: TaskRecord) => settleStaleTask(task))

  /*
   * 历史对话归档：旧 localStorage 没有这个字段 → 空数组；清洗与上限见
   * normalizeArchivedSessions。旧演示 Bot 的归档一并清掉（与消息 / 任务同一口径）。
   */
  const archivedSessions = normalizeArchivedSessions(raw.archivedSessions)
    .filter((session: ArchivedSession) => !legacyBots.has(session.botId))

  return {
    version: 2,
    bots,
    groups,
    rooms,
    messages,
    memories,
    routines,
    calls,
    journals,
    /*
     * 触发日志本地也留一份：刷新后规则面板不该立刻变成空的，宿主 `/journal/status`
     * 回来后再与宿主日志合并（按 at + reason 去重）。
     */
    journalLogs: normalizeJournalLogs(raw.journalLogs),
    tasks,
    archivedSessions,
    // 运行时缓存：每次加载都从空对象开始，等 activeBot 的 assignments 拉回来再填
    assignmentsByBot: {},
    settings,
    lastUserMessageAt,
  }
}

/**
 * 加载时被收口的僵尸任务所属的 bot。
 *
 * `normalizeState` 是纯函数（不能发请求），但「本地已经标停止」意味着宿主那一轮
 * 也该停——否则界面说停了、后台还在跑，后续输出会以「无主消息」的形式推过来。
 * 启动后的挂载 effect 读这份名单补发停止请求（见 usePersonal 里的启动对账）。
 */
const staleTaskBotIds = new Set<string>()

/**
 * 收口一条「僵尸任务」：持久化里还挂着 `status: 'running'`，但页面刚加载，
 * 不可能有任何轮次在跑。
 *
 * ## 为什么必须做（2026-11-02 实测踩到）
 *
 * `normalizeState` 早就把消息上的 `pending` 清掉了（见 messages 那段注释），
 * 但任务记录读的是**另一份数据** `TaskRecord.status`。只清一边的结果是：
 * 刷新后「正在输入」气泡没了，右栏任务记录却永远转着齿轮——用户点停止也救不
 * 回来，因为 `stopReply` 的兜底分支只认 `pending` 消息，没有 pending 就提前
 * return。于是「我说了停止，它还是运行中」。
 *
 * ## 为什么标 stopped 而不是 failed
 *
 * 这一轮没跑完是页面重载造成的，不是用户操作失误、也不是模型报错；显示成
 * 失败（红叉）会让人以为出了故障。`stopped` 在 UI 上是中性灰的空心圆。
 */
function settleStaleTask(task: TaskRecord): TaskRecord {
  if (task.status !== 'running') return task
  /* 记下 botId：宿主那边这一轮可能还在跑，挂载后要补一发停止（见 staleTaskBotIds）。 */
  staleTaskBotIds.add(task.botId)
  const lastStep = task.steps.length > 0 ? task.steps[task.steps.length - 1] : undefined
  const endedAt = Math.max(task.startedAt, lastStep?.at ?? task.startedAt)
  /* 时间线上还挂着 running 的步骤同样不能留：宿主不会再补结束事件。 */
  const steps = task.steps.map((step) => (step.status === 'running' ? { ...step, status: 'error' as const } : step))
  steps.push({
    at: endedAt,
    kind: 'end',
    title: '任务已中断',
    detail: '页面重新加载，这一轮没有跑完（需要继续就重新说一次要做的事）',
  })
  return {
    ...task,
    status: 'stopped',
    endedAt,
    durationMs: Math.max(0, endedAt - task.startedAt),
    steps,
  }
}

/**
 * 洗一遍 `readAt`：旧版本没有这个字段，坏数据（非数字 / NaN）也要挡掉。
 * 只认有限数字，其余丢弃——丢掉一条已读记录最多让某个会话多亮一次提示。
 */
function normalizeReadAt(raw: unknown): Record<string, number> {
  if (raw === null || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

function loadUi(state: AppState): PersonalUi {
  const fallback: PersonalUi = {
    selectedBotId: state.bots.find((bot) => bot.isMain)?.id ?? state.bots[0].id,
    selectedRoomId: null,
    view: 'chat',
    sidebarCollapsed: false,
    collapsedSections: [],
    readAt: {},
    rightPanelOpen: true,
    rightPanelWidth: DEFAULT_RIGHT_WIDTH,
    chatWidth: 0,
    rightTab: 'detail',
    botSettingsOpen: null,
    taskDetailId: null,
    newBotOpen: false,
    groupSettingsOpen: null,
    journalOpenId: null,
    call: createIdleCallUi(),
    search: '',
    toast: null,
    /*
     * 已收起的通话段：**不持久化**。
     *
     * 它是纯视图状态（`types.ts` 的 PersonalUi 注释里写了理由），刷新页面后默认
     * 全部展开更符合直觉——用户不该为了看一条旧转写先去点开一条折叠条。
     */
    collapsedCallSegments: [],
    // 引用回复同理：刷新后不恢复（指向一条旧消息的引用比没有引用更让人困惑）
    replyTo: null,
  }
  try {
    const raw = localStorage.getItem(UI_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersonalUi>
      return {
        ...fallback,
        selectedBotId: parsed.selectedBotId && state.bots.some((bot) => bot.id === parsed.selectedBotId) ? parsed.selectedBotId : fallback.selectedBotId,
        sidebarCollapsed: parsed.sidebarCollapsed ?? false,
        collapsedSections: Array.isArray(parsed.collapsedSections)
          ? parsed.collapsedSections.filter((id): id is string => typeof id === 'string')
          : [],
        readAt: normalizeReadAt(parsed.readAt),
        rightPanelOpen: parsed.rightPanelOpen ?? true,
        rightPanelWidth: clampRightWidth(parsed.rightPanelWidth),
        chatWidth: clampChatWidth(parsed.chatWidth),
        rightTab: parsed.rightTab ?? 'detail',
        // 设置卡 / 任务详情是「这一次打开」的临时态，不跨刷新恢复。
        botSettingsOpen: null,
        taskDetailId: null,
      }
    }
  } catch {
    /* ignore */
  }
  return fallback
}

function truncate(text: string, max = 32): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 把消息块压成一行纯文本（侧栏摘要 / 任务标题 / 记忆抽取共用）。
 *
 * 导出给侧栏用：那里要按消息流实时算「最后一句」，不能只读 bot.lastMessage
 * ——后者只在消息首次 append 时写一次，流式更新不会刷新它。
 */
export function blocksToText(blocks: MessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') return '[图片]'
      if (block.type === 'task') return block.title
      if (block.type === 'call') return '语音通话'
      // 段标记本身没有正文；不返回点东西的话侧栏摘要会被它清成空白
      if (block.type === 'call-segment') return '语音通话'
      if (block.type === 'journal') return block.title
      if (block.type === 'interactive') return block.prompt ?? '交互卡片'
      return ''
    })
    .join(' ')
}

/* ------------------------------------------------------------------------- *
 * 历史消息索引同步（第 3 步宿主侧 POST /api/personal-agent/history/index）
 * ------------------------------------------------------------------------- */

/** 历史索引同步的防抖窗口（毫秒）：一轮回复里消息会连续变化，合并成一次写入。 */
const HISTORY_SYNC_DEBOUNCE_MS = 1_500

/** 每个 Bot 每次最多同步的最近私聊消息条数。 */
const HISTORY_SYNC_MESSAGES_MAX = 500

/** 同步给宿主历史索引的一条消息（契约见第 3 步 /api/personal-agent/history/index）。 */
interface HistoryIndexMessage {
  id: string
  role: 'user' | 'bot'
  text: string
  at: number
}

/** 一个 Bot 的一批待同步消息。 */
interface HistoryIndexGroup {
  botId: string
  messages: HistoryIndexMessage[]
}

/** 消息的正文：只拼接 text 块（图片 / 工具卡 / 期刊卡没有可检索的自然语言）。 */
function historyIndexText(message: Message): string {
  return message.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((part) => part !== '')
    .join('\n')
    .trim()
}

/**
 * 从全量消息里抽取要同步给宿主历史索引的私聊消息，按 Bot 分组。
 *
 * 只收私聊（roomId === undefined）、非 system、非 pending、且有正文的消息；
 * 每个 Bot 最多取最近 HISTORY_SYNC_MESSAGES_MAX 条。群聊属于群，不进任何 Bot
 * 的私聊历史索引——否则同一句话会在每个成员的私聊历史里各出现一遍。
 */
function collectHistoryIndexGroups(messages: Message[]): HistoryIndexGroup[] {
  const grouped = new Map<string, HistoryIndexMessage[]>()
  for (const message of messages) {
    if (message.roomId !== undefined) continue
    if (message.role === 'system') continue
    if (message.pending === true) continue
    const text = historyIndexText(message)
    if (text === '') continue
    const batch = grouped.get(message.botId)
    const entry: HistoryIndexMessage = {
      id: message.id,
      role: message.role === 'user' ? 'user' : 'bot',
      text,
      at: message.at,
    }
    if (batch === undefined) grouped.set(message.botId, [entry])
    else batch.push(entry)
  }
  const groups: HistoryIndexGroup[] = []
  for (const [botId, batch] of grouped) {
    groups.push({ botId, messages: batch.slice(-HISTORY_SYNC_MESSAGES_MAX) })
  }
  return groups
}

/**
 * 消息指纹：同一批私聊消息不发第二次。
 *
 * 不用 JSON.stringify(整批消息)——流式期间 state.messages 每个 delta 都会换引用，
 * 每次序列化几百条长文本太贵；只取 id / at / 正文长度即可区分「消息集合变了」。
 * 正文从 pending 占位定稿时长度会变，所以也不会漏掉最后一条回复。
 */
function historySyncFingerprint(messages: Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.roomId !== undefined) continue
    if (message.role === 'system') continue
    if (message.pending === true) continue
    let textLength = 0
    for (const block of message.blocks) {
      if (block.type === 'text') textLength += block.text.length
    }
    if (textLength === 0) continue
    parts.push(`${message.botId}/${message.id}/${message.at}/${String(textLength)}`)
  }
  return parts.join('|')
}

/** 把一批消息推给宿主历史索引。失败静默：历史检索是增强项，不能打扰用户。 */
async function pushHistoryIndex(botId: string, batch: HistoryIndexMessage[]): Promise<void> {
  try {
    await fetch('/api/personal-agent/history/index', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId, messages: batch }),
    })
  } catch {
    /* 宿主未升级 / 网络抖动都吞掉：下一批消息变化时会重新带上最近窗口。 */
  }
}

function uiTextForAnswer(uiBlock: InteractiveUi, value: AnswerValue): string {
  if (typeof value === 'string') {
    if (uiBlock.kind === 'form') return value
    const option = uiBlock.options.find((item) => item.id === value)
    return option?.label ?? value
  }
  if (Array.isArray(value)) {
    if (uiBlock.kind === 'form') return value.join('、')
    return value.map((id) => uiBlock.options.find((item) => item.id === id)?.label ?? id).join('、')
  }
  return Object.entries(value)
    .map(([key, val]) => `${key}: ${val}`)
    .join('；')
}

/**
 * host 侧的多消息单元（与 `host/personal/agent.ts` 的 `BotMessage` 逐字对齐）。
 *
 * 一轮 turn 会被 host 按「模型说话的次数」切成多条：说完调工具、拿到结果再说一段，
 * 就是两条消息。`kind` 决定前端外观，`id` 用来定位 `message-update`。
 */
export interface HostBotMessage {
  id: string
  kind: BotMessageKind
  blocks: MessageBlock[]
  at: number
  /**
   * 所属轮次 id（host 下发；老 host / 老数据没有）。
   *
   * 前端按它把同一轮的 bot 消息归进一个轮次容器（2.8）。没有它时按单条渲染，
   * 不报错——这样 host 与前端可以各自独立上线。
   */
  turnId?: string
  /**
   * 引用回复（host 下发时才有）。
   *
   * 现在 host 还不产生它，但协议已经定好：谁引用了哪条消息由 host 决定（跨设备
   * 同步时前端本地记的 id 不一定对得上），前端只负责渲染。解析放在这里，将来
   * host 一上线就不用再改前端。
   */
  replyTo?: { id: string; preview: string }
}

/**
 * 宿主 `/api/personal-agent/reply/stream` 的事件形状（见 host/personal/agent.ts
 * 的 PersonalStreamEvent）。前端按 type 分支处理：
 *
 *  · message        —— 新开一条消息（DOST 式多消息的来源）
 *  · message-update —— 原地更新已有消息（工具卡状态、生图占位换真图）
 *  · text / tool    —— **旧的扁平视图**，多消息模式下仍会一起发来，前端忽略即可
 *  · error          —— 本轮出错（含「agent 建不起来」这类致命错误）
 *  · done           —— 收口信号。**host 目前会重复发**（runBotTurn 内部一次 + 路由收尾
 *                      一次，`!turn.ok` 时 done 后面还会再补一条 error），所以前端必须幂等
 */
export type PersonalStreamEvent =
  | { type: 'user-message'; messageId: string }
  | { type: 'message'; message: HostBotMessage }
  | { type: 'message-update'; message: HostBotMessage }
  | { type: 'text'; text: string }
  | { type: 'tool'; run: ToolRun }
  | { type: 'error'; message: string }
  | { type: 'done'; durationMs: number }

/**
 * 从 SSE 字节流里切出完整帧，返回还没吃完的尾巴（下次拼上新数据继续切）。
 *
 * 纯函数，不碰 fetch / DOM，便于 node 侧自测。约定：
 *  · 帧分隔是空行（`\n\n`）；`\r\n\r\n` 也认——先把 `\r\n` 归一成 `\n` 再找。
 *    归一化是安全的：chunk 边界正好切在 `\r` 和 `\n` 之间时，那个孤立的 `\r`
 *    会留在尾巴里，下一块数据以 `\n` 开头拼起来仍是 `\r\n`，下次调用照样归一。
 *  · 每帧取所有 `data:` 行，去掉冒号后**一个**前导空格，用 `\n` 拼起来交给 onFrame；
 *  · 没有 data 行的帧（注释帧 / 心跳）直接丢掉；
 *  · 只有半帧（还没等到空行）时原样返回，等下一块数据补齐。
 */
export function parseSseFrames(buffer: string, onFrame: (data: string) => void): string {
  let rest = buffer.replace(/\r\n/g, '\n')
  let split = rest.indexOf('\n\n')
  while (split >= 0) {
    emitSseFrame(rest.slice(0, split), onFrame)
    rest = rest.slice(split + 2)
    split = rest.indexOf('\n\n')
  }
  return rest
}

/** 把一帧的原始文本抽成 data 载荷（多行 data 按 SSE 规范用 `\n` 连接）。 */
function emitSseFrame(frame: string, onFrame: (data: string) => void): void {
  const parts: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const value = line.slice(5)
    parts.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  if (parts.length === 0) return
  onFrame(parts.join('\n'))
}

/**
 * 把一帧的 data 文本解析成流式事件。
 *
 * 非 JSON / 形状不认识 / 缺关键字段时返回 null 由调用方静默跳过——流里混进
 * 一条脏帧不该让整轮回复失败。
 */
export function parseSseEvent(data: string): PersonalStreamEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  const type = typeof raw.type === 'string' ? raw.type : ''
  if (type === 'user-message') {
    return typeof raw.messageId === 'string' && raw.messageId !== ''
      ? { type: 'user-message', messageId: raw.messageId }
      : null
  }
  if (type === 'message' || type === 'message-update') {
    return parseHostMessage(raw.message) === null
      ? null
      : { type, message: parseHostMessage(raw.message) as HostBotMessage }
  }
  if (type === 'text') {
    return typeof raw.text === 'string' ? { type: 'text', text: raw.text } : null
  }
  if (type === 'tool') {
    if (raw.run === null || typeof raw.run !== 'object') return null
    const run = raw.run as Record<string, unknown>
    if (typeof run.id !== 'string' || typeof run.name !== 'string') return null
    return { type: 'tool', run: run as unknown as ToolRun }
  }
  if (type === 'error') {
    return { type: 'error', message: typeof raw.message === 'string' ? raw.message : '未知错误' }
  }
  if (type === 'done') {
    return { type: 'done', durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0 }
  }
  return null
}

/**
 * 解析 host 的多消息载荷。形状不认识时返回 null，由调用方静默跳过。
 *
 * `blocks` 直接沿用前端 `MessageBlock` 的形状（host 侧就是按它构造的），这里只做
 * 最小校验：数组存在且每项是对象。过深的结构校验交给渲染层——流里混进一条脏帧
 * 不该让整轮回复失败。
 */
/** 解析引用回复载荷（host 未下发 / 形状不认识时返回 undefined）。 */
function parseReplyTo(raw: unknown): { id: string; preview: string } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return undefined
  return { id: record.id, preview: typeof record.preview === 'string' ? record.preview : '' }
}

function parseHostMessage(raw: unknown): HostBotMessage | null {
  if (raw === null || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '') return null
  if (!Array.isArray(value.blocks)) return null
  const kind = typeof value.kind === 'string' ? value.kind : 'progress'
  const allowed: ReadonlyArray<HostBotMessage['kind']> = ['progress', 'finding', 'need-input', 'approval', 'final']
  const replyTo = parseReplyTo(value.replyTo)
  const turnId = typeof value.turnId === 'string' && value.turnId !== '' ? value.turnId : undefined
  return {
    id: value.id,
    kind: allowed.includes(kind as HostBotMessage['kind']) ? kind as HostBotMessage['kind'] : 'progress',
    blocks: value.blocks.filter((block): block is MessageBlock => block !== null && typeof block === 'object'),
    at: typeof value.at === 'number' ? value.at : Date.now(),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
  }
}

/**
 * 宿主 `bot_create` 账本里的一条记录（SSE 的 `bot-created` 事件与 `GET /bots/created`
 * 共用同一个形状）。
 *
 * 只带身份字段：外观、模型、主动问候这些展示与运行期配置由前端补齐（见
 * `botFromCreatedRecord`）。宿主不该知道前端长什么样——它连色板都没有，也不该有，
 * 否则改一次配色就要动宿主。
 *
 * 为什么定义在这里而不是 `types.ts`：这是**宿主协议**，只有本文件消费。`types.ts`
 * 是前端展示模型（Bot / Message / Room…），把协议字段混进去，渲染层迟早会开始直接
 * 读它，宿主换个字段名就要改一片组件。
 */
interface CreatedBotRecord {
  id: string
  name: string
  role: string
  description: string
  instructions: string
  /** 落到哪个分组；缺省由前端塞进默认分组。 */
  groupId?: string
  createdAt: number
  /** 创建者的 botId（正常是主 Bot）。 */
  createdBy: string
}

/**
 * 把宿主推来的记录洗成可用的 `CreatedBotRecord`；认不出就返回 null。
 *
 * 宿主与前端不一定同版本发布（插件热更新时页面还开着，旧页面会收到新宿主的事件）。
 * 字段缺失不能让一条脏帧把整个 SSE 回调抛死——丢掉这一条，后面的消息还要照常收。
 * 只有 id / name 是硬要求：没有它们既没法去重，也没法在侧栏显示。
 */
function sanitizeCreatedBot(raw: unknown): CreatedBotRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return null
  if (typeof record.name !== 'string' || record.name === '') return null
  return {
    id: record.id,
    name: record.name,
    role: typeof record.role === 'string' ? record.role : '',
    description: typeof record.description === 'string' ? record.description : '',
    instructions: typeof record.instructions === 'string' ? record.instructions : '',
    ...(typeof record.groupId === 'string' && record.groupId !== '' ? { groupId: record.groupId } : {}),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    createdBy: typeof record.createdBy === 'string' && record.createdBy !== '' ? record.createdBy : MAIN_BOT_ID,
  }
}

/**
 * 把一条宿主记录落成前端 `Bot`。
 *
 * 默认值照抄 `createBot`：同一个「新 Bot」不该因为来源不同（用户点「+ 新建」vs
 * 主 Bot 在对话里建）而长得不一样——头像、模型、主动问候都按同一套走，否则侧栏里
 * 会出现两种风格的 Bot，用户会以为创建失败了一半。
 *
 * `unread` 给 0 而不是 1：欢迎消息紧接着由 `appendMessage` 落下，它会把未读加到 1
 * （见 `absorbCreatedBots`）。这里再给 1 会让同一条消息被数两遍，侧栏显示「2」而
 * 对话里只有一条。
 */
function botFromCreatedRecord(record: CreatedBotRecord): Bot {
  const appearance = randomBotAppearance()
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    description: record.description,
    instructions: record.instructions,
    avatar: { shape: appearance.shape, color: appearance.color, tint: appearance.tint },
    groupId: record.groupId ?? DEFAULT_GROUP_ID,
    isMain: false,
    status: 'online',
    unread: 0,
    pinned: false,
    enabled: true,
    model: MODEL_FALLBACK,
    skills: [],
    permission: 'full',
    eli5Mode: true,
    proactive: { enabled: true, freq: 'daily', from: '09:00', to: '22:00' },
    createdAt: record.createdAt,
    createdBy: record.createdBy,
  }
}

/**
 * 把宿主创建的 Bot 合并进当前花名册，按 id 去重。
 *
 * 去重不是防御性冗余：宿主的环形缓冲会让同一条记录从补发里再来一次，启动时的
 * `/bots/created` 也可能和 SSE 撞在同一条记录上——同一条记录只该有一只 Bot，否则
 * 侧栏会出现两个同名条目，消息还会各走各的会话。
 *
 * 返回 `added` 而不只是新数组：调用方要拿它决定「弹不弹 toast、落不落欢迎消息」。
 * 让「合并」与「副作用」分开，SSE 与启动拉取才能共用同一份判断。
 */
function mergeCreatedBots(bots: Bot[], records: readonly CreatedBotRecord[]): { bots: Bot[]; added: Bot[] } {
  const known = new Set(bots.map((bot) => bot.id))
  const added: Bot[] = []
  for (const record of records) {
    if (known.has(record.id)) continue
    known.add(record.id)
    added.push(botFromCreatedRecord(record))
  }
  return added.length === 0 ? { bots, added } : { bots: [...bots, ...added], added }
}

/**
 * 把一个流式事件合进 blocks，返回新数组（不改入参，React 才能看见变化）。
 *
 *  · text：追加到末尾的 text 块上，用空行连接——与 MessageBlockView 里
 *          mergeTextBlocks 的规则一致，避免每个模型步骤变成一坨独立气泡；
 *          空白文本忽略（host 侧虽然已经 trim 过，这里再兜一层）。
 *  · tool：按 run.id 就地替换（同一 callId 的多次快照只留最新一条），
 *          位置保持在第一次出现的地方，卡片不会跳来跳去。
 *  · error / done：不产生可见块。错误由调用方在收口时决定要不要展示成文本。
 */
export function applyStreamEventToBlocks(blocks: MessageBlock[], event: PersonalStreamEvent): MessageBlock[] {
  if (event.type === 'text') {
    const text = event.text.trim()
    if (text === '') return blocks
    const last = blocks[blocks.length - 1]
    if (last !== undefined && last.type === 'text') {
      const next = blocks.slice(0, -1)
      next.push({ type: 'text', text: `${last.text}\n\n${text}` })
      return next
    }
    return [...blocks, { type: 'text', text }]
  }
  if (event.type === 'tool') {
    const index = blocks.findIndex((block) => block.type === 'tool' && block.run.id === event.run.id)
    if (index < 0) return [...blocks, { type: 'tool', run: event.run }]
    const next = blocks.slice()
    next[index] = { type: 'tool', run: event.run }
    return next
  }
  return blocks
}

/** 组装请求体时与本轮「场地」相关的可选参数。 */
export interface ReplyRequestOptions {
  /**
   * 这一轮所属的群聊 id（私聊缺省）。
   *
   * 宿主靠它把**这一轮里冒出来的卡片**（审批卡 / 问答卡）送回发起它的群：
   * 卡片本身不带场地信息，不传的话它会落进该 Bot 的私聊，群里那条回复就一直转圈。
   */
  roomId?: string
  /**
   * 覆盖这一轮实际使用的模型（群设置「全组统一模型」）。
   *
   * 缺省 = 用 Bot 自己的模型。
   */
  unifiedModel?: BotModel
  /**
   * 本轮那条用户消息的 id。
   *
   * 构造群历史时要把它排除：它在 `landUserMessage` 里已经落进消息流了，
   * 但又会作为 `text` 单独发给宿主一次——不排除的话模型会看到同一句话两遍。
   */
  userMessageId?: string
  /**
   * 本轮引用了哪条消息（用户点了气泡上的「引用」才带）。
   *
   * 与 `userMessageId` 不是一回事：那是「本轮这条用户消息」，这是「它在回哪一条」。
   * 宿主把被引用消息的完整内容拼进本轮提示；不带的话界面上的引用条就只是装饰，
   * 模型看到的仍然只有一句「1」——这正是「引用了却答非所问」的成因。
   */
  quote?: QuoteRef
  /**
   * 本轮用户 @ 了哪些 Bot（私聊里由输入框正文解析出来）。
   *
   * 为什么走请求体而不是前端拼进 text：宿主需要的是「哪个 bot id」，而正文里的
   * 「@采集」只有名字。群聊回合也会带（解析不受场地限制），宿主侧只认私聊——
   * 群里的 @ 已经是前端路由信号，再注入一次会让接话的人跑去派活。
   */
  mentions?: MentionTarget[]
}

/**
 * 组装 `/reply` 与 `/reply/stream` 共用的请求体。
 *
 * 两条路由在 host 侧读的是同一个 ReplyBody（bot / permission / text / history /
 * memories），抽出来是为了保证「流式与非流式的上下文完全一致」——各写一份迟早
 * 会漂移，表现成「同一个 bot 换个入口就换了记忆」。
 */
function replyRequestBody(
  bot: Bot,
  text: string,
  state: AppState,
  images: ChatImage[] = [],
  opts: ReplyRequestOptions = {},
): string {
  /*
   * 群聊「全组统一模型」：把这一轮实际要用的模型**覆盖进 bot.model**。
   *
   * 群设置里的 modelMode / unifiedModel 原来只写进了 localStorage，宿主侧
   * `toBotSpec` 读的仍然是 `bot.model`，于是这个开关在界面上能选、能保存、
   * README 也写了「全组统一模型」，但一轮回复都不会按它走。真正决定模型的是
   * 这一个字段，所以在这里换掉，而不是再往宿主加一条并行通道。
   */
  const model = opts.unifiedModel ?? bot.model
  return JSON.stringify({
    bot: {
      id: bot.id,
      name: bot.name,
      role: bot.role,
      description: bot.description,
      instructions: bot.instructions,
      model,
      eli5Mode: bot.eli5Mode !== false,
      /*
       * 主 Bot 标记：宿主据此决定给谁挂 `bot_create`（只有主 Bot 能建子 Bot）。
       *
       * 每轮都带、显式给布尔值：宿主的花名册是「收到就覆盖」的缓存，省略会被当成
       * 「旧前端不认识这个字段」，回落到「谁都能建」或「谁都别建」——两种回落都错，
       * 不如永远给一个确定的答案。
       */
      isMain: bot.isMain === true,
    },
    ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
    permission: bot.permission ?? 'full',
    text,
    /*
     * 引用回复：把「用户回的是哪条消息」一起投过去。
     *
     * 界面上的引用条只存了 80 字摘要（preview），交互卡的选项根本不在里面；
     * 宿主要的是完整内容，所以这里带 buildQuoteRef 补全后的 quote（含 role）。
     * 没引用时整个字段不出现，老宿主 / 老前端互不影响。
     */
    ...(opts.quote !== undefined ? { quote: opts.quote } : {}),
    // 用户 @ 了谁：宿主在用户消息前注入「这件事该派给 X」，模型据此调 coordinate_bots
    ...(opts.mentions !== undefined && opts.mentions.length > 0 ? { mentions: opts.mentions } : {}),
    /*
     * 全量 Bot 花名册：宿主派活时需要知道「子 Bot 是谁」。
     *
     * 为什么每轮都带：宿主只在收到时缓存，不带的话「从没跟用户聊过的 Bot」
     * 就派不出去。只带身份与模型——memories 每轮变化，缓存旧值会让子 Bot
     * 用上过期的记忆。
     */
    roster: state.bots.map((item) => ({
      id: item.id,
      name: item.name,
      role: item.role,
      description: item.description,
      instructions: item.instructions,
      model: item.model,
      eli5Mode: item.eli5Mode !== false,
      // 同上：宿主建子 Bot 时要靠花名册认出「谁是主 Bot」，其余成员一律不是
      isMain: item.isMain === true,
    })),
    // 只带相对路径：图片已经在 /upload 落盘，宿主据此在 user 消息里提示 read_image。
    ...(images.length > 0 ? { images: images.map((item) => ({ path: item.path, name: item.name })) } : {}),
    /*
     * 历史按**场地**取，不按 Bot 取。
     *
     * 原来是一句 `msg.botId === bot.id && !msg.roomId`——把群消息全部滤掉。后果是
     * 群里的成员互相看不见：被 @ 的 Bot 只知道自己会话里发生过什么，「三个成员
     * 各说一版方案」实际是三个互不知情的单聊。群聊回合现在只带**本群**的消息，
     * 私聊回合维持原样（只带这个 Bot 的私聊）。
     *
     * 不带别的群的消息是刻意的：那是另一种场地的事，混进来就是串场地。
     */
    history: (opts.roomId !== undefined
      ? state.messages.filter((msg) => msg.roomId === opts.roomId
        && !msg.pending
        && msg.source !== 'compaction'
        && msg.id !== opts.userMessageId)
      : state.messages.filter((msg) => msg.botId === bot.id
        && !msg.roomId
        && !msg.pending
        && msg.source !== 'compaction'))
      /*
       * 群聊给 20 条：一次群回合里可能已经有好几个人说过话，12 条会把本轮的开头
       * 挤掉；私聊维持 12 条不变（宿主那边还有自己的长期会话，前端这段只是补充）。
       */
      .slice(opts.roomId !== undefined ? -20 : -12)
      /*
       * name 只在群聊里带：私聊的 history 每条都是「我 vs 这个 Bot」，说了名字反而
       * 多一层噪音。群里必须带——不然模型分不清哪句是自己说的、哪句是别人说的。
       */
      .map((msg) => ({
        role: msg.role,
        /*
         * 用 historyTextOf 而不是 blocksToText：前者展开交互卡的选项、并带上
         * 「这条在引用哪条」的前缀。用户回一句「1」时，模型要靠这段历史才认得出
         * 1 指的是上一轮哪个选项——这正是 bot 回「没看到前文的选项」的根因。
         */
        text: historyTextOf(msg),
        ...(opts.roomId !== undefined
          ? { name: msg.role === 'user' ? '用户' : (msg.senderName ?? bot.name) }
          : {}),
      })),
    /*
     * 不再带 memories：记忆已统一由宿主记忆引擎注入（schema v6 起按 owner 隔离，
     * 见 src/triad/memory/engine/visibility.ts）。继续带会形成第二套注入源——
     * 同一件事在两个库里各存一份、各自衰减，模型还会收到重复的两段。
     */
  })
}

async function hostReply(bot: Bot, text: string, state: AppState, images: ChatImage[] = [], opts: ReplyRequestOptions = {}): Promise<MessageBlock[] | null> {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null
  try {
    const controller = new AbortController()
    /*
     * 超时给足：bot 现在跑的是真 agent（可能连续读文件、跑命令、搜索），
     * 十几秒就掐断会把正常工作流误判成失败。
     */
    const timer = setTimeout(() => controller.abort(), 300_000)
    const res = await fetch('/api/personal-agent/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: replyRequestBody(bot, text, state, images, opts),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; blocks?: MessageBlock[] }
    if (data.ok && Array.isArray(data.blocks) && data.blocks.length > 0) return data.blocks
  } catch {
    /* 无 host / 无模型：回退本地引擎 */
  }
  return null
}

/**
 * 流式版本的 hostReply：POST /api/personal-agent/reply/stream，边读边回调。
 *
 * 返回值约定：
 *  · `null` —— 请求失败（非 2xx / 不是事件流 / 没有 body / 网络异常 / 一个事件
 *              都没收到），调用方应当回退到非流式 hostReply；
 *  · 数组   —— 流跑完了，内容是最终 blocks（可能为空：只收到 error 事件、或模型
 *              确实什么都没说；空数组同样交给调用方走降级链）。
 *
 * 「流跑完」不要求见过 done 事件：host 的失败路径只 emit error 就结束流。所以只要
 * 读到了事件、流正常关闭（或中途断开时已有内容），就把累积结果交出去，调用方按
 * blocks 是否为空决定收口还是降级——pending 消息因此不会永远挂在「正在输入」。
 *
 * 为什么失败用返回值而不是抛错：调用方要按「流式 → 非流式 → 本地引擎」三级降级，
 * 返回值判断比 try/catch 直白，也不会把一次失败变成未处理的 rejection。
 *
 * onEvent 的第二参数是**当前累积出来的 blocks 快照**（不可变，每次内容事件都是新
 * 数组），调用方直接拿它整块替换 pending 消息的 blocks 即可，不必自己再维护一份
 * 累积逻辑。
 *
 * `signal` 是用户点「停止」时用的外部中止信号：它只负责断开这次读取，返回值的
 * 约定不变（已收到的内容照样交回）。要不要降级由调用方决定——停止**不能**降级，
 * 非流式重跑会把这一轮的工具调用、生图再执行一遍。
 */
async function hostReplyStream(
  bot: Bot,
  text: string,
  state: AppState,
  onEvent: (event: PersonalStreamEvent, blocks: MessageBlock[]) => void,
  images: ChatImage[] = [],
  signal?: AbortSignal,
  opts: ReplyRequestOptions = {},
): Promise<MessageBlock[] | null> {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null
  let received = 0
  let blocks: MessageBlock[] = []
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300_000)
    /*
     * 外部信号并入内部 controller，而不是用 AbortSignal.any：后者在老 WebView /
     * 旧 Chromium 里没有，会把「点停止」变成一次 TypeError，反而停不下来。
     */
    const abortFromOutside = (): void => controller.abort()
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', abortFromOutside, { once: true })
    }
    try {
      const res = await fetch('/api/personal-agent/reply/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: replyRequestBody(bot, text, state, images, opts),
        signal: controller.signal,
      })
      if (!res.ok) return null
      const contentType = res.headers.get('content-type') ?? ''
      // 宿主没挂流式路由 / 被代理吞成 JSON 时，这里就能识别出来并让调用方降级
      if (!contentType.includes('text/event-stream') || res.body === null) return null

      let doneSeen = false
      const handle = (payload: string): void => {
        const event = parseSseEvent(payload)
        if (event === null) return
        // done 幂等：host 现在会发两次（runBotTurn 内部 + 路由收尾），只认第一次
        if (event.type === 'done') {
          if (doneSeen) return
          doneSeen = true
        }
        received += 1
        blocks = applyStreamEventToBlocks(blocks, event)
        onEvent(event, blocks)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        /*
         * 读到 done 就主动退出，不干等连接自然关闭。
         *
         * done 是宿主明确的收口信号：runBotTurn 发完最后一帧就 return，路由随后
         * res.end()。此时再等 EOF 没有意义，却会把「宿主已经收口、连接却没断」
         * 变成前端永远挂着——实测（2026-11-05 19:33 那一轮）：14 个工具跑完、
         * 宿主 turn/end 已经发生，右栏任务卡却一直停在「正在整理回复…」，直到
         * 页面刷新才被 settleStaleTask 兜底标成「任务已中断」。用户因此以为
         * 「它还在跑、我还能插话」，补的那句变成了新的一轮。
         *
         * done 之后的帧（重复 done / 收尾 message-update）仍在下面 buffer 收尾里
         * 解析，不会丢。
         */
        while (!doneSeen) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          buffer = parseSseFrames(buffer, handle)
        }
        buffer += decoder.decode()
        // 收尾时可能还剩一帧没有空行结尾（服务端 res.end() 前少写一个换行）
        if (buffer.trim() !== '') parseSseFrames(`${buffer}\n\n`, handle)
      } finally {
        try {
          reader.releaseLock()
        } catch {
          /* 已释放 */
        }
      }
      // 一个事件都没读到 → 让调用方降级；读到过事件（哪怕只有 error）→ 交回累积结果
      return received === 0 ? null : blocks
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', abortFromOutside)
    }
  } catch {
    /*
     * 网络异常 / 被 abort / 读流中途断开：已经收到的部分照样返回——重跑一遍非
     * 流式会把工具调用再执行一次（生图会重复扣费），能保住已有的就用已有的。
     */
    return received === 0 ? null : blocks
  }
}

async function hostJournalImage(journal: Journal): Promise<string | null> {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const res = await fetch('/api/personal-agent/journal/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: journal.title, prompt: journal.imagePrompt, date: journal.date, aspect: '16:9' }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; image?: string }
    if (data.ok && typeof data.image === 'string' && data.image.length > 32) return data.image
  } catch {
    /* 生图不可用：使用程序化封面 */
  }
  return null
}

/* ───────────────────── 期刊：宿主 API 对接 ───────────────────── */

/**
 * 把宿主返回的期刊洗成前端可渲染的 `Journal`（并强制 `origin='host'`）。
 *
 * 宿主落盘的 JSON 也可能被手工改坏 / 是旧版本写的，所以照样过一遍 shared 的
 * `sanitizeJournalRecord`；返回 null 表示这份数据连标题和正文都没有，不能上屏。
 */
function sanitizeHostJournal(raw: unknown): Journal | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const journal = sanitizeJournalRecord(raw, {
    origin: 'host',
    ...(typeof record.model === 'string' && record.model !== '' ? { model: record.model } : {}),
  })
  if (journal === null) return null
  // 宿主只给 date 时补一个可读日期；期号缺省按第一期兜底，界面上不会出现空白行
  if (journal.dateLabel === '' && journal.date !== '') {
    const parsed = new Date(`${journal.date}T00:00:00`)
    if (!Number.isNaN(parsed.getTime())) journal.dateLabel = journalDateLabel(parsed)
  }
  if (journal.issue === '') journal.issue = journalIssue(0)
  return journal
}

/** GET /journal/list：宿主落盘的期刊；读不到（旧宿主 / 网络失败）返回空数组。 */
async function hostJournalList(): Promise<Journal[]> {
  if (isDemoMode()) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch('/api/personal-agent/journal/list', {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const data = (await res.json()) as { ok?: boolean; journals?: unknown }
    if (data.ok === false || !Array.isArray(data.journals)) return []
    const journals: Journal[] = []
    for (const raw of data.journals) {
      const journal = sanitizeHostJournal(raw)
      if (journal !== null) journals.push(journal)
    }
    return journals
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** `/journal/status` 的归一化结果（`rule: null` = 宿主没给，保留本地规则）。 */
interface HostJournalStatus extends Omit<JournalStatus, 'rule'> {
  rule: JournalRule | null
}

/** 把任意来源的触发日志洗成合法列表（宿主 / localStorage 都可能不干净）。 */
function normalizeJournalLogs(raw: unknown): JournalTriggerLog[] {
  if (!Array.isArray(raw)) return []
  const logs: JournalTriggerLog[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0
    if (at <= 0) continue
    logs.push({
      at,
      ok: record.ok === true,
      reason: typeof record.reason === 'string' ? record.reason.slice(0, 300) : '',
      ...(typeof record.journalId === 'string' && record.journalId !== '' ? { journalId: record.journalId } : {}),
    })
  }
  return logs.sort((a, b) => b.at - a.at).slice(0, 40)
}

/** GET /journal/status：宿主规则 / 日志 / 生成中标志；读不到返回 null。 */
async function hostJournalStatus(): Promise<HostJournalStatus | null> {
  if (isDemoMode()) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch('/api/personal-agent/journal/status', {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      ok?: boolean
      rule?: unknown
      logs?: unknown
      generating?: unknown
      lastGeneratedAt?: unknown
    }
    if (data.ok === false) return null
    // 三个字段都没有 = 跑着的宿主还是旧版本（没这条路由的响应体），按读不到处理
    if (data.rule === undefined && data.logs === undefined && data.generating === undefined) return null
    return {
      rule: data.rule === undefined ? null : normalizeJournalRule(data.rule),
      logs: normalizeJournalLogs(data.logs),
      generating: data.generating === true,
      ...(typeof data.lastGeneratedAt === 'number' ? { lastGeneratedAt: data.lastGeneratedAt } : {}),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 合并本地与宿主的触发日志：按 `at + reason` 去重，新的在前，最多 40 条。 */
function mergeJournalLogs(
  local: readonly JournalTriggerLog[],
  remote: readonly JournalTriggerLog[],
): JournalTriggerLog[] {
  const byKey = new Map<string, JournalTriggerLog>()
  for (const log of [...local, ...remote]) byKey.set(`${String(log.at)}:${log.reason}`, log)
  return [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, 40)
}

/** 按 id upsert 一期期刊（宿主推送与本地生成走同一条路，不会出现两个同 id 卡片）。 */
function upsertJournal(journals: readonly Journal[], journal: Journal): Journal[] {
  const index = journals.findIndex((item) => item.id === journal.id)
  if (index < 0) return [journal, ...journals]
  const next = journals.slice()
  next[index] = journal
  return next
}

/** 同一天的两期期刊谁优先：宿主生成优先，其次 generatedAt 更大的。 */
function preferJournal(candidate: Journal, current: Journal): boolean {
  const candidateHost = candidate.origin === 'host' ? 1 : 0
  const currentHost = current.origin === 'host' ? 1 : 0
  if (candidateHost !== currentHost) return candidateHost > currentHost
  return candidate.generatedAt > current.generatedAt
}

/**
 * 合并宿主期刊与本地期刊。
 *
 * 两条规则：
 *  1. 同 id：宿主优先（落盘的那份是权威，可能比本地多图 / 多模型信息）；
 *  2. 同 bot + 同日期：只留一份，`origin='host'` 优先，否则留 generatedAt 更大的。
 *     第二条兜住「宿主不可用时本地先生成了一份，宿主恢复后又生成一份」——只按 id
 *     去重会留下两期同一天的期刊，界面上像重影。
 */
function mergeJournals(local: readonly Journal[], incoming: readonly Journal[]): Journal[] {
  const byId = new Map<string, Journal>()
  for (const journal of local) byId.set(journal.id, journal)
  for (const journal of incoming) byId.set(journal.id, journal)
  const byDay = new Map<string, Journal>()
  for (const journal of byId.values()) {
    const key = `${journal.botId}:${journal.date}`
    const prev = byDay.get(key)
    if (prev === undefined || preferJournal(journal, prev)) byDay.set(key, journal)
  }
  return [...byDay.values()].sort((a, b) => b.generatedAt - a.generatedAt)
}

/** `POST /journal/generate` 的请求体（字段与 shared 的 `JournalFeed` 对齐）。 */
interface JournalGenerateBody {
  botId: string
  botName: string
  botRole: string
  botModel?: BotModel
  date: string
  auto: boolean
  messages: JournalFeed['messages']
  stats: JournalFeedStats
  lastUserMessageAt: number
}

/**
 * POST /journal/generate：让宿主用真实模型生成期刊。
 *
 * 返回 null = 宿主不可用 / 非 2xx / 生成失败 / 返回体洗不出期刊，调用方走本地回退。
 * 超时给 180 秒：宿主可能顺带生图，十几秒掐断会把正常生成误判成失败。
 */
async function hostJournalGenerate(body: JournalGenerateBody): Promise<Journal | null> {
  if (isDemoMode()) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const res = await fetch('/api/personal-agent/journal/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; journal?: unknown; error?: string }
    if (data.ok !== true) return null
    if (data.journal === null || typeof data.journal !== 'object') return null
    const raw = data.journal as Record<string, unknown>
    const journal = sanitizeJournalRecord(data.journal, {
      botId: body.botId,
      date: body.date,
      auto: body.auto,
      origin: 'host',
      ...(typeof raw.model === 'string' && raw.model !== '' ? { model: raw.model } : {}),
    })
    if (journal === null) return null
    if (journal.dateLabel === '' && journal.date !== '') {
      const parsed = new Date(`${journal.date}T00:00:00`)
      if (!Number.isNaN(parsed.getTime())) journal.dateLabel = journalDateLabel(parsed)
    }
    if (journal.issue === '') journal.issue = journalIssue(0)
    return journal
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** `/journal/check` 的结果（宿主判定 + 可能已生成）。 */
interface HostJournalCheckResult {
  ok: boolean
  reason: string
  journalId?: string
}

/**
 * POST /journal/check：宿主按规则判定，满足条件时**在宿主侧**生成期刊。
 *
 * 返回 null = 宿主不可用（旧宿主没有这条路由 / 非 2xx / 网络失败），调用方走本地回退。
 * `ok:false` 是**正常结果**（不满足触发条件），不是失败。
 */
async function hostJournalCheck(now: number): Promise<HostJournalCheckResult | null> {
  if (isDemoMode()) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const res = await fetch('/api/personal-agent/journal/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: unknown; reason?: unknown; journalId?: unknown }
    if (typeof data.ok !== 'boolean') return null
    return {
      ok: data.ok,
      reason: typeof data.reason === 'string' && data.reason !== ''
        ? data.reason
        : (data.ok ? '宿主已生成期刊' : '宿主未生成期刊'),
      ...(typeof data.journalId === 'string' && data.journalId !== '' ? { journalId: data.journalId } : {}),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** POST /journal/rule：把规则同步给宿主调度器（失败静默，本地规则仍然生效）。 */
async function hostJournalRule(rule: JournalRule, lastUserMessageAt: number): Promise<void> {
  if (isDemoMode()) return
  try {
    await fetch('/api/personal-agent/journal/rule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule, lastUserMessageAt }),
    })
  } catch {
    /* 宿主没起来：规则留在本地，下次挂载再同步 */
  }
}

/** POST /journal/feed：把最近 48 小时的素材同步给宿主（失败静默，下次消息变化再试）。 */
async function hostJournalFeed(feed: JournalFeed): Promise<void> {
  if (isDemoMode()) return
  try {
    await fetch('/api/personal-agent/journal/feed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(feed),
    })
  } catch {
    /* 同上：素材留在本地，不阻塞任何交互 */
  }
}

/**
 * 本地规则判定（**只判定，不生成**）。
 *
 * 宿主可用时真正的判定在宿主（`/journal/check`）；这里只在宿主不可用（或演示页）时
 * 兜底。它同时给同步签名的 `runJournalCheck` 一个即时反馈——调用方（规则面板 / 侧栏）
 * 不能等 HTTP 回来才显示原因。
 */
function evaluateJournalRule(state: AppState, nowMs: number): { ok: boolean; reason: string; journalId?: string } {
  const rule = normalizeJournalRule(state.settings.journalRule)
  if (!rule.enabled) return { ok: false, reason: '日记规则已关闭' }
  const now = new Date(nowMs)
  const hour = now.getHours()
  const minute = now.getMinutes()
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (hour < rule.startHour || hour >= rule.endHour) {
    return { ok: false, reason: `当前 ${clock} 不在 ${String(rule.startHour)}:00–${String(rule.endHour)}:00 触发窗内` }
  }
  const idle = nowMs - state.lastUserMessageAt
  if (idle < rule.idleMinutes * 60_000) {
    return {
      ok: false,
      reason: `距上次用户主动消息仅 ${String(Math.max(0, Math.round(idle / 60_000)))} 分钟，未满 ${String(rule.idleMinutes)} 分钟`,
    }
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const dateKey = journalDateKey(yesterday)
  const exists = state.journals.find((journal) => journal.botId === MAIN_BOT_ID && journal.date === dateKey)
  if (exists !== undefined) return { ok: false, reason: `昨天的日记已生成（${exists.title}）`, journalId: exists.id }
  return {
    ok: true,
    reason: `满足条件：${String(rule.startHour)}:00–${String(rule.endHour)}:00 且已静默 ${String(Math.round(idle / 60_000))} 分钟，正在生成昨天的期刊`,
  }
}

/** 撤回后插进消息流的系统提示文案。 */
const RECALL_NOTICE_TEXT = '你撤回了一条消息'

/**
 * 撤回计划：算出「删哪些消息、记忆窗口在哪、给宿主报什么」。
 *
 * 纯函数（不碰 DOM / fetch / React），便于 node 侧自测——范围边界是这套功能里最
 * 容易写错的地方：多删一条就是吞掉用户的下一轮，少删一条会留下「无头回复」。
 */
export interface RecallPlan {
  /** 要删掉的消息 id（含被撤回的那条用户消息、它之后的回复与 pending 占位）。 */
  removedIds: string[]
  /** 记忆删除窗口起点（被撤回用户消息的 at）。 */
  from: number
  /** 记忆删除窗口终点（撤回范围内最后一条消息的 at）。 */
  to: number
  /**
   * 这一轮涉及的全部 bot：私聊恒为这一个 bot；群聊里可能有多个成员接话，
   * 记忆删除与侧栏摘要重算都按这个集合圈（只删这一轮说的话留下的东西）。
   */
  botIds: string[]
  /** 撤回后要插回列表的系统提示（落在被删那段原来的位置上）。 */
  notice: Message
  botId: string
  roomId?: string
  /** 通知宿主用的纯文本：被撤回那条用户消息的正文。 */
  text: string
  /** 通知宿主用的时间戳：被撤回那条用户消息的 at。 */
  at: number
  /** 这条用户消息在 host 侧的原始 id（新消息才有；撤回靠它精确定位）。 */
  hostMessageId?: string
}

/**
 * 从消息列表算出一次撤回的范围。不是用户消息 / 找不到这条消息时返回 null。
 *
 * 范围规则：
 *  · 起点 = 这条用户消息；
 *  · 终点 = 它之后**下一条用户消息之前**——下一条用户消息之后属于新的一轮，不跟着撤；
 *  · 会话边界：私聊按 botId 圈，群聊按 roomId 圈（同一个群里接话的 bot 可能不止一个，
 *    它们的回复都属于这一轮）；别的会话的消息直接跳过；
 *  · 区间内的 bot 回复、system 提示、还在生成的 pending 占位全都算在内。
 */
export function planRecall(messages: Message[], messageId: string): RecallPlan | null {
  const target = messages.find((message) => message.id === messageId)
  // 只有用户自己发的消息能撤回：bot / system 消息没有「撤回」这个语义
  if (target === undefined || target.role !== 'user') return null
  const startIndex = messages.findIndex((message) => message.id === messageId)
  if (startIndex < 0) return null

  const roomId = target.roomId
  // 群聊：同 roomId 就是同一段会话（发言人 botId 各不相同）；私聊：同 botId 且不带 roomId
  const inScope = (message: Message): boolean => (roomId !== undefined
    ? message.roomId === roomId
    : message.botId === target.botId && message.roomId === undefined)

  const removedIds: string[] = [messageId]
  const botIds = new Set<string>([target.botId])
  let lastAt = target.at
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (!inScope(message)) continue
    // 下一条用户消息是硬边界
    if (message.role === 'user') break
    removedIds.push(message.id)
    botIds.add(message.botId)
    lastAt = Math.max(lastAt, message.at)
  }

  return {
    removedIds,
    from: target.at,
    to: lastAt,
    botIds: [...botIds],
    notice: {
      id: shortId('msg'),
      botId: target.botId,
      ...(roomId !== undefined ? { roomId } : {}),
      role: 'system',
      at: Date.now(),
      blocks: [{ type: 'text', text: RECALL_NOTICE_TEXT }],
      source: 'control',
    },
    botId: target.botId,
    ...(roomId !== undefined ? { roomId } : {}),
    text: blocksToText(target.blocks),
    at: target.at,
    ...(target.hostId !== undefined ? { hostMessageId: target.hostId } : {}),
  }
}

/**
 * 把撤回计划落到 state 上（纯函数，同样为了可自测）。
 *
 * 做四件事：删掉范围内的消息、在原位置插一条系统提示、删掉记忆窗口内这一轮涉及的
 * bot 记下的条目、重算侧栏摘要与「最后一次用户发言时间」（否则撤完侧栏还挂着被撤掉
 * 那句话，日记的「静默多久」判据也会停留在被撤回的那条消息上）。
 */
export function applyRecall(prev: AppState, plan: RecallPlan): AppState {
  const removed = new Set(plan.removedIds)
  const participants = new Set(plan.botIds)
  const messages: Message[] = []
  let placed = false
  for (const message of prev.messages) {
    if (!removed.has(message.id)) {
      messages.push(message)
      continue
    }
    // 系统提示落在这段对话原来的位置上，读起来就是「这里少了点什么」
    if (!placed) {
      messages.push(plan.notice)
      placed = true
    }
  }
  const lastOf = (pick: (message: Message) => boolean): Message | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (pick(messages[index])) return messages[index]
    }
    return undefined
  }
  const bots = prev.bots.map((bot) => {
    if (!participants.has(bot.id)) return bot
    const last = lastOf((message) => message.botId === bot.id)
    return {
      ...bot,
      lastMessage: last !== undefined ? truncate(blocksToText(last.blocks)) : '',
      lastAt: last?.at,
    }
  })
  const rooms = prev.rooms.map((room) => {
    if (room.id !== plan.roomId) return room
    const last = lastOf((message) => message.roomId === room.id)
    return {
      ...room,
      lastMessage: last !== undefined ? truncate(blocksToText(last.blocks)) : '',
      lastAt: last?.at,
    }
  })
  // 记忆窗口：这一轮的时间跨度内、参与这一轮的 bot 记下的条目
  const memories = prev.memories.filter((entry) => !(participants.has(entry.botId)
    && entry.createdAt >= plan.from
    && entry.createdAt <= plan.to))
  /*
   * 任务记录同理：这一轮的任务（按开始时间落在同一窗口）一并撤回。
   * 否则对话已经撤了，任务记录里还挂着一段「已删除的对话」的详情。
   */
  const tasks = prev.tasks.filter((task) => !(participants.has(task.botId)
    && task.startedAt >= plan.from
    && task.startedAt <= plan.to))
  const lastUserMessageAt = messages
    .filter((message) => message.role === 'user')
    .reduce((max, message) => Math.max(max, message.at), 0)
  return { ...prev, messages, bots, rooms, memories, tasks, lastUserMessageAt }
}

/**
 * 尽力通知宿主「这一轮被撤回了」。
 *
 * 与其它 host 调用不同，这里**不等待、不反馈**：撤回的第一性要求是本地立刻干净，
 * 宿主那一半只是让模型之后的上下文里也不再出现这段对话。所以路由不存在、返回
 * 4xx/5xx、网络断了一律静默——用户看到的本地结果不受任何影响。
 *
 * body 带 botId / text / at / messageId：messageId 是 host 给这条用户消息分配的
 * 原始 id（新消息才有），宿主优先按它精确定位；旧消息没有 id 时才退回 text + at。
 */
async function hostRecallTurn(botId: string, text: string, at: number, bot?: Bot, messageId?: string): Promise<void> {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      await fetch('/api/personal-agent/recall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        /*
         * 带上 bot 档案：宿主在会话不在内存里时会 resume；只传 botId 会让它
         * 用默认「助手 / 通用助手」档案重建提示词，撤回顺手把 Bot 身份改掉。
         */
        body: JSON.stringify({
          botId,
          text,
          at,
          ...(messageId !== undefined ? { messageId } : {}),
          ...(bot !== undefined
            ? {
              bot: {
                id: bot.id,
                name: bot.name,
                role: bot.role,
                description: bot.description,
                instructions: bot.instructions,
                model: bot.model,
              },
              permission: bot.permission ?? 'full',
            }
            : {}),
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /* 宿主没挂这条路由 / 撤回失败：本地已经撤干净，静默忽略 */
  }
}

export function PersonalProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AppState>(() => loadState())
  const [ui, setUi] = useState<PersonalUi>(() => loadUi(loadState()))
  const stateRef = useRef(state)
  stateRef.current = state
  const uiRef = useRef(ui)
  uiRef.current = ui
  const timersRef = useRef<number[]>([])
  /**
   * 当前这通实时会话。
   *
   * 放 ref 而不是 state：`RealtimeCall` 是命令式对象，持有 WebSocket、麦克风与
   * AudioContext；把它塞进 state 会让每次 setUi 都重建一次连接（等于挂断重拨）。
   */
  const callRef = useRef<RealtimeCall | null>(null)
  /** 未定稿的流式字幕缓冲（见 CALL_DRAFT_FLUSH_MS）。 */
  const callDraftRef = useRef({ bot: '', thinking: '' })
  const callDraftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 这一轮是否已经开始收到「语音转写」（bot_transcript_*）。
   *
   * 文本模态（bot_text_delta）与语音转写是同一句话的两份来源，内容几乎相同。
   * 谁先到不确定，所以定一条规则：**音频转写优先**——它才是「用户实际听到的话」；
   * 音频转写一旦开始，就丢掉之前由文本模态攒的字幕，否则同一句话会出现两遍。
   */
  const callAudioTranscriptRef = useRef(false)
  /**
   * 待配对的**用户**轮次占位（见 call-turns.ts 的文件头）。
   *
   * 服务端 ASR 是异步的：`user_transcript` 经常晚于 `bot_transcript_done` 到达，
   * 按到达顺序 append 就会变成「Bot 先答、用户后问」——用户实测截图里就是这个错序。
   *
   * 做法：`speech_stopped`（一定早于模型响应）时先分配一个落库序号占位，
   * 等转写到了按 `item_id` 配对补上文本，最后按序号排序。
   */
  const callPendingUsersRef = useRef<PendingUserTurn[]>([])
  /** 通话内单调递增的落库序号（每通电话从 0 开始）。 */
  const callSeqRef = useRef(0)
  /**
   * 当前这通电话在对话流里的**段 id**（见 `MessageBlock` 的 `call-segment`）。
   *
   * 转写与产物现在都以**普通消息**实时进对话流，靠它标记「属于同一通电话」；
   * 渲染层据此把整段收起 / 展开（`ui.collapsedCallSegments`）。`null` = 没有通话。
   */
  const callSegmentRef = useRef<string | null>(null)
  /** 段内已经落了消息几条（折叠条上显示「N 条」）。 */
  const callSegmentTurnsRef = useRef(0)
  /**
   * 段内消息 id → 落库序号。
   *
   * 只用于**排序**（见 `insertCallMessage`）：ASR 是异步的，用户那句常常晚于 Bot 的
   * 转写到达，按到达顺序追加会变成「Bot 先答、用户后问」。序号不进 `Message` 字段——
   * 那要改类型契约，而它是通话期间的临时状态：页面一刷新通话就结束了，落下来的
   * 消息顺序已经是正确的，不需要再排。
   */
  const callMessageSeqRef = useRef<Map<string, number>>(new Map())
  /**
   * 宿主期刊检查是否在飞（防止 30 秒定时器叠加请求）。
   *
   * 宿主 `/journal/check` 满足条件时会顺带生成期刊（模型 + 生图），一次请求可能跑
   * 几十秒；不加这个标志时下一次 tick 会再发一条，前端会白白堆起一串请求。
   */
  const journalCheckInFlightRef = useRef(false)
  /**
   * 正在跑的回复轮次（输入框停止键的作用对象）。
   *
   * 放 ref 而不是 state：它持的是 AbortController 与「本轮已被停止」这类命令式
   * 状态，塞进 state 会让每个流式事件都重渲染一次；而「要不要显示停止键」本来
   * 就由 pending 消息决定，不需要再存一份。
   */
  const runningReplyTurnsRef = useRef<Set<RunningReplyTurn>>(new Set())
  /**
   * 停止键的实际实现（由下面的 `stopReply` 每次渲染后灌进来）。
   *
   * 为什么要转一手：`sendMessage` 需要调用它——用户在运行中发「停止」时必须走
   * 真停止，而不是把这句话投给宿主当 steer。但 `sendMessage` 定义在
   * `stopReply` 之前，直接引用会踩 TDZ（`Cannot access before initialization`），
   * 所以用 ref 桥接。
   */
  const stopReplyRef = useRef<() => void>(() => {})
  /** 已排期、尚未启动的群聊成员回复（见 ScheduledReply）。 */
  const scheduledRepliesRef = useRef<Set<ScheduledReply>>(new Set())
  /**
   * 历史索引同步的上次消息指纹（见下面的同步 effect）。
   *
   * 只依赖 state.messages 还不够：有些 setState 会重建 messages 数组但内容没变，
   * 指纹相同就直接跳过，避免同一批消息反复 POST。
   */
  const lastHistorySyncRef = useRef<string>('')
  /** 历史索引同步的防抖 timer（组件卸载时必须清掉，不能把请求带进已卸载的树）。 */
  const historySyncTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const handle = window.setTimeout(() => {
      try {
        /*
         * 落盘前剥掉三样东西：
         *  · mergedSegments —— 只在流式期间有用（刷新后不会再有 message-update），
         *    存下来等于把同一份 blocks 写两遍，长会话里会把 localStorage 配额翻倍；
         *  · pagesByBot —— Pages 的权威源是宿主（每次打开右栏重新拉），前端这份只是
         *    运行时缓存，存了也不会被 normalizeState 恢复，白白占空间；
         *  · assignmentsByBot —— 任务与委派的权威源同样是宿主（切 Bot 立即重拉），
         *    存旧快照只会让刷新后短暂显示过期任务。
         */
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state, (key, value) => (
          key === 'mergedSegments' || key === 'pagesByBot' || key === 'assignmentsByBot' ? undefined : value
        )))
        /*
         * 名册变了要通知侧栏（2026-11）：操作间 → 记忆的二级菜单里有一组
         * 「Bot」子项，它读的就是这份 localStorage。侧栏是常驻组件、不会
         * 因为 Bot 模式开关而重新挂载，所以必须有一条显式通道——否则新建
         * 一个 Bot 之后，切回 Work 的记忆菜单里要等到下次刷新才出现它。
         * 事件在 setItem 之后发：监听方重读时拿到的已是新值。
         */
        window.dispatchEvent(new Event(BOT_ROSTER_EVENT))
      } catch {
        /* 配额满：只影响持久化 */
      }
    }, 180)
    return () => window.clearTimeout(handle)
  }, [state])

  useEffect(() => {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({
        selectedBotId: ui.selectedBotId,
        sidebarCollapsed: ui.sidebarCollapsed,
        collapsedSections: ui.collapsedSections,
        readAt: ui.readAt,
        rightPanelOpen: ui.rightPanelOpen,
        rightPanelWidth: ui.rightPanelWidth,
        chatWidth: ui.chatWidth,
        rightTab: ui.rightTab,
      }))
    } catch {
      /* ignore */
    }
  }, [ui.selectedBotId, ui.sidebarCollapsed, ui.collapsedSections, ui.readAt, ui.rightPanelOpen, ui.rightPanelWidth, ui.chatWidth, ui.rightTab])

  /*
   * 历史消息增量同步到宿主索引（第 3 步）。
   *
   * 宿主 POST /api/personal-agent/history/index 按消息 id 去重，所以前端可以放心
   * 重复发送「最近窗口」而不是维护精确游标：每次消息变化后防抖 1500ms，把所有有
   * 私聊消息的 Bot 各发一次（每个 Bot 最多最近 500 条）。
   *
   * 三个细节：
   *  · 指纹在 timer 触发时才计算：流式期间 state.messages 每个 delta 都会换引用，
   *    每次渲染都扫一遍全部消息（还要拼接长文本）会明显加重主线程；防抖后只算一次；
   *  · 指纹相同直接跳过：其他 state 变化引起的 messages 重建不该发空请求；
   *  · 失败静默：历史检索是增强项，宿主没升级 / 网络抖动都不弹 toast。
   */
  useEffect(() => {
    if (isDemoMode()) return undefined
    if (historySyncTimerRef.current !== null) window.clearTimeout(historySyncTimerRef.current)
    historySyncTimerRef.current = window.setTimeout(() => {
      historySyncTimerRef.current = null
      const latestMessages = stateRef.current.messages
      const fingerprint = historySyncFingerprint(latestMessages)
      if (fingerprint === lastHistorySyncRef.current) return
      lastHistorySyncRef.current = fingerprint
      const groups = collectHistoryIndexGroups(latestMessages)
      // 每个 Bot 一次请求：宿主按 botId 存索引，分开送才能各自去重。
      for (const group of groups) void pushHistoryIndex(group.botId, group.messages)
    }, HISTORY_SYNC_DEBOUNCE_MS)
    return undefined
  }, [state.messages])

  /*
   * 正在看的会话收到新回复时直接算已读。
   *
   * 否则用户盯着对话流看回复，侧栏那边却一直亮着「未读」——提示一旦和眼睛看到的
   * 事实矛盾，就变成了噪音。这里只把**当前选中会话**的 readAt 推到最新消息时刻，
   * 其他会话照旧保持未读。
   */
  useEffect(() => {
    const current = stateRef.current
    const selectedRoomId = uiRef.current.selectedRoomId
    const selectedBotId = uiRef.current.selectedBotId
    const key = selectedRoomId !== null ? `room:${selectedRoomId}` : `bot:${selectedBotId}`
    let latest = 0
    for (const message of current.messages) {
      const match = selectedRoomId !== null
        ? message.roomId === selectedRoomId
        : message.botId === selectedBotId && message.roomId === undefined
      if (match && message.at > latest) latest = message.at
    }
    if (latest <= (uiRef.current.readAt[key] ?? 0)) return
    setUi((prev) => ({ ...prev, readAt: { ...prev.readAt, [key]: latest } }))
  }, [state.messages])

  /*
   * 启动对账：刷新时被收口的僵尸任务，宿主那边也要停。
   *
   * 与 normalizeState 的消息 `pending` 清理同一口径——页面重载后前端已经不在
   * 监听那一轮了，让它继续跑只会产生「无主消息」（界面显示任务已停止，输出却
   * 还在往对话流里冒）。409 = 宿主本来就没在跑，不算错误。
   *
   * 名单由 settleStaleTask 在加载时填（normalizeState 是纯函数，不能发请求），
   * 这里取走即清空，只发一次。
   */
  useEffect(() => {
    if (isDemoMode()) return
    const botIds = [...staleTaskBotIds]
    staleTaskBotIds.clear()
    if (botIds.length === 0) return
    void Promise.all(botIds.map((botId) => fetch('/api/personal-agent/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId }),
    }).catch(() => null)))
  }, [])

  /*
   * 启动时与宿主同步期刊（只跑一次）。
   *
   *  · `/journal/list`：宿主落盘的期刊是权威（刷新 / 清缓存 / 换标签页都不该丢），
   *    合并时按 id 去重、宿主优先；
   *  · `/journal/status`：把宿主规则与触发日志并回来，规则面板才有内容。
   *
   * 只依赖挂载：之后的新期刊走 SSE 与本地动作，不需要反复拉列表。
   */
  useEffect(() => {
    if (isDemoMode()) return undefined
    let alive = true
    void (async () => {
      const journals = await hostJournalList()
      if (!alive) return
      if (journals.length > 0) {
        setState((prev) => ({ ...prev, journals: mergeJournals(prev.journals, journals) }))
      }
      const status = await hostJournalStatus()
      if (!alive || status === null) return
      setState((prev) => ({
        ...prev,
        settings: {
          ...prev.settings,
          journalRule: status.rule ?? prev.settings.journalRule,
        },
        journalLogs: mergeJournalLogs(prev.journalLogs, status.logs),
        // 规则面板据此显示「宿主正在生成 / 上次生成时间」
        journalStatus: {
          generating: status.generating,
          ...(status.lastGeneratedAt !== undefined ? { lastGeneratedAt: status.lastGeneratedAt } : {}),
        },
      }))
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
    if (historySyncTimerRef.current !== null) {
      window.clearTimeout(historySyncTimerRef.current)
      historySyncTimerRef.current = null
    }
    // 卸载（切到 Work 模式 / 热更新）时必须把通话掐掉：否则 WebSocket、麦克风与
    // AudioContext 会留在这个已经没人渲染的组件树里继续跑，用户会听见「幽灵通话」。
    const session = callRef.current
    callRef.current = null
    if (session !== null) void session.stop()
    if (callDraftTimerRef.current !== null) clearTimeout(callDraftTimerRef.current)
  }, [])

  const later = useCallback((ms: number, run: () => void): void => {
    const timer = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((id) => id !== timer)
      run()
    }, ms)
    timersRef.current.push(timer)
  }, [])

  const toast = useCallback((text: string): void => {
    setUi((prev) => ({ ...prev, toast: text }))
    /*
     * 停留时间按文案长度给：固定 2.6 秒对「Live 供应商……还没配：在设置页里粘贴
     * API Key，或到 DSH 凭据里补上」这种五六十字的报错根本读不完。基础 2.2 秒，
     * 每字加 45ms，封顶 9 秒——短提示仍然干脆，长报错能停下来读完再消失。
     */
    const linger = Math.min(9_000, Math.max(2_600, 2_200 + text.length * 45))
    later(linger, () => setUi((prev) => (prev.toast === text ? { ...prev, toast: null } : prev)))
  }, [later])

  /**
   * 追加一条消息（并按需更新侧栏摘要 / 未读）。
   *
   * @param insert 语音通话段内的消息要带上它：消息按落库序号插到段里的正确位置，
   *   而不是追加到末尾（理由见 `insertCallMessage`）。缺省 = 追加。
   */
  const appendMessage = useCallback((message: Message, insert?: { segment: string; seq: number }): void => {
    setState((prev) => {
      const bots = prev.bots.map((bot) => {
        if (bot.id !== message.botId) return bot
        /*
         * 段内消息可能插到**更早**的位置（ASR 迟到）：此时它不该抢走侧栏摘要，
         * 否则侧栏会显示一条比当前最新消息还早的内容。
         */
        const newer = bot.lastAt === undefined || message.at >= bot.lastAt
        return {
          ...bot,
          lastMessage: newer ? truncate(blocksToText(message.blocks)) : bot.lastMessage,
          lastAt: newer ? message.at : bot.lastAt,
          unread: message.role === 'bot' && !message.pending && uiRef.current.selectedBotId !== bot.id && !message.roomId
            ? bot.unread + 1
            : bot.unread,
        }
      })
      const rooms = prev.rooms.map((room) => (room.id === message.roomId
        ? {
          ...room,
          lastMessage: room.lastAt === undefined || message.at >= room.lastAt ? truncate(blocksToText(message.blocks)) : room.lastMessage,
          lastAt: room.lastAt === undefined || message.at >= room.lastAt ? message.at : room.lastAt,
          /*
           * 正在看这个群时不加未读：用户在群里发消息，成员依次接话，侧栏冒出一个
           * 红色角标说他「有 3 条未读」——而他正盯着这几条。只有会话不在前台
           * （切到别的群 / 别的 Bot / 期刊页）才累计。
           */
          unread: message.role === 'bot' && !message.pending && uiRef.current.selectedRoomId !== room.id
            ? room.unread + 1
            : room.unread,
        }
        : room))
      const messages = insert === undefined
        ? [...prev.messages, message]
        : insertCallMessage(prev.messages, message, insert.segment, insert.seq, callMessageSeqRef.current)
      return { ...prev, bots, rooms, messages }
    })
  }, [])

  /**
   * 本次页面会话里已经吸收过哪些宿主创建的 Bot（按 id）。
   *
   * 只用 state 去重不够：SSE 事件与启动拉取可能在同一帧到达，那时 `stateRef`
   * 还没更新，两次合并都会把同一条记录算成「新增」；而 `appendMessage` 不像
   * setState 那样有 prev 可查，会落出两条一模一样的欢迎消息。用 ref 兜住这个
   * 窗口——它只活在这一份页面会话里，刷新后由 state 自己接管去重。
   */
  const absorbedBotIdsRef = useRef<Set<string>>(new Set())
  /**
   * 把宿主创建的子 Bot 吸收进本地状态（SSE `bot-created` 与启动拉取共用）。
   *
   * 为什么不是简单往 `state.bots` 里 push：新 Bot 的欢迎消息必须和它一起落地。
   * 分两次 setState 时，侧栏会先出现一个没有摘要的空壳（头像下面一片空白），
   * 下一帧才补上欢迎语——用户看到的就是「刚建好的 Bot 抽了一下」。
   *
   * 欢迎消息用 `firstBotMessage` 本地生成，不调模型：主 Bot 在建它的那一轮里
   * 已经回过话了，再让新 Bot 自我介绍一次等于同一件事说两遍，还要多付一次模型
   * 调用；而「侧栏别空着」这个目的，一句本地文案就够。
   */
  const absorbCreatedBots = useCallback((records: readonly CreatedBotRecord[]): void => {
    const merged = mergeCreatedBots(stateRef.current.bots, records)
    /*
     * 分组兜底：宿主（模型）给的 `group_id` 可能是它自己编的。前端侧栏是按分组
     * 遍历 Bot 的，落进一个不存在的分组就等于「一个分组都进不去」——建好了却
     * 看不见。退回默认组至少让它出现在列表里，用户还能自己拖走。
     */
    const groupIds = new Set(stateRef.current.groups.map((group) => group.id))
    const fresh = merged.added
      .filter((bot) => !absorbedBotIdsRef.current.has(bot.id))
      .map((bot) => (groupIds.has(bot.groupId) ? bot : { ...bot, groupId: DEFAULT_GROUP_ID }))
    if (fresh.length === 0) return
    for (const bot of fresh) absorbedBotIdsRef.current.add(bot.id)
    setState((prev) => {
      // 再用 prev 过滤一次：真正落进 state 的以最新一份为准
      const insert = fresh.filter((bot) => !prev.bots.some((item) => item.id === bot.id))
      return insert.length === 0 ? prev : { ...prev, bots: [...prev.bots, ...insert] }
    })
    for (const bot of fresh) {
      appendMessage({
        id: shortId('msg'),
        botId: bot.id,
        role: 'bot',
        at: Date.now(),
        blocks: firstBotMessage(bot),
        source: 'proactive',
      })
    }
    const only = fresh[0]
    toast(fresh.length === 1 && only !== undefined
      ? `主 Bot 创建了新的子 Bot「${only.name}」`
      : `主 Bot 创建了 ${fresh.length} 个新的子 Bot`)
  }, [appendMessage, toast])

  const replaceMessage = useCallback((id: string, blocks: MessageBlock[]): void => {
    setState((prev) => ({
      ...prev,
      messages: prev.messages.map((message) => (message.id === id ? { ...message, blocks, pending: false } : message)),
    }))
  }, [])

  /* ───────────────────────── 任务记录（每轮一条） ───────────────────────── */

  /** 改一条任务记录（函数式，避免闭包读到旧 state）。 */
  const patchTask = useCallback((id: string, patch: (task: TaskRecord) => TaskRecord): void => {
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((task) => (task.id === id ? patch(task) : task)),
    }))
  }, [])

  /**
   * 开一条任务记录（replyAsBot 开头调用）。
   *
   * 标题在开始时先用用户请求生成，完成时如果只是寒暄再拿 bot 回复兜底——
   * 任务列表要**立刻**有一行可见，不能等整轮跑完才出现。
   */
  const createTaskRecord = useCallback((
    bot: Bot,
    text: string,
    target: { roomId?: string },
    images: ChatImage[],
  ): string => {
    const id = shortId('task')
    const hasImages = images.length > 0
    const prompt = text.trim() !== '' ? text.trim() : (hasImages ? '[图片]' : '')
    const at = Date.now()
    const record: TaskRecord = {
      id,
      botId: bot.id,
      ...(target.roomId !== undefined ? { roomId: target.roomId } : {}),
      title: autoTaskTitle(prompt, hasImages),
      prompt,
      status: 'running',
      startedAt: at,
      steps: [{ at, kind: 'start', title: '开始处理', ...(prompt !== '' ? { detail: prompt.slice(0, 300) } : {}) }],
    }
    setState((prev) => ({ ...prev, tasks: [record, ...prev.tasks].slice(0, MAX_TASK_RECORDS) }))
    return id
  }, [])

  /**
   * 把一次工具调用写进任务详情。
   *
   * 工具事件会来很多次（running → ok），按 callId 就地更新同一步；同一个工具名
   * 调用多次时不会互相覆盖。
   *
   * `task_state` 是例外：它是「任务概览」的写入通道，不是执行轨迹。只更新
   * `TaskRecord.overview`，不往 steps 里塞一行「task_state」——用户看不懂，
   * 任务概览卡左栏也只需要任务清单本身。
   */
  const upsertTaskToolStep = useCallback((taskId: string, run: ToolRun): void => {
    if (run.name === TASK_STATE_TOOL) {
      /*
       * running 事件只有 args、ok 事件才带 result：两次都走同一份逻辑，后到的
       * 覆盖前面的（以最新进度为准）；解析不出有效 steps 时保留旧清单。
       */
      const overview = overviewStepsFromArgs(run.args) ?? overviewStepsFromResult(run.result)
      if (overview !== null) patchTask(taskId, (task) => ({ ...task, overview }))
      return
    }
    patchTask(taskId, (task) => {
      const detail = run.status === 'running'
        ? (run.args ?? '')
        : (run.result ?? run.args ?? '')
      const step: TaskRecordStep = {
        at: run.endedAt ?? run.startedAt,
        id: run.id,
        kind: 'tool',
        title: run.name,
        ...(detail !== '' ? { detail: detail.slice(0, 220) } : {}),
        status: run.status,
      }
      const index = task.steps.findIndex((item) => item.kind === 'tool' && item.id === run.id)
      if (index < 0) return { ...task, steps: pushTaskStep(task.steps, step) }
      const steps = task.steps.slice()
      // 保留最初的 startedAt 排序位置，只刷新状态与结果文本。
      steps[index] = { ...step, at: steps[index].at }
      return { ...task, steps }
    })
  }, [patchTask])

  /**
   * 把一条过程消息的文字写进任务记录（任务详情卡的过程时间线正文）。
   *
   * 用户口径（2026-11-02）：「Work 模式那种表达很舒服，搬到任务详情」——Work 的
   * 回合过程是「图标 + 标题 + 一段自然语言」，正文就来自模型每段 progress 消息。
   * 这里按 host 消息 id 去重：同一条消息的 message-update 会反复到达，只更新那一步
   * 的正文，不新增步骤。
   *
   * final 消息不进这里：它的文字是「最终回复」，收口时单独取（lastTextOfBlocks），
   * 重复进时间线会让同一段话在卡里出现两遍。
   */
  const upsertTaskTextStep = useCallback((taskId: string, hostId: string, text: string, kind: BotMessageKind): void => {
    const detail = text.trim()
    if (detail === '') return
    const title = kind === 'finding'
      ? '发现'
      : kind === 'need-input'
        ? '询问'
        : kind === 'approval'
          ? '待确认'
          : kind === 'connector-suggest'
            ? '建议'
            : '分析'
    patchTask(taskId, (task) => {
      const index = task.steps.findIndex((item) => item.kind === 'text' && item.id === hostId)
      const step: TaskRecordStep = {
        at: index >= 0 ? task.steps[index].at : Date.now(),
        id: hostId,
        kind: 'text',
        title,
        detail: detail.slice(0, 2000),
      }
      if (index < 0) return { ...task, steps: pushTaskStep(task.steps, step) }
      const steps = task.steps.slice()
      steps[index] = step
      return { ...task, steps }
    })
  }, [patchTask])

  /**
   * 收口一条任务记录。
   *
   * 这一轮**没有任何实质动作**（没有工具调用、没有过程说明、没有产出）时整条丢弃：
   * 用户口径（2026-11-02）「不是每一个对话都需要给一个任务记录」——纯寒暄 /
   * 一句问答不该在任务记录卡里留一条空壳。任务详情卡展示的是过程时间线（工具 +
   * 过程文字），没有过程就没有可看的内容。
   *
   * @param status done / stopped / failed（stopped = 用户主动停止，是正常操作，不是出错）
   * @param blocks 这一轮最终落地的全部 blocks（用来汇总工具、产出数与最终回复）
   * @param error 失败 / 停止原因
   */
  const finishTaskRecord = useCallback((taskId: string, status: 'done' | 'stopped' | 'failed', blocks: MessageBlock[], error?: string): void => {
    const runs = toolRunsOfBlocks(blocks)
    /** 把一条任务记录补成收口态（纯函数：setState 里按 id 应用）。 */
    const applyFinish = (task: TaskRecord): TaskRecord => {
      // 把最终工具状态补进去（收口时可能还有 running 没被 update 的）
      let steps = task.steps.slice()
      for (const run of runs) {
        // task_state 只写 overview，不进执行轨迹（见 upsertTaskToolStep）
        if (run.name === TASK_STATE_TOOL) continue
        const detail = run.result ?? run.args ?? ''
        const step: TaskRecordStep = {
          at: run.endedAt ?? run.startedAt,
          id: run.id,
          kind: 'tool',
          title: run.name,
          ...(detail !== '' ? { detail: detail.slice(0, 220) } : {}),
          status: run.status,
        }
        const index = steps.findIndex((item) => item.kind === 'tool' && item.id === run.id)
        if (index < 0) steps = pushTaskStep(steps, step)
        else steps[index] = { ...step, at: steps[index].at }
      }
      /*
       * 收口时还挂着 running 的步骤一律标中断：宿主不会再补结束事件，留着就是
       * 时间线上永远转圈的一步。停止与失败都适用（done 时出现 running 说明宿主
       * 漏发了 update，同样不能留）。
       */
      steps = steps.map((step) => (step.status === 'running' ? { ...step, status: 'error' as const } : step))
      const reply = lastTextOfBlocks(blocks)
      const title = isTrivialTaskPrompt(task.prompt) && reply !== ''
        ? autoTaskTitle(reply)
        : task.title
      const endedAt = Date.now()
      const endStep: TaskRecordStep = {
        at: endedAt,
        kind: 'end',
        title: status === 'done' ? '任务完成' : status === 'stopped' ? '任务已停止' : '任务失败',
        ...(error !== undefined && error !== '' ? { detail: error.slice(0, 300) } : {}),
        /*
         * 停止不设 status：时间线上的圆点保持中性灰，与状态 pill 的灰一致。
         * 标成 'error' 会把它渲染成红色，看起来像这一轮出了错。
         */
        ...(status === 'done' ? { status: 'ok' as const } : status === 'failed' ? { status: 'error' as const } : {}),
      }
      return {
        ...task,
        title,
        status,
        endedAt,
        durationMs: Math.max(0, endedAt - task.startedAt),
        steps: [...steps, endStep],
        outputCount: outputCountOfBlocks(blocks),
        ...(reply !== '' ? { reply: reply.slice(0, 500) } : {}),
        ...(error !== undefined && error !== '' ? { error: error.slice(0, 300) } : {}),
      }
    }
    setState((prev) => {
      const target = prev.tasks.find((task) => task.id === taskId)
      if (target === undefined) return prev
      /*
       * 这一轮没有任何实质动作（工具 / 过程说明 / 产出）→ 纯寒暄，整条丢弃。
       * 用户口径（2026-11-02）：「不是每一个对话都需要给一个任务记录」——任务
       * 记录卡只留「做了事」的轮次，聊天不必留一条空壳。
       */
      const hasSubstance = target.steps.some((step) => step.kind === 'tool' || step.kind === 'text' || step.kind === 'output')
      if (!hasSubstance) {
        return { ...prev, tasks: prev.tasks.filter((task) => task.id !== taskId) }
      }
      return { ...prev, tasks: prev.tasks.map((task) => (task.id === taskId ? applyFinish(task) : task)) }
    })
    /*
     * 通知右栏产出物卡刷新：这一轮可能刚刚往产出物文件夹里写了文件。
     * 用 window 事件而不是把刷新状态塞进 store，产出物卡自己能决定怎么拉。
     */
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('pa:outputs-refresh'))
  }, [])

  /*
   * 常驻事件订阅（SSE）：宿主侧例行任务、后台发现、审批到期都从这里推过来。
   *
   * 这是「Bot 在用户没发消息时也能说话」的唯一入口——没有它，例行任务只能等用户
   * 下次打开页面才发现结果。宿主的环形缓冲会补发断线期间的事件（`since` 参数），
   * 但这里只用「连上之后」的增量；离线更久的补发走 `/messages` 接口。
   */
  /*
   * host 消息 id → 前端消息 id 的**全局共享映射**。
   *
   * 为什么不能用「见过就跳过」的 Set：同一条消息会从两条路各来一次——`/reply/stream`
   * 的响应体，和常驻 SSE（多窗口同步靠后者）。Set 只能判断「见过」，却答不出
   * 「它对应界面上哪一条」，于是后来的那条只能再 append 一个新气泡，同一句话就
   * 出现两遍（实测踩过）。用映射表，先到的落地、后到的原地 update。
   */
  const hostMessageIds = useRef<Map<string, string>>(new Map())
  /**
   * 常驻 SSE 的 progress 合并链（`botId → 当前链头`）。
   *
   * 与 `/reply/stream` 的 `lastProgressId` 同一套 2.5 合并口径，但 SSE 是跨轮次的
   * 常驻连接，不能用流式请求里的局部变量：链状态必须按 botId 存，遇到非 progress
   * 消息、turnId 不兼容、链头消息已删除或不再是 progress 时断开。
   */
  const sseProgressChains = useRef<Map<string, { messageId: string; turnId?: string }>>(new Map())
  /**
   * 每个 Bot 已经收到过的最大事件序号（`botId → seq`），重连时当 `since` 用。
   *
   * 为什么必须记：连接断了再重连时，宿主只会补发 `seq > since` 的那一段。不带
   * `since` 就从「当前」开始收，断开那一小段时间里宿主推的例行任务结果、主动
   * 询问会永久丢失，界面上表现为「后台任务跑了，但对话里没有」。
   *
   * 为什么是**逐 Bot 的表**而不是一个数字：现在是一条连接订阅全部 Bot，而各通道
   * 的序号是独立的（各自从 1 开始）。共用一个 since 等于拿 A 的进度去截 B 的历史。
   *
   * 只活在内存里，刷新页面后归零：宿主重启过的话序号会从头计，带一个陈旧的大
   * `since` 反而会让我们**永远收不到**新事件。更久之前的补发交给 `/messages`。
   */
  const hostEventSeqRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    // 独立演示页（file://）没有宿主，EventSource 也连不上任何东西
    if (typeof location !== 'undefined' && location.protocol === 'file:') return undefined
    if (typeof EventSource === 'undefined') return undefined
    /*
     * **一条连接订阅全部 Bot**（`botId=*`）。
     *
     * 原来这里是 `for (const bot of state.bots)` 每个 Bot 建一条常驻 SSE。SSE 是
     * 长连接，而浏览器对同一 origin 的 HTTP/1.1 并发上限只有 6 条：主 Bot + 3 个
     * 子 Bot 就是 4 条，再叠上页面自己的请求；而 effect 依赖 `botIdKey`，**新建或
     * 删除任意一个 Bot 都会关掉全部连接再重建全部**，那个瞬时翻倍直接顶破上限，
     * 之后的请求全部排队——表现就是「一创建子 Bot 服务就断了」（实测复现）。
     *
     * 合并成一条之后：Bot 数量与连接数解耦，effect 依赖也空了——**Bot 增删再也
     * 不会重连 SSE**。事件自带 `botId`，按它分发即可。
     *
     * 补发游标也随之变成逐 Bot 的表（`botA:5,botB:3`）：各通道序号独立，共用
     * 一个 since 会拿 A 的进度去截 B 的历史。
     */
    const encodeSince = (): string => {
      const parts: string[] = []
      for (const [botId, seq] of hostEventSeqRef.current) {
        if (seq > 0) parts.push(`${botId}:${seq}`)
      }
      return parts.join(',')
    }
    const since = encodeSince()
    const source = new EventSource(
      `/api/personal-agent/events?botId=*${since !== '' ? `&since=${encodeURIComponent(since)}` : ''}`,
    )
    source.onmessage = (raw: MessageEvent): void => {
      let payload: any
      try {
        payload = JSON.parse(String(raw.data))
      } catch {
        return
      }
      /*
       * 推进游标：**只认真正收到的事件**，`hello` 不算。
       *
       * `hello` 带的是「宿主当前序号」，不是「我收到了这些事件」。拿它推进游标，
       * 一旦补发在到达前断线，那一段会被永久跳过——比不补发更糟。游标只增不减：
       * 重复补发会带来更小的 seq，不能把游标退回去。
       *
       * 合并连接下按事件自己的 `botId` 记，各通道互不干扰。
       */
      const eventBotId = typeof payload?.botId === 'string' && payload.botId !== '' && payload.botId !== '*'
        ? payload.botId
        : undefined
      if (payload?.type !== 'hello' && eventBotId !== undefined) {
        const seq = typeof payload?.seq === 'number' ? payload.seq : 0
        if (seq > (hostEventSeqRef.current.get(eventBotId) ?? 0)) hostEventSeqRef.current.set(eventBotId, seq)
      }
        /*
         * 期刊事件：宿主调度器生成完一期后推过来（source='auto'），或手动生成后回推。
         * 它不是一条对话消息，处理完必须 return，否则会被下面的消息分支当成脏帧丢掉。
         */
        if (payload?.type === 'journal') {
          const journal = sanitizeHostJournal(payload.journal)
          if (journal === null) return
          const known = stateRef.current.journals.some((item) => item.id === journal.id)
          if (!known) {
            setState((prev) => ({
              ...prev,
              journals: prev.journals.some((item) => item.id === journal.id) ? prev.journals : [journal, ...prev.journals],
              journalStatus: { generating: false, lastGeneratedAt: journal.generatedAt },
            }))
            if (payload.source === 'auto' && uiRef.current.view !== 'journal') toast('昨日期刊已生成')
          }
          return
        }
        /*
         * 压缩标记（1.1）：宿主 compaction 结束后推一条 `{ type: 'compaction', at, summary? }`，
         * 前端落成一条 `role: 'system'`、`source: 'compaction'` 的消息。
         *
         * 不走 appendMessage：那条路径会更新侧栏摘要与未读数，而「上下文已压缩」
         * 不是一条对话内容——它不该抢侧栏摘要、也不该让 Bot 冒出未读小红点。
         * 重复事件（断线重连补发）按 at 去重，同一时刻只留一条。
         */
        if (payload?.type === 'compaction') {
          const at = typeof payload.at === 'number' ? payload.at : Date.now()
          const folded = typeof payload.folded === 'number' && payload.folded >= 0
            ? Math.round(payload.folded)
            : undefined
          const summary = typeof payload.summary === 'string' ? payload.summary : ''
          setState((prev) => {
            if (prev.messages.some((message) => message.source === 'compaction' && message.at === at)) return prev
            const message: Message = {
              id: shortId('msg'),
              botId: String(payload.botId ?? MAIN_BOT_ID),
              role: 'system',
              at,
              source: 'compaction',
              blocks: [{
                type: 'compaction',
                at,
                ...(folded !== undefined ? { folded } : {}),
                ...(summary !== '' ? { summary } : {}),
              }],
            }
            /*
             * 按时间插到正确位置：SSE 断线补发的事件 at 可能早于当前最后一条，
             * 直接追加会让「压缩标记」出现在它压缩之后的消息下面。
             */
            const index = prev.messages.findIndex((item) => item.at > at)
            const messages = index < 0
              ? [...prev.messages, message]
              : [...prev.messages.slice(0, index), message, ...prev.messages.slice(index)]
            return { ...prev, messages }
          })
          return
        }
        /*
         * 主 Bot 在对话里建出了一个子 Bot（`bot_create`）。
         *
         * 事件发在**创建者**的通道上，不是新 Bot 的：新 Bot 的会话此时还不存在，
         * 它自己的通道也没人订阅。所以这里不用按 botId 过滤——能收到这条事件，就
         * 说明当前连接属于主 Bot。
         *
         * 去重交给 `absorbCreatedBots`：补发 / 多窗口都可能让同一条记录再来一次；
         * 这里只负责把载荷洗成记录。
         */
        if (payload?.type === 'bot-created') {
          const record = sanitizeCreatedBot(payload.bot)
          if (record === null) return
          absorbCreatedBots([record])
          return
        }
        if (payload?.type !== 'message' && payload?.type !== 'message-update') return
        if (payload.message === undefined) return
        const hostId = String(payload.message.id ?? '')
        if (hostId === '') return
        const blocks: MessageBlock[] = Array.isArray(payload.message.blocks) ? payload.message.blocks : []
        const kind = typeof payload.message.kind === 'string' ? payload.message.kind as BotMessageKind : undefined
        const replyTo = parseReplyTo(payload.message.replyTo)
        const turnId = typeof payload.message.turnId === 'string' && payload.message.turnId !== ''
          ? payload.message.turnId
          : undefined
        /*
         * 这一轮所属的群（私聊缺省）。
         *
         * 审批卡 / 问答卡是**宿主侧发起**的：它们不带场地信息，就只会落进该 Bot 的
         * 私聊。群里那次回复因此永远等不到用户点卡片——聊天内审批没有超时
         * （CHAT_TIMEOUT_MS = 0），于是那条气泡一直转圈，用户还得自己翻到私聊
         * 才看得见卡片。宿主现在把 roomId 带回来，这里必须原样落进消息里。
         */
        const eventRoomId = typeof payload.roomId === 'string' && payload.roomId !== ''
          ? payload.roomId
          : undefined
        const botId = String(payload.botId ?? MAIN_BOT_ID)
        // 非 progress 消息落地即断链（重复推送的 update 也算）：它们是独立气泡，后续 progress 不能并进来
        if (kind !== 'progress') sseProgressChains.current.delete(botId)
        // 已经落地过（多半是本窗口的流式请求先到）：原地更新，不再新建气泡
        const known = hostMessageIds.current.get(hostId)
        if (known !== undefined) {
          updateMessageBlocks(known, blocks, kind, hostId, replyTo, turnId, undefined, eventRoomId)
          return
        }
        /*
         * 多消息切分：host 把模型每段正文拆成一条独立 progress 消息。常驻 SSE 必须
         * 与 `/reply/stream` 用同一套 2.5 合并口径，否则页面实时收到的就是「一句
         * 一个气泡」（用户截图里一轮 17 条短消息）。
         *
         * 只处理 hostId 未见过的新消息（上面的 known 分支已排除重复推送）；
         * 链按 botId 记：SSE 是跨轮次的常驻连接，不能像流式请求那样用局部变量，
         * 否则上一轮的链会在下一轮还挂着、把新消息并进历史气泡。
         */
        if (payload.type === 'message' && kind === 'progress') {
          const chain = sseProgressChains.current.get(botId)
          if (chain !== undefined) {
            // turnId 兼容：任一方缺省不阻断（老宿主可能不带 turnId），都有且不等才不能并
            const turnCompatible = chain.turnId === undefined || turnId === undefined || chain.turnId === turnId
            const target = stateRef.current.messages.find((message) => message.id === chain.messageId)
            if (turnCompatible && target !== undefined && target.kind === 'progress') {
              hostMessageIds.current.set(hostId, chain.messageId)
              mergeMessageBlocks(chain.messageId, hostId, blocks, kind)
              return
            }
          }
        }
        const id = shortId('msg')
        hostMessageIds.current.set(hostId, id)
        const sourceKind = payload.source === 'routine'
          ? 'routine' as const
          : payload.source === 'proactive'
            ? 'proactive' as const
            // 审批卡 / 问答卡都不是用户对话，用 control 让 UI 不把它当成普通聊天
            : (payload.source === 'approval' || payload.source === 'question')
              ? 'control' as const
              : 'chat' as const
        appendMessage({
          id,
          botId,
          role: 'bot',
          at: typeof payload.message.at === 'number' ? payload.message.at : Date.now(),
          blocks,
          source: sourceKind,
          ...(eventRoomId !== undefined
            ? {
              roomId: eventRoomId,
              // 群聊里必须带发言者身份，否则气泡上不知道是谁说的
              senderId: botId,
              senderName: stateRef.current.bots.find((item) => item.id === botId)?.name ?? 'Bot',
            }
            : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(replyTo !== undefined ? { replyTo } : {}),
          ...(turnId !== undefined ? { turnId } : {}),
          // 原始 host id 必须留着：审批卡 / 问答卡点击时要凭它回传
          hostId,
        })
        // 新建的 progress 成为新的合并目标；非 progress 已在落地前断链
        if (kind === 'progress') {
          sseProgressChains.current.set(botId, { messageId: id, ...(turnId !== undefined ? { turnId } : {}) })
        }
    }
    return () => source.close()
    /*
     * 依赖刻意留空：连接只有一条，Bot 增删不该影响它。
     *
     * 旧实现在这里依赖 `botIdKey`，于是「新建一个子 Bot」= 关掉全部 SSE 再重建
     * 全部，正是那次连接数顶破浏览器上限、界面卡死的直接原因。
     */
  }, [])

  /*
   * 启动时补拉「宿主建过的 Bot」。
   *
   * 页面关着的时候主 Bot 也可能在后台建 Bot（例行任务、别的窗口），那些事件早已
   * 不在 SSE 的环形缓冲里；`/bots/created` 是账本，打开页面时合并一次就够，之后
   * 的创建走 SSE 增量。
   *
   * 失败静默：宿主没起 / 路由还是旧版本 / 独立演示页（file://），在界面上都等价于
   * 「没有要补的 Bot」。这里 toast 报错只会让用户去查一个并不存在的问题，而 Bot
   * 列表本身仍然是可用的。
   *
   * 依赖只有 `absorbCreatedBots`（它由两个稳定回调组成），所以实际只跑一次；不能
   * 把 state 放进来：每条消息都会换引用，会把整本账重拉一遍。
   */
  useEffect(() => {
    if (isDemoMode()) return undefined
    let alive = true
    void (async () => {
      try {
        const response = await fetch('/api/personal-agent/bots/created', { cache: 'no-store' })
        if (!response.ok) return
        const payload = (await response.json()) as { ok?: boolean; bots?: unknown }
        if (!alive || payload.ok === false || !Array.isArray(payload.bots)) return
        const records: CreatedBotRecord[] = []
        for (const raw of payload.bots as unknown[]) {
          const record = sanitizeCreatedBot(raw)
          if (record !== null) records.push(record)
        }
        if (records.length > 0) absorbCreatedBots(records)
      } catch {
        /* 宿主未就绪 / 网络失败：静默跳过，下次打开页面再补 */
      }
    })()
    return () => { alive = false }
  }, [absorbCreatedBots])

  /**
   * 就地更新一条消息的 blocks，**保持 pending 状态**。
   *
   * 流式渲染专用：每个 text / tool 事件都整块替换一次 pending 消息的内容，
   * 让点阵卡与正文在生成过程中就出现。收口仍然走 replaceMessage（它会把
   * pending 置回 false）。
   *
   * 用 setState 的函数式更新而不是读 stateRef：同一时刻可能有多个 bot 在
   * 各聊各的，闭包里的 state 随时是旧的，按 id 就地改才是安全的。
   *
   * 合并过的 progress 消息（带 `mergedSegments`）走另一条分支：`blocks` 是几条
   * host 消息拼起来的，`message-update` 只负责其中一段。整块替换会把别的段冲掉
   * （实测表现是「前面几条进度突然消失，只剩最后一句话」），所以按 hostId 换段
   * 再重拼。
   */
  const updateMessageBlocks = useCallback((
    id: string,
    blocks: MessageBlock[],
    kind?: BotMessageKind,
    hostId?: string,
    replyTo?: { id: string; preview: string },
    turnId?: string,
    relocate?: { at?: number; toEnd?: boolean },
    /** 宿主带回的群 id：只对「本来没有场地」的消息生效（见下方说明）。 */
    patchedRoomId?: string,
  ): void => {
    setState((prev) => {
      const messages: Message[] = prev.messages.map((message): Message => {
        if (message.id !== id) return message
        /*
         * 认领占位时要一并校正时间戳：占位的 `at` 是「用户发消息那一刻」，而它
         * 最终承载的是几十秒后才产生的正文。不校正的话，时间分隔与待办判定都会
         * 用错时刻（见下面 relocate 的说明）。
         */
        const stamp = relocate?.at !== undefined ? { at: relocate.at } : {}
        const segments = message.mergedSegments
        if (segments !== undefined) {
          /*
           * 段表里找不到这次更新（hostId 缺省 / 旧数据）：只更新 kind，不动 blocks。
           * 宁可让这一段稍旧，也不能把整条消息塌成一段。
           */
          if (hostId === undefined || segments[hostId] === undefined) {
            return kind !== undefined ? { ...message, kind, ...stamp } : { ...message, ...stamp }
          }
          const nextSegments = { ...segments, [hostId]: blocks }
          return {
            ...message,
            blocks: Object.values(nextSegments).flat(),
            mergedSegments: nextSegments,
            ...(kind !== undefined ? { kind } : {}),
            ...(turnId !== undefined ? { turnId } : {}),
            ...stamp,
          }
        }
        /*
         * 补场地：消息先由宿主推过来时可能没带 roomId（老版本宿主 / 多窗口时序），
         * 之后同一条消息的更新带了 roomId，就地补上——否则它会永远留在私聊里，
         * 群里那条气泡却一直是空的。
         *
         * 只在**原来没有** roomId 时补：已经有场地的消息不能被后来的事件改到别的群。
         */
        const roomPatch = patchedRoomId !== undefined && message.roomId === undefined
          ? { roomId: patchedRoomId }
          : {}
        // kind / hostId / replyTo / turnId 只在明确传入时改：`message-update` 可能只更新 blocks
        return {
          ...message,
          blocks,
          ...(kind !== undefined ? { kind } : {}),
          ...(hostId !== undefined ? { hostId } : {}),
          ...(replyTo !== undefined ? { replyTo } : {}),
          ...(turnId !== undefined ? { turnId } : {}),
          ...roomPatch,
          ...stamp,
        }
      })
      if (relocate?.toEnd !== true) return { ...prev, messages }
      /*
       * 把刚认领的那条挪到队尾。
       *
       * 「正在输入」占位是在**用户发消息那一刻**插进消息流的，位置固定在当时
       * 的队尾。可这一轮里还有另一类消息走的是**常驻 SSE**（问答卡 / 审批卡 /
       * 例行任务结果）——它们由 `appendMessage` 直接追加，追加时会落在占位**后面**。
       *
       * 于是同一轮里出现这种错位（实测 2026-11-03「创建一个互联网营销bot」）：
       *  · 15.6s 问答卡 → SSE 追加 → 排在占位之后；
       *  · 137.6s 正文 → `/reply/stream` 认领占位 → 填回占位原来的位置；
       * 结果正文显示在卡片**上面**，用户看到的是「先给结论、后提问题」。
       *
       * 占位承载的永远是「这一轮最新到达的那条消息」，所以认领时它就该待在队尾，
       * 而不是死守用户发消息时的位置。规则本身在 `relocateToEnd`（纯函数、可测）。
       */
      const ordered = relocateToEnd(messages, id)
      return ordered === messages ? { ...prev, messages } : { ...prev, messages: [...ordered] }
    })
  }, [])

  /**
   * 把一条 host 消息的 blocks **追加**进已有的 progress 消息（2.5 progress 合并）。
   *
   * 为什么在数据层合并而不是渲染层：一条 turn 会被 host 按模型说话次数切成多条
   * progress 消息，全部落地就是「一句话一个气泡」，对话流被过程文字淹没。在数据层
   * 合掉之后，刷新、侧栏摘要、任务记录看到的都是一条，不需要每处再各写一遍合并。
   *
   * 分段表是必需的：后续 `message-update` 会按 hostId 只替换自己那一段（见
   * updateMessageBlocks），不会把整条消息覆盖掉。
   */
  const mergeMessageBlocks = useCallback((id: string, hostId: string, blocks: MessageBlock[], kind?: BotMessageKind): void => {
    setState((prev) => ({
      ...prev,
      messages: prev.messages.map((message) => {
        if (message.id !== id) return message
        /*
         * 第一次合并时补一条「基线段」：这条消息原本的 blocks 来自它自己的 host
         * 消息（message.hostId）。用固定键 `__base` 兜住 hostId 缺失的中间态
         * （SSE 先落地、流式后接管时可能出现）。
         */
        const segments = message.mergedSegments
          ?? (message.hostId !== undefined
            ? { [message.hostId]: message.blocks }
            : { __base: message.blocks })
        const nextSegments = { ...segments, [hostId]: blocks }
        return {
          ...message,
          blocks: Object.values(nextSegments).flat(),
          mergedSegments: nextSegments,
          ...(kind !== undefined ? { kind } : {}),
        }
      }),
    }))
  }, [])

  const botById = useCallback((id: string): Bot | undefined => stateRef.current.bots.find((bot) => bot.id === id), [])

  const replyAsBot = useCallback((bot: Bot, text: string, target: { roomId?: string; source?: Message['source']; quote?: QuoteRef; mentions?: MentionTarget[] } = {}, images: ChatImage[] = [], userMessageId?: string): void => {
    const pendingId = shortId('msg')
    /*
     * 本轮请求的「场地」参数：群 id，以及群设置要求的统一模型。
     *
     * 统一模型要在**这一轮开始时**定下并带进请求体：群设置随时可能被改，如果
     * 让它跑到一半改设置就换成别的模型，同一条回复的前后两段会由两个模型写。
     */
    const requestOpts: ReplyRequestOptions = {
      ...(target.roomId !== undefined ? { roomId: target.roomId } : {}),
      // 构造群历史时要把本轮这条排除，否则模型会看到同一句话两遍
      ...(userMessageId !== undefined ? { userMessageId } : {}),
      // 引用回复：被引用消息的完整内容随请求投给宿主（界面展示仍用 preview）
      ...(target.quote !== undefined ? { quote: target.quote } : {}),
      // 点名派活：正文里 @ 了谁（宿主据此注入「该交给它」的上下文）
      ...(target.mentions !== undefined && target.mentions.length > 0 ? { mentions: target.mentions } : {}),
      ...((): { unifiedModel?: BotModel } => {
        if (target.roomId === undefined) return {}
        const room = stateRef.current.rooms.find((item) => item.id === target.roomId)
        if (room === undefined || room.modelMode !== 'unified') return {}
        // 选过统一模型就用它；没选（undefined）说明用户切了开关但还没选模型，回落各自模型
        return room.unifiedModel !== undefined ? { unifiedModel: room.unifiedModel } : {}
      })(),
    }
    appendMessage({
      id: pendingId,
      botId: bot.id,
      ...(target.roomId ? { roomId: target.roomId, senderId: bot.id, senderName: bot.name } : {}),
      role: 'bot',
      at: Date.now(),
      blocks: [],
      pending: true,
      source: target.source ?? 'chat',
    })
    // 每轮对话一条任务记录：先落 running，收口时再补状态/耗时/产出。
    const taskId = createTaskRecord(bot, text, target, images)

    /*
     * ── 停止控制 ────────────────────────────────────────────────────
     *
     * 停止要同时做两件事：断开前端流式读取（不再等），以及让 finish() 短路降级链
     * ——非流式 / 本地引擎会把这一轮的工具调用与生图**再执行一遍**，用户看到的
     * 就是「按了停止，反而多扣一次费」。
     *
     * 登记进 ref 是为了让输入框的停止键能按会话找到「现在在跑的是哪几轮」：
     * 群聊里 sendMessage 会为每个被 @ 的成员各起一轮，可能同时在跑。
     */
    const stopController = new AbortController()
    let stopped = false
    /** 停止收口只做一次：abort() 与 finish() 都会触发它。 */
    let stoppedSettled = false
    /*
     * 多消息模式的两张表定义在本轮作用域（不是 finish 内部）：停止时要立刻摘掉
     * pending，那一刻 finish 可能还没走到 await 之后的收口点。
     */
    /** host 消息 id → 前端消息 id（message-update 靠它定位要改哪一条）。 */
    const messageIdMap = new Map<string, string>()
    /** 本轮每条 host 消息的 blocks（收口时汇总任务执行详情用）。 */
    const taskBlocksById = new Map<string, MessageBlock[]>()

    /**
     * 用户主动停止后的收口。
     *
     * 只落地「已经收到的东西」：摘掉 pending、把还在 running 的工具卡标中断、补
     * 一条「已停止」，任务记录收口成 stopped。**不重试、不补请求**（理由见上）。
     *
     * 幂等：abort() 与 finish() 都会调用它，谁先到谁收口。
     */
    const finalizeStopped = (): void => {
      if (stoppedSettled) return
      stoppedSettled = true
      const stopNote: MessageBlock = { type: 'text', text: '已停止' }
      setState((prev) => {
        const landed = new Set(messageIdMap.values())
        const order = [...messageIdMap.values()]
        // 停止提示挂在最后一条落地消息上；一条都没有就挂在占位消息上
        const noteTarget = order.length > 0 ? order[order.length - 1] : pendingId
        return {
          ...prev,
          messages: prev.messages.map((message) => {
            const mine = message.id === pendingId || landed.has(message.id)
            if (!mine) return message
            /*
             * 占位从未被认领、真实内容已经在别的消息里：清空隐藏（与
             * finalizeStreamMessages 同口径），别留一个空气泡。
             */
            if (message.id === pendingId && !landed.has(pendingId) && landed.size > 0) {
              return { ...message, pending: false, blocks: [] }
            }
            const blocks = interruptRunningBlocks(message.blocks)
            const withNote = message.id === noteTarget && !blocks.some((block) => block.type === 'text' && block.text === '已停止')
              ? [...blocks, stopNote]
              : blocks
            return { ...message, pending: false, blocks: withNote }
          }),
        }
      })
      /*
       * 任务记录汇总用「已落地的 blocks」：多消息模式分散在 taskBlocksById 里；
       * 单消息模式还在 pending 占位消息上（流式事件每来一次就写进去了）。
       */
      const collected = [...taskBlocksById.values()].flat()
      const pendingNow = stateRef.current.messages.find((message) => message.id === pendingId)
      const blocks = collected.length > 0 ? collected : (pendingNow?.blocks ?? [])
      // 任务记录里的工具步骤同样不能留 running（收口时会再兜一层，这里先补结果摘要）
      finishTaskRecord(taskId, 'stopped', interruptRunningBlocks(blocks), '已停止')
    }

    const turn: RunningReplyTurn = {
      botId: bot.id,
      ...(target.roomId !== undefined ? { roomId: target.roomId } : {}),
      taskId,
      abort: () => {
        if (stopped) return
        stopped = true
        stopController.abort()
        /*
         * 立刻收口，不等 finish 从 abort 的异常里绕回来：reader.read() 在个别
         * 浏览器上不会马上 reject，气泡多转半秒就会让人以为没点上。
         */
        finalizeStopped()
      },
    }
    runningReplyTurnsRef.current.add(turn)

    /*
     * 三级降级：流式 → 非流式 → 本地引擎。
     *
     * 流式是唯一能让「正文逐段出现 / 生图点阵卡实时出现」的链路：宿主每 emit 一个
     * text 或 tool 事件，这里就把 pending 消息的 blocks 整块换成最新快照。
     *
     * 收口规则（每条路都必须在 pending 消息上落地，否则「正在输入」会永远转下去）：
     *  · 收到 done，或流正常结束但没收到 done 事件：有 blocks 就用它收口；
     *  · 流结束但 blocks 为空、或流里只报错：走非流式 → 本地引擎降级；
     *  · 网络异常 / 非 2xx / 任一环节抛错：同样降级，最后用兜底文案收口。
     * 不能只依赖 done 事件：host 的失败路径（agent 建不起来 / 本轮无输出）只 emit
     * error 就结束流，不再补 done。
     *
     * 每次 replyAsBot 调用都有独立的 pendingId 与局部变量，所以群聊里多个 bot
     * 同时回复时各自更新各自的消息，不会互相串。
     */
    const finish = async (): Promise<void> => {
      let streamError = ''
      /*
       * ── 多消息模式 ────────────────────────────────────────────────
       * host 每开一条消息就 emit 一个 `message` 事件，这里为它落地一条**独立**的
       * 前端消息。第一条复用 pending 占位（否则「正在输入」气泡会先闪一下再被
       * 替换成两条），后续的逐条 append。
       *
       * `messageIdMap` / `taskBlocksById` 定义在 finish 外面（见上面的停止控制）：
       * 停止收口要在 finish 之外读写它们。
       */
      let firstMessageClaimed = false
      let sawMessageEvent = false
      /**
       * 本轮最后一条落地的 progress 消息（前端 id）；null = 合并链已断开。
       *
       * 2.5 progress 合并：host 把一次 turn 按「模型说话的次数」切成多条消息，
       * 其中大多数是 progress（说完调工具、拿到结果再说一段）。这些过程文字不该
       * 每条都开一个气泡——只保留一条，后续 progress 的 blocks 追进去原地增长。
       *
       * 合并链在遇到 finding / need-input / approval / final 时断开：那几类是
       * 「需要用户注意 / 需要用户动作 / 收口」的独立消息，必须有自己的气泡。
       */
      let lastProgressId: string | null = null

      const applyHostMessage = (hostMessage: HostBotMessage): void => {
        sawMessageEvent = true
        taskBlocksById.set(hostMessage.id, hostMessage.blocks)
        for (const block of hostMessage.blocks) {
          if (block.type === 'tool') upsertTaskToolStep(taskId, block.run)
        }
        /*
         * 过程消息的文字进任务记录（任务详情卡的过程时间线）：final 不进——
         * 它是「最终回复」，收口时单独取，重复进时间线会让同一段话出现两遍。
         */
        if (hostMessage.kind !== 'final') {
          const text = hostMessage.blocks
            .filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
          upsertTaskTextStep(taskId, hostMessage.id, text, hostMessage.kind)
        }
        /*
         * 先查全局映射：SSE 可能已经先一步把这条消息落地了（两条路各推一次，
         * 到达顺序不保证）。这时只做 update，绝不再 append——否则同一句话会在
         * 界面上出现两个气泡（实测踩过）。
         */
        const globalKnown = hostMessageIds.current.get(hostMessage.id)
        if (globalKnown !== undefined) {
          // 记进本轮映射：收口时要按它把 pending 摘掉
          messageIdMap.set(hostMessage.id, globalKnown)
          updateMessageBlocks(globalKnown, hostMessage.blocks, hostMessage.kind, hostMessage.id, hostMessage.replyTo, hostMessage.turnId)
          return
        }
        const known = messageIdMap.get(hostMessage.id)
        if (known !== undefined) {
          updateMessageBlocks(known, hostMessage.blocks, hostMessage.kind, hostMessage.id, hostMessage.replyTo, hostMessage.turnId)
          return
        }
        if (!firstMessageClaimed) {
          firstMessageClaimed = true
          messageIdMap.set(hostMessage.id, pendingId)
          hostMessageIds.current.set(hostMessage.id, pendingId)
          /*
           * 认领占位时把它挪到队尾、并校正时间戳。
           *
           * 占位是在用户发消息那一刻插进去的；本轮若还有走常驻 SSE 的消息
           * （问答卡 / 审批卡）已经追加在它后面，正文再填回占位原位就会排到那些
           * 消息**前面**——用户看到的就是「结论在上、提问在下」的颠倒顺序。
           * 详见 updateMessageBlocks 里 `relocate` 的说明。
           */
          updateMessageBlocks(
            pendingId,
            hostMessage.blocks,
            hostMessage.kind,
            hostMessage.id,
            hostMessage.replyTo,
            hostMessage.turnId,
            { at: hostMessage.at, toEnd: true },
          )
          lastProgressId = hostMessage.kind === 'progress' ? pendingId : null
          return
        }
        /*
         * 连续 progress：并进上一条，不再新开气泡。host 消息 id 也映射到同一条
         * 前端消息——后续它的 `message-update` 才能定位到「合并后的那一条」，
         * 由 updateMessageBlocks 按 hostId 换段。
         */
        if (hostMessage.kind === 'progress' && lastProgressId !== null) {
          messageIdMap.set(hostMessage.id, lastProgressId)
          hostMessageIds.current.set(hostMessage.id, lastProgressId)
          mergeMessageBlocks(lastProgressId, hostMessage.id, hostMessage.blocks, hostMessage.kind)
          return
        }
        const id = shortId('msg')
        messageIdMap.set(hostMessage.id, id)
        hostMessageIds.current.set(hostMessage.id, id)
        appendMessage({
          id,
          botId: bot.id,
          ...(target.roomId ? { roomId: target.roomId, senderId: bot.id, senderName: bot.name } : {}),
          role: 'bot',
          at: hostMessage.at,
          blocks: hostMessage.blocks,
          pending: true,
          source: target.source ?? 'chat',
          kind: hostMessage.kind,
          ...(hostMessage.turnId !== undefined ? { turnId: hostMessage.turnId } : {}),
          ...(hostMessage.replyTo !== undefined ? { replyTo: hostMessage.replyTo } : {}),
          hostId: hostMessage.id,
        })
        // 只有 progress 能成为下一次合并的目标；其它类别落地即打断合并链
        lastProgressId = hostMessage.kind === 'progress' ? id : null
      }

      /**
       * 多消息收口：把本轮落地的每条消息都摘掉 pending（「正在输入」停止转动）。
       *
       * pendingId 必须无条件一起收口：常驻 SSE（`/api/personal-agent/events`）与
       * `/reply/stream` 会同时推送同一条 host 消息。SSE 先到时 `applyHostMessage`
       * 走 `globalKnown` 分支，只会 update 那条 SSE 落地的消息，**不会认领** pending
       * 占位——不在这里兜底，界面上就会留一个永久转圈的「正在输入」气泡（实测见
       * 2026-11-02「创建一个AI咨询的子bot」：两条 pending 气泡一直不消失）。
       */
      const finalizeStreamMessages = (): void => {
        const ids = new Set(messageIdMap.values())
        setState((prev) => ({
          ...prev,
          messages: prev.messages.map((message) => {
            if (ids.has(message.id)) return { ...message, pending: false }
            if (message.id === pendingId && message.pending === true) {
              // 未被认领的占位：真实内容已经在 SSE 落地的消息里，清空即可隐藏
              return { ...message, pending: false, blocks: [] }
            }
            return message
          }),
        }))
      }

      try {
        // 停止发生在「保留正在输入手感」的延迟里：一次请求都还没发，直接收口
        if (stopped) {
          finalizeStopped()
          return
        }
        const streamed = await hostReplyStream(bot, text, stateRef.current, (event, blocks) => {
          /*
           * 已停止：abort 之后仍可能有一批已缓冲的事件被派发。这里一律丢弃——
           * 多消息模式的 `message` 事件会 append 一条新的 pending 消息，放进来
           * 就是一颗永远转圈的「正在输入」气泡。
           */
          if (stopped) return
          if (event.type === 'user-message') {
            /*
             * host 回传它给这条用户消息分配的原始 id。撤回要靠它精确定位——
             * steer 插话时 host 会加前缀，文本匹配既可能失败也可能误伤下一句。
             */
            if (userMessageId !== undefined) {
              setState((prev) => ({
                ...prev,
                messages: prev.messages.map((message) => (
                  message.id === userMessageId ? { ...message, hostId: event.messageId } : message
                )),
              }))
            }
            return
          }
          if (event.type === 'error') {
            streamError = event.message
            return
          }
          if (event.type === 'message' || event.type === 'message-update') {
            applyHostMessage(event.message)
            return
          }
          if (event.type === 'tool') upsertTaskToolStep(taskId, event.run)
          if (event.type !== 'text' && event.type !== 'tool') return
          /*
           * 多消息已接管：text/tool 是同一批内容的扁平视图。再按它覆盖 pending
           * 会把刚刚切好的多条消息又合并回一条，多消息就白做了。
           */
          if (sawMessageEvent) return
          updateMessageBlocks(pendingId, blocks)
        }, images, stopController.signal, requestOpts)

        /*
         * 流式过程中点了停止：不再看 streamed、不再降级，直接按停止收口。
         * 这是「停止后不能重跑」的关键短路——放在多消息判断之前，多消息模式
         * 也走同一条停止收口。
         */
        if (stopped) {
          finalizeStopped()
          return
        }

        /*
         * 多消息模式优先收口：只要收到过 message 事件，各条消息就已经在界面上
         * 落地了。此时**不能**再走下面的 replaceMessage(pendingId, …)——那会把
         * 多条消息塌回一条。也要在「流式返回空」之前判断：`streamed` 是扁平
         * blocks，与多消息是否成功无关。
         */
        if (sawMessageEvent) {
          finalizeStreamMessages()
          finishTaskRecord(
            taskId,
            streamError === '' ? 'done' : 'failed',
            [...taskBlocksById.values()].flat(),
            streamError === '' ? undefined : streamError,
          )
          return
        }

        if (streamed !== null && streamed.length > 0) {
          /*
           * 只有工具卡、没有任何正文、且本轮报过错：把错误补成一条文本块。
           * 否则用户会对着几张卡猜「到底成没成」。
           */
          const finalBlocks = streamError !== '' && !streamed.some((block) => block.type === 'text')
            ? [...streamed, { type: 'text' as const, text: `本轮出错：${streamError}` }]
            : streamed
          replaceMessage(pendingId, finalBlocks)
          finishTaskRecord(taskId, streamError === '' ? 'done' : 'failed', finalBlocks, streamError === '' ? undefined : streamError)
          return
        }

        /*
         * 流式没拿到东西：再试一次非流式（同样是真 agent，只是不带流）。
         *
         * **到此为止**。这里原来还有第三层降级——退回 `engine.ts` 的本地模板引擎，
         * 用固定话术假装回复。那条路径已经删掉：它会让「agent 挂了」表现成
         * 「Bot 正常回你，只是不做任何事」，用户完全无感（实测踩过：一个空壳会话
         * 让每轮都静默降级，Bot 满口答应「我这就建」却一个文件都产不出来）。
         * 失败就必须看得见。
         */
        const remote = await hostReply(bot, text, stateRef.current, images, requestOpts)
        // 停止发生在降级请求期间：结果直接丢弃，这一轮已经不该继续了
        if (stopped) {
          finalizeStopped()
          return
        }
        if (remote !== null && remote.length > 0) {
          replaceMessage(pendingId, remote)
          finishTaskRecord(taskId, 'done', remote)
          return
        }
        // 独立演示页没有宿主，本地引擎是它唯一的回复来源（不是降级）
        if (isDemoMode()) {
          const demoBlocks = generateReply(bot, text, stateRef.current)
          replaceMessage(pendingId, demoBlocks)
          finishTaskRecord(taskId, 'done', demoBlocks)
          return
        }
        const failureText = `这一轮没能完成：${streamError !== '' ? streamError : '宿主没有返回任何内容（agent 可能没起来，详见宿主日志）'}`
        replaceMessage(pendingId, [{ type: 'text', text: failureText }])
        finishTaskRecord(taskId, 'failed', [], failureText)
      } catch (error) {
        /*
         * 停止会让 abort 以异常形式冒出来（fetch / reader 都会抛）：按停止收口，
         * 不要报成「这一轮没能完成」。这也是最后一道防降级的闸门。
         */
        if (stopped) {
          finalizeStopped()
          return
        }
        // 兜底：降级链自己出错也不能让 pending 消息永远挂着
        const reason = streamError !== '' ? streamError : userFacingErrorText(error)
        /*
         * 多消息模式下，pending 标记留在任何一条消息上都会让它在下一轮的 history
         * 过滤里被丢掉（`!msg.pending`），表现为「Bot 记不住刚说过的话」。
         * 所以先统一摘掉，再给占位消息补一条错误文本。
         */
        if (sawMessageEvent) finalizeStreamMessages()
        replaceMessage(pendingId, [{ type: 'text', text: `这一轮没能完成：${reason}` }])
        finishTaskRecord(taskId, 'failed', [...taskBlocksById.values()].flat(), reason)
      } finally {
        // 本轮结束（无论怎么结束）就从停止键的作用范围里摘掉
        runningReplyTurnsRef.current.delete(turn)
      }
    }

    // 保留「正在输入」的手感：稍等一下再开流，避免 pending 气泡一闪而过
    later(300 + Math.random() * 300, () => {
      /*
       * 最外层兜底：finish 内部已经有 try/catch，能走到这里说明**收口本身**抛了
       * （例如 applyFinish 处理某条坏 block 时崩掉）。此时任务卡会永远停在
       * 「正在整理回复…」——右栏显示与宿主真实状态脱节，用户会误判「它还在跑、
       * 我还能插话」（2026-11-05 19:33 那一轮就是这么误导用户的）。再兜一次，
       * 至少把任务收成 failed，并留下可排查的日志。
       */
      void finish().catch((error: unknown) => {
        try {
          console.warn('[personal-agent] 收口失败', error)
          finishTaskRecord(taskId, 'failed', [], '这一轮没能完成：收口时出错（详见控制台）')
        } catch {
          /* 兜底再失败：保持现状，不能在这里再抛一次 */
        }
      })
    })
  }, [appendMessage, createTaskRecord, finishTaskRecord, later, mergeMessageBlocks, replaceMessage, updateMessageBlocks, upsertTaskToolStep, upsertTaskTextStep])

  /**
   * 拉取某个 Bot 的 Pages（3.1），写回 `state.pagesByBot`。
   *
   * 为什么放在 store 而不是右栏卡自己 useState：消息里的旧页面卡（ArtifactCard）
   * 也要读这份列表判断「这张卡是否已被更新过」。两处各拉一次会不同步，而且会
   * 把同一个请求打两遍。
   *
   * 失败一律静默：host 路由还没上线、或这个 Bot 一个页面都没交付过，在界面上
   * 应该是同一个结果——右栏不出现「页面」卡。为此不 toast、不记错误状态。
   */
  const refreshPages = useCallback(async (botId: string): Promise<void> => {
    // 独立演示页（file://）没有宿主：直接当「没有页面」处理，不发请求
    if (typeof location !== 'undefined' && location.protocol === 'file:') return
    const bot = stateRef.current.bots.find((item) => item.id === botId)
    if (bot === undefined) return
    try {
      const query = `botId=${encodeURIComponent(botId)}&name=${encodeURIComponent(bot.name)}`
      const response = await fetch(`/api/personal-agent/pages?${query}`, { cache: 'no-store' })
      if (!response.ok) return
      const payload = (await response.json()) as PagesResponse
      if (payload.ok === false || !Array.isArray(payload.items)) return
      /*
       * 逐条洗数据：host 版本可能比前端新 / 旧，字段缺失时不能让整张卡崩掉。
       * slug 与 url 是必须的（没有它们既不能展示也不能打开），其余给默认值。
       */
      const items: PageItem[] = []
      for (const raw of payload.items as unknown[]) {
        if (raw === null || typeof raw !== 'object') continue
        const record = raw as Record<string, unknown>
        if (typeof record.slug !== 'string' || record.slug === '') continue
        if (typeof record.url !== 'string' || record.url === '') continue
        items.push({
          slug: record.slug,
          url: record.url,
          title: typeof record.title === 'string' && record.title !== '' ? record.title : record.slug,
          updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
          ...(typeof record.id === 'string' ? { id: record.id } : {}),
          ...(typeof record.path === 'string' ? { path: record.path } : {}),
          ...(typeof record.createdAt === 'number' ? { createdAt: record.createdAt } : {}),
          ...(typeof record.sourceMessageId === 'string' ? { sourceMessageId: record.sourceMessageId } : {}),
        })
      }
      items.sort((a, b) => b.updatedAt - a.updatedAt)
      setState((prev) => ({ ...prev, pagesByBot: { ...(prev.pagesByBot ?? {}), [botId]: items } }))
    } catch {
      /* host 未就绪 / 网络失败：保持现状（右栏不显示页面卡），不打扰用户 */
    }
  }, [])

  /**
   * Pages 拉取时机（3.1）。
   *
   *  · 切换 Bot：拉一次当前 Bot 的页面；
   *  · `pa:outputs-refresh`：host 在文件系统变化 / 每轮回复收口后广播，页面可能刚
   *    被更新，重拉一次（与右栏产出物卡同一个事件源）。
   *
   * 必须定义在 refreshPages 之后：effect 的依赖数组在渲染时求值，引用一个尚未
   * 初始化的 const 会直接抛「Cannot access before initialization」。
   */
  useEffect(() => {
    void refreshPages(ui.selectedBotId)
  }, [refreshPages, ui.selectedBotId])
  useEffect(() => {
    const onRefresh = (): void => { void refreshPages(uiRef.current.selectedBotId) }
    window.addEventListener('pa:outputs-refresh', onRefresh)
    return () => { window.removeEventListener('pa:outputs-refresh', onRefresh) }
  }, [refreshPages])

  /**
   * 拉取某个 Bot 的任务与委派摘要（第 5 步，`GET /assignments?botId=`）。
   *
   * 只做缓存：宿主是权威，成功后整批替换该 Bot 的列表（按 createdAt 倒序，取前 50）。
   * 失败一律静默——任务面板是增强信息，宿主没升级 / 网络抖动都不该 toast。
   */
  const refreshAssignments = useCallback(async (botId: string): Promise<void> => {
    if (isDemoMode() || botId === '') return
    try {
      const response = await fetch(`/api/personal-agent/assignments?botId=${encodeURIComponent(botId)}`, { cache: 'no-store' })
      if (!response.ok) return
      const payload = (await response.json()) as { ok?: boolean; assignments?: unknown }
      if (payload.ok === false || !Array.isArray(payload.assignments)) return
      const assignments: AssignmentView[] = []
      for (const raw of payload.assignments as unknown[]) {
        const view = normalizeAssignmentView(raw)
        if (view !== null) assignments.push(view)
      }
      assignments.sort((a, b) => b.createdAt - a.createdAt)
      setState((prev) => ({
        ...prev,
        assignmentsByBot: {
          ...(prev.assignmentsByBot ?? {}),
          [botId]: assignments.slice(0, ASSIGNMENT_LIST_MAX),
        },
      }))
    } catch {
      /* 宿主未就绪 / 网络失败：静默，面板保留旧数据 */
    }
  }, [])

  /** 当前选中的 Bot 是否有未结束的委派（决定是否开启 3 秒轮询）。 */
  const hasOpenAssignments = (state.assignmentsByBot?.[ui.selectedBotId] ?? [])
    .some((item) => isOpenAssignment(item.status))

  /*
   * 任务与委派轮询（第 5 步）：
   *  · activeBot 变化立即拉一次；
   *  · 该 Bot 有非终态委派时每 3 秒刷新一次；
   *  · 全部终态自动停；
   *  · document.hidden 时暂停（后台标签页不重复打扰宿主），回到前台立即补一次。
   */
  useEffect(() => {
    void refreshAssignments(ui.selectedBotId)
  }, [refreshAssignments, ui.selectedBotId])

  useEffect(() => {
    if (isDemoMode() || !hasOpenAssignments) return undefined
    const botId = ui.selectedBotId
    let timer: number | null = null
    const start = (): void => {
      if (timer !== null || document.hidden) return
      timer = window.setInterval(() => {
        void refreshAssignments(botId)
      }, ASSIGNMENT_POLL_MS)
    }
    const stop = (): void => {
      if (timer === null) return
      window.clearInterval(timer)
      timer = null
    }
    start()
    const onVisibility = (): void => {
      if (document.hidden) {
        stop()
        return
      }
      // 回到前台先补拉一次（后台期间可能已经结算），再恢复 3 秒节奏
      void refreshAssignments(botId)
      start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [hasOpenAssignments, refreshAssignments, ui.selectedBotId])

  const clearUnread = useCallback((id: string, kind: 'bot' | 'room' = 'bot'): void => {
    setState((prev) => ({
      ...prev,
      bots: kind === 'bot' ? prev.bots.map((bot) => (bot.id === id ? { ...bot, unread: 0 } : bot)) : prev.bots,
      rooms: kind === 'room' ? prev.rooms.map((room) => (room.id === id ? { ...room, unread: 0 } : room)) : prev.rooms,
    }))
  }, [])

  /**
   * 把某个会话标记为已读：`readAt` 取「当前时间」与该会话最新消息 at 的较大者。
   *
   * 为什么要跟消息 at 比：消息时间来自宿主（可能比本机钟略快），只写 Date.now()
   * 会留下一两条「刚读过的还是未读」的幽灵提示。取较大值后，切进会话即彻底清零。
   */
  const markRead = useCallback((kind: 'bot' | 'room', id: string): void => {
    let latest = 0
    for (const message of stateRef.current.messages) {
      const match = kind === 'bot'
        ? message.botId === id && message.roomId === undefined
        : message.roomId === id
      if (match && message.at > latest) latest = message.at
    }
    const at = Math.max(Date.now(), latest)
    setUi((prev) => ({ ...prev, readAt: { ...prev.readAt, [`${kind}:${id}`]: at } }))
  }, [])

  const selectBot = useCallback((id: string): void => {
    setUi((prev) => ({ ...prev, selectedBotId: id, selectedRoomId: null, view: 'chat', rightTab: 'detail' }))
    clearUnread(id, 'bot')
    markRead('bot', id)
  }, [clearUnread, markRead])

  const selectRoom = useCallback((id: string): void => {
    const room = stateRef.current.rooms.find((item) => item.id === id)
    setUi((prev) => ({
      ...prev,
      selectedRoomId: id,
      // 群聊的右栏固定展示群主 Bot（第一个成员），避免右栏停留在上一个私聊对象
      selectedBotId: room?.memberIds[0] ?? prev.selectedBotId,
      view: 'chat',
    }))
    clearUnread(id, 'room')
    markRead('room', id)
  }, [clearUnread, markRead])

  const setTheme = useCallback((theme: 'auto' | 'dark' | 'light'): void => {
    setState((prev) => ({ ...prev, settings: { ...prev.settings, theme } }))
  }, [])

  const sendMessage = useCallback((text: string, opts: { botId?: string; roomId?: string; images?: ChatImage[]; replyTo?: { id: string; preview: string } } = {}): void => {
    const value = text.trim()
    const images = opts.images ?? []
    // 只发图不打字也要能发出去
    if (value === '' && images.length === 0) return
    const current = stateRef.current
    const roomId = opts.roomId ?? uiRef.current.selectedRoomId ?? undefined
    const room = roomId ? current.rooms.find((item) => item.id === roomId) : undefined
    const botId = opts.botId ?? (room ? (room.memberIds[0] ?? MAIN_BOT_ID) : uiRef.current.selectedBotId)
    const bot = current.bots.find((item) => item.id === botId)
    if (!bot) return
    /*
     * 引用回复（2.3）：优先用调用方显式传的，其次读输入框当前挂着的引用。
     * 消息上记下被引用消息的 id 与一小段摘要——只存 id 的话，被引用的消息删掉后
     * 引用条就只剩一行空白；摘要让引用条在任何时候都能自己说清在引用什么。
     *
     * 真正**投给模型**的是补全后的 quote（含完整正文与 role）。只用 interface 层的
     * preview 会丢掉交互卡的选项：用户引用一条问答卡再回「1」，模型既看不到选项、
     * 也不知道 1 对应哪一项，只能回「没看到前文的选项」——这条链路以前就断在这里。
     */
    const quote = buildQuoteRef(current.messages, opts.replyTo ?? uiRef.current.replyTo)
    const at = Date.now()
    const userMessageId = shortId('msg')
    const blocks: MessageBlock[] = []
    if (value !== '') blocks.push({ type: 'text', text: value })
    for (const image of images) blocks.push({ type: 'image', image })

    /** 把这条用户消息落进对话流（正常发送与「停止」拦截两条路共用）。 */
    const landUserMessage = (): void => {
      appendMessage({
        id: userMessageId,
        botId,
        ...(roomId ? { roomId } : {}),
        role: 'user',
        at,
        blocks,
        source: 'chat',
        // replyTo 里带 preview（界面渲染引用条）与 text/role（下一轮 history 用）
        ...(quote !== undefined ? { replyTo: quote } : {}),
      })
      // 引用只对下一条消息生效：发出去就清掉，否则后面每条都会带着同一条引用
      if (uiRef.current.replyTo !== null) setUi((prev) => ({ ...prev, replyTo: null }))
      setState((prev) => ({ ...prev, lastUserMessageAt: at }))
    }

    /**
     * 当前会话有没有东西在跑（与停止键同一口径）：活着的轮次 / pending 消息 /
     * 还挂着 running 的任务记录，三者任一即可。
     */
    const scopeHasRunning = (): boolean => {
      const nowUi = uiRef.current
      const scopeRoom = nowUi.selectedRoomId ?? undefined
      const inScope = (target: { botId: string; roomId?: string }): boolean => (scopeRoom !== undefined
        ? target.roomId === scopeRoom
        : target.botId === nowUi.selectedBotId && target.roomId === undefined)
      for (const turn of runningReplyTurnsRef.current) {
        if (inScope(turn)) return true
      }
      const pending = current.messages.some((message) => message.role === 'bot'
        && message.pending === true
        && inScope({ botId: message.botId, ...(message.roomId !== undefined ? { roomId: message.roomId } : {}) }))
      if (pending) return true
      return current.tasks.some((task) => task.status === 'running'
        && inScope({ botId: task.botId, ...(task.roomId !== undefined ? { roomId: task.roomId } : {}) }))
    }

    /*
     * 「说停止」要真的停止（判据见 isStopCommand 的说明）。
     *
     * 只在当前会话确实有东西在跑时拦截：平时说「停止」是正常对话，不该被吞掉。
     * 拦截后这条消息照常落在对话流里（用户看得见自己发了什么），但不投给模型
     * ——投过去只会换来一句「收到，我按你说的调整方向」，任务继续跑。
     */
    if (value !== '' && images.length === 0 && isStopCommand(value) && scopeHasRunning()) {
      landUserMessage()
      stopReplyRef.current()
      return
    }

    landUserMessage()

    if (room) {
      /*
       * 谁该接话：交给纯函数判定（规则与理由见 room-trigger.ts）。
       *
       * 这里原来是一句 `value.includes(bot.name)`——正文里**任何位置**提到成员名都
       * 算点名（「我记得小墨说过」会把小墨叫出来），成员名互为子串时一次还会叫错
       * 两个人。判定逻辑抽出去之后才有测试可写。
       */
      const members: Bot[] = room.memberIds
        .map((id) => current.bots.find((item) => item.id === id))
        .filter((item): item is Bot => item !== undefined)
      /*
       * 引用了某条 Bot 消息 → 只叫那个成员。
       *
       * 「点回复」是界面上最明确的一次「这条是问你」：比正文里推断委托词可靠，
       * 也比兜底给群主更符合直觉。被引用的消息不在本群（或已删除）时按没引用处理。
       */
      const quoted = quote !== undefined
        ? current.messages.find((item) => item.id === quote.id)
        : undefined
      const quotedBotId = quoted !== undefined && quoted.role === 'bot' && quoted.roomId === roomId
        ? (quoted.senderId ?? quoted.botId)
        : undefined
      const trigger = resolveRoomTrigger({
        text: value,
        members,
        adminId: room.memberIds[0],
        ...(quotedBotId !== undefined ? { quotedBotId } : {}),
      })
      /*
       * 被上限挤掉的成员必须说出来。原实现是 `mentioned.slice(0, 2)` 静默丢弃：
       * 第 3 个被 @ 的成员永远不回复，用户只会以为它坏了。
       */
      if (trigger.overflow.length > 0) {
        const skipped = trigger.overflow.map((item) => item.name).join('、')
        toast(`一次最多编排 ${trigger.responders.length} 位成员，${skipped} 这次没接：可以分开 @，或让群主转派`)
      }
      /*
       * 群里一个可用成员都没有：消息已经落在对话流里（用户看得见），但不会有
       * 任何回复。必须给一句可见的说明——静默在这里等于「消息发丢了」。
       */
      if (trigger.responders.length === 0) {
        toast('这个群里没有可回复的成员：先在群设置里加一个 Bot')
        return
      }
      /*
       * 先把所有排期项一次建好，再各自启动。
       *
       * 必须一次建好：排在后面的成员要看「上一位启动了没有」，而这个判断依赖
       * 上一位那条排期项的 started 标记——边建边启动会让它读到 undefined。
       */
      const scheduledList: ScheduledReply[] = trigger.responders.map((responder) => ({
        botId: responder.id,
        ...(roomId !== undefined ? { roomId } : {}),
        cancelled: false,
        started: false,
      }))
      for (const scheduled of scheduledList) scheduledRepliesRef.current.add(scheduled)

      scheduledList.forEach((scheduled, index) => {
        const responder = trigger.responders[index]
        const start = (): void => {
          scheduled.started = true
          scheduledRepliesRef.current.delete(scheduled)
          if (scheduled.cancelled) return
          replyAsBot(responder, value, { roomId, source: 'chat', ...(quote !== undefined ? { quote } : {}) }, images, userMessageId)
        }

        if (index === 0) {
          later(300, start)
          return
        }

        /*
         * 成员之间**等上一位把这一轮说完**再开始，不是固定错峰。
         *
         * 原来三个人各自 300 / 1000 / 1700ms 后启动，而一轮回复要几十秒：第二个
         * 成员开口时第一个的正文还在流式生成（消息仍是 pending），它既看不到前面
         * 说了什么，「多视角评审」也就退化成三个人各自回答同一段背景。
         *
         * 判据用 runningReplyTurnsRef 而不是某个 promise：那一组 ref 记录的就是
         * 「现在谁在跑」，和停止键共用同一个真相，不会出现「点了停止还在等一个
         * 永远不结束的 promise」。
         */
        const previous = scheduledList[index - 1]
        const previousBotId = trigger.responders[index - 1].id
        const queuedAt = Date.now()
        const waitPrevious = (): void => {
          // 停止键已经取消了这一轮：不必再等（start 里还会再检查一次）
          if (scheduled.cancelled) {
            scheduledRepliesRef.current.delete(scheduled)
            return
          }
          const decision = shouldStartNext({
            previousStarted: previous.started,
            previousCancelled: previous.cancelled,
            previousRunning: previous.started
              && [...runningReplyTurnsRef.current].some((turn) => turn.botId === previousBotId && turn.roomId === roomId),
            elapsedMs: Date.now() - queuedAt,
            timeoutMs: SERIAL_WAIT_TIMEOUT_MS,
          })
          if (decision === 'start') {
            start()
            return
          }
          later(400, waitPrevious)
        }
        // 先等 700ms：上一位是 300ms 后启动的，要给它时间把轮次挂进 Set
        later(700, waitPrevious)
      })
      return
    }
    /*
     * 私聊里的 @ 交给宿主去理解：解析成 { id, name } 随请求带上，宿主注入一段
     * 「用户点名要交给 X」的上下文，主 Bot 再决定用 coordinate_bots 派出去。
     * 群聊那一支已经由 room-trigger 判定谁接话，这里不掺和（多带一份反而会让
     * 接话的人以为自己也该再派一次）。
     */
    const mentions = parseMentions(value, current.bots.filter((item) => item.id !== bot.id))
    replyAsBot(bot, value, {
      ...(quote !== undefined ? { quote } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    }, images, userMessageId)
  }, [appendMessage, later, replyAsBot, toast])

  /**
   * 停止当前会话正在进行的回复（输入框的停止键）。
   *
   * 三件事缺一不可：
   *  · 中止前端流式读取——否则 fetch 一直挂着，pending 消息永远不收口；
   *  · 通知宿主 cancel 这一轮——宿主侧的 10 分钟超时只管前端等待，agent 会继续
   *    跑工具、占着会话，用户再发消息只能排队；
   *  · 本地立刻收口——宿主返回 409（本来就没在跑）或请求根本没送达时，界面也
   *    必须停下来：用户点了停止，看到的就是停。
   *
   * 作用范围按**当前会话**算：私聊是该 Bot 的一条流，群聊是该群里所有正在回复
   * 的成员（sendMessage 会为每个被 @ 的成员各起一轮，还有几个在排队等前一位说完）。
   */
  const stopReply = useCallback((): void => {
    const current = stateRef.current
    const nowUi = uiRef.current
    const roomId = nowUi.selectedRoomId ?? undefined
    const inScope = (target: { botId: string; roomId?: string }): boolean => (roomId !== undefined
      ? target.roomId === roomId
      : target.botId === nowUi.selectedBotId && target.roomId === undefined)

    /*
     * 还在定时器里的群聊成员：直接取消，不再启动。
     *
     * 这些成员**还没落气泡**（pending 消息是在 replyAsBot 里才建的），所以取消之后
     * 界面上一点痕迹都没有——用户看到自己的消息发出去了、然后什么都没发生，
     * 只能以为群坏了。这里把数量记下来，下面无论走哪条分支都要说出来。
     */
    let cancelledScheduled = 0
    for (const scheduled of scheduledRepliesRef.current) {
      if (!inScope(scheduled)) continue
      scheduled.cancelled = true
      cancelledScheduled += 1
    }

    const turns: RunningReplyTurn[] = []
    for (const turn of runningReplyTurnsRef.current) {
      if (inScope(turn)) turns.push(turn)
    }
    const botIds = new Set<string>()
    for (const turn of turns) botIds.add(turn.botId)
    /** 有活着的轮次会自己收口的任务：不能再收一次，否则时间线会多一条「结束」。 */
    const liveTaskIds = new Set<string>()
    for (const turn of turns) liveTaskIds.add(turn.taskId)

    /*
     * 兜底一：界面上还有 pending 消息，但没有活着的轮次（例如这一轮是在别的窗口
     * 发起的、或状态恢复了一半）。没有任何 finish() 会来收口它们，这里自己把
     * 消息收掉，不能让界面永远转圈。
     */
    const staleBotIds = new Set<string>()
    for (const message of current.messages) {
      if (message.role !== 'bot' || message.pending !== true) continue
      const scoped = inScope({ botId: message.botId, ...(message.roomId !== undefined ? { roomId: message.roomId } : {}) })
      if (!scoped || botIds.has(message.botId)) continue
      staleBotIds.add(message.botId)
      botIds.add(message.botId)
    }

    /*
     * 兜底二：**孤儿任务记录**——状态还挂着 running，但没有任何轮次会来收口它。
     *
     * 这条路径以前是缺口（2026-11-02 实测）：只要界面上的 pending 消息已经被
     * 清掉（页面重载后 normalizeState 会清、多窗口同步会清、宿主补发也会把它
     * 收口），上面的 staleBotIds 就是空的，于是 `if (botIds.size === 0) return`
     * 直接返回——用户点一百次停止都没反应，右栏那条任务记录永远转齿轮。
     * 停止键必须能把孤儿任务收掉，哪怕一条 pending 消息都没有。
     */
    const orphanTasks = current.tasks.filter((task) => task.status === 'running'
      && !liveTaskIds.has(task.id)
      && inScope({ botId: task.botId, ...(task.roomId !== undefined ? { roomId: task.roomId } : {}) }))
    /* 孤儿任务说明宿主那一轮可能还在跑：也给它所在的 bot 发停止请求。 */
    for (const task of orphanTasks) botIds.add(task.botId)

    if (botIds.size === 0) {
      // 只取消了「还没开始」的成员（群里可能就一个发言人，此时没有任何在跑的轮次）
      if (cancelledScheduled > 0) toast(`已取消 ${cancelledScheduled} 位还没开始接话的成员`)
      return
    }

    for (const turn of turns) turn.abort()

    /* 孤儿任务没有 abort 会来收口，这里直接标停止（幂等：只有 running 才动）。 */
    for (const task of orphanTasks) finishTaskRecord(task.id, 'stopped', [], '已停止')

    if (staleBotIds.size > 0) {
      setState((prev) => ({
        ...prev,
        messages: prev.messages.map((message) => {
          if (message.role !== 'bot' || message.pending !== true || !staleBotIds.has(message.botId)) return message
          const blocks = interruptRunningBlocks(message.blocks)
          return { ...message, pending: false, blocks: [...blocks, { type: 'text' as const, text: '已停止' }] }
        }),
      }))
    }

    /*
     * 宿主侧停止：群聊可能有多个成员同时在跑，逐个 bot 发。409 = 宿主本来就没
     * 在跑（已经跑完 / 已停过），不算错误；网络失败也照样收口，但要告诉用户
     * 「宿主可能还在跑」——本地停了不等于上游停了。
     */
    void Promise.all([...botIds].map(async (botId) => {
      try {
        const response = await fetch('/api/personal-agent/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ botId }),
        })
        return response.ok || response.status === 409
      } catch {
        return false
      }
    })).then((results) => {
      const failed = results.filter((ok) => !ok).length
      const cancelNote = cancelledScheduled > 0 ? `，另有 ${cancelledScheduled} 位还没开始接话的成员已取消` : ''
      toast(failed === 0 ? `已停止${cancelNote}` : `已停止显示${cancelNote}；宿主侧可能还在跑（停止请求没送达）`)
    })
  }, [finishTaskRecord, toast])

  /*
   * 把停止键的实现交给 sendMessage（见 stopReplyRef 的说明）。
   * 放 effect 而不是渲染期直接赋值：effect 里写 ref 不会在并发渲染下读到半成品。
   */
  useEffect(() => {
    stopReplyRef.current = stopReply
  }, [stopReply])

  const createBot = useCallback(async (input: NewBotInput): Promise<Bot> => {
    const suggestion = NEW_BOT_SUGGESTIONS[Math.floor(Math.random() * NEW_BOT_SUGGESTIONS.length)]
    const role = (input.role ?? '').trim() || (input.description ?? '').trim() || suggestion.role
    const description = (input.description ?? '').trim() || suggestion.description
    const appearance = randomBotAppearance()
    const bot: Bot = {
      id: shortId('bot'),
      name: (input.name ?? '').trim() || (role.length > 12 ? role.slice(0, 12) : role) || '新助手',
      role,
      description,
      instructions: input.instructions ?? `你是「${input.name ?? role}」，${description} 说话直接、具体，先给结论再解释。`,
      // 完整头像优先（新建弹窗里选了形状 / 颜色 / 本地图片）；否则按 color+shape 或随机外观
      avatar: input.avatar ?? { shape: input.shape ?? appearance.shape, color: input.color ?? appearance.color, tint: appearance.tint },
      groupId: input.groupId ?? DEFAULT_GROUP_ID,
      isMain: false,
      status: 'online',
      unread: 1,
      pinned: false,
      enabled: true,
      model: MODEL_FALLBACK,
      skills: [],
      // 新建时可以顺手选音色；空串 = 跟随全局默认，就不落这个字段
      ...(input.voice !== undefined && input.voice !== '' ? { voice: input.voice } : {}),
      // 通话用的 Live 供应商同理：空串 = 跟随全局默认，不落字段
      ...(input.liveVendor !== undefined && input.liveVendor !== '' ? { liveVendor: input.liveVendor } : {}),
      permission: 'full',
      eli5Mode: input.eli5Mode ?? true,
      proactive: { enabled: true, freq: 'daily', from: '09:00', to: '22:00' },
      createdAt: Date.now(),
      createdBy: MAIN_BOT_ID,
    }
    setState((prev) => ({ ...prev, bots: [...prev.bots, bot] }))
    setUi((prev) => ({ ...prev, selectedBotId: bot.id, selectedRoomId: null, newBotOpen: false, rightTab: 'detail' }))
    // 先落一条 pending 消息，再让真实模型按该 Bot 的岗位做自我介绍；host 不可用时
    // 才用带选项的本地欢迎消息兜底。
    const firstId = shortId('msg')
    appendMessage({
      id: firstId,
      botId: bot.id,
      role: 'bot',
      at: Date.now(),
      blocks: [],
      pending: true,
      source: 'proactive',
    })
    const remote = await hostReply(bot, '你刚刚被创建。请用你的岗位和简介做一次简短自我介绍，并问我希望你先做什么。', stateRef.current)
    // 失败就直说，不用本地模板假装自我介绍（见 isDemoMode 的说明）
    const blocks: MessageBlock[] = remote !== null && remote.length > 0
      ? remote
      : isDemoMode()
        ? firstBotMessage(bot)
        : [{ type: 'text', text: '自我介绍没能生成：宿主没有返回内容（agent 可能没起来，详见宿主日志）。' }]
    replaceMessage(firstId, blocks)
    setState((prev) => ({
      ...prev,
      bots: prev.bots.map((item) => (item.id === bot.id ? { ...item, lastMessage: truncate(blocksToText(blocks)), lastAt: Date.now() } : item)),
    }))
    toast(`已创建「${bot.name}」，它的第一条消息到了`)
    return bot
  }, [appendMessage, replaceMessage, toast])

  const updateBot = useCallback((id: string, patch: Partial<Bot>): void => {
    setState((prev) => ({ ...prev, bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot)) }))
  }, [])

  const deleteBot = useCallback((id: string): void => {
    setState((prev) => ({
      ...prev,
      bots: prev.bots.filter((bot) => bot.id !== id || bot.isMain),
      rooms: prev.rooms.map((room) => ({ ...room, memberIds: room.memberIds.filter((memberId) => memberId !== id) })),
      memories: prev.memories.filter((item) => item.botId !== id),
      routines: prev.routines.filter((item) => item.botId !== id),
      // 任务记录跟着 Bot 一起删：留下一条指向不存在 Bot 的任务只会让详情卡出空数据
      tasks: prev.tasks.filter((task) => task.botId !== id),
      /*
       * 历史对话归档也要跟着删：归档条目的 botId 已不存在，留在「历史对话」里
       * 就是一条点开没有归属的孤儿记录（用户实测删完 Bot 后还看到它）。
       */
      archivedSessions: prev.archivedSessions.filter((session) => session.botId !== id),
    }))
    setUi((prev) => ({ ...prev, selectedBotId: prev.selectedBotId === id ? MAIN_BOT_ID : prev.selectedBotId }))
    /*
     * 让宿主把它的痕迹一起清掉。
     *
     * 只删本地状态是不够的：会话历史、派活花名册、工作记忆、产出物映射、Bot 页面、
     * 记忆条目、例行任务配置全都还在宿主侧。其中最要命的是花名册——主 Bot 的可派
     * 名单读的就是它，不摘的话用户明明删了 Bot，主 Bot 下一轮还能往那个「已删除」的
     * Bot 派活。
     *
     * 这条路由**内部已经包含抹账本**（否则下次打开页面启动补发会把它建回来），
     * 所以不再单独调 `DELETE /bots/created`。
     *
     * 产出物目录默认**保留**（那是用户让它生成的真实文件），响应里带回绝对路径，
     * 这里补一条提示让用户知道东西还在哪。失败静默：本地删除已经生效，不该因为
     * 一次清理请求没送达就弹红。
     */
    if (!isDemoMode()) {
      void fetch(`/api/personal-agent/bots?botId=${encodeURIComponent(id)}`, { method: 'DELETE' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.ok !== true) return
          if (typeof data.outputDir === 'string' && data.outputPurged !== true) {
            toast(`产出物文件还在：${data.outputDir}`)
          }
        })
        .catch(() => undefined)
    }
    toast('已删除该 Bot')
  }, [toast])

  const setBotEnabled = useCallback((id: string, enabled: boolean): void => {
    setState((prev) => ({ ...prev, bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, enabled, status: enabled ? 'online' : 'idle' } : bot)) }))
  }, [])

  const setBotPinned = useCallback((id: string, pinned: boolean): void => {
    setState((prev) => ({ ...prev, bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, pinned } : bot)) }))
  }, [])

  const moveBot = useCallback((id: string, groupId: string): void => {
    setState((prev) => ({ ...prev, bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, groupId } : bot)) }))
  }, [])

  const createGroup = useCallback((name: string): void => {
    const value = name.trim()
    if (value === '') return
    setState((prev) => ({ ...prev, groups: [...prev.groups, { id: shortId('group'), name: value, order: prev.groups.length }] }))
  }, [])

  const renameGroup = useCallback((id: string, name: string): void => {
    setState((prev) => ({ ...prev, groups: prev.groups.map((group) => (group.id === id ? { ...group, name } : group)) }))
  }, [])

  const deleteGroup = useCallback((id: string): void => {
    if (id === DEFAULT_GROUP_ID) return
    setState((prev) => ({
      ...prev,
      groups: prev.groups.filter((group) => group.id !== id),
      bots: prev.bots.map((bot) => (bot.groupId === id ? { ...bot, groupId: DEFAULT_GROUP_ID } : bot)),
    }))
  }, [])

  const createRoom = useCallback((name: string, memberIds: string[], avatar?: Avatar): string => {
    const id = shortId('room')
    const members = memberIds.length > 0 ? memberIds : [MAIN_BOT_ID]
    setState((prev) => ({
      ...prev,
      rooms: [...prev.rooms, {
        id,
        name: name.trim() || '新群聊',
        memberIds: members,
        unread: 0,
        ...(avatar !== undefined ? { avatar } : {}),
        modelMode: 'inherit',
        createdAt: Date.now(),
      }],
    }))
    /*
     * 创建即选中：不能等调用方再 selectRoom(id)。
     *
     * selectRoom 从 stateRef.current.rooms 里找房间，而 stateRef 要到下一轮 render
     * 才更新；刚创建的房间还不在里面，右栏的 selectedBotId 会继续停在上一个私聊
     * 对象上（聊天头已经是新群聊、右栏却是别的 Bot）。这里在同一个批次里把
     * selectedRoomId / selectedBotId 一起写好，右栏立刻落到群主成员。
     */
    setUi((prev) => ({
      ...prev,
      selectedRoomId: id,
      selectedBotId: members[0] ?? prev.selectedBotId,
      view: 'chat',
      rightTab: 'detail',
    }))
    return id
  }, [])

  const updateRoom = useCallback((id: string, patch: Partial<{ name: string; memberIds: string[]; avatar: Avatar; modelMode: 'inherit' | 'unified'; unifiedModel: BotModel }>): void => {
    setState((prev) => ({ ...prev, rooms: prev.rooms.map((room) => (room.id === id ? { ...room, ...patch } : room)) }))
  }, [])

  const setRoomPinned = useCallback((id: string, pinned: boolean): void => {
    setState((prev) => ({ ...prev, rooms: prev.rooms.map((room) => (room.id === id ? { ...room, pinned } : room)) }))
  }, [])

  const deleteRoom = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, rooms: prev.rooms.filter((room) => room.id !== id) }))
    setUi((prev) => ({ ...prev, selectedRoomId: prev.selectedRoomId === id ? null : prev.selectedRoomId }))
  }, [])

  const answerInteractive = useCallback((messageId: string, value: AnswerValue): void => {
    const current = stateRef.current
    const message = current.messages.find((item) => item.id === messageId)
    if (!message) return
    const block = message.blocks.find((item) => item.type === 'interactive')
    if (!block || block.type !== 'interactive') return
    /*
     * 审批卡 / 问答卡：决定必须回传给宿主——那里各挂着一个 Promise，agent 在等它。
     *
     * 判断依据是 **hostId** 而不是 `message.id`：前端消息 id 是 shortId 生成的，
     * 与 host 无关；凭它永远匹配不上 `apmsg-` / `qmsg-` 前缀，于是会掉进下面的
     * 本地「回答交互卡」逻辑——表现为「选了以后本地追加一条用户消息、再跑一轮」，
     * 而宿主那边仍在原地等（实测用户报「选择了但被挂起，没发出去」）。
     *
     * 回传后**直接 return**：卡片的已决定状态由宿主推 `message-update` 过来，
     * 本地再改一次会和它打架；也**不**追加用户消息、不再发一轮——答案本身已经
     * 让宿主那一轮继续跑了，用户要的只是「卡片上显示我选了哪个」。
     */
    const hostId = message.hostId ?? ''
    if (hostId.startsWith('apmsg-')) {
      const approvalId = hostId.slice('apmsg-'.length)
      if (approvalId === '') return
      /*
       * 按按钮 id **原样**回传：allow / allow-always / deny。
       *
       * 这里曾经写成 `value === 'allow' ? 'allow' : 'deny'`——任何非 allow 的按钮
       * 都会被静默变成拒绝：用户点「以后都允许」，操作反而被拒，还没有任何提示。
       * 只放行白名单，其余（旧卡片 / 脏数据）一律 deny，绝不让未知值意外放行。
       */
      const decision = value === 'allow' || value === 'allow-always' || value === 'deny' ? value : 'deny'
      void fetch('/api/personal-agent/approval/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvalId, decision }),
      })
        .then((response) => {
          if (!response.ok) toast('这条审批已经失效（超时或已处理）')
        })
        .catch(() => toast('审批回传失败'))
      return
    }
    if (hostId.startsWith('qmsg-')) {
      const questionId = hostId.slice('qmsg-'.length)
      if (questionId === '') return
      void fetch('/api/personal-agent/question/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          questionId,
          selected: typeof value === 'string' && value !== '' ? [value] : [],
        }),
      })
        .then((response) => {
          if (!response.ok) toast('这个问题已经失效（超时或已回答）')
        })
        .catch(() => toast('回答回传失败'))
      return
    }
    const label = uiTextForAnswer(block.ui, value)
    const bot = current.bots.find((item) => item.id === message.botId)
    if (!bot) return

    setState((prev) => ({
      ...prev,
      messages: prev.messages.map((item) => (item.id === messageId
        ? {
            ...item,
            blocks: item.blocks.map((b) => (b === block ? { ...b, submitted: true, result: label, resultAt: Date.now() } : b)),
          }
        : item)),
    }))

    const replyTarget = message.roomId ? { roomId: message.roomId } : {}
    appendMessage({
      id: shortId('msg'),
      botId: bot.id,
      ...replyTarget,
      role: 'user',
      at: Date.now(),
      blocks: [{ type: 'text', text: label }],
      source: 'chat',
    })
    setState((prev) => ({ ...prev, lastUserMessageAt: Date.now() }))

    // 特定动作的真实副作用
    if (typeof value === 'string' && value === 'save-memory') {
      /*
       * 写进宿主记忆引擎（owner = 该 Bot），不再往 localStorage 的 memories 里塞。
       * 后者已退出注入与面板两条链路，再写只会产生「用户看不到、模型也读不到」
       * 的幽灵记忆。
       */
      void fetch('/api/personal-agent/memory/remember', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: bot.id, content: block.prompt ?? label, tags: ['交互卡'] }),
      }).catch(() => undefined)
    }
    if (block.ui.kind === 'form' && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, string>
      const time = record.time || record['时间'] || '09:00'
      const name = record.title || record['提醒内容'] || `${bot.name}的例行任务`
      if (/^\d{2}:\d{2}$/.test(time)) {
        const routine: Routine = {
          id: shortId('rt'),
          botId: bot.id,
          name,
          instruction: block.prompt ?? name,
          schedule: { kind: 'daily', time },
          enabled: true,
          createdAt: Date.now(),
          runs: [],
          nextAt: nextRoutineAt({ id: '', botId: bot.id, name, instruction: '', schedule: { kind: 'daily', time }, enabled: true, createdAt: Date.now(), runs: [] }),
        }
        setState((prev) => ({ ...prev, routines: [...prev.routines, routine] }))
      }
    }

    later(500 + Math.random() * 400, () => replyAsBot(bot, `用户选择了：${label}`, { ...replyTarget }))
  }, [appendMessage, later, replyAsBot, toast])

  /**
   * 撤回一条用户消息（连带这一轮的回复、记忆与上下文入口）。
   *
   * 两段都在纯函数里：planRecall 算「删哪些、记忆窗口在哪」，applyRecall 把计划
   * 落到 state 上（删消息 + 删记忆 + 原位置插系统提示 + 重算侧栏摘要）。这里只负责
   * 串起来，并按契约「先本地、后宿主」：本地状态先落，再尽力通知宿主，**不 await**。
   */
  const recallMessage = useCallback((messageId: string): void => {
    const plan = planRecall(stateRef.current.messages, messageId)
    // 不是用户消息 / 消息已经不在了：没有可撤回的东西
    if (plan === null) return
    setState((prev) => applyRecall(prev, plan))
    /*
     * 本地已经撤干净了，最后再尽力让宿主把模型上下文也遮蔽掉（失败静默）。
     *
     * 群聊里这一轮可能不止一个 bot 接话：逐个会话撤回，否则主发言 bot 的
     * 上下文干净了，其他成员仍然记得这条消息。
     */
    const botsById = new Map(stateRef.current.bots.map((bot) => [bot.id, bot]))
    for (const botId of plan.botIds) {
      void hostRecallTurn(botId, plan.text, plan.at, botsById.get(botId), plan.hostMessageId)
    }
  }, [])

  /**
   * 给一条主动消息打 / 改 / 清「继续提醒 / 不再提醒」标记。
   *
   * 契约是「先本地、后宿主」：本地消息字段立即更新（界面不必等网络），非演示
   * 模式下再尽力 POST 给宿主持久化。宿主失败时**不回滚**——用户刚点的标记不该
   * 因为一次网络抖动从界面上消失；只额外 toast 说明「仅保存在本地」。
   */
  const setProactiveMark = useCallback((messageId: string, kind: ProactiveMarkKind | null): void => {
    const message = stateRef.current.messages.find((item) => item.id === messageId)
    // 消息已经被清理 / 换了会话：没有可标记的对象
    if (message === undefined) return
    const at = Date.now()
    setState((prev) => ({
      ...prev,
      messages: prev.messages.map((item) => {
        if (item.id !== messageId) return item
        if (kind === null) {
          const next = { ...item }
          delete next.proactiveMark
          delete next.proactiveMarkAt
          return next
        }
        return { ...item, proactiveMark: kind, proactiveMarkAt: at }
      }),
    }))
    const successText = kind === 'keep' ? '已标记：以后继续提醒' : kind === 'mute' ? '已标记：以后不再提醒' : '已清除提醒标记'
    if (isDemoMode()) {
      toast(successText)
      return
    }
    /* 正文摘要只取 text 块：工具流水 / 卡片不是「提醒内容」，宿主提示词里也用不上。 */
    const text = truncate(
      message.blocks
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter((part) => part !== '')
        .join(' '),
      200,
    )
    void (async () => {
      try {
        const response = await fetch('/api/personal-agent/proactive/marks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            botId: message.botId,
            messageId: message.hostId ?? message.id,
            text,
            kind,
          }),
        })
        const payload = (await response.json().catch(() => null)) as { ok?: boolean } | null
        if (!response.ok || payload?.ok !== true) throw new Error(`HTTP ${response.status}`)
        toast(successText)
      } catch {
        toast('标记仅保存在本地，宿主未同步')
      }
    })()
  }, [toast])

  const addMemory = useCallback((botId: string, text: string, tags: string[] = ['手动']): void => {
    const value = text.trim()
    if (value === '') return
    setState((prev) => ({ ...prev, memories: [...prev.memories, memoryFromText(botId, value, tags)] }))
    toast('已记进该 Bot 的独立记忆')
  }, [toast])

  const deleteMemory = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, memories: prev.memories.filter((item) => item.id !== id) }))
  }, [])

  const createRoutine = useCallback((input: { botId: string; name: string; instruction: string; schedule: Routine['schedule'] }): void => {
    const routine: Routine = {
      id: shortId('rt'),
      botId: input.botId,
      name: input.name.trim() || '未命名任务',
      instruction: input.instruction.trim(),
      schedule: input.schedule,
      enabled: true,
      createdAt: Date.now(),
      runs: [],
    }
    routine.nextAt = nextRoutineAt(routine)
    setState((prev) => ({ ...prev, routines: [...prev.routines, routine] }))
    toast('例行任务已创建')
  }, [toast])

  const toggleRoutine = useCallback((id: string): void => {
    setState((prev) => ({
      ...prev,
      routines: prev.routines.map((routine) => (routine.id === id
        ? { ...routine, enabled: !routine.enabled, nextAt: !routine.enabled ? nextRoutineAt(routine) : routine.nextAt }
        : routine)),
    }))
  }, [])

  const executeRoutine = useCallback((routine: Routine): void => {
    const bot = stateRef.current.bots.find((item) => item.id === routine.botId)
    if (!bot) return
    const at = Date.now()

    // 先记一条 running：界面上立刻能看到「正在跑」，而不是等半天没有反馈
    setState((prev) => ({
      ...prev,
      routines: prev.routines.map((item) => (item.id === routine.id
        ? {
            ...item,
            lastRunAt: at,
            runs: [...item.runs.slice(-19), { at, status: 'running' as const }],
            nextAt: item.schedule.kind === 'once' ? undefined : nextRoutineAt(item, at),
            enabled: item.schedule.kind === 'once' ? false : item.enabled,
          }
        : item)),
    }))

    /*
     * 真执行：把任务描述投给 agent，让它自己判断该查什么、跑什么。
     *
     * 旧实现是直接拼一句「例行任务已执行」再随机塞一张「已完成」卡片——那是
     * 假装干活：界面上看着有结果，实际系统里什么都没发生。现在这一轮真的会跑
     * 工具，结果也来自模型自己，失败就如实报失败。
     */
    void (async () => {
      const prompt = [
        `【例行任务】${routine.name}`,
        routine.instruction.trim() !== '' ? routine.instruction : '按你的判断检查一下当前状态，有异常就指出来。',
        '',
        '现在开始执行这个例行任务：该查就查、该跑就跑，然后把结果告诉我。',
      ].join('\n')

      let blocks: MessageBlock[]
      let status: 'ok' | 'failed'
      try {
        const remote = await hostReply(bot, prompt, stateRef.current)
        if (remote !== null) {
          blocks = remote
          status = 'ok'
        } else {
          blocks = [{ type: 'text', text: `例行任务「${routine.name}」没能执行：宿主连接不可用。` }]
          status = 'failed'
        }
      } catch {
        blocks = [{ type: 'text', text: `例行任务「${routine.name}」执行出错。` }]
        status = 'failed'
      }

      appendMessage({ id: shortId('msg'), botId: bot.id, role: 'bot', at: Date.now(), blocks, source: 'routine' })
      setState((prev) => ({
        ...prev,
        routines: prev.routines.map((item) => {
          if (item.id !== routine.id) return item
          const runs = [...item.runs]
          const last = runs[runs.length - 1]
          if (last !== undefined && last.status === 'running') runs[runs.length - 1] = { ...last, status }
          return { ...item, runs }
        }),
      }))
    })()
  }, [appendMessage])

  const runRoutine = useCallback((id: string): void => {
    const routine = stateRef.current.routines.find((item) => item.id === id)
    if (routine) executeRoutine(routine)
  }, [executeRoutine])

  const deleteRoutine = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, routines: prev.routines.filter((item) => item.id !== id) }))
  }, [])

  const proactiveNow = useCallback((botId: string): void => {
    const bot = stateRef.current.bots.find((item) => item.id === botId)
    if (!bot) return
    /*
     * 走宿主执行，与定时那条共用同一份提示词与执行路径。
     *
     * 为什么不在这里直接调 /reply：宿主跑完会把消息经 SSE 推回来，前端只需接住
     * ——如果这里再自己 append 一次，同一条主动消息会出现两遍。
     *
     * 宿主没接上时**不再退回本地模板**：那会变成「按钮点了，冒出一条看似正常的
     * 消息，其实什么都没发生」。演示页（file://）例外，那里本来就没有宿主。
     */
    void (async () => {
      try {
        const response = await fetch('/api/personal-agent/proactive/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            botId,
            botName: bot.name,
            botRole: bot.role,
            ...(bot.model !== undefined ? { botModel: bot.model } : {}),
          }),
        })
        if (response.ok) {
          toast(`「${bot.name}」发来一条主动询问`)
          return
        }
      } catch {
        /* 落到下面的失败分支 */
      }
      if (isDemoMode()) {
        appendMessage({ id: shortId('msg'), botId, role: 'bot', at: Date.now(), blocks: proactiveMessage(bot), source: 'proactive' })
        toast(`「${bot.name}」发来一条主动询问`)
        return
      }
      appendMessage({
        id: shortId('msg'),
        botId,
        role: 'bot',
        at: Date.now(),
        blocks: [{ type: 'text', text: '主动询问没能发起：宿主没接上（agent 可能没起来，详见宿主日志）。' }],
        source: 'proactive',
      })
    })()
  }, [appendMessage, toast])

  /**
   * 把某个 bot 的最近私聊整理成「接力摘要」（「整理并开新会话」的第一步）。
   *
   * 为什么在**前端**抽消息：宿主只拿得到它自己的会话历史，而界面上可能有刚发出
   * 还没落进 agent 上下文的轮次；以界面消息为准，用户看到的和摘要取材的才是同一段
   * 对话。只送最近 RELAY_MESSAGES_MAX 条，太长既费 token 也没必要。
   *
   * 失败返回 null（toast 已提示原因），确认卡里仍保留「直接清空」——
   * 「整理」是增强路径，不能因为它失败就把用户卡在弹窗里。
   */
  const prepareRelay = useCallback(async (botId: string): Promise<{ brief: RelayBrief; degraded: boolean; error?: string } | null> => {
    const bot = stateRef.current.bots.find((item) => item.id === botId)
    const label = bot?.name ?? '这个 Bot'

    // 与 clearConversation 同口径：私聊消息（群聊属于群，不参与这个 bot 的接力摘要）
    const recent = stateRef.current.messages
      .filter((message) => message.roomId === undefined
        && (message.botId === botId || message.senderId === botId)
        && message.role !== 'system'
        && message.pending !== true)
      .slice(-RELAY_MESSAGES_MAX)

    const messages: RelayMessage[] = []
    for (const message of recent) {
      // 只取正文块：图片 / 工具卡 / 期刊卡没有可摘要的自然语言
      const text = message.blocks
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter((part) => part !== '')
        .join('\n')
        .trim()
      if (text === '') continue
      messages.push({
        role: message.role === 'user' ? 'user' : 'bot',
        text,
        at: message.at,
      })
    }

    if (messages.length === 0) {
      toast(`「${label}」还没有可整理的对话`)
      return null
    }
    if (isDemoMode()) {
      toast('演示页没有宿主，无法整理对话')
      return null
    }

    try {
      /*
       * 摘要生成要过一次模型，可能十几秒：给足够超时，但别无限等——
       * 用户点完按钮会一直看到「正在整理…」，卡死比失败更糟。
       */
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120_000)
      try {
        const res = await fetch('/api/personal-agent/relay/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            botId,
            ...(bot !== undefined && bot.model !== undefined
              ? {
                  botModel: {
                    provider: bot.model.provider,
                    model: bot.model.model,
                    ...(bot.model.effort !== undefined && bot.model.effort !== ''
                      ? { effort: bot.model.effort }
                      : {}),
                  },
                }
              : {}),
            messages,
          }),
          signal: controller.signal,
        })
        const data = (await res.json()) as {
          ok?: boolean
          brief?: RelayBrief | null
          degraded?: boolean
          error?: string
        }
        if (data.ok !== true || data.brief === undefined || data.brief === null) {
          toast(`整理失败：${data.error ?? `HTTP ${res.status}`}`)
          return null
        }
        return {
          brief: data.brief,
          // 模型不可用时宿主用 fallbackRelayBrief 兜底，degraded 标记让确认卡说明情况
          degraded: data.degraded === true,
          ...(typeof data.error === 'string' && data.error !== '' ? { error: data.error } : {}),
        }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      toast('整理失败：宿主未连接或接口不可用')
      return null
    }
  }, [toast])

  /**
   * 把某个 bot 的当前私聊归档成一段「历史对话」（开新会话前的关键一步）。
   *
   * 「清模型上下文 ≠ 清聊天记录」：清空当前会话前先把消息整体存进
   * state.archivedSessions，聊天记录随时能在「历史对话」面板回看。
   * 返回归档 id；空会话没有可归档的内容，返回 null。
   */
  const archiveConversation = useCallback((botId: string, relay?: RelayBrief): string | null => {
    const record = buildArchivedSession(botId, stateRef.current.messages, relay)
    if (record === null) return null
    setState((prev) => ({
      ...prev,
      archivedSessions: [record, ...(prev.archivedSessions ?? [])].slice(0, MAX_ARCHIVED_SESSIONS),
    }))
    return record.id
  }, [])

  /**
   * 清空 / 轮转某个 bot 的**私聊**。
   *
   * 两种模式（用户明确区分过）：
   *  · **keepMessages = true（整理并开新会话）**：只切换模型上下文——宿主 commit /
   *    reset，界面消息**一条不删**，聊天记录继续留在对话流里随时往上翻；新回复
   *    接着追加。追加一条 system 提示说明已开新会话。
   *  · **keepMessages 缺省（直接清空）**：归档到历史对话后再删除当前私聊消息、
   *    重建宿主会话（原行为，破坏性操作）。
   *
   * 群聊消息**不动**。原来这里按 `botId` / `senderId` 一刀切，清一次私聊会把
   * 这个 Bot 在所有群里说过的话一起抹掉：群里的上下文对别人还在，对他已经断了，
   * 接着回复就是一副「刚才什么都没发生」的样子。私聊是私聊，群聊记录属于群。
   */
  const clearConversation = useCallback(async (botId: string, options?: { relay?: RelayBrief; keepMessages?: boolean }): Promise<void> => {
    const bot = stateRef.current.bots.find((item) => item.id === botId)
    const label = bot?.name ?? '这个 Bot'
    const keepMessages = options?.keepMessages === true

    /*
     * 自动整理（keepMessages）前先确认没有正在跑的回复：生成摘要要十几秒，
     * 期间用户可能已经发了下一条消息。此时切会话会杀掉那一轮（用户实测会看到
     * 「本轮被宿主拒绝」），所以宁可跳过这次，等下一轮再整理。
     */
    if (keepMessages && stateRef.current.messages.some((message) => message.pending === true)) {
      toast('有回复正在进行，稍后再自动整理')
      return
    }

    /*
     * 只有「直接清空」才归档 + 删消息；「整理并开新会话」保留对话流，不归档。
     *
     * archiveConversation 自己 setState 写入归档；下面的清空 setState updater
     * 会排在它后面执行，所以写 localStorage 时拿到的 next 已经包含这条归档。
     * 宿主 commit / reset 逻辑保持原样：它只清模型上下文，不影响前端历史。
     */
    if (!keepMessages) archiveConversation(botId, options?.relay)

    /*
     * 清空时**立刻写 localStorage**，不等防抖持久化。
     * 否则用户清空后顺手刷新，延迟写入还没落地，旧消息会「复活」——
     * 看起来就像清空没生效。updater 里写是幂等的（React 严格模式重复调用结果一致）。
     */
    if (!keepMessages) {
      setState((prev) => {
        const next = {
          ...prev,
          messages: prev.messages.filter((message) => message.roomId !== undefined
            || (message.botId !== botId && message.senderId !== botId)),
          bots: prev.bots.map((item) => (item.id === botId
            ? { ...item, lastMessage: '', lastAt: undefined, unread: 0 }
            : item)),
          // 任务记录同口径：群里的任务属于群，清私聊不该把它从右栏抹掉
          tasks: prev.tasks.filter((task) => task.roomId !== undefined || task.botId !== botId),
        }
        try {
          // 与防抖保存 effect 同一口径：归档里可能带大量 mergedSegments，写盘前剥掉，
          // 否则 500 条归档消息很容易顶破 localStorage 配额，导致「清空没生效」。
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next, (key, value) => (
            key === 'mergedSegments' || key === 'pagesByBot' || key === 'assignmentsByBot' ? undefined : value
          )))
        } catch {
          /* 配额满：只影响持久化，界面已经清了 */
        }
        return next
      })
    }

    /*
     * 宿主侧分两条路：
     *  · 带 relay = 「整理并开新会话」：commit 端点负责落盘摘要 + 清空会话（等价 /reset），
     *    不能再调一次 /reset——commit 已经 reset 过了，重复调用只会多一轮无谓的会话重建；
     *  · 不带 relay = 原来的「直接清空」：维持 /reset 行为不动。
     */
    if (options?.relay !== undefined) {
      try {
        const res = await fetch('/api/personal-agent/relay/commit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ botId, brief: options.relay }),
        })
        const data = await res.json() as { ok?: boolean; error?: string }
        if (data.ok === false) {
          toast(`界面消息已清空；宿主侧没清干净：${data.error ?? '未知原因'}`)
        } else {
          toast('已整理上一段对话，并开启新会话')
        }
      } catch {
        toast('界面消息已清空；宿主未连接，摘要没落盘、agent 历史留到下次重启')
      }
    } else {
      try {
        const res = await fetch('/api/personal-agent/reset', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ botId }),
        })
        const data = await res.json() as { ok?: boolean; error?: string; removed?: number }
        if (data.ok === false) {
          toast(`界面消息已清空；宿主侧没清干净：${data.error ?? '未知原因'}`)
        } else {
          toast(`已清空「${label}」的全部对话`)
        }
      } catch {
        toast('界面消息已清空（宿主未连接，agent 历史留到下次重启）')
      }
    }

    /*
     * 「整理并开新会话」：对话流一条不删，只追加一条 system 提示。
     *
     * 用户的要求是「旧聊天记录一直留在对话里，随时可以翻阅」——所以这里绝不能
     * 走下面的清空 / reload。新会话的回复会继续追加在同一条消息流后面。
     */
    if (keepMessages) {
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, {
          id: shortId('msg'),
          botId,
          role: 'system',
          at: Date.now(),
          blocks: [{ type: 'text', text: '已整理上一段对话并开启新会话，聊天记录保留在这里。' }],
        }],
      }))
      toast('已开启新会话，聊天记录保留')
      return
    }

    /*
     * 最后**强制重载页面**。
     *
     * 为什么不只靠 setState：清空是低频的破坏性操作，而这条链路上有防抖持久化、
     * React 批处理、可能的并发写入——任何一个时序没对齐，用户就会看到「点了没清掉」。
     * 重载后界面完全从 localStorage 重建，而 localStorage 在上一行已经写干净了，
     * 所以结果只有一种：消息确实没了。代价只是一次刷新（Bot 模式状态会恢复）。
     */
    window.setTimeout(() => {
      try {
        window.location.reload()
      } catch {
        /* 独立演示页里可能不允许 reload：忽略 */
      }
    }, 260)
  }, [toast, archiveConversation])

  /**
   * 删除一条历史对话归档。
   *
   * 只删前端本地记录（宿主侧会话文件不受影响）；历史面板是低频只读场景，
   * 删除不做二次确认，界面 toast 由调用方给。
   */
  const deleteArchivedSession = useCallback((id: string): void => {
    setState((prev) => ({
      ...prev,
      archivedSessions: (prev.archivedSessions ?? []).filter((session) => session.id !== id),
    }))
  }, [])

  /**
   * 生成一期期刊（**宿主模型优先，本地模板兜底**）。
   *
   * 时序：
   *  1. 先按当天真实消息构建素材（`journalFeedFromState`）；
   *  2. 非演示页 POST `/journal/generate` 让宿主用真实模型生成；成功就采用宿主返回的期刊；
   *  3. 宿主不可用 / 生成失败 → `buildJournal` 本地回退（真实统计 + 真实摘录），并 toast 说明；
   *  4. 缺图时补图：宿主生成成功但没图 → `/journal/image`，失败 / 本地回退 → 程序化封面；
   *  5. upsert 进 `state.journals`（**不重复 append**）、在会话里放期刊卡、按 auto 决定是否打开阅读器。
   */
  const generateJournal = useCallback(async (botId: string, opts: { auto?: boolean; date?: Date } = {}): Promise<Journal> => {
    const date = opts.date ?? new Date()
    const state = stateRef.current
    const bot = state.bots.find((item) => item.id === botId)
    const feed = journalFeedFromState(state, botId, date)

    let hostJournal: Journal | null = null
    if (!isDemoMode()) {
      hostJournal = await hostJournalGenerate({
        botId,
        botName: bot?.name ?? 'Seeker',
        botRole: bot?.role ?? '',
        ...(bot !== undefined ? { botModel: bot.model } : {}),
        date: journalDateKey(date),
        auto: opts.auto ?? false,
        messages: feed.messages,
        stats: feed.stats,
        lastUserMessageAt: state.lastUserMessageAt,
      })
    }

    // 宿主不可用（且不是演示页）才提示回退；演示页本来就没有宿主
    const hostFailed = hostJournal === null && !isDemoMode()
    let journal: Journal = hostJournal ?? buildJournal(stateRef.current, botId, { auto: opts.auto, date })

    if (journal.image === undefined || journal.image === '') {
      if (hostJournal !== null) {
        // 宿主生成成功但没带图：补一次生图，失败就用程序化封面
        const remote = await hostJournalImage(journal)
        journal = { ...journal, image: remote ?? journalCoverSvg(journal) }
      } else {
        // 本地回退：宿主都不可用，生图大概率也不可用，直接用程序化封面，不额外等超时
        journal = { ...journal, image: journalCoverSvg(journal) }
      }
    }

    /*
     * 按 id upsert，不 append：宿主生成时 SSE 可能已经把同一期推过来了，再插一份
     * 界面上就会出现两期同 id 的期刊（旧实现踩过）。
     */
    const record = journal
    setState((prev) => ({
      ...prev,
      journals: upsertJournal(prev.journals, record),
      journalStatus: { generating: false, lastGeneratedAt: record.generatedAt },
    }))

    // 主 bot 的会话里放一张期刊卡，便于从对话直接打开
    appendMessage({
      id: shortId('msg'),
      botId,
      role: 'bot',
      at: Date.now(),
      blocks: [{ type: 'journal', journalId: record.id, title: record.title, date: record.dateLabel, image: record.image, summary: record.summary }],
      source: 'system',
    })
    if (opts.auto !== true) {
      setUi((prev) => ({ ...prev, journalOpenId: record.id, view: 'journal' }))
    } else {
      setUi((prev) => ({ ...prev, view: 'chat' }))
    }
    // 宿主回退时把「这是本地版」说清楚，避免用户以为模型真的写了这一期
    toast(hostFailed
      ? '宿主模型不可用，已生成本地版期刊'
      : (opts.auto === true ? '已自动生成昨天的期刊' : '期刊日记已生成'))
    return record
  }, [appendMessage, toast])

  /**
   * 检查期刊触发条件。
   *
   * 签名保持**同步**：调用方（规则面板 / 侧栏 / 30 秒定时器）拿返回值直接 toast，
   * 不能等 HTTP。因此这里分两段：
   *  · 同步返回本地规则判定（只判定，不生成）——给界面即时反馈；
   *  · 非演示页把判定交给宿主（`/journal/check`，宿主满足条件时会自己生成并落盘），
   *    宿主结果异步写入 `state.journalLogs`；宿主不可用才走本地生成（保留 fallback）。
   *
   * 为什么非演示页不在本地生成：宿主调度器才是触发者，前端再生成一份会出现两期
   * 同一天的期刊（本地版与宿主版），合并时只能靠日期去重兜底。
   */
  const runJournalCheck = useCallback((nowOverride?: number): { ok: boolean; reason: string; journalId?: string } => {
    const nowMs = nowOverride ?? Date.now()
    const localResult = evaluateJournalRule(stateRef.current, nowMs)
    const appendLog = (ok: boolean, reason: string, journalId?: string): void => {
      setState((prev) => ({
        ...prev,
        journalLogs: [{ at: Date.now(), ok, reason, ...(journalId !== undefined ? { journalId } : {}) }, ...prev.journalLogs].slice(0, 40),
      }))
    }

    // 独立演示页没有宿主：保持旧行为（本地判定 + 本地生成）
    if (isDemoMode()) {
      appendLog(localResult.ok, localResult.reason, localResult.journalId)
      if (localResult.ok) {
        const now = new Date(nowMs)
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
        void generateJournal(MAIN_BOT_ID, { auto: true, date: yesterday })
      }
      return localResult
    }

    // 上一次宿主检查还没回来就不叠加请求：下一次 tick 再试
    if (journalCheckInFlightRef.current) return localResult
    journalCheckInFlightRef.current = true
    void (async () => {
      try {
        const remote = await hostJournalCheck(nowMs)
        if (remote !== null) {
          appendLog(remote.ok, remote.reason, remote.journalId)
          // 宿主生成了：主动拉一次列表合并（SSE 也会推，但事件可能还没到 / 丢过）
          if (remote.ok && remote.journalId !== undefined) {
            const journals = await hostJournalList()
            if (journals.length > 0) {
              setState((prev) => ({ ...prev, journals: mergeJournals(prev.journals, journals) }))
            }
          }
          return
        }
        /*
         * 宿主不可用 → 本地回退：判定 + 生成（保留旧版能力，页面开着也能出期刊）。
         * 注意用**异步回来时的最新 state**，不是发起请求那一刻的快照。
         */
        const fallback = evaluateJournalRule(stateRef.current, nowMs)
        appendLog(fallback.ok, fallback.reason, fallback.journalId)
        if (fallback.ok) {
          const now = new Date(nowMs)
          const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
          void generateJournal(MAIN_BOT_ID, { auto: true, date: yesterday })
        }
      } finally {
        journalCheckInFlightRef.current = false
      }
    })()

    return localResult
  }, [generateJournal])

  /*
   * ── 全双工实时通话 ──
   *
   * 旧链路（点按录音 → DSH ASR → /reply → Edge TTS）已整条移除，**不留开关**：
   * 两套并存会让「点通话到底走哪条链路」变成一个要看设置才能回答的问题，而且旧链路
   * 那 1.2 秒假响铃会让真实建连失败看起来像「接通了但没声音」。
   *
   * 现在分工是：RealtimeCall（call/realtime-client.ts）管 WS 与音频引擎；这里只把
   * 它的回调翻译成 ui.call，并在通话结束时落一条 CallRecord。
   */

  /** 未定稿字幕合并写回 ui（节流，见 CALL_DRAFT_FLUSH_MS）。 */
  const flushCallDraft = useCallback((immediate = false): void => {
    const push = (): void => {
      const draft = callDraftRef.current
      setUi((prev) => (prev.call.status === 'idle' || (prev.call.botDraft === draft.bot && prev.call.thinkingDraft === draft.thinking)
        ? prev
        : { ...prev, call: { ...prev.call, botDraft: draft.bot, thinkingDraft: draft.thinking } }))
    }
    if (immediate) {
      if (callDraftTimerRef.current !== null) {
        clearTimeout(callDraftTimerRef.current)
        callDraftTimerRef.current = null
      }
      push()
      return
    }
    if (callDraftTimerRef.current !== null) return
    callDraftTimerRef.current = setTimeout(() => {
      callDraftTimerRef.current = null
      push()
    }, CALL_DRAFT_FLUSH_MS)
  }, [])

  /** 清空流式缓冲与排序状态（新一通电话 / 收尾时调用）。 */
  const resetCallDraft = useCallback((): void => {
    callDraftRef.current = { bot: '', thinking: '' }
    callAudioTranscriptRef.current = false
    // 未消费的占位与序号一并作废：新一轮通话不该继承上一通的排序
    callPendingUsersRef.current = []
    callSeqRef.current = 0
    // 段 id 与段内序号同理：上一通的段标记已经收尾，新通话必须是新的一段
    callSegmentRef.current = null
    callSegmentTurnsRef.current = 0
    callMessageSeqRef.current = new Map()
    if (callDraftTimerRef.current !== null) {
      clearTimeout(callDraftTimerRef.current)
      callDraftTimerRef.current = null
    }
  }, [])

  /**
   * 往通话转写里落一条，并按落库序号排序（见 call-turns.ts）。
   *
   * @param seq 落库序号。用户轮次用 `speech_stopped` 时预分配的那个，Bot 轮次现取。
   */
  const appendCallTurn = useCallback((role: 'user' | 'bot', text: string, seq: number): void => {
    const value = text.trim()
    if (value === '') return
    const at = Date.now()
    const turn = { id: shortId('turn'), role, text: value, at, seq }
    setUi((prev) => (prev.call.status === 'idle'
      ? prev
      : { ...prev, call: { ...prev.call, liveTurns: sortTurns([...prev.call.liveTurns, turn]) } }))
  }, [])

  /**
   * 原地更新一条段标记消息（**不新增消息**）。
   *
   * 段标记在通话开始时写一次，之后只改它的字段：进行中改 `turns`，ready 后补
   * `model` / `voice`，挂断时补 `endedAt` / `durationMs` 并把 `live` 置 false。
   *
   * @param segment 段 id。
   * @param update  纯函数式的改写。
   */
  const patchCallSegment = useCallback((segment: string, update: (block: CallSegmentBlock) => CallSegmentBlock): void => {
    setState((prev) => {
      const index = prev.messages.findIndex((message) => message.blocks.some(
        (block) => block.type === 'call-segment' && block.segment === segment,
      ))
      // 段标记被清掉了（清空对话 / 历史数据）：没有可更新的对象，静默跳过
      if (index < 0) return prev
      const target = prev.messages[index]
      const blocks = target.blocks.map((block) => (
        block.type === 'call-segment' && block.segment === segment ? update(block) : block
      ))
      const messages = [...prev.messages]
      messages[index] = { ...target, blocks }
      return { ...prev, messages }
    })
  }, [])

  /**
   * 删掉一条段标记消息。
   *
   * 只在一句都没说成时用（连不上 / 刚接通就挂断）：那种情况段内一条消息都没有，
   * 留在对话流里就是一条「语音通话 · 0 条」的空折叠条，点开什么都没有——比不留更糟。
   */
  const removeCallSegment = useCallback((segment: string): void => {
    setState((prev) => {
      const messages = prev.messages.filter((message) => !message.blocks.some(
        (block) => block.type === 'call-segment' && block.segment === segment,
      ))
      return messages.length === prev.messages.length ? prev : { ...prev, messages }
    })
  }, [])

  /**
   * 一轮已定稿的转写 → 一条**普通消息**进对话流（与打字聊天同一个气泡样式）。
   *
   * 这是这次改造的核心：语音不再只把转写塞在通话弹层里、等挂断才落一张通话卡。
   * 用户要的是「对话还是之前的 UI 形式」——所以这里落普通 `text` 块，只加一个
   * `callSegment` 归属标记，收起时由渲染层整段隐藏，展开后与普通消息一模一样。
   *
   * `ui.call.liveTurns` 仍然照旧维护（通话弹层里那份实时字幕还在用），两条路并存。
   *
   * @param role 谁说的。
   * @param text 定稿文本（空串直接丢弃，避免出现空气泡）。
   * @param seq  落库序号，决定它在段里的位置（见 `insertCallMessage`）。
   */
  const appendCallTranscript = useCallback((role: 'user' | 'bot', text: string, seq: number): void => {
    const value = text.trim()
    if (value === '') return
    const botId = uiRef.current.call.botId
    if (botId === null) return
    const segment = callSegmentRef.current
    const message: Message = {
      id: shortId('msg'),
      botId,
      role,
      at: Date.now(),
      blocks: [{ type: 'text', text: value }],
      source: 'call',
      ...(segment !== null ? { callSegment: segment } : {}),
    }
    if (segment === null) {
      appendMessage(message)
      return
    }
    // 先登记序号再插：insertCallMessage 要拿它跟段内已有消息比位置
    callMessageSeqRef.current.set(message.id, seq)
    appendMessage(message, { segment, seq })
    callSegmentTurnsRef.current += 1
    patchCallSegment(segment, (block) => ({ ...block, turns: callSegmentTurnsRef.current }))
  }, [appendMessage, patchCallSegment])

  /**
   * 语音里干活的产物 → 一条 bot 消息进对话流。
   *
   * 为什么产物必须进对话流：用户说「帮我生成一张图」，如果只在通话弹层里念一句
   * 「生成好了」，挂断之后那张图就再也找不到了。产物要作为一张卡留在对话里。
   *
   * 块类型的选择（`RealtimeArtifact.kind` 与现有块对应关系）：
   *  · `image` → `image` 块（`ChatImage`），与用户发图共用同一个渲染器；
   *  · `video` / `audio` / `file` → `tool` 块的 `run.artifacts`（`ArtifactRef`）：
   *    这是**现有的产出物卡通道**（`ToolArtifactsBlock` → `ArtifactCard`），渲染层
   *    不用为语音产物另开一套样式，也不存在「没有块类型可放」的问题。
   */
  const appendCallArtifacts = useCallback((artifacts: RealtimeArtifact[]): void => {
    const botId = uiRef.current.call.botId
    if (botId === null) return
    const segment = callSegmentRef.current
    const at = Date.now()
    const blocks: MessageBlock[] = []
    const files: ArtifactRef[] = []
    for (const artifact of artifacts) {
      if (artifact.url === '') continue
      if (artifact.kind === 'image') {
        const name = artifactNameOf(artifact)
        blocks.push({ type: 'image', image: { url: artifact.url, path: artifactPathOf(artifact), name } })
        continue
      }
      files.push({
        path: artifactPathOf(artifact),
        url: artifact.url,
        name: artifactNameOf(artifact),
        kind: artifact.kind,
      })
    }
    if (files.length > 0) {
      blocks.push({
        type: 'tool',
        run: {
          id: shortId('run'),
          name: '语音产物',
          status: 'ok',
          startedAt: at,
          endedAt: at,
          artifacts: files,
        },
      })
    }
    if (blocks.length === 0) return
    appendMessage({
      id: shortId('msg'),
      botId,
      role: 'bot',
      at,
      blocks,
      source: 'call',
      ...(segment !== null ? { callSegment: segment } : {}),
    })
    if (segment !== null) {
      callSegmentTurnsRef.current += 1
      patchCallSegment(segment, (block) => ({ ...block, turns: callSegmentTurnsRef.current }))
    }
  }, [appendMessage, patchCallSegment])

  /**
   * 收尾：停会话 → 把已定稿的转写落成 CallRecord → 重置 ui.call。
   *
   * @param note 给用户的一句话（链路失败原因 / 到期提示）。有内容时会 toast。
   *             一句都没说成就**不落记录**：连不上却多出一条空通话，比什么都不留更糟。
   */
  const finalizeCall = useCallback((note?: string): void => {
    const call = uiRef.current.call
    const session = callRef.current
    callRef.current = null
    if (session !== null) void session.stop()
    // 被打断时最后一句往往还没定稿：先取出来再清缓冲，否则通话记录里会少一句
    const draftText = callDraftRef.current.bot.trim()
    // 段 id 必须在 resetCallDraft 之前取：它会清掉 callSegmentRef
    const segment = callSegmentRef.current
    if (call.status === 'idle' || call.botId === null) {
      resetCallDraft()
      return
    }
    const bot = stateRef.current.bots.find((item) => item.id === call.botId) ?? null
    const endedAt = Date.now()
    const durationMs = Math.max(1000, endedAt - call.startedAt)
    /*
     * 未定稿的最后一句也要进对话流：它在通话弹层里已经显示给用户看过了，挂断时
     * 直接丢掉会让人以为「刚才那句话没了」。序号现取，落在段尾。
     */
    if (draftText !== '') appendCallTranscript('bot', draftText, (callSeqRef.current += 1))
    const messageTurns = callSegmentTurnsRef.current
    const recordTurns = [...call.liveTurns]
    if (draftText !== '') recordTurns.push({ id: shortId('turn'), role: 'bot', text: draftText, at: endedAt })
    resetCallDraft()
    setUi((prev) => ({ ...prev, call: createIdleCallUi() }))
    /*
     * 段标记收尾：**更新那一条**，不新增。
     *
     * 无论这通电话说没说成话都要收尾——段标记在通话开始时就写进对话流了，不收尾
     * 它会永远停在「通话中」。收尾放在 bot 判空之前，也是这个原因：它跟 Bot 记录
     * 在不在没关系。
     *
     * 一句都没说成时直接删掉：留一条「0 条」的空折叠条比不留更糟（点开什么都没有）。
     */
    if (segment !== null) {
      if (messageTurns === 0) {
        removeCallSegment(segment)
      } else {
        patchCallSegment(segment, (block) => ({ ...block, endedAt, durationMs, turns: messageTurns, live: false }))
      }
    }
    if (bot === null) return
    if (recordTurns.length === 0) {
      // 一句都没说成（连不上 / 刚接通就挂断）：不产生通话记录，但要有交代
      toast(note !== undefined && note !== '' ? note : '通话已结束（没有产生转写）')
      return
    }
    const record: CallRecord = {
      id: shortId('call'),
      botId: bot.id,
      startedAt: call.startedAt,
      endedAt,
      durationMs,
      turns: recordTurns,
      status: 'ended',
      engine: 'realtime',
      ...(call.realtime.model !== '' ? { model: call.realtime.model } : {}),
      ...(call.realtime.voice !== '' ? { voice: call.realtime.voice } : {}),
    }
    setState((prev) => ({ ...prev, calls: [...prev.calls, record] }))
    /*
     * 这里**不再写** `{ type: 'call', call: record }` 那种「通话卡」消息：转写与
     * 产物已经逐条以普通消息进了对话流，再补一张卡等于同一段对话出现两遍。
     * `state.calls` 里照旧落 CallRecord（通话记录还在用它）；历史数据里存下来的
     * call 块仍然照常渲染（见 MessageBlockView 与 CallMessageCard）。
     */
    /*
     * 秒数走 `formatDurationSeconds`（向下取整），与折叠条上的 mm:ss 同一个口径。
     * 这里原来用的是**四舍五入**：16.5 秒的通话，折叠条按 floor 显示 00:16、
     * 提示却按 round 说「17 秒」——同一通电话两个数，看着像计时错了。
     * 所有「N 秒」文案都必须复用这个函数，别再就地取整。
     */
    toast(note !== undefined && note !== '' ? note : `通话已结束 · ${formatDurationSeconds(durationMs)} 秒`)
  }, [appendCallTranscript, patchCallSegment, removeCallSegment, resetCallDraft, toast])

  const startCall = useCallback((botId: string): void => {
    const bot = stateRef.current.bots.find((item) => item.id === botId)
    if (bot === undefined) return
    /*
     * 上一通还在跑（用户直接点了另一个 Bot 的通话）：先把它的段标记收尾，否则
     * 那条折叠条会永远停在「通话中」。这里不补 CallRecord —— 与原来「直接 stop
     * 旧会话」的行为一致；旧会话的转写已经以普通消息留在对话流里了。
     */
    const previousSegment = callSegmentRef.current
    if (previousSegment !== null) {
      if (callSegmentTurnsRef.current === 0) {
        // 上一通还一句话都没说：连折叠条一起撤掉，别留一条空的
        removeCallSegment(previousSegment)
      } else {
        const previousEndedAt = Date.now()
        patchCallSegment(previousSegment, (block) => ({
          ...block,
          endedAt: previousEndedAt,
          durationMs: Math.max(1000, previousEndedAt - block.startedAt),
          live: false,
        }))
      }
    }
    // 已经有一通在跑：先干净收掉旧的，避免两份麦克风 / 播放器叠在一起
    const previous = callRef.current
    callRef.current = null
    if (previous !== null) void previous.stop()
    resetCallDraft()
    const startedAt = Date.now()
    /*
     * 音量在**建会话之前**读：PcmPlayer 在 `session.start()` 里就建好了，
     * 之后再设会让第一片音频按 100% 播出来（用户上一通明明调小了）。
     */
    const volume = loadCallVolume()
    /*
     * 段标记：这一通电话在对话流里的**起点**。
     *
     * 为什么一开始就写它，而不是等挂断：转写从第一轮起就以普通消息实时进对话流
     * （见 appendCallTranscript），没有这个标记，渲染层无从知道「哪几条属于同一通
     * 电话」，也就没法整段收起。
     *
     * 它自己**不带** `Message.callSegment`：折叠时它必须留在外面当折叠条，被一起
     * 藏掉就没有「展开」的入口了。
     */
    const segment = shortId('seg')
    callSegmentRef.current = segment
    callSegmentTurnsRef.current = 0
    callMessageSeqRef.current = new Map()
    appendMessage({
      id: shortId('msg'),
      botId,
      role: 'bot',
      at: startedAt,
      blocks: [{
        type: 'call-segment',
        segment,
        startedAt,
        turns: 0,
        live: true,
        engine: 'realtime',
        // 实际生效的音色要等宿主 ready 才确定（上游可能回落），先按 Bot 的选择显示
        voice: bot.voice !== undefined && bot.voice !== '' ? bot.voice : REALTIME_DEFAULT_VOICE,
      }],
      source: 'call',
    })
    setUi((prev) => ({
      ...prev,
      call: {
        ...createIdleCallUi(),
        status: 'ringing',
        botId,
        startedAt,
        volume,
        realtime: {
          phase: 'connecting',
          model: '',
          // ready 之前先显示这个 Bot 自己选的音色；没选就显示全局默认的名字。
          // 宿主 ready 后会回传**实际生效**的音色（上游可能拒绝某个音色并回落），
          // 届时以那个为准，见 onReady。
          voice: bot.voice !== undefined && bot.voice !== '' ? bot.voice : REALTIME_DEFAULT_VOICE,
        },
      },
    }))

    let session: RealtimeCall | null = null
    /** 只处理「当前这通」的事件：旧会话的迟到回调一律丢弃。 */
    const alive = (): boolean => session !== null && callRef.current === session
    const patch = (update: (call: PersonalCallUi) => PersonalCallUi): void => {
      if (!alive()) return
      setUi((prev) => (prev.call.status === 'idle' ? prev : { ...prev, call: update(prev.call) }))
    }

    const handlers: RealtimeCallHandlers = {
      onLinkState: (link) => {
        patch((call) => ({ ...call, realtime: { ...call.realtime, phase: link === 'idle' ? 'connecting' : link } }))
      },
      onReady: (info) => {
        /*
         * 重连后 onReady 会再来一次。段状态（段 id / 落库序号 / 已落条数）必须跨
         * 重连保留：清掉的话后续转写会失去段归属（不再参与折叠），序号也会从 1
         * 重新开始，把新消息插到段中间。所以这里只重置「这一轮的流式缓冲」。
         */
        const segment = callSegmentRef.current
        const seq = callSeqRef.current
        const turns = callSegmentTurnsRef.current
        const seqById = callMessageSeqRef.current
        resetCallDraft()
        callSegmentRef.current = segment
        callSeqRef.current = seq
        callSegmentTurnsRef.current = turns
        callMessageSeqRef.current = seqById
        callAudioTranscriptRef.current = false
        // 折叠条补上**实际生效**的模型与音色：上游可能拒绝某个音色并回落，以宿主为准
        if (segment !== null && alive()) {
          patchCallSegment(segment, (block) => ({ ...block, model: info.model, voice: info.voice }))
        }
        patch((call) => ({
          ...call,
          status: 'listening',
          thinking: false,
          realtime: {
            ...call.realtime,
            phase: 'open',
            model: info.model,
            voice: info.voice,
            sampleRate: info.sampleRate,
            error: undefined,
            expiresInMs: undefined,
            // 麦克风是 ready 之后才打开的：先置 undefined（= 正在打开），等 onMicReady
            micReady: undefined,
          },
        }))
      },
      onSpeechStarted: () => {
        // 用户开口 = 打断 Bot：丢掉未定稿的 Bot 字幕，立刻切回「在听」
        callDraftRef.current = { ...callDraftRef.current, bot: '' }
        callAudioTranscriptRef.current = false
        flushCallDraft(true)
        patch((call) => ({ ...call, status: 'listening', thinking: false, botDraft: '' }))
      },
      onSpeechStopped: (itemId) => {
        // 用户说完：服务端在跑 ASR + 推理，界面进「在想」；新一轮的思考文本从这里重新攒
        callDraftRef.current = { bot: '', thinking: '' }
        callAudioTranscriptRef.current = false
        flushCallDraft(true)
        /*
         * 先给这一轮**分配落库序号**（见 call-turns.ts 的文件头）：此刻一定早于模型
         * 响应，而 ASR 转写常常晚于 Bot 的转写到达。不预分配序号的话，通话记录会
         * 变成「Bot 先答、用户后问」。
         */
        callSeqRef.current += 1
        callPendingUsersRef.current.push({ itemId: itemId ?? null, seq: callSeqRef.current })
        patch((call) => ({ ...call, status: 'thinking', thinking: true, thinkingDraft: '' }))
        /*
         * 兜底：模型偶尔会「想完决定不说话」（或服务端没触发响应），界面不能一直
         * 停在「正在想」。15 秒还没有任何后续事件就退回「在听」。
         * alive() 保证旧通话的定时器不会污染新通话。
         */
        later(15_000, () => {
          if (!alive() || uiRef.current.call.status !== 'thinking') return
          patch((call) => ({ ...call, status: 'listening', thinking: false }))
        })
      },
      onUserTranscript: (text, itemId) => {
        // 按 item_id 配对（不是假设 FIFO：连说两句时转写也可能逆序返回）
        const taken = takePendingUserTurn(callPendingUsersRef.current, itemId)
        callPendingUsersRef.current = taken.rest
        // 配对不上（上游没给 item_id / 占位已被消费）：现取一个序号，至少不丢这句话
        const seq = taken.entry?.seq ?? (callSeqRef.current += 1)
        appendCallTurn('user', text, seq)
        // 实时进对话流：用户这一句立刻以**普通气泡**出现，不等挂断（与弹层字幕并存）
        appendCallTranscript('user', text, seq)
      },
      onBotTranscript: (text, final) => {
        if (!alive()) return
        if (!final) {
          // 音频转写一旦开始就丢掉之前由文本模态攒的字幕（见 callAudioTranscriptRef）
          if (!callAudioTranscriptRef.current) {
            callAudioTranscriptRef.current = true
            callDraftRef.current.bot = ''
          }
          callDraftRef.current.bot += text
          flushCallDraft()
          return
        }
        const full = text.trim()
        callDraftRef.current.bot = ''
        callAudioTranscriptRef.current = false
        flushCallDraft(true)
        const seq = (callSeqRef.current += 1)
        appendCallTurn('bot', full, seq)
        // 定稿才进对话流：增量还可能是半句话，落进去会看到气泡文字自己变长
        appendCallTranscript('bot', full, seq)
      },
      onBotText: (delta) => {
        // 文本模态兜底字幕：音频转写开始后就不再叠加，否则同一句话会出现两遍
        if (!alive() || callAudioTranscriptRef.current) return
        callDraftRef.current.bot += delta
        flushCallDraft()
      },
      onThinkingDelta: (delta) => {
        if (!alive()) return
        callDraftRef.current.thinking += delta
        flushCallDraft()
      },
      onThinkingDone: (thinking) => {
        if (!alive()) return
        callDraftRef.current.thinking = thinking
        flushCallDraft(true)
      },
      onSpeakingStart: () => {
        // 真正开始出声才切「在说」：response.created 只说明它在生成，可能还在思考
        patch((call) => (call.status === 'speaking' ? call : { ...call, status: 'speaking', thinking: false }))
      },
      onResponseCreated: () => {
        callAudioTranscriptRef.current = false
        patch((call) => (call.status === 'thinking' ? call : { ...call, status: 'thinking', thinking: true }))
      },
      onResponseDone: (status) => {
        // 一轮结束：字幕已定稿，回到「在听」。failed/incomplete 说明这轮没说完
        const failed = status === 'failed' || status === 'incomplete'
        patch((call) => ({ ...call, status: failed ? 'thinking' : 'listening', thinking: failed }))
      },
      onInterrupted: () => {
        patch((call) => ({ ...call, status: 'listening', thinking: false }))
      },
      /*
       * 语音里「让 Bot 干活」的三个事件（见 callAgentSpec 与 realtime-client 文件头）。
       *
       * 任务与对话是**并行**的：这里只更新展示状态，绝不碰 status / muted / 麦克风，
       * 否则会出现「一让它干活就听不见我说话」——那正是全双工要避免的。
       */
      onTaskStarted: (task, callId) => {
        // 新任务直接占展示位：模型可能连续派活，界面上只留最近一条
        patch((call) => ({
          ...call,
          realtime: {
            ...call.realtime,
            task: { callId, label: task, phase: 'running', startedAt: Date.now() },
          },
        }))
      },
      onTaskProgress: (note, callId) => {
        patch((call) => {
          const task = call.realtime.task
          // 旧任务迟到的进度：丢掉，不能覆盖正在展示的新任务
          if (task === undefined || task.callId !== callId) return call
          return { ...call, realtime: { ...call.realtime, task: { ...task, note } } }
        })
      },
      onTaskDone: (ok, text, callId, artifacts) => {
        patch((call) => {
          const task = call.realtime.task
          if (task === undefined || task.callId !== callId) return call
          return {
            ...call,
            realtime: {
              ...call.realtime,
              task: { ...task, phase: ok ? 'done' : 'failed', note: text, endedAt: Date.now() },
            },
          }
        })
        /*
         * 产物进对话流：语音里让它干活生成的东西（图 / 视频 / 文件）必须留下来。
         * 只让模型念一句「生成好了」是不够的——挂断之后用户要能回头看到那张图。
         * 失败时不落（artifacts 一般是空的，这里再判一次 ok 更保险）。
         */
        if (ok && artifacts !== undefined && artifacts.length > 0) appendCallArtifacts(artifacts)
        // 失败不能静默：状态条留着（11 秒），同时 toast 一次，避免用户正盯着字幕时漏掉
        if (!ok && alive()) toast(text === undefined ? '任务执行失败' : `任务执行失败：${text}`)
        // 停留几秒 → 先淡出 → 再移除：直接删一块正在显示的内容会「啪」一下消失
        later(ok ? CALL_TASK_LINGER_MS : CALL_TASK_FAIL_LINGER_MS, () => {
          patch((call) => {
            const task = call.realtime.task
            if (task === undefined || task.callId !== callId) return call
            return { ...call, realtime: { ...call.realtime, task: { ...task, fading: true } } }
          })
          later(CALL_TASK_FADE_MS, () => {
            patch((call) => {
              const task = call.realtime.task
              if (task === undefined || task.callId !== callId) return call
              return { ...call, realtime: { ...call.realtime, task: undefined } }
            })
          })
        })
      },
      onExpiring: (inMs) => {
        patch((call) => ({ ...call, realtime: { ...call.realtime, expiresInMs: inMs } }))
        if (alive()) toast(`这通电话还能聊 ${Math.max(1, Math.round(inMs / 60_000))} 分钟`)
      },
      onError: (error) => {
        patch((call) => ({ ...call, realtime: { ...call.realtime, error: error.message } }))
        if (alive()) toast(error.message)
      },
      /*
       * 语音挂断：模型已经说完道别，但播放器里通常还排着一两秒音频。
       * 先把界面切成「通话已结束」，等播放队列排空后再真正收线——立刻 stop 会把
       * 「再见」的尾音切掉。6 秒是兜底上限：音频卡住 / 浏览器挂起时不能永远不收线。
       */
      onHangup: (reason) => {
        if (!alive()) return
        patch((call) => ({ ...call, status: 'ended' }))
        const deadline = Date.now() + 6000
        const checkDrained = (): void => {
          if (!alive()) return
          // playing 变 false = 最后一句已播完；超过 6 秒也强制收线
          if (session?.playing !== true || Date.now() >= deadline) {
            finalizeCall(reason)
            return
          }
          later(120, checkDrained)
        }
        later(120, checkDrained)
      },
      onClosed: (reason) => {
        if (!alive()) return
        // 链路彻底结束：落通话记录并如实说明原因（没内容就不落，见 finalizeCall）
        finalizeCall(reason)
      },
      onMicUnavailable: (message) => {
        patch((call) => ({ ...call, realtime: { ...call.realtime, micReady: false, micError: message } }))
        if (alive()) toast(`${message}，可以直接打字提问`)
      },
      onMicReady: () => {
        patch((call) => ({ ...call, realtime: { ...call.realtime, micReady: true, micError: undefined } }))
      },
    }

    session = new RealtimeCall(handlers)
    callRef.current = session
    // 播放器还没建（start 内部才建），这里先把音量存进会话，preparePlayer 会应用它
    session.setVolume(volume)
    /*
     * 音色覆盖：这个 Bot 自己选了就随 start 帧带上（宿主原样写进上游的
     * `session.update.voice`）；没选就**不带这个字段**，让宿主走全局默认
     * （settings 的 `personal-realtime.voice`，再兜底 `linjiajiejie`）。
     * 注意不能传空串占位——宿主对「带了但为空」与「没带」的处理不同。
     */
    void session.start({
      botId,
      instructions: callInstructions(bot),
      /*
       * agent 定义：语音里「让它干活」的入口。不带它，Realtime 模型手里只有联网搜索，
       * 用户说「帮我生成一张图」时它只能回「我没有这个功能」（用户实测）。
       * 每次 start（含自动重连）都重新拼一份：重连后的新会话同样需要它。
       */
      agent: callAgentSpec(bot, stateRef.current),
      /*
       * Live 供应商：这个 Bot 自己选了就随 start 帧带上它的 id；没选就**不带这个字段**，
       * 让宿主按「全局默认 → 供应商列表第一条」回落。空值不能写进帧——宿主对
       * 「字段缺失」和「显式给空 id」的处理不同（见 RealtimeStartOptions.vendor）。
       */
      ...(bot.liveVendor !== undefined && bot.liveVendor !== '' ? { vendor: bot.liveVendor } : {}),
      ...(bot.voice !== undefined && bot.voice !== '' ? { voice: bot.voice } : {}),
      /*
       * `route` 已废弃（宿主忽略）：Live 配置不再按聊天供应商路由读取，改由
       * 「Live 供应商列表 + 上面的 vendor」决定。保留透传只为兼容还没升级的旧宿主。
       */
      ...(bot.model.provider !== '' ? { route: bot.model.provider } : {}),
    })
  }, [appendCallArtifacts, appendCallTranscript, appendCallTurn, appendMessage, finalizeCall, flushCallDraft, later, patchCallSegment, removeCallSegment, resetCallDraft, toast])

  const endCall = useCallback((): void => {
    finalizeCall()
  }, [finalizeCall])

  const callUserTurn = useCallback((text: string): void => {
    const value = text.trim()
    if (value === '') return
    const call = uiRef.current.call
    if (call.status === 'idle' || call.botId === null) return
    const session = callRef.current
    if (session === null) return
    if (!session.isReady) {
      toast('实时语音还在接通，稍等一下再发')
      return
    }
    // 打字走 text 帧：服务端不会为文本输入回 user_transcript，本地先落一条用户轮次。
    // 同样要占一个落库序号，否则这条会因为没有 seq（按 0 处理）排到整段转写最前面。
    const seq = (callSeqRef.current += 1)
    appendCallTurn('user', value, seq)
    // 打字这一轮也进对话流：否则用户会看到自己打的字只出现在通话弹层里、对话流里没有
    appendCallTranscript('user', value, seq)
    session.sendText(value)
  }, [appendCallTranscript, appendCallTurn, toast])

  const interruptCall = useCallback((): void => {
    callRef.current?.interrupt()
  }, [])

  const retryCallMicrophone = useCallback((): void => {
    const session = callRef.current
    if (session === null) return
    void session.retryMicrophone()
  }, [])

  const callLevel = useCallback((): number => callRef.current?.level() ?? 0, [])

  const setCallMuted = useCallback((muted: boolean): void => {
    callRef.current?.setMuted(muted)
    setUi((prev) => ({ ...prev, call: { ...prev.call, muted } }))
  }, [])

  const setCallSpeaker = useCallback((speaker: boolean): void => {
    callRef.current?.setSpeaker(speaker)
    setUi((prev) => ({ ...prev, call: { ...prev.call, speaker } }))
  }, [])

  /**
   * 通话音量：实时改播放增益 + 落 localStorage（下一通沿用）。
   *
   * 不走宿主配置：音量是**这台设备上的听感**，换设备本来就该按那边扬声器重调，
   * 同步到云端反而会让用户在另一台机器上莫名其妙听不见。
   */
  const setCallVolume = useCallback((volume: number): void => {
    const next = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1
    callRef.current?.setVolume(next)
    saveCallVolume(next)
    setUi((prev) => ({ ...prev, call: { ...prev.call, volume: next } }))
  }, [])

  const minimizeCall = useCallback((minimized: boolean): void => {
    setUi((prev) => ({ ...prev, call: { ...prev.call, minimized } }))
  }, [])

  /**
   * 收起 / 展开一段语音通话（点折叠条时调用）。
   *
   * 只动 `ui.collapsedCallSegments`：段内那些消息本身一个字节都不改，展开后还是
   * 普通气泡（用户的原话是「收起只是把这一段收起，而不是改变 UI 样式」）。
   * 放 ui 不放 state 的理由见 `types.ts` 的 PersonalUi 注释。
   *
   * `?? []` 兜住「ui 还没初始化这个字段」的中间态（旧 localStorage / 首帧）。
   */
  const toggleCallSegment = useCallback((segment: string): void => {
    setUi((prev) => {
      const collapsed = prev.collapsedCallSegments ?? []
      return {
        ...prev,
        collapsedCallSegments: collapsed.includes(segment)
          ? collapsed.filter((id) => id !== segment)
          : [...collapsed, segment],
      }
    })
  }, [])

  /*
   * ── 定时调度：只留日记检查，例行任务已搬到宿主 ──
   *
   * 例行任务从前端 `setInterval` 搬走的原因（三个都是实测会出问题的）：
   *   1. 页面关掉就停 —— 用户合上笔记本，Bot 就再也不主动做事；
   *   2. 多标签页各跑一遍 —— 同一条例行任务被重复执行、重复扣费；
   *   3. 状态在 localStorage —— 换设备、清缓存全没。
   * 现在由 `host/personal/scheduler.ts` 在常驻宿主进程里跑，结果经 SSE 推回来。
   *
   * 这里**绝不能**保留前端那份例行任务循环：两边都在跑等于每个任务执行两次。
   */
  useEffect(() => {
    const tick = (): void => {
      // 日记只在北京时间凌晨 0–8 点自动检查；页面一直开着时也符合规则
      runJournalCheck()
    }
    const timer = window.setInterval(tick, 30_000)
    return () => window.clearInterval(timer)
  }, [runJournalCheck])

  /*
   * 把例行任务定义同步给宿主（全量覆盖）。
   *
   * 前端是「定义」的唯一入口（用户在界面上建/改/删），宿主是「执行」的唯一场所。
   * 只在定义变化时同步，不跟消息走——`state.routines` 每条消息都会换引用。
   */
  const routineSyncKey = state.routines
    .map((routine) => `${routine.id}:${routine.enabled ? 1 : 0}:${routine.nextAt ?? 0}`)
    .join(',')
  useEffect(() => {
    if (typeof location !== 'undefined' && location.protocol === 'file:') return
    const payload = state.routines
      // 宿主只认 interval / daily / weekly；once 由前端到点跑一次，不交给宿主
      .filter((routine) => routine.schedule.kind !== 'once')
      .map((routine) => {
        const bot = state.bots.find((item) => item.id === routine.botId)
        return {
          id: routine.id,
          botId: routine.botId,
          botName: bot?.name ?? 'Bot',
          botRole: bot?.role ?? '',
          ...(bot?.model !== undefined ? { botModel: bot.model } : {}),
          name: routine.name,
          instruction: routine.instruction,
          schedule: routine.schedule,
          enabled: routine.enabled,
          ...(routine.nextAt !== undefined ? { nextAt: routine.nextAt } : {}),
        }
      })
    void fetch('/api/personal-agent/routines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routines: payload }),
    }).catch(() => undefined)
    // 只按「定义指纹」同步：routines / bots 每次渲染都可能换引用
  }, [routineSyncKey])

  /*
   * 把主动询问配置同步给宿主（全量覆盖）。
   *
   * 窗口与频率由前端定（用户在右栏改），**到点说话由宿主做**——页面关掉也要能
   * 主动找用户，这是 always-on 的另一半。
   */
  const proactiveSyncKey = state.bots
    .map((bot) => `${bot.id}:${bot.proactive.enabled ? 1 : 0}:${bot.proactive.freq}:${bot.proactive.from}:${bot.proactive.to}`)
    .join(',')
  useEffect(() => {
    if (typeof location !== 'undefined' && location.protocol === 'file:') return
    const configs = state.bots.map((bot) => ({
      botId: bot.id,
      botName: bot.name,
      botRole: bot.role,
      ...(bot.model !== undefined ? { botModel: bot.model } : {}),
      enabled: bot.proactive.enabled,
      freq: bot.proactive.freq,
      from: bot.proactive.from,
      to: bot.proactive.to,
    }))
    void fetch('/api/personal-agent/proactive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ configs }),
    }).catch(() => undefined)
    // 只按「配置指纹」同步，理由同上
  }, [proactiveSyncKey])

  /*
   * ── 期刊：素材与规则同步（宿主调度器用它们生成第二天的期刊）──
   *
   * 两条同步都只依赖「指纹」而不是整个 state：
   *  · feed 看消息条数与最后一条消息的文本长度（流式更新时文本会变长）；
   *  · rule 看规则四个字段与 lastUserMessageAt。
   *
   * 都做防抖（feed 5 秒 / rule 1 秒）：对话期间消息连续变化，逐条 POST 只会把请求
   * 打满；停下来之后再同步最终状态即可。
   */
  const lastMessage = state.messages.length > 0 ? state.messages[state.messages.length - 1] : null
  const journalFeedSyncKey = lastMessage === null
    ? '0'
    : `${String(state.messages.length)}:${lastMessage.id}:${String(blocksToText(lastMessage.blocks).length)}`
  useEffect(() => {
    if (isDemoMode()) return undefined
    // 空状态不同步：新设备 / 清过缓存的浏览器会用空 feed 覆盖宿主已有的素材
    if (state.messages.length === 0) return undefined
    const handle = window.setTimeout(() => {
      void hostJournalFeed(journalFeedForSync(stateRef.current, MAIN_BOT_ID))
    }, 5_000)
    return () => window.clearTimeout(handle)
  }, [journalFeedSyncKey])

  const journalRuleSyncKey = `${state.settings.journalRule.enabled ? 1 : 0}:${String(state.settings.journalRule.startHour)}:${String(state.settings.journalRule.endHour)}:${String(state.settings.journalRule.idleMinutes)}:${String(state.lastUserMessageAt)}`
  useEffect(() => {
    if (isDemoMode()) return undefined
    const handle = window.setTimeout(() => {
      const current = stateRef.current
      void hostJournalRule(normalizeJournalRule(current.settings.journalRule), current.lastUserMessageAt)
    }, 1_000)
    return () => window.clearTimeout(handle)
  }, [journalRuleSyncKey])

  const activeBot = useMemo(() => {
    return state.bots.find((bot) => bot.id === ui.selectedBotId) ?? state.bots[0]
  }, [state.bots, ui.selectedBotId])

  const activeRoom = useMemo(() => {
    if (!ui.selectedRoomId) return null
    const room = state.rooms.find((item) => item.id === ui.selectedRoomId)
    if (!room) return null
    return { id: room.id, name: room.name, memberIds: room.memberIds }
  }, [state.rooms, ui.selectedRoomId])

  const activeMessages = useMemo(() => {
    return state.messages
      .filter((message) => (ui.selectedRoomId ? message.roomId === ui.selectedRoomId : message.botId === ui.selectedBotId && !message.roomId))
      .slice(-200)
  }, [state.messages, ui.selectedRoomId, ui.selectedBotId])

  const actions: PersonalActions = useMemo(() => ({
    selectBot,
    selectRoom,
    setView: (view) => setUi((prev) => ({ ...prev, view })),
    setTheme,
    setRightTab: (rightTab) => setUi((prev) => ({ ...prev, rightTab })),
    toggleRightPanel: (open) => setUi((prev) => ({ ...prev, rightPanelOpen: open ?? !prev.rightPanelOpen })),
    setRightPanelWidth: (width) => setUi((prev) => ({ ...prev, rightPanelWidth: clampRightWidth(width) })),
    setChatWidth: (width) => setUi((prev) => ({ ...prev, chatWidth: clampChatWidth(width) })),
    toggleSidebar: (open) => setUi((prev) => ({ ...prev, sidebarCollapsed: open === undefined ? !prev.sidebarCollapsed : !open })),
    toggleSection: (sectionId) => setUi((prev) => {
      const current = prev.collapsedSections ?? []
      return {
        ...prev,
        collapsedSections: current.includes(sectionId)
          ? current.filter((id) => id !== sectionId)
          : [...current, sectionId],
      }
    }),
    openNewBot: (newBotOpen) => setUi((prev) => ({ ...prev, newBotOpen })),
    openBotSettings: (botSettingsOpen) => setUi((prev) => ({ ...prev, botSettingsOpen })),
    openGroupSettings: (groupSettingsOpen) => setUi((prev) => ({ ...prev, groupSettingsOpen })),
    openTaskDetail: (taskDetailId) => setUi((prev) => ({ ...prev, taskDetailId })),
    openJournal: (journalOpenId) => setUi((prev) => ({ ...prev, journalOpenId, view: journalOpenId ? 'journal' : 'chat' })),
    sendMessage,
    stopReply,
    setReplyTo: (replyTo) => setUi((prev) => ({ ...prev, replyTo })),
    createBot,
    updateBot,
    deleteBot,
    setBotEnabled,
    setBotPinned,
    moveBot,
    createGroup,
    renameGroup,
    deleteGroup,
    createRoom,
    updateRoom,
    setRoomPinned,
    deleteRoom,
    answerInteractive,
    recallMessage,
    setProactiveMark,
    /*
     * 补漏：接口里有、依赖数组里也有，但这个对象漏了它——ChatPanel 的「清空对话」
     * 直接调 `actions.clearConversation`，不补就是点击必崩（tsc 也会报 TS2741）。
     */
    prepareRelay,
    clearConversation,
    deleteArchivedSession,
    refreshPages,
    refreshAssignments,
    addMemory,
    deleteMemory,
    createRoutine,
    toggleRoutine,
    runRoutine,
    deleteRoutine,
    proactiveNow,
    generateJournal,
    runJournalCheck,
    startCall,
    endCall,
    callUserTurn,
    interruptCall,
    retryCallMicrophone,
    callLevel,
    setCallMuted,
    setCallSpeaker,
    setCallVolume,
    minimizeCall,
    toggleCallSegment,
    toast,
    clearUnread,
  }), [
    selectBot, selectRoom, setTheme, sendMessage, stopReply, createBot, updateBot, deleteBot, setBotEnabled, setBotPinned, moveBot,
    createGroup, renameGroup, deleteGroup, createRoom, updateRoom, setRoomPinned, deleteRoom, answerInteractive,
    recallMessage,
    setProactiveMark,
    addMemory, deleteMemory, createRoutine, toggleRoutine, runRoutine, deleteRoutine, proactiveNow, prepareRelay, clearConversation, deleteArchivedSession,
    refreshPages, refreshAssignments,
    generateJournal, runJournalCheck, startCall, endCall, callUserTurn, interruptCall, retryCallMicrophone,
    callLevel, setCallMuted, setCallSpeaker, setCallVolume,
    minimizeCall, toggleCallSegment, toast, clearUnread,
  ])

  const value: PersonalContextValue = useMemo(() => ({
    state,
    ui,
    actions,
    activeBot,
    activeRoom,
    activeMessages,
  }), [state, ui, actions, activeBot, activeRoom, activeMessages])

  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>
}

export function usePersonal(): PersonalContextValue {
  const value = useContext(PersonalContext)
  if (value === null) throw new Error('usePersonal must be used inside <PersonalProvider>')
  return value
}

/** 当前会话是否为群聊。 */
export function useActiveRoom(): { id: string; name: string; memberIds: string[] } | null {
  return usePersonal().activeRoom
}

/**
 * Live 供应商列表的读取状态（Bot 设置的三处入口共用）。
 *
 * 数据源是 `GET /api/personal-agent/realtime/config`：这份列表由用户在「设置 →
 * 供应商 → 实时语音」里维护，属于**宿主配置**而不是 Bot 数据，所以不进 localStorage，
 * 每次打开设置入口时现拉一次（`enabled` 从 false 变 true 就重拉）。
 *
 * 降级：接口不可用（宿主还没重启到新版本 / 独立演示页 / 404）时 `vendors` 保持
 * `null`、`error` 给出原因，调用方据此把下拉置灰并显示一行提示——**不能因为拉不到
 * 就挡住其它设置项**。
 */
export interface LiveVendorsState {
  /** 供应商列表；`null` = 还没读到（加载中或读取失败）。 */
  vendors: readonly RealtimeVendorRecord[] | null
  /** 全局默认供应商 id；空串 = 宿主没配（会回落到列表第一条）。 */
  defaultVendor: string
  loading: boolean
  /** 读不到时的原因；`null` = 一切正常。 */
  error: string | null
}

export function useLiveVendors(enabled: boolean): LiveVendorsState {
  const [vendors, setVendors] = useState<readonly RealtimeVendorRecord[] | null>(null)
  const [defaultVendor, setDefaultVendor] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await fetch(REALTIME_CONFIG_PATH, { headers: { accept: 'application/json' } })
        const data = (await res.json()) as RealtimeVendorsResponse
        if (data.ok !== true) throw new Error(data.error ?? `读取失败（HTTP ${res.status}）`)
        const raw = data.config?.vendors
        if (!Array.isArray(raw)) {
          /*
           * 接口通了但**没有 vendors 字段**：跑着的宿主还是旧版本（Live 供应商列表是
           * 新加的，只有重启到新宿主才有）。这跟「列表是空的」不是一回事，要分开说，
           * 否则用户会以为自己的供应商被删了。
           */
          if (!alive) return
          setVendors(null)
          setError('宿主还没提供 Live 供应商列表（可能版本较旧，重启宿主后可用）')
          return
        }
        if (!alive) return
        setVendors(raw)
        setDefaultVendor(data.config?.defaultVendor ?? '')
      } catch (err) {
        if (!alive) return
        // 读不到就回到「未知」状态：下拉置灰，由调用方显示原因
        setVendors(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [enabled])

  return { vendors, defaultVendor, loading, error }
}

export { STORAGE_KEY as PERSONAL_STORAGE_KEY }
