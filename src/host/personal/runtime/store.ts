/**
 * Personal Agent 作业运行时 —— 存储层。
 *
 * ## 为什么用 JSON 而不是 SQLite
 *
 * 第一阶段要的是「形状对不对」，不是「扛不扛得住」。JSON 全量读写在这个规模
 * （一个用户的 bot 作业，通常几十到几百条）完全够，而且和 `scheduler.ts` /
 * `journal.ts` 的现有习惯一致，出问题时可以直接用编辑器打开看。
 *
 * 等 P1 接 `coordinate_bots`、真正出现并发写入和多表事务时，再换 `node:sqlite`
 * ——那时事务才是刚需。**接口先按「事务内写行 + 写事件」设计**，换存储时不用
 * 改调用方。
 *
 * ## 为什么每次都要原子写
 *
 * 作业记录的唯一价值就是「进程挂了之后还能读回来」。直接 `writeFileSync` 覆盖
 * 一个写了一半的文件，等于在最需要它的时候把记录毁了。所以一律写 `.tmp` 再
 * `rename`——rename 在同一文件系统内是原子的，要么旧内容、要么新内容。
 *
 * ## 为什么事件单独一个文件
 *
 * `assignments.json` 是当前快照，`events.ndjson` 是追加式流水。快照坏了可以用
 * 流水重建（不变量 I7），流水本身只追加不改写，损坏面小得多。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  type Assignment,
  type AssignmentEvent,
  type EventKind,
  type InboxItem,
  isTerminal,
  type Status,
} from './types.ts'

/** 磁盘上的格式版本。读到的版本对不上就整份拒读，绝不半读。 */
const SNAPSHOT_VERSION = 1

interface Snapshot {
  version: number
  assignments: Assignment[]
  inbox: InboxItem[]
  /** 收件箱条目的自增序号，用来生成稳定 id。 */
  inboxSeq: number
}

const emptySnapshot = (): Snapshot => ({
  version: SNAPSHOT_VERSION,
  assignments: [],
  inbox: [],
  inboxSeq: 0,
})

export class RuntimeStore {
  private readonly dir: string
  private readonly snapshotFile: string
  private readonly eventsFile: string
  private snapshot: Snapshot

  constructor(dir: string) {
    this.dir = dir
    this.snapshotFile = join(dir, 'assignments.json')
    this.eventsFile = join(dir, 'events.ndjson')
    mkdirSync(dir, { recursive: true })
    this.snapshot = this.read()
  }

  /**
   * 读快照。
   *
   * 任何读不出来的情况都退回空快照并**保留原文件**（改名成 `.broken-<时间戳>`），
   * 而不是删掉重来：用户的作业记录哪怕只有一半，也比没有更有诊断价值。
   */
  private read(): Snapshot {
    if (!existsSync(this.snapshotFile)) return emptySnapshot()
    let raw: string
    try {
      raw = readFileSync(this.snapshotFile, 'utf8')
    } catch {
      return emptySnapshot()
    }
    try {
      const parsed = JSON.parse(raw) as Snapshot
      if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
      if (parsed.version !== SNAPSHOT_VERSION) {
        throw new Error(`snapshot version ${String(parsed.version)} != ${SNAPSHOT_VERSION}`)
      }
      if (!Array.isArray(parsed.assignments) || !Array.isArray(parsed.inbox)) {
        throw new Error('snapshot shape')
      }
      return {
        version: SNAPSHOT_VERSION,
        assignments: parsed.assignments,
        inbox: parsed.inbox,
        inboxSeq: Number.isFinite(parsed.inboxSeq) ? parsed.inboxSeq : parsed.inbox.length,
      }
    } catch {
      /*
       * 损坏 / 版本不符：留档再重来。留档用 rename，失败也不影响后续流程
       * ——这里的目标是「尽量保住证据」，不是「必须保住」。
       */
      try {
        renameSync(this.snapshotFile, `${this.snapshotFile}.broken-${Date.now()}`)
      } catch {
        /* 留档失败就放着，下一次写入会覆盖它 */
      }
      return emptySnapshot()
    }
  }

  /** 原子写：先写临时文件再 rename。 */
  private flush(): void {
    const tmp = `${this.snapshotFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.snapshot, null, 2), 'utf8')
    renameSync(tmp, this.snapshotFile)
  }

  /** 追加一条事件。追加失败不该让整个状态机停摆——事件是审计，不是状态本身。 */
  private appendEvent(event: AssignmentEvent): void {
    try {
      appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      /* 审计丢失不阻塞业务；快照仍是权威 */
    }
  }

  // ── 读 ────────────────────────────────────────────────────────────────

  get(id: string): Assignment | undefined {
    return this.snapshot.assignments.find((a) => a.id === id)
  }

  all(): readonly Assignment[] {
    return this.snapshot.assignments
  }

  /** 某棵树的所有节点。 */
  tree(rootId: string): Assignment[] {
    return this.snapshot.assignments.filter((a) => a.rootId === rootId)
  }

  /** 某个父节点下的直接子活。 */
  children(parentId: string): Assignment[] {
    return this.snapshot.assignments.filter((a) => a.parentId === parentId)
  }

  /** 所有非终态记录。启动恢复和 tick 都从这里出发。 */
  live(): Assignment[] {
    return this.snapshot.assignments.filter((a) => !isTerminal(a.status))
  }

  /** 某个 bot 名下还在跑 / 排队的活（用于「同一会话不并发」）。 */
  liveForBot(botId: string): Assignment[] {
    return this.snapshot.assignments.filter(
      (a) => !isTerminal(a.status) && a.assignee.botId === botId,
    )
  }

  inbox(ownerBotId: string): InboxItem[] {
    return this.snapshot.inbox.filter((item) => item.ownerBotId === ownerBotId)
  }

  // ── 写 ────────────────────────────────────────────────────────────────

  /** 插入一条新记录，同时写 `enqueued` 事件。 */
  insert(assignment: Assignment, at: number): void {
    this.snapshot.assignments.push(assignment)
    this.flush()
    this.appendEvent({ at, assignmentId: assignment.id, kind: 'enqueued' })
  }

  /**
   * 就地更新一条记录，同时写一条事件。
   *
   * `kind` 缺省时按状态推断——绝大多数状态变更都有一条对应事件，逐个手写容易漏，
   * 而不变量 I7（每次状态变化都有事件）正是靠这个兜底保证的。
   *
   * 状态没变（只改了 result / budgets 这类字段）而调用方又没指定事件类型时，
   * **不写事件**：契约要求「每次状态变化都有事件」，反过来，没有状态变化就不该
   * 往审计流里灌噪音。
   */
  update(next: Assignment, at: number, kind?: EventKind, detail?: string): void {
    const index = this.snapshot.assignments.findIndex((a) => a.id === next.id)
    if (index < 0) {
      // 不存在的记录不能凭空 update：那会让状态机和存储分叉
      throw new Error(`assignment not found: ${next.id}`)
    }
    const previous = this.snapshot.assignments[index]!
    this.snapshot.assignments[index] = next
    this.flush()
    const eventKind = kind ?? (previous.status === next.status ? undefined : eventFor(next.status))
    if (eventKind === undefined) return
    this.appendEvent({
      at,
      assignmentId: next.id,
      kind: eventKind,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  /** 只写事件、不改状态（进度、审计类）。 */
  event(assignmentId: string, at: number, kind: EventKind, detail?: string): void {
    this.appendEvent({ at, assignmentId, kind, ...(detail === undefined ? {} : { detail }) })
  }

  /** 往收件箱放一条。返回生成的 id。 */
  pushInbox(item: Omit<InboxItem, 'id' | 'createdAt'>, at: number): string {
    this.snapshot.inboxSeq += 1
    const id = `inbox-${this.snapshot.inboxSeq}`
    this.snapshot.inbox.push({ ...item, id, createdAt: at })
    this.flush()
    return id
  }

  /** 标记收件箱条目已送达。 */
  deliverInbox(id: string, at: number): void {
    const item = this.snapshot.inbox.find((entry) => entry.id === id)
    if (item === undefined) return
    item.deliveredAt = at
    this.flush()
  }

  /** 丢掉某个 owner 的收件箱（它被唤醒后消费掉）。 */
  drainInbox(ownerBotId: string): InboxItem[] {
    const mine = this.snapshot.inbox.filter((item) => item.ownerBotId === ownerBotId)
    if (mine.length === 0) return []
    this.snapshot.inbox = this.snapshot.inbox.filter((item) => item.ownerBotId !== ownerBotId)
    this.flush()
    return mine
  }

  /**
   * 清理终态且已上报的老记录。
   *
   * 不清理会让快照无限增长；但**只清已上报的**——没上报的终态记录还欠一次唤醒，
   * 清掉就等于把结果弄丢了。
   */
  prune(before: number): number {
    const keep: Assignment[] = []
    let removed = 0
    for (const a of this.snapshot.assignments) {
      const stale = isTerminal(a.status) && (a.reportedAt ?? 0) > 0 && (a.finishedAt ?? 0) < before
      if (stale) removed += 1
      else keep.push(a)
    }
    if (removed > 0) {
      this.snapshot.assignments = keep
      this.flush()
    }
    return removed
  }
}

/**
 * 状态转移 → 事件类型的缺省映射。
 *
 * 只覆盖**状态变了**的情况；调用方传了明确事件类型时以它为准（比如结算时区分
 * `settled` 与 `stalled`）。
 */
function eventFor(next: Status): EventKind {
  if (next === 'running') return 'started'
  if (next === 'needs_input') return 'parked'
  if (next === 'waiting') return 'waiting'
  if (next === 'resume') return 'resume_due'
  if (next === 'queued') return 'continued'
  if (next === 'cancelled') return 'cancelled'
  // completed / failed 都算结算
  return 'settled'
}
