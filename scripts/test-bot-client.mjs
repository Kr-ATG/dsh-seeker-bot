/**
 * dsh-seeker-bot — Bot 控制台前端回归测试（scripts/test-bot-client.mjs）。
 *
 * 不启动浏览器：用最小 DOM 桩在 node 里跑真源码（esbuild 现场打包）。
 * 覆盖：
 *  1. renderRoster 重复调用只写一次 DOM；
 *  2. MutationObserver 回调刷 100 次也不产生额外渲染（本次死循环的回归）；
 *  3. 名册分组 / 注意力角标 / 主 Bot 星标；
 *  4. 抽屉字段表与 PATCH / POST 载荷拼接；
 *  5. 右栏面板空数据时只有画面，没有标题 / 说明 / 终端文字。
 *
 * Usage: node scripts/test-bot-client.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-seeker-bot-client-'))

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok   ' + name)
    return
  }
  failed += 1
  console.error('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
}

/* ── 最小 DOM 桩 ─────────────────────────────────────────────────────── */

class StubElement {
  constructor(doc, tag) {
    this.ownerDocument = doc
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    this.style = {}
    this.dataset = {}
    this.attributes = new Map()
    this.listeners = new Map()
    this.id = ''
    this.value = ''
    this.checked = false
    this.disabled = false
    this.hidden = false
    this.type = ''
    this.placeholder = ''
    this.rows = 0
    this.title = ''
    this._className = ''
    this._textContent = ''
    this._innerHTML = ''
    this.innerHTMLWrites = 0
  }
  get className() { return this._className }
  set className(value) { this._className = String(value) }
  get textContent() { return this._textContent }
  set textContent(value) {
    this._textContent = String(value)
    this.children = []
  }
  get innerHTML() { return this._innerHTML }
  set innerHTML(value) {
    this._innerHTML = String(value)
    this.children = []
    this.innerHTMLWrites += 1
  }
  appendChild(child) {
    if (child.parentElement !== null) child.remove()
    child.parentElement = this
    this.children.push(child)
    return child
  }
  insertBefore(node, reference) {
    if (node.parentElement !== null) node.remove()
    const index = this.children.indexOf(reference)
    node.parentElement = this
    if (index < 0) this.children.push(node)
    else this.children.splice(index, 0, node)
    return node
  }
  remove() {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
  }
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value))
    if (name === 'id') this.id = String(value)
    if (name === 'class') this.className = String(value)
  }
  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null
  }
  hasAttribute(name) { return this.attributes.has(String(name)) }
  removeAttribute(name) { this.attributes.delete(String(name)) }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter((item) => item !== listener))
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  click() {
    this.dispatch('click', { preventDefault() {}, stopPropagation() {}, button: 0 })
  }
  focus() {}
  get parentNode() { return this.parentElement }
  get isConnected() {
    let node = this
    while (node !== null) {
      if (node === this.ownerDocument.documentElement) return true
      node = node.parentElement
    }
    return false
  }
  get nextSibling() {
    if (this.parentElement === null) return null
    const index = this.parentElement.children.indexOf(this)
    return this.parentElement.children[index + 1] ?? null
  }
  get nextElementSibling() { return this.nextSibling }
  compareDocumentPosition(other) {
    const all = this.ownerDocument.allElements()
    const a = all.indexOf(this)
    const b = all.indexOf(other)
    if (a < 0 || b < 0 || a === b) return 0
    return a < b ? 4 : 2
  }
  querySelector(selector) { return this.ownerDocument.querySelectorFrom(this, selector) }
  querySelectorAll(selector) { return this.ownerDocument.querySelectorAllFrom(this, selector) }
  getBoundingClientRect() { return { width: 0, height: 0, right: 0, left: 0, top: 0, bottom: 0 } }
}

function matches(element, selector) {
  if (selector.startsWith('.')) return String(element.className).split(/\s+/).includes(selector.slice(1))
  const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector)
  if (attr !== null) {
    if (!element.hasAttribute(attr[1])) return false
    return attr[2] === undefined || element.getAttribute(attr[1]) === attr[2]
  }
  return element.tagName === selector.toUpperCase()
}

class StubDocument {
  constructor() {
    this.documentElement = new StubElement(this, 'html')
    this.head = new StubElement(this, 'head')
    this.body = new StubElement(this, 'body')
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.hidden = false
    this.listeners = new Map()
  }
  createElement(tag) { return new StubElement(this, tag) }
  allElements() {
    const result = []
    const walk = (node) => {
      result.push(node)
      for (const child of node.children) walk(child)
    }
    walk(this.documentElement)
    return result
  }
  getElementById(id) { return this.allElements().find((node) => node.id === String(id)) ?? null }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector) {
    return this.allElements().filter((node) => matches(node, selector))
  }
  querySelectorFrom(root, selector) { return this.querySelectorAllFrom(root, selector)[0] ?? null }
  querySelectorAllFrom(root, selector) {
    const result = []
    const walk = (node) => {
      if (matches(node, selector)) result.push(node)
      for (const child of node.children) walk(child)
    }
    walk(root)
    return result
  }
  contains(node) { return this.allElements().includes(node) }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter((item) => item !== listener))
  }
}

class StubMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.disconnected = false
    StubMutationObserver.last = this
  }
  observe() {}
  disconnect() { this.disconnected = true }
}

/* ── esbuild 打包真源码（每个模块独立打包，测试不复制逻辑） ───────────── */

const { build } = await import(pathToFileURL(resolve(ROOT, 'node_modules/esbuild/lib/main.js')).href)

async function bundle(entry, name, options = {}) {
  const outfile = join(scratch, name)
  await build({
    entryPoints: [resolve(ROOT, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    ...options,
  })
  return pathToFileURL(outfile).href
}

const model = await import(await bundle('src/client/bot/model.ts', 'model.mjs'))

/* ── 1. 纯逻辑：分组 / 角标 / 渲染指纹 ──────────────────────────────── */

console.log('[bot-client] 名册纯逻辑')
{
  const bots = [
    { id: 'a', name: '阿鲸', role: '研究员', pinned: true, primary: true, status: 'working', avatar: { shape: 'whale', color: '#0f1115' } },
    { id: 'b', name: '小轨', role: '设计师', section: '项目', status: 'needs-you', avatar: { shape: 'orbit', color: '#3b82f6' } },
    { id: 'c', name: '叶叶', role: '运营', section: '实验组', status: 'unread', avatar: { shape: 'leaf', color: '#10b981' } },
    { id: 'd', name: '隐藏', role: '测试', hidden: true },
  ]
  const groups = model.groupRoster(bots)
  check('置顶组在最前', groups[0]?.label === '置顶' && groups[0]?.bots.length === 1)
  check('按 section 分组（隐藏的除外）', groups.map((group) => group.label).join(',') === '置顶,项目,实验组')
  check('needs-you → 待处理', model.attentionBadge('needs-you')?.label === '待处理')
  check('unread → 未读', model.attentionBadge('unread')?.label === '未读')
  check('working → 工作中', model.attentionBadge('working')?.label === '工作中')
  check('idle 不出角标', model.attentionBadge('idle') === null)
  const key1 = model.rosterRenderKey({ mode: 'bot', bots, selected: 'a' })
  const key2 = model.rosterRenderKey({ mode: 'bot', bots: bots.map((bot) => ({ ...bot })), selected: 'a' })
  check('渲染指纹对同值对象稳定', key1 === key2)
  check('选中变化会换指纹', key1 !== model.rosterRenderKey({ mode: 'bot', bots, selected: 'b' }))
}

/* ── 2. 抽屉字段表 / 载荷拼接 ───────────────────────────────────────── */

console.log('[bot-client] 详情抽屉载荷')
{
  const bot = {
    id: 'bot-1', name: '小轨', role: '设计师', instructions: '先画再写',
    avatar: { shape: 'orbit', color: '#3b82f6' },
    model: { provider: 'openai', model: 'gpt-5', effort: 'high' },
    proactive: { enabled: true, freq: 'daily', from: '09:00', to: '22:00' },
    output: { charts: true, pages: true },
  }
  const draft = model.drawerDraftOf(bot)
  const patch = model.buildBotPatch({ ...draft, name: ' 小轨 ' })
  check('PATCH 名称 trim', patch.name === '小轨')
  check('PATCH 头像嵌套', patch.avatar.shape === 'orbit' && patch.avatar.color === '#3b82f6')
  check('PATCH 模型嵌套', patch.model.provider === 'openai' && patch.model.model === 'gpt-5' && patch.model.effort === 'high')
  check('PATCH 主动找我嵌套', patch.proactive.enabled === true && patch.proactive.freq === 'daily' && patch.proactive.from === '09:00' && patch.proactive.to === '22:00')
  check('PATCH 产出偏好嵌套', patch.output.charts === true && patch.output.pages === true)
  const created = model.buildCreateBotInput({ name: '新 Bot', role: '岗位', instructions: '', shape: 'spark', color: '#ef4444' })
  check('POST 新建同时带 shape/color 与 avatar', created.shape === 'spark' && created.color === '#ef4444' && created.avatar.shape === 'spark' && created.avatar.color === '#ef4444')
  const labels = model.DRAWER_SECTIONS.flatMap((section) => section.fields.map((field) => field.label))
  const expected = ['名称', '岗位', '指令', '形状', '颜色', '供应商', '模型', '推理强度', '开启', '频率', '时段开始', '时段结束', '图表', '可交互页面']
  check('抽屉字段表完整', expected.every((label) => labels.includes(label)), labels.join('/'))
  const summary = model.drawerFieldSummary(bot)
  const byLabel = Object.fromEntries(summary.map((row) => [row.label, row.value]))
  check('抽屉摘要：模型拼接', byLabel['模型'] === 'openai / gpt-5 / high', byLabel['模型'])
  check('抽屉摘要：头像拼接', byLabel['头像'] === '轨道 · #3b82f6', byLabel['头像'])
  check('抽屉摘要：主动找我拼接', byLabel['主动找我'] === 'daily · 09:00-22:00', byLabel['主动找我'])
  check('抽屉摘要：产出偏好拼接', byLabel['产出偏好'] === '图表、可交互页面', byLabel['产出偏好'])
}

/* ── 3. DOM 桩：renderRoster 只写一次 + 名册渲染 ────────────────────── */

globalThis.document = new StubDocument()
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  confirm: () => true,
}
globalThis.MutationObserver = StubMutationObserver

const roster = await import(await bundle('src/client/bot/roster.ts', 'roster.mjs'))

console.log('[bot-client] renderRoster 幂等')
{
  const container = document.createElement('div')
  const bots = [
    { id: 'a', name: '阿鲸', role: '研究员', pinned: true, primary: true, status: 'working', avatar: { shape: 'whale', color: '#0f1115' } },
    { id: 'b', name: '小轨', role: '设计师', section: '项目', status: 'needs-you', avatar: { shape: 'orbit', color: '#3b82f6' } },
    { id: 'c', name: '叶叶', role: '运营', section: '实验组', status: 'unread', avatar: { shape: 'leaf', color: '#10b981' } },
  ]
  const view = { mode: 'bot', bots, selected: 'a' }
  const handlers = { onSelect() {}, onEdit() {} }
  const first = roster.renderRoster(container, view, handlers)
  const writesAfterFirst = container.innerHTMLWrites
  let changed = 0
  for (let i = 0; i < 100; i += 1) {
    if (roster.renderRoster(container, { ...view, bots: bots.map((bot) => ({ ...bot })) }, handlers)) changed += 1
  }
  check('首次渲染返回 true', first === true)
  check('重复 100 次 renderRoster 不再写 DOM', changed === 0 && container.innerHTMLWrites === writesAfterFirst, 'writes=' + container.innerHTMLWrites)
  check('容器只写一次', writesAfterFirst === 1)
  const sections = container.children.filter((node) => node.className === 'skb-sec').map((node) => node.textContent)
  check('分组标题顺序正确', sections.join(',') === '置顶,项目,实验组', sections.join(','))
  const rows = container.children.filter((node) => String(node.className).includes('skb-row'))
  check('渲染 3 行', rows.length === 3)
  const badges = rows.map((row) => row.children.filter((node) => String(node.className).includes('skb-badge')).map((node) => node.textContent).join('')).filter((text) => text !== '')
  check('三种注意力角标都在', badges.includes('工作中') && badges.includes('待处理') && badges.includes('未读'), badges.join(','))
  const stars = rows.map((row) => row.children.filter((node) => String(node.className).includes('skb-star')).length)
  check('只有主 Bot 有星标', stars.reduce((sum, count) => sum + count, 0) === 1 && stars[0] === 1)
}

/* ── 4. 侧栏控制器：MutationObserver 回调 100 次不额外渲染 ───────────── */

const storeModule = await import(await bundle('src/client/bot/store.ts', 'store.mjs'))
const indexModule = await import(await bundle('src/client/bot/index.ts', 'index.mjs'))

console.log('[bot-client] 侧栏控制器防死循环')
{
  const doc = globalThis.document
  const anchor = doc.createElement('div')
  anchor.setAttribute('data-slot', 'sidebar.workspaces')
  const parent = doc.createElement('div')
  parent.appendChild(anchor)
  doc.body.appendChild(parent)

  const payload = {
    ok: true,
    version: 2,
    bots: [
      { id: 'a', name: '阿鲸', role: '研究员', pinned: true, primary: true, status: 'working', avatar: { shape: 'whale', color: '#0f1115' }, sessionIds: ['s1'] },
      { id: 'b', name: '小轨', role: '设计师', section: '项目', status: 'needs-you', avatar: { shape: 'orbit', color: '#3b82f6' } },
      { id: 'c', name: '叶叶', role: '运营', section: '实验组', status: 'unread', avatar: { shape: 'leaf', color: '#10b981' } },
    ],
    groups: [],
    ui: { mode: 'bot' },
  }
  const calls = []
  let currentSessionId = 's0'
  const openedSessions = []
  const workspace = {
    startSession() { currentSessionId = 's-fallback' },
    openSession(id) { openedSessions.push(id); currentSessionId = id },
    selection: { getSnapshot() { return { sessionId: currentSessionId } } },
  }
  const jsonResponse = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    async json() { return data },
  })
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    const method = String(init?.method ?? 'GET').toUpperCase()
    calls.push({ url: text, method, body: init?.body })
    if (text.includes('/bots/b/session') && method === 'POST') return jsonResponse({ ok: true, sessionId: 's-new', workspaceId: 'w-new' }, 201)
    if (text.includes('/bots/c/session') && method === 'POST') return jsonResponse({ ok: false, error: 'not found' }, 404)
    if (text.includes('/session/bind') && method === 'POST') return jsonResponse({ ok: true })
    if (text.includes('/state')) return jsonResponse(payload)
    return jsonResponse({ ok: true })
  }
  storeModule.getBotConsoleStore().applyPayload(payload)

  globalThis.__dshClientCtx__ = { get(name) { return name === 'uiWorkspace' ? workspace : undefined } }
  indexModule.applyBotConsole({ get(name) { return name === 'uiWorkspace' ? workspace : undefined } })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const host = doc.getElementById('skb-sidebar-host')
  check('host 已挂到锚点上方', host !== null && parent.children.indexOf(host) < parent.children.indexOf(anchor))
  check('Bot 模式隐藏官方工作区', anchor.getAttribute('data-skb-official-hidden') === 'true')
  const list = host.children.find((node) => node.className === 'skb-list')
  check('名册渲染完成（状态驱动 1 次）', indexModule.botConsoleStats().renders === 1, JSON.stringify(indexModule.botConsoleStats()))
  check('新建 Bot 入口存在', host.children.some((node) => node.className === 'skb-form'))
  const form = host.children.find((node) => node.className === 'skb-form')
  const formInputs = form === undefined ? [] : form.children.flatMap((row) => row.children)
  check('新建 Bot 表单有名字/岗位输入', formInputs.some((node) => node.placeholder === '名字') && formInputs.some((node) => node.placeholder === '岗位'))
  const shapeSelect = formInputs.find((node) => node.tagName === 'SELECT')
  check('新建 Bot 表单有 6 种头像形状', shapeSelect !== undefined && shapeSelect.children.length === 6)
  check('新建 Bot 表单有颜色选择', formInputs.some((node) => node.type === 'color'))
  const before = indexModule.botConsoleStats()
  const listWrites = list.innerHTMLWrites
  const observer = StubMutationObserver.last
  for (let i = 0; i < 100; i += 1) observer.callback()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const after = indexModule.botConsoleStats()
  check('100 次观察器回调不增加渲染', after.renders === before.renders && list.innerHTMLWrites === listWrites, JSON.stringify({ before, after, listWrites, now: list.innerHTMLWrites }))
  check('100 次观察器回调被合并成 1 次对账', after.reconciles === before.reconciles + 1, JSON.stringify(after))
  check('host 没有重复挂载', after.mounts === before.mounts)

  /* 点击无会话 Bot：先走 host POST /bots/:id/session，再打开返回的 sessionId。 */
  const rowB = list.children.find((node) => node.getAttribute('data-bot-id') === 'b')
  check('找到无会话 Bot 行', rowB !== undefined)
  if (rowB !== undefined) {
    rowB.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const hostCall = calls.find((call) => call.method === 'POST' && call.url.includes('/api/seeker-bot/bots/b/session'))
    check('点击无会话 Bot 先调 host 会话路由', hostCall !== undefined)
    check('host 返回的 sessionId 被 openSessionById 打开', openedSessions.includes('s-new'), openedSessions.join(','))
    const statusEl = host.children.find((node) => node.className === 'skb-status')
    check('新建并绑定有可见成功提示', statusEl !== undefined && String(statusEl.textContent).includes('已为「小轨」新建会话并绑定'), statusEl?.textContent)
  }

  /* host 路由 404 时降级 uiWorkspace.startSession + POST /session/bind。 */
  const rowC = list.children.find((node) => node.getAttribute('data-bot-id') === 'c')
  check('找到降级用 Bot 行', rowC !== undefined)
  if (rowC !== undefined) {
    rowC.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const bindCall = calls.find((call) => call.method === 'POST' && call.url.includes('/api/seeker-bot/session/bind'))
    check('host 404 时降级 uiWorkspace.startSession', currentSessionId === 's-fallback', currentSessionId)
    check('降级后 POST /session/bind 带 botId/sessionId', bindCall !== undefined && String(bindCall.body).includes('"botId":"c"') && String(bindCall.body).includes('"sessionId":"s-fallback"'), String(bindCall?.body))
  }
}

/* ── 4.5 详情抽屉运行时（打开 / 字段 / PATCH） ─────────────────────────── */

const drawerModule = await import(await bundle('src/client/bot/drawer.ts', 'drawer.mjs'))

console.log('[bot-client] 详情抽屉运行时')
{
  const doc = globalThis.document
  const bot = {
    id: 'bot-1', name: '小轨', role: '设计师', instructions: '先画再写',
    avatar: { shape: 'orbit', color: '#3b82f6' },
    model: { provider: 'openai', model: 'gpt-5', effort: 'high' },
    proactive: { enabled: true, freq: 'daily', from: '09:00', to: '22:00' },
    output: { charts: true, pages: true },
    sessionIds: [],
    status: 'idle',
  }
  const jsonResponse = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    async json() { return data },
  })
  let patchCall = null
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    const method = String(init?.method ?? 'GET').toUpperCase()
    if (text.includes('/bots/bot-1') && method === 'PATCH') {
      patchCall = { url: text, method, body: JSON.parse(String(init?.body ?? '{}')) }
      return jsonResponse({ ok: true, bot })
    }
    return jsonResponse({ ok: true, bots: [bot], groups: [], ui: { mode: 'bot' } })
  }

  drawerModule.openBotDrawer(bot)
  const root = doc.getElementById('skb-bot-drawer')
  check('抽屉打开', root !== null && root.getAttribute('data-open') === 'true')
  const controls = []
  const walk = (node) => {
    if (node.dataset !== undefined && typeof node.dataset.fieldKey === 'string') controls.push(node.dataset.fieldKey)
    for (const child of node.children) walk(child)
  }
  if (root !== null) walk(root)
  const expectedFields = ['name', 'role', 'instructions', 'shape', 'color', 'provider', 'model', 'effort', 'proactiveEnabled', 'proactiveFreq', 'proactiveFrom', 'proactiveTo', 'charts', 'pages']
  check('抽屉 14 个字段控件齐全', expectedFields.every((key) => controls.includes(key)) && controls.length === expectedFields.length, controls.join(','))

  const findButton = (node, label) => {
    if (node.tagName === 'BUTTON' && node.textContent === label) return node
    for (const child of node.children) {
      const found = findButton(child, label)
      if (found !== null) return found
    }
    return null
  }
  const saveBtn = root === null ? null : findButton(root, '保存')
  check('抽屉有保存按钮', saveBtn !== null)
  if (saveBtn !== null) {
    saveBtn.click()
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('保存走 PATCH /bots/:id', patchCall !== null && patchCall.method === 'PATCH' && patchCall.url.includes('/api/seeker-bot/bots/bot-1'))
    check('PATCH 载荷含头像/模型/主动/产出', patchCall !== null
      && patchCall.body.avatar?.shape === 'orbit'
      && patchCall.body.model?.provider === 'openai'
      && patchCall.body.proactive?.enabled === true
      && patchCall.body.output?.pages === true)
  }
  drawerModule.closeBotDrawer()
  check('抽屉可关闭', root !== null && root.getAttribute('data-open') === 'false')
}

/* ── 5. 右栏面板：空数据只有画面，没有标题 / 说明 / 终端文字 ──────────── */

console.log('[bot-client] 右栏 Bot 面板')
{
  check('Work 模式不挂载面板', model.panelShouldMount('work') === false)
  check('Bot 模式挂载面板', model.panelShouldMount('bot') === true)
  check('空数据只有 viewport 区块', model.visiblePanelSections({ hasSubagents: false, hasOutputs: false }).join(',') === 'viewport')
  check('面板静态文案为空', model.PANEL_VIEWPORT_CHROME.title === '' && model.PANEL_VIEWPORT_CHROME.description === '' && model.PANEL_VIEWPORT_CHROME.terminal === false)

  const jsxStub = join(scratch, 'jsx-runtime.mjs')
  writeFileSync(jsxStub, [
    "export const Fragment = Symbol('Fragment')",
    'export function jsx(type, props, key) { return { $$typeof: Symbol.for("react.element"), type, props: props ?? {}, key } }',
    'export const jsxs = jsx',
  ].join('\n'))
  const echoStub = join(scratch, 'echo-stub.mjs')
  writeFileSync(echoStub, 'export const KrEchoViewport = "echo-viewport"')
  const panelModule = await import(await bundle('src/client/bot/panel-view.tsx', 'panel-view.mjs', {
    jsx: 'automatic',
    alias: { 'react/jsx-runtime': jsxStub },
    plugins: [{
      name: 'stub-echo-viewport',
      setup(build) {
        build.onResolve({ filter: /KrEchoViewport\.tsx$/ }, () => ({ path: echoStub }))
      },
    }],
  }))

  function collect(tree, out) {
    if (tree === null || tree === undefined) return
    if (Array.isArray(tree)) { for (const item of tree) collect(item, out); return }
    if (typeof tree !== 'object' || !tree.$$typeof) return
    const type = tree.type
    out.types.push(typeof type === 'string' ? type : (type?.name ?? 'component'))
    const props = tree.props ?? {}
    if (typeof props.children === 'string') out.texts.push(props.children)
    else if (props.children !== undefined) collect(props.children, out)
  }

  const emptyTree = panelModule.BotPanelView({
    sessionId: 's1',
    catalog: { rows: [], runningCount: 0, doneCount: 0, state: 'empty' },
    outputs: { items: [] },
  })
  const emptyOut = { types: [], texts: [] }
  collect(emptyTree, emptyOut)
  check('空数据时渲染画面组件', emptyOut.types.includes('echo-viewport'), emptyOut.types.join(','))
  check('空数据时没有任何文字', emptyOut.texts.length === 0, emptyOut.texts.join('|'))
  check('没有标题 / 终端元素', !emptyOut.types.some((type) => ['h1', 'h2', 'h3', 'p', 'header', 'footer'].includes(type)), emptyOut.types.join(','))

  const dataTree = panelModule.BotPanelView({
    sessionId: 's1',
    catalog: { rows: [{ id: 'sub-1', parentSessionId: 's1', label: '研究员小A', running: true, hasChildren: false, mode: 'one-shot' }], runningCount: 1, doneCount: 0, state: 'ready' },
    outputs: { items: [{ path: 'reports/a.html', name: 'a.html', kind: 'page' }] },
  })
  const dataOut = { types: [], texts: [] }
  collect(dataTree, dataOut)
  check('有数据时列出子智能体名字', dataOut.texts.includes('研究员小A'), dataOut.texts.join('|'))
  check('有数据时列出产出物名字', dataOut.texts.includes('a.html'), dataOut.texts.join('|'))
  check('没有额外标题文字', !dataOut.texts.includes('子智能体') && !dataOut.texts.includes('产出物') && !dataOut.texts.includes('浏览器'), dataOut.texts.join('|'))
}

/* ── 6. 样式纪律：颜色只走 --dsw-alias-*，无渐变发光 ────────────────── */

console.log('[bot-client] 样式纪律')
{
  const stylesSource = readFileSync(resolve(ROOT, 'src/client/bot/styles.ts'), 'utf8')
  const colorLines = stylesSource.split('\n').filter((line) => /(?:^|\s)(?:color|background|background-color|border-color|box-shadow)\s*:/.test(line))
  const offenders = colorLines.filter((line) => {
    const text = line.trim()
    if (/transparent|currentColor|none|inherit/.test(text)) return false
    return !text.includes('var(--dsw-alias-')
  })
  check('颜色属性全部使用 --dsw-alias-*', offenders.length === 0, offenders.join(' | '))
  check('没有渐变', !/gradient/i.test(stylesSource))
  check('主题变量至少覆盖背景/标签/分隔线', ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-border-l2'].every((token) => stylesSource.includes(token)))
  check('空面板不占宽（:has 收起规则）', stylesSource.includes('#dsh-bot-panel-container:has(.skb-bot-panel__viewport:empty)'))
}

rmSync(scratch, { recursive: true, force: true })
if (failed > 0) {
  console.error('\nFAIL dsh-seeker-bot bot client — ' + failed + ' check(s) failed')
  process.exitCode = 1
} else {
  console.log('\nPASS dsh-seeker-bot bot client')
}
