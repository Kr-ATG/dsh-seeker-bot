/**
 * iu kind **link** 的 React 体（client 专用）。
 *
 * ## Body 契约（与所有 kind 一致）
 *
 *  · **只渲染正文**：卡片头（图注 + 全屏按钮）由外壳 IuCard 提供，这里不画；
 *  · **DOM 与 link.ts 的 snapshot() 逐字对齐**：class 名、层级、顺序完全一致。
 *    截图管线内联的是同一份 CSS，结构差一层，截图里就会长歪（钢琴卡的旧伤）；
 *  · **徽标的两半同源**：initialOf / linkSource / hostOf 全部从 link.ts 取，
 *    这里不重算——两边各算一套，同一张卡在对话流与截图里就会是两个字母。
 *
 * ## 为什么整块是一个 <a>
 *
 * 这张卡的全部意义就是「能点」。把 <a> 摊平到整条（而不是只包标题），用户在
 * 条的任意位置点击都能跳转；target/rel 写死 _blank + noreferrer noopener：
 * 外链一律开新标签，且不把来源页面（对话地址）泄漏给目标站点。
 *
 * ## 不做的事情（每一条都是有意的）
 *
 *  · 不加载 favicon / 缩略图 / 任何外链资源：离线与无头截图环境会静默失败，
 *    留下一个空方块，比没有图标更难看；
 *  · 不用品牌色给徽标上色：拿不到真实品牌信息时，上色等于编造；
 *  · 不套第二层圆角 + 底色 + 阴影：外层卡片本身无框，内层再包一层就是「卡中卡」。
 */

import { memo } from 'react'
import type { IuBodyProps } from './bodies.ts'
import type { IuLinkSpec, IuLinkState } from './link.ts'
import { LINK_ARROW_SVG, hostOf, initialOf, linkSource } from './link.ts'

export const LinkBody = memo(function LinkBody(
  { spec }: IuBodyProps<IuLinkState, IuLinkSpec>,
): JSX.Element {
  const source = linkSource(spec)
  /*
   * 正文标题：与卡片头（外壳渲染的 spec.title）重复时不画。
   * heading 缺省回退到 title，所以「只填 title」的老写法会让同一行出现两遍——
   * 这里跳过正是为了那种最常见的情况。
   */
  const headingText = spec.heading ?? spec.title
  const showHeading = headingText !== spec.title

  return (
    <div className="dtt-iu__link" data-host={hostOf(spec.url)}>
      <a
        className="dtt-iu__lk-row"
        href={spec.url}
        target="_blank"
        rel="noreferrer noopener"
      >
        {/* 左侧来源徽标：首字母写死在方块里，中性灰底（见 link.ts 的 initialOf） */}
        <span className="dtt-iu__lk-mark">{initialOf(source)}</span>

        {/* 中间文字区：标题 / 来源·meta / 摘要（有才画） */}
        <span className="dtt-iu__lk-main">
          <span className="dtt-iu__lk-head">
            {showHeading ? <span className="dtt-iu__lk-title">{headingText}</span> : null}
            {spec.badge ? <span className="dtt-iu__lk-tag">{spec.badge}</span> : null}
          </span>
          <span className="dtt-iu__lk-sub">
            <span className="dtt-iu__lk-source">{source}</span>
            {spec.meta ? <span className="dtt-iu__lk-dot">·</span> : null}
            {spec.meta ? <span className="dtt-iu__lk-meta">{spec.meta}</span> : null}
          </span>
          {spec.summary ? <span className="dtt-iu__lk-summary">{spec.summary}</span> : null}
        </span>

        {/* 右侧箭头：与 snapshot 共用同一个 SVG 常量，不用字符箭头（行高不稳） */}
        <span
          className="dtt-iu__lk-arrow"
          dangerouslySetInnerHTML={{ __html: LINK_ARROW_SVG }}
        />
      </a>
    </div>
  )
})
