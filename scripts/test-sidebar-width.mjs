#!/usr/bin/env node
/**
 * dsh-seeker-bot — 左侧栏拖拽宽度回归（2026-11-03 用户反馈「左侧侧边栏无法拖拽」）。
 *
 * 三条链路都必须钉住，任何一条断掉用户都会「要么拖不动、要么一松手就弹回」：
 *
 *  1. **恢复 / 守护走官方 layout store**：只写 frame 与侧栏根的 inline style
 *     会让 React store 里的 `layoutInfo.sidebar` 停在 280px，官方拖拽手柄的
 *     `left` 按 store 值渲染 —— 实际宽 341px、手柄却在 280px，用户按侧栏边界
 *     根本摸不到手柄。必须调 `ctx.layout.panels.setSidebar(px)`。
 *
 *  2. **拖拽结束的静默窗口**：window 的捕获阶段 pointerup 先于官方手柄自己的
 *     pointerup 执行；没有 settle 窗口时 guard 会立刻拿旧存储值把刚拖出的宽度
 *     写回去（一松手就弹回）。
 *
 *  3. **Bot 模式 `.pa-sidebar` 自己的右缘手柄**：Bot 左侧栏不是官方 frame，
 *     必须有自己的 resizer，松手同步 store + localStorage，切 Work 才不跳宽。
 *
 * Usage: node scripts/test-sidebar-width.mjs
 */

import { readFileSync } from 'node:fs'
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

/* ── 1. 官方 store 通道 ─────────────────────────────────────────────────── */
console.log('[sidebar-width] 官方 layout store')
{
  const persist = read('src/client/sidebar-width-persist.ts')
  check('恢复 / 守护优先调用官方 setSidebar（不是只写 DOM）',
    /panels\.setSidebar\(target\)/.test(persist))
  check('从 ctx.layout.panels 解析 store action 集',
    persist.includes('layout?.panels') && persist.includes('setSidebar'))
  check('保留 DOM 直写兜底（旧宿主 / 独立演示页）', persist.includes('applyWidthToDom'))
  check('最小 / 最大宽度与官方 264–420 一致',
    persist.includes('MIN_SIDEBAR_WIDTH = 264') && persist.includes('MAX_SIDEBAR_WIDTH = 420'))
  check('默认宽度 280（与官方 SIDEBAR_DEFAULT 一致）', persist.includes('DEFAULT_SIDEBAR_WIDTH = 280'))
  check('拖拽结束有静默窗口（防 guard 用旧值把宽度弹回）', persist.includes('settleUntil') && persist.includes('inSettleWindow'))
  check('官方 data-dragging 期间不动宽度', persist.includes('isOfficialDragging'))
  check('导出给 Bot 侧栏复用的 API', persist.includes('export function setSidebarWidth')
    && persist.includes('export function persistSidebarWidth')
    && persist.includes('export function readStoredSidebarWidth'))
}

/* ── 2. Bot 模式侧栏手柄 ────────────────────────────────────────────────── */
console.log('[sidebar-width] Bot 模式 .pa-sidebar')
{
  const sidebar = read('src/client/personal/shell/Sidebar.tsx')
  const base = read('src/client/personal/base.css.ts')
  check('渲染右缘拖拽手柄', sidebar.includes('pa-sidebar__resizer')
    && sidebar.includes('aria-label="拖拽调整侧栏宽度"'))
  check('拖拽中直改 --pa-sidebar-w（不逐帧 setState）',
    sidebar.includes("root.style.setProperty('--pa-sidebar-w'"))
  check('松手持久化并同步官方 store', sidebar.includes('persistSidebarWidth(latest)')
    && sidebar.includes('setSidebarWidth(latest)'))
  check('双击手柄恢复默认宽度', sidebar.includes('onDoubleClick={resetSidebarWidth}')
    && sidebar.includes('DEFAULT_SIDEBAR_WIDTH'))
  check('侧栏隐藏（宽度 0）时不进入拖拽', sidebar.includes('if (!(startWidth > 0)) return'))
  check('手柄样式存在（8px 热区 / col-resize）', base.includes('.pa-sidebar__resizer')
    && base.includes('cursor: col-resize'))
  check('折叠态不显示手柄', base.includes(".pa-sidebar[data-collapsed='true'] .pa-sidebar__resizer { display: none; }"))
  check('拖拽中禁用宽度补间与文字选中', base.includes("body[data-pa-sidebar-resizing='true'] .pa-sidebar")
    && base.includes("body[data-pa-sidebar-resizing='true'] {"))
}

/* ── 3. 挂载链 ─────────────────────────────────────────────────────────── */
console.log('[sidebar-width] 挂载链')
{
  const index = read('src/client/index.ts')
  check('persist 仍由 client apply 挂载并传入 ctx', index.includes('applySidebarWidthPersist(ctx)'))
  check('Bot 侧栏仍由 PersonalApp 常驻渲染（拖拽手柄不会被模式切换卸载）',
    read('src/client/personal/index.tsx').includes('installWorkSidebarWidthSync((px) =>'))
}

if (failed > 0) {
  console.error(`\n[sidebar-width] ${failed} 项失败`)
  process.exit(1)
}
console.log('\n[sidebar-width] 全部通过')
