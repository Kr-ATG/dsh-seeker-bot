/**
 * dsh-seeker-bot — 生图结果文本解析（纯函数）。
 *
 * generate_image 工具（dsh-provider-hub 的 model-capabilities）把结果以
 * `JSON.stringify(value, null, 2)` 写进 tool-call 节点的 content 文本块。三种形态
 * 都要认：
 *  - 旧：`{ ok, model, endpoint, data: { data: [{ b64_json | url }] } }`（OpenAI 兼容
 *    images/generations 原始响应，b64_json 转 data URL 交给 <img> 直接渲染）；
 *  - 旧 vision-helper 通道：`{ ok, imageUrls, imageUrl, imageDataUrl }`；
 *  - 新（2026-11-03 起）：`{ ok, model, endpoint, images: [{ path, mime, bytes, width, height }] }`
 *    —— 工具已把图落盘，不再回 base64（那会让模型以为没拿到图、重复生成一张）。
 *    path 是宿主绝对路径，拼成同源文件路由 URL 后 <img> 能直接加载。
 */

export interface GeneratedImageEntry {
  readonly url: string
  readonly model: string | null
}

/** 候选图片：OpenAI data[].b64_json / url 字段。 */
interface RawCandidate {
  readonly b64_json?: unknown
  readonly url?: unknown
}

function pushUnique(list: GeneratedImageEntry[], url: string, model: string | null): void {
  if (url === '') return
  if (!list.some(entry => entry.url === url)) list.push({ url, model })
}

/**
 * 同源文件路由：与 host 侧 `src/host/personal/agent.ts` 的 IMAGE_FILE_ROUTE 同口径。
 *
 * 为什么客户端能拼出这个 URL：`/api/personal-agent/file` 的准入白名单包含
 * `materializeRoot()`（`<DSH_HOME>/storages/dsh-seeker-bot-generated`），而新格式
 * 的 `images[].path` 正是落在那里的绝对路径 —— 拼成同源 URL 后浏览器能直接加载，
 * 不需要把几 MB 的图再塞回 JSON。
 */
const GENERATED_FILE_ROUTE = '/api/personal-agent/file'

/**
 * 一条 `images[]` 项 → 可显示的 URL。
 *
 * `url`（网关直给的 http / data URL）优先，其次 `path` 转同源文件路由 URL。
 * 两项都没有 / 类型不对就返回 null —— 这个函数**绝不抛错**：画廊是「少一张能接受、
 * 崩了不能接受」的地方。
 */
function urlOfGeneratedItem(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) return null
  const record = item as { url?: unknown; path?: unknown }
  if (typeof record.url === 'string' && record.url !== '') return record.url
  if (typeof record.path === 'string' && record.path !== '') {
    return `${GENERATED_FILE_ROUTE}?path=${encodeURIComponent(record.path)}`
  }
  return null
}

/** 从 OpenAI 兼容响应体里提取图片 URL（b64_json 转 data URL 优先，其次 url）。 */
function collectFromData(data: unknown, model: string | null, list: GeneratedImageEntry[]): void {
  if (!Array.isArray(data)) return
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as RawCandidate
    if (typeof record.b64_json === 'string' && record.b64_json !== '') {
      const b64 = record.b64_json.replace(/\s+/g, '')
      pushUnique(list, `data:image/png;base64,${b64}`, model)
    } else if (typeof record.url === 'string' && record.url !== '') {
      pushUnique(list, record.url, model)
    }
  }
}

/**
 * 解析一个 generate_image 工具结果文本，返回画廊条目（已去重）。
 * 解析失败 / 无图片时返回空数组（绝不抛错）。
 */
export function parseGeneratedImageText(text: string): readonly GeneratedImageEntry[] {
  const list: GeneratedImageEntry[] = []
  if (typeof text !== 'string' || text.trim() === '') return list
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return list
  }
  if (typeof parsed !== 'object' || parsed === null) return list
  const record = parsed as Record<string, unknown>
  if (record.ok !== true) return list
  const model = typeof record.model === 'string' && record.model !== '' ? record.model : null

  // 主通道：data.data[]（sensenova 等 OpenAI 兼容网关）。
  const data = record.data as Record<string, unknown> | undefined
  if (typeof data === 'object' && data !== null) {
    collectFromData(data.data, model, list)
  }
  /*
   * 新通道（2026-11-03 起）：工具已把图落盘，结果里只有 `images[].path`。
   * 放在 data.data[] 之后：历史结果里两种形态可能同时存在，顺序只影响优先级。
   */
  if (Array.isArray(record.images)) {
    for (const item of record.images) {
      const url = urlOfGeneratedItem(item)
      if (url !== null) pushUnique(list, url, model)
    }
  }
  // 旧 vision-helper 通道：imageUrls / imageUrl / imageDataUrl。
  if (Array.isArray(record.imageUrls)) {
    for (const item of record.imageUrls) {
      if (typeof item === 'string' && item !== '') pushUnique(list, item, model)
    }
  }
  for (const key of ['imageUrl', 'imageDataUrl'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') pushUnique(list, value, model)
  }
  return list
}

/** Spill locator 正则：完整结果存储路径（preview 通知行的一部分）。 */
const SPILL_LOCATOR_RE = /Full formatted result stored at: ([^\s]+?)\.\s+Use read with offset\/limit/i

/**
 * 从工具结果文本中提取 spill 定位路径（DSH spill-policy 把超大纯文本结果
 * 替换成「preview + locator」，完整 JSON 落在该文件里）。没有则返回 undefined。
 */
export function findSpillLocator(text: string): string | undefined {
  if (typeof text !== 'string') return undefined
  const match = SPILL_LOCATOR_RE.exec(text)
  const locator = match?.[1]
  return locator !== undefined && locator !== '' ? locator : undefined
}
