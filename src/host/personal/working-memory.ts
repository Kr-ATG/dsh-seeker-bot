/**
 * Personal Agent — 工作记忆（任务状态 + 工作日志）。
 *
 * ## 为什么需要它
 *
 * Bot 会话是终身的（`pa-bot-<botId>`），但任务状态（这次外呼拉到 52 个账号、
 * 36 条草稿、top 10 已批）只活在上下文里。宿主 compaction 一发生，Bot 就
 * 「忘了自己在干什么」。长期记忆引擎存的是偏好 / 事实，生命周期与注入策略
 * 都是按「跨会话长期」设计的，不适合存任务态。
 *
 * 工作记忆回答的是「这个 Bot 现在手上有什么活、做到哪一步了」：
 * - 每轮注入（不依赖历史，compaction 也不影响）
 * - 任务完成后沉淀成一条带日期的工作日志（进长期记忆，供回看）
 *
 * ## 存储
 *
 * `~/.dsh/storages/dsh-seeker-bot/personal-agent/working-memory/<botId>.json`
 *
 * 放插件状态目录而不是 `D:\Seeker-Bot`：用户清理产出物时不该把任务态一起删掉。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 任务步骤。 */
export interface WorkingTaskStep {
  label: string
  status: 'todo' | 'doing' | 'done'
}

/**
 * 工作记忆里的「最后写入来源」。
 *
 * 撤回需要精确到「这一轮」，不能再用时间窗口扫整份文件——用户连发三句时，
 * 三句往往落在同一个十分钟窗口里，按时间删会把第三句的任务也一起带走。
 * 这里记下写入它的会话与 turn，撤回时只回收同一轮写入的任务。
 */
export interface WorkingTaskProvenance {
  sessionId?: string
  turn?: number
  /** 最后写入该任务时，该轮里最后一条真人消息 id（steer 插话时按消息精确回收）。 */
  userMessageId?: string
}

/** 一个活跃任务。 */
export interface WorkingTask {
  /** 稳定 id（同一次任务跨轮不变）。 */
  id: string
  title: string
  status: 'active' | 'waiting' | 'done' | 'failed'
  steps: WorkingTaskStep[]
  /** 关键数据（`{ accounts: '52', drafts: '36' }`），注入时原样列出。 */
  facts: Record<string, string>
  /** 产出文件路径（相对 bot 工作区）。 */
  artifacts: string[]
  /** 等用户处理的事（授权、登录、补数据）。 */
  blockers: string[]
  updatedAt: number
  /** done 后保留天数，缺省 7。 */
  ttlDays?: number
  /** 最后写入该任务的会话 / 轮次（用于撤回时按轮回收）。 */
  provenance?: WorkingTaskProvenance
}

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 某个 Bot 的工作记忆文件。 */
export function workingMemoryFile(botId: string): string {
  const safe = String(botId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'main'
  return join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent', 'working-memory', `${safe}.json`)
}

/** 读任务列表；文件不存在 / 坏数据都返回空数组（不阻塞对话）。 */
export async function readWorkingTasks(botId: string): Promise<WorkingTask[]> {
  try {
    const raw = await readFile(workingMemoryFile(botId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is WorkingTask => {
      if (typeof item !== 'object' || item === null) return false
      const record = item as Record<string, unknown>
      return typeof record.id === 'string' && typeof record.title === 'string'
    })
  } catch {
    return []
  }
}

/** 全量写回（调用方负责串行）。 */
export async function writeWorkingTasks(botId: string, tasks: WorkingTask[]): Promise<void> {
  const file = workingMemoryFile(botId)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(tasks, null, 2), 'utf8')
}

/**
 * 已撤回的轮次 / 消息（内存态，进程内有效）。
 *
 * 为什么要记：撤回请求可能和这一轮最后一个 `task_state` 写入并发——purge 删完
 * 之后，模型手里那条迟到的工具调用还可能把任务又写回来。按 sessionId + turn
 * （或更精确的 userMessageId）立墓碑后，后续写入直接丢弃，别的轮次不受影响。
 */
const recalledWorkingTurns = new Set<string>()
const recalledWorkingMessages = new Set<string>()

function recalledWorkingKey(sessionId: string | undefined, turn: number | undefined): string | null {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn <= 0) return null
  return `${sessionId}#${turn}`
}

function recalledWorkingMessageKey(sessionId: string | undefined, userMessageId: string | undefined): string | null {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof userMessageId !== 'string' || userMessageId === '') return null
  return `${sessionId}#${userMessageId}`
}

/** 标记某一轮已撤回（供 `upsertWorkingTask` 拦截迟到写入）。 */
export function markWorkingTurnRecalled(sessionId: string | undefined, turn: number | undefined): void {
  const key = recalledWorkingKey(sessionId, turn)
  if (key !== null) recalledWorkingTurns.add(key)
}

/** 标记某条真人消息已撤回（steer 插话时只挡这一条，不挡同 turn 的后续消息）。 */
export function markWorkingMessageRecalled(sessionId: string | undefined, userMessageId: string | undefined): void {
  const key = recalledWorkingMessageKey(sessionId, userMessageId)
  if (key !== null) recalledWorkingMessages.add(key)
}

/** 某一轮是否已撤回。 */
export function isWorkingTurnRecalled(sessionId: string | undefined, turn: number | undefined): boolean {
  const key = recalledWorkingKey(sessionId, turn)
  return key !== null && recalledWorkingTurns.has(key)
}

/** 某条真人消息是否已撤回。 */
export function isWorkingMessageRecalled(sessionId: string | undefined, userMessageId: string | undefined): boolean {
  const key = recalledWorkingMessageKey(sessionId, userMessageId)
  return key !== null && recalledWorkingMessages.has(key)
}

/** 清掉某会话的撤回墓碑（清空对话后调用：新会话的 turn 号会从 1 重新开始）。 */
export function clearWorkingRecallMarks(sessionId?: string): void {
  if (typeof sessionId !== 'string' || sessionId === '') {
    recalledWorkingTurns.clear()
    recalledWorkingMessages.clear()
    return
  }
  const prefix = `${sessionId}#`
  for (const key of [...recalledWorkingTurns]) {
    if (key.startsWith(prefix)) recalledWorkingTurns.delete(key)
  }
  for (const key of [...recalledWorkingMessages]) {
    if (key.startsWith(prefix)) recalledWorkingMessages.delete(key)
  }
}

/** 撤回一次用户发言时会话侧提供给工作记忆的精确范围。 */
export interface RecalledWorkingScope {
  sessionId: string
  turn: number
  /** 被撤回的那条真人消息 id；有它时按消息精确匹配。 */
  userMessageId?: string
  /** 该轮开始时间（毫秒），用于兼容没有 provenance 的旧任务。 */
  from: number
  /** 该轮结束时间（毫秒），用于兼容没有 provenance 的旧任务。 */
  to: number
}

/**
 * 一条任务是否属于被撤回的那一次用户发言。
 *
 * 新数据优先按 `provenance.userMessageId` 精确匹配：Bot 允许执行中插话，
 * 第 2、3 句可能同 turn，只按 turn 会误删第 3 句的任务。没有消息 id 时退回
 * turn；旧数据没有 provenance 时才退回该轮起止时间。
 */
export function shouldDropWorkingTask(task: WorkingTask, scope: RecalledWorkingScope): boolean {
  const provenance = task.provenance
  if (provenance?.sessionId === scope.sessionId
    && typeof provenance.userMessageId === 'string'
    && scope.userMessageId !== undefined) {
    return provenance.userMessageId === scope.userMessageId
  }
  if (provenance?.sessionId === scope.sessionId && typeof provenance.turn === 'number') {
    return provenance.turn === scope.turn
  }
  if (provenance?.sessionId !== undefined && provenance.sessionId !== scope.sessionId) return false
  return task.updatedAt >= scope.from && task.updatedAt <= scope.to
}

/** 按轮 / 按消息回收工作记忆；返回删掉的任务数。 */
export async function purgeWorkingTasksForTurn(botId: string, scope: RecalledWorkingScope): Promise<number> {
  if (scope.userMessageId !== undefined) markWorkingMessageRecalled(scope.sessionId, scope.userMessageId)
  else markWorkingTurnRecalled(scope.sessionId, scope.turn)
  const tasks = await readWorkingTasks(botId)
  const kept = tasks.filter(task => !shouldDropWorkingTask(task, scope))
  if (kept.length !== tasks.length) await writeWorkingTasks(botId, kept)
  return tasks.length - kept.length
}

/** 插入或更新一个任务（按 id）。 */
export async function upsertWorkingTask(botId: string, task: WorkingTask): Promise<WorkingTask[]> {
  if (isWorkingMessageRecalled(task.provenance?.sessionId, task.provenance?.userMessageId)
    || isWorkingTurnRecalled(task.provenance?.sessionId, task.provenance?.turn)) {
    return readWorkingTasks(botId)
  }
  const tasks = await readWorkingTasks(botId)
  const index = tasks.findIndex(item => item.id === task.id)
  if (index >= 0) tasks[index] = task
  else tasks.push(task)
  await writeWorkingTasks(botId, tasks)
  return tasks
}

/**
 * 构建注入文本：只列 active / waiting 的任务，最多 3 个。
 *
 * 格式刻意紧凑（每个任务 2~3 行），因为它每轮都进上下文。
 * 返回空串表示没有活跃任务，调用方不应注入空块。
 */
export function buildWorkingMemoryBlock(tasks: WorkingTask[], now = Date.now()): string {
  const live = tasks
    .filter(task => !isWorkingMessageRecalled(task.provenance?.sessionId, task.provenance?.userMessageId))
    .filter(task => !isWorkingTurnRecalled(task.provenance?.sessionId, task.provenance?.turn))
    .filter(task => task.status === 'active' || task.status === 'waiting')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
  if (live.length === 0) return ''
  const lines: string[] = ['【工作记忆 · 当前任务】']
  for (const task of live) {
    const steps = task.steps
      .map(step => `${step.status === 'done' ? '✓' : step.status === 'doing' ? '▸' : '·'}${step.label}`)
      .join(' ')
    const facts = Object.entries(task.facts)
      .map(([key, value]) => `${key}=${value}`)
      .join('，')
    const head = `- ${task.title}（${task.status === 'waiting' ? '等你处理' : '进行中'}）`
    const detail = [steps, facts].filter(part => part !== '').join('；')
    lines.push(detail === '' ? head : `${head}：${detail}`)
    if (task.blockers.length > 0) lines.push(`  待办：${task.blockers.join('；')}`)
    if (task.artifacts.length > 0) lines.push(`  产出：${task.artifacts.slice(0, 5).join('、')}`)
  }
  lines.push(`（更新于 ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}；这是任务状态，不是实时数据）`)
  return lines.join('\n')
}

/** 读 + 构建注入文本（每轮 pre-step 调用）。 */
export async function injectWorkingMemory(botId: string, now = Date.now()): Promise<string> {
  const tasks = await readWorkingTasks(botId)
  return buildWorkingMemoryBlock(tasks, now)
}

/** 清理：done / failed 超过 ttlDays 的任务。 */
export async function pruneWorkingTasks(botId: string, now = Date.now()): Promise<WorkingTask[]> {
  const tasks = await readWorkingTasks(botId)
  const kept = tasks.filter(task => {
    if (task.status !== 'done' && task.status !== 'failed') return true
    const ttl = (task.ttlDays ?? 7) * 86_400_000
    return now - task.updatedAt < ttl
  })
  if (kept.length !== tasks.length) await writeWorkingTasks(botId, kept)
  return kept
}

/* ───────────────────── 注入：把工作记忆投给 agent ───────────────────── */

/**
 * 每个会话上次注入的工作记忆指纹。
 *
 * 为什么必须去重：工作记忆每轮都重建（任务状态可能没变），不去重就会在会话
 * 历史里堆十份一模一样的 developer 消息——既费 token，又会让模型以为你在
 * 反复强调同一件事（和 agent.ts 的 `memoryHashBySession` 同一个理由）。
 */
const injectedHash = new Map<string, string>()

/** 深冻结一条要进会话日志的消息（与 agent.ts 的 createDeveloperMessage 同契约）。 */
function freezeDeep(value: any): any {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) freezeDeep(value[key])
  return Object.freeze(value)
}

/**
 * 构造一条 developer 消息：面向模型的上下文，不显示给用户。
 *
 * 为什么不复用 agent.ts 的 `createDeveloperMessage`：它没有导出，而 agent.ts
 * 由另一个 teammate 并行修改，本任务约定不碰它。这里按**逐字相同的结构**
 * 自己构造（id / role / content / source + 深冻结），宿主对消息的不可变要求
 * 是一致的；字段漂移只可能出现在 `source.kind` 上，而它只用于审计。
 */
export function createWorkingMemoryMessage(text: string): any {
  return freezeDeep({
    id: `pa-wm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'developer',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin' },
  })
}

/**
 * 把该 Bot 的工作记忆注入 agent（每轮回复前调用）。
 *
 * 调用点刻意放在 `runBotTurn` **之前**（index.ts 的 /reply、/reply/stream，
 * scheduler.ts 的例行任务 / 主动询问）：`agent.inject()` 写入的是「面向模型的
 * 上下文」，不会唤醒驱动器，会落在下一个被接纳的步骤里——先注入、再 followup
 * 用户消息，模型第一步就能看到任务状态，不依赖历史有没有被压缩。
 *
 * 失败一律吞掉：工作记忆是增强项，它坏了不能连累对话本身。
 *
 * @returns 是否真的注入了一条（false = 没内容 / 内容没变 / agent 不支持 inject）。
 */
export async function injectWorkingMemoryIntoAgent(agent: any, botId: string, now = Date.now()): Promise<boolean> {
  if (agent === null || typeof agent !== 'object' || typeof agent.inject !== 'function') return false
  const text = await injectWorkingMemory(botId, now)
  if (text === '') return false
  const sessionId = String(agent?.session?.id ?? botId)
  const hash = createHash('sha1').update(text).digest('hex')
  if (injectedHash.get(sessionId) === hash) return false
  try {
    agent.inject(createWorkingMemoryMessage(text))
    injectedHash.set(sessionId, hash)
    return true
  } catch {
    /* inject 不可用：这一轮先不带工作记忆 */
    return false
  }
}

/**
 * 清掉某个会话的注入指纹（清空对话 / 重置 Bot 后调用）。
 *
 * 不清的话，重置后的新会话内容相同会被判定成「已注入过」而永远不注入——
 * 表现是「清空对话后 Bot 又不知道自己手上有活了」。
 */
export function resetWorkingMemoryInjection(sessionIdOrBotId: string): void {
  const key = String(sessionIdOrBotId ?? '')
  if (key === '') {
    injectedHash.clear()
    return
  }
  injectedHash.delete(key)
  // 调用方可能传 botId（index.ts 的 /reset 只有 botId），把对应会话一起清掉
  for (const sessionId of [...injectedHash.keys()]) {
    if (sessionId.includes(key)) injectedHash.delete(sessionId)
  }
}

/** 测试用：暴露内部实现。 */
export const workingMemoryTest = {
  workingMemoryFile,
  readWorkingTasks,
  writeWorkingTasks,
  upsertWorkingTask,
  buildWorkingMemoryBlock,
  injectWorkingMemory,
  pruneWorkingTasks,
  injectWorkingMemoryIntoAgent,
  resetWorkingMemoryInjection,
}
