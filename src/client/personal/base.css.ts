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
  /*
   * 兜底底色用 --pa-main（对话区色）而不是 --pa-bg（更深的 #141517）：
   *
   * 切模式时 .pa-root 从 display:none 重新显示，主列 / 侧栏的页面转场会从
   * opacity:0 播 240ms。这 240ms 里透出来的就是这层底色 —— 旧值比正常界面
   * 深一档，于是「Work 切 Bot」会先暗一下再亮起来，用户看到的就是「闪一下」。
   * 改成与主区同色后，透出的是同色底，淡入过程不可见；位移期间顶部露出的
   * 10px 带子也是同色，不会出现色带。
   *
   * --pa-bg 变量本身保留（独立演示页等地方还在用），只换这里的兜底色。
   */
  background: var(--pa-main);
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
/*
 * Work 模式：Personal App 常驻 DOM 但不参与渲染 —— 直接用 body 的 data-skb-mode
 * 属性控制显隐。切换模式时属性和 CSS 同步生效，不经过 React 的重新挂载，
 * 因此不会出现「官方侧栏已让位、Bot 侧栏还没挂出来」的空白帧。
 * data-force-mode 是独立演示页（forceMode）的豁免：它不跟随 body 模式。
 */
body[data-skb-mode='work'] .pa-root:not([data-force-mode='true']) { display: none !important; }
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
  /*
   * 分隔线用内阴影画，不用 border-right：border 会占掉 1px 内容宽度，导致
   * Bot 侧栏的品牌行、收起按钮、模式分段比 Work 模式整体左移 1px（Work 的
   * 官方侧栏没有 border，分隔线画在 frame 的 grid 上）。换成 inset 阴影后
   * 两边内容宽度完全一致，切换模式时这些元素不会「跳一下」。
   */
  box-shadow: inset -1px 0 0 var(--pa-line);
  position: relative;
  /* 收起 / 展开与官方侧栏同一节奏（官方收口 150ms）。 */
  transition: width 160ms cubic-bezier(0.22, 0.8, 0.24, 1), flex-basis 160ms cubic-bezier(0.22, 0.8, 0.24, 1);
}
/*
 * 右边缘拖拽手柄（2026-11-03 用户反馈「左侧侧边栏无法拖拽」）。
 *
 * 8px 热区压在分隔线上，悬停 / 拖拽时亮一条发丝线提示可拖；拖动期间关掉
 * .pa-sidebar 的宽度过渡，让边缘跟手（逻辑见 shell/Sidebar.tsx 的 startResize）。
 * 折叠态（64px 图标轨道）不显示：那个宽度不是用户拖出来的值。
 */
.pa-sidebar__resizer {
  position: absolute;
  right: -4px;
  top: 0;
  bottom: 0;
  width: 8px;
  z-index: 4;
  cursor: col-resize;
  background: transparent;
}
.pa-sidebar__resizer::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: transparent;
  transition: background 120ms ease;
}
.pa-sidebar__resizer:hover::after,
body[data-pa-sidebar-resizing='true'] .pa-sidebar__resizer::after {
  background: var(--pa-line-2);
}
.pa-sidebar[data-collapsed='true'] .pa-sidebar__resizer { display: none; }
/* 拖拽中：侧栏宽度不做补间（否则边缘慢半拍），并禁止选中文字。 */
body[data-pa-sidebar-resizing='true'] .pa-sidebar {
  transition: none;
}
body[data-pa-sidebar-resizing='true'] {
  cursor: col-resize;
  user-select: none;
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
  /* 与 Work 模式官方品牌行同色：官方用 --dsw-alias-label-primary，宿主里
     两边取到同一个值；独立演示页没有宿主变量时才回退 Bot 主题的 --pa-text。 */
  color: var(--dsw-alias-label-primary, var(--pa-text));
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
/* 选择器带 .pa-root 前缀：文件顶部的 .pa-root button 重置（0,1,1）会把
   单纯的 .pa-sidebar-toggle（0,1,0）的 color 压成 inherit，图标颜色就跟着
   父级走、和 Work 模式官方按钮的 label-secondary 不一致了。 */
.pa-root .pa-sidebar-toggle {
  width: 28px;
  height: 28px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  /* 与 Work 模式官方 .hHd-Xa_iconButton 同色（label-secondary）；
     独立演示页没有宿主变量时回退 Bot 主题。 */
  color: var(--dsw-alias-label-secondary, var(--pa-text-2));
  transition: background 120ms ease, color 120ms ease;
}
.pa-root .pa-sidebar-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 132, 140, 0.16));
  color: var(--dsw-alias-label-primary, var(--pa-text));
}
.pa-root .pa-sidebar-toggle:active { transform: scale(0.96); }
/* 折叠态顶部：鲸鱼 mark 即展开入口（与官方 rail 的 railMark 一致），hover 换面板图标。 */
.pa-root .pa-sidebar-toggle--rail {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  /* 官方折叠态 .hHd-Xa_collapsed .hHd-Xa_iconButton 用 label-primary。 */
  color: var(--dsw-alias-label-primary, var(--pa-text));
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
  position: relative;
  display: flex;
  gap: 3px;
  margin: 8px 14px 12px;
  padding: 4px;
  border-radius: 13px;
  background: #2a2b2e;
  flex: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.035);
}
/*
 * 选中块改成独立滑块（2026-11-04 用户要求 Work ⇄ Bot 有左右滑动动效）。
 *
 * 旧实现是给 [data-on='true'] 的按钮直接上背景，只能淡入淡出、没有位移。
 * 现在与官方 .skb-seg 同构：一枚绝对定位的 thumb 承载高亮，按钮只负责文字。
 * Bot 是第二段，所以静态位置在右端；切到 Bot 时由 index.ts 的
 * playThumbSlide('bot') 用 WAAPI 从 Work 端滑过来（跨控件接力，见那里的注释）。
 *
 * will-change / backface-visibility：让滑块单独一层交给合成器，切换瞬间整页
 * 正在做大布局（.pa-root display:none → flex），不提升的话滑动容易掉帧。
 */
.pa-mode-seg__thumb {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc(50% - 5.5px);
  box-sizing: border-box;
  border-radius: 10px;
  background: #0b0b0c;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  pointer-events: none;
  transform: translateX(calc(100% + 3px));
  will-change: transform;
  backface-visibility: hidden;
}
.pa-root[data-pa-theme='light'] .pa-mode-seg { background: #dfe2e7; box-shadow: none; }
.pa-root[data-pa-theme='light'] .pa-mode-seg__thumb {
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
/* 与 Work 模式官方 .skb-seg__btn 的浅色 hover 同值（#14161a）；不加的话
   继承深色主题的 #d8dade，在浅色槽上几乎看不见，两个模式手感不一致。 */
.pa-root[data-pa-theme='light'] .pa-mode-seg button:hover { color: #14161a; }
.pa-mode-seg button {
  position: relative;
  z-index: 1;
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
  /*
   * 与 Work 模式的 .skb-seg__btn 用同一个字号源：两边都直接读
   * --dsh-content-font-size（落在 Bot 里就是 --pa-font-size）。此前 Bot 用
   * calc(14px + delta)、Work 写死 14px，通用字号 15px 时 Bot 是 16px、Work 是
   * 14px，切换模式这一排文字会跳（用户 2026-11-03「切换不要一闪」包含这类
   * 跳动）。分段是模式切换器本身，两个模式的同一控件必须同字号。
   */
  font-size: var(--pa-font-size);
  font-weight: 500;
  letter-spacing: 0.01em;
  color: #a1a4aa;
  transition: color 150ms ease;
}
.pa-mode-seg button:hover { color: #d8dade; }
/* 选中态只改文字色：高亮块由 .pa-mode-seg__thumb 承载（2026-11-04）。 */
.pa-mode-seg button[data-on='true'] { color: #ffffff; }
.pa-root[data-pa-theme='light'] .pa-mode-seg button[data-on='true'] { color: #14161a; }

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
/* 本地导入的图片头像：圆形裁切，盖满整块（SVG 造型只在没有图片时用）。 */
.pa-avatar__image {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
/*
 * 三态透明 WebP 动图（2026-11-05，Bot 右栏资料区）。
 *
 * 动图是透明底，不能再套圆形裁切 / 矩形底色：那会在人物周围露出一个圆角方块
 * （与 Work 卡头同一个坑）。用 contain 保住完整构图，投影改用 filter: drop-shadow
 * ——它按像素 alpha 描边，只给人物轮廓一层柔光，透明区仍透出侧栏背景。
 */
.pa-avatar--motion {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pa-avatar__motion {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  user-select: none;
  -webkit-user-drag: none;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, .28));
}
.pa-root[data-pa-theme='light'] .pa-avatar__motion {
  filter: drop-shadow(0 4px 10px rgba(60, 110, 170, .22));
}
/*
 * 深色主题：透明底动图直接贴在深色侧栏上时，深蓝头发 / 藏青裙装会融进底色，
 * 看起来像人物被调成了半透明（2026-11-05 用户反馈）。给一个到 72% 就全透明的
 * 冷色径向光托底 + 轻微提亮，既保住透明背景，也让人物从深底里立起来。
 */
.pa-root[data-pa-theme='dark'] .pa-avatar--motion {
  background: radial-gradient(circle at 50% 56%, rgba(206, 230, 255, .20) 0%, rgba(206, 230, 255, .07) 48%, rgba(206, 230, 255, 0) 72%);
  border-radius: 50%;
}
.pa-root[data-pa-theme='dark'] .pa-avatar__motion {
  filter: brightness(1.12) saturate(1.06) contrast(1.03) drop-shadow(0 4px 12px rgba(0, 0, 0, .5));
}

/* ---------- 头像选择器（新建 Bot / 群聊、设置卡共用） ---------- */
.pa-avatar-picker {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  min-width: 0;
}
.pa-avatar-picker__preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: none;
}
.pa-avatar-picker__actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: center;
}
.pa-avatar-picker__file { display: none; }
.pa-avatar-picker__choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.pa-avatar-picker__row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pa-avatar-picker__shape {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  transition: background 120ms ease, border-color 120ms ease;
}
.pa-avatar-picker__shape:hover { background: rgba(128, 132, 140, 0.14); }
.pa-avatar-picker__shape[data-on='true'] {
  border-color: var(--pa-accent);
  background: rgba(255, 159, 10, 0.12);
}
.pa-avatar-picker__color {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
  transition: transform 120ms ease, border-color 120ms ease;
}
.pa-avatar-picker__color:hover { transform: scale(1.12); }
.pa-avatar-picker__color[data-on='true'] { border-color: var(--pa-text); }
.pa-avatar-picker__error {
  margin: 0;
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-red);
}
.pa-avatar-picker__reset { margin-top: 6px; align-self: flex-start; }
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
/* 分区标题（可折叠手风琴头）：整行都是点击热区，右侧箭头指示展开 / 收起。
 * 选择器带 .pa-root 是为了压过文件顶部的 .pa-root button 重置（0,1,1）——
 * 不带的话 padding 被清成 0、颜色退回 inherit，标题会贴边并失去层级感。 */
.pa-root .pa-sec-title {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 12px 8px 5px;
  font-size: calc(10.5px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pa-text-4);
  user-select: none;
  transition: color 120ms ease;
}
.pa-root .pa-sec-title:hover { color: var(--pa-text-2); }
.pa-sec-title__chevron {
  flex: none;
  color: inherit;
  transition: transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
/* 展开时箭头朝下，收起时朝右——和文件树 / 手风琴的通用约定一致。 */
.pa-sec-title[data-collapsed='false'] .pa-sec-title__chevron { transform: rotate(90deg); }
.pa-sec-title[data-collapsed='true'] .pa-sec-title__chevron { transform: rotate(0deg); }


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
/*
 * 新回复提示（明显但克制）：左侧一条强调色竖条 + 行底色极淡的橙 + 摘要升一档颜色。
 * 三处单看都很轻，叠起来在侧栏里一眼就能扫到「这个会话刚回了话」；不抢名字的
 * 注意力，也不像红点那样像报警。读掉即消失（切进会话就写 ui.readAt）。
 */
.pa-bot-row[data-unread='true']::before {
  content: '';
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 2.5px;
  border-radius: 0 2px 2px 0;
  background: var(--pa-accent);
}
.pa-bot-row[data-unread='true'] { background: rgba(255, 159, 10, 0.055); }
.pa-root[data-pa-theme='light'] .pa-bot-row[data-unread='true'] { background: rgba(255, 159, 10, 0.09); }
.pa-bot-row[data-unread='true'] .pa-bot-row__summary { color: var(--pa-text-2); }
.pa-bot-row__body { flex: 1; min-width: 0; }
.pa-bot-row__line1 { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.pa-bot-row__name { font-size: calc(12.5px + var(--pa-font-delta)); font-weight: 600; color: var(--pa-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%; flex: 0 1 auto; }
.pa-bot-row__role { font-size: calc(9.5px + var(--pa-font-delta)); color: var(--pa-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.pa-bot-row__summary { font-size: calc(10.5px + var(--pa-font-delta)); color: var(--pa-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.pa-bot-row[data-selected='true'] .pa-bot-row__summary { color: var(--pa-text-2); }
/* 行右上角的最新时间：会话列表里「谁最近说过话」的扫读锚点。
 * 放在名字行最右端（IM 惯例）；hover 时淡出，把位置让给行尾的「更多」按钮
 * （那个按钮是绝对定位盖在行右端的，不淡出会和时间叠在一起）。 */
.pa-bot-row__time {
  margin-left: auto;
  flex: none;
  font-size: calc(9.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  transition: opacity 120ms ease;
}
.pa-bot-row:hover .pa-bot-row__time { opacity: 0; }
/* 置顶标记：名字后面一个小图钉。颜色比名字淡一档——它只回答「这行为什么排在
 * 前面」，不该和名字抢注意力；align-self 覆盖 line1 的 baseline 对齐，否则
 * 图标会贴着文字基线往下沉。 */
.pa-bot-row__pin {
  flex: none;
  display: inline-flex;
  align-items: center;
  align-self: center;
  color: var(--pa-text-4);
}
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
  animation: pa-fade 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
  animation: pa-fade 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
  animation: pa-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
  animation: pa-rise-center 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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

/* ---------- 音量滑条（通话弹层 / 会话头自动播报浮层共用） ----------
 * 用**粗细**表达音量：已选段（当前音量）粗 10px、未选段细 4px，两段都保持单色
 * （此前已按用户要求去掉填充色）。悬停 / 聚焦 / 拖动时两段一起加粗一档
 * （13 / 6），「正在调音量」这件事也画出来，但粗细对比始终保留。
 *
 * 几何对齐：圆点 14px → 中心可移动区间左右各内缩 7px。自绘轨道用同样的内缩
 * （见 .pa-vs__track 的 left/right），百分比才与 range 数值一一对应。改圆点
 * 尺寸时三处一起改：thumb 宽高、track 内缩、margin-top。
 * 颜色 / 底色由使用方通过 --pa-vs-color / --pa-vs-rest / --pa-vs-surface 指定。
 */
.pa-vs {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  height: 20px;
  display: flex;
  align-items: center;
}
.pa-vs__track {
  position: absolute;
  left: 7px;
  right: 7px;
  top: 50%;
  height: 20px;
  transform: translateY(-50%);
  pointer-events: none;
}
/* 已选段：粗 */
.pa-vs__fill {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: var(--pa-vs-fill, 0%);
  height: 10px;
  border-radius: 999px;
  background: var(--pa-vs-color, var(--pa-text));
  transition: height 140ms ease;
}
/* 未选段：细（fill 到 100% 时宽度归零，不会画出半截圆头） */
.pa-vs__rest {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: calc(100% - var(--pa-vs-fill, 0%));
  height: 4px;
  border-radius: 999px;
  background: var(--pa-vs-rest, var(--pa-line-2));
  transition: height 140ms ease;
}
/* 真 range 叠在上层：轨道透明（视觉在下面两段），只保留圆点 */
.pa-vs__input {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 20px;
  margin: 0;
  padding: 0;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
  outline: none;
}
.pa-vs__input::-webkit-slider-runnable-track {
  height: 20px;
  background: transparent;
}
/* 圆点：实心 + 一圈所在表面的底色（挖空环），压在粗细交界处不会糊成一块 */
.pa-vs__input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: 3px; /* (20 - 14) / 2 */
  border-radius: 50%;
  background: var(--pa-vs-color, var(--pa-text));
  box-shadow: 0 0 0 2px var(--pa-vs-surface, var(--pa-card)), 0 1px 3px rgba(0, 0, 0, 0.28);
  transition: transform 120ms ease, box-shadow 140ms ease;
}
.pa-vs__input:hover::-webkit-slider-thumb { transform: scale(1.12); }
.pa-vs__input:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 2px var(--pa-vs-surface, var(--pa-card)), 0 0 0 4px rgba(255, 159, 10, 0.32);
}
/* Firefox：track / progress / thumb 三个伪元素都要显式重置，否则冒出系统高亮色 */
.pa-vs__input::-moz-range-track {
  height: 20px;
  background: transparent;
  border: 0;
}
.pa-vs__input::-moz-range-progress {
  height: 20px;
  background: transparent;
}
.pa-vs__input::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 0;
  border-radius: 50%;
  background: var(--pa-vs-color, var(--pa-text));
  box-shadow: 0 0 0 2px var(--pa-vs-surface, var(--pa-card)), 0 1px 3px rgba(0, 0, 0, 0.28);
}
/* 悬停 / 键盘聚焦 / 拖动：两段一起加粗一档，粗细对比保留 */
.pa-vs:hover .pa-vs__fill,
.pa-vs:focus-within .pa-vs__fill,
.pa-vs:active .pa-vs__fill { height: 13px; }
.pa-vs:hover .pa-vs__rest,
.pa-vs:focus-within .pa-vs__rest,
.pa-vs:active .pa-vs__rest { height: 6px; }
@media (prefers-reduced-motion: reduce) {
  .pa-vs__fill,
  .pa-vs__rest,
  .pa-vs__input::-webkit-slider-thumb { transition: none; }
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

.pa-fade-in { animation: pa-fade 300ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.pa-rise-in { animation: pa-rise 300ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }

/* ───────────────────────── 浮层退场（closing 态） ───────────────────────── */
/*
 * 关闭时先播 240ms 退场再真正卸载，避免条件渲染一置 null 就硬消失。
 * 只挂在最外层（遮罩 / 弹层根）上，卡片用后代选择器跟随——组件侧只改一处
 * data-closing，不会出现「遮罩淡出了、卡片还在」的错位。
 *
 * 时长与曲线跟 src/client/modal-animation.ts 的 MODAL_ANIM_MS 对齐（240ms、
 * 出场用加速曲线 cubic-bezier(0.4, 0, 0.2, 1)，遮罩用 ease），整套插件同一套手感。
 * 这里的选择器优先级高于入场规则，退场时只有退场动画在跑，两套动画不会打架。
 */
@keyframes pa-overlay-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes pa-modal-out {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(14px) scale(0.97); }
}
/* 下拉弹层（popover）：向右 10px 滑出。 */
@keyframes pa-select-pop-out {
  from { opacity: 1; transform: translateX(0) scale(1); }
  to { opacity: 0; transform: translateX(10px) scale(0.97); }
}
/* toast：向下退场，translateX(-50%) 必须保留，否则会从屏幕中线跳开。 */
@keyframes pa-toast-out {
  from { opacity: 1; transform: translate(-50%, 0) scale(1); }
  to { opacity: 0; transform: translate(-50%, 10px) scale(0.97); }
}
.pa-overlay[data-closing='1'] { animation: pa-overlay-out 260ms ease both; }
.pa-overlay[data-closing='1'] .pa-modal { animation: pa-modal-out 260ms cubic-bezier(0.4, 0, 0.2, 1) both; }
.pa-select__popup[data-closing='1'] { animation: pa-select-pop-out 260ms cubic-bezier(0.4, 0, 0.2, 1) both; }
.pa-toast[data-closing='1'] { animation: pa-toast-out 260ms cubic-bezier(0.4, 0, 0.2, 1) both; }

@media (prefers-reduced-motion: reduce) {
  /* 退场规则比入场规则更具体，必须连 [data-closing] 一起列进来才压得住。 */
  .pa-overlay[data-closing='1'],
  .pa-overlay[data-closing='1'] .pa-modal,
  .pa-select__popup[data-closing='1'],
  .pa-toast[data-closing='1'] { animation: none; }
}

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
  const existing = document.getElementById('pa-base-styles')
  if (existing !== null) {
    /*
     * live reload：节点已在，但样式内容可能来自旧 bundle。只认 id 直接返回
     * 会让开发时改的 CSS 永远不生效（实测改完颜色必须手动刷整个页面），
     * 这里顺手把 textContent 对齐到当前 bundle。内容相同则不动，保持幂等。
     */
    if (existing.textContent !== PERSONAL_BASE_CSS) existing.textContent = PERSONAL_BASE_CSS
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
