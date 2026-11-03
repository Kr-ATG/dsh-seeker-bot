# 上下文与记忆控制 · 分析与路线图

> v1（2026-11-02）：基于本仓库代码实读。
> v2（2026-11-02）：对照 Grok Bot 官方文档（[docs.x.ai/grok-bot](https://docs.x.ai/grok-bot/overview)）补充设计基准，
> 新增「Pages / 工作日志 / 审批规则 / 防注入 / 引用回复」等条目。

## 一句话结论

**Bot 的会话是终身的（`pa-bot-<botId>`），但记忆注入只在"首步"和"压缩后"发生，工作状态又只活在上下文里——于是 Bot 的长期记忆实际上取决于"压缩什么时候发生"。Grok Bot 用「稳定的记忆 + 每次从结构化存储重建的工作日志 + 记忆不是权威源」三件事绕开了这个坑，我们的路线图要按这个基准补。**

---

## 一、参考基准：Grok Bot 的设计（对照用）

从官方文档提炼出的六条硬设计，后面每一条都对应我们的差距：

| 维度 | Grok Bot 的做法 | 对我们的含义 |
|---|---|---|
| **记忆内容** | 稳定偏好 + 重要事实 + **过往工作的摘要** + **一份带日期的工作日志**；不重放每条历史 | 我们的记忆类型缺"工作日志"这一维；工作记忆要按日期沉淀，不是只存当前任务 |
| **记忆写入** | Bot 自主判断"值不值得记"，**不问用户**；常在回复里提一句"我记下了" | 我们的 pending 待确认机制更可控但更重；Bot 场景应默认自动保存 + 轻提示 |
| **记忆管理** | personal Bot **没有记忆界面**，靠对话："你记得我什么""忘掉 X" | 我们保留面板，但必须补对话式入口 |
| **记忆定位** | **"Memory is not a source of truth"**：关键决策要求查当前源；安全边界靠审批，不靠记忆 | 注入记忆时要标明"这是记忆不是实时数据"；关键决策强制查源 |
| **上下文** | 工具活动、computer use、产出物、审批卡都显示在 transcript 里；支持**引用某条消息回复**、表情回应、**执行中插话重定向**、**Stop now** | 我们"过程不进正文"藏得太干净，且缺引用/重定向语义 |
| **产出物** | 文件卡片 + **Pages**（可回访的持久页面：报告/看板/追踪器，带筛选控件，存在 Library） | 生成式 UI 要分两层：消息内卡片（即时）+ 持久页面（可回访/可更新） |
| **审批** | Auto Review 默认开；**Allow once / Always allow / Deny**；警告标签（不可撤销/改安全设置/外发数据）；Custom Rules（Ask first / Allow automatically）；**只认用户自己消息里的请求，不认邮件网页里的指令** | 我们的审批只有"允许这次/拒绝"，缺规则、缺标签、缺防注入 |
| **自动化** | 一次性任务 → 可靠 → 存成 skill → 再上 routine；routine 六条信任设计（先准备后执行、先草稿后动作、关键动作审批、无数据策略、幂等重试、部分完成要报告） | 我们缺"从成功任务沉淀成 skill"的路径，routine 缺失败/无数据策略 |

> 引用：[What a Bot remembers](https://docs.x.ai/grok-bot/bots#what-a-bot-remembers)、
> [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)、
> [Approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)、
> [Files and results](https://docs.x.ai/grok-bot/files-and-results)、
> [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)。

---

## 二、现状盘点

### 上下文侧

| 事实 | 位置 |
|---|---|
| Bot 会话固定为 `pa-bot-<botId>`，同一 bot 终身一个 session，历史无限增长 | `src/host/personal/agent.ts:855` |
| 一次 turn 按模型说话次数切多条 assistant 消息 | `agent.ts:2155` `finalizeMessages` |
| 历史压缩交给宿主 compaction，插件只监听 `compaction/summary` / `compaction/end` | `src/triad/memory/index.ts:128` |
| 压缩后清 4 个 `stepCounters`，让记忆在下一 step 重新注入 | 同上 `injector.disposeSession(session.id)` |
| 工具结果进上下文，但 Bot 消息默认不渲染工具块（"过程不进正文"） | `MessageBlockView.tsx` 文件头 |
| 有 `cancelBotTurn`（停止当前轮），但没有"执行中改方向"的语义 | `agent.ts:1052` |

### 记忆侧

| 事实 | 位置 |
|---|---|
| 注入只在会话首步一次；后续轮次靠 `stepCounters` 静默跳过 | `inject.ts:603-606` |
| 压缩后重置计数 → 重新注入 | `index.ts:128-131` |
| 提取在 `turn/end`，输入是本 turn 的 user/assistant 文本 | `index.ts:133-148`、`extract.ts:273` |
| 提取**跳过**注入类消息（plugin / agent-instructions / skill-catalog / compact-checkpoint） | `extract.ts:286` |
| 注入预算：token 截断，pinned 最多占 40%，其余按重要性/检索竞争 | `inject.ts` 文件头、`compile.ts` |
| 可见性三口径：Work / 子 Bot / 主 Bot（主 Bot 可注入全部子 Bot 的记忆） | `visibility.ts:62-89` |
| 类型：`identity` / `preference` / `fact` / `decision` / `gotcha`，无任务态 | `types.ts` |
| 生命周期：pending（待确认）→ active → deprecated / disabled；有衰减 scoring | `scoring.ts`、`inject.ts:380` |

---

## 三、缺陷清单

### P0 — 结构性问题

**1. 记忆更新与注入时机脱节**
注入只在首步 / compaction 后。Bot 是持久会话，短对话可能几周都不触发压缩。用户今天加一条"以后周报用中文"——这个 Bot 要到下次压缩才知道。自动提取的新记忆同理：**提取了，但注入不了**。

**2. 没有工作记忆层（任务状态 + 工作日志）**
Grok 的记忆里明确包含"a dated log of what it has worked on"，而我们的记忆只有事实/偏好。任务状态（52 账号、36 草稿、top 10 已批）只活在上下文里，压缩一发生就断。需要两层：
- **当前任务状态**（每轮注入，保证不失忆）
- **带日期的工作日志**（沉淀成记忆，供回看和检索）

**3. 提取不读工具结果**
`transcriptFromEvents` 只收 `user/message` 与 `assistant/message`。工具产生的关键事实（账号列表、文件路径）不会被记住——除非模型在正文复述。而 Bot 正文契约是 1–3 句。**素材最少的地方，恰恰是最需要记住的地方。**

### P1 — 体验与可信度

**4. 工具活动藏得太干净（对照 Grok 后升级为 P1）**
Grok 把 tool activity、computer use、created files 都显示在 transcript 里；我们默认不渲染工具块。副作用是**可审计性丢失**——用户想复盘"Bot 怎么得出这个结论"看不到过程。修正方向不是"全部摊开"，而是"默认折叠成一行，可展开完整流水"（Grok 的 computer preview 也是点开才看）。

**5. compaction 不可见**
用户不知道历史什么时候被压缩，Bot 的连续性依赖压缩策略但界面无提示；压缩后也没有人工可读摘要。

**6. 上下文与 UI 不对称**
用户看到 1–3 句，上下文里可能有完整工具结果；反过来，生成式 UI 卡片里的数据不在上下文里，Bot 下一轮可能不记得自己展示过什么。

**7. 主 Bot 的记忆可见范围过宽**
`canInject` 允许主 Bot 注入全部子 Bot 的记忆。首步注入时可能塞进大量无关记忆——"保守口径"目前只按 workspace 过滤，没有按相关性过滤。

**8. 记忆与档案两套注入**
`vault/inject.ts` 与 `memory/inject.ts` 各自注入、各自在 compaction 后重置，生命周期不同步，内容可能重复。

**9. 缺对话式记忆管理**
Grok 的 personal Bot 没有记忆界面，靠"你记得我什么 / 忘掉 X"管理。我们虽然有记忆工作台，但 Bot 对话里没有对应的自然语言入口（需要确认 Bot 是否注入了 `memory_search` / `memory_forget` 类工具）。

### P2 — 交互语义与产物形态

**10. 缺引用回复（Reply to a specific message）**
多条消息流里，用户想针对第 3 条回复做不到，只能靠上下文猜。这是"指代漂移"的根因。Grok 直接支持引用回复。

**11. 缺"执行中改方向"（Redirect work in progress）**
我们只有 `cancelBotTurn`（停），没有"新消息优先、重定向当前 turn"的语义。Grok 明确写了：用户的新消息优先于后台工作，可以改变当前轮的方向。

**12. 审批粒度太粗**
只有"允许这次 / 拒绝"。缺：
- `Always allow` + 规则系统（Ask first / Allow automatically）
- 警告标签（不可撤销 / 改安全设置 / 外发数据）
- 超时策略（我们的 5 分钟取消偏激进；Grok 是 chat 内不过期、后台 30 分钟）

**13. 缺防提示注入的显式规则**
Grok 的 Auto Review 只认用户自己消息里的请求，邮件/网页里的指令不算授权。我们的 Bot 会读网页、读邮件，但没有这条规则。

**14. 生成式 UI 缺"持久页面"这一层**
我们的 `iu` / `html` 卡片是消息内、一次性的。Grok 的 Pages 是可回访、可更新、可分享的持久页面（报告/看板/追踪器，带筛选控件，存在 Library）。**消息内卡片解决"即时交互"，Pages 解决"长期产物"**——两者不能互相替代。

**15. 缺"从成功任务沉淀成 skill"的路径**
Grok 的路径是：一次性任务 → 可靠 → 存成 skill → 再上 routine。我们有 SKILL 工作台和例行任务，但没有"这个流程跑顺了，要不要存成 skill"的触发。

**16. routine 缺信任设计**
Grok 的六条：先准备后执行、先草稿后动作、关键动作审批、无数据/过期数据策略、幂等重试、部分完成要报告。我们的例行任务目前更像"定时发消息"。

---

## 四、路线图

### 阶段 0（P0，本周）— 让记忆"进得来、出得去"

#### 0.1 记忆变更触发重新注入

- **改什么**：`store.ts` 加 `revision`（每次写入递增并落盘）；`inject.ts` 的 `preStepListener` 比较 `revision`，变了就清该会话的 `stepCounters`（复用现有 compaction 的重置路径）。
- **验收**：记忆面板加一条新记忆 → Bot 下一轮能引用；日志出现 `re-injected after memory change`。
- **风险**：连续加 10 条触发 10 次重注。用"记录已注入 revision"合并，一轮最多重注一次。

#### 0.2 工作记忆层（任务状态 + 工作日志）

- **存储**：`~/.dsh/storages/dsh-seeker-bot/personal-agent/working-memory/<botId>.json`
- **结构**：
  ```ts
  interface WorkingTask {
    id: string
    title: string
    status: 'active' | 'waiting' | 'done' | 'failed'
    steps: Array<{ label: string; status: 'todo' | 'doing' | 'done' }>
    facts: Record<string, string>   // { accounts: '52', drafts: '36' }
    artifacts: string[]
    blockers: string[]
    updatedAt: number
    ttlDays?: number
  }
  ```
- **写入**：新增 `task_state` 工具（模型主动更新），或从 `todo_write` / `bot_emit(need-input)` 自动推导。
- **注入**：每轮 pre-step 注入**当前活跃任务**的紧凑摘要（最多 3 个，几百 token）。
- **沉淀**：任务 `done` 后，把"做了什么 + 产出 + 日期"写进记忆库（Grok 的 "dated log"），供后续检索。
- **验收**：跑一个 5 步任务 → 中途触发压缩 → 下一轮仍知道进度与待办；一周后问"上周做了什么"能答上来。

#### 0.3 注入分层

| 层 | 内容 | 时机 |
|---|---|---|
| 稳定层 | 身份 / 偏好 / 置顶 | 首步 + compaction 后 |
| 动态层 | 工作记忆 / 活跃任务 | **每轮** |
| 检索层 | 与当前 query 相关的记忆 | 每轮或每 N 轮，按 token 预算 |

- **验收**：每轮 token 增量 < 1k，Bot 对"当前任务"的回忆准确率明显上升。

#### 0.4 记忆定位标注（对照 Grok 新增）

- 注入记忆块时加一句："这是记忆，不是实时数据；关键决策请查当前源。"
- 与现有的"记忆与项目指令冲突时以项目指令为准"并列。
- **验收**：Bot 在被问到"我们客户 A 的合同金额"时，会先查源而不是直接引用记忆。

---

### 阶段 1（P1，下周）— 让上下文"可看见、可信任"

#### 1.1 compaction 标记 + 会话摘要
Host 监听 `compaction/end` → SSE 推一条 `compaction` 事件 → 前端在对话流对应位置插入"上下文已压缩 · N 条消息折叠"标记，可展开看摘要。

#### 1.2 提取纳入工具结果
`turnBuffers` 增加 `tool/result`（截断到 2000 字符，只取文本）；或只在有 `artifacts` 时把文件路径写进提取素材。

#### 1.3 工具结果摘要化
单个工具结果超过 8k 字符时，上下文里只放"头 2k + 摘要 + 尾 1k"，完整内容落盘可展开。

#### 1.4 可审计的执行流水（对照 Grok 新增）
把"过程不进正文"改成"过程默认折叠成一行，可展开完整流水"：
- 对话流里每条 Bot 消息下挂一行"N 个动作 · 展开"
- 展开后是工具调用时间线（中文人话 + 耗时 + 结果摘要）
- 与右栏操作面板共享同一份数据

#### 1.5 对话式记忆管理（对照 Grok 新增）
Bot 支持自然语言管理记忆：
- "你记得我什么" → 列当前可见记忆
- "忘掉 X" → 调用 `memory_forget`
- "这条过时了，改成 Y" → `memory_revise`
- 前提：确认 Bot 的 agent 作用域里是否注入了记忆工具；没有就补。

---

### 阶段 2（P1/P2，两周内）— 对话流改造（与阶段 0/1 并行）

1. **`turnId`**：`Message` 加 `turnId`，host 在 `turn/start` 生成，前端按轮分组。轮次容器、结算、折叠的前提。
2. **生成式 UI 通道**：`MessageBlockView` 接 ```html / ```iu 围栏，复用 Work 模式渲染器；`buildBotPrompt()` 加"能出卡就出卡"规则。
3. **引用回复 + 表情回应**（对照 Grok 新增）：消息支持"回复某条"，回复里带上被引用消息的 id 与摘要；轻量确认用表情，避免用户打"好"。
4. **执行中重定向**（对照 Grok 新增）：用户在执行中发新消息时，不是排队而是**优先于后台工作、可重定向当前 turn**；"Stop now" 仍然只停不撤销。
5. **`progress` 合并**：连续 progress 原地 `message-update`，只有 finding / need-input / approval / final 新开气泡。
6. **待办上浮**：need-input / approval 抽到输入框上方常驻条。
7. **`execution` 块**：computer-use / browser-use 工具调用渲染成执行态卡；点击打开右栏"电脑"面板看实时画面（对应 Grok 的 computer preview）。
8. **轮次容器 / 结算**：依赖 `turnId`，最后做。

---

### 阶段 3（P2，后续）— 产物形态与自动化

#### 3.1 Pages：持久页面（对照 Grok 新增）
- 生成式 UI 的第二层：消息内卡片是即时的，Pages 是可回访的。
- **存储位置**（沿用现有产出物结构，不新开根目录）：
  - 页面本体：`D:\Seeker-Bot\产出物\<botFolder>\网页\<slug>.html`
  - 元数据：同目录 `<slug>.meta.json`（标题、创建/更新时间、版本、分享状态、来源消息 id）
  - `<botFolder>` 由 `ensureBotOutputDirs()` 分配（如 `小析`），映射存在 `bot-output-dirs.json`
- 入口：Bot 产出报告/看板/追踪器时，除了消息卡片，同时存一份到"产出物"工作台。
- 能力：可回访、可更新（旧卡显示"已更新到下方"）、可分享。
- 复用：`iu` / `html` 渲染器 + 产出物卡的扫描与预览链路（`.html` 已映射到「网页」分类，`kind = 'page'`）。

#### 3.2 审批规则系统（对照 Grok 新增）
- `Always allow`：保存规则，类似动作以后自动放行。
- Custom Rules：Ask first / Allow automatically，各设上限。
- 警告标签：不可撤销 / 改安全设置 / 外发数据。
- 超时策略：chat 内不过期，后台 30 分钟过期。

#### 3.3 防提示注入（对照 Grok 新增）
- 审批判断只认用户自己消息里的请求；邮件、网页、文件里的指令不算授权。
- 写进 Bot 契约与审批卡的判定逻辑。

#### 3.4 从任务沉淀 skill（对照 Grok 新增）
- Bot 完成一个可复用任务后，主动建议"要不要存成 skill / 例行任务"。
- 复用现有 SKILL 工作台与 routine 存储。

#### 3.5 routine 信任设计（对照 Grok 新增）
- 先准备后执行、先草稿后动作、关键动作审批、无数据/过期数据策略、幂等重试、部分完成要报告。

#### 3.6 记忆质量收尾
- 类型扩展（task / progress 或并入工作记忆）
- 主 Bot 注入范围收窄（检索 top-k）
- 记忆与档案去重
- 临时信息标记

---

## 五、存储位置约定

> 原则：**Bot 的工作文件都在 `D:\Seeker-Bot` 下**（用户能一眼找到，每个 Bot 一个文件夹，下面按类型分）；**插件自己的持久化状态在 `~/.dsh/storages/dsh-seeker-bot/personal-agent/`**。新增能力不新开根目录。

### 5.1 现有结构（不改）

```
D:\Seeker-Bot\                          ← botWorkspaceDir()，可用 DSH_SEEKER_BOT_WORKSPACE 覆盖
├── 产出物\                             ← botOutputsRoot()
│   └── <botFolder>\                     ← 每个 Bot 一个文件夹（如 小析）
│       ├── 图片\
│       ├── 视频\
│       ├── 音频\
│       ├── 文档\
│       ├── 表格\
│       ├── 演示\
│       ├── 网页\                        ← .html / .htm 落这里（Pages 复用）
│       ├── PDF\
│       └── 其他\
├── uploads\                             ← 用户粘贴 / 上传的图片
└── _tmp\
    ├── generated-images\                ← 生图中间产物
    └── generated-media\                 ← 生视频中间产物
```

`~/.dsh/storages/dsh-seeker-bot/personal-agent/` 现有：
`routines.json` / `proactive.json` / `server-messages.json` / `bot-output-dirs.json`（botId → 文件夹名映射）/ `journals/` / `realtime-config.json`。

### 5.2 新增数据的落盘位置

| 数据 | 位置 | 对应条目 |
|---|---|---|
| Pages 本体 | `D:\Seeker-Bot\产出物\<botFolder>\网页\<slug>.html` | 3.1 |
| Pages 元数据 | 同目录 `<slug>.meta.json` | 3.1 |
| 工作记忆 | `~/.dsh/storages/dsh-seeker-bot/personal-agent/working-memory/<botId>.json` | 0.2 |
| 工具结果全文 | `~/.dsh/storages/dsh-seeker-bot/personal-agent/tool-results/<sessionId>/<callId>.txt` | 1.3 |
| compaction 摘要 | `~/.dsh/storages/dsh-seeker-bot/personal-agent/compactions/<sessionId>.json` | 1.1 |
| execution 截图 / 录像 | `D:\Seeker-Bot\_tmp\execution\<callId>\`（可清理） | 2.7 |
| 记忆库 | `~/.dsh/memories/dsh-memory/`（不改） | — |

### 5.3 约定

- **Bot 交付文件只进 `D:\Seeker-Bot\产出物\<botFolder>\`**；模型写到 `_tmp/` 或工作区根目录的文件由 `archiveArtifactFile` 归档进来。
- **`_tmp` 可被清理**，不能放唯一副本；需要长期保留的页面 / 文件必须进 `产出物\`。
- **新增分类要进 `BOT_OUTPUT_CATEGORIES`**（现有 9 个），同时改 `KIND_BY_EXT` / `CATEGORY_BY_KIND` 与前端 `BotOutputKind`，三处逐字对齐。
- **插件状态不放 `D:\Seeker-Bot`**：工作记忆、工具结果全文、compaction 摘要属于插件状态，放 `~/.dsh/storages/...`，避免用户清理产出物时误删。

---

## 六、依赖关系

```
0.1 记忆变更重注 ──┐
                   ├── 0.3 注入分层 ── 0.4 记忆定位标注
0.2 工作记忆 ──────┘
        │
        ├── 1.5 对话式记忆管理（需要工作记忆 + 记忆工具）
        └── 3.6 记忆质量

1.4 可审计流水 ── 2.7 execution 块（共享同一份工具时间线）

2.1 turnId ── 2.8 轮次容器
2.3 引用回复 ── 解决指代漂移
2.4 执行中重定向 ── 依赖 cancelBotTurn 的现有实现

3.1 Pages ── 依赖 2.2 生成式 UI 通道
3.2 审批规则 ── 独立
```

- **0.1 与 0.2 可以并行**，互不依赖。
- **2.1 / 2.2 / 2.3 / 2.5 / 2.6 可以并行**，都是对话流侧改动。
- **阶段 2 与阶段 0/1 没有硬依赖**，两条线同时推进。

---

## 七、风险与边界

| 风险 | 说明 | 对策 |
|---|---|---|
| 每轮注入工作记忆增加 token | 3 个任务摘要约 300–500 token/轮 | 只注入 active/waiting，done 不注入 |
| 记忆变更频繁导致重注风暴 | 用户连续操作 | 一轮最多重注一次，记录已注入 revision |
| 工作记忆与长期记忆内容重叠 | 任务事实被同时存两处 | 明确边界：任务态只进工作记忆，偏好/事实只进长期记忆；done 后沉淀成"工作日志"进记忆 |
| compaction 摘要质量不可控 | 宿主生成 | 只做展示，不依赖摘要做逻辑 |
| 提取读工具结果可能引入噪音 | 工具结果里有大量中间过程 | 只取 artifacts 与最终结果，不取中间日志 |
| 执行中重定向与现有 turn 管理冲突 | `cancelBotTurn` 是终止语义 | 重定向走"新消息优先"路径，不改 cancel 语义 |
| Pages 与消息内卡片职责重叠 | 两者都能展示 UI | 消息内卡片 = 即时交互；Pages = 可回访产物；同一内容可以两边都有，但 Pages 是权威副本 |

---

## 八、建议的起步顺序

**先做 0.1（半天到一天）**：改动最小，能立刻验证"记忆更新 → Bot 知道"这条链路。

**再做 0.2（工作记忆）**：结构性改动，需要设计工具接口与注入格式，值得单独一轮。

**对话流侧的 2.1（turnId）+ 2.2（生成式 UI 通道）** 可以并行开工。

**3.1（Pages）** 建议等 2.2 落地后再做——它是生成式 UI 的自然延伸，不是并行项。

---

## 九、实施状态（2026-11-02 本轮）

| 条目 | 状态 | 落点 |
|---|---|---|
| 0.1 记忆变更触发重注 | ✅ | `store.ts` 加 `revision`（随 entries.json 落盘）；`inject.ts` 按会话比较，变了清主注入 `stepCounters`；`noteTurnStart()` 保证一轮最多重注一次 |
| 0.2 工作记忆 | ✅ | `working-memory.ts`（存储/读写/注入文本）+ `task_state` 工具（部分更新）+ 每轮注入 + done 自动沉淀工作日志进记忆库 |
| 0.3 注入分层 | ✅ | 稳定层（首步 + revision 变化）与检索层（每 5 轮 / 换话题 / 记忆变更，刷新时替换旧块）分离 |
| 0.4 记忆定位标注 | ✅ | 主注入引导语：「记忆不是实时数据，会变的事实先查当前源」 |
| 1.1 compaction 标记 + 摘要 | ✅ | host 监听 `compaction/summary|end` 推 SSE；前端居中小字「上下文已压缩 · N 条消息折叠」，可展开摘要 |
| 1.2 提取纳入工具结果 | ✅ | `transcriptFromEvents` 收 tool/call + tool/result（截断 2000，中间过程只留路径）；转录裁剪改头 60% + 尾 40% |
| 1.3 工具结果摘要化 | ✅ | `tools/post-execute` 压缩（>8000 字符 → 头 2k + 摘要 + 尾 1k），全文落盘 + `pruneToolResults()` 按天/按量清理 |
| 1.4 可审计流水 | ⚠️ 已回退 | 曾做成「N 个动作 · 展开」；按用户要求「Bot 消息不要出现工具卡」改回不渲染，审计交给宿主日志与 execution 块 |
| 1.5 对话式记忆管理 | ✅ | `BOT_MEMORY_CONTRACT`（记得我什么 / 忘掉 / 修订 / 记住） |
| 2.1 turnId | ✅ | `BotMessage.turnId` + `Message.turnId` |
| 2.2 生成式 UI | ✅ | 契约 `BOT_REPLY_CONTRACT` + 渲染器：`RichText` 接 ```iu / ```html 围栏 |
| 2.3 引用回复 | ✅ | `Message.replyTo` + 引用条 + hover「回复」+ Composer 引用提示 |
| 2.4 执行中重定向 | ✅ | `agent.steer()`；后台轮次不重定向；`cancelBotTurn` 保持只停不撤销 |
| 2.5 progress 合并 | ✅ | `store.tsx` 数据层合并，`mergedSegments` 保证 update 不冲掉整条 |
| 2.6 待办上浮 | ✅ | `PendingBar` 挂在输入框上方 |
| 2.7 execution 块 | ✅ | `ExecutionBlock` + computer/browser 类工具自动转 |
| 2.8 轮次容器 / 结算 | ✅ | 按 turnId 分组，扁平头/尾（时间 + 状态 / N 条消息 · M 产出 · K 待办），可折叠；无 turnId 老数据单条渲染 |
| 3.1 Pages | ✅ | host：`产出物/<botFolder>/网页/<slug>.html` + `.meta.json` + 3 个路由；前端：右栏「页面」卡 + iframe 预览 + 「已更新到下方」提示 |
| 3.2 审批规则系统 | ✅ | always-allow / ask-first 规则、风险标签、聊天不过期 / 后台 30 分钟 |
| 3.3 防提示注入 | ✅ | `BOT_SAFETY_CONTRACT`（只认用户本人消息） |
| 3.4 skill 沉淀 | ✅ | `BOT_SKILL_CONTRACT`（提示词层，不实现存储） |
| 3.5 routine 信任设计 | ✅ | `noDataPolicy` + `retry` + `partial` 标记 + `lastResult` |
| 3.6 记忆质量收尾 | ✅ | 主 Bot 注入收窄（`canSearch` 仍开放）、`ttlDays` 临时信息、记忆×档案去重（`vault-overlap.ts`） |

**验证**：`npm run build` ✅；23 个回归脚本全 PASS：`test-personal-agent` / `test-bot-outputs` / `test-bot-tool-retrieval` / `test-memory-owner` / **`test-context-memory`（新增端到端）** / `smoke-host` / `smoke-client` / `smoke-triad-host` / `smoke-triad-client` / `test-system-prompt` / `test-prompt-optimize-clean` / `test-session-isolation` / `test-mode-switch` / `test-at-guard` / `test-html-card-width` / `test-echo-viewport` / `test-feature-switches` / `test-personal-journal-host` / `test-personal-journal-client` / `test-realtime-audio` / `test-realtime-ws` / `test-realtime-client` / `test-realtime-proxy`。

**收尾补完（第二轮）**：
- **语音通话注入工作记忆**：`realtime/mount.ts` 在 `runBotTurn` 前 `injectWorkingMemoryIntoAgent`，与 `/reply` 同一套。
- **后台轮次显式参数**：`runBotTurn` 的 spec 加 `background?: boolean`，`scheduler.ts` 的 routine / proactive 两处传 `true`；文本前缀降级为兜底。
- **过期记忆清理**：每日编译把 `isExpired()` 条目标 `deprecated`（软废弃，可逆），`memory_search` 默认排除、`includeDeprecated` 可查。
- **`retrievalRefreshTurns` 进面板**：Bot 设置卡「记忆」分区新增一行（1–50，默认 5），走 `GET/POST /api/dsh-memory/config` 即时生效。
- **端到端脚本**：新增 `scripts/test-context-memory.mjs`（npm `test:context-memory`），用真实临时目录串起工作记忆 / Pages / compaction 事件 / 工具结果清理四条链路，30 项断言全过。

**本轮遗留**：
- 1.4 可审计流水按用户要求回退成「不渲染工具块」；可审计性靠宿主日志与 execution 块。
- 工作记忆「done 沉淀记忆」的**成功路径**仍需要真实记忆引擎在场才能验证（`test-context-memory` 覆盖的是存储/注入/清理，不是真实引擎落库）。
- Pages 的 html 走 `/pages/item` 由前端 sandbox iframe 消费，没接 `/file`（同源 `text/html` 会执行脚本）。
- `test-settings-card.mjs` 需要带令牌的真 DSH Web，本机 `web-auth-url.json` 失效，未跑。
- 真实宿主端到端（多步任务中途压缩、执行中插话、Pages 写入）建议重启 DSH 后手动各跑一次。
