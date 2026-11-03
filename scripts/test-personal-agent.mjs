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

/*
 * agent 不可用时必须 **502 + 明确原因**，而不是降级成一次纯 LLM 补全。
 *
 * 这个用例以前断言的是 200 + 模型文本（那条降级路径的产物）。降级策略已删除：
 * 它会让「agent 挂了」表现成「Bot 正常回复」，实测踩过一个空壳会话让每轮都
 * 静默降级，Bot 满口答应「我这就建」却一个文件都产不出来，界面上零报错。
 */
const reply = await request('/api/personal-agent/reply', 'POST', {
  bot: { name: '小墨助手', role: '主助手', model: { provider: 'alymagpie', model: 'auto/deepseek-v4.1-flash' } },
  text: '你好',
  history: [],
  memories: ['用户喜欢直接的回答'],
})
const replyJson = JSON.parse(reply.text)
if (reply.status !== 502 || replyJson.ok !== false || !String(replyJson.agentError ?? '').includes('agents')) {
  throw new Error(`agent 不可用时应 502 + 明确原因，实际 ${reply.status} ${reply.text.slice(0, 200)}`)
}
console.log('✓ /reply：agent 不可用 → 502 明确报错（不再静默降级）')

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

/*
 * 图片路径必须进模型输入——但断言挪到后面去了。
 *
 * 原来这里检查 `lastLlmOptions`（降级路径调 `ctx.llm.stream` 的入参）。降级策略
 * 已删除，`/reply` 现在只有 agent 路径，所以改在 fake agent 的 `followup()` 上断言。
 */


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
/** 最近一次 `followup()` 收到的消息（JSON）：用来断言「图片提示真的进了 user 消息」。 */
let lastFollowupText = ''
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
  followup(message) {
    lastFollowupText = JSON.stringify(message ?? null)
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

async function askImageBot(text, images = []) {
  const response = await request('/api/personal-agent/reply', 'POST', {
    bot: {
      id: IMAGE_BOT_ID,
      name: '画图机器人',
      role: '画师',
      model: { provider: 'alymagpie', model: 'auto/deepseek-v4.1-flash' },
    },
    text,
    ...(images.length > 0 ? { images } : {}),
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

/*
 * ── 文档优先：产出 docx 时，图片类产物（排版预览图）要被摘掉 ──────────────
 *
 * 实测用户反馈：「我要 word 应该是直出」。模型生成 Word 时顺手导出的
 * page1.png / cover2.png 被当成正式产物挂上卡片，四张 PNG 淹没了那个 Word。
 * 规则：本轮只要有文档类产物，图片类产物一律不显示（纯截图任务不受影响）。
 */
writeFileSync(join(tmpDir, 'prune.docx'), Buffer.from('PK prune docx', 'utf8'))
writeFileSync(join(tmpDir, 'page1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-prune-1',
    name: 'pwsh',
    arguments: JSON.stringify({ command: 'python make_docx.py' }),
  })
  emitEvent('tool/result', {
    message: {
      toolCallId: 'call-prune-1',
      content: [{ type: 'text', text: '已生成 _tmp/prune.docx，排版预览图 _tmp/page1.png' }],
    },
  })
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '文档好了。' }] } })
})
const pruneTurn = await askImageBot('生成一个 word')
const prunePaths = (run) => (run?.artifacts ?? []).map((item) => item.path)
// 多消息视图（前端实际渲染的）
const pruneMessageRun = pruneTurn.messages
  .flatMap((message) => message.blocks)
  .find((block) => block.type === 'tool')?.run
const pruneMessagePaths = prunePaths(pruneMessageRun)
if (pruneMessagePaths.includes('_tmp/page1.png')) {
  throw new Error(`messages 里的图片类中间产物应被摘掉，实际：${JSON.stringify(pruneMessagePaths)}`)
}
if (!pruneMessagePaths.includes('_tmp/prune.docx')) {
  throw new Error(`messages 里必须保留最终文档，实际：${JSON.stringify(pruneMessagePaths)}`)
}
// 扁平 blocks（非流式调用方 / 旧前端仍按它渲染）也要一致
const pruneFlatRun = pruneTurn.blocks.find((block) => block.type === 'tool')?.run
const pruneFlatPaths = prunePaths(pruneFlatRun)
if (pruneFlatPaths.includes('_tmp/page1.png') || !pruneFlatPaths.includes('_tmp/prune.docx')) {
  throw new Error(`扁平 blocks 的产物也要摘干净，实际：${JSON.stringify(pruneFlatPaths)}`)
}
console.log('✓ 文档优先：产出 docx 时预览图被摘掉（messages 与 blocks 都一致）')

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

/*
 * ── 多消息切分（DOST 式）──────────────────────────────────────────────
 *
 * 一次 turn 里模型说两段话（说完调工具、拿到结果再说一段），应切成两条消息：
 *   · 第一条 progress，包含第一段文本 + 它触发的工具块；
 *   · 第二条 final，只有第二段文本。
 *
 * 工具块**不跨消息**是硬约束：生图占位卡若跑到下一条气泡里，用户会看到
 * 「先出现一个空占位、随后在别处冒出图片」，生视频的秒数计时器也会重新挂载。
 */
imageSteps.push((emitEvent) => {
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '我先查一下工作区。' }] } })
  emitEvent('tool/call', {
    callId: 'call-multi-1',
    name: 'pwsh',
    arguments: JSON.stringify({ command: 'Get-ChildItem' }),
  })
  emitEvent('tool/result', {
    message: { toolCallId: 'call-multi-1', content: [{ type: 'text', text: 'a.txt' }] },
  })
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '找到了一个文件。' }] } })
})
const multiTurn = await askImageBot('看看工作区')
const multiMessages = multiTurn.messages
if (!Array.isArray(multiMessages) || multiMessages.length !== 2) {
  throw new Error(`多消息切分应得 2 条，实际 ${multiMessages?.length}：${JSON.stringify(multiMessages).slice(0, 300)}`)
}
if (multiMessages[0].kind !== 'progress') {
  throw new Error(`第一条 kind 应为 progress，实际 ${multiMessages[0].kind}`)
}
if (multiMessages[1].kind !== 'final') {
  throw new Error(`最后一条 kind 应为 final，实际 ${multiMessages[1].kind}`)
}
const firstText = multiMessages[0].blocks.find((block) => block.type === 'text')?.text
if (firstText !== '我先查一下工作区。') {
  throw new Error(`第一条文本不对：${firstText}`)
}
if (!multiMessages[0].blocks.some((block) => block.type === 'tool' && block.run?.id === 'call-multi-1')) {
  throw new Error('工具块没有归属到发起它的那条消息')
}
if (multiMessages[1].blocks.some((block) => block.type === 'tool')) {
  throw new Error('工具块跨到了下一条消息（生图卡会跳气泡）')
}
console.log('✓ 多消息切分：两段话两条消息，工具块不跨消息，末条标 final')

/*
 * ── bot_emit：模型主动播报 need-input / finding / approval ─────────────
 *
 * host 推导只能给出 progress / final 两档；`need-input` 与 `approval` 必须由模型
 * 自己声明。断言两件事：
 *   1. bot_emit 产生一条**指定 kind** 的独立消息；
 *   2. 它**不产生工具卡**——用户该看到「一个问题」，而不是「调了一个工具」。
 */
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-emit-1',
    name: 'bot_emit',
    arguments: JSON.stringify({ kind: 'need-input', text: '你要 Markdown 还是 Word？' }),
  })
  emitEvent('tool/result', {
    message: { toolCallId: 'call-emit-1', content: [{ type: 'text', text: '{"ok":true}' }] },
  })
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '你定了我就开始。' }] } })
})
const emitTurn = await askImageBot('帮我写个报告')
const emitMessages = emitTurn.messages
if (!Array.isArray(emitMessages) || emitMessages.length !== 2) {
  throw new Error(`bot_emit 应产生 2 条消息，实际 ${emitMessages?.length}：${JSON.stringify(emitMessages).slice(0, 300)}`)
}
if (emitMessages[0].kind !== 'need-input') {
  throw new Error(`第一条 kind 应为 need-input，实际 ${emitMessages[0].kind}`)
}
const emitText = emitMessages[0].blocks.find((block) => block.type === 'text')?.text
if (emitText !== '你要 Markdown 还是 Word？') {
  throw new Error(`bot_emit 文本不对：${emitText}`)
}
if (emitMessages[0].blocks.some((block) => block.type === 'tool')) {
  throw new Error('bot_emit 不该产生工具卡（用户应看到一条消息，不是一个工具）')
}
if (emitMessages[1].kind !== 'final') {
  throw new Error(`最后一条应为 final，实际 ${emitMessages[1].kind}`)
}
// kind 不在白名单时退回 finding，且空文本整条丢弃
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-emit-2',
    name: 'bot_emit',
    arguments: JSON.stringify({ kind: '随便写的', text: '发现端口被占用。' }),
  })
  emitEvent('tool/call', {
    callId: 'call-emit-3',
    name: 'bot_emit',
    arguments: JSON.stringify({ kind: 'finding', text: '   ' }),
  })
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '好了。' }] } })
})
const emitFallback = await askImageBot('再看看')
if (emitFallback.messages?.[0]?.kind !== 'finding') {
  throw new Error(`非法 kind 应退回 finding，实际 ${emitFallback.messages?.[0]?.kind}`)
}
if (emitFallback.messages.length !== 2) {
  throw new Error(`空文本的 bot_emit 应被丢弃，实际产生 ${emitFallback.messages.length} 条消息`)
}
console.log('✓ bot_emit：按 kind 播报、不产工具卡、非法 kind 退回 finding、空文本丢弃')

/*
 * ── /memory/remember：面板「添加记忆」的写入路由（schema v6）────────────
 *
 * 三条断言对应三种真实故障面：
 *   1. 参数缺失要 400，不能静默写一条空记忆；
 *   2. 记忆引擎没启动（Work 工作台插件被关掉）必须 503，不能假装成功——
 *      假装成功会让用户以为记住了，实际什么也没落库；
 *   3. 归属由 host 推导（owner=bot:<botId> + bot 工作区 hash），前端不传 hash。
 */
{
  const missingBot = await request('/api/personal-agent/memory/remember', 'POST', { content: 'x' })
  if (missingBot.status !== 400) {
    throw new Error(`memory/remember 缺 botId 应 400，实际 ${missingBot.status} ${missingBot.text.slice(0, 120)}`)
  }
  const missingContent = await request('/api/personal-agent/memory/remember', 'POST', { botId: 'bot-a' })
  if (missingContent.status !== 400) {
    throw new Error(`memory/remember 缺 content 应 400，实际 ${missingContent.status}`)
  }
  // 本测试没有启动记忆引擎，所以成功路径在这里必然落到 503 降级分支。
  const noEngine = await request('/api/personal-agent/memory/remember', 'POST', {
    botId: 'bot-a',
    content: '用户偏好先看结论',
    tags: ['手动'],
  })
  if (noEngine.status !== 503) {
    throw new Error(`记忆引擎缺失应 503，实际 ${noEngine.status} ${noEngine.text.slice(0, 120)}`)
  }
  console.log('✓ memory/remember：参数校验与引擎缺失降级正确')
}

/*
 * ── 图片提示进 agent 的 user 消息 ──────────────────────────────────────
 *
 * bot 的 user 消息没有多模态 image part，图片靠这段文本提示让模型自己 read_image。
 * 断言点在 fake agent 的 `followup()` 入参上（降级路径删除后，不再有 llm.stream 可看）。
 */
imageSteps.push((emitEvent) => {
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '我看到一张截图。' }] } })
})
await askImageBot('这张图里是什么', [{ path: uploadJson.path, name: '截图.png' }])
{
  const hasHint = lastFollowupText.includes('用户发来')
  // Windows 上 join() 会把相对路径里的 / 规范成 \，JSON 里再转义成 \\，所以只比对文件名
  const uploadedName = String(uploadJson.path).split('/').pop()
  const hasPath = lastFollowupText.includes(String(uploadedName))
  if (!hasHint || !hasPath) {
    throw new Error(`图片提示没进 agent 的 user 消息（hasHint=${hasHint} hasPath=${hasPath} name=${String(uploadedName)}）：${lastFollowupText.slice(0, 300)}`)
  }
  console.log('✓ 图片路径写进 agent 的 user 消息提示（模型可据此 read_image）')
}

/*
 * ── 工具卡归属：迟到的 tool/result 不能把卡复制到新消息里 ──────────────
 *
 * 生图 / 生视频的落盘是异步的，补 images / videos 那次 update 常常晚于下一个
 * step 的 assistant/message。旧实现按 `currentMessage` 定位，找不到就 push 一份
 * 副本 → 同一张卡裂成两个气泡（实测用户报「生成图片会有两个点阵图」）。
 */
imageSteps.push((emitEvent) => {
  emitEvent('tool/call', {
    callId: 'call-late-1',
    name: 'pwsh',
    arguments: JSON.stringify({ command: 'slow-task' }),
  })
  // 模型已经说了下一段话：此时 currentMessage 指向新消息
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '稍等，我正在处理。' }] } })
  // 工具结果迟到
  emitEvent('tool/result', {
    message: { toolCallId: 'call-late-1', content: [{ type: 'text', text: '完成' }] },
  })
})
const lateTurn = await askImageBot('跑个慢任务')
const lateToolBlocks = lateTurn.messages
  .flatMap((message) => message.blocks)
  .filter((block) => block.type === 'tool' && block.run?.id === 'call-late-1')
if (lateToolBlocks.length !== 1) {
  throw new Error(`同一个 callId 只应有一张工具卡，实际 ${lateToolBlocks.length} 张`)
}
if (lateToolBlocks[0].run.status !== 'ok') {
  throw new Error(`迟到的结果必须原地更新，实际状态 ${lateToolBlocks[0].run.status}`)
}
console.log('✓ 工具卡归属：迟到的 tool/result 原地更新，不复制到新消息')

/*
 * ── 宿主侧调度：例行任务同步 + 事件流参数校验 ──────────────────────────
 *
 * 例行任务已从「前端 setInterval」搬到宿主常驻调度器。断言三件事：
 *   1. 前端推上来的定义要**过滤坏数据**（缺 botId、schedule 形状不认识）——
 *      留着它们会让调度器每 30 秒对着一条跑不起来的任务空转；
 *   2. `nextAt` 必须被补成**未来**时间，否则任务会在下一次 tick 立刻连跑；
 *   3. `/events` 缺 botId 要明确 400（SSE 无法按 bot 隔离时宁可不连）。
 */
{
  const synced = await request('/api/personal-agent/routines', 'POST', {
    routines: [
      { id: 'r1', botId: 'bot-a', botName: '小墨', name: '每日巡检', instruction: '看有没有异常', schedule: { kind: 'daily', time: '09:00' }, enabled: true },
      { id: 'r2', botId: 'bot-a', name: '坏规则', schedule: { kind: 'bogus' } },
      { id: 'r3', botId: '', name: '缺 botId', schedule: { kind: 'daily', time: '10:00' } },
    ],
  })
  const syncedJson = JSON.parse(synced.text)
  if (synced.status !== 200 || syncedJson.count !== 1) {
    throw new Error(`routines 应只保留 1 条合法任务，实际 ${syncedJson.count}：${synced.text.slice(0, 200)}`)
  }
  const routine = syncedJson.routines[0]
  if (!(typeof routine.nextAt === 'number' && routine.nextAt > Date.now())) {
    throw new Error(`nextAt 必须是未来时间，实际 ${routine.nextAt}`)
  }
  const listed = JSON.parse((await request('/api/personal-agent/routines', 'GET')).text)
  if (!Array.isArray(listed.routines) || listed.routines.length !== 1) {
    throw new Error('routines 回读条数不对')
  }
  const emptyMessages = JSON.parse((await request('/api/personal-agent/messages', 'GET')).text)
  if (emptyMessages.ok !== true || !Array.isArray(emptyMessages.messages)) {
    throw new Error('/messages 形状不对')
  }
  const noBot = await request('/api/personal-agent/events', 'GET')
  if (noBot.status !== 400) {
    throw new Error(`/events 缺 botId 应 400，实际 ${noBot.status}`)
  }

  /*
   * `botId=*`：一条连接订阅全部 Bot。
   *
   * 前端原来给每个 Bot 建一条常驻 SSE，而浏览器同源 HTTP/1.1 并发上限只有 6 条，
   * 建到第 4 个子 Bot 就把连接顶满、界面卡死。合并成一条后这个分支必须真的能建流
   * 并下发 hello——否则前端会拿到 400/500，等于把推送整个关掉。
   *
   * 这里手工构造 req/res（不能用上面的 request 桩：它把 res.end 当结束，而 SSE
   * 本来就不结束）。建流后 60ms 检查 hello，再触发 close 收尾。
   */
  {
    const chunks = []
    const handlers = {}
    let ended = false
    const sseReq = {
      url: '/api/personal-agent/events?botId=*',
      method: 'GET',
      headers: {},
      on(event, handler) { handlers[event] = handler },
      destroy() {},
    }
    const sseRes = {
      statusCode: 0,
      setHeader() {},
      writeHead(status) { this.statusCode = status },
      write(chunk) { chunks.push(String(chunk)) },
      end() { ended = true },
    }
    void route.handler(sseReq, sseRes)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const text = chunks.join('')
    if (sseRes.statusCode !== 200) {
      throw new Error(`/events?botId=* 应 200，实际 ${sseRes.statusCode}`)
    }
    if (!text.includes('"type":"hello"')) {
      throw new Error(`/events?botId=* 应下发 hello，实际收到：${text.slice(0, 200)}`)
    }
    handlers.close?.()
    if (!ended) throw new Error('/events?botId=* 关闭连接后应 end 掉响应')
  }

  console.log('✓ 例行任务同步（坏数据丢弃 / nextAt 未来）、/messages、/events 参数校验 + 合并连接建流')
}

/*
 * ── 子 Bot 账本（`bot_create` 的补发源） ─────────────────────────────
 *
 * `bot_create` 工具本身由 `scripts/test-bot-create.mjs` 覆盖；这里只测**两条
 * 路由**，因为它们是「页面关着时建的 Bot 能不能补回来」和「删掉的 Bot 会不会
 * 复活」的唯一通道：
 *
 *   GET    /bots/created         → 前端启动时补拉账本
 *   DELETE /bots/created?botId=  → 前端删 Bot 时抹账本
 *
 * 直接往账本文件写一条再走 HTTP，不经过工具：账本是宿主侧的权威副本，前端只按
 * 它补发，所以「文件里有什么」就是这条链路的真实输入。
 */
{
  const ledger = join(process.env.DSH_HOME, 'storages', 'dsh-seeker-bot', 'personal-agent', 'created-bots.json')
  const record = {
    id: 'bot-route01',
    name: '路由助手',
    role: '路由验证',
    description: '',
    instructions: '你是路由助手。',
    createdAt: Date.now(),
    createdBy: 'bot-main-xiaomo',
  }
  mkdirSync(join(ledger, '..'), { recursive: true })
  writeFileSync(ledger, JSON.stringify([record], null, 2), 'utf8')

  const listed = JSON.parse((await request('/api/personal-agent/bots/created', 'GET')).text)
  if (listed.ok !== true || !Array.isArray(listed.bots) || listed.bots.length !== 1) {
    throw new Error(`/bots/created 应返回 1 条账本记录，实际 ${JSON.stringify(listed).slice(0, 200)}`)
  }
  if (listed.bots[0].id !== 'bot-route01' || listed.bots[0].name !== '路由助手') {
    throw new Error(`/bots/created 返回的记录字段不对：${JSON.stringify(listed.bots[0]).slice(0, 200)}`)
  }

  const missingId = await request('/api/personal-agent/bots/created', 'DELETE')
  if (missingId.status !== 400) {
    throw new Error(`DELETE 缺 botId 应 400，实际 ${missingId.status}`)
  }

  const removed = JSON.parse((await request('/api/personal-agent/bots/created?botId=bot-route01', 'DELETE')).text)
  if (removed.ok !== true || removed.removed !== true) {
    throw new Error(`DELETE 应真的抹掉这条记录，实际 ${JSON.stringify(removed).slice(0, 200)}`)
  }
  const after = JSON.parse((await request('/api/personal-agent/bots/created', 'GET')).text)
  if (!Array.isArray(after.bots) || after.bots.length !== 0) {
    throw new Error(`抹账本后再拉应剩 0 条，实际 ${JSON.stringify(after).slice(0, 200)}`)
  }
  // 重复删同一条要幂等：前端删除流程不该因为「已经没了」而报错
  const again = JSON.parse((await request('/api/personal-agent/bots/created?botId=bot-route01', 'DELETE')).text)
  if (again.ok !== true || again.removed !== false) {
    throw new Error(`重复删同一条应回 removed:false（不报错），实际 ${JSON.stringify(again).slice(0, 200)}`)
  }
  console.log('✓ 子 Bot 账本：GET 补发 / DELETE 抹账（缺参 400、重复删幂等）')
}

/*
 * ── 彻底删除 Bot（`DELETE /bots`）──────────────────────────────────────
 *
 * 与上面那条 `DELETE /bots/created` 是两件事：那条只抹**账本**（防补发），
 * 这条把 Bot 从宿主真正抹掉（会话 / 花名册 / 工作记忆 / 映射 / 记忆 / 配置）。
 * 两者语义差一个数量级，混用会让「只想防补发」的调用意外删光数据——所以要
 * 各自钉一条断言。
 */
{
  const missing = await request('/api/personal-agent/bots', 'DELETE')
  if (missing.status !== 400) {
    throw new Error(`DELETE /bots 缺 botId 应 400，实际 ${missing.status}`)
  }

  const main = await request('/api/personal-agent/bots?botId=bot-main-xiaomo', 'DELETE')
  const mainJson = JSON.parse(main.text)
  if (main.status !== 400 || mainJson.ok !== false) {
    throw new Error(`主 Bot 应拒绝删除，实际 ${main.status} ${main.text.slice(0, 200)}`)
  }

  /*
   * 正常删除：只验路由层（ok + 清理清单形状 + 幂等）。
   *
   * 不在这里断言「账本被清」——`created-bots.json` 在宿主进程里有内存缓存，而本
   * 测试是直接写文件造的数据，缓存读不到（真实场景只有本进程写账本，不存在这个
   * 偏差）。账本清理的细节由 `scripts/test-bot-delete.mjs` 用干净环境覆盖。
   */
  const purged = JSON.parse((await request('/api/personal-agent/bots?botId=bot-victim01', 'DELETE')).text)
  if (purged.ok !== true || !Array.isArray(purged.removed)) {
    throw new Error(`DELETE /bots 应返回 ok + removed 清单，实际 ${JSON.stringify(purged).slice(0, 200)}`)
  }
  // 幂等：再删一次不报错
  const againPurged = JSON.parse((await request('/api/personal-agent/bots?botId=bot-victim01', 'DELETE')).text)
  if (againPurged.ok !== true) {
    throw new Error(`重复删除应仍返回 ok，实际 ${JSON.stringify(againPurged).slice(0, 200)}`)
  }
  console.log('✓ 彻底删除 Bot：缺参 400 / 主 Bot 拒绝 / 正常删除返回 ok + 清理清单 + 幂等')
}

/*
 * ── 审批通道 ────────────────────────────────────────────────────────
 *
 * 审批卡的决定必须回传给宿主（那里挂着一个 approval/request 的 Promise）。
 * 两条断言覆盖最容易做错的两处：
 *   1. 缺 approvalId → 400；
 *   2. 审批已超时/已处理 → **409 而不是 200**。假装成功会让用户以为授权生效了，
 *      而宿主其实早就把它结算成 cancelled，工具不会执行。
 */
{
  const missing = await request('/api/personal-agent/approval/decide', 'POST', { decision: 'allow' })
  if (missing.status !== 400) {
    throw new Error(`审批缺 approvalId 应 400，实际 ${missing.status}`)
  }
  const unknown = await request('/api/personal-agent/approval/decide', 'POST', {
    approvalId: 'ap-does-not-exist',
    decision: 'allow',
  })
  if (unknown.status !== 409) {
    throw new Error(`未知审批应 409，实际 ${unknown.status} ${unknown.text.slice(0, 120)}`)
  }
  if (JSON.parse(unknown.text).ok !== false) {
    throw new Error('409 回包里的 ok 必须是 false')
  }
  console.log('✓ 审批通道：缺参 400、失效审批 409（不假装成功）')
}

/*
 * ── 问答通道 ────────────────────────────────────────────────────────
 *
 * 模型调 `ask_user_question` 时，宿主找的是 `user-questions/request` 的应答者。
 * 不接这个 seam，请求会落到 Work 模式的官方问答卡上——而 Bot 是全屏自绘，那张卡
 * 在背后根本看不见，对话里只剩一个转圈的「...」（实测用户报的正是这个）。
 *
 * 这里只测回传契约（成功路径要挂起一个真实的 ask_user_question，代价太大）：
 *   缺 questionId → 400；已失效 → 409 而不是假装成功。
 */
{
  const missing = await request('/api/personal-agent/question/answer', 'POST', { selected: ['A'] })
  if (missing.status !== 400) {
    throw new Error(`问答缺 questionId 应 400，实际 ${missing.status}`)
  }
  const unknown = await request('/api/personal-agent/question/answer', 'POST', {
    questionId: 'q-does-not-exist',
    selected: ['A'],
  })
  if (unknown.status !== 409) {
    throw new Error(`未知问题应 409，实际 ${unknown.status} ${unknown.text.slice(0, 120)}`)
  }
  if (JSON.parse(unknown.text).ok !== false) {
    throw new Error('409 回包里的 ok 必须是 false')
  }
  console.log('✓ 问答通道：缺参 400、失效问题 409（不假装成功）')
}

console.log('[personal-agent host] PASS')
