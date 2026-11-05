/**
 * Personal Agent (Bot 模式) — 一键全景截图弹窗。
 *
 * 功能：
 *   1. 范围选择：全部消息 / 最近 50 条 / 最近 20 条 / 最近 10 条 / 自选起止区间（从什么消息到什么消息）；
 *   2. 消息排除编辑：可在弹窗内直接点选排除任意单条/多条消息，不满意直接删；
 *   3. 语音通话记录：完整支持通话折叠条（call-segment）、通话卡片（call）与通话转写消息；
 *   4. 画质与尺寸联动：1200/1440/1600/1920/自定义宽度，修改尺寸后保证按最新尺寸复制；
 *   5. 最高 z-index 保证在 Bot 模式下点击立即呈现在最顶层。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { render, reveal, save, type RenderResult } from '../../shot/api.ts'
import { qualityScale, type ShotQuality, WIDTH_MIN, WIDTH_MAX } from '../../../shot/presets.ts'
import { cls, ensureStyles } from '../../shot/styles.ts'
import { usePersonal } from '../store.tsx'
import { buildPersonalAgentHtml } from './builder.ts'
import type { Message } from '../types.ts'

export interface PaShotModalProps {
  open: boolean
  onClose: () => void
}

type ShotRange = 'all' | 'recent50' | 'recent20' | 'recent10' | 'custom'

const RANGE_LABELS: Record<ShotRange, string> = {
  all: '全部消息',
  recent50: '最近 50 条',
  recent20: '最近 20 条',
  recent10: '最近 10 条',
  custom: '起止区间',
}

const PA_WIDTH_PRESETS = [1200, 1440, 1600, 1920] as const
const PA_WIDTH_LABELS: Record<number, string> = {
  1200: '1200 紧凑',
  1440: '1440 标准',
  1600: '1600 宽屏',
  1920: '1920 全宽',
}

function messagePreview(m: Message, idx: number): string {
  const sender = m.role === 'user' ? '你' : (m.senderName ?? 'Bot')
  let text = ''
  for (const b of m.blocks) {
    if (b.type === 'text') text += b.text + ' '
    else if (b.type === 'call-segment') text += '📞 [语音通话] '
    else if (b.type === 'call') text += '📞 [通话记录] '
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) text = '(无文本)'
  const time = m.at ? new Date(m.at).toTimeString().slice(0, 5) : ''
  return '#' + (idx + 1) + ' [' + sender + ' ' + time + '] ' + (text.length > 24 ? text.slice(0, 24) + '…' : text)
}

export function PaShotModal({ open, onClose }: PaShotModalProps): JSX.Element | null {
  const { state, activeBot, activeRoom } = usePersonal()

  // 当前会话消息列表（按时间正序）
  const conversationMessages = useMemo(() => {
    return state.messages.filter(m => {
      if (activeRoom !== null) return m.roomId === activeRoom.id
      return m.botId === activeBot.id && !m.roomId
    })
  }, [state.messages, activeBot.id, activeRoom])

  const isDark = typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme')
  const [theme, setTheme] = useState<'light' | 'dark'>(isDark ? 'dark' : 'light')
  const [range, setRange] = useState<ShotRange>('all')
  const [width, setWidth] = useState<number>(1440)
  const [widthDraft, setWidthDraft] = useState<string>('1440')
  const [quality, setQuality] = useState<ShotQuality>('1080p')

  // 起止区间选择（基于消息 ID）
  const [startId, setStartId] = useState<string>('')
  const [endId, setEndId] = useState<string>('')

  // 用户手动排除/删除的消息 ID 列表
  const [excludedIds, setExcludedIds] = useState<string[]>([])
  // 是否处于消息排除/编辑面板
  const [excludePanelOpen, setExcludePanelOpen] = useState(false)

  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RenderResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  const tokenRef = useRef(0)
  const pendingPromiseRef = useRef<Promise<RenderResult | null> | null>(null)
  const latestResultRef = useRef<RenderResult | null>(null)
  latestResultRef.current = result

  ensureStyles()

  // 打开弹窗时初始化起止消息为当前全量首尾
  useEffect(() => {
    if (open && conversationMessages.length > 0) {
      setStartId(conversationMessages[0].id)
      setEndId(conversationMessages[conversationMessages.length - 1].id)
    }
  }, [open, conversationMessages])

  const scale = qualityScale(quality, width)
  const displayWidth = result ? Math.round(result.width / scale) : width

  // 触发渲染
  const run = useCallback((overrideWidth?: number): Promise<RenderResult | null> => {
    const token = tokenRef.current + 1
    tokenRef.current = token
    const effectiveWidth = typeof overrideWidth === 'number' ? overrideWidth : width

    setBusy(true)
    setError(null)
    setSavedPath(null)
    setToast(null)

    const html = buildPersonalAgentHtml({
      bots: state.bots,
      groups: state.groups,
      rooms: state.rooms,
      messages: state.messages,
      activeBot,
      activeRoom,
      theme,
      width: effectiveWidth,
      range,
      startId: range === 'custom' ? startId : undefined,
      endId: range === 'custom' ? endId : undefined,
      excludedIds,
    })

    const p = render({
      messages: [],
      theme,
      html,
      width: effectiveWidth,
      quality,
    })
      .then((next) => {
        if (tokenRef.current !== token) return null
        setResult(next)
        latestResultRef.current = next
        return next
      })
      .catch((cause: unknown) => {
        if (tokenRef.current !== token) return null
        setResult(null)
        latestResultRef.current = null
        setError(cause instanceof Error ? cause.message : String(cause))
        return null
      })
      .finally(() => {
        if (tokenRef.current !== token) return
        setBusy(false)
        pendingPromiseRef.current = null
      })

    pendingPromiseRef.current = p
    return p
  }, [state.bots, state.groups, state.rooms, state.messages, activeBot, activeRoom, theme, width, range, startId, endId, excludedIds, quality])

  // 打开即渲染，选项变化时重渲染
  useEffect(() => {
    if (open) {
      void run()
    }
  }, [open, run])

  // 自定义宽度输入防抖：400ms 自动应用生效
  useEffect(() => {
    const parsed = parseInt(widthDraft, 10)
    if (!Number.isNaN(parsed) && parsed >= WIDTH_MIN && parsed <= WIDTH_MAX && parsed !== width) {
      const timer = window.setTimeout(() => {
        setWidth(parsed)
      }, 400)
      return () => { window.clearTimeout(timer) }
    }
  }, [widthDraft, width])

  // 确保拿到最新修改尺寸后的结果（绝不复制陈旧旧图）
  const ensureLatestResult = useCallback(async (): Promise<RenderResult | null> => {
    const parsedDraft = parseInt(widthDraft, 10)
    let p = pendingPromiseRef.current
    if (!Number.isNaN(parsedDraft)) {
      const clamped = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, parsedDraft))
      if (clamped !== width) {
        setWidth(clamped)
        p = run(clamped)
      }
    }
    if (p !== null || busy) {
      setToast('正在按最新尺寸生成…')
      const targetP = p ?? pendingPromiseRef.current
      if (targetP !== null) {
        const next = await targetP
        if (next !== null) return next
      }
    }
    return latestResultRef.current ?? result
  }, [widthDraft, width, run, busy, result])

  const onCopy = useCallback((): void => {
    void (async () => {
      const target = await ensureLatestResult()
      if (target === null) return
      try {
        const blob = await (await fetch(target.imageUrl, { cache: 'no-store' })).blob()
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        setToast(`图片已复制到剪贴板 (${target.width} × ${target.height} px)`)
      } catch {
        setError('复制失败：浏览器拒绝了剪贴板写入，请改用「下载 PNG」')
      }
    })()
  }, [ensureLatestResult])

  const onSave = useCallback((): void => {
    void (async () => {
      const target = await ensureLatestResult()
      if (target === null) return
      save(target.id)
        .then((saved) => { setSavedPath(saved.path); setToast('已保存到本地') })
        .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)) })
    })()
  }, [ensureLatestResult])

  const onDownload = useCallback((event: { preventDefault: () => void }): void => {
    event.preventDefault()
    void (async () => {
      const target = await ensureLatestResult()
      if (target === null) return
      const a = document.createElement('a')
      a.href = target.imageUrl
      a.download = `seeker-bot-screenshot-${target.width}x${target.height}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setToast(`已开始下载 (${target.width} × ${target.height} px)`)
    })()
  }, [ensureLatestResult])

  // 切换某条消息的排除状态
  const toggleExclude = (id: string): void => {
    setExcludedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  };

  // Esc 关闭
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const meta = savedPath !== null
    ? savedPath
    : result !== null
      ? `${result.width} × ${result.height} px · ${(result.bytes / 1024).toFixed(0)} KB · ${conversationMessages.length} 条消息`
      : ''

  return createPortal(
    <>
      <div className={cls.mask} data-anim="in" aria-hidden="true" onClick={onClose} style={{ zIndex: 2147483640 }} />
      <div className={cls.panel} data-anim="in" role="dialog" aria-modal="true" aria-label="Bot 模式一键截图" style={{ zIndex: 2147483641 }}>
        <div className={cls.head}>
          <span className={cls.title}>Bot 模式一键截图（左侧名册 + 右侧会话）</span>
          <button type="button" className={cls.close} aria-label="关闭" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* 顶部控制栏 */}
        <div className={cls.bar}>
          <div className={cls.group}>
            <span className={cls.label}>消息范围</span>
            <div className={cls.seg} role="group" aria-label="消息范围">
              {(['all', 'recent50', 'recent20', 'recent10', 'custom'] as const).map(item => (
                <button
                  key={item}
                  type="button"
                  className={item === range ? `${cls.segItem} ${cls.segItemOn}` : cls.segItem}
                  onClick={() => setRange(item)}
                >
                  {RANGE_LABELS[item]}
                </button>
              ))}
            </div>
          </div>

          <div className={cls.group}>
            <span className={cls.label}>排版宽度</span>
            <div className={cls.seg} role="group" aria-label="排版宽度">
              {PA_WIDTH_PRESETS.map(w => (
                <button
                  key={w}
                  type="button"
                  className={width === w ? `${cls.segItem} ${cls.segItemOn}` : cls.segItem}
                  onClick={() => { setWidth(w); setWidthDraft(String(w)) }}
                >
                  {PA_WIDTH_LABELS[w]}
                </button>
              ))}
            </div>
            <div className={cls.widthBox} title={`自定义宽度 (${WIDTH_MIN}~${WIDTH_MAX} px)`}>
              <input
                type="number"
                className={cls.widthInput}
                value={widthDraft}
                min={WIDTH_MIN}
                max={WIDTH_MAX}
                step={10}
                aria-label="自定义宽度"
                onChange={(e) => setWidthDraft(e.target.value)}
                onBlur={() => {
                  const parsed = parseInt(widthDraft, 10)
                  if (!Number.isNaN(parsed)) {
                    const nextW = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, parsed))
                    setWidth(nextW)
                    setWidthDraft(String(nextW))
                  } else {
                    setWidthDraft(String(width))
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              />
              <span className={cls.unit}>px</span>
            </div>
          </div>

          <div className={cls.group}>
            <span className={cls.label}>画质</span>
            <div className={cls.seg} role="group" aria-label="输出画质">
              {(['1080p', '2k', '4k'] as const).map(q => (
                <button
                  key={q}
                  type="button"
                  className={quality === q ? `${cls.segItem} ${cls.segItemOn}` : cls.segItem}
                  onClick={() => setQuality(q)}
                >
                  {q.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className={cls.group}>
            <span className={cls.label}>主题</span>
            <div className={cls.seg} role="group" aria-label="截图主题">
              {(['light', 'dark'] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  className={theme === t ? `${cls.segItem} ${cls.segItemOn}` : cls.segItem}
                  onClick={() => setTheme(t)}
                >
                  {t === 'light' ? '浅色' : '深色'}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            className={cls.action}
            style={{ marginLeft: 'auto', background: excludePanelOpen ? 'var(--dsw-alias-state-business-primary, #4176e6)' : undefined, color: excludePanelOpen ? '#fff' : undefined }}
            onClick={() => setExcludePanelOpen(!excludePanelOpen)}
          >
            {excludePanelOpen ? '收起排除面板' : `排除/删除消息 ${excludedIds.length > 0 ? `(${excludedIds.length}条已删)` : ''}`}
          </button>
        </div>

        {/* 当选择「自选起止区间」时，展开起止消息精确选择行 */}
        {range === 'custom' && (
          <div className={cls.bar} style={{ background: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.03))', gap: '12px' }}>
            <span className={cls.label}>起始消息</span>
            <select
              className={cls.select}
              style={{ maxWidth: '320px', flex: '1' }}
              value={startId}
              onChange={(e) => setStartId(e.target.value)}
            >
              {conversationMessages.map((m, idx) => (
                <option key={m.id} value={m.id}>{messagePreview(m, idx)}</option>
              ))}
            </select>
            <span style={{ color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '13px' }}>➔ 至 ➔</span>
            <span className={cls.label}>截止消息</span>
            <select
              className={cls.select}
              style={{ maxWidth: '320px', flex: '1' }}
              value={endId}
              onChange={(e) => setEndId(e.target.value)}
            >
              {conversationMessages.map((m, idx) => (
                <option key={m.id} value={m.id}>{messagePreview(m, idx)}</option>
              ))}
            </select>
          </div>
        )}

        {/* 消息排除/删除面板（可直接点选想删掉的消息） */}
        {excludePanelOpen && (
          <div style={{ maxHeight: '220px', overflowY: 'auto', borderBottom: '1px solid var(--dsw-alias-border-l1, #eee)', padding: '10px 16px', background: 'var(--tsh-control-surface)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)' }}>
              <span>点击每条消息右侧的按钮可将其从截图中排除（删除敏感或多余消息）：</span>
              {excludedIds.length > 0 && (
                <button type="button" className={cls.action} style={{ height: '24px', padding: '0 8px', fontSize: '11px' }} onClick={() => setExcludedIds([])}>
                  恢复全部排除
                </button>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {conversationMessages.map((m, idx) => {
                const isExcluded = excludedIds.includes(m.id)
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderRadius: '6px', background: isExcluded ? 'rgba(239, 68, 68, 0.08)' : 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.02))', opacity: isExcluded ? 0.55 : 1 }}>
                    <span style={{ fontSize: '12px', textDecoration: isExcluded ? 'line-through' : undefined, color: isExcluded ? 'var(--dsw-alias-state-error-primary, #e5484d)' : 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '10px' }}>
                      {messagePreview(m, idx)}
                    </span>
                    <button
                      type="button"
                      style={{ flex: 'none', border: 'none', background: 'none', cursor: 'pointer', fontSize: '12px', color: isExcluded ? 'var(--dsw-alias-state-business-primary, #4176e6)' : 'var(--dsw-alias-state-error-primary, #e5484d)', padding: '2px 6px' }}
                      onClick={() => toggleExclude(m.id)}
                    >
                      {isExcluded ? '↺ 恢复' : '🗑️ 排除' }
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className={cls.stage}>
          <div className={cls.canvas}>
            {busy && (
              <div className={cls.hint}>
                <span className={cls.spinner} />
                <span>正在渲染高清快照…</span>
              </div>
            )}
            {!busy && error !== null && <div className={cls.error}>{error}</div>}
            {!busy && error === null && result !== null && (
              <img
                className={cls.img}
                src={result.imageUrl}
                alt="Bot 模式截图预览"
                style={{
                  width: `${displayWidth}px`,
                  maxWidth: '100%',
                }}
              />
            )}
          </div>
        </div>

        <div className={cls.foot}>
          <span className={toast !== null ? `${cls.meta} ${cls.toast}` : cls.meta}>
            {toast !== null ? toast : meta}
          </span>
          <div className={cls.actions}>
            <button type="button" className={cls.action} disabled={busy} onClick={() => { void run() }}>
              重新渲染
            </button>
            <button type="button" className={cls.action} disabled={result === null && !busy} onClick={onCopy}>
              {busy ? '生成并复制' : '复制图片'}
            </button>
            <button type="button" className={cls.action} disabled={result === null && !busy} onClick={onDownload}>
              下载 PNG
            </button>
            <button type="button" className={cls.action} onClick={() => { void reveal() }}>
              打开目录
            </button>
            <button type="button" className={cls.primary} disabled={result === null && !busy} onClick={onSave}>
              {busy ? '生成并保存' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}