/**
 * Personal Agent — 通话弹层与通话消息卡样式。
 *
 * 通话卡固定深色渐变（不随亮色主题反色，保证白字可读）；消息卡沿用 --pa-* 主题变量。
 */

export const PERSONAL_CALL_CSS = `
/* ---------- 全屏通话遮罩 ---------- */
.pa-call-overlay {
  position: absolute;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(4, 5, 7, 0.64);
  backdrop-filter: blur(12px);
  animation: pa-fade 180ms ease both;
}
.pa-root[data-pa-theme='light'] .pa-call-overlay { background: rgba(15, 17, 21, 0.42); }
.pa-call {
  --pa-call-text: #f2f3f5;
  --pa-call-text-2: #a7abb2;
  --pa-call-text-3: #73777f;
  --pa-call-line: rgba(255, 255, 255, 0.08);
  --pa-call-card: rgba(255, 255, 255, 0.06);
  width: 380px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 48px);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 30px 24px 22px;
  border-radius: 24px;
  background: linear-gradient(180deg, #24262c 0%, #191a1e 48%, #111214 100%);
  box-shadow: 0 32px 90px rgba(0, 0, 0, 0.68), 0 0 0 1px rgba(255, 255, 255, 0.09);
  color: var(--pa-call-text);
  overflow: hidden;
  animation: pa-pop 220ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
}
.pa-call::before {
  content: "";
  position: absolute;
  inset: -40% -30% auto;
  height: 70%;
  background: radial-gradient(ellipse at 50% 30%, rgba(255, 159, 10, 0.17), transparent 62%);
  pointer-events: none;
}
.pa-call::after {
  content: "";
  position: absolute;
  left: 8%;
  right: 8%;
  bottom: -32%;
  height: 46%;
  background: radial-gradient(ellipse at 50% 50%, rgba(10, 132, 255, 0.12), transparent 65%);
  pointer-events: none;
}
.pa-call__minimize {
  position: absolute;
  top: 14px;
  left: 14px;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-call-text-2);
  background: rgba(255, 255, 255, 0.05);
  transition: background 120ms ease, color 120ms ease;
  z-index: 2;
}
.pa-call__minimize:hover { background: rgba(255, 255, 255, 0.12); color: #ffffff; }
.pa-call__encrypted {
  position: absolute;
  top: 18px;
  right: 16px;
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  letter-spacing: 0.05em;
  color: rgba(255, 255, 255, 0.34);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pa-call__avatar-wrap {
  position: relative;
  width: 138px;
  height: 138px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 6px;
  flex: none;
  z-index: 1;
}
.pa-call__pulse {
  position: absolute;
  inset: 14px;
  border-radius: 50%;
  border: 1px solid rgba(255, 159, 10, 0.34);
  animation: pa-pulse 2.8s ease-out infinite;
  pointer-events: none;
}
.pa-call__pulse:nth-child(2) { animation-delay: 0.9s; }
.pa-call__pulse:nth-child(3) { animation-delay: 1.8s; }
.pa-call__avatar { position: relative; z-index: 2; border-radius: 50%; }
.pa-call__name { font-size: calc(18px + var(--pa-font-delta)); line-height: calc(25px + var(--pa-font-delta)); font-weight: 600; letter-spacing: 0.01em; z-index: 1; }
.pa-call__state {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: calc(17px + var(--pa-font-delta));
  color: var(--pa-call-text-2);
  font-variant-numeric: tabular-nums;
  z-index: 1;
}
.pa-call__state[data-status='ringing'] { color: var(--pa-call-text-3); }
.pa-call__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pa-green);
  box-shadow: 0 0 0 3px rgba(48, 209, 88, 0.15);
  flex: none;
}
.pa-call__state[data-status='ringing'] .pa-call__dot { background: var(--pa-accent); box-shadow: 0 0 0 3px rgba(255, 159, 10, 0.16); animation: pa-typing 1.1s ease-in-out infinite; }

/* ---------- 实时转写 ---------- */
.pa-call__turns {
  width: 100%;
  min-height: 104px;
  max-height: 216px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 4px;
  border-top: 1px solid var(--pa-call-line);
  border-bottom: 1px solid var(--pa-call-line);
  z-index: 1;
}
.pa-call__turns::-webkit-scrollbar { width: 6px; }
.pa-call__turns::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); border-radius: 3px; }
.pa-call__turn {
  max-width: 88%;
  padding: 8px 11px;
  border-radius: 12px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.58;
  overflow-wrap: anywhere;
  animation: pa-rise 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-call__turn[data-role='user'] { align-self: flex-end; background: #2e333b; color: #eef0f3; border-bottom-right-radius: 4px; }
.pa-call__turn[data-role='bot'] { align-self: flex-start; background: rgba(255, 255, 255, 0.07); color: #eef0f3; border-bottom-left-radius: 4px; }
.pa-call__turn-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: calc(13px + var(--pa-font-delta));
  color: rgba(255, 255, 255, 0.4);
  margin-bottom: 3px;
}
.pa-call__empty { margin: auto; font-size: calc(11.5px + var(--pa-font-delta)); line-height: calc(17px + var(--pa-font-delta)); color: var(--pa-call-text-3); text-align: center; }

/* ---------- 说话按钮 ---------- */
.pa-call__speak {
  width: 100%;
  min-height: 44px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--pa-call-text);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
  transition: background 130ms ease, color 130ms ease, transform 100ms ease;
  z-index: 1;
}
.pa-call__speak:hover { background: rgba(255, 255, 255, 0.13); }
.pa-call__speak:active { transform: scale(0.99); }
.pa-call__speak[data-recording='true'] { background: rgba(255, 69, 58, 0.18); color: #ff9a92; animation: pa-call-mic-pulse 1.4s ease-in-out infinite; }
@keyframes pa-call-mic-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 69, 58, 0.28); }
  50% { box-shadow: 0 0 0 6px rgba(255, 69, 58, 0); }
}
.pa-call__speak[data-busy='true'] { opacity: 0.6; cursor: progress; }
.pa-call__speak:disabled { opacity: 0.55; cursor: not-allowed; }
.pa-call__speak-note { font-size: calc(10px + var(--pa-font-delta)); line-height: calc(14px + var(--pa-font-delta)); color: var(--pa-call-text-3); margin-top: -4px; z-index: 1; }
.pa-call__type {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 2px;
  z-index: 1;
}
.pa-call__type input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 11px;
  border-radius: 9px;
  border: 1px solid var(--pa-call-line);
  background: rgba(255, 255, 255, 0.05);
  color: var(--pa-call-text);
  font-size: calc(12px + var(--pa-font-delta));
  outline: none;
}
.pa-call__type input::placeholder { color: var(--pa-call-text-3); }
.pa-call__type input:focus { border-color: rgba(255, 159, 10, 0.4); }
.pa-call__type button {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #f2f3f5;
  color: #14161a;
  flex: none;
}
.pa-call__type button:disabled { opacity: 0.35; cursor: not-allowed; }
.pa-call__thinking { display: inline-flex; gap: 4px; align-items: center; height: 20px; }
.pa-call__thinking i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pa-call-text-2);
  animation: pa-typing 1.1s ease-in-out infinite;
}
.pa-call__thinking i:nth-child(2) { animation-delay: 120ms; }
.pa-call__thinking i:nth-child(3) { animation-delay: 240ms; }

/* ---------- 控制按钮 ---------- */
.pa-call__controls {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 14px;
  width: 100%;
  margin-top: 2px;
  z-index: 1;
}
.pa-call__ctrl { display: flex; flex-direction: column; align-items: center; gap: 5px; color: var(--pa-call-text-2); font-size: calc(10px + var(--pa-font-delta)); line-height: calc(14px + var(--pa-font-delta)); }
.pa-call__ctrl-icon {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: var(--pa-call-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 130ms ease, transform 110ms ease, opacity 130ms ease;
}
.pa-call__ctrl:hover .pa-call__ctrl-icon { background: rgba(255, 255, 255, 0.14); }
.pa-call__ctrl:active .pa-call__ctrl-icon { transform: scale(0.94); }
.pa-call__ctrl[data-on='true'] .pa-call__ctrl-icon { background: #f2f3f5; color: #14161a; }
.pa-call__ctrl[data-disabled='true'] { opacity: 0.38; cursor: not-allowed; }
.pa-call__ctrl[data-disabled='true'] .pa-call__ctrl-icon { background: rgba(255, 255, 255, 0.05); }
.pa-call__ctrl--danger .pa-call__ctrl-icon { background: var(--pa-red); color: #ffffff; }
.pa-call__ctrl--danger:hover .pa-call__ctrl-icon { background: #ff5d52; }

/* ---------- 通话消息卡 ---------- */
.pa-callcard {
  width: min(100%, 460px);
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 12px;
  overflow: hidden;
}
.pa-callcard__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  text-align: left;
  transition: background 120ms ease;
}
.pa-callcard__head:hover { background: var(--pa-card-2); }
.pa-callcard__icon {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(48, 209, 88, 0.12);
  color: var(--pa-green);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.pa-callcard__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pa-callcard__title { font-size: calc(13px + var(--pa-font-delta)); line-height: calc(18px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); }
.pa-callcard__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: calc(10.5px + var(--pa-font-delta)); line-height: calc(15px + var(--pa-font-delta)); color: var(--pa-text-3); font-variant-numeric: tabular-nums; }
.pa-callcard__source { color: var(--pa-accent); background: rgba(255, 159, 10, 0.1); border-radius: 4px; padding: 0 5px; font-size: calc(9.5px + var(--pa-font-delta)); line-height: calc(14px + var(--pa-font-delta)); }
.pa-callcard__chevron { flex: none; display: inline-flex; color: var(--pa-text-3); transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-callcard[data-open='true'] .pa-callcard__chevron { transform: rotate(180deg); }
.pa-callcard__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--pa-line);
  animation: pa-fade 160ms ease both;
}
.pa-callcard__turn {
  max-width: 88%;
  padding: 8px 11px;
  border-radius: 12px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.58;
  overflow-wrap: anywhere;
}
.pa-callcard__turn[data-role='user'] { align-self: flex-end; background: var(--pa-card-3); border-bottom-right-radius: 4px; color: var(--pa-text); }
.pa-callcard__turn[data-role='bot'] { align-self: flex-start; background: var(--pa-chat-glass-2, rgba(255, 255, 255, 0.055)); border-bottom-left-radius: 4px; color: var(--pa-text-2); }
.pa-callcard__turn-label { display: flex; align-items: center; gap: 5px; font-size: calc(9.5px + var(--pa-font-delta)); line-height: calc(13px + var(--pa-font-delta)); color: var(--pa-text-3); margin-bottom: 2px; }
.pa-callcard__turn-time { margin-left: auto; font-variant-numeric: tabular-nums; }
.pa-callcard__turn-text { white-space: pre-wrap; }
.pa-callcard__empty { font-size: calc(11.5px + var(--pa-font-delta)); line-height: calc(17px + var(--pa-font-delta)); color: var(--pa-text-3); text-align: center; padding: 4px 0; }
.pa-callcard__collapse {
  align-self: center;
  margin-top: 2px;
  padding: 4px 12px;
  border-radius: 6px;
  background: var(--pa-chat-glass, rgba(255, 255, 255, 0.035));
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  transition: color 120ms ease, background 120ms ease;
}
.pa-callcard__collapse:hover { color: var(--pa-text); background: var(--pa-chat-hover, rgba(255, 255, 255, 0.06)); }

/* base.css 的 .pa-root button 重置（0,1,1）会压过纯类选择器；补回按钮外观。 */
button.pa-call__minimize {
  position: absolute;
  top: 14px;
  left: 14px;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-call-text-2);
  background: rgba(255, 255, 255, 0.05);
}
button.pa-call__speak {
  width: 100%;
  min-height: 44px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--pa-call-text);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
}
button.pa-call__speak[data-recording='true'] { background: rgba(255, 69, 58, 0.18); color: #ff9a92; }
button.pa-call__ctrl {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  color: var(--pa-call-text-2);
  font-size: calc(10px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
}
button.pa-callcard__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  text-align: left;
}
button.pa-callcard__collapse {
  align-self: center;
  margin-top: 2px;
  padding: 4px 12px;
  border-radius: 6px;
  background: var(--pa-chat-glass, rgba(255, 255, 255, 0.035));
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
}

@media (max-width: 480px) {
  .pa-call { width: 100%; padding: 26px 16px 18px; }
  .pa-call__controls { gap: 8px; }
  .pa-call__ctrl-icon { width: 46px; height: 46px; }
}
`

let injected = false

/** 幂等注入通话区样式；返回本次是否真正插入。 */
export function injectCallStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-call-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-call-styles'
  style.textContent = PERSONAL_CALL_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function callStylesInjected(): boolean {
  return injected
}
