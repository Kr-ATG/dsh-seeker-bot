/**
 * Personal Agent — 交互卡片（options / buttons / form）。
 *
 * 所有提交都真实回传 store：actions.answerInteractive(message.id, value) 会记录结果、
 * 追加一条用户消息并让 Bot 继续回复。提交后卡片切换为只读的「已提交」状态。
 */
import { useMemo, useState } from 'react'
import { usePersonal } from '../store.tsx'
import { IconCheck, IconCircleCheck } from '../icons.tsx'
import type { Message, MessageBlock, UiField, UiOption } from '../types.ts'

export interface InteractiveCardProps {
  message: Message
  block: Extract<MessageBlock, { type: 'interactive' }>
}

type FormValues = Record<string, string>

function optionRows(
  options: UiOption[],
  selected: string[],
  multi: boolean,
  disabled: boolean,
  onPick: (id: string) => void,
): JSX.Element {
  return (
    <div className="pa-int__options">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="pa-int__opt"
          data-selected={selected.includes(option.id) ? 'true' : 'false'}
          data-multi={multi ? 'true' : 'false'}
          disabled={disabled}
          onClick={() => onPick(option.id)}
        >
          <span className="pa-int__radio" aria-hidden="true" />
          <span className="pa-int__opt-body">
            <span className="pa-int__opt-label">{option.label}</span>
            {option.description !== undefined ? <span className="pa-int__opt-desc">{option.description}</span> : null}
          </span>
        </button>
      ))}
    </div>
  )
}

function fieldValue(field: UiField, values: FormValues): string {
  return values[field.id] ?? (field.type === 'checkbox' ? 'false' : '')
}

function FormCard({ message, block }: InteractiveCardProps): JSX.Element {
  const { actions } = usePersonal()
  const ui = block.ui.kind === 'form' ? block.ui : null
  const fields = useMemo(() => (ui === null ? [] : ui.fields), [ui])
  const [values, setValues] = useState<FormValues>(() => {
    const initial: FormValues = {}
    for (const field of fields) initial[field.id] = field.type === 'checkbox' ? 'false' : ''
    return initial
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [locked, setLocked] = useState(false)

  if (ui === null) return <></>

  const update = (id: string, value: string): void => {
    setValues((prev) => ({ ...prev, [id]: value }))
    setErrors((prev) => {
      if (prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const submit = (): void => {
    if (block.submitted || locked) return
    const missing: Record<string, string> = {}
    for (const field of fields) {
      if (field.required !== true) continue
      const value = fieldValue(field, values)
      if (field.type === 'checkbox' ? value !== 'true' : value.trim() === '') missing[field.id] = '请填写此项'
    }
    if (Object.keys(missing).length > 0) {
      setErrors(missing)
      return
    }
    const record: Record<string, string> = {}
    for (const field of fields) {
      const raw = fieldValue(field, values)
      record[field.id] = field.type === 'checkbox' ? (raw === 'true' ? '是' : '否') : raw.trim()
    }
    setLocked(true)
    actions.answerInteractive(message.id, record)
  }

  if (block.submitted) {
    return (
      <div className="pa-int pa-int--done">
        <div className="pa-int__title">{ui.title}</div>
        {block.prompt !== undefined && block.prompt !== '' ? <div className="pa-int__prompt">{block.prompt}</div> : null}
        <div className="pa-int__done">
          <IconCircleCheck size={16} />
          <div>
            <div className="pa-int__done-label">已提交</div>
            <div className="pa-int__done-text">{block.result ?? '表单已提交'}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pa-int">
      <div className="pa-int__title">{ui.title}</div>
      {block.prompt !== undefined && block.prompt !== '' ? <div className="pa-int__prompt">{block.prompt}</div> : null}
      <div className="pa-int__form">
        {fields.map((field) => (
          <div className="pa-int__field" key={field.id}>
            <label className="pa-int__field-label" htmlFor={`pa-field-${message.id}-${field.id}`}>
              {field.label}
              {field.required === true ? <em>*</em> : null}
            </label>
            {field.type === 'textarea' ? (
              <textarea
                id={`pa-field-${message.id}-${field.id}`}
                className="pa-int__input"
                rows={3}
                placeholder={field.placeholder ?? ''}
                value={fieldValue(field, values)}
                aria-invalid={errors[field.id] !== undefined ? 'true' : 'false'}
                onChange={(event) => update(field.id, event.target.value)}
              />
            ) : field.type === 'select' ? (
              <select
                id={`pa-field-${message.id}-${field.id}`}
                className="pa-int__input"
                value={fieldValue(field, values)}
                aria-invalid={errors[field.id] !== undefined ? 'true' : 'false'}
                onChange={(event) => update(field.id, event.target.value)}
              >
                <option value="">{field.placeholder ?? '请选择'}</option>
                {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : field.type === 'checkbox' ? (
              <label className="pa-int__check">
                <input
                  id={`pa-field-${message.id}-${field.id}`}
                  type="checkbox"
                  checked={fieldValue(field, values) === 'true'}
                  onChange={(event) => update(field.id, event.target.checked ? 'true' : 'false')}
                />
                <span>{field.placeholder ?? '确认此项'}</span>
              </label>
            ) : (
              <input
                id={`pa-field-${message.id}-${field.id}`}
                className="pa-int__input"
                type={field.type === 'time' ? 'time' : 'text'}
                placeholder={field.placeholder ?? ''}
                value={fieldValue(field, values)}
                aria-invalid={errors[field.id] !== undefined ? 'true' : 'false'}
                onChange={(event) => update(field.id, event.target.value)}
              />
            )}
            {errors[field.id] !== undefined ? <span className="pa-int__error">{errors[field.id]}</span> : null}
          </div>
        ))}
      </div>
      <div className="pa-int__foot">
        <button className="pa-int__button" type="button" data-primary="true" disabled={locked} onClick={submit}>
          {ui.submitLabel ?? '提交'}
        </button>
      </div>
    </div>
  )
}

export function InteractiveCard({ message, block }: InteractiveCardProps): JSX.Element {
  const { actions } = usePersonal()
  const ui = block.ui
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const [locked, setLocked] = useState(false)

  if (ui.kind === 'form') return <FormCard message={message} block={block} />

  const submitted = block.submitted === true || locked
  const multi = ui.kind === 'options' && ui.multi === true

  const pick = (id: string): void => {
    if (submitted) return
    if (multi) {
      setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
      return
    }
    setLocked(true)
    setSelected([id])
    actions.answerInteractive(message.id, id)
  }

  const confirmMulti = (): void => {
    if (submitted) return
    const values = [...selected]
    if (custom.trim() !== '') values.push(custom.trim())
    if (values.length === 0) return
    setLocked(true)
    actions.answerInteractive(message.id, values)
  }

  const submitCustom = (): void => {
    if (submitted || custom.trim() === '') return
    setLocked(true)
    actions.answerInteractive(message.id, custom.trim())
  }

  const title = ui.title

  if (submitted) {
    return (
      <div className="pa-int pa-int--done">
        {title !== undefined && title !== '' ? <div className="pa-int__title">{title}</div> : null}
        {block.prompt !== undefined && block.prompt !== '' ? <div className="pa-int__prompt">{block.prompt}</div> : null}
        <div className="pa-int__done">
          <IconCheck size={16} />
          <div>
            <div className="pa-int__done-label">已提交</div>
            <div className="pa-int__done-text">{block.result ?? '已记录你的选择'}</div>
          </div>
        </div>
      </div>
    )
  }

  if (ui.kind === 'buttons') {
    return (
      <div className="pa-int">
        {title !== undefined && title !== '' ? <div className="pa-int__title">{title}</div> : null}
        {block.prompt !== undefined && block.prompt !== '' ? <div className="pa-int__prompt">{block.prompt}</div> : null}
        <div className="pa-int__buttons">
          {ui.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="pa-int__button"
              title={option.description}
              onClick={() => pick(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="pa-int">
      {title !== undefined && title !== '' ? <div className="pa-int__title">{title}</div> : null}
      {block.prompt !== undefined && block.prompt !== '' ? <div className="pa-int__prompt">{block.prompt}</div> : null}
      {optionRows(ui.options, selected, multi, false, pick)}
      {ui.allowCustom === true ? (
        <div className="pa-int__custom">
          <input
            className="pa-int__input"
            type="text"
            placeholder="其他想法，直接输入…"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (multi) confirmMulti()
                else submitCustom()
              }
            }}
          />
          <button
            className="pa-int__button"
            type="button"
            onClick={() => (multi ? confirmMulti() : submitCustom())}
            disabled={custom.trim() === ''}
          >
            发送
          </button>
        </div>
      ) : null}
      {multi ? (
        <div className="pa-int__foot">
          <button
            className="pa-int__button"
            type="button"
            data-primary="true"
            disabled={selected.length === 0 && custom.trim() === ''}
            onClick={confirmMulti}
          >
            确认选择
          </button>
          <span className="pa-int__hint">可多选</span>
        </div>
      ) : null}
    </div>
  )
}
