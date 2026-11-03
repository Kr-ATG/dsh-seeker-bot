/**
 * RFC 6455 帧编解码单测 —— 直接 import 宿主实现
 * `src/host/personal/realtime/ws-frame.ts`（node 24 原生 type-stripping，无需构建）。
 *
 * 覆盖：
 *   - `acceptKey` 与 RFC 6455 §1.3 的示例值；
 *   - `isWebSocketUpgrade` 的头组合（含 `Connection: keep-alive, Upgrade`）；
 *   - `encodeFrame` 三种长度档位（<126 / 126~65535 / >65535）的头部字节；
 *   - mask / unmask 往返、掩码位与 mask key 布局；
 *   - 粘包（一次 decode 多帧）、半帧（留 rest，补齐后解出）、空 buffer；
 *   - close / ping / pong 帧、fin=false 分片标记；
 *   - 超限帧（>16MiB 的 64 位长度）必须抛错而不是分配内存；
 *   - `WsPeer`：分片重组、ping 自动 pong、close 回调、sendText 不掩码；
 *   - `acceptUpgrade`：101 响应头正确、upgrade 的 head 字节不被丢弃。
 *
 * Usage: node scripts/test-realtime-ws.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  OPCODE,
  WsPeer,
  acceptKey,
  acceptUpgrade,
  decodeFrames,
  encodeFrame,
  isWebSocketUpgrade,
} from '../src/host/personal/realtime/ws-frame.ts'

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

/** 极简 socket 替身：只提供 WsPeer 用到的 write / on / destroy / destroyed。 */
class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.written = []
    this.destroyed = false
  }

  write(chunk) {
    this.written.push(Buffer.from(chunk))
    return true
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }

  /** 把字节当成「对端发来的数据」喂给 WsPeer。 */
  deliver(chunk) {
    this.emit('data', Buffer.from(chunk))
  }
}

console.log('\n[1] acceptKey / isWebSocketUpgrade')

await check('RFC 6455 §1.3 示例 key → 示例 accept', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

await check('空 key 仍返回稳定的 SHA1-base64（22 位 + =）', () => {
  const value = acceptKey('')
  assert.equal(value, 'Kfh9QIsMVZcl6xEPYxPHzW8SZ8w=')
})

await check('isWebSocketUpgrade 接受标准头组合', () => {
  assert.equal(isWebSocketUpgrade({ headers: { upgrade: 'websocket', connection: 'Upgrade' } }), true)
  assert.equal(isWebSocketUpgrade({ headers: { upgrade: 'WebSocket', connection: 'upgrade' } }), true)
})

await check('isWebSocketUpgrade 接受 Connection 列表形式', () => {
  assert.equal(isWebSocketUpgrade({ headers: { upgrade: 'websocket', connection: 'keep-alive, Upgrade' } }), true)
  assert.equal(isWebSocketUpgrade({ headers: { upgrade: 'websocket', connection: 'keep-alive,upgrade' } }), true)
})

await check('isWebSocketUpgrade 拒绝非升级 / 缺头 / null', () => {
  assert.equal(isWebSocketUpgrade({ headers: { upgrade: 'h2c', connection: 'Upgrade' } }), false)
  assert.equal(isWebSocketUpgrade({ headers: { upgrade: 'websocket', connection: 'keep-alive' } }), false)
  assert.equal(isWebSocketUpgrade({ headers: {} }), false)
  assert.equal(isWebSocketUpgrade(null), false)
  assert.equal(isWebSocketUpgrade(undefined), false)
})

console.log('\n[2] encodeFrame 长度档位与头部字节')

await check('短帧（<126）：2 字节头 + 载荷，FIN=1', () => {
  const frame = encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('hi') })
  assert.equal(frame.length, 4)
  assert.equal(frame[0], 0x81) // FIN | text
  assert.equal(frame[1], 0x02)
  assert.equal(frame.subarray(2).toString('utf8'), 'hi')
})

await check('16 位长度档（126..65535）：second 字节 = 126 + 大端长度', () => {
  const payload = Buffer.alloc(300, 0x41)
  const frame = encodeFrame({ opcode: OPCODE.binary, payload })
  assert.equal(frame[0], 0x82)
  assert.equal(frame[1], 126)
  assert.equal(frame.readUInt16BE(2), 300)
  assert.equal(frame.length, 4 + 300)
  assert.deepEqual(frame.subarray(4), payload)
})

await check('64 位长度档（>65535）：second 字节 = 127 + 大端 8 字节长度', () => {
  const payload = Buffer.alloc(65536, 0x42)
  const frame = encodeFrame({ opcode: OPCODE.binary, payload })
  assert.equal(frame[0], 0x82)
  assert.equal(frame[1], 127)
  assert.equal(frame.readBigUInt64BE(2), 65536n)
  assert.equal(frame.length, 10 + 65536)
  assert.deepEqual(frame.subarray(10), payload)
})

await check('长度边界 125 / 126 / 65535 / 65536 各自走对档位', () => {
  const cases = [
    [125, 2, 125],
    [126, 4, 126],
    [65535, 4, 126],
    [65536, 10, 127],
  ]
  for (const [length, headerBytes, marker] of cases) {
    const frame = encodeFrame({ opcode: OPCODE.binary, payload: Buffer.alloc(length, 0x5a) })
    assert.equal(frame[1], marker, `length=${length} 的 second 字节`)
    assert.equal(frame.length, headerBytes + length, `length=${length} 的总长`)
    if (marker === 126) assert.equal(frame.readUInt16BE(2), length)
    if (marker === 127) assert.equal(frame.readBigUInt64BE(2), BigInt(length))
  }
})

await check('fin=false 时首字节 FIN 位为 0，opcode 保留', () => {
  const frame = encodeFrame({ fin: false, opcode: OPCODE.text, payload: Buffer.from('x') })
  assert.equal(frame[0] & 0x80, 0)
  assert.equal(frame[0] & 0x0f, OPCODE.text)
})

await check('close / ping / pong 的 opcode 编码正确', () => {
  for (const opcode of [OPCODE.close, OPCODE.ping, OPCODE.pong]) {
    const frame = encodeFrame({ opcode, payload: Buffer.alloc(0) })
    assert.equal(frame[0], 0x80 | opcode)
    assert.equal(frame[1], 0)
  }
})

console.log('\n[3] mask / unmask 与 decodeFrames')

await check('mask 帧：掩码位置位、4 字节 mask key 后是异或载荷', () => {
  const payload = Buffer.from('masked-payload')
  const frame = encodeFrame({ opcode: OPCODE.binary, payload, mask: true })
  assert.equal(frame[1] & 0x80, 0x80)
  const maskKey = frame.subarray(2, 6)
  const body = frame.subarray(6)
  const unmasked = Buffer.allocUnsafe(body.length)
  for (let i = 0; i < body.length; i += 1) unmasked[i] = body[i] ^ maskKey[i & 3]
  assert.deepEqual(unmasked, payload)
})

await check('mask → decode 往返字节一致（含 >65535 大载荷）', () => {
  const payload = Buffer.alloc(70000)
  for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff
  const frame = encodeFrame({ opcode: OPCODE.binary, payload, mask: true })
  const decoded = decodeFrames(frame)
  assert.equal(decoded.frames.length, 1)
  assert.equal(decoded.frames[0].opcode, OPCODE.binary)
  assert.equal(decoded.frames[0].fin, true)
  assert.equal(decoded.rest.length, 0)
  assert.deepEqual(decoded.frames[0].payload, payload)
})

await check('未掩码帧 decode 往返（服务端 → 客户端方向）', () => {
  const payload = Buffer.from(JSON.stringify({ type: 'session.created' }))
  const decoded = decodeFrames(encodeFrame({ opcode: OPCODE.text, payload }))
  assert.equal(decoded.frames.length, 1)
  assert.equal(decoded.frames[0].payload.toString('utf8'), payload.toString('utf8'))
})

await check('粘包：三帧拼一次喂入，一次 decode 全解出', () => {
  const chunks = [
    encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('a') }),
    encodeFrame({ opcode: OPCODE.binary, payload: Buffer.alloc(200, 1) }),
    encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('c'.repeat(500)), mask: true }),
  ]
  const decoded = decodeFrames(Buffer.concat(chunks))
  assert.equal(decoded.frames.length, 3)
  assert.deepEqual(decoded.frames.map((f) => f.opcode), [OPCODE.text, OPCODE.binary, OPCODE.text])
  assert.equal(decoded.frames[0].payload.toString(), 'a')
  assert.equal(decoded.frames[1].payload.length, 200)
  assert.equal(decoded.frames[2].payload.toString(), 'c'.repeat(500))
  assert.equal(decoded.rest.length, 0)
})

await check('半帧：只喂前一半 → 0 帧 + rest 完整；补齐后解出', () => {
  const frame = encodeFrame({ opcode: OPCODE.binary, payload: Buffer.alloc(5000, 7) })
  const cut = 1000
  const first = decodeFrames(frame.subarray(0, cut))
  assert.equal(first.frames.length, 0)
  assert.equal(first.rest.length, cut)
  const second = decodeFrames(Buffer.concat([first.rest, frame.subarray(cut)]))
  assert.equal(second.frames.length, 1)
  assert.equal(second.frames[0].payload.length, 5000)
  assert.equal(second.rest.length, 0)
})

await check('头部都不完整（只有 1 字节）→ 0 帧且 rest 保留原字节', () => {
  const decoded = decodeFrames(Buffer.from([0x81]))
  assert.equal(decoded.frames.length, 0)
  assert.equal(decoded.rest.length, 1)
})

await check('空 buffer → 0 帧、rest 为空', () => {
  const decoded = decodeFrames(Buffer.alloc(0))
  assert.equal(decoded.frames.length, 0)
  assert.equal(decoded.rest.length, 0)
})

await check('半帧 + 后续完整帧：先解出完整帧，剩余留在 rest', () => {
  const complete = encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('ok') })
  const partial = encodeFrame({ opcode: OPCODE.binary, payload: Buffer.alloc(1000, 3) })
  const decoded = decodeFrames(Buffer.concat([complete, partial.subarray(0, 500)]))
  assert.equal(decoded.frames.length, 1)
  assert.equal(decoded.frames[0].payload.toString(), 'ok')
  assert.equal(decoded.rest.length, 500)
})

await check('超限帧（64 位长度 > 16MiB）抛错，不尝试分配内存', () => {
  const header = Buffer.alloc(10)
  header[0] = 0x82
  header[1] = 127
  header.writeBigUInt64BE(BigInt(16 * 1024 * 1024 + 1), 2)
  assert.throws(() => decodeFrames(header), /too large/i)
})

console.log('\n[4] WsPeer 连接层')

await check('WsPeer 收到完整文本帧 → onMessage', () => {
  const socket = new FakeSocket()
  const messages = []
  const peer = new WsPeer(socket, { mask: false, handlers: { onMessage: (text) => messages.push(text) } })
  socket.deliver(encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('hello') }))
  assert.deepEqual(messages, ['hello'])
  assert.equal(peer.isOpen, true)
})

await check('WsPeer 分片重组：fin=false text + fin=true continuation', () => {
  const socket = new FakeSocket()
  const messages = []
  new WsPeer(socket, { mask: false, handlers: { onMessage: (text) => messages.push(text) } })
  socket.deliver(encodeFrame({ fin: false, opcode: OPCODE.text, payload: Buffer.from('he') }))
  socket.deliver(encodeFrame({ fin: false, opcode: OPCODE.continuation, payload: Buffer.from('ll') }))
  assert.deepEqual(messages, [])
  socket.deliver(encodeFrame({ fin: true, opcode: OPCODE.continuation, payload: Buffer.from('o') }))
  assert.deepEqual(messages, ['hello'])
})

await check('WsPeer 收到二进制帧 → onBinary 字节一致', () => {
  const socket = new FakeSocket()
  const chunks = []
  new WsPeer(socket, { mask: false, handlers: { onBinary: (payload) => chunks.push(payload) } })
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04])
  socket.deliver(encodeFrame({ opcode: OPCODE.binary, payload: pcm }))
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0], pcm)
})

await check('WsPeer ping → 自动回 pong 且载荷一致', () => {
  const socket = new FakeSocket()
  new WsPeer(socket, { mask: false })
  const payload = Buffer.from('ping-payload')
  socket.deliver(encodeFrame({ opcode: OPCODE.ping, payload }))
  assert.equal(socket.written.length, 1)
  const decoded = decodeFrames(socket.written[0])
  assert.equal(decoded.frames.length, 1)
  assert.equal(decoded.frames[0].opcode, OPCODE.pong)
  assert.deepEqual(decoded.frames[0].payload, payload)
})

await check('WsPeer 收到 close → onClose(code) 并回 close 帧', () => {
  const socket = new FakeSocket()
  const closes = []
  new WsPeer(socket, { mask: false, handlers: { onClose: (code) => closes.push(code) } })
  const payload = Buffer.alloc(2)
  payload.writeUInt16BE(1000, 0)
  socket.deliver(encodeFrame({ opcode: OPCODE.close, payload }))
  assert.deepEqual(closes, [1000])
  const decoded = decodeFrames(socket.written[0])
  assert.equal(decoded.frames[0].opcode, OPCODE.close)
})

await check('WsPeer.sendText 不掩码（服务端方向），sendBinary 同理', () => {
  const socket = new FakeSocket()
  const peer = new WsPeer(socket, { mask: false })
  peer.sendText('{"type":"ready"}')
  peer.sendBinary(Buffer.from([9, 9]))
  assert.equal(socket.written.length, 2)
  assert.equal(socket.written[0][1] & 0x80, 0) // mask 位必须为 0
  const first = decodeFrames(socket.written[0])
  assert.equal(first.frames[0].payload.toString(), '{"type":"ready"}')
  const second = decodeFrames(socket.written[1])
  assert.equal(second.frames[0].opcode, OPCODE.binary)
})

await check('WsPeer 非法 continuation（无起始分片）触发 onError', () => {
  const socket = new FakeSocket()
  const errors = []
  new WsPeer(socket, { mask: false, handlers: { onError: (error) => errors.push(error.message) } })
  socket.deliver(encodeFrame({ opcode: OPCODE.continuation, payload: Buffer.from('x') }))
  assert.equal(errors.length >= 1, true)
  assert.match(errors[0], /continuation/)
})

await check('WsPeer 关闭后 sendText 不再写 socket', () => {
  const socket = new FakeSocket()
  const peer = new WsPeer(socket, { mask: false })
  peer.close(1000, 'bye')
  const writtenAfterClose = socket.written.length
  peer.sendText('late')
  assert.equal(socket.written.length, writtenAfterClose)
  assert.equal(peer.isOpen, false)
})

console.log('\n[5] acceptUpgrade 握手')

await check('acceptUpgrade 写 101 + 正确 Sec-WebSocket-Accept', () => {
  const socket = new FakeSocket()
  const peer = acceptUpgrade(
    { headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } },
    socket,
    Buffer.alloc(0),
    {},
  )
  assert.equal(peer instanceof WsPeer, true)
  const response = socket.written[0].toString('utf8')
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols\r\n/)
  assert.match(response, /Upgrade: websocket\r\n/)
  assert.match(response, /Connection: Upgrade\r\n/)
  assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/)
  assert.match(response, /\r\n\r\n$/)
})

await check('acceptUpgrade 不丢 upgrade head（同一批里已到的帧）', () => {
  const socket = new FakeSocket()
  const messages = []
  acceptUpgrade(
    { headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } },
    socket,
    encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('early-bytes') }),
    { onMessage: (text) => messages.push(text) },
  )
  assert.deepEqual(messages, ['early-bytes'])
})

await check('acceptUpgrade 缺 Sec-WebSocket-Key 时抛错并销毁 socket', () => {
  const socket = new FakeSocket()
  assert.throws(() => acceptUpgrade({ headers: {} }, socket, Buffer.alloc(0), {}), /Sec-WebSocket-Key/)
  assert.equal(socket.destroyed, true)
})

/* -------------------------------------------------------------------------- */
/* 收尾                                                                        */
/* -------------------------------------------------------------------------- */

if (failed > 0) {
  console.error(`\n[realtime-ws] FAILED — ${passed} passed, ${failed} failed`)
  console.error('  - ' + failures.join('\n  - '))
  process.exitCode = 1
} else {
  console.log(`\n[realtime-ws] PASSED — ${passed} assertions`)
}
