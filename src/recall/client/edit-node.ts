/**
 * dsh-recall-plugin — client 就地编辑（issue #26）
 *
 * 官方不允许第二个 composer 实例（`conversation.composer.bar` 是 single 槽，
 * 已被 conversation.content 独占声明），所以消息位置这张卡是插件自绘的
 * 「官方同款」：外框配方逐字对齐官方 composer 卡片（panel 圆角 / input-major
 * 底 / soft 阴影 / 14-24 字号行高），底部输入框保持原样不受影响。
 *
 * 卡内能力：文本（自动增高）、Enter 发送、附件增删与粘贴/拖入、只读的权限与
 * 模型 chip（值抄自底部官方输入框当前显示）、Esc 取消。状态机与执行链仍在
 * recall-node（复用同一段 fork 收尾），这里只吃 stage 渲染。
 */

import type { ReactApi } from './util.js'
import type { Translate } from './locales/index.js'

// editing / error 都携带 text：错误后仍可继续改再重试，不丢用户输入。
// attachments 是原消息里可回填的附件数（0 时不渲染附件提示行）
export type EditStage =
  | { stage: 'idle' }
  | { stage: 'editing'; text: string; attachments: number }
  | { stage: 'submitting' }
  | { stage: 'error'; text: string; attachments: number; message: string }

// 卡内附件条目：key 用于移除（原消息引用 id 或本地新文件下标）；
// previewUrl 存在时渲染缩略图（图片附件），否则渲染文件名 chip
export interface EditAttachmentItem {
  key: string
  name: string
  previewUrl?: string
}

// 只读元信息：从底部官方输入框当前显示抄来，仅作上下文提示
export interface EditMeta {
  permission: string
  model: string
}

export interface EditPanelProps {
  stage: EditStage
  // 主按钮文案随 editSubmitsImmediately 分叉（发送 / 仅回填），由装配侧决定
  submitLabel: string
  meta: EditMeta
  attachments: EditAttachmentItem[]
  // 模型下拉：modelLabel 为空表示官方目录服务不可用，退回 meta.model 的只读展示；
  // 菜单节点由装配侧用 model-menu.ts 渲染后传进来（本组件不持状态）
  modelLabel: string
  // 思考强度：与官方 chip 同构——模型名用常规色，档位用更淡的 caption 色，
  // 两者之间不加分隔符；provider default 时由本组件回落成「Default」
  modelEffort: string
  modelOpen: boolean
  modelBusy: boolean
  modelNodes: import('react').ReactNode
  onToggleModel(): void
  onChange(text: string): void
  onSubmit(): void
  onClose(): void
  onAddFiles(files: File[]): void
  onRemoveAttachment(key: string): void
}

export interface EditFlowApi {
  EditIcon: () => import('react').ReactNode
  EditPanel: (props: EditPanelProps) => import('react').ReactNode
}

export function buildEditFlow(React: ReactApi, t: Translate): EditFlowApi {
  // 铅笔图标：与 UndoIcon/CopyIcon 同一套内联规格（16 声明尺寸、stroke 1.4、
  // currentColor 随按钮文字色），保证动作行三个按钮的视觉重量一致
  function EditIcon() {
    return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: 'M10.6 2.9 13.1 5.4 5.8 12.7 3 13.4l.7-2.8 6.9-7.7z' }),
      React.createElement('path', { d: 'M9.4 4.1 11.9 6.6' })
    )
  }

  function EditPanel(props: EditPanelProps): import('react').ReactNode {
    const stage = props.stage
    const text = stage.stage === 'editing' || stage.stage === 'error' ? stage.text : ''
    if (stage.stage === 'idle') return null

    const error = stage.stage === 'error' ? stage.message : ''
    const busy = stage.stage === 'submitting'
    const empty = text.trim() === '' && props.attachments.length === 0

    const intake = (list: FileList | null | undefined) => {
      if (!list) return
      const files: File[] = []
      for (const file of Array.from(list)) files.push(file)
      if (files.length) props.onAddFiles(files)
    }

    return React.createElement('div', {
      className: 'dsh-recall-edit dsh-recall-composer',
      onPaste: (event: import('react').ClipboardEvent<HTMLDivElement>) => {
        const files = event.clipboardData ? event.clipboardData.files : null
        if (!files || files.length === 0) return
        event.preventDefault()
        intake(files)
      },
      onDragOver: (event: import('react').DragEvent<HTMLDivElement>) => {
        if (event.dataTransfer && Array.from(event.dataTransfer.types).indexOf('Files') >= 0) event.preventDefault()
      },
      onDrop: (event: import('react').DragEvent<HTMLDivElement>) => {
        const files = event.dataTransfer ? event.dataTransfer.files : null
        if (!files || files.length === 0) return
        event.preventDefault()
        intake(files)
      },
    },
      React.createElement('textarea', {
        className: 'dsh-recall-edit-area',
        value: text,
        // 行数按内容估算（这里不能挂 hooks：EditPanel 是以普通函数被父组件
        // 调用的，hook 会记到父组件身上导致数量不一致）
        rows: Math.min(8, Math.max(2, text.split('\n').length + 1)),
        autoFocus: true,
        disabled: busy,
        placeholder: t('edit.placeholder'),
        'aria-label': t('edit.placeholder'),
        onChange: (e: import('react').ChangeEvent<HTMLTextAreaElement>) => props.onChange(e.target.value),
        // Enter 发送、Shift+Enter 换行：与官方 composer 同一套键盘语义；输入法
        // 组合期间的 Enter 是在选词，必须放行
        onKeyDown: (e: import('react').KeyboardEvent<HTMLTextAreaElement>) => {
          if (e.key !== 'Enter' || e.shiftKey) return
          if (e.nativeEvent && (e.nativeEvent as KeyboardEvent).isComposing) return
          e.preventDefault()
          if (!empty && !busy) props.onSubmit()
        },
      }),
      props.attachments.length > 0
        ? React.createElement('div', { className: 'dsh-recall-composer-attachments' },
            props.attachments.map((item) => item.previewUrl !== undefined
              // 图片：56px 缩略图 + 角标删除键（文件名走 title/alt）
              ? React.createElement('span', { className: 'dsh-recall-composer-attach dsh-recall-composer-attach-image', key: item.key },
                  React.createElement('img', { className: 'dsh-recall-composer-thumb', src: item.previewUrl, alt: item.name, title: item.name }),
                  React.createElement('button', {
                    type: 'button',
                    className: 'dsh-recall-composer-attach-x dsh-recall-composer-attach-x-badge',
                    'aria-label': t('edit.attachment.remove', { name: item.name }),
                    onClick: () => props.onRemoveAttachment(item.key),
                  }, '×')
                )
              : React.createElement('span', { className: 'dsh-recall-composer-attach', key: item.key },
                  React.createElement('span', { className: 'dsh-recall-composer-attach-name', title: item.name }, item.name),
                  React.createElement('button', {
                    type: 'button',
                    className: 'dsh-recall-composer-attach-x',
                    'aria-label': t('edit.attachment.remove', { name: item.name }),
                    onClick: () => props.onRemoveAttachment(item.key),
                  }, '×')
                ))
          )
        : null,
      error !== '' ? React.createElement('div', { className: 'dsh-recall-edit-error', role: 'alert' }, error) : null,
      React.createElement('div', { className: 'dsh-recall-composer-foot' },
        // label 包住隐藏的 file input：原生点击即开选择框，不需要 ref 与命令式
        // 点击；input 用视觉隐藏而不是 display:none，键盘仍能 Tab 到它
        React.createElement('label', {
          className: 'dsh-recall-composer-add',
          title: t('edit.attachment.add'),
          'aria-label': t('edit.attachment.add'),
          'aria-disabled': busy ? 'true' : undefined,
        },
          React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
            React.createElement('path', { d: 'M8 3.2v9.6M3.2 8h9.6' })
          ),
          React.createElement('input', {
            className: 'dsh-recall-composer-file',
            type: 'file',
            multiple: true,
            disabled: busy,
            onChange: (e: import('react').ChangeEvent<HTMLInputElement>) => { intake(e.target.files) },
          })
        ),
        props.meta.permission !== ''
          ? React.createElement('span', { className: 'dsh-recall-composer-chip' }, props.meta.permission)
          : null,
        // 模型：目录服务可用时是下拉（选择走官方 selectModel，同步到底部 chip），
        // 不可用则退回只读 chip（值抄自底部输入框）
        props.modelLabel !== ''
          ? React.createElement('span', { className: 'dsh-recall-composer-model' },
              React.createElement('button', {
                type: 'button',
                // 与官方 trigger 同构：模型名 + 淡色档位 + 尾部 chevron（展开时翻转）
                className: 'dsh-recall-composer-chip dsh-recall-composer-chip-btn' + (props.modelOpen ? ' is-open' : ''),
                'aria-haspopup': 'menu',
                'aria-expanded': props.modelOpen,
                disabled: props.modelBusy,
                onClick: props.onToggleModel,
              },
                React.createElement('span', { className: 'dsh-recall-composer-chip-name' }, props.modelLabel),
                React.createElement('span', { className: 'dsh-recall-composer-chip-effort' },
                  props.modelEffort !== '' ? props.modelEffort : t('edit.model.providerDefault')),
                React.createElement('span', { className: 'dsh-recall-composer-chip-chevron' },
                  React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                    React.createElement('path', { d: 'M4 6.2l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' })
                  )
                )
              ),
              props.modelNodes
            )
          : (props.meta.model !== ''
              ? React.createElement('span', { className: 'dsh-recall-composer-chip' }, props.meta.model)
              : null),
        // 仅做「这是编辑而非新消息」的说明；细节（新建会话/归档）由提示承担
        React.createElement('span', { className: 'dsh-recall-composer-hint' },
          busy ? t('edit.submitting') : (error !== '' ? t('edit.official.retry') : t('edit.official.hint'))
        ),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-recall-composer-send',
          'aria-label': busy ? t('edit.submitting') : (error !== '' ? t('edit.retry') : props.submitLabel),
          title: busy ? t('edit.submitting') : (error !== '' ? t('edit.retry') : props.submitLabel),
          disabled: busy || (error === '' && empty),
          onClick: props.onSubmit,
        }, busy ? React.createElement('span', { className: 'dsh-recall-composer-dot' }) : React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
          React.createElement('path', {
            d: 'M8.31 0.98c.36.07.67.22.95.45.22.18.47.43.72.68l4.73 4.73-1.42 1.41L9 3.96v11.08H7V3.96L2.71 8.25 1.29 6.83l4.73-4.73c.25-.25.49-.49.72-.68.24-.19.55-.39.95-.45.21-.03.41-.02.62.01z',
            fill: 'currentColor',
          })
        ))
      )
    )
  }

  return { EditIcon, EditPanel }
}
