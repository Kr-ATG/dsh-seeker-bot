/**
 * 浏览器侧实时通话客户端（src/client/personal/call/realtime-client.ts）的离线状态机测试。
 *
 * 为什么需要它：宿主侧的协议转发有 test-realtime-proxy.mjs 覆盖，但**浏览器侧的状态机**
 * （重连只一次、speech_started 立即打断、字幕去重、stop 幂等、file:// 报错）没有任何
 * 网络测试能覆盖——它依赖 WebSocket 与 AudioContext。这里用 mock WebSocket + mock 音频
 * 引擎跑**真实编译出来的 realtime-client.ts**（esbuild 现场打包），断言事件序列。
 *
 * 用法：node scripts/test-realtime-client.mjs
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const MOCK_AUDIO = `
export class MicStreamer {
  constructor() {
    this.active = false
    this.muted = false
    this.stopped = false
    globalThis.__audioMock.mics.push(this)
  }
  async start(onChunk) { this.onChunk = onChunk; this.active = true; globalThis.__audioMock.micStarts += 1 }
  level() { return 0.42 }
  setMuted(m) { this.muted = m }
  async stop() { this.stopped = true; this.active = false; globalThis.__audioMock.micStops += 1 }
}
export class PcmPlayer {
  constructor() { this.queue = []; this.closed = false; this.volume = 1; globalThis.__audioMock.players.push(this) }
  get playing() { return this.queue.length > 0 }
  async ensureRunning() { this.running = true }
  enqueue(pcm) { this.queue.push(pcm); globalThis.__audioMock.enqueued += 1 }
  interrupt() { this.queue.length = 0; globalThis.__audioMock.interrupts += 1 }
  setVolume(volume) { this.volume = volume; globalThis.__audioMock.volumes.push(volume) }
  async close() { this.closed = true; globalThis.__audioMock.playerCloses += 1 }
}
export function base64ToPcm16(input) { return new Int16Array([1, 2, 3]) }
export function pcm16ToBase64(input) { return 'AAAA' }
`

const mockAudioPlugin = {
  name: 'mock-audio',
  setup(ctx) {
    ctx.onResolve({ filter: /realtime-audio\.ts$/ }, () => ({ path: 'audio-mock', namespace: 'mock' }))
    ctx.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: MOCK_AUDIO, loader: 'js' }))
  },
}

// 产物落到项目的 _tmp/ 下（该目录由工作区清理器回收），不要污染 scripts/
mkdirSync(resolve(ROOT, '_tmp', 'build'), { recursive: true })
const outfile = resolve(ROOT, '_tmp', 'build', 'realtime-client.mjs')
await build({
  entryPoints: [resolve(ROOT, 'src/client/personal/call/realtime-client.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  plugins: [mockAudioPlugin],
  logLevel: 'silent',
})

/* ------------------------------------------------------------------ */
/* 浏览器环境 mock                                                     */
/* ------------------------------------------------------------------ */

globalThis.__audioMock = { mics: [], players: [], volumes: [], micStarts: 0, micStops: 0, enqueued: 0, interrupts: 0, playerCloses: 0 }
globalThis.location = { protocol: 'http:', host: '127.0.0.1:3080' }

const sockets = []
class FakeSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.bufferedAmount = 0
    this.closed = false
    sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(data) { this.sent.push(data) }
  close(code, reason) {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    queueMicrotask(() => this.onclose?.({ code, reason }))
  }
  emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  jsonSent() { return this.sent.filter((item) => typeof item === 'string').map((item) => JSON.parse(item)) }
}
FakeSocket.OPEN = 1
globalThis.WebSocket = FakeSocket

const tick = (ms = 0) => new Promise((done) => setTimeout(done, ms))

const events = []
const { RealtimeCall } = await import(pathToFileURL(outfile).href)

const call = new RealtimeCall({
  onLinkState: (state) => events.push(['link', state]),
  onReady: (info) => events.push(['ready', info]),
  onSpeechStarted: () => events.push(['speech_started']),
  onSpeechStopped: () => events.push(['speech_stopped']),
  onUserTranscript: (text) => events.push(['user', text]),
  onBotTranscript: (text, final) => events.push(['bot', text, final]),
  onBotText: (delta) => events.push(['botText', delta]),
  onThinkingDelta: (delta) => events.push(['thinking', delta]),
  onThinkingDone: (text) => events.push(['thinkingDone', text]),
  onSpeakingStart: () => events.push(['speakingStart']),
  onResponseCreated: () => events.push(['responseCreated']),
  onResponseDone: (status) => events.push(['responseDone', status]),
  onInterrupted: () => events.push(['interrupted']),
  onExpiring: (inMs) => events.push(['expiring', inMs]),
  onError: (error) => events.push(['error', error.message, error.retryable]),
  onClosed: (reason) => events.push(['closed', reason]),
  onMicUnavailable: (message) => events.push(['micUnavailable', message]),
  onMicReady: () => events.push(['micReady']),
})

const failures = []
const check = (name, condition, extra = '') => {
  if (condition) {
    console.log(`ok    ${name}`)
    return
  }
  failures.push(name)
  console.log(`FAIL  ${name}${extra === '' ? '' : ` — ${extra}`}`)
}

/* 1. 建连 + start 帧 */
await call.start({ botId: 'bot-1', instructions: '你是「小墨」，助理。', voice: 'linjiajiejie' })
await tick(5)
const first = sockets[0]
check('WS 地址是同源 /api/personal-agent/realtime', first?.url === 'ws://127.0.0.1:3080/api/personal-agent/realtime', first?.url)
const startFrame = first.jsonSent().find((item) => item.type === 'start')
check('open 后发出 start 帧', startFrame !== undefined)
check('start 帧带 botId', startFrame?.botId === 'bot-1')
check('start 帧带 instructions', String(startFrame?.instructions).includes('小墨'))
check('start 帧带 voice', startFrame?.voice === 'linjiajiejie')
check('链路状态从 connecting 开始', events.some(([kind, value]) => kind === 'link' && value === 'connecting'))

/* 2. ready → 起音频引擎 */
first.emit({ type: 'ready', model: 'stepaudio-3-realtime-preview', voice: 'linjiajiejie', sampleRate: 24000, maxSessionMs: 1800000 })
await tick(10)
check('ready 回调带模型/音色', events.some(([kind, info]) => kind === 'ready' && info?.model === 'stepaudio-3-realtime-preview'))
check('ready 后启动麦克风', globalThis.__audioMock.micStarts === 1)
check('ready 后创建播放器', globalThis.__audioMock.players.length === 1)
check('ready 后 onMicReady 触发', events.some(([kind]) => kind === 'micReady'))

/* 3. 上行：二进制帧 */
const mic = globalThis.__audioMock.mics[0]
mic.onChunk(new Int16Array(960))
const binary = first.sent.filter((item) => typeof item !== 'string')
check('上行音频是二进制帧', binary.length === 1 && binary[0] instanceof Int16Array, String(binary[0]?.constructor?.name))
check('二进制帧是 960 采样（40ms @24k）', binary[0]?.length === 960)

/* 4. 下行音频 → 播放队列 */
first.emit({ type: 'audio_delta', audio: 'AAAAAAAA' })
check('audio_delta 入播放队列', globalThis.__audioMock.enqueued === 1)
check('首片音频触发 speakingStart', events.filter(([kind]) => kind === 'speakingStart').length === 1)
first.emit({ type: 'audio_delta', audio: 'AAAAAAAA' })
check('speakingStart 只回调一次', events.filter(([kind]) => kind === 'speakingStart').length === 1)

/* 5. speech_started 必须立刻清空播放 */
first.emit({ type: 'speech_started' })
check('speech_started 立刻 interrupt 播放器', globalThis.__audioMock.interrupts >= 1)

/* 6. 转写事件透传 */
first.emit({ type: 'user_transcript', text: '帮我订一张票' })
first.emit({ type: 'bot_transcript_delta', delta: '好的' })
first.emit({ type: 'bot_transcript_delta', delta: '，我看看' })
first.emit({ type: 'bot_transcript_done', transcript: '好的，我看看' })
first.emit({ type: 'thinking_delta', delta: '先查一下' })
first.emit({ type: 'thinking_done', thinking: '先查一下有没有票' })
first.emit({ type: 'response_created' })
first.emit({ type: 'response_done', status: 'completed' })
first.emit({ type: 'expiring', inMs: 60000 })
check('user_transcript 透传', events.some(([kind, text]) => kind === 'user' && text === '帮我订一张票'))
check('bot_transcript_delta 逐片透传', events.filter(([kind, , final]) => kind === 'bot' && final === false).length === 2)
check('bot_transcript_done 定稿', events.some(([kind, text, final]) => kind === 'bot' && final === true && text === '好的，我看看'))
check('thinking 增量与定稿都透传', events.some(([kind]) => kind === 'thinking') && events.some(([kind]) => kind === 'thinkingDone'))
check('response_done 透传状态', events.some(([kind, status]) => kind === 'responseDone' && status === 'completed'))
check('expiring 透传剩余时间', events.some(([kind, inMs]) => kind === 'expiring' && inMs === 60000))

/* 7. 打字输入走 text 帧 */
call.sendText('  在吗  ')
const textFrame = first.jsonSent().find((item) => item.type === 'text')
check('打字输入走 text 帧且 trim', textFrame?.text === '在吗')

/* 8. 静音 / 扬声器 */
call.setMuted(true)
check('静音透传到 MicStreamer', mic.muted === true)
const interruptsBefore = globalThis.__audioMock.interrupts
call.setSpeaker(false)
check('关扬声器会清空播放', globalThis.__audioMock.interrupts > interruptsBefore)
first.emit({ type: 'audio_delta', audio: 'AAAAAAAA' })
check('扬声器关闭后不再入队', globalThis.__audioMock.enqueued === 2)
call.setSpeaker(true)
call.setMuted(false)

/* 8b. 音量：透传到播放器，并在重连换播放器后沿用 */
call.setVolume(0.35)
check('音量透传到播放器', globalThis.__audioMock.players[0]?.volume === 0.35, String(globalThis.__audioMock.players[0]?.volume))
call.setVolume(2)
check('音量越界钳制到 1', globalThis.__audioMock.players[0]?.volume === 1, String(globalThis.__audioMock.players[0]?.volume))
call.setVolume(0.35)

/* 9. 可重试错误 → closed → 自动重连一次 */
first.emit({ type: 'error', message: '上游断开', code: 1006, retryable: true })
check('可重试错误上报', events.some(([kind, , retryable]) => kind === 'error' && retryable === true))
first.emit({ type: 'closed', reason: '上游断开' })
await tick(1000)
check('重连一次后新建了第二条 WS', sockets.length === 2, `sockets=${sockets.length}`)
check('重连会重新发 start 帧', sockets[1]?.jsonSent().some((item) => item.type === 'start') === true)
check('重连前释放了旧麦克风', globalThis.__audioMock.micStops >= 1)
check('重连前关闭了旧播放器', globalThis.__audioMock.playerCloses >= 1)
check('重连后新播放器沿用音量', globalThis.__audioMock.players.at(-1)?.volume === 0.35, String(globalThis.__audioMock.players.at(-1)?.volume))

/* 10. 第二次失败不再重连，而是 onClosed */
sockets[1].emit({ type: 'error', message: '又断了', retryable: true })
sockets[1].emit({ type: 'closed', reason: '又断了' })
await tick(1000)
check('第二次失败不再重连', sockets.length === 2, `sockets=${sockets.length}`)
check('彻底结束会回调 onClosed', events.some(([kind]) => kind === 'closed'))

/* 11. stop 清理 */
const before = sockets.length
const call2 = new RealtimeCall({})
await call2.start({ botId: 'bot-2' })
await tick(5)
const second = sockets[before]
second.emit({ type: 'ready', model: 'm', voice: 'v', sampleRate: 24000, maxSessionMs: 1 })
await tick(10)
await call2.stop()
check('stop 发出 stop 帧', second.jsonSent().some((item) => item.type === 'stop') === true)
check('stop 关闭了 WS', second.closed === true)
check('stop 后 linkState 是 closed', call2.linkState === 'closed')
const playersBefore = globalThis.__audioMock.playerCloses
await tick(20)
check('stop 关闭了播放器', globalThis.__audioMock.playerCloses > playersBefore - 1)

/* 12. 非法环境：file:// 直接报错而不是静默 */
globalThis.location = { protocol: 'file:', host: '' }
const call3 = new RealtimeCall({ onError: (error) => events.push(['fileError', error.message]) })
await call3.start({ botId: 'bot-3' })
check('file:// 环境如实报错', events.some(([kind]) => kind === 'fileError'))

/* ==========================================================================
 * 通话转写顺序还原（src/client/personal/call/call-turns.ts）
 *
 * 回归用户实测到的错序：ASR 转写是异步的，`user_transcript` 经常晚于 Bot 的转写
 * 到达，按到达顺序追加会变成「Bot 先答、用户后问」。
 * ========================================================================== */

const orderOutfile = resolve(ROOT, '_tmp', 'build', 'call-turns.mjs')
await build({
  entryPoints: [resolve(ROOT, 'src/client/personal/call/call-turns.ts')],
  outfile: orderOutfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const { sortTurns, takePendingUserTurn } = await import(pathToFileURL(orderOutfile).href)

const t = (id, seq) => ({ id, seq })
const ids = (list) => list.map((item) => item.id).join(',')

check('sortTurns：按 seq 升序', ids(sortTurns([t('c', 3), t('a', 1), t('b', 2)])) === 'a,b,c')
check('sortTurns：不修改原数组', (() => {
  const source = [t('c', 3), t('a', 1)]
  sortTurns(source)
  return ids(source) === 'c,a'
})())
check('sortTurns：旧记录没有 seq 时保持原序（不能把历史通话翻乱）', (() => {
  const legacy = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
  return ids(sortTurns(legacy)) === 'x,y,z'
})())

check('takePendingUserTurn：按 item_id 精确配对（不是 FIFO）', (() => {
  const pending = [{ itemId: 'item_1', seq: 2 }, { itemId: 'item_2', seq: 3 }]
  const taken = takePendingUserTurn(pending, 'item_2')
  return taken.entry?.seq === 3 && taken.rest.length === 1 && taken.rest[0].itemId === 'item_1'
})())
check('takePendingUserTurn：上游没给 item_id → 取队首', (() => {
  const taken = takePendingUserTurn([{ itemId: 'item_1', seq: 2 }], undefined)
  return taken.entry?.seq === 2 && taken.rest.length === 0
})())
check('takePendingUserTurn：item_id 对不上 → 取队首（宁可顺序差，不能丢消息）', (() => {
  const taken = takePendingUserTurn([{ itemId: 'item_1', seq: 2 }], 'item_x')
  return taken.entry?.seq === 2
})())
check('takePendingUserTurn：空队列 → null', takePendingUserTurn([], 'item_1').entry === null)

/*
 * 真实时序复现（用户截图里那一通）：开场白 → 用户说完（占 seq=2）→ Bot 转写先到
 * （seq=3）→ 用户 ASR 后到（用回 seq=2）。排序后必须是「开场白、用户、Bot」。
 */
{
  const pending = []
  let seq = 0
  const turns = []
  const push = (id, turnSeq) => turns.push({ id, seq: turnSeq })

  push('greet', (seq += 1)) // 开场白
  // speech_stopped：预分配序号并占位
  pending.push({ itemId: 'item_u1', seq: (seq += 1) })
  // bot_transcript_done 先到
  push('bot1', (seq += 1))
  // user_transcript 后到 → 配对取回 seq=2
  const taken = takePendingUserTurn(pending, 'item_u1')
  push('user1', taken.entry.seq)

  check('乱序到达时仍还原成「用户问 → Bot 答」', ids(sortTurns(turns)) === 'greet,user1,bot1', ids(sortTurns(turns)))
}

/* 连说两句、两轮转写逆序返回：item_id 配对保证不串位。 */
{
  const pending = []
  let seq = 0
  const turns = []
  const push = (id, turnSeq) => turns.push({ id, seq: turnSeq })

  push('greet', (seq += 1))
  pending.push({ itemId: 'item_1', seq: (seq += 1) }) // 问一 → seq=2
  pending.push({ itemId: 'item_2', seq: (seq += 1) }) // 问二 → seq=3
  push('bot1', (seq += 1)) // Bot 对问一的回复 → seq=4

  // 第二句的 ASR 先返回
  let taken = takePendingUserTurn(pending, 'item_2')
  push('user2', taken.entry.seq)
  // 第一句的 ASR 后返回
  taken = takePendingUserTurn(taken.rest, 'item_1')
  push('user1', taken.entry.seq)

  check('连说两句且转写逆序返回时仍按说话顺序排列', ids(sortTurns(turns)) === 'greet,user1,user2,bot1', ids(sortTurns(turns)))
}

console.log('')
if (failures.length === 0) {
  console.log('REALTIME CLIENT VERIFY PASSED')
} else {
  console.log(`REALTIME CLIENT VERIFY FAILED (${failures.length}): ${failures.join(', ')}`)
  process.exitCode = 1
}
