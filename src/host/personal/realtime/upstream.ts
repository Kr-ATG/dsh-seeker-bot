/**
 * 到 StepFun Realtime API 的 WebSocket 客户端。
 *
 * ## 为什么不用 Node 内置的全局 WebSocket
 *
 * StepFun 用 `Authorization: Bearer <key>` 鉴权，而 Node 22 的全局 WebSocket
 * （undici 实现）构造函数只接受 `(url, protocols)`，**没有 headers 参数**。
 * 于是只能走 `node:https` 的 `request()` + `'upgrade'` 事件：HTTP 升级由 Node
 * 的 TLS/HTTP 栈完成（证书校验、SNI、超时都免费），升级成功后拿到的 socket
 * 就是一条裸 TCP/TLS 流，帧编解码交给 ws-frame.ts。
 *
 * ## 代理
 *
 * 这里不走 undici 的 ProxyAgent（node:https 不认）。StepFun 在国内可直连，
 * 若将来需要走代理，给 `request()` 传 `agent` 即可（https-proxy-agent 那类），
 * 不用改这里的其它逻辑。
 */

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { acceptKey, WsPeer, type WsPeerHandlers } from './ws-frame.ts'

/** 上游连接失败：带上能直接展示给用户的原因与可选的 HTTP 状态码。 */
export class UpstreamError extends Error {
  /** HTTP 状态码（握手被拒时才有）。 */
  readonly status: number | undefined
  /** 是否值得重试（网络类可重试，鉴权类不可）。 */
  readonly retryable: boolean

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = options.status
    this.retryable = options.retryable ?? false
  }
}

/** 把状态码翻译成用户能懂的一句话。 */
function explainStatus(status: number, body: string): string {
  const snippet = body.trim().slice(0, 200)
  const suffix = snippet === '' ? '' : `（上游返回：${snippet}）`
  if (status === 401 || status === 403) {
    return `实时语音鉴权失败（HTTP ${status}）：请检查 STEPPLAN_API_KEY 是否有效、是否开通了 Realtime 权限${suffix}`
  }
  if (status === 404) {
    return `实时语音模型不存在（HTTP 404）：当前 key 可能不支持该模型名${suffix}`
  }
  if (status === 429) {
    return `实时语音被限流（HTTP 429）：并发或频率超限，稍后再试${suffix}`
  }
  if (status === 402) {
    return `实时语音额度不足（HTTP 402）：请检查账户余额或套餐${suffix}`
  }
  return `实时语音上游握手失败（HTTP ${status}）${suffix}`
}

/**
 * 建立到上游的 WebSocket 连接。
 *
 * @param options.url 上游地址（`wss://...` 或 `ws://...`，可带 query）。
 * @param options.apiKey Bearer 凭据；**只留在宿主进程里，不要回传前端**。
 * @param options.handlers 帧回调（连接建立后才会开始收到）。
 * @param options.timeoutMs 建连 + 握手的总超时，默认 12 秒。
 * @returns 已握手的连接（掩码方向为客户端）。
 * @throws {UpstreamError} 鉴权失败、模型不存在、超时、网络错误。
 */
export async function connectUpstream(options: {
  url: string
  apiKey: string
  handlers: WsPeerHandlers
  timeoutMs?: number
}): Promise<WsPeer> {
  const { url, apiKey, handlers, timeoutMs = 12_000 } = options
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UpstreamError(`实时语音上游地址不合法：${url}`)
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new UpstreamError(`实时语音上游地址必须是 ws:// 或 wss://，收到 ${parsed.protocol}`)
  }

  const secure = parsed.protocol === 'wss:'
  const request = secure ? httpsRequest : httpRequest
  // 客户端握手的 key：16 字节随机数的 base64（RFC 6455 §4.1）
  const key = randomBytes(16).toString('base64')

  return await new Promise<WsPeer>((resolve, reject) => {
    let settled = false
    const settleReject = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }

    const req = request({
      // 这里必须是 http:/https: —— node 的 http.request 只认这两个。
      // 直接传 parsed.protocol（ws:/wss:）会同步抛 `Protocol "ws:" not supported`，
      // 而且是在 try/catch 之外抛的，表现为每个模型候选都秒失败、上游一个连接都没建。
      protocol: secure ? 'https:' : 'http:',
      hostname: parsed.hostname,
      port: parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Authorization: `Bearer ${apiKey}`,
        // 有些网关会按 UA 做风控，给一个明确的标识比默认 UA 稳
        'User-Agent': 'dsh-seeker-bot/realtime',
      },
    })

    const timer = setTimeout(() => {
      req.destroy()
      settleReject(new UpstreamError('实时语音上游连接超时（12 秒内没有完成握手）', { retryable: true }))
    }, timeoutMs)
    // 不把事件循环钉住
    timer.unref?.()

    req.on('upgrade', (response: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (settled) {
        socket.destroy()
        return
      }
      // 校验服务端的 Accept 值：能挡住「连到了错误的服务」这类事故
      const expected = acceptKey(key)
      const actual = String(response.headers['sec-websocket-accept'] ?? '')
      if (actual !== expected) {
        socket.destroy()
        settleReject(new UpstreamError('实时语音上游握手校验失败（Sec-WebSocket-Accept 不匹配）'))
        return
      }
      settled = true
      clearTimeout(timer)
      const peer = new WsPeer(socket, { mask: true, handlers })
      if (head.length > 0) peer.feed(head)
      resolve(peer)
    })

    // 不是 101：读一小段 body 用于诊断，然后按状态码分类报错
    req.on('response', (response: IncomingMessage) => {
      const status = response.statusCode ?? 0
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk
      })
      const done = (): void => {
        // 鉴权/额度类错误重试没有意义，网络类才有
        const retryable = status === 429 || status >= 500
        settleReject(new UpstreamError(explainStatus(status, body), { status, retryable }))
      }
      response.on('end', done)
      response.on('error', done)
      response.on('close', done)
    })

    req.on('error', (error: Error) => {
      settleReject(new UpstreamError(`实时语音上游连接失败：${error.message}`, { retryable: true }))
    })

    req.end()
  })
}
