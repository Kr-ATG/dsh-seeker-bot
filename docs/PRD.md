# dsh-seeker-bot · 产品方案（PRD v0.2）

> 目标：在 DeepSeek Harness（DSH）上复刻 **Grok Bot（xAI × Cursor）截至 2026-10-31 已发布的全部能力**，做成一个独立插件。
> 本文 = 功能基线 + 产品设计 + 排期。**可施工的功能实现方案见 `IMPLEMENTATION.md`**，技术架构见 `ARCHITECTURE.md`，可交互原型见 `prototype/index.html`。

---

## 0. 一句话结论

Grok Bot 的创新不是「更好的聊天框」，也不是「云电脑」——云电脑是入场券。
它真正做成的事是：**把 Agent 从一次性会话升级成一支有身份、有记忆、有日程、能互相派活的团队**，
并且用「共享文件系统 + 共享浏览器会话」这种极廉价的方式替代了 A2A 协议。

DSH 内核已经具备 90% 的底座（会话、工具、沙箱、定时、子代理、审批、记忆、MCP、档案），
缺的是**把它们组织成「名册 + 共享电脑 + 日程」的产品层**。

> **dsh-seeker-bot = DSH 的 Bot 操作台（Bot Console）**：不改 DSH 源码，纯插件注入，
> 把 DSH 的 Agent 能力包装成一支可管理的 AI 团队。

---

## 1. Grok Bot 能力基线（14 个模块）

标注：**已发布** = 官方文档明示可用；**灰度** = 官方写明逐步开放；**缺口** = 官方自己没做。
一手证据：`docs.x.ai/grok-bot/*`（28 页）、`cursor.com/docs/grok-bot`、`docs.x.ai/x-subscription/*`。

### M1 Bot 本体

| 能力 | 状态 | 复刻要点 |
|---|---|---|
| 侧栏新建 Bot（+ / Cmd+N），首启自动建一个默认 Bot | 已发布 | 必须有「默认主 Bot」 |
| **主 Bot（primary Bot）**：主动 check-in、协调其他 Bot、可替换 | 已发布 | 这是组织中枢，不是普通成员 |
| 头像三选一：形状+配色 / AI 生成 / 上传（<25MB） | 已发布 | 形状+配色是基线，AI 生成是加分 |
| **岗位不是表单字段**，而是首条消息 + 记忆；个人 Bot 没有 Bot settings 页 | 已发布 | 别做「岗位输入框」当主路径 |
| 共享 Bot 才有 description（About，owner/Manager 可编辑） | 已发布 | 结构化岗位只给共享场景 |
| 标签、改名、置顶、分组 sections、隐藏（隐藏后例程继续跑） | 已发布 | 隐藏 ≠ 暂停 |
| 复制（带 profile/设置/技能/例程/头像，不带历史/记忆/附件） | 已发布 | 只 iPhone 有 |
| 删除（不可撤销，连带记忆/例程/附件） | 已发布 | 要二次确认 |
| **没有「暂停某个 Bot」的开关** | 缺口 | 我们补上：pause 是刚需 |

### M2 持久云电脑

| 能力 | 状态 | 复刻要点 |
|---|---|---|
| 浏览器 + 文件系统 + 终端，合盖继续跑 | 已发布 | DSH 天然具备 |
| **每用户一台机器，每个 Bot 一块屏幕**；单 Bot 同时只跑一个 computer-use 任务 | 已发布 | 别做成「每 Bot 一台」 |
| 浏览器会话/cookie 跨 Bot 共享（登录一次全局可用） | 已发布 | 共享 = 交接零成本 |
| 共享工作区 `/workspace`；node_modules、venv 不保存 | 已发布 | 工作区要有「不持久」清单 |
| 可装软件、可 sudo（企业开关默认开） | 已发布 | DSH 沙箱对应 |
| Update / Recover / Reset 三档，语义不同 | 已发布 | 恢复顺序要写死给用户 |
| 实时看画面 + 随时接管（Take control / I'm done） | 已发布 | 这是「交还人类」的入口 |
| 磁盘将满时主动报告并提议清理（不擅自删） | 已发布 | 小细节，体验分很高 |
| 空闲自动休眠（≠ 删除） | 已发布 | |
| 不支持自托管 / 自带镜像 | 已发布 | |

### M3 记忆

| 能力 | 状态 | 复刻要点 |
|---|---|---|
| 每 Bot 独立记忆：偏好、长期规则、关于你的事实、带日期的「我做过什么」日志 | 已发布 | |
| **Bot 自行决定记什么，不问** | 已发布 | 被动确认会打断心流 |
| 少量事实（姓名、时区）跨所有 Bot 共享 | 已发布 | 全局画像 + 局部记忆 |
| **没有记忆管理界面**，只能对话式查看/纠正/删除 | 已发布 | 三句话完成 CRUD |
| 重置对话保留记忆；删 Bot 才清记忆 | 已发布 | |
| 支持从其他 AI 助手导入记忆 | 已发布 | 迁移钩子 |
| 群聊中各 Bot 记忆互不共享 | 已发布 | |
| 官方立场：记忆不是事实源，重要决策回源核对 | 已发布 | 写进系统提示 |

### M4 技能（Skills）

- **定义**：可复用的「怎么做一件事」的指令集（何时用 / 需要什么输入与权限 / 步骤 / 如何验证 / 返回什么 / 什么要审批）。
- **私有技能是账号级一个库、全体 Bot 共享**——不是挂在 Bot 上。这是复刻关键。
- 调用：按名字问 Bot；`@` 用于 Bot / 群 / 例程 / 应用。
- 团队发布：写 description → Publish → Sync / Copy link / Unpublish。
- **演示教学（Teach a task）**：录浏览器操作最长 10 分钟 → 生成**草稿技能**；不录麦克风。状态：**灰度**。

### M5 例程（Routines）

| 能力 | 状态 |
|---|---|
| 自然语言建例程（「每个工作日 8 点跑…」） | 已发布 |
| 时区 Auto-detect 或指定 | 已发布 |
| 新建不立刻跑，等下一个时间点；有 Test（真执行、耗额度） | 已发布 |
| 触发：Slack（被@/关键词/表情/任意消息）、GitHub、Linear、Sentry、PagerDuty、邮件、Webhook | 已发布 |
| Webhook：POST URL + `Authorization: Bearer <key>`；200 只代表「已接受」 | 已发布 |
| 单 Bot ≤50 个例程、保留最近 20 次运行、间隔 ≥5 分钟 | 已发布 |
| 速率：全体 300 次/小时、单例程 200 次/小时，超限不自动重试 | 已发布 |
| 运行历史 Running / Succeeded / Failed + 原因 | 已发布 |
| 长期离岗会问是否继续跑，无响应则暂停 | 已发布 |
| 官方建议：先自动化「准备」，发送/采购/删除/发布/改生产一律审批 | 已发布 |

### M6 插件 / MCP / 连接器

- **Grok Bot 没有独立插件体系**，继承 Cursor 的连接器策略（「There is no separate Grok Bot connector list」）。
- 连接应用：账号级，装一次全体 Bot 可用；OAuth token 在服务端，Bot 只调工具不拿 token。
- MCP：可自加目录外的 server（按 URL 或按命令），私有网络需批准。
- 官方连接器（从安全页主机白名单反推）：GitHub、X、Origin、Gmail、Google Calendar/Drive/Docs/Sheets/Slides/Ads、Outlook/OneDrive/Teams、Stripe Link、Tailscale、QuickBooks、Workday、WhatsApp Business、Zoho、Notion、Linear、Sentry、PagerDuty、Slack、自有邮箱。
- 官方插件市场：`xai-org/plugin-marketplace`，约 30 个厂商插件，格式 `.grok-plugin/plugin.json`。
- **Intercom / iMessage / Telegram / Discord 不是官方集成**（社区桥而已）。

### M7 多 Bot 协作

| 能力 | 状态 |
|---|---|
| 群聊 2–6 个 Bot；@ 定向；@everyone | 已发布 |
| Bot 间**异步**派活：接收方被唤醒、可稍后回复、交接可见 | 已发布 |
| 群内**不出现**审批卡、密钥卡、邮件/Slack 草稿 | 已发布 |
| Bot→群的消息是纯文本（传图要直发另一个 Bot） | 已发布 |
| **没有「禁止 Bot 互相发消息」的开关**，只能靠指令 + 记忆约束 | 已发布 |
| 群聊里每条回复都计费（含 Bot 间消息） | 已发布 |
| 主 Bot 作为协调者；Bot 可主动建议「给这个岗位建个专职 Bot」 | 已发布 |
| 可把编码任务交给 Cloud Agent，结果文件回传 | 已发布 |

### M8 与 X 的整合

- **@bot 打标**：帖子/回复里 @bot，主 Bot 接单，@bot 只回一句公开确认。
- 传入：你的帖 + 被回复的帖 + 两者引用的帖（含静态图）；**含视频/GIF 则静默不处理**。
- 地区限制：澳、英、欧盟、冰岛、列支敦士登、挪威不可用（按 X 账号登记国判定，VPN 无效）。
- 免登录读公开内容（搜帖、读时间线、查提及、看引用/转发、趋势）。
- X 插件（需开发者 API credits）：DM、书签、首页时间线、谁点赞了你。
- X Chat 内直接对话（灰度）；Tesla 车机语音（灰度）。

### M9 交互界面（最容易被低估）

- 桌面：macOS（Apple silicon + Intel）/ Windows（x64 + Arm64）/ Linux（.deb / .rpm / AppImage）。
- 手机：iOS 18+ / iPadOS 18+ / Android 9+。
- **没有通用 Web 客户端**（只有分享页 pages.grok.bot）。
- Slack：共享 Bot 可 Bring to your team's Slack，有独立 handle；频道里任何人可派活，Bot 代表「谁问的」。
- iPhone 系统级：Siri / Spotlight / 快捷指令 / 灵动岛 / Action Button。
- 让 Bot 用手机 App：日历、通讯录、定位、闹钟、提醒、Home（仅 App 前台 + 仅私聊）。
- 语音：听写（Cmd+D）、实时通话、语音备忘录。
- 通知路由：桌面在用走桌面；需要你输入时约 3 分钟后推手机。
- 37 种桌面语言 / 12 种移动语言；深浅色 + 每 Bot 强调色；多账号。
- 快捷键：Cmd+K 搜索、Shift+F 搜 Bot、Shift+N 建群、1–9 切 Bot、Alt+↑↓ 上下一个 Bot。

### M10 文件、产出物、Pages 与 Library

- 附件：单条 20 个；图片 25MB/张、200MB/条；文档音频 250MB；视频 1GB。
- 产出物要求「可复核」：源链接、截图、时间戳与时区、输入输出文件名、动作日志、明确列出无法验证的部分。
- **Pages**（灰度，Enterprise 不可用）：Bot 造可交互的报告/仪表盘/追踪表，住 Library，可生成公开链接，分享粒度：仅我 / 指定人 Viewer / 团队 / 任何人持链接。
- **Library**：每个 Bot 一个资料库，Today / This week / Older 分组，可 Pin。
- 图片/视频生成：图片 5 种画幅；视频 1–15 秒、480p/720p、最多 14 张参考图。

### M11 计费

- 无独立订阅，随 **The X Subscription**（Free / Plus $8 / Premium $30 / Super $100 / Ultra $200）或 Cursor 套餐附带。
- 额度：**每周共享池**，Grok / Grok Bot / Cursor 共用，不叠加。
- 超额走按需用量或预付额度，可设月度上限；上限不会中途掐断正在跑的任务。
- 试用：7 天窗口 + 用量额度，按 agent 步数与 token 计。
- 模型不可选（「Grok Bot picks the model, there is no model picker」）。

### M12 安全、审批、权限（最该抄的一块）

- **Auto Review**：独立的审查模型，在动作执行前评估（shell / 连接器调用 / computer use / 自动化写入 / 委派），可放行、要求审批或拒绝，默认开启。
- 审批卡三态：Allow once / Always allow（写入 Custom Rules）/ Deny（在你再发消息前不再尝试）。
- 规则上限：Allow automatically 与 Ask first **各 20 条**、每条 ≤1000 字符；冲突时 **Ask first 胜**；满了挤掉最旧并告知。
- 审批过期：聊天内不过期；**后台发起的 30 分钟过期**。
- 凭据三层：Vault（Bot 看不到明文）→ 1Password（逐次批准）→ Secure Form（表单直填，值不进模型）；API key 走掩码密钥卡（只写不可读）。
- 支付：Vault 里的卡结账自动填、不逐次审批；想逐次审批就别存卡。
- 硬件密钥（YubiKey）可选；Linux 不支持。
- 本地电脑执行与云电脑**完全分离的策略**，默认 Ask every time。
- 网络策略（Enterprise）：Allow All / Defaults+Allowlist / Allowlist Only；可覆盖 MCP；约 1 分钟内生效。
- Inference Hooks（beta）：把每次模型请求签名后转发到你的安全服务器，先判定再放行，默认 Shadow。
- Action Recording：记工具调用、决策来源、shell 命令（脱敏）、浏览器导航（去 query）、computer use 动作数；保留 90 天；可 OTel 导出。
- 提示注入防御：外部内容标注不可信；官方承认「reduce, but do not eliminate」。

### M13 团队 / 企业治理

- Teams 默认开；Enterprise 需管理员打开，可按 group 限权。
- 身份复用 Cursor 账号与 SSO；**Bot 没有独立身份**——「A Bot can never hold more access than the person it belongs to」。
- Team Rules 可作用域到 Cursor / Grok Bot / 两者；成员不可关。
- 共享 Bot 角色：Collaborator（能聊）/ Manager（能改指令、技能、记忆、应用）。
- Team Setup Scripts / Team Secrets / 私有网络 / 模板分享管控 / Admin API。

### M14 容易被忽略但很值钱的细节

1. **每个 Bot 有自己的邮箱**：`<name>@mail.grokbot.com`，一次性领取、不可改名删除、永不复用；支持 +alias；可注册服务、收验证码。发信上限 50 收件人。
2. **邮件安全语义**：Bot 把别人的邮件当「信息」而非「指令」，每封标注来自你/来自他人。
3. **草稿优先**：外发默认成草稿（Needs approval）；**例程产生的邮件永远是草稿**，没有无人值守直发。
4. **「谁在代表谁」**：个人 Bot 在 Slack 频道 thread 里不能给别人派活（它不代表任何人）；共享 Bot 代表「提到它的那个人」。
5. 共享 Bot 的计费归属：谁被回答花谁的额度。
6. 隐私模式更严的一方生效：会话跑在独立电脑上。
7. **Bot 模板 ≠ 共享 Bot**：模板是「发一份配置给人复制」；共享 Bot 是「大家聊同一个」。
8. 电脑卡住时的处置顺序写死：Retry → 退出重开 → Update → Recover → Reset。
9. 多团队同机时，两个团队的 Team Secrets 都不下发。
10. 注意力状态：Needs attention / Unread activity / 正在输入。

---

## 2. 产品判断：抄什么、不抄什么

### 必做（缺一条产品就不成立）

1. 账号级持久电脑（浏览器 + 文件 + 终端 + 会话持久 + 空闲休眠 + 三档恢复）
2. Bot 作为持久实体（名字、头像、独立对话、独立记忆、主 Bot 概念）
3. 记忆自动保存 + **对话式管理**（不做面板），并宣告「记忆不是事实源」
4. **技能 = 账号级共享库**，支持从成功任务固化为技能
5. 例程 + 事件触发器 + Test + 运行历史 + 速率限额
6. 审批层：独立审查 + 逐动作卡片 + 用户规则（Ask first 优先）+ 后台 30 分钟过期
7. 凭据不进模型：Vault / Secure Form / 掩码密钥卡三层回退，SSO 与验证码交还人类
8. Bot 间异步派活 + 2–6 人群聊，并把「谁代表谁」写进协议
9. **草稿优先**：外发默认草稿，无人值守路径永不直发

### 加分（决定它像产品还是像 demo）

10. Bot 自带邮箱（+alias、退信/退订处理）
11. 演示教学（录 10 分钟 → 草稿技能）
12. Pages（可交互报告 + 可控分享链接）与 Library（产出物索引）
13. 移动端系统级入口 + 让 Bot 用手机 App
14. 共享 Bot（Collaborator / Manager、独立 Slack app、按被回答者计费）
15. Bot 模板市场 + 团队 Marketplace
16. 企业治理全家桶（SSO/SCIM、Team Rules、Secrets、网络白名单、Inference Hooks、Action Recording）

### 明确不照抄

| 不抄 | 原因 | 我们怎么做 |
|---|---|---|
| 「所有 Bot 共享一台机器且不做 Bot 级隔离」 | 官方自己写成风险（Do not use separate Bots as a security boundary） | 默认每 Bot 独立子工作区 + 凭据作用域 |
| 没有「暂停 Bot」 | 粒度太粗 | 加 pause（暂停 = 不接活、例程可单独保留） |
| 没有记忆导出 / 记忆 API | 企业采购会卡这里 | 提供记忆导出（JSON） |
| 审批卡不显示「下游影响」 | 只给目标与入参 | 卡片里显示「会发给谁、发多少」 |
| Pages 在 Enterprise 不可用 | 企业向产品不该这样切 | 一开始就可用 |

---

## 3. DSH 现有能力映射

| Grok Bot 模块 | DSH 底座 | 缺口（本插件补） |
|---|---|---|
| Bot 身份与会话 | `dsh-session`、`dsh-persona`、会话标题 | 名册、头像、主 Bot、分组/置顶/隐藏、暂停 |
| 共享电脑 | `dsh-fs`、`dsh-pwsh`、`dsh-terminal`、`dsh-computer-use` + `dsh-cua` | 电脑面板（文件/终端/浏览器三视图）、接管、运行中任务 |
| 群聊与交接 | `dsh-experimental-agent-team`（spawn_teammate / send_message / 任务板） | 群聊 UI、@ 路由、交接链可视化、谁代表谁 |
| 技能 | `dsh-skill`（SKILL.md 体系） | 技能卡片管理、账号级共享视图、「从演示学习」捕获 |
| 例程 | `dsh-schedule`（cron / every / daily / weekly / at） | 事件触发、run history、Test、Webhook 入口、限流 |
| 审批 | `dsh-user-approval`、`dsh-experimental-auto-review` | 规则表 UI、三态审批卡、后台过期 |
| 记忆 | 记忆引擎（chat-plus memory 轨） | Bot 维度隔离、对话式 CRUD、导出 |
| 凭据 | vault（加密落盘、不进上下文） | Secure Form 交互、Bot 侧取用、掩码密钥卡 |
| 用量 | `dsh-token-meter`、`dsh-session-stats` | 周额度、按 Bot 拆分、例程消耗 |
| 连接应用 | `dsh-mcp-client` | 应用市场式 UI、安装状态、团队 allowlist |
| 通知 | 浏览器通知 / `dsh-companion` 手机端 | 注意力状态、每 Bot 开关 |
| 邮箱 | 无 | Bot 邮箱（本地 IMAP/SMTP 或接 Agent Mail） |
| Pages / Library | 无 | 产出物索引 + 可分享页面 |

**结论：不造 Agent 内核，只造「产品层 + 数据层 + UI 层」。**

---

## 4. 本插件的产品设计

### 4.1 信息架构

```
Bot Console
├── 名册 Roster        左栏常驻（P0）
├── 会话 Conversation  主区，单聊/群聊共用（P0）
├── 电脑 Computer      右栏：文件 / 终端 / 浏览器（本机）（P0）
├── 日程 Routines      主区 Tab + Bot 详情（P0）
└── 控制台 Console     技能 / 审批 / 用量 / 团队（P1）
```

### 4.2 界面骨架

```
┌──────────────┬───────────────────────────────────┬──────────────────┐
│  Bot 名册     │  ◉ 名字 · 岗位 · 状态   [会话|日程|…]│  共享电脑         │
│              │                                   │  [文件][终端][浏览器]│
│  ▸ 置顶       │  ┌─ 用户消息 ─────────────────┐    │                  │
│   ◉ Chief ★  │  │ 这周把渠道数据拉一下…        │    │  workspace/      │
│   ◉ Scout    │  └────────────────────────────┘    │  ├ reports/      │
│  ▸ 项目 A     │  ┌─ Bot 回合 ─────────────────┐    │  ├ data/         │
│   ◉ Media    │  │ ▸ 工具 7 次  ▸ 浏览器 3 次   │    │  └ notes.md      │
│   ◉ Ledger   │  │ 产出：周报.xlsx · 3 个来源    │    │                  │
│  ▸ 群聊       │  │ [批准并继续][拒绝][先看计划]  │    │  运行中：         │
│   ◉ 周报小组  │  └────────────────────────────┘    │  ● 拉取 CRM       │
│              │  ┌──────────────────────────────┐  │  ● 生成图表       │
│  + 新建 Bot   │  │ 输入 · @ · 附件 · 技能 · 停止 │  │                  │
└──────────────┴───────────────────────────────────┴──────────────────┘
```

### 4.3 关键交互

1. **切换 Bot**：会话、电脑面板、Bot 详情同步切换；未读/需处理状态在打开时清除。
2. **新建 Bot**：名字 → 岗位（写进首条消息与记忆，不是死表单）→ 形状 + 颜色 → 创建即开空会话并引导「先给它一句话的岗位」。
3. **主 Bot**：默认入口，负责 check-in 与协调；可在名册上标记 ★ 并替换。
4. **群聊**：2–6 个 Bot；输入框 `@` 候选；消息按 owner 分色；交接链可见；群内不显示审批/密钥/草稿卡。
5. **日程**：列表 + 详情（Instruction / When to run / Webhook URL+Key / Run history / Test / Pause / Delete）。
6. **审批**：会话内联三态卡（一次性 / 永久 / 拒绝）；控制台里编辑规则表；Ask first 优先；后台 30 分钟过期。
7. **电脑面板**：文件 / 终端 / 浏览器三 Tab；「接管」把画面切成可操作态；运行中任务列表带 Bot 归属。
8. **用量**：顶部小条 + 环形图 + 按 Bot 拆分；显示周额度与按需花费。
9. **注意力状态**：需处理（琥珀）/ 未读（蓝）/ 工作中（绿呼吸）。

### 4.4 Work / Bot 双模式（本次改版核心）

侧栏顶部、**「新会话」按钮上方**加一个 Work / Bot 分段切换：

```
┌─────────────────────────┐
│ 🐳 deepseek  HARNESS  ▥ │   ← 原生 logo 行不动
├─────────────────────────┤
│ [  Work  |  Bot   ]     │   ← 新增：模式切换
├─────────────────────────┤
│      ⊕  新会话           │   ← Work 模式
│      ⊕  新建 Bot         │   ← Bot 模式
├─────────────────────────┤
│  ▾ 工作区 dsh-seeker-bot │   ← Work 模式内容
│    · 设计 Bot 控制台原型  │
│    · Grok Bot 功能调研    │
└─────────────────────────┘
```

切到 Bot 模式时：

1. **原生工作区与会话列表整体收起**，侧栏位置、宽度、边框全部不变；
2. 同一块空间换成 **Bot 名册**（置顶 / 分组 / 群聊）；
3. 「新会话」按钮文案变「新建 Bot」；
4. 主区从普通会话切到 Bot 会话，顶部多出「日程 / 技能 / 审批 / 用量」页签；
5. 右侧栏保留，标题从「工作区」变「共享电脑」。

**设计意图**：不是新增一个并列面板，而是让原生工作区「让位」。用户不需要在两套导航之间来回找，
也不需要记住「Bot 在哪一栏」。切回去，一切照旧。

### 4.5 浏览器 = ego-lite 准实时回显（已实测）

右侧栏的「浏览器」标签不是画的假页面，而是 **ego-lite 的真实回显**：

| 能力 | 行为 |
|---|---|
| 回显 | Bot 正在看的页面投到面板：地址栏、页面内容、滚动位置同步。**实测约 5fps、延迟 ~250ms**（详见 `docs/EGO-LITE-FEASIBILITY.md`） |
| 接管 | 点「接管」直接操作**同一个 ego 窗口**，人与 Bot 的鼠标键盘落在同一会话。点击类操作往返 ~500ms；拖拽/悬停不适用 |
| 登录态 | 存在 ego 里，Bot 全程不接触密码 |
| 多 Bot 分屏 | 每个 Bot 一块屏（对应 Grok Bot 的「每人一屏」），面板顶部标明当前是哪个 Bot |

> 这是本插件与「画一个假浏览器」最大的区别：**回显与操作是同一条链路**，
> 而不是「截图给人看 + 另开一套操作」。

### 4.7 五项新增能力（v1.1）

#### ① 主动找我

Bot 可以按频率主动发起会话，而不是等你问。

| 项 | 设计 |
|---|---|
| 开关 | 每个 Bot 独立 |
| 频率 | 关闭 / 每天 1 次 / 每 4 小时 / 每 2 小时 / 每周 1 次 / 自定义 cron |
| 时段 | 默认 09:00–22:00，避免半夜打扰 |
| 触发条件 | **只在「有值得说的变化」时才发**：新结果、需要你拍板、日程失败、风险信号 |
| 去重 | 同一事件 24h 内不重复提醒；没有新信息就不发 |
| 展示 | 名册上显示「上次主动：今天 09:02」，未读时打蓝点 |

设计原则：**主动 ≠ 骚扰**。宁可少发，也不发「今天没什么事」。

#### ② 对话更积极生成图表与可交互页面

| 项 | 设计 |
|---|---|
| Bot 设置 | 「产出偏好」两个开关：自动生成图表 / 生成可交互页面 |
| 行为 | 开着时，数据类回答直接带图或带可点页面，而不是纯文字描述 |
| 图表卡 | 内联 SVG 折线/柱状/环形，带标题、图例、放大 |
| 交互页卡 | 缩略预览 + 关键指标 + 「打开」按钮（打开 DSH 的 html 沙箱卡） |
| 触发判据 | 出现 ≥3 个可比较的数字、或时间序列、或占比关系 → 出图 |

#### ③ 微信式时间标识

| 项 | 设计 |
|---|---|
| 规则 | 只在**时间变化时**显示一次，不逐条显示 |
| 格式 | 今天 14:23 / 昨天 21:14 / 周三 18:40 / 10月28日 21:05 |
| 位置 | 消息流居中、灰底小标签 |
| 分组阈值 | 跨天必显示；同一天间隔 >5 分钟也显示 |

#### ④ 每个 Bot 独立设置供应商 / 模型 / 推理强度

| 项 | 设计 |
|---|---|
| 位置 | Bot 详情抽屉 → 模型 |
| 字段 | 供应商、模型、推理强度（低/中/高/最高） |
| 生效范围 | 仅该 Bot 的回合 |
| 实现 | 会话级 model override（DSH 的模型选择是 per-session 的） |

#### ⑤ 群聊统一模型（可覆盖）

| 项 | 设计 |
|---|---|
| 默认 | 跟随各自 Bot（各用各的设置） |
| 可切换 | 全组统一：供应商 / 模型 / 推理强度 |
| 优先级 | 群设置 > Bot 设置 |
| 说明 | 群里 UI 明示「当前策略」，避免误以为改的是 Bot 本身 |

### 4.6 与 DSH 原生 UI 的关系

- **不替换**原生对话流：Bot Console 是并列的一层，侧栏新增名册座位，主区新增 Console 路由。
- 会话复用 DSH 原生能力（流式、工具卡、附件、审批），插件只做**外壳与编排**。
- 用户随时可退回原生单会话视图（不锁定）。

---

## 5. 数据模型（插件命名空间 `seeker-bot`）

```ts
Bot {
  id, name, role, label?, description?,     // description 仅共享 Bot
  avatar: { shape: 'whale'|'orbit'|'cube'|'leaf'|'spark'|'ring', color: string },
  instructions,                              // 首条消息固化的岗位与边界，注入系统提示
  primary: boolean,                          // 主 Bot
  sessionIds: string[],
  capabilities: string[],                    // 启用的技能 / 应用 / 工具组
  model?, pinned?, section?, hidden?, paused?,
  notification: boolean,
  memory: { scopes: string[], lastSummarizedAt },
  createdAt, createdBy,
  status: 'idle'|'working'|'needs-you'|'unread'|'paused'
}

Group { id, name, botIds[2..6], ownerPerStage?, createdAt }

Routine {
  id, botId, name, instruction,
  triggers: ({ kind:'schedule', cron, tz } | { kind:'webhook', url, key } |
             { kind:'slack', mode:'mention'|'phrase'|'reaction'|'any', channel?, phrase? } |
             { kind:'github'|'linear'|'sentry'|'pagerduty'|'email', ... })[],
  active, intervalMin, lastRun?, nextRun?,
  runs: Run[]                                 // 保留最近 20 条
}
Run { id, routineId, startedAt, status:'running'|'succeeded'|'failed', reason?, sessionId, usage }

ApprovalRule { id, match: { tool?, action?, domain? }, mode:'ask-first'|'auto', lockedByAdmin? }
UsageDay { date, botId, inputTokens, outputTokens, routineRuns }
```

存储：`~/.dsh/storages/dsh-seeker-bot/` 下原子写 JSON；**只存编排信息**，不复制内核数据
（会话在 DSH 会话存储、技能在 `~/.dsh/skills`、定时在 `dsh-schedule`）。

---

## 6. 里程碑

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **M0 方案与原型** | 本文 + 可交互 HTML 原型 | `docs/` + `prototype/index.html` | 本轮 |
| **M1 骨架** | 双半身插件、名册座位、Bot CRUD、状态持久化 | 可安装的最小插件 | 2–3 天 |
| **M2 会话编排** | 会话绑定、岗位注入、主 Bot、注意力状态、每 Bot 通知 | 单 Bot 可用 | 3–5 天 |
| **M3 共享电脑** | 三视图面板、运行中任务、接管、恢复入口 | 右栏可用 | 3–5 天 |
| **M4 日程** | Routine CRUD、触发器、run history、Test、限流 | 定时/事件驱动可用 | 4–6 天 |
| **M5 群聊** | 多 Bot 同室、@ 路由、交接链、谁代表谁 | 团队协作可用 | 4–6 天 |
| **M6 控制台** | 技能库、审批规则表、用量、记忆导出 | 完整产品 | 5–7 天 |
| **M7 加分项** | Bot 邮箱、演示教学、Pages/Library、模板市场 | 差异化 | 按需 |

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| DSH 客户端槽位/内部 API 变化 | UI 挂不上 | 只依赖公开槽位 + 路由；MutationObserver 兜底 |
| 宿主半身无热重载 | 调试慢 | junction + 重启脚本；核心逻辑抽纯函数便于冒烟 |
| 多 Bot 并发争用工作区 | 文件互相覆盖 | 每 Bot 子目录 + 写作用域声明 + 任务板互斥 |
| 上下文/用量爆炸 | 成本失控 | 按 Bot 预算、例程限流、记忆摘要压缩 |
| 与 chat-plus 座位冲突 | 入口不显示 | 座位 id 前缀 `seeker-`，冲突时降级到设置页入口 |
| 群聊消息计费叠加 | 账单失控 | 群内每条回复计入用量，UI 明示 |

---

## 8. 验收标准（每阶段都要过）

1. 插件可 `dsh plugin add` 安装，重启后侧栏出现「Bot 名册」。
2. 创建 3 个 Bot，切换会话不串上下文，重启后名册与状态完整恢复。
3. 每个 Bot 的岗位描述出现在其系统提示里（可在「系统提示词」页核对）。
4. 一个 routine 能定时触发并写入 run history，Test 可立即跑。
5. 审批卡在会话内可批准/拒绝，规则表生效，Ask first 优先。
6. 群聊里 3 个 Bot 能按 @ 分工，交接链可见，群内不出现审批卡。
7. 冒烟脚本：host 路由断言 + client 产物可加载，二者缺一不可。
