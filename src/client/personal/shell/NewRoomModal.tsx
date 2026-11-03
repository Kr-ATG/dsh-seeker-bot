/**
 * Personal Agent — 新建群聊弹窗。
 *
 * 从左侧栏「+」菜单进入。名称可选（留空默认「新群聊」），成员默认勾选
 * 主 Bot 和前三个子 Bot；成员列表带角色说明，支持全选 / 清空。
 * 创建成功后立刻跳到新群聊。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { randomBotAppearance } from '../engine.ts'
import { IconCheck, IconUsers, IconX } from '../icons.tsx'
import { AvatarPicker } from '../shared/AvatarPicker.tsx'
import { usePersonal } from '../store.tsx'
import type { Avatar } from '../types.ts'

export function NewRoomModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { state, actions } = usePersonal()
  const [name, setName] = useState('')
  /** 群聊头像：随机外观起步，可换预设或本地图片；不选就用成员头像叠加。 */
  const [avatar, setAvatar] = useState<Avatar>(() => randomBotAppearance())
  const [members, setMembers] = useState<string[]>([])

  const bots = state.bots
  const mainBot = useMemo(() => bots.find((bot) => bot.isMain) ?? bots[0], [bots])
  const allIds = useMemo(() => bots.map((bot) => bot.id), [bots])

  /*
   * 退场状态：关闭时先播 240ms（遮罩淡出 + 卡片下滑缩小），再调用父级 onClose
   * 真正卸载。直接 onClose() 会让弹窗硬消失，和入场那 200ms 的弹出不对称。
   * 时长 / 曲线与 src/client/modal-animation.ts 的 MODAL_ANIM_MS 一致。
   */
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  /*
   * onClose 是父级内联函数，每次父级渲染都会换引用。放进 ref 之后
   * requestClose 保持稳定，Esc 监听不必每次渲染都摘挂一遍。
   */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  /** 关闭：先播退场，240ms 后再真正卸载。 */
  const requestClose = useCallback((): void => {
    if (closeTimerRef.current !== null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setClosing(false)
      onCloseRef.current()
    }, 240)
  }, [])

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  /* Esc 关闭：与关闭按钮、点遮罩走同一个退场。 */
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, requestClose])

  /* 每次打开都回到干净状态：默认选主 Bot + 前三个子 Bot。 */
  useEffect(() => {
    if (!open) return
    setName('')
    setAvatar(randomBotAppearance())
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
    actions.createRoom(name.trim() || '新群聊', members, avatar)
    // 创建成功也走退场：弹窗滑出时新群聊已经在背后就位。
    requestClose()
    actions.toast('群聊已创建')
  }

  return (
    <div
      className="pa-overlay pa-overlay--fixed"
      data-closing={closing ? '1' : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
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
          <button className="pa-modal__close" type="button" onClick={requestClose} aria-label="关闭">
            <IconX size={16} />
          </button>
        </div>

        <div className="pa-create-body">
          <div className="pa-form-row">
            <label className="pa-label">群聊头像</label>
            <AvatarPicker value={avatar} onChange={setAvatar} />
          </div>

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
            <button className="pa-btn pa-btn--ghost" type="button" onClick={requestClose}>取消</button>
            <button className="pa-btn pa-btn--primary" type="button" onClick={submit} disabled={members.length === 0}>
              <IconUsers size={13} />创建群聊
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
