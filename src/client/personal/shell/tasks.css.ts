/**
 * Personal Agent — 任务记录卡与任务详情卡的样式（组件级）。
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

.pa-taskrec {
  flex: none;
  margin-top: 10px;
  border-radius: var(--pa-radius-card);
  border: 1px solid var(--pa-line);
  background: var(--pa-card);
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
  animation: pa-taskdetail-fade 160ms ease both;
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
  animation: pa-taskdetail-rise 200ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
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
  .pa-taskdetail-card {
    animation: none;
  }
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
