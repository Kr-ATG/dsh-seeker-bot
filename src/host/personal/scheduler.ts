/**
 * Personal Agent 的宿主任侧调度器。
 *
 * ## 为什么必须搬到宿主
 *
 * 改造前「例行任务」是前端 `window.setInterval`（`store.tsx`），它有三个致命缺陷：
 *   1. 页面关掉就停 —— 用户合上笔记本，Bot 就再也不会主动做事；
 *   2. 多标签页重复执行 —— 两个窗口各自到点各跑一次，同一件事做两遍；
 *   3. 状态在 localStorage —— 换设备、清缓存就全没了。
 *
 * 而宿主的 host 半身是**常驻 Node 进程**，天然具备「用户不在也在跑」的前提。
 * 这里把调度搬过来，前端只负责定义与展示。
 *
 * ## 与宿主 `dsh-schedule` 的关系
 *
 * 宿主的 schedule 服务确实也能定时，但它绑定的是**会话收件箱投递**：到点往会话里
 * 塞一条 user 消息，由那个会话自己的 agent 去跑。对我们的场景有两个限制：
 *   · 它不支持「每次运行用新的任务上下文」，而例行任务恰恰需要独立上下文；
 *   · 它没有「把结果推给前端」的通道，结果只留在会话日志里。
 * 所以这里用自建调度 + `runBotTurn`，结果同时进会话、进事件总线、进持久化快照。
 *
 * ## 一次例行任务的生命周期
 *
 *   到点 → 读 routine → 用 bot 身份跑一轮 `runBotTurn`
 *        → 每个 message 事件 publish 到事件总线（前端在线即收到）
 *        → 整轮结束后把消息落盘（前端离线时下次连上能补）
 *        → 推进 nextAt
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { botWorkspaceDir, ensureBotAgent, runBotTurn, type BotAgentSpec, type BotMessage, type PersonalStreamEvent, type TurnResult } from './agent.ts'
import { publish } from './events.ts'
import { checkJournalTrigger } from './journal.ts'
import { runAsBackgroundApproval } from './approval.ts'
import { injectWorkingMemoryIntoAgent } from './working-memory.ts'

/** 例行任务的调度规则（与前端 `RoutineSchedule` 对齐）。 */
export type HostRoutineSchedule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: number[] }

/** 宿主侧的一条例行任务。 */
export interface HostRoutine {
  id: string
  botId: string
  botName: string
  botRole: string
  botModel?: { provider: string; model: string; effort?: string }
  name: string
  instruction: string
  schedule: HostRoutineSchedule
  enabled: boolean
  /** 下次触发时间（毫秒）。缺省时由 `nextRoutineAt` 现算。 */
  nextAt?: number
  lastRunAt?: number
  /**
   * 没有新数据时怎么办（路线图 3.5 的「无数据策略」）。
   *
   * · `report`（缺省）——明确告诉用户「这次没有新数据」；
   * · `skip`——什么都不发，静默跳过。
   *
   * **两种策略都不会拿上一次的结果冒充本次**：用旧数据顶替会让用户以为
   * 数据是新的，比什么都不说更糟。
   */
  noDataPolicy?: RoutineNoDataPolicy
  /**
   * 失败重试策略（路线图 3.5 的「幂等重试」）。
   *
   * 缺省 `{ max: 0, backoffMs: 0 }`——**默认不重试**。例行任务里可能有
   * 非幂等动作（发消息、写文件、调外部接口），默认重试会把副作用放大一倍；
   * 要让用户/前端显式开启。
   */
  retry?: RoutineRetryPolicy
  /** 最近一次执行结果（宿主落盘，前端可据此显示「部分完成」徽标）。 */
  lastResult?: RoutineLastResult
}

/** 无数据时的处理口径。 */
export type RoutineNoDataPolicy = 'report' | 'skip'

/** 失败重试策略：`max` 是重试次数（不含首次），`backoffMs` 是基础间隔。 */
export interface RoutineRetryPolicy {
  max: number
  backoffMs: number
}

/** 一次执行的结局。 */
export type RoutineOutcome = 'ok' | 'partial' | 'failed' | 'skipped'

/** 落盘的执行结果摘要（不存消息正文，正文在 server-messages 里）。 */
export interface RoutineLastResult {
  at: number
  outcome: RoutineOutcome
  /** 「部分完成」：重试过才成功，或成功但没取到新数据。 */
  partial: boolean
  /** 实际尝试次数（1 = 首次就成功/失败，>1 = 重试过）。 */
  attempts: number
  noData: boolean
  error?: string
}

/** 一次例行任务执行的完整结果（供调度器 / 路由 / 测试消费）。 */
export interface RoutineRunResult {
  ok: boolean
  outcome: RoutineOutcome
  /** 「部分完成」标记：true 时调用方应在界面上明确提示，而不是当成完全成功。 */
  partial: boolean
  attempts: number
  /** 这一轮没有任何可交付内容（没说话、没调工具）。 */
  noData: boolean
  messages: BotMessage[]
  error?: string
}

/** 落盘的服务端消息（前端离线时产生的那部分）。 */
export interface ServerMessage {
  id: string
  botId: string
  kind: BotMessage['kind']
  blocks: Array<Record<string, unknown>>
  at: number
  source: string
}

/**
 * 主动询问的宿主侧配置。
 *
 * 与例行任务的区别：例行任务是「按点做一件指定的事」，主动询问是「在活跃时段里
 * 找机会说一句真正有价值的话」。所以它没有固定 nextAt 语义，而是**窗口内随机**
 * ——每天同一秒发消息会让 Bot 像闹钟而不像同事。
 */
export interface HostProactive {
  botId: string
  botName: string
  botRole: string
  botModel?: { provider: string; model: string; effort?: string }
  enabled: boolean
  /** `daily` = 窗口内每天一次；`hourly` = 窗口内每小时一次；其它值 = 不自动。 */
  freq: string
  from: string
  to: string
  nextAt?: number
  lastAt?: number
}

/** 主动询问的提示词（与前端 `proactiveNow` 逐字一致，避免换个入口就换语气）。 */
const PROACTIVE_PROMPT = [
  '现在轮到你主动找用户说话。',
  '基于你了解的上下文（你们的对话、你的岗位、你记得的关于用户的事），说一句真正有价值的话：',
  '一个提醒、一个你注意到的变化、或一件需要用户拍板的事。',
  '要求：不要客套，不要说「我在」「有什么可以帮你」，直接说正事。一两句话即可。',
].join('\n')

const TICK_MS = 30_000
/** 每个 bot 保留多少条服务端消息。这是补发窗口，不是消息库。 */
const MESSAGE_LIMIT = 50

function dataDir(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dir = join(dshHome, 'storages', 'dsh-seeker-bot', 'personal-agent')
  mkdirSync(dir, { recursive: true })
  return dir
}

function routinesFile(): string {
  return join(dataDir(), 'routines.json')
}

function messagesFile(): string {
  return join(dataDir(), 'server-messages.json')
}

function proactiveFile(): string {
  return join(dataDir(), 'proactive.json')
}

/** 稳定字符串散列：用作「同一天同一 bot 的随机时间」的种子。 */
function hashText(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

/** `HH:MM` → 当天第几分钟；格式不合法返回 null。 */
function timeToMinutes(value: string): number | null {
  const [hourText, minuteText] = String(value ?? '').split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as T
    return parsed ?? fallback
  } catch {
    // 文件损坏时退回空集：宁可丢调度，也不要让整个插件启动失败
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  } catch {
    /* 落盘失败不影响本轮执行 */
  }
}

/** 读取宿主侧全部例行任务。 */
export function readRoutines(): HostRoutine[] {
  const raw = readJson<unknown>(routinesFile(), [])
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is HostRoutine =>
    item !== null && typeof item === 'object'
    && typeof (item as HostRoutine).id === 'string'
    && typeof (item as HostRoutine).botId === 'string'
    && (item as HostRoutine).schedule !== undefined)
}

/** 全量覆盖写（前端把它的定义同步上来）。 */
export function writeRoutines(routines: HostRoutine[]): void {
  writeJson(routinesFile(), routines)
}

/** 读取服务端产生的消息（前端连上时补历史）。 */
export function readServerMessages(botId?: string): ServerMessage[] {
  const raw = readJson<Record<string, ServerMessage[]>>(messagesFile(), {})
  if (botId !== undefined) return raw[botId] ?? []
  return Object.values(raw).flat()
}

function appendServerMessage(message: ServerMessage): void {
  const raw = readJson<Record<string, ServerMessage[]>>(messagesFile(), {})
  const list = raw[message.botId] ?? []
  list.push(message)
  if (list.length > MESSAGE_LIMIT) list.splice(0, list.length - MESSAGE_LIMIT)
  raw[message.botId] = list
  writeJson(messagesFile(), raw)
}

/**
 * 算下一次触发时间。
 *
 * 所有分支都保证返回值**严格大于 now**：算出一个过去的时间会让定时器每 30 秒
 * 重复触发同一条任务，表现是「Bot 疯狂刷同一条消息」。
 */
export function nextRoutineAt(routine: Pick<HostRoutine, 'schedule'>, now = Date.now()): number {
  const schedule = routine.schedule
  if (schedule.kind === 'interval') {
    const every = Math.max(1, Math.round(schedule.everyMinutes)) * 60_000
    return now + every
  }
  const [hourText, minuteText] = schedule.time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    // 时间格式坏掉时退回「一小时后」，不让坏数据卡死整个调度
    return now + 3_600_000
  }
  const candidate = new Date(now)
  candidate.setSeconds(0, 0)
  candidate.setHours(hour, minute, 0, 0)
  if (schedule.kind === 'weekly') {
    const days = Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0 ? schedule.weekdays : [1]
    // ISO 星期：1=周一 … 7=周日；JS 的 getDay() 是 0=周日
    const isoOf = (date: Date): number => (date.getDay() === 0 ? 7 : date.getDay())
    for (let step = 0; step < 8; step += 1) {
      const probe = new Date(candidate.getTime())
      probe.setDate(probe.getDate() + step)
      if (!days.includes(isoOf(probe))) continue
      if (probe.getTime() > now) return probe.getTime()
    }
    return now + 7 * 86_400_000
  }
  if (candidate.getTime() > now) return candidate.getTime()
  candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

/** 读取主动询问配置。 */
export function readProactive(): HostProactive[] {
  const raw = readJson<unknown>(proactiveFile(), [])
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is HostProactive =>
    item !== null && typeof item === 'object'
    && typeof (item as HostProactive).botId === 'string')
}

/** 全量覆盖写主动询问配置。 */
export function writeProactive(configs: HostProactive[]): void {
  writeJson(proactiveFile(), configs)
}

/**
 * 算下一次主动询问的时间。
 *
 * 两个刻意的设计：
 *   · **窗口内随机**：每天同一秒发消息会让 Bot 像闹钟。随机量用「botId + 日期」
 *     做种子，所以同一天里反复计算结果是稳定的（不会每 30 秒漂移一次）。
 *   · **返回值必在未来**：算出过去的时间会让 tick 每次命中同一条，表现是刷屏。
 *
 * 返回 0 表示「不自动」（manual / 配置坏掉），调用方据此跳过。
 */
export function nextProactiveAt(config: HostProactive, now = Date.now()): number {
  if (config.enabled === false) return 0
  if (config.freq !== 'daily' && config.freq !== 'hourly') return 0
  const startMinutes = timeToMinutes(config.from)
  const endMinutes = timeToMinutes(config.to)
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) return 0

  /** 第 dayOffset 天的第 minutes 分钟（以本地 00:00 为基准）。 */
  const at = (dayOffset: number, minutes: number): number => {
    const date = new Date(now)
    date.setDate(date.getDate() + dayOffset)
    date.setHours(0, 0, 0, 0)
    return date.getTime() + minutes * 60_000
  }

  if (config.freq === 'hourly') {
    // 窗口内每小时一次：从下一个整点开始找，找不到就顺延到明天窗口开头
    const firstHour = Math.ceil(startMinutes / 60)
    const lastHour = Math.floor((endMinutes - 1) / 60)
    for (let hour = firstHour; hour <= lastHour; hour += 1) {
      const candidate = at(0, hour * 60)
      if (candidate > now) return candidate
    }
    return at(1, firstHour * 60)
  }

  // daily：窗口内随机一点，种子 = botId + 日期（同一天稳定）
  const windowMinutes = Math.max(1, endMinutes - startMinutes)
  const today = new Date(now).toDateString()
  const todayOffset = hashText(`${config.botId}|${today}`) % windowMinutes
  const todayCandidate = at(0, startMinutes + todayOffset)
  if (todayCandidate > now) return todayCandidate
  const tomorrow = new Date(now + 86_400_000).toDateString()
  const tomorrowOffset = hashText(`${config.botId}|${tomorrow}`) % windowMinutes
  return at(1, startMinutes + tomorrowOffset)
}

/** 把一轮 turn 的消息落到服务端快照（离线补发用）。 */
function recordMessages(botId: string, messages: BotMessage[], source: string): void {
  for (const message of messages) {
    appendServerMessage({
      id: message.id,
      botId,
      kind: message.kind,
      blocks: message.blocks,
      at: message.at,
      source,
    })
  }
}

/* ───────────────────── 例行任务的信任设计（路线图 3.5）───────────────────── */

/** 重试次数的硬上限：再多就不是「重试」而是「刷屏」。 */
const MAX_RETRY_ATTEMPTS = 5
/** 重试间隔的硬上限（单次等待）：例行任务总时长不能失控。 */
const MAX_RETRY_BACKOFF_MS = 120_000

/**
 * 规范化重试策略。
 *
 * 前端推上来的 JSON 什么都可能：负数、字符串、NaN。不夹取的话
 * `while (attempt < max)` 会直接死循环，或者 `setTimeout(NaN)` 变成 0 毫秒
 * 连打。这里统一收敛到 [0, 5] 次 / [0, 120s]。
 */
export function normalizeRetryPolicy(input: unknown): RoutineRetryPolicy {
  if (input === null || typeof input !== 'object') return { max: 0, backoffMs: 0 }
  const record = input as Record<string, unknown>
  const maxRaw = Number(record.max)
  const backoffRaw = Number(record.backoffMs)
  const max = Number.isFinite(maxRaw) ? Math.max(0, Math.min(MAX_RETRY_ATTEMPTS, Math.round(maxRaw))) : 0
  const backoffMs = Number.isFinite(backoffRaw)
    ? Math.max(0, Math.min(MAX_RETRY_BACKOFF_MS, Math.round(backoffRaw)))
    : 0
  return { max, backoffMs }
}

/** 规范化无数据策略（缺省 report：宁可多说一句，也不让用户以为「没消息 = 一切正常」）。 */
export function normalizeNoDataPolicy(input: unknown): RoutineNoDataPolicy {
  return input === 'skip' ? 'skip' : 'report'
}

/**
 * 本轮有没有「可交付内容」。
 *
 * 判据刻意宽：只要模型说了非空的话，或发起过任何工具调用，就算有内容。
 * 真正的「无数据」是整轮零消息 / 全是空占位消息——那说明模型跑完了但什么都
 * 没拿到，此时按 `noDataPolicy` 处理，**不能拿上一次的结果顶上**。
 */
function hasDeliverableContent(turn: TurnResult): boolean {
  return turn.messages.some((message) => message.blocks.some((block) => {
    const type = String(block?.type ?? '')
    if (type === 'text') return String(block?.text ?? '').trim() !== ''
    if (type === 'tool') return block?.run !== undefined && block?.run !== null
    // 其它块（artifact / interactive / images…）本身就代表有产出
    return true
  }))
}

/** 等一会儿（timer 不钉住事件循环：宿主常驻时无所谓，一次性脚本要能退出）。 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 把该 Bot 的工作记忆投给 agent（例行任务 / 主动询问每轮都会调）。
 *
 * 放在 `runBotTurn` 之前：`agent.inject()` 不唤醒驱动器，会落在下一个被接纳的
 * 步骤里，所以「先注入、再 followup」模型第一步就能看到任务状态。失败一律
 * 吞掉——工作记忆是增强项，不能连累例行任务本身。
 */
async function injectWorkingMemoryForTurn(ctx: any, spec: BotAgentSpec): Promise<void> {
  try {
    const agent = await ensureBotAgent(ctx, spec)
    await injectWorkingMemoryIntoAgent(agent, spec.botId)
  } catch {
    /* agent 建不起来时 runBotTurn 自己会报错，这里不必重复 */
  }
}

/** 造一条系统报告消息（无数据 / 部分完成时用）。 */
function systemReportMessage(idSuffix: string, text: string, kind: BotMessage['kind'] = 'progress'): BotMessage {
  return {
    id: `m-${Date.now().toString(36)}-${idSuffix}`,
    kind,
    blocks: [{ type: 'text', text }],
    at: Date.now(),
  }
}

/**
 * 跑一次主动询问。
 *
 * 调度器与「现在问一次」路由共用这一个实现——两处各写一份，迟早会出现
 * 「按钮点出来的和定时跑出来的语气不一样」。
 *
 * 和例行任务走同一条 `runBotTurn`：同样是「真 agent 跑一轮」，只是提示词不同。
 * 消息以 `source: 'proactive'` 发出，前端据此显示「主动消息」标签。
 */
export async function runProactiveNow(ctx: any, config: HostProactive): Promise<{ ok: boolean; error?: string }> {
  const spec: BotAgentSpec = {
    botId: config.botId,
    name: config.botName,
    role: config.botRole,
    description: '',
    instructions: '',
    ...(config.botModel !== undefined ? { model: config.botModel } : {}),
    permission: 'full',
    /*
     * 显式声明「这是后台轮次」：`runBotTurn` 据此决定是否允许「执行中重定向」——
     * 后台工作不该打断用户正在进行的对话（用户的新消息优先于后台，反过来不成立）。
     *
     * 为什么不用文本前缀识别：提示词文案一改就失配。`agent.ts` 里保留
     * `【例行任务】` / 主动询问那句作为**兼容旧调用方的兜底**；显式参数优先。
     */
    background: true,
  }
  publish(config.botId, { type: 'status', status: 'thinking' })
  try {
    await injectWorkingMemoryForTurn(ctx, spec)
    /*
     * 包成「后台来源」：这一轮里发生的审批套用 30 分钟超时（而不是聊天内
     * 的永不过期）——后台任务不能无限占着会话等用户。
     */
    const turn = await runAsBackgroundApproval(() => runBotTurn(ctx, spec, PROACTIVE_PROMPT, (event) => {
      if (event.type === 'message') {
        publish(config.botId, { type: 'message', message: event.message, source: 'proactive' })
      } else if (event.type === 'message-update') {
        publish(config.botId, { type: 'message-update', message: event.message, source: 'proactive' })
      }
    }))
    if (turn.ok) {
      recordMessages(config.botId, turn.messages, 'proactive')
      return { ok: true }
    }
    const error = turn.error ?? '未知原因'
    publish(config.botId, { type: 'error', message: `主动询问未完成：${error}` })
    return { ok: false, error }
  } catch (error: any) {
    const message = String(error?.message ?? error)
    publish(config.botId, { type: 'error', message: `主动询问出错：${message}` })
    return { ok: false, error: message }
  } finally {
    publish(config.botId, { type: 'status', status: 'idle' })
  }
}

/**
 * 挂载调度器：加载例行任务、起定时器、到点跑一轮。
 *
 * @returns 卸载函数（插件 dispose 时停表）。
 */
export function applyPersonalAgentScheduler(ctx: any): () => void {
  let running = false

  const tick = async (): Promise<void> => {
    // 上一轮还没跑完就跳过本次：例行任务可能跑几分钟（读文件、跑命令），
    // 叠着跑会让同一个 bot 的会话被两个 turn 同时写。
    if (running) return
    const now = Date.now()
    const dueRoutines = readRoutines()
      .filter((routine) => routine.enabled && (routine.nextAt ?? nextRoutineAt(routine, now)) <= now)
    const dueProactive = readProactive().filter((config) => {
      const next = config.nextAt ?? nextProactiveAt(config, now)
      // nextAt = 0 表示「不自动」（manual / 配置坏掉）
      return next > 0 && next <= now
    })

    /**
     * 期刊检查：宿主侧 always-on 的第二个消费者（第一个是例行任务）。
     *
     * 放在 due 判断**之后**：先做例行任务 / 主动询问的便宜筛选，再交给
     * `checkJournalTrigger` 自己判定——它第一步只读一个小 JSON + 算小时数，
     * 窗口外 / 规则关闭时几乎零成本。生成可能跑 90 秒以上，所以同样受上面的
     * `running` 标志保护（不会和下一 tick 叠跑）。
     *
     * 失败不抛穿：期刊生成失败只写触发日志，绝不能让调度器整轮崩掉。
     */
    const checkJournal = async (): Promise<void> => {
      try {
        await checkJournalTrigger(ctx)
      } catch (error: any) {
        console.warn('[personal-agent] 期刊检查失败（不影响其它调度）:', error instanceof Error ? error.message : error)
      }
    }

    if (dueRoutines.length === 0 && dueProactive.length === 0) {
      /*
       * 没有到点的例行任务 / 主动询问，期刊仍然要检查：它不依赖 nextAt，
       * 而是每天靠「昨日是否已有期刊」去重。这里也置 running，避免生成过程中
       * 下一个 tick 又进来（生成是慢操作）。
       */
      running = true
      try {
        await checkJournal()
      } finally {
        running = false
      }
      return
    }

    running = true
    try {
      for (const routine of dueRoutines) {
        const result = await runOne(routine)
        // 推进 nextAt 并落盘，无论成功失败——否则失败的任务会每 30 秒重试一次
        const latest = readRoutines()
        const index = latest.findIndex((item) => item.id === routine.id)
        if (index >= 0) {
          const at = Date.now()
          latest[index] = {
            ...latest[index],
            lastRunAt: at,
            nextAt: nextRoutineAt(latest[index], at),
            /*
             * 把结局一起落盘：前端据此显示「部分完成 / 无新数据」徽标。
             * 只存摘要不存正文——正文已经在 server-messages 里，重复存会让
             * routines.json 随运行次数线性膨胀。
             */
            lastResult: {
              at,
              outcome: result.outcome,
              partial: result.partial,
              attempts: result.attempts,
              noData: result.noData,
              ...(result.error !== undefined ? { error: result.error } : {}),
            },
          }
          writeRoutines(latest)
        }
      }
      for (const config of dueProactive) {
        await runProactiveNow(ctx, config)
        const latest = readProactive()
        const index = latest.findIndex((item) => item.botId === config.botId)
        if (index >= 0) {
          latest[index] = {
            ...latest[index],
            lastAt: Date.now(),
            nextAt: nextProactiveAt(latest[index], Date.now()),
          }
          writeProactive(latest)
        }
      }
      // 期刊放在最后：例行任务与主动询问是「到点必须跑」的，先让它们完成
      await checkJournal()
    } finally {
      running = false
    }
  }

  const runOne = async (routine: HostRoutine): Promise<RoutineRunResult> => {
    const spec: BotAgentSpec = {
      botId: routine.botId,
      name: routine.botName,
      role: routine.botRole,
      description: '',
      instructions: '',
      ...(routine.botModel !== undefined ? { model: routine.botModel } : {}),
      permission: 'full',
      /*
       * 显式声明「这是后台轮次」（与 runProactiveNow 同一口径）：例行任务在用户
       * 对话进行中被触发时应该排队，而不是 steer 进用户正在跑的轮次里。
       * 文本前缀 `【例行任务】` 仍保留——它是 agent.ts 兼容旧调用方的兜底，
       * 显式参数优先。
       */
      background: true,
    }
    const text = [
      `【例行任务】${routine.name}`,
      routine.instruction.trim() !== '' ? routine.instruction : '按你的判断检查一下当前状态，有异常就指出来。',
      '现在开始执行这个例行任务：该查就查、该跑就跑，然后把结果告诉我。',
    ].join('\n')
    const retry = normalizeRetryPolicy(routine.retry)
    const noDataPolicy = normalizeNoDataPolicy(routine.noDataPolicy)
    publish(routine.botId, { type: 'status', status: 'thinking' })
    let attempts = 0
    let lastError = ''

    const emit = (event: PersonalStreamEvent): void => {
      /*
       * 把这一轮的消息实时推给前端。
       *
       * 只转发 message / message-update：text / tool 是同一批内容的扁平视图，
       * 前端在多消息模式下已经忽略它们，转发过去只是白占带宽。
       */
      if (event.type === 'message') {
        publish(routine.botId, { type: 'message', message: event.message, source: 'routine' })
      } else if (event.type === 'message-update') {
        publish(routine.botId, { type: 'message-update', message: event.message, source: 'routine' })
      }
    }

    try {
      await injectWorkingMemoryForTurn(ctx, spec)
      /*
       * 重试循环：`max` 是重试次数，所以总尝试上限是 max + 1。
       *
       * 只重试**整轮失败**（agent 建不起来 / 超时 / 宿主异常），不重试「跑完但
       * 没数据」——那多半是数据源真的没新东西，重试只会白烧 token。等待时间按
       * `backoffMs * (attempt - 1)` 线性递增：指数退避在第 4 次就会拖到十几分钟，
       * 例行任务的总时长不能失控。
       */
      for (let attempt = 1; attempt <= retry.max + 1; attempt += 1) {
        attempts = attempt
        if (attempt > 1) await sleep(retry.backoffMs * (attempt - 1))
        let turn: TurnResult | undefined
        try {
          /*
           * 包成「后台来源」：这一轮里发生的审批套用 30 分钟超时——后台任务
           * 不能像聊天那样无限挂着等用户回来。
           */
          turn = await runAsBackgroundApproval(() => runBotTurn(ctx, spec, text, emit))
        } catch (error: any) {
          lastError = String(error?.message ?? error)
          continue
        }
        if (!turn.ok) {
          lastError = turn.error ?? '未知原因'
          continue
        }

        const noData = !hasDeliverableContent(turn)
        if (noData && noDataPolicy === 'skip') {
          /*
           * 静默跳过：不推送、不落盘（用户明确说过「没数据就别烦我」）。
           * 只留一条宿主日志——否则事后排查「为什么那天没消息」会完全没有线索。
           */
          ctx?.logger?.info?.(`[personal-agent] 例行任务「${routine.name}」本次无数据，按 skip 策略静默跳过`)
          return { ok: true, outcome: 'skipped', partial: false, attempts, noData: true, messages: [] }
        }
        if (noData) {
          /*
           * 无数据策略 report（缺省）：明确说「这次没有新数据」，而不是把上一次
           * 的结果再发一遍。旧数据冒充新数据比沉默更糟——用户会据此做决策。
           */
          const notice = systemReportMessage(
            'nodata',
            `例行任务「${routine.name}」跑完了，但这次没有取到新数据。`,
            'final',
          )
          publish(routine.botId, { type: 'message', message: notice, source: 'routine' })
          recordMessages(routine.botId, [notice], 'routine')
          return { ok: true, outcome: 'ok', partial: false, attempts, noData: true, messages: [notice] }
        }

        recordMessages(routine.botId, turn.messages, 'routine')
        const partial = attempts > 1
        if (partial) {
          /*
           * 「部分完成要报告」：重试过才成功时，第一次失败的那半截没有产出，
           * 结果可能不完整。必须让用户看到这句提示，而不是当成完全成功。
           */
          const notice = systemReportMessage(
            'partial',
            `（例行任务「${routine.name}」第 ${attempts} 次尝试才成功，本次结果可能不完整。）`,
          )
          publish(routine.botId, { type: 'message', message: notice, source: 'routine' })
          recordMessages(routine.botId, [notice], 'routine')
          return {
            ok: true,
            outcome: 'partial',
            partial: true,
            attempts,
            noData: false,
            messages: [...turn.messages, notice],
          }
        }
        return { ok: true, outcome: 'ok', partial: false, attempts, noData: false, messages: turn.messages }
      }

      // 所有尝试都失败
      const reason = lastError === '' ? '未知原因' : lastError
      publish(routine.botId, {
        type: 'error',
        message: `例行任务「${routine.name}」执行失败（已尝试 ${attempts} 次）：${reason}`,
      })
      return { ok: false, outcome: 'failed', partial: false, attempts, noData: false, messages: [], error: reason }
    } catch (error: any) {
      const message = String(error?.message ?? error)
      publish(routine.botId, { type: 'error', message: `例行任务「${routine.name}」执行出错：${message}` })
      return { ok: false, outcome: 'failed', partial: false, attempts, noData: false, messages: [], error: message }
    } finally {
      publish(routine.botId, { type: 'status', status: 'idle' })
    }
  }

  const timer = setInterval(() => { void tick().catch(() => undefined) }, TICK_MS)
  /*
   * `unref()` 是必须的：定时器默认会把 Node 进程的事件循环钉住，宿主进程常驻时
   * 无所谓，但单元测试 / `node -e` 这类一次性脚本会永远退不出去（实测表现为
   * test-personal-agent 跑完不结束）。
   */
  timer.unref?.()
  // 启动时补一次：宿主重启后，错过的任务应该尽快补跑而不是等满一个周期
  const initial = setTimeout(() => { void tick().catch(() => undefined) }, 5_000)
  initial.unref?.()

  ctx?.logger?.info?.('[personal-agent] 例行任务调度器已启动（宿主侧常驻）')
  return () => {
    clearInterval(timer)
    clearTimeout(initial)
  }
}

/** 测试用：暴露内部实现。 */
export const schedulerTest = {
  nextRoutineAt,
  readRoutines,
  writeRoutines,
  readServerMessages,
  dataDir,
  botWorkspaceDir,
  normalizeRetryPolicy,
  normalizeNoDataPolicy,
  hasDeliverableContent,
  systemReportMessage,
}
