/**
 * dsh-seeker-bot — 从完整工具参数算出「一句人话动作」（host 侧）。
 *
 * ## 为什么要有这个文件
 *
 * Bot「动态」页在任务运行中要显示「此刻在做什么」。它拿到的 `ToolRun.action`
 * 必须是**具体动作**（「启动第二个 CodeArts 账号登录」），而不是「正在整理回复…」
 * 那种笼统的等待语。
 *
 * 具体动作的规则表只有一份，就在 `src/client/kr-chat/plain-language.ts` 的
 * `toPlainStep`（Seeker「操作面板」那张卡用的同一份）。所以这里**刻意跨目录**
 * import 它，而不是在 host 再抄一套 EXACT/PATTERNS：
 *
 *  - 抄第二份 = 两份规则迟早漂移，同一件事在「动态」和「操作面板」说成两句话，
 *    这正是用户最容易一眼看穿的 bug；
 *  - `toPlainStep` 是纯函数（文件头已声明「无 React / 无 DOM」），host 侧（node
 *    平台）可以直接跑，不会把浏览器依赖拖进 host 产物；
 *  - 跨目录 import 也是本仓库既有做法（`agent.ts` 已 import
 *    `src/client/iu/kinds/registry.ts` 的 `iuKindOf`）。
 *
 * ## 为什么用「完整参数」
 *
 * 卡片上给前端的 `args` 是 clip 到 180 字的摘要，description / query 常常正好
 * 被切断——前端拿摘要根本解析不出动作。这里接收的是**原始完整参数**：调用方先用
 * `agent.ts` 的 `argumentsRecord()` 把 tool/call 的 JSON 字符串（或 PTC 子调用
 * 已解析的对象）收敛成普通对象，再交给本函数。
 *
 * ## 契约
 *
 * `plainActionOf` **绝不抛**：它跑在会话事件流里，一条脏参数不能把整轮工具卡
 * 打断。畸形入参一律回落成「{}」再走 `toPlainStep` 的兜底分支。
 */

import { toPlainStep } from '../../client/kr-chat/plain-language.ts'

/** 把任意入参收敛成普通对象：非对象 / 数组 / null → {}（与 plain-language 同口径）。 */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * 一次工具调用 → 一句人话动作。
 *
 * 拼接口径与「操作面板」那张卡**逐字一致**：
 *  - 规则表声明 `hideVerb`（终端族「在电脑上操作」）时，动作就是 detail 本身
 *    （图标已经表达过动词，再印一遍只会挤掉真正该读的对象）；
 *  - 否则是「动词 + 细节」（「打开网页 携程 · 机票」）；
 *  - detail 取不到时只剩动词，绝不返回空串。
 *
 * @param toolName - 工具名（原始名，不预设归一；`toPlainStep` 内部会归一）。
 * @param args - 完整参数（已解析对象）：畸形值（null / 数组 / 标量）回落到 {}。
 * @returns `action` 为空串表示「这一条没有可用动作」（调用方不要挂字段）；
 *          `hideVerb` 为 true 时短语本身已是完整人话，显示时不要再拼「正在 / 已」。
 */
export function plainActionOf(
  toolName: string,
  args: unknown,
): { action: string; hideVerb: boolean } {
  try {
    const step = toPlainStep({
      toolName: typeof toolName === 'string' ? toolName : '',
      args: recordOf(args),
      // 动作在调用发起时就展示，还没结果：状态只影响 issue / 措辞，不影响动作。
      status: 'running',
    })
    const detail = typeof step.detail === 'string' && step.detail.trim() !== '' ? step.detail : ''
    // hideVerb 只在确实有 detail 时才成立（否则动词被藏起来，这一行就空了）。
    const hideVerb = step.hideVerb === true && detail !== ''
    const verb = typeof step.verb === 'string' ? step.verb : ''
    const action = hideVerb ? detail : detail !== '' ? (verb !== '' ? `${verb} ${detail}` : detail) : verb
    return { action, hideVerb }
  } catch {
    // 理论上到不了这里（toPlainStep 自身就不抛）；兜底只为守「绝不抛」的契约。
    return { action: '', hideVerb: false }
  }
}
