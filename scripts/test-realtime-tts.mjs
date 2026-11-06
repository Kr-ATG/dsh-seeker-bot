/**
 * 回复气泡朗读（TTS）端到端测试 —— 浏览器（fetch）⇄ 宿主（`attachRealtimeRoutes`）⇄ 假 StepFun 上游。
 *
 * 链路：`POST /api/personal-agent/tts` → `synthesizeSpeech` → 一次性实时会话
 *       → `scripts/lib/fake-stepfun.mjs`（纯 node 假上游，不联网）→ WAV。
 *
 * 覆盖（对应任务验收标准）：
 *   - `encodeWav`：44 字节头、RIFF/WAVE/fmt/data 字段、长度 = 44 + PCM；
 *   - 成功：200 + `audio/wav` + `content-length` + `cache-control: no-store`；
 *   - 返回的 WAV 能被解析（采样率 / 声道 / 位深 / PCM 内容与上游吐的字节一致）；
 *   - `x-tts-duration-ms` 与 PCM 长度吻合；
 *   - 上游收到 `session.update`：朗读指令、音色、modalities、pcm16、**无 turn_detection**、**无 tools**；
 *   - 上游收到 `conversation.item.create`（role=user，文本含原文）与 `response.create`，且顺序正确；
 *   - 朗读结束后上游连接被关闭（每次朗读一条会话，不泄漏）；
 *   - 空文本 → 400；超长文本被截断到 `REALTIME_TTS_MAX_CHARS`；
 *   - 非 POST → 405；请求体非法 JSON → 400；请求体超 32KB → 413；
 *   - 没配 key → 502 且错误中文可读；
 *   - 上游握手 401 → 502 且提示鉴权；
 *   - 上游 `error` 事件 → 502；
 *   - 上游中途断开 → 502。
 *
 * 流式朗读（`stream: true`，用户反馈「播放延迟太高」的回归）：
 *   - 200 + `REALTIME_TTS_STREAM_MIME` + `x-tts-sample-rate` + no-store；
 *   - body 是裸 PCM16，字节与上游所有 audio delta 拼起来完全一致；
 *   - **首片在 response.done 之前到达**（假上游分 3 片、片间 120ms 吐出，证明宿主
 *     不是等整段合成完才回包）；
 *   - 首包前的 401 / 上游 error 事件 → JSON 错误 + 非 200（不是断流）；
 *   - 客户端中途断开 → 上游连接被关闭（不泄漏会话）；
 *   - 上游把 session.updated 拖后 500ms 时朗读仍立刻完成（证明已经不等它）；
 *   - `session.created` 与 101 合并进 upgrade head 时也能正常合成；
 *   - 非 stream 请求仍回完整 WAV（旧行为不变）。
 *
 * Usage: node scripts/test-realtime-tts.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { attachRealtimeRoutes } from '../src/host/personal/realtime/index.ts'
import { defaultTtsTimeoutMs, encodeWav } from '../src/host/personal/realtime/tts.ts'
import {
  REALTIME_TTS_MAX_CHARS,
  REALTIME_TTS_PATH,
  REALTIME_TTS_SAMPLE_RATE_HEADER,
  REALTIME_TTS_STREAM_MIME,
} from '../src/shared/realtime-protocol.ts'
import { createFakeStepfun, waitFor } from './lib/fake-stepfun.mjs'

const FAKE_API_KEY = 'tts-test-api-key'
const FAKE_VENDOR_ID = 'fake-tts-vendor'
const FAKE_KEY_REF = 'FAKE_TTS_KEY'
const FAKE_MODEL = 'stepaudio-3-realtime-preview'
const SAMPLE_RATE = 24000
/** 上游一次下行的 PCM 字节数：2400 字节 = 1200 采样 @ 24kHz = 50ms。 */
const PCM_BYTES = 2400
const TEXT = '你好，这是一段要朗读的回复正文。'

/** 上游下行音频：每个字节都不一样，用来验证「收到的 delta 被原样拼进 WAV」。 */
const RESPONSE_PCM = Buffer.alloc(PCM_BYTES)
for (let i = 0; i < RESPONSE_PCM.length; i += 1) RESPONSE_PCM[i] = (i * 37) & 0xff

/**
 * 未处理的 rejection 默认会直接杀掉测试进程。先收集再断言，让测试跑完并留下证据。
 */
const unhandledRejections = []
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason instanceof Error ? reason.message : String(reason))
})

/** 整体看门狗：某条用例挂住时不要卡死 CI（正常跑完会清掉）。 */
const watchdog = setTimeout(() => {
  console.error('[realtime-tts] 测试整体超时（90 秒），强制退出')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

let passed = 0
let failed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name}: ${message}`)
    console.error(`  FAIL ${name}\n       ${message}`)
  }
}

/** 起一个挂好真实路由的裸 http server。 */
async function startProxy(routeOptions) {
  const server = createServer()
  const detach = attachRealtimeRoutes(server, routeOptions)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const { port } = server.address()
  return {
    port,
    ttsUrl: `http://127.0.0.1:${port}${REALTIME_TTS_PATH}`,
    detach,
    close() {
      return new Promise((resolve) => {
        detach()
        server.closeAllConnections?.()
        server.close(() => resolve())
        setTimeout(resolve, 200).unref?.()
      })
    },
  }
}

/** 假上游 + 宿主路由的一套环境。 */
async function startEnv({ fakeOptions = {}, routeOptions = {}, apiKey = FAKE_API_KEY } = {}) {
  const fake = await createFakeStepfun({ apiKey, ...fakeOptions })
  const proxy = await startProxy({
    resolveApiKey: async () => apiKey,
    /*
     * Live 供应商：朗读复用通话那份配置，所以这里就是一条「能连的端点 + 一把 key +
     * 一个模型」。outputSampleRate 显式给 24000，验证 WAV 头用的是供应商配置。
     */
    resolveVendor: () => ({
      id: FAKE_VENDOR_ID,
      label: '假上游',
      upstream: fake.url,
      keyRef: FAKE_KEY_REF,
      model: FAKE_MODEL,
      outputSampleRate: SAMPLE_RATE,
    }),
    models: () => [FAKE_MODEL],
    voice: () => 'linjiajiejie',
    speed: () => 'normal',
    log: () => {},
    ...routeOptions,
  })
  return {
    fake,
    proxy,
    async close() {
      await proxy.close()
      await fake.close()
    },
  }
}

/**
 * 发一次朗读请求。
 *
 * @param {string} url 端点地址。
 * @param {object} [body] JSON 请求体（`init.body` 给定时忽略）。
 * @param {{ method?: string, body?: string }} [init] 覆盖方法 / 原始请求体。
 */
async function postTts(url, body, init = {}) {
  const res = await fetch(url, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body: init.body ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
  const buffer = Buffer.from(await res.arrayBuffer())
  return { res, buffer }
}

/** 发一次朗读请求并返回原始 Response（流式用例要自己读 body，不能先 arrayBuffer）。 */
function postTtsRaw(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * 读完一个流式响应。
 *
 * `firstChunkAt` 是**客户端**收到第一片时的墙钟时间——「首包早于 response.done」
 * 这条核心断言就靠它和假上游的 `sentLog` 对比（同一进程同一时钟）。
 */
async function readStream(res) {
  assert.ok(res.body !== null, '响应没有 body 流')
  const reader = res.body.getReader()
  const parts = []
  let firstChunkAt = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstChunkAt === 0) firstChunkAt = Date.now()
    if (value !== undefined && value !== null) parts.push(Buffer.from(value))
  }
  return { body: Buffer.concat(parts), firstChunkAt }
}

/** 解析 WAV（只认本模块产出的 44 字节标准头）。 */
function parseWav(buffer) {
  assert.ok(buffer.length >= 44, `WAV 太短（${buffer.length} 字节）`)
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(buffer.readUInt32LE(4), buffer.length - 8, 'RIFF chunk size 不等于「文件长度 - 8」')
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WAVE')
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'fmt ')
  assert.equal(buffer.readUInt32LE(16), 16, 'fmt chunk 长度不是 16')
  assert.equal(buffer.readUInt16LE(20), 1, 'audioFormat 不是 1（PCM）')
  const channels = buffer.readUInt16LE(22)
  const sampleRate = buffer.readUInt32LE(24)
  const byteRate = buffer.readUInt32LE(28)
  const blockAlign = buffer.readUInt16LE(32)
  const bitsPerSample = buffer.readUInt16LE(34)
  assert.equal(buffer.subarray(36, 40).toString('ascii'), 'data')
  const dataSize = buffer.readUInt32LE(40)
  return { channels, sampleRate, byteRate, blockAlign, bitsPerSample, dataSize, data: buffer.subarray(44) }
}

/** 取上游收到的最后一条连接（一次朗读一条会话）。 */
function lastConnection(fake) {
  const connection = fake.connection
  assert.ok(connection !== undefined, '上游没有收到任何连接')
  return connection
}

/** 从上游收到的消息里挑一条 `conversation.item.create`。 */
function itemCreateOf(connection) {
  return connection.received.find((entry) => entry.type === 'conversation.item.create')
}

/* ========================================================================== */
/* A. encodeWav 单测                                                          */
/* ========================================================================== */

console.log('\n[A] encodeWav：WAV 头结构')

await check('encodeWav：44 字节头 + PCM，字段全部正确', () => {
  const pcm = Buffer.alloc(1000)
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = i & 0xff
  const wav = encodeWav(pcm, SAMPLE_RATE)
  assert.equal(wav.length, 44 + pcm.length)
  const parsed = parseWav(wav)
  assert.equal(parsed.channels, 1, '声道数不是 1')
  assert.equal(parsed.sampleRate, SAMPLE_RATE)
  assert.equal(parsed.byteRate, SAMPLE_RATE * 2, 'byteRate 不等于 采样率 × 2')
  assert.equal(parsed.blockAlign, 2, 'blockAlign 不是 2')
  assert.equal(parsed.bitsPerSample, 16, '位深不是 16')
  assert.equal(parsed.dataSize, pcm.length)
  assert.deepEqual(parsed.data, pcm)
})

await check('encodeWav：空 PCM 也是合法 WAV（只有 44 字节头）', () => {
  const wav = encodeWav(Buffer.alloc(0), 16000)
  assert.equal(wav.length, 44)
  const parsed = parseWav(wav)
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.dataSize, 0)
})

/* ========================================================================== */
/* A2. 默认超时按字数自适应                                                   */
/* ========================================================================== */

console.log('\n[A2] 默认超时：长段朗读不能被固定的 30 秒拦腰截断')

await check('短文本最少给 60 秒', () => {
  assert.equal(defaultTtsTimeoutMs(0), 60_000)
  assert.equal(defaultTtsTimeoutMs(20), 60_000)
  assert.equal(defaultTtsTimeoutMs(100), 60_000)
})

await check('300 字 → 120 秒（旧版固定 30 秒会在约 2 倍速时正好掐在结尾前）', () => {
  assert.equal(defaultTtsTimeoutMs(300), 120_000)
})

await check('400 字 → 160 秒，且上限封顶 300 秒', () => {
  assert.equal(defaultTtsTimeoutMs(400), 160_000)
  assert.equal(defaultTtsTimeoutMs(10_000), 300_000)
})

/* ========================================================================== */
/* B. 成功链路                                                                */
/* ========================================================================== */

console.log('\n[B] 成功链路：POST /tts → 一次性会话 → WAV')

const env = await startEnv({ fakeOptions: { responseAudio: RESPONSE_PCM } })
try {
  const { res, buffer } = await postTts(env.proxy.ttsUrl, { text: TEXT, botId: 'bot-main' })

  await check('POST /tts：200 + audio/wav + content-length + no-store', () => {
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'audio/wav')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(Number(res.headers.get('content-length')), buffer.length)
  })

  await check('返回的 WAV 能被解析：24kHz / 单声道 / 16bit，且长度 = 44 + PCM', () => {
    const parsed = parseWav(buffer)
    assert.equal(parsed.sampleRate, SAMPLE_RATE)
    assert.equal(parsed.channels, 1)
    assert.equal(parsed.bitsPerSample, 16)
    assert.equal(parsed.dataSize, PCM_BYTES)
    assert.equal(buffer.length, 44 + PCM_BYTES)
  })

  await check('WAV 的 PCM 与上游下行的 audio delta 字节一致（base64 解码 + 拼接正确）', () => {
    const parsed = parseWav(buffer)
    assert.deepEqual(parsed.data, RESPONSE_PCM)
  })

  await check('x-tts-duration-ms / x-tts-sample-rate 与音频长度吻合', () => {
    assert.equal(res.headers.get('x-tts-sample-rate'), String(SAMPLE_RATE))
    const expected = Math.round((PCM_BYTES / 2 / SAMPLE_RATE) * 1000)
    assert.equal(Number(res.headers.get('x-tts-duration-ms')), expected)
    assert.equal(Number(res.headers.get('x-tts-duration-ms')), 50)
  })

  await check('一次朗读只开一条上游会话', () => {
    assert.equal(env.fake.connections.length, 1, `开了 ${env.fake.connections.length} 条上游连接`)
  })

  const connection = lastConnection(env.fake)
  const update = connection.sessionUpdate

  await check('上游 session.update：朗读指令 + 音色 + modalities + pcm16', () => {
    assert.ok(update !== null, '上游没收到 session.update')
    assert.equal(update.type, 'session.update')
    assert.deepEqual(update.session.modalities, ['text', 'audio'])
    assert.equal(update.session.voice, 'linjiajiejie')
    assert.equal(update.session.input_audio_format, 'pcm16')
    assert.equal(update.session.output_audio_format, 'pcm16')
    assert.match(String(update.session.instructions), /你是一台朗读器/)
    assert.match(String(update.session.instructions), /原样、完整地念出来/)
  })

  await check('上游 session.update 不带 turn_detection（一次性合成没有麦克风上行）', () => {
    assert.equal(update.session.turn_detection, undefined, 'session.update 里出现了 turn_detection')
  })

  await check('上游 session.update 不注册任何 tools（朗读会话不该自作主张去搜）', () => {
    assert.equal(update.session.tools, undefined, 'session.update 里出现了 tools')
  })

  await check('上游收到 conversation.item.create：role=user，文本含原文', () => {
    const entry = itemCreateOf(connection)
    assert.ok(entry !== undefined, '上游没收到 conversation.item.create')
    assert.equal(entry.raw.item.type, 'message')
    assert.equal(entry.raw.item.role, 'user')
    assert.equal(entry.raw.item.content[0].type, 'input_text')
    assert.ok(String(entry.raw.item.content[0].text).includes(TEXT), '上游收到的文本里没有原文')
  })

  await check('上游收到 response.create，且排在 conversation.item.create 之后', () => {
    assert.equal(connection.responseCreateCount, 1, `上游收到 ${connection.responseCreateCount} 条 response.create`)
    const itemIndex = connection.received.findIndex((entry) => entry.type === 'conversation.item.create')
    const createIndex = connection.received.findIndex((entry) => entry.type === 'response.create')
    assert.ok(itemIndex >= 0, '没有 conversation.item.create')
    assert.ok(createIndex > itemIndex, 'response.create 抢在 conversation.item.create 前面了')
  })

  await check('朗读结束后上游连接被关闭（不占上游并发）', async () => {
    await waitFor(() => env.fake.connection?.closed === true, { label: 'upstream closed', timeoutMs: 2000 })
  })
} finally {
  await env.close()
}

/* ========================================================================== */
/* C. 输入校验                                                                */
/* ========================================================================== */

console.log('\n[C] 输入校验：空文本 / 超长文本 / 非 POST / 非法 JSON / 超大请求体')

const envC = await startEnv({ fakeOptions: { responseAudio: RESPONSE_PCM } })
try {
  const empty = await postTts(envC.proxy.ttsUrl, { text: '   ' })
  await check('空文本 → 400，错误是中文且可读', async () => {
    assert.equal(empty.res.status, 400)
    const body = JSON.parse(empty.buffer.toString('utf8'))
    assert.equal(body.ok, false)
    assert.match(body.error, /没有要朗读的文字/)
  })

  const longText = '朗'.repeat(REALTIME_TTS_MAX_CHARS + 120)
  const long = await postTts(envC.proxy.ttsUrl, { text: longText })
  await check(`超长文本被截断到 ${REALTIME_TTS_MAX_CHARS} 字（宿主兜底，不信任旧版前端）`, () => {
    assert.equal(long.res.status, 200)
    const entry = itemCreateOf(lastConnection(envC.fake))
    assert.ok(entry !== undefined, '上游没收到 conversation.item.create')
    const sentText = String(entry.raw.item.content[0].text)
    assert.equal(sentText.length, REALTIME_TTS_MAX_CHARS)
    assert.equal(sentText, longText.slice(0, REALTIME_TTS_MAX_CHARS))
  })

  await check('GET /tts → 405（这个端点只收 POST）', async () => {
    const res = await fetch(envC.proxy.ttsUrl, { method: 'GET' })
    assert.equal(res.status, 405)
    const body = await res.json()
    assert.equal(body.ok, false)
  })

  await check('请求体不是合法 JSON → 400', async () => {
    const { res, buffer } = await postTts(envC.proxy.ttsUrl, undefined, { body: '{not json' })
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(buffer.toString('utf8')).ok, false)
  })

  await check('请求体超过 32KB → 413', async () => {
    const { res } = await postTts(envC.proxy.ttsUrl, undefined, {
      body: JSON.stringify({ text: 'x'.repeat(40 * 1024) }),
    })
    assert.equal(res.status, 413)
  })
} finally {
  await envC.close()
}

/* ========================================================================== */
/* D. 没配凭据                                                                */
/* ========================================================================== */

console.log('\n[D] 没配凭据：明确告诉用户去哪儿配')

const envNoKey = await startEnv({ routeOptions: { resolveApiKey: async () => null } })
try {
  const { res, buffer } = await postTts(envNoKey.proxy.ttsUrl, { text: TEXT })
  await check('没配 key → 502，错误里点名「凭据」与供应商', () => {
    assert.equal(res.status, 502)
    const body = JSON.parse(buffer.toString('utf8'))
    assert.equal(body.ok, false)
    assert.match(body.error, /凭据/)
    assert.match(body.error, /假上游/)
  })

  await check('没配 key 时不会白连一次上游', () => {
    assert.equal(envNoKey.fake.connections.length, 0)
  })
} finally {
  await envNoKey.close()
}

/* ========================================================================== */
/* E. 上游握手 401                                                            */
/* ========================================================================== */

console.log('\n[E] 上游握手 401：错误要提示鉴权')

const env401 = await startEnv({ fakeOptions: { handshake: 'unauthorized' } })
try {
  const { res, buffer } = await postTts(env401.proxy.ttsUrl, { text: TEXT })
  await check('上游 401 → 502，错误提示鉴权（而不是笼统的「失败」）', () => {
    assert.equal(res.status, 502)
    const body = JSON.parse(buffer.toString('utf8'))
    assert.equal(body.ok, false)
    assert.match(body.error, /鉴权|401/)
  })
} finally {
  await env401.close()
}

/* ========================================================================== */
/* F. 上游 error 事件                                                         */
/* ========================================================================== */

console.log('\n[F] 上游 error 事件：转成可读的 502')

const envError = await startEnv({ fakeOptions: { errorOnResponseCreate: { message: 'model overloaded', times: 1 } } })
try {
  const { res, buffer } = await postTts(envError.proxy.ttsUrl, { text: TEXT })
  await check('上游 error → 502，且把上游原话带进错误里（便于排查）', () => {
    assert.equal(res.status, 502)
    const body = JSON.parse(buffer.toString('utf8'))
    assert.equal(body.ok, false)
    assert.match(body.error, /model overloaded/)
  })
} finally {
  await envError.close()
}

/* ========================================================================== */
/* G. 上游中途断开                                                            */
/* ========================================================================== */

console.log('\n[G] 上游中途断开：不能挂住请求')

/*
 * slowResponseMs 让响应延迟到 300ms 之后，disconnectAfterMs 在 60ms 就把 socket 掐掉：
 * 宿主此时已经发完 prompt、正在等音频，走的是「中途断开」那条分支（而不是建连失败）。
 */
const envDrop = await startEnv({ fakeOptions: { slowResponseMs: 300, disconnectAfterMs: 60 } })
try {
  const { res, buffer } = await postTts(envDrop.proxy.ttsUrl, { text: TEXT })
  await check('上游中途断开 → 502，错误说明「断开」', () => {
    assert.equal(res.status, 502)
    const body = JSON.parse(buffer.toString('utf8'))
    assert.equal(body.ok, false)
    assert.match(body.error, /断开/)
  })
} finally {
  await envDrop.close()
}

/* ========================================================================== */
/* H. 流式朗读（stream=true）：首包即回，不等整段合成                           */
/* ========================================================================== */

console.log('\n[H] 流式朗读：首包即回（用户反馈「播放延迟太高」的回归）')

/*
 * 假上游把 2400 字节 PCM 分 3 片、片间 120ms 吐出（总共约 240ms）。
 * 宿主若还在等 response.done 才回包，首片时间必然晚于 done；流式则远早于它。
 */
const STREAM_CHUNKS = 3
const STREAM_CHUNK_DELAY_MS = 120

const envStream = await startEnv({
  fakeOptions: {
    responseAudio: RESPONSE_PCM,
    responseChunkCount: STREAM_CHUNKS,
    responseChunkDelayMs: STREAM_CHUNK_DELAY_MS,
  },
})
try {
  const res = await postTtsRaw(envStream.proxy.ttsUrl, { text: TEXT, stream: true })

  await check('stream=true → 200 + octet-stream + x-tts-sample-rate + no-store', () => {
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), REALTIME_TTS_STREAM_MIME)
    assert.equal(res.headers.get(REALTIME_TTS_SAMPLE_RATE_HEADER), String(SAMPLE_RATE))
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  const { body, firstChunkAt } = await readStream(res)
  const connection = envStream.fake.connection
  const doneEntry = connection.sentLog.find((entry) => entry.type === 'response.done')

  await check('流式 body 是裸 PCM16，字节与上游所有 audio delta 拼起来完全一致', () => {
    assert.equal(body.length, PCM_BYTES, `流式 body 长度 ${body.length}（期望 ${PCM_BYTES}）`)
    assert.deepEqual(body, RESPONSE_PCM)
  })

  await check('首片在 response.done 之前到达（证明不是等整段合成）', () => {
    assert.ok(firstChunkAt > 0, '客户端一片都没读到')
    assert.ok(doneEntry !== undefined, '上游没发 response.done')
    assert.ok(
      firstChunkAt < doneEntry.at,
      `首片 ${firstChunkAt} 不早于 response.done ${doneEntry.at}：宿主仍在等整段合成`,
    )
    // 不只是「早一点」：分片延迟合计 240ms，首片必须明显早于 done 才有意义
    assert.ok(
      doneEntry.at - firstChunkAt >= 100,
      `首片只比 done 早 ${doneEntry.at - firstChunkAt}ms，看起来仍在攒包`,
    )
  })

  await check('诊断头带 vendor / model（纯 ASCII，前端可用可不用）', () => {
    assert.equal(res.headers.get('x-tts-vendor'), FAKE_VENDOR_ID)
    assert.equal(res.headers.get('x-tts-model'), FAKE_MODEL)
  })

  await check('流式结束后上游连接被关闭（一次朗读一条会话）', async () => {
    await waitFor(() => envStream.fake.connection?.closed === true, { label: 'upstream closed', timeoutMs: 2000 })
  })
} finally {
  await envStream.close()
}

/* 首包前的失败必须回 JSON：一旦写了 200 头就再也回不去了 */

const envStream401 = await startEnv({ fakeOptions: { handshake: 'unauthorized' } })
try {
  const { res, buffer } = await postTts(envStream401.proxy.ttsUrl, { text: TEXT, stream: true })
  await check('流式 + 上游 401（首包前）→ 502 JSON，不是断流', () => {
    assert.equal(res.status, 502)
    assert.match(String(res.headers.get('content-type')), /application\/json/)
    const body = JSON.parse(buffer.toString('utf8'))
    assert.equal(body.ok, false)
    assert.match(body.error, /鉴权|401/)
  })
} finally {
  await envStream401.close()
}

const envStreamError = await startEnv({ fakeOptions: { errorOnResponseCreate: { message: 'model overloaded', times: 1 } } })
try {
  const { res, buffer } = await postTts(envStreamError.proxy.ttsUrl, { text: TEXT, stream: true })
  await check('流式 + 上游 error 事件（首包前）→ 502 JSON，不是断流', () => {
    assert.equal(res.status, 502)
    assert.match(String(res.headers.get('content-type')), /application\/json/)
    const body = JSON.parse(buffer.toString('utf8'))
    assert.equal(body.ok, false)
    assert.match(body.error, /model overloaded/)
  })
} finally {
  await envStreamError.close()
}

/* 上游在已经吐过音频之后断线：必须让客户端感知「朗读中断」，不能静默当播完 */

const envStreamDrop = await startEnv({
  fakeOptions: {
    responseAudio: RESPONSE_PCM,
    responseChunkCount: 8,
    responseChunkDelayMs: 80,
    disconnectAfterMs: 120,
  },
})
try {
  const res = await postTtsRaw(envStreamDrop.proxy.ttsUrl, { text: TEXT, stream: true })
  await check('流式中途断开（已出音频）→ 客户端读流报错，而不是被当成正常读完', async () => {
    assert.equal(res.status, 200)
    assert.ok(res.body !== null, '响应没有 body 流')
    const reader = res.body.getReader()
    let sawData = false
    let readFailed = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined && value !== null && value.length > 0) sawData = true
      }
    } catch {
      readFailed = true
    }
    assert.ok(sawData, '断开前没有收到任何音频，用例没覆盖「已出音频后失败」')
    assert.equal(readFailed, true, '流式中途断开却被当成了正常读完（用户会听到半句后静默）')
  })
} finally {
  await envStreamDrop.close()
}

/* 客户端中途取消：不能把上游会话晾着 */

const envStreamAbort = await startEnv({
  fakeOptions: {
    responseAudio: RESPONSE_PCM,
    responseChunkCount: 8,
    responseChunkDelayMs: 100,
  },
})
try {
  const controller = new AbortController()
  const res = await fetch(envStreamAbort.proxy.ttsUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: TEXT, stream: true }),
    signal: controller.signal,
  })
  const reader = res.body.getReader()
  const first = await reader.read()
  await check('客户端中途断开 → 上游连接被关闭（不泄漏会话）', async () => {
    assert.ok(first.value !== undefined && first.value !== null, '第一片没到就结束了')
    // 客户端取消：连接被销毁，宿主的 res 'close' 应触发 abort → 关上游
    controller.abort()
    await waitFor(() => envStreamAbort.fake.connection?.closed === true, {
      label: 'upstream closed after client abort',
      timeoutMs: 3000,
    })
  })
} finally {
  await envStreamAbort.close()
}

/* 不等 session.updated：把上游的确认拖后 500ms，朗读仍要立刻完成 */

const SESSION_UPDATED_DELAY_MS = 500
const envNoWait = await startEnv({
  fakeOptions: { responseAudio: RESPONSE_PCM, sessionUpdatedDelayMs: SESSION_UPDATED_DELAY_MS },
})
try {
  const startedAt = Date.now()
  const { res, buffer } = await postTts(envNoWait.proxy.ttsUrl, { text: TEXT })
  const elapsedMs = Date.now() - startedAt
  await check('不等 session.updated：上游把它拖后 500ms，朗读仍然立刻完成', () => {
    assert.equal(res.status, 200)
    assert.equal(buffer.length, 44 + PCM_BYTES)
    assert.ok(
      elapsedMs < SESSION_UPDATED_DELAY_MS - 50,
      `整次朗读耗时 ${elapsedMs}ms（上游 updated 延迟 ${SESSION_UPDATED_DELAY_MS}ms）：宿主还在等 session.updated`,
    )
  })
} finally {
  await envNoWait.close()
}

/* session.created 与 101 写在同一批字节里（落在 upgrade 的 head 参数上） */

const envImmediate = await startEnv({
  fakeOptions: { responseAudio: RESPONSE_PCM, immediateSessionCreated: true },
})
try {
  const { res, buffer } = await postTts(envImmediate.proxy.ttsUrl, { text: TEXT })
  await check('session.created 与 101 合并进 upgrade head 时也能正常合成', () => {
    assert.equal(res.status, 200)
    assert.deepEqual(parseWav(buffer).data, RESPONSE_PCM)
  })
} finally {
  await envImmediate.close()
}

/* 非流式回归：显式传 stream:false 仍然回完整 WAV */

const envPlainAgain = await startEnv({ fakeOptions: { responseAudio: RESPONSE_PCM } })
try {
  const { res, buffer } = await postTts(envPlainAgain.proxy.ttsUrl, { text: TEXT, stream: false })
  await check('stream=false（或不传）→ 仍是完整 WAV（旧行为不变）', () => {
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'audio/wav')
    assert.equal(buffer.length, 44 + PCM_BYTES)
    const parsed = parseWav(buffer)
    assert.deepEqual(parsed.data, RESPONSE_PCM)
  })
} finally {
  await envPlainAgain.close()
}

/* ========================================================================== */
/* 收尾                                                                        */
/* ========================================================================== */

clearTimeout(watchdog)

await check('没有未处理的 Promise rejection', () => {
  assert.deepEqual(unhandledRejections, [])
})

if (failed > 0) {
  console.error(`\n[realtime-tts] FAILED — ${passed} passed, ${failed} failed`)
  console.error('  - ' + failures.join('\n  - '))
  process.exitCode = 1
} else {
  console.log(`\n[realtime-tts] PASSED — ${passed} assertions`)
}
