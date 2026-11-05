/**
 * 桌面控制 MCP 实时画面与执行态卡离线测试。
 *
 * 覆盖：
 *  1. 桌面控制工具判据：isDesktopControlTool 识别 mcp__*desktop*、mcp__*computer*、computer 等；
 *  2. 执行态工具判据：isExecutionToolName 包含桌面控制 MCP 并排除普通工具；
 *  3. 宿主端屏幕截图服务：captureDesktopScreen 能返回有效 JPEG 二进制流，且具备防抖缓存；
 *  4. 源码接线断言：index.ts 挂载 /desktop-screen 路由，MessageBlockView 引用 isDesktopControlTool
 *     与 /desktop-screen，chat.css.ts 包含 pa-exec__live-tag 等样式。
 *
 * 用法：node scripts/test-desktop-screen.mjs
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const failures = []
const check = (name, condition, extra) => {
  if (condition) {
    console.log('ok    ' + name)
    return
  }
  failures.push(name)
  const suffix = extra === undefined || extra === '' ? '' : ' — ' + extra
  console.log('FAIL  ' + name + suffix)
}

/* ------------------------------------------------------------------ */
/* 1. 编译并测试判据                                                    */
/* ------------------------------------------------------------------ */
const visOutfile = resolve(ROOT, '_tmp', 'build', 'test-vis-desktop.mjs')
await build({
  entryPoints: [resolve(ROOT, 'src/client/personal/chat/message-visibility.ts')],
  outfile: visOutfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: ['es2020'],
  logLevel: 'silent',
})

const { isDesktopControlTool, isExecutionToolName, parseMcpToolName } = await import(pathToFileURL(visOutfile).href)

check('parseMcpToolName 解析标准三段',
  JSON.stringify(parseMcpToolName('mcp__desktop-control__mouse_click')) === JSON.stringify({ service: 'desktop-control', tool: 'mouse_click' }))
check('parseMcpToolName 非 mcp 返回 null', parseMcpToolName('run_code') === null)

check('isDesktopControlTool(mcp__desktop-control__click) → true',
  isDesktopControlTool('mcp__desktop-control__click') === true)
check('isDesktopControlTool(mcp__computer-use__action) → true',
  isDesktopControlTool('mcp__computer-use__action') === true)
check('isDesktopControlTool(mcp__windows-control__type_text) → true',
  isDesktopControlTool('mcp__windows-control__type_text') === true)
check('isDesktopControlTool(computer) → true',
  isDesktopControlTool('computer') === true)
check('isDesktopControlTool(screenshot) → true',
  isDesktopControlTool('screenshot') === true)
check('isDesktopControlTool(mcp__playwright-mcp__browser_click) → false',
  isDesktopControlTool('mcp__playwright-mcp__browser_click') === false)
check('isDesktopControlTool(run_code) → false',
  isDesktopControlTool('run_code') === false)

check('isExecutionToolName(mcp__desktop-control__click) → true',
  isExecutionToolName('mcp__desktop-control__click') === true)
check('isExecutionToolName(mcp__computer-use__mouse_move) → true',
  isExecutionToolName('mcp__computer-use__mouse_move') === true)
check('isExecutionToolName(mcp__playwright-mcp__browser_click) → true',
  isExecutionToolName('mcp__playwright-mcp__browser_click') === true)
check('isExecutionToolName(run_code) → false',
  isExecutionToolName('run_code') === false)
check('isExecutionToolName(pwsh) → false',
  isExecutionToolName('pwsh') === false)

/* ------------------------------------------------------------------ */
/* 2. 编译并测试宿主屏幕截图服务                                        */
/* ------------------------------------------------------------------ */
const screenOutfile = resolve(ROOT, '_tmp', 'build', 'test-host-desktop-screen.mjs')
await build({
  entryPoints: [resolve(ROOT, 'src/host/personal/desktop-screen.ts')],
  outfile: screenOutfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node18'],
  logLevel: 'silent',
})

const { captureDesktopScreen, clearDesktopScreenCache, MIN_CAPTURE_INTERVAL_MS } = await import(pathToFileURL(screenOutfile).href)

clearDesktopScreenCache()
const t0 = Date.now()
const frame1 = await captureDesktopScreen({ maxWidth: 640, quality: 50 })
const elapsed1 = Date.now() - t0

check('captureDesktopScreen 成功截取屏幕', frame1 !== null && frame1.length > 500)
check('截屏是合法 JPEG（以 0xFF, 0xD8 开头）',
  frame1 !== null && frame1[0] === 0xff && frame1[1] === 0xd8)

const t1 = Date.now()
const frame2 = await captureDesktopScreen({ maxWidth: 640, quality: 50 })
const elapsed2 = Date.now() - t1

check('短间隔请求命中缓存', frame1 === frame2 && elapsed2 < 50)

/* ------------------------------------------------------------------ */
/* 3. 源码接线断言                                                    */
/* ------------------------------------------------------------------ */
const indexSrc = readFileSync(resolve(ROOT, 'src/host/personal/index.ts'), 'utf8')
check('index.ts 引入 captureDesktopScreen', indexSrc.includes("import { captureDesktopScreen } from './desktop-screen.ts'"))
check('index.ts 注册 /desktop-screen 路由', indexSrc.includes("tail === '/desktop-screen' && method === 'GET'"))
check('index.ts 在 health 路由公布 desktop-screen', indexSrc.includes("'desktop-screen'"))

const blockViewSrc = readFileSync(resolve(ROOT, 'src/client/personal/chat/MessageBlockView.tsx'), 'utf8')
check('MessageBlockView 引入 isDesktopControlTool', blockViewSrc.includes('isDesktopControlTool'))
check('MessageBlockView 引入 IconMonitor', blockViewSrc.includes('IconMonitor'))
check('MessageBlockView 请求 /desktop-screen 路由', blockViewSrc.includes('/api/personal-agent/desktop-screen'))
check('MessageBlockView 包含 实时画面 徽标', blockViewSrc.includes('实时画面'))

const cssSrc = readFileSync(resolve(ROOT, 'src/client/personal/chat/chat.css.ts'), 'utf8')
check('chat.css.ts 包含 .pa-exec__live-tag', cssSrc.includes('.pa-exec__live-tag'))
check('chat.css.ts 包含 .pa-exec__live-dot', cssSrc.includes('.pa-exec__live-dot'))
check('chat.css.ts 包含 @keyframes pa-pulse', cssSrc.includes('@keyframes pa-pulse'))

console.log('')
if (failures.length === 0) {
  console.log('DESKTOP SCREEN & MCP CONTROL VERIFY PASSED')
} else {
  console.log('DESKTOP SCREEN & MCP CONTROL VERIFY FAILED (' + failures.length + '): ' + failures.join(', '))
  process.exitCode = 1
}
