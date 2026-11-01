// src/index.ts
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { URL } from "node:url";
import { inflateRawSync } from "node:zlib";
var name = "skill-manager";
var inject = ["webServer"];
var SKILL_FILE = "SKILL.md";
var BUNDLES_FILE = ".bundles.json";
var ROUTE_PREFIX = "/api/skill-manager";
var NAME_MAX = 64;
var NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
var ARCHIVE_MAX_ENTRIES = 2000;
var ARCHIVE_MAX_TOTAL = 200 * 1024 * 1024;
function unzipArchive(buffer) {
  if (buffer.length < 22) throw new Error("not a zip archive");
  let eocd = -1;
  const tailStart = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= tailStart; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  if (totalEntries === 0 || totalEntries > ARCHIVE_MAX_ENTRIES) throw new Error("archive has too many entries");
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const files = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compSize = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    // Windows 打的包用反斜杠做分隔符，先归一成 / 再匹配（否则找不到 SKILL.md）。
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    if (!name.endsWith("/") && name !== "") {
      if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method ${String(method)}`);
      const lhNameLen = buffer.readUInt16LE(localOffset + 26);
      const lhExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      if (dataStart + compSize > buffer.length) throw new Error("corrupt zip archive");
      const raw = buffer.subarray(dataStart, dataStart + compSize);
      const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
      files.push({ name, data });
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (files.length === 0) throw new Error("archive contains no files");
  let total = 0;
  for (const file of files) {
    total += file.data.length;
    if (total > ARCHIVE_MAX_TOTAL) throw new Error("archive too large");
  }
  return files;
}
function managedRoot() {
  const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), ".agents");
  return join(agentsHome, "skills");
}
function dshRoot() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(dshHome, "skills");
}
function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const block = match?.[1];
  if (block === void 0) return {};
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    const key = pair?.[1];
    const valueText = pair?.[2];
    if (key === void 0 || valueText === void 0) continue;
    const value = valueText.trim();
    if (value === "true") fields[key] = true;
    else if (value === "false") fields[key] = false;
    else fields[key] = value;
  }
  return fields;
}
async function walkSkillDir(dir, prefix, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walkSkillDir(join(dir, entry.name), rel, out);
    else if (entry.name !== BUNDLED_STAMP) out.push(rel);
  }
}

async function readSkillMeta(root, dir) {
  let raw;
  try {
    raw = await readFile(join(root, dir, SKILL_FILE), "utf8");
  } catch {
    return void 0;
  }
  const fields = parseFrontmatter(raw);
  const name2 = typeof fields.name === "string" && fields.name !== "" ? fields.name : dir;
  const files = [];
  await walkSkillDir(join(root, dir), "", files);
  return {
    name: name2,
    dir,
    description: typeof fields.description === "string" ? fields.description : "",
    compatibility: typeof fields.compatibility === "string" ? fields.compatibility : "",
    fileCount: files.length,
    files: files.slice(0, 200),
    root: rootLabel(root),
    // 内置标记（dsh-seeker-bot patch）：面板据此显示「内置」徽章并禁用删除。
    builtin: await isBundledSkillDir(root, dir)
  };
}
/**
 * 插件内置技能的标记文件（dsh-seeker-bot patch）。
 *
 * 由 `src/triad/bundled-skills.ts` 在物化内置技能时写入：内置技能被同步到
 * `~/.dsh/skills/<name>/` 后，目录里除了技能内容还多这一个 stamp，记录
 * 「这个目录归 dsh-seeker-bot 管」以及当初装进去的内容 hash。
 *
 * 面板靠它区分「用户自己放的技能」（可删）与「插件随包分发的技能」
 * （不可删，删了启动时会自己回来）。这里刻意不 import 那个模块——
 * vendor 半身是 vendored 的独立 JS，跨目录 import 会把 TS 依赖拖进来。
 */
var BUNDLED_STAMP = ".dsh-seeker-bot-bundled.json";
/** 目录是否为本插件物化的内置技能。 */
async function isBundledSkillDir(root, dir) {
  try {
    await stat(join(root, dir, BUNDLED_STAMP));
    return true;
  } catch {
    return false;
  }
}
function rootLabel(root) {
  if (root === managedRoot()) return "agents";
  if (root === dshRoot()) return "dsh";
  return "other";
}
/**
 * 技能根下的目录名，符号链接/junction 也算。
 *
 * 安装器（ego lite 的 `~/.agents/skills/ego-browser` 就是一例）常把技能以
 * junction 挂进技能根；Node 的 readdir 对 junction 给 isDirectory()=false +
 * isSymbolicLink()=true，只按 isDirectory() 过滤会把整片技能当不存在。
 */
async function listRootDirNames(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      if ((await stat(join(root, entry.name))).isDirectory()) names.push(entry.name);
    } catch {
    }
  }
  return names;
}
async function listRootSkills(root) {
  const views = [];
  const entries = await listRootDirNames(root);
  for (const dir of entries) {
    const meta = await readSkillMeta(root, dir);
    if (meta !== void 0) views.push(meta);
  }
  return views;
}
async function readBundles(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, BUNDLES_FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && parsed.version === 1 && Array.isArray(parsed.bundles)) {
      return parsed;
    }
  } catch {
  }
  return { version: 1, bundles: [] };
}
async function writeBundles(root, file) {
  await mkdir(root, { recursive: true });
  const target = join(root, BUNDLES_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(file, null, 2)}
`, "utf8");
  await rename(temp, target);
}
/**
 * 技能包分类（dsh-triad patch）：账本里每条 bundle 多一个可选的 categories 字符串数组。
 * 老账本没有这个字段 —— 读到时一律归一成空数组（未分类），写入时只保留去空白、去重、
 * 限长限量的条目；脏字段直接丢弃而不是报错，面板不该因为一个坏分类整页打不开。
 */
var CATEGORY_MAX_LEN = 24;
var CATEGORY_MAX_PER_BUNDLE = 8;
function normalizeCategories(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().slice(0, CATEGORY_MAX_LEN);
    if (trimmed === "" || out.includes(trimmed)) continue;
    if (out.length >= CATEGORY_MAX_PER_BUNDLE) break;
    out.push(trimmed);
  }
  return out;
}
function categoriesOf(record) {
  return normalizeCategories(record.categories);
}
function checkedName(name2) {
  const trimmed = name2.trim();
  if (trimmed === "" || trimmed.length > NAME_MAX) {
    throw new Error(`name must be 1-${String(NAME_MAX)} characters`);
  }
  return trimmed;
}
function resolveSkillFile(base, path) {
  if (path === "" || path.includes("\0") || path.includes("\\")) {
    throw new Error(`unsupported skill file path: ${JSON.stringify(path)}`);
  }
  const target = resolve(base, path);
  const within = relative(resolve(base), target);
  if (within === "" || within.startsWith("..") || within.includes(sep + "..")) {
    throw new Error(`skill file escapes its directory: ${JSON.stringify(path)}`);
  }
  return target;
}
/**
 * 技能文件的 MIME 表（dsh-seeker-bot patch）。
 *
 * 原来的读文件接口**一律** `readFile(target, "utf8")` —— 图片、字体、压缩包被当文本
 * 解码后变成一串 U+FFFD，面板再把它按 markdown 渲染，用户看到的就是满屏乱码
 * （2026-10-20 用户实测：点 `assets/composer-icon.png` 出来一片 `IHDR\0\0...`）。
 * 现在二进制文件只回元数据，字节由 `/raw/` 子路由原样给出，客户端按 MIME 分派。
 */
var MIME_BY_EXT = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".bmp": "image/bmp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".zip": "application/zip", ".gz": "application/gzip",
  ".wasm": "application/wasm",
  // 文本类也进表：raw 路由对纯文本同样可用（比如把 SKILL.md 甩给浏览器原生
  // 查看器），且 /files/ 的 mime 字段因此能如实反映类型，而不是一律
  // octet-stream —— 面板上显示「1.6 KB · application/octet-stream」是错的信号。
  // 这些扩展名**不**触发下面的二进制分支，文本仍走 UTF-8 解码。
  ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8", ".yml": "text/yaml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8", ".ps1": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".toml": "text/plain; charset=utf-8"
};
/** 纯文本扩展名：文本查看器能正常显示，不进二进制分支。 */
var TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".csv", ".html", ".htm",
  ".css", ".js", ".mjs", ".ts", ".tsx", ".py", ".sh", ".ps1", ".xml", ".toml"
]);
/**
 * 是否二进制（不做 UTF-8 解码；客户端改走 <img>/<video>/<audio>/<iframe>）。
 *
 * 判据是「MIME 表里有、但不是纯文本扩展名」。用扩展名判而不是读字节猜类型：
 * 技能包是第三方内容，读头部猜 MIME 既慢又不可靠，而扩展名足够决定
 * 「能不能当文本打开」这一件事。
 */
function isBinaryFile(path) {
  const ext = extOf(path);
  if (ext === "") return false;
  if (TEXT_EXTENSIONS.has(ext)) return false;
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext);
}
function extOf(path) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return "";
  return path.slice(dot).toLowerCase();
}
/** 扩展名 → content-type；表外一律 octet-stream（浏览器按下载处理，不当文本渲染）。 */
function mimeOf(path) {
  return MIME_BY_EXT[extOf(path)] ?? "application/octet-stream";
}
/** raw 子路由的单文件上限（技能包里的演示录屏也够用）。 */
var RAW_MAX_BYTES = 64 * 1024 * 1024;
/**
 * 技能文件定位（名字校验 + 目录定位 + 越界防护 + 存在性）。
 * 文本读取与 raw 输出共用，避免两条路各写一套判据后分叉。
 */
async function locateSkillFile(skillName, relPath) {
  const name2 = checkedLookupName(skillName);
  // 目录名与 frontmatter name 可以不一致（手工拷进来的目录、改名导入），
  // 只按目录名找会让面板里点开的技能 404 —— 两个名字都要能定位到。
  const dir = await locateSkillDir(name2);
  if (dir === void 0) throw new Error(`skill ${JSON.stringify(name2)} not found`);
  if (relPath === "" || relPath.includes("\0") || relPath.includes("\\")) {
    throw new Error(`unsupported file path: ${JSON.stringify(relPath)}`);
  }
  const target = resolveSkillFile(dir, relPath);
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new Error(`file ${JSON.stringify(relPath)} not found in skill ${JSON.stringify(name2)}`);
  }
  if (!info.isFile()) throw new Error(`not a file: ${JSON.stringify(relPath)}`);
  return { name: name2, target, info };
}
/**
 * 技能身份（dsh-triad patch）：一个技能有两个名字 —— 目录名 `dir`（文件系统身份，
 * 删除/读文件/账本历史上用的就是它）与 SKILL.md frontmatter 的 `name`（DSH 内核
 * 调用技能时用的规范名）。两者可以不一致（手工拷目录、改名导入都会造成），旧实现
 * 只按规范名建索引，于是：账本里按目录名记的成员全部解析不到 → 技能包显示「没有
 * 技能」并从列表里消失；删除/查看文件按目录名找 → 404。下面这组 helper 把两个名字
 * 都当成合法入口，并在读到旧账本时自愈成规范名。
 */
/** 两个技能根下的全部技能（managed 先、dsh 后；同名目录/同名规范名只保留先出现的）。 */
async function allSkills() {
  const views = [];
  const seenDir = /* @__PURE__ */ new Set();
  const seenName = /* @__PURE__ */ new Set();
  for (const root of [managedRoot(), dshRoot()]) {
    for (const skill of await listRootSkills(root)) {
      const dirKey = skill.root + "/" + skill.dir;
      if (seenDir.has(dirKey)) continue;
      seenDir.add(dirKey);
      if (seenName.has(skill.name)) continue;
      seenName.add(skill.name);
      views.push(skill);
    }
  }
  return views;
}
function indexSkills(views) {
  const byName = /* @__PURE__ */ new Map();
  const byDir = /* @__PURE__ */ new Map();
  for (const skill of views) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
    if (!byDir.has(skill.dir)) byDir.set(skill.dir, skill);
  }
  return { byName, byDir };
}
/** 账本条目（规范名或历史目录名）→ 规范名；解析不到返回 undefined。 */
function resolveSkillEntry(entry, index) {
  const hit = index.byName.get(entry) ?? index.byDir.get(entry);
  return hit === void 0 ? void 0 : hit.name;
}
/** 账本条目数组（规范名或目录名混着都行）→ 去重后的技能视图数组。 */
async function viewsOf(entries) {
  const index = indexSkills(await allSkills());
  const views = [];
  for (const entry of entries) {
    const name2 = resolveSkillEntry(entry, index);
    if (name2 === void 0) continue;
    if (views.some((view) => view.name === name2)) continue;
    const skill = index.byName.get(name2);
    if (skill !== void 0) views.push(skill);
  }
  return views;
}
/** 查询用技能名：拒绝路径分隔与相对段（旧实现直接 join(root, 输入)，`../..` 能读出技能根外的文件）。 */
function checkedLookupName(value) {
  const name2 = checkedName(value);
  if (name2 === "." || name2 === ".." || name2.includes("/") || name2.includes("\\") || name2.includes(sep)) {
    throw new Error(`invalid skill name ${JSON.stringify(name2)}`);
  }
  return name2;
}
/** 定位技能目录：先按目录名直取，再按 frontmatter name 扫一遍两个根。 */
async function locateSkillDir(name2) {
  const roots = [managedRoot(), dshRoot()];
  for (const root of roots) {
    const candidate = join(root, name2);
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
    }
  }
  for (const root of roots) {
    for (const dir of await listRootDirNames(root)) {
      const meta = await readSkillMeta(root, dir);
      if (meta !== void 0 && meta.name === name2) return join(root, dir);
    }
  }
  return void 0;
}
async function snapshot() {
  const root = managedRoot();
  const views = await allSkills();
  const index = indexSkills(views);
  const ledger = await readBundles(root);
  const bundles = [];
  const healed = [];
  const assigned = /* @__PURE__ */ new Set();
  for (const record of ledger.bundles) {
    const skills = [];
    const canonical = [];
    const missing = [];
    let changed = false;
    for (const entry of record.skills) {
      const name2 = resolveSkillEntry(entry, index);
      if (name2 === void 0) {
        // 真被删掉的技能：账本里原样留着，让面板显式提示「失效引用」再由用户清理。
        missing.push(entry);
        canonical.push(entry);
        continue;
      }
      if (canonical.includes(name2)) {
        changed = true;
        continue;
      }
      if (name2 !== entry) changed = true;
      canonical.push(name2);
      const skill = index.byName.get(name2);
      if (skill !== void 0) skills.push(skill);
      assigned.add(name2);
    }
    bundles.push({ id: record.id, name: record.name, skillCount: skills.length, skills, missingSkills: missing, categories: categoriesOf(record) });
    if (changed) {
      Object.assign(record, { skills: canonical });
      healed.push(record.id);
    }
  }
  const loose = views.filter((skill) => !assigned.has(skill.name));
  // 自愈：把历史上按目录名写入的账本条目改写成规范名（只在真有变化时落盘）。
  if (healed.length > 0) {
    try {
      await writeBundles(root, { version: 1, bundles: ledger.bundles });
    } catch {
    }
  }
  return { bundles, loose };
}
async function createBundle(body) {
  const name2 = checkedName(typeof body.name === "string" ? body.name : "");
  const categories = normalizeCategories(body.categories);
  const root = managedRoot();
  const ledger = await readBundles(root);
  if (ledger.bundles.some((bundle) => bundle.name === name2)) {
    throw new Error(`bundle "${name2}" already exists`);
  }
  const base = name2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bundle";
  let id = base;
  let suffix = 2;
  while (ledger.bundles.some((bundle) => bundle.id === id)) {
    id = `${base}-${String(suffix)}`;
    suffix += 1;
  }
  const record = { id, name: name2, skills: [], categories };
  await writeBundles(root, { version: 1, bundles: [...ledger.bundles, record] });
  return { id, name: name2, skillCount: 0, skills: [], missingSkills: [], categories };
}
async function renameBundle(id, body) {
  const root = managedRoot();
  const ledger = await readBundles(root);
  const index = ledger.bundles.findIndex((bundle) => bundle.id === id);
  const existing = index === -1 ? void 0 : ledger.bundles[index];
  if (existing === void 0) throw new Error(`bundle ${JSON.stringify(id)} not found`);
  // PATCH 语义：name 与 categories 各自可选，只改真正传进来的那一项 ——
  // 「设置分类」不该被迫回传一个名字。
  const nextName = typeof body.name === "string" && body.name.trim() !== ""
    ? checkedName(body.name) : existing.name;
  if (nextName !== existing.name && ledger.bundles.some((bundle, i) => i !== index && bundle.name === nextName)) {
    throw new Error(`bundle "${nextName}" already exists`);
  }
  const record = { ...existing, name: nextName };
  if (Array.isArray(body.categories)) record.categories = normalizeCategories(body.categories);
  const bundles = [...ledger.bundles];
  bundles[index] = record;
  await writeBundles(root, { version: 1, bundles });
  const skills = await viewsOf(record.skills);
  return { id: record.id, name: nextName, skillCount: skills.length, skills, missingSkills: [], categories: categoriesOf(record) };
}
async function deleteBundle(id) {
  const root = managedRoot();
  const ledger = await readBundles(root);
  const bundles = ledger.bundles.filter((bundle) => bundle.id !== id);
  if (bundles.length === ledger.bundles.length) {
    throw new Error(`bundle ${JSON.stringify(id)} not found`);
  }
  await writeBundles(root, { version: 1, bundles });
}
async function setBundleSkills(id, body) {
  const root = managedRoot();
  const ledger = await readBundles(root);
  const index = ledger.bundles.findIndex((bundle) => bundle.id === id);
  const existing = index === -1 ? void 0 : ledger.bundles[index];
  if (existing === void 0) throw new Error(`bundle ${JSON.stringify(id)} not found`);
  const skillIndex = indexSkills(await allSkills());
  const raw = Array.isArray(body.skillNames) ? body.skillNames.filter((v) => typeof v === "string") : [];
  const skills = [];
  const unknown = [];
  for (const entry of raw) {
    const name2 = resolveSkillEntry(entry, skillIndex);
    if (name2 === void 0) {
      unknown.push(entry);
      continue;
    }
    if (!skills.includes(name2)) skills.push(name2);
  }
  if (unknown.length > 0) throw new Error(`skill ${JSON.stringify(unknown.join(", "))} not found`);
  const record = { ...existing, skills };
  // 从别的包里摘同一个技能时，历史条目可能记的是目录名 —— 两个别名都要清。
  const aliases = /* @__PURE__ */ new Set();
  for (const name2 of skills) {
    aliases.add(name2);
    const skill = skillIndex.byName.get(name2);
    if (skill !== void 0) aliases.add(skill.dir);
  }
  const bundles = ledger.bundles.map((candidate) => candidate.id === id ? record : { ...candidate, skills: candidate.skills.filter((name2) => !aliases.has(name2)) });
  await writeBundles(root, { version: 1, bundles });
  const views = skills.map((name2) => skillIndex.byName.get(name2)).filter((skill) => skill !== void 0);
  return { id: record.id, name: record.name, skillCount: views.length, skills: views, missingSkills: [], categories: categoriesOf(record) };
}
async function assignBundle(root, skillName, bundleId) {
  if (typeof bundleId !== "string" || bundleId === "") return;
  const ledger = await readBundles(root);
  const index = ledger.bundles.findIndex((bundle) => bundle.id === bundleId);
  if (index === -1) throw new Error(`bundle ${JSON.stringify(bundleId)} not found`);
  // 归组一律落到规范名：按目录名写入会让技能包在列表里看起来是空的。
  const canonical = resolveSkillEntry(skillName, indexSkills(await allSkills())) ?? skillName;
  const bundles = ledger.bundles.map((candidate, i) => i === index ? { ...candidate, skills: [...candidate.skills.filter((name2) => name2 !== canonical), canonical] } : { ...candidate, skills: candidate.skills.filter((name2) => name2 !== canonical && name2 !== skillName) });
  await writeBundles(root, { version: 1, bundles });
}
/**
 * 归一化上传文件表：
 *  - 反斜杠分隔符统一成 /（Windows 浏览器拖拽会给出来）；
 *  - 所有文件都挂在同一个顶层目录下时剥掉那层 —— 把整个技能文件夹拖进面板时，
 *    客户端带上了文件夹名，不剥就写成 skillDir/my-skill/SKILL.md，技能扫不到、
 *    面板里彻底消失；
 *  - 拒绝 .. 与绝对越界段。
 */
function normalizeUploadFiles(input) {
  const list = Array.isArray(input) ? input : [];
  const cleaned = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rawPath = typeof item.path === "string" ? item.path : "";
    const parts = [];
    for (const segment of rawPath.split("\\").join("/").split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        throw new Error(`unsupported skill file path: ${JSON.stringify(rawPath)}`);
      }
      parts.push(segment);
    }
    if (parts.length === 0) continue;
    cleaned.push({ path: parts.join("/"), data: typeof item.data === "string" ? item.data : "" });
  }
  if (cleaned.length === 0) return cleaned;
  const top = cleaned[0].path.split("/")[0];
  const nested = top !== void 0 && cleaned.every((file) => file.path.startsWith(top + "/"));
  if (!nested) return cleaned;
  return cleaned.map((file) => ({ path: file.path.slice(top.length + 1), data: file.data }));
}

/** 改写 SKILL.md 的 frontmatter name 字段，其余字段与正文原样保留。 */
function setFrontmatterName(raw, name2) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match === null) return `---\nname: ${String(name2)}\n---\n\n${raw}`;
  const body = raw.slice(match[0].length);
  const kept = [];
  let replaced = false;
  for (const line of match[1].split(/\r?\n/)) {
    if (/^\s*name\s*:/.test(line)) {
      if (!replaced) {
        kept.push(`name: ${String(name2)}`);
        replaced = true;
      }
      continue;
    }
    kept.push(line);
  }
  if (!replaced) kept.unshift(`name: ${String(name2)}`);
  return `---\n${kept.join("\n")}\n---\n${body}`;
}

async function installArchive(body) {
  const root = managedRoot();
  const raw = typeof body.archive === "string" ? body.archive : "";
  if (raw === "") throw new Error("empty archive");
  const files = unzipArchive(Buffer.from(raw, "base64"));
  const skillIndex = files.findIndex((file) => file.name === SKILL_FILE || file.name.endsWith("/" + SKILL_FILE));
  const skillEntry = skillIndex === -1 ? void 0 : files[skillIndex];
  if (skillEntry === void 0) throw new Error(`archive must contain ${SKILL_FILE}`);
  const meta = parseFrontmatter(skillEntry.data.toString("utf8"));
  let skillName = typeof meta.name === "string" ? meta.name.trim() : "";
  if (!NAME_PATTERN.test(skillName)) {
    const top = skillEntry.name.slice(0, skillEntry.name.length - SKILL_FILE.length).replace(/\/+$/, "");
    const fallback = top.split("/").pop() ?? "";
    skillName = fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  if (!NAME_PATTERN.test(skillName)) throw new Error("skill name must be lowercase alphanumeric/hyphen");
  if (skillName.length > NAME_MAX) throw new Error(`name must be 1-${String(NAME_MAX)} characters`);
  const skillDir = join(root, skillName);
  const base = skillEntry.name.slice(0, skillEntry.name.length - SKILL_FILE.length).replace(/\/+$/, "");
  let hasSkillFile = false;
  for (const file of files) {
    let rel = file.name;
    if (base !== "" && rel.startsWith(base + "/")) rel = rel.slice(base.length + 1);
    if (rel === SKILL_FILE) hasSkillFile = true;
    const target = resolveSkillFile(skillDir, rel);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.data);
  }
  if (!hasSkillFile) {
    const description = typeof body.description === "string" ? body.description.trim() : "";
    await writeFile(join(skillDir, SKILL_FILE), `---
name: ${skillName}
description: ${description || "Installed from the Skills panel."}
---

${description}`, "utf8");
  }
  await assignBundle(root, skillName, typeof body.bundleId === "string" ? body.bundleId : "");
  const finalMeta = await readSkillMeta(root, skillName);
  return { name: finalMeta?.name ?? skillName, dir: skillName, description: finalMeta?.description ?? "" };
}
async function installSkill(body) {
  if (typeof body.archive === "string" && body.archive !== "") {
    return installArchive(body);
  }
  const rawRequested = typeof body.skillName === "string" ? body.skillName.trim() : "";
  const requested = rawRequested === "" ? "" : checkedName(rawRequested);
  const root = managedRoot();
  const files = normalizeUploadFiles(body.files);
  const skillEntry = files.find((file) => file.path === SKILL_FILE);
  const fields = skillEntry === void 0 ? {} : parseFrontmatter(Buffer.from(skillEntry.data, "base64").toString("utf8"));
  const metaName = typeof fields.name === "string" ? fields.name.trim() : "";
  // 目录名 = 规范名：优先用户在面板里填的名字，其次 SKILL.md 的 name。
  let skillName = NAME_PATTERN.test(requested) ? requested : "";
  if (skillName === "" && NAME_PATTERN.test(metaName)) skillName = metaName;
  if (skillName === "") throw new Error("skill name must be lowercase alphanumeric/hyphen");
  if (skillName.length > NAME_MAX) throw new Error(`name must be 1-${String(NAME_MAX)} characters`);
  const skillDir = join(root, skillName);
  await mkdir(skillDir, { recursive: true });
  let hasSkillFile = false;
  for (const file of files) {
    if (file.path === SKILL_FILE) hasSkillFile = true;
    const target = resolveSkillFile(skillDir, file.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, Buffer.from(file.data, "base64"));
  }
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!hasSkillFile) {
    const text = `---
name: ${skillName}
description: ${description || "Installed from the Skills panel."}
---

${description}`;
    await writeFile(join(skillDir, SKILL_FILE), text, "utf8");
  } else if (metaName !== "" && metaName !== skillName) {
    // 名字被改过（用户改名，或文件夹名与 frontmatter 不一致）：把 SKILL.md 的 name
    // 一起改掉，保证「目录名 = frontmatter 名 = 面板名 = 账本键」四者一致 —— 否则
    // 技能包按目录名记的成员又会解析不到，散装区里冒出一个对不上号的技能。
    const raw = Buffer.from(skillEntry.data, "base64").toString("utf8");
    await writeFile(join(skillDir, SKILL_FILE), setFrontmatterName(raw, skillName), "utf8");
  }
  await assignBundle(root, skillName, typeof body.bundleId === "string" ? body.bundleId : "");
  const meta = await readSkillMeta(root, skillName);
  return {
    name: meta?.name ?? skillName,
    dir: skillName,
    description: meta?.description ?? "",
    renamed: metaName !== "" && metaName !== skillName
  };
}
/*
 * Git 一键导入（dsh-seeker-bot patch）：POST /import-git
 *
 * 用户要的是「粘一个 Git 地址就把技能包装进来」，所以后端得自己 clone、自己找
 * 技能、自己落盘。三段各有各的坑：
 *   · clone 段：地址来自用户输入，必须走参数白名单 + execFile（不经 shell），
 *     否则「--upload-pack=...」这种地址能直接变成命令执行；
 *   · 发现段：技能包仓库有三种常见布局（根 SKILL.md / skills 下一层 / 仓库下一层），
 *     按顺序取第一个命中的规则 —— 合并处理会让 skills 目录下的技能被装两遍；
 *   · 落盘段：目标目录名就是技能规范名，已存在则整体覆盖（先删再写）：半个覆盖
 *     的目录比不装更糟，旧文件残留会让技能内容前后矛盾。
 */
var GIT_CLONE_TIMEOUT_MS = 180000;
var GIT_IMPORT_MAX_SKILLS = 40;
var GIT_IMPORT_MAX_FILES = 2000;
var GIT_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
/** 复制时跳过的目录/文件名：版本库元数据、依赖、macOS 垃圾文件。 */
var GIT_SKIP_NAMES = /* @__PURE__ */ new Set([".git", "node_modules", ".DS_Store"]);
/** 本地地址（file:// 与绝对路径）只在显式打开测试开关时放行。 */
function allowLocalGitUrl() {
  return process.env.DSH_SKILL_GIT_ALLOW_LOCAL === "1";
}
/**
 * 校验 Git 地址。
 *
 * 用白名单而不是「以 - 开头就拒」：git 的 transport 表里 ext::sh -c ... 能直接
 * 执行命令，--upload-pack=... 又能改变 clone 的行为，只挡短横线挡不住这些。
 * 这里只放行 https / http / git / ssh 与 scp 风格的 git@host:path；本地 file://
 * 与绝对路径仅供测试（DSH_SKILL_GIT_ALLOW_LOCAL=1），生产环境一律拒绝。
 */
function checkedGitUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") throw new Error("url is required");
  if (raw.startsWith("-")) throw new Error(`invalid git url: ${JSON.stringify(raw)}`);
  // 空白/换行一律拒：空白可能让地址被拆成两个参数，换行是终端注入的老把戏。
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) throw new Error(`invalid git url: ${JSON.stringify(raw)}`);
  const lower = raw.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("git://") || lower.startsWith("ssh://")) return raw;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(raw)) return raw;
  if (allowLocalGitUrl() && (lower.startsWith("file://") || isAbsolute(raw))) return raw;
  throw new Error(`unsupported git url: ${JSON.stringify(raw)}`);
}
/** ref：分支/tag（git clone --branch 只认这两种），拒绝以 - 开头与空白。 */
function checkedGitRef(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return "";
  if (raw.startsWith("-") || /[\s\u0000-\u001f\u007f]/.test(raw)) throw new Error(`invalid git ref: ${JSON.stringify(raw)}`);
  return raw;
}
/** subdir：仓库内子目录，这里只做类型与空白校验，越界由 subdirSegments 挡。 */
function checkedGitSubdir(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return "";
  if (/[\u0000-\u001f]/.test(raw)) throw new Error(`invalid subdir: ${JSON.stringify(raw)}`);
  return raw;
}
/**
 * subdir → 路径段（顺带挡掉 ..）。
 *
 * 用户给的 subdir 是第三方输入，../../.. 能把「技能来源」指到 clone 目录之外
 * （比如用户 home 下的其他目录），所以先拆成段再拼，不直接 resolve 用户原串。
 */
function subdirSegments(subdir) {
  const segments = subdir.split("\\").join("/").split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw new Error(`invalid subdir: ${JSON.stringify(subdir)}`);
  return segments;
}
/** 子目录绝对路径（越界防护）：解析结果必须仍在 clone 目录内。 */
function resolveRepoSubdir(cloneDir, segments, subdir) {
  const target = resolve(cloneDir, ...segments);
  const within = relative(resolve(cloneDir), target);
  if (within !== "" && (within.startsWith("..") || within.includes(sep + ".."))) {
    throw new Error(`invalid subdir: ${JSON.stringify(subdir)}`);
  }
  return target;
}
/** 临时目录名：取地址最后一段，只为让根技能的兜底目录名有意义（如 my-skill）。 */
function repoDirName(url) {
  const tail = url.replace(/\/+$/g, "").split(/[/:]/).pop() ?? "";
  const cleaned = tail.replace(/\.git$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "repo" : cleaned.slice(0, NAME_MAX);
}
/** 目录名 → 技能名（小写、非字母数字转 -、去首尾 -）。 */
function normalizeSkillName(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
/** stderr 摘要：git 的进度输出是多行 + 回车，压成一行再截 300 字。 */
function summarizeGitOutput(text) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}...` : collapsed;
}
/**
 * 跑一次 git。
 *
 * execFile 不经 shell：url / ref 全来自用户输入，拼进命令行就是命令注入；
 * 每个参数原样进 argv，配合 clone 的 -- 分隔符，参数不会被当成选项。
 */
function runGit(args) {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, {
      timeout: GIT_CLONE_TIMEOUT_MS,
      windowsHide: true,
      // GIT_TERMINAL_PROMPT=0：私有仓库/需要凭据时立刻失败，而不是挂在终端提示上
      // 等到 180s 超时（宿主进程没有 TTY，等提示等于等死）。
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const label = args[0] === "-C" ? args[2] ?? "git" : args[0] ?? "git";
      const detail = String(stderr ?? "").trim();
      if (detail !== "") {
        reject(new Error(`git ${label} failed: ${summarizeGitOutput(detail)}`));
        return;
      }
      if (error.killed === true) {
        reject(new Error(`git ${label} timed out after ${String(GIT_CLONE_TIMEOUT_MS)}ms`));
        return;
      }
      reject(new Error(`git ${label} failed: ${summarizeGitOutput(error.message)}`));
    });
  });
}
async function isRegularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
/** 子目录名（排序，保证多技能导入顺序稳定、面板里显示顺序可预期）。 */
async function childDirNames(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !GIT_SKIP_NAMES.has(entry.name)) names.push(entry.name);
  }
  return names;
}
/** 某个目录下「自己带 SKILL.md」的子目录。 */
async function skillChildDirs(base, baseRel) {
  const out = [];
  for (const name of await childDirNames(base)) {
    if (!(await isRegularFile(join(base, name, SKILL_FILE)))) continue;
    out.push({ dir: join(base, name), rel: baseRel === "" ? name : `${baseRel}/${name}` });
  }
  return out;
}
/**
 * 技能发现（按顺序取第一个命中的规则）：
 *   a. base/SKILL.md      → 单技能（技能目录 = base）
 *   b. base/skills/<x>/SKILL.md → 多技能（技能包仓库的主场景）
 *   c. base/<x>/SKILL.md  → 多技能
 * 规则之间是「第一个命中就停」而不是合并：skills 目录本身也可能带 SKILL.md，
 * 合并会把同一批技能装两遍。
 */
async function discoverSkillDirs(base, baseRel) {
  if (await isRegularFile(join(base, SKILL_FILE))) return [{ dir: base, rel: baseRel }];
  const nestedRel = baseRel === "" ? "skills" : `${baseRel}/skills`;
  const nested = await skillChildDirs(join(base, "skills"), nestedRel);
  if (nested.length > 0) return nested;
  return skillChildDirs(base, baseRel);
}
/**
 * 递归收集技能目录下的普通文件（相对路径用 / 分隔，便于走 resolveSkillFile 校验）。
 *
 * 只收 isFile() 的普通文件：clone 出来的仓库里可能有符号链接（指向 /etc/passwd
 * 这种），跟着链接复制等于把宿主机文件读进技能目录。
 */
async function collectSkillFiles(dir, prefix, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (GIT_SKIP_NAMES.has(entry.name)) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectSkillFiles(join(dir, entry.name), rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await stat(join(dir, entry.name));
      out.push({ path: rel, size: info.size });
    } catch {
    }
  }
}
/**
 * POST /import-git：把 Git 仓库里的技能装进 managedRoot()。
 *
 * 流程：校验入参 → clone 到 mkdtemp 临时目录（finally 必删）→ 取 HEAD → 发现技能
 * → 逐个落盘（同名覆盖）→ 归组。单个技能失败不打断整批：进 skipped，让面板能把
 * 「装了什么 / 没装什么、为什么」一起显示出来。
 */
async function importGitSkills(body) {
  const payload = typeof body === "object" && body !== null ? body : {};
  const url = checkedGitUrl(payload.url);
  const ref = checkedGitRef(payload.ref);
  const subdir = checkedGitSubdir(payload.subdir);
  const bundleId = typeof payload.bundleId === "string" ? payload.bundleId : "";
  const root = managedRoot();
  await mkdir(root, { recursive: true });
  // 归组目标先验证：等 clone 完、文件也写完了再报「技能包不存在」，用户会看到
  // 技能已经装进来但请求是 400，面板刷新后状态对不上。
  if (bundleId !== "") {
    const ledger = await readBundles(root);
    if (!ledger.bundles.some((bundle) => bundle.id === bundleId)) {
      throw new Error(`bundle ${JSON.stringify(bundleId)} not found`);
    }
  }
  const tmp = await mkdtemp(join(tmpdir(), "dsh-skill-git-"));
  try {
    const cloneDir = join(tmp, repoDirName(url));
    /*
     * core.longpaths=true：技能包仓库常把升级卡 / benchmark 夹具一起提交，深层
     * 目录很容易越过 Windows 的 260 字符路径上限，此时 git 会报
     * "unable to access '...'"，整个导入直接 400。git 的 longpaths 开关能绕过
     * MAX_PATH（git for Windows 自带，不需要改系统注册表），代价为零。
     */
    const cloneArgs = ["-c", "core.longpaths=true", "clone", "--depth", "1", "--single-branch"];
    if (ref !== "") cloneArgs.push("--branch", ref);
    // -- 之后再放地址：即使地址长得像选项（--upload-pack=...），也只能当仓库参数。
    cloneArgs.push("--", url, cloneDir);
    await runGit(cloneArgs);
    const commit = (await runGit(["-C", cloneDir, "rev-parse", "HEAD"])).stdout.trim();
    let base = cloneDir;
    let baseRel = "";
    if (subdir !== "") {
      const segments = subdirSegments(subdir);
      base = resolveRepoSubdir(cloneDir, segments, subdir);
      baseRel = segments.join("/");
      try {
        if (!(await stat(base)).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new Error(`subdir ${JSON.stringify(subdir)} not found in repository`);
      }
    }
    const candidates = await discoverSkillDirs(base, baseRel);
    if (candidates.length === 0) {
      throw new Error(`no ${SKILL_FILE} found in ${subdir === "" ? "repository" : `subdir ${JSON.stringify(subdir)}`}`);
    }
    const installed = [];
    const skipped = [];
    const taken = /* @__PURE__ */ new Set();
    for (const candidate of candidates) {
      const label = candidate.rel === "" ? "." : candidate.rel;
      if (installed.length >= GIT_IMPORT_MAX_SKILLS) {
        skipped.push({ path: label, reason: `import limit reached (max ${String(GIT_IMPORT_MAX_SKILLS)} skills)` });
        continue;
      }
      let metaRaw;
      try {
        metaRaw = await readFile(join(candidate.dir, SKILL_FILE), "utf8");
      } catch {
        skipped.push({ path: label, reason: `cannot read ${SKILL_FILE}` });
        continue;
      }
      const fields = parseFrontmatter(metaRaw);
      const metaName = typeof fields.name === "string" ? fields.name.trim() : "";
      // 名字优先 frontmatter（技能作者定的规范名），不可用时才用目录名兜底。
      let skillName = NAME_PATTERN.test(metaName) && metaName.length <= NAME_MAX ? metaName : normalizeSkillName(basename(candidate.dir));
      if (!NAME_PATTERN.test(skillName) || skillName.length > NAME_MAX) {
        skipped.push({ path: label, reason: "cannot derive a valid skill name" });
        continue;
      }
      if (taken.has(skillName)) {
        skipped.push({ path: label, reason: `duplicate skill name ${JSON.stringify(skillName)}` });
        continue;
      }
      const files = [];
      await collectSkillFiles(candidate.dir, "", files);
      if (files.length > GIT_IMPORT_MAX_FILES) {
        skipped.push({ path: label, reason: `too many files (>${String(GIT_IMPORT_MAX_FILES)})` });
        continue;
      }
      let totalBytes = 0;
      for (const file of files) totalBytes += file.size;
      if (totalBytes > GIT_IMPORT_MAX_BYTES) {
        skipped.push({ path: label, reason: `too large (>${String(GIT_IMPORT_MAX_BYTES)} bytes)` });
        continue;
      }
      const dest = join(root, skillName);
      let overwritten = false;
      try {
        await stat(dest);
        overwritten = true;
      } catch {
      }
      // 整体覆盖：先删再写。只删不写会让面板里出现半个技能，先写不删会残留旧文件。
      if (overwritten) await rm(dest, { recursive: true, force: true });
      await mkdir(dest, { recursive: true });
      for (const file of files) {
        const target = resolveSkillFile(dest, file.path);
        await mkdir(join(target, ".."), { recursive: true });
        await copyFile(join(candidate.dir, ...file.path.split("/")), target);
      }
      taken.add(skillName);
      installed.push({
        name: skillName,
        dir: skillName,
        description: typeof fields.description === "string" ? fields.description : "",
        fileCount: files.length,
        ...(overwritten ? { overwritten: true } : {})
      });
    }
    for (const entry of installed) await assignBundle(root, entry.name, bundleId);
    // 记来源（dsh-seeker-bot patch）：只有 Git 导入会写账本，自建技能没有记录，
    // 因此永远不会被自动更新碰到。账本写失败不该把已经装好的技能变成 400。
    if (installed.length > 0) {
      try {
        await rememberSource({
          url,
          ref,
          subdir,
          bundleId,
          commit,
          skills: installed.map((entry) => entry.name)
        });
      } catch {
      }
    }
    return { ok: true, url, ref: ref === "" ? null : ref, commit, installed, skipped };
  } finally {
    // 临时目录无论成败都要删：clone 下来的仓库可能有几十 MB，失败重试几次就能堆满盘。
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
    }
  }
}
/*
 * 技能来源账本与定时自动更新（dsh-seeker-bot patch）
 *
 * 用户要的是「从 Git 装的技能能自动跟着仓库更新，自己建的技能别乱动」，所以：
 *   · 只有 importGitSkills 成功时才会写一条来源记录 —— 自建技能没有 url，天然
 *     不会被更新碰到；
 *   · 检查更新用 git ls-remote（只读远端 ref、不 clone），几十个来源也就几秒；
 *   · 定时器 60s 心跳、每拍自己算「到期没有」，这样 PATCH 改 intervalHours 下一拍
 *     就生效，不用重建定时器，也不会出现两次更新重叠。
 */
var SOURCES_FILE = ".skill-sources.json";
var SOURCE_VERSION = 1;
var SOURCE_DEFAULT_INTERVAL_HOURS = 6;
var SOURCE_TICK_MS = 60 * 1000;
var SOURCE_FIRST_DELAY_MS = 2 * 60 * 1000;
var SOURCE_MIN_INTERVAL_MS = 60 * 1000;
var SOURCE_INTERVAL_MAX_HOURS = 24 * 30;
/** 当前毫秒时间戳：面板按数字算「N 小时前」，用 ISO 字符串会让 Date.now() - ts 变成 NaN。 */
function nowMs() {
  return Date.now();
}
/** 账本里的时间字段归一化：老账本可能存过 ISO 字符串，读出来统一成毫秒数。 */
function toEpoch(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
/** 来源去重键：同一个仓库 + 同一个 ref + 同一个子目录才算同一条来源。 */
function sourceKey(url, ref, subdir) {
  return `${String(url).trim()}\u0000${String(ref ?? "").trim()}\u0000${String(subdir ?? "").trim()}`;
}
function defaultSourceSettings() {
  return { autoUpdate: true, intervalHours: SOURCE_DEFAULT_INTERVAL_HOURS };
}
/** settings 归一化：脏值回落到默认，面板不该因为一个坏字段整页打不开。 */
function normalizeSourceSettings(input) {
  const settings = defaultSourceSettings();
  if (typeof input !== "object" || input === null) return settings;
  if (typeof input.autoUpdate === "boolean") settings.autoUpdate = input.autoUpdate;
  const hours = Number(input.intervalHours);
  if (Number.isFinite(hours) && hours > 0) settings.intervalHours = Math.min(hours, SOURCE_INTERVAL_MAX_HOURS);
  return settings;
}
/** 一条来源记录的归一化：缺字段补默认，类型不对就丢（账本可能被手改坏）。 */
function normalizeSourceRecord(raw) {
  if (typeof raw !== "object" || raw === null) return void 0;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (url === "") return void 0;
  return {
    id: typeof raw.id === "string" ? raw.id.trim() : "",
    url,
    ref: typeof raw.ref === "string" && raw.ref.trim() !== "" ? raw.ref.trim() : null,
    subdir: typeof raw.subdir === "string" ? raw.subdir.trim() : "",
    bundleId: typeof raw.bundleId === "string" ? raw.bundleId : "",
    commit: typeof raw.commit === "string" ? raw.commit : "",
    skills: Array.isArray(raw.skills) ? raw.skills.filter((item) => typeof item === "string") : [],
    auto: raw.auto !== false,
    lastCheck: toEpoch(raw.lastCheck),
    lastUpdate: toEpoch(raw.lastUpdate),
    lastError: typeof raw.lastError === "string" ? raw.lastError : null
  };
}
/**
 * 读来源账本。
 *
 * 账本坏了（手改成非法 JSON、字段类型错）一律按空处理：这里读不出来时如果直接抛，
 * GET /sources 会 400，面板整个来源区块都打不开 —— 比「列表为空」糟糕得多。
 */
async function readSourceLedger() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(managedRoot(), SOURCES_FILE), "utf8"));
  } catch {
    parsed = void 0;
  }
  const settings = normalizeSourceSettings(parsed?.settings);
  const sources = [];
  const rawSources = Array.isArray(parsed?.sources) ? parsed.sources : [];
  for (const raw of rawSources) {
    const record = normalizeSourceRecord(raw);
    if (record === void 0) continue;
    if (record.id === "") record.id = `src-${String(sources.length + 1)}`;
    if (sources.some((item) => item.id === record.id)) continue;
    sources.push(record);
  }
  return { version: SOURCE_VERSION, settings, sources };
}
/** 写来源账本（临时文件 + rename，避免别的请求读到写了一半的 JSON）。 */
async function writeSourceLedger(ledger) {
  const root = managedRoot();
  await mkdir(root, { recursive: true });
  const target = join(root, SOURCES_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: SOURCE_VERSION, settings: ledger.settings, sources: ledger.sources }, null, 2)}\n`, "utf8");
  await rename(temp, target);
}
function nextSourceId(sources) {
  const taken = /* @__PURE__ */ new Set(sources.map((item) => item.id));
  let index = sources.length + 1;
  while (taken.has(`src-${String(index)}`)) index += 1;
  return `src-${String(index)}`;
}
/**
 * 导入成功后记来源（dsh-seeker-bot patch）。
 *
 * 只记「从 Git 装进来的」技能，自建技能永远不在账本里，也就永远不会被自动更新
 * 碰到 —— 这正是用户要的「自建的不参与更新」。重复导入同一仓库只更新已有记录，
 * auto / lastCheck 这些用户与历史状态原样保留。
 */
async function rememberSource(input) {
  const ledger = await readSourceLedger();
  const key = sourceKey(input.url, input.ref, input.subdir);
  const existing = ledger.sources.find((item) => sourceKey(item.url, item.ref, item.subdir) === key);
  if (existing === void 0) {
    const record = {
      id: nextSourceId(ledger.sources),
      url: input.url,
      ref: input.ref === "" ? null : input.ref,
      subdir: input.subdir,
      bundleId: input.bundleId,
      commit: input.commit,
      skills: input.skills,
      auto: true,
      lastCheck: null,
      lastUpdate: nowMs(),
      lastError: null
    };
    ledger.sources.push(record);
    await writeSourceLedger(ledger);
    return record;
  }
  existing.commit = input.commit;
  existing.skills = input.skills;
  if (input.bundleId !== "") existing.bundleId = input.bundleId;
  existing.lastUpdate = nowMs();
  existing.lastError = null;
  await writeSourceLedger(ledger);
  return existing;
}
/**
 * 远端 commit（git ls-remote，不 clone）。
 *
 * 未指定 ref 时看 HEAD；指定 ref 时同时查 refs/heads 与 refs/tags —— tag 可能是
 * annotated tag（ls-remote 直接给的是 tag 对象 SHA），必须优先取 ^{} 的 peeled
 * commit，否则「有更新」会永远为真。
 */
async function remoteCommitOf(url, ref) {
  const target = checkedGitUrl(url);
  const wanted = typeof ref === "string" ? ref.trim() : "";
  const args = ["-c", "core.longpaths=true", "ls-remote", "--", target];
  if (wanted === "") {
    args.push("HEAD");
  } else {
    args.push(`refs/heads/${wanted}`, `refs/tags/${wanted}`, `refs/tags/${wanted}^{}`);
  }
  const { stdout } = await runGit(args);
  const refs = /* @__PURE__ */ new Map();
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [sha, name] = trimmed.split(/\s+/);
    if (sha !== void 0 && name !== void 0) refs.set(name, sha);
  }
  if (wanted === "") {
    const head = refs.get("HEAD");
    if (head === void 0) throw new Error("remote HEAD not found");
    return head;
  }
  const found = refs.get(`refs/heads/${wanted}`) ?? refs.get(`refs/tags/${wanted}^{}`) ?? refs.get(`refs/tags/${wanted}`);
  if (found === void 0) throw new Error(`ref ${JSON.stringify(wanted)} not found on remote`);
  return found;
}
/** GET /sources：settings + 全部来源记录。 */
async function listSources() {
  const ledger = await readSourceLedger();
  return { settings: ledger.settings, sources: ledger.sources };
}
/** POST /sources/check {id?}：只读远端 ref，不 clone；单个来源失败不影响其它来源。 */
async function checkSources(body) {
  const payload = typeof body === "object" && body !== null ? body : {};
  const wantedId = typeof payload.id === "string" ? payload.id.trim() : "";
  const ledger = await readSourceLedger();
  const targets = wantedId === "" ? ledger.sources : ledger.sources.filter((item) => item.id === wantedId);
  if (wantedId !== "" && targets.length === 0) throw new Error(`source ${JSON.stringify(wantedId)} not found`);
  const updates = [];
  for (const record of targets) {
    const entry = { id: record.id, url: record.url, currentCommit: record.commit, remoteCommit: "", hasUpdate: false };
    try {
      const remoteCommit = await remoteCommitOf(record.url, record.ref ?? "");
      entry.remoteCommit = remoteCommit;
      entry.hasUpdate = remoteCommit !== "" && remoteCommit !== record.commit;
      record.lastCheck = nowMs();
      record.lastError = null;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      record.lastCheck = nowMs();
      record.lastError = entry.error;
    }
    updates.push(entry);
  }
  await writeSourceLedger(ledger);
  return { checked: targets.length, updates };
}
/**
 * POST /sources/:id/update：按记录重新导入。
 *
 * 复用 importGitSkills 而不是自己 clone 一遍：落盘、整体覆盖、归组、来源记录刷新
 * 全在那一处，两条路各写一套迟早分叉（比如一边记得排除 node_modules，另一边忘了）。
 */
async function updateSource(id) {
  const wantedId = typeof id === "string" ? id.trim() : "";
  const before = await readSourceLedger();
  const existing = before.sources.find((item) => item.id === wantedId);
  if (existing === void 0) throw new Error(`source ${JSON.stringify(wantedId)} not found`);
  let result;
  try {
    result = await importGitSkills({
      url: existing.url,
      ref: existing.ref ?? "",
      subdir: existing.subdir,
      bundleId: existing.bundleId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 失败也落账：面板上「上次更新失败：xxx」比一个静默的红点有用得多。
    const ledger = await readSourceLedger();
    const record = ledger.sources.find((item) => item.id === wantedId);
    if (record !== void 0) {
      record.lastError = message;
      await writeSourceLedger(ledger);
    }
    throw error;
  }
  // importGitSkills 内部已经 upsert 了来源记录，这里补 lastUpdate 并读回最新状态。
  const ledger = await readSourceLedger();
  const record = ledger.sources.find((item) => item.id === wantedId);
  if (record !== void 0) {
    record.lastUpdate = nowMs();
    record.lastError = null;
    await writeSourceLedger(ledger);
  }
  return {
    ok: true,
    source: record ?? existing,
    id: record?.id ?? existing.id,
    url: record?.url ?? existing.url,
    commit: result.commit,
    skills: record?.skills ?? [],
    installed: result.installed,
    skipped: result.skipped
  };
}
/**
 * POST /sources/update-all：只更新 auto 为 true 的来源（auto=false 是用户明确关掉的）。
 *
 * 必须先 ls-remote 比对、只对真有更新的来源 clone：定时任务每 6 小时跑一次，
 * 无条件全量重装等于定期把每个技能包重新下载一遍 —— 磁盘和网络都白烧，
 * 而且用户没改过的技能也会被整体覆盖。顺带把 lastCheck 写掉，
 * 面板上的「上次检查」才跟得上定时任务的真实节奏。
 */
async function updateAllSources() {
  const check = await checkSources({});
  const byId = new Map((check.updates ?? []).map((entry) => [entry.id, entry]));
  const ledger = await readSourceLedger();
  const updated = [];
  const failed = [];
  const skipped = [];
  for (const record of ledger.sources) {
    if (record.auto !== true) continue;
    const entry = byId.get(record.id);
    if (entry !== void 0 && typeof entry.error === "string") {
      failed.push({ id: record.id, url: record.url, error: entry.error });
      continue;
    }
    if (entry !== void 0 && entry.hasUpdate !== true) {
      skipped.push(record.id);
      continue;
    }
    try {
      const result = await updateSource(record.id);
      updated.push({ id: result.id, url: result.url, commit: result.commit, skills: result.skills });
    } catch (error) {
      failed.push({ id: record.id, url: record.url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { updated, failed, skipped };
}
/** PATCH /sources/settings {autoUpdate?, intervalHours?}：只改传进来的字段。 */
async function patchSourceSettings(body) {
  const payload = typeof body === "object" && body !== null ? body : {};
  const ledger = await readSourceLedger();
  if (typeof payload.autoUpdate === "boolean") ledger.settings.autoUpdate = payload.autoUpdate;
  if (payload.intervalHours !== void 0) {
    const hours = Number(payload.intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error("intervalHours must be a positive number");
    ledger.settings.intervalHours = Math.min(hours, SOURCE_INTERVAL_MAX_HOURS);
  }
  await writeSourceLedger(ledger);
  return { ok: true, settings: ledger.settings };
}
/** PATCH /sources/:id {auto?} */
async function patchSource(id, body) {
  const payload = typeof body === "object" && body !== null ? body : {};
  const ledger = await readSourceLedger();
  const record = ledger.sources.find((item) => item.id === id);
  if (record === void 0) throw new Error(`source ${JSON.stringify(id)} not found`);
  if (typeof payload.auto === "boolean") record.auto = payload.auto;
  await writeSourceLedger(ledger);
  return { ok: true, source: record };
}
/** DELETE /sources/:id：只删来源记录，技能目录原样留着（用户可能还在用）。 */
async function deleteSource(id) {
  const ledger = await readSourceLedger();
  const sources = ledger.sources.filter((item) => item.id !== id);
  if (sources.length === ledger.sources.length) throw new Error(`source ${JSON.stringify(id)} not found`);
  await writeSourceLedger({ ...ledger, sources });
  return { ok: true, id };
}
/** 自动更新间隔（毫秒）：settings 被改成 0/负数/NaN 时回落默认，且有下限防狂刷。 */
function sourceIntervalMs(settings) {
  const hours = Number(settings?.intervalHours);
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : SOURCE_DEFAULT_INTERVAL_HOURS;
  return Math.max(SOURCE_MIN_INTERVAL_MS, safeHours * 3600 * 1000);
}
/** 首次执行延迟（测试可用环境变量压到 0，省得真等两分钟）。 */
function sourceFirstDelayMs() {
  const raw = Number(process.env.DSH_SKILL_SOURCE_FIRST_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : SOURCE_FIRST_DELAY_MS;
}
/** 调度器状态：进程内记启动时刻与上次运行时刻。 */
var sourceScheduler = { startedAt: 0, lastRunAt: 0 };
/**
 * 定时器单拍：到点才真正跑 update-all。
 *
 * 用「固定 60s 心跳 + 自己算到期」而不是把 setInterval 直接设成 intervalHours：
 * settings 随时会被 PATCH 改掉，固定周期的 setInterval 改不了；心跳法下一拍就按
 * 新值判断，而且上一拍还在跑时 lastRunAt 已经更新，下一拍会直接跳过，天然防重叠。
 */
async function sourceSchedulerTick(now) {
  const at = typeof now === "number" ? now : Date.now();
  const ledger = await readSourceLedger();
  if (ledger.settings.autoUpdate !== true) return { skipped: true, reason: "autoUpdate off", updated: [], failed: [] };
  if (sourceScheduler.lastRunAt === 0 && at - sourceScheduler.startedAt < sourceFirstDelayMs()) {
    return { skipped: true, reason: "first delay", updated: [], failed: [] };
  }
  if (sourceScheduler.lastRunAt !== 0 && at - sourceScheduler.lastRunAt < sourceIntervalMs(ledger.settings)) {
    return { skipped: true, reason: "not due", updated: [], failed: [] };
  }
  // 先记运行时刻再跑：更新可能跑很久，期间来的下一拍必须看到「已经在跑了」。
  sourceScheduler.lastRunAt = at;
  const result = await updateAllSources();
  return { skipped: false, ...result };
}
/**
 * 读一个技能文件的文本内容。
 *
 * 二进制文件（图片 / 字体 / 压缩包…）**不再**强按 UTF-8 解码：那会把字节流变成
/**
 * 读一个技能文件的文本内容。
 *
 * 二进制文件（图片 / 字体 / 压缩包…）**不再**强按 UTF-8 解码：那会把字节流变成
 * 一串替换字符，客户端再套 markdown 渲染就成了满屏乱码（用户 2026-10-20 实测
 * 打开 `assets/composer-icon.png` 得到一片 `IHDR` 乱码）。改为只回元数据，
 * 真正的字节由 {@link sendSkillFileRaw} 原样给出。
 */
async function readSkillFile(skillName, relPath) {
  const { name: name2, target, info } = await locateSkillFile(skillName, relPath);
  const mime = mimeOf(relPath);
  if (isBinaryFile(relPath)) {
    return {
      name: name2, path: relPath, binary: true, mime,
      size: info.size, content: ""
    };
  }
  const content = await readFile(target, "utf8");
  return { name: name2, path: relPath, binary: false, mime, size: info.size, content };
}
/**
 * 原样输出技能文件的字节（图片 / 音频 / 视频 / PDF / 字体…）。
 *
 * 为什么单开一个路由而不是把字节塞进 JSON：base64 会让 1MB 的图变成 1.4MB 的
 * 字符串，还要在浏览器里再解码一次；`<img src>` 直接指这个地址最省事，浏览器
 * 自带缓存、分段请求与解码。
 */
async function sendSkillFileRaw(res, skillName, relPath, headOnly) {
  const { target, info } = await locateSkillFile(skillName, relPath);
  if (info.size > RAW_MAX_BYTES) {
    json(res, 413, { error: `file too large (>${String(RAW_MAX_BYTES)} bytes)` });
    return;
  }
  const headers = {
    "content-type": mimeOf(relPath),
    "content-length": String(info.size),
    "cache-control": "no-cache",
    // 技能内容由第三方技能包控制，属于不受信输入：禁止浏览器嗅探内容类型，
    // 免得一个伪装成 .png 的 HTML 被当成页面执行。
    "x-content-type-options": "nosniff"
  };
  /*
   * CSP 只加给「会主动加载资源」的那一族（HTML / SVG 可以被当页面打开）。
   * 图片 / 音视频 / PDF 一律不加 —— 它们本身不执行脚本，而 `sandbox` 指令会
   * 让 PDF 的浏览器查看器拒绝渲染、让 <video> 无法 seek，纯属自伤。
   */
  const ext = extOf(relPath);
  if (ext === ".html" || ext === ".htm" || ext === ".svg") {
    headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
  }
  res.writeHead(200, headers);
  if (headOnly) {
    res.end();
    return;
  }
  await new Promise((resolvePipe, rejectPipe) => {
    const stream = createReadStream(target);
    stream.on("error", rejectPipe);
    stream.on("end", resolvePipe);
    res.on("close", resolvePipe);
    stream.pipe(res);
  });
}

/**
 * 删除技能：规范名与目录名都接受，两个根下的同名技能全部删掉（旧实现只删第一个
 * 命中的目录，且只认目录名 —— 名字对不上就报 not found，面板里点删除没反应）。
 * 账本里按任一别名记的成员一起摘除。
 */
async function deleteSkill(skillName) {
  const name2 = checkedLookupName(skillName);
  const roots = [managedRoot(), dshRoot()];
  const removed = [];
  const aliases = /* @__PURE__ */ new Set([name2]);
  for (const root of roots) {
    for (const dir of await listRootDirNames(root)) {
      const meta = await readSkillMeta(root, dir);
      if (dir !== name2 && (meta === void 0 || meta.name !== name2)) continue;
      // 内置技能拒绝删除（dsh-seeker-bot patch）：它由插件随包分发，删掉
      // 下次启动就会原样装回来。与其让用户删了又莫名重现，不如当场说清。
      if (meta !== void 0 && meta.builtin === true) {
        throw new Error(`「${meta.name}」是 dsh-seeker-bot 内置技能，不可删除`);
      }
      try {
        await rm(join(root, dir), { recursive: true, force: true });
      } catch {
        continue;
      }
      aliases.add(dir);
      if (meta !== void 0) aliases.add(meta.name);
      removed.push({ root: rootLabel(root), dir, name: meta === void 0 ? dir : meta.name });
    }
  }
  if (removed.length === 0) throw new Error(`skill ${JSON.stringify(name2)} not found`);
  const root = managedRoot();
  const ledger = await readBundles(root);
  await writeBundles(root, {
    version: 1,
    bundles: ledger.bundles.map((candidate) => ({
      ...candidate,
      skills: candidate.skills.filter((candidateName) => !aliases.has(candidateName))
    }))
  });
  return { removed };
}
function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const a = address.toLowerCase();
  if (a === "::1") return true;
  const ipv4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  const octets = ipv4.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function hostNameOf(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close <= 1) return null;
    const suffix = host.slice(close + 1);
    if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
    return host.slice(1, close);
  }
  const firstColon = host.indexOf(":");
  const lastColon = host.lastIndexOf(":");
  if (firstColon !== lastColon) return null;
  return firstColon === -1 ? host : host.slice(0, firstColon);
}
function loopbackAllowed(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const host = hostNameOf(req.headers.host);
  if (host === null) return false;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache"
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
async function handle(ctx, req, res) {
  if (!loopbackAllowed(req)) {
    json(res, 403, { error: "loopback-only" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const rest = url.pathname.slice(ROUTE_PREFIX.length);
  const method = req.method ?? "GET";
  try {
    if (method === "GET" && (rest === "" || rest === "/list")) {
      json(res, 200, await snapshot());
      return;
    }
    if (method === "POST" && rest === "/bundles") {
      const body = await readBody(req);
      json(res, 200, await createBundle(body));
      return;
    }
    const matchId = /^\/bundles\/([^/]+)$/.exec(rest);
    if (method === "PATCH" && matchId !== null) {
      const body = await readBody(req);
      json(res, 200, await renameBundle(decodeURIComponent(matchId[1]), body));
      return;
    }
    if (method === "DELETE" && matchId !== null) {
      await deleteBundle(decodeURIComponent(matchId[1]));
      json(res, 200, { ok: true });
      return;
    }
    const matchSkills = /^\/bundles\/([^/]+)\/skills$/.exec(rest);
    if (method === "PUT" && matchSkills !== null) {
      const body = await readBody(req);
      json(res, 200, await setBundleSkills(decodeURIComponent(matchSkills[1]), body));
      return;
    }
    if (method === "POST" && rest === "/skills") {
      const body = await readBody(req);
      json(res, 200, await installSkill(body));
      return;
    }
    // Git 一键导入（dsh-seeker-bot patch）：粘一个仓库地址就把里面的技能装进来。
    if (method === "POST" && rest === "/import-git") {
      const body = await readBody(req);
      json(res, 200, await importGitSkills(body));
      return;
    }
    /*
     * 技能来源路由（dsh-seeker-bot patch）。
     *
     * 静态路径（/sources/check、/sources/update-all、/sources/settings）必须排在
     * /sources/:id 前面，否则 "check" 会被当成一个来源 id 吃掉。
     */
    if (method === "GET" && rest === "/sources") {
      json(res, 200, await listSources());
      return;
    }
    if (method === "POST" && rest === "/sources/check") {
      const body = await readBody(req);
      json(res, 200, await checkSources(body));
      return;
    }
    if (method === "POST" && rest === "/sources/update-all") {
      json(res, 200, await updateAllSources());
      return;
    }
    if (method === "PATCH" && rest === "/sources/settings") {
      const body = await readBody(req);
      json(res, 200, await patchSourceSettings(body));
      return;
    }
    const matchSourceUpdate = /^\/sources\/([^/]+)\/update$/.exec(rest);
    if (method === "POST" && matchSourceUpdate !== null) {
      json(res, 200, await updateSource(decodeURIComponent(matchSourceUpdate[1])));
      return;
    }
    const matchSource = /^\/sources\/([^/]+)$/.exec(rest);
    if (method === "PATCH" && matchSource !== null) {
      const body = await readBody(req);
      json(res, 200, await patchSource(decodeURIComponent(matchSource[1]), body));
      return;
    }
    if (method === "DELETE" && matchSource !== null) {
      json(res, 200, await deleteSource(decodeURIComponent(matchSource[1])));
      return;
    }
    const matchSkillDelete = /^\/skills\/([^/]+)$/.exec(rest);
    if (method === "DELETE" && matchSkillDelete !== null) {
      const result = await deleteSkill(decodeURIComponent(matchSkillDelete[1]));
      json(res, 200, { ok: true, ...result });
      return;
    }
    /*
     * 原始字节路由（dsh-seeker-bot patch）：/skills/<name>/raw/<relPath>
     *
     * 只给二进制/媒体文件用，客户端拿到 MIME 后直接 <img>/<video>/<audio>/<iframe>
     * 指过来。文本文件仍然走下面的 JSON 接口 —— 那条路要带 content 做预览。
     */
    const matchSkillRaw = /^\/skills\/([^/]+)\/raw\/(.+)$/.exec(rest);
    if ((method === "GET" || method === "HEAD") && matchSkillRaw !== null) {
      await sendSkillFileRaw(
        res,
        decodeURIComponent(matchSkillRaw[1]),
        decodeURIComponent(matchSkillRaw[2]),
        method === "HEAD"
      );
      return;
    }
    const matchSkillFile = /^\/skills\/([^/]+)\/files\/(.+)$/.exec(rest);
    if (method === "GET" && matchSkillFile !== null) {
      const file = await readSkillFile(
        decodeURIComponent(matchSkillFile[1]),
        decodeURIComponent(matchSkillFile[2])
      );
      json(res, 200, file);
      return;
    }
    json(res, 404, { error: `no route for ${method} ${rest}` });
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}
async function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      void handle(ctx, req, res);
    }
  }), "dsh-skill-manager: routes");
  /*
   * 定时自动更新（dsh-seeker-bot patch）。
   *
   * 60s 心跳、由 sourceSchedulerTick 自己算到期（见那里的注释）；首次执行延迟
   * 2 分钟是为了避开宿主启动时的 IO 高峰（插件物化内置技能、扫技能根都在那几秒）。
   * 任何一次失败都只写进账本 lastError —— 定时任务把宿主带崩是不可接受的。
   */
  ctx.effect(() => {
    sourceScheduler.startedAt = Date.now();
    sourceScheduler.lastRunAt = 0;
    const timer = setInterval(() => {
      void sourceSchedulerTick().catch(() => {
      });
    }, SOURCE_TICK_MS);
    // 别让这个定时器把宿主进程钉住不退出。
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }, "dsh-skill-manager: source auto update");
}
export {
  apply,
  inject,
  name
};
