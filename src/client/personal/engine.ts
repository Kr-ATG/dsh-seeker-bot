/**
 * Personal Agent — 本地对话引擎。
 *
 * 职责：
 *  1. 在没有 host LLM 时也能让每个 bot「真的回复」，并产出可交互卡片；
 *  2. 统一生成新建 Bot 的首条主动消息、主动询问消息；
 *  3. 生成期刊日记（标题、日期、正文、引文、配图 prompt）与程序化封面。
 *
 * 真正的模型回复由 host `/api/personal-agent/reply` 提供；调用失败时回退到这里。
 */
import {
  journalDateKey,
  journalDateLabel,
  journalIssue,
  type JournalFeed,
  type JournalFeedMessage,
  type JournalFeedStats,
  type JournalHighlight,
  type JournalSection,
  type JournalStat,
} from '../../shared/journal.ts'
import {
  formatClock,
  shortId,
  type AppState,
  type Bot,
  type InteractiveUi,
  type Journal,
  type Message,
  type MessageBlock,
  type MemoryEntry,
  type Routine,
} from './types'

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

function hash(text: string): number {
  let value = 0
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) | 0
  return Math.abs(value)
}

function botFlavor(bot: Bot): string {
  const name = bot.name.replace(/助手$/, '')
  if (bot.isMain) return '我'
  return name
}

/** 生成对新消息的回复块。 */
export function generateReply(bot: Bot, text: string, state: AppState): MessageBlock[] {
  const q = text.toLowerCase()
  const has = (...words: string[]): boolean => words.some((word) => q.includes(word))
  const memory = state.memories.filter((item) => item.botId === bot.id)
  const memoryLine = memory[0]?.text ? `我记得你之前说过：「${memory[0].text.slice(0, 42)}…」` : ''

  if (has('提醒', '闹钟', '别忘了')) {
    return [
      { type: 'text', text: '可以。你定个时间，我到点就提醒你；需要的话也可以直接变成例行任务。' },
      {
        type: 'interactive',
        prompt: '想让我什么时候提醒你？',
        ui: {
          kind: 'form',
          title: '新建提醒',
          submitLabel: '保存提醒',
          fields: [
            { id: 'title', label: '提醒内容', type: 'text', placeholder: '例如：周三前回复供应商', required: true },
            { id: 'time', label: '提醒时间', type: 'time', required: true },
            { id: 'repeat', label: '重复', type: 'select', options: ['不重复', '每天', '每周一'], required: false },
          ],
        },
      },
    ]
  }

  if (has('例行', '定时', '每天', '每周', '周期')) {
    return [
      { type: 'text', text: '这类事情适合设成例行任务。我会按你给的时间自动跑，并把结果放回这条会话。' },
      {
        type: 'interactive',
        prompt: '确认一下执行频率：',
        ui: {
          kind: 'options',
          title: '选择频率',
          options: [
            { id: 'daily-9', label: '每天 09:00', description: '适合日报 / 晨间汇总' },
            { id: 'hourly', label: '每 2 小时', description: '适合巡检与监控' },
            { id: 'weekly', label: '每周一 10:00', description: '适合周报' },
          ],
        },
      },
    ]
  }

  if (has('记住', '记忆', '别忘')) {
    return [
      { type: 'text', text: '我记下了。要把它固定为长期记忆吗？以后每次对话都会带上。' },
      {
        type: 'interactive',
        prompt: `「${text.slice(0, 40)}」`,
        ui: {
          kind: 'buttons',
          options: [
            { id: 'save-memory', label: '存进记忆' },
            { id: 'just-chat', label: '只当这次说说' },
          ],
        },
      },
    ]
  }

  if (has('计划', '安排', '今天', '待办')) {
    return [
      {
        type: 'text',
        text:
          `今日安排（${botFlavor(bot)}视角）：\n\n1. 先处理最紧的一条：PR 巡检结果\n2. 下午 14:00 前把调研截图归档\n3. 晚上 17:30 汇总各线进展\n\n` +
          (memoryLine || '有变化我会在这条会话里随时更新。'),
      },
      {
        type: 'task',
        title: '今日执行清单',
        status: '进行中',
        steps: [
          { text: '整理 PR 巡检结果', done: true },
          { text: '归档调研截图', done: false },
          { text: '生成今日期刊', done: false },
        ],
      },
    ]
  }

  if (has('日报', '汇总', '总结', '进展')) {
    return [
      {
        type: 'text',
        text:
          '目前三条线都有进展：\n\n· PR #1：Java 段完成，前端依赖待确认\n· 邮件：周末 23 封已压成 3 条待办\n· 调研：两张截图已进共享目录\n\n下一步我会跟进 PR 的 CI 结果，并把它写进今晚的期刊。',
      },
      {
        type: 'task',
        title: '进展汇总',
        status: '3 条线 · 1 条待确认',
        steps: [
          { text: 'PR #1 · Java 段完成', done: true },
          { text: '邮件 · 23 封压成 3 条待办', done: true },
          { text: '调研 · 截图归档', done: true },
          { text: 'PR #1 · CI 结果待回填', done: false },
        ],
      },
    ]
  }

  if (has('你好', '早上好', '在吗', 'hi', 'hello')) {
    return [
      {
        type: 'text',
        text: `早。${bot.isMain ? '我这边一切正常，子助手们都在线。' : `${bot.role}这边随时可以开工。`}你想先处理哪一件？`,
      },
      {
        type: 'interactive',
        prompt: '可以从这些开始：',
        ui: {
          kind: 'buttons',
          options: [
            { id: 'brief', label: '看今天的简报' },
            { id: 'task', label: '给我派个任务' },
            { id: 'chat', label: '随便聊聊' },
          ],
        },
      },
    ]
  }

  if (has('呼叫', '打电话', '通话')) {
    return [{ type: 'text', text: '可以，右上角那个电话图标就是呼叫按钮。接通以后我们说话，转写和时长都会记在这条会话里。' }]
  }

  // 默认：角色化回复，带一点具体感
  const seeds = [
    `收到。我按「${bot.role}」的方式来处理：先确认目标，再拆成可以马上动手的几步。`,
    `这件事我可以接。给我一点时间把资料对齐，完成后把结果和下一步一起放进会话。`,
    `明白。我先做一版可验证的结果出来，不先铺大方案；有卡点会在群里说。`,
    `好。我会把它记进这条线，稍后把进展回填给你。`,
  ]
  const blocks: MessageBlock[] = [{ type: 'text', text: pick(seeds) }]
  if (Math.random() > 0.55) {
    blocks.push({
      type: 'task',
      title: bot.isMain ? '分派与跟进' : `${bot.role} · 处理中`,
      status: '进行中',
      steps: [
        { text: '确认需求与边界', done: true },
        { text: '执行并留下可核对的结果', done: false },
        { text: '回报结果与下一步', done: false },
      ],
    })
  }
  return blocks
}

/** 新建 Bot 的首条主动消息：自我介绍 + 立刻给可选项。 */
export function firstBotMessage(bot: Bot): MessageBlock[] {
  return [
    {
      type: 'text',
      text:
        `我是「${bot.name}」，${bot.role}。${bot.description ? bot.description : '接下来由我负责这条线。'}\n\n` +
        '在我开始之前，想先确认一下：你希望我优先做什么？',
    },
    {
      type: 'interactive',
      prompt: '选一个起点，或者直接告诉我你的想法：',
      ui: {
        kind: 'options',
        title: '开始方式',
        options: [
          { id: 'brief', label: '先给我一个任务', description: '你描述目标，我来拆步骤' },
          { id: 'learn', label: '先了解我的工作方式', description: '我会说明边界与回报节奏' },
          { id: 'setup', label: '一起定一条例行任务', description: '把重复的事自动化' },
        ],
      },
    },
  ]
}

/** 主动询问：每个 bot 都有，带随机可选项。 */
export function proactiveMessage(bot: Bot): MessageBlock[] {
  const prompts = bot.isMain
    ? [
        '现在有空吗？我想把今天的安排跟你过一遍。',
        '子助手们都汇报完了，有一件事需要你拍板。',
        '今天想让我先盯哪条线？',
      ]
    : [
        `我这边有一件跟「${bot.role}」相关的事，想先问问你。`,
        '刚看到一个值得你注意的变化，要现在说吗？',
        '有个小决定需要你拍板，很快。',
      ]
  return [
    { type: 'text', text: pick(prompts) },
    {
      type: 'interactive',
      prompt: '要现在处理吗？',
      ui: {
        kind: 'buttons',
        options: [
          { id: 'now', label: '现在说' },
          { id: 'later', label: '晚点再说' },
          ...(bot.isMain ? [{ id: 'assign', label: '直接派给子助手' }] : []),
        ],
      },
    },
  ]
}

/** 交互卡提交后的后续回复。 */
export function followUpForAnswer(bot: Bot, label: string): MessageBlock[] {
  return [
    {
      type: 'text',
      text:
        `好，按「${label}」来。我已经把它记到这条会话里了；接下来我会按这个方向推进，` +
        '有结果第一时间回你。',
    },
  ]
}

/** 通话中的一句回应（短、口语化）。 */
export function callReply(bot: Bot, text: string): string {
  const q = text.toLowerCase()
  if (q.includes('听得到') || q.includes('在吗')) return '听得到，我在。你说。'
  if (q.includes('多久') || q.includes('时间')) return '我这边随时可以，按你的节奏来。'
  if (q.includes('计划') || q.includes('安排')) return '我建议先处理 PR 的 CI，再归档截图；剩下的我可以并行。'
  if (q.includes('谢谢') || q.includes('辛苦')) return '不客气，应该的。'
  return pick([
    '好，我记下了。还有别的要一起说吗？',
    '明白，我这就去办，结果回头发你。',
    '可以。我先把最关键的一步做掉，再回来跟你确认。',
  ])
}

/* ───────────────────────────── 期刊 ───────────────────────────── */

/**
 * 同步给宿主的单条素材文本上限。
 *
 * 与 `src/shared/journal.ts` 的 `formatJournalFeedForPrompt` 口径一致：那里也按
 * 600 字裁每条消息，两边不一致会让「前端算的统计」和「模型看到的素材」对不上。
 */
const JOURNAL_FEED_MESSAGE_LIMIT = 600

/** 一次最多同步多少条素材：够覆盖两天对话，又不至于把请求体撑爆。 */
const JOURNAL_FEED_MAX_MESSAGES = 200

/** 当天素材的投影（`journalFeedFromState` 的返回值）。 */
export interface JournalFeedSnapshot {
  messages: JournalFeedMessage[]
  stats: JournalFeedStats
  /** 当天最后一条用户消息的时间（没有就是 0）。 */
  lastUserMessageAt: number
}

/** 把一条消息的 blocks 拍成纯文本：只取正文，期刊卡 / 工具卡 / 交互卡都不是对话素材。 */
function messageText(blocks: readonly MessageBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type !== 'text') continue
    const text = block.text.trim()
    if (text !== '') parts.push(text)
  }
  return parts.join('\n').trim()
}

/** 一条 bot 消息的发送者名：群聊优先用 senderName，其次按 senderId / botId 查 Bot。 */
function botNameOf(state: AppState, ownerBotId: string, message: Message): string {
  if (message.senderName !== undefined && message.senderName !== '') return message.senderName
  const id = message.senderId ?? message.botId
  const found = state.bots.find((bot) => bot.id === id)
  if (found !== undefined) return found.name
  // 找不到发言者时退回期刊主人：总比在正文里写「Bot」强
  const owner = state.bots.find((bot) => bot.id === ownerBotId)
  return owner?.name ?? 'Bot'
}

/**
 * 把时间窗口内的真实消息投影成宿主可消费的素材。
 *
 * 只收**定稿**的 user / bot 消息：pending 占位里是半句话，拿它当素材会让期刊
 * 引用到一句还没说完的话。按时间升序输出，超过上限时保留最近的。
 */
function collectFeedMessages(
  state: AppState,
  ownerBotId: string,
  from: number,
  to: number,
  limit = JOURNAL_FEED_MAX_MESSAGES,
): JournalFeedMessage[] {
  const messages: JournalFeedMessage[] = []
  for (const message of state.messages) {
    if (message.at < from || message.at >= to) continue
    if (message.role !== 'user' && message.role !== 'bot') continue
    if (message.pending === true) continue
    const text = messageText(message.blocks)
    if (text === '') continue
    const botId = message.role === 'bot' ? (message.senderId ?? message.botId) : message.botId
    messages.push({
      id: message.id,
      botId,
      ...(message.role === 'bot' ? { botName: botNameOf(state, ownerBotId, message) } : {}),
      role: message.role,
      at: message.at,
      text: text.length > JOURNAL_FEED_MESSAGE_LIMIT ? text.slice(0, JOURNAL_FEED_MESSAGE_LIMIT) : text,
    })
  }
  messages.sort((a, b) => a.at - b.at)
  return messages.length > limit ? messages.slice(messages.length - limit) : messages
}

/** 时间窗口内的统计（前端算好传给宿主，避免宿主再猜）。 */
function feedStatsOf(state: AppState, from: number, to: number): JournalFeedStats {
  let messages = 0
  let userMessages = 0
  let botMessages = 0
  const bots = new Set<string>()
  for (const message of state.messages) {
    if (message.at < from || message.at >= to) continue
    if (message.pending === true) continue
    // 与素材投影同口径：没有正文的消息（期刊卡 / 纯工具卡）不算「对话消息」
    if (messageText(message.blocks) === '') continue
    if (message.role === 'user') {
      messages += 1
      userMessages += 1
      continue
    }
    if (message.role !== 'bot') continue
    messages += 1
    botMessages += 1
    bots.add(message.senderId ?? message.botId)
  }
  return {
    messages,
    userMessages,
    botMessages,
    activeBots: bots.size,
    memories: state.memories.filter((entry) => entry.createdAt >= from && entry.createdAt < to && entry.text.trim() !== '').length,
    routines: state.routines.filter((routine) => routine.enabled).length,
  }
}

/**
 * 取**指定日期当天**（本地时区 0:00–24:00）的素材投影。
 *
 * 消息覆盖当天**所有 Bot** 的对话（不只 `botId` 那一个）：期刊是「这一天发生了什么」
 * 的合订本，只取主 Bot 的消息会漏掉子助手整天的进展。`botId` 只用于标识期刊归属，
 * 以及在找不到发言者时兜底显示名字。
 */
export function journalFeedFromState(state: AppState, botId: string, date: Date): JournalFeedSnapshot {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const to = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
  const messages = collectFeedMessages(state, botId, from, to)
  const lastUserMessageAt = messages.reduce(
    (max, message) => (message.role === 'user' ? Math.max(max, message.at) : max),
    0,
  )
  return { messages, stats: feedStatsOf(state, from, to), lastUserMessageAt }
}

/**
 * 给宿主调度器同步的素材包：**最近 48 小时**的全部消息。
 *
 * 为什么是 48 小时而不是「今天」：宿主会在第二天凌晨为「昨天」生成期刊，那时前端
 * 可能还没产生今天的消息；只同步当天会让昨天后半段的素材永远传不上去。统计按
 * 「昨天」算（昨天没有消息时退回今天），宿主生成时再按日期过滤消息。
 */
export function journalFeedForSync(state: AppState, botId: string, now: Date = new Date()): JournalFeed {
  const nowMs = now.getTime()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  const messages = collectFeedMessages(state, botId, nowMs - 48 * 3600_000, nowMs + 1)
  const yesterdayStats = feedStatsOf(state, yesterdayStart, todayStart)
  const stats = yesterdayStats.messages > 0 ? yesterdayStats : feedStatsOf(state, todayStart, nowMs + 1)
  return { messages, stats, lastUserMessageAt: state.lastUserMessageAt, syncedAt: nowMs }
}

/** 话题词里不单独出现的虚字（含这些字的 n-gram 直接丢弃）。 */
const TOPIC_STOP_CHARS = new Set('的了吗呢吧啊呀哦嗯是我你他她它们这那哪个些么什怎把被让'.split(''))

/** 高频套话 / 功能词：出现频率很高，但作为期刊标题毫无信息量。 */
const TOPIC_STOP_WORDS = new Set([
  '今天', '昨天', '明天', '现在', '刚才', '最近', '目前', '之后', '之前', '时候', '时间',
  '一个', '一下', '一些', '一点', '这些', '那些', '这个', '那个', '这样', '那样', '这里', '那里',
  '什么', '怎么', '为什么', '怎么样', '可以', '可能', '应该', '需要', '必须', '已经', '还是',
  '就是', '只是', '不过', '而且', '或者', '因为', '所以', '但是', '如果', '虽然', '然后', '其实',
  '当然', '真的', '非常', '比较', '特别', '一直', '总是', '经常', '偶尔', '立刻', '马上', '我们',
  '你们', '他们', '她们', '它们', '自己', '大家', '东西', '事情', '问题', '情况', '地方', '方式',
  '方法', '方面', '开始', '结束', '进行', '出现', '发生', '知道', '觉得', '认为', '希望', '想要',
  '谢谢', '好的', '收到', '明白', '没问题', '帮我', '帮忙', '麻烦', '请问', '告诉', '看看', '试试',
  '说说', '聊聊', '要不', '是不是', '有没有', '能不能', '会不会', '可不可以', '对不对', '好不好',
  '行不行', '第一', '第二', '第三', '最后', '另外', '此外', '同时', '以及', '关于', '对于', '通过',
  '根据', '按照', '由于', '为了', '除了', '包括', '等等', '左右', '上下', '前后', '里面', '外面',
  '上面', '下面', '前面', '后面', '中间', '之间', '哪里', '哪个', '哪些', '多少', '几个', '一次',
  '两次', '一天', '一周', '一个月', '一年',
])

/** 英文里没有信息量的高频词。 */
const TOPIC_STOP_WORDS_EN = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'not', 'you', 'are',
  'was', 'were', 'but', 'can', 'all', 'any', 'how', 'why', 'what', 'when', 'where', 'which',
  'who', 'use', 'using', 'get', 'got', 'make', 'just', 'also', 'into', 'than', 'then', 'they',
  'them', 'their', 'there', 'here', 'about', 'after', 'before', 'more', 'most', 'some', 'such',
  'only', 'over', 'under', 'again', 'very', 'too', 'own', 'out', 'off', 'on', 'in', 'of', 'to',
  'is', 'it', 'as', 'at', 'by', 'or', 'be', 'do', 'does', 'did', 'has', 'had', 'if', 'no', 'so',
  'up', 'we', 'he', 'she', 'his', 'her', 'its', 'our', 'your', 'my', 'me', 'us', 'ok', 'yes',
  'hello', 'hi',
])

/**
 * 从真实对话里抽当天的高频话题词。
 *
 * 没有分词库，这里用「2–4 字 n-gram + 频次」的轻量做法：出现 ≥2 次的片段才算候选，
 * 含虚字的片段直接丢；同频次时优先长词（「插件项目」比「插件」更具体），再按包含
 * 关系去重。抽不出来就返回空数组——标题会如实退成「今天说了 N 句话」，不硬编话题。
 */
function extractTopics(texts: readonly string[], limit = 3): string[] {
  const counts = new Map<string, number>()
  const add = (word: string): void => {
    if (word.length < 2 || word.length > 8) return
    if (TOPIC_STOP_WORDS.has(word) || TOPIC_STOP_WORDS_EN.has(word)) return
    for (const char of word) if (TOPIC_STOP_CHARS.has(char)) return
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  for (const raw of texts) {
    for (const word of raw.match(/[A-Za-z][A-Za-z0-9+#._-]{1,}/g) ?? []) add(word.toLowerCase())
    for (const segment of raw.match(/[\u4e00-\u9fa5]+/g) ?? []) {
      for (let size = 2; size <= 4; size += 1) {
        for (let index = 0; index + size <= segment.length; index += 1) add(segment.slice(index, index + size))
      }
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
  const picked: string[] = []
  for (const [word] of ranked) {
    if (picked.length >= limit) break
    if (picked.some((existing) => existing.includes(word) || word.includes(existing))) continue
    picked.push(word)
  }
  return picked
}

/** 压平空白并截断（超出补省略号）。 */
function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 从当天素材里挑几条有代表性的消息（用户优先、长文本、不同 Bot，最多 5 条）。 */
function buildHighlights(messages: readonly JournalFeedMessage[], limit = 5): JournalHighlight[] {
  const candidates = messages
    .filter((message) => message.text.trim() !== '')
    .map((message) => {
      const length = message.text.trim().length
      const roleScore = message.role === 'user' ? 100 : 0
      const lengthScore = Math.min(length, 120)
      return { message, score: roleScore + lengthScore + (length > 40 ? 20 : 0) }
    })
    .sort((a, b) => b.score - a.score)
  const highlights: JournalHighlight[] = []
  const perSender = new Map<string, number>()
  const seen = new Set<string>()
  for (const item of candidates) {
    if (highlights.length >= limit) break
    const message = item.message
    const text = message.text.trim()
    if (seen.has(text)) continue
    const sender = message.role === 'user' ? '你' : (message.botName ?? 'Bot')
    // 同一个发送者最多占两条：时间线要像「当天速览」，不是同一个人刷屏
    const used = perSender.get(sender) ?? 0
    if (used >= 2) continue
    perSender.set(sender, used + 1)
    seen.add(text)
    highlights.push({
      time: formatClock(message.at),
      title: truncateText(text, 24),
      botName: sender,
    })
  }
  // 时间线按当天时间顺序排，读起来才像「一天」
  return highlights.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''))
}

/**
 * 生成一篇期刊日记（**本地回退版**）。
 *
 * 宿主模型可用时由 `/api/personal-agent/journal/generate` 生成真正的编辑稿；这个函数
 * 只在宿主不可用（或独立演示页）时兜底。旧版是随机套话数组，看起来精致但跟真实对话
 * 无关；现在全部从当天的真实素材里取：标题用高频话题词、摘要引用真实统计、章节里
 * 直接引用用户原话与 Bot 回复，没有素材就如实写「今天没有新的对话」。
 *
 * 返回的 `origin` 恒为 `'local'`，界面据此标注「本地回退」。
 */
export function buildJournal(
  state: AppState,
  botId: string,
  opts?: { auto?: boolean; date?: Date; image?: string },
): Journal {
  const date = opts?.date ?? new Date()
  const feed = journalFeedFromState(state, botId, date)
  const { stats } = feed
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()

  const userMessages = feed.messages.filter((message) => message.role === 'user')
  const botMessages = feed.messages.filter((message) => message.role === 'bot')
  const botCounts = new Map<string, number>()
  for (const message of botMessages) {
    const name = message.botName ?? 'Bot'
    botCounts.set(name, (botCounts.get(name) ?? 0) + 1)
  }
  const topics = extractTopics(userMessages.map((message) => message.text))
  const total = stats.messages

  const title = total === 0
    ? '安静的一天'
    : topics.length >= 2
      ? `关于${topics[0]}与${topics[1]}的一天`
      : topics.length === 1
        ? `围绕「${topics[0]}」的一天`
        : `今天说了 ${String(total)} 句话`

  const topicPhrase = topics.length > 0 ? `，话题集中在 ${topics.slice(0, 3).join('、')}` : ''
  const partner = stats.activeBots > 0 ? `${String(stats.activeBots)} 个助手` : ''
  const conversationSummary = total > 0
    ? (partner === ''
      ? `今天你自己留下了 ${String(total)} 条消息${topicPhrase}。`
      : `今天你和 ${partner}聊了 ${String(total)} 条消息（你 ${String(stats.userMessages)} 条、助手 ${String(stats.botMessages)} 条）${topicPhrase}。`)
    : ''
  const summary = total > 0
    ? `${conversationSummary}新增记忆 ${String(stats.memories)} 条，${String(stats.routines)} 条例行任务在后台保持运转。`
    : `这一天没有新的对话，也没有新增记忆；${String(stats.routines)} 条例行任务仍在后台保持运转。`

  /*
   * 真实摘录：取当天最长的用户原话与最长的一条 Bot 回复。
   * 不用「随机抽一条」——长文本通常是当天真正展开过的话题，引用它比引用一句「好的」有意义。
   */
  const longestUser = [...userMessages].sort((a, b) => b.text.length - a.text.length)[0]
  const longestBot = [...botMessages].sort((a, b) => b.text.length - a.text.length)[0]
  const userQuote = longestUser === undefined ? '' : truncateText(longestUser.text, 120)
  const botQuote = longestBot === undefined ? '' : truncateText(longestBot.text, 120)
  const quoteLines: string[] = []
  if (userQuote !== '') quoteLines.push(`你说：「${userQuote}」`)
  if (botQuote !== '') quoteLines.push(`${longestBot?.botName ?? 'Bot'}回：「${botQuote}」`)
  const quoteSection: JournalSection = {
    heading: '原声摘录',
    text: quoteLines.length > 0 ? quoteLines.join('\n\n') : '今天没有新的对话，这一页留白。',
  }

  const botCountLines = [...botCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} · ${String(count)} 条`)
  const conversationSection: JournalSection = {
    heading: '今天的对话',
    text: total > 0
      ? `这一天一共 ${String(total)} 条消息，其中你说了 ${String(stats.userMessages)} 条，`
        + `${String(stats.botMessages)} 条来自 ${String(stats.activeBots)} 个助手。`
        + `${topics.length > 0 ? `反复出现的词是 ${topics.join('、')}。` : '内容比较零散，没有形成集中的话题。'}`
      : '今天没有新的对话，也没有需要归档的进展。',
    ...(botCountLines.length > 0 ? { bullets: botCountLines } : {}),
  }

  const firstMemory = state.memories
    .filter((entry) => entry.createdAt >= dayStart && entry.createdAt < dayEnd && entry.text.trim() !== '')
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  const callsToday = state.calls.filter((call) => call.startedAt >= dayStart && call.startedAt < dayEnd).length
  const memoryLine = stats.memories > 0
    ? `新增记忆 ${String(stats.memories)} 条${firstMemory === undefined ? '' : `，其中一条是「${truncateText(firstMemory.text, 60)}」`}。`
    : '今天没有新增记忆。'
  const routineLine = stats.routines > 0
    ? `${String(stats.routines)} 条例行任务仍在后台保持运转。`
    : '当前没有启用的例行任务。'
  const callLine = callsToday > 0 ? `另外有 ${String(callsToday)} 通语音通话。` : ''
  const recordSection: JournalSection = {
    heading: '这一天还发生了什么',
    text: `${memoryLine}${routineLine}${callLine}`,
  }

  const sections: JournalSection[] = [conversationSection, quoteSection, recordSection]

  const statsBlocks: JournalStat[] = [
    { label: '对话消息', value: String(total) },
    { label: '活跃 Bot', value: String(stats.activeBots) },
    { label: '新增记忆', value: String(stats.memories) },
    { label: '例行任务', value: String(stats.routines) },
  ]

  const mood = total === 0
    ? '安静'
    : total >= 20
      ? '热闹'
      : stats.userMessages > stats.botMessages ? '忙碌' : '专注'

  const imagePrompt = [
    '宽幅期刊编辑插画，16:9，主题「' + title + '」。',
    topics.length > 0 ? `画面围绕 ${topics.join('、')} 展开；` : '',
    '深蓝与暖橙的夜色城市，几个人形剪影在各自窗口工作，细线把它们连成一张网络，',
    '纸张纹理、克制的留白、编辑部刊物质感，不要文字。',
  ].join('')

  return {
    id: shortId('journal'),
    botId,
    title,
    subtitle: stats.activeBots > 0 ? `Seeker 日报 · ${String(stats.activeBots)} 位助手` : 'Seeker 日报 · 个人记录',
    date: journalDateKey(date),
    dateLabel: journalDateLabel(date),
    issue: journalIssue(state.journals.length),
    summary,
    sections,
    ...(userQuote !== '' && longestUser !== undefined ? { quote: truncateText(longestUser.text, 100) } : {}),
    mood,
    imagePrompt,
    ...(opts?.image !== undefined && opts.image !== '' ? { image: opts.image } : {}),
    generatedAt: Date.now(),
    auto: opts?.auto ?? false,
    stats: statsBlocks,
    highlights: buildHighlights(feed.messages),
    origin: 'local',
  }
}

/**
 * 程序化期刊封面：没有生图结果时也能给出有编辑感的宽幅图。
 *
 * 16:9，两套配色：
 *  · `dark`（默认，不传时与旧版外观逐像素一致）：深蓝底 + 暖橙光晕 + 细线网络；
 *  · `light`：米白 / 暖棕纸张 + 深蓝细线网络，给亮色主题的阅读器用。
 *
 * 只依赖标题与期号做随机种子，同一个封面的构图稳定（不会每次渲染都换一张）。
 */
export function journalCoverSvg(
  journal: Pick<Journal, 'title' | 'issue'>,
  theme: 'dark' | 'light' = 'dark',
): string {
  const light = theme === 'light'
  const seed = hash(journal.title + journal.issue)
  const x1 = 160 + (seed % 220)
  const x2 = 620 + (seed % 180)
  const y1 = 120 + (seed % 70)
  const bgStops = light
    ? ['#faf5ec', '#f1e7d7', '#e7d4ba']
    : ['#0d1424', '#182238', '#2b1c17']
  const glow = light
    ? { core: '#d99a4e', edge: '#b9782c', coreOpacity: '0.55', edgeOpacity: '0.16' }
    : { core: '#ff9f0a', edge: '#ff6b1a', coreOpacity: '0.85', edgeOpacity: '0.22' }
  const lineColor = light ? '#2f4a6b' : '#ffffff'
  const lineOpacity = light ? '0.26' : '0.18'
  const nodeColor = light ? '#a86a2a' : '#ffb45c'
  const windowAttrs = light
    ? 'fill="#fdfaf4" stroke="#2f4a6b" stroke-opacity=".22"'
    : 'fill="#0b101c" opacity=".9"'
  const windowAccent = light ? '#c98a3f' : '#ffb45c'
  const windowAccentOpacity = light ? '0.8' : '0.55'
  const textColor = light ? '#3a2c1e' : '#f6efe2'
  const subColor = light ? '#5b4a38' : '#f6efe2'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bgStops[0]}"/><stop offset=".55" stop-color="${bgStops[1]}"/><stop offset="1" stop-color="${bgStops[2]}"/>
    </linearGradient>
    <radialGradient id="glow" cx=".72" cy=".38" r=".42">
      <stop offset="0" stop-color="${glow.core}" stop-opacity="${glow.coreOpacity}"/><stop offset=".55" stop-color="${glow.edge}" stop-opacity="${glow.edgeOpacity}"/><stop offset="1" stop-color="${glow.edge}" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <rect width="1280" height="720" fill="url(#glow)"/>
  <g stroke="${lineColor}" stroke-opacity="${lineOpacity}" stroke-width="1.2" fill="none">
    <path d="M${x1} ${y1} L${x2} ${y1 + 110} L${x2 + 120} ${y1 + 20} L${x2 + 260} ${y1 + 190}"/>
    <path d="M${x1} ${y1} L${x1 + 90} ${y1 + 220} L${x2 + 120} ${y1 + 20}"/>
    <path d="M${x1 + 90} ${y1 + 220} L${x2 + 260} ${y1 + 190}"/>
  </g>
  <g fill="${nodeColor}">
    <circle cx="${x1}" cy="${y1}" r="5"/><circle cx="${x2}" cy="${y1 + 110}" r="4"/>
    <circle cx="${x2 + 120}" cy="${y1 + 20}" r="6"/><circle cx="${x2 + 260}" cy="${y1 + 190}" r="4"/>
    <circle cx="${x1 + 90}" cy="${y1 + 220}" r="5"/>
  </g>
  <g ${windowAttrs}>
    <rect x="120" y="440" width="240" height="180" rx="6"/><rect x="410" y="390" width="180" height="230" rx="6"/>
    <rect x="640" y="450" width="260" height="170" rx="6"/><rect x="950" y="410" width="170" height="210" rx="6"/>
  </g>
  <g fill="${windowAccent}" opacity="${windowAccentOpacity}">
    <rect x="150" y="470" width="42" height="30" rx="3"/><rect x="440" y="426" width="34" height="24" rx="3"/>
    <rect x="676" y="486" width="50" height="30" rx="3"/><rect x="982" y="446" width="30" height="22" rx="3"/>
  </g>
  <text x="84" y="640" fill="${textColor}" font-family="Georgia, 'Songti SC', serif" font-size="38" opacity=".92">${escapeXml(journal.issue)}</text>
  <text x="84" y="682" fill="${subColor}" font-family="Georgia, 'Songti SC', serif" font-size="22" opacity=".5">PERSONAL AGENT · DAILY JOURNAL</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch] as string)
}

/* ───────────────────────── 记忆 / 例行任务辅助 ───────────────────────── */

export function memoryFromText(botId: string, text: string, tags: string[] = ['对话']): MemoryEntry {
  return {
    id: shortId('mem'),
    botId,
    text: text.trim(),
    tags,
    createdAt: Date.now(),
    source: '对话',
  }
}

export function nextRoutineAt(routine: Routine, from = Date.now()): number | undefined {
  const s = routine.schedule
  if (s.kind === 'interval') return from + s.everyMinutes * 60_000
  if (s.kind === 'once') return s.at
  const [hh, mm] = s.time.split(':').map((v) => Number(v))
  const date = new Date(from)
  date.setHours(hh, mm, 0, 0)
  if (date.getTime() <= from) date.setDate(date.getDate() + 1)
  if (s.kind === 'weekly') {
    const wanted = new Set(s.weekdays)
    for (let i = 0; i < 8; i += 1) {
      if (wanted.has(date.getDay() === 0 ? 7 : date.getDay())) break
      date.setDate(date.getDate() + 1)
    }
  }
  return date.getTime()
}

export const NEW_BOT_SUGGESTIONS = [
  { role: '日程管家', description: '管理日程、会议与提醒，提前发现冲突。' },
  { role: '代码审查员', description: '盯着仓库的 PR 与 CI，把风险点列成清单。' },
  { role: '内容策划', description: '把想法整理成选题、提纲和可发布的文案。' },
  { role: '数据分析师', description: '从表格与日志里找趋势，输出可读的结论。' },
  { role: '旅行规划师', description: '按预算和偏好做行程，顺手订好关键节点。' },
  { role: '学习教练', description: '拆学习计划、出练习题，按时检查进度。' },
]

export const BOT_COLORS = ['#ff453a', '#ff9f0a', '#30d158', '#2f6bff', '#bf5af2', '#64d2ff', '#ff6482', '#b07a4a']

export const BOT_SHAPES = ['blob', 'whale', 'cat', 'leaf', 'orbit', 'spark', 'ring'] as const

export function randomBotAppearance(): { color: string; shape: Bot['avatar']['shape']; tint: string } {
  const color = pick(BOT_COLORS)
  return { color, shape: pick(BOT_SHAPES), tint: shade(color, -18) }
}

export function shade(hex: string, amount: number): string {
  const raw = hex.replace('#', '')
  const num = parseInt(raw, 16)
  const clamp = (v: number): number => Math.max(0, Math.min(255, v))
  const r = clamp((num >> 16) + amount)
  const g = clamp(((num >> 8) & 0xff) + amount)
  const b = clamp((num & 0xff) + amount)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** 供 host 端生图提示词复用的固定宽高比。 */
export const JOURNAL_ASPECT = '16:9'
