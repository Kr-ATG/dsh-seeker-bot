/**
 * dsh-seeker-bot — Bot 领域聚合入口（host 半身）。
 *
 * src/host.ts 只依赖 applyBotHost；其余模块的纯函数与状态操作通过 __test 暴露，
 * 供 scripts/test-bot-host.mjs 用桩 ctx + 真 HTTP 直接对拍。
 */

export { applyBotHost } from './routes.js'

import * as state from './state.js'
import * as sessions from './sessions.js'
import * as prompt from './prompt.js'
import * as models from './models.js'
import * as routines from './routines.js'
import * as proactive from './proactive.js'
import * as groups from './groups.js'

export const __test = { state, sessions, prompt, models, routines, proactive, groups }
