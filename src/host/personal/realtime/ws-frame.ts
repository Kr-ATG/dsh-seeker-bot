/**
 * RFC 6455 WebSocket 帧编解码 + 连接抽象（宿主半身专用）。
 *
 * ## 为什么自己写，而不是用 `ws` 包
 *
 * 宿主 bundle 是 `external: []`（见 build.mjs），任何依赖都会被打进 lib/index.js。
 * `ws` 带着两个可选原生加速件（bufferutil / utf-8-validate），装进别人的 profile
 * 后解析不到就会在 require 期炸；而我们要的能力其实很窄——浏览器↔宿主这一段是
 * 同源单连接、纯 JSON 文本 + 裸 PCM16 二进制、无扩展协商、无压缩。自己实现
 * 约 200 行，换来「零依赖、可单测、行为完全可控」，和 src/vendor/ 内联叶子模块
 * 的既有哲学一致。
 *
 * ## 已经实现与刻意不实现的
 *
 * 实现：文本/二进制帧、分片（continuation）重组、ping/pong 自动回应、close 握手、
 * 三种长度档位（7 位 / 16 位 / 64 位）、掩码（客户端→服务端必须 mask）。
 *
 * 刻意不做：`permessage-deflate` 压缩扩展（浏览器默认不启用，StepFun 也不用）、
 * 多子协议协商、UTF-8 校验（JSON.parse 自己会拒）、HTTP/2 的 RFC 8441。
 * 真要用到这些再加——现在加只是死代码。
 */

import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'

/** 帧操作码。 */
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const

/** 一次握手里客户端必须带上的 GUID（RFC 6455 §1.3）。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 单帧载荷上限：16 MiB。超过就断开，避免被一个坏帧拖爆内存。 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** 解码出来的一帧（未处理分片，分片由 WsPeer 组装）。 */
export interface WsFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/**
 * 按 RFC 6455 算出 `Sec-WebSocket-Accept`。
 * @param clientKey 握手请求里的 `Sec-WebSocket-Key`。
 * @returns 应答头里该填的值。
 */
export function acceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64')
}

/** 请求是不是一次 WebSocket 升级（看 Upgrade / Connection 两个头）。 */
export function isWebSocketUpgrade(req: { headers?: Record<string, unknown> } | null | undefined): boolean {
  const headers = req?.headers
  if (headers === undefined || headers === null) return false
  const upgrade = String(headers.upgrade ?? '').toLowerCase()
  const connection = String(headers.connection ?? '').toLowerCase()
  // Connection 头可能是 "keep-alive, Upgrade" 这种列表形式
  return upgrade === 'websocket' && connection.split(',').some((part) => part.trim() === 'upgrade')
}

/**
 * 编码一帧。
 * @param options.fin 是否最后一帧（默认 true）。
 * @param options.opcode 操作码。
 * @param options.payload 载荷。
 * @param options.mask 是否加掩码。**服务端→客户端必须为 false，客户端→服务端必须为 true**，
 *   反了对方会直接断连（浏览器尤其严格）。
 */
export function encodeFrame(options: {
  fin?: boolean
  opcode: number
  payload: Buffer
  mask?: boolean
}): Buffer {
  const { fin = true, opcode, payload, mask = false } = options
  const length = payload.length
  // 头最多 2 + 8 + 4 字节
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

  if (!mask) {
    const head = header.subarray(0, offset)
    return Buffer.concat([head, payload])
  }

  header[1] |= 0x80
  const maskKey = Buffer.allocUnsafe(4)
  // 掩码只要随机即可，不需要密码学强度；用 randomFillSync 比 Math.random 快且不额外依赖
  for (let i = 0; i < 4; i += 1) maskKey[i] = Math.floor(Math.random() * 256)
  maskKey.copy(header, offset)
  offset += 4
  const masked = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ maskKey[i & 3]
  return Buffer.concat([header.subarray(0, offset), masked])
}

/**
 * 从缓冲区里尽量多地解出帧。
 * @param buffer 收到的原始字节（可能是一帧的一部分、也可能粘了好几帧）。
 * @returns 解出的帧，以及不足以构成一帧的剩余字节（调用方留着下次拼）。
 * @throws 载荷超过上限或长度字段非法时抛错（调用方应当断开连接）。
 */
export function decodeFrames(buffer: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = []
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
      const big = buffer.readBigUInt64BE(cursor + 2)
      if (big > BigInt(MAX_FRAME_BYTES)) throw new Error(`websocket: frame too large (${big} bytes)`)
      length = Number(big)
      headerBytes = 10
    }

    if (length > MAX_FRAME_BYTES) throw new Error(`websocket: frame too large (${length} bytes)`)

    const maskBytes = masked ? 4 : 0
    const total = headerBytes + maskBytes + length
    if (cursor + total > buffer.length) break // 半帧，等下一批

    let payload = buffer.subarray(cursor + headerBytes + maskBytes, cursor + total)
    if (masked) {
      const maskKey = buffer.subarray(cursor + headerBytes, cursor + headerBytes + 4)
      const unmasked = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ maskKey[i & 3]
      payload = unmasked
    } else {
      // subarray 与原 buffer 共享内存：调用方可能长期持有，拷一份避免引用整块大 buffer
      payload = Buffer.from(payload)
    }

    frames.push({ fin, opcode, payload })
    cursor += total
  }

  return { frames, rest: cursor === 0 ? buffer : buffer.subarray(cursor) }
}

/** 连接层回调。 */
export interface WsPeerHandlers {
  /** 收到完整文本消息（分片已组装）。 */
  onMessage?: (text: string) => void
  /** 收到完整二进制消息（分片已组装）。 */
  onBinary?: (payload: Buffer) => void
  /** 连接关闭（对端发 close、或本端 close、或 socket 断开）。 */
  onClose?: (code: number, reason: string) => void
  /** 协议层错误（之后连接会被销毁）。 */
  onError?: (error: Error) => void
}

/**
 * 一条已升级连接的两个方向。
 *
 * 服务端与客户端共用：差别只在 `mask`（我们是客户端时必须掩码）。握手由调用方
 * 完成（服务端回 101，客户端等 `upgrade` 事件），这里只管之后的帧。
 */
export class WsPeer {
  private readonly socket: Duplex
  private readonly mask: boolean
  private readonly handlers: WsPeerHandlers
  private receiveBuffer: Buffer = Buffer.alloc(0)
  /** 分片重组：非 null 表示正在收一条被拆开的消息。 */
  private fragmentOpcode: number | null = null
  private fragmentChunks: Buffer[] = []
  private closed = false

  constructor(socket: Duplex, options: { mask: boolean; handlers?: WsPeerHandlers }) {
    this.socket = socket
    this.mask = options.mask
    this.handlers = options.handlers ?? {}
    socket.on('data', (chunk: Buffer) => this.feed(chunk))
    socket.on('error', (error: Error) => {
      this.finish(1006, error.message, error)
    })
    socket.on('close', () => {
      this.finish(1006, 'socket closed')
    })
  }

  /** 把收到的原始字节喂进来（调用方在 socket 'data' 里调用）。 */
  feed(chunk: Buffer): void {
    if (this.closed) return
    this.receiveBuffer = this.receiveBuffer.length === 0 ? chunk : Buffer.concat([this.receiveBuffer, chunk])
    let decoded: { frames: WsFrame[]; rest: Buffer }
    try {
      decoded = decodeFrames(this.receiveBuffer)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.receiveBuffer = decoded.rest
    for (const frame of decoded.frames) {
      this.handleFrame(frame)
      if (this.closed) return
    }
  }

  /** 发一条文本消息。 */
  sendText(text: string): void {
    this.write(OPCODE.text, Buffer.from(text, 'utf8'))
  }

  /** 发一条二进制消息。 */
  sendBinary(payload: Buffer): void {
    this.write(OPCODE.binary, payload)
  }

  /** 主动关闭（发 close 帧，然后等对端或超时销毁）。 */
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason, 'utf8'))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2, 'utf8')
    try {
      this.socket.write(encodeFrame({ opcode: OPCODE.close, payload, mask: this.mask }))
    } catch {
      /* 已经断了 */
    }
    this.finish(code, reason)
  }

  /** 直接断掉（不发 close 帧）。 */
  destroy(): void {
    this.closed = true
    try {
      this.socket.destroy()
    } catch {
      /* 已销毁 */
    }
  }

  /** 连接是否还开着。 */
  get isOpen(): boolean {
    return !this.closed && !this.socket.destroyed
  }

  private handleFrame(frame: WsFrame): void {
    switch (frame.opcode) {
      case OPCODE.ping:
        this.write(OPCODE.pong, frame.payload)
        return
      case OPCODE.pong:
        return
      case OPCODE.close: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : ''
        // 回一个 close 完成握手（对端可能已经不等了，失败无所谓）
        try {
          const echo = Buffer.allocUnsafe(2)
          echo.writeUInt16BE(code === 1005 ? 1000 : code, 0)
          this.socket.write(encodeFrame({ opcode: OPCODE.close, payload: echo, mask: this.mask }))
        } catch {
          /* 已断 */
        }
        this.finish(code, reason)
        return
      }
      case OPCODE.continuation: {
        if (this.fragmentOpcode === null) {
          this.fail(new Error('websocket: unexpected continuation frame'))
          return
        }
        this.fragmentChunks.push(frame.payload)
        if (frame.fin) {
          const opcode = this.fragmentOpcode
          const whole = Buffer.concat(this.fragmentChunks)
          this.fragmentOpcode = null
          this.fragmentChunks = []
          this.deliver(opcode, whole)
        }
        return
      }
      case OPCODE.text:
      case OPCODE.binary: {
        if (!frame.fin) {
          this.fragmentOpcode = frame.opcode
          this.fragmentChunks = [frame.payload]
          return
        }
        this.deliver(frame.opcode, frame.payload)
        return
      }
      default:
        this.fail(new Error(`websocket: unsupported opcode ${frame.opcode}`))
    }
  }

  private deliver(opcode: number, payload: Buffer): void {
    if (opcode === OPCODE.text) {
      this.handlers.onMessage?.(payload.toString('utf8'))
    } else {
      this.handlers.onBinary?.(payload)
    }
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return
    try {
      this.socket.write(encodeFrame({ opcode, payload, mask: this.mask }))
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private fail(error: Error): void {
    this.handlers.onError?.(error)
    this.finish(1011, error.message, error)
  }

  private finish(code: number, reason: string, error?: Error): void {
    if (this.closed) return
    this.closed = true
    if (error !== undefined) this.handlers.onError?.(error)
    this.handlers.onClose?.(code, reason)
    try {
      this.socket.destroy()
    } catch {
      /* 已销毁 */
    }
  }
}

/**
 * 在服务端一侧完成握手：写 101 响应，返回封装好的连接。
 * @param socket `upgrade` 事件给的原始 socket。
 * @param head 升级请求里可能已经带着的第一批数据。
 * @param handlers 回调。
 */
export function acceptUpgrade(
  req: { headers: Record<string, unknown> },
  socket: Duplex,
  head: Buffer,
  handlers: WsPeerHandlers,
): WsPeer {
  const key = String(req.headers['sec-websocket-key'] ?? '')
  if (key === '') {
    socket.destroy()
    throw new Error('websocket: missing Sec-WebSocket-Key')
  }
  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ].join('\r\n')
  socket.write(response)
  const peer = new WsPeer(socket, { mask: false, handlers })
  if (head.length > 0) peer.feed(head)
  return peer
}
