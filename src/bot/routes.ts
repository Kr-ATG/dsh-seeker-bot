/**
 * dsh-seeker-bot — Bot 控制台 HTTP 接口。
 *
 * 全部收敛在一个 prefix handler 里（重复 (kind,path) 会抛异常）：
 *
 *   GET    /api/seeker-bot/health
 *   GET    /api/seeker-bot/state
 *   GET    /api/seeker-bot/usage
 *   GET    /api/seeker-bot/rules              PUT /api/seeker-bot/rules
 *   POST   /api/seeker-bot/bots
 *   GET    /api/seeker-bot/bots/:id           PATCH/DELETE /api/seeker-bot/bots/:id
 *   POST   /api/seeker-bot/bots/:id/primary|duplicate|pause|resume
 *   POST   /api/seeker-bot/bots/:id/session   GET /api/seeker-bot/bots/:id/sessions
 *   GET    /api/seeker-bot/bots/:id/model     POST /api/seeker-bot/bots/:id/model
 *   GET    /api/seeker-bot/bots/:id/proactive POST /api/seeker-bot/bots/:id/proactive
 *   POST   /api/seeker-bot/bots/:id/proactive/test
 *   POST   /api/seeker-bot/session/bind
 *   GET    /api/seeker-bot/models/resolve?session=
 *   GET    /api/seeker-bot/routines           POST /api/seeker-bot/routines
 *   GET    /api/seeker-bot/routines/:id       PATCH/DELETE /api/seeker-bot/routines/:id
 *   GET    /api/seeker-bot/routines/:id/runs  POST /api/seeker-bot/routines/:id/test
 *   POST   /api/seeker-bot/webhook/:id/:key
 *   GET    /api/seeker-bot/groups             POST /api/seeker-bot/groups
 *   GET    /api/seeker-bot/groups/:id         PATCH/DELETE /api/seeker-bot/groups/:id
 *   POST   /api/seeker-bot/groups/:id/decide
 *   POST   /api/seeker-bot/ui/mode
 *
 * 约定：
 *   - 所有写操作做同源校验（带 Origin 时必须与 Host 一致；服务端 webhook 无 Origin 放行）；
 *   - 所有 handler 整段 try/catch，错误一律 JSON，绝不抛穿；
 *   - 本文件不引任何 @deepseek-ai/* 运行时依赖。
 */

import {
  createBot, deleteBot, duplicateBot, findBot, getUiMode, listRules, loadState,
  readUsage, replaceRules, setBotPaused, setPrimary, setUiMode, updateBot,
  type ApprovalRule, type BotRecord,
} from './state.js'
import { applyModelPrefsToSession, botModelOf, resolveModelFor, setBotModel } from './models.js'
import { bindSessionToBot, createBotSession, sessionsOfBot } from './sessions.js'
import { createRoutine, handleWebhookRequest, removeRoutine, testRoutine, updateRoutine } from './routines.js'
import { setProactiveConfig, testProactive } from './proactive.js'
import {
  createGroupFromBody, decideSpeaker, deleteGroupById, groupView, listGroupViews,
  updateGroupFromBody,
} from './groups.js'
import { setGateDefaultEnabled } from '../tools-gate/index.js'

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
    routines: st.routines,
    rules: st.rules,
    usage: st.usage,
    sessions: st.sessions,
    ui: st.ui,
  }
}

/** 错误 → 合适的 HTTP 状态：不存在按 404，其余按 400。 */
function statusOfError(error: string): number {
  return /不存在|未找到/.test(error) ? 404 : 400
}

/** 一个最小的字符串字段读取（body 值可能是任意类型）。 */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 把请求体归一成审批规则数组（PUT /rules）。 */
function rulesFromBody(body: Record<string, unknown>): ApprovalRule[] {
  const raw = Array.isArray(body.rules) ? body.rules : []
  const rules: ApprovalRule[] = []
  raw.forEach((item, index) => {
    if (item === null || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    const pattern = text(record.pattern).trim()
    if (pattern === '') return
    const action = record.action === 'allow' || record.action === 'deny' || record.action === 'ask'
      ? record.action
      : 'ask'
    rules.push({
      id: text(record.id).trim() || 'rule-' + Date.now().toString(36) + '-' + index,
      pattern,
      action,
      ...(text(record.note).trim() !== '' ? { note: text(record.note).trim() } : {}),
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    })
  })
  return rules
}

/** 主分发（每个分支只做参数解析与调用，异常由最外层统一兜住）。 */
async function dispatch(ctx: any, req: any, res: any): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/^\/api\/seeker-bot/, '') || '/'
  const method = String(req.method ?? 'GET').toUpperCase()

  /* ── 只读基础端点 ── */
  if (path === '/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, plugin: 'dsh-seeker-bot', bots: loadState().bots.length })
  }
  if (path === '/state' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...publicState() })
  }
  if (path === '/usage' && method === 'GET') {
    return sendJson(res, 200, { ok: true, usage: readUsage() })
  }
  if (path === '/rules' && method === 'GET') {
    return sendJson(res, 200, { ok: true, rules: listRules() })
  }
  /* ── 写操作同源校验（放在所有写路由之前） ── */
  if (method !== 'GET' && crossSite(req)) {
    return sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
  }

  if (path === '/rules' && method === 'PUT') {
    const body = await readJsonBody(req)
    return sendJson(res, 200, { ok: true, rules: replaceRules(rulesFromBody(body)) })
  }

  /* ── Bot 集合 ── */
  if (path === '/bots' && method === 'POST') {
    const body = await readJsonBody(req)
    const bot = createBot(body)
    return sendJson(res, 201, { ok: true, bot })
  }
  if (path === '/bots' && method === 'GET') {
    return sendJson(res, 200, { ok: true, bots: loadState().bots })
  }

  /* ── 单个 Bot 的动作（比 /bots/:id 更具体的先匹配） ── */
  const action = /^\/bots\/([^/]+)\/(duplicate|pause|resume|primary|session|sessions|model|proactive|proactive\/test)$/.exec(path)
  if (action !== null) {
    const id = decodeURIComponent(action[1])
    const kind = action[2]
    if (kind === 'duplicate' && method === 'POST') {
      const bot = duplicateBot(id)
      return bot === null
        ? sendJson(res, 404, { ok: false, error: 'bot not found' })
        : sendJson(res, 201, { ok: true, bot })
    }
    if ((kind === 'pause' || kind === 'resume') && method === 'POST') {
      const bot = setBotPaused(id, kind === 'pause')
      return bot === null
        ? sendJson(res, 404, { ok: false, error: 'bot not found' })
        : sendJson(res, 200, { ok: true, bot })
    }
    if (kind === 'primary' && method === 'POST') {
      const bot = setPrimary(id)
      return bot === null
        ? sendJson(res, 404, { ok: false, error: 'bot not found' })
        : sendJson(res, 200, { ok: true, bot })
    }
    if (kind === 'session' && method === 'POST') {
      const bot = findBot(id)
      if (bot === null) return sendJson(res, 404, { ok: false, error: 'bot not found' })
      const created = await createBotSession(ctx, bot)
      if (!created.ok) return sendJson(res, 400, { ok: false, error: created.error ?? '创建会话失败' })
      let model: unknown
      try {
        model = await applyModelPrefsToSession(ctx, created.sessionId as string)
      } catch {
        model = { ok: false, applied: false, reason: '模型偏好写入异常（已忽略）' }
      }
      return sendJson(res, 201, { ok: true, ...created, model })
    }
    if (kind === 'sessions' && method === 'GET') {
      const bot = findBot(id)
      if (bot === null) return sendJson(res, 404, { ok: false, error: 'bot not found' })
      return sendJson(res, 200, { ok: true, sessions: sessionsOfBot(id) })
    }
    if (kind === 'model') {
      const bot = findBot(id)
      if (bot === null) return sendJson(res, 404, { ok: false, error: 'bot not found' })
      if (method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        return sendJson(res, 200, {
          ok: true,
          model: botModelOf(id),
          ...(sessionId !== '' ? { resolved: resolveModelFor(sessionId) } : {}),
        })
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const updated = setBotModel(id, body.model !== undefined ? body.model : body)
        return updated === null
          ? sendJson(res, 404, { ok: false, error: 'bot not found' })
          : sendJson(res, 200, { ok: true, bot: updated, model: botModelOf(id) })
      }
    }
    if (kind === 'proactive') {
      const bot = findBot(id)
      if (bot === null) return sendJson(res, 404, { ok: false, error: 'bot not found' })
      if (method === 'GET') return sendJson(res, 200, { ok: true, proactive: bot.proactive })
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const updated = setProactiveConfig(id, body.proactive !== undefined ? body.proactive : body)
        return updated === null
          ? sendJson(res, 404, { ok: false, error: 'bot not found' })
          : sendJson(res, 200, { ok: true, bot: updated })
      }
    }
    if (kind === 'proactive/test' && method === 'POST') {
      const bot = findBot(id)
      if (bot === null) return sendJson(res, 404, { ok: false, error: 'bot not found' })
      const body = await readJsonBody(req)
      return sendJson(res, 200, { ok: true, ...testProactive(bot, body.events) })
    }
  }

  const mBot = /^\/bots\/([^/]+)$/.exec(path)
  if (mBot !== null) {
    const id = decodeURIComponent(mBot[1])
    if (method === 'GET') {
      const bot = findBot(id)
      return bot === null
        ? sendJson(res, 404, { ok: false, error: 'bot not found' })
        : sendJson(res, 200, { ok: true, bot, sessions: sessionsOfBot(id) })
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      const bot = updateBot(id, body)
      return bot === null
        ? sendJson(res, 404, { ok: false, error: 'bot not found' })
        : sendJson(res, 200, { ok: true, bot })
    }
    if (method === 'DELETE') {
      return deleteBot(id)
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 404, { ok: false, error: 'bot not found' })
    }
  }

  /* ── 会话绑定 ── */
  if (path === '/session/bind' && method === 'POST') {
    const body = await readJsonBody(req)
    const sessionId = text(body.sessionId)
    const botId = text(body.botId)
    const result = bindSessionToBot(sessionId, botId)
    if (!result.ok) return sendJson(res, statusOfError(result.error ?? ''), { ok: false, error: result.error })
    // 绑定即应用一次该会话的模型偏好（拿不到官方模型服务时只返回状态，不阻塞）。
    let model: unknown
    try {
      model = await applyModelPrefsToSession(ctx, sessionId)
    } catch {
      model = { ok: false, applied: false, reason: '模型偏好写入异常（已忽略）' }
    }
    return sendJson(res, 200, { ok: true, binding: { sessionId, botId }, model })
  }

  /* ── 模型解析 ── */
  if (path === '/models/resolve' && method === 'GET') {
    const sessionId = url.searchParams.get('session') ?? ''
    return sendJson(res, 200, { ok: true, sessionId, model: resolveModelFor(sessionId) })
  }

  /* ── 日程 ── */
  if (path === '/routines' && method === 'GET') {
    const botId = url.searchParams.get('botId') ?? ''
    return sendJson(res, 200, { ok: true, routines: loadState().routines.filter((routine) => botId === '' || routine.botId === botId) })
  }
  if (path === '/routines' && method === 'POST') {
    const body = await readJsonBody(req)
    const result = await createRoutine(ctx, body)
    if (!result.ok) return sendJson(res, statusOfError(result.error ?? ''), { ok: false, error: result.error })
    return sendJson(res, 201, { ok: true, routine: result.routine, schedule: result.schedule })
  }
  const routineAction = /^\/routines\/([^/]+)\/(runs|test)$/.exec(path)
  if (routineAction !== null) {
    const id = decodeURIComponent(routineAction[1])
    const kind = routineAction[2]
    const routine = loadState().routines.find((item) => item.id === id)
    if (routine === undefined) return sendJson(res, 404, { ok: false, error: '日程不存在' })
    if (kind === 'runs' && method === 'GET') return sendJson(res, 200, { ok: true, runs: routine.runs })
    if (kind === 'test' && method === 'POST') {
      const result = await testRoutine(ctx, id)
      return result.ok
        ? sendJson(res, 200, { ok: true, delivered: result.delivered, reason: result.reason, routine: result.routine })
        : sendJson(res, statusOfError(result.error ?? ''), { ok: false, error: result.error })
    }
  }
  const mRoutine = /^\/routines\/([^/]+)$/.exec(path)
  if (mRoutine !== null) {
    const id = decodeURIComponent(mRoutine[1])
    if (method === 'GET') {
      const routine = loadState().routines.find((item) => item.id === id)
      return routine === undefined
        ? sendJson(res, 404, { ok: false, error: '日程不存在' })
        : sendJson(res, 200, { ok: true, routine, bot: findBot(routine.botId) })
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      const result = await updateRoutine(ctx, id, body)
      return result.ok
        ? sendJson(res, 200, { ok: true, routine: result.routine, schedule: result.schedule })
        : sendJson(res, statusOfError(result.error ?? ''), { ok: false, error: result.error })
    }
    if (method === 'DELETE') {
      const result = await removeRoutine(ctx, id)
      return result.ok
        ? sendJson(res, 200, { ok: true, schedule: result.schedule })
        : sendJson(res, statusOfError(result.error ?? ''), { ok: false, error: result.error })
    }
  }

  /* ── webhook（外部服务调用：无 Origin 放行，带跨站 Origin 已在上面拦掉） ── */
  const mWebhook = /^\/webhook\/([^/]+)\/([^/]+)$/.exec(path)
  if (mWebhook !== null && method === 'POST') {
    await readJsonBody(req)
    const result = await handleWebhookRequest(ctx, decodeURIComponent(mWebhook[1]), decodeURIComponent(mWebhook[2]))
    return sendJson(res, result.status, result.body)
  }

  /* ── 群组 ── */
  if (path === '/groups' && method === 'GET') {
    return sendJson(res, 200, { ok: true, groups: listGroupViews() })
  }
  if (path === '/groups' && method === 'POST') {
    const body = await readJsonBody(req)
    const result = createGroupFromBody(body)
    return result.ok && result.group !== undefined
      ? sendJson(res, 201, { ok: true, group: groupView(result.group) })
      : sendJson(res, statusOfError(result.error ?? ''), { ok: false, error: result.error })
  }
  const groupDecide = /^\/groups\/([^/]+)\/decide$/.exec(path)
  if (groupDecide !== null && method === 'POST') {
    const id = decodeURIComponent(groupDecide[1])
    const body = await readJsonBody(req)
    const group = loadState().groups.find((item) => item.id === id)
    if (group === undefined) return sendJson(res, 404, { ok: false, error: '群组不存在' })
    return sendJson(res, 200, { ok: true, decision: decideSpeaker(groupView(group), text(body.text)) })
  }
  const mGroup = /^\/groups\/([^/]+)$/.exec(path)
  if (mGroup !== null) {
    const id = decodeURIComponent(mGroup[1])
    if (method === 'GET') {
      const group = loadState().groups.find((item) => item.id === id)
      return group === undefined
        ? sendJson(res, 404, { ok: false, error: '群组不存在' })
        : sendJson(res, 200, { ok: true, group: groupView(group) })
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      const result = updateGroupFromBody(id, body)
      return result.ok && result.group !== undefined
        ? sendJson(res, 200, { ok: true, group: groupView(result.group) })
        : sendJson(res, statusOfError(result.error ?? ''), { ok: false, error: result.error })
    }
    if (method === 'DELETE') {
      const result = deleteGroupById(id)
      return result.ok
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, statusOfError(result.error ?? ''), { ok: false, error: result.error })
    }
  }

  /* ── UI 模式（同时切换 computer-use 的部署级默认） ── */
  if (path === '/ui/mode' && method === 'POST') {
    const body = await readJsonBody(req)
    const mode = body.mode === 'work' ? 'work' : 'bot'
    setUiMode(mode)
    try { setGateDefaultEnabled('computer-use', mode === 'bot') } catch { /* 闸门未装配时无副作用 */ }
    return sendJson(res, 200, { ok: true, mode: loadState().ui.mode })
  }

  return sendJson(res, 404, { ok: false, error: 'not found' })
}

export function applyBotHost(ctx: any): void {
  // 启动时按当前 UI 模式同步一次 computer-use 默认值（闸门未装配时是 no-op）。
  try { setGateDefaultEnabled('computer-use', getUiMode() === 'bot') } catch { /* ignore */ }

  const handler: Handler = async (req, res) => {
    try {
      await dispatch(ctx, req, res)
    } catch {
      // 所有路由的错误一律 JSON，不抛穿 webServer。
      sendJson(res, 500, { ok: false, error: 'internal error' })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/seeker-bot',
    handler,
  }), 'dsh-seeker-bot: bot console routes')
}
