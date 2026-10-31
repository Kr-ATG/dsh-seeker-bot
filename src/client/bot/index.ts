/**
 * dsh-seeker-bot — 侧栏 Work / Bot 双模式与 Bot 名册（client 半身）。
 *
 * 纯 DOM 注入，不依赖 React 组件树：官方的侧栏容器在每次主题/布局变化时
 * 可能重建，这里用 ResizeObserver 级别的幂等策略——host 节点只建一次，
 * 锚点丢了就重新挂。
 *
 * 行为：
 *   Work 模式 → 官方「工作区 / 会话列表」原样显示
 *   Bot  模式 → 给官方区打 data-skb-hide，显示 Bot 名册
 *
 * 数据：GET /api/seeker-bot/state（与 host 的 Bot 数据层同源）。
 */

const ANCHOR = '[data-slot="sidebar.workspaces"]'
const HOST_ID = 'skb-sidebar-host'
const STYLE_ID = 'skb-styles'
const HIDE_ATTR = 'data-skb-official-hidden'

interface BotRecord {
  id: string
  name: string
  role: string
  avatar: { shape: string; color: string }
  primary?: boolean
  pinned?: boolean
  section?: string
  hidden?: boolean
  status?: string
}

interface BotStatePayload {
  ok?: boolean
  bots?: BotRecord[]
  ui?: { mode?: 'work' | 'bot' }
}

const SHAPES: Record<string, string> = {
  whale: '<path d="M3.6 13.8c0-3.9 3.1-7 7-7 2.5 0 4.7 1.3 5.9 3.3l3.6-1.4-1.6 4.9c.1.5.1 1 .1 1.5 0 3.5-2.8 6.3-6.3 6.3H9.9c-3.5 0-6.3-2.8-6.3-6.3z"/>',
  orbit: '<circle cx="12" cy="12" r="3.2"/><ellipse cx="12" cy="12" rx="9" ry="4" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(-28 12 12)"/>',
  cube: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M12 12l8-4.6M12 12L4 7.4M12 12v9.2" stroke="rgba(0,0,0,.25)" stroke-width="1.1" fill="none"/>',
  leaf: '<path d="M20.2 4c0 8.8-5.2 14-11.9 14H4.4C4.4 9.2 9.6 4 16.3 4z"/>',
  spark: '<path d="M12 2.6l2.4 6.1 6.1 2.4-6.1 2.4L12 19.6l-2.4-6.1-6.1-2.4 6.1-2.4z"/>',
  ring: '<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="3.2"/>',
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
.skb-host{display:flex;flex-direction:column;gap:8px;padding:8px 10px 6px}
.skb-mode{display:flex;gap:2px;padding:3px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.skb-mode button{flex:1;height:26px;border:0;border-radius:6px;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-secondary,#61666b);background:none;cursor:pointer}
.skb-mode button.on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.06),0 0 0 1px var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.skb-list{display:flex;flex-direction:column;gap:1px;max-height:46vh;overflow:auto}
.skb-row{display:flex;align-items:center;gap:8px;padding:6px 7px;border-radius:7px;cursor:pointer}
.skb-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.skb-row.on{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.07))}
.skb-av{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;color:#fff;flex:none}
.skb-av svg{width:14px;height:14px;fill:currentColor;stroke:none}
.skb-meta{flex:1;min-width:0}
.skb-name{font-size:12.5px;color:var(--dsw-alias-label-primary,#0f1115);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.skb-role{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.skb-badge{font-size:9.5px;padding:0 5px;line-height:15px;border-radius:20px;background:rgba(245,158,11,.12);color:#b45309;flex:none}
.skb-sec{font-size:10px;color:var(--dsw-alias-label-caption,#adb2b8);padding:7px 7px 2px;letter-spacing:.3px}
.skb-empty{font-size:11.5px;color:var(--dsw-alias-label-caption,#adb2b8);padding:5px 7px}
[data-skb-official-hidden="true"]{display:none !important}
`
  document.head.appendChild(el)
}

let state: BotStatePayload = { bots: [], ui: { mode: 'bot' } }
let mode: 'work' | 'bot' = 'bot'
let hostEl: HTMLElement | null = null
let selected = ''

function api(path: string, init?: RequestInit): Promise<any> {
  return fetch('/api/seeker-bot' + path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  }).then((r) => r.json()).catch(() => null)
}

function avatar(bot: BotRecord): HTMLElement {
  const el = document.createElement('div')
  el.className = 'skb-av'
  el.style.background = bot.avatar?.color ?? '#0f1115'
  el.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">' + (SHAPES[bot.avatar?.shape] ?? SHAPES.whale) + '</svg>'
  return el
}

function renderList(container: HTMLElement): void {
  container.innerHTML = ''
  const bots = (state.bots ?? []).filter((b) => b.hidden !== true)
  if (bots.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'skb-empty'
    empty.textContent = '还没有 Bot。点上面的「新建 Bot」开始。'
    container.appendChild(empty)
    return
  }
  const sections: string[] = []
  for (const b of bots) {
    const key = b.pinned === true ? '置顶' : (b.section ?? '项目')
    if (!sections.includes(key)) sections.push(key)
  }
  for (const sec of sections) {
    const title = document.createElement('div')
    title.className = 'skb-sec'
    title.textContent = sec
    container.appendChild(title)
    for (const b of bots.filter((x) => (x.pinned === true ? '置顶' : (x.section ?? '项目')) === sec)) {
      const row = document.createElement('div')
      row.className = 'skb-row' + (selected === b.id ? ' on' : '')
      row.appendChild(avatar(b))
      const meta = document.createElement('div')
      meta.className = 'skb-meta'
      const name = document.createElement('div')
      name.className = 'skb-name'
      name.textContent = b.name
      const role = document.createElement('div')
      role.className = 'skb-role'
      role.textContent = b.role
      meta.appendChild(name)
      meta.appendChild(role)
      row.appendChild(meta)
      if (b.status === 'needs-you') {
        const badge = document.createElement('span')
        badge.className = 'skb-badge'
        badge.textContent = '待处理'
        row.appendChild(badge)
      }
      row.addEventListener('click', () => {
        selected = b.id
        renderList(container)
        window.dispatchEvent(new CustomEvent('skb:bot-selected', { detail: { id: b.id } }))
      })
      container.appendChild(row)
    }
  }
}

function applyMode(): void {
  const official = document.querySelectorAll(ANCHOR)
  official.forEach((el) => {
    if (mode === 'bot') el.setAttribute(HIDE_ATTR, 'true')
    else el.removeAttribute(HIDE_ATTR)
  })
  if (hostEl === null) return
  const list = hostEl.querySelector('.skb-list') as HTMLElement | null
  if (list !== null) {
    list.style.display = mode === 'bot' ? 'flex' : 'none'
    if (mode === 'bot') renderList(list)
  }
  const buttons = hostEl.querySelectorAll('.skb-mode button')
  buttons.forEach((b) => {
    const el = b as HTMLElement
    el.classList.toggle('on', el.dataset.mode === mode)
  })
}

async function persistMode(next: 'work' | 'bot'): Promise<void> {
  mode = next
  applyMode()
  await api('/ui/mode', { method: 'POST', body: JSON.stringify({ mode: next }) })
}

function buildHost(): HTMLElement {
  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'skb-host'

  const seg = document.createElement('div')
  seg.className = 'skb-mode'
  for (const m of ['work', 'bot'] as const) {
    const btn = document.createElement('button')
    btn.dataset.mode = m
    btn.textContent = m === 'work' ? 'Work' : 'Bot'
    btn.addEventListener('click', () => { void persistMode(m) })
    seg.appendChild(btn)
  }
  host.appendChild(seg)

  const list = document.createElement('div')
  list.className = 'skb-list'
  host.appendChild(list)
  return host
}

function mount(): void {
  if (typeof document === 'undefined') return
  injectStyles()
  const anchor = document.querySelector(ANCHOR)
  if (anchor === null) return
  if (document.getElementById(HOST_ID) !== null) return
  hostEl = buildHost()
  anchor.parentElement?.insertBefore(hostEl, anchor)
  applyMode()
}

export function applyBotConsole(ctx?: unknown): void {
  void ctx
  if (typeof window === 'undefined') return

  void api('/state').then((payload) => {
    if (payload !== null && typeof payload === 'object') {
      state = payload as BotStatePayload
      if (state.ui?.mode === 'work' || state.ui?.mode === 'bot') mode = state.ui.mode
    }
    mount()
    applyMode()
  })

  // 官方侧栏可能重建：持续观察，锚点回来就重挂
  if (typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(() => { mount(); applyMode() })
    try {
      obs.observe(document.body, { childList: true, subtree: true })
    } catch { /* 忽略 */ }
    setTimeout(() => obs.disconnect(), 30000)
  }

  window.addEventListener('skb:refresh', () => { void api('/state').then((p) => { if (p) { state = p as BotStatePayload; applyMode() } }) })
}

/** 外部（新 Bot 创建后）触发刷新。 */
export function refreshBotConsole(): void {
  window.dispatchEvent(new Event('skb:refresh'))
}
