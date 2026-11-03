/**
 * Personal Agent — 「连接你的应用」推荐卡样式。
 *
 * 为什么单独一个文件而不是塞进 chat.css.ts：那张表已经两千多行、且由别的改动
 * 独占；推荐卡是一块可以整体删掉的功能（宿主不再推推荐时删文件即可），样式跟着
 * 组件走，比在巨型样式表里找一段更安全。
 *
 * 颜色一律取 --pa-* 设计变量（深色为基准，base.css.ts 的浅色主题覆盖同一批变量），
 * 这里不出现任何写死的 #fff / #000，否则浅色主题下会有一半元素看不见。
 */

export const CONNECTOR_SUGGEST_CSS = `
/* ---------- 连接器推荐卡 ---------- */
.pa-con {
  width: min(100%, 490px);
  background: var(--pa-card);
  border: 1px solid var(--pa-line);
  border-radius: 14px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pa-con__title {
  font-size: calc(14px + var(--pa-font-delta));
  line-height: calc(20px + var(--pa-font-delta));
  font-weight: 600;
  color: var(--pa-text);
  letter-spacing: 0.01em;
}
.pa-con__prompt {
  font-size: calc(13px + var(--pa-font-delta));
  line-height: 1.68;
  color: var(--pa-text-2);
  /* 与标题之间的间距由 prompt 自己收紧，避免出现「标题下空一大块」 */
  margin-top: -6px;
  white-space: pre-wrap;
}
.pa-con__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
}

/*
 * 一行 = 一个按钮：整行可点，点击目标是「去连接」而不是某一小块。
 *
 * 选择器必须带 .pa-root 前缀：base.css 顶部那条 .pa-root button 重置（0,1,1）
 * 特异性高于纯类选择器（0,1,0），只写 .pa-con__row 的话内边距 / 圆角 / 边框会被
 * 整条压掉，行会变成贴边的裸文字（chat.css 的 .pa-int__opt 就踩过同一个坑）。
 *
 * 注意：本文件是模板字符串，注释里也**不能出现反引号**（会把模板提前截断，
 * 构建成功但产物一加载就报错）；build.mjs 的 assertCssTemplateDelimiters 会拦。
 */
.pa-root .pa-con__row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 10px;
  /* 默认透明：整张卡已经是一块底色，每行再铺一层就成了「一堆药丸」 */
  background: transparent;
  border: 1px solid transparent;
  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.pa-root button.pa-con__row:hover { background: var(--pa-chat-hover); border-color: var(--pa-line); }
.pa-root button.pa-con__row:focus-visible { outline: 2px solid var(--pa-accent); outline-offset: 1px; }
/* 已连接：整体降透明度（信息弱化），但悬浮时恢复——它仍然点得开，用来去市场管理 */
.pa-root .pa-con__row[data-installed='true'] { opacity: 0.62; }
.pa-root button.pa-con__row[data-installed='true']:hover { opacity: 1; }
/* 刚点过的那条：留一个实线描边，用户回来时能认出「我点的是这条」 */
.pa-root .pa-con__row[data-picked='true'] { background: var(--pa-chat-glass); border-color: var(--pa-line-2); }

/*
 * 图标位：占位块与 <img> 叠在一起。
 * 占位在底层常驻，图片加载成功后由 data-loaded 收起字母；加载失败时组件直接
 * 不渲染 <img>，露出的就是占位——不会出现浏览器默认的破图标。
 */
.pa-con__icon {
  position: relative;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--pa-chat-glass-2);
  color: var(--pa-text-2);
  font-size: calc(12px + var(--pa-font-delta));
  font-weight: 600;
  line-height: 1;
  user-select: none;
}
.pa-con__icon-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* 留 3px 内边距：目录图标多为方形贴边，紧贴圆角会显得很挤 */
  padding: 3px;
  object-fit: contain;
  display: block;
}
.pa-con__icon[data-loaded='true'] .pa-con__icon-fallback { opacity: 0; }
.pa-con__icon-fallback { display: inline-flex; align-items: center; justify-content: center; }

.pa-con__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pa-con__name {
  font-size: calc(12.5px + var(--pa-font-delta));
  line-height: calc(18px + var(--pa-font-delta));
  color: var(--pa-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-con__desc {
  font-size: calc(11px + var(--pa-font-delta));
  line-height: calc(16px + var(--pa-font-delta));
  color: var(--pa-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 右侧状态：已连接 / 已打开，外加一个箭头暗示「点了会跳走」 */
.pa-con__state {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: calc(10.5px + var(--pa-font-delta));
  line-height: calc(15px + var(--pa-font-delta));
  color: var(--pa-text-3);
  white-space: nowrap;
}
.pa-con__state[data-tone='installed'] { color: var(--pa-green); }
.pa-con__state[data-tone='picked'] { color: var(--pa-accent); }
.pa-con__chevron { flex: none; display: inline-flex; color: var(--pa-text-4); }

@media (max-width: 760px) {
  .pa-con { padding: 14px 14px; }
  /* 窄屏一行说明放不下时省略号会截掉关键信息：允许换两行 */
  .pa-con__desc { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
}
`

let injected = false

/** 幂等注入推荐卡样式；返回本次是否真正插入。 */
export function ensureConnectorSuggestStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById('pa-connector-suggest-styles') !== null) {
    injected = true
    return false
  }
  const style = document.createElement('style')
  style.id = 'pa-connector-suggest-styles'
  style.textContent = CONNECTOR_SUGGEST_CSS
  document.head.appendChild(style)
  injected = true
  return true
}

export function connectorSuggestStylesInjected(): boolean {
  return injected
}
