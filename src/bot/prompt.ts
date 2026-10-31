/**
 * dsh-seeker-bot — Bot 岗位注入（host 半身）。
 *
 * 在 system-prompt/assemble waterfall 的**出口**（await next() 之后）追加一段
 * 「# 你的身份」：名字、岗位、instructions、记忆与外部写操作边界。再按
 * bot.output.charts / pages 追加图表与可交互页面偏好（见 IMPLEMENTATION §2.10）。
 *
 * 约束：
 *   - sessionId 从 context.agent.session.id 读取；取不到就静默放行；
 *   - 本模块自身的任何异常都不得抛穿 —— 出口 hook 抛错会毁掉用户真实那一轮请求；
 *   - 不引任何 @deepseek-ai/* 运行时依赖（host 产物必须自包含）。
 */

import { botForSession, type BotRecord } from './state.js'

/** 一段系统提示词（官方组装产物的最小形状）。 */
export interface PromptSectionLike {
  name?: unknown
  text?: unknown
}

export interface PromptAssemblyLike {
  sections?: readonly PromptSectionLike[]
  [key: string]: unknown
}

/** 从组装上下文读 sessionId（取不到返回空串，不抛）。 */
export function sessionIdOf(context: unknown): string {
  try {
    const ctx = context as Record<string, any> | null | undefined
    const agent = ctx?.agent
    const fromAgent = agent?.session?.id ?? agent?.sessionId
    if (typeof fromAgent === 'string' && fromAgent !== '') return fromAgent
    const direct = ctx?.sessionId ?? ctx?.session?.id
    return typeof direct === 'string' ? direct : ''
  } catch {
    return ''
  }
}

/** 身份段正文。 */
export function renderBotIdentitySection(bot: BotRecord): string {
  const lines = ['# 你的身份', '', '你是「' + bot.name + '」，岗位：' + bot.role]
  const instructions = typeof bot.instructions === 'string' ? bot.instructions.trim() : ''
  if (instructions !== '') {
    lines.push('', instructions)
  }
  lines.push('', '记忆不是事实源：关键决策要回源核对。', '未经批准不要执行外部写操作（发送、购买、删除、发布）。')
  return lines.join('\n')
}

/**
 * 产出偏好段。charts / pages 分别开关；都关时返回空串（不追加任何字）。
 * 图表走本插件已有的 ```iu 原生卡片（gauge / table / timeline / checklist），
 * 可交互页面走 ```html 沙箱卡片 —— 两条通道都有现成渲染器，模型不需要学新协议。
 */
export function renderOutputPreference(output: BotRecord['output']): string {
  const charts = output?.charts === true
  const pages = output?.pages === true
  if (!charts && !pages) return ''
  const lines = ['数据类回答优先用图表或可交互页面表达：']
  if (charts) lines.push('- 出现 ≥3 个可比较数字 / 时间序列 / 占比 → 出图表')
  if (pages) lines.push('- 需要筛选、切换、下钻 → 出可交互页面')
  lines.push('图表用 ```iu 围栏（kind 取 gauge / table / timeline / checklist 等已有卡片），不要输出裸 JSON 代码块；')
  lines.push('可交互页面用 ```html 围栏（沙箱内可点、可算、可筛选），不要贴整站或依赖外链。')
  if (charts) lines.push('示例：```iu\n{"kind":"gauge","title":"本周目标","gauges":[{"label":"完成率","value":72,"min":0,"max":100}]}\n```')
  if (pages) lines.push('示例：```html\n<button onclick="this.textContent=Number(this.textContent||0)+1">0</button>\n```')
  return lines.join('\n')
}

/** 该 Bot 需要追加的全部段（身份 + 产出偏好）。 */
export function buildBotPromptSections(bot: BotRecord): Array<{ name: string; text: string }> {
  const sections: Array<{ name: string; text: string }> = [
    { name: 'seeker-bot:identity', text: renderBotIdentitySection(bot) },
  ]
  const output = renderOutputPreference(bot.output)
  if (output !== '') sections.push({ name: 'seeker-bot:output', text: output })
  return sections
}

/** 纯函数：把 Bot 的身份段追加到一次组装产物之后（不修改入参）。 */
export function appendBotPromptSections<T extends PromptAssemblyLike>(assembly: T, bot: BotRecord): T {
  const current = Array.isArray(assembly?.sections) ? assembly.sections : []
  return { ...assembly, sections: [...current, ...buildBotPromptSections(bot)] } as T
}

/**
 * 装配岗位注入。在 host 的 apply 同步路径上调用一次即可。
 * 没有 ctx.on（裸组合 / 测试桩）时静默跳过。
 */
export function applyBotPrompt(ctx: any): void {
  try {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') return
    ctx.on('system-prompt/assemble', async (assembly: any, context: any, next: any) => {
      // next() 本身的失败是官方链路的失败，原样传播（不吞掉别人的错误）。
      const result = typeof next === 'function' ? await next() : assembly
      try {
        const sessionId = sessionIdOf(context)
        if (sessionId === '') return result
        const bot = botForSession(sessionId)
        if (bot === null) return result
        return appendBotPromptSections(result ?? {}, bot)
      } catch {
        // 注入失败绝不影响真实请求：原样返回 upstream 结果。
        return result
      }
    })
  } catch {
    // 装配失败（例如 ctx.on 不可用）不阻塞插件其余能力。
  }
}
