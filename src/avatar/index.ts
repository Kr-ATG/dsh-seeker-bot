/**
 * dsh-seeker-bot — 「卡头头像动图」的宿主侧路由。
 *
 * 2026-11-05 用户要求把操作面板卡头的静态插件头像换成三张透明底 WebP 动图，
 * 按状态切换（无动作 / 调用生成视频图片IUhtml等 / 正在执行）。三张图合计约
 * 2.5MB，不适合内联进 client 产物（每个用户冷启动都要多下载一份巨大 JS 字符串），
 * 于是随包分发在 assets/avatar/ 下，由本路由按状态吐给浏览器。
 *
 * 形态与 src/fonts/index.ts 完全同构（同一套"插件没有公共静态目录、只能自己
 * 开路由"的约定）：
 *  · 路由前缀 /api/chat-flow/avatars；
 *  · 只服务一张**固定的文件名表**（idle.webp / generating.webp / executing.webp），
 *    请求路径必须精确命中，绝不接受任意文件名 —— 不存在路径穿越面；
 *  · 内容随版本固定，immutable 缓存一年；换图时客户端 URL 带版本 query
 *    （见 src/shared/avatar-assets.ts 的 AVATAR_VERSION），缓存键自然变化；
 *  · 资产缺失时明确 404 JSON，不静默 200 空体（否则浏览器把「头像加载失败」
 *    显示成一块空白，排查时看不出是路由没挂还是文件漏打包）。
 *
 * @module
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AVATAR_FILES, AVATAR_ROUTE } from '../shared/avatar-assets.ts'

/** 路由前缀再导出：host 入口与冒烟按它断言（唯一真相在 shared/avatar-assets.ts）。 */
export { AVATAR_ROUTE } from '../shared/avatar-assets.ts'

/** 对外名 → 包内相对路径 + MIME。文件名表由 AVATAR_FILES 派生，永远保持一一对应。 */
const AVATAR_ASSETS: Readonly<Record<string, { readonly rel: string; readonly mime: string }>> = Object.freeze(
  Object.fromEntries(
    Object.values(AVATAR_FILES).map(name => [name, { rel: `assets/avatar/${name}`, mime: 'image/webp' }]),
  ),
)

/**
 * 解析包根目录下的资产绝对路径。
 *
 * 兼容两种产物形态（与 src/fonts/index.ts、src/shot/renderer.ts 同一套约定）：
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

function assetPath(name: string): string | null {
  if (!resolved.has(name)) resolved.set(name, resolveAsset(AVATAR_ASSETS[name]!.rel))
  return resolved.get(name) ?? null
}

/**
 * 注册头像动图路由（在已注入 webServer 的子上下文中调用）。
 *
 * 用 kind: 'prefix' 一次挂住整个前缀，内部按精确文件名分发；未知文件名一律
 * 404，绝不回落到「读任意路径」。
 * @param webCtx - webServer 服务已就绪的插件上下文。
 */
export function applyAvatarRoutes(webCtx: Record<string, any>): void {
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'prefix',
    path: AVATAR_ROUTE,
    handler: (req: any, res: any) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const name = decodeURIComponent(url.pathname.slice(AVATAR_ROUTE.length).replace(/^\/+/, ''))
      const entry = AVATAR_ASSETS[name]
      if (entry === undefined) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'unknown avatar asset' }))
        return
      }
      const path = assetPath(name)
      if (path === null) {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'avatar asset missing from package' }))
        return
      }
      let size: number
      try {
        size = statSync(path).size
      } catch {
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'avatar asset unreadable' }))
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
  }), 'dsh-seeker-bot: avatar asset route')
}
