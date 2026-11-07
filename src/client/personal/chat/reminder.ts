/**
 * Personal Agent — 提醒（例行任务即将开始 / 档案到期）。
 *
 * 形态刻意做得极简（2026-11-07 用户看第一版卡片后的要求：「太丑了，提醒也不是
 * 这样提醒，需要简洁，有倒计时，与立即执行就行了」）：
 *   左边一个大号数字（例行任务 = 秒级倒计时，档案 = 还剩 N 天），
 *   中间一行任务名，右边一颗「立即执行」，末尾一颗关闭。
 * 不再有卡头小标签、说明段落、三个按钮——那些都是要用户读完再决定，而提醒只需要
 * 「什么时候到 + 现在就跑」。
 *
 * 数据来源与抑制策略不变：
 *  - 例行任务读 store 的 `routines.nextAt`，落在 {@link ROUTINE_LEAD_MS} 窗口内最近一条胜出；
 *  - 档案到期问宿主 `/api/dsh-vault/reminders`（90 天阈值、已过期永远报的口径在宿主侧）；
 *  - 「今天不再提 / 忽略」按来源 id 记进 localStorage，同一个任务换触发时间不会又冒出来。
 */
import type { Routine } from '../types.ts'

/** 提醒的情绪档：info 只告知，warn 要留意，danger 已经过期 / 错过。 */
export type ReminderTone = 'info' | 'warn' | 'danger'

export type ReminderActionId = 'run-now' | 'know' | 'dismiss'

/**
 * 休息提示的常量（2026-11-07 用户要求：「增加休息提示，点击消失，不点击 3 分钟后
 * 自动消失」）。
 *   · REST_AFTER_MS    连续工作多久才提示（45 分钟）；
 *   · REST_IDLE_RESET  多久没说话算「离开了」，连续计时从头算（15 分钟）；
 *   · REST_MUTE_MS     点掉或自动消失后，一小时内不再提。
 */
export const REST_AFTER_MS = 45 * 60_000
export const REST_IDLE_RESET_MS = 15 * 60_000
export const REST_MUTE_MS = 60 * 60_000
/** 不点自动收起的时长：3 分钟。 */
export const REST_AUTO_HIDE_MS = 3 * 60_000

/** 面板上最多两颗按钮：主操作 + 关闭（关闭由组件固定渲染，不占 actions）。 */
export interface ReminderAction {
  id: ReminderActionId
  label: string
  primary?: boolean
}

/** 一条待展示的提醒。 */
export interface ReminderItem {
  /** 稳定 key（来源 id），React key 与抑制表都用它。 */
  id: string
  kind: 'routine' | 'vault' | 'rest'
  tone: ReminderTone
  /** 主文案：任务名 / 档案名 / 休息提示（单行，超出省略）。 */
  title: string
  /** 秒级倒计时的截止时间；有它就每秒刷新 mm:ss。 */
  dueAt?: number
  /** 没有倒计时时的短标记（档案到期：「还剩 12 天」/「已过期」）。 */
  badge?: string
  actions: ReminderAction[]
}

const MUTE_KEY = 'pa:remind-muted:v1'

type MuteTable = Record<string, number>

function readMutes(): MuteTable {
  try {
    const raw = localStorage.getItem(MUTE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    const table: MuteTable = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) table[key] = value
    }
    return table
  } catch {
    return {}
  }
}

/** 把一条提醒压到 `until` 之前不再出现（写 localStorage，跨刷新有效）。 */
export function muteReminder(key: string, until: number): void {
  try {
    const table = readMutes()
    table[key] = until
    localStorage.setItem(MUTE_KEY, JSON.stringify(table))
  } catch {
    /* 隐私模式 / 存储满：静默失败，最多下次再提醒一遍 */
  }
}

/** 某条提醒现在是否还在抑制期。 */
export function isMuted(key: string, now = Date.now()): boolean {
  const until = readMutes()[key]
  return typeof until === 'number' && until > now
}

/** 今天 23:59:59 的时间戳（「今天不再提」用）。 */
export function endOfToday(now = Date.now()): number {
  const date = new Date(now)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

/** 例行任务提前多久提醒。 */
export const ROUTINE_LEAD_MS = 10 * 60_000

/** 档案到期提前多少天进提醒（宿主注入侧用 90 天，界面只挑最近的几条）。 */
export const VAULT_LEAD_DAYS = 30

/**
 * 剩余毫秒 → 倒计时文本。
 *
 * 10 分钟内只到分钟级就够，但秒级数字在跳，用户能感到「它真的在走」；
 * 超过一小时补上小时位（档案类不用，那边直接给「还剩 N 天」）。
 */
export function formatCountdown(remaining: number): string {
  const total = Math.max(0, Math.ceil(remaining / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/**
 * 从例行任务里挑出「即将开始」的一条。
 *
 * 只认 enabled 且有 nextAt 的：禁用中的任务 nextAt 是旧值，拿它算会报出
 * 「3 分钟后开始」但其实永远不会跑。
 */
export function routineReminderOf(routines: readonly Routine[], now = Date.now()): ReminderItem | null {
  const due = routines
    .filter((routine) => routine.enabled && typeof routine.nextAt === 'number' && Number.isFinite(routine.nextAt))
    .map((routine) => ({ routine, at: routine.nextAt as number }))
    .filter((row) => row.at > now && row.at - now <= ROUTINE_LEAD_MS)
    .sort((left, right) => left.at - right.at)[0]
  if (due === undefined) return null
  const key = `routine:${due.routine.id}`
  if (isMuted(key, now)) return null
  return {
    id: key,
    kind: 'routine',
    tone: 'warn',
    title: due.routine.name,
    dueAt: due.at,
    actions: [{ id: 'run-now', label: '立即执行', primary: true }],
  }
}

/** 宿主 /reminders 返回里本文档用得上的那几个字段。 */
interface VaultReminderRow {
  recordId: string
  title: string
  fieldLabel: string
  days: number
  due: string
  expired: boolean
}

/**
 * 拉一次档案到期提醒，挑最近的、且落在 {@link VAULT_LEAD_DAYS} 内的一条。
 *
 * 宿主没启用档案（路由 404）、或没有到期项时一律返回 null——提醒是锦上添花，
 * 任何异常都不该让聊天界面报错。
 */
export async function fetchVaultReminder(signal?: AbortSignal): Promise<ReminderItem | null> {
  let rows: VaultReminderRow[]
  try {
    const response = await fetch('/api/dsh-vault/reminders', { signal })
    if (!response.ok) return null
    const body: unknown = await response.json()
    const report = (body as { report?: { reminders?: unknown } } | null)?.report
    const raw = Array.isArray(report?.reminders) ? report.reminders : []
    rows = raw.filter((row): row is VaultReminderRow => {
      const candidate = row as VaultReminderRow | null
      return candidate !== null
        && typeof candidate === 'object'
        && typeof candidate.recordId === 'string'
        && typeof candidate.days === 'number'
        && typeof candidate.title === 'string'
    })
  } catch {
    return null
  }
  const nearest = rows
    .filter((row) => row.days <= VAULT_LEAD_DAYS)
    .sort((left, right) => left.days - right.days)[0]
  if (nearest === undefined) return null
  const key = `vault:${nearest.recordId}`
  if (isMuted(key, Date.now())) return null
  return {
    id: key,
    kind: 'vault',
    tone: nearest.expired ? 'danger' : nearest.days <= 7 ? 'warn' : 'info',
    title: nearest.title,
    badge: nearest.expired ? '已过期' : `还剩 ${String(nearest.days)} 天`,
    actions: [{ id: 'know', label: '知道了' }],
  }
}

/**
 * 休息提示：连续工作满 {@link REST_AFTER_MS} 才出现。
 *
 * 「连续」由调用方维护（`activeSince`：用户超过 {@link REST_IDLE_RESET_MS} 没说话
 * 就把起点重置），这里只判断够不够久、有没有被压过。没有倒计时——它不是「几点
 * 开始的事」，是一句提醒。
 */
export function restReminderOf(now: number, activeSince: number): ReminderItem | null {
  if (now - activeSince < REST_AFTER_MS) return null
  const key = 'rest:break'
  if (isMuted(key, now)) return null
  const minutes = Math.max(1, Math.round((now - activeSince) / 60_000))
  return {
    id: key,
    kind: 'rest',
    tone: 'info',
    title: '该休息一下了',
    badge: `已连续 ${String(minutes)} 分钟`,
    actions: [{ id: 'know', label: '知道了' }],
  }
}
