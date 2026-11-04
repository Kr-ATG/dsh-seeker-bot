// 撤回终态事件契约（issue #19；唯一事实源：事件名、payload 形状、版本号都
// 以本文件为准，README「事件契约」章节与此对偶）。消费方是同宿主任意 cordis
// 插件：ctx.on('dsh-recall/complete' | 'dsh-recall/failed', cb)。
//
// 事件名取 cordis 斜杠惯例 + 插件名命名空间防冲突（不用 issue 提议的
// 'recall:' 冒号式）。首发即稳定公共契约（不标 experimental）：新增字段
// （additive）走 minor；破坏性变更走 major 且 RECALL_EVENT_VERSION 升 2，
// 下游可按 version 分流。host 经 notify 端点收到 client 上报后 enrich 发出，
// 发送失败/监听器抛错不影响撤回主流程。

export const RECALL_EVENT_COMPLETE = 'dsh-recall/complete'
export const RECALL_EVENT_FAILED = 'dsh-recall/failed'
export const RECALL_EVENT_VERSION = 1

// 撤回成功终态。chatReverted=false 表示只回退了文件（无对话切点）；下游以
// 它做「是否清理该回合记忆」的第一判据，childSessionId 仅在 chatReverted
// 时非空。archiveRequested 是 fire-and-forget 的发起标记，不代表归档已落定。
export interface RecallCompleteEvent {
  version: 1
  sessionId: string             // 被撤回的原会话
  childSessionId: string | null // fork 出的新会话；纯文件回退时为 null
  scope: 'both' | 'session-only'
  cutSeq: number | null
  messageId: string             // 被撤回消息 ID（快照主键）
  root: string | null           // host enrich，解析失败为 null
  count: number                 // 回退文件数（session-only 恒 0）
  chatReverted: boolean
  archiveRequested: boolean     // 归档为 fire-and-forget，仅表示已发起
  time: number                  // host 收到上报的时间（ms）
}

// 撤回失败终态。stage='execute' 时文件是否已回退不确定（execute 抛异常情形），
// 文档显式注明；stage='fork' 表示文件已回退但对话未回退——此时绝不发
// complete，否则下游会误清该回合的记忆。code 仅 stage='execute' 时透传
// host 端点错误码（AGENT_BUSY / NO_SNAPSHOT 等）。sessionId 可为 null：
// client 上报缺会话上下文时（理论上不发生）由 host 补 null。
export interface RecallFailedEvent {
  version: 1
  stage: 'execute' | 'fork'
  sessionId: string | null
  messageId: string
  scope: 'both' | 'session-only'
  cutSeq: number | null
  root: string | null
  code?: string                 // stage='execute' 时透传 host 端点错误码
  error: string
  time: number                  // host 收到上报的时间（ms）
}
