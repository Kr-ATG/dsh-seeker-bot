/**
 * Personal Agent — 设置卡样式（Bot 设置 / 群聊设置 / 全局设置共用）。
 *
 * 两种容器形态，卡内控件共用（继续沿用 base.css.ts 的 `.pa-field` /
 * `.pa-btn` / `.pa-select`，所以深浅主题、字号跟随等行为一致）：
 *  · 右贴边滑出卡（默认 `.pa-sheet`）：半透明遮罩 + 右贴边、全高、左侧圆角，
 *    全局设置用它；
 *  · 居中弹窗卡片（`.pa-sheet--dialog`）：760px 宽、高度贴合内容并封顶 84vh，
 *    Bot 设置与群聊设置用它——这两个设置字段多，窄列排不开。
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
  animation: pa-sheet-fade 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
  animation: pa-sheet-slide 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-root[data-pa-theme='light'] .pa-sheet-overlay {
  background: rgba(15, 17, 21, 0.22);
}
.pa-root[data-pa-theme='light'] .pa-sheet {
  --pa-sheet-shadow: -20px 0 52px rgba(15, 17, 21, 0.18);
}

/* ───────────────────────── 居中弹窗卡片（Bot 设置 / 群聊设置） ───────────────────────── */
/*
 * 这两个设置项多、字段长，右贴边 460px 的滑出卡里一列排不开（模型 / 音色 / 成员
 * 这些控件在窄列里只能缩成一条）。改成居中弹窗后给到 760px 宽，字段与控件横向
 * 更松快，也让「设置」看起来像一件有始有终的模态任务，而不是一块常驻面板。
 *
 * 全局设置仍走右贴边滑出：它的入口在侧栏底部，语境是「调工作台外观」，与
 * 「编辑某个 Bot / 群聊」不是同一类操作。
 *
 * 高度写 auto + max-height：内容少时卡片贴合内容（不出现一大片空面板），
 * 内容多时封顶 84vh，滚动交给内部的 .pa-sheet__body。
 */
.pa-sheet-overlay--dialog {
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.pa-sheet--dialog {
  width: min(760px, 92vw);
  height: auto;
  max-height: min(84vh, 880px);
  border: 1px solid var(--pa-line-2);
  border-radius: 16px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.46);
  animation: pa-sheet-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-root[data-pa-theme='light'] .pa-sheet--dialog {
  box-shadow: 0 20px 52px rgba(15, 17, 21, 0.18);
}

/* ───────────────────────── 退场（closing 态） ───────────────────────── */
/*
 * 三个设置卡（全局设置右贴边抽屉 / Bot 设置 / 群聊设置）共用这套：关闭时先播
 * 240ms 退场再真正卸载，而不是条件渲染一置 null 就硬消失。
 *
 * 只在 .pa-sheet-overlay 上挂一个 data-closing 就够了，卡片用后代选择器跟随——
 * 组件侧只改一处属性，不会出现「遮罩淡出了、卡片还在」的错位。
 *
 * 时长与曲线跟 src/client/modal-animation.ts 的 MODAL_ANIM_MS 对齐（240ms、
 * 出场用加速曲线 cubic-bezier(0.4,0,0.2,1)），整套插件的手感才是同一套。
 */
@keyframes pa-sheet-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes pa-sheet-slide-out {
  from { opacity: 1; transform: translateX(0); }
  to { opacity: 0; transform: translateX(46px); }
}
@keyframes pa-sheet-pop-out {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(14px) scale(0.97); }
}
.pa-sheet-overlay[data-closing='1'] {
  animation: pa-sheet-fade-out 240ms ease both;
}
.pa-sheet-overlay[data-closing='1'] .pa-sheet {
  animation: pa-sheet-slide-out 240ms cubic-bezier(0.4, 0, 0.2, 1) both;
}
.pa-sheet-overlay[data-closing='1'] .pa-sheet--dialog {
  animation: pa-sheet-pop-out 240ms cubic-bezier(0.4, 0, 0.2, 1) both;
}
@media (max-width: 720px) {
  .pa-sheet-overlay--dialog { padding: 12px; }
  .pa-sheet--dialog { width: 100%; max-height: 88vh; }
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

/* ───────────────────────── 模型两级选择器（Bot 设置 / 群聊设置共用） ───────────────────────── */
/*
 * 供应商 → 模型两个 PaSelect 并排（都走 36px 表单档）。每格 flex-basis 210px：
 * 设置卡宽 760px 时两列各占一半；窄屏放不下时 flex-wrap 自动折成上下两行，
 * 不会把供应商名 / 模型名压成一条省略号。
 */
.pa-model-picker { display: flex; flex-wrap: wrap; gap: 10px; width: 100%; }
.pa-model-picker__field {
  flex: 1 1 210px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.pa-model-picker__label {
  display: block;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.4;
  color: var(--pa-text-3);
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

/* ─────────────────── Bot 设置卡的左右分栏（分类导航 + 面板） ─────────────────── */
/*
 * 只有 Bot 设置卡挂 .pa-sheet--tabs。9 个分区一列排下来要滚好几屏：想改
 * 「记忆检索间隔」得先翻过语音、权限、例行任务。改成左侧分类导航 + 右侧
 * 面板后，一屏只放一件事。
 *
 * 高度写死成 min(84vh, 760px)，不跟内容收放：各页内容量差得很远（「权限」
 * 只有两行，「记忆」能有几十条），若跟着内容伸缩，每切一次页签整张卡就跳
 * 一次高度，眼睛得重新找位置。
 */
.pa-sheet--tabs {
  width: min(820px, 94vw);
  height: min(84vh, 760px);
}
/* 左导航 + 右面板这一行占满 head 与 foot 之间的剩余高度 */
.pa-sheet__main {
  flex: 1;
  min-height: 0;
  display: flex;
}
.pa-bset-nav {
  flex: none;
  width: 148px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-right: 1px solid var(--pa-line);
  background: rgba(128, 132, 140, 0.04);
}
/* 导航最多 8 项，正常高度不出滚动条；窗口很矮时也别露出一条粗滚动条 */
.pa-bset-nav::-webkit-scrollbar { width: 0; }
.pa-bset-nav__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-bset-nav__icon {
  display: inline-flex;
  flex: none;
  color: var(--pa-text-4);
  transition: color 140ms ease;
}
.pa-bset-nav__badge {
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(128, 132, 140, 0.2);
  color: var(--pa-text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: calc(9.5px + var(--pa-font-delta));
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

/* 右侧面板：滚动仍然交给 .pa-sheet__body，这里只补内边距与换页入场 */
.pa-sheet__body.pa-bset-panes {
  flex: 1;
  min-width: 0;
  padding: 16px 18px 22px;
}
.pa-bset-pane {
  min-width: 0;
  outline: none;
  animation: pa-bset-pane-in 180ms cubic-bezier(0.4, 0, 0.2, 1) both;
}
/*
 * 换页入场：内容整体上浮 6px 淡入，和弹窗本身的 240ms 弹入区分开——
 * 页签切换是「同一层里换内容」，位移要小、要快，不能像又开了一张卡。
 */
@keyframes pa-bset-pane-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}

/* 窄屏：导航挪到顶部变成一条横向 chips，面板占满剩余高度 */
@media (max-width: 720px) {
  .pa-sheet--tabs { width: 100%; height: min(88vh, 720px); }
  .pa-sheet__main { flex-direction: column; }
  /*
   * 窄屏导航换成顶部 chips，但**不**做成横向滚动：8 个 chip 在 614px 里
   * 排不下，「产出」会被切在可视区外，用户看不出右边还有一项（滚动条也被
   * 这条规则自己藏了）。改成换行后所有分类一眼可见，代价只是多占一行高度。
   */
  .pa-bset-nav {
    width: auto;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 6px;
    padding: 9px 10px;
    overflow: visible;
    border-right: 0;
    border-bottom: 1px solid var(--pa-line);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pa-bset-pane { animation: none; }
  .pa-bset-nav__icon { transition: none; }
}

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

/* 左侧分类导航的页签按钮 */
/*
 * 同样要带 .pa-root .pa-sheet 前缀：base.css.ts 的「.pa-root button」重置
 * （0,1,1）会把单类规则（0,1,0）的 padding / color / font 全部吃掉，
 * 表现就是「导航项只有文字、没有内边距、颜色也不对」。
 */
.pa-root .pa-sheet .pa-bset-nav__item {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: none;
  height: 34px;
  padding: 0 9px;
  border-radius: 9px;
  color: var(--pa-text-3);
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 500;
  text-align: left;
  transition: background 140ms ease, color 140ms ease;
}
.pa-root .pa-sheet .pa-bset-nav__item:hover {
  background: rgba(128, 132, 140, 0.12);
  color: var(--pa-text-2);
}
/*
 * 选中底：深色主题用 0.18、浅色用 0.13。
 * 同一档透明度在深色底上更不显眼（暗背景会把橙压暗），深色稍微提亮一点，
 * 两边「当前在哪一页」的强度才一致；文字与图标颜色两边都走 token，不用分。
 */
.pa-root .pa-sheet .pa-bset-nav__item[data-on='true'] {
  background: rgba(255, 159, 10, 0.18);
  color: var(--pa-text);
  font-weight: 600;
}
.pa-root[data-pa-theme='light'] .pa-sheet .pa-bset-nav__item[data-on='true'] {
  background: rgba(255, 159, 10, 0.13);
}
.pa-root .pa-sheet .pa-bset-nav__item[data-on='true'] .pa-bset-nav__icon { color: var(--pa-accent); }
.pa-root .pa-sheet .pa-bset-nav__item[data-on='true'] .pa-bset-nav__badge {
  background: rgba(255, 159, 10, 0.24);
  color: var(--pa-accent);
}
.pa-root .pa-sheet .pa-bset-nav__item:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: -2px;
}
@media (max-width: 720px) {
  .pa-root .pa-sheet .pa-bset-nav__item {
    height: 30px;
    padding: 0 11px;
    gap: 6px;
    border-radius: 999px;
  }
  .pa-root .pa-sheet .pa-bset-nav__item .pa-bset-nav__badge { min-width: 16px; height: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .pa-root .pa-sheet .pa-bset-nav__item { transition: none; }
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
/* 弹窗卡片的入场：从下方轻推上来 + 轻微放大，和右滑出区分开。 */
@keyframes pa-sheet-pop {
  from { transform: translateY(10px) scale(0.97); opacity: 0; }
  to { transform: none; opacity: 1; }
}
/*
 * 退场规则的选择器是「类 + [data-closing] 属性」，特异性高于下面这条普通类
 * 选择器：不把退场选择器一起列进来，开启「减少动态效果」时退场仍会照播。
 */
@media (prefers-reduced-motion: reduce) {
  .pa-sheet-overlay,
  .pa-sheet,
  .pa-sheet-overlay[data-closing='1'],
  .pa-sheet-overlay[data-closing='1'] .pa-sheet,
  .pa-sheet-overlay[data-closing='1'] .pa-sheet--dialog { animation: none; }
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
