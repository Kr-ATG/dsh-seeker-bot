/**
 * Personal Agent — 全屏实时通话弹层。
 *
 * `ui.call.status` 非 idle 且未最小化时覆盖整个应用：88px 头像、呼吸波纹、通话计时、
 * 双向实时转写、思考过程折叠、麦克风波形、静音 / 挂断 / 最小化（右上角）/ 通话设置。
 *
 * 这是**全双工**通话：麦克风一直上行，服务端 VAD 自动断句、自动 ASR，用户一开口
 * 就打断 Bot（`speech_started` 已在 realtime-client 里清空播放队列）。所以界面上
 * 没有「点击说话」按钮——那是半双工链路（点按录音 → ASR → 模型 → Edge TTS）的
 * 交互，已经整条移除。麦克风不可用时仍可打字（走 text 帧），会话不会因此中断。
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
import { useEffect, useRef, useState, type CSSProperties } from 'react'
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
  IconSend,
  IconSettings,
  IconSparkles,
  IconVideo,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '../icons.tsx'
import { PaSelect, type PaSelectOption } from '../shared/PaSelect.tsx'
import { usePersonal } from '../store.tsx'
import { formatDuration, voiceLabel as voiceLabelOf } from '../types.ts'
import {
  REALTIME_CONFIG_PATH,
  REALTIME_SPEED_LABELS,
  REALTIME_VOICES,
  type RealtimeSpeed,
} from '../../../shared/realtime-protocol.ts'

/** 波形条数量（奇数，左右对称）。 */
const WAVE_BARS = 25

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
 * 麦克风音量波形。
 *
 * 每帧直接改 DOM 的 transform，**不走 React state**：60fps 的 setState 会把整棵
 * Bot 应用（含 200 条消息的列表）拖到掉帧，而波形只是装饰，不值得这个代价。
 * 平滑用指数滤波：直接跟随原始 level 会一跳一跳，滤波后像真实电平表。
 */
function CallWave({ active }: { active: boolean }): JSX.Element {
  const { actions } = usePersonal()
  const barsRef = useRef<Array<HTMLSpanElement | null>>([])
  /*
   * actions 放进 ref：它会在每次 ui 变化时重建（useMemo 依赖一堆 callback），
   * 直接进 effect 依赖会让 rAF 每 120ms 被掐断重启一次，波形看起来一顿一顿的。
   */
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  useEffect(() => {
    if (!active) {
      // 停掉动画后压平，避免停在某个奇怪的形状上
      for (const bar of barsRef.current) bar?.style.setProperty('transform', 'scaleY(0.08)')
      return undefined
    }
    let frame = 0
    let smooth = 0
    const tick = (): void => {
      const level = actionsRef.current.callLevel()
      smooth = smooth * 0.65 + level * 0.35
      const shaped = Math.min(1, Math.pow(Math.max(0, smooth), 0.6) * 1.15)
      const bars = barsRef.current
      for (let index = 0; index < bars.length; index += 1) {
        const bar = bars[index]
        if (bar === null || bar === undefined) continue
        // 中间高、两边低，再叠一点随机，看起来才像被声音推动的波形
        const center = 1 - Math.abs(index - (bars.length - 1) / 2) / ((bars.length - 1) / 2)
        const value = Math.max(0.08, Math.min(1, shaped * (0.3 + center * 0.95) * (0.72 + Math.random() * 0.56)))
        bar.style.transform = `scaleY(${value.toFixed(3)})`
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [active])

  return (
    <div className="pa-call__wave" data-on={active ? 'true' : 'false'} aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, index) => (
        <span
          key={index}
          ref={(node) => {
            barsRef.current[index] = node
          }}
        />
      ))}
    </div>
  )
}

export function CallOverlay(): JSX.Element | null {
  const { state, ui, actions } = usePersonal()
  const [now, setNow] = useState(() => Date.now())
  const [typed, setTyped] = useState('')
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 全局语速档位；null = 还没从宿主读到（此时控件禁用，避免误显示成「正常」）。 */
  const [speed, setSpeed] = useState<RealtimeSpeed | null>(null)
  const [speedBusy, setSpeedBusy] = useState(false)
  const turnsRef = useRef<HTMLDivElement | null>(null)

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
  /** 轨道已填充比例：CSS 变量给 ::-webkit-slider-runnable-track 的渐变用。 */
  const volumeFillStyle = { '--pa-call-vol-fill': `${volumePercent}%` } as unknown as CSSProperties

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

  const submitTyped = (): void => {
    const value = typed.trim()
    if (value === '') return
    setTyped('')
    actions.callUserTurn(value)
  }

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
      onClick={(event) => {
        /*
         * 点卡片外的遮罩 = 最小化通话，而不是挂断。
         *
         * 通话是「一直在进行」的，挂断是破坏性动作，不该因为点了一下旁边就发生；
         * 最小化后右栏顶部有恢复入口，随时能回来。只认 `target === currentTarget`，
         * 卡片内部的点击照常冒泡给按钮，不会误触发。
         */
        if (event.target === event.currentTarget) actions.minimizeCall(true)
      }}
    >
      <div className="pa-call" data-state={reconnecting ? 'reconnecting' : call.status}>
        <button className="pa-call__minimize" type="button" title="最小化" aria-label="最小化" onClick={() => actions.minimizeCall(true)}>
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
          * 又不能挤到下面的输入框和静音/挂断（矮屏下整块 .pa-call 可滚动）。
          *
          * 刻意**不带任何按钮、也不禁用麦克风与输入框**：任务与对话是并行的，用户
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
                        ? '麦克风不可用，可以直接打字提问'
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
              * 调音量是通话中的高频动作，折叠起来要多点两下；这一行只有 30px 高。
              * 拖到 0 显示「静音」而不是 0%：要让用户明确知道是「听不见」，不是数字坏了。
              * 上行麦克风不在这里调：浏览器 autoGainControl 已经管了，叠增益会干扰 VAD。
              */}
            <div className="pa-call__volume">
              <span className="pa-call__volume-icon" aria-hidden="true">
                {volumePercent === 0 ? <IconVolumeOff size={14} /> : <IconVolume size={14} />}
              </span>
              <input
                className="pa-call__volume-range"
                type="range"
                min={0}
                max={100}
                step={1}
                value={volumePercent}
                style={volumeFillStyle}
                onChange={(event) => actions.setCallVolume(Number(event.target.value) / 100)}
                aria-label="通话音量"
                aria-valuetext={volumePercent === 0 ? '静音' : `${volumePercent}%`}
              />
              <span className="pa-call__volume-value" data-muted={volumePercent === 0 ? 'true' : 'false'}>
                {volumePercent === 0 ? '静音' : `${volumePercent}%`}
              </span>
            </div>

            <div className="pa-call__type">
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submitTyped()
                  }
                }}
                placeholder={micBroken ? '麦克风不可用，在这里打字提问…' : '不方便说话时，也可以打字…'}
                aria-label="通话文字输入"
              />
              <button
                type="button"
                onClick={submitTyped}
                disabled={typed.trim() === '' || call.status === 'ringing'}
                title="发送"
                aria-label="发送"
              >
                <IconSend size={15} />
              </button>
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
              <button className="pa-call__ctrl pa-call__ctrl--danger" type="button" onClick={() => actions.endCall()}>
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
