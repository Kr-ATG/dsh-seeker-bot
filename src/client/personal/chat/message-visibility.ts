/**
 * Personal Agent — 消息「渲染后是否有内容」的共享判据。
 *
 * 为什么单独抽成一个模块：同一条判据有两个消费者——
 *  · MessageBlockView 决定一个块能不能渲染（2026-11-02 起普通工具卡不再显示）；
 *  · MessageList 决定一条消息要不要进对话流、要不要计入轮次结算的「N 条消息」。
 *
 * 两边各写一份的后果不是「样式不一致」，而是**统计口径和肉眼所见对不上**：一条
 * 只有 run_code 工具块（kind=progress）的消息渲染出来是空白，却会被旧判据当成
 * 可见消息，轮次脚就出现「2 条消息」而用户只看到 1 条正文（真实报障）。
 * 判据必须只有一个来源。
 *
 * 这里只依赖 Message / ToolRun 的类型，不 import 任何 React 组件，离线测试
 * （scripts/test-message-visibility.mjs）可以直接用 esbuild 打包来跑。
 */
import type { Message, ToolRun } from '../types.ts'

/**
 * 工具名 → 是否属于「在屏幕上操作」这一类。
 *
 * 只有工具名本身就是 computer / browser 一族时才转成执行态卡。ego-browser 在本
 * 项目里是通过 pwsh 跑脚本用的，工具名仍是 pwsh —— 那种留在可审计流水里（展开
 * 能看到具体命令），不在这里按参数猜：猜错会让一次普通命令执行变成一张「电脑在
 * 操作」的假卡，而真正的审计信息反而被藏起来了。
 */
export function isExecutionToolName(name: string): boolean {
  return /^(?:computer|browser|screenshot|playwright|puppeteer|chrome|devtools|cdp)/i.test(name.trim())
}

/**
 * 这一组里是不是有「独立卡片」工具：生图 / 生视频 / 正在生成文档。
 *
 * 这几类有自己的展示形态（点阵占位、播放器、产出物卡），不是普通工具卡，
 * 所以即使 2026-11-02 之后普通工具不再渲染，它们仍然保留。
 */
export function isStandaloneToolRun(run: ToolRun): boolean {
  if (run.name === 'generate_image' || run.name === 'generate_video') return true
  return run.docPending === true && run.status === 'running'
}

/**
 * 这条消息渲染出来会不会有东西。
 *
 * 与 MessageBlockView 的渲染规则一一对应：
 *  · text：trim 后非空才算（纯空白气泡是空气泡）；
 *  · tool：只有会转成执行态卡的 computer / browser 一族、以及生图 / 生视频 /
 *    文档生成占位卡算可见；其余普通工具（run_code / pwsh / read …）不渲染；
 *  · 其余块类型（image / execution / task / interactive / journal / voice /
 *    compaction / call / call-segment / connectors …）都是显式可见的块。
 *
 * 注意 pending 不在这里判断：MessageList 里「正在输入」的三点占位另有分支，
 * pending 消息即使暂时没有内容也要留在流里（见 MessageList 的 visible 过滤）。
 */
export function hasRenderableContent(message: Message): boolean {
  return message.blocks.some((block) => {
    if (block.type === 'text') return block.text.trim() !== ''
    if (block.type === 'tool') {
      return isExecutionToolName(block.run.name) || isStandaloneToolRun(block.run)
    }
    return true
  })
}
