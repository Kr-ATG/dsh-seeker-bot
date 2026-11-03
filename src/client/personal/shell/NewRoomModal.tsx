/**
 * Personal Agent — 新建群聊弹窗。
 *
 * 从左侧栏「+」菜单进入。名称可选（留空默认「新群聊」），成员默认勾选
 * 主 Bot 和前三个子 Bot；成员列表带角色说明，支持全选 / 清空。
 * 创建成功后立刻跳到新群聊。
 */
import { useEffect, useMemo, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { IconCheck, IconUsers, IconX } from '../icons.tsx'
import { usePersonal } from '../store.tsx'

export function NewRoomModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { state, actions } = usePersonal()
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])

  const bots = state.bots
  const mainBot = useMemo(() => bots.find((bot) => bot.isMain) ?? bots[0], [bots])
  const allIds = useMemo(() => bots.map((bot) => bot.id), [bots])

  /* 每次打开都回到干净状态：默认选主 Bot + 前三个子 Bot。 */
  useEffect(() => {
    if (!open) return
    setName('')
    const defaults = [mainBot?.id, ...bots.filter((bot) => !bot.isMain).slice(0, 3).map((bot) => bot.id)]
    setMembers(defaults.filter((id): id is string => id !== undefined))
  }, [open])

  if (!open) return null

  const toggleMember = (id: string): void => {
    setMembers((prev) => (prev.includes(id) ? prev.filter((memberId) => memberId !== id) : [...prev, id]))
  }

  const submit = (): void => {
    if (members.length === 0) {
      actions.toast('群聊至少需要一个成员')
      return
    }
    // createRoom 已经在同一个批次里把新群聊设为当前会话（含右栏 owner）
    actions.createRoom(name.trim() || '新群聊', members)
    onClose()
    actions.toast('群聊已创建')
  }

  return (
    <div
      className="pa-overlay pa-overlay--fixed"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="pa-modal pa-create-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pa-create-head">
          <span className="pa-create-head__icon pa-create-head__icon--room">
            <IconUsers size={22} />
          </span>
          <div className="pa-create-head__text">
            <div className="pa-create-head__title">新建群聊</div>
            <p className="pa-create-head__sub">选几个 Bot 一起协作。群聊里 @某个成员，可以让它单独回复。</p>
          </div>
          <button className="pa-modal__close" type="button" onClick={onClose} aria-label="关闭">
            <IconX size={16} />
          </button>
        </div>

        <div className="pa-create-body">
          <div className="pa-form-row">
            <label className="pa-label" htmlFor="pa-new-room-name">群聊名称</label>
            <input
              id="pa-new-room-name"
              className="pa-field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：周报小组（留空则为「新群聊」）"
              autoFocus
            />
          </div>

          <div className="pa-create-sec">
            <div className="pa-create-sec__head">
              <span>选择成员</span>
              <span className="pa-create-sec__aside">
                <em>已选 {members.length} / {allIds.length}</em>
                <button
                  className="pa-link-btn"
                  type="button"
                  onClick={() => setMembers(allIds)}
                  disabled={members.length === allIds.length}
                >
                  全选
                </button>
                <button
                  className="pa-link-btn"
                  type="button"
                  onClick={() => setMembers([])}
                  disabled={members.length === 0}
                >
                  清空
                </button>
              </span>
            </div>
            <div className="pa-member-pick">
              {bots.map((bot) => {
                const selected = members.includes(bot.id)
                return (
                  <button
                    key={bot.id}
                    className="pa-member-pick__row"
                    type="button"
                    data-on={selected ? 'true' : 'false'}
                    aria-pressed={selected}
                    onClick={() => toggleMember(bot.id)}
                  >
                    <BotAvatar avatar={bot.avatar} size={28} />
                    <span className="pa-member-pick__main">
                      <b>{bot.name}</b>
                      <small>{bot.isMain ? '主助手 · 总管所有子 Bot' : bot.role}</small>
                    </span>
                    <span className="pa-member-pick__check">
                      {selected ? <IconCheck size={13} /> : null}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className={members.length === 0 ? 'pa-form-hint pa-form-hint--warn' : 'pa-form-hint'}>
              {members.length === 0
                ? '至少选择一个成员才能创建群聊'
                : '群聊里每个成员都会看到彼此的消息；@ 可以点名让某个 Bot 回复。'}
            </p>
          </div>
        </div>

        <div className="pa-create-foot">
          <p className="pa-create-foot__hint">创建后可以在「群设置」里继续添加成员</p>
          <div className="pa-create-foot__actions">
            <button className="pa-btn pa-btn--ghost" type="button" onClick={onClose}>取消</button>
            <button className="pa-btn pa-btn--primary" type="button" onClick={submit} disabled={members.length === 0}>
              <IconUsers size={13} />创建群聊
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
