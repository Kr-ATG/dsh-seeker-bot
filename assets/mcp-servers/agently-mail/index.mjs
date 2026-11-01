#!/usr/bin/env node
/**
 * agently-mail MCP server — 把腾讯 Agent Mail 的 CLI 包成 MCP。
 *
 * 为什么需要这一层：Agent Mail 官方只发了 CLI（@tencent-qqmail/agently-cli）和
 * skill，没有 MCP server。而 DSH 的连接器市场只认 MCP，所以这里做一个薄适配：
 * 每个工具 = spawn 一次 agently-cli，把它的 JSON 输出原样转成 MCP 的 content。
 *
 * 设计取舍：
 *  · 不引第三方 MCP SDK，手写 JSON-RPC over stdio（协议就三个方法，依赖越少越好）；
 *  · 不做缓存、不改写返回值 —— 模型看到的就是 CLI 吐的原始结构，出错时也能看到
 *    真实的错误体（ok:false + error），而不是被这层吞掉；
 *  · 所有参数都以 CLI 的 flag 形式透传，不做二次校验（CLI 自己会校验并给出可读错误）。
 *
 * 认证：token 存在系统 keychain 里（agently-cli auth login 写入），本进程不碰凭据。
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const CLI = 'agently-cli'
const VERSION = '1.0.0'

/** 从混着 tip 行的输出里抠出第一个完整 JSON 对象（用括号计数，不用正则）。 */
function extractJson(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** 跑一次 CLI，返回解析后的 JSON（失败时抛带 stderr 的错误）。 */
function runCli(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
      reject(new Error('agently-cli 超时（' + String(timeoutMs) + 'ms）'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', () => {
      clearTimeout(timer)
      const json = extractJson(out) ?? extractJson(err)
      if (json !== null) { resolve(json); return }
      reject(new Error((err || out || 'agently-cli 无输出').trim().slice(0, 800)))
    })
  })
}

/** 把 string[] 摊成重复的 flag。 */
function repeat(flag, values) {
  const list = []
  for (const value of values ?? []) {
    if (typeof value === 'string' && value !== '') list.push(flag, value)
  }
  return list
}

const TOOLS = [
  {
    name: 'mail_me',
    description: '查看当前 Agent Mail 邮箱地址、别名、附件大小限制与发信配额。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => runCli(['+me']),
  },
  {
    name: 'mail_list',
    description: '列出某个文件夹的邮件（默认 inbox）。返回 message_id / 主题 / 发件人 / 摘要 / 是否已读 / 是否有附件。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', enum: ['inbox', 'sent', 'trash', 'spam'], description: '文件夹，默认 inbox' },
        limit: { type: 'number', description: '每页条数（最大 50，默认 10）' },
        unreadOnly: { type: 'boolean', description: '只看未读' },
        hasAttachments: { type: 'boolean', description: '只看带附件的' },
        cursor: { type: 'string', description: '上一页返回的 next_cursor' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const argv = ['message', '+list']
      if (typeof args.dir === 'string') argv.push('--dir', args.dir)
      if (typeof args.limit === 'number') argv.push('--limit', String(Math.min(50, Math.max(1, Math.round(args.limit)))))
      if (args.unreadOnly === true) argv.push('--is-unread')
      if (args.hasAttachments === true) argv.push('--has-attachments')
      if (typeof args.cursor === 'string' && args.cursor !== '') argv.push('--cursor', args.cursor)
      return runCli(argv)
    },
  },
  {
    name: 'mail_read',
    description: '读一封邮件的完整内容（正文、附件列表、邮件头）。message_id 从 mail_list 或 mail_search 拿。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'message_id' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (typeof args.id !== 'string' || args.id === '') throw new Error('缺少 id')
      return runCli(['message', '+read', '--id', args.id])
    },
  },
  {
    name: 'mail_search',
    description: '按关键词搜索邮件（主题 / 正文 / 发件人）。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词' },
        limit: { type: 'number', description: '最多几条（默认 10）' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (typeof args.q !== 'string' || args.q === '') throw new Error('缺少 q')
      const argv = ['message', '+search', '--q', args.q]
      if (typeof args.limit === 'number') argv.push('--limit', String(Math.min(50, Math.max(1, Math.round(args.limit)))))
      return runCli(argv)
    },
  },
  {
    name: 'mail_send',
    description: '发送一封新邮件。收件人、抄送、密送都是数组；附件用本机绝对路径。发信有配额（见 mail_me）。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: '收件人邮箱' },
        subject: { type: 'string', description: '主题' },
        body: { type: 'string', description: '正文（纯文本或 Markdown）' },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        attachments: { type: 'array', items: { type: 'string' }, description: '本机附件绝对路径' },
        bodyFormat: { type: 'string', enum: ['plain', 'html', 'markdown'], description: '正文格式' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    run: async (args) => {
      const to = Array.isArray(args.to) ? args.to.filter((x) => typeof x === 'string' && x !== '') : []
      if (to.length === 0) throw new Error('缺少收件人')
      if (typeof args.subject !== 'string' || args.subject === '') throw new Error('缺少主题')
      if (typeof args.body !== 'string') throw new Error('缺少正文')
      const argv = ['message', '+send']
      argv.push(...repeat('--to', to))
      argv.push(...repeat('--cc', Array.isArray(args.cc) ? args.cc : []))
      argv.push(...repeat('--bcc', Array.isArray(args.bcc) ? args.bcc : []))
      argv.push('--subject', args.subject)
      argv.push('--body', args.body)
      if (typeof args.bodyFormat === 'string') argv.push('--body-format', args.bodyFormat)
      argv.push(...repeat('--attachment', Array.isArray(args.attachments) ? args.attachments : []))
      // 模型已经确认过要发，跳过 CLI 的两阶段确认
      argv.push('--confirmed')
      return runCli(argv, 120000)
    },
  },
  {
    name: 'mail_reply',
    description: '回复一封已有邮件。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '被回复的 message_id' },
        body: { type: 'string', description: '回复正文' },
      },
      required: ['id', 'body'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (typeof args.id !== 'string' || args.id === '') throw new Error('缺少 id')
      if (typeof args.body !== 'string') throw new Error('缺少正文')
      return runCli(['message', '+reply', '--id', args.id, '--body', args.body], 120000)
    },
  },
  {
    name: 'mail_forward',
    description: '转发一封邮件给新的收件人。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要转发的 message_id' },
        to: { type: 'array', items: { type: 'string' }, description: '新收件人' },
        body: { type: 'string', description: '附在转发上的一句话' },
      },
      required: ['id', 'to'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (typeof args.id !== 'string' || args.id === '') throw new Error('缺少 id')
      const to = Array.isArray(args.to) ? args.to.filter((x) => typeof x === 'string' && x !== '') : []
      if (to.length === 0) throw new Error('缺少收件人')
      const argv = ['message', '+forward', '--id', args.id, ...repeat('--to', to)]
      if (typeof args.body === 'string' && args.body !== '') argv.push('--body', args.body)
      return runCli(argv, 120000)
    },
  },
  {
    name: 'mail_trash',
    description: '把一封邮件移到废件箱（可恢复）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'message_id' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (typeof args.id !== 'string' || args.id === '') throw new Error('缺少 id')
      return runCli(['message', '+trash', '--id', args.id])
    },
  },
  {
    name: 'mail_delete',
    description: '从废件箱永久删除邮件并释放空间。传 id 删一封；传 all=true 清空废件箱。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'message_id' },
        all: { type: 'boolean', description: '清空整个废件箱' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      if (args.all === true) return runCli(['message', '+delete', '--all'])
      if (typeof args.id !== 'string' || args.id === '') throw new Error('缺少 id（或用 all=true 清空废件箱）')
      return runCli(['message', '+delete', '--id', args.id])
    },
  },
]

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]))

/** 把工具结果包成 MCP content。 */
function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/** 处理一条 JSON-RPC 请求。 */
async function handle(message) {
  const method = message.method
  if (method === 'initialize') {
    return {
      protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agently-mail', version: VERSION },
    }
  }
  if (method === 'tools/list') {
    return {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }
  }
  if (method === 'tools/call') {
    const name = message.params?.name
    const tool = TOOL_MAP.get(name)
    if (tool === undefined) throw new Error('unknown tool: ' + String(name))
    const args = message.params?.arguments ?? {}
    try {
      const value = await tool.run(args)
      return toolResult(value)
    } catch (error) {
      // 工具级失败按 MCP 约定走 isError，而不是让整个进程崩掉
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      }
    }
  }
  if (method === 'ping') return {}
  throw new Error('unsupported method: ' + String(method))
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try { message = JSON.parse(text) } catch { return }
  // 通知类消息（没有 id）不需要回复
  const isNotification = message.id === undefined
  void handle(message).then(
    (result) => {
      if (isNotification) return
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    },
    (error) => {
      if (isNotification) return
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      }) + '\n')
    },
  )
})
