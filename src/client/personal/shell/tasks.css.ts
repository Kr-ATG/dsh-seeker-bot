/**
 * Personal Agent — 任务记录（card / activity 两种形态）与任务详情卡的样式（组件级）。
 *
 * 两张卡同属「任务」这一族：
 *  · 右栏 `TaskRecordCard` —— 一列任务清单，视觉与 Work 右栏 kr-card 同族，
 *    但类名独立（pa-taskrec-*），不依赖 kr-chat 的样式表；
 *  · 全屏 `TaskDetailModal` —— Work 模式的过程时间线：单栏、每条步骤左侧细线图标 +
 *    灰色小标题 + 正文段落（pa-taskdetail-*）。
 *
 * 颜色一律走 base.css.ts 暴露的 --pa-* 变量；深浅主题都能自动跟随。
 * 注意：本文件是模板字符串，正文与注释里都不能出现反引号。
 */

export const PERSONAL_TASK_CSS = `
/* ═══════════════════════ 任务记录卡（右栏） ═══════════════════════ */

/* 2026-11-04 用户要求：Bot 右栏卡片去外框 —— 去掉背景、边框、圆角与阴影
 * （本块原本没有阴影），任务记录卡直接融进右栏底色。
 * 内距保留：卡片自身没有 padding，卡头的 10px 12px 与展开体的 4px 全部原样
 * 保留，它们是内容与右栏边缘之间唯一的留白；overflow: hidden 也保留，
 * 用于约束内部列表滚动与折叠内容不溢出。 */
.pa-taskrec {
  flex: none;
  margin-top: 10px;
  overflow: hidden;
}

/* 卡头：任务清单图标 +「任务记录」+ 条数 + 折叠箭头。整行可点，点击折叠。 */
/*
 * 卡头 / 任务行 / 关闭钮都是 <button>，必须带 .pa-root 前缀：
 * base.css.ts 的 .pa-root button 重置（0,1,1）会压过裸类名（0,1,0），
 * 把内边距、背景与字号全部清掉。
 */
.pa-root .pa-taskrec__head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 10px 12px;
  text-align: left;
  color: var(--pa-text-2);
  transition: background 120ms ease;
}
.pa-root .pa-taskrec__head:hover { background: var(--pa-card-2); }

.pa-taskrec__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: var(--pa-text-3);
}

.pa-taskrec__title {
  flex: 1;
  min-width: 0;
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
}

.pa-taskrec__meta {
  flex: none;
  font-size: calc(10px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text-4);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.pa-taskrec__caret {
  flex: none;
  display: inline-flex;
  color: var(--pa-text-4);
  transition: transform 150ms ease;
}
.pa-taskrec[data-open='false'] .pa-taskrec__caret { transform: rotate(-90deg); }

/* 展开体：卡片内一条条任务行 */
.pa-taskrec__body {
  border-top: 1px solid var(--pa-line);
  padding: 4px;
}
.pa-taskrec__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/*
 * 每一行：圆角图标块 + 右侧三行（标题 / 摘要 / 时间）。
 *
 * 用户口径（2026-11-02）：「布局按照我给的图片来」——图标装在一块圆角方形
 * 底色里，标题加粗、摘要灰色最多两行、时间单独一行左对齐（不是右端对齐）。
 */
.pa-root .pa-taskrec__row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 9px 8px;
  border-radius: 10px;
  text-align: left;
  transition: background 120ms ease;
}
.pa-root .pa-taskrec__row:hover { background: var(--pa-card-2); }

/* 图标块：参考图里的圆角方形底（34px），图标居中、中性色。 */
.pa-taskrec__icon-box {
  width: 34px;
  height: 34px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--pa-card-2);
  color: var(--pa-text-2);
}

/* 正文列：标题 / 摘要 / 时间。 */
.pa-taskrec__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 1px;
}
.pa-taskrec__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(12.5px + var(--pa-font-delta));
  font-weight: 600;
  line-height: 1.35;
  color: var(--pa-text);
}
.pa-taskrec__summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.45;
  color: var(--pa-text-3);
  word-break: break-word;
}
.pa-taskrec__time {
  font-size: calc(9.5px + var(--pa-font-delta));
  line-height: 1.3;
  color: var(--pa-text-4);
  font-variant-numeric: tabular-nums;
}

/* 按天分组：日期是扫读任务流水的第一个锚点（与参考图一致）。 */
.pa-taskrec__group { display: flex; flex-direction: column; gap: 2px; }
.pa-taskrec__group + .pa-taskrec__group { margin-top: 4px; }
.pa-taskrec__group-label {
  padding: 7px 10px 3px;
  font-size: calc(9.5px + var(--pa-font-delta));
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--pa-text-4);
}

/* 列表限高：30 条也不会把右栏其它卡片挤到视口外，卡内滚动即可。 */
.pa-taskrec__list {
  max-height: min(52vh, 520px);
  overflow-y: auto;
}

.pa-taskrec__empty {
  padding: 8px 10px 12px;
  text-align: center;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.6;
  color: var(--pa-text-4);
}

/* ═══════════════════ 「动态」页 · 任务记录（activity 变体） ═══════════════════
 * 不带「任务记录」卡头：动态 tab 里它接着定时任务往下排，按天分组，
 * 每组标题本身是折叠按钮；行结构复用 pa-taskrec__row，点击仍开任务详情。
 * 不额外套卡片边框，只在与定时任务区相接时画一条发丝线。 */
.pa-taskrec--activity {
  flex: none;
  margin-top: 10px;
  padding: 0;
  min-width: 0;
  overflow: visible;
}
.pa-routines + .pa-taskrec--activity {
  margin-top: 16px;
  padding-top: 4px;
  border-top: 1px solid var(--pa-line);
}
.pa-taskrec--activity .pa-taskrec__list {
  max-height: none;
  overflow: visible;
  padding: 0 4px;
}
.pa-root .pa-taskrec__group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 8px 4px;
  text-align: left;
  color: var(--pa-text-4);
  border-radius: 6px;
  transition: color 120ms ease;
}
.pa-root .pa-taskrec__group-head:hover { color: var(--pa-text-3); }
.pa-root .pa-taskrec__group-head:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: -2px;
}
.pa-taskrec--activity .pa-taskrec__group-label {
  flex: none;
  padding: 0;
  font-size: calc(10px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.03em;
  color: inherit;
}
.pa-taskrec__group-meta {
  margin-left: auto;
  flex: none;
  font-size: calc(9px + var(--pa-font-delta));
  font-weight: 500;
  color: var(--pa-text-4);
  font-variant-numeric: tabular-nums;
}
.pa-taskrec__group-caret {
  flex: none;
  display: inline-flex;
  color: var(--pa-text-4);
  transition: transform 150ms ease;
}
.pa-taskrec__group[data-open='false'] .pa-taskrec__group-caret { transform: rotate(-90deg); }
.pa-taskrec--activity .pa-taskrec__empty {
  padding: 16px 10px 10px;
}
@media (prefers-reduced-motion: reduce) {
  .pa-taskrec__group-caret { transition: none; }
}

/* ═══════════════ 运行中任务 · 实时动作（2026-11-05） ═══════════════
 * 用户口径：「发完消息后，动态里要能实时看到任务的动作进行到哪里」。
 * 数据源是 state.tasks 的 steps（流式事件逐条追加），这里只做展示；
 * 动作一律说人话，原始参数 / 源码默认收起，点开才看。
 * 时长曲线按 S/M 档局部展开 220ms cubic-bezier(0.2, 0.8, 0.2, 1)；
 * 进行中只用低调的呼吸点表达状态，不做虚假完成、不抢高频操作的注意力。 */
.pa-taskrec__item { display: flex; flex-direction: column; min-width: 0; }
.pa-taskrec__item + .pa-taskrec__item { margin-top: 1px; }

.pa-taskrec__live {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.45;
  color: var(--pa-accent);
}
.pa-taskrec__live-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: pa-taskrec-pulse 1.6s ease-in-out infinite;
}
.pa-taskrec__live-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.pa-taskrec__live-meta {
  flex: none;
  color: var(--pa-text-4);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@keyframes pa-taskrec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* 进度：已完成一段实色，末端一枚呼吸点标明「现在在这里」。 */
.pa-taskrec__progress {
  display: block;
  height: 3px;
  margin: 3px 0 1px;
  border-radius: 2px;
  background: var(--pa-card-2);
}
.pa-taskrec__progress-fill {
  position: relative;
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--pa-accent);
  transition: width 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pa-taskrec__progress-fill::after {
  content: '';
  position: absolute;
  right: -3px;
  top: -2.5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pa-accent);
  animation: pa-taskrec-pulse 1.6s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .pa-taskrec__live-dot, .pa-taskrec__progress-fill::after { animation: none; }
  .pa-taskrec__progress-fill { transition: none; }
}

/* ═══════════════════════ 任务详情卡（Work 模式过程时间线） ═══════════════════════ */

/* 固定遮罩：盖住整个视口，点击空白处关闭（由组件判断 target === currentTarget）。 */
.pa-taskdetail-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.6);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  animation: pa-taskdetail-fade 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

/* 居中大卡：宽 min(920px, 94vw)，最大高 82vh；整块内容滚动。 */
.pa-taskdetail-card {
  display: flex;
  flex-direction: column;
  width: min(920px, 94vw);
  max-height: 82vh;
  min-height: 0;
  border-radius: 18px;
  border: 1px solid var(--pa-line-2);
  background: var(--pa-card);
  box-shadow: var(--pa-shadow-pop);
  overflow: hidden;
  animation: pa-taskdetail-rise 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

/* 头部：badge + 任务标题 + 元信息 chips，右上角关闭钮。 */
.pa-taskdetail__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex: none;
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--pa-line);
}
.pa-taskdetail__head-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

/*
 * 状态 badge：参考图是深色胶囊。深色主题反转为深灰底浅字——否则整块发亮，
 * 在暗色卡片里比任务标题还抢眼。
 */
.pa-taskdetail__badge {
  display: inline-flex;
  align-items: center;
  height: 21px;
  padding: 0 9px;
  border-radius: 999px;
  background: var(--pa-text);
  color: var(--pa-card);
  font-size: calc(10px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.02em;
}
.pa-root[data-pa-theme='dark'] .pa-taskdetail__badge {
  background: var(--pa-card-3);
  color: var(--pa-text);
}

.pa-taskdetail__name {
  font-size: calc(16px + var(--pa-font-delta));
  font-weight: 650;
  line-height: 1.35;
  color: var(--pa-text);
  word-break: break-word;
}

/* 元信息 chips：一行 flex-wrap，不占大版面。 */
.pa-taskdetail__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.pa-taskdetail__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 8px;
  border-radius: 7px;
  background: var(--pa-card-2);
  font-size: calc(10px + var(--pa-font-delta));
  line-height: 1.4;
}
.pa-taskdetail__meta-key {
  flex: none;
  color: var(--pa-text-4);
}
.pa-taskdetail__meta-val {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--pa-text-2);
  font-variant-numeric: tabular-nums;
}

.pa-root .pa-taskdetail__close {
  width: 30px;
  height: 30px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--pa-text-3);
  transition: background 120ms ease, color 120ms ease;
}
.pa-root .pa-taskdetail__close:hover {
  background: var(--pa-card-2);
  color: var(--pa-text);
}

/* 主体：单栏过程时间线，整块滚动。 */
.pa-taskdetail__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 24px 22px;
}

/*
 * 时间线：一条条事件纵向排列，靠留白分组（不画连接线、不套卡片）。
 * 与 Work 模式的回合过程一致——读的是「发生了什么」，不是一张仪表盘。
 */
.pa-taskdetail__timeline {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 一条事件：图标 + 灰色小标题一行，下面跟正文段落。 */
.pa-taskdetail__event {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.pa-taskdetail__event-head {
  display: flex;
  align-items: center;
  gap: 7px;
}

/* 事件图标：与标题同高居中；中性色，状态靠形状区分（status-glyph.tsx）。 */
.pa-taskdetail__glyph {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 18px;
  color: var(--pa-text-4);
}

/* 灰色小标题：比正文小一档、低对比，读起来像过程日志的段落头。 */
.pa-taskdetail__event-title {
  flex: 1;
  min-width: 0;
  font-size: calc(11.5px + var(--pa-font-delta));
  font-weight: 500;
  line-height: 1.45;
  color: var(--pa-text-3);
  word-break: break-word;
}

/* 正文：普通段落，比标题亮一档；保留换行（模型的过程说明常分段）。 */
.pa-taskdetail__event-text {
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: 1.75;
  color: var(--pa-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 收尾步骤的失败原因：与失败口径一致，用红色。 */
.pa-taskdetail__event[data-kind='end'][data-status='error'] .pa-taskdetail__event-text {
  color: var(--pa-red);
}

/* 工具步骤：摘要行（整行可点展开）+ 展开后的等宽全文。 */
.pa-taskdetail__tool {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.pa-root .pa-taskdetail__tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  text-align: left;
  color: var(--pa-text-4);
}
.pa-taskdetail__tool-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.5;
  color: var(--pa-text-4);
  transition: color 120ms ease;
}
.pa-taskdetail__tool-toggle {
  flex: none;
  font-size: calc(10px + var(--pa-font-delta));
  color: var(--pa-text-3);
  transition: color 120ms ease;
}
.pa-root .pa-taskdetail__tool-head:hover .pa-taskdetail__tool-summary { color: var(--pa-text-3); }
.pa-root .pa-taskdetail__tool-head:hover .pa-taskdetail__tool-toggle { color: var(--pa-text-2); }
.pa-root .pa-taskdetail__tool-head:focus-visible {
  outline: 2px solid var(--pa-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.pa-taskdetail__tool-body {
  margin: 0;
  padding: 10px 12px;
  max-height: 50vh;
  overflow: auto;
  border: 1px solid var(--pa-line);
  border-radius: 8px;
  background: var(--pa-card-2);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: 1.6;
  color: var(--pa-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 底部「最终回复」：与过程之间用发丝线分开。 */
.pa-taskdetail__reply {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--pa-line);
}
.pa-taskdetail__reply-title {
  margin-bottom: 7px;
  font-size: calc(11px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text-3);
}
.pa-taskdetail__reply-text {
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: 1.75;
  color: var(--pa-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 运行中底部：旋转齿轮 +「深度求索中，用时 X」，每秒刷新。 */
.pa-taskdetail__running {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid var(--pa-line);
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-text-3);
}
.pa-taskdetail__running .pa-status-running { color: var(--pa-text-4); }

/* 空态（没有过程步骤、也没有最终回复）。 */
.pa-taskdetail__empty {
  padding: 24px 12px;
  text-align: center;
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-text-4);
}

/*
 * 进行中：单个 SVG 齿轮匀速旋转。
 *
 * 用户口径（2026-11-03）：「换成一个 svg 不需要替换，svg 要动态地、流畅地表达
 * 正在执行中」。早先是两个 SVG 帧交替淡入淡出，换帧那一下是跳变，读起来像闪；
 * 现在只有一个 svg：
 *  · linear 匀速 + infinite，没有加速段与减速段，所以看不出顿挫；
 *  · 360° 与 0° 是同一张图，首尾重合，循环处没有接缝（2.2s 一圈）；
 *  · 只动 transform（合成层动画），不触发布局与重绘——右栏里同时有好几条
 *    running 也不会掉帧；
 *  · 颜色仍只走 currentColor（用户明确不要绿 / 橙），形状自己说明状态。
 * 类名不带 taskdetail 前缀：右栏任务记录卡用的是同一个组件（status-glyph.tsx）。
 */
.pa-status-running {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}
.pa-status-running svg {
  display: block;
  transform-origin: center;
  animation: pa-status-spin 2.2s linear infinite;
}
@keyframes pa-status-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes pa-taskdetail-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes pa-taskdetail-rise {
  from { opacity: 0; transform: translateY(10px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
/*
 * 退场：遮罩淡出 + 大卡下沉 14px 并轻微缩小。
 *
 * 与上面那条入场的起点几乎对称（入场从下方 10px 升起，出场向下方 14px 沉下去），
 * 关掉时就不会是「啪」地硬消失。时长与曲线对齐 modal-animation.ts 的
 * MODAL_ANIM_MS：240ms，出场用加速曲线（从静止启动、峰值速度结束）。
 *
 * 只在外层挂一个 data-closing，卡片用后代选择器跟随——组件侧只改一处属性，
 * 不会出现「遮罩淡出了、卡片还在」的错位。
 */
@keyframes pa-taskdetail-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes pa-taskdetail-out {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(14px) scale(0.97); }
}
.pa-taskdetail-overlay[data-closing='1'] {
  animation: pa-taskdetail-fade-out 240ms ease both;
}
.pa-taskdetail-overlay[data-closing='1'] .pa-taskdetail-card {
  animation: pa-taskdetail-out 240ms cubic-bezier(0.4, 0, 0.2, 1) both;
}

/* 窄屏：卡片贴近视口边缘，正文左右留白收窄（单栏时间线不需要改结构）。 */
@media (max-width: 900px) {
  .pa-taskdetail-overlay { padding: 12px; }
  .pa-taskdetail-card { width: min(920px, 96vw); }
  .pa-taskdetail__body { padding: 16px 16px 20px; }
}

/* 浅色主题补充：遮罩压淡一点，白色卡片与灰底页面之间有层次。 */
.pa-root[data-pa-theme='light'] .pa-taskdetail-overlay {
  background: rgba(15, 17, 21, 0.32);
}
.pa-root[data-pa-theme='light'] .pa-taskdetail-card {
  border-color: var(--pa-line);
}

/* 用户偏好减少动效时，齿轮旋转与入场全部关掉。 */
@media (prefers-reduced-motion: reduce) {
  /* 进行中停转：静态齿轮本身已经是「进行中」的形状，转圈是多余的动效。 */
  .pa-status-running svg { animation: none; }
  .pa-taskdetail-overlay,
  .pa-taskdetail-card,
  /* 退场规则带 [data-closing='1']，权重比上面两条高；媒体查询不增加权重，
     不原样再列一遍的话，减少动效偏好下退场动画会照播。 */
  .pa-taskdetail-overlay[data-closing='1'],
  .pa-taskdetail-overlay[data-closing='1'] .pa-taskdetail-card {
    animation: none;
  }
}

/* ═══════════════ 任务动作面板 · 左右两栏（2026-11-05） ═══════════════
 * 用户口径：「跟我发你的截图一样，左右两栏布局」——左边动作时间线，
 * 右边「正在运行：xxx」或收工后的摘要与产出物。两栏各自己滚动，
 * 中间只画一条发丝线；原始参数 / 命令 / JSON 默认收起，点开才看。
 * 时长曲线沿用 S/M 档局部展开 220ms cubic-bezier(0.2, 0.8, 0.2, 1)。 */
.pa-actions {
  display: grid;
  grid-template-columns: minmax(0, 0.86fr) minmax(0, 1.4fr);
  min-height: 0;
}
.pa-actions__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  max-height: 56vh;
  overflow-y: auto;
  padding: 2px 16px 14px 0;
  border-right: 1px solid var(--pa-line);
}
.pa-actions__detail {
  min-width: 0;
  max-height: 56vh;
  overflow-y: auto;
  padding: 2px 4px 14px 22px;
}
.pa-actions__empty {
  padding: 12px 6px;
  font-size: calc(11px + var(--pa-font-delta));
  color: var(--pa-text-4);
}

/* 左栏一条动作：图标 + 人话标题 + 可选的一句短对象（文件名 / 命令）。 */
.pa-root .pa-actions__step {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  text-align: left;
  border-radius: 9px;
  color: var(--pa-text-3);
  transition: background 120ms ease;
}
.pa-root .pa-actions__step:hover { background: var(--pa-card-2); }
.pa-actions__step[data-active='true'] { background: var(--pa-card-2); }
.pa-actions__step[data-state='running'] .pa-actions__step-label { color: var(--pa-accent); font-weight: 600; }
.pa-actions__step[data-state='error'] .pa-actions__step-label { color: var(--pa-red); }
.pa-actions__step-glyph {
  flex: none;
  display: inline-flex;
  width: 16px;
  height: 16px;
  color: var(--pa-text-4);
}
.pa-actions__step-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pa-actions__step-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(11.5px + var(--pa-font-delta));
  line-height: 1.45;
}
.pa-actions__step-brief {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(9.5px + var(--pa-font-delta));
  color: var(--pa-text-4);
}
.pa-actions__step-now {
  flex: none;
  font-size: calc(9px + var(--pa-font-delta));
  color: var(--pa-accent);
}

/* 右栏：大标题 + 进度 + 说明。 */
.pa-actions__kicker {
  font-size: calc(10px + var(--pa-font-delta));
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--pa-text-4);
}
.pa-actions__title {
  margin-top: 6px;
  font-size: calc(17px + var(--pa-font-delta));
  font-weight: 650;
  line-height: 1.4;
  color: var(--pa-text);
  word-break: break-word;
}
.pa-actions__meta {
  margin-top: 8px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-3);
  font-variant-numeric: tabular-nums;
}
.pa-actions__progress {
  height: 4px;
  margin-top: 10px;
  border-radius: 3px;
  background: var(--pa-card-2);
  overflow: hidden;
}
.pa-actions__progress > span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--pa-accent);
  transition: width 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pa-actions__desc {
  margin: 14px 0 0;
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: 1.8;
  color: var(--pa-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 收工后的产出物格子。 */
.pa-actions__outputs { margin-top: 18px; }
.pa-actions__outputs-title {
  margin-bottom: 8px;
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-4);
}
.pa-actions__outputs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
}
.pa-actions__output {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 10px;
  border-radius: 10px;
  background: var(--pa-card-2);
  font-size: calc(10.5px + var(--pa-font-delta));
  color: var(--pa-text-2);
}
.pa-actions__output > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa-actions__output-more {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--pa-card-2);
  color: var(--pa-text-3);
  font-size: calc(12px + var(--pa-font-delta));
}

/* 视口太窄时上下排：桌面视口（>700px）始终是左右两栏。 */
@media (max-width: 700px) {
  .pa-actions { grid-template-columns: minmax(0, 1fr); }
  .pa-actions__list {
    border-right: 0;
    border-bottom: 1px solid var(--pa-line);
    padding: 2px 0 10px;
    max-height: 34vh;
  }
  .pa-actions__detail { padding: 12px 0 10px; max-height: none; }
}
@media (prefers-reduced-motion: reduce) {
  .pa-actions__progress > span { transition: none; }
}

`

let injected = false

/**
 * 幂等注入任务记录卡 / 任务详情卡样式；返回是否本次真正插入。
 *
 * 与 shell.css.ts 的 injectShellStyles 同一套约定：style id 自己管理，
 * 重复调用不会插入第二份，热更新后也能安全重入。
 */
export function injectTaskStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-task-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-task-styles'
  style.textContent = PERSONAL_TASK_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function taskStylesInjected(): boolean {
  return injected
}
