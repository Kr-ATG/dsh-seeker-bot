/**
 * Personal Agent — 「用户 @ 了谁」的清洗与上下文块（纯函数半边）。
 *
 * ## 为什么需要它
 *
 * @ 在群聊里早就是**路由信号**：前端判定谁接话再给谁发请求（见 room-trigger.ts）。
 * 但私聊里用户也会写「@采集 搜一下我的博客」——那时只有主 Bot 在跑一轮，@ 只
 * 是一段普通文本，模型既不知道该派活，也不知道被点名的 bot id 是什么。
 *
 * 这条链路补的就是那一步：前端把 @ 解析成结构化的 mentions 带上来，宿主把它
 * 拼成一段上下文投给 agent，模型据此调 `coordinate_bots` 把活派出去。
 *
 * ## 为什么不直接由前端把消息发给被点名的 Bot
 *
 * 那等于绕过主管：主 Bot 是唯一有 `bot_create` 权限、也是唯一负责验收的角色。
 * 用户点名说的是「这件事交给它」，不是「换一个会话去说同一句话」。所以这里只
 * 提供**意图**（谁被点名），落不落地仍由主管那一轮决定。
 *
 * ## 为什么是纯函数
 *
 * 宿主与离线测试共用同一份措辞。规则一旦写死在路由里，测试就只能靠起一个 web
 * 服务去断言文本，改一行提示词要跑一遍集成——这正是最容易漂移的地方。
 */

/** 用户点名的一个 Bot：id 用于 `coordinate_bots`，name 只用于写给模型看的说明。 */
export interface BotMention {
  id: string
  name: string
}

/**
 * 一次最多认几个点名。
 *
 * 与群聊一致（一次最多编排 3 位成员）：每个被点名的 Bot 都是一次完整推理，
 * 一口气点五个多半是用户在罗列而不是真的要五个都动。多余的静默丢弃——正文里
 * 那段文字还在，模型自己看得见。
 */
const MAX_MENTIONS = 3

/** 名字只用于展示，超长名字是前端数据坏，不是用户意图。 */
const MAX_NAME_CHARS = 40

/** id 来自前端，过长的一律按坏数据处理（真实 bot id 只有十几个字符）。 */
const MAX_ID_CHARS = 80

/**
 * 把前端带来的 mentions 洗成可用的列表。
 *
 * 只做三件事：字段裁剪、按 id 去重、数量封顶。缺 id 或名字的条目直接丢——
 * 没有 id 就派不出去，没有名字写出来的上下文模型也看不懂指的是谁。
 */
export function normalizeMentionList(input: unknown): BotMention[] {
  if (!Array.isArray(input)) return []
  const out: BotMention[] = []
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, MAX_ID_CHARS) : ''
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, MAX_NAME_CHARS) : ''
    if (id === '' || name === '') continue
    if (out.some((mention) => mention.id === id)) continue
    out.push({ id, name })
    if (out.length >= MAX_MENTIONS) break
  }
  return out
}

/**
 * 拼一段「用户点名了谁」的上下文。
 *
 * 措辞有三个刻意的取舍：
 *
 * 1. **点明「不是随口提到」**。上下文会紧挨着用户正文投进去，不写这一句，模型
 *    很容易当成「用户提到了某个名字」而只在正文里应一句。
 * 2. **给 id 而不是只给名字**。`coordinate_bots` 的 `bot_id` 必须是 id，模型
 *    拿名字去猜只能猜错（名字和 id 长得完全不一样），错一次这一轮就废了。
 * 3. **写清「别自己做完再转述」**。这是实测里最常见的跑偏：模型很愿意自己把活
 *    干完，然后回一句「我已经让采集去做了」——活其实没派出去，用户以为派了。
 *
 * 返回空串表示没有可注入的内容，调用方不应注入空块。
 */
export function buildMentionContextBlock(mentions: readonly BotMention[]): string {
  const list = normalizeMentionList(mentions)
  if (list.length === 0) return ''
  const who = list.map((mention) => `${mention.name}（bot id：${mention.id}）`).join('、')
  const names = list.map((mention) => mention.name).join('、')
  return [
    '## 用户这轮点名了谁（不是随口提到）',
    `用户在这条消息里 @ 了：${who}。`,
    `- 这是「让${names}去做」的指令：用 coordinate_bots 把这件事派给它，message 写清「做什么、交付什么」——它看不到你和用户的对话。`,
    '- 派完用一句话回用户（「已经交给采集了，等它回来我转给你」），不要自己把活做完再转述，也不要照着任务再复述一遍。',
    '- 只有两种情况可以自己处理：一句话就能答完；或者它明显做不了这件事（那时说明为什么不派）。',
  ].join('\n')
}
