/**
 * Personal Agent — 新建 Bot 弹窗。
 *
 * 从左侧栏「+」菜单进入。名字可选；角色 / 简介既能直接输入，也能点四个
 * 随机建议卡片一键填入。「换一批」重新抽取四个建议；发送后由
 * store.createBot 负责创建并让新 Bot 主动发第一条消息。
 */
import { useEffect, useMemo, useState } from 'react'
import { IconBot, IconRefresh, IconSparkles, IconX } from '../icons.tsx'
import { NEW_BOT_SUGGESTIONS } from '../engine.ts'
import { PaSelect, type PaSelectOption } from '../shared/PaSelect.tsx'
import { useLiveVendors, usePersonal } from '../store.tsx'
import { liveVendorOptions } from '../types.ts'
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

  /* 每次打开都回到干净状态。 */
  useEffect(() => {
    if (!ui.newBotOpen) return
    setName('')
    setDraft('')
    setVoice('')
    setLiveVendor('')
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
