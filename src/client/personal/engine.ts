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
  formatDateLabel,
  shortId,
  type AppState,
  type Bot,
  type InteractiveUi,
  type Journal,
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

const JOURNAL_TITLES = [
  '把复杂的事交给对的人',
  '在喧闹里留一条清晰的线',
  '今天，我们把等待变短了',
  '小事做顺，大事自然发生',
  '让每一次交接都有回声',
  '慢一点确认，快一点完成',
]

const JOURNAL_OPENINGS = [
  '今天的节奏不快，但每一步都落在该落的地方。',
  '如果把今天摊开看，会发现真正推动事情的是一些很小的确认。',
  '这一天没有戏剧性的转折，只有几条线安静地向前。',
  '今天的关键词是「收束」：散出去的任务，晚上都回到了同一张桌上。',
]

/** 生成一篇期刊日记（文字部分）。 */
export function buildJournal(state: AppState, botId: string, opts?: { auto?: boolean; date?: Date; image?: string }): Journal {
  const date = opts?.date ?? new Date()
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const bots = state.bots.filter((bot) => bot.id !== botId)
  const active = bots.filter((bot) => (bot.lastAt ?? 0) > dayStart - 24 * 3600_000).slice(0, 3)
  const names = active.map((bot) => bot.name).join('、')
  const userMsgs = state.messages.filter((msg) => msg.role === 'user' && msg.at > dayStart - 24 * 3600_000)
  const botMsgs = state.messages.filter((msg) => msg.role === 'bot' && msg.at > dayStart - 24 * 3600_000)
  const routines = state.routines.filter((routine) => routine.enabled)
  const memories = state.memories.filter((item) => item.createdAt > dayStart - 24 * 3600_000)
  const totalMessages = userMsgs.length + botMsgs.length
  const progressText = active.length > 0
    ? `${active.map((bot) => `${bot.name}今天留下了新的进展`).join('；')}。晚上我把它们收在同一条时间线上。`
    : totalMessages > 0
      ? `今天主要是我和你之间的 ${totalMessages} 条对话，没有子 Bot 参与。我把它们整理成了这一页。`
      : '今天还没有新的对话记录，我把安静的一天也记了下来。'

  const title = pick(JOURNAL_TITLES)
  const partner = names === '' ? '你' : names
  const summary =
    `${JOURNAL_OPENINGS[Math.floor(Math.random() * JOURNAL_OPENINGS.length)]}` +
    `今天与${partner}一共交换了 ${Math.max(0, totalMessages)} 条消息，` +
    `${routines.length} 条例行任务在后台保持运转，${memories.length} 条新记忆被收进档案。`

  const sections = [
    {
      heading: '今日进展',
      text: progressText,
    },
    {
      heading: '一个小观察',
      text:
        '真正花时间的不是执行，而是等待确认。今天开始，我会要求每个助手在回报里带「当前做到哪一段」和「下一步是什么」，' +
        '这样汇总的成本会低很多。',
    },
    {
      heading: '明天的第一件事',
      text: active.length > 0
        ? '先跟进今天还没有闭环的那条线；如果已经有结果，就按完整结论带回来，不再只报进度。'
        : '先等你开口。没有新的任务时，我会保持安静，不编造进展。',
    },
  ]

  const imagePrompt = [
    '宽幅期刊编辑插画，16:9，' + title + '。',
    '深蓝与暖橙的夜色城市，几个人形剪影在各自窗口工作，细线把它们连成一张网络，',
    '纸张纹理、克制的留白、编辑部刊物质感，不要文字。',
  ].join('')

  return {
    id: shortId('journal'),
    botId,
    title,
    subtitle: '小墨日报 · 今日刊',
    date: date.toISOString().slice(0, 10),
    dateLabel: formatDateLabel(date.getTime()),
    issue: `No. ${String(15 + state.journals.length).padStart(3, '0')}`,
    summary,
    sections,
    quote: pick([
      '把事情交出去，不等于失去掌控；清晰的分工本身就是掌控。',
      '好的协作不是没有等待，而是让等待有回声。',
      '今天的每一步都不响，但都在往前。',
    ]),
    mood: pick(['平稳', '专注', '轻快']),
    weather: pick(['晴 · 18℃', '多云 · 16℃', '夜风 · 14℃']),
    imagePrompt,
    image: opts?.image,
    generatedAt: Date.now(),
    auto: opts?.auto ?? false,
  }
}

/**
 * 程序化期刊封面：没有生图结果时也能给出有编辑感的宽幅图。
 * 16:9，深蓝底色 + 暖橙光晕 + 细线网络，和日记主题呼应。
 */
export function journalCoverSvg(journal: Pick<Journal, 'title' | 'issue'>): string {
  const seed = hash(journal.title + journal.issue)
  const x1 = 160 + (seed % 220)
  const x2 = 620 + (seed % 180)
  const y1 = 120 + (seed % 70)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d1424"/><stop offset=".55" stop-color="#182238"/><stop offset="1" stop-color="#2b1c17"/>
    </linearGradient>
    <radialGradient id="glow" cx=".72" cy=".38" r=".42">
      <stop offset="0" stop-color="#ff9f0a" stop-opacity=".85"/><stop offset=".55" stop-color="#ff6b1a" stop-opacity=".22"/><stop offset="1" stop-color="#ff6b1a" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <rect width="1280" height="720" fill="url(#glow)"/>
  <g stroke="#ffffff" stroke-opacity=".18" stroke-width="1.2" fill="none">
    <path d="M${x1} ${y1} L${x2} ${y1 + 110} L${x2 + 120} ${y1 + 20} L${x2 + 260} ${y1 + 190}"/>
    <path d="M${x1} ${y1} L${x1 + 90} ${y1 + 220} L${x2 + 120} ${y1 + 20}"/>
    <path d="M${x1 + 90} ${y1 + 220} L${x2 + 260} ${y1 + 190}"/>
  </g>
  <g fill="#ffb45c">
    <circle cx="${x1}" cy="${y1}" r="5"/><circle cx="${x2}" cy="${y1 + 110}" r="4"/>
    <circle cx="${x2 + 120}" cy="${y1 + 20}" r="6"/><circle cx="${x2 + 260}" cy="${y1 + 190}" r="4"/>
    <circle cx="${x1 + 90}" cy="${y1 + 220}" r="5"/>
  </g>
  <g fill="#0b101c" opacity=".9">
    <rect x="120" y="440" width="240" height="180" rx="6"/><rect x="410" y="390" width="180" height="230" rx="6"/>
    <rect x="640" y="450" width="260" height="170" rx="6"/><rect x="950" y="410" width="170" height="210" rx="6"/>
  </g>
  <g fill="#ffb45c" opacity=".55">
    <rect x="150" y="470" width="42" height="30" rx="3"/><rect x="440" y="426" width="34" height="24" rx="3"/>
    <rect x="676" y="486" width="50" height="30" rx="3"/><rect x="982" y="446" width="30" height="22" rx="3"/>
  </g>
  <text x="84" y="640" fill="#f6efe2" font-family="Georgia, 'Songti SC', serif" font-size="38" opacity=".92">${escapeXml(journal.issue)}</text>
  <text x="84" y="682" fill="#f6efe2" font-family="Georgia, 'Songti SC', serif" font-size="22" opacity=".5">PERSONAL AGENT · DAILY JOURNAL</text>
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
