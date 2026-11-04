/**
 * dsh-seeker-bot — 撤回 client 半身入口（vendor 移植自 dsh-recall-plugin，MIT）
 *
 * 为什么改成普通模块导出，而不是参考插件那套 window.__ModuleLoader__.load({id, factory})：
 * dsh-recall-plugin 是独立插件包，它的 client 半身由宿主的模块加载器单独装载；
 * 本仓库只有一个 client bundle（lib/client.js，id = 'dsh-seeker-bot'），宿主装载的
 * 是「我们的」factory。参考插件的注册在这里没有调用方——留着只会变成一次指向
 * 不存在 loader 的调用（loader 未就绪时还会直接抛错），所以对外入口改为
 * applyRecallClient(ctx)，由 src/client/index.ts 在 ctx.inject 延迟注入后调用。
 *
 * React 为什么用 import 而不是 require：bundle 的 banner（见 build.mjs）已经把
 * 平台模块表封装成 module 作用域的 require，react 家族又被标成 external，于是
 * 本文件的 import React from 'react' 在产物里就是 require('react')。这里刻意
 * 不新增任何 @deepseek-ai/* 依赖：撤回半身只消费宿主 ctx 上已注入的服务。
 *
 * 服务缺失 / 装配期异常的降级边界：
 * - 缺服务：调用方用 ctx.inject([...], cb) 延迟注入，cordis 保证 cb 只在声明服务
 *   齐备时执行；app.ts 内部每个 slot 注册另有 try/catch（单侧失败不牵连同槽）。
 * - 装配期抛错：入口再兜一层 try/catch 并记日志（appLog.error，error 级恒输出），
 *   绝不让异常冒泡到插件总 apply —— 否则「撤回」坏掉会顺带拖垮 seeker-bot 的
 *   思考折叠 / 卡片 / 截图等全部功能。
 */

import React from 'react'
import { createApp } from './app.js'
import { appLog } from './log.js'

/**
 * 把撤回能力挂到宿主 client context 上。
 *
 * @param ctx 经 ctx.inject 延迟注入后的 cordis 子 scope（slots / sessions /
 *   workspaces / uiWorkspace / timer 已就位）。类型取 any 的「为什么」：调用方
 *   拿到的是 cordis 的子 scope context，与参考插件自己声明的 ClientContext 不是
 *   同一个类型身份，强类型会在调用点制造一条无意义的断言（服务面的真实形状仍
 *   由 app.ts 的 ClientContext 约束，入口只负责转交）。
 */
export function applyRecallClient(ctx: any): void {
  try {
    createApp(React)(ctx)
  } catch (error) {
    // 只记日志不重抛：撤回半身是增强功能，坏了不能连坐整个 bundle
    appLog.error('client apply failed:', error)
  }
}
