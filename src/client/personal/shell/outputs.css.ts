/**
 * dsh-seeker-bot — 右栏「产出物」卡与预览弹层样式。
 *
 * 与另外几套 personal-agent 样式同一注入模式：一个幂等函数 + 固定 style id，
 * index.tsx / standalone.tsx 统一调用 `injectOutputsStyles()`。
 *
 * 约束（本轮契约）：
 *   · 选择器加 `pa-out-` 前缀，避免和别的队友新增的类名打架；
 *   · 只用 `--pa-*` 设计 token（base.css.ts 已在 `.pa-root` 上给出深浅两套），
 *     不引用 `--dsw-alias-*` —— Personal Agent 是独立壳层，不保证官方 token 存在；
 *   · 深浅主题适配：token 本身随 `[data-pa-theme]` 切换，个别白色叠加（hover、
 *     缩略图底）用 `color-mix` 从 `--pa-text` 派生，不再写死 rgba 白色。
 *
 * 视觉基准是 Work 右栏的 `.kr-card--outputs / .kr-out-*`：卡头盒子图标 +「产出物」
 * +「N 项 · M 类」、类别发丝线组标题、28px SVG 缩略图、文件名 + 具体时间。
 */

export const PERSONAL_OUTPUTS_CSS = `
/* ── 右栏顶栏与卡间节奏 ───────────────────────────────────────────────
 * RightPanel 重写后只剩通话条 + 极简顶栏 + 两张卡（BotEcho 回显已于 2026-11-02
 * 按用户要求整体删除）。顶栏与卡间距在这里补齐（shell.css.ts 仍是旧的三 tab 版
 * 布局，不在本轮写作用域内）。
 * 用 .pa-right 前缀提高优先级，保证本文件无论何时注入都能覆盖基础布局。 */
.pa-right .pa-right__topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--pa-line);
  min-width: 0;
}
.pa-right .pa-right__topbar-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.pa-right .pa-right__topbar-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(14px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--pa-text);
}
.pa-right .pa-right__topbar-role {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-right .pa-right__topbar-close {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--pa-text-2);
  background: rgba(128, 132, 140, 0.13);
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
}
.pa-right .pa-right__topbar-close:hover {
  background: rgba(128, 132, 140, 0.26);
  color: var(--pa-text);
}
.pa-right .pa-right__topbar-close:active { transform: scale(0.94); }
.pa-right .pa-right__topbar-close:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 1px;
}
/* 右栏滚动区沿用 shell.css.ts 的块级布局（padding: 2px 16px 26px）；
 * 卡间距由两张卡各自的 margin-top 负责 —— 产出物卡与任务记录卡统一 10px，
 * 不在这里加 flex gap，否则任务卡自带的 margin-top 会叠成 20px。 */

/* ── 产出物卡 ─────────────────────────────────────────────────────── */
.pa-out-card {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--pa-line);
  border-radius: var(--pa-radius-card);
  background: var(--pa-card);
  color: var(--pa-text);
}

/* 卡头：整行是折叠热区。 */
.pa-out-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  cursor: pointer;
  user-select: none;
}
.pa-out-head:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 2px;
  border-radius: 6px;
}
.pa-out-head__icon {
  flex: none;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-2);
}
.pa-out-head__icon svg { display: block; }
.pa-out-head__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(13px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
}
.pa-out-head__meta {
  flex: none;
  white-space: nowrap;
  font-size: calc(11px + var(--pa-font-delta));
  font-weight: 500;
  line-height: calc(16px + var(--pa-font-delta) * 1.4545);
  color: var(--pa-text-3);
  font-variant-numeric: tabular-nums;
  transition: color 160ms ease;
}
.pa-out-head:hover .pa-out-head__meta { color: var(--pa-text-2); }
.pa-out-head__chev {
  flex: none;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-3);
  transition: transform 180ms ease, color 140ms ease;
}
.pa-out-head:hover .pa-out-head__chev { color: var(--pa-text-2); }
.pa-out-head__chev[data-open='true'] { transform: rotate(180deg); }

/* 正文 / 分组 */
.pa-out-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.pa-out-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.pa-out-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
/* 组标题：类别名 + 发丝线 + 计数，刻意做轻，不抢文件行。 */
.pa-out-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 2px 8px 1px;
  color: var(--pa-text-3);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.45;
  letter-spacing: 0.02em;
  user-select: none;
}
.pa-out-group__name { flex: none; font-weight: 500; }
.pa-out-group__rule {
  flex: 1 1 auto;
  height: 0;
  border-top: 1px solid var(--pa-line);
  opacity: 0.8;
}
.pa-out-group__count { flex: none; font-variant-numeric: tabular-nums; }

/* 文件行：整行一个 button，键盘可聚焦、触屏有反馈。
 * 选择器带 .pa-root 前缀：base.css.ts 的 .pa-root button 重置（font / color /
 * background / padding）是 (0,1,1)，比单独的 .pa-out-row 更高；不提权的话
 * padding 与字号会被重置吃掉。 */
.pa-root .pa-out-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  color: var(--pa-text-2);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.5;
  -webkit-tap-highlight-color: transparent;
  transition: background-color 120ms linear;
}
.pa-root .pa-out-row:hover { background: rgba(128, 132, 140, 0.12); }
.pa-root[data-pa-theme='light'] .pa-out-row:hover { background: rgba(15, 17, 21, 0.055); }
.pa-root .pa-out-row:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: -2px;
}
.pa-root .pa-out-row:active { background: rgba(128, 132, 140, 0.18); }

/* 类型缩略图：28px SVG，底色按「成果型 / 材料型」两档亮度区分。 */
.pa-out-row__thumb {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--pa-line-2);
  /* 先给中性底色兜底（不支持 color-mix 的浏览器也不至于完全透明），
     再用主题文字色派生 —— 深浅两套自动适配。 */
  background: rgba(128, 132, 140, 0.1);
  background: color-mix(in srgb, var(--pa-text) 5%, transparent);
  color: var(--pa-text-2);
  overflow: hidden;
  transition: transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1), border-color 160ms linear;
}
.pa-out-row__thumb svg { display: block; width: 28px; height: 28px; }
.pa-out-row:hover .pa-out-row__thumb {
  transform: scale(1.06);
  border-color: var(--pa-line-2);
}
/* 成果型（图 / 视频 / 音频 / 演示 / 网页）：底稍实、图标最亮。 */
.pa-out-row[data-kind='image'] .pa-out-row__thumb,
.pa-out-row[data-kind='video'] .pa-out-row__thumb,
.pa-out-row[data-kind='audio'] .pa-out-row__thumb,
.pa-out-row[data-kind='slide'] .pa-out-row__thumb,
.pa-out-row[data-kind='page'] .pa-out-row__thumb {
  background: color-mix(in srgb, var(--pa-text) 10%, transparent);
  color: var(--pa-text);
}
/* 材料型（文档 / PDF / 表格 / 压缩包 / 其他）：底更淡。 */
.pa-out-row[data-kind='doc'] .pa-out-row__thumb,
.pa-out-row[data-kind='pdf'] .pa-out-row__thumb,
.pa-out-row[data-kind='sheet'] .pa-out-row__thumb,
.pa-out-row[data-kind='archive'] .pa-out-row__thumb,
.pa-out-row[data-kind='file'] .pa-out-row__thumb {
  background: color-mix(in srgb, var(--pa-text) 4%, transparent);
  color: var(--pa-text-2);
}

.pa-out-row__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pa-text);
  font-weight: 500;
}
.pa-out-row__time {
  flex: none;
  margin-left: 6px;
  color: var(--pa-text-3);
  font-size: calc(10px + var(--pa-font-delta));
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 加载中 / 接口失败：一行轻提示，卡头仍在。 */
.pa-out-state {
  padding: 7px 8px 5px;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-out-state--error { color: var(--pa-text-3); opacity: 0.9; }

/* ── 预览弹层 ─────────────────────────────────────────────────────── */
.pa-out-preview {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(6px);
  animation: pa-out-fade 160ms ease both;
}
.pa-out-preview__panel {
  display: flex;
  flex-direction: column;
  width: min(920px, calc(100vw - 64px));
  height: min(720px, calc(100vh - 64px));
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--pa-line-2);
  border-radius: 14px;
  background: var(--pa-card);
  color: var(--pa-text);
  box-shadow: var(--pa-shadow-pop);
  overflow: hidden;
  animation: pa-out-pop 190ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
}
.pa-out-preview__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--pa-line);
}
.pa-out-preview__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(13px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
}
.pa-out-preview__meta {
  flex: none;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  white-space: nowrap;
}
/* 关闭按钮同样是 button：带 .pa-root 前缀压过 base 的按钮重置。 */
.pa-root .pa-out-preview__close {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(128, 132, 140, 0.14);
  color: var(--pa-text-2);
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
}
.pa-root .pa-out-preview__close:hover {
  background: rgba(128, 132, 140, 0.28);
  color: var(--pa-text);
}
.pa-root .pa-out-preview__close:active { transform: scale(0.94); }
.pa-root .pa-out-preview__close:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 1px;
}
.pa-out-preview__body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  background: var(--pa-bg);
}
.pa-out-preview__img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.pa-out-preview__media {
  display: block;
  max-width: 100%;
  max-height: 100%;
  background: #000;
}
.pa-out-preview__audio {
  width: min(520px, calc(100% - 48px));
  padding: 16px;
  display: flex;
  align-items: center;
}
.pa-out-preview__audio audio { width: 100%; }
.pa-out-preview__frame {
  flex: 1 1 auto;
  align-self: stretch;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
.pa-out-preview__file {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px;
  color: var(--pa-text-2);
  text-align: center;
}
.pa-out-preview__file-icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border: 1px solid var(--pa-line-2);
  border-radius: 12px;
  background: rgba(128, 132, 140, 0.1);
  background: color-mix(in srgb, var(--pa-text) 5%, transparent);
  color: var(--pa-text-2);
}
.pa-out-preview__file-icon svg { width: 56px; height: 56px; }
.pa-out-preview__file-name {
  max-width: 100%;
  font-size: calc(12px + var(--pa-font-delta));
  color: var(--pa-text-2);
  word-break: break-all;
}
.pa-out-preview__open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 16px;
  border-radius: 9px;
  background: rgba(255, 159, 10, 0.14);
  background: color-mix(in srgb, var(--pa-accent) 14%, transparent);
  color: var(--pa-accent);
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 500;
  text-decoration: none;
  transition: background 120ms ease;
}
.pa-out-preview__open:hover { background: rgba(255, 159, 10, 0.24); background: color-mix(in srgb, var(--pa-accent) 24%, transparent); }
.pa-out-preview__open:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 2px;
}

@keyframes pa-out-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes pa-out-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.975); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 640px) {
  .pa-out-preview { padding: 12px; }
  .pa-out-preview__panel {
    width: calc(100vw - 24px);
    height: calc(100vh - 24px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pa-out-row__thumb { transition: none; }
  .pa-out-row:hover .pa-out-row__thumb { transform: none; }
  .pa-out-head__chev { transition: none; }
  .pa-out-preview { animation: none; }
  .pa-out-preview__panel { animation: none; }
}
`

let injected = false

/** 幂等注入产出物卡与预览弹层样式；返回是否本次真正插入。 */
export function injectOutputsStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-outputs-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-outputs-styles'
  style.textContent = PERSONAL_OUTPUTS_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function outputsStylesInjected(): boolean {
  return injected
}
