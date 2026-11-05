/**
 * Personal Agent — 输入框。
 *
 * 图片（粘贴 / 选文件）→ 先上传落盘（`POST /api/personal-agent/upload`）→
 * 消息块只存同源 URL 与相对路径；textarea 自动增高（上限与 Work 对话框一致，
 * 336px）、Enter 发送 / Shift+Enter 换行、麦克风语音转写（录音 → DSH speech Remote / host ASR，
 * 与 Work 模式同一条 SenseVoice 链路）、群聊 @ 成员菜单。
 *
 * 语音输入不再在输入框上方堆一行状态文字：录音时整块输入框让位给
 * VoiceBar（X / 实时波形 / 停止 / 发送），录完把文字交回输入框或直接发。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { IconMessage, IconPaperclip, IconPlus, IconSend, IconStop, IconUsers, IconWave, IconX } from '../icons.tsx'
import { usePersonal } from '../store.tsx'
import { SpeechRecorder, transcribeWav } from '../audio.ts'
import { primeSpeech } from '../speech.ts'
import { VoiceBar, type VoiceBarPhase } from './VoiceBar.tsx'
import type { Bot, ChatImage } from '../types.ts'

type VoicePhase = 'idle' | VoiceBarPhase

/**
 * 输入框自适应高度：先按内容撑开，涨到上限为止，再超出才在框内滚动。
 *
 * 上限不写死在这里——读 CSS 的 max-height（见 chat.css.ts 的
 * .pa-composer__textarea）。Work 模式的对话框上限是 DSH 的
 * --dsh-composer-text-max-height（336px），Bot 模式跟它对齐：以前这里硬编码
 * 140px，多行消息到五行就不再长，长文本只能在小框里滚。
 */
function autoGrowTextarea(element: HTMLTextAreaElement): void {
  element.style.height = 'auto'
  const maxHeight = Number.parseFloat(getComputedStyle(element).maxHeight)
  const next = Number.isFinite(maxHeight) && maxHeight > 0
    ? Math.min(element.scrollHeight, maxHeight)
    : element.scrollHeight
  element.style.height = `${next}px`
}

export function Composer(): JSX.Element {
  const { state, ui, actions, activeBot, activeRoom, activeMessages } = usePersonal()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [images, setImages] = useState<ChatImage[]>([])
  const [uploading, setUploading] = useState(0)
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle')
  const [mentionOpen, setMentionOpen] = useState(false)
  /*
   * @ 提及气泡的退场状态：关闭时先播 240ms（淡出 + 向右位移缩小），再卸载。
   * 直接 setMentionOpen(false) 会让气泡硬消失；时长 / 曲线与
   * src/client/modal-animation.ts 的 MODAL_ANIM_MS 对齐。
   */
  const [mentionClosing, setMentionClosing] = useState(false)
  const mentionTimerRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef<SpeechRecorder | null>(null)
  /** 每次取消/重开都自增：转写回来的结果对不上号就直接丢弃。 */
  const voiceTokenRef = useRef(0)

  const targetName = activeRoom !== null ? activeRoom.name : activeBot.name
  const members: Bot[] = activeRoom === null
    ? []
    : activeRoom.memberIds
      .map((id) => state.bots.find((bot) => bot.id === id))
      .filter((bot): bot is Bot => bot !== undefined)
  /*
   * 可被 @ 的人。
   *
   * 群聊里是群成员；私聊里是「除当前对话对象以外的 Bot」——语义不同：群里的 @
   * 决定谁接话，私聊里的 @ 是给主管的一条派活指令（「这件事交给它」），所以名单
   * 里不包含正在对话的这个 Bot，@ 它自己等于没说。
   */
  const mentionTargets: Bot[] = activeRoom === null
    ? state.bots.filter((bot) => bot.id !== activeBot.id)
    : members

  /*
   * 用 layout effect：发送后立刻回到单行高度，避免下一帧还闪一下高框。
   * voicePhase 也进依赖：录音时 textarea 会被 VoiceBar 换下，取消录音回到输入框
   * 是一次重新挂载——此时 text 没变，只靠 [text] 不会重新量，多行草稿会塌回一行。
   */
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (element !== null) autoGrowTextarea(element)
  }, [text, voicePhase])

  /*
   * 对话列被左右拖宽 / 窗口缩放时重新量一次：同一段文本在窄列里会多折几行，
   * 不重算就会留下截断或空白。只认宽度变化，避免高度写入触发观察器自循环。
   */
  useEffect(() => {
    const element = textareaRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return undefined
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return
      width = element.clientWidth
      autoGrowTextarea(element)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [voicePhase])

  useEffect(() => () => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder !== null) void recorder.cancel()
  }, [])

  /** 收起 @ 气泡：先播退场，240ms 后再真正卸载。 */
  const closeMention = useCallback((): void => {
    // 气泡本来就没开（例如私聊里直接发送、或没有可点名的 Bot）：不能起退场，
    // 否则会凭空渲染一个空气泡。
    if (!mentionOpen) return
    if (mentionTimerRef.current !== null) return
    setMentionClosing(true)
    mentionTimerRef.current = window.setTimeout(() => {
      mentionTimerRef.current = null
      setMentionClosing(false)
      setMentionOpen(false)
    }, 240)
  }, [mentionOpen])

  /** 撤销退场：退场途中再点「@ 提及」，气泡原地弹回。 */
  const cancelMentionClose = useCallback((): void => {
    if (mentionTimerRef.current !== null) {
      window.clearTimeout(mentionTimerRef.current)
      mentionTimerRef.current = null
    }
    setMentionClosing(false)
  }, [])

  useEffect(() => () => {
    if (mentionTimerRef.current !== null) window.clearTimeout(mentionTimerRef.current)
  }, [])

  useEffect(() => {
    if (!mentionOpen) return undefined
    const close = (event: MouseEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node && rootRef.current.contains(event.target)) return
      closeMention()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [mentionOpen, closeMention])

  /* Esc 关闭 @ 气泡：与点外部、选中成员走同一个退场。 */
  useEffect(() => {
    if (!mentionOpen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      closeMention()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mentionOpen, closeMention])

  const readLevel = useCallback((): number => recorderRef.current?.level() ?? 0, [])

  const send = (): void => {
    const value = text.trim()
    // 只发图不打字也要能发出去
    if (value === '' && images.length === 0) return
    if (uploading > 0) {
      actions.toast('图片还在上传，稍等一下')
      return
    }
    /*
     * 发送是一次用户手势：顺手把朗读的 AudioContext 建好并恢复。
     * 自动朗读发生在「消息到达」那一刻（非手势），浏览器会拦掉那时新建的上下文；
     * 在这里预热之后，打开会话头「自动播报」的用户才会真的听见声音。
     */
    primeSpeech()
    actions.sendMessage(value, {
      images,
      // 输入框挂着引用就带上（store 里还会兜底读 ui.replyTo，这里显式传更清楚）
      ...(ui.replyTo !== null ? { replyTo: ui.replyTo } : {}),
    })
    setText('')
    setImages([])
    setAttachments([])
    closeMention()
  }

  const startVoice = async (): Promise<void> => {
    if (voicePhase !== 'idle') return
    const recorder = new SpeechRecorder()
    recorderRef.current = recorder
    try {
      await recorder.start()
      setVoicePhase('recording')
    } catch (error) {
      recorderRef.current = null
      setVoicePhase('idle')
      actions.toast(error instanceof Error ? error.message : String(error))
    }
  }

  const stopVoice = async (): Promise<void> => {
    const recorder = recorderRef.current
    if (recorder === null) {
      setVoicePhase('idle')
      return
    }
    recorderRef.current = null
    const token = voiceTokenRef.current + 1
    voiceTokenRef.current = token
    setVoicePhase('transcribing')
    try {
      const wav = await recorder.stop()
      const transcript = await transcribeWav(wav)
      if (voiceTokenRef.current !== token) return
      // 转写完就彻底收起语音条：文字并入输入框，麦克风与语音界面一起关掉。
      setText((prev) => (prev.trim() === '' ? transcript : `${prev.trimEnd()} ${transcript}`))
      setVoicePhase('idle')
      actions.toast('语音已转成文字，确认后发送')
      window.requestAnimationFrame(() => textareaRef.current?.focus())
    } catch (error) {
      if (voiceTokenRef.current !== token) return
      setVoicePhase('idle')
      actions.toast(error instanceof Error ? error.message : String(error))
    }
  }

  /** X：录音/转写中直接丢弃，回到输入框。 */
  const cancelVoice = (): void => {
    const recorder = recorderRef.current
    recorderRef.current = null
    voiceTokenRef.current += 1
    if (recorder !== null) void recorder.cancel()
    setVoicePhase('idle')
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const toggleVoice = (): void => {
    if (voicePhase === 'recording') {
      void stopVoice()
      return
    }
    if (voicePhase !== 'idle') return
    void startVoice()
  }

  /**
   * 把图片逐张上传到宿主，拿回同源 URL 与相对路径。
   *
   * 为什么先上传再发消息：消息要持久化在 localStorage 里，base64 几张就撑爆配额；
   * 落盘后消息只存 URL（`/file?path=…`），刷新、重开都还在。上传失败只 toast，
   * 不影响已经成功的那些。
   */
  const uploadImages = async (files: File[]): Promise<void> => {
    const list = files.slice(0, 6)
    if (list.length === 0) return
    for (const file of list) {
      setUploading((count) => count + 1)
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
          reader.onerror = () => reject(new Error('读取图片失败'))
          reader.readAsDataURL(file)
        })
        if (dataUrl === '') throw new Error('读取图片失败')
        const response = await fetch('/api/personal-agent/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dataUrl, name: file.name }),
        })
        const data = (await response.json().catch(() => ({}))) as {
          ok?: boolean
          url?: string
          path?: string
          name?: string
          error?: string
        }
        if (!response.ok || data.ok === false) throw new Error(data.error ?? `图片上传失败（${response.status}）`)
        if (typeof data.url !== 'string' || typeof data.path !== 'string') throw new Error('图片上传返回不完整')
        const image: ChatImage = { url: data.url, path: data.path, ...(typeof data.name === 'string' ? { name: data.name } : {}) }
        setImages((prev) => [...prev, image])
      } catch (error) {
        actions.toast(error instanceof Error ? error.message : String(error))
      } finally {
        setUploading((count) => count - 1)
      }
    }
  }

  /** 从剪贴板里捞图片；不 preventDefault，让文字照常粘进输入框。 */
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = event.clipboardData?.items
    if (items === undefined) return
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (file !== null) files.push(file)
    }
    if (files.length === 0) return
    void uploadImages(files)
  }

  const handleFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = event.target.files
    if (files === null || files.length === 0) return
    const picked = Array.from(files)
    const imageFiles = picked.filter((file) => file.type.startsWith('image/'))
    const otherFiles = picked.filter((file) => !file.type.startsWith('image/'))
    if (imageFiles.length > 0) void uploadImages(imageFiles)
    if (otherFiles.length > 0) {
      const names = otherFiles.map((file) => file.name)
      setAttachments((prev) => [...prev, ...names])
      actions.toast(names.length === 1 ? `已选择附件：${names[0]}` : `已选择 ${names.length} 个附件`)
    }
    event.target.value = ''
  }

  const insertMention = (name: string): void => {
    const element = textareaRef.current
    const prefix = text !== '' && !text.endsWith(' ') && !text.endsWith('\n') ? ' ' : ''
    const next = `${text}${prefix}@${name} `
    setText(next)
    // 插入文字是即时的，气泡只负责滑出——不必等退场播完才把 @ 写进输入框。
    closeMention()
    window.requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(next.length, next.length)
    })
  }

  const hasText = text.trim() !== ''
  const canSend = hasText || images.length > 0
  /*
   * 运行中判定：pending 消息 + 还挂着 running 的任务记录。
   *
   * 只认 pending 消息是不够的（2026-11-02 实测）：页面重载时 store 会把消息的
   * pending 清掉，但任务记录可能还是 running——那时停止键消失，用户既停不掉、
   * 也看不到「它还在跑」。两条都看，按钮才不会在这种半恢复状态下消失。
   * 群聊里任一成员还在回复都算运行中——停止键要能一次停掉整个群。
   */
  const replying = activeMessages.some((message) => message.role === 'bot' && message.pending === true)
    || state.tasks.some((task) => task.status === 'running' && (activeRoom !== null
      ? task.roomId === activeRoom.id
      : task.botId === activeBot?.id && task.roomId === undefined))

  return (
    <div className="pa-composer" ref={rootRef}>
      {/*
       * 引用提示（2.3）：点某条消息的「回复」后，这里显示被引用的内容。
       * 放在附件 chips 之前：它说明的是「这条消息在回复谁」，优先级比附件高。
       */}
      {ui.replyTo !== null ? (
        <div className="pa-composer__reply">
          <IconMessage size={12} />
          <span className="pa-composer__reply-text" title={ui.replyTo.preview}>{ui.replyTo.preview}</span>
          <button type="button" title="取消引用" aria-label="取消引用" onClick={() => actions.setReplyTo(null)}>
            <IconX size={11} />
          </button>
        </div>
      ) : null}
      {mentionTargets.length > 0 || attachments.length > 0 ? (
        <div className="pa-composer__chips">
          {mentionTargets.length > 0 ? (
            <button
              className="pa-composer__chip pa-composer__chip--at"
              type="button"
              onClick={() => {
                // 退场途中再点一次：撤销退场原地弹回，不必等它消失后再开。
                if (mentionClosing) {
                  cancelMentionClose()
                  return
                }
                if (mentionOpen) closeMention()
                else setMentionOpen(true)
              }}
            >
              <IconUsers size={12} />
              <span>@ 提及</span>
            </button>
          ) : null}
          {attachments.map((name, index) => (
            <span className="pa-composer__chip" key={`${name}-${index}`}>
              <IconPaperclip size={11} />
              <span>{name}</span>
              <button
                type="button"
                aria-label={`移除附件 ${name}`}
                onClick={() => setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
              >
                <IconX size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {images.length > 0 || uploading > 0 ? (
        <div className="pa-composer__images">
          {images.map((image, index) => (
            <span className="pa-composer__image" key={`${image.url}-${index}`}>
              <img src={image.url} alt={image.name ?? '图片'} />
              <button
                type="button"
                aria-label="移除图片"
                title="移除图片"
                onClick={() => setImages((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
              >
                <IconX size={11} />
              </button>
            </span>
          ))}
          {uploading > 0 ? <span className="pa-composer__uploading">图片上传中…</span> : null}
        </div>
      ) : null}

      {voicePhase !== 'idle' ? (
        <VoiceBar
          phase={voicePhase}
          level={readLevel}
          onCancel={cancelVoice}
          onStop={() => void stopVoice()}
        />
      ) : (
        <div className="pa-composer__box">
          <input ref={fileRef} className="pa-composer__file" type="file" multiple onChange={handleFiles} />
          <button className="pa-composer__plus" type="button" title="添加附件" aria-label="添加附件" onClick={() => fileRef.current?.click()}>
            <IconPlus size={18} />
          </button>
          <textarea
            ref={textareaRef}
            className="pa-composer__textarea"
            rows={1}
            value={text}
            placeholder={`给 ${targetName} 发消息`}
            onChange={(event) => setText(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                if (event.nativeEvent.isComposing) return
                event.preventDefault()
                send()
              }
            }}
          />
          <div className="pa-composer__tools">
            {/*
             * 运行中优先显示停止键：哪怕输入框里已经打了字，用户此刻最需要的
             * 也是「先停下来」——发送可以等停止之后再点。
             */}
            {replying ? (
              <button className="pa-composer__stop" type="button" title="停止回复" aria-label="停止回复" onClick={() => actions.stopReply()}>
                <IconStop size={15} />
              </button>
            ) : canSend ? (
              <button className="pa-composer__send" type="button" data-on="true" title="发送" aria-label="发送" onClick={send}>
                <IconSend size={17} />
              </button>
            ) : (
              <button className="pa-composer__voice" type="button" title="语音输入" aria-label="语音输入" onClick={toggleVoice}>
                <IconWave size={17} />
              </button>
            )}
          </div>

          {(mentionOpen || mentionClosing) && mentionTargets.length > 0 ? (
            <div className="pa-composer__mention" data-closing={mentionClosing ? '1' : undefined}>
              {activeRoom === null ? (
                <div className="pa-chat-empty__desc">点名让它去做：消息会交给它，主 Bot 负责转派和验收</div>
              ) : null}
              {mentionTargets.map((member) => (
                <button type="button" key={member.id} onClick={() => insertMention(member.name)}>
                  <BotAvatar avatar={member.avatar} size={22} />
                  <span className="pa-composer__mention-name">{member.name}</span>
                  <span className="pa-composer__mention-role">{member.role}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
