/**
 * 搜索后端的取消语义共享叶（`anysearch-auto` 链上每一环都遵守同一套约定）。
 *
 * 为什么单独成文件：`WebSearchProvider.search(request, signal)` 的取消契约是
 * 「调用方 abort 时必须以 `WEB_ABORTED` 退出，不得算成 provider 故障」。链一旦
 * 把取消误判为失败，就会在用户停止生成后继续往下几家猛打请求，既烧额度又产生
 * 无人认领的结果。三份等价实现必然写歪，所以只留一份。
 *
 * `abortable` 的作用是让「同进程内的异步前置步骤」（凭据解析）也能被外层取消：
 * `fetch` 自带 `signal`，而凭据服务返回的 Promise 不理会取消，必须手动竞速。
 * 结算回调在 abort 后仍继续观察原 Promise，避免它稍后 reject 变成 unhandled。
 * @module dsh-provider-hub/web-search-abort
 */

import { WebError } from '../vendor/error.ts'

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
export function searchAborted(name: string, signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError(`${name} search aborted`, 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
export function throwIfSearchAborted(name: string, signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(name, signal)
}

/**
 * Race a same-process asynchronous preflight against caller cancellation.
 * @param name - provider 名，用于取消消息（保持各环消息可辨识）。
 * @param operation - 待观察的 Promise。
 * @param signal - 外层搜索的取消信号。
 * @returns operation 的结果。
 * @throws `WEB_ABORTED` when cancelled, or the operation's own rejection.
 */
export function abortable<T>(name: string, operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(name, signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(name, signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}
