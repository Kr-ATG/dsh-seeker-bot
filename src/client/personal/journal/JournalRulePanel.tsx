/**
 * Personal Agent — 期刊触发规则面板（右侧滑出）。
 *
 * 数据来源保持与旧版一致：state.settings.journalRule + state.journalLogs。
 * 如果数据层（store）以后补了 `state.journalStatus`（宿主 /journal/status 的合并结果），
 * 这里会**可选地**读出 generating / lastGeneratedAt 做展示，没有也不影响。
 *
 * 两个按钮都真实调用 actions.runJournalCheck()：
 *   · 「立即检查」用当前时间；
 *   · 「模拟 07:30 触发」构造今天 07:30 的时间戳，便于验收触发窗口逻辑。
 * 数据层可能把 runJournalCheck 改成异步（宿主优先、失败回退本地），所以这里
 * 同时兼容「同步返回结果」和「返回 Promise」两种形态，统一用 Promise.resolve 收敛。
 *
 * 视觉与阅读器同一套 --j-* token（见 journal.css.ts），不写死颜色。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconClock, IconRefresh, IconX } from '../icons.tsx'
import { usePersonal } from '../store.tsx'

export interface JournalRulePanelProps {
  onClose?: () => void
}

interface CheckResult {
  ok: boolean
  reason: string
  journalId?: string
}

interface JournalStatusLike {
  generating?: boolean
  lastGeneratedAt?: number
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 日志时间：MM-DD HH:mm。 */
function formatLogTime(at: number): string {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return '—'
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 从 store 里可选地读出宿主状态（字段还没加时返回空对象）。 */
function readJournalStatus(state: unknown): JournalStatusLike {
  if (state === null || typeof state !== 'object') return {}
  const status = (state as { journalStatus?: unknown }).journalStatus
  if (status === null || typeof status !== 'object') return {}
  return status as JournalStatusLike
}

export function JournalRulePanel({ onClose }: JournalRulePanelProps): JSX.Element {
  const { state, actions } = usePersonal()
  const [checking, setChecking] = useState(false)
  /*
   * 退场状态：收起规则面板时先播 240ms（整层淡出 + 向右 46px + 轻微缩小），
   * 再调用父级 onClose 真正卸载。直接 onClose() 会让抽屉硬消失，和入场那
   * 220ms 的滑入不对称。时长 / 曲线与 modal-animation.ts 的 MODAL_ANIM_MS 一致。
   */
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  /*
   * onClose 由期刊层用内联箭头函数传入，每次父级渲染都会换引用。放进 ref
   * 之后 requestClose 保持稳定，捕获阶段的 Esc 监听不必每次渲染都摘挂一遍。
   */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  /** 收起：先播退场，240ms 后再真正卸载。 */
  const requestClose = useCallback((): void => {
    if (onCloseRef.current === undefined) return
    if (closeTimerRef.current !== null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setClosing(false)
      onCloseRef.current?.()
    }, 240)
  }, [])

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  /*
   * Esc 收起规则面板：与右上角关闭按钮走同一个退场。
   *
   * 用捕获阶段 + stopImmediatePropagation：期刊层（JournalOverlay）也在 window
   * 上监听 Esc，且它看到 ruleOpen 仍为 true 时会直接 setRuleOpen(false) 把本面板
   * 硬卸载——退场就播不出来。捕获阶段先接管并截断，Esc 才能和按钮一致。
   */
  const canClose = onClose !== undefined
  useEffect(() => {
    if (!canClose) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopImmediatePropagation()
      requestClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [canClose, requestClose])
  const rule = state.settings.journalRule
  const logs = state.journalLogs.slice(0, 8)
  const status = readJournalStatus(state)

  const runCheck = (nowOverride?: number): void => {
    if (checking) return
    setChecking(true)
    const settle = (result: unknown): void => {
      setChecking(false)
      const value = result as CheckResult | null | undefined
      if (value !== null && value !== undefined && typeof value.reason === 'string' && value.reason !== '') {
        actions.toast(value.reason)
        return
      }
      actions.toast('已执行检查')
    }
    try {
      const result = actions.runJournalCheck(nowOverride) as unknown
      if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
        void (result as Promise<unknown>)
          .then(settle)
          .catch(() => {
            setChecking(false)
            actions.toast('检查失败：宿主暂时没有响应')
          })
      } else {
        settle(result)
      }
    } catch {
      setChecking(false)
      actions.toast('检查失败：宿主暂时没有响应')
    }
  }

  const runNow = (): void => runCheck()

  const simulateMorning = (): void => {
    // 构造「今天 07:30」的时间戳交给规则检查；静默不足时 runJournalCheck 会返回原因。
    const target = new Date()
    target.setHours(7, 30, 0, 0)
    runCheck(target.getTime())
  }

  const lastGeneratedAt = typeof status.lastGeneratedAt === 'number' ? status.lastGeneratedAt : null
  const hostGenerating = status.generating === true

  return (
    <aside
      className="pa-journal-rule"
      role="dialog"
      aria-label="期刊触发规则"
      data-closing={closing ? '1' : undefined}
    >
      <header className="pa-journal-rule__head">
        <div className="pa-journal-rule__heading">
          <h2 className="pa-journal-rule__title">期刊触发规则</h2>
          <p className="pa-journal-rule__sub">Personal Agent · 自动日记</p>
        </div>
        {onClose !== undefined ? (
          <button className="pa-journal-iconbtn" type="button" title="收起规则" aria-label="收起规则" onClick={requestClose}>
            <IconX size={16} />
          </button>
        ) : null}
      </header>

      <div className="pa-journal-rule__body">
        {hostGenerating ? (
          <div className="pa-journal-rule__status">
            <span className="pa-journal-rule__status-dot" aria-hidden="true" />
            <span>宿主正在生成这一期，稍后会自动出现在书架里。</span>
          </div>
        ) : null}

        <p className="pa-journal-rule__text">
          到达第二天且在 <strong>{rule.startHour}:00–{rule.endHour}:00</strong> 内，
          连续 <strong>{rule.idleMinutes} 分钟</strong>没有任何用户主动发起的对话，
          自动生成总结日记。
        </p>

        <div className="pa-journal-rule__settings">
          <div className="pa-journal-rule__row">
            <span className="pa-journal-rule__label">规则状态</span>
            <span className="pa-journal-rule__value" data-off={rule.enabled ? 'false' : 'true'}>
              {rule.enabled ? '已开启' : '已关闭'}
            </span>
          </div>
          <div className="pa-journal-rule__row">
            <span className="pa-journal-rule__label">触发窗口</span>
            <span className="pa-journal-rule__value">{rule.startHour}:00 – {rule.endHour}:00</span>
          </div>
          <div className="pa-journal-rule__row">
            <span className="pa-journal-rule__label">静默时长</span>
            <span className="pa-journal-rule__value">{rule.idleMinutes} 分钟</span>
          </div>
          <div className="pa-journal-rule__row">
            <span className="pa-journal-rule__label">目标内容</span>
            <span className="pa-journal-rule__value">昨天的对话总结</span>
          </div>
          {lastGeneratedAt !== null ? (
            <div className="pa-journal-rule__row">
              <span className="pa-journal-rule__label">上次生成</span>
              <span className="pa-journal-rule__value">{formatLogTime(lastGeneratedAt)}</span>
            </div>
          ) : null}
        </div>

        <div className="pa-journal-rule__actions">
          <button className="pa-journal-rule__btn" type="button" disabled={checking} onClick={runNow}>
            <IconRefresh size={14} />
            {checking ? '检查中…' : '立即检查'}
          </button>
          <button
            className="pa-journal-rule__btn pa-journal-rule__btn--primary"
            type="button"
            disabled={checking}
            onClick={simulateMorning}
          >
            <IconClock size={14} />
            模拟 07:30 触发
          </button>
        </div>

        <p className="pa-journal-rule__logs-title">最近触发记录 · 最新 8 条</p>
        {logs.length === 0 ? (
          <div className="pa-journal-rule__empty">还没有触发记录。点上面的按钮跑一次检查。</div>
        ) : (
          logs.map((log, logIndex) => (
            <div className="pa-journal-log" data-ok={log.ok ? 'true' : 'false'} key={`${log.at}-${logIndex}`}>
              <span className="pa-journal-log__dot" aria-hidden="true" />
              <div className="pa-journal-log__body">
                <div className="pa-journal-log__line">
                  <span className="pa-journal-log__badge">{log.ok ? '成功' : '跳过'}</span>
                  <p className="pa-journal-log__reason">{log.reason}</p>
                </div>
                <div className="pa-journal-log__time">{formatLogTime(log.at)}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

export default JournalRulePanel
