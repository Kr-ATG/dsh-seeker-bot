/**
 * 假 StepFun Realtime 上游 —— 纯 node（node:http + 自实现 WebSocket 握手与帧），
 * 不依赖 `ws` 包、不联网，供 `test-realtime-proxy.mjs` 在 CI 里跑端到端。
 *
 * ## 为什么帧编解码在这里再实现一份
 *
 * 宿主实现（`src/host/personal/realtime/ws-frame.ts`）自己有一份帧编解码。如果
 * 假上游直接复用它，那么「编码器写错了」和「解码器也错成一样」会互相抵消，端到端
 * 测试全绿但浏览器连不上。所以这里按 RFC 6455 **独立实现**：宿主产出的字节由这份
 * 代码解，假上游产出的字节由宿主解。真正的正确性由 `test-realtime-ws.mjs` 用
 * RFC 示例值钉住，两份实现互为交叉验证。
 *
 * ## 覆盖的注入场景
 *
 * - `handshake: 'unauthorized'` / `'model-not-found'` —— 握手阶段就失败（宿主应把它
 *   转成客户端可见的 error，且 retryable=false）；
 * - `failModels: [...]` —— 指定模型握手 404，用于验证宿主的模型回退；
 * - `disconnectAfterMs` —— 连接建立后中途断线（宿主应把客户端标成可重连）；
 * - `slowResponseMs` —— 响应事件延迟，用于验证宿主不阻塞、不乱序；
 * - `immediateSessionCreated` —— 把 `session.created` 和 101 响应写在同一批字节里
 *   （真实上游常见的 TCP 合并，落在宿主 upgrade 事件的 `head` 参数里）。宿主如果
 *   丢掉 `head`，就收不到 `session.created`，端到端会挂——这是刻意暴露的接缝。
 * - `injectFunctionCall` —— 让「模型决定动手」：一轮响应不再回音频，而是发
 *   `response.created` → 工具调用通知 → `response.done`。通知有两种形状，由
 *   `injectFunctionCall.shape` 选（真上游两种都可能发，宿主两种都得认）：
 *   - `arguments_done`（默认）：`response.function_call_arguments.delta`（可选）→
 *     `response.function_call_arguments.done`（带 `call_id`/`name`/`arguments`）；
 *   - `function_call_item`：`conversation.item.created` 且 `item.type='function_call'`
 *     （带 `item.call_id`/`item.name`/`item.arguments`）。
 *   宿主应当据此调 `runTask`，再向上游回
 *   `conversation.item.create`（`item.type='function_call_output'`）+ `response.create`。
 *   本假上游把收到的 `function_call_output` 记在 `connection.functionCallOutputs`
 *   与 `fake.functionCallOutputs` 里供断言。
 *
 * Usage:
 *   import { createFakeStepfun } from './lib/fake-stepfun.mjs'
 *   const fake = await createFakeStepfun({ apiKey: 'sk-fake' })
 *   // fake.url → ws://127.0.0.1:<port>/v1/realtime
 *   // fake.connections[0].received / .sessionUpdate / .audioBytes / .functionCallOutputs
 *   await fake.close()
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

/** 帧操作码（与 RFC 6455 一致）。 */
export const OPCODE = Object.freeze({
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
})

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 按 RFC 6455 算 `Sec-WebSocket-Accept`。 */
export function acceptKey(clientKey) {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64')
}

/**
 * 编码一帧（服务端方向默认不掩码）。
 * @param {{ fin?: boolean, opcode: number, payload?: Buffer, mask?: boolean, maskKey?: Buffer }} options
 * @returns {Buffer}
 */
export function encodeFrame(options) {
  const { fin = true, opcode, payload = Buffer.alloc(0), mask = false } = options
  const length = payload.length
  const header = Buffer.alloc(2 + 8 + 4)
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  let offset = 2
  if (length < 126) {
    header[1] = length
  } else if (length < 65536) {
    header[1] = 126
    header.writeUInt16BE(length, 2)
    offset = 4
  } else {
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
    offset = 10
  }
  if (!mask) return Buffer.concat([header.subarray(0, offset), payload])

  header[1] |= 0x80
  const maskKey = options.maskKey ?? Buffer.from([0x12, 0x34, 0x56, 0x78])
  maskKey.copy(header, offset)
  offset += 4
  const masked = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ maskKey[i & 3]
  return Buffer.concat([header.subarray(0, offset), masked])
}

/**
 * 从缓冲区解出帧（掩码帧会被解掩码）。
 * @param {Buffer} buffer
 * @returns {{ frames: Array<{ fin: boolean, opcode: number, payload: Buffer }>, rest: Buffer }}
 */
export function decodeFrames(buffer) {
  const frames = []
  let cursor = 0
  while (cursor + 2 <= buffer.length) {
    const first = buffer[cursor]
    const second = buffer[cursor + 1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let headerBytes = 2
    if (length === 126) {
      if (cursor + 4 > buffer.length) break
      length = buffer.readUInt16BE(cursor + 2)
      headerBytes = 4
    } else if (length === 127) {
      if (cursor + 10 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor + 2))
      headerBytes = 10
    }
    const maskBytes = masked ? 4 : 0
    const total = headerBytes + maskBytes + length
    if (cursor + total > buffer.length) break
    let payload = buffer.subarray(cursor + headerBytes + maskBytes, cursor + total)
    if (masked) {
      const maskKey = buffer.subarray(cursor + headerBytes, cursor + headerBytes + 4)
      const plain = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i += 1) plain[i] = payload[i] ^ maskKey[i & 3]
      payload = plain
    } else {
      payload = Buffer.from(payload)
    }
    frames.push({ fin, opcode, payload })
    cursor += total
  }
  return { frames, rest: cursor === 0 ? buffer : buffer.subarray(cursor) }
}

/** 等一个条件成立（轮询 5ms），超时抛错。 */
export function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = () => {
      let value
      try {
        value = predicate()
      } catch {
        value = undefined
      }
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`fake-stepfun: 等待超时 ${timeoutMs}ms（${label}）`))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })
}

/** 等一小段时间。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把字符串切成若干片（模拟流式生成的工具参数增量）。
 * @param {string} text 完整文本。
 * @param {number} count 期望片数（至少 1）。
 * @returns {string[]} 分片；空文本返回空数组。
 */
function splitIntoPieces(text, count) {
  const value = String(text ?? '')
  if (value === '') return []
  const size = Math.max(1, Math.ceil(value.length / Math.max(1, count)))
  const pieces = []
  for (let i = 0; i < value.length; i += size) pieces.push(value.slice(i, i + size))
  return pieces
}

/** 默认上游下行音频（4 字节 PCM16 占位，base64 后是 'ESIzRA=='）。 */
export const DEFAULT_RESPONSE_AUDIO = Buffer.from([0x11, 0x22, 0x33, 0x44])

/**
 * 起一个假 StepFun Realtime 上游。
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] 期望的 Bearer token。
 * @param {readonly string[]} [options.models] 允许的模型（其它模型握手 404）。
 * @param {readonly string[]} [options.failModels] 强制 404 的模型（验证宿主回退）。
 * @param {'ok'|'unauthorized'|'model-not-found'} [options.handshake] 握手结果注入。
 * @param {number} [options.disconnectAfterMs] >0 时连接建立后这么久断线。
 * @param {number} [options.slowResponseMs] 响应事件延迟。
 * @param {number} [options.audioBytesThreshold] 收到这么多上行 PCM 后触发一轮响应。
 * @param {Buffer} [options.responseAudio] 下行音频内容。
 * @param {string} [options.transcript] ASR 转写文本。
 * @param {string} [options.botTranscript] Bot 转写文本。
 * @param {boolean} [options.immediateSessionCreated] 把 session.created 与 101 写在同一批。
 * @param {boolean} [options.rejectTools] 拒绝带 `tools` 的 session.update（回带 event_id 的
 *   error 且不更新会话），用来验证宿主「去掉 tools 降级重发」这条容错路径。
 * @param {object} [options.injectFunctionCall] 注入一次「模型调用工具」的响应（见文件头）。
 * @param {'arguments_done'|'function_call_item'} [options.injectFunctionCall.shape]
 *   用哪种上游形状通知工具调用，默认 `arguments_done`：
 *   - `arguments_done`：`response.function_call_arguments.done`（带 `call_id`/`name`/`arguments`）；
 *   - `function_call_item`：`conversation.item.created` 且 `item.type='function_call'`
 *     （带 `item.call_id`/`item.name`/`item.arguments`）。真上游两种都可能发，宿主两种都得认。
 * @param {string} [options.injectFunctionCall.name] 工具名，默认 `run_task`。
 * @param {string} options.injectFunctionCall.arguments 工具参数 JSON 字符串。
 * @param {string} [options.injectFunctionCall.callId] `call_id`；缺省按轮次自动生成。
 *   **显式传空串 `''` 时保持空**，用来注入「上游没给 call_id」这条错误路径。
 * @param {number} [options.injectFunctionCall.delayMs] 延迟多久发（毫秒，默认 0）。
 * @param {boolean} [options.injectFunctionCall.emitDelta] 是否先发 `arguments.delta`，默认 true
 *   （只对 `arguments_done` 形状有效）。
 * @param {number} [options.injectFunctionCall.repeat] 同一个 `call_id` 的调用通知重复发几次
 *   （验证宿主幂等），默认 1。
 * @param {number} [options.injectFunctionCall.repeatDelayMs] 重复通知之间隔多久
 *   （毫秒，默认 0=同一批发出）。设成大于宿主处理时长的值，才能验证「任务已经跑完之后
 *   再来一条重复投递」也幂等——这比连续两发更接近重连/乱序的真实场景。
 * @param {number} [options.injectFunctionCall.times] 前几轮响应注入（默认 1；
 *   `0` 表示每轮都注入——注意那会让宿主回灌后的 `response.create` 再次被注入，慎用）。
 * @param {(line: string) => void} [options.log] 调试日志。
 * @returns {Promise<object>} fake 句柄。
 */
export async function createFakeStepfun(options = {}) {
  const {
    apiKey = 'sk-fake-stepfun-key',
    models = ['stepaudio-3-realtime-preview', 'stepaudio-2.5-realtime'],
    failModels = [],
    handshake = 'ok',
    disconnectAfterMs = 0,
    slowResponseMs = 0,
    audioBytesThreshold = 3840,
    responseAudio = DEFAULT_RESPONSE_AUDIO,
    transcript = '你好呀，我是假上游。',
    botTranscript = '你好，我在听。',
    immediateSessionCreated = false,
    rejectTools = false,
    injectFunctionCall = undefined,
    log = () => {},
  } = options

  /** @type {Array<object>} */
  const connections = []
  /** 所有连接上收到的消息（跨连接），断言「宿主到底往上游发了什么」用。 */
  const allReceived = []
  /** 所有连接上收到的 `function_call_output`（跨连接，断言「宿主把任务结果回灌了」用）。 */
  const functionCallOutputs = []

  const server = createServer((req, res) => {
    // 上游只提供 WS；普通 HTTP 请求给 404 JSON，便于宿主探测时拿到明确结果。
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'fake-stepfun: only /v1/realtime websocket', code: 'not_found' } }))
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const model = url.searchParams.get('model') ?? ''
    const authorization = String(req.headers.authorization ?? '')

    log(`[fake-stepfun] upgrade ${url.pathname}?model=${model} auth=${authorization.slice(0, 16)}`)

    const reject = (status, payload) => {
      const body = JSON.stringify(payload)
      socket.write(
        `HTTP/1.1 ${status}\r\n`
        + 'content-type: application/json\r\n'
        + `content-length: ${Buffer.byteLength(body)}\r\n`
        + 'connection: close\r\n'
        + '\r\n'
        + body,
      )
      socket.destroy()
      log(`[fake-stepfun] rejected ${status} ${body}`)
    }

    if (handshake === 'unauthorized' || authorization !== `Bearer ${apiKey}`) {
      reject(401, { error: { message: 'invalid api key', type: 'authentication_error', code: 'invalid_api_key' } })
      return
    }
    if (handshake === 'model-not-found' || failModels.includes(model) || !models.includes(model)) {
      reject(404, {
        error: {
          message: `model not found: ${model}`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      })
      return
    }

    const clientKey = String(req.headers['sec-websocket-key'] ?? '')
    const upgradeResponse = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(clientKey)}`,
      '',
      '',
    ].join('\r\n')

    /** @type {object} */
    const connection = {
      id: connections.length + 1,
      model,
      socket,
      closed: false,
      /** 宿主发来的 session.update 内容（最近一次）。 */
      sessionUpdate: null,
      /** 收到的消息记录：{ type, raw, at } / 二进制记 { type: '__binary__', bytes }。 */
      received: [],
      /** 上行音频分片（按收到的 append 顺序）。 */
      audioChunks: [],
      /** 上行音频累计字节。 */
      audioBytes: 0,
      /** 已触发的响应轮数。 */
      turns: 0,
      /** 本连接上发出去的事件（断言「宿主转发了什么」用）。 */
      sent: [],
      /** 本连接上收到的 `function_call_output`（宿主把 agent 结果回灌给模型）。 */
      functionCallOutputs: [],
      sendEvent,
      sendRawText,
      sendBinary,
      destroy: () => {
        try {
          socket.destroy()
        } catch {
          /* 已断 */
        }
      },
      close,
    }
    connections.push(connection)

    let itemSeq = 0
    let responseSeq = 0
    let receiveBuffer = Buffer.alloc(0)
    let turnTimer = null
    let fragmentOpcode = null
    let fragmentChunks = []
    /**
     * 还剩几轮响应要注入 function_call。
     *
     * 默认只注入第一轮（`times: 1`）：宿主处理完工具结果会再发一条 `response.create`，
     * 那一轮必须走正常脚本（回音频），否则会形成「注入 → 宿主回灌 → 再注入」的死循环。
     */
    let injectionsLeft = injectFunctionCall === undefined
      ? 0
      : (injectFunctionCall.times === 0 ? Number.POSITIVE_INFINITY : Math.max(1, Number(injectFunctionCall.times ?? 1) || 1))

    function record(entry) {
      connection.received.push(entry)
      allReceived.push({ connectionId: connection.id, ...entry })
    }

    function sendEvent(event) {
      if (connection.closed) return
      const raw = JSON.stringify(event)
      connection.sent.push(event)
      log(`[fake-stepfun] -> ${event.type}`)
      try {
        socket.write(encodeFrame({ opcode: OPCODE.text, payload: Buffer.from(raw, 'utf8') }))
      } catch {
        /* 对端已断 */
      }
    }

    function sendRawText(text) {
      if (connection.closed) return
      try {
        socket.write(encodeFrame({ opcode: OPCODE.text, payload: Buffer.from(text, 'utf8') }))
      } catch {
        /* 对端已断 */
      }
    }

    function sendBinary(payload) {
      if (connection.closed) return
      try {
        socket.write(encodeFrame({ opcode: OPCODE.binary, payload }))
      } catch {
        /* 对端已断 */
      }
    }

    function close(code = 1000, reason = '') {
      if (connection.closed) return
      connection.closed = true
      const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2, 'utf8')
      try {
        socket.write(encodeFrame({ opcode: OPCODE.close, payload }))
        socket.end()
      } catch {
        /* 已断 */
      }
    }

    function sendResponseSequence(delayMs) {
      const emit = () => {
        if (connection.closed) return
        responseSeq += 1
        itemSeq += 1
        const responseId = `resp_fake_${responseSeq}`
        const itemId = `item_fake_${itemSeq}`
        connection.turns += 1
        sendEvent({ type: 'response.created', response: { id: responseId, status: 'in_progress' } })
        sendEvent({ type: 'response.audio_transcript.delta', response_id: responseId, item_id: itemId, delta: '你好，' })
        sendEvent({ type: 'response.audio_transcript.delta', response_id: responseId, item_id: itemId, delta: '我在听。' })
        sendEvent({ type: 'response.audio_transcript.done', response_id: responseId, item_id: itemId, transcript: botTranscript })
        sendEvent({ type: 'response.audio.delta', response_id: responseId, item_id: itemId, delta: responseAudio.toString('base64') })
        sendEvent({ type: 'response.audio.done', response_id: responseId, item_id: itemId })
        sendEvent({ type: 'response.done', response: { id: responseId, status: 'completed' } })
      }
      if (delayMs > 0) setTimeout(emit, delayMs)
      else emit()
    }

    /**
     * 注入一轮「模型决定调用工具」的响应。
     *
     * 支持两种上游形状（`inject.shape`）：
     * - `arguments_done`（默认）：`response.function_call_arguments.delta`（可选）→
     *   `response.function_call_arguments.done`（带 `call_id` / `name` / `arguments`）；
     * - `function_call_item`：`conversation.item.created` 且 `item.type='function_call'`
     *   （带 `item.call_id` / `item.name` / `item.arguments`）。
     *
     * 两种都用 `response.created` 开头、`response.done` 收尾，跟真实上游一致（宿主据此
     * 维护「响应进行中」状态）。宿主要在这里把 `arguments` 解析出 `task`，交给注入的
     * `runTask`，再回 `conversation.item.create(function_call_output)`。
     */
    function sendFunctionCallSequence(inject, delayMs) {
      const emit = async () => {
        if (connection.closed) return
        responseSeq += 1
        itemSeq += 1
        connection.turns += 1
        const responseId = `resp_fake_${responseSeq}`
        const itemId = `item_fake_${itemSeq}`
        // 显式传空串时保持空：那是「上游没给 call_id」的注入场景，不能被自动生成顶掉。
        const callId = typeof inject.callId === 'string' ? inject.callId : `call_fake_${responseSeq}`
        const name = typeof inject.name === 'string' && inject.name !== '' ? inject.name : 'run_task'
        const args = String(inject.arguments ?? '{}')
        const shape = inject.shape === 'function_call_item'
          ? 'function_call_item'
          : inject.shape === 'streamed'
            ? 'streamed'
            : 'arguments_done'
        const repeat = Math.max(1, Number(inject.repeat ?? 1) || 1)
        const repeatDelayMs = Math.max(0, Number(inject.repeatDelayMs ?? 0) || 0)
        const emitCallNotice = (index) => {
          if (shape === 'function_call_item') {
            sendEvent({
              type: 'conversation.item.created',
              item: {
                id: `item_fc_${itemSeq}`,
                type: 'function_call',
                call_id: callId,
                name,
                arguments: args,
              },
            })
            return
          }
          if (shape === 'streamed') {
            /*
             * 真实 StepFun 的形状（用户实测踩到的那条）：`conversation.item.created`
             * **只有 id/type/status/call_id/name，没有 arguments**；参数是之后靠
             * `...arguments.delta` 逐片生成的，最后 `...arguments.done` 给完整值。
             *
             * 这里刻意把 done 的 arguments 留空，强制宿主用 delta 拼出来的那份——
             * 有些上游确实这样发，只认 done.arguments 的实现会拿到空参数。
             */
            sendEvent({
              type: 'conversation.item.created',
              item: { id: `item_fc_${itemSeq}`, type: 'function_call', status: 'incomplete', call_id: callId, name },
            })
            const pieces = splitIntoPieces(args, 3)
            for (const piece of pieces) {
              sendEvent({
                type: 'response.function_call_arguments.delta',
                response_id: responseId,
                item_id: itemId,
                call_id: callId,
                name,
                delta: piece,
              })
            }
            sendEvent({
              type: 'response.function_call_arguments.done',
              response_id: responseId,
              item_id: itemId,
              call_id: callId,
              name,
              arguments: '',
            })
            return
          }
          sendEvent({
            type: 'response.function_call_arguments.done',
            response_id: responseId,
            item_id: itemId,
            call_id: callId,
            name,
            arguments: args,
          })
        }

        sendEvent({ type: 'response.created', response: { id: responseId, status: 'in_progress' } })
        // delta 只属于 arguments_done 形状（item.created 没有增量事件）
        if (shape === 'arguments_done' && inject.emitDelta !== false) {
          sendEvent({
            type: 'response.function_call_arguments.delta',
            response_id: responseId,
            item_id: itemId,
            call_id: callId,
            name,
            delta: args,
          })
        }
        for (let i = 0; i < repeat; i += 1) {
          if (i > 0 && repeatDelayMs > 0) {
            await sleep(repeatDelayMs)
            if (connection.closed) return
          }
          emitCallNotice(i)
        }
        sendEvent({ type: 'response.done', response: { id: responseId, status: 'completed' } })
      }
      if (delayMs > 0) setTimeout(() => { void emit() }, delayMs)
      else void emit()
    }

    /** 本轮响应该走哪个脚本：还有注入额度就注入 function_call，否则回正常的音频响应。 */
    function runResponseScript(delayMs) {
      if (injectFunctionCall !== undefined && injectionsLeft > 0) {
        injectionsLeft -= 1
        log(`[fake-stepfun] inject function_call (left=${injectionsLeft === Number.POSITIVE_INFINITY ? 'inf' : injectionsLeft})`)
        sendFunctionCallSequence(injectFunctionCall, delayMs)
        return
      }
      sendResponseSequence(delayMs)
    }

    /** 攒够音频后按脚本回一轮：VAD → ASR → 模型响应。 */
    function runAudioTurn() {
      if (connection.closed) return
      itemSeq += 1
      const itemId = `item_fake_${itemSeq}`
      connection.audioBytes = 0
      sendEvent({ type: 'input_audio_buffer.speech_started', item_id: itemId, audio_start_ms: 0 })
      sendEvent({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: 40 })
      sendEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript })
      runResponseScript(0)
    }

    function scheduleAudioTurn() {
      if (turnTimer !== null) return
      turnTimer = setTimeout(() => {
        turnTimer = null
        runAudioTurn()
      }, slowResponseMs)
    }

    function handleText(text) {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        record({ type: '__unparsable__', raw: text, at: Date.now() })
        return
      }
      record({ type: parsed?.type ?? '__unknown__', raw: parsed, at: Date.now() })
      log(`[fake-stepfun] <- ${parsed?.type}`)

      switch (parsed?.type) {
        case 'session.update': {
          /*
           * rejectTools：模拟上游不认识 `tools`（内置 web_search 的形状可能变），
           * 回一个带 event_id 的 error 且**不**更新会话。宿主应当降级重发一条不带
           * tools 的 update——这条注入就是给那个降级路径做回归的。
           */
          if (rejectTools === true && Array.isArray(parsed?.session?.tools) && parsed.session.tools.length > 0) {
            sendEvent({
              type: 'error',
              event_id: parsed?.event_id,
              error: {
                type: 'invalid_request_error',
                code: 'invalid_param',
                message: 'tools: unsupported parameter',
                event_id: parsed?.event_id,
              },
            })
            return
          }
          connection.sessionUpdate = parsed
          sendEvent({ type: 'session.updated', session: { ...(parsed.session ?? {}) } })
          return
        }
        case 'input_audio_buffer.append': {
          const chunk = Buffer.from(String(parsed.audio ?? ''), 'base64')
          connection.audioChunks.push(chunk)
          connection.audioBytes += chunk.length
          if (connection.audioBytes >= audioBytesThreshold) scheduleAudioTurn()
          return
        }
        case 'input_audio_buffer.clear': {
          connection.audioBytes = 0
          if (turnTimer !== null) {
            clearTimeout(turnTimer)
            turnTimer = null
          }
          return
        }
        case 'conversation.item.create': {
          // 文本输入：宿主会先建 item，再发 response.create
          const item = parsed?.item
          if (item !== null && typeof item === 'object' && item.type === 'function_call_output') {
            const entry = {
              callId: String(item.call_id ?? ''),
              output: String(item.output ?? ''),
              raw: item,
              at: Date.now(),
            }
            connection.functionCallOutputs.push(entry)
            functionCallOutputs.push({ connectionId: connection.id, ...entry })
            log(`[fake-stepfun] <- function_call_output call_id=${entry.callId} output=${entry.output.slice(0, 80)}`)
          }
          return
        }
        case 'response.create': {
          runResponseScript(slowResponseMs)
          return
        }
        case 'response.cancel': {
          responseSeq += 1
          sendEvent({ type: 'response.done', response: { id: `resp_fake_${responseSeq}`, status: 'cancelled' } })
          return
        }
        case 'session.close': {
          close(1000, 'session.close')
          return
        }
        default:
          return
      }
    }

    function handleBinary(payload) {
      record({ type: '__binary__', bytes: payload.length, at: Date.now() })
      connection.audioChunks.push(payload)
      connection.audioBytes += payload.length
      if (connection.audioBytes >= audioBytesThreshold) scheduleAudioTurn()
    }

    function handleFrame(frame) {
      switch (frame.opcode) {
        case OPCODE.ping:
          try {
            socket.write(encodeFrame({ opcode: OPCODE.pong, payload: frame.payload }))
          } catch {
            /* 已断 */
          }
          return
        case OPCODE.pong:
          return
        case OPCODE.close:
          connection.closed = true
          try {
            socket.write(encodeFrame({ opcode: OPCODE.close, payload: frame.payload.subarray(0, 2) }))
            socket.end()
          } catch {
            /* 已断 */
          }
          return
        case OPCODE.continuation: {
          if (fragmentOpcode === null) return
          fragmentChunks.push(frame.payload)
          if (frame.fin) {
            const whole = Buffer.concat(fragmentChunks)
            const opcode = fragmentOpcode
            fragmentOpcode = null
            fragmentChunks = []
            if (opcode === OPCODE.text) handleText(whole.toString('utf8'))
            else handleBinary(whole)
          }
          return
        }
        case OPCODE.text:
        case OPCODE.binary: {
          if (!frame.fin) {
            fragmentOpcode = frame.opcode
            fragmentChunks = [frame.payload]
            return
          }
          if (frame.opcode === OPCODE.text) handleText(frame.payload.toString('utf8'))
          else handleBinary(frame.payload)
          return
        }
        default:
          return
      }
    }

    function feed(chunk) {
      receiveBuffer = receiveBuffer.length === 0 ? chunk : Buffer.concat([receiveBuffer, chunk])
      const decoded = decodeFrames(receiveBuffer)
      receiveBuffer = decoded.rest
      for (const frame of decoded.frames) handleFrame(frame)
    }

    // 101 与 session.created 分批写（immediateSessionCreated 时故意合并成一批，
    // 让宿主 upgrade 事件的 head 里就带着 session.created，验证它不丢 head）。
    if (immediateSessionCreated) {
      const sessionCreated = JSON.stringify({
        type: 'session.created',
        session: { id: `sess_fake_${connection.id}`, model, voice: 'linjiajiejie', modalities: ['audio', 'text'] },
      })
      socket.write(Buffer.concat([
        Buffer.from(upgradeResponse, 'utf8'),
        encodeFrame({ opcode: OPCODE.text, payload: Buffer.from(sessionCreated, 'utf8') }),
      ]))
    } else {
      socket.write(upgradeResponse)
      setImmediate(() => {
        sendEvent({
          type: 'session.created',
          session: { id: `sess_fake_${connection.id}`, model, voice: 'linjiajiejie', modalities: ['audio', 'text'] },
        })
      })
    }

    if (head !== undefined && head.length > 0) feed(head)

    socket.on('data', (chunk) => {
      try {
        feed(chunk)
      } catch (error) {
        log(`[fake-stepfun] decode error: ${error instanceof Error ? error.message : String(error)}`)
        socket.destroy()
      }
    })
    socket.on('error', () => {
      connection.closed = true
    })
    socket.on('close', () => {
      connection.closed = true
      if (turnTimer !== null) clearTimeout(turnTimer)
    })

    if (disconnectAfterMs > 0) {
      setTimeout(() => {
        log('[fake-stepfun] injected disconnect')
        connection.closed = true
        socket.destroy()
      }, disconnectAfterMs)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const fake = {
    port,
    url: `ws://127.0.0.1:${port}/v1/realtime`,
    connections,
    allReceived,
    /** 所有连接上收到的 `function_call_output`（宿主回灌给模型的工具结果）。 */
    functionCallOutputs,
    /** 最近一条连接。 */
    get connection() {
      return connections.at(-1)
    },
    /** 等某条连接出现并满足条件。 */
    waitForConnection(predicate = () => true, options2 = {}) {
      return waitFor(() => connections.find(predicate), { label: 'connection', ...options2 })
    },
    /** 等所有连接里出现满足条件的消息。 */
    waitForMessage(predicate, options2 = {}) {
      return waitFor(() => allReceived.find(predicate), { label: 'message', ...options2 })
    },
    /** 等宿主回灌一条满足条件的 `function_call_output`。 */
    waitForFunctionCallOutput(predicate = () => true, options2 = {}) {
      return waitFor(() => functionCallOutputs.find(predicate), { label: 'function_call_output', ...options2 })
    },
    waitFor,
    close() {
      return new Promise((resolve) => {
        for (const connection of connections) connection.destroy()
        server.close(() => resolve())
        // 有些 socket 可能还挂着；给个兜底，别让测试卡住
        setTimeout(resolve, 200).unref?.()
      })
    },
  }
  return fake
}
