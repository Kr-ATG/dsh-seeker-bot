/**
 * Personal Agent — Bot 头像（参考图中的「小墨」blob 造型）。
 *
 * 用纯 SVG 生成：底色 + 高光 + 两个斜眼缝。同一套形状在不同 Bot 上只换颜色。
 */
import type { Avatar } from './types.ts'

export interface BotAvatarProps {
  avatar: Avatar
  size?: number
  online?: boolean
  className?: string
  muted?: boolean
}

function Eyes({ variant }: { variant: Avatar['shape'] }): JSX.Element {
  if (variant === 'orbit') {
    return <g><ellipse cx="27" cy="31" rx="2.2" ry="3.4" fill="#101216" opacity=".62" /><ellipse cx="39" cy="31" rx="2.2" ry="3.4" fill="#101216" opacity=".62" /></g>
  }
  if (variant === 'ring') return <g />
  return (
    <g transform="rotate(-8 32 31)">
      <ellipse cx="27" cy="31" rx="2.5" ry="4.2" fill="#0c0e12" opacity={variant === 'leaf' ? '.45' : '.66'} />
      <ellipse cx="39" cy="31" rx="2.5" ry="4.2" fill="#0c0e12" opacity={variant === 'leaf' ? '.45' : '.66'} />
    </g>
  )
}

function Shape({ shape }: { shape: Avatar['shape'] }): JSX.Element {
  switch (shape) {
    case 'whale':
      return <path d="M12 33c0-11 8.4-19 21-19 12 0 20 7.6 20 18 0 7.4-4 12-9.6 14.2l3.4 6.8-9-3.3A37 37 0 0 1 32 51C20 51 12 44 12 33Z" />
    case 'cat':
      return <path d="M14 30 12.4 13l12 6.2a27 27 0 0 1 15.2 0l12-6.2L50 30c0 12-8 21-18 21s-18-9-18-21Z" />
    case 'leaf':
      return <path d="M32 8c14 0 24 9 24 22 0 14-10 24-24 24S8 44 8 30C8 17 18 8 32 8Z" transform="rotate(-12 32 32)" />
    case 'orbit':
      return <g><circle cx="32" cy="32" r="18" /><ellipse cx="32" cy="32" rx="27" ry="9" fill="none" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" /></g>
    case 'spark':
      return <path d="M32 6 38 24 56 32 38 40 32 58 26 40 8 32 26 24Z" />
    case 'ring':
      return <g><circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" strokeWidth="9" /></g>
    case 'blob':
    default:
      return <path d="M13 34c0-12 8.2-22 19.5-22 12.2 0 19.5 9.2 19.5 21 0 12.6-8 23-19.5 23S13 46 13 34Z" />
  }
}

export function BotAvatar({ avatar, size = 34, online = false, className, muted = false }: BotAvatarProps): JSX.Element {
  const gradientId = `pa-av-${avatar.color.replace('#', '')}-${avatar.shape}`
  return (
    <span
      className={`pa-avatar ${className ?? ''}`}
      style={{ width: size, height: size, opacity: muted ? 0.55 : 1 }}
    >
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={avatar.color} />
            <stop offset="1" stopColor={avatar.tint ?? avatar.color} />
          </linearGradient>
          <radialGradient id={`${gradientId}-hi`} cx=".32" cy=".22" r=".65">
            <stop offset="0" stopColor="#ffffff" stopOpacity=".28" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g fill={`url(#${gradientId})`} style={{ color: avatar.color }}>
          <Shape shape={avatar.shape} />
        </g>
        <ellipse cx="26" cy="20" rx="14" ry="10" fill={`url(#${gradientId}-hi)`} />
        <Eyes variant={avatar.shape} />
      </svg>
      {online ? <i className="pa-avatar__online" /> : null}
    </span>
  )
}
