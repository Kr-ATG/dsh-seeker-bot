/**
 * dsh-recall-plugin — client 命名空间 logger（A5）
 *
 * 替代 client 裸 console.*：error/warn 恒输出（用户可见降级路径的最低诊断
 * 保底），info/debug 由 localStorage 开关按命名空间过滤——用户现场排查只需
 * 在控制台贴一行 `localStorage.setItem('dsh-recall.debug','*')`，改开关即生效
 * （每次调用重读），无需重启。对齐同类插件的 client logger 设计。
 * 纯模块级导出、零模块级可变状态（HMR 假设：卸载重载后行为只取决于
 * localStorage 现值，不存在跨实例残留；预建实例是不可变常量）。
 */

// localStorage 直读封装：每次调用重读（改开关即生效），整体 try/catch——
// 隐私模式 / jsdom 测试环境 / 嵌入式 webview 可能抛 SecurityError 或根本没有
// localStorage，此时静默降级为「只出 error/warn」，绝不因日志而崩插件。
function debugFlag(): string {
  try {
    return String(localStorage.getItem('dsh-recall.debug') || '')
  } catch (error) {
    return ''
  }
}

// ns 在开关值中的命中判定：'*' 全开；逗号分隔列表按 trim 后精确匹配；
// 空串/未命中都不出。每次调用重算（配合 debugFlag 的每次重读，改开关即生效）。
function debugEnabled(ns: string): boolean {
  const raw = debugFlag()
  if (!raw) return false
  for (const part of raw.split(',')) {
    const t = part.trim()
    if (t === '*' || t === ns) return true
  }
  return false
}

export interface ClientLogger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

// 命名空间 logger：前缀 [dsh-recall:<ns>] 便于控制台过滤。error/warn 恒输出
// （降级路径的最低保底，与替换前行为一致）；info/debug 仅在开关命中时输出，
// 生产默认静默——不给用户控制台刷噪音。
export function createLogger(ns: string): ClientLogger {
  const prefix = '[dsh-recall:' + ns + ']'
  return {
    error: (...args) => { console.error(prefix, ...args) },
    warn: (...args) => { console.warn(prefix, ...args) },
    info: (...args) => { if (debugEnabled(ns)) console.info(prefix, ...args) },
    debug: (...args) => { if (debugEnabled(ns)) console.debug(prefix, ...args) },
  }
}

// 预建实例：命名空间固定（装配层 / 撤回节点各一），避免调用点重复建对象
export const appLog = createLogger('app')
export const recallNodeLog = createLogger('recall-node')