#!/usr/bin/env node
/**
 * 清理壳子（Electron `dsh-shell`）里 DSH 页面的 localStorage 缓存。
 *
 * ## 为什么需要它
 *
 * 在 **DSH 桌面壳**里打开 DSH 时，前端页面跑在壳子的 iframe 里
 * （`http://127.0.0.1:3080/`），它的 localStorage 存在壳子的用户数据目录：
 *
 * ```
 * %APPDATA%\dsh-shell\Local Storage\leveldb\
 * ```
 *
 * 也就是说：**浏览器里的 127.0.0.1:3080 和壳子里的 127.0.0.1:3080 是两套
 * localStorage**。清了宿主侧的会话数据（`~/.dsh/sessions`）之后，壳子界面上
 * 仍然能看到旧消息——它们在前端 localStorage 里，宿主碰不到。
 *
 * ## 怎么清（不关壳子）
 *
 * 壳子启动时开了 CDP 调试端口（端口号写在 `%APPDATA%\dsh-shell\DevToolsActivePort`
 * 和 `.shell-cdp-port` 里，通常是 9224）。通过它连上 iframe target，执行
 * `Runtime.evaluate` 就能直接读写页面的 localStorage——不用关壳子、不用手点 DevTools。
 *
 * ## 清理范围（**只清 Bot 模式，不动 Work**）
 *
 * · `pa:` 前缀 —— Bot 模式的全部状态（bot / 群聊 / 消息 / 记忆 / 任务 / 期刊）
 * · `dsh.conversation.pa-bot-*` / `dsh.sidebar-right.v1.pa-bot-*` —— bot 会话的 UI 残留
 *
 * **不动** `dsh.conversation.session-*` 与 `dsh.sessions.current`：那些是 Work 会话的
 * 界面偏好（面板宽度、滚动位置），与「对话记录」无关，清掉只会丢偏好。
 * Work 的对话历史在 `~/.dsh/sessions`，不在 localStorage，本脚本不碰。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/clean-shell-cache.mjs            # 只看（列出待清理项）
 * node scripts/clean-shell-cache.mjs --apply    # 备份 → 清理 → 刷新页面
 * ```
 *
 * 备份写到 `_tmp/shell-ls-backup/`，**注意 `_tmp` 会被定期清理**，需要长期保留就自己挪走。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 壳子默认的 CDP 端口；读不到 DevToolsActivePort 时用它兜底。 */
const FALLBACK_PORT = 9224
const APPLY = process.argv.includes('--apply')

/** 从壳子的用户数据目录读 CDP 端口。 */
function readPort() {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const dir = join(appData, 'dsh-shell')
  for (const name of ['DevToolsActivePort', '.shell-cdp-port']) {
    try {
      const raw = readFileSync(join(dir, name), 'utf8')
      const first = raw.split('\n')[0]?.trim() ?? ''
      if (/^\d+$/.test(first)) return Number(first)
    } catch {
      /* 文件不存在：试下一个 */
    }
  }
  return FALLBACK_PORT
}

/** 该清的 key（与 buildBotPrompt / store.tsx 的存储约定一致）。 */
const SHOULD_CLEAR_JS = `
  (key) => key.startsWith('pa:')
    || key.startsWith('dsh.conversation.pa-bot-')
    || key.startsWith('dsh.sidebar-right.v1.pa-bot-')
`

/** 连一个 target 的 CDP，执行一次 Runtime.evaluate 并取回结果。 */
function evaluate(wsUrl, expression, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      try { ws.close() } catch { /* ignore */ }
      reject(new Error('CDP 超时'))
    }, timeoutMs)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }))
    })
    ws.addEventListener('message', (event) => {
      let payload
      try { payload = JSON.parse(String(event.data)) } catch { return }
      if (payload.id !== 1) return
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      if (payload.error) reject(new Error(JSON.stringify(payload.error)))
      else resolve(payload.result?.result?.value)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    })
  })
}

async function main() {
  const port = readPort()
  console.log(`壳子 CDP 端口: ${port}`)

  let list
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch (error) {
    console.error(`连不上壳子 CDP（端口 ${port}）：${error instanceof Error ? error.message : String(error)}`)
    console.error('壳子没开？或者这个 DSH 是从浏览器而不是桌面壳打开的——那样直接清浏览器 localStorage 即可。')
    process.exit(1)
  }

  const frame = list.find((item) => item.type === 'iframe' || String(item.url ?? '').includes('127.0.0.1:3080'))
  if (frame === undefined) {
    console.error('壳子里没找到 DSH 页面 target（iframe 127.0.0.1:3080）')
    process.exit(1)
  }
  const ws = frame.webSocketDebuggerUrl
  console.log(`DSH 页面: ${frame.url}\n`)

  const inventory = await evaluate(ws, `
    (() => {
      const shouldClear = ${SHOULD_CLEAR_JS}
      const out = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        const value = localStorage.getItem(key) ?? ''
        out.push({ key, bytes: value.length, clear: shouldClear(key) })
      }
      return JSON.stringify(out)
    })()
  `)
  const entries = JSON.parse(inventory ?? '[]')
  const hit = entries.filter((entry) => entry.clear)
  console.log(`localStorage 共 ${entries.length} 条，待清理 ${hit.length} 条：\n`)
  for (const entry of hit) console.log(`  ${String(entry.bytes).padStart(8)} B  ${entry.key}`)

  if (!APPLY) {
    console.log('\n（只看模式。加 --apply 执行清理）')
    return
  }
  if (hit.length === 0) {
    console.log('\n没有需要清理的条目。')
    return
  }

  // ── 备份（_tmp 会被定期清理，需要长期保留请自行挪走）────────────────
  const backupDir = join(process.cwd(), '_tmp', 'shell-ls-backup')
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, `pa-state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const backup = await evaluate(ws, `
    (() => {
      const shouldClear = ${SHOULD_CLEAR_JS}
      const dump = {}
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (shouldClear(key)) dump[key] = localStorage.getItem(key)
      }
      return JSON.stringify(dump)
    })()
  `)
  writeFileSync(backupPath, backup ?? '{}', 'utf8')
  console.log(`\n已备份 ${hit.length} 条到：${backupPath}`)

  // ── 清理 ──────────────────────────────────────────────────────────
  const removed = await evaluate(ws, `
    (() => {
      const shouldClear = ${SHOULD_CLEAR_JS}
      const removed = []
      for (const key of Object.keys(localStorage)) {
        if (!shouldClear(key)) continue
        removed.push(key)
        localStorage.removeItem(key)
      }
      return JSON.stringify(removed)
    })()
  `)
  console.log(`已清除 ${JSON.parse(removed ?? '[]').length} 条`)

  // ── 刷新页面，让前端按默认状态重建 ────────────────────────────────
  await evaluate(ws, 'setTimeout(() => location.reload(), 200), "reloading"').catch(() => undefined)
  console.log('已触发页面刷新（前端会按默认状态重建，主 Bot 会重新 seed）')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
