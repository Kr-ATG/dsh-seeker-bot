/**
 * Personal Agent — 真实 agent 会话（每个 bot 一个持久会话）。
 *
 * ## 为什么要有这个文件
 *
 * 早先的 bot 只是「一次 LLM 补全」：拿历史拼个 prompt、调 `ctx.llm.stream`、
 * 把一段文本当回复。那是个会聊天的头像，不是 agent——它不能读文件、不能跑命令、
 * 不能搜索、不能多步推进。
 *
 * 这里把每个 bot 接到**宿主的真 agent loop** 上：`ctx.agents.create()` 建一个带
 * 完整工具集的会话，`followup()` 投用户消息，然后监听 Session 事件把「工具调用 →
 * 结果 → 文本」按发生顺序翻成前端能渲染的 blocks。因此 bot 天然继承宿主能力
 * （文件读写、命令执行、web 搜索、技能、MCP、子代理、workflow…），不需要我们
 * 逐个仿造。
 *
 * ## 会话与隔离
 *
 * - sessionId 固定为 `pa-bot-<botId>`：同一 bot 关掉再开还是同一个会话，历史仍在
 * - **工作目录统一**：所有 bot 与群聊共用 `<DSH_HOME>/storages/dsh-seeker-bot/
 *   personal-agent/Seeker-Bot`（不存在自动创建）。用户要求 bot 全部在这个文件夹里
 *   干活——所以 bot 之间共享文件视野，能看到彼此产出的东西，也不会去动用户的项目目录
 * - 权限档位写在该会话自己的 `sandbox/mode` + `approval/policy` 事件上，因此
 *   「完全权限」与「审批模式」是按 bot 隔离的，重启后保持
 *
 * ## 约束
 *
 * 本仓库 host 产物必须自包含，不能 import `@deepseek-ai/*`。所以这里：
 * - agent 服务用 `ctx.get('agents')` 探测，而不是 `import`
 * - user 消息自己构造（结构对齐 dsh-llm 的 createUserMessage）
 * - 任何宿主服务缺失都降级返回错误，不抛穿到路由层
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  decodeDataUrl,
  extensionFor,
  fetchImageBytes,
  looksLikeImage,
  parseGeneratedResult,
  reusable,
} from '../../spill/materialize.ts'
import { admitSpillPath, spillRoots } from '../../spill/index.ts'

/**
 * bot 会话 id 前缀（宿主里一眼能认出这是 Personal Agent 的会话）。
 *
 * **v2 不是装饰**：早期的 `pa-bot-<botId>` 会话留下过坏状态——`create` 认为它
 * 已存在、`resume` 又恢复出一个 followup 后毫无反应的僵尸会话（实测：同一个
 * botId 换成 `...-2` 立刻正常）。换前缀让所有 bot 从全新身份重建，彻底绕开
 * 那些残留，代价只是旧会话历史作废（它们本来也跑不起来）。
 */
const SESSION_PREFIX = 'pa-bot-v2-'

/** 提示词段在组装里的顺序：排在部署 persona 后缀（10200）之后。 */
const BOT_PROMPT_ORDER = 10300

export type BotPermission = 'full' | 'approval'

/** 前端传过来的 bot 描述（字段都是可选的，缺了就按默认值走）。 */
export interface BotAgentSpec {
  botId: string
  name: string
  role: string
  description: string
  instructions: string
  model?: { provider?: string; model?: string; effort?: string }
  permission?: BotPermission
  /** 该 bot 的记忆（前端 localStorage 持有，每次请求带上来）。 */
  memories?: string[]
}

/** 工具产出的可预览文件类型（按扩展名归族，决定卡片图标与预览方式）。 */
export type ArtifactKind = 'video' | 'audio' | 'pdf' | 'doc' | 'sheet' | 'slide' | 'image' | 'file'

/**
 * 一个可预览的产出物（bot 工作区里的真实文件）。
 *
 * 字段与 `src/client/personal/types.ts` 的 `ArtifactRef` **逐字对齐**：前端按
 * 同一份快照渲染产出物卡，两处漂移会让文件永远显示不出来。
 *
 *  · `path` —— 相对 bot 工作区的正斜杠路径（`_tmp/report.docx`）；
 *  · `url`  —— 同源地址，直接给 `<video>` / `<iframe>` / 下载用；
 *  · `kind` —— 决定前端用哪种预览方式（视频 / PDF / Office 页图 / 音频 / 图片）。
 */
export interface ArtifactRef {
  path: string
  url: string
  name: string
  kind: ArtifactKind
  size?: number
}

/** 一次工具调用的可展示状态（与前端 ToolRun 对齐）。 */
export interface ToolRun {
  id: string
  name: string
  args?: string
  status: 'running' | 'ok' | 'error'
  result?: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  /**
   * 生图专用：host 已落盘图片的同源 URL 列表（缺省 = 还没出图）。
   *
   * 字段名与 `src/client/personal/types.ts` 的 ToolRun **逐字对齐**：前端按
   * 同一份快照渲染实时卡，两处漂移会让图片永远不出现。
   */
  images?: string[]
  /** 生图专用：本次请求的张数（1–4，缺省 1）。 */
  imageCount?: number
  /** 生图专用：本次请求的宽高比（宽 / 高，缺省 1）。 */
  imageRatio?: number
  /** 生视频专用：host 已落盘视频的同源 URL 列表（缺省 = 还没出片）。 */
  videos?: string[]
  /** 生视频专用：网关返回异步任务时的 id / 状态（此时没有可播放文件）。 */
  videoTask?: { id: string; status: string }
  /** 工具产出的可预览文件（present 参数 / pwsh、run_code 等结果里的工作区路径）。 */
  artifacts?: ArtifactRef[]
  /** 生图 / 生视频专用：完整提示词（未截断）。 */
  prompt?: string
  /** 生图 / 生视频专用：模型名（结果解析后才有）。 */
  model?: string
}

/** host → client 的流式事件。 */
export type PersonalStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; run: ToolRun }
  | { type: 'error'; message: string }
  | { type: 'done'; durationMs: number }

/** 一轮跑完的完整结果。 */
export interface TurnResult {
  ok: boolean
  blocks: Array<Record<string, unknown>>
  error?: string
  sessionId?: string
}

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 把任意 botId 收敛成安全的路径 / 会话 id 片段。 */
function safeId(botId: string): string {
  const cleaned = String(botId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)
  return cleaned === '' ? 'main' : cleaned
}

export function botSessionId(botId: string): string {
  return `${SESSION_PREFIX}${safeId(botId)}`
}

/**
 * 所有 bot 与群聊共用的工作目录：`<DSH_HOME>/storages/dsh-seeker-bot/personal-agent/Seeker-Bot`。
 *
 * 用户要求「bot 全部使用 Seeker-Bot 这个文件夹，没有就默认新建」——所以这里
 * **按 bot 分目录是错的**：所有 bot 落在同一个工作区里，彼此能看到对方产出的
 * 文件，用户也只需要记住一个路径。不存在时自动创建。
 *
 * 会话仍然是按 bot 隔离的（sessionId 不同），共享的只是文件系统视野。
 * 注：目录名大小写按用户写的 `Seeker-Bot` 保留，Windows 不区分但 Linux 区分，
 * 写成固定字面量避免两边不一致。
 */
export function botWorkspaceDir(): string {
  /*
   * 用户要求放在 **D 盘根目录**，不要藏在 ~/.dsh/storages 里（那里用户根本找不到）。
   * 选盘顺序：环境变量覆盖 → Windows 有 D 盘就用 D:\Seeker-Bot → 退到用户主目录。
   */
  const override = process.env.DSH_SEEKER_BOT_WORKSPACE
  let dir: string
  if (typeof override === 'string' && override.trim() !== '') {
    dir = override.trim()
  } else if (process.platform === 'win32' && existsSync('D:\\')) {
    dir = join('D:\\', 'Seeker-Bot')
  } else {
    dir = join(homedir(), 'Seeker-Bot')
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 截断成卡片上放得下的一行。 */
function clip(value: unknown, max = 180): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 深冻结一条要进会话日志的消息。
 *
 * agent 的 followup / inject 会把消息写进会话，后续步骤要求消息不可变。
 * 这里自己写是为了让 host 产物保持自包含（不 import @deepseek-ai/dsh-llm）。
 */
function freezeDeep(value: any): any {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) freezeDeep(value[key])
  return Object.freeze(value)
}

/**
 * 构造一条 user 消息。
 *
 * 结构与 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 对齐（id / role / content /
 * source）。
 */
function createUserMessage(text: string): any {
  return freezeDeep({
    id: `pa-user-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * 构造一条 developer 消息：面向模型的上下文，不会显示给用户。
 * 用来把 bot 的记忆投喂给 agent。
 */
function createDeveloperMessage(text: string): any {
  return freezeDeep({
    id: `pa-ctx-${randomUUID()}`,
    role: 'developer',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin' },
  })
}

/** 取 agents 服务（宿主可能没装 / 还没就绪，探测而不是属性访问）。 */
function getAgents(ctx: any): any {
  try {
    const direct = ctx?.agents
    if (direct?.create !== undefined || direct?.get !== undefined) return direct
  } catch {
    /* ctx.agents 可能是未就绪的代理：继续走 ctx.get */
  }
  try {
    return typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
  } catch {
    return undefined
  }
}

/**
 * bot 的系统提示词：它是什么、能干什么、怎么说话。
 *
 * ## 为什么「说话方式」写得这么硬
 *
 * bot 跑的是宿主完整的 agent loop，默认会继承 Work 模式那套「编码 agent」的
 * 输出习惯：分节标题、要点清单、文件路径、逐条复述工具过程。用户要的是
 * **聊天**——参考 GrokBot / Muse 这类 Personal Agent，bot 回复是一段精炼的
 * 对话，过程细节留在界面（工具轨迹 / 右栏）里，而不是写进正文。
 *
 * 所以这里把回复形态写成可执行的硬要求，并明确「什么时候可以展开」：
 * 只有用户主动要详细内容时才放开，否则一律短回复。
 */
function buildBotPrompt(spec: BotAgentSpec): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const timeText = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  return [
    `你是「${spec.name}」，岗位：${spec.role}。`,
    spec.description.trim() === '' ? '' : `档案：${spec.description}`,
    spec.instructions.trim() === '' ? '' : `行为约定：${spec.instructions}`,
    `现在是 ${timeText}（Asia/Shanghai）。`,
    '',
    '## 你能动手，但你在跟用户聊天',
    '你手上有真实工具（文件、命令、web 搜索、技能、MCP）。用户让你做事时直接做完再回话，不要只说「我可以帮你…」。',
    '- 不要声称做过你没做过的事；工具失败就直说卡在哪。',
    '- 只有确实需要用户拍板（方向选择、危险操作、缺关键信息）时才提问。',
    '',
    '## 回复格式（硬要求，每条都适用）',
    '- 简体中文，像在微信里跟同事说话：默认 1–3 句，最多两小段。先给结论或直接回答，再补一句必要说明。',
    '- 不用加粗当小标题，不用多级清单、表格、代码块；不要「首先 / 其次 / 综上 / 建议如下」这种汇报腔。',
    '- 不贴文件路径、命令、参数、URL。要提位置就用自然说法（「放在 Seeker-Bot 文件夹里」）；用户明确要看才贴。',
    '- 过程不逐条复述：查了什么、跑了几步，一句「我看了下 / 我跑了一遍」带过——执行过程界面里已经有了。',
    '- 结尾最多一句：下一步做什么，或一个具体问题。不要罗列「需要的话我还可以…」的菜单。',
    '- 汇总多个来源或子 Bot 的结果时，只给合并后的结论、分歧点和需要用户拍板的那件事，不要转述原文。',
    '- 只有用户明确说「详细说 / 给我报告 / 列个清单 / 贴代码 / 写成文档」时才展开成长内容。',
  ].filter((line) => line !== '').join('\n')
}

/**
 * 摘掉 Work 模式专属的提示段。
 *
 * bot 会话与 Work 会话共用宿主的 system prompt。下面这些段是「工作台里的编码
 * agent」才需要的，留在 bot 会话里会把模型拉回工作汇报的形态：
 *
 *  - `team:policy`                  —— Agent Teams 全套协作纪律（bot 没有队友）
 *  - `ui:deliverable-file-references` —— present / 文件路径链接规则（正文里全是路径的来源之一）
 *  - `app:web-surface`              —— Web GUI 与 HMR 说明（bot 不需要知道自己跑在哪个前端）
 *  - `harness:source`               —— 实现 checkout 位置（bot 不该去动 DSH 源码）
 *
 * 分两条路走，因为这两类段的注册位置不同：
 *
 * 1. **全局段**（后三个）：在 agent 自己的作用域注册**同名** section、文本为空——
 *    组装时会被过滤掉，全局注册与其他会话完全不受影响。
 * 2. **agent 作用域段**（`team:policy`）：agent-team 插件在每个 agent 的 scope 里
 *    注册它，同 scope 再注册同名会直接抛 `already registered in this scope`，
 *    把建会话流程带崩（实测：bot 退化成纯文本补全、丢掉全部工具）。所以改成在
 *    `system-prompt/assemble` presentation waterfall 上过滤：拿到下游组装结果后
 *    按 name 剔除。
 *
 * 两条路都失败兜底：裁剪失败最多是「多一段 Work 提示」，绝不能让 bot 报错。
 */
function trimWorkOnlyPrompt(agentCtx: any): void {
  const prompt = agentCtx?.systemPrompt
  if (prompt !== undefined && prompt !== null && typeof prompt.section === 'function') {
    const orderOf = (name: string): number | null => {
      try {
        const value = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder(name) : null
        return typeof value === 'number' ? value : null
      } catch {
        return null
      }
    }
    const trimmed: Array<{ name: string; orderName: string }> = [
      { name: 'ui:deliverable-file-references', orderName: 'DELIVERABLE_FILE_REFERENCES' },
      { name: 'app:web-surface', orderName: 'WEB_SURFACE' },
      { name: 'harness:source', orderName: 'HARNESS_SOURCE' },
    ]
    for (const item of trimmed) {
      const order = orderOf(item.orderName)
      if (order === null) continue
      try {
        prompt.section({ name: item.name, order, text: '' })
      } catch {
        /* 该段在本宿主不存在、或已被别的插件占用：忽略，不影响对话 */
      }
    }
  }
  trimAgentScopedPrompt(agentCtx)
}

/** agent 作用域段（`team:policy`）走组装期过滤，见 {@link trimWorkOnlyPrompt}。 */
function trimAgentScopedPrompt(agentCtx: any): void {
  const on = agentCtx?.on
  if (typeof on !== 'function') return
  try {
    on('system-prompt/assemble', async (assembly: any, _context: any, next: any) => {
      let result: any = assembly
      try {
        result = await (typeof next === 'function' ? next() : assembly)
        if (result === null || typeof result !== 'object' || !Array.isArray(result.sections)) return result
        return {
          ...result,
          sections: result.sections.filter((section: any) => section?.name !== 'team:policy'),
        }
      } catch {
        // 组装本身失败时把下游结果原样交回，让宿主按它自己的错误路径处理
        return result
      }
    })
  } catch {
    /* 该作用域不支持 waterfall 监听：跳过 */
  }
}

/** 把 bot 身份与行为约定注册进该 agent 自己的作用域（不影响别的会话）。 */
function installBotPrompt(agentCtx: any, spec: BotAgentSpec): void {
  // 先摘 Work 专属段，再装 bot 身份：两件事都在这个 agent 自己的作用域里，
  // 顺序不影响结果，但先摘能让「谁覆盖了谁」在排查时更好读。
  trimWorkOnlyPrompt(agentCtx)
  try {
    agentCtx?.systemPrompt?.section?.({
      name: 'personal-agent:bot-identity',
      order: BOT_PROMPT_ORDER,
      text: buildBotPrompt(spec),
    })
  } catch {
    /* 没有 systemPrompt 服务：bot 仍可对话，只是少了身份描述 */
  }
}

/** 权限档位 → 宿主预设名。 */
function presetFor(permission: BotPermission | undefined): string {
  return permission === 'approval' ? 'workspace-write' : 'danger-full-access'
}

/**
 * 解析这个 bot 该用哪个模型。
 *
 * 顺序：bot 自己的设置 → 宿主的默认模型（`agentDefaultModel`）。
 *
 * 这一步是**必须**的：agent 的每个步骤在准备时都要求 provider 与 model 同时
 * 存在，缺一个就会「turn 开了但模型没被调用」——表现为界面上一句话都不回，
 * 而 session 里只有一串空的 turn/start→turn/end。
 */
function resolveModel(ctx: any, spec: BotAgentSpec): { provider: string; model: string; effort?: string } | null {
  const provider = String(spec.model?.provider ?? '').trim()
  const model = String(spec.model?.model ?? '').trim()
  if (provider !== '' && model !== '') {
    const effort = String(spec.model?.effort ?? '').trim()
    return effort !== '' ? { provider, model, effort } : { provider, model }
  }
  try {
    const defaults = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const selection = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined
    const fallbackProvider = String(selection?.provider ?? '').trim()
    const fallbackModel = String(selection?.model ?? '').trim()
    if (fallbackProvider !== '' && fallbackModel !== '') {
      const effort = String(selection?.reasoningEffort ?? '').trim()
      return effort !== '' ? { provider: fallbackProvider, model: fallbackModel, effort } : { provider: fallbackProvider, model: fallbackModel }
    }
  } catch {
    /* 宿主没有默认模型服务 */
  }
  return null
}

/** 把 provider/model 变成 agents.create 的 agentOptions。 */
function agentOptionsOf(resolved: { provider: string; model: string; effort?: string } | null): Record<string, unknown> {
  if (resolved === null) return {}
  const options: Record<string, unknown> = { provider: resolved.provider, model: resolved.model }
  if (resolved.effort !== undefined && resolved.effort !== '') options.reasoningEffort = resolved.effort
  return options
}

/**
 * 创建 / 恢复之后，把模型显式钉到 agent 上。
 *
 * 为什么不能只靠 create 的 `agentOptions`：那个只在**新建**时生效，恢复会话时
 * 即使传了也不会覆盖历史；而 `model.select()` 是权威写路径，从下一个尚未准备的
 * 步骤开始生效。不钉住的话，resume 出来的 agent 会没有模型可用。
 */
function pinModel(agent: any, resolved: { provider: string; model: string; effort?: string } | null): void {
  if (resolved === null) return
  try {
    if (typeof agent?.model?.select === 'function') {
      agent.model.select({
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.effort !== undefined && resolved.effort !== '' ? { reasoningEffort: resolved.effort } : {}),
      })
    }
  } catch {
    /* 选择失败：保持会话原有选择 */
  }
}

/**
 * 把权限档位钉到会话上。
 *
 * 首选 `ctx.permissionPresets.set(session, name)`（权威写路径，会同时落
 * `permission/preset` + `sandbox/mode` + `approval/policy` 三条事件）；
 * 服务不在时退化成直接 append 两条旋钮事件——效果等价，只是少一条「用户选了
 * 哪档」的记录。
 */
function applyPermission(ctx: any, agent: any, permission: BotPermission | undefined): void {
  const session = agent?.session
  if (session === undefined || session === null) return
  const name = presetFor(permission)

  try {
    const presets = typeof ctx?.get === 'function' ? ctx.get('permissionPresets') : undefined
    if (typeof presets?.set === 'function') {
      presets.set(session, name)
      return
    }
  } catch {
    /* 服务存在但 set 失败：走下面的兜底 */
  }

  try {
    const approval = permission === 'approval' ? 'ask' : 'never'
    const sandbox = permission === 'approval' ? 'workspace-write' : 'danger-full-access'
    session.append('sandbox/mode', { mode: sandbox })
    session.append('approval/policy', { policy: approval })
  } catch {
    /* 会话只读或已关闭：保持宿主默认档位 */
  }
}

/**
 * 已创建的 bot agent 缓存（sessionId → agent + handle）。
 *
 * 存 handle 是为了「清空对话」能真正 dispose 掉 agent：只清缓存不清 agent，
 * 宿主内存里那个会话还带着旧历史，下一次 `agents.get()` 又会把它拿回来。
 */
const agentCache = new Map<string, { agent: any; handle?: any }>()

/**
 * 给 bot 会话挂上部署默认的 agent preset。
 *
 * ## 为什么必须有这一步
 *
 * `ctx.agents.create()` 只是把 agent 驱动器建起来，**不会自动给它挂工具插件**。
 * 工具集（pwsh / read / write / web / skill …）是 agent preset 的子插件树，要靠
 * registry 的 `select()` 去 `recompose` 才挂得上。官方 Web 会话走的是
 * `composeAgent(preset)` → 把组合好的 setup 传进 create，效果等价。
 *
 * 不做这一步的实际症状（实机验证过）：bot 能对话、也能调 working_directory 这类
 * 全局注册的工具，但**完全没有 shell / 文件 / 联网工具**，于是它只能回答
 * 「当前会话里没有可用的 pwsh 工具」——看起来就像「bot 不会调工具」。
 *
 * ## 限制
 *
 * `select()` 要求会话还没开始第一轮（`lastTurn === 0`）。已经聊过的老会话会被
 * 锁住（`agent-preset/locked`），这里静默跳过——那种会话要清空对话重建才有工具。
 */
async function ensureAgentPreset(ctx: any, agent: any): Promise<void> {
  try {
    const presets = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined
    if (typeof presets?.select !== 'function') return
    const wanted = typeof presets.defaultId === 'string' && presets.defaultId !== ''
      ? presets.defaultId
      : 'standard'
    await presets.select(agent, wanted)
  } catch {
    /* 会话已开过轮次（preset 锁定）或 registry 不在：保持现状，不阻塞对话 */
  }
}
export async function ensureBotAgent(ctx: any, spec: BotAgentSpec): Promise<any> {
  const sessionId = botSessionId(spec.botId)

  const cached = agentCache.get(sessionId)
  if (cached !== undefined) return cached.agent

  const agents = getAgents(ctx)
  if (agents === undefined || agents === null) throw new Error('宿主未提供 agents 服务')

  const live = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (live !== undefined && live !== null) {
    agentCache.set(sessionId, { agent: live })
    return live
  }

  let agent: any
  let handle: any
  let restored = false
  const setup = (agentCtx: any): void => { installBotPrompt(agentCtx, spec) }
  /*
   * 模型必须在两条路径上都给到：
   *  - 新建时经 agentOptions 记录初始路由
   *  - 恢复时同样要传（否则 resume 出来的 agent 没有 provider/model，
   *    步骤准备直接失败 → turn 空转 → 界面一句话都不回）
   */
  const resolved = resolveModel(ctx, spec)
  const agentOptions = agentOptionsOf(resolved)
  const hasAgentOptions = Object.keys(agentOptions).length > 0

  if (typeof agents.resume === 'function') {
    try {
      /*
       * 恢复用 `resumeSessionId`（不是 `sessionId`）——两者互斥，传错会变成「新建」，
       * 每次进来都把 bot 的历史丢掉。见 dsh-api-session-controller 的调用形状。
       *
       * setup 必须一起传：恢复出来的 agent 是全新组合出来的，不重跑 setup 的话
       * bot 的身份提示词就没了（模型会退回成通用助手）。
       */
      handle = await agents.resume({
        resumeSessionId: sessionId,
        ...(hasAgentOptions ? { agentOptions } : {}),
        setup,
      })
      agent = handle?.agent ?? handle
      restored = agent !== undefined && agent !== null
    } catch {
      /* 会话不存在（或已被别的进程占用）：下面新建 */
    }
  }

  if (!restored) {
    const cwd = botWorkspaceDir()
    try {
      handle = await agents.create({
        sessionId,
        ...(hasAgentOptions ? { agentOptions } : {}),
        meta: { cwd },
        setup,
      })
      agent = handle?.agent ?? handle
    } catch (createError: any) {
      /*
       * 最常见的失败：这个 sessionId 已经落在持久化存储里（上次创建成功但句柄
       * 没留住，或进程重启前没释放），create 会以「已存在 / 已被占用」拒绝。
       * 这时再查一次实时注册表，能拿到就直接用；拿不到才把原错误抛出去——
       * 静默失败会让界面退化成「模型说它没有权限」，根本查不出原因。
       */
      const again = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      if (again !== undefined && again !== null) {
        agent = again
        handle = undefined
      } else {
        throw createError
      }
    }
  }

  if (agent === undefined || agent === null) throw new Error('创建 agent 会话失败')

  // 权威写路径：不管走新建还是恢复，都把模型钉死，避免「没有模型 → 步骤空转」
  pinModel(agent, resolved)
  // 挂工具集：不挂 preset 的话 bot 只能聊天，拿不到 shell / 文件 / 联网工具
  await ensureAgentPreset(ctx, agent)
  await ensureSharedWorkspace(ctx, agent)
  applyPermission(ctx, agent, spec.permission)
  agentCache.set(sessionId, { agent, handle })
  return agent
}

/**
 * 把会话的工作目录对齐到共享的 `Seeker-Bot`。
 *
 * 为什么要单独做：会话的 `header.cwd` 是**创建时钉死、不可变**的。早先版本按
 * bot 分目录（`workspaces/<botId>`），那些会话恢复回来仍然指向旧目录。直接改
 * header 不可能，但宿主提供了 `workingDirectory.set()` —— 它会验证目录存在、
 * 落一条 `working-directory/change` 事件、并给模型注入一条「目录已变更」的通知。
 * 于是老会话也能迁到新目录，而且不丢历史。
 */
async function ensureSharedWorkspace(ctx: any, agent: any): Promise<void> {
  const target = botWorkspaceDir()
  try {
    const wd = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (typeof wd?.get === 'function' && wd.get(agent.session) === target) return
    if (typeof wd?.set === 'function') {
      await wd.set(agent, target)
      return
    }
    // 服务不可用时兜底：直接落事件（缺「通知模型」那一步，但目录确实切了）
    agent.session.append('working-directory/change', { cwd: target })
  } catch {
    /* 切换失败：保持原目录，不影响对话 */
  }
}

/** 丢掉缓存的 agent（bot 被删除 / 改权限时用）。 */
export function forgetBotAgent(botId: string): void {
  const sessionId = botSessionId(botId)
  agentCache.delete(sessionId)
  memoryHashBySession.delete(sessionId)
}

/**
 * 找出某个 sessionId 的持久化目录。
 *
 * 会话文件按「cwd 编码」分目录存放：`~/.dsh/sessions/<cwd 编码>/<sessionId>/`。
 * 不按编码规则反推（换平台/版本会变），而是直接遍历一层找同名子目录——稳且便宜。
 */
function sessionDirsFor(sessionId: string): string[] {
  const root = join(dshHome(), 'sessions')
  const found: string[] = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, sessionId)
      if (existsSync(candidate)) found.push(candidate)
    }
  } catch {
    /* sessions 目录不存在：没有可删的 */
  }
  return found
}

/**
 * 清空一个 bot 的全部对话。
 *
 * 两件事都要做，少一件就是「看起来清了」：
 *  1. **dispose 活着的 agent** —— 否则宿主内存里那个会话还带着完整历史，
 *     下一次 `agents.get()` 又把它拿回来，bot 会接着说「我们刚才聊的…」
 *  2. **删持久化会话目录** —— 否则重启后 resume 又把历史读回来
 *
 * 前端 localStorage 里的消息由前端自己清（host 碰不到浏览器存储）。
 */
export async function resetBotConversation(
  ctx: any,
  botId: string,
): Promise<{ ok: boolean; sessionId: string; removed: number; disposed: boolean; error?: string }> {
  const sessionId = botSessionId(botId)
  let disposed = false

  const cached = agentCache.get(sessionId)
  if (cached !== undefined) {
    try {
      await cached.handle?.dispose?.()
      disposed = true
    } catch {
      /* 已经被别处拆掉了 */
    }
    agentCache.delete(sessionId)
  } else {
    // 插件重载后缓存可能是空的，但宿主注册表里还有活 agent
    try {
      const agents = getAgents(ctx)
      const live = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
      if (live !== undefined && live !== null) {
        // 没有 handle 就拆不掉；把情况报上去，让前端提示「重启后彻底清空」
        return {
          ok: false,
          sessionId,
          removed: 0,
          disposed: false,
          error: '会话仍被宿主占用（没有 dispose 句柄），请重启 DSH 后再清空',
        }
      }
    } catch {
      /* 探测失败：继续删文件 */
    }
  }

  memoryHashBySession.delete(sessionId)

  let removed = 0
  let failed = false
  for (const dir of sessionDirsFor(sessionId)) {
    try {
      rmSync(dir, { recursive: true, force: true })
      removed += 1
    } catch {
      failed = true
    }
  }

  return {
    ok: !failed,
    sessionId,
    removed,
    disposed,
    ...(failed ? { error: '会话文件删除失败（可能被占用）' } : {}),
  }
}

/** 每个 bot 会话上次注入的记忆指纹（避免同一份记忆每轮都重复进历史）。 */
const memoryHashBySession = new Map<string, string>()

/**
 * 把 bot 的记忆投给 agent。
 *
 * 用 `inject()` 而不是拼进用户消息：它是「面向模型的上下文」，不唤醒驱动器、
 * 不打断当前轮次，会落在下一个被接纳的步骤里。
 *
 * 记忆每轮都会从前端带上来，内容没变就不重复注入——否则聊十轮就会在历史里
 * 堆十份同样的记忆，既费 token 又会让模型以为你在反复强调。
 */
function injectMemories(agent: any, memories: string[] | undefined): void {
  if (!Array.isArray(memories)) return
  const list = memories
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '')
    .slice(-12)
  if (list.length === 0) return

  const sessionId = String(agent?.session?.id ?? '')
  const text = `你记得关于用户的事：\n- ${list.join('\n- ')}`
  const hash = createHash('sha1').update(text).digest('hex')
  if (memoryHashBySession.get(sessionId) === hash) return

  try {
    agent.inject(createDeveloperMessage(text))
    memoryHashBySession.set(sessionId, hash)
  } catch {
    /* inject 不可用：这一轮先不带记忆 */
  }
}

/** 从 assistant/message 的 content 里抽文本。 */
function textOfMessage(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => String(block.text))
    .join('')
}

/* ───────────────────── 生图（generate_image）───────────────────── */

/**
 * 生图工具的 name。
 *
 * 来源是 dsh-provider-hub 的 model-capabilities（`images/generations`）。前端
 * 只知道「这是个工具调用」，图片要从结果里抠出来，所以 name 必须在这里判一次。
 */
const IMAGE_TOOL_NAME = 'generate_image'

/** 生图落盘目录（相对 bot 工作区）。 */
const GENERATED_IMAGE_REL_DIR = '_tmp/generated-images'

/** 单张图片字节上限：超过就跳过这一张（一张坏图不该毁掉整组）。 */
const MAX_GENERATED_IMAGE_BYTES = 24 * 1024 * 1024

/** spill 文本上限：与 spill/materialize.ts 同口径（2720×1536 PNG 约 9MB，留到 24MB）。 */
const MAX_SPILL_TEXT_BYTES = 24 * 1024 * 1024

/** 宽高比夹取区间：1:20 这种极端值会把卡片里的点阵压成一条线。 */
const MIN_IMAGE_RATIO = 0.2
const MAX_IMAGE_RATIO = 5

/** 图片文件路由（与 host/personal/index.ts 的 `/file` 分支对应）。 */
const IMAGE_FILE_ROUTE = '/api/personal-agent/file'

/**
 * Spill locator 正则：与 `src/client/generated-images/parse.ts` 的
 * `findSpillLocator` **逐字一致**。
 *
 * 两边各留一份是刻意的：client 解析「历史消息里已经存下来的结果文本」，host
 * 解析「刚刚到达的 tool/result 事件」。口径必须相同，否则会出现「刷新后画廊
 * 有图、实时卡没图」这种只有一边正确的假象。
 */
const SPILL_LOCATOR_RE = /Full formatted result stored at: ([^\s]+?)\.\s+Use read with offset\/limit/i

/** 从工具结果文本里取 spill 定位路径（没有则 undefined）。 */
function findSpillLocator(text: string): string | undefined {
  if (typeof text !== 'string') return undefined
  const match = SPILL_LOCATOR_RE.exec(text)
  const locator = match?.[1]
  return locator !== undefined && locator !== '' ? locator : undefined
}

/** 本次生图请求的展示参数（tool/call 阶段就能画点阵占位）。 */
interface ImageRequestSpec {
  /** 完整提示词（未截断；空串表示模型没给）。 */
  prompt: string
  /** 张数（1–4）。 */
  count: number
  /** 宽高比（宽 / 高，0.2–5）。 */
  ratio: number
}

/** 把 data.arguments（JSON 文本或已解析对象）收敛成普通对象。 */
function argumentsRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return {}
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>
  return {}
}

/** 张数：1–4 取整；解析不出来按 1。 */
function normalizeImageCount(value: unknown): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(raw)) return 1
  return Math.min(4, Math.max(1, Math.round(raw)))
}

/** 宽 / 高 → 夹在 [0.2, 5] 的比值；非法尺寸返回 null。 */
function clampImageRatio(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return Math.min(MAX_IMAGE_RATIO, Math.max(MIN_IMAGE_RATIO, width / height))
}

/** `size: "1024x1024"` → 宽高比（也认 1024*1024 这种写法）。 */
function ratioFromSize(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^\s*(\d+)\s*[x*×]\s*(\d+)\s*$/i.exec(value)
  if (match === null) return null
  return clampImageRatio(Number(match[1]), Number(match[2]))
}

/** `aspect_ratio: "16:9"` → 宽高比（也接受 16/9 写法与数值）。 */
function ratioFromAspect(value: unknown): number | null {
  if (typeof value === 'number') return clampImageRatio(value, 1)
  if (typeof value !== 'string') return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(value)
  if (match === null) return null
  return clampImageRatio(Number(match[1]), Number(match[2]))
}

/**
 * 解析 generate_image 的调用参数（tool/call 阶段，结果还没回来）。
 *
 * 用**完整** arguments 而不是卡片上那段 clip 文本：prompt 动辄几百字，截断后
 * 点阵卡的副标题只剩半句。解析失败一律回落到「1 张 / 1:1」——参数再怪也不能
 * 因此丢掉工具卡。
 */
function parseImageRequest(raw: unknown): ImageRequestSpec {
  const record = argumentsRecord(raw)
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
  const count = normalizeImageCount(record.n)
  const ratio = ratioFromSize(record.size) ?? ratioFromAspect(record.aspect_ratio) ?? 1
  return { prompt, count, ratio }
}

/** 一张生图结果落盘后的可用形态。 */
interface GeneratedImages {
  /** 同源 URL 列表（去重、保持结果顺序）。 */
  images: string[]
  /** 生图模型名（结果里没有就是 null）。 */
  model: string | null
}

/** 当前活动的 spill root（与 spill/materialize.ts 的准入口径一致）。 */
function activeSpillRoot(ctx: any): string | undefined {
  try {
    const store = typeof ctx?.get === 'function' ? ctx.get('spillStore') : undefined
    return typeof store?.root === 'string' && store.root !== '' ? store.root : undefined
  } catch {
    return undefined
  }
}

/**
 * 工具结果文本 → 生图结果全文。
 *
 * 大结果会被 DSH 的 spill policy 换成「preview + locator」，事件里只剩一行
 * 「Full formatted result stored at: <路径>」。不读回全文的话，base64 图根本
 * 不在手里 —— 这正是「对话流里看不到图，模型只能在正文写 ![](...)」的根因。
 */
function readGeneratedResultText(ctx: any, text: string): string {
  const locator = findSpillLocator(text)
  if (locator === undefined) return text
  try {
    // 准入与 spill/materialize.ts 逐字同口径：只认可信 root 下的 spill 文件。
    const verdict = admitSpillPath(locator, spillRoots(activeSpillRoot(ctx)))
    if (!verdict.ok) return text
    const size = statSync(verdict.path).size
    if (size <= 0 || size > MAX_SPILL_TEXT_BYTES) return text
    return readFileSync(verdict.path, 'utf8')
  } catch {
    // 读不到（被清理 / 权限）：用事件里的原文，至少不会让工具卡消失。
    return text
  }
}

/** 一张图片 URL → 原始字节（data: 解码 / http(s) 下载，其它跳过）。 */
async function generatedImageBytes(url: string): Promise<Buffer | null> {
  if (url.startsWith('data:')) return decodeDataUrl(url)
  if (/^https?:\/\//i.test(url)) return fetchImageBytes(url)
  return null
}

/**
 * 把一张图落到 bot 工作区，返回相对工作区的正斜杠路径（失败返回 null）。
 *
 * 文件名用 sha1(url) 前 16 位：同一张图重复出现（重放历史 / 重试）落在同一个
 * 文件上，幂等，也不会把磁盘越写越满。
 */
async function writeGeneratedImage(url: string, outDir: string): Promise<string | null> {
  const bytes = await generatedImageBytes(url)
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) return null
  // 被截断 / 污染的 base64 也能解码出字节，落成 png 后就是裂图 —— 先验 magic number。
  if (!looksLikeImage(bytes)) return null
  const name = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${extensionFor(url)}`
  try {
    mkdirSync(outDir, { recursive: true })
    const target = join(outDir, name)
    if (!reusable(target)) writeFileSync(target, bytes)
    return `${GENERATED_IMAGE_REL_DIR}/${name}`
  } catch {
    return null
  }
}

/**
 * 从一条 generate_image 的工具结果里把图片全部落盘，返回可直接展示的 URL。
 *
 * 逐张独立成败：某一张解码失败 / 下载超时 / 不是图片就跳过它继续下一张
 * （与 spill/materialize.ts 的契约一致）。因此 images 可能比 urls 少。
 *
 * 任何异常都在调用方 try/catch 里收敛：图少几张可以，工具卡本身不能因此丢。
 */
async function materializeGeneratedImages(ctx: any, message: any): Promise<GeneratedImages | null> {
  const raw = textOfMessage(message)
  if (raw.trim() === '') return null
  const text = readGeneratedResultText(ctx, raw)
  const parsed = parseGeneratedResult(text)
  if (!parsed.ok) return null

  const outDir = join(botWorkspaceDir(), '_tmp', 'generated-images')
  const images: string[] = []
  for (const url of parsed.urls) {
    const relative = await writeGeneratedImage(url, outDir)
    if (relative === null) continue
    const href = `${IMAGE_FILE_ROUTE}?path=${encodeURIComponent(relative)}`
    if (!images.includes(href)) images.push(href)
  }
  return { images, model: parsed.model }
}

/* ───────────────────── 生视频（generate_video）───────────────────── */

/** 生视频工具的 name（与生图同源：dsh-provider-hub 的 model-capabilities）。 */
const VIDEO_TOOL_NAME = 'generate_video'

/** 生视频落盘目录（相对 bot 工作区）。 */
const GENERATED_MEDIA_REL_DIR = '_tmp/generated-media'

/** 单个视频字节上限：与 /file 路由的媒体上限一致（256MB）。 */
const MAX_GENERATED_VIDEO_BYTES = 256 * 1024 * 1024

/** http(s) 视频下载超时：视频比图片大一个量级，给到 120s。 */
const VIDEO_FETCH_TIMEOUT_MS = 120_000

/** 一条结果里最多收几个视频（再多卡片也放不下）。 */
const MAX_GENERATED_VIDEOS = 4

/** 视频 URL 的后缀判据：路径以 .mp4/.webm/.mov/.m4v 结尾（允许 query / hash）。 */
const VIDEO_URL_EXT_RE = /\.(?:mp4|webm|mov|m4v)(?:[?#].*)?$/i

/**
 * 键名是「视频地址」的提示集：这些键下的 http(s) URL 即使没有视频后缀也收。
 *
 * 为什么要按键名放宽：网关返回的 CDN 地址经常是 `https://cdn.xx/abc123`（没有
 * 扩展名），只靠后缀会漏掉整条视频。
 */
const VIDEO_URL_KEYS = new Set([
  'url', 'video_url', 'videoUrl', 'videoUrls', 'video', 'video_urls',
  'download_url', 'downloadUrl', 'output_url', 'outputUrl',
])

/** 键名是「视频 base64」的提示集（不同网关的写法都收）。 */
const VIDEO_B64_KEYS = new Set([
  'b64_json', 'b64Json', 'video_b64', 'videoB64', 'videoBase64', 'video_base64', 'b64',
])

/** 异步任务的 id / 状态键名。 */
const TASK_ID_KEYS = ['id', 'task_id', 'taskId', 'taskID', 'job_id', 'jobId']
const TASK_STATUS_KEYS = ['status', 'state', 'task_status', 'taskStatus', 'job_status']

/**
 * 视频字节的 magic number 判据。
 *
 * mp4 家族（mp4 / m4v / mov）：第 4–8 字节是 'ftyp'（前面 4 字节是 box 长度）；
 * webm / mkv：EBML 头 1A 45 DF A3。与图片一样，宁可少落一条，也不落一个打不开
 * 的坏文件 —— base64 解码对任何字符串都不抛错，坏字节只有播放器才知道。
 */
function looksLikeVideo(bytes: Buffer): boolean {
  if (bytes.byteLength < 12) return false
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true
  return false
}

/** data URL 的 MIME / URL 后缀 → 视频扩展名（默认 mp4）。 */
function videoExtensionFor(url: string): string {
  const dataMatch = /^data:([^;,]*)[;,]/.exec(url)
  if (dataMatch !== null) {
    const mime = (dataMatch[1] ?? '').trim().toLowerCase()
    if (mime === 'video/webm') return 'webm'
    if (mime === 'video/quicktime') return 'mov'
    if (mime === 'video/mp4' || mime === 'video/x-m4v') return 'mp4'
  }
  const clean = url.split(/[?#]/)[0] ?? ''
  const match = /\.(mp4|webm|mov|m4v)$/i.exec(clean)
  return match?.[1] !== undefined ? match[1].toLowerCase() : 'mp4'
}

/**
 * http(s) 视频 → 字节。失败（网络错误 / 超时 / 超限 / 非 2xx）一律返回 null。
 *
 * 为什么不复用 spill/materialize.ts 的 fetchImageBytes：那个上限是 24MB（图片
 * 口径），视频很容易超，会被整条丢掉。
 */
async function fetchVideoBytes(url: string): Promise<Buffer | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VIDEO_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) return null
    const declared = response.headers.get('content-length')
    if (declared !== null && declared !== '' && Number(declared) > MAX_GENERATED_VIDEO_BYTES) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_GENERATED_VIDEO_BYTES) return null
    return bytes
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把一条视频落到 bot 工作区，返回相对工作区的正斜杠路径（失败返回 null）。
 *
 * 文件名用 sha1(url) 前 16 位：同一段视频重复出现（重放历史 / 重试）落在同一个
 * 文件上，幂等，也不会把磁盘越写越满。
 */
async function writeGeneratedVideo(url: string, outDir: string): Promise<string | null> {
  const bytes = url.startsWith('data:')
    ? decodeDataUrl(url)
    : /^https?:\/\//i.test(url) ? await fetchVideoBytes(url) : null
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > MAX_GENERATED_VIDEO_BYTES) return null
  if (!looksLikeVideo(bytes)) return null
  const name = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${videoExtensionFor(url)}`
  try {
    mkdirSync(outDir, { recursive: true })
    const target = join(outDir, name)
    if (!reusable(target)) writeFileSync(target, bytes)
    return `${GENERATED_MEDIA_REL_DIR}/${name}`
  } catch {
    return null
  }
}

/** 从一条结果里收集到的视频候选。 */
interface VideoCandidates {
  /** 可直接下载 / 解码的视频地址（`data:video/...` 或 http(s)）。 */
  urls: string[]
  /** 裸 base64（键名命中 {@link VIDEO_B64_KEYS}）。 */
  b64: string[]
}

function pushUniqueString(list: string[], value: string, max: number): void {
  if (list.length >= max || list.includes(value)) return
  list.push(value)
}

/** 一条字符串是否像视频地址（按所在键名放宽判据）。 */
function isVideoAddress(value: string, key: string | null): boolean {
  if (/^data:video\//i.test(value)) return true
  if (!/^https?:\/\//i.test(value)) return false
  if (key !== null && VIDEO_URL_KEYS.has(key)) return true
  return VIDEO_URL_EXT_RE.test(value.split(/[?#]/)[0] ?? value)
}

function collectVideoString(value: string, key: string | null, sink: VideoCandidates): void {
  const text = value.trim()
  if (text === '') return
  if (key !== null && VIDEO_B64_KEYS.has(key)) {
    // b64 字段：可能是完整 data URL，也可能是裸 base64（两种网关写法都见过）。
    if (text.startsWith('data:')) {
      if (/^data:video\//i.test(text)) pushUniqueString(sink.urls, text, MAX_GENERATED_VIDEOS)
      return
    }
    if (text.length > 64) pushUniqueString(sink.b64, text, MAX_GENERATED_VIDEOS)
    return
  }
  if (isVideoAddress(text, key)) pushUniqueString(sink.urls, text, MAX_GENERATED_VIDEOS)
}

/**
 * 递归遍历结果对象，收集视频候选。
 *
 * 为什么用递归而不是按固定键路径取：生视频的响应形状没有统一契约 —— 见过
 * `data[].url`、`output.url`、`video_url`、`videoUrls: []`，也有网关直接塞
 * `data.video_b64`。按「字符串内容 + 所在键名」判，比按路径猜更耐改。
 */
function collectVideoCandidates(node: unknown, sink: VideoCandidates, key: string | null = null, depth = 0): void {
  if (depth > 8) return
  if (typeof node === 'string') {
    collectVideoString(node, key, sink)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectVideoCandidates(item, sink, key, depth + 1)
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
    collectVideoCandidates(child, sink, childKey, depth + 1)
  }
}

/** 按候选键名取第一个可字符串化的标量值。 */
function firstScalar(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/**
 * 在结果对象里找「异步任务」形态：同一个对象里同时有 id 与 status。
 *
 * 生视频走异步任务很常见（网关先回 `{ data: { id, status: 'queued' } }`，几秒后
 * 再轮询出片）。此时没有可播放文件，卡片上展示任务 id + 状态。
 */
function readVideoTask(node: unknown, depth = 0): { id: string; status: string } | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = readVideoTask(item, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const record = node as Record<string, unknown>
  const id = firstScalar(record, TASK_ID_KEYS)
  const status = firstScalar(record, TASK_STATUS_KEYS)
  if (id !== null && status !== null) return { id: clip(id, 120), status: clip(status, 120) }
  for (const value of Object.values(record)) {
    const found = readVideoTask(value, depth + 1)
    if (found !== null) return found
  }
  return null
}

/** 一条生视频结果落盘后的可用形态。 */
interface GeneratedVideos {
  /** 同源 URL 列表（去重、保持结果顺序）。 */
  videos: string[]
  /** 异步任务信息（有可播放文件时为 null）。 */
  task: { id: string; status: string } | null
  /** 生视频模型名（结果里没有就是 null）。 */
  model: string | null
}

/**
 * 从一条 generate_video 的工具结果里把视频落盘，并抽出异步任务信息。
 *
 * 逐条独立成败：某一条下载失败 / 解码失败 / 不是视频就跳过它继续下一条。因此
 * videos 可能比候选少。任何异常都在调用方 try/catch 里收敛 —— 视频少一条可以，
 * 工具卡本身不能因此丢。
 */
async function materializeGeneratedVideos(ctx: any, message: any): Promise<GeneratedVideos | null> {
  const raw = textOfMessage(message)
  if (raw.trim() === '') return null
  const text = readGeneratedResultText(ctx, raw)

  let parsed: unknown = null
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    parsed = null
  }

  const sink: VideoCandidates = { urls: [], b64: [] }
  let model: string | null = null
  if (parsed !== null && typeof parsed === 'object') {
    collectVideoCandidates(parsed, sink)
    const record = parsed as Record<string, unknown>
    if (typeof record.model === 'string' && record.model !== '') model = record.model
  } else {
    // 结果不是 JSON（纯文本 / 被截断）：退一步从正文里捞 http(s) 视频地址。
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const url = match[0]
      if (VIDEO_URL_EXT_RE.test(url.split(/[?#]/)[0] ?? url)) pushUniqueString(sink.urls, url, MAX_GENERATED_VIDEOS)
    }
  }

  const outDir = join(botWorkspaceDir(), '_tmp', 'generated-media')
  const videos: string[] = []
  for (const url of sink.urls) {
    const rel = await writeGeneratedVideo(url, outDir)
    if (rel === null) continue
    const href = `${IMAGE_FILE_ROUTE}?path=${encodeURIComponent(rel)}`
    if (!videos.includes(href)) videos.push(href)
  }
  for (const b64 of sink.b64) {
    if (videos.length >= MAX_GENERATED_VIDEOS) break
    const rel = await writeGeneratedVideo(`data:video/mp4;base64,${b64}`, outDir)
    if (rel === null) continue
    const href = `${IMAGE_FILE_ROUTE}?path=${encodeURIComponent(rel)}`
    if (!videos.includes(href)) videos.push(href)
  }

  // 没有可播放文件时才看异步任务：网关先回 task_id 是常见形态。
  const task = videos.length === 0 && parsed !== null ? readVideoTask(parsed) : null
  if (videos.length === 0 && task === null) return null
  return { videos, task, model }
}

/* ───────────────────── 产出物（artifacts）───────────────────── */

/** present 工具名：它的参数里直接写着要交付的文件路径。 */
const PRESENT_TOOL_NAME = 'present'

/** artifacts 单文件上限：与 /file 的媒体上限一致（256MB）。 */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024

/** 一张工具卡最多挂几个产出物：再多卡片也放不下。 */
const MAX_ARTIFACTS = 12

/**
 * 可识别的产出物扩展名 → 展示类型。
 *
 * 这份表同时是**扫描结果文本时的白名单**：只有命中它的 token 才会被当路径去
 * stat，否则随便一个带点号的中文词都会被误判成文件。
 */
const ARTIFACT_KIND_BY_EXT: Readonly<Record<string, ArtifactKind>> = {
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.m4v': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.ogg': 'audio',
  '.pdf': 'pdf',
  '.doc': 'doc', '.docx': 'doc', '.odt': 'doc',
  '.xls': 'sheet', '.xlsx': 'sheet', '.ods': 'sheet',
  '.ppt': 'slide', '.pptx': 'slide', '.odp': 'slide',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
  '.zip': 'file',
}

/** 路径比较用的归一化（与 host/personal/index.ts 的 normalizeForCompare 同口径）。 */
function normalizeCompare(value: string): string {
  return resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 一个候选路径 → ArtifactRef（不合格返回 null）。
 *
 * 判据（缺一条都不收）：落在 bot 工作区内、扩展名在白名单、存在且是普通文件、
 * 非空、≤256MB。绝对路径与相对路径都接受（相对以 bot 工作区为基准）。
 */
function artifactRefFor(rawPath: string): ArtifactRef | null {
  const text = rawPath.trim()
  if (text === '' || text.includes('://')) return null
  let target: string
  try {
    target = resolve(isAbsolute(text) ? text : join(botWorkspaceDir(), text))
  } catch {
    return null
  }
  const root = normalizeCompare(botWorkspaceDir())
  const normalized = normalizeCompare(target)
  if (normalized !== root && !normalized.startsWith(`${root}/`)) return null
  const ext = extname(target).toLowerCase()
  const kind = ARTIFACT_KIND_BY_EXT[ext]
  if (kind === undefined) return null
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(target)
  } catch {
    return null
  }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) return null
  const rel = relative(botWorkspaceDir(), target).replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('..')) return null
  return {
    path: rel,
    url: `${IMAGE_FILE_ROUTE}?path=${encodeURIComponent(rel)}`,
    name: basename(target),
    kind,
    size: info.size,
  }
}

/**
 * 结果文本里「像产出物扩展名」的廉价预筛。
 *
 * 为什么需要：生图 / 生视频的结果文本动辄几 MB 的 base64，而 `extractArtifactPaths`
 * 要按标点 split 成 token 再逐个 extname —— 对纯 base64 文本跑一遍会白分配几万个
 * 字符串。先用一个不分配的正则过一遍，绝大多数媒体结果在这里就被挡掉。
 */
const ARTIFACT_PATH_HINT_RE = /\.(?:mp4|m4v|webm|mov|mp3|wav|m4a|ogg|pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|png|jpe?g|webp|gif)(?![A-Za-z0-9])/i

/**
 * 从结果文本里捞「像工作区文件路径」的 token。
 *
 * 刻意按空白与常见标点切开再逐个判，而不是写一个大正则：工具结果的文本形态
 * 千奇百怪（`已写入 _tmp/a.docx`、`("D:\\Seeker-Bot\\b.pdf")`、`- out/c.xlsx`），
 * 一个正则要覆盖全部写法会变成不可读的怪物，而且很容易把 URL 一起吞进去。
 */
function extractArtifactPaths(text: string): string[] {
  if (typeof text !== 'string' || text === '') return []
  if (!ARTIFACT_PATH_HINT_RE.test(text)) return []
  const found: string[] = []
  for (const chunk of text.split(/[\s"'`<>()\[\]{}，。；：、！？|（）【】《》「」]+/)) {
    const token = chunk.replace(/^[.,;:!?]+/, '').replace(/[.,;:!?]+$/, '')
    if (token === '' || token.length > 400) continue
    // URL 里的路径段不是本地文件，跳过整条 token。
    if (token.includes('://')) continue
    const ext = extname(token).toLowerCase()
    if (ARTIFACT_KIND_BY_EXT[ext] === undefined) continue
    // 必须是「像路径」的形态：绝对路径，或带分隔符的相对路径。
    if (!isAbsolute(token) && !/[\\/]/.test(token)) continue
    found.push(token)
  }
  return found
}

/** present 的调用参数 → 候选路径（path / paths / file / files，字符串或数组）。 */
function parsePresentPaths(raw: unknown): string[] {
  const record = argumentsRecord(raw)
  const paths: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string') {
      const text = value.trim()
      if (text !== '') paths.push(text)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) push(item)
      return
    }
    if (typeof value === 'object' && value !== null) {
      // 兼容 [{ path: '...' }] 这种写法
      const path = (value as Record<string, unknown>).path
      if (typeof path === 'string' && path.trim() !== '') paths.push(path.trim())
    }
  }
  for (const key of ['path', 'paths', 'file', 'files']) push(record[key])
  return paths
}

/**
 * 汇总一张工具卡的产出物：present 的参数路径 + 结果文本里出现的路径。
 *
 * 去重（同一路径只留一条）、最多 12 条、按出现顺序（present 参数在前）。
 */
function collectArtifacts(presentPaths: readonly string[], resultText: string): ArtifactRef[] {
  const candidates = [...presentPaths, ...extractArtifactPaths(resultText)]
  const refs: ArtifactRef[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (refs.length >= MAX_ARTIFACTS) break
    const ref = artifactRefFor(candidate)
    if (ref === null) continue
    if (seen.has(ref.path)) continue
    seen.add(ref.path)
    refs.push(ref)
  }
  return refs
}

/**
 * 最近一轮的会话事件记录（诊断接口读取）。
 *
 * 排查「agent 建起来了但界面没反应」时，这是唯一能说明问题的证据：
 * events 为空 = 监听没挂对；有 turn/end 但没有 assistant/message = 模型步骤没跑。
 */
let lastTurnDebug: unknown = null

/** 读取最近一轮的诊断记录（供 /diagnose 路由使用）。 */
export function getLastTurnDebug(): unknown {
  return lastTurnDebug
}

/**
 * 跑一轮：把用户这句话投给 agent，收集「文本 / 工具调用 / 工具结果」，
 * 边收边通过 emit 推给前端，最后返回完整 blocks。
 */
export async function runBotTurn(
  ctx: any,
  spec: BotAgentSpec,
  text: string,
  emit: (event: PersonalStreamEvent) => void,
  signal?: AbortSignal,
): Promise<TurnResult> {
  const startedAt = Date.now()
  const blocks: Array<Record<string, unknown>> = []
  const toolIndex = new Map<string, ToolRun>()
  /**
   * 媒体落盘（生图 / 生视频）的异步任务。
   *
   * 为什么要在收尾时等它们：`tool/result` 到达时先把卡片变成 ok，图片 / 视频是
   * 之后异步补的（http(s) 资源要下载）。若不等，`done` 会先发出、SSE 一收口，
   * 前端就再也收不到补发的 images / videos —— 表现就是「跑完了但对话流里没东西」。
   */
  const pendingMediaTasks = new Set<Promise<void>>()
  /** present 的调用参数里带的路径（callId → 候选路径），tool/result 时 stat 它们。 */
  const pendingPresentPaths = new Map<string, string[]>()

  let agent: any
  try {
    agent = await ensureBotAgent(ctx, spec)
  } catch (error: any) {
    const message = String(error?.message ?? error)
    emit({ type: 'error', message })
    return { ok: false, blocks: [], error: message }
  }

  const sessionId = String(agent?.session?.id ?? botSessionId(spec.botId))

  /** 推一条文本块。 */
  const pushText = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed === '') return
    blocks.push({ type: 'text', text: trimmed })
    emit({ type: 'text', text: trimmed })
  }

  /** 推 / 更新一张工具卡。 */
  const pushTool = (run: ToolRun): void => {
    toolIndex.set(run.id, run)
    blocks.push({ type: 'tool', run })
    emit({ type: 'tool', run })
  }

  const updateTool = (run: ToolRun): void => {
    toolIndex.set(run.id, run)
    // 就地替换 blocks 里同一张卡：非流式返回时，用户看到的是最终状态而不是「running」
    const index = blocks.findIndex(
      (block) => block.type === 'tool' && (block.run as ToolRun | undefined)?.id === run.id,
    )
    if (index >= 0) blocks[index] = { type: 'tool', run }
    emit({ type: 'tool', run })
  }

  /** 等到本轮结束（turn/end）或超时。 */
  let settle: (() => void) | null = null
  const finished = new Promise<void>((resolveTurn) => { settle = resolveTurn })

  /*
   * 诊断记录：这一轮到底收到了哪些事件、turn/end 说了什么。
   * 排查「agent 建起来了但界面没反应」时，唯一能说明问题就是这张表——
   * 事件表为空说明监听没挂对，有 turn/end 但没有 assistant/message 说明
   * 模型步骤根本没跑起来。
   */
  const debug: {
    sessionId: string
    listener: string
    events: string[]
    turnEnd: unknown
    error?: string
  } = { sessionId, listener: '', events: [], turnEnd: null }
  lastTurnDebug = debug

  const seenSeq = new Set<number>()

  const handler = (session: any, event: any): void => {
    // 两个作用域都注册了监听，同一事件会被投递两次：按 seq 去重
    const seq = typeof event?.seq === 'number' ? event.seq : -1
    if (seq >= 0) {
      if (seenSeq.has(seq)) return
      seenSeq.add(seq)
    }
    const type = String(event?.type ?? '')
    debug.events.push(type)
    if (String(session?.id ?? '') !== sessionId) return
    const data = event?.data ?? {}

    if (type === 'tool/call') {
      /*
       * 工具调用在**执行前**就发这条事件，且自带 name / arguments——比从
       * assistant/message 里反抽更早也更准（后者要等整段消息提交）。所以工具卡
       * 以它为准，assistant/message 只负责文本。
       */
      const callId = String(data?.callId ?? '')
      if (callId === '' || toolIndex.has(callId)) return
      const startedAt = typeof event?.time === 'number' ? event.time : Date.now()
      const name = String(data?.name ?? 'tool')
      /*
       * 生图请求的参数在**结果回来之前**就到了：prompt / 张数 / 宽高比都在
       * arguments 里。提前带给前端，实时卡才能在等图时按比例画点阵占位。
       * 解析用完整 arguments（不是卡片上那段 clip 文本）。
       */
      const imageSpec = name === IMAGE_TOOL_NAME ? parseImageRequest(data?.arguments) : null
      /*
       * 生视频只有 prompt（没有张数 / 比例的概念）：实时卡在等片时用完整提示词
       * 当副标题，和生图卡同一套展示契约。
       */
      const videoPrompt = name === VIDEO_TOOL_NAME ? argumentsRecord(data?.arguments).prompt : undefined
      /*
       * present 的路径参数先记下来：tool/result 时 stat 它们，把产出物挂到同一张
       * 工具卡上。放在这里而不是结果里，是因为 present 的参数就是权威来源
       * （结果文本可能只是「已展示 2 个文件」这种摘要）。
       */
      if (name === PRESENT_TOOL_NAME) {
        const presentPaths = parsePresentPaths(data?.arguments)
        if (presentPaths.length > 0) pendingPresentPaths.set(callId, presentPaths)
      }
      pushTool({
        id: callId,
        name,
        ...(typeof data?.arguments === 'string' && data.arguments !== ''
          ? { args: clip(data.arguments) }
          : {}),
        status: 'running',
        startedAt,
        ...(imageSpec === null
          ? {}
          : {
              imageCount: imageSpec.count,
              imageRatio: imageSpec.ratio,
              ...(imageSpec.prompt !== '' ? { prompt: imageSpec.prompt } : {}),
            }),
        ...(typeof videoPrompt === 'string' && videoPrompt.trim() !== ''
          ? { prompt: videoPrompt.trim() }
          : {}),
      })
      return
    }

    if (type === 'tool/result') {
      const callId = String(data?.message?.toolCallId ?? '')
      const existing = callId === '' ? undefined : toolIndex.get(callId)
      if (existing === undefined) return
      const isError = data?.message?.isError === true || data?.error !== undefined
      // 完整结果文本留给产出物扫描（clip 只用于卡片摘要，截断后可能切掉路径）。
      const rawResultText = textOfMessage(data.message) || (isError ? '执行失败' : '')
      const resultText = clip(rawResultText)
      const endedAt = typeof event?.time === 'number' ? event.time : Date.now()
      /*
       * 产出物识别：present 的参数路径 + 结果文本里出现的 bot 工作区文件路径。
       *
       * 这一步是**同步**的（只 stat，不读内容），所以直接塞进这一次 updateTool，
       * 不必像图片那样再补发一条事件。spill 结果也读回全文再扫：路径经常只出现
       * 在被 spill 掉的完整结果里，事件里的 preview 已经截掉了。
       */
      const presentPaths = pendingPresentPaths.get(callId) ?? []
      pendingPresentPaths.delete(callId)
      const artifacts = isError
        ? []
        : collectArtifacts(presentPaths, readGeneratedResultText(ctx, rawResultText))
      updateTool({
        ...existing,
        status: isError ? 'error' : 'ok',
        ...(resultText !== '' ? { result: resultText } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
        endedAt,
        durationMs: Math.max(0, endedAt - existing.startedAt),
      })
      /*
       * 生图 / 生视频结果里的媒体不在卡片上：result 只是 clip 过的摘要，base64
       * 本体还可能被 spill 到临时文件里。这里把媒体落盘、再把同源 URL 补进同一
       * 张卡。
       *
       * 落盘是异步的（http(s) 资源要下载），所以不阻塞事件处理：上面已经先把卡
       * 变成 ok，落完再 updateTool 一次补 images / videos。整个任务包在 try/catch
       * 里，任何失败都只影响媒体，不影响已经发出去的工具结果。
       */
      if (!isError && existing.name === IMAGE_TOOL_NAME) {
        const task = (async (): Promise<void> => {
          try {
            const generated = await materializeGeneratedImages(ctx, data.message)
            if (generated === null) return
            const current = toolIndex.get(callId)
            if (current === undefined) return
            updateTool({
              ...current,
              ...(generated.images.length > 0 ? { images: generated.images } : {}),
              ...(generated.model !== null ? { model: generated.model } : {}),
            })
          } catch {
            /* 图片落盘失败不影响工具卡：它已经是 ok 状态了 */
          }
        })()
        pendingMediaTasks.add(task)
        void task.then(() => { pendingMediaTasks.delete(task) }, () => { pendingMediaTasks.delete(task) })
      }
      if (!isError && existing.name === VIDEO_TOOL_NAME) {
        const task = (async (): Promise<void> => {
          try {
            const generated = await materializeGeneratedVideos(ctx, data.message)
            if (generated === null) return
            const current = toolIndex.get(callId)
            if (current === undefined) return
            updateTool({
              ...current,
              ...(generated.videos.length > 0 ? { videos: generated.videos } : {}),
              ...(generated.task !== null ? { videoTask: generated.task } : {}),
              ...(generated.model !== null ? { model: generated.model } : {}),
            })
          } catch {
            /* 视频落盘失败不影响工具卡：它已经是 ok 状态了 */
          }
        })()
        pendingMediaTasks.add(task)
        void task.then(() => { pendingMediaTasks.delete(task) }, () => { pendingMediaTasks.delete(task) })
      }
      return
    }

    if (type === 'assistant/message') {
      // 只取文本：工具卡已经由 tool/call 建好了
      const textValue = textOfMessage(data.message)
      if (textValue !== '') pushText(textValue)
      return
    }

    if (type === 'turn/end') {
      debug.turnEnd = data
      settle?.()
    }
  }

  /*
   * 事件按 session 的**作用域**分发：session 是在 agent 的上下文里创建的，
   * 所以在插件自己的 ctx 上注册收不到（这正是「agent 建起来了、但界面一直说
   * 没有权限」的根因——监听器一个事件都没进来）。这里在 agent.ctx 上注册，
   * 同时保留 root ctx 作为兜底，handler 内按 seq 去重。
   */
  const disposers: Array<() => void> = []
  const register = (target: any, label: string): void => {
    try {
      if (typeof target?.on !== 'function') return
      const off = target.on('session/event', handler)
      if (typeof off === 'function') disposers.push(off as () => void)
      debug.listener = debug.listener === '' ? label : `${debug.listener}+${label}`
    } catch {
      /* 该作用域不支持注册 */
    }
  }
  register(agent?.ctx, 'agent.ctx')
  register(ctx, 'root')

  const onAbort = (): void => { settle?.() }
  signal?.addEventListener('abort', onAbort)

  try {
    // 先补记忆上下文，再投用户消息：inject 不唤醒驱动器，正好落在本次步骤里
    injectMemories(agent, spec.memories)
    agent.followup(createUserMessage(text))
    // 超时兜底：工具可能跑很久，但前端不能永远挂着
    const timer = setTimeout(() => settle?.(), 10 * 60_000)
    try {
      await finished
    } finally {
      clearTimeout(timer)
    }
  } catch (error: any) {
    const message = String(error?.message ?? error)
    for (const dispose of disposers) dispose()
    signal?.removeEventListener('abort', onAbort)
    debug.error = message
    emit({ type: 'error', message })
    return { ok: false, blocks, error: message, sessionId }
  }

  for (const dispose of disposers) dispose()
  signal?.removeEventListener('abort', onAbort)

  /*
   * 等媒体落盘收尾（放在 done 之前）：tool/result 已经把卡变成 ok，images /
   * videos 是异步补的。不等的话 done 会先发出，SSE 一收口，前端就收不到后补的
   * tool 事件。单次 http 下载有上限（图片 30s / 视频 120s），所以最坏也只是多等
   * 一个资源的时间；任务内部已经各自 try/catch，allSettled 不会因为某条失败而抛。
   */
  if (pendingMediaTasks.size > 0) {
    try {
      await Promise.allSettled([...pendingMediaTasks])
    } catch {
      /* 兜底：理论上 allSettled 不会 reject */
    }
  }

  // 收尾：还在 running 的工具卡标记为未知（多半是被取消 / 超时）
  for (const run of toolIndex.values()) {
    if (run.status !== 'running') continue
    updateTool({ ...run, status: 'error', result: '未拿到结果（已取消或超时）', endedAt: Date.now() })
  }

  const durationMs = Date.now() - startedAt
  if (blocks.length === 0) {
    const message = '本轮没有产生任何输出'
    emit({ type: 'error', message })
    return { ok: false, blocks, error: message, sessionId }
  }
  emit({ type: 'done', durationMs })
  return { ok: true, blocks, sessionId }
}

/** 撤回一轮对话的结果。 */
export interface RecallResult {
  ok: boolean
  /** 被遮蔽的 surface 节点数（用户消息 + 该轮 bot 回复 + 工具结果）。 */
  removed?: number
  error?: string
}

/** 撤回占位消息的文本：模型看到它就知道这一段被用户撤掉了。 */
const RECALL_PLACEHOLDER = '[用户撤回了这一段对话，请忽略此前这些内容]'

/**
 * 撤回一轮对话：把「这条用户消息 + 它之后的 bot 回复」从模型可见 surface 上遮蔽掉。
 *
 * ## 为什么是 replace 而不是删除
 *
 * Session 日志是 append-only 的事实记录（崩溃恢复、审计都靠它），没有删除 API。
 * 但 surface（模型可见消息序列）支持 `replace`——compaction 用的同一机制：
 * 追加一条新节点，把指定区间整体替换掉，之后 `deriveMessages()` 重建历史时
 * 这些内容就不在了。于是「撤回」= 日志保留 + 上下文消失。
 *
 * ## 语义边界
 *
 * 撤回只影响**之后的模型上下文**：模型在产生那条回复的那一步已经看过原文，
 * 这里保证的是「后续对话不再带着它」。
 *
 * ## 定位方式
 *
 * 前端只有本地消息（localStorage），没有 session seq，所以按「user/message +
 * 文本完全相等 + 时间最接近」反查。撤回范围 = 该节点到下一个 user/message
 * 节点之前（含 assistant / tool 节点）。
 */
export async function recallBotTurn(
  ctx: any,
  spec: BotAgentSpec,
  text: string,
  at: number,
): Promise<RecallResult> {
  const wanted = String(text ?? '').trim()
  if (wanted === '') return { ok: false, error: '空消息无法撤回' }

  let agent: any
  try {
    agent = await ensureBotAgent(ctx, spec)
  } catch (error: any) {
    return { ok: false, error: `无法连接该 Bot 的会话：${String(error?.message ?? error)}` }
  }

  const session = agent?.session
  const nodes: number[] = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []
  if (nodes.length === 0) return { ok: false, error: '会话里还没有可撤回的消息' }

  const textOf = (event: any): string => {
    const content = event?.data?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => String(block.text))
      .join('')
      .trim()
  }

  // 目标节点：文本相等、且时间最接近前端那条消息的 user/message
  let targetIndex = -1
  let bestDelta = Number.POSITIVE_INFINITY
  for (let index = 0; index < nodes.length; index += 1) {
    const event = session.eventAt(nodes[index])
    if (event?.type !== 'user/message') continue
    if (textOf(event) !== wanted) continue
    const delta = Math.abs((typeof event.time === 'number' ? event.time : 0) - at)
    if (delta < bestDelta) {
      bestDelta = delta
      targetIndex = index
    }
  }
  if (targetIndex < 0) return { ok: false, error: '会话里找不到这条消息（可能已被撤回或清空）' }

  // 区间终点：下一个 user/message 节点之前的最后一个节点（没有下一个就到最后）
  let endIndex = nodes.length - 1
  for (let index = targetIndex + 1; index < nodes.length; index += 1) {
    if (session.eventAt(nodes[index])?.type === 'user/message') {
      endIndex = index - 1
      break
    }
  }
  if (endIndex < targetIndex) return { ok: false, error: '撤回范围为空' }

  const startSeq = nodes[targetIndex]
  const endSeq = nodes[endIndex]
  const range = nodes.slice(targetIndex, endIndex + 1)

  // turn/step 沿用区间里最后一个带它们的节点（assistant/message），缺省 0
  let turn = 0
  let step = 0
  for (const seq of range) {
    const data: any = session.eventAt(seq)?.data
    if (typeof data?.turn === 'number') turn = data.turn
    if (typeof data?.step === 'number') step = data.step
  }

  try {
    session.append(
      'developer/message',
      {
        turn,
        step,
        message: {
          id: `pa-recall-${randomUUID()}`,
          role: 'developer',
          content: [{ type: 'text', text: RECALL_PLACEHOLDER }],
          source: { kind: 'plugin' },
        },
      },
      {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        // 必须覆盖被遮蔽区间里的**每一个** surface 节点，宿主会逐项校验
        sourceEventSeqs: range,
      },
    )
    return { ok: true, removed: range.length }
  } catch (error: any) {
    return { ok: false, error: `撤回失败：${String(error?.message ?? error)}` }
  }
}
