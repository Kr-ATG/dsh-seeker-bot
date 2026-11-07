#!/usr/bin/env node
/**
 * session-maintenance — 会话存储与索引的定期维护
 *
 *   1. session-archive（可选，--archive-days=N）：把 N 天未动的冷会话分层归档
 *   2. session-store-gc：合并 zstd 碎片帧并高强度重压（实测 -56%）
 *   3. session-index-warm：重建搜索索引（archive / gc 都会让索引失效）
 *
 * 三步必须成组跑：只 gc 不 warm，宿主里的首次搜索会全量重建而撞超时。
 * 建议凌晨无人使用时执行（gc 默认只碰 24 小时前的会话）。
 *
 * 用法：
 *   node scripts/session-maintenance.mjs                     # gc + warm
 *   node scripts/session-maintenance.mjs --archive-days=90   # 季度维护：归档 + gc + warm
 *   node scripts/session-maintenance.mjs --dry-run           # 只估算，不改文件
 *   node scripts/session-maintenance.mjs --fast              # gc 用 level 3（快、省得少）
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const FAST = args.includes("--fast");
const archiveArg = args.find((a) => a.startsWith("--archive-days="));
const ARCHIVE_DAYS = archiveArg === undefined ? undefined : Number(archiveArg.split("=")[1]);

function run(script, extra, label) {
  const t = Date.now();
  console.log("[session-maintenance] " + label + " 开始 " + new Date().toLocaleString("zh-CN"));
  const r = spawnSync(process.execPath, ["--max-old-space-size=8192", path.join(here, script), ...extra], { stdio: "inherit", env: process.env });
  console.log("[session-maintenance] " + label + " 结束，用时 " + Math.round((Date.now() - t) / 1000) + "s，退出码 " + r.status);
  return r.status ?? 1;
}

if (ARCHIVE_DAYS !== undefined) {
  if (!Number.isFinite(ARCHIVE_DAYS) || ARCHIVE_DAYS < 0) {
    console.error("[session-maintenance] --archive-days 必须是非负数字");
    process.exit(2);
  }
  const status = run("session-archive.mjs", ["--days=" + ARCHIVE_DAYS, ...(DRY ? ["--dry-run"] : [])], "archive");
  if (status !== 0) process.exit(status);
}

const gcStatus = run(
  "session-store-gc.mjs",
  ["--min-age-hours=24", ...(FAST ? ["--fast"] : []), ...(DRY ? ["--dry-run"] : [])],
  "gc",
);
if (gcStatus !== 0) process.exit(gcStatus);

if (DRY) {
  console.log("[session-maintenance] dry-run 结束（未重建索引）");
  process.exit(0);
}
process.exit(run("session-index-warm.mjs", [], "warm"));
