/**
 * iu kind: **link**（链接卡 · 一条能点的细长链接条）。
 *
 * ## 为什么需要这张卡
 *
 * Bot 的系统提示词有一条硬约束：**正文里不贴裸 URL**。可用户主动要「给个链接」
 * 「这篇原文在哪」的时候，模型没有别的出口——只能口头描述「你去搜一下」，或者
 * 违规甩一串裸链接。这张卡把链接变成**一张能点的条**：纪律没破，人真的被送到了
 * 目的地。
 *
 * ## 两个半边
 *
 *   · 本文件 = **纯逻辑**（零 React、零 DOM）：parse / initState / fillText /
 *     snapshot / css / doc，host 半身与 client 半身都能 import；
 *   · link.body.tsx = React 体，只被 bodies.ts 收拢。
 *
 * ⚠ 本文件在 host 半身的依赖链上（截图管线 src/shot/card.ts 要调 snapshot），
 * **绝不能 import React**，连 import type 都不行——那会让 host 产物内联第二份
 * React，build.mjs 的 assertHostExternals 会当场失败。
 *
 * ## 五条设计取舍（改之前先读）
 *
 *  1. **url 不合格 → 整卡返回 undefined**（不是钳位、不是兜底）。契约允许 kind
 *     拒绝整张卡、回退成代码块，而这正是这里该做的事：一张点不动的链接卡比没有
 *     更糟——它长得像能点，点下去什么都不发生。所以其它字段一律「尽力钳位」，
 *     只有 url 走「校验不过就整卡作废」。
 *  2. **徽标只用来源首字母**，中性灰底 + currentColor。拿不到 favicon，就不假装
 *     有；也不引任何外链图片——离线 / 无头截图环境会静默失败，只留一个空方块。
 *  3. **徽标的两个半边必须同源**：hostOf / initialOf / linkSource 全部导出，Body
 *     与 snapshot 共用同一份。两边各算一套的下场是「同一张卡在对话流与截图里
 *     徽标不一样」——这类漂移一旦发生，肉眼很难发现，只会被用户当成 bug 追问。
 *  4. **snapshot 里不用模板字面量**（一个都没有，连嵌套都没有）：build.mjs 的
 *     静态守卫会扫源码里的模板字面量，注释里一个反引号就能让模板提前闭合、产物
 *     加载即 ReferenceError。这里一律数组 join + 字符串拼接。
 *  5. **数字列走 tabular-nums**：meta 里常带「2026-03 · 8 分钟」这种数字，比例
 *     字体下会左右抖。
 */

import type { IuKind, IuSpecBase, IuState } from './contract.ts'
import { esc, escAttr, str, strOr } from './core.ts'

/** 链接卡 Spec（字段名固定，注入文档与模型输出都按这份来）。 */
export interface IuLinkSpec extends IuSpecBase {
  readonly kind: 'link'
  /**
   * 正文里的大标题（文章 / 页面原本的标题）。
   *
   * 与 `title` 是两个位置：`title` 是**卡片头**那行 11px 小字（"参考文档" /
   * 来源名这类短标签），`heading` 才是正文里的主体标题。两者相同时正文不重复
   * 渲染（见 snapshot / Body 里的 showHeading 判断）——否则同一个标题会在
   * 一张卡上出现两遍，实测一眼就能看出是 bug。
   */
  readonly heading?: string
  /** 必填，只接受 http(s) 绝对地址；不合法时 parse 返回 undefined。 */
  readonly url: string
  /** 来源名（知乎 / GitHub / 官方文档），缺省由 url 的 hostname 推导。 */
  readonly source?: string
  /** 摘要，≤200 字。 */
  readonly summary?: string
  /** 一行元信息：作者 · 日期 · 阅读时长，≤60。 */
  readonly meta?: string
  /** 右上角小标签：官方 / 文档 / 视频 …（≤8 字）。 */
  readonly badge?: string
}

/**
 * 链接卡的本地状态：**无交互**，永远是空对象。
 *
 * 仍然实现 initState / setState 契约：外壳按它的形状做持久化，Body 拿到的是
 * 同一个空对象。不做成 undefined 是为了让「无状态 kind」与有状态 kind 走同一条
 * 外壳代码路径，不在 IuCard 里为它开特例。
 */
export type IuLinkState = IuState

/** URL 上限（字符）。超长的一律当作不合法：截断会让地址变成另一个不存在的页面。 */
const MAX_URL = 2048

/**
 * 右上角箭头（↗）的内联 SVG。
 *
 * 用 path 画、不用字符 ↗：字符箭头在各种字体下行高与基线都不稳定，窄屏上还会被
 * 当成文本截断。这个常量被 Body（dangerouslySetInnerHTML）与 snapshot 共同消费
 * ——两边的箭头只能是同一份字节，不能各写一遍。
 */
export const LINK_ARROW_SVG: string = [
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
  '<path d="M5.4 10.6L10.6 5.4"/>',
  '<path d="M6.4 5.4H10.6V9.6"/>',
  '</svg>',
].join('')

/**
 * 校验并保留链接地址：只接受 **http(s) 绝对地址**。
 *
 * 拒绝的东西（全部返回 undefined）：
 *  · 相对路径 / 裸域名（「github.com」不是合法绝对地址，点不出去）；
 *  · javascript: / data: / vbscript: / file: —— 这些一旦进了 href 就是可执行的
 *    注入面，哪怕外面套了 escAttr 也不该放行；
 *  · 超长地址（> MAX_URL）：截断等于把用户送到 404，比不显示更糟。
 *
 * 通过校验后**原样返回模型的写法**（只去首尾空白），不做 URL 规范化：规范化会把
 * 中文、空格、查询参数重新编码成一串 %E4%B8%AD，用户复制粘贴时认不出来。
 */
export function normalizeLinkUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '' || text.length > MAX_URL) return undefined
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.hostname === '') return undefined
  return text
}

/**
 * 从 URL 取 hostname（去掉开头的 www.）。
 *
 * 解析失败返回空串而不是抛错：这个函数被 Body 与 snapshot 共用，任何一边抛出
 * 都会让整张卡白屏，而它仅用于「来源」的兜底展示。
 */
export function hostOf(url: string | undefined): string {
  const text = (url ?? '').trim()
  if (text === '') return ''
  try {
    return new URL(text).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/**
 * 来源首字母：拉丁字母取大写首字，中文/数字取第一个字，取不到给中点。
 *
 * 规则（Body 与 snapshot 共用，改这里两边同时变）：
 *  · 跳过标点、空白、符号（「The Verge」→ T，「·知乎」→ 知）；
 *  · 按 **code point** 迭代而不是按下标切，emoji / 生僻字不会被劈成半个代理对；
 *  · 大写后再取首字：德语 ß 的 toUpperCase 是 SS，取 S 才不会把方块撑破。
 */
export function initialOf(source: string | undefined): string {
  const text = (source ?? '').trim()
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      const upper = Array.from(ch.toUpperCase())
      return upper[0] ?? ch
    }
  }
  return '·'
}

/**
 * 展示用的来源名：模型显式给的优先，缺省回退到 hostname。
 *
 * Body 与 snapshot **必须**都调这个函数。两处各写一遍 source ?? hostOf(url)
 * 也能跑，但只要以后有人给其中一边补一个 trim，徽标的两半就开始分叉。
 */
export function linkSource(spec: IuLinkSpec): string {
  const explicit = (spec.source ?? '').trim()
  return explicit !== '' ? explicit : hostOf(spec.url)
}

/**
 * 解析围栏 JSON。
 *
 * url 不合格 → undefined（整卡回退代码块）。其它字段一律钳位，绝不因为某个字段
 * 写错就整卡消失——模型多写一个 300 字的 summary 不该让链接一起没掉。
 */
function parse(raw: Record<string, unknown>): IuLinkSpec | undefined {
  const url = normalizeLinkUrl(raw.url ?? raw.href ?? raw.link)
  if (url === undefined) return undefined

  const host = hostOf(url)
  const source = str(raw.source ?? raw.site ?? raw.from, 24) || host
  const summary = str(raw.summary ?? raw.desc, 200) || undefined
  const meta = str(raw.meta ?? raw.info, 60) || undefined
  const badge = str(raw.badge ?? raw.tag, 8) || undefined

  // 卡片头那行 11px 小字：模型给什么用什么，缺省用来源名兜底，再空用 url。
  const title = strOr(raw.title, 60, source || url)
  /*
   * 正文大标题。**缺省回退到 title** —— 老写法（只填 title）照样能用；
   * 两者相同时 snapshot / Body 会让正文跳过标题行，避免同一行字出现两遍。
   */
  const heading = str(raw.heading ?? raw.articleTitle, 80) || title

  return {
    kind: 'link',
    title,
    heading,
    url,
    source,
    ...(summary ? { summary } : {}),
    ...(meta ? { meta } : {}),
    ...(badge ? { badge } : {}),
  }
}

/** 无交互状态。 */
function initState(_spec: IuLinkSpec): IuLinkState {
  return {}
}

/**
 * 回填输入框的可读文本。
 *
 * **必须带完整 URL**：这张卡的唯一价值就是把人送到链接；回填出去的文本少了
 * 地址，用户还得回头找卡片，等于白填。来源名放前面是为了让「链接是什么」在
 * 粘贴进聊天框时先被看见。
 */
function fillText(spec: IuLinkSpec, _state: IuLinkState): string {
  return spec.title + ' — ' + linkSource(spec) + '：' + spec.url
}

/**
 * 静态快照（截图管线用）。
 *
 * DOM 与 link.body.tsx **逐字对齐**：class 名、层级、顺序完全一致，否则共用同一份
 * CSS 的截图会当场长歪（钢琴卡就是这么栽的）。所以两边都不许多一层、不许少一层。
 *
 * 所有模型文本走 esc，href 走 escAttr——截图页跑在 --disable-web-security 的
 * 无头 Chrome 里，一个逃出属性上下文的引号就等于任意脚本。
 */
function snapshot(spec: IuLinkSpec): string {
  const source = linkSource(spec)
  const host = hostOf(spec.url)

  const metaHtml = spec.meta
    ? '<span class="dtt-iu__lk-dot">·</span>'
      + '<span class="dtt-iu__lk-meta">' + esc(spec.meta) + '</span>'
    : ''

  const tagHtml = spec.badge
    ? '<span class="dtt-iu__lk-tag">' + esc(spec.badge) + '</span>'
    : ''

  /*
   * 正文标题：**与卡片头重复时不画**。
   *
   * 外壳 IuCard 的图注行渲染的就是 spec.title，而 heading 缺省会回退成 title——
   * 模型最常见的写法（只给 title）会让同一个标题在一张卡上出现两遍。截图里
   * 一眼就能看出来，用户会当成排版 bug。
   */
  const headingText = spec.heading ?? spec.title
  const showHeading = headingText !== spec.title
  const headingHtml = showHeading
    ? '<span class="dtt-iu__lk-title">' + esc(headingText) + '</span>'
    : ''

  const summaryHtml = spec.summary
    ? '<span class="dtt-iu__lk-summary">' + esc(spec.summary) + '</span>'
    : ''

  return [
    '<div class="dtt-iu__link" data-host="' + escAttr(host) + '">',
    '<a class="dtt-iu__lk-row" href="' + escAttr(spec.url) + '" target="_blank" rel="noreferrer noopener">',
    '<span class="dtt-iu__lk-mark">' + esc(initialOf(source)) + '</span>',
    '<span class="dtt-iu__lk-main">',
    '<span class="dtt-iu__lk-head">',
    headingHtml,
    tagHtml,
    '</span>',
    '<span class="dtt-iu__lk-sub">',
    '<span class="dtt-iu__lk-source">' + esc(source) + '</span>',
    metaHtml,
    '</span>',
    summaryHtml,
    '</span>',
    '<span class="dtt-iu__lk-arrow">' + LINK_ARROW_SVG + '</span>',
    '</a>',
    '</div>',
  ].join('')
}

/**
 * 本 kind 专属样式。
 *
 * 纪律（与基座一致）：
 *  · 字号一律 calc(Npx * var(--iu-text-scale, 1))，跟随官方「设置 → 字号」；
 *  · 颜色只用 currentColor / var(--dsw-alias-*)，不写死 #000 / #fff；
 *  · **不加外描边**：外层 .dtt-iu 已经没有边框，内层再描一圈就又变成「框」；
 *  · **不做入场动画**：可见性绝不依赖动画（无头截图会停在第一帧）；
 *  · 无外部资源：没有 favicon、没有缩略图、没有外链图片。
 */
const CSS = [
  '/* ───────────────────────── iu kind: link ───────────────────────── */',
  '.dtt-iu__link { display: block; width: 100%; padding: 2px 0; box-sizing: border-box; }',
  '/* 整条就是链接：横向布局，徽标 / 文字 / 箭头三段。',
  '   box-sizing 显式写死：宿主不一定有全局 border-box，不写会让 100% 宽度 + 内边距溢出。 */',
  '.dtt-iu__lk-row { display: flex; align-items: flex-start; gap: 10px; width: 100%; box-sizing: border-box;',
  '  padding: 10px 12px; border-radius: var(--iu-r-md, 8px);',
  '  background: rgba(127,127,127,.05); color: inherit; text-decoration: none;',
  '  -webkit-tap-highlight-color: transparent;',
  '  transition: background-color .18s ease; }',
  '/* hover / focus 只加深底色 + 箭头位移，不描边（外层卡片已有边框）。 */',
  '.dtt-iu__lk-row:hover, .dtt-iu__lk-row:focus { background: rgba(127,127,127,.08); }',
  '/* 键盘兜底：outline 是焦点可见性的唯一出口，不能因为「不想加框」而删掉。 */',
  '.dtt-iu__lk-row:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6); outline-offset: 2px; }',
  '/* 左侧来源徽标：38px 圆角方块，中性灰底 + currentColor。',
  '   ⚠ 不用品牌色、不塞 favicon——拿不到就是拿不到，假装有只会得到一个空方块。 */',
  '.dtt-iu__lk-mark { flex: none; display: flex; align-items: center; justify-content: center;',
  '  width: 38px; height: 38px; border-radius: 10px;',
  '  background: rgba(127,127,127,.08); color: currentColor;',
  '  font-size: calc(15px * var(--iu-text-scale, 1)); font-weight: 600; line-height: 1;',
  '  letter-spacing: .01em; user-select: none; }',
  '/* 中间文字区：flex:1 且 min-width:0 —— 少了 min-width，单行省略在 flex 里永远不生效 */',
  '.dtt-iu__lk-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }',
  '.dtt-iu__lk-head { display: flex; align-items: center; gap: 8px; min-width: 0; }',
  '.dtt-iu__lk-title { flex: 1 1 auto; min-width: 0; display: block;',
  '  font-size: calc(14px * var(--iu-text-scale, 1)); font-weight: 600; line-height: 1.35;',
  '  color: currentColor; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '/* 右上角小标签：极小胶囊，中性灰底；字号不跟标题抢戏 */',
  '.dtt-iu__lk-tag { flex: none; display: inline-flex; align-items: center;',
  '  padding: 1px 6px; border-radius: 999px; background: rgba(127,127,127,.10);',
  '  color: var(--dsw-alias-label-tertiary, currentColor);',
  '  font-size: calc(9.5px * var(--iu-text-scale, 1)); font-weight: 500; line-height: 1.5;',
  '  white-space: nowrap; }',
  '/* 第二行：来源 · meta。flex + 各自省略：meta 太长时缩 meta，来源名不被挤压。 */',
  '.dtt-iu__lk-sub { display: flex; align-items: center; gap: 5px; min-width: 0;',
  '  font-size: calc(11.5px * var(--iu-text-scale, 1)); line-height: 1.4;',
  '  color: var(--dsw-alias-label-tertiary, currentColor); font-variant-numeric: tabular-nums; }',
  '.dtt-iu__lk-source { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '.dtt-iu__lk-dot { flex: none; opacity: .55; }',
  '.dtt-iu__lk-meta { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '/* 第三行：摘要两行 clamp。line-clamp 是标准属性，-webkit- 那套是现役实现，两个都写。 */',
  '.dtt-iu__lk-summary { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;',
  '  overflow: hidden; margin-top: 1px;',
  '  font-size: calc(12px * var(--iu-text-scale, 1)); line-height: 1.5;',
  '  color: var(--dsw-alias-label-tertiary, currentColor); font-variant-numeric: tabular-nums; }',
  '/* 右侧箭头：SVG path，hover 右移 2px（1–2px 区间内，再多就会「跳」） */',
  '.dtt-iu__lk-arrow { flex: none; align-self: center; display: flex; align-items: center; justify-content: center;',
  '  width: 16px; height: 16px; color: currentColor; opacity: .42;',
  '  transition: transform .18s ease, opacity .18s ease; }',
  '.dtt-iu__lk-row:hover .dtt-iu__lk-arrow,',
  '.dtt-iu__lk-row:focus-visible .dtt-iu__lk-arrow { transform: translateX(2px); opacity: .72; }',
  '/* 减少动效：装饰位移与过渡全关（本卡没有入场动画，可见性不依赖动画）。 */',
  '@media (prefers-reduced-motion: reduce) {',
  '  .dtt-iu__lk-row, .dtt-iu__lk-arrow { transition: none; }',
  '  .dtt-iu__lk-row:hover .dtt-iu__lk-arrow,',
  '  .dtt-iu__lk-row:focus-visible .dtt-iu__lk-arrow { transform: none; }',
  '}',
  '/* 窄屏：只收内边距与间距，徽标尺寸不动（38px 是这条卡的可识别特征）。 */',
  '@container iu (max-width: 480px) {',
  '  .dtt-iu__lk-row { gap: 8px; padding: 9px 10px; }',
  '}',
].join('\n')

export const linkKind: IuKind<IuLinkState, IuLinkSpec> = {
  kind: 'link',
  label: '链接',
  parse,
  initState,
  fillText,
  snapshot,
  css: CSS,
  doc: '  · link 链接：{"kind":"link","title":"参考文档","heading":"React 官方文档：Hooks 规则","url":"https://react.dev/reference/react","source":"react.dev","summary":"组件之间共享状态时最容易踩的几条规则。","meta":"React 团队 · 2026-03 · 8 分钟","badge":"官方"}（约束：url 必填且必须是 http(s) 绝对地址，不合法整卡回退代码块；**title 是卡头那行短标签（"参考文档"/来源名），heading 才是文章大标题**，只填一个时另一个自动回退；source 缺省由 hostname 推导；summary≤200 字、meta≤60、badge≤8 字）。',
}
