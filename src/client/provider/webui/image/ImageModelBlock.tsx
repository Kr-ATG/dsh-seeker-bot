/**
 * ImageModelBlock — 生图模型区块。
 *
 * 两类信息：
 *   1. **生图来源**（2026-11-07 新增）：供应商内置 generate_image vs
 *      MCP（magpie-image）。两套只生效一套——另一套在 system-prompt/assemble
 *      出口被撤掉（见 src/provider/image-source.mjs）。缺省保持「供应商」，
 *      与用户既有配置一致。
 *   2. 供应商生图模型：两级下拉——先选供应商，再选该供应商下**已声明「生图」**
 *      的模型；选中即保存。只列已经勾选生图能力的模型：这一块是「选生图模型」，
 *      不是模型浏览器（用户 2026-10-31：不要把所有供应商的所有模型都摊出来）。
 *
 * 版式走 {@link ../blocks/shared.tsx} 的统一外壳：标题行带当前生效胶囊、
 * 说明默认折叠，下拉并排在同一填充面里各带小标签。
 *
 * 数据通道：`GET /api/model-capabilities/snapshot` +
 * `POST /api/model-capabilities/active`、`POST /api/model-capabilities/settings`
 * ——settings 命名空间 `model-capabilities`，也就是 `generate_image` 工具真正读的
 * 那一份。旧实现写工作区 model-router.json 的 `imageActive`，工具读不到，选了
 * 下拉也照样报「尚未选择生图模型」。
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { BlockShell, FILL_PANEL, SelectField, StateHint } from '../blocks/shared.tsx'

interface ModelInfo { id: string; name: string; image?: boolean }
interface ProviderInfo { provider: string; displayName: string; models: ModelInfo[] }

type ImageSource = 'provider' | 'mcp'

const BASE = '/api/model-capabilities'

const DESCRIPTION = '生图/生视频工具只有一套生效：选「供应商」用内置 generate_image（模型在下方选）；选「MCP」用 magpie-image 连接器提供的工具。切换后下一步请求即生效，另一套工具会被撤掉，模型不会两边都调。'

/** 该模型是否声明了生图能力。 */
function isCapable(m: ModelInfo): boolean {
  return m.image === true
}

export function ImageModelBlock(): ReactNode {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [active, setActive] = useState('')
  const [source, setSource] = useState<ImageSource>('provider')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [sourceSaving, setSourceSaving] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState('')

  useEffect(() => {
    let alive = true
    fetch(`${BASE}/snapshot`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: any) => {
        if (!alive) return
        if (d && d.ok !== false) {
          setProviders(Array.isArray(d.providers)
            ? d.providers
              .map((p: any) => ({
                provider: typeof p?.provider === 'string' ? p.provider : '',
                displayName: typeof p?.displayName === 'string' && p.displayName !== '' ? p.displayName : String(p?.provider ?? ''),
                models: Array.isArray(p?.models) ? p.models.filter((m: any) => m && typeof m.id === 'string') : [],
              }))
              .filter((p: ProviderInfo) => p.provider !== '')
            : [])
          setActive(typeof d.imageActive === 'string' ? d.imageActive : '')
          setSource(d.imageSource === 'mcp' ? 'mcp' : 'provider')
        } else {
          setError((d && d.error) || '加载失败')
        }
        setLoaded(true)
      })
      .catch(() => { if (alive) { setError('接口不可用'); setLoaded(true) } })
    return () => { alive = false }
  }, [])

  // 只留「至少有一个生图模型」的供应商，模型也只留生图模型。
  const capableProviders = providers
    .map(p => ({ ...p, models: p.models.filter(isCapable) }))
    .filter(p => p.models.length > 0)

  const slash = active.indexOf('/')
  const activeProvider = slash > 0 ? active.slice(0, slash) : ''
  const activeModel = slash > 0 ? active.slice(slash + 1) : ''

  const currentProvider = selectedProvider || activeProvider || capableProviders[0]?.provider || ''
  const currentModels = capableProviders.find(p => p.provider === currentProvider)?.models ?? []
  const modelValue = currentProvider === activeProvider ? activeModel : ''

  const pick = (key: string): void => {
    if (saving) return
    setSaving(true)
    setError(null)
    fetch(`${BASE}/active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'image', key }),
    })
      .then((r) => r.json())
      .then((d: any) => {
        // 失败必须说话：静默忽略会让下拉停在旧值，用户以为已切换。
        if (d && d.ok) setActive(key)
        else setError((d && (d.error ?? d.message)) || '保存失败')
      })
      .catch(() => setError('保存请求失败'))
      .finally(() => setSaving(false))
  }

  const pickSource = (value: string): void => {
    if (sourceSaving) return
    const next: ImageSource = value === 'mcp' ? 'mcp' : 'provider'
    if (next === source) return
    setSourceSaving(true)
    setError(null)
    fetch(`${BASE}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageSource: next }),
    })
      .then((r) => r.json())
      .then((d: any) => {
        if (d && d.ok) setSource(next)
        else setError((d && (d.error ?? d.message)) || '保存失败')
      })
      .catch(() => setError('保存请求失败'))
      .finally(() => setSourceSaving(false))
  }

  return (
    <BlockShell title="生图模型" activeText={source === 'mcp' ? 'MCP · magpie-image' : active} description={DESCRIPTION}>
      {error !== null ? <StateHint text={error} tone="error" /> : null}
      {!loaded
        ? <StateHint text="加载中…" />
        : (
          <div className="phub-fill" style={FILL_PANEL}>
            <SelectField label="生图来源" value={source} disabled={sourceSaving} onChange={pickSource}>
              <option value="provider">供应商 · 内置 generate_image</option>
              <option value="mcp">MCP · magpie-image</option>
            </SelectField>
            {source === 'provider'
              ? (capableProviders.length === 0
                  ? <StateHint text="还没有模型声明「生图」能力：到供应商的模型设置里给模型勾上「生图」，或者把上面切到 MCP。" />
                  : (
                    <>
                      <SelectField label="供应商" value={currentProvider} onChange={setSelectedProvider}>
                        {capableProviders.map(p => <option key={p.provider} value={p.provider}>{p.displayName || p.provider}</option>)}
                      </SelectField>
                      <SelectField
                        label="模型"
                        value={modelValue}
                        disabled={saving || currentModels.length === 0}
                        onChange={(v) => { if (v !== '') pick(`${currentProvider}/${v}`) }}
                      >
                        <option value="">{currentModels.length === 0 ? '无可用模型' : '选择模型'}</option>
                        {currentModels.map(m => (
                          <option key={m.id} value={m.id}>{m.name || m.id}</option>
                        ))}
                      </SelectField>
                    </>
                  ))
              : <StateHint text="生图/生视频走 magpie-image MCP（mcp__magpie-image__*），由「操作间 → 连接器」里的 magpie-image 条目提供。关掉或卸载那个条目后会没有生图工具。" />}
          </div>
        )}
    </BlockShell>
  )
}
