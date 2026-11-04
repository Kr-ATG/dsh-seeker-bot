/**
 * dsh-seeker-bot — 侧栏 Work / Bot 切换的回归测试（scripts/test-mode-switch.mjs）。
 *
 * 不启动浏览器：用最小 DOM 桩在 node 里跑真源码（esbuild 现场打包）。
 * 覆盖：
 *  1. 默认 Work；localStorage 存过 bot 时读回 bot（2026-11-01 Bot 模式重新启用）；
 *  2. 分段控件挂在品牌行之后，两个按钮 / 选中态 / aria-selected 正确；
 *  3. Bot 按钮可点：点击后 body/data 模式、侧栏让位与落盘值都切到 bot；
 *     setUiMode('work'/'bot') 可自由切换；
 *  4. 外部把 body 的 data-skb-mode 篡改，下一次对账按当前模式纠正；
 *  5. 对账幂等：MutationObserver 回调连刷 100 次不再创建 / 移动任何节点
 *     （原 Bot 控制台就是在这里死循环的，必须钉死）；
 *  6. 官方侧栏重建后宿主能补挂回来；
 *  7. live reload 重复 apply 不会出现两份宿主，样式表只有一份；
 *  8. 源码守卫：mode-switch 本身不请求任何接口、不引用旧 src/client/bot。
 *
 * Usage: node scripts/test-mode-switch.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-seeker-bot-mode-switch-'))
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 清理失败不改变断言 */ } })

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok   ' + name)
    return
  }
  failed += 1
  console.error('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
}

/* ── 最小 DOM 桩（只实现本模块用到的 API）────────────────────────────── */

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
    this.type = ''
    this._className = ''
    this._textContent = ''
  }
  get className() { return this._className }
  set className(value) { this._className = String(value) }
  get textContent() { return this._textContent }
  set textContent(value) { this._textContent = String(value); this.children = [] }
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
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null }
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
  click() { this.dispatch('click', { preventDefault() {}, stopPropagation() {}, button: 0 }) }
  /*
   * WAAPI 桩（2026-11-04）：分段滑块动效改用 element.animate() 后，测试要能
   * 断言「切回 Work 时播放的是从 Bot 端到 Work 端的位移」。只记录调用，不真正
   * 计时；onfinish 由用例决定是否触发。
   */
  animate(keyframes, options) {
    const animation = {
      keyframes,
      options,
      cancelled: false,
      onfinish: null,
      cancel() { this.cancelled = true },
    }
    if (!Array.isArray(this.animations)) this.animations = []
    this.animations.push(animation)
    return animation
  }
  querySelector(selector) { return this.ownerDocument.querySelectorFrom(this, selector) }
  querySelectorAll(selector) { return this.ownerDocument.querySelectorAllFrom(this, selector) }
  get firstElementChild() { return this.children[0] ?? null }
  get firstChild() { return this.children[0] ?? null }
  get nextSibling() {
    if (this.parentElement === null) return null
    const index = this.parentElement.children.indexOf(this)
    return this.parentElement.children[index + 1] ?? null
  }
  get previousElementSibling() {
    if (this.parentElement === null) return null
    const index = this.parentElement.children.indexOf(this)
    return index > 0 ? this.parentElement.children[index - 1] : null
  }
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
    this.createElementCalls = 0
  }
  createElement(tag) { this.createElementCalls += 1; return new StubElement(this, tag) }
  allElements() {
    const result = []
    const walk = (node) => { result.push(node); for (const child of node.children) walk(child) }
    walk(this.documentElement)
    return result
  }
  getElementById(id) { return this.allElements().find((node) => node.id === String(id)) ?? null }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector) { return this.allElements().filter((node) => matches(node, selector)) }
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
}

class StubMutationObserver {
  constructor(callback) { this.callback = callback; this.disconnected = false }
  observe() {}
  disconnect() { this.disconnected = true }
}

class StubStorage {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(String(key), String(value)) }
  removeItem(key) { this.map.delete(String(key)) }
}

/* ── 环境装配 ────────────────────────────────────────────────────────── */

const doc = new StubDocument()
const storage = new StubStorage()
globalThis.document = doc
globalThis.window = { localStorage: storage }
globalThis.MutationObserver = StubMutationObserver
// 同步执行 microtask，断言不必等事件循环。
globalThis.queueMicrotask = (fn) => { fn() }

// 官方侧栏骨架：根 > 品牌行 > 新会话按钮 > 工作区行
const sidebar = doc.createElement('div')
sidebar.setAttribute('data-slot', 'sidebar')
const sidebarRoot = doc.createElement('div')
sidebarRoot.className = 'hHd-Xa_root'
const logo = doc.createElement('div')
logo.className = 'hHd-Xa_logoRow'
const newSession = doc.createElement('button')
newSession.className = 'hHd-Xa_newSession'
const workspaces = doc.createElement('div')
workspaces.setAttribute('data-slot', 'sidebar.workspaces')
sidebarRoot.appendChild(logo)
sidebarRoot.appendChild(newSession)
sidebarRoot.appendChild(workspaces)
sidebar.appendChild(sidebarRoot)
doc.body.appendChild(sidebar)
const navSections = doc.createElement('div')
navSections.id = 'dsh-sidebar-nav-sections'
doc.body.appendChild(navSections)

const { build } = await import(pathToFileURL(resolve(ROOT, 'node_modules/esbuild/lib/main.js')).href)
const outfile = join(scratch, 'mode-switch.mjs')
await build({
  entryPoints: [resolve(ROOT, 'src/client/mode-switch/index.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const mod = await import(pathToFileURL(outfile).href)

/* ── 1. 默认 Work / Bot 可切换（2026-11-01 Bot 模式重新启用）───────────── */
console.log('[mode-switch] 默认 work / Bot 可切换')
{
  check('默认模式是 work', mod.readUiMode() === 'work', mod.readUiMode())
  storage.setItem('dsh-seeker-bot.ui-mode', 'bot')
  check('存过 bot 后读回 bot', mod.readUiMode() === 'bot', mod.readUiMode())
  check('bot 记录保持原样', storage.getItem('dsh-seeker-bot.ui-mode') === 'bot',
    storage.getItem('dsh-seeker-bot.ui-mode'))
  check('存储键是 dsh-seeker-bot.ui-mode', storage.getItem('dsh-seeker-bot.ui-mode') !== null)
  mod.writeUiMode('work')
  check('写回 work 后读回 work', mod.readUiMode() === 'work')
  mod.writeUiMode('bot')
  check('写 bot 后读回 bot', mod.readUiMode() === 'bot')
  check('Bot 模式开关是打开的', mod.BOT_MODE_ENABLED === true, String(mod.BOT_MODE_ENABLED))
  mod.writeUiMode('work')
}

/* ── 2. 挂载与分段结构 ───────────────────────────────────────────────── */
console.log('[mode-switch] 挂载与分段结构')
{
  mod.applyModeSwitch({})
  const host = doc.getElementById('skb-bot-console-host')
  check('宿主已挂到侧栏根', host !== null && host.parentElement === sidebarRoot)
  check('宿主紧贴品牌行之后', host !== null && host.previousElementSibling === logo)
  const seg = host?.querySelector('.skb-seg') ?? null
  check('分段控件存在', seg !== null)
  const buttons = host?.querySelectorAll('.skb-seg__btn') ?? []
  check('两个按钮 Work / Bot', buttons.length === 2
    && buttons[0].getAttribute('data-mode') === 'work'
    && buttons[1].getAttribute('data-mode') === 'bot'
    && buttons[0].textContent === 'Work'
    && buttons[1].textContent === 'Bot')
  check('默认选中 Work', seg?.getAttribute('data-mode') === 'work' && buttons[0].className.includes(' on'))
  check('body 模式属性 = work', doc.body.getAttribute('data-skb-mode') === 'work')
  check('Work 模式下官方侧栏不被隐藏',
    !logo.hasAttribute('data-skb-native-hide') && !workspaces.hasAttribute('data-skb-native-hide')
    && !logo.hasAttribute('data-skb-mode-hide') && !workspaces.hasAttribute('data-skb-mode-hide'))
  const style = doc.getElementById('dsh-seeker-bot-mode-switch')
  check('样式表已注入', style !== null && style.textContent.includes('.skb-seg__thumb'))
}

/* ── 3. Bot 那一半可点（2026-11-01 重新启用）────────────────────────── */
console.log('[mode-switch] Bot 可点')
{
  const host = doc.getElementById('skb-bot-console-host')
  const buttons = host.querySelectorAll('.skb-seg__btn')
  const botBtn = buttons[1]

  check('Bot 按钮可点', botBtn.disabled !== true && (botBtn.listeners.get('click') ?? []).length > 0)
  storage.setItem('dsh-seeker-bot.ui-mode', 'work')
  botBtn.click()
  check('点 Bot 后 body 变为 bot', doc.body.getAttribute('data-skb-mode') === 'bot',
    String(doc.body.getAttribute('data-skb-mode')))
  check('点 Bot 后品牌行软隐藏（不重播 wide 入场动画）',
    logo.hasAttribute('data-skb-mode-hide') && !logo.hasAttribute('data-skb-native-hide'))
  check('点 Bot 后工作区行软隐藏',
    workspaces.hasAttribute('data-skb-mode-hide') && !workspaces.hasAttribute('data-skb-native-hide'))
  check('点 Bot 后工作台导航软隐藏', navSections.hasAttribute('data-skb-mode-hide'))
  check('点 Bot 后分段在 bot', host.querySelector('.skb-seg').getAttribute('data-mode') === 'bot')
  check('点 Bot 后模式落盘成 bot', storage.getItem('dsh-seeker-bot.ui-mode') === 'bot',
    String(storage.getItem('dsh-seeker-bot.ui-mode')))

  // 直接调 setUiMode 也能切回 / 切走（不再有第二道闸）。
  mod.setUiMode('work')
  check('setUiMode(work) 生效', mod.currentUiMode() === 'work')
  check('setUiMode(work) 后 body 恢复 work', doc.body.getAttribute('data-skb-mode') === 'work')
  {
    const workThumb = doc.getElementById('skb-bot-console-host').querySelector('.skb-seg__thumb')
    const workAnim = (workThumb.animations ?? [])[0]
    check('切回 Work 时官方滑块播放从右到左的 WAAPI 动画',
      workAnim !== undefined
        && workAnim.keyframes[0].transform === 'translateX(calc(100% + 3px))'
        && workAnim.keyframes[1].transform === 'translateX(0)'
        && workAnim.options.duration === 240)
  }
  mod.setUiMode('bot')
  check('setUiMode(bot) 生效', mod.currentUiMode() === 'bot')
  mod.setUiMode('work')
}

/* ── 4. 外部把 body 属性改成 bot，对账纠回 work ──────────────────────── */
console.log('[mode-switch] 外部篡改被纠回')
{
  /*
   * 别的插件 / 手动改 DOM 可能把 data-skb-mode 写成 bot（旧版 Bot 控制台就是这么
   * 干的）。侧栏对账必须把它纠回来，否则样式按 bot 生效、侧栏变空白。
   */
  doc.body.setAttribute('data-skb-mode', 'bot')
  mod.reconcileModeSwitch()
  check('对账后 body 纠回 work', doc.body.getAttribute('data-skb-mode') === 'work',
    String(doc.body.getAttribute('data-skb-mode')))
  check('对账后侧栏没有被隐藏',
    !logo.hasAttribute('data-skb-native-hide') && !logo.hasAttribute('data-skb-mode-hide'))
  check('分段仍在 work', doc.getElementById('skb-bot-console-host')
    .querySelector('.skb-seg').getAttribute('data-mode') === 'work')

  // Work 那一半仍然可点（只是 Bot 被封，不是整枚控件废掉）。
  const buttons = doc.getElementById('skb-bot-console-host').querySelectorAll('.skb-seg__btn')
  check('Work 按钮可点', buttons[0].disabled !== true && (buttons[0].listeners.get('click') ?? []).length > 0)
  buttons[0].click()
  check('点 Work 后模式仍是 work', doc.body.getAttribute('data-skb-mode') === 'work')
  check('点 Work 后模式落盘 work', storage.getItem('dsh-seeker-bot.ui-mode') === 'work')
}

/* ── 5. 对账幂等：观察器连刷 100 次不写 DOM ──────────────────────────── */
console.log('[mode-switch] 对账幂等')
{
  const before = doc.createElementCalls
  const host = doc.getElementById('skb-bot-console-host')
  const childrenBefore = sidebarRoot.children.length
  for (let i = 0; i < 100; i += 1) mod.handleModeSwitchMutations()
  check('不再创建节点', doc.createElementCalls === before, 'before=' + before + ' after=' + doc.createElementCalls)
  check('宿主位置不变', host.parentElement === sidebarRoot && host.previousElementSibling === logo)
  check('侧栏子节点数不变', sidebarRoot.children.length === childrenBefore)
}

/* ── 6. 官方侧栏重建后补挂 ──────────────────────────────────────────── */
console.log('[mode-switch] 侧栏重建后补挂')
{
  const host = doc.getElementById('skb-bot-console-host')
  host.remove()
  check('宿主已摘除', doc.getElementById('skb-bot-console-host') === null)
  mod.reconcileModeSwitch()
  const restored = doc.getElementById('skb-bot-console-host')
  check('对账后宿主回到侧栏根', restored !== null && restored.parentElement === sidebarRoot)
  check('补挂后仍紧贴品牌行', restored?.previousElementSibling === logo)
}

/* ── 7. 重复 apply（live reload）不留双份 ────────────────────────────── */
console.log('[mode-switch] 重复 apply')
{
  mod.applyModeSwitch({})
  const hosts = doc.allElements().filter((node) => node.id === 'skb-bot-console-host').length
  check('宿主只有一份', hosts === 1, 'got ' + hosts)
  const styles = doc.head.children.filter((node) => node.id === 'dsh-seeker-bot-mode-switch')
  check('样式表只有一份', styles.length === 1, 'got ' + styles.length)
  check('重复 apply 后模式保持 work', doc.body.getAttribute('data-skb-mode') === 'work')
}

/* ── 8. 源码守卫：不允许再出现 Bot 接口 ─────────────────────────────── */
console.log('[mode-switch] 源码守卫')
{
  const source = readFileSync(resolve(ROOT, 'src/client/mode-switch/index.ts'), 'utf8')
  check('不再请求任何接口', !source.includes('fetch(') && !source.includes("'/api/") && !source.includes('\"/api/'))
  check('不再引用 src/client/bot', !source.includes("'./bot/") && !source.includes('bot/index'))
}

if (failed > 0) {
  console.error('\nFAIL dsh-seeker-bot mode switch — ' + failed + ' check(s) failed')
  process.exitCode = 1
} else {
  console.log('\nPASS dsh-seeker-bot mode switch')
}
