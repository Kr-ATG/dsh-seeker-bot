/**
 * 节日卡（Festival Card）宿主半身的集成测试。
 *
 * 覆盖契约（见 src/shared/festival.ts 与 src/host/done-pill/festival.ts）：
 *   - 共享纯函数：日期窗口（2026-11-05 窗口内是立冬 11-07）、倒计时、搜图词合并、
 *     清洗与兜底卡；
 *   - 宿主内部：图片头解析（PNG / JPEG / GIF / WebP）、生图模型调用与字节校验、
 *     标题 / 来源 / 元数据尺寸过滤、来源展示名；
 *   - 生成链路（桩 ctx + 桩 fetch）：模型正常生成 → 清洗 → 搜图 → 落盘；模型坏
 *     JSON / 模型抛错 / 没有模型时走 origin='fallback'、仍然 ok:true；
 *     图片全部失败时 image=null 但记录照常生成；已有记录复用；force 重生成；并发锁；
 *   - 路由：3 条 exact（today / generate / list）+ 1 条 prefix（image）的注册与形状，
 *     image 路由 200 流式返回 / 404 明确 JSON，POST 跨站闸门 403；
 *   - 调度：凌晨不生成、6 点后窗口内有节日则生成、已生成去重、90 天清理。
 *
 * ── 为什么用 esbuild 现场打包 ────────────────────────────────────────────
 *
 * 被测模块是 TS（带 .ts 后缀 import），Node 直接跑不了；仓库的 build.mjs 会把
 * 整包产物写进 lib/，与并行改动的队友冲突。所以用项目自带的 esbuild 把
 * src/shared/festival.ts 与 src/host/done-pill/festival.ts 各打成一个临时 ESM，
 * 断言的仍是真正会跑的那份源码。
 *
 * ── 隔离 ────────────────────────────────────────────────────────────────
 *
 * DSH_HOME 指向临时目录（绝不碰真实 ~/.dsh）；web / llm 全部是桩，不发任何网络
 * 请求（全局 fetch 也被替换）。定时器用 unref()，脚本结束前显式 dispose。
 *
 * 跑法：node scripts/test-festival-card-host.mjs（非 0 退出码 = 有失败）
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
const OUT = mkdtempSync(join(tmpdir(), 'dsh-festival-host-'))
const HOME_ROOT = mkdtempSync(join(tmpdir(), 'dsh-festival-home-'))
process.env.DSH_HOME = join(HOME_ROOT, 'main')

await esbuild.build({
  entryPoints: {
    shared: join(ROOT, 'src/shared/festival.ts'),
    host: join(ROOT, 'src/host/done-pill/festival.ts'),
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
  FESTIVAL_IMAGE_ROUTE,
  FESTIVAL_ROUTE,
  festivalCountdownLabel,
  festivalDateKey,
  festivalDateShort,
  festivalFallbackCard,
  sanitizeFestivalRecord,
  upcomingFestivals,
} = shared
const { applyFestivalHost, checkFestivalSchedule, generateFestival, festivalTodayPayload } = host
const T = host.__festivalTest

const FESTIVALS_DIR = () => join(process.env.DSH_HOME, 'storages', 'dsh-seeker-bot', 'done-pill', 'festivals')
const IMAGES_DIR = () => join(FESTIVALS_DIR(), 'images')

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

function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/** 切到一份全新的 DSH_HOME（每个用例组互不污染）。 */
function useHome(name) {
  process.env.DSH_HOME = join(HOME_ROOT, name)
  resetDir(process.env.DSH_HOME)
}

/* ───────────────────────────── 桩数据 ───────────────────────────── */

const GOOD_CARD = {
  cards: [{
    title: '立冬的羊肉汤，四川人最后涮的是豌豆尖',
    lede: '北方这天包饺子，四川人却要炖一锅奶白的羊肉汤，起锅前涮一把豌豆尖，鲜得很。',
    facts: [
      { label: '北方', value: '吃饺子' },
      { label: '四川', value: '羊肉汤' },
    ],
  }],
}
const GOOD_TEXT = JSON.stringify(GOOD_CARD)

/** 一条合格的两卡简报式 JSON（第二版标题不同，用来验证 force 重生成）。 */
const GOOD_CARD_V2 = JSON.parse(JSON.stringify(GOOD_CARD))
GOOD_CARD_V2.cards[0].title = '立冬的第二版：一锅羊肉汤配豌豆尖'
const GOOD_TEXT_V2 = JSON.stringify(GOOD_CARD_V2)

/** 一张 200KB 的 PNG（只保证文件头正确，尺寸解析读 IHDR 即可）。 */
function makePng(width, height, totalBytes = 220 * 1024) {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  head[24] = 8
  head[25] = 2
  head[26] = 0
  head[27] = 0
  head[28] = 0
  head.writeUInt32BE(0, 29)
  return Buffer.concat([head, Buffer.alloc(Math.max(0, totalBytes - 33), 0x42)])
}

/** 一张 JPEG（只保证 SOI + SOF0 段正确）。 */
function makeJpeg(width, height, totalBytes = 220 * 1024) {
  const head = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
  return Buffer.concat([head, Buffer.alloc(Math.max(0, totalBytes - head.length), 0x42)])
}

/** 一张 GIF。 */
function makeGif(width, height, totalBytes = 220 * 1024) {
  const head = Buffer.alloc(13)
  head.write('GIF89a', 0, 'ascii')
  head.writeUInt16LE(width, 6)
  head.writeUInt16LE(height, 8)
  return Buffer.concat([head, Buffer.alloc(Math.max(0, totalBytes - 13), 0x42)])
}

/** 一张 WebP（VP8X）。 */
function makeWebp(width, height, totalBytes = 220 * 1024) {
  const head = Buffer.alloc(30)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(22, 4)
  head.write('WEBP', 8, 'ascii')
  head.write('VP8X', 12, 'ascii')
  head.writeUInt32LE(10, 16)
  head[20] = 0
  head.writeUIntLE(width - 1, 24, 3)
  head.writeUIntLE(height - 1, 27, 3)
  return Buffer.concat([head, Buffer.alloc(Math.max(0, totalBytes - 30), 0x42)])
}

/* ───────────────────────────── 桩 fetch ───────────────────────────── */

const fetchLog = []
const realFetch = globalThis.fetch
let fetchMode = 'ok' // ok | image-gen-fail
let lastFetchInit = null

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
  }
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => '',
  }
}

globalThis.fetch = async (url, init) => {
  const text = String(url)
  fetchLog.push(text)
  if (init !== undefined) lastFetchInit = init
  // 生图接口：返回一张 1024×1536 的假 PNG（尺寸解析只读 IHDR）。
  if (text.includes('/images/generations')) {
    if (fetchMode === 'image-gen-fail') return notFoundResponse()
    return jsonResponse({ data: [{ b64_json: makePng(1024, 1536, 320 * 1024).toString('base64') }] })
  }
  return notFoundResponse()
}

/* ───────────────────────────── 桩 ctx ───────────────────────────── */

/** llm.stream 的脚本队列：每次调用 shift 一项（数组 = 分片文本；{ wait } = 挂起；{ throw } = 抛错）。 */
const llmQueue = []
let lastLlmOptions = null
let onStreamStart = null

const llm = {
  listProviders: () => [{ id: 'stub-provider' }],
  listModels: async () => [{ id: 'stub-model' }],
  // 生图用的供应商枚举（providerProfile 通过它找 settingsNs / settingsPath）
  listConfigurableProviders: () => [{ provider: 'stub-provider', settingsNs: 'stub-provider-settings', settingsPath: [] }],
  stream: async function* (options) {
    lastLlmOptions = options
    if (onStreamStart !== null) onStreamStart()
    const script = llmQueue.shift()
    if (script === undefined) throw new Error('测试没有为这次 llm.stream 准备响应')
    if (script.wait !== undefined) await script.wait
    if (script.throw !== undefined) throw new Error(script.throw)
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
 */
function makeCtx(options = {}) {
  const state = {
    routes: new Map(),
    logs: [],
  }
  const localLlm = options.noLlm === true ? undefined : llm
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
      if (name === 'llm') return localLlm
      if (name === 'web') return undefined
      if (name === 'credentials') {
        return options.imageModel === true
          ? { resolve: async (envName) => ({ value: 'fake-key:' + String(envName) }) }
          : undefined
      }
      if (name === 'agentDefaultModel') {
        return options.noDefaultModel === true
          ? undefined
          : { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
      }
      return undefined
    },
    llm: localLlm,
    web: undefined,
    // 只有显式声明 imageModel 的用例才带生图配置；其余用例不配生图模型，image 应为 null。
    ...(options.imageModel === true ? {
      settings: {
        get(namespace) {
          if (namespace === 'model-capabilities') {
            return { imageActive: 'stub-provider/stub-image-model', imagePath: 'images/generations' }
          }
          if (namespace === 'stub-provider-settings') {
            return { baseURL: 'https://fake-image.test/v1', apiKeyEnv: 'FAKE_IMAGE_KEY' }
          }
          return null
        },
      },
    } : {}),
  }
  return { ctx, state }
}

/** 极简 req / res 桩：JSON 路由与 createReadStream().pipe(res) 都能用。 */
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

/* ═════════════════════════════ 共享契约 / 日期窗口 ═════════════════════════════ */

await test('festivalDateKey：本地时区切日（凌晨也算今天）', () => {
  assertEqual(festivalDateKey(new Date(2026, 10, 5, 1, 30)), '2026-11-05', '凌晨 1:30 的日期键')
  assertEqual(festivalDateKey(new Date(2026, 10, 5, 23, 59)), '2026-11-05', '深夜 23:59 的日期键')
})

await test('upcomingFestivals：2026-11-05 的 10 天窗口内是立冬（11-07）', () => {
  const entries = upcomingFestivals(new Date(2026, 10, 5), 10)
  assert(entries.length > 0, '窗口内应有节日')
  assertEqual(entries[0].id, 'lidong', '最近一个节日是立冬')
  assertEqual(entries[0].date, '2026-11-07', '立冬日期')
  assertEqual(festivalCountdownLabel('2026-11-07', new Date(2026, 10, 5)), '还有两天', '倒计时')
})

await test('upcomingFestivals：无节日窗口（2026-06-10）返回空数组', () => {
  assertEqual(upcomingFestivals(new Date(2026, 5, 10), 10).length, 0, '6-10 到 6-20 没有节气或节日')
})

await test('sanitizeFestivalRecord / festivalFallbackCard：坏输入 null，兜底卡字段齐全', () => {
  const entry = upcomingFestivals(new Date(2026, 10, 5), 10)[0]
  assertEqual(sanitizeFestivalRecord({}, { entry, origin: 'model' }), null, '空 payload → null')
  assertEqual(sanitizeFestivalRecord({ cards: [{}] }, { entry, origin: 'model' }), null, '空标题卡 → null')
  const record = sanitizeFestivalRecord(GOOD_CARD, { entry, origin: 'model', model: 'p/m', generatedAt: 1 })
  assert(record !== null, '合格输入不能返回 null')
  assertEqual(record.cards[0].id, '2026-11-07-lidong', '卡片 id 形状')
  assertEqual(record.festivalDate, '2026-11-07', 'festivalDate')

  const fallback = festivalFallbackCard(entry)
  assert(fallback.title.includes('立冬'), '兜底卡标题含节日名')
  assert(fallback.lede.length > 10, '兜底卡导语不能为空')
  assert(fallback.facts.length >= 2, '兜底卡至少 2 条 fact')
})

/* ═════════════════════════════ 宿主内部纯函数 ═════════════════════════════ */

await test('imageSizeOf：PNG / JPEG / GIF / WebP 头解析，未知格式 null', () => {
  assertEqual(JSON.stringify(T.imageSizeOf(makePng(1200, 800))), JSON.stringify({ width: 1200, height: 800 }), 'PNG')
  assertEqual(JSON.stringify(T.imageSizeOf(makeJpeg(1024, 768))), JSON.stringify({ width: 1024, height: 768 }), 'JPEG')
  assertEqual(JSON.stringify(T.imageSizeOf(makeGif(900, 600))), JSON.stringify({ width: 900, height: 600 }), 'GIF')
  assertEqual(JSON.stringify(T.imageSizeOf(makeWebp(1280, 720))), JSON.stringify({ width: 1280, height: 720 }), 'WebP')
  assertEqual(T.imageSizeOf(Buffer.from('not an image')), null, '未知格式')
})

await test('parseFestivalJson：剥 markdown 围栏；坏 JSON 抛中文错误', () => {
  const FENCE = String.fromCharCode(96, 96, 96)
  const payload = T.parseFestivalJson(FENCE + 'json\n' + GOOD_TEXT + '\n' + FENCE)
  assertEqual(payload.cards.length, 1, '围栏内 JSON')
  let error = null
  try {
    T.parseFestivalJson('这不是 JSON')
  } catch (caught) {
    error = caught
  }
  assert(error !== null, '坏 JSON 必须抛错')
  assertChinese(error.message, '错误信息必须是中文')
})

await test('normalizeFestivalDate：非法输入回退今天', () => {
  assertEqual(T.normalizeFestivalDate('2026-11-05'), '2026-11-05', '合法日期原样')
  assertEqual(T.normalizeFestivalDate('not-a-date'), festivalDateKey(new Date()), '非法回退今天')
})

/* ═════════════════════════════ 生成链路 ═════════════════════════════ */

await test('generateFestival：模型 → 清洗 → 生图 → 落盘（origin=model）', async () => {
  useHome('generate')
  fetchMode = 'ok'
  lastFetchInit = null
  const { ctx } = makeCtx({ imageModel: true })
  llmQueue.push(splitChunks(GOOD_TEXT))
  const beforeLog = fetchLog.length
  const result = await generateFestival(ctx, { date: '2026-11-05', force: true })

  assert(result.ok === true, '生成应成功，实际 error=' + String(result.error))
  const record = result.record
  assert(record !== undefined, '成功时必须返回 record')
  assertEqual(record.date, '2026-11-05', '生成日期')
  assertEqual(record.dateLabel, '11 月 5 日 · 周四', '展示日期')
  assertEqual(record.festivalDate, '2026-11-07', '节日日期')
  assertEqual(record.origin, 'model', 'origin')
  assertEqual(record.model, 'default-provider/default-model', '模型标识')
  assertEqual(record.cards.length, 1, '一张卡')
  assertEqual(record.cards[0].festivalId, 'lidong', 'festivalId')
  assertEqual(record.cards[0].title, GOOD_CARD.cards[0].title, '标题来自模型')

  const image = record.cards[0].image
  assert(image !== null, '生图模型可用时必须出图')
  assertEqual(image.source, 'AI 生图', '来源标注')
  assertEqual(image.caption, '立冬 · AI 绘制', '图注')
  assertEqual(image.file, '2026-11-07.png', '图片文件名按 festivalDate')
  assertEqual(image.width, 1024, '生图宽')
  assertEqual(image.height, 1536, '生图高')
  assertEqual(image.sourceUrl, undefined, 'AI 图不带来源页链接')
  assertEqual(
    image.url,
    FESTIVAL_IMAGE_ROUTE + '/2026-11-07?v=' + String(record.generatedAt),
    '图片 URL 带 generatedAt 版本',
  )

  // 模型调用契约：路由 / 提示词 / 采样参数 / 取消信号
  assert(lastLlmOptions !== null, 'llm.stream 必须被调用')
  assertEqual(lastLlmOptions.provider, 'default-provider', 'provider 路由')
  assertEqual(lastLlmOptions.model, 'default-model', 'model 路由')
  assertEqual(lastLlmOptions.maxTokens, 2000, 'maxTokens')
  assertEqual(lastLlmOptions.temperature, 0.8, 'temperature')
  assert(lastLlmOptions.signal !== undefined, 'llm.stream 必须带 AbortSignal')
  assert(String(lastLlmOptions.system).includes('中文生活杂志'), 'system 提示词身份')
  assert(String(lastLlmOptions.messages?.[0]?.content?.[0]?.text).includes('立冬'), 'user 提示词含节日名')

  // 落盘
  const file = join(FESTIVALS_DIR(), '2026-11-07.json')
  assert(existsSync(file), '记录没有落盘：' + file)
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assertEqual(persisted.festivalDate, '2026-11-07', '落盘 festivalDate')
  assert(persisted.cards[0].image !== null, '落盘记录保留图片')
  const imageFile = join(IMAGES_DIR(), '2026-11-07.png')
  assert(existsSync(imageFile), '图片没有落盘：' + imageFile)

  // 配图只走生图网关：绝不能出现任何百度图片请求
  const calls = fetchLog.slice(beforeLog).map((url) => String(url))
  assert(calls.some((url) => url.includes('/images/generations')), '必须调用生图接口')
  assert(!calls.some((url) => url.includes('image.baidu.com')), '绝不能再请求百度图片接口')
})

await test('generateFestival：有生图模型时用 AI 图，且绝不请求百度', async () => {
  useHome('generate-model-image')
  fetchMode = 'ok'
  lastFetchInit = null
  const { ctx } = makeCtx({ imageModel: true })
  llmQueue.push(splitChunks(GOOD_TEXT))
  const beforeLog = fetchLog.length
  const result = await generateFestival(ctx, { date: '2026-11-05', force: true })

  assert(result.ok === true, '生成应成功，实际 error=' + String(result.error))
  const image = result.record.cards[0].image
  assert(image !== null, '生图模型可用时必须出图')
  assertEqual(image.source, 'AI 生图', '来源标注')
  assertEqual(image.caption, '立冬 · AI 绘制', '图注')
  assertEqual(image.file, '2026-11-07.png', '图片文件名')
  assertEqual(image.width, 1024, '生图宽')
  assertEqual(image.height, 1536, '生图高')

  const calls = fetchLog.slice(beforeLog).map((url) => String(url))
  assert(calls.some((url) => url.includes('/images/generations')), '必须调用生图接口')
  assert(!calls.some((url) => url.includes('image.baidu.com')), '全程不应出现百度图片请求')
  assert(lastFetchInit !== null && lastFetchInit.method === 'POST', '生图必须走 POST')
  const body = JSON.parse(String(lastFetchInit.body))
  assertEqual(body.model, 'stub-image-model', '模型来自 model-capabilities')
  assertEqual(body.size, '1024x1536', '竖幅尺寸')
  assert(String(body.prompt).includes('立冬'), '生图提示词含节气名')
  assert(String(body.prompt).includes('羊肉') || String(body.prompt).includes('饺子'), '生图提示词含应季食物')
})

await test('generateFestival：生图失败 → image=null，绝不回退搜图', async () => {
  useHome('generate-model-image-fail')
  fetchMode = 'image-gen-fail'
  const { ctx } = makeCtx({ imageModel: true })
  llmQueue.push(splitChunks(GOOD_TEXT))
  const beforeLog = fetchLog.length
  const result = await generateFestival(ctx, { date: '2026-11-05', force: true })
  fetchMode = 'ok'

  assertEqual(result.ok, true, '生图失败不应让记录生成失败')
  assertEqual(result.record.cards[0].image, null, 'image 必须是 null，不再降级到网上搜图')
  const calls = fetchLog.slice(beforeLog).map((url) => String(url))
  assert(calls.some((url) => url.includes('/images/generations')), '生图接口确实被尝试过')
  assert(!calls.some((url) => url.includes('image.baidu.com')), '失败后绝不能去搜百度图')
  assert(existsSync(join(FESTIVALS_DIR(), '2026-11-07.json')), '记录仍要落盘')
})

await test('generateFestival：已有记录且 force=false 直接复用（不调模型）', async () => {
  const { ctx } = makeCtx()
  const before = llmQueue.length
  const result = await generateFestival(ctx, { date: '2026-11-05' })
  assertEqual(result.ok, true, '应直接返回已有记录')
  assertEqual(result.record.festivalDate, '2026-11-07', '复用同一节日记录')
  assertEqual(llmQueue.length, before, '不该消耗模型调用')
})

await test('generateFestival：force=true 重新生成（换文案）', async () => {
  const { ctx } = makeCtx()
  const old = T.readFestivalRecord('2026-11-07')
  llmQueue.push(splitChunks(GOOD_TEXT_V2))
  const result = await generateFestival(ctx, { date: '2026-11-05', force: true })
  assertEqual(result.ok, true, 'force 重生成应成功')
  assertEqual(result.record.cards[0].title, GOOD_CARD_V2.cards[0].title, '标题应换成新文案')
  assert(result.record.generatedAt >= old.generatedAt, 'generatedAt 不应倒退')
})

await test('generateFestival：模型输出坏 JSON → origin=fallback 且 ok:true', async () => {
  useHome('fallback-bad-json')
  fetchMode = 'ok'
  const { ctx } = makeCtx()
  llmQueue.push(['这不是 JSON，也 没有花括号。'])
  const result = await generateFestival(ctx, { date: '2026-11-20', force: true })
  assertEqual(result.ok, true, '坏 JSON 也必须 ok:true（资料卡兜底）')
  assertEqual(result.record.origin, 'fallback', 'origin=fallback')
  assertEqual(result.record.festivalDate, '2026-11-22', '小雪日期')
  assert(result.record.cards[0].title.includes('小雪'), '兜底卡标题含节日名')
  assertEqual(result.record.cards[0].image, null, '未配生图模型时 image=null，资料卡照常出')
  assertEqual(result.record.model, undefined, '兜底卡不带 model')
})

await test('generateFestival：模型抛错 → origin=fallback 且 ok:true', async () => {
  useHome('fallback-throw')
  fetchMode = 'ok'
  const { ctx } = makeCtx()
  llmQueue.push({ throw: '模型网关 500' })
  const result = await generateFestival(ctx, { date: '2026-11-20', force: true })
  assertEqual(result.ok, true, '模型抛错也必须 ok:true')
  assertEqual(result.record.origin, 'fallback', '走资料卡')
  assertEqual(result.record.cards[0].image, null, '未配生图模型时 image=null')
})

await test('generateFestival：没有可用模型 → origin=fallback 且 ok:true', async () => {
  useHome('fallback-no-llm')
  fetchMode = 'ok'
  const { ctx } = makeCtx({ noLlm: true })
  const result = await generateFestival(ctx, { date: '2026-12-05', force: true })
  assertEqual(result.ok, true, '没有模型也必须 ok:true')
  assertEqual(result.record.origin, 'fallback', '走资料卡')
  assertEqual(result.record.festivalDate, '2026-12-07', '大雪日期')
  assertEqual(result.record.cards[0].image, null, '未配生图模型时 image=null')
})

await test('generateFestival：窗口内没有节日 → ok:false + 中文短句', async () => {
  useHome('no-festival')
  const { ctx } = makeCtx()
  const result = await generateFestival(ctx, { date: '2026-06-10', force: true })
  assertEqual(result.ok, false, '没有节日必须失败')
  assertChinese(result.error, '错误必须是中文')
  assert(String(result.error).includes('最近'), '错误要说明窗口，实际：' + String(result.error))
})

await test('generateFestival：未配置生图模型 → image=null，记录照常生成', async () => {
  useHome('no-image-model')
  fetchMode = 'ok'
  const { ctx } = makeCtx()
  llmQueue.push(splitChunks(GOOD_TEXT))
  const result = await generateFestival(ctx, { date: '2026-12-19', force: true })
  assertEqual(result.ok, true, '没有生图模型不影响记录生成')
  assertEqual(result.record.cards[0].image, null, 'image 必须是 null')
  assert(existsSync(join(FESTIVALS_DIR(), '2026-12-22.json')), '记录仍要落盘')
})

await test('generateFestival：并发锁 → 第二次调用立刻返回「正在生成中」', async () => {
  useHome('concurrency')
  fetchMode = 'ok'
  const { ctx } = makeCtx()
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  let streamStarted
  const started = new Promise((resolve) => { streamStarted = resolve })
  onStreamStart = streamStarted
  llmQueue.push({ wait: gate, chunks: splitChunks(GOOD_TEXT) })

  const first = generateFestival(ctx, { date: '2026-12-19', force: true })
  await started
  const second = await generateFestival(ctx, { date: '2026-12-19', force: true })
  assertEqual(second.ok, false, '并发生成必须被锁挡住')
  assert(String(second.error).includes('正在生成中'), '第二次应返回「正在生成中」，实际：' + String(second.error))

  releaseGate()
  const firstResult = await first
  assertEqual(firstResult.ok, true, '第一次生成应成功，实际 error=' + String(firstResult.error))
  onStreamStart = null
})

/* ═════════════════════════════ 调度 ═════════════════════════════ */

await test('checkFestivalSchedule：凌晨不生成（便宜判定先跑）', async () => {
  useHome('schedule-night')
  const { ctx } = makeCtx()
  const result = await checkFestivalSchedule(ctx, new Date(2026, 10, 5, 3, 0))
  assertEqual(result.ok, false, '凌晨 3 点不该生成')
  assert(String(result.reason).includes('还没到'), '原因应说明还没到 6 点，实际：' + String(result.reason))
})

await test('checkFestivalSchedule：清理 90 天前的记录与图片', async () => {
  useHome('schedule-cleanup')
  const root = FESTIVALS_DIR()
  const images = IMAGES_DIR()
  mkdirSync(images, { recursive: true })
  writeFileSync(join(root, '2026-07-01.json'), '{}', 'utf8')
  writeFileSync(join(root, '2026-11-07.json'), '{}', 'utf8')
  writeFileSync(join(images, '2026-07-01.png'), Buffer.from([1, 2, 3]))
  writeFileSync(join(images, '2026-11-07.png'), Buffer.from([1, 2, 3]))
  const { ctx } = makeCtx()
  await checkFestivalSchedule(ctx, new Date(2026, 10, 5, 3, 0))
  assertEqual(existsSync(join(root, '2026-07-01.json')), false, '90 天前的记录应删除')
  assertEqual(existsSync(join(images, '2026-07-01.png')), false, '90 天前的图片应删除')
  assertEqual(existsSync(join(root, '2026-11-07.json')), true, '近期记录必须保留')
  assertEqual(existsSync(join(images, '2026-11-07.png')), true, '近期图片必须保留')
})

await test('checkFestivalSchedule：6 点后窗口内有节日且无记录 → 自动生成', async () => {
  useHome('schedule-generate')
  fetchMode = 'ok'
  const { ctx } = makeCtx()
  llmQueue.push(splitChunks(GOOD_TEXT))
  const result = await checkFestivalSchedule(ctx, new Date(2026, 10, 5, 7, 0))
  assertEqual(result.ok, true, '调度应生成，实际：' + String(result.reason))
  assert(existsSync(join(FESTIVALS_DIR(), '2026-11-07.json')), '调度生成的记录要落盘')

  const again = await checkFestivalSchedule(ctx, new Date(2026, 10, 5, 7, 30))
  assertEqual(again.ok, false, '已有记录时不该重复生成')
  assert(String(again.reason).includes('已生成'), '原因应说明已生成，实际：' + String(again.reason))
})

/* ═════════════════════════════ 路由 ═════════════════════════════ */

await test('路由：3 条 exact + 1 条 prefix 都在，形状符合契约', async () => {
  useHome('routes')
  fetchMode = 'ok'
  const { ctx, state } = makeCtx({ imageModel: true })
  applyFestivalHost(ctx)

  const todayPath = FESTIVAL_ROUTE + '/today'
  const generatePath = FESTIVAL_ROUTE + '/generate'
  const listPath = FESTIVAL_ROUTE + '/list'
  assert(state.routes.has(todayPath), 'GET /festival/today 未注册')
  assert(state.routes.has(generatePath), 'POST /festival/generate 未注册')
  assert(state.routes.has(listPath), 'GET /festival/list 未注册')
  assert(state.routes.has(FESTIVAL_IMAGE_ROUTE), 'prefix /festival/image 未注册')
  assertEqual(state.routes.get(todayPath).kind, 'exact', 'today 是 exact')
  assertEqual(state.routes.get(generatePath).kind, 'exact', 'generate 是 exact')
  assertEqual(state.routes.get(listPath).kind, 'exact', 'list 是 exact')
  assertEqual(state.routes.get(FESTIVAL_IMAGE_ROUTE).kind, 'prefix', 'image 是 prefix')

  // 生成前 today：形状必须是 ok/generating/hasToday 齐全
  const empty = jsonOf(await request(state.routes.get(todayPath)))
  assertEqual(empty.ok, true, 'today.ok')
  assertEqual(empty.generating, false, 'generating 初始 false')
  assertEqual(typeof empty.hasToday, 'boolean', 'hasToday 必须是布尔')
  assert(empty.record === null || typeof empty.record === 'object', 'record 必须是对象或 null')

  // POST /generate：用固定日期生成（不依赖运行日期）
  llmQueue.push(splitChunks(GOOD_TEXT))
  const generated = jsonOf(await request(state.routes.get(generatePath), {
    method: 'POST',
    body: { date: '2026-11-05', force: true },
  }))
  assertEqual(generated.ok, true, 'POST /generate 应成功：' + JSON.stringify(generated).slice(0, 200))
  assert(generated.record !== undefined, 'POST /generate 应返回 record')
  assertEqual(generated.record.festivalDate, '2026-11-07', '生成的是立冬记录')

  // today 的纯函数版本（注入 2026-11-05）应能读到刚生成的记录
  const todayPayload = festivalTodayPayload(new Date(2026, 10, 5))
  assert(todayPayload.record !== null, '注入日期应能读到记录')
  assertEqual(todayPayload.record.festivalDate, '2026-11-07', 'today 记录')
  assertEqual(todayPayload.next.name, '立冬', 'next 名称')
  assertEqual(todayPayload.next.countdown, '还有两天', 'next 倒计时')
  assertEqual(todayPayload.hasToday, true, 'hasToday')

  // list
  const list = jsonOf(await request(state.routes.get(listPath), { url: listPath + '?days=90' }))
  assertEqual(list.ok, true, 'list.ok')
  assert(Array.isArray(list.records), 'list.records 必须是数组')
  assert(list.records.some((item) => item.festivalDate === '2026-11-07'), 'list 应包含刚生成的记录')

  // image 路由：流式返回 PNG
  const imageResponseResult = await request(state.routes.get(FESTIVAL_IMAGE_ROUTE), {
    url: FESTIVAL_IMAGE_ROUTE + '/2026-11-07',
  })
  assertEqual(imageResponseResult.status, 200, 'image 状态码')
  assertEqual(imageResponseResult.headers['content-type'], 'image/png', 'image content-type')
  assert(imageResponseResult.buffer.length > 100 * 1024, 'image 应返回完整字节')
  assertEqual(imageResponseResult.buffer[1], 0x50, 'PNG 文件头')

  // image 404 明确 JSON
  const missing = await request(state.routes.get(FESTIVAL_IMAGE_ROUTE), { url: FESTIVAL_IMAGE_ROUTE + '/1999-01-01' })
  assertEqual(missing.status, 404, '不存在的图片必须 404')
  assertChinese(jsonOf(missing).error, '404 必须是中文 JSON')

  // 非 GET / 非 POST 方法
  const wrongToday = await request(state.routes.get(todayPath), { method: 'POST' })
  assertEqual(wrongToday.status, 405, 'today 非 GET 应 405')
  const wrongImage = await request(state.routes.get(FESTIVAL_IMAGE_ROUTE), {
    method: 'POST',
    url: FESTIVAL_IMAGE_ROUTE + '/2026-11-07',
  })
  assertEqual(wrongImage.status, 405, 'image 非 GET 应 405')

  // 跨站 POST → 403
  const cross = await request(state.routes.get(generatePath), {
    method: 'POST',
    body: {},
    headers: { origin: 'http://evil.test', host: '127.0.0.1:3080' },
  })
  assertEqual(cross.status, 403, '跨站 POST 必须 403')
})

await test('applyFestivalHost：调度定时器已挂上且可 dispose', () => {
  assert(disposers.length > 0, '调度器必须注册 effect（否则插件卸载后定时器泄漏）')
})

/* ═════════════════════════════ 收尾 ═════════════════════════════ */

globalThis.fetch = realFetch

for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* 清理失败不影响结论 */
  }
}

try {
  rmSync(OUT, { recursive: true, force: true })
  rmSync(HOME_ROOT, { recursive: true, force: true })
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log('\n[festival-card host] 通过 ' + String(passed) + ' 项')
for (const [name, error] of failures) {
  console.error('✗ ' + name + '\n  ' + String(error && error.stack ? error.stack : error))
}
if (failures.length > 0) {
  console.error('[festival-card host] 失败 ' + String(failures.length) + ' 项')
  process.exitCode = 1
}
