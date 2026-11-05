/**
 * dsh-seeker-bot — Git 来源「更新」回归测试（upToDate 短路 / 真实重装 / 账本刷新）。
 *
 * 全程用本地 git 仓库（file://）模拟远端，不依赖网络；DSH_SKILL_GIT_ALLOW_LOCAL=1
 * 打开 host 的本地地址白名单（与生产环境一致的那条测试开关）。
 *
 * 覆盖用户 2026-11-03 报的那个问题：
 *   「点了更新，转两分钟，最后 commit 没变，看起来像没更新成功」
 *   → 远端没动时必须秒回 upToDate，且不重装；远端动了才 clone 并刷新 commit。
 *
 * Usage: node scripts/test-skill-source-update.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { EventEmitter } from "node:events"

const sandbox = mkdtempSync(join(tmpdir(), "dsh-skill-src-"))
process.env.DSH_AGENTS_HOME = join(sandbox, "agents")
process.env.DSH_HOME = join(sandbox, "dsh")
process.env.DSH_SKILL_GIT_ALLOW_LOCAL = "1"
mkdirSync(join(process.env.DSH_AGENTS_HOME, "skills"), { recursive: true })
mkdirSync(join(process.env.DSH_HOME, "skills"), { recursive: true })

// 远端仓库：skills/demo-skill 布局（技能包仓库最常见的形态）
const repo = join(sandbox, "repo")
mkdirSync(join(repo, "skills", "demo-skill"), { recursive: true })
writeFileSync(join(repo, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: v1\n---\n\nbody v1\n")
writeFileSync(join(repo, "README.md"), "root readme\n")
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim()
git("init", "-q")
git("config", "user.email", "test@example.com")
git("config", "user.name", "test")
git("add", "-A")
git("commit", "-q", "-m", "v1")
const url = pathToFileURL(repo).href

const mod = await import(pathToFileURL(join(process.cwd(), "src/vendor/usage-skill/skills-host.js")).href)
let handler = null
mod.apply({ effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler; return () => {} } } })
if (handler === null) { console.error("FAIL  route not registered"); process.exit(1) }

/** 打一次路由：method + url(+ 可选 JSON body) → { status, body }。 */
function call(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = urlPath
    req.headers = { host: "localhost" }
    req.socket = { remoteAddress: "127.0.0.1" }
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status },
      end(payload) {
        let parsed = payload
        try { parsed = JSON.parse(payload) } catch { /* 原样返回 */ }
        resolve({ status: this.statusCode, body: parsed })
      },
    }
    handler(req, res)
    queueMicrotask(() => {
      if (body === undefined) { req.emit("end"); return }
      req.emit("data", Buffer.from(JSON.stringify(body)))
      req.emit("end")
    })
  })
}

let failed = 0
function check(cond, msg) {
  if (cond) { console.log(`ok    ${msg}`) } else { failed += 1; console.error(`FAIL  ${msg}`) }
}
const skillsRoot = join(process.env.DSH_AGENTS_HOME, "skills")
const skillFile = join(skillsRoot, "demo-skill", "SKILL.md")

// ── 1. Git 导入：落盘 + 写来源账本
const imported = await call("POST", "/api/skill-manager/import-git", { url })
check(imported.status === 200 && imported.body.ok === true, "import-git 成功")
const importedCommit = imported.body.commit
check(imported.body.installed?.length === 1 && imported.body.installed[0].name === "demo-skill", "导入 1 个技能 demo-skill")
check(readFileSync(skillFile, "utf8").includes("v1"), "落盘内容是 v1")

// ── 2. 远端没动：update 必须秒回 upToDate，且不重装（这是用户报的主症状）
const before = readFileSync(skillFile, "utf8")
const upToDate = await call("POST", "/api/skill-manager/sources/src-1/update", {})
check(upToDate.status === 200 && upToDate.body.upToDate === true, "无更新时返回 upToDate=true")
check((upToDate.body.installed ?? []).length === 0, "无更新时 installed 为空（没有重新 clone/重装）")
check(upToDate.body.commit === importedCommit, "无更新时 commit 与账本一致")
check(readFileSync(skillFile, "utf8") === before, "无更新时技能文件未被改动")

// ── 3. 远端提交新版本：update 必须真正重装并刷新 commit
writeFileSync(join(repo, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: v2\n---\n\nbody v2\n")
git("add", "-A")
git("commit", "-q", "-m", "v2")
const newCommit = git("rev-parse", "HEAD")
const updated = await call("POST", "/api/skill-manager/sources/src-1/update", {})
check(updated.status === 200 && updated.body.ok === true, "有更新时 update 成功")
check(updated.body.upToDate !== true, "有更新时 upToDate 不为 true")
check(updated.body.commit === newCommit, "commit 刷新到新版本")
check(readFileSync(skillFile, "utf8").includes("v2"), "落盘内容更新为 v2")

// ── 4. 账本：commit 与 lastError 落账正确
const ledger = JSON.parse(readFileSync(join(skillsRoot, ".skill-sources.json"), "utf8"))
check(ledger.sources[0]?.commit === newCommit && ledger.sources[0]?.lastError === null, "账本 commit / lastError 正确")

// ── 5. 更新完再点一次：回到 upToDate，且 lastUpdate 同步刷新为当前时间
const ledgerBefore = JSON.parse(readFileSync(join(skillsRoot, ".skill-sources.json"), "utf8"))
const t0 = Date.now()
const again = await call("POST", "/api/skill-manager/sources/src-1/update", {})
check(again.body.upToDate === true, "更新完成后再次 update 返回 upToDate")
const ledgerAfter = JSON.parse(readFileSync(join(skillsRoot, ".skill-sources.json"), "utf8"))
check(ledgerAfter.sources[0]?.lastUpdate >= t0, "无新 commit 时 lastUpdate 依然刷新为同步确认时间")

// ── 6. 本地文件缺失自愈：即使 commit 未变，缺失文件也必须重新 clone 恢复
rmSync(skillFile, { force: true })
let missingChecked = false
try { readFileSync(skillFile, "utf8"); } catch { missingChecked = true }
check(missingChecked, "模拟技能文件丢失")
const heal = await call("POST", "/api/skill-manager/sources/src-1/update", {})
check(heal.status === 200 && heal.body.upToDate !== true, "文件缺失时跳过短路，重新 clone 恢复")
check(readFileSync(skillFile, "utf8").includes("v2"), "丢失的文件已成功恢复落盘")

// ── 7. force: true 强制重新安装
writeFileSync(skillFile, "corrupted", "utf8")
const forced = await call("POST", "/api/skill-manager/sources/src-1/update", { force: true })
check(forced.status === 200 && forced.body.upToDate !== true, "force=true 强制重新安装")
check(readFileSync(skillFile, "utf8").includes("v2"), "强制安装后内容恢复最新")

rmSync(sandbox, { recursive: true, force: true })
console.log(failed === 0 ? "\nALL PASS" : `\nFAILED: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
