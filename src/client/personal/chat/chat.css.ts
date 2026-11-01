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
}
.pa-root[data-pa-theme='light'] {
  --pa-chat-hover: rgba(15, 17, 21, 0.05);
  --pa-chat-hover-strong: rgba(15, 17, 21, 0.09);
  --pa-chat-glass: rgba(15, 17, 21, 0.035);
  --pa-chat-glass-2: rgba(15, 17, 21, 0.06);
  --pa-chat-sender: #5d6269;
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
  height: 100%;
}

/* ---------- 会话头 ----------
 * 高度与 Work 模式的官方会话标题栏（.wSkVaW_header，44px）一致：两个模式
 * 切换时消息流的第一行不会上下跳。左内边距也对齐官方那 20px。 */
.pa-chat__header {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 28px 0 20px;
  border-bottom: 1px solid var(--pa-line);
  background: var(--pa-main);
  position: relative;
  z-index: 12;
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
  animation: pa-pop 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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

/* ---------- 消息行 ---------- */
.pa-msg {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 100%;
  animation: pa-rise 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
}
.pa-msg--user .pa-msg__content { flex: 0 1 auto; width: auto; align-items: flex-end; max-width: 88%; }
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
.pa-msg--system {
  justify-content: center;
  padding: 0;
  animation: pa-rise 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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

/* ---------- 撤回入口（只挂用户消息） ----------
 * hover / 键盘聚焦时在气泡外侧浮现一枚小胶囊；点开是自绘确认卡（见 MessageList）。
 *
 * 为什么绝对定位：这枚按钮常驻 DOM，若参与布局，每条用户消息都会因为它常年内缩
 * 一截（用户消息右对齐，气泡左边那点空隙就是它的位置）。绝对定位挂在
 * .pa-msg__content 上、右侧贴住气泡左沿，不改变任何气泡宽度。
 *
 * 可见性挂在**整行** .pa-msg--user 的 hover 上，而不是气泡上：气泡与按钮之间隔着
 * 8px 空隙，挂在气泡上会让鼠标横跨那 8px 时按钮先消失（悬停断链），点不中。
 *
 * 触屏没有 hover：常显半透明（否则根本没有入口），focus-within 仍能把它提亮。 */
.pa-msg--user .pa-msg__content { position: relative; }
button.pa-msg__recall {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--pa-chat-glass-2);
  border: 1px solid var(--pa-line);
  color: var(--pa-text-3);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease, border-color 120ms ease;
}
button.pa-msg__recall svg { flex: none; }
.pa-msg--user:hover button.pa-msg__recall,
.pa-msg--user:focus-within button.pa-msg__recall { opacity: 1; pointer-events: auto; }
button.pa-msg__recall:hover {
  background: var(--pa-chat-hover-strong);
  border-color: var(--pa-line-2);
  color: var(--pa-text);
}
button.pa-msg__recall:active { transform: translateY(-50%) scale(0.96); }
@media (hover: none) {
  button.pa-msg__recall { opacity: 0.62; pointer-events: auto; }
}

/* ---------- 气泡 ---------- */
.pa-bubble {
  max-width: 100%;
  width: fit-content;
  border-radius: 16px;
  padding: 12px 14px;
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.68;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
.pa-bubble--bot {
  background: var(--pa-card);
  color: var(--pa-text);
  border: 1px solid var(--pa-line);
  padding: 14px 16px;
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  border-bottom-left-radius: 6px;
  border-bottom-right-radius: 16px;
}
.pa-bubble--user {
  background: var(--pa-card-3);
  color: var(--pa-text);
  border-radius: 18px 18px 6px 18px;
  padding: 10px 14px;
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.62;
}
.pa-msg--user .pa-bubble { background: var(--pa-card-3); }
.pa-bubble--plain { background: transparent; border: 0; padding: 0; }

.pa-md { color: var(--pa-text); font-size: calc(13px + var(--pa-font-delta)); line-height: 1.7; overflow-wrap: anywhere; }
.pa-md > *:first-child { margin-top: 0; }
.pa-md > *:last-child { margin-bottom: 0; }
.pa-md p { margin: 0 0 8px; }
.pa-md p:last-child { margin-bottom: 0; }
.pa-md strong { font-weight: 600; color: var(--pa-text); }
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
  border-radius: 12px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pa-int__title { font-size: calc(13px + var(--pa-font-delta)); line-height: calc(19px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); }
.pa-int__prompt { font-size: calc(12px + var(--pa-font-delta)); line-height: 1.6; color: var(--pa-text-2); margin-top: -4px; }
.pa-int__options { display: flex; flex-direction: column; gap: 6px; }
.pa-int__opt {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  border-radius: 9px;
  background: var(--pa-chat-glass);
  border: 1px solid transparent;
  transition: background 120ms ease, border-color 120ms ease;
}
button.pa-int__opt:hover { background: var(--pa-chat-hover); }
.pa-int__opt[data-selected='true'] { border-color: rgba(255, 159, 10, 0.55); background: rgba(255, 159, 10, 0.08); }
.pa-int__opt:disabled { cursor: default; opacity: 0.72; }
.pa-int__radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1.5px solid var(--pa-text-4);
  margin-top: 1px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: border-color 120ms ease;
}
.pa-int__radio::after {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pa-accent);
  transform: scale(0);
  transition: transform 120ms ease;
}
.pa-int__opt[data-selected='true'] .pa-int__radio { border-color: var(--pa-accent); }
.pa-int__opt[data-selected='true'] .pa-int__radio::after { transform: scale(1); }
.pa-int__opt[data-multi='true'] .pa-int__radio { border-radius: 5px; }
.pa-int__opt[data-multi='true'] .pa-int__radio::after { border-radius: 3px; }
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
.pa-int__custom { display: flex; gap: 7px; align-items: center; }
.pa-int__custom .pa-int__input { flex: 1; }

/* ---------- 输入区 ---------- */
.pa-composer { flex: none; padding: 6px 26px 18px; background: var(--pa-main); }
.pa-composer__chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 4px 8px; }
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
  animation: pa-pop 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
  max-height: 140px;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--pa-text);
  font-size: calc(13px + var(--pa-font-delta));
  line-height: calc(21px + var(--pa-font-delta));
  padding: 7px 2px;
  overflow-y: auto;
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
  animation: pa-pop 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
  animation: pa-pop 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-composer__send:hover { background: #ffffff; }
.pa-composer__send:active { transform: scale(0.94); }
.pa-composer__send[data-on='false'] { background: var(--pa-chat-glass-2); color: var(--pa-text-3); }
.pa-composer__send[data-on='false']:hover { background: var(--pa-chat-hover-strong); color: var(--pa-text-2); }

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
  animation: pa-pop 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
button.pa-int__opt {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  border-radius: 9px;
  background: var(--pa-chat-glass);
  border: 1px solid transparent;
}
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
button.pa-composer__send[data-on='false'] { background: var(--pa-chat-glass-2); color: var(--pa-text-3); }
.pa-root[data-pa-theme='light'] button.pa-composer__voice,
.pa-root[data-pa-theme='light'] button.pa-composer__send[data-on='true'] { background: #17181a; color: #f7f8fa; }
.pa-root[data-pa-theme='light'] button.pa-composer__voice:hover,
.pa-root[data-pa-theme='light'] button.pa-composer__send[data-on='true']:hover { background: #000000; }

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

@media (max-width: 1100px) {
  .pa-chat__scroll { padding: 18px 20px 24px; }
  .pa-composer { padding: 6px 18px 16px; }
  .pa-msg--bot { padding-right: 6%; }
  .pa-msg--user { padding-left: 10%; }
}
@media (max-width: 760px) {
  .pa-chat__scroll { padding: 14px 14px 20px; }
  .pa-composer { padding: 6px 12px 14px; }
  .pa-msg--bot { padding-right: 0; }
  .pa-msg--user { padding-left: 0; }
  .pa-msg__content { max-width: calc(100% - 42px); }
  /* 窄屏用户消息左边没有留白可放撤回按钮：改放气泡上方右侧，
     既不会被滚动容器的 overflow-x 裁掉，也不会把气泡挤窄。 */
  button.pa-msg__recall {
    right: 0;
    top: auto;
    bottom: calc(100% + 2px);
    transform: none;
  }
  button.pa-msg__recall:active { transform: scale(0.96); }
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
