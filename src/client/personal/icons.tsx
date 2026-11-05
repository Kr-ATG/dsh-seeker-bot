/**
 * Personal Agent — 内联 SVG 图标集。
 *
 * 统一 24×24 viewBox、round 线帽、1.7 描边。禁止用 emoji 代替图标。
 */
import type { ReactNode } from 'react'

export interface IconProps {
  size?: number
  className?: string
  strokeWidth?: number
}

function Svg({ size = 18, className, strokeWidth = 1.7, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function IconSidebar({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /><path d="M14.5 10.5 17 12l-2.5 1.5" /></Svg>
}

export function IconSearch({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><circle cx="11" cy="11" r="6.4" /><path d="m16 16 4 4" /></Svg>
}

export function IconPlus({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M12 5v14M5 12h14" /></Svg>
}

/** 机器人头像（新建 Bot 入口 / 创建弹窗的英雄图标）。 */
export function IconBot({ size, className }: IconProps): JSX.Element {
  return (
    <Svg size={size} className={className}>
      <rect x="3.6" y="7.4" width="16.8" height="12.1" rx="4.2" />
      <path d="M12 3.4v4" />
      <circle cx="8.7" cy="12.6" r="1" fill="currentColor" stroke="none" />
      <circle cx="15.3" cy="12.6" r="1" fill="currentColor" stroke="none" />
      <path d="M9.4 16.2h5.2" />
      <path d="M3.6 12.2H2.2M20.4 12.2h1.4" />
    </Svg>
  )
}

export function IconPhone({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M5.2 3.8h3.1l1.4 3.9-2 1.4a12.5 12.5 0 0 0 5.2 5.2l1.4-2 3.9 1.4v3.1a2.4 2.4 0 0 1-2.6 2.4C9.3 18.7 5.3 14.7 2.8 6.4a2.4 2.4 0 0 1 2.4-2.6Z" /></Svg>
}

export function IconPhoneOff({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M5.2 3.8h3.1l1.4 3.9-2 1.4a12.5 12.5 0 0 0 5.2 5.2l1.4-2 3.9 1.4v3.1a2.4 2.4 0 0 1-2.6 2.4C9.3 18.7 5.3 14.7 2.8 6.4a2.4 2.4 0 0 1 2.4-2.6Z" /><path d="m4 20 16-16" /></Svg>
}

export function IconMic({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v3" /></Svg>
}

export function IconMicOff({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v3" /><path d="m4 20 16-16" /></Svg>
}

export function IconWave({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></Svg>
}

export function IconPaperclip({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M20.4 11.3 12 19.7a5.5 5.5 0 0 1-7.8-7.8l8.4-8.4a3.7 3.7 0 0 1 5.2 5.2L9.4 17a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" /></Svg>
}

export function IconSend({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></Svg>
}

export function IconMore({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className} strokeWidth={2}><circle cx="5" cy="12" r=".7" /><circle cx="12" cy="12" r=".7" /><circle cx="19" cy="12" r=".7" /></Svg>
}

export function IconX({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="m6 6 12 12M18 6 6 18" /></Svg>
}

export function IconChevronDown({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="m6 9 6 6 6-6" /></Svg>
}

export function IconChevronRight({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="m9 6 6 6-6 6" /></Svg>
}

export function IconChevronLeft({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="m15 6-6 6 6 6" /></Svg>
}

export function IconCheck({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="m5 12.5 4.2 4.2L19 6.8" /></Svg>
}

export function IconCircleCheck({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><circle cx="12" cy="12" r="8.6" /><path d="m8 12.2 2.7 2.7 5.4-5.5" /></Svg>
}

export function IconSettings({ size, className }: IconProps): JSX.Element {
  /**
   * 圆角齿轮：齿顶保留小平台、齿根用圆弧收口，配合 stroke-linejoin=round
   * 让小尺寸下不再是一圈尖齿（原来的刚性来自 8 个尖锐齿角）。
   */
  return <Svg size={size} className={className}><path d="M18.5 10.85 L21.13 10.88 A9.2 9.2 0 0 1 21.13 13.12 L18.5 13.15 A6.6 6.6 0 0 1 17.41 15.79 L19.25 17.66 A9.2 9.2 0 0 1 17.66 19.25 L15.79 17.41 A6.6 6.6 0 0 1 13.15 18.5 L13.12 21.13 A9.2 9.2 0 0 1 10.88 21.13 L10.85 18.5 A6.6 6.6 0 0 1 8.21 17.41 L6.34 19.25 A9.2 9.2 0 0 1 4.75 17.66 L6.59 15.79 A6.6 6.6 0 0 1 5.5 13.15 L2.87 13.12 A9.2 9.2 0 0 1 2.87 10.88 L5.5 10.85 A6.6 6.6 0 0 1 6.59 8.21 L4.75 6.34 A9.2 9.2 0 0 1 6.34 4.75 L8.21 6.59 A6.6 6.6 0 0 1 10.85 5.5 L10.88 2.87 A9.2 9.2 0 0 1 13.12 2.87 L13.15 5.5 A6.6 6.6 0 0 1 15.79 6.59 L17.66 4.75 A9.2 9.2 0 0 1 19.25 6.34 L17.41 8.21 A6.6 6.6 0 0 1 18.5 10.85 Z" /><circle cx="12" cy="12" r="3" /></Svg>
}

export function IconBook({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><rect x="4" y="3.5" width="16" height="17" rx="3.4" /><path d="M8.4 3.5v17" /><path d="M11.6 8.2h5.2M11.6 11.6h3.4" /></Svg>
}

export function IconUsers({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.4A5.5 5.5 0 0 1 20.5 20" /></Svg>
}

export function IconSparkles({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M12 3.5 13.6 9 19 10.5 13.6 12 12 17.5 10.4 12 5 10.5 10.4 9Z" /><path d="M18.5 16.5 19.2 19l2.3.8-2.3.7-.7 2.5-.7-2.5-2.3-.7 2.3-.8Z" /></Svg>
}

export function IconVolume({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z" /><path d="M16 9a4.2 4.2 0 0 1 0 6M18.7 6.3a8 8 0 0 1 0 11.4" /></Svg>
}

export function IconVolumeOff({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></Svg>
}

export function IconVideo({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><rect x="3" y="6" width="13" height="12" rx="3" /><path d="m16 10 5-3v10l-5-3" /></Svg>
}

export function IconMinimize({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M9 15H5M9 15V19M15 9h4M15 9V5" /></Svg>
}

export function IconExpand({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4" /></Svg>
}

export function IconShare({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M12 15V3M8 7l4-4 4 4" /><path d="M5 13v6.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V13" /></Svg>
}

export function IconFolder({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h4l2 2.5h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z" /></Svg>
}

export function IconFile({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M6 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5A1.5 1.5 0 0 1 6.5 3.5Z" /><path d="M13 3.5V9h5" /></Svg>
}

export function IconTerminal({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7 9 3 3-3 3M12.5 15H17" /></Svg>
}

export function IconCpu({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" /></Svg>
}

export function IconClock({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><circle cx="12" cy="12" r="8.7" /><path d="M12 7v5.2l3.2 2" /></Svg>
}

export function IconTrash({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M4 6.5h16M9 3.5h6M6.5 6.5 7.5 20a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13.5" /><path d="M10 10v7M14 10v7" /></Svg>
}

export function IconEdit({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M4 20h4l11-11a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" /><path d="m13.5 7 3.5 3.5" /></Svg>
}

/** 图钉（置顶）：钉在侧栏会话列表最前。 */
export function IconPin({ size, className }: IconProps): JSX.Element {
  return (
    <Svg size={size} className={className}>
      <path d="M12 17v5" />
      <path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Svg>
  )
}

export function IconPause({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M8 5v14M16 5v14" /></Svg>
}

/**
 * 停止（实心方块）。
 *
 * 用填充而不是描边：输入框里只有 17px，三条描边会糊成一团；实心块靠颜色
 * （currentColor，由样式表给红）就能说明「这一下会中断」，不必再画细节。
 */
export function IconStop({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><rect x="7.2" y="7.2" width="9.6" height="9.6" rx="2.2" fill="currentColor" stroke="none" /></Svg>
}

export function IconPlay({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M7 4.5 19 12 7 19.5Z" /></Svg>
}

export function IconRefresh({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M20 12a8 8 0 1 1-2.3-5.6L20 8.5" /><path d="M20 4v5h-5" /></Svg>
}

export function IconDownload({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M12 3v12M8 11l4 4 4-4" /><path d="M5 19h14" /></Svg>
}

export function IconArrowLeft({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M19 12H5M11 6l-6 6 6 6" /></Svg>
}

export function IconArrowRight({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>
}

export function IconMessage({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M20.5 11.5a7.8 7.8 0 0 1-8.5 7.7 9.7 9.7 0 0 1-3-.5L4 20.5l1.3-4.2A7.8 7.8 0 0 1 12 3.7a7.8 7.8 0 0 1 8.5 7.8Z" /></Svg>
}

/**
 * 引用：把这条消息带进输入框当上下文（气泡侧边的图标按钮用）。
 *
 * 用**实心双引号**而不是回转箭头：箭头在聊天界面里是「回复」的通用符号，
 * 放在这里会让人以为点下去会另起一条消息。实心形状在 18px 下也不会糊。
 */
export function IconQuote({ size, className }: IconProps): JSX.Element {
  return (
    <Svg size={size} className={className}>
      <path fill="currentColor" d="M9.6 4.6C5.4 6.3 2.8 9.4 2.8 13c0 2.8 1.7 4.6 4 4.6 2.1 0 3.6-1.5 3.6-3.5 0-1.9-1.3-3.2-3.1-3.2-.4 0-.8 0-1.1.1.5-1.9 1.9-3.4 4-4.3l-.6-2.1Z" />
      <path fill="currentColor" d="M19.6 4.6c-4.2 1.7-6.8 4.8-6.8 8.4 0 2.8 1.7 4.6 4 4.6 2.1 0 3.6-1.5 3.6-3.5 0-1.9-1.3-3.2-3.1-3.2-.4 0-.8 0-1.1.1.5-1.9 1.9-3.4 4-4.3l-.6-2.1Z" />
    </Svg>
  )
}

/** 撤回：撤销箭头（不是刷新）。刷新表示「重来一次」，撤回是「退回去」。 */
export function IconUndo({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Svg>
}

export function IconMemory({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M9.5 3.5A3 3 0 0 0 6.7 6v.2A3 3 0 0 0 4 9a3 3 0 0 0 1.4 2.5A3 3 0 0 0 4 14a3 3 0 0 0 2.7 3v.3a3 3 0 0 0 5.3 1.8V3.8a3 3 0 0 0-2.5-.3Z" /><path d="M14.5 3.5A3 3 0 0 1 17.3 6v.2A3 3 0 0 1 20 9a3 3 0 0 1-1.4 2.5A3 3 0 0 1 20 14a3 3 0 0 1-2.7 3v.3a3 3 0 0 1-5.3 1.8" /></Svg>
}

export function IconListTodo({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3.5 5.8 1.2 1.2L7 4.8M3.5 11.8l1.2 1.2L7 10.8M3.5 17.8l1.2 1.2L7 16.8" /></Svg>
}

export function IconImage({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m5 18 4.5-4.5 3.5 3 2.5-2.5L19.5 18" /></Svg>
}

export function IconSun({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>
}

export function IconMoon({ size, className }: IconProps): JSX.Element {
  return <Svg size={size} className={className}><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" /></Svg>
}

export function IconMonitor({ size, className }: IconProps): JSX.Element {
  return (
    <Svg size={size} className={className}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Svg>
  )
}

export function IconCamera({ size, className }: IconProps): JSX.Element {
  return (
    <Svg size={size} className={className}>
      <path d="M14.5 4h-5L7.5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5l-2-3Z" />
      <circle cx="12" cy="13" r="3.5" />
    </Svg>
  )
}
