/**
 * dsh-memory — 记忆归属与可见性回归测试（schema v6）。
 *
 * 覆盖七件改造后才成立的事：
 *   1. 会话 id → 归属的解析（`pa-bot-v2-<botId>` → `bot:<botId>`）；
 *   2. 同内容不同归属必须得到**不同 id**（否则两个 Bot 的记忆会合并）；
 *   3. 可见性矩阵：Work / 子 Bot / 主 Bot 各自读得到什么；
 *   4. 变更流（appendChange）的 owner 自动补全——显式传入优先，否则按 entryId
 *      反查条目，查不到（已删除 / 空 entryId）兜底 work；
 *   5. 「删除今日」（/delete-today）与整理（/consolidate）的 owner 过滤——传了
 *      owner 就只动该归属的条目（`bots` = 所有 Bot），不传 = 全量（向后兼容）；
 *   6. 每日整理按 owner 分组（无人值守路径同样不能跨归属合批）；
 *   7. memory_consolidate 的归属收窄：Bot 会话只整理自己，Work 会话保持全量。
 *
 * 直接打包 TS 源再 import，不依赖构建产物（`lib/index.js` 不导出这些内部函数）。
 * Usage: node scripts/test-memory-owner.mjs
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import assert from "node:assert/strict"
import { build } from "esbuild"

const HERE = process.cwd()
const outdir = mkdtempSync(join(tmpdir(), "dsh-memory-owner-"))
/** 变更流回归用的独立数据根（绝不碰真实的 ~/.dsh 记忆库）。 */
const storeRoot = mkdtempSync(join(tmpdir(), "dsh-memory-changes-"))

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 异步版 check（变更流要真的落盘，必须 await）。 */
async function checkAsync(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  await build({
    entryPoints: [
      join(HERE, "src/triad/memory/engine/store.ts"),
      join(HERE, "src/triad/memory/engine/visibility.ts"),
    ],
    outdir,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outExtension: { ".js": ".mjs" },
    logLevel: "error",
  })

  const store = await import(pathToFileURL(join(outdir, "store.mjs")).href)
  const { visibilityFor, MAIN_BOT_ID } = await import(pathToFileURL(join(outdir, "visibility.mjs")).href)

  console.log("\n[1] 会话 id → 归属")
  check("pa-bot-v2-<id> → bot:<id>", () => {
    assert.equal(store.ownerOfSessionId("pa-bot-v2-bot-main-xiaomo"), "bot:bot-main-xiaomo")
  })
  check("无版本段 pa-bot-<id> 也认（前缀升级不丢归属）", () => {
    assert.equal(store.ownerOfSessionId("pa-bot-bot-abc"), "bot:bot-abc")
  })
  check("pa-bot-v3-<id> 认（未来版本段）", () => {
    assert.equal(store.ownerOfSessionId("pa-bot-v3-bot-abc"), "bot:bot-abc")
  })
  check("普通 Work 会话 → work", () => {
    assert.equal(store.ownerOfSessionId("session-48d5254e"), "work")
  })
  check("空值 → work", () => {
    assert.equal(store.ownerOfSessionId(undefined), "work")
    assert.equal(store.ownerOfSessionId(null), "work")
    assert.equal(store.ownerOfSessionId(""), "work")
  })
  check("前缀不完整不误判（pa-bot- 后为空）", () => {
    assert.equal(store.ownerOfSessionId("pa-bot-v2-"), "work")
  })

  console.log("\n[2] id 隔离（同内容不同归属）")
  const CONTENT = "用户喜欢简洁回复"
  const idA = store.entryIdOf(CONTENT, "global", null, "bot:bot-a")
  const idB = store.entryIdOf(CONTENT, "global", null, "bot:bot-b")
  const idW = store.entryIdOf(CONTENT, "global", null, "work")
  check("两个 Bot 记同一句话 → 两个不同 id", () => assert.notEqual(idA, idB))
  check("Bot 与 Work 记同一句话 → 不同 id", () => {
    assert.notEqual(idA, idW)
    assert.notEqual(idB, idW)
  })
  check("同归属同内容 → 稳定同 id", () => {
    assert.equal(store.entryIdOf(CONTENT, "global", null, "bot:bot-a"), idA)
  })
  check("缺省 owner 等价于 work", () => {
    assert.equal(store.entryIdOf(CONTENT, "global", null), idW)
  })
  check("新 id 与旧 id 算法不同（迁移必要性）", () => {
    assert.notEqual(store.legacyEntryIdOf(CONTENT, "global", null), idW)
  })
  check("ownerOf 缺省回退 work（兼容 v5 存量）", () => {
    assert.equal(store.ownerOf({}), "work")
    assert.equal(store.ownerOf({ owner: "bot:x" }), "bot:x")
  })

  console.log("\n[3] 可见性矩阵")
  /** 造一条最小条目（只看 owner/scope/projectHash 三字段）。 */
  const entry = (owner, scope, projectHash = null) => ({
    owner,
    scope,
    projectHash: scope === "project" ? projectHash : null,
    content: "x",
  })
  const BOT_HASH = "775c363e7a87" // D:\Seeker-Bot（所有 Bot 共用）
  const WORK_HASH = "3efe291def22" // D:\AI\dsh-seeker-bot
  const OTHER_HASH = "039218675a5d" // D:\AI\Dsh

  const work = visibilityFor("session-abc", WORK_HASH)
  check("Work：读得到 work global", () => assert.equal(work.canInject(entry("work", "global")), true))
  check("Work：读得到 work 当前项目", () => assert.equal(work.canInject(entry("work", "project", WORK_HASH)), true))
  check("Work：读不到 work 其它项目", () => assert.equal(work.canInject(entry("work", "project", OTHER_HASH)), false))
  check("Work：读不到任何 Bot 的记忆", () => {
    assert.equal(work.canInject(entry("bot:bot-a", "global")), false)
    assert.equal(work.canSearch(entry("bot:bot-a", "project", BOT_HASH)), false)
  })

  const sub = visibilityFor("pa-bot-v2-bot-a", BOT_HASH)
  check("子 Bot：读得到自己", () => {
    assert.equal(sub.canInject(entry("bot:bot-a", "global")), true)
    assert.equal(sub.canInject(entry("bot:bot-a", "project", BOT_HASH)), true)
  })
  check("子 Bot：读得到 work 全局（身份/偏好继承）", () => {
    assert.equal(sub.canInject(entry("work", "global")), true)
  })
  check("子 Bot：读不到 work 项目层", () => {
    assert.equal(sub.canInject(entry("work", "project", WORK_HASH)), false)
  })
  check("子 Bot：读不到别的 Bot（隔离核心）", () => {
    assert.equal(sub.canInject(entry("bot:bot-b", "global")), false)
    assert.equal(sub.canSearch(entry("bot:bot-b", "project", BOT_HASH)), false)
  })
  check("子 Bot：写入归属恒为自己", () => assert.equal(sub.self, "bot:bot-a"))

  const main = visibilityFor(`pa-bot-v2-${MAIN_BOT_ID}`, BOT_HASH)
  /*
   * 3.6 收窄（2026-11）：主 Bot 的**自动注入**不再包含子 Bot。
   * 所有 Bot 共用同一个工作目录，projectHash 对它们完全相同，旧的「主 Bot 看见
   * 全部子 Bot」等于把每个子 Bot 的全部项目记忆塞进主 Bot 的每一轮上下文。
   * 跨 Bot 的场合（用户问「小莫你记得小助说过什么」）走 memory_search，
   * 那里 canSearch 保持开放——所以下面两条要一起断言，收窄不能误伤检索。
   */
  check("主 Bot：自动注入不再包含子 Bot（3.6 收窄）", () => {
    assert.equal(main.isMain, true)
    assert.equal(main.canInject(entry("bot:bot-a", "project", BOT_HASH)), false)
    assert.equal(main.canInject(entry("bot:bot-a", "global")), false)
  })
  check("主 Bot：子 Bot 记忆仍可显式检索（canSearch 保持开放）", () => {
    assert.equal(main.canSearch(entry("bot:bot-a", "project", BOT_HASH)), true)
    assert.equal(main.canSearch(entry("bot:bot-a", "global")), true)
  })
  check("主 Bot：读得到 work 全局", () => assert.equal(main.canInject(entry("work", "global")), true))
  check("主 Bot：注入不主动塞 work 其它项目（避免噪声）", () => {
    assert.equal(main.canInject(entry("work", "project", OTHER_HASH)), false)
  })
  check("主 Bot：显式检索可跨项目", () => {
    assert.equal(main.canSearch(entry("work", "project", OTHER_HASH)), true)
    assert.equal(main.canSearch(entry("bot:bot-b", "project", BOT_HASH)), true)
  })
  check("主 Bot：写入归属仍只有自己", () => assert.equal(main.self, `bot:${MAIN_BOT_ID}`))

  console.log("\n[4] 变更流 owner 自动补全（appendChange）")
  /*
   * 变更记录必须自带 owner：面板「变更」页要按 Bot 过滤，而删除类记录指向的
   * 条目已经从库里消失，反查不到归属。补全规则在 appendChange 内部：
   * 显式传入 > 按 entryId 反查条目 > 兜底 work。
   */
  const memoryStore = new store.MemoryStore(storeRoot)
  const { entry: botEntry } = await memoryStore.upsertEntry({
    content: "小莫记得用户在写插件",
    scope: "global",
    projectHash: null,
    owner: "bot:bot-a",
  })
  const { entry: workEntry } = await memoryStore.upsertEntry({
    content: "用户偏好简洁回复",
    scope: "global",
    projectHash: null,
  })
  /** 造一条最小变更记录（只关心 entryId / owner）。 */
  const change = (entryId, extra = {}) => ({
    action: "update",
    entryId,
    scope: "global",
    projectHash: null,
    summary: "回归用",
    ...extra,
  })

  await checkAsync("条目存在时自动带出 owner（Bot）", async () => {
    const record = await memoryStore.appendChange(change(botEntry.id))
    assert.equal(record.owner, "bot:bot-a")
  })
  await checkAsync("条目无 owner 字段时自动带出 work（v5 存量兼容）", async () => {
    const record = await memoryStore.appendChange(change(workEntry.id))
    assert.equal(record.owner, "work")
  })
  await checkAsync("显式传入的 owner 优先于反查结果", async () => {
    const record = await memoryStore.appendChange(change(botEntry.id, { owner: "bot:bot-b" }))
    assert.equal(record.owner, "bot:bot-b")
  })
  await checkAsync("entryId 查不到条目时兜底 work", async () => {
    const record = await memoryStore.appendChange(change("mem_不存在的条目"))
    assert.equal(record.owner, "work")
  })
  await checkAsync("entryId 为空串（整理汇总记录）兜底 work", async () => {
    const record = await memoryStore.appendChange(change("", { action: "consolidate" }))
    assert.equal(record.owner, "work")
  })
  await checkAsync("删除后反查必失败：只有显式传 owner 才留得住归属", async () => {
    assert.equal(await memoryStore.removeEntry(botEntry.id), true)
    const kept = await memoryStore.appendChange(change(botEntry.id, { action: "delete", owner: "bot:bot-a" }))
    assert.equal(kept.owner, "bot:bot-a")
    // 不显式传就会兜底成 work —— 这正是删除路径必须自己传 owner 的原因。
    const fellBack = await memoryStore.appendChange(change(botEntry.id, { action: "delete" }))
    assert.equal(fellBack.owner, "work")
  })
  await checkAsync("落盘记录带 owner（GET /changes 直接透出）", async () => {
    const changes = await memoryStore.readChanges()
    assert.ok(changes.length >= 6, `变更记录数 ${changes.length} 少于预期`)
    assert.ok(changes.every(record => typeof record.owner === "string" && record.owner !== ""))
    assert.ok(changes.some(record => record.owner === "bot:bot-a"))
  })
  // 清掉 500ms 节流回刷计时器，别让进程为一条测试多挂半秒。
  await memoryStore.flush()

  console.log("\n[5] 「删除今日」的 owner 过滤（POST /delete-today）")
  /*
   * 判据是 store.isDeletableToday（api.ts 的 /delete-today 直接调它）：
   * 不传 owner = 全量（旧行为），传了就只删该归属的今日条目。不加这道过滤时，
   * 在某个 Bot 的视图里点「删除今日」会把 Work 与所有 Bot 的今日记忆一起清掉。
   */
  const today = store.localDate(new Date())
  const isoToday = new Date().toISOString()
  const isoYesterday = new Date(Date.now() - 86_400_000).toISOString()
  /** 造一条判定用的条目（只看 isDeletableToday 关心的字段）。 */
  const dayEntry = (owner, updatedAt, extra = {}) => ({
    owner,
    scope: "global",
    projectHash: null,
    content: "x",
    pinned: false,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  })
  const dayEntries = [
    dayEntry("bot:bot-a", isoToday),
    dayEntry("bot:bot-b", isoToday),
    dayEntry(undefined, isoToday), // 无 owner 字段 = work（v5 存量）
    dayEntry("bot:bot-a", isoYesterday),
    dayEntry("work", isoToday, { pinned: true }), // 置顶：批量删除豁免
  ]
  /** 模拟 /delete-today 的取目标过程。 */
  const deletable = (owner) => dayEntries.filter(entry => store.isDeletableToday(entry, { today, owner }))

  check("不传 owner：今日全量（向后兼容，旧调用方行为不变）", () => {
    assert.equal(deletable(undefined).length, 3)
  })
  check("owner=bot:bot-a：只删该 Bot 的今日条目，不碰 Work / 别的 Bot", () => {
    const targets = deletable("bot:bot-a")
    assert.equal(targets.length, 1)
    assert.equal(store.ownerOf(targets[0]), "bot:bot-a")
    assert.equal(targets[0].updatedAt, isoToday)
  })
  check("owner=work：只删 Work 的（含无 owner 字段的存量），不碰 Bot", () => {
    const targets = deletable("work")
    assert.equal(targets.length, 1)
    assert.equal(targets[0].owner, undefined)
  })
  check("owner=bots：只删所有 Bot 的，Work 的不动", () => {
    const targets = deletable("bots")
    assert.equal(targets.length, 2)
    assert.ok(targets.every(entry => store.ownerOf(entry).startsWith("bot:")))
  })
  check("置顶与昨日条目始终不在目标集里", () => {
    const targets = deletable(undefined)
    assert.ok(targets.every(entry => entry.pinned !== true && entry.updatedAt === isoToday))
  })

  console.log("\n[6] 整理输入的 owner 过滤（POST /consolidate）")
  /*
   * 判据是 store.filterByOwner（consolidateScope 在选集合前调它）。不加过滤时
   * 一个批次里会同时有多个归属的条目，LLM 可能把两台 Bot 的相似记忆合并成一条。
   */
  const consolidateSet = [
    { owner: "bot:bot-a", content: "a1" },
    { owner: "bot:bot-a", content: "a2" },
    { owner: "bot:bot-b", content: "b1" },
    { content: "w1" }, // 无 owner 字段 = work（v5 存量）
  ]
  const contentsOf = (owner) => store.filterByOwner(consolidateSet, owner).map(entry => entry.content)

  check("不传 owner：全量整理（向后兼容）", () => {
    assert.equal(contentsOf(undefined).length, 4)
  })
  check("owner=bot:bot-a：只整理该 Bot 的条目（跨 owner 合并不再可能）", () => {
    assert.deepEqual(contentsOf("bot:bot-a"), ["a1", "a2"])
  })
  check("owner=bots：只整理 Bot 的条目，Work 的留给 Work 视图", () => {
    assert.deepEqual(contentsOf("bots"), ["a1", "a2", "b1"])
  })
  check("owner=work：只整理 Work 的条目（含无 owner 字段的存量）", () => {
    assert.deepEqual(contentsOf("work"), ["w1"])
  })

  console.log("\n[7] 每日整理按 owner 分组（ticker 的 runDailyCompile）")
  /*
   * 分组判据是 store.ownerGroupsOf：每日整理对每个归属各跑一遍 LLM 决策。
   * 不分组时跨 owner 的条目会进同一批，一次 merge 就把两台 Bot 的相似记忆合成
   * 一条（合并产物落在第一条源条目的归属上，另一方的记忆凭空消失）。
   */
  check("跨 owner 集合 → owner 去重后的分组（work 在前，其余按字典序）", () => {
    const mixed = [
      { owner: "bot:bot-b" },
      { owner: "bot:bot-a" },
      { content: "无 owner 字段 = work（v5 存量）" },
      { owner: "bot:bot-b" },
    ]
    assert.deepEqual(store.ownerGroupsOf(mixed), ["work", "bot:bot-a", "bot:bot-b"])
  })
  check("单一归属只产生一组", () => {
    assert.deepEqual(store.ownerGroupsOf([{ owner: "bot:bot-a" }, { owner: "bot:bot-a" }]), ["bot:bot-a"])
  })
  check("空库不产生分组（整理步骤直接跳过，不发空请求）", () => {
    assert.deepEqual(store.ownerGroupsOf([]), [])
  })

  console.log("\n[8] memory_consolidate 的归属收窄")
  /*
   * Bot 会话只整理自己的记忆；Work 会话保持全量（原有语义，不改）。
   * Bot 是分身，它没有资格替主人整理别的分身的记忆。
   */
  check("Bot 会话 → 该 Bot 的 owner（只整理自己的）", () => {
    assert.equal(store.consolidateOwnerForSessionId("pa-bot-v2-bot-a"), "bot:bot-a")
  })
  check("Work 会话 → undefined（保持全量整理，行为不变）", () => {
    assert.equal(store.consolidateOwnerForSessionId("session-48d5254e"), undefined)
  })
  check("拿不到会话 id → undefined（回退全量，不猜归属）", () => {
    assert.equal(store.consolidateOwnerForSessionId(undefined), undefined)
    assert.equal(store.consolidateOwnerForSessionId(null), undefined)
  })

  console.log("")
  if (failed > 0) {
    console.error(`失败 ${failed} 项`)
    process.exit(1)
  }
  console.log("全部通过")
} finally {
  rmSync(outdir, { recursive: true, force: true })
  rmSync(storeRoot, { recursive: true, force: true })
}
