/**
 * Personal Agent — Bot 右栏头像的三态推导（纯函数）。
 *
 * 2026-11-05 用户要求 Bot 模式右侧栏资料区的头像也换成与 Work 操作面板同一套
 * 三态透明 WebP 动图（idle / generating / executing），并在切换 Bot / 群聊时
 * 同步变化。这里只回答「当前会话此刻该显示哪一态」，取图与渲染分别由
 * Avatar.tsx（motionState 分支）与 kr-chat/brand-avatar.ts（brandAvatarSrc）负责。
 *
 * 口径（与 Work 卡头一致）：
 *  · idle       —— Bot 已停用，或当前作用域里没有正在跑的消息 / 任务；
 *  · executing  —— 有 pending 的 bot 消息或 running 的任务，且没在调生成能力；
 *  · generating —— 在跑、且 pending 消息里有正在执行的生成类工具调用。
 *
 * 为什么是纯函数：右栏在 store 每次快照变化时都会重算，纯函数便于在脚本里直接
 * 断言，也避免「什么算正在跑」的口径散落到组件里、各处各写一遍。
 */
import type { Bot, Message, TaskRecord } from './types.ts'
import { isGeneratingToolName } from '../kr-chat/plain-language.ts'
import type { SeekerAvatarState } from '../../shared/avatar-assets.ts'

/**
 * 当前作用域里这个 Bot（或这个群聊）该显示哪一态头像。
 *
 * 作用域：
 *  · 群聊（roomId 给定）→ 只认这个群聊的消息 / 任务：群里多个 Bot 共用右栏那块
 *    资料区，此时 activeBot 只是「当前选中的成员」，头像状态应反映**整场群聊**
 *    是否在跑，而不是某个成员的私聊记录；
 *  · 私聊（roomId 未给）→ 只认该 Bot 且不带 roomId 的消息 / 任务（与 store 的
 *    activeMessages 口径一致）。
 *
 * 「正在跑」有两个信号，任一成立即可：pending 的 bot 消息（模型正在流式生成 /
 * 调工具），或任务记录里还有 running 的一轮。两套数据收口有先后，只认一边会
 * 让头像在边界上闪回 idle。
 *
 * @param bot - 当前选中的 Bot（只读 id / enabled）。
 * @param messages - 当前会话的消息（RightPanel 传 activeMessages，已按会话筛过）。
 * @param tasks - 任务记录列表（RightPanel 传 state.tasks）。
 * @param roomId - 群聊 id；私聊时省略。
 * @returns 三态头像状态。
 */
export function botAvatarStateOf(
  bot: Pick<Bot, 'id' | 'enabled'>,
  messages: readonly Message[],
  tasks: readonly TaskRecord[],
  roomId?: string,
): SeekerAvatarState {
  // 停用的 Bot 一律 idle：即使历史里残留 pending 消息，也不该显示「正在干活」。
  if (!bot.enabled) return 'idle'

  const inScope = (item: { botId: string; roomId?: string }): boolean => (
    roomId !== undefined
      ? item.roomId === roomId
      : item.botId === bot.id && item.roomId === undefined
  )

  const activeMessages = messages.filter(inScope)
  const activeTasks = tasks.filter(inScope)

  const hasPendingMessage = activeMessages.some((message) => (
    message.role === 'bot' && message.pending === true
  ))
  const hasRunningTask = activeTasks.some((task) => task.status === 'running')
  if (!hasPendingMessage && !hasRunningTask) return 'idle'

  /*
   * 只有 pending 消息里的**工具块**能回答「在调什么」：run.status === 'running'
   * 才算当前正在执行（已完成 / 失败的工具不算），工具名交给 plain-language 的
   * isGeneratingToolName 判定 —— 与 Work 卡头同源，两处不会各认一套工具。
   */
  const generating = activeMessages.some((message) => (
    message.role === 'bot'
    && message.pending === true
    && message.blocks.some((block) => (
      block.type === 'tool'
      && block.run.status === 'running'
      && isGeneratingToolName(block.run.name)
    ))
  ))

  return generating ? 'generating' : 'executing'
}
