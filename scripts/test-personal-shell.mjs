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
  check('Work 分段字号吃 --dsh-content-font-size（与 Bot 分段同源）',
    modeSwitchStyles.includes('font-size: var(--dsh-content-font-size, 14px);'))
  check('切回 Work 时分段滑块不做补间（防止高亮从 Bot 端滑过来）',
    modeSwitchStyles.includes('body[data-skb-mode="work"] .skb-seg__thumb { transition: none; }'))
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
  }
}

if (failed > 0) {
  console.error('\nFAIL dsh-seeker-bot personal shell — ' + failed + ' check(s) failed')
  process.exitCode = 1
} else {
  console.log('\nPASS dsh-seeker-bot personal shell')
}
