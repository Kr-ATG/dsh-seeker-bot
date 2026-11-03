/**
 * Personal Agent — 侧栏顶部品牌行素材。
 *
 * Work 模式的官方侧栏顶部是「鲸鱼 mark + deepseek wordmark + HARNESS 徽标 + 收起按钮」。
 * Bot 模式要做成同一套观感，就不能用系统字体近似一个 deepseek：这里把官方
 * `@deepseek-ai/dsh-client-ui-primitives` 的 FishLogo / BrandWordmark 原样内联
 * （数据见 brand-svg.ts），字形、字距、徽标尺寸与 Work 模式逐像素一致。
 *
 * 官方那两个素材本身是 slot 渲染的装饰性 SVG（aria-hidden），这里同样保持
 * aria-hidden：品牌行不是交互元素，读屏不该读出「deepseek HARNESS」。
 */
import { BRAND_WORDMARK_RATIO, BRAND_WORDMARK_SVG, FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from './brand-svg.ts'

/**
 * 内联官方 wordmark 的 clipPath id 加 pa- 前缀。
 *
 * 官方 SVG 里有两个全局 clipPath id（dsh-wordmark-whale-clip /
 * dsh-wordmark-badge-clip）。Work 模式官方品牌行本身也带同 id 的 SVG；
 * Bot 模式下官方 logoRow 只是 visibility:hidden（为了不重播 wide-in 动画，
 * 不能 display:none），两棵子树同时留在渲染树里时，url(#...) 会按文档顺序
 * 解析到另一份定义，HARNESS 徽标的字母会被裁掉、只剩一块黑底。
 * 本插件这份改用独立 id，跨组件不再冲突。
 */
const BRAND_WORDMARK_SVG_SCOPED = BRAND_WORDMARK_SVG
  .replaceAll('dsh-wordmark-whale-clip', 'pa-brand-wordmark-whale-clip')
  .replaceAll('dsh-wordmark-badge-clip', 'pa-brand-wordmark-badge-clip')

/** 鲸鱼 mark（官方 FishLogo 的同款几何，高度按 viewBox 比例算）。 */
export function BrandMark({ size = 24 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={(size * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width}
      viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={FISH_LOGO_PATH} fill="currentColor" />
    </svg>
  )
}

/**
 * 完整 wordmark（deepseek + HARNESS 徽标），不含鲸鱼 mark。
 *
 * `height` 是 SVG 高度；宽度按官方 156:24 的比例算，所以传 24 得到的就是
 * 官方侧栏里那一枚 156×24 的原始尺寸（与 Work 模式逐像素一致）。
 */
export function BrandWordmark({ height = 24 }: { height?: number }): JSX.Element {
  return (
    <span
      className="pa-brand__wordmark"
      style={{ height: `${height}px`, width: `${height * BRAND_WORDMARK_RATIO}px` }}
      // 官方 SVG 是静态素材（不含用户输入），内联渲染不会引入注入面。
      dangerouslySetInnerHTML={{ __html: BRAND_WORDMARK_SVG_SCOPED }}
      aria-hidden="true"
    />
  )
}

/**
 * 侧栏收起 / 展开图标（官方 IconPanelLeftOutlineRegular 的**逐路径复刻**）。
 *
 * 2026-11-03 用户指出「Work 与 Bot 切换上方的收起图标不一致」：旧版是自绘的
 * rect（1.7/2.7/12.6×10.6、rx 2.6）配 1.3px 描边，比 Work 模式官方那枚
 * （见 dsh-client-ui-primitives 的 #dsw-icon-panel-left-outline-regular）
 * 更圆、更粗、整体小一圈，两模式来回切能明显看出图标在变。
 *
 * 这里直接照抄官方 symbol 的 viewBox / 路径 / 描边宽度（1px、无圆头圆角），
 * 不再用 <rect> 近似——连 rx 的贝塞尔曲线都保持原样，任何缩放比例下都与
 * Work 模式那一枚逐像素一致。改这里必须同步核对官方 symbol，不要凭手感调。
 */
export function IconPanelLeft({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      aria-hidden="true"
    >
      <path d="M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z" />
      <path d="M5.5 1.5V14.5" />
    </svg>
  )
}
