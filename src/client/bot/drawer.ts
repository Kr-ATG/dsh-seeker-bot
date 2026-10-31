/**
 * dsh-seeker-bot — Bot 详情抽屉（纯 DOM，右侧滑出）。
 *
 * 为什么不引 React：抽屉只需要表单控件 + 一次 PATCH，纯 DOM 反而少了
 * createRoot / 状态同步 / 卸载时序三处复杂度；数据口径全部来自 model.ts
 * 的同一张字段表（DRAWER_SECTIONS），不会出现「界面有字段、保存没带上」。
 *
 * 所有失败都在抽屉底部留一行可见错误，绝不静默。
 */

import { deleteBot, patchBot, setBotPaused, setPrimaryBot } from './api.ts'
import {
  buildBotPatch,
  DRAWER_SECTIONS,
  drawerDraftOf,
  drawerFieldSummary,
  type BotDraft,
  type BotRecord,
  type DrawerField,
} from './model.ts'
import { getBotConsoleStore } from './store.ts'
import { injectBotStyles } from './styles.ts'

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

const DRAWER_ID = 'skb-bot-drawer'

let drawerEl: HTMLDivElement | null = null
let subtitleEl: HTMLDivElement | null = null
let bodyEl: HTMLDivElement | null = null
let errorEl: HTMLDivElement | null = null
let saveBtn: HTMLButtonElement | null = null
let pauseBtn: HTMLButtonElement | null = null
let pinBtn: HTMLButtonElement | null = null
let primaryBtn: HTMLButtonElement | null = null
let currentBot: BotRecord | null = null
let busy = false
const controls = new Map<string, Control>()

function controlOf(key: string): Control | undefined {
  return controls.get(key)
}

function textOf(key: string): string {
  return controlOf(key)?.value ?? ''
}

function checkedOf(key: string): boolean {
  const control = controlOf(key)
  return control !== undefined && (control as HTMLInputElement).checked === true
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  return node
}

function buildField(field: DrawerField): { wrap: HTMLElement; control: Control } {
  const wrap = el('div', 'skb-drawer__field')
  if (field.kind === 'toggle') {
    const check = el('label', 'skb-drawer__check')
    const input = el('input', '') as HTMLInputElement
    input.type = 'checkbox'
    input.dataset.fieldKey = field.key
    input.setAttribute('aria-label', field.label)
    const text = el('span', 'skb-drawer__label')
    text.textContent = field.label
    check.appendChild(input)
    check.appendChild(text)
    wrap.appendChild(check)
    controls.set(field.key, input)
    return { wrap, control: input }
  }

  const label = el('label', 'skb-drawer__label')
  label.textContent = field.label
  wrap.appendChild(label)

  let control: Control
  if (field.kind === 'textarea') {
    const textarea = el('textarea', 'skb-textarea') as HTMLTextAreaElement
    textarea.rows = 4
    if (field.placeholder !== undefined) textarea.placeholder = field.placeholder
    control = textarea
  } else if (field.kind === 'select') {
    const select = el('select', 'skb-select') as HTMLSelectElement
    for (const option of field.options ?? []) {
      const node = el('option', '') as HTMLOptionElement
      node.value = option.value
      node.textContent = option.label
      select.appendChild(node)
    }
    control = select
  } else {
    const input = el('input', 'skb-input') as HTMLInputElement
    input.type = field.kind === 'color' ? 'color' : field.kind === 'time' ? 'time' : 'text'
    if (field.placeholder !== undefined) input.placeholder = field.placeholder
    control = input
  }
  control.dataset.fieldKey = field.key
  wrap.appendChild(control)
  controls.set(field.key, control)
  return { wrap, control }
}

function fillControls(bot: BotRecord): void {
  const draft = drawerDraftOf(bot)
  const values: Record<string, string | boolean> = {
    name: draft.name,
    role: draft.role,
    instructions: draft.instructions,
    shape: draft.shape,
    color: draft.color,
    provider: draft.provider,
    model: draft.model,
    effort: draft.effort,
    proactiveEnabled: draft.proactiveEnabled,
    proactiveFreq: draft.proactiveFreq,
    proactiveFrom: draft.proactiveFrom,
    proactiveTo: draft.proactiveTo,
    charts: draft.charts,
    pages: draft.pages,
  }
  for (const [key, value] of Object.entries(values)) {
    const control = controls.get(key)
    if (control === undefined) continue
    if (typeof value === 'boolean') {
      if ('checked' in control) (control as HTMLInputElement).checked = value
    } else {
      control.value = value
    }
  }
}

function readDraft(): BotDraft {
  return {
    name: textOf('name'),
    role: textOf('role'),
    instructions: textOf('instructions'),
    shape: textOf('shape') as BotDraft['shape'],
    color: textOf('color'),
    provider: textOf('provider'),
    model: textOf('model'),
    effort: textOf('effort'),
    proactiveEnabled: checkedOf('proactiveEnabled'),
    proactiveFreq: textOf('proactiveFreq'),
    proactiveFrom: textOf('proactiveFrom'),
    proactiveTo: textOf('proactiveTo'),
    charts: checkedOf('charts'),
    pages: checkedOf('pages'),
  }
}

function showDrawerError(message: string): void {
  if (errorEl === null) return
  errorEl.textContent = message
}

function setBusy(next: boolean): void {
  busy = next
  if (saveBtn !== null) saveBtn.disabled = next
  if (pauseBtn !== null) pauseBtn.disabled = next
  if (pinBtn !== null) pinBtn.disabled = next
  if (primaryBtn !== null) primaryBtn.disabled = next || currentBot?.primary === true
}

function notice(message: string): void {
  getBotConsoleStore().setNotice(message)
}

async function afterMutation(message: string): Promise<void> {
  const store = getBotConsoleStore()
  const id = currentBot?.id ?? ''
  const refreshed = await store.refresh()
  const updated = refreshed !== null ? store.botById(id) : null
  if (updated !== null) openBotDrawer(updated)
  else closeBotDrawer()
  notice(message)
}

function buildDrawer(): HTMLDivElement {
  const root = el('div', 'skb-drawer')
  root.id = DRAWER_ID
  root.setAttribute('data-open', 'false')
  root.setAttribute('aria-hidden', 'true')

  const mask = el('div', 'skb-drawer__mask')
  mask.addEventListener('click', () => { closeBotDrawer() })
  root.appendChild(mask)

  const panel = el('aside', 'skb-drawer__panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', 'Bot 设置')

  const header = el('div', 'skb-drawer__header')
  const heading = el('div', '')
  const title = el('div', 'skb-drawer__title')
  title.textContent = 'Bot 设置'
  subtitleEl = el('div', 'skb-drawer__subtitle')
  heading.appendChild(title)
  heading.appendChild(subtitleEl)
  const close = el('button', 'skb-drawer__close') as HTMLButtonElement
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', '关闭 Bot 设置')
  close.addEventListener('click', () => { closeBotDrawer() })
  header.appendChild(heading)
  header.appendChild(close)
  panel.appendChild(header)

  bodyEl = el('div', 'skb-drawer__body')
  for (const section of DRAWER_SECTIONS) {
    const box = el('section', 'skb-drawer__section')
    const sectionTitle = el('div', 'skb-drawer__section-title')
    sectionTitle.textContent = section.title
    box.appendChild(sectionTitle)
    for (const field of section.fields) {
      box.appendChild(buildField(field).wrap)
    }
    bodyEl.appendChild(box)
  }

  // 动作区：暂停 / 置顶 / 主 Bot / 删除（即时生效，不需要点保存）
  const actionBox = el('section', 'skb-drawer__section')
  const actionTitle = el('div', 'skb-drawer__section-title')
  actionTitle.textContent = '操作'
  actionBox.appendChild(actionTitle)
  const actions = el('div', 'skb-drawer__actions')

  pauseBtn = el('button', 'skb-btn') as HTMLButtonElement
  pauseBtn.type = 'button'
  pauseBtn.addEventListener('click', () => { void togglePaused() })
  actions.appendChild(pauseBtn)

  pinBtn = el('button', 'skb-btn') as HTMLButtonElement
  pinBtn.type = 'button'
  pinBtn.addEventListener('click', () => { void togglePinned() })
  actions.appendChild(pinBtn)

  primaryBtn = el('button', 'skb-btn') as HTMLButtonElement
  primaryBtn.type = 'button'
  primaryBtn.addEventListener('click', () => { void makePrimary() })
  actions.appendChild(primaryBtn)

  const removeBtn = el('button', 'skb-btn skb-btn--danger') as HTMLButtonElement
  removeBtn.type = 'button'
  removeBtn.textContent = '删除'
  removeBtn.addEventListener('click', () => { void removeBot() })
  actions.appendChild(removeBtn)

  actionBox.appendChild(actions)
  bodyEl.appendChild(actionBox)
  panel.appendChild(bodyEl)

  errorEl = el('div', 'skb-drawer__error')
  errorEl.setAttribute('role', 'alert')
  panel.appendChild(errorEl)

  const footer = el('div', 'skb-drawer__footer')
  const spacer = el('div', 'skb-drawer__footer-spacer')
  footer.appendChild(spacer)
  const cancel = el('button', 'skb-btn') as HTMLButtonElement
  cancel.type = 'button'
  cancel.textContent = '取消'
  cancel.addEventListener('click', () => { closeBotDrawer() })
  footer.appendChild(cancel)
  saveBtn = el('button', 'skb-btn skb-btn--primary') as HTMLButtonElement
  saveBtn.type = 'button'
  saveBtn.textContent = '保存'
  saveBtn.addEventListener('click', () => { void save() })
  footer.appendChild(saveBtn)
  panel.appendChild(footer)

  root.appendChild(panel)
  document.body.appendChild(root)

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && root.getAttribute('data-open') === 'true') closeBotDrawer()
  })
  return root
}

async function save(): Promise<void> {
  if (currentBot === null || busy) return
  setBusy(true)
  showDrawerError('')
  const draft = readDraft()
  if (draft.name.trim() === '') {
    setBusy(false)
    showDrawerError('名称不能为空')
    return
  }
  const res = await patchBot(currentBot.id, buildBotPatch(draft))
  setBusy(false)
  if (!res.ok) {
    showDrawerError('保存失败：' + (res.error ?? '未知错误'))
    return
  }
  await afterMutation('已保存「' + draft.name.trim() + '」')
}

async function togglePaused(): Promise<void> {
  if (currentBot === null || busy) return
  setBusy(true)
  showDrawerError('')
  const next = currentBot.paused !== true
  const res = await setBotPaused(currentBot.id, next)
  setBusy(false)
  if (!res.ok) {
    showDrawerError('操作失败：' + (res.error ?? '未知错误'))
    return
  }
  await afterMutation(next ? '已暂停「' + currentBot.name + '」' : '已恢复「' + currentBot.name + '」')
}

async function togglePinned(): Promise<void> {
  if (currentBot === null || busy) return
  setBusy(true)
  showDrawerError('')
  const res = await patchBot(currentBot.id, { pinned: currentBot.pinned !== true })
  setBusy(false)
  if (!res.ok) {
    showDrawerError('操作失败：' + (res.error ?? '未知错误'))
    return
  }
  await afterMutation(currentBot.pinned === true ? '已取消置顶' : '已置顶「' + currentBot.name + '」')
}

async function makePrimary(): Promise<void> {
  if (currentBot === null || busy || currentBot.primary === true) return
  setBusy(true)
  showDrawerError('')
  const res = await setPrimaryBot(currentBot.id)
  setBusy(false)
  if (!res.ok) {
    showDrawerError('操作失败：' + (res.error ?? '未知错误'))
    return
  }
  await afterMutation('已设「' + currentBot.name + '」为主 Bot')
}

async function removeBot(): Promise<void> {
  if (currentBot === null || busy) return
  const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function'
    ? true
    : window.confirm('删除 Bot「' + currentBot.name + '」？会话本身不会被删除。')
  if (!confirmed) return
  const name = currentBot.name
  setBusy(true)
  showDrawerError('')
  const res = await deleteBot(currentBot.id)
  setBusy(false)
  if (!res.ok) {
    showDrawerError('删除失败：' + (res.error ?? '未知错误'))
    return
  }
  const store = getBotConsoleStore()
  await store.refresh()
  closeBotDrawer()
  store.setNotice('已删除「' + name + '」')
}

/** 打开抽屉（同一个 DOM 复用，只重填字段）。 */
export function openBotDrawer(bot: BotRecord): void {
  if (typeof document === 'undefined') return
  injectBotStyles()
  if (drawerEl === null) drawerEl = buildDrawer()
  currentBot = bot
  fillControls(bot)
  showDrawerError('')
  if (subtitleEl !== null) {
    const summary = drawerFieldSummary(bot)
    subtitleEl.textContent = summary.map((row) => row.label + '：' + row.value).join(' · ')
  }
  if (pauseBtn !== null) pauseBtn.textContent = bot.paused === true ? '恢复' : '暂停'
  if (pinBtn !== null) pinBtn.textContent = bot.pinned === true ? '取消置顶' : '置顶'
  if (primaryBtn !== null) {
    primaryBtn.textContent = bot.primary === true ? '主 Bot' : '设为主 Bot'
    primaryBtn.disabled = bot.primary === true
  }
  drawerEl.setAttribute('data-open', 'true')
  drawerEl.setAttribute('aria-hidden', 'false')
}

/** 关闭抽屉（保留 DOM，方便下次秒开）。 */
export function closeBotDrawer(): void {
  if (drawerEl === null) return
  drawerEl.setAttribute('data-open', 'false')
  drawerEl.setAttribute('aria-hidden', 'true')
  currentBot = null
}
