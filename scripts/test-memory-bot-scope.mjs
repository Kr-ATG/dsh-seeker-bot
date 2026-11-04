/**
 * 记忆归属维度（Bot 二级菜单）冒烟测试。
 *
 * ── 这个脚本防的是什么 ──────────────────────────────────────────────
 * 2026-11 给「操作间 → 记忆」加了第二维：归属（Work / 某台 Bot / 全部 Bot）。
 * 这条链路有三处只要写错一次就会静默出错的契约，各配一条断言：
 *
 *  1. **作用域 → 归属的映射**：Work 侧三种作用域（all / global / project:hash）
 *     必须都映射成 `work`，Bot 侧两种映射成 `bot:<id>` / `bots`。映射错了
 *     就是「点小莫的菜单看到 Work 的记忆」，且不会有任何报错。
 *  2. **持久化层的值校验**：侧栏写进 localStorage 的值会被页面回填。残值
 *     （`'bot:'` 空 id、拼错的前缀）必须回落 `all`，否则页面带着一个永远
 *     匹配不到条目的归属去请求，表现是「列表永远空」。
 *  3. **名册 → 菜单子项的转换**：读 `pa:state:v1` 的容错（脏 JSON / 缺字段）
 *     与子项结构（叶子 id 必须与作用域值同构，否则侧栏高亮对不上）。
 *
 * ── 为什么用 esbuild 现场打包 ────────────────────────────────────────
 * 源码是 .ts / .tsx，`lib/client.js` 是整插件单文件，都不能按模块 import。
 * 这里把两个 hub 模块打成一个临时 ESM 再 import，断言的是真正会跑的源码。
 * tsx 里的 JSX 用 transform + inject 换成一个空实现（本测试不渲染组件，
 * 只调它的纯逻辑导出），因此不依赖 react。
 *
 * Usage: node scripts/test-memory-bot-scope.mjs
 */

import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_DIR = resolve(ROOT, '_tmp', 'test-memory-bot-scope-bundle')

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.error('  FAIL ' + name + '\n       ' + (error instanceof Error ? error.message : String(error)))
  }
}
function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error((label ? label + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
}
function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error((label ? label + ': ' : '') + 'expected ' + b + ', got ' + a)
}

/* ── 0. 测试环境：localStorage / window 的最小实现 ─────────────────────
   hub 模块在模块级不碰这两者（都是调用时才读），所以可以在 import 之前装好。 */
const store = new Map()
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: (key) => { store.delete(key) },
  clear: () => { store.clear() },
  key: (index) => [...store.keys()][index] ?? null,
  get length() { return store.size },
}
const events = []
/** 被 dispatch 过的事件（没有订阅者时 events 里不会有记录，断言要盯这里）。 */
const dispatched = []
globalThis.window = {
  addEventListener: (name, handler) => { events.push({ name, handler }) },
  removeEventListener: (name, handler) => {
    const index = events.findIndex((item) => item.name === name && item.handler === handler)
    if (index >= 0) events.splice(index, 1)
  },
  dispatchEvent: (event) => {
    dispatched.push(event)
    for (const item of [...events]) {
      if (item.name === event.type) item.handler(event)
    }
    return true
  },
  localStorage: globalThis.localStorage,
}
globalThis.Event = class Event {
  constructor(type) { this.type = type }
}
globalThis.CustomEvent = class CustomEvent extends globalThis.Event {
  constructor(type, init = {}) { super(type); this.detail = init.detail }
}
globalThis.StorageEvent = class StorageEvent extends globalThis.Event {
  constructor(type, init = {}) { super(type); this.key = init.key ?? null }
}

/* ── 1. 现场打包两个 hub 模块 ──────────────────────────────────────── */
try { rmSync(OUT_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
mkdirSync(OUT_DIR, { recursive: true })

const slash = (p) => p.replace(/[\\]/g, '/')
/*
 * JSX 运行时桩：memory-bot-source.tsx 里有图标组件（纯展示），本测试只调它的
 * 纯逻辑导出，不渲染任何组件。esbuild 的 automatic runtime 会把 <svg> 编成
 * `import { jsx } from 'react/jsx-runtime'`——仓库没有 react 依赖，用 alias 把
 * 它指到这个空实现即可（不引真 react，测试保持零外部依赖）。
 */
const stubFile = join(OUT_DIR, 'jsx-stub.mjs')
writeFileSync(stubFile, 'export const jsx = () => null\nexport const jsxs = () => null\nexport const Fragment = null\n', 'utf8')
const entryFile = join(OUT_DIR, 'entry.ts')
writeFileSync(entryFile, [
  "export * from '" + slash(resolve(ROOT, 'src/client/triad/hub/workbench-intent.ts')) + "'",
  "export * from '" + slash(resolve(ROOT, 'src/client/triad/hub/memory-bot-source.tsx')) + "'",
].join('\n'), 'utf8')

await build({
  entryPoints: [entryFile],
  outdir: OUT_DIR,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  alias: { 'react/jsx-runtime': stubFile },
  logLevel: 'error',
})

const mod = await import(pathToFileURL(join(OUT_DIR, 'entry.mjs')).href)
const {
  memoryOwnerOf,
  isBotMemoryScope,
  readMemoryScope,
  requestMemoryScope,
  MEMORY_SCOPE_STORE,
} = mod
const { readBotRoster, botsToChildren, BOT_MEMORY_GROUP_ID, ALL_BOTS_CHILD_ID, BOT_ROSTER_STORE } = mod

console.log('\n[1] 作用域 → 归属映射')
check("Work 侧三种作用域都映射到 work", () => {
  assertEqual(memoryOwnerOf('all'), 'work', 'all')
  assertEqual(memoryOwnerOf('global'), 'work', 'global')
  assertEqual(memoryOwnerOf('project:abc123'), 'work', 'project')
})
check("Bot 侧映射到 bot:<id> / bots", () => {
  assertEqual(memoryOwnerOf('bots'), 'bots', 'bots')
  assertEqual(memoryOwnerOf('bot:bot-main-xiaomo'), 'bot:bot-main-xiaomo', 'bot:<id>')
})
check('isBotMemoryScope 只认 bots / bot: 前缀', () => {
  assertEqual(isBotMemoryScope('bots'), true, 'bots')
  assertEqual(isBotMemoryScope('bot:a'), true, 'bot:a')
  assertEqual(isBotMemoryScope('all'), false, 'all')
  assertEqual(isBotMemoryScope('global'), false, 'global')
  assertEqual(isBotMemoryScope('project:h'), false, 'project')
})

console.log('\n[2] 持久化层的值校验')
check('未存过 → 回落 all', () => {
  store.clear()
  assertEqual(readMemoryScope(), 'all')
})
check('合法值原样回填（含 bots / bot:<id>）', () => {
  for (const value of ['all', 'global', 'project:abc', 'bots', 'bot:bot-a']) {
    store.set(MEMORY_SCOPE_STORE, value)
    assertEqual(readMemoryScope(), value, value)
  }
})
check("残值回落 all（'bot:' 空 id / 拼错前缀 / 空串）", () => {
  for (const value of ['bot:', 'bot', 'Bot:a', 'workspace:x', '']) {
    store.set(MEMORY_SCOPE_STORE, value)
    assertEqual(readMemoryScope(), 'all', JSON.stringify(value))
  }
})
check('requestMemoryScope 写盘并广播意图', () => {
  store.clear()
  events.length = 0
  dispatched.length = 0
  requestMemoryScope('bot:bot-a')
  assertEqual(store.get(MEMORY_SCOPE_STORE), 'bot:bot-a')
  assertEqual(dispatched.some((event) => event.type === 'dsh-workbench-intent'), true, 'broadcast')
  assertEqual(dispatched.at(-1)?.detail?.scope, 'bot:bot-a', 'intent payload')
})

console.log('\n[3] Bot 名册读取（pa:state:v1）')
check('没有该键 → 空名册', () => {
  store.clear()
  assertDeepEqual(readBotRoster(), [])
})
check('脏 JSON → 空名册（不抛）', () => {
  store.set(BOT_ROSTER_STORE, '{oops')
  assertDeepEqual(readBotRoster(), [])
})
check('bots 不是数组 → 空名册', () => {
  store.set(BOT_ROSTER_STORE, JSON.stringify({ bots: 'nope' }))
  assertDeepEqual(readBotRoster(), [])
})
check('缺 id / 空 id 的条目被跳过，名字缺省兜底', () => {
  store.set(BOT_ROSTER_STORE, JSON.stringify({
    bots: [
      { id: 'bot-a', name: '小莫', isMain: true },
      { id: '', name: '坏数据' },
      { name: '没 id' },
      { id: 'bot-b' },
    ],
  }))
  assertDeepEqual(readBotRoster(), [
    { id: 'bot-a', name: '小莫', isMain: true },
    { id: 'bot-b', name: '未命名 Bot', isMain: false },
  ])
})

console.log('\n[4] 名册 → 侧栏子项')
check('空名册 → 不画 Bot 分组', () => {
  assertDeepEqual(botsToChildren([]), [])
})
check('分组行 + 全部 Bot + 各 Bot 叶子，id 与作用域值同构', () => {
  const children = botsToChildren([
    { id: 'bot-main', name: '小莫', isMain: true },
    { id: 'bot-x', name: '小助', isMain: false },
  ])
  assertEqual(children.length, 1, 'one group')
  const group = children[0]
  assertEqual(group.id, BOT_MEMORY_GROUP_ID)
  assertEqual(group.label, 'Bot')
  const leaves = group.children
  assertEqual(Array.isArray(leaves), true, 'leaves')
  assertEqual(leaves.length, 3, '全部 Bot + 2 台')
  assertEqual(leaves[0].id, ALL_BOTS_CHILD_ID)
  assertEqual(leaves[0].label, '全部 Bot')
  assertDeepEqual(leaves.slice(1).map((leaf) => leaf.id), ['bot:bot-main', 'bot:bot-x'])
  assertDeepEqual(leaves.slice(1).map((leaf) => leaf.label), ['小莫', '小助'])
})
check('点叶子的 run 会写到对应作用域', () => {
  store.clear()
  const children = botsToChildren([{ id: 'bot-main', name: '小莫', isMain: true }])
  const leaves = children[0].children
  leaves[1].run()
  assertEqual(readMemoryScope(), 'bot:bot-main')
  leaves[0].run()
  assertEqual(readMemoryScope(), 'bots')
})

try { rmSync(OUT_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }

if (failed > 0) {
  console.error('\n' + failed + ' check(s) failed')
  process.exitCode = 1
} else {
  console.log('\nall memory bot-scope checks passed')
}
