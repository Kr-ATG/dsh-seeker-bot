/**
 * 从 agent / session 读当前 turn 号（记忆工具写 provenance 用）。
 *
 * 优先用宿主的 turnBoundary 投影；没有该服务时退回扫描 session 日志里的
 * 最近一个 `turn/start`。两者都拿不到时返回 0，调用方会退回时间窗口兜底。
 */

interface TurnAwareSession {
  readonly id?: string
  snapshotEvents?: () => readonly any[]
}

/** 记忆工具拿得到的 agent 最小面。 */
export interface TurnAwareAgent {
  readonly session?: TurnAwareSession
  readonly ctx?: { get?: (name: string) => any }
}

/** 当前 turn 号；0 表示未知。 */
export function currentTurnOf(agent: TurnAwareAgent | undefined): number {
  if (agent === undefined) return 0
  try {
    const boundary = agent.ctx?.get?.('agents')?.turnBoundaryOf?.(agent.session)
    if (typeof boundary?.lastTurn === 'number' && Number.isInteger(boundary.lastTurn) && boundary.lastTurn > 0) {
      return boundary.lastTurn
    }
  } catch {
    /* 没有投影服务：走日志扫描 */
  }
  try {
    const events = typeof agent.session?.snapshotEvents === 'function'
      ? agent.session.snapshotEvents()
      : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'turn/start') continue
      const turn = Number(event?.data?.turn ?? 0)
      if (Number.isInteger(turn) && turn > 0) return turn
    }
  } catch {
    /* 读不到日志：返回 0 */
  }
  return 0
}

/** 当前这一轮里最后一条真人消息的位置（用于消息级撤回）。 */
export interface PromptPosition {
  turn: number
  /** 该 turn 里最后一条 `source.kind === 'user'` 的消息 id。 */
  userMessageId?: string
}

/**
 * 读当前 turn 与最后一条真人消息 id。
 *
 * 为什么需要消息 id：Bot 允许执行中插话（steer），第 2、3 句会落在同一个
 * turn 里。只记 turn 无法区分「撤回第 2 句」和「撤回第 3 句」，必须把
 * provenance 再细到 userMessageId。
 */
export function currentPromptOf(agent: TurnAwareAgent | undefined): PromptPosition {
  const turn = currentTurnOf(agent)
  try {
    const events = typeof agent?.session?.snapshotEvents === 'function'
      ? agent.session.snapshotEvents()
      : []
    let start = 0
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/start') {
        start = index
        break
      }
    }
    for (let index = events.length - 1; index >= start; index -= 1) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const data = event.data as { id?: unknown; source?: { kind?: unknown } } | undefined
      if (data?.source?.kind !== 'user') continue
      if (typeof data.id !== 'string' || data.id === '') continue
      return { turn, userMessageId: data.id }
    }
  } catch {
    /* 读不到日志：只返回 turn */
  }
  return { turn }
}
