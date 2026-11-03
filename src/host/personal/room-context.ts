/**
 * Personal Agent — 「一次回合的所属群」的内存登记表。
 *
 * ## 为什么需要它
 *
 * 群聊（Room）里发一条消息会触发若干个成员各自起一轮回复，但**审批卡与问答卡
 * 是宿主侧异步生成的**：它们只知道自己是哪个 `botId` 的，不知道这一轮是群里
 * 发起的。事件总线按 botId 隔离，卡片于是天然落进该 Bot 的私聊；前端按
 * `message.roomId` 归组、群聊视图只认自己那个群，结果那张卡在群里永远不出现——
 * 群里那个回复气泡就一直转圈（聊天内审批 `CHAT_TIMEOUT_MS = 0`，根本不会过期，
 * 用户必须自己翻到那个 Bot 的私聊去应答）。
 *
 * 这个模块补的就是那条缺失的关联：回合入口把请求带来的 `roomId` 记在 botId
 * 名下，卡片发布时再按 botId 取回、补进事件的 `roomId` 字段。
 *
 * ## 口径
 *
 * - 它登记的是**一次回合的所属群**，不是 Bot 的持久配置：同一个 Bot 下一轮换了
 *   群（或者换到私聊）就会被覆盖；
 * - 私聊回合必须**删除登记**、而不是留一个空串：否则后台例行任务要审批时会把
 *   卡片沿用上一轮的群，塞进一个用户没在看的地方；
 * - 只用进程内内存：宿主重启时挂起的回合本来就没了，没有跨重启保留的场景。
 */

const rooms = new Map<string, string>()

/**
 * 登记 / 清除一个 Bot 当前回合的所属群。
 *
 * 传空串或缺省即**删除**登记——调用方不需要先判断「这次是不是群聊」，把
 * `body.roomId` 原样丢进来即可，私聊回合自然会把上一轮留下的群清掉。
 *
 * @param botId  收敛后的稳定 Bot id（`toBotSpec` 的 `spec.botId`）。
 * @param roomId 群聊回合的群 id；私聊（或字段缺失）时不传或传空串。
 */
export function setBotRoom(botId: string, roomId?: string): void {
  const id = String(botId).trim()
  if (id === '') return
  const room = typeof roomId === 'string' ? roomId.trim() : ''
  if (room === '') {
    rooms.delete(id)
    return
  }
  rooms.set(id, room)
}

/** 取一个 Bot 当前回合的所属群；私聊回合或还没登记过时返回 `undefined`。 */
export function botRoomOf(botId: string): string | undefined {
  return rooms.get(String(botId).trim())
}

/** 显式清除登记（Bot 被删除等「这一轮不会再回来」的场景用）。 */
export function clearBotRoom(botId: string): void {
  rooms.delete(String(botId).trim())
}

/* ───────────────────── 群历史 → 上下文块 ───────────────────── */

/** 单条消息最多保留的字符数：够容纳一条完整发言的要点，又不至于一条挤掉整块。 */
const ROOM_MESSAGE_MAX_CHARS = 600

/** 整块上下文最多保留的字符数：群历史每轮都进上下文，必须给 token 成本设硬上限。 */
const ROOM_CONTEXT_MAX_CHARS = 6000

/**
 * 把前端带来的群历史格式化成一段「本群之前的对话」文本。
 *
 * 为什么需要：每个 Bot 只有一条终身会话（`pa-bot-v2-<botId>`），群消息并不在
 * 其中——不把本群最近的发言带进上下文，被 @ 的成员就看不到其他成员说过什么，
 * 「多视角评审」会退化成三个互不知情的单聊。
 *
 * 为什么要说「不是用户二次提问」：这段文本会以 developer 消息的身份紧挨着本轮
 * 用户消息投进去，不点明来源的话模型很容易把它当成用户又追问了一遍，逐条重新
 * 回答历史消息。
 *
 * 返回空串表示没有可注入的内容，调用方不应注入空块。
 */
export function buildRoomContextBlock(history: Array<{ role?: string; text?: string; name?: string }>): string {
  if (!Array.isArray(history) || history.length === 0) return ''
  const lines: string[] = []
  for (const item of history) {
    if (item === null || typeof item !== 'object') continue
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (text === '') continue
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    // role 只有 'user' / 'bot' 两种口径：真人发言统一署名「用户」，
    // Bot 发言优先用前端带来的名字，缺名时退回「Bot」而不是留空。
    const speaker = item.role === 'user' ? '用户' : name !== '' ? name : 'Bot'
    const line = `${speaker}：${text}`
    lines.push(line.length > ROOM_MESSAGE_MAX_CHARS ? `${line.slice(0, ROOM_MESSAGE_MAX_CHARS - 1)}…` : line)
  }
  if (lines.length === 0) return ''
  const header = '【本群之前的对话】以下是本群之前的聊天记录（按时间正序），仅供背景参考；它不是用户二次提问，请不要把它当成需要回复的消息。'
  const full = [header, ...lines].join('\n')
  if (full.length <= ROOM_CONTEXT_MAX_CHARS) return full
  /*
   * 超限时从**最近的**发言往回装：历史是正序的，越靠后离当前越近、参考价值越高；
   * 丢掉的是最早那几条，并在开头明确告知，避免模型把残缺上下文当成全部。
   */
  const kept: string[] = []
  let used = header.length
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (used + 1 + line.length > ROOM_CONTEXT_MAX_CHARS) break
    kept.unshift(line)
    used += 1 + line.length
  }
  const omitted = kept.length < lines.length ? '（更早的消息已省略）' : ''
  if (omitted !== '' && used + 1 + omitted.length <= ROOM_CONTEXT_MAX_CHARS) kept.unshift(omitted)
  return [header, ...kept].join('\n')
}
