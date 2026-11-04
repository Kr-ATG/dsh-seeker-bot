#!/usr/bin/env node
/**
 * dsh-seeker-bot — Bot 设置卡的「分类页签 + 左右布局」回归（纯源码 / 产物断言，不起浏览器）。
 *
 * 为什么要有这条：Bot 设置卡原来是 9 个分区一列纵向排下来，找「记忆检索间隔」
 * 得先翻过语音、权限、例行任务。2026-11-04 改成左侧分类导航 + 右侧面板。
 * 这种改动错了不会报错，只会「看着不对」——导航还在但面板不换、面板换了但
 * 高度跳一下、按钮被 base.css 的 reset 吃掉内边距。所以这里逐条钉住：
 *
 *   A. 页签定义：8 个分类齐全，「团队」只有主 Bot 有；
 *   B. ARIA：tablist / tab / tabpanel / aria-selected / aria-controls 成对；
 *   C. 只渲染当前页（条件渲染，而不是 9 个分区全挂上再藏起来）；
 *   D. 换页签滚回顶部、换 Bot 回到第一页；
 *   E. 布局：.pa-sheet__main 是 flex 行、nav 在左、面板在右、窄屏改列；
 *   F. 页签按钮的样式带 .pa-root .pa-sheet 前缀（否则被 .pa-root button 重置吃掉）；
 *   G. 群聊设置卡不挂 .pa-sheet--tabs（别把群聊也改成两栏）；
 *   H. 产物里真的有这套类名（有 lib 才查）。
 *
 * Usage: node scripts/test-bot-settings-tabs.mjs
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

const card = read('src/client/personal/shell/BotSettingsCard.tsx')
const css = read('src/client/personal/shell/settings.css.ts')

/* ── A. 页签定义 ─────────────────────────────────────────────────────── */
console.log('[bot-settings-tabs] 页签定义')
{
  check('定义了 BotTabId 联合类型', card.includes('type BotTabId'))
  check('页签表叫 BOT_TABS 且带 mainOnly 字段', card.includes('const BOT_TABS: BotTab[]') && card.includes('mainOnly?: boolean'))
  for (const id of ['profile', 'model', 'voice', 'permission', 'automation', 'team', 'memory', 'outputs']) {
    check(`页签含 ${id}`, new RegExp("id: '" + id + "'").test(card))
  }
  check('团队页标了 mainOnly', /id: 'team'[\s\S]{0,120}mainOnly: true/.test(card))
  check('子 Bot 看不到团队页（按 isMain 过滤）',
    card.includes('item.mainOnly !== true || bot?.isMain === true'))
  check('当前页不可用时回退到资料页',
    card.includes("availableTabs.some((item) => item.id === tab) ? tab : 'profile'"))
  check('团队分区还要再判一次 bot.isMain（双保险）',
    card.includes("activeTab === 'team' && bot.isMain ? ("))
}

/* ── B. ARIA 契约 ────────────────────────────────────────────────────── */
console.log('[bot-settings-tabs] ARIA 契约')
{
  check('导航是 role="tablist" 且纵向', card.includes('role="tablist"') && card.includes('aria-orientation="vertical"'))
  check('页签是 role="tab"', card.includes('role="tab"'))
  check('选中态写 aria-selected', card.includes('aria-selected={on}'))
  check('页签用 aria-controls 指向面板', card.includes('aria-controls="pa-bset-pane"'))
  check('面板 id 固定（所有页签的 aria-controls 都指向真实元素）', card.includes('id="pa-bset-pane"'))
  check('面板是 role="tabpanel"', card.includes('role="tabpanel"'))
  check('面板用 aria-labelledby 指回页签', card.includes('aria-labelledby={`pa-bset-tab-${activeTab}`}'))
  check('未选中的页签 tabIndex=-1（Tab 只停一次）', card.includes('tabIndex={on ? 0 : -1}'))
  check('方向键 / Home / End 可切页', card.includes('onNavKeyDown')
    && card.includes("'ArrowDown'") && card.includes("'ArrowUp'")
    && card.includes("'Home'") && card.includes("'End'"))
  check('键盘切换后焦点跟着走', card.includes('pa-bset-tab-${target.id}') && card.includes('.focus()'))
}

/* ── C. 只渲染当前页 ─────────────────────────────────────────────────── */
console.log('[bot-settings-tabs] 只渲染当前页')
{
  const guards = ['profile', 'model', 'voice', 'permission', 'automation', 'team', 'memory', 'outputs']
    .filter((id) => card.includes(`activeTab === '${id}'`))
  check('8 个页签都有渲染条件', guards.length === 8, 'missing: '
    + ['profile', 'model', 'voice', 'permission', 'automation', 'team', 'memory', 'outputs']
      .filter((id) => !card.includes(`activeTab === '${id}'`)).join(','))
  check('自动化页同时放「主动询问」和「例行任务」',
    card.includes('title="主动询问"') && card.includes('title="例行任务"'))
  check('面板用 key={activeTab} 重建（换页重播入场）', card.includes('key={activeTab}'))
}

/* ── D. 状态重置 ─────────────────────────────────────────────────────── */
console.log('[bot-settings-tabs] 状态重置')
{
  check('换页签把右侧面板滚回顶部', card.includes('bodyRef.current') && card.includes('body.scrollTop = 0'))
  check('换 Bot 回到第一页', card.includes("setTab('profile')"))
  check('页签状态不落 localStorage（每次打开都从资料页开始）',
    !/localStorage[sS]{0,80}setTab|setTab[sS]{0,80}localStorage/.test(card))
  check('导航角标只给有数量的三页', card.includes('const tabBadge')
    && card.includes("id === 'automation' && routines.length > 0")
    && card.includes("id === 'team' && subBots.length > 0")
    && card.includes("id === 'memory' && memories.length > 0"))
}

/* ── E. 左右布局 ─────────────────────────────────────────────────────── */
console.log('[bot-settings-tabs] 左右布局')
{
  check('Bot 设置卡挂了 pa-sheet--tabs', card.includes('pa-sheet pa-sheet--dialog pa-sheet--tabs'))
  check('有 .pa-sheet__main 这一行容器', card.includes('className="pa-sheet__main"'))
  check('左导航是 nav.pa-bset-nav', card.includes('className="pa-bset-nav"'))
  check('右面板是 .pa-sheet__body.pa-bset-panes', card.includes('className="pa-sheet__body pa-bset-panes"'))
  check('CSS 里 .pa-sheet__main 是 flex 行', /\.pa-sheet__main \{[^}]*display: flex/.test(css))
  check('CSS 里 nav 定宽且不参与伸缩', /\.pa-bset-nav \{[^}]*flex: none[^}]*width: 148px/.test(css))
  check('CSS 里 nav 有右分隔线', /\.pa-bset-nav \{[^}]*border-right: 1px solid var\(--pa-line\)/.test(css))
  check('卡片高度固定，不随页签内容收放', /\.pa-sheet--tabs \{[^}]*height: min\(84vh, 760px\)/.test(css))
  check('窄屏改成上下结构', /@media \(max-width: 720px\)[\s\S]{0,400}\.pa-sheet__main \{ flex-direction: column; \}/.test(css))
  check('窄屏导航变成横向 chips', /@media \(max-width: 720px\)[\s\S]{0,800}\.pa-bset-nav \{[\s\S]{0,240}flex-direction: row/.test(css))
  /*
   * 窄屏 chips 必须换行，不能是横向滚动：614px 里排不下 8 个 chip 时，
   * 横向滚动会把「产出」切在可视区外且没有任何提示（滚动条还被藏了）。
   */
  check('窄屏 chips 换行而非横向滚动',
    /@media \(max-width: 720px\)[\s\S]{0,800}\.pa-bset-nav \{[\s\S]{0,240}flex-wrap: wrap/.test(css)
    && !/@media \(max-width: 720px\)[\s\S]{0,800}\.pa-bset-nav \{[\s\S]{0,240}overflow-x: auto/.test(css))
  check('换页有入场动画', css.includes('@keyframes pa-bset-pane-in') && /\.pa-bset-pane \{[\s"]*[^}]*animation: pa-bset-pane-in/.test(css))
  check('减弱动效下不播换页动画',
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.pa-bset-pane \{ animation: none; \}/.test(css))
}

/* ── F. 页签按钮样式不被 reset 吃掉 ──────────────────────────────────── */
console.log('[bot-settings-tabs] 按钮样式优先级')
{
  check('页签按钮规则带 .pa-root .pa-sheet 前缀',
    css.includes('.pa-root .pa-sheet .pa-bset-nav__item {'))
  check('选中态用 data-on 驱动', css.includes(".pa-root .pa-sheet .pa-bset-nav__item[data-on='true'] {"))
  check('选中态给图标上强调色', css.includes(".pa-bset-nav__item[data-on='true'] .pa-bset-nav__icon"))
  check('角标是等宽数字（数量变化不抖）', /\.pa-bset-nav__badge \{[^}]*font-variant-numeric: tabular-nums/.test(css))
  check('角标对读屏隐藏（避免「团队1」读成「团队一」）',
    /className="pa-bset-nav__badge" aria-hidden="true"/.test(card))
  check('选中底深色 0.18 / 浅色 0.13 分开给',
    /\.pa-sheet \.pa-bset-nav__item\[data-on='true'\] \{[\s\S]{0,120}rgba\(255, 159, 10, 0\.18\)/.test(css)
    && /data-pa-theme='light'\] \.pa-sheet \.pa-bset-nav__item\[data-on='true'\] \{[\s\S]{0,120}rgba\(255, 159, 10, 0\.13\)/.test(css))
  check('键盘焦点有可见描边', css.includes('.pa-root .pa-sheet .pa-bset-nav__item:focus-visible'))
}

/* ── G. 不波及群聊设置 ───────────────────────────────────────────────── */
console.log('[bot-settings-tabs] 群聊设置不受影响')
{
  const group = read('src/client/personal/shell/GroupSettings.tsx')
  check('群聊设置卡不挂 pa-sheet--tabs', !group.includes('pa-sheet--tabs'))
  check('群聊设置卡仍是居中弹窗', group.includes('pa-sheet pa-sheet--dialog'))
  check('群聊设置仍用原来的 body 容器', group.includes('className="pa-sheet__body"'))
  const side = read('src/client/personal/shell/Sidebar.tsx')
  check('全局设置抽屉仍是右贴边滑出（没挂 tabs）', !side.includes('pa-sheet--tabs'))
}

/* ── H. 产物同步（有 lib 才查） ──────────────────────────────────────── */
console.log('[bot-settings-tabs] 构建产物')
{
  const clientPath = join(ROOT, 'lib/client.js')
  if (!existsSync(clientPath)) {
    console.log('  ·  lib/client.js 不存在（跳过；先 npm run build）')
  } else {
    const client = readFileSync(clientPath, 'utf8')
    check('产物含左导航类名', client.includes('pa-bset-nav'))
    check('产物含面板类名', client.includes('pa-bset-panes'))
    check('产物含两栏容器类名', client.includes('pa-sheet__main'))
    check('产物含换页关键帧', client.includes('pa-bset-pane-in'))
  }
}

console.log('')
if (failed > 0) {
  console.error('FAIL dsh-seeker-bot bot-settings-tabs — ' + failed + ' check(s) failed')
  process.exitCode = 1
} else {
  console.log('PASS dsh-seeker-bot bot-settings-tabs')
}
