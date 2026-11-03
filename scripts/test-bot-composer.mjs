#!/usr/bin/env node
/**
 * dsh-seeker-bot — Bot 模式输入框回归（纯源码 / 产物断言，不启动浏览器）。
 *
 * 覆盖 2026-11-03 用户反馈：「bot 模式的对话框允许换行自适应拉长」。
 *
 * 守住两条：
 *  1. 输入框是 textarea，高度随内容增长；上限不再写死 140px，而是跟 Work
 *     模式对话框同源（--dsh-composer-text-max-height，fallback 336px）；
 *  2. 换行保留（white-space: pre-wrap），宽列 / 窄列切换后重新量高度。
 *
 * Usage: node scripts/test-bot-composer.mjs
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

console.log('[bot-composer] 输入框自适应')
{
  const composer = read('src/client/personal/chat/Composer.tsx')
  const css = read('src/client/personal/chat/chat.css.ts')

  check('textarea 自适应高度读 CSS 上限，不再硬编码 140px',
    composer.includes('function autoGrowTextarea')
    && composer.includes('Number.parseFloat(getComputedStyle(element).maxHeight)')
    && !composer.includes('Math.min(element.scrollHeight, 140)'))
  check('高度计算包在 useLayoutEffect（发送后立刻回落单行）',
    composer.includes('useLayoutEffect(() => {') && composer.includes('autoGrowTextarea(element)'))
  check('宽度变化（对话列拖拽 / 窗口缩放）会重新量高度',
    composer.includes('ResizeObserver') && composer.includes('element.clientWidth === width'))
  check('CSS 上限与 Work 模式同源，fallback 336px',
    css.includes('max-height: var(--dsh-composer-text-max-height, 336px);'))
  check('输入框显式保留换行', css.includes('white-space: pre-wrap;'))
}

console.log('[bot-composer] 构建产物')
{
  const clientPath = join(ROOT, 'lib/client.js')
  if (!existsSync(clientPath)) {
    console.log('  ·  lib/client.js 不存在（跳过；先 npm run build）')
  } else {
    const client = readFileSync(clientPath, 'utf8')
    check('产物包含新的高度上限', client.includes('--dsh-composer-text-max-height, 336px'))
    check('产物不再含旧的 140px 截断', !client.includes('Math.min(element2.scrollHeight, 140)'))
  }
}

if (failed > 0) {
  console.error('\nFAIL dsh-seeker-bot bot composer — ' + failed + ' check(s) failed')
  process.exitCode = 1
} else {
  console.log('\nPASS dsh-seeker-bot bot composer')
}
