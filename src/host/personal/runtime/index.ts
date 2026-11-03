/**
 * Personal Agent 作业运行时 —— 模块出口。
 *
 * 接入方式（P0 阶段先不接，等形状确认）：
 *
 * ```ts
 * const store = new RuntimeStore(join(dataDir(), 'runtime'))
 * const runtime = new JobRuntime(store, runner)
 * runtime.open()                       // 启动恢复，必须在第一次 tick 之前
 * setInterval(() => runtime.tick(), …) // 宿主驱动，节奏自定
 * ```
 *
 * `runner` 由宿主实现 `TurnRunner`（见 `types.ts`），真正的执行仍走
 * `agent.followup` / `runBotTurn`。运行时自己不做任何模型调用。
 */

export * from './types.ts'
export { RuntimeStore } from './store.ts'
export { JobRuntime, assignmentLevel, type BeginRequest, type RuntimeOptions } from './runtime.ts'
