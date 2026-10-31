/**
 * dsh-seeker-bot — Bot 数据层。
 *
 * 只存「编排信息」：Bot 档案、分组、界面状态。会话内容在 DSH 会话存储里，
 * 技能在 ~/.dsh/skills，记忆在插件自己的工作区，这里不复制。
 *
 * 存储：${DSH_HOME:-~/.dsh}/storages/dsh-seeker-bot/state.json
 * 写入：tmp + rename 原子替换；单进程串行。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs'

export type BotStatus = 'idle' | 'working' | 'needs-you' | 'unread'

export interface BotAvatar {
  shape: 'whale' | 'orbit' | 'cube' | 'leaf' | 'spark' | 'ring'
  color: string
}

export interface BotRecord {
  id: string
  name: string
  role: string
  label?: string
  avatar: BotAvatar
  /** 首条消息固化的岗位与边界，注入系统提示。 */
  instructions: string
  primary: boolean
  pinned: boolean
  section: string
  hidden: boolean
  paused: boolean
  notification: boolean
  model?: { provider?: string; model?: string; effort?: 'low' | 'mid' | 'high' | 'max' }
  proactive?: { enabled: boolean; freq: string; from: string; to: string; lastAt?: number }
  output?: { charts: boolean; pages: boolean }
  sessionIds: string[]
  createdAt: number
  createdBy: string | null
  status: BotStatus
}

export interface BotGroup {
  id: string
  name: string
  botIds: string[]
  model?: { mode: 'inherit' } | { mode: 'unified'; provider?: string; model?: string; effort?: string }
  createdAt: number
}

export interface BotState {
  version: 1
  bots: BotRecord[]
  groups: BotGroup[]
  ui: { mode: 'work' | 'bot'; lastBotId?: string }
}

const DEFAULT_SHAPE: BotAvatar['shape'] = 'whale'
const DEFAULT_COLOR = '#0f1115'

export function stateDir(): string {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  return join(base, 'storages', 'dsh-seeker-bot')
}

export function statePath(): string {
  return join(stateDir(), 'state.json')
}

function emptyState(): BotState {
  return { version: 1, bots: [], groups: [], ui: { mode: 'bot' } }
}

let cache: BotState | null = null

export function loadState(): BotState {
  if (cache !== null) return cache
  const file = statePath()
  if (!existsSync(file)) {
    cache = emptyState()
    return cache
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BotState>
    const st: BotState = {
      version: 1,
      bots: Array.isArray(raw.bots) ? raw.bots as BotRecord[] : [],
      groups: Array.isArray(raw.groups) ? raw.groups as BotGroup[] : [],
      ui: raw.ui && typeof raw.ui === 'object' ? raw.ui as BotState['ui'] : { mode: 'bot' },
    }
    cache = st
    return st
  } catch {
    // 读坏了不阻塞：备份后从空状态起，用户数据至少还在盘上
    try { copyFileSync(file, file + '.broken-' + Date.now()) } catch { /* ignore */ }
    cache = emptyState()
    return cache
  }
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

export interface CreateBotInput {
  name?: unknown
  role?: unknown
  instructions?: unknown
  shape?: unknown
  color?: unknown
  section?: unknown
}

const SHAPES = new Set(['whale', 'orbit', 'cube', 'leaf', 'spark', 'ring'])

export function createBot(input: CreateBotInput): BotRecord {
  const st = loadState()
  const name = String(input.name ?? '').trim() || '新队友'
  const role = String(input.role ?? '').trim() || '通用助手'
  const shape = SHAPES.has(String(input.shape)) ? String(input.shape) as BotAvatar['shape'] : DEFAULT_SHAPE
  const color = /^#[0-9a-fA-F]{6}$/.test(String(input.color)) ? String(input.color) : DEFAULT_COLOR
  const bot: BotRecord = {
    id: 'bot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name,
    role,
    avatar: { shape, color },
    instructions: String(input.instructions ?? '').trim() || ('你是「' + name + '」，岗位：' + role + '。'),
    primary: st.bots.length === 0,
    pinned: false,
    section: String(input.section ?? '项目').trim() || '项目',
    hidden: false,
    paused: false,
    notification: true,
    output: { charts: true, pages: true },
    proactive: { enabled: false, freq: 'daily', from: '09:00', to: '22:00' },
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
  'name', 'role', 'label', 'instructions', 'pinned', 'section', 'hidden',
  'paused', 'notification', 'model', 'proactive', 'output', 'avatar', 'status',
])

export function updateBot(id: string, patch: Record<string, unknown>): BotRecord | null {
  const st = loadState()
  const bot = st.bots.find((b) => b.id === id)
  if (bot === undefined) return null
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) continue
    if (k === 'avatar' && v !== null && typeof v === 'object') {
      const av = v as Partial<BotAvatar>
      bot.avatar = {
        shape: SHAPES.has(String(av.shape)) ? String(av.shape) as BotAvatar['shape'] : bot.avatar.shape,
        color: /^#[0-9a-fA-F]{6}$/.test(String(av.color)) ? String(av.color) : bot.avatar.color,
      }
      continue
    }
    ;(bot as unknown as Record<string, unknown>)[k] = v
  }
  saveState(st)
  return bot
}

export function deleteBot(id: string): boolean {
  const st = loadState()
  const before = st.bots.length
  st.bots = st.bots.filter((b) => b.id !== id)
  if (st.bots.length === before) return false
  // 主 Bot 被删：把第一个补成主
  if (!st.bots.some((b) => b.primary) && st.bots.length > 0) st.bots[0].primary = true
  saveState(st)
  return true
}

export function setPrimary(id: string): BotRecord | null {
  const st = loadState()
  const target = st.bots.find((b) => b.id === id)
  if (target === undefined) return null
  st.bots.forEach((b) => { b.primary = b.id === id })
  saveState(st)
  return target
}

export function getUiMode(): 'work' | 'bot' {
  return loadState().ui.mode
}

export function setUiMode(mode: 'work' | 'bot'): void {
  const st = loadState()
  st.ui.mode = mode === 'work' ? 'work' : 'bot'
  saveState(st)
}
