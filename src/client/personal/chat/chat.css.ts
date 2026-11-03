/**
 * Personal Agent — 聊天主区样式（会话头 / 消息流 / 气泡 / 卡片 / 输入框）。
 *
 * 深色为基准：Bot 消息是左对齐深灰圆角卡（#202124），用户消息是右侧灰蓝气泡
 * （--pa-card-3，18px 圆角、右下 6px）；输入框为整体圆角胶囊。亮色主题通过
 * base.css.ts 覆盖的 --pa-* 变量自动适配，另外补少量 hover/玻璃色。
 *
 * 本文件只导出字符串与幂等注入函数；所有选择器以 .pa- 前缀避免污染宿主。
 */

export const PERSONAL_CHAT_CSS = `
.pa-root {
  --pa-chat-hover: rgba(255, 255, 255, 0.06);
  --pa-chat-hover-strong: rgba(255, 255, 255, 0.10);
  --pa-chat-glass: rgba(255, 255, 255, 0.035);
  --pa-chat-glass-2: rgba(255, 255, 255, 0.055);
  --pa-chat-sender: #a7abb2;
  /*
   * 气泡配色（对齐参考图：bot 中性底、用户品牌蓝、四角同半径的大圆角）。
   * 深色下 bot 气泡比画布（--pa-main #181819）亮一档，靠色差浮出来而不是描边；
   * 用户气泡是品牌蓝 + 白字。亮色主题在下面整组换成浅灰 / 浅蓝 + 深字。
   */
  --pa-bubble-radius: 20px;
  --pa-bubble-bot-bg: #1f1f20;
  --pa-bubble-bot-fg: #ffffff;
  --pa-bubble-user-bg: #0074e8;
  --pa-bubble-user-fg: #ffffff;
}
.pa-root[data-pa-theme='light'] {
  --pa-chat-hover: rgba(15, 17, 21, 0.05);
  --pa-chat-hover-strong: rgba(15, 17, 21, 0.09);
  --pa-chat-glass: rgba(15, 17, 21, 0.035);
  --pa-chat-glass-2: rgba(15, 17, 21, 0.06);
  --pa-chat-sender: #5d6269;
  --pa-bubble-bot-bg: #e9eaeb;
  --pa-bubble-bot-fg: #111112;
  --pa-bubble-user-bg: #b8dbfe;
  --pa-bubble-user-fg: #111112;
}

/* ---------- 聊天主列 ---------- */
.pa-main-col {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--pa-main);
  position: relative;
}
.pa-chat {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--pa-main);
  color: var(--pa-text);
  /*
   * 对话列宽度：默认 100%（铺满主列），用户从两侧拖拽后收窄并居中。
   * 只读 --pa-chat-w，不碰左右侧栏——侧栏折叠 / 拖拽不会改变这里。
   * 高度交给 flex 撑满（会话头移出后这里只剩消息流 + 输入区，不能再写 height:100%）。
   */
  width: min(100%, var(--pa-chat-w, 100%));
  align-self: center;
  position: relative;
}

/*
 * 对话流两侧的拖拽手柄：8px 热区贴在 .pa-chat 左右边缘，hover / 拖拽时亮一条线。
 * 放在 .pa-chat 内部而不是侧栏上：不会被侧栏的滚动区或 hover 层盖住。
 */
.pa-chat__resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  z-index: 14;
  cursor: col-resize;
  background: transparent;
  touch-action: none;
}
.pa-chat__resizer--left { left: 10px; }
.pa-chat__resizer--right { right: 10px; }
.pa-chat__resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: transparent;
  transition: background 120ms ease;
}
.pa-chat__resizer--left::after { left: 4px; }
.pa-chat__resizer--right::after { right: 4px; }
.pa-chat__resizer:hover::after,
body[data-pa-resizing='true'] .pa-chat__resizer::after {
  background: var(--pa-line-2);
}
@media (max-width: 900px) {
  /* 窄屏没有拖拽手柄，直接铺满，避免宽屏留下的自定义宽度在小窗里挤出空白。 */
  .pa-chat { width: 100%; }
  /* 会话头内容同步铺满：不跟 --pa-chat-w 走，否则窄屏下头像与消息列对不齐。 */
  .pa-chat__head-inner { width: 100%; }
  .pa-chat__resizer { display: none; }
}

/* ---------- 会话头 ----------
 * 高度与 Work 模式的官方会话标题栏（.wSkVaW_header，44px）一致：两个模式
 * 切换时消息流的第一行不会上下跳。左内边距也对齐官方那 20px。
 *
 * 这一条横在对话列**外面**（.pa-main-col 的直接子级）：下边框必须从左栏一路
 * 顶到右栏。以前它住在 .pa-chat 里，对话列一拖窄（--pa-chat-w < 100%）边框就
 * 跟着缩，两端露出缺口——用户明确要求「永远占满，不要两端与侧边栏有间隙」。
 * 头部内容由 .pa-chat__head-inner 按对话列宽度居中，所以对齐方式没有变化。 */
.pa-chat__header {
  flex: none;
  height: 44px;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--pa-line);
  background: var(--pa-main);
  position: relative;
  z-index: 12;
}
/* 内容容器：宽度跟对话列走，水平居中；header 自身永远铺满主列。
 * flex 用 0 1 auto（不是 1）——写成 flex:1 会被 flex-grow 撑满，width 形同虚设，
 * 对话列拖窄后头像和按钮仍贴在主列两端，跟下面的消息流对不齐。 */
.pa-chat__head-inner {
  flex: 0 1 auto;
  width: min(100%, var(--pa-chat-w, 100%));
  min-width: 0;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 28px 0 20px;
}
.pa-chat__head-avatar { flex: none; display: flex; align-items: center; }
.pa-chat__stack {
  display: flex;
  align-items: center;
  width: 28px;
  height: 28px;
  flex: none;
}
.pa-chat__stack > .pa-avatar {
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--pa-main);
  background: var(--pa-main);
}
.pa-chat__stack > .pa-avatar + .pa-avatar { margin-left: -10px; }
/* 名称与角色/成员数并排一行（原来上下两行，44px 头部里一行更紧凑） */
.pa-chat__head-text {
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
}
.pa-chat__head-name {
  flex: 0 2 auto;
  min-width: 0;
  font-size: calc(14px + var(--pa-font-delta));
  font-weight: 600;
  line-height: calc(18px + var(--pa-font-delta));
  color: var(--pa-text);
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-chat__head-sub {
  flex: 0 1 auto;
  min-width: 0;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  color: var(--pa-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-chat__head-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; }
.pa-chat__head-btn {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-text-2);
  background: transparent;
  transition: background 130ms ease, color 130ms ease, transform 100ms ease;
}
.pa-chat__head-btn:hover { background: var(--pa-chat-hover); color: var(--pa-text); }
.pa-chat__head-btn:active { transform: scale(0.94); }
.pa-chat__head-btn[data-on='true'] { color: var(--pa-accent); }
.pa-chat__more { position: relative; display: flex; }
.pa-chat__menu {
  position: absolute;
  top: 40px;
  right: 0;
  min-width: 178px;
  padding: 6px;
  border-radius: 12px;
  background: #232427;
  border: 1px solid var(--pa-line-2);
  box-shadow: var(--pa-shadow-pop);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 2px;
  animation: pa-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-root[data-pa-theme='light'] .pa-chat__menu { background: #ffffff; }
.pa-chat__menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border-radius: 7px;
  text-align: left;
  font-size: calc(12px + var(--pa-font-delta));
  color: var(--pa-text-2);
  transition: background 110ms ease, color 110ms ease;
}
.pa-chat__menu button:hover { background: var(--pa-chat-hover); color: var(--pa-text); }
.pa-chat__menu button svg { flex: none; }
/* 破坏性操作（清空对话）：红字提示，但只在 hover 时才强调 */
.pa-chat__menu button.pa-chat__menu-danger { color: var(--pa-red); }
.pa-chat__menu button.pa-chat__menu-danger:hover { background: rgba(255, 69, 58, 0.12); color: var(--pa-red); }

/* 清空对话确认卡：自绘，替代 window.confirm（原生对话框会带 dsh-shell 标题、样式脱离界面） */
.pa-confirm { width: 380px; max-width: calc(100vw - 48px); }
.pa-confirm__lead {
  margin: 0 0 6px;
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.6;
  color: var(--pa-text);
}
.pa-confirm__hint {
  margin: 0;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text-3);
}

/* ---------- 消息流 ---------- */
.pa-chat__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px 30px 26px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scroll-behavior: smooth;
}
/*
 * 回到最新：悬浮在**输入框上方右侧**，往上翻远之后才淡入（见 MessageList 的 onScroll）。
 *
 * 定位桩：0 高度、夹在滚动容器和输入框之间，按钮挂在它上面往上浮。这样输入框
 * 高度怎么变（引用条 / 待处理条 / 语音条 / 多行输入）都不用跟着改数。
 * 底色/描边/投影按用户给的参考图：圆形深灰底 + 向下箭头。
 */
.pa-chat__to-bottom-wrap {
  position: relative;
  flex: none;
  height: 0;
  z-index: 15;
}
.pa-chat__to-bottom {
  position: absolute;
  right: 18px;
  bottom: 10px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--pa-card-2);
  border: 1px solid var(--pa-line-2);
  color: var(--pa-text);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  opacity: 0;
  transform: translateY(6px) scale(0.9);
  pointer-events: none;
  transition: opacity 140ms ease, transform 140ms ease, background 120ms ease, color 120ms ease;
}
.pa-chat__to-bottom[data-on='true'] {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.pa-chat__to-bottom:hover { background: var(--pa-card-3); }
.pa-chat__to-bottom:active { transform: scale(0.94); }
.pa-root[data-pa-theme='light'] .pa-chat__to-bottom {
  background: #ffffff;
  box-shadow: 0 6px 18px rgba(15, 17, 21, 0.14);
}
.pa-root[data-pa-theme='light'] .pa-chat__to-bottom:hover { background: #f1f2f4; }
.pa-chat__sep {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2px 0 4px;
  flex: none;
}
.pa-chat__sep > span {
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-text-3);
  background: var(--pa-chat-glass);
  border-radius: 999px;
  padding: 3px 11px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

/* ---------- 语音通话折叠条 ----------
 * 一段语音通话的**分隔标记**：两条发丝线夹一行小字。它刻意不是卡片——段内的
 * 转写与产物都是普通消息（普通气泡），这条只负责把整段收起来 / 放出来。
 *
 * 用户原话：「收起只是把之前语音开始到截止这一段收起，而不是改变 UI 样式」。
 * 所以这里不给底色、不给描边、不给圆角框，只在 hover / 键盘聚焦时给标签浮一层
 * 极淡的底——扫过对话流时它应该像时间分隔，而不是又一个可点的面板。 */
.pa-callseg-row {
  display: flex;
  width: 100%;
  min-width: 0;
  animation: pa-rise 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-callseg {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 2px 0;
  background: none;
  border: 0;
  color: var(--pa-text-3);
  font: inherit;
  text-align: left;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.pa-callseg:focus-visible { outline: none; }
.pa-callseg__rule {
  flex: 1 1 auto;
  height: 1px;
  min-width: 12px;
  background: var(--pa-line);
}
.pa-callseg__label {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  white-space: nowrap;
  transition: background 160ms ease, color 160ms ease;
}
.pa-callseg:hover .pa-callseg__label,
.pa-callseg:focus-visible .pa-callseg__label { background: var(--pa-chat-hover); }
.pa-callseg__icon { flex: none; display: inline-flex; align-items: center; color: var(--pa-text-3); }
.pa-callseg[data-live='true'] .pa-callseg__icon { color: var(--pa-green); }
/* 展开时标题提亮一档：一眼能看出「这段是摊开的」，不需要额外的背景框。 */
.pa-callseg__title { color: var(--pa-text-2); }
.pa-callseg[data-open='true'] .pa-callseg__title,
.pa-callseg:hover .pa-callseg__title { color: var(--pa-text); }
.pa-callseg__meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--pa-text-3);
  font-variant-numeric: tabular-nums;
}
.pa-callseg[data-live='true'] .pa-callseg__meta { color: var(--pa-green); }
.pa-callseg__count { color: var(--pa-text-4); font-variant-numeric: tabular-nums; }
.pa-callseg__pulse {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pa-green);
  animation: pa-callseg-pulse 1.4s ease-in-out infinite;
}
.pa-callseg__caret {
  flex: none;
  color: var(--pa-text-4);
  transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pa-callseg[data-open='true'] .pa-callseg__caret { transform: rotate(180deg); }
.pa-callseg:hover .pa-callseg__caret { color: var(--pa-text-2); }
@keyframes pa-callseg-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .pa-callseg__pulse { animation: none; }
  .pa-callseg__caret { transition: none; }
}

/* ---------- 压缩标记（1.1） ----------
 * 一行居中小字，两侧发丝线；点开是摘要。刻意不做卡片、不用底色：
 * 它是对话流里的一次「环境变化」提示，不是内容，不该和消息抢注意力。 */
.pa-compaction-row { display: flex; justify-content: center; padding: 2px 0; }
.pa-compaction { width: 100%; max-width: 520px; display: flex; flex-direction: column; align-items: center; }
.pa-compaction__line {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 2px 0;
  color: var(--pa-text-3);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  cursor: default;
}
.pa-compaction[data-expandable='true'] .pa-compaction__line { cursor: pointer; }
.pa-compaction__line:disabled { cursor: default; }
.pa-compaction[data-expandable='true'] .pa-compaction__line:hover .pa-compaction__label { color: var(--pa-text-2); }
.pa-compaction__rule { flex: 1 1 auto; height: 1px; background: var(--pa-line); }
.pa-compaction__label { flex: none; white-space: nowrap; }
.pa-compaction__caret { flex: none; color: var(--pa-text-4); transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-compaction[data-open='true'] .pa-compaction__caret { transform: rotate(180deg); }
.pa-compaction__body {
  display: grid;
  grid-template-rows: 0fr;
  width: 100%;
  transition: grid-template-rows 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pa-compaction[data-open='true'] .pa-compaction__body { grid-template-rows: 1fr; }
.pa-compaction__inner { overflow: hidden; min-height: 0; }
.pa-compaction__summary {
  margin-top: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--pa-chat-glass);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-2);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.65;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
}
@media (prefers-reduced-motion: reduce) {
  .pa-compaction__caret { transition: none; }
}

/* ---------- 轮次容器（2.8） ----------
 * 头尾各一条发丝线 + 一行小字，中间就是普通消息 —— 不包外框、不加底色。
 * 容器是给「这一轮发生过什么」一个边界，不是又一张卡片：一旦做成卡片，
 * 一轮多消息就会在对话流里叠出一堆方框，比不做还吵。 */
.pa-turn__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 2px;
  padding: 0 2px;
  color: var(--pa-text-4);
  font-size: calc(10px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
}
.pa-turn__time { flex: none; color: var(--pa-text-3); font-variant-numeric: tabular-nums; }
.pa-turn__rule { flex: 1 1 auto; height: 1px; background: var(--pa-line); }
.pa-turn__state { flex: none; }
.pa-turn__head[data-state='running'] .pa-turn__state { color: var(--pa-accent); }
.pa-turn__toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--pa-text-4);
  font-size: inherit;
  line-height: inherit;
  cursor: pointer;
}
.pa-turn__toggle:hover { color: var(--pa-text-2); }
.pa-turn__toggle svg { flex: none; transform: rotate(180deg); transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-turn__foot {
  display: flex;
  align-items: center;
  margin: 2px 0 12px;
  padding: 0 2px;
  color: var(--pa-text-4);
  font-size: calc(10px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  font-variant-numeric: tabular-nums;
}
.pa-turn__foot span + span::before { content: ' · '; white-space: pre; }
.pa-turn__collapsed {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin: 2px 0 12px;
  padding: 6px 10px;
  border-radius: 9px;
  background: var(--pa-chat-glass);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  text-align: left;
  cursor: pointer;
}
.pa-turn__collapsed:hover { background: var(--pa-chat-glass-2); color: var(--pa-text-2); }
.pa-turn__collapsed svg { flex: none; }
@media (prefers-reduced-motion: reduce) {
  .pa-turn__toggle svg { transition: none; }
}

/* ---------- 消息行 ---------- */
.pa-msg {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 100%;
  animation: pa-rise 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-msg--bot { justify-content: flex-start; padding-right: 12%; }
.pa-msg--user { justify-content: flex-end; padding-left: 16%; }
.pa-msg__avatar { flex: none; width: 32px; height: 32px; margin-top: 1px; }
.pa-msg__content {
  flex: 1 1 auto;
  width: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-width: 88%;
  align-items: flex-start;
  /* 气泡后的「引用」按钮绝对定位挂在这里，不占消息间距。 */
  position: relative;
}
.pa-msg--user .pa-msg__content { flex: 0 1 auto; width: auto; align-items: flex-end; max-width: 88%; }
/*
 * 气泡定位容器：包住「气泡 + 侧边操作图标」，让图标相对**气泡**垂直居中。
 * 直接挂内容列的话，有「来自通话」标签或引用条时列被顶高一截，图标会浮到气泡
 * 中心上方（用户反馈「有的居中有的没居中」）。
 *
 * 宽度默认整列（卡片类消息靠它按 100% 算宽度）；纯文本消息用 --tight 收成
 * 气泡宽度，图标才能贴住气泡右沿而不是飘到行边缘。
 */
.pa-msg__body {
  position: relative;
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: flex-start;
}
.pa-msg--user .pa-msg__body { align-items: flex-end; }
.pa-msg__body--tight { width: fit-content; max-width: 100%; }
.pa-msg__sender {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  color: var(--pa-chat-sender);
  white-space: nowrap;
  max-width: 100%;
}
.pa-msg__sender-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
.pa-msg__tag {
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  color: var(--pa-text-3);
  background: var(--pa-chat-glass);
  border-radius: 4px;
  padding: 0 5px;
  flex: none;
}
/*
 * 多消息类别（DOST 形态）：
 *   finding    —— 左侧一道橙线 + 淡底，扫一眼就知道「这条要注意」
 *   need-input —— 整块换成卡片，问题要显眼，因为等用户回答
 *   approval   —— 同上但用红色系，语义是「有风险动作待批」
 * progress / final 不加装饰：它们是普通对话气泡，加框反而吵。
 */
.pa-msg__kind {
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  border-radius: 4px;
  padding: 0 5px;
  flex: none;
  font-weight: 500;
}
.pa-msg__kind--finding { color: var(--pa-accent); background: color-mix(in srgb, var(--pa-accent) 14%, transparent); }
.pa-msg__kind--need-input { color: var(--pa-blue); background: color-mix(in srgb, var(--pa-blue) 14%, transparent); }
.pa-msg__kind--approval { color: var(--pa-red); background: color-mix(in srgb, var(--pa-red) 14%, transparent); }
.pa-msg--finding .pa-msg__content {
  border-left: 2px solid var(--pa-accent);
  padding-left: 10px;
}
/*
 * need-input / approval：**外层不要再套卡片**。
 *
 * 这两类消息的正文本身就是一个 pa-int 卡片（自带背景、圆角、内边距）。外层再画
 * 一层背景和描边，就成了「卡片套卡片」——实测被用户直接说「太丑」。
 * 这里只做两件事：把宽度收到聊天气泡的量级、把外层内边距归零让内层卡片自己撑开。
 */
.pa-msg--need-input .pa-msg__content,
.pa-msg--approval .pa-msg__content {
  padding: 0;
  max-width: min(100%, 520px);
}
.pa-msg--need-input .pa-msg__body > .pa-int,
.pa-msg--approval .pa-msg__body > .pa-int {
  width: 100%;
}
/*
 * connector-suggest：「连接你的应用」推荐卡同样是「正文即卡片」。
 *
 * 与 need-input 的区别只有两点：宽度收到 490（一行「图标 + 名称 + 一句说明」，
 * 再宽就是空白），以及**不加任何装饰**——推荐应用不是告警，不要橙边和角标，
 * 让它安静地待在对话流里。
 */
.pa-msg--connector-suggest .pa-msg__content {
  padding: 0;
  max-width: min(100%, 490px);
}
.pa-msg--connector-suggest .pa-msg__body > .pa-con { width: 100%; }
.pa-msg--system {
  justify-content: center;
  padding: 0;
  animation: pa-rise 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-msg__system-text {
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-text-3);
  background: var(--pa-chat-glass);
  border-radius: 999px;
  padding: 4px 12px;
  max-width: 82%;
  text-align: center;
}

/* ---------- 气泡侧边的操作图标（引用 / 撤回） ----------
 * hover / 键盘聚焦时在气泡**侧面**浮出一排纯图标按钮，不带文字。
 *
 * 位置：挂在 .pa-msg__content 的 100% 处 —— bot 消息贴气泡右沿（气泡左对齐，
 * 右边是空白），用户消息贴左沿。所以纯文本消息的内容列必须先收窄到气泡宽度
 * （.pa-msg__content--tight），否则图标会飘到行边缘、离气泡老远。
 *
 * 为什么绝对定位：按钮常驻 DOM，参与布局的话每条消息都要为它让出一截宽度。
 * 触屏没有 hover：常显半透明，否则根本没有入口。 */
.pa-msg__tools {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
  z-index: 2;
}
.pa-msg--bot .pa-msg__tools { left: calc(100% + 6px); }
.pa-msg--user .pa-msg__tools { right: calc(100% + 6px); }
.pa-msg--bot:hover .pa-msg__tools,
.pa-msg--bot:focus-within .pa-msg__tools,
.pa-msg--user:hover .pa-msg__tools,
.pa-msg--user:focus-within .pa-msg__tools { opacity: 1; pointer-events: auto; }
@media (hover: none) {
  .pa-msg__tools { opacity: 0.62; pointer-events: auto; }
}
/*
 * 图标按钮：圆形热区 + hover 浮底，图标 15px。
 * 旧版是 11px 图标配 10px 中文，深色底上几乎看不清；纯图标反而更安静。
 */
button.pa-msg__tool {
  width: 28px;
  height: 28px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  /* 默认就比正文淡一档但看得清（--pa-text-4 在深色底上几乎消失），hover 再提亮。 */
  color: var(--pa-text-2);
  background: transparent;
  transition: background 120ms ease, color 120ms ease, transform 100ms ease;
}
button.pa-msg__tool:hover { background: var(--pa-chat-hover-strong); color: var(--pa-text); }
button.pa-msg__tool:active { transform: scale(0.92); }
/*
 * 朗读中的喇叭按钮：常亮品牌色 + 一圈很轻的脉冲。
 *
 * 只给这一枚按钮上色而不是整条消息：正在被念的是「这一条」，用户要一眼看出该停
 * 哪一条；给气泡上色会让人以为整轮都在播。脉冲用 box-shadow 向外扩散，不占布局、
 * 不推图标位置，1.6s 一轮，够弱不抢戏（reduced-motion 下直接关掉）。
 */
button.pa-msg__tool[data-speaking='true'] {
  color: var(--pa-accent);
  background: color-mix(in srgb, var(--pa-accent) 14%, transparent);
  animation: pa-msg-speaking 1.6s ease-in-out infinite;
}
button.pa-msg__tool[data-speaking='true']:hover {
  color: var(--pa-accent);
  background: color-mix(in srgb, var(--pa-accent) 22%, transparent);
}
@keyframes pa-msg-speaking {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--pa-accent) 40%, transparent); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--pa-accent) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  button.pa-msg__tool[data-speaking='true'] { animation: none; }
}

/* ---------- 引用条（2.3） ----------
 * 一条浅色细条：左侧一道竖线 + 「引用」+ 被引用消息摘要。
 * 不做背景块、不加圆角外框——引用是附注，不是第二张卡片。 */
button.pa-quote {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
  padding: 2px 6px 2px 0;
  color: var(--pa-text-3);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  text-align: left;
  cursor: pointer;
}
.pa-quote__rule { flex: none; width: 2px; height: 14px; border-radius: 1px; background: var(--pa-line-2); }
.pa-quote__label { flex: none; color: var(--pa-text-4); }
.pa-quote__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pa-text-2); }
button.pa-quote:hover .pa-quote__text { color: var(--pa-text); }
button.pa-quote:hover .pa-quote__rule { background: var(--pa-text-4); }

/* ---------- 气泡 ----------
 * 形态对齐参考图（DeepSeek 客户端）：四角同半径的大圆角、没有小尾巴、没有描边。
 * bot 用中性底（深色 #1F1F20 / 亮色 #E9EAEB）靠与画布的色差浮出来；用户用品牌蓝
 * （深色 #0074E8 白字 / 亮色 #B8DBFE 深字）。
 * 字号沿用「基础 13px + 用户字号差值」的既有档位（默认设置下渲染 15px，与参考图一致），
 * 行高收到 1.55：参考图 15px 字号配 23px 行距，旧值 1.62/1.68 偏松。 */
.pa-bubble {
  max-width: 100%;
  width: fit-content;
  border-radius: var(--pa-bubble-radius);
  padding: 12px 16px;
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.55;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
.pa-bubble--bot {
  background: var(--pa-bubble-bot-bg);
  color: var(--pa-bubble-bot-fg);
  border: 0;
  padding: 12px 16px;
  border-radius: var(--pa-bubble-radius);
}
.pa-bubble--user {
  background: var(--pa-bubble-user-bg);
  color: var(--pa-bubble-user-fg);
  border-radius: var(--pa-bubble-radius);
  padding: 10px 16px;
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.55;
}
.pa-msg--user .pa-bubble { background: var(--pa-bubble-user-bg); color: var(--pa-bubble-user-fg); }
.pa-bubble--plain { background: transparent; border: 0; padding: 0; }

.pa-md { color: inherit; font-size: calc(13px + var(--pa-font-delta)); line-height: 1.55; overflow-wrap: anywhere; }
.pa-md > *:first-child { margin-top: 0; }
.pa-md > *:last-child { margin-bottom: 0; }
.pa-md p { margin: 0 0 8px; }
.pa-md p:last-child { margin-bottom: 0; }
.pa-md strong { font-weight: 600; color: inherit; }
.pa-md code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: calc(12px + var(--pa-font-delta));
  background: var(--pa-chat-glass-2);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--pa-text);
}
.pa-md ul, .pa-md ol { margin: 6px 0; padding-left: 20px; }
.pa-md li { margin: 3px 0; }
.pa-md li::marker { color: var(--pa-text-3); }
.pa-md blockquote {
  margin: 8px 0;
  padding: 2px 0 2px 11px;
  border-left: 2px solid rgba(255, 159, 10, 0.5);
  color: var(--pa-text-2);
}
.pa-root[data-pa-theme='light'] .pa-md blockquote { border-left-color: rgba(255, 139, 0, 0.55); }

/* ---------- 正文图片（模型写的 Markdown 图片语法） ----------
 * ![alt](src) 现在渲染成真实图片。地址归一化（相对路径 → 宿主文件路由）在
 * MessageBlockView 的 toImageSrc 里做，这里只管外观：块级图片圆角居中、
 * 行内图片跟着文字流走。图片加载中先垫一层极淡底，避免整块白闪。 */
.pa-md__img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 8px 0;
  border-radius: 12px;
  background: var(--pa-chat-glass-2);
}
/* 一段文字里夹着的图片：跟文字排在同一行里。
 * 用后代选择器而不是直接子级 —— 普通段落把每一行都包在 span 里。 */
.pa-md p .pa-md__img { display: inline-block; margin: 4px 0; vertical-align: middle; }
/* 整段只有一张图片时的容器：居中，alt 非空时作小字 caption。 */
.pa-md__figure {
  margin: 10px 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.pa-md__figure .pa-md__img { margin: 0; }
/* 块级图片限宽：消息列在宽屏下能到 850px，图铺满会把整段正文压成一条；
 * 420px 上限与生图卡单图档位一致，figure 保持居中、不溢出。 */
.pa-md__figure .pa-md__img--block { max-width: min(100%, 420px); }
/* 图片加载失败：bot 工作区的 _tmp 会被清理器定期清掉，旧消息图片 URL 会 404。
 * 块级图片换成一行小字（不留裂图图标），行内图片由组件直接不渲染。 */
.pa-md__img-missing {
  display: inline-block;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.5;
}
.pa-md__caption {
  max-width: 100%;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--pa-text-3);
  text-align: center;
  overflow-wrap: anywhere;
}

/* ---------- 生图块（generate_image，复用 seeker 的 ImageGenerationCard） ----------
 * 为什么需要这一层定宽容器：dgi-stage 里的点阵格子写的是 width: min(100%, 360px)，
 * 百分比需要一个确定的包含块宽度。消息列是 align-items: flex-start 的 flex 列，
 * 直接放进去会收缩成 max-content，百分比退化成 auto，点阵尺寸不可控。 */
.pa-genimg {
  width: min(100%, 440px);
  min-width: 0;
  display: flex;
  flex-direction: column;
}
/* dgi-stage 自带 10px 上下外边距；消息列本来就有 7px gap，收紧一点别撑开空隙。 */
.pa-genimg .dgi-stage { margin: 2px 0; }

.pa-md--clamp {
  max-height: 180px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 34px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 34px), transparent);
}
.pa-foldbar {
  display: flex;
  justify-content: flex-start;
  margin-top: 6px;
  position: relative;
  z-index: 1;
}
.pa-foldbar__btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  color: var(--pa-text-3);
  padding: 2px 1px;
  transition: color 120ms ease;
}
.pa-foldbar__btn:hover { color: var(--pa-text); }
.pa-foldbar__btn svg { transition: transform 180ms ease; }
.pa-foldbar__btn[data-open='true'] svg { transform: rotate(180deg); }

/* ---------- typing ---------- */
.pa-typing {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 13px 16px;
  min-width: 58px;
}
.pa-typing i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pa-text-2);
  display: inline-block;
  animation: pa-typing 1.15s ease-in-out infinite;
}
.pa-typing i:nth-child(2) { animation-delay: 0.14s; }
.pa-typing i:nth-child(3) { animation-delay: 0.28s; }

/* ---------- 空态 ---------- */
.pa-chat-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px 28px 56px;
  text-align: center;
}
.pa-chat-empty__avatar { margin-bottom: 2px; }
.pa-chat-empty__title { font-size: calc(17px + var(--pa-font-delta)); font-weight: 600; line-height: calc(24px + var(--pa-font-delta)); color: var(--pa-text); }
.pa-chat-empty__desc {
  max-width: 400px;
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: 1.7;
  color: var(--pa-text-2);
}
.pa-chat-empty__chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }
.pa-chat-empty__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-2);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
  transition: background 130ms ease, color 130ms ease, border-color 130ms ease, transform 100ms ease;
}
.pa-chat-empty__chip:hover { background: var(--pa-card-2); color: var(--pa-text); border-color: var(--pa-line-2); }
.pa-chat-empty__chip:active { transform: scale(0.98); }
.pa-chat-empty__chip svg { color: var(--pa-text-3); }

/* ---------- 任务卡 ---------- */
.pa-task {
  width: min(100%, 520px);
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 12px;
  padding: 13px 14px;
  cursor: pointer;
  transition: background 130ms ease, border-color 130ms ease;
  user-select: none;
}
.pa-task:hover { background: var(--pa-card-2); border-color: var(--pa-line-2); }
.pa-task__head { display: flex; align-items: flex-start; gap: 10px; }
.pa-task__icon {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(48, 209, 88, 0.12);
  color: var(--pa-green);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  margin-top: 1px;
}
.pa-task[data-status='running'] .pa-task__icon { background: rgba(255, 159, 10, 0.12); color: var(--pa-accent); }
.pa-task[data-status='fail'] .pa-task__icon { background: rgba(255, 69, 58, 0.12); color: var(--pa-red); }
.pa-task__main { flex: 1; min-width: 0; }
.pa-task__title {
  font-size: calc(13px + var(--pa-font-delta));
  line-height: calc(19px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  overflow-wrap: anywhere;
}
.pa-task__status { font-size: calc(11px + var(--pa-font-delta)); line-height: calc(16px + var(--pa-font-delta)); color: var(--pa-text-3); margin-top: 2px; }
.pa-task__toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
  color: var(--pa-text-3);
  padding-top: 3px;
  white-space: nowrap;
}
.pa-task__toggle svg { transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-task[data-open='true'] .pa-task__toggle svg { transform: rotate(180deg); }
.pa-task__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pa-task[data-open='true'] .pa-task__body { grid-template-rows: 1fr; }
.pa-task__inner { overflow: hidden; min-height: 0; }
.pa-task__detail {
  margin: 10px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--pa-line);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.65;
  color: var(--pa-text-2);
}
.pa-task__steps { list-style: none; margin: 9px 0 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.pa-task__step { display: flex; align-items: flex-start; gap: 8px; font-size: calc(12px + var(--pa-font-delta)); line-height: calc(18px + var(--pa-font-delta)); color: var(--pa-text-2); }
.pa-task__step svg { flex: none; margin-top: 2px; color: var(--pa-text-4); }
.pa-task__ring {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.4px solid var(--pa-text-4);
  display: inline-block;
  flex: none;
  margin-top: 2px;
}
.pa-task__step[data-done='true'] { color: var(--pa-text-3); }
.pa-task__step[data-done='true'] svg { color: var(--pa-green); }

/* ---------- 可审计执行流水（1.4） ----------
 * 默认一行玻璃底胶囊：图标 + N 个动作 + 工具摘要 + 总耗时 + 展开。
 * 展开后是时间线，但**不套外框**：左侧一条发丝竖线 + 圆点，像一份操作日志，
 * 而不是又一张卡片 —— 流水是给复盘用的，不该比正文更抢眼。 */
.pa-trail { width: min(100%, 560px); }
.pa-trail__head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 9px;
  background: var(--pa-chat-glass);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: background 130ms ease, border-color 130ms ease;
}
.pa-trail__head:hover { background: var(--pa-chat-glass-2); border-color: var(--pa-line-2); }
.pa-trail__head:focus-visible { outline: 2px solid var(--pa-accent); outline-offset: 1px; }
.pa-trail[data-status='running'] .pa-trail__head { border-color: rgba(255, 159, 10, 0.22); }
.pa-trail[data-status='error'] .pa-trail__head { border-color: rgba(255, 69, 58, 0.26); }
.pa-trail__glyph { flex: none; display: inline-flex; align-items: center; color: var(--pa-text-3); }
.pa-trail[data-status='error'] .pa-trail__glyph { color: var(--pa-red); }
.pa-trail__spinner {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid var(--pa-line-2);
  border-top-color: var(--pa-accent);
  animation: pa-spin 760ms linear infinite;
}
.pa-trail__title { flex: none; font-weight: 500; color: var(--pa-text); }
.pa-trail__summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: calc(10.5px + var(--pa-font-delta));
}
.pa-trail__dur { flex: none; font-variant-numeric: tabular-nums; }
.pa-trail__toggle { flex: none; display: inline-flex; align-items: center; gap: 2px; color: var(--pa-text-3); }
.pa-trail__head:hover .pa-trail__toggle { color: var(--pa-text-2); }
.pa-trail__caret { transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-trail[data-open='true'] .pa-trail__caret { transform: rotate(180deg); }
.pa-trail__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pa-trail[data-open='true'] .pa-trail__body { grid-template-rows: 1fr; }
.pa-trail__inner { overflow: hidden; min-height: 0; }
.pa-trail__list {
  list-style: none;
  position: relative;
  margin: 0;
  padding: 5px 0 2px 14px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.pa-trail__list::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 10px;
  bottom: 10px;
  width: 1px;
  background: var(--pa-line-2);
}
.pa-trail__step {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-text-2);
}
.pa-trail__dot {
  position: absolute;
  left: -13px;
  top: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pa-text-4);
}
.pa-trail__step[data-status='running'] .pa-trail__dot { background: var(--pa-accent); }
.pa-trail__step[data-status='error'] .pa-trail__dot { background: var(--pa-red); }
.pa-trail__step[data-status='ok'] .pa-trail__dot { background: var(--pa-green); }
.pa-trail__time { flex: none; width: 34px; color: var(--pa-text-4); font-variant-numeric: tabular-nums; }
.pa-trail__step-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pa-trail__step-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.pa-trail__step-name { flex: none; color: var(--pa-text); }
.pa-trail__step-args {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-trail__step-dur { margin-left: auto; flex: none; color: var(--pa-text-4); font-variant-numeric: tabular-nums; }
.pa-trail__step-result {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-trail__step-result[data-tone='error'] { color: var(--pa-red); }
@media (prefers-reduced-motion: reduce) {
  .pa-trail__spinner { animation: none; }
  .pa-trail__caret { transition: none; }
}

/* ---------- 执行态卡（2.7 computer / browser） ----------
 * 比工具卡重一档：card 底 + 圆角，回答的是「Bot 此刻在替你做什么」。
 * 状态色只落在图标、状态文字与描边上，卡面保持中性 —— 执行中的卡会随截图刷新，
 * 整卡跟着变色会一直闪。 */
.pa-exec {
  width: min(100%, 520px);
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 12px;
  overflow: hidden;
}
.pa-exec[data-status='running'] { border-color: rgba(255, 159, 10, 0.28); }
.pa-exec[data-status='error'] { border-color: rgba(255, 69, 58, 0.3); }
.pa-exec__head { display: flex; align-items: center; gap: 9px; padding: 10px 12px; cursor: pointer; user-select: none; }
.pa-exec[data-expandable='false'] .pa-exec__head { cursor: default; }
.pa-exec__head:focus-visible { outline: 2px solid var(--pa-accent); outline-offset: -2px; }
.pa-exec__glyph {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text-2);
}
.pa-exec[data-status='running'] .pa-exec__glyph { color: var(--pa-accent); background: rgba(255, 159, 10, 0.12); }
.pa-exec[data-status='error'] .pa-exec__glyph { color: var(--pa-red); background: rgba(255, 69, 58, 0.12); }
.pa-exec__main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pa-exec__label {
  font-size: calc(13px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-exec__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-exec__tool { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
.pa-exec__state-text[data-state='running'] { color: var(--pa-accent); }
.pa-exec__state-text[data-state='error'] { color: var(--pa-red); }
.pa-exec__spinner {
  flex: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1.6px solid var(--pa-line-2);
  border-top-color: var(--pa-accent);
  animation: pa-spin 760ms linear infinite;
}
.pa-exec__icon { flex: none; display: inline-flex; }
.pa-exec__icon[data-state='ok'] { color: var(--pa-green); }
.pa-exec__icon[data-state='error'] { color: var(--pa-red); }
.pa-exec__caret { flex: none; color: var(--pa-text-4); transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-exec[data-open='true'] .pa-exec__caret { transform: rotate(180deg); }
.pa-exec__error {
  margin: 0 12px 10px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(255, 69, 58, 0.08);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.6;
  color: var(--pa-red);
  overflow-wrap: anywhere;
}
.pa-exec__media { padding: 0 12px 10px; }
.pa-exec__media a { display: block; }
.pa-exec__shot {
  display: block;
  width: 100%;
  max-height: 240px;
  object-fit: cover;
  border-radius: 8px;
  background: var(--pa-chat-glass-2);
}
.pa-exec__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pa-exec[data-open='true'] .pa-exec__body { grid-template-rows: 1fr; }
.pa-exec__inner { overflow: hidden; min-height: 0; }
.pa-exec__steps { list-style: none; margin: 0; padding: 0 12px 10px; display: flex; flex-direction: column; gap: 6px; }
.pa-exec__step {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: calc(11.5px + var(--pa-font-delta));
  line-height: calc(17px + var(--pa-font-delta));
  color: var(--pa-text-2);
}
.pa-exec__step-dot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--pa-text-4); transform: translateY(-2px); }
.pa-exec__step[data-status='running'] .pa-exec__step-dot { background: var(--pa-accent); }
.pa-exec__step[data-status='error'] .pa-exec__step-dot { background: var(--pa-red); }
.pa-exec__step[data-status='ok'] .pa-exec__step-dot { background: var(--pa-green); }
.pa-exec__step-time { flex: none; color: var(--pa-text-4); font-variant-numeric: tabular-nums; }
.pa-exec__step-label { min-width: 0; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) {
  .pa-exec__spinner { animation: none; }
  .pa-exec__caret { transition: none; }
}

/* ---------- 工具调用卡 ---------- */
/* 一次真实工具调用 = 一条执行步骤：玻璃底 + 发丝线，比正文气泡轻，
   不抢 bot 文本的注意力。默认一行（图标 + 工具名 + 参数摘要 + 状态），
   点击展开完整参数与结果（等宽、限高可滚）。 */
.pa-tool {
  width: fit-content;
  max-width: min(100%, 520px);
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--pa-chat-glass);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-2);
  cursor: pointer;
  user-select: none;
  transition: background 130ms ease, border-color 130ms ease;
}
.pa-tool:hover { background: var(--pa-chat-glass-2); border-color: var(--pa-line-2); }
.pa-tool[data-expandable='false'] { cursor: default; }
.pa-tool[data-open='true'] { width: min(100%, 560px); }
.pa-tool[data-status='running'] { border-color: rgba(255, 159, 10, 0.22); }
.pa-tool[data-status='error'] { border-color: rgba(255, 69, 58, 0.26); }
/* 连续几次工具调用收紧成一组「步骤」，别散成一堆独立卡片 */
.pa-tool + .pa-tool { margin-top: -2px; }
.pa-tool__head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.pa-tool__glyph { flex: none; display: inline-flex; color: var(--pa-text-3); }
.pa-tool[data-status='error'] .pa-tool__glyph { color: var(--pa-red); }
.pa-tool__name {
  flex: none;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--pa-text);
}
.pa-tool__args {
  flex: 0 1 auto;
  min-width: 0;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-tool__state {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-tool__state[data-state='error'] { color: var(--pa-red); }
.pa-tool__spinner {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid var(--pa-line-2);
  border-top-color: var(--pa-accent);
  display: inline-block;
  animation: pa-spin 760ms linear infinite;
}
.pa-tool__dur { font-variant-numeric: tabular-nums; }
.pa-tool[data-status='error'] .pa-tool__dur { color: var(--pa-red); opacity: 0.9; }
.pa-tool__caret { flex: none; color: var(--pa-text-4); transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-tool[data-open='true'] .pa-tool__caret { transform: rotate(180deg); }
.pa-tool__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pa-tool[data-open='true'] .pa-tool__body { grid-template-rows: 1fr; }
.pa-tool__inner { overflow: hidden; min-height: 0; }
.pa-tool__section { margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--pa-line); }
.pa-tool__label {
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pa-text-4);
  margin-bottom: 5px;
}
.pa-tool__code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.65;
  color: var(--pa-text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--pa-chat-glass-2);
}
.pa-tool__code[data-tone='error'] { background: rgba(255, 69, 58, 0.08); }
.pa-tool__running { margin-top: 8px; font-size: calc(10.5px + var(--pa-font-delta)); line-height: calc(15px + var(--pa-font-delta)); color: var(--pa-text-3); }

/* ---------- 期刊卡 ---------- */
.pa-journal {
  width: min(100%, 470px);
  display: flex;
  gap: 12px;
  align-items: stretch;
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 12px;
  padding: 10px;
  cursor: pointer;
  transition: background 130ms ease, border-color 130ms ease, transform 120ms ease;
}
.pa-journal:hover { background: var(--pa-card-2); border-color: var(--pa-line-2); }
.pa-journal:active { transform: scale(0.995); }
.pa-journal__cover {
  width: 108px;
  min-height: 72px;
  flex: none;
  border-radius: 8px;
  overflow: hidden;
  background: linear-gradient(135deg, #1b2433 0%, #2b1c17 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.55);
}
.pa-journal__cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pa-journal__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; padding: 2px 0; }
.pa-journal__kicker { font-size: calc(9.5px + var(--pa-font-delta)); line-height: calc(13px + var(--pa-font-delta)); letter-spacing: 0.08em; color: var(--pa-accent); text-transform: uppercase; }
.pa-journal__title { font-size: calc(13px + var(--pa-font-delta)); line-height: calc(18px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.pa-journal__date { font-size: calc(10px + var(--pa-font-delta)); line-height: calc(14px + var(--pa-font-delta)); color: var(--pa-text-3); }
.pa-journal__summary {
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text-2);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pa-journal__open {
  align-self: center;
  flex: none;
  padding: 6px 11px;
  border-radius: 8px;
  background: var(--pa-chat-glass-2);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-text);
  transition: background 120ms ease;
}
.pa-journal:hover .pa-journal__open { background: var(--pa-chat-hover-strong); }

/* ---------- 语音条 ---------- */
.pa-voice {
  width: min(100%, 430px);
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 14px;
  padding: 10px 12px;
}
.pa-voice__row { display: flex; align-items: center; gap: 10px; }
.pa-voice__play {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.pa-voice__play:hover { background: var(--pa-chat-hover-strong); }
.pa-voice__wave { flex: 1; display: flex; align-items: center; gap: 2px; height: 22px; min-width: 40px; color: var(--pa-text-2); }
.pa-voice__glyph { flex: none; color: var(--pa-text-3); margin-right: 3px; }
.pa-voice__wave i {
  flex: 1;
  max-width: 4px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.65;
  height: 30%;
}
.pa-voice__wave i:nth-child(3n) { height: 72%; }
.pa-voice__wave i:nth-child(3n + 1) { height: 48%; }
.pa-voice__wave i:nth-child(4n) { height: 92%; }
.pa-voice[data-playing='true'] .pa-voice__wave i { animation: pa-voice-bar 900ms ease-in-out infinite alternate; opacity: 1; }
.pa-voice__wave i:nth-child(2n) { animation-delay: 120ms; }
.pa-voice__wave i:nth-child(3n) { animation-delay: 240ms; }
.pa-voice__wave i:nth-child(5n) { animation-delay: 360ms; }
@keyframes pa-voice-bar {
  from { transform: scaleY(0.55); }
  to { transform: scaleY(1.15); }
}
.pa-voice__duration { flex: none; font-size: calc(11px + var(--pa-font-delta)); line-height: calc(16px + var(--pa-font-delta)); color: var(--pa-text-3); font-variant-numeric: tabular-nums; }
.pa-voice__text { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--pa-line); font-size: calc(12px + var(--pa-font-delta)); line-height: 1.6; color: var(--pa-text-2); }

/* ---------- 交互卡 ---------- */
.pa-int {
  width: min(100%, 490px);
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 14px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pa-int__title {
  font-size: calc(14px + var(--pa-font-delta));
  line-height: calc(20px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  letter-spacing: 0.01em;
}
.pa-int__prompt {
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.68;
  color: var(--pa-text-2);
  margin-top: -6px;
  /* prompt 里可能带换行（多问题提示、补充说明），保留它们 */
  white-space: pre-wrap;
}
.pa-int__options { display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }
/*
 * 选项 = 虚线圆角框，选中转实线描边 + 右侧实心勾（参考图形态）。
 *
 * 选择器带 .pa-root 是必须的：base.css 顶部的「.pa-root button」重置（0,1,1）会压过
 * 纯类选择器（0,1,0），只写 .pa-int__opt 的话内边距 / 圆角 / 边框全部失效。文件末尾
 * 原本就有一条 button.pa-int__opt 在替它补，两处数值早已各自漂移（这里写透明底、
 * 那边写玻璃底）—— 现在收拢到这一处，不再需要那份补丁。
 */
.pa-root .pa-int__opt {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 12px 14px;
  border-radius: 10px;
  /*
   * 虚线是「这里可以点」的唯一提示：卡片本身已经是一块底色，选项再铺一层就成了
   * 一串药丸。虚线只勾边界、不占视觉重量，选中时才把描边换成实线。
   */
  background: transparent;
  border: 1px dashed var(--pa-line-2);
  transition: background 120ms ease, border-color 120ms ease;
}
/* 只有未选中的项跟着鼠标走：选中项要守住自己的描边，不能被 hover 的灰实线盖掉。 */
.pa-root .pa-int__opt:not([data-selected='true']):hover {
  background: var(--pa-chat-hover);
  border-style: solid;
  border-color: var(--pa-line);
}
.pa-root .pa-int__opt[data-selected='true'] {
  border-style: solid;
  border-width: 1.5px;
  border-color: var(--pa-text);
  background: var(--pa-chat-glass);
  /* 描边从 1px 加粗到 1.5px，两边各多占 0.5px；用内边距补回来，选中时文字不位移 */
  padding: calc(12px - 0.5px) calc(14px - 0.5px);
}
.pa-root .pa-int__opt:disabled { cursor: default; opacity: 0.72; }
/*
 * 已提交后的清单（div 而不是 button，见 submittedRows）：不能再点，但**不能**整行
 * 压成 disabled 的 0.72——用户回看时要能一眼认出自己选的那个，所以选中项保持原样、
 * 只把没选的那些压暗。
 */
.pa-root .pa-int__opt[data-locked='true'] { cursor: default; }
.pa-root .pa-int__opt[data-locked='true']:not([data-selected='true']) { opacity: 0.5; }
.pa-root .pa-int__opt[data-locked='true']:not([data-selected='true']):hover {
  background: transparent;
  border-style: dashed;
  border-color: var(--pa-line-2);
}
/*
 * 右侧勾：实心圆 + 挖空的勾。圆取文字色、勾取卡片底色，深浅主题各自成立，
 * 不写死黑白。未选中时只降透明度、保留占位，否则选中那一刻选项文字会重新换行。
 */
.pa-int__tick {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--pa-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: scale(0.6);
  transition: opacity 120ms ease, transform 120ms ease;
}
.pa-int__tick::after {
  content: "";
  width: 4px;
  height: 7px;
  margin-top: -1px;
  border: solid var(--pa-card);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.pa-root .pa-int__opt[data-selected='true'] .pa-int__tick { opacity: 1; transform: scale(1); }
.pa-int__opt-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pa-int__opt-label { display: block; font-size: calc(12.5px + var(--pa-font-delta)); line-height: calc(18px + var(--pa-font-delta)); color: var(--pa-text); }
.pa-int__opt-desc { display: block; font-size: calc(11px + var(--pa-font-delta)); line-height: calc(16px + var(--pa-font-delta)); color: var(--pa-text-3); margin-top: 1px; }
.pa-int__buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.pa-int__button {
  padding: 8px 14px;
  border-radius: 9px;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: calc(17px + var(--pa-font-delta));
  transition: background 120ms ease, transform 100ms ease;
}
.pa-int__button:hover { background: var(--pa-chat-hover-strong); }
.pa-int__button:active { transform: scale(0.98); }
.pa-int__button[data-primary='true'] { background: #f2f3f5; color: #14161a; font-weight: 600; }
.pa-int__button[data-primary='true']:hover { background: #ffffff; }
.pa-int__button:disabled { opacity: 0.42; cursor: not-allowed; }
.pa-int__form { display: flex; flex-direction: column; gap: 10px; }
.pa-int__field { display: flex; flex-direction: column; gap: 5px; }
.pa-int__field-label { font-size: calc(11px + var(--pa-font-delta)); line-height: calc(15px + var(--pa-font-delta)); color: var(--pa-text-3); }
.pa-int__field-label em { font-style: normal; color: var(--pa-red); margin-left: 3px; }
.pa-int__input {
  width: 100%;
  border: 1px solid var(--pa-line-2);
  background: var(--pa-chat-glass);
  border-radius: 9px;
  padding: 8px 10px;
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--pa-text);
  outline: none;
  transition: border-color 120ms ease, background 120ms ease;
}
.pa-int__input:focus { border-color: rgba(255, 159, 10, 0.55); background: var(--pa-chat-glass-2); }
.pa-int__input::placeholder { color: var(--pa-text-4); }
.pa-int__input[aria-invalid='true'] { border-color: rgba(255, 69, 58, 0.6); }
select.pa-int__input { appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--pa-text-3) 50%), linear-gradient(135deg, var(--pa-text-3) 50%, transparent 50%); background-position: calc(100% - 15px) 50%, calc(100% - 10px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: 28px; }
.pa-int__check { display: flex; align-items: center; gap: 8px; font-size: calc(12px + var(--pa-font-delta)); line-height: calc(18px + var(--pa-font-delta)); color: var(--pa-text-2); cursor: pointer; }
.pa-int__check input { width: 15px; height: 15px; accent-color: var(--pa-accent); margin: 0; }
.pa-int__error { font-size: calc(10.5px + var(--pa-font-delta)); line-height: calc(15px + var(--pa-font-delta)); color: var(--pa-red); }
.pa-int__hint { font-size: calc(10.5px + var(--pa-font-delta)); line-height: calc(15px + var(--pa-font-delta)); color: var(--pa-text-3); }
.pa-int__foot { display: flex; align-items: center; gap: 10px; }
.pa-int__done {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 9px;
  background: rgba(48, 209, 88, 0.08);
  color: var(--pa-text-2);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.55;
}
.pa-int__done svg { flex: none; margin-top: 1px; color: var(--pa-green); }
.pa-int__done-label { font-size: calc(10.5px + var(--pa-font-delta)); line-height: calc(15px + var(--pa-font-delta)); color: var(--pa-green); }
.pa-int__done-text { color: var(--pa-text); overflow-wrap: anywhere; }
/*
 * 自定义输入的展开态：接替那个「其他（自己输入）」虚线框的位置，所以沿用同一套外框。
 * 输入框本身去边框 —— 框里再套一圈输入框描边就成了一页表单，而不是「就地补一句」。
 */
.pa-int__custom {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 14px;
  border: 1px dashed var(--pa-line-2);
  border-radius: 10px;
}
.pa-int__custom-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 0;
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
  color: var(--pa-text);
  outline: none;
}
.pa-int__custom-input::placeholder { color: var(--pa-text-4); }
.pa-int__custom .pa-int__button { flex: none; padding: 6px 12px; }

/* ---------- 输入区 ---------- */
.pa-composer { flex: none; padding: 6px 26px 18px; background: var(--pa-main); }
.pa-composer__chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 4px 8px; }
/* 引用提示条（2.3）：与待处理上浮条同一套玻璃底，说明「这条消息在回复谁」。 */
.pa-composer__reply {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 4px 6px;
  padding: 5px 10px;
  border-radius: 9px;
  background: var(--pa-chat-glass);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
}
.pa-composer__reply > svg { flex: none; }
.pa-composer__reply-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pa-text-2);
}
.pa-composer__reply button { flex: none; display: inline-flex; color: var(--pa-text-3); }
.pa-composer__reply button:hover { color: var(--pa-text); }
/* ---------- 语音输入条（录音时整块替换输入框） ---------- */
.pa-voicebar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 50px;
  padding: 6px 8px;
  border-radius: 24px;
  background: var(--pa-card-2);
  border: 1px solid var(--pa-line);
  animation: pa-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-voicebar__cancel,
.pa-voicebar__stop,
.pa-voicebar__send {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease, transform 120ms ease;
}
.pa-voicebar__cancel { background: var(--pa-chat-glass-2); color: var(--pa-text-2); }
.pa-voicebar__cancel:hover { background: var(--pa-chat-hover-strong); color: var(--pa-text); }
.pa-voicebar__cancel:active { transform: scale(0.94); }
.pa-voicebar__body { flex: 1; min-width: 0; display: flex; align-items: center; height: 36px; }
/* 实时波形：一排等宽竖条铺满整行，高度由麦克风音量驱动（scaleY，不触发布局） */
.pa-voicebar__wave { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 100%; }
.pa-voicebar__wave span {
  flex: 0 1 3px;
  min-width: 1px;
  height: 20px;
  border-radius: 2px;
  background: var(--pa-text-2);
  transform: scaleY(0.35);
  transform-origin: center;
  opacity: 0.6;
  will-change: transform, opacity;
}
.pa-voicebar__wave span:last-child { background: var(--pa-text); }
.pa-voicebar__status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--pa-text-2);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
}
.pa-voicebar__status-dots { display: inline-flex; align-items: center; gap: 3px; }
.pa-voicebar__status-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--pa-blue);
  animation: pa-voicebar-dot 1s ease-in-out infinite;
}
.pa-voicebar__status-dots i:nth-child(2) { animation-delay: 140ms; }
.pa-voicebar__status-dots i:nth-child(3) { animation-delay: 280ms; }
@keyframes pa-voicebar-dot {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}
.pa-voicebar__actions { display: flex; align-items: center; gap: 8px; flex: none; }
.pa-voicebar__stop { background: var(--pa-chat-glass-2); }
.pa-voicebar__stop:hover { background: var(--pa-chat-hover-strong); }
.pa-voicebar__stop:active { transform: scale(0.94); }
.pa-voicebar__stop > span { width: 11px; height: 11px; border-radius: 2.5px; background: var(--pa-text); }
.pa-voicebar__stop[data-hidden='true'] { visibility: hidden; }
.pa-voicebar__send { background: var(--pa-blue); color: #ffffff; }
.pa-voicebar__send:hover { background: #2a95ff; }
.pa-voicebar__send:active { transform: scale(0.94); }
.pa-voicebar__send:disabled { background: rgba(10, 132, 255, 0.26); color: rgba(255, 255, 255, 0.45); cursor: default; }

/* ---------- 消息里的用户图片 ---------- */
.pa-image {
  display: block;
  width: min(100%, 320px);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--pa-line);
  background: var(--pa-card);
  transition: border-color 120ms ease;
}
.pa-msg--user .pa-image { align-self: flex-end; }
.pa-image:hover { border-color: var(--pa-line-2); }
.pa-image img { display: block; width: 100%; height: auto; }

/* ---------- 输入框里的图片预览 ---------- */
.pa-composer__images { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 4px 8px; }
.pa-composer__image {
  position: relative;
  width: 62px;
  height: 62px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--pa-line);
  background: var(--pa-card-2);
}
.pa-composer__image img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pa-composer__image button {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.62);
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 120ms ease;
}
.pa-composer__image button:hover { background: rgba(0, 0, 0, 0.85); }
.pa-composer__uploading { font-size: calc(11px + var(--pa-font-delta)); color: var(--pa-text-3); }

.pa-composer__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 240px;
  padding: 3px 8px;
  border-radius: 7px;
  background: var(--pa-chat-glass);
  border: 1px solid var(--pa-line);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-text-2);
}
.pa-composer__chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-composer__chip button { display: inline-flex; color: var(--pa-text-3); flex: none; }
.pa-composer__chip button:hover { color: var(--pa-text); }
.pa-composer__chip--at { cursor: pointer; }
.pa-composer__chip--at:hover { background: var(--pa-chat-hover); color: var(--pa-text); }
.pa-composer__box {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  min-height: 50px;
  padding: 7px;
  border-radius: 24px;
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  position: relative;
  transition: border-color 130ms ease, box-shadow 130ms ease;
}
.pa-composer__box:focus-within { border-color: var(--pa-line-2); box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.035); }
.pa-composer__plus {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  transition: background 120ms ease, color 120ms ease;
}
.pa-composer__plus:hover { background: var(--pa-chat-hover-strong); color: var(--pa-text); }
.pa-composer__textarea {
  flex: 1;
  min-width: 0;
  min-height: 36px;
  /*
   * 多行输入随内容拉长：上限跟 Work 模式对话框同源（DSH 在
   * .wSkVaW_composerSeat 上定义 --dsh-composer-text-max-height: 336px）。
   * 以前写死 140px，输入到五行就不再变高，长消息只能在小框里滚。
   * 这里保留 fallback 336px：Bot 模式是独立全屏层，不保证挂在 Work 的
   * composerSeat 里，变量缺失时也要和 Work 一样高。
   */
  max-height: var(--dsh-composer-text-max-height, 336px);
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--pa-text);
  font-size: calc(13px + var(--pa-font-delta));
  line-height: calc(21px + var(--pa-font-delta));
  padding: 7px 2px;
  overflow-y: auto;
  /* 换行原样保留（textarea 默认 pre-wrap，显式写出来防止继承样式意外覆盖） */
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.pa-composer__textarea::placeholder { color: var(--pa-text-3); }
.pa-composer__tools { display: flex; align-items: center; gap: 2px; flex: none; padding-bottom: 1px; }
.pa-composer__voice {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #f2f3f5;
  color: #17181a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  transition: background 120ms ease, transform 120ms ease, opacity 120ms ease;
  animation: pa-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-composer__voice:hover { background: #ffffff; }
.pa-composer__voice:active { transform: scale(0.94); }
.pa-composer__send {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #f2f3f5;
  color: #17181a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  transition: background 120ms ease, transform 120ms ease, opacity 120ms ease;
  animation: pa-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-composer__send:hover { background: #ffffff; }
.pa-composer__send:active { transform: scale(0.94); }
.pa-composer__send[data-on='false'] { background: var(--pa-chat-glass-2); color: var(--pa-text-3); }
.pa-composer__send[data-on='false']:hover { background: var(--pa-chat-hover-strong); color: var(--pa-text-2); }
/*
 * 停止键：本轮回复进行中替换发送键。
 *
 * 与发送键同尺寸、同圆角、同位置——换键时按钮不跳，用户不必重新瞄准。实心方块
 * 加红底表示「这一下会中断」，颜色走 --pa-red（深浅主题共用），浅色主题另有
 * 覆盖（见文件末的 button 重置区）。
 */
.pa-composer__stop {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--pa-red) 16%, transparent);
  color: var(--pa-red);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  transition: background 120ms ease, transform 120ms ease, opacity 120ms ease;
  animation: pa-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-composer__stop:hover { background: color-mix(in srgb, var(--pa-red) 26%, transparent); }
.pa-composer__stop:active { transform: scale(0.94); }

/* @ 提及菜单 */
.pa-composer__mention {
  position: absolute;
  left: 44px;
  bottom: calc(100% + 8px);
  width: 232px;
  max-height: 248px;
  overflow-y: auto;
  padding: 6px;
  border-radius: 12px;
  background: #232427;
  border: 1px solid var(--pa-line-2);
  box-shadow: var(--pa-shadow-pop);
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 2px;
  animation: pa-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-root[data-pa-theme='light'] .pa-composer__mention { background: #ffffff; }
.pa-composer__mention button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 8px;
  text-align: left;
  transition: background 110ms ease;
}
.pa-composer__mention button:hover { background: var(--pa-chat-hover); }
.pa-composer__mention-name { font-size: calc(12.5px + var(--pa-font-delta)); line-height: calc(17px + var(--pa-font-delta)); color: var(--pa-text); }
.pa-composer__mention-role { font-size: calc(10px + var(--pa-font-delta)); line-height: calc(14px + var(--pa-font-delta)); color: var(--pa-text-3); }

/* ───────────────────────── 小浮层退场（closing 态） ───────────────────────── */
/*
 * 「更多」菜单与 @ 提及气泡：关闭时先播 240ms 退场再卸载。
 * 两者入场都是 pa-pop（translateY(8px) scale(.975)），退场按 popover 规格
 * 向右 10px + 轻微缩小，形成「弹入 → 滑出」的方向差。
 * 时长与曲线跟 src/client/modal-animation.ts 的 MODAL_ANIM_MS 对齐；
 * [data-closing] 选择器比入场规则更具体，退场时不会两套动画同时跑。
 */
@keyframes pa-chat-menu-out {
  from { opacity: 1; transform: translateX(0) scale(1); }
  to { opacity: 0; transform: translateX(10px) scale(0.97); }
}
@keyframes pa-mention-out {
  from { opacity: 1; transform: translateX(0) scale(1); }
  to { opacity: 0; transform: translateX(10px) scale(0.97); }
}
.pa-chat__menu[data-closing='1'] { animation: pa-chat-menu-out 240ms cubic-bezier(0.4, 0, 0.2, 1) both; }
.pa-composer__mention[data-closing='1'] { animation: pa-mention-out 240ms cubic-bezier(0.4, 0, 0.2, 1) both; }

@media (prefers-reduced-motion: reduce) {
  .pa-chat__menu[data-closing='1'],
  .pa-composer__mention[data-closing='1'] { animation: none; }
}

/* 文件输入隐藏 */
.pa-composer__file { display: none; }

/* base.css 的 .pa-root button 重置（0,1,1）会压过纯类选择器（0,1,0）。
   这里用 button.class（同为 0,1,1，靠后生效）把按钮外观补回来。 */
button.pa-chat__head-btn { color: var(--pa-text-2); background: transparent; }
button.pa-chat-empty__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-2);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
}
/* .pa-int__opt 不在这张补丁表里：它已改用「.pa-root .pa-int__opt」（0,2,0）直接压过
   重置，见「交互卡」段。原先这里那条 button.pa-int__opt 与那边数值不同（9px/玻璃底
   vs 10px/透明底），实际渲染的是这里——同一份样式两份定义，改一处永远改不干净。 */
button.pa-int__button {
  padding: 8px 14px;
  border-radius: 9px;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: calc(17px + var(--pa-font-delta));
}
button.pa-int__button[data-primary='true'] { background: var(--pa-text); color: var(--pa-main); font-weight: 600; }
button.pa-journal__open {
  padding: 6px 11px;
  border-radius: 8px;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
}
button.pa-foldbar__btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 1px;
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
}
/* 产出物卡上的「预览 / 下载」：一个是 button、一个是 a，都要写 button.class /
 * a.class（0,1,1）—— base.css 的 .pa-root button 重置会压过纯类选择器（0,1,0），
 * 只写 .pa-media__btn 的话按钮会变成一行没有底色的文字。 */
button.pa-media__btn, a.pa-media__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 9px;
  border-radius: 7px;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text-2);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  text-decoration: none;
  white-space: nowrap;
  transition: background 120ms ease, color 120ms ease;
}
button.pa-media__btn:hover, a.pa-media__btn:hover { background: var(--pa-chat-hover-strong); color: var(--pa-text); }
button.pa-voice__play {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button.pa-composer__chip,
button.pa-composer__chip--at {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 240px;
  padding: 3px 8px;
  border-radius: 7px;
  background: var(--pa-chat-glass);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-2);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
}
button.pa-composer__plus {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button.pa-composer__voice {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #f2f3f5;
  color: #17181a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button.pa-composer__send {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #f2f3f5;
  color: #17181a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button.pa-composer__stop {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--pa-red) 16%, transparent);
  color: var(--pa-red);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button.pa-composer__send[data-on='false'] { background: var(--pa-chat-glass-2); color: var(--pa-text-3); }
.pa-root[data-pa-theme='light'] button.pa-composer__voice,
.pa-root[data-pa-theme='light'] button.pa-composer__send[data-on='true'] { background: #17181a; color: #f7f8fa; }
.pa-root[data-pa-theme='light'] button.pa-composer__voice:hover,
.pa-root[data-pa-theme='light'] button.pa-composer__send[data-on='true']:hover { background: #000000; }
/* 浅色主题：--pa-red 在浅底上偏亮，压深一档并把底色换成淡红，保证对比度。 */
.pa-root[data-pa-theme='light'] button.pa-composer__stop { background: #fff1f0; color: #d92d20; }
.pa-root[data-pa-theme='light'] button.pa-composer__stop:hover { background: #ffe4e1; }

/* ---------- Seeker 生图卡在 personal 全屏应用里的两处覆盖 ---------- */

/* 1) lightbox 遮罩的层级。
 * dgi 样式表给的是 z-index: 1200（宿主会话级遮罩的取值），而 .pa-root 自己是
 * z-index: 2147483000 的定位元素、遮罩又经 createPortal 挂到 body 上 —— 不抬高
 * 就会被整个 personal 应用盖住，点开大图什么都看不到。
 * 必须 !important：dgi 那张表在组件挂载时才注入，晚于本表，同特异性会输。 */
.dgi__backdrop { z-index: 2147483001 !important; }

/* 2) 保存按钮的外观。
 * base.css 的 .pa-root button 重置（0,1,1）压过 dgi 的 .dgi__save-button
 * （0,1,0），背景 / 边框 / 内边距全被抹掉，只剩一行白字。这里写成
 * button.class（同为 0,1,1），既压过 base.css 的重置（本表后注入），
 * 也压过 dgi 自己的 (0,1,0) 规则（特异性更高），把胶囊外观补回来。 */
button.dgi__save-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: rgba(20, 24, 32, 0.92);
  color: rgba(255, 255, 255, 0.92);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
}
button.dgi__save-button:hover { background: rgba(32, 38, 50, 0.88); border-color: rgba(255, 255, 255, 0.32); }
button.dgi__save-button:disabled { opacity: 0.6; cursor: default; }

/* ---------- 产出物卡（正文里的文件路径 / 下载链接） ----------
 * 与 .pa-genimg 同宽节奏（min(100%, 440px)）：同一条消息里生图卡、视频卡、
 * 产出物卡左右边界对齐，不会一段宽一段窄。卡片本身比正文气泡轻一档：
 * 发丝边框 + 卡片底，不抢文字注意力。 */
.pa-media-group {
  width: min(100%, 440px);
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0;
}
.pa-media {
  width: 100%;
  min-width: 0;
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 12px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  transition: border-color 130ms ease, background 130ms ease;
}
.pa-media:hover { border-color: var(--pa-line-2); }
.pa-media__head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pa-media__icon {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text-2);
}
.pa-media[data-kind='video'] .pa-media__icon { background: rgba(10, 132, 255, 0.12); color: var(--pa-blue); }
.pa-media[data-kind='audio'] .pa-media__icon { background: rgba(48, 209, 88, 0.12); color: var(--pa-green); }
.pa-media[data-kind='pdf'] .pa-media__icon { background: rgba(255, 69, 58, 0.12); color: var(--pa-red); }
.pa-media[data-kind='sheet'] .pa-media__icon { background: rgba(48, 209, 88, 0.12); color: var(--pa-green); }
.pa-media[data-kind='slide'] .pa-media__icon { background: rgba(255, 159, 10, 0.12); color: var(--pa-accent); }
/* 页面（3.1 Pages）：与「网页」分类同一枚蓝色，和 PDF 的红色区分开 */
.pa-media[data-kind='page'] .pa-media__icon { background: rgba(10, 132, 255, 0.12); color: var(--pa-blue); }
.pa-media__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pa-media__name {
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-media__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-media__label {
  flex: none;
  max-width: 55%;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-media__kind { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 旧页面提示（3.1）：同一页面已有更新版本。蓝色小字、虚线底线，点开最新版。 */
.pa-media__stale {
  flex: none;
  color: var(--pa-blue);
  font-size: calc(10px + var(--pa-font-delta));
  text-decoration: none;
  border-bottom: 1px dashed color-mix(in srgb, var(--pa-blue) 55%, transparent);
  white-space: nowrap;
}
.pa-media__stale:hover { border-bottom-style: solid; }
.pa-media__actions { flex: none; display: flex; align-items: center; gap: 6px; }
.pa-media__caret { transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-media[data-open='true'] .pa-media__caret { transform: rotate(180deg); }
.pa-media__preview {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--pa-line);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
/* iframe：PDF 查看器 / Office 转出的 PDF。高度固定 360px —— 让浏览器自带查看器
 * 有足够的高度放下工具栏与一页正文；白底是 PDF 纸面，深色主题下仍保持白，
 * 只把边框与外壳压暗（灰底会让 PDF 页看起来像加载失败）。 */
.pa-media__frame {
  width: 100%;
  height: 360px;
  border: 0;
  border-radius: 8px;
  background: #ffffff;
  display: block;
}
.pa-root[data-pa-theme='dark'] .pa-media__frame { box-shadow: 0 0 0 1px var(--pa-line-2); }
.pa-media__video {
  display: block;
  width: 100%;
  max-width: 420px;
  max-height: 420px;
  border-radius: 12px;
  background: #000000;
}
.pa-media__audio { display: block; width: 100%; max-width: 420px; }
.pa-media__image { display: block; max-width: 100%; height: auto; border-radius: 10px; background: var(--pa-chat-glass-2); }
/* Office 首页页图：宽度上限 320px（比卡片窄一档，视觉上明确是「缩略图」）。 */
.pa-media__thumb {
  display: block;
  width: 100%;
  max-width: 320px;
  height: auto;
  border-radius: 8px;
  border: 1px solid var(--pa-line);
  background: #ffffff;
}
.pa-media__thumb-missing {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 14px;
  border-radius: 8px;
  border: 1px dashed var(--pa-line-2);
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
}
.pa-media__thumb-missing svg { flex: none; }

/*
 * 常显缩略图 + 点击全屏预览。
 *
 * 文件生成完就该「一眼看见它长什么样」，而不是先点「预览」再等一张图。
 * 缩略图本身是个按钮：外层去掉所有默认按钮外观，悬浮时才浮出「点击查看」。
 */
.pa-media__thumbwrap {
  position: relative;
  display: block;
  margin-top: 10px;
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
  text-align: left;
  max-width: 320px;
}
.pa-media__thumbwrap .pa-media__thumb { max-width: 100%; transition: filter 140ms ease; }
.pa-media__thumbwrap:hover .pa-media__thumb { filter: brightness(0.94); }
.pa-media__thumbwrap:focus-visible { outline: 2px solid var(--pa-accent); outline-offset: 2px; border-radius: 8px; }
.pa-media__thumbhint {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: calc(10px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  color: #fff;
  background: rgba(0, 0, 0, 0.52);
  backdrop-filter: blur(4px);
  opacity: 0;
  transition: opacity 140ms ease;
  pointer-events: none;
}
.pa-media__thumbwrap:hover .pa-media__thumbhint,
.pa-media__thumbwrap:focus-visible .pa-media__thumbhint { opacity: 1; }

/* 全屏预览层：盖住整个 Bot 应用，点遮罩关闭 */
.pa-media__lightbox {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(3px);
  animation: pa-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-media__lightbox-inner {
  display: flex;
  flex-direction: column;
  width: min(100%, 960px);
  max-height: 100%;
  border-radius: 14px;
  background: var(--pa-card);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--pa-line-2);
  overflow: hidden;
  cursor: default;
}
.pa-media__lightbox-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--pa-line);
  flex: none;
}
.pa-media__lightbox-title {
  flex: 1;
  min-width: 0;
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-media__lightbox-body {
  flex: 1;
  min-height: 0;
  padding: 12px;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pa-media__lightbox-body .pa-media__frame { height: min(70vh, 640px); }
.pa-media__frame--full { height: min(70vh, 640px); }
.pa-media__lightbox-body .pa-media__image { max-height: 70vh; width: auto; }
.pa-media__lightbox-body .pa-media__video { max-width: 100%; }

/*
 * 灯箱退场：遮罩淡出 + 面板下沉 14px 并轻微缩小。
 *
 * 入场是 160ms 弹入，出场原来是硬消失（组件里 lightbox 一置 false 就被摘掉）。
 * 时长与曲线对齐 modal-animation.ts 的 MODAL_ANIM_MS：240ms，出场用加速曲线
 * （从静止启动、峰值速度结束），与插件其它浮层同一套手感。
 *
 * 只在根节点挂一个 data-closing，面板用后代选择器跟随——组件侧只改一处属性，
 * 不会出现「遮罩淡出了、面板还在」的错位。
 */
@keyframes pa-media-lightbox-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes pa-media-lightbox-out {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(14px) scale(0.97); }
}
.pa-media__lightbox[data-closing='1'] {
  animation: pa-media-lightbox-fade-out 240ms ease both;
}
.pa-media__lightbox[data-closing='1'] .pa-media__lightbox-inner {
  animation: pa-media-lightbox-out 240ms cubic-bezier(0.4, 0, 0.2, 1) both;
}
/*
 * 减少动效：入场与退场一起关掉。
 *
 * 退场选择器必须原样再列一遍（带上 [data-closing='1']）——媒体查询不增加权重，
 * 只写 .pa-media__lightbox 压不过上面那条带属性的规则，退场动画会照播。
 */
@media (prefers-reduced-motion: reduce) {
  .pa-media__lightbox,
  .pa-media__lightbox[data-closing='1'],
  .pa-media__lightbox[data-closing='1'] .pa-media__lightbox-inner {
    animation: none;
  }
}

/* 「正在生成文档」占位复用生图卡的 dgi-stage 样式（见 src/client/styles.ts），
   这里不再单独定义——两套样式迟早会走样，用户要求所有生成过程长得一样。 */

/* ---------- 视频生成卡（generate_video） ---------- */
.pa-video-gen {
  width: min(100%, 440px);
  min-width: 0;
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.pa-video-gen[data-status='running'] { border-color: rgba(255, 159, 10, 0.22); }
.pa-video-gen[data-status='error'] { border-color: rgba(255, 69, 58, 0.26); }
.pa-video-gen__head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pa-video-gen__badge {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text-2);
}
.pa-video-gen[data-status='running'] .pa-video-gen__badge { color: var(--pa-accent); background: rgba(255, 159, 10, 0.12); }
.pa-video-gen[data-status='error'] .pa-video-gen__badge { color: var(--pa-red); background: rgba(255, 69, 58, 0.12); }
.pa-video-gen__title {
  font-size: calc(13px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-video-gen__timer {
  margin-left: auto;
  flex: none;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-text-3);
  font-variant-numeric: tabular-nums;
}
.pa-video-gen__prompt {
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-text-2);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}
.pa-video-gen__stage { display: flex; align-items: center; justify-content: center; padding: 4px 0 2px; }
/* 点阵：11×11 格子，径向延迟的呼吸波（延迟由组件按格子到中心的距离算）。
 * aspect-ratio 让方阵在任何宽度下都保持正方形，格子用百分比宽度自适应。 */
.pa-video-gen__dots {
  display: grid;
  grid-template-columns: repeat(11, 1fr);
  gap: 6px;
  width: min(100%, 176px);
  aspect-ratio: 1;
}
.pa-video-gen__dots i {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--pa-text-2);
  opacity: 0.28;
  animation: pa-video-dot 1.6s ease-in-out infinite;
}
@keyframes pa-video-dot {
  0%, 100% { opacity: 0.14; transform: scale(0.72); }
  50% { opacity: 0.82; transform: scale(1); }
}
.pa-video-gen__error {
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.55;
  color: var(--pa-red);
  overflow-wrap: anywhere;
}
.pa-video-gen__task {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--pa-chat-glass);
}
.pa-video-gen__task-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: calc(11.5px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
}
.pa-video-gen__task-key { flex: none; color: var(--pa-text-3); }
.pa-video-gen__task-val {
  min-width: 0;
  color: var(--pa-text-2);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  overflow-wrap: anywhere;
}
.pa-video-gen__task-hint {
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-video-gen__videos { display: flex; flex-direction: column; gap: 8px; min-width: 0; }

/* ---------- 待处理上浮条（2.6） ----------
 * 输入框上方常驻一行：玻璃底 + 发丝线，比气泡轻、比系统提示重。
 * 左右边距跟 .pa-composer 的 padding 对齐（含两档窄屏），视觉上属于输入区，
 * 不是又一条消息。 */
.pa-pending {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 26px 8px;
  padding: 7px 12px;
  border-radius: 10px;
  background: var(--pa-chat-glass);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-2);
  font-size: calc(11.5px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  text-align: left;
  cursor: pointer;
  transition: background 130ms ease, border-color 130ms ease;
}
.pa-pending:hover { background: var(--pa-chat-glass-2); border-color: var(--pa-line-2); }
.pa-pending:focus-visible { outline: 2px solid var(--pa-accent); outline-offset: 1px; }
.pa-pending__dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--pa-blue); }
.pa-pending[data-kind='approval'] .pa-pending__dot { background: var(--pa-red); }
.pa-pending__label { flex: none; font-weight: 500; color: var(--pa-blue); }
.pa-pending[data-kind='approval'] .pa-pending__label { color: var(--pa-red); }
.pa-pending__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pa-text);
}
.pa-pending__count { flex: none; color: var(--pa-text-3); font-variant-numeric: tabular-nums; }
.pa-pending__jump { flex: none; display: inline-flex; align-items: center; gap: 1px; color: var(--pa-text-3); }
.pa-pending:hover .pa-pending__jump { color: var(--pa-text); }
/* 从上浮条跳到原消息时闪一下描边，否则用户只看到消息流动了一下、不知道落在哪。
 * 加在外层消息容器上（MessageList 的 id 节点），描边画在内层内容块上。 */
.pa-flash .pa-msg__content { animation: pa-flash-ring 1.6s ease-out; }
@keyframes pa-flash-ring {
  0% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--pa-accent) 60%, transparent); border-radius: 12px; }
  100% { box-shadow: 0 0 0 2px transparent; border-radius: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .pa-flash .pa-msg__content { animation: none; }
}

@media (max-width: 1100px) {
  .pa-chat__scroll { padding: 18px 20px 24px; }
  .pa-composer { padding: 6px 18px 16px; }
  .pa-pending { margin-left: 18px; margin-right: 18px; }
  .pa-msg--bot { padding-right: 6%; }
  .pa-msg--user { padding-left: 10%; }
}
@media (max-width: 760px) {
  .pa-chat__scroll { padding: 14px 14px 20px; }
  .pa-composer { padding: 6px 12px 14px; }
  .pa-pending { margin-left: 12px; margin-right: 12px; }
  .pa-msg--bot { padding-right: 0; }
  .pa-msg--user { padding-left: 0; }
  .pa-msg__content { max-width: calc(100% - 42px); }
  /* 窄屏用户消息左边没有留白可放操作条：改放气泡上方右侧，
     既不会被滚动容器的 overflow-x 裁掉，也不会把气泡挤窄。 */
  .pa-msg__hoverbar {
    right: 0;
    top: auto;
    bottom: calc(100% + 2px);
    transform: none;
    flex-direction: row;
  }
}
`

let injected = false

/** 幂等注入聊天区样式；返回本次是否真正插入。 */
export function injectChatStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-chat-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-chat-styles'
  style.textContent = PERSONAL_CHAT_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function chatStylesInjected(): boolean {
  return injected
}
