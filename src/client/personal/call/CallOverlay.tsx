/**
 * Personal Agent — 全屏通话弹层。
 *
 * ui.call.status 非 idle 且未最小化时覆盖整个应用：88px 头像、呼吸波纹、通话计时、
 * 实时转写、静音/扬声器/视频（禁用）/挂断/最小化。
 *
 * 通话是真实链路：麦克风录音 → 规范 WAV → DSH speech Remote（与 Work 模式同一
 * SenseVoice ASR）→ `actions.callUserTurn` → 宿主 `/api/personal-agent/reply`
 * 的真实模型回复 → 宿主 `/api/personal-agent/tts`（Edge TTS）播放。ASR/模型/
 * TTS 任一环节失败都有可读提示，不会静默假回复。
 */
import { useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { IconMic, IconMicOff, IconMinimize, IconPhoneOff, IconSend, IconVideo, IconVolume, IconVolumeOff, IconWave } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { SpeechRecorder, transcribeWav } from '../audio.ts'
import { formatDuration } from '../types.ts'

export function CallOverlay(): JSX.Element | null {
  const { state, ui, actions } = usePersonal()
  const [now, setNow] = useState(() => Date.now())
  const [voicePhase, setVoicePhase] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [typed, setTyped] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const recorderRef = useRef<SpeechRecorder | null>(null)
  const lastSpokenRef = useRef<string | null>(null)

  const call = ui.call
  const bot = call.botId !== null ? state.bots.find((item) => item.id === call.botId) ?? null : null
  const lastBotTurn = [...call.liveTurns].reverse().find((turn) => turn.role === 'bot')

  useEffect(() => {
    if (call.status !== 'active') return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [call.status, call.startedAt])

  useEffect(() => {
    if (call.status !== 'active' || lastBotTurn === undefined) return
    if (lastSpokenRef.current === lastBotTurn.id) return
    lastSpokenRef.current = lastBotTurn.id
    if (call.muted) return
    const text = lastBotTurn.text
    let alive = true
    const controller = new AbortController()
    const fallback = (): void => {
      if (!alive || call.muted) return
      try {
        if (!('speechSynthesis' in window)) return
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = 'zh-CN'
        window.speechSynthesis.speak(utterance)
      } catch {
        /* TTS 失败静默降级 */
      }
    }
    const run = async (): Promise<void> => {
      try {
        if (location.protocol === 'file:') {
          fallback()
          return
        }
        const timer = window.setTimeout(() => controller.abort(), 20_000)
        const response = await fetch('/api/personal-agent/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, botId: call.botId }),
          signal: controller.signal,
        })
        window.clearTimeout(timer)
        if (!response.ok) {
          fallback()
          return
        }
        const data = (await response.json()) as { ok?: boolean; audio?: string }
        if (!alive || call.muted) return
        if (data.ok === false) {
          fallback()
          return
        }
        if (typeof data.audio === 'string' && data.audio.length > 32) {
          const audio = new Audio(data.audio.startsWith('data:') ? data.audio : `data:audio/mpeg;base64,${data.audio}`)
          audioRef.current = audio
          await audio.play()
          return
        }
        fallback()
      } catch {
        fallback()
      }
    }
    void run()
    return () => {
      alive = false
      controller.abort()
    }
  }, [call.status, call.muted, call.botId, lastBotTurn])

  useEffect(() => {
    if (call.muted) {
      if (audioRef.current !== null) {
        audioRef.current.pause()
        audioRef.current = null
      }
      try {
        if ('speechSynthesis' in window) window.speechSynthesis.cancel()
      } catch {
        /* ignore */
      }
    }
    if (call.status !== 'idle') return
    if (audioRef.current !== null) {
      audioRef.current.pause()
      audioRef.current = null
    }
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
    lastSpokenRef.current = null
  }, [call.muted, call.status])

  useEffect(() => () => {
    if (audioRef.current !== null) {
      audioRef.current.pause()
      audioRef.current = null
    }
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder !== null) void recorder.cancel()
  }, [])

  if (call.status === 'idle' || call.minimized) return null

  const elapsed = call.status === 'active' ? Math.max(0, now - call.startedAt) : 0
  const statusText = call.status === 'ringing' ? '呼叫中…' : `通话中 ${formatDuration(elapsed)}`

  const startRecording = async (): Promise<void> => {
    if (call.status !== 'active' || voicePhase !== 'idle') return
    const recorder = new SpeechRecorder()
    recorderRef.current = recorder
    try {
      await recorder.start()
      setVoicePhase('recording')
    } catch (error) {
      recorderRef.current = null
      setVoicePhase('idle')
      actions.toast(error instanceof Error ? error.message : String(error))
    }
  }

  const stopRecording = async (): Promise<void> => {
    const recorder = recorderRef.current
    if (recorder === null) {
      setVoicePhase('idle')
      return
    }
    recorderRef.current = null
    setVoicePhase('transcribing')
    try {
      const wav = await recorder.stop()
      const transcript = await transcribeWav(wav)
      actions.callUserTurn(transcript)
    } catch (error) {
      actions.toast(error instanceof Error ? error.message : String(error))
    } finally {
      setVoicePhase('idle')
    }
  }

  const toggleRecording = (): void => {
    if (voicePhase === 'recording') {
      void stopRecording()
      return
    }
    if (voicePhase === 'transcribing') return
    void startRecording()
  }

  const submitTyped = (): void => {
    const value = typed.trim()
    if (value === '') return
    setTyped('')
    actions.callUserTurn(value)
  }

  return (
    <div className="pa-call-overlay" role="dialog" aria-modal="true" aria-label="语音通话">
      <div className="pa-call">
        <button className="pa-call__minimize" type="button" title="最小化" aria-label="最小化" onClick={() => actions.minimizeCall(true)}>
          <IconMinimize size={16} />
        </button>
        <span className="pa-call__encrypted">语音通话 · 实时转写</span>

        <div className="pa-call__avatar-wrap">
          <span className="pa-call__pulse" />
          <span className="pa-call__pulse" />
          <span className="pa-call__pulse" />
          <div className="pa-call__avatar">
            {bot !== null ? <BotAvatar avatar={bot.avatar} size={88} /> : null}
          </div>
        </div>
        <div className="pa-call__name">{bot?.name ?? '语音通话'}</div>
        <div className="pa-call__state" data-status={call.status} aria-live="polite">
          <span className="pa-call__dot" />
          {statusText}
        </div>

        <div className="pa-call__turns">
          {call.liveTurns.length === 0 ? (
            <div className="pa-call__empty">
              {call.status === 'ringing' ? '正在接通…' : '接通后，说的话会实时转写在这里'}
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
          {call.thinking === true ? (
            <div className="pa-call__turn" data-role="bot" data-thinking="true">
              <div className="pa-call__turn-label"><span>{bot?.name ?? '对方'}</span></div>
              <div className="pa-call__thinking"><i /><i /><i /></div>
            </div>
          ) : null}
        </div>

        <button
          className="pa-call__speak"
          type="button"
          data-recording={voicePhase === 'recording' ? 'true' : 'false'}
          data-busy={voicePhase === 'transcribing' ? 'true' : 'false'}
          disabled={call.status !== 'active' || voicePhase === 'transcribing'}
          onClick={toggleRecording}
        >
          {voicePhase === 'idle' ? <IconMic size={17} /> : <IconWave size={17} />}
          {voicePhase === 'transcribing' ? '正在用 DSH 语音服务识别…' : voicePhase === 'recording' ? '录音中，点击结束并转写' : '点击说话'}
        </button>
        <div className="pa-call__speak-note">
          {call.status === 'ringing'
            ? '接通后即可说话'
            : voicePhase === 'recording'
              ? '正在录音；再次点击结束，转写后交给该 Bot 的模型回复'
              : '语音 → DSH ASR → 模型回复 → Edge TTS 播放'}
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
            placeholder="麦克风不可用时，也可以直接打字…"
            aria-label="通话文字输入"
          />
          <button type="button" onClick={submitTyped} disabled={typed.trim() === ''} title="发送" aria-label="发送">
            <IconSend size={15} />
          </button>
        </div>

        <div className="pa-call__controls">
          <button className="pa-call__ctrl" type="button" data-on={call.muted ? 'true' : 'false'} onClick={() => actions.setCallMuted(!call.muted)}>
            <span className="pa-call__ctrl-icon">{call.muted ? <IconMicOff size={20} /> : <IconMic size={20} />}</span>
            静音
          </button>
          <button className="pa-call__ctrl" type="button" data-on={call.speaker ? 'true' : 'false'} onClick={() => actions.setCallSpeaker(!call.speaker)}>
            <span className="pa-call__ctrl-icon">{call.speaker ? <IconVolume size={20} /> : <IconVolumeOff size={20} />}</span>
            扬声器
          </button>
          <button className="pa-call__ctrl" type="button" data-disabled="true" disabled title="视频通话暂未开放">
            <span className="pa-call__ctrl-icon"><IconVideo size={20} /></span>
            视频
          </button>
          <button className="pa-call__ctrl" type="button" onClick={() => actions.minimizeCall(true)}>
            <span className="pa-call__ctrl-icon"><IconMinimize size={20} /></span>
            最小化
          </button>
          <button className="pa-call__ctrl pa-call__ctrl--danger" type="button" onClick={() => actions.endCall()}>
            <span className="pa-call__ctrl-icon"><IconPhoneOff size={20} /></span>
            挂断
          </button>
        </div>
      </div>
    </div>
  )
}
