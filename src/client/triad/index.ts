/**
 * dsh-triad client 半身（搬迁进 dsh-seeker-bot，三工作台融合）。
 *
 * 挂载以下模块，每个独立 try/catch，一个失败不拖垮其他：
 *
 *  - workbench  → 统一工作台（记忆 / 能力 / 连接器 / 画廊 / 档案 / 系统提示词 / 同步设置）
 *  - memory     → 官方 main 页 + sidebar.panellist 菜单行（composer 注入开关已全部下线）
 *  - skills     → 官方 main 页 + sidebar.panellist 菜单行 + `/` slash source + skill tool row
 *  - responsive → 窄屏全局覆盖样式
 *
 * 定时自动化（原 automation 模块）已于 2026-09-28 删除：官方
 * `@deepseek-ai/dsh-experimental-schedule-bundle` 提供了任务页与 schedule_* 工具。
 *
 * 2026-10-04 入口改版：记忆 / 能力两个工作台原先都是「自绘侧边栏导航行
 * + createPortal 到 body 的浮层抽屉」，现已全部改走官方座位（`main` 页 +
 * `sidebar.panellist` 菜单行），与官方「自动化任务」页完全同座位——见
 * `./panel-seat.tsx`。原「用量」工作台（自绘紧凑小卡入口）已于 2026-11 整块删除。
 *
 * 座位与命名空间（locale namespace / 路由前缀）原样保留，dsh-triad 退役后用户
 * 零迁移。所有数据经 host 半身的 loopback-only HTTP 路由以 same-origin fetch
 * 获取，不修改任何 DSH 源码。
 *
 * 与 dsh-seeker-bot 主入口的关系：主线程在 `src/client/index.ts` 里调用
 * `applyTriadClient(ctx)`；`inject` 白名单由主线程统一声明，此处不导出。
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { applyWorkbenchSeat } from './hub/seat.js'
import { applyMemoryClient } from './memory/index.js'
import { apply as applySkillSource } from './skill-source/index.js'
import { injectResponsiveStyles } from './responsive.js'

/** Run one module's apply, logging and swallowing any failure. */
function safe(label: string, run: (ctx: ClientContext) => void, ctx: ClientContext): void {
  try {
    run(ctx)
  } catch (error) {
    console.error(`[dsh-seeker-bot] triad ${label} failed:`, error)
  }
}

/** Apply the dsh-seeker-bot browser half. */
export function applyTriadClient(ctx: ClientContext): void {
  safe('responsive styles', (c) => { c.effect(injectResponsiveStyles, 'dsh-seeker-bot: triad responsive styles') }, ctx)
  // 统一工作台（记忆、能力、连接器、画廊、档案、系统提示词、同步设置）
  safe('workbench', applyWorkbenchSeat, ctx)
  // 记忆模块：只剩 locale 字典注册（composer 注入开关已全部下线，见 memory/index.ts）
  safe('memory locale', applyMemoryClient, ctx)
  // 斜杠命令与技能工具行源
  safe('skills source', applySkillSource, ctx)
}
