/**
 * Personal Agent — 头像选择器（新建 / 修改 Bot 与群聊共用）。
 *
 * 两件事：
 *  1. 在预设里挑：形状（7 种）× 颜色（8 种），点一下即时预览；
 *  2. 从本地导入图片：读文件 → 居中裁成正方形 → 压到 160×160 的 JPEG（约
 *     10–20KB）→ data URL 存进 Avatar.image。
 *
 * 为什么压这么小：头像跟 Bot 数据一起躺在 localStorage（上限约 5MB），原图
 * 动辄几 MB，两三个头像就能把整个名册写崩。160px 在侧栏（34px）和会话头
 * （28px）上已经绰绰有余，连设置卡里的预览都够清晰。
 */
import { useRef, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { BOT_COLORS, BOT_SHAPES, shade } from '../engine.ts'
import type { Avatar } from '../types.ts'

export interface AvatarPickerProps {
  value: Avatar
  onChange: (avatar: Avatar) => void
  /** 预览头像的尺寸（px）。 */
  size?: number
  /** 是否允许从本地导入图片（默认允许）。 */
  allowImage?: boolean
}

/** 头像图片边长：够清楚，又不至于把 localStorage 撑爆。 */
const IMAGE_SIZE = 160

/**
 * 本地图片 → 正方形 JPEG data URL。
 *
 * 居中裁剪而不是拉伸：拉伸会把人脸压扁。失败时抛中文原因，由调用方显示在
 * 选择器下方（静默失败会让人以为点了没反应）。
 */
async function readImageAsAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  if (file.size > 12 * 1024 * 1024) throw new Error('图片太大了（上限 12MB）')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败，换一张试试'))
    img.src = dataUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_SIZE
  canvas.height = IMAGE_SIZE
  const ctx = canvas.getContext('2d')
  // 拿不到 2D 上下文（极旧浏览器）就退回原图：能用，只是体积大
  if (ctx === null) return dataUrl
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  const sx = (image.naturalWidth - side) / 2
  const sy = (image.naturalHeight - side) / 2
  ctx.drawImage(image, sx, sy, side, side, 0, 0, IMAGE_SIZE, IMAGE_SIZE)
  return canvas.toDataURL('image/jpeg', 0.82)
}

export function AvatarPicker({ value, onChange, size = 48, allowImage = true }: AvatarPickerProps): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasImage = value.image !== undefined && value.image !== ''

  const pickFile = async (file: File): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const image = await readImageAsAvatar(file)
      onChange({ ...value, image })
    } catch (err) {
      setError(err instanceof Error ? err.message : '图片读取失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pa-avatar-picker">
      <div className="pa-avatar-picker__preview">
        <BotAvatar avatar={value} size={size} />
        {allowImage ? (
          <div className="pa-avatar-picker__actions">
            <button
              className="pa-btn pa-btn--ghost pa-btn--sm"
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? '处理中…' : hasImage ? '换一张' : '上传图片'}
            </button>
            {hasImage ? (
              <button
                className="pa-btn pa-btn--ghost pa-btn--sm"
                type="button"
                onClick={() => onChange({ ...value, image: undefined })}
              >
                移除
              </button>
            ) : null}
          </div>
        ) : null}
        <input
          ref={fileRef}
          className="pa-avatar-picker__file"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            const file = event.target.files?.[0]
            // 清空 value：同一个文件连选两次也要能再次触发 onChange
            event.target.value = ''
            if (file !== undefined) void pickFile(file)
          }}
        />
      </div>

      <div className="pa-avatar-picker__choices">
        <div className="pa-avatar-picker__row" role="group" aria-label="头像形状">
          {BOT_SHAPES.map((shape) => (
            <button
              key={shape}
              className="pa-avatar-picker__shape"
              type="button"
              title={shape}
              data-on={!hasImage && value.shape === shape ? 'true' : 'false'}
              onClick={() => onChange({ ...value, shape, image: undefined })}
            >
              <BotAvatar avatar={{ ...value, shape, image: undefined }} size={24} />
            </button>
          ))}
        </div>
        <div className="pa-avatar-picker__row" role="group" aria-label="头像颜色">
          {BOT_COLORS.map((color) => (
            <button
              key={color}
              className="pa-avatar-picker__color"
              type="button"
              title={color}
              style={{ background: color }}
              data-on={!hasImage && value.color === color ? 'true' : 'false'}
              onClick={() => onChange({ ...value, color, tint: shade(color, -18), image: undefined })}
            />
          ))}
        </div>
        {error !== null ? <p className="pa-avatar-picker__error">{error}</p> : null}
      </div>
    </div>
  )
}
