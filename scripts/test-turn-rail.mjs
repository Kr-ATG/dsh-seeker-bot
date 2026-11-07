/**
 * dsh-seeker-bot — 官方轮次导航轨恢复测试（2026-11-07）。
 *
 * 行为口径：官方 TurnNavigator 被识别出来并打上 data-dsh-turn-rail；
 * 官方其它 nav（全局面板 / 面包屑）不误伤；会话切换换掉导航轨后
 * 新节点自动标记、旧节点标记清理；卸载时全部还原。
 *
 * 用 fake DOM 直接驱动源模块（Node 24 原生剥离 TS 类型），不依赖浏览器。
 */
const WATCH_MS = 500
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fails = []
function need(condition, label) {
  if (condition) console.log('ok    ' + label)
  else { fails.push(label); console.log('FAIL  ' + label) }
}

/** 只实现本模块用到的 DOM 面：属性读写 + parentElement + 计算样式。 */
class FakeNode {
  constructor({ attrs = {}, style = {}, parent = null }) {
    this.attrs = new Map(Object.entries(attrs))
    this.style = style
    this.parentElement = parent
  }
  setAttribute(key, value) { this.attrs.set(key, String(value)) }
  getAttribute(key) { return this.attrs.has(key) ? this.attrs.get(key) : null }
  removeAttribute(key) { this.attrs.delete(key) }
  has(key) { return this.attrs.has(key) }
}

/** 官方导航轨的父槽位：container-type: inline-size。 */
const railSlot = new FakeNode({ style: { containerType: 'inline-size' } })
/** 官方导航轨本体：aria-label 轮次导航 + contain: layout。 */
const zhRail = new FakeNode({ attrs: { 'aria-label': '轮次导航' }, style: { contain: 'layout' }, parent: railSlot })
/** 英文界面下的同一枚元素（无 hash 类名可读，靠文案命中）。 */
const enRailSlot = new FakeNode({ style: { containerType: 'normal' } })
const enRail = new FakeNode({ attrs: { 'aria-label': 'Turn navigation' }, style: { contain: 'paint' }, parent: enRailSlot })
/** 文案缺失但结构特征齐全的导航轨（官方改文案时仍要命中）。 */
const structRailSlot = new FakeNode({ style: { containerType: 'inline-size' } })
const structRail = new FakeNode({ attrs: {}, style: { contain: 'layout style paint' }, parent: structRailSlot })
/** 官方其它 nav：全局面板（父级不是容器、自身无 contain）。 */
const panelNav = new FakeNode({ attrs: { 'aria-label': '全局面板' }, style: { contain: 'none' }, parent: new FakeNode({ style: { containerType: 'normal' } }) })
/** 面包屑 nav：有 aria-label，但不是轮次导航。 */
const crumbNav = new FakeNode({ attrs: { 'aria-label': '会话层级' }, style: { contain: 'none' }, parent: new FakeNode({ style: { containerType: 'normal' } }) })

let navs = [zhRail, enRail, structRail, panelNav, crumbNav]
globalThis.document = {
  querySelectorAll: (selector) => (selector === 'nav' ? navs : []),
}
globalThis.window = globalThis
globalThis.getComputedStyle = (element) => element.style

const mod = await import('../src/client/kr-chat/turn-rail.ts')
const dispose = mod.installTurnRailReveal()

need(mod.TURN_RAIL_ATTR === 'data-dsh-turn-rail', '标记属性是 data-dsh-turn-rail')
need(mod.TURN_RAIL_WATCH_INTERVAL_MS === WATCH_MS, '对账间隔是 500ms')
need(zhRail.has(mod.TURN_RAIL_ATTR), '中文文案的官方轮次导航被打上标记')
need(enRail.has(mod.TURN_RAIL_ATTR), '英文文案的官方轮次导航同样被打上标记')
need(structRail.has(mod.TURN_RAIL_ATTR), '文案缺失时按结构特征（inline-size 容器 + contain:layout）命中')
need(!panelNav.has(mod.TURN_RAIL_ATTR) && !crumbNav.has(mod.TURN_RAIL_ATTR), '官方其它 nav（全局面板 / 面包屑）不被误伤')
need(zhRail.getAttribute(mod.TURN_RAIL_ATTR) === '', '标记属性值为空串（纯存在性选择器）')

// 会话切换：导航轨整块换掉
const rebuiltSlot = new FakeNode({ style: { containerType: 'inline-size' } })
const rebuiltRail = new FakeNode({ attrs: { 'aria-label': '轮次导航' }, style: { contain: 'layout' }, parent: rebuiltSlot })
navs = [rebuiltRail, panelNav, crumbNav]
await sleep(WATCH_MS + 200)
need(rebuiltRail.has(mod.TURN_RAIL_ATTR), '会话切换后新出现的轮次导航自动标记')
need(!zhRail.has(mod.TURN_RAIL_ATTR) && !enRail.has(mod.TURN_RAIL_ATTR) && !structRail.has(mod.TURN_RAIL_ATTR),
  '消失的旧导航轨上的标记被清理')

// 导航轨本轮次不足（<2 轮官方整块不渲染）
navs = [panelNav, crumbNav]
await sleep(WATCH_MS + 200)
need(!rebuiltRail.has(mod.TURN_RAIL_ATTR), '导航轨整块消失后标记随之清掉')

// 再出现一次，确认对账可反复
navs = [rebuiltRail]
await sleep(WATCH_MS + 200)
need(rebuiltRail.has(mod.TURN_RAIL_ATTR), '导航轨重新出现后再次被标记')

dispose()
need(!rebuiltRail.has(mod.TURN_RAIL_ATTR), '卸载时清掉所有标记')
navs = [zhRail]
await sleep(WATCH_MS + 200)
need(!zhRail.has(mod.TURN_RAIL_ATTR), '卸载后对账定时器已停，不再重新标记')

console.log('')
if (fails.length > 0) {
  console.log('TURN RAIL TEST FAILED — ' + String(fails.length) + ' 个断言未通过')
  process.exit(1)
}
console.log('TURN RAIL TEST PASSED — 识别官方轮次导航 + 不误伤其它 nav + 换节点重挂 + 卸载还原')
