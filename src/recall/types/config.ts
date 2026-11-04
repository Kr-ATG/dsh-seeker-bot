// 配置域类型（事实来源：src/host/config.js 的 Config schema 与 DEFAULTS）。
// 仅类型导出——共享运行时常量继续住 src/host/config.js。
//
// M4 起消费：config.ts 的 `createConfig(raw: RawConfig): ResolvedConfig` 与
// `DEFAULTS: ResolvedConfig` 标注（schema 增删字段时漏改 DEFAULTS 编译期报错，
// 消灭「改默认值两处同步改」的人工同步面）。

// A4：界面语言偏好（auto=跟随系统；zh/en=显式锁定）。client 侧解析成具体
// 语言（locales/index.ts 的 resolveLocale），host 只做搬运与取值校验。
export type LocalePref = 'auto' | 'zh' | 'en'

export interface ResolvedConfig {
  gcSnaps: number
  gcHours: number
  maxFileBytes: number
  // issue #24 快照护栏：单工作区纳入总量上限与前置扫描时间预算
  //（两者均为 0 时表示不限制）
  maxWorkspaceBytes: number
  scanBudgetMs: number
  // issue #29：单次快照脚本（扫描 + add + 写索引/打 tag）的总时限，兜底
  // scanBudgetMs 管不到的写入阶段；0 表示不限制
  snapshotBudgetMs: number
  maxSnapshotsPerWorkspace: number
  baseExcludes: string[]
  refillDraft: boolean
  snapshotEnabled: boolean
  // issue #31：只登记撤回记录、不写文件快照。按条目落 files:false，
  // 因此关闭开关后老条目仍是「仅消息」，不会被误恢复文件树。
  // 2026-11-04：默认改为 true（本仓库默认「撤回只撤对话」）。
  messageOnly: boolean
  // 2026-11-04 新增：文件回退总开关（默认 false）。关闭时 preview 不列文件
  // 清单、execute 恒为 session-only——对升级前拍下的旧快照同样生效。
  fileRollbackEnabled: boolean
  archiveOriginal: boolean
  // issue #26：编辑提交后自动发出改后的文本（关闭则只回填输入框）
  editSubmitsImmediately: boolean
  retentionDays: number
  locale: LocalePref
}

export type RawConfig = Partial<ResolvedConfig>
