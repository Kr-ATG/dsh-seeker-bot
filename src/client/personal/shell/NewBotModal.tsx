/**
 * Personal Agent — 新建 Bot 弹窗。
 *
 * 从左侧栏「+」菜单进入。名字可选；角色 / 简介既能直接输入，也能点四个
 * 随机建议卡片一键填入。「换一批」重新抽取四个建议；发送后由
 * store.createBot 负责创建并让新 Bot 主动发第一条消息。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconBot, IconRefresh, IconSparkles, IconX } from '../icons.tsx'
import { NEW_BOT_SUGGESTIONS, randomBotAppearance } from '../engine.ts'
import { AvatarPicker } from '../shared/AvatarPicker.tsx'
import { PaSelect, type PaSelectOption } from '../shared/PaSelect.tsx'
import { useLiveVendors, usePersonal } from '../store.tsx'
import { liveVendorOptions, type Avatar } from '../types.ts'
import { REALTIME_VOICES } from '../../../shared/realtime-protocol.ts'

type Suggestion = (typeof NEW_BOT_SUGGESTIONS)[number]

/** 音色选项（自绘下拉用）：空串 = 不设、跟随全局默认。 */
const VOICE_OPTIONS: PaSelectOption[] = [
  { value: '', label: '跟随全局默认' },
  ...REALTIME_VOICES.map((item) => ({ value: item.id, label: item.label, hint: item.hint })),
]

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
  /** 头像：随机外观起步，用户可以在预设里换或从本地导入图片。 */
  const [avatar, setAvatar] = useState<Avatar>(() => randomBotAppearance())
  const [draft, setDraft] = useState('')
  /** 通话音色 id；空串 = 跟随全局默认（不落 Bot 字段）。 */
  const [voice, setVoice] = useState('')
  /** 通话用的 Live 供应商 id；空串 = 跟随全局默认（不落 Bot 字段）。 */
  const [liveVendor, setLiveVendor] = useState('')
  const [picked, setPicked] = useState<Suggestion | null>(null)
  const [chips, setChips] = useState<Suggestion[]>(() => pickFour())
  const [busy, setBusy] = useState(false)
  /*
   * Live 供应商下拉：弹层打开时现拉一次宿主配置（`GET /realtime/config`）。
   * 读不到就置灰并给一行原因——不能挡住创建 Bot 的其它字段。
   */
  const liveVendors = useLiveVendors(ui.newBotOpen)
  const liveVendorChoices = useMemo(
    () => liveVendorOptions(liveVendors.vendors, liveVendor, liveVendors.defaultVendor),
    [liveVendors.vendors, liveVendors.defaultVendor, liveVendor],
  )

  /*
   * 退场状态：ui.newBotOpen 变 false 时先播 240ms 退场，再从 DOM 摘掉。
   *
   * 关闭入口不止「关闭 / 取消」：创建成功后 store 会自己把 newBotOpen 置 false
   * （store.tsx 的 createBot），所以不能只在一个 requestClose 里挂定时器——
   * 这里统一监听 open 变 false，任何路径都能播完退场再卸载。
   */
  const [rendered, setRendered] = useState(ui.newBotOpen)
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  const renderedRef = useRef(ui.newBotOpen)

  useEffect(() => {
    if (ui.newBotOpen) {
      // 打开（含退场途中重新打开）：撤销退场，立刻可见。
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      renderedRef.current = true
      setClosing(false)
      setRendered(true)
      return
    }
    if (!renderedRef.current) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      renderedRef.current = false
      setClosing(false)
      setRendered(false)
    }, 240)
  }, [ui.newBotOpen])

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  const close = useCallback((): void => {
    if (busy) return
    actions.openNewBot(false)
  }, [busy, actions])

  /* Esc 关闭：与关闭按钮、点遮罩走同一个退场。 */
  useEffect(() => {
    if (!ui.newBotOpen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      // 被内层控件（如 PaSelect 的下拉）先处理过的 Esc 不再重复响应。
      if (event.key !== 'Escape' || event.defaultPrevented) return
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [ui.newBotOpen, close])

  /* 每次打开都回到干净状态。 */
  useEffect(() => {
    if (!ui.newBotOpen) return
    setName('')
    setAvatar(randomBotAppearance())
    setDraft('')
    setVoice('')
    setLiveVendor('')
    setPicked(null)
    setChips(pickFour())
    setBusy(false)
  }, [ui.newBotOpen])

  /*
   * 打开的首帧直接用 ui.newBotOpen 兜住：rendered 要等 effect 才置 true，
   * 只看 rendered 会让点击「新建 Bot」后先空一帧。关闭时 open 已为 false，
   * rendered 仍为 true，所以退场期间照常渲染。
   */
  if (!rendered && !ui.newBotOpen) return null

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await actions.createBot({
        name: name.trim() === '' ? undefined : name.trim(),
        avatar,
        role: picked !== null ? picked.role : (draft.trim() === '' ? undefined : draft.trim()),
        description: picked !== null ? picked.description : undefined,
        // 空串 = 跟随全局默认，createBot 里不会落这个字段
        voice: voice === '' ? undefined : voice,
        liveVendor: liveVendor === '' ? undefined : liveVendor,
      })
    } catch (error) {
      actions.toast(error instanceof Error ? error.message : '创建 Bot 失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="pa-overlay"
      data-closing={closing ? '1' : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="pa-modal pa-create-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pa-create-head">
          <span className="pa-create-head__icon pa-create-head__icon--bot">
            <IconBot size={22} />
          </span>
          <div className="pa-create-head__text">
            <div className="pa-create-head__title">新建 Bot</div>
            <p className="pa-create-head__sub">为主助手增加一个专职子助手，创建成功后会立刻发来第一条消息。</p>
          </div>
          <button className="pa-modal__close" type="button" onClick={close} aria-label="关闭">
            <IconX size={16} />
          </button>
        </div>

        <div className="pa-create-body">
          <div className="pa-create-sec">
            <div className="pa-create-sec__head"><span>基本信息</span></div>
            <div className="pa-form-row">
              <label className="pa-label">头像</label>
              <AvatarPicker value={avatar} onChange={setAvatar} />
            </div>
            <div className="pa-form-row">
              <label className="pa-label" htmlFor="pa-new-bot-name">名字 <em>可选</em></label>
              <input
                id="pa-new-bot-name"
                className="pa-field"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：调研助手"
                autoFocus
              />
            </div>
            <div className="pa-form-row">
              <label className="pa-label" htmlFor="pa-new-bot-role">角色或简介</label>
              <textarea
                id="pa-new-bot-role"
                className="pa-field"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setPicked(null)
                }}
                placeholder="描述它擅长什么、怎么跟你配合…"
              />
            </div>
          </div>

          <div className="pa-create-sec">
            <div className="pa-create-sec__head">
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

          <div className="pa-create-sec">
            <div className="pa-create-sec__head"><span>通话设置 <em>可选</em></span></div>
            <div className="pa-form-grid">
              <div className="pa-form-row">
                <label className="pa-label">通话音色</label>
                <PaSelect
                  className="pa-select--form"
                  value={voice}
                  options={VOICE_OPTIONS}
                  onChange={setVoice}
                  ariaLabel="通话音色"
                />
                <p className="pa-form-hint">
                  {REALTIME_VOICES.find((item) => item.id === voice)?.hint
                    ?? '不选就跟随设置里的全局默认'}
                </p>
              </div>
              <div className="pa-form-row">
                <label className="pa-label">通话供应商</label>
                <PaSelect
                  className="pa-select--form"
                  value={liveVendor}
                  options={liveVendorChoices}
                  disabled={liveVendors.vendors === null || liveVendors.vendors.length === 0}
                  onChange={setLiveVendor}
                  ariaLabel="通话供应商"
                />
                <p className={liveVendors.error === null ? 'pa-form-hint' : 'pa-form-hint pa-form-hint--warn'}>
                  {liveVendors.error !== null
                    ? `读不到 Live 供应商列表（${liveVendors.error}），先跟随全局默认`
                    : liveVendors.loading || liveVendors.vendors === null
                      ? '正在读取供应商列表…'
                      : '不选就跟随设置里的全局默认'}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="pa-create-foot">
          <p className="pa-create-foot__hint">创建后可在右侧详情里继续调整</p>
          <div className="pa-create-foot__actions">
            <button className="pa-btn pa-btn--ghost" type="button" onClick={close} disabled={busy}>取消</button>
            <button className="pa-btn pa-btn--primary" type="button" onClick={() => { void submit() }} disabled={busy}>
              {busy ? <><i className="pa-spinner" />创建中…</> : <><IconSparkles size={13} />创建 Bot</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
