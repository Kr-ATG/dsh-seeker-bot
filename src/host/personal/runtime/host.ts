/**
 * Personal Agent 作业运行时 —— 宿主接线层。
 *
 * ## 这一层补的是什么
 *
 * `runtime.ts` 只管状态机，它不碰模型、不碰会话、不碰 UI——那是 `TurnRunner`
 * 的事。本文件就是那个实现：把「派给某个 Bot 的一件活」翻译成一次真实的
 * `runBotTurn`，再把结果送回请求者的对话流。
 *
 * ## 为什么 Bot 配置要从缓存里找
 *
 * 改造前，Bot 的全部配置（名字、角色、指令、模型、权限）都由**前端每次请求
 * 带上**（`/reply` 的 `body.bot`），宿主侧不存。派活时宿主得自己知道「子 Bot
 * 是谁」，所以这里维护一份见过即缓存的配置表。
 *
 * 代价：从没跟用户聊过、也没被派过活的 Bot 查不到配置。这不是最终形态——
 * 后续要让前端在 Bot 增删改时同步全量花名册（`POST /bots`），那时这张表就有
 * 权威来源了。当前实现先在能跑通的前提下把边界说清楚：**查不到就明确报错，
 * 不要用一个瞎猜的默认配置去跑**（那会让子 Bot 以错误的身份说话）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { type BotAgentSpec, runBotTurn, botSessionId } from '../agent.ts'
import { publish } from '../events.ts'
import { outwardLabelsOf } from './outward.ts'
import { personalRuntime, registerRuntime, setBotSpecForgetter, setBotSpecWriter, setRosterProvider } from './registry.ts'
import { JobRuntime } from './runtime.ts'
import { RuntimeStore } from './store.ts'
import type {
  Assignment,
  RunInput,
  RunResult,
  TurnEvidence,
  TurnRunner,
} from './types.ts'

/** 运行时状态目录：和 memory / routines 一样落在插件 storages 下。 */
function runtimeDir(): string {
  return join(homedir(), '.dsh', 'storages', 'dsh-seeker-bot', 'personal-agent', 'runtime')
}

function specCacheFile(): string {
  return join(runtimeDir(), 'bot-specs.json')
}

/**
 * 见过的 Bot 配置。
 *
 * 只存派活需要的字段（身份 + 模型 + 权限），不存 memories——那些每轮由前端
 * 带上来，缓存旧值反而会让子 Bot 用上过期的记忆。
 */
class BotSpecCache {
  private readonly file: string
  private specs = new Map<string, BotAgentSpec>()

  constructor() {
    this.file = specCacheFile()
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, BotAgentSpec>
      for (const [id, spec] of Object.entries(parsed)) {
        if (spec !== null && typeof spec === 'object' && typeof spec.botId === 'string') {
          this.specs.set(id, spec)
        }
      }
    } catch {
      /* 缓存坏了就当空的：它只是加速，不是权威数据 */
    }
  }

  private flush(): void {
    try {
      mkdirSync(runtimeDir(), { recursive: true })
      const record: Record<string, BotAgentSpec> = {}
      for (const [id, spec] of this.specs) record[id] = spec
      writeFileSync(this.file, JSON.stringify(record, null, 2), 'utf8')
    } catch {
      /* 写不进去不影响本轮；下次 /reply 还会再写一次 */
    }
  }

  /** 记下一个 Bot 的配置（`/reply` 每轮都会调，天然保持新鲜）。 */
  remember(spec: BotAgentSpec): void {
    const previous = this.specs.get(spec.botId)
    // 只在身份字段变化时才落盘，避免每轮都写一次文件
    if (
      previous !== undefined &&
      previous.name === spec.name &&
      previous.role === spec.role &&
      previous.instructions === spec.instructions &&
      previous.model?.model === spec.model?.model &&
      // isMain 变了要重写：它决定这个 Bot 的下一轮会不会挂上 bot_create
      previous.isMain === spec.isMain
    ) {
      return
    }
    this.specs.set(spec.botId, { ...spec, memories: undefined })
    this.flush()
  }

  get(botId: string): BotAgentSpec | undefined {
    return this.specs.get(botId)
  }

  /**
   * 摘掉一个 Bot（删除 Bot 时调用）。
   *
   * 必须落盘：不落的话下次进程启动又会从 `bot-specs.json` 读回来，删掉的 Bot
   * 重新出现在可派名单里——用户会看到「删了还能派活」。
   */
  forget(botId: string): boolean {
    if (!this.specs.delete(botId)) return false
    this.flush()
    return true
  }

  /** 给 `coordinate_bots` 的描述用：让模型知道能派给谁。 */
  roster(excludeBotId?: string): Array<{ id: string; name: string; role: string }> {
    const list: Array<{ id: string; name: string; role: string }> = []
    for (const [id, spec] of this.specs) {
      if (id === excludeBotId) continue
      list.push({ id, name: spec.name, role: spec.role })
    }
    return list
  }
}

const specCache = new BotSpecCache()

/** `/reply` 每轮调用：保持子 Bot 配置新鲜。 */
export function rememberBotSpec(spec: BotAgentSpec): void {
  specCache.remember(spec)
}

/** 当前有哪些 Bot 可以被派活。 */
export function knownBots(excludeBotId?: string): Array<{ id: string; name: string; role: string }> {
  return specCache.roster(excludeBotId)
}

/**
 * 从花名册缓存里摘掉一个 Bot（删除 Bot 时调用）。
 *
 * 与 `rememberBotSpec` 对称：一个负责「建完立刻能派活」，一个负责「删完立刻不能」。
 * 两者都走 `runtime/registry.ts` 暴露给 `bot-delete.ts`，避免它直接 import 本文件
 * （本文件已经 import 了 `agent.ts`，反向依赖会成环）。
 */
export function forgetBotSpecFromCache(botId: string): boolean {
  return specCache.forget(botId)
}

/**
 * 宿主侧实现。
 *
 * 它是 `TurnRunner` 的唯一实现：状态机问它「能不能开始」「跑一轮」「把结果
 * 送回去」，它把这些问题翻译成 `runBotTurn` + 事件总线。
 */
class PersonalTurnRunner implements TurnRunner {
  private readonly ctx: any
  /** 正在跑的 turn 属于哪条 assignment：`coordinate_bots` 靠它找到「我现在是谁」。 */
  private readonly currentAssignment = new Map<string, string>()

  constructor(ctx: any) {
    this.ctx = ctx
  }

  validate(): string | undefined {
    // P1 阶段没有路由校验（P3 接权限与工作区校验时补）
    return undefined
  }

  canStart(a: Assignment): true | false {
    // 同一个 Bot 同时只跑一轮：真正的并发上限在 runtime 的 busyBots 里，
    // 这里再挡一层是因为会话本身不是并发安全的。
    return !this.currentAssignment.has(a.assignee.botId)
  }

  async run(a: Assignment, input: RunInput, signal: AbortSignal): Promise<RunResult> {
    const spec = specCache.get(a.assignee.botId)
    if (spec === undefined) {
      return {
        kind: 'failed',
        outcome: 'provider_error',
        text: `不知道该 Bot（${a.assignee.botId}）的配置，无法派活。请先让它在对话里出现一次，或等前端同步花名册。`,
      }
    }

    this.currentAssignment.set(a.assignee.botId, a.id)
    try {
      /*
       * 派活的开头用 runtime 拼好的信封（`input.envelope`），不是裸的 brief：
       * 信封里带着等级、来源、完成标准这些模型无法自证的事实。
       */
      const turn = await runBotTurn(
        this.ctx,
        { ...spec, background: true },
        input.envelope,
        (event) => {
          // 子 Bot 的工作过程照常推给它自己的对话流，用户能看到它在干活
          publish(a.assignee.botId, { type: 'turn-event', event } as any)
          /*
           * 对外动作**在工具结算的当下**就落盘，不等这一轮结束。
           *
           * 理由是崩溃：进程可能在 turn 中途挂掉，而重启恢复要靠「做过没有」
           * 来决定重跑还是判死。等 turn 结束再写，恰恰在需要它的那一刻是空的。
           *
           * 只认 `ok` 的工具：失败或进行中的调用没有产生外部影响。
           */
          if (event.type === 'tool' && event.run?.status === 'ok') {
            const labels = outwardLabelsOf(String(event.run.name ?? ''), event.run.args)
            if (labels.length > 0) {
              personalRuntime()?.recordOutward(a.id, labels)
            }
          }
        },
        signal,
      )

      const evidence: TurnEvidence = {
        okToolCalls: turn.blocks.filter((block) => block.type === 'tool').length,
      }
      if (!turn.ok) {
        return {
          kind: 'failed',
          outcome: 'provider_error',
          text: turn.error ?? '子 Bot 这一轮失败了',
          evidence,
        }
      }
      return { kind: 'completed', text: lastTextOf(turn), evidence }
    } finally {
      this.currentAssignment.delete(a.assignee.botId)
    }
  }

  park(a: Assignment, question: string): void {
    // 子 Bot 卡在问题上：把问题推到它自己的对话流，用户可以在那里回
    publish(a.assignee.botId, {
      type: 'message',
      botId: a.assignee.botId,
      message: {
        id: `q-${a.id}`,
        kind: 'need-input',
        blocks: [{ type: 'text', text: question }],
        at: Date.now(),
      },
      source: 'coordinate',
    } as any)
  }

  report(a: Assignment, parent?: Assignment): void {
    /*
     * 结果要送到**请求者**的对话流里，否则用户只会看到子 Bot 干完了、
     * 却不知道父 Bot 有没有收到。
     *
     * 真正喂给父 Bot 下一轮的是 `RunInput.settled`（runtime 自己带），
     * 这里发的是一条给人看的消息。
     */
    const target = a.requester.botId ?? parent?.assignee.botId
    if (target === undefined) return
    const label = a.status === 'completed' ? '完成' : a.status === 'failed' ? '失败' : '结束'
    const head = `子 Bot 那边的活${label}（${a.assignee.botId}）：`
    publish(target, {
      type: 'message',
      botId: target,
      message: {
        id: `r-${a.id}`,
        kind: a.status === 'failed' ? 'progress' : 'finding',
        blocks: [{ type: 'text', text: `${head}${clipText(a.result, 300)}` }],
        at: Date.now(),
      },
      source: 'coordinate',
    } as any)
  }

  changed(): void {
    /* P1 阶段 UI 还没订阅 assignment 变化；接右栏任务卡时在这里推 */
  }

  names(a: Assignment, parent?: Assignment): { requester: string; assignee: string; person?: string } {
    const assignee = specCache.get(a.assignee.botId)?.name ?? a.assignee.botId
    const requester =
      (a.requester.botId === undefined ? undefined : specCache.get(a.requester.botId)?.name) ??
      (parent === undefined ? '用户' : specCache.get(parent.assignee.botId)?.name ?? '上级 Bot')
    return { requester, assignee }
  }

  /**
   * 这一轮**已经做过的对外动作**。
   *
   * 读的是记录上落盘的 `evidence.outward`（在工具结算时写入），所以进程重启后
   * 仍然读得到。返回空数组 = 不知道 / 没做过——按 runtime 的约定，不知道就允许
   * 重跑一次。
   */
  outward(a: Assignment): string[] {
    return a.evidence?.outward ?? []
  }

  /** `coordinate_bots` 用：当前 Bot 正在跑的那条 assignment。 */
  assignmentOf(botId: string): string | undefined {
    return this.currentAssignment.get(botId)
  }
}

function lastTextOf(turn: { blocks: Array<Record<string, unknown>> }): string {
  for (let i = turn.blocks.length - 1; i >= 0; i -= 1) {
    const block = turn.blocks[i]!
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      return block.text
    }
  }
  return '（这一轮没有输出文字）'
}

function clipText(value: string, max: number): string {
  const text = value.trim()
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 一个宿主只初始化一次。 */
let singleton: { runtime: JobRuntime; runner: PersonalTurnRunner; timer: ReturnType<typeof setInterval> } | undefined

/**
 * 初始化作业运行时并开始 tick。
 *
 * **tick 由宿主驱动**：运行时自己不带定时器（那会在进程重启时丢）。这里的
 * 节奏是「有活在跑就快、空闲就慢」——快的时候 250ms 保证派发及时，慢的时候
 * 2s 足够发现新活又不空转。
 */
export function startPersonalRuntime(ctx: any): { runtime: JobRuntime; runner: PersonalTurnRunner } | undefined {
  if (singleton !== undefined) return singleton

  try {
    const store = new RuntimeStore(runtimeDir())
    const runner = new PersonalTurnRunner(ctx)
    const runtime = new JobRuntime(store, runner, {
      log: (line) => console.warn('[personal-agent:runtime]', line),
    })
    // 启动恢复必须在第一次 tick 之前
    runtime.open()

    const timer = setInterval(() => {
      try {
        runtime.tick()
      } catch (error: any) {
        console.warn('[personal-agent:runtime] tick 失败:', String(error?.message ?? error))
      }
    }, 250)
    // 不阻止进程退出
    timer.unref?.()

    singleton = { runtime, runner, timer }
    /*
     * 登记到注册表，让 `agent.ts` / `coordinate.ts` 能拿到运行时。
     * 走注册表而不是直接 import 本文件，是为了不让 `agent.ts` 与本文件互相
     * import（循环依赖在 ESM 下是「今天能跑、改一行就炸」的隐患）。
     */
    registerRuntime({
      runtime,
      assignmentOf: (botId) => runner.assignmentOf(botId),
      enqueue: (request) => runtime.enqueue(request),
      get: (id) => store.get(id),
      list: () => store.all(),
      forgetBot: (botId) => store.forgetBot(botId),
      recordOutward: (id, labels) => runtime.recordOutward(id, labels),
    })
    setRosterProvider((excludeBotId) => specCache.roster(excludeBotId))
    /*
     * 反向通道：`bot_create` 建完要能把新 Bot 写回花名册。
     *
     * 走注册表而不是让 `bot-create.ts` 直接 import 本文件，理由同 roster——
     * 本文件已经 import 了 `agent.ts`，再被 `bot-create.ts` 反向依赖就成环。
     */
    setBotSpecWriter((spec) => rememberBotSpec(spec))
    setBotSpecForgetter((botId) => forgetBotSpecFromCache(botId))
    return singleton
  } catch (error: any) {
    // 运行时起不来不该让整个插件挂掉：Bot 照常能对话，只是不能派活
    console.warn('[personal-agent] 作业运行时启动失败（Bot 将不能派活）:', String(error?.message ?? error))
    return undefined
  }
}

export { specCache as __specCacheForTest }
