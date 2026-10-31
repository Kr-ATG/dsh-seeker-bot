/**
 * dsh-seeker-bot — Bot 对话流头部（Bot 名称 / 岗位 / 状态 + 五个页签）。
 *
 * 只在 Bot 模式挂载，插在官方 conversation.header 之前；不替换官方 header，
 * 避免把侧栏折叠、模型选择等官方控件一并拿掉。
 *
 * 页签：
 *  · 会话：留在当前对话；
 *  · 日程：打开 Bot 详情抽屉（内含日程区）；
 *  · 技能 / 用量：走官方 layout.selectPanel（与操作间同一入口）；
 *  · 审批：优先官方 approval 面板，没有就打开 Bot 抽屉。
 *
 * @module
 */

import { getBotConsoleStore } from './store.ts'
import { openBotDrawer } from './drawer.ts'

const HEADER_ID = 'skb-bot-header'

type TabId = 'chat' | 'routines' | 'skills' | 'approval' | 'usage'

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'chat', label: '会话' },
  { id: 'routines', label: '日程' },
  { id: 'skills', label: '技能' },
  { id: 'approval', label: '审批' },
  { id: 'usage', label: '用量' },
]

let headerEl: HTMLElement | null = null
let active: TabId = 'chat'
let ctxRef: any = null

function selectedBot(): any {
  const snapshot = getBotConsoleStore().getSnapshot()
  return snapshot.bots.find((bot: any) => bot.id === snapshot.selected) ?? snapshot.bots[0] ?? null
}

function statusText(bot: any): string {
  if (bot === null) return ''
  if (bot.status === 'working') return '工作中'
  if (bot.status === 'needs-you') return '等你确认'
  if (bot.status === 'unread') return '有新回复'
  return bot.paused === true ? '已暂停' : '待命'
}

function openPanel(id: string | null): boolean {
  try {
    const layout = ctxRef?.get?.('layout')
    if (layout && typeof layout.selectPanel === 'function') {
      layout.selectPanel(id)
      return true
    }
  } catch { /* 服务不可用时忽略 */ }
  return false
}

function activate(tab: TabId): void {
  active = tab
  for (const button of headerEl?.querySelectorAll<HTMLButtonElement>('.skb-bot-tab') ?? []) {
    button.dataset.active = button.dataset.tab === tab ? 'true' : 'false'
  }
  if (tab === 'chat') {
    openPanel(null)
    return
  }
  if (tab === 'routines') {
    const bot = selectedBot()
    if (bot !== null) openBotDrawer(bot)
    return
  }
  if (tab === 'skills') {
    if (!openPanel('skills')) {
      const bot = selectedBot()
      if (bot !== null) openBotDrawer(bot)
    }
    return
  }
  if (tab === 'usage') {
    if (!openPanel('usage')) {
      const bot = selectedBot()
      if (bot !== null) openBotDrawer(bot)
    }
    return
  }
  if (tab === 'approval') {
    if (!openPanel('approval')) {
      const bot = selectedBot()
      if (bot !== null) openBotDrawer(bot)
    }
  }
}

function build(): HTMLElement {
  const root = document.createElement('div')
  root.id = HEADER_ID
  root.className = 'skb-bot-header'

  const identity = document.createElement('div')
  identity.className = 'skb-bot-header__identity'
  const avatar = document.createElement('span')
  avatar.className = 'skb-bot-header__avatar'
  const name = document.createElement('span')
  name.className = 'skb-bot-header__name'
  const role = document.createElement('span')
  role.className = 'skb-bot-header__role'
  const status = document.createElement('span')
  status.className = 'skb-bot-header__status'
  identity.appendChild(avatar)
  identity.appendChild(name)
  identity.appendChild(role)
  identity.appendChild(status)
  root.appendChild(identity)

  const tabs = document.createElement('nav')
  tabs.className = 'skb-bot-tabs'
  for (const tab of TABS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'skb-bot-tab'
    button.dataset.tab = tab.id
    button.textContent = tab.label
    button.addEventListener('click', () => { activate(tab.id) })
    tabs.appendChild(button)
  }
  root.appendChild(tabs)
  return root
}

function sync(): void {
  if (typeof document === 'undefined') return
  const native = document.querySelector('[data-slot="conversation.header"]') as HTMLElement | null
  const parent = native?.parentElement ?? (document.querySelector('[data-slot="main"]') as HTMLElement | null)
  if (parent === null) return
  if (headerEl === null) headerEl = document.getElementById(HEADER_ID) as HTMLElement | null
  if (headerEl === null) {
    headerEl = build()
    parent.insertBefore(headerEl, native ?? parent.firstChild)
  } else if (headerEl.parentElement !== parent) {
    parent.insertBefore(headerEl, native ?? parent.firstChild)
  }
  const bot = selectedBot()
  const avatar = headerEl.querySelector('.skb-bot-header__avatar') as HTMLElement | null
  const name = headerEl.querySelector('.skb-bot-header__name') as HTMLElement | null
  const role = headerEl.querySelector('.skb-bot-header__role') as HTMLElement | null
  const status = headerEl.querySelector('.skb-bot-header__status') as HTMLElement | null
  if (avatar !== null) {
    avatar.style.background = bot?.avatar?.color ?? 'var(--dsw-alias-bg-layer-2, #e8eaed)'
    avatar.textContent = typeof bot?.name === 'string' ? bot.name.slice(0, 1) : 'B'
  }
  if (name !== null) name.textContent = typeof bot?.name === 'string' ? bot.name : 'Bot'
  if (role !== null) role.textContent = typeof bot?.role === 'string' ? bot.role : ''
  if (status !== null) status.textContent = statusText(bot)
  for (const button of headerEl.querySelectorAll<HTMLButtonElement>('.skb-bot-tab')) {
    button.dataset.active = button.dataset.tab === active ? 'true' : 'false'
  }
}

/** 装配 Bot 对话头部；Work 模式隐藏，Bot 模式显示。 */
export function applyBotHeader(ctx: any): void {
  ctxRef = ctx
  if (typeof document === 'undefined') return
  const store = getBotConsoleStore()
  store.subscribe(() => { sync() })
  const win = typeof window === 'undefined' ? undefined : window
  if (win !== undefined) {
    win.addEventListener('skb:refresh', () => { sync() })
  }
  sync()
  const timer = win === undefined ? 0 : win.setInterval(sync, 1500)
  // 插件卸载时清掉定时器；旧 bundle 的 sync 由 headerEl 复用与幂等写保护兜底。
  if (win !== undefined) {
    win.addEventListener('beforeunload', () => { if (timer !== 0) win.clearInterval(timer) }, { once: true })
  }
}
