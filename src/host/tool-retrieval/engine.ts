/**
 * Bot 模式的动态工具检索（Tool RAG）。
 *
 * ## 为什么要有这个文件
 *
 * Bot 跑的是宿主完整的 agent loop，因此天然继承**全部**工具：核心工具、
 * preset 工具、以及所有已连接的 MCP server（`mcp__<server>__<tool>`）。
 * 工具一多，每轮请求都要为它们的 JSON schema 付固定 token，而其中绝大多数
 * 在一个具体对话里根本用不到——用户问「北京天气」，没必要为 12 个高德工具
 * 里的 11 个、9 个邮件工具里的 9 个买单。
 *
 * 这里做的事：**按当前对话意图，只把用得上的那部分工具注入模型可见集**，
 * 其余压成一份「工具目录」放进系统提示（走 sections，不占 schema 预算），
 * 再给模型一个 `search_tools` 兜底工具，让它需要时自己把工具捞回来。
 *
 * ## 作用域：只影响 bot，Work 完全不受影响
 *
 * 全部逻辑挂在 **bot 自己的 agent 作用域**（`agentCtx`）上，只在该 agent 的
 * `system-prompt/assemble` 出口生效。Work 会话有它自己的 agent，走不到这里。
 *
 * ## 为什么不做成「全量语义检索」
 *
 * 业界实测（Arcade 4,027 工具 / Stacklok 2,792 工具）表明纯关键词检索在几千
 * 工具规模下召回率只有 56%~64%，而**漏召回比多召回贵得多**：多召回只是费
 * token，漏召回会让模型去编（声称调用了不存在的工具）。所以这里的策略是：
 *
 * 1. **只对 MCP 工具做延迟加载**——检索池只收 `mcp__*`。文件读写、命令执行、
 *    搜索、以及 `cua_driver_native__*` 这类宿主原生能力全部常驻：它们要么一旦
 *    漏掉整个 bot 就废了，要么已经由 tools-gate 的显式开关管着，不该再叠一层
 *    概率性的检索判断。
 * 2. **保底注入**——只要 query 提到了某个 server（中文别名也算），就至少注入
 *    该 server 的一批工具，不让整台 server 凭空消失。
 * 3. **目录 + `search_tools` 双兜底**——模型永远知道自己「还有什么」以及「怎么要」。
 * 4. **抖动抑制**——话题没变就沿用上一轮的集合。工具集一变，agent-loop 就会
 *    追加 tool-addition/removal 并刷新 request/header，KV cache 前缀从那一点起
 *    失效一次；每轮重算等于每轮打掉缓存，省下的 token 又被缓存失效吃回去。
 *
 * ## 失败策略
 *
 * 任何一步出错都返回「原样放行」（全量注入）。宁可多占 token，也不能让 bot
 * 因为检索器异常而少工具——那会表现为模型突然不会读文件了，且毫无线索。
 *
 * @module
 */

/** 工具 schema 的最小形状（`system-prompt` 组装产物的子集）。 */
export interface RetrievalTool {
  name: string
  description?: string
  parameters?: unknown
}

/** 系统提示词段的最小形状。 */
export interface RetrievalSection {
  name: string
  text?: unknown
}

/** 一次组装的最小形状（只声明本模块读写到的字段）。 */
export interface RetrievalAssembly {
  tools?: readonly RetrievalTool[]
  sections?: readonly RetrievalSection[]
}

/** 检索配置。 */
export interface RetrievalConfig {
  /** 总开关。关掉后 `projectTools` 原样放行。 */
  enabled: boolean
  /** 进入检索池的工具名前缀；不匹配的一律常驻。 */
  retrievablePrefixes: readonly string[]
  /** 每个可检索工具组最多注入多少个。 */
  maxPerGroup: number
  /** 一次最多注入的可检索工具总数。 */
  maxRetrieved: number
  /** 话题切换判定：与上一轮 query 的 Jaccard 低于它才重算集合。 */
  switchThreshold: number
}

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  enabled: true,
  /*
   * 只对 MCP 工具做延迟加载。
   *
   * 不把 `cua_driver_native__*` 放进来是刻意的：电脑操作已经由 tools-gate 的
   * 显式开关（`/computer-use` 与连接器面板）管着，那是个**确定性**的开关；
   * 再叠一层按意图猜测的检索，等于给同一个能力加两道概率性闸门——用户明明
   * 打开了，检索没命中还是看不见，且很难排查到底是哪一层挡的。
   */
  retrievablePrefixes: ['mcp__'],
  maxPerGroup: 6,
  maxRetrieved: 12,
  switchThreshold: 0.5,
}

/**
 * 命名空间 → 中文触发词。
 *
 * 为什么需要手工维护：MCP 工具的 description 绝大多数是英文（"Get weather
 * forecast for a city"），而 Bot 的用户说中文。纯关键词检索在中文 query 与
 * 英文描述之间**必然失效**，所以给常见 server 配一份中文别名，作为最便宜的
 * 跨语言桥。未收录的新 server 退回「工具名/描述英文 token + 目录兜底」。
 */
const NAMESPACE_HINTS: Readonly<Record<string, readonly string[]>> = {
  // ── 地图 / 出行 ──（每组第一个词是**品牌主名**，命中即强信号）
  amap: ['高德', '高德地图', '地图', '地点', '位置', '导航', '路线', '周边', '附近', '距离', '坐标', '经纬度', '在哪', '怎么走', '开车', '骑车', '步行', '公交', '地铁', '打车', '路况'],
  baidu: ['百度', '百度地图', '地图', '地点', '导航', '路线', '周边', '附近', '坐标'],
  mapbox: ['mapbox', '地图', '地理编码', '坐标', '经纬度'],
  map: ['地图', '地点', '导航', '路线', '坐标'],
  train12306: ['12306', '火车', '车票', '余票', '高铁', '经停'],
  // ── 天气 ──
  weather: ['天气', '气温', '预报', '下雨', '温度'],
  // ── 邮件 ──
  mail: ['邮件', '邮箱', '发信', '收信', '来信', '附件', '回复', '收件', '发件', '写信', '转发', '抄送'],
  gmail: ['gmail', '谷歌邮箱', '邮件', '邮箱'],
  // ── 浏览器 ──
  playwright: ['playwright', '浏览器', '网页', '网站', '打开页面', '点击', '截图', '表单', '登录', '爬取'],
  puppeteer: ['puppeteer', '浏览器', '网页', '自动化'],
  browserbase: ['browserbase', '浏览器', '云端浏览器'],
  browser: ['浏览器', '网页', '网站'],
  'chrome-devtools': ['devtools', '调试', '性能', '控制台'],
  // ── 电脑 / 终端 / 文件 ──
  cua: ['电脑', '桌面', '鼠标', '键盘', '窗口', '应用', '操作电脑', '屏幕'],
  computer: ['电脑', '桌面', '鼠标', '键盘'],
  desktop: ['桌面', '终端', '命令行', '文件操作'],
  filesystem: ['文件', '目录', '读写', '路径'],
  // ── 协作 / 办公 ──
  feishu: ['飞书', '文档', '多维表格', '群消息', '消息'],
  dingtalk: ['钉钉', '消息', '日程', '群'],
  slack: ['slack', '频道', '消息', '用户'],
  notion: ['notion', '笔记', '页面', '数据库'],
  obsidian: ['obsidian', '笔记', '双链', '知识库'],
  excel: ['excel', '表格', '公式', '工作表'],
  airtable: ['airtable', '表格', '记录', '字段'],
  miro: ['miro', '白板', '看板', '协作'],
  zoom: ['zoom', '会议', '录制', '参会'],
  gdrive: ['谷歌云盘', '云盘', '网盘', '云端文件'],
  // ── 代码 / 项目 ──
  github: ['github', '仓库', 'issue', '拉取请求', '代码', '分支', '提交'],
  gitlab: ['gitlab', '仓库', '合并请求', '流水线', '分支'],
  linear: ['linear', '需求', '缺陷', '任务'],
  jira: ['jira', '需求', '缺陷', '任务'],
  atlassian: ['atlassian', 'jira', 'confluence', '需求', '缺陷', '文档'],
  asana: ['asana', '任务', '项目', '进度'],
  todoist: ['todoist', '待办', '任务清单', '提醒'],
  // ── 数据库 ──
  postgres: ['postgres', '数据库', '查询', '表', 'sql'],
  mongodb: ['mongodb', '数据库', '集合', '文档'],
  supabase: ['supabase', '数据库', '项目'],
  neon: ['neon', '数据库', 'postgres'],
  prisma: ['prisma', '数据库', 'schema', '迁移'],
  // ── 部署 / 云 ──
  vercel: ['vercel', '部署', '上线', '日志'],
  cloudflare: ['cloudflare', 'workers', 'dns', 'cdn', '域名'],
  // ── 搜索 / 抓取 / 文档 ──
  exa: ['exa', '搜索', '网页搜索', '语义搜索', '查资料'],
  perplexity: ['perplexity', '搜索', '联网问答', '查资料'],
  firecrawl: ['firecrawl', '抓取', '爬虫', '网页转markdown', '采集'],
  apify: ['apify', '抓取', '爬虫', '采集'],
  context7: ['context7', '文档', '代码示例', '库文档'],
  mslearn: ['微软', 'mslearn', '文档', '教程'],
  'aws-knowledge': ['aws', '文档', '最佳实践'],
  // ── 支付 / 账单 ──
  stripe: ['stripe', '支付', '账单', '客户', '退款'],
  paypal: ['paypal', '支付', '账单', '退款'],
  alipay: ['支付宝', '支付', '账单', '商户'],
  // ── 电商 / 内容 ──
  taobao: ['淘宝', '商品', '购物', '优惠券', '价格'],
  jd: ['京东', '商品', '购物', '价格', '榜单'],
  bilibili: ['b站', '哔哩哔哩', '视频', '弹幕'],
  douyin: ['抖音', '视频', '解析'],
  weibo: ['微博', '热搜', '动态'],
  twitter: ['推特', 'twitter', '推文', '时间线'],
  weread: ['微信读书', '读书', '书评', '书'],
  'netease-music': ['网易云', '音乐', '歌曲', '歌单'],
  // ── 设计 / 监控 / 客服 ──
  figma: ['figma', '设计稿', '组件', '设计'],
  sentry: ['sentry', '错误监控', '告警', '异常'],
  posthog: ['posthog', '产品分析', '埋点', '实验'],
  pagerduty: ['pagerduty', '告警', '值班', '故障'],
  intercom: ['intercom', '客服', '会话', '用户'],
}

/**
 * 工具级中文别名：工具名**包含** key 即命中。
 *
 * 为什么在组级之外再加一层：组级别名只能判断「用户想要高德」，判断不了「想要
 * 高德里哪个工具」。问「天气」时，同组 12 个工具拿同样的组级分，最后按字母序
 * 排，`maps_geo` 会排在 `maps_weather` 前面——模型拿到的是「把地址转坐标」而不是
 * 「查天气」。工具级命中给更高权重，把精确的那个顶到前面。
 *
 * key 用工具名的片段（`weather` 命中 `maps_weather`），因此跨 server 通用：
 * 任何 MCP server 只要提供 `*weather*` / `*mail_send*` 这类工具都能被命中。
 */
const TOOL_HINTS: Readonly<Record<string, readonly string[]>> = {
  // 地图
  weather: ['天气', '气温', '预报', '下雨', '温度'],
  forecast: ['预报', '天气'],
  regeocode: ['逆地理', '地址转坐标', '反查'],
  geo: ['坐标', '经纬度', '地址'],
  text_search: ['搜索地点', '找地方', '查地点'],
  around_search: ['周边', '附近'],
  direction_driving: ['开车', '驾车', '自驾'],
  direction_walking: ['步行', '走路'],
  direction_transit: ['公交', '地铁', '坐车', '换乘'],
  bicycling: ['骑行', '骑车', '自行车'],
  distance: ['距离', '多远'],
  ip_location: ['归属地', 'ip'],
  // 邮件
  mail_send: ['发邮件', '发信', '写信'],
  mail_list: ['收件箱', '邮件列表', '看邮件'],
  mail_read: ['读邮件', '看邮件'],
  mail_reply: ['回复邮件', '回信'],
  mail_search: ['搜邮件', '找邮件'],
  mail_forward: ['转发邮件'],
  // 代码托管
  create_issue: ['新建issue', '提issue', '报缺陷'],
  create_pr: ['提pr', '拉取请求', '合并请求'],
  search_repositories: ['搜仓库'],
  // 浏览器 / 桌面
  screenshot: ['截图', '截屏', '截个屏', '屏幕', '抓屏', '拍屏'],
  click: ['点击', '点一下', '点开'],
  navigate: ['打开网页', '打开网站', '跳转', '访问'],
  scroll: ['滚动', '往下翻'],
  type: ['输入文字', '打字'],
  // 文件
  read_file: ['读文件', '看文件'],
  write_file: ['写文件', '存文件'],
  list_files: ['列目录', '看目录'],
  // 搜索
  search: ['搜索', '查找', '搜一下', '找一下'],
  query: ['查询', '查一下'],
}

/**
 * 中文触发词 → 英文检索词。
 *
 * 为什么需要这一层：MCP 工具的 description 几乎全是英文（"Get weather forecast
 * for a city"），而 Bot 的用户说中文。中文 query 与英文描述之间没有任何字面
 * 重叠，纯关键词匹配必然失效。所以在 query 侧做一次**单向扩展**：中文词映射成
 * 对应英文词，再去和工具名 / 描述做匹配；工具侧不动，避免污染索引。
 *
 * 这是最便宜的跨语言桥——不引入分词库、不引入 embedding，代价只是一份词表。
 */
const ZH_EN: Readonly<Record<string, readonly string[]>> = {
  // 地图 / 出行
  天气: ['weather'],
  气温: ['weather', 'temperature'],
  温度: ['temperature'],
  预报: ['forecast'],
  下雨: ['rain'],
  地图: ['map', 'maps'],
  位置: ['location'],
  地点: ['place', 'location'],
  导航: ['navigate', 'route', 'direction'],
  路线: ['route', 'direction'],
  怎么走: ['direction', 'route'],
  周边: ['around', 'nearby'],
  附近: ['nearby', 'around'],
  距离: ['distance'],
  多远: ['distance'],
  坐标: ['geo', 'coordinate', 'location'],
  经纬度: ['geo', 'coordinate'],
  公交: ['transit', 'bus'],
  地铁: ['subway', 'metro', 'transit'],
  打车: ['taxi', 'ride'],
  开车: ['driving', 'drive'],
  骑车: ['bicycling', 'bike'],
  步行: ['walking', 'walk'],
  火车: ['train'],
  车票: ['ticket', 'train'],
  余票: ['ticket'],
  // 邮件
  邮件: ['mail', 'email'],
  邮箱: ['mail', 'email'],
  发信: ['send', 'mail'],
  收信: ['list', 'mail'],
  写信: ['send', 'mail'],
  回信: ['reply', 'mail'],
  转发: ['forward'],
  抄送: ['cc'],
  附件: ['attachment'],
  收件箱: ['inbox', 'list'],
  // 代码 / 项目
  仓库: ['repo', 'repository'],
  分支: ['branch'],
  提交: ['commit'],
  合并: ['merge'],
  拉取请求: ['pull', 'request', 'pr'],
  缺陷: ['issue', 'bug'],
  需求: ['issue', 'requirement'],
  任务: ['task', 'todo'],
  待办: ['todo', 'task'],
  流水线: ['pipeline', 'ci'],
  部署: ['deploy', 'deployment'],
  上线: ['deploy', 'release'],
  日志: ['log'],
  构建: ['build'],
  // 数据
  数据库: ['database', 'db', 'sql'],
  查询: ['query', 'search', 'get'],
  表格: ['table', 'sheet'],
  字段: ['field', 'column'],
  记录: ['record', 'row'],
  // 协作
  文档: ['doc', 'document', 'page'],
  笔记: ['note'],
  消息: ['message', 'chat'],
  频道: ['channel'],
  日程: ['calendar', 'schedule'],
  会议: ['meeting', 'call'],
  白板: ['board', 'whiteboard'],
  看板: ['board', 'kanban'],
  // 浏览器 / 电脑
  浏览器: ['browser', 'playwright'],
  网页: ['page', 'web'],
  网站: ['website', 'web'],
  截图: ['screenshot', 'shot'],
  点击: ['click'],
  表单: ['form'],
  输入: ['type', 'input'],
  电脑: ['computer', 'desktop'],
  桌面: ['desktop'],
  鼠标: ['mouse'],
  键盘: ['keyboard'],
  窗口: ['window'],
  屏幕: ['screen', 'display'],
  应用: ['app', 'application'],
  终端: ['terminal', 'shell', 'command'],
  命令行: ['command', 'shell'],
  // 文件
  文件: ['file'],
  目录: ['directory', 'dir', 'folder'],
  路径: ['path'],
  读取: ['read'],
  写入: ['write'],
  运行: ['run', 'exec'],
  // 搜索 / 抓取
  搜索: ['search'],
  查找: ['search', 'find'],
  抓取: ['crawl', 'scrape', 'fetch'],
  爬虫: ['crawler', 'scrape'],
  下载: ['download'],
  // 电商 / 内容
  商品: ['product', 'item'],
  购物: ['shop', 'cart'],
  价格: ['price'],
  优惠券: ['coupon', 'discount'],
  订单: ['order'],
  支付: ['pay', 'payment'],
  账单: ['bill', 'invoice'],
  视频: ['video'],
  音乐: ['music', 'song'],
  歌曲: ['song', 'track'],
  书: ['book'],
  读书: ['book', 'reading'],
  弹幕: ['danmaku', 'comment'],
  热搜: ['trending', 'hot'],
  // 其他
  监控: ['monitor', 'alert'],
  告警: ['alert', 'incident'],
  设计稿: ['design', 'figma'],
  组件: ['component'],
  客户: ['customer', 'client'],
  客服: ['support', 'intercom'],
  翻译: ['translate'],
  总结: ['summary', 'summarize'],
}

/** 组级 hint 的 token 缓存（assemble 每步都跑，不能每次重新分词）。 */
const groupHintCache = new Map<string, GroupHints>()

/** 工具级 hint 的 token 缓存。 */
const toolHintCache = new Map<string, ReadonlySet<string>>()

/** 工具级 hint 的原文缓存（短语匹配用）。 */
const toolPhraseCache = new Map<string, readonly string[]>()

/** 一个工具组的中文别名：品牌主名 + 其余别名。 */
interface GroupHints {
  /** 品牌主名（最具体那个 key 的第一条），命中即强信号。 */
  primary: ReadonlySet<string>
  /** 其余别名的 token。 */
  others: ReadonlySet<string>
}

/**
 * 一个工具组命中的全部中文别名 token。
 *
 * 匹配方式是**包含**而不是相等：serverName 千奇百怪（`amap` / `baidu-map` /
 * `mapbox` / `playwright-mcp`），逐个精确登记既写不全也容易漏；用包含匹配后
 * `map` 能覆盖前三个，`playwright` 能覆盖带后缀的那个。
 *
 * 品牌主名只取**最长匹配 key** 的那一条：`mcp__baidu-map` 同时命中 `baidu` 和
 * `map`，但用户说「百度」时只有 `baidu` 该拿强信号——否则「用百度地图查」
 * 会同时给高德和百度加满，最后按字母序把高德排在前面。
 */
function hintsOfGroup(group: string): GroupHints {
  const cached = groupHintCache.get(group)
  if (cached !== undefined) return cached
  const lower = group.toLowerCase()
  let bestKey = ''
  for (const key of Object.keys(NAMESPACE_HINTS)) {
    if (!lower.includes(key)) continue
    if (key.length > bestKey.length) bestKey = key
  }
  const primary = new Set<string>()
  const others = new Set<string>()
  for (const [key, hints] of Object.entries(NAMESPACE_HINTS)) {
    if (!lower.includes(key)) continue
    const isBest = key === bestKey
    hints.forEach((hint, index) => {
      const target = isBest && index === 0 ? primary : others
      for (const token of tokenize(hint)) target.add(token)
    })
  }
  const result: GroupHints = { primary, others }
  groupHintCache.set(group, result)
  return result
}

/** 一个工具命中的全部工具级别名 token。 */
function hintsOfTool(name: string): ReadonlySet<string> {
  const cached = toolHintCache.get(name)
  if (cached !== undefined) return cached
  const lower = name.toLowerCase()
  const out = new Set<string>()
  for (const [key, hints] of Object.entries(TOOL_HINTS)) {
    if (!lower.includes(key)) continue
    for (const hint of hints) for (const token of tokenize(hint)) out.add(token)
  }
  toolHintCache.set(name, out)
  return out
}

/**
 * 一个工具命中的工具级别名**原文**（短语匹配用）。
 *
 * 为什么需要原文匹配：中文 2-gram 切不出跨字的短语。「帮我截个屏」的 2-gram 是
 * {帮我, 我截, 截个, 个屏}，而别名是「截图」——两者没有任何 token 重叠，纯 token
 * 匹配会漏掉。原文包含判断能覆盖这类口语变体，代价只是多一次子串查找。
 */
function phrasesOfTool(name: string): readonly string[] {
  const cached = toolPhraseCache.get(name)
  if (cached !== undefined) return cached
  const lower = name.toLowerCase()
  const out: string[] = []
  for (const [key, hints] of Object.entries(TOOL_HINTS)) {
    if (!lower.includes(key)) continue
    for (const hint of hints) out.push(hint)
  }
  toolPhraseCache.set(name, out)
  return out
}

/** query 原文是否包含某个别名短语。 */
function phraseHit(text: string, phrases: readonly string[]): boolean {
  if (text === '') return false
  for (const phrase of phrases) if (phrase.length >= 2 && text.includes(phrase)) return true
  return false
}

/**
 * 把 query token 扩展出对应的英文词。
 *
 * 只扩展 query 侧：工具索引保持原文，避免扩展词把无关工具也拉高分数。
 */
function expandQuery(tokens: ReadonlySet<string>): Set<string> {
  const out = new Set<string>(tokens)
  for (const token of tokens) {
    const english = ZH_EN[token]
    if (english !== undefined) for (const word of english) out.add(word)
  }
  return out
}

/** 每个 bot 的检索状态（抖动抑制用）。 */
interface RetrievalState {
  /** 上一轮 query 的 token 集。 */
  lastQueryTokens: ReadonlySet<string>
  /** 上一轮 query 原文（短语匹配用：中文 2-gram 切不出「截个屏」这种跨字说法）。 */
  lastQueryText: string
  /** 上一轮注入的可检索工具名。 */
  lastSelection: ReadonlySet<string>
}

const states = new Map<string, RetrievalState>()

/**
 * 模型通过 `search_tools` 显式点名的工具。
 *
 * 下一步组装时这些工具**强制注入**，不受打分结果影响——这是「检索器漏召回」
 * 的最后一道兜底：模型自己知道缺什么，就能自己捞回来。
 */
const pinned = new Map<string, Set<string>>()

/**
 * 从会话历史里提取最近的用户输入，作为检索意图。
 *
 * 为什么需要：Work 模式（以及任何不是本插件驱动的 agent）拿不到用户原话——
 * turn 是宿主发起的，assemble 的上下文只带 `agent` 与 `scope`，不带消息。
 * 唯一现成的来源是 `agent.session.deriveMessages()`，它是缓存投影（纯尾部增长
 * 是 O(new nodes)），每步读一次不贵。
 *
 * 取最近 3 条而不是 1 条：多轮对话里用户往往先给背景再说诉求（「我在做 XX」
 * →「帮我查下 YY」），只看最后一句会把背景丢掉。
 */
export function readSessionQuery(session: unknown): string {
  let messages: unknown
  try {
    messages = (session as { deriveMessages?: () => unknown } | undefined)?.deriveMessages?.()
  } catch {
    return ''
  }
  if (!Array.isArray(messages)) return ''
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0 && parts.length < 3; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown }
    if (message?.role !== 'user') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    const text = content
      .map((block) => {
        const typed = block as { type?: unknown; text?: unknown }
        return typed?.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
      })
      .filter((value) => value !== '')
      .join(' ')
    if (text.trim() !== '') parts.push(text)
  }
  return parts.join('\n')
}

/** 记录一条用户输入，作为下一步检索的意图来源。 */
export function noteQuery(key: string, text: string): void {
  if (typeof text !== 'string' || text.trim() === '') return
  const tokens = tokenize(text)
  if (tokens.size === 0) return
  const previous = states.get(key)
  states.set(key, {
    lastQueryTokens: tokens,
    lastQueryText: text,
    // 话题切换（token 重叠低）时丢掉上一轮的选择，避免旧意图长期占坑
    lastSelection: previous !== undefined && jaccard(previous.lastQueryTokens, tokens) >= DEFAULT_RETRIEVAL.switchThreshold
      ? previous.lastSelection
      : new Set<string>(),
  })
}

/** 清掉某个 bot 的检索状态（bot 删除 / 会话重建时调用）。 */
export function resetRetrieval(key: string): void {
  states.delete(key)
  pinned.delete(key)
}

/** 读某个 bot 当前被显式点名的工具（供 `search_tools` 写入后查询）。 */
export function pinnedTools(key: string): ReadonlySet<string> {
  return pinned.get(key) ?? new Set<string>()
}

/** 把一个工具名加入显式点名集。 */
export function pinTool(key: string, name: string): void {
  let set = pinned.get(key)
  if (set === undefined) {
    set = new Set<string>()
    pinned.set(key, set)
  }
  set.add(name)
}

/** 本次投影的结果。 */
export interface ToolProjection {
  tools: RetrievalTool[]
  sections: RetrievalSection[]
  /** 被移出可见集、写进目录的工具名。 */
  removed: string[]
}

/**
 * 按当前意图投影一次工具集。
 *
 * 纯函数之外只读模块级状态（`states` / `pinned`），不改入参。
 *
 * @param assembly 组装产物。
 * @param key bot 标识（状态按它隔离）。
 * @param config 配置（缺省用 {@link DEFAULT_RETRIEVAL}）。
 * @returns 过滤后的工具、追加的目录段、被移除的工具名。
 */
export function projectTools(
  assembly: RetrievalAssembly,
  key: string,
  config: RetrievalConfig = DEFAULT_RETRIEVAL,
): ToolProjection {
  const tools = Array.isArray(assembly.tools) ? assembly.tools : []
  const sections = Array.isArray(assembly.sections) ? assembly.sections : []
  if (!config.enabled || tools.length === 0) return { tools: [...tools], sections: [...sections], removed: [] }

  const state = states.get(key)
  const queryTokens = state?.lastQueryTokens ?? new Set<string>()
  /*
   * 没有意图信息就原样放行。
   *
   * 首次组装可能发生在用户输入被记录之前（会话恢复、宿主主动预热等），这时
   * 「什么都没命中」不等于「什么都不需要」——按命中结果裁掉全部可检索工具，
   * 模型会突然看不见 MCP 工具，且没有任何线索说明为什么。宁可多占也不误伤。
   */
  if (queryTokens.size === 0) return { tools: [...tools], sections: [...sections], removed: [] }
  /** 匹配用扩展后的 token（含中文→英文映射）；话题相似度仍用原始 token。 */
  const matchTokens = expandQuery(queryTokens)
  const pinnedNames = pinnedTools(key)

  // ── 1. 分流：常驻 vs 可检索 ─────────────────────────────────────────
  const resident: RetrievalTool[] = []
  const pool = new Map<string, RetrievalTool[]>()
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name : ''
    if (name === '' || !isRetrievable(name, config)) {
      resident.push(tool)
      continue
    }
    const group = groupOf(name)
    const bucket = pool.get(group)
    if (bucket === undefined) pool.set(group, [tool])
    else bucket.push(tool)
  }
  if (pool.size === 0) return { tools: [...tools], sections: [...sections], removed: [] }

  // ── 2. 打分 ─────────────────────────────────────────────────────────
  const queryText = state?.lastQueryText ?? ''
  const scored: Array<{ group: string; tool: RetrievalTool; score: number }> = []
  for (const [group, bucket] of pool) {
    const groupHints = hintsOfGroup(group)
    /*
     * 品牌主名命中是**强信号**：用户说「用百度地图查」时，只有 `baidu` 组该拿
     * 满额分。若把它和普通别名一样处理，高德组会因为共享「地图」拿到同样的分，
     * 最后按字母序把高德排在前面——用户明确点名了却给错工具。
     */
    const brandHit = intersects(matchTokens, groupHints.primary)
    const groupMentioned = brandHit
      || intersects(matchTokens, groupHints.others)
      || matchTokens.has(group.toLowerCase())
    for (const tool of bucket) {
      const own = tokenize(`${splitName(tool.name)} ${tool.description ?? ''}`)
      let score = intersectionCount(matchTokens, own)
      // 组级中文别名命中：该组下所有工具一起加分（英文描述匹配不了中文 query）
      if (brandHit) score += 6
      else if (groupMentioned) score += 2
      /*
       * 工具级别名命中：给比组级更高的权重，把「精确的那个」顶到前面。
       * 没有这一层时，问「天气」同组 12 个工具拿一样的分，按字母序排会先给出
       * `maps_geo`（地址转坐标）而不是 `maps_weather`。
       *
       * 同时走两条路：token 交集（覆盖「天气」这类能切出 2-gram 的说法）与
       * 原文短语包含（覆盖「截个屏」这类跨字说法）。
       */
      if (intersects(matchTokens, hintsOfTool(tool.name)) || phraseHit(queryText, phrasesOfTool(tool.name))) score += 4
      // 显式点名：最高优先
      if (pinnedNames.has(tool.name)) score += 100
      // 抖动抑制：上一轮已注入且话题没变，给一点粘性
      if (state?.lastSelection.has(tool.name) === true) score += 1
      if (score > 0) scored.push({ group, tool, score })
    }
  }
  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))

  // ── 3. 选：按组限流 + 全局上限 ──────────────────────────────────────
  const perGroup = new Map<string, number>()
  const selected = new Set<string>()
  const selectedTools: RetrievalTool[] = []
  for (const item of scored) {
    if (selectedTools.length >= config.maxRetrieved) break
    const used = perGroup.get(item.group) ?? 0
    if (used >= config.maxPerGroup) continue
    perGroup.set(item.group, used + 1)
    selected.add(item.tool.name)
    selectedTools.push(item.tool)
  }

  // ── 4. 组级保底：提到的组至少给一个，不让整台 server 消失 ───────────
  for (const [group, bucket] of pool) {
    if (selectedTools.length >= config.maxRetrieved) break
    if ((perGroup.get(group) ?? 0) > 0) continue
    const hints = hintsOfGroup(group)
    if (!intersects(matchTokens, hints.primary) && !intersects(matchTokens, hints.others)) continue
    const candidate = bucket.find((tool) => !selected.has(tool.name))
    if (candidate === undefined) continue
    selected.add(candidate.name)
    selectedTools.push(candidate)
    perGroup.set(group, 1)
  }

  // ── 5. 记账（供下一轮做抖动抑制）────────────────────────────────────
  if (state !== undefined) {
    states.set(key, { lastQueryTokens: queryTokens, lastQueryText: state.lastQueryText, lastSelection: selected })
  }

  const removed: string[] = []
  const keptPool = new Set(selected)
  for (const bucket of pool.values()) for (const tool of bucket) if (!keptPool.has(tool.name)) removed.push(tool.name)

  if (selectedTools.length === 0 && removed.length === 0) {
    return { tools: [...tools], sections: [...sections], removed: [] }
  }

  // ── 6. 目录：告诉模型「还有什么、怎么要」──────────────────────────
  const catalog = buildCatalog(pool, keptPool)
  return {
    tools: [...resident, ...selectedTools],
    sections: catalog === null ? [...sections] : [...sections, catalog],
    removed,
  }
}

/** 工具是否进入检索池（前缀命中即算）。 */
function isRetrievable(name: string, config: RetrievalConfig): boolean {
  return config.retrievablePrefixes.some((prefix) => name.startsWith(prefix))
}

/** 工具所属的组：`mcp__<server>__<tool>` → `mcp__<server>`，其余按双下划线首段。 */
function groupOf(name: string): string {
  const parts = name.split('__')
  if (parts.length >= 3 && parts[0] === 'mcp') return `${parts[0]}__${parts[1]}`
  if (parts.length >= 2) return parts[0] as string
  return name
}

/** 组的展示名：去掉 `mcp__` 前缀，便于模型阅读。 */
function groupLabel(group: string): string {
  return group.startsWith('mcp__') ? group.slice('mcp__'.length) : group
}

/** `mcp__amap__get_weather` → `mcp amap get weather`（让工具名参与分词）。 */
function splitName(name: string): string {
  return name.replace(/_{1,2}/g, ' ')
}

/**
 * 分词：英文/数字按词，中文按 2-gram。
 *
 * 中文不分词直接按 2-gram 切，是为了在不引入分词库的前提下让「北京天气」
 * 能命中描述里的「天气」——2-gram 会产生噪声（「京天」），但检索场景下
 * 噪声只带来轻微误召回，而漏召回才是致命的。
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9]+/g)) {
    if (match[0].length >= 2) out.add(match[0])
  }
  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) out.add(run)
    else for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  return out
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) if (b.has(value)) return true
  return false
}

function intersectionCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0
  for (const value of a) if (b.has(value)) count += 1
  return count
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let shared = 0
  for (const value of a) if (b.has(value)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * 生成「工具目录」提示段。
 *
 * 为什么必须有：工具被挡在请求之外后，模型既看不见它们的 schema，也不知道
 * 「本来有、只是没注入」。缺了这段，模型会去调一个不存在的工具（拿
 * UNKNOWN_TOOL），或者更糟——声称自己已经打开网页 / 发了邮件。
 *
 * 全部工具都在可见集里时返回 null（不往请求里加任何字）。
 */
function buildCatalog(pool: ReadonlyMap<string, readonly RetrievalTool[]>, kept: ReadonlySet<string>): RetrievalSection | null {
  const lines: string[] = []
  for (const [group, bucket] of pool) {
    const hidden = bucket.filter((tool) => !kept.has(tool.name))
    if (hidden.length === 0) continue
    const names = hidden.slice(0, 8).map((tool) => tool.name.replace(`${group}__`, '')).join('、')
    const more = hidden.length > 8 ? ` 等 ${hidden.length} 个` : ''
    lines.push(`- ${groupLabel(group)}：${names}${more}`)
  }
  if (lines.length === 0) return null
  return {
    name: 'tool-retrieval:catalog',
    text: [
      '以下工具**当前未注入**到你的工具列表（按需加载，以节省上下文），不要直接调用它们：',
      ...lines,
      '需要其中某个能力时，先用 `search_tools` 检索（例如 `search_tools({"query": "天气"})`），命中后它会在下一步出现在你的工具列表里。',
      '不要假装调用了未注入的工具；确实需要而检索不到时，直接告诉用户缺什么能力。',
    ].join('\n'),
  }
}

/** 供 `search_tools` 使用：按 query 在可检索池里找工具，返回名称与描述。 */
export function searchPool(
  tools: readonly RetrievalTool[],
  query: string,
  config: RetrievalConfig = DEFAULT_RETRIEVAL,
  limit = 8,
): RetrievalTool[] {
  const queryTokens = expandQuery(tokenize(query))
  const queryText = typeof query === 'string' ? query : ''
  const scored: Array<{ tool: RetrievalTool; score: number }> = []
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name : ''
    if (name === '' || !isRetrievable(name, config)) continue
    const group = groupOf(name)
    const own = tokenize(`${splitName(name)} ${tool.description ?? ''}`)
    let score = intersectionCount(queryTokens, own)
    const hints = hintsOfGroup(group)
    if (intersects(queryTokens, hints.primary)) score += 6
    else if (intersects(queryTokens, hints.others)) score += 2
    if (intersects(queryTokens, hintsOfTool(name)) || phraseHit(queryText, phrasesOfTool(name))) score += 4
    // 名字直接命中优先（模型往往直接搜工具名）
    if (name.toLowerCase().includes(queryText.trim().toLowerCase()) && queryText.trim() !== '') score += 3
    if (score > 0) scored.push({ tool, score })
  }
  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
  return scored.slice(0, limit).map((item) => item.tool)
}

/** 读某个 bot 的检索状态（测试与诊断用）。 */
export function retrievalState(key: string): { lastSelection: readonly string[]; tokenCount: number } {
  const state = states.get(key)
  if (state === undefined) return { lastSelection: [], tokenCount: 0 }
  return { lastSelection: [...state.lastSelection], tokenCount: state.lastQueryTokens.size }
}

/**
 * 测试面：只给 `scripts/` 里的覆盖率测试用，不是公共 API。
 *
 * 映射表是手工维护的，最容易出的问题是「新接了一个 MCP server，中文别名忘了加，
 * 于是它在中文对话里永远检索不到」。把三个内部函数露出来，让测试拿仓库自带的
 * `assets/mcp-catalog/catalog.json`（58 个 server）逐个验证覆盖率。
 */
export const __retrievalTest = {
  hintsOfGroup,
  hintsOfTool,
  expandQuery,
  namespaceHintKeys: Object.keys(NAMESPACE_HINTS),
  toolHintKeys: Object.keys(TOOL_HINTS),
  zhEnKeys: Object.keys(ZH_EN),
}
