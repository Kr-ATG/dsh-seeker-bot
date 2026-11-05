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
  check('pa-sidebar 用 inset 阴影画分隔线', base.includes('box-shadow: inset -1px 0 0 var(--pa-line);'))
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
  check('Bot 资料区把 tab 顶到面板约 1/3 高度（头像/名称/编辑；已连接状态已删）',
    right.includes('pa-right__profile') && right.includes('<BotAvatar')
    && right.includes('pa-right__profile-name')
    && right.includes('pa-right__edit-btn')
    && !right.includes('pa-right__profile-status')
    && !outputsCss.includes('pa-right__profile-status')
    && /min-height:\s*clamp\(230px, 30vh, 340px\)/.test(profileBlock))
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
  check('群聊资料区从顶部排且避开关闭按钮（44px 顶距）',
    /\.pa-right \.pa-right__profile\[data-room='true'\] \{([^}]*)\}/.exec(outputsCss)?.[1]?.includes('padding-top: 44px') === true
      && /\.pa-right \.pa-right__profile\[data-room='true'\] \{([^}]*)\}/.exec(outputsCss)?.[1]?.includes('justify-content: flex-start') === true)
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
  }
}

if (failed > 0) {
  console.error('\nFAIL dsh-seeker-bot personal shell — ' + failed + ' check(s) failed')
  process.exitCode = 1
} else {
  console.log('\nPASS dsh-seeker-bot personal shell')
}
