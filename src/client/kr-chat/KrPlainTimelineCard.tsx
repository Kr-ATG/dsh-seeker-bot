/**
 * dsh-seeker-bot — 「操作面板」卡（右栏大盘滚动区的一张卡）。
 *
 * 读者是**不会编程的普通用户**。2026-10-24 起这张卡换了形态（用户点名要的），
 * 2026-10-30 再压成紧凑横排（用户：「操作面板人物变小，整个卡片重新设计布局」），
 * 2026-10-31 卡头的人物换成**插件头像**（用户：「操作面板的这个人物删除替换为
 * 我们的插件头像」—— 那张 64×114 的任务动画在这张卡里撤掉了，见 brand-avatar.ts）：
 *
 *     ┌ 头像  ┐  Seeker                [Git][齿轮]
 *     │ 64×64 │  Seeker / ▶ 打开网页 携程旅行网 · 机票   ← 只有这一行，新动作把它顶掉
 *     └───────┘  ──────────────────────────────────────
 *                33 个动作                    展开时间线 ⌄
 *
 * 也就是说它从「一列按时间读的流水」变成了**一张状态卡**：卡上永远只有
 * 当前正在做的那一件事，不堆历史。为什么这样更好：
 *  · 用户抬头扫一眼就知道"现在在干嘛"，不需要在读 13 行之后再自己找进行中的那条；
 *  · 卡片高度恒定（头像 + 名字 + 一行），右栏不会因为动作流增长而反复变高，
 *    下面的「任务概览 / 产出物 / 记忆」几张卡的位置就稳了。
 *
 * 历史去哪了：**没删，默认收起**（2026-10-24 按用户要求「操作面板默认不展开」）。
 * 展开后仍是原来那份完整时间线（失败人话原因、条目长度上限全部保留），点卡头
 * 即可切 —— 收起态那一行只回答"此刻在干嘛"，历史是点开才看的东西。
 *
 * 卡头那一行的**耗时读数已隐藏**（同一天，用户「那一行的秒数给隐藏」）；展开后
 * 时间线里每行自己那枚耗时原样保留（「里面的不隐藏」）。
 *
 * 刻意不做的三件事（沿用）：
 *  1. 不显示工具函数名、参数名、原始命令行、完整文件路径——那些只在点开
 *     单条时的二级技术信息里出现；
 *  2. 不做「同一动作聚合计数」——browser_click 点了 20 次，「点了 20 次」
 *     本身就是事实，折叠成一行会把它抹掉；
 *  3. 不自己算进度百分比——进行中 / 已完成 / 失败三个计数已经够了。
 *
 * 头像位是**插件头像**（2026-10-31 起）。2026-11-05 起默认取三态透明 WebP
 * 动图（idle / generating / executing，由 brand-avatar.ts 的 brandAvatarSrc
 * 拼 host 路由 URL），加载失败时降级为内联 PNG；原来那套 9 段透明底 WebM
 * 人物动画已随「之前那个人物彻底删除」整条移除。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { useHeightAnimation, useMotionAllowed, useSteppedFollow } from '../motion-utils.ts'
import { formatDuration } from '../tool-summary/tool-stats.ts'
import { isGeneratingStep } from './plain-language.ts'
import type { PlainIconKey, PlainStep } from './plain-language.ts'
import type { SeekerAvatarState } from '../../shared/avatar-assets.ts'
import type { PlainTimeline } from './plain-timeline.ts'
import type { SubagentCatalogView } from './subagent-catalog.ts'
import { workspaceCwdOf } from '../client-ctx.ts'
import { tryOpenInSidebar } from '../open-preview.ts'
import { SeekerHead } from './SeekerHead.tsx'
import { THINKING_PHRASE, VIEWING_PHRASE } from './idle-phrase.ts'
import { getBrowserFlagEntry, sessionSeenBrowser, subscribeBrowserFlag } from '../browser-flag/store.ts'

/**
 * 「简要 / 详细」两档**已整块删除**（2026-10-24 用户点名：「点击就是详细不需要简要了」）。
 *
 * 旧形态：卡头挂两枚常驻按钮切档，默认简要（把成功的文件操作与已解决的失败收敛掉）。
 * 现在：卡上**永远只有一行当前动作**（原简要档的极致形态），点开就是**完整详细
 * 时间线** —— 一步不省、每条都带图标与耗时。
 *
 * 为什么这个组合比两档切换更合理：
 *  · 折叠态已经足够克制（一行），不再需要"简要"这个中间档；
 *  · 展开的意图很明确 —— 用户点开就是要看全部，再让他二次选择"要不要收敛"是多余的一步；
 *  · 少一个持久化偏好 = 少一处"升级后默认值失效"的坑。
 *
 * 旧的两个 localStorage 键一并清掉：留着只会在用户下次打开时读到一份没人再消费的值。
 */
try {
  localStorage.removeItem('dsh.kr_chat.plain_view')
  localStorage.removeItem('dsh.kr_chat.plain_view_v2')
} catch { /* 隐私模式下忽略 */ }

/**
 * 列表视口最大行数：6 → 8 → **13**（用户按实际观感定的档，8 → 13 是「再加 100px」：
 * 行高 22px，+5 行 = +110px）。
 *
 * 这张卡在右栏最末尾，视口高度就是它能一口气看到多少条动作。右栏本身有滚动区，
 * 列表内部再套一层滚动是双重滚动条（旧档位 6 行时这样更明显），所以宁可把视口
 * 开大些，让更多动作直接露出来。
 */
const LIST_MAX_ROWS = 13
/** 被右栏挤压时（记忆卡常驻底部触发自适应降档）收一档。 */
const LIST_MAX_ROWS_SQUEEZED = 9

/*
 * ══ 卡头的「没在干活」文案（2026-10-25 起，2026-10-26 改词）════════════════
 *
 * 用户原话：「不要显示等待本轮开始，显示休息中、吃饭中、小憩、晒太阳；当我发送
 * 出去对话的时候就变成在思考中，后面就正常了」。
 *
 * 三档状态，按「有没有活」区分：
 *   · **空闲**（本轮没在跑）→ 轮换的拟人化说法。原先是一句「等待本轮开始」/
 *     「已收口」—— 那是**系统视角**的措辞（"这一轮还没开始"），读起来像报错
 *     提示；而这张卡的卡头是鲸鱼娘本人，她"没在干活"时该有生活感。
 *   · **刚发出消息、还没有任何动作**（running 但没有可显示的动作）→「在思考中」。
 *     用户点名要这个：消息发出去到第一个工具调用之间有一段空窗，那时卡头不能
 *     还挂着"休息中"—— 她明明已经在处理了。
 *   · **有动作** → 照旧显示当前这一件事（正常流程）。
 *
 * 2026-10-26 用户定稿：删掉「休息中」「晒太阳」，改成按夜里的时段说「观月中」，
 * 白天说「小憩中」，11–13 点说「吃饭中」。（这三个说法原先各对应一段动画片段，
 * 那套动画已于 2026-10-31 整条删除，现在它们只是卡头上的一句话。）
 *
 * 时段表**不在这个文件里**了：新对话页的卡头也要用同一份，两处各抄一遍必然
 * 分叉（改一处忘了另一处 = 两处说法不一致）。现在它是 idle-phrase.ts 的
 * 唯一真相，这里只 import。
 */

export interface KrPlainTimelineCardProps {
  readonly timeline: PlainTimeline
  readonly running: boolean
  /** 右栏被挤压时为 true，列表降一档高度。 */
  readonly squeezed?: boolean
  /** 当前会话 id：用于查该会话派生了哪些子智能体、浏览器标志按它隔离。 */
  readonly sessionId?: string | null
  /**
   * **本会话**的子智能体目录（KrAgentPanel 单点订阅后原样传下来）。
   *
   * 只用来给「派出子任务」那一步标一枚计数。**订阅不在这里做**：子智能体卡
   * 也要这份数据，两处各订阅一次会各开一条 interval，白白把 RPC 打成轮询。
   * 传 null = 目录还没落地，计数那枚徽标直接显示「派出子任务」。
   *
   * 口径是会话累计（2026-10-23）：目录不再按轮次裁剪，这枚计数说「这场对话一共
   * 派出去几个」，与上面那张子智能体卡逐行列出的是同一批 —— 两处数字必须对得上，
   * 否则读者会以为卡里漏了东西。
   */
  readonly subagentCatalog?: SubagentCatalogView | null
  /**
   * 本轮用户输入里带了几张图片（0 / undefined = 没带）。
   *
   * 只服务卡头动画：用户发图或「图 + 文字」过来时，那一刻一条工具调用都还没有，
   * 卡头会按 `empty` 判成「思考中」—— 而她其实该先**看**那张图。用户 2026-10-26
   * 点名要这个：「发送的是图片或图片+文字时，查看图片的动作没有出来，直接出来的
   * 是思考」。判据由 turn-input-images.ts 算出（在 KrAgentPanel 里做，因为那里
   * 才拿得到 chat 快照），这里只是个入参。
   */
  readonly inputImageCount?: number
}

/**
 * 类别图标：单色描边、14px（与状态圆圈同大），线宽 1.3。
 *
 * 这一枚图标负责「做了什么」（终端 / 地球 / 放大镜 / 文件夹…），所以行里的文字
 * 不再重复"在线缆执行命令""在浏览器里操作"这类动词前缀——前缀是把图标说的话
 * 又用文字抄一遍，扫一列下来全是重复句。文字只留动作的具体对象（「查看视频底层
 * 组件详情」），没有对象时才退回动词本身。
 */
function Icon({ name }: { readonly name: PlainIconKey }): ReactElement {
  const common = {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
  } as const
  switch (name) {
    case 'globe':
      return <svg {...common}><circle cx="8" cy="8" r="5.9" /><path d="M2.2 8h11.6" /><path d="M8 2.1c1.7 2 1.7 9.8 0 11.8" /><path d="M8 2.1c-1.7 2-1.7 9.8 0 11.8" /></svg>
    case 'cursor':
      return <svg {...common}><path d="M3.2 2.2 13 7.1 9 8.6l-1.5 3.9z" /></svg>
    case 'keyboard':
      return <svg {...common}><rect x="1.6" y="4" width="12.8" height="8" rx="1.6" /><path d="M4.2 6.6h.01M7 6.6h.01M9.8 6.6h.01M5 9.6h6" /></svg>
    case 'eye':
      return <svg {...common}><path d="M1.6 8S4.1 3.6 8 3.6 14.4 8 14.4 8 11.9 12.4 8 12.4 1.6 8 1.6 8Z" /><circle cx="8" cy="8" r="1.9" /></svg>
    case 'scroll':
      return <svg {...common}><path d="M8 2.2v8.4M5.2 8l2.8 2.8L10.8 8" /><path d="M2.8 13.4h10.4" /></svg>
    case 'arrow':
      return <svg {...common}><path d="M12.8 8H3.4M6.8 4.6 3.4 8l3.4 3.4" /></svg>
    case 'folder':
      return <svg {...common}><path d="M2.1 4.6A1.5 1.5 0 0 1 3.6 3.1h2.1l1.3 1.6h5.4a1.5 1.5 0 0 1 1.5 1.5v5.3a1.5 1.5 0 0 1-1.5 1.5H3.6a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
    case 'search':
      return <svg {...common}><circle cx="7" cy="7" r="4.3" /><path d="m10.2 10.2 3.2 3.2" /></svg>
    case 'terminal':
      return <svg {...common}><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6" /><path d="m4.6 6.2 2 1.9-2 1.9" /><path d="M8.6 10.4h3.4" /></svg>
    case 'image':
      return <svg {...common}><rect x="1.6" y="3" width="12.8" height="10" rx="1.6" /><circle cx="5.7" cy="6.4" r="1.1" /><path d="m2.6 11.4 3.5-3.2 2.9 2.5 1.9-1.7 2.5 2.2" /></svg>
    case 'download':
      return <svg {...common}><path d="M8 2.4v7.2M5.2 6.9 8 9.7l2.8-2.8" /><path d="M2.8 12.6h10.4" /></svg>
    case 'cloud':
      return <svg {...common}><path d="M4.6 12.4a2.9 2.9 0 0 1-.3-5.8 4 4 0 0 1 7.5-.6 2.8 2.8 0 0 1-.3 6.4z" /></svg>
    case 'bolt':
      return <svg {...common}><path d="M8.9 1.8 4.2 9.1h3.3l-.4 5.1 4.7-7.3H8.5z" /></svg>
    case 'task':
      return <svg {...common}><path d="M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h6.8" /></svg>
    case 'spark':
      return <svg {...common}><path d="M8 2 9.3 6.1 13.4 7.4 9.3 8.7 8 12.8 6.7 8.7 2.6 7.4 6.7 6.1z" /></svg>
    case 'file':
    default:
      return <svg {...common}><path d="M9.2 1.9H4.6A1.5 1.5 0 0 0 3.1 3.4v9.2a1.5 1.5 0 0 0 1.5 1.5h6.8a1.5 1.5 0 0 0 1.5-1.5V5.9z" /><path d="M9.2 1.9v4h4" /></svg>
    /*
     * 文件族四枚（看 / 改 / 建 / 删）。
     *
     * 拆开的原因是形状本身要能说话：这一列里最需要被一眼认出的就是「在读 / 在改
     * / 在建 / 在删」，四者都画成同一枚文档时扫一列等于什么都没说——尤其一个
     * 「修改」和一个「查看」紧挨着时，用户根本分不出模型刚动过哪个文件。
     *
     * 14px 下细线会糊成一团，所以文件族单独用 1.5 的线宽（其余类别图标仍 1.3），
     * 文件轮廓缩到左侧 2/3，右下角让给动作符号；四枚共用同一份轮廓保证仍看得出
     * 是一家人（都是文件），符号不同保证不撞形。
     */
    case 'fileView':
      return <svg {...common} strokeWidth={1.5}><path d="M7.2 2.4H4.4A1.4 1.4 0 0 0 3 3.8v8.4a1.4 1.4 0 0 0 1.4 1.4h.8" /><path d="M7.2 2.4v3.1h3.1" /><circle cx="10.4" cy="10.4" r="3" /><path d="m12.7 12.7 1.9 1.9" /></svg>
    case 'fileEdit':
      return <svg {...common} strokeWidth={1.5}><path d="M7.2 2.4H4.4A1.4 1.4 0 0 0 3 3.8v8.4a1.4 1.4 0 0 0 1.4 1.4h.8" /><path d="M7.2 2.4v3.1h3.1" /><path d="m8.6 13 .6-2 3.9-3.9 1.4 1.4-3.9 3.9z" /><path d="m12.1 7.6 1.4 1.4" /></svg>
    case 'fileNew':
      return <svg {...common} strokeWidth={1.5}><path d="M7.2 2.4H4.4A1.4 1.4 0 0 0 3 3.8v8.4a1.4 1.4 0 0 0 1.4 1.4h.8" /><path d="M7.2 2.4v3.1h3.1" /><path d="M11.7 7.2v6.2M8.6 10.3h6.2" /></svg>
    case 'trash':
      return <svg {...common} strokeWidth={1.5}><path d="M2.4 4.2h11.2" /><path d="M6 4.2V2.9a1.1 1.1 0 0 1 1.1-1.1h1.8A1.1 1.1 0 0 1 10 2.9v1.3" /><path d="M3.8 4.2l.6 8.3a1.5 1.5 0 0 0 1.5 1.4h4.2a1.5 1.5 0 0 0 1.5-1.4l.6-8.3" /><path d="M6.7 6.9v3.9M9.3 6.9v3.9" /></svg>
  }
}

/**
 * 产出行末尾的「打开预览」按钮。
 *
 * 读者是普通用户：他刚让模型做了张图 / 改了份文档，最想要的下一步就是**看一眼**。
 * 在那之前他只能自己去翻文件管理器 —— 因为卡片上写的只有文件名，点不动。
 * 这枚按钮把「文件名」变成「点一下就在右侧栏打开」。
 *
 * 只在这一步确实产出了一个文件时渲染（step.filePath 有值）。点击时优先走
 * 官方右栏预览；右栏服务不可用（旧宿主）就什么都不做，绝不弹错误框 ——
 * 那枚按钮本来只是加速通道，不是必经之路。
 */
function OpenFileChip({ step, sessionId }: {
  readonly step: PlainStep
  readonly sessionId: string | null
}): ReactElement | null {
  const path = step.filePath
  if (path === undefined || path === '') return null
  return (
    <button
      type="button"
      className="kr-plain-step__open"
      title={`在右侧栏预览 ${path}`}
      aria-label={`在右侧栏预览 ${path}`}
      onClick={(event) => {
        // 卡片头整行是折叠热区，这里必须拦住，否则点开预览会把卡片收起。
        event.stopPropagation()
        tryOpenInSidebar(path, { sessionId, cwd: workspaceCwdOf(sessionId) })
      }}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6.4 3.2H3.6A1.4 1.4 0 0 0 2.2 4.6v7.8a1.4 1.4 0 0 0 1.4 1.4h7.8a1.4 1.4 0 0 0 1.4-1.4V9.6" />
        <path d="M9.6 2.2h4.2v4.2" />
        <path d="M13.8 2.2 7.6 8.4" />
      </svg>
      <span>预览</span>
    </button>
  )
}

function StepRow({ step, index, subagentCount, sessionId }: {
  readonly step: PlainStep
  readonly index: number
  /**
   * 该步骤派生出的子智能体数量；null = 拿不到（目录没落地 / 服务未就绪）。
   *
   * 只在**这条步骤真的派生了子智能体**时才有值。清单本身**不再挂在这里** ——
   * 子智能体是独立会话，缩进挂在某一步下面读起来像"这一步的内部细节"，还会把
   * 一列按时间读的流水截成一段一段；现在它有自己的卡（KrSubagentsCard），
   * 这里只留一枚计数，说清"这一步派了几个"，要跳过去看在下面那张卡上。
   */
  readonly subagentCount: number | null
  /** 当前会话 id：点「预览」时用它构造文件地址。 */
  readonly sessionId: string | null
}): ReactElement {
  /*
   * 一句话 = **对象**（拿不到对象时才退回动词）。
   *
   * 行首那枚图标已经说了"是哪类动作"，文字再重复"修改文件""查看文件"就是
   * 把图标说的话抄一遍——扫一列下来全是重复句。所以这里只留对象
   * （「plain-language.ts」）。
   *
   * 2026-10-24：原来还有一套"简要模式"的三段式排版（动词 + 对象 + 次数药丸），
   * 随简要档一起删掉了。现在展开就是详细，视觉上只有这一种行。
   */
  const base = step.detail
  const title = base === undefined || base === '' ? step.verb : base
  const failed = step.status === 'failed'
  return (
    <div
      className="kr-plain-step"
      data-status={step.status}
      data-nested={step.spawnsSubagents === true ? 'true' : undefined}
      // 错峰入场：只对靠后的若干条错开，卡片整体不拖出一段长尾。
      style={{ animationDelay: `${Math.min(index, 8) * 24}ms` }}
    >
      {/*
       * 行首图标：类别图标说「是哪类动作」，失败时它自己变红。
       *
       * 原来行首是「状态槽 + 类别图标」两列，而状态槽 99% 的行是空盒——一整列
       * 14px 空白只为等那一条红叉，已整列删除。
       */}
      <span className="kr-plain-step__icon" data-failed={failed ? 'true' : undefined} aria-hidden>
        <Icon name={step.icon} />
      </span>
      <span className="kr-plain-step__title" title={title}>{title}</span>
      {/*
       * 失败原因：**人话**那一句，不是原始报错。
       *
       * 这是整张卡上最该被看见的一件事——用户要的是"出了什么问题"，而一枚红叉
       * 只说了"有件事没成"。原样贴 `ENOENT: no such file or directory` 也没用，
       * 那不是他会读的东西；plain-language 的 humanIssue 已经把它翻成「找不到
       * 文件或页面」这类他能据此判断的话。认不出类别时不显示这一枚，宁可空着。
       *
       * 简短、弱一级字色，不抢行的主文案——它是对那行标题的**补充**，不是并列。
       */}
      {failed && step.issue !== undefined && (
        <span className="kr-plain-step__issue">{step.issue}</span>
      )}
      {/*
       * 「预览」入口：只在**成功了**的产出行上出现。
       * 失败那一步的 filePath 往往指向一个没写成的文件，给个点开就报错的按钮
       * 比不给更糟 —— 失败行要的是那句人话原因，不是出口。
       */}
      {!failed && <OpenFileChip step={step} sessionId={sessionId} />}
      {step.durationMs !== undefined && step.durationMs > 40 && (
        <span className="kr-plain-step__time">{formatDuration(step.durationMs)}</span>
      )}
      {step.spawnsSubagents === true && (
        <span
          className="kr-plain-step__subcount"
          /*
            * 计数口径是**整场会话**（2026-10-23 起，目录不再按轮次裁剪）：这场
            * 对话一共派出去几个，就是几个，与上面「子智能体」卡逐行列出的是同一
            * 批。两处数字必须一致——徽标说 5 个、卡里只列 2 行，读者会以为卡漏了。
            */
          title={subagentCount === null
            ? '正在读取子智能体清单；读完可在上面「子智能体」卡里逐个点进去看'
            : `本次对话派出 ${subagentCount} 个子智能体；在上面「子智能体」卡里点一行即跳过去看`}
        >
          {subagentCount === null ? '派出子任务' : `派出 ${subagentCount} 个子智能体`}
        </span>
      )}
    </div>
  )
}

export const KrPlainTimelineCard = memo(function KrPlainTimelineCard({
  timeline,
  running,
  squeezed = false,
  sessionId = null,
  subagentCatalog = null,
  inputImageCount = 0,
}: KrPlainTimelineCardProps) {
  /*
   * 默认**收起**（2026-10-24 按用户要求）。
   *
   * 上一版是默认展开，理由是"它挂在滚动区最末尾，收起等于把它藏到视线之外"。
   * 但卡头那两行（头像 / 名字 + 当前动作）本来就是这张卡的主视图——用户点名
   * 「操作面板默认不展开」，说明他要的就是"扫一眼当前在干嘛"，要看历史自己点开。
   * 收起态也是右栏最省高度的那一档，能给上面的子智能体与下面的任务概览让位。
   */
  const [open, setOpen] = useState(false)
  const motion = useMotionAllowed(true)
  const { ref: bodyRef, present: bodyPresent } = useHeightAnimation(open, motion)

  /*
   * 浏览器操作标志：**本会话**此刻 / 曾经有没有在操作浏览器。
   *
   * 数据面来自 browser-flag/store.ts（同一个 store、同一条轮询、同一份快照）。
   * 渲染交给 SeekerHead（卡头已抽成共享组件，新对话页也用同一份）。
   *
   * 判据三条，**全部按会话**（2026-11-01 重写。用户原话：「操作面板的浏览器标识
   * 应该绑定会话，而不是所有会话共用」）：
   *
   *  1. `browserActive` —— 本会话此刻有进行中的浏览器调用（或 4s 尾迹）；
   *  2. `browserSticky` —— 本会话**本轮**出现过浏览器活动，就一直亮到本轮收口
   *     （2026-10-25 用户：「只要 ego 没有收口就不要消失」：两次调用之间模型在
   *     思考、读快照，那段空窗里图标闪灭再亮读起来像「浏览器关了」，1.5s 的尾迹
   *     缝不住「想了 5 秒」）；
   *  3. `browserRemembered` —— 本会话历史上真的跑过浏览器（store 的会话级记忆，
   *     刷新后仍在）。2026-10-31 用户要求「本会话打开过工作空间，即便轮次结束
   *     也要能看见入口」。
   *
   * ⚠ 三条都不许退化成「全局有活动就亮」：
   *   · 别写成 browserActive || running —— 那会让每个正在跑的会话都亮图标；
   *   · **别再用步骤文案做子串匹配**（open- / workspace / taskspace）判「碰过
   *     浏览器」：任何读过 `open-preview.ts`、搜过 `workspaceHints` 的会话都会
   *     被**永久**点亮，两个都误判过的会话于是同时亮着同一个状态 —— 这正是本次
   *     要修的 bug（旧实现在 hasBrowserHistory 里干这件事）；
   *   · 别再用 sessionStorage 里那份**所有会话共用**的白名单（旧
   *     isRememberedSession）：它的写入时机被上面那个误判污染，误写一次就再也
   *     清不掉。
   */
  const browserEntry = useSyncExternalStore(
    subscribeBrowserFlag,
    () => getBrowserFlagEntry(sessionId ?? undefined),
    () => getBrowserFlagEntry(sessionId ?? undefined),
  )
  const browserActive = browserEntry !== undefined
    && (browserEntry.active > 0 || browserEntry.lingering === true)

  const steps = timeline.steps

  /*
   * 「本会话本轮用过浏览器」的粘滞标记。
   *
   * 用 state + effect 而不是在渲染期写 ref：渲染期写 ref 在 React 严格模式下
   * 会跑两次、并发渲染下还可能被丢弃（官方文档明确列为反模式）。
   *
   * 值记的是 sessionId 而不是布尔：切会话时不需要额外的清理 effect —— 比较
   * 「记的那个会话 === 当前会话」就自然把旧会话的账作废了。
   */
  const [browserSeenSession, setBrowserSeenSession] = useState<string | null>(null)
  useEffect(() => {
    if (!browserActive) return
    if (sessionId === null || sessionId === undefined || sessionId === '') return
    setBrowserSeenSession((prev) => (prev === sessionId ? prev : sessionId))
  }, [browserActive, sessionId])

  /*
   * 本会话历史上是否真的跑过浏览器（store 的会话级记忆，按 sessionId 查）。
   *
   * 订阅同一个 store：真实活动到达时它会顺带把会话记进记忆并广播，这里跟着重算。
   * 传 null / undefined 一律 false —— 没有会话身份时不许退回成「任意会话」。
   */
  const browserRemembered = useSyncExternalStore(
    subscribeBrowserFlag,
    () => sessionSeenBrowser(sessionId ?? undefined),
    () => sessionSeenBrowser(sessionId ?? undefined),
  )

  const browserSticky = sessionId !== null && sessionId !== undefined && browserSeenSession === sessionId
  const browserOn = browserActive || (running && browserSticky) || browserRemembered

  /*
   * 子智能体目录**不在这里订阅**（2026-10-08 起）：数据由 KrAgentPanel 单点订阅
   * 后经 props 传下来。两张卡各订阅一次 = 各开一条 1.5s interval + 各发一份
   * refreshProjections，白白把 RPC 打成轮询；而它们读的本来就是同一份快照。
   *
   * 计数只给「派出子任务」那一步用；目录没落地时传 null，徽标显示「派生子任务」。
   */
  const subagentCount = subagentCatalog !== null && subagentCatalog.state === 'ready'
    ? subagentCatalog.rows.length
    : null

  // 跟随探针：条目数变化就重新贴底。
  const probe = useMemo(
    () => `${steps.length}`,
    [steps.length],
  )
  const { ref: listRef, onScroll, onWheel, overflow, following, edges } = useSteppedFollow(probe, running && open, motion)

  /*
   * 收口时把列表拉回顶部。
   *
   * 运行中列表一直贴底跟随（用户在追最新动作），轮次一结束内容就定格了——这时
   * 停在底部反而把开头那几步挡在视口外，而「这一轮一共做了什么」正是收口后用户
   * 最想看的东西。留着跟随时的滚动位置还会与后来的内容变化错位，顶部被硬切出
   * 半行（没有渐隐遮罩时尤其明显，见 styles.ts 的 kr-plain-list）。
   */
  const wasRunningRef = useRef(running)
  useEffect(() => {
    const was = wasRunningRef.current
    wasRunningRef.current = running
    if (!was || running) return
    const el = listRef.current
    if (el === null) return
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  }, [running, listRef])

  const empty = timeline.steps.length === 0
  const maxRows = squeezed ? LIST_MAX_ROWS_SQUEEZED : LIST_MAX_ROWS

  /*
   * 卡头上唯一那一行动作：**当前正在做的事**。
   *
   * 取值口径（两条，顺序即优先级）：
   *  1. 有一条 running → 就是它（同时只可能有一条，模型是串行执行的）；
   *  2. 没有 running 但**本轮还在跑** → 取最后一条（刚做完、正在起下一步）；
   *  3. **本轮已收口 → null**，卡头不显示状态文字（只留名字与摘要行）。
   *
   * 第 3 条是 2026-10-25 用户点名改的：「结束之后怎么不[变]回去呢」。原先收口后
   * 卡头会一直挂着**最后一条动作**（截图里那句「收口任务清单」），读起来像"她还在
   * 干这件事"——而事实上她已经停下了。最后做了什么，展开时间线就能看到；卡头
   * 回答的是"此刻在干嘛"，不是"刚才干了啥"。
   *
   * 用**完整时间线**（timeline.steps）而不是收敛后的 steps：简要档会把成功的
   * 文件操作整类砍掉，若此刻正在改文件，卡头就会空着——而"正在改文件"恰恰
   * 是最该显示的一条。这里要的是"此刻在干嘛"，不是"纪要"。
   */
  const currentAction = useMemo<PlainStep | null>(() => {
    const all = timeline.steps
    if (all.length === 0) return null
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const step = all[i]
      if (step !== undefined && step.status === 'running') return step
    }
    // 收口了：不再显示最后一条，交给卡头的空闲文案。
    if (!running) return null
    return all[all.length - 1] ?? null
  }, [timeline.steps, running])

  /*
   * 卡头头像三态（2026-11-05）。
   *
   * 口径与「卡头此刻在干嘛」完全一致，直接复用 currentAction，不另算一套：
   *  · 没有当前动作：本轮没在跑 → idle（无动作）；本轮在跑但还没调工具 →
   *    executing（对应卡头的「在思考中」——她已经在处理了）；
   *  · 当前动作 running 且属于生成类（生成视频 / 图片 / IU / HTML 等，
   *    判定见 plain-language.ts 的 isGeneratingStep）→ generating；
   *  · 其余（包括已完成 / 失败的最后一条）→ executing。
   *
   * 为什么只在 status === 'running' 时给 generating：generating 表示「正在调
   * 生成能力」，一步已经 done 就不该再播生成动画；而卡头本来就不会把 done 的
   * 步骤当作「当前动作」（收口后 currentAction 为 null，running 时取最后一条
   * 可能是刚 done 的），所以这里显式带上 running 判定。
   */
  const avatarState = useMemo<SeekerAvatarState>(() => {
    if (currentAction === null) return running ? 'executing' : 'idle'
    if (currentAction.status === 'running' && isGeneratingStep(currentAction)) return 'generating'
    return 'executing'
  }, [currentAction, running])

  /*
   * 卡头「没在干活」时显示哪一句。
   *
   * 2026-11-05 用户要求「操作面板的观月中字样删除」：操作面板空闲时不再显示
   * 任何拟人化空闲文案（观月中 / 吃饭中 / 小憩中），只保留名字与摘要行。
   * 新对话页 Hero 的空闲文案不受影响（那里仍读 idle-phrase.ts）。
   *
   * 唯一保留的是**正在跑但一个动作都还没有**这一档：「在思考中」或带图时的
   * 「查看照片中」—— 它表达的是「她已经在处理了」，不是空闲状态。
   */
  const idleLine = useMemo(() => {
    if (running && empty) {
      return inputImageCount > 0 ? VIEWING_PHRASE : THINKING_PHRASE
    }
    return ''
  }, [running, empty, inputImageCount])

  return (
    <div className="kr-card kr-card--plain" data-empty={empty || undefined}>
      {/*
       * 卡头：2026-10-30 起是**紧凑横排**「插件头像 / 名字 + 当前动作 / 摘要行」。
       *
       * 与更早的竖排大立绘版差别：
       *  · 名字与状态移到右侧，卡头高度从 215px 压到 160px；
       *  · 2026-11-03 按用户要求（「操作面板的这个操作放在 seeker 文字后面」）把
       *    当前动作并到名字右侧同一行：原来是「Seeker / 动作」上下两行，现在
       *    卡头读作一句「Seeker 正在查看文件 agent.ts」；同日用户补一句「文字
       *    半截，我需要双行显示」，所以动作仍允许折两排（首排与名字同高）；
       *  · 底部摘要行显示动作条数与「展开 / 收起时间线」，把可点击的暗示说清楚；
       *  · **头像位是插件头像**（2026-10-31 起）：原来那 9 段任务动画在这里撤掉了，
       *    换成 64×64 的方形头像（2026-11-05 起是三态透明 WebP 动图，失败时降级
       *    内联 PNG，见 brand-avatar.ts），卡头再省 60px；
       *  · 动作行只显示一条（当前进行中优先），新动作把它顶掉；本轮收口后回到
       *    不显示任何状态文字（2026-11-05 用户要求删除「观月中」字样）。
       */}
      <SeekerHead
        compact
        avatarState={avatarState}
        stepCount={timeline.steps.length}
        line={currentAction === null ? null : {
          icon: currentAction.icon,
          verb: currentAction.verb,
          ...(currentAction.hideVerb === true ? { hideVerb: true as const } : {}),
          ...(currentAction.detail !== undefined ? { detail: currentAction.detail } : {}),
          status: currentAction.status,
        }}
        idleLine={idleLine}
        thinking={idleLine === THINKING_PHRASE || idleLine === VIEWING_PHRASE}
        browserEntry={browserEntry}
        browserOn={browserOn}
        expanded={open}
        onClick={() => { setOpen((value) => !value) }}
        renderIcon={(name) => <Icon name={name as PlainIconKey} />}
      />

      {bodyPresent && (
        <div
          ref={bodyRef}
          className="kr-plain-body"
          data-open={open || undefined}
          aria-hidden={!open}
          {...(!open ? { inert: '' } : {})}
        >
          {/*
           * 「接下来」预告行（模型自己播报的"下一步：…"）已整块删除。
           *
           * 它是**尚未发生**的事，而这张卡回答的是"已经做了什么"——一行还没兑现
           * 的承诺混在事实流水里，用户读完只会更困惑（"这条到底做没做？"）。而且
           * 80% 的情况下它与当前正在跑的那一行说的是同一件事（模型写"接下来查
           * model-seats 目录"，同一时刻列表里也正有一行"查看文件"在扫光），白白
           * 占掉一行高度。要看"现在在干什么"，进行中那行的扫光与右侧耗时已经说清。
           *
           * 模型侧的播报约定（PLAIN_PROGRESS_RULE）也于 2026-10-01 整条下掉：
           * 这行删掉之后，intent 只剩一个滚动跟随探针在消费、nowLabel 干脆没有
           * 渲染出口，而模型每一步都要多写一行。相关注入规则、composer 那枚
           * 「操作面板」开关、extractIntent / nowLabel 一并移除。
           */}


          {empty ? (
            <div className="kr-plain-empty">本轮还没有执行动作</div>
          ) : (
            <div
              className="kr-plain-list"
              ref={listRef}
              onScroll={onScroll}
              onWheel={onWheel}
              role="region"
              aria-label="人话行动时间线"
              /*
               * 溢出时才进焦点序。没有 tabIndex 的溢出容器不进 Tab 序，纯键盘
               * 用户既聚焦不了也用方向键/PageDown 滚，只能读到前 6 行——同仓库
               * 的思考卡对完全同构的视口就写了 tabIndex={overflow ? 0 : undefined}
               * （KrReasoningCard.tsx），这里是漏抄。
               */
              tabIndex={overflow ? 0 : undefined}
              data-following={running && open && following ? 'true' : undefined}
              data-edges={edges}
              style={{ '--kr-plain-rows': maxRows } as CSSProperties}
            >
              {steps.map((step, index) => (
                <StepRow
                  key={step.id}
                  step={step}
                  index={index}
                  subagentCount={step.spawnsSubagents === true ? subagentCount : null}
                  sessionId={sessionId}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
})