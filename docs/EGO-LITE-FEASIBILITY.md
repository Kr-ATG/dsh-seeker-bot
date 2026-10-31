# ego-lite 工作区回显 · 可行性实测报告

> 结论先行：**可以实现**。回显有三档方案，帧率从 1.5fps 到 24fps 不等；
> 操作转发可行但有约 0.5s 往返延迟。推荐「长驻抓帧进程 + 命令转发」方案，零额外配置、约 5fps。
>
> 实测环境：ego lite 0.6.2.5 / Chromium 156.0.8078.74 / Windows 11 / Node 24
> 实测时间：2026-10-31 · 全部数据来自本机真实运行，非推算

---

## 一、实测数据

### 1.1 单次调用开销

| 指标 | 实测值 | 说明 |
|---|---|---|
| `ego-browser nodejs` 进程启动 + 握手 | **~350–400ms** | 每次调用固定成本 |
| `taskSpace()` 恢复已有空间 | **4–80ms** | 空间已存在时几乎无成本 |
| `page.screenshot()` 首帧（页面刚加载） | **972ms** | 含首屏渲染 |
| `page.screenshot()` 热路径 | **61–75ms** | 页面已稳定 |
| `Page.captureScreenshot`（CDP，jpeg q55） | **79ms** | 63KB base64 |
| `page.evaluate()` | **4ms** | |
| `page.mouse.click()` | **15ms** | |
| 整次 CLI 调用墙钟（1 次截图） | **~500ms** | 启动 + 恢复 + 抓帧 |

### 1.2 三种抓帧方式

| 方式 | 帧率 | 单帧大小 | 结论 |
|---|---|---|---|
| **CDP `Page.startScreencast`（同进程）** | **24.6 fps** | 39.8KB（jpeg q50 / 1280×800） | 最快，但见 1.3 的跨进程限制 |
| **批量 `Page.captureScreenshot`（单进程 15 帧）** | **4.1 fps**（去首帧约 5.3） | 58KB（q45） | 无特殊约束，最稳 |
| **单次 screenshot 轮询** | 1.5–2 fps | 63KB | 最省事，延迟 ~600ms |

> screencast 是**变化驱动**的：页面静止时不推帧（4 秒只 1 帧），有动画时满帧。
> 这对回显是好事——静止页面零带宽。

### 1.3 关键限制：screencast 不跨进程

| 场景 | 结果 |
|---|---|
| 同一进程内推流 + 自己改页面 | ✅ 24.6 fps |
| 另一进程只读连接（`page.url()`） | ✅ 不打断推流 |
| **另一进程写页面，推流进程收帧** | ❌ 9 秒只收到 1 帧（首帧） |

**解释**：ego 的 CDP 会话疑似按进程绑定，另一个进程的渲染变化不会回传给推流进程。
所以「Bot 在另一个 CLI 进程里操作，插件进程推流」这条路走不通。

**但 `captureScreenshot` 轮询不受影响**——每次都是新抓一帧，永远是最新画面。

### 1.4 长驻脚本可行

用一个循环 8 秒的脚本（每 200ms 抓一帧）验证：

```
+48ms   {"i":0,"t":48,"shotMs":48,"bytes":54952}
+358ms  {"i":1,"t":358,"shotMs":104,"bytes":54952}
+614ms  {"i":2,"t":614,"shotMs":51,"bytes":54952}
+912ms  {"i":3,"t":912,"shotMs":83,"bytes":54952}
...     总时长 8158ms，持续输出
```

- **CLI 不会提前退出**，脚本可以长驻；
- 脚本输出走 **stderr**（不是 stdout），host 读 stderr 即可；
- 去掉 200ms 间隔可到 8–10fps（受单帧 50–100ms 限制）。

### 1.5 CDP 直连：部分可行

- ego 支持 `--remote-debugging-port=9333`，端口能开、能连、协议版本 1.3；
- **但只暴露 `browser_ui` 一个 target**（ego 自己的 UI），webview 里的网页内容没有作为 target 暴露；
- 用户**当前运行的实例没有开这个端口**，要用必须改启动方式。

所以 CDP 直连暂时不能作为主路径，列为后续优化项。

---

## 二、三档方案对比

| | **A. 轮询单次截图** | **B. 长驻抓帧进程**（推荐） | **C. CDP 直连** |
|---|---|---|---|
| 帧率 | 1.5–2 fps | **5–8 fps** | 24+ fps |
| 端到端延迟 | ~600ms | **~250ms** | ~50ms |
| 额外配置 | 无 | 无 | 需改 ego 启动参数 |
| 实现复杂度 | 低 | 中（host 管子进程 + 帧分发） | 高（且 webview target 未解决） |
| 与 Bot 操作并发 | 安全 | 安全 | 安全 |
| 结论 | 降级方案 | **主方案** | 待验证 |

### 操作转发

| 操作 | 延迟 | 说明 |
|---|---|---|
| 点击 / 滚轮 / 键盘 | **~500ms 往返** | 每次 spawn 一次 CLI 进程 |
| 拖拽 / 悬停跟随 | 不可用 | 帧率不足以支撑连续指针事件 |

**建议**：面板只转发 click / scroll / 输入文字 / 快捷键，不做 hover 跟随与拖拽。
真要拖拽，引导用户点「在 ego 中打开」跳到真实窗口。

---

## 三、推荐架构

```
┌─ DSH host（插件常驻）─────────────────────────────┐
│                                                   │
│  EgoBridge                                        │
│   ├─ FramePump（每个 Bot 屏一路）                  │
│   │    spawn: ego-browser nodejs -e import(stream.mjs)
│   │    stream.mjs:                                   │
│   │      taskSpace('seeker-bot')                     │
│   │      page('p1')                                  │
│   │      loop { captureScreenshot(q40) → stderr 行 } │
│   │    host 读 stderr → 解析 JSON → 帧缓存           │
│   │                                                  │
│   ├─ InputQueue                                     │
│   │    POST /input → spawn act.mjs（click/type/...） │
│   │                                                  │
│   └─ WS /api/seeker-bot/browser/stream              │
│        按 botId 推送最新帧（默认 5fps，可调）        │
└───────────────────────────────────────────────────┘
                     │
                     ▼
        前端 <canvas> 绘制 + 指针事件回传
```

### 关键设计

1. **每个 Bot 一个 Page**：`task.newPage()` 拿到 `p1/p2/p3`，FramePump 按 label 抓帧；
   一个 space 内多 page 共享同一浏览器，天然满足「一台电脑、多块屏」。
2. **帧只在面板可见时抓**：面板收起 → 暂停 FramePump，静止页面零开销。
3. **帧率自适应**：默认 5fps；检测到连续多帧相同（哈希）→ 降到 1fps；用户接管时升到 10fps。
4. **操作走独立进程**：不与 FramePump 抢同一进程，避免 CLI 会话冲突。
5. **降级**：FramePump 启动失败 → 退回单次截图轮询（1.5fps），面板显示「降级模式」。

---

## 四、风险与限制

| 风险 | 影响 | 对策 |
|---|---|---|
| ego 未启动 | 面板空 | 显示「未连接」+ 一键启动 ego |
| CLI 升级后输出通道变化 | 读不到帧 | 同时监听 stdout/stderr；版本探测 |
| 多 Bot 多路帧流 | CPU / 带宽 | 单浏览器多 page，帧率自适应，只推可见面板 |
| 用户主实例与插件实例不同 | 看到的是另一个浏览器 | 明确约定：插件使用固定 space 名 `seeker-bot`，与用户手动开的 space 区分 |
| 单帧 40–60KB | 5fps ≈ 250KB/s | 本地 WebSocket 无压力；可降到 q35 + maxWidth 1000（约 25KB/帧） |
| 拖拽 / 悬停体验差 | 接管不完整 | 提供「在 ego 中打开」按钮跳真实窗口 |

---

## 五、对原方案的修正

原型与架构文档里原先写的是「实时回显」，实测后应改为：

- **默认**：约 5fps 的准实时回显（延迟 ~250ms），足够看清 Bot 在做什么；
- **接管**：可提到 10fps，但指针操作仍有 ~500ms 往返，不适合拖拽；
- **不承诺**：24fps 只在同进程内成立，产品上不采用。

---

## 六、复现方式

探针脚本已归档到 `docs/reference/ego-probe/`（可直接复跑）：

| 脚本 | 验证内容 |
|---|---|
| `round-01.mjs` | 冷启动 + 首帧截图耗时 |
| `round-02.mjs` | 热路径截图 vs CDP captureScreenshot |
| `round-03.mjs` | screencast 能否启动 |
| `round-04.mjs` | 页面持续变化时的帧率（24.6fps） |
| `round-05/06.mjs` | 跨进程并发：操作可用、推流收不到帧 |
| `round-07.mjs` | 单进程批量抓帧（4.1fps） |
| `round-08.mjs` | 长驻脚本流式输出（可行） |

跑法：

```powershell
ego-browser nodejs -e "await import('file:///D:/AI/dsh-seeker-bot/docs/reference/ego-probe/round-07.mjs')"
```

> 探针用的 TaskSpace 已 `finish({ keep: [] })` 关闭，没有残留空间。
