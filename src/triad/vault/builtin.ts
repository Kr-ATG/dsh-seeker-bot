/**
 * dsh-vault 内置凭据动作（零配置）。
 *
 * ── 这个模块要解决什么 ────────────────────────────────────────────────
 * 用户不想装 sshpass、也不想维护程序白名单，只想让 AI 能登录那台 VPS、
 * 调用一下已经存了 API Key 的服务。内置动作把这两种用法做成**默认开启、
 * 不需要任何配置**的能力：
 *
 *   · `vault_ssh`  —— 用记录里的 SSH 密码或私钥连接**记录自己的主机**，
 *     执行一条远程命令；
 *   · `vault_http` —— 用记录里的 API Key / Web Key 请求**记录自己的 URL**，
 *     支持自定义认证头。
 *
 * 关键安全边界：目标主机 / 域名只能来自档案记录本身，模型不能另行指定。
 * 密码只用于本地 SSH 握手或 HTTP 认证头，绝不返回给模型；输出照旧脱敏。
 * 这两条把「把密码发给攻击者」的最坏情况压回「只能发给用户自己存的主机」。
 */

import { Client } from 'ssh2'
import type { VaultConfig, VaultField, VaultRecord } from './types.js'
import { isFieldSensitive } from './types.js'
import type { VaultStore } from './store.js'

/** SSH 代用请求。 */
export interface BuiltinSshRequest {
  recordRef: string
  /** 远程命令（在目标主机上执行）。 */
  command: string
  timeoutMs?: number
}

/** HTTP 代用请求。 */
export interface BuiltinHttpRequest {
  recordRef: string
  /** 提供凭据的字段 key / 显示名。 */
  fieldRef: string
  method: string
  /** 完整 URL 或相对记录 base URL 的路径。 */
  url: string
  headers?: Record<string, string>
  body?: string
  /** 凭据放在哪个请求头（默认 Authorization）。 */
  authHeader?: string
  /** 头值前缀（默认 "Bearer "）。 */
  authPrefix?: string
  timeoutMs?: number
}

/** 单次输出上限。 */
const MAX_OUTPUT_BYTES = 256 * 1024
/** 默认超时。 */
const DEFAULT_TIMEOUT_MS = 30_000
/** 换行符。 */
const LF = String.fromCharCode(10)

/* ───────────────────────── SSH ───────────────────────── */

/**
 * 用档案记录里的 SSH 凭据执行远程命令。
 *
 * 只接受 record + command：host / username / port / password / privateKey
 * 全部从记录字段推导，模型没有覆盖入口。这是这个函数的第一道安全闸门。
 */
export async function runVaultSsh(
  store: VaultStore,
  config: VaultConfig,
  request: BuiltinSshRequest,
): Promise<BrokerResult> {
  if (config.credentialBuiltins === false) {
    return { ok: false, text: '内置凭据动作已关闭。请让用户在「操作间 → 档案 → 代用」里重新开启。' }
  }
  const command = request.command.trim()
  if (command === '') return { ok: false, text: 'command 不能为空。' }

  const resolved = await resolveRecord(store, request.recordRef)
  if ('error' in resolved) return { ok: false, text: resolved.error }
  const record = resolved.record
  const revealed = await store.getRecordRevealed(record.id)
  if (revealed === undefined) return { ok: false, text: '记录不存在或读不出来。' }

  const host = fieldValue(revealed.fields, ['ip', 'host', 'hostname', 'address', 'server'])
  if (host === '') {
    return { ok: false, text: '记录「' + record.title + '」里没有可用的主机地址（需要 ip / host / 服务器 这类字段）。' }
  }
  const username = fieldValue(revealed.fields, ['username', 'user', 'login', 'account']) || 'root'
  const port = parsePort(fieldValue(revealed.fields, ['ssh-port', 'ssh_port', 'port', 'sshport']))
  const passwordField = findPasswordField(revealed.fields)
  const keyField = findPrivateKeyField(revealed.fields)
  const credentialField = keyField ?? passwordField
  if (credentialField === undefined || credentialField.value === '') {
    return {
      ok: false,
      text: '记录「' + record.title + '」里没有可用的 SSH 密码或私钥字段（需要 password / ssh-private-key 这类加密字段）。',
    }
  }
  const secret = credentialField.value
  const authMode: 'key' | 'password' = keyField !== undefined ? 'key' : 'password'

  const timeoutMs = clampTimeout(request.timeoutMs ?? config.credentialTimeoutMs)
  const startedAt = Date.now()
  return await new Promise<BrokerResult>((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = async (code: number | null, signal: string | null, error?: Error): Promise<void> => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      // 无论成功还是失败都要断开连接：ssh2 的 Client 不主动 end 会一直占着
      // socket，测试里表现为 server.close() 永远不返回，生产里是连接泄漏。
      try { conn.end() } catch { /* 已断开 */ }
      const durationMs = Date.now() - startedAt
      const redactedOut = redactSecretText(stdout, secret)
      const redactedErr = redactSecretText(stderr, secret)
      await store.appendAudit({
        recordId: record.id,
        fieldKey: credentialField.key,
        via: 'builtin',
        action: 'exec',
        program: 'ssh',
        args: ('root@' + host + ': ' + command).slice(0, 500),
        purpose: ('内置 SSH：' + username + '@' + host + ':' + String(port)).slice(0, 200),
        exitCode: code,
        durationMs,
      }).catch(() => undefined)

      const lines: string[] = []
      lines.push('凭据代用（内置 SSH）：档案「' + record.title + '」→ ' + username + '@' + host + ':' + String(port))
      if (error !== undefined) {
        lines.push('状态：连接 / 执行失败：' + redactSecretText(error.message, secret))
      } else if (timedOut) {
        lines.push('状态：超时（' + String(timeoutMs) + ' ms），连接已关闭')
      } else if (signal !== null && signal !== undefined) {
        lines.push('状态：远程进程被信号 ' + signal + ' 终止')
      } else {
        lines.push('状态：执行完成（退出码 ' + String(code ?? '未知') + '，耗时 ' + String(durationMs) + ' ms）')
      }
      if (redactedOut !== '') lines.push('stdout：' + LF + redactedOut.replace(/\s+$/, ''))
      if (redactedErr !== '') lines.push('stderr：' + LF + redactedErr.replace(/\s+$/, ''))
      if (truncated) lines.push('（输出超过上限，已截断）')
      if (redactedOut === '' && redactedErr === '') lines.push('（没有输出）')
      resolve({
        ok: error === undefined && !timedOut && code === 0,
        text: lines.join(LF),
      })
    }

    const conn = new Client()
    timer = setTimeout(() => {
      timedOut = true
      try { conn.end() } catch { /* 已断开 */ }
      finish(null, null)
    }, timeoutMs)

    conn.on('ready', () => {
      conn.exec(command, (error, stream) => {
        if (error !== undefined && error !== null) {
          finish(null, null, error instanceof Error ? error : new Error(String(error)))
          return
        }
        stream.on('data', (chunk: Buffer) => {
          if (stdoutBytes >= MAX_OUTPUT_BYTES) { truncated = true; return }
          const room = MAX_OUTPUT_BYTES - stdoutBytes
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
          if (chunk.length > room) truncated = true
          stdout += slice.toString('utf8')
          stdoutBytes += slice.length
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          if (stderrBytes >= MAX_OUTPUT_BYTES) { truncated = true; return }
          const room = MAX_OUTPUT_BYTES - stderrBytes
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
          if (chunk.length > room) truncated = true
          stderr += slice.toString('utf8')
          stderrBytes += slice.length
        })
        stream.on('close', (code: number | null, signal: string | null) => {
          finish(code, signal)
        })
      })
    })
    conn.on('error', (error: Error) => { finish(null, null, error) })
    try {
      conn.connect({
        host,
        port,
        username,
        ...(authMode === 'key' ? { privateKey: secret } : { password: secret }),
        readyTimeout: Math.min(timeoutMs, 15_000),
      })
    } catch (error) {
      finish(null, null, error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/* ───────────────────────── HTTP ───────────────────────── */

/**
 * 用档案记录里的 API Key / Web Key 发 HTTP 请求。
 *
 * 目标 URL 必须落在记录自己的 URL 字段域名内（模型不能把密码发到别处）；
 * 请求不自动跟随重定向，避免跨域重定向把认证头带走。
 */
export async function runVaultHttp(
  store: VaultStore,
  config: VaultConfig,
  request: BuiltinHttpRequest,
): Promise<BrokerResult> {
  if (config.credentialBuiltins === false) {
    return { ok: false, text: '内置凭据动作已关闭。请让用户在「操作间 → 档案 → 代用」里重新开启。' }
  }
  const method = (request.method || 'GET').trim().toUpperCase()
  if (!/^[A-Z]+$/.test(method)) return { ok: false, text: 'method 不合法。' }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
    return { ok: false, text: 'method 只支持 GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS。' }
  }
  const resolved = await resolveRecord(store, request.recordRef)
  if ('error' in resolved) return { ok: false, text: resolved.error }
  const record = resolved.record
  const revealed = await store.getRecordRevealed(record.id)
  if (revealed === undefined) return { ok: false, text: '记录不存在或读不出来。' }

  const field = findField(revealed.fields, request.fieldRef)
  if (field === undefined) {
    return { ok: false, text: '记录「' + record.title + '」里没有字段「' + request.fieldRef + '」。' }
  }
  if (!isFieldSensitive(field)) return { ok: false, text: '字段「' + field.label + '」不是敏感字段，不需要代用。' }
  if (field.value === '') return { ok: false, text: '字段「' + field.label + '」是空的。' }
  const secret = field.value

  const bases = baseUrlsOf(revealed.fields)
  if (bases.length === 0) {
    return { ok: false, text: '记录「' + record.title + '」里没有可用的 URL 字段（url / base_url / gateway / 控制台地址），无法确定允许的目标域名。' }
  }
  const target = resolveTargetUrl(request.url, bases)
  if ('error' in target) return { ok: false, text: target.error }

  const headers: Record<string, string> = {}
  if (request.headers !== undefined) {
    for (const [name, value] of Object.entries(request.headers)) {
      if (!/^[A-Za-z0-9-]+$/.test(name)) return { ok: false, text: '请求头名称不合法：' + name }
      headers[name] = String(value)
    }
  }
  const authHeader = (request.authHeader ?? 'Authorization').trim()
  if (!/^[A-Za-z0-9-]+$/.test(authHeader)) return { ok: false, text: 'authHeader 不合法。' }
  headers[authHeader] = (request.authPrefix ?? 'Bearer ') + secret

  const timeoutMs = clampTimeout(request.timeoutMs ?? config.credentialTimeoutMs)
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(target.url, {
      method,
      headers,
      ...(request.body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body: request.body } : {}),
      redirect: 'manual',
      signal: controller.signal,
    })
    const raw = await response.text()
    const truncated = raw.length > 128 * 1024
    const body = redactSecretText(truncated ? raw.slice(0, 128 * 1024) : raw, secret)
    const durationMs = Date.now() - startedAt
    await store.appendAudit({
      recordId: record.id,
      fieldKey: field.key,
      via: 'builtin',
      action: 'exec',
      program: 'http',
      args: (method + ' ' + target.url).slice(0, 500),
      purpose: ('内置 HTTP：' + method + ' ' + target.url).slice(0, 200),
      exitCode: response.status,
      durationMs,
    }).catch(() => undefined)
    const lines = [
      '凭据代用（内置 HTTP）：档案「' + record.title + '」的「' + field.label + '」',
      '请求：' + method + ' ' + target.url,
      '状态：HTTP ' + String(response.status) + (response.statusText === '' ? '' : ' ' + response.statusText) + '（耗时 ' + String(durationMs) + ' ms）',
    ]
    const contentType = response.headers.get('content-type')
    if (contentType !== null) lines.push('Content-Type：' + contentType)
    if (body !== '') lines.push('响应：' + LF + body.replace(/\s+$/, ''))
    if (truncated) lines.push('（响应超过上限，已截断）')
    if (body === '') lines.push('（没有响应正文）')
    return { ok: response.ok, text: lines.join(LF) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = controller.signal.aborted
    return {
      ok: false,
      text: '凭据代用（内置 HTTP）：档案「' + record.title + '」的「' + field.label + '」'
        + LF + '状态：' + (timedOut ? '超时（' + String(timeoutMs) + ' ms）' : '请求失败：' + message),
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ───────────────────────── 字段推导 ───────────────────────── */

/** 按 key 优先顺序取第一个非空字段值。 */
function fieldValue(fields: VaultField[], keys: readonly string[]): string {
  for (const key of keys) {
    const field = fields.find((item) => item.key.toLowerCase() === key)
    if (field !== undefined && field.value.trim() !== '') return field.value.trim()
  }
  return ''
}

/** 找 SSH 密码字段（避开 Hysteria / VLESS 这类代理密码）。 */
function findPasswordField(fields: VaultField[]): VaultField | undefined {
  const exact = fields.find((field) => isFieldSensitive(field)
    && ['password', 'ssh-password', 'ssh_password', 'passwd', 'pwd'].includes(field.key.toLowerCase()))
  if (exact !== undefined) return exact
  return fields.find((field) => isFieldSensitive(field)
    && /密码|password|passwd/i.test(field.label)
    && !/hysteria|vless|reality|hy2|代理|proxy/i.test(field.label + ' ' + field.key))
}

/** 找 SSH 私钥字段。 */
function findPrivateKeyField(fields: VaultField[]): VaultField | undefined {
  return fields.find((field) => isFieldSensitive(field)
    && /private[_-]?key|ssh[_-]?key|私钥/i.test(field.key + ' ' + field.label))
}

/** 端口解析（非法值回到 22）。 */
function parsePort(value: string): number {
  const port = Number.parseInt(value, 10)
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : 22
}

/** 记录里所有可以当 base URL 的字段值。 */
function baseUrlsOf(fields: VaultField[]): string[] {
  const values: string[] = []
  for (const field of fields) {
    if (isFieldSensitive(field)) continue
    if (field.type !== 'url' && !/^(url|base_url|gateway|website|api_url|endpoint)$/i.test(field.key)) continue
    if (field.value.trim() !== '') values.push(field.value.trim())
  }
  return [...new Set(values)]
}

/** 解析目标 URL：相对路径拼到 base；绝对 URL 必须与记录里的域名一致。 */
function resolveTargetUrl(raw: string, bases: string[]): { url: string } | { error: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { error: 'url 不能为空。' }
  let parsed: URL | null = null
  if (/^https?:\/\//i.test(trimmed)) {
    try { parsed = new URL(trimmed) } catch { return { error: 'URL 无法解析：' + trimmed } }
  } else {
    try { parsed = new URL(trimmed, bases[0]) } catch { return { error: 'URL 无法解析：' + trimmed } }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: '只允许 http / https。' }
  const allowed = bases.map((base) => {
    try { return new URL(base) } catch { return null }
  }).filter((item): item is URL => item !== null)
  if (!allowed.some((base) => base.host === parsed.host)) {
    return {
      error: '目标地址 ' + parsed.host + ' 不在记录「' + bases.join('、') + '」的域名范围内。'
        + '为防止凭据被发到其它主机，只允许访问记录自己的 URL。',
    }
  }
  return { url: parsed.toString() }
}

/** 超时钳制：5 秒到 2 分钟。 */
function clampTimeout(value: number | undefined): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TIMEOUT_MS
  return Math.min(120_000, Math.max(5_000, Math.round(raw)))
}

/* ───────────────────────── 共享辅助 ───────────────────────── */

/** 动作结果（text 已经过脱敏，可直接交给模型）。 */
export interface BrokerResult {
  ok: boolean
  text: string
}

/** 低于这个长度的凭据拒绝处理：太短的串在输出里做替换会误伤正常文本。 */
const MIN_SECRET_CHARS = 6

/** 按 id、精确标题、唯一模糊标题找记录（返回掩码版即可，标题够用）。 */
export async function resolveRecord(
  store: VaultStore,
  ref: string,
): Promise<{ record: VaultRecord } | { error: string }> {
  const needle = ref.trim()
  if (needle === '') return { error: 'record 不能为空：请传记录 id（rec_ 开头）或记录标题。' }
  const records = await store.listRecords()
  const byId = records.find((record) => record.id === needle)
  if (byId !== undefined) return { record: byId }

  const lower = needle.toLowerCase()
  const exact = records.filter((record) => record.title.toLowerCase() === lower)
  if (exact.length === 1) return { record: exact[0] }
  const fuzzy = records.filter((record) => record.title.toLowerCase().includes(lower))
  if (fuzzy.length === 1) return { record: fuzzy[0] }
  if (fuzzy.length > 1) {
    const names = fuzzy.slice(0, 8).map((record) => '「' + record.title + '」(' + record.id + ')').join('、')
    return { error: '「' + needle + '」匹配到多条记录：' + names + '。请改用记录 id 精确指定。' }
  }
  return { error: '找不到「' + needle + '」对应的档案记录。' }
}

/** 按字段 key 或显示名找字段（key 优先，大小写不敏感）。 */
export function findField(fields: VaultField[], ref: string): VaultField | undefined {
  const needle = ref.trim()
  const byKey = fields.find((field) => field.key.toLowerCase() === needle.toLowerCase())
  if (byKey !== undefined) return byKey
  return fields.find((field) => field.label.trim() === needle)
}

/**
 * 把文本里出现的凭据及其常见编码变体替换成 ********。
 *
 * 变体覆盖：原文、URL 编码、base64 / base64url、hex（大小写）、JSON 转义。
 * 顺序按长度从长到短，避免 base64 串里恰好包含原文时被先拆碎。
 */
export function redactSecretText(text: string, secret: string): string {
  if (text === '' || secret === '' || secret.length < MIN_SECRET_CHARS) return text
  const variants = secretVariants(secret).sort((a, b) => b.length - a.length)
  let out = text
  for (const variant of variants) {
    if (variant.length < MIN_SECRET_CHARS) continue
    out = out.split(variant).join('********')
  }
  return out
}

/** 生成凭据的常见编码变体（全部为本机进程内计算，不落盘）。 */
function secretVariants(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8')
  const values = new Set<string>([secret])
  try { values.add(encodeURIComponent(secret)) } catch { /* 非法代理对 */ }
  const b64 = bytes.toString('base64')
  values.add(b64)
  values.add(b64.replace(/=+$/, ''))
  values.add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  const hex = bytes.toString('hex')
  values.add(hex)
  values.add(hex.toUpperCase())
  try { values.add(JSON.stringify(secret).slice(1, -1)) } catch { /* 忽略 */ }
  return [...values]
}
