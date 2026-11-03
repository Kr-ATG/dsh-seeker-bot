/**
 * dsh-seeker-bot — 「界面字体」设置行（官方「通用」设置页的一个偏好行）。
 *
 * 座位：`settings.general.item`（官方 `ui-settings-general` 的 General 入口声明）。
 * 与官方的「外观」「字号」两行同一列堆叠——这个槽位只堆行，行内全部内容
 * （标签、当前值、写入路径）由注册方自己负责，owner 不传任何 props。
 *
 * ## 版式逐字对齐官方 LanguageRow / FontSizeRow
 *
 * 官方那一行的规格（`ui-theme` 内联的 FontSizeRow.module.css）：
 *   .row      flex / align-items:center / gap:8 / padding:16px 0 / border-bottom .5px border-l2
 *   .rowText  flex:1 / column / gap:4 / padding-right:48px
 *   .title    14px/22px 400 label-primary
 *   .desc     12px/18px 400 label-tertiary
 *
 * 直接复刻这套 token 而不是 require 官方组件：官方 CSS Modules 由各自的 bundle
 * 注入，插件渲染其组件时样式表未必就位（实测查不到规则），会出现「结构对、外观裸」。
 *
 * ## 下拉框为什么改用官方 primitives 的 Menu
 *
 * 原生 select 展开后的 option 列表是浏览器自己渲染的原生控件，不在文档流里，
 * CSS 完全碰不到（白底 + 系统蓝高亮 + 方角），和 DSH 的设置页视觉割裂。
 * 改用官方 `Menu`（按钮触发 + portal 浮层 + 勾选）后，弹层层级、圆角、行高、
 * hover 与选中态全部由官方设计系统提供——与「语言」「繁忙时的发送行为」那些
 * 官方设置行同款。触发钮复刻官方 LanguageRow 的 selector pill（h36 / r18 /
 * 模块底 / hover 换 interactive-bg-hover）。
 *
 * ## 为什么下拉框旁边要显示体积与状态
 *
 * 霞鹜文楷屏幕版约 10.3 MB、HarmonyOS Sans 约 8.3 MB、霞鹜新致宋约 5.0 MB：首次
 * 切换要真下载。不告诉用户就会变成「点了没反应」（其实在下 10MB）。所以切换中
 * 显示「加载中」，失败显示「加载失败，已回退系统字体」——失败必须可见，否则用户
 * 只会觉得字体坏了。
 */
import { useState, useSyncExternalStore } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { FONT_OPTIONS } from './font.js'
import { getSnapshot, setFont, subscribe } from './store.js'

/** 行外壳：官方 .row 规格。 */
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '16px 0',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))',
} as const

/** 文本列：官方 .rowText 规格。 */
const textStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  gap: 4,
  minWidth: 0,
  paddingRight: 48,
} as const

/** 标题：官方 .title 规格。 */
const titleStyle = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  fontWeight: 400,
  lineHeight: '22px',
} as const

/** 说明：官方 .desc 规格。 */
const descStyle = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  fontWeight: 400,
  lineHeight: '18px',
} as const

/** 字体授权署名：HarmonyOS 许可要求在软件内显著提示字体使用（10px 注脚样式）。 */
const noticeStyle = {
  color: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))',
  fontSize: 10,
  fontWeight: 400,
  lineHeight: '14px',
} as const

/** 控制列：官方 .control 规格。 */
const controlStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
} as const

/** 下拉触发钮样式表 id（全局只需注入一次）。 */
const SELECT_CSS_ID = 'dsh-seeker-bot-ui-font-select-css'

/**
 * 触发钮样式：逐字复刻官方 LanguageRow.module.css 的 .selector（h36 / r18 /
 * 模块底 / hover 换 interactive-bg-hover），外加 focus-visible 轮廓。
 *
 * 必须用真实样式表而不是内联 style：hover / focus-visible 是伪类，内联写法
 * 够不到；这也是官方 selector 的既有规格，不另造一套。
 */
const SELECT_CSS = `
.dsh-seeker-ui-font-select{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08));font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer;flex:none;white-space:nowrap;transition:background-color .15s ease}
.dsh-seeker-ui-font-select:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsh-seeker-ui-font-select:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.dsh-seeker-ui-font-chev{flex:none}
`

/** 注入触发钮样式表（幂等；SSR / 测试环境没有 document 时静默跳过）。 */
function ensureSelectCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(SELECT_CSS_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = SELECT_CSS_ID
  tag.dataset.plugin = 'dsh-seeker-bot'
  tag.dataset.pluginCss = 'ui-font/select'
  tag.textContent = SELECT_CSS
  document.head.appendChild(tag)
}

ensureSelectCss()

/**
 * 状态徽标（加载中 / 失败）。
 *
 * 返回类型写 `JSX.Element | null` 而不是 `unknown`：`unknown` 会让 TS 拒绝把它
 * 当 JSX 组件使用（TS2786），而这里确实要嵌进元素树里。
 */
function StatusBadge({ load, sizeLabel }: { load: string; sizeLabel: string }): JSX.Element | null {
  if (load === 'loading') {
    return (
      <span style={{ ...descStyle, whiteSpace: 'nowrap' }} role="status">
        加载中 {sizeLabel}
      </span>
    )
  }
  if (load === 'failed') {
    return (
      <span
        style={{ ...descStyle, color: 'var(--dsw-alias-state-error-primary, #d54941)', whiteSpace: 'nowrap' }}
        role="status"
      >
        加载失败，已回退系统字体
      </span>
    )
  }
  return null
}

/**
 * 渲染「界面字体」偏好行。
 *
 * `inject` 面按官方契约传入（`settings.general.item` 的注册要求组件收一个
 * inject 面）。本行的写入路径走模块内单例 store（`setFont`），不经过 inject，
 * 所以这里只把它当可选参数忽略——但**不能**因此省掉注册时的 `inject` 声明，
 * 否则类型与运行时契约都对不上。
 * @param props - 槽位注入面（本行不使用）。
 * @returns 设置行元素树。
 */
export function UiFontRow(_props: { setFont?: (id: string) => void } = {}): JSX.Element {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [open, setOpen] = useState(false)
  const { option } = state
  const sizeLabel = option.webfont?.sizeLabel ?? ''
  return (
    <div style={rowStyle} data-ui-font-row="true">
      <div style={textStyle}>
        <div style={titleStyle}>界面字体</div>
        <div style={descStyle}>应用到整个 DSH 界面与对话正文</div>
        {option.notice !== undefined ? <div style={noticeStyle}>{option.notice}</div> : null}
      </div>
      <div style={controlStyle}>
        <StatusBadge load={state.load} sizeLabel={sizeLabel} />
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={FONT_OPTIONS.map(item => ({ id: item.id, label: item.label }))}
          selectedId={state.id}
          onSelect={(id) => { setOpen(false); setFont(id) }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className="dsh-seeker-ui-font-select"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="界面字体"
              onClick={() => { setOpen(prev => !prev) }}
            >
              {option.label}
              <IconChevronDownOutlineRegular className="dsh-seeker-ui-font-chev" />
            </button>
          )}
        />
      </div>
    </div>
  )
}
