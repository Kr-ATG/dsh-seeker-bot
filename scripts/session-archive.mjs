#!/usr/bin/env node
/**
 * session-archive — 按时间把冷会话分层归档（控制 sessions 无限增长的唯一有效手段）
 *
 * 为什么不用压缩解决增长：压缩只降低单位体积，会话数仍在增长；而 DSH 每次
 * 搜索都要 reconcile 全库会话，历史越长索引越大、首次重建越慢。把长期不动的
 * 会话整目录移出 sessions 之后：
 *   · 不再参与 reconcile，检索更快
 *   · 索引里的行会被删除，库变小（再跑 session-index-warm 生效）
 *   · 磁盘占用原样保留在归档目录，随时可以整目录移回
 *
 * 归档判据：会话文件的 mtime（最后一次写入时间）早于 --days 天。
 * 归档目标：--into（默认 ~/.dsh/sessions-archive-YYYYMMDD），保留工作区层级。
 *
 * 恢复：把归档目录里的会话目录移回 ~/.dsh/sessions/<工作区>/ 即可，
 *       然后跑 node scripts/session-index-warm.mjs 让索引重新收录。
 *
 * 用法：
 *   node scripts/session-archive.mjs --days=90 --dry-run
 *   node scripts/session-archive.mjs --days=90
 *   node scripts/session-archive.mjs --days=90 --into=D:\backup\sessions-2026Q4
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const argv = process.argv.slice(2);
const DAYS = Number((argv.find((a) => a.startsWith("--days=")) ?? "--days=90").split("=")[1]);
const DRY = argv.includes("--dry-run");
if (!Number.isFinite(DAYS) || DAYS < 0) {
  console.error("[session-archive] --days 必须是 >= 0 的数字");
  process.exit(2);
}
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const ROOT = (argv.find((a) => a.startsWith("--root=")) ?? "--root=" + path.join(DSH_HOME, "sessions")).slice("--root=".length);
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const INTO = (argv.find((a) => a.startsWith("--into=")) ?? "--into=" + path.join(DSH_HOME, "sessions-archive-" + stamp)).slice("--into=".length);

const cutoff = Date.now() - DAYS * 86400e3;

/** 找到所有「含 session.* 文件的目录」即一个会话。 */
function findSessionDirs(dir, acc = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  const files = [];
  const dirs = [];
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) dirs.push(p);
    else if (e.name.startsWith("session.") && e.name.endsWith(".zstd")) files.push(p);
  }
  if (files.length) {
    const mtimeMs = Math.max(...files.map((f) => fs.statSync(f).mtimeMs));
    const size = files.reduce((a, f) => a + fs.statSync(f).size, 0);
    acc.push({ dir, files, mtimeMs, size });
  }
  for (const d of dirs) findSessionDirs(d, acc);
  return acc;
}

const sessions = findSessionDirs(ROOT);
const cold = sessions.filter((s) => s.mtimeMs < cutoff);

console.log("[session-archive] " + new Date().toLocaleString("zh-CN"));
console.log("  根目录: " + ROOT);
console.log("  判据:   mtime 早于 " + new Date(cutoff).toLocaleString("zh-CN") + "（" + DAYS + " 天前）");
console.log("  会话总数 " + sessions.length + " | 命中 " + cold.length + " | 合计 " + (cold.reduce((a, s) => a + s.size, 0) / 1048576).toFixed(1) + "MB");
console.log("  归档到: " + INTO);
if (!cold.length) {
  console.log("  没有需要归档的会话。");
  process.exit(0);
}

const rows = [];
for (const s of cold) {
  const rel = path.relative(ROOT, s.dir);
  const dst = path.join(INTO, rel);
  rows.push({ rel, sizeKB: Math.round(s.size / 1024), lastActive: new Date(s.mtimeMs).toISOString().slice(0, 10) });
  if (DRY) continue;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(s.dir, dst, { recursive: true });
  // 复制成功后再删源，保证任何中断都不会丢会话
  const copied = fs.readdirSync(dst).filter((n) => n.startsWith("session."));
  if (!copied.length) { console.error("  复制失败，跳过: " + rel); continue; }
  fs.rmSync(s.dir, { recursive: true, force: true });
}
rows.sort((a, b) => b.sizeKB - a.sizeKB);
for (const r of rows.slice(0, 10)) console.log("  · " + String(r.sizeKB).padStart(6) + "KB  " + r.lastActive + "  " + r.rel);
if (rows.length > 10) console.log("  … 另有 " + (rows.length - 10) + " 个");

fs.mkdirSync(INTO, { recursive: true });
fs.writeFileSync(path.join(INTO, "_archived.json"), JSON.stringify({ archivedAt: new Date().toISOString(), days: DAYS, from: ROOT, count: rows.length, sessions: rows }, null, 2) + "\n", "utf8");
console.log(DRY ? "  (dry-run，未移动任何文件)" : "  已归档 " + rows.length + " 个会话" + (DRY ? "" : "，索引需要重建：node scripts/session-index-warm.mjs"));
