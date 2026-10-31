/**
 * dsh-seeker-bot — 侧栏 Bot 名册的 DOM 渲染（纯函数式，无观察器 / 无副作用）。
 *
 * 关键结构约束（本次修 MutationObserver 死循环的核心）：
 *  · 本文件**只**在状态变化时被调用，绝不从 MutationObserver 回调里调用；
 *  · 每个容器记住上一次的渲染指纹，指纹相同直接 return false，连 innerHTML
 *    都不碰 —— 即使将来有调用方误接进观察器，也只会多做一次字符串比较，
 *    不会产生「写 DOM → 观察器 → 再写 DOM」的循环。
 */

import {
  attentionBadge,
  avatarOf,
  groupRoster,
  rosterRenderKey,
  SHAPE_PATHS,
  type BotRecord,
} from './model.ts'

export interface RosterView {
  readonly mode: 'work' | 'bot'
  readonly bots: readonly BotRecord[]
  readonly selected: string
}

export interface RosterHandlers {
  readonly onSelect: (bot: BotRecord) => void
  readonly onEdit: (bot: BotRecord) => void
}

const LAST_KEYS = new WeakMap<object, string>()

function avatarElement(bot: BotRecord): HTMLElement {
  const avatar = avatarOf(bot)
  const el = document.createElement('div')
  el.className = 'skb-avatar'
  el.style.background = avatar.color
  el.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">'
    + (SHAPE_PATHS[avatar.shape] ?? SHAPE_PATHS.whale)
    + '</svg>'
  return el
}

function moreButton(bot: BotRecord, onEdit: (bot: BotRecord) => void): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'skb-row__more'
  btn.title = 'Bot 设置'
  btn.setAttribute('aria-label', '编辑 ' + bot.name)
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="2.1" />'
    + '<path d="M8 1.4l1 1.5 1.8-.45.45 1.8 1.5 1-1.5 1 .45 1.8-1.8.45-1 1.5-1-1.5-1.8.45L5.65 9.1 4.15 8.1l1.5-1-.45-1.8 1.8-.45z" />'
    + '</svg>'
  btn.addEventListener('click', (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    onEdit(bot)
  })
  return btn
}

/**
 * 渲染名册。
 * @returns true 表示这次真的重写了容器（供调试计数 / 测试断言）。
 */
export function renderRoster(container: HTMLElement, view: RosterView, handlers: RosterHandlers): boolean {
  const key = rosterRenderKey(view)
  if (LAST_KEYS.get(container) === key) return false
  LAST_KEYS.set(container, key)

  container.innerHTML = ''
  const groups = groupRoster(view.bots)
  if (groups.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'skb-empty'
    empty.textContent = '还没有 Bot。点上面的「新建 Bot」开始。'
    container.appendChild(empty)
    return true
  }

  for (const group of groups) {
    const title = document.createElement('div')
    title.className = 'skb-sec'
    title.textContent = group.label
    container.appendChild(title)

    for (const bot of group.bots) {
      const row = document.createElement('div')
      row.className = 'skb-row' + (view.selected === bot.id ? ' skb-row--active' : '')
      row.setAttribute('data-bot-id', bot.id)
      row.setAttribute('role', 'button')
      row.setAttribute('tabindex', '0')
      row.addEventListener('click', () => { handlers.onSelect(bot) })
      row.addEventListener('keydown', (event: Event) => {
        const keyboard = event as KeyboardEvent
        if (keyboard.key !== 'Enter' && keyboard.key !== ' ') return
        keyboard.preventDefault()
        handlers.onSelect(bot)
      })

      row.appendChild(avatarElement(bot))

      const meta = document.createElement('div')
      meta.className = 'skb-meta'
      const name = document.createElement('div')
      name.className = 'skb-name'
      name.textContent = bot.name
      const role = document.createElement('div')
      role.className = 'skb-role'
      role.textContent = bot.role
      meta.appendChild(name)
      meta.appendChild(role)
      row.appendChild(meta)

      const badge = attentionBadge(bot.status)
      if (badge !== null) {
        const el = document.createElement('span')
        el.className = 'skb-badge skb-badge--' + badge.kind
        el.textContent = badge.label
        el.title = badge.label
        row.appendChild(el)
      }

      if (bot.primary === true) {
        const star = document.createElement('span')
        star.className = 'skb-star'
        star.textContent = '★'
        star.title = '主 Bot'
        star.setAttribute('aria-label', '主 Bot')
        row.appendChild(star)
      }

      row.appendChild(moreButton(bot, handlers.onEdit))
      container.appendChild(row)
    }
  }
  return true
}

/** 测试 / 热重载清理用：忘掉某个容器的渲染指纹。 */
export function forgetRosterRenderKey(container: HTMLElement): void {
  LAST_KEYS.delete(container)
}
