/**
 * dsh-recall-plugin — client 设置卡片装配（S1 拆分后）
 *
 * 原单文件按域拆为三份后，本文件只留装配层：分区折叠头 SectionToggle（共享
 * UI 原子）与撤回卡片外壳 RecallSettingsCard，组装配置表单 / 排除配置 /
 * 快照管理三张卡片。拆分动机见各子模块头部注释；引用路径与导出面保持不变，
 * app.ts 无需改动。
 */

import type { ReactApi, UtilApi } from './util.js'
import type { ClientSessionsService, ClientUiWorkspaceService, ClientWorkspacesService } from '../types/client-contract.js'
import { buildConfigForm } from './config-card.js'
import { buildExcludeCards } from './exclude-card.js'
import { buildSnapshotManager } from './snapshot-manager.js'

export function buildSettingsCards(React: ReactApi, util: UtilApi, sessionsSvc: ClientSessionsService, workspacesSvc?: ClientWorkspacesService, uiWorkspaceSvc?: ClientUiWorkspaceService): { RecallSettingsCard: () => import('react').ReactNode } {
  // 分区折叠头：官方卡片列表纵向排布，排除配置/快照管理是重内容，默认折叠、
  // 按需展开（展开后由设置外壳保持挂载，草稿不丢）。作为共享原子注入
  // config-card（见其 SectionToggleProps 契约）。
  // divider：在折叠头上方画一条分界线，标记「表单字段 → 折叠分区列表」的分界，
  // 只由列表首个折叠头（见 config-card 的「高级：基础排除表」）开启
  function SectionToggle(props: { title: string; open: boolean; onToggle: () => void; meta?: string; divider?: boolean }): import('react').ReactNode {
    return React.createElement('button', {
      type: 'button',
      className: 'dsh-recall-cardbtn' + (props.divider ? ' dsh-recall-section-divider' : ''),
      'aria-expanded': props.open,
      onClick: props.onToggle,
    },
      // 标题在前、chevron 收尾（官方卡片头同为「左标题 + 右 chevron」）：chevron
      // 在前的布局会把标题推到 18px 盒 + 12px gap 之后，实测与上方分组标题
      // （cfg-group）左缘差出约 30px、视觉上不齐；标题独占行首后与分组标题、
      // 表单标签共享同一条左缘线
      React.createElement('span', { className: 'dsh-recall-section-title' }, props.title),
      props.meta ? React.createElement('span', { className: 'dsh-recall-tree-meta' }, props.meta) : null,
      // 向下字形 14px chevron：收起不旋转、展开 rotate(180deg) 朝上（transition
      // .16s）；读屏状态由 aria-expanded 播报，字形只承担可点提示
      React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16',
        className: 'dsh-recall-section-chevron' + (props.open ? ' dsh-recall-section-chevron-open' : ''),
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round'
      }, React.createElement('path', { d: 'M4 6l4 4 4-4' }))
    )
  }

  const { ConfigForm } = buildConfigForm(React, util, SectionToggle)
  const { ExcludeFilesSection } = buildExcludeCards(React, util)
  const { ManageCard } = buildSnapshotManager(React, util, sessionsSvc, workspacesSvc, uiWorkspaceSvc)
  // 分区标题走词表（A4）：外壳只负责装配，不该有自己的一份文案
  const { t } = util

  // 「插件配置」分区里的撤回设置块（settings.plugin.item keyed slot，key =
  // Host 端注册的 settings namespace 'dsh-recall'）。用户实测反馈两轮收敛：
  // 外层再套一层可折叠卡是冗余交互（插件页头部已有名称/描述/开关，进入设置
  // 就该直接看到设置项）→ 先去折叠头；随后连卡片外框也去掉——设置项直接
  // 平铺在设置页面上，不再多一层描边容器。仅保留内部两个按需折叠的分区
  // （排除配置/快照管理仍是重内容，默认折叠、展开后保持挂载不丢草稿）。
  function RecallSettingsCard(): import('react').ReactNode {
    const [sections, setSections] = React.useState({ exclude: false, manage: false })
    // 语言落地计数：ConfigForm 换语言后回调一次，外壳跳过自身文案的旧语言
    // 快照（两个分区折叠头在 ConfigForm 之外渲染——实弹发现半截切换）
    const [, setLocaleTick] = React.useState(0)
    const notifyLocale = React.useCallback(() => setLocaleTick((n) => n + 1), [])
    function toggle(key: string): void {
      setSections((prev) => Object.assign({}, prev, { [key]: !(prev as Record<string, boolean>)[key] }))
    }
    return React.createElement('li', { className: 'dsh-recall-settings' },
      React.createElement('div', { className: 'dsh-recall-settings-body' },
        React.createElement(ConfigForm, { onLocaleApplied: notifyLocale }),
        React.createElement(SectionToggle, { title: t('section.exclude'), open: sections.exclude, onToggle: () => toggle('exclude') }),
        // section-body 只做纵向间距与展开入场动画，不带描边/底色：外层卡片框
        // 去掉后内容区再套一层框等于把「去包裹」加回来（用户实测反馈）。「高级：
        // 基础排除表」不包——它在 cfg-grid 内本就走通栏，且 label 列对齐依赖
        // grid item 身份，包容器会破坏跨行对齐。
        sections.exclude ? React.createElement('div', { className: 'dsh-recall-section-body' }, React.createElement(ExcludeFilesSection)) : null,
        React.createElement(SectionToggle, { title: t('section.manage'), open: sections.manage, onToggle: () => toggle('manage') }),
        sections.manage ? React.createElement('div', { className: 'dsh-recall-section-body' }, React.createElement(ManageCard)) : null
      )
    )
  }

  return { RecallSettingsCard }
}