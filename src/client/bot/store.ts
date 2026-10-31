/**
 * dsh-seeker-bot — Bot 控制台的共享状态（侧栏名册与右栏面板同源）。
 *
 * 为什么不是每个模块各拉一份：名册点击「新建 Bot」后，右栏面板与名册必须
 * 在同一拍看到同一份 bots / mode；两份 fetch 会互相覆盖。
 *
 * live reload 时旧 bundle 的模块级变量不会回收，所以 store 挂在 globalThis
 * 的固定键上（同 kr-chat-controller 的做法）：新旧实例共享同一份状态与订阅。
 */

import { fetchBotState } from './api.ts'
import type { BotGroup, BotRecord, BotStatePayload } from './model.ts'

export interface BotConsoleSnapshot {
  readonly ready: boolean
  readonly busy: boolean
  readonly mode: 'work' | 'bot'
  readonly bots: readonly BotRecord[]
  readonly groups: readonly BotGroup[]
  readonly selected: string
  readonly error: string
  readonly notice: string
  /** 单调递增版本号：React useSyncExternalStore 靠它判断快照是否变化。 */
  readonly revision: number
}

export interface BotConsoleStore {
  getSnapshot(): BotConsoleSnapshot
  subscribe(listener: () => void): () => void
  applyPayload(payload: BotStatePayload): void
  refresh(): Promise<BotStatePayload | null>
  setMode(mode: 'work' | 'bot'): void
  select(id: string): void
  setBusy(busy: boolean): void
  setError(message: string): void
  setNotice(message: string): void
  clearError(): void
  clearNotice(): void
  botById(id: string): BotRecord | null
}

const GLOBAL_KEY = '__dshSeekerBotConsoleStoreV1__'

function createStore(): BotConsoleStore {
  let bots: BotRecord[] = []
  let groups: BotGroup[] = []
  let mode: 'work' | 'bot' = 'bot'
  let selected = ''
  let ready = false
  let busy = false
  let error = ''
  let notice = ''
  let revision = 0
  let inflight: Promise<BotStatePayload | null> | null = null

  const listeners = new Set<() => void>()

  let snapshot: BotConsoleSnapshot = Object.freeze({
    ready, busy, mode, bots, groups, selected, error, notice, revision,
  })

  function publish(): void {
    revision += 1
    snapshot = Object.freeze({ ready, busy, mode, bots, groups, selected, error, notice, revision })
    for (const listener of [...listeners]) {
      try { listener() } catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
  }

  function ensureSelection(): void {
    const ids = bots.filter((bot) => bot.hidden !== true).map((bot) => bot.id)
    if (selected !== '' && ids.includes(selected)) return
    selected = ids[0] ?? ''
  }

  function applyPayload(payload: BotStatePayload): void {
    bots = Array.isArray(payload.bots) ? payload.bots : []
    groups = Array.isArray(payload.groups) ? payload.groups : []
    if (payload.ui?.mode === 'work' || payload.ui?.mode === 'bot') mode = payload.ui.mode
    const hinted = typeof payload.ui?.lastBotId === 'string' ? payload.ui.lastBotId : ''
    if (hinted !== '' && bots.some((bot) => bot.id === hinted)) selected = hinted
    ensureSelection()
    ready = true
    error = ''
    publish()
  }

  async function refresh(): Promise<BotStatePayload | null> {
    if (inflight !== null) return inflight
    inflight = (async (): Promise<BotStatePayload | null> => {
      const res = await fetchBotState()
      if (!res.ok) {
        error = '读取 Bot 状态失败：' + (res.error ?? '未知错误')
        publish()
        return null
      }
      return res.data ?? null
    })()
      .then((payload) => {
        if (payload !== null) applyPayload(payload)
        inflight = null
        return payload
      })
      .catch((err: unknown) => {
        error = '读取 Bot 状态失败：' + (err instanceof Error ? err.message : String(err))
        inflight = null
        publish()
        return null
      })
    return inflight
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    applyPayload,
    refresh,
    setMode(next) {
      if (next === mode) return
      mode = next
      publish()
    },
    select(id) {
      if (id === selected) return
      selected = id
      publish()
    },
    setBusy(next) {
      if (next === busy) return
      busy = next
      publish()
    },
    setError(message) {
      error = message
      if (message !== '') notice = ''
      publish()
    },
    setNotice(message) {
      notice = message
      if (message !== '') error = ''
      publish()
    },
    clearError() {
      if (error === '') return
      error = ''
      publish()
    },
    clearNotice() {
      if (notice === '') return
      notice = ''
      publish()
    },
    botById(id) {
      return bots.find((bot) => bot.id === id) ?? null
    },
  }
}

/** 取全页面唯一的 store（live reload 后复用旧实例）。 */
export function getBotConsoleStore(): BotConsoleStore {
  const holder = globalThis as unknown as Record<string, unknown>
  const existing = holder[GLOBAL_KEY]
  if (existing !== undefined && existing !== null && typeof existing === 'object') {
    const candidate = existing as BotConsoleStore
    if (typeof candidate.getSnapshot === 'function' && typeof candidate.refresh === 'function') return candidate
  }
  const created = createStore()
  holder[GLOBAL_KEY] = created
  return created
}
