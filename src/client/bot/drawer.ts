/**
 * dsh-seeker-bot — Bot 详情抽屉（纯 DOM，右侧滑出）。
 *
 * 为什么不引 React：抽屉只需要表单控件 + 一次 PATCH，纯 DOM 反而少了
 * createRoot / 状态同步 / 卸载时序三处复杂度；数据口径全部来自 model.ts
 * 的同一张字段表（DRAWER_SECTIONS），不会出现「界面有字段、保存没带上」。
 *
 * 所有失败都在抽屉底部留一行可见错误，绝不静默。
 */

import {
  createRoutine, deleteBot, deleteRoutine, fetchRoutines, patchBot, patchRoutine,
  setBotPaused, setPrimaryBot, testProactive, testRoutine, type RoutineView,
} from './api.ts'
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
let routinesBody: HTMLDivElement | null = null
let routineNameInput: HTMLInputElement | null = null
let routineInstructionInput: HTMLTextAreaElement | null = null
let routineScheduleSelect: HTMLSelectElement | null = null
let routines: RoutineView[] = []
let routinesBusy = false
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

/* ───────────────────────────── 日程（原班次） ───────────────────────────── */

/** 把 triggers 归一成一句可读的频率说明。 */
function scheduleLabelOf(routine: RoutineView): string {
  const trigger = Array.isArray(routine.triggers)
    ? routine.triggers.find((item) => item.type === 'schedule')
    : undefined
  if (trigger === undefined) return '仅手动 / Webhook'
  if (typeof trigger.everySeconds === 'number' && trigger.everySeconds > 0) {
    const hours = trigger.everySeconds / 3600
    return Number.isInteger(hours) ? '每 ' + hours + ' 小时' : '每 ' + trigger.everySeconds + ' 秒'
  }
  if (typeof trigger.cron === 'string' && trigger.cron !== '') {
    if (trigger.cron === '0 9 * * *') return '每天 09:00'
    if (trigger.cron === '0 9 * * 1') return '每周一 09:00'
    return 'cron：' + trigger.cron
  }
  return '仅手动 / Webhook'
}

function lastRunTextOf(routine: RoutineView): string {
  const run = Array.isArray(routine.runs) && routine.runs.length > 0 ? routine.runs[0] : undefined
  if (run === undefined) return '还没跑过'
  const time = new Date(run.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const status = run.status === 'succeeded' ? '成功' : run.status === 'failed' ? '失败' : run.status
  return time + ' · ' + status + (run.reason ? '：' + run.reason : '')
}

function renderRoutines(): void {
  if (routinesBody === null) return
  routinesBody.innerHTML = ''
  if (routines.length === 0) {
    const empty = el('div', 'skb-routine-empty')
    empty.textContent = '还没有日程。日程会在指定时间让这个 Bot 自己跑一件事。'
    routinesBody.appendChild(empty)
    return
  }
  for (const routine of routines) {
    const row = el('div', 'skb-routine')
    const check = el('input', '') as HTMLInputElement
    check.type = 'checkbox'
    check.checked = routine.enabled === true
    check.title = routine.enabled === true ? '暂停这个日程' : '恢复这个日程'
    check.addEventListener('change', () => { void toggleRoutine(routine, check.checked) })
    row.appendChild(check)

    const meta = el('div', 'skb-routine__meta')
    const name = el('div', 'skb-routine__name')
    name.textContent = routine.name
    const sub = el('div', 'skb-routine__sub')
    sub.textContent = scheduleLabelOf(routine) + ' · ' + lastRunTextOf(routine)
    meta.appendChild(name)
    meta.appendChild(sub)
    row.appendChild(meta)

    const test = el('button', 'skb-routine__act') as HTMLButtonElement
    test.type = 'button'
    test.textContent = 'Test'
    test.title = '立即跑一次（没有可驱动的会话时会如实跳过）'
    test.addEventListener('click', () => { void runRoutineTest(routine) })
    row.appendChild(test)

    const remove = el('button', 'skb-routine__act skb-routine__act--danger') as HTMLButtonElement
    remove.type = 'button'
    remove.textContent = '删除'
    remove.addEventListener('click', () => { void removeRoutine(routine) })
    row.appendChild(remove)
    routinesBody.appendChild(row)
  }
}

async function loadRoutines(botId: string): Promise<void> {
  const res = await fetchRoutines(botId)
  if (!res.ok) {
    routines = []
    renderRoutines()
    showDrawerError('读取日程失败：' + (res.error ?? '未知错误'))
    return
  }
  routines = Array.isArray(res.data?.routines) ? res.data.routines : []
  renderRoutines()
}

async function addRoutine(): Promise<void> {
  if (currentBot === null || routinesBusy) return
  if (routineNameInput === null || routineInstructionInput === null || routineScheduleSelect === null) return
  const name = routineNameInput.value.trim()
  const instruction = routineInstructionInput.value.trim()
  if (name === '' || instruction === '') {
    showDrawerError('日程名称和内容都不能为空')
    return
  }
  routinesBusy = true
  showDrawerError('')
  const schedule = routineScheduleSelect.value
  const input: Record<string, unknown> = { botId: currentBot.id, name, instruction, enabled: true }
  if (schedule === 'hourly') input.everySeconds = 3600
  else if (schedule === 'every4h') input.everySeconds = 4 * 3600
  else if (schedule === 'daily9') input.cron = '0 9 * * *'
  else if (schedule === 'weekly') input.cron = '0 9 * * 1'
  try {
    const res = await createRoutine(input)
    if (!res.ok) {
      showDrawerError('创建日程失败：' + (res.error ?? '未知错误'))
      return
    }
    routineNameInput.value = ''
    routineInstructionInput.value = ''
    await loadRoutines(currentBot.id)
    notice('已创建日程「' + name + '」')
  } finally {
    routinesBusy = false
  }
}

async function toggleRoutine(routine: RoutineView, enabled: boolean): Promise<void> {
  const res = await patchRoutine(routine.id, { enabled })
  if (!res.ok) {
    showDrawerError('更新日程失败：' + (res.error ?? '未知错误'))
    return
  }
  await loadRoutines(routine.botId)
}

async function removeRoutine(routine: RoutineView): Promise<void> {
  const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function'
    ? true
    : window.confirm('删除日程「' + routine.name + '」？')
  if (!confirmed) return
  const res = await deleteRoutine(routine.id)
  if (!res.ok) {
    showDrawerError('删除日程失败：' + (res.error ?? '未知错误'))
    return
  }
  await loadRoutines(routine.botId)
  notice('已删除日程「' + routine.name + '」')
}

async function runRoutineTest(routine: RoutineView): Promise<void> {
  const res = await testRoutine(routine.id)
  if (!res.ok) {
    showDrawerError('Test 失败：' + (res.error ?? '未知错误'))
    return
  }
  notice(res.data?.delivered === true ? '已交给「' + routine.name + '」执行' : 'Test 已记录：' + (res.data?.reason ?? '已接受'))
  await loadRoutines(routine.botId)
}

async function runProactiveTest(): Promise<void> {
  if (currentBot === null) return
  const res = await testProactive(currentBot.id)
  if (!res.ok) {
    showDrawerError('测试主动找我失败：' + (res.error ?? '未知错误'))
    return
  }
  const data = res.data ?? {}
  const reason = typeof data.reason === 'string' ? data.reason : ''
  const count = typeof data.candidateCount === 'number' ? data.candidateCount : 0
  if (data.willSend === true) notice('此刻会发：有 ' + count + ' 条候选事件（' + reason + '）')
  else notice('此刻不会发：' + reason + '（候选 ' + count + ' 条）')
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
    if (section.title === '主动找我') {
      const test = el('button', 'skb-btn') as HTMLButtonElement
      test.type = 'button'
      test.textContent = '测试主动找我'
      test.title = '按当前配置与候选事件判断此刻是否会发消息（不会真的发）'
      test.addEventListener('click', () => { void runProactiveTest() })
      box.appendChild(test)
    }
    bodyEl.appendChild(box)
  }

  // 日程（原「班次」）：列表 + 新建。与 Bot 档案分开保存，操作即时生效。
  const routineBox = el('section', 'skb-drawer__section')
  const routineTitle = el('div', 'skb-drawer__section-title')
  routineTitle.textContent = '日程'
  routineBox.appendChild(routineTitle)
  const routineHint = el('div', 'skb-drawer__hint')
  routineHint.textContent = '到点让这个 Bot 自己跑一件事；日程失败会进入主动找我的候选事件。'
  routineBox.appendChild(routineHint)
  routinesBody = el('div', 'skb-routines')
  routineBox.appendChild(routinesBody)

  const routineForm = el('div', 'skb-routine-form')
  const routineRow1 = el('div', 'skb-form-row')
  routineNameInput = el('input', 'skb-input') as HTMLInputElement
  routineNameInput.placeholder = '日程名称'
  routineNameInput.setAttribute('aria-label', '日程名称')
  routineScheduleSelect = el('select', 'skb-select') as HTMLSelectElement
  for (const item of [
    { value: 'daily9', label: '每天 09:00' },
    { value: 'hourly', label: '每小时' },
    { value: 'every4h', label: '每 4 小时' },
    { value: 'weekly', label: '每周一 09:00' },
    { value: 'manual', label: '仅手动 / Webhook' },
  ]) {
    const option = el('option', '') as HTMLOptionElement
    option.value = item.value
    option.textContent = item.label
    routineScheduleSelect.appendChild(option)
  }
  routineRow1.appendChild(routineNameInput)
  routineRow1.appendChild(routineScheduleSelect)
  routineForm.appendChild(routineRow1)
  routineInstructionInput = el('textarea', 'skb-textarea') as HTMLTextAreaElement
  routineInstructionInput.rows = 3
  routineInstructionInput.placeholder = '到点要做什么（给 Bot 的指令）'
  routineInstructionInput.setAttribute('aria-label', '日程内容')
  routineForm.appendChild(routineInstructionInput)
  const routineAdd = el('button', 'skb-btn skb-btn--primary') as HTMLButtonElement
  routineAdd.type = 'button'
  routineAdd.textContent = '添加日程'
  routineAdd.addEventListener('click', () => { void addRoutine() })
  routineForm.appendChild(routineAdd)
  routineBox.appendChild(routineForm)
  bodyEl.appendChild(routineBox)

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
  routines = []
  renderRoutines()
  void loadRoutines(bot.id)
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
