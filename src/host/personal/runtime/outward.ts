/**
 * Personal Agent 作业运行时 —— 「这一轮做过哪些对外动作」的判定。
 *
 * ## 为什么这件事必须做
 *
 * 进程重启时，一条停在 `running` 的记录有两种处理：重跑一次，或者判死。
 * 分界线是**这一轮有没有对外部世界产生不可撤销的影响**：
 *
 *   - 只是读了文件、查了网页 → 重跑无害，重跑一次更可能救回来；
 *   - 已经发了邮件、push 了代码、付了款 → **重跑等于做两遍**，那比不恢复更糟。
 *
 * 所以「已对外动作」不能靠模型自述（它会记错、会夸大、会在被要求继续时
 * 把没做的说成做了），必须由宿主观测到的工具调用推出来。
 *
 * ## 判定为什么要偏保守
 *
 * 两类错误的代价不对称：
 *
 *   - 把「其实只是读」误判成对外 → 少重跑一次，用户重说一句就行；
 *   - 把「其实已经发了邮件」误判成只读 → 重跑，**同一封信发两遍**。
 *
 * 所以这里宁可多判。名字里带 `SEND` / `POST` / `PUBLISH` 的 MCP 工具一律算，
 * 不区分它到底发出去没有——调用失败的工具本来就不会被记成 `ok`。
 */

/**
 * MCP 工具名里出现这些词，就认为它**可能**对外产生副作用。
 *
 * 只看 `mcp__` 开头的工具：本地工具（`write` / `pwsh` / `present`）改的是
 * 工作区里的文件或界面，不属于「外部世界」，重跑也不会伤到别人。
 */
const OUTWARD_TOOL_WORDS: readonly string[] = [
  'SEND',
  'REPLY',
  'POST',
  'PUBLISH',
  'UPLOAD',
  'DELETE',
  'REMOVE',
  'INVITE',
  'TRANSFER',
  'PAY',
  'REFUND',
  'CANCEL_ORDER',
  'CREATE_ORDER',
  'SUBMIT',
]

/**
 * 命令行里的对外动作。
 *
 * `git commit` 不在列表里——它是本地的，重跑顶多多一个提交，能撤；`git push`
 * 一旦推上去就可能已经触发 CI 或别人已经拉了。
 */
const OUTWARD_COMMAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+push\b/i, label: 'git push' },
  { pattern: /\bgh\s+(?:pr|issue|release)\s+create\b/i, label: 'gh create' },
  { pattern: /\b(?:npm|pnpm|yarn)\s+publish\b/i, label: 'npm publish' },
  { pattern: /\bdocker\s+push\b/i, label: 'docker push' },
  { pattern: /\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)/i, label: 'curl write' },
  { pattern: /\bwget\b[^\n]*--post-/i, label: 'wget post' },
  { pattern: /\bInvoke-(?:RestMethod|WebRequest)\b[^\n]*-Method\s+(?:Post|Put|Patch|Delete)/i, label: 'Invoke-* write' },
  { pattern: /\bgit\s+remote\s+add\b/i, label: 'git remote add' },
]

/** 执行外部命令的工具名（它们的 `args` 里才有命令行文本）。 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'shell',
  'terminal',
  'run_code',
  'execute_command',
])

/**
 * 从一次工具调用推出「对外动作标签」。
 *
 * 返回空数组 = 这一调用看不出对外副作用。**返回非空不等于一定已经产生效果**
 * （调用可能失败了），调用方只在工具状态为 `ok` 时才该采信。
 *
 * @param toolName - 工具名，例如 `mcp__gmail__GMAIL_SEND_EMAIL`、`pwsh`
 * @param argsText - 原始参数 JSON 文本（可能很长、可能不是合法 JSON）
 */
export function outwardLabelsOf(toolName: string, argsText: string | undefined): string[] {
  const name = toolName.trim()
  if (name === '') return []

  const labels: string[] = []

  if (name.startsWith('mcp__')) {
    const upper = name.toUpperCase()
    if (OUTWARD_TOOL_WORDS.some((word) => upper.includes(word))) {
      // 标签用完整工具名：排查时要能一眼看出是哪一次调用
      labels.push(name)
    }
    return labels
  }

  if (SHELL_TOOL_NAMES.has(name) && typeof argsText === 'string' && argsText !== '') {
    for (const { pattern, label } of OUTWARD_COMMAND_PATTERNS) {
      if (pattern.test(argsText) && !labels.includes(label)) labels.push(label)
    }
  }

  return labels
}
