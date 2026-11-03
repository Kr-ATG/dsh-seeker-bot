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
      dangerouslySetInnerHTML={{ __html: BRAND_WORDMARK_SVG }}
      aria-hidden="true"
    />
  )
}

/**
 * 侧栏收起 / 展开图标（官方 IconPanelLeftOutlineRegular 的同款形态）。
 *
 * 外框是圆角矩形，左侧一条竖线把「面板」与「内容区」分开；不画箭头，
 * 与 Work 模式侧栏右上角那枚按钮一致。
 */
export function IconPanelLeft({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="2.6" />
      <path d="M6.1 2.7v10.6" />
    </svg>
  )
}
