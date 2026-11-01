/**
 * Personal Agent host 路由的单元/集成测试（不依赖真实 DSH）。
 *
 * 构造一个最小的 fake ctx：webServer 捕获路由、llm.stream 返回固定文本、
 * credentials/settings 提供生图配置、speechController 返回固定转写。
 * 断言：
 *   - /reply 能收集 text-delta 并返回 blocks；
 *   - /asr 走 speechController 并回传 text；
 *   - /tts 能真实调用本机 edge-tts（缺环境时标记 skip，不算失败）；
 *   - 跨站写请求被拒绝；
 *   - /file 能读回 bot 工作区里的图片，且越界路径 / 非图片扩展名被拒。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPersonalAgentHost } from '../lib/index.js'

const routes = []
/** 最近一次 llm.stream 的入参：用来断言「图片提示真的进了模型输入」。 */
let lastLlmOptions = null
const ctx = {
  inject(_deps, cb) { cb(ctx) },
  effect(fn) { fn(); return () => {} },
  webServer: {
    register(route) { routes.push(route); return () => {} },
  },
  get(name) { return name === 'credentials' ? ctx.credentials : undefined },
  credentials: { resolve: async () => ({ value: 'test-key' }) },
  settings: {
    get(ns) {
      if (ns === 'model-capabilities') return { imageActive: 'sensenova/sensenova-u1.5-lite', imagePath: 'images/generations' }
      return { providers: { sensenova: { baseURL: 'http://127.0.0.1:9', apiKeyEnv: 'SENSENOVA_API_KEY' } } }
    },
  },
  llm: {
    listProviders: () => [{ id: 'alymagpie' }],
    listModels: async () => [{ id: 'auto/deepseek-v4.1-flash' }],
    listConfigurableProviders: () => [{ provider: 'sensenova', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'sensenova'] }],
    stream: async function* (options) {
      lastLlmOptions = options
      yield { type: 'text-delta', index: 0, text: '这是来自模型层的回复。' }
    },
  },
  speechController: {
    transcribe: async (request) => ({ text: `转写:${String(request.audioBase64).slice(0, 3)}` }),
  },
}

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pa-host-test-'))
/*
 * bot 工作区必须指到临时目录：/file 路由以它为基准解析相对路径，不隔离的话
 * 测试会往真实的 D:\Seeker-Bot 里写文件。
 */
const workspace = mkdtempSync(join(tmpdir(), 'pa-workspace-test-'))
process.env.DSH_SEEKER_BOT_WORKSPACE = workspace
applyPersonalAgentHost(ctx)

const route = routes.find((item) => item.path === '/api/personal-agent')
if (route === undefined) throw new Error('personal-agent route not registered')

function request(url, method, body, headers = {}) {
  return new Promise((resolve) => {
    const req = {
      url,
      method,
      headers,
      on(event, handler) {
        if (event === 'data') handler(Buffer.from(JSON.stringify(body ?? {})))
        if (event === 'end') handler()
      },
      destroy() {},
    }
    let status = 0
    const responseHeaders = {}
    const res = {
      set statusCode(value) { status = value },
      get statusCode() { return status },
      setHeader(name, value) { responseHeaders[String(name).toLowerCase()] = String(value) },
      end(chunk) {
        const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
        // text 给 JSON 断言用；body 给二进制（图片）断言用
        resolve({ status, text: payload.toString('utf8'), body: payload, headers: responseHeaders })
      },
    }
    void route.handler(req, res)
  })
}

const reply = await request('/api/personal-agent/reply', 'POST', {
  bot: { name: '小墨助手', role: '主助手', model: { provider: 'alymagpie', model: 'auto/deepseek-v4.1-flash' } },
  text: '你好',
  history: [],
  memories: ['用户喜欢直接的回答'],
})
const replyJson = JSON.parse(reply.text)
if (reply.status !== 200 || replyJson.ok !== true || replyJson.blocks?.[0]?.text !== '这是来自模型层的回复。') {
  throw new Error(`reply route failed: ${reply.status} ${reply.text.slice(0, 200)}`)
}
console.log('✓ /reply 收集模型文本并返回 blocks')

const asr = await request('/api/personal-agent/asr', 'POST', { audio: 'QUJD', language: 'zh-CN' })
const asrJson = JSON.parse(asr.text)
if (asr.status !== 200 || asrJson.ok !== true || asrJson.text !== '转写:QUJ') {
  throw new Error(`asr route failed: ${asr.status} ${asr.text.slice(0, 200)}`)
}
console.log('✓ /asr 走 speechController')

const cross = await request('/api/personal-agent/reply', 'POST', {}, { origin: 'http://evil.test', host: '127.0.0.1:3080' })
if (cross.status !== 403) throw new Error(`cross-site should be 403, got ${cross.status}`)
console.log('✓ 跨站写请求被拒绝')

// TTS 需要本机 edge-tts；没有安装时打印 skip，不阻塞。
const tts = await request('/api/personal-agent/tts', 'POST', { text: '你好' })
const ttsJson = JSON.parse(tts.text)
if (ttsJson.ok === true && typeof ttsJson.audio === 'string' && ttsJson.audio.startsWith('data:audio')) {
  console.log('✓ /tts 生成 Edge 语音', Math.round(ttsJson.audio.length / 1024), 'KB')
} else {
  console.log('· /tts 当前环境不可用（skip）：', String(ttsJson.error ?? '').slice(0, 120))
}

/* ───────────────────── /file：生图落盘文件的同源读取 ───────────────────── */

// 1×1 透明 PNG：模拟 agent 侧把 data: URL 解码落盘后的产物
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const tmpDir = join(workspace, '_tmp')
mkdirSync(tmpDir, { recursive: true })
writeFileSync(join(tmpDir, 'test.png'), Buffer.from(PNG_1X1, 'base64'))

const relativeFile = await request(`/api/personal-agent/file?path=${encodeURIComponent('_tmp/test.png')}`, 'GET')
if (relativeFile.status !== 200 || relativeFile.headers['content-type'] !== 'image/png') {
  throw new Error(`/file relative path failed: ${relativeFile.status} ${relativeFile.headers['content-type'] ?? ''} ${relativeFile.text.slice(0, 120)}`)
}
if (relativeFile.headers['cache-control'] !== 'private, max-age=86400') {
  throw new Error(`/file cache-control mismatch: ${relativeFile.headers['cache-control'] ?? ''}`)
}
if (relativeFile.body.length === 0 || relativeFile.body[0] !== 0x89) {
  throw new Error('/file 返回的图片字节为空或不是 PNG')
}
console.log('✓ /file 以 bot 工作区为基准读回图片（200 + image/png + 缓存头）')

// 绝对路径：同样必须落在允许根内
const absoluteFile = await request(`/api/personal-agent/file?path=${encodeURIComponent(join(tmpDir, 'test.png'))}`, 'GET')
if (absoluteFile.status !== 200) {
  throw new Error(`/file absolute path failed: ${absoluteFile.status} ${absoluteFile.text.slice(0, 120)}`)
}
console.log('✓ /file 接受允许根内的绝对路径')

// 生图落盘根（materializeRoot，在 DSH_HOME 下）也是允许根
const materializedDir = join(process.env.DSH_HOME, 'storages', 'dsh-seeker-bot-generated', 'abc123')
mkdirSync(materializedDir, { recursive: true })
writeFileSync(join(materializedDir, 'img-1.png'), Buffer.from(PNG_1X1, 'base64'))
const materializedFile = await request(`/api/personal-agent/file?path=${encodeURIComponent(join(materializedDir, 'img-1.png'))}`, 'GET')
if (materializedFile.status !== 200) {
  throw new Error(`/file materialize root failed: ${materializedFile.status} ${materializedFile.text.slice(0, 120)}`)
}
console.log('✓ /file 接受生图落盘根下的图片')

// 越界路径：解析后不在任何允许根内 → 403
const escape = await request(`/api/personal-agent/file?path=${encodeURIComponent('../../Windows/win.ini')}`, 'GET')
if (escape.status !== 403) {
  throw new Error(`/file 越界路径应 403，实际 ${escape.status} ${escape.text.slice(0, 120)}`)
}
console.log('✓ /file 拒绝越界路径')

// 非图片扩展名：即使在允许根内也拒
writeFileSync(join(tmpDir, 'note.txt'), 'secret')
const notImage = await request(`/api/personal-agent/file?path=${encodeURIComponent('_tmp/note.txt')}`, 'GET')
if (notImage.status !== 403) {
  throw new Error(`/file 非图片扩展名应 403，实际 ${notImage.status} ${notImage.text.slice(0, 120)}`)
}
console.log('✓ /file 拒绝非图片扩展名')

// 空 path / 不存在的图片
const emptyPath = await request('/api/personal-agent/file', 'GET')
if (emptyPath.status !== 400) {
  throw new Error(`/file 空 path 应 400，实际 ${emptyPath.status}`)
}
const missing = await request(`/api/personal-agent/file?path=${encodeURIComponent('_tmp/missing.png')}`, 'GET')
if (missing.status !== 404) {
  throw new Error(`/file 不存在的文件应 404，实际 ${missing.status}`)
}
console.log('✓ /file 空 path 400、不存在 404')

/* ───────────────────── /upload：用户粘贴图片落盘 ───────────────────── */

const uploadDataUrl = `data:image/png;base64,${PNG_1X1}`
const upload = await request('/api/personal-agent/upload', 'POST', { dataUrl: uploadDataUrl, name: '截图.png' })
const uploadJson = JSON.parse(upload.text)
if (upload.status !== 200 || uploadJson.ok !== true) {
  throw new Error(`/upload failed: ${upload.status} ${upload.text.slice(0, 200)}`)
}
if (typeof uploadJson.path !== 'string' || !uploadJson.path.startsWith('uploads/')) {
  throw new Error(`/upload 返回的 path 不对：${String(uploadJson.path ?? '')}`)
}
if (typeof uploadJson.url !== 'string' || !uploadJson.url.includes('/api/personal-agent/file?path=')) {
  throw new Error(`/upload 返回的 url 不对：${String(uploadJson.url ?? '')}`)
}
const uploadedFile = await request(uploadJson.url, 'GET')
if (uploadedFile.status !== 200 || !uploadedFile.body.equals(Buffer.from(PNG_1X1, 'base64'))) {
  throw new Error(`/upload 落盘的文件读回不一致：${uploadedFile.status}`)
}
console.log('✓ /upload 落盘并返回同源 URL（/file 读回字节一致）')

// 内容寻址：同一张图再传一次应命中同一个文件，不重复占盘
const uploadAgain = await request('/api/personal-agent/upload', 'POST', { dataUrl: uploadDataUrl })
const uploadAgainJson = JSON.parse(uploadAgain.text)
if (uploadAgainJson.path !== uploadJson.path) {
  throw new Error(`/upload 同一张图应复用同一路径：${uploadJson.path} vs ${String(uploadAgainJson.path ?? '')}`)
}
console.log('✓ /upload 内容寻址：同图复用同一文件')

// 非图片字节：魔数校验必须挡住（base64 解码对任何字符串都不抛错）
const notImageDataUrl = `data:image/png;base64,${Buffer.from('这不是图片').toString('base64')}`
const badUpload = await request('/api/personal-agent/upload', 'POST', { dataUrl: notImageDataUrl })
if (badUpload.status !== 400) {
  throw new Error(`/upload 非图片应 400，实际 ${badUpload.status} ${badUpload.text.slice(0, 120)}`)
}
console.log('✓ /upload 拒绝非图片字节')

const emptyUpload = await request('/api/personal-agent/upload', 'POST', { dataUrl: '' })
if (emptyUpload.status !== 400) {
  throw new Error(`/upload 空数据应 400，实际 ${emptyUpload.status}`)
}
console.log('✓ /upload 拒绝空数据')

// 图片路径必须进模型输入：bot 的 user 消息没有多模态 image part，靠这段提示让模型 read_image
await request('/api/personal-agent/reply', 'POST', {
  bot: { name: '小墨助手', role: '主助手', model: { provider: 'alymagpie', model: 'auto/deepseek-v4.1-flash' } },
  text: '这张图里是什么',
  images: [{ path: uploadJson.path, name: '截图.png' }],
})
const promptText = JSON.stringify(lastLlmOptions?.messages ?? [])
const hasHint = promptText.includes('用户发来')
// Windows 上 join() 会把相对路径里的 / 规范成 \，JSON 里再转义成 \\，所以只比对文件名
const uploadedName = String(uploadJson.path).split('/').pop()
const hasPath = promptText.includes(String(uploadedName))
if (!hasHint || !hasPath) {
  throw new Error(`/reply 没有把图片提示带进模型输入（hasHint=${hasHint} hasPath=${hasPath} name=${String(uploadedName)}）：${promptText.slice(0, 300)}`)
}
console.log('✓ /reply 把图片路径写进 user 消息提示（模型可据此 read_image）')

/* ───────── generate_image：参数解析 → 落盘 → 同源 URL 全链路 ───────── */

/*
 * 这一段用 fake agent 驱动真实的 runBotTurn：followup 时按脚本发
 * session/event，验证
 *   - tool/call 把完整 prompt / 张数 / 宽高比带进工具卡；
 *   - tool/result 把内联 base64 与 spill 文本里的图落盘，blocks 里拿到同源 URL；
 *   - 解析失败 / 参数非法时回落默认值，工具卡本身照常是 ok。
 * 走 /reply 而不是直接调 runBotTurn：host.ts 没有导出后者，而 /reply 返回的
 * blocks 就是最终快照（图片落盘在 done 之前完成，所以一定在 blocks 里）。
 */
const IMAGE_BOT_ID = 'image-test'
const imageSession = {
  id: `pa-bot-v2-${IMAGE_BOT_ID}`,
  header: { cwd: workspace },
  append() {},
}
const imageListeners = new Set()
const imageSteps = []
const imageAgent = {
  session: imageSession,
  ctx: {
    on(type, handler) {
      if (type !== 'session/event') return () => {}
      imageListeners.add(handler)
      return () => { imageListeners.delete(handler) }
    },
  },
  inject() {},
  model: { select() {} },
  followup() {
    const step = imageSteps.shift()
    if (step === undefined) return
    let seq = 1
    const emitEvent = (type, data) => {
      for (const handler of [...imageListeners]) {
        handler(imageSession, { seq: seq++, type, time: Date.now(), data })
      }
    }
    step(emitEvent)
    emitEvent('turn/end', { reason: 'stop' })
  },
}
ctx.agents = {
  get() { return undefined },
  create: async () => imageAgent,
}

async function askImageBot(text) {
  const response = await request('/api/personal-agent/reply', 'POST', {
    bot: {
      id: IMAGE_BOT_ID,
      name: '画图机器人',
      role: '画师',
      model: { provider: 'alymagpie', model: 'auto/deepseek-v4.1-flash' },
    },
    text,
    history: [],
  })
  const parsed = JSON.parse(response.text)
  if (response.status !== 200 || parsed.ok !== true || parsed.mode !== 'agent') {
    throw new Error(`image reply failed: ${response.status} ${response.text.slice(0, 300)}`)
  }
  return parsed
}

// 场景 1：内联 base64（一张 PNG + 一张 GIF，覆盖扩展名与多图顺序）
const GIF_1X1 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const inlineResult = JSON.stringify({
  ok: true,
  model: 'test/sensenova-u1.5-lite',
  data: { data: [{ b64_json: PNG_1X1 }, { url: `data:image/gif;base64,${GIF_1X1}` }] },
})
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-img-1',
    name: 'generate_image',
    arguments: JSON.stringify({ prompt: '一只戴墨镜的猫，赛博朋克风格', n: 2, size: '1024x1536' }),
  })
  emitEvent('tool/result', {
    message: { toolCallId: 'call-img-1', content: [{ type: 'text', text: inlineResult }] },
  })
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '画好了，看看这两张。' }] } })
})

const inlineTurn = await askImageBot('画两张戴墨镜的猫')
const inlineRun = inlineTurn.blocks.find((block) => block.type === 'tool')?.run
if (inlineRun === undefined) throw new Error('blocks 里没有生图工具卡')
if (inlineRun.name !== 'generate_image' || inlineRun.status !== 'ok') {
  throw new Error(`生图工具卡状态不对：${inlineRun.name} ${inlineRun.status}`)
}
if (inlineRun.imageCount !== 2) throw new Error(`imageCount 应为 2，实际 ${inlineRun.imageCount}`)
if (Math.abs(inlineRun.imageRatio - 1024 / 1536) > 1e-9) {
  throw new Error(`imageRatio 应为 ${1024 / 1536}，实际 ${inlineRun.imageRatio}`)
}
if (inlineRun.prompt !== '一只戴墨镜的猫，赛博朋克风格') {
  throw new Error(`prompt 未原样带上：${inlineRun.prompt}`)
}
if (inlineRun.model !== 'test/sensenova-u1.5-lite') throw new Error(`model 应为解析结果里的值，实际 ${inlineRun.model}`)
if (!Array.isArray(inlineRun.images) || inlineRun.images.length !== 2) {
  throw new Error(`images 应有 2 张，实际 ${JSON.stringify(inlineRun.images)}`)
}
const IMAGE_URL_PREFIX = '/api/personal-agent/file?path=_tmp%2Fgenerated-images%2F'
if (!inlineRun.images.every((url) => url.startsWith(IMAGE_URL_PREFIX))) {
  throw new Error(`图片 URL 形状不对：${inlineRun.images[0]}`)
}
const firstImage = await request(inlineRun.images[0], 'GET')
const secondImage = await request(inlineRun.images[1], 'GET')
if (firstImage.status !== 200 || firstImage.headers['content-type'] !== 'image/png') {
  throw new Error(`第一张图读回失败：${firstImage.status} ${firstImage.headers['content-type'] ?? ''}`)
}
if (secondImage.status !== 200 || secondImage.headers['content-type'] !== 'image/gif') {
  throw new Error(`第二张图读回失败：${secondImage.status} ${secondImage.headers['content-type'] ?? ''}`)
}
console.log('✓ generate_image：tool/call 带 prompt/张数/比例，落盘后经 /file 读回')

// 场景 2：结果被 DSH spill 成临时文件，事件里只有 locator
const spillRoot = mkdtempSync(join(tmpdir(), 'dsh-spill-'))
const spillSessionDir = join(spillRoot, 'session-0123456789ab')
mkdirSync(spillSessionDir, { recursive: true })
const spillFile = join(spillSessionDir, 'deadbeef-generate_image.txt')
writeFileSync(spillFile, JSON.stringify({
  ok: true,
  model: 'test/spill-model',
  data: { data: [{ b64_json: PNG_1X1 }] },
}))
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-img-2',
    name: 'generate_image',
    arguments: JSON.stringify({ prompt: '落日海面', n: 1, aspect_ratio: '16:9' }),
  })
  emitEvent('tool/result', {
    message: {
      toolCallId: 'call-img-2',
      content: [{ type: 'text', text: `Full formatted result stored at: ${spillFile}. Use read with offset/limit` }],
    },
  })
})
const spillTurn = await askImageBot('画一张落日')
const spillRun = spillTurn.blocks.find((block) => block.type === 'tool')?.run
if (spillRun?.status !== 'ok') throw new Error(`spill 场景工具卡状态不对：${spillRun?.status}`)
if (spillRun.model !== 'test/spill-model') throw new Error(`spill 场景 model 不对：${spillRun.model}`)
if (!Array.isArray(spillRun.images) || spillRun.images.length !== 1) {
  throw new Error(`spill 场景 images 应有 1 张，实际 ${JSON.stringify(spillRun.images)}`)
}
if (Math.abs(spillRun.imageRatio - 16 / 9) > 1e-9) {
  throw new Error(`aspect_ratio 16:9 应换算成 ${16 / 9}，实际 ${spillRun.imageRatio}`)
}
const spillImage = await request(spillRun.images[0], 'GET')
if (spillImage.status !== 200) throw new Error(`spill 场景图片读回失败：${spillImage.status}`)
console.log('✓ generate_image：spill locator 文本能读回全文并落盘')

// 场景 3：参数非法 + 结果解析不出图 → 回落默认值，工具卡照常 ok
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', { callId: 'call-img-3', name: 'generate_image', arguments: '{not json' })
  emitEvent('tool/result', {
    message: { toolCallId: 'call-img-3', content: [{ type: 'text', text: '生图失败：额度不足' }] },
  })
})
const fallbackTurn = await askImageBot('随便画一张')
const fallbackRun = fallbackTurn.blocks.find((block) => block.type === 'tool')?.run
if (fallbackRun?.status !== 'ok') throw new Error(`解析失败场景工具卡状态不对：${fallbackRun?.status}`)
if (fallbackRun.imageCount !== 1 || fallbackRun.imageRatio !== 1) {
  throw new Error(`参数解析失败应回落 1 张 / 1:1，实际 ${fallbackRun.imageCount} / ${fallbackRun.imageRatio}`)
}
if (fallbackRun.images !== undefined) throw new Error('解析不出图时不应带 images')
if (fallbackRun.result === undefined || !fallbackRun.result.includes('额度不足')) {
  throw new Error('工具结果摘要丢失')
}
console.log('✓ generate_image：参数/结果解析失败回落默认值，不影响工具卡')

/* ───────────── /file：媒体 MIME（视频 / 文档）与 HTTP Range ───────────── */

/*
 * 视频 / 音频的播放与拖动依赖 206：浏览器先发 Range 探长度，拖动时再发小片段。
 * 这里用 1KB 假 mp4 覆盖三种形态：无 Range（200 + accept-ranges）、
 * 单区间（206 + content-range + content-length）、越界（416 + bytes * / total）。
 */
const MEDIA_BYTES = Buffer.alloc(1024, 0xab)
writeFileSync(join(tmpDir, 'clip.mp4'), MEDIA_BYTES)
const MEDIA_PATH = encodeURIComponent('_tmp/clip.mp4')

const mediaNoRange = await request(`/api/personal-agent/file?path=${MEDIA_PATH}`, 'GET')
if (mediaNoRange.status !== 200) {
  throw new Error(`/file 无 Range 应 200，实际 ${mediaNoRange.status} ${mediaNoRange.text.slice(0, 120)}`)
}
if (mediaNoRange.headers['content-type'] !== 'video/mp4') {
  throw new Error(`.mp4 的 content-type 应为 video/mp4，实际 ${mediaNoRange.headers['content-type'] ?? ''}`)
}
if (mediaNoRange.headers['accept-ranges'] !== 'bytes') {
  throw new Error(`/file 应声明 accept-ranges: bytes，实际 ${mediaNoRange.headers['accept-ranges'] ?? ''}`)
}
if (mediaNoRange.body.length !== MEDIA_BYTES.length) {
  throw new Error(`/file 无 Range 应回全量 ${MEDIA_BYTES.length} 字节，实际 ${mediaNoRange.body.length}`)
}
console.log('✓ /file 视频无 Range：200 + video/mp4 + accept-ranges')

const mediaRange = await request(`/api/personal-agent/file?path=${MEDIA_PATH}`, 'GET', undefined, { range: 'bytes=0-99' })
if (mediaRange.status !== 206) {
  throw new Error(`/file Range 应 206，实际 ${mediaRange.status} ${mediaRange.text.slice(0, 120)}`)
}
if (mediaRange.headers['content-range'] !== `bytes 0-99/${MEDIA_BYTES.length}`) {
  throw new Error(`content-range 不对：${mediaRange.headers['content-range'] ?? ''}`)
}
if (mediaRange.headers['content-length'] !== '100') {
  throw new Error(`content-length 应为 100，实际 ${mediaRange.headers['content-length'] ?? ''}`)
}
if (mediaRange.body.length !== 100) {
  throw new Error(`206 响应体应 100 字节，实际 ${mediaRange.body.length}`)
}
if (!mediaRange.body.equals(MEDIA_BYTES.subarray(0, 100))) {
  throw new Error('206 响应体的字节不是文件前 100 字节')
}
console.log('✓ /file Range：206 + content-range + content-length')

const mediaOpenRange = await request(`/api/personal-agent/file?path=${MEDIA_PATH}`, 'GET', undefined, { range: 'bytes=0-' })
if (mediaOpenRange.status !== 206 || mediaOpenRange.body.length !== MEDIA_BYTES.length) {
  throw new Error(`Range: bytes=0- 应 206 全量，实际 ${mediaOpenRange.status} / ${mediaOpenRange.body.length}`)
}
if (mediaOpenRange.headers['content-range'] !== `bytes 0-${MEDIA_BYTES.length - 1}/${MEDIA_BYTES.length}`) {
  throw new Error(`Range: bytes=0- 的 content-range 不对：${mediaOpenRange.headers['content-range'] ?? ''}`)
}
const mediaSuffixRange = await request(`/api/personal-agent/file?path=${MEDIA_PATH}`, 'GET', undefined, { range: 'bytes=-128' })
if (mediaSuffixRange.status !== 206 || mediaSuffixRange.headers['content-range'] !== `bytes 896-1023/${MEDIA_BYTES.length}`) {
  throw new Error(`Range: bytes=-128 解析不对：${mediaSuffixRange.status} ${mediaSuffixRange.headers['content-range'] ?? ''}`)
}
console.log('✓ /file Range：bytes=0- 全量、bytes=-N 取尾部')

const mediaBadRange = await request(`/api/personal-agent/file?path=${MEDIA_PATH}`, 'GET', undefined, { range: 'bytes=5000-6000' })
if (mediaBadRange.status !== 416) {
  throw new Error(`越界 Range 应 416，实际 ${mediaBadRange.status}`)
}
if (mediaBadRange.headers['content-range'] !== `bytes */${MEDIA_BYTES.length}`) {
  throw new Error(`416 的 content-range 应为 bytes * /total，实际 ${mediaBadRange.headers['content-range'] ?? ''}`)
}
console.log('✓ /file Range：越界 416 + bytes * / total')

// 文档 MIME：docx / pdf 走白名单（前端据此决定内嵌预览还是下载）
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOCX_BYTES = Buffer.from('PK fake docx payload', 'utf8')
writeFileSync(join(tmpDir, 'report.docx'), DOCX_BYTES)
const docxFile = await request(`/api/personal-agent/file?path=${encodeURIComponent('_tmp/report.docx')}`, 'GET')
if (docxFile.status !== 200 || docxFile.headers['content-type'] !== DOCX_MIME) {
  throw new Error(`.docx 的 content-type 不对：${docxFile.status} ${docxFile.headers['content-type'] ?? ''}`)
}
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8')
writeFileSync(join(tmpDir, 'manual.pdf'), PDF_BYTES)
const pdfFile = await request(`/api/personal-agent/file?path=${encodeURIComponent('_tmp/manual.pdf')}`, 'GET')
if (pdfFile.status !== 200 || pdfFile.headers['content-type'] !== 'application/pdf') {
  throw new Error(`.pdf 的 content-type 不对：${pdfFile.status} ${pdfFile.headers['content-type'] ?? ''}`)
}
console.log('✓ /file 文档 MIME：docx / pdf')

/* ───────────────────── /office/*：PDF 预览与可渲染探测 ───────────────────── */

const officeInfo = await request(`/api/personal-agent/office/info?path=${encodeURIComponent('_tmp/manual.pdf')}`, 'GET')
const officeInfoJson = JSON.parse(officeInfo.text)
if (officeInfo.status !== 200 || officeInfoJson.ok !== true || officeInfoJson.renderable !== true) {
  throw new Error(`/office/info 对 .pdf 应 renderable:true，实际 ${officeInfo.status} ${officeInfo.text.slice(0, 200)}`)
}
console.log('✓ /office/info：.pdf 恒 renderable')

const officePdf = await request(`/api/personal-agent/office/pdf?path=${encodeURIComponent('_tmp/manual.pdf')}`, 'GET')
if (officePdf.status !== 200 || officePdf.headers['content-type'] !== 'application/pdf') {
  throw new Error(`/office/pdf 失败：${officePdf.status} ${officePdf.headers['content-type'] ?? ''} ${officePdf.text.slice(0, 120)}`)
}
if (!officePdf.body.equals(PDF_BYTES)) {
  throw new Error('/office/pdf 对 .pdf 应原样返回字节')
}
console.log('✓ /office/pdf：.pdf 原样返回 application/pdf')

// 不可渲染的扩展名 → 200 + renderable:false（不是错误，前端据此回退到下载）
const officeUnsupported = await request(`/api/personal-agent/office/info?path=${encodeURIComponent('_tmp/test.png')}`, 'GET')
const officeUnsupportedJson = JSON.parse(officeUnsupported.text)
if (officeUnsupported.status !== 200 || officeUnsupportedJson.ok !== true || officeUnsupportedJson.renderable !== false) {
  throw new Error(`/office/info 对 .png 应 renderable:false，实际 ${officeUnsupported.status} ${officeUnsupported.text.slice(0, 200)}`)
}
// 越界路径 → 403（这条路由族等于读本机文件，准入必须生效）
const officeEscape = await request(`/api/personal-agent/office/pdf?path=${encodeURIComponent('../../Windows/win.ini')}`, 'GET')
if (officeEscape.status !== 403) {
  throw new Error(`/office/pdf 越界路径应 403，实际 ${officeEscape.status} ${officeEscape.text.slice(0, 120)}`)
}
console.log('✓ /office/info 不可渲染回落 renderable:false、/office/pdf 拒绝越界')

// /office/page 的失败面：文件不存在 → 404 JSON（不能抛穿成 500 / 崩路由）
const officePageMissing = await request(`/api/personal-agent/office/page?path=${encodeURIComponent('_tmp/missing.docx')}&page=1`, 'GET')
const officePageMissingJson = JSON.parse(officePageMissing.text)
if (officePageMissing.status !== 404 || officePageMissingJson.ok !== false) {
  throw new Error(`/office/page 不存在的文件应 404 JSON，实际 ${officePageMissing.status} ${officePageMissing.text.slice(0, 160)}`)
}
console.log('✓ /office/page 失败一律 JSON（404 not-found）')

// 扩展名闸门：不在 RENDERABLE_EXT 里 → 415（先于引擎判断，不依赖本机装没装 LibreOffice）
const officePageUnsupported = await request(`/api/personal-agent/office/page?path=${encodeURIComponent('_tmp/test.png')}&page=1`, 'GET')
const officePageUnsupportedJson = JSON.parse(officePageUnsupported.text)
if (officePageUnsupported.status !== 415 || officePageUnsupportedJson.error !== 'unsupported-format') {
  throw new Error(`/office/page 对 .png 应 415 unsupported-format，实际 ${officePageUnsupported.status} ${officePageUnsupported.text.slice(0, 160)}`)
}
console.log('✓ /office/page 扩展名闸门：非 RENDERABLE_EXT → 415')

/* ───────────── generate_video：落盘 videos / 异步任务 videoTask ───────────── */

/*
 * 视频字节必须过 magic number 校验（mp4 家族第 4–8 字节是 'ftyp'）：这里构造一段
 * 带合法 box 头的假 mp4，用 data URL 喂给工具结果 —— 不依赖网络，也不碰真实网关。
 */
const FAKE_VIDEO = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('isommp42', 'ascii'),
  Buffer.from('fake-video-payload-'.repeat(4), 'ascii'),
])
const FAKE_VIDEO_DATA_URL = `data:video/mp4;base64,${FAKE_VIDEO.toString('base64')}`
const VIDEO_URL_PREFIX = '/api/personal-agent/file?path=_tmp%2Fgenerated-media%2F'

imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-video-1',
    name: 'generate_video',
    arguments: JSON.stringify({ prompt: '一只猫在弹钢琴，电影感', duration: 5 }),
  })
  emitEvent('tool/result', {
    message: {
      toolCallId: 'call-video-1',
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, model: 'test/video-model', data: { video_url: FAKE_VIDEO_DATA_URL } }),
      }],
    },
  })
})
const videoTurn = await askImageBot('生成一段猫弹钢琴的视频')
const videoRun = videoTurn.blocks.find((block) => block.type === 'tool')?.run
if (videoRun?.name !== 'generate_video' || videoRun.status !== 'ok') {
  throw new Error(`生视频工具卡状态不对：${videoRun?.name} ${videoRun?.status}`)
}
if (videoRun.prompt !== '一只猫在弹钢琴，电影感') {
  throw new Error(`生视频 prompt 未原样带上：${videoRun.prompt}`)
}
if (!Array.isArray(videoRun.videos) || videoRun.videos.length !== 1) {
  throw new Error(`videos 应有 1 条，实际 ${JSON.stringify(videoRun.videos)}`)
}
if (!videoRun.videos[0].startsWith(VIDEO_URL_PREFIX)) {
  throw new Error(`视频 URL 形状不对：${videoRun.videos[0]}`)
}
if (videoRun.model !== 'test/video-model') throw new Error(`生视频 model 不对：${videoRun.model}`)
const videoFile = await request(videoRun.videos[0], 'GET')
if (videoFile.status !== 200 || videoFile.headers['content-type'] !== 'video/mp4') {
  throw new Error(`落盘视频读回失败：${videoFile.status} ${videoFile.headers['content-type'] ?? ''}`)
}
if (!videoFile.body.equals(FAKE_VIDEO)) throw new Error('落盘视频字节与 data URL 不一致')
console.log('✓ generate_video：data URL 落盘到 _tmp/generated-media，经 /file 读回')

// 异步任务形态：只有 id + status，没有可播放文件 → videoTask
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-video-2',
    name: 'generate_video',
    arguments: JSON.stringify({ prompt: '海浪拍岸' }),
  })
  emitEvent('tool/result', {
    message: {
      toolCallId: 'call-video-2',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { id: 'task-1', status: 'queued' } }) }],
    },
  })
})
const videoTaskTurn = await askImageBot('再来一段海浪')
const videoTaskRun = videoTaskTurn.blocks.find((block) => block.type === 'tool')?.run
if (videoTaskRun?.status !== 'ok') throw new Error(`异步任务场景工具卡状态不对：${videoTaskRun?.status}`)
if (videoTaskRun.videoTask?.id !== 'task-1' || videoTaskRun.videoTask?.status !== 'queued') {
  throw new Error(`videoTask 应为 {id:'task-1',status:'queued'}，实际 ${JSON.stringify(videoTaskRun.videoTask)}`)
}
if (videoTaskRun.videos !== undefined) throw new Error('异步任务场景不应带 videos')
console.log('✓ generate_video：异步任务回落 videoTask = {id,status}')

// 下载失败（域名不可达）只影响 videos：工具卡本身必须还是 ok、result 保留
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-video-3',
    name: 'generate_video',
    arguments: JSON.stringify({ prompt: '森林延时' }),
  })
  emitEvent('tool/result', {
    message: {
      toolCallId: 'call-video-3',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { url: 'https://example.invalid/v.mp4' } }) }],
    },
  })
})
const videoFailTurn = await askImageBot('来一段森林延时')
const videoFailRun = videoFailTurn.blocks.find((block) => block.type === 'tool')?.run
if (videoFailRun?.status !== 'ok') throw new Error(`下载失败时工具卡应仍为 ok，实际 ${videoFailRun?.status}`)
if (videoFailRun.videos !== undefined) throw new Error('下载失败时不应带 videos')
if (videoFailRun.result === undefined) throw new Error('下载失败时 result 摘要不应丢')
console.log('✓ generate_video：下载失败只影响 videos，工具卡仍 ok')

/* ───────────── artifacts：工具产出的工作区文件 → ToolRun.artifacts ───────────── */

// pwsh 结果文本里的相对路径（真实存在才算）
const OUT_DOCX_BYTES = Buffer.from('PK fake docx from pwsh', 'utf8')
writeFileSync(join(tmpDir, 'out.docx'), OUT_DOCX_BYTES)
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-pwsh-1',
    name: 'pwsh',
    arguments: JSON.stringify({ command: 'python make_docx.py' }),
  })
  emitEvent('tool/result', {
    message: {
      toolCallId: 'call-pwsh-1',
      content: [{ type: 'text', text: '已生成：_tmp/out.docx（12 KB），另外 _tmp/not-exist.pdf 不存在。' }],
    },
  })
})
const artifactTurn = await askImageBot('把结论整理成 Word')
const artifactRun = artifactTurn.blocks.find((block) => block.type === 'tool')?.run
if (artifactRun?.status !== 'ok') throw new Error(`pwsh 工具卡状态不对：${artifactRun?.status}`)
if (!Array.isArray(artifactRun.artifacts) || artifactRun.artifacts.length !== 1) {
  throw new Error(`artifacts 应只收真实存在的 1 条，实际 ${JSON.stringify(artifactRun.artifacts)}`)
}
const artifact = artifactRun.artifacts[0]
if (artifact.path !== '_tmp/out.docx') throw new Error(`artifact.path 不对：${artifact.path}`)
if (artifact.kind !== 'doc') throw new Error(`artifact.kind 应为 doc，实际 ${artifact.kind}`)
if (artifact.name !== 'out.docx') throw new Error(`artifact.name 不对：${artifact.name}`)
if (artifact.size !== OUT_DOCX_BYTES.length) throw new Error(`artifact.size 不对：${artifact.size}`)
if (artifact.url !== `/api/personal-agent/file?path=${encodeURIComponent('_tmp/out.docx')}`) {
  throw new Error(`artifact.url 不对：${artifact.url}`)
}
const artifactFile = await request(artifact.url, 'GET')
if (artifactFile.status !== 200 || artifactFile.headers['content-type'] !== DOCX_MIME) {
  throw new Error(`artifact.url 读回失败：${artifactFile.status} ${artifactFile.headers['content-type'] ?? ''}`)
}
console.log('✓ artifacts：pwsh 结果里的 _tmp/out.docx 被识别（kind=doc + 可读回）')

// present 的参数路径（结果文本里没有路径，全靠 args）也要能识别
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-present-1',
    name: 'present',
    arguments: JSON.stringify({ path: '_tmp/out.docx', title: '分析报告' }),
  })
  emitEvent('tool/result', {
    message: { toolCallId: 'call-present-1', content: [{ type: 'text', text: '已展示 1 个文件' }] },
  })
})
const presentTurn = await askImageBot('把报告展示出来')
const presentRun = presentTurn.blocks.find((block) => block.type === 'tool')?.run
if (!Array.isArray(presentRun?.artifacts) || presentRun.artifacts[0]?.path !== '_tmp/out.docx') {
  throw new Error(`present 的 artifacts 识别失败：${JSON.stringify(presentRun?.artifacts)}`)
}
if (presentRun.artifacts[0].kind !== 'doc') throw new Error('present 的 artifact.kind 应为 doc')
console.log('✓ artifacts：present 的 args.path 被识别')

console.log('[personal-agent host] PASS')
