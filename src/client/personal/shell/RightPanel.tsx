/**
 * Personal Agent — 右侧栏（v6：Bot 资料区 + 动态 / 产出物分段 tab）。
 *
 * 用户口径（2026-11-04 澄清）：「三分之一」指的是 tab 条落在面板约 1/3 高度处，
 * 不是 tab 条宽度。参考图的右栏自上而下是：
 *   1. Bot 资料区 —— 圆形头像 + 右下编辑铅笔 + 居中的名称；
 *   2. 分段式 tab 条 —— 接近内容区全宽，两段「动态」「产出物」，选中段是一枚
 *      独立滑块（左右滑动 240ms，与 Work ⇄ Bot 分段同一套手感）；
 *   3. 分类内容 —— 动态：定时任务区 + 任务记录；产出物：页面卡 + 产出物卡。
 *
 * 2026-11-07 改版（用户：「把右侧侧边栏的动图也移动到对话，放在对话的正上方
 * 中间悬浮」）：资料区那枚 92px 三态动图整个迁到对话卡顶部正中悬浮（见
 * chat/ChatPanel.tsx 的 .pa-chat__mascot）。资料区因此只剩「名称 + 编辑铅笔」
 * （群聊再加成员网格），高度改成**内容自适应**——动图走了还继续用 30vh 兜底，
 * 名称下方就会压出一大块空白，tab 条顶到 1/3 高度也失去了视觉依据。
 *
 * 最终结构（自上而下）：
 *   1. 通话收起条 —— 仅在通话最小化时出现；
 *   2. Bot 资料区 —— 群聊时先排一块 5 列成员网格（圆形头像 + 名字 + 添加），
 *      下面是名称 + 编辑铅笔；私聊时只有名称 + 编辑铅笔。**右栏内不再放关闭钮**
 *      （2026-11-07 用户要求：关闭入口只有会话头「更多」左侧那枚切换按钮）；
 *   3. 分类 tab —— 「动态」（默认）/「产出物」，分段控件；
 *   4. 分类面板 —— 动态：ActivityTab（定时任务区 + 任务记录）；
 *      产出物：PagesCard + BotOutputsCard。
 *
 * 样式：本文件只组织结构；资料区 / 分段 tab / 定时任务区在 outputs.css.ts，
 * 任务卡样式在 tasks.css.ts，两者都由 index.tsx / standalone.tsx 统一注入。
 */
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { PAGE_MOTION_IN, PAGE_MOTION_STAGGER } from '../../motion/overlay-motion.ts'
import { IconEdit, IconExpand, IconFolder, IconListTodo, IconPhoneOff, IconPlus } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { formatDuration, type Bot } from '../types.ts'
import { ActivityTab } from './ActivityTab.tsx'
import { BotOutputsCard } from './BotOutputsCard.tsx'
import { PagesCard } from './PagesCard.tsx'

/*
 * 右栏宽度约束：与 store.tsx 的 clampRightWidth 保持一致。
 * store 是权威（写进 pa:ui:v1 前会再 clamp 一次），这里只为拖拽过程做即时约束。
 */
const MIN_RIGHT_WIDTH = 240
const MAX_RIGHT_WIDTH = 640
const DEFAULT_RIGHT_WIDTH = 300

/** 右栏分类：动态（默认）在前，产出物在后。 */
type RightTabId = 'activity' | 'outputs'

/*
 * 分类 tab 是**纯图标**（2026-11-04 用户：「我不要这个文字」，参照的分段条也是
 * 图标段）：可见区域只放图标，分类名只留在 title / aria-label 上，悬停与读屏
 * 仍能知道自己点的是哪一类。
 */
const RIGHT_TABS: ReadonlyArray<{ id: RightTabId; label: string; icon: JSX.Element }> = [
  { id: 'activity', label: '动态', icon: <IconListTodo size={17} /> },
  { id: 'outputs', label: '产出物', icon: <IconFolder size={17} /> },
]

export function RightPanel(): JSX.Element {
  const { state, ui, actions, activeBot, activeRoom } = usePersonal()
  /** 当前分类；默认「动态」，不落盘（每次拉开右栏都从动态开始）。 */
  const [tab, setTab] = useState<RightTabId>('activity')
  /**
   * 面板内容用的分类：比 tab **晚一帧**生效。
   *
   * 滑块位移由 tab 驱动。如果在同一帧里把整块面板换掉（产出物卡要扫文件、
   * 页面卡要渲染），主线程会先忙几十毫秒，滑块 transition 的首帧会被挤掉，
   * 看起来就是「顿一下再滑」。晚一帧让滑块先提交给合成器，再换面板内容，
   * 滑动就不会被内容渲染打断（与侧栏 Work ⇄ Bot 的「先钉起点再起播」同因）。
   */
  const [panelTab, setPanelTab] = useState<RightTabId>('activity')
  /** 通话计时：只在收起条可见且通话中时每秒刷新一次。 */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (panelTab === tab) return undefined
    const raf = window.requestAnimationFrame(() => { setPanelTab(tab) })
    return () => { window.cancelAnimationFrame(raf) }
  }, [tab, panelTab])

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

  /**
   * 分类 tab 的键盘操作：左右方向键循环，Home / End 跳首尾。
   *
   * WAI-ARIA tablist 的惯例动作；选中后把焦点也移到新 tab，键盘用户按一次
   * 方向键就能继续用 Tab / 回车操作，不会出现「焦点留在旧 tab」的错位。
   */
  const onTabsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const { key } = event
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return
    event.preventDefault()
    const index = RIGHT_TABS.findIndex((item) => item.id === tab)
    const last = RIGHT_TABS.length - 1
    let next = index
    if (key === 'ArrowRight') next = index >= last ? 0 : index + 1
    else if (key === 'ArrowLeft') next = index <= 0 ? last : index - 1
    else if (key === 'Home') next = 0
    else next = last
    const target = RIGHT_TABS[next]
    if (target === undefined) return
    setTab(target.id)
    document.getElementById(`pa-right-tab-${target.id}`)?.focus()
  }

  /*
   * 资料区的三态动图已于 2026-11-07 迁到对话卡顶部悬浮（用户要求「把右侧侧边栏
   * 的动图也移动到对话，放在对话的正上方中间悬浮」）：三态推导与 BotAvatar
   * 调用现在都在 chat/ChatPanel.tsx 的 .pa-chat__mascot，本文件不再持有头像状态。
   */

  /*
   * 群聊成员（2026-11-05）：用户要求「bot 群聊在右侧侧边栏的动图上面增加类似
   * 微信这种，但是头像是圆形的」。
   *
   * 数据口径与 ChatPanel / Sidebar 的群成员完全一致：按 room.memberIds 的顺序取
   * state.bots，找不到的（成员已被删除的脏数据）直接跳过，不在界面上留空位。
   * 只有群聊会渲染这块网格，私聊只有「名称 + 编辑铅笔」。
   */
  const roomMembers: Bot[] = activeRoom === null
    ? []
    : activeRoom.memberIds
      .map((id) => state.bots.find((bot) => bot.id === id))
      .filter((bot): bot is Bot => bot !== undefined)

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
          {callBot !== undefined ? <BotAvatar avatar={callBot.avatar} size={28} /> : null}
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

      {/*
       * Bot 资料区（2026-11-07 起高度内容自适应）：居中「名称 + 编辑铅笔」。
       * 关闭钮仍在右上（这是右栏唯一的关闭入口；本轮的改动只迁移了动图，
       * 没有动关闭入口）。2026-11-05 按用户要求删掉了「已连接」文字与状态指示灯。
       *
       * 原来那枚 92px 三态动图已经迁到对话卡顶部悬浮（见 chat/ChatPanel.tsx 的
       * .pa-chat__mascot），资料区不再放头像，所以也不再拿 30vh 撑出 1/3 高度。
       *
       * 群聊时在名称行**上面**多排一块成员网格（微信聊天信息页的 5 列排法，
       * 但头像做成圆形）：它是「这个群有谁」的入口，所以跟名称同一块资料区里，
       * 而不是另起一张卡。data-room 只负责切换资料区的纵向排布，私聊样式不动。
       */}
      <div className="pa-right__profile" data-room={activeRoom === null ? undefined : 'true'}>
        {activeRoom === null ? null : (
          /*
           * 群成员网格：5 列，每格「圆形头像 + 名字」，最后一格是「+」。
           *
           * · 头像用 BotAvatar（用户上传的照片会自带圆形裁切；SVG 造型则压在
           *   中性的圆底上，外圈始终是一个正圆，符合「头像是圆形的」）；
           * · 点某个成员 → 打开该 Bot 的资料卡（与侧栏点头像同一套 BotSettingsCard，
           *   相当于微信点群成员看资料）；
           * · 「+」直接打开群设置：添加成员就在那张卡的「成员」区，不再另造一个
           *   只有两个输入框的小弹层。
           * · 只读成员名字 / 角色，不改任何数据；成员按 memberIds 原顺序展示，
           *   群主（第一个成员）排在最前，与会话头显示的是同一个群。
           */
          <div className="pa-right__members-card">
            <div className="pa-right__members-head">
              <b>群成员</b>
              <span>{roomMembers.length} 个</span>
            </div>
            <div
              className="pa-right__members"
              role="group"
              aria-label={`群成员（${String(roomMembers.length)} 个）`}
            >
              {roomMembers.map((member) => (
                <button
                  key={member.id}
                  className="pa-right__member"
                  type="button"
                  title={`${member.name} · ${member.role}`}
                  aria-label={`${member.name} · ${member.role}`}
                  onClick={() => actions.openBotSettings(member.id)}
                >
                  <span className="pa-right__member-avatar">
                    <BotAvatar avatar={member.avatar} size={44} muted={!member.enabled} />
                  </span>
                  <span className="pa-right__member-name">{member.name}</span>
                </button>
              ))}
              <button
                className="pa-right__member pa-right__member--add"
                type="button"
                title="添加成员"
                aria-label="添加成员"
                onClick={() => actions.openGroupSettings(activeRoom.id)}
              >
                <span className="pa-right__member-avatar pa-right__member-avatar--add">
                  <IconPlus size={19} />
                </span>
                {/* 占位：让「+」和上面各格的名字行同高，网格底边不会缺一截。 */}
                <span className="pa-right__member-name" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {/*
         * 资料区只剩「名称 + 编辑铅笔」（2026-11-07）：原来压在大头像右下角的
         * 编辑按钮并到名称右侧，两者成为同一个居中行；动图已经迁到对话卡顶部，
         * 这里不再放头像，避免资料区留出一大块空位。
         */}
        <div className="pa-right__profile-main">
          <div className="pa-right__profile-name" title={`${activeBot.name} · ${activeBot.role}`}>
            {activeBot.name}
          </div>
          <button
            className="pa-right__edit-btn"
            type="button"
            title="编辑 Bot 资料"
            aria-label="编辑 Bot 资料"
            onClick={() => actions.openBotSettings(activeBot.id)}
          >
            <IconEdit size={13} />
          </button>
        </div>
      </div>

      {/*
       * 分段式分类 tab：接近内容区全宽（左右 16px），浅色 track 两段等分，
       * 选中段是浅色凸起 pill。role=tablist + aria-selected，键盘左右键可切换。
       */}
      <div
        className="pa-right__tabs"
        role="tablist"
        aria-label="右栏分类"
        onKeyDown={onTabsKeyDown}
      >
        {/*
          高亮块是独立滑块（2026-11-04）：与侧栏 Work ⇄ Bot 分段同一套手感，
          位移用 CSS transition（240ms / cubic-bezier(.22,1,.36,1)），切换 tab
          时从「动态」滑到「产出物」、再滑回来，不再给按钮换背景。
        */}
        <span className="pa-right__tab-thumb" aria-hidden="true" data-tab={tab} />
        {RIGHT_TABS.map((item) => {
          const on = item.id === tab
          return (
            <button
              key={item.id}
              className="pa-right__tab"
              type="button"
              role="tab"
              id={`pa-right-tab-${item.id}`}
              aria-selected={on}
              aria-label={item.label}
              aria-controls="pa-right-panel"
              title={item.label}
              tabIndex={on ? 0 : -1}
              onClick={() => setTab(item.id)}
            >
              <span className="pa-right__tab-icon" aria-hidden="true">{item.icon}</span>
            </button>
          )
        })}
      </div>

      {/*
       * 分类面板：只渲染当前分类那一份，key={tab} 让换 tab 时入场动画重播。
       * 动态 = 定时任务区 + 任务记录（ActivityTab 内部自行按天分组）；
       * 产出物 = 页面卡 + 产出物卡，沿用现有预览 / 折叠逻辑。
       */}
      <div className="pa-right__body">
        <div
          key={panelTab}
          className="pa-right__panel"
          id="pa-right-panel"
          role="tabpanel"
          aria-labelledby={`pa-right-tab-${panelTab}`}
          {...PAGE_MOTION_STAGGER}
        >
          {panelTab === 'activity' ? (
            <ActivityTab botId={activeBot.id} roomId={activeRoom?.id} />
          ) : (
            <>
              <PagesCard botId={activeBot.id} />
              <BotOutputsCard botId={activeBot.id} botName={activeBot.name} />
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
