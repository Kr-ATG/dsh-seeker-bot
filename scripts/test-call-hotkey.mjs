#!/usr/bin/env node
/**
 * dsh-seeker-bot — 语音通话快捷键回归。
 *
 *  1. 纯逻辑真跑：pref.ts（react 打桩）验证物理码↔组合键↔accelerator 转换、
 *     匹配规则、默认绑定、运行时广播；
 *  2. 产物断言：官方命令注册 / catalog 订阅 / 四路触发通道在位，且自定义设置行
 *     已彻底移除（配置源只有官方 ctx.shortcuts 一处）。
 *
 * Usage: node scripts/test-call-hotkey.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
let failed = 0
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

const outdir = mkdtempSync(join(tmpdir(), 'dsh-call-hotkey-'))
try {
  await build({
    entryPoints: [join(ROOT, 'src/client/call-hotkey/pref.ts')],
    outdir, bundle: true, format: 'esm', platform: 'node', target: 'node22',
    outExtension: { '.js': '.mjs' }, logLevel: 'error',
    plugins: [{
      name: 'react-stub',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const useState=(v)=>[typeof v==="function"?v():v,()=>{}];'
            + 'export const useEffect=()=>{};',
          loader: 'js',
        }))
      },
    }],
  })
  const m = await import(pathToFileURL(join(outdir, 'pref.mjs')).href)

  console.log('[1] 组合键纯逻辑（配置源 = 官方 catalog）')
  check('默认 Ctrl+Alt+V 且带修饰键', () => {
    assert.deepEqual(m.DEFAULT_CALL_HOTKEY, { key: 'v', ctrl: true, alt: true, shift: false, meta: false })
    assert.equal(m.hasModifier(m.DEFAULT_CALL_HOTKEY), true)
  })
  check('fromNormalizedBinding 把官方物理码转成组合键', () => {
    assert.deepEqual(m.fromNormalizedBinding({ code: 'KeyV', modifiers: ['control', 'alt'] }), m.DEFAULT_CALL_HOTKEY)
    assert.deepEqual(m.fromNormalizedBinding({ code: 'F8', modifiers: ['control', 'shift'] }),
      { key: 'F8', ctrl: true, alt: false, shift: true, meta: false })
  })
  check('认不出的物理码 / 无修饰键返回 null', () => {
    assert.equal(m.fromNormalizedBinding({ code: 'Unknown', modifiers: ['alt'] }), null)
    assert.equal(m.fromNormalizedBinding({ code: 'KeyV', modifiers: [] }), null)
  })
  check('hotkeyFromEvent 规范化大小写与修饰键', () => {
    assert.deepEqual(
      m.hotkeyFromEvent({ key: 'V', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }),
      { key: 'v', ctrl: true, alt: true, shift: false, meta: false },
    )
    assert.equal(m.hotkeyFromEvent({ key: 'Alt', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }), null)
  })
  check('hotkeyMatches 大小写不敏感、修饰键严格', () => {
    const hk = m.DEFAULT_CALL_HOTKEY
    assert.equal(m.hotkeyMatches({ key: 'V', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }, hk), true)
    assert.equal(m.hotkeyMatches({ key: 'v', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }, hk), false)
    assert.equal(m.hotkeyMatches({ key: 'x', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }, hk), false)
  })
  check('formatHotkey / toAccelerator', () => {
    assert.equal(m.formatHotkey(m.DEFAULT_CALL_HOTKEY), 'Ctrl + Alt + V')
    assert.equal(m.toAccelerator(m.DEFAULT_CALL_HOTKEY), 'Ctrl+Alt+V')
    assert.equal(m.toAccelerator({ key: 'F8', ctrl: true, alt: false, shift: true, meta: false }), 'Ctrl+Shift+F8')
  })
  check('运行时绑定默认可改、无 window 时不抛错', () => {
    assert.deepEqual(m.getCurrentHotkey(), m.DEFAULT_CALL_HOTKEY)
    const other = { key: 'F9', ctrl: true, alt: false, shift: true, meta: false }
    assert.doesNotThrow(() => m.setCurrentHotkey(other))
    assert.deepEqual(m.getCurrentHotkey(), other)
    m.setCurrentHotkey(m.DEFAULT_CALL_HOTKEY)
  })

  console.log('[2] 产物装配')
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  check('官方命令注册与 catalog 订阅在位', () => {
    assert.ok(bundle.includes('dsh-seeker-bot:toggle-voice-call'))
    assert.ok(bundle.includes('toggle-voice-call'))
    assert.ok(bundle.includes('dsh:call-hotkey-fire'))
    assert.ok(bundle.includes('getSnapshot'))
  })
  check('shortcuts 走延迟注入（直接读 ctx.shortcuts 会被 cordis 拒绝）', () => {
    /* 2026-11-04 回归：shortcuts 不在插件顶层 inject 里，直接读根 ctx.shortcuts
       抛 cannot get property "shortcuts" without inject，整块快捷键不挂载。 */
    assert.ok(bundle.includes('ctx.inject(["shortcuts"]'))
    assert.equal(/const shortcuts = \(?ctx\)?\.shortcuts/u.test(bundle), false)
  })
  check('自定义设置行已移除（配置源唯一）', () => {
    assert.equal(bundle.includes('data-call-hotkey-row'), false)
    assert.equal(bundle.includes('skb-hotkey-btn--recording'), false)
    assert.equal(bundle.includes('dsh-seeker-bot-call-hotkey-css'), false)
  })
  check('壳子三路消息通道 + 官方 fire 事件在位', () => {
    assert.ok(bundle.includes('dsh:set-call-hotkey'))
    assert.ok(bundle.includes('dsh:hotkey-down'))
    assert.ok(bundle.includes('dsh:call-hotkey'))
    assert.ok(bundle.includes('dsh:call-hotkey-fire'))
  })
  check('全局监听读 body 模式属性并调 startCall / endCall / selectBot', () => {
    assert.ok(bundle.includes('data-skb-mode'))
    assert.ok(bundle.includes('startCall'))
    assert.ok(bundle.includes('endCall'))
    assert.ok(bundle.includes('selectBot'))
  })
  check('capture 阶段成对注册/注销', () => {
    assert.ok(bundle.includes('addEventListener("keydown"'))
    assert.ok(bundle.includes('removeEventListener("keydown"'))
  })
} finally {
  rmSync(outdir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n[call-hotkey] FAIL: ${failed} 项`)
  process.exit(1)
}
console.log('\n[call-hotkey] PASS')
