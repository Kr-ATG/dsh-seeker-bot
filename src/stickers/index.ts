/**
 * dsh-seeker-bot — 聊天贴纸（表情包）的宿主侧路由。
 *
 * 只做一件事：把随包分发的 assets/stickers/ 下的图片，以正确的 MIME 与缓存头
 * 吐给浏览器。形态与 src/avatar/index.ts、src/host/done-pill/sfx.ts 完全同构：
 *
 *  · 前缀 /api/chat-flow/stickers，内部按**精确文件名**分发；
 *  · 文件名表由 shared/stickers.ts 的清单派生，两者永远一一对应；
 *  · 未知文件名一律 404 JSON，绝不回落到「读任意路径」——不存在路径穿越面；
 *  · 内容随版本固定，immutable 缓存一年（客户端 URL 带 ?v= 版本，见 stickerUrl）。
 *
 * 为什么不把贴纸内联进 client 产物：几十张 PNG 会让每个用户冷启动都多背一份
 * 体积，而贴纸是按需出现的——只拉用过的那几张，之后靠缓存命中。
 *
 * @module
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STICKER_ROUTE, STICKERS } from '../shared/stickers.ts'

/** 路由前缀再导出：host 入口与冒烟按它断言（唯一真相在 shared/stickers.ts）。 */
export { STICKER_ROUTE } from '../shared/stickers.ts'

/** 对外文件名 → 包内相对路径 + MIME。清单里 file 重名时后一条覆盖前一条——由清单测试兜底。 */
const STICKER_ASSETS: Readonly<Record<string, { readonly rel: string; readonly mime: string }>> = Object.freeze(
  Object.fromEntries(
    STICKERS.map(entry => [entry.file, { rel: `assets/stickers/${entry.group}/${entry.file}`, mime: entry.mime }]),
  ),
)

/**
 * 解析包根目录下的资产绝对路径。
 *
 * 兼容两种产物形态（与 src/fonts/index.ts、src/avatar/index.ts 同一套约定）：
 * esbuild 打成单文件 lib/index.js 时 `..` 即包根；tsc 保留目录结构
 * lib/xxx.js 时 `../..` 才是包根。
 * @param rel - 包内相对路径（posix 分隔）。
 * @returns 命中的绝对路径；两处都不存在时返回 null。
 */
function resolveAsset(rel: string): string | null {
  const candidates = [
    join(fileURLToPath(new URL('..', import.meta.url)), ...rel.split('/')),
    join(fileURLToPath(new URL('../..', import.meta.url)), ...rel.split('/')),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

/** 已解析过的资产路径缓存（进程内不变，避免每请求两次 existsSync）。 */
const resolved = new Map<string, string | null>()

function assetPath(file: string): string | null {
  if (!resolved.has(file)) resolved.set(file, resolveAsset(STICKER_ASSETS[file]!.rel))
  return resolved.get(file) ?? null
}

/**
 * 注册贴纸路由（在已注入 webServer 的子上下文中调用）。
 *
 * 用 kind: 'prefix' 一次挂住整个前缀，内部按精确文件名分发；未知文件名一律
 * 404，绝不回落到「读任意路径」。
 * @param webCtx - webServer 服务已就绪的插件上下文。
 */
export function applyStickerRoutes(webCtx: Record<string, any>): void {
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'prefix',
    path: STICKER_ROUTE,
    handler: (req: any, res: any) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      let file = ''
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        file = decodeURIComponent(url.pathname.slice(STICKER_ROUTE.length).replace(/^\/+/, ''))
      } catch {
        // 非法百分号编码：按键名未知处理，绝不让异常冒出 handler。
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'unknown sticker' }))
        return
      }
      const entry = STICKER_ASSETS[file]
      if (entry === undefined) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'unknown sticker' }))
        return
      }
      const path = assetPath(file)
      if (path === null) {
        // 资产缺失（打包漏了 files 字段、或清单里登记了没落盘的文件）：明确报错，
        // 不要静默 200 空体——那会让前端把「贴纸加载失败」表现成一张破图。
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'sticker asset missing from package' }))
        return
      }
      let size: number
      try {
        size = statSync(path).size
      } catch {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'sticker asset unreadable' }))
        return
      }
      res.writeHead(200, {
        'content-type': entry.mime,
        'content-length': String(size),
        'cache-control': 'public, max-age=31536000, immutable',
      })
      if (req.method === 'HEAD') { res.end(); return }
      const stream = createReadStream(path)
      stream.on('error', () => { try { res.destroy() } catch { /* 已经断了 */ } })
      stream.pipe(res)
    },
  }), 'dsh-seeker-bot: sticker asset route')
}
