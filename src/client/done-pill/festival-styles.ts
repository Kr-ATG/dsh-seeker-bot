/**
 * dsh-seeker-bot — 节日卡（Festival Card）样式表。
 *
 * 两段式形态，与每日情报卡同构：
 *   · 半截态 .dsh-festival-card：插在对话完成胶囊上沿**中段**的白色小卡
 *     （宽度随内容自适应约 70px、高 36px、left:30%、旋转 -6°），横排「节日名 +
 *     圆形倒计时徽标」。第二张再向右下错开 10px、角度 -10°，两张卡片一起插在胶囊上沿。
 *   · 划出层 .fc-modal + .fc-sheet：点标签后 portal 到 body 的「左图右文」
 *     大卡（宽 min(760px,100%)、高 min(560px,82vh)、46% / 54% 两栏）。
 *     左栏封面图 + 底部图注，右栏纸色文字区（眉标 / 宋体大标题 / 导语 /
 *     key-value 行）。入场 340ms 减速曲线、退场 260ms 加速曲线，与 brief 一致。
 *
 * ## 变量来源
 *
 * 配色复用 pill.tsx 注入的 --dpl-* 变量（定义在 .dsh-done-pill 上）。浮层
 * portal 到 body 后继承不到胶囊上的变量，所以浮层根节点自己挂 .dsh-done-pill
 * 类；几何与字号仍走 --dps / --dpt。暖棕强调色是本卡片私有的 --fc-accent，
 * 深色主题下换成更亮的暖棕，保证在 #202020 纸面上可读。
 *
 * ## 依赖方向
 *
 * 本文件不 import 任何模块（尤其不 import ./pill）：胶囊样式表由 pill.tsx 全局
 * 注入一次，这里只消费它的类名与变量。
 */

/** 样式表 id：幂等注入的判据，也是升级后替换旧表的锚点。 */
export const FESTIVAL_STYLE_ID = 'dsh-festival-card-styles'

/** 样式表正文（模块级常量，注入一次即可）。 */
export const FESTIVAL_CSS = `
/* ───────────────────────────────────────────────────────────────────────
   一、半截态：斜插在胶囊左侧的小纸片
   ─────────────────────────────────────────────────────────────────────── */

/* 父容器兜底：标签 absolute 定位，必须以胶囊所在容器为定位上下文。
   与 brief-styles 的同名规则一致（重复写一遍是因为两张卡可以分开启用，
   不能假设 brief 的样式表一定已经注入）。 */
[data-dpp-card]{position:relative}
[data-dpp-card] .dpp-bar{position:relative;z-index:2}

/* 标签本体：白色圆角小卡，轻微逆时针（-6°）「插」在胶囊上沿中段，底边压进
   胶囊 9px、露出上面 27px（文字与徽标完整可见）。宽度随内容自适应（约 70px）：横排「节日名 +
   圆形倒计时徽标」。与右侧日报卡（青色徽标）并排集中在胶囊中段，不贴两端。
   旋转角由组件内联 style 驱动：前卡 -6°、后卡 -10°；旋转原点在底边中点，
   左右两端都压在胶囊下面。z-index 三档：后卡 0 / 前卡 1 / 胶囊 2。 */
.dsh-festival-card{
  --fc-accent:#9c4a2f;
  --fc-accent-soft:rgba(156,74,47,.08);
  position:absolute;
  left:30%;
  right:auto;
  width:auto;
  max-width:44%;
  height:calc(36px * var(--dps, 1) * var(--dpt, 1));
  bottom:calc(100% - 9px * var(--dps, 1));
  z-index:1;
  box-sizing:border-box;
  display:flex;
  align-items:center;
  justify-content:flex-start;
  gap:calc(5px * var(--dps, 1));
  padding:0 calc(8px * var(--dps, 1));
  overflow:hidden;
  border:1px solid rgba(47,52,55,.14);
  border-radius:calc(9px * var(--dps, 1));
  /* 斜插小卡换回纯白：纸纹只铺在展开大卡上。暗色主题下也不跟着变深，
     否则会和深色胶囊糊在一起「看不到了」。 */
  --paper-base:rgb(255 255 255);
  background-color:var(--paper-base);
  /* 文字用固定的中性深灰，不跟 --dpl-fg（暗色下会变浅）走。 */
  color:rgb(47 52 55);
  box-shadow:0 calc(3px * var(--dps, 1)) calc(10px * var(--dps, 1)) rgba(0,0,0,.22),0 1px 2px rgba(0,0,0,.10);
  /* 旋转原点放在底边中点：左右两端都压在胶囊顶边下面，不会只有一端插进去。 */
  transform-origin:bottom center;
  transition:box-shadow .24s ease,color .2s ease,background-color .2s ease;
  cursor:pointer;
  font-family:inherit;
  text-align:left;
  outline:none;
  -webkit-tap-highlight-color:transparent;
}
.dsh-festival-card:hover{
  color:rgb(28 32 36);
  box-shadow:0 calc(4px * var(--dps, 1)) calc(14px * var(--dps, 1)) rgba(0,0,0,.26);
}

/* 后卡（第二张）：向右下错开 10px / 20px，角度更斜（内联 -10deg），
   压在前卡后面，只露出右下一道边。 */
.dsh-festival-card[data-stack="back"]{
  left:calc(30% + 10px * var(--dps, 1));
  bottom:calc(100% - 14px * var(--dps, 1));
  z-index:0;
  color:rgb(124 128 131);
}
.dsh-festival-card[data-stack="back"] .fc-tab{opacity:.78}
.dsh-festival-card:focus-visible{outline:2px solid rgb(156 74 47);outline-offset:2px}
.dsh-festival-card[data-state="skeleton"]{cursor:default}
.dsh-festival-card[data-state="error"]{color:rgb(150 74 24)}

/* 标签文字：两三个字（立冬 / 冬至 / 小寒）。 */
.fc-tab{
  min-width:0;
  flex:0 1 auto;
  font-size:calc(13px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(18px * var(--dps, 1) * var(--dpt, 1));
  font-weight:700;
  letter-spacing:.04em;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}

/* 圆形倒计时徽标：暖棕底白字。今天写「今」，明天「1」，还有 N 天写 N。 */
.fc-count{
  flex:none;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:calc(19px * var(--dps, 1));
  height:calc(19px * var(--dps, 1));
  border-radius:50%;
  background:var(--fc-accent);
  color:#fff;
  font-size:calc(11px * var(--dps, 1) * var(--dpt, 1));
  font-weight:700;
  line-height:1;
  font-variant-numeric:tabular-nums;
}
.fc-count[data-empty="1"]{
  background:color-mix(in srgb,var(--fc-accent) 30%,transparent);
  color:rgb(124 128 131);
}
.fc-count[data-live="1"]{animation:fcCountBreath 1.3s ease-in-out infinite}

@keyframes fcCountBreath{0%,100%{opacity:.35}50%{opacity:1}}

/* ───────────────────────────────────────────────────────────────────────
   二、划出层：点标签后从屏幕正中划出的左图右文大卡
   ─────────────────────────────────────────────────────────────────────── */

/* 遮罩：全屏铺一层，卡片居中。入场遮罩先淡入，卡片随后从下方 24px 处放大
   划出（340ms，cubic-bezier(0,0,.2,1)：起点加速度最大、末段收得很慢，
   观感是一张纸被抽出来摊开，而不是弹窗式硬切）。 */
.fc-modal{
  position:fixed;
  inset:0;
  z-index:9600;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:calc(24px * var(--dps, 1));
  box-sizing:border-box;
  background:rgba(0,0,0,.38);
  /* backwards 而非 both：both 会在动画结束后保留 to 帧的 transform，
     使本层成为后代 position:fixed 元素的包含块。 */
  animation:fcFadeIn .24s cubic-bezier(.2,.8,.2,1) backwards;
}
@keyframes fcFadeIn{from{opacity:0}to{opacity:1}}

/* 退场：遮罩淡出 + 卡片缩小下移，260ms 加速曲线 cubic-bezier(.4,0,1,1)。 */
.fc-modal[data-closing="1"]{animation:fcFadeOut .26s ease both}
.fc-modal[data-closing="1"] .fc-sheet{animation:fcSheetOut .26s cubic-bezier(.4,0,1,1) both}
@keyframes fcFadeOut{from{opacity:1}to{opacity:0}}
@keyframes fcSheetOut{
  from{opacity:1;transform:none}
  to{opacity:0;transform:translateY(28px) scale(.93)}
}

/* 大卡：期刊式两栏（左 46% 封面、右 54% 纸色文字），圆角克制到 10px。 */
.fc-sheet{
  --fc-accent:#9c4a2f;
  --fc-accent-soft:rgba(156,74,47,.08);
  position:relative;
  box-sizing:border-box;
  display:grid;
  grid-template-columns:minmax(0,46%) minmax(0,54%);
  width:min(760px, 100%);
  height:min(560px, 82vh);
  overflow:hidden;
  border:1px solid var(--dpl-panel-border);
  border-radius:calc(10px * var(--dps, 1));
  /*
   * 纸面：暖白底 + 一层内联 SVG 纤维噪点 + 极淡横纹。
   * 噪点是 data URI 的 feTurbulence（不引外链、不打包图片），亮色下几乎
   * 只让白面「不塑料」；暗色主题换成深灰纸底（见文件末尾的 dark 规则）。
   */
  --paper-base:rgb(251 246 236);
  background-color:var(--paper-base);
  background-image:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23p)' opacity='0.065'/%3E%3C/svg%3E"),
    repeating-linear-gradient(0deg,rgba(120,96,64,.016) 0 1px,transparent 1px 4px);
  background-size:auto,auto;
  color:var(--dpl-fg);
  box-shadow:var(--dpl-panel-shadow),0 24px 64px rgba(0,0,0,.20);
  animation:fcSheetIn .34s cubic-bezier(0,0,.2,1) backwards;
  text-align:left;
}
@keyframes fcSheetIn{
  from{opacity:0;transform:translateY(28px) scale(.92)}
  to{opacity:1;transform:none}
}
.fc-sheet,.fc-sheet *{box-sizing:border-box}

/* 右上角轻量关闭按钮。 */
.fc-close{
  position:absolute;
  top:calc(12px * var(--dps, 1));
  right:calc(14px * var(--dps, 1));
  z-index:3;
  width:calc(26px * var(--dps, 1));
  height:calc(26px * var(--dps, 1));
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:0;
  border:none;
  border-radius:calc(6px * var(--dps, 1));
  background:color-mix(in srgb, var(--dpl-panel-bg) 70%, transparent);
  color:var(--dpl-fg-weak);
  font-size:calc(12px * var(--dps, 1) * var(--dpt, 1));
  line-height:1;
  cursor:pointer;
  transition:background-color .18s ease,color .18s ease;
}
.fc-close:hover{background:var(--dpl-row-hover);color:var(--dpl-fg)}
.fc-close:focus-visible{outline:2px solid var(--dpl-fg);outline-offset:1px}

/* ── 左栏封面 ── */
.fc-cover{
  position:relative;
  min-width:0;
  min-height:0;
  overflow:hidden;
  background:
    linear-gradient(155deg,
      color-mix(in srgb, var(--fc-accent) 22%, var(--dpl-panel-bg)),
      color-mix(in srgb, var(--fc-accent) 8%, var(--dpl-panel-bg)));
}
.fc-cover-img{width:100%;height:100%;display:block;object-fit:cover}
/* 图片缺失 / 加载失败时的大字占位：宋体节日名居中，四周一道细框。 */
.fc-cover-name{
  display:none;
  position:absolute;
  inset:0;
  align-items:center;
  justify-content:center;
  font-family:"Songti SC","SimSun","Noto Serif SC",serif;
  font-size:calc(56px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  letter-spacing:.18em;
  text-indent:.18em;
  color:color-mix(in srgb, var(--fc-accent) 62%, var(--dpl-fg));
  user-select:none;
}
.fc-cover[data-empty] .fc-cover-name{display:flex}
.fc-cover[data-empty]::after{
  content:'';
  position:absolute;
  inset:calc(18px * var(--dps, 1));
  border:1px solid color-mix(in srgb, var(--fc-accent) 24%, transparent);
  border-radius:calc(4px * var(--dps, 1));
  pointer-events:none;
}
/* 图片底部半透明图注：从透明到深色的渐变，白字压在实拍图上。 */
.fc-caption{
  position:absolute;
  left:0;
  right:0;
  bottom:0;
  padding:calc(26px * var(--dps, 1)) calc(16px * var(--dps, 1)) calc(10px * var(--dps, 1));
  background:linear-gradient(180deg,transparent,rgba(0,0,0,.62));
  color:rgba(255,255,255,.88);
  font-size:calc(11px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(16px * var(--dps, 1) * var(--dpt, 1));
  text-align:right;
  word-break:break-word;
}
.fc-caption a{
  color:inherit;
  text-decoration:underline;
  text-underline-offset:2px;
  text-decoration-color:rgba(255,255,255,.55);
}
.fc-caption a:hover{color:#fff}
.fc-cover[data-empty] .fc-caption{display:none}

/* ── 右栏纸色文字区 ── */
.fc-paper{
  display:flex;
  flex-direction:column;
  min-width:0;
  min-height:0;
  padding:calc(34px * var(--dps, 1)) calc(30px * var(--dps, 1)) calc(22px * var(--dps, 1));
  overflow-y:auto;
  overscroll-behavior:contain;
  background:transparent;
}
.fc-paper::-webkit-scrollbar{width:4px}
.fc-paper::-webkit-scrollbar-thumb{
  background:color-mix(in srgb,var(--dpl-fg) 22%,transparent);
  border-radius:2px;
}
.fc-paper::-webkit-scrollbar-track{background:transparent}

/* 眉标：立冬 · 还有三天。字距拉开，暖棕强调色。 */
.fc-kicker{
  display:flex;
  align-items:center;
  gap:calc(8px * var(--dps, 1));
  min-width:0;
  margin-bottom:calc(10px * var(--dps, 1));
  /* 给右上角关闭按钮留出横向空间，避免「资料卡」角标和 ✕ 叠在一起。 */
  padding-right:calc(28px * var(--dps, 1));
  font-size:calc(12.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(18px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  letter-spacing:.14em;
  color:var(--fc-accent);
  white-space:nowrap;
}
.fc-kicker-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
/* 「资料卡」角标：模型不可用时的兜底记录来源，只用细描边，不用警告色。 */
.fc-origin{
  flex:none;
  margin-left:auto;
  padding:0 calc(7px * var(--dps, 1));
  border:1px solid color-mix(in srgb,var(--fc-accent) 32%,transparent);
  border-radius:999px;
  background:var(--fc-accent-soft);
  font-size:calc(10.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(17px * var(--dps, 1) * var(--dpt, 1));
  font-weight:500;
  letter-spacing:.08em;
  color:var(--fc-accent);
  white-space:nowrap;
}

/* 宋体大标题：28–32px，行高克制，落到具体食物 / 场景上。 */
.fc-title{
  margin:0;
  font-family:"Songti SC","SimSun","Noto Serif SC",serif;
  font-size:calc(30px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(40px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  letter-spacing:.01em;
  color:var(--dpl-fg);
  word-break:break-word;
}

/* 导语：一段生活气的正文。 */
.fc-lede{
  margin:calc(14px * var(--dps, 1)) 0 0;
  font-size:calc(14.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(25px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-dim);
  word-break:break-word;
}

/* key-value 行：label 小字暖棕、value 正文色，发丝线分隔。 */
.fc-facts{margin-top:auto;padding-top:calc(18px * var(--dps, 1))}
.fc-fact{
  display:grid;
  grid-template-columns:calc(4.2em) minmax(0,1fr);
  column-gap:calc(12px * var(--dps, 1));
  align-items:baseline;
  padding:calc(9px * var(--dps, 1)) 0;
  border-top:1px solid var(--dpl-divider);
}
.fc-fact:first-child{border-top:none;padding-top:0}
.fc-fact-label{
  font-size:calc(11.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(19px * var(--dps, 1) * var(--dpt, 1));
  letter-spacing:.12em;
  color:var(--fc-accent);
  white-space:nowrap;
}
.fc-fact-value{
  font-size:calc(13.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(19px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg);
  word-break:break-word;
}

/* 翻页：左右按钮 + 页码（多卡时）。滚轮切换由组件监听。 */
.fc-page{
  display:flex;
  align-items:center;
  justify-content:flex-end;
  gap:calc(6px * var(--dps, 1));
  margin-top:calc(10px * var(--dps, 1));
  padding-top:calc(8px * var(--dps, 1));
  border-top:1px solid var(--dpl-divider);
}
.fc-page-btn{
  width:calc(24px * var(--dps, 1));
  height:calc(24px * var(--dps, 1));
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:0;
  border:1px solid var(--dpl-panel-border);
  border-radius:calc(5px * var(--dps, 1));
  background:transparent;
  color:var(--dpl-fg-dim);
  font-size:calc(13px * var(--dps, 1) * var(--dpt, 1));
  line-height:1;
  cursor:pointer;
  transition:background-color .16s ease,color .16s ease;
}
.fc-page-btn:hover{background:var(--dpl-row-bg);color:var(--dpl-fg)}
.fc-page-btn:focus-visible{outline:2px solid var(--dpl-fg);outline-offset:1px}
.fc-page-label{
  font-size:calc(10.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(16px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-weak);
  font-variant-numeric:tabular-nums;
  letter-spacing:.02em;
  white-space:nowrap;
}

/* 页码进度：几条细短线，当前卡用暖棕点亮。 */
.fc-progress{
  display:flex;
  gap:calc(4px * var(--dps, 1));
  justify-content:flex-end;
  margin-top:calc(8px * var(--dps, 1));
}
.fc-progress span{
  width:calc(20px * var(--dps, 1));
  height:2px;
  border-radius:1px;
  background:var(--dpl-divider);
}
.fc-progress span[data-on="1"]{background:var(--fc-accent)}

/* ── 空态 / 生成中 / 失败态：浮层里换成居中的一行状态 ── */
.fc-status{
  grid-column:1 / -1;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  gap:calc(7px * var(--dps, 1));
  min-width:0;
  padding:calc(48px * var(--dps, 1));
  text-align:center;
}
.fc-status-title{
  font-family:"Songti SC","SimSun","Noto Serif SC",serif;
  font-size:calc(22px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(30px * var(--dps, 1) * var(--dpt, 1));
  font-weight:600;
  color:var(--dpl-fg);
}
.fc-status-sub{
  max-width:calc(420px * var(--dps, 1));
  font-size:calc(12.5px * var(--dps, 1) * var(--dpt, 1));
  line-height:calc(20px * var(--dps, 1) * var(--dpt, 1));
  color:var(--dpl-fg-weak);
  word-break:break-word;
}
.fc-status-sub[data-error="1"]{color:var(--dpl-warn)}

/* 生成中的不确定进度条：细条来回扫，表示「还在跑」。 */
.fc-loading{
  position:relative;
  display:block;
  width:min(260px,70%);
  height:2px;
  margin-top:calc(10px * var(--dps, 1));
  border-radius:1px;
  overflow:hidden;
  background:var(--dpl-row-bg);
}
.fc-loading::after{
  content:'';
  position:absolute;
  top:0;
  bottom:0;
  left:-40%;
  width:40%;
  border-radius:1px;
  background:var(--fc-accent);
  animation:fcIndeterminate 1.15s cubic-bezier(.4,0,.2,1) infinite;
}
@keyframes fcIndeterminate{
  0%{left:-40%}
  100%{left:100%}
}

/* 首次拉取的骨架：三行暖灰 shimmer。 */
.fc-skeleton{
  grid-column:1 / -1;
  display:flex;
  flex-direction:column;
  justify-content:center;
  gap:calc(10px * var(--dps, 1));
  padding:calc(48px * var(--dps, 1));
}
.fc-skeleton-line{
  height:calc(11px * var(--dps, 1) * var(--dpt, 1));
  border-radius:calc(5px * var(--dps, 1));
  background:linear-gradient(90deg,var(--dpl-row-bg) 0%,var(--dpl-row-hover) 50%,var(--dpl-row-bg) 100%);
  background-size:200% 100%;
  animation:fcShimmer 1.4s linear infinite;
}
.fc-skeleton-line[data-w="1"]{width:30%}
.fc-skeleton-line[data-w="2"]{width:82%}
.fc-skeleton-line[data-w="3"]{width:58%}
@keyframes fcShimmer{
  from{background-position:200% 0}
  to{background-position:-200% 0}
}

/* ── 深色主题：斜插小卡配色恒定（纯白 + 深棕徽标），不再提亮；
   只有展开大卡在深灰纸面上把暖棕强调色提亮 ── */
body[data-ds-dark-theme] .fc-sheet{
  --fc-accent:#d99872;
  --fc-accent-soft:rgba(217,152,114,.14);
  --paper-base:rgb(38 37 35);
}

/* 窄屏（壳子半屏 / 手机）：两栏收成上下两段，封面固定高度。 */
@media (max-width:640px){
  .fc-sheet{
    grid-template-columns:minmax(0,1fr);
    grid-template-rows:minmax(0,180px) minmax(0,1fr);
    height:min(680px, 88vh);
  }
  .fc-paper{padding:calc(24px * var(--dps, 1)) calc(22px * var(--dps, 1)) calc(18px * var(--dps, 1))}
  .fc-title{font-size:calc(25px * var(--dps, 1) * var(--dpt, 1));line-height:calc(34px * var(--dps, 1) * var(--dpt, 1))}
}

/* 系统开了「减少动效」时只保留状态变化，不做位移、呼吸与 shimmer。 */
@media (prefers-reduced-motion:reduce){
  .dsh-festival-card,.fc-modal,.fc-sheet{transition:none;animation:none}
  .fc-pip,.fc-loading::after,.fc-skeleton-line{animation:none}
}
`

/** 幂等注入样式表（首帧渲染前调用一次）。 */
export function ensureFestivalStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(FESTIVAL_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = FESTIVAL_STYLE_ID
  style.dataset.plugin = 'dsh-festival-card'
  style.textContent = FESTIVAL_CSS
  document.head.appendChild(style)
}
