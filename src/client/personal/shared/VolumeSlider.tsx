/**
 * Personal Agent — 音量滑条（通话弹层与会话头自动播报浮层共用）。
 *
 * ## 为什么自绘轨道
 * 用户要求「拖动条要有明显的粗细变化」：**已选段（当前音量）粗、未选段细**，
 * 用粗细而不是颜色表达音量位置——此前已按用户要求把填充色去掉，现在把「哪一段
 * 是亮的」这层信息交给粗细承担，两段都保持单色。
 *
 * 原生 `input[type=range]` 的 track 伪元素只能画一条等高的线，画不出两段不同
 * 粗细；所以视觉层拆成两个节点（粗填充段 / 细剩余段）画在 range 下面，
 * range 本身仍是真的 range——键盘步进、触摸拖动、无障碍语义一项不少。
 *
 * ## 为什么两处共用同一个组件
 * 通话弹层里那条通话音量条与会话头浮层里的朗读音量条是同一类控件。各写一套的
 * 直接后果就是「同一个界面里两条音量条手感不一样」（历史上已经出现过一次：
 * 一边有填充色、一边没有）。样式也放在 base.css 的 `.pa-vs*` 公共段，两处只
 * 通过 `--pa-vs-*` 变量指定颜色与底色。
 *
 * ## 几何对齐（改样式时必须保留）
 * 圆点直径 14px → 圆点中心的可移动区间是「控件宽度 - 14px」，即左右各内缩 7px。
 * 自绘轨道用同样的 7px 内缩，百分比才与 range 的值一一对应；改了圆点尺寸就要
 * 同步改 base.css 里 `.pa-vs__track` 的左右内缩与 `.pa-vs__input` 的 thumb 尺寸。
 */
import type { ChangeEvent, CSSProperties } from 'react'

export interface VolumeSliderProps {
  /** 0–100 的整数百分比（组件内部再钳一次，防止调用方传越界值）。 */
  value: number
  /** 拖动 / 键盘调节后的新百分比（0–100）。 */
  onChange: (value: number) => void
  /** 读屏用的控件名（如「通话音量」「朗读音量」）。 */
  ariaLabel: string
  /** 读屏读到的当前值描述（如「静音」「50%」）。 */
  valueText: string
}

export function VolumeSlider({ value, onChange, ariaLabel, valueText }: VolumeSliderProps): JSX.Element {
  const percent = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div className="pa-vs" style={{ '--pa-vs-fill': `${percent}%` } as CSSProperties}>
      {/* 视觉层：粗的已选段 + 细的未选段。纯装饰，交互全交给下面的 range。 */}
      <div className="pa-vs__track" aria-hidden="true">
        <span className="pa-vs__fill" />
        <span className="pa-vs__rest" />
      </div>
      <input
        className="pa-vs__input"
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label={ariaLabel}
        aria-valuetext={valueText}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          onChange(Number(event.target.value))
        }}
      />
    </div>
  )
}
