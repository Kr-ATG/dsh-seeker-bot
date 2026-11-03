/**
 * Personal Agent — 模型两级选择器（供应商 → 模型）。
 *
 * 设置卡里原来的原生 `<select>` + `<optgroup>` 选项弹层由浏览器自己画，CSS 碰不到，
 * 跟这套自绘面板的观感对不上（见 shared/PaSelect.tsx 文件头）。这里用两个 PaSelect
 * 拼出「先供应商、后模型」的两级选择：供应商在前、模型在后，同一行横向排列，
 * 窄屏（设置卡宽度不足）自动换成上下两行。
 *
 * 兜底规则：当前 provider / model 可能已经不在宿主返回的列表里（供应商被删、模型
 * 下线，或接口暂时失败）。这时仍然要把当前值补成一个选项显示出来——否则 PaSelect
 * 找不到 value 会显示占位文案，用户会误以为选择丢了。
 *
 * 供应商切换：当前模型仍属于新供应商时保留模型；否则自动选新供应商的第一款模型。
 * 两种结果都只触发一次 onChange（父组件可能据此写库，不能先清空再设置）。
 */
import { useMemo } from 'react'
import { PaSelect, type PaSelectOption } from './PaSelect.tsx'

/** 模型公布的一档推理强度（与宿主 `/api/personal-agent/models` 的 reasoningEfforts 对齐）。 */
export interface ModelPickerEffort {
  id: string
  name: string
}

export interface ModelPickerModel {
  id: string
  name: string
  /** 模型公布的可选推理档位；Bot 设置用它决定换模型时是否保留 effort。 */
  reasoningEfforts?: ModelPickerEffort[]
  /** 模型自己的默认档位 id（保持与宿主接口字段一致）。 */
  defaultEffort?: string
}

/** 宿主按供应商分组返回的一组模型。 */
export interface ModelPickerGroup {
  provider: string
  name: string
  models: ModelPickerModel[]
}

export interface ModelPickerValue {
  provider: string
  model: string
}

export interface ModelPickerProps {
  groups: readonly ModelPickerGroup[]
  value: ModelPickerValue
  onChange: (next: ModelPickerValue) => void
  disabled?: boolean
  /** 加到根元素上的类名（设置卡一般不需要，留作排版扩展）。 */
  className?: string
}

export function ModelPicker(props: ModelPickerProps): JSX.Element {
  const { groups, value, onChange, disabled = false, className } = props

  const providerOptions = useMemo<PaSelectOption[]>(() => {
    const options: PaSelectOption[] = groups.map((group) => ({ value: group.provider, label: group.name }))
    if (value.provider !== '' && !groups.some((group) => group.provider === value.provider)) {
      options.push({ value: value.provider, label: `${value.provider}（当前）` })
    }
    return options
  }, [groups, value.provider])

  const currentGroup = groups.find((group) => group.provider === value.provider)
  const modelOptions = useMemo<PaSelectOption[]>(() => {
    const models = currentGroup?.models ?? []
    const options: PaSelectOption[] = models.map((model) => ({ value: model.id, label: model.name }))
    if (value.model !== '' && !models.some((model) => model.id === value.model)) {
      options.push({ value: value.model, label: `${value.model}（当前）` })
    }
    return options
  }, [currentGroup, value.model])

  const handleProviderChange = (nextProvider: string): void => {
    const nextGroup = groups.find((group) => group.provider === nextProvider)
    if (nextGroup === undefined) {
      // 兜底供应商没有模型列表可查，只能保留当前模型；同样只回调一次。
      if (nextProvider !== value.provider) onChange({ provider: nextProvider, model: value.model })
      return
    }
    const keepsModel = nextGroup.models.some((model) => model.id === value.model)
    const nextModel = keepsModel ? value.model : nextGroup.models[0]?.id ?? value.model
    onChange({ provider: nextProvider, model: nextModel })
  }

  const handleModelChange = (nextModel: string): void => {
    onChange({ provider: value.provider, model: nextModel })
  }

  const rootClass = className === undefined || className === ''
    ? 'pa-model-picker'
    : `pa-model-picker ${className}`

  return (
    <div className={rootClass}>
      <div className="pa-model-picker__field">
        <span className="pa-model-picker__label">供应商</span>
        <PaSelect
          className="pa-select--form"
          value={value.provider}
          options={providerOptions}
          onChange={handleProviderChange}
          disabled={disabled}
          placeholder="请选择供应商"
          ariaLabel="供应商"
        />
      </div>
      <div className="pa-model-picker__field">
        <span className="pa-model-picker__label">模型</span>
        <PaSelect
          className="pa-select--form"
          value={value.model}
          options={modelOptions}
          onChange={handleModelChange}
          disabled={disabled || modelOptions.length === 0}
          placeholder="请选择模型"
          ariaLabel="模型"
        />
      </div>
    </div>
  )
}
