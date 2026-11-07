/**
 * Personal Agent — 主位两侧的护法槽位（左 Muse / 右 Quill）。
 *
 * ## 两格是什么
 *
 * 它们是**固定位置**：人格跟着槽位走（state.hero 的两条映射），不跟着位置走。
 * 用户长按拖动交换时改的是映射本身，Bot 记录（名字、头像、记忆归属）一根手指
 * 都不碰——所以交换之后「谁记得什么」不会跟着错位。
 *
 * ## 空槽 = 召唤态
 *
 * 槽位没挂 Bot 时画的是出厂预设（见 presets.ts）：头像半透明、名字压暗、点一下
 * 就地建出来并占位。**不自动创建**——用户第一眼看到的应该是「这里可以放一个人」，
 * 而不是某天打开侧栏凭空多出两个陌生 Bot，还带着两个待读红点。
 *
 * ## 拖动换位的手感
 *
 * 双阈值：按下后**位移超过 8px 直接起拖**（有位移意图就不该等长按），或者原地
 * 按住 320ms 进入预备态。拖动期间 1:1 跟手、不做任何缓动（缓动会让手指和卡片
 * 脱节）；松手时落在对面格矩形内才交换，否则弹回原位。状态在松手瞬间就写，
 * 动画只负责让这已经发生的事实看起来顺滑——反过来做就是「状态撒谎」。
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { heroPresetOf } from '../presets.ts'
import { usePersonal } from '../store.tsx'
import type { HeroSlot } from '../types.ts'

/** 长按进入拖动态的时间（与桌面图标排序的体感对齐）。 */
const HOLD_MS = 320

/** 手指位移超过这个距离就直接起拖；低于它则算「点击 / 长按」。 */
const MOVE_SLOP = 8

/** 拖动态：当前相对原位的位移。null = 没在拖。 */
interface DragState {
  dx: number
  dy: number
}

export function HeroSlotCell({ slot }: { slot: HeroSlot }): JSX.Element {
  const { state, ui, actions } = usePersonal()
  const preset = heroPresetOf(slot)
  const botId = state.hero?.[slot] ?? null
  const bot = botId === null ? undefined : state.bots.find(item => item.id === botId)
  const [drag, setDrag] = useState<DragState | null>(null)

  /** 手势状态放在 ref 里：pointermove 每次都读，放 state 会触发无意义的重渲染。 */
  const gesture = useRef<{
    pointerId: number
    startX: number
    startY: number
    holdTimer: number | null
    dragging: boolean
  } | null>(null)

  /** 拖动刚结束的那一次 click 要吞掉，否则「松手」会被当成「点开了对话」。 */
  const suppressClick = useRef(false)

  /** 召唤中的标志：异步建 Bot 期间挡住第二次点击，避免建出两个同名 Bot。 */
  const summoning = useRef(false)

  const endGesture = useCallback((): void => {
    const current = gesture.current
    if (current?.holdTimer !== null && current?.holdTimer !== undefined) {
      window.clearTimeout(current.holdTimer)
    }
    gesture.current = null
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.currentTarget
    target.setPointerCapture?.(event.pointerId)
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      holdTimer: window.setTimeout(function armDrag() {
        const current = gesture.current
        if (current === null) return
        current.dragging = true
        setDrag({ dx: 0, dy: 0 })
      }, HOLD_MS),
      dragging: false,
    }
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = gesture.current
    if (current === null) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (!current.dragging) {
      // 位移意图已经明确：不等长按，直接起拖
      if (Math.hypot(dx, dy) < MOVE_SLOP) return
      if (current.holdTimer !== null) window.clearTimeout(current.holdTimer)
      current.holdTimer = null
      current.dragging = true
    }
    setDrag({ dx, dy })
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = gesture.current
    endGesture()
    if (current === null || !current.dragging) {
      // 没进入拖动：保持原来的点击语义
      return
    }
    suppressClick.current = true
    setDrag(null)
    const other: HeroSlot = slot === 'left' ? 'right' : 'left'
    const otherEl = document.querySelector(`.pa-hero-slot[data-slot="${other}"]`)
    if (otherEl === null) return
    const rect = otherEl.getBoundingClientRect()
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom
    if (!inside) return
    /*
     * 落进对面格才交换。注意这里只在「对面也挂着 Bot」时才调 swap：
     * 对面是空槽时交换会让那个 Bot 挪过去、原来这格变成空的召唤态——那其实
     * 也是一种合法移动，但用户更容易理解成「拖到一个没人的格子上」= 什么都不做。
     * 两种情况都接受，交给 swapHeroSlots 自己处理（它对 null 一样成立）。
     */
    actions.swapHeroSlots()
  }, [actions, endGesture, slot])

  const onClick = useCallback((): void => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    if (bot !== undefined) {
      actions.selectBot(bot.id)
      return
    }
    /*
     * 空槽点击：先认领**已经存在**的同名同岗 Bot，再考虑新建。
     *
     * 没有这一步，坏数据会自我复制：早先 normalizeState 丢过 hero 字段，
     * 槽位一空用户就再点一次，于是每刷一次页面就多一个「Muse 闺蜜」。
     * 修复归一化之后，用户手里那些历史遗留的同名 Bot 也要能被认领回来，
     * 而不是逼他再建第三个。
     */
    const occupied = new Set(
      [state.hero?.left, state.hero?.right].filter((slotBotId): slotBotId is string => typeof slotBotId === 'string'),
    )
    const reusable = state.bots.find(candidate =>
      !candidate.isMain && !occupied.has(candidate.id)
      && candidate.name === preset.name && candidate.role === preset.role,
    )
    if (reusable !== undefined) {
      actions.assignHeroSlot(slot, reusable.id)
      return
    }
    if (summoning.current) return
    summoning.current = true
    void (async () => {
      try {
        const created = await actions.createBot({
          name: preset.name,
          role: preset.role,
          description: preset.description,
          instructions: preset.instructions,
          avatar: preset.avatar,
          stickerMode: preset.stickerMode,
          proactive: preset.proactive,
        })
        actions.assignHeroSlot(slot, created.id)
      } finally {
        summoning.current = false
      }
    })()
  }, [actions, bot, preset, slot, state.bots, state.hero?.left, state.hero?.right])

  const selected = bot !== undefined && ui.selectedBotId === bot.id && ui.selectedRoomId === null

  return (
    <div
      className="pa-hero-slot"
      data-slot={slot}
      data-empty={bot === undefined ? 'true' : 'false'}
      data-dragging={drag === null ? 'false' : 'true'}
      data-selected={selected ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      title={bot !== undefined ? bot.name : `召唤 ${preset.name} · ${preset.role}`}
      style={drag === null ? undefined : { transform: `translate(${drag.dx}px, ${drag.dy}px)` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { endGesture(); setDrag(null) }}
      onClick={onClick}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick() } }}
    >
      <BotAvatar avatar={bot?.avatar ?? preset.avatar} size={40} muted={bot === undefined || !bot.enabled} />
      <span className="pa-hero-slot__name">{bot?.name ?? preset.name}</span>
    </div>
  )
}
