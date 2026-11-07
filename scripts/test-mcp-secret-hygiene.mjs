#!/usr/bin/env node
/**
 * 凭据卫生检查 —— 仓库 / npm 发布物里永远不许出现本机 magpie 生图 MCP 的凭据。
 *
 * 背景（2026-11-07）：
 *   magpie-image 这个 MCP 的配置只住在 ~/.dsh/profiles/web/cordis.patch.yml：
 *   网关密钥是 Authorization: Bearer <key>，地址是自托管域名。它会被「工作台资产
 *   同步」的 MCP 配置项带走（加密后传到用户自己的私有仓库，用户允许），但
 *   **绝不能**进插件仓库、npm 发布物或连接器目录 assets/mcp-catalog/catalog.json。
 *
 * 检查范围：package.json 的发布 files（lib / assets / scripts / packages / locale /
 * build.mjs / cordis.patch.yml / README.md / icon.png）+ src + package.json。
 * 命中即失败（exit 1），并打印文件:行号。
 *
 * 用法：node scripts/test-mcp-secret-hygiene.mjs
 */

import { readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

// 刻意拆开拼接：本文件本身也会被扫描，不能让自己命中。
const NEEDLES = [
  { label: 'magpie 网关密钥', value: 'sk-magpie' + '-key-' },
  { label: 'magpie 自托管域名', value: 'hy.kratg' + '.top' },
]

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml',
  '.md', '.html', '.css', '.txt', '.example', '.sh', '.ps1', '.bat',
])
const SKIP_DIRS = new Set(['node_modules', '.git', '_tmp', 'dist', '.dsh-shot-engine'])

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(join(dir, entry.name))
    } else if (entry.isFile()) {
      yield join(dir, entry.name)
    }
  }
}

const roots = ['src', 'assets', 'scripts', 'packages', 'locale']
const looseFiles = ['package.json', 'build.mjs', 'cordis.patch.yml', 'README.md']

const files = []
for (const name of looseFiles) {
  try { if (statSync(join(ROOT, name)).isFile()) files.push(join(ROOT, name)) } catch {}
}
for (const name of roots) {
  try {
    if (statSync(join(ROOT, name)).isDirectory()) {
      for await (const f of walk(join(ROOT, name))) files.push(f)
    }
  } catch {}
}

const offenders = []
let scanned = 0
for (const file of files) {
  const ext = extname(file).toLowerCase()
  if (!TEXT_EXT.has(ext)) continue
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  scanned++
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const needle of NEEDLES) {
      if (lines[i].includes(needle.value)) {
        offenders.push({ file: relative(ROOT, file), line: i + 1, label: needle.label })
      }
    }
  }
}

if (offenders.length === 0) {
  console.log('[mcp-secret-hygiene] PASS — 扫描 ' + scanned + ' 个文件，未发现 magpie MCP 凭据。')
  process.exit(0)
}

console.error('[mcp-secret-hygiene] FAIL — ' + offenders.length + ' 处泄露风险：')
for (const o of offenders) console.error('  ' + o.file + ':' + o.line + '  ' + o.label)
console.error('')
console.error('修正：magpie-image 的 url / Authorization 只写在 ~/.dsh/profiles/web/cordis.patch.yml，')
console.error('不要写进 src / assets / lib / README / 插件自带的 cordis.patch.yml。')
process.exit(1)
