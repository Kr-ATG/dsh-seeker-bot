/**
 * dsh-seeker-bot — 节日卡（客户端半身）静态回归测试（纯 Node ESM）。
 *
 * 不启动浏览器：直接读源码做断言。节日卡的视觉与状态几乎全是「字符串契约」
 * （CSS 关键规则、路由、localStorage 键、aria 属性、class 名），这些东西错了
 * 不会抛异常、只会静默显示成错的形态，所以用静态断言把它们钉死。
 *
 * 分六层：
 *   1. 组件契约：FestivalCard 导出、props 签名、路由、翻页存储、aria；
 *   2. 交互规格：portal、data-closing、幽灵副本、Escape、pointerdown、图片 onError；
 *   3. 状态规格：骨架 / 空态 / 生成中 / 失败 / 资料卡 / 轮询间隔 / 跨日；
 *   4. 样式规格：幂等注入、复用 --dpl-* 变量、左图右文两栏、退场动效；
 *   5. 依赖方向：不 import ./pill、无白名单外的第三方 import；
 *   6. 源码完整性：模板字面量反引号守卫（构建脚本会因此硬失败）。
 *
 * Usage: node scripts/test-festival-card-client.mjs
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

const CARD_PATH = 'src/client/done-pill/festival-card.tsx'
const STYLE_PATH = 'src/client/done-pill/festival-styles.ts'
const SHARED_PATH = 'src/shared/festival.ts'

const cardSrc = readText(CARD_PATH)
const stylesSrc = readText(STYLE_PATH)
const sharedSrc = readText(SHARED_PATH)

// ── 1. 组件契约 ────────────────────────────────────────────────────────────
console.log('\n── 组件契约 ' + CARD_PATH + ' ──')

check(/export function FestivalCard\s*\(\s*props: FestivalCardProps\s*\)\s*:\s*JSX\.Element \| null/.test(cardSrc), '导出 FestivalCard(props: FestivalCardProps): JSX.Element | null')

const propsMatch = cardSrc.match(/export interface FestivalCardProps\s*\{([\s\S]*?)\n\}/)
check(propsMatch !== null, '导出 FestivalCardProps 接口')
if (propsMatch !== null) {
  const block = propsMatch[1]
  check(/scale:\s*number/.test(block), 'props.scale 是 number（--dps 缩放）')
  check(/ratio:\s*number/.test(block), 'props.ratio 是 number（--dpt 字号比例）')
  check(/wide:\s*boolean/.test(block), 'props.wide 是 boolean（宽栏 / 窄轨）')
}

check(cardSrc.includes("const TODAY_ROUTE = '/api/dsh-done-pill/festival/today'"), 'GET 路由常量 /api/dsh-done-pill/festival/today')
check(cardSrc.includes("const GENERATE_ROUTE = '/api/dsh-done-pill/festival/generate'"), 'POST 路由常量 /api/dsh-done-pill/festival/generate')
check(/method:\s*'POST'/.test(cardSrc), '触发生成用 POST')
check(/body:\s*'\{\}'/.test(cardSrc), '生成请求体是空对象 {}')
check(cardSrc.includes('festivalCardAriaLabel(card)') || cardSrc.includes('festivalCardAriaLabel(card, now)'), '无障碍标签走共享契约 festivalCardAriaLabel')
check(cardSrc.includes("const CARD_KEY = 'dsh.festivalCard.card'"), '翻页位置存 localStorage 键 dsh.festivalCard.card')
check(/localStorage\.getItem\(CARD_KEY\)/.test(cardSrc) && /localStorage\.setItem\(CARD_KEY/.test(cardSrc), '翻页位置读写 localStorage')
check(cardSrc.includes('aria-haspopup="dialog"') && cardSrc.includes('aria-expanded={open}'), '标签声明「点开弹对话框」的无障碍语义')
check(cardSrc.includes('role="dialog"') && cardSrc.includes('aria-modal="true"'), '浮层 role="dialog" + aria-modal')
check(cardSrc.includes('aria-label="关闭节日卡"'), '关闭按钮有中文 aria-label')
check(cardSrc.includes('aria-label="上一张节日卡"') && cardSrc.includes('aria-label="下一张节日卡"'), '翻页按钮有中文 aria-label')
check(cardSrc.includes('const tabs = cards.length > 0'), '标签列表按卡片数量渲染（1–2 张半叠放）')
check(cardSrc.includes("data-stack={tab.index === 0 ? 'front' : 'back'}"), '前卡 / 后卡两个层叠位置')
check(cardSrc.includes('if (!wide) return null'), '窄轨（wide=false）不渲染卡片')

// ── 2. 交互规格 ────────────────────────────────────────────────────────────
console.log('\n── 交互规格 ──')

check(cardSrc.includes('createPortal'), '点标签弹出浮层（createPortal 到 body）')
check(cardSrc.includes('data-closing={closing'), '退场动画期间保持挂载（data-closing）')
check(cardSrc.includes('closeTimerRef'), '退场动画定时器（260ms 后卸载）')
check(cardSrc.includes("document.addEventListener('pointerdown'"), '点浮层外面关闭（pointerdown 捕获）')
check(/onPointerDown[\s\S]{0,700}?close\(\)/.test(cardSrc), '点外面也走 close()（同样有退场动效，不是裸 setOpen(false)）')
check(cardSrc.includes("document.addEventListener('keydown'") && /event\.key !== 'Escape'/.test(cardSrc), 'Escape 关闭浮层（document 级监听，焦点不在弹层里也生效）')
check(cardSrc.includes('lastPopRef') && cardSrc.includes('cloneNode(true)'), '组件卸载时克隆幽灵副本播完退场（切会话 / 切形态）')
check(cardSrc.includes('ghost.remove()'), '幽灵副本 320ms 后自行移除')
check(cardSrc.includes('data-closing') && stylesSrc.includes('.fc-modal[data-closing="1"]'), '幽灵副本吃到 data-closing 的退场动画')
check(cardSrc.includes('type="button"'), '标签 / 按钮用原生 button（Enter / Space 由浏览器原生触发 click）')
check(cardSrc.includes('if (!loaded) return'), '首轮拉取未回时不触发生成（防误触）')
check(cardSrc.includes('rotate(-6deg)') && cardSrc.includes('rotate(-10deg)'), '两张卡两个角度：前 -6° / 后 -10°（白卡轻微逆时针插在胶囊上沿）')

// 图片：有图时 <img>，加载失败切 .fc-cover[data-empty] 大字占位。
check(cardSrc.includes('<img') && cardSrc.includes('className="fc-cover-img"'), '有图时渲染 <img className="fc-cover-img">')
check(cardSrc.includes('src={image.url}'), 'img.src 用宿主回填的 image.url')
check(/onError=\{\(\) => \{ setImageFailed\(true\) \}\}/.test(cardSrc), '图片 onError 切失败态（不展示裂图）')
check(cardSrc.includes("data-empty={coverEmpty ? '1' : undefined}"), '.fc-cover[data-empty] 标记无图 / 加载失败')
check(cardSrc.includes('className="fc-cover-name"'), '无图时用节日大字占位（.fc-cover-name）')

// kicker 必须按 festivalKicker 动态算，不能用记录里的旧值。
check(cardSrc.includes('festivalKicker({ name: card.name, date: card.festivalDate }, now)'), 'kicker 用 festivalKicker(card, now) 动态计算（不用记录旧值）')
check(!cardSrc.includes('.kicker') || cardSrc.includes('festivalKicker('), '卡头倒计时不在渲染层写死')

// 图注：来源 + 可点的 sourceUrl。
check(cardSrc.includes('图片来源：'), '图注显示「图片来源：{source}」')
check(cardSrc.includes('imageSourceOf(image)') && cardSrc.includes('imageSourceUrlOf(image)'), '图注来源 / 链接走本地纯函数（容错）')
check(cardSrc.includes('target="_blank"') && cardSrc.includes('rel="noreferrer"'), '图注来源外链 target=_blank + rel=noreferrer')
check(cardSrc.includes('^https?:\\/\\/'), '图注链接只接受 http(s) 绝对地址')

// 多卡翻页：左右按钮 + 滚轮。
check(cardSrc.includes('className="fc-page"'), '多卡时渲染 .fc-page 翻页')
check(cardSrc.includes('onWheel={handleWheel}'), '滚轮切换卡片（onWheel）')
check(cardSrc.includes('changeCard(-1)') && cardSrc.includes('changeCard(1)'), '左右按钮切换上一张 / 下一张')
check(cardSrc.includes('className="fc-progress"') && cardSrc.includes('data-on={index === safeIndex'), '页码进度条 .fc-progress 点亮当前卡')

// ── 3. 状态规格 ────────────────────────────────────────────────────────────
console.log('\n── 状态规格 ──')

check(cardSrc.includes('fc-skeleton'), '首次拉取显示骨架（.fc-skeleton）')
check(cardSrc.includes('正在准备节日卡'), '生成中文案「正在准备节日卡」')
check(cardSrc.includes('节日卡没做出来'), '失败文案「节日卡没做出来」')
check(/点(此|标签)重试/.test(cardSrc), '失败态点按重试')
check(cardSrc.includes('下一个节日：'), '空态显示「下一个节日：{name}」')
check(cardSrc.includes('最近三天里没有节气或节日'), '无临近节日时的空态文案')
check(cardSrc.includes("record.origin === 'fallback'") && cardSrc.includes('资料卡'), 'origin === fallback 时显示「资料卡」角标')
check(cardSrc.includes('className="fc-status"') && cardSrc.includes('className="fc-loading"'), '空 / 生成 / 失败态用 .fc-status + 生成中 .fc-loading')
check(/const POLL_MS = 60_000/.test(cardSrc), '前台轮询 60s')
check(/const POLL_MS_HIDDEN = 300_000/.test(cardSrc), '后台（document.hidden）轮询 5 分钟')
check(/const POLL_MS_GENERATING = 6_000/.test(cardSrc), '生成中轮询 6s')
check(cardSrc.includes('document.hidden'), '读取 document.hidden 降频')
check(cardSrc.includes('festivalDateKey(new Date())'), '用共享契约 festivalDateKey 判断跨日')
check(cardSrc.includes('setInterval'), '独立跨日哨兵（跨日立刻重拉）')
check(cardSrc.includes('truncate(error, ERROR_MAX)'), '失败原因按 ERROR_MAX 截断')
check(/const ERROR_MAX = 48/.test(cardSrc), 'ERROR_MAX = 48')
check(cardSrc.includes('ensureFestivalStyles()'), '渲染前调用 ensureFestivalStyles 注入样式')

// ── 4. 样式规格 ────────────────────────────────────────────────────────────
console.log('\n── 样式规格 ' + STYLE_PATH + ' ──')

check(/export function ensureFestivalStyles\s*\(\s*\)\s*:\s*void/.test(stylesSrc), '导出 ensureFestivalStyles(): void')
check(stylesSrc.includes("export const FESTIVAL_STYLE_ID = 'dsh-festival-card-styles'"), '样式表 id 是 dsh-festival-card-styles')
check(stylesSrc.includes('document.getElementById(FESTIVAL_STYLE_ID)'), '注入前按 id 查重（幂等）')
check(stylesSrc.includes('style.id = FESTIVAL_STYLE_ID'), '注入的 style 元素带固定 id')
check(stylesSrc.includes("style.dataset.plugin = 'dsh-festival-card'"), '注入的 style 元素带 data-plugin 标记')
check(stylesSrc.includes('document.head.appendChild(style)'), '样式表挂到 document.head')

for (const variable of ['--dpl-panel-bg', '--dpl-panel-border', '--dpl-panel-shadow', '--dpl-fg-dim', '--dpl-fg-weak', '--dpl-row-bg', '--dpl-row-hover', '--dpl-divider', '--dpl-warn']) {
  check(stylesSrc.includes(variable), '复用 ' + variable)
}
check(stylesSrc.includes('--fc-accent:#9c4a2f'), '暖棕强调色 --fc-accent:#9c4a2f')
check(stylesSrc.includes('body[data-ds-dark-theme]') && stylesSrc.includes('--fc-accent:#d99872'), '深色主题下强调色提亮（--fc-accent:#d99872）')
check(stylesSrc.includes('"Songti SC","SimSun","Noto Serif SC"'), '标题字体栈 Songti SC / SimSun / Noto Serif SC')

check(stylesSrc.includes('width:44%'), '标签宽度 44%（横排名称 + 圆形徽标 + 短块）')
check(stylesSrc.includes('left:30%'), '标签位置在胶囊上沿中段（left:30%，不贴两端）')
check(stylesSrc.includes('height:calc(36px'), '标签高度 36px（底边压进胶囊 9px，露出 27px，文字与徽标完整可见）')
check(stylesSrc.includes('transform-origin:bottom center'), '旋转原点 bottom center（左右两端都压进胶囊上沿）')
check(stylesSrc.includes('.dsh-festival-card[data-stack="back"]'), '后卡规则（错开 12px、z-index 更低）')
check(stylesSrc.includes('.fc-count{'), '圆形倒计时徽标 .fc-count 规则存在')
check(!stylesSrc.includes('.fc-mark{'), '不再有右端短块（用户反馈多余）')
check(cardSrc.includes('className="fc-count"'), '标签里渲染 fc-count')
check(cardSrc.includes('festivalDayDiff(now, item.festivalDate)'), '徽标数字来自共享契约的倒计时差值')
check(stylesSrc.includes('overflow:hidden'), '标签 overflow:hidden（超长节日名不撑破）')
check(stylesSrc.includes('cubic-bezier(.32,.72,0,1)') || stylesSrc.includes('cubic-bezier(.4,0,1,1)'), '过渡曲线与胶囊同一套')

check(stylesSrc.includes('.fc-modal{'), '遮罩 .fc-modal 规则存在')
check(stylesSrc.includes('.fc-sheet{'), '大卡 .fc-sheet 规则存在')
check(stylesSrc.includes('animation:fcSheetIn'), '划出入场动画 fcSheetIn')
check(stylesSrc.includes('animation:fcSheetOut'), '划出退场动画 fcSheetOut')
check(stylesSrc.includes('cubic-bezier(.4,0,1,1)'), '退场走加速曲线 cubic-bezier(.4,0,1,1)')
check(stylesSrc.includes('fcSheetOut .26s'), '退场时长 260ms')
check(/translateY\(2[68]px\) scale\(\.9[34]\)/.test(stylesSrc), '退场位移 26–28px / 缩到 0.93–0.94')
check(stylesSrc.includes('cubic-bezier(0,0,.2,1)'), '入场走减速曲线 cubic-bezier(0,0,.2,1)')
check(stylesSrc.includes('width:min(760px, 100%)'), '大卡宽度 760px 封顶')
check(stylesSrc.includes('height:min(560px, 82vh)'), '大卡高度 560px / 82vh 封顶')
check(stylesSrc.includes('grid-template-columns:minmax(0,46%) minmax(0,54%)'), '两栏 46% / 54% 网格（左图右文）')
check(stylesSrc.includes('overscroll-behavior:contain'), '浮层内部滚动不传染页面')
check(stylesSrc.includes('@keyframes fcShimmer'), '骨架 shimmer 动画')
check(stylesSrc.includes('@keyframes fcIndeterminate'), '生成中不确定进度条动画')
check(stylesSrc.includes('prefers-reduced-motion'), '尊重系统「减少动效」')
check(/@media \(max-width:640px\)/.test(stylesSrc), '窄屏（<640px）两栏收成上下两段')

// 关键 class 名：组件里出现的每个静态 fc-* / dsh-festival-card 类名都要在样式表里有定义，
// 防止「类名拼错 → 卡片裸奔但零报错」。
const classNames = new Set()
for (const match of cardSrc.matchAll(/className="([^"]+)"/g)) {
  for (const name of match[1].split(/\s+/)) if (name !== '') classNames.add(name)
}
const missingClasses = [...classNames].filter((name) => !stylesSrc.includes('.' + name))
check(missingClasses.length === 0, '组件用到的类名都在样式表里定义' + (missingClasses.length === 0 ? '' : '：' + missingClasses.join(', ')))
for (const required of ['dsh-festival-card', 'fc-modal', 'fc-sheet', 'fc-cover', 'fc-paper', 'fc-kicker', 'fc-title', 'fc-lede', 'fc-facts', 'fc-fact', 'fc-caption', 'fc-close', 'fc-page', 'fc-progress']) {
  check(cardSrc.includes(required) && stylesSrc.includes('.' + required), '关键 class ' + required + ' 在组件与样式里成对存在')
}

// ── 5. 依赖方向 ────────────────────────────────────────────────────────────
console.log('\n── 依赖方向 ──')

const importsOf = (source) => [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
const cardImports = importsOf(cardSrc)
const styleImports = importsOf(stylesSrc)
const isAllowed = (spec) => spec.startsWith('.') || spec === 'react' || spec === 'react-dom' || spec.startsWith('@deepseek-ai/')

check(cardImports.length > 0, 'festival-card.tsx 有 import（react + 共享契约 + 样式）')
check(cardImports.includes('react'), 'festival-card.tsx import react')
check(cardImports.includes('react-dom'), 'festival-card.tsx import react-dom（createPortal）')
check(cardImports.includes('../../shared/festival.ts'), 'festival-card.tsx 从共享契约 ../../shared/festival.ts 取类型与纯函数')
check(cardImports.includes('./festival-styles'), 'festival-card.tsx 从 ./festival-styles 取样式注入')
check(!cardImports.some((spec) => spec === './pill' || spec.endsWith('/pill')), 'festival-card.tsx 不 import ./pill（防循环依赖）')
check(cardImports.every(isAllowed), 'festival-card.tsx 无白名单外的第三方 import' + (cardImports.every(isAllowed) ? '' : '：' + cardImports.filter((s) => !isAllowed(s)).join(', ')))
check(styleImports.length === 0, 'festival-styles.ts 不 import 任何模块（尤其不 import ./pill）')

// ── 6. 共享契约一致性 ─────────────────────────────────────────────────────
console.log('\n── 共享契约 ' + SHARED_PATH + ' ──')

check(/export interface FestivalCard \{/.test(sharedSrc), '契约导出 FestivalCard 接口')
check(/export interface FestivalRecord \{/.test(sharedSrc), '契约导出 FestivalRecord')
check(/export interface FestivalTodayResponse \{/.test(sharedSrc), '契约导出 FestivalTodayResponse')
check(/export function festivalKicker\s*\(/.test(sharedSrc), '契约导出 festivalKicker')
check(/export function festivalCountdownLabel\s*\(/.test(sharedSrc), '契约导出 festivalCountdownLabel')
check(/export function festivalCardAriaLabel\s*\(/.test(sharedSrc), '契约导出 festivalCardAriaLabel')
check(/export function festivalDateKey\s*\(/.test(sharedSrc), '契约导出 festivalDateKey')
check(sharedSrc.includes("origin: 'model' | 'fallback'"), '契约的 origin 只有 model / fallback 两态')

// ── 7. 源码完整性：模板字面量反引号守卫 ───────────────────────────────────
console.log('\n── 源码完整性（构建脚本会硬失败的点）──')

const countBackticks = (source) => (source.match(/`/g) ?? []).length
check(countBackticks(stylesSrc) === 2, 'festival-styles.ts 恰好 2 个反引号（样式表模板首尾各一，注释里没有反引号）')
check(countBackticks(cardSrc) === 0, 'festival-card.tsx 不含模板字面量（字符串拼接，避开构建守卫）')

console.log(failed === 0 ? '\nPASSED' : '\nFAILED (' + failed + ')')
process.exit(failed === 0 ? 0 : 1)
