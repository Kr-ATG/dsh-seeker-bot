/**
 * Personal Agent 作业运行时 —— 进程内的接线注册表。
 *
 * ## 为什么单独一个文件
 *
 * `host.ts` 要实现 `TurnRunner`，就得 import `agent.ts` 的 `runBotTurn`；
 * 而 `agent.ts` 要给 Bot 装 `coordinate_bots` 工具，又得拿到运行时的实例和
 * Bot 花名册。两边直接互相 import 就是循环依赖——ESM 下能不能跑取决于求值
 * 顺序，属于「今天能跑、改一行就炸」的那类隐患。
 *
 * 这里放一个**只存引用、不含逻辑**的注册表：`host.ts` 启动时把自己登记进来，
 * `agent.ts` / `coordinate.ts` 从这里读。两边都只依赖这个文件，依赖图变成单向。
 *
 * ## 为什么允许「没有运行时」
 *
 * 运行时启动失败（目录写不进去、状态快照损坏）时，Bot 必须照常能对话——只是
 * 不能派活。所以读取方拿到的可能是 `undefined`，调用方要按「这个能力不可用」
 * 处理，而不是抛异常。
 */

import type { JobRuntime } from './runtime.ts'
import type { Assignment } from './types.ts'

/** 运行时实例和它对外暴露的少量能力。 */
export interface RuntimeHandle {
  runtime: JobRuntime
  /** 当前 Bot 正在跑的那条作业记录（`coordinate_bots` 挂父节点用）。 */
  assignmentOf(botId: string): string | undefined
  /** 把一件活入队；失败时返回带类型的结果而不是抛异常。 */
  enqueue: (request: Parameters<JobRuntime['enqueue']>[0]) => ReturnType<JobRuntime['enqueue']>
  /** 读一条记录（给 UI / 诊断用）。 */
  get: (id: string) => Assignment | undefined
  /**
   * 读全部作业记录（给 UI / 诊断用；只读快照，不会触发运行时推进）。
   *
   * 与 `get` 同源，但给列表页一次拿全量——过滤 / 排序在调用方做，
   * 避免每个界面各写一套查法。
   */
  list: () => readonly Assignment[]
  /**
   * 删掉某个 Bot 的全部作业记录与收件箱（删 Bot 时用）。
   *
   * 可选：老运行时没注册这个方法时调用方按「没有可清的记录」处理。
   * @returns 被删掉的作业记录条数。
   */
  forgetBot?: (botId: string) => number
  /**
   * 记下这一轮已经完成的对外动作。
   *
   * 必须在工具**结算的当下**调用（不是等 turn 结束）：进程中途崩溃时，
   * 这条信息决定重启后是重跑还是判死。
   */
  recordOutward: (id: string, labels: readonly string[]) => void
}

/**
 * 写回一条 Bot 配置所需的字段（`bot_create` 建完要让花名册立刻认识它）。
 *
 * 刻意用结构类型而不是 `import type { BotAgentSpec }`：`agent.ts` 已经从这里读
 * `knownBots`，反向引它的类型会让两个模块在类型层面也互相依赖。形状少写几遍
 * 是值得的，依赖图保持单向更重要。
 */
export interface BotSpecWrite {
  botId: string
  name: string
  role: string
  description: string
  instructions: string
  model?: { provider?: string; model?: string; effort?: string }
  permission?: 'full' | 'approval'
}

let handle: RuntimeHandle | undefined
let rosterProvider: ((excludeBotId?: string) => Array<{ id: string; name: string; role: string }>) | undefined
let specWriter: ((spec: BotSpecWrite) => void) | undefined
let specForgetter: ((botId: string) => boolean) | undefined

export function registerRuntime(next: RuntimeHandle): void {
  handle = next
}

export function unregisterRuntime(): void {
  handle = undefined
}

/** 读运行时；没启动时返回 `undefined`，调用方按「能力不可用」处理。 */
export function personalRuntime(): RuntimeHandle | undefined {
  return handle
}

/** Bot 花名册的来源（`host.ts` 启动时注入，读的是宿主侧缓存）。 */
export function setRosterProvider(
  provider: (excludeBotId?: string) => Array<{ id: string; name: string; role: string }>,
): void {
  rosterProvider = provider
}

/** 当前能被派活的 Bot。没有来源时返回空数组（不是抛错）。 */
export function knownBots(excludeBotId?: string): Array<{ id: string; name: string; role: string }> {
  return rosterProvider?.(excludeBotId) ?? []
}

/**
 * Bot 配置写回通道的来源（`host.ts` 启动时注入，写的是宿主侧配置缓存）。
 *
 * 为什么需要：`bot_create` 刚建出来的 Bot，模型下一句就可能 `coordinate_bots`
 * 派活给它。花名册是**惰性读取**的（每次执行时才查），所以只要建完立刻写回，
 * 派活那一步就能看到它——不写回的话，模型会被告知「没有这个 Bot」，
 * 而用户界面上它明明已经出现了。
 */
export function setBotSpecWriter(writer: (spec: BotSpecWrite) => void): void {
  specWriter = writer
}

/** 把一条 Bot 配置写回花名册；没有写回通道（运行时没起来）时静默跳过。 */
export function rememberBotSpec(spec: BotSpecWrite): void {
  specWriter?.(spec)
}

/**
 * 花名册移除通道的来源（`host.ts` 启动时注入）。
 *
 * 为什么必须能摘：`coordinate_bots` 的可派名单读的就是这份缓存。不摘的话，用户
 * 明明把 Bot 删了，主 Bot 下一轮还会看到它、还能派活给它——派出去才发现会话已经
 * 不在了，或者更糟：会话还在，那个「已删除」的 Bot 真的爬起来干活。
 */
export function setBotSpecForgetter(forgetter: (botId: string) => boolean): void {
  specForgetter = forgetter
}

/** 从花名册里摘掉一个 Bot；返回是否真的摘到了（没有通道时返回 false）。 */
export function forgetBotSpec(botId: string): boolean {
  return specForgetter?.(botId) ?? false
}
