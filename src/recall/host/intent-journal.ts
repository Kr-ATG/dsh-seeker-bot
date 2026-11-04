/**
 * dsh-recall-plugin — 操作意图 journal（A2，吸收 U4 留痕职能）
 *
 * 堵 execute both 分支的崩溃窗口：安全快照 → rollbackFor → rescue 中途断电
 * 时，安全快照 tag 已在磁盘而没有任何记录指向它——用户不知道工作区可能半
 * 回退，也不知道救援锚点存在。纪律：**先落意图再动磁盘，启动预热 / init
 * 时续做（recover）**。
 *
 * 判定顺序（stale journal 防线）：有记录先做幂等判定——工作区与目标
 * snap-<messageId> 一致说明回退实际已完成（clear 失败留下的残留记录），
 * 只清记录不 reset；否则残留记录会被误救援、把已完成的回退撤销回安全快照
 * （plan-quality-hardening A2，单测钉死该路径）。
 *
 * 写入走 writeTextViaShell（tmp+rename 原子写）；清空 = 写空串（不引入删除
 * 命令——读侧空串按「无记录」处理，同 format marker 语义）。journal 写失败
 * 只 recordError 告警、不阻断主流程（U4 纪律）。
 */

import type { StoreInfo } from '../types/state.js'
import type { RecallIntent } from '../types/payloads.js'
import type { PwshScripts, PosixScripts } from '../types/scripts.js'

export interface IntentJournalDeps {
  runShell(cmd: string, opts?: { timeoutMs?: number; stdoutMaxBytes?: number }): Promise<string>
  writeTextViaShell(file: string, text: string): Promise<void>
  scripts: PwshScripts | PosixScripts
  isWin: boolean
  recordError(text: string): void
  // ---- 恢复期动作注入（复用既有机制，不在本模块复制实现）----
  // 幂等判定：工作区与 snap-<messageId> 一致（diff 无差异）即回退已完成
  workspaceMatchesTag(messageId: string): Promise<boolean>
  // H1 救援的同款 reset（rescueScript + RESCUE_OK 哨兵），true = 已复位
  resetToSafety(store: StoreInfo, safetyId: string, root: string): Promise<boolean>
  // execute P0-1 同款护栏：工作区有 agent 在跑时不动文件
  agentBusy(root: string): boolean
}

export interface IntentJournal {
  begin(store: StoreInfo, root: string, fields: { messageId: string; safetyId: string; safetyOk: boolean }): Promise<void>
  advance(store: StoreInfo, phase: 'rollback' | 'rescue'): Promise<void>
  clear(store: StoreInfo): Promise<void>
  read(store: StoreInfo): Promise<RecallIntent | null>
  file(store: StoreInfo): string
  recover(store: StoreInfo): Promise<boolean>
}

const INTENT_VERSION = 1

// 意图摘要（告警文案用）：不嵌长路径，只给定位所需的最小信息
function describeIntent(intent: RecallIntent): string {
  return 'message=' + intent.messageId + ', phase=' + intent.phase + ', safety=snap-' + intent.safetyId
}

export function createIntentJournal(deps: IntentJournalDeps): IntentJournal {
  // 已判定过的 store 去重（预热 + init 双挂载点幂等）：同进程内不重复判定/
  // 告警。「读取命令失败」不入集——留给下一次 init 重试（瞬态 shell 故障
  // 不得吞掉恢复时机）
  const handled = new Set<string>()

  function intentFile(store: StoreInfo): string {
    return store.dir + (deps.isWin ? '\\' : '/') + 'recall-intent.json'
  }

  // 内部读：区分「定论（无记录/损坏）」与「读取命令失败」——前者可以入
  // handled 集，后者必须留给下一次 init 重试
  async function readRaw(store: StoreInfo): Promise<{ ok: boolean; intent: RecallIntent | null }> {
    let raw = ''
    try {
      raw = deps.scripts.stripBom(await deps.runShell(deps.scripts.fileReadCmd(intentFile(store)), { timeoutMs: 30000, stdoutMaxBytes: 65536 })).trim()
    } catch (error) {
      // 读取失败静默（不刷错误环）：恢复时机由下一次 init 续上
      return { ok: false, intent: null }
    }
    if (!raw) return { ok: true, intent: null } // 缺席 / 已清空（写空串）
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      if (!obj || obj.v !== INTENT_VERSION || obj.op !== 'execute'
        || typeof obj.messageId !== 'string' || !obj.messageId
        || typeof obj.safetyId !== 'string' || !obj.safetyId
        || (obj.phase !== 'rollback' && obj.phase !== 'rescue')) {
        // 形状不符按无处理：本地小文件，损坏不阻断启动（读取侧宽松纪律）
        return { ok: true, intent: null }
      }
      return {
        ok: true,
        intent: {
          v: INTENT_VERSION,
          op: 'execute',
          messageId: obj.messageId,
          root: typeof obj.root === 'string' ? obj.root : '',
          safetyId: obj.safetyId,
          safetyOk: obj.safetyOk !== false,
          phase: obj.phase,
          time: typeof obj.time === 'number' ? obj.time : 0,
        },
      }
    } catch (error) {
      // JSON 解析失败（原子写承诺下只可能是人为编辑/磁盘故障）按无处理
      return { ok: true, intent: null }
    }
  }

  async function write(store: StoreInfo, text: string): Promise<void> {
    try {
      await deps.writeTextViaShell(intentFile(store), text)
    } catch (error) {
      // U4 纪律：写失败只告警、不阻断主流程（execute 照常回退）
      deps.recordError('recall intent journal write failed: ' + String(error))
    }
  }

  function read(store: StoreInfo): Promise<RecallIntent | null> {
    return readRaw(store).then((r) => r.intent)
  }

  async function begin(store: StoreInfo, root: string, fields: { messageId: string; safetyId: string; safetyOk: boolean }): Promise<void> {
    const intent: RecallIntent = {
      v: INTENT_VERSION,
      op: 'execute',
      messageId: fields.messageId,
      root,
      safetyId: fields.safetyId,
      safetyOk: fields.safetyOk,
      phase: 'rollback',
      time: Date.now(),
    }
    await write(store, JSON.stringify(intent))
  }

  async function advance(store: StoreInfo, phase: 'rollback' | 'rescue'): Promise<void> {
    const cur = await read(store)
    // 无记录（begin 写失败/已被清）时不凭空造记录——推进只是「改写已有意图」
    if (cur) await write(store, JSON.stringify(Object.assign({}, cur, { phase })))
  }

  function clear(store: StoreInfo): Promise<void> {
    return write(store, '')
  }

  // 崩溃恢复：无记录 → 空操作；有记录 → 先幂等判定再动作（见文件头注释）
  async function recover(store: StoreInfo): Promise<boolean> {
    if (handled.has(store.dir)) return false
    const got = await readRaw(store)
    if (!got.ok) return false // 读取失败：不入集，下次 init 重试
    const intent = got.intent
    if (!intent) {
      handled.add(store.dir) // 无记录：定论，本轮不再查
      return false
    }
    // 幂等判定先行（stale journal 防线）：一致 = 回退实际已完成，只清记录
    if (await deps.workspaceMatchesTag(intent.messageId)) {
      await clear(store)
      handled.add(store.dir)
      return true
    }
    // safetyOk=false 即「需救援但无救援点」（安全快照当时就失败）——保留
    // 记录 + fail-loud，等下次启动重试（不能自动 reset：没有可复位目标）
    if (!intent.safetyOk) {
      deps.recordError('recall interrupted rollback detected, no safety snapshot: ' + describeIntent(intent) + '（记录保留于 ' + intentFile(store) + '）')
      handled.add(store.dir)
      return true
    }
    // P0-1 同款护栏：agent 在跑时不动工作区；不进程内重试（延后到下次 init）
    if (deps.agentBusy(intent.root)) {
      deps.recordError('recall interrupted rollback deferred (agent busy): ' + describeIntent(intent))
      return false
    }
    const reset = await deps.resetToSafety(store, intent.safetyId, intent.root)
    if (!reset) {
      // 复位失败（tag 被手工删除 / git 环境故障）：保留记录 + fail-loud，
      // 下次启动重试；同进程不循环写工作区
      deps.recordError('recall interrupted rollback rescue failed: ' + describeIntent(intent) + '（记录保留于 ' + intentFile(store) + '）')
      handled.add(store.dir)
      return true
    }
    await clear(store)
    handled.add(store.dir)
    deps.recordError('recovered interrupted rollback: ' + describeIntent(intent) + ' — 工作区已复位到安全快照')
    return true
  }

  return { begin, advance, clear, read, file: intentFile, recover }
}