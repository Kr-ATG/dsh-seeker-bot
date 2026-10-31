/**
 * dsh-seeker-bot — 右栏 Bot 面板的纯呈现层。
 *
 * 纪律：这里**不渲染任何标题 / 说明文字 / 终端**，只渲染：
 *  · 一张 KrEchoViewport 画面（没有工作空间时组件自己返回 null，不占空框）；
 *  · 有子智能体 / 产出物时，按 KrSubagentsCard / KrOutputsCard 的同源数据
 *    （useSubagentCatalog / useSubagentOutputs / useSessionOutputs 的结果）列出
 *    最小行，不重复卡头与计数——右栏面板不是第二套大盘。
 *
 * 组件本身不取数（hooks 在 panel.tsx 的连接层），所以测试可以在 node 里用
 * react/jsx-runtime 桩直接跑，断言「空数据时树上只有一个画面，没有文字」。
 */

import type { ReactElement } from 'react'
import { KrEchoViewport } from '../echo-viewport/KrEchoViewport.tsx'
import type { SubagentCatalogView } from '../kr-chat/subagent-catalog.ts'
import type { OutputsView } from '../kr-chat/outputs.ts'
import { visiblePanelSections } from './model.ts'

export interface BotPanelViewProps {
  /** 当前会话 id（画面与产出物都按它取数）。 */
  readonly sessionId: string | null
  /** 当前会话的子智能体目录（与 KrSubagentsCard 同源）。 */
  readonly catalog: SubagentCatalogView
  /** 当前会话的产出物（与 KrOutputsCard 同源）。 */
  readonly outputs: OutputsView
}

export function BotPanelView({ sessionId, catalog, outputs }: BotPanelViewProps): ReactElement {
  const sections = visiblePanelSections({
    hasSubagents: catalog.rows.length > 0,
    hasOutputs: outputs.items.length > 0,
  })
  return (
    <div className="skb-bot-panel">
      {sections.includes('viewport') && (
        <div className="skb-bot-panel__viewport">
          <KrEchoViewport sessionId={sessionId} browserOn />
        </div>
      )}
      {sections.includes('subagents') && (
        <div className="skb-bot-panel__list" data-kind="subagents">
          {catalog.rows.map((row) => (
            <div className="skb-bot-panel__row" key={row.id} title={row.label}>
              <span className="skb-bot-panel__dot" data-running={row.running ? 'true' : undefined} aria-hidden />
              <span className="skb-bot-panel__name">{row.label}</span>
            </div>
          ))}
        </div>
      )}
      {sections.includes('outputs') && (
        <div className="skb-bot-panel__list" data-kind="outputs">
          {outputs.items.slice(0, 8).map((item) => (
            <div className="skb-bot-panel__row" key={item.path} title={item.path}>
              <span className="skb-bot-panel__dot" aria-hidden />
              <span className="skb-bot-panel__name">{item.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
