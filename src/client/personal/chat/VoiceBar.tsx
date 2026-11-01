/**
 * Personal Agent — 语音输入条。
 *
 * 形态按参考图：一条占满输入区的深色胶囊，左「X 取消」、中间实时音量波形、
 * 右侧「停止方块 + 发送箭头」。录音时输入框整体让位给这条，转写完成后自动收起。
 *
 * 两态：
 *   recording    波形跟着麦克风实时起伏；方块可点（停止录音），箭头禁用
 *   transcribing 波形换成「正在转写…」；方块与箭头都禁用
 *
 * 转写成功即关闭语音条（文字交回输入框），所以这里没有「已完成」的停留态；
 * 发送箭头按参考图保留为录音阶段的禁用样式，真正的发送入口是输入框的发送键。
 */
import { useEffect, useRef } from 'react'
import { IconSend, IconX } from '../icons.tsx'

export type VoiceBarPhase = 'recording' | 'transcribing'

/** 竖条数量：密度接近参考图的点阵，同时保证最窄窗口也能铺满整行。 */
const BAR_COUNT = 100
/** 采样间隔（ms）：太大波形一顿一顿，太小会让 DOM 每帧重排。 */
const SAMPLE_MS = 60
/** 静音时保留的高度比例（配合 scaleY，避免改 height 触发布局）。 */
const BAR_FLOOR = 0.35

interface VoiceBarProps {
  phase: VoiceBarPhase
  /** 取当前麦克风音量（0..1）；只有录音态会被调用。 */
  level: () => number
  onCancel: () => void
  onStop: () => void
}

export function VoiceBar({ phase, level, onCancel, onStop }: VoiceBarProps): JSX.Element {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([])
  const historyRef = useRef<number[]>(new Array(BAR_COUNT).fill(0))
  const levelRef = useRef(level)
  levelRef.current = level

  useEffect(() => {
    if (phase !== 'recording') return undefined
    historyRef.current = new Array(BAR_COUNT).fill(0)
    let frame = 0
    let lastSample = 0
    let smooth = 0
    const paint = (): void => {
      const history = historyRef.current
      const bars = barsRef.current
      for (let index = 0; index < bars.length; index += 1) {
        const bar = bars[index]
        if (bar === null || bar === undefined) continue
        const value = history[index] ?? 0
        bar.style.transform = `scaleY(${(BAR_FLOOR + value * (1 - BAR_FLOOR)).toFixed(3)})`
        bar.style.opacity = (0.6 + value * 0.4).toFixed(3)
      }
    }
    const tick = (now: number): void => {
      frame = window.requestAnimationFrame(tick)
      if (now - lastSample < SAMPLE_MS) return
      lastSample = now
      const raw = levelRef.current()
      // 起音跟得快、落音稍慢，波形看起来才像真在说话。
      smooth = raw > smooth ? smooth * 0.25 + raw * 0.75 : smooth * 0.62 + raw * 0.38
      const history = historyRef.current
      history.push(smooth)
      if (history.length > BAR_COUNT) history.shift()
      paint()
    }
    paint()
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [phase])

  return (
    <div className="pa-voicebar" data-phase={phase}>
      <button className="pa-voicebar__cancel" type="button" onClick={onCancel} title="取消语音输入" aria-label="取消语音输入">
        <IconX size={16} />
      </button>

      <div className="pa-voicebar__body">
        {phase === 'recording' ? (
          <div className="pa-voicebar__wave" aria-hidden="true">
            {Array.from({ length: BAR_COUNT }, (_, index) => (
              <span
                key={index}
                ref={(element) => {
                  barsRef.current[index] = element
                }}
              />
            ))}
          </div>
        ) : (
          <div className="pa-voicebar__status" role="status">
            <span className="pa-voicebar__status-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>正在转写…</span>
          </div>
        )}
      </div>

      <div className="pa-voicebar__actions">
        <button
          className="pa-voicebar__stop"
          type="button"
          onClick={onStop}
          disabled={phase !== 'recording'}
          title="停止录音并转写"
          aria-label="停止录音并转写"
          data-hidden={phase === 'recording' ? 'false' : 'true'}
        >
          <span />
        </button>
        <button
          className="pa-voicebar__send"
          type="button"
          disabled
          title="停止后自动转成文字，用输入框的发送键发出"
          aria-label="发送（停止录音后可用输入框发送键）"
        >
          <IconSend size={18} />
        </button>
      </div>
    </div>
  )
}
