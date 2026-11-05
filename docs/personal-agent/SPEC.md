# Personal Agent · 开发契约（v1）

> ## ⚠️ v3 变更摘要（2026-11-02 晚，右栏与设置重构）
>
> - **右栏只剩三块**：浏览器（Bot 工作空间回显）+ 产出物卡 + 任务记录卡；
>   详情 / 资料库 / 电脑三个 tab 与全部旧内容删除。
> - **所有 Bot / 群聊设置改为右侧滑出卡片**：`BotSettingsCard`（基本资料 / 模型 /
>   语音 / 权限 / 主动询问 / 例行任务 / 子 Bot 管理 / 记忆 / 产出物文件夹）、
>   `GroupSettings`（群名 / 模型策略 / 成员 / 删除）、侧栏底部全局设置卡。
> - **产出物按 Bot 分文件夹**：`<bot 工作区>/产出物/<botFolder>/<分类>/`，固定 9 类；
>   host 新增 `GET /api/personal-agent/outputs` 扫描接口，收口时自动归档工具产物。
> - **任务记录**：每个用户回合一条 `TaskRecord`（`AppState.tasks`），自动生成主题；
>   右栏任务卡点开后是左右分栏详情（左任务名称、右执行时间线）。
> - 共享契约文件：`_tmp/personal-agent-v3-contract.md`（实现时对齐用，可删）。

> ## ⚠️ v2 变更摘要（2026-11-02，读本文件前先看这里）
>
> 下面这份 v1 契约描述的是「界面复刻 + 前端持有一切」的形态，**运行时部分已经过时**。
> 现实现以 README 的「Personal Agent」章与代码注释为准，关键差异：
>
> | 方面 | v1（本文件） | 现在 |
> |---|---|---|
> | 消息 | 一条回复 = 一条 `Message`，text 块强制合并 | 多消息：host 按模型说话次数切分，`message` / `message-update` 两个事件 |
> | 消息类别 | 无 | `progress` / `finding` / `need-input` / `approval` / `final`，后三档由 `bot_emit` 工具声明 |
> | 记忆 | 前端 `state.memories`（localStorage） | 宿主记忆引擎，schema v6 带 `owner`（`work` / `bot:<id>`），子 Bot 隔离、主 Bot 跨库 |
> | 例行任务 | 前端 `window.setInterval` 30 秒 | 宿主常驻调度器（`src/host/personal/scheduler.ts`），页面关掉照跑 |
> | 主动询问 | 前端按钮 + 前端定时 | 宿主调度（窗口内随机取点）+ `POST /proactive/run` |
> | 推送 | 无（只有 POST 响应内的 SSE） | `GET /events` 常驻 SSE + `server-messages.json` 离线补发 |
> | 审批 | 只有 `full` / `approval` 两档，无 UI | `approval/request` 应答者 → 对话内卡片 → `POST /approval/decide` |
> | 状态权威源 | localStorage `pa:state:v1` 全部 | 记忆 / 例行任务 / 主动询问 / 服务端消息的权威副本在宿主 |
> | 宿主会话隔离 | 无（Bot 不落 DSH 会话） | 每个 Bot 是 `pa-bot-v2-<botId>` 宿主会话；创建时带 `origin: 'subagent'`，官方 Work 的会话列表 / 搜索用 `sessionVisible()` 排除；旧会话用 `scripts/migrate-bot-session-origin.mjs` 迁移 |
>
> 新增的宿主文件：`events.ts`（事件总线）、`scheduler.ts`（调度）、`approval.ts`（审批）。
> 新增的测试：`scripts/test-memory-owner.mjs`，以及 `test-personal-agent.mjs` 里的
> 多消息 / bot_emit / 例行任务 / 审批四组断言。

本文件是「Personal agent」界面复刻 + 功能实现的唯一事实来源。所有模块按本契约并行开发，
不得擅自改共享类型 / 类名 / 数据键。

## 1. 产品定位

在 `dsh-seeker-bot` 插件内新增完整的 Personal Agent 模式（Bot 模式）：点击侧栏顶部
`Work | Bot` 切换器进入。Bot 模式是一个**全屏自绘应用**（overlay，覆盖整个 DSH Web 视口）：

```
┌──────────────────────────────────────────────────────────────────────┐
│  左侧栏 280px（可收起 64px）  │  聊天主区 flex:1        │  右栏 300px     │
│  - 品牌行（鲸鱼 + wordmark + 收起）│ - 会话头（头像/名称/角色/呼叫）│ - bot 头像/名 │
│  - Work/Bot 切换器            │  - 消息流（微信式）      │  - tabs 详情/资料库/电脑 │
│  - 主 bot（大号 + 右下角 +）  │  - 交互卡 / 通话卡       │  - 任务/例行任务/记忆 │
│  - 子 bot 分组列表            │  - 输入框 + 语音麦克风    │  - 关闭按钮            │
│  - 群聊分组                  │                        │  - 通话收起条（顶部）    │
│  - 底部：日记 / 设置          │                        │                        │
└──────────────────────────────────────────────────────────────────────┘
```

> 2026-11-02 调整：侧栏顶部改成与 Work 模式官方侧栏一致的品牌行（鲸鱼 mark +
> deepseek wordmark + HARNESS 徽标 + 收起按钮），侧栏因此也能像 Work 一样收起成
> 64px 图标轨道；新建入口（「+」）从顶部挪到主 Bot 卡片右下角。

参考素材：`_tmp/probe/ref-*.png`（从用户截图裁出）、`_tmp/probe/ref-top.png`、
`_tmp/probe/ref-right.png`、`_tmp/probe/ref-call.png`、第二张素材 `Work|Bot` 分段控件。
深色主题为基准，同时支持 DSH 亮色主题：根节点使用 `data-pa-theme="dark|light"`，
默认「跟随 DSH」（读 `body[data-ds-dark-theme]` / body 实际底色 / 系统配色），设置里可强制深/浅。
所有组件样式使用 `--pa-*` token，亮色覆盖挂在 `.pa-root[data-pa-theme='light']` 下。

**初始状态（2026-11-01 用户要求）**：首次进入只有主 Bot；不再预置演示子 Bot / 群聊 /
消息 / 记忆 / 例行任务 / 期刊。旧版 localStorage 由 `store.tsx` 的 `normalizeState`
迁移清理，只保留主 Bot 与用户自己创建的内容。

## 2. 文件边界（禁止跨边界写）

| 作用域 | 路径 | 负责人 |
| --- | --- | --- |
| 共享类型/store/引擎/图标/基座样式 | `src/client/personal/types.ts`, `store.tsx`, `engine.ts`, `icons.tsx`, `base.css.ts`, `index.tsx` | Lead |
| 左侧栏 / 右栏 / 新建 Bot / 群聊设置 | `src/client/personal/shell/*.tsx`, `shell.css.ts` | 队友 A |
| 聊天主区 / 消息 / 交互卡 / 输入框 | `src/client/personal/chat/*.tsx`, `chat.css.ts` | 队友 B |
| 通话弹窗 / 通话卡 / 全双工实时语音 | `src/client/personal/call/*`（`realtime-client.ts` 连接层、`realtime-audio.ts` 采集播放）、`src/shared/realtime-protocol.ts` | 队友 A/B |
| 期刊日记 / 阅读器 / 记忆与任务面板 | `src/client/personal/journal/*.tsx`, `journal.css.ts` | 队友 C |
| Host API / 持久化 / LLM/实时语音/生图 | `src/host/personal/*.ts`、`src/host/personal/realtime/*` | Lead |
| 集成入口 / 构建 | `src/client/index.ts`, `src/client/mode-switch/index.ts`, `src/host.ts` | Lead |

## 3. 共享类型

见 `src/client/personal/types.ts`，核心约束：

- `Bot.avatar.shape ∈ blob | whale | cat | orbit | leaf | spark | ring`
- `Message.blocks` 是块数组，支持 `text | task | interactive | call | journal | voice`
- 所有时间都是毫秒时间戳；所有 id 是短随机串
- 状态持久化键：`pa:state:v1`（localStorage，前端）

## 4. 状态 API（`store.tsx` 导出）

```ts
const { state, ui, actions } = usePersonal()
// state: AppState
// ui: { selectedBotId, selectedRoomId, view, call, rightPanelOpen, ... }
actions.selectBot(id)
actions.selectRoom(id)
actions.sendMessage(text: string, opts?: { botId?, roomId?, via?: 'chat'|'call' })
actions.createBot(input: NewBotInput): Promise<Bot>
actions.updateBot(id, patch)
actions.deleteBot(id)
actions.setBotEnabled(id, enabled)
actions.moveBot(id, groupId)
actions.createGroup(name)
actions.renameGroup(id, name)
actions.deleteGroup(id)
actions.createRoom(name, memberIds)
actions.updateRoom(id, patch)
actions.deleteRoom(id)
actions.answerInteractive(messageId, value)
actions.addMemory(botId, text, tags?)
actions.deleteMemory(id)
actions.searchMemories(botId, query)  // 主 bot 传 isMain 可搜全部
actions.createRoutine(routine)
actions.toggleRoutine(id)
actions.runRoutine(id)
actions.deleteRoutine(id)
actions.proactiveNow(botId)
actions.generateJournal(botId, opts?)
actions.runJournalCheck(nowOverride?: number)
actions.startCall(botId)
actions.endCall()
actions.callUserTurn(text)
actions.toggleJournal() / openJournal(id)
```

## 5. 视觉规范（唯一基准）

### 5.1 颜色（深色）

```css
--pa-bg: #141517;            /* 应用底 */
--pa-sidebar: #17181a;       /* 左侧栏 */
--pa-main: #151618;          /* 聊天区 */
--pa-right: var(--pa-sidebar); /* 右栏：与左栏同一块面，不另给近似值 */
--pa-card: #202124;          /* 卡片/输入框 */
--pa-card-2: #26272a;        /* 卡片 hover / 选中行 */
--pa-card-3: #2d2e32;        /* 用户气泡 */
--pa-line: rgba(255,255,255,.06);
--pa-line-2: rgba(255,255,255,.10);
--pa-text: #f2f3f5;
--pa-text-2: #a7abb2;
--pa-text-3: #73777f;
--pa-text-4: #55585f;
--pa-accent: #ff9f0a;        /* 在线点 / 主强调橙 */
--pa-blue: #0a84ff;
--pa-red: #ff453a;
--pa-green: #30d158;
```

### 5.2 尺寸/圆角/字号

- 左侧栏 280px（与 Work 模式官方侧栏同宽；可收起成 64px 图标轨道），右栏 300px；中缝 1px `--pa-line`
- 侧栏左右内边距 12px；行高 44px；分组标题 11px/500 letter-spacing .04em
- 主 bot 头像 48px（按参考图实测；SPEC 早期写 56px，以 48px 为准），子 bot 头像 34px，右栏头像 64px
- 圆角：卡片 12px，输入框 14px，气泡 18px（右下 6px），弹窗 16px，分段控件 13px
- 字号：**全部跟随官方「设置 → 通用 → 字号大小」**（2026-11-03 用户要求「BOT 模式下的
  所有字体与字号跟随通用设置」）。`.pa-root` 的 `--pa-font-size` 直接取
  `--dsh-content-font-size`（10–22px，默认 14），`font-size` 就是它 —— 14px 档下正文
  等于 14px，与 Work 正文同档。其余档位相对 **13px 标定线**用
  `--pa-font-delta: calc(var(--pa-font-size) - 13px)` 整体平移：标题 15px + delta、
  正文 13px + delta、摘要 11px + delta、小标签 10px + delta、按钮 12px + delta，
  字号与行高成对出现（`line-height: calc(Npx + var(--pa-font-delta))`），
  不许出现裸 px 的 `font-size`（smoke-client 有断言）。
  注：标定线原先在 14px，通用 14px 时正文只有 13px，比 Work 小一号，切模式肉眼可见。
- 字体：继承 `--dsw-font-family`（官方在 body 上把「界面字体」写入的
  `--dsh-font-family-text` 解析成它），兜底
  `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`。
  例外两处：代码与终端走等宽（`--ds-font-family-code`）、期刊日记标题走衬线
  （Georgia / 宋体，杂志排版）。
- 阴影：浮层 `0 18px 60px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06)`
- 动效：消息 `pa-rise` 260ms cubic-bezier(.2,.8,.2,1)；弹窗 `pa-pop` 180ms；列表选中 120ms

### 5.3 图标

全部内联 SVG（`icons.tsx`），stroke 1.7，圆角端点，尺寸 16/18/20。
禁止 emoji 当图标（头像里的眼睛除外）。

## 6. 组件契约

### 6.1 Sidebar（队友 A）

- 品牌行：与 Work 模式官方侧栏一致 —— 鲸鱼 mark（24 高）+ deepseek wordmark
  （含 HARNESS 徽标）+ 右侧 28×28 收起按钮。素材直接内联官方 FishLogo /
  BrandWordmark（`shell/brand-svg.ts`），不拿系统字体近似字形。
  dsh-shell 内顶部有 320×44 的窗口拖拽区（`-webkit-app-region: drag`），正好压住
  收起按钮的上半截。**不加高品牌行**（加高会让它比 Work 模式低一大截、上方多出
  一条空隙），改为给按钮向下补一块透明热区（y44 以下可点），视觉与浏览器里一致。
- 收起态：64px 图标轨道（主 Bot 头像 + 子 Bot 头像 + 群聊 + 底部期刊/设置图标），
  顶部鲸鱼 mark 就是展开按钮；状态存 `pa:ui:v1` 的 `sidebarCollapsed`，刷新保持。
- 新建入口：主 Bot 卡片右下角的「+」（28px 圆形，常驻），点击弹出「添加 Bot /
  添加群聊」两项菜单。2026-11-02 前它在顶栏右侧，随品牌行改造一起下移。
- `SegmentedMode`：Work / Bot，272×42 胶囊，选中块 #0a0a0b 圆角 11px；Bot 时高亮
- 主 bot：56px blob 头像 + 名称 14px/600 + 橙色在线点；点击进入主 bot 会话
- 子 bot 列表：按 `groups` 渲染；每条 = 34px 彩色 blob 头像 + 名称 13px/600 + 角色 11px/灰 +
  最近消息摘要 11px/截断；选中态整行 `--pa-card-2` 圆角 10px；未读数徽标
- 群聊分组：群头像（成员头像叠加）+ 名称 + `N 个 Bot · 群聊`
- 底部：`期刊日记` / `设置` 两个按钮
- 右键/悬浮 `...` 菜单：编辑、移动分组、暂停、删除（主 bot 才显示管理项）
- 「+」菜单 →「添加 Bot」打开 NewBotModal（队友 A 负责）；「添加群聊」打开 NewRoomModal

### 6.2 RightPanel（v3）

- **只保留**：BotEcho（浏览器工作空间回显）→ 通话收起条（若最小化）→ 极简顶栏
  （Bot 名 / 角色 + 关闭右栏）→ `BotOutputsCard` → `TaskRecordCard`。
- 旧的详情 / 资料库 / 电脑三个 tab 与其中的任务卡、模型、音色、权限、主动询问、
  例行任务、子 Bot 管理、记忆、文件树、终端全部删除。
- 设置入口迁到 `BotSettingsCard`（右侧滑出卡）；任务详情在 `TaskDetailModal`
  （左右分栏）；产出物扫描见 host `src/host/personal/outputs.ts`。

### 6.3 NewBotModal（队友 A）

- 弹窗 560px，标题「新建 Bot」；头部 = 机器人图标 + 标题 + 一句说明，底部固定操作区
- 字段：名字（可选，占位「例如：调研助手」）；角色或简介 textarea（占位「描述它擅长什么、怎么跟你配合…」）
- 随机选项：4 个建议卡片（2×2，点击填入 textarea），右上「换一批」
- 通话设置：音色 / 供应商两列下拉（均可选）
- 底部：取消 / 创建 Bot
- 未填角色 → 自动选一个随机选项作为角色并真实创建；创建后 bot 主动发首条消息（store 处理）
- 创建中禁用按钮+转圈

### 6.3b NewRoomModal（队友 A）

- 弹窗 560px，标题「新建群聊」；头部 = 群聊图标 + 标题 + 一句说明
- 群聊名称输入（留空 = 「新群聊」）
- 成员选择：行式列表（头像 + 名称 + 角色），支持全选 / 清空；标题右侧显示「已选 N / 总数」
- 底部：取消 / 创建群聊；没有成员时禁用并给红字提示

### 6.4 ChatPanel（队友 B）

- Header：44px 头像 + 名称 15px/600 + 副标题（角色）11px 灰 + 右侧「呼叫」电话图标（必有）、「更多」
- 消息流：日期/时间系统分隔条居中胶囊；bot 消息左侧（头像 32px + 名称小字 + 内容），用户消息右侧
  深灰蓝气泡；bot 文本无气泡（纯文本块）或浅卡（取决于 block 类型）；进入动画 `pa-rise`
- blocks：
  - text：Markdown 轻量渲染（加粗、列表、行内代码、换行）
  - task：可折叠任务卡（标题 + 状态 + 步骤，点击展开）
  - interactive：卡片含按钮组 / 单选 / 表单；点击后立即显示已选状态，并调用 `actions.answerInteractive`
  - call-segment：语音通话折叠条（**不是卡**：两条发丝线夹一行小字，点击收起/展开整段）
  - call：旧版通话记录卡（仅历史数据，新通话不再产生）
  - journal：期刊卡（封面缩略图 + 标题 + 打开）
- 输入框：附件按钮 + textarea（多行输入、自动增高；上限与 Work 模式的对话框同源，336px）+ 麦克风（MediaRecorder → 16k 单声道 WAV →
  `ctx.remote.speech.transcribe`，与 Work 模式同一条 SenseVoice ASR；转写填入输入框，确认后发送）
- 输入框上方支持 `@` 提及与快捷 chip；群聊里 `@名字` 是**结构化点名**（只叫被点名的），
  判定规则见 6.7.1。注意：目前只有「手动插入 `@名字`」这一条路径，输入 `@` 弹出的成员选择层尚未实现
- 空会话展示 bot 主动打招呼与 3 个建议 chip

### 6.4.1 回复形态（Bot ≠ Work）

Bot 复用宿主的 agent loop，但输出形态必须按**对话**设计，不能是工作台报告：

- 正文 1–3 句、最多两小段；不用加粗伪标题、多级清单、表格、代码块；不贴路径 / 命令 / 参数
  （用户明确要求「详细说 / 报告 / 清单 / 代码 / 文档」时才展开）。
- 工具过程不进正文：`MessageBlockView` 默认不渲染 `tool` 块（`generate_image` 例外）。
  例外这条对 **PTC 子调用**同样成立：Bot 会话挂 `ptc` preset，生图 / 生视频多半发生在
  `run_code` 里（`tools.generate_image(...)`），宿主只发 `tool/ptc-dispatch-start` /
  `tool/ptc-dispatch`，**不发** `tool/call` / `tool/result`。host 侧必须把这两条事件翻译成
  与原生调用同构的工具块（id 用 `subCallId`），否则点阵占位与图片都不会进对话流
  （2026-11-03 修复，回归见 `scripts/test-personal-ptc-image.mjs`）。
- 文档生成的点阵占位**不靠关键词猜**（用户明确要求「不要猜的，必须命中」）：
  模型动手前调 `document_progress`（format + title）声明，生成完调 `phase="done"` 收起；
  漏调时由宿主 `watchDocumentOutputs()` 监听 bot 工作区里刚写出的文档文件兜底
  （扩展名白名单 + mtime 5 秒内），因此「真的在生成文档」一定有点阵、「只是读文档」不会误报。
- 每个 Bot 的 agent 作用域要摘掉 Work 专属提示段：`team:policy`、
  `ui:deliverable-file-references`、`app:web-surface`、`harness:source`。实现见
  `src/host/personal/agent.ts` 的 `trimWorkOnlyPrompt()`（全局段同名空覆盖 +
  `system-prompt/assemble` waterfall 过滤 agent 作用域段）。
- 契约文本在 `buildBotPrompt()`；`/reply` 的 chat 降级路径必须用同一份措辞。

### 6.4.2 交互卡与连接器推荐（选项消息）

两种「正文即卡片」的形态，外层都**不再套气泡**（`chat.css.ts` 里 `.pa-msg--need-input` /
`.pa-msg--connector-suggest` 各自把 `.pa-msg__content` 的 padding 归零并收窄宽度）：

- **选项卡** `blocks: [{ type: 'interactive', ui: { kind: 'options', … } }]`（消息 `kind: 'need-input'`）
  - 每个选项是虚线圆角卡片（1px dashed `--pa-line-2` / 10px 圆角 / 12px 14px 内边距）；
    hover 转实线；选中转 1.5px 实线 `--pa-text` + 玻璃底 + **右侧**实心圆勾。
    左侧没有 radio 圆点——单选是「点一下即提交」，那个圆点表达不了中间态。
  - `allowCustom: true` 时列表末尾追加「其他（自己输入）」虚线框，点开就地展开
    无边框输入框 + 发送；单选输入完即提交，多选只记为一项、仍走「确认选择」。
  - 提交后**保留清单**：选中项亮勾、其余压暗（`data-locked`），下方再给一行「已提交」。
    整卡收成一个小绿框会让用户没法回看自己挑了哪个；`buttons`（审批 / 确认）仍走旧形态。
- **连接器推荐卡** `blocks: [{ type: 'connectors', title?, items: [{ id, name, description?, icon?, installed? }] }]`
  （消息 `kind: 'connector-suggest'`）
  - 一行一个应用：30×30 图标（宿主路由 `/api/chat-flow/mcp-icons/<iconFile>`，失败回落
    名称首字母）+ 名称 + 一句说明 + 右侧箭头；`installed` 显示「已连接」并降透明度。
  - 点任意一行 → `openWorkbench('connectors')` 打开连接器市场，并把该行标成「已打开」。
    推荐不是提问，所以**不挂起、不回传模型**。
  - 数据来自 `assets/mcp-catalog/catalog.json`，host 侧用 `findCatalogEntries(ids)` 取条目；
    模型通过 `bot_emit(connectors: [...])` 触发（最多 4 条，未知 id 静默丢弃，全查不到就不发卡）。
    系统提示词里已写明「邮件 / 日程 / 文档 / 设计稿类需求且未连上时主动推荐，不要为推荐而推荐」。

### 6.5 CallOverlay（全双工实时语音）

- 打开：全屏遮罩 + 居中 360px 通话面板（主题跟随 DSH，深浅两套；头像 88px、名字、状态/计时、波纹环）
- 控件：静音、视频（禁用）、挂断（红）；最小化只在右上角，控制栏不重复
- 通话音量：**居中胶囊**（喇叭图标 + 细轨道 + 百分比），只调下行播放增益；拖到 0 显示「静音」。
  轨道**单色无填充**（用户要求「音量条里面的颜色去掉」）：音量只由滑块位置与数值表达
- 麦克风电平：**7 个圆点的点阵**（正弦相位、中间最活跃），静止时是一排 40% 透明度的安静小点；
  不再用 25 根竖条频谱（用户反馈「丑陋，要简约又优雅」后整块重做）
- **没有文字输入框**：底部「不方便说话时，也可以打字…」+ 发送按钮已移除（横跨整宽、与
  居中胶囊不协调）。麦克风不可用时只提示重试 / 挂断；`callUserTurn` 与宿主 text 帧保留
- 「最小化」按钮：收起后 `ui.call.minimized = true`，右栏顶部出现通话条，点击恢复
- **转写实时进对话流**（不是挂断后才生成一张卡）：
  - 通话开始时先写一条**段标记消息**（`blocks: [{ type: 'call-segment', segment, live: true }]`，
    该消息本身**不带** `Message.callSegment`）；
  - 每轮定稿（用户 ASR / Bot 转写 final / 打字 / 挂断前最后一句）落一条普通消息
    （`source: 'call'` + `callSegment`），按落库序号 `seq` 插位而非追加（ASR 异步迟到时
    否则会变成「Bot 先答、用户后问」）；
  - 语音里让 Bot 干活产生的产物同样落进这段：图片 → `image` 块，视频/音频/文件 →
    `tool` 块的 `run.artifacts`（复用产出物卡通道）；
  - `endCall` 只更新段标记（`endedAt`/`durationMs`/`turns`/`live:false`），**不再**写
    `{ type: 'call' }` 旧通话卡；一句没说成时整条删掉。
- **收起/展开**：`actions.toggleCallSegment(segment)` 增删 `ui.collapsedCallSegments`（不持久化）。
  折叠条（`MessageBlockView` 的 `CallSegmentBar`）是两条发丝线夹一行小字，不是卡片；
  收起只跳过段内消息的渲染，展开后仍是普通气泡——**不换样式**。
  历史数据里的 `{ type: 'call' }` 块继续由 `CallMessageCard` 渲染（仅兼容）。
- 通话界面内同时显示双向实时转写（弹层里的一路，与对话流那一路并存）
- 状态三态：`listening`（在听）/ `thinking`（在想）/ `speaking`（在说），由服务端 VAD 与
  `response.created` / `response.done` 驱动；思考过程（`response.thinking.delta`）可折叠展示
- 链路（**取代了原来的半双工「录音 → ASR → 模型 → Edge TTS」**）：
  麦克风 24 kHz 单声道 PCM16 每 40 ms 一片 → 同源 WebSocket `/api/personal-agent/realtime`
  （二进制帧，裸 PCM16）→ 宿主代理注入 `Authorization` 并转发到 StepFun Realtime API →
  下行 `response.audio.delta`（base64 PCM16 24 kHz）→ 浏览器 `PcmPlayer` 串接播放。
- 打断：收到 `speech_started` 立刻 `player.interrupt()` 清空播放队列（本地立即静音），
  宿主侧在确有响应在跑时补一发 `response.cancel`。
- 失败时给出可读提示，绝不再静默返回固定假回复；缺凭据 / 上游 401 这类不可重试错误必须
  原样告诉用户。（打字通道 `conversation.item.create` + `response.create` 仍在宿主侧保留，
  但通话界面已不提供输入框，见上方「没有文字输入框」。）
- 协议契约：`src/shared/realtime-protocol.ts`（两端共享，只放常量与类型）。
- 宿主实现：`src/host/personal/realtime/`（`ws-frame` 帧编解码 / `upstream` 上游客户端 /
  `session` 事件翻译 / `index` 会话编排 / `mount` cordis 适配，前四个不依赖框架、可离线测试）。

### 6.5.1 文字朗读（TTS：把回复气泡念出来）

- **入口 1（手动）**：Bot 消息气泡侧边、引用按钮**之后**一枚喇叭按钮（`IconVolume`），
  播放中换成停止图标 + `data-speaking='true'`（`--pa-accent` 常亮 + 1.6s 脉冲，
  `prefers-reduced-motion` 下关动画）。只对**有可朗读正文的 bot 消息**渲染；
  用户消息不给入口（自己的话不需要听，也容易让人以为在放语音输入）。
- **入口 2（自动）**：**会话头**通话按钮**左侧**的喇叭按钮（`AutoSpeakButton.tsx`），
  **唯一入口**（2026-11-05 起，Bot 设置卡语音页里那个重复开关已撤掉；那一页只留音色与
  Live 供应商）。拨的是 `Bot.autoSpeak`（默认关；`normalizeState` 只认显式 `true`）；
  群聊不渲染——群里自动播报不生效，摆一个拨了没用的入口比不摆更糟。打开态
  `data-on='true'`（`--pa-accent`），图标在 `IconVolume` / `IconVolumeOff` 之间切换。
  生效条件：单聊（`room === null`）+ 开关打开 + `ui.call.status === 'idle'`。
  触发：messages 变化后 debounce 250ms，取**最后一条** bot 消息，`pending` 不播；
  `spokenRef` 记录已播消息，首次挂载 / 切会话 / 拨开关时把现有消息全部标记为已播
  （刷新不重播历史）。切会话、通话开始、消息流卸载都会 `stopSpeech()`。
- **朗读音量**：会话头开关 **hover / 键盘聚焦** 浮出音量浮层（移开 160ms 后收起，
  面板与按钮之间有透明桥接，见 `AutoSpeakButton.tsx` 文件头）：0–100% 滑条即时写
  `speech.ts` 的 `setSpeechVolume`——两条播放路径一起变（整段 WAV 主增益 / 流式
  PcmPlayer 增益），并落 `pa:speech-volume:v1`；滑块拖到 0 显示「静音」。
  它与通话弹层那条通话音量（`pa:call-volume:v1`）是**两个独立的值**。
- **音量滑条（两处共用）**：`shared/VolumeSlider.tsx` + base.css 的 `.pa-vs*`。
  用**粗细**表达音量：已选段 10px 粗、未选段 4px 细（悬停 / 聚焦 / 拖动时两段
  一起加到 13 / 6，粗细对比保留），两段都单色；圆点 14px，轨道左右各内缩 7px
  与原生 thumb 的可移动区间对齐。`input[type=range]` 叠在上层当透明交互层，
  键盘 / 触摸 / 读屏语义仍在。通话弹层与会话头浮层只各自指定
  `--pa-vs-color / --pa-vs-rest / --pa-vs-surface`，不再各写一套轨道样式。
- **语音来源 = 通话已设置的模型**：请求带该消息发送者 Bot 的 `voice` / `liveVendor`，
  宿主缺省回落到全局默认。**没有第二套 TTS 配置**。
- 链路（**流式**）：`POST REALTIME_TTS_PATH`（`/api/personal-agent/tts`，见 shared 契约）
  → 宿主 `synthesizeSpeechStream`：读 Live 供应商 → 凭据 → 模型候选（请求 > 供应商配置 > 宿主链）
  → 一次性 Realtime 会话（`session.update` 带朗读指令 + 音色，**无 tools、无 turn_detection**；
  **收到 `session.created` 就发** `conversation.item.create` + `response.create`，不等
  `session.updated`——WS 帧有序，等它只是多一次往返）
  → 收 `response.audio.delta` 逐片回调 → 路由层**首片到达才写 200**
  （`REALTIME_TTS_STREAM_MIME` + `REALTIME_TTS_SAMPLE_RATE_HEADER`，chunked）→ 边收边 `res.write`。
  `stream` 缺省/false 时保留整段 WAV（`synthesizeSpeech` + `encodeWav`）。
  失败口径：**首包前**非 200 + `{ ok:false, error }`（中文可读）；**首包后**只能断流
  （已发 200 与部分 PCM，再补 JSON 会被当 PCM 播放）；客户端中途断开 → abort 上游并关连接。
- **播放器（`src/client/personal/speech.ts`）**：模块级单例 + `useSyncExternalStore`
  订阅；`AudioContext` 懒创建并复用（发送消息时 `primeSpeech()` 在手势里预热，
  否则自动朗读会被浏览器策略拦）；同一时刻只播一条，新播放停旧的；「播放代次」
  丢弃迟到响应；`AbortController` 取消在途合成。被拦时**静默**回空闲；
  手动点播失败才 `toast` 原因（`SpeakToolButton` 的 `onError`）。
- **文本清洗**：`cleanSpeechText` 去代码块 / 行内反引号 / 图片 / 链接地址（留文字）/
  标题列表引用符号 / 表格分隔行 / 加粗星号 / HTML 标签，压缩空白，截到 240 字
  （宿主 `REALTIME_TTS_MAX_CHARS` = 400 兜底）。
- 回归：`scripts/test-realtime-tts.mjs`（宿主端到端，假上游）、
  `scripts/test-speech-client.mjs`（esbuild 打包真实 speech.ts + mock fetch/AudioContext）。

### 6.6 Journal（v4：宿主生成 + 编辑杂志风 + 双主题）

数据契约在 `src/shared/journal.ts`（两端共享：JournalRecord / JournalRule / JournalFeed /
JournalStatus / sanitizeJournalRecord / journalDateKey / formatJournalFeedForPrompt）。

- **生成（宿主）**：`POST /api/personal-agent/journal/generate`。宿主读取前端同步的素材
  （`journal-feed.json`，最近 48h / 500 条）或请求体里的 `messages/stats`，用
  `ctx.llm.stream` + `createUserMessage` 调当前聊天模型，system 提示词要求「只依据素材、
  不得编造事实与数字」，输出严格 JSON（title / subtitle / summary / mood / weather / quote /
  sections[3–4] / stats[3–5] / highlights[≤6] / imagePrompt）。解析失败或模型不可用返回
  可读错误，前端回退本地版。
- **持久化**：`<DSH_HOME>/storages/dsh-seeker-bot/personal-agent/journals/<id>.json`；
  id = `journal-<date>-<hash>`（同一天同一 bot 稳定，重试覆盖不产生两期）。
  另存 `journal-rule.json`、`journal-feed.json`、`journal-logs.json`（40 条，最新在前）。
- **调度**：`scheduler.ts` 的 30s tick 调 `checkJournalTrigger(ctx)`：enabled → 触发窗口
  `[startHour, endHour)` → 静默 `now - lastUserMessageAt ≥ idleMinutes` → 本地时区「昨天」
  没有该 bot 的期刊 → feed 有素材。满足则生成、落盘、`publish` 一条
  `{ type:'journal', journal, source:'auto' }` 事件；手动生成与自动生成共用模块级生成锁。
- **API**：`GET /journal/list`、`GET /journal/status`、`POST /journal/generate`、
  `POST /journal/check`（与调度器同一判定）、`POST /journal/rule`、`POST /journal/feed`、
  `DELETE /journal?id=`；`journal/image`（生图）与 `journal/asset`（封面静态文件）保留。
- **前端**：启动时 `GET /journal/list` + `/journal/status` 合并（按 id 去重、宿主优先、
  同 bot 同日只留一份）；消息变化 5s 防抖同步 `/journal/feed`，规则变化 1s 防抖同步
  `/journal/rule`；SSE 收到 journal 事件去重 prepend（auto 时 toast）。所有 fetch 在
  `file://` 演示页跳过，走纯本地 `buildJournal`（真实统计 + 真实对话摘录，`origin:'local'`）。
- **界面（JournalOverlay）**：全屏「书架 + 阅读台」。
  - 左侧 260px 书架：按年月分组、当前期色条高亮、可折叠（<900px 变顶部横向滚动条）；
  - 顶栏：返回对话 / 上一期 / 下一期 / 下载封面 / 规则 / 关闭；
  - 纸张（居中 max-width 780px）：16:9 hero → 期号细线 + 日期/天气/心情 → 衬线大标题 →
    斜体副标题 → 首字下沉导语 → 本期数据 stats → 编号章节 01/02/03（bullets 细点列表）→
    当日速览 highlights 时间线 → 引文 → 页脚 PAGE xx / xx；
  - 空态：书籍图标 + 说明 +「生成今日期刊」（loading 态）。
- **主题适配**：`.pa-journal-overlay` 上定义 `--j-*` 双套 token（默认/暗色 + `.pa-root[data-pa-theme='light']`
  亮色），组件规则零硬编码颜色；亮色为浅色 UI + 象牙纸 `#faf6ec` + 墨 `#241f1a`，
  暗色为深色 UI + 深墨纸 `#171a20` + 墨 `#e9e4da`；`color-scheme` 同步。
  首次打开时 overlay 用 `z-index:9999 + transform:translateZ(0) + isolation:isolate`
  防止与主界面合成层错乱（实测修复）。
- **封面**：宿主 `generateJournalImage` 调生图模型（失败不阻塞，`imagePrompt` 保留）；
  无图时按主题用 `journalCoverSvg(journal, theme)` 程序化封面。
- **JournalRulePanel**：右侧 320px 抽屉，显示规则状态 / 触发窗口 / 静默时长 / 目标内容，
  「立即检查」「模拟 07:30 触发」（同步与 Promise 返回都兼容），最近 8 条触发日志。
- **聊天期刊卡**：`MessageBlockView` 的横向小卡（封面缩略图 + 「期刊日记」小标 + 标题 +
  日期 + 摘要 + 箭头），颜色走 journal 变量，亮暗主题一致。

### 6.7 GroupSettings（v3：右侧滑出卡）

- 同一套 `pa-sheet` 居中弹窗卡：群名、模型策略（跟随各自 Bot / 全组统一）、成员 chips、保存、
  删除群聊（自绘二次确认）。
- 群聊成员管理与模型统一设置在 store 更新。
- **模型选择**：群聊「全组统一」与 `BotSettingsCard` 的模型区共用 `shared/ModelPicker.tsx`，
  都是**先选供应商、再选模型**的两级 PaSelect 下拉（不再用原生 `<select>` 或手填 provider）；
  两边都带**推理强度**下拉（只列当前模型公布过的档位，空 = 跟随默认），换模型时旧档位不再
  被新模型支持会自动回落；宿主模型列表读不到时群聊保留手填输入作为降级。
- 新增 `BotSettingsCard`（Bot 设置居中弹窗卡）与侧栏底部全局设置滑出卡。

### 6.7.1 群聊「谁接话」的判定

判定抽在 `src/client/personal/room-trigger.ts`（纯函数，不依赖 React 与宿主），
由 `store.tsx` 的 `sendMessage` 群聊分支调用；回归测试 `scripts/test-room-trigger.mjs`。
完整设计见 [GROUP-CHAT.md](./GROUP-CHAT.md)。

- 五档，命中即停：`@所有人` 一类广播 → 全员；`@名字` → 只叫被点名的（按点名顺序）；
  引用了某条 Bot 消息 → 只叫被引用的那个；委托词（让/请/叫/找/交给/派给/由）紧邻成员名 →
  只叫被委托的那个；都没有 → 群主兜底。`@` 压过引用（@ 是更晚的一次选择），引用压过委托
  （UI 动作比文本推断确定）；被引用的人已退群时按没引用处理。
- 正文里随口提到成员名**不**触发（原实现是 `value.includes(bot.name)`）；
  `user@example.com`、`@2x` 这类写法不算点名；成员名互为子串时最长优先。
- 一次最多编排 3 位成员，超出的进 `overflow` 并 toast 说清谁没接（原来是静默截断）。
- 群里没有成员时 toast 提示并中止，不再让消息「发出去没反应」。
- 成员之间**严格串行**：每个成员等上一位在本群的轮次收口再启动，判据是`room-queue.ts`
  的 `shouldStartNext()`（纯函数、有真值表测试；关键是「上一位启动过没有」，不是「在不在跑」），
  运行时读 `runningReplyTurnsRef`（与停止键共用），180 秒超时兜底。不是固定错峰——一轮回复
  要几十秒，固定错峰会让第二个成员在第一个还在流式生成时就开口，等于各自回答同一段背景。
- 「全组统一模型」在回合开始时解析成 `unifiedModel` 并覆盖进请求体的 `bot.model`——
  宿主只认这一个字段，设置里的 `modelMode` 原本不会影响任何一轮回复。
- 群里的审批卡 / 问答卡由宿主侧补 `roomId` 后发布（`src/host/personal/room-context.ts`），
  否则它们只会落进该 Bot 的私聊，群里那条回复永远等不到应答。
- **群成员能看见彼此**：群聊回合把本群最近 20 条消息（含其他成员发言、排除本轮这条、
  带 `name`）随请求体 `history` 带上；宿主 `buildRoomContextBlock()` 拼成一段
  developer 消息，在用户消息之前注入。单条 ≤600 字符、整体 ≤6000 字符，超限保留最近发言。
  只带本群是刻意的（别的群是另一种场地）；私聊回合维持原样。

## 7. 验收自检（必须逐条可演示）

1. 视觉：截图对比，布局/间距/颜色/圆角/字号/图标一致
2. 主 bot 控制子 bot（右栏子 Bot 管理）、子 bot 分组、群聊可用
3. 日记：规则说明 + 模拟触发 + 期刊风 + 宽幅图 + 图文呼应
4. 每个 bot：主动询问（按钮/定时 + 提醒标记「继续提醒 / 不再提醒」）、例行任务、记忆隔离（每个 bot 独立列表）、主 bot 检索全部
5. 交互式 UI：按钮选择后回传、bot 继续响应、消息记录可见
6. 通话：对话中回显、来源标记（语音通话）、发生时间、最终时长、默认折叠/展开、收起右栏顶部
7. 新建 Bot：弹窗完整、首条主动消息真实进入会话

## 8. 运行方式

- 构建：`npm run build`
- 独立演示：`npm run build:personal-demo`（产出 `dist/personal-agent/index.html`，可直接打开）
- DSH 内：刷新 `http://127.0.0.1:3080`，点击侧栏顶部 Bot
