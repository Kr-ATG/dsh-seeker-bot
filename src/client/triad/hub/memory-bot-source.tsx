/**
 * memory-bot-source — 侧栏「操作间 → 记忆 → Bot」二级菜单的**数据源**。
 *
 * ── 为什么需要它（2026-11 用户要求「记忆页面增加二级菜单适配 bot」）──
 * 记忆库从 schema v6 起按 owner 隔离（`work` / `bot:<id>`），但侧栏记忆的
 * 二级菜单只有「范围」维度（全部工作区 / 全局 / 各工作区），于是：
 *   · 工作台的记忆页看不到任何 Bot 的记忆（列表默认按 owner=work 过滤）；
 *   · Bot 的记忆只能进 Bot 设置卡里看，能力比记忆页少一截。
 * 这里补上「归属」维度的数据源：从 Personal Agent 的名册里读出 Bot 列表，
 * 转成侧栏子项，点一项就把记忆页切到那个 Bot 的资料库。
 *
 * ── 为什么读 localStorage 而不是宿主接口 ─────────────────────────────
 * Bot 名册是**前端状态**（`pa:state:v1`，Personal Agent 的 store 持久化），
 * 宿主侧没有「列出所有 Bot」的路由——记忆引擎只知道 owner 字符串，不知道
 * Bot 叫什么。侧栏与 Bot 界面同源同域，直接读那份名册是唯一不需要新增
 * 宿主接口的做法；读不到（从没进过 Bot 模式 / 清过缓存）时返回空数组，
 * 侧栏不画 Bot 分组，其它菜单照常可用。
 *
 * ── 刷新时机 ────────────────────────────────────────────────────────
 * 名册只在 Bot 模式里变（新建 / 改名 / 删除 Bot）。Bot 模式的 store 每次
 * 落盘会广播 `pa:state-changed`（见 personal/store.tsx 的持久化 effect），
 * 侧栏订阅它重新读一次；另外监听 `storage` 事件兜住「另一个标签页改了名册」。
 * 不做轮询：名册是低频数据，而侧栏本来就有 1.5s 的 DOM 对账轮询，再叠一层
 * 读盘没有收益。
 *
 * 本模块只依赖协议层（workbench-intent）与注册表类型，不碰 DOM 结构。
 */

import type { JSX } from 'react'
import type { NavChildDef } from './nav-registry.js'
import { requestMemoryScope, type MemoryScopeIntent } from './workbench-intent.js'

/** Personal Agent 名册的持久化键（与 src/client/personal/store.tsx 的 STORAGE_KEY 同源）。 */
export const BOT_ROSTER_STORE = 'pa:state:v1'

/** Bot 模式落盘后广播的事件名（侧栏据此刷新名册）。 */
export const BOT_ROSTER_EVENT = 'pa:state-changed'

/** 「Bot」分组行在二级菜单里的 id（与任何作用域值都不同，不会被高亮）。 */
export const BOT_MEMORY_GROUP_ID = 'group-bots'

/** 「全部 Bot」聚合项的 id（与 `MemoryScopeIntent` 的 'bots' 同构）。 */
export const ALL_BOTS_CHILD_ID = 'bots'

/** 名册里的一台 Bot（只取侧栏要用的字段）。 */
export interface BotRosterEntry {
  readonly id: string
  readonly name: string
  readonly isMain: boolean
}

/**
 * 机器人图标（Bot 分组行与「全部 Bot」固定项共用）。
 *
 * 与记忆页条目里的来源徽章**必须是同一枚形状**：两处画得不一样，用户会以为
 * 是两种不同的东西（工作区那两枚图标的注释里踩过同一个坑）。
 */
export function BotGroupIcon({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="7.5" width="16" height="12" rx="3.5" />
      <path d="M12 7.5V4.5" />
      <circle cx="12" cy="3.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="13" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.1" fill="currentColor" stroke="none" />
      <path d="M9.5 16.5h5" />
    </svg>
  )
}

/** 读持久化层（隐私模式 / node 环境 / 没进过 Bot 模式都返回 null）。 */
function readRosterRaw(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const value = localStorage.getItem(BOT_ROSTER_STORE)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

/**
 * 读 Bot 名册。
 *
 * 三条容错（都按「静默降级」处理，侧栏菜单绝不因为名册脏数据而报错）：
 *  · JSON 解析失败 / 顶层不是对象 → 空数组；
 *  · `bots` 不是数组 → 空数组；
 *  · 单条缺 id 或 id 不是字符串 → 跳过该条（没有 id 就没法写 owner 意图）。
 *
 * 顺序保持名册原顺序：主 Bot 通常排在第一位，用户建 Bot 的顺序也是他心里的顺序。
 * @returns 名册（读不到时为空数组）。
 */
export function readBotRoster(): BotRosterEntry[] {
  const raw = readRosterRaw()
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const bots = (parsed as { bots?: unknown }).bots
  if (!Array.isArray(bots)) return []
  const out: BotRosterEntry[] = []
  for (const item of bots) {
    if (item === null || typeof item !== 'object') continue
    const candidate = item as { id?: unknown; name?: unknown; isMain?: unknown }
    if (typeof candidate.id !== 'string' || candidate.id === '') continue
    out.push({
      id: candidate.id,
      name: typeof candidate.name === 'string' && candidate.name.trim() !== '' ? candidate.name.trim() : '未命名 Bot',
      isMain: candidate.isMain === true,
    })
  }
  return out
}

/**
 * 名册 → 侧栏子项（一个「Bot」分组行 + 各 Bot 叶子）。
 *
 * 结构照档案场景的三级分组（`vaultSceneChildren`）：分组行点行只展开/收起，
 * 不执行 run；叶子项的 id 与 `MemoryScopeIntent` 天然同构（`bots` / `bot:<id>`），
 * 所以 activeChild 能直接拿 `readMemoryScope()` 的返回值比对。
 *
 * 空名册返回空数组（**不是**「只有分组行」的空壳）：从没进过 Bot 模式的用户
 * 不该在记忆菜单里看到一个点开全是空的「Bot」。
 * @param bots - 名册。
 * @param icon - 分组行与「全部 Bot」固定项的图标（调用方注入，保持与所在菜单同一套图形语言）。
 * @returns 侧栏子项（可能为空）。
 */
export function botsToChildren(
  bots: readonly BotRosterEntry[],
  icon: (props: { size: number }) => JSX.Element = BotGroupIcon,
): NavChildDef[] {
  if (bots.length === 0) return []
  const leaves: NavChildDef[] = [
    {
      id: ALL_BOTS_CHILD_ID,
      label: '全部 Bot',
      icon,
      order: 10,
      run: () => { requestMemoryScope('bots') },
    },
    ...bots.map((bot, index) => ({
      id: `bot:${bot.id}`,
      label: bot.name,
      // 数据驱动的项不画图标（二级菜单行高 30px，多一枚图标只会挤成彩色噪点，
      // 见 nav-registry.ts 的 NavChildDef.icon 注释）。
      order: 20 + index * 10,
      hint: bot.isMain ? `主 Bot · ${bot.id}` : bot.id,
      run: () => { requestMemoryScope(`bot:${bot.id}` as MemoryScopeIntent) },
    })),
  ]
  return [{
    id: BOT_MEMORY_GROUP_ID,
    label: 'Bot',
    icon,
    // 排在全部工作区（30 起）之后：工作区是记忆页的「老主场」，Bot 是新增维度。
    order: 500,
    run: () => {},
    children: leaves,
  }]
}

/**
 * 订阅名册变化（Bot 模式落盘广播 + 跨标签页 storage 事件）。
 *
 * 两种来源都要挂：
 *  · 同页面内 Bot 模式新建/改名/删除 → 自定义事件 `pa:state-changed`；
 *  · 另一个标签页改了名册 → 浏览器原生 `storage` 事件（自定义事件跨标签页不传）。
 * @param listener - 名册可能变化时调用（调用方自己重新 readBotRoster 并推送）。
 * @returns 取消订阅函数。
 */
export function subscribeBotRoster(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  let disposed = false
  const onLocal = (): void => { if (!disposed) listener() }
  const onStorage = (event: StorageEvent): void => {
    if (disposed) return
    // key 为 null = 整个 localStorage 被清空，同样要重读（名册会变空）。
    if (event.key !== null && event.key !== BOT_ROSTER_STORE) return
    listener()
  }
  window.addEventListener(BOT_ROSTER_EVENT, onLocal)
  window.addEventListener('storage', onStorage)
  return () => {
    disposed = true
    window.removeEventListener(BOT_ROSTER_EVENT, onLocal)
    window.removeEventListener('storage', onStorage)
  }
}
