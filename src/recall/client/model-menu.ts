/**
 * dsh-recall-plugin — 编辑卡里的模型菜单（官方同构的两段式菜单）
 *
 * 官方菜单先给两行「模型 / 推理等级」，点进去才是模型列表（搜索 + 按供应商
 * 分组）或档位列表。这里复刻同一结构与度量（34px 行高、13px 名字、4px 内边距、
 * 圆角 `--dsw-radius-md`、选中行打勾），但不依赖官方私有类名——那些是构建期
 * 哈希，跨版本会变；这里只借公开的 CSS 变量。
 *
 * 官方列表里的「1017」徽标来自 `conversation.input.model.label` 槽的注入方，
 * 插件拿不到该槽的渲染权，故省略；模型名本身已带价格后缀。
 */

import type { ReactApi } from './util.js'
import type { Translate } from './locales/index.js'
import type { ModelGroup, ModelOption } from './model-picker.js'

export type ModelPane = 'main' | 'list' | 'effort'

export interface ModelMenuProps {
  pane: ModelPane
  query: string
  groups: ModelGroup[]
  activeKey: string
  activeOption: ModelOption | null
  modelLabel: string
  effortLabel: string
  activeEffortId: string
  busy: boolean
  onPane(pane: ModelPane): void
  onQuery(query: string): void
  onPick(option: ModelOption): void
  onPickEffort(effortId: string): void
}

export function renderModelMenu(React: ReactApi, t: Translate, props: ModelMenuProps): import('react').ReactNode {
  const chevron = () => React.createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, strokeWidth: 1,
  }, React.createElement('path', { d: 'M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4', stroke: 'currentColor' }))

  const check = () => React.createElement('span', { className: 'dsh-recall-menu-check' },
    React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      React.createElement('path', { d: 'M3.2 8.4l3.1 3.1 6.5-6.9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })
    )
  )

  const cell = (label: string, value: string, onClick: () => void) => React.createElement('button', {
    type: 'button', role: 'menuitem', className: 'dsh-recall-menu-cell', onClick,
  },
    React.createElement('span', { className: 'dsh-recall-menu-cell-label' }, label),
    React.createElement('span', { className: 'dsh-recall-menu-cell-value' }, value),
    React.createElement('span', { className: 'dsh-recall-menu-cell-chevron' }, chevron())
  )

  if (props.pane === 'main') {
    return React.createElement('div', { className: 'dsh-recall-menu', role: 'menu', 'aria-label': t('edit.model.menu') },
      cell(t('edit.model.label'), props.modelLabel, () => props.onPane('list')),
      cell(t('edit.model.effort'), props.effortLabel !== '' ? props.effortLabel : t('edit.model.providerDefault'), () => props.onPane('effort'))
    )
  }

  if (props.pane === 'effort') {
    const option = props.activeOption
    // 与官方一致：模型没有声明默认档时，先给一条「provider default」（传空档位）
    const levels: Array<{ id: string; name: string }> = []
    if (option === null || option.defaultEffort === undefined) levels.push({ id: '', name: t('edit.model.providerDefault') })
    for (const level of option ? option.efforts : []) levels.push(level)
    return React.createElement('div', { className: 'dsh-recall-menu', role: 'menu', 'aria-label': t('edit.model.effort') },
      levels.length === 0
        ? React.createElement('div', { className: 'dsh-recall-menu-empty' }, t('edit.model.noLevels'))
        : levels.map((level) => React.createElement('button', {
            key: 'effort-' + level.id,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': level.id === props.activeEffortId,
            disabled: props.busy,
            className: 'dsh-recall-menu-option' + (level.id === props.activeEffortId ? ' dsh-recall-menu-option-active' : ''),
            onClick: () => props.onPickEffort(level.id),
          },
            React.createElement('span', { className: 'dsh-recall-menu-name' }, level.name),
            level.id === props.activeEffortId ? check() : React.createElement('span', { className: 'dsh-recall-menu-check' })
          ))
    )
  }

  const query = props.query.trim().toLowerCase()
  const groups = props.groups
    .map((group) => ({
      id: group.id,
      name: group.name,
      options: query === '' ? group.options : group.options.filter((option) => option.label.toLowerCase().indexOf(query) >= 0),
    }))
    .filter((group) => group.options.length > 0)
  const total = groups.reduce((count, group) => count + group.options.length, 0)

  return React.createElement('div', { className: 'dsh-recall-menu', role: 'group', 'aria-label': t('edit.model.menu') },
    // 搜索：官方在候选超过 4 条时才显示，这里同样按总数决定
    props.groups.reduce((count, group) => count + group.options.length, 0) > 4
      ? React.createElement('div', { className: 'dsh-recall-menu-search-row' },
          React.createElement('span', { className: 'dsh-recall-menu-search' },
            React.createElement('input', {
              type: 'text',
              role: 'searchbox',
              value: props.query,
              placeholder: t('edit.model.search'),
              'aria-label': t('edit.model.search'),
              onChange: (e: import('react').ChangeEvent<HTMLInputElement>) => props.onQuery(e.target.value),
            })
          )
        )
      : null,
    React.createElement('div', { className: 'dsh-recall-menu-groups', role: 'menu', 'aria-label': t('edit.model.label') },
      total === 0
        ? React.createElement('div', { className: 'dsh-recall-menu-empty' }, t('edit.model.empty'))
        : groups.map((group) => React.createElement('section', { key: 'group-' + group.id, className: 'dsh-recall-menu-group' },
            React.createElement('div', { className: 'dsh-recall-menu-heading' }, group.name),
            group.options.map((option) => React.createElement('button', {
              key: option.key,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': option.key === props.activeKey,
              disabled: props.busy,
              title: option.label,
              className: 'dsh-recall-menu-option' + (option.key === props.activeKey ? ' dsh-recall-menu-option-active' : ''),
              onClick: () => props.onPick(option),
            },
              React.createElement('span', { className: 'dsh-recall-menu-name' }, option.label),
              option.key === props.activeKey ? check() : React.createElement('span', { className: 'dsh-recall-menu-check' })
            ))
          ))
    )
  )
}
