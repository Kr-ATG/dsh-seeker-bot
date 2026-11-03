/**
 * 群聊「谁该接话」的判定（纯函数，不依赖 React / 宿主）。
 *
 * ## 为什么单独成一个模块
 *
 * 原来的判定写在 store 的 sendMessage 里，是一句 `value.includes(bot.name)`：
 * 正文里**任何位置**出现成员名就算被点名。后果有三种，用户都能直接感到：
 *
 *  - 「我记得小墨说过…」会把小墨叫出来回话（它并没有被叫）；
 *  - 成员名互为子串时（「小墨」与「小墨助手」）一次文本可以同时命中两个成员；
 *  - 两者叠加后，判定结果与用户实际想找谁几乎无关。
 *
 * 判定规则是群聊里最容易错、又最难在界面上观察到的一块，抽成纯函数才能被测试覆盖。
 *
 * ## 判定顺序（命中即停）
 *
 *  1. `@所有人` 一类的广播词 → 全员；
 *  2. 结构化 `@名字` → 只叫被点名的，按点名出现的顺序；
 *  3. 委托意图（「让 / 请 / 叫 / 找 / 交给 …」+ 成员名）→ 只叫被委托的那个；
 *  4. 以上都没有 → 群主（管理员）兜底接话。
 *
 * 顺序不能反：前三档都是**用户已经表达出来**的确定性意图，只有第四档才是系统猜。
 * 先让模型判断「他大概想找谁」、再看有没有 `@`，等于把确定信息丢掉再用猜测重建。
 */

/** 判定只需要这两样，Bot 结构天然满足它（不 import Bot 以保持与本项目的类型解耦）。 */
export interface RoomMember {
  id: string
  name: string
}

/** 谁被编排进来了，以及是依据哪一档规则。 */
export type RoomTriggerKind = 'all' | 'mention' | 'quote' | 'delegate' | 'admin'

export interface RoomTriggerResult<M extends RoomMember> {
  kind: RoomTriggerKind
  /** 需要起回复的成员（已去重、保持点名顺序）。 */
  responders: M[]
  /**
   * 命中规则、但被上限挤掉的成员。
   *
   * 必须交还给调用方去提示用户：原来的实现是 `mentioned.slice(0, 2)` 静默截断，
   * 第 3 个被 `@` 的成员永远不回复，用户只会以为它坏了。
   */
  overflow: M[]
}

export interface RoomTriggerOptions<M extends RoomMember> {
  text: string
  members: M[]
  /** 群主 / 管理员：没人被点名时由它兜底。缺省取 members[0]（沿用「数组第一项是群主」的老约定）。 */
  adminId?: string
  /**
   * 用户引用了某条 Bot 消息时，被引用消息的发送者 id。
   *
   * 点「回复」是界面上最明确的一次「这条是问你」——比正文里推断委托词可靠，
   * 所以排在 @ 之后、委托之前。被引用的人已经退群时按没引用处理（不报错）。
   */
  quotedBotId?: string
  /** 一次最多编排多少人回复。每条回复都是一次完整的模型推理，默认 3。 */
  mentionLimit?: number
}

/**
 * 广播词。
 *
 * 只认**带 `@` 前缀**的这几种写法：正文里出现「所有人」三个字（比如
 * 「所有人都看得出来这个方案有问题」）不该被当成一次全员广播。
 */
const BROADCAST_WORDS = ['所有人', '全体成员', '全体', 'all', 'everyone']

/**
 * 紧贴 `@` 前后出现这些字符时，这个 `@` 多半不是点名。
 *
 * 用来放过 `user@example.com`、`@2x` 这类正文里的写法——它们被当成点名会把
 * 一个毫不相干的成员叫出来。
 */
const WORD_CHAR = /[A-Za-z0-9_.\-]/

/**
 * 委托词。
 *
 * 用户不打 `@` 也常用「让小墨看一下」这种说法。只在委托词**紧邻**成员名时才算
 * 点名，否则「我请了半天假」这类句子会因为含一个「请」字就把成员叫出来。
 */
const DELEGATE_WORDS = ['让', '请', '叫', '找', '交给', '派给', '由']

/** 把成员名里的正则元字符转义掉：名字是用户填的，可能是「小墨(测试)」这种带括号的。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `@` 的后一个字符位置上的字符不是「词字符」时，才算名字到此为止。 */
function tailOk(text: string, index: number): boolean {
  const ch = text[index]
  return ch === undefined || !WORD_CHAR.test(ch)
}

/** `@` 的前一个字符不是「词字符」时，才算这个 `@` 是独立出现的。 */
function headOk(text: string, index: number): boolean {
  const ch = index > 0 ? text[index - 1] : undefined
  return ch === undefined || !WORD_CHAR.test(ch)
}

/**
 * `@` 后面紧跟 ASCII 数字时，这多半不是点名。
 *
 * 设计稿里的倍率写法（`@2x`、`@3x`）、以及 `@2x 的图` 这类正文，都可能撞上
 * 「名字恰好以数字开头」的成员。人不会用 `@` 去叫一个以数字开头的名字，
 * 这条判据只丢极少见的合法用法，换来的是不误伤。
 */
function numericAfterAt(text: string, at: number): boolean {
  const ch = text[at + 1]
  return ch !== undefined && ch >= '0' && ch <= '9'
}

/** 某个位置是否紧跟着一个广播词（且词尾是干净的边界）。 */
function isBroadcastAt(text: string, at: number): boolean {
  for (const word of BROADCAST_WORDS) {
    if (text.startsWith(word, at) && tailOk(text, at + word.length)) return true
  }
  return false
}

/**
 * 从 `at`（`@` 所在下标）往后匹配一个成员名。
 *
 * **最长优先**：成员「小墨」与「小墨助手」同时存在时，`@小墨助手` 只能命中后者。
 * 按数组顺序逐个试会先撞上更短的「小墨」，这正是原来那版判定在子串上出错的原因。
 */
function memberAt<M extends RoomMember>(text: string, at: number, members: M[]): M | undefined {
  let hit: M | undefined
  for (const member of members) {
    if (member.name === '') continue
    if (!text.startsWith(member.name, at + 1)) continue
    if (!tailOk(text, at + 1 + member.name.length)) continue
    if (hit === undefined || member.name.length > hit.name.length) hit = member
  }
  return hit
}

/** 扫描全文里的 `@`，返回命中的成员（按出现顺序去重）。同时报告是否出现了广播词。 */
function scanAt<M extends RoomMember>(text: string, members: M[]): { direct: M[]; broadcast: boolean } {
  const direct: M[] = []
  let broadcast = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    // 全角 ＠ 也认：用户从中文输入法打出来的经常是这个
    if (ch !== '@' && ch !== '＠') continue
    if (!headOk(text, i)) continue
    if (numericAfterAt(text, i)) continue
    if (isBroadcastAt(text, i + 1)) {
      broadcast = true
      continue
    }
    const member = memberAt(text, i, members)
    if (member === undefined) continue
    if (!direct.some((item) => item.id === member.id)) direct.push(member)
  }
  return { direct, broadcast }
}

/**
 * 委托意图：委托词紧邻成员名。
 *
 * 与 `@` 判定分开写，是因为它们的失败模式不同——`@` 的误判来自正文里随口提到
 * 名字，委托意图的误判来自正文里出现「请 / 让」这些常用字，所以都要求紧邻。
 */
function scanDelegate<M extends RoomMember>(text: string, members: M[]): M[] {
  const hit: M[] = []
  for (const member of members) {
    if (member.name === '') continue
    for (const word of DELEGATE_WORDS) {
      /*
       * 委托词后面允许隔一个空格或标点（「让 小墨」「让小墨，」都算），
       * 但不允许隔字：隔字就变成「我让小墨的同事看一下」这种转述。
       */
      const pattern = new RegExp(`${word}[\\s，,、:：]?${escapeRegExp(member.name)}`, 'gu')
      /*
       * 逐个匹配位置验词尾边界：全文里可能前一处「让小墨」是转述、后一处才是真委托
       * （「我让小墨的同事看一下，让小墨自己来定」），只看第一处会把真委托漏掉。
       */
      let confirmed = false
      for (const match of text.matchAll(pattern)) {
        const end = (match.index ?? 0) + match[0].length
        if (!tailOk(text, end)) continue
        /*
         * 「让小墨的同事看一下」是转述，不是委托。
         *
         * 中文没有词边界，「让小墨看一下」与「让小墨的同事看一下」在字符层面都是
         * 「让小墨 + 汉字」，只能在『的』上分：领属标记是中文里最可靠的转述信号。
         * 这是启发式而不是语法分析——它只挡最常见的转述形态；`@` 分支不加这条，
         * 因为用户亲手打了 `@` 本就是要叫人。
         */
        if (text[end] === '的') continue
        confirmed = true
        break
      }
      if (!confirmed) continue
      if (!hit.some((item) => item.id === member.id)) hit.push(member)
      break
    }
  }
  return hit
}

/**
 * 判定这一条群消息该由谁接话。
 *
 * @returns responders 为空数组表示「群里没有任何可用的成员」——调用方要给出可见
 *   提示，而不是静默丢弃（原实现的静默返回会让用户以为消息发出去了）。
 */
export function resolveRoomTrigger<M extends RoomMember>(options: RoomTriggerOptions<M>): RoomTriggerResult<M> {
  const { text, members } = options
  const limit = options.mentionLimit ?? 3
  const admin = members.find((item) => item.id === options.adminId) ?? members[0]

  if (members.length === 0) return { kind: 'admin', responders: [], overflow: [] }

  const trimmed = typeof text === 'string' ? text : ''
  const { direct, broadcast } = scanAt(trimmed, members)

  if (broadcast) {
    // 广播是用户**显式**要求全员接话：不受点名上限约束（上限只约束逐个 @ 的场景）
    return { kind: 'all', responders: members.slice(), overflow: [] }
  }
  if (direct.length > 0) {
    return {
      kind: 'mention',
      responders: direct.slice(0, limit),
      overflow: direct.slice(limit),
    }
  }
  /*
   * 引用回复：只叫被引用的那个成员。
   *
   * 排在 @ 之后，是因为用户既点了引用又在正文里 @ 了别人时，@ 是更晚、更明确的
   * 一次选择；排在委托之前，是因为点「回复」是 UI 动作，不靠中文推断。
   */
  const quoted = options.quotedBotId !== undefined && options.quotedBotId !== ''
    ? members.find((item) => item.id === options.quotedBotId)
    : undefined
  if (quoted !== undefined) {
    return { kind: 'quote', responders: [quoted], overflow: [] }
  }
  const delegated = scanDelegate(trimmed, members)
  if (delegated.length > 0) {
    return {
      kind: 'delegate',
      responders: delegated.slice(0, limit),
      overflow: delegated.slice(limit),
    }
  }
  /*
   * 兜底：只叫群主。
   *
   * 这里刻意不叫「全员」——每多一个发言人就是一次完整的模型推理与一整段上下文，
   * 而用户并没有要求。群主接住之后如果确实需要别人，它自己会派活（主 Bot 有
   * coordinate_bots / 建子 Bot 的权限）。
   */
  return {
    kind: 'admin',
    responders: admin !== undefined ? [admin] : [],
    overflow: [],
  }
}
