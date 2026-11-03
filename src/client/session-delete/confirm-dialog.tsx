/**
 * dsh-seeker-bot — 「删除会话」的确认弹窗（自绘，替代 window.confirm）。
 *
 * ## 为什么不用 window.confirm
 *
 * 在 DSH 桌面壳（dsh-shell）里，`window.confirm` 弹的是**壳的原生对话框**：
 * 标题写死成 "dsh-shell"、系统灰底、按钮是 Windows 样式，与 DSH 主题完全
 * 脱节，也没法把「删的是哪条会话」讲清楚。删除是不可逆操作，确认框必须
 * 自己画。
 *
 * ## 视觉与交互约定
 *
 * - `createPortal` 到 `document.body`：祖先容器上的 `backdrop-filter` /
 *   `transform` 会把 `position:fixed` 钉进局部坐标系，遮罩挂 body 才盖得住全屏；
 * - z-index 1200/1201：高于菜单（官方 Menu 的 portal 层）与 popover-shell
 *   （mask 999 / card 1000），低于浏览器级提示；
 * - 开合动画复用 `modal-animation.ts`（遮罩淡入淡出 + 卡片自底部 24px 上滑），
 *   遵守 `prefers-reduced-motion`；
 * - Esc / 点遮罩 = 取消；「永久删除」`autoFocus`（回车即确认）；
 * - 确认按钮用警示红（`--dsw-alias-state-error-primary`），与菜单项的红字同色。
 *
 * 样式独立注入（`STYLE_ID` 幂等），类名前缀 `sd-`，不依赖任何其它模块的类。
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ensureModalAnimStyles, modalAnimClass, modalMaskAnimClass, useModalClose } from '../modal-animation.ts'

/** 样式标签 id（幂等注入）。 */
const STYLE_ID = 'dsh-session-delete-dialog-styles'

const SHEET = `
/* ── 遮罩：固定全屏，点击=取消 ── */
.sd-mask{position:fixed;inset:0;z-index:1200;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45))}
/* 居中容器：flex 定位，卡片动画的 transform 不与其冲突 */
.sd-wrap{position:fixed;inset:0;z-index:1201;display:flex;align-items:center;justify-content:center;pointer-events:none}
/* ── 卡片：实底（玻璃模式也不透）、圆角 14、l3 投影 ── */
.sd-card{
  pointer-events:auto;display:flex;flex-direction:column;
  width:min(432px,calc(100vw - 48px));max-height:calc(100vh - 96px);
  box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  border-radius:14px;
  box-shadow:var(--dsw-shadow-lv3,0 8px 40px rgba(0,0,0,.5));
  overflow:hidden}
.sd-card,html[data-dsh-glass] .sd-card{
  background:var(--dsw-static-neutral-bluish-00,#fff);
  backdrop-filter:none;-webkit-backdrop-filter:none}
body[data-ds-dark-theme] .sd-card,html[data-dsh-glass] body[data-ds-dark-theme] .sd-card{
  background:var(--dsw-static-neutral-bluish-850,#2c2c2e)}
/* ── 内容 ── */
.sd-title{flex:none;display:flex;align-items:center;gap:8px;padding:15px 18px 6px;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary,#eee)}
.sd-title-icon{display:inline-flex;color:var(--dsw-alias-state-error-primary,#e0434b)}
.sd-body{flex:none;min-height:0;padding:2px 18px 16px;overflow-y:auto;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#bbb);word-break:break-word}
/* 被删会话的标题：单独一行、主色、可省略，让用户确认删的是哪一条 */
.sd-target{
  margin:0 0 10px;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-l2,rgba(127,127,127,.10));
  color:var(--dsw-alias-label-primary,#eee);font-weight:500;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sd-warn{margin:0;color:var(--dsw-alias-state-error-primary,#e0434b);font-weight:500}
.sd-note{margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#8a8a8e);font-size:12px;line-height:18px}
.sd-actions{flex:none;display:flex;justify-content:flex-end;gap:8px;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
/* danger 确认钮：红框红字，hover 加深（与记忆面板的 mcd-btn-danger 同款） */
.sd-btn-danger{
  border-color:var(--dsw-alias-state-error-primary,#e0434b)!important;
  color:var(--dsw-alias-state-error-primary,#e0434b)!important}
.sd-btn-danger:hover{
  background:var(--dsw-alias-interactive-bg-hover-danger,rgba(224,67,75,.12))!important;
  border-color:var(--dsw-alias-state-error-primary,#e0434b)!important;
  color:var(--dsw-alias-state-error-primary,#e0434b)!important}
@media (prefers-reduced-motion:reduce){
  .sd-mask,.sd-card{animation:none!important}
}
`

/** 注入弹窗样式（幂等）。 */
function ensureDialogStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.dataset.plugin = 'dsh-seeker-bot'
  tag.textContent = SHEET
  document.head.appendChild(tag)
}

/** 弹窗属性。 */
export interface DeleteConfirmDialogProps {
  /** 被删会话的标题（空串 = 取不到，不显示那一行）。 */
  title: string
  /** 点「永久删除」。 */
  onConfirm: () => void
  /** 收回动画播完、真正卸载时触发。 */
  onClose: () => void
}

/**
 * 删除确认弹窗。
 *
 * 调用方以**条件渲染**使用（有请求才挂载），所以 `open` 恒为 true。
 *
 * @param props - 标题与两个回调。
 * @returns 弹窗（portal 到 body）。
 */
export function DeleteConfirmDialog({ title, onConfirm, onClose }: DeleteConfirmDialogProps): JSX.Element {
  ensureModalAnimStyles()
  ensureDialogStyles()
  const { closing, requestClose } = useModalClose(true, onClose)

  // Esc = 取消（与点遮罩等价）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [requestClose])

  const handleConfirm = (): void => {
    onConfirm()
    requestClose()
  }

  return createPortal(
    <>
      <div className={`sd-mask ${modalMaskAnimClass(closing)}`} aria-hidden="true" onClick={() => { requestClose() }} />
      <div className="sd-wrap">
        <div className={`sd-card ${modalAnimClass(closing)}`} role="dialog" aria-modal="true" aria-label="删除会话">
          <div className="sd-title">
            <span className="sd-title-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 1.6 15 14H1L8 1.6Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
                <path d="M8 6v3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <circle cx="8" cy="11.6" r="0.85" fill="currentColor" />
              </svg>
            </span>
            删除会话
          </div>
          <div className="sd-body">
            {title !== '' && <div className="sd-target">{title}</div>}
            <p className="sd-warn">对话与日志记录会一起消失，无法从回收站恢复。</p>
            <p className="sd-note">收藏的会话不受影响；已归档的会话会被直接清掉。正在跑回合的会话会被拒绝，等它结束或先归档即可。</p>
          </div>
          <div className="sd-actions">
            <Button variant="outline" size="sm" onClick={() => { requestClose() }}>取消</Button>
            <Button variant="outline" size="sm" autoFocus className="sd-btn-danger" onClick={handleConfirm}>
              永久删除
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
