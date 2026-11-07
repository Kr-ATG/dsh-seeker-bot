#!/usr/bin/env node
/**
 * dsh-seeker-bot — Bot 模式手动主题的背景同步回归（不启动浏览器，纯源码 / 产物断言）。
 *
 * 覆盖 2026-11-07 用户反馈：
 *   「bot模式下有一个巨大的问题，深色模式下所有的背景都没有同步主题」
 *
 * 根因：`--pa-sidebar` / `--pa-main` 直接引用宿主 token（--dsw-specific-sidebar-fill /
 * --dsw-alias-bg-base），而宿主 token 只反映**宿主当前**的主题。用户在外观里手动选
 * 「深色」、宿主还是浅色时，文字/卡片已经换成深色，底色却仍是宿主那套浅色 —— 整页
 * 背景看着完全没跟主题走；反向（宿主深色 + 手动浅色）则是黑底黑字。
 *
 * 修复约定：
 *  · `.pa-root` 上标记主题来源：data-pa-theme-mode = auto | dark | light；
 *  · 「跟随」（auto）继续借宿主 token，与 Work 模式同源同色；
 *  · 手动深色 / 浅色把 --pa-sidebar / --pa-main 钉成该主题自己的值，并顺带把
 *    品牌行、截图弹窗等直接读宿主 alias 的少数控件拉回 Bot 主题。
 *
 * Usage: node scripts/test-pa-theme-sync.mjs
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

/** 取出某个选择器后面的规则体（第一个 { 到配对的 }）。 */
function blockOf(css, selector) {
  const at = css.indexOf(selector)
  if (at < 0) return ''
  const start = css.indexOf('{', at)
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start + 1, i)
    }
  }
  return ''
}

console.log('[pa-theme-sync] 主题来源标记')
const index = read('src/client/personal/index.tsx')
{
  check('pa-root 标记主题来源（auto / dark / light）',
    index.includes('data-pa-theme-mode={state.settings.theme}'))
  check('仍写解析后的主题（auto 时用宿主结果）',
    index.includes('data-pa-theme={theme}') && index.includes("state.settings.theme === 'auto' ? detectedTheme : state.settings.theme"))
}

console.log('[pa-theme-sync] 手动主题的底色覆盖')
const base = read('src/client/personal/base.css.ts')
{
  const dark = blockOf(base, ".pa-root[data-pa-theme-mode='dark']")
  check('手动深色：侧栏底色钉成 #17181a（不再跟随宿主浅色）', /--pa-sidebar:\s*#17181a/.test(dark))
  check('手动深色：对话区底色钉成 #181819', /--pa-main:\s*#181819/.test(dark))
  check('手动深色：右栏与左栏同色', /--pa-right:\s*var\(--pa-sidebar\)/.test(dark))

  const light = blockOf(base, ".pa-root[data-pa-theme-mode='light']")
  check('手动浅色：侧栏底色钉成 #f9fafb', /--pa-sidebar:\s*#f9fafb/.test(light))
  check('手动浅色：对话区底色钉成 #ffffff', /--pa-main:\s*#ffffff/.test(light))

  check('手动主题把品牌行 / 侧栏按钮用的宿主 alias 拉回 Bot 主题',
    /--dsw-alias-label-primary:\s*var\(--pa-text\)/.test(dark) && /--dsw-alias-label-primary:\s*var\(--pa-text\)/.test(light))
  check('手动主题把 iu 卡面（--dsw-alias-bg-base）拉回 Bot 卡面色',
    /--dsw-alias-bg-base:\s*var\(--pa-card\)/.test(dark) && /--dsw-alias-bg-base:\s*var\(--pa-card\)/.test(light))
  check('手动主题把浮层 / 描边 alias 一并拉回 Bot 主题',
    /--dsw-alias-bg-layer-1:\s*var\(--pa-card\)/.test(dark) && /--dsw-alias-border-l2:\s*var\(--pa-line-2\)/.test(dark))
  check('手动主题的 hover 底色不再取宿主 interactive-bg-hover',
    /--dsw-alias-interactive-bg-hover:\s*rgba\(128, 132, 140, 0\.16\)/.test(dark) && /--dsw-alias-interactive-bg-hover:\s*rgba\(15, 17, 21, 0\.06\)/.test(light))
}

console.log('[pa-theme-sync] 跟随态保持与 Work 模式同色')
{
  check('基础块仍引用宿主侧栏 token', /--pa-sidebar:\s*var\(--dsw-specific-sidebar-fill, #17181a\)/.test(base))
  check('基础块仍引用宿主对话区 token', /--pa-main:\s*var\(--dsw-alias-bg-base, #181819\)/.test(base))
  check('没有给 data-pa-theme-mode=\'auto\' 写任何覆盖（跟随态必须继续借宿主）',
    !base.includes("[data-pa-theme-mode='auto']"))
}

console.log('[pa-theme-sync] 内嵌 HTML 卡片跟随 Bot 有效主题')
{
  const htmlCard = read('src/client/html-embed/HtmlCard.tsx')
  check('isDarkNow 优先读 Bot 的有效主题（.pa-root[data-pa-theme]）',
    htmlCard.includes("document.querySelector('.pa-root')") && htmlCard.includes("paRoot.getAttribute('data-pa-theme')") && htmlCard.includes("data-skb-mode'") )
  check('主题观察同时盯 body 主题属性与 pa-root 的 data-pa-theme',
    htmlCard.includes('function watchThemeSources') && /attributeFilter: \['data-pa-theme'\]/.test(htmlCard))
  check('未回退到只用 body 属性判断', !/function isDarkNow\(\)[\s\S]{0,120}return document\.body\.hasAttribute\(THEME_ATTR\)\s*\n\}/.test(htmlCard) || htmlCard.includes('paTheme ==='))
}

console.log('[pa-theme-sync] 构建产物同步')
{
  const bundlePath = 'lib/client.js'
  if (existsSync(join(ROOT, bundlePath))) {
    const bundle = read(bundlePath)
    check('产物含 data-pa-theme-mode', bundle.includes('data-pa-theme-mode'))
    check('产物含手动深色底色覆盖', bundle.includes("data-pa-theme-mode='dark'"))
  } else {
    console.log('  skip 产物未构建（lib/client.js 不存在）')
  }
}

if (failed > 0) {
  console.error('\n[pa-theme-sync] ' + failed + ' 项失败')
  process.exit(1)
}
console.log('\n[pa-theme-sync] 全部通过')
