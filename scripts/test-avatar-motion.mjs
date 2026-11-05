/**
 * dsh-seeker-bot — 卡头三态头像动图（WebP）与宿主路由契约回归测试（纯 Node ESM）。
 *
 * ── 这个脚本防的是什么 ──────────────────────────────────────────────
 * 「操作面板」卡头头像按状态切换（idle / generating / executing），依赖四层，
 * 任何一层坏掉，用户看到的就是空白头像、一张静止图，或者黑底图：
 *
 *  1. 资产层：assets/avatar/{idle,generating,executing}.webp 必须真实随包存在，
 *     且是**动画** WebP —— RIFF 容器里要有 ANIM 全局参数块和多个 ANMF 帧；
 *     画布必须 160×160、VP8X 的 alpha 位必须打开（透明底依赖它）。
 *  2. 共享契约层：src/shared/avatar-assets.ts 的路由前缀 / 三态联合类型 /
 *     avatarUrl() 是 host 与 client 共用的唯一真相。
 *  3. 宿主接线层：src/avatar/index.ts 的 prefix 路由、src/host.ts 的
 *     hostFeatureEnabled('host.avatars') 注册，以及 features/components 两级
 *     开关映射，任何一层漏了路由都不会挂载。
 *  4. 打包层：package.json 的 files 必须包含 assets，否则 npm pack 后图片全丢。
 *
 * 解析器只认 RIFF/WebP 规范字节，不信任扩展名：扩展名是 .webp 但内容其实是
 * PNG / JPEG 的文件在这里会直接 FAIL。
 *
 * Usage: node scripts/test-avatar-motion.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** 三种卡头状态（与 src/shared/avatar-assets.ts 的 SeekerAvatarState 对齐）。 */
const AVATAR_STATES = ['idle', 'generating', 'executing']
/** 设计稿规定的画布边长。 */
const AVATAR_SIZE = 160

let failed = 0
let total = 0
const check = (condition, message) => {
  total += 1
  if (condition) console.log('ok    ' + message)
  else {
    failed += 1
    console.error('FAIL  ' + message)
  }
}

const readText = (relative) => {
  try {
    return readFileSync(join(ROOT, relative), 'utf8')
  } catch (error) {
    check(false, '读取 ' + relative + '：' + (error?.message ?? error))
    return ''
  }
}

const formatBytes = (bytes) => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

/**
 * 解析 RIFF/WebP 容器，返回结构信息与结构性问题列表。
 *
 * 容器格式：
 *   'RIFF' + uint32 小端（文件长度 - 8）+ 'WEBP'，随后是 chunk 序列；
 *   每个 chunk = 4 字节 ASCII id + uint32 小端 payload 长度 + payload，
 *   payload 长度为奇数时补 1 字节 padding。
 *
 * VP8X 扩展头 payload 的 10 字节布局（WebP 容器规范）：
 *   [0]     flags
 *   [1..3]  reserved（保留字节，必须为 0）
 *   [4..6]  canvas width - 1  （24 位小端）
 *   [7..9]  canvas height - 1 （24 位小端）
 * flags 位：0x02 = 有动画，0x10 = 有 alpha 透明通道。
 *
 * 注意：flags 与宽高之间隔着 3 个 reserved 字节，宽高从 payload 第 4 字节
 * 开始读；直接读 [1..3] 会得到 1×160 这种假尺寸（用真实文件验证过）。
 */
function parseWebp(buffer) {
  const problems = []
  const ascii = (start, end) => buffer.toString('ascii', start, end)
  if (buffer.length < 12) {
    problems.push('文件只有 ' + buffer.length + ' 字节，连 12 字节 RIFF 头都不完整')
    return { problems, chunks: [], anmfCount: 0, hasAnim: false, flags: null, width: null, height: null }
  }
  if (ascii(0, 4) !== 'RIFF') problems.push("文件头应为 'RIFF'，实际为 '" + ascii(0, 4) + "'")
  if (ascii(8, 12) !== 'WEBP') problems.push("RIFF 类型应为 'WEBP'，实际为 '" + ascii(8, 12) + "'")
  const declared = buffer.readUInt32LE(4)
  if (declared !== buffer.length - 8) {
    problems.push('RIFF 长度字段 ' + declared + ' 与文件实际长度减 8（' + (buffer.length - 8) + '）不一致')
  }

  const chunks = []
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = ascii(offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + size
    chunks.push({ id, size, dataStart, dataEnd })
    if (dataEnd > buffer.length) {
      problems.push("chunk '" + id + "' 声明 " + size + " 字节，超出文件尾 " + (dataEnd - buffer.length) + ' 字节')
      offset = buffer.length
      break
    }
    offset = dataEnd + (size % 2)
  }
  if (offset !== buffer.length) problems.push('chunk 遍历结束于 ' + offset + '，文件长度为 ' + buffer.length + '（chunk 边界不齐）')

  const anmfCount = chunks.filter((chunk) => chunk.id === 'ANMF').length
  const hasAnim = chunks.some((chunk) => chunk.id === 'ANIM')
  const vp8x = chunks.find((chunk) => chunk.id === 'VP8X')
  let flags = null
  let width = null
  let height = null
  if (vp8x === undefined) {
    problems.push("缺少 'VP8X' 扩展头（无法声明画布尺寸与 alpha）")
  } else if (vp8x.size < 10) {
    problems.push("'VP8X' payload 只有 " + vp8x.size + ' 字节，标准布局应 >= 10')
  } else {
    const start = vp8x.dataStart
    const readU24 = (index) => buffer[index] | (buffer[index + 1] << 8) | (buffer[index + 2] << 16)
    flags = buffer[start]
    const reserved = [buffer[start + 1], buffer[start + 2], buffer[start + 3]]
    if (reserved.some((byte) => byte !== 0)) problems.push("'VP8X' 保留字节非 0：" + reserved.join(','))
    width = readU24(start + 4) + 1
    height = readU24(start + 7) + 1
  }
  return { problems, chunks, anmfCount, hasAnim, flags, width, height }
}

/** 校验一张头像动图：存在性、RIFF/WebP 容器、ANIM + ANMF 帧数、160×160、alpha。 */
function testAvatarAsset(state) {
  const relative = 'assets/avatar/' + state + '.webp'
  const absolute = join(ROOT, relative)
  if (!existsSync(absolute)) {
    check(false, relative + ' 存在且 > 0 字节（文件不存在）')
    return
  }
  const { size } = statSync(absolute)
  check(size > 0, relative + ' 存在且 > 0 字节（' + formatBytes(size) + '）')
  if (size === 0) return

  const info = parseWebp(readFileSync(absolute))
  check(
    info.problems.length === 0,
    '[' + state + '] RIFF/WEBP 容器结构完整：' + info.chunks.length + ' 个 chunk' +
      (info.problems.length === 0 ? '' : '；' + info.problems.join('；')),
  )
  check(info.anmfCount > 1, '[' + state + '] 是动画：ANMF 帧数 ' + info.anmfCount + ' > 1')
  check(info.hasAnim, '[' + state + '] 存在 ANIM 动画全局参数 chunk')
  check(
    info.width === AVATAR_SIZE && info.height === AVATAR_SIZE,
    '[' + state + '] 画布 ' + AVATAR_SIZE + '×' + AVATAR_SIZE + '（实际 ' + (info.width ?? '?') + '×' + (info.height ?? '?') + '）',
  )
  check(
    info.flags !== null && (info.flags & 0x10) === 0x10,
    '[' + state + '] VP8X alpha 位为 1（flags=' + (info.flags === null ? '?' : '0x' + info.flags.toString(16).padStart(2, '0')) + '）',
  )
}

// ── 1. 头像资产文件：存在、非空、真·动画 WebP、160×160、带透明通道 ─────
console.log('\n── 1. 头像资产文件（assets/avatar/*.webp） ──')
for (const state of AVATAR_STATES) testAvatarAsset(state)

// ── 2. 共享契约：src/shared/avatar-assets.ts ─────────────────────────────
console.log('\n── 2. 共享契约（src/shared/avatar-assets.ts） ──')
const avatarAssets = readText('src/shared/avatar-assets.ts')
check(/AVATAR_ROUTE\s*=\s*'\/api\/chat-flow\/avatars'/.test(avatarAssets), "AVATAR_ROUTE = '/api/chat-flow/avatars'")
check(/'idle'\s*\|\s*'generating'\s*\|\s*'executing'/.test(avatarAssets), "SeekerAvatarState 含 'idle' | 'generating' | 'executing'")
check(/export\s+function\s+avatarUrl\b/.test(avatarAssets), '导出 avatarUrl() 拼 URL 函数')
check(/AVATAR_FILES/.test(avatarAssets) && /\.webp/.test(avatarAssets), 'AVATAR_FILES 文件名表含 .webp 文件')

// ── 3. 宿主路由：src/avatar/index.ts ─────────────────────────────────────
console.log('\n── 3. 宿主路由（src/avatar/index.ts） ──')
const avatarIndex = readText('src/avatar/index.ts')
check(/AVATAR_ROUTE/.test(avatarIndex), '引用 AVATAR_ROUTE 前缀')
check(/export\s+function\s+applyAvatarRoutes\b/.test(avatarIndex), '导出 applyAvatarRoutes()')
check(avatarIndex.includes('assets/avatar/'), "资产相对路径 'assets/avatar/...'")
check(avatarIndex.includes('image/webp'), "响应 MIME 'image/webp'")

// ── 4. 宿主注册：src/host.ts ─────────────────────────────────────────────
console.log('\n── 4. 宿主注册（src/host.ts） ──')
const host = readText('src/host.ts')
check(/hostFeatureEnabled\('host\.avatars'\)/.test(host), "hostFeatureEnabled('host.avatars') 开关判断")
check(/applyAvatarRoutes\(webCtx\)/.test(host), 'applyAvatarRoutes(webCtx) 挂载路由')

// ── 5. 功能与组件映射 ────────────────────────────────────────────────────
console.log('\n── 5. 功能与组件映射 ──')
const features = readText('src/shared/features.ts')
check(/id:\s*'host\.avatars'/.test(features), "features.ts 存在 'host.avatars' 功能项")
const avatarFeatureStart = features.indexOf("id: 'host.avatars'")
const avatarFeatureEnd = avatarFeatureStart === -1 ? -1 : features.indexOf('}', avatarFeatureStart)
const avatarFeature = avatarFeatureStart === -1 || avatarFeatureEnd === -1 ? '' : features.slice(avatarFeatureStart, avatarFeatureEnd + 1)
check(/default:\s*true/.test(avatarFeature), "features.ts 的 host.avatars 默认开启（default: true）")

const components = readText('src/shared/components.ts')
check(/'host\.avatars'\s*:\s*'host'/.test(components), "components.ts 存在 'host.avatars': 'host' 映射")

// ── 6. 打包清单：package.json ────────────────────────────────────────────
console.log('\n── 6. 打包清单（package.json） ──')
let pkg = null
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
} catch (error) {
  check(false, 'package.json 无法解析：' + (error?.message ?? error))
}
check(pkg !== null && Array.isArray(pkg.files) && pkg.files.includes('assets'), "package.json 的 files 数组包含 'assets'")

// ── 7. 深色主题不让透明动图「融进」背景（2026-11-05）────────────────────
console.log('\n── 7. 深色主题头像对比度 ──')
const krStyles = readText('src/client/kr-chat/styles.ts')
const personalCss = readText('src/client/personal/base.css.ts')
check(/body\[data-ds-dark-theme\] \.kr-plain-head__avatar \{[^}]*radial-gradient/.test(krStyles)
  && /brightness\(1\.12\)/.test(krStyles), 'Work 操作面板头像在深色主题下有径向光托底 + 提亮滤镜')
check(/\.pa-root\[data-pa-theme='dark'\] \.pa-avatar--motion \{[^}]*radial-gradient/.test(personalCss)
  && /\.pa-root\[data-pa-theme='dark'\] \.pa-avatar__motion \{[^}]*brightness/.test(personalCss), 'Bot 模式头像在深色主题下同样有径向光 + 提亮滤镜')
check(!/\.kr-plain-head__avatar \{[^}]*background:\s*#EAF2FB/.test(krStyles), '亮色主题不再给透明动图铺矩形底色')

// ── 8. Bot 右栏资料区的三态头像（2026-11-05）────────────────────────────
console.log('\n── 8. Bot 右栏三态头像 ──')
const botAvatarSrc = readText('src/client/personal/Avatar.tsx')
check(/motionState\?\s*:\s*SeekerAvatarState/.test(botAvatarSrc), 'BotAvatar 支持 motionState 三态动图 prop')
check(/data-avatar-state=\{motionState\}/.test(botAvatarSrc)
  && /brandAvatarSrc\(motionState\)/.test(botAvatarSrc)
  && /onError=\{\(\) => setAvatarFailed\(true\)\}/.test(botAvatarSrc), 'BotAvatar 动图分支带 data-avatar-state / brandAvatarSrc / onError 回退')

const rightPanelSrc = readText('src/client/personal/shell/RightPanel.tsx')
check(/botAvatarStateOf\(activeBot, activeMessages, state\.tasks, activeRoom\?\.id\)/.test(rightPanelSrc)
  && /motionState=\{avatarState\}/.test(rightPanelSrc), 'RightPanel 按当前 Bot / 群聊推导状态并传给 BotAvatar')

const sidebarSrc = readText('src/client/personal/shell/Sidebar.tsx')
check((sidebarSrc.match(/motionState="idle"/g) ?? []).length >= 2, '左栏主 Bot 卡片与折叠轨道都使用无动作动图（motionState="idle"）')
check(!/online=\{mainBot\.status === 'online'\}/.test(sidebarSrc), '主 Bot 头像不再显示橙色在线圆点')
const chatPanelSrc = readText('src/client/personal/chat/ChatPanel.tsx')
const messageListSrc = readText('src/client/personal/chat/MessageList.tsx')
const botSettingsSrc = readText('src/client/personal/shell/BotSettingsCard.tsx')
const callOverlaySrc = readText('src/client/personal/call/CallOverlay.tsx')
check(/activeBot\.isMain \? 'idle'/.test(chatPanelSrc)
  && /bot\.isMain \? 'idle'/.test(messageListSrc)
  && /bot\.isMain \? 'idle'/.test(botSettingsSrc)
  && /bot\.isMain \? 'idle'/.test(callOverlaySrc), '主 Bot 的会话头 / 空态 / 设置卡 / 通话头像也走无动作动图（子 Bot 保持自定义头像）')
check(!/online=\{/.test(sidebarSrc)
  && !/online=\{/.test(chatPanelSrc)
  && !/online=\{/.test(messageListSrc)
  && !/online=\{/.test(botSettingsSrc)
  && !/online=\{/.test(rightPanelSrc), 'Bot 模式头像不再显示橙色在线圆点')

const botAvatarStateSrc = readText('src/client/personal/avatar-state.ts')
check(/export\s+function\s+botAvatarStateOf\b/.test(botAvatarStateSrc), 'avatar-state.ts 导出 botAvatarStateOf()')

/*
 * 行为断言：直接 import 纯函数，把「停用 / 私聊 / 群聊 / 生成类工具 / 任务」几
 * 个关键口径钉住。Node 24 的 TS type-stripping 可直接加载这个无 JSX 的模块。
 * 构造最小对象即可 —— 函数只读 bot.id / bot.enabled、message 的 botId / role /
 * pending / roomId / blocks、task 的 botId / roomId / status。
 */
const { botAvatarStateOf } = await import(new URL('../src/client/personal/avatar-state.ts', import.meta.url).href)
const bot = { id: 'bot-1', enabled: true }
const otherBot = { id: 'bot-2', enabled: true }
const msg = (over = {}) => ({ id: 'm-1', botId: 'bot-1', role: 'bot', at: 0, blocks: [], pending: true, ...over })
const toolBlock = (name, status) => ({ type: 'tool', run: { id: 'run-1', name, status, startedAt: 0 } })
const task = (over = {}) => ({ id: 't-1', botId: 'bot-1', title: '', prompt: '', status: 'running', startedAt: 0, steps: [], ...over })

check(botAvatarStateOf(bot, [], [], undefined) === 'idle', 'botAvatarStateOf：无消息 / 无任务 → idle')
check(botAvatarStateOf({ id: 'bot-1', enabled: false }, [msg()], [], undefined) === 'idle', 'botAvatarStateOf：Bot 停用 → idle')
check(botAvatarStateOf(bot, [msg()], [], undefined) === 'executing', 'botAvatarStateOf：pending 消息 → executing')
check(
  botAvatarStateOf(bot, [msg({ blocks: [toolBlock('generate_image', 'running')] })], [], undefined) === 'generating',
  'botAvatarStateOf：生成类工具 running → generating',
)
check(
  botAvatarStateOf(bot, [msg({ blocks: [toolBlock('generate_image', 'ok')] })], [], undefined) === 'executing',
  'botAvatarStateOf：生成类工具已结束 → executing（不算正在生成）',
)
check(botAvatarStateOf(bot, [], [task()], undefined) === 'executing', 'botAvatarStateOf：running 任务记录 → executing')
check(botAvatarStateOf(bot, [msg({ botId: 'bot-2' })], [], undefined) === 'idle', 'botAvatarStateOf：别的 Bot 的 pending 不计入')
check(botAvatarStateOf(bot, [msg({ botId: 'bot-2', roomId: 'room-1' })], [], 'room-1') === 'executing', 'botAvatarStateOf：群聊作用域看整场群聊')
check(botAvatarStateOf(bot, [msg({ botId: 'bot-2', roomId: 'room-1' })], [], undefined) === 'idle', 'botAvatarStateOf：私聊作用域不串群聊')

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log('\n── 汇总 ──')
if (failed > 0) {
  console.error('FAIL  ' + failed + '/' + total + ' 项检查未通过')
  process.exit(1)
}
console.log('ok    全部 ' + total + ' 项检查通过')
