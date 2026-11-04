/**
 * dsh-recall-plugin — 配置持久化文件源（移植接缝 ④，本仓库新增模块）
 *
 * 为什么需要它（为什么不能只靠官方 settings 面）：
 *   参考实现把「设置页卡片保存」整条压在官方 settings 服务上
 *   （routes-manage 的 config-set → settings.update(ns, patch)；config-get →
 *   describe().user；config-reset → replace/update）。0.1.7+ 新面下 settings ns
 *   = profile entry id，且**只有 schema 标了 .volatile() 的字段可写**；本插件
 *   被 vendor 进 dsh-seeker-bot 后 entry 是宿主插件的行 id（dsh-seeker-bot），
 *   而宿主入口（src/host.ts）并没有向 loader 导出 recall 的 Config schema。
 *   于是 settings.update(宿主 ns, recall patch) 大概率报「unknown namespace /
 *   schema 校验失败」，用户点「保存」必失败——功能装上了但不可用，属静默失效。
 *   因此把配置持久化改成自管文件源：三层语义不变（文件 > profile 行 config >
 *   DEFAULTS），但「用户设置页写的值」落在本插件自己的文件里，不依赖 settings
 *   面是否可写。官方 settings 接入仍然保留（settings-bridge 照旧注册；旧面
 *   路径自然跳过、新面能挂上就继续热更 base），只是不再是唯一通路。
 *
 * 文件位置：`(DSH_HOME || ~/.dsh)/dsh-recall-snapshots/config.json`
 *   —— 与影子仓库容器同目录。选它而不是 DSH_HOME 根的理由：用户卸载插件 /
 *   清理快照容器时配置一起消失，不留孤儿文件；也不与宿主自己的配置命名空间
 *   抢位置。
 *
 * 纪律：
 *   · 读取路径**绝不抛**——readConfigFile 在 apply 期被调用，抛错会连累整棵
 *     插件树 boot。缺失/损坏/非对象一律返回 {}（损坏文件改名隔离保留现场）。
 *   · 写入走 tmp + rename 原子落盘——中途崩溃/断电不会留下半截 JSON（半截
 *     JSON 在读取侧会被判损坏并隔离，等于用户配置全丢，不能靠读取侧兜底）。
 *   · 只认 ResolvedConfig 的字段白名单（KNOWN_KEYS）：ResolvedConfig 增字段而
 *     这里漏改会**编译期报错**，消灭「两处同步改」的人工同步面（与 config.ts
 *     的 DEFAULTS 同一套纪律）。
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { ResolvedConfig } from '../types/config.js'

/** 写配置的结果（clear 也复用它）：失败带人话 message，端点直接回给客户端。 */
export type ConfigWriteResult = { ok: true } | { ok: false; message: string }

// 字段白名单：ResolvedConfig 的 key 集合的运行时镜像。用 Record<keyof
// ResolvedConfig, true> 标注——ResolvedConfig 新增/删除字段时这里漏改会编译期
// 报错（与 host/config.ts 的 DEFAULTS 同款约束）。
const KNOWN_KEYS: Record<keyof ResolvedConfig, true> = {
  gcSnaps: true,
  gcHours: true,
  maxFileBytes: true,
  maxWorkspaceBytes: true,
  scanBudgetMs: true,
  snapshotBudgetMs: true,
  maxSnapshotsPerWorkspace: true,
  baseExcludes: true,
  refillDraft: true,
  snapshotEnabled: true,
  messageOnly: true,
  // 2026-11-04 新增（文件回退总开关，默认关）
  fileRollbackEnabled: true,
  archiveOriginal: true,
  editSubmitsImmediately: true,
  retentionDays: true,
  locale: true,
}

/**
 * 配置文件的容器目录：与快照容器同目录（`~/.dsh/dsh-recall-snapshots`）。
 * DSH_HOME 每次调用时现取——运行期改 env（测试/headless 多 profile）时能立刻
 * 跟随，不缓存模块级路径。os.homedir() 在 win32/POSIX 都成立。
 */
export function configFileDir(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-recall-snapshots')
}

/** 配置文件绝对路径（端点错误信息里会带上它，方便用户自己去删/改）。 */
export function configFilePath(): string {
  return path.join(configFileDir(), 'config.json')
}

/**
 * 从任意来源（JSON.parse 结果 / 用户手改的文件 / 端点 patch）里只挑
 * ResolvedConfig 认识的字段，且只做「形状对得上」的浅过滤。
 *
 * 为什么不在这里校验数值范围/枚举合法性：那是 createConfig 的职责（它按
 * typeof/pickNumber 判非法并回退默认，行为在参考实现里已被大量用例钉死）。
 * 在这里复制一套判定只会制造第二份事实源、日后漂移——这里只负责「不让垃圾
 * 字段进入配置链」，值域交给 createConfig。
 */
function pickKnown(raw: unknown): Partial<ResolvedConfig> {
  const out: Record<string, unknown> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out as Partial<ResolvedConfig>
  const source = raw as Record<string, unknown>
  for (const key of Object.keys(KNOWN_KEYS) as Array<keyof ResolvedConfig>) {
    const value = source[key as string]
    if (value === undefined) continue
    if (key === 'baseExcludes') {
      // 排除表必须是字符串数组；建库时两侧脚本还要求非空（空数组回落
      // BASE_EXCLUDES，见 config.ts），这里只做类型过滤
      if (!Array.isArray(value)) continue
      out[key as string] = value.filter((item) => typeof item === 'string' && item.trim())
      continue
    }
    out[key as string] = value
  }
  return out as Partial<ResolvedConfig>
}

/** 损坏文件隔离：改名保留现场，让用户/支持者还能翻到原始坏内容。 */
function quarantineConfigFile(reason: string): void {
  const file = configFilePath()
  try {
    fs.renameSync(file, file + '.' + reason + '-' + String(Date.now()))
  } catch (error) {
    // 隔离失败（权限/竞态：另一个进程刚删了它）——只影响「保留现场」，
    // 调用方本来就只承诺「不抛」，因此在这里静默收口。
  }
}

/**
 * 读用户层配置（Partial：只含用户显式写过的字段）。
 * 文件缺失（从未保存过）→ {}；损坏/非对象 → 隔离改名 + {}；一律不抛。
 */
export function readConfigFile(): Partial<ResolvedConfig> {
  const file = configFilePath()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // ENOENT 是常态（用户没存过配置）；其余（权限/IO）也不拦 apply——
    // 配置读不到就按「无用户覆盖」跑 DEFAULTS，功能可用性优先。
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code
    if (code !== 'ENOENT') console.error('recall config file unreadable (fallback to defaults): ' + String(error))
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // 损坏文件不能抛：readConfigFile 在 apply 期同步调用，抛错会打断整棵
    // 插件树 boot（参考实现纪律：配置面故障只降级、不连累主链）。
    quarantineConfigFile('corrupt')
    console.error('recall config file corrupted, quarantined: ' + file)
    return {}
  }
  return pickKnown(parsed)
}

/**
 * 合并写：文件里已有的用户配置保留，patch 里**非 undefined** 的字段覆盖。
 * 原子落盘（tmp + rename）；失败返回 { ok:false, message }，由端点转
 * RECALL_SETTINGS_WRITE_FAILED 呈现给用户（message 带路径，便于自查权限）。
 *
 * 为什么是「合并」不是「整覆盖」：设置卡片按字段增量提交（保存一个开关不该
 * 抹掉用户之前调过的其它值）。清空用户层走 clearConfigFile（config-reset）。
 */
export function writeConfigFile(patch: Partial<ResolvedConfig>): ConfigWriteResult {
  const file = configFilePath()
  const dir = configFileDir()
  // 先读旧值再合并：读损坏文件会走隔离 + 返回 {}，等价于「从干净状态重写」
  const next: Record<string, unknown> = { ...readConfigFile() }
  const clean = pickKnown(patch)
  for (const key of Object.keys(clean) as Array<keyof ResolvedConfig>) {
    const value = clean[key]
    if (value === undefined) continue
    next[key as string] = value
  }
  // tmp 名带 pid + 时间戳：同目录并发写（多个宿主进程）不会互相踩临时文件
  const tmp = file + '.tmp-' + String(process.pid) + '-' + String(Date.now())
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch (cleanupError) {
      // 临时文件清理失败不影响「写失败」这个结论（下次写入会换个 tmp 名）；
      // 残留的 .tmp-* 在容器目录里，不影响读取（读的是 config.json）
    }
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: file + '：' + detail }
  }
}

/**
 * 删除用户层配置（config-reset 用）。幂等：文件不存在视为成功。
 * 失败（权限/占用）返回 ok:false，由端点转 RECALL_SETTINGS_WRITE_FAILED。
 */
export function clearConfigFile(): ConfigWriteResult {
  const file = configFilePath()
  try {
    fs.rmSync(file, { force: true })
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: file + '：' + detail }
  }
}
