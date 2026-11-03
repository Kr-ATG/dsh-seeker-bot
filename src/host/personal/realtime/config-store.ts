/**
 * 实时语音「用户级配置」的落盘读写。
 *
 * ## 结构
 *
 * ```json
 * {
 *   "vendors": [ { "id": "stepfun", "label": "...", "upstream": "wss://...", "keyRef": "...", "model": "..." } ],
 *   "defaultVendor": "stepfun",
 *   "voice": "linjiajiejie",
 *   "speed": "normal",
 *   "webSearch": true
 * }
 * ```
 *
 * `vendors` 是**用户自己维护的 Live 供应商列表**（可增删改），不是白名单。
 * 以前是按「聊天供应商 route」各存一份、用下拉切换，用户明确否掉了——那不是新增
 * 供应商，只是从三个写死的预设里挑一个。
 *
 * ## 为什么不用 DSH 的 settings 服务
 *
 * `settings.update(ns, patch)` 只认**已注册的插件 loader entry**：找不到就直接抛
 * `No configurable plugin entry`。任意命名空间写不进去，所以配置落在本插件自己的
 * 存储目录（与 routines.json / proactive.json 同一处）。
 *
 * ## 兼容旧文件
 *
 * 旧版本把配置按 `routes.<provider>` 分存、或只有单份 `vendor/model/keyRef/upstream`。
 * 读到没有 `vendors` 的文件时在这里**迁移**成一条 vendor，用户不用手动改文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_REALTIME_VENDORS,
  REALTIME_DEFAULT_KEY_REF,
  REALTIME_DEFAULT_UPSTREAM,
  type RealtimeConfig,
  type RealtimeVendorRecord,
} from '../../../shared/realtime-protocol.ts'

/** DSH 主目录（测试里用 DSH_HOME 覆盖）。 */
function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 配置文件路径（调用时算，便于测试里改 DSH_HOME）。 */
export function userConfigFile(): string {
  const dir = join(dshHome(), 'storages', 'dsh-seeker-bot', 'personal-agent')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'realtime-config.json')
}

/** 磁盘上的原始结构（含旧版本遗留字段）。 */
interface StoredConfig extends RealtimeConfig {
  /** @deprecated 旧版按聊天供应商分存的覆盖层。 */
  routes?: Record<string, RealtimeConfig>
}

/** 读原始结构（不做任何合并与迁移）。 */
function readRaw(): StoredConfig {
  try {
    const file = userConfigFile()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return {}
    return parsed as StoredConfig
  } catch {
    return {}
  }
}

/** 校验一条 vendor 记录；缺关键字段就丢掉（半个供应商渲染出来只会更难查）。 */
function normalizeVendor(raw: unknown): RealtimeVendorRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  const upstream = typeof source.upstream === 'string' ? source.upstream.trim() : ''
  const keyRef = typeof source.keyRef === 'string' ? source.keyRef.trim() : ''
  if (id === '' || upstream === '' || keyRef === '') return null
  const label = typeof source.label === 'string' ? source.label.trim() : ''
  const vendor: RealtimeVendorRecord = {
    id,
    label: label === '' ? id : label,
    upstream,
    keyRef,
  }
  if (typeof source.model === 'string' && source.model.trim() !== '') vendor.model = source.model.trim()
  const inputRate = Number(source.inputSampleRate)
  if (Number.isFinite(inputRate) && inputRate >= 8000 && inputRate <= 48000) vendor.inputSampleRate = Math.round(inputRate)
  const outputRate = Number(source.outputSampleRate)
  if (Number.isFinite(outputRate) && outputRate >= 8000 && outputRate <= 48000) vendor.outputSampleRate = Math.round(outputRate)
  return vendor
}

/**
 * 以内置预设为基底，用迁移出来的记录覆盖同 id 的那条。
 *
 * 为什么不是「迁移出几条就只返回几条」：用户旧配置里通常只存了他用过的那一家
 * （比如只有 StepFun），直接返回一条会让他以为「千问预设丢了」。内置预设本来就
 * 是给用户挑的模板，迁移时补回列表、让同 id 的旧配置覆盖预设字段即可。
 */
function mergeIntoPresets(migrated: RealtimeVendorRecord[]): RealtimeVendorRecord[] {
  const base = DEFAULT_REALTIME_VENDORS.map((item) => ({ ...item }))
  for (const item of migrated) {
    // 先按 id 找，找不到再按上游地址找——同一个端点不该在列表里出现两次
    // （旧版按聊天供应商 route 迁移出来的是 `stepplan`，而预设里叫 `stepfun`，
    //  只按 id 匹配就会变成「两条 StepFun」，用户实测截图里就是这个）。
    let index = base.findIndex((entry) => entry.id === item.id)
    if (index < 0) index = base.findIndex((entry) => sameEndpoint(entry.upstream, item.upstream))
    if (index >= 0) base[index] = item
    else base.push(item)
  }
  return base
}

/** 两个上游地址是否指向同一个端点（忽略大小写与结尾斜杠）。 */
function sameEndpoint(a: string, b: string): boolean {
  const norm = (value: string): string => value.trim().toLowerCase().replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/**
 * 按上游地址去重，保留第一条。
 *
 * 用户配置文件里可能同时存在「旧版按 route 迁移出来的 stepplan」与「内置预设 stepfun」，
 * 两者上游地址一样、label 一样，列表里就会显示成两条同名供应商（用户实测截图）。
 * 同一个端点用一个 key 连，重复一条没有任何意义。
 */
function dedupeByEndpoint(vendors: RealtimeVendorRecord[]): RealtimeVendorRecord[] {
  const seen = new Set<string>()
  const out: RealtimeVendorRecord[] = []
  for (const vendor of vendors) {
    const key = vendor.upstream.trim().toLowerCase().replace(/\/+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(vendor)
  }
  return out
}
/**
 * 把旧版配置迁移成 `vendors` 列表。
 *
 * @param raw 磁盘上的原始结构。
 * @returns 迁移后的 vendor 列表（至少一条）。
 */
function migrateVendors(raw: StoredConfig): RealtimeVendorRecord[] {
  // 1) 新格式：直接用。**空数组也尊重**——用户把供应商全删了就该是空的，
  //    不能偷偷塞回预设（否则「删不干净」，跟之前「清不掉配置」是同一类问题）。
  if (Array.isArray(raw.vendors)) {
    return dedupeByEndpoint(raw.vendors.map(normalizeVendor).filter((item): item is RealtimeVendorRecord => item !== null))
  }
  // 2) 旧格式 A：单份 vendor/model/keyRef/upstream
  if (typeof raw.vendor === 'string' || typeof raw.upstream === 'string' || typeof raw.keyRef === 'string') {
    const preset = DEFAULT_REALTIME_VENDORS.find((item) => item.id === raw.vendor)
    const migrated = normalizeVendor({
      id: typeof raw.vendor === 'string' && raw.vendor !== '' ? raw.vendor : 'default',
      label: preset?.label ?? (typeof raw.vendor === 'string' && raw.vendor !== '' ? raw.vendor : '默认'),
      upstream: typeof raw.upstream === 'string' && raw.upstream !== '' ? raw.upstream : (preset?.upstream ?? REALTIME_DEFAULT_UPSTREAM),
      keyRef: typeof raw.keyRef === 'string' && raw.keyRef !== '' ? raw.keyRef : (preset?.keyRef ?? REALTIME_DEFAULT_KEY_REF),
      model: typeof raw.model === 'string' ? raw.model : preset?.model,
      inputSampleRate: preset?.inputSampleRate,
      outputSampleRate: preset?.outputSampleRate,
    })
    if (migrated !== null) return mergeIntoPresets([migrated])
  }
  // 3) 旧格式 B：按聊天供应商分存（routes.*）——挑第一个有内容的
  if (raw.routes !== undefined && raw.routes !== null && typeof raw.routes === 'object') {
    for (const [route, scoped] of Object.entries(raw.routes)) {
      if (scoped === null || typeof scoped !== 'object') continue
      const item = scoped as RealtimeConfig
      const preset = DEFAULT_REALTIME_VENDORS.find((entry) => entry.id === item.vendor)
      const migrated = normalizeVendor({
        // 用预设 id 而不是聊天供应商 route：否则同一端点会以两个 id 并存（两条 StepFun）
        id: preset?.id ?? route,
        label: preset?.label ?? route,
        upstream: typeof item.upstream === 'string' && item.upstream !== '' ? item.upstream : (preset?.upstream ?? REALTIME_DEFAULT_UPSTREAM),
        keyRef: typeof item.keyRef === 'string' && item.keyRef !== '' ? item.keyRef : (preset?.keyRef ?? REALTIME_DEFAULT_KEY_REF),
        model: item.model ?? preset?.model,
        inputSampleRate: preset?.inputSampleRate,
        outputSampleRate: preset?.outputSampleRate,
      })
      if (migrated !== null) return mergeIntoPresets([migrated])
    }
  }
  // 4) 全新：内置预设
  return DEFAULT_REALTIME_VENDORS.map((item) => ({ ...item }))
}

/** 读用户级配置（vendors 已迁移/播种，永远至少一条）。 */
export function readUserConfig(): RealtimeConfig & { vendors: RealtimeVendorRecord[] } {
  const raw = readRaw()
  const vendors = migrateVendors(raw)
  const out: RealtimeConfig & { vendors: RealtimeVendorRecord[] } = { vendors }
  const defaultVendor = typeof raw.defaultVendor === 'string' && raw.defaultVendor !== ''
    ? raw.defaultVendor
    : (vendors[0]?.id ?? '')
  if (defaultVendor !== '') out.defaultVendor = defaultVendor
  if (typeof raw.voice === 'string') out.voice = raw.voice
  if (raw.speed === 'slow' || raw.speed === 'fast' || raw.speed === 'normal') out.speed = raw.speed
  if (typeof raw.webSearch === 'boolean') out.webSearch = raw.webSearch
  return out
}

/**
 * 合并写用户级配置。
 *
 * @param patch 要覆盖的字段；`undefined` 跳过（= 不修改），空串照存（= 清空回默认）。
 *   `vendors` 是**整体覆盖**（列表的增删改都靠它）。
 */
export function writeUserConfig(patch: RealtimeConfig): void {
  const raw = readRaw()
  const next: StoredConfig = { ...raw }
  /*
   * 写回前先把旧格式迁移成 `vendors`：否则「只改了音色」的一次写入会把文件保持
   * 旧形状，下次读还得再迁移一遍，而且用户会看到「配置里始终没有供应商列表」。
   */
  next.vendors = patch.vendors === undefined
    ? migrateVendors(raw)
    : patch.vendors.map(normalizeVendor).filter((item): item is RealtimeVendorRecord => item !== null)
  for (const key of ['defaultVendor', 'voice', 'speed', 'webSearch'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    ;(next as Record<string, unknown>)[key] = value
  }
  // 迁移完成后把旧字段清掉，避免下次读到两份互相矛盾的配置
  delete next.routes
  delete next.vendor
  delete next.model
  delete next.keyRef
  delete next.upstream
  writeFileSync(userConfigFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

/**
 * 按 id 找一条 vendor。
 *
 * @param config 已迁移的配置。
 * @param id 想要的 id；空/找不到时回落到 `defaultVendor`，再回落到第一条。
 */
export function pickVendor(
  config: { vendors: RealtimeVendorRecord[]; defaultVendor?: string },
  id?: string,
): RealtimeVendorRecord | null {
  const wanted = (id ?? '').trim()
  if (wanted !== '') {
    const hit = config.vendors.find((item) => item.id === wanted)
    if (hit !== undefined) return hit
  }
  const fallbackId = (config.defaultVendor ?? '').trim()
  if (fallbackId !== '') {
    const hit = config.vendors.find((item) => item.id === fallbackId)
    if (hit !== undefined) return hit
  }
  return config.vendors[0] ?? null
}
