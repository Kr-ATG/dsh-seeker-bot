/**
 * dsh-seeker-bot — 会话与子代理 MCP 与 Skill 能力调用查询（host 半身，只读路由）。
 *
 * 为什么需要它：
 * 子智能体在 DSH 里是独立会话，主会话的客户端快照里只有主会话的消息，没有子会话内部的
 * 工具事件。本路由按主会话 id 及子代理 id 列表，同时查询 live 内存事件与持久化日志，
 * 精确提取所有被真正调用的 MCP 工具（mcp__*）与 Skill 技能（skill({ name }) / skill-invocation），
 * 聚合调用次数、状态、参数摘要与时间，交给操作面板卡头与弹出大盘卡片。
 *
 * 路由：GET /api/chat-flow/session-capabilities?session=<会话id>&subagents=<子会话列表>
 */

/** 路由常量 */
export const SESSION_CAPABILITIES_ROUTE = '/api/chat-flow/session-capabilities'

const MAX_EVENTS_PER_READ = 50000

export interface SessionCapabilitiesDeps {
  readonly sessions?: any
  readonly persistence?: any
  readonly logger?: { warn?: (message: string) => void; info?: (message: string) => void }
}

export interface CapabilityItemDto {
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

export interface SessionCapabilitiesResponse {
  readonly ok: boolean
  readonly mcpCount: number
  readonly skillCount: number
  readonly mcpTotalCalls: number
  readonly skillTotalCalls: number
  readonly items: readonly CapabilityItemDto[]
  readonly error?: string
}

function json(res: any, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function summarizeArgs(argsRaw: string): string {
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

/** 读取指定会话的所有原始事件。 */
async function fetchSessionEvents(deps: SessionCapabilitiesDeps, sessionId: string): Promise<readonly any[]> {
  if (!sessionId) return []

  // 1. Live 内存中的会话（优先，零 I/O）
  if (deps.sessions !== undefined && typeof deps.sessions.list === 'function') {
    try {
      for (const session of deps.sessions.list()) {
        if (session?.id !== sessionId) continue
        if (Array.isArray(session.events)) return session.events
        if (typeof session.snapshotEvents === 'function') {
          const events = session.snapshotEvents()
          if (Array.isArray(events)) return events
        }
      }
    } catch {
      // 容错降级到持久化
    }
  }

  // 2. 持久化日志
  if (deps.persistence !== undefined) {
    if (typeof deps.persistence.open === 'function') {
      let handle: any
      try {
        handle = await deps.persistence.open(sessionId, 'read')
      } catch {
        return []
      }
      try {
        const events: any[] = []
        let cursor = 0
        while (events.length < MAX_EVENTS_PER_READ) {
          const want = MAX_EVENTS_PER_READ - events.length
          const slice = await handle.read(cursor, want)
          const batch = (slice?.events ?? []) as any[]
          if (batch.length === 0) break
          for (const ev of batch) events.push(ev)
          const last = batch[batch.length - 1]
          cursor = typeof last?.seq === 'number' ? last.seq + 1 : cursor + batch.length
          if (batch.length < want) break
        }
        return events
      } catch {
        return []
      } finally {
        try { await handle.close() } catch {}
      }
    } else if (typeof deps.persistence.readFrom === 'function') {
      try {
        const { events } = await deps.persistence.readFrom(sessionId, 0)
        return Array.isArray(events) ? events : []
      } catch {
        return []
      }
    }
  }

  return []
}

interface RawExtractedCall {
  kind: 'mcp' | 'skill'
  name: string
  server?: string
  tool?: string
  displayName: string
  time: number
  status: 'success' | 'failed' | 'running'
  argsSummary?: string
  callId?: string
}

/** 从会话事件流中提取 MCP 与 Skill 调用。 */
function extractCapabilitiesFromEvents(events: readonly any[]): RawExtractedCall[] {
  const extracted: RawExtractedCall[] = []
  const pendingCalls = new Map<string, { name: string; argsRaw: string; time: number }>()

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const type = event.type
    const data = (event.data ?? {}) as Record<string, unknown>
    const eventTime = Number.isFinite(event.time) ? (event.time as number) : Date.now()

    // 1. tool/call
    if (type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const name = typeof data.name === 'string' ? data.name : ''
      const argsRaw = typeof data.arguments === 'string' ? data.arguments : ''
      if (callId) {
        pendingCalls.set(callId, { name, argsRaw, time: eventTime })
      } else if (name) {
        // 无 callId 的即时记录
        processCall(name, argsRaw, eventTime, 'running', undefined)
      }
      continue
    }

    // 2. tool/result
    if (type === 'tool/result') {
      const message = data.message as Record<string, unknown> | undefined
      const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : ''
      const pending = callId ? pendingCalls.get(callId) : undefined
      if (pending) {
        pendingCalls.delete(callId)
        const isError = data.isError === true || message?.isError === true
        const status: 'success' | 'failed' = isError ? 'failed' : 'success'
        processCall(pending.name, pending.argsRaw, eventTime || pending.time, status, callId)
      }
      continue
    }

    // 3. tool/ptc-dispatch
    if (type === 'tool/ptc-dispatch') {
      const name = typeof data.name === 'string' ? data.name : ''
      const argsRaw = typeof data.arguments === 'string' ? data.arguments : ''
      const isError = data.isError === true
      processCall(name, argsRaw, eventTime, isError ? 'failed' : 'success', undefined)
      continue
    }

    // 4. 用户/系统注入的 skill-invocation
    if (type === 'message') {
      const source = data.source as Record<string, unknown> | undefined
      if (source && source.kind === 'skill-invocation' && typeof source.name === 'string' && source.name.trim() !== '') {
        const skillName = source.name.trim()
        extracted.push({
          kind: 'skill',
          name: skillName,
          displayName: skillName,
          time: eventTime,
          status: 'success',
          argsSummary: '指令直接触发',
        })
      }
    }
  }

  // 处理剩余仍处于 pending 中的调用
  for (const [callId, pending] of pendingCalls) {
    processCall(pending.name, pending.argsRaw, pending.time, 'running', callId)
  }

  function processCall(
    name: string,
    argsRaw: string,
    time: number,
    status: 'success' | 'failed' | 'running',
    callId?: string,
  ): void {
    if (!name) return

    // A. MCP 工具: mcp__<server>__<tool>
    if (name.startsWith('mcp__')) {
      const rest = name.slice('mcp__'.length)
      const sepIdx = rest.indexOf('__')
      const server = sepIdx > 0 ? rest.slice(0, sepIdx) : rest
      const tool = sepIdx > 0 ? rest.slice(sepIdx + 2) : rest
      extracted.push({
        kind: 'mcp',
        name,
        server,
        tool,
        displayName: `${server} / ${tool}`,
        time,
        status,
        argsSummary: summarizeArgs(argsRaw),
        callId,
      })
      return
    }

    // B. Skill 工具: name === 'skill' 或 'tool-skill'，参数里有 name
    if (name === 'skill' || name === 'tool-skill') {
      let skillName = ''
      try {
        const parsed = JSON.parse(argsRaw)
        if (parsed && typeof parsed.name === 'string') {
          skillName = parsed.name.trim()
        } else if (parsed && typeof parsed.skill === 'string') {
          skillName = parsed.skill.trim()
        }
      } catch {}
      if (skillName) {
        extracted.push({
          kind: 'skill',
          name: skillName,
          displayName: skillName,
          time,
          status,
          argsSummary: summarizeArgs(argsRaw),
          callId,
        })
      }
      return
    }

    // C. 前缀形式 skill__<name>
    if (name.startsWith('skill__')) {
      const skillName = name.slice('skill__'.length).trim()
      if (skillName) {
        extracted.push({
          kind: 'skill',
          name: skillName,
          displayName: skillName,
          time,
          status,
          argsSummary: summarizeArgs(argsRaw),
          callId,
        })
      }
    }
  }

  return extracted
}

async function handleSessionCapabilities(
  req: any,
  res: any,
  deps: SessionCapabilitiesDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    const sessionId = url.searchParams.get('session') ?? ''
    const subagentsParam = url.searchParams.get('subagents') ?? ''

    if (!sessionId || !/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) {
      json(res, 400, { ok: false, error: 'bad-session' })
      return
    }

    // 解析子代理参数：格式可能是 "id1:label1,id2:label2" 或纯 "id1,id2"
    const subagentTargets: { id: string; label?: string }[] = []
    if (subagentsParam.trim() !== '') {
      for (const piece of subagentsParam.split(',')) {
        const trimmed = piece.trim()
        if (!trimmed) continue
        const colon = trimmed.indexOf(':')
        if (colon > 0) {
          const subId = trimmed.slice(0, colon).trim()
          const subLabel = decodeURIComponent(trimmed.slice(colon + 1)).trim()
          if (/^[A-Za-z0-9_-]{1,200}$/.test(subId)) {
            subagentTargets.push({ id: subId, label: subLabel || undefined })
          }
        } else if (/^[A-Za-z0-9_-]{1,200}$/.test(trimmed)) {
          subagentTargets.push({ id: trimmed })
        }
      }
    }

    // 收集所有目标会话事件
    interface TargetSession {
      id: string
      role: 'main' | 'subagent'
      label?: string
    }

    const allTargets: TargetSession[] = [
      { id: sessionId, role: 'main' },
      ...subagentTargets.map((s) => ({ id: s.id, role: 'subagent' as const, label: s.label })),
    ]

    // 聚合分组：key = `${kind}:${name}:${targetSessionId}`
    const groupedMap = new Map<string, {
      id: string
      kind: 'mcp' | 'skill'
      name: string
      server?: string
      tool?: string
      displayName: string
      sessionId: string
      sessionRole: 'main' | 'subagent'
      subagentLabel?: string
      callCount: number
      lastTime: number
      status: 'success' | 'failed' | 'running'
      argsSummary?: string
    }>()

    let mcpTotalCalls = 0
    let skillTotalCalls = 0

    await Promise.all(
      allTargets.map(async (target) => {
        const events = await fetchSessionEvents(deps, target.id)
        const calls = extractCapabilitiesFromEvents(events)

        for (const call of calls) {
          if (call.kind === 'mcp') mcpTotalCalls += 1
          if (call.kind === 'skill') skillTotalCalls += 1

          const groupKey = `${call.kind}:${call.name}:${target.id}`
          const existing = groupedMap.get(groupKey)
          if (existing) {
            existing.callCount += 1
            if (call.time > existing.lastTime) {
              existing.lastTime = call.time
              existing.status = call.status
              if (call.argsSummary) existing.argsSummary = call.argsSummary
            }
          } else {
            groupedMap.set(groupKey, {
              id: `${call.kind}:${call.name}:${target.id}`,
              kind: call.kind,
              name: call.name,
              server: call.server,
              tool: call.tool,
              displayName: call.displayName,
              sessionId: target.id,
              sessionRole: target.role,
              subagentLabel: target.label,
              callCount: 1,
              lastTime: call.time,
              status: call.status,
              argsSummary: call.argsSummary,
            })
          }
        }
      }),
    )

    const items = [...groupedMap.values()].sort((a, b) => b.lastTime - a.lastTime)

    // 计算去重后的能力数量
    const uniqueMcpNames = new Set<string>()
    const uniqueSkillNames = new Set<string>()
    for (const item of items) {
      if (item.kind === 'mcp') uniqueMcpNames.add(item.name)
      if (item.kind === 'skill') uniqueSkillNames.add(item.name)
    }

    const responseData: SessionCapabilitiesResponse = {
      ok: true,
      mcpCount: uniqueMcpNames.size,
      skillCount: uniqueSkillNames.size,
      mcpTotalCalls,
      skillTotalCalls,
      items,
    }

    json(res, 200, responseData as unknown as Record<string, unknown>)
  } catch (error) {
    deps.logger?.warn?.(
      '[dsh-seeker-bot] session-capabilities route failed: ' +
        (error instanceof Error ? error.message : String(error)),
    )
    json(res, 500, { ok: false, error: 'internal-error' })
  }
}

/** 注册会话能力统计路由。 */
export function applySessionCapabilities(ctx: Record<string, any>): void {
  const webServer = ctx.webServer
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
  const get = (name: string): unknown => {
    try {
      return ctx.get?.(name)
    } catch {
      return undefined
    }
  }
  const deps: SessionCapabilitiesDeps = {
    sessions: get('sessions'),
    persistence: get('sessionPersistence'),
    logger: ctx.logger,
  }
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: SESSION_CAPABILITIES_ROUTE,
        handler: (req: any, res: any) => {
          void handleSessionCapabilities(req, res, deps)
        },
      }),
    'dsh-seeker-bot: session capabilities route',
  )
}

export const __test = {
  SESSION_CAPABILITIES_ROUTE,
  extractCapabilitiesFromEvents,
  summarizeArgs,
}
