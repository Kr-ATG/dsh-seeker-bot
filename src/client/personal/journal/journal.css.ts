/**
 * Personal Agent — 期刊日记样式（编辑杂志风 · 双主题）。
 *
 * 视觉结构是「书架 + 阅读台」：
 *   · 左侧 260px 书架（可折叠）：按年月分组的封面卡列表；
 *   · 右侧阅读台：次级 UI 色顶栏 + 居中的纸张（亮色象牙纸 / 暗色深墨纸）；
 *   · 纸张里按杂志排版：16:9 封面、期号细线、衬线大标题、首字下沉、
 *     数据块、编号章节、当日速览时间线、引文与页脚。
 *
 * 主题适配（硬要求）：
 *   1. 所有颜色都收在 `.pa-journal-overlay` 上的 `--j-*` 变量里；
 *   2. 默认 + `.pa-root[data-pa-theme='dark']` 是同一套暗色 token；
 *   3. `.pa-root[data-pa-theme='light']` 覆盖成亮色一套；
 *   4. 组件规则里不出现硬编码的深色 / 白色（行内 SVG 封面除外，它自带配色）；
 *   5. 同时给 `.pa-journal-overlay` 设 `color-scheme`，让原生控件跟着主题走。
 *
 * 类名统一 pa-journal- 前缀；本文件是模板字符串，正文与注释里都不能出现反引号。
 */

export const JOURNAL_CSS = `
/* ───────────────────────── 主题 token：暗色（默认 + 显式 dark） ───────────────────────── */
.pa-journal-overlay {
  --j-ui-bg: #101114;
  --j-ui-panel: #16171b;
  --j-ui-panel-2: #1d1f24;
  --j-ui-text: #f2f3f5;
  --j-ui-text-2: #a9adb4;
  --j-ui-text-3: #757a82;
  --j-ui-line: rgba(255, 255, 255, 0.075);
  --j-ui-line-2: rgba(255, 255, 255, 0.14);
  --j-ui-hover: rgba(255, 255, 255, 0.065);
  --j-ui-glass: rgba(16, 17, 20, 0.82);
  --j-ui-accent: #ff9f0a;
  --j-paper: #171a20;
  --j-paper-2: #1d2128;
  --j-paper-grain: rgba(233, 228, 218, 0.035);
  --j-paper-edge: rgba(255, 255, 255, 0.06);
  --j-ink: #e9e4da;
  --j-ink-2: #c4bdb1;
  --j-ink-3: #918a7d;
  --j-rule: rgba(233, 228, 218, 0.17);
  --j-accent: #ff9f0a;
  --j-accent-soft: rgba(255, 159, 10, 0.16);
  --j-accent-line: rgba(255, 159, 10, 0.46);
  --j-shadow: 0 32px 90px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04);
  --j-hero-shadow: 0 20px 46px -20px rgba(0, 0, 0, 0.75);
  color-scheme: dark;
  position: absolute;
  inset: 0;
  /*
   * z-index 与合成层提示缺一不可（2026-11-02 实测踩过）：
   * 只写 z-index: 50 时，overlay 与主界面在 DOM 层叠顺序上是对的
   * （elementFromPoint 命中的确实是期刊元素），但**首次打开**的那一帧里
   * 聊天区/右栏会盖在期刊上面——主界面的滚动容器自己是一个合成层，
   * Chromium 在合成阶段没有把 overlay 提到它上面，等用户滚动一次或
   * 打开规则面板才恢复。截图验收时表现为「期刊与聊天半透明叠加」。
   *
   * translateZ(0) 让 overlay 也成为一个独立合成层，配合足够大的 z-index
   * 保证首次绘制就在最上层；这比等一帧后重绘可靠得多。
   */
  z-index: 9999;
  transform: translateZ(0);
  isolation: isolate;
  display: flex;
  overflow: hidden;
  color: var(--j-ui-text);
  background:
    radial-gradient(130% 100% at 50% -10%, var(--j-ui-panel-2) 0%, var(--j-ui-bg) 58%, var(--j-ui-bg) 100%);
  animation: pa-journal-fade 180ms ease both;
}
.pa-root[data-pa-theme='dark'] .pa-journal-overlay {
  --j-ui-bg: #101114;
  --j-ui-panel: #16171b;
  --j-ui-panel-2: #1d1f24;
  --j-ui-text: #f2f3f5;
  --j-ui-text-2: #a9adb4;
  --j-ui-text-3: #757a82;
  --j-ui-line: rgba(255, 255, 255, 0.075);
  --j-ui-line-2: rgba(255, 255, 255, 0.14);
  --j-ui-hover: rgba(255, 255, 255, 0.065);
  --j-ui-glass: rgba(16, 17, 20, 0.82);
  --j-ui-accent: #ff9f0a;
  --j-paper: #171a20;
  --j-paper-2: #1d2128;
  --j-paper-grain: rgba(233, 228, 218, 0.035);
  --j-paper-edge: rgba(255, 255, 255, 0.06);
  --j-ink: #e9e4da;
  --j-ink-2: #c4bdb1;
  --j-ink-3: #918a7d;
  --j-rule: rgba(233, 228, 218, 0.17);
  --j-accent: #ff9f0a;
  --j-accent-soft: rgba(255, 159, 10, 0.16);
  --j-accent-line: rgba(255, 159, 10, 0.46);
  --j-shadow: 0 32px 90px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04);
  --j-hero-shadow: 0 20px 46px -20px rgba(0, 0, 0, 0.75);
  color-scheme: dark;
}

/* ───────────────────────── 主题 token：亮色 ───────────────────────── */
.pa-root[data-pa-theme='light'] .pa-journal-overlay {
  --j-ui-bg: #e9e5dc;
  --j-ui-panel: #f4f0e8;
  --j-ui-panel-2: #ded9ce;
  --j-ui-text: #241f1a;
  --j-ui-text-2: #5f574c;
  --j-ui-text-3: #8b8173;
  --j-ui-line: rgba(36, 31, 26, 0.1);
  --j-ui-line-2: rgba(36, 31, 26, 0.18);
  --j-ui-hover: rgba(36, 31, 26, 0.055);
  --j-ui-glass: rgba(236, 232, 223, 0.86);
  --j-ui-accent: #a85a12;
  --j-paper: #faf6ec;
  --j-paper-2: #f2ecdf;
  --j-paper-grain: rgba(90, 72, 46, 0.045);
  --j-paper-edge: rgba(36, 31, 26, 0.08);
  --j-ink: #241f1a;
  --j-ink-2: #4a4137;
  --j-ink-3: #6f6354;
  --j-rule: rgba(36, 31, 26, 0.17);
  --j-accent: #a85a12;
  --j-accent-soft: rgba(168, 90, 18, 0.12);
  --j-accent-line: rgba(168, 90, 18, 0.4);
  --j-shadow: 0 26px 70px rgba(60, 45, 25, 0.2), 0 0 0 1px rgba(36, 31, 26, 0.05);
  --j-hero-shadow: 0 16px 34px -18px rgba(60, 45, 25, 0.4);
  color-scheme: light;
}

/* ───────────────────────── 基础重置 ───────────────────────── */
.pa-journal-overlay * { box-sizing: border-box; }
/*
 * 用 :where() 把重置选择器的特异性压到 0，否则「.pa-journal-overlay button」
 * （0,1,1）会盖掉下面所有单类名按钮规则（0,1,0）的 background / color / border，
 * 主按钮会变成「透明底 + 继承色」的纯文字。
 */
.pa-journal-overlay :where(button) {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.pa-journal-overlay :where(button:disabled) { cursor: not-allowed; }
.pa-journal-overlay :where(a) { color: inherit; text-decoration: none; }
.pa-journal-overlay ::-webkit-scrollbar { width: 8px; height: 8px; }
.pa-journal-overlay ::-webkit-scrollbar-thumb {
  background: var(--j-ui-line-2);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: content-box;
}
.pa-journal-overlay ::-webkit-scrollbar-track { background: transparent; }

.pa-journal-shell {
  flex: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
}

/* ───────────────────────── 书架 ───────────────────────── */
.pa-journal-shelf {
  width: 260px;
  flex: 0 0 260px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--j-ui-panel);
  border-right: 1px solid var(--j-ui-line);
  transition: width 200ms ease, flex-basis 200ms ease, opacity 160ms ease, visibility 0s linear 0s;
}
.pa-journal-shelf[data-collapsed='true'] {
  width: 0;
  flex-basis: 0;
  opacity: 0;
  border-right: 0;
  visibility: hidden;
  pointer-events: none;
  transition: width 200ms ease, flex-basis 200ms ease, opacity 160ms ease, visibility 0s linear 200ms;
}
.pa-journal-shelf__head {
  flex: none;
  min-width: 236px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 18px 14px 14px 16px;
  border-bottom: 1px solid var(--j-ui-line);
}
.pa-journal-shelf__brand {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}
.pa-journal-shelf__mark {
  width: 32px;
  height: 32px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--j-accent-soft);
  color: var(--j-ui-accent);
}
.pa-journal-shelf__titles { min-width: 0; }
.pa-journal-shelf__name {
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(15px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.3;
  color: var(--j-ui-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-shelf__issue {
  margin-top: 2px;
  font-size: calc(9px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--j-ui-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-shelf__collapse {
  width: 26px;
  height: 26px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: var(--j-ui-text-3);
  transition: background 120ms ease, color 120ms ease;
}
.pa-journal-shelf__collapse:hover { background: var(--j-ui-hover); color: var(--j-ui-text); }

.pa-journal-shelf__scroll {
  flex: 1;
  min-height: 0;
  min-width: 236px;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 10px 20px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pa-journal-group { display: flex; flex-direction: column; gap: 8px; }
.pa-journal-group__head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 14px 6px 6px;
  background: var(--j-ui-panel);
}
.pa-journal-group__label {
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(10px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.14em;
  color: var(--j-ui-text-2);
  white-space: nowrap;
}
.pa-journal-group__count {
  font-size: calc(9px + var(--pa-font-delta));
  letter-spacing: 0.08em;
  color: var(--j-ui-text-3);
  font-variant-numeric: tabular-nums;
}
.pa-journal-group__items { display: flex; flex-direction: column; gap: 8px; }
.pa-journal-shelf__empty {
  padding: 30px 12px;
  text-align: center;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.7;
  color: var(--j-ui-text-3);
}
.pa-journal-shelf__foot {
  flex: none;
  min-width: 236px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px 12px;
  border-top: 1px solid var(--j-ui-line);
  font-size: calc(9px + var(--pa-font-delta));
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--j-ui-text-3);
  font-variant-numeric: tabular-nums;
}

/* ───────────────────────── 书架封面卡 ───────────────────────── */
.pa-journal-card {
  position: relative;
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px;
  border-radius: 11px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition: background 130ms ease, border-color 130ms ease, box-shadow 130ms ease;
}
.pa-journal-card:hover { background: var(--j-ui-hover); }
.pa-journal-card:focus-visible {
  outline: 2px solid var(--j-accent-line);
  outline-offset: 2px;
}
.pa-journal-card[data-active='true'] {
  background: var(--j-ui-panel-2);
  border-color: var(--j-accent-line);
  box-shadow: inset 3px 0 0 var(--j-accent);
}
.pa-journal-card__cover {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 6px;
  background: var(--j-paper-2);
}
.pa-journal-card__cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 340ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 140ms ease;
}
.pa-journal-card:hover .pa-journal-card__cover img { transform: scale(1.03); }
.pa-journal-card[data-active='true'] .pa-journal-card__cover img { opacity: 0.94; }
.pa-journal-card__body { padding: 7px 4px 2px; }
.pa-journal-card__top {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.pa-journal-card__issue {
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(9px + var(--pa-font-delta));
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--j-ui-accent);
  white-space: nowrap;
}
.pa-journal-card__mood {
  margin-left: auto;
  flex: none;
  max-width: 96px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--j-accent-soft);
  color: var(--j-ui-accent);
  font-size: calc(9px + var(--pa-font-delta));
  line-height: 1.6;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-card__title {
  margin-top: 4px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(13px + var(--pa-font-delta));
  font-weight: 600;
  line-height: 1.42;
  color: var(--j-ui-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pa-journal-card__date {
  margin-top: 3px;
  font-size: calc(9.5px + var(--pa-font-delta));
  letter-spacing: 0.04em;
  color: var(--j-ui-text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ───────────────────────── 阅读台 ───────────────────────── */
.pa-journal-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(120% 80% at 50% -20%, var(--j-ui-panel-2) 0%, var(--j-ui-bg) 62%, var(--j-ui-bg) 100%);
}

/* 顶栏：次级 UI 色，不抢纸面 */
.pa-journal-toolbar {
  flex: none;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border-bottom: 1px solid var(--j-ui-line);
  background: var(--j-ui-glass);
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
  z-index: 2;
}
.pa-journal-iconbtn {
  width: 32px;
  height: 32px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--j-ui-text-2);
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}
.pa-journal-iconbtn:hover:not(:disabled) { background: var(--j-ui-hover); color: var(--j-ui-text); }
.pa-journal-iconbtn:active:not(:disabled) { transform: scale(0.94); }
.pa-journal-iconbtn:disabled { opacity: 0.26; }
.pa-journal-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px 0 8px;
  border-radius: 8px;
  color: var(--j-ui-text-2);
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 500;
  transition: background 120ms ease, color 120ms ease;
  flex: none;
}
.pa-journal-back:hover { background: var(--j-ui-hover); color: var(--j-ui-text); }
.pa-journal-toolbar__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-left: 4px;
}
.pa-journal-toolbar__label {
  font-size: calc(9px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--j-ui-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-toolbar__title {
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--j-ui-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-toolbar__nav { display: flex; align-items: center; gap: 2px; flex: none; }
.pa-journal-divider {
  width: 1px;
  height: 20px;
  margin: 0 3px;
  background: var(--j-ui-line);
  flex: none;
}
.pa-journal-rule-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border-radius: 8px;
  border: 1px solid var(--j-ui-line-2);
  font-size: calc(11.5px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--j-ui-text-2);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  flex: none;
}
.pa-journal-rule-toggle:hover { background: var(--j-ui-hover); color: var(--j-ui-text); }
.pa-journal-rule-toggle[data-on='true'] {
  background: var(--j-accent-soft);
  border-color: var(--j-accent-line);
  color: var(--j-ui-accent);
}

/* 阅读区滚动容器 */
.pa-journal-reader {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 36px 28px 72px;
}

/* ───────────────────────── 纸张 ───────────────────────── */
.pa-journal-paper {
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  padding: 50px 56px 34px;
  border-radius: 4px;
  color: var(--j-ink);
  background-color: var(--j-paper);
  background-image: radial-gradient(var(--j-paper-grain) 1px, transparent 1px);
  background-size: 3px 3px;
  box-shadow: var(--j-shadow);
  animation: pa-journal-paper-in 300ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-journal-paper ::selection { background: var(--j-accent-soft); }

/* 封面 */
.pa-journal-paper__hero {
  margin: 0 0 28px;
  border: 1px solid var(--j-paper-edge);
  border-radius: 5px;
  overflow: hidden;
  background: var(--j-paper-2);
  box-shadow: var(--j-hero-shadow);
}
.pa-journal-paper__hero img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
}

/* 期号 + 细线 + 日期 / 天气 / 心情 */
.pa-journal-paper__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-bottom: 16px;
}
.pa-journal-meta__issue {
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(10px + var(--pa-font-delta));
  font-weight: 700;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--j-accent);
  white-space: nowrap;
}
.pa-journal-meta__line {
  flex: 1;
  min-width: 24px;
  height: 1px;
  background: var(--j-rule);
}
.pa-journal-meta__tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: calc(10px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.1em;
  color: var(--j-ink-3);
  font-variant-numeric: tabular-nums;
}
.pa-journal-meta__dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--j-ink-3);
  flex: none;
}

/* 标题组 */
.pa-journal-title {
  margin: 0 0 10px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(clamp(30px, 4.4vw, 40px) + var(--pa-font-delta));
  font-weight: 600;
  line-height: 1.16;
  letter-spacing: -0.012em;
  color: var(--j-ink);
  text-wrap: balance;
}
.pa-journal-subtitle {
  margin: 0 0 24px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-style: italic;
  font-size: calc(15px + var(--pa-font-delta));
  line-height: 1.6;
  color: var(--j-ink-3);
}
.pa-journal-summary {
  margin: 0 0 8px;
  padding-bottom: 26px;
  border-bottom: 1px solid var(--j-rule);
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(15.5px + var(--pa-font-delta));
  line-height: 1.9;
  color: var(--j-ink-2);
  text-align: justify;
}
.pa-journal-summary::first-letter {
  float: left;
  padding: 6px 9px 0 0;
  font-size: calc(52px + var(--pa-font-delta));
  line-height: 0.9;
  font-weight: 600;
  color: var(--j-ink);
}

/* 本期数据 */
.pa-journal-stats {
  display: flex;
  flex-wrap: wrap;
  margin: 26px 0 30px;
  border-top: 1px solid var(--j-rule);
  border-bottom: 1px solid var(--j-rule);
}
.pa-journal-stat {
  flex: 1 1 0;
  min-width: 108px;
  padding: 15px 16px 13px;
  border-left: 1px solid var(--j-rule);
}
.pa-journal-stat:first-child { border-left: 0; padding-left: 0; }
.pa-journal-stat__value {
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(28px + var(--pa-font-delta));
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.01em;
  color: var(--j-ink);
  font-variant-numeric: tabular-nums;
}
.pa-journal-stat__label {
  margin-top: 6px;
  font-size: calc(10.5px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--j-ink-2);
}
.pa-journal-stat__hint {
  margin-top: 2px;
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--j-ink-3);
}

/* 编号章节 */
.pa-journal-sections { margin-top: 4px; }
.pa-journal-section {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 0 14px;
  padding: 22px 0;
  border-top: 1px solid var(--j-rule);
}
.pa-journal-section:first-child { border-top: 0; padding-top: 4px; }
.pa-journal-section__num {
  padding-top: 5px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(11px + var(--pa-font-delta));
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--j-accent);
  font-variant-numeric: tabular-nums;
}
.pa-journal-section__main { min-width: 0; }
.pa-journal-section__title {
  margin: 0 0 8px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(17px + var(--pa-font-delta));
  font-weight: 600;
  line-height: 1.45;
  color: var(--j-ink);
}
.pa-journal-section__text {
  margin: 0;
  font-size: calc(13.8px + var(--pa-font-delta));
  line-height: 1.95;
  color: var(--j-ink-2);
  text-align: justify;
}
.pa-journal-section__text + .pa-journal-section__text { margin-top: 10px; }
.pa-journal-bullets {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
}
.pa-journal-bullets li {
  position: relative;
  padding-left: 15px;
  margin: 0 0 6px;
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.85;
  color: var(--j-ink-2);
}
.pa-journal-bullets li::before {
  content: "";
  position: absolute;
  left: 1px;
  top: 0.74em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--j-ink-3);
}
.pa-journal-bullets li:last-child { margin-bottom: 0; }

/* 当日速览时间线 */
.pa-journal-highlights {
  margin: 30px 0 4px;
  padding-top: 22px;
  border-top: 1px solid var(--j-rule);
}
.pa-journal-highlights__title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 16px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(11px + var(--pa-font-delta));
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--j-ink-3);
}
.pa-journal-highlights__title::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--j-rule);
}
.pa-journal-timeline { display: flex; flex-direction: column; }
.pa-journal-tl {
  display: grid;
  grid-template-columns: 48px 14px minmax(0, 1fr);
  gap: 0 10px;
  padding: 0 0 18px;
}
.pa-journal-tl:last-child { padding-bottom: 0; }
.pa-journal-tl__time {
  padding-top: 1px;
  text-align: right;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(10.5px + var(--pa-font-delta));
  letter-spacing: 0.06em;
  color: var(--j-ink-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.pa-journal-tl__axis { position: relative; }
.pa-journal-tl__axis::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 12px;
  bottom: -18px;
  width: 1px;
  transform: translateX(-50%);
  background: var(--j-rule);
}
.pa-journal-tl:last-child .pa-journal-tl__axis::before { display: none; }
.pa-journal-tl__axis::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 5px;
  width: 7px;
  height: 7px;
  margin-left: -3.5px;
  border-radius: 50%;
  background: var(--j-paper);
  border: 1.5px solid var(--j-accent);
}
.pa-journal-tl__body { min-width: 0; padding-bottom: 2px; }
.pa-journal-tl__title {
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(13.5px + var(--pa-font-delta));
  font-weight: 600;
  line-height: 1.5;
  color: var(--j-ink);
}
.pa-journal-tl__text {
  margin-top: 3px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.75;
  color: var(--j-ink-3);
}
.pa-journal-tl__bot {
  display: inline-block;
  margin-top: 5px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--j-rule);
  font-size: calc(9px + var(--pa-font-delta));
  letter-spacing: 0.04em;
  color: var(--j-ink-3);
}

/* 引文 */
.pa-journal-quote {
  position: relative;
  margin: 30px 0 0;
  padding: 8px 0 8px 22px;
  border-left: 3px solid var(--j-accent);
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-style: italic;
  font-size: calc(18px + var(--pa-font-delta));
  line-height: 1.75;
  color: var(--j-ink);
}
.pa-journal-quote::before {
  content: "\\201C";
  position: absolute;
  left: 14px;
  top: -14px;
  font-size: calc(46px + var(--pa-font-delta));
  line-height: 1;
  color: var(--j-accent);
  opacity: 0.32;
}

/* 页脚 */
.pa-journal-footer {
  margin-top: 42px;
  padding-top: 14px;
  border-top: 1px solid var(--j-rule);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(9px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--j-ink-3);
}
.pa-journal-footer__page { font-variant-numeric: tabular-nums; white-space: nowrap; }

/* ───────────────────────── 空态 ───────────────────────── */
.pa-journal-empty {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 13px;
  padding: 48px 28px;
  text-align: center;
}
.pa-journal-empty__icon {
  width: 74px;
  height: 74px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--j-ui-hover);
  border: 1px solid var(--j-ui-line);
  color: var(--j-ui-text-3);
  margin-bottom: 4px;
}
.pa-journal-empty__title {
  margin: 0;
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(24px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--j-ui-text);
}
.pa-journal-empty__text {
  margin: 0;
  max-width: 420px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.8;
  color: var(--j-ui-text-3);
}
.pa-journal-empty__btn {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 16px;
  border-radius: 9px;
  background: var(--j-ui-text);
  color: var(--j-ui-bg);
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  transition: opacity 120ms ease, transform 100ms ease;
}
.pa-journal-empty__btn:hover { opacity: 0.88; }
.pa-journal-empty__btn:active { transform: scale(0.985); }
.pa-journal-empty__btn:disabled { opacity: 0.55; }
.pa-journal-empty__spinner {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid var(--j-ui-line-2);
  border-top-color: var(--j-ui-bg);
  animation: pa-journal-spin 800ms linear infinite;
}

/* ───────────────────────── 规则面板（右侧抽屉） ───────────────────────── */
.pa-journal-rule {
  position: absolute;
  top: 66px;
  right: 16px;
  bottom: 16px;
  width: 320px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--j-ui-panel);
  border: 1px solid var(--j-ui-line-2);
  border-radius: 14px;
  box-shadow: var(--j-shadow);
  animation: pa-journal-slide-in 220ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
}
.pa-journal-rule__head {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 15px 12px 12px 16px;
  border-bottom: 1px solid var(--j-ui-line);
}
.pa-journal-rule__heading { flex: 1; min-width: 0; }
.pa-journal-rule__title {
  margin: 0;
  font-size: calc(13.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--j-ui-text);
}
.pa-journal-rule__sub {
  margin: 3px 0 0;
  font-size: calc(10px + var(--pa-font-delta));
  letter-spacing: 0.06em;
  color: var(--j-ui-text-3);
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
  border: 1px solid var(--j-ui-line);
  background: var(--j-ui-hover);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.8;
  color: var(--j-ui-text-2);
}
.pa-journal-rule__text strong { color: var(--j-ui-text); font-weight: 600; }
.pa-journal-rule__settings {
  margin: 0 0 14px;
  border-top: 1px solid var(--j-ui-line);
}
.pa-journal-rule__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--j-ui-line);
  font-size: calc(11.5px + var(--pa-font-delta));
}
.pa-journal-rule__label { color: var(--j-ui-text-3); }
.pa-journal-rule__value {
  color: var(--j-ui-text);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.pa-journal-rule__value[data-off='true'] { color: var(--j-ui-text-3); }
.pa-journal-rule__actions {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.pa-journal-rule__btn {
  flex: 1;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 8px;
  background: var(--j-ui-hover);
  color: var(--j-ui-text);
  font-size: calc(11.5px + var(--pa-font-delta));
  font-weight: 500;
  transition: background 120ms ease, transform 100ms ease, opacity 120ms ease;
}
.pa-journal-rule__btn:hover { background: var(--j-ui-panel-2); }
.pa-journal-rule__btn:active { transform: scale(0.98); }
.pa-journal-rule__btn:disabled { opacity: 0.55; }
.pa-journal-rule__btn--primary {
  background: var(--j-ui-text);
  color: var(--j-ui-bg);
  font-weight: 600;
}
.pa-journal-rule__btn--primary:hover { background: var(--j-ui-text); opacity: 0.9; }
.pa-journal-rule__status {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 12px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--j-ui-text-3);
}
.pa-journal-rule__status-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--j-ui-accent);
  animation: pa-journal-pulse 1.4s ease-in-out infinite;
}
.pa-journal-rule__logs-title {
  margin: 0 0 6px;
  font-size: calc(9.5px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--j-ui-text-3);
}
.pa-journal-log {
  display: flex;
  gap: 9px;
  padding: 8px 0;
  border-bottom: 1px solid var(--j-ui-line);
}
.pa-journal-log:last-child { border-bottom: 0; }
.pa-journal-log__dot {
  width: 6px;
  height: 6px;
  margin-top: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--j-ui-accent);
}
.pa-journal-log[data-ok='false'] .pa-journal-log__dot { background: var(--j-ui-text-3); }
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
  color: var(--j-ui-accent);
}
.pa-journal-log[data-ok='false'] .pa-journal-log__badge { color: var(--j-ui-text-3); }
.pa-journal-log__reason {
  margin: 0;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.6;
  color: var(--j-ui-text-2);
  word-break: break-word;
}
.pa-journal-log__time {
  margin-top: 3px;
  font-size: calc(9.5px + var(--pa-font-delta));
  letter-spacing: 0.04em;
  color: var(--j-ui-text-3);
  font-variant-numeric: tabular-nums;
}
.pa-journal-rule__empty {
  padding: 10px 0;
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--j-ui-text-3);
}

/* ───────────────────────── 聊天里的期刊小卡 ─────────────────────────
 * 用 --pa-* 变量（小卡在聊天流里，不在 .pa-journal-overlay 内，拿不到 --j-*）。
 * 类名与 chat.css.ts 里旧的 .pa-journal 分开，避免优先级纠缠。
 */
.pa-journal-mini {
  width: min(100%, 470px);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 12px;
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  cursor: pointer;
  transition: background 130ms ease, border-color 130ms ease, transform 120ms ease;
}
.pa-journal-mini:hover { background: var(--pa-card-2); border-color: var(--pa-line-2); }
.pa-journal-mini:active { transform: scale(0.995); }
.pa-journal-mini:focus-visible { outline: 2px solid var(--pa-accent); outline-offset: 2px; }
.pa-journal-mini__cover {
  width: 72px;
  height: 40px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 6px;
  background: var(--pa-card-2);
  color: var(--pa-text-3);
}
.pa-journal-mini__cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pa-journal-mini__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pa-journal-mini__kicker {
  font-size: calc(9px + var(--pa-font-delta));
  line-height: 1.3;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--pa-accent);
}
.pa-journal-mini__title {
  font-family: Georgia, "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.4;
  font-weight: 600;
  color: var(--pa-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-mini__meta {
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: 1.35;
  color: var(--pa-text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-mini__summary {
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--pa-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-journal-mini__open {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--pa-text-2);
  background: transparent;
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
}
.pa-journal-mini:hover .pa-journal-mini__open {
  background: var(--pa-card-3);
  color: var(--pa-text);
  transform: translateX(1px);
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
@keyframes pa-journal-slide-in {
  from { opacity: 0; transform: translateX(18px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes pa-journal-spin {
  to { transform: rotate(360deg); }
}
@keyframes pa-journal-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .pa-journal-overlay,
  .pa-journal-paper,
  .pa-journal-rule,
  .pa-journal-card,
  .pa-journal-card__cover img,
  .pa-journal-mini,
  .pa-journal-mini__open,
  .pa-journal-rule__status-dot { animation: none !important; transition: none !important; }
}

/* ───────────────────────── 响应式 ───────────────────────── */

/* 中等宽度：书架收窄，纸张留白缩小 */
@media (max-width: 1180px) {
  .pa-journal-shelf { width: 236px; flex-basis: 236px; }
  .pa-journal-paper { padding: 44px 40px 30px; }
}

/* 窄屏：书架变成顶部横向滚动条，不横向溢出整页 */
@media (max-width: 900px) {
  .pa-journal-shell { flex-direction: column; }
  .pa-journal-shelf {
    width: auto;
    flex: 0 0 auto;
    max-height: 152px;
    border-right: 0;
    border-bottom: 1px solid var(--j-ui-line);
  }
  .pa-journal-shelf[data-collapsed='true'] {
    width: auto;
    flex-basis: auto;
    max-height: 0;
    opacity: 0;
    border-bottom: 0;
  }
  .pa-journal-shelf__head {
    min-width: 0;
    align-items: center;
    padding: 10px 14px 2px;
    border-bottom: 0;
  }
  .pa-journal-shelf__mark { width: 26px; height: 26px; border-radius: 7px; }
  .pa-journal-shelf__name { font-size: calc(13px + var(--pa-font-delta)); }
  .pa-journal-shelf__scroll {
    min-width: 0;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 8px 12px 12px;
    gap: 8px;
  }
  .pa-journal-group { display: contents; }
  .pa-journal-group__head { display: none; }
  .pa-journal-group__items { flex-direction: row; gap: 8px; }
  /* 横向滚动条里用横向小卡：封面 72x40 + 期号 / 标题 / 日期，整条高度可控 */
  .pa-journal-card {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 224px;
    flex: 0 0 224px;
  }
  .pa-journal-card__cover {
    width: 72px;
    flex: none;
    aspect-ratio: 16 / 9;
    border-radius: 5px;
  }
  .pa-journal-card__body { flex: 1; min-width: 0; padding: 0; }
  .pa-journal-card__mood { max-width: 62px; }
  .pa-journal-card__title { margin-top: 2px; -webkit-line-clamp: 1; }
  .pa-journal-card__date { margin-top: 1px; }
  .pa-journal-shelf__foot { display: none; }
  .pa-journal-toolbar { height: 52px; padding: 0 10px; }
  .pa-journal-toolbar__label { display: none; }
  .pa-journal-reader { padding: 20px 14px 44px; }
  .pa-journal-paper { padding: 30px 24px 26px; }
  .pa-journal-title { font-size: calc(clamp(26px, 5.2vw, 34px) + var(--pa-font-delta)); }
  .pa-journal-rule {
    top: auto;
    left: 12px;
    right: 12px;
    bottom: 12px;
    width: auto;
    max-height: 74%;
  }
}

/* 手机宽度：标题再降一档，数据块两列 */
@media (max-width: 640px) {
  .pa-journal-back span { display: none; }
  .pa-journal-back { padding: 0 8px; }
  .pa-journal-toolbar__info { display: none; }
  .pa-journal-toolbar__nav { margin-left: auto; }
  .pa-journal-rule-toggle span { display: none; }
  .pa-journal-rule-toggle { padding: 0 9px; }
  .pa-journal-reader { padding: 14px 10px 36px; }
  .pa-journal-paper { padding: 22px 17px 22px; border-radius: 3px; }
  .pa-journal-paper__hero { margin-bottom: 20px; }
  .pa-journal-title { font-size: calc(26px + var(--pa-font-delta)); }
  .pa-journal-subtitle { font-size: calc(13.5px + var(--pa-font-delta)); margin-bottom: 18px; }
  .pa-journal-summary { font-size: calc(14px + var(--pa-font-delta)); }
  .pa-journal-summary::first-letter { font-size: calc(42px + var(--pa-font-delta)); padding: 5px 7px 0 0; }
  .pa-journal-stats { margin: 20px 0 24px; }
  .pa-journal-stat { flex: 1 1 44%; min-width: 0; padding: 12px 12px 10px; }
  .pa-journal-stat:nth-child(odd) { border-left: 0; padding-left: 0; }
  .pa-journal-stat:nth-child(n+3) { border-top: 1px solid var(--j-rule); }
  .pa-journal-stat__value { font-size: calc(23px + var(--pa-font-delta)); }
  .pa-journal-section { grid-template-columns: 32px minmax(0, 1fr); gap: 0 10px; padding: 18px 0; }
  .pa-journal-section__title { font-size: calc(15.5px + var(--pa-font-delta)); }
  .pa-journal-section__text { font-size: calc(13.2px + var(--pa-font-delta)); line-height: 1.9; }
  .pa-journal-tl { grid-template-columns: 40px 12px minmax(0, 1fr); gap: 0 8px; }
  .pa-journal-quote { font-size: calc(16px + var(--pa-font-delta)); padding-left: 16px; }
  .pa-journal-footer { flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 32px; }
  .pa-journal-empty { padding: 36px 18px; }
  .pa-journal-empty__text { max-width: 100%; }
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
