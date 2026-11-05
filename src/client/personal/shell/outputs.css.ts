/**
 * dsh-seeker-bot — 右栏「产出物」卡、分类 tab、定时任务区与预览弹层样式。
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
/* ── 右栏顶部：Bot 资料区 ─────────────────────────────────────────────
 * 用户口径（2026-11-04 澄清）：分类 tab 的「三分之一」是高度位置，不是宽度。
 * 资料区撑到面板约 30%（tab 条顶部因此落在 1/3 高度附近），自上而下是：
 * 居中头像 + 右下编辑铅笔 + 名称。「关闭右栏」仍在右上角。 */
.pa-right .pa-right__profile {
  position: relative;
  flex: none;
  min-height: clamp(230px, 30vh, 340px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 34px 16px 16px;
  overflow: hidden;
}
/* 群聊：成员网格在上、大头像在下，从顶部往下排。
 * 私聊不挂 data-room，仍是原来的居中「大头像 + 名称」。
 * padding-top 44px 而不是 34px：右上角「关闭右栏」按钮占 10–38px，第一行头像
 * 从 34px 起会被按钮压住右上角 4px，抬高 10px 让两者彻底分开。 */
.pa-right .pa-right__profile[data-room='true'] {
  justify-content: flex-start;
  gap: 18px;
  padding-top: 44px;
}
/* ── 群聊成员网格（2026-11-05） ─────────────────────────────────────
 * 用户要求「bot 群聊在右侧侧边栏的动图上面增加类似微信这种，但是头像是圆形的」。
 * 5 列等分、头像圆形、名字在下方，最后一格是添加按钮。
 *
 * **区域感**（2026-11-05 用户反馈「有一个巨大的问题没有区域感」）：成员网格不能
 * 裸铺在面板上，否则会和下方的大头像糊成一片。这里给它一块独立的圆角浅色底
 * （--pa-card-2，深浅主题各自适配）+ 一行「群成员 / N 个」小标题，和下面的
 * Bot 资料区用 18px 间距隔开——一眼就能看出「这是群成员，那是当前 Bot」。
 *
 * 高度只留两行（64 × 2 + 14 = 142px）：成员再多就在网格内部滚动，不把资料区
 * 撑高、也不把下面的头像动图与分类 tab 推出面板。右栏最窄 240px 时列宽约 39px，
 * 头像用 width:100% + max-width 跟着列宽缩小，不会挤破格子。 */
.pa-right .pa-right__members-card {
  width: 100%;
  max-width: 284px;
  flex: none;
  padding: 10px 10px 8px;
  border-radius: 14px;
  background: var(--pa-card-2);
}
.pa-right .pa-right__members-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px 8px;
  font-size: calc(11px + var(--pa-font-delta));
  line-height: 1.2;
  color: var(--pa-text-3);
  user-select: none;
}
.pa-right .pa-right__members-head b {
  font-weight: 600;
  color: var(--pa-text-2);
}
.pa-right .pa-right__members {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px 6px;
  /* 统一成员格的字号（名字行高由它决定）；两行封顶的高度用 em 联动字号设置，
   * 用户把通用字号调大时不会出现「第二行被裁一半」。默认字号下：
   * 单格 49px + 1.3em(≈15px) = 64px，两行 64×2 + 14 = 142px。 */
  font-size: calc(10.5px + var(--pa-font-delta));
  max-height: calc(112px + 2.6em);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0;
  scrollbar-width: thin;
}
.pa-right .pa-right__members::-webkit-scrollbar { width: 4px; }
.pa-right .pa-right__members::-webkit-scrollbar-thumb {
  background: rgba(128, 132, 140, 0.3);
  border: 0;
  border-radius: 4px;
}
.pa-root .pa-right__member {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: calc(49px + 1.3em);
  min-width: 0;
  padding: 0;
  border-radius: 10px;
  color: var(--pa-text-2);
  transition: background 120ms ease;
}
.pa-root .pa-right__member:hover { background: rgba(128, 132, 140, 0.1); }
.pa-root .pa-right__member:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 1px;
}
.pa-right .pa-right__member-avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: 44px;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  overflow: hidden;
  /* 圆底用 --pa-card（浅色纯白 / 深色更深一档）：与成员卡的 --pa-card-2 形成
   * 一亮一暗的层次，没有上传头像的 Bot 也能看出「这是一个圆形头像位」。 */
  background: var(--pa-card);
  box-shadow: inset 0 0 0 1px rgba(128, 132, 140, 0.18);
  color: var(--pa-text-2);
}
/* BotAvatar 自带固定 px 尺寸（inline style），这里让它填满圆形底：
 * 上传照片会自带 50% 圆角，SVG 造型则缩小到圆内，外圈始终是一个正圆。 */
.pa-right .pa-right__member-avatar > .pa-avatar {
  width: 100% !important;
  height: 100% !important;
}
.pa-right .pa-right__member-name {
  display: block;
  width: 100%;
  min-height: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: inherit;
  line-height: 1.3;
  color: var(--pa-text-3);
}
.pa-right .pa-right__member-avatar--add {
  background: transparent;
  border: 1.4px dashed rgba(128, 132, 140, 0.46);
  box-shadow: none;
  color: var(--pa-text-3);
  transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
}
.pa-root .pa-right__member--add:hover .pa-right__member-avatar--add {
  border-color: var(--pa-accent);
  background: rgba(255, 159, 10, 0.08);
  color: var(--pa-accent);
}
.pa-right .pa-right__profile-main {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  min-width: 0;
  max-width: 100%;
}
.pa-right .pa-right__avatar-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  margin-bottom: 2px;
}
/* 编辑铅笔：压在头像右下角，用面板底色描一圈，避免和头像贴死。 */
.pa-root .pa-right__edit-btn {
  position: absolute;
  right: -2px;
  bottom: 1px;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--pa-right);
  border-radius: 50%;
  background: var(--pa-card-3);
  color: var(--pa-text-2);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.24);
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
}
.pa-root .pa-right__edit-btn:hover {
  background: var(--pa-card-2);
  color: var(--pa-text);
  transform: translateY(-1px);
}
.pa-root .pa-right__edit-btn:active { transform: scale(0.94); }
.pa-root .pa-right__edit-btn:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 1px;
}
.pa-root[data-pa-theme='light'] .pa-right__edit-btn {
  background: #ffffff;
  box-shadow: 0 1px 4px rgba(15, 17, 21, 0.16);
}
.pa-root .pa-right__profile-close {
  position: absolute;
  top: 10px;
  right: 12px;
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
.pa-root .pa-right__profile-close:hover {
  background: rgba(128, 132, 140, 0.26);
  color: var(--pa-text);
}
.pa-root .pa-right__profile-close:active { transform: scale(0.94); }
.pa-root .pa-right__profile-close:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 1px;
}
.pa-right .pa-right__profile-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(16.5px + var(--pa-font-delta));
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: 0.01em;
  color: var(--pa-text);
}
/* 右栏滚动区沿用 shell.css.ts 的块级布局（padding: 2px 16px 26px）；
 * 卡间距由两张卡各自的 margin-top 负责 —— 产出物卡与任务记录卡统一 10px，
 * 不在这里加 flex gap，否则任务卡自带的 margin-top 会叠成 20px。 */

/* ── 右栏分类 tab：分段控件（2026-11-04 修正） ───────────────────────
 * 用户澄清：「三分之一」指的是 tab 条落在面板约 1/3 高度处（由上方资料区撑出），
 * 不是 tab 条宽度。参考图是一条接近内容区全宽的圆角浅色 track：两段等分，
 * 选中段为浅色凸起 pill（深色 --pa-card-3；浅色白底 + 轻阴影），不是文字下划线。 */
.pa-right .pa-right__tabs {
  position: relative;
  flex: none;
  display: flex;
  align-items: stretch;
  justify-content: flex-start;
  gap: 3px;
  width: auto;
  margin: 0 16px;
  padding: 3px;
  border: 0;
  border-radius: 12px;
  background: rgba(128, 132, 140, 0.12);
}
/*
 * 选中滑块（2026-11-04 用户要求「动态 / 产出物」也有左右滑动动效）。
 *
 * 与侧栏 Work ⇄ Bot 分段同一套参数：240ms、cubic-bezier(.22,1,.36,1)、
 * 合成层提示。区别是这里用 CSS transition 而不是 WAAPI——tab 条始终可见、
 * 只在一枚控件内位移，不存在跨界面接力，React 改 data-tab 就能平滑补间。
 *
 * 宽度按包含块（padding box）算：两段各 (100% - 3px gap) / 2，再减去自身
 * 所在的 3px 内边距换算 = 50% - 4.5px；位移到第二段要再跨过 gap。
 */
.pa-right .pa-right__tab-thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc(50% - 4.5px);
  border-radius: 9px;
  background: var(--pa-card-3);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  pointer-events: none;
  transform: translateX(0);
  transition: transform 240ms cubic-bezier(.22, 1, .36, 1);
  will-change: transform;
}
.pa-right .pa-right__tab-thumb[data-tab='outputs'] { transform: translateX(calc(100% + 3px)); }
.pa-root[data-pa-theme='light'] .pa-right__tab-thumb {
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(15, 17, 21, 0.13), 0 0 0 1px rgba(15, 17, 21, 0.04);
}
.pa-root[data-pa-theme='light'] .pa-right .pa-right__tabs {
  background: #eceef2;
}
.pa-root .pa-right__tab {
  position: relative;
  z-index: 1;
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  min-width: 0;
  height: 34px;
  padding: 0;
  border-radius: 9px;
  text-align: center;
  white-space: nowrap;
  font-size: calc(11.5px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text-3);
  transition: color 120ms ease;
}
.pa-root .pa-right__tab:hover { color: var(--pa-text-2); }
/* 选中态只改文字：高亮块由 .pa-right__tab-thumb 承载（2026-11-04）。 */
.pa-root .pa-right__tab[aria-selected='true'] {
  color: var(--pa-text);
  font-weight: 600;
}
.pa-right .pa-right__tab-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
}
/* 分类名不上屏（用户 2026-11-04：「我不要这个文字」）：可见区只有图标，
   名字留在 title / aria-label。 */
.pa-root .pa-right__tab:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: -2px;
  border-radius: 9px;
}

/* 分类面板：承载当前 tab 的内容；错峰序号按面板实际子元素给
 * （ActivityTab 返回 Fragment，它的定时任务区与任务记录就是面板的直接子元素；
 * 产出物 tab 的两张卡同理）。 */
.pa-right .pa-right__panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.pa-right__panel[data-page-motion='stagger'] > :nth-child(1) { --i: 0; }
.pa-right__panel[data-page-motion='stagger'] > :nth-child(2) { --i: 1; }
.pa-right__panel[data-page-motion='stagger'] > :nth-child(3) { --i: 2; }

/* ── 动态 tab：定时任务区 ─────────────────────────────────────────────
 * 参考图上半部分：可折叠的「N scheduled tasks」，行 = 圆角图标块 + 名称 +
 * 频率文案（右侧不挂操作，保持轻量），底部居中「查看全部定时任务」。 */
.pa-routines {
  flex: none;
  display: flex;
  flex-direction: column;
  margin-top: 10px;
  min-width: 0;
  color: var(--pa-text);
}
.pa-root .pa-routines__head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 10px 12px;
  text-align: left;
  color: var(--pa-text-2);
  border-radius: 8px;
  transition: background 120ms ease;
}
.pa-root .pa-routines__head:hover { background: var(--pa-card-2); }
.pa-root .pa-routines__head:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: -2px;
}
.pa-routines__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
}
.pa-routines__caret {
  flex: none;
  display: inline-flex;
  color: var(--pa-text-4);
  transition: transform 150ms ease;
}
.pa-routines[data-open='false'] .pa-routines__caret { transform: rotate(-90deg); }
.pa-routines__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 4px 2px;
  min-width: 0;
}
.pa-routines__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.pa-routines__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 7px 8px;
  border-radius: 10px;
}
.pa-routines__row[data-enabled='false'] { opacity: 0.55; }
.pa-routines__icon {
  flex: none;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--pa-card-2);
  color: var(--pa-text-2);
}
.pa-routines__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pa-routines__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  line-height: 1.35;
  color: var(--pa-text);
}
.pa-routines__freq {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.45;
  color: var(--pa-text-3);
}
.pa-root .pa-routines__all {
  align-self: center;
  margin-top: 2px;
  padding: 6px 10px;
  border-radius: 7px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  transition: color 120ms ease, background 120ms ease;
}
.pa-root .pa-routines__all:hover {
  color: var(--pa-text);
  background: var(--pa-card-2);
}
.pa-root .pa-routines__all:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .pa-routines__caret { transition: none; }
  .pa-right__tab { transition: none; }
  .pa-right__tab-thumb { transition: none; }
  .pa-right__edit-btn { transition: none; }
  .pa-right__edit-btn:hover { transform: none; }
}

/* ── 产出物卡 ─────────────────────────────────────────────────────── */
/* 2026-11-04 用户要求：Bot 右栏卡片去外框 —— 去掉背景、边框、圆角与阴影
 * （本块原本没有阴影），让页面卡 / 产出物卡直接融进右栏底色。
 * padding 与 margin 保留：外框去掉后，这圈内距仍是卡头、文件行与右栏边缘
 * 之间的呼吸空间，也保证与任务记录卡的横向对齐。 */
.pa-out-card {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin-top: 10px;
  padding: 10px 12px;
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

/* 分类选择器：卡头下面的 chip 行，挑一类只显示那一类。
 * 两类以上才出现；横向可滚动，窄栏里也不换行撑高卡片。 */
.pa-out-filter {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 0 2px 1px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.pa-root .pa-out-filter__chip {
  flex: none;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--pa-line);
  border-radius: 999px;
  background: transparent;
  font-size: calc(10px + var(--pa-font-delta));
  line-height: 22px;
  color: var(--pa-text-3);
  white-space: nowrap;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.pa-root .pa-out-filter__chip:hover {
  color: var(--pa-text-2);
  border-color: var(--pa-line-2);
}
.pa-root .pa-out-filter__chip[data-on='true'] {
  color: var(--pa-text);
  font-weight: 600;
  background: var(--pa-card-2);
  border-color: transparent;
}
.pa-root .pa-out-filter__chip:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .pa-out-filter__chip { transition: none; }
}

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
  animation: pa-out-fade 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
  animation: pa-out-pop 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
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
/*
 * 退场：遮罩淡出 + 面板下沉 14px 并轻微缩小。
 *
 * 入场是 160ms 淡入 + 190ms 弹入，出场原来是硬消失（父层 preview 一置 null
 * 这层就被摘掉）。时长与曲线对齐 modal-animation.ts 的 MODAL_ANIM_MS：240ms，
 * 出场用加速曲线（从静止启动、峰值速度结束），与插件其它弹层同一套手感。
 *
 * 页面卡（PagesCard 的 PagePreview）复用同一组 pa-out-preview-* 类，所以这一处
 * 退场同时覆盖「产出物预览」与「页面预览」两个灯箱。
 */
@keyframes pa-out-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes pa-out-away {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(14px) scale(0.97); }
}
.pa-out-preview[data-closing='1'] {
  animation: pa-out-fade-out 240ms ease both;
}
.pa-out-preview[data-closing='1'] .pa-out-preview__panel {
  animation: pa-out-away 240ms cubic-bezier(0.4, 0, 0.2, 1) both;
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
  /* 退场规则带 [data-closing='1']，权重比上面两条高；媒体查询不增加权重，
     不原样再列一遍的话，减少动效偏好下退场动画会照播。 */
  .pa-out-preview[data-closing='1'],
  .pa-out-preview[data-closing='1'] .pa-out-preview__panel { animation: none; }
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
