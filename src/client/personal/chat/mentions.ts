/**
 * Personal Agent — 私聊里 `@名字` 的解析（纯函数）。
 *
 * ## 为什么需要
 *
 * 群聊里 @ 由 room-trigger.ts 判定「谁接话」；私聊只有一个 Bot 在跑，@ 就只是
 * 一段普通文本。用户写「@采集 搜一下我的博客」时，谁也不知道被点名的是哪个 bot
 * id，模型只能看到四个字。
 *
 * 这里只做一件事：把正文里的 `@名字` 翻成 `{ id, name }`，随 /reply 带给宿主。
 * 宿主再把它拼成一段上下文（见 host/personal/mentions.ts），模型据此用
 * `coordinate_bots` 派活。**解析不决定行为**——派不派、派给谁仍由主管那轮决定。
 *
 * ## 边界口径（与群聊判定对齐）
 *
 * - 全角 `＠` 同样认；
 * - `@` 与名字之间不允许空格（`@ 小墨` 是排版，不是点名）；
 * - `@` 前面紧贴词字符时不算（`user@example.com` 不会命中名为 example.com 的 Bot）；
 * - 名字互为子串时最长优先（有「小墨」和「小墨助手」时，`@小墨助手` 不该叫出前者）；
 * - 同一段里重复 @ 同一个 Bot 只算一次；一次最多认 3 个（每多一个就是一次完整推理）。
 */
import type { Bot } from '../types.ts'

/** 一个被点名的 Bot。 */
export interface MentionTarget {
  id: string
  name: string
}

/** 一次最多认几个点名（与群聊「一次最多编排 3 位成员」同口径）。 */
const MAX_MENTIONS = 3

/** 可以是 @ 的字符。 */
const AT_CHARS = new Set(['@', '＠'])

/** `@` 前面出现这些字符时不是点名（邮箱 / 版本号 / 路径碎片）。 */
const WORD_BEFORE_AT = /[A-Za-z0-9._%+\-]/

/**
 * 解析一段正文里 @ 了哪些 Bot。
 *
 * targets 传「可被点名的人」（私聊里是除当前对话对象以外的 Bot）。返回按**首次
 * 出现顺序**排，便于宿主按用户点名的先后写好上下文。
 */
export function parseMentions(text: string, targets: readonly Pick<Bot, 'id' | 'name'>[]): MentionTarget[] {
  const source = typeof text === 'string' ? text : ''
  if (source === '' || targets.length === 0) return []
  // 最长优先：先匹配长的，短的再撞上时会被已占用区间挡掉
  const sorted = [...targets]
    .map((item) => ({ id: item.id, name: String(item.name ?? '').trim() }))
    .filter((item) => item.id !== '' && item.name !== '')
    .sort((left, right) => right.name.length - left.name.length)

  const found: Array<{ at: number; target: MentionTarget }> = []
  const used: Array<{ start: number; end: number }> = []
  for (const target of sorted) {
    let from = 0
    while (from < source.length) {
      const hit = source.indexOf(target.name, from)
      if (hit < 0) break
      from = hit + target.name.length
      // @ 紧贴在名字前面
      if (hit === 0 || !AT_CHARS.has(source[hit - 1] ?? '')) continue
      const at = hit - 1
      // @ 自己前面紧贴词字符：user@example.com / a@小墨 这类都不是点名
      if (at > 0 && WORD_BEFORE_AT.test(source[at - 1] ?? '')) continue
      const start = at
      const end = hit + target.name.length
      if (used.some((range) => start < range.end && end > range.start)) continue
      used.push({ start, end })
      if (!found.some((item) => item.target.id === target.id)) found.push({ at: start, target: { id: target.id, name: target.name } })
      if (found.length >= MAX_MENTIONS) return found.sort((left, right) => left.at - right.at).map((item) => item.target)
    }
  }
  // 按出现位置排序：最长优先的遍历顺序不是用户在正文里的书写顺序
  return found.sort((left, right) => left.at - right.at).map((item) => item.target)
}
