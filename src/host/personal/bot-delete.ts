/**
 * Personal Agent — 删除一个 Bot 时清理宿主侧的全部残留。
 *
 * ## 它解决什么
 *
 * 前端的「删除 Bot」原来只做一件事：把它从 `pa:state:v1` 里摘掉。宿主侧的一切
 * 都还在——会话目录、派活花名册、工作记忆、产出物映射、Bot 页面、记忆条目、
 * 例行任务配置。用户看到的现象是「删了，但磁盘只涨不降」，更麻烦的是：
 *
 *  · `coordinate_bots` 的可派名单读的是**宿主侧花名册缓存**，不摘的话主 Bot
 *    下一轮还会看到那个「已删除」的 Bot，还能派活给它；
 *  · 会话目录不删，同 id 重建时会恢复出上一任的历史，新 Bot 一上来就带着
 *    别人的上下文；
 *  · 产出物映射不删，同名新 Bot 会被分到一个带 `-xxxx` 后缀的文件夹。
 *
 * 这个模块把那些残留按「Bot 身份」一次性清干净。
 *
 * ## 什么删、什么不删
 *
 * 删：会话历史、花名册缓存、工作记忆、产出物**映射**、Bot 页面、属于该 Bot 的
 *     记忆条目、例行任务与主动询问配置、创建账本、内存里的 agent。
 *
 * **不删：产出物目录本身。** 那是用户让它生成的真实文件——一个按钮不该无声
 * 抹掉用户的东西。默认保留，把绝对路径带回给前端提示「文件还在哪」；真要连
 * 文件一起删，显式传 `purgeFiles: true`。
 *
 * ## 容错
 *
 * 每一项单独 try/catch，失败只记进日志、不中断其余清理：删一半崩掉会让用户
 * 既删不干净、又不知道删到了哪。返回 `removed` 是为了让前端能如实告诉用户
 * 「清掉了哪些」，而不是一句含糊的「已删除」。
 */

import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { botSessionId, forgetBotAgent } from './agent.ts'
import { removeCreatedBot } from './bot-create.ts'
import { botOutputFolderOf, botOutputsRoot, forgetBotOutputDir } from './outputs.ts'
import { forgetBotSpec } from './runtime/registry.ts'
import { readProactive, readRoutines, writeProactive, writeRoutines } from './scheduler.ts'
import { workingMemoryFile } from './working-memory.ts'
import { getWebuiMemoryStore } from '../../triad/memory-store-singleton.ts'

/**
 * 主 Bot 的 id。
 *
 * 与 `src/client/personal/types.ts` 的 `MAIN_BOT_ID`、`triad/memory/engine/visibility.ts`
 * 的同名常量**必须逐字一致**——这里硬编码是因为宿主产物不能 import 前端代码。
 */
const MAIN_BOT_ID = 'bot-main-xiaomo'

function dshHome(): string {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

export interface BotPurgeResult {
  ok: boolean
  /** 清掉了哪些东西（给人看的短语，前端可直接拼进 toast）。 */
  removed: string[]
  /** 产出物目录的绝对路径（默认保留；`purgeFiles` 时是被删掉的那个路径）。 */
  outputDir?: string
  /** 产出物目录是否被一起删了。 */
  outputPurged?: boolean
  error?: string
}

/**
 * 找出某个 Bot 在所有工作区下的会话目录。
 *
 * 为什么要遍历：`pa-bot-v2-<id>` 会话落在**创建时所在工作区**的目录里，而
 * 工作区是可能变的（用户切过工作区再跟同一个 Bot 聊）。只删当前工作区那个
 * 会留下孤儿目录，`/reset` 之类按 sessionId 找会话的逻辑就会在别处命中旧历史。
 */
function sessionDirsOf(botId: string): string[] {
  const root = join(dshHome(), 'sessions')
  const target = botSessionId(botId)
  const out: string[] = []
  let workspaces: string[]
  try {
    workspaces = readdirSync(root)
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    const candidate = join(root, workspace, target)
    if (existsSync(candidate)) out.push(candidate)
  }
  return out
}

/**
 * 删掉属于该 Bot 的记忆条目（`owner = bot:<id>`）。
 *
 * 走 store 的 `removeEntriesWhere` 而不是逐条检索：记忆条目按 owner 分区存，
 * 逐条删要先把全部条目读进内存再筛，Bot 多了会很慢。
 *
 * 记忆模块没启用（单例为空）时返回 0——此时本来就没有条目可删。
 */
async function purgeMemories(botId: string): Promise<number> {
  const store: any = getWebuiMemoryStore()
  if (store === undefined || store === null || typeof store.removeEntriesWhere !== 'function') return 0
  const owner = `bot:${botId}`
  try {
    return await store.removeEntriesWhere((entry: any) => entry?.owner === owner)
  } catch {
    return 0
  }
}

/**
 * 彻底删掉一个 Bot 在宿主侧的一切痕迹。
 *
 * 幂等：重复调用不会报错（第二次多半什么也删不到，`removed` 为空）。
 *
 * @param botId - 要删的 Bot id。
 * @param options.purgeFiles - 是否连产出物目录一起删（默认 **false**，见文件头说明）。
 */
export async function purgeBot(botId: string, options: { purgeFiles?: boolean } = {}): Promise<BotPurgeResult> {
  const id = String(botId ?? '').trim()
  if (id === '') return { ok: false, removed: [], error: 'botId required' }
  if (id === MAIN_BOT_ID) return { ok: false, removed: [], error: '主 Bot 不能删除' }

  const removed: string[] = []

  // 1. 内存里的 agent 缓存（不先摘，后面删了会话目录它还会继续用内存那份）
  try {
    forgetBotAgent(id)
  } catch {
    /* 缓存不在也能继续 */
  }

  // 2. 会话历史
  for (const dir of sessionDirsOf(id)) {
    try {
      rmSync(dir, { recursive: true, force: true })
      if (!removed.includes('会话历史')) removed.push('会话历史')
    } catch {
      /* 被占用（agent 还在跑）：留痕即可，下次再删 */
    }
  }

  // 3. 派活花名册（不摘的话主 Bot 还会往这个「已删除」的 Bot 派活）
  try {
    if (forgetBotSpec(id)) removed.push('派活花名册')
  } catch {
    /* 运行时没起来：没有花名册可摘 */
  }

  // 4. 工作记忆
  try {
    const file = workingMemoryFile(id)
    if (existsSync(file)) {
      unlinkSync(file)
      removed.push('工作记忆')
    }
  } catch {
    /* 文件被占用：下次启动的 prune 会兜底 */
  }

  // 5. 先**只读**拿文件夹名：后面删 Pages 要用它拼路径，而删映射必须放在最后
  //    （Pages 就在产出物目录里，顺序反了会互相打架，见下面第 6 步的说明）。
  let folder: string | undefined
  try {
    folder = botOutputFolderOf(id)
  } catch {
    /* 映射文件坏了：本来也读不出来 */
  }

  /*
   * 6. Bot 页面（`<产出物根>/<folder>/网页/`）。
   *
   * 刻意**不用** `pagesDir(botId)`：那个函数内部会调 `ensureBotOutputDirs()`，
   * 在映射已被摘掉的情况下它会重新分配一个文件夹并写回映射——等于把刚清掉的
   * 东西又建回来（实测踩过：删完 Bot 一看，映射里又多了个 `Bot-xxxx`）。
   * 这里用只读拿到的 folder 自己拼。
   */
  if (folder !== undefined) {
    try {
      const dir = join(botOutputsRoot(), folder, '网页')
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
        removed.push('Bot 页面')
      }
    } catch {
      /* 被占用：下次启动的 prune 会兜底 */
    }
  }

  // 7. 产出物映射（只摘映射，目录留着）
  try {
    if (forgetBotOutputDir(id) !== undefined) removed.push('产出物映射')
  } catch {
    /* 映射文件坏了：本来也读不出来 */
  }

  // 7. 记忆条目
  const memoryCount = await purgeMemories(id)
  if (memoryCount > 0) removed.push(`记忆 ${memoryCount} 条`)

  // 8. 例行任务 / 主动询问（宿主侧配置，前端删 Bot 后不会再同步，得自己清）
  try {
    const routines = readRoutines()
    const kept = routines.filter((routine) => routine.botId !== id)
    if (kept.length !== routines.length) {
      writeRoutines(kept)
      removed.push('例行任务')
    }
  } catch {
    /* 配置写不进去：调度器下一 tick 会因为找不到 Bot 跳过 */
  }
  try {
    const configs = readProactive()
    const kept = configs.filter((config) => config.botId !== id)
    if (kept.length !== configs.length) {
      writeProactive(kept)
      removed.push('主动询问配置')
    }
  } catch {
    /* 同上 */
  }

  // 9. 创建账本（否则下次打开页面，启动补发会把这个 Bot 重新建回来）
  try {
    if (removeCreatedBot(id)) removed.push('创建账本')
  } catch {
    /* 账本坏了：删不到也不影响其它清理 */
  }

  // 10. 产出物目录：默认保留，只有显式要求才删
  let outputDir: string | undefined
  let outputPurged = false
  if (folder !== undefined) {
    outputDir = join(botOutputsRoot(), folder)
    if (options.purgeFiles === true && existsSync(outputDir)) {
      try {
        rmSync(outputDir, { recursive: true, force: true })
        outputPurged = true
        removed.push('产出物文件')
      } catch {
        /* 文件被别的程序占着：告诉前端目录还在 */
      }
    }
  }

  return {
    ok: true,
    removed,
    ...(outputDir !== undefined ? { outputDir } : {}),
    ...(outputPurged ? { outputPurged: true } : {}),
  }
}
