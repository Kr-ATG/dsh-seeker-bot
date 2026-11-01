/**
 * Personal Agent — 基础设计系统与全局布局样式。
 *
 * 深色主题为基准（参考截图），同时跟随 DSH 的 --dsw-alias-* token 自动适配亮色。
 * 组件模块只追加自己的规则；不要在这里写具体业务组件样式。
 */

export const PERSONAL_BASE_CSS = `
html body[data-skb-mode='bot'] { overflow: hidden !important; }
html body[data-skb-mode='bot'] #root { overflow: hidden !important; }

.pa-root {
  --pa-bg: #141517;
  --pa-sidebar: #17181a;
  --pa-main: #151618;
  --pa-right: #18191b;
  --pa-card: #202124;
  --pa-card-2: #26272a;
  --pa-card-3: #2e3138;
  --pa-line: rgba(255, 255, 255, 0.065);
  --pa-line-2: rgba(255, 255, 255, 0.11);
  --pa-text: #f2f3f5;
  --pa-text-2: #a7abb2;
  --pa-text-3: #73777f;
  --pa-text-4: #55585f;
  --pa-accent: #ff9f0a;
  --pa-blue: #0a84ff;
  --pa-red: #ff453a;
  --pa-green: #30d158;
  --pa-radius-card: 12px;
  --pa-radius-input: 14px;
  --pa-shadow-pop: 0 18px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06);
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  overflow: hidden;
  background: var(--pa-bg);
  color: var(--pa-text);
  /*
   * 字体与字号跟随 Work 模式的「设置」：
   *  · --dsw-font-family 是官方在 body 上解析好的正文族（已把用户选的字体
   *    --dsh-font-family-text 排在系统栈前面），直接继承即可；后面的 fallback
   *    只在官方样式缺失时兜底。
   *  · --dsh-content-font-size 是官方「通用 → 字号」的正文档位（10–22px，默认 14）。
   *    这里按官方 ui-theme 同款做法换算成**差值**：用户在 Work 里把字号 +2px，
   *    Bot 界面每个字号也 +2px（整体平移），下面的 font-size / line-height 都加它。
   *    默认档位（14px）下差值为 0，界面与原来逐像素一致。
   *    注：不用「比例」是因为 CSS calc() 的除数必须是纯数字，
   *    calc(14px / 14px) 不合规范会被整条丢弃，字号会静默掉回继承值。
   */
  --pa-font-delta: calc(var(--dsh-content-font-size, 14px) - 14px);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif);
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.pa-root * { box-sizing: border-box; }
.pa-root button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.pa-root input, .pa-root textarea, .pa-root select { font: inherit; color: inherit; }
.pa-root ::selection { background: rgba(255, 159, 10, 0.28); }
.pa-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.pa-root ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.09); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
.pa-root ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.16); background-clip: content-box; }
.pa-root ::-webkit-scrollbar-track { background: transparent; }

.pa-root[data-pa-theme='dark'] { color-scheme: dark; }
.pa-root[data-pa-theme='light'] {
  --pa-bg: #f4f5f7;
  --pa-sidebar: #ebedf0;
  --pa-main: #f7f8fa;
  --pa-right: #f2f3f5;
  --pa-card: #ffffff;
  --pa-card-2: #e9ebef;
  --pa-card-3: #e3e6eb;
  --pa-line: rgba(15, 17, 21, 0.07);
  --pa-line-2: rgba(15, 17, 21, 0.12);
  --pa-text: #14161a;
  --pa-text-2: #5d6269;
  --pa-text-3: #858a92;
  --pa-text-4: #a4a9b1;
  color-scheme: light;
}

.pa-app-shell { display: flex; flex: 1; min-width: 0; min-height: 0; }
.pa-col { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.pa-grow { flex: 1; min-height: 0; }

/* ---------- 左侧栏 ---------- */
.pa-sidebar {
  /* 与 Work 模式的官方侧栏同宽（官方 .hHd-Xa_root 是 280px），切换模式时
     左侧栏不跳宽度；分段控件的可用宽度也随之与官方侧栏一致（280-28=252）。 */
  width: 280px;
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--pa-sidebar);
  border-right: 1px solid var(--pa-line);
  position: relative;
}
.pa-sidebar__top {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  height: 66px;
  padding: 0 12px;
  box-sizing: border-box;
  flex: none;
}
.pa-icon-btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--pa-text-2);
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
  flex: none;
}
.pa-icon-btn:hover { background: rgba(255, 255, 255, 0.08); color: var(--pa-text); }
.pa-icon-btn:active { transform: scale(0.94); }
.pa-icon-btn--bordered { background: rgba(255, 255, 255, 0.055); }
.pa-icon-btn--accent { color: var(--pa-accent); }
.pa-spacer { flex: 1; }

/* Work / Bot 分段（参考第二张素材：深槽 + 黑色滑块） */
.pa-mode-seg {
  display: flex;
  gap: 3px;
  margin: 8px 14px 12px;
  padding: 4px;
  border-radius: 13px;
  background: #2a2b2e;
  flex: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.035);
}
.pa-root[data-pa-theme='light'] .pa-mode-seg { background: #dfe2e7; }
.pa-mode-seg button {
  flex: 1;
  height: 34px;
  border-radius: 10px;
  font-size: calc(14px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.01em;
  color: #a1a4aa;
  transition: color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}
.pa-mode-seg button:hover { color: #d8dade; }
.pa-mode-seg button[data-on='true'] {
  background: #0b0b0c;
  color: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.07);
}
.pa-root[data-pa-theme='light'] .pa-mode-seg button[data-on='true'] { background: #ffffff; color: #14161a; box-shadow: 0 1px 3px rgba(0,0,0,.12); }

.pa-sidebar__scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 2px 10px 10px; min-height: 0; }
.pa-sidebar__bottom { flex: none; padding: 8px 12px 12px; border-top: 1px solid var(--pa-line); }

/* ---------- 主 bot ---------- */
.pa-mainbot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 10px 12px;
  border-radius: 14px;
  transition: background 130ms ease;
  position: relative;
  cursor: pointer;
}
.pa-mainbot:hover { background: rgba(255, 255, 255, 0.03); }
.pa-mainbot[data-selected='true'] { background: transparent; }
.pa-mainbot__name {
  font-size: calc(13.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  letter-spacing: 0.01em;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-mainbot__meta { font-size: calc(10.5px + var(--pa-font-delta)); color: var(--pa-text-3); margin-top: -4px; }

/* ---------- 头像 ---------- */
.pa-avatar { position: relative; display: inline-flex; flex: none; }
.pa-avatar svg { display: block; width: 100%; height: 100%; overflow: visible; }
.pa-avatar__online {
  position: absolute;
  right: -1px;
  bottom: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--pa-accent);
  box-shadow: 0 0 0 2.5px var(--pa-sidebar);
}

/* ---------- 列表行 ---------- */
.pa-sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 8px 5px;
  font-size: calc(10.5px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pa-text-4);
  user-select: none;
}
.pa-sec-title__count { margin-left: auto; font-size: calc(10px + var(--pa-font-delta)); color: var(--pa-text-4); letter-spacing: 0; }

.pa-bot-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 8px;
  border-radius: 10px;
  text-align: left;
  transition: background 120ms ease;
  position: relative;
  cursor: pointer;
}
.pa-bot-row:hover { background: rgba(255, 255, 255, 0.045); }
.pa-bot-row[data-selected='true'] { background: var(--pa-card-2); }
.pa-bot-row__body { flex: 1; min-width: 0; }
.pa-bot-row__line1 { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.pa-bot-row__name { font-size: calc(12.5px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%; flex: 0 1 auto; }
.pa-bot-row__role { font-size: calc(9.5px + var(--pa-font-delta)); color: var(--pa-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.pa-bot-row__summary { font-size: calc(10.5px + var(--pa-font-delta)); color: var(--pa-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.pa-bot-row[data-selected='true'] .pa-bot-row__summary { color: var(--pa-text-2); }
.pa-bot-row__badge {
  min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px; background: var(--pa-accent);
  color: #1a1206; font-size: calc(9.5px + var(--pa-font-delta)); font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
  flex: none;
}

/* ---------- 通用按钮 ---------- */
.pa-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: 9px;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text);
  background: rgba(255, 255, 255, 0.07);
  transition: background 120ms ease, transform 100ms ease, opacity 120ms ease;
  white-space: nowrap;
}
.pa-btn:hover { background: rgba(255, 255, 255, 0.12); }
.pa-btn:active { transform: scale(0.98); }
.pa-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.pa-btn--primary { background: #f2f3f5; color: #14161a; font-weight: 600; }
.pa-btn--primary:hover { background: #ffffff; }
.pa-btn--ghost { background: transparent; color: var(--pa-text-2); }
.pa-btn--ghost:hover { background: rgba(255, 255, 255, 0.06); color: var(--pa-text); }
.pa-btn--danger { background: rgba(255, 69, 58, 0.16); color: #ff8a82; }
.pa-btn--sm { height: 26px; padding: 0 10px; font-size: calc(11px + var(--pa-font-delta)); border-radius: 7px; }

.pa-field {
  width: 100%;
  border: 1px solid var(--pa-line-2);
  background: rgba(255, 255, 255, 0.035);
  border-radius: 10px;
  padding: 9px 11px;
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--pa-text);
  outline: none;
  transition: border-color 120ms ease, background 120ms ease;
}
.pa-field:focus { border-color: rgba(255, 159, 10, 0.55); background: rgba(255, 255, 255, 0.05); }
.pa-field::placeholder { color: var(--pa-text-4); }
.pa-label { display: block; font-size: calc(11px + var(--pa-font-delta)); color: var(--pa-text-3); margin: 0 0 6px; }

/* ---------- 弹窗底座 ---------- */
.pa-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(6px);
  animation: pa-fade 160ms ease both;
  padding: 24px;
}
.pa-modal {
  width: 100%;
  max-width: 520px;
  max-height: calc(100vh - 80px);
  overflow: auto;
  background: #1d1e21;
  border-radius: 16px;
  box-shadow: var(--pa-shadow-pop);
  animation: pa-pop 200ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
  color: var(--pa-text);
}
.pa-root[data-pa-theme='light'] .pa-modal { background: #ffffff; }

/* ---------- Toast ---------- */
.pa-toast {
  position: absolute;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 80;
  background: rgba(20, 21, 23, 0.92);
  border: 1px solid var(--pa-line-2);
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
  padding: 8px 14px;
  border-radius: 999px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
  animation: pa-rise 220ms ease both;
  pointer-events: none;
  white-space: nowrap;
}

/* ---------- 动画 ---------- */
@keyframes pa-rise {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes pa-rise-center {
  from { opacity: 0; transform: translate(-50%, 14px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
@keyframes pa-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.975); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes pa-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes pa-typing {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
  30% { transform: translateY(-3px); opacity: 1; }
}
@keyframes pa-pulse {
  0% { transform: scale(1); opacity: 0.55; }
  70% { transform: scale(1.45); opacity: 0; }
  100% { transform: scale(1.45); opacity: 0; }
}
@keyframes pa-spin {
  to { transform: rotate(360deg); }
}
@keyframes pa-shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}

.pa-fade-in { animation: pa-fade 180ms ease both; }
.pa-rise-in { animation: pa-rise 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }

@media (max-width: 1000px) {
  .pa-sidebar { width: 220px; flex-basis: 220px; }
}
@media (max-width: 780px) {
  .pa-sidebar { position: absolute; z-index: 30; height: 100%; box-shadow: 0 20px 60px rgba(0,0,0,.45); transform: translateX(-100%); transition: transform 200ms ease; }
  .pa-root[data-mobile-sidebar='true'] .pa-sidebar { transform: translateX(0); }
}
`

let injected = false

/** 幂等注入基础样式；返回是否本次真正插入。 */
export function injectPersonalBaseStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-base-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-base-styles'
  style.textContent = PERSONAL_BASE_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function personalBaseInjected(): boolean {
  return injected
}
