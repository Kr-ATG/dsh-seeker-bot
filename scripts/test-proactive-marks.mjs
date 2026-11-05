/**
 * dsh-seeker-bot — 主动消息「提醒标记」回归测试（纯 Node ESM）。
 *
 * 背景：主动消息（source='proactive'）的「主动消息」标签后新增标记控件，
 * 用户可标记「继续提醒 / 不再提醒」，宿主持久化并在下一次主动询问时注入提示词。
 *
 * 分四层：
 *   1. 宿主源码：ProactiveMark 类型、读写/upsert/build 函数、runProactiveNow 注入；
 *   2. 客户端源码：Message.proactiveMark、setProactiveMark、ProactiveMarkButton、样式与图标；
 *   3. 宿主行为：fake ctx 挂载 applyPersonalAgentHost，走 GET/POST /proactive/marks；
 *   4. 构建产物：lib/index.js 与 lib/client.js 含新能力关键字。
 *
 * Usage: node scripts/test-proactive-marks.mjs（需先 npm run build）
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
const check = (condition, message) => {
  if (condition) console.log('ok    ' + message)
  else {
    failed += 1
    console.error('FAIL  ' + message)
  }
}
const readText = (relative) => readFileSync(join(ROOT, relative), 'utf8')

// ── 1. 宿主源码 ─────────────────────────────────────────────────────────────
console.log('\n── 宿主源码 src/host/personal/scheduler.ts ──')
const schedulerSrc = readText('src/host/personal/scheduler.ts')
check(/export interface ProactiveMark\s*\{/.test(schedulerSrc), '声明 ProactiveMark 接口')
check(/export interface HostProactiveMarkStore\s*\{/.test(schedulerSrc), '声明 HostProactiveMarkStore 接口')
check(/export function readProactiveMarks\s*\(/.test(schedulerSrc), '导出 readProactiveMarks')
check(/export function writeProactiveMarks\s*\(/.test(schedulerSrc), '导出 writeProactiveMarks')
check(/export function upsertProactiveMark\s*\(/.test(schedulerSrc), '导出 upsertProactiveMark')
check(/export function buildProactiveMarksBlock\s*\(/.test(schedulerSrc), '导出 buildProactiveMarksBlock')
check(schedulerSrc.includes('proactive-marks.json'), '落盘文件名为 proactive-marks.json')
check(schedulerSrc.includes('buildProactiveMarksBlock(config.botId)'), 'runProactiveNow 调用 buildProactiveMarksBlock(config.botId) 注入提示词')
check(schedulerSrc.includes("kind: 'keep' | 'mute'"), 'ProactiveMark.kind 只允许 keep / mute')
check(schedulerSrc.includes('不要当成已解决') && schedulerSrc.includes('不要再提起'), '提示词块包含 keep / mute 的明确执行指令')

const hostIndexSrc = readText('src/host/personal/index.ts')
check(hostIndexSrc.includes("'/proactive/marks'"), 'index.ts 注册 /proactive/marks 路由')
check(hostIndexSrc.includes('readProactiveMarks'), 'index.ts 引入 readProactiveMarks')
check(hostIndexSrc.includes('upsertProactiveMark'), 'index.ts 引入 upsertProactiveMark')

// ── 2. 客户端源码 ───────────────────────────────────────────────────────────
console.log('\n── 客户端源码 ──')
const typesSrc = readText('src/client/personal/types.ts')
const storeSrc = readText('src/client/personal/store.tsx')
const listSrc = readText('src/client/personal/chat/MessageList.tsx')
const chatCssSrc = readText('src/client/personal/chat/chat.css.ts')
const iconsSrc = readText('src/client/personal/icons.tsx')

check(/export type ProactiveMarkKind\s*=\s*'keep'\s*\|\s*'mute'/.test(typesSrc), 'types.ts 声明 ProactiveMarkKind')
check(/proactiveMark\?:\s*ProactiveMarkKind/.test(typesSrc), 'Message 增加 proactiveMark 字段')
check(/proactiveMarkAt\?:\s*number/.test(typesSrc), 'Message 增加 proactiveMarkAt 字段')
check(storeSrc.includes('setProactiveMark'), 'store.tsx 声明并挂载 setProactiveMark')
check(storeSrc.includes('/api/personal-agent/proactive/marks'), 'store.tsx 调用 /proactive/marks 接口')
check(listSrc.includes('ProactiveMarkButton'), 'MessageList 渲染 ProactiveMarkButton')
check(listSrc.includes("message.source === 'proactive'"), '标记按钮只在 proactive 消息出现')
check(chatCssSrc.includes('.pa-msg__mark'), 'chat.css.ts 提供 .pa-msg__mark 样式')
check(/export function IconBell\b/.test(iconsSrc), 'icons.tsx 提供 IconBell')
check(/export function IconBellOff\b/.test(iconsSrc), 'icons.tsx 提供 IconBellOff')

// ── 3. 宿主路由行为 ─────────────────────────────────────────────────────────
console.log('\n── 宿主路由行为 /api/personal-agent/proactive/marks ──')
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pa-marks-test-'))
process.env.DSH_SEEKER_BOT_WORKSPACE = mkdtempSync(join(tmpdir(), 'pa-marks-workspace-'))

const routes = []
const ctx = {
  inject(_deps, cb) { cb(ctx) },
  effect(fn) { fn(); return () => {} },
  webServer: { register(route) { routes.push(route); return () => {} } },
  get(name) {
    if (name === 'credentials') return ctx.credentials
    if (name === 'llm') return ctx.llm
    return undefined
  },
  logger: { info() {}, warn() {}, error() {} },
  credentials: { resolve: async () => ({ value: 'test-key' }) },
  settings: { get: () => ({}) },
  llm: {
    listProviders: () => [],
    listModels: async () => [],
    listConfigurableProviders: () => [],
    resolveModelInfo: async () => { throw new Error('not needed') },
    stream: async function* () { yield { type: 'text-delta', index: 0, text: '' } },
  },
  speechController: { transcribe: async () => ({ text: '' }) },
}

let route
try {
  const { applyPersonalAgentHost } = await import('../lib/index.js')
  applyPersonalAgentHost(ctx)
  route = routes.find((item) => item.path === '/api/personal-agent')
  check(route !== undefined, 'applyPersonalAgentHost 注册了 /api/personal-agent 路由')
} catch (error) {
  failed += 1
  console.error('FAIL  无法加载 lib/index.js（先 npm run build）：' + error.message)
}

function request(url, method, body, headers = {}) {
  return new Promise((resolveFn) => {
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
    const res = {
      set statusCode(value) { status = value },
      get statusCode() { return status },
      setHeader() {},
      end(chunk) {
        const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
        resolveFn({ status, text: payload.toString('utf8') })
      },
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      failed += 1
      console.error('FAIL  路由执行异常：' + error.message)
      resolveFn({ status: 500, text: '{}' })
    })
  })
}

const parse = (response) => {
  try { return JSON.parse(response.text) } catch { return null }
}

if (route !== undefined) {
  const empty = await request('/api/personal-agent/proactive/marks?botId=bot-test', 'GET')
  check(empty.status === 200 && Array.isArray(parse(empty)?.marks) && parse(empty).marks.length === 0, 'GET 空标记返回 { ok: true, marks: [] }')

  const keep = await request('/api/personal-agent/proactive/marks', 'POST', {
    botId: 'bot-test',
    messageId: 'm-mark-1',
    text: '商汤 Raccoon 访问凭证 12 月 2 日到期，记得续期。',
    kind: 'keep',
  })
  const keepBody = parse(keep)
  check(keep.status === 200 && keepBody?.ok === true && Array.isArray(keepBody.marks) && keepBody.marks.length === 1, 'POST keep 返回 1 条标记')
  check(keepBody?.marks?.[0]?.messageId === 'm-mark-1' && keepBody?.marks?.[0]?.kind === 'keep', 'POST keep 的 messageId / kind 正确')
  check(keepBody?.marks?.[0]?.text?.includes('Raccoon'), 'POST keep 保留提醒正文摘要')

  const mute = await request('/api/personal-agent/proactive/marks', 'POST', {
    botId: 'bot-test',
    messageId: 'm-mark-1',
    kind: 'mute',
  })
  const muteBody = parse(mute)
  check(mute.status === 200 && muteBody?.marks?.length === 1 && muteBody?.marks?.[0]?.kind === 'mute', '同一 messageId 改标记为 mute 是覆盖而不是新增')
  check(muteBody?.marks?.[0]?.text?.includes('Raccoon'), '覆盖时缺省 text 保留旧正文')

  const listed = await request('/api/personal-agent/proactive/marks?botId=bot-test', 'GET')
  check(parse(listed)?.marks?.[0]?.kind === 'mute', 'GET 能读回已保存的标记')

  const other = await request('/api/personal-agent/proactive/marks?botId=bot-other', 'GET')
  check(parse(other)?.marks?.length === 0, '标记按 botId 隔离')

  const cleared = await request('/api/personal-agent/proactive/marks', 'POST', {
    botId: 'bot-test',
    messageId: 'm-mark-1',
    kind: null,
  })
  check(parse(cleared)?.marks?.length === 0, 'kind=null 清除该标记')

  const badKind = await request('/api/personal-agent/proactive/marks', 'POST', {
    botId: 'bot-test', messageId: 'm-mark-2', kind: 'maybe',
  })
  check(badKind.status === 400, '非法 kind 返回 400')

  const missingBot = await request('/api/personal-agent/proactive/marks', 'POST', { messageId: 'm-mark-3', kind: 'keep' })
  check(missingBot.status === 400, '缺 botId 返回 400')

  const missingMessage = await request('/api/personal-agent/proactive/marks', 'POST', { botId: 'bot-test', kind: 'keep' })
  check(missingMessage.status === 400, '缺 messageId 返回 400')

  const marksFile = join(process.env.DSH_HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'proactive-marks.json')
  check(readFileSync(marksFile, 'utf8').includes('bot-test'), '标记已落盘到 proactive-marks.json')
}

// ── 4. 构建产物 ─────────────────────────────────────────────────────────────
console.log('\n── 构建产物 ──')
try {
  const hostBundle = readText('lib/index.js')
  check(hostBundle.includes('proactive-marks.json'), 'lib/index.js 含 proactive-marks.json')
  check(hostBundle.includes('buildProactiveMarksBlock'), 'lib/index.js 含 buildProactiveMarksBlock')
  const clientBundle = readText('lib/client.js')
  check(clientBundle.includes('pa-msg__mark'), 'lib/client.js 含 .pa-msg__mark 样式')
  check(clientBundle.includes('setProactiveMark'), 'lib/client.js 含 setProactiveMark')
} catch (error) {
  failed += 1
  console.error('FAIL  读取构建产物失败：' + error.message)
}

console.log('')
if (failed > 0) {
  console.error('test-proactive-marks: ' + failed + ' 项失败')
  process.exit(1)
}
console.log('test-proactive-marks: 全部通过')
