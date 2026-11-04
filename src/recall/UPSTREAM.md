# 消息撤回 / 编辑重发 — 上游来源与移植约定

本目录（`src/recall/`）是独立插件 [dsh-recall-plugin](https://github.com/limbo947/dsh-recall-plugin)
的 **vendor 移植**，把「消息撤回」整块能力内嵌进 dsh-seeker-bot：装了本插件就有
「↶ 撤回」「✎ 编辑」「‹ X/N ›」，不再需要单独安装一个插件包。

## 上游坐标

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/limbo947/dsh-recall-plugin |
| 版本 | v2.6.3 |
| 提交 | `2102f839a5770d14fa2734cd46f49f730356a278`（2026-11-03） |
| 许可 | MIT（见下方全文） |

## 目录结构

| 路径 | 来源 | 说明 |
| --- | --- | --- |
| `host/` | 上游 `src/host/` 全量 | 快照 / 回退 / 维护 / HTTP 端点 / 配置域 |
| `types/` | 上游 `src/types/` 全量 | 跨域类型与双平台脚本契约（仅类型 + 事件名常量） |
| `client/` | 上游 `src/client/` 全量 | 撤回按钮 / 确认面板 / 编辑卡 / 版本翻页器 / 设置页三张卡片 |
| `client/apply.ts` | **本仓库新增** | 取代上游 `entry.ts`：改成普通模块导出 `applyRecallClient(ctx)`，由 `src/client/index.ts` 在主 bundle 内延迟挂载 |
| `host/index.ts` | 上游同名文件 | 导出改名：`applyRecallHost` / `recallInjects` / `RecallConfig`，去掉对 `@deepseek-ai/dsh-settings` 的硬 import |
| `host/config-file.ts` | **本仓库新增** | 配置持久化兜底（见「移植适配点」第 5 条） |

其余文件与上游逐字节一致；升级上游时按 sha1 对比即可定位差异。

## 移植适配点（相对上游的**全部**改动）

1. **不再注册独立 client bundle**。上游 `src/client/entry.ts` 调
   `window.__ModuleLoader__.load({id:'dsh-recall-plugin', factory})`；本仓库只有
   一个 client bundle（`lib/client.js`，id `dsh-seeker-bot`），宿主装载的是我们的
   factory。`client/apply.ts` 改成 `export function applyRecallClient(ctx)`，内部
   `import React from 'react'`（bundle banner 已把平台模块表封装成 require）后直接
   调 `createApp(React)(ctx)`，外面包一层 try/catch（只记日志不重抛，撤回坏掉不连坐
   本插件其它功能）。
2. **settings 卡片的槽位 key**：`plugins.bundle.config` 从上游包名
   `dsh-recall-plugin` 改为本包名 `dsh-seeker-bot`（插件管理页按当前 bundle 包名
   分发该卡）；`settings.plugin.item` 的 key 保持 `dsh-recall`（host settings
   namespace 语义，改包名会让交集为空）。
3. **host 去掉 `@deepseek-ai/dsh-settings` 硬 import**。上游 `host/index.ts` 裸导入
   该包只为调用 0.1.1-rc.2 的旧面独立函数 `installSettingsSection`。本仓库 host
   产物必须对 `@deepseek-ai/*` 零运行时依赖（`build.mjs` 的
   `assertHostExternals`），故传空模块桩——旧面独立函数路径跳过，0.1.2-alpha.2+
   的 `settings.installSection` / `register` 与 0.1.7+ 的 `SettingsForms` 分支都
   不受影响（settings-bridge 按运行时实例的 API 分派）。
4. **导出改名**：`name`/`inject`/`Config`/`apply` → `recallHostId` /
   `recallInjects` / `RecallConfig` / `applyRecallHost`，避免与宿主入口同名语义混淆；
   `applyRecallHost` 第二参数放宽为 `unknown`，接受 `undefined` 或本插件 config
   里的 `recall` 段。
5. **配置持久化改文件源**（`host/config-file.ts`，本仓库新增）。上游把设置页保存
   压在 `settings.update(profile-entry-id, patch)` 上；本插件没有向 loader 导出
   Config schema（apply 的 config 是自由形状），新面 `update` 很可能因 ns/schema
   不匹配而失败——那会让「撤回配置卡片」看起来能点、保存却报错。改为落在
   `$DSH_HOME/dsh-recall-snapshots/config.json`（与快照容器同目录），写成功即刻
   合并进运行中的 cfg（热更不依赖 loader 事件）；settings 面仍按原逻辑尝试注册，
   失败不影响配置读写。
6. **未引入版本门禁**。上游只在 `peerDependencies` 与发布脚本里做 DSH 版本开窗，
   运行时没有拦截逻辑，故无需删改。本机核验版本 0.2.2-alpha.3。
7. **默认语义收紧为「只撤回对话」**（2026-11-04，用户现场需求，**行为差异，非接缝**）：
   - `messageOnly` 默认 `true`（上游 `false`）——默认不写文件快照，撤回不碰项目文件、也省磁盘与 CPU；
   - 新增 `fileRollbackEnabled` 默认 `false`——文件回退总开关。关着时 preview **不跑 diff、不列
     文件清单**（按 `files:false` 返回，client 显示「只有对话回退」），execute **强制 session-only**
     （即便旧 client 传 `both`、即便库里有升级前拍的旧快照）。打开后才走上游的「文件与对话一并回退」。
   - 动机：上游快照是**目录级**的，分不清「哪个会话改的」。同一工作区开多个会话时，撤回一条聊天
     消息会把别的会话刚改的文件一起退回去（现场实测：撤回一条「你是谁」，清单里是另一个会话刚修的
     两个前端文件 + 重新构建的 lib/client.js）。用户的诉求是「像聊天软件那样撤回」。
   - 想恢复上游行为：`messageOnly=false` + `fileRollbackEnabled=true`（配置卡片两个开关）。

## 与宿主既有 UI 的座位关系

- `conversation.chat.node`：撤回只注册 `user` / `steering` 两个 key（按现有
  entries 取「最低值 - 1」避让）；本插件自有的 `assistant-step` / `turn-process`
  （priority -100）key 不同，互不覆盖。
- `conversation.chat.assistant-actions`（list 槽）：版本翻页器 `recall-version-pager`
  （order 20）与截图按钮 `chat-flow-screenshot`（order 5）id 不同、共存。
- 撤回完全不注册 `sidebar.workspaces.session.menu.item`，与会话删除菜单项无冲突。

## 上游已知边界（原样继承，非本移植引入）

- 快照只在**消息发送时**创建：插件启用前的历史消息没有快照、不显示撤回按钮。
- 快照是**尽力捕获**：从收到消息到 `git add` 之间有约 0.5–1.5 秒窗口（Windows 上
  仅一次 PowerShell 启动就占约 0.4 秒），秒级任务若在这个窗口内改完文件，该快照会
  连带捕获本轮改动（撤回时文件回退成为空操作，对话回退不受影响）。
- 会话**第一条**用户消息无法回退对话（fork 需要更早的 turn 边界），只能回退文件；
  「编辑并重发」同理会被明确拒绝。
- 目标工作区的 agent 正在运行时拒绝撤回（先停止 agent）。
- 工作区根路径自身超过 260 字符（Windows MAX_PATH）时不支持撤回；嵌套 git 仓库
  与 win32 目录重解析点（junction / 目录符号链接）不参与快照。
- 版本翻页器的家族表存在浏览器 `localStorage`（键 `dsh-recall:versions:*`），
  换浏览器/清缓存后翻页器不再显示历史版本（会话与归档本身不受影响）。
- 撤回后必然 fork 出新会话（DSH 唯一的「回到某条消息之前」通道就是
  `sessions.fork`）；插件能控制的是原会话归档与否（`archiveOriginal`，默认归档）。

## 维护约定

- **升级上游**：`git clone` 上游（或 `git pull`）→ 与 `src/recall/` 做 sha1 全量
  对比 → 只把上游改动应用到 `host/` `client/` `types/`（不要覆盖上面六条适配点）
  → `node build.mjs` → `node scripts/test-recall.mjs` → 冒烟脚本 → 真机验收撤回链路。
- **不要**在 `src/recall/` 里改文案、改算法、加功能：这里的作用是「保持可对比」。
  需要改行为时优先在上游提 PR，或在本仓库外层（`src/host.ts` / `src/client/index.ts`）
  做接线层适配。
- 类型检查：本仓库不携带 `typescript` 依赖，`src/recall/` 不做本地 tsc 门禁；类型
  由上游项目自己的 `npm run typecheck` 保证。本地门禁是 esbuild 构建（含注入式
  CSS 反引号守卫）、`node scripts/test-recall.mjs` 装配冒烟与两侧既有冒烟。

## 上游许可证

```
MIT License

Copyright (c) 2026 dsh-recall-plugin contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
