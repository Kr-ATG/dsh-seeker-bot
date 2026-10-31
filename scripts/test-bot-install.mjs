#!/usr/bin/env node
/**
 * dsh-seeker-bot — 安装契约静态测试（不需要启动 DSH，也不碰任何 profile）。
 *
 * 覆盖任务要求的三个面：
 *   1. package.json 五件套：main / exports / files / dsh.bundle.patch / dsh.client；
 *   2. lib/index.js、lib/client.js 存在，且 host 产物没有装到 profile 后必然
 *      ERR_MODULE_NOT_FOUND 的 @deepseek-ai/* 运行时 import（client 半身只允许
 *      通过 dsh.client.inject 声明的模块表 require）；
 *   3. cordis.patch.yml 的 15 个 insert id 都能从 packages 子包的 index.js（根行
 *      则是 main）解析到真实文件。
 *
 * 这是「快速红灯」脚本：真链路（建 profile、装 link、起实例、页面探针）由
 * scripts/verify-install.mjs 负责。
 *
 * Usage: node scripts/test-bot-install.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_INSERT_COUNT = 15
const HOST_EXTERNAL_ALLOWLIST = new Set(['undici'])
const CLIENT_PLATFORM_SEEDS = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'])

let checks = 0
let failures = 0
const pass = (msg) => { checks += 1; console.log('ok    ' + msg) }
const fail = (msg, detail) => {
  checks += 1
  failures += 1
  console.error('FAIL  ' + msg + (detail ? ' — ' + detail : ''))
}
const expect = (condition, msg, detail) => condition ? pass(msg) : fail(msg, detail)
const unquote = (value) => {
  const trimmed = String(value).trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
const readText = (file) => readFileSync(file, 'utf8')
const rel = (file) => relative(ROOT, file).replaceAll('\\', '/')

console.log('== 1. package.json 五件套 ==')
const pkgPath = resolve(ROOT, 'package.json')
if (!existsSync(pkgPath)) {
  fail('package.json 不存在')
  console.log('\nFAILED — 无法继续')
  process.exit(1)
}
let pkg
try {
  pkg = JSON.parse(readText(pkgPath))
  pass('package.json 可解析')
} catch (error) {
  fail('package.json JSON 解析失败', error.message)
  console.log('\nFAILED — 无法继续')
  process.exit(1)
}

expect(pkg.name === 'dsh-seeker-bot', 'name = dsh-seeker-bot', String(pkg.name))
expect(pkg.type === 'module', 'type = module（host 产物按 ESM 加载）', String(pkg.type))
expect(pkg.main === './lib/index.js', 'main = ./lib/index.js', String(pkg.main))

const exportsMap = pkg.exports ?? {}
expect(exportsMap['.'] === './lib/index.js', 'exports["."] = ./lib/index.js', String(exportsMap['.']))
expect(exportsMap['./client'] === './lib/client.js', 'exports["./client"] = ./lib/client.js（client 半身入口）', String(exportsMap['./client']))
expect(exportsMap['./cordis.patch.yml'] === './cordis.patch.yml', 'exports["./cordis.patch.yml"] = ./cordis.patch.yml（bundle patch 入口）', String(exportsMap['./cordis.patch.yml']))
expect(exportsMap['./package.json'] === './package.json', 'exports["./package.json"] = ./package.json', String(exportsMap['./package.json']))
expect(exportsMap['./packages/*'] === './packages/*/index.js', 'exports["./packages/*"] 指向 packages/*/index.js', String(exportsMap['./packages/*']))

const files = Array.isArray(pkg.files) ? pkg.files : []
expect(files.length > 0, 'files 数组非空', JSON.stringify(files))
for (const required of ['lib', 'assets', 'packages', 'locale', 'cordis.patch.yml', 'README.md', 'scripts', 'build.mjs']) {
  expect(files.includes(required), 'files 包含 ' + required, JSON.stringify(files))
}
expect(!files.includes('src') && !files.includes('vendor'), 'files 不发布 src/vendor（构建已内联，减少安装体积）', JSON.stringify(files))
for (const entry of files) {
  if (entry.includes('*')) continue
  expect(existsSync(resolve(ROOT, entry)), 'files 条目在磁盘存在：' + entry)
}

expect(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch = ./cordis.patch.yml', JSON.stringify(pkg.dsh?.bundle))
const clientManifest = pkg.dsh?.client
expect(clientManifest?.platform === 'web', 'dsh.client.platform = web', String(clientManifest?.platform))
const inject = Array.isArray(clientManifest?.inject) ? clientManifest.inject : []
expect(inject.length > 0, 'dsh.client.inject 非空', JSON.stringify(inject))
expect(inject.every((id) => typeof id === 'string' && id.startsWith('@deepseek-ai/dsh-client-')), 'dsh.client.inject 全部是 DSH client 模块表行（@deepseek-ai/dsh-client-*）', JSON.stringify(inject))
expect(new Set(inject).size === inject.length, 'dsh.client.inject 无重复项')
expect(pkg.scripts?.prepare === undefined, 'package.json 无 prepare 脚本（pnpm 10+ 不会拦截构建脚本）', JSON.stringify(pkg.scripts?.prepare))
expect(pkg.scripts?.postinstall === undefined, 'package.json 无 postinstall 脚本', JSON.stringify(pkg.scripts?.postinstall))

console.log('\n== 2. 产物存在性与自包含 ==')
const hostPath = resolve(ROOT, 'lib/index.js')
const clientPath = resolve(ROOT, 'lib/client.js')
for (const item of [['lib/index.js', hostPath, 1024], ['lib/client.js', clientPath, 1024]]) {
  const label = item[0]
  const file = item[1]
  const minBytes = item[2]
  if (!existsSync(file)) { fail(label + ' 不存在', rel(file)); continue }
  const size = statSync(file).size
  expect(size >= minBytes, label + ' 存在且非空（' + (size / 1024 / 1024).toFixed(2) + ' MB）')
}
const patchPath = resolve(ROOT, 'cordis.patch.yml')
expect(existsSync(patchPath), 'cordis.patch.yml 存在', rel(patchPath))

const hostSource = existsSync(hostPath) ? readText(hostPath) : ''
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ')
const staticSpecifiers = (source) => [...source.matchAll(/(?:^|[;\n])\s*(?:import|export)[^\n]*?from\s*["']([^"']+)["']/g)].map((m) => m[1])
const dynamicSpecifiers = (source) => [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
const requireSpecifiers = (source) => [...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
const hostCode = stripComments(hostSource)
const HOST_DYNAMIC_OPTIONAL = new Set(['@xenova/transformers'])
const hostStaticSpecs = [...new Set([...staticSpecifiers(hostCode), ...requireSpecifiers(hostCode)])]
const hostDynamicSpecs = [...new Set(dynamicSpecifiers(hostCode))]
const hostViolations = hostStaticSpecs.filter((spec) => !spec.startsWith('node:') && !HOST_EXTERNAL_ALLOWLIST.has(spec))
expect(
  hostViolations.length === 0,
  'host 产物静态 import / require 只有 node: 内置模块 + 白名单 undici（装到 profile 后不会 ERR_MODULE_NOT_FOUND）',
  hostViolations.join(', '),
)
const hostUnexpectedDynamic = hostDynamicSpecs.filter((spec) => !spec.startsWith('node:') && !HOST_EXTERNAL_ALLOWLIST.has(spec) && !HOST_DYNAMIC_OPTIONAL.has(spec))
expect(
  hostUnexpectedDynamic.length === 0,
  'host 产物动态 import 的非 node 目标只有已声明的可选依赖（@xenova/transformers 本地向量模型，未装时自动回退）',
  hostUnexpectedDynamic.join(', '),
)
const hostOptionalDynamic = hostDynamicSpecs.filter((spec) => HOST_DYNAMIC_OPTIONAL.has(spec))
if (hostOptionalDynamic.length > 0) {
  console.log('note  可选动态依赖：' + hostOptionalDynamic.join(', ') + '（未安装时对应功能回退，不影响插件加载）')
}
expect(
  !staticSpecifiers(hostCode).some((spec) => spec.startsWith('@deepseek-ai/')),
  'host 产物无 @deepseek-ai/* 静态 import',
)
const hostAtDeepseekHits = [...hostCode.matchAll(/@deepseek-ai\/[A-Za-z0-9._/-]+/g)].map((m) => m[0])
const hostAtDeepseekStatic = hostAtDeepseekHits.filter((spec) => staticSpecifiers(hostCode).includes(spec))
expect(hostAtDeepseekStatic.length === 0, 'host 产物中不存在 @deepseek-ai/* 运行时解析依赖（文本提及不算 import）', hostAtDeepseekHits.join(', '))

const clientSource = existsSync(clientPath) ? readText(clientPath) : ''
expect(clientSource.startsWith('window.__ModuleLoader__.load({ id: "dsh-seeker-bot"'), 'client 产物是 DSH ModuleLoader 工厂（window.__ModuleLoader__.load + 插件 id）')
const clientCode = stripComments(clientSource)
const clientStatic = staticSpecifiers(clientCode)
expect(!clientStatic.some((spec) => spec.startsWith('@deepseek-ai/')), 'client 产物无 @deepseek-ai/* ESM 静态 import（否则模块表注入失效）')
const clientRequires = [...new Set(requireSpecifiers(clientCode))]
const injected = new Set(inject)
const clientAtDeepseek = clientRequires.filter((spec) => spec.startsWith('@deepseek-ai/'))
const notInjected = clientAtDeepseek.filter((spec) => !injected.has(spec))
expect(
  notInjected.length === 0,
  'client 产物 require 的 ' + clientAtDeepseek.length + ' 个 @deepseek-ai/* 模块全部已声明在 dsh.client.inject',
  notInjected.join(', '),
)
const nonAllowedClientBare = clientRequires.filter((spec) => !spec.startsWith('@deepseek-ai/') && !CLIENT_PLATFORM_SEEDS.has(spec))
expect(nonAllowedClientBare.length === 0, 'client 产物只 require 平台种子词（react 家族）与已注入模块', nonAllowedClientBare.join(', '))

console.log('\n== 3. cordis.patch.yml 的 15 个 insert ==')
const patchText = existsSync(patchPath) ? readText(patchPath) : ''
const insertEntries = []
let inInsertBlock = false
let currentEntry = null
for (const line of patchText.split(/\r?\n/)) {
  if (/^- insert:\s*$/.test(line)) { inInsertBlock = true; continue }
  if (!inInsertBlock) continue
  if (/^\S/.test(line)) break
  const idMatch = /^\s{4}-\s+id:\s*(.+?)\s*$/.exec(line)
  if (idMatch) { currentEntry = { id: unquote(idMatch[1]) }; insertEntries.push(currentEntry); continue }
  const nameMatch = /^\s{6}name:\s*(.+?)\s*$/.exec(line)
  if (nameMatch && currentEntry) { currentEntry.name = unquote(nameMatch[1]); continue }
}
expect(insertEntries.length === EXPECTED_INSERT_COUNT, 'insert 条目数量 = ' + EXPECTED_INSERT_COUNT, String(insertEntries.length))
const ids = insertEntries.map((entry) => entry.id)
expect(new Set(ids).size === ids.length, 'insert id 全部唯一', ids.join(', '))
expect(insertEntries.every((entry) => typeof entry.id === 'string' && entry.id.startsWith('dsh-seeker-bot')), 'insert id 均以 dsh-seeker-bot 开头')
expect(insertEntries.every((entry) => typeof entry.name === 'string' && entry.name.length > 0), '每个 insert 都有非空 name')

const resolveInsertName = (name) => {
  if (name === pkg.name) return resolve(ROOT, pkg.main)
  const prefix = pkg.name + '/packages/'
  if (!name.startsWith(prefix)) return undefined
  const rest = name.slice(prefix.length)
  const segments = rest.split('/')
  const pkgDir = segments.shift()
  if (!pkgDir) return undefined
  return resolve(ROOT, 'packages', pkgDir, ...(segments.length > 0 ? segments : ['index.js']))
}
const unresolved = []
const resolved = []
for (const entry of insertEntries) {
  const file = resolveInsertName(entry.name)
  if (!file) { unresolved.push(entry.id + ': name 不在 exports 契约内 (' + entry.name + ')'); continue }
  if (!existsSync(file)) { unresolved.push(entry.id + ': ' + rel(file) + ' 不存在'); continue }
  if (statSync(file).size === 0) { unresolved.push(entry.id + ': ' + rel(file) + ' 为空'); continue }
  resolved.push({ id: entry.id, file: rel(file) })
}
expect(unresolved.length === 0, '15 个 insert name 全部可解析到真实 index.js / main 入口', unresolved.join('; '))
const resolvedPackageCount = resolved.filter((item) => item.file.startsWith('packages/')).length
expect(resolvedPackageCount === EXPECTED_INSERT_COUNT - 1, '其中 ' + (EXPECTED_INSERT_COUNT - 1) + ' 个来自 packages/*/index.js（根条目走 main）', String(resolvedPackageCount))
expect(insertEntries[0]?.id === 'dsh-seeker-bot' && insertEntries[0]?.name === 'dsh-seeker-bot', '首条 insert 是本插件根入口（id/name 均为 dsh-seeker-bot）')
const packageIds = insertEntries.slice(1).map((entry) => entry.id)
expect(new Set(packageIds).size === packageIds.length && packageIds.length === EXPECTED_INSERT_COUNT - 1, '14 个 packages 子插件 id 唯一', String(packageIds.length))

console.log('\n' + (failures === 0 ? 'PASSED — ' + checks + ' checks' : 'FAILED — ' + checks + ' checks, ' + failures + ' failure(s)'))
process.exitCode = failures === 0 ? 0 : 1
