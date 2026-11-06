/**
 * Personal Agent — 会话头的「自动播报」开关（放在通话按钮左侧）。
 *
 * ## 为什么放到会话头
 * 自动播报是聊天里的高频动作：想安静时随手关掉，想听时随手打开。它原先只在
 * 「Bot 设置 → 语音 → 自动朗读回复」里，要拨一次得点开设置卡、切到语音页，
 * 三层才够到。挪到会话头之后，它与通话按钮并排成一组——都是「这个 Bot 的嘴」，
 * 同一个心智模型。
 *
 * **这也是唯一入口**（2026-11-05）：设置卡语音页里那个重复的开关已撤掉，
 * 同一份状态 `bot.autoSpeak` 只由这里维护；设置卡只留音色与 Live 供应商。
 *
 * ## 音量条为什么做成悬停浮层
 *  · 常驻一条会白占头部一行高度，而调音量是「调一次就不再碰」的低频动作；
 *  · 塞进「更多」菜单又要点两层才够得到；
 *  · 挂在开关自己身上最省：hover / 键盘聚焦即出，移开就收，拖动即时生效。
 *
 * 音量调节的是**朗读播放增益**（见 speech.ts 的 setSpeechVolume），与通话弹层
 * 里那条通话音量是两个独立的值：一个管「念出来的回复」，一个管「电话里的声音」。
 *
 * ## 群聊不显示
 * 自动播报只在单聊生效（MessageList 的判定：群聊是多个 Bot 轮流说话，自动念会
 * 变成抢话）。群里摆一个拨了也没用的开关，比不摆更糟。
 */
import { useCallback, useEffect, useRef, useState, type FocusEvent as ReactFocusEvent } from 'react'
import { IconVolume, IconVolumeOff } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { getSpeechVolume, setSpeechVolume } from '../speech.ts'
import { VolumeSlider } from '../shared/VolumeSlider.tsx'

/**
 * 鼠标离开后多久收起浮层（毫秒）。
 *
 * 给「按钮 → 浮层」之间那条缝留出移动时间：这个数字要明显小于人把鼠标移过去
 * 的时间（百毫秒级），又足够兜住光标划过缝隙时的抖动；配合 CSS 里那条透明桥，
 * 正常移动根本不会触发它。
 */
const CLOSE_DELAY_MS = 160

export function AutoSpeakButton(): JSX.Element | null {
  const { activeBot, activeRoom, actions } = usePersonal()
  const [open, setOpen] = useState(false)
  const [volume, setVolume] = useState(() => getSpeechVolume())
  const closeTimerRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const clearClose = useCallback((): void => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const closeSoon = useCallback((): void => {
    clearClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }, [clearClose])

  useEffect(() => () => {
    clearClose()
  }, [clearClose])

  const on = activeBot.autoSpeak === true
  const percent = Math.round(volume * 100)

  const toggle = useCallback((): void => {
    actions.updateBot(activeBot.id, { autoSpeak: !on })
  }, [actions, activeBot.id, on])

  const changeVolume = useCallback((next: number): void => {
    const clamped = Math.max(0, Math.min(1, next))
    setVolume(clamped)
    setSpeechVolume(clamped)
  }, [])

  // 群聊里自动播报不生效（见文件头），入口一并隐藏。放在 hooks 之后，保持调用顺序稳定。
  if (activeRoom !== null) return null

  return (
    <div
      className="pa-autospeak"
      ref={rootRef}
      onMouseEnter={() => {
        clearClose()
        setOpen(true)
      }}
      onMouseLeave={closeSoon}
      onFocus={() => {
        clearClose()
        setOpen(true)
      }}
      onBlur={(event: ReactFocusEvent<HTMLDivElement>) => {
        // 焦点在按钮与滑块之间移动不算离开：两者都在本容器里
        const next = event.relatedTarget
        if (next instanceof Node && rootRef.current !== null && rootRef.current.contains(next)) return
        clearClose()
        setOpen(false)
      }}
    >
      <button
        className="pa-chat__head-btn"
        type="button"
        data-on={on ? 'true' : 'false'}
        aria-pressed={on}
        title={on ? '自动播报已开启（悬停调节音量）' : '自动播报已关闭（悬停调节音量）'}
        aria-label={on ? '关闭自动播报' : '开启自动播报'}
        onClick={toggle}
      >
        {on ? <IconVolume size={18} /> : <IconVolumeOff size={18} />}
      </button>

      {open ? (
        <div className="pa-autospeak__panel" role="group" aria-label="朗读音量">
          <VolumeSlider
            value={percent}
            onChange={(next) => {
              changeVolume(next / 100)
            }}
            ariaLabel="朗读音量"
            valueText={percent === 0 ? '静音' : `${percent}%`}
          />
        </div>
      ) : null}
    </div>
  )
}
