/**
 * IU 原生卡片「容器级自适应」回归检查（静态断言，无新依赖）。
 *
 * 为什么需要：IU 卡片的宽度由对话流决定（侧栏折叠 / 窗口缩放 / 全屏进出），
 * 而旧实现全部降级规则写成 @media (max-width: …px) 量的是浏览器视口 —— 卡片
 * 变宽变窄时阈值不跨，布局就不重排。修法是给根 .dtt-iu 建 inline-size 容器、
 * 把断点改为 @container iu (max-width: …px)，外壳再用 ResizeObserver 把实测宽
 * 写成 --iu-card-w / data-iu-w 供 JS 侧（chart）消费。
 *
 * 这里只做源码级静态断言（快、可重复、无 GUI 依赖）；真浏览器里改容器宽度看
 * 布局重排，由最终验收另行截图核对。
 *
 * 用法：node scripts/test-iu-card-adaptive.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const IU = resolve(ROOT, 'src/client/iu')
const read = (p) => readFileSync(p, 'utf8')

const failures = []
function need(name, ok, detail) {
  console.log((ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''))
  if (!ok) failures.push(name)
}

const base = read(resolve(IU, 'styles.ts'))
const shell = read(resolve(IU, 'IuCard.tsx'))
const chart = read(resolve(IU, 'kinds/chart.body.tsx'))
const kindsDir = resolve(IU, 'kinds')
const kindTexts = readdirSync(kindsDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => read(resolve(kindsDir, f)))
const allCss = base + '\n' + kindTexts.join('\n')

// 1) 基座：容器化
need('基座 .dtt-iu 建立 inline-size 容器',
  /container-type\s*:\s*inline-size/.test(base) || /container\s*:\s*iu\s*\/\s*inline-size/.test(base))
need('基座声明具名容器 iu',
  /container-name\s*:\s*iu/.test(base) || /container\s*:\s*iu\s*\/\s*inline-size/.test(base))
need('全屏层不再写死 1180px 上限', /min\(\s*100%\s*,\s*1180px\s*\)/.test(base))

// 2) 断点：视口 → 容器
const viewportRules = allCss.split('\n')
  .filter((l) => /^\s*['"]?@media\s*\(\s*max-width\s*:/.test(l))
need('IU CSS 里不再有视口宽度断点', viewportRules.length === 0,
  viewportRules.slice(0, 5).join(' | '))
const containers = [...allCss.matchAll(/@container\s+([^({]*)\s*\(/g)]
need('容器断点数量 >= 11', containers.length >= 11, '实测 ' + containers.length + ' 条')
need('所有容器断点都带具名容器 iu',
  containers.length > 0 && containers.every((m) => m[1].trim().split(/\s+/).includes('iu')))

// 3) 外壳：两套 DOM 实例各自测量
need('外壳接入 ResizeObserver', /ResizeObserver/.test(shell))
need('外壳写入 --iu-card-w', /--iu-card-w/.test(shell))
need('外壳打 data-iu-w 档位', /data-iu-w/.test(shell))
const figureCount = (shell.match(/<(?:figure|IuRoot)\s+className="dtt-iu/g) || []).length
need('内嵌卡与全屏卡各自是独立根节点', figureCount >= 2, '实测 ' + figureCount + ' 处')

// 4) chart：坐标系不再写死
need('chart 不再写死 svgW = 500', !/const\s+svgW\s*=\s*500/.test(chart))
need('chart 自测容器宽度', /ResizeObserver/.test(chart))

// 5) 截图链路仍复用同一份 IU_CSS
const shotCard = read(resolve(ROOT, 'src/shot/card.ts'))
const shotBuilder = read(resolve(ROOT, 'src/client/personal/shot/builder.ts'))
need('截图链路仍内联同一份 IU_CSS', /IU_CSS/.test(shotCard) && /IU_CSS/.test(shotBuilder))

// 6) 构建产物（存在才查，避免 build 之前误报）
const built = resolve(ROOT, 'lib/client.js')
if (existsSync(built)) {
  const out = read(built)
  need('构建产物含 container-type', /container-type/.test(out))
  need('构建产物含 @container iu', /@container iu/.test(out))
} else {
  console.log('note  lib/client.js 不存在，构建产物检查跳过（先跑 node build.mjs）')
}

if (failures.length > 0) {
  console.log('\nIU ADAPTIVE FAILED — ' + failures.length + ' 条不通过：\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
console.log('\nIU ADAPTIVE PASSED — 全部静态断言通过')
