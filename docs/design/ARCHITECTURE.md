# dsh-seeker-bot · 技术架构（v0.2）

> 前提：**不修改 DSH 源码**，全部通过 Cordis 插件契约挂载。
> 参考实现：`D:/AI/Dsh/dsh-chat-plus`（同环境已跑通的融合插件）。
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
    path: '/api/example-plugin',
    handler: (req, res) => route(req, res),
  }))

  // 工具用手写 ToolDefinition 对象，不要 import defineTool
  ctx.tools.register({
    name: 'example_echo',
    description: '示例工具：把输入原样回显',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } } },
      render: (r) => '已回显：' + r.text,
    },
    async execute(args) { return { text: args.text } },
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
      ctx.slots.inject('example-panel', () => ctx.slots.register({
        id: 'example-panel',
        slot: 'sidebar.left',      // 槽位名以 CLIENT_SLOT_API 为准
        cardinality: 'single',
        priority: 100,
      }, ExamplePanel))
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

本插件实际使用的槽位：

| 用途 | 槽位 | 说明 |
|---|---|---|
| 侧栏二级导航 | `sidebar.left`（或等价 left rail） | 工作区 ⇄ 操作间切换、七个工作台入口 |
| 会话头部标签 | 会话头部槽位 | 官方「对话 / 轨迹」旁注入 Seeker 标签 |
| 设置页 | 设置页 slot | 插件自己的设置行（胶囊形态 / 录屏 / 展示开关） |
| 浮层（弹窗、抽屉） | `shell.overlay` | 不要碰 root |

> 具体槽位名在 M1 阶段用 `CLIENT_SLOT_API` 实测确认后再写死；本文件先给结构。

---

## 4. 目录结构

```
dsh-seeker-bot/
├── package.json
├── build.mjs                  # esbuild 双产物 + 外部依赖守卫
├── cordis.patch.yml           # bundle patch：自动注册 loader 条目
├── icon.png
├── README.md
├── docs/
│   └── ARCHITECTURE.md
├── src/
│   ├── host.ts                # host 半身入口（路由 / 工具 / 状态）
│   ├── shared/                # 两侧共用的小工具（CSRF / 围栏扫描 / 卡片校验）
│   ├── triad/                 # 工作台 host 侧（记忆 / 档案 / 画廊 / 技能 / 同步）
│   ├── vendor/                # 内核叶子模块的内联副本
│   ├── client/                # client 半身：槽位注册、React 组件、样式
│   │   ├── kr-chat/           # Seeker 视图与右栏卡片
│   │   ├── iu/                # iu 原生交互卡片（12 种 kind）
│   │   ├── html-embed/        # HTML 沙箱卡片
│   │   ├── done-pill/         # 对话完成胶囊
│   │   ├── triad/             # 七个工作台面板与侧栏导航
│   │   └── …
│   └── …
└── scripts/                   # 冒烟、安装契约与链路验证脚本
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

## 6. 数据流

```
用户输入 ─▶ 原生会话 ─▶ 模型 ─▶ 工具调用
                 │                  ├─ 插件注册的工具（tools.register）
                 │                  └─ 普通工具（fs / pwsh / browser / mcp）
                 ▼
        host 半身（HTTP 路由 + 状态 + 资产）
                 ▼
        GET /api/<前缀>/… ─▶ client 槽位渲染（卡片 / 工作台 / 侧栏）
```

- **状态留在 host**：需要跨会话保留的数据（记忆、档案、同步状态）由 host 落盘，
  client 只读快照；页面刷新后从路由重新拉。
- **渲染留在 client**：槽位组件只做展示与交互，不直接碰文件系统。
- **降级**：事件流不可用时退回定时轮询；路由失败时组件静默隐藏，不阻塞会话。

---

## 7. 安全

| 面 | 做法 |
|---|---|
| 路由鉴权 | 复用宿主 web 会话 cookie；写操作校验 Origin |
| 路径穿越 | 只接受 workspace 内相对路径，`resolve` 后做前缀校验 |
| 凭据 | 敏感值落盘加密（AES-GCM）；列表接口返回掩码，明文只在用户主动查看时单字段取出 |
| 审批 | 复用 `dsh-user-approval`，插件不自建放行通道 |
| 注入 | 写进系统提示的文本一律限长 + 规整换行，防越权指令 |

---

## 8. 测试

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
4. **手动验收**：装进真实 profile 后，逐项过一遍页面能力（卡片、工作台、胶囊、Seeker 视图）。

---

## 9. 开发流程

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

## 10. 已知坑（同环境实测）

1. `@deepseek-ai/*` 只发源码 → host 产物必须自包含，否则装完 `ERR_MODULE_NOT_FOUND`。
2. esbuild 没有 `intro`，CJS 工厂用 `banner/footer`。
3. 模板字面量里的裸反引号 → 构建"成功"但产物 `ReferenceError`。
4. `ctx.webServer.register` 重复 path **抛异常**。
5. 槽位 id 冲突会让入口静默不显示（不报错）。
6. `root` 槽位一注册就把整个 AppFrame 遮掉。
7. 未在 `inject` 声明的 `ctx.xxx` 一读就抛，连带 3080 起不来。
8. Windows 下给 node 传路径要用反斜杠风格（Git Bash 的 `/d/...` 会被转坏）。
9. 宿主半身改动必须重启；client 产物按 no-cache 读盘，刷新页面即可。
