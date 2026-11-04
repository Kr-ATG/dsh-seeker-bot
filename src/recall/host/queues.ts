/**
 * dsh-recall-plugin — 按工作区隔离的任务队列（工厂，无模块级状态）
 *
 * 为什么按 root 分链：一条消息的快照可能要跑几十秒（大工作区首拍，或慢盘），
 * 此前全局单链会让**所有会话**的新快照排在它后面——别的项目连撤回按钮都
 * 出不来。同一 root 必须串行（快照/preview/回滚/删除都在写同一个 git index，
 * 并发就是 index.lock 竞态）；不同 root 之间没有共享写面，天然可以并行。
 *
 * key 归一：win32 路径大小写不敏感，同一仓库不能因 root 写法不同拿到两把锁；
 * POSIX 保持原样（大小写敏感）。
 */

export interface QueuesApi {
  enqueueFor<T>(root: string | null | undefined, task: () => Promise<T>): Promise<T>
  enqueueMany<T>(roots: Array<string | null | undefined>, task: () => Promise<T>): Promise<T>
}

export function createQueues(isWin: boolean): QueuesApi {
  // key -> 该链的尾部。尾部恒为 catch 过的 promise：一次失败不能让整条链
  // 停在拒绝状态，后续任务只依赖排队关系、不依赖前一个任务的结果。
  const tails = new Map<string, Promise<void>>()

  const keyOf = (root: string | null | undefined): string => {
    const k = String(root == null ? '' : root)
    return k !== '' && isWin ? k.toLowerCase() : k
  }

  function tailFor(key: string): Promise<void> {
    return tails.get(key) || Promise.resolve()
  }

  function enqueueFor<T>(root: string | null | undefined, task: () => Promise<T>): Promise<T> {
    const key = keyOf(root)
    const run = tailFor(key).then(task)
    tails.set(key, run.catch(() => {}) as Promise<void>)
    return run
  }

  // 跨工作区操作（全量删除 / 全局 gc）：等这些 root 的链尾全部落地再执行，
  // 并把同一条链尾写回每个 key——与 per-root 任务互斥，又不阻塞无关 root。
  // 空集合退化为单条全局链（'' key），对应「没有 root 可用」的场景。
  function enqueueMany<T>(roots: Array<string | null | undefined>, task: () => Promise<T>): Promise<T> {
    const keys = Array.from(new Set(roots.map(keyOf)))
    if (keys.length === 0) keys.push('')
    const run = Promise.all(keys.map(tailFor)).then(task)
    const tail = run.catch(() => {}) as Promise<void>
    for (const key of keys) tails.set(key, tail)
    return run
  }

  return { enqueueFor, enqueueMany }
}
