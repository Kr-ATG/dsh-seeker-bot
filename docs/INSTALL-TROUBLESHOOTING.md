# dsh-seeker-bot 安装排障手册

> 适用版本：dsh-seeker-bot 0.1.0（2026-10-31 当前仓库）
> 环境：Windows + DeepSeek Harness（D:\AI\Dsh\dsh-runtime）
> 结论先行：**先在独立 DSH_HOME 的临时 profile 里安装并跑完链路验证，再切换用户真实 profile；永远不要用定时 kill 去重启当前 DSH 进程。**

## 0. 一分钟快速路径

```powershell
cd D:\AI\dsh-seeker-bot
node build.mjs
node scripts/test-bot-install.mjs
node scripts/smoke-host.mjs
node scripts/verify-install.mjs
```

四条命令都通过（后两条应看到 PASSED / SMOKE PASSED），再考虑装到真实 profile。
安装验证脚本会把截图写到 `_tmp/verify-install/page.png`，把配置快照写到
`_tmp/verify-install/dump-config-after-install.txt`，把页面探针结果写到
`_tmp/verify-install/summary.json`。

## 1. 本次故障复盘（2026-10-31）

### 1.1 现象

- 用户先前手动把 `dsh-chat-plus` 换成 `dsh-seeker-bot` 后，DSH 页面加载出来但整页像死了一样：点击、滚动、切换侧栏都不响应，Windows 上表现为窗口「未响应」。
- DSH 进程本身还活着，HTTP 服务也还在（`/connect` 换 cookie 仍正常）。
- 因此不能只看「服务是否启动」判断安装成功：**服务活着不等于浏览器页面没卡死**。

### 1.2 根因：MutationObserver 无限重绘

原 `src/client/bot/index.ts`（已随 Bot 功能整块删除）的旧写法把「模式切换 + 列表重渲染」串进了 MutationObserver 回调：

```ts
observer = new MutationObserver(() => {
  applyMode()      // 切换侧栏显示/隐藏
  renderList()     // 用 innerHTML 重建列表
})
observer.observe(document.body, { childList: true, subtree: true })
```

`renderList()` 每次重建都会产生新的 DOM 变更；观察器配置的是 `document.body { childList: true, subtree: true }`，
于是「重建 → 变更 → 微任务回调 → 再重建」永远清不空微任务队列。浏览器主线程被微任务占满，
页面呈现出来却无法响应输入，Runtime.evaluate / setTimeout 也永远不会返回。

这类故障的特征：

- 服务端完全正常（HTTP 200、WebSocket 连接甚至已建立）。
- 页面首屏可能是完整的，但 15 秒后 evaluate 仍不返回。
- CPU 持续占用（本次复现的 3199 实例 CPU 累计很高）。

### 1.3 修复要点（已落地）

修复版把职责拆开，核心不是「指纹相同就跳过」这一条兜底，而是：

1. **MutationObserver 只做幂等外壳对账**：`handleModeSwitchMutations()` → `scheduleReconcile()`（微任务去重）→ `reconcileModeSwitch()`；回调里只做 `ensureHost()`（位置正确就零写入）、`renderSeg()`、`applyModeDom()`，**永远不重建 DOM 结构**。
2. **位置判断不用 `nextSibling`**：官方侧栏节点之间可能夹着空白文本节点，`nextSibling` 会把「位置正确」误判成「位置不对」，于是每次对账都 `insertBefore` 一次、再触发观察器；改用 `previousElementSibling` / `firstElementChild`。
3. **写 DOM 前先比对**：属性、class、位置与当前值一致就不写，保证观察器第二次回调就收敛。
4. **重复挂载保护**：全局控制器 `__dshSeekerModeSwitchV1__` 在重挂载前 dispose 旧 observer，并摘掉旧 bundle 留下的宿主（监听器绑在旧实例上）。

### 1.4 页面卡死的验证方法

自动（推荐）：

```powershell
node scripts/verify-install.mjs
```

脚本会起临时实例、等 15 秒、用 CDP `Runtime.evaluate` 执行一段
`await new Promise(r => setTimeout(r, 50))` 并读取 `document.body.innerText.length`。
如果主线程被死循环占满，evaluate 20 秒超时，脚本会打印：

```text
FAIL  等待 15s 后页面主线程可响应（Runtime.evaluate 在 20s 内返回） — CDP timeout (20s): Runtime.evaluate
```

手动（ego-browser）：打开启动日志里的 URL（带 token），等 15 秒后执行
`page.evaluate(() => new Promise(r => setTimeout(() => r(performance.now()), 50)))`；
超时或报 `EGO_PAGE_UNRESPONSIVE` 即说明页面主线程卡死。截图只能证明「画出来了」，
不能证明「没卡死」——必须配 evaluate。

## 2. 为什么旧的手工安装 / 延迟重启很危险

> **不要用延迟脚本 kill 当前 DSH 宿主**：典型写法是 `Start-Sleep -Seconds 5; Stop-Process -Name node -Force` 或 `taskkill /IM node.exe /F`。它会杀掉所有 node 进程（包括当前 DSH 宿主和正在安装的脚本），导致 profile 写到一半、锁文件残留、用户会话丢失。安装/升级完成后请让用户手动重启 DSH；验证脚本只按 PID 清理自己启动的临时实例。

### 2.1 手工改 profile + Junction

旧做法常见是这样：

```powershell
# 危险示例，不要照抄
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-seeker-bot" -Target D:\AI\dsh-seeker-bot
# 再手工往 profile 的 cordis.patch.yml 里 insert 15 行
```

问题：

1. **漏写 profile 的 `dsh.profile.bundles`**：`dsh plugin add` 不但装包，还会把 `dsh-seeker-bot` 写进 profile 的 bundles；手工 junction 只产生 node_modules 链接，加载器根本不会把插件当 profile 层加载。
2. **与 bundle patch 双注册**：本包自带 `cordis.patch.yml`，`dsh plugin add` 会自动并入。如果 profile 的 patch 里再手写同样的组件行，同名组件会挂两次：轻则侧栏出现两份、设置页重复，重则 loader 报重复注册。
3. **残留旧插件**：`dsh-chat-plus` 的 bundle 行或 disabled 行没清，和 dsh-seeker-bot 抢同一个侧栏座位；卸载后旧 fiber 还可能活到下次重启。
4. **profile 路径写错（已修）**：此前 README 的「本地开发安装」示例写的是 `D:\AI\Dsh\dsh-seeker-bot`，实际仓库是 `D:\AI\dsh-seeker-bot`（本次检查发现，见第 6 节问题清单）。Junction 指到错误目录后，插件能显示但依赖/资源可能缺失；README 现已改为官方 `dsh plugin add link:D:/AI/dsh-seeker-bot`，不再教用户手工建 junction。

### 2.2 延迟重启 / 定时 kill 当前 DSH 宿主

危险写法（绝对不要用）：

```powershell
Start-Sleep -Seconds 5
Stop-Process -Name node -Force
# 或
taskkill /IM node.exe /F
```

风险：

- **杀的不只是 DSH**：所有 `node.exe`（包括正在执行的安装脚本、其他开发服务、agent 会话宿主）全部被杀；安装可能停在「文件已复制、package.json 未写完」的中间态。
- **profile 原子写被打断**：`dsh plugin add` / atomic-write 正在写 `package.json`、`cordis.patch.yml` 或锁文件时被杀，会留下半截 JSON 或 `.dsh/profiles/node_modules.lock` 死锁，下一次安装报 `atomic-write: timed out waiting for the writer lock`。
- **用户会话丢失**：用户当前 DSH 里的对话、未保存工作区状态可能直接消失。
- **页面状态与日志错位**：你以为「重启后好了」，实际是旧进程没死、新进程起不来，最后同时监听/端口冲突。

正确做法：

- **只在临时实例上操作**：使用独立 `DSH_HOME`（默认 `_tmp/dsh-home`）+ 独立 `--port`，验证完按 PID 清理：`taskkill /PID <临时实例PID> /T /F`，不要按镜像名杀。
- **用户真实 DSH 由用户手动重启**：关闭 DSH 窗口 / 托盘退出，再重新启动。不要用定时脚本。
- `--from-default-profile` 会**替换**同名 profile。它只能在隔离的 `DSH_HOME` 里执行；不带 `DSH_HOME` 执行等于直接覆盖用户真实 profile，这是最大的安装脚枪。

## 3. 正确的安装流程（隔离验证 → 再切换）

### 3.1 准备

- Node.js >= 22（本机验证为 v24.15.0）。
- DSH CLI：`D:\AI\Dsh\dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js`。
- 先构建产物（lib 随仓库提交，但本地改动后必须重新构建）：

```powershell
cd D:\AI\dsh-seeker-bot
node build.mjs
```

预期最后输出：

```text
[dsh-seeker-bot] built lib/index.js + lib/client.js
[dsh-seeker-bot] host runtime imports: node:module, node:fs, ..., undici
```

### 3.2 静态契约先过

```powershell
node scripts/test-bot-install.mjs
node scripts/smoke-host.mjs
```

`test-bot-install.mjs` 检查：

- package.json 五件套：`main` / `exports` / `files` / `dsh.bundle.patch` / `dsh.client`；
- `lib/index.js`、`lib/client.js` 存在，host 无 `@deepseek-ai/*` 运行时 import；
- `cordis.patch.yml` 里的全部 insert 行都能解析到 `packages/*/index.js`（根条目走 `main`）。

`smoke-host.mjs` 是 host 半身裸 node 冒烟；它同时驱动 apply()、路由注册与资产链路。

### 3.3 在隔离 profile 里安装

```powershell
$env:DSH_HOME = "D:\AI\dsh-seeker-bot\_tmp\dsh-home"
$dsh = "D:\AI\Dsh\dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js"

# 1) 从官方 web 模板重建自定义 profile（会替换 seeker-test）
node $dsh --profile seeker-test --from-default-profile web --dump-config | Out-Null

# 2) 安装本地 link 包
node $dsh plugin --profile seeker-test add link:D:/AI/dsh-seeker-bot

# 3) 确认插件组件行已注册
node $dsh --profile seeker-test --dump-config | Select-String dsh-seeker-bot
```

预期看到：

```text
# == @deepseek-ai/dsh-web-app, patched by dsh-seeker-bot
# == dsh-seeker-bot
- id: dsh-seeker-bot
  name: dsh-seeker-bot
...
- id: dsh-seeker-bot-host
  name: dsh-seeker-bot/packages/host
```

### 3.4 一键链路验证

```powershell
node scripts/verify-install.mjs
```

它做的事情（全部可重复）：

1. 断言 `DSH_HOME` 不在 `C:\Users\Anti\.dsh` 内，否则直接拒绝执行；
2. 重建 profile → `dsh plugin add link:...` → `--dump-config` 校验；
3. 起临时端口 `--no-open --port 0`，等启动日志里的 URL/token；
4. 用 `/connect` 换 API cookie（期望 302 + Set-Cookie）；
5. 无头 Chrome/Edge 打开页面，等 15 秒，`Runtime.evaluate` 验证主线程可响应、`body.innerText` 非空、`window.__DSH_BOOT__` 已注入；
6. 截图 `_tmp/verify-install/page.png`；
7. finally 杀临时实例/浏览器，核对用户真实 profile 的 package.json / cordis.patch.yml / cordis.yml 指纹未变。

验收输出应为：

```text
ok    临时实例已停止，端口 xxxxx 已释放
ok    用户真实 profile（C:\Users\Anti\.dsh\profiles\web）未被改动
PASSED — 29 checks
```

### 3.5 切换用户真实 profile

> 只有在 3.4 全部 PASS 后才执行本节。执行前备份 profile 配置：

```powershell
$profileDir = "$env:USERPROFILE\.dsh\profiles\web"
Copy-Item "$profileDir\package.json" "$profileDir\package.json.bak-seeker"
Copy-Item "$profileDir\cordis.patch.yml" "$profileDir\cordis.patch.yml.bak-seeker"
Copy-Item "$profileDir\cordis.yml" "$profileDir\cordis.yml.bak-seeker"

# 用真实 profile 安装（本地开发用 link；正式发布用包名）
dsh plugin --profile web add link:D:/AI/dsh-seeker-bot
# 或：dsh plugin --profile web add dsh-seeker-bot
```

然后**手动**重启 DSH（关闭再打开，不要定时 kill）。重启后：

- 侧栏出现 Work / Bot 切换控件；
- 打开页面 15 秒后仍可点击/滚动（必要时用 ego-browser evaluate 或第 1.4 节方法复核）；
- 设置 → 插件 → dsh-seeker-bot 的「包含的组件」显示插件的组件行。

### 3.6 升级已有安装

```powershell
dsh plugin --profile web remove dsh-seeker-bot
dsh plugin --profile web add dsh-seeker-bot
```

注意：pnpm 一轮内删除数超阈值会报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`；remove 和 add 要分两轮执行，不要串在同一条命令里。

## 4. 正确卸载 / 回滚

### 4.1 正常卸载

```powershell
dsh plugin --profile web remove dsh-seeker-bot
```

- 卸载后本包自带 patch 整体消失，被它停用的内核 `ui-skill` 会自动恢复；这不是 bug。
- 仍要手动重启 DSH；只刷新页面不够（host 半身不热重载）。
- 如果之前手工建过 junction，在确认 `dsh plugin remove` 完成后删除 `$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-seeker-bot`（先确认目标确实指向本仓库，不要删用户其他目录）。

### 4.2 页面已经卡死 / 插件导致无法使用时回滚

1. 不要杀当前 DSH 进程；先尝试正常退出 DSH。
2. 若 DSH 起不来，用隔离环境确认问题仍在：`$env:DSH_HOME = "D:\AI\dsh-seeker-bot\_tmp\dsh-home"; node scripts/verify-install.mjs --no-browser`。
3. 真实 profile 回滚：`dsh plugin --profile web remove dsh-seeker-bot`；如 package.json / cordis.patch.yml 已被写坏，从 `.bak-seeker` 恢复。
4. 手动重启 DSH，确认页面恢复。
5. 如果只想回退插件代码版本：本仓库 `lib/` 随 git 提交，可 `git checkout <已知良好提交> -- lib` 后重新执行安装验证；不要改 profile 里的产物。

### 4.3 旧插件残留

如果在 profile 的 `cordis.patch.yml` 里还看到：

```yaml
- id: dsh-chat-plus
  name: dsh-chat-plus
  disabled: true
```

这是热停用旧 fiber 的过渡行，**下次重启后可以删除**。确认旧插件已从 `package.json` 的 `dependencies` / `dsh.profile.bundles` 中移除，不要让它和 dsh-seeker-bot 同时加载。

## 5. 常见症状 → 定位命令

| 症状 | 先看什么 | 命令 / 判断 |
|---|---|---|
| 页面白屏 / 点击滚动无响应 | 服务是否活、页面 evaluate 是否超时 | `node scripts/verify-install.mjs`；FAIL 在 15s evaluate 就是客户端主线程卡死，不是后端 |
| DSH 启动即崩 / 页面 404 | bundle patch 是否注册、profile bundles | `dsh --profile web --dump-config` 搜 `dsh-seeker-bot`；没有则 `dsh plugin --profile web add ...` 未完成 |
| 插件健康探针 401 | 必须带启动日志里的 token 换 cookie | `/connect?token=...&interactions=none` 拿 302 + Set-Cookie，再带 Cookie 请求；不要把 token 贴到聊天/日志 |
| 探针 404 | 插件 host 路由没挂 / 前缀错 | 确认 dump-config 有主入口；确认测试的是 http://127.0.0.1:<port>，不是用户 3080 |
| `ERR_MODULE_NOT_FOUND: @deepseek-ai/*` | host 产物有外部运行时 import | `node scripts/test-bot-install.mjs`；若 FAIL 重新 `node build.mjs`；不要在 profile 里补 @deepseek-ai 包 |
| 侧栏没有 Work/Bot | client 半身没加载 | 检查 package.json `dsh.client.platform = "web"`、`exports["./client"]`；刷新页面；看浏览器 console |
| 组件出现两份 / 设置页重复 | 手工 insert + bundle patch 双注册 | 删 profile 里手写的 15 行，只保留 `dsh.bundle.patch` 自动注册 |
| pnpm 安装报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | 包里写了 prepare / postinstall | 本包不应有；本地用 `link:`；发布前 `node scripts/test-bot-install.mjs` 会检查 |
| pnpm `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | remove+add 同轮删除超阈值 | remove 与 add 分两轮命令执行 |
| `atomic-write: timed out waiting for the writer lock` | 上次中断留下锁 | 查 `.dsh/profiles/node_modules.lock` 里 PID 是否已不存在，确认后再删 |
| 字体/动画/Office 预览静默失效 | 资产是否随包、路由是否注册 | `node scripts/smoke-host.mjs` 的字体/动画/office 段落；已安装位置跑同一脚本 |

> token 纪律：启动日志里的 `token=...` 等价于当前 DSH 实例的登录凭据。验证脚本只在内存里读取并立即隐藏，任何排障输出都只允许出现 `token=[REDACTED]`。

## 6. 本次 QA 记录与已知问题

### 6.1 已跑命令与结果（2026-10-31）

| 命令 | 结果 |
|---|---|
| `node build.mjs` | PASS：lib/index.js 5.0MB + lib/client.js 3.8MB，仅 node: + undici 外部导入 |
| `node scripts/smoke-host.mjs`（修复前） | FAIL：`expected exactly 28 route registrations, got 29` —— 新增一条 prefix 路由后期望值未同步 |
| `node scripts/smoke-host.mjs`（修复后） | **SMOKE PASSED**：期望值与路由断言同步 |
| `node scripts/test-bot-install.mjs` | **PASSED — 54 checks**；note：`@xenova/transformers` 是可选动态依赖（未装时回退，不影响加载） |
| `node scripts/verify-install.mjs` | **PASSED — 29 checks**：health 200、页面 evaluate 不超时、截图约 68KB、临时实例已清理、用户 profile 未改动 |

> `smoke-host.mjs` 会在系统临时目录建独立 `DSH_HOME`，预置插件自己的状态文件；这是为了固定冒烟基线，不是改产品默认值。

截图：`_tmp/verify-install/page.png`（侧栏可见 Work / Bot 切换控件，说明插件已挂载且页面未卡死；官方预览版弹窗仍在，属于隔离环境未登录账号的正常现象）。

### 6.2 已知问题（按严重度）

1. **[已修复] README 的本地开发 junction 目标写错（曾为高）**：README「本地开发安装」曾写 `-Target D:\AI\Dsh\dsh-seeker-bot`，实际仓库是 `D:\AI\dsh-seeker-bot`；照抄会得到空的/错误的 junction，随后 ERR_MODULE_NOT_FOUND 或资源 404。当前 README 已改为 `dsh plugin --profile web add link:D:/AI/dsh-seeker-bot` 并链接本手册，避免手工 junction 与手改 profile。
2. **[中] `build.mjs` 的 `assertHostExternals()` 会漏掉带注释的动态 import**：源码 `await import(/* @vite-ignore */ "@xenova/transformers")` 中，注释让构建守卫的 `import\s*\(\s*["']` 正则匹配不到；`lib/index.js` 实际保留了 `@xenova/transformers` 动态引用。当前行为是可选能力：未安装时自动回退混合检索，不影响插件加载；但守卫应改为先剥注释再扫描，并把 `@xenova/transformers` 列入显式可选依赖白名单，避免未来误把必需依赖当可选放过。
3. **[中] 用户真实 DSH 里可能仍有 3199 旧实例 / 旧插件残留**：本次验证前发现 `--profile seeker-test --port 3199` 的旧 Node 进程仍在监听（PID 24176，CPU 累计高）。本任务未擅自杀它（它不是本脚本启动的实例）；排障/切换真实 profile 前应确认它是否还需要，若不需要按 PID 正常清理，避免端口/资源占用和「以为已停止」的误判。
4. **[低] `dsh.client.inject` 列出 11 个模块，但 `lib/client.js` 实际只 require `@deepseek-ai/dsh-client-ui-primitives`**：其余注入行当前依赖运行时注入表按名匹配，在 0.1.2 模块表变化时可能成为隐性风险；建议每次升级 DSH 后跑一次 `scripts/test-bot-install.mjs` + 真机页面探针。
5. **[低] 官方预览版/登录弹窗会遮挡首屏截图**：验证脚本会尝试点「继续」，但登录弹窗仍可能出现；截图用于证明「页面可交互/插件已挂载」足够，若需纯净截图可在隔离 profile 里先配置账号或给脚本加 `--no-browser` 后手工点选。

## 7. 相关文件

- 安装契约测试：`scripts/test-bot-install.mjs`
- 隔离安装验证：`scripts/verify-install.mjs`
- host 冒烟：`scripts/smoke-host.mjs`
- 本次验证产物：`_tmp/verify-install/page.png`、`summary.json`、`dump-config-after-install.txt`
- 构建入口：`build.mjs` / `package.json` / `cordis.patch.yml`
