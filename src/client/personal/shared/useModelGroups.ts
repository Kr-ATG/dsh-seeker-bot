/**
 * Personal Agent — 宿主可用模型列表（供应商 → 模型）读取 hook。
 *
 * 数据源：`GET /api/personal-agent/models` 返回 `{ ok, groups: [...] }`。
 * 列表属于宿主配置（用户可能在「设置 → 供应商」里随时增删），不进 localStorage；
 * 每次打开用到它的设置入口时现拉一次（`enabled` 从 false 变 true）。
 *
 * Bot 设置卡与群聊设置卡共用这个 hook，避免两处各写一份 fetch 与错误处理。
 * 读不到时 groups 保持空数组、error 给原因：调用方按「宿主没提供列表」降级，
 * 不能因此挡住其它设置项。
 */
import { useEffect, useState } from 'react'
import type { ModelPickerGroup } from './ModelPicker.tsx'

export interface ModelGroupsState {
  /** 宿主返回的供应商 / 模型分组；空数组 = 未加载完成或读取失败。 */
  groups: ModelPickerGroup[]
  loading: boolean
  /** 读不到时的原因；null = 一切正常。 */
  error: string | null
}

export function useModelGroups(enabled: boolean): ModelGroupsState {
  const [groups, setGroups] = useState<ModelPickerGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await fetch('/api/personal-agent/models', { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`读取模型列表失败（HTTP ${res.status}）`)
        const data = (await res.json()) as { ok?: boolean; groups?: ModelPickerGroup[] }
        if (data.ok !== true || !Array.isArray(data.groups)) {
          throw new Error('宿主未提供模型列表')
        }
        if (!alive) return
        setGroups(data.groups)
      } catch (err) {
        if (!alive) return
        // 读不到就保持空列表，由调用方显示空态 / 降级为文本输入。
        setGroups([])
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [enabled])

  return { groups, loading, error }
}
