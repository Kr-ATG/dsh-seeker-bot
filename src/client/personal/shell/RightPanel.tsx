/**
 * Personal Agent — 右侧栏（v3 精简版）。
 *
 * 用户口径：**右侧栏除了浏览器全部删掉，只留产出物卡与任务记录卡。**
 * 因此这里不再有「详情 / 资料库 / 电脑」三个 tab，也没有任务卡、模型、音色、
 * 权限、主动询问、例行任务、子 Bot 管理、记忆、文件树、终端、分享按钮。
 * 这些设置入口已迁到 Bot 设置滑出卡（BotSettingsCard），右栏只负责「看结果」。
 *
 * 最终结构（自上而下）：
 *   1. 通话收起条 —— 仅在通话最小化时出现；
 *   3. 极简顶栏 —— 左侧 Bot 名称 / 角色，右侧关闭右栏；
 *   4. PagesCard —— Bot 交付过的可回访页面（3.1；host 没就绪时自身不渲染）；
 *   5. BotOutputsCard —— 产出物文件夹扫描结果（Seeker 大盘同款）；
 *   6. TaskRecordCard —— 这个 Bot 的任务记录（队友 D 实现）。
 *
 * 样式：本文件只组织结构；顶栏 / 卡间距在 outputs.css.ts，任务卡样式在
 * tasks.css.ts，两者都由 index.tsx / standalone.tsx 统一注入。
 */
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { PAGE_MOTION_IN, PAGE_MOTION_STAGGER } from '../../motion/overlay-motion.ts'
import { IconExpand, IconPhoneOff, IconX } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { formatDuration } from '../types.ts'
import { BotOutputsCard } from './BotOutputsCard.tsx'
import { PagesCard } from './PagesCard.tsx'
import { TaskRecordCard } from './TaskRecordCard.tsx'

/*
 * 右栏宽度约束：与 store.tsx 的 clampRightWidth 保持一致。
 * store 是权威（写进 pa:ui:v1 前会再 clamp 一次），这里只为拖拽过程做即时约束。
 */
const MIN_RIGHT_WIDTH = 240
const MAX_RIGHT_WIDTH = 640
const DEFAULT_RIGHT_WIDTH = 300

export function RightPanel(): JSX.Element {
  const { state, ui, actions, activeBot, activeRoom } = usePersonal()
  /** 通话计时：只在收起条可见且通话中时每秒刷新一次。 */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (ui.call.status === 'idle' || !ui.call.minimized) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ui.call.status, ui.call.minimized])

  /**
   * 拖拽右栏左边缘调整宽度。
   *
   * 拖动过程中**直接改 CSS 变量**（`.pa-app-shell` 上的 `--pa-right-w`）：
   * 每帧都 setState 会让整棵 Bot 界面重渲染，手感会发涩。松手时才调
   * `actions.setRightPanelWidth` 落进 `pa:ui:v1`，刷新后保持。
   */
  const startResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const shell = document.querySelector('.pa-app-shell')
    const startX = event.clientX
    const startWidth = ui.rightPanelWidth
    let latest = startWidth
    const onMove = (moveEvent: MouseEvent): void => {
      // 右栏在右侧：鼠标往左拖（clientX 变小）变宽
      const next = Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, startWidth - (moveEvent.clientX - startX)))
      latest = next
      if (shell instanceof HTMLElement) shell.style.setProperty('--pa-right-w', `${next}px`)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.removeAttribute('data-pa-resizing')
      actions.setRightPanelWidth(latest)
    }
    document.body.setAttribute('data-pa-resizing', 'true')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 双击手柄恢复默认宽度（用户拖窄了想回去时不用再慢慢拖）。 */
  const resetRightWidth = (): void => {
    actions.setRightPanelWidth(DEFAULT_RIGHT_WIDTH)
  }

  const callBot = ui.call.botId !== null
    ? state.bots.find((bot) => bot.id === ui.call.botId)
    : undefined

  /*
   * 页面转场：右栏是一页「面板」——它随 ui.rightPanelOpen 挂载 / 卸载，
   * 所以每次拉开都会重播入场（等价于视图容器换 key），不用额外写状态。
   * 常驻不卸载的侧栏 / 主列不能这么用（不会重播），它们的重播靠模式切换。
   */
  return (
    <aside className="pa-right" {...PAGE_MOTION_IN}>
      {/* 左边缘拖拽手柄：调宽度，松手写回 ui；双击恢复默认。 */}
      <div
        className="pa-right__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整右栏宽度"
        title="拖拽调整宽度（双击恢复默认）"
        onMouseDown={startResize}
        onDoubleClick={resetRightWidth}
      />
      {/* 通话收起条：通话最小化时给一个回到通话的入口。 */}
      {ui.call.status !== 'idle' && ui.call.minimized ? (
        <div className="pa-call-bar">
          {callBot !== undefined ? <BotAvatar avatar={callBot.avatar} size={28} online /> : null}
          <div className="pa-call-bar__text">
            <b>通话中 · {formatDuration(now - ui.call.startedAt)}</b>
            {callBot?.name ?? '语音通话'}
          </div>
          <button
            className="pa-call-bar__btn"
            type="button"
            title="展开通话"
            aria-label="展开通话"
            onClick={() => actions.minimizeCall(false)}
          >
            <IconExpand size={14} />
          </button>
          <button
            className="pa-call-bar__btn pa-call-bar__btn--hangup"
            type="button"
            title="挂断"
            aria-label="挂断"
            onClick={() => actions.endCall()}
          >
            <IconPhoneOff size={14} />
          </button>
        </div>
      ) : null}

      {/* 极简顶栏：只交代「这是谁」和「怎么关掉右栏」。 */}
      <div className="pa-right__topbar">
        <div className="pa-right__topbar-main">
          <span className="pa-right__topbar-name" title={activeBot.name}>{activeBot.name}</span>
          <span className="pa-right__topbar-role" title={activeBot.role}>{activeBot.role}</span>
        </div>
        <button
          className="pa-right__topbar-close"
          type="button"
          title="关闭右栏"
          aria-label="关闭右栏"
          onClick={() => actions.toggleRightPanel(false)}
        >
          <IconX size={15} />
        </button>
      </div>

      {/*
       * 结果区：页面（可回访的持久产物）+ 产出物 + 任务记录。
       *
       * 错峰入场：三张卡依次上浮（每张晚 22ms），右栏拉开时先看到「面板在」、
       * 再看到内容一块块落位。只有三张卡、都在首屏内，不存在长列表全量错峰
       * 拖慢首帧的问题；--i 由 shell.css.ts 按渲染顺序给（PagesCard 可能不渲染）。
       */}
      <div className="pa-right__body" {...PAGE_MOTION_STAGGER}>
        <PagesCard botId={activeBot.id} />
        <BotOutputsCard botId={activeBot.id} botName={activeBot.name} />
        <TaskRecordCard botId={activeBot.id} roomId={activeRoom?.id} />
      </div>
    </aside>
  )
}
