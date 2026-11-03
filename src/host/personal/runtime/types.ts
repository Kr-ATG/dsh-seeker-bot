/**
 * Personal Agent 作业运行时 —— 类型契约。
 *
 * ## 为什么要有这一层
 *
 * 改造前，一个 bot 的活就是 `runBotTurn()` 的一次调用：函数在跑就是在执行，
 * Promise 结束就结束了。这带来三个后果，全都是「普通 chat agent」的特征：
 *
 *  - 进程重启 → 正在跑的活静默消失，没人知道它做到哪一步；
 *  - 主 Bot 没法真正给子 Bot 派活（宿主侧没有委派记录，`isMain` 只是前端字段）；
 *  - 长任务卡住没人管，也没有「排队 / 等待 / 续跑」这些中间状态。
 *
 * 这里把「一件活」变成一条持久化记录（`Assignment`）：谁要的、谁干、干到什么
 * 程度、失败为什么、重启后怎么办，全部写在存储里。运行时只做三件事——准入、
 * 派发、结算；真正的执行仍由宿主的 `TurnRunner` 完成。
 *
 * ## 一条铁律
 *
 * **存储是唯一状态，`tick()` 是唯一的派发点，运行时内部不持有任何定时器。**
 * 定时器一旦活在运行时里，进程重启就会丢；而 `tick()` 由宿主按自己的节奏调用，
 * 睡多久都不影响正确性（只是响应快慢）。这条规则是从 OpenMausBot 的
 * `server/runtime/runtime.ts` 学来的，它靠这一条换来了崩溃恢复和可测性。
 */

/** 一件活的来源：人说的、例行任务起的、还是外部事件（webhook / 其他 bot）推来的。 */
export type OriginKind = 'person' | 'routine' | 'outside'

/** 来源的具体通道。`ref` 用来回指原对象（routine id、webhook id 等）。 */
export interface Origin {
  kind: OriginKind
  source: 'chat' | 'routine' | 'webhook' | 'peer' | 'api'
  ref?: string
  /**
   * 人自己的原话，由 harness 截取（最多 400 字），**永远不是模型文本**。
   *
   * 为什么必须由 harness 写：模型若能自己填这段，它就能伪造「用户授权我做 X」。
   * 这是权限判定的证据来源，不能交给被判定的一方。
   */
  quote?: string
}

/** 谁要的活。`bot_turn` 表示是另一个 bot 的某一轮派出来的。 */
export interface Requester {
  kind: 'person' | 'bot_turn' | 'routine_run'
  botId?: string
  /** 结果回到哪个会话；缺省表示回到请求者自己的会话。 */
  threadId?: string
  runId?: string
}

/** 派给哪个 bot。 */
export interface Assignee {
  botId: string
}

/**
 * 派活的意图。
 *
 * - `work`：用你自己的工具去干；
 * - `consult`：只回答，不对外部世界做任何动作；
 * - `notify`：单向通知，不等结果。
 */
export type Mode = 'work' | 'consult' | 'notify'

/** 结果怎么回：唤醒请求者 / 只进收件箱等它自己来读 / 不回。 */
export type Reply = 'resume' | 'poll' | 'none'

/**
 * 一条活的状态。
 *
 * ```
 * queued ──admit──> running ──turn ends──> completed | failed | cancelled
 *                     │  └──交出子活──> waiting ──子活全部结算──> resume ──> running
 *                     └──向人提问──> needs_input ──回答──> running
 * ```
 *
 * `waiting` 和 `resume` 是两个容易被合并、但**不能**合并的状态：`waiting` 是
 * 「等别人」，`resume` 是「别人都回来了，欠自己一轮」。混在一起会导致
 * 「子活结算了但父活没被唤醒」这类丢事件的问题。
 */
export type Status =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'waiting'
  | 'resume'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const TERMINAL_STATUSES: readonly Status[] = ['completed', 'failed', 'cancelled']

export const isTerminal = (status: Status): boolean => TERMINAL_STATUSES.includes(status)

/**
 * 为什么结束。**必须分类**，不能只留一句错误文本——调用方要能据此决定
 * 「重试 / 换人 / 上报 / 直接放弃」，靠字符串匹配做不到这件事。
 */
export type Outcome =
  | 'done'
  | 'needs_input'
  | 'cap_continued'
  | 'stalled'
  | 'interrupted'
  | 'budget'
  | 'provider_error'
  | 'denied'
  | 'expired'
  | 'stopped'
  | 'refused'

/**
 * 权限等级，四档，**有序**：`ask < edits < auto < full`。
 *
 * 现有 Bot 只有 `full` / `approval` 两档，先映射成 `full` / `ask`；中间两档
 * 留给以后接引擎原生能力时用。顺序不能乱——等级传播靠比较大小。
 */
export type Level = 'ask' | 'edits' | 'auto' | 'full'

export const LEVEL_ORDER: readonly Level[] = ['ask', 'edits', 'auto', 'full']

/** 等级从哪条规则来：自己的设置 / 沿 Chief 链继承 / 被目标引擎能力封顶。 */
export type LevelSource = 'own' | 'chief' | 'engine_cap'

/** 宿主观测到的一轮执行痕迹。**不是模型自述**，用来做续跑护栏和「是否已对外动作」判定。 */
export interface TurnEvidence {
  /** 本轮成功的工具调用数。连续两轮为 0 会被判定「没有进展」。 */
  okToolCalls?: number
  /** 本轮的工具报错文本（最多 3 条，各截 200 字），用于识别「连续同样报错」。 */
  errors?: string[]
  /**
   * 本轮完成的**对外动作**短标签（发信、发帖、push、付款…）。
   *
   * 崩溃恢复靠它判断「这一轮要不要重跑」：已经发出去的邮件不能因为重启再发一遍。
   * 必须来自宿主的 activity 记录，不能读模型文本。
   */
  outward?: string[]
  summary?: string
}

/** 一件活。 */
export interface Assignment {
  id: string
  /** 这棵树（一次请求链）的根 id；root 自己指向自己。 */
  rootId: string
  parentId?: string
  /** 离根几层，root 是 0。 */
  depth: number

  origin: Origin
  requester: Requester
  assignee: Assignee

  mode: Mode
  reply: Reply
  /** 请求正文，harness 存（最多 12000 字）。 */
  brief: string
  /** 请求者自己给的完成标准。 */
  doneWhen?: string

  status: Status
  outcome?: Outcome
  outcomeDetail?: string

  level: Level
  levelSource: LevelSource

  /** 为它启动过的轮数（含续跑与重跑）。 */
  executions: number
  /** 被重启切掉后又原地重跑的次数。上限 1——第二次被切直接判死。 */
  restarts: number
  /** 重启后第一轮要读的说明：重跑 / 被切 / 只有子活被切。 */
  restart?: 'rerun' | 'cut' | 'teammates'

  createdAt: number
  startedAt?: number
  /** 最后一次**持久进展**（派发 / 结算 / 子活结算）。预算与停滞窗口都以它为基准。 */
  lastActivityAt: number
  finishedAt?: number

  /** 它最后说了什么，或怎么结束的（最多 12000 字）。 */
  result: string
  evidence?: TurnEvidence
  /** 结果已经送回请求者会话。 */
  reportedAt?: number

  /** 停放中：要问人的原话。 */
  question?: string
  /** 人的回答，harness 引用。 */
  answer?: string
  answeredBy?: { kind: 'bot'; botId: string } | { kind: 'default' }

  /** root 上才有：自上次持久进展以来的预算窗口。 */
  budgets?: Budgets

  /** 续跑：上一轮因步数上限或拿不到执行槽位而停下，下一轮接着干。 */
  continuation?: { note: string; count: number }
  /** 续跑护栏：连续无进展次数 + 最近三条报错。 */
  guard?: { stale: number; errors: string[] }

  /** 记录格式版本，用来拒绝旧版本写的行。 */
  version: 1
}

/** 三份预算，全部挂在 root 上，按「上次持久进展」计数。 */
export interface Budgets {
  since: number
  requests: number
  executions: number
  wakes: number
}

/** 事件类型。每次状态变更都写一条，行可以由事件重建（不变量 I7）。 */
export type EventKind =
  | 'enqueued'
  | 'refused'
  | 'admitted'
  | 'started'
  | 'parked'
  | 'answered'
  | 'waiting'
  | 'resume_due'
  | 'settled'
  | 'reported'
  | 'woken'
  | 'cancelled'
  | 'restart_reconciled'
  | 'budget'
  | 'stalled'
  | 'continued'

export interface AssignmentEvent {
  at: number
  assignmentId: string
  kind: EventKind
  detail?: string
}

/** 派发时传给宿主的输入。宿主据此拼出这一轮的开头。 */
export interface RunInput {
  /** first=首次；resume=子活回来了；rerun=重启重跑；answered=人答了；continued=接着上次。 */
  turn: 'first' | 'resume' | 'rerun' | 'answered' | 'continued'
  resumed: boolean
  /** 重启做了什么，放在第一行（没有就是空串）。 */
  restartNote: string
  /** harness 写的信封开头——不是模型写的，见 `envelope.ts`。 */
  envelope: string
  answer?: string
  /** resume 轮要带上的、已结算的子活。 */
  settled?: Assignment[]
  /** 续跑：为什么继续、上次做到哪。 */
  continuation?: { note: string }
  level: Level
  mode: Mode
}

/** 宿主跑完一轮的回报。四种形状，缺一不可。 */
export type RunResult =
  | { kind: 'completed'; text: string; evidence?: TurnEvidence }
  | { kind: 'failed'; outcome: Exclude<Outcome, 'done' | 'needs_input'>; text: string; evidence?: TurnEvidence }
  | { kind: 'needs_input'; question: string; evidence?: TurnEvidence }
  /** 这一轮没干完（步数上限 / 拿不到槽位），同一个节点接着跑下一轮。 */
  | { kind: 'continue'; text: string; note: string; evidence?: TurnEvidence }

/** 宿主自己跑的一轮（人的消息、例行任务）结束时回报。 */
export interface EndResult {
  ok: boolean
  text: string
  evidence?: TurnEvidence
  needsInput?: { question: string }
  continue?: { note: string }
  stalled?: boolean
}

/**
 * 宿主必须实现的端口。
 *
 * **任何方法都不许把异常抛进运行时**：抛了会被记一条日志并当成「现在不行」，
 * 下一个 tick 再试。运行时不能因为宿主的 bug 而丢状态。
 */
export interface TurnRunner {
  /** 每次派发前重查地址与路由；返回字符串 = 用这个理由拒绝。 */
  validate(a: Assignment, parent?: Assignment): string | undefined
  /** 现在能不能开一轮：true 能；false 静默等；字符串 = 说明一次原因。 */
  canStart(a: Assignment): true | false | string
  /** 跑一轮。signal 用于取消/停止。 */
  run(a: Assignment, input: RunInput, signal: AbortSignal): Promise<RunResult>
  /** 停在人面前：把问题显示出来。restored=重启后的重新停放，只显示没显示过的。 */
  park(a: Assignment, question: string, restored?: boolean): void
  /** 子活结算了，把结果送回请求者会话（或 root 自己结束时报到自己会话）。每次结算只调一次。 */
  report(a: Assignment, parent?: Assignment): void
  /** 行变了，刷新展示。 */
  changed(assignments: readonly Assignment[]): void
  /** 信封要用的显示名；id 是兜底。 */
  names(a: Assignment, parent?: Assignment): { requester: string; assignee: string; person?: string }
  /**
   * 被切掉的那一轮**已经做过的对外动作**短标签。只在 open() 时对「本轮没交出子活」
   * 的 running 节点问一次。缺省 / 空 / 抛错都按「没有」处理。
   */
  outward?(a: Assignment): string[]
}

/** 时钟。停滞窗口必须用单调时钟，否则笔记本睡眠会被当成「卡死」。 */
export interface Clock {
  now(): number
  monotonic(): number
}

export interface Limits {
  /** 离根最多几层。 */
  depth: number
  requests: number
  executions: number
  wakes: number
  /** 排队多久还没启动就过期。 */
  queueMs: number
  /** 整棵树多久没有持久进展就判死。 */
  stallMs: number
  /** 单轮多久没有活动算卡死（单调时钟）。 */
  turnStallMs: number
  /** 等人回话等多久；默认无限——问人就是要等人。 */
  inputWaitMs: number
}

/**
 * 默认值。
 *
 * 和 OpenMausBot 的默认值刻意不同：它的 `turnStallMs` 生产环境设成 24h，因为
 * 它有自己的 host watchdog 兜底；我们暂时没有 watchdog，所以这里取 20 分钟
 * ——比「长任务正常时长」宽松，又不至于让卡死的活挂一整天。
 */
export const DEFAULT_LIMITS: Limits = {
  depth: 4,
  requests: 24,
  executions: 48,
  wakes: 48,
  queueMs: 24 * 60 * 60_000,
  stallMs: 4 * 60 * 60_000,
  turnStallMs: 20 * 60_000,
  inputWaitMs: Number.POSITIVE_INFINITY,
}

/** 入队请求。 */
export interface EnqueueRequest {
  /** 请求者自己正在跑的那条记录；新开一棵树时缺省。 */
  parentId?: string
  origin: Origin
  requester: Requester
  assignee: Assignee
  mode?: Mode
  reply?: Reply
  brief: string
  doneWhen?: string
  /** 请求者自己的等级，以及 Chief 链上的等级（宿主按链算好传进来）。 */
  levels: { own: Level; chief?: Level }
}

export type EnqueueResult =
  | { ok: true; assignment: Assignment; duplicate: boolean }
  | { ok: false; reason: string; outcome: 'refused' | 'budget' | 'duplicate' }

/** 一个 owner 的收件箱条目：请求者只通过它得知子活结果。 */
export interface InboxItem {
  id: string
  ownerBotId: string
  ownerThreadId?: string
  assignmentId: string
  kind: 'settled' | 'needs_input' | 'stalled'
  createdAt: number
  deliveredAt?: number
}
