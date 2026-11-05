/**
 * dsh-seeker-bot — 卡头头像动图的状态与 URL 约定（host / client 共用的唯一真相）。
 *
 * 2026-11-05 用户要求把操作面板卡头的静态插件头像换成三张透明底 WebP 动图，
 * 按「此刻在做什么」切换：
 *
 *   · idle       —— 无动作（本轮没在跑；操作面板不显示额外文字，Hero 仍显示空闲文案）；
 *   · generating —— 调用生成类能力（生成图片 / 视频 / HTML / iu 卡片等）；
 *   · executing  —— 其余执行中（工具调用、思考中）。
 *
 * 为什么走 host 路由而不是内联 base64：三张动图合计约 2.5MB，内联进 client.js
 * 会让每个用户冷启动多下载一份巨大的 JS 字符串；走 /api/chat-flow/avatars/*
 * 后浏览器只在需要时按状态取图，并靠 immutable 缓存命中。
 *
 * 三个文件随包放在 assets/avatar/（package.json 的 files 已包含整个 assets 目录）。
 * 路由实现见 src/avatar/index.ts，客户端取 URL 见 src/client/kr-chat/brand-avatar.ts。
 *
 * @module
 */

/** 头像动图路由前缀（host 注册 / client 拼 URL 共用）。 */
export const AVATAR_ROUTE = '/api/chat-flow/avatars'

/** 卡头头像的三种状态。 */
export type SeekerAvatarState = 'idle' | 'generating' | 'executing'

/**
 * 状态 → 随包文件名。
 *
 * 文件名刻意保持稳定（不带 hash）：缓存键靠 {@link avatarUrl} 的版本参数区分，
 * 升级插件换图时改 {@link AVATAR_VERSION} 即可让浏览器重新取图。
 */
export const AVATAR_FILES: Readonly<Record<SeekerAvatarState, string>> = Object.freeze({
  idle: 'idle.webp',
  generating: 'generating.webp',
  executing: 'executing.webp',
})

/**
 * 头像动图版本号。
 *
 * 只在**图片内容变化**时改它（换一套立绘 / 重新压图）。它只参与 URL 的 query，
 * 不改变 host 的文件名表；host 路由按 pathname 分发、忽略 query。
 */
export const AVATAR_VERSION = '20261105'

/**
 * 某个状态的头像动图 URL（同源相对路径，浏览器按当前 host 解析）。
 *
 * @param state - 头像状态。
 * @param version - 缓存版本，默认 {@link AVATAR_VERSION}。
 * @returns 可直接塞给 img.src 的 URL。
 */
export function avatarUrl(state: SeekerAvatarState, version: string = AVATAR_VERSION): string {
  return `${AVATAR_ROUTE}/${AVATAR_FILES[state]}?v=${version}`
}
