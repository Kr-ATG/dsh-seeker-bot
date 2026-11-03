/**
 * dsh-seeker-bot — PTC 子调用 → 生图卡的回归测试（scripts/test-personal-ptc-image.mjs）。
 *
 * 背景（2026-11-03 用户实测）：「生图的点阵图没了，图片也不展示在对话里」。
 * Bot 会话挂的是 `ptc` preset，模型在 run_code 里 `await tools.generate_image(...)`，
 * 宿主只发 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`，**不发** `tool/call` /
 * `tool/result`。宿主侧不接这两条事件时，生图卡整块消失：没有点阵占位，也没有图。
 *
 * 本测试用 fake ctx / fake agent 驱动真实的 runBotTurn，断言：
 *   1. dispatch-start 推出一张 running 的生图块（前端据此画点阵）；
 *   2. dispatch 收口后同一张卡变 ok，且带上落盘后的图片 URL 与模型名；
 *   3. 图片真的写进了 bot 工作区的 _tmp/generated-images；
 *   4. 结果被 spill 换成 locator 时（真实场景：3.5MB 大图）同样能读回；
 *   5. 非生图子调用（pwsh）不产生工具块（Bot 消息里不出现工具卡的约定）。
 *
 * 环境隔离：DSH_HOME 与 DSH_SEEKER_BOT_WORKSPACE 都指到系统临时目录；
 * spill 用例自己建一个 `dsh-spill-XXXXXX` 形状的临时 root，结束时删除。
 *
 * 直接用 Node 运行（Node 22.18+ / 24 原生剥离 TS 类型）：
 *   node scripts/test-personal-ptc-image.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// capabilities-host.js 是 host 半身源码（依赖 vendor 里的 TS 副本，Node 直接加载不了），
// 用项目自带的 esbuild 现场打成临时 ESM 再 import —— 与 scripts/test-vault.mjs 同款。
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-ptc-image-test-'))
process.env.DSH_HOME = join(tempRoot, 'dsh-home')
const workspace = join(tempRoot, 'workspace')
process.env.DSH_SEEKER_BOT_WORKSPACE = workspace

let failed = 0
const pass = (msg) => console.log(`✓ ${msg}`)
const fail = (msg) => {
  failed += 1
  console.error(`✗ ${msg}`)
}
const assert = (cond, msg) => {
  if (cond) pass(msg)
  else fail(msg)
}
const assertEqual = (actual, expected, msg) => {
  if (actual === expected) pass(msg)
  else fail(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

/** 1×1 PNG：只要 magic number 合法，落盘与展示都不关心内容。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** 第二张：只改尾部字符，让 sha1 与第一张不同（落盘成两个文件）。 */
const PNG_B64_ALT = `${PNG_B64.slice(0, -8)}AAAAAAA=`

const imageResultText = (model, b64) => JSON.stringify({ ok: true, model, data: { data: [{ b64_json: b64 }] } })

/**
 * 最小 fake 环境：一个 bot 会话 + 事件总线。
 * @param {string} botId - Bot id（同时决定 session id）。
 * @param {{ root: string } | null} spillStore - 需要覆盖 spill 分支时传入。
 */
function createHarness(botId, spillStore = null) {
  const listeners = new Set()
  const streamEvents = []
  let seq = 0
  const session = {
    id: `pa-bot-v2-${botId}`,
    header: { cwd: workspace },
    append() {},
    surface: { nodes: [] },
  }
  const emitEvent = (type, data) => {
    seq += 1
    for (const handler of [...listeners]) {
      handler(session, { seq, type, time: Date.now(), data })
    }
  }
  const agent = {
    session,
    ctx: {
      on(type, handler) {
        if (type !== 'session/event') return () => {}
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      systemPrompt: { section() {} },
      tools: { register() {} },
    },
    inject() {},
    model: { select() {} },
    followup() {},
  }
  const ctx = {
    on: () => () => {},
    get(name) {
      if (name === 'agents') return ctx.agents
      if (name === 'spillStore' && spillStore !== null) return spillStore
      return undefined
    },
    agents: {
      get: () => undefined,
      create: async ({ setup }) => {
        if (typeof setup === 'function') await setup(agent.ctx)
        return { agent }
      },
    },
  }
  return { agent, ctx, streamEvents, emitEvent }
}

/* ───────────────── 假网关 / 假 ctx（驱动真的 capabilities-host）───────────────── */

/** 一张「真 PNG + 尾部填充」的大图：尺寸解析只看 IHDR，填充用来模拟真实大图体积。 */
function bigPngBytes(padding = 240_000) {
  return Buffer.concat([Buffer.from(PNG_B64, 'base64'), Buffer.alloc(padding, 0x41)])
}

/** 一段最小合法 mp4 头（4 字节 box 长度 + 'ftyp' + brand）+ 填充，magic 判据能过。 */
function fakeMp4Bytes(padding = 2_000) {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00]),
    Buffer.alloc(padding, 0x11),
  ])
}

/**
 * 只在 127.0.0.1 上监听的假网关：按请求路径回固定 JSON。
 *
 * 为什么要起真 HTTP server 而不是 stub fetch：被测的是 callGeneration 的完整
 * 出网路径（拼 URL、带 header、读 body、解析 JSON），stub 掉 fetch 就只剩
 * 「瘦身函数」本身可测，拼错 URL 这类错误测不出来。
 */
async function startFakeGateway(routes) {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const route = routes[req.url ?? '']
      // 原始字节路由：模拟「网关给的是图片 url，工具要去下载落盘」这条分支。
      if (route !== undefined && Buffer.isBuffer(route.raw)) {
        res.writeHead(200, { 'content-type': route.contentType ?? 'application/octet-stream' })
        res.end(route.raw)
        return
      }
      const payload = route ?? { error: `no route: ${req.url}` }
      res.writeHead(payload.error === undefined ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  return { server, baseURL: `http://127.0.0.1:${address.port}` }
}

/**
 * 驱动 capabilities-host 的最小 ctx。
 *
 * 只提供 apply 路径上真正用到的四个服务（settings / llm / tools / webServer）
 * 与 effect：settings.register 返回一个内存 scope，于是 ownConfig() 读到我们
 * 指定的 imageActive / videoActive，工具就能按「已选模型」正常走 callGeneration。
 * ctx.get('credentials') 返回 undefined —— 假 profile 不设 apiKeyEnv，不会因此报错。
 */
function createCapabilitiesHarness({ config, providers }) {
  const registered = new Map()
  const state = { ...config }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    settings: {
      writable: true,
      register: () => ({
        get: () => ({ ...state }),
        update: async (patch) => { Object.assign(state, patch) },
      }),
      get: (ns) => (ns === 'llm-pi-ai' ? { providers } : undefined),
      describe: () => [],
    },
    llm: {
      listConfigurableProviders: () => [],
      listProviders: () => [],
      listModels: async () => [],
    },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    webServer: { register: () => () => {} },
    get: () => undefined,
  }
  return { ctx, registered }
}

/** 把 host 半身的 capabilities-host.js 打成临时 ESM 再 import（Node 认不了 .js 里的 .ts import）。 */
async function loadCapabilitiesHost() {
  const outfile = join(tempRoot, 'capabilities-host.bundle.mjs')
  await build({
    entryPoints: [join(ROOT, 'src', 'provider', 'capabilities-host.js')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    logLevel: 'silent',
  })
  return await import(pathToFileURL(outfile).href)
}

/** 生图/生视频工具的落盘根（与 spill/materialize.ts 的 materializeRoot() 同口径）。 */
function generatedRoot() {
  return join(process.env.DSH_HOME, 'storages', 'dsh-seeker-bot-generated')
}

/** 一轮里最典型的 PTC 生图事件序列。 */
function scriptImageTurn(emitEvent, { subCallId, prompt, size, n, resultText }) {
  emitEvent('tool/call', {
    callId: 'call-run-code-1',
    name: 'run_code',
    arguments: JSON.stringify({ code: 'await tools.generate_image({...})' }),
  })
  const args = { prompt, size, n }
  emitEvent('tool/ptc-dispatch-start', {
    rootCallId: 'call-run-code-1',
    parentCallId: 'call-run-code-1',
    subCallId,
    name: 'generate_image',
    arguments: args,
  })
  /* 非生图子调用：不该产生任何工具块。 */
  emitEvent('tool/ptc-dispatch-start', {
    rootCallId: 'call-run-code-1',
    parentCallId: 'call-run-code-1',
    subCallId: `${subCallId}-pwsh`,
    name: 'pwsh',
    arguments: { command: 'Get-ChildItem' },
  })
  emitEvent('tool/ptc-dispatch', {
    rootCallId: 'call-run-code-1',
    parentCallId: 'call-run-code-1',
    subCallId: `${subCallId}-pwsh`,
    name: 'pwsh',
    arguments: { command: 'Get-ChildItem' },
    isError: false,
    content: [{ type: 'text', text: 'OK' }],
  })
  emitEvent('tool/ptc-dispatch', {
    rootCallId: 'call-run-code-1',
    parentCallId: 'call-run-code-1',
    subCallId,
    name: 'generate_image',
    arguments: args,
    isError: false,
    content: [{ type: 'text', text: resultText }],
  })
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '出好了。' }] } })
  emitEvent('turn/end', { reason: 'stop' })
}

let spillRoot = null
try {
  const { runBotTurn } = await import(pathToFileURL(join(ROOT, 'src', 'host', 'personal', 'agent.ts')).href)

  /* ── 1. 内联结果：点阵占位 → 带图的卡 ─────────────────────────────── */
  {
    const botId = 'ptc-image-bot'
    const harness = createHarness(botId)
    harness.agent.followup = () => scriptImageTurn(harness.emitEvent, {
      subCallId: 'call-run-code-1:ptc:1',
      prompt: '氷越しの夏',
      size: '1024x1536',
      n: 1,
      resultText: imageResultText('test/image-model', PNG_B64),
    })

    const turn = await runBotTurn(
      harness.ctx,
      { botId, name: 'PTC 生图机器人', role: '助手', description: '', instructions: '', model: { provider: 'test-provider', model: 'test-model' } },
      '生成一张氷越しの夏',
      (event) => harness.streamEvents.push(event),
    )
    assertEqual(turn.ok, true, 'runBotTurn 跑完一轮（fake agent）')

    const toolStreams = harness.streamEvents.filter((event) => event.type === 'tool')
    const runningCard = toolStreams.find((event) => event.run?.name === 'generate_image' && event.run?.status === 'running')
    assert(runningCard !== undefined, 'dispatch-start 推出 running 的生图块（前端画点阵）')
    assertEqual(runningCard?.run?.imageCount, 1, '点阵占位拿到张数 n=1')
    assert(Math.abs((runningCard?.run?.imageRatio ?? 0) - 1024 / 1536) < 1e-6, '点阵占位拿到宽高比 1024x1536')
    assertEqual(runningCard?.run?.prompt, '氷越しの夏', '点阵占位拿到完整提示词')

    const settledCard = [...toolStreams].reverse().find((event) => event.run?.name === 'generate_image')
    assertEqual(settledCard?.run?.status, 'ok', 'dispatch 收口后生图块状态为 ok')
    assertEqual(settledCard?.run?.model, 'test/image-model', '生图块带上模型名')
    const images = settledCard?.run?.images ?? []
    assertEqual(images.length, 1, '生图块带 1 张图片')
    assert(
      typeof images[0] === 'string' && images[0].startsWith('/api/personal-agent/file?path='),
      '图片地址走宿主文件路由（前端可直接 <img src>）',
    )

    const outDir = join(workspace, '_tmp', 'generated-images')
    assert(existsSync(outDir), '图片落盘目录已创建')
    const files = existsSync(outDir) ? readdirSync(outDir) : []
    assert(files.length === 1 && files[0].endsWith('.png'), '工作区里落下一张 png')

    const pwshCard = toolStreams.find((event) => event.run?.name === 'pwsh')
    assertEqual(pwshCard, undefined, 'pwsh 子调用不产生工具块（Bot 消息里不出现工具卡）')

    const blockCards = turn.blocks.filter((block) => block.type === 'tool' && block.run?.name === 'generate_image')
    assertEqual(blockCards.length, 1, 'TurnResult.blocks 里只有一张生图卡（没有裂成两张）')
    assertEqual((blockCards[0]?.run?.images ?? []).length, 1, 'TurnResult.blocks 里的生图卡同样带图')
  }

  /* ── 2. spill 结果：大图被换成 locator 时同样能读回 ───────────────── */
  /*
   * 真实场景里 3.5MB 的生图结果 100% 会被 spill：content 里只剩一行
   * 「Full formatted result stored at: <路径>」。这条路径必须走通，否则卡片
   * 会一直停在「ok 但没有图」——那正是用户报的现象的一半。
   */
  spillRoot = mkdtempSync(join(tmpdir(), 'dsh-spill-'))
  const spillSession = join(spillRoot, 'session-0123456789ab')
  mkdirSync(spillSession, { recursive: true })
  const spillFile = join(spillSession, 'f4c7e0f91897-generate_image.txt')
  writeFileSync(spillFile, imageResultText('test/image-model-spill', PNG_B64_ALT), 'utf8')

  {
    const botId = 'ptc-image-spill-bot'
    const harness = createHarness(botId, { root: spillRoot })
    harness.agent.followup = () => scriptImageTurn(harness.emitEvent, {
      subCallId: 'call-run-code-2:ptc:1',
      prompt: 'spill 场景',
      size: '1024x1024',
      n: 2,
      resultText: `(Omitted 3712515 bytes. Full formatted result stored at: ${spillFile}. Use read with offset/limit, or grep this path to search within it.)`,
    })

    const turn = await runBotTurn(
      harness.ctx,
      { botId, name: 'PTC spill 机器人', role: '助手', description: '', instructions: '', model: { provider: 'test-provider', model: 'test-model' } },
      '生成一张大图',
      (event) => harness.streamEvents.push(event),
    )
    assertEqual(turn.ok, true, 'spill 用例跑完一轮')

    const settled = [...harness.streamEvents].reverse().find((event) => event.type === 'tool' && event.run?.name === 'generate_image')
    assertEqual(settled?.run?.status, 'ok', 'spill 用例：生图块状态为 ok')
    assertEqual((settled?.run?.images ?? []).length, 1, 'spill 用例：从 spill 文件里读回 1 张图')
    assertEqual(settled?.run?.model, 'test/image-model-spill', 'spill 用例：模型名来自 spill 全文')
  }
  /* ── 5. 生图工具瘦身：大 base64 不再回给模型（2026-11-03 修复）──────── */
  /*
   * 根因：工具把网关原始 JSON（约 3.8MB b64_json）直接回给模型，模型在
   * run_code 里打印被截断，误以为「没拿到图」→ 再调一次 → 用户要一张得两张。
   * 这条用例用假网关 + 假 ctx 驱动**真的** capabilities-host，断言：
   *   1. 返回体里没有 b64（小到不可能被截断）；
   *   2. 图真的落在 <DSH_HOME>/storages/dsh-seeker-bot-generated/generated；
   *   3. images[] 带 path / mime / bytes / width / height；
   *   4. 再调一次落在同一个文件上（幂等，不重复写盘）。
   */
  const hostMod = await loadCapabilitiesHost()
  {
    const pngBytes = bigPngBytes()
    const b64 = pngBytes.toString('base64')
    const gateway = await startFakeGateway({
      '/images/generations': { created: 1, data: [{ b64_json: b64 }] },
    })
    try {
      const harness = createCapabilitiesHarness({
        config: {
          flags: { 'fake-route/fake-image': { image: true, video: true, speech: false, enabled: true } },
          imageActive: 'fake-route/fake-image',
          videoActive: 'fake-route/fake-image',
          imagePath: 'images/generations',
          videoPath: 'videos/generations',
          proxyUrl: '',
        },
        providers: { 'fake-route': { baseURL: gateway.baseURL } },
      })
      hostMod.apply(harness.ctx)
      const tool = harness.registered.get('generate_image')
      assert(tool !== undefined, 'generate_image 工具已注册（假 ctx 驱动真 capabilities-host）')

      const result = await tool.execute({ prompt: '氷越しの夏' }, { signal: undefined })
      const text = JSON.stringify(result)
      assert(!text.includes('b64_json'), '返回体里没有 b64_json（模型不会再看到被截断的 base64）')
      assert(text.length < 4000, `返回体足够小（${text.length} 字节；修复前是 3.8MB 量级）`)
      assertEqual(result.ok, true, '生图工具返回 ok:true')
      assertEqual(result.model, 'fake-route/fake-image', '返回体带上模型名')
      assertEqual(result.images?.length, 1, '返回 images[] 里有一张图')

      const image = result.images?.[0] ?? {}
      assert(typeof image.path === 'string' && isAbsolute(image.path), 'images[0].path 是绝对路径')
      assert(image.path.startsWith(generatedRoot()), '落盘路径在 materializeRoot() 之内（前端 /file 路由能读）')
      assert(existsSync(image.path), '图片真的落到了磁盘上')
      assertEqual(image.mime, 'image/png', 'images[0].mime 是 image/png')
      assertEqual(image.bytes, pngBytes.byteLength, 'images[0].bytes 是落盘字节数')
      assertEqual(image.width, 1, 'images[0].width 从 IHDR 解析（1）')
      assertEqual(image.height, 1, 'images[0].height 从 IHDR 解析（1）')
      assert(
        String(result.note ?? '').includes('不要用同一提示词重复生成'),
        'note 明确告诉模型「图已落盘、别重复生成」',
      )

      const again = await tool.execute({ prompt: '氷越しの夏' }, { signal: undefined })
      assertEqual(again.images?.[0]?.path, image.path, '同一张图再调一次落在同一个文件上（幂等）')
      const files = readdirSync(join(generatedRoot(), 'generated'))
      assertEqual(files.length, 1, '重复调用不会写出第二个文件')
    } finally {
      await new Promise((resolvePromise) => gateway.server.close(resolvePromise))
    }
  }

  /* ── 5b. 生视频瘦身：异步任务 id 保留、大 b64 不进返回体 ────────────── */
  {
    const gateway = await startFakeGateway({
      '/videos/generations': {
        data: { id: 'task-42', status: 'queued', progress: 10, video_b64: 'A'.repeat(50_000) },
      },
    })
    try {
      const harness = createCapabilitiesHarness({
        config: {
          flags: { 'fake-route/fake-image': { image: true, video: true, speech: false, enabled: true } },
          imageActive: 'fake-route/fake-image',
          videoActive: 'fake-route/fake-image',
          imagePath: 'images/generations',
          videoPath: 'videos/generations',
          proxyUrl: '',
        },
        providers: { 'fake-route': { baseURL: gateway.baseURL } },
      })
      hostMod.apply(harness.ctx)
      const tool = harness.registered.get('generate_video')
      assert(tool !== undefined, 'generate_video 工具已注册')

      const result = await tool.execute({ prompt: '海边日落' }, { signal: undefined })
      const text = JSON.stringify(result)
      assert(!text.includes('A'.repeat(1000)), '返回体里没有那段 50KB 的 base64')
      assert(text.length < 4000, `视频返回体足够小（${text.length} 字节）`)
      assertEqual(result.videos?.length, 0, '异步任务形态：没有可播放文件')
      assertEqual(result.task?.id, 'task-42', 'task.id 原样保留（模型据此转告 / 轮询）')
      assertEqual(result.task?.status, 'queued', 'task.status 原样保留')
      assert(String(result.note ?? '').includes('异步任务'), 'note 说明这是异步任务、不要重复提交')
    } finally {
      await new Promise((resolvePromise) => gateway.server.close(resolvePromise))
    }
  }

  /* ── 5c. 生视频：网关给 b64 时也能落盘成真实文件 ───────────────────── */
  {
    const mp4Bytes = fakeMp4Bytes()
    const gateway = await startFakeGateway({
      '/videos/generations': { data: { data: [{ b64_json: mp4Bytes.toString('base64') }] } },
    })
    try {
      const harness = createCapabilitiesHarness({
        config: {
          flags: { 'fake-route/fake-image': { image: true, video: true, speech: false, enabled: true } },
          imageActive: 'fake-route/fake-image',
          videoActive: 'fake-route/fake-image',
          imagePath: 'images/generations',
          videoPath: 'videos/generations',
          proxyUrl: '',
        },
        providers: { 'fake-route': { baseURL: gateway.baseURL } },
      })
      hostMod.apply(harness.ctx)
      const tool = harness.registered.get('generate_video')
      const result = await tool.execute({ prompt: '海边日落' }, { signal: undefined })
      assertEqual(result.videos?.length, 1, 'b64 视频被落盘成一条 videos[]')
      const video = result.videos?.[0] ?? {}
      assert(typeof video.path === 'string' && existsSync(video.path), '视频文件真的落到了磁盘上')
      assertEqual(video.mime, 'video/mp4', '视频 mime 是 video/mp4')
      assert(!JSON.stringify(result).includes(mp4Bytes.toString('base64').slice(0, 200)), '返回体里没有视频 base64')
    } finally {
      await new Promise((resolvePromise) => gateway.server.close(resolvePromise))
    }
  }

  /* ── 5d. 网关给 url（不是 b64）时也下载落盘；下载失败保留 url ────── */
  /*
   * 真实网关有两种形态：有的回 b64_json，有的只回一个 CDN 地址。后一种如果不
   * 下载落盘，模型拿到的 path 就是空的，前端也显示不出图 —— 任务要求「url 也要
   * 落盘；下载失败则保留 images[].url 不丢信息」，这条用例把两个分支都钉住。
   */
  {
    const pngBytes = Buffer.from(PNG_B64, 'base64')
    const routes = {}
    const gateway = await startFakeGateway(routes)
    routes['/files/img.png'] = { raw: pngBytes, contentType: 'image/png' }
    routes['/images/generations'] = { data: [{ url: `${gateway.baseURL}/files/img.png` }] }
    try {
      const harness = createCapabilitiesHarness({
        config: {
          flags: { 'fake-route/fake-image': { image: true, video: true, speech: false, enabled: true } },
          imageActive: 'fake-route/fake-image',
          videoActive: 'fake-route/fake-image',
          imagePath: 'images/generations',
          videoPath: 'videos/generations',
          proxyUrl: '',
        },
        providers: { 'fake-route': { baseURL: gateway.baseURL } },
      })
      hostMod.apply(harness.ctx)
      const tool = harness.registered.get('generate_image')

      const downloaded = await tool.execute({ prompt: 'url 形态' }, { signal: undefined })
      const downloadedImage = downloaded.images?.[0] ?? {}
      assert(typeof downloadedImage.path === 'string' && existsSync(downloadedImage.path), 'url 形态：图片被下载并落盘')
      assertEqual(downloadedImage.bytes, pngBytes.byteLength, 'url 形态：落盘字节与远端一致')
      assertEqual(downloadedImage.width, 1, 'url 形态：尺寸仍从 IHDR 解析')

      // 下载失败（404）：保留原 url，不丢信息。
      routes['/images/generations'] = { data: [{ url: `${gateway.baseURL}/files/missing.png` }] }
      const fallback = await tool.execute({ prompt: 'url 形态 404' }, { signal: undefined })
      const fallbackImage = fallback.images?.[0] ?? {}
      assertEqual(fallbackImage.path, undefined, '下载失败时不伪造 path')
      assertEqual(
        fallbackImage.url,
        `${gateway.baseURL}/files/missing.png`,
        '下载失败时保留原 url（信息不丢）',
      )
    } finally {
      await new Promise((resolvePromise) => gateway.server.close(resolvePromise))
    }
  }

  /* ── 6. 新格式（图已落盘）→ 对话流仍能显示 ───────────────────────── */
  /*
   * 这是修复的另一半：工具只回 path，如果下游不认新格式，生图卡就是
   * 「ok 但没有图」—— 比重复生成更糟。这里断言 agent.ts 能把本地文件复制进
   * bot 工作区并生成同源 URL（前端直接 <img src>）。
   */
  const newFormatImagePath = join(generatedRoot(), 'generated', 'fedcba9876543210.png')
  mkdirSync(dirname(newFormatImagePath), { recursive: true })
  writeFileSync(newFormatImagePath, Buffer.from(PNG_B64_ALT, 'base64'))
  {
    const botId = 'ptc-image-new-format-bot'
    const harness = createHarness(botId)
    const resultText = JSON.stringify({
      ok: true,
      model: 'test/new-format-model',
      endpoint: 'http://127.0.0.1/v1/images/generations',
      images: [{
        path: newFormatImagePath,
        mime: 'image/png',
        bytes: Buffer.from(PNG_B64_ALT, 'base64').byteLength,
        width: 1,
        height: 1,
      }],
      note: '图片已落盘为真实文件（images[].path 是绝对路径），无需再解码保存：可直接 present，或把路径告知用户；不要用同一提示词重复生成。',
    })
    harness.agent.followup = () => scriptImageTurn(harness.emitEvent, {
      subCallId: 'call-run-code-5:ptc:1',
      prompt: '新格式一张图',
      size: '1024x1536',
      n: 1,
      resultText,
    })

    const turn = await runBotTurn(
      harness.ctx,
      { botId, name: 'PTC 新格式机器人', role: '助手', description: '', instructions: '', model: { provider: 'test-provider', model: 'test-model' } },
      '生成一张图',
      (event) => harness.streamEvents.push(event),
    )
    assertEqual(turn.ok, true, '新格式用例跑完一轮')

    const settled = [...harness.streamEvents].reverse().find((event) => event.type === 'tool' && event.run?.name === 'generate_image')
    assertEqual(settled?.run?.status, 'ok', '新格式：生图块状态为 ok')
    assertEqual(settled?.run?.model, 'test/new-format-model', '新格式：模型名解析出来了')
    const images = settled?.run?.images ?? []
    assertEqual(images.length, 1, '新格式：生图块带 1 张图（本地 path 被复制进工作区）')
    assert(
      typeof images[0] === 'string' && images[0].startsWith('/api/personal-agent/file?path='),
      '新格式：图片地址是同源文件路由（前端可直接 <img src>）',
    )
    assertEqual(turn.blocks.filter((block) => block.type === 'tool' && block.run?.name === 'generate_image').length, 1, '新格式：只有一张生图卡')
  }

  /* ── 7. 解析器：新旧格式都认，新格式能落出文件 ───────────────────── */
  {
    const materialize = await import(pathToFileURL(join(ROOT, 'src', 'spill', 'materialize.ts')).href)
    const newFormat = materialize.parseGeneratedResult(JSON.stringify({
      ok: true,
      model: 'test/new-format-model',
      images: [{ path: newFormatImagePath, mime: 'image/png', bytes: 1, width: 1, height: 1 }],
    }))
    assertEqual(newFormat.ok, true, 'parseGeneratedResult：新格式解析成功')
    assertEqual(newFormat.urls.length, 1, 'parseGeneratedResult：新格式解析出 1 张图')
    assert(
      String(newFormat.urls[0]).startsWith('/api/personal-agent/file?path='),
      'parseGeneratedResult：path 转成同源文件路由 URL（客户端能显示）',
    )
    assertEqual(
      materialize.localPathOfImageRef(newFormat.urls[0]),
      newFormatImagePath,
      'localPathOfImageRef：同源 URL 能还原成本地绝对路径（host 侧读文件）',
    )

    const oldFormat = materialize.parseGeneratedResult(imageResultText('test/old', PNG_B64))
    assertEqual(oldFormat.urls.length, 1, 'parseGeneratedResult：旧格式（b64_json）仍然解析出 1 张')
    assert(String(oldFormat.urls[0]).startsWith('data:image/png;base64,'), 'parseGeneratedResult：旧格式仍是 data URL（行为不变）')

    const urlFirst = materialize.parseGeneratedResult(JSON.stringify({
      ok: true,
      images: [{ url: 'https://cdn.example.com/a.png', path: '/nowhere/a.png' }],
    }))
    assertEqual(urlFirst.urls[0], 'https://cdn.example.com/a.png', 'images[].url 优先于 path')

    const outDir = join(tempRoot, 'materialize-out')
    const files = await materialize.materializeImages(
      JSON.stringify({ ok: true, images: [{ path: newFormatImagePath }] }),
      outDir,
    )
    assertEqual(files.length, 1, 'materializeImages：新格式能落出文件（本地文件分支）')
    assert(files[0] !== undefined && existsSync(files[0].path), 'materializeImages：落盘文件真的写出来了')
    assertEqual(files[0]?.name, 'img-1.png', 'materializeImages：扩展名取本地文件真实后缀')
  }

  /* ── 8. 客户端画廊解析：新格式也能出可显示 URL ─────────────────── */
  {
    const clientParse = await import(pathToFileURL(join(ROOT, 'src', 'client', 'generated-images', 'parse.ts')).href)
    const entries = clientParse.parseGeneratedImageText(JSON.stringify({
      ok: true,
      model: 'test/client-model',
      images: [{ path: 'D:\\imgs\\a.png', mime: 'image/png', bytes: 1 }],
    }))
    assertEqual(entries.length, 1, 'parseGeneratedImageText：新格式解析出 1 张图')
    assert(
      String(entries[0]?.url).startsWith('/api/personal-agent/file?path='),
      'parseGeneratedImageText：path 拼成同源文件路由 URL',
    )
    assertEqual(entries[0]?.model, 'test/client-model', 'parseGeneratedImageText：带上模型名')

    const oldEntries = clientParse.parseGeneratedImageText(imageResultText('test/old', PNG_B64))
    assertEqual(oldEntries.length, 1, 'parseGeneratedImageText：旧格式仍然解析出 1 张（行为不变）')

    let threw = false
    try {
      clientParse.parseGeneratedImageText('{not json')
      clientParse.parseGeneratedImageText(JSON.stringify({ ok: true, images: [null, 42, {}, { path: '' }] }))
      clientParse.parseGeneratedImageText(JSON.stringify({ ok: false, images: [{ path: '/x.png' }] }))
    } catch {
      threw = true
    }
    assertEqual(threw, false, 'parseGeneratedImageText：坏输入 / 空项 / ok:false 都不会抛错')
  }

  /* ── 3. 文档进度：模型用 document_progress 声明（不再猜关键词）──────── */
  /*
   * 旧实现拿参数关键词猜（.docx / python-docx）：猜不中整段空白，猜中了也只是
   * 碰巧。现在由模型自己声明——start 挂占位、done 收起，判据是事实而不是关键词。
   */
  {
    const botId = 'ptc-doc-bot'
    const harness = createHarness(botId)
    harness.agent.followup = () => {
      harness.emitEvent('tool/call', {
        callId: 'call-run-code-3',
        name: 'run_code',
        arguments: JSON.stringify({ code: 'await tools.document_progress({...})' }),
      })
      harness.emitEvent('tool/ptc-dispatch-start', {
        rootCallId: 'call-run-code-3',
        parentCallId: 'call-run-code-3',
        subCallId: 'call-run-code-3:ptc:1',
        name: 'document_progress',
        arguments: { phase: 'start', format: 'docx', title: '季度复盘 Word 报告' },
      })
      harness.emitEvent('tool/ptc-dispatch', {
        rootCallId: 'call-run-code-3',
        parentCallId: 'call-run-code-3',
        subCallId: 'call-run-code-3:ptc:1',
        name: 'document_progress',
        arguments: { phase: 'start', format: 'docx', title: '季度复盘 Word 报告' },
        isError: false,
        content: [{ type: 'text', text: '已记录文档生成进度' }],
      })
      harness.emitEvent('tool/ptc-dispatch-start', {
        rootCallId: 'call-run-code-3',
        parentCallId: 'call-run-code-3',
        subCallId: 'call-run-code-3:ptc:2',
        name: 'document_progress',
        arguments: { phase: 'done' },
      })
      harness.emitEvent('tool/ptc-dispatch', {
        rootCallId: 'call-run-code-3',
        parentCallId: 'call-run-code-3',
        subCallId: 'call-run-code-3:ptc:2',
        name: 'document_progress',
        arguments: { phase: 'done' },
        isError: false,
        content: [{ type: 'text', text: '已记录文档生成进度' }],
      })
      harness.emitEvent('turn/end', { reason: 'stop' })
    }

    const turn = await runBotTurn(
      harness.ctx,
      { botId, name: 'PTC 文档机器人', role: '助手', description: '', instructions: '', model: { provider: 'test-provider', model: 'test-model' } },
      '把结论整理成 Word',
      (event) => harness.streamEvents.push(event),
    )
    assertEqual(turn.ok, true, '文档声明用例跑完一轮')

    const runningDoc = harness.streamEvents.find(
      (event) => event.type === 'tool' && event.run?.docPending === true && event.run?.status === 'running',
    )
    assert(runningDoc !== undefined, 'document_progress(start) 推出「正在生成文档」点阵占位')
    assertEqual(runningDoc?.run?.args, '季度复盘 Word 报告', '占位副标题取声明里的 title')
    const settledDoc = [...harness.streamEvents]
      .reverse()
      .find((event) => event.type === 'tool' && event.run?.docPending === true)
    assertEqual(settledDoc?.run?.status, 'ok', 'document_progress(done) 收起占位（不残留转圈）')
  }

  /* ── 4. 文件系统兜底：模型漏声明时，文档文件写出来也命中 ───────────── */
  /*
   * 主路径是模型声明；但模型可能漏调。漏掉就整段空白，等于没命中。
   * 这条兜底看的是事实：工作区里真的写出了一个 docx，就补一块占位。
   */
  {
    const botId = 'ptc-doc-watch-bot'
    const harness = createHarness(botId)
    harness.agent.followup = () => {
      harness.emitEvent('tool/call', {
        callId: 'call-run-code-4',
        name: 'run_code',
        arguments: JSON.stringify({ code: '// 直接写文件，没有声明' }),
      })
      // 模拟模型用脚本写出 docx（没有任何 document_progress 声明）
      writeFileSync(join(workspace, '报告-2026-11-03.docx'), Buffer.from('PK fake docx payload'))
      // fs.watch 是异步投递的：轮询等到占位出现（或 3 秒超时）再收口
      const deadline = Date.now() + 3000
      const settleWhenSeen = () => {
        const hit = harness.streamEvents.some((event) => event.type === 'tool' && event.run?.docPending === true)
        if (!hit && Date.now() < deadline) {
          setTimeout(settleWhenSeen, 50)
          return
        }
        harness.emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '报告好了。' }] } })
        harness.emitEvent('turn/end', { reason: 'stop' })
      }
      setTimeout(settleWhenSeen, 50)
    }

    const turn = await runBotTurn(
      harness.ctx,
      { botId, name: 'PTC 兜底机器人', role: '助手', description: '', instructions: '', model: { provider: 'test-provider', model: 'test-model' } },
      '写一份报告',
      (event) => harness.streamEvents.push(event),
    )
    assertEqual(turn.ok, true, '文件兜底用例跑完一轮')
    const docCard = harness.streamEvents.find((event) => event.type === 'tool' && event.run?.docPending === true)
    assert(docCard !== undefined, '模型漏声明时，工作区写出 docx 也会补一块文档进度占位')
    assert(
      String(docCard?.run?.args ?? '').includes('.docx'),
      '兜底占位的副标题是文件名',
    )
  }
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发占用：临时目录由系统清理 */
  }
  if (spillRoot !== null) {
    try {
      rmSync(spillRoot, { recursive: true, force: true })
    } catch {
      /* 同上 */
    }
  }
}

if (failed > 0) {
  console.error(`\n[ptc image] ${failed} 项断言失败`)
  process.exitCode = 1
} else {
  console.log('\n[ptc image] PASS')
}
