/**
 * Personal Agent 作业运行时 —— `coordinate_bots` 工具。
 *
 * ## 它解决什么
 *
 * 改造前，主 Bot 和子 Bot 之间**没有任何执行层通路**：`isMain` 只是前端的一个
 * 布尔字段，用来决定 UI 上显示哪些管理入口。模型就算想「让调研 Bot 去查一下」，
 * 也只能回一句「你可以去问问它」——因为它没有能真的把活交出去的工具。
 *
 * 这个工具补上那条通路：一次调用在运行时里落一条 child Assignment，派给目标
 * Bot，然后**立刻返回**。
 *
 * ## 为什么是「立刻返回」而不是等结果
 *
 * 子 Bot 可能跑几分钟，而模型这一轮的时间是有限的。等下去只有两个结果：超时，
 * 或者模型被卡在一个不该它等的地方。正确的分工是——
 *
 *   - 这里只负责**派出去**，返回 assignment id；
 *   - 等和唤醒交给运行时：子活结算时 runtime 把父 Bot 拉回 `resume`，父 Bot 的
 *     下一轮开头会带着子活的结果（`RunInput.settled`）。
 *
 * 也就是说，模型看到的是「已派出」；等子活回来时，它会在**新的一轮**里看到结果。
 *
 * ## 派给谁
 *
 * 目标 Bot 必须已知——宿主侧只缓存见过的 Bot 配置（见 `host.ts` 的说明）。
 * 查不到就明确报错，不要用一个猜出来的默认身份去跑：那会让子 Bot 顶着错误的
 * 角色说话，比直接失败更难排查。
 */

import { knownBots, personalRuntime } from './registry.ts'
import type { Mode, Reply } from './types.ts'

/** 工具名。模型在 PTC 下会以 `tools.coordinate_bots(...)` 的形式调用它。 */
export const COORDINATE_TOOL = 'coordinate_bots'

/** 一次调用最多派几件活（防止模型一轮里扇出几十个 Bot 把宿主打满）。 */
const MAX_FANOUT_PER_CALL = 1

export interface CoordinateArgs {
  bot_id?: unknown
  message?: unknown
  mode?: unknown
  reply?: unknown
  done_when?: unknown
}

export interface CoordinateResult {
  ok: boolean
  assignment_id?: string
  duplicate?: boolean
  error?: string
}

/**
 * 把一次 `coordinate_bots` 调用翻译成一条入队请求。
 *
 * 抽成纯函数是为了能离线测：真正的入队、派发、唤醒都在 runtime 里，这里只负责
 * 「模型给的参数」到「运行时认的请求」这一步映射，以及所有拒绝理由的措辞。
 */
export function coordinate(
  args: CoordinateArgs,
  options: { botId: string; assignmentId: string | undefined },
): CoordinateResult {
  const host = personalRuntime()
  if (host === undefined) {
    return { ok: false, error: '作业运行时没有启动，现在不能派活。' }
  }

  const rawTargetId = typeof args.bot_id === 'string' ? args.bot_id.trim() : ''
  if (rawTargetId === '') return { ok: false, error: 'bot_id 不能为空：要说明派给哪个 Bot。' }

  // 容错匹配：模型可能传了目标 Bot 的名称（如 "GitStar"），而不是 id（如 "bot-4c14ca51"）
  let targetId = rawTargetId
  const bots = knownBots()
  const matchedById = bots.find((b) => b.id === rawTargetId)
  if (!matchedById) {
    const matchedByName = bots.find(
      (b) => b.name.trim().toLowerCase() === rawTargetId.toLowerCase()
    )
    if (matchedByName) {
      targetId = matchedByName.id
    }
  }

  if (targetId === options.botId) {
    return { ok: false, error: '不能把活派给自己；你自己直接做就行。' }
  }

  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (message === '') return { ok: false, error: 'message 不能为空：要写清让那个 Bot 做什么。' }

  const parentId = options.assignmentId
  if (parentId === undefined) {
    /*
     * 没有正在跑的作业记录：说明这一轮不是经运行时发起的（例如运行时启动前
     * 就开始的对话）。直接派会挂不上父节点，子活完成后也没人收结果——所以
     * 宁可拒绝，也不要派出一条没人管的活。
     */
    return { ok: false, error: '这一轮没有挂到作业运行时上，暂时不能派活（重启后应该恢复）。' }
  }

  const mode: Mode = args.mode === 'consult' ? 'consult' : 'work'
  const reply: Reply = args.reply === 'none' ? 'none' : 'resume'
  const doneWhen = typeof args.done_when === 'string' && args.done_when.trim() !== ''
    ? args.done_when.trim()
    : undefined

  /*
   * 等级沿父节点传下去：父 Bot 在这个等级下做的事，它派出去的活也该能做。
   *
   * 读不到父记录时退回 `full`——这是本项目现在的默认档（Bot 默认完全权限），
   * 与 `begin()` 里的映射保持一致。注意**不能**退成 `ask`：那会让派出去的活
   * 每一步都要问人，而人根本看不到子 Bot 的对话。
   */
  const parentLevel = host.get(parentId)?.level ?? 'full'

  const enqueued = host.runtime.enqueue({
    parentId,
    origin: { kind: 'person', source: 'chat' },
    requester: { kind: 'bot_turn', botId: options.botId },
    assignee: { botId: targetId },
    mode,
    reply,
    brief: message,
    ...(doneWhen === undefined ? {} : { doneWhen }),
    levels: { own: parentLevel },
  })

  if (!enqueued.ok) return { ok: false, error: enqueued.reason }
  return {
    ok: true,
    assignment_id: enqueued.assignment.id,
    ...(enqueued.duplicate ? { duplicate: true } : {}),
  }
}

/**
 * 注册到 Bot 的 agent 作用域。
 *
 * 只挂在这个 Bot 自己看得到的地方（和其他 Bot 专属工具一致），Work 会话不受
 * 影响。注册失败不阻塞对话，但必须留痕——否则「模型不会派活」会变成一个查不出
 * 原因的现象。
 */
export function installCoordinateTool(agentCtx: any, botId: string, roster: () => Array<{ id: string; name: string; role: string }>): void {
  const tools = agentCtx?.tools
  if (tools === undefined || typeof tools.register !== 'function') return

  const buildDescription = (): string => {
    const others = roster()
    const lines = [
      '把一件活交给另一个 Bot 去做，然后继续你自己的事。',
      '这个工具**不会等结果**：它立刻返回一个 assignment_id，那个 Bot 完成（或失败）后，你会在**下一轮**收到结果并继续。',
      '什么时候用：这件事明显属于另一个 Bot 的职责（看它的角色），或者你手上同时有几件事要并行推进。',
      '什么时候不用：一句话能答的、你自己两步就能做完的，直接做——派出去反而慢。',
      'message 要写清楚「做什么」和「交付什么」，那个 Bot 看不到你们的对话，只看到你写的这段。',
    ]
    if (others.length === 0) {
      lines.push('当前没有别的 Bot 可以派活。')
    } else {
      lines.push('可派的 Bot：')
      for (const bot of others.slice(0, 12)) lines.push(`· ${bot.id}（${bot.name}）——${bot.role}`)
    }
    return lines.join('\n')
  }

  try {
    tools.register({
      name: COORDINATE_TOOL,
      description: buildDescription(),
      parameters: {
        type: 'object',
        properties: {
          bot_id: { type: 'string', description: '目标 Bot 的 id（见描述里的「可派的 Bot」）' },
          message: { type: 'string', description: '要它做的事：写清做什么、交付什么。它看不到你们的对话。' },
          mode: {
            type: 'string',
            enum: ['work', 'consult'],
            description: 'work=让它真的去做（默认）；consult=只要它回答一个问题，不要动手改任何东西',
          },
          reply: {
            type: 'string',
            enum: ['resume', 'none'],
            description: 'resume=完成时叫醒你并带回结果（默认）；none=单向通知，不要结果',
          },
          done_when: { type: 'string', description: '可选：什么算做完，用来判断它交付得够不够' },
        },
        required: ['bot_id', 'message'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            assignment_id: { type: 'string' },
            duplicate: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        // 契约：第一个参数是 arguments，第二个才是执行结果；必须返回 content 数组
        render: (_args: unknown, value: any) => {
          const text = value?.ok !== true
            ? `派活失败：${String(value?.error ?? '未知原因')}`
            : value?.duplicate === true
              ? '这件活刚才已经派过了，等它回来就行'
              : '已经派出去了，你可以继续做别的'
          return [{ type: 'text', text }]
        },
      },
      async execute(args: any) {
        const host = personalRuntime()
        return coordinate(args as CoordinateArgs, {
          botId,
          assignmentId: host?.assignmentOf(botId),
        })
      },
    })
  } catch (error) {
    console.warn(
      '[personal-agent] 注册 coordinate_bots 失败（Bot 将不能给其他 Bot 派活）:',
      error instanceof Error ? error.message : error,
    )
  }
}

export { MAX_FANOUT_PER_CALL }
