/**
 * Personal Agent — 群聊设置弹窗。
 *
 * 模型策略：跟随各自 Bot / 全组统一（统一时可填写 provider 与 model）。
 * 成员：chips 可移除，也可以从其余 Bot 里添加。
 * 保存后调用 actions.updateRoom 并关闭弹窗。
 */
import { useEffect, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { IconPlus, IconX } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { MODEL_FALLBACK, type Bot } from '../types.ts'

export function GroupSettings(): JSX.Element | null {
  const { state, ui, actions } = usePersonal()
  const room = ui.groupSettingsOpen !== null
    ? state.rooms.find((item) => item.id === ui.groupSettingsOpen) ?? null
    : null

  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [mode, setMode] = useState<'inherit' | 'unified'>('inherit')
  const [provider, setProvider] = useState(MODEL_FALLBACK.provider)
  const [modelValue, setModelValue] = useState(MODEL_FALLBACK.model)
  const [addOpen, setAddOpen] = useState(false)

  /* 打开时从当前群聊回填表单。 */
  useEffect(() => {
    if (room === null) return
    setName(room.name)
    setMembers(room.memberIds)
    setMode(room.modelMode)
    setProvider(room.unifiedModel?.provider ?? MODEL_FALLBACK.provider)
    setModelValue(room.unifiedModel?.model ?? MODEL_FALLBACK.model)
    setAddOpen(false)
  }, [ui.groupSettingsOpen, room?.id])

  if (room === null) return null

  const memberBots = members
    .map((id) => state.bots.find((bot) => bot.id === id))
    .filter((bot): bot is Bot => bot !== undefined)
  const candidates = state.bots.filter((bot) => !members.includes(bot.id))

  const addMember = (id: string): void => {
    setMembers((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setAddOpen(false)
  }

  const removeMember = (id: string): void => {
    setMembers((prev) => prev.filter((memberId) => memberId !== id))
  }

  const save = (): void => {
    if (room === null || members.length === 0) return
    actions.updateRoom(room.id, {
      name: name.trim() || room.name,
      memberIds: members,
      modelMode: mode,
      ...(mode === 'unified'
        ? {
            unifiedModel: {
              provider: provider.trim() || MODEL_FALLBACK.provider,
              model: modelValue.trim() || MODEL_FALLBACK.model,
              effort: MODEL_FALLBACK.effort,
            },
          }
        : {}),
    })
    actions.toast('群聊设置已保存')
    actions.openGroupSettings(null)
  }

  return (
    <div
      className="pa-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) actions.openGroupSettings(null)
      }}
    >
      <div className="pa-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pa-modal__head">
          <div className="pa-modal__title">群聊设置</div>
          <button
            className="pa-modal__close"
            type="button"
            onClick={() => actions.openGroupSettings(null)}
            aria-label="关闭"
          >
            <IconX size={16} />
          </button>
        </div>
        <div className="pa-modal__body">
          <div className="pa-form-row">
            <label className="pa-label">群聊名称</label>
            <input
              className="pa-field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="群聊名称"
            />
          </div>

          <div className="pa-group-sec">
            <div className="pa-group-sec__title">模型策略</div>
            <label className="pa-radio" data-checked={mode === 'inherit' ? 'true' : 'false'}>
              <input
                type="radio"
                name="pa-group-model"
                checked={mode === 'inherit'}
                onChange={() => setMode('inherit')}
              />
              <span className="pa-radio__main">
                <b>跟随各自 Bot</b>
                <span>每个成员继续使用自己的模型设置</span>
              </span>
            </label>
            <label className="pa-radio" data-checked={mode === 'unified' ? 'true' : 'false'}>
              <input
                type="radio"
                name="pa-group-model"
                checked={mode === 'unified'}
                onChange={() => setMode('unified')}
              />
              <span className="pa-radio__main">
                <b>全组统一</b>
                <span>群内所有 Bot 使用同一个 provider 与模型</span>
              </span>
            </label>
            {mode === 'unified' ? (
              <>
                <div className="pa-form-row" style={{ marginTop: '10px' }}>
                  <label className="pa-label">Provider</label>
                  <input
                    className="pa-field"
                    value={provider}
                    onChange={(event) => setProvider(event.target.value)}
                    placeholder="例如：alymagpie"
                  />
                </div>
                <div className="pa-form-row">
                  <label className="pa-label">Model</label>
                  <input
                    className="pa-field"
                    value={modelValue}
                    onChange={(event) => setModelValue(event.target.value)}
                    placeholder="例如：auto/deepseek-v4.1-flash"
                  />
                </div>
              </>
            ) : null}
          </div>

          <div className="pa-group-sec">
            <div className="pa-group-sec__title">成员（{members.length}）</div>
            <div className="pa-member-chips">
              {memberBots.map((bot) => (
                <span className="pa-member-chip" key={bot.id}>
                  <BotAvatar avatar={bot.avatar} size={22} />
                  <span>{bot.name}</span>
                  <button type="button" title="移除成员" aria-label="移除成员" onClick={() => removeMember(bot.id)}>
                    <IconX size={11} />
                  </button>
                </span>
              ))}
              {candidates.length > 0 ? (
                <button className="pa-member-add" type="button" onClick={() => setAddOpen((prev) => !prev)}>
                  <IconPlus size={11} />添加成员
                </button>
              ) : null}
            </div>
            {addOpen ? (
              <div className="pa-add-member-list">
                {candidates.map((bot) => (
                  <button
                    key={bot.id}
                    className="pa-add-member-item"
                    type="button"
                    onClick={() => addMember(bot.id)}
                  >
                    <BotAvatar avatar={bot.avatar} size={22} />
                    <span>{bot.name}</span>
                    <small>{bot.role}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="pa-modal__foot">
          <button className="pa-btn pa-btn--ghost" type="button" onClick={() => actions.openGroupSettings(null)}>取消</button>
          <button className="pa-btn pa-btn--primary" type="button" disabled={members.length === 0} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
