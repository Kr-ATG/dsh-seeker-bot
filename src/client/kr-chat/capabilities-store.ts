/**
 * dsh-seeker-bot — 操作面板「MCP 与 Skill 调用」开合状态与数据共享 Store。
 *
 * 聚合当前会话与其所有子代理中真正调用过的 MCP 工具与 Skill 技能，
 * 卡头统计徽标与弹出大盘卡片共用同一份快照与数据源。
 *
 * @module
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { SubagentRow } from './subagent-catalog.ts'
import { callName } from '../tool-summary/tool-stats.ts'

export interface CapabilityItem {
  readonly id: string
  readonly kind: 'mcp' | 'skill'
  readonly name: string
  readonly server?: string
  readonly tool?: string
  readonly displayName: string
  readonly sessionId: string
  readonly sessionRole: 'main' | 'subagent'
  readonly subagentLabel?: string
  readonly callCount: number
  readonly lastTime: number
  readonly status: 'success' | 'failed' | 'running'
  readonly argsSummary?: string
}

export interface CapabilitiesSnapshot {
  readonly open: boolean
  readonly mcpCount: number
  readonly skillCount: number
  readonly mcpTotalCalls: number
  readonly skillTotalCalls: number
  readonly items: readonly CapabilityItem[]
  readonly loading: boolean
  readonly sessionId: string | null
}

type Listener = () => void

const EMPTY_SNAPSHOT: CapabilitiesSnapshot = {
  open: false,
  mcpCount: 0,
  skillCount: 0,
  mcpTotalCalls: 0,
  skillTotalCalls: 0,
  items: [],
  loading: false,
  sessionId: null,
}

class CapabilitiesStore {
  private open = false
  private sessionId: string | null = null
  private subagents: readonly SubagentRow[] = []
  private loading = false
  private hostItems: readonly CapabilityItem[] = []
  private liveToolNodes: readonly unknown[] = []
  private listeners = new Set<Listener>()
  private cachedSnapshot: CapabilitiesSnapshot = EMPTY_SNAPSHOT
  private pollTimer?: number
  private refreshTimer?: number
  private abortController?: AbortController

  constructor() {
    this.recompute()
  }

  getSnapshot = (): CapabilitiesSnapshot => {
    return this.cachedSnapshot
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        console.error('[capabilities-store] listener error', err)
      }
    }
  }

  toggle(): void {
    this.open = !this.open
    if (this.open) {
      void this.fetchHostData()
    }
    this.recompute()
    this.notify()
  }

  setOpen(open: boolean): void {
    if (this.open === open) return
    this.open = open
    if (this.open) {
      void this.fetchHostData()
    }
    this.recompute()
    this.notify()
  }

  setSession(sessionId: string | null, subagents: readonly SubagentRow[] = []): void {
    const subagentsKey = subagents.map((s) => `${s.id}:${s.label}:${s.running ? '1' : '0'}`).join('|')
    const prevSubagentsKey = this.subagents.map((s) => `${s.id}:${s.label}:${s.running ? '1' : '0'}`).join('|')
    const sessionChanged = this.sessionId !== sessionId
    const subagentsChanged = subagentsKey !== prevSubagentsKey

    if (!sessionChanged && !subagentsChanged) return

    this.sessionId = sessionId
    this.subagents = subagents

    if (sessionChanged) {
      this.hostItems = []
    }

    void this.fetchHostData()
    this.setupPolling()
    this.recompute()
    this.notify()
  }

  setLiveToolNodes(nodes: readonly unknown[]): void {
    if (this.liveToolNodes === nodes) return
    const prevCount = this.liveToolNodes.length
    this.liveToolNodes = nodes
    this.recompute()
    this.notify()
    /*
     * 会话里出现**新的工具调用**时，主动补一次宿主数据刷新（延迟节流，一次一批）。
     *
     * 为什么必须补：徽标只由 host 侧事件日志算出来，而 setSession 只在会话
     * 切换时抓一次；调用 skill / MCP 之后若从不点开弹窗，卡头数字会一直停在
     * 上一次抓到的旧值 —— 用户看到的就是「数字从来不变化」。
     */
    if (nodes.length !== prevCount) this.scheduleRefresh()
  }

  /** 延迟抓一次宿主数据；同一批工具调用只排一次，避免每个节点都打一次全量日志。 */
  private scheduleRefresh(delay = 1200): void {
    if (!this.sessionId) return
    if (this.refreshTimer !== undefined) return
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined
      void this.fetchHostData()
    }, delay)
  }

  refresh = async (): Promise<void> => {
    await this.fetchHostData()
  }

  private setupPolling(): void {
    if (this.pollTimer !== undefined) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }

    // 若有子代理还在跑，设置 5 秒轮询
    const hasRunningSubagents = this.subagents.some((s) => s.running)
    if (hasRunningSubagents && this.sessionId) {
      this.pollTimer = window.setInterval(() => {
        void this.fetchHostData()
      }, 5000)
    }
  }

  private async fetchHostData(): Promise<void> {
    if (!this.sessionId) {
      this.hostItems = []
      this.recompute()
      this.notify()
      return
    }

    this.abortController?.abort()
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    this.loading = true
    this.recompute()
    this.notify()

    try {
      const subParam = this.subagents
        .map((s) => `${s.id}:${encodeURIComponent(s.label || '')}`)
        .join(',')
      const url = `/api/chat-flow/session-capabilities?session=${encodeURIComponent(this.sessionId)}${
        subParam ? `&subagents=${encodeURIComponent(subParam)}` : ''
      }`

      const res = await fetch(url, { signal, cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data && data.ok && Array.isArray(data.items)) {
        this.hostItems = data.items
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('[capabilities-store] fetch error', err)
      }
    } finally {
      this.loading = false
      this.recompute()
      this.notify()
    }
  }

  private extractLiveCapabilities(): CapabilityItem[] {
    if (!this.sessionId || !Array.isArray(this.liveToolNodes)) return []
    const items: CapabilityItem[] = []
    const map = new Map<string, CapabilityItem>()

    for (const node of this.liveToolNodes) {
      if (!node || typeof node !== 'object') continue
      const data = (node as any).data
      const root = data?.root
      if (!root) continue

      let name = ''
      try {
        name = callName(root)
      } catch {
        continue
      }
      if (!name) continue

      const callTime = typeof (root as any).time === 'number' ? (root as any).time : Date.now()
      const isErr = (root as any).isError === true
      const isRunning = !('kind' in root)
      const status: 'success' | 'failed' | 'running' = isRunning ? 'running' : isErr ? 'failed' : 'success'

      // 获取 raw arguments（PTC 派发的参数是对象，普通工具调用是 JSON 字符串）
      const argsRaw = rawArgsOf(root)

      // 1. MCP
      if (name.startsWith('mcp__')) {
        const rest = name.slice('mcp__'.length)
        const sepIdx = rest.indexOf('__')
        const server = sepIdx > 0 ? rest.slice(0, sepIdx) : rest
        const tool = sepIdx > 0 ? rest.slice(sepIdx + 2) : rest
        const groupKey = `mcp:${name}:${this.sessionId}`

        const existing = map.get(groupKey)
        if (existing) {
          map.set(groupKey, {
            ...existing,
            callCount: existing.callCount + 1,
            lastTime: Math.max(existing.lastTime, callTime),
            status: status === 'running' ? 'running' : existing.status,
          })
        } else {
          map.set(groupKey, {
            id: groupKey,
            kind: 'mcp',
            name,
            server,
            tool,
            displayName: `${server} / ${tool}`,
            sessionId: this.sessionId,
            sessionRole: 'main',
            callCount: 1,
            lastTime: callTime,
            status,
            argsSummary: summarizeArgsString(argsRaw),
          })
        }
        continue
      }

      // 2. Skill
      if (name === 'skill' || name === 'tool-skill') {
        let skillName = ''
        try {
          const parsed = JSON.parse(argsRaw)
          skillName = parsed?.name || parsed?.skill || ''
        } catch {}
        if (skillName) {
          const groupKey = `skill:${skillName}:${this.sessionId}`
          const existing = map.get(groupKey)
          if (existing) {
            map.set(groupKey, {
              ...existing,
              callCount: existing.callCount + 1,
              lastTime: Math.max(existing.lastTime, callTime),
              status: status === 'running' ? 'running' : existing.status,
            })
          } else {
            map.set(groupKey, {
              id: groupKey,
              kind: 'skill',
              name: skillName,
              displayName: skillName,
              sessionId: this.sessionId,
              sessionRole: 'main',
              callCount: 1,
              lastTime: callTime,
              status,
              argsSummary: summarizeArgsString(argsRaw),
            })
          }
        }
        continue
      }

      if (name.startsWith('skill__')) {
        const skillName = name.slice('skill__'.length).trim()
        if (skillName) {
          const groupKey = `skill:${skillName}:${this.sessionId}`
          const existing = map.get(groupKey)
          if (existing) {
            map.set(groupKey, {
              ...existing,
              callCount: existing.callCount + 1,
              lastTime: Math.max(existing.lastTime, callTime),
              status: status === 'running' ? 'running' : existing.status,
            })
          } else {
            map.set(groupKey, {
              id: groupKey,
              kind: 'skill',
              name: skillName,
              displayName: skillName,
              sessionId: this.sessionId,
              sessionRole: 'main',
              callCount: 1,
              lastTime: callTime,
              status,
              argsSummary: summarizeArgsString(argsRaw),
            })
          }
        }
      }
    }

    return [...map.values()]
  }

  private recompute(): void {
    const liveItems = this.extractLiveCapabilities()

    // 合并 hostItems 与 liveItems
    const mergedMap = new Map<string, CapabilityItem>()

    // 先压入 hostItems
    for (const item of this.hostItems) {
      mergedMap.set(`${item.kind}:${item.name}:${item.sessionId}`, item)
    }

    // 再用主会话的 live 提取补齐或更新
    for (const item of liveItems) {
      const key = `${item.kind}:${item.name}:${item.sessionId}`
      const existing = mergedMap.get(key)
      if (existing) {
        mergedMap.set(key, {
          ...existing,
          callCount: Math.max(existing.callCount, item.callCount),
          lastTime: Math.max(existing.lastTime, item.lastTime),
          status: item.status,
          argsSummary: item.argsSummary || existing.argsSummary,
        })
      } else {
        mergedMap.set(key, item)
      }
    }

    const items = [...mergedMap.values()].sort((a, b) => b.lastTime - a.lastTime)

    const uniqueMcpNames = new Set<string>()
    const uniqueSkillNames = new Set<string>()
    let mcpTotalCalls = 0
    let skillTotalCalls = 0

    for (const item of items) {
      if (item.kind === 'mcp') {
        uniqueMcpNames.add(item.name)
        mcpTotalCalls += item.callCount
      } else if (item.kind === 'skill') {
        uniqueSkillNames.add(item.name)
        skillTotalCalls += item.callCount
      }
    }

    this.cachedSnapshot = {
      open: this.open,
      mcpCount: uniqueMcpNames.size,
      skillCount: uniqueSkillNames.size,
      mcpTotalCalls,
      skillTotalCalls,
      items,
      loading: this.loading,
      sessionId: this.sessionId,
    }
  }
}

/**
 * 从工具节点读参数原文。
 *
 * 形态有两种：普通工具节点是 `argsRaw` JSON 字符串；PTC 派发（run_code 内层调用）
 * 直接给对象。只认字符串会让后者退化成空串，`JSON.parse('')` 抛错 → skill 名
 * 解析不出来，与宿主侧同一处坑（2026-11-04 修）。
 */
function rawArgsOf(root: any): string {
  const raw = 'kind' in root ? (root.call?.argsRaw ?? root.call?.args) : (root.argsRaw ?? root.args)
  if (typeof raw === 'string') return raw
  if (raw !== null && typeof raw === 'object') {
    try {
      return JSON.stringify(raw)
    } catch {
      return ''
    }
  }
  return ''
}

function summarizeArgsString(argsRaw: string): string {
  if (!argsRaw || argsRaw.trim() === '') return ''
  try {
    const obj = JSON.parse(argsRaw)
    if (typeof obj !== 'object' || obj === null) return String(obj).slice(0, 50)
    const pairs: string[] = []
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue
      if (typeof v === 'string') {
        const val = v.replace(/[\r\n\t]+/g, ' ').trim()
        pairs.push(`${k}: ${val.length > 20 ? val.slice(0, 18) + '...' : val}`)
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        pairs.push(`${k}: ${v}`)
      }
      if (pairs.length >= 3) break
    }
    return pairs.join(', ')
  } catch {
    return argsRaw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 50)
  }
}

let storeSingleton: CapabilitiesStore | null = null

export function getCapabilitiesStore(): CapabilitiesStore {
  if (storeSingleton === null) {
    storeSingleton = new CapabilitiesStore()
  }
  return storeSingleton
}

export function useCapabilitiesSnapshot(): CapabilitiesSnapshot {
  const store = getCapabilitiesStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
