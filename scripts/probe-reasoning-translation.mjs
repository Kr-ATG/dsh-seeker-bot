#!/usr/bin/env node
/**
 * dsh-seeker-bot — KR 思考卡译文层的**运行时**探针（走壳子 CDP）。
 *
 * 为什么需要它：
 *
 * 静态断言只能证明「代码写对了」，证明不了「运行时真的能翻」。翻译链路上有
 * 三个只在运行时才暴露的接缝：
 *
 *   1. 官方 client 包是**异步** apply 的（`await ctx.remote.$mount(...)`），
 *      命名空间 `remote.cotTranslation` 可能比本插件的组件晚到；
 *   2. cordis 的 ctx 是 Proxy，未在 inject 白名单里声明的属性**一读就抛**
 *      —— `ctx.remote.cotTranslation` 能不能读到，取决于本插件的 inject 与
 *      读法对不对；
 *   3. 官方 host 端会校验 provider 与目标语言：客户端自选 provider 会直接
 *      被拒（「Translation provider is not selected」）。
 *
 * 这个脚本在**真实页面**里依次回答这三个问题，输出纯 JSON。
 *
 * 用法：
 *   node scripts/probe-reasoning-translation.mjs            # 只探
 *   node scripts/probe-reasoning-translation.mjs --translate # 额外实译一句
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FALLBACK_PORT = 9224
const DO_TRANSLATE = process.argv.includes('--translate')

function readPort() {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const dir = join(appData, 'dsh-shell')
  for (const name of ['DevToolsActivePort', '.shell-cdp-port']) {
    try {
      const raw = readFileSync(join(dir, name), 'utf8')
      const first = raw.split('\n')[0]?.trim() ?? ''
      if (/^\d+$/.test(first)) return Number(first)
    } catch {
      /* 试下一个 */
    }
  }
  return FALLBACK_PORT
}

function evaluate(wsUrl, expression, timeoutMs = 20000) {
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
      else {
        const result = payload.result?.result
        if (payload.result?.exceptionDetails) {
          reject(new Error(result?.description ?? '页面内求值抛错'))
        } else resolve(result?.value)
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    })
  })
}

async function main() {
  const port = readPort()
  let list
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      stage: 'cdp-connect',
      error: error instanceof Error ? error.message : String(error),
    }))
    process.exit(1)
  }
  const frame = list.find((item) => item.type === 'iframe' || String(item.url ?? '').includes('127.0.0.1:3080'))
  if (frame === undefined) {
    console.error(JSON.stringify({ ok: false, stage: 'find-target', error: '壳子里没找到 DSH 页面 target' }))
    process.exit(1)
  }

  const expression = `
    (async () => {
      const out = { ok: false, stage: 'start' }
      try {
        const ctx = window.__dshClientCtx__
        out.hasCtx = ctx !== undefined && ctx !== null
        if (!out.hasCtx) { out.stage = 'no-ctx'; return JSON.stringify(out) }

        // 1. remote 命名空间是否可达（cordis Proxy 的 inject 闸门）。
        //    正确读法是 ctx.get(\'remote.cotTranslation\')：
        //    属性访问（ctx.remote.cotTranslation / ctx.get(\'remote\').cotTranslation）
        //    一律撞 inject 闸门。
        let ns = null
        let readError = null
        try {
          ns = ctx.get('remote.cotTranslation')
        } catch (error) {
          readError = error instanceof Error ? error.message : String(error)
        }
        out.namespaceReachable = ns !== undefined && ns !== null
        out.readError = readError
        out.hasLimits = typeof ns?.limits === 'function'
        out.hasTranslate = typeof ns?.translate === 'function'
        if (!out.namespaceReachable) {
          out.stage = 'no-namespace'
          out.remoteKeys = Object.keys(ctx.remote ?? {})
          return JSON.stringify(out)
        }

        // 2. limits()：官方已接受的 provider / 目标语言 / 请求上限。
        try {
          const limits = await ns.limits()
          out.limitsOk = limits?.ok === true
          out.limits = limits?.ok === true ? limits.value : null
          out.limitsError = limits?.ok === true ? null : JSON.stringify(limits?.error ?? null)
        } catch (error) {
          out.limitsOk = false
          out.limitsError = error instanceof Error ? error.message : String(error)
        }

        // 3. locale：auto 目标语言时用它。
        try {
          out.locale = ctx.locale?.getSnapshot?.()?.active ?? null
        } catch (error) {
          out.locale = null
        }

        // 4. 实译一句（可选）：验证 provider / 语言校验与真实链路。
        if (${DO_TRANSLATE ? 'true' : 'false'} && out.limitsOk) {
          const accepted = out.limits.preferences
          const target = accepted.targetLanguage === 'auto'
            ? (out.locale ?? navigator.language)
            : accepted.targetLanguage
          try {
            const result = await ns.translate({
              text: 'The build finished successfully.',
              targetLanguage: target,
              provider: accepted.provider,
            })
            out.translateOk = result?.ok === true
            out.translated = result?.ok === true ? result.value : null
            out.translateError = result?.ok === true ? null : JSON.stringify(result?.error ?? null)
          } catch (error) {
            out.translateOk = false
            out.translateError = error instanceof Error ? error.message : String(error)
          }
        }

        out.stage = 'done'
        out.ok = true
        return JSON.stringify(out)
      } catch (error) {
        out.stage = 'throw'
        out.error = error instanceof Error ? error.message : String(error)
        return JSON.stringify(out)
      }
    })()
  `

  const raw = await evaluate(frame.webSocketDebuggerUrl, expression)
  const result = JSON.parse(String(raw ?? '{}'))
  console.log(JSON.stringify(result, null, 2))
  if (result.ok !== true) process.exit(1)
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, stage: 'script', error: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
})
