/**
 * dsh-seeker-bot — Bot 数据层（v2）。
 *
 * 只存「编排信息」：Bot 档案、群组、日程、审批规则、用量与会话绑定。会话内容在
 * DSH 会话存储里，技能在 ~/.dsh/skills，记忆在插件自己的工作区，这里不复制。
 *
 * 存储：${DSH_HOME:-~/.dsh}/storages/dsh-seeker-bot/state.json
 * 写入：tmp + rename 原子替换；单进程串行。
 *
 * v1 → v2 迁移（读到时自动完成，另存一份 .v1-backup-* 备份）：
 *   - Bot 补齐 workspace / description / skills / memoryWorkspace / model /
 *     proactive / output / sessionIds / status / createdBy；
 *   - 新增 routines（对外叫「日程」，字段名仍是 routine）、rules、usage；
 *   - 新增 sessions 表（sessionId → botId），并从各 Bot 的 sessionIds 反推。
 */

import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync,
} from 'node:fs'

export type BotStatus = 'idle' | 'working' | 'needs-you' | 'unread'

export interface BotAvatar {
  shape: 'whale' | 'orbit' | 'cube' | 'leaf' | 'spark' | 'ring'
  color: string
}

/** 单个 Bot 的模型偏好。provider/model 同时存在才算一条有效设置。 */
export interface BotModelPrefs {
  provider?: string
  model?: string
  effort?: string
}

/** 主动找我配置。lastAt 是最近一次真正发送的时间戳（毫秒）。 */
export interface BotProactive {
  enabled: boolean
  freq: string
  from: string
  to: string
  lastAt?: number
}

/** 产出偏好：图表 / 可交互页面。 */
export interface BotOutput {
  charts: boolean
  pages: boolean
}

export interface BotRecord {
  id: string
  name: string
  role: string
  label?: string
  avatar: BotAvatar
  /** 一句话档案描述（面板与群组列表用）。 */
  description: string
  /** 首条消息固化的岗位与边界，注入系统提示。 */
  instructions: string
  primary: boolean
  pinned: boolean
  section: string
  hidden: boolean
  paused: boolean
  notification: boolean
  /** 该 Bot 的会话工作目录；空串表示使用共享的 memoryWorkspace 目录。 */
  workspace: string
  /** 记忆工作区名，默认 seekerbot；所有 Bot 共用。 */
  memoryWorkspace: string
  /** 启用的技能名列表（空表示不限制）。 */
  skills: string[]
  model?: BotModelPrefs
  proactive?: BotProactive
  output?: BotOutput
  sessionIds: string[]
  createdAt: number
  createdBy: string | null
  status: BotStatus
}

/** 一次日程运行记录（保留最近 20 条）。 */
export interface RoutineRun {
  at: number
  status: 'running' | 'succeeded' | 'failed' | 'accepted' | 'skipped'
  /** 触发来源：定时 / webhook / 手动 test。 */
  trigger: 'schedule' | 'webhook' | 'manual' | 'test'
  reason?: string
}

/** 日程的触发方式。 */
export type RoutineTrigger =
  | { type: 'schedule'; cron?: string; everySeconds?: number; timezone?: string }
  | { type: 'webhook' }
  | { type: 'manual' }

/** 日程记录。对外一律称「日程」，字段名保持 routine/routines 以兼容客户端。 */
export interface RoutineRecord {
  id: string
  botId: string
  name: string
  instruction: string
  enabled: boolean
  /** 官方 schedule 服务里的任务 id；未包装成功时为空。 */
  scheduleId?: string
  /** webhook 校验密钥（仅本机 UI 可读）。 */
  key: string
  triggers: RoutineTrigger[]
  runs: RoutineRun[]
  createdAt: number
  updatedAt: number
}

/** 审批规则（F3 规则表的存储面）。 */
export interface ApprovalRule {
  id: string
  pattern: string
  action: 'allow' | 'deny' | 'ask'
  note?: string
  createdAt: number
}

export type GroupModel =
  | { mode: 'inherit' }
  | { mode: 'unified'; provider?: string; model?: string; effort?: string }

export interface BotGroup {
  id: string
  name: string
  botIds: string[]
  /** 群里没 @ 任何人时由谁接；缺省取 botIds[0]。 */
  primaryBotId?: string
  model?: GroupModel
  createdAt: number
}

export interface BotUsage {
  input: number
  output: number
  runs: number
}

export interface BotState {
  version: 2
  bots: BotRecord[]
  groups: BotGroup[]
  routines: RoutineRecord[]
  rules: ApprovalRule[]
  usage: Record<string, BotUsage>
  /** sessionId → botId 绑定表（持久化，重启不丢）。 */
  sessions: Record<string, string>
  ui: { mode: 'work' | 'bot'; lastBotId?: string }
}

const DEFAULT_SHAPE: BotAvatar['shape'] = 'whale'
const DEFAULT_COLOR = '#0f1115'
const DEFAULT_MEMORY_WORKSPACE = 'seekerbot'
const MAX_ROUTINE_RUNS = 20

/** DSH 根目录（DSH_HOME 优先；与官方 dsh-home-paths 的默认一致）。 */
export function dshHomeDir(): string {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
}

export function stateDir(): string {
  return join(dshHomeDir(), 'storages', 'dsh-seeker-bot')
}

export function statePath(): string {
  return join(stateDir(), 'state.json')
}

/** 共享记忆工作区目录：${DSH_HOME}/seekerbot。 */
export function seekerbotDir(): string {
  return join(dshHomeDir(), 'seekerbot')
}

/** 把 Bot 的 workspace 解析成绝对目录；空串回落到共享 seekerbot 目录。 */
export function resolveBotWorkspace(bot: Pick<BotRecord, 'workspace'>): string {
  const raw = typeof bot.workspace === 'string' ? bot.workspace.trim() : ''
  if (raw === '') return seekerbotDir()
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
}

function emptyState(): BotState {
  return {
    version: 2,
    bots: [],
    groups: [],
    routines: [],
    rules: [],
    usage: {},
    sessions: {},
    ui: { mode: 'bot' },
  }
}

/* ─────────────────────────── 归一化（迁移与坏数据容错） ─────────────────────── */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asTrimmedString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  return out
}

function asTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

const SHAPES = new Set<BotAvatar['shape']>(['whale', 'orbit', 'cube', 'leaf', 'spark', 'ring'])

function normalizeAvatar(value: unknown): BotAvatar {
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    shape: SHAPES.has(String(raw.shape) as BotAvatar['shape']) ? String(raw.shape) as BotAvatar['shape'] : DEFAULT_SHAPE,
    color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color)) ? String(raw.color) : DEFAULT_COLOR,
  }
}

function normalizeModel(value: unknown): BotModelPrefs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const out: BotModelPrefs = {}
  const provider = asTrimmedString(raw.provider)
  const model = asTrimmedString(raw.model)
  const effort = asTrimmedString(raw.effort)
  if (provider !== '') out.provider = provider
  if (model !== '') out.model = model
  if (effort !== '') out.effort = effort
  return Object.keys(out).length > 0 ? out : undefined
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function normalizeProactive(value: unknown, fallback?: BotProactive): BotProactive {
  const base: BotProactive = fallback ?? { enabled: false, freq: 'daily', from: '09:00', to: '22:00' }
  if (value === null || typeof value !== 'object') return { ...base }
  const raw = value as Record<string, unknown>
  const from = typeof raw.from === 'string' && HHMM.test(raw.from) ? raw.from : base.from
  const to = typeof raw.to === 'string' && HHMM.test(raw.to) ? raw.to : base.to
  return {
    enabled: asBoolean(raw.enabled, base.enabled),
    freq: asTrimmedString(raw.freq, base.freq),
    from,
    to,
    lastAt: typeof raw.lastAt === 'number' && Number.isFinite(raw.lastAt) ? raw.lastAt : base.lastAt,
  }
}

function normalizeOutput(value: unknown, fallback?: BotOutput): BotOutput {
  const base = fallback ?? { charts: true, pages: true }
  if (value === null || typeof value !== 'object') return { ...base }
  const raw = value as Record<string, unknown>
  return {
    charts: asBoolean(raw.charts, base.charts),
    pages: asBoolean(raw.pages, base.pages),
  }
}

const STATUSES = new Set<BotStatus>(['idle', 'working', 'needs-you', 'unread'])

function normalizeBot(value: unknown, index: number): BotRecord {
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const name = asTrimmedString(raw.name, '未命名 Bot')
  const role = asTrimmedString(raw.role, '通用助手')
  const id = asTrimmedString(raw.id, 'bot-migrated-' + index)
  return {
    id,
    name,
    role,
    ...(typeof raw.label === 'string' && raw.label !== '' ? { label: raw.label } : {}),
    avatar: normalizeAvatar(raw.avatar),
    description: asString(raw.description, '').trim(),
    instructions: asString(raw.instructions, '你是「' + name + '」，岗位：' + role + '。'),
    primary: asBoolean(raw.primary, index === 0),
    pinned: asBoolean(raw.pinned, false),
    section: asTrimmedString(raw.section, '项目'),
    hidden: asBoolean(raw.hidden, false),
    paused: asBoolean(raw.paused, false),
    notification: asBoolean(raw.notification, true),
    workspace: asString(raw.workspace, '').trim(),
    memoryWorkspace: asTrimmedString(raw.memoryWorkspace, DEFAULT_MEMORY_WORKSPACE),
    skills: asStringArray(raw.skills),
    ...(normalizeModel(raw.model) !== undefined ? { model: normalizeModel(raw.model) } : {}),
    proactive: normalizeProactive(raw.proactive),
    output: normalizeOutput(raw.output),
    sessionIds: asStringArray(raw.sessionIds),
    createdAt: asTimestamp(raw.createdAt, Date.now()),
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    status: STATUSES.has(String(raw.status) as BotStatus) ? String(raw.status) as BotStatus : 'idle',
  }
}

function normalizeGroupModel(value: unknown): GroupModel {
  if (value === null || typeof value !== 'object') return { mode: 'inherit' }
  const raw = value as Record<string, unknown>
  if (raw.mode !== 'unified') return { mode: 'inherit' }
  const provider = asTrimmedString(raw.provider)
  const model = asTrimmedString(raw.model)
  const effort = asTrimmedString(raw.effort)
  return {
    mode: 'unified',
    ...(provider !== '' ? { provider } : {}),
    ...(model !== '' ? { model } : {}),
    ...(effort !== '' ? { effort } : {}),
  }
}

function normalizeGroup(value: unknown, index: number): BotGroup {
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const botIds = asStringArray(raw.botIds)
  const primaryBotId = asTrimmedString(raw.primaryBotId)
  return {
    id: asTrimmedString(raw.id, 'group-migrated-' + index),
    name: asTrimmedString(raw.name, '未命名群组'),
    botIds,
    ...(primaryBotId !== '' && botIds.includes(primaryBotId) ? { primaryBotId } : {}),
    model: normalizeGroupModel(raw.model),
    createdAt: asTimestamp(raw.createdAt, Date.now()),
  }
}

function normalizeRoutineRun(value: unknown): RoutineRun | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const status = String(raw.status)
  if (!['running', 'succeeded', 'failed', 'accepted', 'skipped'].includes(status)) return null
  const trigger = String(raw.trigger)
  return {
    at: asTimestamp(raw.at, Date.now()),
    status: status as RoutineRun['status'],
    trigger: (['schedule', 'webhook', 'manual', 'test'].includes(trigger) ? trigger : 'manual') as RoutineRun['trigger'],
    ...(typeof raw.reason === 'string' && raw.reason !== '' ? { reason: raw.reason } : {}),
  }
}

function normalizeRoutineTrigger(value: unknown): RoutineTrigger | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.type === 'schedule') {
    return {
      type: 'schedule',
      ...(asTrimmedString(raw.cron) !== '' ? { cron: asTrimmedString(raw.cron) } : {}),
      ...(typeof raw.everySeconds === 'number' && raw.everySeconds > 0 ? { everySeconds: raw.everySeconds } : {}),
      ...(asTrimmedString(raw.timezone) !== '' ? { timezone: asTrimmedString(raw.timezone) } : {}),
    }
  }
  if (raw.type === 'webhook') return { type: 'webhook' }
  return { type: 'manual' }
}

function normalizeRoutine(value: unknown, index: number): RoutineRecord {
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const runs = Array.isArray(raw.runs) ? raw.runs.map(normalizeRoutineRun).filter((run): run is RoutineRun => run !== null) : []
  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.map(normalizeRoutineTrigger).filter((trigger): trigger is RoutineTrigger => trigger !== null)
    : []
  return {
    id: asTrimmedString(raw.id, 'routine-migrated-' + index),
    botId: asTrimmedString(raw.botId),
    name: asTrimmedString(raw.name, '未命名日程'),
    instruction: asString(raw.instruction, ''),
    enabled: asBoolean(raw.enabled, true),
    ...(asTrimmedString(raw.scheduleId) !== '' ? { scheduleId: asTrimmedString(raw.scheduleId) } : {}),
    key: asTrimmedString(raw.key, randomToken()),
    triggers: triggers.length > 0 ? triggers : [{ type: 'manual' }],
    runs: runs.slice(-MAX_ROUTINE_RUNS),
    createdAt: asTimestamp(raw.createdAt, Date.now()),
    updatedAt: asTimestamp(raw.updatedAt, Date.now()),
  }
}

function normalizeRule(value: unknown, index: number): ApprovalRule | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const pattern = asTrimmedString(raw.pattern)
  if (pattern === '') return null
  const action = String(raw.action)
  return {
    id: asTrimmedString(raw.id, 'rule-migrated-' + index),
    pattern,
    action: (action === 'allow' || action === 'deny' || action === 'ask' ? action : 'ask') as ApprovalRule['action'],
    ...(asTrimmedString(raw.note) !== '' ? { note: asTrimmedString(raw.note) } : {}),
    createdAt: asTimestamp(raw.createdAt, Date.now()),
  }
}

function normalizeUsage(value: unknown): Record<string, BotUsage> {
  if (value === null || typeof value !== 'object') return {}
  const out: Record<string, BotUsage> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    out[key] = {
      input: typeof item.input === 'number' && Number.isFinite(item.input) ? item.input : 0,
      output: typeof item.output === 'number' && Number.isFinite(item.output) ? item.output : 0,
      runs: typeof item.runs === 'number' && Number.isFinite(item.runs) ? item.runs : 0,
    }
  }
  return out
}

/** 从持久化的 sessions 表与各 Bot 的 sessionIds 合成绑定表（双向补齐）。 */
function normalizeSessions(value: unknown, bots: BotRecord[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (value !== null && typeof value === 'object') {
    for (const [sessionId, botId] of Object.entries(value as Record<string, unknown>)) {
      if (typeof sessionId === 'string' && sessionId !== '' && typeof botId === 'string' && botId !== '') out[sessionId] = botId
    }
  }
  for (const bot of bots) {
    for (const sessionId of bot.sessionIds) {
      if (out[sessionId] === undefined) out[sessionId] = bot.id
    }
  }
  return out
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

function randomId(prefix: string): string {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

/* ───────────────────────────────── 加载 / 保存 ─────────────────────────────── */

let cache: BotState | null = null

export function loadState(): BotState {
  if (cache !== null) return cache
  const file = statePath()
  if (!existsSync(file)) {
    cache = emptyState()
    return cache
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // 读坏了不阻塞：备份后从空状态起，用户数据至少还在盘上
    try { copyFileSync(file, file + '.broken-' + Date.now()) } catch { /* ignore */ }
    cache = emptyState()
    return cache
  }

  const version = typeof raw.version === 'number' ? raw.version : 1
  const bots = Array.isArray(raw.bots) ? raw.bots.map(normalizeBot) : []
  const st: BotState = {
    version: 2,
    bots,
    groups: Array.isArray(raw.groups) ? raw.groups.map(normalizeGroup) : [],
    routines: Array.isArray(raw.routines) ? raw.routines.map(normalizeRoutine) : [],
    rules: Array.isArray(raw.rules)
      ? raw.rules.map(normalizeRule).filter((rule): rule is ApprovalRule => rule !== null)
      : [],
    usage: normalizeUsage(raw.usage),
    sessions: normalizeSessions(raw.sessions, bots),
    ui: raw.ui !== null && typeof raw.ui === 'object'
      ? {
          mode: (raw.ui as Record<string, unknown>).mode === 'work' ? 'work' : 'bot',
          ...(typeof (raw.ui as Record<string, unknown>).lastBotId === 'string'
            ? { lastBotId: String((raw.ui as Record<string, unknown>).lastBotId) }
            : {}),
        }
      : { mode: 'bot' },
  }
  cache = st
  if (version < 2) {
    // 迁移前先留一份原文件；备份失败不阻塞启动（原始内容仍在 state.json 里，
    // 下一次 saveState 才会覆盖，所以尽力而为即可）。
    try { copyFileSync(file, file + '.v1-backup-' + Date.now()) } catch { /* ignore */ }
    try { saveState(st) } catch { /* 读迁移成功即可先用 */ }
  }
  return st
}

export function saveState(next: BotState): void {
  cache = next
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const file = statePath()
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 仅测试用：丢掉内存缓存，下一次 loadState 重新读盘（模拟进程重启）。 */
export function __resetStateCache(): void {
  cache = null
}

/* ───────────────────────────────── Bot CRUD ──────────────────────────────── */

export interface CreateBotInput {
  name?: unknown
  role?: unknown
  description?: unknown
  instructions?: unknown
  shape?: unknown
  color?: unknown
  section?: unknown
  workspace?: unknown
  memoryWorkspace?: unknown
  skills?: unknown
  model?: unknown
  proactive?: unknown
  output?: unknown
}

export function createBot(input: CreateBotInput): BotRecord {
  const st = loadState()
  const name = String(input.name ?? '').trim() || '新队友'
  const role = String(input.role ?? '').trim() || '通用助手'
  const shape = SHAPES.has(String(input.shape)) ? String(input.shape) as BotAvatar['shape'] : DEFAULT_SHAPE
  const color = /^#[0-9a-fA-F]{6}$/.test(String(input.color)) ? String(input.color) : DEFAULT_COLOR
  const model = normalizeModel(input.model)
  const bot: BotRecord = {
    id: randomId('bot'),
    name,
    role,
    avatar: { shape, color },
    description: String(input.description ?? '').trim(),
    instructions: String(input.instructions ?? '').trim() || ('你是「' + name + '」，岗位：' + role + '。'),
    primary: st.bots.length === 0,
    pinned: false,
    section: String(input.section ?? '项目').trim() || '项目',
    hidden: false,
    paused: false,
    notification: true,
    workspace: String(input.workspace ?? '').trim(),
    memoryWorkspace: String(input.memoryWorkspace ?? '').trim() || DEFAULT_MEMORY_WORKSPACE,
    skills: asStringArray(input.skills),
    ...(model !== undefined ? { model } : {}),
    proactive: normalizeProactive(input.proactive),
    output: normalizeOutput(input.output),
    sessionIds: [],
    createdAt: Date.now(),
    createdBy: null,
    status: 'idle',
  }
  st.bots.push(bot)
  saveState(st)
  return bot
}

const PATCHABLE = new Set([
  'name', 'role', 'label', 'description', 'instructions', 'pinned', 'section', 'hidden',
  'paused', 'notification', 'model', 'proactive', 'output', 'avatar', 'status',
  'workspace', 'memoryWorkspace', 'skills',
])

export function updateBot(id: string, patch: Record<string, unknown>): BotRecord | null {
  const st = loadState()
  const bot = st.bots.find((b) => b.id === id)
  if (bot === undefined) return null
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) continue
    if (k === 'avatar' && v !== null && typeof v === 'object') {
      bot.avatar = normalizeAvatar(v)
      continue
    }
    if (k === 'model') {
      const model = normalizeModel(v)
      if (model === undefined) delete bot.model
      else bot.model = model
      continue
    }
    if (k === 'proactive') {
      bot.proactive = normalizeProactive(v, bot.proactive)
      continue
    }
    if (k === 'output') {
      bot.output = normalizeOutput(v, bot.output)
      continue
    }
    if (k === 'skills') {
      bot.skills = asStringArray(v)
      continue
    }
    if (k === 'workspace' || k === 'description') {
      bot[k] = String(v ?? '').trim()
      continue
    }
    if (k === 'memoryWorkspace') {
      bot.memoryWorkspace = String(v ?? '').trim() || DEFAULT_MEMORY_WORKSPACE
      continue
    }
    if (k === 'name' || k === 'role' || k === 'section') {
      const text = String(v ?? '').trim()
      if (text !== '') bot[k] = text
      continue
    }
    ;(bot as unknown as Record<string, unknown>)[k] = v
  }
  saveState(st)
  return bot
}

/** 删除 Bot：移除档案、清掉它的会话绑定、暂停它的日程；不删会话本身。 */
export function deleteBot(id: string): boolean {
  const st = loadState()
  const before = st.bots.length
  st.bots = st.bots.filter((b) => b.id !== id)
  if (st.bots.length === before) return false
  for (const [sessionId, botId] of Object.entries(st.sessions)) {
    if (botId === id) delete st.sessions[sessionId]
  }
  for (const routine of st.routines) {
    if (routine.botId === id) {
      routine.enabled = false
      routine.updatedAt = Date.now()
    }
  }
  for (const group of st.groups) {
    group.botIds = group.botIds.filter((botId) => botId !== id)
    if (group.primaryBotId === id) delete group.primaryBotId
  }
  // 主 Bot 被删：把第一个补成主
  if (!st.bots.some((b) => b.primary) && st.bots.length > 0) st.bots[0].primary = true
  saveState(st)
  return true
}

/** 深拷贝档案：复制 skill/日程定义，不复制 sessionIds（也不复制历史与主位）。 */
export function duplicateBot(id: string): BotRecord | null {
  const st = loadState()
  const source = st.bots.find((b) => b.id === id)
  if (source === undefined) return null
  const baseName = source.name + ' 副本'
  let name = baseName
  let suffix = 2
  while (st.bots.some((b) => b.name === name)) {
    name = baseName + ' ' + suffix
    suffix += 1
  }
  const copy = JSON.parse(JSON.stringify(source)) as BotRecord
  copy.id = randomId('bot')
  copy.name = name
  copy.primary = false
  copy.pinned = false
  copy.sessionIds = []
  copy.createdAt = Date.now()
  copy.status = 'idle'
  st.bots.push(copy)
  // 日程定义跟着复制，但指向新的日程记录、重新生成 webhook key，也不复用官方 schedule id。
  for (const routine of st.routines.filter((item) => item.botId === id)) {
    const cloned = JSON.parse(JSON.stringify(routine)) as RoutineRecord
    cloned.id = randomId('routine')
    cloned.botId = copy.id
    cloned.key = randomToken()
    cloned.runs = []
    cloned.createdAt = Date.now()
    cloned.updatedAt = Date.now()
    delete cloned.scheduleId
    st.routines.push(cloned)
  }
  saveState(st)
  return copy
}

export function setPrimary(id: string): BotRecord | null {
  const st = loadState()
  const target = st.bots.find((b) => b.id === id)
  if (target === undefined) return null
  st.bots.forEach((b) => { b.primary = b.id === id })
  saveState(st)
  return target
}

/** 暂停/恢复 Bot。paused 的 Bot 不再接受新任务，但日程仍可跑。 */
export function setBotPaused(id: string, paused: boolean): BotRecord | null {
  const st = loadState()
  const bot = st.bots.find((b) => b.id === id)
  if (bot === undefined) return null
  bot.paused = paused
  saveState(st)
  return bot
}

export function findBot(id: string): BotRecord | null {
  return loadState().bots.find((b) => b.id === id) ?? null
}

/* ─────────────────────────────── 会话绑定表 ───────────────────────────────── */

export function bindSession(sessionId: string, botId: string): boolean {
  const st = loadState()
  const bot = st.bots.find((b) => b.id === botId)
  if (bot === undefined) return false
  st.sessions[sessionId] = botId
  if (!bot.sessionIds.includes(sessionId)) bot.sessionIds.push(sessionId)
  saveState(st)
  return true
}

export function unbindSession(sessionId: string): boolean {
  const st = loadState()
  const botId = st.sessions[sessionId]
  if (botId === undefined) return false
  delete st.sessions[sessionId]
  const bot = st.bots.find((b) => b.id === botId)
  if (bot !== undefined) bot.sessionIds = bot.sessionIds.filter((id) => id !== sessionId)
  saveState(st)
  return true
}

/** sessionId → botId；绑定表缺失时回退遍历 Bot.sessionIds。 */
export function botIdForSession(sessionId: string): string | null {
  const st = loadState()
  const bound = st.sessions[sessionId]
  if (typeof bound === 'string' && st.bots.some((b) => b.id === bound)) return bound
  const owner = st.bots.find((b) => b.sessionIds.includes(sessionId))
  return owner?.id ?? null
}

export function botForSession(sessionId: string): BotRecord | null {
  const botId = botIdForSession(sessionId)
  return botId === null ? null : findBot(botId)
}

/** 某 Bot 的会话绑定（含绑定表与 Bot.sessionIds 的并集）。 */
export function listSessionsForBot(botId: string): Array<{ sessionId: string; botId: string }> {
  const st = loadState()
  const bot = st.bots.find((b) => b.id === botId)
  if (bot === undefined) return []
  const ids = new Set<string>(bot.sessionIds)
  for (const [sessionId, owner] of Object.entries(st.sessions)) {
    if (owner === botId) ids.add(sessionId)
  }
  return [...ids].map((sessionId) => ({ sessionId, botId }))
}

/* ───────────────────────────────── 群组 CRUD ─────────────────────────────── */

export function listGroups(): BotGroup[] {
  return [...loadState().groups]
}

export function findGroup(id: string): BotGroup | null {
  return loadState().groups.find((g) => g.id === id) ?? null
}

export function insertGroup(group: BotGroup): void {
  const st = loadState()
  st.groups.push(group)
  saveState(st)
}

export function updateGroupRecord(id: string, patch: Partial<BotGroup>): BotGroup | null {
  const st = loadState()
  const group = st.groups.find((g) => g.id === id)
  if (group === undefined) return null
  if (Array.isArray(patch.botIds)) group.botIds = asStringArray(patch.botIds)
  if (typeof patch.name === 'string' && patch.name.trim() !== '') group.name = patch.name.trim()
  if (patch.primaryBotId === null) delete group.primaryBotId
  else if (typeof patch.primaryBotId === 'string' && group.botIds.includes(patch.primaryBotId)) group.primaryBotId = patch.primaryBotId
  if (patch.model !== undefined) group.model = normalizeGroupModel(patch.model)
  saveState(st)
  return group
}

export function deleteGroupRecord(id: string): boolean {
  const st = loadState()
  const before = st.groups.length
  st.groups = st.groups.filter((g) => g.id !== id)
  if (st.groups.length === before) return false
  saveState(st)
  return true
}

/* ───────────────────────────────── 日程 CRUD ─────────────────────────────── */

export function listRoutines(botId?: string): RoutineRecord[] {
  const st = loadState()
  return botId === undefined || botId === ''
    ? [...st.routines]
    : st.routines.filter((routine) => routine.botId === botId)
}

export function findRoutine(id: string): RoutineRecord | null {
  return loadState().routines.find((routine) => routine.id === id) ?? null
}

export function insertRoutine(routine: RoutineRecord): void {
  const st = loadState()
  st.routines.push(routine)
  saveState(st)
}

export function updateRoutineRecord(id: string, patch: Partial<RoutineRecord>): RoutineRecord | null {
  const st = loadState()
  const routine = st.routines.find((item) => item.id === id)
  if (routine === undefined) return null
  if (typeof patch.name === 'string' && patch.name.trim() !== '') routine.name = patch.name.trim()
  if (typeof patch.instruction === 'string' && patch.instruction.trim() !== '') routine.instruction = patch.instruction.trim()
  if (typeof patch.enabled === 'boolean') routine.enabled = patch.enabled
  if (patch.scheduleId === null) delete routine.scheduleId
  else if (typeof patch.scheduleId === 'string' && patch.scheduleId !== '') routine.scheduleId = patch.scheduleId
  if (Array.isArray(patch.triggers)) routine.triggers = patch.triggers
  routine.updatedAt = Date.now()
  saveState(st)
  return routine
}

export function deleteRoutineRecord(id: string): boolean {
  const st = loadState()
  const before = st.routines.length
  st.routines = st.routines.filter((routine) => routine.id !== id)
  if (st.routines.length === before) return false
  saveState(st)
  return true
}

/** 追加一条运行记录，只保留最近 20 条。 */
export function appendRoutineRun(id: string, run: RoutineRun): RoutineRecord | null {
  const st = loadState()
  const routine = st.routines.find((item) => item.id === id)
  if (routine === undefined) return null
  routine.runs = [...routine.runs, run].slice(-MAX_ROUTINE_RUNS)
  saveState(st)
  return routine
}

/* ──────────────────────────────── 审批规则 / 用量 ─────────────────────────── */

export function listRules(): ApprovalRule[] {
  return [...loadState().rules]
}

export function replaceRules(rules: ApprovalRule[]): ApprovalRule[] {
  const st = loadState()
  st.rules = rules
  saveState(st)
  return [...st.rules]
}

export function readUsage(): Record<string, BotUsage> {
  return { ...loadState().usage }
}

export function recordUsage(botId: string, input: number, output: number, runs = 1): void {
  const st = loadState()
  const current = st.usage[botId] ?? { input: 0, output: 0, runs: 0 }
  st.usage[botId] = {
    input: current.input + (Number.isFinite(input) ? input : 0),
    output: current.output + (Number.isFinite(output) ? output : 0),
    runs: current.runs + (Number.isFinite(runs) ? runs : 0),
  }
  saveState(st)
}

/* ─────────────────────────────── UI 模式 ─────────────────────────────────── */

export function getUiMode(): 'work' | 'bot' {
  return loadState().ui.mode
}

export function setUiMode(mode: 'work' | 'bot'): void {
  const st = loadState()
  st.ui.mode = mode === 'work' ? 'work' : 'bot'
  saveState(st)
}

/** 生成一个新的日程 webhook 密钥（供 routines 模块创建记录时使用）。 */
export function newRoutineKey(): string {
  return randomToken() + randomToken()
}

/** 生成新的记录 id（Bot/日程/群组共用）。 */
export function newRecordId(prefix: string): string {
  return randomId(prefix)
}
