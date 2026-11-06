/**
 * dsh-seeker-bot — 「思考自动翻译」偏好（纯客户端，localStorage）。
 *
 * 用户要求：思考过程**自动翻译**，不需要点按钮。
 *
 * 为什么走 localStorage 而不是 host 状态表：
 *  · 它是**纯客户端呈现偏好**，host 那头没有任何消费者；写进 host 只会让
 *    「换个观感」被迫等一次 DSH 重启；
 *  · 仓库里已有同款先例（reply-card-chrome / tool-calls-visible / kr-chat-store），
 *    同一套「读盘 + 订阅 + 落盘」形态，不引入第二种持久化范式。
 *
 * 默认**开**：用户明确要求的就是「不用点」。关掉后仍可手动点「查看译文」
 * ——两条路并存，不是二选一。
 *
 * 一个字都不进 prompt：它只决定「要不要把思考发给翻译服务」，与任何注入
 * 通道无关。
 */

/** localStorage 键（跨刷新保留）。 */
const STORAGE_KEY = 'dsh.chat_plus.auto_translate'

/** 当前值（true = 自动翻译）。 */
let enabled = true

/** 是否已初始化过（重入时只重读状态，不重复绑监听）。 */
let installed = false

/** 订阅者（组件用 useSyncExternalStore 接）。 */
const listeners = new Set<() => void>()

/**
 * 从 localStorage 读取（读不到 / 被禁用 → 保持默认 true）。
 *
 * 默认 true 的理由：用户明确要求「不用点」，升级不该把已经到手的自动翻译
 * 又变回要手动点。脏值（手工改坏）一律回默认。
 */
function readStored(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === '0') return false
    if (raw === '1') return true
    return true
  } catch {
    // 隐私模式 / 存储被禁时 getItem 会抛，读取失败按默认处理。
    return true
  }
}

/** 读当前值（useSyncExternalStore 的 getSnapshot）。 */
export function autoTranslateEnabled(): boolean {
  return enabled
}

/** 订阅变化（useSyncExternalStore 的 subscribe）。 */
export function subscribeAutoTranslate(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 写值：落盘 + 通知订阅者。 */
export function setAutoTranslateEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      // 落盘失败只影响「刷新后还记得吗」，本次会话内的行为照常生效 ——
      // 不因为存储不可用就把用户刚拨的开关弹回去。
    }
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('[auto-translate] listener error', error)
    }
  }
}

/**
 * 初始化：读盘 + 跟随别的窗口的改动。
 *
 * 在插件 apply 时调用一次（见 index.ts）。
 *
 * `storage` 事件只在**其它**窗口/标签页改动时触发，所以这里直接重读整份
 * 状态，不区分来源；同窗口的改动由 setAutoTranslateEnabled 自己广播。
 */
export function installAutoTranslate(): void {
  enabled = readStored()
  if (installed) return
  installed = true
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return
      const next = readStored()
      if (next === enabled) return
      enabled = next
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          console.error('[auto-translate] listener error', error)
        }
      }
    })
  }
}
