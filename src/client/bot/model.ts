/**
 * dsh-seeker-bot — Bot 控制台前端纯逻辑（无 DOM / 无 React 依赖）。
 *
 * 侧栏名册、详情抽屉、右栏面板都从这里取同一份判据：
 *  - 名册分组 / 注意力角标 / 渲染指纹（防止 DOM 写回触发观察器循环）；
 *  - 抽屉的字段表与 PATCH / POST 载荷装配；
 *  - 右栏面板该渲染哪些区块（只有画面，没有标题 / 说明文字 / 终端）。
 *
 * 之所以把纯逻辑单独成文件：这些判据错了不会抛错，只会静默显示错分组、
 * 保存丢字段或面板多出一段说明文字。测试（scripts/test-bot-client.mjs）
 * 直接在 node 里 import 本文件断言，不依赖浏览器。
 */

/** Bot 的注意力状态（host 推导后下发）。 */
export type BotStatus = 'idle' | 'working' | 'needs-you' | 'unread' | string

/** 头像形状。 */
export type AvatarShape = 'whale' | 'orbit' | 'cube' | 'leaf' | 'spark' | 'ring'

export interface BotAvatar {
  shape?: AvatarShape | string
  color?: string
}

export interface BotModelPref {
  provider?: string
  model?: string
  effort?: 'low' | 'mid' | 'high' | 'max' | string
}

export interface BotProactive {
  enabled?: boolean
  freq?: string
  from?: string
  to?: string
  lastAt?: number
}

export interface BotOutput {
  charts?: boolean
  pages?: boolean
}

/** 与 host 的 BotRecord 对齐的客户端视图（字段全部可选，后端老版本也能渲染）。 */
export interface BotRecord {
  id: string
  name: string
  role: string
  label?: string
  avatar?: BotAvatar
  instructions?: string
  primary?: boolean
  pinned?: boolean
  section?: string
  hidden?: boolean
  paused?: boolean
  notification?: boolean
  model?: BotModelPref
  proactive?: BotProactive
  output?: BotOutput
  sessionIds?: string[]
  status?: BotStatus
  createdAt?: number
  createdBy?: string | null
  workspace?: string
  description?: string
}

export interface BotGroup {
  id: string
  name: string
  botIds?: string[]
  model?: { mode?: 'inherit' | 'unified'; provider?: string; model?: string; effort?: string }
}

export interface BotUiState {
  mode?: 'work' | 'bot'
  lastBotId?: string
}

export interface BotStatePayload {
  ok?: boolean
  version?: number
  bots?: BotRecord[]
  groups?: BotGroup[]
  ui?: BotUiState
  [key: string]: unknown
}

/** 名册分组：置顶永远第一组，其余按首次出现顺序按 section 分组。 */
export interface RosterGroup {
  readonly key: string
  readonly label: string
  readonly bots: BotRecord[]
}

export interface AttentionBadge {
  readonly kind: 'needs-you' | 'unread' | 'working'
  readonly label: string
}

/** 头像形状的 SVG path 数据（viewBox 0 0 24 24）。 */
export const SHAPE_PATHS: Readonly<Record<AvatarShape, string>> = {
  whale: '<path d="M3.6 13.8c0-3.9 3.1-7 7-7 2.5 0 4.7 1.3 5.9 3.3l3.6-1.4-1.6 4.9c.1.5.1 1 .1 1.5 0 3.5-2.8 6.3-6.3 6.3H9.9c-3.5 0-6.3-2.8-6.3-6.3z"/>',
  orbit: '<circle cx="12" cy="12" r="3.2"/><ellipse cx="12" cy="12" rx="9" ry="4" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(-28 12 12)"/>',
  cube: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M12 12l8-4.6M12 12L4 7.4M12 12v9.2" stroke="rgba(0,0,0,.25)" stroke-width="1.1" fill="none"/>',
  leaf: '<path d="M20.2 4c0 8.8-5.2 14-11.9 14H4.4C4.4 9.2 9.6 4 16.3 4z"/>',
  spark: '<path d="M12 2.6l2.4 6.1 6.1 2.4-6.1 2.4L12 19.6l-2.4-6.1-6.1-2.4 6.1-2.4z"/>',
  ring: '<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="3.2"/>',
}

export const AVATAR_SHAPES: ReadonlyArray<{ value: AvatarShape; label: string }> = [
  { value: 'whale', label: '鲸鱼' },
  { value: 'orbit', label: '轨道' },
  { value: 'cube', label: '方块' },
  { value: 'leaf', label: '叶子' },
  { value: 'spark', label: '星光' },
  { value: 'ring', label: '圆环' },
]

/** 头像可选颜色（用户数据，不是主题色；样式仍走 --dsw-alias-*）。 */
export const AVATAR_COLORS: readonly string[] = [
  '#0f1115', '#3b82f6', '#10b981', '#f59e0b',
  '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6',
]

const DEFAULT_SHAPE: AvatarShape = 'whale'
const DEFAULT_COLOR = '#0f1115'

/** 读头像（老数据缺字段时给默认值，渲染层不抛）。 */
export function avatarOf(bot: BotRecord): { shape: AvatarShape; color: string } {
  const shape = String(bot.avatar?.shape ?? '')
  const color = String(bot.avatar?.color ?? '')
  return {
    shape: (Object.prototype.hasOwnProperty.call(SHAPE_PATHS, shape) ? shape : DEFAULT_SHAPE) as AvatarShape,
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_COLOR,
  }
}

/** 注意力角标：只有三种状态需要出现在名册上。 */
export function attentionBadge(status: BotStatus | undefined): AttentionBadge | null {
  if (status === 'needs-you') return { kind: 'needs-you', label: '待处理' }
  if (status === 'unread') return { kind: 'unread', label: '未读' }
  if (status === 'working') return { kind: 'working', label: '工作中' }
  return null
}

/** 名册分组：隐藏 Bot 不出现；置顶优先，其余按 section（缺省「项目」）。 */
export function groupRoster(bots: readonly BotRecord[]): RosterGroup[] {
  const visible = bots.filter((bot) => bot.hidden !== true)
  const pinned = visible.filter((bot) => bot.pinned === true)
  const rest = visible.filter((bot) => bot.pinned !== true)
  const groups: RosterGroup[] = []
  if (pinned.length > 0) groups.push({ key: 'pinned', label: '置顶', bots: pinned })
  const order: string[] = []
  for (const bot of rest) {
    const section = (bot.section ?? '').trim() || '项目'
    if (!order.includes(section)) order.push(section)
  }
  for (const section of order) {
    groups.push({
      key: 'section:' + section,
      label: section,
      bots: rest.filter((bot) => ((bot.section ?? '').trim() || '项目') === section),
    })
  }
  return groups
}

/** 名册渲染指纹：只由字符串 / 布尔拼成，绝不包含对象引用。 */
export function rosterRenderKey(input: {
  readonly mode: 'work' | 'bot'
  readonly bots: readonly BotRecord[]
  readonly selected: string
}): string {
  const rows = input.bots
    .filter((bot) => bot.hidden !== true)
    .map((bot) => {
      const avatar = avatarOf(bot)
      return [
        bot.id,
        bot.name,
        bot.role,
        bot.status ?? '',
        bot.pinned === true ? '1' : '0',
        bot.primary === true ? '1' : '0',
        bot.section ?? '',
        avatar.shape,
        avatar.color,
      ].join('\u0002')
    })
    .join('\u0001')
  return input.mode + '\u0003' + input.selected + '\u0003' + rows
}

// ── 详情抽屉：字段表与载荷装配 ─────────────────────────────────────────

/** 抽屉可编辑字段的键。 */
export type DrawerFieldKey =
  | 'name' | 'role' | 'instructions'
  | 'shape' | 'color'
  | 'provider' | 'model' | 'effort'
  | 'proactiveEnabled' | 'proactiveFreq' | 'proactiveFrom' | 'proactiveTo'
  | 'charts' | 'pages'

export interface DrawerField {
  readonly key: DrawerFieldKey
  readonly label: string
  readonly kind: 'text' | 'textarea' | 'color' | 'select' | 'toggle' | 'time'
  readonly options?: ReadonlyArray<{ value: string; label: string }>
  readonly placeholder?: string
}

export interface DrawerSection {
  readonly key: string
  readonly title: string
  readonly fields: readonly DrawerField[]
}

/** 抽屉字段表：渲染与测试共用同一份，避免字段漏一个或标签走样。 */
export const DRAWER_SECTIONS: readonly DrawerSection[] = [
  {
    key: 'identity',
    title: '名称与岗位',
    fields: [
      { key: 'name', label: '名称', kind: 'text', placeholder: '例如：小鲸' },
      { key: 'role', label: '岗位', kind: 'text', placeholder: '例如：研究员' },
      { key: 'instructions', label: '指令', kind: 'textarea', placeholder: '这个 Bot 要遵守的岗位与边界' },
    ],
  },
  {
    key: 'avatar',
    title: '头像',
    fields: [
      { key: 'shape', label: '形状', kind: 'select', options: AVATAR_SHAPES.map((item) => ({ value: item.value, label: item.label })) },
      { key: 'color', label: '颜色', kind: 'color' },
    ],
  },
  {
    key: 'model',
    title: '模型',
    fields: [
      { key: 'provider', label: '供应商', kind: 'text', placeholder: '留空跟随全局' },
      { key: 'model', label: '模型', kind: 'text', placeholder: '留空跟随全局' },
      {
        key: 'effort',
        label: '推理强度',
        kind: 'select',
        options: [
          { value: '', label: '跟随默认' },
          { value: 'low', label: '低' },
          { value: 'mid', label: '中' },
          { value: 'high', label: '高' },
          { value: 'max', label: '最高' },
        ],
      },
    ],
  },
  {
    key: 'proactive',
    title: '主动找我',
    fields: [
      { key: 'proactiveEnabled', label: '开启', kind: 'toggle' },
      {
        key: 'proactiveFreq',
        label: '频率',
        kind: 'select',
        options: [
          { value: 'off', label: '关' },
          { value: 'daily', label: '每天' },
          { value: '4h', label: '每 4 小时' },
          { value: '2h', label: '每 2 小时' },
          { value: 'weekly', label: '每周' },
        ],
      },
      { key: 'proactiveFrom', label: '时段开始', kind: 'time' },
      { key: 'proactiveTo', label: '时段结束', kind: 'time' },
    ],
  },
  {
    key: 'output',
    title: '产出偏好',
    fields: [
      { key: 'charts', label: '图表', kind: 'toggle' },
      { key: 'pages', label: '可交互页面', kind: 'toggle' },
    ],
  },
]

/** 抽屉草稿：所有可编辑值都转成字符串 / 布尔，输入控件直接读写。 */
export interface BotDraft {
  readonly name: string
  readonly role: string
  readonly instructions: string
  readonly shape: AvatarShape
  readonly color: string
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly proactiveEnabled: boolean
  readonly proactiveFreq: string
  readonly proactiveFrom: string
  readonly proactiveTo: string
  readonly charts: boolean
  readonly pages: boolean
}

export function drawerDraftOf(bot: BotRecord): BotDraft {
  const avatar = avatarOf(bot)
  return {
    name: bot.name ?? '',
    role: bot.role ?? '',
    instructions: bot.instructions ?? '',
    shape: avatar.shape,
    color: avatar.color,
    provider: bot.model?.provider ?? '',
    model: bot.model?.model ?? '',
    effort: bot.model?.effort ?? '',
    proactiveEnabled: bot.proactive?.enabled === true,
    proactiveFreq: bot.proactive?.freq ?? 'off',
    proactiveFrom: bot.proactive?.from ?? '09:00',
    proactiveTo: bot.proactive?.to ?? '22:00',
    charts: bot.output?.charts !== false,
    pages: bot.output?.pages !== false,
  }
}

/** PATCH /bots/:id 的载荷：嵌套结构与 host 的更新语义一致。 */
export function buildBotPatch(draft: BotDraft): Record<string, unknown> {
  return {
    name: draft.name.trim() || '新队友',
    role: draft.role.trim() || '通用助手',
    instructions: draft.instructions,
    avatar: {
      shape: draft.shape,
      color: /^#[0-9a-fA-F]{6}$/.test(draft.color) ? draft.color : DEFAULT_COLOR,
    },
    model: {
      provider: draft.provider.trim(),
      model: draft.model.trim(),
      effort: draft.effort,
    },
    proactive: {
      enabled: draft.proactiveEnabled,
      freq: draft.proactiveFreq,
      from: draft.proactiveFrom,
      to: draft.proactiveTo,
    },
    output: {
      charts: draft.charts,
      pages: draft.pages,
    },
  }
}

/** POST /bots 的载荷：同时带顶层 shape/color 与 avatar，兼容 host 新旧两版。 */
export function buildCreateBotInput(draft: Pick<BotDraft, 'name' | 'role' | 'shape' | 'color' | 'instructions'>): Record<string, unknown> {
  return {
    name: draft.name.trim() || '新队友',
    role: draft.role.trim() || '通用助手',
    instructions: draft.instructions,
    shape: draft.shape,
    color: /^#[0-9a-fA-F]{6}$/.test(draft.color) ? draft.color : DEFAULT_COLOR,
    avatar: {
      shape: draft.shape,
      color: /^#[0-9a-fA-F]{6}$/.test(draft.color) ? draft.color : DEFAULT_COLOR,
    },
  }
}

/** 抽屉头部的只读摘要（字段拼接口径，测试直接断言）。 */
export function drawerFieldSummary(bot: BotRecord): Array<{ label: string; value: string }> {
  const avatar = avatarOf(bot)
  const shapeLabel = AVATAR_SHAPES.find((item) => item.value === avatar.shape)?.label ?? avatar.shape
  const provider = bot.model?.provider?.trim() ?? ''
  const model = bot.model?.model?.trim() ?? ''
  const effort = bot.model?.effort?.trim() ?? ''
  const modelText = [provider, model, effort].filter((part) => part !== '').join(' / ') || '跟随全局'
  const proactive = bot.proactive?.enabled === true
    ? [bot.proactive?.freq ?? 'off', (bot.proactive?.from ?? '09:00') + '-' + (bot.proactive?.to ?? '22:00')].join(' · ')
    : '关闭'
  const output = [bot.output?.charts !== false ? '图表' : '', bot.output?.pages !== false ? '可交互页面' : '']
    .filter((part) => part !== '')
    .join('、') || '无'
  return [
    { label: '名称', value: bot.name ?? '' },
    { label: '岗位', value: bot.role ?? '' },
    { label: '头像', value: shapeLabel + ' · ' + avatar.color },
    { label: '模型', value: modelText },
    { label: '主动找我', value: proactive },
    { label: '产出偏好', value: output },
  ]
}

// ── 右栏面板：只渲染画面，不渲染标题 / 说明文字 / 终端 ─────────────────

export type PanelSection = 'viewport' | 'subagents' | 'outputs'

/** 面板的静态文案必须为空：只有画面，没有标题与说明。 */
export const PANEL_VIEWPORT_CHROME = Object.freeze({
  title: '',
  description: '',
  terminal: false,
})

/** 面板该渲染哪些区块（viewport 永远在；其余按数据出现，空则不渲染）。 */
export function visiblePanelSections(input: {
  readonly hasSubagents: boolean
  readonly hasOutputs: boolean
}): PanelSection[] {
  const sections: PanelSection[] = ['viewport']
  if (input.hasSubagents) sections.push('subagents')
  if (input.hasOutputs) sections.push('outputs')
  return sections
}

/** 面板只在 Bot 模式挂载；Work 模式必须卸载。 */
export function panelShouldMount(mode: 'work' | 'bot'): boolean {
  return mode === 'bot'
}
