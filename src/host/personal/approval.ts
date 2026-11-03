/**
 * Personal Agent 的审批通道：把宿主的 `approval/request` 接到前端卡片上。
 *
 * ## 为什么需要它
 *
 * bot 的权限档位只有 `full` / `approval` 两档。选 `approval` 时，宿主会在敏感
 * 工具调用前向「应答者」要一个决定——但改造前**没有任何应答者**：宿主的
 * `dsh-user-approval` 明确写着「没有最终应答者时，请求解析为 unavailable 并以
 * 拒绝方式关闭」。也就是说审批模式的 bot 实际上什么都干不了，用户还看不到为什么。
 *
 * 这里补上那个应答者：把请求变成对话里的一张卡片，用户点「允许这次」或「拒绝」，
 * 结果回给宿主，工具照常执行或被拒。
 *
 * ## 生命周期
 *
 *   agent 要调敏感工具
 *     → 宿主发 `approval/request`（waterfall）
 *     → 先查 always-allow 规则（命中 allow 直接放行，命中 ask 强制询问）
 *     → 否则 publish 一条 `kind: 'approval'` 的消息（带按钮）并挂起
 *     → 用户点击 → 前端 POST /approval/decide
 *     → resolve 成 allowed-once / rejected
 *     → 宿主继续或拒绝该工具调用
 *
 * ## 规则系统（路线图 3.2）
 *
 * 对应 Grok Bot 的 Allow once / Always allow / Custom Rules。规则落在
 * `~/.dsh/storages/dsh-seeker-bot/personal-agent/approval-rules.json`：
 *
 *   { id, match, decision: 'allow' | 'ask', createdAt, risk? }
 *
 * · `match` 是工具名的 glob（`*` 通配，大小写不敏感）；写成 `工具名:原因片段`
 *   时连原因一起匹配，用于「只放行这个具体动作」；
 * · `ask` 优先级高于 `allow`——用户显式说过「这个永远问我」，就不能被别的
 *   宽泛 allow 规则盖掉（安全侧默认）；
 * · 带 `risk` 的规则只对同类风险生效，让「不可撤销操作永远问我」能表达。
 *
 * ## 风险标签（3.2）
 *
 * `irreversible`（不可撤销）/ `security`（改安全设置）/ `external`（外发数据）。
 * 宿主传下来的审批请求里**没有**这个字段（`dsh-user-approval` 只有 toolName /
 * reason / signal），所以这里按工具名 + 原因做一次推断兜底；调用方也能显式传
 * （`requestApproval(..., { risk })`），显式值优先。
 *
 * ## 超时策略（3.2）
 *
 * 旧实现一律 5 分钟超时。问题是「聊天里发起」和「后台跑 routine」是两种场景：
 * 聊天里用户可能去开会了，5 分钟就悄悄取消，回来后发现操作没执行；后台任务
 * 则不能无限挂着占住会话。所以按来源分开：
 *
 * · 聊天内（chat）——**不过期**，靠「停止」按钮（abort signal）兜底；
 * · 后台（routine / proactive）——30 分钟过期。
 *
 * 来源靠 AsyncLocalStorage 传递，而不是模块级布尔标志：聊天轮次与后台轮次可能
 * 并发，全局标志会把用户刚发起的审批误判成后台、半小时后悄悄过期。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { publish } from './events.ts'
import { botRoomOf } from './room-context.ts'
import type { BotMessage } from './agent.ts'

/** 宿主的结算词汇（见 @deepseek-ai/dsh-user-approval 的 types）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * 用户可选的审批决定。
 *
 * `allowed-always` 不是宿主的词汇——它的语义是「写一条 always-allow 规则，
 * 本次仍按 allowed-once 结算」。放在这里是为了让 /approval/decide 的入参
 * 与前端按钮 id 一一对应。
 */
export type ApprovalChoice = ApprovalOutcome | 'allowed-always'

/** 审批卡上的风险标签（对应 Grok 的警告标签）。 */
export type ApprovalRisk = 'irreversible' | 'security' | 'external'

/** 规则的两种口径：自动放行 / 强制询问（Custom Rules）。 */
export type ApprovalRuleDecision = 'allow' | 'ask'

/** 一条 always-allow / ask-first 规则。 */
export interface ApprovalRule {
  id: string
  /** 工具名 glob；含 `:` 时匹配 `工具名:原因片段`。 */
  match: string
  decision: ApprovalRuleDecision
  createdAt: number
  /** 只对这类风险生效（缺省 = 不限）。 */
  risk?: ApprovalRisk
}

/** 审批从哪来：聊天内不过期，后台 30 分钟过期。 */
export type ApprovalSource = 'chat' | 'background'

/** 聊天内审批的超时：0 = 不过期（Grok 的口径，用户去开会也不该被悄悄取消）。 */
const CHAT_TIMEOUT_MS = 0

/** 后台审批的超时：例行任务不能无限占着会话。 */
const BACKGROUND_TIMEOUT_MS = 30 * 60_000

/** 规则条数上限（Custom Rules 的「各设上限」）。超出淘汰最旧，防止无限堆积。 */
const MAX_RULES = 50

/** 风险标签的中文文案（卡片里显示给用户看）。 */
const RISK_LABELS: Record<ApprovalRisk, string> = {
  irreversible: '不可撤销',
  security: '改安全设置',
  external: '外发数据',
}

/**
 * 风险推断规则表。
 *
 * 顺序即优先级：不可撤销排第一——它一旦发生就找不回来，比「改了安全设置」
 * 和「把数据发出去」更需要用户停下来看一眼。
 */
const RISK_PATTERNS: ReadonlyArray<{ risk: ApprovalRisk; pattern: RegExp }> = [
  {
    risk: 'irreversible',
    pattern: /(delete|remove|unlink|rmdir|\brm\b|truncate|overwrite|format|destroy|drop|wipe|purge|清空|删除|覆盖|重置|销毁|抹除|格式化)/i,
  },
  {
    risk: 'security',
    pattern: /(permission|credential|secret|password|passwd|token|api[_-]?key|sudo|chmod|chown|\bssh\b|oauth|auth|权限|凭据|密钥|令牌|密码|安全|授权)/i,
  },
  {
    risk: 'external',
    pattern: /(https?|fetch|upload|download|send|email|mail|webhook|publish|外发|发送|上传|下载|邮件|推送|发布)/i,
  },
]

interface PendingApproval {
  botId: string
  message: BotMessage
  /** 命中 always-allow 时要落规则，所以工具名与风险必须随挂起项一起留住。 */
  toolName: string
  risk?: ApprovalRisk
  settle: (outcome: ApprovalOutcome, label?: string) => void
}

const pending = new Map<string, PendingApproval>()

/** 已注册应答者的 sessionId：避免 agent 重建时重复注册。 */
const installedSessions = new Set<string>()

/** 当前审批来源（AsyncLocalStorage：并发聊天 / 后台轮次不会串台）。 */
const approvalSourceStore = new AsyncLocalStorage<ApprovalSource>()

/**
 * 把一个后台轮次（routine / proactive）包成「后台来源」。
 *
 * 只在 scheduler.ts 里用：它调 `runBotTurn` 时，这一轮里发生的审批都会带上
 * background 来源，从而套用 30 分钟超时。
 */
export function runAsBackgroundApproval<T>(fn: () => Promise<T>): Promise<T> {
  return approvalSourceStore.run('background', fn)
}

/** 当前上下文属于哪种审批来源（缺省 chat）。 */
export function currentApprovalSource(): ApprovalSource {
  return approvalSourceStore.getStore() ?? 'chat'
}

/* ───────────────────────── 规则存储 ───────────────────────── */

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 规则文件路径（插件状态目录，与 routines.json 同级）。 */
export function approvalRulesFile(): string {
  return join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent', 'approval-rules.json')
}

/**
 * 读规则；文件不存在 / 损坏一律返回空数组。
 *
 * 规则是「少一层摩擦」的增强项：读不出来最坏是每次都弹审批卡，绝不能因为
 * 一个坏 JSON 让审批通道整体失效（那会让审批档位的 bot 什么都干不了）。
 */
export function readApprovalRules(): ApprovalRule[] {
  try {
    const file = approvalRulesFile()
    if (!existsSync(file)) return []
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is ApprovalRule => {
      if (item === null || typeof item !== 'object') return false
      const record = item as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.match !== 'string') return false
      if (record.decision !== 'allow' && record.decision !== 'ask') return false
      return true
    })
  } catch {
    return []
  }
}

/** 全量写回（调用方负责串行；宿主侧审批是低频操作，不做锁）。 */
export function writeApprovalRules(rules: ApprovalRule[]): void {
  const file = approvalRulesFile()
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(rules, null, 2), 'utf8')
  } catch (error) {
    // 落盘失败只留日志：内存里这一轮的匹配仍然生效（下一次写入会重试）
    console.warn('[personal-agent] 审批规则写入失败:', error instanceof Error ? error.message : error)
  }
}

/**
 * 加一条规则。
 *
 * 去重口径是 `match + decision + risk` 三元组：用户重复点「以后都允许」不该
 * 在文件里堆出十条一模一样的规则（匹配时还要多扫一遍）。
 *
 * @returns 落库后的规则（已存在时返回那条，`createdAt` 保持原值）。
 */
export function addApprovalRule(input: {
  match: string
  decision?: ApprovalRuleDecision
  risk?: ApprovalRisk
}): ApprovalRule | null {
  const match = String(input.match ?? '').trim()
  if (match === '') return null
  const decision: ApprovalRuleDecision = input.decision === 'ask' ? 'ask' : 'allow'
  const risk = input.risk
  const rules = readApprovalRules()
  const existing = rules.find((rule) => rule.match === match && rule.decision === decision && rule.risk === risk)
  if (existing !== undefined) return existing

  const rule: ApprovalRule = {
    id: `ar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    match,
    decision,
    createdAt: Date.now(),
    ...(risk !== undefined ? { risk } : {}),
  }
  rules.push(rule)
  // 超出上限淘汰最旧：规则是便利设施，不能无限增长到拖慢每次审批
  while (rules.length > MAX_RULES) {
    let oldestIndex = 0
    for (let index = 1; index < rules.length; index += 1) {
      if (rules[index].createdAt < rules[oldestIndex].createdAt) oldestIndex = index
    }
    rules.splice(oldestIndex, 1)
  }
  writeApprovalRules(rules)
  return rule
}

/** 删一条规则；返回是否真的删掉了。 */
export function removeApprovalRule(id: string): boolean {
  const target = String(id ?? '').trim()
  if (target === '') return false
  const rules = readApprovalRules()
  const kept = rules.filter((rule) => rule.id !== target)
  if (kept.length === rules.length) return false
  writeApprovalRules(kept)
  return true
}

/* ───────────────────────── 规则匹配与风险推断 ───────────────────────── */

/** 把 glob（只认 `*`）编译成锚定的正则；非法输入返回 null（按不匹配处理）。 */
function globToRegExp(pattern: string): RegExp | null {
  try {
    const escaped = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(`^${escaped}$`, 'i')
  } catch {
    return null
  }
}

/** 一条规则是否命中这次审批。 */
function ruleMatches(rule: ApprovalRule, toolName: string, reason: string): boolean {
  const pattern = rule.match.trim()
  if (pattern === '') return false
  // 带冒号 = 连原因一起匹配（`pwsh:rm -rf`）；否则只匹配工具名
  const subject = pattern.includes(':') ? `${toolName}:${reason}` : toolName
  const regex = globToRegExp(pattern)
  return regex !== null && regex.test(subject)
}

/**
 * 找命中这次审批的规则。
 *
 * 多条命中时：`ask` 优先于 `allow`（安全侧默认），同类里取最新创建的那条
 * （用户最近一次表达的意思最可信）。
 */
export function matchApprovalRule(toolName: string, reason: string, risk?: ApprovalRisk): ApprovalRule | undefined {
  const candidates = readApprovalRules().filter((rule) => {
    if (rule.risk !== undefined && rule.risk !== risk) return false
    return ruleMatches(rule, toolName, reason)
  })
  if (candidates.length === 0) return undefined
  const ask = candidates.find((rule) => rule.decision === 'ask')
  if (ask !== undefined) return ask
  return [...candidates].sort((a, b) => b.createdAt - a.createdAt)[0]
}

/**
 * 按工具名 + 原因推断风险标签（调用方没显式传时兜底）。
 *
 * 为什么要有兜底：宿主的 `approval/request` 只带 toolName / reason，没有风险
 * 字段。不推断的话卡片上永远是「无标签」，用户看不出「这一步删了就没法撤销」。
 */
export function inferApprovalRisk(toolName: string, reason: string): ApprovalRisk | undefined {
  const subject = `${toolName} ${reason}`
  for (const entry of RISK_PATTERNS) {
    if (entry.pattern.test(subject)) return entry.risk
  }
  return undefined
}

/** 风险标签的中文文案。 */
export function riskLabel(risk: ApprovalRisk): string {
  return RISK_LABELS[risk] ?? risk
}

/* ───────────────────────── 审批卡 ───────────────────────── */

/**
 * 构造审批卡片的消息体（纯函数，便于测试）。
 *
 * **只出一个 interactive 块**（和问答卡同一套结构）：卡片自带标题 + 正文 + 按钮，
 * 外面再挂一段 text 会变成「文字浮在卡片上」的双层结构。
 *
 * 风险标签写进 prompt 文本（老前端也能看到），同时作为可选字段挂在 block 上
 * （新前端可以据此加图标 / 颜色）。未知字段对老前端是无害的——它只读
 * `ui.options` 渲染按钮。
 *
 * @param options.allowAlways 是否出「以后都允许」按钮。**默认关闭**，原因见
 *   {@link requestApproval} 的注释：现有前端把非 `allow` 的按钮值一律映射成
 *   `deny`，在它改成按 option.id 回传之前，直接出第三个按钮会让用户点
 *   「以后都允许」却把操作拒掉。
 */
export function buildApprovalMessage(
  approvalId: string,
  toolName: string,
  reason: string,
  displayReason?: Record<string, string>,
  options?: { risk?: ApprovalRisk; allowAlways?: boolean },
): BotMessage {
  const localized = displayReason?.zh ?? displayReason?.en ?? ''
  const detail = reason !== '' ? reason : localized
  const head = detail !== ''
    ? `要执行「${toolName}」：${detail}`
    : `要执行「${toolName}」，这一步需要你确认。`
  const risk = options?.risk
  const riskLine = risk !== undefined ? `\n⚠️ 风险：${riskLabel(risk)}` : ''
  const choices = [
    { id: 'allow', label: '允许这次' },
    ...(options?.allowAlways === true ? [{ id: 'allow-always', label: '以后都允许' }] : []),
    { id: 'deny', label: '拒绝' },
  ]
  return {
    id: `apmsg-${approvalId}`,
    kind: 'approval',
    blocks: [
      {
        type: 'interactive',
        prompt: `${head}${riskLine}\n\n确认后才会继续。`,
        ui: {
          kind: 'buttons',
          title: risk !== undefined ? `待确认 · ${riskLabel(risk)}` : '待确认',
          options: choices,
        },
        // 可选字段：老前端忽略，新前端据此渲染风险徽标
        ...(risk !== undefined ? { risk } : {}),
      },
    ],
    at: Date.now(),
  }
}

/**
 * 发起一次审批：推一张卡片给前端，然后挂起等用户决定。
 *
 * 返回 Promise 而不是回调，是因为宿主的 seam 就是 `Promise<ApprovalOutcome>`；
 * 挂起期间 agent 那一轮会一直等着（这正是「审批」的语义）。
 *
 * ## 关于「以后都允许」按钮
 *
 * 前端 `store.tsx` 目前把按钮值映射成 `value === 'allow' ? 'allow' : 'deny'`，
 * 即**任何非 allow 的按钮都会回传 deny**。所以这里默认不出这个按钮：在
 * 前端改成按 `option.id` 回传之前，出它等于给用户挖一个「点允许却被拒绝」的坑。
 * 能力已经完整（`/approval/decide` 接受 `allow-always`、规则匹配直接放行），
 * 前端改一行即可打开。
 *
 * @param options.risk 显式风险标签（缺省按工具名 + 原因推断）。
 * @param options.allowAlways 是否出「以后都允许」按钮（缺省 false，见上）。
 * @param options.source 审批来源（缺省读 AsyncLocalStorage，再缺省 chat）。
 */
export function requestApproval(
  botId: string,
  toolName: string,
  reason: string,
  signal?: AbortSignal,
  displayReason?: Record<string, string>,
  options?: { risk?: ApprovalRisk; allowAlways?: boolean; source?: ApprovalSource },
): Promise<ApprovalOutcome> {
  const approvalId = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const risk = options?.risk ?? inferApprovalRisk(toolName, reason)
  const source = options?.source ?? currentApprovalSource()
  const message = buildApprovalMessage(approvalId, toolName, reason, displayReason, {
    ...(risk !== undefined ? { risk } : {}),
    allowAlways: options?.allowAlways === true,
  })
  /*
   * 带上所属群：本卡是宿主异步发的，不带 roomId 会被前端归到该 Bot 的私聊，
   * 群里那个回复气泡就一直转圈。展开写法而不是 `roomId: undefined`，私聊回合
   * 才会真的不带这个键。
   */
  const roomId = botRoomOf(botId)
  publish(botId, { type: 'message', message, source: 'approval', ...(roomId !== undefined ? { roomId } : {}) })

  return new Promise<ApprovalOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: ApprovalOutcome, label?: string): void => {
      if (settled) return
      settled = true
      pending.delete(approvalId)
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      /*
       * 把卡片标成已决定：不改的话用户会看到一个还在闪的按钮组，不知道
       * 自己刚才那一下到底生效没有。
       */
      const resultText = label ?? (outcome === 'allowed-once'
        ? '已允许这次'
        : outcome === 'rejected'
          ? '已拒绝'
          : '已取消（超时或中止）')
      const decided: BotMessage = {
        ...message,
        blocks: message.blocks.map((block) => (
          block.type === 'interactive'
            ? { ...block, submitted: true, result: resultText }
            : block
        )),
        at: Date.now(),
      }
      // 更新也必须带同一个 roomId：否则前端找不到原来那张卡，点完按钮还是转圈
      publish(botId, { type: 'message-update', message: decided, source: 'approval', ...(roomId !== undefined ? { roomId } : {}) })
      resolve(outcome)
    }
    /*
     * 超时按来源分开：聊天内不过期（用户去开会不该让操作悄悄消失），
     * 后台 30 分钟（routine 不能无限占着会话）。
     */
    const timeoutMs = source === 'background' ? BACKGROUND_TIMEOUT_MS : CHAT_TIMEOUT_MS
    const timer: NodeJS.Timeout | undefined = timeoutMs > 0
      ? setTimeout(() => finish('cancelled'), timeoutMs)
      : undefined
    // 不把 Node 事件循环钉住（宿主常驻时无所谓，测试会退不出去）
    timer?.unref?.()
    const onAbort = (): void => finish('cancelled')
    signal?.addEventListener?.('abort', onAbort)
    pending.set(approvalId, { botId, message, toolName, ...(risk !== undefined ? { risk } : {}), settle: finish })
    /*
     * 挂起项登记完之后再补一次「已经中止」检查：宿主的 signal 可能在审批卡
     * 发出去之前就已经 abort 了（上一轮被取消 / 超时）。不检查的话这次审批会
     * 永远挂着——聊天内审批刻意没有超时兜底，漏掉这个检查就是永久卡死。
     */
    if (signal?.aborted === true) finish('cancelled')
  })
}

/**
 * 用户做出决定。
 *
 * `allowed-always` 会先落一条 always-allow 规则，再把本次按 allowed-once 结算：
 * 本次操作本来就要执行，规则只影响**以后**的同类审批。
 *
 * @returns 是否命中一个仍在挂起的审批（false = 已超时 / 已取消 / id 不对）。
 */
export function decideApproval(approvalId: string, choice: ApprovalChoice): boolean {
  const entry = pending.get(approvalId)
  if (entry === undefined) return false
  if (choice === 'allowed-always') {
    addApprovalRule({
      match: entry.toolName,
      decision: 'allow',
      ...(entry.risk !== undefined ? { risk: entry.risk } : {}),
    })
    entry.settle('allowed-once', '已允许（以后同类操作自动放行）')
    return true
  }
  entry.settle(choice)
  return true
}

/** 当前挂起的审批数（诊断用）。 */
export function pendingApprovalCount(): number {
  return pending.size
}

/**
 * 把审批应答者挂上。
 *
 * ## 为什么注册在 root ctx 且必须 prepend
 *
 * 和问答通道同一个原因：宿主的 `typertGateway` 会在同一条 waterfall 上把请求转成
 * Remote 事件发给浏览器（Work 模式里那张官方审批卡就是这么来的）。插件加载得晚，
 * 普通注册排在它后面就永远抢不到——表现是审批卡长在 Work 界面、Bot 里只剩转圈。
 *
 * 注册在 root ctx（scope 不受限）+ `prepend` 排最前 + 按 sessionId 认领自己的 bot。
 */
export function installBotApproval(rootCtx: any, sessionId: string, botId: string): void {
  if (typeof rootCtx?.on !== 'function') return
  if (installedSessions.has(sessionId)) return
  try {
    rootCtx.on('approval/request', async (req: any, next: () => Promise<ApprovalOutcome>) => {
      // 不是这个 bot 的请求：交还给 gateway / 别的 bot 的应答者
      if (String(req?.agent?.session?.id ?? '') !== sessionId) return next()
      /*
       * 不调 next()：我们是这个 bot 的最终应答者。委托出去要么落到 Work 的官方 UI
       * （Bot 模式下看不见），要么落到「没有应答者 → unavailable → 拒绝」，
       * 等于把审批功能做成静默失败。
       */
      const toolName = String(req?.toolName ?? '工具')
      const reason = String(req?.reason ?? '')
      const risk = inferApprovalRisk(toolName, reason)
      /*
       * 规则先于卡片：命中 always-allow 就直接放行，用户不会再被同一类操作
       * 反复打断（这正是「规则系统」存在的意义）。命中 ask 则继续走卡片——
       * 用户显式要求过「这个永远问我」，不能被宽泛的 allow 规则盖掉。
       */
      const rule = matchApprovalRule(toolName, reason, risk)
      if (rule !== undefined && rule.decision === 'allow') return 'allowed-once'
      return requestApproval(
        botId,
        toolName,
        reason,
        req?.signal,
        req?.displayReason,
        { ...(risk !== undefined ? { risk } : {}) },
      )
    }, {
      // prepend：抢在 typertGateway 之前；global：绕过 context filter，保证收到
      prepend: true,
      global: true,
    })
    installedSessions.add(sessionId)
  } catch (error) {
    console.warn('[personal-agent] 审批应答者注册失败（审批模式的 Bot 会拒绝所有敏感操作）:', error instanceof Error ? error.message : error)
  }
}

/** 测试用：暴露内部实现。 */
export const approvalTest = {
  approvalRulesFile,
  readApprovalRules,
  writeApprovalRules,
  addApprovalRule,
  removeApprovalRule,
  matchApprovalRule,
  inferApprovalRisk,
  riskLabel,
  buildApprovalMessage,
  requestApproval,
  decideApproval,
  pendingApprovalCount,
  runAsBackgroundApproval,
  currentApprovalSource,
  CHAT_TIMEOUT_MS,
  BACKGROUND_TIMEOUT_MS,
}
