/**
 * Personal Agent 的问答通道：把宿主的 `user-questions/request` 接到 Bot 对话里。
 *
 * ## 为什么需要它
 *
 * 模型在需要用户补信息时会调宿主的 `ask_user_question`。这个工具的界面由宿主官方
 * 客户端渲染（Work 模式里的问答卡）——而 Bot 模式是一个**全屏自绘应用**，把官方
 * 界面整个盖住了。结果就是：模型问了一个问题，用户在 Bot 对话里只看到一个转圈的
 * 「...」，真正的问答卡在背后的 Work 界面里，谁也看不见（实测用户报「在 work 里面
 * 出现了问答，应该在 bot 对话里面出现」）。
 *
 * 这里补上那个应答者：把请求变成对话里一张可点击的卡片，用户点完答案回给宿主，
 * `ask_user_question` 照常返回，agent 继续跑。
 *
 * ## 与审批通道的关系
 *
 * 两者是同一个形状（agent-scoped waterfall + 挂起 + 前端卡片回传），所以实现也
 * 刻意保持一致：`qmsg-<id>` 前缀的消息 id、同样的超时语义、同样的 409 失效回包。
 *
 * ## 多问题
 *
 * `ask_user_question` 一次可以带多个问题，但对话里一张卡只能承载一个选择。这里
 * 只把**第一个问题**渲染成可点卡片，其余按宿主约定的「跳过」形态（`selected: []`）
 * 回填——宿主 README 明确说这种条目表示用户跳过，是合法答案。
 */

import { publish } from './events.ts'
import { botRoomOf } from './room-context.ts'
import type { BotMessage } from './agent.ts'

/** 用户不回应时等多久。问答比审批更需要耐心，但也不能把 agent 无限挂住。 */
const QUESTION_TIMEOUT_MS = 10 * 60_000

/** 宿主的一条问题（只取我们渲染需要的字段）。 */
export interface HostQuestion {
  id: string
  question: string
  detail?: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

/** 宿主的答案结构。 */
export interface HostAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

interface PendingQuestion {
  botId: string
  message: BotMessage
  questions: HostQuestion[]
  settle: (answer: HostAnswer) => void
}

const pending = new Map<string, PendingQuestion>()

/** 已注册应答者的 sessionId：避免 agent 重建时重复注册（重复无害但会累积）。 */
const installedSessions = new Set<string>()

/**
 * 构造问答卡片的消息体（纯函数，便于测试）。
 *
 * **只出一个 interactive 块**，不再额外挂一个 text 块：
 * 卡片自带标题 + 正文 + 选项三层（`ui.title` / `block.prompt` / 选项列表），
 * 外面再套一段文本就会变成「文字浮在卡片上」的双层结构（实测被用户说丑）。
 */
export function buildQuestionMessage(
  questionId: string,
  questions: HostQuestion[],
  /**
   * 是否在选项之外再给一个「其他（自己输入）」入口。
   *
   * 问答与审批走同一套卡片结构，但**语义完全不同**：审批问的是「准不准」，
   * 只有允许 / 拒绝两种答案，多给一个自由输入框等于把授权风险交给一句随手打的
   * 文字；问答问的是「你说的是哪一个」，模型的选项永远覆盖不全用户脑子里的答案。
   * 所以默认开、审批显式关。
   */
  allowCustom = true,
): BotMessage {
  const first = questions[0]
  const head = first.header !== undefined && first.header !== '' ? first.header : '需要你确认'
  const detail = first.detail !== undefined && first.detail !== '' ? `\n\n${first.detail}` : ''
  const extra = questions.length > 1 ? `\n\n另有 ${questions.length - 1} 个问题，回答后继续。` : ''
  const options = (first.options ?? []).map((option) => ({
    id: option.label,
    label: option.label,
    ...(option.description !== undefined ? { description: option.description } : {}),
  }))
  const hasOptions = options.length > 0
  return {
    id: `qmsg-${questionId}`,
    kind: 'need-input',
    blocks: [
      {
        type: 'interactive',
        prompt: `${first.question}${detail}${extra}`,
        ui: hasOptions
          /*
           * 有选项时用 `options`（竖向列表）而不是 `buttons`（一排药丸）：
           * 模型给的选项文案通常偏长，横向排列会换行成一堆碎块，竖向列表
           * 才是可读的形态。单选点一下即提交。
           *
           * allowCustom 打开「其他（自己输入）」：模型列的三个选项经常是它猜的
           * 方向，用户真正想说的往往不在里面。宿主答案结构本来就带 `custom`
           * （单选覆盖、多选补充），SPEC 6.4.2 也写明了这个形态——这里只是把
           * 它在 Bot 自绘卡上真正打开（此前一直是关的，卡片只有选项可点）。
           */
          ? { kind: 'options', title: head, options, ...(allowCustom ? { allowCustom: true } : {}) }
          /*
           * 没有选项：以前只给一个「知道了」，点下去等于告诉模型「用户答了知道了」，
           * 而开放问题（「你的项目叫什么？」）根本没有可答之处。现在同样走 options
           * 形态、选项为空 + allowCustom，前端看到空选项会把输入框直接展开。
           * 审批不允许自定义，退回到只能点的「知道了」。
           */
          : allowCustom
            ? { kind: 'options', title: head, options: [], allowCustom: true }
            : { kind: 'buttons', title: head, options: [{ id: '知道了', label: '知道了' }] },
      },
    ],
    at: Date.now(),
  }
}

/**
 * Bot 自己的审批：挂起等用户点「允许 / 拒绝」。
 *
 * 宿主的 `approval/request` 是全局 waterfall，请求会被转成 Work 界面的卡片——
 * Bot 看不见。所以审批档位的 bot 改成走这条：模型调
 * `bot_emit(kind='approval')` → 这里挂起 → 用户点 → 结果回给模型决定下一步。
 *
 * @returns `allowed` 才继续；拒绝、超时、跳过都算 `rejected`（安全侧默认）。
 */
export function requestApprovalPick(botId: string, text: string): Promise<'allowed' | 'rejected'> {
  const questions: HostQuestion[] = [{
    id: 'approval',
    question: text,
    options: [{ label: '允许' }, { label: '拒绝' }],
  }]
  // 审批是「准不准」：只给允许 / 拒绝，不给自由输入（见 buildQuestionMessage 的 allowCustom）。
  return requestQuestion(botId, questions, undefined, false).then((answer) => {
    const first = answer.answers[0]
    const picked = first?.custom !== undefined && first.custom !== ''
      ? first.custom
      : (first?.selected[0] ?? '')
    return picked === '允许' ? 'allowed' as const : 'rejected' as const
  })
}

/**
 * 让模型用 `bot_emit(kind='need-input')` 发起一次提问，挂起等用户点选。
 *
 * 复用问答通道的整套机制（消息构造、`qmsg-` 前缀、前端回传、超时跳过），只是
 * 入口从**宿主的 user-questions 服务**换成了 **Bot 自己的工具**——这样请求从头到尾
 * 不出 Bot 的对话流，不会像以前那样被 typertGateway 转成 Work 界面上的卡片。
 *
 * @returns 用户选中的文案；跳过 / 超时返回空串。
 */
export function requestPick(botId: string, text: string, options: string[]): Promise<string> {
  const questions: HostQuestion[] = [{
    id: 'pick',
    question: text,
    ...(options.length > 0 ? { options: options.map((label) => ({ label })) } : {}),
  }]
  return requestQuestion(botId, questions).then((answer) => {
    const first = answer.answers[0]
    if (first === undefined) return ''
    return first.custom !== undefined && first.custom !== '' ? first.custom : first.selected.join('、')
  })
}

/**
 * 发起一次问答：推一张卡片给前端，挂起等用户点选。
 *
 * 返回 Promise 而不是回调，是因为宿主的 seam 就是 `Promise<AskUserQuestionAnswer>`；
 * 挂起期间 `ask_user_question` 那一轮会一直等着（这正是「提问」的语义）。
 */
export function requestQuestion(
  botId: string,
  questions: HostQuestion[],
  signal?: AbortSignal,
  allowCustom = true,
): Promise<HostAnswer> {
  if (questions.length === 0) {
    return Promise.resolve({ answers: [] })
  }
  const questionId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const message = buildQuestionMessage(questionId, questions, allowCustom)
  /*
   * 带上所属群：问答卡同样由宿主异步发，不带 roomId 就落进私聊，群里那个
   * 回复气泡会一直转圈。展开写法让私聊回合真的不带这个键。
   */
  const roomId = botRoomOf(botId)
  publish(botId, { type: 'message', message, source: 'question', ...(roomId !== undefined ? { roomId } : {}) })

  return new Promise<HostAnswer>((resolve) => {
    let settled = false
    /** 跳过形态：宿主约定 `selected: []` 表示用户没答这一条。 */
    const skipAll = (): HostAnswer => ({
      answers: questions.map((item, index) => ({ id: item.id, selected: index === 0 ? [] : [] })),
    })
    const finish = (answer: HostAnswer): void => {
      if (settled) return
      settled = true
      pending.delete(questionId)
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      /*
       * 把卡片标成已回答：不改的话用户会看到一个还在闪的按钮组，不知道
       * 自己刚才那一下到底生效没有。
       */
      const answered = answer.answers.find((item) => item.selected.length > 0 || item.custom !== undefined)
      /*
       * 回显要同时保留「勾了哪几项」和「自己打了什么」：单选自定义时 selected 为空、
       * 只有 custom；多选则是两者都有。此前只取 custom ?? selected，多选一填自定义
       * 就把勾选项整段吞掉，用户回看时看不到自己选了什么。
       */
      const decidedParts: string[] = []
      if (answered !== undefined) {
        decidedParts.push(...answered.selected)
        if (answered.custom !== undefined && answered.custom.trim() !== '') decidedParts.push(answered.custom.trim())
      }
      const decided: BotMessage = {
        ...message,
        blocks: message.blocks.map((block) => (
          block.type === 'interactive'
            ? {
              ...block,
              submitted: true,
              result: decidedParts.length > 0 ? decidedParts.join('、') : '已跳过',
            }
            : block
        )),
        at: Date.now(),
      }
      // 更新也必须带同一个 roomId：否则前端找不到原来那张卡，点完还是转圈
      publish(botId, { type: 'message-update', message: decided, source: 'question', ...(roomId !== undefined ? { roomId } : {}) })
      resolve(answer)
    }
    const timer = setTimeout(() => finish(skipAll()), QUESTION_TIMEOUT_MS)
    // 不把 Node 事件循环钉住（宿主常驻时无所谓，测试会退不出去）
    timer.unref?.()
    const onAbort = (): void => finish(skipAll())
    signal?.addEventListener?.('abort', onAbort)
    pending.set(questionId, { botId, message, questions, settle: finish })
  })
}

/**
 * 用户点了某个选项。
 *
 * @returns 是否命中一个仍在挂起的问题（false = 已超时 / 已取消 / id 不对）。
 */
export function answerQuestion(questionId: string, selected: string[], custom?: string): boolean {
  const entry = pending.get(questionId)
  if (entry === undefined) return false
  /*
   * 只答第一个问题；其余按「跳过」回填（宿主 README 说这是合法答案形态）。
   * 多问题的完整交互留待以后——现在先把「看得见、点得动」这件事做对。
   */
  const answers = entry.questions.map((item, index) => (
    index === 0
      ? { id: item.id, selected, ...(custom !== undefined && custom !== '' ? { custom } : {}) }
      : { id: item.id, selected: [] }
  ))
  entry.settle({ answers })
  return true
}

/** 当前挂起的问题数（诊断用）。 */
export function pendingQuestionCount(): number {
  return pending.size
}

/**
 * 把问答应答者挂上。
 *
 * ## 为什么注册在 root ctx 且必须 prepend
 *
 * 宿主的 `typertGateway` 会在同一条 waterfall 上把请求**转成 Remote 事件发给浏览器**
 * ——Work 模式里那张官方问答卡就是这么来的。插件加载得比它晚，普通注册永远排在它
 * 后面，请求先被 gateway 接走，我们就再也看不到（这正是「问答卡长在 Work 界面、
 * Bot 对话里只剩转圈」的原因）。
 *
 * 所以：注册在 root ctx（scope 不受限）+ `prepend` 排到最前 + 在 handler 里按
 * sessionId 认领自己的 bot。不是自己的请求一律 `next()` 交还给后面的应答者。
 */
export function installBotQuestions(rootCtx: any, sessionId: string, botId: string): void {
  if (typeof rootCtx?.on !== 'function') return
  if (installedSessions.has(sessionId)) return
  try {
    rootCtx.on('user-questions/request', async (request: any, next: () => Promise<HostAnswer>) => {
      // 不是这个 bot 的请求：交还给 gateway / 别的 bot 的应答者
      if (String(request?.agent?.session?.id ?? '') !== sessionId) return next()
      /*
       * 不调 next()：我们是这个 bot 的最终应答者。委托出去会落到 typert gateway
       * → Work 模式的官方 UI，而那个界面在 Bot 模式下被全屏盖住了。
       */
      const questions: HostQuestion[] = Array.isArray(request?.questions)
        ? request.questions
          .filter((item: any) => item !== null && typeof item === 'object' && typeof item.question === 'string')
          .map((item: any, index: number) => ({
            id: typeof item.id === 'string' && item.id !== '' ? item.id : `q${index}`,
            question: String(item.question),
            ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
            ...(typeof item.header === 'string' ? { header: item.header } : {}),
            ...(Array.isArray(item.options)
              ? {
                options: item.options
                  .filter((option: any) => option !== null && typeof option === 'object' && typeof option.label === 'string')
                  .map((option: any) => ({
                    label: String(option.label),
                    ...(typeof option.description === 'string' ? { description: option.description } : {}),
                  })),
              }
              : {}),
            ...(item.multiSelect === true ? { multiSelect: true } : {}),
          }))
        : []
      return requestQuestion(botId, questions, request?.signal)
    }, {
      /*
       * prepend：排到最前，抢在宿主的 typertGateway 之前。
       * global：绕过 context filter —— 这条最关键，agent scope 的 filter 判定
       *   一旦不匹配，普通监听器会静默收不到请求，而 global 让它无条件参与。
       */
      prepend: true,
      global: true,
    })
    installedSessions.add(sessionId)
  } catch (error) {
    console.warn('[personal-agent] 问答应答者注册失败（Bot 里的提问会落到看不见的 Work 界面）:', error instanceof Error ? error.message : error)
  }
}
