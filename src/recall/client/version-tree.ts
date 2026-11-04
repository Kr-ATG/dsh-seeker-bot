/**
 * 版本家族（‹ X/N › 翻页器的数据源）
 *
 * 每次「撤回 / 编辑重发」都会 fork 出新会话，同一段对话因此有几个真实会话
 * 版本。host 侧 lineage.json 已有这条链，但客户端要即时渲染翻页器、读不到
 * 磁盘；这里在 fork 成功那一刻把「家族根 → 成员」写进 localStorage。它是
 * 纯增量 UI 数据：丢了只影响翻页器，会话与快照本身不受影响。
 *
 * 为什么不用 sessions.fork 的返回自己算树：fork 只给 childId，家族根需要
 * 追溯整条链；localStorage 里按根聚合能直接得到顺序与下标。
 */

const KEY_PREFIX = 'dsh-recall:versions:'

export interface VersionFamily {
  rootId: string
  // [根, v2, v3…]，按 fork 产生顺序排列，即翻页器的 1..N
  ids: string[]
  // 当前会话在 ids 里的下标（-1 表示不在家族内）
  index: number
}

// 当前正在看的会话：assistant-actions 槽只给 messageId，拿不到 sessionId，
// 由消息节点在渲染时写入（同一列表里最后渲染的即当前会话）。渲染期赋值是
// 刻意的——pager 在同一次提交中后渲染，读到的必然是当前会话。
export const activeSession = { id: '' }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch (e) {
    return null
  }
}

function readIds(rootId: string): string[] {
  const store = storage()
  if (!store || !rootId) return []
  try {
    const raw = store.getItem(KEY_PREFIX + rootId)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id !== '') : []
  } catch (e) {
    return []
  }
}

function writeIds(rootId: string, ids: string[]): void {
  const store = storage()
  if (!store || !rootId) return
  try {
    store.setItem(KEY_PREFIX + rootId, JSON.stringify(ids))
  } catch (e) { /* 配额满/隐私模式：翻页器降级为不显示，不影响主链 */ }
}

// 线性扫描全部家族键：家族数量等于「本机用过的撤回/编辑次数」，量级很小，
// 不值得为它再维护一张 sessionId → rootId 的反查表
function findRootOf(sessionId: string): string | null {
  const store = storage()
  if (!store || !sessionId) return null
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (!key || !key.startsWith(KEY_PREFIX)) continue
    const rootId = key.slice(KEY_PREFIX.length)
    if (readIds(rootId).indexOf(sessionId) >= 0) return rootId
  }
  return null
}

export function familyOf(sessionId: string | null | undefined): VersionFamily | null {
  const id = String(sessionId || '')
  if (!id) return null
  const rootId = findRootOf(id)
  if (!rootId) return null
  const ids = readIds(rootId)
  const index = ids.indexOf(id)
  if (index < 0 || ids.length < 2) return null
  return { rootId, ids, index }
}

/**
 * 登记一次 fork：parentId 是刚被回退的会话，childId 是新会话。
 * 幂等——同一对父子重复登记不会产生重复成员（重试/重复提交）。
 */
export function recordVersion(parentId: string, childId: string): void {
  const parent = String(parentId || '')
  const child = String(childId || '')
  if (!parent || !child || parent === child) return
  const rootId = findRootOf(parent) || parent
  const ids = readIds(rootId)
  const next = ids.length === 0 ? [parent] : ids.slice()
  if (next.indexOf(child) >= 0) return
  // 新版本总是接在末尾：撤回/编辑只会把「当前版本」再往后推一格
  next.push(child)
  writeIds(rootId, next)
}
