/**
 * dsh-seeker-bot — Bot 控制台样式（侧栏名册 / 新建表单 / 详情抽屉 / 右栏面板）。
 *
 * 只用 DSH 主题变量 --dsw-alias-*；白底细线、无渐变发光。
 * 与 echo-viewport 共用一张 style（面板要用它的画面样式，而 KR 样式在本插件
 * 关闭 KR 视图时不会注入）。
 */

import { echoViewportStyles } from '../echo-viewport/styles.ts'

const BOT_CORE_STYLES = `/* ══ Bot 控制台：侧栏名册 / 新建表单 / 详情抽屉 / 右栏面板 ═══════════════
 * 设计系统：只使用 --dsw-alias-*（背景、分隔线、标签、状态色）。
 * 白底细线、无渐变、无发光；暗色由 DSH 主题变量跟随系统。
 * ══════════════════════════════════════════════════════════════════════ */

.skb-host {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 6px;
  box-sizing: border-box;
  /* 官方 regionArea 是 flex column；host 必须保留自身高度，不能被下面的
     工作区 flex:1 挤扁（挤扁后按钮可见但点击命中会落到父级 div 上）。 */
  flex: 0 0 auto;
  width: 100%;
}

/* ── Work / Bot 滑块（独立放在「新会话」上方）──────────────────────── */
.skb-mode-host {
  flex: 0 0 auto;
  width: 100%;
  padding: 8px 10px 2px;
  box-sizing: border-box;
}
.skb-mode {
  position: relative;
  display: flex;
  padding: 3px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.035));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  box-sizing: border-box;
}
.skb-mode-thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc(50% - 3px);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 0 0 0.5px var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  transition: transform 0.24s cubic-bezier(0.22, 0.8, 0.24, 1);
  pointer-events: none;
}
.skb-mode[data-mode="bot"] .skb-mode-thumb { transform: translateX(100%); }
.skb-mode button {
  position: relative;
  z-index: 1;
  flex: 1;
  height: 27px;
  border: 0;
  border-radius: 6px;
  font: inherit;
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary, #61666b);
  background: transparent;
  cursor: pointer;
  transition: color 0.18s ease;
}
.skb-mode button:hover { color: var(--dsw-alias-label-primary, #0f1115); }
.skb-mode button.on {
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-weight: 500;
  box-shadow: none;
}

/* Bot 模式独占侧栏：官方菜单 / 插件菜单让位，只留品牌、新会话、滑块与名册。 */
body[data-skb-mode="bot"] [data-skb-native-hide="true"] { display: none !important; }
body[data-skb-mode="work"] #skb-sidebar-host { display: none !important; }

/* ── Bot 对话流头部（名称 / 岗位 / 状态 + 页签）──────────────────── */
.skb-bot-header {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: none;
  min-height: 48px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-base, #fff);
  box-sizing: border-box;
}
.skb-bot-header__identity { display: flex; align-items: center; gap: 8px; min-width: 0; }
.skb-bot-header__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--dsw-alias-label-on-primary, #fff);
  font-size: 12px;
  font-weight: 600;
  flex: none;
}
.skb-bot-header__name { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, #0f1115); white-space: nowrap; }
.skb-bot-header__role { font-size: 11px; color: var(--dsw-alias-label-tertiary, #81858c); white-space: nowrap; }
.skb-bot-header__status {
  margin-left: 2px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.04));
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary, #61666b);
  white-space: nowrap;
}
.skb-bot-tabs { display: flex; align-items: center; gap: 2px; margin-left: 6px; }
.skb-bot-tab {
  height: 27px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #61666b);
  cursor: pointer;
}
.skb-bot-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
.skb-bot-tab[data-active="true"] {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.04));
  color: var(--dsw-alias-label-primary, #0f1115);
  font-weight: 500;
}
body[data-skb-mode="work"] .skb-bot-header { display: none !important; }

/* ── 新建 Bot 入口与内联表单 ─────────────────────────────────────── */
.skb-actions { display: flex; justify-content: flex-end; }
.skb-new {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.skb-new:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--dsw-alias-label-primary, #0f1115);
}
.skb-form {
  display: none;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.02));
}
.skb-form[data-open="true"] { display: flex; }
.skb-form-row { display: flex; gap: 6px; }
.skb-form-row > * { flex: 1; min-width: 0; }
.skb-input,
.skb-select,
.skb-textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 5px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit;
  font-size: 12px;
  padding: 4px 6px;
  outline: none;
}
.skb-input:focus,
.skb-select:focus,
.skb-textarea:focus { border-color: var(--dsw-alias-border-focus, #3b82f6); }
.skb-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.skb-btn {
  height: 25px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.skb-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
.skb-btn--primary {
  background: var(--dsw-alias-button-primary-fill, #0f1115);
  border-color: var(--dsw-alias-button-primary-fill, #0f1115);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.skb-btn--danger {
  color: var(--dsw-alias-state-error-primary, #dc2626);
  border-color: var(--dsw-alias-state-error-primary, #dc2626);
  background: transparent;
}
.skb-btn:disabled { opacity: .5; cursor: default; }

/* ── 名册 ────────────────────────────────────────────────────────── */
.skb-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 46vh;
  overflow: auto;
}
.skb-sec {
  font-size: 10px;
  color: var(--dsw-alias-label-caption, #adb2b8);
  padding: 7px 7px 2px;
  letter-spacing: .3px;
}
.skb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 7px;
  border-radius: 7px;
  cursor: pointer;
  border: 1px solid transparent;
}
.skb-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
.skb-row--active {
  background: var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, 0.07));
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
}
.skb-avatar {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  color: var(--dsw-alias-label-primary-foreground, #fff);
  flex: none;
}
.skb-avatar svg { width: 14px; height: 14px; fill: currentColor; stroke: none; }
.skb-meta { flex: 1; min-width: 0; }
.skb-name {
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary, #0f1115);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.skb-role {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.skb-badge {
  font-size: 9.5px;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 20px;
  border: 1px solid currentColor;
  background: transparent;
  flex: none;
}
.skb-badge--needs { color: var(--dsw-alias-state-warning-primary, #b45309); }
.skb-badge--unread { color: var(--dsw-alias-state-business-primary, #3b82f6); }
.skb-badge--working { color: var(--dsw-alias-state-success-primary, #16a34a); }
.skb-star {
  flex: none;
  font-size: 11px;
  line-height: 1;
  color: var(--dsw-alias-state-warning-primary, #b45309);
}
.skb-row__more {
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.skb-row__more:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--dsw-alias-label-primary, #0f1115);
}
.skb-empty {
  font-size: 11.5px;
  color: var(--dsw-alias-label-caption, #adb2b8);
  padding: 5px 7px;
}
.skb-status {
  min-height: 15px;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  padding: 0 7px;
  word-break: break-all;
}
.skb-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #dc2626); }
.skb-status[data-tone="notice"] { color: var(--dsw-alias-label-secondary, #61666b); }

[data-skb-official-hidden="true"] { display: none !important; }

/* ── 详情抽屉 ────────────────────────────────────────────────────── */
.skb-drawer {
  position: fixed;
  inset: 0;
  z-index: 100200;
  pointer-events: none;
}
.skb-drawer__mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.32));
  opacity: 0;
  transition: opacity .18s ease;
  pointer-events: none;
}
.skb-drawer[data-open="true"] { pointer-events: auto; }
.skb-drawer[data-open="true"] .skb-drawer__mask { opacity: 1; pointer-events: auto; }
.skb-drawer__panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(92vw, 400px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #fff);
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  box-shadow: -8px 0 24px var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.12));
  transform: translateX(100%);
  transition: transform .2s ease;
}
.skb-drawer[data-open="true"] .skb-drawer__panel { transform: translateX(0); }
.skb-drawer__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.08));
}
.skb-drawer__title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.skb-drawer__subtitle {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.skb-drawer__close {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.skb-drawer__close:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--dsw-alias-label-primary, #0f1115);
}
.skb-drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 14px 16px;
}
.skb-drawer__section {
  padding: 10px 0;
  border-bottom: 1px solid var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.08));
}
.skb-drawer__section:last-child { border-bottom: 0; }
.skb-drawer__section-title {
  font-size: 11px;
  color: var(--dsw-alias-label-caption, #adb2b8);
  margin-bottom: 7px;
  letter-spacing: .3px;
}
.skb-drawer__field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.skb-drawer__field:last-child { margin-bottom: 0; }
.skb-drawer__label {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #61666b);
}
.skb-drawer__check { display: flex; align-items: center; gap: 6px; }
.skb-drawer__check input { width: 13px; height: 13px; margin: 0; }
.skb-drawer__actions { display: flex; flex-wrap: wrap; gap: 6px; }
.skb-drawer__error {
  min-height: 15px;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.skb-drawer__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.08));
}
.skb-drawer__footer-spacer { flex: 1; }

/* ── 右栏 Bot 面板：只有画面，没有标题 / 说明文字 / 终端 ──────────── */
#dsh-bot-panel-container {
  flex: 0 0 336px;
  min-width: 280px;
  max-width: 380px;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  background: var(--dsw-alias-bg-base, #fff);
  overflow: hidden;
  box-sizing: border-box;
}
.skb-bot-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 12px;
  overflow-y: auto;
  box-sizing: border-box;
}
/* 右栏卡片堆叠（对齐 Bot 控制台原型） */
.skb-bot-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 10px 10px 14px;
  overflow-y: auto;
  box-sizing: border-box;
}
.skb-card {
  flex: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  background: var(--dsw-alias-bg-base, #fff);
  overflow: hidden;
}
.skb-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 8px 11px;
  border-bottom: 1px solid var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.07));
}
.skb-card__title {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.skb-card__meta {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.skb-card__action {
  flex: none;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 999px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.skb-card__action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
.skb-card__viewport {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.02));
}
.skb-card__viewport:empty { min-height: 120px; }
.skb-card__viewport .kr-echo-viewport {
  width: 100%;
  height: 100%;
  margin: 0;
  border: 0;
  border-radius: 0;
  align-self: stretch;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.02));
}
.skb-card__viewport .kr-echo-viewport__badge { display: none; }
.skb-card__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 6px 7px;
}
.skb-row-line {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: 5px;
  background: none;
  font: inherit;
  font-size: 11.5px;
  text-align: left;
  color: var(--dsw-alias-label-secondary, #61666b);
  cursor: pointer;
}
.skb-row-line:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
.skb-row-line__mark { flex: none; width: 12px; text-align: center; color: var(--dsw-alias-label-caption, #adb2b8); }
.skb-row-line__mark[data-running="true"] { color: var(--dsw-alias-state-success-primary, #16a34a); }
.skb-row-line__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.skb-row-line__meta { margin-left: auto; flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #81858c); }
.skb-bot-card { display: flex; align-items: center; gap: 8px; padding: 10px 11px 8px; }
.skb-bot-card__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--dsw-alias-label-on-primary, #fff);
  font-size: 13px;
  font-weight: 600;
  flex: none;
}
.skb-bot-card__meta { min-width: 0; }
.skb-bot-card__name { font-size: 12.5px; color: var(--dsw-alias-label-primary, #0f1115); }
.skb-bot-card__status { margin-top: 1px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #81858c); }
.skb-bot-card__icon { margin-left: auto; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; }
.skb-bot-card__icon + .skb-bot-card__icon { margin-left: 8px; }
.skb-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 7px 11px;
  border: 0;
  border-top: 1px solid var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.07));
  background: none;
  font: inherit;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  cursor: pointer;
}
.skb-card__footer:disabled { cursor: default; }
.skb-output-group { padding-top: 4px; }
.skb-output-group__head {
  display: flex;
  justify-content: space-between;
  padding: 5px 6px 1px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.skb-file-tree { padding-bottom: 8px; }
.skb-file-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 2px 6px 2px 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #61666b);
}
.skb-file-row[data-depth="1"] { padding-left: 18px; }
.skb-file-row[data-depth="2"] { padding-left: 30px; }
.skb-file-icon { flex: none; width: 10px; color: var(--dsw-alias-label-caption, #adb2b8); }
.skb-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skb-file-size { margin-left: auto; flex: none; font-size: 9.5px; color: var(--dsw-alias-label-caption, #adb2b8); }

/* 面板挂载时把会话区变成右栏布局（官方 KR 未开启时 content 不一定是 flex）。 */
body[data-skb-mode="bot"][data-skb-panel="on"] [data-conversation-content] {
  display: flex !important;
  flex-direction: row !important;
  position: relative !important;
  overflow: hidden !important;
}
body[data-skb-mode="bot"][data-skb-panel="on"] [data-conversation-scroll] {
  flex: 1 1 0;
  min-width: 0;
}

/* 面板挂载时隐藏 KR 大盘：两套右栏不同时可见（各自独立的 React 根与容器，
 * 禁止往同一容器重复 createRoot）。 */
body[data-skb-mode="bot"][data-skb-panel="on"] #dsh-kr-panel-container {
  display: none !important;
}

/* ── 详情抽屉里的「日程」区 ─────────────────────────────────────────── */
.skb-drawer__hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, #81858c);
  margin: -2px 0 6px;
}
.skb-routines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}
.skb-routine-empty {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  padding: 4px 0 6px;
}
.skb-routine {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 5px 0;
  border-top: 1px solid var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.08));
}
.skb-routine:first-child { border-top: 0; }
.skb-routine input[type="checkbox"] { flex: none; }
.skb-routine__meta { flex: 1; min-width: 0; }
.skb-routine__name {
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #0f1115);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.skb-routine__sub {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.skb-routine__act {
  flex: none;
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 5px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.skb-routine__act:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
.skb-routine__act--danger:hover { color: var(--dsw-alias-state-error-primary, #dc2626); }
.skb-routine-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.08));
}
`

export const BOT_STYLE_ID = 'skb-styles'
export const BOT_STYLES = echoViewportStyles + BOT_CORE_STYLES

/** 幂等注入（live reload 时刷新旧 <style> 的内容，避免旧样式残留）。 */
export function injectBotStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(BOT_STYLE_ID)
  if (existing !== null) {
    if (existing.textContent !== BOT_STYLES) existing.textContent = BOT_STYLES
    return
  }
  const el = document.createElement('style')
  el.id = BOT_STYLE_ID
  el.textContent = BOT_STYLES
  const head = document.head ?? document.documentElement
  head?.appendChild(el)
}
