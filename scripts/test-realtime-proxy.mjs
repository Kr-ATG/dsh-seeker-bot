/**
 * 实时语音代理端到端测试 —— 浏览器 ⇄ 宿主（`attachRealtimeRoutes`）⇄ 假 StepFun 上游。
 *
 * 链路：node 全局 WebSocket 客户端 → 裸 `node:http` server（挂真实路由）→
 *       `scripts/lib/fake-stepfun.mjs`（纯 node 假上游，不联网）。
 *
 * 覆盖（对应任务验收标准）：
 *   - 收到 `ready`（model / voice / sampleRate=24000 / maxSessionMs）；
 *   - 上游收到的 `session.update` 带音色、包装过的人设、pcm16、server_vad；
 *   - 二进制上行音频 → 上游 `input_audio_buffer.append`，base64 还原后字节一致；
 *   - 上游 `response.audio.delta` 原样转发为客户端 `audio_delta`；
 *   - `speech_started` / `speech_stopped` / ASR 转写 / 转写增量转发；
 *   - 客户端 text 帧 → 上游 `conversation.item.create` + `response.create`；
 *   - interrupt → 上游 `response.cancel` + 客户端 `interrupted`；
 *   - stop → 双向关闭；
 *   - 上游 401 → 客户端 `error` 且 `retryable=false`；
 *   - `resolveApiKey` 返回 null → 明确 error；
 *   - 模型回退（首个模型 404 → 换下一个）；
 *   - 上游中途断开 → `retryable=true`；
 *   - `session.created` 与 101 合并进 upgrade head 时不丢；
 *   - `/realtime/diagnose` 返回配置且不含 key 明文；
 *   - 跨站 Origin 的 upgrade 被拒绝。
 *
 * 语音里「让 Bot 干活」的闭环（function calling，[O]~[Z]）：
 *   - start 带 agent → `session.update` 注册 `run_task` 工具；
 *   - 注入 `response.function_call_arguments.done` → 宿主调注入的 `runTask`
 *     （task / botId / callId / agent 都对），并推 `task_started` / `task_progress` / `task_done`；
 *   - **任务受理即时播报**（[Z]）：任务交给 runner 的同一刻先回一条
 *     `function_call_output`（含「任务已受理」）让模型立刻开口，再把完成结果以
 *     `conversation.item.create(message/system)` 注入（不再是第二条 function_call_output）；
 *   - 未受理的失败（空参数 / 没 agent / 没 runner）仍以 `function_call_output` 回灌；
 *   - `runTask` 失败时 `task_done.ok=false`，失败原因以 message/system 回灌给模型；
 *   - start 没带 agent 时模型乱调 `run_task`：宿主回一条可读 output，不挂住、不误调；
 *   - 同一 `call_id` 的 `arguments.done` 重复投递（含「任务已跑完再来一条」）只执行一次；
 *   - **另一种上游形状** `conversation.item.created` + `item.type='function_call'` 同样能触发；
 *   - `call_id` 缺失时明确报错（retryable=false）、不误跑任务、不断开会话；
 *   - **竞态**（[V]~[X]，用户实测红条 `ongoing response already exists` 的回归）：
 *     任务完成时上游那轮响应还没结束 → 宿主不发 `response.create`、记 pending，
 *     等 `response.done` 后补发一次；上游直接回该 error 时同样不转发给前端、done 后
 *     补发；补发也被拒时放弃（不死循环）；没有竞态时仍立刻发（正常路径行为不变）。
 *
 * 语音挂断（[Y]）：
 *   - 不带 agent 的会话，`session.update.session.tools` 里也有 `end_call`；
 *   - 注入 `end_call` 调用 → 上游收到对应 `function_call_output`（请模型道别）；
 *   - 假上游回一轮正常道别音频 → 客户端**先收到 response_done、再收到 hangup**；
 *   - 客户端发 `stop` 后正常收线，全程无 error。
 *
 * Usage: node scripts/test-realtime-proxy.mjs
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachRealtimeRoutes, primeRealtimeKeyState } from '../src/host/personal/realtime/index.ts'
import { pickVendor, readUserConfig, userConfigFile, writeUserConfig } from '../src/host/personal/realtime/config-store.ts'
import {
  DEFAULT_RESPONSE_AUDIO,
  createFakeStepfun,
  sleep,
  waitFor,
} from './lib/fake-stepfun.mjs'

const FAKE_API_KEY = 'sk-fake-stepfun-key'
const FAKE_VENDOR_ID = 'fake-vendor'
const FAKE_KEY_REF = 'FAKE_REALTIME_KEY'
const FAKE_MODEL = 'stepaudio-3-realtime-preview'
const FALLBACK_MODEL = 'stepaudio-2.5-realtime'

/**
 * 宿主 `start()` 目前没有 catch `resolveApiKey()` 的 reject（见 [J] 用例），
 * 未处理的 rejection 默认会直接杀掉测试进程。先收集再断言，让测试跑完并留下证据。
 */
const unhandledRejections = []
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason instanceof Error ? reason.message : String(reason))
})

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
    url: `ws://127.0.0.1:${port}/api/personal-agent/realtime`,
    diagnoseUrl: `http://127.0.0.1:${port}/api/personal-agent/realtime/diagnose`,
    detach,
    close() {
      return new Promise((resolve) => {
        detach()
        server.close(() => resolve())
        setTimeout(resolve, 200).unref?.()
      })
    },
  }
}

/** 用 node 全局 WebSocket 连宿主，收集消息。 */
async function openClient(url) {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const client = {
    ws,
    messages: [],
    closed: false,
    closeCode: null,
    errored: false,
    sendJson(value) {
      ws.send(JSON.stringify(value))
    },
    sendBinary(bytes) {
      ws.send(new Uint8Array(bytes))
    },
  }
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      try {
        // at：到达时刻，用于断言「受理回执先于 task_done」这类时序
        client.messages.push({ ...JSON.parse(event.data), at: Date.now() })
      } catch {
        client.messages.push({ type: '__unparsable__', raw: event.data })
      }
      return
    }
    const bytes = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : new Uint8Array(event.data.buffer ?? event.data)
    client.messages.push({ type: '__binary__', bytes: Array.from(bytes) })
  })
  ws.addEventListener('close', (event) => {
    client.closed = true
    client.closeCode = event.code
  })
  ws.addEventListener('error', () => {
    client.errored = true
  })
  await waitFor(() => ws.readyState === WebSocket.OPEN, { label: 'websocket open', timeoutMs: 3000 })
  return client
}

function waitForClientMessage(client, predicate, { timeoutMs = 3000, label = 'client message' } = {}) {
  return waitFor(() => client.messages.find(predicate), { timeoutMs, label })
}

/**
 * 等一条客户端消息，超时返回 null。
 *
 * O~R 组依赖宿主侧的 function calling 实现，可能还没落地。用 null 代替抛错，让
 * `check()` 把「没收到」变成一条失败断言，而不是让脚本在第一个 await 就崩掉——
 * 那样后面的用例一条都跑不到，也就看不出实现到底缺哪几块。
 */
async function waitForClientMessageOrNull(client, predicate, options) {
  try {
    return await waitForClientMessage(client, predicate, options)
  } catch {
    return null
  }
}

/** 同上，针对假上游侧收到的 `function_call_output`。 */
async function waitForOutputOrNull(fake, predicate, options) {
  try {
    return await fake.waitForFunctionCallOutput(predicate, options)
  } catch {
    return null
  }
}

/** 同上，针对假上游侧收到的 `conversation.item.create` message item。 */
async function waitForMessageItemOrNull(fake, predicate, options) {
  try {
    return await fake.waitForMessageItem(predicate, options)
  } catch {
    return null
  }
}

/**
 * 等一个任意条件成立，超时返回 null（不抛错）。
 *
 * 为什么需要它：`waitForClientMessage` 会命中**已经收到过的**旧消息。断言「补发之后
 * 又来了一条 response_done」时不能用它——注入那轮早就发过一条 response_done，等待
 * 会立刻返回旧的那条，补发还没发生就判定通过了。这类场景一律用「计数增加」条件 +
 * 这个 helper。
 */
async function waitForOrNull(predicate, options) {
  try {
    return await waitFor(predicate, options)
  } catch {
    return null
  }
}

/** 手搓一次原始 WebSocket 升级（用于测 Origin 校验 / 卸载函数，全局 WebSocket 不能带自定义头）。 */
function rawUpgrade({ port, origin, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      Host: `127.0.0.1:${port}`,
    }
    if (origin !== undefined) headers.Origin = origin
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/personal-agent/realtime', headers })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      finish({ upgraded: true })
    })
    req.on('response', (res) => finish({ upgraded: false, status: res.statusCode }))
    req.on('error', (error) => finish({ upgraded: false, error: error.message }))
    // 没有 upgrade 监听器时 Node 可能既不回 101 也不报错（socket 被丢弃），必须自带超时兜底
    const timer = setTimeout(() => {
      try {
        req.destroy()
      } catch {
        /* 已销毁 */
      }
      finish({ upgraded: false, timedOut: true })
    }, timeoutMs)
    timer.unref?.()
    req.end()
  })
}

/** 起「假上游 + 宿主代理」一套环境，返回句柄。 */
async function startEnv({ fakeOptions = {}, routeOptions = {}, apiKey = FAKE_API_KEY } = {}) {
  const fake = await createFakeStepfun({ apiKey, ...fakeOptions })
  const proxy = await startProxy({
    resolveApiKey: async () => apiKey,
    /*
     * Live 供应商：宿主现在按 `start.vendor` → 全局默认 → 列表第一条来选，选中之后
     * 上游地址 / 凭据名 / 模型都从那条 vendor 上取（不再有 upstreamUrl / route）。
     */
    resolveVendor: () => ({ id: FAKE_VENDOR_ID, label: '假上游', upstream: fake.url, keyRef: FAKE_KEY_REF }),
    models: () => [FAKE_MODEL, FALLBACK_MODEL],
    voice: () => 'linjiajiejie',
    log: () => {},
    ...routeOptions,
  })
  return { fake, proxy, async close() { await proxy.close(); await fake.close() } }
}

/* ========================================================================== */
/* A. 正常链路                                                                */
/* ========================================================================== */

console.log('\n[A] 正常链路：ready / session.update / 音频上行 / 事件下行')

const env = await startEnv({ fakeOptions: { audioBytesThreshold: 1920 } })
try {
  const client = await openClient(env.proxy.url)

  // ── A1. start → ready ────────────────────────────────────────────────
  client.sendJson({
    type: 'start',
    botId: 'bot-main-xiaomo',
    instructions: '你是小墨，一个耐心、简洁的语音助手。',
  })
  const ready = await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready' })

  await check('start → ready 携带 model / voice / sampleRate=24000 / maxSessionMs', () => {
    assert.equal(ready.type, 'ready')
    assert.equal(ready.model, FAKE_MODEL)
    assert.equal(ready.voice, 'linjiajiejie')
    assert.equal(ready.sampleRate, 24000)
    assert.equal(ready.maxSessionMs, 30 * 60 * 1000)
  })

  // ── A2. 上游收到 session.update ──────────────────────────────────────
  const connection = await env.fake.waitForConnection(() => true, { label: 'upstream connection' })
  await env.fake.waitForMessage((m) => m.type === 'session.update', { label: 'session.update' })

  await check('宿主向上游下发 session.update：voice / pcm16 / server_vad / 人设包装', () => {
    const update = connection.sessionUpdate
    assert.ok(update !== null, 'session.update 未到达上游')
    assert.equal(update.type, 'session.update')
    assert.equal(update.session.voice, 'linjiajiejie')
    assert.equal(update.session.input_audio_format, 'pcm16')
    assert.equal(update.session.output_audio_format, 'pcm16')
    assert.deepEqual(update.session.modalities, ['text', 'audio'])
    assert.equal(update.session.turn_detection.type, 'server_vad')
    assert.equal(update.session.turn_detection.silence_duration_ms, 800)
    // 人设必须被原样塞进 instructions，并压上「语音通话」约束
    assert.match(String(update.session.instructions), /你是小墨/)
    assert.match(String(update.session.instructions), /不要输出 Markdown|语音通话/)
  })

  await check('session.update 默认带内置 web_search 工具（语音会话里模型没有别的联网手段）', () => {
    const update = connection.sessionUpdate
    assert.ok(Array.isArray(update.session.tools), 'session.tools 不是数组')
    const search = update.session.tools.find((tool) => tool?.type === 'web_search')
    assert.ok(search !== undefined, 'session.tools 里没有 web_search')
    assert.equal(typeof search.function?.options?.top_k, 'number')
    // update 必须带 event_id：上游拒绝时要靠它精确识别是哪条被拒（降级重发的前提）
    assert.equal(typeof update.event_id, 'string')
    assert.ok(update.event_id.length > 0, 'session.update 缺 event_id')
  })

  await check('上游收到的 Authorization 是注入的 key（不在 URL 里）', () => {
    assert.equal(connection.model, FAKE_MODEL)
    // fake 的握手校验已经强制 Bearer 匹配；这里补一条「模型走 query」的断言
    assert.equal(env.fake.connections.length, 1)
  })

  // ── A3. 二进制上行音频 → append ──────────────────────────────────────
  const pcm1 = Buffer.alloc(1920)
  for (let i = 0; i < pcm1.length; i += 1) pcm1[i] = (i * 7) & 0xff
  client.sendBinary(pcm1)
  const append = await env.fake.waitForMessage((m) => m.type === 'input_audio_buffer.append', {
    label: 'input_audio_buffer.append',
  })

  await check('二进制上行 → 上游 input_audio_buffer.append，base64 还原字节一致', () => {
    const decoded = Buffer.from(String(append.raw.audio), 'base64')
    assert.equal(decoded.length, pcm1.length)
    assert.deepEqual(decoded, pcm1)
  })

  // ── A4. 攒够音频 → 上游回一轮事件，宿主全部映射 ──────────────────────
  const pcm2 = Buffer.alloc(1920, 0x3c)
  client.sendBinary(pcm2)

  const speechStarted = await waitForClientMessage(client, (m) => m.type === 'speech_started', { label: 'speech_started' })
  const speechStopped = await waitForClientMessage(client, (m) => m.type === 'speech_stopped', { label: 'speech_stopped' })
  const userTranscript = await waitForClientMessage(client, (m) => m.type === 'user_transcript', { label: 'user_transcript' })
  const responseCreated = await waitForClientMessage(client, (m) => m.type === 'response_created', { label: 'response_created' })
  const transcriptDelta = await waitForClientMessage(client, (m) => m.type === 'bot_transcript_delta', { label: 'bot_transcript_delta' })
  const audioDelta = await waitForClientMessage(client, (m) => m.type === 'audio_delta', { label: 'audio_delta' })
  const transcriptDone = await waitForClientMessage(client, (m) => m.type === 'bot_transcript_done', { label: 'bot_transcript_done' })
  const responseDone = await waitForClientMessage(client, (m) => m.type === 'response_done', { label: 'response_done' })

  await check('speech_started / speech_stopped 转发（带 itemId）', () => {
    assert.equal(speechStarted.type, 'speech_started')
    assert.ok(String(speechStarted.itemId ?? '').startsWith('item_fake_'), 'speech_started 缺 itemId')
    assert.equal(speechStopped.type, 'speech_stopped')
  })

  await check('ASR 转写 → user_transcript', () => {
    assert.equal(userTranscript.text, '你好呀，我是假上游。')
  })

  await check('response_created 转发', () => {
    assert.equal(responseCreated.type, 'response_created')
  })

  await check('上游 audio.delta 原样转发为客户端 audio_delta（base64 不变）', () => {
    assert.equal(audioDelta.audio, DEFAULT_RESPONSE_AUDIO.toString('base64'))
  })

  await check('转写增量 / 完整转写 / response_done 状态都映射', () => {
    assert.equal(transcriptDelta.delta, '你好，')
    assert.equal(transcriptDone.transcript, '你好，我在听。')
    assert.equal(responseDone.status, 'completed')
  })

  // 两片音频的 append 可能分两批到上游（第一片触发第一轮、第二片触发第二轮），
  // 等它们都到齐再断言总字节，避免和事件转发抢时序。
  await waitFor(() => connection.audioChunks.length >= 2, { label: 'two upstream audio chunks' })

  await check('上行两片音频都被上游完整收到（1920 + 1920 字节）', () => {
    const total = connection.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    assert.equal(total, 3840)
    assert.deepEqual(connection.audioChunks[1], pcm2)
  })

  // ── A5. text 帧 → conversation.item.create + response.create ─────────
  client.sendJson({ type: 'text', text: '帮我讲个笑话' })
  const itemCreate = await env.fake.waitForMessage((m) => m.type === 'conversation.item.create', {
    label: 'conversation.item.create',
  })
  await env.fake.waitForMessage((m) => m.type === 'response.create', { label: 'response.create' })

  await check('text 帧 → 上游 conversation.item.create（input_text）+ response.create', () => {
    assert.equal(itemCreate.raw.item.role, 'user')
    assert.deepEqual(itemCreate.raw.item.content, [{ type: 'input_text', text: '帮我讲个笑话' }])
  })

  // ── A5b. JSON audio 字段上行（协议允许两种上行方式）─────────────────
  const pcmJson = Buffer.from([0xde, 0xad, 0xbe, 0xef])
  client.sendJson({ type: 'audio', audio: pcmJson.toString('base64') })
  const appendJson = await env.fake.waitForMessage(
    (m) => m.type === 'input_audio_buffer.append'
      && Buffer.from(String(m.raw.audio), 'base64').equals(pcmJson),
    { label: 'append (json audio field)' },
  )

  await check('JSON audio 字段上行 → 上游 append，base64 还原字节一致', () => {
    assert.deepEqual(Buffer.from(String(appendJson.raw.audio), 'base64'), pcmJson)
  })

  // ── A5c. 垃圾帧不崩，后续控制帧仍可用 ───────────────────────────────
  client.ws.send('this-is-not-json')
  client.sendJson({ type: 'unknown-type', foo: 1 })
  client.sendJson({ type: 'text', text: '垃圾帧之后仍然可用' })
  const itemAfterGarbage = await env.fake.waitForMessage(
    (m) => m.type === 'conversation.item.create'
      && m.raw?.item?.content?.[0]?.text === '垃圾帧之后仍然可用',
    { label: 'conversation.item.create after garbage' },
  )

  await check('无效 JSON / 未知 type 不崩溃，后续控制帧仍正常', () => {
    assert.equal(itemAfterGarbage.raw.item.content[0].text, '垃圾帧之后仍然可用')
  })

  // ── A5d. 思考过程 / 文本增量 ────────────────────────────────────────
  connection.sendEvent({ type: 'response.thinking.delta', delta: '让我想想…' })
  connection.sendEvent({ type: 'response.thinking.done', thinking: '想好了。' })
  connection.sendEvent({ type: 'response.text.delta', delta: '文本增量' })
  const thinkingDelta = await waitForClientMessage(client, (m) => m.type === 'thinking_delta', { label: 'thinking_delta' })
  const thinkingDone = await waitForClientMessage(client, (m) => m.type === 'thinking_done', { label: 'thinking_done' })
  const textDelta = await waitForClientMessage(client, (m) => m.type === 'bot_text_delta', { label: 'bot_text_delta' })

  await check('thinking_delta / thinking_done / bot_text_delta 映射', () => {
    assert.equal(thinkingDelta.delta, '让我想想…')
    assert.equal(thinkingDone.thinking, '想好了。')
    assert.equal(textDelta.delta, '文本增量')
  })

  // ── A6. interrupt → response.cancel ─────────────────────────────────
  // 手动让上游进入「响应进行中」状态，否则宿主按设计不会发 cancel。
  const createdBefore = client.messages.filter((m) => m.type === 'response_created').length
  connection.sendEvent({ type: 'response.created', response: { id: 'resp_manual_1', status: 'in_progress' } })
  await waitFor(
    () => client.messages.filter((m) => m.type === 'response_created').length > createdBefore,
    { label: 'manual response_created' },
  )
  client.sendJson({ type: 'interrupt' })
  const cancel = await env.fake.waitForMessage((m) => m.type === 'response.cancel', { label: 'response.cancel' })
  const interrupted = await waitForClientMessage(client, (m) => m.type === 'interrupted', { label: 'interrupted' })

  await check('interrupt → 上游 response.cancel + 客户端 interrupted', () => {
    assert.equal(cancel.type, 'response.cancel')
    assert.equal(interrupted.type, 'interrupted')
  })

  // ── A7. stop → 双向关闭 ──────────────────────────────────────────────
  client.sendJson({ type: 'stop' })
  const closed = await waitForClientMessage(client, (m) => m.type === 'closed', { label: 'closed' })
  await waitFor(() => client.closed, { label: 'client websocket closed' })
  await waitFor(() => connection.closed, { label: 'upstream connection closed' })

  await check('stop → 客户端收到 closed、两端连接都关闭', () => {
    assert.equal(closed.type, 'closed')
    assert.equal(client.closed, true)
    assert.equal(connection.closed, true)
  })
} finally {
  await env.close()
}

/* ========================================================================== */
/* B. 上游 401                                                                */
/* ========================================================================== */

console.log('\n[B] 上游 401：不可重试的错误')

const env401 = await startEnv({ fakeOptions: { handshake: 'unauthorized' } })
try {
  const client = await openClient(env401.proxy.url)
  client.sendJson({ type: 'start', botId: 'bot-1' })
  const error = await waitForClientMessage(client, (m) => m.type === 'error', { label: 'error (401)' })

  await check('上游 401 → 客户端 error 且 retryable=false', () => {
    assert.equal(error.type, 'error')
    assert.equal(error.retryable, false)
    assert.match(String(error.message), /401|鉴权/)
  })
} finally {
  await env401.close()
}

/* ========================================================================== */
/* C. 没有凭据                                                                */
/* ========================================================================== */

console.log('\n[C] resolveApiKey 返回 null：明确报错')

const envNoKey = await startEnv({ routeOptions: { resolveApiKey: async () => null } })
try {
  const client = await openClient(envNoKey.proxy.url)
  client.sendJson({ type: 'start', botId: 'bot-1' })
  const error = await waitForClientMessage(client, (m) => m.type === 'error', { label: 'error (no key)' })

  await check('无凭据 → error 提到 STEPPLAN_API_KEY / 凭据，retryable=false', () => {
    assert.equal(error.retryable, false)
    assert.match(String(error.message), /STEPPLAN_API_KEY|凭据/)
    assert.equal(envNoKey.fake.connections.length, 0, '没 key 时不应该去连上游')
  })

  const diagNoKey = await fetch(envNoKey.proxy.diagnoseUrl)
  const diagNoKeyJson = await diagNoKey.json()
  await check('无 key 时 diagnose configured=false', () => {
    assert.equal(diagNoKey.status, 200)
    assert.equal(diagNoKeyJson.configured, false)
  })
} finally {
  await envNoKey.close()
}

/* ========================================================================== */
/* D. 模型回退                                                                */
/* ========================================================================== */

console.log('\n[D] 模型回退：首个模型 404 → 换下一个')

const envFallback = await startEnv({ fakeOptions: { failModels: [FAKE_MODEL] } })
try {
  const client = await openClient(envFallback.proxy.url)
  client.sendJson({ type: 'start', botId: 'bot-1' })
  const ready = await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (fallback)' })

  await check('首个模型 404 后自动回退到下一个模型并 ready', () => {
    assert.equal(ready.model, FALLBACK_MODEL)
    assert.equal(envFallback.fake.connections.length, 1)
    assert.equal(envFallback.fake.connections[0].model, FALLBACK_MODEL)
  })
} finally {
  await envFallback.close()
}

/* ========================================================================== */
/* E. 上游中途断开                                                            */
/* ========================================================================== */

console.log('\n[E] 上游中途断开：retryable=true')

const envDrop = await startEnv({ fakeOptions: { disconnectAfterMs: 120 } })
try {
  const client = await openClient(envDrop.proxy.url)
  client.sendJson({ type: 'start', botId: 'bot-1' })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (drop)' })
  const error = await waitForClientMessage(client, (m) => m.type === 'error', { label: 'error (drop)' })

  await check('上游中途断开 → error retryable=true（前端可重连）', () => {
    assert.equal(error.retryable, true)
    assert.match(String(error.message), /断开/)
  })
} finally {
  await envDrop.close()
}

/* ========================================================================== */
/* F. session.created 落在 upgrade head 里                                     */
/* ========================================================================== */

console.log('\n[F] session.created 与 101 合并进 head：宿主不能丢')

const envHead = await startEnv({ fakeOptions: { immediateSessionCreated: true } })
try {
  const client = await openClient(envHead.proxy.url)
  client.sendJson({ type: 'start', botId: 'bot-1' })
  const ready = await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (head)' })

  await check('session.created 落在 upgrade head 时仍能就绪', () => {
    assert.equal(ready.type, 'ready')
    assert.equal(ready.model, FAKE_MODEL)
  })
} finally {
  await envHead.close()
}

/* ========================================================================== */
/* G. diagnose 路由                                                           */
/* ========================================================================== */

console.log('\n[G] /realtime/diagnose')

const envDiag = await startEnv()
try {
  /*
   * 诊断路由现在是**同步读缓存**（避免与裸 server 上已存在的 404 handler 抢响应），
   * 缓存值三态：true=有凭据 / false=没配 / null=还没探测过。先 prime 一次再断言。
   */
  primeRealtimeKeyState({ resolveApiKey: async () => FAKE_API_KEY })
  await sleep(60)

  const response = await fetch(envDiag.proxy.diagnoseUrl)
  const payload = await response.json()

  await check('diagnose 返回 200 + configured=true + sampleRate=24000', () => {
    assert.equal(response.status, 200)
    assert.equal(payload.ok, true)
    assert.ok(
      payload.configured === true || payload.configured === false || payload.configured === null,
      `configured 只能是 true/false/null，实际 ${JSON.stringify(payload.configured)}`,
    )
    assert.equal(payload.configured, true, 'primeRealtimeKeyState 之后 configured 应为 true')
    assert.equal(payload.sampleRate, 24000)
    assert.deepEqual(payload.models, [FAKE_MODEL, FALLBACK_MODEL])
    assert.equal(payload.voice, 'linjiajiejie')
  })

  await check('diagnose 不泄漏 API Key 明文', () => {
    const text = JSON.stringify(payload)
    assert.equal(text.includes(FAKE_API_KEY), false)
    assert.equal(text.includes('Bearer'), false)
  })

  const methodNotAllowed = await fetch(envDiag.proxy.diagnoseUrl, { method: 'POST' })
  await check('diagnose 非 GET → 405', () => {
    assert.equal(methodNotAllowed.status, 405)
  })
} finally {
  await envDiag.close()
}

/* ========================================================================== */
/* H. 跨站 Origin 的 upgrade 被拒绝                                            */
/* ========================================================================== */

console.log('\n[H] 跨站 Origin 拒绝')

const envCross = await startEnv()
try {
  const crossSite = await rawUpgrade({ port: envCross.proxy.port, origin: 'http://evil.example' })
  await check('跨站 Origin 的 WebSocket 升级被拒绝（无 101）', () => {
    assert.equal(crossSite.upgraded, false)
  })

  const sameOrigin = await rawUpgrade({ port: envCross.proxy.port, origin: `http://127.0.0.1:${envCross.proxy.port}` })
  await check('同源 Origin 的升级放行（101）', () => {
    assert.equal(sameOrigin.upgraded, true)
  })

  // 卸载函数必须真的摘掉监听器（DSH 侧热重载依赖它）
  envCross.proxy.detach()
  const afterDetach = await rawUpgrade({ port: envCross.proxy.port, origin: `http://127.0.0.1:${envCross.proxy.port}` })
  await check('detach() 卸载后 upgrade 被拒（无 101）', () => {
    assert.equal(afterDetach.upgraded, false)
  })
} finally {
  await envCross.close()
}

/* ========================================================================== */
/* I. 浏览器直接断开                                                          */
/* ========================================================================== */

console.log('\n[I] 浏览器直接断开 → 关掉上游')

const envClientDrop = await startEnv()
try {
  const client = await openClient(envClientDrop.proxy.url)
  client.sendJson({ type: 'start', botId: 'bot-1' })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (client drop)' })
  const connection = await envClientDrop.fake.waitForConnection(() => true, { label: 'upstream (client drop)' })
  client.ws.close()
  await waitFor(() => connection.closed, { label: 'upstream closed after client close' })

  await check('浏览器直接断开（不发 stop）→ 宿主关掉上游连接', () => {
    assert.equal(connection.closed, true)
  })
} finally {
  await envClientDrop.close()
}

/* ========================================================================== */
/* J. resolveApiKey 抛错                                                      */
/* ========================================================================== */

console.log('\n[J] resolveApiKey 抛错：客户端必须收到明确 error')

const envThrow = await startEnv({
  routeOptions: {
    resolveApiKey: async () => {
      throw new Error('credentials service down')
    },
  },
})
try {
  const client = await openClient(envThrow.proxy.url)
  client.sendJson({ type: 'start', botId: 'bot-1' })
  let error = null
  try {
    error = await waitForClientMessage(client, (m) => m.type === 'error', {
      label: 'error (resolveApiKey throws)',
      timeoutMs: 2000,
    })
  } catch {
    error = null
  }

  await sleep(30) // unhandledRejection 在 reject 后的下一个 tick 才触发
  await check('resolveApiKey 抛错 → 客户端收到 error、retryable=false、无 unhandledRejection', () => {
    assert.ok(error !== null, `客户端没收到任何 error（unhandledRejection: ${JSON.stringify(unhandledRejections)}）`)
    assert.match(String(error.message), /凭据|credentials|失败/i)
    assert.equal(error.retryable, false)
    assert.deepEqual(unhandledRejections, [], '修复后不应再有 unhandledRejection')
  })
} finally {
  await envThrow.close()
}

/* ========================================================================== */
/* K. 并发两次 start                                                          */
/* ========================================================================== */

console.log('\n[K] 并发两次 start：不能建两条上游连接')

const envDoubleStart = await startEnv({
  routeOptions: {
    resolveApiKey: async () => {
      await sleep(120)
      return FAKE_API_KEY
    },
  },
})
try {
  const client = await openClient(envDoubleStart.proxy.url)
  client.sendJson({ type: 'start', botId: 'bot-1' })
  client.sendJson({ type: 'start', botId: 'bot-1' })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (double start)' })
  await sleep(250)

  await check('并发两次 start 只建一条上游连接（第二条被去重）', () => {
    assert.equal(envDoubleStart.fake.connections.length, 1, `实际建了 ${envDoubleStart.fake.connections.length} 条上游连接`)
  })
} finally {
  await envDoubleStart.close()
}

/* ========================================================================== */
/* L. 上游拒绝 tools：降级重发不带 tools 的 session.update                      */
/* ========================================================================== */

console.log('\n[L] 上游拒绝 tools → 降级重发（通话保住，只丢联网搜索）')

const envRejectTools = await startEnv({ fakeOptions: { rejectTools: true } })
try {
  const client = await openClient(envRejectTools.proxy.url)
  client.sendJson({ type: 'start', botId: 'bot-1', instructions: '你是小墨。' })

  // 第一条 update 带 tools（被拒），第二条应当不带 tools
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (rejectTools)' })
  await sleep(120)

  await check('tools 被拒后自动降级重发：第二条 session.update 不带 tools，会话仍就绪', () => {
    const updates = envRejectTools.fake.allReceived.filter((m) => m.type === 'session.update')
    assert.ok(updates.length >= 2, `只收到 ${updates.length} 条 session.update，降级重发没发生`)
    const first = updates[0].raw.session
    const last = updates[updates.length - 1].raw.session
    assert.ok(Array.isArray(first.tools) && first.tools.length > 0, '第一条 update 应当带 tools')
    assert.equal(last.tools, undefined, '降级重发后不应再带 tools')
    // 关键：降级不等于放弃——VAD 与音色必须还在，否则整通电话都废了
    assert.equal(last.turn_detection?.type, 'server_vad')
    assert.equal(last.voice, 'linjiajiejie')
    assert.equal(last.input_audio_format, 'pcm16')
  })

  await check('tools 被拒不影响后续音频链路', () => {
    client.sendBinary(Buffer.alloc(1920, 0x11))
    return envRejectTools.fake.waitForMessage((m) => m.type === 'input_audio_buffer.append', {
      label: 'append after tools rejected',
    }).then(() => undefined)
  })
} finally {
  await envRejectTools.close()
}

/* ========================================================================== */
/* M. 设置路由（GET/POST /realtime/config）                                   */
/* ========================================================================== */

console.log('\n[M] 实时语音设置路由（供应商页与 Bot 设置都靠它读写）')

/** 内存版 settings：够验证路由的读写与白名单，不需要真 settings 服务。 */
let storedConfig = {}
const configWrites = []
/** 凭据写入记录：只存 ref 与长度，不存值（测试日志里不该出现密钥）。 */
const credentialWrites = []
const envConfig = await startEnv({
  routeOptions: {
    readConfig: () => storedConfig,
    writeConfig: async (patch) => {
      configWrites.push(patch)
      storedConfig = { ...storedConfig, ...patch }
    },
    // 凭据写入：只记录调用，绝不把值写进任何断言输出（避免测试日志里出现密钥）
    writeCredential: async (ref, value) => {
      credentialWrites.push({ ref, valueLength: value.length, ok: true })
    },
    speed: () => 'normal',
  },
})
try {
  const configUrl = `http://127.0.0.1:${envConfig.proxy.port}/api/personal-agent/realtime/config`

  const getRes = await fetch(configUrl)
  const getBody = await getRes.json()
  await check('GET config：返回音色清单 / 模型候选 / 默认值', () => {
    assert.equal(getRes.status, 200)
    assert.equal(getBody.ok, true)
    assert.ok(Array.isArray(getBody.voices) && getBody.voices.length > 0, 'voices 为空')
    assert.ok(getBody.voices.some((v) => v.id === 'linjiajiejie'), '音色清单里没有默认音色')
    assert.ok(Array.isArray(getBody.models) && getBody.models.length > 0, 'models 为空')
    assert.equal(getBody.defaults.voice, 'linjiajiejie')
    assert.equal(getBody.defaults.webSearch, true, '联网搜索默认应为开')
  })

  const postRes = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice: 'qingchunshaonv', speed: 'slow', webSearch: false }),
  })
  const postBody = await postRes.json()
  await check('POST config：音色 / 语速 / 联网被写入并回读', () => {
    assert.equal(postRes.status, 200)
    assert.equal(postBody.ok, true)
    assert.equal(storedConfig.voice, 'qingchunshaonv')
    assert.equal(storedConfig.speed, 'slow')
    assert.equal(storedConfig.webSearch, false)
  })

  await check('POST config：白名单外的字段不会被写进 settings', async () => {
    await fetch(configUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: 'linjiameimei', evil: 'should-not-land', __proto__: { x: 1 } }),
    })
    assert.equal(storedConfig.voice, 'linjiameimei')
    assert.equal(storedConfig.evil, undefined, '未知字段被写进去了')
  })

  await check('POST config：非法 JSON → 400，且不落任何改动', async () => {
    const before = JSON.stringify(storedConfig)
    const res = await fetch(configUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(res.status, 400)
    assert.equal(JSON.stringify(storedConfig), before)
  })

  await check('PUT config → 405', async () => {
    const res = await fetch(configUrl, { method: 'PUT' })
    assert.equal(res.status, 405)
  })

  await check('POST config：空串原样下发（宿主据此清空回默认）', async () => {
    await fetch(configUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: '' }),
    })
    const last = configWrites[configWrites.length - 1]
    assert.ok(last !== undefined, 'writeConfig 没被调用')
    assert.equal(last.voice, '', '空串在路由层被吃掉了（清不掉回默认）')
  })

  await check('GET config 不泄漏任何密钥值', () => {
    assert.equal(JSON.stringify(getBody).includes(FAKE_API_KEY), false)
  })

  /*
   * 凭据写入：用户要能直接填 API Key，而不是先想办法塞进凭据库。
   * 关键不是「能写」，而是「只写不读」——响应里绝不能回显密钥。
   */
  const keyUrl = `http://127.0.0.1:${envConfig.proxy.port}/api/personal-agent/realtime/key`

  await check('POST key：写入凭据且响应只回引用名、不回显密钥', async () => {
    const res = await fetch(keyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'MY_REALTIME_KEY', value: 'unit-test-api-key-value' }),
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.ref, 'MY_REALTIME_KEY')
    assert.equal(JSON.stringify(body).includes('unit-test-api-key-value'), false, '响应里回显了密钥')
    assert.equal(credentialWrites.length, 1)
    assert.equal(credentialWrites[0].ref, 'MY_REALTIME_KEY')
    assert.equal(credentialWrites[0].valueLength, 'unit-test-api-key-value'.length)
  })

  await check('POST key：非法 ref / 空密钥 / 超长密钥都 400，且不写凭据', async () => {
    const before = credentialWrites.length
    const bad = await Promise.all([
      fetch(keyUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: '../etc/passwd', value: 'x' }) }),
      fetch(keyUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'OK_REF', value: '   ' }) }),
      fetch(keyUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'OK_REF', value: 'x'.repeat(5000) }) }),
    ])
    for (const res of bad) assert.equal(res.status, 400)
    assert.equal(credentialWrites.length, before, '非法请求不该写进凭据')
  })

  await check('GET key → 405（这个端点只写不读）', async () => {
    const res = await fetch(keyUrl)
    assert.equal(res.status, 405)
  })
} finally {
  await envConfig.close()
}

/* ========================================================================== */
/* N. 用户级配置落盘（config-store.ts）                                        */
/* ========================================================================== */

console.log('\n[N] 用户级配置落盘（realtime-config.json）')

/*
 * 用 DSH_HOME 指到临时目录隔离：这个测试会真的写文件，绝不能碰用户真实配置。
 * 放在最后一段，避免影响前面依赖 DSH_HOME 的用例。
 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-realtime-config-'))
process.env.DSH_HOME = isolatedHome
try {
  await check('全新环境：vendors 自动播种成内置预设（至少一条）', () => {
    const back = readUserConfig()
    assert.ok(Array.isArray(back.vendors) && back.vendors.length >= 1, 'vendors 没播种')
    assert.ok(back.vendors.some((item) => item.id === 'stepfun'), '预设里没有 stepfun')
    // 每条都必须有连得上的三要素
    for (const vendor of back.vendors) {
      assert.ok(vendor.upstream.startsWith('ws'), `upstream 不像 ws 地址：${vendor.upstream}`)
      assert.ok(vendor.keyRef !== '', 'keyRef 为空')
    }
  })

  await check('写入后可读回', () => {
    writeUserConfig({ voice: 'qingchunshaonv', speed: 'slow', webSearch: false })
    const back = readUserConfig()
    assert.equal(back.voice, 'qingchunshaonv')
    assert.equal(back.speed, 'slow')
    assert.equal(back.webSearch, false)
  })

  await check('合并写：不丢其它字段', () => {
    writeUserConfig({ voice: 'linjiameimei' })
    const back = readUserConfig()
    assert.equal(back.voice, 'linjiameimei')
    assert.equal(back.speed, 'slow', '合并写把 speed 丢了')
  })

  await check('空串照存（读取侧当「没配」= 回默认）', () => {
    writeUserConfig({ voice: '' })
    assert.equal(readUserConfig().voice, '', '空串被过滤了，界面上就清不掉')
  })

  await check('undefined 字段不落盘（= 不修改）', () => {
    const before = readUserConfig()
    writeUserConfig({ voice: undefined })
    assert.deepEqual(readUserConfig(), before)
  })

  await check('坏 JSON 当「没配」，退回内置预设（不抛错）', () => {
    writeFileSync(userConfigFile(), '{ this is not json')
    const back = readUserConfig()
    assert.ok(Array.isArray(back.vendors) && back.vendors.length >= 1, '坏文件应当退回预设而不是崩掉')
  })

  /*
   * vendors 列表：用户自己维护的那份，增删改都是整体覆盖。
   */
  await check('vendors 整体覆盖：新增 / 改名 / 删除都生效', () => {
    writeUserConfig({
      vendors: [
        { id: 'a', label: 'A 家', upstream: 'wss://a.example/realtime', keyRef: 'A_KEY', model: 'a-1' },
        { id: 'b', label: 'B 家', upstream: 'wss://b.example/realtime', keyRef: 'B_KEY' },
      ],
      defaultVendor: 'b',
    })
    const back = readUserConfig()
    assert.equal(back.vendors.length, 2)
    assert.equal(back.defaultVendor, 'b')
    assert.equal(back.vendors[1].id, 'b')
    assert.equal(back.vendors[0].model, 'a-1')

    // 删掉 a，只剩 b
    writeUserConfig({ vendors: [{ id: 'b', label: 'B 家', upstream: 'wss://b.example/realtime', keyRef: 'B_KEY' }] })
    const afterDelete = readUserConfig()
    assert.equal(afterDelete.vendors.length, 1)
    assert.equal(afterDelete.vendors[0].id, 'b')
  })

  await check('vendors 写空数组 → 真的空（不能偷偷塞回预设）', () => {
    writeUserConfig({ vendors: [] })
    assert.equal(readUserConfig().vendors.length, 0, '删光了又被塞回预设，用户会以为删不掉')
  })

  /*
   * 用户实测：列表里出现两条「StepFun 阶跃星辰」——一条是预设 stepfun，一条是旧版按
   * 聊天供应商 route 迁移出来的 stepplan，两者上游地址一模一样。同一端点只能留一条。
   */
  await check('同一上游地址只保留一条（两条 StepFun 的回归）', () => {
    writeUserConfig({
      vendors: [
        { id: 'stepfun', label: 'StepFun 阶跃星辰', upstream: 'wss://api.stepfun.com/v1/realtime', keyRef: 'A_KEY' },
        { id: 'stepplan', label: 'StepFun 阶跃星辰', upstream: 'wss://api.stepfun.com/v1/realtime/', keyRef: 'B_KEY' },
      ],
    })
    const back = readUserConfig()
    assert.equal(back.vendors.length, 1, '同一端点出现了两条，列表里会显示两个同名供应商')
  })
  await check('pickVendor：按 id → defaultVendor → 第一条', () => {
    writeUserConfig({
      vendors: [
        { id: 'x', label: 'X', upstream: 'wss://x.example/realtime', keyRef: 'X_KEY' },
        { id: 'y', label: 'Y', upstream: 'wss://y.example/realtime', keyRef: 'Y_KEY' },
      ],
      defaultVendor: 'y',
    })
    const config = readUserConfig()
    assert.equal(pickVendor(config, 'x')?.id, 'x', '按 id 没命中')
    assert.equal(pickVendor(config, 'nope')?.id, 'y', '找不到时应回落 defaultVendor')
    assert.equal(pickVendor(config, undefined)?.id, 'y', '不传 id 时应用 defaultVendor')
  })

  /*
   * 旧配置迁移：用户升级前可能是单份 `vendor/model/keyRef/upstream`，
   * 也可能是按聊天供应商分存的 `routes.*`。两种都要能读出来，不能让用户重新配一遍。
   */
  await check('旧格式迁移：单份 vendor 覆盖预设里同 id 的那条，其余预设保留', () => {
    writeFileSync(userConfigFile(), JSON.stringify({
      vendor: 'qwen',
      model: 'qwen3.8-omni-flash-realtime',
      keyRef: 'QWEN_API_KEY',
      voice: 'longanqian_v3.1',
    }))
    const back = readUserConfig()
    // 迁移出来的记录覆盖预设里的 qwen，其它预设（stepfun）保留下来
    assert.ok(back.vendors.length >= 2, '迁移后应保留其它预设，实际 ' + String(back.vendors.length) + ' 条')
    const qwen = back.vendors.find((item) => item.id === 'qwen')
    assert.ok(qwen !== undefined, '迁移出来的 qwen 不见了')
    assert.equal(qwen.keyRef, 'QWEN_API_KEY')
    assert.equal(qwen.model, 'qwen3.8-omni-flash-realtime')
    assert.equal(back.voice, 'longanqian_v3.1')
  })

  await check('旧格式迁移：routes.<provider> → 一条 vendor 记录', () => {
    writeFileSync(userConfigFile(), JSON.stringify({
      routes: {
        stepplan: { vendor: 'stepfun', model: 'stepaudio-2.5-realtime', keyRef: 'STEPPLAN_API_KEY' },
      },
    }))
    const back = readUserConfig()
    // 旧 route 名（stepplan）会映射成预设 id（stepfun），避免同一端点出现两条
    const migrated = back.vendors.find((item) => item.id === 'stepfun')
    assert.ok(migrated !== undefined, 'routes 里那条没迁移出来')
    assert.equal(migrated.keyRef, 'STEPPLAN_API_KEY')
    assert.ok(back.vendors.length >= 2, '迁移时应保留其它内置预设')
  })

  await check('写回后旧字段被清掉（不留两份矛盾配置）', () => {
    writeUserConfig({ voice: 'linjiajiejie' })
    const raw = JSON.parse(readFileSync(userConfigFile(), 'utf8'))
    assert.equal(raw.routes, undefined, 'routes 没清掉')
    assert.equal(raw.vendor, undefined, 'vendor 没清掉')
    assert.ok(Array.isArray(raw.vendors), 'vendors 没写进去')
  })
} finally {
  rmSync(isolatedHome, { recursive: true, force: true })
  delete process.env.DSH_HOME
}

/* ========================================================================== */
/* O. 语音里让 Bot 干活：function_call → runTask → function_call_output        */
/* ========================================================================== */

console.log('\n[O] 正常执行：注入 function_call → runTask → 受理 function_call_output + 完成 message/system')

/** 最小可用的 Bot agent 定义（start 帧带上它，宿主才会注册 run_task）。 */
const AGENT_SPEC = {
  botId: 'bot-main-xiaomo',
  name: '小墨',
  role: 'assistant',
  description: '情感陪伴与语音助手',
  instructions: '你是小墨，一个耐心、简洁的语音助手。',
  permission: 'full',
}

const TASK_TEXT = '生成一张海边日落的插画，16:9'
const CALL_ID_OK = 'call_fake_ok_1'
const SUMMARY_OK = '图已生成：海边日落.png'

/**
 * 新用例的等待上限。
 *
 * 宿主实现缺失时要快速失败：每个用例最多等 2s（并发等，不是逐个 2s），否则整脚本
 * 会远远超过 25s。全绿时这些等待都是毫秒级返回，不影响总时长。
 */
const NEW_CASE_TIMEOUT_MS = 2000

const runTaskCalls = []
const envTask = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      name: 'run_task',
      arguments: JSON.stringify({ task: TASK_TEXT }),
      callId: CALL_ID_OK,
    },
  },
  routeOptions: {
    runTask: async (request) => {
      runTaskCalls.push(request)
      // 任务跑起来先报一句进度（协议里的 task_progress），前端据此显示「正在做什么」
      request.onProgress?.('正在生成图片…')
      await sleep(40) // 模拟 agent loop 的耗时：宿主必须等结果回来再回灌
      return { ok: true, summary: SUMMARY_OK }
    },
  },
})
try {
  const client = await openClient(envTask.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (task)' })
  const connection = await envTask.fake.waitForConnection(() => true, { label: 'upstream (task)' })

  await check('start 带 agent → session.update 注册 run_task 工具（function + task 参数）', () => {
    const tools = connection.sessionUpdate?.session?.tools
    assert.ok(Array.isArray(tools), 'session.tools 不是数组')
    const tool = tools.find((entry) => entry?.type === 'function' && entry?.function?.name === 'run_task')
    assert.ok(tool !== undefined, `session.tools 里没有 run_task（实际：${JSON.stringify(tools)}）`)
    assert.equal(tool.function.parameters?.properties?.task?.type, 'string')
    assert.deepEqual(tool.function.parameters?.required, ['task'])
  })

  // 用「攒够上行音频」触发一轮：最贴近真实场景（用户说话 → 模型决定动手）
  client.sendBinary(Buffer.alloc(1920, 0x5a))

  const [taskStarted, taskProgress, taskDone, acceptedOutput, completionMessage] = await Promise.all([
    waitForClientMessageOrNull(client, (m) => m.type === 'task_started', {
      label: 'task_started',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForClientMessageOrNull(client, (m) => m.type === 'task_progress', {
      label: 'task_progress',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
      label: 'task_done',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForOutputOrNull(envTask.fake, (entry) => entry.callId === CALL_ID_OK, {
      label: 'function_call_output (accepted)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForMessageItemOrNull(envTask.fake, (entry) => entry.role === 'system' && entry.text.includes(SUMMARY_OK), {
      label: 'message/system (completion)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
  ])

  await check('宿主调用注入的 runTask：task 文本 / botId / callId / agent 定义都对', () => {
    assert.equal(runTaskCalls.length, 1, `runTask 被调用 ${runTaskCalls.length} 次（期望 1）`)
    const request = runTaskCalls[0]
    assert.equal(request.task, TASK_TEXT)
    assert.equal(request.botId, AGENT_SPEC.botId)
    assert.equal(request.callId, CALL_ID_OK)
    assert.equal(request.agent?.name, '小墨', 'start 帧里的 agent 定义没透传给 runTask')
  })

  await check('客户端收到 task_started（callId + task 文本）', () => {
    assert.ok(taskStarted !== null, '客户端没收到 task_started')
    assert.equal(taskStarted.callId, CALL_ID_OK)
    assert.equal(taskStarted.task, TASK_TEXT)
  })

  await check('runTask 上报的进度 → 客户端 task_progress（callId + note）', () => {
    assert.ok(taskProgress !== null, '客户端没收到 task_progress（runTask 的 onProgress 没接到前端）')
    assert.equal(taskProgress.callId, CALL_ID_OK)
    assert.equal(taskProgress.note, '正在生成图片…')
  })

  await check('任务受理：上游先收到 function_call_output（含「任务已受理」与任务文本）', () => {
    assert.ok(acceptedOutput !== null, '上游没收到 task 的 function_call_output（受理回执）')
    assert.equal(acceptedOutput.raw.type, 'function_call_output')
    assert.equal(acceptedOutput.callId, CALL_ID_OK)
    assert.match(acceptedOutput.output, /任务已受理，正在后台执行：/)
    assert.ok(
      acceptedOutput.output.includes(TASK_TEXT),
      `受理回执里没有任务文本：${acceptedOutput.output}`,
    )
  })

  await check('任务完成：上游收到 message/system（含 summary），不是第二条 function_call_output', () => {
    assert.ok(completionMessage !== null, '上游没收到完成任务的结果（message/system）')
    assert.equal(completionMessage.role, 'system')
    assert.match(completionMessage.text, /【后台任务完成】/)
    assert.ok(
      completionMessage.text.includes(SUMMARY_OK),
      `message/system 里没有 runTask 的 summary：${completionMessage.text}`,
    )
    const outputs = envTask.fake.functionCallOutputs.filter((entry) => entry.callId === CALL_ID_OK)
    assert.equal(
      outputs.length,
      1,
      `上游收到 ${outputs.length} 条同 call_id 的 function_call_output（任务完成后应改用 message/system）`,
    )
  })

  await check('受理回执之后收到 response.create（模型能立刻开口播报）', () => {
    const received = connection.received
    const outputIndex = received.findIndex(
      (entry) => entry.type === 'conversation.item.create' && entry.raw?.item?.type === 'function_call_output',
    )
    assert.ok(outputIndex >= 0, '上游没收到 function_call_output')
    const createIndex = received.findIndex((entry, index) => index > outputIndex && entry.type === 'response.create')
    assert.ok(createIndex > outputIndex, 'function_call_output 之后没有 response.create')
  })

  await check('客户端 task_done：ok=true 且带 summary', () => {
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    assert.equal(taskDone.callId, CALL_ID_OK)
    assert.equal(taskDone.ok, true)
    assert.equal(taskDone.summary, SUMMARY_OK)
  })
} finally {
  await envTask.close()
}

/* ========================================================================== */
/* P. 执行失败                                                                */
/* ========================================================================== */

console.log('\n[P] 执行失败：runTask 返回 ok=false，失败也要回灌给模型')

const CALL_ID_FAIL = 'call_fake_fail_1'
const envFail = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      arguments: JSON.stringify({ task: '跑一个会失败的命令' }),
      callId: CALL_ID_FAIL,
    },
  },
  routeOptions: {
    runTask: async () => {
      await sleep(20)
      return { ok: false, error: '炸了' }
    },
  },
})
try {
  const client = await openClient(envFail.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (fail)' })
  client.sendBinary(Buffer.alloc(1920, 0x3c))

  const [taskDone, acceptedOutput, completionMessage] = await Promise.all([
    waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
      label: 'task_done (fail)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForOutputOrNull(envFail.fake, (entry) => entry.callId === CALL_ID_FAIL, {
      label: 'function_call_output (fail accepted)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForMessageItemOrNull(envFail.fake, (entry) => entry.role === 'system' && /炸了|失败/.test(entry.text), {
      label: 'message/system (fail completion)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
  ])

  await check('runTask 失败 → 客户端 task_done 的 ok=false 且带 error', () => {
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    assert.equal(taskDone.callId, CALL_ID_FAIL)
    assert.equal(taskDone.ok, false)
    assert.match(String(taskDone.error ?? ''), /炸了/)
  })

  await check('任务受理：上游收到 function_call_output（含「任务已受理」）', () => {
    assert.ok(acceptedOutput !== null, '上游没收到受理回执（function_call_output）')
    assert.equal(acceptedOutput.callId, CALL_ID_FAIL)
    assert.match(acceptedOutput.output, /任务已受理/)
  })

  await check('失败结果以 message/system 回灌给模型（带失败原因，让它用语音解释）', () => {
    assert.ok(completionMessage !== null, '上游没收到失败结果（message/system，失败时模型无法用语音解释）')
    assert.equal(completionMessage.role, 'system')
    assert.match(completionMessage.text, /【后台任务失败】/)
    assert.match(completionMessage.text, /炸了/)
  })
} finally {
  await envFail.close()
}

/* ========================================================================== */
/* Q. 没带 agent                                                              */
/* ========================================================================== */

console.log('\n[Q] 没带 agent：模型仍调 run_task 时不能挂住')

const CALL_ID_NO_AGENT = 'call_fake_noagent_1'
const runTaskCallsNoAgent = []
const envNoAgent = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      arguments: JSON.stringify({ task: '帮我生成一张图' }),
      callId: CALL_ID_NO_AGENT,
    },
  },
  routeOptions: {
    runTask: async (request) => {
      runTaskCallsNoAgent.push(request)
      return { ok: true, summary: '不该被调用' }
    },
  },
})
try {
  const client = await openClient(envNoAgent.proxy.url)
  // 故意不带 agent：模型照样可能调 run_task，宿主必须自己兜住
  client.sendJson({ type: 'start', botId: 'bot-without-agent', instructions: '你是小墨。' })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (no agent)' })
  client.sendBinary(Buffer.alloc(1920, 0x77))

  const [outputEntry, responseDone] = await Promise.all([
    waitForOutputOrNull(envNoAgent.fake, (entry) => entry.callId === CALL_ID_NO_AGENT, {
      label: 'function_call_output (no agent)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForClientMessageOrNull(client, (m) => m.type === 'response_done', {
      label: 'response_done (no agent)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
  ])
  await sleep(120) // 给「如果宿主选择报错而不是回灌」留出发送时间
  const clientError = client.messages.find((m) => m.type === 'error') ?? null

  await check('没带 agent 时收到 function_call：仍回 function_call_output（不挂住）', () => {
    assert.ok(
      outputEntry !== null,
      '上游没收到 function_call_output：宿主在没 agent 时挂住了，模型永远等不到工具结果',
    )
    assert.equal(outputEntry.callId, CALL_ID_NO_AGENT)
  })

  await check('该 output 是可读原因（「没有可执行的 Bot」），且没有误调 runTask', () => {
    assert.match(
      String(outputEntry.output),
      /bot|Bot|agent|没有|未|无法|不能/,
      `output 看不出原因：${outputEntry.output}`,
    )
    assert.equal(runTaskCallsNoAgent.length, 0, '没带 agent 却调用了 runTask')
  })

  await check('没带 agent 不崩溃：客户端没有 error，会话继续（收到 response_done）', () => {
    assert.equal(clientError, null, `客户端收到 error：${JSON.stringify(clientError)}`)
    assert.ok(responseDone !== null, '没收到 response_done（回灌后模型没继续响应）')
  })
} finally {
  await envNoAgent.close()
}

/* ========================================================================== */
/* R. 重复 call_id                                                            */
/* ========================================================================== */

console.log('\n[R] 重复 call_id：同一 arguments.done 发两次，runTask 只能调一次')

const CALL_ID_DUP = 'call_fake_dup_1'
const runTaskCallsDup = []
const envDup = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      arguments: JSON.stringify({ task: '重复投递的任务' }),
      callId: CALL_ID_DUP,
      repeat: 2, // 同一个 call_id 的 arguments.done 连发两次
      // 隔开 150ms：第二次重复投递要落在「第一个任务已经跑完」之后。只靠 in-flight
      // 标记去重的实现会在这里暴露（第二次又跑一遍），而这正是重连/乱序的真实形状。
      repeatDelayMs: 150,
    },
  },
  routeOptions: {
    runTask: async () => {
      runTaskCallsDup.push(Date.now())
      await sleep(30)
      return { ok: true, summary: '做完了' }
    },
  },
})
try {
  const client = await openClient(envDup.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (dup)' })
  const connection = await envDup.fake.waitForConnection(() => true, { label: 'upstream (dup)' })
  client.sendBinary(Buffer.alloc(1920, 0x11))

  const [taskDone, acceptedOutput, completionMessage] = await Promise.all([
    waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
      label: 'task_done (dup)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForOutputOrNull(envDup.fake, (entry) => entry.callId === CALL_ID_DUP, {
      label: 'function_call_output (dup)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForMessageItemOrNull(envDup.fake, (entry) => entry.role === 'system' && entry.text.includes('做完了'), {
      label: 'message/system (dup)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
  ])
  await sleep(220) // 第二次重复投递在 150ms 后到；留足余量，不幂等的实现会在这段时间里冒出第二次调用

  await check('假上游确实发出了两条同 call_id 的 arguments.done（输入侧有效）', () => {
    const doneEvents = connection.sent.filter(
      (event) => event.type === 'response.function_call_arguments.done' && event.call_id === CALL_ID_DUP,
    )
    assert.equal(doneEvents.length, 2, `假上游只发了 ${doneEvents.length} 条 arguments.done，幂等断言就是空转`)
  })

  await check('同一 call_id 的 arguments.done 发两次 → runTask 只调用一次（幂等）', () => {
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    assert.equal(
      runTaskCallsDup.length,
      1,
      `runTask 被调用 ${runTaskCallsDup.length} 次（期望 1，说明没按 call_id 去重）`,
    )
  })

  await check('该 call_id 只回灌一条 function_call_output（受理回执，重复投递不重复受理）', () => {
    const outputs = envDup.fake.functionCallOutputs.filter((entry) => entry.callId === CALL_ID_DUP)
    assert.equal(outputs.length, 1, `上游收到 ${outputs.length} 条同 call_id 的 function_call_output`)
    assert.match(String(outputs[0]?.output), /任务已受理/)
  })

  await check('该 call_id 只收到一条完成 message/system（结果不重复注入）', () => {
    assert.ok(completionMessage !== null, '上游没收到完成结果（message/system）')
    const messages = envDup.fake.messageItems.filter(
      (entry) => entry.role === 'system' && entry.text.includes('做完了'),
    )
    assert.equal(messages.length, 1, `上游收到 ${messages.length} 条完成 message/system`)
    assert.ok(acceptedOutput !== null, '上游没收到受理回执')
  })

  await check('客户端只收到一条 task_done（不重复通知）', () => {
    const doneCount = client.messages.filter((m) => m.type === 'task_done' && m.callId === CALL_ID_DUP).length
    assert.equal(doneCount, 1, `客户端收到 ${doneCount} 条 task_done`)
  })
} finally {
  await envDup.close()
}

/* ========================================================================== */
/* S. 另一种上游形状：conversation.item.created + item.type=function_call      */
/* ========================================================================== */

console.log('\n[S] 另一种上游形状：conversation.item.created + item.type=function_call')

/*
 * 真上游可能不发 `response.function_call_arguments.done`，而是把工具调用做成一个
 * conversation item 推过来。宿主只认前一种时，表现是「模型说我来做，然后静默、
 * 零报错」——最难查的那类故障，所以两种形状必须各有一条端到端断言。
 */
const CALL_ID_ITEM_SHAPE = 'call_item_shape'
const ITEM_SHAPE_TASK = '生成一张图'
const runTaskCallsItemShape = []
const envItemShape = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      shape: 'function_call_item',
      arguments: JSON.stringify({ task: ITEM_SHAPE_TASK }),
      callId: CALL_ID_ITEM_SHAPE,
    },
  },
  routeOptions: {
    runTask: async (request) => {
      runTaskCallsItemShape.push(request)
      await sleep(20)
      return { ok: true, summary: '图好了' }
    },
  },
})
try {
  const client = await openClient(envItemShape.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (item shape)' })
  const connection = await envItemShape.fake.waitForConnection(() => true, { label: 'upstream (item shape)' })
  client.sendBinary(Buffer.alloc(1920, 0x22))

  const [taskStarted, taskDone, acceptedOutput, completionMessage] = await Promise.all([
    waitForClientMessageOrNull(client, (m) => m.type === 'task_started', {
      label: 'task_started (item shape)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
      label: 'task_done (item shape)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForOutputOrNull(envItemShape.fake, (entry) => entry.callId === CALL_ID_ITEM_SHAPE, {
      label: 'function_call_output (item shape accepted)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForMessageItemOrNull(envItemShape.fake, (entry) => entry.role === 'system' && entry.text.includes('图好了'), {
      label: 'message/system (item shape completion)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
  ])

  await check('假上游确实发出 conversation.item.created + item.type=function_call（输入侧有效）', () => {
    const created = connection.sent.find(
      (event) => event.type === 'conversation.item.created' && event.item?.type === 'function_call',
    )
    assert.ok(created !== undefined, '假上游没发出 function_call 形状的 item.created')
    assert.equal(created.item.call_id, CALL_ID_ITEM_SHAPE)
    assert.equal(created.item.name, 'run_task')
  })

  await check('item.created 形状也触发 runTask：task 文本 / call_id 都对', () => {
    assert.equal(
      runTaskCallsItemShape.length,
      1,
      `runTask 被调用 ${runTaskCallsItemShape.length} 次（期望 1，说明 item.created 形状被静默丢弃了）`,
    )
    assert.equal(runTaskCallsItemShape[0].task, ITEM_SHAPE_TASK)
    assert.equal(runTaskCallsItemShape[0].callId, CALL_ID_ITEM_SHAPE)
  })

  await check('上游收到受理 function_call_output 且 call_id 一致（item.created 形状照常执行）', () => {
    assert.ok(acceptedOutput !== null, '上游没收到 function_call_output（item.created 形状的结果没回灌给模型）')
    assert.equal(acceptedOutput.callId, CALL_ID_ITEM_SHAPE)
    assert.match(String(acceptedOutput.output), /任务已受理/)
  })

  await check('完成结果以 message/system 回灌（含 summary）', () => {
    assert.ok(completionMessage !== null, '上游没收到完成结果（message/system）')
    assert.equal(completionMessage.role, 'system')
    assert.ok(completionMessage.text.includes('图好了'), `message/system 里没有 summary：${completionMessage.text}`)
  })

  await check('客户端仍收到 task_started + task_done（ok=true）', () => {
    assert.ok(taskStarted !== null, '客户端没收到 task_started')
    assert.equal(taskStarted.callId, CALL_ID_ITEM_SHAPE)
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    assert.equal(taskDone.callId, CALL_ID_ITEM_SHAPE)
    assert.equal(taskDone.ok, true)
  })
} finally {
  await envItemShape.close()
}

/* ========================================================================== */
/* T. call_id 缺失：明确报错，不静默吞掉                                       */
/* ========================================================================== */

console.log('\n[T] call_id 缺失：明确报错、不误跑任务、会话不断')

const runTaskCallsNoCallId = []
const envNoCallId = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      /*
       * 显式传空 call_id。注意只能用 arguments_done 形状：item.created 形状宿主会
       * 用 `item.call_id ?? item.id` 兜底（item.id 总是有），测不到「缺 call_id」这条路径。
       */
      callId: '',
      arguments: JSON.stringify({ task: '没有 call_id 的任务' }),
    },
  },
  routeOptions: {
    runTask: async (request) => {
      runTaskCallsNoCallId.push(request)
      return { ok: true, summary: '不该被调用' }
    },
  },
})
try {
  const client = await openClient(envNoCallId.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (no call_id)' })
  client.sendBinary(Buffer.alloc(1920, 0x44))

  const [clientError, responseDone] = await Promise.all([
    waitForClientMessageOrNull(client, (m) => m.type === 'error', {
      label: 'error (no call_id)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForClientMessageOrNull(client, (m) => m.type === 'response_done', {
      label: 'response_done (no call_id)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
  ])

  await check('call_id 缺失 → 客户端收到 error、retryable=false、提示点明 call_id', () => {
    assert.ok(clientError !== null, '客户端没收到 error（缺 call_id 被静默吞掉了，用户只会觉得「说了没下文」）')
    assert.equal(clientError.retryable, false)
    assert.match(String(clientError.message), /call_id/)
  })

  await check('call_id 缺失不会误跑任务', () => {
    assert.equal(runTaskCallsNoCallId.length, 0, `runTask 被调用了 ${runTaskCallsNoCallId.length} 次`)
  })

  await check('call_id 缺失不断开会话：仍收到 response_done、客户端 ws 未关闭', () => {
    assert.ok(responseDone !== null, '没收到 response_done（会话被这条错误带断了）')
    assert.equal(client.closed, false)
  })
} finally {
  await envNoCallId.close()
}

/* ========================================================================== */
/* U. 真实形状：item.created 不带参数 → delta 分片 → done 的 arguments 为空      */
/* ========================================================================== */

console.log('\n[U] 真实上游形状：item.created 无 arguments + delta 分片 + done 空参数')

/*
 * 这是用户实测踩到的那条（截图里模型连试三次都回「任务描述为空」）：
 * 真实 StepFun 的 `conversation.item.created` 只有 id/type/status/call_id/name，
 * **没有 arguments**；参数由 `...arguments.delta` 逐片生成，而 `...arguments.done`
 * 的 arguments 可能是空的。宿主必须靠 delta 拼出来的那份。
 */
const CALL_ID_STREAMED = 'call_streamed_1'
const runTaskCallsStreamed = []
const envStreamed = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      shape: 'streamed',
      callId: CALL_ID_STREAMED,
      arguments: JSON.stringify({ task: '生成一张海边日落的插画' }),
    },
  },
  routeOptions: {
    runTask: async (request) => {
      runTaskCallsStreamed.push(request)
      return { ok: true, summary: '图片已生成（假上游）' }
    },
  },
})
try {
  const client = await openClient(envStreamed.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (streamed)' })
  client.sendBinary(Buffer.alloc(1920, 0x55))

  const taskStarted = await waitForClientMessageOrNull(client, (m) => m.type === 'task_started', {
    label: 'task_started (streamed)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  const taskDone = await waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
    label: 'task_done (streamed)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })

  await check('delta 拼出的参数能被解析：runTask 收到正确 task（不是空串）', () => {
    assert.equal(runTaskCallsStreamed.length, 1, `runTask 被调用 ${runTaskCallsStreamed.length} 次`)
    assert.equal(runTaskCallsStreamed[0].task, '生成一张海边日落的插画', `task 实际是「${runTaskCallsStreamed[0].task}」`)
    assert.equal(runTaskCallsStreamed[0].callId, CALL_ID_STREAMED)
  })

  await check('item.created 阶段不执行（参数还没到），最终仍成功', () => {
    assert.ok(taskStarted !== null, '客户端没收到 task_started')
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    assert.equal(taskDone.ok, true, `任务失败：${taskDone?.error ?? '(无)'}`)
  })

  // 回灌是「上游收到 → 记录」的异步链路，给一拍再查（task_done 先于记录可见是正常的）
  await sleep(120)
  const accepted = envStreamed.fake.functionCallOutputs.find((entry) => entry.callId === CALL_ID_STREAMED)
  const completion = envStreamed.fake.messageItems.find((entry) => entry.role === 'system')
  await check('结果照常回灌上游：受理 function_call_output + 完成 message/system 含 summary', () => {
    assert.ok(
      accepted !== undefined,
      `上游没收到 call_id=${CALL_ID_STREAMED} 的受理 function_call_output（共 ${envStreamed.fake.functionCallOutputs.length} 条）`,
    )
    assert.match(String(accepted.output), /任务已受理/)
    assert.ok(completion !== undefined, `上游没收到完成 message/system（共 ${envStreamed.fake.messageItems.length} 条）`)
    assert.match(String(completion.text), /图片已生成/)
  })
} finally {
  await envStreamed.close()
}

/* ========================================================================== */
/* V. 竞态：任务完成时上游那一轮响应还在跑                                      */
/* ========================================================================== */

console.log('\n[V] 竞态：任务完成时上游还在响应 → 不报错、response.done 后补发 response.create')

/*
 * 用户实测那条红条的复现：语音里让它生图，任务其实成功了，通话界面却弹
 * `ongoing response already exists`，而且模型不开口汇报。
 *
 * 成因是 finishAgentTask 回灌 `function_call_output` 之后立刻发 `response.create`，
 * 而上游此刻可能正有一轮响应在跑（模型在说话 / 用户刚开口触发 VAD）。上游对这条
 * `response.create` 只回一句 error 就丢掉，**不排队也不补发**。
 *
 * 这里用 `holdDoneMs` 把上游的 `response.done` 压后 250ms，让 runTask（30ms）
 * 先跑完——宿主处理任务结果时 responseActive 仍是 true，正是真实竞态的形状。
 */
const CALL_ID_RACE = 'call_race_1'
const RACE_SUMMARY = '图好了：海边日落.png'
const envRace = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      arguments: JSON.stringify({ task: '生成一张海边日落的插画' }),
      callId: CALL_ID_RACE,
      holdDoneMs: 250,
    },
  },
  routeOptions: {
    runTask: async () => {
      await sleep(30)
      return { ok: true, summary: RACE_SUMMARY }
    },
  },
})
try {
  const client = await openClient(envRace.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (race)' })
  const connection = await envRace.fake.waitForConnection(() => true, { label: 'upstream (race)' })
  client.sendBinary(Buffer.alloc(1920, 0x66))

  const taskDone = await waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
    label: 'task_done (race)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  // 任务完成这一刻，上游那一轮响应还没结束（holdDoneMs 还没到点）
  const sentTypesAtTaskDone = connection.sent.map((event) => event.type)
  const createCountAtTaskDone = connection.responseCreateCount

  // 再等一小段（仍在上游那轮响应期间）：宿主不能在这段时间里发 response.create
  await sleep(80)
  const createCountDuringHold = connection.responseCreateCount

  // holdDoneMs 到点 → 上游发 response.done → 宿主补发 → 假上游走正常响应脚本
  const responseDone = await waitForClientMessageOrNull(client, (m) => m.type === 'response_done', {
    label: 'response_done (race)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  const clientErrors = client.messages.filter((m) => m.type === 'error')

  await check('竞态前提成立：task_done 到达时上游那一轮响应还没 done（输入侧有效）', () => {
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    assert.equal(taskDone.ok, true, `任务本身应该成功，实际 ok=${taskDone.ok}`)
    assert.ok(
      sentTypesAtTaskDone.includes('response.created'),
      '假上游没发过 response.created，竞态前提不成立',
    )
    assert.ok(
      !sentTypesAtTaskDone.includes('response.done'),
      'task_done 到达时上游已经 done 了，holdDoneMs 没生效，这条用例测不到竞态',
    )
  })

  await check('上游响应进行中：宿主不发 response.create（发过去必被拒）', () => {
    assert.equal(
      createCountAtTaskDone,
      0,
      `task_done 那一刻宿主已经发了 ${createCountAtTaskDone} 条 response.create（上游还在响应中）`,
    )
    assert.equal(
      createCountDuringHold,
      0,
      `上游那轮响应期间宿主发了 ${createCountDuringHold} 条 response.create`,
    )
  })

  await check('上游 response.done 之后补发了一次 response.create（模型这才有机会汇报）', () => {
    assert.equal(
      connection.responseCreateCount,
      1,
      `上游共收到 ${connection.responseCreateCount} 条 response.create（期望恰好 1 条补发）`,
    )
    assert.ok(responseDone !== null, '客户端没收到 response_done：补发没让模型开口')
  })

  await check('全程没有把竞态错误转给前端（不弹红条）', () => {
    assert.deepEqual(
      clientErrors.map((m) => m.message),
      [],
      '客户端收到了 error（任务成功却弹红条，正是用户截图里那条）',
    )
  })
} finally {
  await envRace.close()
}

/* ========================================================================== */
/* W. 上游直接回 ongoing response already exists                               */
/* ========================================================================== */

console.log('\n[W] 上游回 ongoing response already exists → 不转发、response.done 后补发一次')

/*
 * 另一种形状：宿主发 `response.create` 时本地还以为没人在说话（responseActive 为
 * false），但上游那边确实有一轮响应在跑，于是直接回 error。这条路径上宿主既没有
 * 「先判断」的机会，只能靠**收到 error 后**记 pending、等 done 补发。
 *
 * 用 `errorOnResponseCreate` 让假上游拒掉第一条、放行第二条（补发那一条）：
 * 若宿主只是把 error 吞掉不补发，客户端就永远收不到 response_done（模型不开口）。
 */
const CALL_ID_ONGOING = 'call_ongoing_1'
const envOngoing = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      arguments: JSON.stringify({ task: '生成一段海边日落的视频' }),
      callId: CALL_ID_ONGOING,
    },
    errorOnResponseCreate: { message: 'ongoing response already exists', times: 1 },
  },
  routeOptions: {
    runTask: async () => {
      await sleep(20)
      return { ok: true, summary: '视频好了：海边日落.mp4' }
    },
  },
})
try {
  const client = await openClient(envOngoing.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (ongoing)' })
  const connection = await envOngoing.fake.waitForConnection(() => true, { label: 'upstream (ongoing)' })
  client.sendBinary(Buffer.alloc(1920, 0x67))

  const taskDone = await waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
    label: 'task_done (ongoing)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  // 等宿主把第一条 response.create 发出去（假上游已经回了 error）
  await waitFor(() => connection.responseCreateCount >= 1, {
    label: 'first response.create (ongoing)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  await sleep(60) // 给宿主处理那条 error 的时间
  const errorsBeforeDone = client.messages.filter((m) => m.type === 'error')
  const createsBeforeDone = connection.responseCreateCount

  // 上游那一轮（假想中）进行中的响应终于结束：宿主应当在这之后补发
  const doneCountBeforeResend = client.messages.filter((m) => m.type === 'response_done').length
  connection.sendEvent({ type: 'response.done', response: { id: 'resp_ongoing_done', status: 'completed' } })

  // 等宿主补发（假上游收到第二条 response.create），再等补发那轮响应跑完
  const resent = await waitForOrNull(() => connection.responseCreateCount >= 2, {
    label: 'resend response.create (ongoing)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  const resentDone = await waitForOrNull(
    () => client.messages.filter((m) => m.type === 'response_done').length > doneCountBeforeResend,
    { label: 'response_done (ongoing 补发那一轮)', timeoutMs: NEW_CASE_TIMEOUT_MS },
  )
  const allClientErrors = client.messages.filter((m) => m.type === 'error')

  await check('ongoing response already exists 不转发给前端', () => {
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    assert.equal(
      errorsBeforeDone.length,
      0,
      `客户端收到了 error：${JSON.stringify(errorsBeforeDone)}`,
    )
  })

  await check('被拒后不忙重试（等 response.done / 完成回灌，而不是立刻再发）', () => {
    /*
     * 受理回执会发一条 response.create（被 errorOnResponseCreate 拒掉）；任务完成后的
     * message/system 回灌还会合法地再发一条——它是「完成汇报」，不是「忙重试」。
     * 真正要钉住的是：被拒之后、完成回灌之前，不能再冒出第三条 response.create。
     */
    const creates = connection.received.filter((entry) => entry.type === 'response.create')
    const completion = envOngoing.fake.messageItems.find((entry) => entry.role === 'system')
    assert.ok(creates.length >= 1, '第一条 response.create 没发出去')
    const retriesBeforeCompletion = creates.filter((entry, index) => (
      index > 0 && (completion === undefined || entry.at < completion.at)
    ))
    assert.equal(
      retriesBeforeCompletion.length,
      0,
      `被拒后到完成回灌之前又发了 ${retriesBeforeCompletion.length} 条 response.create（忙重试）`,
    )
    assert.ok(createsBeforeDone >= 1, 'sleep 之后一条 response.create 都没发出')
  })

  await check('response.done 之后补发了一次 response.create', () => {
    assert.ok(resent !== null, '上游没有在 response.done 之后收到补发的 response.create（模型不会开口）')
    assert.equal(
      connection.responseCreateCount,
      2,
      `上游共收到 ${connection.responseCreateCount} 条 response.create（期望 2：1 次被拒 + 1 次补发）`,
    )
    assert.ok(resentDone !== null, '客户端没收到补发那一轮的 response_done：补发没让模型开口')
  })

  await check('全程客户端零 error（会话没有被竞态带坏）', () => {
    assert.deepEqual(allClientErrors.map((m) => m.message), [])
    assert.equal(client.closed, false, '会话被这条竞态关掉了')
  })
} finally {
  await envOngoing.close()
}

/* ========================================================================== */
/* W2. 补发也被拒：放弃补发，不许死循环                                         */
/* ========================================================================== */

console.log('\n[W2] 补发也被拒 → 放弃补发（不忙重试、不死循环）')

/*
 * 极端情况：上游连着拒两次（用户刚打断、上游又自己起了一轮）。没有上限的实现会
 * 「done → 补发 → 被拒 → 等 done → 再补发」一直转下去，模型永远开不了口，日志里
 * 刷满同一句。宿主的上限是「同一份结果最多补发一次」，这条用例把它钉住。
 */
const CALL_ID_STUCK = 'call_stuck_1'
const envStuck = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      arguments: JSON.stringify({ task: '生成一张图（补发也会被拒）' }),
      callId: CALL_ID_STUCK,
    },
    // 前两次 response.create 都回 ongoing：原始那条 + 补发那条
    errorOnResponseCreate: { message: 'ongoing response already exists', times: 2 },
  },
  routeOptions: {
    runTask: async () => {
      await sleep(20)
      return { ok: true, summary: '图好了' }
    },
  },
})
try {
  const client = await openClient(envStuck.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (stuck)' })
  const connection = await envStuck.fake.waitForConnection(() => true, { label: 'upstream (stuck)' })
  client.sendBinary(Buffer.alloc(1920, 0x69))

  await waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
    label: 'task_done (stuck)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  // 原始那条被拒 → 宿主等 done 补发
  await waitForOrNull(() => connection.responseCreateCount >= 1, {
    label: 'first response.create (stuck)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  await sleep(60)
  connection.sendEvent({ type: 'response.done', response: { id: 'resp_stuck_1', status: 'completed' } })

  // 补发那条也被拒
  await waitForOrNull(() => connection.responseCreateCount >= 2, {
    label: 'resend response.create (stuck)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  await sleep(60)
  const countAfterResend = connection.responseCreateCount
  connection.sendEvent({ type: 'response.done', response: { id: 'resp_stuck_2', status: 'completed' } })

  // 再等一段：宿主不能再发第三条
  await sleep(250)
  const countAfterSecondDone = connection.responseCreateCount
  const clientErrors = client.messages.filter((m) => m.type === 'error')

  await check('补发只做一次（第二次 done 之后不再补发）', () => {
    assert.equal(countAfterResend, 2, `补发后上游共收到 ${countAfterResend} 条 response.create（期望 2）`)
    assert.equal(
      countAfterSecondDone,
      2,
      `第二次 response.done 之后上游又收到了 ${countAfterSecondDone - 2} 条 response.create（补发没有上限，会死循环）`,
    )
  })

  await check('放弃补发也不报错、不断会话', () => {
    assert.deepEqual(
      clientErrors.map((m) => m.message),
      [],
      '放弃补发时把 error 转给了前端',
    )
    assert.equal(client.closed, false, '会话被这条竞态关掉了')
  })
} finally {
  await envStuck.close()
}

/* ========================================================================== */
/* X. 正常路径：没有进行中的响应 → 立刻发 response.create                      */
/* ========================================================================== */

console.log('\n[X] 正常路径：上游没有进行中的响应 → 受理 / 完成各自立即发 response.create')

/*
 * 竞态修复不能把正常路径也拖成「等 done 再发」——那样每轮任务结果都会晚一拍，
 * 而且上游根本不会再有 done 可等。这里把「立刻发、只发一次、不报错」钉住。
 */
const CALL_ID_PLAIN = 'call_plain_1'
const envPlain = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      arguments: JSON.stringify({ task: '生成一张图' }),
      callId: CALL_ID_PLAIN,
    },
  },
  routeOptions: {
    runTask: async () => {
      await sleep(20)
      return { ok: true, summary: '图好了' }
    },
  },
})
try {
  const client = await openClient(envPlain.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (plain)' })
  const connection = await envPlain.fake.waitForConnection(() => true, { label: 'upstream (plain)' })
  client.sendBinary(Buffer.alloc(1920, 0x68))

  const taskDone = await waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
    label: 'task_done (plain)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  // 注入轮 + 受理轮 + 完成轮 = 三条 response_done；等到三条才说明「完成汇报」也真的开口了
  const responseDone = await waitForOrNull(
    () => client.messages.filter((m) => m.type === 'response_done').length >= 3,
    { label: 'response_done (plain 完成轮)', timeoutMs: NEW_CASE_TIMEOUT_MS },
  )
  const clientErrors = client.messages.filter((m) => m.type === 'error')

  await check('受理 function_call_output 之后立刻收到 response.create（不等任务完成）', () => {
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    const received = connection.received
    const outputIndex = received.findIndex(
      (entry) => entry.type === 'conversation.item.create' && entry.raw?.item?.type === 'function_call_output',
    )
    assert.ok(outputIndex >= 0, '上游没收到 function_call_output')
    const createIndex = received.findIndex((entry, index) => index > outputIndex && entry.type === 'response.create')
    assert.ok(createIndex > outputIndex, 'function_call_output 之后没有 response.create（正常路径被改坏了）')
  })

  await check('完成 message/system 之后立刻收到 response.create（汇报不等人）', () => {
    const received = connection.received
    const messageIndex = received.findIndex(
      (entry) => entry.type === 'conversation.item.create' && entry.raw?.item?.type === 'message' && entry.raw?.item?.role === 'system',
    )
    assert.ok(messageIndex >= 0, '上游没收到完成结果（message/system）')
    const createIndex = received.findIndex((entry, index) => index > messageIndex && entry.type === 'response.create')
    assert.ok(createIndex > messageIndex, '完成结果之后没有 response.create（模型不会汇报）')
  })

  await check('受理与完成各触发一次 response.create（共 2 条，没有多余补发）', () => {
    assert.equal(
      connection.responseCreateCount,
      2,
      `上游收到 ${connection.responseCreateCount} 条 response.create（期望 2：受理 1 + 完成 1）`,
    )
    assert.ok(responseDone !== null, '客户端没收到完成轮的 response_done')
  })

  await check('正常路径客户端零 error', () => {
    assert.deepEqual(clientErrors.map((m) => m.message), [])
  })
} finally {
  await envPlain.close()
}

/* ========================================================================== */
/* Y. 语音挂断：end_call → 道别说完 → 先 response_done 再 hangup                */
/* ========================================================================== */

console.log('\n[Y] 语音挂断：end_call → 道别说完 → 客户端先收到 response_done 再收到 hangup')

const CALL_ID_HANGUP = 'call_hangup_1'
const envHangup = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      name: 'end_call',
      arguments: '{}',
      callId: CALL_ID_HANGUP,
    },
  },
})
try {
  const client = await openClient(envHangup.proxy.url)
  // 故意不带 agent：挂断是通话基础能力，不依赖 Bot 定义
  client.sendJson({ type: 'start', botId: 'bot-hangup', instructions: '你是小墨。' })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (hangup)' })
  const connection = await envHangup.fake.waitForConnection(() => true, { label: 'upstream (hangup)' })
  client.sendBinary(Buffer.alloc(1920, 0x7a))

  const [hangupMessage, outputEntry] = await Promise.all([
    waitForClientMessageOrNull(client, (m) => m.type === 'hangup', {
      label: 'hangup',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
    waitForOutputOrNull(envHangup.fake, (entry) => entry.callId === CALL_ID_HANGUP, {
      label: 'function_call_output (hangup)',
      timeoutMs: NEW_CASE_TIMEOUT_MS,
    }),
  ])

  await check('不带 agent 的 session.update 也注册 end_call 工具', () => {
    const tools = connection.sessionUpdate?.session?.tools
    assert.ok(Array.isArray(tools), 'session.tools 不是数组')
    const endCall = tools.find((entry) => entry?.type === 'function' && entry?.function?.name === 'end_call')
    assert.ok(
      endCall !== undefined,
      `session.tools 里没有 end_call（实际：${JSON.stringify(tools?.map((entry) => entry?.function?.name ?? entry?.type))}）`,
    )
    // 契约：end_call 先于 web_search，参数为空对象且 required=[]
    assert.equal(tools[0]?.function?.name, 'end_call', 'end_call 应排在 web_search 前面')
    assert.deepEqual(endCall.function.parameters, { type: 'object', properties: {}, required: [] })
    const runTask = tools.find((entry) => entry?.type === 'function' && entry?.function?.name === 'run_task')
    assert.equal(runTask, undefined, '没带 agent 时不应注册 run_task')
  })

  await check('end_call 调用 → 上游收到对应 function_call_output（请模型道别）', () => {
    assert.ok(outputEntry !== null, '上游没收到 end_call 的 function_call_output（模型没有机会道别）')
    assert.equal(outputEntry.callId, CALL_ID_HANGUP)
    assert.match(String(outputEntry.output), /已收到用户的挂断请求/)
  })

  await check('客户端先收到 response_done、再收到 hangup（尾音不被切）', () => {
    assert.ok(hangupMessage !== null, '客户端没收到 hangup')
    const hangupIndex = client.messages.indexOf(hangupMessage)
    const doneBefore = client.messages.slice(0, hangupIndex).filter((m) => m.type === 'response_done')
    assert.ok(
      doneBefore.length >= 2,
      `hangup 之前的 response_done 只有 ${doneBefore.length} 条（期望注入轮 + 道别轮共 2 条）`,
    )
    // 道别轮必须真的出了音频，否则「先说完再收线」只是空口
    const audioBefore = client.messages.slice(0, hangupIndex).filter((m) => m.type === 'audio_delta')
    assert.ok(audioBefore.length >= 1, `hangup 之前的 audio_delta 只有 ${audioBefore.length} 条（道别轮应有音频）`)
    assert.equal(hangupMessage.reason, '通话已结束')
  })

  // 前端收到 hangup 后会等播放器排空再发 stop；这里直接模拟这一步
  client.sendJson({ type: 'stop' })
  const closed = await waitForClientMessageOrNull(client, (m) => m.type === 'closed', {
    label: 'closed (hangup)',
    timeoutMs: NEW_CASE_TIMEOUT_MS,
  })
  await waitForOrNull(() => client.closed, { label: 'client closed (hangup)', timeoutMs: NEW_CASE_TIMEOUT_MS })
  await waitForOrNull(() => connection.closed, { label: 'upstream closed (hangup)', timeoutMs: NEW_CASE_TIMEOUT_MS })
  await sleep(80)
  const errors = client.messages.filter((m) => m.type === 'error')

  await check('客户端 stop 后正常收线（两端关闭）、全程无 error', () => {
    assert.ok(closed !== null, '客户端没收到 closed')
    assert.equal(client.closed, true, 'stop 之后客户端 WebSocket 没关闭')
    assert.equal(connection.closed, true, 'stop 之后上游连接没关闭')
    assert.deepEqual(errors.map((m) => m.message), [])
  })
} finally {
  await envHangup.close()
}

/* ========================================================================== */
/* Z. 任务受理即时播报：不等任务跑完就先回「任务已受理」                        */
/* ========================================================================== */

console.log('\n[Z] 任务受理即时播报：受理回执先于 task_done，完成后 message/system 带 summary')

const CALL_ID_ACCEPT = 'call_accept_1'
const ACCEPT_TASK = '生成一张海边日落的插画，16:9'
const ACCEPT_SUMMARY = '图已生成：海边日落-受理版.png'
let acceptRunFinishedAt = 0
const envAccept = await startEnv({
  fakeOptions: {
    audioBytesThreshold: 1920,
    injectFunctionCall: {
      name: 'run_task',
      arguments: JSON.stringify({ task: ACCEPT_TASK }),
      callId: CALL_ID_ACCEPT,
    },
  },
  routeOptions: {
    runTask: async () => {
      await sleep(300) // 任务真跑一会儿：受理播报必须等它之前就发出去
      acceptRunFinishedAt = Date.now()
      return { ok: true, summary: ACCEPT_SUMMARY }
    },
  },
})
try {
  const client = await openClient(envAccept.proxy.url)
  client.sendJson({
    type: 'start',
    botId: AGENT_SPEC.botId,
    instructions: AGENT_SPEC.instructions,
    agent: AGENT_SPEC,
  })
  await waitForClientMessage(client, (m) => m.type === 'ready', { label: 'ready (accept)' })
  const connection = await envAccept.fake.waitForConnection(() => true, { label: 'upstream (accept)' })
  client.sendBinary(Buffer.alloc(1920, 0x7b))

  const [taskDone, acceptedOutput, completionMessage] = await Promise.all([
    waitForClientMessageOrNull(client, (m) => m.type === 'task_done', {
      label: 'task_done (accept)',
      timeoutMs: 3000,
    }),
    waitForOutputOrNull(envAccept.fake, (entry) => entry.callId === CALL_ID_ACCEPT, {
      label: 'function_call_output (accept)',
      timeoutMs: 3000,
    }),
    waitForMessageItemOrNull(envAccept.fake, (entry) => entry.role === 'system' && entry.text.includes(ACCEPT_SUMMARY), {
      label: 'message/system (accept)',
      timeoutMs: 3000,
    }),
  ])

  await check('第一条 function_call_output 在任务跑完之前到达，且含「任务已受理」', () => {
    assert.ok(acceptedOutput !== null, '上游没收到受理回执（function_call_output）')
    assert.equal(acceptedOutput.callId, CALL_ID_ACCEPT)
    assert.match(acceptedOutput.output, /任务已受理，正在后台执行：/)
    assert.ok(
      acceptedOutput.output.includes(ACCEPT_TASK),
      `受理回执里没有任务文本：${acceptedOutput.output}`,
    )
    assert.ok(acceptRunFinishedAt > 0, 'runTask 没跑完（测试前提不成立）')
    assert.ok(
      acceptedOutput.at < acceptRunFinishedAt,
      `受理回执在任务跑完之后才到（output@${acceptedOutput.at} >= runFinished@${acceptRunFinishedAt}），「即时播报」不成立`,
    )
  })

  await check('第一条 function_call_output 在 task_done 之前到达', () => {
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    assert.ok(acceptedOutput !== null, '上游没收到受理回执')
    assert.ok(
      acceptedOutput.at < taskDone.at,
      `受理回执晚于 task_done（output@${acceptedOutput.at} >= task_done@${taskDone.at}）`,
    )
  })

  await check('任务完成后上游收到 message/system（role=system，文本含 summary）', () => {
    assert.ok(completionMessage !== null, '上游没收到完成结果（message/system）')
    assert.equal(completionMessage.role, 'system')
    assert.equal(completionMessage.raw?.content?.[0]?.type, 'input_text')
    assert.match(completionMessage.text, /【后台任务完成】/)
    assert.ok(
      completionMessage.text.includes(ACCEPT_SUMMARY),
      `message/system 里没有 summary：${completionMessage.text}`,
    )
    const outputs = envAccept.fake.functionCallOutputs.filter((entry) => entry.callId === CALL_ID_ACCEPT)
    assert.equal(
      outputs.length,
      1,
      `上游收到 ${outputs.length} 条同 call_id 的 function_call_output（完成结果应为 message/system）`,
    )
  })

  await check('task_done.ok=true 且带 summary', () => {
    assert.ok(taskDone !== null, '客户端没收到 task_done')
    assert.equal(taskDone.callId, CALL_ID_ACCEPT)
    assert.equal(taskDone.ok, true)
    assert.equal(taskDone.summary, ACCEPT_SUMMARY)
  })

  await check('受理回执之后上游收到 response.create（模型能立刻开口）', () => {
    const received = connection.received
    const outputIndex = received.findIndex(
      (entry) => entry.type === 'conversation.item.create' && entry.raw?.item?.type === 'function_call_output',
    )
    assert.ok(outputIndex >= 0, '上游没收到受理回执')
    const createIndex = received.findIndex((entry, index) => index > outputIndex && entry.type === 'response.create')
    assert.ok(createIndex > outputIndex, '受理回执之后没有 response.create，模型无法立刻播报')
  })
} finally {
  await envAccept.close()
}

/* ========================================================================== */
/* 收尾                                                                        */
/* ========================================================================== */

await sleep(10)

if (failed > 0) {
  console.error(`\n[realtime-proxy] FAILED — ${passed} passed, ${failed} failed`)
  console.error('  - ' + failures.join('\n  - '))
  process.exitCode = 1
} else {
  console.log(`\n[realtime-proxy] PASSED — ${passed} assertions`)
}
