/**
 * 群聊「谁该接话」的回归测试（纯判据 + 装配静态断言）。
 *
 * ## 为什么必须有这一组
 *
 * 判定逻辑原来是 `value.includes(bot.name)`——正文里任何位置出现成员名都算点名。
 * 它**永远不抛错**，出问题时界面上只是「叫错了人 / 叫多了一个人 / 被叫的人不回」，
 * 没有一条日志、没有一个红叉。这类判据只能靠测试钉住。
 *
 * 断言分两半：
 *  1. `resolveRoomTrigger` 的判定结果（点名 / 广播 / 委托 / 兜底 / 上限溢出）；
 *  2. store.tsx 的装配是否真的用上了它（并保留了「溢出要说出来」这条提示）。
 *     判据抽出去只完成一半工作：调用方忘了接，等于什么都没改。
 *
 * Usage: node scripts/test-room-trigger.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const toUrl = (rel) => new URL(rel, 'file:///' + ROOT.replace(/\\/g, '/') + '/').href
const { resolveRoomTrigger } = await import(toUrl('src/client/personal/room-trigger.ts'))
const { shouldStartNext } = await import(toUrl('src/client/personal/room-queue.ts'))

let failures = 0
function check(label, condition, detail) {
  if (condition) { console.log('  ok   ' + label); return }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
}

/** 判定结果的简写：`kind:名字,名字`，溢出用 `>` 标出。 */
const brief = (result) => result.kind + ':' + result.responders.map((item) => item.name).join(',')
  + (result.overflow.length > 0 ? ' >' + result.overflow.map((item) => item.name).join(',') : '')

const XIAOMO = { id: 'bot-xm', name: '小墨' }
const XIAOMO_PLUS = { id: 'bot-xmp', name: '小墨助手' }
const AQI = { id: 'bot-aq', name: '阿七' }
const LAOW = { id: 'bot-lw', name: '老吴' }
const TEAM = [XIAOMO, AQI, LAOW]

console.log('[room-trigger] 结构化 @ 点名')
{
  const one = resolveRoomTrigger({ text: '@小墨 看下这个报错', members: TEAM })
  check('@ 只叫被点名的那一个', brief(one) === 'mention:小墨', brief(one))

  const two = resolveRoomTrigger({ text: '@阿七 @小墨 你们各给一版', members: TEAM })
  check('多个 @ 按点名顺序', brief(two) === 'mention:阿七,小墨', brief(two))

  const dup = resolveRoomTrigger({ text: '@小墨 看看 @小墨 再看', members: TEAM })
  check('同一个成员被 @ 两次只起一轮', brief(dup) === 'mention:小墨', brief(dup))

  const fullWidth = resolveRoomTrigger({ text: '＠小墨 在吗', members: TEAM })
  check('全角 ＠ 也认', brief(fullWidth) === 'mention:小墨', brief(fullWidth))
}

console.log('[room-trigger] 引用某条 Bot 消息 = 定向给它')
{
  const quoted = resolveRoomTrigger({ text: '这里再补一句', members: TEAM, quotedBotId: 'bot-aq' })
  check('引用谁就只叫谁', brief(quoted) === 'quote:阿七', brief(quoted))

  const quotedVsAt = resolveRoomTrigger({ text: '@小墨 你看', members: TEAM, quotedBotId: 'bot-aq' })
  check('引用与 @ 同时出现时以 @ 为准', brief(quotedVsAt) === 'mention:小墨', brief(quotedVsAt))

  const quotedVsDelegate = resolveRoomTrigger({ text: '让小墨看一下', members: TEAM, quotedBotId: 'bot-aq' })
  check('引用优先于文本推断的委托', brief(quotedVsDelegate) === 'quote:阿七', brief(quotedVsDelegate))

  const gone = resolveRoomTrigger({ text: '这里再补一句', members: TEAM, quotedBotId: 'bot-gone' })
  check('被引用的人已退群 → 按没引用处理（兜底群主）', brief(gone) === 'admin:小墨', brief(gone))

  const quotedBroadcast = resolveRoomTrigger({ text: '@所有人 报进度', members: TEAM, quotedBotId: 'bot-aq' })
  check('广播优先于引用', brief(quotedBroadcast) === 'all:小墨,阿七,老吴', brief(quotedBroadcast))
}

console.log('[room-trigger] 正文提到名字 ≠ 点名（原 bug 本体）')
{
  const quoted = resolveRoomTrigger({ text: '我记得小墨说过这个问题', members: TEAM })
  check('正文提到名字不叫人（叫群主兜底）', brief(quoted) === 'admin:小墨', brief(quoted))

  const email = resolveRoomTrigger({ text: '发给 user@example.com 就行', members: [{ id: 'x', name: 'example.com' }, ...TEAM] })
  check('邮箱里的 @ 不命中成员', email.kind === 'admin' && email.responders.length === 1, brief(email))

  const scale = resolveRoomTrigger({ text: '图标要 @2x 的', members: [{ id: 'x', name: '2x' }, ...TEAM] })
  check('@2x 这类写法不命中成员', scale.kind === 'admin', brief(scale))
}

console.log('[room-trigger] 成员名互为子串')
{
  const longer = resolveRoomTrigger({ text: '@小墨助手 来一下', members: [XIAOMO, XIAOMO_PLUS] })
  check('最长优先：@小墨助手 只命中后者', brief(longer) === 'mention:小墨助手', brief(longer))

  const shorter = resolveRoomTrigger({ text: '@小墨 来一下', members: [XIAOMO, XIAOMO_PLUS] })
  check('@小墨 只命中短名，不连带长名', brief(shorter) === 'mention:小墨', brief(shorter))
}

console.log('[room-trigger] 广播')
{
  const all = resolveRoomTrigger({ text: '@所有人 各报一下进度', members: TEAM })
  check('@所有人 叫全员', brief(all) === 'all:小墨,阿七,老吴', brief(all))

  const bare = resolveRoomTrigger({ text: '所有人都看得出来这个方案有问题', members: TEAM })
  check('正文里的「所有人」不算广播', bare.kind === 'admin', brief(bare))
}

console.log('[room-trigger] 委托意图')
{
  const delegate = resolveRoomTrigger({ text: '让小墨看一下这段日志', members: TEAM })
  check('「让X」命中 X', brief(delegate) === 'delegate:小墨', brief(delegate))

  const noName = resolveRoomTrigger({ text: '我请了半天假，下午再说', members: TEAM })
  check('只有委托词、没有成员名 → 兜底', noName.kind === 'admin', brief(noName))

  const relayed = resolveRoomTrigger({ text: '我让小墨的同事看一下这件事', members: TEAM })
  check('转述（让小墨的…）不算点名', relayed.kind === 'admin', brief(relayed))

  const later = resolveRoomTrigger({ text: '我让小墨的同事看一下，让小墨自己来定', members: TEAM })
  check('前一处是转述、后一处才是真委托：仍然命中', brief(later) === 'delegate:小墨', brief(later))
}

console.log('[room-trigger] 兜底与边界')
{
  const plain = resolveRoomTrigger({ text: '这个方案怎么落地？', members: TEAM })
  check('没有点名 → 只有群主兜底', brief(plain) === 'admin:小墨', brief(plain))

  const explicitAdmin = resolveRoomTrigger({ text: '这个方案怎么落地？', members: TEAM, adminId: 'bot-aq' })
  check('adminId 可指定群主', brief(explicitAdmin) === 'admin:阿七', brief(explicitAdmin))

  const empty = resolveRoomTrigger({ text: '@小墨 在吗', members: [] })
  check('群里没有成员 → 空 responders（调用方必须提示）', empty.responders.length === 0 && empty.overflow.length === 0, brief(empty))

  const blank = resolveRoomTrigger({ text: '', members: TEAM })
  check('空正文 → 群主兜底', brief(blank) === 'admin:小墨', brief(blank))

  const namedWithSpace = resolveRoomTrigger({ text: '@ 小墨 看看', members: TEAM })
  check('@ 与名字之间隔空格不算点名（避免误判）', namedWithSpace.kind === 'admin', brief(namedWithSpace))
}

console.log('[room-trigger] 点名上限与溢出')
{
  const four = resolveRoomTrigger({ text: '@小墨 @阿七 @老吴 @小墨助手 都说一句', members: [XIAOMO, AQI, LAOW, XIAOMO_PLUS] })
  check('超过上限时只起前 3 轮', four.responders.length === 3, String(four.responders.length))
  check('被挤掉的成员进 overflow（不能静默丢弃）', four.overflow.length === 1 && four.overflow[0].name === '小墨助手', brief(four))

  const raised = resolveRoomTrigger({ text: '@小墨 @阿七 @老吴 都说一句', members: TEAM, mentionLimit: 5 })
  check('上限可调高', raised.responders.length === 3 && raised.overflow.length === 0, brief(raised))
}

console.log('[room-trigger] 成员排队判据（谁该开口）')
{
  const T = 180_000
  /** 简写：p=上一位已启动, c=上一位已取消, r=上一位还在跑, e=已等多久 */
  const decide = (p, c, r, e) => shouldStartNext({ previousStarted: p, previousCancelled: c, previousRunning: r, elapsedMs: e, timeoutMs: T })

  check('上一位还没启动、也没取消 → 必须继续等（第三位插队的 bug）', decide(false, false, false, 0) === 'wait')
  check('上一位还没启动、等到超时 → 放行', decide(false, false, false, T) === 'start')
  check('上一位没启动但已被取消 → 立即放行，不必陪等', decide(false, true, false, 0) === 'start')
  check('上一位还在跑 → 等', decide(true, false, true, 0) === 'wait')
  check('上一位还在跑、等到超时 → 放行', decide(true, false, true, T) === 'start')
  check('上一位已经跑完 → 放行', decide(true, false, false, 0) === 'start')
  check('上一位跑完又被取消 → 放行', decide(true, true, false, 0) === 'start')
}

console.log('[room-trigger] store.tsx 装配')
{
  const src = readFileSync(resolve(ROOT, 'src/client/personal/store.tsx'), 'utf8')
  check('引入判定模块', src.includes("from './room-trigger.ts'"))
  check('群聊分支调用 resolveRoomTrigger', src.includes('resolveRoomTrigger('))
  check('不再用 includes 判定点名', !src.includes('value.includes(item.name)') && !src.includes('value.includes(`@${item.name}`)'))
  check('溢出会以 toast 说出来', src.includes('trigger.overflow.length > 0') && src.includes('这次没接'))
  check('群里没成员时提示而不是静默', src.includes('这个群里没有可回复的成员'))
  check('引用某条 Bot 消息会定向给它', src.includes('quotedBotId'))
  check('群聊回合构造本群历史（按 roomId 过滤）', src.includes('msg.roomId === opts.roomId'))
  check('群历史排除本轮这条', src.includes('msg.id !== opts.userMessageId'))
  check('群历史带发言者名字', src.includes('msg.senderName ?? bot.name'))
  check('停止键把没启动的成员数量说出来', src.includes('还没开始接话的成员'))
  check('成员等前一位收口再启动（不是固定错峰）', src.includes('shouldStartNext(') && !src.includes('300 + index * 700'))
  check('排队判据来自纯函数模块', src.includes("from './room-queue.ts'"))
  check('串行等待有超时兜底', src.includes('SERIAL_WAIT_TIMEOUT_MS'))
}

console.log('[room-trigger] 群聊「全组统一模型」贯通')
{
  const src = readFileSync(resolve(ROOT, 'src/client/personal/store.tsx'), 'utf8')
  check('请求体按 unifiedModel 覆盖 bot.model', src.includes('const model = opts.unifiedModel ?? bot.model'))
  check('请求体带 roomId', src.includes('opts.roomId !== undefined ? { roomId: opts.roomId }'))
  check('replyAsBot 按群设置解析统一模型', src.includes("room.modelMode !== 'unified'"))
  check('流式调用把 opts 传下去', src.includes('stopController.signal, requestOpts)'))
}

console.log('[room-trigger] 清空私聊不删群消息')
{
  const src = readFileSync(resolve(ROOT, 'src/client/personal/store.tsx'), 'utf8')
  check('清空按 roomId 保留群消息', src.includes('message.roomId !== undefined') && src.includes('message.botId !== botId && message.senderId !== botId'))
}

if (failures > 0) {
  console.error('\n[room-trigger] ' + failures + ' 项失败')
  process.exit(1)
}
console.log('\n[room-trigger] 全部通过')
