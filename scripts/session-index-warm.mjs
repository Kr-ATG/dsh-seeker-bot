#!/usr/bin/env node
/**
 * session-index-warm — 预热 / 重建会话搜索索引
 *
 * DSH 的 SQLite 搜索索引在每次搜索前 reconcile 全库；宿主里的工具调用有
 * searchTimeoutMs 上限，全量重建（几百个会话、2GB+ 明文）会撞超时并回滚，
 * 于是永远建不完。本脚本在宿主之外用同一条索引库跑一次完整 reconcile，
 * 没有超时窗口，之后再在宿主里搜索就是亚秒级。
 *
 * 什么时候需要跑：
 *   · 首次启用磁盘索引后
 *   · session-store-gc 重压过会话之后（所有 revision 都变了）
 *   · 从 sessions-archive 恢复大量会话之后
 *
 * 用法：node scripts/session-index-warm.mjs [--query=关键词]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const QUERY = (argv.find((a) => a.startsWith("--query=")) ?? "--query=warmup").split("=")[1] || "warmup";
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SESSIONS = path.join(DSH_HOME, "sessions");
const DB = path.join(DSH_HOME, "session-search.db");

function findRuntime() {
  const candidates = [process.env.DSH_RUNTIME, path.join(process.env.APPDATA || "", "dsh-shell", "runtime"), path.join(DSH_HOME, "runtime")].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"))) return c;
  throw new Error("找不到 DSH runtime（可用 DSH_RUNTIME 指定）");
}

const rt = findRuntime();
const url = (pkg) => pathToFileURL(path.join(rt, "node_modules", "@deepseek-ai", pkg, "lib", "index.js")).href;
const { Context } = await import(url("cordis"));
const session = await import(url("dsh-session"));
const jsonl = await import(url("dsh-session-persistence-jsonl"));
const sqlite = await import(url("dsh-session-query-sqlite"));

const ctx = new Context();
ctx.plugin(session.default);
ctx.plugin(jsonl, { root: SESSIONS });
ctx.plugin(sqlite.default, { path: DB, openAt: "startup", persistedReadConcurrency: 8 });
await new Promise((r) => setTimeout(r, 1500));

const q = ctx.get("sessionQuery");
const t = Date.now();
try {
  const r = await q.searchSessions({ query: QUERY });
  console.log("[session-index-warm] reconcile 完成，用时 " + Math.round((Date.now() - t) / 1000) + "s，结果 " + (r.items?.length ?? 0) + " 条；库 " + (fs.statSync(DB).size / 1048576).toFixed(0) + "MB");
} catch (e) {
  let chain = "";
  let cur = e, g = 0;
  while (cur && g++ < 5) { chain += " ⟵ " + (cur.name || "?") + ": " + (cur.message || ""); cur = cur.cause; }
  console.error("[session-index-warm] 失败:" + chain.slice(0, 500));
  process.exit(1);
}
process.exit(0);
