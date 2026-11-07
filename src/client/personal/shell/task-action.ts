/**
 * 任务动作的「人话」文案（纯函数，零 React / 零 DOM）。
 *
 * 抽出来的原因：任务详情弹窗、右栏「动态」、左右两栏动作面板三处都要把
 * 工具名 / 参数 JSON 说成人话，规则表只能有一份，复制两份必然漂移。
 *
 * 用户口径（2026-11-05）：「每一步的工作都是同一段话，你到底理解没有」——
 * 所以每一条动作只讲它自己那一步查到 / 做了什么：把工具结果里的英文键
 * 换成中文标签（体感温度、云量、标题…），把英文天气词翻成中文，
 * 代码围栏整段剥掉。绝不拿后面那一步的总结来顶替前面几步。
 *
 * 2026-11-07 用户口径：「动态里这个正在回复改为动态显示与 seeker 操作面板里
 * 显示的动作」——工具名 → 动作的**规则表不再在本地抄一份**，直接复用 Work
 * 操作面板的 `src/client/kr-chat/plain-language.ts`（纯函数、无 React / DOM）：
 * 同一句工具调用在两个界面必须读作同一句人话，两份规则表迟早会漂移成
 * 「动态里说查看文件、操作面板说读取文件」。
 */
import { toPlainStep, type PlainStatus } from '../../kr-chat/plain-language.ts'
import { formatDuration, type TaskRecord, type TaskRecordStep } from '../types.ts'

/** 压平空白并截断。 */
function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** TaskRecordStep 的三种工具状态 → plain-language 的三态。 */
function plainStatusOf(step: TaskRecordStep): PlainStatus {
  if (step.status === 'running') return 'running'
  if (step.status === 'error') return 'failed'
  return 'done'
}

/**
 * 参数摘要 → 参数对象。
 *
 * TaskRecordStep.detail 是宿主给的**参数摘要**（可能被截断），历史数据里也
 * 只有它。能把整串解析成对象的就用它还原动作；解析不出来（半截 JSON / 纯
 * 文本 / 空）一律给空对象，由 plain-language 的规则表按工具名兜底——绝不
 * 因为一条脏数据抛异常、让整行动作消失。
 */
function argsOf(detail: string | undefined): Record<string, unknown> {
  if (detail === undefined || detail.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(detail)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * 一步的「人话动作短语」（无时态）+ 是否不拼动词前缀。
 *
 * 两个来源，按优先级：
 *  1. `step.action` —— host 用**完整参数**算好的那句（与 Seeker 操作面板逐字
 *     一致），有多具体就多具体：「启动第二个 CodeArts 账号登录」；
 *  2. 回退：历史数据 / 宿主还没接线时，用 step.title + step.detail 现算一遍。
 *     拼接规则与 host 的 `plainActionOf` 完全相同（终端族 hideVerb 时只留
 *     短语本身，其余是「动词 + 空格 + 对象」），保证两处不会念出两种说法。
 */
export function stepActionViewOf(step: TaskRecordStep): { action: string; hideVerb: boolean } {
  const given = step.action?.trim() ?? ''
  if (given !== '') return { action: given, hideVerb: step.actionHideVerb === true }
  const plain = toPlainStep({
    toolName: step.title,
    args: argsOf(step.detail),
    status: plainStatusOf(step),
  })
  const detail = plain.detail?.trim() ?? ''
  const hideVerb = plain.hideVerb === true && detail !== ''
  return {
    action: hideVerb ? detail : (detail !== '' ? plain.verb + ' ' + detail : plain.verb),
    hideVerb,
  }
}

/** 工具名 → 中文动作（plain-language 的动词；认不出的落到「执行操作」）。 */
export function toolActionOf(name: string): string {
  return toPlainStep({ toolName: name, args: {}, status: 'done' }).verb
}

/**
 * 进行中前缀。
 *
 * 绝大多数动作是「动词 + 对象」（「查看文件 agent.ts」），运行中读作
 * 「正在查看文件 agent.ts」——「正在」是这一行唯一表达时态的记号。
 *
 * 但少数动词**本身已经是进行式**：终端的兜底动词是「在电脑上操作」，浏览器
 * 族的「在输入框里填写」「在页面上查找」也都以「在」开头。再前置一个「正在」
 * 就叠成「正在在电脑上操作」，读起来像口吃。判据只有一条：动词以「在」开头
 * 就不再补前缀，直接裸用——「在电脑上操作」本身就是「它正让电脑干活」。
 *
 * 只作用于进行中；完成态「已在电脑上操作」、失败态「在电脑上操作失败」都不叠字。
 */
function runningPrefixOf(action: string): string {
  return action.startsWith('在') ? '' : '正在'
}

/**
 * 失败的人话说法。
 *
 * 纯中文动作（「查看文件」）直接接「失败」，读作「查看文件失败」；已经带到具体
 * 对象 / 文件名的动作（「查看文件 agent.ts」）再接一个「失败」会粘成一句话
 * （「查看文件 agent.ts失败」），所以换个说法：「查看文件 agent.ts，没做成」。
 * 两种情况都是完整人话，不出现英文与错误码。
 */
function failureLabelOf(action: string): string {
  return action.includes(' ') ? action + '，没做成' : action + '失败'
}

/**
 * 工具步骤的标题：进行中「正在查看文件 X」、失败「查看文件 X，没做成」、
 * 完成「已查看文件 X」；终端族（hideVerb）不拼时态前缀，短语本身已是完整人话。
 */
export function toolTitleOf(step: TaskRecordStep): string {
  const view = stepActionViewOf(step)
  if (step.status === 'running') {
    return view.hideVerb ? view.action : runningPrefixOf(view.action) + view.action
  }
  if (step.status === 'error') {
    return view.hideVerb ? view.action + '，没做成' : failureLabelOf(view.action)
  }
  return view.hideVerb ? view.action : '已' + view.action
}

/** 任意步骤的人话标题（左右两栏与动态行共用）。 */
export function actionLabelOf(step: TaskRecordStep): string {
  if (step.kind === 'tool') return toolTitleOf(step)
  if (step.kind === 'output') return '产出 ' + clip(step.title, 26)
  if (step.kind === 'start') return '已开始'
  if (step.kind === 'end') return '任务收尾'
  const title = step.title.trim()
  return title !== '' ? title : '说明进展'
}

/** 机器字段：不是给人看的，拼人话时跳过。 */
const MACHINE_KEYS = /^(url|id|code|status|success|raw|args|meta|metadata|index|timestamp|at|type|kind|feelslikef)$/i

/** 工具结果里的英文键 → 中文标签（键统一按小写查）。 */
const FIELD_LABELS: Record<string, string> = {
  feelslikec: '体感温度', cloudcover: '云量', humidity: '湿度', observation_time: '观测时间',
  current_temp: '气温', current_desc: '天气状况', temp_c: '气温', temp: '气温',
  maxtemp: '最高温', mintemp: '最低温', max_temp: '最高温', min_temp: '最低温',
  avgtemp: '平均气温', windspeed: '风速', wind: '风力', wind_dir: '风向', pressure: '气压',
  date: '日期', day: '日期', condition: '天气', weather: '天气', forecast: '预报',
  days: '预报', sources: '来源', title: '标题', query: '搜索词', description: '说明',
  summary: '摘要', content: '内容', text: '正文', name: '名称', city: '城市',
  result: '结果', output: '结果', message: '说明', file_path: '文件', path: '路径',
  command: '命令', pattern: '关键词', count: '共', total: '共',
}

/** 常见的英文天气词 → 中文。 */
const VALUE_WORDS: Record<string, string> = {
  'patchy rain nearby': '附近有阵雨', 'patchy rain': '局部有阵雨', 'light rain': '小雨',
  'moderate rain': '中雨', 'heavy rain': '大雨', 'partly cloudy': '局部多云',
  'cloudy': '多云', 'overcast': '阴', 'sunny': '晴', 'clear': '晴',
  'light drizzle': '毛毛雨', 'thunderstorm': '雷阵雨', 'mist': '薄雾',
}

function labelOf(key: string): string {
  return FIELD_LABELS[key.toLowerCase()] ?? ''
}

function valueOf(raw: string): string {
  return VALUE_WORDS[raw.toLowerCase()] ?? raw
}

/** 没有中文标签、值又是纯英文的字段直接跳过，别把英文键名摊给读者。 */
function worthShowing(label: string, val: string): boolean {
  return label !== '' || /[一-龥]/.test(val) || /^[0-9]/.test(val)
}

/** 把 JSON 结果说成中文短句：键换标签、值翻中文，最多 8 条。 */
function describeObject(value: unknown, depth: number, out: string[]): void {
  if (out.length >= 8 || depth > 3) return
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) describeObject(item, depth + 1, out)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (MACHINE_KEYS.test(key)) continue
    if (item === null || item === undefined) continue
    if (typeof item === 'object') {
      describeObject(item, depth + 1, out)
      continue
    }
    const raw = String(item).replace(/\s+/g, ' ').trim()
    if (raw === '' || /^(https?:|data:|blob:)/i.test(raw)) continue
    const label = labelOf(key)
    const val = valueOf(raw)
    if (!worthShowing(label, val)) continue
    out.push(label !== '' ? label + ' ' + val : val)
    if (out.length >= 8) return
  }
}

/** 半截 JSON（被截断的工具结果）：把「键: 值」一对对捞出来，同样套中文标签。 */
function describeLoose(s: string, out: string[]): void {
  const re = /"([^"]{1,40})"\s*[:：]\s*"([^"]{1,80})"/g
  let match: RegExpExecArray | null = re.exec(s)
  while (match !== null && out.length < 8) {
    const key = match[1].trim()
    const raw = match[2].trim()
    if (!MACHINE_KEYS.test(key) && raw !== '' && !/^(https?:|data:|blob:)/i.test(raw)) {
      const label = labelOf(key)
      const val = valueOf(raw)
      if (worthShowing(label, val)) out.push(label !== '' ? label + ' ' + val : val)
    }
    match = re.exec(s)
  }
}

/**
 * 把一步的原始内容清洗成能读的人话（只讲这一步自己）。
 *
 *  · 代码围栏（iu / html / 无标记）整段删掉；
 *  · 模型写的过程说明、最终回复等自然语言直接保留；
 *  · 工具结果：英文键换中文标签、英文天气词翻中文，拼成短句；
 *  · 结果被截断成半截 JSON 时，按「键: 值」配对捞出来翻译；
 *  · 实在读不出字段，才退回去掉括号引号的碎片文字。
 */
export function humanizeDetail(detail: string, max = 260): string {
  let s = detail.trim()
  if (s === '') return ''
  const fence = String.fromCharCode(96).repeat(3)
  const parts = s.split(fence)
  if (parts.length >= 3) s = parts.filter((_, i) => i % 2 === 0).join(' ')
  s = s.replace(/^[A-Za-z_]+\s*[:：]\s*/, '')
  s = s.replace(/\s+/g, ' ').trim()
  if (s === '') return ''
  if (!/^[{[]/.test(s)) return clip(s, max)
  const out: string[] = []
  try {
    describeObject(JSON.parse(s) as unknown, 0, out)
  } catch {
    /* 半截 JSON，走配对 */
  }
  if (out.length === 0) describeLoose(s, out)
  if (out.length > 0) return clip(out.join(' · '), max)
  const skip = '{}[]",' + String.fromCharCode(92)
  const loose: string[] = []
  let buf = ''
  for (const ch of s) {
    if (skip.includes(ch)) {
      if (buf.trim() !== '') loose.push(buf.trim())
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf.trim() !== '') loose.push(buf.trim())
  const text = loose.filter((bit) => /[0-9一-龥A-Za-z]/.test(bit)).slice(0, 12).join(' · ')
  return clip(text, max)
}

/** 左栏小字：取这一步人话正文的第一句（截到 40 字）。 */
export function briefOf(detail: string): string {
  const text = humanizeDetail(detail, 240)
  if (text === '') return ''
  return clip(text.split(' · ')[0] ?? '', 40)
}

/* -------------------------------------------------------------------------- */
/* 任务行「此刻在做什么」（纯函数；右栏动态卡与回归脚本共用）                    */
/* -------------------------------------------------------------------------- */

/** 只把「真正干活」的步骤算作动作：工具调用、阶段说明、产出物。 */
export function actionStepsOf(task: TaskRecord): TaskRecordStep[] {
  return task.steps.filter((step) => step.kind === 'tool' || step.kind === 'text' || step.kind === 'output')
}

/** 已完成的动作数：工具步看状态，阶段文字与产出物一到就算完成。 */
export function doneActionCount(steps: TaskRecordStep[]): number {
  return steps.reduce((n, step) => n + (step.kind === 'tool' && step.status !== 'ok' ? 0 : 1), 0)
}

/** 运行中任务行上的一行活信息。 */
export interface LiveProgress {
  /** 此刻在做什么：一句带具体对象的人话动作。 */
  label: string
  done: number
  total: number
}

/**
 * 运行中任务的「此刻进行到哪里」（纯函数，不读 DOM、不发请求）。
 *
 * 文案按「越具体越优先」分四层：
 *
 *  1. 有正在跑的动作 → 那一步的人话动作（actionLabelOf，带具体对象：
 *     「正在启动第二个 CodeArts 账号登录」），与 Seeker 操作面板同一句；
 *  2. 没有跑的动作、但这一轮还在跑（模型在写字 / 在等结果）→ 最后一条过程
 *     说明的首句，截到约 28 字；
 *  3. **所有动作都完成了、这一轮还没收口**（用户 2026-11-07 二次反馈：「怎么
 *     还是正在思考呢」——截图里「已做 2/2 · 0:46」却显示「正在思考」，等于
 *     什么都没说）→ 显示**刚做完的那一步**：「刚才查看文件 README.md」
 *     「刚才读取网页 github.com」。读的人立刻知道这一轮在做什么事；
 *  4. 真的一个动作都没有 → 「正在思考」。
 *
 * 旧的「正在整理回复…」「正在处理…」都已删除：它们说的是**还没发生**的事。
 */
export function liveProgressOf(task: TaskRecord): LiveProgress | null {
  if (task.status !== 'running') return null
  const steps = actionStepsOf(task)
  let running: TaskRecordStep | undefined
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].status === 'running') { running = steps[i]; break }
  }
  let label: string
  if (running !== undefined) {
    // 有正在跑的动作：说它自己（「正在查看文件 x」）。
    label = actionLabelOf(running)
  } else {
    /*
     * 没有在跑的动作：从最新一条往前找，谁能说出一句具体的话就用谁。
     *
     *  · 过程说明（text）→ 它自己的首句（模型刚说的话，最像"正在干什么"）；
     *  · 已完成的工具 / 产出 → 「刚才 + 动作短语」，说明这一轮刚做了什么；
     *  · 一条都不剩 → 才轮到「正在思考」。
     */
    label = '正在思考'
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]
      if (step.kind === 'text') {
        // 只给这一行两行位置：首句太长会读不全，截到约 28 字。
        const brief = clip(briefOf(step.detail ?? ''), 28)
        if (brief !== '') { label = brief; break }
        continue
      }
      label = justFinishedLabelOf(step)
      break
    }
  }
  return { label, done: doneActionCount(steps), total: steps.length }
}

/**
 * 「刚做完的那一步」怎么读。
 *
 * 用「刚才 + 动作短语（无时态）」而不是「已 + 动作」：这一行整行的语境是
 * 「这轮还在跑」，再叠一个「已」会让人误以为整轮已经结束。产出物单独说
 * 「刚才产出 xxx」（它的 title 是文件名，套工具规则会被翻成「执行 xxx」）。
 */
function justFinishedLabelOf(step: TaskRecordStep): string {
  if (step.kind === 'output') return '刚才产出 ' + clip(step.title, 20)
  const view = stepActionViewOf(step)
  const suffix = step.status === 'error' ? '，没做成' : ''
  return '刚才' + view.action + suffix
}

/**
 * 任务行右上角的「做了多长时间」（mm:ss）。
 *
 * 用户口径（2026-11-07）：「已做去掉，做了多长时间放在右上角，完成后也显示
 * 做了多长时间」。于是耗时从原来 live 行尾的
 * 「已做 N/M · 耗时」里独立出来，成为标题行右端唯一的一个读数：
 *
 *  · 运行中：按 now 实时走格（调用方有任务在跑时每秒重渲染一次）；
 *  · 收工后：读 store 收口时落盘的 durationMs（store 的 settleTurnEnd /
 *    settleStaleTask 都会写它），老数据回退 endedAt - startedAt；
 *  · 两样都没有（很早以前的中断记录）→ null，行上不显示。
 *    宁可不给，也不要挂一个假的 00:00 让人以为这一轮是一瞬间跑完的。
 */
export function elapsedTextOf(task: TaskRecord, now: number): string | null {
  if (task.status === 'running') return formatDuration(Math.max(0, now - task.startedAt))
  if (typeof task.durationMs === 'number' && Number.isFinite(task.durationMs)) {
    return formatDuration(Math.max(0, task.durationMs))
  }
  if (typeof task.endedAt === 'number' && Number.isFinite(task.endedAt) && task.endedAt >= task.startedAt) {
    return formatDuration(task.endedAt - task.startedAt)
  }
  return null
}
