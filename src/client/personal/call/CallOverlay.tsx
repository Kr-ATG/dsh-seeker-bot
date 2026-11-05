/**
 * Personal Agent — 全屏实时通话弹层。
 *
 * `ui.call.status` 非 idle 且未最小化时覆盖整个应用：88px 头像、呼吸波纹、通话计时、
 * 双向实时转写、思考过程折叠、麦克风波形、静音 / 挂断 / 最小化（右上角）/ 通话设置。
 *
 * 这是**全双工**通话：麦克风一直上行，服务端 VAD 自动断句、自动 ASR，用户一开口
 * 就打断 Bot（`speech_started` 已在 realtime-client 里清空播放队列）。所以界面上
 * 没有「点击说话」按钮——那是半双工链路（点按录音 → ASR → 模型 → Edge TTS）的
 * 交互，已经整条移除。
 *
 * 也**没有文字输入框**：原来底部那条「不方便说话时，也可以打字…」+ 发送按钮已按
 * 用户反馈整块移除。它横跨整宽、和这一列居中的胶囊控件不是一个语言，而全双工通话
 * 里打字本来就是罕见路径。麦克风不可用时只提示重试 / 挂断，不再兜底打字；store 的
 * `callUserTurn` 与宿主侧 text 帧能力保留，只是不再有界面入口。
 *
 * 两处刻意「没有」的控件：
 *  · **没有扬声器开关**：通话本来就该出声，关掉它只会让人以为坏了；播放路径在
 *    realtime-client 里始终开启。
 *  · **底部没有最小化**：右上角那颗圆钮已经是同一个动作，重复一遍只是噪音。
 *
 * 音色 / 语速放在折叠的「通话设置」里：两者都是**会话级**配置（StepFun 的 voice
 * 一旦本轮生成过音频就不能改，语速靠 instructions 描述），所以只能对下一通生效，
 * 界面上必须写清楚，否则用户点完发现声音没变会当成 bug。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import {
  IconChevronDown,
  IconCircleCheck,
  IconMic,
  IconMicOff,
  IconMinimize,
  IconPause,
  IconPhoneOff,
  IconRefresh,
  IconSettings,
  IconSparkles,
  IconVideo,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '../icons.tsx'
import { PaSelect, type PaSelectOption } from '../shared/PaSelect.tsx'
import { VolumeSlider } from '../shared/VolumeSlider.tsx'
import { usePersonal } from '../store.tsx'
import { formatDuration, voiceLabel as voiceLabelOf } from '../types.ts'
import {
  REALTIME_CONFIG_PATH,
  REALTIME_SPEED_LABELS,
  REALTIME_VOICES,
  type RealtimeSpeed,
} from '../../../shared/realtime-protocol.ts'

/** 波形点的数量（奇数，左右对称）。7 个：再少表达不出声波，再多就显密。 */
const WAVE_DOTS = 7

/**
 * 音色选项（自绘下拉用）。
 *
 * 首项空串 = 跟随全局默认（与 `Bot.voice` 的约定一致）；`hint` 会显示在选项右侧小字，
 * 用户不用背「邻家姐姐 / 清纯少女」到底适合什么场景。
 */
const VOICE_OPTIONS: PaSelectOption[] = [
  { value: '', label: '跟随全局默认' },
  ...REALTIME_VOICES.map((item) => ({ value: item.id, label: item.label, hint: item.hint })),
]

/**
 * 语速三档的展示顺序。
 *
 * 显式数组而不是 Object.keys(REALTIME_SPEED_LABELS)：后者依赖对象键的枚举顺序，
 * 哪天有人往常量里插一档，界面顺序会悄悄变。
 */
const SPEED_OPTIONS: readonly RealtimeSpeed[] = ['slow', 'normal', 'fast']

/**
 * 麦克风电平的可视化：一排随声音起伏的小圆点。
 *
 * 为什么不是传统竖条频谱：25 根带随机抖动的亮绿条是「录音软件」的语言，放在这块
 * 圆角胶囊面板里又吵又廉价（用户反馈「丑陋，要简约又优雅」）。换成少量圆点后——
 *  · 用**正弦相位**代替随机数，相邻的点有先后，动作像水波而不是噪音；
 *  · 中间的点最活跃、两端最安静，整排只占 28px 高；
 *  · 静止时就是一排安静的小点（40% 透明度的绿），不抢视线。
 *
 * 每帧直接改 DOM 的 transform / opacity，**不走 React state**：60fps 的 setState
 * 会把整棵 Bot 应用（含 200 条消息的列表）拖到掉帧，而它们只是装饰。
 * 平滑用指数滤波：直接跟随原始 level 会一跳一跳；滤波后像真实的呼吸。
 */
function CallWave({ active }: { active: boolean }): JSX.Element {
  const { actions } = usePersonal()
  const dotsRef = useRef<Array<HTMLSpanElement | null>>([])
  /*
   * actions 放进 ref：它会在每次 ui 变化时重建（useMemo 依赖一堆 callback），
   * 直接进 effect 依赖会让 rAF 每 120ms 被掐断重启一次，点阵看起来一顿一顿的。
   */
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  useEffect(() => {
    if (!active) {
      /*
       * 停掉动画后回到静止态，而不是停在某个奇怪的形状上。
       * 清掉 inline style 让 CSS 的基线（opacity 0.4 / 无缩放）接管。
       */
      for (const dot of dotsRef.current) {
        if (dot === null) continue
        dot.style.transform = ''
        dot.style.opacity = ''
      }
      return undefined
    }
    let frame = 0
    let smooth = 0
    const started = performance.now()
    const tick = (): void => {
      const raw = actionsRef.current.callLevel()
      // 上行滤波比旧版更慢（0.86）：点阵要「优雅地跟随」，而不是抖成电平表
      smooth = smooth * 0.86 + Math.max(0, Math.min(1, raw)) * 0.14
      const time = (performance.now() - started) / 1000
      const dots = dotsRef.current
      for (let index = 0; index < dots.length; index += 1) {
        const dot = dots[index]
        if (dot === null || dot === undefined) continue
        /*
         * 包络：中间的点能量最大、两端最小（center: 0..1）。
         * `pow(smooth, 0.62)` 把「正常说话」那点电平抬起来——原始 level 大多只有
         * 0.1~0.4，线性映射的话点几乎不动，看着像坏了。
         */
        const center = 1 - Math.abs(index - (dots.length - 1) / 2) / ((dots.length - 1) / 2)
        const energy = Math.min(1, Math.pow(smooth, 0.62) * (0.45 + center * 0.85))
        // 相位错开：相邻点一前一后，整排像水波推过去，而不是一起跳
        const sway = Math.sin(time * 6.2 + index * 0.85)
        // 幅度克制：大小只放大到 2 倍出头，主要靠上下浮动表达「声音在流动」
        const scale = 1 + energy * (0.45 + (sway * 0.5 + 0.5) * 0.75)
        const lift = energy * (2.4 + center * 5.6) * sway
        dot.style.transform = `translateY(${(-lift).toFixed(2)}px) scale(${scale.toFixed(3)})`
        dot.style.opacity = (0.4 + energy * 0.55).toFixed(3)
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [active])

  return (
    <div className="pa-call__wave" data-on={active ? 'true' : 'false'} aria-hidden="true">
      {Array.from({ length: WAVE_DOTS }, (_, index) => (
        <span
          key={index}
          ref={(node) => {
            dotsRef.current[index] = node
          }}
        />
      ))}
    </div>
  )
}

export function CallOverlay(): JSX.Element | null {
  const { state, ui, actions } = usePersonal()
  const [now, setNow] = useState(() => Date.now())
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 全局语速档位；null = 还没从宿主读到（此时控件禁用，避免误显示成「正常」）。 */
  const [speed, setSpeed] = useState<RealtimeSpeed | null>(null)
  const [speedBusy, setSpeedBusy] = useState(false)
  const turnsRef = useRef<HTMLDivElement | null>(null)

  /*
   * 退场状态：最小化 / 挂断都先播 240ms 退场，播完再真正收层。
   *
   * 这两条入口原来都是直接切 store 状态（minimizeCall / endCall），组件在下一帧就
   * 被顶部的 `idle || minimized` 早退摘掉——入场是 180ms 淡入 + 220ms 弹入，出场
   * 却是硬消失，关一下就「啪」地断掉。时长与曲线对齐 modal-animation.ts 的
   * MODAL_ANIM_MS（240ms、出场加速曲线），整套插件才是同一套手感。
   */
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  /** 退场播完后要执行的真正关闭动作（最小化与挂断两种入口共用一条定时器）。 */
  const pendingCloseRef = useRef<(() => void) | null>(null)

  /**
   * 关闭：先播 240ms 退场，再真正卸载 / 最小化（直接切状态会硬消失）。
   *
   * 传进来的 action 才是原关闭动作：点遮罩与右上角按钮是最小化，挂断是 endCall。
   * 定时器已挂上时直接返回，连点两下不会排两条。
   */
  const requestClose = useCallback((action: () => void): void => {
    if (closeTimerRef.current !== null) return
    pendingCloseRef.current = action
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setClosing(false)
      const run = pendingCloseRef.current
      pendingCloseRef.current = null
      if (run !== null) run()
    }, 240)
  }, [])

  /* 卸载时清定时器：通话可能被宿主 onClosed 自己收掉，别让回调打在已卸载的组件上。 */
  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  const call = ui.call
  const bot = call.botId !== null ? state.bots.find((item) => item.id === call.botId) ?? null : null
  const active = call.status !== 'idle' && call.status !== 'ended'
  const reconnecting = call.realtime.phase === 'reconnecting'
  const micBroken = call.realtime.micError !== undefined
  /** 语音里「让 Bot 干活」的当前任务（无任务时 undefined）。 */
  const task = call.realtime.task

  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, call.startedAt])

  /* 转写自动滚到底：用户在看字幕，新内容进来必须可见。 */
  useEffect(() => {
    const element = turnsRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [call.liveTurns, call.botDraft, call.thinkingDraft])

  /*
   * 展开设置区时读一次全局语速（`GET /api/personal-agent/realtime/config`）。
   *
   * 只在第一次展开时拉：语速是全局配置，通话期间不会变；重复拉只会多打一次宿主。
   * 失败（独立演示页 / 宿主没挂路由）就保持 null，控件禁用但不报错——设置区打不开
   * 不该打断正在进行的通话。
   */
  useEffect(() => {
    if (!settingsOpen || speed !== null) return undefined
    let alive = true
    void (async () => {
      try {
        const response = await fetch(REALTIME_CONFIG_PATH)
        if (!response.ok) return
        const data = (await response.json()) as {
          ok?: boolean
          config?: { speed?: RealtimeSpeed }
          defaults?: { speed?: RealtimeSpeed }
        }
        if (!alive) return
        setSpeed(data.config?.speed ?? data.defaults?.speed ?? 'normal')
      } catch {
        /* 宿主不可用：保持禁用态 */
      }
    })()
    return () => {
      alive = false
    }
  }, [settingsOpen, speed])

  if (call.status === 'idle' || call.minimized) return null

  /*
   * 三个关闭入口都走 requestClose：先播退场，播完再最小化 / 挂断。
   * 通话本身在退场这 240ms 里照常进行（音频不断），只是这一层在渐隐。
   */
  const minimizeCall = (): void => { requestClose(() => actions.minimizeCall(true)) }
  const hangUp = (): void => { requestClose(() => actions.endCall()) }

  const elapsed = active ? Math.max(0, now - call.startedAt) : 0
  const clock = formatDuration(elapsed)
  const modelLabel = call.realtime.model !== '' ? call.realtime.model : '实时语音'
  // 显示中文音色名（用户不该看到 linjiajiejie 这种 id）；未知 id 原样显示
  const voiceLabel = call.realtime.voice !== '' ? voiceLabelOf(call.realtime.voice) : '默认音色'
  const expiresMinutes = call.realtime.expiresInMs === undefined
    ? null
    : Math.max(1, Math.round(call.realtime.expiresInMs / 60_000))
  /*
   * 通话音量（0..1）：`call.volume` 是持久化偏好，正常情况下总有值；这里再兜一层
   * 非法值，避免旧状态/测试桩传进来把滑块的 value 变成 NaN。
   */
  const volume = Number.isFinite(call.volume) ? Math.max(0, Math.min(1, call.volume)) : 1
  const volumePercent = Math.round(volume * 100)

  const statusText = ((): string => {
    if (reconnecting) return '连接中断，正在重连…'
    switch (call.status) {
      case 'ringing':
        return '正在接通…'
      case 'listening':
        return `在听你说 · ${clock}`
      case 'thinking':
        return `正在想… · ${clock}`
      case 'speaking':
        return `正在说… · ${clock}`
      case 'ended':
        return '通话已结束'
      default:
        return ''
    }
  })()

  /**
   * 改全局语速：`POST /realtime/config`（宿主只收白名单字段，speed 三选一）。
   *
   * 乐观更新 + 失败回滚：这是本地宿主，正常 10ms 内就返回；等往返再切会有「按了没
   * 反应」的错觉。失败必须把旧值放回去并 toast，不能假装成功。
   */
  const changeSpeed = (next: RealtimeSpeed): void => {
    const previous = speed
    setSpeed(next)
    setSpeedBusy(true)
    void (async () => {
      try {
        const response = await fetch(REALTIME_CONFIG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ speed: next }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = (await response.json()) as { ok?: boolean; config?: { speed?: RealtimeSpeed } }
        if (data.ok === false) throw new Error('宿主拒绝写入')
        if (data.config?.speed !== undefined) setSpeed(data.config.speed)
      } catch {
        setSpeed(previous)
        actions.toast('语速没保存成功，稍后再试')
      } finally {
        setSpeedBusy(false)
      }
    })()
  }

  /** 改当前 Bot 的音色：存在 Bot 记录里，下一通 start 帧带上去。 */
  const changeVoice = (value: string): void => {
    if (call.botId === null) return
    actions.updateBot(call.botId, { voice: value === '' ? undefined : value })
    const label = value === '' ? '' : REALTIME_VOICES.find((item) => item.id === value)?.label ?? value
    actions.toast(value === '' ? '已改为跟随全局默认，下一通电话生效' : `音色已改为「${label}」，下一通电话生效`)
  }

  const currentVoice = bot?.voice ?? ''
  const voiceHint = REALTIME_VOICES.find((item) => item.id === currentVoice)?.hint ?? ''

  /**
   * 任务状态条的两行文字。
   *
   * running 且没有进度 note 时补一句「你可以继续说别的」：全双工是这条链路的硬约定，
   * 不写清楚，用户会以为「它在忙，我先别说话」而干等——实际上任务在后台跑，随时
   * 可以继续问、继续打断。
   */
  const taskTitle = task === undefined
    ? ''
    : task.phase === 'running'
      ? `正在执行：${task.label}`
      : task.phase === 'done'
        ? `已完成：${task.label}`
        : `执行失败：${task.label}`
  const taskNote = ((): string => {
    if (task === undefined) return ''
    const note = (task.note ?? '').trim()
    if (note !== '') return note
    return task.phase === 'running' ? '任务在后台跑，你可以继续说别的' : ''
  })()

  return (
    <div
      className="pa-call-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="实时语音通话"
      data-closing={closing ? '1' : undefined}
      onClick={(event) => {
        /*
         * 点卡片外的遮罩 = 最小化通话，而不是挂断。
         *
         * 通话是「一直在进行」的，挂断是破坏性动作，不该因为点了一下旁边就发生；
         * 最小化后右栏顶部有恢复入口，随时能回来。只认 `target === currentTarget`，
         * 卡片内部的点击照常冒泡给按钮，不会误触发。
         */
        if (event.target === event.currentTarget) minimizeCall()
      }}
    >
      <div className="pa-call" data-state={reconnecting ? 'reconnecting' : call.status}>
        <button className="pa-call__minimize" type="button" title="最小化" aria-label="最小化" onClick={minimizeCall}>
          <IconMinimize size={16} />
        </button>
        <span className="pa-call__encrypted" title={`模型 ${modelLabel} · 音色 ${voiceLabel}`}>
          {modelLabel} · {voiceLabel}
        </span>

        <div className="pa-call__layout">
          <div className="pa-call__side">
        <div className="pa-call__avatar-wrap">
          <span className="pa-call__pulse" />
          <span className="pa-call__pulse" />
          <span className="pa-call__pulse" />
          <div className="pa-call__avatar">
            {bot !== null ? <BotAvatar avatar={bot.avatar} size={88} /> : null}
          </div>
        </div>
        <div className="pa-call__name">{bot?.name ?? '实时语音'}</div>
        <div className="pa-call__state" data-status={reconnecting ? 'reconnecting' : call.status} aria-live="polite">
          <span className="pa-call__dot" />
          {statusText}
        </div>

        {expiresMinutes !== null ? (
          <div className="pa-call__notice" data-kind="warn" role="status">
            单次通话最长 30 分钟，约 {expiresMinutes} 分钟后自动结束
          </div>
        ) : null}
        {call.realtime.error !== undefined ? (
          <div className="pa-call__notice" data-kind="error" role="alert">{call.realtime.error}</div>
        ) : null}
        {micBroken ? (
          <div className="pa-call__notice" data-kind="warn" role="status">
            <span>麦克风不可用：{call.realtime.micError}</span>
            <button className="pa-call__notice-btn" type="button" onClick={() => actions.retryCallMicrophone()}>
              <IconRefresh size={11} />
              重试麦克风
            </button>
          </div>
        ) : null}

        {/*
          * 语音里「让 Bot 干活」的状态条（宿主 task_started / task_progress / task_done）。
          *
          * 位置在提示条与转写区之间：它是「此刻正在发生的事」，比转写更该被一眼看到，
          * 又不能挤到下面的音量与静音/挂断（矮屏下整块 .pa-call 可滚动）。
          *
          * 刻意**不带任何按钮、也不禁用麦克风与音量**：任务与对话是并行的，用户
          * 随时可以继续说下一句或打断。结束态由 store 停留几秒后自动收起。
          */}
        {task !== undefined ? (
          <div
            className="pa-call__task"
            data-phase={task.phase}
            data-fading={task.fading === true ? 'true' : 'false'}
            role="status"
            aria-live="polite"
          >
            <span className="pa-call__task-icon" aria-hidden="true">
              {task.phase === 'running'
                ? <span className="pa-call__task-spinner" />
                : task.phase === 'done' ? <IconCircleCheck size={13} /> : <IconX size={13} />}
            </span>
            <div className="pa-call__task-main">
              <div className="pa-call__task-title">{taskTitle}</div>
              {taskNote !== '' ? <div className="pa-call__task-note">{taskNote}</div> : null}
            </div>
          </div>
        ) : null}

            <div className="pa-call__audio">
              <CallWave active={active && call.status !== 'ringing' && !call.muted && !micBroken && call.realtime.micReady === true} />
              <div className="pa-call__audio-note">
                {reconnecting
                  ? '网络抖了一下，正在自动重连（只重试一次）'
                  : call.status === 'ringing'
                    ? '正在建立实时语音会话…'
                    : call.muted
                      ? '已静音，说话不会被听见'
                      : micBroken
                        ? '麦克风不可用，重试或直接挂断'
                        : call.realtime.micReady !== true
                          ? '正在打开麦克风（浏览器可能会询问权限）…'
                          : call.status === 'speaking'
                            ? '它在说话；你直接开口就能打断它'
                            : '直接说话，说完它会自己接话'}
              </div>
              {call.status === 'speaking' ? (
                <button className="pa-call__interrupt" type="button" onClick={() => actions.interruptCall()}>
                  <IconPause size={13} />
                  打断
                </button>
              ) : null}
            </div>

            {/*
              * 通话音量：控制 Bot 声音（下行）的播放增益，常驻而不是塞进「通话设置」——
              * 调音量是通话中的高频动作，折叠起来要多点两下。
              *
              * 形态是**居中胶囊**（图标 + 细轨道 + 数值），不是一条横跨整宽的裸滑块：
              * 这一列的元素全是居中成组的胶囊，通栏滑块看着像从别的界面借来的控件
              * （用户实机截图反馈「很丑、不协调」）。
              * 拖到 0 显示「静音」而不是 0%，图标换成静音喇叭：要让用户明确知道是
              * 「听不见」，不是数字坏了。
              * 轨道是**单色**的，不带填充色（用户要求「音量条里面的颜色去掉」）：音量
              * 由滑块位置与右侧数值表达，胶囊里不再出现第二种颜色。
              * 上行麦克风不在这里调：浏览器 autoGainControl 已经管了，叠增益会干扰 VAD。
              */}
            <div className="pa-call__volume">
              <span className="pa-call__volume-icon" aria-hidden="true">
                {volumePercent === 0 ? <IconVolumeOff size={14} /> : <IconVolume size={14} />}
              </span>
              {/* 与会话头朗读音量共用同一个滑条：粗细表达音量（已选段粗 / 未选段细）。 */}
              <VolumeSlider
                value={volumePercent}
                onChange={(next) => actions.setCallVolume(next / 100)}
                ariaLabel="通话音量"
                valueText={volumePercent === 0 ? '静音' : `${volumePercent}%`}
              />
              <span className="pa-call__volume-value">
                {volumePercent === 0 ? '静音' : `${volumePercent}%`}
              </span>
            </div>

            {/*
              * 通话设置：音色 / 语速都是**会话级**配置，改完只对下一通生效。
              * 默认收起——常驻会把左栏的控制按钮挤下去。
              */}
            <div className="pa-call__settings">
              <button
                className="pa-call__settings-toggle"
                type="button"
                aria-expanded={settingsOpen}
                data-open={settingsOpen ? 'true' : 'false'}
                onClick={() => setSettingsOpen((value) => !value)}
              >
                <IconSettings size={13} />
                <span>通话设置</span>
                <IconChevronDown size={12} />
              </button>
              {settingsOpen ? (
                <div className="pa-call__settings-body">
                  <div className="pa-call__field">
                    <span className="pa-call__field-label">音色</span>
                    <PaSelect
                      className="pa-call__voice-select"
                      value={currentVoice}
                      options={VOICE_OPTIONS}
                      onChange={changeVoice}
                      disabled={call.botId === null}
                      ariaLabel="通话音色"
                    />
                  </div>
                  {voiceHint !== '' ? <div className="pa-call__field-hint">{voiceHint}</div> : null}
                  <div className="pa-call__field">
                    <span className="pa-call__field-label">语速</span>
                    <div className="pa-call__seg" role="group" aria-label="语速">
                      {SPEED_OPTIONS.map((item) => (
                        <button
                          key={item}
                          type="button"
                          data-on={speed === item ? 'true' : 'false'}
                          disabled={speed === null || speedBusy}
                          onClick={() => changeSpeed(item)}
                        >
                          {REALTIME_SPEED_LABELS[item]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="pa-call__settings-hint">
                    音色与语速在<b>下一通</b>电话生效（服务端会话内不允许改）。语速靠指令提示模型，不是播放变速。
                  </p>
                </div>
              ) : null}
            </div>

            <div className="pa-call__controls">
              <button className="pa-call__ctrl" type="button" data-on={call.muted ? 'true' : 'false'} onClick={() => actions.setCallMuted(!call.muted)}>
                <span className="pa-call__ctrl-icon">{call.muted ? <IconMicOff size={20} /> : <IconMic size={20} />}</span>
                静音
              </button>
              <button className="pa-call__ctrl" type="button" data-disabled="true" disabled title="视频通话暂未开放">
                <span className="pa-call__ctrl-icon"><IconVideo size={20} /></span>
                视频
              </button>
              <button className="pa-call__ctrl pa-call__ctrl--danger" type="button" onClick={hangUp}>
                <span className="pa-call__ctrl-icon"><IconPhoneOff size={20} /></span>
                挂断
              </button>
            </div>
          </div>

          {/* 右栏：实时转写 + 思考过程（独立滚动，不挤压左栏的呼叫控制） */}
          <div className="pa-call__transcript">
            <div className="pa-call__transcript-head">
              <span className="pa-call__transcript-title">实时转写</span>
              <span className="pa-call__transcript-count">
                {call.liveTurns.length > 0 ? `${call.liveTurns.length} 轮` : '等待第一句'}
              </span>
            </div>
            <div className="pa-call__turns" ref={turnsRef}>
          {call.liveTurns.length === 0 && call.botDraft === '' ? (
            <div className="pa-call__empty">
              {call.status === 'ringing' ? '正在接通实时语音…' : '直接说话就行，服务端会自动断句并转写在这里'}
            </div>
          ) : null}
          {call.liveTurns.map((turn) => (
            <div className="pa-call__turn" data-role={turn.role} key={turn.id}>
              <div className="pa-call__turn-label">
                {turn.role === 'user' ? <IconMic size={10} /> : null}
                <span>{turn.role === 'user' ? '我' : (bot?.name ?? '对方')}</span>
              </div>
              <div>{turn.text}</div>
            </div>
          ))}
          {call.botDraft !== '' ? (
            <div className="pa-call__turn" data-role="bot" data-live="true">
              <div className="pa-call__turn-label">
                <span>{bot?.name ?? '对方'}</span>
                <span className="pa-call__live-tag">{call.status === 'speaking' ? '正在说' : '生成中'}</span>
              </div>
              <div>
                {call.botDraft}
                <span className="pa-call__caret" />
              </div>
            </div>
          ) : null}
        </div>

        {call.thinkingDraft !== '' ? (
          <div className="pa-call__think">
            <button
              className="pa-call__think-toggle"
              type="button"
              aria-expanded={thinkingOpen}
              data-open={thinkingOpen ? 'true' : 'false'}
              onClick={() => setThinkingOpen((value) => !value)}
            >
              <IconSparkles size={11} />
              <span>思考过程</span>
              <IconChevronDown size={11} />
            </button>
            {thinkingOpen ? <div className="pa-call__think-body">{call.thinkingDraft}</div> : null}
          </div>
        ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
