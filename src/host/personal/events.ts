/**
 * Personal Agent 的服务端事件总线。
 *
 * ## 为什么需要它
 *
 * 改造前，bot 只会在「用户发了一条消息」这一轮里说话——消息是 `/reply/stream`
 * 这个 HTTP 响应的内容，请求一结束就什么都不剩。DOST 式的 always-on 要求相反的
 * 方向：**服务端在用户没发请求时也能推一条消息过去**（例行任务到点、发现异常、
 * 审批到期）。这必须有一条常驻连接，而常驻连接的前提是服务端先有「事件」这个概念。
 *
 * ## 设计约束
 *
 * - **按 bot 隔离**：前端可能同时开着多个 bot 的窗口，事件不能串台。
 * - **带序号**：断线重连要能补发错过的事件，否则「页面切走两分钟，回来少一条
 *   例行任务结果」。序号在单个 bot 内单调递增。
 * - **有界缓冲**：每个 bot 只留最近 `HISTORY_LIMIT` 条。这是一个补发窗口，
 *   不是消息存储——权威消息仍在会话日志与前端状态里。
 * - **订阅者出错不影响别人**：一个连接写失败不能中断整轮广播。
 */

import type { JournalRecord } from '../../shared/journal.ts'
import type { BotMessage } from './agent.ts'

/** 服务端推给前端的事件。 */
export type BotEvent =
  | { type: 'message'; botId: string; message: BotMessage; source: string; seq: number; at: number }
  | { type: 'message-update'; botId: string; message: BotMessage; source: string; seq: number; at: number }
  | { type: 'status'; botId: string; status: 'idle' | 'thinking'; seq: number; at: number }
  | { type: 'error'; botId: string; message: string; seq: number; at: number }
  /**
   * 新的一期期刊生成好了（手动触发或调度器自动触发）。
   *
   * 为什么必须走事件总线：期刊是**宿主异步产出**的——用户点了「生成」之后可以切走，
   * 调度器更是完全在后台跑。没有这条事件，前端只能靠轮询 `/journal/list` 才知道
   * 新刊到了；而调度生成发生在凌晨，用户第二天打开页面时应该直接看到它。
   * `source` 让前端区分「我点的」与「系统写的」（后者要 toast 提醒）。
   */
  | { type: 'journal'; botId: string; journal: JournalRecord; source: 'auto' | 'manual'; seq: number; at: number }
  /**
   * 上下文被压缩了。
   *
   * Bot 会话是终身的（`pa-bot-<botId>`），长对话必然触发宿主 compaction。用户需要
   * 知道「从这里往前的历史已经被摘要替换」，否则会误以为 Bot 还记得全部原文。
   *
   * 走事件总线而不是 `/reply/stream`：压缩可能发生在后台 routine 里，那时未必有
   * 聊天请求在跑；常驻 SSE 才能把这条事件送到已经打开着的页面上。
   */
  | {
      type: 'compaction'
      botId: string
      at: number
      /** 宿主生成的摘要；取不到时为空串。 */
      summary?: string
      /** 被折叠掉的 token 数（宿主提供时才有）。 */
      shadowedTokenCount?: number
      /** 压缩事务失败（历史可能已被截断）。 */
      failed?: boolean
      seq: number
    }
  /**
   * 主 Bot 在对话里建出了一个子 Bot。
   *
   * 为什么必须走事件总线：创建动作发生在**一轮对话内部**，用户界面上的侧栏
   * 归前端管，宿主没法直接改它。没有这条事件，用户只能刷新页面才能看到新 Bot
   * ——而它明明已经被模型「建好了」，还可能在同一条回复里就被派了活。
   *
   * 事件发在**创建者**（主 Bot）的通道上，不是新 Bot 的：新 Bot 的会话此时
   * 还不存在，它自己的通道也没人订阅。
   *
   * 只带身份字段：外观、模型、主动问候这些由前端合并时按自己的默认值补齐
   * （见 `bot-create.ts` 的 `CreatedBotRecord` 说明）。
   */
  | {
      type: 'bot-created'
      botId: string
      bot: {
        id: string
        name: string
        role: string
        description: string
        instructions: string
        groupId?: string
        createdAt: number
        createdBy: string
      }
      /** agent = 主 Bot 在对话里建的；user 留给「用户主动建」这条通道。 */
      source: 'agent' | 'user'
      seq: number
      at: number
    }

/** 每个 bot 保留多少条历史事件用于断线补发。 */
const HISTORY_LIMIT = 200

interface BotChannel {
  seq: number
  history: BotEvent[]
  listeners: Set<(event: BotEvent) => void>
}

const channels = new Map<string, BotChannel>()

/**
 * 订阅**全部 Bot** 的监听者（`botId=*`）。
 *
 * ## 为什么需要这条通道
 *
 * 前端原来是「每个 Bot 一条常驻 SSE」。SSE 是长连接，而浏览器对同一个 origin
 * 的 HTTP/1.1 并发上限只有 **6 条**——4 个 Bot 就吃掉 4 条，再叠上页面自己的
 * 请求；新建 Bot 时前端 effect「关掉全部再建全部」的瞬时翻倍会直接顶破上限，
 * 之后的请求全部排队，整个界面看起来就是「服务断了」（实测踩过：建到第 4 个
 * 子 Bot 就卡死，重启服务能好一阵，再建又卡）。
 *
 * 一条连接订阅全部通道，Bot 数量就和连接数解耦：不管用户建多少个子 Bot，
 * 浏览器都只占一条长连接。
 *
 * 事件本身带 `botId`，前端按它分发即可——所以「合并订阅」不需要另造一套消息格式。
 */
const allListeners = new Set<(event: BotEvent) => void>()

function channelOf(botId: string): BotChannel {
  let channel = channels.get(botId)
  if (channel === undefined) {
    channel = { seq: 0, history: [], listeners: new Set() }
    channels.set(botId, channel)
  }
  return channel
}

/**
 * 发布一条事件。
 *
 * 序号在这里统一分配，调用方不要自己算——两处分配序号迟早会撞。
 */
export function publish(botId: string, payload: Omit<BotEvent, 'botId' | 'seq' | 'at'>): BotEvent {
  const channel = channelOf(botId)
  channel.seq += 1
  const event = { ...payload, botId, seq: channel.seq, at: Date.now() } as BotEvent
  channel.history.push(event)
  if (channel.history.length > HISTORY_LIMIT) {
    channel.history.splice(0, channel.history.length - HISTORY_LIMIT)
  }
  for (const listener of [...channel.listeners]) {
    try {
      listener(event)
    } catch {
      // 单个订阅者写失败（连接已断）不能中断整轮广播
    }
  }
  for (const listener of [...allListeners]) {
    try {
      listener(event)
    } catch {
      /* 同上：合并订阅者的失败同样不能波及别人 */
    }
  }
  return event
}

/**
 * 订阅某个 bot 的事件。
 *
 * @param since 只补发 `seq > since` 的历史事件；缺省 0 表示不补发历史。
 * @returns 取消订阅函数。
 */
export function subscribe(botId: string, listener: (event: BotEvent) => void, since = 0): () => void {
  const channel = channelOf(botId)
  if (since > 0) {
    for (const event of channel.history) {
      if (event.seq <= since) continue
      try {
        listener(event)
      } catch {
        /* 补发失败不影响后续订阅 */
      }
    }
  }
  channel.listeners.add(listener)
  return () => {
    channel.listeners.delete(listener)
  }
}

/**
 * 订阅**全部 Bot**（含此后新建的通道）。
 *
 * 前端只建一条 SSE 用它，替代原来「每个 Bot 一条」的做法（原因见 `allListeners`
 * 的说明）。此后任何 `publish(botId, …)` 都会送到这里，事件自带 `botId`。
 *
 * @param sinceByBot 逐 Bot 的补发游标：`botId → 已收到的最大 seq`。只对**已经存在**
 *   的通道生效——还没发布过事件的 Bot 本来就没有历史，补发无从谈起。
 * @returns 取消订阅函数。
 */
export function subscribeAll(
  listener: (event: BotEvent) => void,
  sinceByBot?: ReadonlyMap<string, number>,
): () => void {
  if (sinceByBot !== undefined && sinceByBot.size > 0) {
    for (const [botId, channel] of channels) {
      const since = sinceByBot.get(botId) ?? 0
      if (since <= 0) continue
      for (const event of channel.history) {
        if (event.seq <= since) continue
        try {
          listener(event)
        } catch {
          /* 补发失败不影响后续订阅 */
        }
      }
    }
  }
  allListeners.add(listener)
  return () => {
    allListeners.delete(listener)
  }
}

/** 当前已分配的序号（前端重连时用来判断「我漏了多少」）。 */
export function currentSeq(botId: string): number {
  return channels.get(botId)?.seq ?? 0
}

/**
 * 解析合并连接的补发游标：`botA:5,botB:3` → `Map{ botA→5, botB→3 }`。
 *
 * 为什么不能沿用单个数字：合并连接覆盖多个通道，而**每个通道的序号是独立**的
 * （各自从 1 开始）。拿一个全局数字去补发，等于拿 A 的进度去截 B 的历史——
 * 要么漏事件，要么重复补。
 *
 * 空串 / 全非法返回 `undefined`（= 不补发），这是首次连接的常态。单个坏片段
 * 跳过而不是整串失败：一个脏 token 不该让整条连接退化成「不补发」。
 */
export function parseSinceByBot(raw: string): Map<string, number> | undefined {
  const map = new Map<string, number>()
  for (const part of String(raw ?? '').split(',')) {
    const index = part.lastIndexOf(':')
    if (index <= 0) continue
    const botId = part.slice(0, index).trim()
    const seq = Number(part.slice(index + 1))
    if (botId === '' || !Number.isFinite(seq) || seq <= 0) continue
    map.set(botId, Math.round(seq))
  }
  return map.size > 0 ? map : undefined
}

/** 测试用：清空全部通道。 */
export function resetChannels(): void {
  channels.clear()
  allListeners.clear()
}
