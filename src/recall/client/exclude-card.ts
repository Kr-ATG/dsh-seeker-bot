/**
 * dsh-recall-plugin — client 排除配置卡片（S1 拆分）
 *
 * 从 settings-cards.ts 按域拆出的「排除配置」分区：exclude 文件列表拉取 +
 * 单个文件的编辑卡片（draft/baseline 分离、快捷追加建议）。纯移动，零行为
 * 变化；依赖注入 React 与 util（仅 api）。拆分动机同 snapshot-manager。
 */

import type { ReactApi, UtilApi } from './util.js'
import { useAutoDismissMessage } from './util.js'
import type { ExcludeGetResponse, ExcludeSetResponse } from '../types/api.js'

// 常用排除建议：一键追加的高频项，覆盖构建产物/日志/密钥三类最常见诉求；
// 已存在的条目自动从候选里滤掉，避免重复点击堆叠。
const EXCLUDE_SUGGESTIONS = ['dist/', 'build/', 'out/', 'coverage/', '*.log', '.env']

export function buildExcludeCards(React: ReactApi, util: UtilApi): { ExcludeFilesSection: () => import('react').ReactNode } {
  const { api, t } = util

  // 单个 exclude 文件的编辑卡片。draft/baseline 分离实现「未保存修改」判定
  // （textarea 所见即将保存的原文，不偷偷规范化）；key=file.path 挂载，
  // 父级重载列表时整卡重建、草稿随之丢弃。
  function ExcludeCard(props: { file: { path: string; home: boolean; content?: string | null } }) {
    const file = props.file
    const [draft, setDraft] = React.useState(file.content || '')
    const [baseline, setBaseline] = React.useState(file.content || '')
    const [quick, setQuick] = React.useState('')
    const [state, setState] = React.useState({ busy: false, message: '', error: false })
    // V3：成功消息 4s 后自动消退（错误常驻），共享 hook 见 util.ts
    useAutoDismissMessage(React, state, setState)
    const dirty = draft !== baseline

    // 追加一条模式：先补齐行尾换行再拼接，保证每条模式独占一行
    // （exclude.txt 按行解析，两条挤一行会双双失效）
    function appendPattern(pattern: string): void {
      setDraft((d: string) => (d && !d.endsWith('\n') ? d + '\n' : d) + pattern + '\n')
    }

    // 局部量改名 pattern（不叫 t）：与词表函数 t 撞名会让「这个 t 是取词」
    // 的读法在函数里失效（同名遮蔽是纯噪音，改名零成本）
    function addQuick() {
      const pattern = quick.trim()
      if (!pattern) return
      appendPattern(pattern)
      setQuick('')
    }

    function save(): void {
      if (state.busy || !dirty) return
      setState({ busy: true, message: t('exclude.msg.saving'), error: false })
      api<ExcludeSetResponse>('exclude-set', { path: file.path, content: draft }).then((res) => {
        if (res && res.ok) {
          setBaseline(draft)
          setState({ busy: false, message: t('exclude.msg.saved'), error: false })
        } else {
          setState({ busy: false, message: (res && ((res as { message?: string }).message || (res as { error?: string }).error)) || t('exclude.msg.saveFailed'), error: true })
        }
      }).catch((error) => {
        // 保存异常落错误态（与响应 ok=false 同显式面）
        setState({ busy: false, message: String(error), error: true })
      })
    }

    function discard() {
      if (state.busy) return
      setDraft(baseline)
      setState({ busy: false, message: '', error: false })
    }

    const draftLines = draft.split('\n').map((l) => l.trim())
    const suggestions = EXCLUDE_SUGGESTIONS.filter((s) => draftLines.indexOf(s) < 0)

    return React.createElement('div', { className: 'dsh-recall-ex-card' },
      // 不渲染「快照排除项」内标题（与折叠头「排除配置（exclude.txt）」语义重复）；
      // 多文件场景（降级工作区）靠紧随说明的存储路径行区分，标题文本本就相同、
      // 不承担区分职责。路径从长句中抽出独立等宽行——Windows 长路径内联在句号
      // 前会撑出断裂换行（实测丑），独立行 break-all 整齐折行。
      React.createElement('div', { className: 'dsh-recall-ex-note' },
        file.home
          ? t('exclude.note.home')
          : t('exclude.note.fallback')
      ),
      React.createElement('div', { className: 'dsh-recall-ex-path' }, t('exclude.path', { path: file.path })),
      React.createElement('div', { className: 'dsh-recall-ex-note' }, t('exclude.syntax')),
      React.createElement('textarea', {
        className: 'dsh-recall-ex-area',
        'aria-label': t('exclude.area.aria'),
        value: draft,
        spellCheck: false,
        onChange: (e: import('react').ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)
      }),
      React.createElement('div', { className: 'dsh-recall-ex-quick' },
        React.createElement('input', {
          className: 'dsh-recall-ex-input',
          value: quick,
          placeholder: t('exclude.quick.placeholder'),
          'aria-label': t('exclude.quick.aria'),
          onChange: (e: import('react').ChangeEvent<HTMLInputElement>) => setQuick(e.target.value),
          onKeyDown: (e: import('react').KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); addQuick() } }
        }),
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: addQuick }, t('exclude.add')),
        ...suggestions.map((s) => React.createElement('button', {
          key: 'chip-' + s,
          type: 'button',
          className: 'dsh-recall-ex-chip',
          title: t('exclude.chip.title', { pattern: s }),
          onClick: () => appendPattern(s)
        }, s))
      ),
      React.createElement('div', { className: 'dsh-recall-panel-actions' },
        state.message ? React.createElement('span', { role: 'status', 'aria-live': 'polite', className: 'dsh-recall-ex-status' + (state.error ? ' dsh-recall-ex-status-error' : ' dsh-recall-ex-status-success') }, (state.error ? t('common.errorPrefix') : '') + state.message) : null,
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn', disabled: !dirty || state.busy, onClick: discard }, t('common.discard')),
        // 保存升主色实心（与配置表单同一约定：每卡唯一主动作，对齐官方插件卡
        // footer 的 discard 幽灵 + save 实心组合）
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn dsh-recall-btn-primary', disabled: !dirty || state.busy, onClick: save }, t('common.save'))
      )
    )
  }

  // 排除配置分区：拉取 Host 枚举的 exclude 文件列表（home 存储通常合并为一条，
  // 降级工作区各一条）。折叠展开时由设置外壳保持挂载，本地草稿不丢失。
  function ExcludeFilesSection(): import('react').ReactNode {
    const [files, setFiles] = React.useState<Array<{ path: string; home: boolean; roots: string[]; content: string }> | null>(null)
    const [error, setError] = React.useState('')

    function load(): void {
      api<ExcludeGetResponse>('exclude-get', {}).then((res) => {
        if (res && res.ok) { setFiles(res.files || []); setError(''); return }
        if (res && res.unsupported) { setError(t('exclude.unsupported')); return }
        setError((res && ((res as { message?: string }).message || (res as { error?: string }).error)) || t('exclude.loadFailed'))
      }).catch((e) => setError(String(e))) // 读取异常落错误态（含重试按钮）
    }

    React.useEffect(() => { load() }, [])

    if (error) {
      return React.createElement('div', { className: 'dsh-recall-ex-card' },
        React.createElement('div', { className: 'dsh-recall-ex-note' }, error),
        React.createElement('div', { className: 'dsh-recall-panel-actions' },
          React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: load }, t('common.retry'))
        )
      )
    }
    if (files === null) {
      return React.createElement('div', { className: 'dsh-recall-ex-note' }, t('exclude.loading'))
    }
    if (!files.length) {
      return React.createElement('div', { className: 'dsh-recall-ex-note' }, t('exclude.empty'))
    }
    return React.createElement('div', { className: 'dsh-recall-ex-card' },
      ...files.map((f) => React.createElement(ExcludeCard, { key: f.path, file: f }))
    )
  }

  return { ExcludeFilesSection }
}