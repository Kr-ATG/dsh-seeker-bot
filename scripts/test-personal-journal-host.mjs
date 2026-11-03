/**
 * Personal Agent 期刊（Journal）宿主服务的集成测试。
 *
 * 覆盖契约（见 src/shared/journal.ts 与 src/host/personal/journal.ts）：
 *   - GET  /journal/list      初始为空 → 生成后有 1 条
 *   - POST /journal/generate  真实模型（fake llm.stream）生成 → 落盘 → 返回 journal
 *   - GET  /journal/status    规则 / 日志 / generating / lastGeneratedAt
 *   - POST /journal/rule      规则保存与回读
 *   - POST /journal/feed      素材保存（48h 裁剪）与回读
 *   - POST /journal/check     窗口 / 静默 / 昨日无期刊 → 生成；再 check 应报「已生成」
 *   - DELETE /journal?id=     删除记录与文件
 *   - 跨站写请求被拒绝；/journal/image、/journal/asset 路由保留
 *
 * 测试要点（这几条错了都不会抛错，只能断言）：
 *   1. 生图网关不可达时**期刊照常生成**（封面失败不阻塞，image 留空）；
 *   2. 模型返回坏 JSON 时 **502 + 可读错误**，而不是静默回退成模板；
 *   3. 没有可用模型时明确报「未配置可用的聊天模型」；
 *   4. 昨日已有期刊时再 check 不能重复生成。
 *
 * 隔离：DSH_HOME / bot 工作区都指向临时目录，不碰真实数据；调度器的 5 秒补跑
 * 用一个「真实当前小时不在其中」的窗口规则避开（见 windowForTest）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPersonalAgentHost } from '../lib/index.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pa-journal-home-'))
process.env.DSH_SEEKER_BOT_WORKSPACE = mkdtempSync(join(tmpdir(), 'pa-journal-workspace-'))

const DATA_DIR = join(process.env.DSH_HOME, 'storages', 'dsh-seeker-bot', 'personal-agent')
const JOURNALS_DIR = join(DATA_DIR, 'journals')

/*
 * 插件挂载后调度器会在 5 秒后补跑一次 tick。为了让它在断言过程中不偷偷生成，
 * 预置一条「未启用」的规则；需要测 check 的用例再临时打开。
 */
mkdirSync(DATA_DIR, { recursive: true })
writeFileSync(join(DATA_DIR, 'journal-rule.json'), JSON.stringify({
  rule: { enabled: false, startHour: 0, endHour: 8, idleMinutes: 30 },
  updatedAt: Date.now(),
}, null, 2))

/** 合法期刊 JSON（字段与 journalSystemPrompt 的规格一致）。 */
const GOOD_JOURNAL = {
  title: '把调度搬进宿主的一天',
  subtitle: '从页面定时器到常驻进程',
  summary: '今天主要在处理期刊生成的宿主化：把定时器从页面挪进常驻进程，接上真实模型与磁盘存储，页面关掉也能按时出刊。',
  mood: '专注',
  weather: '多云',
  quote: '页面关掉也得能跑。',
  sections: [
    { heading: '上午：拆掉旧模板', text: '上午先把前端那套随机标题的模板实现拆了，确认新契约只保留字段定义。' },
    { heading: '下午：接上真模型', text: '下午把生成链路接到宿主 llm 服务，提示词要求只依据当天素材，输出严格 JSON。', bullets: ['解析层剥围栏', '失败回 502 不降级'] },
    { heading: '夜里：调度与落盘', text: '晚上接上 30 秒 tick 的调度器，并让期刊落到 personal-agent 目录，第二天打开页面就能看到。' },
  ],
  stats: [
    { label: '消息', value: '2 条', hint: '用户 1 / Bot 1' },
    { label: '活跃 Bot', value: '1 个' },
    { label: '例行任务', value: '1 条' },
  ],
  highlights: [
    { time: '09:40', title: '调度器接上期刊检查', text: '窗口判定通过后自动生成昨日期刊。', botName: 'Seeker' },
  ],
  imagePrompt: 'editorial illustration, warm desk lamp over a newspaper layout, 16:9, muted ink tones',
}
const GOOD_TEXT = JSON.stringify(GOOD_JOURNAL)

const routes = []
/** 最近一次 llm.stream 的入参：断言「模型路由 / 提示词 / 采样参数」用。 */
let lastLlmOptions = null
/** llm.stream 的脚本队列：每次调用 shift 一个数组（按顺序 yield text-delta）。 */
const llmQueue = []

function splitChunks(text, size = 80) {
  const chunks = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

const llm = {
  listProviders: () => [{ id: 'alymagpie' }],
  listModels: async () => [{ id: 'auto/deepseek-v4.1-flash' }],
  listConfigurableProviders: () => [{ provider: 'sensenova', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'sensenova'] }],
  stream: async function* (options) {
    lastLlmOptions = options
    const script = llmQueue.shift()
    if (script === undefined) throw new Error('测试没有为这次 llm.stream 准备响应')
    for (const delta of script) {
      yield { type: 'text-delta', index: 0, text: delta }
    }
  },
}

const ctx = {
  inject(_deps, cb) { cb(ctx) },
  effect(fn) { fn(); return () => {} },
  webServer: {
    register(route) { routes.push(route); return () => {} },
  },
  get(name) {
    if (name === 'llm') return llm
    if (name === 'credentials') return ctx.credentials
    if (name === 'agentDefaultModel') return ctx.agentDefaultModel
    return undefined
  },
  credentials: { resolve: async () => ({ value: 'test-key' }) },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  },
  settings: {
    get(ns) {
      if (ns === 'model-capabilities') {
        // 生图网关指向必然连不上的本地端口：验证「生图失败不阻塞期刊生成」
        return { imageActive: 'sensenova/sensenova-u1.5-lite', imagePath: 'images/generations' }
      }
      return { providers: { sensenova: { baseURL: 'http://127.0.0.1:9', apiKeyEnv: 'SENSENOVA_API_KEY' } } }
    },
  },
  llm,
}
applyPersonalAgentHost(ctx)

const route = routes.find((item) => item.path === '/api/personal-agent')
if (route === undefined) throw new Error('personal-agent route not registered')

function request(url, method, body, headers = {}) {
  return new Promise((resolve) => {
    const req = {
      url,
      method,
      headers,
      on(event, handler) {
        if (event === 'data') handler(Buffer.from(JSON.stringify(body ?? {})))
        if (event === 'end') handler()
      },
      destroy() {},
    }
    let status = 0
    const responseHeaders = {}
    const res = {
      set statusCode(value) { status = value },
      get statusCode() { return status },
      setHeader(name, value) { responseHeaders[String(name).toLowerCase()] = String(value) },
      end(chunk) {
        const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
        resolve({ status, text: payload.toString('utf8'), body: payload, headers: responseHeaders })
      },
    }
    void route.handler(req, res)
  })
}

function jsonOf(response) {
  try {
    return JSON.parse(response.text)
  } catch {
    throw new Error(`响应不是 JSON（${response.status}）：${response.text.slice(0, 200)}`)
  }
}

/** 一期期刊的素材投影（真实对话形状）。 */
function feedMessages(now = Date.now()) {
  return [
    { id: 'm1', role: 'user', at: now - 3_600_000, text: '把期刊生成搬到宿主，页面关掉也要能跑。' },
    { id: 'm2', role: 'bot', botId: 'main', botName: 'Seeker', at: now - 3_500_000, text: '已经接上调度器，30 秒 tick 一次。' },
  ]
}

const FEED_STATS = {
  messages: 2,
  userMessages: 1,
  botMessages: 1,
  activeBots: 1,
  memories: 0,
  routines: 1,
}

/* ───────────────────── GET /journal/list：初始为空 ───────────────────── */

const initialList = await request('/api/personal-agent/journal/list', 'GET')
if (initialList.status === 404) {
  throw new Error('lib/index.js 还是旧构建产物（没有 journal 路由）：请先 node build.mjs 再跑本测试')
}
const initialJson = jsonOf(initialList)
if (initialList.status !== 200 || initialJson.ok !== true || !Array.isArray(initialJson.journals) || initialJson.journals.length !== 0) {
  throw new Error(`/journal/list 初始应为空，实际 ${initialList.status} ${initialList.text.slice(0, 200)}`)
}
console.log('✓ /journal/list 初始为空')

/* ───────────────────── POST /journal/generate：真实生成 ───────────────────── */

llmQueue.push(splitChunks(GOOD_TEXT))
const generate = await request('/api/personal-agent/journal/generate', 'POST', {
  botId: 'main',
  botName: 'Seeker',
  botRole: '主助手',
  botModel: { provider: 'test-provider', model: 'test-model' },
  date: '2026-10-20',
  messages: feedMessages(),
  stats: FEED_STATS,
})
const generateJson = jsonOf(generate)
if (generate.status !== 200 || generateJson.ok !== true || generateJson.journal === undefined) {
  throw new Error(`/journal/generate 应成功，实际 ${generate.status} ${generate.text.slice(0, 300)}`)
}
const journal = generateJson.journal
if (!/^journal-2026-10-20-[0-9a-f]{8}$/.test(String(journal.id))) {
  throw new Error(`期刊 id 形状不对：${String(journal.id)}`)
}
if (journal.botId !== 'main' || journal.date !== '2026-10-20') {
  throw new Error(`期刊 botId/date 不对：${journal.botId} ${journal.date}`)
}
if (journal.dateLabel !== '2026 年 10 月 20 日') throw new Error(`dateLabel 不对：${journal.dateLabel}`)
if (journal.issue !== 'No. 001') throw new Error(`第一期 issue 应为 No. 001，实际 ${journal.issue}`)
if (journal.origin !== 'host') throw new Error(`origin 应为 host，实际 ${String(journal.origin)}`)
if (journal.model !== 'test-provider/test-model') throw new Error(`model 应为 test-provider/test-model，实际 ${String(journal.model)}`)
if (journal.auto !== false) throw new Error('手动生成的 auto 应为 false')
if (journal.title !== GOOD_JOURNAL.title) throw new Error(`title 未按模型输出，实际 ${journal.title}`)
if (journal.sections.length !== 3) throw new Error(`sections 应有 3 节，实际 ${journal.sections.length}`)
if (!Array.isArray(journal.stats) || journal.stats.length !== 3) throw new Error(`stats 应有 3 个，实际 ${JSON.stringify(journal.stats)}`)
if (!Array.isArray(journal.highlights) || journal.highlights.length !== 1) throw new Error(`highlights 应有 1 个，实际 ${JSON.stringify(journal.highlights)}`)
if (journal.imagePrompt !== GOOD_JOURNAL.imagePrompt) throw new Error('imagePrompt 应原样保留（重试补图要用）')
if (journal.image !== undefined) throw new Error('生图网关不可达时 image 应留空（封面失败不能阻塞期刊）')
console.log('✓ /journal/generate：模型生成 → 清洗 → 返回 journal（封面失败不阻塞）')

// 模型路由与提示词必须按契约走
if (lastLlmOptions?.provider !== 'test-provider' || lastLlmOptions?.model !== 'test-model') {
  throw new Error(`botModel 未生效：${String(lastLlmOptions?.provider)}/${String(lastLlmOptions?.model)}`)
}
if (lastLlmOptions?.maxTokens !== 3000 || lastLlmOptions?.temperature !== 0.6) {
  throw new Error(`采样参数不对：maxTokens=${String(lastLlmOptions?.maxTokens)} temperature=${String(lastLlmOptions?.temperature)}`)
}
if (lastLlmOptions?.signal === undefined) throw new Error('llm.stream 必须带 AbortSignal（90s 超时用）')
const systemText = String(lastLlmOptions?.system ?? '')
if (!systemText.includes('资深中文杂志编辑') || !systemText.includes('不得编造')) {
  throw new Error('system 提示词缺少编辑身份 / 反编造约束')
}
const userText = String(lastLlmOptions?.messages?.[0]?.content?.[0]?.text ?? '')
if (!userText.includes('2026-10-20') || !userText.includes('请只输出 JSON')) {
  throw new Error(`user 提示词缺少日期或输出要求：${userText.slice(0, 200)}`)
}
if (!userText.includes('把期刊生成搬到宿主')) throw new Error('当天素材没有进 user 提示词')
console.log('✓ 模型路由（botModel 优先）、system/user 提示词、采样参数符合契约')

// 持久化：一期一个 JSON，id 就是文件名
const journalFile = join(JOURNALS_DIR, `${journal.id}.json`)
if (!existsSync(journalFile)) throw new Error(`期刊没有落盘：${journalFile}`)
const persisted = JSON.parse(readFileSync(journalFile, 'utf8'))
if (persisted.title !== journal.title || persisted.date !== journal.date) {
  throw new Error('落盘内容与返回的 journal 不一致')
}
console.log('✓ 期刊已落盘到 journals/<id>.json')

/* ───────────────────── GET /journal/list：1 条 ───────────────────── */

const listAfter = jsonOf(await request('/api/personal-agent/journal/list', 'GET'))
if (listAfter.journals.length !== 1 || listAfter.journals[0].id !== journal.id) {
  throw new Error(`/journal/list 应有 1 条且为刚生成的期刊，实际 ${JSON.stringify(listAfter.journals.map((item) => item.id))}`)
}
console.log('✓ /journal/list 回读到 1 条（按 generatedAt 倒序）')

/* ───────────────────── GET /journal/status ───────────────────── */

const status = jsonOf(await request('/api/personal-agent/journal/status', 'GET'))
if (status.ok !== true || status.generating !== false) {
  throw new Error(`/journal/status 形状不对：${JSON.stringify(status).slice(0, 200)}`)
}
if (status.rule?.enabled !== false) throw new Error('status.rule 应回读预置的「未启用」规则')
if (!Array.isArray(status.logs)) throw new Error('status.logs 应为数组')
if (typeof status.lastGeneratedAt !== 'number' || status.lastGeneratedAt !== journal.generatedAt) {
  throw new Error(`status.lastGeneratedAt 应等于最近一期 generatedAt，实际 ${String(status.lastGeneratedAt)}`)
}
console.log('✓ /journal/status：rule / logs / generating / lastGeneratedAt')

/* ───────────────────── POST /journal/rule ───────────────────── */

const ruleSave = await request('/api/personal-agent/journal/rule', 'POST', {
  rule: { enabled: true, startHour: 2, endHour: 6, idleMinutes: 45 },
  lastUserMessageAt: Date.now() - 3_600_000,
})
if (ruleSave.status !== 200 || jsonOf(ruleSave).ok !== true) {
  throw new Error(`/journal/rule 保存失败：${ruleSave.status} ${ruleSave.text.slice(0, 200)}`)
}
const statusAfterRule = jsonOf(await request('/api/personal-agent/journal/status', 'GET'))
if (statusAfterRule.rule.startHour !== 2 || statusAfterRule.rule.endHour !== 6
  || statusAfterRule.rule.idleMinutes !== 45 || statusAfterRule.rule.enabled !== true) {
  throw new Error(`规则未按预期保存：${JSON.stringify(statusAfterRule.rule)}`)
}
// 不带 lastUserMessageAt 再存一次：必须保留旧值（否则「静默」判定会失真）
const beforeRuleFile = JSON.parse(readFileSync(join(DATA_DIR, 'journal-rule.json'), 'utf8'))
await request('/api/personal-agent/journal/rule', 'POST', { rule: { enabled: true, startHour: 2, endHour: 6, idleMinutes: 45 } })
const afterRuleFile = JSON.parse(readFileSync(join(DATA_DIR, 'journal-rule.json'), 'utf8'))
if (afterRuleFile.lastUserMessageAt !== beforeRuleFile.lastUserMessageAt) {
  throw new Error('再次保存规则时不应清空 lastUserMessageAt')
}
console.log('✓ /journal/rule：保存、回读、保留 lastUserMessageAt')

/* ───────────────────── POST /journal/feed：48h 裁剪 ───────────────────── */

const now = Date.now()
const feedSave = await request('/api/personal-agent/journal/feed', 'POST', {
  messages: [
    { role: 'user', at: now - 3 * 86_400_000, text: '三天前的老消息（应被裁掉）' },
    { role: 'user', at: now - 60_000, text: '最近的用户消息' },
    { role: 'bot', botName: 'Seeker', at: now - 30_000, text: '最近的 Bot 回复' },
  ],
  stats: FEED_STATS,
  lastUserMessageAt: now - 60_000,
})
if (feedSave.status !== 200 || jsonOf(feedSave).ok !== true) {
  throw new Error(`/journal/feed 保存失败：${feedSave.status} ${feedSave.text.slice(0, 200)}`)
}
const feedFile = join(DATA_DIR, 'journal-feed.json')
if (!existsSync(feedFile)) throw new Error('journal-feed.json 没有落盘')
const feedRaw = JSON.parse(readFileSync(feedFile, 'utf8'))
if (feedRaw.messages.length !== 2) {
  throw new Error(`素材应只保留 48h 内的 2 条，实际 ${feedRaw.messages.length}`)
}
if (feedRaw.messages.some((message) => String(message.text).includes('三天前'))) {
  throw new Error('超过 48h 的素材没有被裁掉')
}
if (feedRaw.lastUserMessageAt !== now - 60_000) {
  throw new Error(`lastUserMessageAt 未原样保存：${String(feedRaw.lastUserMessageAt)}`)
}
console.log('✓ /journal/feed：保存、48h 裁剪、lastUserMessageAt')

/* ───────────────────── 坏 JSON → 502 可读错误 ───────────────────── */

llmQueue.push(['这不是 JSON，', '也 没有花括号。'])
const bad = await request('/api/personal-agent/journal/generate', 'POST', {
  botId: 'main',
  date: '2026-10-21',
  messages: feedMessages(),
})
const badJson = jsonOf(bad)
if (bad.status !== 502 || badJson.ok !== false) {
  throw new Error(`坏 JSON 应 502 + ok:false，实际 ${bad.status} ${bad.text.slice(0, 200)}`)
}
if (!String(badJson.error ?? '').includes('JSON')) {
  throw new Error(`坏 JSON 的错误应可读（提到 JSON），实际：${String(badJson.error)}`)
}
// 没传 botModel：回退到 agentDefaultModel.currentSelection()
if (lastLlmOptions?.provider !== 'default-provider' || lastLlmOptions?.model !== 'default-model') {
  throw new Error(`模型回退链不对：${String(lastLlmOptions?.provider)}/${String(lastLlmOptions?.model)}`)
}
if (existsSync(join(JOURNALS_DIR, 'journal-2026-10-21.json'))) {
  throw new Error('解析失败时不应写出任何期刊文件')
}
console.log('✓ 坏 JSON → 502 可读错误；未指定模型时回退 agentDefaultModel')

/* ───────────────────── 没有可用模型 → 明确报错 ───────────────────── */

const savedProviders = llm.listProviders
const savedModels = llm.listModels
const savedDefault = ctx.agentDefaultModel
llm.listProviders = () => []
llm.listModels = async () => []
ctx.agentDefaultModel = { currentSelection: () => undefined }
const noModel = await request('/api/personal-agent/journal/generate', 'POST', {
  botId: 'main',
  messages: feedMessages(),
})
const noModelJson = jsonOf(noModel)
if (noModel.status !== 502 || !String(noModelJson.error ?? '').includes('未配置可用的聊天模型')) {
  throw new Error(`无可用模型时应明确报错，实际 ${noModel.status} ${noModel.text.slice(0, 200)}`)
}
llm.listProviders = savedProviders
llm.listModels = savedModels
ctx.agentDefaultModel = savedDefault
console.log('✓ 无可用模型 → 502「未配置可用的聊天模型」（不静默降级）')

/* ───────────────────── POST /journal/check：规则判定 ───────────────────── */

/*
 * 选一个**真实当前小时不在其中**的 4 小时窗口，避免调度器的 5 秒补跑在测试
 * 过程中也命中窗口去生成期刊（真实小时落在窗口内时，tick 会走和这里一样的判定）。
 */
const realHour = new Date().getHours()
const windowStart = realHour < 6 ? 12 : 2
const windowEnd = windowStart + 4
const checkNow = new Date()
checkNow.setHours(windowStart + 1, 0, 0, 0)
const checkNowMs = checkNow.getTime()
/** 目标日期 = 本地时区的「昨天」。 */
const targetDay = new Date(checkNowMs - 86_400_000)
const targetDate = `${targetDay.getFullYear()}-${String(targetDay.getMonth() + 1).padStart(2, '0')}-${String(targetDay.getDate()).padStart(2, '0')}`

await request('/api/personal-agent/journal/rule', 'POST', {
  rule: { enabled: true, startHour: windowStart, endHour: windowEnd, idleMinutes: 45 },
  lastUserMessageAt: checkNowMs - 90 * 60_000,
})
// 素材要落在目标日附近：用户静默 90 分钟（> 45 分钟）
await request('/api/personal-agent/journal/feed', 'POST', {
  messages: [
    { id: 'n1', role: 'user', at: checkNowMs - 90 * 60_000, text: '昨天的对话：确认期刊要由宿主生成。' },
    { id: 'n2', role: 'bot', botId: 'main', botName: 'Seeker', at: checkNowMs - 80 * 60_000, text: '好，调度器已经就位。' },
  ],
  stats: FEED_STATS,
  lastUserMessageAt: checkNowMs - 90 * 60_000,
})

llmQueue.push(splitChunks(GOOD_TEXT))
const check = await request('/api/personal-agent/journal/check', 'POST', { now: checkNowMs })
const checkJson = jsonOf(check)
if (check.status !== 200 || checkJson.ok !== true) {
  throw new Error(`/journal/check 应满足规则并生成，实际 ${check.status} ${check.text.slice(0, 300)}`)
}
if (!String(checkJson.reason ?? '').includes('已生成')) throw new Error(`check.reason 不对：${String(checkJson.reason)}`)
if (typeof checkJson.journalId !== 'string' || !checkJson.journalId.startsWith('journal-')) {
  throw new Error(`check.journalId 缺失：${String(checkJson.journalId)}`)
}
const autoFile = join(JOURNALS_DIR, `${checkJson.journalId}.json`)
if (!existsSync(autoFile)) throw new Error(`调度生成的期刊没有落盘：${autoFile}`)
const autoJournal = JSON.parse(readFileSync(autoFile, 'utf8'))
if (autoJournal.date !== targetDate) {
  throw new Error(`调度生成的目标日期应为本地「昨天」${targetDate}，实际 ${autoJournal.date}`)
}
if (autoJournal.auto !== true) throw new Error('调度生成的 auto 应为 true')
if (autoJournal.botId !== 'main') throw new Error(`调度生成的 botId 应为 main，实际 ${autoJournal.botId}`)
console.log(`✓ /journal/check：窗口/静默/昨日无记录 → 自动生成 ${targetDate}（auto=true）`)

// 日志要记一笔成功
const statusAfterCheck = jsonOf(await request('/api/personal-agent/journal/status', 'GET'))
if (!Array.isArray(statusAfterCheck.logs) || statusAfterCheck.logs.length === 0) {
  throw new Error('触发后应写一条日志')
}
if (statusAfterCheck.logs[0].ok !== true || statusAfterCheck.logs[0].journalId !== checkJson.journalId) {
  throw new Error(`最新日志应为成功且带 journalId，实际 ${JSON.stringify(statusAfterCheck.logs[0])}`)
}
console.log('✓ 触发日志：ok=true + journalId（最新在前）')

// 再 check 一次：昨日已有期刊 → 不重复生成（也不消耗 llm 队列）
const checkAgain = await request('/api/personal-agent/journal/check', 'POST', { now: checkNowMs })
const checkAgainJson = jsonOf(checkAgain)
if (checkAgainJson.ok !== false || !String(checkAgainJson.reason ?? '').includes('已生成')) {
  throw new Error(`重复 check 应报「已生成」，实际 ${checkAgain.text.slice(0, 200)}`)
}
console.log('✓ 重复 check：昨日已有期刊 → 不再生成')

/* ───────────────────── DELETE /journal?id= ───────────────────── */

const remove = await request(`/api/personal-agent/journal?id=${encodeURIComponent(journal.id)}`, 'DELETE')
if (remove.status !== 200 || jsonOf(remove).ok !== true) {
  throw new Error(`DELETE /journal 失败：${remove.status} ${remove.text.slice(0, 200)}`)
}
if (existsSync(journalFile)) throw new Error('删除期刊后记录文件仍存在')
const listAfterDelete = jsonOf(await request('/api/personal-agent/journal/list', 'GET'))
if (listAfterDelete.journals.length !== 1 || listAfterDelete.journals[0].id !== checkJson.journalId) {
  throw new Error(`删除后应只剩调度生成的那期，实际 ${JSON.stringify(listAfterDelete.journals.map((item) => item.id))}`)
}
const removeMissing = await request('/api/personal-agent/journal?id=journal-does-not-exist', 'DELETE')
if (removeMissing.status !== 404) throw new Error(`删除不存在的期刊应 404，实际 ${removeMissing.status}`)
console.log('✓ DELETE /journal：删除记录与文件、不存在 404')

/* ───────────────────── 跨站写拒绝 / 旧路由保留 ───────────────────── */

const cross = await request('/api/personal-agent/journal/generate', 'POST', {}, {
  origin: 'http://evil.test',
  host: '127.0.0.1:3080',
})
if (cross.status !== 403) throw new Error(`跨站写请求应 403，实际 ${cross.status}`)
console.log('✓ 跨站写请求被拒绝（403）')

// /journal/image 路由保留：生图网关不可达 → 502 + ok:false（不是 404）
const image = await request('/api/personal-agent/journal/image', 'POST', { prompt: '一只戴墨镜的猫' })
const imageJson = jsonOf(image)
if (image.status !== 502 || imageJson.ok !== false || String(imageJson.error ?? '') === '') {
  throw new Error(`/journal/image 应保留且返回可读失败，实际 ${image.status} ${image.text.slice(0, 200)}`)
}
console.log('✓ /journal/image 路由保留（生图不可达 → 502 可读错误）')

// /journal/asset 路由保留：非法 / 不存在的文件名
const badAsset = await request('/api/personal-agent/journal/asset?name=../evil.png', 'GET')
if (badAsset.status !== 400) throw new Error(`/journal/asset 非法文件名应 400，实际 ${badAsset.status}`)
const missingAsset = await request('/api/personal-agent/journal/asset?name=missing.png', 'GET')
if (missingAsset.status !== 404) throw new Error(`/journal/asset 不存在的文件应 404，实际 ${missingAsset.status}`)
console.log('✓ /journal/asset 路由保留（非法名 400、不存在 404）')

/* ───────────────────── 落盘文件清单 ───────────────────── */

for (const file of [join(DATA_DIR, 'journal-rule.json'), feedFile, join(DATA_DIR, 'journal-logs.json')]) {
  if (!existsSync(file)) throw new Error(`持久化文件缺失：${file}`)
}
console.log('✓ 持久化文件齐全：journal-rule.json / journal-feed.json / journal-logs.json')

console.log('[personal-journal host] PASS')
