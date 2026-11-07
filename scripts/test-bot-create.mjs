/**
 * `bot_create`（主 Bot 在对话里创建子 Bot）的回归测试。
 *
 * 覆盖 `src/host/personal/bot-create.ts` 的全部可观察行为：
 *
 *  1. 参数校验：空名字 / 空岗位 / 超长字段 / 重名 —— 每种拒绝都要给出**给模型
 *     看的中文句子**（模型靠它自己纠错，错误措辞退化成错误码就等于没纠错）；
 *  2. 默认值：不给 instructions 时按「名字 + 岗位 + 简介」拼身份提示；不给
 *     group_id 时字段不落（不是落一个空串）；
 *  3. id 生成：`bot-` + 8 位十六进制，且与已有记录不撞；
 *  4. 落盘：创建后账本文件真的写出来了，重新读盘内容一致，第二条是追加；
 *  5. 广播：事件发在**创建者**通道上，形状与前端契约逐字对齐；
 *  6. 花名册写回：建完立刻能被 `coordinate_bots` 看到（否则模型下一句派活
 *     就会被告知「没有这个 Bot」）；
 *  7. 落盘失败时返回 `ok: false`，且**不**广播、不写花名册 —— 不能出现
 *     「前端看到了、重启后没了」。
 *
 * ── 为什么用 esbuild 现场打包 ────────────────────────────────────────
 * 源码是 .ts、`lib/index.js` 是整插件单文件，两者都不能按模块 import。这里用
 * esbuild（本仓库 devDependency）把被测模块打成一个临时 ESM 包再 import，
 * 断言的是**真正会跑的那份源码**。
 *
 * Usage: node scripts/test-bot-create.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failed = 0
const pass = (msg) => console.log('ok    ' + msg)
const fail = (msg) => { console.error('FAIL  ' + msg); failed += 1 }
const assert = (cond, msg) => { if (cond) pass(msg); else fail(msg) }
const assertEqual = (actual, expected, msg) => {
  if (actual === expected) pass(msg)
  else fail(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

/** Windows 路径 → import URL 可用的正斜杠形式。 */
const slash = (p) => p.replace(/[\\]/g, '/')

// ── 隔离的 DSH_HOME：账本写进临时目录，绝不碰用户真实数据 ──────────────
const home = mkdtempSync(join(tmpdir(), 'dsh-bot-create-home-'))
process.env.DSH_HOME = home

const outDir = mkdtempSync(join(tmpdir(), 'dsh-bot-create-bundle-'))
let mod

try {
  const entry = join(outDir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * from '${slash(resolve(ROOT, 'src/host/personal/bot-create.ts'))}'`,
      `export { subscribe, subscribeAll, parseSinceByBot, resetChannels, publish } from '${slash(resolve(ROOT, 'src/host/personal/events.ts'))}'`,
      `export { setBotSpecWriter } from '${slash(resolve(ROOT, 'src/host/personal/runtime/registry.ts'))}'`,
      '',
    ].join('\n'),
    'utf8',
  )
  const bundleFile = join(outDir, 'bot-create.mjs')
  await build({
    entryPoints: [entry],
    outfile: bundleFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  })
  mod = await import(pathToFileURL(bundleFile).href)
} catch (error) {
  console.error('打包失败：', error instanceof Error ? error.message : error)
  process.exit(1)
}

const {
  planBotCreate,
  createBot,
  readCreatedBots,
  createdBotsFile,
  __resetCreatedBotsCache,
  removeCreatedBot,
  installBotCreateTool,
  subscribe,
  subscribeAll,
  parseSinceByBot,
  resetChannels,
  publish,
  setBotSpecWriter,
} = mod

// ── 1. 参数校验 ─────────────────────────────────────────────────────────
console.log('\n# 参数校验')

const base = { createdBy: 'bot-main', now: 1_700_000_000_000, id: 'bot-fixed01' }

{
  const plan = planBotCreate({ name: '   ', role: '调研' }, base)
  assert(plan.ok === false, '空名字被拒绝')
  assert(plan.ok === false && plan.error.includes('name'), '空名字的错误里点名 name 字段')
}

{
  const plan = planBotCreate({ name: '调研助手', role: '' }, base)
  assert(plan.ok === false && plan.error.includes('role'), '空岗位被拒绝且点名 role')
}

{
  const plan = planBotCreate({ name: '名'.repeat(25), role: '调研' }, base)
  assert(plan.ok === false && plan.error.includes('太长'), '名字超 24 字被拒绝')
}

{
  // 24 字整好是边界，必须放行（边界写错会让用户建不出合法名字）
  const plan = planBotCreate({ name: '名'.repeat(24), role: '调研' }, base)
  assert(plan.ok === true, '名字 24 字（边界值）放行')
}

{
  const plan = planBotCreate({ name: '调研助手', role: '调研' }, {
    ...base,
    existing: [{ id: 'bot-old', name: '调研助手', role: '调研', description: '', instructions: '', createdAt: 1, createdBy: 'bot-main' }],
  })
  assert(plan.ok === false && plan.error.includes('已经有一个叫'), '重名被拒绝，错误里说明已有同名 Bot')
  assert(plan.ok === false && plan.error.includes('coordinate_bots'), '重名的错误给出替代做法（直接派活）')
}

// ── 2. 默认值 ───────────────────────────────────────────────────────────
console.log('\n# 默认值')

{
  const plan = planBotCreate({ name: '调研助手', role: '竞品调研', description: '盯竞品动态' }, base)
  assert(plan.ok === true, '合法参数创建成功')
  if (plan.ok) {
    /*
     * 2026-11-07 改口径：没给 instructions 时**保持空**，不再拼「你是「X」，Y。
     * 说话直接、先给结论再解释」——那里面藏着系统替用户定的性格。性格现在归
     * Bot.persona（可空），空着就不注入（见 host 的 buildBotPrompt）。
     */
    assert(plan.record.instructions === '', '未给 instructions 时留空，不再自动生成人设')
    assertEqual(plan.record.id, 'bot-fixed01', 'id 用注入值（便于测试）')
    assertEqual(plan.record.createdAt, base.now, 'createdAt 用注入时间')
    assertEqual(plan.record.createdBy, 'bot-main', 'createdBy 记录创建者')
    assert(!('groupId' in plan.record), '不给 group_id 时不落该字段（不是落空串）')
  }
}

{
  const plan = planBotCreate({ name: '写手', role: '文案', instructions: '你只写短句。' }, base)
  assert(plan.ok === true && plan.record.instructions === '你只写短句。', '显式 instructions 原样保留')
}

{
  const plan = planBotCreate({ name: '写手', role: '文案', group_id: 'g-1' }, base)
  assert(plan.ok === true && plan.record.groupId === 'g-1', 'group_id 有值时落字段')
}

// ── 3. id 生成 ──────────────────────────────────────────────────────────
console.log('\n# id 生成')

{
  const plan = planBotCreate({ name: '无注入', role: '测试' }, { createdBy: 'bot-main', now: 1 })
  assert(plan.ok === true && /^bot-[0-9a-f]{8}$/.test(plan.record.id), '随机 id 形如 bot-xxxxxxxx')
  // 同参数再生成一次必须不同 id（不能靠时间戳兜底）
  const again = planBotCreate({ name: '无注入2', role: '测试' }, { createdBy: 'bot-main', now: 1 })
  assert(again.ok === true && again.record.id !== plan.record.id, '两次随机生成的 id 不同')
}

// ── 4. 落盘 ─────────────────────────────────────────────────────────────
console.log('\n# 落盘')

{
  // 清掉内存缓存，从「空盘」开始
  rmSync(createdBotsFile(), { force: true })
  __resetCreatedBotsCache()
  assertEqual(readCreatedBots().length, 0, '空盘时账本为空数组')

  const first = createBot({ name: '调研助手', role: '竞品调研' }, { createdBy: 'bot-main' })
  assert(first.ok === true && typeof first.bot_id === 'string', 'createBot 返回 ok 与 bot_id')

  const onDisk = JSON.parse(readFileSync(createdBotsFile(), 'utf8'))
  assert(Array.isArray(onDisk) && onDisk.length === 1, '账本文件已写出且有一条记录')
  assertEqual(onDisk[0].name, '调研助手', '落盘记录名字正确')
  assertEqual(onDisk[0].createdBy, 'bot-main', '落盘记录带创建者')

  const second = createBot({ name: '写手', role: '文案' }, { createdBy: 'bot-main' })
  assert(second.ok === true, '第二条创建成功')
  __resetCreatedBotsCache()
  const reloaded = readCreatedBots()
  assertEqual(reloaded.length, 2, '重新读盘拿到两条（追加而不是覆盖）')
  assertEqual(reloaded[1].name, '写手', '第二条在末尾')
}

// ── 5. 删除（防「删不掉的 Bot」）───────────────────────────────────────
console.log('\n# 删除')

{
  /*
   * 账本是给前端**补发**用的。用户删掉一个子 Bot 后如果账本还留着它，下次
   * 页面加载 `/bots/created` 就会把它重新加回来——表现为「删不掉的 Bot」。
   * 所以前端删除 Bot 时会顺手调一次 `DELETE /bots/created`，对应这里的
   * `removeCreatedBot`。
   */
  const target = readCreatedBots()[0]
  assert(target !== undefined, '账本里有一条可删的记录')
  if (target !== undefined) {
    assert(removeCreatedBot(target.id) === true, 'removeCreatedBot 返回 true 表示真的删掉了')
    __resetCreatedBotsCache()
    assert(!readCreatedBots().some((item) => item.id === target.id), '重新读盘后那条记录不在了')
    assert(removeCreatedBot(target.id) === false, '再删一次返回 false（不存在的 id 不抛错）')
  }
  assert(removeCreatedBot('') === false, '空 id 返回 false')
}

// ── 6. 广播 ─────────────────────────────────────────────────────────────
console.log('\n# 广播')

{
  resetChannels()
  const seen = []
  const off = subscribe('bot-main', (event) => seen.push(event))

  const result = createBot({ name: '播报助手', role: '播报' }, { createdBy: 'bot-main' })
  off()

  assert(result.ok === true, '创建成功')
  const event = seen.find((item) => item.type === 'bot-created')
  assert(event !== undefined, '创建者通道上收到 bot-created 事件')
  if (event !== undefined) {
    assertEqual(event.botId, 'bot-main', '事件发在创建者通道上（不是新 Bot 的）')
    assertEqual(event.bot.name, '播报助手', '事件带着新 Bot 的名字')
    assertEqual(event.bot.id, result.bot_id, '事件里的 id 与返回值一致')
    assertEqual(event.source, 'agent', 'source 标记为 agent')
    assert(typeof event.seq === 'number', '事件带序号')
    assertEqual(typeof event.bot.instructions, 'string', '事件带 instructions（前端要建完整 Bot）')
  }
}

{
  // 另一个通道不该收到：前端为每个 Bot 建一条 SSE，串台会让别的 Bot 界面冒出提示
  resetChannels()
  const other = []
  const off = subscribe('bot-someone-else', (event) => other.push(event))
  createBot({ name: '隔离助手', role: '隔离' }, { createdBy: 'bot-main' })
  off()
  assertEqual(other.length, 0, '别的 Bot 通道收不到这次创建（事件不串台）')
}

// ── 6b. 补发游标（前端重连带 since，整条链路依赖这条语义）──────────────
console.log('\n# 补发游标')

{
  /*
   * 前端现在重连时会带 `since=<已收到的最大 seq>`（见 store.tsx 的
   * `hostEventSeqRef`）。这条链路成立的前提是宿主**严格只补发 seq > since**：
   *
   *  · 补少了 → 断线窗口里的事件永久丢失，正是这次要修的问题；
   *  · 补多了 → 重复事件，前端按 id / at 去重能扛住，但白白多传数据；
   *  · 边界错一位（>= 而不是 >）→ 每次重连都重复收最后一条，日志里会看到
   *    同一条例行任务结果反复出现。
   *
   * 所以直接钉住边界：since=2 只该收到 3 和 4。
   */
  resetChannels()
  publish('bot-cursor', { type: 'status', status: 'idle' })
  publish('bot-cursor', { type: 'status', status: 'thinking' })
  publish('bot-cursor', { type: 'status', status: 'idle' })
  publish('bot-cursor', { type: 'status', status: 'idle' })

  const replay = []
  subscribe('bot-cursor', (event) => replay.push(event.seq), 2)()
  assertEqual(replay.join(','), '3,4', 'since=2 只补发 seq 3 与 4（严格大于）')

  const none = []
  subscribe('bot-cursor', (event) => none.push(event.seq), 4)()
  assertEqual(none.length, 0, 'since 等于最新序号时不补发（不会重复收最后一条）')

  const all = []
  subscribe('bot-cursor', (event) => all.push(event.seq), 0)()
  assertEqual(all.length, 0, 'since=0 不补发历史（首次连接只要增量）')
}

// ── 6c. 合并连接（一条 SSE 订阅全部 Bot）────────────────────────────────
console.log('\n# 合并连接')

{
  /*
   * 前端现在只建**一条** SSE（`botId=*`）。这条链路有三件事必须成立：
   *
   *  1. 所有 Bot 的事件都送到同一个监听者——否则某个 Bot 的推送会静默消失；
   *  2. 退订后不再收——否则切页面会泄漏监听者，宿主内存只涨不降；
   *  3. 逐 Bot 补发：since 是 Map，各通道按自己的进度补（共用一个数字会截错）。
   */
  resetChannels()
  publish('bot-a', { type: 'status', status: 'idle' })
  publish('bot-b', { type: 'status', status: 'idle' })
  publish('bot-a', { type: 'status', status: 'thinking' })

  const seen = []
  const off = subscribeAll((event) => seen.push(`${event.botId}#${event.seq}`))
  publish('bot-b', { type: 'status', status: 'thinking' })
  off()
  publish('bot-a', { type: 'status', status: 'idle' })

  assertEqual(seen.join(','), 'bot-b#2', '合并订阅收到所有 Bot 的实时事件，退订后不再收')
}

{
  // 逐 Bot 补发：bot-a 只补 seq>1，bot-b 只补 seq>1，互不干扰
  resetChannels()
  publish('bot-a', { type: 'status', status: 'idle' })
  publish('bot-a', { type: 'status', status: 'idle' })
  publish('bot-a', { type: 'status', status: 'idle' })
  publish('bot-b', { type: 'status', status: 'idle' })
  publish('bot-b', { type: 'status', status: 'idle' })

  const replay = []
  const off = subscribeAll(
    (event) => replay.push(`${event.botId}#${event.seq}`),
    new Map([['bot-a', 1], ['bot-b', 1]]),
  )
  off()
  assertEqual(replay.join(','), 'bot-a#2,bot-a#3,bot-b#2', '逐 Bot 补发：各自按自己的游标补，互不干扰')
}

{
  resetChannels()
  publish('bot-c', { type: 'status', status: 'idle' })
  const replay = []
  const off = subscribeAll((event) => replay.push(event.seq))
  off()
  assertEqual(replay.length, 0, '没有游标时不补发历史（首次连接只要增量）')
}

{
  const parsed = parseSinceByBot('bot-a:5,bot-b:3')
  assert(parsed instanceof Map && parsed.get('bot-a') === 5 && parsed.get('bot-b') === 3, 'parseSinceByBot 解析逐 Bot 游标')
  assertEqual(parseSinceByBot(''), undefined, '空串 → undefined（首次连接）')
  assertEqual(parseSinceByBot('bad,bot-c:0,bot-d:-1'), undefined, '坏片段与非法序号全部跳过')
  const mixed = parseSinceByBot('bot-e:2,junk')
  assert(mixed instanceof Map && mixed.size === 1 && mixed.get('bot-e') === 2, '单个坏片段不影响其它有效项')
}

// ── 7. 花名册写回 ───────────────────────────────────────────────────────
console.log('\n# 花名册写回')

{
  const written = []
  setBotSpecWriter((spec) => written.push(spec))

  const result = createBot({ name: '花名册助手', role: '登记' }, { createdBy: 'bot-main' })
  assert(result.ok === true, '创建成功')
  assertEqual(written.length, 1, '写回了一次花名册')
  if (written.length === 1) {
    assertEqual(written[0].botId, result.bot_id, '写回的 botId 与返回值一致')
    assertEqual(written[0].name, '花名册助手', '写回的名字正确')
    assertEqual(written[0].role, '登记', '写回的岗位正确')
  }
  // 还原，避免影响后续用例
  setBotSpecWriter(() => {})
}

{
  // 没有写回通道（运行时没起来）时不能抛错：Bot 照常能建，只是暂时派不了活
  setBotSpecWriter(() => {})
  let threw = false
  try {
    createBot({ name: '无通道助手', role: '兜底' }, { createdBy: 'bot-main' })
  } catch {
    threw = true
  }
  assert(threw === false, '没有花名册写回通道时不抛错')
}

// ── 8. 工具注册 ─────────────────────────────────────────────────────────
console.log('\n# 工具注册')

{
  /*
   * 用一个假的 agentCtx 真跑一遍注册：`installBotCreateTool` 内部是
   * try/catch 吞错的，schema 写错 / 注册接口签名对不上都不会报错，只会表现成
   * 「模型没有这个工具」。所以要断言注册确实发生了、名字和必填项都对。
   */
  const registered = []
  installBotCreateTool({ tools: { register: (tool) => registered.push(tool) } }, 'bot-main')

  assertEqual(registered.length, 1, '注册了一个工具')
  const tool = registered[0]
  assertEqual(tool.name, 'bot_create', '工具名是 bot_create')
  assert(tool.parameters.required.includes('name'), 'required 含 name')
  assert(tool.parameters.required.includes('role'), 'required 含 role')
  assert(typeof tool.description === 'string' && tool.description.includes('什么时候用'), '描述里写了使用时机（模型靠它判断该不该建）')
  assert(typeof tool.output.render === 'function', '有 render（工具卡上要显示人话）')

  const executed = await tool.execute({ name: '工具助手', role: '注册验证' })
  assert(executed.ok === true, 'execute 能真的建出 Bot')
  assertEqual(executed.name, '工具助手', 'execute 返回名字')
  assert(/^bot-[0-9a-f]{8}$/.test(String(executed.bot_id)), 'execute 返回合法 bot_id')
}

{
  // agentCtx 缺 tools（宿主服务没起来）时必须静默跳过，不能把 setup 整条打断
  let threw = false
  try {
    installBotCreateTool({}, 'bot-main')
    installBotCreateTool(undefined, 'bot-main')
  } catch {
    threw = true
  }
  assert(threw === false, 'agentCtx 缺 tools 时不抛错（不阻塞 Bot 启动）')
}

// ── 9. 落盘失败 ─────────────────────────────────────────────────────────
console.log('\n# 落盘失败')

{
  /*
   * 把 DSH_HOME 指到一个「文件占住了目录名」的路径：`mkdirSync` 必然失败，
   * 于是走 appendCreatedBot 的抛错分支。要验证的是**失败时什么都不发生**：
   * 不广播、不写花名册、返回 ok:false 且错误话术提醒模型别骗用户。
   */
  const blocker = join(home, 'blocked-home')
  writeFileSync(blocker, 'not a directory', 'utf8')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = blocker
  __resetCreatedBotsCache()

  const written = []
  setBotSpecWriter((spec) => written.push(spec))
  resetChannels()
  const seen = []
  const off = subscribe('bot-main', (event) => seen.push(event))

  let result
  let threw = false
  try {
    result = createBot({ name: '不该建成', role: '失败路径' }, { createdBy: 'bot-main' })
  } catch {
    threw = true
  }
  off()
  process.env.DSH_HOME = previousHome
  __resetCreatedBotsCache()

  assert(threw === false, '落盘失败不抛异常（转成 ok:false 交给模型）')
  assert(result !== undefined && result.ok === false, '落盘失败返回 ok:false')
  assert(
    result !== undefined && typeof result.error === 'string' && result.error.includes('没有生效'),
    '错误话术明确告诉模型「这次创建没有生效」',
  )
  assertEqual(seen.length, 0, '落盘失败不广播（避免前端显示一个不存在的 Bot）')
  assertEqual(written.length, 0, '落盘失败不写花名册（避免派活给幽灵 Bot）')
}

// ── 收尾 ────────────────────────────────────────────────────────────────
try {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
} catch { /* 临时目录清不掉不影响结论 */ }

console.log('')
if (failed === 0) {
  console.log('全部通过')
} else {
  console.error(`${failed} 项失败`)
  process.exitCode = 1
}
