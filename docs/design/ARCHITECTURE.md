# dsh-seeker-bot · 技术架构（v0.2）

> 前提：**不修改 DSH 源码**，全部通过 Cordis 插件契约挂载。
> 参考实现：`D:/AI/Dsh/dsh-seeker-bot`（同环境已跑通的融合插件）。
> 本机 DSH 为 **npm 安装形态**（`D:\AI\Dsh\dsh-runtime` 只有 package.json + node_modules），
> 权威实现都在 `node_modules/@deepseek-ai/*/lib/`；profile 在 `C:\Users\Anti\.dsh\profiles\web`。

---

## 1. 三条决定性的硬结论

### 1.1 `dsh.bundle.patch` 是自动挂载的唯一开关

`dsh plugin add` 之后 `reconcile()` 会扫新依赖：
- 没有 `dsh.bundle` → 只 warn（`installed as a plain dependency, not a profile layer`）并跳过；
- 有 → 写进 `dsh.profile.bundles` 并加载。

**没有它，插件装了也不加载。** 所以 `package.json` 必须有：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": [] }
}
```

`dsh.client` 只认四个键：`platform`(string) / `inject`(string[]) / `external`(string[]) / `immediately`(boolean)。
**声明了 `dsh.client` 却没有 `exports["./client"]` 会直接抛错。**

### 1.2 host 产物必须自包含

插件仓库在 `D:\AI\dsh-seeker-bot`，pnpm link / junction 的 realpath 在 D 盘，
Node 向上找**找不到** `profiles/web/node_modules/@deepseek-ai/*` → `ERR_MODULE_NOT_FOUND`。

- `dsh-image-gen` 装在 profile 内（`profiles/web/plugins/`）所以能 `import { defineTool } from '@deepseek-ai/dsh-tools'`；
- `dsh-seeker-bot` 在 D 盘，所以 host 产物**零 `@deepseek-ai/*` 运行时依赖**。

**新插件走 chat-plus 路线**：host 产物只留 `node:*`，需要的内核叶子模块一律 vendor 化到 `src/vendor/`。

### 1.3 client 半身能 require 的名字是有限的

浏览器模块表的 **seed 词（11 个）**：

```
react · react/jsx-runtime · react-dom · react-dom/client · @deepseek-ai/cordis · zod ·
@tanstack/react-virtual · @deepseek-ai/dsh-client-store · @deepseek-ai/dsh-client-ui-slots ·
@deepseek-ai/dsh-client-ui-primitives · @deepseek-ai/dsh-client-ui-dockkit
```

其余 `@deepseek-ai/dsh-client-*` 必须写进 `dsh.client.inject` 才会被提供。
**最小插件只需要 `react`，`inject` 可以留空数组。**

---

## 2. 双半身结构

| 半身 | 形态 | 入口 | 职责 |
|---|---|---|---|
| **host** | Node ESM，自包含 | `lib/index.js` | HTTP 路由、状态持久化、定时注册、工具注入、系统提示注入 |
| **client** | 浏览器 CJS 工厂 | `lib/client.js` | 槽位注册、React 组件、样式注入 |

### 2.1 host 最小骨架

```ts
// src/host.ts
export const name = 'dsh-seeker-bot'
export const inject = ['webServer', 'tools']

export function apply(ctx) {
  // 路由必须包在 ctx.effect 里，dispose 时自动摘除
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/seeker-bot',
    handler: (req, res) => route(req, res),
  }))

  // 工具用手写 ToolDefinition 对象，不要 import defineTool
  ctx.tools.register({
    name: 'seeker_bot_create',
    description: '创建一个新的持久 Bot（队友），返回它的 id',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        role: { type: 'string' },
      },
      required: ['name', 'role'],
    },
    output: {
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      render: (r) => '已创建 Bot：' + r.id,
    },
    async execute(args) { return { id: await bots.create(args) } },
  })
}
```

> `inject` 里没声明的 `ctx.xxx` 一读就抛（cordis Proxy），会连累整棵树 boot 失败、3080 起不来。

### 2.2 client 最小骨架

```js
// 产物外层契约（build 时用 banner/footer 包）
window.__ModuleLoader__.load({
  id: 'dsh-seeker-bot',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;

    exports.apply = function (ctx) {
      // 槽位注册必须包一层 inject，等 slots 服务就绪
      ctx.slots.inject('seeker-roster', () => ctx.slots.register({
        id: 'seeker-roster',
        slot: 'sidebar.left',      // 槽位名以 CLIENT_SLOT_API 为准
        cardinality: 'single',
        priority: 100,
      }, RosterPanel))
    }
    exports.inject = ['slots']
    return module.exports
  }
})
```

---

## 3. 槽位系统（106 个真实槽位）

权威数据在 `@deepseek-ai/dsh-cordis-client-runner/lib/client.js:2606` 的 `CLIENT_SLOT_API`，
每条含 `kind / scope / declaredBy / occupants / registerOptions / example`。

**红线：`root` 槽位绝对不能注册**（single，会遮蔽整个 AppFrame，页面只剩你的组件）。
要浮层用 `shell.overlay`。

本插件只用四个槽位：

| 用途 | 槽位 | 说明 |
|---|---|---|
| 名册侧栏 | `sidebar.left`（或等价 left rail） | 主入口 |
| 会话头身份条 | 会话头部槽位 | 显示当前 Bot 身份与状态 |
| 设置页 | 设置页 slot | 规则表 / 用量 / 团队 |
| 浮层（命令面板、新建 Bot） | `shell.overlay` | 不要碰 root |

> 具体槽位名在 M1 阶段用 `CLIENT_SLOT_API` 实测确认后再写死；本文件先给结构。

---

## 4. 目录结构

```
dsh-seeker-bot/
├── package.json
├── build.mjs                  # esbuild 双产物 + 外部依赖守卫
├── cordis.patch.yml           # bundle patch：自动注册 loader 条目
├── icon.svg
├── README.md
├── docs/
│   ├── PRD.md
│   └── ARCHITECTURE.md
├── prototype/index.html       # 可交互原型（纯前端）
├── src/
│   ├── host.ts
│   ├── shared/{types.ts,schema.ts}
│   ├── host/{state,routes,bots,groups,routines,approvals,usage,prompt}.ts
│   ├── client/{index.ts,roster/,console/,computer/,routines/,control/,styles.ts}
│   └── vendor/                # 内核叶子模块的内联副本
└── scripts/{smoke-host.mjs,smoke-client.mjs,install-dev.ps1}
```

---

## 5. 构建

与 chat-plus 同款：**两侧外部化策略刻意不同**。

```js
// host：自包含
{ entryPoints: ['src/host.ts'], outfile: 'lib/index.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node22', external: [], sourcemap: false }

// client：平台种子词与 @deepseek-ai/* 全部 external
{ entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: ['es2020'], jsx: 'automatic',
  external: ['react','react/jsx-runtime','react-dom','react-dom/client'] }
```

- esbuild **没有 `intro` 选项**（那是 Rollup 的）：CJS 工厂用 `banner + footer`。
- 构建末尾跑 `assertHostExternals()`：扫产物里的 `import/export … from 'x'`，除 `node:*` 与白名单外一律失败。
- 构建前跑模板字面量守卫：CSS 里一个裸反引号会让模板提前闭合，构建"成功"但产物 `ReferenceError`。

---

## 6. host 接口面

### 6.1 路由表（前缀 `/api/seeker-bot`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/state?since=rev` | 全量/增量状态（bots/groups/routines/rules/usage） |
| POST | `/bots` | 创建 Bot |
| PATCH | `/bots/:id` | 改名/头像/标签/置顶/分组/隐藏/暂停 |
| DELETE | `/bots/:id` | 删除（可选保留会话） |
| POST | `/bots/:id/duplicate` | 复制（带配置，不带历史） |
| POST | `/groups` · PATCH · DELETE | 群聊 |
| POST | `/groups/:id/send` | 群内发消息（@ 路由到具体 Bot） |
| GET/POST/PATCH/DELETE | `/routines` | 班次 CRUD |
| POST | `/routines/:id/test` | 立即跑一次 |
| GET | `/routines/:id/runs` | 运行历史 |
| POST | `/webhook/:routineId/:key` | 外部事件入口 |
| GET/PUT | `/rules` | 审批规则表 |
| GET | `/usage` | 本周用量 / 按 Bot 拆分 |
| GET | `/computer/tree` | 共享电脑文件树 |
| GET | `/computer/tasks` | 运行中的任务 |

**重复 `(kind, path)` 会抛异常**（不是 warn），所有子路由在**一个** prefix handler 内分发。

### 6.2 系统提示注入

岗位描述不是死表单，而是「首条消息固化 + 记忆」的结果。注入点：

```ts
ctx.on('system-prompt/assemble', (prompt, c) => {
  const bot = bots.bySession(c.sessionId)
  if (!bot) return prompt
  return prompt + '\n\n# 你的身份\n你是「' + bot.name + '」，岗位：' + bot.role +
    '\n' + bot.instructions + '\n记忆不是事实源：关键决策要回源核对。'
})
```

（钩子名以宿主版本为准，chat-plus 的 `src/system-prompt` 有可直接照抄的接法。）

### 6.3 状态持久化

```
~/.dsh/storages/dsh-seeker-bot/
├── state.json      # bots / groups / rules / usage 缓存（tmp + rename 原子写）
├── routines.json   # 班次与运行历史（每班次保留 20 条）
└── backups/        # 结构升级前快照
```

单进程写入，内存队列串行化；带 `version`，读取时迁移；**不复制内核数据**。

---

## 7. 界面融合：Work / Bot 双模式

### 7.1 落点

侧栏顶部（logo 行下方、「新会话」上方）注入一个 segmented 控件。两种实现路径：

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A. 侧栏容器内条件渲染**（推荐） | 在 `sidebar` 槽位里渲染一个包裹层：上半是模式切换，下半按 mode 渲染「原生内容」或「名册」 | 位置最稳；需要能拿到原生侧栏容器做 portal |
| B. 独立座位 + CSS 让位 | 新增一个 `seeker-roster` 座位，Bot 模式下给原生工作区加 `display:none` | 侵入小；但原生节点选择器依赖 DOM 结构，升级易碎 |

首选 A：用 `createPortal` 把切换控件挂到原生侧栏顶部节点，名册渲染在同一个滚动容器里。
拿不到容器时降级为 B，并用 `MutationObserver` 兜住重渲染。

### 7.2 状态与持久化

```ts
type UiMode = 'work' | 'bot'
// 存 settings 命名空间 seeker-bot.ui.mode，跨会话记忆
```

切换是**纯前端状态**，不触发会话重建；切回 Work 时恢复原会话滚动位置。

### 7.3 主区页签

Bot 模式下在主区顶部注入「班次 / 技能 / 审批 / 用量」四个页签（复用原生 tab 组件或自绘 36px 高、
1.5px 下划线的轻量版）。Work 模式下这排页签整体 `hidden`——注意 `[hidden]` 会被 `display:flex` 覆盖，
必须补 `.tabs[hidden]{display:none}`（原型里踩过）。

---

## 8. 浏览器回显：ego-lite（已实测）

> 完整实测数据见 `docs/EGO-LITE-FEASIBILITY.md`。这里只写结论与实现。

### 8.1 三档方案与实测帧率

| 方案 | 帧率 | 延迟 | 结论 |
|---|---|---|---|
| 单次截图轮询（每次 spawn CLI） | 1.5–2 fps | ~600ms | 降级方案 |
| **长驻抓帧进程**（一次 spawn，循环 captureScreenshot） | **5–8 fps** | **~250ms** | **主方案** |
| CDP 直连（`--remote-debugging-port`） | 24+ fps | ~50ms | 暂不可用：只暴露 browser_ui target，webview 内容未暴露 |

### 8.2 为什么不用 CDP screencast

实测：同一进程内 `Page.startScreencast` 能到 **24.6fps**，
但**另一个进程写页面时，推流进程收不到帧**（9 秒只有 1 帧）。
ego 的 CDP 会话疑似按进程绑定。而 Bot 的操作必然来自另一个 CLI 进程，
所以「推流」这条路在产品形态里不成立。

`captureScreenshot` 轮询不受此限制——每次都是新抓，永远最新。

### 8.3 主方案：长驻抓帧进程

```
host: FramePump（每个 Bot 屏一路）
  spawn('ego-browser.exe', ['nodejs','-e',"await import('file:///.../stream.mjs')"])
  stream.mjs:
    const task = await taskSpace('seeker-bot')     // 固定空间名
    const page = task.page('p1')                    // 每个 Bot 一个 label
    loop:
      const r = await page.cdp('Page.captureScreenshot', { format:'jpeg', quality:40 })
      console.error(JSON.stringify({ t: Date.now(), data: r.data }))   // 注意：输出走 stderr
      await sleep(interval)                          // 默认 200ms → 5fps
```

要点：

1. **脚本输出走 stderr**，host 读 `stderr` 而不是 `stdout`（实测）。
2. **CLI 不会提前退出**，脚本可长驻；一次 spawn 摊掉 ~350ms 启动成本。
3. **帧率自适应**：默认 5fps；帧哈希连续相同 → 降到 1fps；接管时升到 10fps。
4. **面板不可见就停泵**，静止页面零开销。
5. **每 Bot 一个 Page**：`task.newPage()` 得 `p1/p2/p3`，一个 space 多块屏，
   对应 Grok Bot 的「每用户一台电脑、每 Bot 一块屏」。

### 8.4 操作转发

| 操作 | 延迟 | 实现 |
|---|---|---|
| click / wheel / type / 快捷键 | ~500ms 往返 | `POST /input` → spawn 一次 `act.mjs` |
| 拖拽 / 悬停跟随 | 不可用 | 提供「在 ego 中打开」跳真实窗口 |

输入必须走**独立进程**，不与 FramePump 共用（避免 CLI 会话冲突）。

### 8.5 降级

- ego 未启动 → 面板显示「未连接」+ 一键启动；
- FramePump 起不来 → 退回单次截图轮询（1.5fps），面板标「降级模式」；
- 只读场景（不需要接管）→ 纯截图，不建输入通道。

## 9. 数据流

```
用户输入 ─▶ 原生会话 ─▶ 模型 ─▶ 工具调用
                 │                  ├─ seeker_bot_*（建 Bot / 建例程 / 查用量）
                 │                  └─ 普通工具（fs / pwsh / browser / mcp）
                 ▼
        host 状态机（bots/status/routines/usage）
                 ▼
        GET /state ─▶ client 名册 + 电脑面板 + 用量（优先事件流，降级 2s 轮询）
```

---

## 10. 安全

| 面 | 做法 |
|---|---|
| 路由鉴权 | 复用宿主 web 会话 cookie；写操作校验 Origin |
| 路径穿越 | 文件树只接受 workspace 内相对路径，`resolve` 后做前缀校验 |
| Webhook | 每例程独立 key（`Authorization: Bearer`），常量时间比较 |
| 凭据 | 复用 vault；Bot 只拿「已登录会话」，不拿明文 |
| 审批 | 复用 `dsh-user-approval`；插件只维护规则表，不自行放行 |
| 注入 | 岗位描述进系统提示前限长 + 规整换行，防越权指令 |

---

## 11. 测试

1. **host 冒烟**：桩 `ctx` 给 `logger / webServer.register / tools.register / on / effect / get`，
   路由用 Map 收集；断言按特征查找（`find(s => s.path === …)`），不写「等于 N 条」。
2. **client 冒烟**：`node:vm` + 假 `window.__ModuleLoader__`；React 桩用 Proxy（先查覆盖表），
   `Component` 必须是真 class；`setTimeout` 置空并显式 `process.exit()`。
3. **已安装位置复验**（最关键）：
   ```powershell
   cd $env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-seeker-bot
   node scripts/smoke-host.mjs
   ```
   源码目录通过而这里失败 = `ERR_MODULE_NOT_FOUND` 那个坑。
4. **手动验收**：按 PRD §8 逐条过。

---

## 12. 开发流程

```powershell
# 1) 构建
node build.mjs

# 2) 本地挂载（junction，避免每次 pnpm install）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-seeker-bot" -Target "D:\AI\dsh-seeker-bot"

# 3) 让 profile 认到它（bundle patch 自注册；或手动加进 dsh.profile.bundles）

# 4) 重启 DSH（host 半身不支持热重载）
```

**每次加能力都要同步三处**：冒烟断言、`package.json` 的 description、README 能力表。

---

## 13. 已知坑（同环境实测）

1. `@deepseek-ai/*` 只发源码 → host 产物必须自包含，否则装完 `ERR_MODULE_NOT_FOUND`。
2. esbuild 没有 `intro`，CJS 工厂用 `banner/footer`。
3. 模板字面量里的裸反引号 → 构建"成功"但产物 `ReferenceError`。
4. `ctx.webServer.register` 重复 path **抛异常**。
5. 槽位 id 冲突会让入口静默不显示（不报错）。
6. `root` 槽位一注册就把整个 AppFrame 遮掉。
7. 未在 `inject` 声明的 `ctx.xxx` 一读就抛，连带 3080 起不来。
8. Windows 下给 node 传路径要用反斜杠风格（Git Bash 的 `/d/...` 会被转坏）。
9. 宿主半身改动必须重启；client 产物按 no-cache 读盘，刷新页面即可。
