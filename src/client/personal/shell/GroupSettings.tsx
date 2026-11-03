/**
 * Personal Agent — 群聊设置卡（右侧滑出）。
 *
 * 与 BotSettingsCard 共用同一套 `pa-sheet` 视觉（遮罩 + 右贴边全高容器，
 * 样式在 settings.css.ts）：群名 / 模型策略 / 成员管理 / 保存，外加一个
 * 「删除群聊」危险区（二次确认用自绘确认条，不弹 window.confirm）。
 *
 * 入口：Sidebar 的群聊行「...」菜单、ChatPanel 的「更多 → 群聊设置」，
 * 都只调用 `actions.openGroupSettings(roomId)`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../Avatar.tsx'
import { randomBotAppearance } from '../engine.ts'
import { IconPlus, IconTrash, IconX } from '../icons.tsx'
import { AvatarPicker } from '../shared/AvatarPicker.tsx'
import { ModelPicker, type ModelPickerGroup } from '../shared/ModelPicker.tsx'
import { PaSelect, type PaSelectOption } from '../shared/PaSelect.tsx'
import { useModelGroups } from '../shared/useModelGroups.ts'
import { usePersonal } from '../store.tsx'
import { MODEL_FALLBACK, type Avatar, type Bot, type BotModel, type Room } from '../types.ts'

/**
 * 从群聊当前配置与宿主模型列表算出「全组统一」的初始值。
 *
 * · 没有配置过 / 供应商已经不在列表里 → 第一组第一款（避免拿一个已下线的
 *   provider 去跑群聊）；
 * · 供应商还在、但没选模型 → 该供应商第一款；
 * · 模型不在列表里 → 保留原值（ModelPicker 会补一个「（当前）」兜底项）。
 */
function resolveUnifiedModel(
  groups: readonly ModelPickerGroup[],
  unified: BotModel | undefined,
): { provider: string; model: string } {
  if (groups.length === 0) {
    return { provider: unified?.provider ?? '', model: unified?.model ?? '' }
  }
  const group = groups.find((item) => item.provider === unified?.provider)
  if (group === undefined) {
    const first = groups[0]
    return { provider: first?.provider ?? '', model: first?.models[0]?.id ?? '' }
  }
  return {
    provider: group.provider,
    model: unified?.model !== undefined && unified.model !== ''
      ? unified.model
      : group.models[0]?.id ?? '',
  }
}

export function GroupSettings(): JSX.Element | null {
  const { state, ui, actions } = usePersonal()
  const liveRoom = ui.groupSettingsOpen !== null
    ? state.rooms.find((item) => item.id === ui.groupSettingsOpen) ?? null
    : null

  /*
   * 退场状态：关闭时先播 240ms 退场（遮罩淡出 + 卡片下沉 14px 并缩到 0.97），
   * 播完才真正 actions.openGroupSettings(null) 卸载。直接置 null 的话卡片会
   * 硬消失，和入场那 180ms 的弹入完全不对称。
   *
   * 时长与曲线跟 src/client/modal-animation.ts 的 MODAL_ANIM_MS 对齐
   * （240ms / cubic-bezier(0.4, 0, 0.2, 1)）；关键帧在 settings.css.ts 的
   * .pa-sheet-overlay[data-closing='1'] 里，三张设置卡共用同一套。
   */
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)

  /** 关闭：先播 240ms 退场，再真正卸载（直接置 null 会硬消失）。 */
  const requestClose = useCallback((): void => {
    if (closeTimerRef.current !== null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setClosing(false)
      actions.openGroupSettings(null)
    }, 240)
  }, [actions])

  /* 卸载时清计时器：退场播到一半被外部卸载（切 Work / 关插件）时别留悬空回调。 */
  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  /*
   * 「删除群聊」会让 liveRoom 立刻变 null，而退场还要播满 240ms。这里留一份
   * 最后渲染过的群聊快照：closing 期间拿它继续渲染，卡片才会照常淡出，而不是
   * 在点「确认删除」的瞬间硬消失。非 closing 时仍只看 liveRoom（删完就真没了）。
   */
  const lastRoomRef = useRef<Room | null>(null)
  useEffect(() => {
    if (liveRoom !== null) lastRoomRef.current = liveRoom
  }, [liveRoom])
  const room = liveRoom ?? (closing ? lastRoomRef.current : null)

  const [name, setName] = useState('')
  /**
   * 群聊头像：null = 跟随成员头像叠加（旧行为，也是没选过头像时的默认）。
   * 用户在下面挑一个形状 / 颜色 / 本地图片后才有值，保存时一起落库。
   */
  const [avatar, setAvatar] = useState<Avatar | null>(null)
  /** 选择器的初始预览：没自定义头像时给一个随机外观，挑起来才知道换的是什么。 */
  const [avatarSeed] = useState<Avatar>(() => randomBotAppearance())
  const [members, setMembers] = useState<string[]>([])
  const [mode, setMode] = useState<'inherit' | 'unified'>('inherit')
  const [provider, setProvider] = useState('')
  const [modelValue, setModelValue] = useState('')
  /**
   * 「全组统一」的推理强度（模型公布的可选档位 id）。
   *
   * 空串 = 跟随模型自己的默认档（与 BotSettingsCard 的 effort 口径一致，不下发
   * reasoningEffort）。群聊保存时只写模型公布过的档位；换到不支持该档位的模型时
   * 自动回落到「跟随默认」，避免把一个无效档位写进 unifiedModel。
   */
  const [effort, setEffort] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  /* 宿主可用模型（供应商 → 模型）：群聊设置打开时拉一次。 */
  const modelGroupsState = useModelGroups(ui.groupSettingsOpen !== null)
  const modelGroups = modelGroupsState.groups
  /** 已经按哪一份模型列表为哪个群算过初始值；防止用户手动选择后列表刷新又覆盖。 */
  const modelInitRef = useRef<{ roomId: string; groups: ModelPickerGroup[] } | null>(null)
  /* 删除群聊的二次确认（自绘，不用原生 confirm） */
  const [deleteOpen, setDeleteOpen] = useState(false)

  /* 打开时从当前群聊回填表单。 */
  useEffect(() => {
    if (room === null) return
    setName(room.name)
    setAvatar(room.avatar ?? null)
    setMembers(room.memberIds)
    setMode(room.modelMode)
    setProvider(room.unifiedModel?.provider ?? '')
    setModelValue(room.unifiedModel?.model ?? '')
    setEffort(room.unifiedModel?.effort ?? '')
    setAddOpen(false)
    setDeleteOpen(false)
  }, [ui.groupSettingsOpen, room?.id])

  /*
   * 模型列表是异步拉取的：打开时先按 room.unifiedModel 回填（上面的 effect），
   * 列表到达后再把「没配置 / 供应商不在列表」的群落到第一组第一款。
   * 用 ref 按群 id 只初始化一次：用户手动改过选择之后，即使列表重新拉取也不覆盖。
   */
  useEffect(() => {
    if (room === null) {
      modelInitRef.current = null
      return
    }
    const initialized = modelInitRef.current
    if (
      initialized !== null
      && initialized.roomId === room.id
      && initialized.groups === modelGroups
    ) {
      return
    }
    if (modelGroups.length === 0) return
    const resolved = resolveUnifiedModel(modelGroups, room.unifiedModel)
    setProvider(resolved.provider)
    setModelValue(resolved.model)
    /*
     * 只有「群聊原本就配的模型没有被替换」时才保留原来的推理强度；
     * 供应商下线 / 第一次打开 / 模型被换成该供应商第一款时，旧档位不再可信，
     * 回落成「跟随默认」。
     */
    const sameModel = room.unifiedModel?.provider === resolved.provider
      && room.unifiedModel?.model === resolved.model
    setEffort(sameModel ? (room.unifiedModel?.effort ?? '') : '')
    modelInitRef.current = { roomId: room.id, groups: modelGroups }
  }, [room, modelGroups])

  /* Esc 关闭；PaSelect / 原生控件处理过 Esc 时跳过。 */
  useEffect(() => {
    if (room === null) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      // 走 requestClose 而不是直接置 null：Esc 也要播完退场再卸载。
      if (event.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [room, requestClose])

  /*
   * 群聊被删除后 ui.groupSettingsOpen 会残留一个不存在的 id：自动清掉。
   * 走 requestClose 而不是直接置 null——这样「在别处解散群聊」也能播完退场
   * （上面 lastRoomRef 的快照保证这 240ms 里还有内容可渲染）。
   */
  useEffect(() => {
    if (ui.groupSettingsOpen === null) return
    if (!state.rooms.some((item) => item.id === ui.groupSettingsOpen)) requestClose()
  }, [ui.groupSettingsOpen, state.rooms, requestClose])

  if (room === null) return null

  const memberBots = members
    .map((id) => state.bots.find((bot) => bot.id === id))
    .filter((bot): bot is Bot => bot !== undefined)
  const candidates = state.bots.filter((bot) => !members.includes(bot.id))

  const addMember = (id: string): void => {
    setMembers((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setAddOpen(false)
  }

  const removeMember = (id: string): void => {
    setMembers((prev) => prev.filter((memberId) => memberId !== id))
  }

  /*
   * 推理强度选项：只列「当前选中的模型自己公布」的档位，另加一项「跟随默认」。
   * 模型没公布档位（或宿主列表没加载完）时不渲染这一行，不拿一套固定档位冒充能力。
   */
  const currentModel = modelGroups
    .flatMap((group) => group.models.map((item) => ({ ...item, provider: group.provider })))
    .find((item) => item.provider === provider && item.id === modelValue)
  const effortChoices: PaSelectOption[] = currentModel === undefined || (currentModel.reasoningEfforts ?? []).length === 0
    ? []
    : [
        { value: '', label: '跟随默认' },
        ...(currentModel.reasoningEfforts ?? []).map((item) => ({ value: item.id, label: item.name })),
      ]
  /** 当前值不在公布档位里（旧数据 / 换过模型）时按「跟随默认」展示，不编一个假选项。 */
  const effortValue = effortChoices.some((option) => option.value === effort) ? effort : ''

  /** 选供应商 / 模型：把旧档位只在「新模型也支持」时保留下来。 */
  const handleModelPick = (next: { provider: string; model: string }): void => {
    setProvider(next.provider)
    setModelValue(next.model)
    const nextModel = modelGroups
      .flatMap((group) => group.models.map((item) => ({ ...item, provider: group.provider })))
      .find((item) => item.provider === next.provider && item.id === next.model)
    const nextEfforts = (nextModel?.reasoningEfforts ?? []).map((item) => item.id)
    setEffort((prev) => (prev !== '' && nextEfforts.includes(prev) ? prev : ''))
  }

  const save = (): void => {
    if (members.length === 0) return
    actions.updateRoom(room.id, {
      name: name.trim() || room.name,
      memberIds: members,
      /*
       * 恢复成成员头像叠加时要**显式写 undefined**：updateRoom 是浅合并，
       * 不传这个字段等于保留旧头像，用户点了「恢复」再保存会发现没变化。
       */
      avatar: avatar ?? undefined,
      modelMode: mode,
      ...(mode === 'unified'
        ? {
            unifiedModel: {
              provider: provider.trim() || MODEL_FALLBACK.provider,
              model: modelValue.trim() || MODEL_FALLBACK.model,
              // 只写当前模型真正公布过的档位；空串 = 跟随模型默认，不写这个字段。
              ...(effortValue === '' ? {} : { effort: effortValue }),
            },
          }
        : {}),
    })
    actions.toast('群聊设置已保存')
    requestClose()
  }

  /*
   * 退场只加一个 data-closing，动画由 settings.css.ts 里
   * .pa-sheet-overlay[data-closing='1'] 的后代选择器接管（特异性高于入场规则），
   * 所以入场 class 不用拆，两者不会同时抢同一个 animation 属性。
   */
  return (
    <div
      className="pa-sheet-overlay pa-sheet-overlay--dialog"
      data-closing={closing ? '1' : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <aside
        className="pa-sheet pa-sheet--dialog"
        role="dialog"
        aria-modal="true"
        aria-label="群聊设置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="pa-sheet__head">
          <div className="pa-sheet__head-text">
            <div className="pa-sheet__title">群聊设置</div>
            <div className="pa-sheet__sub">{room.name} · {members.length} 个 Bot</div>
          </div>
          <button className="pa-sheet__close" type="button" onClick={requestClose} title="关闭" aria-label="关闭群聊设置">
            <IconX size={16} />
          </button>
        </div>

        <div className="pa-sheet__body">
          {/* 群名与头像 */}
          <section className="pa-sheet-sec">
            <div className="pa-sheet-sec__head">
              <span className="pa-sheet-sec__title">群聊信息</span>
            </div>
            <div className="pa-sheet-field-row">
              <label className="pa-sheet-label">群聊头像</label>
              <AvatarPicker value={avatar ?? avatarSeed} onChange={setAvatar} />
              {avatar !== null ? (
                <button
                  className="pa-link-btn pa-avatar-picker__reset"
                  type="button"
                  onClick={() => setAvatar(null)}
                >
                  恢复为成员头像叠加
                </button>
              ) : (
                <p className="pa-sheet-hint">不选就用成员头像叠加显示</p>
              )}
            </div>
            <div className="pa-sheet-field-row">
              <input
                className="pa-field"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="群聊名称"
                aria-label="群聊名称"
              />
            </div>
          </section>

          {/* 模型策略 */}
          <section className="pa-sheet-sec">
            <div className="pa-sheet-sec__head">
              <span className="pa-sheet-sec__title">模型策略</span>
            </div>
            <label className="pa-sheet-radio" data-checked={mode === 'inherit' ? 'true' : 'false'}>
              <input
                type="radio"
                name="pa-group-model"
                checked={mode === 'inherit'}
                onChange={() => setMode('inherit')}
              />
              <span className="pa-sheet-radio__main">
                <b>跟随各自 Bot</b>
                <span>每个成员继续使用自己的模型设置</span>
              </span>
            </label>
            <label className="pa-sheet-radio" data-checked={mode === 'unified' ? 'true' : 'false'}>
              <input
                type="radio"
                name="pa-group-model"
                checked={mode === 'unified'}
                onChange={() => setMode('unified')}
              />
              <span className="pa-sheet-radio__main">
                <b>全组统一</b>
                <span>群内所有 Bot 使用同一个供应商与模型</span>
              </span>
            </label>
            {mode === 'unified' ? (
              modelGroups.length > 0 ? (
                <>
                  <div className="pa-sheet-field-row" style={{ marginTop: 10 }}>
                    <ModelPicker
                      groups={modelGroups}
                      value={{ provider, model: modelValue }}
                      onChange={handleModelPick}
                    />
                  </div>
                  {effortChoices.length > 0 ? (
                    <div className="pa-sheet-field-row" style={{ marginTop: 11 }}>
                      <label className="pa-sheet-label">推理强度</label>
                      <PaSelect
                        value={effortValue}
                        options={effortChoices}
                        ariaLabel="推理强度"
                        onChange={setEffort}
                      />
                      <p className="pa-sheet-hint">
                        档位越高，模型思考越久、回答越稳；「跟随默认」使用模型自己的默认档。保存后下一轮群聊生效。
                      </p>
                    </div>
                  ) : null}
                </>
              ) : modelGroupsState.loading ? (
                <p className="pa-sheet-hint" style={{ marginTop: 10 }}>正在读取模型列表…</p>
              ) : (
                /*
                 * 降级路径：宿主没提供模型列表时（旧版本 / 接口不可用），仍然允许
                 * 手填 provider 与模型，保证群聊设置本身可用。
                 */
                <>
                  <div className="pa-sheet-field-row" style={{ marginTop: 10 }}>
                    <label className="pa-sheet-label">供应商</label>
                    <input
                      className="pa-field"
                      value={provider}
                      onChange={(event) => setProvider(event.target.value)}
                      placeholder="例如：alymagpie"
                    />
                  </div>
                  <div className="pa-sheet-field-row">
                    <label className="pa-sheet-label">模型</label>
                    <input
                      className="pa-field"
                      value={modelValue}
                      onChange={(event) => setModelValue(event.target.value)}
                      placeholder="例如：auto/deepseek-v4.1-flash"
                    />
                  </div>
                </>
              )
            ) : null}
          </section>

          {/* 成员 */}
          <section className="pa-sheet-sec">
            <div className="pa-sheet-sec__head">
              <span className="pa-sheet-sec__title">成员</span>
              <span className="pa-sheet-sec__extra">{members.length} 个</span>
            </div>
            <div className="pa-sheet-chips">
              {memberBots.map((bot) => (
                <span className="pa-sheet-chip" key={bot.id}>
                  <BotAvatar avatar={bot.avatar} size={22} />
                  <span>{bot.name}</span>
                  <button type="button" title="移除成员" aria-label="移除成员" onClick={() => removeMember(bot.id)}>
                    <IconX size={11} />
                  </button>
                </span>
              ))}
              {candidates.length > 0 ? (
                <button className="pa-sheet-add-member" type="button" onClick={() => setAddOpen((prev) => !prev)}>
                  <IconPlus size={11} />添加成员
                </button>
              ) : null}
            </div>
            {addOpen ? (
              <div className="pa-sheet-member-list">
                {candidates.map((bot) => (
                  <button
                    key={bot.id}
                    className="pa-sheet-member-item"
                    type="button"
                    onClick={() => addMember(bot.id)}
                  >
                    <BotAvatar avatar={bot.avatar} size={22} />
                    <span>{bot.name}</span>
                    <small>{bot.role}</small>
                  </button>
                ))}
              </div>
            ) : null}
            {members.length === 0 ? (
              <p className="pa-sheet-hint pa-sheet-hint--warn">群聊至少要有一个成员才能保存。</p>
            ) : null}
          </section>

          {/* 危险区：删除群聊 */}
          <section className="pa-sheet-sec">
            <div className="pa-sheet-sec__head">
              <span className="pa-sheet-sec__title">危险操作</span>
            </div>
            <div className="pa-sheet-danger-zone">
              <b>删除群聊</b>
              <p>删除后群聊从侧栏消失，成员 Bot 和各自的私聊不受影响。此操作不可撤销。</p>
              {deleteOpen ? (
                <div className="pa-sheet-danger-confirm">
                  确定删除「{room.name}」？
                  <div className="pa-sheet-danger-confirm__row">
                    <button className="pa-btn pa-btn--ghost pa-btn--sm" type="button" onClick={() => setDeleteOpen(false)}>
                      取消
                    </button>
                    <button
                      className="pa-btn pa-btn--danger pa-btn--sm"
                      type="button"
                      onClick={() => {
                        actions.deleteRoom(room.id)
                        // 删除会让 liveRoom 立刻变 null，requestClose 负责让快照
                        // 再撑 240ms 把退场播完，而不是当场硬消失。
                        requestClose()
                        actions.toast('群聊已删除')
                      }}
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              ) : (
                <div className="pa-sheet-danger-actions">
                  <button className="pa-btn pa-btn--danger pa-btn--sm" type="button" onClick={() => setDeleteOpen(true)}>
                    <IconTrash size={12} />删除群聊
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="pa-sheet__foot">
          <button className="pa-btn pa-btn--ghost" type="button" onClick={requestClose}>取消</button>
          <button className="pa-btn pa-btn--primary" type="button" disabled={members.length === 0} onClick={save}>
            保存
          </button>
        </div>
      </aside>
    </div>
  )
}
