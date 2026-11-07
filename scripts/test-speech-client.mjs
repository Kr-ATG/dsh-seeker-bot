/**
 * 浏览器侧「朗读」（src/client/personal/speech.ts）的离线测试。
 *
 * 为什么需要它：朗读链路的两端都不在离线测试的舒适区——它要 fetch 宿主端点、
 * 要解码 / 流式播放音频，还要在「用户点了另一条 / 点了停止」时把迟到的响应
 * 丢掉。这些行为没有任何网络测试能覆盖。这里用 esbuild 现场打包真实的 speech.ts
 * （React 与 PcmPlayer 用 mock 顶掉，只测纯逻辑），mock fetch 与 AudioContext：
 *
 *  · 整段 WAV 路径（旧宿主）走真实的 decodeAudioData 分支；
 *  · 流式路径（新宿主）用 mock PcmPlayer 断言「边收边播」的逐块入队语义。
 *
 * 另加一批源码断言，保证界面接线（喇叭按钮 / 会话头自动播报开关 / 音量滑条 / 播放中样式）与
 * 流式契约（stream: true、MIME / 采样率响应头）没有被后续改动悄悄拆掉。
 *
 * 用法：node scripts/test-speech-client.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/*
 * React 的 mock：speech.ts 只用 useSyncExternalStore 订阅状态，离线环境没有渲染器，
 * 让它直接返回快照即可（真实订阅语义由 getSpeechState / subscribeSpeech 覆盖）。
 */
const MOCK_REACT = 'export function useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() }'

/*
 * PcmPlayer 的 mock：真实的 PcmPlayer 要 AudioWorklet / AudioContext 才能工作，
 * 离线测它没有意义。这里只保留「排队的 PCM」「是否在播」「有没有被打断」这三件事，
 * 流式路径的全部断言都建立在它们上面（任务要求不要依赖 AudioWorklet）。
 */
const MOCK_AUDIO = [
  'export const AUDIO_SAMPLE_RATE = 24000',
  'export class PcmPlayer {',
  '  constructor(sampleRate) {',
  '    this.sampleRate = sampleRate',
  '    this.queued = []',
  '    this.interrupts = 0',
  '    this.running = false',
  '    this.closed = false',
  '    globalThis.__speechMock.players.push(this)',
  '  }',
  '  get playing() { return this.queued.length > 0 }',
  '  get currentVolume() { return 1 }',
  '  async ensureRunning() { this.running = true; globalThis.__speechMock.ensureRunning += 1 }',
  '  enqueue(pcm) { this.queued.push(pcm); globalThis.__speechMock.enqueued.push(pcm) }',
  '  interrupt() { this.interrupts += 1; this.queued.length = 0; globalThis.__speechMock.interrupts += 1 }',
  '  setVolume(volume) { this.volume = volume }',
  '  async close() { this.closed = true }',
  '}',
].join('\n')

const mockModulesPlugin = {
  name: 'mock-modules',
  setup(ctx) {
    ctx.onResolve({ filter: /^react$/ }, () => ({ path: 'react-mock', namespace: 'mock-react' }))
    ctx.onResolve({ filter: /realtime-audio\.ts$/ }, () => ({ path: 'audio-mock', namespace: 'mock-audio' }))
    ctx.onLoad({ filter: /.*/, namespace: 'mock-react' }, () => ({ contents: MOCK_REACT, loader: 'js' }))
    ctx.onLoad({ filter: /.*/, namespace: 'mock-audio' }, () => ({ contents: MOCK_AUDIO, loader: 'js' }))
  },
}

// 产物落到项目的 _tmp/ 下（该目录由工作区清理器回收），不要污染 scripts/
mkdirSync(resolve(ROOT, '_tmp', 'build'), { recursive: true })
const outfile = resolve(ROOT, '_tmp', 'build', 'personal-speech.mjs')
await build({
  entryPoints: [resolve(ROOT, 'src/client/personal/speech.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  plugins: [mockModulesPlugin],
  logLevel: 'silent',
})

/* ------------------------------------------------------------------ */
/* 浏览器环境 mock（fetch / AudioContext / PcmPlayer）                  */
/* ------------------------------------------------------------------ */

const mock = {
  fetches: [],
  contexts: [],
  sources: [],
  players: [],
  enqueued: [],
  gains: [],
  decoded: 0,
  ensureRunning: 0,
  interrupts: 0,
  handler: null,
}
globalThis.__speechMock = mock

class FakeAudioContext {
  constructor() {
    this.state = 'running'
    this.destination = {}
    this.sampleRate = 48000
    this.resumeFails = false
    mock.contexts.push(this)
  }

  async resume() {
    if (this.resumeFails === true) throw new Error('NotAllowedError')
    this.state = 'running'
  }

  async close() {
    this.state = 'closed'
  }

  createGain() {
    const node = { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }
    mock.gains.push(node)
    return node
  }

  createBufferSource() {
    const node = {
      buffer: null,
      onended: null,
      started: false,
      stopped: false,
      connect: () => {},
      disconnect: () => {},
      start() {
        this.started = true
      },
      stop() {
        this.stopped = true
      },
    }
    mock.sources.push(node)
    return node
  }

  decodeAudioData(data, ok, fail) {
    mock.decoded += 1
    if (mock.decodeFails === true) {
      fail?.(new Error('bad audio'))
      return
    }
    ok?.({ duration: 1.2, length: 1000 })
  }
}

globalThis.AudioContext = FakeAudioContext

/*
 * localStorage mock：朗读音量在模块加载时就要从它读回上次的值（真实浏览器里
 * 当然有）。没有它，speech.ts 会走 `typeof localStorage === 'undefined'` 的
 * 兜底分支，音量相关断言就测不到持久化这条路径。
 */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => {
    storage.set(key, String(value))
  },
  removeItem: (key) => {
    storage.delete(key)
  },
}

const defaultHandler = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
  status: 200,
  headers: { 'content-type': 'audio/wav' },
})
mock.handler = defaultHandler

globalThis.fetch = async (url, init) => {
  mock.fetches.push({ url, init })
  return mock.handler(url, init)
}

const tick = (ms = 0) => new Promise((done) => setTimeout(done, ms))

const failures = []
const check = (name, condition, extra) => {
  if (condition) {
    console.log('ok    ' + name)
    return
  }
  failures.push(name)
  const suffix = extra === undefined || extra === '' ? '' : ' — ' + extra
  console.log('FAIL  ' + name + suffix)
}

const {
  speakText,
  stopSpeech,
  getSpeechState,
  speechTextOf,
  cleanSpeechText,
  primeSpeech,
  SPEECH_MAX_CHARS,
  SPEECH_CHUNK_CHARS,
  splitSpeechChunks,
  getSpeechVolume,
  setSpeechVolume,
} = await import(pathToFileURL(outfile).href)

/** 造一段 PCM16 字节（小端），长度 = samples 个采样。 */
const pcmChunk = (samples) => {
  const bytes = new Uint8Array(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    const value = (i * 37) % 2000
    bytes[i * 2] = value & 0xff
    bytes[i * 2 + 1] = (value >> 8) & 0xff
  }
  return bytes
}

/** 造一个「把给定块依次吐出然后关闭」的流式响应。 */
const streamResponse = (chunks, extraHeaders = {}) => {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'x-tts-sample-rate': '24000',
      ...extraHeaders,
    },
  })
}

/* ------------------------------------------------------------------ */
/* 1. 整段 WAV（旧宿主）成功播放                                        */
/* ------------------------------------------------------------------ */

const initial = getSpeechState()
check('初始状态是空闲', initial.speaking === false && initial.loading === false && initial.messageId === null)

// playBuffer 现在要等 onended 才 resolve：先拿住播放句柄，断言播放中态后再手动收尾
const firstRun = speakText('你好呀', { messageId: 'm-1', botId: 'bot-1', voice: 'linjiajiejie', vendor: 'stepfun' })
await tick(20)
const first = mock.fetches.at(-1)
check('请求走契约里的 TTS 端点', first?.url === '/api/personal-agent/tts', String(first?.url))
check('请求方法是 POST', first?.init.method === 'POST', String(first?.init.method))
const body = JSON.parse(first?.init.body ?? '{}')
check('请求体带 stream: true', body.stream === true, JSON.stringify(body.stream))
check('请求体带 text', body.text === '你好呀', JSON.stringify(body))
check('请求体带 voice', body.voice === 'linjiajiejie')
check('请求体带 vendor', body.vendor === 'stepfun')
check('请求体带 botId', body.botId === 'bot-1')
check('空的可选字段不下发', body.speed === undefined)
check('旧宿主：WAV 走 decodeAudioData', mock.decoded === 1, String(mock.decoded))
check('旧宿主：开始播放', mock.sources.at(-1)?.started === true)

const playing = getSpeechState()
check('播放中状态：speaking + messageId', playing.speaking === true && playing.loading === false && playing.messageId === 'm-1', JSON.stringify(playing))

mock.sources.at(-1).onended()
await firstRun
const afterEnd = getSpeechState()
check('播完回到空闲', afterEnd.speaking === false && afterEnd.messageId === null, JSON.stringify(afterEnd))

/* ------------------------------------------------------------------ */
/* 2. 同一时刻只播一条：新播放打断旧播放                                 */
/* ------------------------------------------------------------------ */

const firstPlay = speakText('第一句', { messageId: 'm-2' })
await tick(20)
const oldSource = mock.sources.at(-1)
const secondPlay = speakText('第二句', { messageId: 'm-3' })
await tick(20)
check('新播放停掉旧的 source', oldSource.stopped === true)
check('被打断的旧节点摘掉 onended', oldSource.onended === null)
check('状态指向新的一条', getSpeechState().messageId === 'm-3', String(getSpeechState().messageId))
mock.sources.at(-1).onended()
await secondPlay
await firstPlay

/* ------------------------------------------------------------------ */
/* 3. stopSpeech                                                       */
/* ------------------------------------------------------------------ */

// playBuffer 要等 onended 才返回：重新起一条，让 stopSpeech 打断它并验证不会悬挂
const stopRun = speakText('第三句', { messageId: 'm-stop' })
await tick(20)
const stopping = mock.sources.at(-1)
stopSpeech()
check('stopSpeech 停掉 source', stopping.stopped === true)
const stopped = getSpeechState()
check('stopSpeech 回到空闲', stopped.speaking === false && stopped.loading === false && stopped.messageId === null)
await stopRun
stopSpeech()
check('stopSpeech 幂等（重复调用不炸）', getSpeechState().speaking === false)

/* ------------------------------------------------------------------ */
/* 4. 失败：可读中文原因                                                */
/* ------------------------------------------------------------------ */

mock.handler = async () => new Response(JSON.stringify({ ok: false, error: '还没配置 Live 供应商' }), { status: 502 })
await speakText('会失败的', { messageId: 'm-4' })
const failed = getSpeechState()
check('失败时用宿主给的原因', failed.error === '还没配置 Live 供应商', String(failed.error))
check('失败不进入播放', failed.speaking === false && failed.messageId === null)

mock.handler = async () => new Response('bad gateway', { status: 500 })
await speakText('再失败', {})
check('非 JSON 失败退回状态码', String(getSpeechState().error).includes('500'), String(getSpeechState().error))

mock.handler = async () => new Response('', { status: 404 })
await speakText('404', {})
check('404 提示宿主版本', String(getSpeechState().error).includes('重启'), String(getSpeechState().error))

mock.handler = async () => { throw new TypeError('Failed to fetch') }
await speakText('网络炸了', {})
check('网络层失败翻成中文', String(getSpeechState().error).includes('连不上朗读服务'), String(getSpeechState().error))

mock.handler = async () => new Response(JSON.stringify({ ok: false, error: '音色不可用' }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})
await speakText('200 却报错', {})
check('200 + JSON 也按失败处理', getSpeechState().error === '音色不可用', String(getSpeechState().error))

/* ------------------------------------------------------------------ */
/* 5. 空文本不发请求                                                   */
/* ------------------------------------------------------------------ */

mock.handler = defaultHandler
const fetchCount = mock.fetches.length
await speakText('   ')
check('空文本不发请求', mock.fetches.length === fetchCount, String(mock.fetches.length - fetchCount))

/* ------------------------------------------------------------------ */
/* 6. 自动播放被拦：静默失败，不弹错                                    */
/* ------------------------------------------------------------------ */

const sharedContext = mock.contexts[0]
sharedContext.state = 'suspended'
sharedContext.resumeFails = true
const fetchesBeforeBlocked = mock.fetches.length
await speakText('会被浏览器拦', { messageId: 'm-5' })
const blocked = getSpeechState()
check('被拦时静默回到空闲', blocked.error === null && blocked.speaking === false && blocked.messageId === null, JSON.stringify(blocked))
check('被拦时不发请求（省一次上游合成）', mock.fetches.length === fetchesBeforeBlocked, String(mock.fetches.length - fetchesBeforeBlocked))
sharedContext.resumeFails = false
sharedContext.state = 'running'

/* ------------------------------------------------------------------ */
/* 7. 停止后迟到的响应不再播放                                          */
/* ------------------------------------------------------------------ */

let release = null
mock.handler = () => new Promise((done) => {
  release = () => done(new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'audio/wav' } }))
})
const sourcesBefore = mock.sources.length
const slow = speakText('慢的', { messageId: 'm-6' })
stopSpeech()
release()
await slow
await tick()
check('停止后迟到的响应不再播放', mock.sources.length === sourcesBefore, String(mock.sources.length - sourcesBefore))
check('停止后状态保持空闲', getSpeechState().speaking === false && getSpeechState().messageId === null)

/* ------------------------------------------------------------------ */
/* 8. 流式：分块边收边播                                                */
/* ------------------------------------------------------------------ */

const playersBeforeStream = mock.players.length
mock.handler = async () => streamResponse([pcmChunk(240), pcmChunk(240), pcmChunk(240)])
const streaming = speakText('流式朗读', { messageId: 'm-stream' })
await tick(30)
const streamPlayer = mock.players.at(-1)
check('流式：创建了 PcmPlayer', mock.players.length === playersBeforeStream + 1, String(mock.players.length - playersBeforeStream))
check('流式：按响应头采样率建播放器', streamPlayer?.sampleRate === 24000, String(streamPlayer?.sampleRate))
check('流式：ensureRunning 被调用', mock.ensureRunning >= 1, String(mock.ensureRunning))
check('流式：逐块 enqueue', streamPlayer?.queued.length === 3, String(streamPlayer?.queued.length))
check('流式：每块长度正确', streamPlayer?.queued[0]?.length === 240, String(streamPlayer?.queued[0]?.length))
const streamingState = getSpeechState()
check('流式：首片入队即 speaking', streamingState.speaking === true && streamingState.loading === false, JSON.stringify(streamingState))
check('流式：messageId 跟随这条消息', streamingState.messageId === 'm-stream', String(streamingState.messageId))
// 模拟「队列播完」：把 mock 的队列清空，等轮询发现并回到空闲
streamPlayer.queued.length = 0
await streaming
const afterStream = getSpeechState()
check('流式：播完回 idle', afterStream.speaking === false && afterStream.messageId === null, JSON.stringify(afterStream))

/* ------------------------------------------------------------------ */
/* 9. 流式：块边界把 PCM16 采样切开时不能错位                            */
/* ------------------------------------------------------------------ */

mock.handler = async () => streamResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])])
const odd = speakText('奇数块', { messageId: 'm-odd' })
await tick(30)
const oddPlayer = mock.players.at(-1)
check('流式：跨块残留字节拼成完整采样', oddPlayer?.queued.length === 2, String(oddPlayer?.queued.length))
check('流式：总采样数正确（6 字节 = 3 采样）', oddPlayer?.queued.reduce((sum, item) => sum + item.length, 0) === 3, String(oddPlayer?.queued.reduce((sum, item) => sum + item.length, 0)))
oddPlayer.queued.length = 0
await odd
check('流式：奇数块也能正常收尾', getSpeechState().speaking === false)

/* ------------------------------------------------------------------ */
/* 10. 流式：采样率缺省回落到 24000，且复用同一个播放器                  */
/* ------------------------------------------------------------------ */

const playersBeforeDefault = mock.players.length
mock.handler = async () => streamResponse([pcmChunk(10)], { 'x-tts-sample-rate': '' })
const defaultRate = speakText('缺省采样率', { messageId: 'm-rate' })
await tick(30)
check('流式：缺省采样率回落到 24000', mock.players.at(-1)?.sampleRate === 24000, String(mock.players.at(-1)?.sampleRate))
check('流式：同采样率复用播放器实例', mock.players.length === playersBeforeDefault, String(mock.players.length - playersBeforeDefault))
mock.players.at(-1).queued.length = 0
await defaultRate

/* ------------------------------------------------------------------ */
/* 11. 流式：停止中断播放与在途请求                                      */
/* ------------------------------------------------------------------ */

let longController = null
const longStream = new ReadableStream({
  start(controller) {
    longController = controller
    controller.enqueue(pcmChunk(240))
  },
})
mock.handler = async () => new Response(longStream, {
  status: 200,
  headers: { 'content-type': 'application/octet-stream' },
})
const longRun = speakText('长流', { messageId: 'm-stop-stream' })
await tick(30)
const longPlayer = mock.players.at(-1)
const interruptsBefore = longPlayer.interrupts
const streamSignal = mock.fetches.at(-1).init.signal
stopSpeech()
check('流式停止：player.interrupt 被调用', longPlayer.interrupts > interruptsBefore, String(longPlayer.interrupts - interruptsBefore))
check('流式停止：在途请求被 abort', streamSignal.aborted === true)
longController.close()
await longRun
const stoppedStream = getSpeechState()
check('流式停止后状态空闲', stoppedStream.speaking === false && stoppedStream.loading === false && stoppedStream.messageId === null, JSON.stringify(stoppedStream))

/* ------------------------------------------------------------------ */
/* 12. 流式：空流给出可读错误                                          */
/* ------------------------------------------------------------------ */

mock.handler = async () => new Response(new ReadableStream({ start(controller) { controller.close() } }), {
  status: 200,
  headers: { 'content-type': 'application/octet-stream' },
})
await speakText('空流', {})
check('空流给出可读错误', String(getSpeechState().error).includes('没有返回音频'), String(getSpeechState().error))

/* ------------------------------------------------------------------ */
/* 12.5 流式中途断开：给出「朗读中断」而不是静默当播完                    */
/* ------------------------------------------------------------------ */

mock.handler = async () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(pcmChunk(240))
    setTimeout(() => controller.error(new TypeError('terminated')), 10)
  },
}), {
  status: 200,
  headers: { 'content-type': 'application/octet-stream', 'x-tts-sample-rate': '24000' },
})
await speakText('流断了', { messageId: 'm-cut' })
const cutState = getSpeechState()
check('流式中途断开：状态带「朗读中断」错误', String(cutState.error).includes('朗读中断'), String(cutState.error))
check('流式中途断开：不会静默回到空闲而无错误', cutState.error !== null, JSON.stringify(cutState))
// 清掉 mock 播放器里残留的队列，别影响后面的用例
if (mock.players.at(-1) !== undefined) mock.players.at(-1).queued.length = 0

/* ------------------------------------------------------------------ */
/* 13. primeSpeech：手势里预热两条播放链路                              */
/* ------------------------------------------------------------------ */

mock.handler = defaultHandler
const ensureBeforePrime = mock.ensureRunning
primeSpeech()
await tick(10)
check('primeSpeech 预热流式播放器（ensureRunning）', mock.ensureRunning > ensureBeforePrime, String(mock.ensureRunning - ensureBeforePrime))

/* ------------------------------------------------------------------ */
/* 14. 文本清洗                                                        */
/* ------------------------------------------------------------------ */

const markdown = [
  '# 标题',
  '',
  '这是 **重点** 内容，还有 命令 npm install 要跑。',
  '',
  '- 第一点',
  '- 第二点',
  '',
  '[点这里](https://example.com/x) 看详情',
  '',
  '![图片文件名](https://example.com/a.png)',
  '',
  '| 项目 | 值 |',
  '| --- | --- |',
  '| 甲 | 乙 |',
  '',
  '<br>结尾',
].join('\n')

const cleaned = cleanSpeechText(markdown)
check('行内代码保留文字', cleaned.includes('npm install'), cleaned)
check('HTML 标签去掉', !cleaned.includes('<br'), cleaned)
check('标题符号去掉', !cleaned.includes('#'), cleaned)
check('列表符号去掉', !cleaned.includes('- '), cleaned)
check('加粗星号去掉', !cleaned.includes('*'), cleaned)
check('链接只留文字', cleaned.includes('点这里') && !cleaned.includes('example.com'), cleaned)
check('图片整段去掉', !cleaned.includes('图片文件名'), cleaned)
check('表格分隔行不念', !cleaned.includes('---'), cleaned)
check('表格文字保留', cleaned.includes('项目') && cleaned.includes('甲'), cleaned)
check('压缩成单行', !cleaned.includes('\n') && !cleaned.includes('  '), cleaned)

// 代码块单独一段测：围栏与里面的代码都该消失，围栏之外的文字要留住
const fence = String.fromCharCode(96, 96, 96)
const fenced = '看这个 ' + fence + 'js\nconst hidden = 1\n' + fence + ' 然后继续'
const cleanedFence = cleanSpeechText(fenced)
check('代码块内容不念', !cleanedFence.includes('hidden'), cleanedFence)
check('代码块围栏不念', !cleanedFence.includes('js'), cleanedFence)
check('代码块之外的文字保留', cleanedFence.includes('看这个') && cleanedFence.includes('然后继续'), cleanedFence)

// 整条消息的兜底上限变成 2000 字；超长时按句边界截断，不能停在半句中间
check('整条消息上限是 2000 字', SPEECH_MAX_CHARS === 2000, String(SPEECH_MAX_CHARS))
const longNoPunctuation = cleanSpeechText('啊'.repeat(2500))
check('无句号超长文本硬切到总上限并加省略号', longNoPunctuation.length === SPEECH_MAX_CHARS + 1 && longNoPunctuation.endsWith('…'), String(longNoPunctuation.length))
const longSentence = cleanSpeechText('第一句。' + '啊'.repeat(2100))
check('超长文本优先按句边界截断', longSentence === '第一句。…', longSentence.slice(0, 20))

// splitSpeechChunks 纯函数：句边界 / 逗号二次切 / 无标点硬切都要保证每段 <= max
check('单段上限是 200 字', SPEECH_CHUNK_CHARS === 200, String(SPEECH_CHUNK_CHARS))
const sentenceChunks = splitSpeechChunks('第一句。第二句。', 6)
check('splitSpeechChunks 按句号切句', sentenceChunks.length === 2 && sentenceChunks[0] === '第一句。' && sentenceChunks[1] === '第二句。', JSON.stringify(sentenceChunks))
const newlineChunks = splitSpeechChunks('上半句\n下半句', 4)
check('splitSpeechChunks 按换行切句', newlineChunks.length === 2 && newlineChunks[0] === '上半句' && newlineChunks[1] === '下半句', JSON.stringify(newlineChunks))
const commaChunks = splitSpeechChunks('甲'.repeat(200) + '，' + '乙'.repeat(200) + '。', 250)
check('splitSpeechChunks 超长句按逗号二次切', commaChunks.length === 2 && commaChunks.every((chunk) => chunk.length <= 250), JSON.stringify(commaChunks.map((chunk) => chunk.length)))
const punctuationFree = '丙'.repeat(1000)
const hardChunks = splitSpeechChunks(punctuationFree, 380)
check('splitSpeechChunks 无标点硬切且每段不超上限', hardChunks.length === 3 && hardChunks.every((chunk) => chunk.length <= 380), JSON.stringify(hardChunks.map((chunk) => chunk.length)))
check('splitSpeechChunks 硬切不丢字', hardChunks.join('') === punctuationFree, String(hardChunks.join('').length))
const mergedChunks = splitSpeechChunks('短句一。短句二。', 380)
check('splitSpeechChunks 短句合并成一段', mergedChunks.length === 1 && mergedChunks[0] === '短句一。短句二。', JSON.stringify(mergedChunks))

/* ------------------------------------------------------------------ */
/* 15. 长文本：分段请求、每段 <= 200、全部播完才回 idle                  */
/* ------------------------------------------------------------------ */

mock.handler = defaultHandler
// 三句各 150 字 + 句号：按句切成 3 段（每段 151 字，<= 200）
const longSpeechText = '甲'.repeat(150) + '。' + '乙'.repeat(150) + '。' + '丙'.repeat(150) + '。'
// 等到「第 N 段请求已发出 + 第 N 个 WAV source 已创建」，避免拿到上一段的旧节点
const waitForPlayback = async (fetchCount, sourceCount) => {
  const deadline = Date.now() + 2000
  while ((mock.fetches.length < fetchCount || mock.sources.length < sourceCount) && Date.now() < deadline) await tick(5)
}
const fetchesBeforeLong = mock.fetches.length
const sourcesBeforeLong = mock.sources.length
const longPlayback = speakText(longSpeechText, { messageId: 'm-long' })

await waitForPlayback(fetchesBeforeLong + 1, sourcesBeforeLong + 1)
check('长文本：第一段请求已发出', mock.fetches.length === fetchesBeforeLong + 1, String(mock.fetches.length - fetchesBeforeLong))
const firstLongText = JSON.parse(mock.fetches[fetchesBeforeLong].init.body).text
check('长文本：每段不超过单段上限', firstLongText.length <= SPEECH_CHUNK_CHARS, String(firstLongText.length))

// 第一段播完 → 才应该请求第二段
mock.sources.at(-1).onended()
await waitForPlayback(fetchesBeforeLong + 2, sourcesBeforeLong + 2)
check('长文本：第一段播完才请求第二段', mock.fetches.length === fetchesBeforeLong + 2, String(mock.fetches.length - fetchesBeforeLong))
check('长文本：段间保持 speaking', getSpeechState().speaking === true && getSpeechState().messageId === 'm-long', JSON.stringify(getSpeechState()))
const secondLongText = JSON.parse(mock.fetches[fetchesBeforeLong + 1].init.body).text
check('长文本：第二段也不超上限', secondLongText.length <= SPEECH_CHUNK_CHARS, String(secondLongText.length))

// 第二段播完 → 第三段
mock.sources.at(-1).onended()
await waitForPlayback(fetchesBeforeLong + 3, sourcesBeforeLong + 3)
check('长文本：第二段播完才请求第三段', mock.fetches.length === fetchesBeforeLong + 3, String(mock.fetches.length - fetchesBeforeLong))
const thirdLongText = JSON.parse(mock.fetches[fetchesBeforeLong + 2].init.body).text
check('长文本：第三段也不超上限', thirdLongText.length <= SPEECH_CHUNK_CHARS, String(thirdLongText.length))
check('长文本：三段拼起来就是原文', firstLongText + secondLongText + thirdLongText === longSpeechText, String((firstLongText + secondLongText + thirdLongText).length))

// 最后一段还没播完：不能提前回 idle
check('长文本：最后一段播完前保持 speaking', getSpeechState().speaking === true, JSON.stringify(getSpeechState()))
mock.sources.at(-1).onended()
await longPlayback
const afterLong = getSpeechState()
check('长文本：全部播完才回 idle', afterLong.speaking === false && afterLong.loading === false && afterLong.messageId === null, JSON.stringify(afterLong))

/* ------------------------------------------------------------------ */
/* 16. speechTextOf                                                    */
/* ------------------------------------------------------------------ */

const botMessage = {
  id: 'msg-1',
  botId: 'bot-1',
  role: 'bot',
  at: 0,
  blocks: [
    { type: 'text', text: '你好 **世界**' },
    { type: 'image', image: { url: 'u', path: 'p' } },
  ],
}
check('speechTextOf 取 text 块并清洗', speechTextOf(botMessage) === '你好 世界', speechTextOf(botMessage))
check('没有 text 块 → 空串', speechTextOf({ ...botMessage, blocks: [{ type: 'tool', run: {} }] }) === '')
check('空白文本 → 空串', speechTextOf({ ...botMessage, blocks: [{ type: 'text', text: '   ' }] }) === '')
check('多段 text 块拼接', speechTextOf({
  ...botMessage,
  blocks: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
}) === '第一段 第二段')

/*
 * 交互卡（问答 / 审批 / 表单）：卡片没有 text 块，问题在 prompt、选项在 ui.options。
 * 只念 text 块时这类消息永远是空串——「需要你定」静悄悄，用户根本不知道 Bot 在等。
 */
const askCard = {
  ...botMessage,
  kind: 'need-input',
  blocks: [{
    type: 'interactive',
    prompt: '你说的 superagent 项目是指哪个？',
    ui: {
      kind: 'options',
      title: '需要你确认',
      allowCustom: true,
      options: [
        { id: 'a', label: 'dsh-superagent-prototype' },
        { id: 'b', label: 'Superagent（开源 AI agent 平台）' },
        { id: 'c', label: '字节跳动 DeerFlow 2.0' },
      ],
    },
  }],
  at: 0,
}
check(
  '问答卡：念标题 + 问题 + 选项',
  speechTextOf(askCard) === '需要你确认 你说的 superagent 项目是指哪个？ 选项：dsh-superagent-prototype，Superagent（开源 AI agent 平台），字节跳动 DeerFlow 2.0',
  speechTextOf(askCard),
)
check('开放问题（无选项）只念标题 + 问题', speechTextOf({
  ...askCard,
  blocks: [{ type: 'interactive', prompt: '你的项目叫什么名字？', ui: { kind: 'options', title: '需要你确认', allowCustom: true, options: [] } }],
}) === '需要你确认 你的项目叫什么名字？', speechTextOf({
  ...askCard,
  blocks: [{ type: 'interactive', prompt: '你的项目叫什么名字？', ui: { kind: 'options', title: '需要你确认', allowCustom: true, options: [] } }],
}))
check('审批卡：念按钮（允许 / 拒绝）', speechTextOf({
  ...askCard,
  kind: 'approval',
  blocks: [{ type: 'interactive', prompt: '要删除这张表吗？', ui: { kind: 'buttons', title: '需要你确认', options: [{ id: 'allow', label: '允许' }, { id: 'deny', label: '拒绝' }] } }],
}) === '需要你确认 要删除这张表吗？ 选项：允许，拒绝')
check('表单卡：只念标题与说明，不念字段', speechTextOf({
  ...askCard,
  blocks: [{
    type: 'interactive',
    prompt: '每天几点提醒？',
    ui: { kind: 'form', title: '建一个提醒', fields: [{ id: 'time', label: '时间', type: 'time' }] },
  }],
}) === '建一个提醒 每天几点提醒？')
check('正文 + 卡片混排：两段都念', speechTextOf({
  ...askCard,
  blocks: [{ type: 'text', text: '我看了下，得先确认。' }, askCard.blocks[0]],
}) === '我看了下，得先确认。 需要你确认 你说的 superagent 项目是指哪个？ 选项：dsh-superagent-prototype，Superagent（开源 AI agent 平台），字节跳动 DeerFlow 2.0')
check('卡片已提交不影响朗读文本（回看时仍可念）', speechTextOf({
  ...askCard,
  blocks: [{ ...askCard.blocks[0], submitted: true, result: 'dsh-superagent-prototype' }],
}).startsWith('需要你确认'))

/* ------------------------------------------------------------------ */
/* 17. 朗读音量（会话头音量浮层控制的就是这个值）                        */
/* ------------------------------------------------------------------ */

check('没存过音量 → 满音量', getSpeechVolume() === 1, String(getSpeechVolume()))
setSpeechVolume(0.35)
check('setSpeechVolume 立即生效', Math.abs(getSpeechVolume() - 0.35) < 1e-9, String(getSpeechVolume()))
check('音量写进 localStorage', storage.get('pa:speech-volume:v1') === '0.35', String(storage.get('pa:speech-volume:v1')))
setSpeechVolume(2)
check('音量上界钳到 1', getSpeechVolume() === 1, String(getSpeechVolume()))
setSpeechVolume(-3)
check('音量下界钳到 0', getSpeechVolume() === 0, String(getSpeechVolume()))
setSpeechVolume(Number.NaN)
check('非数字音量回满音量', getSpeechVolume() === 1, String(getSpeechVolume()))

// 流式路径：PcmPlayer 重建后必须沿用当前音量（新实例默认满音量）
const volumePlayer = mock.players.at(-1)
check('存在流式播放器（primeSpeech / 播放过）', volumePlayer !== undefined)
setSpeechVolume(0.42)
check('音量实时写进 PcmPlayer', volumePlayer !== undefined && Math.abs(volumePlayer.volume - 0.42) < 1e-9, String(volumePlayer?.volume))

// 整段 WAV 路径：主增益是模块级缓存，同样要跟着变
const volumeGain = mock.gains.at(-1)
check('存在 WAV 主增益（播放过）', volumeGain !== undefined)
setSpeechVolume(0.66)
check('音量实时写进 WAV 主增益', volumeGain !== undefined && Math.abs(volumeGain.gain.value - 0.66) < 1e-9, String(volumeGain?.gain.value))

// 重建上下文（浏览器休眠后旧 context 会 closed）时要沿用已存的音量，不能回落满音量
await tick(10)
for (const context of mock.contexts) context.state = 'closed'
setSpeechVolume(0.25)
primeSpeech()
await tick(10)
const rebuiltGain = mock.gains.at(-1)
check('重建上下文沿用音量', rebuiltGain !== undefined && Math.abs(rebuiltGain.gain.value - 0.25) < 1e-9, String(rebuiltGain?.gain.value))

/* ------------------------------------------------------------------ */
/* 18. 源码接线断言（防止后续改动把界面入口 / 流式契约悄悄拆掉）          */
/* ------------------------------------------------------------------ */

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')

const speechSrc = read('src/client/personal/speech.ts')
check('speech.ts 请求体总是要流式', speechSrc.includes('stream: true'))
check('speech.ts 用契约的流式 MIME', speechSrc.includes('REALTIME_TTS_STREAM_MIME'))
check('speech.ts 用契约的采样率响应头', speechSrc.includes('REALTIME_TTS_SAMPLE_RATE_HEADER'))
check('speech.ts 不硬编码采样率响应头名', !speechSrc.includes("'x-tts-sample-rate'"))
check('speech.ts 不硬编码 TTS 路径', speechSrc.includes('REALTIME_TTS_PATH') && !speechSrc.includes("'/api/personal-agent/tts'"))
check('speech.ts 复用通话的 PcmPlayer', speechSrc.includes("from './call/realtime-audio.ts'") && speechSrc.includes('new PcmPlayer('))
check('speech.ts 用 getReader 逐块读流', speechSrc.includes('getReader()'))
check('speech.ts 调用 ensureRunning', speechSrc.includes('ensureRunning()'))
check('speech.ts 停止时打断播放队列', speechSrc.includes('stopPlayer()'))
check('speech.ts 保留 primeSpeech 预热', speechSrc.includes('export function primeSpeech'))
check('speech.ts 按 content-type 分流', speechSrc.includes('responseKind') && speechSrc.includes('REALTIME_TTS_STREAM_MIME'))
check('speech.ts 用契约里的字符上限兜底', speechSrc.includes('REALTIME_TTS_MAX_CHARS'))
check('speech.ts 整条消息上限改为 2000', /SPEECH_MAX_CHARS = 2000/.test(speechSrc))
check('speech.ts 单段上限是 200', speechSrc.includes('SPEECH_CHUNK_CHARS = 200'))
check('speech.ts 导出 splitSpeechChunks', speechSrc.includes('export function splitSpeechChunks'))
check('speech.ts 截断走句边界', speechSrc.includes('truncateSpeechText'))
check('speech.ts speakText 按 chunks 循环', speechSrc.includes('for (const chunk of chunks)'))
const playStreamSrc = speechSrc.slice(speechSrc.indexOf('async function playSpeechStream'), speechSrc.indexOf('export async function speakText'))
check('speech.ts playSpeechStream 不再自行回 idle', !/^[ \t]*patchState\(idleState\(\)\)/m.test(playStreamSrc))
check('speech.ts playBuffer 等 onended', speechSrc.includes('finishPlayback') && speechSrc.includes('await finished'))
check('speech.ts stopPlayback 兑现等待中的 Promise', speechSrc.includes('resolvePlayback()'))

const messageListSrc = read('src/client/personal/chat/MessageList.tsx')
check('MessageList 引入喇叭图标', messageListSrc.includes('IconVolume'))
check('MessageList 引入停止图标', messageListSrc.includes('IconStop'))
check('MessageList 有朗读 / 停止文案', messageListSrc.includes('朗读这条消息') && messageListSrc.includes('停止朗读'))
check('MessageList 在引用按钮之后渲染朗读按钮', messageListSrc.includes("message.role === 'bot' ? <SpeakToolButton"))
check('MessageList 朗读按钮带 data-speaking 态', messageListSrc.includes("data-speaking={active ? 'true' : 'false'}"))
check('MessageList 自动朗读防抖 250ms', messageListSrc.includes('AUTO_SPEAK_DELAY_MS = 250'))
check('MessageList 自动朗读只认 bot.autoSpeak', messageListSrc.includes('bot.autoSpeak === true'))
check('MessageList 只在单聊自动播', messageListSrc.includes('room !== null'))
check('MessageList 通话中不自动播', messageListSrc.includes("ui.call.status !== 'idle'"))
check('MessageList 记录已播消息（首次挂载不重播历史）', messageListSrc.includes('spokenRef'))
check('MessageList pending 消息不自动播', messageListSrc.includes('last.pending === true'))

const settingsSrc = read('src/client/personal/shell/BotSettingsCard.tsx')
/*
 * 2026-11-05：设置卡里那个重复的「自动朗读回复」开关已撤掉，入口统一到会话头。
 * 三条断言一起盯：设置卡不得再出现该字段 / 开关按钮，但音色与 Live 供应商必须
 * 还在（撤的是入口，不是语音配置），设置卡的其它开关也不能被连带删掉。
 */
check('设置卡不再有自动朗读开关（唯一入口在会话头）', !settingsSrc.includes('autoSpeak') && !settingsSrc.includes('关闭自动朗读回复'))
check('设置卡语音页仍保留音色 / Live 供应商', settingsSrc.includes('通话音色') && settingsSrc.includes('通话供应商'))
check('设置卡仍有其它开关（pa-bset-switch 未被整块带走）', settingsSrc.includes('pa-bset-switch'))

const typesSrc = read('src/client/personal/types.ts')
check('Bot 类型有 autoSpeak 可选字段', typesSrc.includes('autoSpeak?: boolean'))

const storeSrc = read('src/client/personal/store.tsx')
check('normalizeState 归一化 autoSpeak', storeSrc.includes('autoSpeak: bot.autoSpeak === true'))

const chatCssSrc = read('src/client/personal/chat/chat.css.ts')
check('CSS 有播放中态选择器', chatCssSrc.includes("button.pa-msg__tool[data-speaking='true']"))
check('CSS 有脉冲关键帧', chatCssSrc.includes('@keyframes pa-msg-speaking'))
check('CSS 播放中态遵守 reduced-motion', chatCssSrc.includes('button.pa-msg__tool[data-speaking=\'true\'] { animation: none; }'))

/*
 * 自动播报开关（2026-11-05）：从设置卡挪到会话头、放在通话按钮左侧，悬停出
 * 音量条，并成为**唯一入口**（设置卡那个重复开关已删）。下面几条盯住「入口在
 * 通话按钮左侧」「读写的是 Bot 数据里的那一份字段」「群聊不出现无效果入口」这
 * 三件容易被后续重构悄悄拆掉的事。
 */
const chatPanelSrc = read('src/client/personal/chat/ChatPanel.tsx')
check('ChatPanel 引入自动播报按钮', chatPanelSrc.includes("from './AutoSpeakButton.tsx'"))
check(
  '自动播报按钮在通话按钮左侧',
  chatPanelSrc.includes('<AutoSpeakButton />')
    && chatPanelSrc.indexOf('<AutoSpeakButton />') < chatPanelSrc.indexOf('onClick={handleCall}'),
)
const autoSpeakSrc = read('src/client/personal/chat/AutoSpeakButton.tsx')
check('自动播报读写 bot.autoSpeak（Bot 数据里唯一的那份）', autoSpeakSrc.includes('activeBot.autoSpeak') && autoSpeakSrc.includes('actions.updateBot'))
check('自动播报悬停展开音量浮层', autoSpeakSrc.includes('onMouseEnter') && autoSpeakSrc.includes('onMouseLeave') && autoSpeakSrc.includes('closeSoon'))
check('音量浮层用共用 VolumeSlider 接 setSpeechVolume', autoSpeakSrc.includes('VolumeSlider') && autoSpeakSrc.includes('setSpeechVolume'))
check('群聊不渲染自动播报', autoSpeakSrc.includes('activeRoom !== null') && autoSpeakSrc.includes('return null'))
check('CSS 有自动播报浮层', chatCssSrc.includes('.pa-autospeak__panel'))
check('自动播报浮层遵守 reduced-motion', chatCssSrc.includes('.pa-autospeak__panel { animation: none; }'))

/*
 * 音量滑条（2026-11-05）：用户要求「拖动条要有明显的粗细变化」，落地为
 * 「已选段粗 / 未选段细」；通话弹层与会话头浮层共用同一个组件与同一套样式。
 * 这几条把「两段粗细差」「两处共用」「原生交互仍在」三件事钉住——它们都是
 * 纯视觉约定，没有渲染测试会在改样式时报警。
 */
const baseCssSrc = read('src/client/personal/base.css.ts')
const vsSrc = read('src/client/personal/shared/VolumeSlider.tsx')
const callOverlaySrc = read('src/client/personal/call/CallOverlay.tsx')
const callCssSrc = read('src/client/personal/call/call.css.ts')
check(
  '音量滑条已选段明显比未选段粗',
  /\.pa-vs__fill[\s\S]{0,400}height: 10px/.test(baseCssSrc)
    && /\.pa-vs__rest[\s\S]{0,400}height: 4px/.test(baseCssSrc),
)
check('悬停 / 拖动时两段一起加粗一档', baseCssSrc.includes('.pa-vs:hover .pa-vs__fill') && baseCssSrc.includes('.pa-vs:hover .pa-vs__rest'))
check('共用滑条保留原生 range 语义（键盘 / 读屏）', vsSrc.includes('type="range"') && vsSrc.includes('aria-valuetext') && vsSrc.includes('--pa-vs-fill'))
check('通话弹层与自动播报共用同一音量滑条', callOverlaySrc.includes('VolumeSlider') && autoSpeakSrc.includes('VolumeSlider'))
check('两处各自只指定颜色 / 底色变量', callCssSrc.includes('--pa-vs-color') && chatCssSrc.includes('--pa-vs-color'))
check('旧的两套单条 range 样式已删除', !callCssSrc.includes('.pa-call__volume-range') && !chatCssSrc.includes('.pa-autospeak__range'))

const protocolSrc = read('src/shared/realtime-protocol.ts')
check('契约里有 TTS 端点常量', protocolSrc.includes('REALTIME_TTS_PATH'))
check('契约里有流式 MIME 常量', protocolSrc.includes('REALTIME_TTS_STREAM_MIME'))
check('契约里有采样率响应头常量', protocolSrc.includes('REALTIME_TTS_SAMPLE_RATE_HEADER'))

console.log('')
if (failures.length === 0) {
  console.log('SPEECH CLIENT VERIFY PASSED')
} else {
  console.log('SPEECH CLIENT VERIFY FAILED (' + failures.length + '): ' + failures.join(', '))
  process.exitCode = 1
}
