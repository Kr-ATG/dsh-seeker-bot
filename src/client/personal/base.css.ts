/**
 * Personal Agent — 基础设计系统与全局布局样式。
 *
 * 深色主题为基准（参考截图），同时跟随 DSH 的 --dsw-alias-* token 自动适配亮色。
 * 组件模块只追加自己的规则；不要在这里写具体业务组件样式。
 */

export const PERSONAL_BASE_CSS = `
html body[data-skb-mode='bot'] { overflow: hidden !important; }
html body[data-skb-mode='bot'] #root { overflow: hidden !important; }

.pa-root {
  --pa-bg: #141517;
  /*
   * 侧栏底色直接跟随官方主题变量 --dsw-specific-sidebar-fill（官方 .hHd-Xa_root
   * 用的就是它）：Work 与 Bot 两个模式的左侧栏因此同源同色，切模式不会出现
   * 一深一浅的色块。读不到时（独立演示页没有宿主主题）回退原先的深色值。
   */
  --pa-sidebar: var(--dsw-specific-sidebar-fill, #17181a);
  /*
   * 中间对话区底色直接跟随官方 --dsw-alias-bg-base（官方对话区 .pI_x6G_frame /
   * 对话列用的就是它）：Work 与 Bot 两个模式的中间区因此同源同色，切模式不会
   * 出现一深一浅的色块。读不到时（独立演示页没有宿主主题）回退原先的深色值。
   *
   * 气泡仍比画布亮一档（--pa-card），靠色差浮出来而不是描边——这条设计不变。
   */
  --pa-main: var(--dsw-alias-bg-base, #181819);
  /*
   * 右栏底色与左侧栏保持同一块面：直接引用 --pa-sidebar，而不是另给一个
   * 近似值（旧值是 #18191b，比左栏亮一档，两侧拼在一起能看出色差）。
   * 这样以后调左栏颜色，右栏自动跟随，不会再分叉。
   */
  --pa-right: var(--pa-sidebar);
  --pa-card: #202124;
  --pa-card-2: #26272a;
  --pa-card-3: #2e3138;
  --pa-line: rgba(255, 255, 255, 0.065);
  --pa-line-2: rgba(255, 255, 255, 0.11);
  --pa-text: #f2f3f5;
  --pa-text-2: #a7abb2;
  --pa-text-3: #73777f;
  --pa-text-4: #55585f;
  --pa-accent: #ff9f0a;
  --pa-blue: #0a84ff;
  --pa-red: #ff453a;
  --pa-green: #30d158;
  --pa-radius-card: 12px;
  --pa-radius-input: 14px;
  --pa-shadow-pop: 0 18px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06);
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  overflow: hidden;
  background: var(--pa-bg);
  color: var(--pa-text);
  /*
   * 字体与字号跟随 Work 模式的「设置」：
   *  · --dsw-font-family 是官方在 body 上解析好的正文族（已把用户选的字体
   *    --dsh-font-family-text 排在系统栈前面），直接继承即可；后面的 fallback
   *    只在官方样式缺失时兜底。
   *  · --dsh-content-font-size 是官方「通用 → 字号」的正文档位（10–22px，默认 14）。
   *    用户要求（2026-11-03）：「BOT 模式下的所有字体与字号跟随通用设置」——
   *    关键是 Bot 的**正文要等于**这个值，而不是比它小一档（旧实现是
   *    calc(13px + (通用字号 − 14px))，通用 14px 时正文只有 13px，与 Work 模式
   *    的 14px 正文差一号，切模式能明显看出字变小了）。
   *
   *    做法：把 delta 的标定线定在 13px（Bot 正文档的原始设计值），
   *      --pa-font-delta = 通用字号 − 13px
   *    通用 14px 时 delta = 1px：「.pa-root」的正文解析成 14px（= 通用字号），
   *    其余 300 多处 calc(Npx + var(--pa-font-delta))（字号与行高成对出现）
   *    一起抬 1px，相对层次不变；通用字号调到 10px / 22px 时整页仍整体平移
   *    −3px / +9px，与 Work 模式同步。
   *
   *    注：不用「比例」是因为 CSS calc() 的除数必须是纯数字，
   *    calc(14px / 14px) 不合规范会被整条丢弃，字号会静默掉回继承值。
   */
  --pa-font-size: var(--dsh-content-font-size, 14px);
  --pa-font-delta: calc(var(--pa-font-size) - 13px);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif);
  font-size: var(--pa-font-size);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.pa-root * { box-sizing: border-box; }
.pa-root button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
/*
 * 按钮里的图标永远不吃指针事件：图标只是装饰，点击目标是按钮本身。
 * 不加这条时，命中检测会落在内层 <svg> 上（自动化工具直接判定「按钮点不到」，
 * 真实鼠标点击虽然靠冒泡还能生效，但 hover / 焦点环也会闪）。
 */
.pa-root button svg { pointer-events: none; }
.pa-root input, .pa-root textarea, .pa-root select { font: inherit; color: inherit; }
.pa-root ::selection { background: rgba(255, 159, 10, 0.28); }
.pa-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.pa-root ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.09); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
.pa-root ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.16); background-clip: content-box; }
.pa-root ::-webkit-scrollbar-track { background: transparent; }

.pa-root[data-pa-theme='dark'] { color-scheme: dark; }
.pa-root[data-pa-theme='light'] {
  --pa-bg: #f4f5f7;
  /* 亮色同样跟随官方侧栏底色，保证与 Work 模式同色；读不到时回退原亮色值。 */
  --pa-sidebar: var(--dsw-specific-sidebar-fill, #f9fafb);
  /* 亮色中间区同样跟随官方对话区底色（--dsw-alias-bg-base）。 */
  --pa-main: var(--dsw-alias-bg-base, #fcfcfc);
  /* 亮色同样与左栏同色（旧值 #f2f3f5 比左栏暗，右侧会显出一层灰）。 */
  --pa-right: var(--pa-sidebar);
  --pa-card: #ffffff;
  --pa-card-2: #e9ebef;
  --pa-card-3: #e3e6eb;
  --pa-line: rgba(15, 17, 21, 0.07);
  --pa-line-2: rgba(15, 17, 21, 0.12);
  --pa-text: #14161a;
  --pa-text-2: #5d6269;
  --pa-text-3: #858a92;
  --pa-text-4: #a4a9b1;
  color-scheme: light;
}

.pa-app-shell { display: flex; flex: 1; min-width: 0; min-height: 0; }
.pa-col { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.pa-grow { flex: 1; min-height: 0; }

/* ---------- 左侧栏 ---------- */
.pa-sidebar {
  /*
   * 宽度跟随 Work 模式官方侧栏的拖拽值（--pa-sidebar-w 由 shell/work-sidebar-width.ts
   * 写在 .pa-root 上，值是官方侧栏根的 inline width）。读不到时回退官方默认的
   * 280px —— 与 Work 模式切换时左侧栏不跳宽度，分段控件可用宽度也随之对齐
   * （280-28=252）。
   */
  width: var(--pa-sidebar-w, 280px);
  flex: 0 0 var(--pa-sidebar-w, 280px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--pa-sidebar);
  border-right: 1px solid var(--pa-line);
  position: relative;
  /* 收起 / 展开与官方侧栏同一节奏（官方收口 150ms）。 */
  transition: width 160ms cubic-bezier(0.22, 0.8, 0.24, 1), flex-basis 160ms cubic-bezier(0.22, 0.8, 0.24, 1);
}
/*
 * 顶部品牌行：与 Work 模式官方侧栏完全一致的一行。
 *
 * 官方规格（.hHd-Xa_root padding 6/8 + .hHd-Xa_logoRow height 60 padding 8）：
 * 品牌内容从 y=6 开始、左边距 8+8=16、右边距 8，toggle 28×28 垂直居中于 60px。
 * 这里照抄这套内边距，品牌 mark / wordmark / 按钮的落点与 Work 模式逐像素一致
 * （实测 Work：wordmark x45 y24 156×24，toggle x244 y22 28×28）。
 */
.pa-sidebar__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 66px;
  padding: 6px 8px 0 16px;
  box-sizing: border-box;
  flex: none;
}
/* 品牌行：鲸鱼 mark + 官方 wordmark（含 HARNESS 徽标）。 */
.pa-brand {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 24px;
  color: var(--pa-text);
  /*
   * HARNESS 徽标是「底色 = 品牌色、字母 = 反色」：官方 wordmark 里字母的
   * fill 走 --dsw-alias-label-primary-inverted。DSH 里这个变量由宿主提供，
   * 独立演示页没有宿主样式，所以在这里按 Bot 主题显式钉一份同值兜底。
   */
  --dsw-alias-label-primary-inverted: #ffffff;
}
.pa-root[data-pa-theme='dark'] .pa-brand {
  --dsw-alias-label-primary-inverted: #0b0b0c;
}
.pa-brand > svg { flex: none; display: block; }
.pa-brand__wordmark { display: inline-flex; flex: none; }
.pa-brand__wordmark > svg { display: block; width: 100%; height: 100%; }
/* 收起按钮：官方是 28×28 圆角矩形（不是圆形），hover 只给底色。 */
.pa-sidebar-toggle {
  width: 28px;
  height: 28px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: var(--pa-text-2);
  transition: background 120ms ease, color 120ms ease;
}
.pa-sidebar-toggle:hover { background: rgba(128, 132, 140, 0.16); color: var(--pa-text); }
.pa-sidebar-toggle:active { transform: scale(0.96); }
/* 折叠态顶部：鲸鱼 mark 即展开入口（与官方 rail 的 railMark 一致），hover 换面板图标。 */
.pa-sidebar-toggle--rail {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  color: var(--pa-text);
}
.pa-sidebar-toggle--rail .pa-sidebar-toggle__mark { display: inline-flex; }
.pa-sidebar-toggle--rail .pa-sidebar-toggle__icon { display: none; }
.pa-sidebar-toggle--rail:hover .pa-sidebar-toggle__mark { display: none; }
.pa-sidebar-toggle--rail:hover .pa-sidebar-toggle__icon { display: inline-flex; }
.pa-icon-btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--pa-text-2);
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
  flex: none;
}
.pa-icon-btn:hover { background: rgba(255, 255, 255, 0.08); color: var(--pa-text); }
.pa-icon-btn:active { transform: scale(0.94); }
.pa-icon-btn--bordered { background: rgba(255, 255, 255, 0.055); }
.pa-icon-btn--accent { color: var(--pa-accent); }
.pa-spacer { flex: 1; }

/* Work / Bot 分段（参考第二张素材：深槽 + 黑色滑块） */
.pa-mode-seg {
  display: flex;
  gap: 3px;
  margin: 8px 14px 12px;
  padding: 4px;
  border-radius: 13px;
  background: #2a2b2e;
  flex: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.035);
}
.pa-root[data-pa-theme='light'] .pa-mode-seg { background: #dfe2e7; }
.pa-mode-seg button {
  flex: 1;
  height: 34px;
  border-radius: 10px;
  /*
   * 行高锁 1 + flex 居中：字号轴抬到 22px 档时（14+delta → 23px），继承的
   * 1.55 行高会把行盒顶到 35.65px，比 34px 的按钮高——文字上下各溢 0.8px，
   * 贴着圆角边。14px 档下看不出，极端档位能看出来。
   */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  font-size: calc(14px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.01em;
  color: #a1a4aa;
  transition: color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}
.pa-mode-seg button:hover { color: #d8dade; }
.pa-mode-seg button[data-on='true'] {
  background: #0b0b0c;
  color: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.07);
}
.pa-root[data-pa-theme='light'] .pa-mode-seg button[data-on='true'] { background: #ffffff; color: #14161a; box-shadow: 0 1px 3px rgba(0,0,0,.12); }

.pa-sidebar__scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 2px 10px 10px; min-height: 0; }
.pa-sidebar__bottom { flex: none; padding: 8px 12px 12px; border-top: 1px solid var(--pa-line); }

/* ---------- 主 bot ---------- */
.pa-mainbot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 10px 12px;
  border-radius: 14px;
  transition: background 130ms ease;
  position: relative;
  cursor: pointer;
}
.pa-mainbot:hover { background: rgba(255, 255, 255, 0.03); }
.pa-mainbot[data-selected='true'] { background: transparent; }
.pa-mainbot__name {
  font-size: calc(13.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  letter-spacing: 0.01em;
  /* 右下角是「+ 新建」按钮，名字给按钮让出 30px，避免长名字压到按钮上。 */
  max-width: calc(100% - 30px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * 主 Bot 卡片右下角的「+」：新建 Bot / 群聊的唯一入口（2026-11-02 从顶部挪来）。
 *
 * 常驻可见而不是 hover 才出现：新建是低频但「找得到」比「不碍眼」重要，
 * 主 Bot 卡片又只有这一处入口，藏起来会让用户以为功能没了。
 */
.pa-mainbot__add {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 28px;
  height: 28px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--pa-card-2);
  border: 1px solid var(--pa-line-2);
  color: var(--pa-text-2);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.pa-mainbot__add:hover { background: var(--pa-card-3); color: var(--pa-text); border-color: transparent; }
.pa-mainbot__add:active { transform: scale(0.94); }
.pa-mainbot__add[data-open='true'] {
  background: var(--pa-accent);
  border-color: transparent;
  color: #1a1206;
}
.pa-mainbot__meta { font-size: calc(10.5px + var(--pa-font-delta)); color: var(--pa-text-3); margin-top: -4px; }

/* ---------- 头像 ---------- */
.pa-avatar { position: relative; display: inline-flex; flex: none; }
.pa-avatar svg { display: block; width: 100%; height: 100%; overflow: visible; }
.pa-avatar__online {
  position: absolute;
  right: -1px;
  bottom: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--pa-accent);
  box-shadow: 0 0 0 2.5px var(--pa-sidebar);
}

/* ---------- 列表行 ---------- */
.pa-sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 8px 5px;
  font-size: calc(10.5px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pa-text-4);
  user-select: none;
}
.pa-sec-title__count { margin-left: auto; font-size: calc(10px + var(--pa-font-delta)); color: var(--pa-text-4); letter-spacing: 0; }

.pa-bot-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 8px;
  border-radius: 10px;
  text-align: left;
  transition: background 120ms ease;
  position: relative;
  cursor: pointer;
}
.pa-bot-row:hover { background: rgba(255, 255, 255, 0.045); }
.pa-bot-row[data-selected='true'] { background: var(--pa-card-2); }
.pa-bot-row__body { flex: 1; min-width: 0; }
.pa-bot-row__line1 { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.pa-bot-row__name { font-size: calc(12.5px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%; flex: 0 1 auto; }
.pa-bot-row__role { font-size: calc(9.5px + var(--pa-font-delta)); color: var(--pa-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.pa-bot-row__summary { font-size: calc(10.5px + var(--pa-font-delta)); color: var(--pa-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.pa-bot-row[data-selected='true'] .pa-bot-row__summary { color: var(--pa-text-2); }
.pa-bot-row__badge {
  min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px; background: var(--pa-accent);
  color: #1a1206; font-size: calc(9.5px + var(--pa-font-delta)); font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
  flex: none;
}

/* ---------- 通用按钮 ---------- */
/*
 * 选择器必须带上 .pa-root：文件顶部的 .pa-root button 重置（0,1,1）
 * 会压过裸 .pa-btn（0,1,0），把背景、字重和内边距全部清掉——弹窗底部的
 * 主按钮会退化成一行白字。这里用 0,2,0 把按钮外观拿回来。
 */
.pa-root .pa-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: 9px;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text);
  background: rgba(255, 255, 255, 0.07);
  transition: background 120ms ease, transform 100ms ease, opacity 120ms ease;
  white-space: nowrap;
}
.pa-root .pa-btn:hover { background: rgba(255, 255, 255, 0.12); }
.pa-root .pa-btn:active { transform: scale(0.98); }
.pa-root .pa-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.pa-root .pa-btn--primary { background: #f2f3f5; color: #14161a; font-weight: 600; }
.pa-root .pa-btn--primary:hover { background: #ffffff; }
.pa-root .pa-btn--ghost { background: transparent; color: var(--pa-text-2); }
.pa-root .pa-btn--ghost:hover { background: rgba(255, 255, 255, 0.06); color: var(--pa-text); }
.pa-root .pa-btn--danger { background: rgba(255, 69, 58, 0.16); color: #ff8a82; }
.pa-root .pa-btn--sm { height: 26px; padding: 0 10px; font-size: calc(11px + var(--pa-font-delta)); border-radius: 7px; }
/* 浅色主题：主按钮用深色实底，避免 #f2f3f5 落在白底上几乎看不见 */
.pa-root[data-pa-theme='light'] .pa-btn { background: rgba(15, 17, 21, 0.06); }
.pa-root[data-pa-theme='light'] .pa-btn:hover { background: rgba(15, 17, 21, 0.1); }
.pa-root[data-pa-theme='light'] .pa-btn--primary { background: #14161a; color: #ffffff; }
.pa-root[data-pa-theme='light'] .pa-btn--primary:hover { background: #2a2d33; }
.pa-root[data-pa-theme='light'] .pa-btn--ghost { background: transparent; }
.pa-root[data-pa-theme='light'] .pa-btn--ghost:hover { background: rgba(15, 17, 21, 0.06); }
.pa-root[data-pa-theme='light'] .pa-btn--danger { background: rgba(198, 40, 40, 0.12); color: #b3261e; }

.pa-field {
  width: 100%;
  border: 1px solid var(--pa-line-2);
  background: rgba(255, 255, 255, 0.035);
  border-radius: 10px;
  padding: 9px 11px;
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--pa-text);
  outline: none;
  transition: border-color 120ms ease, background 120ms ease;
}
.pa-field:focus { border-color: rgba(255, 159, 10, 0.55); background: rgba(255, 255, 255, 0.05); }
.pa-field::placeholder { color: var(--pa-text-4); }
.pa-label { display: block; font-size: calc(11px + var(--pa-font-delta)); color: var(--pa-text-3); margin: 0 0 6px; }

/* ---------- PaSelect：自绘下拉 ----------
 * 原生 select 的 option 弹层由浏览器渲染，CSS 完全碰不到（永远白底 + 系统蓝高亮 + 方角），
 * 所以界面里所有「选一个」的地方统一用这个自绘控件。
 * 弹层由 JS portal 到 .pa-root 并用 position: fixed 定位（见 shared/PaSelect.tsx），
 * 这里只负责长什么样，不负责在哪。 */
.pa-select { position: relative; width: 100%; min-width: 0; }
button.pa-select__trigger {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--pa-line-2);
  border-radius: 9px;
  background: var(--pa-card-2);
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  cursor: pointer;
  outline: none;
  transition: border-color 120ms ease, background 120ms ease;
}
button.pa-select__trigger:hover { background: var(--pa-card-3); }
button.pa-select__trigger:focus-visible { border-color: var(--pa-accent); }
button.pa-select__trigger[data-open='true'] { border-color: var(--pa-accent); background: var(--pa-card-3); }
button.pa-select__trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.pa-select__value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-select__value[data-empty='true'] { color: var(--pa-text-3); }
.pa-select__chevron { flex: none; display: inline-flex; color: var(--pa-text-3); transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1); }
button.pa-select__trigger[data-open='true'] .pa-select__chevron { transform: rotate(180deg); }

/* 弹层：portal 到 .pa-root，坐标由 JS 用 fixed 算，所以这里只写外观。
 * z-index 要高于面板里的所有浮层（弹窗 40 / 通话弹层 70 / 侧栏抽屉 120 / 最高 1200），
 * 但低于 .pa-root 自身与 toast 家族（2147483000+）。 */
.pa-select__popup {
  position: fixed;
  z-index: 1300;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px;
  border-radius: 11px;
  border: 1px solid var(--pa-line);
  background: var(--pa-card-2);
  box-shadow: var(--pa-shadow-pop);
  overflow-y: auto;
  overscroll-behavior: contain;
  animation: pa-fade 120ms ease both;
}
.pa-select__popup::-webkit-scrollbar { width: 6px; }
.pa-select__popup::-webkit-scrollbar-thumb { background: var(--pa-line-2); border-radius: 3px; }
/*
 * 浅色主题：--pa-shadow-pop 是深色主题用的硬投影（rgba(0,0,0,.5)），压在浅色面板上
 * 会糊成一圈黑；弹层底色也从 card-2 换成纯白卡片，跟浅灰页面拉开层次。
 */
.pa-root[data-pa-theme='light'] .pa-select__popup {
  background: var(--pa-card);
  box-shadow: 0 16px 44px rgba(15, 17, 21, 0.16), 0 0 0 1px var(--pa-line);
}
.pa-select__option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 7px;
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.35;
  color: var(--pa-text-2);
  cursor: pointer;
  user-select: none;
}
/* hover 与键盘高亮同一套观感：不用系统蓝底白字 */
.pa-select__option[data-active='true'] { background: var(--pa-card-3); color: var(--pa-text); }
.pa-select__option[data-selected='true'] { color: var(--pa-accent); }
.pa-select__option-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pa-select__option-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa-select__option-hint {
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: 1.35;
  color: var(--pa-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-select__option-check { flex: none; display: inline-flex; width: 13px; color: var(--pa-accent); }

/* 尺寸档位：设置行里的小号（和开关/分段控件同高）、表单行里的大号（和 input 同高） */
.pa-select--compact { flex: none; width: auto; min-width: 112px; max-width: 152px; }
.pa-select--compact .pa-select__trigger { height: 28px; padding: 0 8px; border-radius: 8px; font-size: calc(10.5px + var(--pa-font-delta)); }
.pa-select--form .pa-select__trigger { height: 36px; border-radius: 10px; }

/* ---------- 弹窗底座 ---------- */
.pa-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(6px);
  animation: pa-fade 160ms ease both;
  padding: 24px;
}
.pa-modal {
  width: 100%;
  max-width: 520px;
  max-height: calc(100vh - 80px);
  overflow: auto;
  background: #1d1e21;
  border-radius: 16px;
  box-shadow: var(--pa-shadow-pop);
  animation: pa-pop 200ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
  color: var(--pa-text);
}
.pa-root[data-pa-theme='light'] .pa-modal { background: #ffffff; }

/* ---------- Toast ---------- */
/*
 * 底色不能写死深色：浅色主题下 --pa-text 是近黑（#14161a），压在这个
 * rgba(20,21,23,.92) 上就是黑底黑字（实测对比度约 1.2:1，完全读不出来）。
 * 深色 / 浅色各给一套底色，文字统一用主题变量，才叫「跟主题同步」。
 *
 * 另外三点：
 *  · 动画用 pa-rise-center：pa-rise 的 keyframes 只写 translateY，会在动画期间
 *    把这里的 translateX(-50%) 覆盖掉，toast 会从屏幕中线开始往右跑。
 *  · 长文案（报错经常是四五十字）不能 nowrap，否则撑成一条超过视口的横条；
 *    限宽 + 自动换行 + 居中，长句也能完整读完。
 *  · 圆角从 999px 改成 12px：多行时胶囊形会变成两头圆的大块，12px 更稳。
 */
.pa-toast {
  position: absolute;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 80;
  box-sizing: border-box;
  width: max-content;
  max-width: min(640px, calc(100% - 48px));
  background: rgba(38, 39, 42, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: var(--pa-text);
  font-size: calc(12px + var(--pa-font-delta));
  line-height: 1.55;
  padding: 9px 16px;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
  animation: pa-rise-center 220ms ease both;
  pointer-events: none;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: center;
}
.pa-root[data-pa-theme='light'] .pa-toast {
  background: rgba(255, 255, 255, 0.98);
  border-color: var(--pa-line-2);
  color: var(--pa-text);
  box-shadow: 0 10px 30px rgba(15, 17, 21, 0.16);
}

/* ---------- 动画 ---------- */
@keyframes pa-rise {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes pa-rise-center {
  from { opacity: 0; transform: translate(-50%, 14px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
@keyframes pa-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.975); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes pa-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes pa-typing {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
  30% { transform: translateY(-3px); opacity: 1; }
}
@keyframes pa-pulse {
  0% { transform: scale(1); opacity: 0.55; }
  70% { transform: scale(1.45); opacity: 0; }
  100% { transform: scale(1.45); opacity: 0; }
}
@keyframes pa-spin {
  to { transform: rotate(360deg); }
}
@keyframes pa-shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}

.pa-fade-in { animation: pa-fade 180ms ease both; }
.pa-rise-in { animation: pa-rise 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }

@media (max-width: 1000px) {
  .pa-sidebar { width: 220px; flex-basis: 220px; }
  /*
   * 窄侧栏（220px）放不下「鲸鱼 + deepseek + HARNESS + 收起按钮」整行
   * （实测需要约 234px），只留鲸鱼 mark —— 与官方折叠态的 railMark 同一处理。
   */
  .pa-brand__wordmark { display: none; }
}
@media (max-width: 780px) {
  .pa-sidebar { position: absolute; z-index: 30; height: 100%; box-shadow: 0 20px 60px rgba(0,0,0,.45); transform: translateX(-100%); transition: transform 200ms ease; }
  .pa-root[data-mobile-sidebar='true'] .pa-sidebar { transform: translateX(0); }
}
`

let injected = false

/** 幂等注入基础样式；返回是否本次真正插入。 */
export function injectPersonalBaseStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-base-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-base-styles'
  style.textContent = PERSONAL_BASE_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function personalBaseInjected(): boolean {
  return injected
}
