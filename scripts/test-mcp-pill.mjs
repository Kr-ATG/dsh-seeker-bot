/**
 * dsh-seeker-bot — 侧栏「MCP服务器」胶囊的回归测试（scripts/test-mcp-pill.mjs）。
 *
 * 不启动浏览器：用 esbuild 把纯模型模块打包到临时目录后直接 import 断言；
 * 胶囊的 DOM 挂载与视觉部分由 build + 真机截图验证（依赖官方侧栏结构，
 * 无法在 node 里稳定模拟）。
 *
 * 覆盖：
 *  1. 目录 id → serverName 换算与宿主 toServerName 一致（点号换短横线、截 32 位）；
 *  2. 已装清单合并：图标 URL / 中文名 / disabled / 首字母回落 / 去重；
 *  3. 源码守卫：操作间不再注册 workbench-connectors、seat 挂了胶囊、胶囊组件含关键文案；
 *  4. 构建产物守卫：lib/client.js 含 dmp-pill / MCP服务器 / 状态与目录两个接口路径。
 *
 * Usage: node scripts/test-mcp-pill.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-seeker-bot-mcp-pill-'))
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 清理失败不改变断言 */ } })

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok   ' + name)
    return
  }
  failed += 1
  console.error('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
}

/* ── 1. 纯模型：esbuild 现场打包后 import（不依赖宿主 / DOM）────────── */

const esbuild = await import('esbuild')
const outFile = join(scratch, 'sidebar-pill-model.mjs')
await esbuild.build({
  entryPoints: [resolve(ROOT, 'src/client/triad/connectors/sidebar-pill-model.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const model = await import(pathToFileURL(outFile).href)

const { toServerName, mergeInstalledIcons } = model

check('toServerName：点号换成短横线', toServerName('agent.mail') === 'agent-mail', toServerName('agent.mail'))
check('toServerName：空格/特殊字符换成短横线', toServerName('Foo Bar!') === 'Foo-Bar-', toServerName('Foo Bar!'))
check('toServerName：截断 32 位', toServerName('a'.repeat(40)).length === 32)
check('toServerName：合法字符原样保留', toServerName('amap_weather-2') === 'amap_weather-2')

const status = {
  servers: [
    { serverName: 'amap', config: { disabled: false } },
    { serverName: 'weather', config: { disabled: true } },
    { serverName: 'custom-server', config: {} },
    { serverName: 'amap', config: {} },
  ],
}
const catalog = {
  entries: [
    { id: 'amap', name: '高德地图', iconFile: 'amap.png' },
    { id: 'weather', name: '天气', iconFile: 'weather.svg' },
    { id: 'agent.mail', name: 'Agent Mail', iconFile: 'agently-mail.svg' },
  ],
}
const items = mergeInstalledIcons(status, catalog)
check('合并：按宿主顺序、同 serverName 去重', items.length === 3, String(items.length))
check('合并：目录里的中文名 + 图标 URL',
  items[0]?.key === 'amap' && items[0]?.name === '高德地图'
  && items[0]?.iconUrl === '/api/chat-flow/mcp-icons/amap.png' && items[0]?.fallback === '高',
  JSON.stringify(items[0]))
check('合并：disabled 透传', items[1]?.key === 'weather' && items[1]?.disabled === true, JSON.stringify(items[1]))
check('合并：目录里没有的 server 回落到首字母',
  items[2]?.key === 'custom-server' && items[2]?.name === 'custom-server'
  && items[2]?.iconUrl === null && items[2]?.fallback === 'C',
  JSON.stringify(items[2]))
check('合并：空输入不抛、返回空数组',
  Array.isArray(mergeInstalledIcons({}, {})) && mergeInstalledIcons({}, {}).length === 0)

/* ── 2. 源码守卫 ─────────────────────────────────────────────────── */

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')
const nav = read('src/client/triad/hub/nav-sections.tsx')
check('操作间不再注册连接器菜单行（跳过 workbench-connectors）',
  /if \(tab\.id === 'connectors'\) return \[\]/.test(nav))

const seat = read('src/client/triad/hub/seat.ts')
check('工作台座位挂载了胶囊', seat.includes('attachConnectorPill'))
check('工作台座位挂载了弹窗宿主', seat.includes('attachConnectorModalHost'))

const pill = read('src/client/triad/connectors/sidebar-pill.tsx')
// 源码守卫必须看**代码**，不能看注释：文件头注释本身就提到「MCP服务器」和两个
// 接口路径，直接 includes 会让「删掉渲染代码测试仍绿」。
const pillCode = pill
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
check('胶囊：左侧文案是「MCP服务器」', pillCode.includes('MCP服务器'))
check('胶囊：渲染标记 data-mcp-pill', pillCode.includes('data-mcp-pill'))
check('胶囊：最多 3 个圆形图标', /MAX_AVATARS = 3/.test(pillCode))
check('胶囊：状态接口 /api/triad/mcp-status', pillCode.includes('/api/triad/mcp-status'))
check('胶囊：目录接口 /api/triad/mcp-catalog', pillCode.includes('/api/triad/mcp-catalog'))
check('胶囊：点击打开弹窗卡片（ConnectorModal）', pillCode.includes('ConnectorModal'))
const modalSrc = read('src/client/triad/connectors/ConnectorModal.tsx')
check('弹窗：使用 PopoverShell 的 modal 形态', /variant="modal"/.test(modalSrc))
check('弹窗：内容复用 ConnectorsPanel 的 inCard 形态', /ConnectorsPanel[^>]*inCard/.test(modalSrc))
check('弹窗：提供全局 openConnectorModal 入口', modalSrc.includes('export function openConnectorModal'))
check('弹窗：宿主挂在 body 上且幂等',
  modalSrc.includes("document.createElement('div')") && modalSrc.includes('attachConnectorModalHost'))
const suggestSrc = read('src/client/personal/chat/ConnectorSuggestCard.tsx')
check('Bot 推荐卡改用弹窗入口（不再 openWorkbench）',
  suggestSrc.includes('openConnectorModal') && !suggestSrc.includes('openWorkbench'))
const flyoutSrc = read('src/client/triad/hub/row-flyout.tsx')
const tabsBlock = flyoutSrc.slice(flyoutSrc.indexOf('export const WORKBENCH_TABS'), flyoutSrc.indexOf('] as const'))
check('工作台分类不再包含连接器（MCP 只以弹窗出现）', !/id: 'connectors'/.test(tabsBlock))

const panelSrc = read('src/client/triad/connectors/Panel.tsx')
check('分类精简：18 个细分类合并为 6 个大组',
  ['系统能力', '办公协作', '开发工具', '内容设计', '搜索与数据', '生活出行']
    .every((label) => panelSrc.includes(`label: '${label}'`)))

const botSidebar = read('src/client/personal/shell/Sidebar.tsx')
check('Bot 侧栏：底部渲染了胶囊且传 checkRail={false}',
  botSidebar.includes('ConnectorPill checkRail={false}'))
check('Bot 侧栏：设置行包在 pa-sidebar__bottom-row', botSidebar.includes('pa-sidebar__bottom-row'))

/* ── 3. 构建产物守卫 ─────────────────────────────────────────────── */

const bundlePath = resolve(ROOT, 'lib/client.js')
const bundle = readFileSync(bundlePath, 'utf8')
check('产物：含胶囊样式类 dmp-pill', bundle.includes('dmp-pill'))
// esbuild 默认 charset=ascii，中文会写成 \u670D\u52A1\u5668 转义序列。
check('产物：含胶囊文案', /MCP(?:服务器|\\u670D\\u52A1\\u5668)/.test(bundle))
check('产物：含样式表 id', bundle.includes('dsh-mcp-pill-styles'))
check('产物：含状态接口路径', bundle.includes('/api/triad/mcp-status'))
check('产物：含 Bot 侧栏底部行', bundle.includes('pa-sidebar__bottom-row'))

if (failed > 0) {
  console.error('\n' + String(failed) + ' 项失败')
  process.exit(1)
}
console.log('\n全部通过')
