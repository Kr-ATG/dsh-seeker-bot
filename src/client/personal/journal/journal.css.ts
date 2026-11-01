/**
 * Personal Agent — 期刊日记样式（组件级）。
 *
 * 视觉目标：深色阅读器 UI 包着一张米白纸张（#f6f0e4 / #241f1a），
 * 像一本真正的小杂志：衬线大标题、期号细线、16:9 宽幅配图、两栏正文、
 * 左侧粗线引文、刊头页脚。所有类名统一 pa-journal- 前缀。
 *
 * 只由 index.tsx 与 JournalOverlay 调用 injectJournalStyles()，幂等注入。
 */

export const JOURNAL_CSS = `
.pa-journal-overlay {
  --pa-journal-ui-text: #f2f3f5;
  --pa-journal-ui-text-2: #a7abb2;
  --pa-journal-ui-text-3: #73777f;
  --pa-journal-ui-text-4: #55585f;
  --pa-journal-ui-line: rgba(255, 255, 255, 0.07);
  --pa-journal-ui-line-2: rgba(255, 255, 255, 0.12);
  --pa-journal-ui-card: #1c1d20;
  --pa-journal-ui-card-2: #26272b;
  --pa-journal-ui-accent: #ff9f0a;
  --pa-journal-paper: #f6f0e4;
  --pa-journal-ink: #241f1a;
  --pa-journal-ink-2: #4a4137;
  --pa-journal-ink-3: #6f6354;
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  overflow: hidden;
  color: var(--pa-journal-ui-text);
  background: rgba(7, 8, 10, 0.9);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  animation: pa-journal-fade 180ms ease both;
}
.pa-journal-overlay * { box-sizing: border-box; }
.pa-journal-overlay button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.pa-journal-overlay button:disabled { cursor: not-allowed; }
.pa-journal-overlay a { color: inherit; text-decoration: none; }

.pa-journal-shell {
  flex: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
}

/* ───────────────────────── 左侧期刊列表 ───────────────────────── */
.pa-journal-aside {
  width: 280px;
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #131416;
  border-right: 1px solid var(--pa-journal-ui-line);
}
.pa-journal-aside-head {
  flex: none;
  padding: 20px 18px 12px;
}
.pa-journal-aside-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(15px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--pa-journal-ui-text);
}
.pa-journal-aside-title svg { color: var(--pa-journal-ui-accent); }
.pa-journal-aside-sub {
  margin-top: 5px;
  font-size: calc(9.5px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--pa-journal-ui-text-4);
}
.pa-journal-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px 12px 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pa-journal-aside-empty {
  padding: 26px 10px;
  text-align: center;
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-journal-ui-text-4);
}

/* ───────────────────────── 封面卡（列表 / 会话通用） ───────────────────────── */
.pa-journal-card {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px;
  border-radius: 12px;
  background: var(--pa-journal-ui-card);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
}
.pa-journal-card:hover { background: var(--pa-journal-ui-card-2); }
.pa-journal-card:focus-visible { outline: 2px solid rgba(255, 159, 10, 0.55); outline-offset: 2px; }
.pa-journal-card[data-active='true'] {
  background: var(--pa-journal-ui-card-2);
  border-color: rgba(255, 159, 10, 0.5);
}
.pa-journal-card__cover {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 7px;
  background: #0e1013;
}
.pa-journal-card__cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 340ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 140ms ease;
}
.pa-journal-card:hover .pa-journal-card__cover img { transform: scale(1.028); }
.pa-journal-card[data-active='true'] .pa-journal-card__cover img { opacity: 0.92; }
.pa-journal-card__body { padding: 8px 4px 2px; }
.pa-journal-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 8px;
  row-gap: 2px;
  font-size: calc(9px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--pa-journal-ui-text-4);
}
.pa-journal-card__issue {
  color: var(--pa-journal-ui-accent);
  font-weight: 700;
  letter-spacing: 0.14em;
}
.pa-journal-card__date { color: var(--pa-journal-ui-text-3); }
.pa-journal-card__title {
  margin-top: 5px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
  font-size: calc(13.5px + var(--pa-font-delta));
  font-weight: 600;
  line-height: 1.42;
  color: #eef0f3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ───────────────────────── 阅读器主区 ───────────────────────── */
.pa-journal-main {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(circle at 50% -12%, #24262b 0%, #131417 48%, #0b0c0e 100%);
}

/* 顶栏 */
.pa-journal-topbar {
  flex: none;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border-bottom: 1px solid var(--pa-journal-ui-line);
  background: rgba(18, 19, 21, 0.76);
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
}
.pa-journal-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px 0 9px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--pa-journal-ui-text-2);
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 500;
  transition: background 120ms ease, color 120ms ease;
  flex: none;
}
.pa-journal-back:hover { background: rgba(255, 255, 255, 0.11); color: var(--pa-journal-ui-text); }
.pa-journal-back:active { transform: scale(0.98); }
.pa-journal-topbar__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-left: 4px;
}
.pa-journal-topbar__label {
  font-size: calc(9px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--pa-journal-ui-text-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-topbar__title {
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-journal-ui-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-topbar__nav { display: flex; align-items: center; gap: 2px; flex: none; }
.pa-journal-iconbtn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--pa-journal-ui-text-2);
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
  flex: none;
}
.pa-journal-iconbtn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.09); color: var(--pa-journal-ui-text); }
.pa-journal-iconbtn:active:not(:disabled) { transform: scale(0.94); }
.pa-journal-iconbtn:disabled { opacity: 0.26; }
.pa-journal-rule-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border-radius: 8px;
  font-size: calc(11.5px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-journal-ui-text-2);
  border: 1px solid var(--pa-journal-ui-line-2);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  flex: none;
}
.pa-journal-rule-toggle:hover { background: rgba(255, 255, 255, 0.07); color: var(--pa-journal-ui-text); }
.pa-journal-rule-toggle[data-on='true'] {
  background: rgba(255, 159, 10, 0.14);
  border-color: rgba(255, 159, 10, 0.38);
  color: #ffb340;
}
.pa-journal-divider {
  width: 1px;
  height: 20px;
  margin: 0 3px;
  background: var(--pa-journal-ui-line);
  flex: none;
}

/* 滚动容器与纸张 */
.pa-journal-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 34px 28px 64px;
}
.pa-journal-paper {
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
  padding: 52px 58px 36px;
  border-radius: 3px;
  color: var(--pa-journal-ink);
  background-color: var(--pa-journal-paper);
  background-image: radial-gradient(rgba(90, 72, 46, 0.035) 1px, transparent 1px);
  background-size: 3px 3px;
  box-shadow: 0 34px 90px rgba(0, 0, 0, 0.62), 0 0 0 1px rgba(255, 255, 255, 0.07);
  animation: pa-journal-paper-in 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-journal-paper ::selection { background: rgba(255, 159, 10, 0.24); }

.pa-journal-hero { margin: 0 0 30px; }
.pa-journal-hero img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 2px;
  background: #1a2030;
}

.pa-journal-kicker {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 10px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
  font-size: calc(10px + var(--pa-font-delta));
  font-weight: 700;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--pa-journal-ink-3);
}
.pa-journal-kicker::after {
  content: "";
  flex: 1;
  height: 1px;
  background: rgba(36, 31, 26, 0.22);
}
.pa-journal-date {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 22px;
  font-size: calc(10.5px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--pa-journal-ink-3);
}
.pa-journal-date__sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(36, 31, 26, 0.38);
}
.pa-journal-title {
  margin: 0 0 10px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
  font-size: clamp(34px, 4.2vw, 40px);
  line-height: 1.16;
  letter-spacing: -0.012em;
  font-weight: 600;
  color: #1d1914;
  text-wrap: balance;
}
.pa-journal-subtitle {
  margin: 0 0 26px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
  font-style: italic;
  font-size: calc(15px + var(--pa-font-delta));
  line-height: 1.6;
  color: var(--pa-journal-ink-3);
}
.pa-journal-summary {
  margin: 0 0 30px;
  padding-bottom: 26px;
  border-bottom: 1px solid rgba(36, 31, 26, 0.16);
  font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
  font-size: calc(16px + var(--pa-font-delta));
  line-height: 1.88;
  color: #3b332a;
}
.pa-journal-summary::first-letter {
  float: left;
  padding: 7px 10px 0 0;
  font-size: calc(56px + var(--pa-font-delta));
  line-height: 0.88;
  font-weight: 600;
  color: #1d1914;
}
.pa-journal-body {
  column-count: 2;
  column-gap: 42px;
  margin-top: 4px;
}
.pa-journal-section {
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
  margin: 0 0 26px;
}
.pa-journal-section:last-child { margin-bottom: 0; }
.pa-journal-section-title {
  margin: 0 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(36, 31, 26, 0.18);
  font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #2a241d;
}
.pa-journal-section p {
  margin: 0;
  font-size: calc(13.5px + var(--pa-font-delta));
  line-height: 1.96;
  color: #332c24;
  text-align: justify;
}
.pa-journal-quote {
  margin: 30px 0 0;
  padding: 8px 0 8px 22px;
  border-left: 4px solid var(--pa-journal-ink);
  font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
  font-style: italic;
  font-size: calc(17px + var(--pa-font-delta));
  line-height: 1.75;
  color: #2a241d;
}
.pa-journal-footer {
  margin-top: 42px;
  padding-top: 14px;
  border-top: 1px solid rgba(36, 31, 26, 0.24);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
  font-size: calc(9px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--pa-journal-ink-3);
}
.pa-journal-footer__page { font-variant-numeric: tabular-nums; white-space: nowrap; }

/* 空态 */
.pa-journal-empty {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 48px 32px;
  text-align: center;
}
.pa-journal-empty__icon {
  width: 76px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--pa-journal-ui-line);
  color: var(--pa-journal-ui-text-3);
  margin-bottom: 4px;
}
.pa-journal-empty__title {
  margin: 0;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
  font-size: calc(24px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-journal-ui-text);
}
.pa-journal-empty__text {
  margin: 0;
  max-width: 400px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.8;
  color: var(--pa-journal-ui-text-3);
}
.pa-journal-empty__btn {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 16px;
  border-radius: 9px;
  background: #f2f3f5;
  color: #14161a;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  transition: background 120ms ease, transform 100ms ease, opacity 120ms ease;
}
.pa-journal-empty__btn:hover { background: #ffffff; }
.pa-journal-empty__btn:active { transform: scale(0.985); }
.pa-journal-empty__btn:disabled { opacity: 0.55; }

/* ───────────────────────── 规则面板（右侧抽屉） ───────────────────────── */
.pa-journal-rule {
  position: absolute;
  top: 66px;
  right: 16px;
  bottom: 16px;
  width: 364px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #1a1b1e;
  border: 1px solid var(--pa-journal-ui-line-2);
  border-radius: 16px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.62), 0 0 0 1px rgba(255, 255, 255, 0.03);
  animation: pa-journal-pop 200ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
}
.pa-journal-rule__head {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 16px 14px 12px 16px;
  border-bottom: 1px solid var(--pa-journal-ui-line);
}
.pa-journal-rule__heading { flex: 1; min-width: 0; }
.pa-journal-rule__title {
  margin: 0;
  font-size: calc(13.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-journal-ui-text);
}
.pa-journal-rule__sub {
  margin: 3px 0 0;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-journal-ui-text-3);
}
.pa-journal-rule__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 18px;
}
.pa-journal-rule__text {
  margin: 0 0 14px;
  padding: 12px 13px;
  border-radius: 10px;
  border: 1px solid var(--pa-journal-ui-line);
  background: rgba(255, 255, 255, 0.035);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.8;
  color: var(--pa-journal-ui-text-2);
}
.pa-journal-rule__text strong { color: var(--pa-journal-ui-text); font-weight: 600; }
.pa-journal-rule__settings {
  margin: 0 0 14px;
  border-top: 1px solid var(--pa-journal-ui-line);
}
.pa-journal-rule__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--pa-journal-ui-line);
  font-size: calc(11.5px + var(--pa-font-delta));
}
.pa-journal-rule__label { color: var(--pa-journal-ui-text-3); }
.pa-journal-rule__value {
  color: var(--pa-journal-ui-text);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.pa-journal-rule__value[data-off='true'] { color: var(--pa-journal-ui-text-3); }
.pa-journal-rule__actions {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
}
.pa-journal-rule__btn {
  flex: 1;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.07);
  color: var(--pa-journal-ui-text);
  font-size: calc(11.5px + var(--pa-font-delta));
  font-weight: 500;
  transition: background 120ms ease, transform 100ms ease;
}
.pa-journal-rule__btn:hover { background: rgba(255, 255, 255, 0.12); }
.pa-journal-rule__btn:active { transform: scale(0.98); }
.pa-journal-rule__btn--primary {
  background: #f2f3f5;
  color: #14161a;
  font-weight: 600;
}
.pa-journal-rule__btn--primary:hover { background: #ffffff; }
.pa-journal-rule__logs-title {
  margin: 0 0 8px;
  font-size: calc(9.5px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--pa-journal-ui-text-4);
}
.pa-journal-log {
  display: flex;
  gap: 9px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.pa-journal-log:last-child { border-bottom: 0; }
.pa-journal-log__dot {
  width: 6px;
  height: 6px;
  margin-top: 6px;
  border-radius: 50%;
  flex: none;
  background: #30d158;
}
.pa-journal-log[data-ok='false'] .pa-journal-log__dot { background: #55585f; }
.pa-journal-log__body { flex: 1; min-width: 0; }
.pa-journal-log__line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.pa-journal-log__badge {
  font-size: calc(9px + var(--pa-font-delta));
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #30d158;
}
.pa-journal-log[data-ok='false'] .pa-journal-log__badge { color: var(--pa-journal-ui-text-4); }
.pa-journal-log__reason {
  margin: 0;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.6;
  color: var(--pa-journal-ui-text-2);
  word-break: break-word;
}
.pa-journal-log__time {
  margin-top: 3px;
  font-size: calc(9.5px + var(--pa-font-delta));
  color: var(--pa-journal-ui-text-4);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.pa-journal-rule__empty {
  padding: 10px 0;
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-journal-ui-text-4);
}

/* ───────────────────────── 动画 ───────────────────────── */
@keyframes pa-journal-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes pa-journal-paper-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes pa-journal-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .pa-journal-overlay,
  .pa-journal-paper,
  .pa-journal-rule,
  .pa-journal-card,
  .pa-journal-card__cover img { animation: none !important; transition: none !important; }
}

/* ───────────────────────── 窄屏 ───────────────────────── */
@media (max-width: 1080px) {
  .pa-journal-aside { width: 240px; flex-basis: 240px; }
  .pa-journal-paper { padding: 44px 42px 32px; }
}
@media (max-width: 860px) {
  .pa-journal-aside { display: none; }
  .pa-journal-scroll { padding: 18px 12px 42px; }
  .pa-journal-paper { padding: 26px 20px 24px; }
  .pa-journal-body { column-count: 1; }
  .pa-journal-title { font-size: calc(30px + var(--pa-font-delta)); }
  .pa-journal-summary { font-size: calc(15px + var(--pa-font-delta)); }
  .pa-journal-quote { font-size: calc(15.5px + var(--pa-font-delta)); }
  .pa-journal-rule {
    top: auto;
    left: 12px;
    right: 12px;
    bottom: 12px;
    width: auto;
    max-height: 74%;
  }
}
`

let injected = false

/** 幂等注入期刊样式；返回本次是否真正插入。 */
export function injectJournalStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-journal-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-journal-styles'
  style.textContent = JOURNAL_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

/** 样式是否已注入（调试 / 测试用）。 */
export function journalStylesInjected(): boolean {
  return injected
}
