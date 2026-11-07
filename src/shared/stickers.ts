/**
 * dsh-seeker-bot — 聊天贴纸（表情包）的唯一真相：id 表、URL 约定与解析规则。
 *
 * 背景：Muse（闺蜜位）需要一个「特别爱发表情包」的预设。贴纸不内联进 client 产物
 * （一堆 PNG 会让每个用户冷启动都多背一份体积），而是随包放在 assets/stickers/
 * 下，由 host 的 /api/chat-flow/stickers/* 路由按需吐出，形态与
 * src/avatar/index.ts、src/host/done-pill/sfx.ts 完全同构。
 *
 * 模型怎么「发」贴纸：不新增工具，只在正文里写标记 `[[sticker:<id>]]`。
 * 这样零工具成本、不碰权限体系，前端在渲染前把标记拆成独立的贴纸条。
 * 未知 id 一律**原样保留成文字**（不吞掉模型写的内容），所以任何一个错 id
 * 最坏的结果是多出一行方括号，而不是整段话消失。
 *
 * @module
 */

/** 贴纸路由前缀（host 注册 / client 拼 URL 共用）。 */
export const STICKER_ROUTE = '/api/chat-flow/stickers'

/** 贴纸的语言分组：中文语境梗 / 通用英文反应贴纸。 */
export type StickerGroup = 'zh' | 'en'

/** 一条贴纸的口径：id 是模型唯一要记住的东西，其余都是宿主与前端的事。 */
export interface StickerEntry {
  /** 模型在正文里引用的 id（小写英文 + 连字符，如 `cat-ok`）。 */
  readonly id: string
  /** 随包文件名（assets/stickers/ 下的扁平文件名）。 */
  readonly file: string
  /** MIME：image/png、image/svg+xml、image/webp、image/gif。 */
  readonly mime: string
  /** 中文组 / 英文组。 */
  readonly group: StickerGroup
  /** 无障碍文案与悬停提示（中文，说清这张图表达什么情绪）。 */
  readonly alt: string
  /** 给模型看的语义标签，用来在「什么时候发哪张」上做选择。 */
  readonly tags: readonly string[]
  /** 授权字符串（如 CC-BY-4.0 / CC0-1.0 / Pixabay），随包附原文见 assets/stickers/LICENSES.md。 */
  readonly license: string
}

/**
 * 贴纸清单。
 *
 * 素材来源必须是**可商用**的公开素材（CC0 / CC-BY / CC-BY-SA / Pixabay Content
 * License 等），且**不含人物形象**（真人、人形卡通、动漫角色都不要）。
 * 授权原文与出处逐条记录在 assets/stickers/LICENSES.md。
 */
export const STICKERS: readonly StickerEntry[] = [
  // ── 中文梗（符号 + 动物 + 食物，没有人物形象）─────────────────────────
  { id: 'ke-ok', file: 'ke-ok.svg', mime: 'image/svg+xml', group: 'zh', alt: '「可以」/ 行', tags: ['同意', '行', '好'], license: 'CC-BY-4.0' },
  { id: 'wu-none', file: 'wu-none.svg', mime: 'image/svg+xml', group: 'zh', alt: '「无」→ 无语', tags: ['无语', '没有', '拒绝'], license: 'CC-BY-4.0' },
  { id: 'mi-secret', file: 'mi-secret.svg', mime: 'image/svg+xml', group: 'zh', alt: '嘘 · 说悄悄话', tags: ['秘密', '悄悄话', '八卦'], license: 'CC-BY-4.0' },
  { id: 'zhu-bless', file: 'zhu-bless.svg', mime: 'image/svg+xml', group: 'zh', alt: '祝福 / 恭喜', tags: ['恭喜', '祝福', '生日'], license: 'CC-BY-4.0' },
  { id: 'jin-no', file: 'jin-no.svg', mime: 'image/svg+xml', group: 'zh', alt: '「禁止」→ 达咩', tags: ['不行', '拒绝', '打住'], license: 'CC-BY-4.0' },
  { id: 'ying-open', file: 'ying-open.svg', mime: 'image/svg+xml', group: 'zh', alt: '营业中', tags: ['开工', '在线', '营业'], license: 'CC-BY-4.0' },
  { id: 'fish-slack', file: 'fish-slack.svg', mime: 'image/svg+xml', group: 'zh', alt: '鱼 · 摸鱼', tags: ['摸鱼', '偷懒', '下班'], license: 'CC-BY-4.0' },
  { id: 'lemon-sour', file: 'lemon-sour.svg', mime: 'image/svg+xml', group: 'zh', alt: '柠檬 · 酸了', tags: ['羡慕', '酸', '嫉妒'], license: 'CC-BY-4.0' },
  { id: 'hongbao', file: 'hongbao.svg', mime: 'image/svg+xml', group: 'zh', alt: '红包', tags: ['红包', '打钱', '恭喜发财'], license: 'CC-BY-4.0' },
  { id: 'dog-doge', file: 'dog-doge.svg', mime: 'image/svg+xml', group: 'zh', alt: '狗头保命', tags: ['开玩笑', '狗头', '调侃'], license: 'CC-BY-4.0' },
  { id: 'milktea', file: 'milktea.svg', mime: 'image/svg+xml', group: 'zh', alt: '奶茶续命', tags: ['奶茶', '续命', '休息'], license: 'CC-BY-4.0' },
  { id: 'lotus-chill', file: 'lotus-chill.svg', mime: 'image/svg+xml', group: 'zh', alt: '莲花 · 佛系', tags: ['佛系', '躺平', '淡定'], license: 'CC-BY-4.0' },
  { id: 'panda', file: 'panda.svg', mime: 'image/svg+xml', group: 'zh', alt: '熊猫', tags: ['国宝', '可爱', '憨'], license: 'CC-BY-4.0' },
  // ── 英文反应（通用表情，跨语言可读）──────────────────────────────────
  { id: 'fire-hot', file: 'fire-hot.svg', mime: 'image/svg+xml', group: 'en', alt: '火 · 燃', tags: ['赞', '燃', '厉害'], license: 'CC-BY-4.0' },
  { id: 'hundred', file: 'hundred.svg', mime: 'image/svg+xml', group: 'en', alt: '💯 满分', tags: ['满分', '服气', '赞'], license: 'CC-BY-4.0' },
  { id: 'sparkles', file: 'sparkles.svg', mime: 'image/svg+xml', group: 'en', alt: '闪闪发亮', tags: ['好看', '惊喜', '亮'], license: 'CC-BY-4.0' },
  { id: 'ok', file: 'ok.svg', mime: 'image/svg+xml', group: 'en', alt: 'OK', tags: ['收到', '同意', '行'], license: 'CC-BY-4.0' },
  { id: 'cool', file: 'cool.svg', mime: 'image/svg+xml', group: 'en', alt: 'COOL', tags: ['酷', '帅', '赞'], license: 'CC-BY-4.0' },
  { id: 'new', file: 'new.svg', mime: 'image/svg+xml', group: 'en', alt: 'NEW', tags: ['新', '新品'], license: 'CC-BY-4.0' },
  { id: 'sos', file: 'sos.svg', mime: 'image/svg+xml', group: 'en', alt: 'SOS · 求救', tags: ['救命', '求救', '急'], license: 'CC-BY-4.0' },
  { id: 'frog', file: 'frog.svg', mime: 'image/svg+xml', group: 'en', alt: '蛙 · 尴尬', tags: ['尴尬', '静默', '无语'], license: 'CC-BY-4.0' },
  { id: 'duck', file: 'duck.svg', mime: 'image/svg+xml', group: 'en', alt: '鸭 · 无所谓', tags: ['无所谓', '算了', '呵呵'], license: 'CC-BY-4.0' },
  { id: 'rainbow', file: 'rainbow.svg', mime: 'image/svg+xml', group: 'en', alt: '彩虹', tags: ['好心情', '彩虹', '治愈'], license: 'CC-BY-4.0' },
  { id: 'zzz', file: 'zzz.svg', mime: 'image/svg+xml', group: 'en', alt: '困 · 晚安', tags: ['困', '睡觉', '晚安'], license: 'CC-BY-4.0' },
  { id: 'cat', file: 'cat.svg', mime: 'image/svg+xml', group: 'en', alt: '猫', tags: ['猫', '可爱', '卖萌'], license: 'CC-BY-4.0' },
  { id: 'bomb', file: 'bomb.svg', mime: 'image/svg+xml', group: 'en', alt: '爆炸', tags: ['爆炸', '崩了', '完蛋'], license: 'CC-BY-4.0' },
]

/** id → 条目（O(1) 解析；清单很小但每条消息都要查）。 */
export const STICKER_BY_ID: ReadonlyMap<string, StickerEntry> = new Map(
  STICKERS.map(entry => [entry.id, entry]),
)

/**
 * 贴纸版本号。
 *
 * 只在**素材内容变化**时改它（换图 / 重压）。它只参与 URL 的 query，不改变
 * host 的文件名表；host 路由按 pathname 分发、忽略 query。
 */
export const STICKER_VERSION = '20261107'

/**
 * 某张贴纸的同源 URL。
 * @param id - 贴纸 id。
 * @param version - 缓存版本，默认 {@link STICKER_VERSION}。
 * @returns 可直接塞给 `img.src` 的 URL；id 不存在时返回 null（调用方决定降级）。
 */
export function stickerUrl(id: string, version: string = STICKER_VERSION): string | null {
  const entry = STICKER_BY_ID.get(id)
  if (entry === undefined) return null
  return `${STICKER_ROUTE}/${entry.file}?v=${version}`
}

/**
 * 正文里的贴纸标记正则。
 *
 * 只认「小写英文 + 数字 + 连字符」，长度 1–40：这样模型偶尔写出的
 * `[[sticker:笑死]]` 不会被当成有效标记（中文 id 反而更难稳定复现），
 * 会原样留在正文里，一眼能看出是模型写错了。
 */
export const STICKER_MARK_PATTERN: string = '\\[\\[sticker:([a-z0-9-]{1,40})\\]\\]'

/** 一段正文拆分后的片段：普通文字，或一张贴纸。 */
export type StickerSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'sticker'; readonly entry: StickerEntry }

/**
 * 把一段正文按贴纸标记拆成片段。
 *
 * 三条约定：
 *  · 未知 id → 整段标记**留在 text 片段里**（不丢内容，也不渲染破图）；
 *  · 只有空白的 text 片段会被丢掉，否则气泡里会出现一条空白行；
 *  · 没有标记时原样返回一个 text 片段，调用方可以直接走老路径。
 * @param text - 模型正文（可能含多个 `[[sticker:id]]`）。
 * @returns 按出现顺序排列的片段数组。
 */
export function splitStickerMarks(text: string): StickerSegment[] {
  const pattern = new RegExp(STICKER_MARK_PATTERN, 'g')
  const out: StickerSegment[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const id = match[1] ?? ''
    const entry = STICKER_BY_ID.get(id)
    if (entry === undefined) continue
    const head = text.slice(cursor, match.index)
    if (head.trim() !== '') out.push({ kind: 'text', text: head })
    out.push({ kind: 'sticker', entry })
    cursor = match.index + match[0].length
  }
  const tail = text.slice(cursor)
  if (tail.trim() !== '') out.push({ kind: 'text', text: tail })
  return out
}

/**
 * 给模型看的贴纸清单片段（拼进 system prompt）。
 *
 * 只在 Bot 打开了 `stickerMode` 且清单非空时才注入；清单为空返回空串，
 * 提示词里不会出现一段「你可以用这些贴纸」却没有任何可用 id 的空承诺。
 */
export function buildStickerCatalogPrompt(): string {
  if (STICKERS.length === 0) return ''
  const groups: Array<{ label: string; group: StickerGroup }> = [
    { label: '中文梗', group: 'zh' },
    { label: '英文反应', group: 'en' },
  ]
  const lines: string[] = []
  for (const { label, group } of groups) {
    const items = STICKERS.filter(entry => entry.group === group)
    if (items.length === 0) continue
    lines.push(`### ${label}`)
    for (const entry of items) lines.push(`- ${entry.id}：${entry.alt}（${entry.tags.join(' / ')}）`)
  }
  return lines.join('\n')
}
