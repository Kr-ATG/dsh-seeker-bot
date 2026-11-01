# Personal Agent · 开发契约（v1）

本文件是「Personal agent」界面复刻 + 功能实现的唯一事实来源。所有模块按本契约并行开发，
不得擅自改共享类型 / 类名 / 数据键。

## 1. 产品定位

在 `dsh-seeker-bot` 插件内新增完整的 Personal Agent 模式（Bot 模式）：点击侧栏顶部
`Work | Bot` 切换器进入。Bot 模式是一个**全屏自绘应用**（overlay，覆盖整个 DSH Web 视口）：

```
┌──────────────────────────────────────────────────────────────────────┐
│  左侧栏 248px                │  聊天主区 flex:1        │  右栏 300px     │
│  - 顶栏（折叠/搜索/+）        │  - 会话头（头像/名称/角色/呼叫）│  - bot 头像/名 │
│  - Work/Bot 切换器            │  - 消息流（微信式）      │  - tabs 详情/资料库/电脑 │
│  - 主 bot（大号）             │  - 交互卡 / 通话卡       │  - 任务/例行任务/记忆 │
│  - 子 bot 分组列表            │  - 输入框 + 语音麦克风    │  - 关闭按钮            │
│  - 群聊分组                  │                        │  - 通话收起条（顶部）    │
│  - 底部：日记 / 设置          │                        │                        │
└──────────────────────────────────────────────────────────────────────┘
```

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
| 通话弹窗 / 通话卡 / 语音 | `src/client/personal/call/*.tsx`, `call.css.ts`, `audio.ts` | 队友 B |
| 期刊日记 / 阅读器 / 记忆与任务面板 | `src/client/personal/journal/*.tsx`, `journal.css.ts` | 队友 C |
| Host API / 持久化 / LLM/TTS/生图 | `src/host/personal/*.ts` | Lead |
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
--pa-right: #18191b;         /* 右栏 */
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

- 左侧栏 248px，右栏 300px；中缝 1px `--pa-line`
- 侧栏左右内边距 12px；行高 44px；分组标题 11px/500 letter-spacing .04em
- 主 bot 头像 48px（按参考图实测；SPEC 早期写 56px，以 48px 为准），子 bot 头像 34px，右栏头像 64px
- 圆角：卡片 12px，输入框 14px，气泡 18px（右下 6px），弹窗 16px，分段控件 13px
- 字号：标题 15px/600；正文 13px/1.6；摘要 11px/1.45；小标签 10px；按钮 12px/500
- 字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
- 阴影：浮层 `0 18px 60px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06)`
- 动效：消息 `pa-rise` 260ms cubic-bezier(.2,.8,.2,1)；弹窗 `pa-pop` 180ms；列表选中 120ms

### 5.3 图标

全部内联 SVG（`icons.tsx`），stroke 1.7，圆角端点，尺寸 16/18/20。
禁止 emoji 当图标（头像里的眼睛除外）。

## 6. 组件契约

### 6.1 Sidebar（队友 A）

- 顶栏：左「侧栏折叠」图标、中间留白、右「搜索」「+」圆形按钮（32px）
- `SegmentedMode`：Work / Bot，272×42 胶囊，选中块 #0a0a0b 圆角 11px；Bot 时高亮
- 主 bot：56px blob 头像 + 名称 14px/600 + 橙色在线点；点击进入主 bot 会话
- 子 bot 列表：按 `groups` 渲染；每条 = 34px 彩色 blob 头像 + 名称 13px/600 + 角色 11px/灰 +
  最近消息摘要 11px/截断；选中态整行 `--pa-card-2` 圆角 10px；未读数徽标
- 群聊分组：群头像（成员头像叠加）+ 名称 + `N 个 Bot · 群聊`
- 底部：`期刊日记` / `设置` 两个按钮
- 右键/悬浮 `...` 菜单：编辑、移动分组、暂停、删除（主 bot 才显示管理项）
- 「+」打开新建 Bot 弹窗（队友 A 同时负责 NewBotModal）

### 6.2 RightPanel（队友 A）

- 头部：64px 头像、名称 16px/600、角色 11px 灰；右上角分享 + 关闭（关闭 = 右栏收起，聊天区变宽）
- tabs：详情 / 资料库 / 电脑；选中白色 600，下划线 2px
- 详情：
  - 「编码」任务卡列表（可点击展开步骤）
  - 「例行任务」区块：列出该 bot 的 routines（名称 + 频率 + 开关 + 下次时间），空态「请在聊天中设置例行任务。」；底部「＋ 新建例行任务」→ 弹窗
  - 主 bot 额外：「子 Bot 管理」列表（启用/暂停/编辑/移动分组/删除）
- 资料库：记忆搜索框 + 记忆列表（文本、标签、时间）；主 bot 有「全部 Bot」筛选
- 电脑：工作区文件树占位（种子数据）+ 终端片段（静态）
- 顶部若 `ui.call.minimized` 显示「通话条」：头像 + 通话中 00:19 + 挂断/展开按钮

### 6.3 NewBotModal（队友 A）

- 弹窗 520px，深色卡片，标题「新建 Bot」
- 字段：名字（可选，占位「例如：调研助手」）；角色或简介 textarea（占位「描述它擅长什么、怎么跟你配合…」）
- 随机选项：4 个 chip（点击填入 textarea），右上「换一批」
- 底部：取消 / 发送
- 未填角色 → 自动选一个随机选项作为角色并真实创建；创建后 bot 主动发首条消息（store 处理）
- 创建中禁用按钮+转圈

### 6.4 ChatPanel（队友 B）

- Header：44px 头像 + 名称 15px/600 + 副标题（角色）11px 灰 + 右侧「呼叫」电话图标（必有）、「更多」
- 消息流：日期/时间系统分隔条居中胶囊；bot 消息左侧（头像 32px + 名称小字 + 内容），用户消息右侧
  深灰蓝气泡；bot 文本无气泡（纯文本块）或浅卡（取决于 block 类型）；进入动画 `pa-rise`
- blocks：
  - text：Markdown 轻量渲染（加粗、列表、行内代码、换行）
  - task：可折叠任务卡（标题 + 状态 + 步骤，点击展开）
  - interactive：卡片含按钮组 / 单选 / 表单；点击后立即显示已选状态，并调用 `actions.answerInteractive`
  - call：通话记录折叠卡（默认折叠）
  - journal：期刊卡（封面缩略图 + 标题 + 打开）
- 输入框：附件按钮 + textarea（自动增高）+ 麦克风（MediaRecorder → 16k 单声道 WAV →
  `ctx.remote.speech.transcribe`，与 Work 模式同一条 SenseVoice ASR；转写填入输入框，确认后发送）
- 输入框上方支持 `@` 提及（群聊时选择成员）与快捷 chip
- 空会话展示 bot 主动打招呼与 3 个建议 chip

### 6.4.1 回复形态（Bot ≠ Work）

Bot 复用宿主的 agent loop，但输出形态必须按**对话**设计，不能是工作台报告：

- 正文 1–3 句、最多两小段；不用加粗伪标题、多级清单、表格、代码块；不贴路径 / 命令 / 参数
  （用户明确要求「详细说 / 报告 / 清单 / 代码 / 文档」时才展开）。
- 工具过程不进正文：`MessageBlockView` 默认不渲染 `tool` 块（`generate_image` 例外）。
- 每个 Bot 的 agent 作用域要摘掉 Work 专属提示段：`team:policy`、
  `ui:deliverable-file-references`、`app:web-surface`、`harness:source`。实现见
  `src/host/personal/agent.ts` 的 `trimWorkOnlyPrompt()`（全局段同名空覆盖 +
  `system-prompt/assemble` waterfall 过滤 agent 作用域段）。
- 契约文本在 `buildBotPrompt()`；`/reply` 的 chat 降级路径必须用同一份措辞。

### 6.5 CallOverlay（队友 B）

- 打开：全屏暗色遮罩 + 居中 360px 通话卡片（渐变底、头像 88px、名字、状态/计时、波纹环）
- 控件：静音、扬声器、视频（禁用）、挂断（红）
- 「最小化」按钮：收起后 `ui.call.minimized = true`，右栏顶部出现通话条，点击恢复
- 结束：调用 `actions.endCall()`，写一条 `kind:'call'` 消息到该 bot 会话，默认折叠
- 通话界面内显示实时转写（我方语音 + bot 回复），对话结束后完整回显到消息卡
- 语音：麦克风点击后请求录音权限；录音 → 规范 WAV → DSH speech Remote（与 Work 模式同一
  SenseVoice ASR）→ `callUserTurn` → 宿主 `/reply` 真实模型回复 → 宿主 `/tts` Edge TTS 播放；
  失败时给出可读提示并保留打字输入兜底，绝不再静默返回固定假回复。

### 6.6 Journal（队友 C）

- `JournalReader`：全屏/侧滑阅读层；期刊风：米白纸张 `#f6f0e4`，深墨 `#241f1a`，
  衬线标题（Georgia / Songti SC）、期号、日期、顶部 16:9 宽幅配图、正文多段、引文、页脚
- 顶栏：返回、上一期/下一期、下载/分享（可无操作）、关闭
- 左侧列表（或在右栏「期刊」tab）：按时间倒序的期刊封面卡
- `JournalRulePanel`：显示触发规则说明与「立即检查」「模拟 07:30 触发」按钮
- 无图时：显示程序化生成的抽象封面（SVG data URL），不空白

### 6.7 GroupSettings（队友 A）

- 群聊设置弹窗：模型策略（跟随各自 Bot / 全组统一）、成员 chips、保存
- 群聊成员管理与模型统一设置在 store 更新

## 7. 验收自检（必须逐条可演示）

1. 视觉：截图对比，布局/间距/颜色/圆角/字号/图标一致
2. 主 bot 控制子 bot（右栏子 Bot 管理）、子 bot 分组、群聊可用
3. 日记：规则说明 + 模拟触发 + 期刊风 + 宽幅图 + 图文呼应
4. 每个 bot：主动询问（按钮/定时）、例行任务、记忆隔离（每个 bot 独立列表）、主 bot 检索全部
5. 交互式 UI：按钮选择后回传、bot 继续响应、消息记录可见
6. 通话：对话中回显、来源标记（语音通话）、发生时间、最终时长、默认折叠/展开、收起右栏顶部
7. 新建 Bot：弹窗完整、首条主动消息真实进入会话

## 8. 运行方式

- 构建：`npm run build`
- 独立演示：`npm run build:personal-demo`（产出 `dist/personal-agent/index.html`，可直接打开）
- DSH 内：刷新 `http://127.0.0.1:3080`，点击侧栏顶部 Bot
