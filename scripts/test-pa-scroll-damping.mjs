/**
 * dsh-seeker-bot — Bot 消息流滚动阻尼测试（2026-11-07）。
 *
 * 覆盖三层：
 *   1. 纯函数：橡皮筋映射（单调 / 有上限 / 保号）、wheel delta 归一化；
 *   2. 物理层：滚轮后 scrollTop 逐帧推进（不是瞬移）、多帧收敛、端点越界产生
 *      负向/正向位移、停手后回弹归零；
 *   3. 边界：内层可滚动区域优先、Ctrl+wheel 放行、减少动态效果退化、
 *      destroy 完整清理监听与内联样式。
 *
 * 用 fake DOM + 手动 rAF 队列直接驱动源模块（Node 24 原生剥离 TS 类型），
 * 不依赖浏览器 —— 与 test-scrollbar-autohide.mjs 同一套做法。
 */
import { readFileSync } from 'node:fs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fails = []
function need(condition, label) {
  if (condition) console.log('ok    ' + label)
  else { fails.push(label); console.log('FAIL  ' + label) }
}

/* ---------- fake DOM ---------- */

class FakeStyle {
  constructor() {
    this.values = new Map()
    this.scrollBehavior = ''
  }
  setProperty(key, value) { this.values.set(key, String(value)) }
  removeProperty(key) { this.values.delete(key) }
  getPropertyValue(key) { return this.values.get(key) ?? '' }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.nodeType = 1
    this.parentElement = null
    this.children = []
    this.style = new FakeStyle()
    this.attrs = new Map()
    this.listeners = new Map()
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
    this.overflowY = 'visible'
  }
  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }
  get firstElementChild() { return this.children.length > 0 ? this.children[0] : null }
  setAttribute(key, value) { this.attrs.set(key, String(value)) }
  getAttribute(key) { return this.attrs.has(key) ? this.attrs.get(key) : null }
  removeAttribute(key) { this.attrs.delete(key) }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    const list = this.listeners.get(type)
    if (!list.includes(fn)) list.push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }
  emit(type, event) {
    let prevented = false
    const payload = Object.assign({
      type,
      target: this,
      ctrlKey: false,
      metaKey: false,
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      preventDefault() { prevented = true },
    }, event)
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(payload)
    return prevented
  }
  listenerCount() {
    let total = 0
    for (const list of this.listeners.values()) total += list.length
    return total
  }
}

globalThis.Element = FakeElement
globalThis.getComputedStyle = (element) => ({ overflowY: element.overflowY ?? 'visible' })
globalThis.window = globalThis
globalThis.matchMedia = () => ({ matches: false })
globalThis.ResizeObserver = undefined

/* 手动 rAF 队列：每帧由测试显式 flush，时间戳可控。 */
let rafSeq = 1
let rafQueue = []
globalThis.requestAnimationFrame = (fn) => {
  const id = rafSeq++
  rafQueue.push({ id, fn })
  return id
}
globalThis.cancelAnimationFrame = (id) => {
  rafQueue = rafQueue.filter((item) => item.id !== id)
}
function flushFrame(timestamp) {
  const queue = rafQueue
  rafQueue = []
  for (const item of queue) item.fn(timestamp)
}
function pendingFrames() { return rafQueue.length }

const mod = await import('../src/client/personal/chat/scroll-damping.ts')

/* ---------- 1. 纯函数 ---------- */

need(mod.RUBBER_BAND_MAX === 22, '越界位移上限是 22px')
need(mod.rubberBandOffset(0) === 0, 'raw=0 时位移为 0')
need(mod.rubberBandOffset(100) > 0 && mod.rubberBandOffset(100) < 22, 'raw=100 被压缩到 0~22px 之间')
need(mod.rubberBandOffset(-100) === -mod.rubberBandOffset(100), '正负方向对称')
need(mod.rubberBandOffset(10) < mod.rubberBandOffset(20), '越界位移随 raw 单调递增')
need(mod.rubberBandOffset(100000) === 22, '极端越界仍被夹在上限内')
need(mod.rubberBandOffset(Number.NaN) === 0, 'NaN 安全返回 0')
need(mod.pullOffsetOf(-100) === mod.rubberBandOffset(100), '顶部越界（raw<0）映射为正向内容位移（内容下让）')
need(mod.pullOffsetOf(100) === -mod.rubberBandOffset(100), '底部越界（raw>0）映射为负向内容位移（内容上让）')

need(mod.normalizeWheelDelta(100, 0, 800) === 100, 'deltaMode=pixel 原样返回')
need(mod.normalizeWheelDelta(3, 1, 800) === 48, 'deltaMode=line 按 16px/行换算')
need(mod.normalizeWheelDelta(1, 2, 800) === 800, 'deltaMode=page 按视口高度换算')

/* ---------- 2. 平滑滚动 + 端点阻尼 ---------- */

const scroller = new FakeElement('div')
scroller.scrollHeight = 1000
scroller.clientHeight = 300
const handle = mod.installScrollDamping(scroller)

need(scroller.getAttribute('data-pa-scroll-damping') === '', '安装后容器带阻尼标记')
need(scroller.style.scrollBehavior === '', '安装时不动 CSS scroll-behavior（程序滚动仍用 smooth）')

const prevented = scroller.emit('wheel', { deltaY: 100 })
need(prevented === true, '滚轮被接管并 preventDefault')
need(scroller.style.scrollBehavior === 'auto', '物理层接管期间临时改成 auto（避免逐帧写入被再包一层补间）')
need(pendingFrames() === 1, '滚轮后只排一帧 rAF')

flushFrame(1000)
const afterFirstFrame = scroller.scrollTop
need(afterFirstFrame > 0 && afterFirstFrame < 100, '第一帧只走一小段（不是瞬移 100px），实际 ' + afterFirstFrame.toFixed(1) + 'px')

let frames = 1
while (pendingFrames() > 0 && frames < 240) {
  flushFrame(1000 + frames * 16.7)
  frames += 1
}
need(Math.abs(scroller.scrollTop - 100) < 0.6, '连续多帧后精确收敛到目标 100px（实际 ' + scroller.scrollTop.toFixed(2) + '）')
need(frames > 3, '收敛过程确实跨多帧（' + frames + ' 帧）')
need(scroller.style.scrollBehavior === '', '动画收口后还原 scroll-behavior（程序滚动恢复 smooth）')

/* 顶部越界：继续向上滚 → 内容下让（正位移），停手后回弹归零 */
const topScroller = new FakeElement('div')
topScroller.scrollHeight = 500
topScroller.clientHeight = 300
const topHandle = mod.installScrollDamping(topScroller)
const topPrevented = topScroller.emit('wheel', { deltaY: -100 })
need(topPrevented === true, '顶部继续向上滚会被接管（不是硬截断）')
flushFrame(2000)
const pulled = Number(topScroller.style.getPropertyValue('--pa-scroll-pull').replace('px', ''))
need(pulled > 0, '顶部越界产生正向内容位移（内容下让，实际 ' + pulled.toFixed(2) + 'px）')
need(Math.abs(pulled) <= 22, '越界位移不超过 22px 上限')

await sleep(mod.SCROLL_IDLE_MS + 80)
let reboundFrames = 0
while (pendingFrames() > 0 && reboundFrames < 240) {
  flushFrame(3000 + reboundFrames * 16.7)
  reboundFrames += 1
}
const reboundValue = Number(topScroller.style.getPropertyValue('--pa-scroll-pull').replace('px', '') || '0')
need(Math.abs(reboundValue) < 0.5, '停手后弹性回弹归零（实际 ' + reboundValue.toFixed(3) + 'px）')

/* 底部越界：到底继续向下滚 → 内容上让（负位移） */
const bottomScroller = new FakeElement('div')
bottomScroller.scrollHeight = 500
bottomScroller.clientHeight = 300
bottomScroller.scrollTop = 200
const bottomHandle = mod.installScrollDamping(bottomScroller)
const bottomPrevented = bottomScroller.emit('wheel', { deltaY: 100 })
need(bottomPrevented === true, '底部继续向下滚会被接管（不是硬截断）')
flushFrame(4000)
const bottomPulled = Number(bottomScroller.style.getPropertyValue('--pa-scroll-pull').replace('px', ''))
need(bottomPulled < 0, '底部越界产生负向内容位移（内容上让，实际 ' + bottomPulled.toFixed(2) + 'px）')
need(Math.abs(bottomPulled) <= 22, '底部越界位移不超过 22px 上限')
bottomHandle.destroy()

/* ---------- 3. 边界与生命周期 ---------- */

const innerScroller = new FakeElement('div')
innerScroller.scrollHeight = 900
innerScroller.clientHeight = 300
const inner = new FakeElement('div')
inner.parentElement = innerScroller
inner.overflowY = 'auto'
inner.scrollHeight = 600
inner.clientHeight = 200
inner.scrollTop = 0
const innerHandle = mod.installScrollDamping(innerScroller)

const innerAllowed = innerScroller.emit('wheel', { deltaY: 100, target: inner })
need(innerAllowed === false, '内层可滚动区域还能滚时不抢事件')
inner.scrollTop = 500 // 内层到底
const innerAtEnd = innerScroller.emit('wheel', { deltaY: 100, target: inner })
need(innerAtEnd === true, '内层滚到底后事件交还消息流')

const zoomAllowed = innerScroller.emit('wheel', { deltaY: 100, ctrlKey: true })
need(zoomAllowed === false, 'Ctrl+滚轮（缩放）不接管')

innerHandle.destroy()
need(innerScroller.listenerCount() === 0, 'destroy 摘掉所有监听')
need(innerScroller.getAttribute('data-pa-scroll-damping') === null, 'destroy 清掉阻尼标记')
need(innerScroller.style.getPropertyValue('--pa-scroll-pull') === '', 'destroy 清掉位移变量')
need(innerScroller.style.scrollBehavior === '', 'destroy 还原原有 scroll-behavior')

/* 减少动态效果：完全退化为原生，不挂监听 */
globalThis.matchMedia = () => ({ matches: true })
const reducedScroller = new FakeElement('div')
reducedScroller.scrollHeight = 900
reducedScroller.clientHeight = 300
const reducedHandle = mod.installScrollDamping(reducedScroller)
need(reducedScroller.getAttribute('data-pa-scroll-damping') === null, 'prefers-reduced-motion 下不安装阻尼')
need(reducedScroller.listenerCount() === 0, 'prefers-reduced-motion 下不挂任何监听')
reducedHandle.destroy()

handle.destroy()
topHandle.destroy()

/* ---------- 4. 结构守卫：clip 层必须存在 ----------
 * transform 会改变 Chromium 计算的可滚动溢出区：底部上拉时 scrollHeight 当场
 * 变小、scrollTop 被夹回，橡皮筋静默失效。clip 层是这条手感的物理前提，
 * 所以在源码级加一道守卫，避免以后整理 DOM 时把它当多余的 div 删掉。 */
const listSource = readFileSync(new URL('../src/client/personal/chat/MessageList.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(new URL('../src/client/personal/chat/chat.css.ts', import.meta.url), 'utf8')
need(listSource.includes('pa-chat__scroll-clip'), 'MessageList 保留 clip 包裹层')
need(/\.pa-chat__scroll-clip\s*\{[^}]*overflow:\s*clip/.test(cssSource), 'clip 层使用 overflow: clip 隔离 transform 溢出')

console.log('')
if (fails.length > 0) {
  console.log('PA SCROLL DAMPING TEST FAILED — ' + String(fails.length) + ' 个断言未通过')
  process.exit(1)
}
console.log('PA SCROLL DAMPING TEST PASSED — 平滑惯性 + 端点橡皮筋 + 弹簧回弹 + 边界让位')