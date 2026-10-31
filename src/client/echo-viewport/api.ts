/**
 * dsh-seeker-bot — 工作区实时回显抓帧客户端 API。
 *
 * @module
 */

/** 旧版窗口抓帧路由（保留给非 ego 浏览器场景）。 */
export const ECHO_VIEWPORT_FRAME_ROUTE = '/api/chat-flow/echo-viewport/frame'
/** 工作空间抓帧路由（ego TaskSpace 画面，操作面板的唯一数据源）。 */
export const ECHO_VIEWPORT_SPACE_ROUTE = '/api/chat-flow/echo-viewport/space-frame'

export interface EchoFrameSuccess {
  readonly ok: true
  readonly hwnd: number
  readonly process: string
  readonly title: string
  readonly w: number
  readonly h: number
  /** base64 编码的 JPEG 图片。 */
  readonly data: string
  readonly at: number
}

export interface EchoFrameError {
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly title?: string
}

export type EchoFrameResult = EchoFrameSuccess | EchoFrameError

export interface EchoSpaceFrameSuccess {
  readonly ok: true
  readonly spaceId: number
  readonly name: string
  readonly title: string
  readonly url: string
  readonly w: number
  readonly h: number
  /** base64 编码的 JPEG 图片。 */
  readonly data: string
  readonly at: number
}

export interface EchoSpaceFrameError {
  readonly ok: false
  readonly code: string
  readonly message: string
}

export type EchoSpaceFrameResult = EchoSpaceFrameSuccess | EchoSpaceFrameError

export interface FetchEchoSpaceFrameOptions {
  /** 当前会话 id：服务端据此读取该会话的工作空间线索并维护绑定。 */
  readonly session?: string | null
  /** 从会话工具调用里提取的工作空间线索（taskSpace 名称 / spaceId）。 */
  readonly hints?: readonly string[]
  readonly maxW?: number
}

function paramsOf(options: { session?: string | null; hints?: readonly string[]; maxW?: number }): string {
  const params = new URLSearchParams()
  const session = typeof options.session === 'string' ? options.session.trim() : ''
  if (session !== '') params.set('session', session)
  const hints = (options.hints ?? []).map((hint) => hint.trim()).filter((hint) => hint !== '')
  if (hints.length > 0) params.set('hint', hints.slice(-6).join(','))
  if (options.maxW && options.maxW > 0) params.set('maxW', String(Math.round(options.maxW)))
  return params.toString()
}

/**
 * 获取本会话关联工作空间的最新画面帧。
 * 绝不抛错，失败时返回 { ok: false, code, message }。
 */
export async function fetchEchoSpaceFrame(options: FetchEchoSpaceFrameOptions = {}): Promise<EchoSpaceFrameResult> {
  if (typeof fetch !== 'function') {
    return { ok: false, code: 'no_fetch', message: 'fetch 不可用' }
  }
  const query = paramsOf(options)
  const url = query === '' ? ECHO_VIEWPORT_SPACE_ROUTE : `${ECHO_VIEWPORT_SPACE_ROUTE}?${query}`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!res.ok) {
      return { ok: false, code: `http_${res.status}`, message: `HTTP ${res.status} ${res.statusText}` }
    }
    return (await res.json()) as EchoSpaceFrameResult
  } catch (err: unknown) {
    return { ok: false, code: 'network_error', message: err instanceof Error ? err.message : String(err) }
  }
}

export interface FetchEchoFrameOptions {
  readonly process?: string
  readonly maxW?: number
  readonly hwnd?: number
  readonly query?: string
}

/** 旧版窗口抓帧 API（保留，不再被回显视口使用）。 */
export async function fetchEchoFrame(options: FetchEchoFrameOptions = {}): Promise<EchoFrameResult> {
  if (typeof fetch !== 'function') {
    return { ok: false, code: 'no_fetch', message: 'fetch 不可用' }
  }
  const params = new URLSearchParams()
  if (options.process) params.set('process', options.process)
  if (options.maxW && options.maxW > 0) params.set('maxW', String(Math.round(options.maxW)))
  if (options.hwnd && options.hwnd > 0) params.set('hwnd', String(Math.round(options.hwnd)))
  if (options.query && options.query.trim()) params.set('query', options.query.trim())
  const url = `${ECHO_VIEWPORT_FRAME_ROUTE}?${params.toString()}`
  try {
    const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!res.ok) {
      return { ok: false, code: `http_${res.status}`, message: `HTTP ${res.status} ${res.statusText}` }
    }
    return (await res.json()) as EchoFrameResult
  } catch (err: unknown) {
    return { ok: false, code: 'network_error', message: err instanceof Error ? err.message : String(err) }
  }
}
