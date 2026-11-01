/**
 * Personal Agent — 全局状态与动作（前端）。
 *
 * 设计原则：
 *  - 单一 AppState + 派生选择器；所有写操作集中在这里，组件只读 state / 调 actions。
 *  - 持久化到 localStorage（pa:state:v1）；首次运行注入 seed。
 *  - 消息回复默认走本地引擎；若 host `/api/personal-agent/reply` 可用，则用真实模型结果替换。
 *  - 定时器（例行任务 / 日记触发）挂在 Provider 上，页面开着就会真实跑。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  buildJournal,
  BOT_COLORS,
  callReply,
  firstBotMessage,
  followUpForAnswer,
  generateReply,
  journalCoverSvg,
  memoryFromText,
  NEW_BOT_SUGGESTIONS,
  nextRoutineAt,
  proactiveMessage,
  randomBotAppearance,
} from './engine.ts'
import {
  createInitialState,
  createMainBot,
  LEGACY_SEED_BOT_IDS,
  LEGACY_SEED_GROUP_IDS,
  LEGACY_SEED_JOURNAL_IDS,
  LEGACY_SEED_ROOM_IDS,
  LEGACY_SEED_ROUTINE_IDS,
} from './seed.ts'
import {
  DEFAULT_GROUP_ID,
  MAIN_BOT_ID,
  MODEL_FALLBACK,
  shortId,
  type AppState,
  type Bot,
  type BotModel,
  type CallRecord,
  type ChatImage,
  type InteractiveUi,
  type Journal,
  type Message,
  type MessageBlock,
  type NewBotInput,
  type PersonalUi,
  type Routine,
  type ToolRun,
} from './types.ts'

const STORAGE_KEY = 'pa:state:v1'
const UI_KEY = 'pa:ui:v1'

type AnswerValue = string | string[] | Record<string, string>

export interface PersonalActions {
  selectBot(id: string): void
  selectRoom(id: string): void
  setView(view: 'chat' | 'journal'): void
  setTheme(theme: 'auto' | 'dark' | 'light'): void
  setRightTab(tab: PersonalUi['rightTab']): void
  toggleRightPanel(open?: boolean): void
  openNewBot(open: boolean): void
  openGroupSettings(roomId: string | null): void
  openJournal(id: string | null): void
  sendMessage(text: string, opts?: { botId?: string; roomId?: string; images?: ChatImage[] }): void
  createBot(input: NewBotInput): Promise<Bot>
  updateBot(id: string, patch: Partial<Bot>): void
  deleteBot(id: string): void
  setBotEnabled(id: string, enabled: boolean): void
  moveBot(id: string, groupId: string): void
  createGroup(name: string): void
  renameGroup(id: string, name: string): void
  deleteGroup(id: string): void
  createRoom(name: string, memberIds: string[]): string
  updateRoom(id: string, patch: Partial<{ name: string; memberIds: string[]; modelMode: 'inherit' | 'unified'; unifiedModel: BotModel }>): void
  deleteRoom(id: string): void
  answerInteractive(messageId: string, value: AnswerValue): void
  /**
   * 撤回一条用户消息：删掉这一轮的界面消息与本地记忆，插一条系统提示，
   * 并尽力通知宿主把模型上下文也遮蔽掉（失败静默，不影响本地结果）。
   */
  recallMessage(messageId: string): void
  addMemory(botId: string, text: string, tags?: string[]): void
  deleteMemory(id: string): void
  createRoutine(input: { botId: string; name: string; instruction: string; schedule: Routine['schedule'] }): void
  toggleRoutine(id: string): void
  runRoutine(id: string): void
  deleteRoutine(id: string): void
  proactiveNow(botId: string): void
  /** 清空某个 bot 的全部对话（界面消息 + 宿主侧 agent 会话）。 */
  clearConversation(botId: string): Promise<void>
  generateJournal(botId: string, opts?: { auto?: boolean; date?: Date }): Promise<Journal>
  runJournalCheck(nowOverride?: number): { ok: boolean; reason: string; journalId?: string }
  startCall(botId: string): void
  endCall(): void
  callUserTurn(text: string): void
  setCallMuted(muted: boolean): void
  setCallSpeaker(speaker: boolean): void
  minimizeCall(minimized: boolean): void
  toast(text: string): void
  clearUnread(id: string, kind?: 'bot' | 'room'): void
}

interface PersonalContextValue {
  state: AppState
  ui: PersonalUi
  actions: PersonalActions
  activeBot: Bot
  activeRoom: { id: string; name: string; memberIds: string[] } | null
  activeMessages: Message[]
}

const PersonalContext = createContext<PersonalContextValue | null>(null)

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AppState
      if (parsed && Array.isArray(parsed.bots)) {
        return normalizeState(parsed)
      }
    }
  } catch {
    /* 损坏的本地状态一次性丢弃 */
  }
  return createInitialState()
}

/**
 * 迁移 / 清理旧版演示状态。
 *
 * 2026-11-01 用户要求「移除所有假的 bot，初始化主 bot」：旧版种子里的七个演示
 * 子 Bot、协作小组、示例期刊、示例记忆与示例例行任务全部清掉；只保留主 Bot
 * 和用户自己创建的 Bot / 群聊 / 记忆 / 任务。旧版 `version:1` 一并升级到 2。
 */
function normalizeState(parsed: AppState): AppState {
  const legacyBots = new Set<string>(LEGACY_SEED_BOT_IDS)
  const legacyRooms = new Set<string>(LEGACY_SEED_ROOM_IDS)
  const legacyGroups = new Set<string>(LEGACY_SEED_GROUP_IDS)
  const legacyRoutines = new Set<string>(LEGACY_SEED_ROUTINE_IDS)
  const legacyJournals = new Set<string>(LEGACY_SEED_JOURNAL_IDS)
  const raw = parsed as unknown as Record<string, any>

  let bots = (Array.isArray(raw.bots) ? raw.bots : [])
    .filter((bot: any) => bot && typeof bot.id === 'string' && !legacyBots.has(bot.id))
    // 旧数据没有 permission 字段：补成完全权限（与「bot 是 agent」的默认预期一致）
    .map((bot: any) => ({
      ...bot,
      unread: 0,
      permission: bot.permission === 'approval' ? 'approval' : 'full',
    }))
  if (!bots.some((bot: Bot) => bot.isMain)) bots = [createMainBot(), ...bots]

  const groups = (Array.isArray(raw.groups) ? raw.groups : [])
    .filter((group: any) => group && typeof group.id === 'string' && !legacyGroups.has(group.id))
  if (!groups.some((group: any) => group.id === DEFAULT_GROUP_ID)) {
    groups.unshift({ id: DEFAULT_GROUP_ID, name: '助手', order: 0 })
  }
  const groupIds = new Set(groups.map((group: any) => group.id))
  bots = bots.map((bot: Bot) => (groupIds.has(bot.groupId) ? bot : { ...bot, groupId: DEFAULT_GROUP_ID }))

  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .filter((message: any) => message
      && !legacyBots.has(message.botId)
      && !legacyRooms.has(message.roomId)
      && !String(message.id ?? '').startsWith('m-'))

  const rooms = (Array.isArray(raw.rooms) ? raw.rooms : [])
    .filter((room: any) => room && typeof room.id === 'string' && !legacyRooms.has(room.id))
    .map((room: any) => ({
      ...room,
      memberIds: (Array.isArray(room.memberIds) ? room.memberIds : []).filter((id: string) => !legacyBots.has(id)),
    }))
    .filter((room: any) => room.memberIds.length > 0)

  const memories = (Array.isArray(raw.memories) ? raw.memories : [])
    .filter((entry: any) => entry
      && !legacyBots.has(entry.botId)
      && entry.id !== 'mem-main-1'
      && entry.id !== 'mem-main-2')
  const routines = (Array.isArray(raw.routines) ? raw.routines : [])
    .filter((routine: any) => routine
      && !legacyBots.has(routine.botId)
      && !legacyRoutines.has(routine.id))
  const calls = (Array.isArray(raw.calls) ? raw.calls : [])
    .filter((call: any) => call && !legacyBots.has(call.botId))
  const journals = (Array.isArray(raw.journals) ? raw.journals : [])
    .filter((journal: any) => journal
      && !legacyBots.has(journal.botId)
      && !legacyJournals.has(journal.id))

  // 主 Bot 的 lastMessage / lastAt 从清理后的消息重新算，避免还挂着演示摘要。
  bots = bots.map((bot: Bot) => {
    const own = messages.filter((message: Message) => message.botId === bot.id).sort((a: Message, b: Message) => a.at - b.at)
    const last = own.length > 0 ? own[own.length - 1] : undefined
    return {
      ...bot,
      lastMessage: last !== undefined ? truncate(blocksToText(last.blocks)) : undefined,
      lastAt: last?.at,
    }
  })

  const settings = {
    // v1 的「深色/浅色」是旧版设置弹窗的假选择（只 toast 不生效），迁移时改回跟随；
    // v2 用户手动选过才保留。
    theme: raw.version === 1
      ? 'auto'
      : (raw.settings?.theme === 'dark' || raw.settings?.theme === 'light' || raw.settings?.theme === 'auto' ? raw.settings.theme : 'auto'),
    showRightPanel: raw.settings?.showRightPanel !== false,
    journalRule: raw.settings?.journalRule ?? { enabled: true, startHour: 0, endHour: 8, idleMinutes: 30 },
  }
  const lastUserMessageAt = messages
    .filter((message: Message) => message.role === 'user')
    .reduce((max: number, message: Message) => Math.max(max, message.at), 0)

  return {
    version: 2,
    bots,
    groups,
    rooms,
    messages,
    memories,
    routines,
    calls,
    journals,
    journalLogs: [],
    settings,
    lastUserMessageAt,
  }
}

function loadUi(state: AppState): PersonalUi {
  const fallback: PersonalUi = {
    selectedBotId: state.bots.find((bot) => bot.isMain)?.id ?? state.bots[0].id,
    selectedRoomId: null,
    view: 'chat',
    rightPanelOpen: true,
    rightTab: 'detail',
    newBotOpen: false,
    groupSettingsOpen: null,
    journalOpenId: null,
    call: { status: 'idle', botId: null, startedAt: 0, muted: false, speaker: true, minimized: false, liveTurns: [], thinking: false },
    search: '',
    toast: null,
  }
  try {
    const raw = localStorage.getItem(UI_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersonalUi>
      return {
        ...fallback,
        selectedBotId: parsed.selectedBotId && state.bots.some((bot) => bot.id === parsed.selectedBotId) ? parsed.selectedBotId : fallback.selectedBotId,
        rightPanelOpen: parsed.rightPanelOpen ?? true,
        rightTab: parsed.rightTab ?? 'detail',
      }
    }
  } catch {
    /* ignore */
  }
  return fallback
}

function truncate(text: string, max = 32): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function blocksToText(blocks: MessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') return '[图片]'
      if (block.type === 'task') return block.title
      if (block.type === 'call') return '语音通话'
      if (block.type === 'journal') return block.title
      if (block.type === 'interactive') return block.prompt ?? '交互卡片'
      return ''
    })
    .join(' ')
}

function uiTextForAnswer(uiBlock: InteractiveUi, value: AnswerValue): string {
  if (typeof value === 'string') {
    if (uiBlock.kind === 'form') return value
    const option = uiBlock.options.find((item) => item.id === value)
    return option?.label ?? value
  }
  if (Array.isArray(value)) {
    if (uiBlock.kind === 'form') return value.join('、')
    return value.map((id) => uiBlock.options.find((item) => item.id === id)?.label ?? id).join('、')
  }
  return Object.entries(value)
    .map(([key, val]) => `${key}: ${val}`)
    .join('；')
}

/**
 * 宿主 `/api/personal-agent/reply/stream` 的事件形状（见 host/personal/agent.ts
 * 的 PersonalStreamEvent）。前端按 type 分支处理：
 *
 *  · text  —— 一段正文；同一轮里可能来多次（每个模型步骤一段），渲染时与上一段合并
 *  · tool  —— 工具调用快照；同一 callId 先 running 后 ok / error，按 id 就地替换
 *  · error —— 本轮出错（含「agent 建不起来」这类致命错误）
 *  · done  —— 收口信号。**host 目前会重复发**（runBotTurn 内部一次 + 路由收尾
 *             一次，`!turn.ok` 时 done 后面还会再补一条 error），所以前端必须幂等
 */
export type PersonalStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; run: ToolRun }
  | { type: 'error'; message: string }
  | { type: 'done'; durationMs: number }

/**
 * 从 SSE 字节流里切出完整帧，返回还没吃完的尾巴（下次拼上新数据继续切）。
 *
 * 纯函数，不碰 fetch / DOM，便于 node 侧自测。约定：
 *  · 帧分隔是空行（`\n\n`）；`\r\n\r\n` 也认——先把 `\r\n` 归一成 `\n` 再找。
 *    归一化是安全的：chunk 边界正好切在 `\r` 和 `\n` 之间时，那个孤立的 `\r`
 *    会留在尾巴里，下一块数据以 `\n` 开头拼起来仍是 `\r\n`，下次调用照样归一。
 *  · 每帧取所有 `data:` 行，去掉冒号后**一个**前导空格，用 `\n` 拼起来交给 onFrame；
 *  · 没有 data 行的帧（注释帧 / 心跳）直接丢掉；
 *  · 只有半帧（还没等到空行）时原样返回，等下一块数据补齐。
 */
export function parseSseFrames(buffer: string, onFrame: (data: string) => void): string {
  let rest = buffer.replace(/\r\n/g, '\n')
  let split = rest.indexOf('\n\n')
  while (split >= 0) {
    emitSseFrame(rest.slice(0, split), onFrame)
    rest = rest.slice(split + 2)
    split = rest.indexOf('\n\n')
  }
  return rest
}

/** 把一帧的原始文本抽成 data 载荷（多行 data 按 SSE 规范用 `\n` 连接）。 */
function emitSseFrame(frame: string, onFrame: (data: string) => void): void {
  const parts: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const value = line.slice(5)
    parts.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  if (parts.length === 0) return
  onFrame(parts.join('\n'))
}

/**
 * 把一帧的 data 文本解析成流式事件。
 *
 * 非 JSON / 形状不认识 / 缺关键字段时返回 null 由调用方静默跳过——流里混进
 * 一条脏帧不该让整轮回复失败。
 */
export function parseSseEvent(data: string): PersonalStreamEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  const type = typeof raw.type === 'string' ? raw.type : ''
  if (type === 'text') {
    return typeof raw.text === 'string' ? { type: 'text', text: raw.text } : null
  }
  if (type === 'tool') {
    if (raw.run === null || typeof raw.run !== 'object') return null
    const run = raw.run as Record<string, unknown>
    if (typeof run.id !== 'string' || typeof run.name !== 'string') return null
    return { type: 'tool', run: run as unknown as ToolRun }
  }
  if (type === 'error') {
    return { type: 'error', message: typeof raw.message === 'string' ? raw.message : '未知错误' }
  }
  if (type === 'done') {
    return { type: 'done', durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0 }
  }
  return null
}

/**
 * 把一个流式事件合进 blocks，返回新数组（不改入参，React 才能看见变化）。
 *
 *  · text：追加到末尾的 text 块上，用空行连接——与 MessageBlockView 里
 *          mergeTextBlocks 的规则一致，避免每个模型步骤变成一坨独立气泡；
 *          空白文本忽略（host 侧虽然已经 trim 过，这里再兜一层）。
 *  · tool：按 run.id 就地替换（同一 callId 的多次快照只留最新一条），
 *          位置保持在第一次出现的地方，卡片不会跳来跳去。
 *  · error / done：不产生可见块。错误由调用方在收口时决定要不要展示成文本。
 */
export function applyStreamEventToBlocks(blocks: MessageBlock[], event: PersonalStreamEvent): MessageBlock[] {
  if (event.type === 'text') {
    const text = event.text.trim()
    if (text === '') return blocks
    const last = blocks[blocks.length - 1]
    if (last !== undefined && last.type === 'text') {
      const next = blocks.slice(0, -1)
      next.push({ type: 'text', text: `${last.text}\n\n${text}` })
      return next
    }
    return [...blocks, { type: 'text', text }]
  }
  if (event.type === 'tool') {
    const index = blocks.findIndex((block) => block.type === 'tool' && block.run.id === event.run.id)
    if (index < 0) return [...blocks, { type: 'tool', run: event.run }]
    const next = blocks.slice()
    next[index] = { type: 'tool', run: event.run }
    return next
  }
  return blocks
}

/**
 * 组装 `/reply` 与 `/reply/stream` 共用的请求体。
 *
 * 两条路由在 host 侧读的是同一个 ReplyBody（bot / permission / text / history /
 * memories），抽出来是为了保证「流式与非流式的上下文完全一致」——各写一份迟早
 * 会漂移，表现成「同一个 bot 换个入口就换了记忆」。
 */
function replyRequestBody(bot: Bot, text: string, state: AppState, images: ChatImage[] = []): string {
  return JSON.stringify({
    bot: { id: bot.id, name: bot.name, role: bot.role, description: bot.description, instructions: bot.instructions, model: bot.model },
    permission: bot.permission ?? 'full',
    text,
    // 只带相对路径：图片已经在 /upload 落盘，宿主据此在 user 消息里提示 read_image。
    ...(images.length > 0 ? { images: images.map((item) => ({ path: item.path, name: item.name })) } : {}),
    history: state.messages
      .filter((msg) => msg.botId === bot.id && !msg.roomId && !msg.pending)
      .slice(-12)
      .map((msg) => ({ role: msg.role, text: blocksToText(msg.blocks) })),
    memories: state.memories.filter((item) => item.botId === bot.id).slice(-8).map((item) => item.text),
  })
}

async function hostReply(bot: Bot, text: string, state: AppState, images: ChatImage[] = []): Promise<MessageBlock[] | null> {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null
  try {
    const controller = new AbortController()
    /*
     * 超时给足：bot 现在跑的是真 agent（可能连续读文件、跑命令、搜索），
     * 十几秒就掐断会把正常工作流误判成失败。
     */
    const timer = setTimeout(() => controller.abort(), 300_000)
    const res = await fetch('/api/personal-agent/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: replyRequestBody(bot, text, state, images),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; blocks?: MessageBlock[] }
    if (data.ok && Array.isArray(data.blocks) && data.blocks.length > 0) return data.blocks
  } catch {
    /* 无 host / 无模型：回退本地引擎 */
  }
  return null
}

/**
 * 流式版本的 hostReply：POST /api/personal-agent/reply/stream，边读边回调。
 *
 * 返回值约定：
 *  · `null` —— 请求失败（非 2xx / 不是事件流 / 没有 body / 网络异常 / 一个事件
 *              都没收到），调用方应当回退到非流式 hostReply；
 *  · 数组   —— 流跑完了，内容是最终 blocks（可能为空：只收到 error 事件、或模型
 *              确实什么都没说；空数组同样交给调用方走降级链）。
 *
 * 「流跑完」不要求见过 done 事件：host 的失败路径只 emit error 就结束流。所以只要
 * 读到了事件、流正常关闭（或中途断开时已有内容），就把累积结果交出去，调用方按
 * blocks 是否为空决定收口还是降级——pending 消息因此不会永远挂在「正在输入」。
 *
 * 为什么失败用返回值而不是抛错：调用方要按「流式 → 非流式 → 本地引擎」三级降级，
 * 返回值判断比 try/catch 直白，也不会把一次失败变成未处理的 rejection。
 *
 * onEvent 的第二参数是**当前累积出来的 blocks 快照**（不可变，每次内容事件都是新
 * 数组），调用方直接拿它整块替换 pending 消息的 blocks 即可，不必自己再维护一份
 * 累积逻辑。
 */
async function hostReplyStream(
  bot: Bot,
  text: string,
  state: AppState,
  onEvent: (event: PersonalStreamEvent, blocks: MessageBlock[]) => void,
  images: ChatImage[] = [],
): Promise<MessageBlock[] | null> {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null
  let received = 0
  let blocks: MessageBlock[] = []
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300_000)
    try {
      const res = await fetch('/api/personal-agent/reply/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: replyRequestBody(bot, text, state, images),
        signal: controller.signal,
      })
      if (!res.ok) return null
      const contentType = res.headers.get('content-type') ?? ''
      // 宿主没挂流式路由 / 被代理吞成 JSON 时，这里就能识别出来并让调用方降级
      if (!contentType.includes('text/event-stream') || res.body === null) return null

      let doneSeen = false
      const handle = (payload: string): void => {
        const event = parseSseEvent(payload)
        if (event === null) return
        // done 幂等：host 现在会发两次（runBotTurn 内部 + 路由收尾），只认第一次
        if (event.type === 'done') {
          if (doneSeen) return
          doneSeen = true
        }
        received += 1
        blocks = applyStreamEventToBlocks(blocks, event)
        onEvent(event, blocks)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          buffer = parseSseFrames(buffer, handle)
        }
        buffer += decoder.decode()
        // 收尾时可能还剩一帧没有空行结尾（服务端 res.end() 前少写一个换行）
        if (buffer.trim() !== '') parseSseFrames(`${buffer}\n\n`, handle)
      } finally {
        try {
          reader.releaseLock()
        } catch {
          /* 已释放 */
        }
      }
      // 一个事件都没读到 → 让调用方降级；读到过事件（哪怕只有 error）→ 交回累积结果
      return received === 0 ? null : blocks
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /*
     * 网络异常 / 被 abort / 读流中途断开：已经收到的部分照样返回——重跑一遍非
     * 流式会把工具调用再执行一次（生图会重复扣费），能保住已有的就用已有的。
     */
    return received === 0 ? null : blocks
  }
}

async function hostJournalImage(journal: Journal): Promise<string | null> {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const res = await fetch('/api/personal-agent/journal/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: journal.title, prompt: journal.imagePrompt, date: journal.date, aspect: '16:9' }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; image?: string }
    if (data.ok && typeof data.image === 'string' && data.image.length > 32) return data.image
  } catch {
    /* 生图不可用：使用程序化封面 */
  }
  return null
}

/** 撤回后插进消息流的系统提示文案。 */
const RECALL_NOTICE_TEXT = '你撤回了一条消息'

/**
 * 撤回计划：算出「删哪些消息、记忆窗口在哪、给宿主报什么」。
 *
 * 纯函数（不碰 DOM / fetch / React），便于 node 侧自测——范围边界是这套功能里最
 * 容易写错的地方：多删一条就是吞掉用户的下一轮，少删一条会留下「无头回复」。
 */
export interface RecallPlan {
  /** 要删掉的消息 id（含被撤回的那条用户消息、它之后的回复与 pending 占位）。 */
  removedIds: string[]
  /** 记忆删除窗口起点（被撤回用户消息的 at）。 */
  from: number
  /** 记忆删除窗口终点（撤回范围内最后一条消息的 at）。 */
  to: number
  /**
   * 这一轮涉及的全部 bot：私聊恒为这一个 bot；群聊里可能有多个成员接话，
   * 记忆删除与侧栏摘要重算都按这个集合圈（只删这一轮说的话留下的东西）。
   */
  botIds: string[]
  /** 撤回后要插回列表的系统提示（落在被删那段原来的位置上）。 */
  notice: Message
  botId: string
  roomId?: string
  /** 通知宿主用的纯文本：被撤回那条用户消息的正文。 */
  text: string
  /** 通知宿主用的时间戳：被撤回那条用户消息的 at。 */
  at: number
}

/**
 * 从消息列表算出一次撤回的范围。不是用户消息 / 找不到这条消息时返回 null。
 *
 * 范围规则：
 *  · 起点 = 这条用户消息；
 *  · 终点 = 它之后**下一条用户消息之前**——下一条用户消息之后属于新的一轮，不跟着撤；
 *  · 会话边界：私聊按 botId 圈，群聊按 roomId 圈（同一个群里接话的 bot 可能不止一个，
 *    它们的回复都属于这一轮）；别的会话的消息直接跳过；
 *  · 区间内的 bot 回复、system 提示、还在生成的 pending 占位全都算在内。
 */
export function planRecall(messages: Message[], messageId: string): RecallPlan | null {
  const target = messages.find((message) => message.id === messageId)
  // 只有用户自己发的消息能撤回：bot / system 消息没有「撤回」这个语义
  if (target === undefined || target.role !== 'user') return null
  const startIndex = messages.findIndex((message) => message.id === messageId)
  if (startIndex < 0) return null

  const roomId = target.roomId
  // 群聊：同 roomId 就是同一段会话（发言人 botId 各不相同）；私聊：同 botId 且不带 roomId
  const inScope = (message: Message): boolean => (roomId !== undefined
    ? message.roomId === roomId
    : message.botId === target.botId && message.roomId === undefined)

  const removedIds: string[] = [messageId]
  const botIds = new Set<string>([target.botId])
  let lastAt = target.at
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (!inScope(message)) continue
    // 下一条用户消息是硬边界
    if (message.role === 'user') break
    removedIds.push(message.id)
    botIds.add(message.botId)
    lastAt = Math.max(lastAt, message.at)
  }

  return {
    removedIds,
    from: target.at,
    to: lastAt,
    botIds: [...botIds],
    notice: {
      id: shortId('msg'),
      botId: target.botId,
      ...(roomId !== undefined ? { roomId } : {}),
      role: 'system',
      at: Date.now(),
      blocks: [{ type: 'text', text: RECALL_NOTICE_TEXT }],
      source: 'control',
    },
    botId: target.botId,
    ...(roomId !== undefined ? { roomId } : {}),
    text: blocksToText(target.blocks),
    at: target.at,
  }
}

/**
 * 把撤回计划落到 state 上（纯函数，同样为了可自测）。
 *
 * 做四件事：删掉范围内的消息、在原位置插一条系统提示、删掉记忆窗口内这一轮涉及的
 * bot 记下的条目、重算侧栏摘要与「最后一次用户发言时间」（否则撤完侧栏还挂着被撤掉
 * 那句话，日记的「静默多久」判据也会停留在被撤回的那条消息上）。
 */
export function applyRecall(prev: AppState, plan: RecallPlan): AppState {
  const removed = new Set(plan.removedIds)
  const participants = new Set(plan.botIds)
  const messages: Message[] = []
  let placed = false
  for (const message of prev.messages) {
    if (!removed.has(message.id)) {
      messages.push(message)
      continue
    }
    // 系统提示落在这段对话原来的位置上，读起来就是「这里少了点什么」
    if (!placed) {
      messages.push(plan.notice)
      placed = true
    }
  }
  const lastOf = (pick: (message: Message) => boolean): Message | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (pick(messages[index])) return messages[index]
    }
    return undefined
  }
  const bots = prev.bots.map((bot) => {
    if (!participants.has(bot.id)) return bot
    const last = lastOf((message) => message.botId === bot.id)
    return {
      ...bot,
      lastMessage: last !== undefined ? truncate(blocksToText(last.blocks)) : '',
      lastAt: last?.at,
    }
  })
  const rooms = prev.rooms.map((room) => {
    if (room.id !== plan.roomId) return room
    const last = lastOf((message) => message.roomId === room.id)
    return {
      ...room,
      lastMessage: last !== undefined ? truncate(blocksToText(last.blocks)) : '',
      lastAt: last?.at,
    }
  })
  // 记忆窗口：这一轮的时间跨度内、参与这一轮的 bot 记下的条目
  const memories = prev.memories.filter((entry) => !(participants.has(entry.botId)
    && entry.createdAt >= plan.from
    && entry.createdAt <= plan.to))
  const lastUserMessageAt = messages
    .filter((message) => message.role === 'user')
    .reduce((max, message) => Math.max(max, message.at), 0)
  return { ...prev, messages, bots, rooms, memories, lastUserMessageAt }
}

/**
 * 尽力通知宿主「这一轮被撤回了」。
 *
 * 与其它 host 调用不同，这里**不等待、不反馈**：撤回的第一性要求是本地立刻干净，
 * 宿主那一半只是让模型之后的上下文里也不再出现这段对话。所以路由不存在、返回
 * 4xx/5xx、网络断了一律静默——用户看到的本地结果不受任何影响。
 *
 * body 只有 botId / text / at 三样：text 是这条用户消息的纯文本，at 是它的时间戳，
 * 宿主靠这两样在会话日志里反查要遮蔽的那一段（见 host/personal/agent.ts 的
 * recallBotTurn）。
 */
async function hostRecallTurn(botId: string, text: string, at: number): Promise<void> {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      await fetch('/api/personal-agent/recall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId, text, at }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /* 宿主没挂这条路由 / 撤回失败：本地已经撤干净，静默忽略 */
  }
}

export function PersonalProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AppState>(() => loadState())
  const [ui, setUi] = useState<PersonalUi>(() => loadUi(loadState()))
  const stateRef = useRef(state)
  stateRef.current = state
  const uiRef = useRef(ui)
  uiRef.current = ui
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    const handle = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch {
        /* 配额满：只影响持久化 */
      }
    }, 180)
    return () => window.clearTimeout(handle)
  }, [state])

  useEffect(() => {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({
        selectedBotId: ui.selectedBotId,
        rightPanelOpen: ui.rightPanelOpen,
        rightTab: ui.rightTab,
      }))
    } catch {
      /* ignore */
    }
  }, [ui.selectedBotId, ui.rightPanelOpen, ui.rightTab])

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
  }, [])

  const later = useCallback((ms: number, run: () => void): void => {
    const timer = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((id) => id !== timer)
      run()
    }, ms)
    timersRef.current.push(timer)
  }, [])

  const toast = useCallback((text: string): void => {
    setUi((prev) => ({ ...prev, toast: text }))
    later(2600, () => setUi((prev) => (prev.toast === text ? { ...prev, toast: null } : prev)))
  }, [later])

  const appendMessage = useCallback((message: Message): void => {
    setState((prev) => {
      const bots = prev.bots.map((bot) => {
        if (bot.id !== message.botId) return bot
        return {
          ...bot,
          lastMessage: truncate(blocksToText(message.blocks)),
          lastAt: message.at,
          unread: message.role === 'bot' && !message.pending && uiRef.current.selectedBotId !== bot.id && !message.roomId
            ? bot.unread + 1
            : bot.unread,
        }
      })
      const rooms = prev.rooms.map((room) => (room.id === message.roomId
        ? { ...room, lastMessage: truncate(blocksToText(message.blocks)), lastAt: message.at, unread: message.role === 'bot' ? room.unread + 1 : room.unread }
        : room))
      return { ...prev, bots, rooms, messages: [...prev.messages, message] }
    })
  }, [])

  const replaceMessage = useCallback((id: string, blocks: MessageBlock[]): void => {
    setState((prev) => ({
      ...prev,
      messages: prev.messages.map((message) => (message.id === id ? { ...message, blocks, pending: false } : message)),
    }))
  }, [])

  /**
   * 就地更新一条消息的 blocks，**保持 pending 状态**。
   *
   * 流式渲染专用：每个 text / tool 事件都整块替换一次 pending 消息的内容，
   * 让点阵卡与正文在生成过程中就出现。收口仍然走 replaceMessage（它会把
   * pending 置回 false）。
   *
   * 用 setState 的函数式更新而不是读 stateRef：同一时刻可能有多个 bot 在
   * 各聊各的，闭包里的 state 随时是旧的，按 id 就地改才是安全的。
   */
  const updateMessageBlocks = useCallback((id: string, blocks: MessageBlock[]): void => {
    setState((prev) => ({
      ...prev,
      messages: prev.messages.map((message) => (message.id === id ? { ...message, blocks } : message)),
    }))
  }, [])

  const botById = useCallback((id: string): Bot | undefined => stateRef.current.bots.find((bot) => bot.id === id), [])

  const replyAsBot = useCallback((bot: Bot, text: string, target: { roomId?: string; source?: Message['source'] } = {}, images: ChatImage[] = []): void => {
    const pendingId = shortId('msg')
    appendMessage({
      id: pendingId,
      botId: bot.id,
      ...(target.roomId ? { roomId: target.roomId, senderId: bot.id, senderName: bot.name } : {}),
      role: 'bot',
      at: Date.now(),
      blocks: [],
      pending: true,
      source: target.source ?? 'chat',
    })

    /*
     * 三级降级：流式 → 非流式 → 本地引擎。
     *
     * 流式是唯一能让「正文逐段出现 / 生图点阵卡实时出现」的链路：宿主每 emit 一个
     * text 或 tool 事件，这里就把 pending 消息的 blocks 整块换成最新快照。
     *
     * 收口规则（每条路都必须在 pending 消息上落地，否则「正在输入」会永远转下去）：
     *  · 收到 done，或流正常结束但没收到 done 事件：有 blocks 就用它收口；
     *  · 流结束但 blocks 为空、或流里只报错：走非流式 → 本地引擎降级；
     *  · 网络异常 / 非 2xx / 任一环节抛错：同样降级，最后用兜底文案收口。
     * 不能只依赖 done 事件：host 的失败路径（agent 建不起来 / 本轮无输出）只 emit
     * error 就结束流，不再补 done。
     *
     * 每次 replyAsBot 调用都有独立的 pendingId 与局部变量，所以群聊里多个 bot
     * 同时回复时各自更新各自的消息，不会互相串。
     */
    const finish = async (): Promise<void> => {
      let streamError = ''
      try {
        const streamed = await hostReplyStream(bot, text, stateRef.current, (event, blocks) => {
          if (event.type === 'error') {
            streamError = event.message
            return
          }
          if (event.type !== 'text' && event.type !== 'tool') return
          updateMessageBlocks(pendingId, blocks)
        }, images)

        if (streamed !== null && streamed.length > 0) {
          /*
           * 只有工具卡、没有任何正文、且本轮报过错：把错误补成一条文本块。
           * 否则用户会对着几张卡猜「到底成没成」。
           */
          const finalBlocks = streamError !== '' && !streamed.some((block) => block.type === 'text')
            ? [...streamed, { type: 'text' as const, text: `本轮出错：${streamError}` }]
            : streamed
          replaceMessage(pendingId, finalBlocks)
          return
        }

        // 流式没拿到东西：退回原来的非流式链路（createBot / routine / proactive / call 也还在用它）
        const remote = await hostReply(bot, text, stateRef.current, images)
        const blocks = remote ?? generateReply(bot, text, stateRef.current)
        replaceMessage(pendingId, blocks)
      } catch (error) {
        // 兜底：降级链自己出错也不能让 pending 消息永远挂着
        const reason = streamError !== '' ? streamError : (error instanceof Error ? error.message : String(error))
        replaceMessage(pendingId, [{ type: 'text', text: `这一轮没能完成：${reason}` }])
      }
    }

    // 保留「正在输入」的手感：稍等一下再开流，避免 pending 气泡一闪而过
    later(300 + Math.random() * 300, () => { void finish() })
  }, [appendMessage, later, replaceMessage, updateMessageBlocks])

  const clearUnread = useCallback((id: string, kind: 'bot' | 'room' = 'bot'): void => {
    setState((prev) => ({
      ...prev,
      bots: kind === 'bot' ? prev.bots.map((bot) => (bot.id === id ? { ...bot, unread: 0 } : bot)) : prev.bots,
      rooms: kind === 'room' ? prev.rooms.map((room) => (room.id === id ? { ...room, unread: 0 } : room)) : prev.rooms,
    }))
  }, [])

  const selectBot = useCallback((id: string): void => {
    setUi((prev) => ({ ...prev, selectedBotId: id, selectedRoomId: null, view: 'chat', rightTab: 'detail' }))
    clearUnread(id, 'bot')
  }, [clearUnread])

  const selectRoom = useCallback((id: string): void => {
    const room = stateRef.current.rooms.find((item) => item.id === id)
    setUi((prev) => ({
      ...prev,
      selectedRoomId: id,
      // 群聊的右栏固定展示群主 Bot（第一个成员），避免右栏停留在上一个私聊对象
      selectedBotId: room?.memberIds[0] ?? prev.selectedBotId,
      view: 'chat',
    }))
    clearUnread(id, 'room')
  }, [clearUnread])

  const setTheme = useCallback((theme: 'auto' | 'dark' | 'light'): void => {
    setState((prev) => ({ ...prev, settings: { ...prev.settings, theme } }))
  }, [])

  const sendMessage = useCallback((text: string, opts: { botId?: string; roomId?: string; images?: ChatImage[] } = {}): void => {
    const value = text.trim()
    const images = opts.images ?? []
    // 只发图不打字也要能发出去
    if (value === '' && images.length === 0) return
    const current = stateRef.current
    const roomId = opts.roomId ?? uiRef.current.selectedRoomId ?? undefined
    const room = roomId ? current.rooms.find((item) => item.id === roomId) : undefined
    const botId = opts.botId ?? (room ? (room.memberIds[0] ?? MAIN_BOT_ID) : uiRef.current.selectedBotId)
    const bot = current.bots.find((item) => item.id === botId)
    if (!bot) return
    const at = Date.now()
    const blocks: MessageBlock[] = []
    if (value !== '') blocks.push({ type: 'text', text: value })
    for (const image of images) blocks.push({ type: 'image', image })
    appendMessage({ id: shortId('msg'), botId, ...(roomId ? { roomId } : {}), role: 'user', at, blocks, source: 'chat' })
    setState((prev) => ({ ...prev, lastUserMessageAt: at }))

    if (room) {
      const mentioned = room.memberIds
        .map((id) => current.bots.find((item) => item.id === id))
        .filter((item): item is Bot => item !== undefined && (value.includes(item.name) || value.includes(`@${item.name}`)))
      const responders = mentioned.length > 0 ? mentioned.slice(0, 2) : [current.bots.find((item) => item.id === room.memberIds[0]) ?? bot]
      responders.forEach((responder, index) => {
        later(300 + index * 700, () => replyAsBot(responder, value, { roomId, source: 'chat' }, images))
      })
      return
    }
    replyAsBot(bot, value, {}, images)
  }, [appendMessage, later, replyAsBot])

  const createBot = useCallback(async (input: NewBotInput): Promise<Bot> => {
    const suggestion = NEW_BOT_SUGGESTIONS[Math.floor(Math.random() * NEW_BOT_SUGGESTIONS.length)]
    const role = (input.role ?? '').trim() || (input.description ?? '').trim() || suggestion.role
    const description = (input.description ?? '').trim() || suggestion.description
    const appearance = randomBotAppearance()
    const bot: Bot = {
      id: shortId('bot'),
      name: (input.name ?? '').trim() || (role.length > 12 ? role.slice(0, 12) : role) || '新助手',
      role,
      description,
      instructions: input.instructions ?? `你是「${input.name ?? role}」，${description} 说话直接、具体，先给结论再解释。`,
      avatar: { shape: input.shape ?? appearance.shape, color: input.color ?? appearance.color, tint: appearance.tint },
      groupId: input.groupId ?? DEFAULT_GROUP_ID,
      isMain: false,
      status: 'online',
      unread: 1,
      pinned: false,
      enabled: true,
      model: MODEL_FALLBACK,
      skills: [],
      permission: 'full',
      proactive: { enabled: true, freq: 'daily', from: '09:00', to: '22:00' },
      createdAt: Date.now(),
      createdBy: MAIN_BOT_ID,
    }
    setState((prev) => ({ ...prev, bots: [...prev.bots, bot] }))
    setUi((prev) => ({ ...prev, selectedBotId: bot.id, selectedRoomId: null, newBotOpen: false, rightTab: 'detail' }))
    // 先落一条 pending 消息，再让真实模型按该 Bot 的岗位做自我介绍；host 不可用时
    // 才用带选项的本地欢迎消息兜底。
    const firstId = shortId('msg')
    appendMessage({
      id: firstId,
      botId: bot.id,
      role: 'bot',
      at: Date.now(),
      blocks: [],
      pending: true,
      source: 'proactive',
    })
    const remote = await hostReply(bot, '你刚刚被创建。请用你的岗位和简介做一次简短自我介绍，并问我希望你先做什么。', stateRef.current)
    const blocks = remote ?? firstBotMessage(bot)
    replaceMessage(firstId, blocks)
    setState((prev) => ({
      ...prev,
      bots: prev.bots.map((item) => (item.id === bot.id ? { ...item, lastMessage: truncate(blocksToText(blocks)), lastAt: Date.now() } : item)),
    }))
    toast(`已创建「${bot.name}」，它的第一条消息到了`)
    return bot
  }, [appendMessage, replaceMessage, toast])

  const updateBot = useCallback((id: string, patch: Partial<Bot>): void => {
    setState((prev) => ({ ...prev, bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot)) }))
  }, [])

  const deleteBot = useCallback((id: string): void => {
    setState((prev) => ({
      ...prev,
      bots: prev.bots.filter((bot) => bot.id !== id || bot.isMain),
      rooms: prev.rooms.map((room) => ({ ...room, memberIds: room.memberIds.filter((memberId) => memberId !== id) })),
      memories: prev.memories.filter((item) => item.botId !== id),
      routines: prev.routines.filter((item) => item.botId !== id),
    }))
    setUi((prev) => ({ ...prev, selectedBotId: prev.selectedBotId === id ? MAIN_BOT_ID : prev.selectedBotId }))
    toast('已删除该 Bot')
  }, [toast])

  const setBotEnabled = useCallback((id: string, enabled: boolean): void => {
    setState((prev) => ({ ...prev, bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, enabled, status: enabled ? 'online' : 'idle' } : bot)) }))
  }, [])

  const moveBot = useCallback((id: string, groupId: string): void => {
    setState((prev) => ({ ...prev, bots: prev.bots.map((bot) => (bot.id === id ? { ...bot, groupId } : bot)) }))
  }, [])

  const createGroup = useCallback((name: string): void => {
    const value = name.trim()
    if (value === '') return
    setState((prev) => ({ ...prev, groups: [...prev.groups, { id: shortId('group'), name: value, order: prev.groups.length }] }))
  }, [])

  const renameGroup = useCallback((id: string, name: string): void => {
    setState((prev) => ({ ...prev, groups: prev.groups.map((group) => (group.id === id ? { ...group, name } : group)) }))
  }, [])

  const deleteGroup = useCallback((id: string): void => {
    if (id === DEFAULT_GROUP_ID) return
    setState((prev) => ({
      ...prev,
      groups: prev.groups.filter((group) => group.id !== id),
      bots: prev.bots.map((bot) => (bot.groupId === id ? { ...bot, groupId: DEFAULT_GROUP_ID } : bot)),
    }))
  }, [])

  const createRoom = useCallback((name: string, memberIds: string[]): string => {
    const id = shortId('room')
    setState((prev) => ({
      ...prev,
      rooms: [...prev.rooms, {
        id,
        name: name.trim() || '新群聊',
        memberIds: memberIds.length > 0 ? memberIds : [MAIN_BOT_ID],
        unread: 0,
        modelMode: 'inherit',
        createdAt: Date.now(),
      }],
    }))
    return id
  }, [])

  const updateRoom = useCallback((id: string, patch: Partial<{ name: string; memberIds: string[]; modelMode: 'inherit' | 'unified'; unifiedModel: BotModel }>): void => {
    setState((prev) => ({ ...prev, rooms: prev.rooms.map((room) => (room.id === id ? { ...room, ...patch } : room)) }))
  }, [])

  const deleteRoom = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, rooms: prev.rooms.filter((room) => room.id !== id) }))
    setUi((prev) => ({ ...prev, selectedRoomId: prev.selectedRoomId === id ? null : prev.selectedRoomId }))
  }, [])

  const answerInteractive = useCallback((messageId: string, value: AnswerValue): void => {
    const current = stateRef.current
    const message = current.messages.find((item) => item.id === messageId)
    if (!message) return
    const block = message.blocks.find((item) => item.type === 'interactive')
    if (!block || block.type !== 'interactive') return
    const label = uiTextForAnswer(block.ui, value)
    const bot = current.bots.find((item) => item.id === message.botId)
    if (!bot) return

    setState((prev) => ({
      ...prev,
      messages: prev.messages.map((item) => (item.id === messageId
        ? {
            ...item,
            blocks: item.blocks.map((b) => (b === block ? { ...b, submitted: true, result: label, resultAt: Date.now() } : b)),
          }
        : item)),
    }))

    const replyTarget = message.roomId ? { roomId: message.roomId } : {}
    appendMessage({
      id: shortId('msg'),
      botId: bot.id,
      ...replyTarget,
      role: 'user',
      at: Date.now(),
      blocks: [{ type: 'text', text: label }],
      source: 'chat',
    })
    setState((prev) => ({ ...prev, lastUserMessageAt: Date.now() }))

    // 特定动作的真实副作用
    if (typeof value === 'string' && value === 'save-memory') {
      setState((prev) => ({
        ...prev,
        memories: [...prev.memories, memoryFromText(bot.id, block.prompt ?? label, ['交互卡'])],
      }))
    }
    if (block.ui.kind === 'form' && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, string>
      const time = record.time || record['时间'] || '09:00'
      const name = record.title || record['提醒内容'] || `${bot.name}的例行任务`
      if (/^\d{2}:\d{2}$/.test(time)) {
        const routine: Routine = {
          id: shortId('rt'),
          botId: bot.id,
          name,
          instruction: block.prompt ?? name,
          schedule: { kind: 'daily', time },
          enabled: true,
          createdAt: Date.now(),
          runs: [],
          nextAt: nextRoutineAt({ id: '', botId: bot.id, name, instruction: '', schedule: { kind: 'daily', time }, enabled: true, createdAt: Date.now(), runs: [] }),
        }
        setState((prev) => ({ ...prev, routines: [...prev.routines, routine] }))
      }
    }

    later(500 + Math.random() * 400, () => replyAsBot(bot, `用户选择了：${label}`, { ...replyTarget }))
  }, [appendMessage, later, replyAsBot])

  /**
   * 撤回一条用户消息（连带这一轮的回复、记忆与上下文入口）。
   *
   * 两段都在纯函数里：planRecall 算「删哪些、记忆窗口在哪」，applyRecall 把计划
   * 落到 state 上（删消息 + 删记忆 + 原位置插系统提示 + 重算侧栏摘要）。这里只负责
   * 串起来，并按契约「先本地、后宿主」：本地状态先落，再尽力通知宿主，**不 await**。
   */
  const recallMessage = useCallback((messageId: string): void => {
    const plan = planRecall(stateRef.current.messages, messageId)
    // 不是用户消息 / 消息已经不在了：没有可撤回的东西
    if (plan === null) return
    setState((prev) => applyRecall(prev, plan))
    // 本地已经撤干净了，最后再尽力让宿主把模型上下文也遮蔽掉（失败静默）
    void hostRecallTurn(plan.botId, plan.text, plan.at)
  }, [])

  const addMemory = useCallback((botId: string, text: string, tags: string[] = ['手动']): void => {
    const value = text.trim()
    if (value === '') return
    setState((prev) => ({ ...prev, memories: [...prev.memories, memoryFromText(botId, value, tags)] }))
    toast('已记进该 Bot 的独立记忆')
  }, [toast])

  const deleteMemory = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, memories: prev.memories.filter((item) => item.id !== id) }))
  }, [])

  const createRoutine = useCallback((input: { botId: string; name: string; instruction: string; schedule: Routine['schedule'] }): void => {
    const routine: Routine = {
      id: shortId('rt'),
      botId: input.botId,
      name: input.name.trim() || '未命名任务',
      instruction: input.instruction.trim(),
      schedule: input.schedule,
      enabled: true,
      createdAt: Date.now(),
      runs: [],
    }
    routine.nextAt = nextRoutineAt(routine)
    setState((prev) => ({ ...prev, routines: [...prev.routines, routine] }))
    toast('例行任务已创建')
  }, [toast])

  const toggleRoutine = useCallback((id: string): void => {
    setState((prev) => ({
      ...prev,
      routines: prev.routines.map((routine) => (routine.id === id
        ? { ...routine, enabled: !routine.enabled, nextAt: !routine.enabled ? nextRoutineAt(routine) : routine.nextAt }
        : routine)),
    }))
  }, [])

  const executeRoutine = useCallback((routine: Routine): void => {
    const bot = stateRef.current.bots.find((item) => item.id === routine.botId)
    if (!bot) return
    const at = Date.now()

    // 先记一条 running：界面上立刻能看到「正在跑」，而不是等半天没有反馈
    setState((prev) => ({
      ...prev,
      routines: prev.routines.map((item) => (item.id === routine.id
        ? {
            ...item,
            lastRunAt: at,
            runs: [...item.runs.slice(-19), { at, status: 'running' as const }],
            nextAt: item.schedule.kind === 'once' ? undefined : nextRoutineAt(item, at),
            enabled: item.schedule.kind === 'once' ? false : item.enabled,
          }
        : item)),
    }))

    /*
     * 真执行：把任务描述投给 agent，让它自己判断该查什么、跑什么。
     *
     * 旧实现是直接拼一句「例行任务已执行」再随机塞一张「已完成」卡片——那是
     * 假装干活：界面上看着有结果，实际系统里什么都没发生。现在这一轮真的会跑
     * 工具，结果也来自模型自己，失败就如实报失败。
     */
    void (async () => {
      const prompt = [
        `【例行任务】${routine.name}`,
        routine.instruction.trim() !== '' ? routine.instruction : '按你的判断检查一下当前状态，有异常就指出来。',
        '',
        '现在开始执行这个例行任务：该查就查、该跑就跑，然后把结果告诉我。',
      ].join('\n')

      let blocks: MessageBlock[]
      let status: 'ok' | 'failed'
      try {
        const remote = await hostReply(bot, prompt, stateRef.current)
        if (remote !== null) {
          blocks = remote
          status = 'ok'
        } else {
          blocks = [{ type: 'text', text: `例行任务「${routine.name}」没能执行：宿主连接不可用。` }]
          status = 'failed'
        }
      } catch {
        blocks = [{ type: 'text', text: `例行任务「${routine.name}」执行出错。` }]
        status = 'failed'
      }

      appendMessage({ id: shortId('msg'), botId: bot.id, role: 'bot', at: Date.now(), blocks, source: 'routine' })
      setState((prev) => ({
        ...prev,
        routines: prev.routines.map((item) => {
          if (item.id !== routine.id) return item
          const runs = [...item.runs]
          const last = runs[runs.length - 1]
          if (last !== undefined && last.status === 'running') runs[runs.length - 1] = { ...last, status }
          return { ...item, runs }
        }),
      }))
    })()
  }, [appendMessage])

  const runRoutine = useCallback((id: string): void => {
    const routine = stateRef.current.routines.find((item) => item.id === id)
    if (routine) executeRoutine(routine)
  }, [executeRoutine])

  const deleteRoutine = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, routines: prev.routines.filter((item) => item.id !== id) }))
  }, [])

  const proactiveNow = useCallback((botId: string): void => {
    const bot = stateRef.current.bots.find((item) => item.id === botId)
    if (!bot) return
    /*
     * 真主动：让 agent 自己判断现在有什么值得说，而不是从三句模板里抽一句。
     * 模板只留作降级（宿主不可用 / 模型没返回），保证按钮不会点了没反应。
     */
    void (async () => {
      const prompt = [
        '现在轮到你主动找用户说话。',
        '基于你了解的上下文（你们的对话、你的岗位、你记得的关于用户的事），说一句真正有价值的话：',
        '一个提醒、一个你注意到的变化、或一件需要用户拍板的事。',
        '要求：不要客套，不要说「我在」「有什么可以帮你」，直接说正事。一两句话即可。',
      ].join('\n')
      let blocks: MessageBlock[]
      try {
        const remote = await hostReply(bot, prompt, stateRef.current)
        blocks = remote ?? proactiveMessage(bot)
      } catch {
        blocks = proactiveMessage(bot)
      }
      appendMessage({ id: shortId('msg'), botId, role: 'bot', at: Date.now(), blocks, source: 'proactive' })
      toast(`「${bot.name}」发来一条主动询问`)
    })()
  }, [appendMessage, toast])

  /**
   * 清空某个 bot 的全部对话。
   *
   * 两处都要清，少一处就会出现割裂：
   *  · 前端：删掉这个 bot 的消息（含它在群聊里发的那些）
   *  · 宿主：dispose 活着的 agent + 删会话文件——只清界面的话，bot 下一轮
   *    还会引用旧历史，说出「我们刚才聊的…」这种让人困惑的话
   */
  const clearConversation = useCallback(async (botId: string): Promise<void> => {
    const bot = stateRef.current.bots.find((item) => item.id === botId)
    const label = bot?.name ?? '这个 Bot'

    /*
     * 清空时**立刻写 localStorage**，不等防抖持久化。
     * 否则用户清空后顺手刷新，延迟写入还没落地，旧消息会「复活」——
     * 看起来就像清空没生效。updater 里写是幂等的（React 严格模式重复调用结果一致）。
     */
    setState((prev) => {
      const next = {
        ...prev,
        messages: prev.messages.filter((message) => message.botId !== botId && message.senderId !== botId),
        bots: prev.bots.map((item) => (item.id === botId
          ? { ...item, lastMessage: '', lastAt: undefined, unread: 0 }
          : item)),
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* 配额满：只影响持久化，界面已经清了 */
      }
      return next
    })

    try {
      const res = await fetch('/api/personal-agent/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId }),
      })
      const data = await res.json() as { ok?: boolean; error?: string; removed?: number }
      if (data.ok === false) {
        toast(`界面消息已清空；宿主侧没清干净：${data.error ?? '未知原因'}`)
      } else {
        toast(`已清空「${label}」的全部对话`)
      }
    } catch {
      toast('界面消息已清空（宿主未连接，agent 历史留到下次重启）')
    }

    /*
     * 最后**强制重载页面**。
     *
     * 为什么不只靠 setState：清空是低频的破坏性操作，而这条链路上有防抖持久化、
     * React 批处理、可能的并发写入——任何一个时序没对齐，用户就会看到「点了没清掉」。
     * 重载后界面完全从 localStorage 重建，而 localStorage 在上一行已经写干净了，
     * 所以结果只有一种：消息确实没了。代价只是一次刷新（Bot 模式状态会恢复）。
     */
    window.setTimeout(() => {
      try {
        window.location.reload()
      } catch {
        /* 独立演示页里可能不允许 reload：忽略 */
      }
    }, 260)
  }, [toast])

  const generateJournal = useCallback(async (botId: string, opts: { auto?: boolean; date?: Date } = {}): Promise<Journal> => {
    const journal = buildJournal(stateRef.current, botId, { auto: opts.auto, date: opts.date })
    journal.image = journalCoverSvg(journal)
    setState((prev) => ({ ...prev, journals: [journal, ...prev.journals] }))
    const remote = await hostJournalImage(journal)
    if (remote) {
      journal.image = remote
      setState((prev) => ({ ...prev, journals: prev.journals.map((item) => (item.id === journal.id ? { ...item, image: remote } : item)) }))
    }
    // 主 bot 的会话里放一张期刊卡，便于从对话直接打开
    appendMessage({
      id: shortId('msg'),
      botId,
      role: 'bot',
      at: Date.now(),
      blocks: [{ type: 'journal', journalId: journal.id, title: journal.title, date: journal.dateLabel, image: journal.image, summary: journal.summary }],
      source: 'system',
    })
    if (opts.auto !== true) {
      setUi((prev) => ({ ...prev, journalOpenId: journal.id, view: 'journal' }))
    } else {
      setUi((prev) => ({ ...prev, view: 'chat' }))
    }
    toast(opts.auto === true ? '已自动生成昨天的期刊' : '期刊日记已生成')
    return journal
  }, [appendMessage, toast])

  const runJournalCheck = useCallback((nowOverride?: number): { ok: boolean; reason: string; journalId?: string } => {
    const now = new Date(nowOverride ?? Date.now())
    const rule = stateRef.current.settings.journalRule
    const log = (ok: boolean, reason: string, journalId?: string): { ok: boolean; reason: string; journalId?: string } => {
      setState((prev) => ({
        ...prev,
        journalLogs: [{ at: Date.now(), ok, reason, ...(journalId ? { journalId } : {}) }, ...prev.journalLogs].slice(0, 40),
      }))
      return { ok, reason, journalId }
    }
    if (!rule.enabled) return log(false, '日记规则已关闭')
    const hour = now.getHours()
    if (hour < rule.startHour || hour >= rule.endHour) {
      return log(false, `当前 ${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} 不在 ${rule.startHour}:00–${rule.endHour}:00 触发窗内`)
    }
    const idle = now.getTime() - stateRef.current.lastUserMessageAt
    if (idle < rule.idleMinutes * 60_000) {
      return log(false, `距上次用户主动消息仅 ${Math.max(0, Math.round(idle / 60_000))} 分钟，未满 ${rule.idleMinutes} 分钟`)
    }
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    const dateKey = yesterday.toISOString().slice(0, 10)
    const exists = stateRef.current.journals.find((journal) => journal.botId === MAIN_BOT_ID && journal.date === dateKey)
    if (exists) return log(false, `昨天的日记已生成（${exists.title}）`, exists.id)
    void generateJournal(MAIN_BOT_ID, { auto: true, date: yesterday })
    return log(true, `满足条件：${rule.startHour}:00–${rule.endHour}:00 且已静默 ${Math.round(idle / 60_000)} 分钟，正在生成昨天的期刊`)
  }, [generateJournal])

  const startCall = useCallback((botId: string): void => {
    setUi((prev) => ({
      ...prev,
      call: { status: 'ringing', botId, startedAt: Date.now(), muted: false, speaker: true, minimized: false, liveTurns: [], thinking: false },
    }))
    later(1200, () => setUi((prev) => (prev.call.status === 'ringing' ? { ...prev, call: { ...prev.call, status: 'active' } } : prev)))
  }, [later])

  const endCall = useCallback((): void => {
    const call = uiRef.current.call
    if (call.botId === null || call.status === 'idle') return
    const bot = stateRef.current.bots.find((item) => item.id === call.botId)
    if (!bot) return
    const endedAt = Date.now()
    const durationMs = Math.max(1000, endedAt - call.startedAt)
    const record: CallRecord = {
      id: shortId('call'),
      botId: bot.id,
      startedAt: call.startedAt,
      endedAt,
      durationMs,
      turns: call.liveTurns,
      status: 'ended',
    }
    setState((prev) => ({ ...prev, calls: [...prev.calls, record] }))
    appendMessage({
      id: shortId('msg'),
      botId: bot.id,
      role: 'bot',
      at: endedAt,
      blocks: [{ type: 'call', call: record }],
      source: 'call',
    })
    setUi((prev) => ({ ...prev, call: { status: 'idle', botId: null, startedAt: 0, muted: false, speaker: true, minimized: false, liveTurns: [], thinking: false } }))
    toast(`通话已结束 · ${Math.round(durationMs / 1000)} 秒`)
  }, [appendMessage, toast])

  const callUserTurn = useCallback((text: string): void => {
    const value = text.trim()
    if (value === '') return
    const call = uiRef.current.call
    if (call.botId === null) return
    const bot = stateRef.current.bots.find((item) => item.id === call.botId)
    if (!bot) return
    const at = Date.now()
    setUi((prev) => ({
      ...prev,
      call: {
        ...prev.call,
        thinking: true,
        liveTurns: [...prev.call.liveTurns, { id: shortId('turn'), role: 'user', text: value, at }],
      },
    }))
    // 通话走与聊天相同的真实模型链路；host 不可用时才退回本地短句。
    later(250, () => {
      void (async () => {
        const remote = await hostReply(bot, value, stateRef.current)
        const reply = remote !== null
          ? remote.map((block) => (block.type === 'text' ? block.text : '')).filter((line) => line !== '').join('\n')
          : callReply(bot, value)
        if (uiRef.current.call.status === 'idle') return
        setUi((prev) => ({
          ...prev,
          call: {
            ...prev.call,
            thinking: false,
            liveTurns: [
              ...prev.call.liveTurns,
              { id: shortId('turn'), role: 'bot', text: reply !== '' ? reply : '我在。', at: Date.now() },
            ],
          },
        }))
      })()
    })
  }, [later])

  const setCallMuted = useCallback((muted: boolean): void => {
    setUi((prev) => ({ ...prev, call: { ...prev.call, muted } }))
  }, [])

  const setCallSpeaker = useCallback((speaker: boolean): void => {
    setUi((prev) => ({ ...prev, call: { ...prev.call, speaker } }))
  }, [])

  const minimizeCall = useCallback((minimized: boolean): void => {
    setUi((prev) => ({ ...prev, call: { ...prev.call, minimized } }))
  }, [])

  /* ── 定时调度：每 30 秒跑一次例行任务 + 日记检查 ── */
  useEffect(() => {
    const tick = (): void => {
      const now = Date.now()
      const current = stateRef.current
      for (const routine of current.routines) {
        if (!routine.enabled || routine.nextAt === undefined || routine.nextAt > now) continue
        executeRoutine(routine)
      }
      // 日记只在北京时间凌晨 0–8 点自动检查；页面一直开着时也符合规则
      runJournalCheck()
    }
    const timer = window.setInterval(tick, 30_000)
    return () => window.clearInterval(timer)
  }, [executeRoutine, runJournalCheck])

  const activeBot = useMemo(() => {
    return state.bots.find((bot) => bot.id === ui.selectedBotId) ?? state.bots[0]
  }, [state.bots, ui.selectedBotId])

  const activeRoom = useMemo(() => {
    if (!ui.selectedRoomId) return null
    const room = state.rooms.find((item) => item.id === ui.selectedRoomId)
    if (!room) return null
    return { id: room.id, name: room.name, memberIds: room.memberIds }
  }, [state.rooms, ui.selectedRoomId])

  const activeMessages = useMemo(() => {
    return state.messages
      .filter((message) => (ui.selectedRoomId ? message.roomId === ui.selectedRoomId : message.botId === ui.selectedBotId && !message.roomId))
      .slice(-200)
  }, [state.messages, ui.selectedRoomId, ui.selectedBotId])

  const actions: PersonalActions = useMemo(() => ({
    selectBot,
    selectRoom,
    setView: (view) => setUi((prev) => ({ ...prev, view })),
    setTheme,
    setRightTab: (rightTab) => setUi((prev) => ({ ...prev, rightTab })),
    toggleRightPanel: (open) => setUi((prev) => ({ ...prev, rightPanelOpen: open ?? !prev.rightPanelOpen })),
    openNewBot: (newBotOpen) => setUi((prev) => ({ ...prev, newBotOpen })),
    openGroupSettings: (groupSettingsOpen) => setUi((prev) => ({ ...prev, groupSettingsOpen })),
    openJournal: (journalOpenId) => setUi((prev) => ({ ...prev, journalOpenId, view: journalOpenId ? 'journal' : 'chat' })),
    sendMessage,
    createBot,
    updateBot,
    deleteBot,
    setBotEnabled,
    moveBot,
    createGroup,
    renameGroup,
    deleteGroup,
    createRoom,
    updateRoom,
    deleteRoom,
    answerInteractive,
    recallMessage,
    addMemory,
    deleteMemory,
    createRoutine,
    toggleRoutine,
    runRoutine,
    deleteRoutine,
    proactiveNow,
    generateJournal,
    runJournalCheck,
    startCall,
    endCall,
    callUserTurn,
    setCallMuted,
    setCallSpeaker,
    minimizeCall,
    toast,
    clearUnread,
  }), [
    selectBot, selectRoom, setTheme, sendMessage, createBot, updateBot, deleteBot, setBotEnabled, moveBot,
    createGroup, renameGroup, deleteGroup, createRoom, updateRoom, deleteRoom, answerInteractive,
    recallMessage,
    addMemory, deleteMemory, createRoutine, toggleRoutine, runRoutine, deleteRoutine, proactiveNow, clearConversation,
    generateJournal, runJournalCheck, startCall, endCall, callUserTurn, setCallMuted, setCallSpeaker,
    minimizeCall, toast, clearUnread,
  ])

  const value: PersonalContextValue = useMemo(() => ({
    state,
    ui,
    actions,
    activeBot,
    activeRoom,
    activeMessages,
  }), [state, ui, actions, activeBot, activeRoom, activeMessages])

  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>
}

export function usePersonal(): PersonalContextValue {
  const value = useContext(PersonalContext)
  if (value === null) throw new Error('usePersonal must be used inside <PersonalProvider>')
  return value
}

/** 当前会话是否为群聊。 */
export function useActiveRoom(): { id: string; name: string; memberIds: string[] } | null {
  return usePersonal().activeRoom
}

export { STORAGE_KEY as PERSONAL_STORAGE_KEY }
