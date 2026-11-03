/**
 * realtime-audio.ts 的单元测试（Node 里跑，无 DOM / 无真实 AudioContext）。
 *
 * 覆盖：
 *   1. 契约常量（24000 Hz / 40 ms / 960 采样 / 1920 字节）；
 *   2. PCM16 双向转换的边界（-1 / 0 / 1、溢出钳制、NaN、奇数字节、byteOffset）；
 *   3. base64 编解码（与标准 base64 一致、往返、空白容错、非法输入）；
 *   4. 重采样（48k → 24k、同采样率直通、跨帧相位连续）与 40 ms 分片；
 *   5. MicStreamer：AudioWorklet 路径（Blob URL 注册、分片回调、静音、幂等 stop）、
 *      ScriptProcessor 兜底（48k 输入重采样成 24k）、addModule 失败回退、
 *      麦克风权限被拒的错误文案；
 *   6. PcmPlayer：nextStartTime 串接时序、interrupt 立刻停播并重置时间轴、
 *      空分片忽略、奇数字节 ArrayBuffer、close 幂等。
 *
 * 运行：node scripts/test-realtime-audio.mjs
 */
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requirePlugin = createRequire(resolve(ROOT, 'package.json'))
const esbuild = requirePlugin('esbuild')

/*
 * 用 esbuild bundle 而不是单文件 transform：realtime-audio.ts 还 import 着
 * shared/realtime-protocol.ts（带 .ts 扩展名的裸相对路径），transform 出来的
 * 产物 Node 直接 ERR_MODULE_NOT_FOUND，测试会以「找不到模块」而不是断言失败挂掉。
 */
const buildDir = mkdtempSync(resolve(tmpdir(), 'dsh-realtime-audio-'))
const bundleFile = resolve(buildDir, 'realtime-audio.mjs')
await esbuild.build({
  entryPoints: [resolve(ROOT, 'src/client/personal/call/realtime-audio.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: bundleFile,
  logLevel: 'silent',
})
const mod = await import(pathToFileURL(bundleFile).href)

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
  passed += 1
}

/* -------------------------------------------------------------------------- */
/* 全局桩工具                                                                  */
/* -------------------------------------------------------------------------- */

const savedGlobals = new Map()
function setGlobal(name, value) {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
function restoreGlobals() {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor === undefined) delete globalThis[name]
    else Object.defineProperty(globalThis, name, descriptor)
  }
  savedGlobals.clear()
}

function installObjectUrlSpy() {
  const calls = { created: [], revoked: [] }
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = (blob) => {
    const url = `blob:fake-worklet-${calls.created.length + 1}`
    calls.created.push({ url, type: blob === null || blob === undefined ? '' : blob.type })
    return url
  }
  URL.revokeObjectURL = (url) => {
    calls.revoked.push(url)
  }
  return {
    calls,
    restore() {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    },
  }
}

function installMediaDevices(impl) {
  const calls = []
  const mediaDevices = {
    async getUserMedia(constraints) {
      calls.push(constraints)
      return impl(constraints)
    },
  }
  setGlobal('navigator', { mediaDevices })
  return { calls }
}

function createFakeStream() {
  const track = {
    stopped: false,
    stop() {
      track.stopped = true
    },
  }
  return { track, getTracks: () => [track], getAudioTracks: () => [track] }
}

function installFakeWorkletNode() {
  const instances = []
  class FakeAudioWorkletNode {
    constructor(context, name, options) {
      this.context = context
      this.name = name
      this.options = options
      this.port = { onmessage: null, postMessage() {} }
      this.connected = []
      instances.push(this)
    }
    connect(target) {
      this.connected.push(target)
    }
    disconnect() {
      this.disconnected = true
    }
  }
  setGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  return instances
}

/**
 * 最小 AudioContext 桩：只实现本文件用到的方法，其余按需记录调用。
 * options.sampleRate 控制 context.sampleRate（模拟「浏览器不遵守 24k 请求」）。
 */
function createFakeAudioContext(options = {}) {
  const spy = {
    contexts: [],
    sources: [],
    processors: [],
    gains: [],
    resumeCalls: 0,
    closeCalls: 0,
    addModuleCalls: [],
    bufferCalls: [],
  }
  class FakeAudioContext {
    constructor(ctorOptions = {}) {
      this.requestedSampleRate = ctorOptions.sampleRate
      this.sampleRate = options.sampleRate ?? ctorOptions.sampleRate ?? 24000
      this.state = options.state ?? 'running'
      this.currentTime = options.currentTime ?? 0
      this.destination = { kind: 'destination' }
      this.audioWorklet = options.disableWorklet === true
        ? undefined
        : {
            addModule: async (url) => {
              spy.addModuleCalls.push(url)
              if (options.addModuleFails === true) throw new Error('addModule failed')
            },
          }
      spy.contexts.push(this)
    }
    async resume() {
      spy.resumeCalls += 1
      this.state = 'running'
    }
    async close() {
      spy.closeCalls += 1
      this.state = 'closed'
    }
    createMediaStreamSource(stream) {
      const node = {
        stream,
        connected: [],
        connect(target) {
          node.connected.push(target)
        },
        disconnect() {},
      }
      return node
    }
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      spy.bufferCalls.push({ channels, length, sampleRate })
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (index) => data[index],
      }
    }
    createBufferSource() {
      const source = {
        buffer: null,
        connected: null,
        startCalls: [],
        stopCalls: 0,
        onended: null,
        connect(target) {
          source.connected = target
        },
        start(when) {
          source.startCalls.push(when === undefined ? 0 : when)
        },
        stop() {
          source.stopCalls += 1
        },
        disconnect() {},
      }
      spy.sources.push(source)
      return source
    }
    createScriptProcessor(bufferSize, inputChannels, outputChannels) {
      const node = {
        bufferSize,
        inputChannels,
        outputChannels,
        onaudioprocess: null,
        connected: [],
        connect(target) {
          node.connected.push(target)
        },
        disconnect() {},
      }
      spy.processors.push(node)
      return node
    }
    createGain() {
      const node = {
        gain: { value: 1 },
        connected: [],
        connect(target) {
          node.connected.push(target)
        },
        disconnect() {},
      }
      spy.gains.push(node)
      return node
    }
  }
  return { FakeAudioContext, spy }
}

/* -------------------------------------------------------------------------- */
/* 1. 契约常量                                                                 */
/* -------------------------------------------------------------------------- */
{
  check(mod.AUDIO_SAMPLE_RATE === 24000, `采样率应为 24000，实际 ${mod.AUDIO_SAMPLE_RATE}`)
  check(mod.MIC_CHUNK_SAMPLES === 960, `每片采样数应为 960，实际 ${mod.MIC_CHUNK_SAMPLES}`)
  check(mod.MIC_CHUNK_BYTES === 1920, `每片字节数应为 1920，实际 ${mod.MIC_CHUNK_BYTES}`)
  check(mod.CAPTURE_PROCESSOR_NAME === 'pa-pcm-capture', 'worklet 处理器名')
  check(typeof mod.CAPTURE_WORKLET_SOURCE === 'string', 'worklet 源码是字符串')
  check(mod.CAPTURE_WORKLET_SOURCE.includes('registerProcessor'), 'worklet 源码注册处理器')
  check(mod.CAPTURE_WORKLET_SOURCE.includes('AudioWorkletProcessor'), 'worklet 源码继承 AudioWorkletProcessor')
  check(mod.CAPTURE_WORKLET_SOURCE.includes(`registerProcessor('${mod.CAPTURE_PROCESSOR_NAME}'`), '源码里的处理器名与常量一致')
  check(!mod.CAPTURE_WORKLET_SOURCE.includes(String.fromCharCode(96)), 'worklet 源码里没有反引号（否则会打断外层模板字面量）')
  let parsed = true
  try {
    // Function 构造器只编译不执行：能验证 worklet 源码语法合法，又不会真的求值。
    new Function(mod.CAPTURE_WORKLET_SOURCE)
  } catch {
    parsed = false
  }
  check(parsed, 'worklet 源码语法可解析')
  console.log('✓ 契约常量与 worklet 内联源码')
}

/* -------------------------------------------------------------------------- */
/* 2. float32ToPcm16 / pcm16ToFloat32                                          */
/* -------------------------------------------------------------------------- */
{
  const encoded = mod.float32ToPcm16(new Float32Array([-1, 0, 1, 0.5, -0.5, 1.5, -1.5, NaN, Infinity, -Infinity]))
  check(encoded[0] === -32768, `-1 应映射到 -32768，实际 ${encoded[0]}`)
  check(encoded[1] === 0, '0 应映射到 0')
  check(encoded[2] === 32767, `1 应映射到 32767，实际 ${encoded[2]}`)
  check(encoded[3] === 16384, `0.5 应映射到 16384，实际 ${encoded[3]}`)
  check(encoded[4] === -16384, `-0.5 应映射到 -16384，实际 ${encoded[4]}`)
  check(encoded[5] === 32767, '超过 +1 应钳制到 32767')
  check(encoded[6] === -32768, '低于 -1 应钳制到 -32768')
  check(encoded[7] === 0, 'NaN 应归零')
  check(encoded[8] === 32767, '+Infinity 应钳制到 32767')
  check(encoded[9] === -32768, '-Infinity 应钳制到 -32768')
  check(mod.float32ToPcm16(new Float32Array(0)).length === 0, '空输入返回空数组')

  // Int16 → Float32 → Int16 必须无损（正负半轴用不同除数正是为此）。
  const original = new Int16Array([-32768, -12345, -1, 0, 1, 12345, 32767])
  const roundTrip = mod.float32ToPcm16(mod.pcm16ToFloat32(original))
  check(roundTrip.length === original.length, '往返长度一致')
  let lossless = true
  for (let index = 0; index < original.length; index += 1) {
    if (roundTrip[index] !== original[index]) lossless = false
  }
  check(lossless, 'Int16 → Float32 → Int16 无损往返')

  const floats = mod.pcm16ToFloat32(new Int16Array([-32768, -1, 0, 1, 32767]))
  check(floats[0] === -1, '-32768 应映射到 -1')
  check(Math.abs(floats[1] - (-1 / 32768)) < 1e-9, '-1 应映射到 -1/32768')
  check(floats[2] === 0, '0 应映射到 0')
  check(Math.abs(floats[3] - 1 / 32767) < 1e-9, '1 应映射到 1/32767')
  check(floats[4] === 1, '32767 应映射到 1')
  console.log('✓ PCM16 双向转换边界（-1/0/1、溢出钳制、NaN/Infinity）')
}

{
  // ArrayBuffer 输入按小端解析：-32768 = 00 80，32767 = ff 7f，0 = 00 00。
  const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00])
  const floats = mod.pcm16ToFloat32(bytes.buffer)
  check(floats.length === 3, `3 个采样，实际 ${floats.length}`)
  check(floats[0] === -1, '小端 -32768')
  check(floats[1] === 1, '小端 32767')
  check(floats[2] === 0, '小端 0')

  const odd = new Uint8Array([0x00, 0x80, 0xff])
  check(mod.pcm16ToFloat32(odd.buffer).length === 1, '奇数字节丢弃尾部不完整采样')

  // 带 byteOffset 的视图不能被当成从头开始解析。
  const backing = new Int16Array([12345, -32768, 32767])
  const view = backing.subarray(1)
  const viewFloats = mod.pcm16ToFloat32(view)
  check(viewFloats.length === 2 && viewFloats[0] === -1 && viewFloats[1] === 1, '尊重 Int16Array 的 byteOffset')

  let threw = false
  try {
    mod.pcm16ToFloat32(new Float32Array(4))
  } catch {
    threw = true
  }
  check(threw, '非 Int16Array/ArrayBuffer 输入抛 TypeError')
  console.log('✓ pcm16ToFloat32 的 ArrayBuffer / 奇数字节 / byteOffset 边界')
}

/* -------------------------------------------------------------------------- */
/* 3. base64 编解码                                                            */
/* -------------------------------------------------------------------------- */
{
  const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234])
  const encoded = mod.pcm16ToBase64(samples)
  const expected = Buffer.from(
    new Uint8Array(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)),
  ).toString('base64')
  check(encoded === expected, `base64 应与标准实现一致：${encoded} !== ${expected}`)
  check(mod.pcm16ToBase64(new Int16Array(0)) === '', '空采样编码为空字符串')

  const decoded = mod.base64ToPcm16(encoded)
  check(decoded.length === samples.length, 'base64 往返长度一致')
  let same = true
  for (let index = 0; index < samples.length; index += 1) {
    if (decoded[index] !== samples[index]) same = false
  }
  check(same, 'base64 往返数值一致')

  check(mod.base64ToPcm16('').length === 0, '空字符串解码为空采样')
  check(mod.base64ToPcm16(encoded.replace(/(.{4})/g, '$1\n')).length === samples.length, '解码忽略换行')
  check(mod.base64ToPcm16(encoded.replace(/=+$/, '')).length === samples.length, '解码容忍缺失 padding')

  let threw = false
  try {
    mod.base64ToPcm16('!!!!')
  } catch {
    threw = true
  }
  check(threw, '非法 base64 字符抛错（不静默产出垃圾音频）')

  threw = false
  try {
    mod.base64ToPcm16('A')
  } catch {
    threw = true
  }
  check(threw, '长度非法（%4 === 1）的 base64 抛错')

  // 显式锁死小端：采样 1 的字节是 01 00，base64 应为 AQA=。
  check(mod.pcm16ToBase64(new Int16Array([1])) === 'AQA=', 'PCM16 按小端编码')
  console.log('✓ base64 编解码（标准一致、往返、空白容错、非法输入）')
}

/* -------------------------------------------------------------------------- */
/* 4. 重采样与 40 ms 分片                                                      */
/* -------------------------------------------------------------------------- */
{
  const resampler = new mod.PcmResampler(48000, 24000)
  const output = resampler.push(new Float32Array(1920).fill(0.5))
  check(output.length === 960, `48k → 24k 应输出 960 个采样，实际 ${output.length}`)
  let constant = true
  for (let index = 0; index < output.length; index += 1) {
    if (Math.abs(output[index] - 0.5) > 1e-6) constant = false
  }
  check(constant, '常量信号经过线性插值后保持不变')

  const passthrough = new mod.PcmResampler(24000, 24000)
  const direct = passthrough.push(new Float32Array([0.1, 0.2, 0.3]))
  check(direct.length === 2, `同采样率直通应输出 2 个（最后 1 个留给跨帧插值），实际 ${direct.length}`)
  check(Math.abs(direct[0] - 0.1) < 1e-6 && Math.abs(direct[1] - 0.2) < 1e-6, '同采样率直通数值不变')
  const continued = passthrough.push(new Float32Array([0.4]))
  check(continued.length === 1 && Math.abs(continued[0] - 0.3) < 1e-6, '同采样率下上一帧保留的样本在下一帧输出')

  // 跨帧一致性：一次喂完 vs 分两帧喂，输出必须逐点相同（相位不能丢）。
  const signal = new Float32Array(3840)
  for (let index = 0; index < signal.length; index += 1) signal[index] = Math.sin(index / 10)
  const whole = new mod.PcmResampler(48000, 24000)
  const split = new mod.PcmResampler(48000, 24000)
  const wholeOut = whole.push(signal)
  const firstHalf = split.push(signal.subarray(0, 1920))
  const secondHalf = split.push(signal.subarray(1920))
  check(wholeOut.length === firstHalf.length + secondHalf.length, '跨帧输出总长与一次性输出一致')
  let maxDiff = 0
  for (let index = 0; index < wholeOut.length; index += 1) {
    const joined = index < firstHalf.length ? firstHalf[index] : secondHalf[index - firstHalf.length]
    maxDiff = Math.max(maxDiff, Math.abs(wholeOut[index] - joined))
  }
  check(maxDiff < 1e-7, `跨帧重采样与一次性重采样逐点一致（最大差 ${maxDiff}）`)

  // 44.1k → 24k 这种非整数比也要保持跨帧连续。
  const odd = new Float32Array(4410)
  for (let index = 0; index < odd.length; index += 1) odd[index] = Math.sin(index / 7)
  const oddWhole = new mod.PcmResampler(44100, 24000)
  const oddSplit = new mod.PcmResampler(44100, 24000)
  const oddWholeOut = oddWhole.push(odd)
  const oddFirst = oddSplit.push(odd.subarray(0, 2205))
  const oddSecond = oddSplit.push(odd.subarray(2205))
  check(oddWholeOut.length === oddFirst.length + oddSecond.length, '44.1k → 24k 跨帧输出总长一致')
  let oddMaxDiff = 0
  for (let index = 0; index < oddWholeOut.length; index += 1) {
    const joined = index < oddFirst.length ? oddFirst[index] : oddSecond[index - oddFirst.length]
    oddMaxDiff = Math.max(oddMaxDiff, Math.abs(oddWholeOut[index] - joined))
  }
  check(oddMaxDiff < 1e-7, `44.1k → 24k 跨帧相位连续（最大差 ${oddMaxDiff}）`)
  check(Math.abs(oddWholeOut.length - 2400) <= 1, `4410 个 44.1k 采样应输出约 2400 个 24k 采样，实际 ${oddWholeOut.length}`)

  let threw = false
  try {
    new mod.PcmResampler(0, 24000)
  } catch {
    threw = true
  }
  check(threw, '非法采样率抛错')
  console.log('✓ PcmResampler：48k/44.1k 重采样、直通、跨帧相位连续')
}

{
  const chunker = new mod.PcmChunker()
  const first = chunker.push(new Float32Array(1000).fill(0.5))
  check(first.length === 1 && first[0].length === 960, '喂 1000 个采样应出 1 片 960')
  check(first[0].byteLength === 1920, '分片字节数 1920')
  check(chunker.pending === 40, `剩余 40 个采样，实际 ${chunker.pending}`)
  const second = chunker.push(new Float32Array(920).fill(0.5))
  check(second.length === 1 && second[0].length === 960, '补 920 个后出第 2 片')
  check(chunker.pending === 0, '补齐后无剩余')
  const third = chunker.push(new Float32Array(3000))
  check(third.length === 3 && third[2].length === 960, '一次喂 3000 个应出 3 整片')
  check(chunker.pending === 120, '剩余 120 个采样（不足一片，等下一次 push）')
  chunker.reset()
  check(chunker.pending === 0, 'reset 清空缓冲')
  let threw = false
  try {
    new mod.PcmChunker(0)
  } catch {
    threw = true
  }
  check(threw, '非法分片长度抛错')
  console.log('✓ PcmChunker：40 ms 定长分片与残余缓冲')
}

/* -------------------------------------------------------------------------- */
/* 5. MicStreamer —— AudioWorklet 路径                                         */
/* -------------------------------------------------------------------------- */
{
  const { FakeAudioContext, spy } = createFakeAudioContext({ sampleRate: 24000, state: 'suspended' })
  setGlobal('AudioContext', FakeAudioContext)
  const workletNodes = installFakeWorkletNode()
  const objectUrl = installObjectUrlSpy()
  const stream = createFakeStream()
  const media = installMediaDevices(async () => stream)
  try {
    const mic = new mod.MicStreamer()
    const chunks = []
    await mic.start((pcm) => chunks.push(pcm))

    check(media.calls.length === 1, 'start 申请一次麦克风')
    const constraints = media.calls[0]
    check(constraints.audio.echoCancellation === true, '开启回声消除')
    check(constraints.audio.noiseSuppression === true, '开启噪声抑制')
    check(constraints.audio.autoGainControl === true, '开启自动增益')
    check(constraints.video === false, '不申请摄像头')
    check(spy.contexts.length === 1 && spy.contexts[0].requestedSampleRate === 24000, 'AudioContext 请求 24000 Hz')
    check(spy.addModuleCalls.length === 1, 'AudioWorklet 注册一次')
    check(objectUrl.calls.created.length === 1, 'Blob URL 创建一次')
    check(objectUrl.calls.created[0].type === 'text/javascript', 'Blob 类型是 text/javascript')
    check(objectUrl.calls.revoked.length === 1, 'addModule 后立刻 revoke Blob URL')
    check(workletNodes.length === 1, 'AudioWorkletNode 创建一次')
    const node = workletNodes[0]
    check(node.options.numberOfOutputs === 0, 'worklet 不接输出（避免麦克风原声回放）')
    check(node.options.numberOfInputs === 1, 'worklet 有 1 个输入')
    check(node.options.processorOptions.targetRate === 24000, 'processorOptions.targetRate 24000')
    check(node.options.processorOptions.chunkSamples === 960, 'processorOptions.chunkSamples 960')
    check(spy.contexts[0].state === 'running', 'suspended context 在 start 时 resume')
    check(mic.active === true, 'start 后 active')
    check(mic.level() === 0, '初始音量 0')

    // 模拟 worklet 发来一片 40 ms PCM16。
    const pcm = new Int16Array(960).fill(100)
    node.port.onmessage({ data: { type: 'chunk', pcm: pcm.buffer, level: 0.4 } })
    check(chunks.length === 1, '收到 1 片')
    check(chunks[0].length === 960, '分片长度 960')
    check(chunks[0].byteLength === 1920, '分片字节数 1920')
    check(chunks[0][0] === 100, '分片内容原样透传')
    check(Math.abs(mic.level() - 0.4) < 1e-6, 'level 来自 worklet 上报')

    // 非 chunk 消息 / 非 ArrayBuffer 载荷不应触发回调。
    node.port.onmessage({ data: { type: 'other' } })
    node.port.onmessage({ data: { type: 'chunk', pcm: 'not-a-buffer', level: 0.9 } })
    check(chunks.length === 1, '非法消息被忽略')

    mic.setMuted(true)
    check(mic.level() === 0, '静音时 level 归零')
    node.port.onmessage({ data: { type: 'chunk', pcm: new Int16Array(960).buffer, level: 0.9 } })
    check(chunks.length === 1, '静音时不回调但连接保持')
    check(spy.addModuleCalls.length === 1 && workletNodes.length === 1, '静音不重建采集链路')
    mic.setMuted(false)
    node.port.onmessage({ data: { type: 'chunk', pcm: new Int16Array(960).buffer, level: 0.2 } })
    check(chunks.length === 2, '取消静音后恢复回调')
    check(Math.abs(mic.level() - 0.2) < 1e-6, '取消静音后 level 恢复')

    // 重复 start 幂等：只替换回调，不重复申请设备。
    const replacement = []
    await mic.start((value) => replacement.push(value))
    check(media.calls.length === 1 && workletNodes.length === 1, '重复 start 不重复申请麦克风')
    node.port.onmessage({ data: { type: 'chunk', pcm: new Int16Array(960).buffer, level: 0.3 } })
    check(replacement.length === 1 && chunks.length === 2, '重复 start 后回调换成新的')

    await mic.stop()
    check(mic.active === false, 'stop 后 active false')
    check(spy.closeCalls === 1, 'stop 关闭 AudioContext 一次')
    check(stream.track.stopped === true, 'stop 停止麦克风轨道')
    check(node.port.onmessage === null, 'stop 摘掉 worklet 消息处理')
    check(node.disconnected === true, 'stop 断开 worklet 节点')
    node.port.onmessage?.({ data: { type: 'chunk', pcm: new Int16Array(960).buffer, level: 0.3 } })
    check(replacement.length === 1, 'stop 后不再回调')

    await mic.stop()
    check(spy.closeCalls === 1, 'stop 幂等（不重复关闭）')
    console.log('✓ MicStreamer：AudioWorklet 路径、分片回调、静音、幂等 stop')
  } finally {
    objectUrl.restore()
    restoreGlobals()
  }
}

/* -------------------------------------------------------------------------- */
/* 6. MicStreamer —— ScriptProcessor 兜底路径                                  */
/* -------------------------------------------------------------------------- */
{
  // context 给 48 kHz：模拟「浏览器不遵守 24000 请求」，验证重采样兜底。
  const { FakeAudioContext, spy } = createFakeAudioContext({ sampleRate: 48000, state: 'running', disableWorklet: true })
  setGlobal('AudioContext', FakeAudioContext)
  const stream = createFakeStream()
  const media = installMediaDevices(async () => stream)
  try {
    const mic = new mod.MicStreamer()
    const chunks = []
    await mic.start((pcm) => chunks.push(pcm))

    check(spy.contexts.length === 1, 'ScriptProcessor 路径创建 context')
    check(spy.processors.length === 1, '回退到 ScriptProcessorNode')
    check(spy.processors[0].bufferSize === 1024, 'ScriptProcessor 缓冲 1024')
    check(spy.gains.length === 1 && spy.gains[0].gain.value === 0, '串了 gain=0 防止回放')
    check(spy.gains[0].connected.includes(spy.contexts[0].destination), 'gain 接到 destination（ScriptProcessor 必须被拉取）')
    check(spy.processors[0].connected.includes(spy.gains[0]), 'processor 接到 gain')

    const feed = (samples) => {
      const input = new Float32Array(samples).fill(0.25)
      spy.processors[0].onaudioprocess({ inputBuffer: { getChannelData: () => input } })
    }
    // 48 kHz 下 40 ms = 1920 个采样，重采样后正好一片 960。
    feed(1920)
    check(chunks.length === 1, '48k 输入 1920 个采样 → 一片')
    check(chunks[0].length === 960, '重采样后 960 个采样')
    check(chunks[0][0] === 8192, `0.25 应编码为 8192，实际 ${chunks[0][0]}`)
    check(mic.level() > 0, 'ScriptProcessor 路径也有 level')

    // 再喂 960 + 960：每次重采样出 480，两次凑满第二片。
    feed(960)
    check(chunks.length === 1, '不足 40 ms 不提前回调')
    feed(960)
    check(chunks.length === 2, '凑满 40 ms 后回调第二片')

    mic.setMuted(true)
    feed(1920)
    check(chunks.length === 2, '静音时 ScriptProcessor 路径不回调')
    mic.setMuted(false)

    await mic.stop()
    check(spy.closeCalls === 1, '兜底路径 stop 关闭 context')
    check(stream.track.stopped === true, '兜底路径 stop 停轨道')
    console.log('✓ MicStreamer：ScriptProcessor 兜底、48k → 24k 重采样、静音')
  } finally {
    restoreGlobals()
  }
}

/* -------------------------------------------------------------------------- */
/* 7. MicStreamer —— addModule 失败回退 + 权限被拒                              */
/* -------------------------------------------------------------------------- */
{
  const { FakeAudioContext, spy } = createFakeAudioContext({ sampleRate: 24000, addModuleFails: true })
  setGlobal('AudioContext', FakeAudioContext)
  installFakeWorkletNode()
  const objectUrl = installObjectUrlSpy()
  const stream = createFakeStream()
  installMediaDevices(async () => stream)
  try {
    const mic = new mod.MicStreamer()
    await mic.start(() => {})
    check(spy.addModuleCalls.length === 1, '尝试过 AudioWorklet')
    check(objectUrl.calls.revoked.length === 1, 'addModule 失败也 revoke Blob URL')
    check(spy.processors.length === 1, 'addModule 失败回退 ScriptProcessor')
    await mic.stop()
    console.log('✓ MicStreamer：addModule 失败自动回退 ScriptProcessor')
  } finally {
    objectUrl.restore()
    restoreGlobals()
  }
}

{
  const { FakeAudioContext, spy } = createFakeAudioContext({})
  setGlobal('AudioContext', FakeAudioContext)
  installMediaDevices(async () => {
    const error = new Error('denied')
    error.name = 'NotAllowedError'
    throw error
  })
  try {
    const mic = new mod.MicStreamer()
    let message = ''
    try {
      await mic.start(() => {})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    check(message.includes('麦克风权限被拒绝'), `权限被拒应有可读提示，实际「${message}」`)
    check(mic.active === false, '失败后不处于 active')
    check(spy.contexts.length === 0, '权限被拒不创建 AudioContext')
    console.log('✓ MicStreamer：麦克风权限被拒的中文提示与清理')
  } finally {
    restoreGlobals()
  }
}

/* -------------------------------------------------------------------------- */
/* 8. PcmPlayer —— 播放队列时序与 interrupt                                     */
/* -------------------------------------------------------------------------- */
{
  const { FakeAudioContext, spy } = createFakeAudioContext({ sampleRate: 24000, state: 'suspended', currentTime: 10 })
  setGlobal('AudioContext', FakeAudioContext)
  try {
    const player = new mod.PcmPlayer()
    check(player.playing === false, '初始不在播放')

    await player.ensureRunning()
    check(spy.resumeCalls === 1, 'ensureRunning 会 resume 挂起的 context')
    check(spy.contexts[0].state === 'running', 'resume 后 context running')
    check(spy.contexts[0].requestedSampleRate === 24000, '播放器请求 24000 Hz')

    const first = new Int16Array(960).fill(0)
    const second = new Int16Array(960).fill(0)
    player.enqueue(first)
    player.enqueue(second)
    check(spy.sources.length === 2, '两片各建一个 AudioBufferSourceNode')
    const [sourceA, sourceB] = spy.sources
    check(spy.bufferCalls.length === 2, '两片各建一个 AudioBuffer')
    check(spy.bufferCalls[0].length === 960, 'AudioBuffer 长度 960')
    check(spy.bufferCalls[0].sampleRate === 24000, 'AudioBuffer 采样率 24000')
    check(sourceA.buffer.duration === 0.04, '每片时长 40 ms')
    check(spy.gains.length === 1, '两片共用同一个 master gain')
    const masterGain = spy.gains[0]
    check(sourceA.connected === masterGain, 'source 接到 master gain（不是直接 destination）')
    check(masterGain.connected.includes(spy.contexts[0].destination), 'master gain 接到 destination')
    check(masterGain.gain.value === 1, '默认满音量')
    check(player.currentVolume === 1, 'currentVolume 默认 1')
    check(Math.abs(sourceA.startCalls[0] - 10.02) < 1e-6, `第一片应在 currentTime+20ms 起播，实际 ${sourceA.startCalls[0]}`)
    check(Math.abs(sourceB.startCalls[0] - (sourceA.startCalls[0] + 0.04)) < 1e-6, '第二片紧接第一片结束（nextStartTime 累加）')
    check(player.playing === true, '有排队音频时 playing')

    // 音量：实时改 master gain；越界钳制；非法值回落满音量。
    player.setVolume(0.35)
    check(masterGain.gain.value === 0.35, 'setVolume 立即改 master gain')
    check(player.currentVolume === 0.35, 'currentVolume 跟随设置')
    player.setVolume(-1)
    check(masterGain.gain.value === 0, '负值钳制到 0')
    player.setVolume(2)
    check(masterGain.gain.value === 1, '大于 1 钳制到 1')
    player.setVolume(Number.NaN)
    check(masterGain.gain.value === 1, '非法值回落 1')
    player.setVolume(0.4)

    sourceA.onended()
    check(player.playing === true, '播完一片但还有一片时仍在播放')
    sourceB.onended()
    check(player.playing === false, '全部播完 playing false')

    // interrupt：立刻停播 + 清空队列 + 重置时间轴。
    player.enqueue(first)
    player.enqueue(second)
    check(spy.sources.length === 4, '打断前又排了两片')
    player.interrupt()
    check(spy.sources[2].stopCalls === 1 && spy.sources[3].stopCalls === 1, 'interrupt 对所有已调度 source 调 stop')
    check(player.playing === false, 'interrupt 后 playing false')
    player.interrupt()
    check(player.playing === false, 'interrupt 可重复调用')
    check(spy.sources[2].stopCalls === 1, '重复 interrupt 不重复 stop')

    player.enqueue(first)
    const resumed = spy.sources[4]
    check(Math.abs(resumed.startCalls[0] - 10.02) < 1e-6, `打断后从当前时间重新起播，实际 ${resumed.startCalls[0]}`)

    // 空分片不建 buffer；奇数字节 ArrayBuffer 丢弃尾部。
    const buffersBefore = spy.bufferCalls.length
    player.enqueue(new Int16Array(0))
    check(spy.bufferCalls.length === buffersBefore, '空分片被忽略')
    player.enqueue(new Uint8Array([0x01, 0x00, 0xff]).buffer)
    check(spy.bufferCalls.length === buffersBefore + 1, '奇数字节 ArrayBuffer 仍可入队')
    check(spy.bufferCalls[spy.bufferCalls.length - 1].length === 1, '奇数字节丢弃尾部，剩 1 个采样')

    await player.close()
    check(spy.closeCalls === 1, 'close 关闭 AudioContext')
    check(player.playing === false, 'close 后不再播放')
    await player.close()
    check(spy.closeCalls === 1, 'close 幂等')

    /*
     * close 之后再次 enqueue：必须重建 AudioContext 与 master gain，而且音量沿用。
     * 不复用旧 gain 是关键——旧 gain 属于已关闭的上下文，连着它音频会静默丢失，
     * 表现为「重连后一点声音都没有、也不报错」。
     */
    player.enqueue(first)
    const rebuiltContext = spy.contexts[1]
    const rebuiltGain = spy.gains[1]
    check(spy.contexts.length === 2, 'close 后 enqueue 重建 AudioContext')
    check(rebuiltGain !== undefined && rebuiltGain !== masterGain, '重建 master gain（不复用旧上下文节点）')
    check(rebuiltGain.gain.value === 0.4, '重建后沿用上次音量')
    check(rebuiltGain.connected.includes(rebuiltContext.destination), '新 gain 接到新 context 的 destination')
    check(spy.sources.at(-1).connected === rebuiltGain, '新 source 接到新 gain')
    console.log('✓ PcmPlayer：nextStartTime 串接、interrupt 清空重置、空片/奇数字节、音量增益、close 幂等与重建')
  } finally {
    restoreGlobals()
  }
}

{
  // 自定义采样率：构造参数应生效，且非法值回落到 24000。
  const { FakeAudioContext, spy } = createFakeAudioContext({ sampleRate: 16000 })
  setGlobal('AudioContext', FakeAudioContext)
  try {
    const player = new mod.PcmPlayer(16000)
    player.enqueue(new Int16Array(160))
    check(spy.contexts[0].requestedSampleRate === 16000, '构造参数采样率生效')
    check(spy.bufferCalls[0].sampleRate === 16000, 'AudioBuffer 用自定义采样率')
    const fallback = new mod.PcmPlayer(0)
    fallback.enqueue(new Int16Array(960))
    check(spy.contexts[1].requestedSampleRate === 24000, '非法采样率回落到 24000')
    await player.close()
    await fallback.close()
    console.log('✓ PcmPlayer：自定义采样率与非法值回落')
  } finally {
    restoreGlobals()
  }
}

/* -------------------------------------------------------------------------- */
/* 9. worklet 内联源码可执行（假 AudioWorkletGlobalScope）                      */
/* -------------------------------------------------------------------------- */
{
  // 真正跑一遍内联源码：注入假 AudioWorkletProcessor / registerProcessor /
  // sampleRate，拿到处理器类后按音频块喂数据，验证重采样、分片、level。
  const loadProcessorClass = (contextSampleRate) => {
    const registered = []
    class FakeAudioWorkletProcessor {
      constructor() {
        this.messages = []
        this.port = {
          onmessage: null,
          postMessage: (message, transfer) => {
            this.messages.push({ message, transfer })
          },
        }
      }
    }
    const factory = new Function(
      'AudioWorkletProcessor',
      'registerProcessor',
      'sampleRate',
      mod.CAPTURE_WORKLET_SOURCE,
    )
    factory(FakeAudioWorkletProcessor, (name, ctor) => registered.push({ name, ctor }), contextSampleRate)
    return registered
  }

  const registered = loadProcessorClass(48000)
  check(registered.length === 1, 'worklet 源码注册了 1 个处理器')
  check(registered[0].name === mod.CAPTURE_PROCESSOR_NAME, 'worklet 注册的处理器名与常量一致')

  const processor = new registered[0].ctor({ processorOptions: { targetRate: 24000, chunkSamples: 960 } })
  check(Math.abs(processor.ratio - 2) < 1e-9, '48k context 下重采样比为 2')
  const frame = new Float32Array(128).fill(0.25)
  let alive = true
  for (let index = 0; index < 15; index += 1) {
    // 15 帧 × 128 样本 = 1920 个 48k 采样，重采样后正好 960。
    alive = processor.process([[frame]]) && alive
  }
  check(alive === true, 'process 返回 true 保持处理器存活')
  check(processor.messages.length === 1, `15 帧后应出 1 片，实际 ${processor.messages.length}`)
  const payload = processor.messages[0].message
  check(payload.type === 'chunk', 'worklet 消息类型 chunk')
  check(payload.pcm instanceof ArrayBuffer, 'worklet 用 ArrayBuffer 传 PCM')
  check(payload.pcm.byteLength === 1920, `worklet 分片 1920 字节，实际 ${payload.pcm.byteLength}`)
  check(processor.messages[0].transfer.length === 1 && processor.messages[0].transfer[0] === payload.pcm, 'ArrayBuffer 以 transferable 方式零拷贝转移')
  const samples = new Int16Array(payload.pcm)
  check(samples.length === 960, 'worklet 分片 960 个采样')
  check(samples[0] === 8192, `0.25 应编码为 8192，实际 ${samples[0]}`)
  check(payload.level > 0 && payload.level <= 1, `worklet level 在 0..1，实际 ${payload.level}`)

  for (let index = 0; index < 15; index += 1) processor.process([[frame]])
  check(processor.messages.length === 2, '再 15 帧出第二片')
  processor.process([[]])
  check(processor.messages.length === 2, '空输入不产出分片')

  // 24 kHz context（不需要重采样）：16 帧 × 128 样本 = 2048 个采样 → 2 片。
  const nativeRegistered = loadProcessorClass(24000)
  const native = new nativeRegistered[0].ctor({ processorOptions: { targetRate: 24000, chunkSamples: 960 } })
  check(native.ratio === 1, '24k context 下重采样比为 1')
  for (let index = 0; index < 16; index += 1) native.process([[frame]])
  check(native.messages.length === 2, `24k 下 16 帧应出 2 片，实际 ${native.messages.length}`)
  console.log('✓ worklet 内联源码：假 AudioWorkletGlobalScope 下重采样/分片/level 正确')
}

console.log(`[realtime-audio] PASS ${passed} 项断言`)
