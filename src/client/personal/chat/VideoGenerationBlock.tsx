/**
 * Personal Agent — 视频生成块（generate_video 的 tool 块）。
 *
 * 与生图卡（ImageGenerationCard）的分工：生图卡是 Seeker 主对话的共用组件，样式
 * 体系是 dgi-stage 那一套；视频没有现成组件，这里按同样的视觉语言写一张轻量卡：
 *
 *  · running —— 「正在生成视频」+ 实时秒数 + 提示词 + 呼吸点阵。点阵刻意不用
 *    ImageGenerationCard：那个组件的标题写死成「正在生成图片」，复用会把视频说成
 *    图片；但点阵的排布（径向波、负延迟错相）与它一致，看起来是同一套。
 *  · videos  —— host 已落盘的视频，原生 `<video controls>` 直接播（走 /file 路由，
 *    支持 Range，浏览器边下边播）。多个视频纵向排列。
 *  · videoTask —— 网关返回异步任务时的 id / 状态：这时候**没有可播放文件**，
 *    给一张「视频任务已创建」卡说明原因，不挂一个永远转圈的空 <video>。
 *  · error  —— 一句人话（从工具结果里抠出来的 error/message，或兜底文案）。
 *
 * 去重：正文里已经写了同一个视频路径时（`_tmp/out.mp4` 或下载链接），工具卡不再
 * 重复播一遍 —— 与生图卡「正文有图就不再出图」同一条约定。
 */
import { useEffect, useMemo, useState } from 'react'
import { IconVideo } from '../icons.tsx'
import { errorMessageOf, pathKeyOf, pathOfFileUrl } from './media.ts'
import type { MessageBlock } from '../types.ts'

/** 点阵：11×11（与生图卡 1:1 档位同密度），径向延迟形成向外扩散的呼吸波。 */
const DOT_COLS = 11
const DOT_ROWS = 11

interface DotSpec {
  readonly key: number
  readonly delay: string
}

const DOTS: readonly DotSpec[] = (() => {
  const list: DotSpec[] = []
  for (let row = 0; row < DOT_ROWS; row += 1) {
    for (let col = 0; col < DOT_COLS; col += 1) {
      const dx = (col - (DOT_COLS - 1) / 2) / ((DOT_COLS - 1) / 2)
      const dy = (row - (DOT_ROWS - 1) / 2) / ((DOT_ROWS - 1) / 2)
      const distance = Math.sqrt(dx * dx + dy * dy)
      list.push({ key: row * DOT_COLS + col, delay: `${Math.round(distance * 620 - 1100)}ms` })
    }
  }
  return list
})()

export interface VideoGenerationBlockProps {
  readonly block: Extract<MessageBlock, { type: 'tool' }>
  /** 正文里已经出现过的产出物路径（用于视频去重）。 */
  readonly bodyPaths: readonly string[]
}

/** bot 对话里的视频块。没有可展示内容时返回 null（不占对话流位置）。 */
export function VideoGenerationBlock({ block, bodyPaths }: VideoGenerationBlockProps): JSX.Element | null {
  const run = block.run
  const running = run.status === 'running'
  const error = run.status === 'error' ? (errorMessageOf(run.result) ?? '视频生成失败') : null
  const task = run.videoTask

  const videos = useMemo(() => {
    const list = run.videos ?? []
    if (list.length === 0) return []
    const bodyKeys = new Set(bodyPaths.map(pathKeyOf))
    return list.filter((url) => {
      const path = pathOfFileUrl(url)
      // 解不出路径的（外链 / data:）一律保留：宁可贵一张，也不要吞掉用户真想要的视频。
      if (path === null) return true
      return !bodyKeys.has(pathKeyOf(path))
    })
  }, [run.videos, bodyPaths])

  /*
   * 实时秒数：只在 running 期间开 1s 的 interval（停表后立刻清掉）。
   * 用「现在 - startedAt」而不是累加计数：消息重渲染 / 卡片重新挂载都不会把
   * 已经跑过的秒数清零。
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const elapsed = running ? Math.max(0, Math.round((now - run.startedAt) / 1000)) : null

  if (!running && videos.length === 0 && task === undefined && error === null) return null

  const title = running
    ? '正在生成视频'
    : videos.length > 0
      ? '生成的视频'
      : task !== undefined
        ? '视频任务已创建'
        : '视频生成失败'
  const prompt = (run.prompt ?? '').trim()

  return (
    <div className="pa-video-gen" data-status={run.status} data-task={task !== undefined ? 'true' : 'false'}>
      <div className="pa-video-gen__head">
        <span className="pa-video-gen__badge"><IconVideo size={14} /></span>
        <span className="pa-video-gen__title">{title}</span>
        {elapsed !== null ? <span className="pa-video-gen__timer">{elapsed}s</span> : null}
      </div>
      {running && prompt !== '' ? <div className="pa-video-gen__prompt" title={prompt}>{prompt}</div> : null}
      {running ? (
        <div className="pa-video-gen__stage" aria-hidden="true">
          <div className="pa-video-gen__dots">
            {DOTS.map((dot) => <i key={dot.key} style={{ animationDelay: dot.delay }} />)}
          </div>
        </div>
      ) : null}
      {error !== null && videos.length === 0 ? <div className="pa-video-gen__error">{error}</div> : null}
      {task !== undefined && videos.length === 0 ? (
        <div className="pa-video-gen__task">
          <div className="pa-video-gen__task-row">
            <span className="pa-video-gen__task-key">任务 id</span>
            <span className="pa-video-gen__task-val" title={task.id}>{task.id}</span>
          </div>
          <div className="pa-video-gen__task-row">
            <span className="pa-video-gen__task-key">状态</span>
            <span className="pa-video-gen__task-val">{task.status}</span>
          </div>
          <div className="pa-video-gen__task-hint">网关异步生成，完成后可再查询</div>
        </div>
      ) : null}
      {videos.length > 0 ? (
        <div className="pa-video-gen__videos">
          {videos.map((url, index) => (
            <video
              key={`${url}-${index}`}
              className="pa-media__video"
              src={url}
              controls
              preload="metadata"
              playsInline
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
