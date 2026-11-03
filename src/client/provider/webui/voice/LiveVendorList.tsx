/**
 * 「模型供应商」页 · 实时语音模式 · 左栏。
 *
 * 视觉沿用 {@link ChatProviderList}（标题 + 分组列表 + 底部「+ 添加」按钮那套）：
 * 用户 2026-11-02 原话是「还是沿用左侧供应商与添加供应商的方式，只不过是里面的
 * 内容全部换掉了」——所以这里只换数据源，形态一字不动。
 *
 * 行内不再放「编辑 / 删除 / 设为默认」：那些操作属于右侧详情（与聊天供应商页
 * 一致——左栏只负责选，右栏负责改）。左栏在选中后由 `.phub-host[data-editing]`
 * 整体收起，返回入口在详情工具条左侧。
 */
import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ensureProviderFieldStyles } from '../chat/ModelListEditor.tsx'
import type { LiveVendorStore } from './store.ts'

/** {@link LiveVendorList} 的 props。 */
export interface LiveVendorListProps {
  /** 页面级共享 store（与右栏同一份）。 */
  store: LiveVendorStore
  /**
   * 标题位置的替代内容（当前是「模型 / 实时语音」模式切换）。
   *
   * 给值时不再渲染「Live 供应商」文字——用户 2026-11-02 要求切换按钮顶替标题。
   */
  headerSlot?: ReactNode
}

/**
 * 渲染 Live 供应商左栏：列表 + 添加按钮。
 * @param props - 共享 store 与标题插槽。
 * @returns 左栏导航。
 */
export function LiveVendorList({ store, headerSlot }: LiveVendorListProps): ReactNode {
  const { loaded, vendors, defaultVendor, editing, error, saving } = store
  // 行内小胶囊与分段控件的 hover 态样式（与聊天供应商页共用同一注入块）。
  useEffect(() => { ensureProviderFieldStyles() }, [])
  const selectedId = editing === null ? null : editing.id
  return (
    <section className="phub-nav" style={navColStyle}>
      <div style={navHeaderStyle}>
        {headerSlot ?? <p style={{ ...titleStyle, flex: 1, minWidth: 0 }}>Live 供应商</p>}
      </div>

      <div style={navScrollStyle}>
        {/* 分组标题与聊天供应商页逐字一致：两套列表同一个骨架，只是内容换了。 */}
        <p style={groupLabelStyle}>已配置</p>
        {!loaded
          ? <p style={hintStyle}>加载中…</p>
          : vendors.length === 0
            ? <p style={hintStyle}>还没有 Live 供应商，点下面添加。</p>
            : vendors.map(vendor => (
              <NavRow
                key={vendor.id}
                label={vendor.label}
                isDefault={vendor.id === defaultVendor}
                selected={selectedId === vendor.id}
                onSelect={() => { store.select(vendor.id) }}
              />
            ))}
        {error === null
          ? null
          : (
            <>
              <p style={errorStyle}>{error}</p>
              <button type="button" className="dsh-webui-capsule-btn" style={retryBtnStyle} onClick={store.reload}>
                重试
              </button>
            </>
          )}
      </div>

      <button
        type="button"
        className="dsh-webui-capsule-btn"
        style={addBtnStyle}
        disabled={saving}
        onClick={store.beginCreate}
      >
        + 添加 Live 供应商
      </button>
    </section>
  )
}

/**
 * 左栏一行：**只有名称 + 是否默认**。
 *
 * 用户 2026-11-02 明确要求「只需要显示供应商名字与是否默认标签」——上游地址与模型
 * 是详情里的事，摊在列表里只会把一栏挤成两行字，反而不好扫。
 *
 * @param props - 行数据与选中回调。
 * @returns 导航行。
 */
function NavRow({ label, isDefault, selected, onSelect }: {
  label: string
  /** 默认 Live 供应商（Bot 没单独选时用它）。 */
  isDefault: boolean
  selected: boolean
  onSelect: () => void
}): ReactNode {
  return (
    <div
      className="dsh-webui-provider-nav-row"
      style={selected ? navRowSelectedStyle : navRowStyle}
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      title={isDefault ? `${label}（默认）` : label}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }}
    >
      <span style={navNameStyle}>{label}</span>
      {isDefault ? <span style={defaultTagStyle} title="默认 Live 供应商（Bot 没单独选时用它）">默认</span> : null}
    </div>
  )
}

/* ---------- 内联样式（与 chat/ChatProviderList.tsx 同一套规格） ---------- */

/* 左栏：宽度由外层 .phub-navwrap 容器决定（写死宽度会在右边留一条死空白）。 */
const navColStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  width: '100%', flex: '1 1 auto', minWidth: 0, minHeight: 0, height: '100%',
}

const navHeaderStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, minHeight: 22,
}

const titleStyle: CSSProperties = {
  margin: 0, fontSize: 14, fontWeight: 600,
  color: 'var(--dsw-alias-label-primary, #1f2329)',
}

const groupLabelStyle: CSSProperties = {
  margin: '2px 0 0', fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary, #8f959e)',
}

const hintStyle: CSSProperties = {
  margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8f959e)',
}

const errorStyle: CSSProperties = {
  margin: 0, fontSize: 12, lineHeight: '18px',
  color: 'var(--dsw-alias-state-error-primary, #d54941)',
}

/* 列表滚动区：条数多时栏内自滚，「+ 添加」按钮始终钉在栏底可见。 */
const navScrollStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  overflowY: 'auto', overflowX: 'hidden', minHeight: 0, flex: '1 1 auto',
  paddingRight: 2, marginLeft: -4, paddingLeft: 4,
}

/* 导航行：无描边，仅靠底色区分状态（描边会被主题/全局规则染色）。 */
const navRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
  minWidth: 0,
}

/* 选中态：填充面 + 左侧品牌色指示条（用 boxShadow inset 画，不占布局）。 */
const navRowSelectedStyle: CSSProperties = {
  ...navRowStyle,
  background: 'var(--dsw-alias-bg-module-platform, #f2f3f5)',
  boxShadow: 'inset 3px 0 0 0 var(--dsw-alias-state-business-primary, #4176e6)',
}

/* 行内两行文字：名称在上、上游/模型在下，超出省略。 */
const rowTextColStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 1,
  flex: '1 1 auto', minWidth: 0,
}

const navNameStyle: CSSProperties = {
  fontSize: 13, lineHeight: '20px', fontWeight: 500,
  // 与 chat/ChatProviderList 的 navNameStyle 逐字一致（含 flex，否则名称与默认标签的间距对不上）
  flex: '1 1 auto', minWidth: 0,
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

const navMetaStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 11, lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary, #8f959e)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

/* 「默认」小胶囊：0.5px 描边 + 成功色文字（与详情页 Pill 同族但不可点）。 */
const defaultTagStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', flexShrink: 0,
  padding: '1px 6px',
  borderRadius: 'var(--dsw-radius-xs, 4px)',
  border: '0.5px solid var(--dsw-alias-border-l3, rgba(255,255,255,.14))',
  color: 'var(--dsw-alias-state-success-primary, #00b42a)',
  fontSize: 11, lineHeight: '16px',
}

/* 官方行内小胶囊（Button .sm）：28px 高、14px 圆角、12px 字。 */
const addBtnStyle: CSSProperties = {
  boxSizing: 'border-box',
  alignSelf: 'flex-start',
  height: 28, padding: '0 10px', flexShrink: 0,
  border: '1px solid var(--dsw-alias-border-l2, #dcdfe6)',
  borderRadius: 14,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  fontSize: 12, lineHeight: '18px', cursor: 'pointer',
}

/* 加载失败重试：与添加按钮同规格，避免在错误态引入第二种按钮外观。 */
const retryBtnStyle: CSSProperties = {
  ...addBtnStyle,
  alignSelf: 'flex-start',
}
