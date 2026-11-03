/**
 * Personal Agent — 设置卡样式（Bot 设置 / 群聊设置 / 全局设置共用）。
 *
 * 统一的「右侧滑出卡片」：半透明遮罩 + 右贴边、全高、左侧圆角的容器。
 * 与旧版居中弹窗的区别只在容器，卡内控件继续沿用 base.css.ts 的
 * `.pa-field` / `.pa-btn` / `.pa-select`，所以深浅主题、字号跟随等行为一致。
 *
 * 约定：
 *  · 类名前缀 `pa-sheet-*`（容器 / 分区 / 表单行）与 `pa-bset-*`（Bot 设置专用行）；
 *  · 颜色一律走 `--pa-*` token（`--pa-right` / `--pa-card` / `--pa-line` / `--pa-text-*`），
 *    深浅主题只在阴影和遮罩浓度上各补一条覆盖，不另写一套色板；
 *  · 由 index.tsx / standalone.tsx 调用 `injectSettingsStyles()` 幂等注入，
 *    style id 自管理（`pa-settings-styles`），不碰别人的 <style>。
 */

export const SETTINGS_CSS = `
/* ───────────────────────── 右侧滑出卡片底座 ───────────────────────── */
/*
 * z-index 取 75：高于普通弹窗（40）与通话弹层（70），设置卡打开时压住通话；
 * 低于 toast（80）与 PaSelect 弹层（1300），保存后的提示和下拉选项不会被遮住。
 */
.pa-sheet-overlay {
  position: fixed;
  inset: 0;
  z-index: 75;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.42);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  animation: pa-sheet-fade 160ms ease both;
}
.pa-sheet {
  --pa-sheet-shadow: -28px 0 70px rgba(0, 0, 0, 0.46);
  display: flex;
  flex-direction: column;
  width: min(460px, 92vw);
  height: 100%;
  max-height: 100%;
  min-height: 0;
  background: var(--pa-right);
  color: var(--pa-text);
  border-left: 1px solid var(--pa-line);
  border-radius: 16px 0 0 16px;
  box-shadow: var(--pa-sheet-shadow);
  overflow: hidden;
  animation: pa-sheet-slide 220ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
}
.pa-root[data-pa-theme='light'] .pa-sheet-overlay {
  background: rgba(15, 17, 21, 0.22);
}
.pa-root[data-pa-theme='light'] .pa-sheet {
  --pa-sheet-shadow: -20px 0 52px rgba(15, 17, 21, 0.18);
}

.pa-sheet__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--pa-line);
}
.pa-sheet__head-text { flex: 1; min-width: 0; }
.pa-sheet__title {
  font-size: calc(16px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--pa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-sheet__sub {
  margin-top: 2px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-sheet__close {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-3);
  flex: none;
  transition: background 120ms ease, color 120ms ease;
}
.pa-sheet__close:hover { background: rgba(128, 132, 140, 0.18); color: var(--pa-text); }

.pa-sheet__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 18px 20px 24px;
  overscroll-behavior: contain;
}
.pa-sheet__foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--pa-line);
  background: var(--pa-card);
}

/* ───────────────────────── 分区与表单 ───────────────────────── */
.pa-sheet-sec { margin-bottom: 22px; }
.pa-sheet-sec:last-child { margin-bottom: 0; }
.pa-sheet-sec__head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  color: var(--pa-text-3);
}
.pa-sheet-sec__icon { display: inline-flex; flex: none; color: var(--pa-text-4); }
.pa-sheet-sec__title {
  font-size: calc(11.5px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--pa-text-2);
}
.pa-sheet-sec__extra {
  margin-left: auto;
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-text-4);
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-sheet-field-row { margin-bottom: 11px; }
.pa-sheet-field-row:last-child { margin-bottom: 0; }
.pa-sheet-label {
  display: block;
  margin-bottom: 5px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-sheet__body textarea.pa-field { resize: vertical; min-height: 74px; line-height: 1.55; }
.pa-sheet-hint {
  margin: 6px 0 0;
  font-size: calc(10px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--pa-text-4);
}
.pa-sheet-hint--warn { color: var(--pa-red); }
.pa-sheet-empty {
  padding: 14px 12px;
  border: 1px dashed var(--pa-line-2);
  border-radius: 10px;
  text-align: center;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text-3);
}
.pa-sheet-inline-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

/* ───────────────────────── Bot 设置专用 ───────────────────────── */
/* 基本资料：字段 + 右上角保存按钮 */
.pa-bset-profile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.pa-bset-profile-avatar { display: flex; align-items: center; gap: 9px; min-width: 0; }
.pa-bset-profile-avatar__name {
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-bset-profile-avatar__meta {
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 模型下拉：宿主 llm 注册表（原生 select 分组展示） */
.pa-bset-model {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid var(--pa-line-2);
  background: var(--pa-card-2);
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
  outline: none;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.pa-bset-model:hover { background: var(--pa-card-3); }
.pa-bset-model:focus { border-color: var(--pa-accent); }
.pa-bset-model optgroup,
.pa-bset-model option { background: var(--pa-card); color: var(--pa-text); }

/* 设置行（主动询问等：左文案 + 右控件） */
.pa-bset-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 12px;
  margin-bottom: 8px;
  border-radius: 11px;
  background: var(--pa-card);
}
.pa-bset-row:last-child { margin-bottom: 0; }
.pa-bset-row__main { min-width: 0; }
.pa-bset-row__main b {
  display: block;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
}
.pa-bset-row__main span {
  display: block;
  margin-top: 2px;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.45;
  color: var(--pa-text-3);
}

/* 数字设置行（记忆检索刷新间隔）：输入框 + 单位，高度对齐设置行的右侧控件。
 * 草稿式编辑：失焦 / Enter 才提交，避免「删空重打」的中间态被写进配置。 */
.pa-bset-num {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 9px;
  border-radius: 8px;
  background: var(--pa-card-2);
  border: 1px solid var(--pa-line);
  transition: border-color 130ms ease, opacity 130ms ease;
}
.pa-bset-num:focus-within { border-color: var(--pa-accent); }
.pa-bset-num[data-saving='true'] { opacity: 0.55; }
.pa-bset-num input {
  width: 42px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pa-bset-num input::placeholder { color: var(--pa-text-4); text-align: right; }
/* 数字框的上下小箭头在 30px 高度里挤成一团，去掉（仍可键盘上下调） */
.pa-bset-num input::-webkit-outer-spin-button,
.pa-bset-num input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.pa-bset-num input[type='number'] { -moz-appearance: textfield; appearance: textfield; }
.pa-bset-num__unit { flex: none; font-size: calc(11px + var(--pa-font-delta)); color: var(--pa-text-3); }

/* 开关（34×20，和旧设置里的 pa-switch 同尺寸，但不依赖 shell.css.ts） */
.pa-bset-switch {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: var(--pa-card-3);
  flex: none;
  transition: background 150ms ease;
}
.pa-bset-switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 150ms ease;
}
.pa-bset-switch[data-on='true'] { background: var(--pa-accent); }
.pa-bset-switch[data-on='true'] i { transform: translateX(14px); }

/* 权限二选一 */
.pa-bset-perm {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: var(--pa-card-2);
}
.pa-bset-perm__opt {
  flex: 1;
  padding: 7px 0;
  border-radius: 8px;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text-2);
  background: transparent;
  transition: background 120ms ease, color 120ms ease;
}
.pa-bset-perm__opt:hover { color: var(--pa-text); }
.pa-bset-perm__opt[data-on='true'] { background: var(--pa-card-3); color: var(--pa-text); }

/* 例行任务卡片 */
.pa-bset-routine {
  padding: 10px 12px;
  margin-bottom: 8px;
  border-radius: 11px;
  background: var(--pa-card);
}
.pa-bset-routine__head { display: flex; align-items: center; gap: 8px; }
.pa-bset-routine__name {
  flex: 1;
  min-width: 0;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-bset-routine__meta {
  margin-top: 3px;
  font-size: calc(10px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--pa-text-3);
}
.pa-bset-routine__actions { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
.pa-bset-linkbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  transition: color 120ms ease;
}
.pa-bset-linkbtn:hover { color: var(--pa-text); }
.pa-bset-linkbtn--danger { color: var(--pa-text-3); }
.pa-bset-linkbtn--danger:hover { color: var(--pa-red); }
.pa-bset-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 34px;
  border-radius: 10px;
  border: 1px dashed var(--pa-line-2);
  color: var(--pa-text-3);
  font-size: calc(11.5px + var(--pa-font-delta));
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.pa-bset-add:hover {
  color: var(--pa-accent);
  border-color: var(--pa-accent);
  background: rgba(255, 159, 10, 0.06);
}
.pa-bset-inline-form {
  margin-top: 8px;
  padding: 12px;
  border-radius: 11px;
  border: 1px solid var(--pa-line);
  background: var(--pa-card-2);
}

/* 子 Bot 管理 */
.pa-bset-subrow {
  padding: 9px 10px;
  margin-bottom: 7px;
  border-radius: 11px;
  background: var(--pa-card);
}
.pa-bset-subrow__top { display: flex; align-items: center; gap: 8px; }
.pa-bset-subrow__main { flex: 1; min-width: 0; }
.pa-bset-subrow__name {
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-bset-subrow__meta {
  margin-top: 2px;
  font-size: calc(9.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-bset-subrow__ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.pa-bset-mini-select {
  height: 24px;
  max-width: 108px;
  padding: 0 4px;
  border-radius: 7px;
  border: 1px solid var(--pa-line-2);
  background: var(--pa-card-2);
  color: var(--pa-text-2);
  font-size: calc(10px + var(--pa-font-delta));
  outline: none;
  cursor: pointer;
}
.pa-bset-mini-select option { background: var(--pa-card); color: var(--pa-text); }
.pa-bset-mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  border-radius: 7px;
  background: rgba(128, 132, 140, 0.16);
  color: var(--pa-text-2);
  font-size: calc(10px + var(--pa-font-delta));
  transition: background 120ms ease, color 120ms ease;
}
.pa-bset-mini-btn:hover { background: rgba(128, 132, 140, 0.26); color: var(--pa-text); }
.pa-bset-mini-btn--danger { background: rgba(255, 69, 58, 0.14); color: #ff8a82; }
.pa-bset-mini-btn--danger:hover { background: rgba(255, 69, 58, 0.24); color: #ffb3ae; }
.pa-bset-mini-input {
  width: 100%;
  height: 26px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid var(--pa-accent);
  background: var(--pa-card-2);
  color: var(--pa-text);
  font-size: calc(11.5px + var(--pa-font-delta));
  outline: none;
}
.pa-bset-confirm-text {
  flex: 1;
  min-width: 90px;
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-text-3);
}

/* 记忆 */
.pa-bset-mem-search { position: relative; margin-bottom: 8px; }
.pa-bset-mem-search svg {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--pa-text-4);
  pointer-events: none;
}
.pa-bset-mem-search input {
  width: 100%;
  height: 32px;
  padding: 0 10px 0 30px;
  border-radius: 9px;
  border: 1px solid var(--pa-line-2);
  background: var(--pa-card-2);
  color: var(--pa-text);
  font-size: calc(11.5px + var(--pa-font-delta));
  outline: none;
  transition: border-color 120ms ease;
}
.pa-bset-mem-search input:focus { border-color: var(--pa-accent); }
.pa-bset-mem-search input::placeholder { color: var(--pa-text-4); }
.pa-bset-filters {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 4px;
  margin-bottom: 8px;
}
.pa-bset-filters::-webkit-scrollbar { display: none; }
.pa-bset-filter-chip {
  flex: none;
  height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: rgba(128, 132, 140, 0.09);
  color: var(--pa-text-3);
  font-size: calc(10px + var(--pa-font-delta));
  white-space: nowrap;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.pa-bset-filter-chip:hover { color: var(--pa-text-2); background: rgba(128, 132, 140, 0.16); }
.pa-bset-filter-chip[data-on='true'] {
  background: var(--pa-card-2);
  border-color: var(--pa-line-2);
  color: var(--pa-text);
}
.pa-bset-mem-card {
  position: relative;
  padding: 10px 12px;
  margin-bottom: 7px;
  border-radius: 11px;
  background: var(--pa-card);
}
.pa-bset-mem-text {
  font-size: calc(11.5px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text-2);
  word-break: break-word;
  padding-right: 20px;
}
.pa-bset-mem-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.pa-bset-mem-tag {
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(128, 132, 140, 0.16);
  color: var(--pa-text-3);
  font-size: calc(9.5px + var(--pa-font-delta));
  display: inline-flex;
  align-items: center;
}
.pa-bset-mem-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: calc(9.5px + var(--pa-font-delta));
  color: var(--pa-text-4);
}
.pa-bset-mem-src { color: var(--pa-text-3); }
.pa-bset-mem-del {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-4);
  opacity: 0;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
}
.pa-bset-mem-card:hover .pa-bset-mem-del { opacity: 1; }
.pa-bset-mem-del:hover { background: rgba(255, 69, 58, 0.16); color: #ff8a82; }
.pa-bset-mem-add { display: flex; align-items: flex-end; gap: 6px; margin-top: 10px; }
.pa-bset-mem-add textarea {
  flex: 1;
  min-height: 46px;
  max-height: 120px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--pa-line-2);
  background: var(--pa-card-2);
  color: var(--pa-text);
  font-size: calc(11.5px + var(--pa-font-delta));
  line-height: 1.5;
  resize: vertical;
  outline: none;
}
.pa-bset-mem-add textarea:focus { border-color: var(--pa-accent); }
.pa-bset-mem-add textarea::placeholder { color: var(--pa-text-4); }
.pa-bset-mem-add button {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--pa-card-3);
  color: var(--pa-text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  transition: background 120ms ease, color 120ms ease;
}
.pa-bset-mem-add button:hover { background: var(--pa-accent); color: #1a1206; }
.pa-bset-mem-add button:disabled { opacity: 0.4; cursor: not-allowed; }

/* 产出物文件夹 */
.pa-bset-output {
  padding: 12px;
  border-radius: 11px;
  background: var(--pa-card);
}
.pa-bset-output__label {
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-bset-output__path {
  display: block;
  margin: 6px 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--pa-card-2);
  color: var(--pa-text-2);
  /*
   * 路径走全局代码字体（--ds-font-family-code，由「界面字体」档位定义），
   * 不写死 ui-monospace：否则用户换界面字体后，Bot 模式里只有这处路径不跟。
   * 与本文件之外的代码块 / 终端 / 日志保持同一条链。
   */
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: calc(10px + var(--pa-font-delta));
  line-height: 1.5;
  word-break: break-all;
  user-select: text;
}
.pa-bset-output__actions { display: flex; gap: 8px; }

/* ───────────────────────── 群聊设置专用 ───────────────────────── */
.pa-sheet-radio {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px;
  margin-bottom: 7px;
  border: 1px solid var(--pa-line);
  border-radius: 10px;
  background: rgba(128, 132, 140, 0.05);
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.pa-sheet-radio:hover { background: rgba(128, 132, 140, 0.1); }
.pa-sheet-radio[data-checked='true'] {
  border-color: rgba(255, 159, 10, 0.55);
  background: rgba(255, 159, 10, 0.06);
}
.pa-sheet-radio input { margin: 2px 0 0; accent-color: var(--pa-accent); flex: none; }
.pa-sheet-radio__main b {
  display: block;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
}
.pa-sheet-radio__main span {
  display: block;
  margin-top: 2px;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.45;
  color: var(--pa-text-3);
}
.pa-sheet-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.pa-sheet-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 7px 0 5px;
  border-radius: 999px;
  background: rgba(128, 132, 140, 0.12);
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-text-2);
}
.pa-sheet-chip button {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-4);
  flex: none;
}
.pa-sheet-chip button:hover { background: rgba(255, 69, 58, 0.2); color: #ff8a82; }
.pa-sheet-add-member {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px dashed var(--pa-line-2);
  color: var(--pa-text-3);
  font-size: calc(10.5px + var(--pa-font-delta));
}
.pa-sheet-add-member:hover { color: var(--pa-accent); border-color: rgba(255, 159, 10, 0.5); }
.pa-sheet-member-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--pa-line-2);
  background: rgba(128, 132, 140, 0.06);
  max-height: 180px;
  overflow-y: auto;
}
.pa-sheet-member-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 7px;
  border-radius: 7px;
  font-size: calc(11.5px + var(--pa-font-delta));
  color: var(--pa-text-2);
  text-align: left;
}
.pa-sheet-member-item:hover { background: rgba(128, 132, 140, 0.14); color: var(--pa-text); }
.pa-sheet-member-item small {
  margin-left: auto;
  font-size: calc(9.5px + var(--pa-font-delta));
  color: var(--pa-text-4);
}
.pa-sheet-danger-zone {
  padding: 12px;
  border-radius: 11px;
  border: 1px solid rgba(255, 69, 58, 0.28);
  background: rgba(255, 69, 58, 0.06);
}
.pa-sheet-danger-zone b {
  display: block;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  color: #ff8a82;
}
.pa-sheet-danger-zone p {
  margin: 4px 0 10px;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text-3);
}
.pa-sheet-danger-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.pa-sheet-danger-confirm {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 69, 58, 0.22);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text-2);
}
.pa-sheet-danger-confirm__row {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

/* ───────────────────────── 卡内按钮补全 ───────────────────────── */
/*
 * base.css.ts 里的 .pa-root button 是全局 reset（specificity 0,1,1），会把
 * 单类按钮规则（0,1,0）的 background / border / padding / font 全部吃掉：
 * 表现为「按钮只有文字、没有底色和内边距」。这里用 .pa-root .pa-sheet 前缀
 * （0,2,0）把设置卡内用到的按钮外观补回来，卡外按钮完全不受影响。
 *
 * 为什么不在 base.css.ts 改：那是全站共享样式，改 reset 的优先级会波及其它
 * 工作台；本轮只负责设置卡，作用域收在这里最安全。
 */
.pa-root .pa-sheet .pa-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.07);
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 500;
  white-space: nowrap;
}
.pa-root .pa-sheet .pa-btn:hover { background: rgba(255, 255, 255, 0.12); }
.pa-root .pa-sheet .pa-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.pa-root .pa-sheet .pa-btn--primary { background: #f2f3f5; color: #14161a; font-weight: 600; }
.pa-root .pa-sheet .pa-btn--primary:hover { background: #ffffff; }
.pa-root .pa-sheet .pa-btn--ghost { background: transparent; color: var(--pa-text-2); }
.pa-root .pa-sheet .pa-btn--ghost:hover { background: rgba(255, 255, 255, 0.06); color: var(--pa-text); }
.pa-root .pa-sheet .pa-btn--danger { background: rgba(255, 69, 58, 0.16); color: #ff8a82; }
.pa-root .pa-sheet .pa-btn--danger:hover { background: rgba(255, 69, 58, 0.24); }
.pa-root .pa-sheet .pa-btn--sm {
  height: 26px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: calc(11px + var(--pa-font-delta));
}

/* 虚线「新建」按钮 */
.pa-root .pa-sheet .pa-bset-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  border: 1px dashed var(--pa-line-2);
  background: transparent;
  color: var(--pa-text-3);
}
.pa-root .pa-sheet .pa-bset-add:hover {
  color: var(--pa-accent);
  border-color: var(--pa-accent);
  background: rgba(255, 159, 10, 0.06);
}

/* 开关（关闭态轨道） */
.pa-root .pa-sheet .pa-bset-switch { background: var(--pa-card-3); }
.pa-root .pa-sheet .pa-bset-switch[data-on='true'] { background: var(--pa-accent); }
.pa-root .pa-sheet .pa-switch { background: var(--pa-card-3); }
.pa-root .pa-sheet .pa-switch[data-on='true'] { background: var(--pa-accent); }

/* 记忆来源筛选 chips */
.pa-root .pa-sheet .pa-bset-filter-chip {
  border: 1px solid transparent;
  background: rgba(128, 132, 140, 0.09);
  color: var(--pa-text-3);
}
.pa-root .pa-sheet .pa-bset-filter-chip:hover {
  background: rgba(128, 132, 140, 0.16);
  color: var(--pa-text-2);
}
.pa-root .pa-sheet .pa-bset-filter-chip[data-on='true'] {
  background: var(--pa-card-2);
  border-color: var(--pa-line-2);
  color: var(--pa-text);
}

/* 子 Bot 管理的小按钮 */
.pa-root .pa-sheet .pa-bset-mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  background: rgba(128, 132, 140, 0.16);
  color: var(--pa-text-2);
}
.pa-root .pa-sheet .pa-bset-mini-btn:hover {
  background: rgba(128, 132, 140, 0.26);
  color: var(--pa-text);
}
.pa-root .pa-sheet .pa-bset-mini-btn--danger {
  background: rgba(255, 69, 58, 0.14);
  color: #ff8a82;
}
.pa-root .pa-sheet .pa-bset-mini-btn--danger:hover {
  background: rgba(255, 69, 58, 0.24);
  color: #ffb3ae;
}

/* 行内文字按钮（立即运行 / 删除） */
.pa-root .pa-sheet .pa-bset-linkbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--pa-text-3);
}
.pa-root .pa-sheet .pa-bset-linkbtn:hover { color: var(--pa-text); }
.pa-root .pa-sheet .pa-bset-linkbtn--danger:hover { color: var(--pa-red); }

/* 权限二选一 */
.pa-root .pa-sheet .pa-bset-perm__opt {
  padding: 7px 0;
  background: transparent;
  color: var(--pa-text-2);
}
.pa-root .pa-sheet .pa-bset-perm__opt:hover { color: var(--pa-text); }
.pa-root .pa-sheet .pa-bset-perm__opt[data-on='true'] {
  background: var(--pa-card-3);
  color: var(--pa-text);
}

/* 记忆删除按钮的默认色 */
.pa-root .pa-sheet .pa-bset-mem-del { color: var(--pa-text-4); }
.pa-root .pa-sheet .pa-bset-mem-del:hover {
  background: rgba(255, 69, 58, 0.16);
  color: #ff8a82;
}

/* 群聊成员 chip 的「添加成员」与候选行 */
.pa-root .pa-sheet .pa-sheet-add-member {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 9px;
  border: 1px dashed var(--pa-line-2);
  background: transparent;
  color: var(--pa-text-3);
}
.pa-root .pa-sheet .pa-sheet-add-member:hover {
  color: var(--pa-accent);
  border-color: rgba(255, 159, 10, 0.5);
}
.pa-root .pa-sheet .pa-sheet-member-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 7px;
  color: var(--pa-text-2);
}
.pa-root .pa-sheet .pa-sheet-member-item:hover {
  background: rgba(128, 132, 140, 0.14);
  color: var(--pa-text);
}
.pa-root .pa-sheet .pa-sheet__close { color: var(--pa-text-3); }

/* ───────────────────────── 浅色主题补充 ───────────────────────── */
/*
 * 大多数颜色都走 --pa-* token，深浅主题自动切换；这里只补「写死了深色系
 * 高亮色」的几处危险态：浅色底上 #ff8a82 对比度太低，换成深红。
 */
.pa-root[data-pa-theme='light'] .pa-sheet-danger-zone {
  border-color: rgba(192, 57, 43, 0.28);
  background: rgba(192, 57, 43, 0.05);
}
/*
 * 浅色主题的主按钮反过来用深色底：白底按钮压在白色 foot 上几乎看不出来，
 * 深底白字既显眼又符合官方 Work 界面的主按钮惯例。
 */
.pa-root[data-pa-theme='light'] .pa-sheet .pa-btn--primary {
  background: #14161a;
  color: #ffffff;
}
.pa-root[data-pa-theme='light'] .pa-sheet .pa-btn--primary:hover { background: #2a2d33; }
.pa-root[data-pa-theme='light'] .pa-sheet-danger-zone b { color: #c0392b; }
.pa-root[data-pa-theme='light'] .pa-sheet-danger-confirm { border-top-color: rgba(192, 57, 43, 0.2); }
.pa-root[data-pa-theme='light'] .pa-bset-mini-btn--danger {
  background: rgba(192, 57, 43, 0.1);
  color: #c0392b;
}
.pa-root[data-pa-theme='light'] .pa-bset-mini-btn--danger:hover {
  background: rgba(192, 57, 43, 0.18);
  color: #a93226;
}
.pa-root[data-pa-theme='light'] .pa-bset-linkbtn--danger:hover,
.pa-root[data-pa-theme='light'] .pa-bset-mem-del:hover,
.pa-root[data-pa-theme='light'] .pa-sheet-chip button:hover { color: #c0392b; }
.pa-root[data-pa-theme='light'] .pa-sheet-hint--warn { color: #c0392b; }

/* ───────────────────────── 动画 ───────────────────────── */
@keyframes pa-sheet-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes pa-sheet-slide {
  from { transform: translateX(34px); opacity: 0.55; }
  to { transform: translateX(0); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .pa-sheet-overlay,
  .pa-sheet { animation: none; }
}
`

let injected = false

/**
 * 幂等注入设置卡样式；返回是否本次真正插入。
 *
 * 与其它组件级 CSS 模块同一套模式：宿主可能重复挂载 Personal Agent
 * （切 Work / Bot 模式），重复 append 会让 <style> 越积越多。
 */
export function injectSettingsStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-settings-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-settings-styles'
  style.textContent = SETTINGS_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function settingsStylesInjected(): boolean {
  return injected
}
