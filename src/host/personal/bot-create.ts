/**
 * Personal Agent — 子 Bot 的创建通道（`bot_create` 工具）。
 *
 * ## 它解决什么
 *
 * 改造前，子 Bot 只有一条来路：用户自己在侧栏点「+ 新建 Bot」，走前端的
 * `store.createBot()`。主 Bot 就算听懂了「帮我建一个专门盯竞品的助手」，
 * 也只能回一句「你去点右上角的加号」——它手上没有任何创建能力。
 *
 * 这个文件补上那条通路：主 Bot 在对话里调用 `bot_create`，宿主落一条 Bot 记录、
 * 推一条事件，前端把它变成侧栏里一个真的可以点开的 Bot。
 *
 * ## 为什么 Bot 记录落在宿主，而不是前端直接收
 *
 * Bot 的全部配置一直由前端持有（`pa:state:v1` 这个 localStorage 快照），宿主
 * 侧只有一份「见过即缓存」的派活花名册。要凭空造一个 Bot，**权威数据必须先在
 * 宿主落地**，理由有两个：
 *
 *  1. 模型这一轮结束时就可能 `coordinate_bots` 派活给刚建出来的 Bot。花名册
 *     是宿主侧的（见 `runtime/registry.ts`），记录不先落宿主，这一步必然报
 *     「没有这个 Bot」。
 *  2. 创建动作发生在**对话里**，而页面可能根本没开（比如例行任务触发）。只靠
 *     一条 SSE 事件，用户没打开页面时就丢了；落盘 + 启动时拉取才补得回来。
 *
 * 所以数据流是三段：宿主落盘 → SSE 推给已打开的页面 → 前端合并进 localStorage。
 * 前端是**显示层**，宿主是**权威层**，两边按 `id` 去重。
 *
 * ## 为什么只有主 Bot 能建
 *
 * 子 Bot 之间互相创建会变成一条不受控的链：A 建 B、B 建 C，用户根本不知道
 * 侧栏为什么会越来越长。职责上，「要不要多一个分身」是全局决策，属于主 Bot
 * （以及它背后的人）。工具是**按 Bot 挂载**的，非主 Bot 连这个工具都看不到，
 * 比挂上再报错更干净——模型不会因为「有个工具但它不让我用」而反复试探。
 *
 * ## 失败要能被模型读懂
 *
 * 所有拒绝理由都是**给模型看的中文句子**，不是错误码：模型拿到
 * `{ ok: false, error }` 后要能自己修正（换个名字、补个岗位）再试一次。
 * 抛异常会让它看到一段栈，除了重试什么也做不了。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { publish } from './events.ts'
import { rememberBotSpec } from './runtime/registry.ts'

/** 工具名。PTC 下模型以 `tools.bot_create(...)` 的形式调用。 */
export const BOT_CREATE_TOOL = 'bot_create'

/**
 * 一条由宿主创建出来的 Bot 记录。
 *
 * 只带**身份字段**，不带外观 / 模型 / 主动问候这些展示与运行期配置：那些由前端
 * 在合并时按它自己的默认值补齐（`randomBotAppearance()` / `MODEL_FALLBACK` 等）。
 * 宿主不该知道前端长什么样，否则改一次配色就要动宿主。
 *
 * 字段与 `events.ts` 里 `bot-created` 事件的 `bot` 逐字对齐——两处漂移会让前端
 * 收到一条读不出名字的 Bot。
 */
export interface CreatedBotRecord {
  id: string
  name: string
  role: string
  description: string
  instructions: string
  /** 落到哪个分组；缺省由前端塞进默认分组。 */
  groupId?: string
  createdAt: number
  /** 创建者的 botId（正常是主 Bot）。 */
  createdBy: string
}

/** 记录上限。到顶后丢最旧的：这是「宿主建过什么」的账本，不是 Bot 列表本身。 */
const MAX_RECORDS = 500

/** 各字段的长度上限（按**字符**数，中文与 emoji 都算一个）。 */
const LIMITS = {
  name: 24,
  role: 80,
  description: 200,
  instructions: 4000,
  groupId: 64,
} as const

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 账本文件路径。与工作记忆、运行时快照同属插件状态目录。 */
export function createdBotsFile(): string {
  return join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent', 'created-bots.json')
}

/**
 * 账本的内存副本。
 *
 * 为什么同步读写 + 内存缓存：`bot_create` 可能在同一轮里被调用两次，而路由
 * （`GET /bots/created`）随时可能并发进来。异步读改写在这个体量下没有收益，
 * 只会引入「后写的覆盖先写的」这种偶发丢记录。文件很小（几百条上限），
 * 同步 IO 的代价可以忽略。
 */
let cache: CreatedBotRecord[] | undefined

function isRecord(value: unknown): value is CreatedBotRecord {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.role === 'string'
    && typeof item.createdAt === 'number'
  )
}

/** 读账本。文件不存在 / 坏数据都返回空数组（不阻塞创建）。 */
export function readCreatedBots(): CreatedBotRecord[] {
  if (cache !== undefined) return cache
  try {
    const file = createdBotsFile()
    if (!existsSync(file)) {
      cache = []
      return cache
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    cache = Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    /* 账本坏了当空的：它只影响「启动时补建漏掉的 Bot」，不该让创建本身失败 */
    cache = []
  }
  return cache
}

function flush(records: CreatedBotRecord[]): void {
  const file = createdBotsFile()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(records, null, 2), 'utf8')
}

/** 追加一条并落盘。落盘失败时抛错——调用方要据此告诉模型「没建成」。 */
export function appendCreatedBot(record: CreatedBotRecord): void {
  const records = [...readCreatedBots(), record].slice(-MAX_RECORDS)
  flush(records)
  cache = records
}

/**
 * 从账本里抹掉一条。
 *
 * 为什么必须有：账本是给前端**补发**用的。用户在界面上删掉一个子 Bot 之后，
 * 如果账本还留着它，下次页面加载 `/bots/created` 就会把它重新加回来——表现为
 * 「删不掉的 Bot」。所以前端删除 Bot 时要顺手调一次 `DELETE /bots/created`。
 *
 * 删不到（id 不存在 / 落盘失败）都返回 `false` 而不是抛错：这是一条清理动作，
 * 失败最坏也只是那条记录多留一轮，不该让前端的删除流程跟着报错。
 */
export function removeCreatedBot(botId: string): boolean {
  const id = String(botId ?? '').trim()
  if (id === '') return false
  const records = readCreatedBots()
  const next = records.filter((item) => item.id !== id)
  if (next.length === records.length) return false
  try {
    flush(next)
    cache = next
    return true
  } catch {
    return false
  }
}

/** 测试用：丢掉内存缓存，强制下次重新读盘。 */
export function __resetCreatedBotsCache(): void {
  cache = undefined
}

/** 按字符数计长度（`'🐱'.length` 是 2，但用户眼里它是一个字）。 */
function charLength(text: string): number {
  return Array.from(text).length
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把模型给的参数收敛成一条待落盘的记录。
 *
 * 抽成纯函数（不碰磁盘、不碰事件总线）是为了能离线测：真正的写入与广播都在
 * {@link createBot} 里，这里只负责「模型说了什么」到「一条合法记录」的映射，
 * 以及**所有拒绝理由的措辞**——那些措辞是模型唯一的纠错线索，值得单独测。
 */
export type BotCreatePlan =
  | { ok: true; record: CreatedBotRecord }
  | { ok: false; error: string }

export interface BotCreateArgs {
  name?: unknown
  role?: unknown
  description?: unknown
  instructions?: unknown
  group_id?: unknown
}

export interface BotCreateOptions {
  /** 发起创建的 botId。 */
  createdBy: string
  /** 当前已有的记录（重名检查用）。 */
  existing?: readonly CreatedBotRecord[]
  /** 注入时间戳，便于测试。 */
  now?: number
  /** 注入 id，便于测试；缺省随机生成。 */
  id?: string
}

export function planBotCreate(args: BotCreateArgs, options: BotCreateOptions): BotCreatePlan {
  const name = trimmed(args?.name)
  if (name === '') {
    return { ok: false, error: 'name 不能为空：给这个 Bot 起个名字，2-12 个字最好（例如「调研助手」）。' }
  }
  if (charLength(name) > LIMITS.name) {
    return { ok: false, error: `name 太长了（最多 ${LIMITS.name} 个字）：名字要能在侧栏一行里显示完。` }
  }

  const role = trimmed(args?.role)
  if (role === '') {
    return {
      ok: false,
      error: 'role 不能为空：写清它的岗位（例如「竞品调研」）。这个名字决定派活时模型怎么判断该交给它。',
    }
  }
  if (charLength(role) > LIMITS.role) {
    return { ok: false, error: `role 太长了（最多 ${LIMITS.role} 个字）：一句话说清岗位就够。` }
  }

  const description = trimmed(args?.description)
  if (charLength(description) > LIMITS.description) {
    return { ok: false, error: `description 太长了（最多 ${LIMITS.description} 个字）。` }
  }

  const instructions = trimmed(args?.instructions)
  if (charLength(instructions) > LIMITS.instructions) {
    return { ok: false, error: `instructions 太长了（最多 ${LIMITS.instructions} 个字）。` }
  }

  const groupId = trimmed(args?.group_id)
  if (charLength(groupId) > LIMITS.groupId) {
    return { ok: false, error: `group_id 太长了（最多 ${LIMITS.groupId} 个字符）。` }
  }

  /*
   * 重名直接拒绝，不自动加序号。
   *
   * 自动改名会让用户看到两个「调研助手」，而模型以为自己只建了一个——之后
   * 派活、汇报都会指向一个含糊的目标。让模型自己换个名字，是更便宜的纠错。
   */
  const duplicated = (options.existing ?? []).some((item) => item.name === name)
  if (duplicated) {
    return {
      ok: false,
      error: `已经有一个叫「${name}」的 Bot 了。换个名字；如果就是它，直接用 coordinate_bots 派活即可，不用新建。`,
    }
  }

  const record: CreatedBotRecord = {
    id: options.id ?? nextBotId(options.existing ?? []),
    name,
    role,
    description,
    // 没给指令就按「名字 + 岗位 + 简介」拼一段最小身份提示，和前端 createBot 的兜底一致
    instructions: instructions !== ''
      ? instructions
      : `你是「${name}」，${role}。${description !== '' ? `${description} ` : ''}说话直接、具体，先给结论再解释。`,
    ...(groupId !== '' ? { groupId } : {}),
    createdAt: options.now ?? Date.now(),
    createdBy: options.createdBy,
  }
  return { ok: true, record }
}

/** 生成一个不与现有记录冲突的 botId（`bot-` + 8 位十六进制）。 */
function nextBotId(existing: readonly CreatedBotRecord[]): string {
  const taken = new Set(existing.map((item) => item.id))
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `bot-${randomUUID().replace(/-/g, '').slice(0, 8)}`
    if (!taken.has(id)) return id
  }
  // 8 位空间撞 8 次基本不可能；真撞了就用全量 uuid，宁可长一点也不能重 id
  return `bot-${randomUUID().replace(/-/g, '')}`
}

/** `bot_create` 的执行结果（也是工具的输出 schema）。 */
export interface BotCreateResult {
  ok: boolean
  bot_id?: string
  name?: string
  error?: string
}

/**
 * 真正执行一次创建：校验 → 落盘 → 写回花名册 → 广播事件。
 *
 * 顺序是有意的：
 *  1. **先落盘**，失败就整件事失败（不能出现「前端看到了、重启后没了」）；
 *  2. 再写回花名册，让**这一轮**后续的 `coordinate_bots` 就能派给它；
 *  3. 最后广播。广播是尽力而为——没有打开的页面时它本来就送不到，靠启动拉取兜底。
 */
export function createBot(args: BotCreateArgs, options: BotCreateOptions): BotCreateResult {
  const existing = readCreatedBots()
  const plan = planBotCreate(args, { ...options, existing })
  if (!plan.ok) return { ok: false, error: plan.error }

  try {
    appendCreatedBot(plan.record)
  } catch (error) {
    return {
      ok: false,
      error: `Bot 记录没能落盘（${error instanceof Error ? error.message : String(error)}），这次创建没有生效，不要告诉用户已经建好了。`,
    }
  }

  rememberBotSpec({
    botId: plan.record.id,
    name: plan.record.name,
    role: plan.record.role,
    description: plan.record.description,
    instructions: plan.record.instructions,
  })

  try {
    publish(options.createdBy, { type: 'bot-created', bot: plan.record, source: 'agent' })
  } catch {
    /* 广播失败不影响创建本身：前端下次打开会从 /bots/created 拉到 */
  }

  return { ok: true, bot_id: plan.record.id, name: plan.record.name }
}

/**
 * 把 `bot_create` 注册进 bot 自己的 agent 作用域（只有主 Bot 挂）。
 *
 * 注册失败不阻塞对话，但必须留痕：静默失败的表现是「模型说它建好了，侧栏什么
 * 都没有」，那种现象查起来毫无线索。
 */
export function installBotCreateTool(agentCtx: any, botId: string): void {
  const tools = agentCtx?.tools
  if (tools === undefined || typeof tools.register !== 'function') return

  try {
    tools.register({
      name: BOT_CREATE_TOOL,
      description: [
        '新建一个长期存在的子 Bot（会出现在用户侧栏里，用户可以点开单独跟它对话）。',
        '',
        '什么时候用：用户明确要求「新建一个专门做某事的助手 / 子 Bot」，而且这件事是**长期分工**——以后还会反复找它。',
        '什么时候不用：',
        '· 一次性的活（自己做完，或用 coordinate_bots 派给已有的 Bot 更快）；',
        '· 只是想换个做法 / 换个口吻（那是调整你自己，不是建新 Bot）；',
        '· 已经有职责相同的 Bot 了（直接派给它，别造重复的）。',
        '',
        '建之前先确认两件事，缺哪件就用 bot_emit(kind=need-input) 问清楚，别自己编：',
        '  1. 它负责什么（role）；',
        '  2. 叫什么名字（name，用户没想法时按岗位起一个）。',
        '',
        '一次只建一个。建完用一两句话告诉用户「建好了、叫什么、可以直接点开聊」，不要把它能做什么吹成一长串。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '名字，2-12 个字最好（如「调研助手」）。同名已存在会被拒绝。' },
          role: { type: 'string', description: '岗位，一句话（如「竞品调研」）。派活时靠它判断该不该交给这个 Bot。' },
          description: { type: 'string', description: '可选：它具体做什么、怎么跟用户配合。' },
          instructions: {
            type: 'string',
            description: '可选：它的身份提示词。不填就按「名字 + 岗位 + 简介」自动生成一段，多数情况不用填。',
          },
          group_id: { type: 'string', description: '可选：放进哪个分组。不填就由界面放进默认分组。' },
        },
        required: ['name', 'role'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            bot_id: { type: 'string' },
            name: { type: 'string' },
            error: { type: 'string' },
          },
        },
        // 契约：第一个参数是 arguments，第二个才是执行结果；必须返回 content 数组
        render: (_args: unknown, value: any) => {
          const text = value?.ok !== true
            ? `创建失败：${String(value?.error ?? '未知原因')}`
            : `已创建子 Bot「${String(value?.name ?? '')}」（${String(value?.bot_id ?? '')}）`
          return [{ type: 'text', text }]
        },
      },
      async execute(args: any) {
        return createBot(args as BotCreateArgs, { createdBy: botId })
      },
    })
  } catch (error) {
    console.warn(
      '[personal-agent] 注册 bot_create 失败（主 Bot 将不能创建子 Bot）:',
      error instanceof Error ? error.message : error,
    )
  }
}
