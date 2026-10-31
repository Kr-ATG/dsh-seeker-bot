/**
 * dsh-seeker-bot — 工作区实时回显视口与放大弹窗样式。
 *
 * 严格遵从 DSH 设计系统：无「AI 味」大块发光与渐变，纯净黑白灰、发丝线与微弱半透明层次。
 *
 * @module
 */

export const echoViewportStyles = `
/* ══ 紧凑卡头内 · 实时回显小视口 ════════════════════════════════════════ */
.kr-echo-viewport {
  position: relative;
  grid-area: echo;
  width: 120px;
  height: 68px;
  border-radius: 6px;
  border: 1px solid var(--kr-hairline, rgba(255, 255, 255, 0.12));
  background: var(--dsw-alias-bg-base, rgba(0, 0, 0, 0.25));
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color .15s ease, box-shadow .15s ease, transform .1s ease;
  flex-shrink: 0;
  align-self: end;
  margin-top: 30px;
  margin-bottom: 2px;
}

body:not([data-ds-dark-theme]) .kr-echo-viewport {
  background: #f0f2f5;
  border-color: rgba(0, 0, 0, 0.12);
}

.kr-echo-viewport:hover {
  border-color: var(--dsw-alias-color-primary, #3b82f6);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}

.kr-echo-viewport:active {
  transform: scale(0.98);
}

/* 成功激活窗口后的脉冲反馈 */
.kr-echo-viewport[data-flash="ok"] {
  border-color: var(--dsw-alias-color-primary, #3b82f6);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.35);
}

.kr-echo-viewport[data-flash="fail"] {
  border-color: #ef4444;
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.3);
}

.kr-echo-viewport__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}

/* 左上角状态徽标（在线点 + 进程名） */
.kr-echo-viewport__badge {
  position: absolute;
  top: 3px;
  left: 4px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 3.5px;
  padding: 1px 4.5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  font-size: 9.5px;
  line-height: 12px;
  font-family: var(--dsw-font-family, sans-serif);
  color: #fff;
  pointer-events: none;
  letter-spacing: .2px;
}

.kr-echo-viewport__badge-text {
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kr-echo-viewport__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 4px #22c55e;
}

.kr-echo-viewport__dot--offline {
  background: #94a3b8;
  box-shadow: none;
}

.kr-echo-viewport__dot--min {
  background: #f59e0b;
  box-shadow: 0 0 4px #f59e0b;
}

/* 右下角放大标识按钮 */
.kr-echo-viewport__zoom {
  position: absolute;
  right: 3px;
  bottom: 3px;
  z-index: 3;
  width: 20px;
  height: 20px;
  padding: 0;
  margin: 0;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  color: rgba(255, 255, 255, 0.9);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease, transform .1s ease;
}

.kr-echo-viewport__zoom:hover {
  background: rgba(0, 0, 0, 0.88);
  color: #fff;
  transform: scale(1.08);
}

.kr-echo-viewport__zoom:active {
  transform: scale(0.92);
}

/* 空态 / 离线待机 */
.kr-echo-viewport__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 4px;
  color: var(--dsw-alias-label-tertiary, #888);
  font-size: 10px;
  text-align: center;
  pointer-events: none;
}

.kr-echo-viewport__empty svg {
  opacity: .55;
}

/* ══ 放大回显全屏模态弹窗 ══════════════════════════════════════════════ */
.kr-echo-modal__mask {
  position: fixed;
  inset: 0;
  z-index: 100000;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(5px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  animation: kr-echo-fade-in .15s ease-out;
}

@keyframes kr-echo-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.kr-echo-modal__dialog {
  position: relative;
  width: min(94vw, 1140px);
  max-height: min(90vh, 820px);
  background: var(--dsw-alias-bg-floating, #18191f);
  border: 1px solid var(--kr-hairline, rgba(255, 255, 255, 0.14));
  border-radius: 10px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary, #ededed);
}

body:not([data-ds-dark-theme]) .kr-echo-modal__dialog {
  background: #ffffff;
  border-color: rgba(0, 0, 0, 0.12);
  color: #1f2328;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}

/* 弹窗顶栏 */
.kr-echo-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--kr-hairline, rgba(255, 255, 255, 0.1));
  flex-shrink: 0;
}

.kr-echo-modal__title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.kr-echo-modal__title {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
}

.kr-echo-modal__subtitle {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #888);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
}

.kr-echo-modal__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.kr-echo-modal__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 5px;
  border: 1px solid var(--kr-hairline, rgba(255, 255, 255, 0.15));
  background: var(--dsw-alias-bg-hover, rgba(255, 255, 255, 0.08));
  color: inherit;
  cursor: pointer;
  transition: all .15s ease;
}

.kr-echo-modal__btn:hover {
  background: var(--dsw-alias-color-primary, #3b82f6);
  border-color: var(--dsw-alias-color-primary, #3b82f6);
  color: #fff;
}

.kr-echo-modal__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #888);
  cursor: pointer;
  padding: 0;
  transition: background-color .15s ease, color .15s ease;
}

.kr-echo-modal__close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--dsw-alias-label-primary, #ededed);
}

/* 弹窗画面区 */
.kr-echo-modal__body {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  overflow: hidden;
  padding: 12px;
  min-height: 360px;
}

body:not([data-ds-dark-theme]) .kr-echo-modal__body {
  background: #f8fafc;
}

.kr-echo-modal__big-img {
  max-width: 100%;
  max-height: calc(86vh - 90px);
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transition: transform .15s ease;
}

.kr-echo-modal__big-img:hover {
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.45);
}

.kr-echo-modal__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--dsw-alias-label-tertiary, #888);
  font-size: 13px;
}
`;
