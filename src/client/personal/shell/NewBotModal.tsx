/**
 * Personal Agent — 新建 Bot 弹窗（520px 深色卡片）。
 *
 * 名字可选；角色 / 简介既可直接输入，也可以点四个随机建议 chip 一键填入。
 * 「换一批」重新抽取四个建议；发送后由 store.createBot 负责创建并让新 Bot
 * 主动发第一条消息。
 */
import { useEffect, useState } from 'react'
import { IconRefresh, IconSend, IconX } from '../icons.tsx'
import { NEW_BOT_SUGGESTIONS } from '../engine.ts'
import { usePersonal } from '../store.tsx'

type Suggestion = (typeof NEW_BOT_SUGGESTIONS)[number]

/** 从建议池里不重复地抽四个。 */
function pickFour(): Suggestion[] {
  const pool = [...NEW_BOT_SUGGESTIONS]
  const out: Suggestion[] = []
  while (out.length < 4 && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length)
    out.push(pool.splice(index, 1)[0])
  }
  return out
}

export function NewBotModal(): JSX.Element | null {
  const { ui, actions } = usePersonal()
  const [name, setName] = useState('')
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState<Suggestion | null>(null)
  const [chips, setChips] = useState<Suggestion[]>(() => pickFour())
  const [busy, setBusy] = useState(false)

  /* 每次打开都回到干净状态。 */
  useEffect(() => {
    if (!ui.newBotOpen) return
    setName('')
    setDraft('')
    setPicked(null)
    setChips(pickFour())
    setBusy(false)
  }, [ui.newBotOpen])

  if (!ui.newBotOpen) return null

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await actions.createBot({
        name: name.trim() === '' ? undefined : name.trim(),
        role: picked !== null ? picked.role : (draft.trim() === '' ? undefined : draft.trim()),
        description: picked !== null ? picked.description : undefined,
      })
    } catch (error) {
      actions.toast(error instanceof Error ? error.message : '创建 Bot 失败')
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    if (busy) return
    actions.openNewBot(false)
  }

  return (
    <div
      className="pa-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="pa-modal pa-newbot" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pa-modal__head">
          <div className="pa-modal__title">新建 Bot</div>
          <button className="pa-modal__close" type="button" onClick={close} aria-label="关闭">
            <IconX size={16} />
          </button>
        </div>
        <div className="pa-modal__body">
          <p className="pa-newbot__lead">给主 Bot 增加一个专职助手，创建成功后会立刻发来第一条消息。</p>

          <div className="pa-form-row">
            <label className="pa-label">名字（可选）</label>
            <input
              className="pa-field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：调研助手"
              autoFocus
            />
          </div>

          <div className="pa-form-row">
            <label className="pa-label">角色或简介</label>
            <textarea
              className="pa-field"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setPicked(null)
              }}
              placeholder="描述它擅长什么、怎么跟你配合…"
            />
          </div>

          <div className="pa-suggest-head">
            <span>快速选择</span>
            <button
              className="pa-suggest-refresh"
              type="button"
              onClick={() => {
                setChips(pickFour())
                setPicked(null)
              }}
            >
              <IconRefresh size={12} />换一批
            </button>
          </div>
          <div className="pa-suggest-grid">
            {chips.map((chip) => (
              <button
                key={chip.role}
                className="pa-suggest-chip"
                type="button"
                data-active={picked?.role === chip.role ? 'true' : 'false'}
                onClick={() => {
                  setPicked(chip)
                  setDraft(`${chip.role}：${chip.description}`)
                }}
              >
                <b>{chip.role}</b>
                <span>{chip.description}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="pa-modal__foot">
          <button className="pa-btn pa-btn--ghost" type="button" onClick={close} disabled={busy}>取消</button>
          <button className="pa-btn pa-btn--primary" type="button" onClick={() => { void submit() }} disabled={busy}>
            {busy ? <><i className="pa-spinner" />创建中…</> : <><IconSend size={13} />发送</>}
          </button>
        </div>
      </div>
    </div>
  )
}
