/**
 * dsh-seeker-bot — 每日情报卡（客户端半身）静态回归测试（纯 Node ESM）。
 *
 * 不启动浏览器：直接读源码做断言。情报卡的视觉与状态几乎全是「字符串契约」
 * （CSS 关键规则、路由、localStorage 键、aria 属性），这些东西错了不会抛异常、
 * 只会静默显示成错的形态，所以用静态断言把它们钉死。
 *
 * 分五层：
 *   1. 组件契约：BriefCard 导出、props 签名、路由、翻页存储、aria；
 *   2. 状态规格：骨架 / 空态 / 生成中 / 失败 / 未联网 / 轮询间隔 / 跨日；
 *   3. 样式规格：幂等注入、复用 --dpl-* 变量、半截裁剪、max-height 过渡；
 *   4. 依赖方向：不 import ./pill（防循环依赖）、无白名单外的第三方 import；
 *   5. 源码完整性：模板字面量反引号守卫（构建脚本会因此硬失败）。
 *
 * Usage: node scripts/test-daily-brief-client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
const check = (condition, message) => {
  if (condition) console.log('ok    ' + message)
  else {
    failed += 1
    console.error('FAIL  ' + message)
  }
}
const readText = (relative) => readFileSync(join(ROOT, relative), 'utf8')

const CARD_PATH = 'src/client/done-pill/brief-card.tsx'
const STYLE_PATH = 'src/client/done-pill/brief-styles.ts'
const SHARED_PATH = 'src/shared/brief.ts'

const cardSrc = readText(CARD_PATH)
const stylesSrc = readText(STYLE_PATH)
const sharedSrc = readText(SHARED_PATH)

// ── 1. 组件契约 ────────────────────────────────────────────────────────────
console.log('\n── 组件契约 ' + CARD_PATH + ' ──')

check(/export function BriefCard\s*\(\s*props: BriefCardProps\s*\)\s*:\s*JSX\.Element \| null/.test(cardSrc), '导出 BriefCard(props: BriefCardProps): JSX.Element | null')

const propsMatch = cardSrc.match(/export interface BriefCardProps\s*\{([\s\S]*?)\n\}/)
check(propsMatch !== null, '导出 BriefCardProps 接口')
if (propsMatch !== null) {
  const block = propsMatch[1]
  check(/scale:\s*number/.test(block), 'props.scale 是 number（--dps 缩放）')
  check(/ratio:\s*number/.test(block), 'props.ratio 是 number（--dpt 字号比例）')
  check(/wide:\s*boolean/.test(block), 'props.wide 是 boolean（宽栏 / 窄轨）')
}

check(cardSrc.includes("const TODAY_ROUTE = '/api/dsh-done-pill/brief/today'"), 'GET 路由常量 /api/dsh-done-pill/brief/today')
check(cardSrc.includes("const GENERATE_ROUTE = '/api/dsh-done-pill/brief/generate'"), 'POST 路由常量 /api/dsh-done-pill/brief/generate')
check(/method:\s*'POST'/.test(cardSrc), '触发生成用 POST')
check(/body:\s*'\{\}'/.test(cardSrc), '生成请求体是空对象 {}')
check(cardSrc.includes('briefCardAriaLabel(card)'), '无障碍标签走共享契约 briefCardAriaLabel')
check(cardSrc.includes("const CARD_KEY = 'dsh.dailyBrief.card'"), '翻页位置存 localStorage 键 dsh.dailyBrief.card')
check(/localStorage\.getItem\(CARD_KEY\)/.test(cardSrc) && /localStorage\.setItem\(CARD_KEY/.test(cardSrc), '翻页位置读写 localStorage')
check(cardSrc.includes('ref={tab.index === 0 ? tabRef : undefined}') && cardSrc.includes('type="button"'), '半截态是小标签 button（可点可聚焦）')
check(cardSrc.includes('aria-haspopup="dialog"') && cardSrc.includes('aria-expanded={open}'), '标签声明「点开弹对话框」的无障碍语义')
check(cardSrc.includes('role="dialog"'), '浮层 role="dialog"')
check(cardSrc.includes('createPortal'), '点标签弹出浮层（createPortal 到 body）')
check(cardSrc.includes('const tabs = cards.length > 0'), '标签列表按卡片数量渲染（1–2 张半叠放）')
check(cardSrc.includes("data-stack={tab.index === 0 ? 'front' : 'back'}"), '前卡 / 后卡两个层叠位置')
check(cardSrc.includes('data-closing={closing'), '退场动画期间保持挂载（data-closing）')
check(cardSrc.includes('closeTimerRef'), '退场动画定时器（190ms 后卸载）')
check(cardSrc.includes('if (!loaded) return'), '首轮拉取未回时不触发生成（防误触）')
check(cardSrc.includes('if (!wide) return null'), '窄轨（wide=false）不渲染卡片')
check(cardSrc.includes('rotate(-30deg)') && cardSrc.includes('rotate(-44deg)'), '两张卡两个角度：前 -30° / 后 -44°（夹角 14°）')
check(cardSrc.includes('db-sheet'), '大卡容器 .db-sheet（期刊式）')
check(cardSrc.includes('db-col-left') && cardSrc.includes('db-col-right'), '两栏结构：左主题 / 右条目')
check(cardSrc.includes('db-modal'), '遮罩层 .db-modal（点遮罩关闭）')
check(cardSrc.includes("document.addEventListener('pointerdown'"), '点浮层外面关闭（pointerdown 捕获）')
check(/onPointerDown[\s\S]{0,400}?close\(\)/.test(cardSrc), '点外面也走 close()（同样有退场动效，不是裸 setOpen(false)）')
check(cardSrc.includes('lastPopRef') && cardSrc.includes('cloneNode(true)'), '组件卸载时克隆幽灵副本播完退场（切会话 / 切形态）')
check(cardSrc.includes('ghost.remove()'), '幽灵副本 320ms 后自行移除')
check(cardSrc.includes('type="button"'), '标签用原生 button（Enter / Space 由浏览器原生触发 click）')
check(cardSrc.includes("event.key === 'Escape'"), 'Escape 关闭浮层')
check(cardSrc.includes('target="_blank"') && cardSrc.includes('rel="noreferrer"'), '条目来源外链 target=_blank + rel=noreferrer')
check(cardSrc.includes('fontVariantNumeric') || stylesSrc.includes('tabular-nums'), '序号 / 数字用 tabular-nums')

// ── 2. 状态规格 ────────────────────────────────────────────────────────────
console.log('\n── 状态规格 ──')

check(cardSrc.includes('今日情报整理中'), '空态文案「今日情报整理中」')
check(cardSrc.includes('点此生成'), '空态小字「点此生成」')
check(cardSrc.includes('正在联网整理'), '生成中文案「正在联网整理」')
check(cardSrc.includes('情报卡没整理出来'), '失败文案「情报卡没整理出来」')
check(cardSrc.includes('点此重试'), '失败态点按重试')
check(cardSrc.includes('未联网'), '未联网角标文案')
check(cardSrc.includes("brief.origin === 'model'"), 'origin === model 时显示未联网角标')
check(cardSrc.includes('db-skeleton'), '首次拉取显示骨架（两条灰条）')
check(cardSrc.includes('db-progress'), '生成中显示细进度条')
check(/const POLL_MS = 60_000/.test(cardSrc), '前台轮询 60s')
check(/const POLL_MS_HIDDEN = 300_000/.test(cardSrc), '后台（document.hidden）轮询 5 分钟')
check(cardSrc.includes('document.hidden'), '读取 document.hidden 降频')
check(cardSrc.includes('briefDateKey(new Date())'), '用共享契约 briefDateKey 判断跨日')
check(cardSrc.includes('setInterval'), '独立跨日哨兵（跨日立刻重拉）')
check(cardSrc.includes('truncate(error, ERROR_MAX)'), '失败原因按 40 字截断（ERROR_MAX）')
check(/const ERROR_MAX = 40/.test(cardSrc), 'ERROR_MAX = 40')
check(cardSrc.includes('ensureBriefStyles()'), '渲染前调用 ensureBriefStyles 注入样式')

// ── 3. 样式规格 ────────────────────────────────────────────────────────────
console.log('\n── 样式规格 ' + STYLE_PATH + ' ──')

check(/export function ensureBriefStyles\s*\(\s*\)\s*:\s*void/.test(stylesSrc), '导出 ensureBriefStyles(): void')
check(stylesSrc.includes("export const BRIEF_STYLE_ID = 'dsh-daily-brief-styles'"), '样式表 id 是 dsh-daily-brief-styles')
check(stylesSrc.includes('document.getElementById(BRIEF_STYLE_ID)'), '注入前按 id 查重（幂等）')
check(stylesSrc.includes('style.id = BRIEF_STYLE_ID'), '注入的 style 元素带固定 id')
check(stylesSrc.includes("style.dataset.plugin = 'dsh-daily-brief'"), '注入的 style 元素带 data-plugin 标记')
check(stylesSrc.includes('document.head.appendChild(style)'), '样式表挂到 document.head')
check(stylesSrc.includes('--dpl-panel-bg'), '复用 --dpl-panel-bg')
check(stylesSrc.includes('--dpl-panel-border'), '复用 --dpl-panel-border')
check(stylesSrc.includes('--dpl-panel-shadow'), '复用 --dpl-panel-shadow')
check(stylesSrc.includes('--dpl-fg-dim'), '复用 --dpl-fg-dim')
check(stylesSrc.includes('--dpl-fg-weak'), '复用 --dpl-fg-weak')
check(stylesSrc.includes('--dpl-row-bg'), '复用 --dpl-row-bg')
check(stylesSrc.includes('--dpl-divider'), '复用 --dpl-divider')
check(stylesSrc.includes('--dpl-warn'), '复用 --dpl-warn')
check(stylesSrc.includes('overflow:hidden'), '标签 overflow:hidden（超长栏目名不撑破）')
check(stylesSrc.includes('cubic-bezier(.32,.72,0,1)'), '过渡曲线与胶囊同一套 .32,.72,0,1')
check(stylesSrc.includes('width:17%'), '标签宽度 17%（比 1/5 更小）')
check(stylesSrc.includes('left:63%'), '标签位置在胶囊 2/3 处（left:63%）')
check(stylesSrc.includes('.dsh-daily-brief[data-stack="back"]'), '后卡规则（错开 10px、z-index 更低）')
check(stylesSrc.includes('height:calc(40px'), '标签高度 40px（压进胶囊 9px，露出约 31px）')
check(stylesSrc.includes('transform-origin:bottom left'), '旋转原点 bottom left（斜插进胶囊左下）')
check(stylesSrc.includes('.db-modal{'), '遮罩 .db-modal 规则存在')
check(stylesSrc.includes('.db-sheet{'), '大卡 .db-sheet 规则存在')
check(stylesSrc.includes('animation:dbSheetIn'), '划出入场动画 dbSheetIn')
check(stylesSrc.includes('animation:dbSheetOut'), '划出退场动画 dbSheetOut')
check(stylesSrc.includes('cubic-bezier(.4,0,1,1)'), '退场走加速曲线 cubic-bezier(.4,0,1,1)')
check(stylesSrc.includes('dbSheetOut .26s'), '退场时长 260ms（够看清，不是「啪一下没了」）')
check(stylesSrc.includes('translateY(28px) scale(.93)'), '退场位移 28px / 缩到 0.93')
check(cardSrc.includes('}, 260)'), '退场后 260ms 才真正卸载')
check(stylesSrc.includes('cubic-bezier(0,0,.2,1)'), '入场走减速曲线 cubic-bezier(0,0,.2,1)（HarmonyOS 减速语义）')
check(stylesSrc.includes('width:min(860px'), '大卡宽度 860px 封顶（期刊尺度）')
check(stylesSrc.includes('max-height:min(82vh, 760px)'), '大卡高度 82vh 封顶')
check(stylesSrc.includes('grid-template-columns:minmax(0,38%)'), '两栏 38% / 62% 网格')
check(stylesSrc.includes('overscroll-behavior:contain'), '浮层内部滚动不传染页面')
check(stylesSrc.includes('.db-tab{'), '标签文字 .db-tab 规则存在')
check(stylesSrc.includes('.db-pip{'), '状态小圆点 .db-pip 规则存在')
check(stylesSrc.includes('@keyframes dbShimmer'), '骨架 shimmer 动画')
check(stylesSrc.includes('@keyframes dbIndeterminate'), '生成中不确定进度条动画')
check(stylesSrc.includes('prefers-reduced-motion'), '尊重系统「减少动效」')
check(!/:[^;{}]*#[0-9a-fA-F]{3,8}\b/.test(stylesSrc), '不写死十六进制颜色（配色全部走 --dpl-* 变量）')

// 类名交叉检查：组件里出现的每个静态 db-* 类名都要在样式表里有定义，
// 防止「类名拼错 → 卡片裸奔但零报错」。
const classNames = new Set()
for (const match of cardSrc.matchAll(/className="([^"]+)"/g)) {
  for (const name of match[1].split(/\s+/)) if (name !== '') classNames.add(name)
}
const missingClasses = [...classNames].filter((name) => !stylesSrc.includes('.' + name))
check(missingClasses.length === 0, '组件用到的类名都在样式表里定义' + (missingClasses.length === 0 ? '' : '：' + missingClasses.join(', ')))

// ── 4. 依赖方向 ────────────────────────────────────────────────────────────
console.log('\n── 依赖方向 ──')

const importsOf = (source) => [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
const cardImports = importsOf(cardSrc)
const styleImports = importsOf(stylesSrc)
const isAllowed = (spec) => spec.startsWith('.') || spec === 'react' || spec === 'react-dom' || spec.startsWith('@deepseek-ai/')

check(cardImports.length > 0, 'brief-card.tsx 有 import（react + 共享契约 + 样式）')
check(cardImports.includes('react'), 'brief-card.tsx import react')
check(cardImports.includes('../../shared/brief.ts'), 'brief-card.tsx 从共享契约 ../../shared/brief.ts 取类型与纯函数')
check(cardImports.includes('./brief-styles'), 'brief-card.tsx 从 ./brief-styles 取样式注入')
check(!cardImports.some((spec) => spec === './pill' || spec.endsWith('/pill')), 'brief-card.tsx 不 import ./pill（防循环依赖）')
check(cardImports.every(isAllowed), 'brief-card.tsx 无白名单外的第三方 import' + (cardImports.every(isAllowed) ? '' : '：' + cardImports.filter((s) => !isAllowed(s)).join(', ')))
check(styleImports.length === 0, 'brief-styles.ts 不 import 任何模块（尤其不 import ./pill）')

// ── 5. 共享契约一致性 ─────────────────────────────────────────────────────
console.log('\n── 共享契约 ' + SHARED_PATH + ' ──')

check(/export function briefCardChatPrompt\s*\(\s*card: BriefCard\s*\)\s*:\s*string/.test(sharedSrc), '契约导出 briefCardChatPrompt(card): string')
check(/export function briefCardAriaLabel\s*\(\s*card: BriefCard\s*\)\s*:\s*string/.test(sharedSrc), '契约导出 briefCardAriaLabel(card): string')
check(/export interface BriefTodayResponse\s*\{/.test(sharedSrc), '契约导出 BriefTodayResponse')
check(/export interface BriefRecord\s*\{/.test(sharedSrc), '契约导出 BriefRecord')
check(/export interface BriefCard\s*\{/.test(sharedSrc), '契约导出 BriefCard')
check(/export function briefDateKey\s*\(\s*date: Date\s*\)\s*:\s*string/.test(sharedSrc), '契约导出 briefDateKey(date): string')
check(sharedSrc.includes("origin: 'web' | 'model'"), '契约的 origin 只有 web / model 两态')

// ── 6. 源码完整性：模板字面量反引号守卫 ───────────────────────────────────
console.log('\n── 源码完整性（构建脚本会硬失败的点）──')

const countBackticks = (source) => (source.match(/`/g) ?? []).length
check(countBackticks(stylesSrc) === 2, 'brief-styles.ts 恰好 2 个反引号（样式表模板首尾各一，注释里没有反引号）')
check(countBackticks(cardSrc) === 0, 'brief-card.tsx 不含模板字面量（字符串拼接，避开构建守卫）')

console.log(failed === 0 ? '\nPASSED' : '\nFAILED (' + failed + ')')
process.exit(failed === 0 ? 0 : 1)