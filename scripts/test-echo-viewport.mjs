/**
 * dsh-seeker-bot — 操作面板工作空间实时回显（space-frame）契约测试。
 *
 * 覆盖三块：
 *  1. 纯函数：工作空间线索提取 / 空间选择（错了不会抛错，只会错显或该显示时不显示）；
 *  2. 路由：会话绑定、跨会话隔离、空间关闭后隐藏；
 *  3. 产物：lib/index.js 必须导出 host/客户端需要的符号。
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const toUrl = (rel) => new URL(rel, 'file:///' + ROOT.replace(/\\/g, '/') + '/').href

const {
  ECHO_VIEWPORT_FRAME_ROUTE,
  ECHO_VIEWPORT_SPACE_ROUTE,
  handleEchoViewportFrameRoute,
  handleEchoViewportSpaceRoute,
  pickWorkspaceSpace,
  extractWorkspaceHints,
  WorkspaceLink,
  resetWorkspaceBindings,
} = await import(toUrl('src/echo-viewport/index.ts'))

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
}

function mockReqRes(route, method = 'GET', query = '', headers = { host: '127.0.0.1:3080' }) {
  let status = 200
  let resHeaders = {}
  let body = ''
  return {
    req: {
      method,
      url: `${route}${query ? '?' + query : ''}`,
      headers,
    },
    res: {
      writeHead(s, h) { status = s; resHeaders = h },
      setHeader(k, v) { resHeaders[k] = v },
      end(b) { body = b },
    },
    getResult() {
      let data = {}
      try { data = JSON.parse(body || '{}') } catch {}
      return { status, headers: resHeaders, data }
    },
  }
}

const userSpace = {
  id: 0, name: '', taskId: '', createdBy: 'user', ownership: 'user', recentTabTitles: ['magpie'],
}
const taobaoSpace = {
  id: 6, name: 'taobao', taskId: 'taobao', createdBy: 'agent', ownership: 'agent', recentTabTitles: ['淘宝'],
}
const aliyunSpace = {
  id: 7, name: 'aliyun', taskId: 'aliyun', createdBy: 'agent', ownership: 'agent', recentTabTitles: ['阿里云'],
}

console.log('[echo-viewport] 工作空间线索提取')
{
  check('taskSpace("taobao") 提取名称', extractWorkspaceHints('const task = await taskSpace("taobao")').includes('taobao'))
  check('转义引号也能提取', extractWorkspaceHints('taskSpace(\\"taobao\\")').includes('taobao'))
  check('claimTaskSpace(6) 提取 id', extractWorkspaceHints('await claimTaskSpace(6)').includes('6'))
  check('JSON spaceId 提取 id', extractWorkspaceHints('{"spaceId":6}').includes('6'))
  check('无线索返回空数组', extractWorkspaceHints('普通文本，没有任务空间').length === 0)

  const link = new WorkspaceLink()
  link.remember('session-a', 'await taskSpace("taobao")')
  check('WorkspaceLink 按会话记线索', link.hintsOf('session-a').includes('taobao'))
  check('WorkspaceLink 不串会话', link.hintsOf('session-b').length === 0)
  link.forget('session-a')
  check('WorkspaceLink forget 生效', link.hintsOf('session-a').length === 0)
  link.dispose()
}

console.log('[echo-viewport] 工作空间选择（纯函数）')
{
  const all = [userSpace, taobaoSpace, aliyunSpace]
  check('user space 不参与回显', pickWorkspaceSpace([userSpace], ['magpie']) === null)
  const byName = pickWorkspaceSpace(all, ['aliyun'])
  check('按名称精确匹配', byName !== null && byName.space.id === 7)
  const byTitle = pickWorkspaceSpace(all, ['淘宝'])
  check('按最近标签标题匹配', byTitle !== null && byTitle.space.id === 6)
  const byId = pickWorkspaceSpace(all, ['6'])
  check('按数字 id 匹配', byId !== null && byId.space.id === 6)
  const latest = pickWorkspaceSpace(all, ['taobao', 'aliyun'])
  check('同一会话多个工作空间时优先最新的', latest !== null && latest.space.id === 7)
  check('多个空间无线索时不猜', pickWorkspaceSpace(all, []) === null)
  const single = pickWorkspaceSpace([userSpace, taobaoSpace], [])
  check('唯一 agent 空间可识别', single !== null && single.space.id === 6 && single.matchedBy === 'single')
  const unknown = pickWorkspaceSpace(all, ['不存在的任务'])
  check('线索对不上时不猜', unknown === null)
}

console.log('[echo-viewport] 路由基础契约')
{
  check('space 路由常量路径正确', ECHO_VIEWPORT_SPACE_ROUTE === '/api/chat-flow/echo-viewport/space-frame')
  check('旧 frame 路由仍存在', ECHO_VIEWPORT_FRAME_ROUTE === '/api/chat-flow/echo-viewport/frame')

  const postCtx = mockReqRes(ECHO_VIEWPORT_SPACE_ROUTE, 'POST')
  await handleEchoViewportSpaceRoute(postCtx.req, postCtx.res, {
    listSpaces: async () => [], capture: async () => null, hintsOf: () => [],
  })
  check('POST 请求返回 405', postCtx.getResult().status === 405)

  const csrfCtx = mockReqRes(ECHO_VIEWPORT_SPACE_ROUTE, 'GET', '', {
    host: '127.0.0.1:3080', origin: 'http://malicious-website.com',
  })
  await handleEchoViewportSpaceRoute(csrfCtx.req, csrfCtx.res, {
    listSpaces: async () => [], capture: async () => null, hintsOf: () => [],
  })
  const csrfRes = csrfCtx.getResult()
  check('恶意跨站来源被拒绝', csrfRes.status === 403 || csrfRes.data.ok === false)
}

console.log('[echo-viewport] 路由会话关联与空间生命周期')
{
  resetWorkspaceBindings()
  let spaces = [userSpace, taobaoSpace]
  const deps = {
    listSpaces: async () => spaces,
    capture: async (spaceId, maxW) => ({
      ok: true, spaceId, name: 'taobao', title: '淘宝', url: 'https://www.taobao.com',
      w: Math.round(maxW), h: 250, data: 'AAAA',
    }),
    hintsOf: (sessionId) => (sessionId === 'session-hint' ? ['taobao'] : []),
  }

  // 1. 服务端记住的会话线索 → 找到 taobao 空间
  const hintCtx = mockReqRes(ECHO_VIEWPORT_SPACE_ROUTE, 'GET', 'session=session-hint&maxW=400')
  await handleEchoViewportSpaceRoute(hintCtx.req, hintCtx.res, deps)
  const hintRes = hintCtx.getResult()
  check('会话线索命中工作空间', hintRes.data.ok === true && hintRes.data.spaceId === 6)
  check('返回 base64 画面', typeof hintRes.data.data === 'string' && hintRes.data.data.length > 0)

  // 2. 同一会话后续请求没有 hint 也应命中已绑定空间
  const boundCtx = mockReqRes(ECHO_VIEWPORT_SPACE_ROUTE, 'GET', 'session=session-hint')
  await handleEchoViewportSpaceRoute(boundCtx.req, boundCtx.res, deps)
  check('会话绑定持久生效', boundCtx.getResult().data.ok === true)

  // 3. 其他会话不能抢同一个空间
  const otherCtx = mockReqRes(ECHO_VIEWPORT_SPACE_ROUTE, 'GET', 'session=session-other&hint=taobao')
  await handleEchoViewportSpaceRoute(otherCtx.req, otherCtx.res, deps)
  check('跨会话不抢同一空间', otherCtx.getResult().data.ok === false)

  // 4. 工作空间关闭（finish）后 → 绑定失效且不显示
  spaces = [userSpace]
  const closedCtx = mockReqRes(ECHO_VIEWPORT_SPACE_ROUTE, 'GET', 'session=session-hint')
  await handleEchoViewportSpaceRoute(closedCtx.req, closedCtx.res, deps)
  const closedRes = closedCtx.getResult()
  check('空间关闭后返回 no-workspace', closedRes.data.ok === false && closedRes.data.code === 'no-workspace')

  // 5. 没有 agent 空间的普通会话 → 不显示
  const noneCtx = mockReqRes(ECHO_VIEWPORT_SPACE_ROUTE, 'GET', 'session=session-none')
  await handleEchoViewportSpaceRoute(noneCtx.req, noneCtx.res, deps)
  check('普通会话不显示回显', noneCtx.getResult().data.ok === false)

  // 6. 捕获失败 → 明确失败态，客户端会隐藏
  resetWorkspaceBindings()
  spaces = [userSpace, taobaoSpace]
  const failCtx = mockReqRes(ECHO_VIEWPORT_SPACE_ROUTE, 'GET', 'session=session-fail&hint=taobao')
  await handleEchoViewportSpaceRoute(failCtx.req, failCtx.res, {
    ...deps, capture: async () => null,
  })
  check('抓帧失败返回 capture-failed', failCtx.getResult().data.code === 'capture-failed')
}

console.log('[echo-viewport] 旧窗口抓帧路由（兼容）')
{
  const notFoundCtx = mockReqRes(ECHO_VIEWPORT_FRAME_ROUTE, 'GET', 'process=absolutely_non_existent_process_xyz_999')
  await handleEchoViewportFrameRoute(notFoundCtx.req, notFoundCtx.res)
  const notFoundRes = notFoundCtx.getResult()
  check('不存在的进程返回 ok: false', notFoundRes.data.ok === false)
}

console.log('[echo-viewport] 产物打包验证')
{
  const { existsSync } = await import('node:fs')
  check('lib/client.js 产物文件存在', existsSync(resolve(ROOT, 'lib/client.js')))
  check('lib/index.js 产物文件存在', existsSync(resolve(ROOT, 'lib/index.js')))

  const hostMod = await import(toUrl('lib/index.js'))
  check('host 产物导出 applyEchoViewport', typeof hostMod.applyEchoViewport === 'function')
  check('host 产物导出 handleEchoViewportSpaceRoute', typeof hostMod.handleEchoViewportSpaceRoute === 'function')
  check('host 产物导出 ECHO_VIEWPORT_SPACE_ROUTE', hostMod.ECHO_VIEWPORT_SPACE_ROUTE === '/api/chat-flow/echo-viewport/space-frame')
  check('host 产物导出 pickWorkspaceSpace', typeof hostMod.pickWorkspaceSpace === 'function')
}

if (failures > 0) {
  console.error(`\n${failures} tests failed.`)
  process.exit(1)
} else {
  console.log('\nAll echo-viewport tests passed.')
}
