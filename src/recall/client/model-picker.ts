/**
 * dsh-recall-plugin — 模型选择服务桥（编辑卡上的模型菜单）
 *
 * 官方 model-selection 包注册 `ctx.modelDirectories`：每个会话一个 ModelDirectory，
 * 它把「Host 目录 + 会话持久选择」合成同一份状态，`select()` 走与官方 chip、
 * `/model` 命令同一个 `sessions.selectModel` 通道。所以卡里换模型会同步到底部
 * 输入框的 chip，fork 出的子会话也沿用这次选择——插件不需要自己拼选择载荷。
 *
 * 菜单是两段式（官方同构）：模型列表（搜索 + 按供应商分组）与推理等级，
 * 本模块只负责把目录摊成这两段需要的形状；渲染在 model-menu.ts。
 *
 * 服务形态全部按能力探测（0.2.1-rc.2 实证），任何一环缺失就返回 null，卡片退回
 * 只读展示（值抄自底部输入框的槽容器）。
 */

import type { ClientContext } from '../types/client-contract.js'

/** 一个可选模型；key 只用于列表渲染，选择时用的是 provider/model/effort */
export interface ModelOption {
  key: string
  provider: string
  model: string
  label: string
  // 推理等级：defaultEffort 是模型的默认档，efforts 是可选档位（可能是空数组）
  defaultEffort?: string
  efforts: Array<{ id: string; name: string }>
}

/** 按供应商分组后的菜单项（官方菜单同样按供应商分段） */
export interface ModelGroup {
  id: string
  name: string
  options: ModelOption[]
}

export interface ModelPickerState {
  /** 当前模型的展示文案（含价格后缀，取自目录里的 name） */
  label: string
  /** 当前选择对应的 option.key；目录里找不到时为空串 */
  activeKey: string
  /** 推理等级的展示文案（provider default 时由调用方给「Default」） */
  effortLabel: string
  /** 当前档位 id；provider default 时为空串 */
  activeEffortId: string
  groups: ModelGroup[]
}

export interface ModelPickerApi {
  /** 读取目录（会触发一次官方 load）；服务不可用返回 null */
  load(): Promise<ModelPickerState | null>
  /** 提交选择；成功返回 null，失败返回可直接展示的错误文案 */
  select(option: ModelOption, effortId: string): Promise<string | null>
}

// 官方目录快照的最小形状（只读我们需要的字段，其余忽略）
interface DirectoryState {
  current?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
  groups?: Array<{
    id?: unknown
    name?: unknown
    models?: Array<{
      id?: unknown
      name?: unknown
      reasoning?: { defaultEffort?: unknown; efforts?: Array<{ id?: unknown; name?: unknown }> }
    }>
  }>
}

interface Directory {
  store?: { getSnapshot?: () => unknown }
  load?: () => Promise<unknown>
  select?: (selection: unknown) => Promise<unknown>
}

interface Resolver {
  directoryFor?: (sessionId: string) => Directory | null | undefined
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function buildModelPicker(ctx: ClientContext, sessionId: string): ModelPickerApi | null {
  if (!sessionId) return null
  let directory: Directory | null = null

  const resolve = (): Directory | null => {
    if (directory !== null) return directory
    try {
      const resolver = ctx.get<Resolver>('modelDirectories')
      if (!resolver || typeof resolver.directoryFor !== 'function') return null
      directory = resolver.directoryFor(sessionId) || null
      return directory
    } catch (e) {
      return null
    }
  }

  const readState = (): DirectoryState | null => {
    const dir = resolve()
    const snapshot = dir && dir.store && typeof dir.store.getSnapshot === 'function' ? dir.store.getSnapshot() : null
    return snapshot && typeof snapshot === 'object' ? snapshot as DirectoryState : null
  }

  return {
    async load() {
      const dir = resolve()
      if (!dir) return null
      if (typeof dir.load === 'function') {
        try { await dir.load() } catch (e) { /* 读取失败就用手头快照，最坏只剩只读展示 */ }
      }
      const state = readState()
      if (!state) return null
      const groups: ModelGroup[] = []
      for (const group of Array.isArray(state.groups) ? state.groups : []) {
        const provider = text(group && group.id)
        if (provider === '') continue
        const options: ModelOption[] = []
        for (const model of Array.isArray(group.models) ? group.models : []) {
          const modelId = text(model && model.id)
          if (modelId === '') continue
          const efforts: Array<{ id: string; name: string }> = []
          for (const level of model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : []) {
            const id = text(level && level.id)
            if (id !== '') efforts.push({ id, name: text(level.name) || id })
          }
          const defaultEffort = text(model.reasoning && model.reasoning.defaultEffort)
          options.push({
            key: provider + '/' + modelId,
            provider,
            model: modelId,
            label: text(model.name) || modelId,
            efforts,
            ...defaultEffort === '' ? {} : { defaultEffort },
          })
        }
        groups.push({ id: provider, name: text(group.name) || provider, options })
      }
      const current = state.current || null
      const currentProvider = text(current && current.provider)
      const currentModel = text(current && current.model)
      const flat = groups.reduce<ModelOption[]>((all, group) => all.concat(group.options), [])
      const active = flat.find((option) => option.provider === currentProvider && option.model === currentModel)
      const effortId = text(current && current.reasoningEffort) || (active && active.defaultEffort) || ''
      const effortHit = active ? active.efforts.find((level) => level.id === effortId) : undefined
      return {
        label: active ? active.label : currentModel,
        activeKey: active ? active.key : '',
        effortLabel: effortHit ? effortHit.name : '',
        activeEffortId: effortId,
        groups,
      }
    },

    async select(option, effortId) {
      const dir = resolve()
      if (!dir || typeof dir.select !== 'function') return 'model selection is unavailable'
      try {
        const result = await dir.select({
          provider: option.provider,
          model: option.model,
          ...effortId === '' ? {} : { reasoningEffort: effortId },
        }) as { ok?: boolean; error?: { message?: unknown; code?: unknown } } | null
        if (result && result.ok === false) {
          const error = result.error || {}
          return text(error.message) || text(error.code) || 'model selection failed'
        }
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    },
  }
}
