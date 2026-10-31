/**
 * dsh-seeker-bot — Bot 控制台 HTTP 接口。
 *
 * 全部收敛在一个 prefix handler 里（重复 (kind,path) 会抛异常）：
 *   GET    /api/seeker-bot/health
 *   GET    /api/seeker-bot/state
 *   POST   /api/seeker-bot/bots
 *   PATCH  /api/seeker-bot/bots/:id
 *   DELETE /api/seeker-bot/bots/:id
 *   POST   /api/seeker-bot/bots/:id/primary
 *   POST   /api/seeker-bot/ui/mode
 */

import {
  createBot, deleteBot, loadState, setPrimary, setUiMode, updateBot,
} from './state.js'

type Handler = (req: any, res: any) => void | Promise<void>

const MAX_BODY = 64 * 1024

/** 读 JSON body（带上限；坏 JSON 返回空对象）。 */
function readJsonBody(req: any): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { resolve({}); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res: any, status: number, payload: unknown): void {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch { /* 客户端已断开 */ }
}

/** 写操作挡跨站（浏览器带 Origin 时必须是同源）。 */
function crossSite(req: any): boolean {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return false
  const host = req.headers?.host
  try {
    const u = new URL(origin)
    return typeof host !== 'string' || u.host !== host
  } catch { return true }
}

function publicState() {
  const st = loadState()
  return {
    version: st.version,
    bots: st.bots,
    groups: st.groups,
    ui: st.ui,
  }
}

export function applyBotHost(ctx: any): void {
  const handler: Handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/^\/api\/seeker-bot/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    if (path === '/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, plugin: 'dsh-seeker-bot', bots: loadState().bots.length })
    }

    if (path === '/state' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...publicState() })
    }

    if (method !== 'GET' && crossSite(req)) {
      return sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
    }

    if (path === '/bots' && method === 'POST') {
      const body = await readJsonBody(req)
      const bot = createBot(body)
      return sendJson(res, 201, { ok: true, bot })
    }

    const mBot = /^\/bots\/([^/]+)$/.exec(path)
    if (mBot !== null) {
      const id = decodeURIComponent(mBot[1])
      if (method === 'PATCH') {
        const body = await readJsonBody(req)
        const bot = updateBot(id, body)
        return bot === null ? sendJson(res, 404, { ok: false, error: 'bot not found' }) : sendJson(res, 200, { ok: true, bot })
      }
      if (method === 'DELETE') {
        return deleteBot(id) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { ok: false, error: 'bot not found' })
      }
    }

    const mPrimary = /^\/bots\/([^/]+)\/primary$/.exec(path)
    if (mPrimary !== null && method === 'POST') {
      const bot = setPrimary(decodeURIComponent(mPrimary[1]))
      return bot === null ? sendJson(res, 404, { ok: false, error: 'bot not found' }) : sendJson(res, 200, { ok: true, bot })
    }

    if (path === '/ui/mode' && method === 'POST') {
      const body = await readJsonBody(req)
      setUiMode(body.mode === 'work' ? 'work' : 'bot')
      return sendJson(res, 200, { ok: true, mode: loadState().ui.mode })
    }

    return sendJson(res, 404, { ok: false, error: 'not found' })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/seeker-bot',
    handler,
  }), 'dsh-seeker-bot: bot console routes')
}
