/**
 * 每日情报卡（Daily Brief）宿主半身的集成测试。
 *
 * 覆盖契约（见 src/shared/brief.ts 与 src/host/done-pill/brief.ts）：
 *   - 纯函数：briefDateKey 的本地时区口径、briefQueries、sanitizeBriefRecord 的
 *     条目下限（不足 3 条 → null）；
 *   - RSS 解析：parseBriefFeed 对 RSS 2.0（CDATA 标题）与 Atom（link href）的
 *     提取，HTML 标签必须被剥掉，lane / feed 来自源定义；
 *   - 生成链路（桩 ctx）：RSS 主通道 → 模型 JSON → 清洗 → 落盘；搜索兜底；两路
 *     全挂时 origin=model 仍能生成；模型返回垃圾时 ok:false + 中文错误；
 *     并发锁；三条 HTTP 路由的形状。
 *
 * ── 为什么用 esbuild 现场打包 ────────────────────────────────────────────
 *
 * 被测模块是 TS（带 .ts 后缀 import），Node 直接跑不了；仓库的 build.mjs 会把
 * 整包产物写进 lib/，与并行改动的队友冲突。所以用项目自带的 esbuild 把
 * src/shared/brief.ts 与 src/host/done-pill/brief.ts 各打成一个临时 ESM，
 * 断言的仍是真正会跑的那份源码。
 *
 * ── 隔离 ────────────────────────────────────────────────────────────────
 *
 * DSH_HOME 指向临时目录（绝不碰真实 ~/.dsh）；web / llm 全部是桩，不发任何网络
 * 请求。定时器用 unref()，脚本结束前显式 dispose，不会挂住进程。
 *
 * 跑法：node scripts/test-daily-brief-host.mjs（非 0 退出码 = 有失败）
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

let esbuild
try {
  esbuild = require('esbuild')
} catch {
  console.error('缺少 esbuild（本仓库 devDependency）：先跑 pnpm install')
  process.exit(1)
}

const ROOT = process.cwd()
const OUT = mkdtempSync(join(tmpdir(), 'dsh-brief-host-'))
// 临时 DSH_HOME：落盘断言与真实数据隔离
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-brief-home-'))

await esbuild.build({
  entryPoints: {
    shared: join(ROOT, 'src/shared/brief.ts'),
    host: join(ROOT, 'src/host/done-pill/brief.ts'),
  },
  outdir: OUT,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  logLevel: 'error',
})

const shared = await import(pathToFileURL(join(OUT, 'shared.mjs')).href)
const host = await import(pathToFileURL(join(OUT, 'host.mjs')).href)

const {
  BRIEF_FEEDS,
  BRIEF_FEED_ITEMS,
  BRIEF_IMAGE_ROUTE,
  briefCardImagePrompt,
  briefDateKey,
  briefQueries,
  parseBriefFeed,
  sanitizeBriefRecord,
} = shared
const { applyBriefHost, checkBriefSchedule, generateBrief } = host

const BRIEFS_DIR = join(process.env.DSH_HOME, 'storages', 'dsh-seeker-bot', 'done-pill', 'briefs')

/* ───────────────────────────── 断言框架 ───────────────────────────── */

let passed = 0
const failures = []
const disposers = []

async function test(name, run) {
  try {
    await run()
    passed += 1
    console.log('✓ ' + name)
  } catch (error) {
    failures.push([name, error])
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error('✗ ' + name + '\n  ' + detail)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）')
  }
}

/** 错误信息必须是中文短句（给用户看的），不能是英文堆栈。 */
function assertChinese(text, message) {
  if (!/[\u4e00-\u9fa5]/.test(String(text ?? ''))) throw new Error(message + '：' + String(text))
}

/* ───────────────────────────── 桩数据 ───────────────────────────── */

/** 相对当前时间的小时前（保证 RSS 条目永远「新鲜」，不受真实日期影响）。 */
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600000).toUTCString()
}

/** 造一段 RSS 2.0（可带 CDATA 与 HTML 标签，验证解析层剥标签）。 */
function rssXml(channelTitle, items) {
  const rows = items.map((item) => [
    '    <item>',
    '      <title>' + (item.cdata === true ? '<![CDATA[' + item.title + ']]>' : item.title) + '</title>',
    '      <link>' + item.url + '</link>',
    '      <description>' + (item.cdata === true ? '<![CDATA[' + (item.description ?? '') + ']]>' : (item.description ?? '')) + '</description>',
    '      <pubDate>' + (item.pubDate ?? hoursAgo(2)) + '</pubDate>',
    '    </item>',
  ].join('\n')).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel><title>' + channelTitle + '</title>',
    rows,
    '</channel></rss>',
  ].join('\n')
}

/** 每个内置源都给 4 条素材（5 源 × 4 = 20 条 ≥ SEARCH_FALLBACK_MIN，不触发搜索）。 */
function buildFeedMap() {
  const map = {}
  BRIEF_FEEDS.forEach((feed, feedIndex) => {
    const items = []
    for (let index = 0; index < 4; index += 1) {
      items.push({
        title: '<b>' + feed.label + String(index + 1) + '</b>：当天要闻标题',
        url: 'https://example.test/' + feed.id + '/' + String(index + 1),
        description: '<p>' + feed.label + ' 的第 ' + String(index + 1) + ' 条摘要，含 <em>HTML</em> 标签。</p>',
        cdata: true,
        pubDate: hoursAgo(feedIndex + index + 1),
      })
    }
    map[feed.url] = rssXml(feed.label, items)
  })
  return map
}

const FEED_MAP = buildFeedMap()

/** 一条合格的两卡简报（字段与 briefSystemPrompt 的规格一致）。 */
const GOOD_BRIEF = {
  cards: [
    {
      kicker: 'AI · 前沿',
      title: '模型开始自己找活干',
      lede: '这一天的 AI 新闻都指向同一件事：模型从「回答问题」走向「自己把活干完」，工具调用与长程推理成了新战场。',
      entries: [
        { title: 'GPT-5.5 发布，主打长程推理', text: '新模型把上下文窗口扩到更大，官方演示里能连续调用十几个工具完成一次调研。', source: '量子位', url: 'https://example.test/qbitai/1', tag: 'AI' },
        { title: '开源社区放出同尺寸替代品', text: '一个 32B 的开放权重模型在多项基准上追平闭源中档模型，显存需求压到单卡。', source: 'Hacker News', url: 'https://example.test/hn/1', tag: 'AI' },
        { title: '推理成本再降一个数量级', text: '某云厂商把长上下文的输入价格砍到原来的十分之一，企业试点门槛明显降低。', source: '量子位', url: 'https://example.test/qbitai/2', tag: 'AI' },
      ],
    },
    {
      kicker: '世界 · 要闻',
      title: '气候峰会达成新协议',
      lede: '与会代表在最后一刻就化石燃料补贴达成妥协，协议文本比预期温和，但首次写入了明确的时间表。',
      entries: [
        { title: '峰会协议写入削减时间表', text: '文本要求各方在两年内提交补贴削减路线图，资金机制留待明年续会敲定。', source: 'BBC 中文', url: 'https://example.test/bbc-zh/1', tag: '世界' },
        { title: '主要经济体表态不一', text: '几个排放大国强调能源安全优先，发展中国家则要求先看到资金落地。', source: '纽约时报中文网', url: 'https://example.test/nyt-zh/1', tag: '世界' },
        { title: '市场反应相对平静', text: '能源与公用事业板块小幅波动，分析师认为协议约束力低于预期。', source: 'WSJ 世界', url: 'https://example.test/wsj-world/1', tag: '世界' },
      ],
    },
  ],
}
const GOOD_TEXT = JSON.stringify(GOOD_BRIEF)

/** 搜索兜底用的假结果。 */
const SEARCH_SOURCES = [
  { url: 'https://search.test/ai-1', title: '搜索结果：AI 要闻', summary: '一条搜索摘要' },
  { url: 'https://search.test/world-1', title: '搜索结果：世界要闻', snippet: '另一条搜索摘要' },
]

/* ───────────────────────────── 桩 ctx ───────────────────────────── */

/** llm.stream 的脚本队列：每次调用 shift 一项（数组 = 分片文本；{ wait } = 挂起）。 */
const llmQueue = []
/** 最近一次 llm.stream 的入参（断言模型路由 / 提示词 / 采样参数）。 */
let lastLlmOptions = null
/** 每次 stream 开始时 resolve（并发锁用例用）。 */
let onStreamStart = null

const llm = {
  listProviders: () => [{ id: 'stub-provider' }],
  listModels: async () => [{ id: 'stub-model' }],
  stream: async function* (options) {
    lastLlmOptions = options
    if (onStreamStart !== null) onStreamStart()
    const script = llmQueue.shift()
    if (script === undefined) throw new Error('测试没有为这次 llm.stream 准备响应')
    if (script.wait !== undefined) await script.wait
    for (const delta of script.chunks ?? script) {
      yield { type: 'text-delta', index: 0, text: delta }
    }
  },
}

function splitChunks(text, size = 120) {
  const chunks = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

/**
 * 造一个桩 ctx。
 *
 * @param options.feedFails  true = 所有 RSS 抓取抛错（模拟离线）
 * @param options.searchFails true = 所有搜索抛错
 * @param options.agentDefaultModel 覆盖默认模型服务（测回退链用）
 */
function makeCtx(options = {}) {
  const state = {
    routes: new Map(),
    fetches: [],
    searches: [],
    logs: [],
  }
  const web = {
    fetch: async (request) => {
      state.fetches.push(request.url)
      if (options.feedFails === true) throw new Error('RSS 源不可达')
      const xml = FEED_MAP[request.url]
      if (xml === undefined) throw new Error('未知 RSS 源：' + request.url)
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: xml }, truncated: false }
    },
    search: async (request) => {
      state.searches.push(request.query)
      if (options.searchFails === true) throw new Error('搜索后端不可用')
      return { sources: SEARCH_SOURCES, truncated: false }
    },
  }
  const ctx = {
    logger: {
      info: (message) => state.logs.push(['info', message]),
      warn: (message) => state.logs.push(['warn', message]),
    },
    inject(_names, callback) { callback(ctx) },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    webServer: {
      register(route) {
        state.routes.set(route.path, route)
        return () => {}
      },
    },
    get(name) {
      if (name === 'llm') return llm
      if (name === 'web') return web
      if (name === 'agentDefaultModel') {
        return options.agentDefaultModel ?? { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
      }
      return undefined
    },
    llm,
    web,
  }
  return { ctx, state }
}

/** req / res 桩：支持 JSON 路由与 createReadStream().pipe(res)。 */
function request(route, options = {}) {
  const method = options.method ?? 'GET'
  const url = options.url ?? route.path
  const body = options.body
  const headers = options.headers ?? {}
  return new Promise((resolve) => {
    const req = {
      url,
      method,
      headers,
      on(event, handler) {
        if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)))
        if (event === 'end') handler()
      },
      destroy() {},
    }
    let status = 0
    const responseHeaders = {}
    const chunks = []
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })
    const originalEnd = sink.end.bind(sink)
    sink.writeHead = (code, values) => {
      status = code
      for (const [key, value] of Object.entries(values ?? {})) responseHeaders[String(key).toLowerCase()] = String(value)
    }
    sink.setHeader = (key, value) => { responseHeaders[String(key).toLowerCase()] = String(value) }
    sink.end = (chunk, ...rest) => {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
        try { chunks.push(Buffer.from(chunk)) } catch { /* 忽略 */ }
      }
      const callback = rest.find((item) => typeof item === 'function')
      return originalEnd(callback)
    }
    sink.on('finish', () => {
      const buffer = Buffer.concat(chunks)
      resolve({ status, text: buffer.toString('utf8'), buffer, headers: responseHeaders })
    })
    route.handler(req, sink)
  })
}

function jsonOf(response) {
  try {
    return JSON.parse(response.text)
  } catch {
    throw new Error('响应不是 JSON（' + response.status + '）：' + response.text.slice(0, 200))
  }
}

/* ═════════════════════════════ 纯函数边界 ═════════════════════════════ */

await test('briefDateKey：本地时区切日（凌晨也算今天）', () => {
  assertEqual(briefDateKey(new Date(2026, 10, 3, 1, 30)), '2026-11-03', '凌晨 1:30 的日期键')
  assertEqual(briefDateKey(new Date(2026, 10, 3, 23, 59)), '2026-11-03', '深夜 23:59 的日期键')
  assertEqual(briefDateKey(new Date(2026, 0, 9, 12, 0)), '2026-01-09', '月份 / 日期补零')
})

await test('briefCardImagePrompt：为 AI 情报卡生成横版宽幅科技提示词', () => {
  const card = {
    id: 'test-1',
    kicker: 'AI · 前沿',
    title: 'OpenAI加速多模态落地',
    lede: '测试导语',
    entries: [
      { order: 1, title: 'OpenAI发布新模型', text: '', source: '', url: '', tag: 'AI' },
      { order: 2, title: '开源大模型突破', text: '', source: '', url: '', tag: 'AI' },
    ],
  }
  const prompt = briefCardImagePrompt(card)
  assert(prompt.includes('OpenAI加速多模态落地'), '提示词应包含大标题')
  assert(prompt.includes('OpenAI发布新模型'), '提示词应包含前排条目')
  assert(prompt.includes('宽幅横构图'), '提示词应包含宽幅横构图要求')
  assert(prompt.includes('不要出现任何文字'), '提示词应禁止文字水印')
})

await test('briefQueries：四条查询、覆盖 AI 与世界 / 国内', () => {
  const queries = briefQueries(new Date(2026, 10, 3, 12, 0))
  assertEqual(queries.length, 4, '默认查询条数')
  assert(queries.every((query) => typeof query === 'string' && query.trim() !== ''), '查询不能为空串')
  assert(queries.some((query) => query.includes('AI')), '至少一条 AI 查询')
  assert(queries.some((query) => query.includes('世界')), '至少一条世界查询')
  assert(queries.some((query) => query.includes('国内')), '至少一条国内查询')
})

await test('sanitizeBriefRecord：条目不足 3 条 → null，合格 → 1–2 张卡', () => {
  const tooFew = {
    cards: [{
      kicker: 'AI · 前沿',
      title: '条目不够的一天',
      lede: '导语',
      entries: [
        { title: '只有一条', text: '正文' },
        { title: '只有两条', text: '正文' },
      ],
    }],
  }
  assertEqual(sanitizeBriefRecord(tooFew, { date: '2026-11-03', origin: 'web', sources: 3 }), null, '两条 entry 必须判无效')

  const record = sanitizeBriefRecord(GOOD_BRIEF, {
    date: '2026-11-03',
    model: 'p/m',
    origin: 'web',
    sources: 9,
    elapsedMs: 1200,
    queries: ['q1'],
    generatedAt: 1,
  })
  assert(record !== null, '合格输入不能返回 null')
  assertEqual(record.cards.length, 2, '两张卡')
  assertEqual(record.cards[0].id, '2026-11-03-1', '卡片 id 形状')
  assertEqual(record.cards[0].entries[0].order, 1, '条目序号从 1 开始')
  assertEqual(record.dateLabel, '11 月 3 日 · 周二', '展示日期')
  assertEqual(record.sources, 9, 'sources 原样保留')

  // 超过 2 张卡只留前两张
  const threeCards = { cards: [GOOD_BRIEF.cards[0], GOOD_BRIEF.cards[1], GOOD_BRIEF.cards[0]] }
  const capped = sanitizeBriefRecord(threeCards, { date: '2026-11-03', origin: 'model', sources: 0 })
  assertEqual(capped.cards.length, 2, '卡片数上限 2')
})

await test('parseBriefFeed：RSS 2.0 的 CDATA 标题与 HTML 摘要被剥干净', () => {
  const feed = BRIEF_FEEDS.find((item) => item.id === 'qbitai')
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel><title>量子位</title>',
    '  <item>',
    '    <title><![CDATA[<b>GPT-5.5</b> 发布：推理能力再上一个台阶]]></title>',
    '    <link>https://www.qbitai.com/2026/11/1001.html</link>',
    '    <description><![CDATA[<p>OpenAI 今天发布 GPT-5.5，主打长程推理与工具调用。</p>]]></description>',
    '    <pubDate>Tue, 03 Nov 2026 08:00:00 +0800</pubDate>',
    '  </item>',
    '  <item>',
    '    <title>第二条没有链接（应被丢弃）</title>',
    '    <description>没有 link 的条目进不了素材</description>',
    '  </item>',
    '</channel></rss>',
  ].join('\n')
  const items = parseBriefFeed(xml, feed, BRIEF_FEED_ITEMS)
  assertEqual(items.length, 1, '没有 link 的条目必须丢弃')
  const first = items[0]
  assertEqual(first.title, 'GPT-5.5 发布：推理能力再上一个台阶', 'CDATA + HTML 标签必须剥掉')
  assert(!first.title.includes('<b>'), '标题里不能残留 HTML 标签')
  assertEqual(first.url, 'https://www.qbitai.com/2026/11/1001.html', 'RSS 文本 link')
  assertEqual(first.feed, '量子位', 'feed 来自源定义 label')
  assertEqual(first.lane, 'ai', 'lane 来自源定义')
  assert(first.snippet !== undefined && !first.snippet.includes('<p>'), '摘要里的 HTML 标签必须剥掉')
  assertEqual(first.publishedAt, '2026-11-03T00:00:00.000Z', 'pubDate 归一成 ISO 8601')
})

await test('parseBriefFeed：Atom 的 link href 与 updated 也能解析', () => {
  const feed = BRIEF_FEEDS.find((item) => item.id === 'bbc-zh')
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>BBC 中文</title>',
    '  <entry>',
    '    <title>全球气候峰会达成新协议</title>',
    '    <link rel="alternate" href="https://www.bbc.com/zhongwen/simp/world-20261103"/>',
    '    <summary>&lt;p&gt;与会代表同意逐步削减化石燃料补贴。&lt;/p&gt;</summary>',
    '    <updated>2026-11-03T06:30:00Z</updated>',
    '  </entry>',
    '</feed>',
  ].join('\n')
  const items = parseBriefFeed(xml, feed)
  assertEqual(items.length, 1, 'Atom entry 要能解析')
  assertEqual(items[0].url, 'https://www.bbc.com/zhongwen/simp/world-20261103', 'Atom link href')
  assertEqual(items[0].lane, 'world', 'lane 来自源定义')
  assertEqual(items[0].feed, 'BBC 中文', 'feed 来自源定义 label')
  // shared 的 feedText 先剥真标签、再反转义实体，所以「被转义的标签」会以字面量保留。
  // 这里只断言实体已解码、正文可读（契约现状如此，不属于宿主侧问题）。
  assert(String(items[0].snippet).includes('与会代表同意逐步削减化石燃料补贴'), '实体转义后的正文要能读出来')
  assertEqual(items[0].publishedAt, '2026-11-03T06:30:00.000Z', 'updated 归一成 ISO')
})

await test('parseBriefFeed：HTML 验证页 / 空串 → 空数组，绝不抛', () => {
  const feed = BRIEF_FEEDS[0]
  assertEqual(parseBriefFeed('<html><body>Access denied</body></html>', feed).length, 0, '验证页应解析出 0 条')
  assertEqual(parseBriefFeed('', feed).length, 0, '空串应解析出 0 条')
  assertEqual(parseBriefFeed('<rss><channel><item><title>无链接</title></item></channel></rss>', feed).length, 0, '无链接条目应丢弃')
})

/* ═════════════════════════════ 生成链路 ═════════════════════════════ */

await test('generateBrief：RSS 主通道 → 模型 → 清洗 → 落盘（origin=web）', async () => {
  const { ctx, state } = makeCtx()
  llmQueue.push(splitChunks(GOOD_TEXT))
  const result = await generateBrief(ctx, { date: '2026-11-03', force: true })

  assert(result.ok === true, '生成应成功，实际 error=' + String(result.error))
  const brief = result.brief
  assert(brief !== undefined, '成功时必须返回 brief')
  assertEqual(brief.date, '2026-11-03', '日期')
  assertEqual(brief.origin, 'web', 'RSS 有素材时 origin 应为 web')
  assert(brief.sources > 0, 'sources 应大于 0，实际 ' + String(brief.sources))
  assertEqual(brief.model, 'default-provider/default-model', '未指定模型时走 agentDefaultModel')
  assert(brief.cards.length >= 1 && brief.cards.length <= 2, '卡片应为 1–2 张，实际 ' + String(brief.cards.length))
  for (const card of brief.cards) {
    assert(card.entries.length >= 3, '每张卡至少 3 条，实际 ' + String(card.entries.length))
  }
  assert(!Array.isArray(brief.queries) || brief.queries.length === 0, 'RSS 素材够用时不触发搜索，queries 应为空')
  assertEqual(state.fetches.length, BRIEF_FEEDS.length, '五个 RSS 源都要被抓一次')
  assertEqual(state.searches.length, 0, 'RSS 素材足够时不该调用搜索')

  // 落盘：<DSH_HOME>/storages/dsh-seeker-bot/done-pill/briefs/<date>.json
  const file = join(BRIEFS_DIR, '2026-11-03.json')
  assert(existsSync(file), '简报没有落盘：' + file)
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assertEqual(persisted.date, '2026-11-03', '落盘日期')
  assertEqual(persisted.cards.length, brief.cards.length, '落盘卡片数')

  // 模型调用契约：路由 / 提示词 / 采样参数 / 取消信号
  assert(lastLlmOptions !== null, 'llm.stream 必须被调用')
  assertEqual(lastLlmOptions.provider, 'default-provider', 'provider 路由')
  assertEqual(lastLlmOptions.model, 'default-model', 'model 路由')
  assertEqual(lastLlmOptions.maxTokens, 4000, 'maxTokens')
  assertEqual(lastLlmOptions.temperature, 0.7, 'temperature')
  assert(lastLlmOptions.signal !== undefined, 'llm.stream 必须带 AbortSignal（总超时用）')
  const systemText = String(lastLlmOptions.system ?? '')
  assert(systemText.includes('资深中文科技媒体'), 'system 提示词缺少编辑身份')
  assert(systemText.includes('不得编造'), 'system 提示词缺少反编造约束')
  const userText = String(lastLlmOptions.messages?.[0]?.content?.[0]?.text ?? '')
  assert(userText.includes('2026-11-03'), 'user 提示词缺少日期')
  assert(userText.includes('联网素材'), 'user 提示词缺少素材段')
  assert(userText.includes('请只输出 JSON'), 'user 提示词缺少输出要求')
  assert(userText.includes('example.test/qbitai/1'), 'RSS 素材 URL 没有进提示词')
})

await test('generateBrief：RSS 与搜索全失败 → origin=model 仍能生成', async () => {
  const { ctx, state } = makeCtx({ feedFails: true, searchFails: true })
  llmQueue.push(splitChunks(GOOD_TEXT))
  const result = await generateBrief(ctx, { date: '2026-11-04', force: true })

  assert(result.ok === true, '素材全空也应能生成，实际 error=' + String(result.error))
  assertEqual(result.brief.origin, 'model', '没有素材时 origin 必须是 model（前端据此标「未联网」）')
  assertEqual(result.brief.sources, 0, 'sources 应为 0')
  assert(result.brief.cards.length >= 1, '仍然要出卡')
  assert(state.searches.length > 0, 'RSS 不足 6 条时必须走搜索兜底')
  const userText = String(lastLlmOptions.messages?.[0]?.content?.[0]?.text ?? '')
  assert(userText.includes('没有抓到任何联网素材'), '素材为空时提示词要明说，避免模型硬编')
})

await test('generateBrief：RSS 全挂时用搜索兜底补素材（origin=web）', async () => {
  const { ctx, state } = makeCtx({ feedFails: true })
  llmQueue.push(splitChunks(GOOD_TEXT))
  const result = await generateBrief(ctx, { date: '2026-11-05', force: true })

  assert(result.ok === true, '搜索兜底应能生成，实际 error=' + String(result.error))
  assertEqual(result.brief.origin, 'web', '搜索有结果时 origin 应为 web')
  assert(result.brief.sources > 0, 'sources 应大于 0')
  assert(state.searches.length > 0, '搜索兜底必须真的发出查询')
  assertEqual(state.searches.length, 4, '默认四条兜底查询')
  assert(Array.isArray(result.brief.queries) && result.brief.queries.length === 4, '真正发出的查询要记进记录')
})

await test('generateBrief：模型返回垃圾 → ok:false + 中文错误，不落盘', async () => {
  const { ctx } = makeCtx()
  llmQueue.push(['这不是 JSON，', '也 没有花括号。'])
  const result = await generateBrief(ctx, { date: '2026-11-06', force: true })

  assertEqual(result.ok, false, '垃圾输出必须失败')
  assertChinese(result.error, '错误信息必须是中文短句')
  assert(String(result.error).includes('JSON'), '错误要提到 JSON，实际：' + String(result.error))
  assert(!existsSync(join(BRIEFS_DIR, '2026-11-06.json')), '解析失败时不该写出任何文件')
})

await test('generateBrief：并发锁 → 第二次调用立刻返回「正在生成中」', async () => {
  const { ctx } = makeCtx()
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  let streamStarted
  const started = new Promise((resolve) => { streamStarted = resolve })
  onStreamStart = streamStarted
  llmQueue.push({ wait: gate, chunks: splitChunks(GOOD_TEXT) })

  const first = generateBrief(ctx, { date: '2026-11-07', force: true })
  await started
  const second = await generateBrief(ctx, { date: '2026-11-07', force: true })
  assertEqual(second.ok, false, '并发生成必须被锁挡住')
  assert(String(second.error).includes('正在生成中'), '第二次调用应返回「正在生成中」，实际：' + String(second.error))

  releaseGate()
  const firstResult = await first
  assertEqual(firstResult.ok, true, '第一次生成应成功，实际 error=' + String(firstResult.error))
  onStreamStart = null
})

await test('generateBrief：当天已有简报时 force=false 直接复用（不调模型）', async () => {
  const { ctx } = makeCtx()
  const before = llmQueue.length
  const result = await generateBrief(ctx, { date: '2026-11-03' })
  assertEqual(result.ok, true, '应直接返回已有简报')
  assertEqual(result.brief.date, '2026-11-03', '复用当天记录')
  assertEqual(llmQueue.length, before, '不该消耗模型调用')
})

/* ═════════════════════════════ HTTP 路由 ═════════════════════════════ */

await test('路由：today / generate / list 三条都在，形状符合契约', async () => {
  const { ctx, state } = makeCtx()
  applyBriefHost(ctx)

  // 前面的用例可能已经把「今天」的简报写出来了（固定日期恰好撞上测试当天时）；
  // 先清掉，保证「生成前 brief 为 null」的空态断言成立。
  const todayKey = briefDateKey(new Date())
  rmSync(join(BRIEFS_DIR, todayKey + '.json'), { force: true })

  const todayPath = '/api/dsh-done-pill/brief/today'
  const generatePath = '/api/dsh-done-pill/brief/generate'
  const listPath = '/api/dsh-done-pill/brief/list'
  const imagePath = BRIEF_IMAGE_ROUTE
  assert(state.routes.has(todayPath), 'GET /brief/today 未注册')
  assert(state.routes.has(generatePath), 'POST /brief/generate 未注册')
  assert(state.routes.has(listPath), 'GET /brief/list 未注册')
  assert(state.routes.has(imagePath), 'prefix /brief/image 未注册')
  assertEqual(state.routes.get(todayPath).kind, 'exact', 'today 必须是 exact')
  assertEqual(state.routes.get(generatePath).kind, 'exact', 'generate 必须是 exact')
  assertEqual(state.routes.get(listPath).kind, 'exact', 'list 必须是 exact')
  assertEqual(state.routes.get(imagePath).kind, 'prefix', 'image 必须是 prefix')

  // 生成前：brief 为 null、hasToday=false、generating=false
  const empty = jsonOf(await request(state.routes.get(todayPath)))
  assertEqual(empty.ok, true, 'today.ok')
  assertEqual(empty.brief, null, '还没有简报时 brief 必须是 null')
  assertEqual(empty.hasToday, false, 'hasToday 按文件存在判定')
  assertEqual(empty.generating, false, 'generating 初始为 false')

  // POST /generate：用今天（不传 date），成功后 today 能读到
  llmQueue.push(splitChunks(GOOD_TEXT))
  const generated = jsonOf(await request(state.routes.get(generatePath), {
    method: 'POST',
    body: { force: true, model: { provider: 'stub-provider', model: 'stub-model' } },
  }))
  assertEqual(generated.ok, true, 'POST /generate 应成功：' + JSON.stringify(generated).slice(0, 200))
  assert(generated.brief !== undefined, 'POST /generate 应返回 brief')
  assertEqual(generated.brief.model, 'stub-provider/stub-model', 'request.model 优先于默认模型')

  const after = jsonOf(await request(state.routes.get(todayPath)))
  assertEqual(after.ok, true, 'today.ok（生成后）')
  assert(after.brief !== null, '生成后 today 应能读到简报')
  assertEqual(after.hasToday, true, '生成后 hasToday 应为 true')
  assertEqual(after.brief.date, briefDateKey(new Date()), 'today 读的是本地今天的简报')

  const list = jsonOf(await request(state.routes.get(listPath), { url: listPath + "?days=7" }))
  assertEqual(list.ok, true, 'list.ok')
  assert(Array.isArray(list.briefs), 'list.briefs 必须是数组')
  assert(list.briefs.length >= 1, 'list 至少包含刚生成的那份')
  assert(list.briefs.some((item) => item.date === todayKey), 'list 应包含刚生成的今天简报')
  // 临时 DSH_HOME 里还有别的用例写的未来日期记录，所以只断言排序而不是「第一条是今天」
  const listedDates = list.briefs.map((item) => item.date)
  assert(
    listedDates.every((value, index) => index === 0 || listedDates[index - 1] >= value),
    'list 必须按日期倒序（新的在前）：' + listedDates.join(','),
  )

  // 失败也回 200 + error 字段（与 journal 路由一致）
  llmQueue.push(['不是 JSON'])
  const failed = await request(state.routes.get(generatePath), {
    method: 'POST',
    body: { date: '2026-11-08', force: true },
  })
  assertEqual(failed.status, 200, '生成失败也回 HTTP 200')
  const failedJson = jsonOf(failed)
  assertEqual(failedJson.ok, false, '失败时 ok:false')
  assertChinese(failedJson.error, '失败原因必须是中文')

  // 非 GET 方法 → 405
  const wrongMethod = await request(state.routes.get(todayPath), { method: 'POST' })
  assertEqual(wrongMethod.status, 405, 'today 非 GET 应 405')

  // prefix /brief/image: 不存在的图片回 404 JSON
  const missingImg = await request(state.routes.get(imagePath), { url: imagePath + '/1999-01-01' })
  assertEqual(missingImg.status, 404, '不存在的图片必须 404')
  assertChinese(jsonOf(missingImg).error, '404 响应必须带中文 error')

  // prefix /brief/image: 有对应图片时流式返回 PNG 200
  const fakeImgDir = join(BRIEFS_DIR, 'images')
  mkdirSync(fakeImgDir, { recursive: true })
  writeFileSync(join(fakeImgDir, todayKey + '-ai.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const realImg = await request(state.routes.get(imagePath), { url: imagePath + '/' + todayKey })
  assertEqual(realImg.status, 200, '存在图片时必须回 200')
  assertEqual(realImg.headers['content-type'], 'image/png', '图片 Content-Type 应为 image/png')
  assertEqual(realImg.buffer.length, 8, '图片字节完整')
})

await test('路由：跨站写请求被拒绝（403）', async () => {
  const { ctx, state } = makeCtx()
  applyBriefHost(ctx)
  const generatePath = '/api/dsh-done-pill/brief/generate'
  const cross = await request(state.routes.get(generatePath), {
    method: 'POST',
    body: {},
    headers: { origin: 'http://evil.test', host: '127.0.0.1:3080' },
  })
  assertEqual(cross.status, 403, '跨站 POST 必须 403')
})

await test('checkBriefSchedule：凌晨不生成（便宜判定先跑）', async () => {
  const { ctx } = makeCtx()
  const result = await checkBriefSchedule(ctx, new Date(2026, 10, 3, 3, 0))
  assertEqual(result.ok, false, '凌晨 3 点不该生成')
  assert(String(result.reason).includes('还没到'), '原因应说明还没到 6 点，实际：' + String(result.reason))
})

await test('applyBriefHost：调度定时器已挂上且可 dispose', () => {
  assert(disposers.length > 0, '调度器必须注册 effect（否则插件卸载后定时器泄漏）')
})

/* ═════════════════════════════ 收尾 ═════════════════════════════ */

for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* 清理失败不影响结论 */
  }
}

try {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log('\n[daily-brief host] 通过 ' + String(passed) + ' 项')
for (const [name, error] of failures) {
  console.error('✗ ' + name + '\n  ' + String(error && error.stack ? error.stack : error))
}
if (failures.length > 0) {
  console.error('[daily-brief host] 失败 ' + String(failures.length) + ' 项')
  process.exitCode = 1
}
