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

/**
 * 贴纸分组。
 *
 *  · `chibi` —— Q 版角色的成套情绪（透明底 PNG），有表情、有角色、有画面，
 *    聊天里最先被选中的一组；
 *  · `zh`   —— 中文语境梗（CJK 方框字符与中文语义稳定的动物食物）；
 *  · `en`   —— 通用英文反应。
 */
export type StickerGroup = 'chibi' | 'zh' | 'en'

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
  // ── Q 版情绪（OpenGameArt · eysselia「chibi emotions」· CC0 · 透明底 PNG）──
  // 同一角色 Aranel 的九种情绪，成套出现才有「这个人」的感觉，别拆散。
  { id: 'chibi-angry', file: 'chibi-angry.png', mime: 'image/png', group: 'chibi', alt: '气到炸', tags: ['生气', '炸毛', '恼'], license: 'CC0-1.0' },
  { id: 'chibi-angry2', file: 'chibi-angry2.png', mime: 'image/png', group: 'chibi', alt: '气鼓鼓', tags: ['生气', '不服', '嘟嘴'], license: 'CC0-1.0' },
  { id: 'chibi-happy', file: 'chibi-happy.png', mime: 'image/png', group: 'chibi', alt: '开心', tags: ['开心', '笑', '好耶'], license: 'CC0-1.0' },
  { id: 'chibi-happy2', file: 'chibi-happy2.png', mime: 'image/png', group: 'chibi', alt: '偷笑', tags: ['开心', '偷笑', '得意'], license: 'CC0-1.0' },
  { id: 'chibi-heh', file: 'chibi-heh.png', mime: 'image/png', group: 'chibi', alt: '呃…', tags: ['尴尬', '犹豫', '试探'], license: 'CC0-1.0' },
  { id: 'chibi-neutral', file: 'chibi-neutral.png', mime: 'image/png', group: 'chibi', alt: '面无表情', tags: ['平静', '无语', '看戏'], license: 'CC0-1.0' },
  { id: 'chibi-oops', file: 'chibi-oops.png', mime: 'image/png', group: 'chibi', alt: '糟了', tags: ['糟糕', '心虚', '失误'], license: 'CC0-1.0' },
  { id: 'chibi-sad', file: 'chibi-sad.png', mime: 'image/png', group: 'chibi', alt: '难过', tags: ['难过', '委屈', '求安慰'], license: 'CC0-1.0' },
  { id: 'chibi-shock', file: 'chibi-shock.png', mime: 'image/png', group: 'chibi', alt: '震惊', tags: ['震惊', '懵', '不敢信'], license: 'CC0-1.0' },
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
  // 顺序就是推荐优先级：Q 版情绪排第一，模型会先在这组里挑。
  const groups: Array<{ label: string; group: StickerGroup }> = [
    { label: 'Q 版情绪（有角色、有表情，优先用这组）', group: 'chibi' },
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
