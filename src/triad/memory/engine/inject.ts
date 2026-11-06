/**
 * dsh-memory 注入引擎：agent/pre-step 把记忆组装成带来源的 user message 注入
 * （source: { kind: 'plugin:dsh-memory' }）。绝不写 system prompt（DSH persona
 * complete:true 会静默丢弃）。
 *
 * ── 注入分两层（0.3）──────────────────────────────────────────────
 *  · **稳定层**：置顶 + 全局身份/偏好 + 长期沉淀。每会话首步注入一次，记忆内容
 *    变了（store.revision 变化）再补一次——这些东西与话题无关，反复注入纯浪费。
 *  · **检索层**：与当前对话最相关的 top-k。**每 N 轮或话题明显变化时重新检索，
 *    并整体替换上一轮的检索块**（不是追加）。首步按第一句话检索出的 8 条，聊到
 *    第十轮时多半已经无关；但每轮都追加一份，历史里会堆出十几份越来越像的清单，
 *    既烧 token 又让模型分不清哪份是当前的。
 *
 * 除主注入外，本文件还承载四条**内置通道**（zh 中文偏好 / html+iu 卡片规范 /
 * team 团队协作 / 任务清单纪律）：各自独立 stepCounters、各自全局开关、每会话只注首步、
 * 位置一律在「项目排除 + 主注入开关」两道闸门之前，失败只记日志。
 */

import { createUserMessage } from '../../../vendor/dsh-llm/index.js'
// iu kind 注册表（**纯逻辑**，host 半身可用）：注入文档直接取每个 kind 自带
// 的 doc 行，不再在这里手写示例——手写必然漂移（piano 的 showNotes 字段实现了
// 但文档从没提过，模型永远不知道能用它）。文档跟着实现走。
import { iuKindsDoc, IU_KIND_NAMES } from '../../../client/iu/kinds/registry.ts'
import type { MemoryConfig, MemoryEntry } from '../types.js'
import { buildChineseInjectionText, buildInjectionText, renderEntryLines, selectChineseEntries, selectInjectionEntries, workspaceHashOf } from './compile.js'
import { TODO_RULE_INJECTION_RULE } from './todo-rule.js'
import { searchEntries, semanticSimilarity } from './retrieval.js'
import { daysSince } from './scoring.js'
import { isExpired, type MemoryStore } from './store.js'
import { filterCoveredByVault } from './vault-overlap.js'
import { visibilityFor } from './visibility.js'
import { hostFeatureEnabled } from '../../../features/store.ts'

/** pre-step 载荷的最小 agent 面。 */
export interface PreStepAgent {
  readonly id: string
  readonly session: {
    readonly id: string
    readonly header?: { cwd?: string }
  }
}

export interface MemoryInjector {
  /** 注入监听器（注册时用 prepend: true）。 */
  preStepListener: (payload: {
    agent: PreStepAgent
    messages: unknown[]
    signal: AbortSignal
  }, next: () => Promise<{ kind: 'enter'; messages: unknown[] } | { kind: 'reject' }>) => Promise<unknown>
  /**
   * 新的一轮开始（index.ts 在 `turn/start` 调）。
   *
   * 用途只有一个：把「本轮已因记忆变更重注过」的标记清掉，让下一轮还能再重注一次。
   * 没有它，就分不清「同一轮里连续两次写记忆」和「隔了一轮又写记忆」——前者要
   * 合并成一次重注（否则模型每调一次 memory_remember 就重注一遍整块记忆），
   * 后者必须重注（用户真的改了东西）。
   */
  noteTurnStart: (sessionId: string) => void
  /** 清理会话级状态。 */
  disposeSession: (sessionId: string) => void
}

/** 每次注入最多刷新的命中条目数。 */
const MAX_HITS_PER_INJECTION = 5

/**
 * 稳定层占注入预算的比例。
 *
 * 0.7 而不是对半分：稳定层是「用户置顶 + 身份偏好 + 长期沉淀」，条目数少、
 * 命中率高，而且 pinned 另有 40% 占比上限，实际很少吃满；检索层才是每轮真正
 * 跟着话题变的部分，留 30%（默认预算 6000 字符时约 1800）够放 8 条中等长度记忆。
 */
const STABLE_BUDGET_RATIO = 0.7

/**
 * 检索块的首行标记：靠它从历史消息里认出上一轮的检索块并整体替换。
 *
 * 为什么用文本前缀而不是 source 字段：历史消息经 DSH 会话持久化后，source 上的
 * 自定义字段不保证原样保留，而 content 文本一定在。source.sections 里同时写一份
 * （面板/调试时更好认），但判定只认文本。
 */
const RETRIEVAL_MARK = '【相关记忆 · 按当前任务检索】'

/** 该消息是否是本插件上一轮注入的检索块。 */
function isRetrievalBlockMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const record = message as { role?: string; source?: { kind?: string }; content?: unknown }
  // 只认 user 消息：检索块是插件注入的 user message，assistant 正文里即使复述了
  // 这个前缀（比如它在解释记忆机制）也不该被删。
  if (record.role !== undefined && record.role !== 'user') return false
  // source 还在时以它为准（别的插件注入的块绝不能被误删）；source 被会话持久化层
  // 丢掉时退回纯文本判定——前缀是插件专用的，误伤概率极低，而漏判（旧块删不掉）
  // 会让历史里堆出多份检索块，那正是 0.3 要解决的问题。
  if (typeof record.source?.kind === 'string' && record.source.kind !== 'plugin:dsh-memory') return false
  return textOf(record.content).startsWith(RETRIEVAL_MARK)
}

/**
 * 用户输入是否「换话题了」。
 *
 * 检索层除了按轮数刷新，还要认这一条：用户直接甩一句新任务时，不该等满 N 轮。
 * 用 n-gram 相似度而不是字符串相等——「帮我看下 X」→「X 的日志在哪」是同一话题
 * 的追问，相似度不低；而「帮我改下 CSS」→「客户 A 的合同呢」会明显掉下来。
 *
 * 阈值 0.35：同一话题的追问通常 > 0.5，换话题常 < 0.3，取中间留余量。
 */
function queryShifted(previous: string, next: string): boolean {
  const a = previous.trim()
  const b = next.trim()
  if (a === '' || b === '') return a !== b
  return semanticSimilarity(a, b) < 0.35
}

/** ContentBlock[] 或字符串 → 纯文本。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (typeof part !== 'object' || part === null) return ''
      const record = part as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join(' ')
}

/** 从 pre-step 消息里提取当前用户输入文本（作检索 query；跳过插件/指令注入源）。 */
function extractQuery(messages: unknown[]): string {
  const texts: string[] = []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const msg = message as { role?: string; source?: { kind?: string }; content?: unknown }
    if (typeof msg.source?.kind === 'string' && msg.source.kind !== 'user') continue
    if (msg.role !== 'user' && msg.role !== undefined) continue
    texts.push(textOf(msg.content))
  }
  return texts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}

/**
 * 内置安全规范（每次注入都携带）：敏感凭据严禁提交/更新到 GitHub。
 * 与提取敏感过滤、面板风险提示共同构成凭据防线。
 */
const SAFETY_RULE = [
  '【安全规范】所有 GitHub/OpenAI/AWS/Slack token、私钥、password 等敏感凭据',
  '严禁提交或更新到 GitHub 仓库；代码中一律用环境变量引用，',
  '并确保 .gitignore 排除含凭据的文件。',
].join('')

/**
 * 中文记忆内置通道的引导语。
 *
 * 单独成块而非并入主注入的理由：主注入整体可能处于关闭状态（用户显式关掉、
 * 项目被标记为不注入），但语言契约必须仍然成立——否则同一个用户在不同会话
 * 得到互相矛盾的回答语言。措辞里显式声明它与项目指令的优先关系，避免和
 * AGENTS.md 打架。
 */
const ZH_INJECTION_RULE = [
  '【中文偏好记忆 · 内置通道】以下为用户长期语言偏好，与上方记忆库开关无关，始终生效。',
  '请始终遵循：内部分析/推理过程与对外输出默认使用简体中文。',
  '代码、路径、命令、标识符、报错原文、API/协议名等技术内容保持原文不翻译。',
  /*
   * ── 「说明性参数也算对外输出」（2026-10-25 补）────────────────────────
   *
   * 起因：右栏「操作面板」整片英文（用户截图：Probe workspace layout and existing
   * fee… / List existing _tmp/proto contents / Inspect deliverables and create feed-pr…）。
   *
   * 那些行**不是模型答错语言**，而是工具 schema 的引导：官方 pwsh / bash / run_code
   * 的 description 参数文档写着 "Clear, concise description of what this command does
   * in active voice, 5-10 words (shown in the UI)"，并给三个英文示例
   * （"List files in current directory" / "Show working tree status"…）。模型照着写英文。
   *
   * 而 DSH 的 UI 把这段 description **原样上屏**：plain-language.ts 里
   * pwsh / bash / exec_command 三条规则的 detail 直接取 description，且都带
   * hideVerb —— 动词被抹掉之后，这一行**只剩下 description**，它因此成了卡头上的
   * 主文案。于是「中文对话 + 英文操作面板」并存，而这张卡的读者是完全不写代码的人。
   *
   * 为什么必须写进语言契约而不是改 schema：schema 是官方的（不伪造、不覆盖），
   * 而"这段文字会被人读"这一事实只有语言契约能表达。
   *
   * 边界必须钉死，否则会引出更糟的 bug：只有**给人读的说明性文字**要中文；命令原文、
   * 参数值、文件名、路径一律保持原文 —— 把 `git status` 翻译成「查看仓库状态」再去
   * 执行，那不是本地化，是破坏。
   */
  '工具调用里**会被直接显示给用户看**的说明性参数同样属于对外输出：pwsh / bash / exec_command / run_code 这类工具的 description 字段（它会被原样印在右栏操作面板与工具卡上）、子任务与定时任务的标题，一律用简体中文写，不要写英文。',
  /*
   * ── 「任务清单条目」也要中文（2026-10-25 补）──────────────────────────
   *
   * 用户原话：「我要中文的目前任务概览会出现英文我有点看不懂」。
   *
   * 与上面 description 是**同一个根因**：官方 todo_write 的 schema 对 `content`
   * 字段的说明是英文 —— "What the task is — a short imperative line."，
   * 而整份 tools 数组的文档也是英文（"The COMPLETE task list, replacing any
   * previous list."）。模型照着 schema 的语言写，于是条目全英文。
   *
   * 而这段文字的去向是**右栏「任务概览」卡的正文**（KrTaskOverviewCard 直接
   * 渲染 task.content，一个字都不加工）。也就是说：模型以为在写内部工作清单，
   * 实际上是在给一个不写代码的用户写一屏待办 —— 他看不懂。
   *
   * 为什么单独点名它：description 那条只说「说明性参数」，而 todos 是**数组里的
   * 业务内容**，不在「参数说明」的直觉范围内。不点名，模型不会把它归进语言契约。
   *
   * 边界同前：条目里出现的文件名、函数名、命令片段保持原文（「跑通 build.mjs
   * 的冒烟」这种写法是对的），要中文的是叙述那部分，不是把标识符也译掉。
   */
  '任务清单（todo_write）的每一条 content 也属于对外输出：它是右栏「任务概览」卡上给人读的正文，一律用简体中文写（如「重建插件产物并跑冒烟」），不要写英文。条目里出现的文件名、函数名、命令保持原文；子任务的 label / 标题同理。',
  '但**命令原文、参数值、文件名、文件路径保持原文**，不要翻译、不要改写——要翻译的只是那句描述，不是被执行的命令。',
  '（若与当前项目的 AGENTS.md / 项目指令或系统提示冲突，一律以项目指令为准。）',
].join('\n')

/**
 * 中文通道的注入预算：只投 preference/identity 子集，给多了纯浪费。
 *
 * 口径是**字符数**不是 token 数（buildChineseInjectionText 直接比 length），
 * 中文 1 字符 ≈ 1 token 以上，所以这里的数字基本等于实烧 token。
 *
 * 2026-10-05 由 1500 提到 2500：实测本机 26 条候选全量装配需 2087 字符，
 * 1500 只装得下 16 条，被丢的恰恰是 reduced-motion 兜底、容器查询响应式、
 * 最小改动不重构这几条——全是做 UI 时最该在场的偏好，且长条目更容易被
 * 预算挤掉，截断结果与 importance 排序并不同向。2500 留约 20% 余量给后续
 * 新增条目，再多就是拿常驻 token 换永远不会被读到的尾巴。
 */
const ZH_INJECTION_BUDGET = 2500

/**
 * 对话内 HTML 卡片（html 围栏）能力规范注入文本。
 *
 * 客户端 `splitHtml()` 会拦截正文里的 ```html
 * 围栏并渲染成沙箱 iframe 卡片，但模型默认不知道这个围栏存在——又是「有渲染器、
 * 没接线」。这里补的是指令侧那一半。
 *
 * 措辞里刻意写清三条**沙箱事实**，因为模型对 HTML 的默认直觉全都基于普通浏览器：
 *  · 没有 same-origin —— localStorage / 宿主 DOM / 外部接口调用都拿不到；
 *  · 高度必须自适应（宿主按上报高度给框，写死 100vh 会撑出滚动条）；
 *  · 不引外网资源（CDN 脚本在内网/离线环境直接白屏，且 CSP 会硬拦）。
 * 不写这三条，模型会写出「能跑但什么都不显示」的卡片，而且它自己看不到结果。
 */
const HTML_INJECTION_RULE = [
  '【对话内 HTML 卡片 · 内置通道】本客户端的对话流会把 ```html 代码围栏渲染成一张可交互的沙箱卡片（独立 iframe，带预览/源码切换、复制、重载、全屏）。',
  '需要给出「能点、能动、能算」的东西时用它：小工具、计算器、图表、可视化、演示页、单页原型。纯静态说明文字不要用它。',
  '',
  '格式：直接写 ```html 围栏，围栏正文就是完整可运行的 HTML（片段或整篇文档都行）。',
  '',
  '沙箱事实（不知道这些会写出「能跑但什么都不显示」的卡片）：',
  '  · iframe 只有 allow-scripts，**没有 same-origin**：拿不到宿主页面与 DOM，localStorage / cookie / 宿主接口一律不可用；也不要假设能读外部接口。',
  '  · 高度自适应：宿主按内容真实高度给框。不要写 height:100vh、不要给 body 加固定高度，否则会出现内部滚动条或大片空白。',
  '  · **外链一律被拦**：卡片文档带 CSP（default-src none + connect-src none），CDN 脚本 / 外链字体 / 外链图片全部加载失败，fetch / XHR / WebSocket 也发不出去；图片只能 data: 或 blob:。CSS 与 JS 全内联，图形用内联 SVG / canvas，图片用 data: URL。引了不会报错，只会静默失效——所以不要引。',
  '  · 点击链接会开新标签页（文档已设 base target=_blank），不要在卡片内部做整页跳转。',
  '  · 深浅主题：宿主会把明暗状态以 html[data-ds-dark-theme] 属性同步进来，可用它写两套配色；不写就跟随 color-scheme。',
  '  · **背景别铺满整页**：宿主已经按主题给画布兜了一层底色（亮 #fff / 暗 #16181d），而且它优先级最低——',
  '    你一旦写 `body{background:#f5f7f9}` 这类整页底色，就把它盖掉了，卡片在对话流里会变成一块**明显色差的板子**',
  '    （实测被用户当成 bug 追问过）。**默认就别要「卡片感」**：卡片是正文的一部分，不是嵌进来的一块面板；',
  '    需要分组的边界时，用留白与发丝线（.5px），不要给外层再套一圈圆角容器 + 底色 —— 那正是「面板感」的来源。',
  '  · **宽度别猜**：卡片宽度由对话流决定（侧栏折叠 / 窗口缩放 / 全屏都会变），你写页面时看不到它。',
  '    宿主会把它自动落到 `--dsh-card-w`（CSS 变量，带 px）与 `window.__dshCardWidth`（数字）——',
  '    这两个值**任何宿主下都一定有**（拿不到宿主下发时，桥会退回 iframe 自身视口宽度）。',
  '    **默认就别写宽度**：body 天然满宽，铺满最稳；确实要限宽时用 `width:min(100%, var(--dsh-card-w))`，',
  '    不要写死 `max-width:760px` 再居中——宽屏下两侧会各留一条明显空白（实测被用户指出「两侧有点空」）。',
  '    宽屏下横向空间很富余：优先用 `grid` 做两栏（如左图右说明），别把内容挤在中间一条。',
  '  · 双向交互桥：页面里调用 window.__dshFill(text) 把结果填入输入草稿；或调用 window.__dshSubmit(text)（≤4000字）直接发起下一轮对话闭环（如卡片内的「以当前参数深度推演」按钮），无需用户手动点发送。',
  '',
  '内置样式（正文出现 `k-` 类名或 `--k-` 变量时自动注入，不写 CSS 也能直接用）：',
  '  · 排版：`.k-title` 主标题 · `.k-lede` 一句话结论 · `.k-h` 章节小标题 · `.k-muted` / `.k-dim` 次级文字',
  '  · 数字：`.k-num` 等宽对齐（成列数字必加）· `.k-fs-sm` / `.k-fs-xs` 小字号',
  '  · 结构：`.k-rule` 发丝分隔线 · `.k-kv` 键值列表（>li 两栏，值右对齐）· `.k-grid` / `.k-cols` 自适应多列',
  '  · 图元：`.k-bar` 比例堆叠条（子 span 用 `--n:数值` 分配）· `.k-track` 单条进度（子 span 用 `--p:百分比`）',
  '  · 色标：`.k-swatch` 小方块配 `.k-a1`~`.k-a4` 四档色阶；主色是 `--k-accent`，另有三档 `--k-accent-2/3`、中性填充 `--k-fill`',
  '  · 动效：`.k-rise` 入场上升 · `.k-grow` 条状生长，子元素用 `--i:序号` 错峰',
  '  · **别用样式凑「卡片感」**：不要给外层套圆角+底色+阴影，分组用 `.k-rule` 和留白。',
  '',
  '内置交互（正文出现对应标记时自动注入运行时，不用自己写 JS）：',
  '  · 提示气泡：元素写 `data-tooltip="说明文字"`，hover / 键盘聚焦 / 触摸点按都会出，Escape 关闭。不要自己造浮层。',
  '  · 标签页：`<div class="k-tabs" role="tablist">` 里放 `button[role="tab"][aria-controls=面板id]`，配 `div#面板id[role="tabpanel"]`；点击与方向键/Home/End 已接管、选中态已有样式，**不要自己写切换 JS**。',
  '  · 记忆状态：`__dshState.ready(function(s){…})` 读回上次状态（s 为 null 表示没存过，用你的默认值），`__dshState.set({key:值})` 存（浅合并，≤16KB）。刷新/重挂载后自动恢复。',
  '  · 双向桥接：`window.__dshFill(文本)`（≤2000字）填入草稿；`window.__dshSubmit(文本)`（≤4000字）直接提交发起下一回合 Agent 思考。',
  '',
  '硬性约束：',
  '  · **别贴整站**：卡片是对话流里的一块正文，不是交付网站。整站骨架、多路由、几屏内容请落盘后用文字给路径。',
  '  · 围栏语言标记必须正好是 html（```html-preview 这类不算）。',
  '  · 简单事实问答用纯文本，不要为放卡而放卡。数量与时机见下面的「出卡准则：认知增益与即时微工具」。',
  '  · **大卡片发前先自检**：正文超过约 40 行、或用到图片/音频/视频、或你不确定某条规则时，',
  '    把围栏正文（不含围栏标记）传给 `validate_html_card` 工具。它返回 `[card-check]` 协议块：',
  '    status=ok 直接发；status=warn 能发但效果差；status=invalid 必须先按 fix 改。',
  '    十来行的小卡片（一个计算器、一张表、一段内联 SVG）不用走这一步，直接发。',
  '  · **围栏正文必须是完整可直接运行的内容；严禁只写一行注释/占位文字来代替**。',
  '    「<!-- 内容较长，此处省略 -->」「<!-- 见附件 -->」这种会被**当成合法卡片渲染成一片空白**',
  '    （判定只看「有没有标签」，`<!--` 就算标签），用户看到的就是一张空白框，而不是你写的说明。',
  '    真写不下：改用 ```iu 做精简版，或把文件落盘后**用文字给出路径**，不要再贴一个空围栏。',
  '',
   '轻量交互优先用 ```iu 围栏（原生卡片，不走 iframe，内容为单行 JSON）。',
   `全部 ${IU_KIND_NAMES.length} 种 kind（按常用度排序；卡片状态会持久化，刷新不丢）：`,
   // kind 清单与示例 JSON **来自注册表**（kinds/<kind>.ts 的 doc 字段）：
   // 文档跟着实现走，新增 kind 自动出现在这里，杜绝「字段实现了文档没写」
   //（真事：piano 的 showNotes 实现了，手写文档从没提过，模型永远不知道能用）。
   iuKindsDoc(),
   '  · 复杂页面（整站原型、多视图联动、自由交互）仍用 ```html；上面这些 kind 能覆盖的优先用 ```iu，体积小、不白屏、状态可持久化。',
  '',
  '【图形一律用 ```html】流程图 / 架构图 / 时序图 / 关系图 / 任何示意图，都用 ```html 手写内联 SVG，',
  '不要用文字节点凑一张「图」。原因：图形是最需要设计感的一类内容，而 iu 的图形 kind',
  '（原 graph / arch / sequence）只能画算法排版的拓扑图，视觉上限被锁死，已整块下线。',
  '',
  '写 ```html 图形的硬要求（这几条做不到就是白干）：',
  '  · 用一个 `viewBox` 定坐标系，内部**全部用绝对坐标**写死（rect x/y、path d），不要靠 flex 排版；',
  '  · **viewBox 必须紧贴内容**：宽度按图的实际跨度给（`minX` 到 `maxX`），高度同理，四周只留 16–24',
  '    个用户单位。留白给大了，图会被等比缩到中间一小条，上下各空一片（实测最常见的「浪费空间」）。',
  '    自检办法：把 viewBox 的宽高比算出来，横排流程图的理想值是 `3:1 ~ 5:1`；如果你的比例是 `1:1`，',
  '    说明高度给多了，或者该把它排成横向而不是纵向。',
  '  · **字号跟着 viewBox 走，不跟屏幕**：`viewBox` 宽 800 时就写 13–15px，宽 400 时写 12–13px。',
  '    图会被缩放到容器宽度，写 8–9px 在宽屏上会糊成一团，写 20px 又会让图变成「放大的截图」。',
  '  · 节点宽高按文字长度给足（中文约 1.15×字号/字），标签与边框留 10 以上内边距，否则文字溢出框；',
  '  · 连线画成 `<path>` 正交折线（`M … H … V …`），箭头用 `<marker>`，别用字符箭头；',
  '  · 配色只用一个主色 + 中性灰，深浅主题各写一套（`html[data-ds-dark-theme]`）；',
  '    文字色一律用 `currentColor` 或主题变量，**不要写死 `#000`/`#fff`**（暗色下直接不可读）；',
  '  · 不要写 `height:100vh`、不要引 CDN，图形必须内联 SVG；',
  '  · 复杂度控制：节点 ≤16 个、连线 ≤24 条，再多就拆成两张图，别把一张图画成一团乱麻。',
  '  · **先想排版方向**：宽屏里横排（左→右）比竖排（上→下）省一半高度，且读起来更顺；',
  '    超过 6 个节点再考虑竖排或分组。',
  '',
  '【/iu 前缀 · 用户强制出卡】用户在输入框以 `/iu` 开头时，这条消息会**连 `/iu` 一起原样发给你**（客户端不做任何转换，别把它当未知命令或笔误）。',
  '看到以 `/iu` 开头的消息 = 用户**明确要求**用卡片回答（不是建议，是指令）：必须用 ```iu 或 ```html 围栏出卡，不要用纯文字或 Markdown 表格替代。',
   'kind 由你按内容判断：即时计算/分账AA/费用试算/公式换算→calculator、数据对比/趋势折线/柱状环图看板→chart、基础取值→slider、数据行列→table、待办检查→checklist、方案对比→tabs、任务分列→kanban、收集输入→form、时间安排→timeline、前后修改→diff、层级结构→tree、完成度指标→gauge、考察理解→quiz、乐器→piano、天气预报/气象生活指数→weather、**3D空间几何/复杂物理仿真/流程架构时序图→html**、复杂页面→html。',
  '若消息里没说清要什么，就用最贴合其意图的那种卡片，不要反问。',
  '',
  '【出卡准则：认知增益与即时微工具】核心判据：只用文字说完，用户是否必须在脑子里进行三维脑补、动态推演或复杂计算？',
  '  · **必须主动出卡（认知增益场景）**：',
  '    1. 空间几何与物理运动（3D 姿态/轨迹/机械传动）：文字存在严重降维损耗，主动用 ```html 内联 Canvas/SVG 交付可把玩的 3D 或几何交互模型；',
  '    2. 连续动态仿真与调优（参数联动/试算/算法推演/流体平衡）：主动交付带滑块、实时推导公式反馈的微操纵台；',
  '    3. 即时微工具（Make a tool for the moment）：算账、AA分摊、预算规划、度量换算、多方案动态权衡，直接交付具备输入计算与重置能力的微工具；',
  '    4. 结构化数据对比与决策：遵循现代交互数据看板（指标概览卡+占比进度条+分类过滤Chips+彩色徽标）。',
  '  · **坚决不出伪卡片（杜绝形式主义）**：',
  '    1. 思考维度、建议路径、方案列举等纯文本严禁做成带打勾框和 0/N 进度的伪待办 Checklist；',
  '    2. 严禁为了排版把两句话强行拆成 Tabs，严禁生成死板无维度的黑白纯表格。',
  '  · 数量：一条回复通常 1 张精准微工具/看板，复杂场景至多 2 张，避免堆砌。',
  '',
  '【卡片怎么放进正文】卡是论据，不是装饰，也不是结论。',
  '  · **三明治**：一句引出 → 围栏 → 一句落点。引出句指向卡里的具体事实（「按你现在这个量，8 个人大概要备这些：」），',
  '    落点句给结论或下一步。**别让卡片成为回复的最后一段**——贴完围栏要接着说。',
  '  · 卡片内部**不要复述正文**：正文说过的话不要在卡里再写一遍，卡片只放「文字放不下」的那部分。',
  '  · 删掉「以下是…」「如下图所示」「我为你生成了一张…」这类**把卡片的存在复述一遍**的句子。',
  '  · 数据形态优先选轻的：3~5 个数用 table 或 gauge 就够，不要为了「丰富」去堆 kind。',
  '',
  '【标题】写「能接住上下文的一个短语」，不是报告标题：「华东贵，华北在掉」好过「2024 Q1 各区域销售额统计表」。',
  '  8–16 字最好，去掉「统计表 / 数据 / 详细 / 情况 / 一览 / 汇总 / 分析」这类公文后缀。正文给结论，标题给角度。',
  '  ```html 卡的标题取自 `<title>` 或第一个 `<h1>`（上限 60 字），```iu 卡取自 JSON 的 `title`（上限 40 字）。',
  '',
  '两条纪律：',
  '  · 卡片是正文的延伸，不是幻灯片：先把话说清楚，卡片负责「文字放不下」的那部分。',
  '  · 不要用 ```html 来展示「示例代码」——那会被渲染成真卡片。要给人看源码请用其它语言标记。',
  '  · 同理，不要在 ```iu 里写「示例 JSON」或注释占位：它会被当真卡片渲染（非法 JSON 则回退成代码块，',
  '    两种结果都不是「给人看示例」）。',
].join('\n')

/**
 * 团队协作（Agent Teams / 子代理委派）规范注入文本。
 *
 * 为什么需要它（2026-10-06 由「效率约束」通道改写而来）：模型默认倾向
 * 单线程自己串完，把本该并行的活排成队列——既慢又把大文件、长输出全灌进
 * 自己这一条上下文。而 DSH 侧本来就给了完整的团队面（subagent /
 * spawn_teammate / 共享任务板），不主动注入纪律，模型几乎不会去用。
 *
 * 与原效率通道同构：纯静态规范文本，不读条目、不做检索、不参与命中加分。
 *
 * **基调是「更积极」，但不是「无条件」**：只喊「多组队」会退化成每个小改动
 * 都开四个 teammate，协调开销吃掉全部收益。所以文本自带分档判据，且把判据的
 * 顺序写成「独立子任务默认并行 → 复杂任务组队 → 只有小事才自己做」，并给
 * 「我顺手就做完了」这句最常见的偷懒借口钉了一个反判据。
 *
 * 开头带一句「本会话若提供了 subagent / spawn_teammate / 共享任务板」：普通
 * 对话会话里这些工具可能没注入，不加这句模型会去调不存在的工具。
 *
 * **文本长度本身要受约束**：这段文字首步注入后进历史，之后每步都被
 * cacheRead 一次。判据同前：一句话若删掉后模型的做法不会变，它就是水分。
 * 保留的高价值事实：①委派必须用 fresh 子代理，fork 继承全部历史起点即大上下文；
 * ②「先自己串完再补一个验证代理」是顺序错误，返工成本翻倍。
 */
const TEAM_INJECTION_RULE = [
  '【团队协作 · 内置通道】先问一句「这活能不能拆」，而不是默认自己串完。本会话若提供了 subagent / spawn_teammate / 共享任务板，按下面三档走：',
  '',
  '一、判据（顺序不能反）：',
  '  · 互不依赖的独立子任务（多文件调研、多方案对比、批量审计/迁移、多个独立修复）→ **默认并行**：同一条消息里发多个 subagent，一个子任务一个；不要串行等，也不要先自己做一个试试。',
  '  · 跨阶段或多角色的复杂任务（调研→实现→验证、大重构、对抗式审查）→ spawn_teammate 组队，你当 Lead 收口。',
  '  · 单文件小改、单步查询、纯问答才自己做。判据是「拆出一个子任务的沟通成本是否大于它本身」，不是「我顺手就做完了」——后者是最常见的偷懒借口。',
  '',
  '二、组队的硬规矩：',
  '  · 委派 prompt 必须自包含：fresh 子代理看不到本会话历史，目标 / 输入 / 产出物路径 / 验收标准要写全。',
  '  · 写作用域先切分到不重叠，重叠的写操作一律串行；开写前在共享任务板上建任务并标 write_scopes。',
  '  · 依赖用 blocked_by 表达，不靠「发消息时它大概做完了」这种时序假设。',
  '  · 交最终答复前等齐所有 required teammate，并亲自跑一遍最终验证；子代理的自我报告不算验收。',
  '',
  '三、反模式：',
  '  · 先自己单线程串完，再补一个「验证代理」——顺序错了，返工成本翻倍。',
  '  · 让子代理干你已有上下文的活：fork 继承全部历史，起点就是那个大上下文。',
].join('\n')

/**
 * 动效技能强制加载（内置通道，**默认关**）。
 *
 * 解决的问题不是「模型不会写动效」，而是**想不起来先用技能**：技能目录里明明有
 * harmonyos-motion（术语表 + 官方时长曲线 + 跟手正确做法 + 跨平台写法 + 常见坑），
 * 模型却常凭已有印象直接写，于是反复踩「线性曲线 / 松手速度归零 / 用 duration
 * 控制弹簧」这几个坑。这段文本把「先加载」从概率行为变成确定性动作。
 *
 * 默认关：它不声明任何能力，只是替用户固定一个习惯，升级不该改变现状。
 * 文本长度受约束的理由同 team 通道——首步注入后进历史，之后每步都被 cacheRead。
 */
const MOTION_INJECTION_RULE = [
  '【动效技能 · 内置通道】涉及 UI 动效的任务，先加载 harmonyos-motion 技能再动手。',
  '',
  '判据：出现「做个动画 / 加个过渡 / 交互太生硬 / 松手像急刹车 / 不跟手 / 点了没反馈 / 卡片展开 / 页面转场 / 下拉刷新 / 列表入场」这类诉求，或要评审动效、修手感、定动效参数时，先调用 skill 工具加载 harmonyos-motion。',
  '',
  '理由：该技能内置官方时长与曲线取值、弹性参数调法、跟手与速度继承的正确做法、跨平台等价写法与常见错误清单。不加载也能写出能跑的动画，但多半会踩「线性曲线 / 速度归零 / 用 duration 控制弹簧」这几个坑。',
  '',
  '不适用：纯视频剪辑、镜头叙事、生成式视频，以及不涉及动效的普通 UI 改动。',
].join('\n')

/**
 * 通俗解释（ELI5 模式）能力规范注入文本。
 *
 * 开启后每会话首步注入一条规则：解答概念、说明原理时像给5岁小孩或零基础朋友
 * 解释一样，语言通俗平实，善用生动生活比喻，拆解本质常识，不堆砌晦涩专业黑话。
 *
 * 默认关：Work 模式下为纯工程模式，属于用户主动打开的表达风格偏好。
 */
const ELI5_INJECTION_RULE = [
  '【通俗解释 · 内置通道】像给5岁小孩或零基础朋友解释一样回答问题（ELI5 模式）。',
  '',
  '1. 语言通俗平易：绝不堆砌晦涩艰深的学术术语、工程黑话或抽象大词。',
  '2. 善用生活比喻：遇到抽象机制、复杂流程或技术概念，必须打一个贴近日常生活的生动比喻（如把 API 比作餐馆服务员、把缓存比作桌子上的零食盘），先在脑海中建立直观画面。',
  '3. 拆解本质常识：把复杂问题拆成最朴素直白的常识因果（它是什么、解决了什么现实麻烦、像生活中的什么）。',
  '4. 术语紧跟解释：若必须出现专业技术名词或英文缩写，紧接着在括号里或下一句用大白话解释清楚。',
  '（注：代码编写、终端命令、配置文件修改等具体工程实操，其代码与命令原文保持精准专业；叙述、分析与解释部分严格遵循本通俗约定。）',
].join('\n')

/** 创建注入器。 */
export function createMemoryInjector(
  store: MemoryStore,
  config: MemoryConfig,
  logger: { debug?: (message: string) => void; warn?: (message: string) => void } | undefined,
): MemoryInjector {
  /** 每会话 step 计数（仅内存）。 */
  const stepCounters = new Map<string, number>()
  /**
   * 中文通道的每会话 step 计数，**必须独立于 stepCounters**。
   *
   * 共用一个 Map 会互相抢占首步名额：主注入先跑就把 sessionId 记上，中文
   * 通道随后的 has() 命中而静默跳过——而主注入恰恰在最常被关闭的那条路径上
   * 提前 return，来不及置位，反而是中文通道把它占了。两边各记各的。
   */
  const zhStepCounters = new Map<string, number>()

  /**
   * html 通道的每会话 step 计数，理由同 zhStepCounters——各内置通道各记
   * 各的，共用一个 Map 会互相抢占首步名额。
   */
  const htmlStepCounters = new Map<string, number>()

  /**
   * team 通道的每会话 step 计数，理由同 zhStepCounters——各通道各记各的，
   * 共用一个 Map 会互相抢占首步名额。
   */
  const teamStepCounters = new Map<string, number>()

  /**
   * 任务清单纪律通道的每会话 step 计数，理由同 teamStepCounters——各通道各记各的，
   * 共用一个 Map 会互相抢占首步名额。
   */
  const todoRuleStepCounters = new Map<string, number>()

  /**
   * 动效技能通道的每会话 step 计数，理由同上——各通道各记各的，共用一个 Map
   * 会互相抢占首步名额。
   */
  const motionStepCounters = new Map<string, number>()

  /**
   * 通俗解释（ELI5）通道的每会话 step 计数，理由同上——各通道各记各的。
   */
  const eli5StepCounters = new Map<string, number>()

  /**
   * 每会话「上次注入时」的记忆内容版本号（store.revision）。
   *
   * 为什么必须记住它：主注入每会话只做一次，而记忆是会被改的（面板增删改、
   * 提取入库、整理合并）。不比较版本号，用户改完记忆要等到会话重启才看得到效果
   * ——注入是记忆唯一的出口，出口关着，改了也白改。
   *
   * 版本号是**全库共享**的（不按 owner 分区）：某个 bot 写入也会让另一个 bot
   * 的会话重注一次。按归属分区的代价是给每个条目追一套版本号并让写路径知道
   * 「这次改的是谁的」，而收益只是省掉少数几次「重注后内容其实没变」的注入；
   * 主 bot 本来就能看见所有子 bot，跨 bot 的重注多数也确有其事。取舍上取简单。
   *
   * 只影响主注入：zh / html / team / todo 四条内置通道投的是静态规范文本，
   * 与记忆内容无关，重注它们纯属浪费 token（HTML 卡片规范一篇就上千字符）。
   */
  const injectedRevisions = new Map<string, number>()

  /**
   * 本轮已经因记忆变更重注过的会话。
   *
   * 模型在一次回复里可能连续调好几次 memory_remember：每次工具调用后都会再走
   * pre-step，若每次都重注，一轮里同一块记忆会重复进上下文 N 遍（cacheRead 也
   * 跟着涨）。一轮只重注一次，剩下的改动合并到下一轮——反正下一轮还会比较版本号。
   */
  const reinjectedThisTurn = new Set<string>()

  /**
   * 每会话的轮次计数（noteTurnStart 递增）。
   *
   * 检索层的「每 N 轮刷新」需要一个轮次来源：pre-step 载荷里没有轮次号
   * （payload 只有 agent / messages / signal），而 turn/start 事件在 index.ts
   * 侧稳定可达，所以在这里自己数——比从 messages 长度猜要可靠。
   */
  const turnCounters = new Map<string, number>()

  /**
   * 每会话检索层的状态：上次刷新时的轮次 / query / 记忆 revision。
   *
   * revision 也必须记：同一轮里模型可能连续写两次记忆，第二次 pre-step 时
   * 「revision 变了」依旧成立；不记住「已经按哪个 revision 刷过」，检索层会在
   * 每个 step 都重检索一次——工具调用越多，重检索越频繁。
   */
  const retrievalStates = new Map<string, { turn: number; query: string; revision: number }>()

  /**
   * 注入可见条目：库 → 可见性 → 过期 → 档案去重。
   *
   * 四道过滤的顺序有讲究：可见性最先（决定「能不能看」），TTL 过期其次
   * （临时信息到点就该消失），档案去重最后（要读 vault，异步且最贵，前面的
   * 过滤已经把候选砍到几十条以内）。
   */
  async function buildVisibleEntries(agent: PreStepAgent): Promise<MemoryEntry[]> {
    const entries = await store.readEntries()
    const hash = workspaceHashOf(agent.session.header)
    /*
     * 可见性按会话身份推导（schema v6）：Work 会话只看 work 自己的，子 Bot 看
     * 自己 + work 全局。主 Bot 的「全部子 Bot」只用于显式检索，不进自动注入
     * （口径见 visibility.ts 模块头）。
     */
    const visibility = visibilityFor(agent.session.id, hash)
    // disabled 条目保留在库与检索中，但绝不参与注入；
    // deprecated 条目（软废弃）同样不参与注入；
    // pending 条目（待确认）也不注入——这正是待确认制的全部意义：自动抽取的东西
    // 在用户点头之前不许进上下文。它仍然在面板里可见、可确认、可拒绝。
    // ttlDays 过期的临时信息同样不注入（见 MemoryEntry.ttlDays）。
    const visible = entries.filter(entry =>
      entry.disabled !== true && entry.deprecated !== true && entry.pending !== true &&
      !isExpired(entry) &&
      visibility.canInject(entry))
    // 档案已覆盖的字段从记忆块里剔掉：两套注入各投一份，内容一旦分叉模型会拿到
    // 互相矛盾的两个值（口径与「为什么不读 vault 的注入文本」见 vault-overlap.ts）。
    return filterCoveredByVault(visible)
  }

  /** 把可见条目分成「稳定层常驻」与「参与检索」两池（两池不重叠）。 */
  function partitionEntries(visible: MemoryEntry[]): { stable: MemoryEntry[]; rest: MemoryEntry[] } {
    const pinned = visible.filter(entry => entry.pinned)
    const identity = visible.filter(entry =>
      entry.scope === 'global' && !entry.pinned && (entry.kind === 'identity' || entry.kind === 'preference'))
    const longterm = visible.filter(entry =>
      entry.layer === 'long' && !entry.pinned && !identity.includes(entry))
    const stable = [...pinned, ...identity, ...longterm]
    const rest = visible.filter(entry => !stable.includes(entry))
    return { stable, rest }
  }

  /**
   * 命中刷新：被注入的条目距上次命中 ≥1 天时加分并重置衰减起点（最多 MAX_HITS 条）。
   *
   * 取哪几条必须按「最久没被命中」排，不能直接拿 selected 的头部：selected 的前缀
   * 是 pinned + identity + longterm（见上），而 pinned 在注入侧另有条数上限，
   * 于是「取前 5 条」永远落在同一批置顶条目上——加分被它们反复吃掉，其余条目
   * 的 lastHitAt 永不刷新，衰减只降不升，越冷越冷。改成 lastHitAt 升序（从未
   * 命中=null 排最前）后，加分在整库范围内轮转，与「命中即有价值」的初衷一致。
   *
   * 用字符串比较而非 Date.parse：lastHitAt 一律是 toISOString() 产出的同格式
   * ISO 串，字典序即时间序；Date.parse 遇到脏数据会给 NaN，让排序变成随机。
   */
  async function refreshHits(selected: MemoryEntry[]): Promise<void> {
    if (selected.length === 0) return
    const hitCandidates = selected
      .filter(entry => entry.lastHitAt === null || daysSince(entry.lastHitAt) >= 1)
      .sort((a, b) => {
        if (a.lastHitAt === b.lastHitAt) return 0
        if (a.lastHitAt === null) return -1
        if (b.lastHitAt === null) return 1
        return a.lastHitAt.localeCompare(b.lastHitAt)
      })
      .slice(0, MAX_HITS_PER_INJECTION)
    if (hitCandidates.length > 0) {
      const hitIds = new Set(hitCandidates.map(entry => entry.id))
      const refreshed = await store.applyHits(hitIds, config.hitBonus)
      logger?.debug?.(`[dsh-memory] hit refresh: ${refreshed} entries`)
    }
  }

  /**
   * 稳定层：置顶 + 全局身份/偏好 + 长期沉淀。
   *
   * 空集返回 null（而不是空文本）：调用方据此决定「要不要追加这条消息」，
   * 两者语义不同——空文本会让历史里多出一条只有引导语的消息。
   */
  async function buildStableBlock(stable: MemoryEntry[]): Promise<{ text: string; sections: Array<{ name: string; text: string }> } | null> {
    if (stable.length === 0) return null
    await refreshHits(stable)
    // 稳定层拿 70% 预算：剩下的留给检索层。稳定层里 pinned 另有 40% 占比上限，
    // 实际很少吃满；而检索层每一条都是按当前话题挑出来的，值得留足空间。
    const budget = Math.max(800, Math.floor(config.injectTokenBudget * STABLE_BUDGET_RATIO))
    return buildInjectionText(stable, { ...config, injectTokenBudget: budget })
  }

  /**
   * 检索层：与当前任务相关的 top-k（稳定层已带上的条目不再重复出现）。
   *
   * 不走 buildInjectionText：那一套按 identity/memory/pinned/facts 四段分桶，
   * 8 条 top-k 会被拆成三小堆、每堆再带一个段头，预算全花在标题上。
   */
  async function buildRetrievalBlock(rest: MemoryEntry[], query: string): Promise<string> {
    if (rest.length === 0) return ''
    const topK = query.trim() === ''
      ? selectInjectionEntries(rest, config.compileThreshold).slice(0, config.injectTopK)
      : searchEntries(query, rest, 'hybrid').slice(0, config.injectTopK).map(match => match.entry)
    if (topK.length === 0) return ''
    await refreshHits(topK)
    const budget = Math.max(600, config.injectTokenBudget - Math.floor(config.injectTokenBudget * STABLE_BUDGET_RATIO))
    return renderEntryLines(topK, budget)
  }

  /**
   * 构建中文记忆块（内置通道）。
   *
   * 与 buildMemoryBlock 的三处刻意差异：
   *  1. 不看 isInjectExcluded —— 项目级「不注入」管的是记忆库整体，不该
   *     顺带掐掉语言契约；
   *  2. 不做检索 top-k —— 中文偏好条目本来就少且全是高 importance，全量带上；
   *  3. 不做命中刷新加分 —— 每会话每轮都注入同一批，刷新会把它顶到封顶，
   *     反而污染主注入的 importance 排序。
   */
  async function buildChineseBlock(agent: PreStepAgent): Promise<string> {
    const entries = await store.readEntries()
    const selected = selectChineseEntries(entries, workspaceHashOf(agent.session.header))
    if (selected.length === 0) return ''
    return buildChineseInjectionText(selected, ZH_INJECTION_BUDGET)
  }

  const preStepListener: MemoryInjector['preStepListener'] = async (payload, next) => {
    let decision: { kind: 'enter'; messages: unknown[] } | { kind: 'reject' }
    try {
      decision = await next()
    } catch (error) {
      // next() 抛错（下游 listener 失败）必须原样上抛，绝不能吞成 { kind: 'reject' }：
      // 宿主收到 reject 只会把 turn/end 记成 { kind: 'blocked' }（该类型没有 error
      // 字段），界面只能显示笼统的「会话状态异常」，真正异常就永远查不到；只有抛出
      // 去，宿主才会记成 { kind: 'error', error: { message, code } } 并显示具体原因。
      // 日志要带 stack：控制台 warn 不进磁盘，appendErrorLog 才是事后排查的依据。
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error && error.stack !== undefined ? `\n${error.stack}` : ''
      logger?.warn?.(`[dsh-memory] pre-step next() failed: ${message}${stack}`)
      void store.appendErrorLog('pre-step', `${message}${stack}`).catch(() => undefined)
      throw error
    }
    if (decision.kind !== 'enter' || payload.signal.aborted) return decision
    const sessionId = payload.agent.session.id
    const hash = workspaceHashOf(payload.agent.session.header)

    // ── 中文记忆内置通道 ──────────────────────────────────────────────
    // 位置是刻意的：在下面两道闸门（项目排除 / 主开关）**之前**求值。这两道
    // 闸门回答的是「记忆库整体要不要进上下文」，而中文通道回答的是「用户的
    // 语言契约是否成立」，两者正交。放在闸门之后，就等于主开关一关中文记忆
    // 跟着消失，那这条通道就没有存在意义了。
    let messages = decision.messages
    // 开关读取必须放在 stepCounters 检查**之后**：isXxxInjectEnabled 内部每次都要
    // readState()（整份 state.json，实测 200KB+ 且无缓存），而下面三条通道都只在
    // 会话首步生效——放在前面等于每个 step 白读 3 次磁盘。「首次进入才读」的语义
    // 不变：一旦本会话进过首步，stepCounters.has() 命中，开关根本不需要求值。
    if (!zhStepCounters.has(sessionId)) {
      const zhEnabled = hostFeatureEnabled('prompt.zh') && await store.isZhInjectEnabled(config.zhInjectDefaultEnabled !== false)
      if (!zhEnabled) {
        logger?.debug?.('[dsh-memory] zh injection off (switch disabled)')
      } else {
        zhStepCounters.set(sessionId, 1)
        try {
          const zhText = await buildChineseBlock(payload.agent)
          if (zhText !== '') {
            messages = [...messages, createUserMessage({
              content: [{ type: 'text', text: `${ZH_INJECTION_RULE}\n\n${zhText}` }],
              source: {
                kind: 'plugin:dsh-memory',
                plugin: 'dsh-memory',
                form: 'snapshot',
                sections: [{ name: '中文偏好记忆', text: zhText }],
              },
            })]
            logger?.debug?.(`[dsh-memory] zh injection ok (${zhText.length} chars)`)
          } else {
            logger?.debug?.('[dsh-memory] zh injection skipped (no chinese entries)')
          }
        } catch (error) {
          // 中文通道失败绝不能影响主注入：记日志后继续往下走。
          logger?.warn?.(`[dsh-memory] zh injection failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    // ── 对话内流程图注入通道已移除（2026-10-09）──────────────────────────
    // 原 ```diagram 围栏要求模型手工算节点坐标与折线点，画歪是常态，且开关默认关、
    // 能力常年闲置。图形结构改由 iu kind 承接（graph 自动布局流程图 / arch 分层
    // 架构图 / sequence 时序图），注入文档随 kind 注册表走 html 卡片通道（默认开）。
    // 渲染器（splitDiagram + DiagramCard）保留：历史消息里的 ```diagram 围栏
    // 必须继续显示成卡片，不能变成一坨 JSON 代码块。

    // ── 对话内 HTML 卡片能力规范注入（内置通道） ──────────────────────
    // 位置刻意：两道闸门之前。它回答的是「本客户端支持什么呈现能力」，
    // 与「记忆库要不要进上下文」正交。iu 的 kind 文档（含图形三件套）也随它注入。
    // 开关读取在 stepCounters 检查之内（理由见上方 zh 通道的注释）。
    if (!htmlStepCounters.has(sessionId)) {
      const htmlEnabled = hostFeatureEnabled('prompt.iu') && await store.isHtmlInjectEnabled(config.htmlInjectDefaultEnabled !== false)
      if (!htmlEnabled) {
        logger?.debug?.('[dsh-memory] html injection off (switch disabled)')
      } else {
        htmlStepCounters.set(sessionId, 1)
        try {
          messages = [...messages, createUserMessage({
            content: [{ type: 'text', text: HTML_INJECTION_RULE }],
            source: {
              kind: 'plugin:dsh-memory',
              plugin: 'dsh-memory',
              form: 'snapshot',
              sections: [{ name: '对话内 HTML 卡片', text: HTML_INJECTION_RULE }],
            },
          })]
          logger?.debug?.('[dsh-memory] html injection ok')
        } catch (error) {
          // 失败绝不能影响主注入与其它通道。
          logger?.warn?.(`[dsh-memory] html injection failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    // ── 团队协作（Agent Teams / 子代理委派）规范注入（内置通道） ────────
    // 位置同 zh / html：两道闸门之前。它回答的是「这活该怎么组织」，
    // 跟「记忆库要不要进上下文」正交；这套纪律跨会话恒定，不该随主开关一起消失。
    // 开关读取在 stepCounters 检查之内（理由见上方 zh 通道的注释）。
    if (!teamStepCounters.has(sessionId)) {
      const teamEnabled = hostFeatureEnabled('prompt.team') && await store.isTeamInjectEnabled(config.teamInjectDefaultEnabled !== false)
      if (!teamEnabled) {
        logger?.debug?.('[dsh-memory] team injection off (switch disabled)')
      } else {
        teamStepCounters.set(sessionId, 1)
        try {
          messages = [...messages, createUserMessage({
            content: [{ type: 'text', text: TEAM_INJECTION_RULE }],
            source: {
              kind: 'plugin:dsh-memory',
              plugin: 'dsh-memory',
              form: 'snapshot',
              sections: [{ name: '团队协作', text: TEAM_INJECTION_RULE }],
            },
          })]
          logger?.debug?.('[dsh-memory] team injection ok')
        } catch (error) {
          // 失败绝不能影响主注入与其它通道。
          logger?.warn?.(`[dsh-memory] team injection failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    // ── 任务清单纪律注入（内置通道） ──────────────────────────────────
    // 位置同 zh / html / team：两道闸门之前。它回答的是「清单怎么列、怎么推进、
    // 怎么收尾」，与「记忆库要不要进上下文」正交，也与 team 通道（回答「这活
    // 怎么组织」）正交。
    // 开关读取在 todoRuleStepCounters 检查之内（理由见上方 zh 通道的注释）。
    if (!todoRuleStepCounters.has(sessionId)) {
      const todoRuleEnabled = hostFeatureEnabled('prompt.todo-rule') && await store.isTodoRuleInjectEnabled(config.todoRuleInjectDefaultEnabled !== false)
      if (!todoRuleEnabled) {
        logger?.debug?.('[dsh-memory] todo-rule injection off (switch disabled)')
      } else {
        todoRuleStepCounters.set(sessionId, 1)
        try {
          messages = [...messages, createUserMessage({
            content: [{ type: 'text', text: TODO_RULE_INJECTION_RULE }],
            source: {
              kind: 'plugin:dsh-memory',
              plugin: 'dsh-memory',
              form: 'snapshot',
              sections: [{ name: '任务清单纪律', text: TODO_RULE_INJECTION_RULE }],
            },
          })]
          logger?.debug?.('[dsh-memory] todo-rule injection ok')
        } catch (error) {
          // 失败绝不能影响主注入与其它通道。
          logger?.warn?.(`[dsh-memory] todo-rule injection failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    // ── 动效技能强制加载注入（内置通道） ────────────────────────────
    // 位置同 zh / html / team / todo-rule：两道闸门之前。它回答的是「遇到动效
    // 任务该先做什么」，与「记忆库要不要进上下文」正交。
    // 开关读取在 stepCounters 检查之内（理由见上方 zh 通道的注释）。
    if (!motionStepCounters.has(sessionId)) {
      const motionEnabled = hostFeatureEnabled('prompt.motion') && await store.isMotionInjectEnabled(config.motionInjectDefaultEnabled !== false)
      if (!motionEnabled) {
        logger?.debug?.('[dsh-memory] motion injection off (switch disabled)')
      } else {
        motionStepCounters.set(sessionId, 1)
        try {
          messages = [...messages, createUserMessage({
            content: [{ type: 'text', text: MOTION_INJECTION_RULE }],
            source: {
              kind: 'plugin:dsh-memory',
              plugin: 'dsh-memory',
              form: 'snapshot',
              sections: [{ name: '动效技能', text: MOTION_INJECTION_RULE }],
            },
          })]
          logger?.debug?.('[dsh-memory] motion injection ok')
        } catch (error) {
          // 失败绝不能影响主注入与其它通道。
          logger?.warn?.(`[dsh-memory] motion injection failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    // ── 通俗解释（ELI5 模式）注入（内置通道） ─────────────────────────
    // 位置同 zh / html / team / todo-rule / motion：两道闸门之前。
    // 它回答的是「解释概念与回答时怎么表达」，与「记忆库要不要进上下文」正交。
    if (!eli5StepCounters.has(sessionId)) {
      const eli5Enabled = hostFeatureEnabled('prompt.eli5') && await store.isEli5InjectEnabled(config.eli5InjectDefaultEnabled !== false)
      if (!eli5Enabled) {
        logger?.debug?.('[dsh-memory] eli5 injection off (switch disabled)')
      } else {
        eli5StepCounters.set(sessionId, 1)
        try {
          messages = [...messages, createUserMessage({
            content: [{ type: 'text', text: ELI5_INJECTION_RULE }],
            source: {
              kind: 'plugin:dsh-memory',
              plugin: 'dsh-memory',
              form: 'snapshot',
              sections: [{ name: '通俗解释', text: ELI5_INJECTION_RULE }],
            },
          })]
          logger?.debug?.('[dsh-memory] eli5 injection ok')
        } catch (error) {
          // 失败绝不能影响主注入与其它通道。
          logger?.warn?.(`[dsh-memory] eli5 injection failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    // 项目注入排除：被排除的工作区里，会话不注入**记忆库条目**（用户在面板
    // 项目上下文条里按项目关闭注入）。判定在会话级开关之前——排除是项目级
    // 硬闸，会话级开关管不到它。注意这不再影响上面已产出的中文块。
    if (hash !== null && await store.isInjectExcluded(hash)) {
      logger?.debug?.(`[dsh-memory] injection skipped (project excluded): ${hash}`)
      return { kind: 'enter', messages }
    }
    // 该会话的记忆注入开关（对话框旁开关控制）：会话里手动开/关优先，
    // 没单独设置过则跟随 config.injectDefaultEnabled（面板「默认开启」）。
    if (!(await store.isInjectEnabled(sessionId, config.injectDefaultEnabled !== false))) {
      return { kind: 'enter', messages }
    }
    // ── 注入分层判定 ────────────────────────────────────────────────
    // 稳定层（置顶/身份/长期）与检索层（当前任务 top-k）各有自己的触发条件，
    // 互不依赖：稳定层看「注入过没有 / 记忆变没变」，检索层看「隔了几轮 / 换没换话题」。
    const injectedRevision = injectedRevisions.get(sessionId)
    const revisionChanged = injectedRevision !== undefined && injectedRevision !== store.revision
    const stableInjected = stepCounters.has(sessionId)
    // 一轮最多重注一次：同一轮里连续写记忆只合并成一次（理由见 reinjectedThisTurn）。
    const needStable = !stableInjected || (revisionChanged && !reinjectedThisTurn.has(sessionId))

    const turnNo = turnCounters.get(sessionId) ?? 0
    const refreshEvery = Math.max(1, Math.round(config.retrievalRefreshTurns ?? 5))
    const retrievalState = retrievalStates.get(sessionId)
    // 检索 query 刻意取 payload.messages（原始）而非已追加中文块的 messages：
    // 否则中文偏好记忆会参与本次任务的相似度检索，等于自己检索自己。
    const query = extractQuery(payload.messages)
    const needRetrieval = retrievalState === undefined
      // 首步跟随稳定层：两者一起构成第一次注入。
      ? needStable
      : store.revision !== retrievalState.revision
        || turnNo - retrievalState.turn >= refreshEvery
        || queryShifted(retrievalState.query, query)

    if (!needStable && !needRetrieval) return { kind: 'enter', messages }
    // 版本号在求值**之前**取：buildStableBlock 内部会 applyHits（它不推进版本号），
    // 但把捕获点放前面，将来新增的写路径也不会造成「刚注入完就被判成过时」。
    const revisionAtInject = store.revision
    if (needStable) {
      stepCounters.set(sessionId, 1)
      if (revisionChanged) {
        // 复用 compaction 的重置路径：只清主注入自己的计数器。四条内置通道投的是
        // 静态规范文本、与记忆内容无关，上下文里那几段也还在，不必跟着重注。
        reinjectedThisTurn.add(sessionId)
        logger?.debug?.(
          `[dsh-memory] re-injected after memory change: ${sessionId} rev ${injectedRevision} -> ${store.revision}`,
        )
      }
    }
    try {
      const visible = await buildVisibleEntries(payload.agent)
      const { stable, rest } = partitionEntries(visible)
      // ── 稳定层 ────────────────────────────────────────────────────
      if (needStable) {
        const block = await buildStableBlock(stable)
        if (block !== null && block.text !== '') {
          // 注入引导：明确记忆属于用户指令/参考，模型应"该执行就执行"；
          // 同时声明两条优先级——
          //  ① 与 AGENTS.md/项目指令/系统提示冲突时，以项目指令为准；
          //  ② 记忆是「记忆」不是实时数据：金额、库存、状态这类会变的事实必须
          //    先查当前源（文件/接口/数据库），直接引用记忆里的旧值会给出过时答案。
          //    这条与 ① 并列而不是塞进 ① 里：它们回答的是两个不同问题（谁优先 /
          //    数据新不新），合成一句模型只会记住前半个。
          const wrapped = [
            SAFETY_RULE,
            '【长期记忆 · 用户要求按需执行或参考】',
            '（若与当前项目的 AGENTS.md / 项目指令或系统提示冲突，一律以项目指令为准；记忆仅作参考与用户偏好补充）',
            '（记忆不是实时数据：涉及会变的事实（金额、库存、状态、价格、进度等）时先查当前源，不要直接引用记忆里的旧值）',
            block.text,
          ].join('\n')
          messages = [...messages, createUserMessage({
            content: [{ type: 'text', text: wrapped }],
            source: {
              kind: 'plugin:dsh-memory',
              plugin: 'dsh-memory',
              form: 'snapshot',
              sections: [{ name: '安全规范', text: SAFETY_RULE }, ...block.sections],
            },
          })]
          logger?.debug?.(`[dsh-memory] stable injection ok (${block.text.length} chars)`)
        }
        // 即使稳定层为空也记下版本号：否则「首步没有常驻记忆」会让每一步都重新
        // 求值一次（每步都读库 + 读档案），直到有内容为止。
        injectedRevisions.set(sessionId, revisionAtInject)
      }
      // ── 检索层 ────────────────────────────────────────────────────
      if (needRetrieval) {
        // **替换**而不是追加：先把历史里所有旧的检索块摘掉，再在末尾放新的。
        // 这样「当前相关记忆」永远只有一份，且位置最靠近本轮；旧块留在历史里
        // 只会让模型分不清哪份是当前的。代价是每刷新一次前缀缓存失效一次——
        // 所以间隔取 5 轮而不是每轮（见 config.retrievalRefreshTurns 注释）。
        const before = messages.length
        messages = messages.filter(message => !isRetrievalBlockMessage(message))
        const removed = before - messages.length
        const retrievalText = await buildRetrievalBlock(rest, query)
        if (retrievalText !== '') {
          messages = [...messages, createUserMessage({
            content: [{
              type: 'text',
              text: `${RETRIEVAL_MARK}\n（以下是按当前对话检索出的记忆条目；记忆不是实时数据，涉及会变的事实先查当前源）\n${retrievalText}`,
            }],
            source: {
              kind: 'plugin:dsh-memory',
              plugin: 'dsh-memory',
              form: 'snapshot',
              sections: [{ name: '相关记忆（检索层）', text: retrievalText }],
            },
          })]
        }
        retrievalStates.set(sessionId, { turn: turnNo, query, revision: store.revision })
        logger?.debug?.(`[dsh-memory] retrieval refreshed: ${sessionId} turn=${turnNo} removed=${removed} chars=${retrievalText.length}`)
      }
      return { kind: 'enter', messages }
    } catch (error) {
      // 注入失败绝不阻塞对话。
      logger?.warn?.(`[dsh-memory] injection failed: ${error instanceof Error ? error.message : String(error)}`)
      // 失败也记下版本号：否则失败一次之后，每一步都会重新尝试（且每步都失败），
      // 日志被刷满而用户什么也看不到。等下一次记忆真正变化再试。
      if (needStable) injectedRevisions.set(sessionId, revisionAtInject)
      return { kind: 'enter', messages }
    }
  }

  return {
    preStepListener,
    noteTurnStart: (sessionId: string) => {
      reinjectedThisTurn.delete(sessionId)
      // 轮次自己数：pre-step 载荷里没有轮次号，而检索层的「每 N 轮刷新」
      // 需要一个可靠来源（见 turnCounters 注释）。
      turnCounters.set(sessionId, (turnCounters.get(sessionId) ?? 0) + 1)
    },
    disposeSession: (sessionId: string) => {
      stepCounters.delete(sessionId)
      zhStepCounters.delete(sessionId)
      htmlStepCounters.delete(sessionId)
      teamStepCounters.delete(sessionId)
      todoRuleStepCounters.delete(sessionId)
      injectedRevisions.delete(sessionId)
      reinjectedThisTurn.delete(sessionId)
      // 检索层状态跟着清：压缩会把注入的那几条消息一起摘要掉（agent/disposed
      // 时更不用说），不清就会出现「以为历史里还有检索块、实际已经没有」——
      // 表现为压缩后的会话再也拿不到相关记忆。轮次计数一并归零，重注后重新计时。
      retrievalStates.delete(sessionId)
      turnCounters.delete(sessionId)
    },
  }
}
