/**
 * 构建 Personal Agent 独立演示页：dist/personal-agent/index.html
 *
 * 把 standalone.tsx 连同 React 一起打进单文件 HTML；不引任何外链，
 * 双击即可打开验收。构建失败时打印 esbuild 的错误原文。
 */
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_DIR = resolve(ROOT, 'dist', 'personal-agent')
const TMP_JS = resolve(OUT_DIR, 'bundle.js')

/** React 只在 DSH 客户端模块表里，插件本身不装；按顺序找一份可打包的实体。 */
function findReactRoots() {
  const checkout = process.env.DSH_CHECKOUT !== undefined && process.env.DSH_CHECKOUT !== ''
    ? resolve(process.env.DSH_CHECKOUT)
    : resolve(ROOT, '../deepseek-harness')
  const candidates = [
    { react: resolve(ROOT, 'node_modules/react'), reactDom: resolve(ROOT, 'node_modules/react-dom') },
    {
      react: resolve(checkout, 'node_modules/.pnpm/node_modules/react'),
      reactDom: resolve(checkout, 'node_modules/.pnpm/node_modules/react-dom'),
    },
    {
      react: resolve(ROOT, '../Dsh/dsh-runtime/node_modules/react'),
      reactDom: resolve(ROOT, '../Dsh/dsh-runtime/node_modules/react-dom'),
    },
  ]
  const found = candidates.find((item) => existsSync(item.react) && existsSync(item.reactDom))
  if (found === undefined) {
    throw new Error(
      'dsh-seeker-bot: cannot find react/react-dom for the standalone demo.\n'
      + '  Install react + react-dom as devDependencies, or set DSH_CHECKOUT to a DSH checkout.',
    )
  }
  return found
}

const { react: REACT, reactDom: REACT_DOM } = findReactRoots()

mkdirSync(OUT_DIR, { recursive: true })

await build({
  entryPoints: [resolve(ROOT, 'src/client/personal/standalone.tsx')],
  outfile: TMP_JS,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: {
    react: REACT,
    'react/jsx-runtime': resolve(REACT, 'jsx-runtime.js'),
    'react/jsx-dev-runtime': resolve(REACT, 'jsx-dev-runtime.js'),
    'react-dom': REACT_DOM,
    'react-dom/client': resolve(REACT_DOM, 'client.js'),
  },
})

const js = readFileSync(TMP_JS, 'utf8')
const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark" data-ds-dark-theme>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Personal Agent · 小墨助手</title>
<style>
  html,body{height:100%;margin:0;background:#141517;color:#f2f3f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
  #app{height:100%}
</style>
</head>
<body data-skb-mode="bot">
<div id="app"></div>
<script>${js.replace(/<\/script>/g, '<\\/script>')}</script>
</body>
</html>
`
writeFileSync(resolve(OUT_DIR, 'index.html'), html, 'utf8')
rmSync(TMP_JS, { force: true })
console.log(`[personal-agent] built ${resolve(OUT_DIR, 'index.html')}`)
