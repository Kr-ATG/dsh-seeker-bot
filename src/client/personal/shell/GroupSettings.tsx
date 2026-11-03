/**
 * Personal Agent — 群聊设置卡（右侧滑出）。
 *
 * 与 BotSettingsCard 共用同一套 `pa-sheet` 视觉（遮罩 + 右贴边全高容器，
 * 样式在 settings.css.ts）：群名 / 模型策略 / 成员管理 / 保存，外加一个
 * 「删除群聊」危险区（二次确认用自绘确认条，不弹 window.confirm）。
 *
 * 入口：Sidebar 的群聊行「...」菜单、ChatPanel 的「更多 → 群聊设置」，
 * 都只调用 `actions.openGroupSettings(roomId)`。
 */
import { useEffect, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { IconPlus, IconTrash, IconX } from '../icons.tsx'
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
  /* 删除群聊的二次确认（自绘，不用原生 confirm） */
  const [deleteOpen, setDeleteOpen] = useState(false)

  /* 打开时从当前群聊回填表单。 */
  useEffect(() => {
    if (room === null) return
    setName(room.name)
    setMembers(room.memberIds)
    setMode(room.modelMode)
    setProvider(room.unifiedModel?.provider ?? MODEL_FALLBACK.provider)
    setModelValue(room.unifiedModel?.model ?? MODEL_FALLBACK.model)
    setAddOpen(false)
    setDeleteOpen(false)
  }, [ui.groupSettingsOpen, room?.id])

  /* Esc 关闭；PaSelect / 原生控件处理过 Esc 时跳过。 */
  useEffect(() => {
    if (room === null) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') actions.openGroupSettings(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [room, actions])

  /* 群聊被删除后 ui.groupSettingsOpen 会残留一个不存在的 id：自动清掉。 */
  useEffect(() => {
    if (ui.groupSettingsOpen === null) return
    if (!state.rooms.some((item) => item.id === ui.groupSettingsOpen)) actions.openGroupSettings(null)
  }, [ui.groupSettingsOpen, state.rooms, actions])

  if (room === null) return null

  const close = (): void => actions.openGroupSettings(null)

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
    if (members.length === 0) return
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
    close()
  }

  return (
    <div
      className="pa-sheet-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <aside
        className="pa-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="群聊设置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="pa-sheet__head">
          <div className="pa-sheet__head-text">
            <div className="pa-sheet__title">群聊设置</div>
            <div className="pa-sheet__sub">{room.name} · {members.length} 个 Bot</div>
          </div>
          <button className="pa-sheet__close" type="button" onClick={close} title="关闭" aria-label="关闭群聊设置">
            <IconX size={16} />
          </button>
        </div>

        <div className="pa-sheet__body">
          {/* 群名 */}
          <section className="pa-sheet-sec">
            <div className="pa-sheet-sec__head">
              <span className="pa-sheet-sec__title">群聊名称</span>
            </div>
            <div className="pa-sheet-field-row">
              <input
                className="pa-field"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="群聊名称"
                aria-label="群聊名称"
              />
            </div>
          </section>

          {/* 模型策略 */}
          <section className="pa-sheet-sec">
            <div className="pa-sheet-sec__head">
              <span className="pa-sheet-sec__title">模型策略</span>
            </div>
            <label className="pa-sheet-radio" data-checked={mode === 'inherit' ? 'true' : 'false'}>
              <input
                type="radio"
                name="pa-group-model"
                checked={mode === 'inherit'}
                onChange={() => setMode('inherit')}
              />
              <span className="pa-sheet-radio__main">
                <b>跟随各自 Bot</b>
                <span>每个成员继续使用自己的模型设置</span>
              </span>
            </label>
            <label className="pa-sheet-radio" data-checked={mode === 'unified' ? 'true' : 'false'}>
              <input
                type="radio"
                name="pa-group-model"
                checked={mode === 'unified'}
                onChange={() => setMode('unified')}
              />
              <span className="pa-sheet-radio__main">
                <b>全组统一</b>
                <span>群内所有 Bot 使用同一个 provider 与模型</span>
              </span>
            </label>
            {mode === 'unified' ? (
              <>
                <div className="pa-sheet-field-row" style={{ marginTop: 10 }}>
                  <label className="pa-sheet-label">Provider</label>
                  <input
                    className="pa-field"
                    value={provider}
                    onChange={(event) => setProvider(event.target.value)}
                    placeholder="例如：alymagpie"
                  />
                </div>
                <div className="pa-sheet-field-row">
                  <label className="pa-sheet-label">Model</label>
                  <input
                    className="pa-field"
                    value={modelValue}
                    onChange={(event) => setModelValue(event.target.value)}
                    placeholder="例如：auto/deepseek-v4.1-flash"
                  />
                </div>
              </>
            ) : null}
          </section>

          {/* 成员 */}
          <section className="pa-sheet-sec">
            <div className="pa-sheet-sec__head">
              <span className="pa-sheet-sec__title">成员</span>
              <span className="pa-sheet-sec__extra">{members.length} 个</span>
            </div>
            <div className="pa-sheet-chips">
              {memberBots.map((bot) => (
                <span className="pa-sheet-chip" key={bot.id}>
                  <BotAvatar avatar={bot.avatar} size={22} />
                  <span>{bot.name}</span>
                  <button type="button" title="移除成员" aria-label="移除成员" onClick={() => removeMember(bot.id)}>
                    <IconX size={11} />
                  </button>
                </span>
              ))}
              {candidates.length > 0 ? (
                <button className="pa-sheet-add-member" type="button" onClick={() => setAddOpen((prev) => !prev)}>
                  <IconPlus size={11} />添加成员
                </button>
              ) : null}
            </div>
            {addOpen ? (
              <div className="pa-sheet-member-list">
                {candidates.map((bot) => (
                  <button
                    key={bot.id}
                    className="pa-sheet-member-item"
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
            {members.length === 0 ? (
              <p className="pa-sheet-hint pa-sheet-hint--warn">群聊至少要有一个成员才能保存。</p>
            ) : null}
          </section>

          {/* 危险区：删除群聊 */}
          <section className="pa-sheet-sec">
            <div className="pa-sheet-sec__head">
              <span className="pa-sheet-sec__title">危险操作</span>
            </div>
            <div className="pa-sheet-danger-zone">
              <b>删除群聊</b>
              <p>删除后群聊从侧栏消失，成员 Bot 和各自的私聊不受影响。此操作不可撤销。</p>
              {deleteOpen ? (
                <div className="pa-sheet-danger-confirm">
                  确定删除「{room.name}」？
                  <div className="pa-sheet-danger-confirm__row">
                    <button className="pa-btn pa-btn--ghost pa-btn--sm" type="button" onClick={() => setDeleteOpen(false)}>
                      取消
                    </button>
                    <button
                      className="pa-btn pa-btn--danger pa-btn--sm"
                      type="button"
                      onClick={() => {
                        actions.deleteRoom(room.id)
                        close()
                        actions.toast('群聊已删除')
                      }}
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              ) : (
                <div className="pa-sheet-danger-actions">
                  <button className="pa-btn pa-btn--danger pa-btn--sm" type="button" onClick={() => setDeleteOpen(true)}>
                    <IconTrash size={12} />删除群聊
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="pa-sheet__foot">
          <button className="pa-btn pa-btn--ghost" type="button" onClick={close}>取消</button>
          <button className="pa-btn pa-btn--primary" type="button" disabled={members.length === 0} onClick={save}>
            保存
          </button>
        </div>
      </aside>
    </div>
  )
}
