/**
 * dsh-seeker-bot — 节日卡（Festival Card）共享契约测试（纯 Node ESM）。
 *
 * 共享契约 src/shared/festival.ts 是两端唯一的数据模型：宿主用它算「未来 3 天
 * 有什么节气 / 节日」、拼提示词、清洗模型输出；浏览器用它算倒计时与无障碍标签。
 * 这里把纯函数的口径逐条钉死——日期差一天、倒计时写错一个字，卡就会在用户
 * 面前「看起来正常但内容错误」，这类错误不会抛异常，只能靠断言拦住。
 *
 * 覆盖：
 *   1. 节气日期表：2026 立冬 11-07、冬至 12-22；缺年份只返回固定节日；
 *   2. upcomingFestivals：窗口边界、跨年窗口（2026-12-28 → 元旦 / 小寒）；
 *   3. 日期展示与倒计时：festivalDateLabel / festivalDateShort / 今天 / 明天 / 还有三天；
 *   4. 生图提示词：节气 / 食物 / 竖幅 / 无水印都写进提示词；
 *   5. 提示词：festivalSystemPrompt 含 JSON 形状；user 提示词含节日资料；
 *   6. 清洗：空 / 坏 JSON → null；正常 JSON → 合法记录；facts 上限 3 条；
 *   7. 兜底卡：title / lede / facts 存在，且不伪造图片。
 *
 * ── 为什么用 esbuild 现场打包 ────────────────────────────────────────────
 *
 * 被测模块是 TS（带 .ts 后缀 import），Node 直接跑不了；仓库的 build.mjs 会
 * 把整包产物写进 lib/，与并行改动的队友冲突。所以用项目自带的 esbuild 把
 * src/shared/festival.ts（连同 festival-data.ts）打成一个临时 ESM，断言的
 * 仍是真正会跑的那份源码。
 *
 * 跑法：node scripts/test-festival-card-shared.mjs（非 0 退出码 = 有失败）
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

let esbuild
try {
  esbuild = require('esbuild')
} catch {
  console.error('缺少 esbuild（本仓库 devDependency）：先跑 pnpm install')
  process.exit(1)
}

const ROOT = process.cwd()
const OUT = mkdtempSync(join(tmpdir(), 'dsh-festival-shared-'))

await esbuild.build({
  entryPoints: {
    shared: join(ROOT, 'src/shared/festival.ts'),
  },
  outdir: OUT,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  logLevel: 'error',
})

const shared = await import(pathToFileURL(join(OUT, 'shared.mjs')).href)

const {
  FESTIVAL_MAX_CARDS,
  FESTIVAL_WINDOW_DAYS,
  SOLAR_TERM_DATES,
  buildFestivalUserPrompt,
  festivalCardAriaLabel,
  festivalCatalog,
  festivalCountdownLabel,
  festivalDateKey,
  festivalDateLabel,
  festivalDateShort,
  festivalDayDiff,
  festivalFallbackCard,
  festivalImagePrompt,
  festivalKicker,
  festivalNextOf,
  festivalSystemPrompt,
  parseFestivalDate,
  sanitizeFestivalRecord,
  upcomingFestivals,
} = shared

/* ───────────────────────────── 断言框架 ───────────────────────────── */

let passed = 0
const failures = []

async function test(name, run) {
  try {
    await run()
    passed += 1
    console.log('✓ ' + name)
  } catch (error) {
    failures.push([name, error])
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error('✗ ' + name + '\n  ' + detail)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）')
  }
}

const entryById = (list, id) => list.find((item) => item.id === id)

const lidong2026 = () => entryById(festivalCatalog(2026), 'lidong')

/* ───────────────────────────── 一、节气日期表 ───────────────────────────── */

await test('festivalCatalog：2026 立冬 11-07、冬至 12-22，24 节气 + 8 固定节日', () => {
  const catalog = festivalCatalog(2026)
  const lidong = entryById(catalog, 'lidong')
  assert(lidong !== undefined, '2026 目录缺少立冬')
  assertEqual(lidong.name, '立冬', '立冬名称')
  assertEqual(lidong.date, '2026-11-07', '2026 立冬日期（参考图口径 11 月 7 日）')
  assertEqual(lidong.kind, 'solar-term', '立冬 kind')
  assertEqual(lidong.season, 'winter', '立冬 season')

  const dongzhi = entryById(catalog, 'dongzhi')
  assert(dongzhi !== undefined, '2026 目录缺少冬至')
  assertEqual(dongzhi.date, '2026-12-22', '2026 冬至日期')

  assertEqual(Object.keys(SOLAR_TERM_DATES[2026]).length, 24, '2026 节气表应有 24 个节气')
  assertEqual(catalog.filter((item) => item.kind === 'solar-term').length, 24, '2026 目录应有 24 个节气')
  assertEqual(catalog.filter((item) => item.kind === 'festival').length, 8, '固定公历节日应有 8 个')

  // 按日期升序：列表展示 / 取第一个节日的实现都依赖这个顺序。
  const dates = catalog.map((item) => item.date)
  assert(dates.every((date, index) => index === 0 || dates[index - 1] <= date), '目录必须按日期升序：' + dates.join(','))

  // 固定节日：元旦与圣诞的日期必须是 01-01 / 12-25。
  const yuandan = entryById(catalog, 'yuandan')
  assertEqual(yuandan !== undefined ? yuandan.date : '', '2026-01-01', '2026 元旦日期')
  assertEqual(entryById(catalog, 'shengdanjie')?.date, '2026-12-25', '2026 圣诞节日期')
})

await test('festivalCatalog：缺年份表（2025）只返回固定节日，不猜节气', () => {
  const catalog = festivalCatalog(2025)
  assertEqual(catalog.filter((item) => item.kind === 'solar-term').length, 0, '2025 没有节气表，不得返回任何节气')
  assertEqual(catalog.filter((item) => item.kind === 'festival').length, 8, '2025 仍应返回 8 个固定节日')
})

/* ───────────────────────────── 二、未来窗口 ───────────────────────────── */

await test('upcomingFestivals：2026-11-05 起 10 天 → 立冬（还有两天）', () => {
  const today = new Date(2026, 10, 5, 9, 30, 0)
  const list = upcomingFestivals(today, 10)
  assertEqual(list.length, 1, '窗口内应只有立冬一个节日，实际：' + list.map((item) => item.name).join(','))
  const lidong = list[0]
  assertEqual(lidong.id, 'lidong', '窗口第一个应是立冬')
  assertEqual(lidong.date, '2026-11-07', '立冬日期')
  assert(!list.some((item) => item.id === 'xiaoxue'), '小雪（11-22）在 10 天窗口外，不应出现')
  assertEqual(festivalCountdownLabel('2026-11-07', today), '还有两天', '11-05 看 11-07 的倒计时')
  assertEqual(festivalKicker(lidong, today), '立冬 · 还有两天', '眉标应是「立冬 · 还有两天」')

  // 窗口边界：当天（0 天）包含，第 10 天包含，第 11 天不包含。
  const boundary = upcomingFestivals(new Date(2026, 10, 5), 10)
  assertEqual(boundary.length, 1, '10 天窗口边界不应变化')
  assertEqual(festivalDayDiff(new Date(2026, 10, 5), '2026-11-05'), 0, '当天差值为 0')
  assertEqual(FESTIVAL_WINDOW_DAYS, 3, '默认窗口应为 3 天（当前产品口径）')
})

await test('upcomingFestivals：默认窗口只覆盖前 3 天', () => {
  assertEqual(upcomingFestivals(new Date(2026, 10, 5, 9, 0, 0)).length, 1, '11-05 默认窗口应含立冬')
  assertEqual(upcomingFestivals(new Date(2026, 10, 4, 9, 0, 0)).length, 1, '11-04 距立冬 3 天，正好进窗口')
  assertEqual(upcomingFestivals(new Date(2026, 10, 1, 9, 0, 0)).length, 0, '11-01 距立冬 6 天，默认窗口应为空')
  assertEqual(upcomingFestivals(new Date(2026, 10, 8, 9, 0, 0)).length, 0, '11-08 立冬已过，默认窗口应为空')
})

await test('upcomingFestivals：2026-12-28 跨年窗口 → 元旦 / 小寒', () => {
  const today = new Date(2026, 11, 28, 8, 0, 0)
  const list = upcomingFestivals(today, 10)
  const ids = list.map((item) => item.id)
  assert(ids.includes('yuandan'), '跨年窗口应包含元旦，实际：' + ids.join(','))
  assert(ids.includes('xiaohan'), '跨年窗口应包含小寒，实际：' + ids.join(','))
  assertEqual(entryById(list, 'yuandan').date, '2027-01-01', '跨年元旦应取 2027 年日期')
  assertEqual(entryById(list, 'xiaohan').date, '2027-01-05', '2027 小寒日期')
  // 窗口上界是 2027-01-07：元旦（01-01）必须排在小寒（01-05）前面。
  const yuanIndex = ids.indexOf('yuandan')
  const xiaoIndex = ids.indexOf('xiaohan')
  assert(yuanIndex < xiaoIndex, '窗口内应按日期升序：元旦在小寒之前')
  for (const item of list) {
    const diff = festivalDayDiff(today, item.date)
    assert(diff >= 0 && diff <= 10, '窗口外的节日被带进来了：' + item.name + ' ' + item.date)
  }
  // 跨年查询不能把 2026 已过去的冬至 / 圣诞带回来。
  assert(!ids.includes('dongzhi'), '已过去的冬至不应出现在未来窗口')
  assert(!ids.includes('shengdanjie'), '已过去的圣诞节不应出现在未来窗口')
})

await test('festivalNextOf：空态标签用的轻量描述形状正确', () => {
  const today = new Date(2026, 10, 5)
  const next = festivalNextOf(lidong2026(), today)
  assertEqual(next.festivalId, 'lidong', 'festivalId')
  assertEqual(next.name, '立冬', 'name')
  assertEqual(next.festivalDate, '2026-11-07', 'festivalDate')
  assertEqual(next.dateLabel, '2026 年 11 月 7 日，周六', 'dateLabel')
  assertEqual(next.countdown, '还有两天', 'countdown')
})

/* ───────────────────────────── 三、日期展示与倒计时 ───────────────────────────── */

await test('festivalDateLabel / festivalDateShort / festivalDateKey：格式与本地时区口径', () => {
  assertEqual(festivalDateLabel('2026-11-07'), '2026 年 11 月 7 日，周六', '完整展示格式')
  assertEqual(festivalDateShort('2026-11-07'), '11 月 7 日 · 周六', '短展示格式')
  assertEqual(festivalDateLabel('2027-01-01'), '2027 年 1 月 1 日，周五', '跨年日期格式')

  // 本地时区：凌晨 00:30 仍应是当天，不能被 toISOString 算成前一天（UTC+8 常见坑）。
  assertEqual(festivalDateKey(new Date(2026, 10, 7, 0, 30, 0)), '2026-11-07', '凌晨日期键不能漂到昨天')
  assertEqual(festivalDateKey(new Date(2026, 10, 7, 23, 59, 0)), '2026-11-07', '深夜日期键')
  assertEqual(parseFestivalDate('2026-11-07').getHours(), 12, '解析到本地正午（避免 UTC 切日）')
})

await test('festivalCountdownLabel：今天 / 明天 / 还有三天 / 十天 / 阿拉伯数字', () => {
  const today = new Date(2026, 10, 5, 15, 0, 0)
  assertEqual(festivalCountdownLabel('2026-11-05', today), '今天', '当天')
  assertEqual(festivalCountdownLabel('2026-11-04', today), '今天', '已过去按今天处理')
  assertEqual(festivalCountdownLabel('2026-11-06', today), '明天', '隔一天')
  assertEqual(festivalCountdownLabel('2026-11-08', today), '还有三天', '隔三天（中文数字）')
  assertEqual(festivalCountdownLabel('2026-11-15', today), '还有十天', '第 10 天用「十」')
  assertEqual(festivalCountdownLabel('2026-11-16', today), '还有 11 天', '超过 10 天改用阿拉伯数字并留空格')
})

/* ───────────────────────────── 四、配图提示词 ───────────────────────────── */

await test('festivalImagePrompt：节气 / 食物 / 竖幅 / 无水印都写进生图提示词', () => {
  const entry = lidong2026()
  const prompt = festivalImagePrompt(entry)
  assert(prompt.includes('立冬'), '含节气名')
  assert(prompt.includes('羊肉') || prompt.includes('饺子'), '含应季食物')
  assert(prompt.includes('竖幅'), '竖幅构图（大卡左栏是竖图）')
  assert(prompt.includes('水印') && prompt.includes('文字'), '明确要求不要水印 / 文字')
  assert(prompt.length > 40 && prompt.length < 300, '提示词长度合理')
})

/* ───────────────────────────── 五、提示词 ───────────────────────────── */

await test('festivalSystemPrompt：含 JSON 形状与关键写作约束', () => {
  const prompt = festivalSystemPrompt()
  assert(prompt.includes('{"cards":[{"title":"","lede":"","facts":[{"label":"","value":""}]}]}'), '必须带完整 JSON 形状示例')
  assert(prompt.includes('只输出一个 JSON 对象'), '必须要求只输出 JSON')
  assert(prompt.includes('不得编造'), '必须带反编造约束')
  assert(prompt.includes('title') && prompt.includes('lede') && prompt.includes('facts'), '必须说明 title/lede/facts')
})

await test('buildFestivalUserPrompt：日期、节日资料与倒计时都进提示词', () => {
  const prompt = buildFestivalUserPrompt(lidong2026(), new Date(2026, 10, 5, 9, 0, 0))
  assert(prompt.includes('2026-11-05'), '缺少今天日期')
  assert(prompt.includes('立冬'), '缺少节日名')
  assert(prompt.includes('二十四节气'), '节气类型标识')
  assert(prompt.includes('2026 年 11 月 7 日，周六'), '缺少完整日期')
  assert(prompt.includes('还有两天'), '缺少倒计时')
  assert(prompt.includes('北方饺子'), '缺少内置应季食物资料')
  assert(prompt.includes('请按 system 里的规格写 1 张卡，只输出 JSON'), '缺少输出要求')
})

/* ───────────────────────────── 六、清洗 ───────────────────────────── */

const metaOf = () => ({
  entry: lidong2026(),
  origin: 'model',
  model: 'test-provider/test-model',
  elapsedMs: 1234,
  generatedAt: 1_700_000_000_000,
  today: new Date(2026, 10, 5, 10, 0, 0),
})

await test('sanitizeFestivalRecord：空 / 坏 JSON → null，绝不抛', () => {
  const meta = metaOf()
  for (const payload of [null, undefined, '', 'not json', 42, [], {}, { cards: [] }, { cards: [null] }, { cards: [{}] }, { cards: [{ title: '   ' }] }]) {
    let result
    try {
      result = sanitizeFestivalRecord(payload, meta)
    } catch (error) {
      throw new Error('坏输入不应抛异常：' + JSON.stringify(payload) + ' → ' + String(error))
    }
    assertEqual(result, null, '坏输入必须返回 null：' + JSON.stringify(payload))
  }
})

await test('sanitizeFestivalRecord：正常 JSON → 合法记录（facts 上限 3 条）', () => {
  const meta = metaOf()
  const record = sanitizeFestivalRecord({
    cards: [{
      title: '立冬的羊肉汤，四川人最后涮的是豌豆尖',
      lede: '北方这天吃饺子，四川人却要炖一锅奶白的羊肉汤，涮一把豌豆尖。',
      facts: [
        { label: '北方', value: '吃饺子' },
        { label: '', value: '坏标签应被丢弃' },
        { label: '四川', value: '羊肉汤涮豌豆尖' },
        { label: '时节', value: '水始冰，地始冻' },
        { label: '多余', value: '第四条应被截断' },
      ],
    }],
  }, meta)

  assert(record !== null, '合法输出不应返回 null')
  assertEqual(record.date, '2026-11-05', '记录日期取 today')
  assertEqual(record.dateLabel, '11 月 5 日 · 周四', '记录展示日期')
  assertEqual(record.festivalDate, '2026-11-07', '记录节日日期')
  assertEqual(record.generatedAt, 1_700_000_000_000, 'generatedAt 原样保留')
  assertEqual(record.model, 'test-provider/test-model', 'model 透传')
  assertEqual(record.elapsedMs, 1234, 'elapsedMs 透传')
  assertEqual(record.origin, 'model', 'origin')
  assertEqual(record.cards.length, 1, '应生成 1 张卡')
  const card = record.cards[0]
  assertEqual(card.id, '2026-11-07-lidong', '卡 id = 日期-id')
  assertEqual(card.festivalId, 'lidong', 'festivalId')
  assertEqual(card.festivalDate, '2026-11-07', '卡 festivalDate')
  assertEqual(card.name, '立冬', '卡 name')
  assertEqual(card.kind, 'solar-term', '卡 kind')
  assertEqual(card.title, '立冬的羊肉汤，四川人最后涮的是豌豆尖', '卡 title')
  assert(card.lede.startsWith('北方这天吃饺子'), '卡 lede')
  assertEqual(card.facts.length, 3, 'facts 最多保留 3 条')
  assertEqual(card.facts[0].label, '北方', 'facts[0].label')
  assertEqual(card.facts[1].label, '四川', '空 label 应被丢弃')
  assertEqual(card.image, null, '清洗阶段图片必须为 null（由宿主回填）')

  // 超长标题截断（模型不听话时不能把 300 字塞进标题）。
  const longRecord = sanitizeFestivalRecord({ cards: [{ title: '甲'.repeat(100) }] }, metaOf())
  assert(longRecord !== null, '只有标题也应合法')
  assertEqual(longRecord.cards[0].title.length, 61, '标题截断到 60 字 + 省略号')
  assert(longRecord.cards[0].title.endsWith('…'), '截断后带省略号')

  // 一次给 3 张卡：最多保留 FESTIVAL_MAX_CARDS（2）张。
  const many = sanitizeFestivalRecord({ cards: [{ title: '一' }, { title: '二' }, { title: '三' }] }, metaOf())
  assertEqual(many.cards.length, FESTIVAL_MAX_CARDS, '最多 2 张卡')
})

/* ───────────────────────────── 七、兜底卡 ───────────────────────────── */

await test('festivalFallbackCard：有 title / lede / facts，且不伪造图片', () => {
  const lidong = lidong2026()
  const card = festivalFallbackCard(lidong)
  assertEqual(card.id, '2026-11-07-lidong', '兜底卡 id')
  assertEqual(card.festivalId, 'lidong', '兜底卡 festivalId')
  assertEqual(card.name, '立冬', '兜底卡 name')
  assert(card.title.includes('立冬'), '兜底卡 title 要含节日名')
  assert(card.title.includes('北方饺子'), '兜底卡 title 要落到具体食物')
  assert(card.lede.startsWith(lidong.blurb), '兜底卡 lede 应基于内置释义')
  assert(card.facts.length >= 2, '兜底卡至少 2 条 facts')
  assert(card.facts.some((item) => item.label === '吃什么'), '兜底卡应有「吃什么」')
  assertEqual(card.image, null, '兜底卡没有图片，前端用大字占位')
  assertEqual(card.kind, 'solar-term', '兜底卡 kind')

  const aria = festivalCardAriaLabel(card, new Date(2026, 10, 5))
  assertEqual(aria, '节日卡：立冬 · 还有两天，' + card.title, '无障碍标签格式')
})

/* ───────────────────────────── 收尾 ───────────────────────────── */

try {
  rmSync(OUT, { recursive: true, force: true })
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log('\n[festival shared] 通过 ' + String(passed) + ' 项')
for (const [name, error] of failures) {
  console.error('✗ ' + name + '\n  ' + String(error && error.stack ? error.stack : error))
}
if (failures.length > 0) {
  console.error('[festival shared] 失败 ' + String(failures.length) + ' 项')
  process.exitCode = 1
}
