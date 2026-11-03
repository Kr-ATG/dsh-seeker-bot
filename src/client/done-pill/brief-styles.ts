/**
 * dsh-seeker-bot — 每日情报卡（Daily Brief）的样式表。
 *
 * ## 两种形态，两个节点
 *
 *   · 半截态（本文件 .dsh-daily-brief）：斜插在对话完成胶囊左上角的**小标签**，
 *     宽度只有胶囊的 1/5（约 50px）、露出约 28px，只写一个栏目短标签
 *     （AI / 世界 / 国内）+ 一个状态小圆点。它的作用是「入口」，不是阅读面。
 *   · 划出层（本文件 .db-modal + .db-sheet）：点标签后 portal 到 body 的
 *     **期刊式大卡**，860px 宽、82vh 高、左右两栏，从屏幕正中划出；关闭时
 *     反向缩小淡出（260ms 加速曲线），不是直接卸载。
 *
 * 为什么不再「原位撑大」：第一版把半截卡做成整宽大卡、hover 原地展开，实测
 * 一张纸直接盖住半个侧栏，太重。用户要的是「一张斜插的小纸片，点开才看内容」，
 * 所以标签必须小、浮层必须独立。
 *
 * ## 变量来源
 *
 * 配色全部复用 pill.tsx 注入的 --dpl-*（定义在 .dsh-done-pill 上）。浮层 portal
 * 到 body 后**继承不到**胶囊上的变量，所以浮层根节点自己挂 .dsh-done-pill
 * 类（与 sidebar-card 的弹窗同款做法），几何/字号仍走 --dps / --dpt。
 *
 * ## 依赖方向
 *
 * 本文件不 import 任何模块（尤其不 import ./pill）：胶囊样式表由 pill.tsx 全局
 * 注入一次，这里只消费它的类名与变量。互相 import 会形成循环依赖。
 */

/** 样式表 id：幂等注入的判据，也是升级后替换旧表的锚点。 */
export const BRIEF_STYLE_ID = 'dsh-daily-brief-styles'

/**
 * 样式表正文。
 *
 * 模块级常量（不是每次渲染重新拼字符串）：内容稳定，注入一次即可。
 */
export const BRIEF_CSS = `
/* ───────────────────────────────────────────────────────────────────────
   一、半截态：斜插在胶囊左上角的小标签
   ─────────────────────────────────────────────────────────────────────── */

/* 父容器兜底：标签用 absolute 定位，必须以胶囊所在容器为定位上下文。
   胶囊的 wrapStyle 只写 flex 几何、没有 position，这里按它已有的
   data-dpp-card 属性补一条定位规则（不改胶囊源码）；z-index 把胶囊抬到
   标签之上，形成「纸片从胶囊后面插进去」的层叠。 */
[data-dpp-card]{position:relative}
[data-dpp-card] .dpp-bar{position:relative;z-index:2}

/* 标签本体：宽度 17%（约胶囊的 1/6）、高 38px、其中 9px 压在胶囊后面，
   实际露出约 29px。水平位置落在胶囊的 **2/3 处**（left:63%）。
   旋转角由组件内联 style 驱动：第一张 -23°、第二张 -34°，两张半叠放——
   后卡往左下错开 10px、角度更陡，只从前卡边缘露出一点，像两张纸片一起插着。
   z-index 三档：后卡 0 / 前卡 1 / 胶囊 2，层叠关系就是「纸片插进胶囊」。 */
.dsh-daily-brief{
  position:absolute;
  left:63%;
  right:auto;
  width:17%;
  min-width:calc(38px * var(--dps, 1));
  height:calc(40px * var(--dps, 1) * var(--dpt, 1));
  bottom:calc(100% - 9px * var(--dps, 1));
  z-index:1;
  box-sizing:border-box;
  display:flex;
  align-items:center;
  justify-content:center;
  gap:calc(4px * var(--dps, 1));
  padding:0 calc(4px * var(--dps, 1));
  overflow:hidden;
  border:1px solid var(--dpl-panel-border);
  border-radius:calc(8px * var(--dps, 1));
  background:var(--dpl-panel-bg);
  color:var(--dpl-fg-dim);
  box-shadow:var(--dpl-panel-shadow);
  transform-origin:bottom left;
  transition:transform .24s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,color .2s ease;
  cursor:pointer;
  font-family:inherit;
  text-align:center;
  outline:none;
  -webkit-tap-highlight-color:transparent;
}
.dsh-daily-brief:hover{
  color:var(--dpl-fg);
  box-shadow:var(--dpl-shell-shadow-hover);
}

/* 后卡（第二张）：往左下错开、角度更陡（内联给 -34deg），压在前卡后面。
   它不承载文字——只露出一条斜边，作用是「这里还有一张」的暗示。 */
.dsh-daily-brief[data-stack="back"]{
  left:calc(63% + 19px * var(--dps, 1));
  bottom:calc(100% - 16px * var(--dps, 1));
  z-index:0;
  color:var(--dpl-fg-weak);
}
.dsh-daily-brief[data-stack="back"] .db-tab{opacity:.72}
.dsh-daily-brief:focus-visible{outline:2px solid var(--dpl-fg);outline-offset:2px}
.dsh-daily-brief[data-state="skeleton"]{cursor:default}
.dsh-daily-brief[data-state="error"]{color:var(--dpl-warn)}

/* 标签文字：两个字（AI / 世界 / 国内），字距拉开一点才像标签而不是缩写。 */
.db-tab{
  min-width:0;
  font-size:calc(9.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(13px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  letter-spacing:.06em;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}

/* 状态小圆点：有卡且未读时实心；生成中呼吸。 */
.db-pip{
  flex:none;
  width:calc(4px * var(--dps, 1));
  height:calc(4px * var(--dps, 1));
  border-radius:50%;
  background:currentColor;
}
.db-pip[data-live="1"]{animation:dbPipBreath 1.3s ease-in-out infinite}
@keyframes dbPipBreath{0%,100%{opacity:.28}50%{opacity:1}}

/* ───────────────────────────────────────────────────────────────────────
   二、划出层：点标签后从屏幕正中划出的「期刊式」大卡
   ─────────────────────────────────────────────────────────────────────── */

/* 遮罩：全屏铺一层，卡片居中。z-index 与胶囊弹窗（9500）错开一级。
   入场按 HarmonyOS 的「从视线外进入 → 减速曲线」：遮罩先淡入（180ms），
   卡片随后从下方 28px 处放大划出（340ms，cubic-bezier(0,0,.2,1)）——
   这条曲线起点加速度最大、末段收得很慢，观感就是「一张纸被抽出来摊开」，
   而不是弹窗式的硬切。时长取 340ms，落在官方「全屏范围 350ms」以内。 */
.db-modal{
  position:fixed;
  inset:0;
  z-index:9600;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:calc(24px * var(--dps, 1));
  box-sizing:border-box;
  background:rgba(0,0,0,.36);
  /* fill-mode 用 backwards 而不是 both：both 会在动画结束后保留 to 帧的
     transform，使本层成为后代 position:fixed 元素的包含块（tooltip 会整体偏移）。
     入场的 to 帧就是默认值（opacity:1），backwards 落地无跳变。 */
  animation:dbFadeIn .24s cubic-bezier(.2,.8,.2,1) backwards;
}
@keyframes dbFadeIn{from{opacity:0}to{opacity:1}}

/* 退场：遮罩淡出 + 卡片缩小下移。出场用**加速曲线** cubic-bezier(.4,0,1,1)
   （HarmonyOS 的加速语义：从静止启动、峰值速度时结束）。
   时长 260ms、位移 28px、缩到 0.93 —— 第一版写的 190ms/14px 太快，肉眼几乎
   只剩「啪一下没了」，等于没动效；退场要比入场（340ms）短，但不能短到看不出来。 */
.db-modal[data-closing="1"]{animation:dbFadeOut .26s ease both}
.db-modal[data-closing="1"] .db-sheet{animation:dbSheetOut .26s cubic-bezier(.4,0,1,1) both}
@keyframes dbFadeOut{from{opacity:1}to{opacity:0}}
@keyframes dbSheetOut{
  from{opacity:1;transform:none}
  to{opacity:0;transform:translateY(28px) scale(.93)}
}

/* 大卡：期刊式两栏（左：栏目 / 标题 / 导语 / 动作；右：编号条目）。
   宽 860px 封顶、高 82vh 封顶 —— 比侧栏宽一倍多，读起来像摊开的一页杂志。 */
.db-sheet{
  box-sizing:border-box;
  display:flex;
  flex-direction:column;
  width:min(860px, 100%);
  max-height:min(82vh, 760px);
  padding:calc(22px * var(--dps, 1)) calc(26px * var(--dps, 1)) calc(20px * var(--dps, 1));
  overflow:hidden;
  border:1px solid var(--dpl-panel-border);
  border-radius:calc(18px * var(--dps, 1));
  background:var(--dpl-panel-bg);
  color:var(--dpl-fg);
  box-shadow:var(--dpl-panel-shadow),0 24px 64px rgba(0,0,0,.18);
  /* 同 .db-modal：backwards 而非 both，避免残留 transform 改变包含块。 */
  animation:dbSheetIn .24s cubic-bezier(.2,.8,.2,1) backwards;
  text-align:left;
}
@keyframes dbSheetIn{
  from{opacity:0;transform:translateY(28px) scale(.92)}
  to{opacity:1;transform:none}
}

/* 正文两栏：左 38% 主题区、右 62% 条目区，中间一条发丝竖线。 */
.db-body{
  display:grid;
  grid-template-columns:minmax(0,38%) minmax(0,1fr);
  gap:calc(22px * var(--dps, 1));
  flex:1 1 auto;
  min-height:0;
  margin-top:calc(14px * var(--dps, 1));
  padding-top:calc(14px * var(--dps, 1));
  border-top:1px solid var(--dpl-divider);
}
.db-col-left{
  display:flex;
  flex-direction:column;
  min-height:0;
  min-width:0;
}
.db-col-right{
  display:flex;
  flex-direction:column;
  min-height:0;
  min-width:0;
  overflow-y:auto;
  overscroll-behavior:contain;
  padding-left:calc(22px * var(--dps, 1));
  border-left:1px solid var(--dpl-divider);
}
.db-col-right::-webkit-scrollbar{width:4px}
.db-col-right::-webkit-scrollbar-thumb{
  background:color-mix(in srgb,var(--dpl-fg) 22%,transparent);
  border-radius:2px;
}

/* 窄屏（壳子半屏 / 手机）：两栏收成单栏，右栏的竖线换成横线。 */
@media (max-width:720px){
  .db-body{grid-template-columns:minmax(0,1fr)}
  .db-col-right{
    padding-left:0;
    border-left:none;
    margin-top:calc(12px * var(--dps, 1));
    padding-top:calc(12px * var(--dps, 1));
    border-top:1px solid var(--dpl-divider);
  }
}

/* 浮层头：栏目名 + 未联网角标 + 日期 + 关闭按钮。 */
.db-head{
  display:flex;
  align-items:baseline;
  gap:calc(8px * var(--dps, 1));
  min-width:0;
}
.db-kicker{
  flex:none;
  font-size:calc(10.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(15px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  letter-spacing:.16em;
  color:var(--dpl-fg-dim);
  white-space:nowrap;
}
/* 未联网角标：只用弱色 + 发丝描边，不用警告色——模型知识不是错误。 */
.db-offline{
  flex:none;
  padding:0 calc(5px * var(--dps, 1));
  border:1px solid var(--dpl-panel-border);
  border-radius:999px;
  font-size:calc(9.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(14px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-weak);
  white-space:nowrap;
}
.db-meta{
  flex:1;
  min-width:0;
  text-align:right;
  font-size:calc(10px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(15px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-weak);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  font-variant-numeric:tabular-nums;
}
.db-close{
  flex:none;
  width:calc(20px * var(--dps, 1));
  height:calc(20px * var(--dps, 1));
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:0;
  border:none;
  border-radius:calc(6px * var(--dps, 1));
  background:transparent;
  color:var(--dpl-fg-weak);
  font-size:calc(12px * var(--dps, 1) * var(--dpt, 1));
  line-height:1;
  cursor:pointer;
}
.db-close:hover{background:var(--dpl-row-bg);color:var(--dpl-fg)}
.db-close:focus-visible{outline:2px solid var(--dpl-fg);outline-offset:1px}

/* ── 标题与导语 ── */
.db-title{
  margin:calc(2px * var(--dps, 1)) 0 0;
  font-size:calc(21px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  line-height:calc(29px * var(--dps, 1) * var(--dpt, 1));
  letter-spacing:-.018em;
  color:var(--dpl-fg);
  word-break:break-word;
}
.db-lede{
  margin:calc(8px * var(--dps, 1)) 0 0;
  font-size:calc(13px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(21px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-dim);
  word-break:break-word;
}

/* ── 编号条目：01 序号 + 标题一行 + 说明两行 + 右下角来源 ── */
.db-entries{
  display:flex;
  flex-direction:column;
  gap:calc(13px * var(--dps, 1));
}
.db-entry{
  display:grid;
  grid-template-columns:calc(20px * var(--dps, 1)) minmax(0,1fr);
  column-gap:calc(7px * var(--dps, 1));
  align-items:start;
}
.db-no{
  padding-top:calc(1px * var(--dps, 1));
  font-size:calc(11px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(16px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  color:var(--dpl-fg-weak);
  font-variant-numeric:tabular-nums;
  letter-spacing:.02em;
}
.db-entry-main{
  display:flex;
  flex-direction:column;
  gap:calc(1px * var(--dps, 1));
  min-width:0;
}
.db-entry-title{
  font-size:calc(13.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(19px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  color:var(--dpl-fg);
  word-break:break-word;
}
.db-entry-text{
  font-size:calc(12px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(18px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-dim);
  word-break:break-word;
}
.db-entry-foot{
  display:flex;
  align-items:center;
  justify-content:flex-end;
  gap:calc(6px * var(--dps, 1));
  min-width:0;
  margin-top:calc(2px * var(--dps, 1));
}
.db-entry-tag{
  flex:none;
  font-size:calc(9.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(14px * var(--dps, 1) * var(--dpt, 1));
  letter-spacing:.06em;
  color:var(--dpl-fg-weak);
}
.db-entry-src{
  min-width:0;
  max-width:70%;
  font-size:calc(10px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(15px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-weak);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.db-entry-src[data-link="1"]{
  text-decoration:underline;
  text-underline-offset:2px;
  text-decoration-color:color-mix(in srgb,var(--dpl-fg-weak) 70%,transparent);
  cursor:pointer;
}
.db-entry-src[data-link="1"]:hover{color:var(--dpl-fg)}
.db-entry-src[data-link="1"]:focus-visible{outline:2px solid var(--dpl-fg);outline-offset:2px}

/* ── 底部动作行：继续聊 + 翻页 ── */
.db-actions{
  display:flex;
  align-items:center;
  gap:calc(8px * var(--dps, 1));
  margin:auto 0 0;
  padding-top:calc(14px * var(--dps, 1));
}
.db-chat{
  flex:none;
  display:inline-flex;
  align-items:center;
  gap:calc(4px * var(--dps, 1));
  padding:calc(4px * var(--dps, 1)) calc(10px * var(--dps, 1));
  border:1px solid var(--dpl-panel-border);
  border-radius:999px;
  background:var(--dpl-accent-soft);
  color:var(--dpl-fg);
  font-size:calc(11px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(16px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  font-family:inherit;
  cursor:pointer;
  transition:background-color .18s ease,transform .18s cubic-bezier(.32,.72,0,1);
}
.db-chat:hover{background:var(--dpl-row-hover);transform:translateY(-1px)}
.db-chat:focus-visible{outline:2px solid var(--dpl-fg);outline-offset:2px}
.db-spacer{flex:1;min-width:0}
.db-pager{
  display:inline-flex;
  align-items:center;
  gap:calc(2px * var(--dps, 1));
  flex:none;
}
.db-pager-btn{
  width:calc(20px * var(--dps, 1));
  height:calc(20px * var(--dps, 1));
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:0;
  border:none;
  border-radius:calc(6px * var(--dps, 1));
  background:transparent;
  color:var(--dpl-fg-dim);
  font-size:calc(13px * var(--dps, 1) * var(--dpt, 1));
  line-height:1;
  cursor:pointer;
}
.db-pager-btn:hover:not(:disabled){background:var(--dpl-row-bg);color:var(--dpl-fg)}
.db-pager-btn:focus-visible{outline:2px solid var(--dpl-fg);outline-offset:1px}
.db-pager-btn:disabled{opacity:.4;cursor:default}
.db-pager-label{
  font-size:calc(10px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(15px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-weak);
  font-variant-numeric:tabular-nums;
  letter-spacing:.02em;
  white-space:nowrap;
}

/* ── 空态 / 生成中 / 失败态：浮层里换成一行状态 ── */
.db-status{
  display:flex;
  flex-direction:column;
  gap:calc(3px * var(--dps, 1));
  min-width:0;
  padding:calc(6px * var(--dps, 1)) 0 calc(2px * var(--dps, 1));
}
.db-status-title{
  font-size:calc(13px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(19px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  color:var(--dpl-fg);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.db-status-sub{
  font-size:calc(10.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(16px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-weak);
  word-break:break-word;
}
.db-status-sub[data-error="1"]{color:var(--dpl-warn)}

/* 生成中的不确定进度条：细条来回扫，表示「还在跑」而不是具体百分比。 */
.db-progress{
  position:relative;
  display:block;
  margin-top:calc(7px * var(--dps, 1));
  height:2px;
  border-radius:1px;
  overflow:hidden;
  background:var(--dpl-row-bg);
}
.db-progress::after{
  content:'';
  position:absolute;
  top:0;
  bottom:0;
  left:-40%;
  width:40%;
  border-radius:1px;
  background:var(--dpl-fg-dim);
  animation:dbIndeterminate 1.15s cubic-bezier(.4,0,.2,1) infinite;
}
@keyframes dbIndeterminate{
  0%{left:-40%}
  100%{left:100%}
}

/* 首次拉取的骨架：两条灰条 shimmer。 */
.db-skeleton{
  display:flex;
  flex-direction:column;
  gap:calc(8px * var(--dps, 1));
  padding-top:calc(3px * var(--dps, 1));
}
.db-skeleton-line{
  height:calc(10px * var(--dps, 1) * var(--dpt, 1));
  border-radius:calc(5px * var(--dps, 1));
  background:linear-gradient(90deg,var(--dpl-row-bg) 0%,var(--dpl-row-hover) 50%,var(--dpl-row-bg) 100%);
  background-size:200% 100%;
  animation:dbShimmer 1.4s linear infinite;
}
.db-skeleton-line[data-w="1"]{width:34%}
.db-skeleton-line[data-w="2"]{width:78%}
@keyframes dbShimmer{
  from{background-position:200% 0}
  to{background-position:-200% 0}
}

/* 系统开了「减少动效」时只保留状态变化，不做位移与 shimmer。 */
@media (prefers-reduced-motion:reduce){
  .dsh-daily-brief,.db-modal,.db-sheet{transition:none;animation:none}
  .db-skeleton-line,.db-progress::after,.db-pip{animation:none}
}
`

/** 幂等注入样式表（apply 期或首帧渲染前调用一次）。 */
export function ensureBriefStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(BRIEF_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = BRIEF_STYLE_ID
  style.dataset.plugin = 'dsh-daily-brief'
  style.textContent = BRIEF_CSS
  document.head.appendChild(style)
}
