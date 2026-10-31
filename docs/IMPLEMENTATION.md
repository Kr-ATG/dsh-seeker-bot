# dsh-seeker-bot · 功能实现方案（v1.0）

> 这份文档回答一个问题：**每个功能到底怎么真正跑起来**，而不是长什么样。
> 每一项都给出：实现路径 → 依赖 → 接口 → 验收标准 → 降级方案。
> 原型只是外观参考；本文件是可施工的图纸。
>
> 前置实测：
> - ego-lite 回显可行，5fps / 250ms（`EGO-LITE-FEASIBILITY.md`）
> - ego 窗口激活可行：`Page.bringToFront` + `SetForegroundWindow`（本轮实测）
> - DSH 插件契约、槽位、构建（`ARCHITECTURE.md`）

---

## 0. 三条总原则

1. **能复用内核的绝不重写**：会话、工具、沙箱、定时、子代理、审批、记忆、MCP 全部走 DSH 原生；
   插件只做「数据层 + 编排层 + UI 层」。
2. **每个功能必须有降级路径**：拿不到 A 就走 B，绝不让面板白屏。
3. **验收标准写成可执行的命令或可观察的现象**，不写「体验良好」。

---

## 1. 功能可用性矩阵

状态说明：**原生** = DSH 已有能力直接接；**新写** = 插件要实现的代码；**降级** = 做不了完整版，给替代方案。

### 1.1 Bot 本体

| # | 功能 | 状态 | 实现路径 | 验收 |
|---|---|---|---|---|
| A1 | 创建 / 命名 / 头像（形状+颜色） | 新写 | `bots.ts` 内存状态 + `state.json` 原子写；头像 = 6 种 SVG 形状 + 8 色 | 建 3 个 Bot，重启后名字/头像/顺序不变 |
| A2 | 岗位注入 | 原生 | `system-prompt/assemble` 钩子追加身份段（见 §2.3） | 「系统提示词」页能看到该 Bot 的岗位段 |
| A3 | 每 Bot 独立会话 | 原生 | Bot.sessionIds ↔ DSH session；切换 Bot 时切换 session | 两个 Bot 的对话互不串上下文 |
| A4 | 主 Bot | 新写 | `bot.primary` 字段；启动时若无 primary 则把第一个设为 primary | 名册上只有一个 ★，删主 Bot 后自动补位 |
| A5 | 置顶 / 分组 / 隐藏 | 新写 | `pin` / `section` / `hidden` 字段，侧栏按此分组渲染 | 隐藏后侧栏不显示，例程仍在跑 |
| A6 | 暂停 Bot | 新写 | `paused` 字段；暂停时不再接受新任务、例程仍可跑 | 暂停后发消息被拒并提示，恢复后正常 |
| A7 | 复制 Bot | 新写 | 深拷贝 profile/skills/routines，**不**拷贝 sessionIds/memory | 复制出的 Bot 没有历史消息 |
| A8 | 删除 Bot | 新写 | 移除 profile + 解绑 session（不删会话本身）+ 暂停例程 | 删除后名册消失，会话仍在原生列表里 |
| A9 | 注意力状态 | 新写 | 由会话事件推导：有未答提问/待审批→needs；有新回复未读→unread；回合进行中→working | 三态在名册上正确显示并随事件变化 |

### 1.2 会话与协作

| # | 功能 | 状态 | 实现路径 | 验收 |
|---|---|---|---|---|
| B1 | 发消息 / 附件 / @ 提及 | 原生 | 原生会话组件，插件不重写 | 能发图、发文件、@ 出候选 |
| B2 | 工具活动可见 | 原生 | 原生工具卡；插件只加「Bot 归属」标记 | 每个工具卡能看出是哪个 Bot 执行的 |
| B3 | 群聊（2–6 Bot） | 原生 + 新写 | 底层 `agent-team`：spawn_teammate + send_message + 共享任务板；插件做群聊 UI 与会话映射 | 3 个 Bot 在一条会话里按 @ 分工，消息带各自头像 |
| B4 | Bot 间交接 | 原生 + 新写 | `send_message` 异步派活；插件把交接记录渲染成「↳ 交接 · A → B」 | 交接后 B 被唤醒并回复，A 的会话里能看到交接行 |
| B5 | 工作中追加指令 / 停止 | 原生 | 原生 input queue + 中断 | 回合中发消息能重定向；点停止能中断 |

### 1.3 共享电脑

| # | 功能 | 状态 | 实现路径 | 验收 |
|---|---|---|---|---|
| C1 | 文件树 | 原生 | `fs` + `/api/seeker-bot/computer/tree` 读工作区 | 树与真实目录一致，点击能预览 |
| C2 | 终端 | 原生 | `terminal` 会话；面板显示最近输出 | 面板里能看到 Bot 跑过的命令与输出 |
| C3 | **浏览器回显** | 新写（已实测） | FramePump：长驻 `ego-browser nodejs` 循环 `captureScreenshot`，读 stderr → WS → canvas | 面板 5fps 显示 Bot 当前页面，延迟 < 500ms |
| C4 | **点击进入 ego** | 新写（已实测） | `page.cdp('Page.bringToFront')` + Win32 `SetForegroundWindow` + `task.handOff()` | 点画面后 ego 窗口到前台并显示该页；面板转「已交给你在 ego 操作」 |
| C5 | 回到面板 | 新写 | `takeOverTaskSpace(spaceId)` → 重启 FramePump | 点「回到面板」后帧流恢复，ego 交还控制 |
| C6 | 多 Bot 分屏 | 新写 | 一个 task space 内 `task.newPage()` 得 p1/p2/p3，每屏一路 FramePump | 3 个 Bot 各占一屏，切换 Bot 时面板跟着切 |
| C7 | 运行中任务 | 新写 | 订阅会话事件，聚合「哪个 Bot 在跑什么」 | 面板实时列出运行中的工具调用 |
| C8 | 产出物面板 | 原生 + 新写 | 订阅会话的 file/deliverable 事件，按类型（网页/文档/表格/图片）分组；数据源与 DSH 原生产出物同源 | 面板列出该 Bot 生成的文件，点击能打开；数量与原生面板一致 |

### 1.4 班次（Routines）

| # | 功能 | 状态 | 实现路径 | 验收 |
|---|---|---|---|---|
| D1 | 定时触发 | 原生 | 包装 `dsh-schedule`：插件建 routine 时同步创建 schedule | 到点自动跑，结果进该 Bot 会话 |
| D2 | 事件触发（Webhook） | 新写 | host 路由 `POST /webhook/:id/:key` → 校验 key → 触发一次 | curl 打 200 后 Bot 开始干活 |
| D3 | 事件触发（Slack/GitHub…） | 降级 | 无官方 App；用 webhook + MCP 桥接 | 通过 webhook 间接支持 |
| D4 | 运行历史 | 新写 | `routines.json` 记录最近 20 次（Running/Succeeded/Failed + 原因） | 面板显示历史，失败有原因 |
| D5 | Test 立即跑 | 原生 | 直接调一次 routine 的 instruction | 点 Test 后会话里出现结果 |
| D6 | 暂停 / 恢复 | 原生 | 改 schedule 的 enabled | 暂停后不再触发 |
| D7 | 限流 | 新写 | 内存令牌桶：全局 300/h、单例程 200/h、间隔 ≥5min | 超限返回 429 并记录 |
| D8 | 时区 | 原生 | `dsh-schedule` 自带 tz | 设置 Asia/Shanghai 后按本地时间跑 |

### 1.5 技能

| # | 功能 | 状态 | 实现路径 | 验收 |
|---|---|---|---|---|
| E1 | 技能库（账号级共享） | 原生 | 直接读 `~/.dsh/skills`（SKILL.md 体系） | 面板列出全部技能，Bot 都能调用 |
| E2 | 启用 / 停用 | 新写 | 插件维护 enabled 列表，注入时过滤 | 停用后 Bot 不再看到该技能 |
| E3 | 从演示学习 | 降级 | 录一段操作 → 生成 SKILL.md 草稿（MVP：手动编辑） | 生成的 SKILL.md 能被 DSH 识别 |
| E4 | 技能调用 | 原生 | 对话里点名 / `skill` 工具 | Bot 能按名字调用 |

### 1.6 审批

| # | 功能 | 状态 | 实现路径 | 验收 |
|---|---|---|---|---|
| F1 | 审批卡 | 原生 | `dsh-user-approval` 的审批事件 → 会话内联卡 | 有风险动作弹出卡片 |
| F2 | 三态（一次性/永久/拒绝） | 新写 | 卡片按钮 → 写规则表 + 本次放行 | 选「永久」后同类动作不再问 |
| F3 | 规则表 | 原生 + 新写 | 包装 `auto-review` 的规则；插件提供 UI | 规则改动立即生效 |
| F4 | Ask first 优先 | 新写 | 冲突时 ask 覆盖 auto | 同时命中两条规则时停下来问 |
| F5 | 后台审批过期 | 新写 | 非聊天上下文发起的审批 30 分钟过期 | 超时后卡片显示 Expired |
| F6 | 凭据不进模型 | 原生 | vault 已实现（加密落盘、不进上下文） | 模型上下文里看不到密码 |

### 1.7 用量与通知

| # | 功能 | 状态 | 实现路径 | 验收 |
|---|---|---|---|---|
| G1 | 按 Bot 拆用量 | 原生 + 新写 | `token-meter` 的按会话统计 → 按 Bot 聚合 | 面板数字与原生用量页对得上 |
| G2 | 周额度 | 新写 | 本地累计 + 周重置（滚动 7 天） | 跨周自动归零 |
| G3 | 每 Bot 通知 | 新写 | 浏览器 Notification + 专注时抑制 | Bot 完成/等待时弹通知 |
| G4 | 注意力状态同步 | 新写 | 与会话事件总线同源（见 A9） | 与名册一致 |

### 1.8 明确做不了的（不承诺）

| 功能 | 原因 | 替代 |
|---|---|---|
| 云 microVM | DSH 是本地优先 | 本地工作区 + 沙箱 |
| 手机原生 App | 无 App 分发 | `dsh-companion` 手机远程 |
| Slack 双向 | 无官方 Slack App | webhook 触发 |
| X @bot 打标 | 无 X API 授权 | 手动转发链接 |
| 企业治理（SSO/SCIM/审计） | 单机场景 | 本地日志 + 会话导出 |

---

## 2. 关键模块实现详述

### 2.1 数据层（`src/host/state.ts`）

```ts
interface BotState {
  version: 2
  bots: Bot[]
  groups: Group[]
  routines: Routine[]
  rules: ApprovalRule[]
  usage: Record<string, { input: number; output: number; runs: number }>
  ui: { mode: 'work' | 'bot'; lastBotId?: string }
}
```

- 存储：`~/.dsh/storages/dsh-seeker-bot/state.json`
- 写入：内存队列串行 + `write tmp → rename` 原子替换
- 迁移：读到时 `version < 2` 就补字段并备份
- **不存会话内容**：会话在 DSH 自己的存储里，这里只存 `sessionIds`

### 2.2 侧栏双模式（`src/client/roster`）

```ts
// 注入到原生侧栏顶部
const mount = document.querySelector('[data-dsh-sidebar]')  // 具体选择器 M1 实测
createPortal(<ModeSwitch />, mount)

// 切换时
if (mode === 'bot') {
  nativeWorkspace.style.display = 'none'   // 或加 class
  rosterSlot.mount()
} else {
  rosterSlot.unmount()
  nativeWorkspace.style.display = ''
}
```

**M1 必须先做的事**：实测原生侧栏的 DOM 锚点与类名（用 MutationObserver 兜底），
并把结果写进 `ARCHITECTURE.md` §7，避免凭猜写选择器。

### 2.3 岗位注入（`src/host/prompt.ts`）

```ts
ctx.on('system-prompt/assemble', (prompt, c) => {
  const bot = bots.bySession(c.sessionId)
  if (!bot) return prompt
  return [
    prompt,
    '',
    '# 你的身份',
    '你是「' + bot.name + '」，岗位：' + bot.role,
    bot.instructions,
    '记忆不是事实源：关键决策要回源核对。',
    '未经批准不要执行外部写操作（发送、购买、删除、发布）。',
  ].join('\n')
})
```

验收：原生「系统提示词」页能看到这段（chat-plus 的 system-prompt 模块有现成观测口）。

### 2.4 浏览器回显与进入（`src/host/computer/frame-pump.ts`）

**FramePump**

```ts
spawn(EGO_BIN, ['nodejs', '-e', "await import('file:///.../stream.mjs')"])
// stream.mjs 内：
//   const task = await taskSpace('seeker-bot')
//   const page = task.page(label)
//   loop: captureScreenshot(q40) → console.error(JSON) → sleep(200)
// host 读 stderr 行 → 解析 base64 → 广播给 WS 订阅者
```

**点击进入 ego**（本轮实测可行）

```ts
// 1. 切到该页并激活 ego 窗口
await page.cdp('Page.bringToFront')
// 2. Win32 兜底前置（bringToFront 有时不抢焦点）
SetForegroundWindow(egoHwnd)
// 3. 把控制权交给用户
await task.handOff()
// → 之后该 space 的命令会被 ego 暂停（实测：硬停止，不可绕过）
```

**回到面板**

```ts
const task = await takeOverTaskSpace(spaceId)   // 用户点「回到面板」= 明确授权
restartFramePump()
```

**状态机**

```
watching ──点击画面──▶ handed-off ──点回到面板──▶ watching
   │                        │
   └─ ego 未启动 ─▶ disconnected
```

面板文案必须跟着状态走：`观看中 · 5fps` / `已交给你在 ego 操作` / `ego 未连接`。

### 2.5 班次（`src/host/routines.ts`）

```ts
// 创建
const scheduleId = await ctx.schedule.create({ cron, tz, prompt: routine.instruction })
routines.push({ id, botId, scheduleId, triggers, runs: [] })

// webhook
router.post('/webhook/:id/:key', async (req, res) => {
  if (!timingSafeEqual(req.params.key, routine.key)) return res.status(403).end()
  if (!bucket.take(routine.id)) return res.status(429).end()
  await triggerRun(routine, req.body)
  res.json({ ok: true, runId })   // 200 只代表已接受
})
```

限流：令牌桶（全局 300/h、单例程 200/h、最小间隔 5min），超限写一条 failed run。

### 2.6 群聊（`src/host/groups.ts`）

底层用 agent-team：
- 群 = 一个 DSH 会话 + 一组 teammate
- 用户消息 → 按 @ 决定由谁接；没 @ 则由 primary Bot 分派
- Bot 间交接 = `send_message`，插件把交接事件转成会话里的「↳ 交接」行
- **群内不渲染审批卡/密钥卡**（与 Grok Bot 一致）：审批只在 1:1 会话里出现

### 2.7 审批规则（`src/host/approvals.ts`）

- 规则存插件状态，注入 auto-review 的判断链
- 三态按钮：`allow-once` / `always-allow`（写规则）/ `deny`
- Ask first 优先：匹配到 ask 规则直接停，不再看 auto
- 后台来源（例程/webhook）的审批 30 分钟过期

### 2.8 用量（`src/host/usage.ts`）

- 订阅 token 计量事件，按 `sessionId → botId` 归集
- 周窗口：滚动 7 天，每天零点归档
- 面板数字 = 插件累计；与原生用量页做一次对账（验收项）

---

### 2.9 主动找我（`src/host/proactive.ts`）

```ts
// 每个 Bot 一个轻量调度器（不是 routine，独立通道）
interface ProactiveConfig {
  enabled: boolean
  freq: 'off' | 'daily' | '4h' | '2h' | 'weekly' | { cron: string }
  window: { from: '09:00', to: '22:00' }
  lastAt?: number
}
```

**触发链路**

```
定时器（按 freq 起一个 dsh-schedule，或用 setInterval + 窗口判断）
   → 收集「候选事件」：新结果 / 待拍板 / 班次失败 / 风险信号
   → 去重（事件指纹 24h 内只发一次）
   → 无候选 → 静默返回，不写消息
   → 有候选 → 发起一次 Bot 主动回合 → 写进该 Bot 会话 + 推送通知
```

关键约束：

- **没有新信息就不发**（这是防骚扰的核心，不是可选优化）；
- 主动回合的 prompt 固定为「基于以下变化，用三句话告诉我最要紧的一件事」；
- 主动消息在会话里带一个「主动」标记，可一键关闭该 Bot 的主动。

验收：把 freq 设成 1 分钟（测试用），无事件时 10 分钟内不发消息；造一条班次失败后 1 分钟内收到主动消息。

### 2.10 图表与交互页面（`src/client/chat/chart.tsx` + `src/host/output-hint.ts`）

**两条腿**：

1. **提示词侧**：Bot 的产出偏好开启时，系统提示追加：
   ```
   数据类回答优先用图表或可交互页面表达：
   - 出现 ≥3 个可比较数字 / 时间序列 / 占比 → 出图表
   - 需要筛选、切换、下钻 → 出可交互页面
   用约定的 JSON 块描述，不要手写 HTML：
   {"type":"chart","kind":"line","title":"…","series":[…],"labels":[…]}
   {"type":"page","title":"…","stats":[[…]]}
   ```
2. **渲染侧**：客户端把 JSON 块渲染成图表卡 / 页面卡（不信任模型写的 HTML）。

**为什么不让模型直接吐 HTML**：可控、可主题化、可冒烟断言；HTML 只在「页面卡」里作为沙箱内容出现。

验收：让 Bot 分析一组 CSV → 回答里出现图表卡且数值与 CSV 一致。

### 2.11 时间标识（`src/client/chat/time-divider.ts`）

纯渲染层，不涉及数据：

```ts
// 消息按时间排序后，相邻两条的时间差决定是否插入分隔
shouldShow(prev, cur) {
  if (!prev) return true
  if (!sameDay(prev.at, cur.at)) return true          // 跨天
  return cur.at - prev.at > 5 * 60 * 1000              // 同日超 5 分钟
}
format(at) // 今天 HH:mm / 昨天 HH:mm / 周三 HH:mm / M月D日 HH:mm
```

验收：连续三条同分钟消息只显示一个时间标签；跨天后第一条显示「昨天 …」。

### 2.12 模型与推理强度（`src/host/model-prefs.ts`）

| 层级 | 存储 | 生效方式 |
|---|---|---|
| Bot 级 | `bot.model = { provider, model, effort }` | 该 Bot 会话的 model override |
| 群级 | `group.model = { mode:'inherit' } \| { provider, model, effort }` | 群会话的 model override |

**优先级**：群设置（unified）> Bot 设置 > 全局默认。

实现要点：

- DSH 的模型选择是 **per-session** 的（`dsh-client-ui-model-selection`），
  插件在「会话创建 / 切换 Bot / 群设置变更」三个时机写入；
- 推理强度走已有的 `reasoningEfforts` 能力（model-capabilities / provider-hub 已在维护）；
- 群会话统一时，成员的 Bot 设置**不修改**，只在该会话内被覆盖——UI 要明示「本群已统一」。

验收：给 Bot A 设 grok-4 / 高，Bot B 设 deepseek / 低；各自会话的模型标识正确；
群设统一后，群内回合用统一模型，退出群不影响各自 Bot 的设置。

## 3. host 接口清单（最终版）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state?since=rev` | 增量状态 |
| POST/PATCH/DELETE | `/bots[/:id]` | Bot CRUD |
| POST | `/bots/:id/{duplicate,pause,resume,primary}` | 动作 |
| GET/POST | `/groups[/:id/send]` | 群聊 |
| GET/POST/PATCH/DELETE | `/routines[/:id]` | 班次 |
| POST | `/routines/:id/test` | 立即跑 |
| GET | `/routines/:id/runs` | 历史 |
| POST | `/webhook/:id/:key` | 事件入口 |
| GET/PUT | `/rules` | 审批规则 |
| GET | `/usage` | 用量 |
| GET | `/computer/tree` | 文件树 |
| GET | `/computer/tasks` | 运行中任务 |
| WS | `/browser/stream?bot=` | 帧流 |
| POST | `/browser/focus` | 点击进入 ego |
| POST | `/browser/resume` | 回到面板 |

工具（给 agent 用）：`seeker_bot_create`、`seeker_bot_list`、`seeker_routine_create`、`seeker_usage`。

---

## 4. 分阶段交付（每阶段独立可验收）

| 阶段 | 交付 | 验收（可执行） | 预估 |
|---|---|---|---|
| **M1 骨架** | 双半身插件 + 名册座位 + Bot CRUD + 持久化 | 装插件重启 → 侧栏出现名册；建 3 个 Bot 重启后还在；`node scripts/smoke-host.mjs` 通过 | 2–3 天 |
| **M2 会话** | 岗位注入 + 会话绑定 + 注意力状态 | 两 Bot 对话不串；系统提示词页能看到岗位；名册三态正确 | 2–3 天 |
| **M3 电脑** | FramePump + 点击进入 ego + 文件树 + 运行中任务 | 面板 5fps 出画面；点击后 ego 前台显示该页；回到面板帧流恢复 | 3–4 天 |
| **M4 班次** | Routine CRUD + schedule 包装 + webhook + 限流 + 历史 | 定时到点跑；curl webhook 返回 200 且会话出现结果；超限 429 | 3–4 天 |
| **M5 群聊** | 群会话 + @ 路由 + 交接可视化 | 3 Bot 同室按 @ 分工，交接行可见，群内无审批卡 | 3–5 天 |
| **M6 控制台** | 技能库 + 审批规则表 + 用量 + 通知 | 规则改动立即生效；用量与原生对账一致；通知能弹 | 3–4 天 |
| **M7 加分** | Bot 邮箱、演示教学、Library | 按需 | — |

---

## 5. 风险与降级

| 风险 | 降级 |
|---|---|
| ego 未启动 | 面板显示「未连接」+ 一键启动；不阻塞其他功能 |
| FramePump 起不来 | 退回单次截图轮询（1.5fps），面板标「降级」 |
| 原生侧栏 DOM 变化 | MutationObserver 兜底；再不行退到「独立路由页」 |
| 槽位冲突 | 座位 id 前缀 `seeker-`；冲突则降级到设置页入口 |
| schedule 精度 | 最小间隔 5 分钟，短于此用 webhook |
| agent-team 不可用 | 群聊降级为「串行接力」（A 说完 @ B） |

---

## 6. 总验收清单

```powershell
# 构建 + 冒烟
node build.mjs
node scripts/smoke-host.mjs
node scripts/smoke-client.mjs
# 已安装位置复验
cd $env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-seeker-bot
node scripts/smoke-host.mjs
```

手动验收（按顺序，全过才算「功能可用」）：

1. 装插件重启 → 侧栏出现 Work/Bot 切换，Bot 模式显示名册
2. 建 3 个 Bot（不同形状颜色），重启 DSH → 名册与头像不变
3. 给 Bot A 发消息，Bot B 的会话不受影响
4. 「系统提示词」页能看到 Bot A 的岗位段
5. 打开右栏浏览器 → 5fps 出画面；点画面 → ego 窗口前台显示该页；点回到面板 → 帧流恢复
6. 建一个 1 分钟后的 routine → 到点自动跑，结果进会话，历史有记录
7. curl webhook → 200，会话出现结果
8. 触发一次外部写操作 → 会话内出现审批卡 → 点批准 → 动作执行
9. 群聊 3 个 Bot → @ 分工正确，交接行可见
10. 用量面板数字与原生用量页一致
