/**
 * dsh-recall-plugin — 输入区回填（撤回回填 / 编辑重发的共用下半程）
 *
 * 把「文本 + 附件」写进目标会话的输入态；编辑重发再多一步：等附件也落进
 * 输入态后替用户按下发送。单独成模块的原因有二：两条入口必须共用同一条
 * 官方写入通道（各写一份必然漂移）；这条链路自带重试、附件异步完成与提交
 * 时序校验，混在节点组件里会把 UI 状态机与 I/O 搅拌在一起。
 */

import type { ClientContext, ConversationInputShell, ConversationService, DraftAttachmentDescriptor, ReadAttachmentResult, SessionAttachmentRef } from '../types/client-contract.js'
import { recallNodeLog } from './log.js'

// 被撤回消息里可回填为草稿附件的块引用：image / file 两类块都带 durable
// attachment 引用（{attachmentId, ...}）。
export interface DraftAttachmentRef {
  attachmentId: string
  name?: string
  // 块类型：编辑卡据此决定渲染缩略图（image）还是文件名 chip（file）
  kind?: 'image' | 'file'
  // 消息块里的原始 durable 引用对象（ImageAttachmentRef 形状）。新版
  // readAttachment 的入参；旧版忽略。丢了它就只能传裸 id，在 ≥0.2.2 上读不出来。
  attachment?: unknown
}

// 缺省附件文件名：媒体类型 → 「attachment-N.<subtype>」（image/png → png）。
// 官方 readAttachment 的元数据可能缺 name，此时按 mediaType 派生一个可读名。
export function defaultAttachmentName(mediaType: unknown, index: number): string {
  const text = String(mediaType || '')
  const slash = text.indexOf('/')
  const sub = (slash >= 0 ? text.slice(slash + 1) : text).replace(/[^a-z0-9.+-]/gi, '')
  return 'attachment-' + String(index + 1) + '.' + (sub || 'bin')
}

export interface DraftFillApi {
  fillDraft(targetSessionId: string, draftText: string, attachmentFiles: Promise<File[]> | null, opts?: { submit?: boolean }): void
  preloadAttachmentFiles(sourceSessionId: string, refs: DraftAttachmentRef[]): Promise<File[]>
}

// ctx 只用来探测 conversation 服务与 sessions 对象层：0.1.1-rc.2 无 conversation
// （不能进静态 inject），故一律走 ctx.get 而不是 ctx.conversation 属性访问。
export function buildDraftFill(ctx: ClientContext): DraftFillApi {
  // 撤回后把被撤回消息的文本与附件回填到输入框，方便用户修改后重新发送。
  // 官方 conversation 服务提供 input（InputHub）→ per-session shell → actions，
  // 走与输入框自身同一条官方写入通道。附件沿用官方 composer 的 addFiles 链路
  // （ui-conversation 实证）：sessions.binding 门禁 → session.readAttachment 取回
  // 字节 → conversation.createDrafts 注册草稿附件 → shell 的 addAttachments 进
  // 输入态（未接纳时 releaseDraftAttachments 释放）。fork + open 之后 shell /
  // binding 可能需要一个 tick 才就绪，做有界重试：最多 8 次、间隔 150ms；服务面
  // 缺失时静默跳过（文本与附件各自独立降级，附件读不出不影响撤回主流程）。
  //
  // opts.submit：编辑并重发专用——文本与附件都落进输入态后替用户按下发送。
  // 撤回回填不传，行为与既有完全一致（只回填，不替用户决定发不发）。
  function fillDraft(targetSessionId: string, draftText: string, attachmentFiles: Promise<File[]> | null, opts?: { submit?: boolean }): void {
    if (!targetSessionId || (!draftText && attachmentFiles === null)) return
    let attempts = 0
    let attachStarted = false
    // 「附件链路走完」而不是「已发起」：createDrafts/addAttachments 是异步的，
    // 先 submit 再补附件会把附件留成下一轮的草稿（编辑重发的附件直接漏发）
    let attachDone = attachmentFiles === null
    let submitted = false
    let shellRef: ConversationInputShell | null = null
    const submitIfReady = () => {
      if (!opts || opts.submit !== true || submitted || !shellRef) return
      submitted = true
      submitShell(shellRef, draftText)
    }
    const attempt = () => {
      let textDone = draftText === ''
      try {
        // conversation 服务 0.1.2 才有（0.1.1-rc.2 无，ui-conversation 提供），
        // 不能进静态 inject——否则 0.1.1-rc.2 上声明缺失服务插件静默不启动。
        // 走 ctx.get 探测：guard 的 get 对缺失/未声明服务安全返回 undefined，
        // 拿不到就降级重试（0.1.1-rc.2 恒降级；0.1.2 视服务可见性而定）。
        const conversation = ctx.get<ConversationService>('conversation')
        if (conversation && conversation.input && typeof conversation.input.shell === 'function') {
          const shell = conversation.input.shell(targetSessionId)
          if (shell) {
            shellRef = shell
            if (!textDone) {
              if (shell.actions && typeof shell.actions.setDraft === 'function') {
                shell.actions.setDraft(draftText)
                textDone = true
              } else if (typeof shell.setDraft === 'function') {
                shell.setDraft(draftText)
                textDone = true
              }
            }
            if (!attachStarted && attachmentFiles !== null) {
              // 自动发送（编辑重发）时不让图片走「进输入态即后台上传」：官方 sendSession
              // 会等上传回执，而刚 fork 的子会话上传可能迟迟不结算——实测草稿留在输入框、
              // 消息不发也不报错。改传 false 让图片随 prompt 内联，发送一步到位；只有
              // 「只回填不发送」的撤回场景才值得提前上传。
              attachStarted = startAttachDrafts(conversation, shell, targetSessionId, attachmentFiles, () => {
                attachDone = true
                submitIfReady()
              }, opts === undefined || opts.submit !== true)
            }
          }
        }
      } catch (e) { /* fall through to retry */ }
      if (textDone && attachDone) {
        submitIfReady()
        return
      }
      if ((!textDone || !attachStarted) && attempts++ < 8) setTimeout(attempt, 150)
    }
    attempt()
  }

  // 程序化按下发送。官方 submit 读的是输入态快照里的草稿文本（ui-conversation
  // 0.2.1-rc.2 实证：shell.actions.submit 无参，内部即 submit('queue')），若
  // setDraft 与 submit 落在同一 tick 而投影尚未刷新，submit 会按空草稿提前返回
  // ——表现为「没报错但没发出去」。有 snapshot 可读时按文本比对等它落地；
  // 读不到（跨版本降级面）就让出一拍直接提交：草稿为空时官方自身会拒绝发送，
  // 最坏结果是「没发」，不会是「发错内容」。
  function submitShell(shell: ConversationInputShell, expected: string): void {
    const actions = shell.actions
    const submit = actions && actions.submit
    if (typeof submit !== 'function') {
      recallNodeLog.warn('输入区未暴露 submit，编辑后的消息未能自动发出')
      return
    }
    let tries = 0
    const tick = () => {
      const snap = (shell as { snapshot?: { draft?: unknown } }).snapshot
      const draft = snap && typeof snap.draft === 'string' ? snap.draft : null
      if (draft !== null && draft !== expected && tries++ < 6) {
        setTimeout(tick, 50)
        return
      }
      try {
        submit.call(actions)
      } catch (error) {
        recallNodeLog.warn('send after edit failed:', error)
      }
    }
    setTimeout(tick, 0)
  }

  // 附件回填（后半程）：把早读好的 File 注册为子会话的草稿附件。返回「链路是否
  // 已发起」——服务面缺失返回 false，交由调用方有界重试；发起后逐项失败只降级
  // 该项，不再重试。
  // onDone：链路终结（成功、部分失败、服务面不可用）时回调一次——编辑重发要
  // 等附件真正进输入态才能按发送，见 fillDraft 的 attachDone
  function startAttachDrafts(conversation: ConversationService, shell: ConversationInputShell, sessionId: string, files: Promise<File[]>, onDone?: () => void, eagerUpload = true): boolean {
    if (typeof conversation.createDrafts !== 'function') return false
    const actions = shell.actions
    let add: ((ids: string[]) => unknown) | null = null
    if (actions && typeof actions.addAttachments === 'function') add = (ids) => actions.addAttachments ? actions.addAttachments(ids) : false
    else if (typeof shell.addAttachments === 'function') add = (ids) => shell.addAttachments ? shell.addAttachments(ids) : false
    if (add === null) return false
    ;(async () => {
      try {
        let list: File[] = []
        try { list = await files } catch (e) { return } // 附件早读失败放弃附件回填（文本回填不受影响）
        if (!Array.isArray(list) || list.length === 0) return
        try {
          // 第三参 uploadImages（≥0.2.2-alpha.2）：true＝图片进输入态即后台上传、发送时
          // 复用；false（或缺省）＝字节随 prompt 内联。旧版忽略多余实参。取哪个由调用
          // 场景决定（见 fillDraft 的 eagerUpload）。三参形态若抛错（上传服务缺席等），
          // 退回两参让图片改随 prompt 内联——附件宁可慢一点，也不能整批丢。
          let drafts: unknown
          try {
            drafts = conversation.createDrafts ? conversation.createDrafts(sessionId, list, eagerUpload) : []
          } catch (e) {
            drafts = conversation.createDrafts ? conversation.createDrafts(sessionId, list) : []
          }
          const descriptors = Array.isArray(drafts) ? drafts as DraftAttachmentDescriptor[] : []
          const ids = descriptors.map((draft) => draft && draft.id).filter((id): id is string => typeof id === 'string' && id !== '')
          if (ids.length === 0) return
          const accepted = add(ids)
          // 官方 addFiles 的失败回滚：未接纳时释放已注册的草稿附件
          if (accepted === false && typeof conversation.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(descriptors)
        } catch (e) { /* 附件未回填；文本回填不受影响 */ }
      } finally {
        // 逐项失败也算终结：编辑重发不能在附件链路上无限等（最坏少带附件发出）
        if (onDone) onDone()
      }
    })()
    return true
  }

  // readAttachment 的入参有两代，形状互斥且都不抛「用错了」的专用错：
  // ≥0.2.2-alpha.1 收完整引用对象（宿主只按 mediaType/bytes/尺寸自证，裸 id 直接
  // INVALID_ATTACHMENT_REF）；≤0.2.1 收 attachmentId 字符串（宿主回会话日志反查）。
  // 故按「完整引用 → 裸 id」回退探测，并把命中的那代记在闭包里——同一次撤回里
  // 多张图片不必重复撞错。两代返回形状一致（{attachment, data}），调用方无感。
  let attachmentShape: 'ref' | 'id' | null = null
  async function readAttachmentBytes(read: (attachment: unknown) => Promise<ReadAttachmentResult>, ref: DraftAttachmentRef): Promise<{ attachment?: SessionAttachmentRef; data: unknown } | null> {
    const refArg = ref.attachment && typeof ref.attachment === 'object' ? ref.attachment : null
    const idArg = typeof ref.attachmentId === 'string' && ref.attachmentId !== '' ? ref.attachmentId : null
    const attempts: Array<{ shape: 'ref' | 'id'; arg: unknown }> = []
    if (attachmentShape === 'id') {
      if (idArg !== null) attempts.push({ shape: 'id', arg: idArg })
      if (refArg !== null) attempts.push({ shape: 'ref', arg: refArg })
    } else {
      if (refArg !== null) attempts.push({ shape: 'ref', arg: refArg })
      if (idArg !== null) attempts.push({ shape: 'id', arg: idArg })
    }
    for (const attempt of attempts) {
      try {
        const result = await read(attempt.arg)
        if (result && result.ok === true && result.value && result.value.data !== undefined && result.value.data !== null) {
          attachmentShape = attempt.shape
          return { attachment: result.value.attachment, data: result.value.data }
        }
      } catch (e) { /* 该代口径不适用，试下一条 */ }
    }
    return null
  }

  // 附件早读（前半程）：撤回执行一开始调用——此刻源会话仍在册（归档在 fork
  // 之后才发生）、附件引用可解析；fork + open 完成后再由 fillDraft 注册进子会话。
  // readAttachment 的凭据绑定在「消息所在会话」上（旧版按会话日志授权、新版按网关
  // 权限范围），故必须用源会话 id。逐项 try/catch：单项失败跳过，不阻断其余附件。
  function preloadAttachmentFiles(sourceSessionId: string, refs: DraftAttachmentRef[]): Promise<File[]> {
    return (async () => {
      const sessions = ctx.sessions
      const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(sourceSessionId) : undefined
      const session = binding && binding.session
      if (!session || typeof session.readAttachment !== 'function') return []
      const read = session.readAttachment.bind(session)
      const out: File[] = []
      for (const ref of refs) {
        try {
          const value = await readAttachmentBytes(read, ref)
          if (!value) continue
          const raw = value.data
          const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw as ArrayLike<number>)
          const meta = value.attachment
          const mediaType = meta && typeof meta.mediaType === 'string' && meta.mediaType !== '' ? meta.mediaType : 'application/octet-stream'
          const name = ref.name || (meta && typeof meta.name === 'string' && meta.name !== '' ? meta.name : defaultAttachmentName(mediaType, out.length))
          // 拷贝出独立 ArrayBuffer 再建 File：Uint8Array<ArrayBufferLike> 不满足
          // 新版 TS 的 BlobPart（SharedArrayBuffer 分支），且避免视图共享底层缓冲
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          out.push(new File([buffer], name, { type: mediaType }))
        } catch (e) { /* 单项失败跳过 */ }
      }
      return out
    })()
  }

  return { fillDraft, preloadAttachmentFiles }
}
