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

/**
 * 选项清单。
 *
 * 每项是一个虚线圆角框，选中转实线描边并亮出右侧的勾。左侧不再有 radio 圆点：
 * 单选是「点一下即提交」、卡片当场变只读，那个圆点根本没有机会表达「还没提交的
 * 中间态」，只是把视线往左拽、把选项文字挤窄。
 *
 * `trailing` 是列表末尾的自定义输入入口。它必须和选项排在同一个容器里：
 * 挂到列表外面就会吃到卡片的 12px 间距，看起来像另一组东西，而不是「最后一个选项」。
 */
function optionRows(
  options: UiOption[],
  selected: string[],
  disabled: boolean,
  onPick: (id: string) => void,
  trailing?: JSX.Element,
): JSX.Element {
  return (
    <div className="pa-int__options">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="pa-int__opt"
          data-selected={selected.includes(option.id) ? 'true' : 'false'}
          disabled={disabled}
          onClick={() => onPick(option.id)}
        >
          <span className="pa-int__opt-body">
            <span className="pa-int__opt-label">{option.label}</span>
            {option.description !== undefined ? <span className="pa-int__opt-desc">{option.description}</span> : null}
          </span>
          <span className="pa-int__tick" aria-hidden="true" />
        </button>
      ))}
      {trailing ?? null}
    </div>
  )
}

/**
 * 已提交后的选项清单。
 *
 * 为什么不是整卡收成一个小绿框：用户点完最想知道「我刚才选的是哪个」，而选项本来
 * 就在眼前——把它撤掉等于逼人再读一遍结果文字。选中项亮勾、其余压暗，一眼就对得上
 * （参考形态也是这个：卡片留在原地，只是不能再点）。
 *
 * `chosen` 是回传的结果文本：单选是选项文案，多选是顿号 / 逗号连起来的一串；自定义
 * 输入则是一段不在选项里的自由文本——那种情况下没有一项会亮勾，靠下方结果行说明。
 */
function submittedRows(options: UiOption[], chosen: string): JSX.Element {
  const picked = new Set(
    chosen.split(/[、,，]/).map((item) => item.trim()).filter((item) => item !== ''),
  )
  return (
    <div className="pa-int__options">
      {options.map((option) => {
        const on = picked.has(option.label) || picked.has(option.id)
        return (
          <div
            key={option.id}
            className="pa-int__opt"
            data-selected={on ? 'true' : 'false'}
            data-locked="true"
          >
            <span className="pa-int__opt-body">
              <span className="pa-int__opt-label">{option.label}</span>
              {option.description !== undefined ? <span className="pa-int__opt-desc">{option.description}</span> : null}
            </span>
            <span className="pa-int__tick" aria-hidden="true" />
          </div>
        )
      })}
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

/**
 * 审批卡的选项补全：确保有「以后都允许」。
 *
 * host 的 `buildApprovalMessage` 默认不出这个按钮（它怕前端把非 allow 的按钮值
 * 一律映射成 deny，那样点「以后都允许」等于拒绝）。前端现在已改成按 option.id
 * 原样回传，这个按钮可以安全地出现。
 *
 * 为什么在渲染层补而不是改 host 调用处：host 侧的改动正在并行进行，渲染层补全是
 * 幂等的——host 将来自己带上 allow-always 时，这里检测到已存在就不再重复加。
 *
 * 位置：插在「拒绝」之前。允许类动作排在一起、危险动作放最后，减少误点。
 */
function withAllowAlways(message: Message, options: UiOption[]): UiOption[] {
  if (message.kind !== 'approval') return options
  if (options.some((option) => option.id === 'allow-always')) return options
  const extra: UiOption = { id: 'allow-always', label: '以后都允许' }
  const denyIndex = options.findIndex((option) => option.id === 'deny')
  if (denyIndex < 0) return [...options, extra]
  return [...options.slice(0, denyIndex), extra, ...options.slice(denyIndex)]
}

export function InteractiveCard({ message, block }: InteractiveCardProps): JSX.Element {
  const { actions } = usePersonal()
  const ui = block.ui
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const [locked, setLocked] = useState(false)
  /** 自定义输入框是否已展开（收起态显示的是「其他（自己输入）」那张虚线框）。 */
  const [customOpen, setCustomOpen] = useState(false)
  /** 多选时这段自定义文字是否已经算作一项（决定收起后那张框要不要带勾）。 */
  const [customDone, setCustomDone] = useState(false)

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
    // 用户填了自定义、却没点那次「发送」就直接确认时，这段文字仍然要算进去——
    // 否则它只活在输入框里，用户以为自己答了两件事，实际只提交了勾选的那些。
    if (custom.trim() !== '') values.push(custom.trim())
    if (values.length === 0) return
    setLocked(true)
    actions.answerInteractive(message.id, values)
  }

  /**
   * 收起自定义输入。
   *
   * 清空后收起要连「已填」标记一起撤掉：否则多选列表末尾会留一张空白卡片，
   * 看起来像渲染坏了。
   */
  const closeCustom = (): void => {
    if (custom.trim() === '') setCustomDone(false)
    setCustomOpen(false)
  }

  /**
   * 提交自定义输入。
   *
   * 单选：输入完就是最终答案，直接提交——和点选项走同一条语义，不再多要一次确认。
   * 多选：只把这段文字记成「已填的一项」并收起输入框，等用户点「确认选择」统一提交。
   *       多选本来就要确认一次，这里抢先提交会让用户来不及再勾别的。
   */
  const commitCustom = (): void => {
    const text = custom.trim()
    if (submitted || text === '') return
    if (multi) {
      setCustomDone(true)
      setCustomOpen(false)
      return
    }
    setLocked(true)
    actions.answerInteractive(message.id, text)
  }

  const title = ui.title

  if (submitted) {
    /*
     * options 形态保留清单（选中项亮勾、其余压暗），buttons 仍是整卡收成一行结果。
     *
     * 分开的理由：选项是「从这几项里挑一个」，用户回看时要能对上自己挑了哪个；
     * 而按钮（审批 / 确认）表达的是「办完了」，把按钮再摆一遍反而像还能反悔。
     */
    return (
      <div className="pa-int pa-int--done">
        {title !== undefined && title !== '' ? <div className="pa-int__title">{title}</div> : null}
        {block.prompt !== undefined && block.prompt !== '' ? <div className="pa-int__prompt">{block.prompt}</div> : null}
        {ui.kind === 'options' ? submittedRows(ui.options, block.result ?? '') : null}
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
          {withAllowAlways(message, ui.options).map((option) => (
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

  /*
   * 自定义输入入口：allowCustom 时接在选项末尾，点开在原地换成输入框 + 发送。
   *
   * 收起态也要把已填的文字显示出来（而不是永远写着「其他（自己输入）」）：
   * 多选时它是一项已经填好的答案，用户得能看见自己填了什么、能不能改。
   */
  const customSlot: JSX.Element | undefined =
    ui.allowCustom !== true ? undefined : customOpen ? (
      <div className="pa-int__custom">
        <input
          className="pa-int__custom-input"
          type="text"
          placeholder="其他想法，直接输入…"
          value={custom}
          autoFocus
          onChange={(event) => setCustom(event.target.value)}
          onBlur={() => {
            // 误点展开、又什么都没填时，点到别处就收回去；填了东西则留着，别让半句话凭空消失
            if (custom.trim() === '') closeCustom()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitCustom()
            } else if (event.key === 'Escape') {
              closeCustom()
            }
          }}
        />
        <button className="pa-int__button" type="button" disabled={custom.trim() === ''} onClick={commitCustom}>
          发送
        </button>
      </div>
    ) : (
      <button
        type="button"
        className="pa-int__opt pa-int__opt--custom"
        data-selected={customDone ? 'true' : 'false'}
        onClick={() => setCustomOpen(true)}
      >
        <span className="pa-int__opt-body">
          <span className="pa-int__opt-label">{custom.trim() === '' ? '其他（自己输入）' : custom}</span>
        </span>
        <span className="pa-int__tick" aria-hidden="true" />
      </button>
    )

  return (
    <div className="pa-int">
      {title !== undefined && title !== '' ? <div className="pa-int__title">{title}</div> : null}
      {block.prompt !== undefined && block.prompt !== '' ? <div className="pa-int__prompt">{block.prompt}</div> : null}
      {optionRows(ui.options, selected, false, pick, customSlot)}
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
