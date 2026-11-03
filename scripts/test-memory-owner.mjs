/**
 * dsh-memory — 记忆归属与可见性回归测试（schema v6）。
 *
 * 覆盖三件改造后才成立的事：
 *   1. 会话 id → 归属的解析（`pa-bot-v2-<botId>` → `bot:<botId>`）；
 *   2. 同内容不同归属必须得到**不同 id**（否则两个 Bot 的记忆会合并）；
 *   3. 可见性矩阵：Work / 子 Bot / 主 Bot 各自读得到什么。
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

  console.log("")
  if (failed > 0) {
    console.error(`失败 ${failed} 项`)
    process.exit(1)
  }
  console.log("全部通过")
} finally {
  rmSync(outdir, { recursive: true, force: true })
}
