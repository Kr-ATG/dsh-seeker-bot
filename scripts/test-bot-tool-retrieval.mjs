/**
 * dsh-seeker-bot — Bot 模式动态工具检索的回归测试（scripts/test-bot-tool-retrieval.mjs）。
 *
 * 覆盖 `src/host/personal/tool-retrieval.ts` 的全部可观察行为：
 *
 *  1. 分词：英文/数字按词，中文按 2-gram（「北京天气」要切出「天气」）；
 *  2. 分流：只有 `mcp__*` 进检索池；核心工具与 cua 等宿主原生能力永远常驻；
 *  3. 中文 query 命中英文描述：靠命名空间别名表，不靠描述本身；
 *  4. 无关 query 不注入可检索工具，但生成目录（模型要知道「还有什么」）；
 *  5. 组级保底：提到了某个 server 就至少给一个工具，不让整台 server 消失；
 *  6. `search_tools` 的 pinned 强制注入；
 *  7. 抖动抑制：同一话题沿用上一轮集合，话题切换才重算；
 *  8. 关闭开关 / 无意图 / 空工具表时原样放行；
 *  9. 纯函数性：不改入参。
 *
 * ── 为什么用 esbuild 现场打包 ────────────────────────────────────────
 * 源码是 .ts、`lib/index.js` 是整插件单文件，两者都不能按模块 import。这里用
 * esbuild（本仓库 devDependency）把检索器打成一个临时 ESM 包再 import，断言的
 * 是**真正会跑的那份源码**。
 *
 * Usage: node scripts/test-bot-tool-retrieval.mjs
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
const pass = (msg) => console.log('ok    ' + msg)
const fail = (msg) => { console.error('FAIL  ' + msg); failed += 1 }
const assert = (cond, msg) => { if (cond) pass(msg); else fail(msg) }
const assertEqual = (actual, expected, msg) => {
  if (actual === expected) pass(msg)
  else fail(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

/** Windows 路径 → import URL 可用的正斜杠形式。 */
const slash = (p) => p.replace(/[\\]/g, '/')

// ── 1. 现场打包检索器 ───────────────────────────────────────────────────
const OUT_DIR = resolve(ROOT, '_tmp', 'test-bot-tool-retrieval-bundle')
try { rmSync(OUT_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
mkdirSync(OUT_DIR, { recursive: true })

const entryFile = join(OUT_DIR, 'entry.ts')
writeFileSync(
  entryFile,
  [
    `export * from '${slash(resolve(ROOT, 'src/host/tool-retrieval/engine.ts'))}'`,
    `export { applyToolRetrieval, setToolRetrievalEnabled, SEARCH_TOOL } from '${slash(resolve(ROOT, 'src/host/tool-retrieval/index.ts'))}'`,
    `export { __personalAgentTest } from '${slash(resolve(ROOT, 'src/host/personal/agent.ts'))}'`,
    '',
  ].join('\n'),
  'utf8',
)
const bundleFile = join(OUT_DIR, 'retrieval.mjs')
await build({
  entryPoints: [entryFile],
  outfile: bundleFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
})

const mod = await import(pathToFileURL(bundleFile).href)
const {
  tokenize,
  noteQuery,
  pinTool,
  projectTools,
  searchPool,
  retrievalState,
  resetRetrieval,
  readSessionQuery,
  DEFAULT_RETRIEVAL,
  applyToolRetrieval,
  setToolRetrievalEnabled,
  SEARCH_TOOL,
  __personalAgentTest,
  __retrievalTest,
} = mod

// ── 2. 测试夹具 ─────────────────────────────────────────────────────────
const TOOLS = [
  { name: 'read', description: 'Read a file from disk' },
  { name: 'write', description: 'Write a file' },
  { name: 'pwsh', description: 'Run a PowerShell command' },
  { name: 'bot_emit', description: 'Emit a message to the user' },
  { name: 'search_tools', description: 'Search tools that are not loaded yet' },
  { name: 'mcp__amap__maps_weather', description: 'Get weather forecast for a city' },
  { name: 'mcp__amap__maps_geo', description: 'Convert a structured address to coordinates' },
  { name: 'mcp__amap__maps_text_search', description: 'Search places by keyword' },
  { name: 'mcp__agently-mail__mail_send', description: 'Send an email' },
  { name: 'mcp__agently-mail__mail_list', description: 'List emails in a folder' },
  { name: 'cua_driver_native__screenshot', description: 'Take a screenshot of the desktop' },
]

const CORE = ['read', 'write', 'pwsh', 'bot_emit', 'search_tools']
const names = (list) => list.map((tool) => tool.name)

/** 用独立 botId 隔离每个用例（状态是按 botId 存的）。 */
let caseId = 0
const freshBot = () => `bot-case-${++caseId}`

// ── 3. 分词 ─────────────────────────────────────────────────────────────
{
  const zh = tokenize('北京天气')
  assert(zh.has('北京'), '中文 2-gram：切出「北京」')
  assert(zh.has('天气'), '中文 2-gram：切出「天气」')
  assert(zh.has('京天'), '中文 2-gram：相邻字也切（噪声可接受，漏召回不可接受）')

  const en = tokenize('Get Weather forecast')
  assert(en.has('weather') && en.has('forecast'), '英文按词切分并小写化')
  assert(!tokenize('go to a b').has('a'), '单字英文 token 被丢弃（噪声太大）')

  assertEqual(tokenize('  ').size, 0, '空串切出空集')
}

// ── 4. 分流：核心工具永远常驻 ───────────────────────────────────────────
{
  const bot = freshBot()
  noteQuery(bot, '北京天气怎么样')
  const out = projectTools({ tools: TOOLS, sections: [] }, bot)

  const kept = names(out.tools)
  for (const core of CORE) assert(kept.includes(core), `核心工具 ${core} 常驻（不参与检索）`)
  assert(kept.includes('mcp__amap__maps_weather'), '中文「天气」经别名表命中英文描述的 weather 工具')
  assert(!kept.includes('mcp__agently-mail__mail_send'), '无关的邮件工具被移出可见集')
  assert(kept.includes('cua_driver_native__screenshot'), '电脑操作工具常驻（只对 MCP 做延迟加载）')
  assert(out.removed.includes('mcp__agently-mail__mail_send'), '被移除的工具记进 removed')
}

// ── 5. 目录：告诉模型「还有什么」 ───────────────────────────────────────
{
  const bot = freshBot()
  noteQuery(bot, '北京天气怎么样')
  const out = projectTools({ tools: TOOLS, sections: [] }, bot)

  const catalog = out.sections.find((section) => section.name === 'tool-retrieval:catalog')
  assert(catalog !== undefined, '生成工具目录段')
  const text = String(catalog?.text ?? '')
  assert(text.includes('agently-mail'), '目录按组列出未注入的 server')
  assert(text.includes('search_tools'), '目录告诉模型可以用 search_tools 捞回来')
  assert(text.includes('不要假装调用了未注入的工具'), '目录明确禁止假装调用')

  const onlyCore = projectTools({ tools: TOOLS.filter((tool) => CORE.includes(tool.name)), sections: [] }, freshBot())
  assertEqual(onlyCore.sections.length, 0, '没有可检索工具时不追加目录（一个字都不加）')
}

// ── 6. 组级保底：提到就至少给一个 ───────────────────────────────────────
{
  const bot = freshBot()
  noteQuery(bot, '帮我用地图查一下这个地方')
  const out = projectTools({ tools: TOOLS, sections: [] }, bot)
  const amap = names(out.tools).filter((name) => name.startsWith('mcp__amap__'))
  assert(amap.length >= 1, '提到「地图」时 amap 组至少注入一个工具（不让整台 server 消失）')
}

// ── 7. pinned：search_tools 的强制注入 ──────────────────────────────────
{
  const bot = freshBot()
  noteQuery(bot, '随便聊两句')
  pinTool(bot, 'mcp__amap__maps_geo')
  const out = projectTools({ tools: TOOLS, sections: [] }, bot)
  assert(names(out.tools).includes('mcp__amap__maps_geo'), '被 search_tools 点名的工具强制注入（无视打分）')
}

// ── 8. searchPool：检索接口本身 ─────────────────────────────────────────
{
  const weather = searchPool(TOOLS, '天气')
  assertEqual(weather[0]?.name, 'mcp__amap__maps_weather', 'searchPool 按中文别名命中 weather 工具')

  const mail = searchPool(TOOLS, '发邮件')
  assert(mail.some((tool) => tool.name === 'mcp__agently-mail__mail_send'), 'searchPool 命中发邮件工具')

  const byName = searchPool(TOOLS, 'maps_geo')
  assertEqual(byName[0]?.name, 'mcp__amap__maps_geo', 'searchPool 支持直接搜工具名')

  assertEqual(searchPool(TOOLS, '完全不相关的东西').length, 0, 'searchPool 无关 query 返回空')

  const coreOnly = searchPool(TOOLS, 'read')
  assert(!coreOnly.some((tool) => tool.name === 'read'), 'searchPool 不返回核心工具（它们本来就常驻）')
}

// ── 9. 抖动抑制：同话题沿用，换话题重算 ─────────────────────────────────
{
  const bot = freshBot()
  noteQuery(bot, '北京天气怎么样')
  const first = projectTools({ tools: TOOLS, sections: [] }, bot)
  assert(names(first.tools).includes('mcp__amap__maps_weather'), '首轮：命中 weather')

  noteQuery(bot, '北京天气明天呢')
  const second = projectTools({ tools: TOOLS, sections: [] }, bot)
  assert(names(second.tools).includes('mcp__amap__maps_weather'), '同话题第二轮：沿用上一轮集合')

  const state = retrievalState(bot)
  assert(state.lastSelection.includes('mcp__amap__maps_weather'), '状态里记录了上一轮的注入集合')

  noteQuery(bot, '帮我把这段代码重构一下')
  const third = projectTools({ tools: TOOLS, sections: [] }, bot)
  assert(!names(third.tools).includes('mcp__amap__maps_weather'), '换话题后不再保留旧意图的工具')
}

// ── 10. 放行路径：关闭 / 无意图 / 空表 ──────────────────────────────────
{
  const bot = freshBot()
  noteQuery(bot, '北京天气怎么样')
  const off = projectTools({ tools: TOOLS, sections: [] }, bot, { ...DEFAULT_RETRIEVAL, enabled: false })
  assertEqual(off.tools.length, TOOLS.length, '开关关闭时原样放行（全量注入）')
  assertEqual(off.removed.length, 0, '开关关闭时不记 removed')

  const noIntent = projectTools({ tools: TOOLS, sections: [] }, freshBot())
  assertEqual(noIntent.tools.length, TOOLS.length, '没有意图信息时原样放行（首轮不误伤）')

  const empty = projectTools({ tools: [], sections: [] }, bot)
  assertEqual(empty.tools.length, 0, '空工具表原样放行')
}

// ── 11. 纯函数性：不改入参 ──────────────────────────────────────────────
{
  const bot = freshBot()
  noteQuery(bot, '北京天气怎么样')
  const tools = TOOLS.map((tool) => ({ ...tool }))
  const sections = [{ name: 'keep:me', text: 'x' }]
  const toolsSnapshot = JSON.stringify(tools)
  const sectionsSnapshot = JSON.stringify(sections)
  projectTools({ tools, sections }, bot)
  assertEqual(JSON.stringify(tools), toolsSnapshot, '投影不改入参 tools')
  assertEqual(JSON.stringify(sections), sectionsSnapshot, '投影不改入参 sections')

  const out = projectTools({ tools, sections }, freshBot())
  assertEqual(out.sections.length, sections.length, '无意图时保留原有 sections')
  assertEqual(out.sections[0]?.name, 'keep:me', '原有 sections 内容不变')
}

// ── 12. 上限：maxRetrieved / maxPerGroup ────────────────────────────────
{
  const many = []
  for (let i = 0; i < 30; i += 1) many.push({ name: `mcp__amap__tool_${i}`, description: '地图 天气 路线' })
  const bot = freshBot()
  noteQuery(bot, '地图 天气 路线')
  const out = projectTools({ tools: many, sections: [] }, bot, { ...DEFAULT_RETRIEVAL, maxRetrieved: 5, maxPerGroup: 3 })
  assertEqual(out.tools.length, 3, '按 maxPerGroup 限流（单组最多 3 个）')

  const twoGroups = [...many, ...Array.from({ length: 10 }, (_, i) => ({ name: `mcp__agently-mail__tool_${i}`, description: '邮件 地图' }))]
  const bot2 = freshBot()
  noteQuery(bot2, '地图 天气 路线')
  const out2 = projectTools({ tools: twoGroups, sections: [] }, bot2, { ...DEFAULT_RETRIEVAL, maxRetrieved: 5, maxPerGroup: 3 })
  assert(out2.tools.length <= 5, '按 maxRetrieved 限流（总数不超过 5）')
}

// ── 13. Bot 侧：agentCtx 的 trim 钩子（只摘宿主 UI 工具）────────────────
{
  const { installBotToolTrim } = __personalAgentTest
  const listeners = []
  const agentCtx = {
    on(event, fn) { if (event === 'system-prompt/assemble') listeners.push(fn) },
  }
  installBotToolTrim(agentCtx)
  assertEqual(listeners.length, 1, 'Bot 装上一个 system-prompt/assemble 监听器')

  const withAsk = [...TOOLS, { name: 'ask_user_question', description: 'Ask the user a question' }]
  const out = await listeners[0]({}, {}, async () => ({ tools: withAsk, sections: [] }))
  const kept = names(out.tools)
  assert(!kept.includes('ask_user_question'), 'Bot 钩子摘掉宿主交互工具 ask_user_question')
  assertEqual(kept.length, TOOLS.length, 'Bot 钩子不动其它工具（检索已移到 root ctx）')
}

// ── 14. root ctx：Work 与 Bot 共用的检索钩子 ────────────────────────────
{
  const listeners = []
  const registered = []
  const rootCtx = {
    on(event, fn) { if (event === 'system-prompt/assemble') listeners.push(fn) },
    inject(_names, callback) {
      callback({
        tools: {
          register(definition) { registered.push(definition); return () => {} },
          schemas() { return TOOLS },
        },
      })
    },
    logger: { info() {}, warn() {} },
  }
  applyToolRetrieval(rootCtx)
  assertEqual(listeners.length, 1, 'root 装上一个 system-prompt/assemble 监听器')

  const searchTool = registered.find((definition) => definition?.name === SEARCH_TOOL)
  assert(searchTool !== undefined, 'root 注册了 search_tools 工具')
  assert(
    Array.isArray(searchTool?.parameters?.required) && searchTool.parameters.required.includes('query'),
    'search_tools 声明了必填 query 参数',
  )

  // 用假 session 提供 Work 模式的意图（真实来源是 session.deriveMessages）
  const session = {
    id: 'session-work-1',
    deriveMessages() {
      return [
        { role: 'user', content: [{ type: 'text', text: '北京天气怎么样' }] },
        { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
      ]
    },
  }
  const out = await listeners[0]({}, { agent: { session } }, async () => ({ tools: TOOLS, sections: [] }))
  const kept = names(out.tools)
  assert(kept.includes('mcp__amap__maps_weather'), 'Work 会话按意图注入 weather 工具')
  assert(!kept.includes('mcp__agently-mail__mail_send'), 'Work 会话移出无关 MCP 工具')
  assert(
    Array.isArray(out.sections) && out.sections.some((section) => section?.name === 'tool-retrieval:catalog'),
    'Work 会话也追加工具目录段',
  )

  const hit = await searchTool.execute({ query: '天气' }, { agent: { session } })
  assert(String(hit).includes('maps_weather'), 'search_tools 返回命中的工具名')
  assert(!String(hit).includes('parameters'), 'search_tools 不返回 schema（省下的 token 不再塞回去）')

  const after = await listeners[0]({}, { agent: { session } }, async () => ({ tools: TOOLS, sections: [] }))
  assert(names(after.tools).includes('mcp__amap__maps_weather'), 'search_tools 点名后下一步强制注入')
}

// ── 15. 放行路径：没有 agent / 没有会话 id 时不动 ───────────────────────
{
  const listeners = []
  applyToolRetrieval({
    on(event, fn) { if (event === 'system-prompt/assemble') listeners.push(fn) },
    inject() {},
    logger: {},
  })
  const noAgent = await listeners[0]({}, {}, async () => ({ tools: TOOLS, sections: [] }))
  assertEqual(noAgent.tools.length, TOOLS.length, '没有 agent 时原样放行（标题生成等服务级组装）')

  const noSession = await listeners[0]({}, { agent: {} }, async () => ({ tools: TOOLS, sections: [] }))
  assertEqual(noSession.tools.length, TOOLS.length, '没有会话 id 时原样放行（不跨会话共享状态）')
}

// ── 16. 从会话历史读意图（Work 模式的意图来源）──────────────────────────
{
  const session = {
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '我在做一个地图相关的东西' }] },
      { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
      { role: 'user', content: [{ type: 'text', text: '北京天气怎么样' }, { type: 'image' }] },
    ],
  }
  const query = readSessionQuery(session)
  assert(query.includes('北京天气怎么样'), '提取最近一条用户输入')
  assert(query.includes('地图相关'), '连带上一条（多轮里用户先给背景再说诉求）')
  assert(!query.includes('收到'), '不把 assistant 内容当意图')
  assertEqual(readSessionQuery(undefined), '', '没有 session 时返回空')
  assertEqual(readSessionQuery({ deriveMessages() { throw new Error('boom') } }), '', 'session 抛错时返回空而不是抛穿')
}

// ── 17. 挂载失败不抛穿 ──────────────────────────────────────────────────
{
  const { installBotToolTrim } = __personalAgentTest
  let threw = false
  try {
    installBotToolTrim({})
    installBotToolTrim({ on() {} })
    // root 侧缺 on / 缺 inject 都不该炸
    applyToolRetrieval({})
    applyToolRetrieval({ on() {}, logger: {} })
  } catch {
    threw = true
  }
  assert(!threw, 'ctx 缺 on / inject 时安装函数不抛穿')

  // 钩子里检索器抛错时，应原样放行而不是把整轮请求带崩
  const listeners = []
  applyToolRetrieval({
    on(event, fn) { if (event === 'system-prompt/assemble') listeners.push(fn) },
    inject() {},
    logger: {},
  })
  const brokenSession = {
    id: 'session-broken',
    deriveMessages() { throw new Error('boom') },
  }
  const out = await listeners[0]({}, { agent: { session: brokenSession } }, async () => ({ tools: TOOLS, sections: [] }))
  assertEqual(out.tools.length, TOOLS.length, '检索器异常时原样放行（全量注入，不误伤）')
}

// ── 18. 开关：关掉后不再注册 search_tools ───────────────────────────────
{
  const registered = []
  setToolRetrievalEnabled(false)
  applyToolRetrieval({
    on() {},
    inject(_names, callback) { callback({ tools: { register(definition) { registered.push(definition); return () => {} } } }) },
    logger: {},
  })
  assertEqual(registered.length, 0, '开关关闭时不注册 search_tools')
  setToolRetrievalEnabled(true)
}

// ── 19. 状态清理：删除后同一 id 重建不带旧意图 ──────────────────────────
{
  const bot = freshBot()
  noteQuery(bot, '北京天气怎么样')
  projectTools({ tools: TOOLS, sections: [] }, bot)
  assert(retrievalState(bot).tokenCount > 0, '删除前有检索状态')

  resetRetrieval(bot)
  assertEqual(retrievalState(bot).tokenCount, 0, '清理后状态归零（同一 id 重建不会带旧意图）')
}

// ── 16. 映射表覆盖率：catalog 里每个 server 都要有中文别名 ──────────────
{
  const catalogPath = resolve(ROOT, 'assets/mcp-catalog/catalog.json')
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  const { hintsOfGroup } = __retrievalTest
  const missing = []
  for (const entry of catalog.entries) {
    const hints = hintsOfGroup(`mcp__${entry.id}`)
    if (hints.primary.size === 0 && hints.others.size === 0) missing.push(entry.id)
  }
  assertEqual(
    missing.length,
    0,
    `catalog ${catalog.entries.length} 个 server 全部有中文别名${missing.length > 0 ? `（缺：${missing.join(', ')}）` : ''}`,
  )

  assert(__retrievalTest.zhEnKeys.length >= 100, `中英对照表 ≥100 词（实得 ${__retrievalTest.zhEnKeys.length}）`)
  assert(__retrievalTest.namespaceHintKeys.length >= 50, `组级别名 ≥50 组（实得 ${__retrievalTest.namespaceHintKeys.length}）`)
  assert(__retrievalTest.toolHintKeys.length >= 25, `工具级别名 ≥25 条（实得 ${__retrievalTest.toolHintKeys.length}）`)
}

// ── 17. 工具级别名：同组内能区分出「精确的那个」 ────────────────────────
{
  const { hintsOfTool } = __retrievalTest
  assert(hintsOfTool('mcp__amap__maps_weather').has('天气'), 'maps_weather 命中「天气」')
  assert(!hintsOfTool('mcp__amap__maps_geo').has('天气'), 'maps_geo 不命中「天气」（组级区分不开，工具级能）')
  assert(hintsOfTool('mcp__agently-mail__mail_send').has('发信'), 'mail_send 命中「发信」')
  assert(hintsOfTool('mcp__github__create_issue').has('issue'), 'create_issue 命中「issue」')
}

// ── 18. 跨 server 真实场景：每组意图都要落到对的工具 ────────────────────
{
  const MULTI = [
    { name: 'read', description: 'Read a file from disk' },
    { name: 'mcp__amap__maps_weather', description: 'Get weather forecast for a city' },
    { name: 'mcp__amap__maps_geo', description: 'Convert a structured address to coordinates' },
    { name: 'mcp__amap__maps_direction_driving', description: 'Plan a driving route between two points' },
    { name: 'mcp__amap__maps_direction_transit_integrated', description: 'Plan a public transit route' },
    { name: 'mcp__amap__maps_around_search', description: 'Search POI around a location' },
    { name: 'mcp__amap__maps_distance', description: 'Measure distance between coordinates' },
    { name: 'mcp__baidu-map__map_search', description: 'Search places on Baidu map' },
    { name: 'mcp__agently-mail__mail_send', description: 'Send an email' },
    { name: 'mcp__agently-mail__mail_list', description: 'List emails in a folder' },
    { name: 'mcp__github__create_issue', description: 'Create an issue in a repository' },
    { name: 'mcp__github__create_pull_request', description: 'Create a pull request' },
    { name: 'mcp__playwright-mcp__browser_navigate', description: 'Navigate to a URL in the browser' },
    { name: 'mcp__playwright-mcp__browser_click', description: 'Click an element on the page' },
    { name: 'cua_driver_native__screenshot', description: 'Take a screenshot of the desktop' },
  ]
  const topPool = (query) => {
    const bot = freshBot()
    noteQuery(bot, query)
    const out = projectTools({ tools: MULTI, sections: [] }, bot)
    // 只看 MCP 检索结果：cua 等宿主原生能力现在常驻，不参与排序
    return names(out.tools).filter((name) => name.startsWith('mcp__'))
  }

  assertEqual(topPool('北京今天天气怎么样')[0], 'mcp__amap__maps_weather', '「天气」落到 weather 而不是 geo')
  assertEqual(topPool('开车从北京到上海怎么走')[0], 'mcp__amap__maps_direction_driving', '「开车」落到驾车路线')
  assertEqual(topPool('坐地铁去天安门')[0], 'mcp__amap__maps_direction_transit_integrated', '「坐地铁」落到公交路线')
  assertEqual(topPool('附近有什么好吃的')[0], 'mcp__amap__maps_around_search', '「附近」落到周边搜索')
  assertEqual(topPool('这两个地方多远')[0], 'mcp__amap__maps_distance', '「多远」落到距离测量')
  assertEqual(topPool('发封邮件给张三')[0], 'mcp__agently-mail__mail_send', '「发邮件」落到 mail_send')
  assertEqual(topPool('提一个 issue 给这个仓库')[0], 'mcp__github__create_issue', '「issue + 仓库」落到 create_issue')
  assertEqual(topPool('打开浏览器访问这个网站')[0], 'mcp__playwright-mcp__browser_navigate', '「打开浏览器」落到 navigate')
  assertEqual(topPool('截个屏给我看看').length, 0, '「截个屏」不误拉 MCP 工具（电脑操作已常驻，不参与检索）')
  assertEqual(topPool('用百度地图查一下')[0], 'mcp__baidu-map__map_search', '「百度地图」落到百度而不是高德')
}

// ── 收尾 ────────────────────────────────────────────────────────────────
try { rmSync(OUT_DIR, { recursive: true, force: true }) } catch { /* 清理失败不影响断言 */ }

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}
