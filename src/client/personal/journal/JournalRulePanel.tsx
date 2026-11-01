/**
 * Personal Agent — 期刊触发规则面板。
 *
 * 展示「到达第二天且在 0:00–8:00 内，连续 30 分钟无用户主动对话 → 自动生成总结日记」
 * 的规则与当前设置；提供「立即检查」和「模拟 07:30 触发」两个真实调用
 * actions.runJournalCheck() 的入口，并把返回的 reason 用 toast 显示出来。
 * 面板底部列出最近 8 条触发日志（成功 / 跳过及原因、时间）。
 */
import { IconClock, IconRefresh, IconX } from '../icons.tsx'
import { usePersonal } from '../store.tsx'

export interface JournalRulePanelProps {
  onClose?: () => void
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 日志时间：MM-DD HH:mm。 */
function formatLogTime(at: number): string {
  const date = new Date(at)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function JournalRulePanel({ onClose }: JournalRulePanelProps): JSX.Element {
  const { state, actions } = usePersonal()
  const rule = state.settings.journalRule
  const logs = state.journalLogs.slice(0, 8)

  const runNow = (): void => {
    const result = actions.runJournalCheck()
    actions.toast(result.reason)
  }

  const simulateMorning = (): void => {
    // 构造「今天 07:30」的时间戳交给规则检查；静默不足时 runJournalCheck 会返回原因。
    const target = new Date()
    target.setHours(7, 30, 0, 0)
    const result = actions.runJournalCheck(target.getTime())
    actions.toast(result.reason)
  }

  return (
    <aside className="pa-journal-rule" role="dialog" aria-label="期刊触发规则">
      <header className="pa-journal-rule__head">
        <div className="pa-journal-rule__heading">
          <h2 className="pa-journal-rule__title">期刊触发规则</h2>
          <p className="pa-journal-rule__sub">Personal Agent · 自动日记</p>
        </div>
        {onClose !== undefined ? (
          <button className="pa-journal-iconbtn" type="button" title="收起规则" aria-label="收起规则" onClick={onClose}>
            <IconX size={16} />
          </button>
        ) : null}
      </header>

      <div className="pa-journal-rule__body">
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
        </div>

        <div className="pa-journal-rule__actions">
          <button className="pa-journal-rule__btn" type="button" onClick={runNow}>
            <IconRefresh size={14} />
            立即检查
          </button>
          <button className="pa-journal-rule__btn pa-journal-rule__btn--primary" type="button" onClick={simulateMorning}>
            <IconClock size={14} />
            模拟 07:30 触发
          </button>
        </div>

        <p className="pa-journal-rule__logs-title">最近触发记录 · 最新 8 条</p>
        {logs.length === 0 ? (
          <div className="pa-journal-rule__empty">还没有触发记录。点上面的按钮跑一次检查。</div>
        ) : (
          logs.map((log, index) => (
            <div className="pa-journal-log" data-ok={log.ok ? 'true' : 'false'} key={`${log.at}-${index}`}>
              <span className="pa-journal-log__dot" />
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
