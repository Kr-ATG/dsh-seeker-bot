/**
 * Personal Agent — 初始状态。
 *
 * 这里**只初始化一个主 Bot**，不预置任何子 Bot、群聊、消息、记忆、例行任务或期刊。
 * 之前版本的演示数据（Agent 安装 / 邮件 / 调研 / X / 图片视频 / GitHub / 知识库
 * 七个子 Bot，以及协作小组和两期示例期刊）已全部移除；旧 localStorage 由
 * store.tsx 的 migrateV1 清理。
 *
 * 主 Bot 是用户唯一初始实体：它在首次进入 Bot 模式时被创建（或从旧状态保留），
 * 名称/角色可改，其余内容全部由真实对话、真实模型与用户操作产生。
 */
import {
  DEFAULT_GROUP_ID,
  MAIN_BOT_ID,
  MODEL_FALLBACK,
  type AppState,
  type Bot,
} from './types'

const now = Date.now()

/** 旧版演示 Bot 的 id（迁移时整批清理）。 */
export const LEGACY_SEED_BOT_IDS = [
  'bot-agent-install',
  'bot-mail',
  'bot-research',
  'bot-x',
  'bot-media',
  'bot-github',
  'bot-kb',
] as const

/** 旧版演示群聊 / 分组 / 期刊 / 例行任务的 id（迁移时整批清理）。 */
export const LEGACY_SEED_ROOM_IDS = ['room-weekly'] as const
export const LEGACY_SEED_GROUP_IDS = ['group-pinned', 'group-project'] as const
export const LEGACY_SEED_ROUTINE_IDS = ['rt-mail', 'rt-research', 'rt-github', 'rt-journal'] as const
export const LEGACY_SEED_JOURNAL_IDS = ['journal-seed-1', 'journal-seed-0'] as const

/** 构造唯一的主 Bot（首次启动 / 旧状态里没有主 Bot 时使用）。 */
export function createMainBot(at = now): Bot {
  return {
    id: MAIN_BOT_ID,
    name: 'Seeker',
    role: '主助手',
    description: '你的主 Bot。所有子 Bot 都由它调度，也可以直接和它对话。',
    instructions:
      '你是「Seeker」，用户的主 Bot。你拥有所有子 Bot 的调度权：理解用户目标，自己处理或派给最合适的子 Bot，' +
      '并把结果汇总回来。你的语气沉稳、简洁，像一个可靠的总管。',
    avatar: { shape: 'blob', color: '#8b9099', tint: '#6b7079' },
    groupId: DEFAULT_GROUP_ID,
    isMain: true,
    status: 'online',
    unread: 0,
    pinned: true,
    enabled: true,
    model: MODEL_FALLBACK,
    skills: [],
    permission: 'full',
    eli5Mode: true,
    proactive: { enabled: true, freq: 'daily', from: '09:00', to: '22:00' },
    createdAt: at,
    createdBy: null,
  }
}

/** 干净初始状态：只有主 Bot 和一个默认分组。 */
export function createInitialState(): AppState {
  return {
    version: 2,
    bots: [createMainBot()],
    groups: [{ id: DEFAULT_GROUP_ID, name: '助手', order: 0 }],
    rooms: [],
    messages: [],
    memories: [],
    routines: [],
    calls: [],
    journals: [],
    journalLogs: [],
    tasks: [],
    settings: {
      theme: 'auto',
      showRightPanel: true,
      journalRule: { enabled: true, startHour: 0, endHour: 8, idleMinutes: 30 },
    },
    lastUserMessageAt: 0,
  }
}

/** 兼容旧导入名：初始状态不再包含任何演示期刊。 */
export function seedJournals(): [] {
  return []
}

export const SEED_STATE: AppState = createInitialState()
