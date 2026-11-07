#!/usr/bin/env node
/**
 * session-store-gc — 会话日志的体积回收（相当于 git gc）
 *
 * 背景：DSH 的会话日志是 append-only 的 concatenated Zstandard 帧，
 * 每批事件单独一帧。一次会话动辄几百到几千帧（实测平均帧仅 ~2.4KB），
 * 而 zstd 每帧独立压缩，跨帧的重复内容（每轮重复的 system prompt、
 * skills 清单、runtime context、同样的工具输出）完全无法互相引用 ——
 * 这就是体积虚高的根因。
 *
 * 本脚本把「事件帧」合并成一帧大帧重新压缩：header 帧必须单独保留
 * （读取端契约：first frame is not exactly one header line 会判损坏），
 * 其余帧合并后 zstd 可以引用整段历史，实测 -48%（level 3）/ -61%
 * （level 19 + long-distance matching）。
 *
 * 安全性：
 *   · 只处理 mtime 早于 --min-age-hours 的会话，避开正在写入的会话
 *     （Windows 上 rename 替换后，旧句柄仍指向旧文件，写回会丢数据）。
 *   · 解码后必须没有残留尾巴（torn tail），否则跳过。
 *   · 新文件写临时路径 → 重新解码校验事件数与 header → 再 rename。
 *
 * 用法：
 *   node scripts/session-store-gc.mjs --dry-run        # 只估算能省多少
 *   node scripts/session-store-gc.mjs                  # 实跑（默认 level 19）
 *   node scripts/session-store-gc.mjs --fast           # level 3，快很多
 *   node scripts/session-store-gc.mjs --min-age-hours=72
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FAST = argv.includes("--fast");
const LEVEL = FAST ? 3 : 19;
const MIN_AGE_HOURS = Number((argv.find((a) => a.startsWith("--min-age-hours=")) ?? "--min-age-hours=24").split("=")[1]) || 24;

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SESSIONS = path.join(DSH_HOME, "sessions");
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const opts = { params: { [zlib.constants.ZSTD_c_compressionLevel]: LEVEL, [zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1 } };

function decodeFrames(buf) {
  const offs = [];
  let i = 0;
  while (true) { const k = buf.indexOf(MAGIC, i); if (k < 0) break; offs.push(k); i = k + 1; }
  const frames = [];
  let consumed = 0;
  let idx = 0;
  while (idx < offs.length) {
    const start = offs[idx];
    let ok = null;
    let endUsed = -1;
    for (let j = idx + 1; j <= offs.length; j++) {
      const end = j < offs.length ? offs[j] : buf.length;
      try { ok = zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8"); endUsed = end; idx = j; break; } catch {}
    }
    if (ok === null) { idx++; continue; }
    frames.push({ start, end: endUsed, text: ok });
    consumed = endUsed;
  }
  return { frames, leftover: buf.length - consumed };
}

function walk(dir, acc = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.startsWith("session.") && e.name.endsWith(".zstd")) acc.push(p);
  }
  return acc;
}

const now = Date.now();
const cutoff = now - MIN_AGE_HOURS * 3600e3;
const files = walk(SESSIONS);
let before = 0, after = 0, touched = 0, skipped = 0;
const rows = [];

for (const f of files) {
  const st = fs.statSync(f);
  if (st.mtimeMs > cutoff) { skipped++; continue; }
  const buf = fs.readFileSync(f);
  if (buf.length < 32 * 1024) { skipped++; continue; }
  const { frames, leftover } = decodeFrames(buf);
  if (frames.length < 3 || leftover !== 0) { skipped++; continue; }
  const headerFrame = buf.subarray(frames[0].start, frames[0].end);
  const body = frames.slice(1).map((x) => x.text).join("");
  const eventsBefore = body.split("\n").filter(Boolean).length;
  const packed = zlib.zstdCompressSync(body, opts);
  const next = Buffer.concat([headerFrame, packed]);
  if (next.length >= buf.length * 0.97) { skipped++; continue; }

  before += buf.length;
  after += next.length;
  touched++;
  rows.push({ file: path.relative(SESSIONS, f), frames: frames.length, events: eventsBefore, fromKB: Math.round(buf.length / 1024), toKB: Math.round(next.length / 1024) });

  if (DRY) continue;

  const tmp = f + ".gc.tmp";
  fs.writeFileSync(tmp, next);
  const check = decodeFrames(fs.readFileSync(tmp));
  const eventsAfter = check.frames.slice(1).map((x) => x.text).join("").split("\n").filter(Boolean).length;
  const headerOk = check.leftover === 0 && check.frames.length === 2 && check.frames[0].text.split("\n").filter(Boolean).length === 1;
  if (!headerOk || eventsAfter !== eventsBefore) {
    fs.rmSync(tmp, { force: true });
    console.error("[gc] 校验失败，跳过: " + f + " (events " + eventsBefore + " -> " + eventsAfter + ")");
    skipped++;
    continue;
  }
  fs.renameSync(tmp, f);
}

console.log("[session-store-gc] " + new Date().toLocaleString("zh-CN"));
console.log("  扫描 " + files.length + " 个会话 | 重压 " + touched + " | 跳过 " + skipped + " | level " + LEVEL + (DRY ? " (dry-run)" : ""));
if (touched) {
  console.log("  体积 " + (before / 1048576).toFixed(1) + "MB → " + (after / 1048576).toFixed(1) + "MB  (省 " + ((1 - after / before) * 100).toFixed(1) + "%)");
  const top = rows.sort((a, b) => b.fromKB - a.fromKB).slice(0, 8);
  for (const r of top) console.log("  · " + r.fromKB + "KB → " + r.toKB + "KB  (" + r.frames + " 帧 / " + r.events + " 事件)  " + r.file.slice(-46));
}
