/**
 * Personal Agent — 左侧栏 / 右栏 / 新建 Bot / 群聊设置 的样式。
 *
 * 深色为基准（参考截图），亮色通过 html:not([data-ds-dark-theme]) 覆盖到可读。
 * 只使用 base.css.ts 暴露的 --pa-* 变量与公共类名，不修改共享样式。
 *
 * 注意：本文件里的样式表是模板字符串，正文与注释中都不能出现反引号。
 */

export const PERSONAL_SHELL_CSS = `
/* ───────────────────────── 左侧栏：整体 ───────────────────────── */
/*
 * 收起态：与 Work 模式官方侧栏的 rail 同宽（官方折叠后 64px 含内边距）。
 * 只留图标轨道，品牌行缩成一枚 logo 按钮，点它展开。
 */
.pa-sidebar[data-collapsed='true'] {
  width: 64px;
  flex: 0 0 64px;
}
.pa-sidebar[data-collapsed='true'] .pa-sidebar__top {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}
/* 折叠轨道：主 Bot 头像 + 子 Bot 头像 + 群聊，全部靠 hover 提示认人。 */
.pa-sidebar__rail {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 0 10px;
}
.pa-rail-item {
  position: relative;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  flex: none;
  transition: background 120ms ease;
}
.pa-rail-item:hover { background: rgba(128, 132, 140, 0.14); }
.pa-rail-item[data-selected='true'] { background: var(--pa-card-2); }
.pa-rail-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pa-accent);
  box-shadow: 0 0 0 2px var(--pa-sidebar);
}
/* 群聊：成员头像叠加（与展开态 .pa-room-avatars 同一套叠法）。 */
.pa-rail-room { display: inline-flex; align-items: center; }
.pa-rail-room .pa-avatar {
  border-radius: 50%;
  border: 1.5px solid var(--pa-sidebar);
  margin-left: -9px;
  background: var(--pa-sidebar);
}
.pa-rail-room .pa-avatar:first-child { margin-left: 0; }
.pa-rail-sep {
  width: 24px;
  height: 1px;
  background: var(--pa-line);
  margin: 2px 0;
  flex: none;
}
.pa-sidebar__bottom[data-collapsed='true'] {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0 10px;
}
/*
 * dsh-shell 的 topbar 有一块 -webkit-app-region: drag 拖拽区，覆盖在 iframe
 * 内容上方，落在里面的点击会被窗口拖拽吃掉。
 *
 * 2026-11-02 起壳子侧已把它缩到 240×30（topbar.css / main.js / renderer.js
 * 三处同步），品牌行右侧的收起按钮（x243 起、y22–50）整块落在热区外，直接可点。
 *
 * 下面这条透明热区是**兜底**：万一哪天热区又盖到按钮上半截（旧壳子 / 换壳子），
 * 按钮向下补的这块（y44 以下）仍然能点中，视觉保持 28×28 不变。
 */
.pa-sidebar-toggle { position: relative; }
.pa-root[data-shell-embed='true'] .pa-sidebar-toggle::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: -18px;
  left: 0;
}

/* 搜索条 */
.pa-side-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 12px 8px;
  padding: 0 10px;
  height: 32px;
  flex: none;
  border-radius: 9px;
  background: var(--pa-card);
  color: var(--pa-text-3);
  animation: pa-fade 140ms ease both;
}
.pa-side-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
}
.pa-side-search input::placeholder { color: var(--pa-text-4); }
.pa-side-search .pa-icon-btn {
  width: 20px;
  height: 20px;
  margin-right: -4px;
}

/* 折叠轨道底部的图标按钮（期刊 / 设置）。轨道本体样式见文件顶部。 */
.pa-rail-btn {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: var(--pa-text-2);
  transition: background 120ms ease, color 120ms ease;
  flex: none;
}
.pa-rail-btn:hover { background: rgba(128, 132, 140, 0.14); color: var(--pa-text); }
.pa-rail-btn[data-selected='true'] { background: var(--pa-card-2); }

/* 行内更多按钮 */
.pa-row-more {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-2);
  background: transparent;
  opacity: 0;
  transition: opacity 120ms ease, background 120ms ease;
  z-index: 2;
}
.pa-bot-row:hover .pa-row-more,
.pa-mainbot:hover .pa-row-more,
.pa-bot-row:focus-within .pa-row-more,
.pa-mainbot:focus-within .pa-row-more { opacity: 1; }
.pa-row-more:hover { background: rgba(128, 132, 140, 0.22); color: var(--pa-text); }
.pa-bot-row:hover .pa-bot-row__badge { opacity: 0; }
.pa-bot-row__badge { transition: opacity 120ms ease; }
.pa-mainbot .pa-row-more { top: 10px; right: 10px; transform: none; }

.pa-bot-row__name { flex: 0 0 auto; max-width: 100%; }
.pa-bot-row__role { flex: 1 1 0; min-width: 0; }

/* 群聊行：成员头像叠加 */
.pa-room-avatars {
  display: flex;
  align-items: center;
  flex: none;
  width: auto;
  padding-left: 2px;
}
.pa-room-avatars .pa-avatar {
  border-radius: 50%;
  border: 1.5px solid var(--pa-sidebar);
  margin-left: -9px;
  background: var(--pa-sidebar);
}
.pa-room-avatars .pa-avatar:first-child { margin-left: 0; }
.pa-room-fallback {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--pa-card);
  color: var(--pa-text-3);
  flex: none;
}

/* 底部入口 */
.pa-sidebar__bottom--rail { padding: 8px 0 10px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.pa-side-bottom-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border-radius: 9px;
  color: var(--pa-text-2);
  font-size: calc(12.5px + var(--pa-font-delta));
  text-align: left;
  transition: background 120ms ease, color 120ms ease;
}
.pa-side-bottom-item:hover { background: rgba(128, 132, 140, 0.14); color: var(--pa-text); }
.pa-sidebar__bottom--rail .pa-side-bottom-item {
  width: 42px;
  height: 38px;
  padding: 0;
  justify-content: center;
}

/* ───────────────────────── 弹出菜单 ───────────────────────── */
.pa-popover {
  position: fixed;
  z-index: 120;
  min-width: 178px;
  padding: 6px;
  border-radius: 12px;
  background: #232427;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.07);
  animation: pa-pop 140ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
  color: var(--pa-text);
}
.pa-root[data-pa-theme='light'] .pa-popover {
  background: #ffffff;
  box-shadow: 0 18px 50px rgba(15, 20, 30, 0.2), 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.pa-popover__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border-radius: 8px;
  font-size: calc(12.5px + var(--pa-font-delta));
  color: var(--pa-text);
  text-align: left;
}
.pa-popover__item:hover { background: rgba(128, 132, 140, 0.16); }
.pa-popover__item[data-danger='true'] { color: #ff8a82; }
.pa-popover__item[data-danger='true']:hover { background: rgba(255, 69, 58, 0.14); }
.pa-popover__item:disabled { opacity: 0.4; cursor: not-allowed; }
.pa-popover__item svg { flex: none; color: var(--pa-text-3); }
.pa-popover__item[data-danger='true'] svg { color: #ff8a82; }
.pa-popover__sep { height: 1px; background: var(--pa-line); margin: 5px 4px; }
.pa-popover__title {
  padding: 4px 9px 6px;
  font-size: calc(10px + var(--pa-font-delta));
  letter-spacing: 0.06em;
  color: var(--pa-text-4);
}
.pa-popover__confirm { padding: 8px 9px 4px; font-size: calc(11.5px + var(--pa-font-delta)); color: var(--pa-text-2); line-height: 1.5; }
.pa-popover__confirm-row { display: flex; gap: 6px; margin-top: 9px; }
.pa-popover__confirm-row .pa-btn { flex: 1; height: 27px; padding: 0 8px; font-size: calc(11px + var(--pa-font-delta)); }

/* ───────────────────────── 顶部「+」：新建菜单 ───────────────────────── */
.pa-create-trigger svg { transition: transform 170ms cubic-bezier(0.2, 0.9, 0.3, 1); }
.pa-create-trigger[data-open='true'] {
  background: var(--pa-card-2);
  color: var(--pa-text);
}
.pa-create-trigger[data-open='true'] svg { transform: rotate(45deg); }
.pa-create-menu {
  width: 256px;
  min-width: 256px;
  padding: 8px;
  border-radius: 14px;
}
.pa-create-menu__title {
  padding: 3px 10px 7px;
  font-size: calc(10px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--pa-text-2);
}
.pa-create-item {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 9px 10px;
  border-radius: 10px;
  text-align: left;
  transition: background 120ms ease;
}
/* base 里的 .pa-root button 会把按钮内边距清零，这里用更高优先级拿回菜单项的留白 */
.pa-root button.pa-create-item { padding: 9px 10px; }
.pa-create-item + .pa-create-item { margin-top: 2px; }
.pa-create-item:hover { background: rgba(128, 132, 140, 0.16); }
.pa-create-item__icon {
  width: 36px;
  height: 36px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 11px;
}
.pa-create-item__icon--bot {
  color: #ffb45c;
  background: linear-gradient(145deg, rgba(255, 159, 10, 0.24), rgba(255, 159, 10, 0.07));
  box-shadow: inset 0 0 0 1px rgba(255, 159, 10, 0.16);
}
.pa-create-item__icon--room {
  color: #7cb8ff;
  background: linear-gradient(145deg, rgba(10, 132, 255, 0.26), rgba(10, 132, 255, 0.07));
  box-shadow: inset 0 0 0 1px rgba(10, 132, 255, 0.18);
}
.pa-create-item__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pa-create-item__text b {
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
}
.pa-create-item__text span {
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-create-item__arrow {
  flex: none;
  color: var(--pa-text-4);
  opacity: 0;
  transform: translateX(-2px);
  transition: opacity 120ms ease, transform 120ms ease;
}
.pa-create-item:hover .pa-create-item__arrow { opacity: 1; transform: translateX(0); }

/* ───────────────────────── 通用弹窗补充 ───────────────────────── */
.pa-overlay.pa-overlay--fixed { position: fixed; }
.pa-modal--sm { max-width: 380px; }
.pa-modal__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 20px 20px 0;
}
.pa-modal__title {
  flex: 1;
  font-size: calc(15px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--pa-text);
}
.pa-modal__close {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-3);
  flex: none;
}
.pa-modal__close:hover { background: rgba(128, 132, 140, 0.16); color: var(--pa-text); }
.pa-modal__body { padding: 16px 20px 2px; }
.pa-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px 20px;
}
.pa-form-row { margin-bottom: 14px; }
.pa-form-row:last-child { margin-bottom: 0; }
.pa-form-row .pa-field { border-radius: 10px; }
.pa-form-row textarea.pa-field { resize: vertical; min-height: 86px; line-height: 1.55; }
/* 表单行下方的解释小字（音色的场景提示等） */
.pa-form-hint {
  margin: 6px 0 0;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--pa-text-4);
}
/* 读不到宿主配置时的提示（Live 供应商列表拉取失败）：用错误色区分，别让它看起来像普通说明 */
.pa-form-hint--warn,
.pa-routine__meta--warn { color: var(--pa-red); }
/* 新建 Bot 里紧跟在建议 chip 网格之后的表单行 */
.pa-form-row--voice { margin-top: 14px; }
.pa-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.6px solid currentColor;
  border-right-color: transparent;
  display: inline-block;
  animation: pa-spin 700ms linear infinite;
}

/* 开关 */
.pa-switch {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: var(--pa-card-3);
  transition: background 150ms ease;
  flex: none;
}
.pa-switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  transition: transform 150ms ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
}
.pa-switch[data-on='true'] { background: var(--pa-accent); }
.pa-switch[data-on='true'] i { transform: translateX(14px); }

/* 模型选择器：原生 select，但外观跟右栏其它控件一致 */
.pa-model-select {
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border-radius: 9px;
  border: 1px solid var(--pa-line-2);
  background: var(--pa-card-2);
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
  cursor: pointer;
  outline: none;
}
.pa-model-select:hover { border-color: var(--pa-line-2); background: var(--pa-card-3); }
.pa-model-select:focus { border-color: var(--pa-accent); }
/* 下拉项在深色下默认是系统白底，这里强制跟主题走 */
.pa-model-select optgroup,
.pa-model-select option {
  background: var(--pa-card);
  color: var(--pa-text);
}

/* 权限档位二选一（完全权限 / 审批模式） */
.pa-perm {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: var(--pa-card-2);
}
.pa-perm__opt {
  flex: 1;
  padding: 7px 0;
  border-radius: 8px;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text-2);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.pa-perm__opt:hover { color: var(--pa-text); }
.pa-perm__opt[data-on='true'] {
  background: var(--pa-card-3);
  color: var(--pa-text);
}

/* ───────────────────────── 右栏 ───────────────────────── */
.pa-right {
  /*
   * 宽度走 CSS 变量：index.tsx 在 .pa-app-shell 上按 ui.rightPanelWidth 设置，
   * 拖拽过程中 RightPanel 直接改它（不触发 React 重渲染）。窄屏媒体查询里
   * 仍是固定宽度（后定义，同优先级覆盖 var）。
   */
  width: var(--pa-right-w, 300px);
  flex: 0 0 var(--pa-right-w, 300px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--pa-right);
  border-left: 1px solid var(--pa-line);
  position: relative;
}

/*
 * 右栏左边缘的拖拽手柄：7px 热区压住发丝线，悬停/拖拽时亮一条线提示可拖。
 * 往左拖变宽、往右拖变窄；双击恢复默认宽度（逻辑在 RightPanel.tsx）。
 */
.pa-right__resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 7px;
  z-index: 3;
  cursor: col-resize;
  background: transparent;
}
.pa-right__resizer::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: transparent;
  transition: background 120ms ease;
}
.pa-right__resizer:hover::after,
body[data-pa-resizing='true'] .pa-right__resizer::after {
  background: var(--pa-line-2);
}
/* 拖拽中禁止选中文字：否则鼠标划过聊天区会整片变蓝。 */
body[data-pa-resizing='true'] {
  cursor: col-resize;
  user-select: none;
}
.pa-right__head { position: relative; padding: 18px 16px 8px; flex: none; }
.pa-right__actions {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  gap: 6px;
}
.pa-right__actions .pa-icon-btn {
  background: rgba(128, 132, 140, 0.13);
  width: 28px;
  height: 28px;
}
.pa-right__actions .pa-icon-btn:hover { background: rgba(128, 132, 140, 0.24); }
.pa-right__avatar { display: flex; justify-content: center; margin-top: 6px; }
.pa-right__name {
  margin-top: 10px;
  text-align: center;
  font-size: calc(16px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--pa-text);
}
.pa-right__role {
  margin-top: 3px;
  text-align: center;
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-text-3);
  line-height: 1.4;
  padding: 0 16px;
}
.pa-right__tabs {
  display: flex;
  justify-content: center;
  gap: 28px;
  padding: 6px 12px 0;
  border-bottom: 1px solid var(--pa-line);
  flex: none;
}
.pa-right__tab {
  position: relative;
  height: 36px;
  padding: 0 2px;
  font-size: calc(12px + var(--pa-font-delta));
  color: var(--pa-text-3);
  transition: color 120ms ease;
}
.pa-right__tab:hover { color: var(--pa-text-2); }
.pa-right__tab[data-on='true'] { color: var(--pa-text); font-weight: 600; }
.pa-right__tab[data-on='true']::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--pa-text);
}
.pa-right__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 16px 26px;
}
.pa-right-sec {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0 8px;
  font-size: calc(11px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.03em;
  color: var(--pa-text-3);
}
.pa-right-sec__count {
  margin-left: auto;
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-text-4);
  letter-spacing: 0;
}
.pa-sidebar-empty { margin: 18px 8px 0; padding: 12px; border-radius: 10px; border: 1px dashed var(--pa-line-2); color: var(--pa-text-3); font-size: calc(11px + var(--pa-font-delta)); line-height: calc(17px + var(--pa-font-delta)); text-align: center; }
.pa-right__empty {
  padding: 26px 12px;
  text-align: center;
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-text-4);
  line-height: 1.6;
}

/* 通话收起条 */
.pa-call-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 10px 12px 0;
  padding: 8px 10px;
  border-radius: 12px;
  background: linear-gradient(120deg, rgba(48, 209, 88, 0.18), rgba(255, 159, 10, 0.12));
  border: 1px solid rgba(48, 209, 88, 0.26);
}
.pa-call-bar__text { flex: 1; min-width: 0; font-size: calc(10px + var(--pa-font-delta)); color: var(--pa-text-3); }
.pa-call-bar__text b { display: block; font-size: calc(12px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); }
.pa-call-bar__btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-2);
  background: rgba(128, 132, 140, 0.16);
  flex: none;
}
.pa-call-bar__btn:hover { background: rgba(128, 132, 140, 0.28); color: var(--pa-text); }
.pa-call-bar__btn--hangup { background: rgba(255, 69, 58, 0.9); color: #ffffff; }
.pa-call-bar__btn--hangup:hover { background: #ff453a; }

/* 任务卡 */
.pa-task-card {
  background: var(--pa-card);
  border-radius: 12px;
  margin-bottom: 8px;
  overflow: hidden;
}
.pa-task-card__head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 11px;
  text-align: left;
}
.pa-task-card__head:hover { background: rgba(128, 132, 140, 0.06); }
.pa-task-ico { color: var(--pa-text-2); margin-top: 1px; flex: none; }
.pa-task-main { flex: 1; min-width: 0; }
.pa-task-title {
  display: block;
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  line-height: 1.35;
  word-break: break-word;
}
.pa-task-sub {
  display: block;
  margin-top: 3px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  line-height: 1.4;
}
.pa-task-caret { color: var(--pa-text-4); margin-top: 2px; flex: none; transition: transform 150ms ease; }
.pa-task-card[data-open='true'] .pa-task-caret { transform: rotate(90deg); }
.pa-task-detail {
  padding: 8px 12px 0 35px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  line-height: 1.55;
}
.pa-task-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 12px 11px 35px;
  border-top: 1px solid var(--pa-line);
  margin-top: 8px;
}
.pa-task-step {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-2);
  line-height: 1.45;
}
.pa-task-step svg { flex: none; margin-top: 1px; color: var(--pa-text-3); }
.pa-task-step[data-done='true'] { color: var(--pa-text-3); }
.pa-task-step[data-done='true'] svg { color: var(--pa-green); }

/* 例行任务 */
.pa-routine {
  background: var(--pa-card);
  border-radius: 11px;
  padding: 10px 11px;
  margin-bottom: 7px;
}
.pa-routine__head { display: flex; align-items: center; gap: 8px; }
.pa-routine__name {
  flex: 1;
  min-width: 0;
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-routine__meta {
  margin-top: 4px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  line-height: 1.45;
}
.pa-routine__actions { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
.pa-link-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  transition: color 120ms ease;
}
.pa-link-btn:hover { color: var(--pa-text); }
.pa-link-btn--danger:hover { color: #ff8a82; }
.pa-add-dashed {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 32px;
  margin-top: 8px;
  border-radius: 10px;
  border: 1px dashed var(--pa-line-2);
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
}
.pa-add-dashed:hover {
  border-color: rgba(255, 159, 10, 0.5);
  color: var(--pa-accent);
  background: rgba(255, 159, 10, 0.05);
}
.pa-empty-card {
  background: var(--pa-card);
  border-radius: 12px;
  padding: 12px;
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-text-3);
  line-height: 1.6;
}

/* 子 Bot 管理 */
.pa-submanage { display: flex; flex-direction: column; gap: 7px; }
.pa-submanage__row { background: var(--pa-card); border-radius: 11px; padding: 9px 10px; }
.pa-submanage__top { display: flex; align-items: center; gap: 8px; }
.pa-submanage__main { flex: 1; min-width: 0; }
.pa-submanage__name {
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-submanage__meta {
  margin-top: 1px;
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-submanage__ops { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.pa-mini-select {
  height: 24px;
  max-width: 104px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid var(--pa-line-2);
  background: rgba(128, 132, 140, 0.08);
  color: var(--pa-text-2);
  font-size: calc(10.5px + var(--pa-font-delta));
  outline: none;
}
.pa-mini-btn {
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(128, 132, 140, 0.12);
  color: var(--pa-text-2);
  font-size: calc(10.5px + var(--pa-font-delta));
  transition: background 120ms ease, color 120ms ease;
  white-space: nowrap;
}
.pa-mini-btn:hover { background: rgba(128, 132, 140, 0.24); color: var(--pa-text); }
.pa-mini-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.pa-mini-btn--danger { background: rgba(255, 69, 58, 0.14); color: #ff8a82; }
.pa-mini-btn--danger:hover { background: rgba(255, 69, 58, 0.24); color: #ffb3ae; }
.pa-mini-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 7px;
  border-radius: 6px;
  border: 1px solid rgba(255, 159, 10, 0.5);
  background: rgba(128, 132, 140, 0.08);
  color: var(--pa-text);
  font-size: calc(11px + var(--pa-font-delta));
  outline: none;
}

/* 资料库 */
.pa-mem-search { position: relative; margin-bottom: 9px; }
.pa-mem-search svg {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--pa-text-4);
  pointer-events: none;
}
.pa-mem-search input {
  width: 100%;
  height: 32px;
  padding: 0 10px 0 30px;
  border-radius: 9px;
  border: 1px solid var(--pa-line-2);
  background: rgba(128, 132, 140, 0.07);
  color: var(--pa-text);
  font-size: calc(11.5px + var(--pa-font-delta));
  outline: none;
}
.pa-mem-search input:focus { border-color: rgba(255, 159, 10, 0.55); }
.pa-mem-search input::placeholder { color: var(--pa-text-4); }
.pa-mem-filters {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 8px;
  margin-bottom: 1px;
  scrollbar-width: none;
}
.pa-mem-filters::-webkit-scrollbar { display: none; }
.pa-filter-chip {
  height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  background: rgba(128, 132, 140, 0.12);
  color: var(--pa-text-3);
  font-size: calc(10.5px + var(--pa-font-delta));
  white-space: nowrap;
  flex: none;
  transition: background 120ms ease, color 120ms ease;
}
.pa-filter-chip:hover { color: var(--pa-text-2); }
.pa-filter-chip[data-on='true'] { background: var(--pa-card-2); color: var(--pa-text); }
.pa-mem-card {
  position: relative;
  background: var(--pa-card);
  border-radius: 11px;
  padding: 10px 11px;
  margin-bottom: 7px;
}
.pa-mem-text {
  padding-right: 18px;
  font-size: calc(11.5px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.pa-mem-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.pa-mem-tag {
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(128, 132, 140, 0.14);
  color: var(--pa-text-3);
  font-size: calc(9.5px + var(--pa-font-delta));
}
.pa-mem-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 6px;
  font-size: calc(9.5px + var(--pa-font-delta));
  color: var(--pa-text-4);
}
.pa-mem-src {
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(255, 159, 10, 0.12);
  color: var(--pa-accent);
}
.pa-mem-del {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-4);
  opacity: 0;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
}
.pa-mem-card:hover .pa-mem-del { opacity: 1; }
.pa-mem-del:hover { background: rgba(255, 69, 58, 0.16); color: #ff8a82; }
.pa-mem-add { display: flex; align-items: flex-end; gap: 6px; margin-top: 10px; }
.pa-mem-add textarea {
  flex: 1;
  min-width: 0;
  min-height: 34px;
  max-height: 88px;
  padding: 8px 9px;
  border-radius: 9px;
  border: 1px solid var(--pa-line-2);
  background: rgba(128, 132, 140, 0.07);
  color: var(--pa-text);
  font-size: calc(11.5px + var(--pa-font-delta));
  line-height: 1.5;
  resize: vertical;
  outline: none;
}
.pa-mem-add textarea:focus { border-color: rgba(255, 159, 10, 0.55); }
.pa-mem-add textarea::placeholder { color: var(--pa-text-4); }
.pa-mem-add button {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--pa-card-2);
  color: var(--pa-text-2);
  flex: none;
  transition: background 120ms ease, color 120ms ease;
}
.pa-mem-add button:hover { background: var(--pa-accent); color: #1a1206; }
.pa-mem-add button:disabled { opacity: 0.4; cursor: not-allowed; }

/* 电脑 */
.pa-tree { background: var(--pa-card); border-radius: 12px; padding: 8px 7px; }
.pa-tree__row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding: 0 6px;
  border-radius: 6px;
  font-size: calc(11.5px + var(--pa-font-delta));
  color: var(--pa-text-2);
  text-align: left;
  width: 100%;
}
.pa-tree__row:hover { background: rgba(128, 132, 140, 0.12); }
.pa-tree__row[data-file='true'] { cursor: default; }
.pa-tree__row[data-file='true']:hover { background: transparent; }
.pa-tree__row svg { flex: none; color: var(--pa-text-3); }
.pa-tree__caret {
  width: 12px;
  height: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-4);
  flex: none;
  transition: transform 120ms ease;
}
.pa-tree__caret[data-open='true'] { transform: rotate(90deg); }
.pa-tree__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-term {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: #0e0f11;
  color: #b9bec7;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
.pa-term b { color: #7ee2a0; font-weight: 500; }
.pa-term i { color: #ffb45c; font-style: normal; }

/* ───────────────────────── 新建 Bot / 新建群聊弹窗 ───────────────────────── */
.pa-create-modal {
  max-width: 560px;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pa-create-head {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 22px 24px 18px;
  border-bottom: 1px solid var(--pa-line);
  flex: none;
}
.pa-create-head__icon {
  width: 42px;
  height: 42px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 13px;
}
.pa-create-head__icon--bot {
  color: #ffb45c;
  background: linear-gradient(145deg, rgba(255, 159, 10, 0.26), rgba(255, 159, 10, 0.08));
  box-shadow: inset 0 0 0 1px rgba(255, 159, 10, 0.16);
}
.pa-create-head__icon--room {
  color: #7cb8ff;
  background: linear-gradient(145deg, rgba(10, 132, 255, 0.28), rgba(10, 132, 255, 0.08));
  box-shadow: inset 0 0 0 1px rgba(10, 132, 255, 0.18);
}
.pa-create-head__text { flex: 1; min-width: 0; padding-top: 1px; }
.pa-create-head__title {
  font-size: calc(16px + var(--pa-font-delta));
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--pa-text);
}
.pa-create-head__sub {
  margin: 4px 0 0;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text-3);
}
.pa-create-body {
  padding: 18px 24px 4px;
  overflow-y: auto;
  min-height: 0;
}
.pa-create-sec { margin-bottom: 18px; }
.pa-create-sec:last-child { margin-bottom: 8px; }
.pa-create-sec__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 9px;
  font-size: calc(11px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--pa-text-2);
}
.pa-create-sec__head em {
  margin-left: 4px;
  font-style: normal;
  font-weight: 400;
  color: var(--pa-text-4);
}
.pa-create-sec__aside {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-weight: 400;
  letter-spacing: 0;
}
.pa-create-sec__aside em {
  margin: 0;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-4);
}
.pa-create-sec__aside .pa-link-btn:disabled { opacity: 0.35; cursor: default; }
.pa-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pa-form-grid .pa-form-row { margin-bottom: 0; }
.pa-label em {
  margin-left: 3px;
  font-style: normal;
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-text-4);
}
.pa-create-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 24px;
  border-top: 1px solid var(--pa-line);
  background: rgba(128, 132, 140, 0.035);
  flex: none;
}
.pa-create-foot__hint {
  margin: 0;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.45;
  color: var(--pa-text-4);
}
.pa-create-foot__actions { display: flex; gap: 8px; flex: none; }
.pa-create-foot__actions .pa-btn { padding: 0 14px; }
.pa-create-foot .pa-btn--primary { min-width: 96px; }

.pa-suggest-refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: calc(10.5px + var(--pa-font-delta));
  font-weight: 400;
  letter-spacing: 0;
  color: var(--pa-text-3);
  transition: color 120ms ease;
}
.pa-suggest-refresh:hover { color: var(--pa-text); }
.pa-suggest-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pa-root button.pa-suggest-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-height: 62px;
  padding: 10px 11px;
  border-radius: 11px;
  border: 1px solid var(--pa-line-2);
  background: rgba(128, 132, 140, 0.08);
  text-align: left;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
}
.pa-root button.pa-suggest-chip:hover {
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(128, 132, 140, 0.16);
  transform: translateY(-1px);
}
.pa-root button.pa-suggest-chip[data-active='true'] {
  border-color: rgba(255, 159, 10, 0.6);
  background: rgba(255, 159, 10, 0.1);
}
.pa-suggest-chip b { font-size: calc(11.5px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); }
.pa-suggest-chip span {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: calc(10px + var(--pa-font-delta));
  line-height: 1.45;
  color: var(--pa-text-3);
}

/* ───────────────────────── 群聊设置 ───────────────────────── */
.pa-group-sec { margin-bottom: 16px; }
.pa-group-sec:last-child { margin-bottom: 0; }
.pa-group-sec__title {
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-text-3);
  margin-bottom: 8px;
  letter-spacing: 0.02em;
}
.pa-radio {
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
.pa-radio:hover { background: rgba(128, 132, 140, 0.1); }
.pa-radio[data-checked='true'] {
  border-color: rgba(255, 159, 10, 0.55);
  background: rgba(255, 159, 10, 0.06);
}
.pa-radio input {
  margin: 2px 0 0;
  accent-color: var(--pa-accent);
  flex: none;
}
.pa-radio__main b { display: block; font-size: calc(12px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); }
.pa-radio__main span {
  display: block;
  margin-top: 2px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  line-height: 1.45;
}
.pa-member-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.pa-member-chip {
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
.pa-member-chip button {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-4);
  flex: none;
}
.pa-member-chip button:hover { background: rgba(255, 69, 58, 0.2); color: #ff8a82; }
.pa-member-add {
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
.pa-member-add:hover { color: var(--pa-accent); border-color: rgba(255, 159, 10, 0.5); }
.pa-add-member-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--pa-line-2);
  background: rgba(128, 132, 140, 0.06);
  max-height: 168px;
  overflow-y: auto;
}
.pa-add-member-item {
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
.pa-add-member-item:hover { background: rgba(128, 132, 140, 0.14); color: var(--pa-text); }
.pa-add-member-item small { margin-left: auto; font-size: calc(9.5px + var(--pa-font-delta)); color: var(--pa-text-4); }

/* ───────────────────────── 设置弹窗 ───────────────────────── */
.pa-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 12px;
  margin-bottom: 8px;
  border-radius: 11px;
  background: var(--pa-card);
}
.pa-settings-row__main { min-width: 0; }
.pa-settings-row__main b { display: block; font-size: calc(12px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); }
.pa-settings-row__main span {
  display: block;
  margin-top: 2px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  line-height: 1.45;
}
.pa-theme-seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: rgba(128, 132, 140, 0.12);
  flex: none;
}
.pa-theme-seg button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border-radius: 6px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-theme-seg button[data-on='true'] { background: var(--pa-card-2); color: var(--pa-text); }
.pa-settings-note {
  margin-bottom: 10px;
  padding: 11px 12px;
  border-radius: 11px;
  background: var(--pa-card);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.65;
  color: var(--pa-text-3);
}
.pa-settings-note b { color: var(--pa-text-2); font-weight: 600; }
.pa-settings-actions { display: flex; flex-wrap: wrap; gap: 8px; }
/* 读写宿主配置失败时的可见提示（红字条，不弹窗） */
.pa-settings-error {
  margin-bottom: 10px;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 69, 58, 0.35);
  background: rgba(255, 69, 58, 0.1);
  color: #ff8a82;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.5;
  word-break: break-word;
}

/* ───────────────────────── 亮色补充 ───────────────────────── */
.pa-root[data-pa-theme='light'] .pa-sidebar .pa-mode-seg button {
  color: #5d6269;
}
.pa-root[data-pa-theme='light'] .pa-sidebar .pa-mode-seg button[data-on='true'] {
  background: #ffffff;
  color: #14161a;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.pa-root[data-pa-theme='light'] .pa-sidebar__top .pa-icon-btn--bordered {
  background: rgba(15, 17, 21, 0.06);
}
.pa-root[data-pa-theme='light'] .pa-right__actions .pa-icon-btn {
  background: rgba(15, 17, 21, 0.06);
}
.pa-root[data-pa-theme='light'] .pa-suggest-chip {
  background: rgba(15, 17, 21, 0.045);
}
.pa-root[data-pa-theme='light'] .pa-suggest-chip:hover {
  background: rgba(15, 17, 21, 0.07);
}
.pa-root[data-pa-theme='light'] .pa-create-item__icon--bot {
  color: #b96f00;
  background: linear-gradient(145deg, rgba(255, 159, 10, 0.16), rgba(255, 159, 10, 0.05));
}
.pa-root[data-pa-theme='light'] .pa-create-item__icon--room {
  color: #0a66c9;
  background: linear-gradient(145deg, rgba(10, 132, 255, 0.14), rgba(10, 132, 255, 0.04));
}
.pa-root[data-pa-theme='light'] .pa-create-foot {
  background: rgba(15, 17, 21, 0.025);
}
/* 浅色下 #ff453a 对白底只有约 3.4:1，小字提示换成更深的红 */
.pa-root[data-pa-theme='light'] .pa-form-hint--warn {
  color: #c62828;
}
.pa-root[data-pa-theme='light'] .pa-member-pick__row {
  background: rgba(15, 17, 21, 0.02);
}
.pa-root[data-pa-theme='light'] .pa-member-pick__row:hover {
  background: rgba(15, 17, 21, 0.05);
}
.pa-root[data-pa-theme='light'] .pa-member-pick__row[data-on='true'] {
  background: rgba(255, 159, 10, 0.09);
}
.pa-root[data-pa-theme='light'] .pa-mem-search input,
.pa-root[data-pa-theme='light'] .pa-mem-add textarea,
.pa-root[data-pa-theme='light'] .pa-mini-select {
  background: rgba(15, 17, 21, 0.03);
}
.pa-root[data-pa-theme='light'] .pa-radio {
  background: rgba(15, 17, 21, 0.025);
}
.pa-root[data-pa-theme='light'] .pa-filter-chip,
.pa-root[data-pa-theme='light'] .pa-member-chip,
.pa-root[data-pa-theme='light'] .pa-mini-btn {
  background: rgba(15, 17, 21, 0.07);
}

/* 窄屏：右栏逐档收窄，给聊天区留出阅读宽度（参考图 900 宽时右栏约 230px） */
@media (max-width: 1200px) {
  .pa-right { width: 268px; flex-basis: 268px; }
  /*
   * 窄屏固定宽度，拖拽改了也会被上面的规则覆盖——干脆收起手柄，
   * 不留一个「拖了没反应」的交互。
   */
  .pa-right__resizer { display: none; }
}
@media (max-width: 1000px) {
  .pa-right { width: 232px; flex-basis: 232px; }
  .pa-right__body { padding-left: 12px; padding-right: 12px; }
}
@media (max-width: 900px) {
  .pa-right { width: 232px; flex-basis: 232px; }
}

/* 新建群聊成员选择 / 分组管理 */
.pa-member-pick {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 330px;
  overflow-y: auto;
  padding-right: 2px;
}
.pa-root button.pa-member-pick__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--pa-line);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.025);
  text-align: left;
  transition: background 120ms ease, border-color 120ms ease;
}
.pa-root button.pa-member-pick__row:hover { background: rgba(255, 255, 255, 0.055); }
.pa-root button.pa-member-pick__row[data-on='true'] {
  border-color: rgba(255, 159, 10, 0.38);
  background: rgba(255, 159, 10, 0.08);
}
.pa-member-pick__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pa-member-pick__main b {
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-member-pick__main small {
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-member-pick__check {
  width: 18px;
  height: 18px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--pa-line-2);
  border-radius: 50%;
  color: #1a1206;
  transition: background 120ms ease, border-color 120ms ease;
}
.pa-member-pick__row[data-on='true'] .pa-member-pick__check {
  border-color: var(--pa-accent);
  background: var(--pa-accent);
}
.pa-group-list { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 8px; }
.pa-group-row { display: flex; align-items: center; gap: 8px; font-size: calc(12px + var(--pa-font-delta)); color: var(--pa-text-2); }
.pa-group-row__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-group-row__name em { font-style: normal; font-size: calc(10px + var(--pa-font-delta)); color: var(--pa-text-4); margin-left: 6px; }
.pa-group-add { display: flex; gap: 6px; margin-bottom: 12px; }
.pa-group-add .pa-field { flex: 1; height: 30px; padding: 4px 9px; font-size: calc(12px + var(--pa-font-delta)); }
.pa-link-btn--danger { color: #ff8a82; }

/* 新建弹窗在窄屏下：单列、底部操作区换行 */
@media (max-width: 620px) {
  .pa-create-modal { max-width: calc(100vw - 28px); }
  .pa-form-grid { grid-template-columns: 1fr; }
  .pa-suggest-grid { grid-template-columns: 1fr; }
  .pa-create-head { padding: 18px 18px 15px; }
  .pa-create-body { padding: 16px 18px 2px; }
  .pa-create-foot { padding: 12px 18px; flex-direction: column; align-items: stretch; }
  .pa-create-foot__actions { justify-content: flex-end; }
}
`

let injected = false

/** 幂等注入左侧栏 / 右栏 / 弹窗样式；返回是否本次真正插入。 */
export function injectShellStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-shell-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-shell-styles'
  style.textContent = PERSONAL_SHELL_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function shellStylesInjected(): boolean {
  return injected
}
