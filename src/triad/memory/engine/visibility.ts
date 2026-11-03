/**
 * 记忆可见性：谁读得到、谁只读得到自己。
 *
 * ## 为什么需要单独一层
 *
 * 归属（`MemoryEntry.owner`）回答的是「这条记忆属于谁」，可见性回答的是
 * 「当前这个会话能读哪些」。两者不能混：主 Bot 需要读到所有子 Bot 的记忆，
 * 但它写下的东西仍然只属于自己——把可见性做成归属的派生，会逼着调用方
 * 去改 owner 才能共享，那等于把隔离拆掉。
 *
 * ## 两条不同口径
 *
 * - `canInject()`：自动注入用，**保守**。每轮都进上下文的东西必须与当前任务
 *   强相关，否则主 Bot 会把一堆别的 Bot 的闲聊塞进每次请求。
 * - `canSearch()`：`memory_search` 工具用，**开放**。用户/模型明确在找东西时，
 *   范围越大越好；这里放开不会污染上下文，因为结果不会自动进历史。
 *
 * ## 各身份的可见范围
 *
 * | 身份 | 自动注入 | 显式检索 |
 * |---|---|---|
 * | Work 会话 | work 的 global + 当前工作区 project | 同左 |
 * | 子 Bot | 自己的（global + 本工作区 project）+ work 的 global | 同左 |
 * | 主 Bot | **自己的**（global + 本工作区 project）+ work 的 global | 全部（含各 Bot 与 work 各项目） |
 *
 * 主 Bot 的自动注入**不再**包含全部子 Bot（2026-11 收窄）。原因：所有 Bot 共用
 * 同一个工作目录，`projectHash` 对它们完全相同，`canInject` 里那条「主 Bot 看见
 * 全部子 Bot」等于把每个子 Bot 的全部项目记忆都塞进主 Bot 的每一轮上下文——
 * 别的 Bot 的闲聊、踩坑、半成品任务都会进主 Bot 的 prompt，而主 Bot 并没有
 * 办法从工作区维度过滤掉它们。需要跨 Bot 的场合（用户问「小莫你记得小助说过
 * 什么」）走 `memory_search`，那里 `canSearch` 保持开放。
 *
 * 子 Bot 能读到 work 的 **global** 是有意的：那里存的是用户身份与长期偏好
 * （称呼、语言、禁忌），不继承的话每个 Bot 都会像第一次见面。
 * 但读不到 work 的 **project**——那是别的项目的具体事实，与 Bot 的活无关。
 */

import type { MemoryEntry, MemoryOwner } from '../types.js'
import { ownerOf, ownerOfSessionId } from './store.js'

/**
 * Personal Agent 主 Bot 的固定 id。
 *
 * 与 `src/client/personal/types.ts` 的 `MAIN_BOT_ID` **必须逐字一致**：
 * 前端建主 Bot 用那个常量，host 侧判定「谁是主 Bot」用这个。两处漂移会让
 * 主 Bot 退化成普通子 Bot（看不到其他 Bot 的记忆），而且不会报错。
 */
export const MAIN_BOT_ID = 'bot-main-xiaomo'

export interface MemoryVisibility {
  /** 当前会话自己的归属（写入永远只落这里）。 */
  self: MemoryOwner
  /** 是否主 Bot。 */
  isMain: boolean
  /** 当前工作区的 projectHash（null = 判定失败）。 */
  hash: string | null
  /** 自动注入口径（保守）。 */
  canInject: (entry: MemoryEntry) => boolean
  /** 显式检索口径（开放）。 */
  canSearch: (entry: MemoryEntry) => boolean
}

/**
 * 按会话身份构造可见性。
 *
 * @param sessionId 当前会话 id（`pa-bot-v2-<botId>` 或普通 Work 会话 id）。
 * @param hash      当前工作区的 projectHash。
 */
export function visibilityFor(sessionId: string, hash: string | null): MemoryVisibility {
  const self = ownerOfSessionId(sessionId)
  const isMain = self === `bot:${MAIN_BOT_ID}`

  /** 条目的 scope/project 是否落在当前工作区（global 恒成立）。 */
  const inWorkspace = (entry: MemoryEntry): boolean =>
    entry.scope === 'global' || (hash !== null && entry.projectHash === hash)

  const canInject = (entry: MemoryEntry): boolean => {
    const owner = ownerOf(entry)
    // 自己写的：全局层与当前工作区都算「自己的地盘」。
    if (owner === self) return inWorkspace(entry)
    // 主 Bot 额外看见全部子 Bot —— **只用于显式检索**（见 canSearch）。
    // 自动注入不再走这条路：理由见模块头「各身份的可见范围」。
    // 任何 Bot 都继承 Work 的全局层（身份/偏好），但不碰 Work 的项目层。
    if (self.startsWith('bot:') && owner === 'work') return entry.scope === 'global'
    // Work 会话：只看 work 自己的，且项目必须匹配当前工作区。
    if (self === 'work' && owner === 'work') return inWorkspace(entry)
    return false
  }

  const canSearch = (entry: MemoryEntry): boolean => {
    // 主 Bot 是全库管家：显式检索时不设限（含 work 各项目）。
    if (isMain) return true
    return canInject(entry)
  }

  return { self, isMain, hash, canInject, canSearch }
}
