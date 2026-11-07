#!/usr/bin/env node
/**
 * dsh-seeker-bot — Personal Agent 外壳稳定性回归（不启动浏览器，纯源码 / 产物断言）。
 *
 * 覆盖 2026-11-03 用户反馈的两个问题：
 *
 *  1. 「Work 与 Bot 切换上方的收起图标不一致」——Bot 侧栏的 IconPanelLeft 必须
 *     与 Work 模式官方 IconPanelLeftOutlineRegular 的路径 / viewBox / 描边完全一致
 *     （官方 symbol 见 dsh-client-ui-primitives 的 #dsw-icon-panel-left-outline-regular）。
 *
 *  2. 「Work 与 Bot 切换不要出现一闪，包括左侧的标识」——PersonalApp 必须常驻
 *     DOM，Work / Bot 的显隐由 CSS 的 body[data-skb-mode] 属性选择器直接控制，
 *     不能再在 Work 模式下 return null（那会引入一次 React 挂载等待，出现空白帧）。
 *
 * 同时守住：
 *  · base.css 的 work 模式隐藏规则还在；
 *  · .pa-sidebar 不再用 border-right（会占 1px 内容宽，品牌行 / 收起按钮 / 分段
 *    比 Work 模式左移 1px）；
 *  · 侧栏宽度同步常驻安装（不依赖 mode === 'bot'）。
 *
 * Usage: node scripts/test-personal-shell.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok   ' + name)
    return
  }
  failed += 1
  console.error('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
}

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/* ── 1. 收起图标与官方 IconPanelLeftOutlineRegular 逐路径一致 ─────────── */
console.log('[personal-shell] 收起图标')
{
  const brand = read('src/client/personal/shell/Brand.tsx')
  const OFFICIAL_RECT_PATH = 'M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z'
  const OFFICIAL_DIVIDER = 'M5.5 1.5V14.5'

  check('图标使用官方 rect 路径', brand.includes(OFFICIAL_RECT_PATH))
  check('图标使用官方分隔线路径', brand.includes(OFFICIAL_DIVIDER))
  check('图标描边 1px（regular 档）', /strokeWidth=\{1\}/.test(brand))
  check('不再残留自绘 rect / 1.3 描边', !brand.includes('<rect x="1.7"') && !brand.includes('strokeWidth={1.3}'))
  check('仍以 currentColor 着色', brand.includes('stroke="currentColor"'))
  const sidebarSource = read('src/client/personal/shell/Sidebar.tsx')
  check('折叠态图标尺寸对齐官方（mark 24 / panel 18）',
    sidebarSource.includes('<BrandMark size={24} />') && sidebarSource.includes('<IconPanelLeft size={18} />'))
  check('内联 wordmark 的 clipPath id 已加 pa- 前缀（避免与官方 SVG 冲突）',
    brand.includes("replaceAll('dsh-wordmark-whale-clip', 'pa-brand-wordmark-whale-clip')")
    && brand.includes("replaceAll('dsh-wordmark-badge-clip', 'pa-brand-wordmark-badge-clip')"))
}

/* ── 2. PersonalApp 常驻 + CSS 显隐 ───────────────────────────────────── */
console.log('[personal-shell] PersonalApp 常驻')
{
  const index = read('src/client/personal/index.tsx')
  const base = read('src/client/personal/base.css.ts')

  check('不再在 Work 模式 return null', !index.includes("if (!forceMode && mode !== 'bot') return null"))
  check('不再定义 / 调用 useBodyMode',
    !index.includes('function useBodyMode') && !index.includes('const mode = useBodyMode'))
  check('根节点带 data-force-mode 豁免', index.includes("data-force-mode={forceMode ? 'true' : 'false'}"))
  check('base.css 有 work 模式隐藏 pa-root 的规则',
    base.includes("body[data-skb-mode='work'] .pa-root:not([data-force-mode='true']) { display: none !important; }"))
  check('侧栏宽度同步常驻安装且直写 CSS 变量（不触发 React 重渲染）',
    index.includes('installWorkSidebarWidthSync((px) =>')
    && index.includes("el.style.setProperty('--pa-sidebar-w'")
    && !index.includes("if (mode !== 'bot') return")
    && !index.includes('setWorkSidebarWidth'))
}

/* ── 3. 侧栏像素对齐 ─────────────────────────────────────────────────── */
console.log('[personal-shell] 侧栏像素对齐')
{
  const base = read('src/client/personal/base.css.ts')
  /*
   * 2026-11-07：用户要求隐藏左右侧栏的常驻分隔竖线，.pa-sidebar 的 inset 画线已换成
   * box-shadow: none。断言跟着实现走：不许回到 inset 分隔线（那是常驻竖条），
   * 「不许用 border-right 占宽」的历史守卫保留（见下一条）。
   */
  const sidebarAt = base.indexOf('.pa-sidebar {')
  const sidebarBlock = sidebarAt < 0 ? '' : base.slice(sidebarAt, base.indexOf('}', sidebarAt) + 1)
  check('pa-sidebar 不画常驻分隔竖线（box-shadow: none，2026-11-07 隐藏）',
    sidebarBlock.includes('box-shadow: none;')
      && !sidebarBlock.includes('inset -1px 0 0 var(--pa-line)'))
  check('pa-sidebar 不再用 border-right 占宽', !/.pa-sidebar \{[\s\S]*?border-right:/.test(base))
  check('品牌颜色跟官方 label-primary', base.includes('color: var(--dsw-alias-label-primary, var(--pa-text));'))
  check('收起按钮颜色跟官方 label-secondary', base.includes('color: var(--dsw-alias-label-secondary, var(--pa-text-2));'))
  const segBlock = /\n\.pa-mode-seg button \{([\s\S]*?)\n\}/.exec(base)?.[1] ?? ''
  check('Bot 分段字号吃 --pa-font-size（与 Work 的 skb 分段同源）',
    /font-size:\s*var\(--pa-font-size\);/.test(segBlock))
  const modeSwitchStyles = read('src/client/mode-switch/styles.ts')
  const modeSwitchIndex = read('src/client/mode-switch/index.ts')
  check('Work 分段字号吃 --dsh-content-font-size（与 Bot 分段同源）',
    modeSwitchStyles.includes('font-size: var(--dsh-content-font-size, 14px);'))
  check('Work 分段滑块不用 transition，位移交给 WAAPI（跨控件不会只剩尾程）',
    /\.skb-seg__thumb \{[\s\S]*?transition: none;/.test(modeSwitchStyles)
      && modeSwitchStyles.includes('will-change: transform')
      && !modeSwitchStyles.includes('@keyframes skb-seg-thumb-from-bot'))
  check('Bot 侧分段有独立滑块与合成层提示',
    read('src/client/personal/shell/Sidebar.tsx').includes('pa-mode-seg__thumb')
      && /\.pa-mode-seg__thumb \{[\s\S]*?will-change: transform;/.test(base))
  check('滑块动效用项目统一缓动与 240ms',
    modeSwitchIndex.includes('THUMB_SLIDE_MS = 240')
      && modeSwitchIndex.includes("cubic-bezier(.22, 1, .36, 1)"))
  check('两个分段都尊重 prefers-reduced-motion（WAAPI 起播前检查）',
    modeSwitchIndex.includes("prefers-reduced-motion: reduce")
      && modeSwitchIndex.includes('function motionReduced'))
  check('Bot 模式用软隐藏（visibility）而不是 display:none，避免 wide-in 重播',
    modeSwitchStyles.includes('[data-skb-mode-hide="true"] { visibility: hidden !important; pointer-events: none !important; }'))
  check('Bot 分段浅色 hover 与官方同值', base.includes(".pa-root[data-pa-theme='light'] .pa-mode-seg button:hover { color: #14161a; }"))
}

/* ── 3.1 对话列布局（2026-11-07 改版） ───────────────────────────────── */
console.log('[personal-shell] 对话列布局')
{
  const chatCss = read('src/client/personal/chat/chat.css.ts')
  const shellCss = read('src/client/personal/shell/shell.css.ts')

  /*
   * 取某选择器的第一条规则体：同一选择器在媒体查询里可能再出现一次（这里要守的
   * 是顶格主块）。用字面量 indexOf 而不是宽泛正则，避免跨块误匹配。
   */
  function ruleOf(css, selector) {
    const at = css.indexOf(selector + ' {')
    if (at < 0) return ''
    const from = at + selector.length + 2
    const end = css.indexOf('}', from)
    return end < 0 ? '' : css.slice(from, end)
  }

  const chatBlock = ruleOf(chatCss, '.pa-chat')
  check('.pa-chat 宽度恒为 100%（拖拽只收气泡列，不再收窄卡片）',
    chatBlock.includes('width: 100%;')
      && chatBlock.includes('align-self: stretch;')
      && !chatBlock.includes('width: min(100%, var(--pa-chat-w'))

  const headerBlock = ruleOf(chatCss, '.pa-chat__header')
  /*
   * 三版（2026-11-07 用户「不应该有背景、不应该覆盖对话流」）：会话头完全没有背景层，
   * 二版的 ::before 顶部渐隐遮罩也已删除；整条 pointer-events: none 让对话流穿透，
   * 可点的按钮 / 自动播报 / 「更多」菜单单独恢复 auto。
   */
  const headAutoAt = chatCss.indexOf('.pa-chat__head-actions,')
  const headAutoBlock = headAutoAt < 0 ? '' : chatCss.slice(headAutoAt, chatCss.indexOf('}', headAutoAt) + 1)
  check('.pa-chat__header 绝对定位悬浮且无包裹层，整条穿透指针、按钮恢复 auto（三版无渐隐遮罩）',
    headerBlock.includes('position: absolute;')
      && headerBlock.includes('background: none;')
      && headerBlock.includes('border: 0;')
      && headerBlock.includes('box-shadow: none;')
      && headerBlock.includes('pointer-events: none;')
      && !chatCss.includes('.pa-chat__header::before {')
      && headAutoBlock.includes('.pa-chat__more { pointer-events: auto; }'))

  const scrollBlock = ruleOf(chatCss, '.pa-chat__scroll')
  const innerBlock = ruleOf(chatCss, '.pa-chat__scroll-inner')
  check('.pa-chat__scroll 用 max(bubble-gutter, (100% - --pa-chat-w)/2) 收气泡列，上下留白由 scroll-inner 按「顶到卡片最上沿的 92px 动图 + 呼吸」变量推导',
    scrollBlock.includes('--pa-chat-bubble-gutter: 30px;')
      && scrollBlock.includes('padding: 0 max(var(--pa-chat-bubble-gutter), calc((100% - var(--pa-chat-w, 100%)) / 2));')
      && innerBlock.includes('padding: calc(var(--pa-chat-mascot-size) + var(--pa-chat-scroll-breath)) 0 22px;')
      && chatCss.includes('--pa-chat-mascot-size: 92px;')
      && chatCss.includes('--pa-chat-scroll-breath: 22px;')
      && chatCss.includes('--pa-chat-scroll-breath: 18px;')
      && chatCss.includes('--pa-chat-scroll-breath: 14px;'))

  /*
   * 2026-11-07 晚：用户反馈「消息滚上来会被会话头覆盖」——会话头是无底色浮层，
   * 它的头像 / 名称 / 角色标签与右侧动作直接压在消息上（实测 scrolled 时
   * 气泡与 head-avatar 重叠 22px、与 head-name 重叠 50px）。守：滚动区必须带
   * **顶部渐隐遮罩**，让内容自己在会话头下方淡出，而不是靠补一层底色去盖。
   */
  check('.pa-chat__scroll 顶部有渐隐遮罩（滚到会话头下面时内容淡出，而不是被浮层盖住）',
    scrollBlock.includes('--pa-chat-head-fade-end: calc(8px + var(--pa-chat-head-h) + 10px);')
      && scrollBlock.includes('mask-image: linear-gradient(')
      && scrollBlock.includes('-webkit-mask-image: linear-gradient(')
      && scrollBlock.includes('transparent calc(var(--pa-chat-head-fade-end) - 22px)'))

  const mascotBlock = ruleOf(chatCss, '.pa-chat__mascot')
  check('.pa-chat__mascot 是卡片最上沿悬浮动图（absolute / top: 0 / 透明 / pointer-events: none / 尺寸读 --pa-chat-mascot-size）',
    mascotBlock.includes('position: absolute;')
      && mascotBlock.includes('top: 0;')
      && mascotBlock.includes('width: var(--pa-chat-mascot-size);')
      && mascotBlock.includes('height: var(--pa-chat-mascot-size);')
      && mascotBlock.includes('background: none;')
      && mascotBlock.includes('box-shadow: none;')
      && mascotBlock.includes('pointer-events: none;'))

  /*
   * 提醒带（2026-11-07）：「动图往左去、右侧出文字或选项，全程有动效，回位也有动效」。
   * 这些断言守的是**动效骨架**：收起态是 clip 全裁（不是 display:none，否则没有揭示）、
   * 展开/收起用同一条 clip 过渡、动图位移与面板揭示都挂在 data 属性上（JS 只切状态）、
   * 内容错峰、以及系统减弱动效时的兜底。
   */
  const remindBlock = ruleOf(chatCss, '.pa-chat__remind')
  check('.pa-chat__remind 是提醒条（整组居中 / 倒计时等宽 / clip 揭示 / 动图让位 / 会话头不动）',
    remindBlock.includes('position: absolute;')
      && remindBlock.includes('clip-path: inset(0 100% 0 0 round 999px);')
      && remindBlock.includes('transition: clip-path 300ms')
      && remindBlock.includes('left: calc(50% + (112px - var(--pa-remind-w, 460px)) / 2);')
      && remindBlock.includes('width: var(--pa-remind-w, 460px);')
      && chatCss.includes(".pa-chat__remind[data-shown='true'] { clip-path: inset(0 0 0 0 round 999px); }")
      && chatCss.includes('.pa-chat__remind__count {')
      && chatCss.includes('font-variant-numeric: tabular-nums;')
      && chatCss.includes(".pa-chat[data-reminding='true'] .pa-chat__mascot {")
      && chatCss.includes('transform: translateX(calc(-50% - var(--pa-remind-shift, 0px)));')
      /* 会话头在提醒态**不动**（用户 2026-11-07 要求「左侧的这个别动」）：不应再有任何 [data-reminding] 让位规则。 */
      && !chatCss.includes(".pa-chat__header[data-reminding='true']")
      && chatCss.includes('transition-delay: calc(var(--i, 0) * 30ms + 60ms);')
      && chatCss.includes('@media (prefers-reduced-motion: reduce)'))

  /*
   * 2026-11-07 晚：动图必须**始终悬浮**（用户：「动图始终悬浮不要隐藏」）——
   * 不许再按滚动位置淡出/位移。上一版加过 data-scrolled 淡出，按要求撤掉，
   * 这里反过来守住：源码与样式里都不许出现「滚离顶部就隐藏动图」的收口。
   */
  check('动图始终悬浮，不随滚动隐藏（无 data-scrolled 淡出逻辑）',
    !read('src/client/personal/chat/MessageList.tsx').includes("setAttribute('data-scrolled'")
      && !chatCss.includes("pa-chat[data-scrolled='true']")
      && mascotBlock.includes('pointer-events: none;'))

  /*
   * 2026-11-07 晚：用户看图后要求「把这几个按钮去掉，变成实心的 svg」。
   * 会话头动作从「浮起的小圆角块」退回**裸图标**：静止态没有底色 / 投影，
   * 只有 hover 与按下时给回应；图标本身换成实心（*Solid）。
   * 旧断言守的 --pa-chat-float-btn-bg 已随按钮框一起删除，这里反过来守「没有框」。
   */
  const headBtnBlock = ruleOf(chatCss, '.pa-chat__head-btn')
  check('.pa-chat__head-btn 静止态没有底色 / 投影（只剩裸图标，hover 才给回应）',
    headBtnBlock.includes('background: none;')
      && headBtnBlock.includes('box-shadow: none;')
      && headBtnBlock.includes('width: 32px;')
      && !chatCss.includes('--pa-chat-float-btn-bg:'))
  check('会话头 hover / 按下仍有反馈（提亮 + 0.9 缩放）',
    chatCss.includes('.pa-chat__head-btn:hover {')
      && chatCss.includes('transform: scale(0.9);')
      && chatCss.includes('.pa-chat__head-btn:active {'))
  check('会话头图标换成实心（*Solid）且不再用描边版',
    read('src/client/personal/chat/ChatPanel.tsx').includes('IconPhoneSolid')
      && read('src/client/personal/chat/ChatPanel.tsx').includes('IconCameraSolid')
      && read('src/client/personal/chat/ChatPanel.tsx').includes('IconPanelRightSolid')
      && read('src/client/personal/chat/ChatPanel.tsx').includes('IconMoreSolid')
      && read('src/client/personal/chat/AutoSpeakButton.tsx').includes('IconVolumeSolid')
      && read('src/client/personal/icons.tsx').includes('function SvgSolid('))

  const mainColBlock = ruleOf(chatCss, '.pa-main-col')
  const rightBlock = ruleOf(shellCss, '.pa-right')
  check('.pa-main-col 画布取 --pa-chat-bg（= --pa-sidebar），.pa-right 分隔线为透明 1px（视觉无线、宽度不变）',
    mainColBlock.includes('padding: var(--pa-chat-gap);')
      && mainColBlock.includes('background: var(--pa-chat-bg);')
      && chatCss.includes('--pa-chat-bg: var(--pa-sidebar);')
      && rightBlock.includes('border-left: 1px solid transparent;')
      && !rightBlock.includes('border-left: 1px solid var(--pa-line);'))

  /*
   * 浅色气泡配色（2026-11-07：用户长期反馈「浅色模式下 bot 气泡样式和颜色不协调」）。
   * 守三件事：
   *  · 浅色 bot / user 收到同一色相的低饱和雾面（#EEF1F5 / #CFE2FA），不再是
   *    「中性冷灰 + 高饱亮蓝」那一对，白卡面上也不再有「一脏一艳」；
   *  · 描边只在浅色选择器上出现，基础规则保持 border: 0 —— 深色不会因为
   *    1px 透明边框占位而悄悄变大，深色观感分毫不动；
   *  · 深色基准值（#1F1F20 / #0074E8）不被「顺手统一」改掉。
   */
  const botBubbleBlock = ruleOf(chatCss, '.pa-bubble--bot')
  const userBubbleBlock = ruleOf(chatCss, '.pa-bubble--user')
  check('浅色气泡同色相雾面：bot #EEF1F5 / user #CFE2FA（不再灰 + 亮蓝）',
    chatCss.includes('--pa-bubble-bot-bg: #eef1f5;')
      && chatCss.includes('--pa-bubble-user-bg: #cfe2fa;')
      && !chatCss.includes('--pa-bubble-bot-bg: #e9eaeb;')
      && !chatCss.includes('--pa-bubble-user-bg: #b8dbfe;'))
  check('深色气泡基准值保持（#1F1F20 / #0074E8）',
    chatCss.includes('--pa-bubble-bot-bg: #1f1f20;')
      && chatCss.includes('--pa-bubble-user-bg: #0074e8;'))
  check('浅色气泡补 1px 发丝边，且基础规则仍是 border: 0（深色尺寸不变）',
    botBubbleBlock.includes('border: 0;')
      && userBubbleBlock.includes('border: 0;')
      && chatCss.includes(".pa-root[data-pa-theme='light'] .pa-bubble--bot {")
      && chatCss.includes(".pa-root[data-pa-theme='light'] .pa-bubble--user {")
      && ruleOf(chatCss, ".pa-root[data-pa-theme='light'] .pa-bubble--bot").includes('border: 1px solid var(--pa-bubble-bot-border);')
      && ruleOf(chatCss, ".pa-root[data-pa-theme='light'] .pa-bubble--user").includes('border: 1px solid var(--pa-bubble-user-border);'))
  check('浅色引用条改中性发丝线（不再用琥珀色竖线）',
    chatCss.includes(".pa-root[data-pa-theme='light'] .pa-md blockquote { border-left-color: rgba(15, 17, 21, 0.16); }")
      && !chatCss.includes('rgba(255, 139, 0, 0.55)'))

  /*
   * 正文链接（2026-11-07：轻量 Markdown 原先不认方括号加括号的链接语法，
   * 模型写出来的链接会原样显示成方括号文本）。守四件事：
   *  · 语法还原：方括号链接与裸 http(s) URL 都渲染成可点元素；
   *  · 安全白名单：只放行 http(s) / mailto / 站内绝对路径，其余协议按纯文本；
   *  · 外链带 target=_blank 与 rel=noopener noreferrer；
   *  · 行内代码里的字面量不被变成链接（code 分支排在链接分支之前）。
   */
  const mview = read('src/client/personal/chat/MessageBlockView.tsx')
  check('轻量 Markdown 还原方括号链接与裸 URL',
    mview.includes('const LINK_PATTERN') && mview.includes('const BARE_URL') && mview.includes('className="pa-md__link"'))
  check('链接地址走白名单（http(s) / mailto / 站内绝对路径）',
    mview.includes('function safeHref') && mview.includes('/^(?:https?:\\/\\/|mailto:)/i'))
  check('外链新窗口 + noopener', mview.includes('target="_blank"') && mview.includes('rel="noopener noreferrer"'))
  check('链接深浅都有对比度合格的配色', chatCss.includes('--pa-link: #6cb0ff;') && chatCss.includes('--pa-link: #0a63c9;'))
  check('链接样式是主题链接色 + 半透明下划线（hover 收实线）',
    chatCss.includes('.pa-md__link {') && chatCss.includes('text-decoration-color: color-mix(in srgb, var(--pa-link) 40%, transparent);'))
}

/* ── 4. Bot 设置卡：推理强度可改（2026-11-03） ─────────────────────── */
console.log('[personal-shell] Bot 设置卡推理强度')
{
  const card = read('src/client/personal/shell/BotSettingsCard.tsx')
  check('模型分区有「推理强度」下拉', card.includes('推理强度') && card.includes('effortChoices'))
  check('档位按模型公布能力动态生成（含「跟随默认」）', card.includes('reasoningEfforts') && card.includes('跟随默认'))
  check('换模型时保留/校验 effort（不整体替换丢字段）', card.includes('keepEffort') && card.includes('nextEfforts'))
  check('下拉即改即存进 bot.model.effort', card.includes('handleEffortChange') && /effort: next/.test(card))
}

/* ── 4.5 模型两级选择（Bot 设置 / 群聊设置，2026-11-03） ─────────────── */
console.log('[personal-shell] 模型两级选择')
{
  const picker = read('src/client/personal/shared/ModelPicker.tsx')
  const hook = read('src/client/personal/shared/useModelGroups.ts')
  const card = read('src/client/personal/shell/BotSettingsCard.tsx')
  const group = read('src/client/personal/shell/GroupSettings.tsx')
  check('共享 ModelPicker 存在且按供应商 → 模型两级输出',
    picker.includes('export function ModelPicker')
    && picker.includes('供应商')
    && picker.includes('模型')
    && picker.includes('handleProviderChange'))
  check('ModelPicker 复用 PaSelect（非原生 select）', picker.includes("from './PaSelect.tsx'") && !picker.includes('</select>'))
  check('模型列表读取抽成共享 hook', hook.includes('export function useModelGroups') && hook.includes('/api/personal-agent/models'))
  check('Bot 设置卡已用 ModelPicker 替换原生 select',
    card.includes('<ModelPicker') && !/\.pa-bset-model|className="pa-bset-model"/.test(card))
  check('群聊设置「全组统一」使用 ModelPicker', group.includes('<ModelPicker') && group.includes('modelGroups'))
  check('群聊设置也有推理强度下拉', group.includes('推理强度') && group.includes('effortChoices') && group.includes('<PaSelect'))
  check('群聊换模型时丢弃不支持的旧档位', group.includes('nextEfforts.includes(prev)'))
  check('群聊保存写入当前档位（空串跟随默认）', group.includes('effortValue') && group.includes('effort: effortValue'))
  check('群聊无模型列表时保留手填降级', group.includes('例如：alymagpie') && group.includes('modelGroupsState.loading'))
}

/* ── 4.6 Bot 右栏卡片去外框（2026-11-04） ───────────────────────────── */
console.log('[personal-shell] Bot 右栏卡片去外框')
{
  const outputs = read('src/client/personal/shell/outputs.css.ts')
  const tasks = read('src/client/personal/shell/tasks.css.ts')
  const outBlock = /\.pa-out-card\s*\{([^}]*)\}/.exec(outputs)?.[1] ?? ''
  const taskBlock = /\.pa-taskrec\s*\{([^}]*)\}/.exec(tasks)?.[1] ?? ''
  check('页面 / 产出物卡 .pa-out-card 去外框（无背景 / 边框 / 圆角）',
    outBlock !== '' && !/background\s*:/.test(outBlock)
    && !/border\s*:/.test(outBlock) && !/border-radius\s*:/.test(outBlock))
  check('任务记录卡 .pa-taskrec 去外框（无背景 / 边框 / 圆角）',
    taskBlock !== '' && !/background\s*:/.test(taskBlock)
    && !/border\s*:/.test(taskBlock) && !/border-radius\s*:/.test(taskBlock))
  check('去外框后保留内距 / 外边距（内容不贴边）',
    /padding:\s*10px 12px/.test(outBlock) && /margin-top:\s*10px/.test(taskBlock))
}

/* ── 4.7 Bot 右栏分类 tab（2026-11-04） ─────────────────────────────── */
console.log('[personal-shell] Bot 右栏分类 tab')
{
  const right = read('src/client/personal/shell/RightPanel.tsx')
  const activity = read('src/client/personal/shell/ActivityTab.tsx')
  const taskCard = read('src/client/personal/shell/TaskRecordCard.tsx')
  const outputsCss = read('src/client/personal/shell/outputs.css.ts')
  const tasksCss = read('src/client/personal/shell/tasks.css.ts')
  const tabsBlock = /\.pa-right \.pa-right__tabs\s*\{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  const profileBlock = /\.pa-right \.pa-right__profile\s*\{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  const selectedBlock = /\.pa-root \.pa-right__tab\[aria-selected='true'\]\s*\{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  const thumbBlock = /\.pa-right \.pa-right__tab-thumb\s*\{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  check('右栏顶栏下有 tablist（动态 / 产出物，默认动态）',
    right.includes('role="tablist"') && right.includes("label: '动态'") && right.includes("label: '产出物'")
    && /useState<RightTabId>\('activity'\)/.test(right))
  check('动态 tab 渲染 ActivityTab，产出物 tab 保留 PagesCard + BotOutputsCard',
    right.includes('<ActivityTab') && right.includes('<PagesCard') && right.includes('<BotOutputsCard')
    && /panelTab === 'activity'/.test(right))
  check('面板内容比滑块晚一帧切换（滑块 transition 先起跑）',
    right.includes('requestAnimationFrame(() => { setPanelTab(tab) })')
    && right.includes("key={panelTab}"))
  check('动态 tab 包含定时任务区与任务记录',
    activity.includes('state.routines') && activity.includes('查看全部定时任务')
    && activity.includes('<TaskRecordCard') && activity.includes('variant="activity"'))
  check('TaskRecordCard 支持 activity 变体（无卡头、按天分组可折叠）',
    taskCard.includes("variant?: 'card' | 'activity'") && taskCard.includes('pa-taskrec--activity')
    && taskCard.includes('pa-taskrec__group-head'))
  check('Bot 资料区高度内容自适应（头像/名称/编辑；不用 30vh 撑高；已连接状态已删）',
    right.includes('pa-right__profile') && right.includes('<BotAvatar')
    && right.includes('pa-right__profile-name')
    && right.includes('pa-right__edit-btn')
    && !right.includes('pa-right__profile-status')
    && !outputsCss.includes('pa-right__profile-status')
    && /padding:\s*14px 16px/.test(profileBlock)
    && !/min-height:\s*clamp\(230px, 30vh, 340px\)/.test(profileBlock))
  check('tab 条改为接近内容区全宽的分段控件（浅色 track + 独立滑块）',
    /margin:\s*0 16px/.test(tabsBlock) && /border-radius:\s*12px/.test(tabsBlock)
    && /padding:\s*3px/.test(tabsBlock)
    && /position:\s*relative/.test(tabsBlock)
    && right.includes('pa-right__tab-thumb')
    && /position:\s*absolute/.test(thumbBlock)
    && /background:\s*var\(--pa-card-3\)/.test(thumbBlock)
    && /box-shadow:/.test(thumbBlock))
  check('右栏 tab 滑块有左右滑动过渡（与 Work ⇄ Bot 同一曲线）',
    /transition:\s*transform 240ms cubic-bezier\(\.22, 1, \.36, 1\)/.test(thumbBlock)
      && /\.pa-right__tab-thumb\[data-tab='outputs'\] \{ transform: translateX\(calc\(100% \+ 3px\)\); \}/.test(outputsCss))
  check('右栏 tab 选中态只改文字，高亮由滑块承载',
    selectedBlock !== '' && !/background\s*:/.test(selectedBlock) && !/box-shadow\s*:/.test(selectedBlock))
  check('分类 tab 为纯图标（文字只留在 aria-label / title）',
    right.includes('aria-label={item.label}') && right.includes('title={item.label}')
    && !right.includes('pa-right__tab-label')
    && !outputsCss.includes('.pa-right__tab-label'))
  check('动态任务记录有独立样式（不套卡片外框）',
    tasksCss.includes('.pa-taskrec--activity') && tasksCss.includes('.pa-taskrec__group-head'))
}

/* ── 4.7b Bot 右栏群成员网格（2026-11-05） ───────────────────────────── */
console.log('[personal-shell] Bot 右栏群成员网格')
{
  const right = read('src/client/personal/shell/RightPanel.tsx')
  const outputsCss = read('src/client/personal/shell/outputs.css.ts')
  const membersBlock = /\.pa-right \.pa-right__members \{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  const cardBlock = /\.pa-right \.pa-right__members-card \{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  const avatarBlock = /\.pa-right \.pa-right__member-avatar \{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  check('群聊时在资料区渲染成员网格（私聊不渲染）',
    right.includes('data-room={activeRoom === null ? undefined : \'true\'}')
    && right.includes('activeRoom === null ? null : (')
    && right.includes('className="pa-right__members"')
    && right.includes('群成员（'))
  check('成员区有独立区域感（圆角底色卡 + 群成员标题）',
    /background:\s*var\(--pa-card-2\)/.test(cardBlock)
      && /border-radius:\s*14px/.test(cardBlock)
      && right.includes('className="pa-right__members-card"')
      && right.includes('className="pa-right__members-head"')
      && right.includes('<b>群成员</b>'))
  check('成员网格 5 列等分、两行封顶后内部滚动（高度随字号联动）',
    /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/.test(membersBlock)
      && /max-height:\s*calc\(112px \+ 2\.6em\)/.test(membersBlock)
      && /font-size:\s*calc\(10\.5px \+ var\(--pa-font-delta\)\)/.test(membersBlock)
      && /overflow-y:\s*auto/.test(membersBlock))
  check('成员头像是圆形（圆形裁切 + 兜底圆底）',
    /border-radius:\s*50%/.test(avatarBlock)
      && /overflow:\s*hidden/.test(avatarBlock)
      && /aspect-ratio:\s*1 \/ 1/.test(avatarBlock))
  check('最后一格是「+」并打开群聊设置',
    right.includes('pa-right__member--add')
      && right.includes('aria-label="添加成员"')
      && right.includes('openGroupSettings(activeRoom.id)'))
  check('点头像打开该 Bot 资料卡（与侧栏同一条入口）',
    right.includes('openBotSettings(member.id)'))
  const roomProfileBlock = /\.pa-right \.pa-right__profile\[data-room='true'\] \{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  check('群聊资料区从顶部排（关闭钮已删，不再留 44px 顶距）',
    roomProfileBlock.includes('justify-content: flex-start')
      && !roomProfileBlock.includes('padding-top'))
}

/* ── 4.7c 右侧详情栏开关迁到会话头（2026-11-07） ──────────────────────
 * 用户口径：「bot 设置的改到对话界面的更多的左侧，并且不是开关，变成切换」，
 * 随后又要求「右侧侧边栏的关闭按钮删掉」。守三件事：
 *   ① 会话头「更多」左侧有一枚按钮式切换（点亮 = 右栏展开），不是滑块开关；
 *   ② 设置面板里那一行连同滑块一起消失；
 *   ③ 右栏自己的关闭按钮消失，关 / 开只剩会话头这一个入口。 */
console.log('[personal-shell] 右侧详情栏切换迁到会话头')
{
  const chat = read('src/client/personal/chat/ChatPanel.tsx')
  const sidebar = read('src/client/personal/shell/Sidebar.tsx')
  const right = read('src/client/personal/shell/RightPanel.tsx')
  const toggleAt = chat.indexOf('aria-label="右侧详情栏"')
  check('会话头「更多」左侧是按钮式切换（aria-pressed + data-on，不是开关）',
    toggleAt >= 0
      && chat.includes('aria-pressed={ui.rightPanelOpen}')
      && chat.includes("data-on={ui.rightPanelOpen ? 'true' : 'false'}")
      && chat.includes('onClick={() => actions.toggleRightPanel()}')
      && chat.includes('IconPanelRight')
      && toggleAt < chat.indexOf('title="更多"'))
  check('设置面板不再有「右侧详情栏」那一行与滑块开关',
    !sidebar.includes('右侧详情栏') && !sidebar.includes('pa-switch')
      && !sidebar.includes('toggleRightPanel'))
  check('右栏内关闭按钮已删除（关闭入口只剩会话头切换）',
    !right.includes('pa-right__profile-close') && !right.includes('title="关闭右栏"')
      && !right.includes('toggleRightPanel(false)'))
}

/* ── 4.8 产出物分类选择器（2026-11-04） ─────────────────────────────── */
console.log('[personal-shell] 产出物分类选择器')
{
  const card = read('src/client/personal/shell/BotOutputsCard.tsx')
  const outputsCss = read('src/client/personal/shell/outputs.css.ts')
  const filterBlock = /\.pa-out-filter\s*\{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  const chipOn = /\.pa-root \.pa-out-filter__chip\[data-on='true'\]\s*\{([^}]*)\}/.exec(outputsCss)?.[1] ?? ''
  check('产出物卡头下有分类选择器（全部 + 各实际分类）',
    card.includes('kindFilter') && card.includes('pa-out-filter')
    && card.includes('aria-pressed={kindFilter ===') && card.includes('全部')
    && card.includes('groups.map'))
  check('分类选择器只在两类以上出现，并参与列表过滤',
    /groups\.length > 1/.test(card) && card.includes('visibleGroups')
    && /visibleGroups\.map/.test(card) && card.includes("kindFilter === 'all'"))
  check('取消选择 / 切 Bot 时筛选回落到全部',
    card.includes("setKindFilter('all')") && card.includes('[botId]'))
  check('分类 chip 选中态有独立样式（可横向滚动）',
    /overflow-x:\s*auto/.test(filterBlock)
    && /background:\s*var\(--pa-card-2\)/.test(chipOn)
    && /font-weight:\s*600/.test(chipOn))
}

/* ── 5. 构建产物同步检查（有 lib 才查，避免先要求 build） ─────────────── */
console.log('[personal-shell] 构建产物')
{
  const clientPath = join(ROOT, 'lib/client.js')
  if (!existsSync(clientPath)) {
    console.log('  ·  lib/client.js 不存在（跳过；先 npm run build）')
  } else {
    const client = readFileSync(clientPath, 'utf8')
    check('产物包含官方图标路径', client.includes('M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5'))
    check('产物包含 work 模式隐藏规则', client.includes("body[data-skb-mode='work'] .pa-root:not([data-force-mode='true'])"))
    check('产物不含旧版自绘 PanelLeft 路径', !client.includes('<rect x="1.7"') && !client.includes('M6.1 2.7v10.6'))
    check('产物包含两级模型选择器样式', client.includes('pa-model-picker'))
    check('产物不再包含原生模型下拉样式', !client.includes('pa-bset-model'))
    check('产物包含 Bot 右栏分类 tab 与动态样式',
      client.includes('pa-right__tabs') && client.includes('pa-routines') && client.includes('pa-taskrec--activity')
      && client.includes('pa-right__tab-thumb'))
    check('产物包含产出物分类选择器样式', client.includes('pa-out-filter__chip'))
    check('产物包含提醒条（面板 + 动图让位 + 会话头不让位）', client.includes('.pa-chat__remind {') && client.includes('data-reminding'))
    // 产物里的中文会被 esbuild 转成 \uXXXX，断言只认 ASCII 标识。
    check('产物包含休息提示（连续工作 / 自动收起 / 抑制）', client.includes('rest:break') && client.includes('restReminderOf'))
  }
}

if (failed > 0) {
  console.error('\nFAIL dsh-seeker-bot personal shell — ' + failed + ' check(s) failed')
  process.exitCode = 1
} else {
  console.log('\nPASS dsh-seeker-bot personal shell')
}
