/**
 * dsh-seeker-bot — 右栏 Bot 面板的纯呈现层。
 *
 * 形态对齐 Bot 控制台原型：浏览器 → 子智能体 → 当前 Bot → 产出物 → 文件，
 * 五张卡片竖排。只渲染「看」的内容，不提供输入转发；浏览器卡点击画面即由
 * KrEchoViewport 负责切到 ego。
 *
 * 组件本身不取数（hooks 在 panel.tsx 的连接层），测试可以用 react/jsx-runtime
 * 桩直接跑。
 */

import type { ReactElement } from 'react'
import { KrEchoViewport } from '../echo-viewport/KrEchoViewport.tsx'
import type { SubagentCatalogView } from '../kr-chat/subagent-catalog.ts'
import type { OutputsView } from '../kr-chat/outputs.ts'
import type { BotRecord } from './model.ts'
import type { BotTreeEntry } from './api.ts'

export interface BotPanelViewProps {
  readonly sessionId: string | null
  readonly catalog: SubagentCatalogView
  readonly outputs: OutputsView
  readonly bot: BotRecord | null
  readonly tree: readonly BotTreeEntry[]
  readonly onOpenSubagent?: (row: SubagentCatalogView['rows'][number]) => void
  readonly onOpenOutput?: (item: OutputsView['items'][number]) => void
  readonly onOpenEgo?: () => void
}

function statusText(bot: BotRecord): string {
  if (bot.status === 'working') return '工作中'
  if (bot.status === 'needs-you') return '等你确认'
  if (bot.status === 'unread') return '有新回复'
  return bot.paused === true ? '已暂停' : '待命'
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60) return sec + 's'
  const min = Math.floor(sec / 60)
  return min + 'm ' + (sec % 60) + 's'
}

function outputGroups(outputs: OutputsView): Array<{ kind: string; label: string; items: OutputsView['items'] }> {
  const order = ['page', 'doc', 'sheet', 'image', 'video', 'audio', 'pdf', 'slide', 'archive', 'other']
  const labels: Record<string, string> = {
    page: '网页', doc: '文档', sheet: '表格', image: '图片', video: '视频',
    audio: '音频', pdf: 'PDF', slide: '演示', archive: '压缩包', other: '其它',
  }
  const groups: Array<{ kind: string; label: string; items: OutputsView['items'] }> = []
  for (const kind of order) {
    const items = outputs.items.filter((item) => item.kind === kind)
    if (items.length > 0) groups.push({ kind, label: labels[kind] ?? kind, items })
  }
  return groups
}

function fileRows(entries: readonly BotTreeEntry[], depth = 0): ReactElement[] {
  const rows: ReactElement[] = []
  for (const entry of entries) {
    rows.push(
      <div className="skb-file-row" key={entry.path} data-depth={depth} title={entry.path}>
        <span className="skb-file-icon" data-type={entry.type} aria-hidden>{entry.type === 'dir' ? '▸' : '·'}</span>
        <span className="skb-file-name">{entry.name}</span>
        {entry.type === 'file' && typeof entry.size === 'number' && entry.size > 0 && (
          <span className="skb-file-size">{entry.size > 1024 * 1024 ? (entry.size / 1024 / 1024).toFixed(1) + 'M' : Math.max(1, Math.round(entry.size / 1024)) + 'K'}</span>
        )}
      </div>,
    )
    if (entry.type === 'dir' && Array.isArray(entry.children) && entry.children.length > 0) {
      rows.push(...fileRows(entry.children, depth + 1))
    }
  }
  return rows
}

export function BotPanelView({
  sessionId, catalog, outputs, bot = null, tree = [], onOpenSubagent, onOpenOutput, onOpenEgo,
}: BotPanelViewProps): ReactElement {
  const groups = outputGroups(outputs)
  const visibleGroups = groups.slice(0, 3)
  const visibleOutputCount = visibleGroups.reduce((sum, group) => sum + Math.min(3, group.items.length), 0)
  const totalOutputs = outputs.items.length
  const actions = catalog.rows.length + totalOutputs

  return (
    <div className="skb-bot-panel">
      <section className="skb-card" data-kind="browser">
        <header className="skb-card__head">
          <span className="skb-card__title">浏览器</span>
          <span className="skb-card__meta">ego-lite · 5fps</span>
          <button type="button" className="skb-card__action" onClick={() => { onOpenEgo?.() }}>进入 ego</button>
        </header>
        <div className="skb-card__viewport">
          <KrEchoViewport sessionId={sessionId} browserOn strictWorkspace />
        </div>
      </section>

      {catalog.rows.length > 0 && (
        <section className="skb-card" data-kind="subagents">
          <header className="skb-card__head">
            <span className="skb-card__title">子智能体</span>
            <span className="skb-card__meta">{catalog.rows.length} 个 · {catalog.runningCount > 0 ? catalog.runningCount + ' 个进行中' : '全部结束'}</span>
          </header>
          <div className="skb-card__list">
            {catalog.rows.map((row) => (
              <button type="button" className="skb-row-line" key={row.id} title={row.label + ' · 点击跳转'} onClick={() => { onOpenSubagent?.(row) }}>
                <span className="skb-row-line__mark" data-running={row.running ? 'true' : undefined}>{row.running ? '◌' : '✓'}</span>
                <span className="skb-row-line__name">{row.label}</span>
                {typeof row.elapsedMs === 'number' && <span className="skb-row-line__meta">{formatDuration(row.elapsedMs)}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {bot !== null && (
        <section className="skb-card" data-kind="bot">
          <header className="skb-card__head">
            <span className="skb-card__title">当前 Bot</span>
          </header>
          <div className="skb-bot-card">
            <span className="skb-bot-card__avatar" style={{ background: bot.avatar?.color ?? '#0f1115' }} aria-hidden>
              {bot.name.slice(0, 1)}
            </span>
            <div className="skb-bot-card__meta">
              <div className="skb-bot-card__name">{bot.name}</div>
              <div className="skb-bot-card__status">{statusText(bot)}</div>
            </div>
            <span className="skb-bot-card__icon" title="分支">⑂</span>
            <span className="skb-bot-card__icon" title="邮件">✉</span>
            <span className="skb-bot-card__icon" title="设置">⚙</span>
          </div>
          <button type="button" className="skb-card__footer" disabled={actions === 0}>
            <span>{actions === 0 ? '暂无动作' : actions + ' 个动作'}</span>
            <span>展开时间线</span>
          </button>
        </section>
      )}

      {totalOutputs > 0 && (
        <section className="skb-card" data-kind="outputs">
          <header className="skb-card__head">
            <span className="skb-card__title">产出物</span>
            <span className="skb-card__meta">{totalOutputs} 项 · {groups.length} 类</span>
          </header>
          <div className="skb-card__list">
            {visibleGroups.map((group) => (
              <div className="skb-output-group" key={group.kind}>
                <div className="skb-output-group__head">
                  <span>{group.label}</span>
                  <span>{group.items.length}</span>
                </div>
                {group.items.slice(0, 3).map((item) => (
                  <button type="button" className="skb-row-line" key={item.path} title={item.path} onClick={() => { onOpenOutput?.(item) }}>
                    <span className="skb-row-line__mark">▤</span>
                    <span className="skb-row-line__name">{item.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          {totalOutputs > visibleOutputCount && (
            <button type="button" className="skb-card__footer" disabled>
              <span>展开其余 {totalOutputs - visibleOutputCount} 条</span>
              <span>⌄</span>
            </button>
          )}
        </section>
      )}

      {tree.length > 0 && (
        <section className="skb-card" data-kind="files">
          <header className="skb-card__head">
            <span className="skb-card__title">文件</span>
            <span className="skb-card__meta">workspace</span>
          </header>
          <div className="skb-card__list skb-file-tree">{fileRows(tree)}</div>
        </section>
      )}
    </div>
  )
}
