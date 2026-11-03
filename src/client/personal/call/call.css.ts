/**
 * Personal Agent — 通话弹层与通话消息卡样式。
 *
 * 弹层与消息卡都**跟随 DSH 主题**：色板全部从 base.css 的 --pa-* 主题变量派生，
 * 深浅两套主题各自可读。改造前这里是一块固定深色渐变（文件头原本写着「不随亮色
 * 主题反色」），在浅色界面里非常突兀——已废弃。
 *
 * 约定：新增颜色一律走 var(--pa-*) 或下面 .pa-call 上的局部变量，不要再写死色值；
 * 只有「语义色」（在听绿 / 在想蓝 / 在说橙 / 出错红）保留高饱和度的 rgba 底色，
 * 文字色用 --pa-call-*-fg（深色亮化、浅色压深）。
 */

export const PERSONAL_CALL_CSS = `
/* ---------- 全屏通话遮罩 ---------- */
.pa-call-overlay {
  position: absolute;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(4, 5, 7, 0.64);
  backdrop-filter: blur(12px);
  animation: pa-fade 180ms ease both;
}
/* 浅色主题：遮罩只压一层淡灰。原来的 0.42 在浅色界面上仍然像拉了一层黑幕 */
.pa-root[data-pa-theme='light'] .pa-call-overlay { background: rgba(15, 17, 21, 0.24); }

/* ---------- 弹层主体 ---------- */
.pa-call {
  /*
   * 通话弹层的局部色板，全部由 --pa-* 主题变量派生：
   *   · 深色主题下 = 原来的深灰观感（卡片色 → 页面底色的渐变）；
   *   · 浅色主题下 = 白卡片 + 深字。
   * 内部所有元素只引用这些变量，所以「只换外层、里面还是一堆深色块」的情况不会发生。
   */
  --pa-call-text: var(--pa-text);
  --pa-call-text-2: var(--pa-text-2);
  --pa-call-text-3: var(--pa-text-3);
  --pa-call-line: var(--pa-line-2);
  /* 控件 / 输入框 / 设置面板：比弹层背景高（深色）或低（浅色）一档，保证有层次。
     用 card-3 而不是 card-2：card-2 正好等于深色渐变中点的颜色，控件会「融进背景」。 */
  --pa-call-surface: var(--pa-card-3);
  --pa-call-surface-2: var(--pa-card-3);
  /* hover / 滚动条用半透明前景色叠加：任何底色上都自然，不用为每个主题挑实色 */
  --pa-call-hover: rgba(255, 255, 255, 0.12);
  --pa-call-scroll: rgba(255, 255, 255, 0.16);
  /* 激活态：前景色当底、背景色当字，深浅主题自动反转 */
  --pa-call-on: var(--pa-text);
  --pa-call-on-fg: var(--pa-bg);
  /* 语义色（文字）：深色主题用亮化值，浅色主题在下面的 light 覆盖里压深 */
  --pa-call-blue-fg: #8ab4ff;
  --pa-call-accent-fg: #ffc46b;
  --pa-call-red-fg: #ff9a92;
  --pa-call-green-fg: var(--pa-green);
  width: min(calc(100vw - 40px), 860px);
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 48px);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 0;
  border-radius: 24px;
  background: linear-gradient(180deg, var(--pa-card) 0%, var(--pa-card-2) 48%, var(--pa-bg) 100%);
  box-shadow: 0 32px 90px rgba(0, 0, 0, 0.52), 0 0 0 1px var(--pa-line-2);
  color: var(--pa-call-text);
  /*
   * 左右布局：左侧通话状态与控制、右侧实时转写。
   * 弹层本身不滚动，两栏各自滚动——否则「控制按钮跟着转写一起滚走」，
   * 通话中要挂断还得先往回滚（实测最容易漏的一条）。
   */
  overflow: hidden;
  animation: pa-pop 220ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
}
/* 左右两栏：左信息/控制、右转写 */
.pa-call__layout {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
}
.pa-call__side {
  flex: 0 0 336px;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 30px 22px 22px;
  overflow-x: hidden;
  overflow-y: auto;
  /* 滚动条隐藏但保留滚动：这一栏是一整块玻璃面板，露出滚动槽会切断圆角光晕 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.pa-call__side::-webkit-scrollbar { display: none; }
.pa-call__transcript {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 顶部留出右上角最小化按钮的高度，避免标题行被按钮压住 */
  padding: 46px 20px 18px;
  border-left: 1px solid var(--pa-call-line);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0));
}
.pa-root[data-pa-theme='light'] .pa-call__transcript {
  background: linear-gradient(180deg, rgba(15, 17, 21, 0.02), rgba(15, 17, 21, 0));
}
.pa-call__transcript-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 10px;
  border-bottom: 1px solid var(--pa-call-line);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  color: var(--pa-call-text-3);
}
.pa-call__transcript-title {
  font-weight: 600;
  letter-spacing: 0.14em;
  color: var(--pa-call-text-2);
}
.pa-call__transcript-count {
  margin-left: auto;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
}
/* 浅色主题：强调色压深，否则亮黄 / 亮蓝在白底上几乎看不清；阴影也换成浅色的 */
.pa-root[data-pa-theme='light'] .pa-call {
  --pa-call-blue-fg: #0b63c5;
  --pa-call-accent-fg: #96550a;
  --pa-call-red-fg: #c0291f;
  --pa-call-green-fg: #147a34;
  --pa-call-hover: rgba(15, 17, 21, 0.08);
  --pa-call-scroll: rgba(15, 17, 21, 0.18);
  box-shadow: 0 24px 70px rgba(15, 17, 21, 0.2), 0 0 0 1px var(--pa-line-2);
}
/* 隐藏滚动条（保留 overflow 的滚动能力）：WebKit 系必须整个 ::-webkit-scrollbar 关掉，
   只改 width 仍会占位并在悬停时露出槽。 */
.pa-call::-webkit-scrollbar { display: none; }
.pa-call::before {
  content: "";
  position: absolute;
  inset: -40% -30% auto;
  height: 70%;
  background: radial-gradient(ellipse at 50% 30%, rgba(255, 159, 10, 0.17), transparent 62%);
  pointer-events: none;
}
.pa-call::after {
  content: "";
  position: absolute;
  left: 8%;
  right: 8%;
  bottom: -32%;
  height: 46%;
  background: radial-gradient(ellipse at 50% 50%, rgba(10, 132, 255, 0.12), transparent 65%);
  pointer-events: none;
}
/* 浅色下光晕要收着点，否则白卡片上糊一片橙/蓝 */
.pa-root[data-pa-theme='light'] .pa-call::before { opacity: 0.5; }
.pa-root[data-pa-theme='light'] .pa-call::after { opacity: 0.45; }

.pa-call__minimize {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-call-text-2);
  background: var(--pa-call-surface);
  transition: background 120ms ease, color 120ms ease;
  z-index: 3;
}
.pa-call__minimize:hover { background: var(--pa-call-hover); color: var(--pa-call-text); }
.pa-call__encrypted {
  position: absolute;
  top: 18px;
  left: 16px;
  z-index: 2;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  letter-spacing: 0.05em;
  color: var(--pa-call-text-3);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pa-call__avatar-wrap {
  position: relative;
  width: 138px;
  height: 138px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 6px;
  flex: none;
  z-index: 1;
}
.pa-call__pulse {
  position: absolute;
  inset: 14px;
  border-radius: 50%;
  border: 1px solid rgba(255, 159, 10, 0.34);
  animation: pa-pulse 2.8s ease-out infinite;
  pointer-events: none;
}
.pa-call__pulse:nth-child(2) { animation-delay: 0.9s; }
.pa-call__pulse:nth-child(3) { animation-delay: 1.8s; }
.pa-call__avatar { position: relative; z-index: 2; border-radius: 50%; }
.pa-call__name { font-size: calc(18px + var(--pa-font-delta)); line-height: calc(25px + var(--pa-font-delta)); font-weight: 600; letter-spacing: 0.01em; z-index: 1; }
.pa-call__state {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: calc(17px + var(--pa-font-delta));
  color: var(--pa-call-text-2);
  font-variant-numeric: tabular-nums;
  z-index: 1;
}
.pa-call__state[data-status='ringing'] { color: var(--pa-call-text-3); }
.pa-call__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pa-green);
  box-shadow: 0 0 0 3px rgba(48, 209, 88, 0.15);
  flex: none;
}
.pa-call__state[data-status='ringing'] .pa-call__dot { background: var(--pa-accent); box-shadow: 0 0 0 3px rgba(255, 159, 10, 0.16); animation: pa-typing 1.1s ease-in-out infinite; }

/* 三阶段配色：在听=绿、在想=蓝、在说=橙、重连=红。
   圆点用高饱和色（小面积，两主题都清楚），文字走 --pa-call-*-fg。 */
.pa-call__state[data-status='listening'] .pa-call__dot { background: var(--pa-green); box-shadow: 0 0 0 3px rgba(48, 209, 88, 0.16); }
.pa-call__state[data-status='thinking'] { color: var(--pa-call-blue-fg); }
.pa-call__state[data-status='thinking'] .pa-call__dot { background: var(--pa-blue); box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.18); animation: pa-typing 1.4s ease-in-out infinite; }
.pa-call__state[data-status='speaking'] { color: var(--pa-call-accent-fg); }
.pa-call__state[data-status='speaking'] .pa-call__dot { background: var(--pa-accent); box-shadow: 0 0 0 3px rgba(255, 159, 10, 0.18); animation: pa-call-beat 1.1s ease-in-out infinite; }
.pa-call__state[data-status='reconnecting'] { color: var(--pa-call-red-fg); }
.pa-call__state[data-status='reconnecting'] .pa-call__dot { background: var(--pa-red); box-shadow: 0 0 0 3px rgba(255, 69, 58, 0.18); animation: pa-typing 0.9s ease-in-out infinite; }
@keyframes pa-call-beat {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.32); opacity: 0.72; }
}

/* 状态驱动的头像波纹与顶部光晕：让「在听 / 在想 / 在说」在余光里也能分辨 */
.pa-call[data-state='listening'] .pa-call__pulse { border-color: rgba(48, 209, 88, 0.36); animation-duration: 2.2s; }
.pa-call[data-state='thinking'] .pa-call__pulse { border-color: rgba(10, 132, 255, 0.32); animation-duration: 3.4s; }
.pa-call[data-state='speaking'] .pa-call__pulse { border-color: rgba(255, 159, 10, 0.44); animation-duration: 1.7s; }
.pa-call[data-state='reconnecting'] .pa-call__pulse { border-color: rgba(255, 69, 58, 0.34); animation-duration: 2.6s; }
.pa-call[data-state='listening']::before { background: radial-gradient(ellipse at 50% 30%, rgba(48, 209, 88, 0.13), transparent 62%); }
.pa-call[data-state='thinking']::before { background: radial-gradient(ellipse at 50% 30%, rgba(10, 132, 255, 0.16), transparent 62%); }
.pa-call[data-state='speaking']::before { background: radial-gradient(ellipse at 50% 30%, rgba(255, 159, 10, 0.2), transparent 62%); }
.pa-call[data-state='reconnecting']::before { background: radial-gradient(ellipse at 50% 30%, rgba(255, 69, 58, 0.17), transparent 62%); }

/* ---------- 提示条（到期 / 错误 / 麦克风不可用） ---------- */
.pa-call__notice {
  width: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 10px;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  overflow-wrap: anywhere;
  z-index: 1;
}
.pa-call__notice[data-kind='warn'] { background: rgba(255, 159, 10, 0.13); color: var(--pa-call-accent-fg); }
.pa-call__notice[data-kind='error'] { background: rgba(255, 69, 58, 0.14); color: var(--pa-call-red-fg); }
/*
 * 带 button 前缀：base.css 的「.pa-root button」（特异性 0,1,1）会把纯类选择器
 * （0,1,0）的 padding / background / color 全部重置掉。同特异性 + 后注入才压得住。
 */
button.pa-call__notice-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 7px;
  /* 用卡片实色而不是半透明白：叠在彩色提示条上，深浅主题都能形成清晰的胶囊边界 */
  background: var(--pa-card);
  color: inherit;
  font-size: calc(10px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  flex: none;
  transition: background 120ms ease;
}
.pa-call__notice-btn:hover { background: var(--pa-call-hover); }

/* ---------- 语音任务（让 Bot 干活） ---------- */
/*
 * 三种 phase 共用一块「状态条」：running 蓝（与「在想」同色系）、done 绿、failed 红。
 * 颜色一律走 .pa-call 上的语义变量（浅色主题在覆盖块里压深），底色是低透明度的同色系，
 * 深浅两套主题都能看清；不要在这里写死文字色。
 *
 * 出现用 animation（只在元素挂载时播一次），收起用 transition + data-fading：
 * 结束态改 data-phase 不会重播入场动画，淡出由 store 先置 fading 再移除。
 */
.pa-call__task {
  width: 100%;
  max-height: 120px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(10, 132, 255, 0.13);
  color: var(--pa-call-blue-fg);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  overflow: hidden;
  overflow-wrap: anywhere;
  z-index: 1;
  /*
   * 入场动画的 fill-mode 必须是 backwards，**不能是 both / forwards**：
   * 动画结束后 fill-mode 会继续压住 opacity / transform，下面 data-fading 的
   * transition 就永远不生效（表现成「淡出没反应，到点直接消失」）。
   * backwards 只在动画开始前应用 from 帧，播完即交还给普通声明。
   */
  animation: pa-call-task-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
  transition: opacity 600ms ease, max-height 600ms ease, padding 600ms ease, transform 600ms ease;
}
.pa-call__task[data-phase='done'] {
  background: rgba(48, 209, 88, 0.14);
  color: var(--pa-call-green-fg);
}
.pa-call__task[data-phase='failed'] {
  background: rgba(255, 69, 58, 0.15);
  color: var(--pa-call-red-fg);
}
/* 淡出：透明度 + 高度一起收，避免移除那一刻下面的内容往上跳一格 */
.pa-call__task[data-fading='true'] {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  transform: translateY(-2px);
  pointer-events: none;
}
.pa-call__task-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: calc(15px + var(--pa-font-delta));
}
/* running 的转圈：border 环 + 缺口，currentColor 跟随 phase 的主题色 */
.pa-call__task-spinner {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  animation: pa-call-spin 900ms linear infinite;
}
@keyframes pa-call-spin {
  to { transform: rotate(360deg); }
}
@keyframes pa-call-task-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.pa-call__task-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pa-call__task-title { font-weight: 600; }
.pa-call__task-note { color: var(--pa-call-text-2); font-weight: 400; }

/* ---------- 实时转写（右侧栏，独立滚动） ---------- */
.pa-call__turns {
  width: 100%;
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  /* 滚动条隐藏但保留滚动：转写区是右侧整栏内容，露出滚动槽会破坏这块玻璃面板 */
  scrollbar-width: none;
  -ms-overflow-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 4px 6px;
  border: 0;
  z-index: 1;
}
.pa-call__turns::-webkit-scrollbar { display: none; }
.pa-call__turn {
  max-width: 88%;
  padding: 8px 11px;
  border-radius: 12px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.58;
  overflow-wrap: anywhere;
  animation: pa-rise 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.pa-call__turn[data-role='user'] { align-self: flex-end; background: var(--pa-call-surface-2); color: var(--pa-call-text); border-bottom-right-radius: 4px; }
/* Bot 气泡比用户气泡淡一档（沿用原来的层级）；浅色下再补一圈发丝边，否则白底上看不出气泡边界 */
.pa-call__turn[data-role='bot'] { align-self: flex-start; background: var(--pa-card-2); color: var(--pa-call-text); border-bottom-left-radius: 4px; box-shadow: 0 0 0 1px var(--pa-line); }
.pa-call__turn-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: calc(13px + var(--pa-font-delta));
  color: var(--pa-call-text-3);
  margin-bottom: 3px;
}
.pa-call__empty { margin: auto; font-size: calc(11.5px + var(--pa-font-delta)); line-height: calc(17px + var(--pa-font-delta)); color: var(--pa-call-text-3); text-align: center; }

/* 正在流式生成的那一句（还没定稿）：左侧小标签 + 闪烁光标，与已定稿的轮次区分开 */
.pa-call__turn[data-live='true'] { opacity: 0.94; }
.pa-call__live-tag {
  margin-left: auto;
  color: var(--pa-call-green-fg);
  font-size: calc(9px + var(--pa-font-delta));
  letter-spacing: 0.04em;
}
.pa-call__caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -2px;
  background: currentColor;
  animation: pa-call-caret 1s steps(2, start) infinite;
}
@keyframes pa-call-caret {
  0%, 100% { opacity: 0.15; }
  50% { opacity: 0.72; }
}

/* ---------- 思考过程（可折叠） ---------- */
.pa-call__think {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  z-index: 1;
}
button.pa-call__think-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border-radius: 999px;
  background: rgba(10, 132, 255, 0.14);
  color: var(--pa-call-blue-fg);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  transition: background 120ms ease;
}
.pa-call__think-toggle:hover { background: rgba(10, 132, 255, 0.24); }
.pa-call__think-toggle svg:last-child { transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-call__think-toggle[data-open='true'] svg:last-child { transform: rotate(180deg); }
.pa-call__think-body {
  width: 100%;
  max-height: 92px;
  overflow-y: auto;
  /* 同上：思考区是圆角填充面，滚动条会贴着圆角露出直角槽 */
  scrollbar-width: none;
  -ms-overflow-style: none;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(10, 132, 255, 0.09);
  color: var(--pa-call-text-2);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  animation: pa-fade 160ms ease both;
}
.pa-call__think-body::-webkit-scrollbar { display: none; }

/* ---------- 麦克风波形 + 打断 ---------- */
/* 全双工没有「点击说话」按钮：麦克风一直开着，这里显示的是实时电平与当前提示。 */
.pa-call__audio {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  z-index: 1;
}
.pa-call__wave {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 100%;
  height: 38px;
  padding: 0 4px;
}
.pa-call__wave span {
  flex: 1 1 auto;
  min-width: 2px;
  max-width: 5px;
  height: 100%;
  border-radius: 3px;
  /* 波形是「声音在动」的唯一视觉线索，绿色与 listening 状态同色系 */
  background: linear-gradient(180deg, rgba(48, 209, 88, 0.92), rgba(48, 209, 88, 0.3));
  transform: scaleY(0.08);
  transform-origin: center;
  transition: transform 60ms linear, background 200ms ease;
}
.pa-call__wave[data-on='false'] span {
  background: var(--pa-call-line);
}
.pa-call__audio-note {
  font-size: calc(10px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  color: var(--pa-call-text-3);
  text-align: center;
  overflow-wrap: anywhere;
}
button.pa-call__interrupt {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 13px;
  border-radius: 999px;
  background: rgba(255, 159, 10, 0.16);
  color: var(--pa-call-accent-fg);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  transition: background 120ms ease;
  z-index: 1;
}
.pa-call__interrupt:hover { background: rgba(255, 159, 10, 0.28); }

/* ---------- 通话音量拖动条 ---------- */
/* 只调下行（听 Bot 说话）的播放增益；上行麦克风由浏览器 autoGainControl 管，
   这里不碰——叠一层增益会干扰服务端 VAD 与 ASR。 */
.pa-call__volume {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  z-index: 1;
}
.pa-call__volume-icon {
  flex: none;
  display: inline-flex;
  color: var(--pa-call-text-3);
}
.pa-call__volume-range {
  flex: 1;
  min-width: 0;
  height: 16px;
  margin: 0;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
  outline: none;
}
/*
 * 轨道：已填充部分用强调色，剩余部分用发丝线。
 * 「--pa-call-vol-fill」由 JSX 按当前音量写进 style（0%..100%），滑块一动轨道跟着变。
 * 强调色用 --pa-call-accent-fg（浅色主题已压深），不用 --pa-accent：亮橙在浅色
 * 轨道上几乎看不出边界。
 */
.pa-call__volume-range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--pa-call-accent-fg) 0 var(--pa-call-vol-fill, 100%),
    var(--pa-call-line) var(--pa-call-vol-fill, 100%) 100%
  );
}
.pa-call__volume-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4px;
  border-radius: 50%;
  background: var(--pa-call-text);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  transition: transform 120ms ease;
}
.pa-call__volume-range:hover::-webkit-slider-thumb { transform: scale(1.15); }
.pa-call__volume-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px rgba(255, 159, 10, 0.35);
}
/* Firefox：轨道与已填充段是两个伪元素，没有渐变也能对齐观感 */
.pa-call__volume-range::-moz-range-track {
  height: 4px;
  border-radius: 999px;
  background: var(--pa-call-line);
}
.pa-call__volume-range::-moz-range-progress {
  height: 4px;
  border-radius: 999px;
  background: var(--pa-call-accent-fg);
}
.pa-call__volume-range::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 0;
  border-radius: 50%;
  background: var(--pa-call-text);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
}
.pa-call__volume-value {
  flex: none;
  min-width: 34px;
  text-align: right;
  font-size: calc(10px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  color: var(--pa-call-text-2);
  font-variant-numeric: tabular-nums;
}
.pa-call__volume-value[data-muted='true'] { color: var(--pa-call-accent-fg); }
.pa-call__type {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 2px;
  z-index: 1;
}
.pa-call__type input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 11px;
  border-radius: 9px;
  border: 1px solid var(--pa-call-line);
  background: var(--pa-call-surface);
  color: var(--pa-call-text);
  font-size: calc(12px + var(--pa-font-delta));
  outline: none;
}
.pa-call__type input::placeholder { color: var(--pa-call-text-3); }
.pa-call__type input:focus { border-color: rgba(255, 159, 10, 0.45); }
.pa-call__type button {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--pa-call-on);
  color: var(--pa-call-on-fg);
  flex: none;
}
.pa-call__type button:disabled { opacity: 0.35; cursor: not-allowed; }
.pa-call__thinking { display: inline-flex; gap: 4px; align-items: center; height: 20px; }
.pa-call__thinking i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pa-call-text-2);
  animation: pa-typing 1.1s ease-in-out infinite;
}
.pa-call__thinking i:nth-child(2) { animation-delay: 120ms; }
.pa-call__thinking i:nth-child(3) { animation-delay: 240ms; }

/* ---------- 通话设置（音色 / 语速，会话级、下一通生效） ---------- */
.pa-call__settings {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 1;
}
button.pa-call__settings-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--pa-call-surface);
  color: var(--pa-call-text-2);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  transition: background 120ms ease, color 120ms ease;
}
.pa-call__settings-toggle:hover { background: var(--pa-call-hover); color: var(--pa-call-text); }
.pa-call__settings-toggle svg:last-child { transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-call__settings-toggle[data-open='true'] svg:last-child { transform: rotate(180deg); }
.pa-call__settings-body {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--pa-call-surface);
  animation: pa-fade 160ms ease both;
}
.pa-call__field { display: flex; align-items: center; gap: 10px; }
.pa-call__field-label {
  flex: none;
  width: 32px;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-call-text-2);
}
/*
 * 音色下拉（自绘 PaSelect）：触发器跟随通话弹层的局部色板，弹层本身由 JS portal
 * 到 .pa-root 并 fixed 定位，所以这里的后代选择器只管得到触发器——弹层外观走
 * base.css 里那套全局 --pa-* 样式（深浅主题都成立）。
 */
.pa-call__voice-select { flex: 1; min-width: 0; }
.pa-call__voice-select .pa-select__trigger {
  height: 30px;
  padding: 0 8px;
  border-radius: 8px;
  border-color: var(--pa-call-line);
  background: var(--pa-card);
  color: var(--pa-call-text);
  font-size: calc(11.5px + var(--pa-font-delta));
}
.pa-call__voice-select .pa-select__trigger:hover { background: var(--pa-call-hover); }
.pa-call__voice-select .pa-select__chevron { color: var(--pa-call-text-3); }
.pa-call__field-hint {
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  color: var(--pa-call-text-3);
  padding-left: 42px;
  margin-top: -4px;
}
.pa-call__seg {
  flex: 1;
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: var(--pa-card);
  border: 1px solid var(--pa-call-line);
}
.pa-call__seg button {
  flex: 1;
  min-width: 0;
  height: 24px;
  border-radius: 6px;
  color: var(--pa-call-text-2);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  transition: background 120ms ease, color 120ms ease;
}
.pa-call__seg button:hover { background: var(--pa-call-hover); color: var(--pa-call-text); }
.pa-call__seg button[data-on='true'] { background: var(--pa-call-on); color: var(--pa-call-on-fg); }
.pa-call__seg button:disabled { opacity: 0.5; cursor: not-allowed; }
.pa-call__settings-hint {
  margin: 0;
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  color: var(--pa-call-text-3);
}
.pa-call__settings-hint b { color: var(--pa-call-text-2); font-weight: 600; }

/* ---------- 控制按钮 ---------- */
.pa-call__controls {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 14px;
  width: 100%;
  margin-top: 2px;
  z-index: 1;
}
.pa-call__ctrl { display: flex; flex-direction: column; align-items: center; gap: 5px; color: var(--pa-call-text-2); font-size: calc(10px + var(--pa-font-delta)); line-height: calc(14px + var(--pa-font-delta)); }
.pa-call__ctrl-icon {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background: var(--pa-call-surface);
  color: var(--pa-call-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 130ms ease, transform 110ms ease, opacity 130ms ease;
}
.pa-call__ctrl:hover .pa-call__ctrl-icon { background: var(--pa-call-hover); }
.pa-call__ctrl:active .pa-call__ctrl-icon { transform: scale(0.94); }
.pa-call__ctrl[data-on='true'] .pa-call__ctrl-icon { background: var(--pa-call-on); color: var(--pa-call-on-fg); }
.pa-call__ctrl[data-disabled='true'] { opacity: 0.38; cursor: not-allowed; }
.pa-call__ctrl[data-disabled='true'] .pa-call__ctrl-icon { background: var(--pa-card); }
.pa-call__ctrl--danger .pa-call__ctrl-icon { background: var(--pa-red); color: #ffffff; }
.pa-call__ctrl--danger:hover .pa-call__ctrl-icon { background: #ff5d52; }

/* ---------- 通话消息卡 ---------- */
.pa-callcard {
  width: min(100%, 460px);
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 12px;
  overflow: hidden;
}
.pa-callcard__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  text-align: left;
  transition: background 120ms ease;
}
.pa-callcard__head:hover { background: var(--pa-card-2); }
.pa-callcard__icon {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(48, 209, 88, 0.12);
  color: var(--pa-green);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.pa-callcard__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pa-callcard__title { font-size: calc(13px + var(--pa-font-delta)); line-height: calc(18px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); }
.pa-callcard__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: calc(10.5px + var(--pa-font-delta)); line-height: calc(15px + var(--pa-font-delta)); color: var(--pa-text-3); font-variant-numeric: tabular-nums; }
.pa-callcard__source { color: var(--pa-accent); background: rgba(255, 159, 10, 0.1); border-radius: 4px; padding: 0 5px; font-size: calc(9.5px + var(--pa-font-delta)); line-height: calc(14px + var(--pa-font-delta)); }
.pa-callcard__chevron { flex: none; display: inline-flex; color: var(--pa-text-3); transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.pa-callcard[data-open='true'] .pa-callcard__chevron { transform: rotate(180deg); }
.pa-callcard__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--pa-line);
  animation: pa-fade 160ms ease both;
}
.pa-callcard__turn {
  max-width: 88%;
  padding: 8px 11px;
  border-radius: 12px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.58;
  overflow-wrap: anywhere;
}
.pa-callcard__turn[data-role='user'] { align-self: flex-end; background: var(--pa-card-3); border-bottom-right-radius: 4px; color: var(--pa-text); }
.pa-callcard__turn[data-role='bot'] { align-self: flex-start; background: var(--pa-chat-glass-2, var(--pa-card-2)); border-bottom-left-radius: 4px; color: var(--pa-text-2); }
.pa-callcard__turn-label { display: flex; align-items: center; gap: 5px; font-size: calc(9.5px + var(--pa-font-delta)); line-height: calc(13px + var(--pa-font-delta)); color: var(--pa-text-3); margin-bottom: 2px; }
.pa-callcard__turn-time { margin-left: auto; font-variant-numeric: tabular-nums; }
.pa-callcard__turn-text { white-space: pre-wrap; }
.pa-callcard__empty { font-size: calc(11.5px + var(--pa-font-delta)); line-height: calc(17px + var(--pa-font-delta)); color: var(--pa-text-3); text-align: center; padding: 4px 0; }
/* 实时通话记录展开后的模型 / 音色（旧半双工记录没有这一行） */
.pa-callcard__engine {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: calc(10px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
  color: var(--pa-text-3);
  font-variant-numeric: tabular-nums;
}
.pa-callcard__collapse {
  align-self: center;
  margin-top: 2px;
  padding: 4px 12px;
  border-radius: 6px;
  background: var(--pa-chat-glass, var(--pa-card-2));
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  transition: color 120ms ease, background 120ms ease;
}
.pa-callcard__collapse:hover { color: var(--pa-text); background: var(--pa-chat-hover, var(--pa-card-3)); }

/* base.css 的 .pa-root button 重置（0,1,1）会压过纯类选择器；补回按钮外观。 */
button.pa-call__minimize {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--pa-call-text-2);
  background: var(--pa-call-surface);
}
button.pa-call__ctrl {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  color: var(--pa-call-text-2);
  font-size: calc(10px + var(--pa-font-delta));
  line-height: calc(14px + var(--pa-font-delta));
}
button.pa-callcard__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  text-align: left;
}
button.pa-callcard__collapse {
  align-self: center;
  margin-top: 2px;
  padding: 4px 12px;
  border-radius: 6px;
  background: var(--pa-chat-glass, var(--pa-card-2));
  color: var(--pa-text-3);
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
}

/* 窄屏（手机 / 侧栏很窄的窗口）：左右布局退回上下布局，弹层整体纵向滚动 */
@media (max-width: 760px) {
  .pa-call { width: min(100%, 440px); max-height: calc(100vh - 32px); overflow-y: auto; }
  .pa-call__layout { flex-direction: column; }
  .pa-call__side { flex: none; padding: 30px 20px 16px; overflow: visible; }
  .pa-call__transcript {
    flex: none;
    border-left: 0;
    border-top: 1px solid var(--pa-call-line);
    padding: 14px 16px 18px;
  }
  .pa-call__turns { flex: none; min-height: 104px; max-height: 216px; }
}
@media (max-width: 480px) {
  .pa-call { width: 100%; }
  .pa-call__side { padding: 26px 16px 14px; }
  .pa-call__transcript { padding: 12px 14px 16px; }
  .pa-call__controls { gap: 8px; }
  .pa-call__ctrl-icon { width: 46px; height: 46px; }
  .pa-call__wave { height: 32px; gap: 2px; }
  .pa-call__field-hint { padding-left: 0; }
}
/* 矮屏（笔记本 768p / 分屏）收紧一档；只作用于左右布局，窄屏由上面的媒体查询接管 */
@media (max-height: 780px) and (min-width: 761px) {
  .pa-call__side { gap: 10px; padding: 24px 20px 16px; }
  .pa-call__transcript { padding: 20px 18px 14px; }
  .pa-call__avatar-wrap { width: 112px; height: 112px; margin-top: 2px; }
  .pa-call__wave { height: 30px; }
  .pa-call__ctrl-icon { width: 44px; height: 44px; }
  /* 任务条也收一档：矮屏下多一行提示就少一行转写 */
  .pa-call__task { padding: 7px 9px; }
}
`

let injected = false

/** 幂等注入通话区样式；返回本次是否真正插入。 */
export function injectCallStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-call-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-call-styles'
  style.textContent = PERSONAL_CALL_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function callStylesInjected(): boolean {
  return injected
}
