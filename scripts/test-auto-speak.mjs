/**
 * 自动播报（src/client/personal/chat/auto-speak.ts）的离线行为测试。
 *
 * 为什么单独一个脚本：本次修的 bug 是「一轮里 Bot 发了好几条消息，自动播报只念
 * 最后一条，第一条永远不念」。这是挑选顺序 + 排队语义的问题，纯源码字符串断言
 * 钉不住，必须真跑逻辑：
 *  · pickAutoSpeakItems：按消息流顺序挑、ask 卡必播、pending 普通消息不播、
 *    同一轮没收口时普通消息延后（SSE 落地消息不带 pending，只看自己会念半句）；
 *  · AutoSpeakQueue：严格串行（第一条播完才播第二条）、reset 后不再念、
 *    没出声（浏览器拦截 / 服务失败）时整队停且**不**标记已播。
 *
 * 用法：node scripts/test-auto-speak.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

mkdirSync(resolve(ROOT, '_tmp', 'build'), { recursive: true })
const outfile = resolve(ROOT, '_tmp', 'build', 'personal-auto-speak.mjs')
await build({
  entryPoints: [resolve(ROOT, 'src/client/personal/chat/auto-speak.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['es2022'],
  logLevel: 'silent',
})

const {
  AUTO_SPEAK_DELAY_MS,
  AutoSpeakQueue,
  isAutoSpeakAsk,
  pickAutoSpeakItems,
} = await import(pathToFileURL(outfile).href)

const failures = []
const check = (name, condition, extra) => {
  if (condition) {
    console.log('  ok  ' + name)
    return
  }
  console.log('  FAIL ' + name + (extra === undefined ? '' : ' -> ' + String(extra)))
  failures.push(name)
}
const tick = (ms = 5) => new Promise((resolveTick) => setTimeout(resolveTick, ms))

let messageSeq = 0
/** 造一条最小可用的 Message（只带挑选器会读的字段 + 测试自己的 __text）。 */
const message = (patch = {}) => {
  messageSeq += 1
  const built = {
    id: patch.id ?? 'm' + messageSeq,
    botId: 'bot-1',
    role: patch.role ?? 'bot',
    at: Date.now(),
    blocks: patch.blocks ?? [{ type: 'text', text: patch.__text ?? '' }],
    __text: patch.__text ?? '',
  }
  if (patch.pending !== undefined) built.pending = patch.pending
  if (patch.kind !== undefined) built.kind = patch.kind
  if (patch.turnId !== undefined) built.turnId = patch.turnId
  return built
}
const textOf = (item) => item.__text
const item = (id) => ({ id, text: id, options: { messageId: id, botId: 'b' } })

/* ------------------------------------------------------------------ */
/* 1. 挑选：一轮多条消息时按顺序全部挑出（本次 bug 的核心）            */
/* ------------------------------------------------------------------ */

const progress = message({ id: 'p1', kind: 'progress', __text: '我先查一下资料。', pending: false })
const ask = message({ id: 'q1', kind: 'need-input', __text: '需要你确认用哪个方案？', pending: true })
const final = message({ id: 'f1', kind: 'final', __text: '查清楚了，方案是 A。', pending: false })

const ordered = pickAutoSpeakItems(
  [progress, ask, final],
  new Set(),
  { autoSpeak: true, botId: 'bot-1' },
  textOf,
)
check('一轮三条消息按顺序全部挑出', ordered.map((entry) => entry.id).join(',') === 'p1,q1,f1', ordered.map((entry) => entry.id).join(','))
check('挑出的是可朗读正文', ordered[0]?.text === '我先查一下资料。')
check('第一条不再被最后的 final 挡住', ordered.length === 3 && ordered[0].id === 'p1')
check('问答卡即使还在 pending 也挑（必播通道）', ordered.some((entry) => entry.id === 'q1'))
check('文本选项带 messageId / botId', ordered[0]?.options.messageId === 'p1' && ordered[0]?.options.botId === 'bot-1')

const offOrdered = pickAutoSpeakItems(
  [progress, ask, final],
  new Set(),
  { autoSpeak: false, botId: 'bot-1' },
  textOf,
)
check('开关关闭时问答/审批卡仍必播、普通消息不播', offOrdered.map((entry) => entry.id).join(',') === 'q1', offOrdered.map((entry) => entry.id).join(','))

check('isAutoSpeakAsk 只认 need-input / approval', isAutoSpeakAsk(ask) === true && isAutoSpeakAsk(final) === false)

/* ------------------------------------------------------------------ */
/* 2. 挑选：pending / 空占位 / 已播 / 用户消息 / 音色透传              */
/* ------------------------------------------------------------------ */

const streaming = message({ id: 's1', __text: '半句话还没说完', pending: true })
check('生成中的普通消息不播（半句话）', pickAutoSpeakItems([streaming], new Set(), { autoSpeak: true, botId: 'b' }, textOf).length === 0)

const afterStreaming = pickAutoSpeakItems([streaming, final], new Set(), { autoSpeak: true, botId: 'b' }, textOf)
check('跳过 pending 的普通消息后，后面的定稿消息仍然挑', afterStreaming.map((entry) => entry.id).join(',') === 'f1', afterStreaming.map((entry) => entry.id).join(','))

const placeholder = message({ id: 'ph1', blocks: [], __text: '', pending: true })
check('空 blocks 的 pending 占位不挑（也不该标记已播）', pickAutoSpeakItems([placeholder], new Set(), { autoSpeak: true, botId: 'b' }, textOf).length === 0)

const user = message({ id: 'u1', role: 'user', __text: '你好' })
check('用户消息不自动播', pickAutoSpeakItems([user], new Set(), { autoSpeak: true, botId: 'b' }, textOf).length === 0)

const spokenAll = new Set(['p1', 'q1', 'f1'])
check('已播消息不重复挑', pickAutoSpeakItems([progress, ask, final], spokenAll, { autoSpeak: true, botId: 'b' }, textOf).length === 0)

const voiced = pickAutoSpeakItems([final], new Set(), { autoSpeak: true, botId: 'b1', voice: 'v1', vendor: 'vendor1' }, textOf)
check('音色 / Live 供应商透传到 speak 选项', voiced[0]?.options.voice === 'v1' && voiced[0]?.options.vendor === 'vendor1')

const noVoice = pickAutoSpeakItems([final], new Set(), { autoSpeak: true, botId: 'b1', voice: '', vendor: '' }, textOf)
check('空音色 / 空供应商不放进请求（跟随全局默认）', noVoice[0]?.options.voice === undefined && noVoice[0]?.options.vendor === undefined)

/* ------------------------------------------------------------------ */
/* 3. 挑选：同一轮还没收口时，普通消息延后（SSE 半句防护）             */
/* ------------------------------------------------------------------ */

const turnProgress = message({ id: 't1', turnId: 'turn-1', kind: 'progress', __text: '我先看一眼。', pending: true })
const turnFinal = message({ id: 't2', turnId: 'turn-1', kind: 'final', __text: '结论是这样。', pending: false })
const sameTurn = pickAutoSpeakItems([turnProgress, turnFinal], new Set(), { autoSpeak: true, botId: 'b' }, textOf)
check('同一轮还有 pending 时同轮普通消息延后（SSE 消息不带 pending，只看自己会念半句）', sameTurn.length === 0, sameTurn.map((entry) => entry.id).join(','))

const turnAsk = message({ id: 't3', turnId: 'turn-2', kind: 'need-input', __text: '选哪个？', pending: true })
const askInTurn = pickAutoSpeakItems([turnAsk], new Set(), { autoSpeak: false, botId: 'b' }, textOf)
check('必播卡不受同轮 pending 延后约束', askInTurn.length === 1, askInTurn.map((entry) => entry.id).join(','))

/* ------------------------------------------------------------------ */
/* 4. 队列：严格串行（后一条等前一条播完）+ 播完才回调        */
/* ------------------------------------------------------------------ */

const serialCalls = []
const serialResults = []
let releaseFirst = null
const queue = new AutoSpeakQueue(
  (text) => {
    serialCalls.push(text)
    if (text === 'a') {
      return new Promise((resolveSpeak) => {
        releaseFirst = () => resolveSpeak(true)
      })
    }
    return Promise.resolve(true)
  },
  (entry, played) => serialResults.push(entry.id + ':' + played),
)
queue.enqueue([item('a'), item('b')])
await tick(10)
check('第一条没播完时第二条不开始', serialCalls.join(',') === 'a', serialCalls.join(','))
check('失败的 / 未播完的项还没回调结果', serialResults.length === 0, serialResults.join(','))
releaseFirst()
await tick(10)
check('第一条播完后继续念第二条（不互相打断）', serialCalls.join(',') === 'a,b', serialCalls.join(','))
check('播完才回调 played=true（按顺序）', serialResults.join(',') === 'a:true,b:true', serialResults.join(','))

/* ------------------------------------------------------------------ */
/* 5. 队列：reset 作废未念项，当前这条播完就停                          */
/* ------------------------------------------------------------------ */

const resetCalls = []
const resetResults = []
let releaseReset = null
const queueReset = new AutoSpeakQueue(
  (text) => {
    resetCalls.push(text)
    if (text === 'x') {
      return new Promise((resolveSpeak) => {
        releaseReset = () => resolveSpeak(true)
      })
    }
    return Promise.resolve(true)
  },
  (entry, played) => resetResults.push(entry.id + ':' + played),
)
queueReset.enqueue([item('x'), item('y'), item('z')])
await tick(10)
check('reset 前队列里还有两条排队', queueReset.size === 2, String(queueReset.size))
queueReset.reset()
check('reset 立刻清空排队项', queueReset.size === 0, String(queueReset.size))
releaseReset()
await tick(10)
check('reset 后当前这条播完就不再念后面的', resetCalls.join(',') === 'x', resetCalls.join(','))
check('reset 丢弃的未播项没有播过回调（不会误记已播）', resetResults.join(',') === 'x:true', resetResults.join(','))

/* ------------------------------------------------------------------ */
/* 6. 队列：没出声（返回 false / 抛错）时整队停，失败项不标已播        */
/* ------------------------------------------------------------------ */

const blockedCalls = []
const blockedResults = []
const queueBlocked = new AutoSpeakQueue(
  async (text) => {
    blockedCalls.push(text)
    return text !== 'blocked'
  },
  (entry, played) => blockedResults.push(entry.id + ':' + played),
)
queueBlocked.enqueue([item('blocked'), item('next')])
await tick(10)
check('开播失败整队停（不再连环请求）', blockedCalls.join(',') === 'blocked', blockedCalls.join(','))
check('失败项回调 played=false（留着重挑）', blockedResults.join(',') === 'blocked:false', blockedResults.join(','))
check('失败后队列清空', queueBlocked.size === 0, String(queueBlocked.size))

const throwCalls = []
const queueThrow = new AutoSpeakQueue(async (text) => {
  throwCalls.push(text)
  throw new Error('tts failed')
})
queueThrow.enqueue([item('a'), item('b')])
await tick(10)
check('抛错同样按「没出声」处理并停队', throwCalls.join(',') === 'a', throwCalls.join(','))

/* ------------------------------------------------------------------ */
/* 7. 队列：claimedIds = 正在播 + 排队中（供挑选去重，防重复念）         */
/* ------------------------------------------------------------------ */

const slowQueue = new AutoSpeakQueue(() => new Promise(() => {}))
slowQueue.enqueue([item('first'), item('second')])
await tick(5)
check('claimedIds 含正在播的那条与排队中的项', slowQueue.claimedIds().join(',') === 'first,second', slowQueue.claimedIds().join(','))

const inFlightPick = pickAutoSpeakItems(
  [message({ id: 'first', __text: '正在播的一条' })],
  new Set(slowQueue.claimedIds()),
  { autoSpeak: true, botId: 'b' },
  textOf,
)
check('正在播的那条不会被再次挑中（否则会念两遍）', inFlightPick.length === 0, inFlightPick.map((entry) => entry.id).join(','))

/* ------------------------------------------------------------------ */
/* 8. 队列：reset 之后重新入队仍能正常念                                */
/* ------------------------------------------------------------------ */

const againCalls = []
const queueAgain = new AutoSpeakQueue(async (text) => {
  againCalls.push(text)
  return true
})
queueAgain.enqueue([item('old')])
await tick(5)
queueAgain.reset()
queueAgain.enqueue([item('new')])
await tick(10)
check('reset 之后重新入队仍能正常念', againCalls.includes('new'), againCalls.join(','))

/* ------------------------------------------------------------------ */
/* 9. 源码接线断言（防止后续重构把逐条补播改回「只念最后一条」）        */
/* ------------------------------------------------------------------ */

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')
const autoSpeakSrc = read('src/client/personal/chat/auto-speak.ts')
const messageListSrc = read('src/client/personal/chat/MessageList.tsx')
const storeSrc = read('src/client/personal/store.tsx')

check('debounce 常量是 250ms', AUTO_SPEAK_DELAY_MS === 250, String(AUTO_SPEAK_DELAY_MS))
check('挑选器按消息流顺序正向扫描', autoSpeakSrc.includes('for (const message of messages)'))
check('挑选器实现 ask 必播通道', autoSpeakSrc.includes("message.kind === 'need-input' || message.kind === 'approval'"))
check('挑选器不放过 pending 普通消息', autoSpeakSrc.includes('!ask && message.pending === true'))
check('挑选器实现「同轮未收口延后」', autoSpeakSrc.includes('pendingTurns'))
check('队列把正在播的项纳入 claimedIds', autoSpeakSrc.includes('claimedIds()') && autoSpeakSrc.includes('this.current'))
check('store 在 SSE 先落地时补占位 turnId（同轮门禁不失活）', storeSrc.includes('syncPendingTurnId(pendingId, hostMessage.turnId)'))
check('队列开播失败会整队停', autoSpeakSrc.includes('if (!played)'))
check('MessageList 使用 pickAutoSpeakItems', messageListSrc.includes('pickAutoSpeakItems('))
check('MessageList 使用串行队列 AutoSpeakQueue', messageListSrc.includes('new AutoSpeakQueue('))
check('MessageList 用 claimedIds 去重（含正在播的那条）', messageListSrc.includes('queue.claimedIds()'))
check('拨开关时不误标已排队的项', messageListSrc.includes('queued.has(message.id)'))
check(
  '手动点喇叭只标已定稿消息（不把在途轮次静音）',
  /handleManualSpeak[\s\S]{0,900}message\.pending === true[\s\S]{0,160}continue/.test(messageListSrc),
)
check('MessageList 播完出声才记已播', messageListSrc.includes('(item, played) =>') && messageListSrc.includes('if (!played) return'))
check('MessageList 不再入队即标已播', !messageListSrc.includes('for (const item of items) spoken.ids.add(item.id)'))
check('MessageList 不再「从尾部取最后一条」', !messageListSrc.includes('let last: Message | undefined'))
check('手动点喇叭会作废队列且同批记为不自动播', messageListSrc.includes('handleManualSpeak') && messageListSrc.includes('onManualSpeak={handleManualSpeak}'))
check('卸载消息流前会作废队列', messageListSrc.includes('autoSpeakQueueRef.current?.reset()'))

console.log('')
if (failures.length === 0) {
  console.log('AUTO SPEAK VERIFY PASSED')
} else {
  console.log('AUTO SPEAK VERIFY FAILED (' + failures.length + '): ' + failures.join(', '))
  process.exitCode = 1
}
