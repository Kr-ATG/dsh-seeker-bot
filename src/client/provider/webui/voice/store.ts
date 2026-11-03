/**
 * Live 供应商共享 store —— 「模型供应商」页切到「实时语音」模式时左右两栏共用的
 * 状态与 API。
 *
 * ## 为什么要有这一层
 *
 * 旧版把整份 Live 逻辑塞在一个 1300 行的块里（行内展开编辑），形态是「详情页底部
 * 一个块」。用户 2026-11-02 否掉了这个形态：「模式切换应该是在右上角打开配置文件
 * 左侧，并且还是沿用左侧供应商与添加供应商的方式，只不过是里面的内容全部换掉了」。
 *
 * 于是这一页改成**同一个页面两套内容**：左栏仍是「供应商列表 + 添加」，右栏仍是
 * 「选中项详情」，只是数据源换成 Live 供应商。左右两栏必须共享同一份列表与选中态，
 * 所以把状态 / 请求 / 派生逻辑收进这个 hook（{@link useLiveVendorStore}），
 * 两个渲染组件（LiveVendorList / LiveVendorDetail）只做呈现。
 *
 * ## 数据通道（与旧块逐字一致，宿主契约不变）
 *
 * - `GET  /api/personal-agent/realtime/config` → `{ ok, config, presets, voices, models, defaults }`
 * - `POST 同路径`，body 白名单 `{ vendors?, defaultVendor?, voice?, speed?, webSearch? }`。
 *   **`vendors` 是整体覆盖**：新增 / 编辑 / 删除都靠提交完整数组，宿主不做增量合并。
 * - `POST /api/personal-agent/realtime/key`，body `{ ref, value }` → `{ ok, ref }`。
 *   写进 DSH 凭据库（加密），**只写不读、永不回显密钥**。
 *
 * ## 几条从旧块原样继承的纪律
 *
 * 1. **保存 = 先写密钥、再提交整份数组**。反过来的话，密钥写失败时列表里已经多了
 *    一条「看起来配好了」的供应商，通话却报找不到凭据。
 * 2. **API Key 只写不读**：成功后输入框直接清空，反馈只写「已保存（引用名 X）」。
 * 3. **删除默认项要顺手把默认指向第一条**，否则界面上没有任何一条标着「默认」。
 * 4. **id 由名称生成 slug**（重名加 `-2` / `-3` 后缀），编辑时**不改 id**。
 * 5. **凭据名留空自动派生**（`my-live` → `MY_LIVE_API_KEY`）。
 * 6. **模型是输入框 + datalist，不是下拉**（接自己网关里的 realtime 模型时下拉永远
 *    没有那个 id）。
 * 7. **改动即时保存**：设默认 / 删除 / 音色 / 语速 / 联网都立刻 POST，不等表单的
 *    保存按钮——那个按钮提交的是当前这一条供应商。
 *
 * 宿主侧见 `src/host/personal/realtime/`（config-store.ts 负责落盘与旧格式迁移）。
 */
import { useEffect, useId, useRef, useState } from 'react'
import {
  DEFAULT_REALTIME_VENDORS,
  REALTIME_CONFIG_PATH,
  REALTIME_DEFAULT_VOICE,
  REALTIME_KEY_PATH,
  REALTIME_VOICES,
  type RealtimeConfig,
  type RealtimeSpeed,
  type RealtimeVendorRecord,
  type RealtimeVoiceOption,
} from '../../../../shared/realtime-protocol.ts'

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 凭据名的合法形状，与宿主 `createRealtimeKeyHandler` 的校验逐字一致。
 *
 * 前端先挡一道：不合法的名字发过去必然 400，用户等一个来回才看到「凭据名不合法」
 * 不如当场说清楚（这个名字可能来自自动派生，也可能来自用户手填）。
 */
export const LIVE_KEY_REF_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

/** 密钥长度上限（与宿主一致：4096 字符）。挡住误粘贴一整段 JSON 的情况。 */
export const LIVE_KEY_MAX_LENGTH = 4096

/** 采样率的合法区间（与宿主 normalizeVendor 一致：8k–48k）。 */
export const LIVE_SAMPLE_RATE_MIN = 8000
export const LIVE_SAMPLE_RATE_MAX = 48000

/** 语速三档的展示顺序：慢 → 正常 → 快（与用户对刻度的直觉一致）。 */
export const LIVE_SPEED_ORDER: readonly RealtimeSpeed[] = ['slow', 'normal', 'fast']

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 表单草稿。
 *
 * 采样率用字符串：`<input type="number">` 的受控值必须允许「空」，而空串与
 * 「没配」在语义上是一回事（宿主按 24000 兜底），用 number 反而要额外处理 NaN。
 */
export interface VendorDraft {
  label: string
  upstream: string
  keyRef: string
  model: string
  inputSampleRate: string
  outputSampleRate: string
}

/**
 * 正在编辑的表单。
 *
 * `id === null` 表示「新增」；否则是正在编辑的那条 vendor 的 id。
 * 同一时刻只展开一份表单——同时摊开多条会让「保存哪一条」变得含糊。
 */
export interface EditingState {
  id: string | null
  draft: VendorDraft
}

/** API Key 提交的行内反馈（成功绿字 / 失败红字）。 */
export interface KeyNotice {
  tone: 'ok' | 'error'
  text: string
}

/**
 * 宿主 GET 回的「实际生效默认值」。
 *
 * 用户一个字段都没配过时，界面要显示**真正在用的**东西（而不是空白），否则用户
 * 不知道「自动」到底是谁。`defaults.voice` 可能是空串（宿主没显式配音色，由上游兜底）。
 */
export interface RealtimeDefaults {
  voice: string
  webSearch: boolean
  speed: RealtimeSpeed
}

/** 左右两栏共用的 store 形状（由 {@link useLiveVendorStore} 产出）。 */
export interface LiveVendorStore {
  /* ── 数据 ── */
  /** 首次 GET 是否已结束（无论成功失败）。 */
  loaded: boolean
  /** 用户自己维护的 Live 供应商列表。 */
  vendors: readonly RealtimeVendorRecord[]
  /** 默认 Live 供应商 id（空串 = 没设过）。 */
  defaultVendor: string
  /** 默认那条记录（左栏打「默认」标记用；没有列表时为 null）。 */
  defaultVendorRecord: RealtimeVendorRecord | null
  /** 内置模板（新增时快速填）。 */
  presets: readonly RealtimeVendorRecord[]
  /** 音色清单。 */
  voices: readonly RealtimeVoiceOption[]
  /** 宿主回读的「实际生效默认值」。 */
  defaults: RealtimeDefaults
  /** 全局音色（空串 = 自动）。 */
  voice: string
  /** 当前音色是否属于官方清单（否则是复刻音色 / 旧值，要显示成「自定义」并保留）。 */
  voiceIsCustom: boolean
  /** 「自动」时实际会用哪个音色（中文名）。 */
  defaultVoiceLabel: string
  /** 当前语速。 */
  currentSpeed: RealtimeSpeed
  /** 全局联网搜索开关。 */
  webSearch: boolean
  /** 模型输入框的候选（模板 → 已有供应商 → 宿主候选链，去重）。 */
  modelSuggestions: readonly string[]
  /** 加载 / 保存错误（右栏顶部展示）。 */
  error: string | null
  /** 刚保存成功的短暂提示。 */
  saved: boolean
  /** 有请求在飞（列表操作与全局设置）。 */
  saving: boolean

  /* ── 选中态 / 表单态 ── */
  editing: EditingState | null
  /** 表单当前会用的稳定 id（新增时按名称派生一个临时 id）。 */
  draftId: string
  /** 表单会写入的凭据名（手填优先，留空按 id 派生）。 */
  editingKeyRef: string
  formError: string | null
  /** 采样率折叠区是否展开。 */
  advanced: boolean
  keyDraft: string
  keySaving: boolean
  keyNotice: KeyNotice | null
  /** 待确认删除的 vendor id（点第一次只进确认态，第二次才真删）。 */
  pendingDelete: string | null
  /** 模型候选 `<datalist>` 的 id。 */
  modelListId: string

  /* ── 动作 ── */
  /** 重新拉一次配置。 */
  reload(): void
  /** 选中一条（打开它的编辑表单）。 */
  select(id: string): void
  /** 打开「新增」。 */
  beginCreate(): void
  /** 用内置模板填当前表单（用户可再改任何一项）。 */
  applyPreset(preset: RealtimeVendorRecord): void
  /** 草稿字段更新。 */
  patchDraft(patch: Partial<VendorDraft>): void
  setKeyDraft(value: string): void
  /** 清掉密钥反馈（用户重新输入时调用：留着「已保存」会让人以为新值也存了）。 */
  clearKeyNotice(): void
  setAdvanced(value: boolean): void
  setPendingDelete(id: string | null): void
  /** 收起表单（不改任何已保存的值）。 */
  cancelEdit(): void
  /** 清掉选中态与表单（切换页面模式时调用，避免两套内容串台）。 */
  resetSelection(): void
  /** 保存当前表单（先写密钥、再提交列表）。 */
  commitEdit(): Promise<void>
  /** 只写密钥、不动列表。 */
  submitKeyOnly(): Promise<void>
  /** 删除一条（默认项删掉时默认顺延到第一条）。 */
  removeVendor(vendor: RealtimeVendorRecord): Promise<void>
  /** 设为默认。 */
  setDefault(vendor: RealtimeVendorRecord): Promise<void>
  /** 全局设置（音色 / 语速 / 联网）即时保存；返回是否写成功。 */
  saveGlobal(patch: RealtimeConfig): Promise<boolean>
}

/* -------------------------------------------------------------------------- */
/* 纯函数：回包收窄（宿主只回白名单字段，这里仍逐项校验类型，不写 any）          */
/* -------------------------------------------------------------------------- */

/** 读一条 Live 供应商；缺 id / 上游地址 / 凭据名的整条丢掉（半个供应商渲染出来只会更难查）。 */
function readVendorRecord(raw: unknown): RealtimeVendorRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  const upstream = typeof source.upstream === 'string' ? source.upstream.trim() : ''
  const keyRef = typeof source.keyRef === 'string' ? source.keyRef.trim() : ''
  if (id === '' || upstream === '' || keyRef === '') return null
  const label = typeof source.label === 'string' && source.label.trim() !== '' ? source.label.trim() : id
  const record: RealtimeVendorRecord = { id, label, upstream, keyRef }
  if (typeof source.model === 'string' && source.model.trim() !== '') record.model = source.model.trim()
  const inputRate = Number(source.inputSampleRate)
  if (Number.isFinite(inputRate) && inputRate >= LIVE_SAMPLE_RATE_MIN && inputRate <= LIVE_SAMPLE_RATE_MAX) {
    record.inputSampleRate = Math.round(inputRate)
  }
  const outputRate = Number(source.outputSampleRate)
  if (Number.isFinite(outputRate) && outputRate >= LIVE_SAMPLE_RATE_MIN && outputRate <= LIVE_SAMPLE_RATE_MAX) {
    record.outputSampleRate = Math.round(outputRate)
  }
  return record
}

/** 读一组供应商；任何一条不合法就只丢那一条。 */
function readVendorList(raw: unknown): RealtimeVendorRecord[] {
  if (!Array.isArray(raw)) return []
  const out: RealtimeVendorRecord[] = []
  for (const entry of raw) {
    const record = readVendorRecord(entry)
    if (record !== null) out.push(record)
  }
  return out
}

/**
 * 把回包里的 config 收窄成 {@link RealtimeConfig}。
 *
 * 空串按「未配置」处理：宿主 readConfig 本来就不回空串字段（pickString 返回 null
 * 就不写），这里再兜一层，免得界面上出现「音色：空字符串」这种脏值。
 */
function readConfig(raw: unknown): RealtimeConfig {
  if (raw === null || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const out: RealtimeConfig = {}
  if (Array.isArray(source.vendors)) out.vendors = readVendorList(source.vendors)
  if (typeof source.defaultVendor === 'string' && source.defaultVendor !== '') out.defaultVendor = source.defaultVendor
  if (typeof source.voice === 'string' && source.voice !== '') out.voice = source.voice
  if (source.speed === 'slow' || source.speed === 'normal' || source.speed === 'fast') out.speed = source.speed
  if (typeof source.webSearch === 'boolean') out.webSearch = source.webSearch
  return out
}

/** 读内置模板（宿主没回时回退到 shared 里的同一份，旧宿主也能用）。 */
function readPresets(raw: unknown): RealtimeVendorRecord[] {
  const list = readVendorList(raw)
  if (list.length > 0) return list
  return DEFAULT_REALTIME_VENDORS.map(item => ({ ...item }))
}

/** 读一个音色选项（id / label 必填，hint 可选）。 */
function readVoiceOption(raw: unknown): RealtimeVoiceOption | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  if (typeof source.id !== 'string' || source.id === '') return null
  if (typeof source.label !== 'string' || source.label === '') return null
  return typeof source.hint === 'string' && source.hint !== ''
    ? { id: source.id, label: source.label, hint: source.hint }
    : { id: source.id, label: source.label }
}

/** 读音色清单；缺失/为空时回退到 shared 的官方清单。 */
function readVoices(raw: unknown): RealtimeVoiceOption[] {
  const out: RealtimeVoiceOption[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const option = readVoiceOption(entry)
      if (option !== null) out.push(option)
    }
  }
  return out.length > 0 ? out : [...REALTIME_VOICES]
}

/** 读宿主候选模型链（只用于输入框的候选建议，不影响真正提交的值）。 */
function readHostModels(raw: unknown): string[] {
  const out: string[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry !== '' && !out.includes(entry)) out.push(entry)
    }
  }
  return out
}

/** 读 `defaults` 字段；缺失时退回与宿主一致的默认值（音色空串、联网开、语速正常）。 */
function readDefaults(raw: unknown): RealtimeDefaults {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const speed = source.speed
  return {
    voice: typeof source.voice === 'string' ? source.voice : '',
    // 联网默认开：语音会话里模型没有别的联网手段，关掉就等于用户问实时信息时只能听
    // 「我查不了」——这与宿主侧 webSearch 的默认值同源（见 mount.ts 的注释）。
    webSearch: source.webSearch !== false,
    speed: speed === 'slow' || speed === 'fast' || speed === 'normal' ? speed : 'normal',
  }
}

/** 从回包里取给人看的错误文案（宿主的失败形状是 `{ ok:false, error }`）。 */
function readError(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null
  if (typeof payload.error === 'string' && payload.error !== '') return payload.error
  if (typeof payload.message === 'string' && payload.message !== '') return payload.message
  return null
}

/** 音色 id → 中文名（在给定清单里找；复刻音色找不到时原样返回 id）。 */
function voiceLabel(id: string, voices: readonly RealtimeVoiceOption[]): string {
  for (const voice of voices) {
    if (voice.id === id) return voice.label
  }
  return id
}

/* -------------------------------------------------------------------------- */
/* 纯函数：id / 凭据名 / 记录构造                                               */
/* -------------------------------------------------------------------------- */

/**
 * 名称 → id slug（小写 + 连字符）。
 *
 * 中文名称洗不出 ASCII 时回退 `live`：id 只在本机当稳定标识用（`defaultVendor`
 * 引用它），不需要可读，只要唯一。
 */
function slugify(label: string): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii === '' ? 'live' : ascii
}

/**
 * 生成不重复的 id：重名时依次尝试 `-2` / `-3` …
 *
 * 为什么不用随机后缀：列表里出现 `live-8f3a` 这种 id 时，用户看不出它是谁；顺序
 * 后缀至少能对上「第二家」。
 */
function uniqueVendorId(label: string, existing: readonly RealtimeVendorRecord[]): string {
  const base = slugify(label)
  const taken = new Set(existing.map(item => item.id))
  if (!taken.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/**
 * id → 默认凭据名（`my-live` → `MY_LIVE_API_KEY`）。
 *
 * 用户新增时只填「名称 / 上游地址 / API Key / 模型」（用户明确要求最少字段），
 * 凭据名是 DSH 内部概念，不该逼他理解；留空就按这个规则派生一个合法名字。
 */
export function keyRefFromId(id: string): string {
  const base = id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const prefixed = base === '' ? 'LIVE' : (/^[A-Z]/.test(base) ? base : `LIVE_${base}`)
  return `${prefixed}_API_KEY`
}

/** 采样率文本 → 数字；空 / 非数字 / 越界都返回 undefined（= 不写这个字段，宿主按 24000 兜底）。 */
function parseSampleRate(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  if (rounded < LIVE_SAMPLE_RATE_MIN || rounded > LIVE_SAMPLE_RATE_MAX) return undefined
  return rounded
}

/** 空草稿（新增用）。 */
function emptyDraft(): VendorDraft {
  return { label: '', upstream: '', keyRef: '', model: '', inputSampleRate: '', outputSampleRate: '' }
}

/** 已有记录 → 草稿（编辑用）。 */
export function draftOf(vendor: RealtimeVendorRecord): VendorDraft {
  return {
    label: vendor.label,
    upstream: vendor.upstream,
    keyRef: vendor.keyRef,
    model: vendor.model ?? '',
    inputSampleRate: vendor.inputSampleRate === undefined ? '' : String(vendor.inputSampleRate),
    outputSampleRate: vendor.outputSampleRate === undefined ? '' : String(vendor.outputSampleRate),
  }
}

/**
 * 草稿 → 待提交的记录。
 *
 * 只写有值的可选字段：`model: ''` 写进配置会被宿主 normalizeVendor 丢掉，但空串
 * 留在前端对象里会让「模型：空字符串」这种脏值一路传到下一次渲染。
 */
function buildVendorRecord(id: string, draft: VendorDraft): RealtimeVendorRecord {
  const label = draft.label.trim() === '' ? id : draft.label.trim()
  const keyRef = draft.keyRef.trim() === '' ? keyRefFromId(id) : draft.keyRef.trim()
  const record: RealtimeVendorRecord = { id, label, upstream: draft.upstream.trim(), keyRef }
  const model = draft.model.trim()
  if (model !== '') record.model = model
  const inputRate = parseSampleRate(draft.inputSampleRate)
  if (inputRate !== undefined) record.inputSampleRate = inputRate
  const outputRate = parseSampleRate(draft.outputSampleRate)
  if (outputRate !== undefined) record.outputSampleRate = outputRate
  return record
}

/* -------------------------------------------------------------------------- */
/* store hook                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Live 供应商的共享 store（页面级单例，由 section 调一次）。
 *
 * 不接收任何参数：这是一份**全局**列表，与当前聊天供应商无关（旧版靠 `route`
 * 按供应商各存一份，正是用户否掉的设计）。
 *
 * @returns 左右两栏共用的状态与动作。
 */
export function useLiveVendorStore(): LiveVendorStore {
  const [loaded, setLoaded] = useState(false)
  /** 宿主回读的权威配置（vendors 列表 + 全局默认字段）。 */
  const [config, setConfig] = useState<RealtimeConfig>({})
  /** 内置模板（新增时快速填；宿主没回就用 shared 里的同一份）。 */
  const [presets, setPresets] = useState<RealtimeVendorRecord[]>([])
  /** 音色清单（GET 回的 REALTIME_VOICES；缺失回退常量）。 */
  const [voices, setVoices] = useState<RealtimeVoiceOption[]>([...REALTIME_VOICES])
  /** 宿主候选模型链（只做输入框建议）。 */
  const [hostModels, setHostModels] = useState<string[]>([])
  const [defaults, setDefaults] = useState<RealtimeDefaults>({ voice: '', webSearch: true, speed: 'normal' })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  /** 待确认删除的 vendor id（点第一次只进确认态，第二次才真删）。 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** 采样率折叠区（默认收起：新增只填最少的，采样率是高级项）。 */
  const [advanced, setAdvanced] = useState(false)
  /**
   * API Key 是**另走一条通道**的（`POST REALTIME_KEY_PATH`），所以草稿与反馈都单独
   * 一份：它不属于 config 的任何字段，成功之后宿主也只回引用名，没有「回读值」可灌。
   */
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [keyNotice, setKeyNotice] = useState<KeyNotice | null>(null)
  /**
   * 请求在飞标记用 ref 而不是 state：按钮点击与回车可能在同一拍触发两次，state 要等
   * 下一次渲染才更新，读到的会是旧值。两条通道各自一份，互不阻塞。
   */
  const savingRef = useRef(false)
  const keySavingRef = useRef(false)
  /** 重新拉配置的触发器（失败重试按钮用）。 */
  const [reloadTick, setReloadTick] = useState(0)
  /**
   * 模型候选 `<datalist>` 的 id。
   *
   * 用 `useId` 而不是写死字符串：同一页面可能同时挂多个区块（不同供应商详情页在
   * keep-alive 下会共存），id 撞了以后候选列表会串台。`useId` 的值带冒号，先洗成
   * 合法的 id 片段再用。
   */
  const rawModelListId = useId()
  const modelListId = `live-vendor-models-${rawModelListId.replace(/[^A-Za-z0-9_-]/g, '')}`

  // 全局列表：拉一次就够（与当前聊天供应商无关，所以没有 route 依赖）。
  useEffect(() => {
    let alive = true
    setLoaded(false)
    fetch(REALTIME_CONFIG_PATH, { cache: 'no-store' })
      .then((response) => {
        // 404 不是「没配过」，而是宿主进程里还没有这条路由（跑的是旧版插件）——两者在
        // 界面上必须区分开，否则用户会以为「设置全丢了」。这一条实测踩过：宿主没重启时
        // 诊断路由 200、配置路由 404。
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        return response.json() as Promise<unknown>
      })
      .then((raw) => {
        if (!alive) return
        const payload = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : null
        if (payload === null || payload.ok === false) {
          setError(readError(payload) ?? '读取 Live 供应商设置失败')
          return
        }
        const rawConfig = payload.config
        const configRecord = rawConfig !== null && typeof rawConfig === 'object'
          ? rawConfig as Record<string, unknown>
          : null
        /*
         * 旧宿主的 config 里没有 `vendors`（还是单供应商的 vendor/model/keyRef 字段）。
         * 必须说清楚：否则界面会渲染成「一条供应商都没有」，用户会以为列表被清空了。
         */
        if (configRecord === null || !Array.isArray(configRecord.vendors)) {
          setError('宿主返回的配置里没有 Live 供应商列表（vendors）——运行中的宿主可能还是旧版插件。重启 DSH 后重新打开这一页。')
        }
        setConfig(readConfig(rawConfig))
        setPresets(readPresets(payload.presets))
        setVoices(readVoices(payload.voices))
        setHostModels(readHostModels(payload.models))
        setDefaults(readDefaults(payload.defaults))
      })
      .catch((cause: unknown) => {
        if (!alive) return
        const detail = cause instanceof Error ? cause.message : ''
        setError(`读取 Live 供应商设置失败（${detail}）。宿主需要先加载带 /api/personal-agent/realtime/config 的插件版本：重启 DSH 后重新打开这一页。`)
      })
      .finally(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [reloadTick])

  // 「已保存」自己消失：常驻会变成一条没人维护的状态行，短暂出现就够了。
  useEffect(() => {
    if (!saved) return undefined
    const timer = window.setTimeout(() => { setSaved(false) }, 1800)
    return () => { window.clearTimeout(timer) }
  }, [saved])

  const vendors = config.vendors ?? []
  const defaultVendor = config.defaultVendor ?? ''
  const voice = config.voice ?? ''
  const currentSpeed = config.speed ?? defaults.speed
  const webSearch = config.webSearch ?? defaults.webSearch
  const defaultVendorRecord = vendors.find(item => item.id === defaultVendor) ?? null
  /** 当前音色是否属于官方清单（否则是复刻音色 / 旧值，要显示成「自定义」并保留）。 */
  const voiceIsCustom = voice !== '' && !voices.some(option => option.id === voice)
  /**
   * 「自动」时实际会用哪个音色：宿主回读的默认值优先（插件 config 里可能配过），
   * 否则官方默认。不显示真值的话，「自动」在界面上是个黑箱。
   */
  const defaultVoiceLabel = voiceLabel(defaults.voice !== '' ? defaults.voice : REALTIME_DEFAULT_VOICE, voices)

  /**
   * 模型候选：正在编辑的值 → 内置模板 → 已有供应商 → 宿主候选链（去重）。
   *
   * 顺序就是「最可能用到的排前面」，不排序：模板里的顺序是宿主真实回退顺序，
   * 打乱会让用户以为候选链换了。
   */
  const modelSuggestions: string[] = []
  const pushModel = (value: string | undefined): void => {
    if (value === undefined || value === '') return
    if (!modelSuggestions.includes(value)) modelSuggestions.push(value)
  }
  if (editing !== null) pushModel(editing.draft.model.trim())
  for (const preset of presets) pushModel(preset.model)
  for (const vendor of vendors) pushModel(vendor.model)
  for (const model of hostModels) pushModel(model)

  /** 新增时的临时 id（表单里显示派生凭据名用；真正提交时才定下来）。 */
  const draftId = editing === null
    ? ''
    : editing.id ?? uniqueVendorId(editing.draft.label.trim() === '' ? 'live' : editing.draft.label, vendors)

  /** 表单里当前这条会用到哪个凭据名：手填优先，留空按 id 派生。 */
  const editingKeyRef = editing === null
    ? ''
    : (editing.draft.keyRef.trim() === '' ? keyRefFromId(draftId) : editing.draft.keyRef.trim())

  /**
   * 提交一组字段，并把宿主回读的 config 灌回界面。
   *
   * 只发白名单字段；`vendors` 是整体覆盖（增删改都靠它）。
   *
   * @param patch - 要写的字段（省略 = 不改）。
   * @returns 是否真的写成功（保存密钥那条链路要靠它决定「要不要继续保存列表」）。
   */
  const save = async (patch: RealtimeConfig): Promise<boolean> => {
    if (savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(REALTIME_CONFIG_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
        cache: 'no-store',
      })
      // 失败必须可见：静默忽略会让控件停在旧值，用户以为已经切换（与生图/生视频块同一条纪律）。
      if (!response.ok) {
        setError(`保存失败（HTTP ${response.status}）——宿主还没加载带 /api/personal-agent/realtime/config 的插件版本。`)
        return false
      }
      const raw: unknown = await response.json()
      const payload = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : null
      if (payload === null || payload.ok !== true) {
        setError(readError(payload) ?? '保存失败')
        return false
      }
      setConfig(readConfig(payload.config))
      setSaved(true)
      return true
    } catch {
      setError('保存请求失败（宿主接口不可用）')
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  /**
   * 写一条凭据：`POST REALTIME_KEY_PATH`（body `{ ref, value }`）。
   *
   * 三条纪律：
   *  1. **只写不读**：成功只显示宿主回的引用名，输入框直接清空——页面任何地方都不回显密钥；
   *  2. **失败必须可见**：宿主在 400/413/501/500 里也带 `{ ok: false, error }`，所以先把
   *     body 读出来再判状态码，否则用户只看到「HTTP 400」而不知道是凭据名不合法还是密钥为空；
   *  3. **写到的引用名必须与列表里那条供应商一致**：调用方传的 ref 就是表单里（或派生出的）
   *     凭据名，保存列表时用的也是同一个值。
   *
   * @param ref - 凭据引用名（DSH credentials 里的名字）。
   * @param value - 密钥明文；只在本函数内出现，不落任何 state。
   * @returns 是否写成功。
   */
  const writeKey = async (ref: string, value: string): Promise<boolean> => {
    if (value.length > LIVE_KEY_MAX_LENGTH) {
      setKeyNotice({ tone: 'error', text: `密钥过长（上限 ${LIVE_KEY_MAX_LENGTH} 个字符），确认粘贴的是 key 本身` })
      return false
    }
    // 前端先按宿主的同一规则挡一道：名字来自自动派生或用户手填，中文/空格发过去必然 400。
    if (!LIVE_KEY_REF_PATTERN.test(ref)) {
      setKeyNotice({ tone: 'error', text: `凭据名「${ref}」不合法：只能字母开头，后接字母 / 数字 / 下划线` })
      return false
    }
    if (keySavingRef.current) return false
    keySavingRef.current = true
    setKeySaving(true)
    setKeyNotice(null)
    try {
      const response = await fetch(REALTIME_KEY_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref, value }),
        cache: 'no-store',
      })
      // 失败时宿主也回 JSON，所以不能只看 response.ok —— error 字段才是给人看的原因。
      const raw: unknown = await response.json().catch(() => null)
      const payload = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : null
      /*
       * 404 不是「参数错了」，而是运行中的宿主进程里还没有这条路由（跑的是旧版插件）——
       * 与配置路由的 404 同一个坑，必须单独说清楚，否则用户只会看到一句 "not found"。
       */
      if (response.status === 404) {
        setKeyNotice({ tone: 'error', text: '保存失败：宿主还没加载带 /api/personal-agent/realtime/key 的插件版本——重启 DSH 后重试' })
        return false
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        setKeyNotice({ tone: 'error', text: readError(payload) ?? `保存失败（HTTP ${response.status}）` })
        return false
      }
      const savedRef = typeof payload.ref === 'string' && payload.ref !== '' ? payload.ref : ref
      // 成功：清掉密钥草稿（只写不读，留着它就是一份没人用的明文）。
      setKeyDraft('')
      setKeyNotice({ tone: 'ok', text: `已保存（引用名 ${savedRef}）` })
      return true
    } catch {
      setKeyNotice({ tone: 'error', text: '保存请求失败（宿主接口不可用）' })
      return false
    } finally {
      keySavingRef.current = false
      setKeySaving(false)
    }
  }

  /**
   * 保存整张表单。
   *
   * 顺序：**先写密钥、再提交列表**。反过来的话，密钥写失败时列表里已经多了一条
   * 「看起来配好了」的供应商，通话却报找不到凭据；现在最坏只是「密钥写了、列表
   * 没存」，重试一次即可。
   */
  const commitEdit = async (): Promise<void> => {
    if (editing === null) return
    const draft = editing.draft
    const label = draft.label.trim()
    if (label === '') {
      setFormError('名称必填：它就是列表里显示的那一行')
      return
    }
    const upstream = draft.upstream.trim()
    if (upstream === '') {
      setFormError('上游地址必填，例如 wss://api.stepfun.com/v1/realtime')
      return
    }
    const id = draftId
    const keyRef = editingKeyRef
    if (!LIVE_KEY_REF_PATTERN.test(keyRef)) {
      setFormError(`凭据名「${keyRef}」不合法：只能字母开头，后接字母 / 数字 / 下划线（在凭据名里改，或留空自动生成）`)
      return
    }
    setFormError(null)
    const typedKey = keyDraft.trim()
    if (typedKey !== '') {
      const keyOk = await writeKey(keyRef, typedKey)
      if (!keyOk) return
    }
    const record = buildVendorRecord(id, { ...draft, keyRef })
    const next = editing.id === null
      ? [...vendors, record]
      : vendors.map(item => (item.id === editing.id ? record : item))
    /*
     * 首次新增自动设为默认：列表里总要有一条默认，否则「刚加的那条」看起来不像生效。
     * 已有默认时保持不动——用户点「设为默认」才会换。
     */
    const nextDefault = defaultVendor !== '' ? defaultVendor : id
    const ok = await save({ vendors: next, defaultVendor: nextDefault })
    if (!ok) return
    setEditing(null)
    setKeyDraft('')
    setKeyNotice(null)
  }

  /** 「保存密钥」按钮：只写凭据、不动列表（用于「列表没改，只想换一把 key」）。 */
  const submitKeyOnly = async (): Promise<void> => {
    if (editing === null) return
    const value = keyDraft.trim()
    if (value === '') {
      setKeyNotice({ tone: 'error', text: '先粘贴 API Key 再保存' })
      return
    }
    await writeKey(editingKeyRef, value)
  }

  /** 打开编辑（清掉上一次的密钥草稿与反馈：跨供应商残留会让人以为它已生效）。 */
  const select = (id: string): void => {
    const vendor = vendors.find(item => item.id === id)
    if (vendor === undefined) return
    setEditing({ id: vendor.id, draft: draftOf(vendor) })
    setFormError(null)
    setPendingDelete(null)
    setAdvanced(false)
    setKeyDraft('')
    setKeyNotice(null)
  }

  /** 打开新增。 */
  const beginCreate = (): void => {
    setEditing({ id: null, draft: emptyDraft() })
    setFormError(null)
    setPendingDelete(null)
    setAdvanced(false)
    setKeyDraft('')
    setKeyNotice(null)
  }

  /** 收起表单（不改任何已保存的值）。 */
  const cancelEdit = (): void => {
    setEditing(null)
    setFormError(null)
    setAdvanced(false)
    setKeyDraft('')
    setKeyNotice(null)
    setPendingDelete(null)
  }

  /** 切换页面模式时清掉选中态与表单（含未保存草稿），避免两套内容串台。 */
  const resetSelection = (): void => {
    setEditing(null)
    setFormError(null)
    setAdvanced(false)
    setKeyDraft('')
    setKeyNotice(null)
    setPendingDelete(null)
  }

  /** 用内置模板填表单（用户可再改任何一项）。 */
  const applyPreset = (preset: RealtimeVendorRecord): void => {
    setEditing(current => current === null
      ? current
      : {
        ...current,
        draft: {
          label: preset.label,
          upstream: preset.upstream,
          keyRef: preset.keyRef,
          model: preset.model ?? '',
          inputSampleRate: preset.inputSampleRate === undefined ? '' : String(preset.inputSampleRate),
          outputSampleRate: preset.outputSampleRate === undefined ? '' : String(preset.outputSampleRate),
        },
      })
  }

  /** 把某条设为默认（只提交 defaultVendor，列表本身不动）。 */
  const setDefault = async (vendor: RealtimeVendorRecord): Promise<void> => {
    if (vendor.id === defaultVendor) return
    await save({ defaultVendor: vendor.id })
  }

  /**
   * 删除一条。
   *
   * 删的是默认项时把默认指向剩余第一条；删空时提交空串（宿主读配置会回落到
   * 「第一条」的语义，但列表为空时它自己会重新播种内置模板——这是宿主的既有行为，
   * 前端不做特殊处理）。
   */
  const removeVendor = async (vendor: RealtimeVendorRecord): Promise<void> => {
    const next = vendors.filter(item => item.id !== vendor.id)
    const nextDefault = defaultVendor === vendor.id ? (next[0]?.id ?? '') : defaultVendor
    const ok = await save({ vendors: next, defaultVendor: nextDefault })
    if (!ok) return
    setPendingDelete(null)
    if (editing !== null && editing.id === vendor.id) cancelEdit()
  }

  /** 清掉密钥反馈（用户重新输入时调用）。 */
  const clearKeyNotice = (): void => { setKeyNotice(null) }

  /** 草稿字段更新（一次改一个键，避免每个字段各写一份 setState）。 */
  const patchDraft = (patch: Partial<VendorDraft>): void => {
    setEditing(current => current === null ? null : { ...current, draft: { ...current.draft, ...patch } })
  }

  return {
    loaded,
    vendors,
    defaultVendor,
    defaultVendorRecord,
    presets,
    voices,
    defaults,
    voice,
    voiceIsCustom,
    defaultVoiceLabel,
    currentSpeed,
    webSearch,
    modelSuggestions,
    error,
    saved,
    saving,
    editing,
    draftId,
    editingKeyRef,
    formError,
    advanced,
    keyDraft,
    keySaving,
    keyNotice,
    pendingDelete,
    modelListId,
    reload: () => { setError(null); setReloadTick(tick => tick + 1) },
    select,
    beginCreate,
    applyPreset,
    patchDraft,
    setKeyDraft,
    clearKeyNotice,
    setAdvanced,
    setPendingDelete,
    cancelEdit,
    resetSelection,
    commitEdit,
    submitKeyOnly,
    removeVendor,
    setDefault,
    saveGlobal: save,
  }
}
