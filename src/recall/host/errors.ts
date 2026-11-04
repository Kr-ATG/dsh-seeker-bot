/**
 * dsh-recall-plugin — 错误码单一事实源（H3）
 *
 * 端点响应 code 字段的常量表：此前 code 字符串（STALE/NO_SNAPSHOT/...）
 * 散布各 handler 内联，改一处漏一处。这里集中导出、值保持不变（code 是
 * client 已消费的线上契约，不改值只收拢），每条注释说明触发条件与 client
 * 预期行为。client 侧按 code 查 locales 词典的 `err.<code>`（未命中回退
 * host 返回的 message）——机器码与人文案分层可译（A4）；码表本身仍是
 * 「端点返回的 code 都在表内」的一致性扫描锚点。
 */

// 预览后项目文件变化（P0-3 STALE total 比对失败）——client 自动重新预览
export const RECALL_STALE = 'STALE' as const
// 目标消息没有可用项目快照（未捕获/已删除）
export const RECALL_NO_SNAPSHOT = 'NO_SNAPSHOT' as const
// 快照存储不可用（store 未建/已失配）
export const RECALL_NO_STORE = 'NO_STORE' as const
// 目标工作区 agent 运行中（P0-1 保护，preview/execute 双处拒绝）
export const RECALL_AGENT_BUSY = 'AGENT_BUSY' as const
// 回退失败（H1）——可能已自动救援恢复；message 携带救援结果
export const RECALL_ROLLBACK_FAILED = 'ROLLBACK_FAILED' as const
// 排除配置写入路径不在已知白名单内（防「借 API 写任意文件」）
export const RECALL_UNKNOWN_PATH = 'UNKNOWN_PATH' as const
// 配置字段类型/取值非法
export const RECALL_BAD_TYPE = 'BAD_TYPE' as const
// 配置补丁为空（无可写字段）
export const RECALL_EMPTY_PATCH = 'EMPTY_PATCH' as const
// settings 服务未组装（非 web 部署 / 未挂载）
export const RECALL_SETTINGS_UNAVAILABLE = 'SETTINGS_UNAVAILABLE' as const
// settings.update 写入被拒
export const RECALL_SETTINGS_WRITE_FAILED = 'SETTINGS_WRITE_FAILED' as const
// 请求体超过 1MB 上限（errBody 统一映射）
export const RECALL_BODY_TOO_LARGE = 'BODY_TOO_LARGE' as const
// 系统异常/未分类错误兜底（errBody 统一映射）
export const RECALL_ERROR = 'ERROR' as const
// 无法解析当前工作区（manage usage/delete）
export const RECALL_NO_ROOT = 'NO_ROOT' as const
// 缺少会话 ID（manage delete scope=session）
export const RECALL_NO_SESSION = 'NO_SESSION' as const
// 管理操作部分完成（deleteAll 有 store 失败）
export const RECALL_PARTIAL_DELETE = 'PARTIAL_DELETE' as const
// 未知管理操作（manage 端点 op 未识别）
export const RECALL_UNKNOWN_OP = 'UNKNOWN_OP' as const
// A3：store 磁盘格式高于本插件支持（或格式标记损坏），写操作（快照/撤回/
// 清理/删除）已按 fail-closed 短路；读路径（列表/状态）不受影响。
// client 预期：提示升级插件或修复 marker，不要引导用户重试直到问题解决。
export const RECALL_FORMAT_BLOCKED = 'FORMAT_BLOCKED' as const
// 未知 API 端点（/api/recall/<name> 无对应端点；exact 路由未命中由宿主返回 404）
export const RECALL_UNKNOWN_ENDPOINT = 'UNKNOWN_ENDPOINT' as const
// 磁盘 store 枚举（dump）失败：快照管理列表 / 批量删除 / 全部删除拿不到磁盘真值。
// 旧行为是静默返回空 Map（界面只有一棵空树），现已 fail-loud——错误细节同时进
// 「最近错误」。client 预期：显示失败提示并给重试入口，不要展示成「没有快照」。
export const RECALL_DUMP_FAILED = 'DUMP_FAILED' as const

// 语义锚点：H2 的索引损坏经 status 端点 errors 通道暴露（recordError 文本
// 前缀 'recall index corrupt'），不作为端点 code 返回。保留单一命名供
// 一致性扫描与未来若要升级为端点 code 时复用，避免「损坏」这一事实在
// 代码里无归属。
export const RECALL_INDEX_CORRUPT = 'INDEX_CORRUPT' as const

// 全量常量集合：供单测做「端点返回的 code 都在表内」的一致性扫描
export const ALL_CODES = Object.freeze([
  RECALL_STALE,
  RECALL_NO_SNAPSHOT,
  RECALL_NO_STORE,
  RECALL_AGENT_BUSY,
  RECALL_ROLLBACK_FAILED,
  RECALL_UNKNOWN_PATH,
  RECALL_BAD_TYPE,
  RECALL_EMPTY_PATCH,
  RECALL_SETTINGS_UNAVAILABLE,
  RECALL_SETTINGS_WRITE_FAILED,
  RECALL_BODY_TOO_LARGE,
  RECALL_ERROR,
  RECALL_NO_ROOT,
  RECALL_NO_SESSION,
  RECALL_PARTIAL_DELETE,
  RECALL_UNKNOWN_OP,
  RECALL_FORMAT_BLOCKED,
  RECALL_UNKNOWN_ENDPOINT,
  RECALL_DUMP_FAILED,
  RECALL_INDEX_CORRUPT,
])

// 错误码联合类型：由常量表派生（types/api.ts 的 errBody.code 引用此类型）。
// schema/端点改动 code 时，表内增删即自动反映到类型面——码表是单一事实源。
export type ErrorCode = (typeof ALL_CODES)[number]

