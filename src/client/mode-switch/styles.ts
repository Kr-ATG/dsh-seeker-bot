/**
 * dsh-seeker-bot — 侧栏 Work / Bot 分段控件样式（命名空间 skb-，幂等注入）。
 *
 * 只保留切换控件本身需要的规则：分段容器 / 滑块 / 两个按钮，以及 Bot 模式
 * 「官方侧栏其余内容让位」的隐藏规则。原 Bot 控制台的名册、新建弹窗、详情抽屉、
 * 右栏面板与输入区改造样式已随功能一起删除。
 *
 * 颜色一律优先消费 DSH 主题变量并带浅色回退；暗色在 body[data-ds-dark-theme]
 * 下切换同一套层级关系。
 *
 * 注意：本文件是注入式 CSS 模板字面量，注释里不能出现反引号（会让模板提前闭合）。
 */

/** <style> 的 id：smoke 断言按它找节点，改名要同步 scripts/smoke-client.mjs。 */
export const MODE_SWITCH_STYLE_ID = 'dsh-seeker-bot-mode-switch'

export const modeSwitchStyles = `
/* ── 宿主：Bot 模式填满侧栏剩余高度；Work 模式只占分段那一行 ─────────── */
.skb-console-host {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
body[data-skb-mode="work"] #skb-bot-console-host {
  display: block !important;
  flex: 0 0 auto;
}
/*
 * 水平内边距交给 .skb-seg 的 margin：Work 侧栏根有 8px padding，段再留 6px，
 * 左边距正好 14px —— 与 Bot 侧栏的 .pa-mode-seg（margin 14px）对齐，
 * 切换模式时分段不会左右跳。
 */
body[data-skb-mode="work"] .skb-console {
  height: auto;
  padding: 8px 0 2px;
  background: transparent;
  overflow: visible;
}

/* ── Bot 模式：官方侧栏子元素让位，只留这枚分段控件（侧栏空白）──────── */
body[data-skb-mode="bot"] [data-skb-native-hide="true"] { display: none !important; }
/*
 * Bot 模式下降级态（Personal Agent 没渲染出来时，侧栏里只剩这枚分段）：
 * 顶部留出与 .pa-sidebar__top 等高的 66px，分段仍落在 y=74，
 * 与 Bot 应用内的分段、以及 Work 模式的分段三处对齐，不会突然贴顶。
 */
body[data-skb-mode="bot"] .skb-console {
  /* 侧栏根有 6px padding，再补 68px，分段顶边落在 74 —— 与另两处一致。 */
  padding: 68px 0 10px;
}

/*
 * Bot 模式下顺带把对话增强（kr-chat）的人物卡头藏掉（2026-10-31 补）。
 *
 * Bot 模式现在被硬关闭（BOT_MODE_ENABLED = false），这条规则正常情况下不会被
 * 命中 —— 它的价值在于**将来重新开放 Bot 模式时不会重演「怎么人物还在」**。
 * 原写法住在已删除的 src/client/bot/console-styles.ts 里，随功能一起删掉了；
 * 这里留一份兜底，让「Bot 模式 = 没有人物」成为样式层的事实，而不是靠调用链
 * 恰好没渲染。
 */
body[data-skb-mode="bot"] .kr-hero-head { display: none !important; }

/* 侧栏宽度按参考图锁 300px：官方把宽度同时写在 frame 的内联
   grid-template-columns 与侧栏根的 inline width 上，没有可覆盖的变量，
   只能两处一起锁死；折叠态保持官方行为。 */
body[data-skb-mode="bot"] .pI_x6G_frame:not([data-sidebar-collapsed]) {
  grid-template-columns: 300px minmax(0px, 1fr) minmax(0px, 0px) !important;
}
body[data-skb-mode="bot"] .pI_x6G_frame:not([data-sidebar-collapsed]) .hHd-Xa_root {
  width: 300px !important;
}
body[data-skb-mode="bot"] [data-slot="sidebar"] .hHd-Xa_root {
  background: #F7F7F7;
}

/* ── 自绘容器（Bot 模式下是空白侧栏的底色）─────────────────────────── */
.skb-console {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 4px 10px;
  box-sizing: border-box;
  background: #F7F7F7;
  color: var(--dsw-alias-label-primary, #1F1F1F);
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

/*
 * ── Work / Bot 分段控件 ──────────────────────────────────────────────
 *
 * 规格与 Bot 侧栏的 .pa-mode-seg（src/client/personal/base.css.ts）逐项对齐：
 * 容器 padding 4 / 圆角 13 / gap 3，按钮高 34 / 圆角 10 / 字号 14，
 * 深色槽 #2a2b2e + 深色滑块 #0b0b0c，浅色槽 #dfe2e7 + 白色滑块。
 * 改这里记得同步改那边，反之亦然 —— 两个界面切来切去不能有视觉差。
 *
 * 结构沿用滑块（thumb）而不是给按钮上底色：位移有过渡动画，切换更顺；
 * 视觉结果与 .pa-mode-seg 的选中块一致。
 */
.skb-seg {
  position: relative;
  display: flex;
  flex: none;
  gap: 3px;
  margin: 0 6px 4px;
  padding: 4px;
  box-sizing: border-box;
  border-radius: 13px;
  background: #2a2b2e;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .035);
}
.skb-seg__thumb {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  /* 容器内宽 = 100% - 8px(padding)；两半各 (100% - 8px - 3px) / 2 */
  width: calc(50% - 5.5px);
  box-sizing: border-box;
  border-radius: 10px;
  background: #0b0b0c;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .07);
  transition: transform .22s cubic-bezier(.22, .8, .24, 1);
  pointer-events: none;
}
.skb-seg[data-mode="bot"] .skb-seg__thumb { transform: translateX(calc(100% + 3px)); }
.skb-seg__btn {
  position: relative;
  z-index: 1;
  flex: 1;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: #a1a4aa;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: .01em;
  cursor: pointer;
  transition: color .15s ease;
}
.skb-seg__btn:hover { color: #d8dade; }
.skb-seg__btn.on { color: #ffffff; }

/*
 * 禁用态（2026-10-31 用户要求「Bot 不让点击」）。
 *
 * 置灰到 tertiary 这一档，比未选中的二级文字更弱 —— 一眼能看出「这半是关着的」，
 * 而不是「没选中」。光标用 not-allowed，鼠标移上去立刻给反馈，不用等点击失败。
 * hover 颜色必须显式钉回禁用色：上面那条 .skb-seg__btn:hover 与它优先级相同、
 * 但写在前面，不钉就会被 hover 拉亮，看起来又能点了。
 */
.skb-seg__btn:disabled {
  color: var(--dsw-alias-label-tertiary, #6b7280);
  cursor: not-allowed;
  transition: none;
}
.skb-seg__btn:disabled:hover { color: var(--dsw-alias-label-tertiary, #6b7280); }

/* ── 浅色主题：槽变浅灰、滑块变白（与 .pa-mode-seg 的 light 覆盖同值）────── */
body:not([data-ds-dark-theme]) .skb-seg {
  background: #dfe2e7;
  box-shadow: none;
}
body:not([data-ds-dark-theme]) .skb-seg__thumb {
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .12);
}
body:not([data-ds-dark-theme]) .skb-seg__btn { color: #5d6269; }
body:not([data-ds-dark-theme]) .skb-seg__btn:hover { color: #14161a; }
body:not([data-ds-dark-theme]) .skb-seg__btn.on { color: #14161a; }
body:not([data-ds-dark-theme]) .skb-seg__btn:disabled,
body:not([data-ds-dark-theme]) .skb-seg__btn:disabled:hover {
  color: var(--dsw-alias-label-tertiary, #adadad);
}

/* ── 暗色主题：Bot 模式侧栏底色（分段配色已是深色基准，这里只收底色）──── */
body[data-ds-dark-theme][data-skb-mode="bot"] [data-slot="sidebar"] .hHd-Xa_root {
  background: #1B1B1C;
}
body[data-ds-dark-theme] .skb-console {
  background: #1B1B1C;
  color: var(--dsw-alias-label-primary, #E6E7E9);
}
`

/** 幂等注入：同一 id 的 <style> 已存在就直接返回。 */
export function injectModeSwitchStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(MODE_SWITCH_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = MODE_SWITCH_STYLE_ID
  style.textContent = modeSwitchStyles
  document.head.appendChild(style)
}
