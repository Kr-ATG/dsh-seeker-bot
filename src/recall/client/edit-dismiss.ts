/**
 * dsh-recall-plugin — 就地编辑的取消出口（Esc）
 *
 * 编辑态不搬动输入框：底部官方 composer 原样留在原位，只换了草稿内容。于是
 * 「点空白处取消」不再合适——点消息、滚列表、开侧栏都是正常操作，不该丢弃
 * 正在编辑的消息文本。唯一明确的放弃信号是 Esc。
 *
 * Esc 先看弹层：`/` 与 `@` 菜单打开时归官方处理（它自己关菜单），插件抢走会
 * 变成「菜单没关反而退出编辑」。
 *
 * 独立成模块：选择器与事件阶段这类宿主契约集中一处，配一个 Disposer 便于
 * 卸载清理；节点组件里只留一行 effect。
 */

export interface EditDismissOptions {
  /** 该选择器存在时把 Esc 让给官方（弹层打开中） */
  popupSelector: string
  onDismiss(): void
}

/** 安装捕获阶段的 Esc 监听；返回幂等的卸载函数。 */
export function installEditDismiss(doc: Document, opts: EditDismissOptions): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (opts.popupSelector !== '' && doc.querySelector(opts.popupSelector) !== null) return
    event.preventDefault()
    event.stopPropagation()
    opts.onDismiss()
  }
  doc.addEventListener('keydown', onKeyDown, true)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    doc.removeEventListener('keydown', onKeyDown, true)
  }
}
