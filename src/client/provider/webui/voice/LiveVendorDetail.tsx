/**
 * 「模型供应商」页 · 实时语音模式 · 右栏详情。
 *
 * 版式沿用 {@link ChatProviderDetail}（标签在上、控件在下、底部「取消 / 保存」
 * 胶囊按钮那套 `phub-*` 规格）：用户 2026-11-02 原话是「还是沿用左侧供应商与
 * 添加供应商的方式，只不过是里面的内容全部换掉了」——右栏就是「选中项的编辑表单」，
 * 只是字段全换成 Live 供应商的字段（名称 / 上游地址 / 凭据名 / 模型 / API Key /
 * 采样率高级项）。
 *
 * 三种状态：
 * - **新增**（`editing.id === null`）：空表单 + 内置模板快捷键；
 * - **编辑**（`editing.id !== null`）：选中那条的草稿 + 「设为默认 / 删除」；
 * - **未选中**：占位提示（从左侧选一条），下面仍挂「通话默认（全局）」——
 *   音色 / 语速 / 联网是全局设置，不属于任何一条供应商，但用户切到这一页就要能改。
 *
 * 所有状态与请求都在 {@link LiveVendorStore}（voice/store.ts），本组件只做呈现。
 */
import type { CSSProperties, ReactNode } from 'react'
import {
  CAPSULE_BTN,
  FILL_PANEL,
  INPUT_STYLE,
  OFFICIAL_SWITCH,
  OFFICIAL_SWITCH_ON,
  OFFICIAL_SWITCH_THUMB,
  OFFICIAL_SWITCH_THUMB_ON,
  SelectField,
  StateHint,
} from '../blocks/shared.tsx'
import {
  inlineCapGroupStyle,
  inlineCapPillOnStyle,
  inlineCapPillStyle,
} from '../chat/ModelListEditor.tsx'
import { REALTIME_SPEED_LABELS } from '../../../../shared/realtime-protocol.ts'
import {
  LIVE_SAMPLE_RATE_MAX,
  LIVE_SAMPLE_RATE_MIN,
  LIVE_SPEED_ORDER,
  keyRefFromId,
  type LiveVendorStore,
} from './store.ts'

/** {@link LiveVendorDetail} 的 props。 */
export interface LiveVendorDetailProps {
  /** 页面级共享 store（与左栏同一份）。 */
  store: LiveVendorStore
}

/**
 * 渲染右栏：选中项的编辑表单 + 全局通话默认。
 * @param props - 共享 store。
 * @returns 详情面板内容。
 */
export function LiveVendorDetail({ store }: LiveVendorDetailProps): ReactNode {
  const { editing } = store
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minWidth: 0 }}>
      {store.error !== null ? <StateHint text={store.error} tone="error" /> : null}
      {store.saved ? <p style={SAVED_TEXT}>已保存</p> : null}
      {!store.loaded
        ? <StateHint text="加载中…" />
        : editing === null
          ? <Placeholder hasVendors={store.vendors.length > 0} />
          : <VendorForm store={store} />}
      <GlobalDefaults store={store} />
    </div>
  )
}

/** 未选中时的占位提示（列表为空时给出「点下面添加」的指引）。 */
function Placeholder({ hasVendors }: { hasVendors: boolean }): ReactNode {
  return (
    <div style={placeholderStyle}>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>从左侧选择一条 Live 供应商</p>
      <p style={{ margin: 0, fontSize: 12 }}>
        {hasVendors
          ? '查看或编辑上游地址、凭据名、模型与 API Key'
          : '还没有 Live 供应商，点左下角「+ 添加 Live 供应商」新建一条'}
      </p>
    </div>
  )
}

/** 选中项（或新增）的编辑表单。 */
function VendorForm({ store }: { store: LiveVendorStore }): ReactNode {
  const editing = store.editing
  if (editing === null) return null
  const draft = editing.draft
  const isNew = editing.id === null
  const current = isNew ? undefined : store.vendors.find(item => item.id === editing.id)
  const isDefault = !isNew && editing.id === store.defaultVendor
  const confirming = editing.id !== null && store.pendingDelete === editing.id
  const busy = store.saving || store.keySaving
  /*
   * 采样率按钮的文字带上当前值：编辑已有条目时折叠着看不出它是不是 16 kHz，
   * 而「以为都是 24 kHz」正是接千问时最容易踩的坑。
   */
  const inputRateText = draft.inputSampleRate.trim() === '' ? '24000' : draft.inputSampleRate.trim()
  const outputRateText = draft.outputSampleRate.trim() === '' ? '24000' : draft.outputSampleRate.trim()
  const rateSummary = `采样率（高级）：上行 ${inputRateText} / 下行 ${outputRateText} Hz`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      {/* 头部：名称 + 默认态 + 删除（与聊天供应商详情卡同一行结构）。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={nameTitleStyle} title={draft.label}>
          {isNew ? '新增 Live 供应商' : (draft.label.trim() === '' ? editing.id ?? '' : draft.label)}
        </span>
        {isNew || current === undefined
          ? null
          : isDefault
            ? <span style={defaultTagStyle} title="默认 Live 供应商（Bot 没单独选时用它）">默认</span>
            : (
              <button
                type="button"
                className="dsh-webui-capsule-btn"
                style={CAPSULE_BTN}
                disabled={busy}
                title="设为默认 Live 供应商"
                onClick={() => { void store.setDefault(current) }}
              >
                设为默认
              </button>
            )}
        {current === undefined
          ? null
          : (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
              {confirming
                ? (
                  <>
                    <button
                      type="button"
                      className="dsh-webui-capsule-btn"
                      style={DANGER_CONFIRM_BTN}
                      disabled={busy}
                      onClick={() => { void store.removeVendor(current) }}
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      className="dsh-webui-capsule-btn"
                      style={CAPSULE_BTN}
                      disabled={busy}
                      onClick={() => { store.setPendingDelete(null) }}
                    >
                      取消
                    </button>
                  </>
                )
                : (
                  <button
                    type="button"
                    className="dsh-webui-capsule-btn"
                    style={DANGER_BTN}
                    disabled={busy}
                    title="删除这条 Live 供应商"
                    onClick={() => { store.setPendingDelete(editing.id) }}
                  >
                    删除
                  </button>
                )}
            </div>
          )}
      </div>

      {/* 新增时先给内置模板：一键填入上游地址 / 凭据名 / 模型，填完还能改。 */}
      {isNew && store.presets.length > 0
        ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={FIELD_LABEL}>用内置模板快速填（填完还能改）</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {store.presets.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  className="dsh-webui-capsule-btn"
                  style={CAPSULE_BTN}
                  title={`填入 ${preset.label} 的上游地址、凭据名与模型`}
                  onClick={() => { store.applyPreset(preset) }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        )
        : null}

      <Field label="名称">
        <input
          className="dsh-webui-field"
          style={INPUT_STYLE}
          type="text"
          value={draft.label}
          placeholder="例如 我的 Live 网关"
          aria-label="名称"
          disabled={busy}
          onChange={(event) => { store.patchDraft({ label: event.target.value }) }}
        />
      </Field>

      <Field label="上游地址">
        <input
          className="dsh-webui-field"
          style={INPUT_STYLE}
          type="text"
          value={draft.upstream}
          placeholder="wss://api.stepfun.com/v1/realtime"
          aria-label="上游地址"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => { store.patchDraft({ upstream: event.target.value }) }}
        />
      </Field>

      <Field label="凭据名（留空自动生成）">
        <input
          className="dsh-webui-field"
          style={INPUT_STYLE}
          type="text"
          value={draft.keyRef}
          placeholder={keyRefFromId(store.draftId)}
          aria-label="凭据名"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => { store.patchDraft({ keyRef: event.target.value }) }}
        />
      </Field>

      {/*
        模型：输入框 + datalist，而不是下拉。用户要接自己网关里的 realtime 模型时，
        下拉里永远没有那个 id；这里保留下拉建议，同时允许任意字符串。
      */}
      <Field label="模型（可自由填写）">
        <input
          className="dsh-webui-field"
          style={INPUT_STYLE}
          type="text"
          list={store.modelListId}
          value={draft.model}
          placeholder="留空 = 自动（按宿主候选链）"
          aria-label="模型（可自由填写）"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => { store.patchDraft({ model: event.target.value }) }}
        />
        <datalist id={store.modelListId}>
          {store.modelSuggestions.map(model => <option key={model} value={model} />)}
        </datalist>
      </Field>

      <Field label="API Key（只写不读，保存后不回显）">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <input
            className="dsh-webui-field"
            style={INPUT_STYLE}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={store.keyDraft}
            placeholder="粘贴 API Key"
            aria-label="API Key"
            aria-invalid={store.keyNotice !== null && store.keyNotice.tone === 'error'}
            disabled={store.keySaving}
            onChange={(event) => {
              store.setKeyDraft(event.target.value)
              // 改了输入就清掉上一次的反馈：留着「已保存」会让人以为新值也存了。
              store.clearKeyNotice()
            }}
          />
          <button
            type="button"
            className="dsh-webui-capsule-btn"
            style={CAPSULE_BTN}
            disabled={store.keySaving || store.saving || store.keyDraft.trim() === ''}
            onClick={() => { void store.submitKeyOnly() }}
          >
            {store.keySaving ? '保存中…' : '保存密钥'}
          </button>
        </div>
      </Field>
      {store.keyNotice === null
        ? null
        : store.keyNotice.tone === 'ok'
          ? <p style={SAVED_TEXT}>{store.keyNotice.text}</p>
          : <StateHint text={store.keyNotice.text} tone="error" />}
      <p style={HINT_TEXT}>
        {`密钥会写进凭据名 ${store.editingKeyRef}（DSH 凭据库，加密保存），页面任何地方都不回显密钥值。改了凭据名之后要重新粘贴一次 API Key，否则通话仍按旧引用名去找。`}
      </p>

      {/* 采样率：默认折叠。上行采样率喂错不报错，只会变调 + VAD 时间轴错位。 */}
      <button
        type="button"
        className="dsh-webui-capsule-btn"
        style={{ ...CAPSULE_BTN, alignSelf: 'flex-start' }}
        aria-expanded={store.advanced}
        onClick={() => { store.setAdvanced(!store.advanced) }}
      >
        {store.advanced ? '收起采样率' : rateSummary}
      </button>
      {store.advanced
        ? (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Field label="上行采样率（Hz）" narrow>
                <input
                  className="dsh-webui-field"
                  style={INPUT_STYLE}
                  type="number"
                  min={LIVE_SAMPLE_RATE_MIN}
                  max={LIVE_SAMPLE_RATE_MAX}
                  step={1000}
                  value={draft.inputSampleRate}
                  placeholder="24000"
                  aria-label="上行采样率"
                  disabled={busy}
                  onChange={(event) => { store.patchDraft({ inputSampleRate: event.target.value }) }}
                />
              </Field>
              <Field label="下行采样率（Hz）" narrow>
                <input
                  className="dsh-webui-field"
                  style={INPUT_STYLE}
                  type="number"
                  min={LIVE_SAMPLE_RATE_MIN}
                  max={LIVE_SAMPLE_RATE_MAX}
                  step={1000}
                  value={draft.outputSampleRate}
                  placeholder="24000"
                  aria-label="下行采样率"
                  disabled={busy}
                  onChange={(event) => { store.patchDraft({ outputSampleRate: event.target.value }) }}
                />
              </Field>
            </div>
            <p style={HINT_TEXT}>
              喂错上行采样率不会报错，只会让声音变调、VAD 时间轴错位（表现是「说完了不响应」）。千问实时语音上行是 16000，StepFun 是 24000；留空按 24000。
            </p>
          </>
        )
        : null}

      {store.formError !== null ? <StateHint text={store.formError} tone="error" /> : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
        <button
          type="button"
          className="dsh-webui-secondary-btn"
          style={secondaryButtonStyle}
          disabled={busy}
          onClick={store.cancelEdit}
        >
          取消
        </button>
        <button
          type="button"
          className="dsh-webui-primary-btn"
          style={primaryButtonStyle}
          disabled={busy}
          onClick={() => { void store.commitEdit() }}
        >
          {store.saving ? '保存中…' : (isNew ? '新增' : '保存')}
        </button>
      </div>
    </div>
  )
}

/**
 * 通话默认（全局）：音色 / 语速 / 联网。
 *
 * 对所有 Live 供应商生效，不属于任何一条——所以它挂在右栏底部，未选中时也在。
 * 改动即时 POST（与列表操作同一条通道），不等上面表单的保存按钮。
 */
function GlobalDefaults({ store }: { store: LiveVendorStore }): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <span style={SECTION_TITLE}>通话默认（全局）</span>
      <div className="phub-fill" style={FILL_PANEL}>
        <SelectField
          label="默认音色"
          value={store.voice}
          disabled={store.saving}
          onChange={(value) => { void store.saveGlobal({ voice: value }) }}
        >
          <option value="">自动（{store.defaultVoiceLabel}）</option>
          {store.voices.map(option => (
            <option key={option.id} value={option.id}>
              {option.hint === undefined ? option.label : `${option.label} · ${option.hint}`}
            </option>
          ))}
          {/* 复刻音色 / 旧值：保留并显示，不让用户以为「填过的东西没被记住」。 */}
          {store.voiceIsCustom ? <option value={store.voice}>自定义：{store.voice}</option> : null}
        </SelectField>
        <div style={FIELD_COL}>
          <span style={FIELD_LABEL}>语速</span>
          <div className="dsh-cap-group" style={inlineCapGroupStyle}>
            {LIVE_SPEED_ORDER.map(speed => {
              const on = store.currentSpeed === speed
              return (
                <button
                  key={speed}
                  type="button"
                  className="dsh-cap-pill"
                  aria-pressed={on}
                  style={on ? inlineCapPillOnStyle : inlineCapPillStyle}
                  disabled={store.saving}
                  title={`语速：${REALTIME_SPEED_LABELS[speed]}`}
                  onClick={() => { if (!on) void store.saveGlobal({ speed }) }}
                >
                  {REALTIME_SPEED_LABELS[speed]}
                </button>
              )
            })}
          </div>
        </div>
        <div style={FIELD_COL}>
          <span style={FIELD_LABEL}>内置联网搜索</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32 }}>
            <button
              type="button"
              role="switch"
              aria-checked={store.webSearch}
              aria-label="内置联网搜索"
              disabled={store.saving}
              style={store.webSearch ? OFFICIAL_SWITCH_ON : OFFICIAL_SWITCH}
              onClick={() => { void store.saveGlobal({ webSearch: !store.webSearch }) }}
            >
              <span style={store.webSearch ? OFFICIAL_SWITCH_THUMB_ON : OFFICIAL_SWITCH_THUMB} />
            </button>
            <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
              {store.webSearch ? '开（默认）' : '关'}
            </span>
          </div>
        </div>
      </div>
      <p style={HINT_TEXT}>
        音色与语速对所有 Live 供应商生效；不同供应商支持的音色不同，上游不接受时会回落到它自己的默认音色（通话建立后宿主会把实际生效值回传）。语速靠指令表达（千问另有真实参数），不是播放变速。
      </p>
    </div>
  )
}

/**
 * 表单字段：标签在上、控件在下（与 ChatProviderDetail 的 Field 同规格）。
 *
 * @param props - 标签、是否窄字段、子节点。
 */
function Field({ label, narrow, children }: {
  label: string
  /** 窄字段（采样率这类 4–5 位数字）：不参与平分整行。 */
  narrow?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <label style={{
      display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
      // 窄字段（采样率这类 4–5 位数字）用在行向容器里：不参与平分整行。
      ...(narrow === true ? { flex: '0 1 150px' } : {}),
    }}>
      <span style={FIELD_LABEL}>{label}</span>
      {children}
    </label>
  )
}

/* ---------- 内联样式（主题令牌 + fallback） ---------- */

/** 小标签（与 SelectField 的字段标签同规格：12px / 500 / label-secondary）。 */
const FIELD_LABEL: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}

/** 全局面板里的列向字段（标签在上、控件在下）。 */
const FIELD_COL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
  flex: '1 1 160px',
}

/** 占位块：不用虚线卡（右栏外层已经是描边面板，再套一层会显得像空态错误）。 */
const placeholderStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
  minHeight: 160, padding: '24px 12px', textAlign: 'center',
  color: 'var(--dsw-alias-label-tertiary, #8f959e)',
}

/** 详情标题（14px / 500 / label-primary，与聊天供应商详情卡一致）。 */
const nameTitleStyle: CSSProperties = {
  fontSize: 14, lineHeight: '22px', fontWeight: 500,
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, maxWidth: 320,
}

/** 「默认」标记：绿色小胶囊（0.5px 描边 + 成功色文字）。 */
const defaultTagStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
  padding: '1px 6px',
  borderRadius: 'var(--dsw-radius-xs, 4px)',
  border: '0.5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.14))',
  color: 'var(--dsw-alias-state-success-primary, #00b42a)',
  fontSize: 11, lineHeight: '16px',
}

/** 删除按钮（常态：中性底 + 错误色文字，破坏性操作不抢主按钮的视觉）。 */
const DANGER_BTN: CSSProperties = { ...CAPSULE_BTN, color: 'var(--dsw-alias-state-error-primary, #d54941)' }

/** 删除确认按钮（确认态才实心，避免误点）。 */
const DANGER_CONFIRM_BTN: CSSProperties = {
  ...CAPSULE_BTN,
  border: 'none',
  background: 'var(--dsw-alias-state-error-primary, #d54941)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)',
}

/** 区块小标题（「通话默认（全局）」那一行）。 */
const SECTION_TITLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary)',
}

/** 常驻小字提示（官方 .advancedHint 规格：12 / 18 / label-tertiary）。 */
const HINT_TEXT: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}

/** 保存成功的绿字（与详情页顶部的 chatCopy.saved 同色）。 */
const SAVED_TEXT: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-success-primary, #00b42a)',
}

/* 底部按钮沿用官方 18px 圆角胶囊规格（与 ChatProviderDetail 同款：36px 高 / 14 字）。 */
const primaryButtonStyle: CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  height: 36, padding: '0 14px',
  fontSize: 14, lineHeight: '22px', borderRadius: 18,
  border: 'none',
  background: 'var(--dsw-alias-button-primary-fill, #4176e6)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)',
  cursor: 'pointer',
}

const secondaryButtonStyle: CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  height: 36, padding: '0 14px',
  fontSize: 14, lineHeight: '22px', borderRadius: 18,
  border: '1px solid var(--dsw-alias-border-l2, #dcdfe6)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  cursor: 'pointer',
}
