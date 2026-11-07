#!/usr/bin/env node
/**
 * session-search-doctor — 会话检索健康检查 / 自愈
 *
 * 背景：DSH 的 SQLite 会话搜索索引在每次搜索前会 reconcile 全库会话，
 * 且是 fail-closed —— 只要有一个会话违反 v4 存储契约（缺 message id、
 * 事件顺序错乱等），整个工作区的 session_search / session_event_search
 * 就会返回 "session history storage is unavailable"。
 *
 * 本脚本在宿主进程之外跑审计（用 :memory: 索引，不碰宿主正在用的
 * session-search.db），把不合规会话隔离到 ~/.dsh/sessions-quarantine，
 * 让检索恢复。首次全量，之后按文件 mtime 增量，每天跑一次几秒钟。
 *
 * 用法：
 *   node scripts/session-search-doctor.mjs            # 审计（只读）
 *   node scripts/session-search-doctor.mjs --repair   # 审计 + 隔离坏会话
 *   node scripts/session-search-doctor.mjs --full     # 忽略增量状态，全量重审
 *   node scripts/session-search-doctor.mjs --json     # 输出机器可读结果
 *
 * 退出码：0 = 健康（或无坏会话可隔离）；1 = 发现坏会话（未加 --repair 时）。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const argv = new Set(process.argv.slice(2));
const REPAIR = argv.has("--repair");
const FULL = argv.has("--full");
const JSON_OUT = argv.has("--json");
const CONCURRENCY = Number((process.argv.find((a) => a.startsWith("--concurrency=")) ?? "--concurrency=2").split("=")[1]) || 2;

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SESSIONS = path.join(DSH_HOME, "sessions");
const QUARANTINE = path.join(DSH_HOME, "sessions-quarantine");
const STATE = path.join(DSH_HOME, "session-doctor-state.json");
const REPORT = path.join(DSH_HOME, "session-doctor-report.json");

/** 这些错误说明当前进程没加载投影插件，不代表会话坏了 —— 跳过而不是隔离。 */
const PLUGIN_GAP = [
  "requires a message projection",
  "load its owning plugin",
  "unknown event type",
];

function findRuntime() {
  const candidates = [
    process.env.DSH_RUNTIME,
    path.join(process.env.APPDATA || "", "dsh-shell", "runtime"),
    path.join(DSH_HOME, "runtime"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"))) return c;
  }
  throw new Error("找不到 DSH runtime（可用 DSH_RUNTIME 指定）");
}

function walkSessions(dir, acc = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSessions(p, acc);
    else if (e.name.startsWith("session.") && e.name.endsWith(".zstd")) acc.push(p);
  }
  return acc;
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (typeof s.lastAuditMs === "number") return s;
  } catch {}
  return { lastAuditMs: 0, knownBad: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function errorChain(e) {
  const parts = [];
  let cur = e;
  let guard = 0;
  while (cur && guard++ < 5) {
    parts.push((cur.name || "Error") + ": " + (cur.message || String(cur)));
    cur = cur.cause;
  }
  return parts.join(" ⟵ ");
}

async function main() {
  const rt = findRuntime();
  const url = (pkg) => pathToFileURL(path.join(rt, "node_modules", "@deepseek-ai", pkg, "lib", "index.js")).href;

  const { Context } = await import(url("cordis"));
  const session = await import(url("dsh-session"));
  const jsonl = await import(url("dsh-session-persistence-jsonl"));
  const sqlite = await import(url("dsh-session-query-sqlite"));

  const ctx = new Context();
  ctx.plugin(session.default);
  ctx.plugin(jsonl, { root: SESSIONS });
  ctx.plugin(sqlite.default, { path: ":memory:", openAt: "first-search" });
  await new Promise((r) => setTimeout(r, 1500));

  const q = ctx.get("sessionQuery");
  const persistence = ctx.get("sessionPersistence");
  const snapshots = await persistence.list();
  const state = loadState();

  // 增量：只审最近变更过的会话；--full 时全量
  const filesById = new Map();
  for (const f of walkSessions(SESSIONS)) {
    const id = path.basename(path.dirname(f));
    const st = fs.statSync(f);
    filesById.set(id, { file: f, id, mtimeMs: st.mtimeMs, sizeKB: Math.round(st.size / 1024) });
  }
  const targets = snapshots
    .map((s) => s.header.id)
    .filter((id) => {
      if (FULL) return true;
      const meta = filesById.get(id);
      if (!meta) return false;
      return meta.mtimeMs > state.lastAuditMs || state.knownBad.includes(id);
    });

  const bad = [];
  const skipped = [];
  let done = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= targets.length) return;
      const id = targets[i];
      try {
        await q.observeSession(id, {});
      } catch (e) {
        const chain = errorChain(e);
        if (PLUGIN_GAP.some((k) => chain.includes(k))) skipped.push({ id, detail: chain.slice(0, 240) });
        else bad.push({ id, detail: chain.slice(0, 400) });
      }
      done++;
    }
  });
  await Promise.all(workers);

  // 隔离
  const moved = [];
  if (REPAIR && bad.length) {
    for (const b of bad) {
      const meta = filesById.get(b.id);
      if (!meta) continue;
      const rel = path.relative(SESSIONS, path.dirname(meta.file));
      const from = path.dirname(meta.file);
      const to = path.join(QUARANTINE, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
      moved.push({ id: b.id, from, to, reason: b.detail });
    }
  }

  const report = {
    checkedAt: new Date().toISOString(),
    dshHome: DSH_HOME,
    totalSessions: snapshots.length,
    audited: targets.length,
    mode: FULL ? "full" : "incremental",
    bad,
    quarantined: moved,
    pluginGapSkipped: skipped,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n", "utf8");

  if (!JSON_OUT) {
    console.log("[session-search-doctor] " + new Date().toLocaleString("zh-CN"));
    console.log("  会话总数: " + snapshots.length + " | 本次审计: " + targets.length + " (" + report.mode + ")");
    console.log("  合规: " + (targets.length - bad.length - skipped.length) + " | 坏: " + bad.length + " | 跳过(插件缺失): " + skipped.length);
    for (const b of bad) console.log("  ✗ " + b.id + "\n      " + b.detail.slice(0, 200));
    for (const m of moved) console.log("  → 已隔离 " + m.id + " → " + m.to);
    console.log("  报告: " + REPORT);
  } else {
    console.log(JSON.stringify(report));
  }

  // 状态：只有确认通过后才推进水位；有坏会话且未修复时保留，下次继续报
  if (!bad.length || REPAIR) {
    state.lastAuditMs = Date.now();
    state.knownBad = bad.filter((b) => !REPAIR).map((b) => b.id);
    saveState(state);
  }

  process.exitCode = bad.length && !REPAIR ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error("[session-search-doctor] 运行失败: " + errorChain(e));
  process.exit(2);
});
