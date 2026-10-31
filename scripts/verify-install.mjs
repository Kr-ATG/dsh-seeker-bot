#!/usr/bin/env node
/**
 * dsh-seeker-bot — 隔离 profile 安装验证（可重复执行，绝不碰用户真实 profile）。
 *
 * 全链路：
 *   1. 在独立 DSH_HOME（默认 _tmp/dsh-home）里用 --from-default-profile web
 *      重建 seeker-test 自定义 profile；
 *   2. dsh plugin --profile seeker-test add link:<repo>；
 *   3. --dump-config 确认 bundle patch 已并入、15 个 insert id 全部出现；
 *   4. 启动临时端口实例（--no-open），从启动日志读取 token（只在内存中使用，不打印）；
 *   5. HTTP 探针：/connect 换 API cookie 后请求 /api/seeker-bot/health 期望 200；
 *   6. 无头 Chrome + CDP：打开页面、等 15s、Runtime.evaluate 证明主线程没卡死、
 *      截图到 _tmp/verify-install/page.png；
 *   7. finally 里杀掉临时实例与浏览器，并核对用户真实 profile 未被改动。
 *
 * Usage:
 *   node scripts/verify-install.mjs [--dsh-home <path>] [--profile <name>]
 *       [--port <n>] [--timeout <seconds>] [--no-browser] [--keep-chrome-profile]
 *
 * 退出码：0 = 全部通过；1 = 有失败；2 = 参数/环境错误。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DSH_BIN = 'D:/AI/Dsh/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'
const ARTIFACT_DIR = resolve(ROOT, '_tmp', 'verify-install')
const USER_DSH_HOME = resolve(homedir(), '.dsh')
const USER_WEB_PROFILE = resolve(USER_DSH_HOME, 'profiles', 'web')

const opts = {
  dshHome: process.env.DSH_VERIFY_HOME || resolve(ROOT, '_tmp', 'dsh-home'),
  profile: 'seeker-test',
  port: 0,
  timeoutSec: 180,
  browser: true,
  keepChromeProfile: false,
  dshBin: process.env.DSH_VERIFY_BIN || DEFAULT_DSH_BIN,
}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  const next = () => {
    i += 1
    if (i >= argv.length) throw new Error('参数 ' + arg + ' 缺少取值')
    return argv[i]
  }
  if (arg === '--dsh-home') opts.dshHome = next()
  else if (arg.startsWith('--dsh-home=')) opts.dshHome = arg.slice('--dsh-home='.length)
  else if (arg === '--profile') opts.profile = next()
  else if (arg.startsWith('--profile=')) opts.profile = arg.slice('--profile='.length)
  else if (arg === '--port') opts.port = Number(next())
  else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length))
  else if (arg === '--timeout') opts.timeoutSec = Number(next())
  else if (arg.startsWith('--timeout=')) opts.timeoutSec = Number(arg.slice('--timeout='.length))
  else if (arg === '--no-browser') opts.browser = false
  else if (arg === '--keep-chrome-profile') opts.keepChromeProfile = true
  else if (arg === '--help' || arg === '-h') {
    console.log('Usage: node scripts/verify-install.mjs [--dsh-home <path>] [--profile <name>] [--port <n>] [--timeout <seconds>] [--no-browser] [--keep-chrome-profile]')
    process.exit(0)
  } else {
    console.error('未知参数：' + arg)
    process.exit(2)
  }
}
opts.dshHome = resolve(opts.dshHome)
opts.dshBin = resolve(opts.dshBin)
if (!Number.isFinite(opts.port) || opts.port < 0 || opts.port > 65535) {
  console.error('--port 必须是 0-65535')
  process.exit(2)
}
if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec < 30) {
  console.error('--timeout 至少 30 秒')
  process.exit(2)
}

let checks = 0
let failures = 0
const pass = (msg) => { checks += 1; console.log('ok    ' + msg) }
const fail = (msg, detail) => {
  checks += 1
  failures += 1
  console.error('FAIL  ' + msg + (detail ? ' — ' + detail : ''))
}
const assert = (condition, msg, detail) => condition ? pass(msg) : fail(msg, detail)
const note = (msg) => console.log('note  ' + msg)
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
const redact = (text) => String(text || '').replace(/token=[A-Za-z0-9._~-]+/g, 'token=[REDACTED]')
const tail = (text, size) => {
  const value = String(text || '')
  return value.length > size ? '...' + value.slice(value.length - size) : value
}
const toPosix = (value) => value.replaceAll('\\', '/')
const safeRealpath = (value) => {
  try { return realpathSync.native(value) } catch { return resolve(value) }
}
const samePath = (a, b) => safeRealpath(a).toLowerCase() === safeRealpath(b).toLowerCase()
const isInside = (child, parent) => {
  const rel = relative(safeRealpath(parent), safeRealpath(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
const fileFingerprint = (file) => {
  if (!existsSync(file)) return file + '|missing'
  try {
    const stat = statSync(file)
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
    return file + '|' + stat.size + '|' + stat.mtimeMs + '|' + hash
  } catch (error) {
    return file + '|unreadable|' + String(error.message)
  }
}
const profileFingerprint = () => ['package.json', 'cordis.patch.yml', 'cordis.yml']
  .map((name) => fileFingerprint(resolve(USER_WEB_PROFILE, name)))
  .join('\n')

const state = {
  server: null,
  serverExit: null,
  serverOut: resolve(ARTIFACT_DIR, 'seeker-test.log'),
  serverErr: resolve(ARTIFACT_DIR, 'seeker-test.log.err'),
  port: null,
  token: null,
  chrome: null,
  chromeProfile: resolve(ARTIFACT_DIR, 'chrome-profile'),
  browserResult: null,
  health: null,
  userProfileBefore: '',
}
const startedAt = new Date().toISOString()

function runDsh(args, label, timeoutMs) {
  const result = spawnSync(process.execPath, [opts.dshBin, ...args], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: opts.dshHome },
    encoding: 'utf8',
    timeout: timeoutMs || opts.timeoutSec * 1000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw new Error(label + ' 启动失败：' + result.error.message)
  const output = redact((result.stdout || '') + (result.stderr ? '\n[stderr]\n' + result.stderr : ''))
  return { status: result.status, signal: result.signal, output, label }
}
function requireRun(result) {
  if (result.status !== 0) {
    throw new Error(result.label + ' 退出码 ' + result.status + '\n' + tail(result.output, 4000))
  }
}
function parseInsertIds() {
  const lines = readFileSync(resolve(ROOT, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
  const ids = []
  let inInsert = false
  for (const line of lines) {
    if (/^- insert:\s*$/.test(line)) { inInsert = true; continue }
    if (!inInsert) continue
    if (/^\S/.test(line)) break
    const match = /^\s{2,}-\s+id:\s*(.+?)\s*$/.exec(line)
    if (match) ids.push(match[1].trim().replace(/^['"]|['"]$/g, ''))
  }
  return ids
}
function readProfilePackage(profileDir) {
  const file = resolve(profileDir, 'package.json')
  if (!existsSync(file)) throw new Error('profile package.json 不存在：' + file)
  return JSON.parse(readFileSync(file, 'utf8'))
}
function findBrowser() {
  const candidates = [
    process.env.DSH_VERIFY_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}
function killTree(pid) {
  if (!pid) return
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
  if (result.error) {
    try { process.kill(pid) } catch {}
  }
}
async function waitForChildExit(child, timeoutMs) {
  if (!child) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true
    await sleep(100)
  }
  return child.exitCode !== null || child.signalCode !== null
}
async function isPortOpen(port) {
  return await new Promise((resolvePromise) => {
    const socket = new net.Socket()
    let settled = false
    const done = (value) => { if (settled) return; settled = true; socket.destroy(); resolvePromise(value) }
    socket.setTimeout(700)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, '127.0.0.1')
  })
}
function writeSummary() {
  const payload = {
    startedAt,
    finishedAt: new Date().toISOString(),
    dshHome: opts.dshHome,
    profile: opts.profile,
    profileDir: resolve(opts.dshHome, 'profiles', opts.profile),
    port: state.port,
    health: state.health,
    page: state.browserResult,
    screenshot: resolve(ARTIFACT_DIR, 'page.png'),
    log: state.serverOut,
    checks,
    failures,
  }
  const file = resolve(ARTIFACT_DIR, 'summary.json')
  writeFileSync(file, JSON.stringify(payload, null, 2))
  console.log('note  summary: ' + file)
}

async function waitForServerUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastLog = ''
  while (Date.now() < deadline) {
    if (state.serverExit !== null) {
      let detail = ''
      try { detail = tail(readFileSync(state.serverErr, 'utf8'), 3000) } catch {}
      if (!detail) { try { detail = tail(readFileSync(state.serverOut, 'utf8'), 3000) } catch {} }
      throw new Error('临时实例提前退出（code=' + state.serverExit + '）\n' + redact(detail))
    }
    if (existsSync(state.serverOut)) {
      const text = readFileSync(state.serverOut, 'utf8')
      lastLog = text
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s&]+)/.exec(text)
      if (match) {
        const url = new URL(match[1])
        state.port = Number(url.port)
        state.token = url.searchParams.get('token')
        if (!state.port || !state.token) throw new Error('启动日志里的 URL 不完整')
        return url
      }
    }
    await sleep(400)
  }
  throw new Error('等待 DSH 实例启动超时（' + Math.round(timeoutMs / 1000) + 's）\n' + redact(tail(lastLog, 4000)))
}
async function httpGet(path, headers) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    return await fetch('http://127.0.0.1:' + state.port + path, {
      headers: headers || {},
      redirect: 'manual',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}
async function probeHealth() {
  const connect = await httpGet('/connect?token=' + encodeURIComponent(state.token) + '&interactions=none', {})
  const cookies = typeof connect.headers.getSetCookie === 'function'
    ? connect.headers.getSetCookie()
    : [connect.headers.get('set-cookie')].filter(Boolean)
  const cookie = cookies.map((item) => String(item).split(';')[0]).filter(Boolean).join('; ')
  assert(connect.status === 302 && cookie.length > 0, 'launch token 可换取 API operator cookie（/connect）', 'status=' + connect.status + ' cookies=' + cookies.length)
  const health = await httpGet('/api/seeker-bot/health', { cookie })
  const body = await health.text()
  let json = null
  try { json = JSON.parse(body) } catch {}
  assert(health.status === 200, '/api/seeker-bot/health 返回 200', 'status=' + health.status + ' body=' + tail(body, 300))
  assert(json && json.ok === true && json.plugin === 'dsh-seeker-bot', '/api/seeker-bot/health 返回 {ok:true, plugin:dsh-seeker-bot}', tail(body, 300))
  state.health = { status: health.status, body: json || tail(body, 300) }
  console.log('note  health: ' + JSON.stringify(state.health))
  const stateRes = await httpGet('/api/seeker-bot/state', { cookie })
  const stateBody = await stateRes.text()
  assert(stateRes.status === 200, '/api/seeker-bot/state 返回 200', 'status=' + stateRes.status + ' body=' + tail(stateBody, 300))
}

function openCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  const events = []
  const opened = new Promise((resolvePromise, rejectPromise) => {
    socket.onopen = () => resolvePromise()
    socket.onerror = (event) => rejectPromise(new Error('WebSocket error: ' + String(event && event.message ? event.message : 'unknown')))
  })
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined) {
      const pendingItem = pending.get(message.id)
      if (pendingItem) { pending.delete(message.id); pendingItem(message) }
    } else {
      events.push(message)
    }
  }
  const send = (method, params, timeoutMs) => {
    const id = ++seq
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectPromise(new Error('CDP timeout (' + Math.round((timeoutMs || 20000) / 1000) + 's): ' + method))
      }, timeoutMs || 20000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) rejectPromise(new Error('CDP error: ' + message.error.message))
        else resolvePromise(message)
      })
      socket.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  return { socket, opened, send, events, close: () => { try { socket.close() } catch {} } }
}

async function runBrowserProbe(pageUrl) {
  const browser = findBrowser()
  if (!browser) throw new Error('找不到 Chrome/Edge（可用 DSH_VERIFY_BROWSER 指定路径）')
  console.log('note  browser: ' + browser)
  rmSync(state.chromeProfile, { recursive: true, force: true })
  mkdirSync(state.chromeProfile, { recursive: true })
  state.chrome = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=1440,900',
    '--user-data-dir=' + state.chromeProfile,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let spawnError = null
  state.chrome.on('error', (error) => { spawnError = error })
  const devtoolsFile = join(state.chromeProfile, 'DevToolsActivePort')
  let devtoolsPort = 0
  let browserWsPath = ''
  const devtoolsDeadline = Date.now() + 20000
  while (Date.now() < devtoolsDeadline) {
    if (spawnError) throw new Error('浏览器启动失败：' + spawnError.message)
    if (existsSync(devtoolsFile)) {
      const lines = readFileSync(devtoolsFile, 'utf8').split(/\r?\n/).filter(Boolean)
      if (lines.length >= 2) { devtoolsPort = Number(lines[0]); browserWsPath = lines[1]; break }
    }
    await sleep(100)
  }
  if (!devtoolsPort || !browserWsPath) throw new Error('浏览器未写出 DevToolsActivePort')
  const targets = await (await fetch('http://127.0.0.1:' + devtoolsPort + '/json/list')).json()
  const target = targets.find((item) => item.type === 'page')
  if (!target) throw new Error('没有可用的页面 target')
  const cdp = openCdp(target.webSocketDebuggerUrl)
  try {
    await cdp.opened
    await cdp.send('Page.enable', {})
    await cdp.send('Runtime.enable', {})
    const nav = await cdp.send('Page.navigate', { url: pageUrl }, 30000)
    if (nav.result && nav.result.errorText) throw new Error('页面导航失败：' + nav.result.errorText)
    await sleep(15000)
    let value = null
    let evalError = null
    try {
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: "(async () => { const started = performance.now(); await new Promise((resolve) => setTimeout(resolve, 50)); const body = document.body; return { readyState: document.readyState, title: document.title, href: location.href, bodyTextLength: body ? (body.innerText || '').length : -1, bodyTextSample: body ? (body.innerText || '').slice(0, 200) : '', hasBoot: typeof window.__DSH_BOOT__ !== 'undefined', elapsedMs: Math.round(performance.now() - started) } })()",
        awaitPromise: true,
        returnByValue: true,
      }, 20000)
      value = evaluated.result && evaluated.result.result ? evaluated.result.result.value : null
    } catch (error) {
      evalError = error
    }
    assert(!evalError, '等待 15s 后页面主线程可响应（Runtime.evaluate 在 20s 内返回）', evalError ? evalError.message : '')
    if (value) {
      assert(value.readyState === 'complete', '页面 readyState = complete', String(value.readyState))
      assert(value.bodyTextLength > 100, '页面 body 有可见内容（innerText 长度 ' + value.bodyTextLength + '）', JSON.stringify(value.bodyTextSample))
      assert(value.hasBoot === true, '页面已注入 window.__DSH_BOOT__（前端 bundle 已启动）', String(value.hasBoot))
      state.browserResult = {
        readyState: value.readyState,
        title: value.title,
        href: value.href,
        bodyTextLength: value.bodyTextLength,
        hasBoot: value.hasBoot,
        elapsedMs: value.elapsedMs,
      }
    }
    try {
      await cdp.send('Runtime.evaluate', {
        expression: "(() => { const button = [...document.querySelectorAll('button')].find((item) => { const text = (item.textContent || '').trim(); return text === '继续' || text === 'Continue' }); if (button) { button.click(); return true } return false })()",
        returnByValue: true,
      }, 5000)
      await sleep(600)
    } catch {}
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000)
    const shotBytes = Buffer.from(shot.result.data, 'base64')
    const shotPath = resolve(ARTIFACT_DIR, 'page.png')
    writeFileSync(shotPath, shotBytes)
    assert(shotBytes.length > 1000, '页面截图已生成（' + Math.round(shotBytes.length / 1024) + ' KB）', shotPath)
    const exceptions = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown').length
    const consoleErrors = cdp.events.filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params && event.params.type === 'error').length
    note('页面 console error=' + consoleErrors + '，未捕获异常=' + exceptions)
  } finally {
    cdp.close()
  }
}

async function main() {
  console.log('== 0. 环境与安全前置 ==')
  console.log('note  repo: ' + ROOT)
  console.log('note  DSH_HOME: ' + opts.dshHome)
  console.log('note  profile: ' + opts.profile)
  if (!existsSync(opts.dshBin)) throw new Error('找不到 DSH CLI：' + opts.dshBin + '（可用 DSH_VERIFY_BIN 指定）')
  pass('DSH CLI 存在：' + opts.dshBin)
  if (isInside(opts.dshHome, USER_DSH_HOME)) {
    throw new Error('拒绝执行：DSH_HOME 不能指向用户真实 DSH home（' + USER_DSH_HOME + '）。请使用默认 _tmp/dsh-home。')
  }
  pass('DSH_HOME 是隔离目录（不在 ' + USER_DSH_HOME + ' 内）')
  const repoPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  assert(repoPkg.name === 'dsh-seeker-bot', '当前目录是 dsh-seeker-bot 仓库', String(repoPkg.name))
  state.userProfileBefore = profileFingerprint()
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(opts.dshHome, { recursive: true })
  pass('验证产物目录就绪：' + ARTIFACT_DIR)

  console.log('\n== 1. 用 --from-default-profile web 重建自定义 profile ==')
  const profileDir = resolve(opts.dshHome, 'profiles', opts.profile)
  const create = runDsh(['--profile', opts.profile, '--from-default-profile', 'web', '--dump-config'], 'create-profile')
  writeFileSync(resolve(ARTIFACT_DIR, 'dump-config-before-install.txt'), create.output)
  requireRun(create)
  pass('--from-default-profile web --dump-config 成功（' + Math.round(create.output.length / 1024) + ' KB 配置输出）')
  const profilePkgBefore = readProfilePackage(profileDir)
  const bundlesBefore = profilePkgBefore.dsh?.profile?.bundles || []
  assert(bundlesBefore.includes('@deepseek-ai/dsh-base') && bundlesBefore.includes('@deepseek-ai/dsh-web-app'), '新 profile bundles 含 dsh-base + dsh-web-app', JSON.stringify(bundlesBefore))
  assert(!bundlesBefore.includes('dsh-seeker-bot'), '新 profile 尚未包含 dsh-seeker-bot', JSON.stringify(bundlesBefore))

  console.log('\n== 2. dsh plugin add link:<repo> ==')
  const linkSpec = 'link:' + toPosix(ROOT)
  const add = runDsh(['plugin', '--profile', opts.profile, 'add', linkSpec], 'plugin-add', Math.max(opts.timeoutSec * 1000, 300000))
  console.log('note  ' + tail(add.output.trim(), 1200).replace(/\n/g, '\nnote  '))
  requireRun(add)
  pass('dsh plugin add ' + linkSpec + ' 成功')
  const profilePkg = readProfilePackage(profileDir)
  const bundles = profilePkg.dsh?.profile?.bundles || []
  const deps = profilePkg.dependencies || {}
  assert(bundles.includes('dsh-seeker-bot'), 'profile bundles 已加入 dsh-seeker-bot', JSON.stringify(bundles))
  assert(typeof deps['dsh-seeker-bot'] === 'string' && toPosix(deps['dsh-seeker-bot']).endsWith('/dsh-seeker-bot'), 'profile dependencies 已写入 dsh-seeker-bot link 依赖', JSON.stringify(deps))
  const installedDir = resolve(profileDir, 'node_modules', 'dsh-seeker-bot')
  assert(existsSync(installedDir), '已安装位置存在 node_modules/dsh-seeker-bot', installedDir)
  if (existsSync(installedDir)) {
    assert(samePath(installedDir, ROOT), '已安装位置 link 指向当前仓库', safeRealpath(installedDir))
  }

  console.log('\n== 3. --dump-config 验证 bundle patch 与 15 个 insert ==')
  const dumpAfter = runDsh(['--profile', opts.profile, '--dump-config'], 'dump-config-after-install')
  writeFileSync(resolve(ARTIFACT_DIR, 'dump-config-after-install.txt'), dumpAfter.output)
  requireRun(dumpAfter)
  const expectedIds = parseInsertIds()
  assert(expectedIds.length === 15, 'cordis.patch.yml 解析出 15 个 insert id', String(expectedIds.length))
  assert(dumpAfter.output.includes('# == dsh-seeker-bot'), 'dump-config 含 dsh-seeker-bot bundle 层')
  assert(/patched by dsh-seeker-bot/.test(dumpAfter.output), 'dump-config 标记 web-app 被 dsh-seeker-bot patch 覆盖')
  const missing = expectedIds.filter((id) => !new RegExp('^- id: ' + id.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '\\s*$', 'm').test(dumpAfter.output))
  assert(missing.length === 0, 'dump-config 含全部 15 个 insert id', missing.join(', '))
  const bundleSection = (dumpAfter.output.split('# == dsh-seeker-bot')[1] || '')
  const sectionIds = expectedIds.filter((id) => new RegExp('^- id: ' + id.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '\\s*$', 'm').test(bundleSection))
  assert(sectionIds.length === expectedIds.length, 'dsh-seeker-bot bundle 层包含全部 15 个 insert 行', String(sectionIds.length))

  console.log('\n== 4. 启动临时端口实例 ==')
  rmSync(state.serverOut, { force: true })
  rmSync(state.serverErr, { force: true })
  const outFd = openSync(state.serverOut, 'w')
  const errFd = openSync(state.serverErr, 'w')
  state.server = spawn(process.execPath, [
    opts.dshBin,
    '--profile', opts.profile,
    '--no-open',
    '--port', String(opts.port),
  ], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: opts.dshHome },
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  })
  closeSync(outFd)
  closeSync(errFd)
  state.server.on('exit', (code, signal) => {
    state.serverExit = code !== null ? code : 'signal:' + String(signal)
  })
  const url = await waitForServerUrl(opts.timeoutSec * 1000)
  console.log('note  instance: http://127.0.0.1:' + state.port + '/ (token 已读取并隐藏)')
  assert(state.server.pid > 0 && state.serverExit === null, '临时实例已启动（PID ' + state.server.pid + '）')

  console.log('\n== 5. HTTP 探针：/api/seeker-bot/health ==')
  try {
    await probeHealth()
  } catch (error) {
    fail('HTTP 探针执行失败', error.message)
  }

  console.log('\n== 6. 页面探针：等待 15s + Runtime.evaluate + 截图 ==')
  if (opts.browser) {
    try {
      await runBrowserProbe(url.href)
    } catch (error) {
      fail('浏览器页面探针失败', error.message)
    }
  } else {
    note('--no-browser：跳过页面探针（不满足完整验收）')
  }
}

state.userProfileBefore = profileFingerprint()
let fatalError = null
try {
  await main()
} catch (error) {
  fatalError = error
  console.error('FATAL ' + redact(String(error && error.stack ? error.stack : error)))
}

console.log('\n== 7. 清理临时实例与核对用户 profile ==')
try {
  if (state.chrome) {
    killTree(state.chrome.pid)
    await waitForChildExit(state.chrome, 10000)
    note('浏览器已关闭')
  }
  if (state.server) {
    killTree(state.server.pid)
    await waitForChildExit(state.server, 10000)
  }
  if (state.port) {
    const open = await isPortOpen(state.port)
    assert(!open, '临时实例已停止，端口 ' + state.port + ' 已释放', open ? '端口仍可连接' : '')
  } else {
    note('实例未成功启动，无端口需要清理')
  }
  if (!opts.keepChromeProfile) rmSync(state.chromeProfile, { recursive: true, force: true })
  const profileAfter = profileFingerprint()
  assert(profileAfter === state.userProfileBefore, '用户真实 profile（' + USER_WEB_PROFILE + '）未被改动')
} catch (error) {
  fail('清理阶段失败', error.message)
}

writeSummary()
console.log('\n' + (failures === 0 && !fatalError ? 'PASSED — ' + checks + ' checks' : 'FAILED — ' + checks + ' checks, ' + failures + ' failure(s)' + (fatalError ? ' (fatal)' : '')))
process.exitCode = failures === 0 && !fatalError ? 0 : 1
