/**
 * dsh-recall-plugin — 排除表的「目录形态」判据（issue #18，纯函数无 ctx 依赖）
 *
 * 用途：判断某个工作区根**自身**是否就是一个不该建快照的目录（`target/debug`、
 * `dist` 这类构建产物目录）。为什么需要独立模块：`baseExcludes` 是 gitignore
 * 语义的**相对 root** 路径模式，天然回答不了「root 自己算不算被排除」——实测
 * root=`…/src-tauri/target/debug` 时 7000 个产物条目只有 2000 个（root 内部
 * 恰好同名的 `build/` 子树）被挡下，root 整体仍进快照，单会话可积到 GB 级。
 *
 * 判定只需「目录名」一维，故复用脚本侧 oversize 目录跳过的同一判据（见
 * scripts.pwsh.ts / scripts.posix.ts 的 oversizeListBlock：无通配、无内部斜杠、
 * 非 `!` 反选、非 `#` 注释）。两处必须同形态——改判据要同步脚本侧，脚本侧由
 * scripts-contract.test.js 钉文本、本模块由 exclude-patterns.test.js 钉行为。
 */

// 与脚本侧「不参与目录跳过」的通配/分隔符集合同源（pwsh 的 `[*?\[\]/\\]`
// 与 posix 的 `*?[/` 取并集里的严格侧）：含这些字符的 pattern 语义不限于
// 「一个目录名」，交给 git 自己按 gitignore 处理，不参与 root 判定。
const NON_NAME_CHARS = /[*?[\]\\/]/

/** 取排除表里的目录形态项（去掉 `target/` 的尾斜杠，返回纯目录名） */
export function dirNamePatterns(base: unknown): string[] {
  if (!Array.isArray(base)) return []
  const out: string[] = []
  for (const raw of base) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (!t || t.charAt(0) === '#' || t.charAt(0) === '!') continue
    const name = t.replace(/\/+$/, '')
    if (!name || NON_NAME_CHARS.test(name)) continue
    out.push(name)
  }
  return out
}

/**
 * root 的路径段命中目录形态排除项时返回命中的那一段（如 `target`），否则 null。
 *
 * 为什么要看**每一段**而不是 basename：issue #18 的最坏形态 root 是
 * `…/src-tauri/target/debug`，basename 是 `debug`、不在默认表里——只比 basename
 * 会漏掉它；真正表明「这是构建产物」的是上一层路径段 `target`。
 * 为什么首段（win32 盘符）不参与：`C:` 是卷标识不是用户建目录，UNC 的
 * 服务器/共享名同理；POSIX 的根空段在 split 时已被滤掉。
 * 大小写：win32 不敏感、POSIX 敏感，与两平台文件系统语义对齐（返回的仍是
 * 排除表里的原始写法，供文案展示）。
 */
export function buildArtifactRootSegment(root: unknown, base: unknown, isWin: boolean): string | null {
  const names = dirNamePatterns(base)
  if (!names.length || typeof root !== 'string' || !root) return null
  const parts = root.split(/[\\/]+/).filter((s) => s.length > 0)
  const segs = isWin && /^[a-zA-Z]:$/.test(parts[0] || '') ? parts.slice(1) : parts
  const pool = isWin ? names.map((n) => n.toLowerCase()) : names
  for (const seg of segs) {
    const i = pool.indexOf(isWin ? seg.toLowerCase() : seg)
    // 命中值落局部再判空（A6）：indexOf 命中与索引读取分两步，才符合
    // noUncheckedIndexedAccess 下的显式判空纪律。
    const hit = i >= 0 ? names[i] : undefined
    if (hit !== undefined) return hit
  }
  return null
}

/**
 * 面向用户的停用说明（init 与 snapshot-info 共用，保证两处文案逐字一致）。
 * 遵守诊断文案纪律：≤140 字符、不嵌长路径（只嵌命中的段名）、给出可行动的出口。
 * 出口就是排除表本身——它是设置页可编辑字段，删掉对应项即恢复该目录的快照。
 *
 * A4 起这是**回落文案**：两个端点同时下发命中段名（artifactSeg），client 优先
 * 按段名本地取词（notice.buildRoot），本函数保留一个版本周期供旧 client 展示。
 */
export function buildRootNotice(segment: string): string {
  return '当前工作区位于构建产物目录（路径段 ' + segment + '），已跳过项目快照；如需在此目录使用撤回，请在插件设置里从「基础排除表」移除该项。'
}
