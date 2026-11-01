/**
 * dsh-seeker-bot — 「连接器」页（操作间里 SKILL 下面那一格）。
 *
 * ── 这是什么 ────────────────────────────────────────────────────────
 * 一个 MCP 连接器市场：精选目录（随包分发）+ 搜索 + 分类 + 一键安装。
 * 目录数据来自 assets/mcp-catalog/catalog.json（56 条，国内 14 / 国外 42，
 * 每条都验过包在 npm/pypi 上真实存在，图标自托管在 assets/mcp-catalog/icons/）。
 *
 * ── 为什么自己做目录而不是接第三方市场 ──────────────────────────────
 * 调研了 12 个开源 agent（Cline / Hermes / Cherry Studio / Chatbox / 5ire /
 * LobeChat / Continue / LibreChat / Open WebUI / Jan / Witsy / DeepChat）：
 * 没有一家接第三方全量市场，全是自建精选（规模 3~203 条）。Cline 用静态
 * catalog.json 托管在 GitHub Pages，Hermes 用仓库里 66 个 manifest.yaml。
 * 我们照做，并把国内应用那半边补上（Cline/Hermes 一条国内都没有）。
 *
 * ── 安装落地 ────────────────────────────────────────────────────────
 * POST /api/triad/mcp-catalog/install → 宿主往 cordis.patch.yml 追加一条
 * @deepseek-ai/dsh-mcp-client 实例。mcp-client 条目增删不走热重载，
 * 所以装完要提示用户重启 DSH（页面里明说，不假装已经生效）。
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { css, ensureConnectorsStyles } from './styles.js'

/** 面板 props（与记忆 / 技能 / 档案面板同形）。 */
export interface ConnectorsPanelProps {
  onClose: () => void
  embedded?: boolean
}

/** 目录条目（与宿主 catalog 字段对齐）。 */
interface CatalogEnvField {
  name: string
  required?: boolean
  label?: string
  secret?: boolean
  url?: string
}

interface CatalogEntry {
  id: string
  name: string
  nameEn?: string
  tagline?: string
  description?: string
  category?: string
  region?: 'cn' | 'global'
  author?: string
  repo?: string
  install: { type: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; env?: CatalogEnvField[]; auth?: string }
  /** 有这一项才显示「开始授权」按钮（目录里声明的，前端只点不管命令）。 */
  authorize?: {
    requiresFile?: string
    requiresLabel?: string
    setupUrl?: string
    doneHint?: string
  }
  iconFile?: string
  featured?: boolean
}

/** 授权接口返回。 */
interface AuthorizeResult {
  ok: boolean
  started?: boolean
  needsSetup?: boolean
  requiresFile?: string
  requiresLabel?: string
  setupUrl?: string
  message?: string
}

interface CatalogFile {
  counts: { total: number; cn: number; global: number }
  categories: Array<{ id: string; label: string; count: number }>
  entries: CatalogEntry[]
}

/** 页面相位。 */
type Phase = 'loading' | 'ready' | 'error'

/** 安装结果。 */
interface InstallResult {
  ok: boolean
  error?: string
  serverName?: string
  alreadyInstalled?: boolean
  updated?: boolean
  needsRestart?: boolean
}

/** 图标地址（宿主路由，按文件名精确匹配）。 */
function iconUrl(file: string | undefined): string {
  if (file === undefined || file === '') return ''
  return '/api/chat-flow/mcp-icons/' + encodeURIComponent(file)
}

/** 安装配置的一行人类可读描述。 */
function installSummary(entry: CatalogEntry): string {
  const inst = entry.install
  if (inst.type === 'http') return '远程 HTTP · ' + (inst.url ?? '')
  const args = (inst.args ?? []).join(' ')
  return '本地 stdio · ' + (inst.command ?? 'npx') + ' ' + args
}

/** 一条已装连接器在 patch 里的现状。 */
interface InstalledState {
  serverName: string
  env: Record<string, string>
}

/**
 * 已装状态（catalog id → 当前配置）。
 *
 * 走 mcp-catalog 自己的 /state 而不是 mcp-status：后者只回 serverName，
 * 而详情弹窗要把已写入的密钥回填进输入框 —— 否则用户装完就再也改不了。
 */
async function fetchState(): Promise<Record<string, InstalledState>> {
  try {
    const res = await fetch('/api/triad/mcp-catalog/state', { headers: { accept: 'application/json' } })
    if (!res.ok) return {}
    const body = (await res.json()) as { items?: Record<string, InstalledState> }
    return body.items ?? {}
  } catch {
    return {}
  }
}

/** 拉目录。 */
async function fetchCatalog(): Promise<CatalogFile> {
  const res = await fetch('/api/triad/mcp-catalog', { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error('目录读取失败（HTTP ' + String(res.status) + '）')
  return (await res.json()) as CatalogFile
}

/** 提交安装（overwrite=true 表示覆盖已装条目，用于改密钥）。 */
async function postInstall(id: string, env: Record<string, string>, overwrite: boolean): Promise<InstallResult> {
  const res = await fetch('/api/triad/mcp-catalog/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ id, env, overwrite }),
  })
  const body = (await res.json().catch(() => ({ ok: false, error: '响应无法解析' }))) as InstallResult
  return body
}

/** 点一下开始授权（宿主按目录声明 spawn 授权命令，自己会弹浏览器）。 */
async function postAuthorize(id: string): Promise<AuthorizeResult> {
  const res = await fetch('/api/triad/mcp-catalog/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ id }),
  })
  const body = (await res.json().catch(() => ({ ok: false, message: '响应无法解析' }))) as AuthorizeResult
  return body
}

/** 提交卸载。 */
async function postUninstall(id: string): Promise<InstallResult> {
  const res = await fetch('/api/triad/mcp-catalog/uninstall', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ id }),
  })
  const body = (await res.json().catch(() => ({ ok: false, error: '响应无法解析' }))) as InstallResult
  return body
}

/** 搜索图标。 */
function SearchIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

/** 卡片图标（加载失败回落到首字母块）。 */
function CardIcon({ entry, size }: { entry: CatalogEntry; size: number }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const url = iconUrl(entry.iconFile)
  const style = { width: size, height: size } as const
  if (url === '' || broken) {
    return (
      <div className={css.cardIconFallback} style={style} aria-hidden="true">
        {entry.name.slice(0, 1)}
      </div>
    )
  }
  return (
    <img
      className={css.cardIcon}
      style={style}
      src={url}
      alt=""
      loading="lazy"
      onError={() => { setBroken(true) }}
    />
  )
}

/** 安装状态筛选的三段。 */
const SEGMENTS: ReadonlyArray<{ key: 'all' | 'installed' | 'uninstalled'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'uninstalled', label: '未安装' },
  { key: 'installed', label: '已安装' },
]

export function ConnectorsPanel({ embedded = false }: ConnectorsPanelProps): JSX.Element {
  ensureConnectorsStyles()

  const [phase, setPhase] = useState<Phase>('loading')
  const [catalog, setCatalog] = useState<CatalogFile | null>(null)
  const [installedState, setInstalledState] = useState<Record<string, InstalledState>>({})
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState('全部')
  const [detail, setDetail] = useState<CatalogEntry | null>(null)
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({})
  const [installing, setInstalling] = useState(false)
  const [installMsg, setInstallMsg] = useState('')
  const [installOk, setInstallOk] = useState(true)
  const [authBusy, setAuthBusy] = useState(false)
  const [authResult, setAuthResult] = useState<AuthorizeResult | null>(null)
  /** 安装状态筛选：全部 / 未安装 / 已安装。 */
  const [installFilter, setInstallFilter] = useState<'all' | 'installed' | 'uninstalled'>('all')
  /** 内容区滚动容器（页头滚轮要转发给它）。 */
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(() => {
    setPhase('loading')
    setError('')
    Promise.all([fetchCatalog(), fetchState()])
      .then(([cat, ins]) => {
        setCatalog(cat)
        setInstalledState(ins)
        setPhase('ready')
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      })
  }, [])

  useEffect(() => { load() }, [load])

  /** 分类胶囊：固定四项 + 目录里真实有货的分类。 */
  const chips = useMemo(() => {
    if (catalog === null) return ['全部']
    const list = ['全部', '精选', '国内', '国外']
    for (const cat of catalog.categories) {
      if (cat.count > 0) list.push(cat.label)
    }
    return list
  }, [catalog])

  /** 过滤后的条目。 */
  const filtered = useMemo(() => {
    const entries = catalog?.entries ?? []
    const q = query.trim().toLowerCase()
    return entries.filter((entry) => {
      const isInstalled = installedState[entry.id] !== undefined
      if (installFilter === 'installed' && !isInstalled) return false
      if (installFilter === 'uninstalled' && isInstalled) return false
      if (chip === '精选' && entry.featured !== true) return false
      if (chip === '国内' && entry.region !== 'cn') return false
      if (chip === '国外' && entry.region !== 'global') return false
      if (chip !== '全部' && chip !== '精选' && chip !== '国内' && chip !== '国外' && entry.category !== chip) return false
      if (q === '') return true
      const hay = (entry.name + ' ' + (entry.nameEn ?? '') + ' ' + (entry.tagline ?? '') + ' ' + (entry.category ?? '')).toLowerCase()
      return hay.includes(q)
    })
  }, [catalog, chip, query, installFilter, installedState])

  /** 按分类分组（「全部」时分组显示，其余平铺）。 */
  const groups = useMemo(() => {
    if (chip !== '全部') return [{ label: '', items: filtered }]
    const map = new Map<string, CatalogEntry[]>()
    for (const entry of filtered) {
      const key = entry.category ?? '其它'
      const list = map.get(key) ?? []
      list.push(entry)
      map.set(key, list)
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }))
  }, [filtered, chip])

  const openDetail = useCallback((entry: CatalogEntry) => {
    setDetail(entry)
    // 已装过就把 patch 里的当前值回填进输入框 —— 否则用户装完就再也改不了密钥
    setEnvDraft({ ...(installedState[entry.id]?.env ?? {}) })
    setInstallMsg('')
    setAuthResult(null)
  }, [installedState])

  const closeDetail = useCallback(() => {
    setDetail(null)
    setInstallMsg('')
  }, [])

  const doInstall = useCallback(async () => {
    if (detail === null) return
    const isUpdate = installedState[detail.id] !== undefined
    setInstalling(true)
    setInstallMsg('')
    try {
      const result = await postInstall(detail.id, envDraft, isUpdate)
      if (!result.ok) {
        setInstallOk(false)
        setInstallMsg(result.error ?? '安装失败')
      } else {
        setInstallOk(true)
        setInstallMsg(isUpdate ? '配置已更新，几秒内自动生效。' : '已安装，几秒内自动生效。')
        setInstalledState(await fetchState())
      }
    } catch (err) {
      setInstallOk(false)
      setInstallMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }, [detail, envDraft, installedState])

  const doAuthorize = useCallback(async () => {
    if (detail === null) return
    setAuthBusy(true)
    setAuthResult(null)
    try {
      setAuthResult(await postAuthorize(detail.id))
    } catch (err) {
      setAuthResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setAuthBusy(false)
    }
  }, [detail])

  const doUninstall = useCallback(async () => {
    if (detail === null) return
    setInstalling(true)
    setInstallMsg('')
    try {
      const result = await postUninstall(detail.id)
      if (!result.ok) {
        setInstallOk(false)
        setInstallMsg(result.error ?? '卸载失败')
      } else {
        setInstallOk(true)
        setInstallMsg('已卸载，几秒内自动生效。')
        setInstalledState(await fetchState())
        setEnvDraft({})
      }
    } catch (err) {
      setInstallOk(false)
      setInstallMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }, [detail])

  /** 当前打开的详情是否已装（决定按钮是「安装」还是「保存配置 + 卸载」）。 */
  const isDetailInstalled = detail !== null && installedState[detail.id] !== undefined

  /**
   * 页头区域的滚轮转发。
   *
   * 内容区（.dsh-mc-scroll）和页头（标题 / 搜索框 / 分类条）是**兄弟**，
   * 滚轮事件在页头上冒泡时根本经过不了滚动容器，于是鼠标停在搜索框那一带
   * 滚页面不动（用户反馈的「无法鼠标滚动」就是这个）。这里手动把增量转过去。
   */
  const onRootWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const scroll = scrollRef.current
    if (scroll === null) return
    const target = event.target
    if (target instanceof Node && scroll.contains(target)) return
    scroll.scrollTop += event.deltaY
  }, [])

  const requiredFilled = useMemo(() => {
    if (detail === null) return true
    for (const field of detail.install.env ?? []) {
      if (field.required === true && (envDraft[field.name] ?? '').trim() === '') return false
    }
    return true
  }, [detail, envDraft])

  return (
    <div className={css.root} onWheel={onRootWheel}>
      <div className={css.head}>
        <div className={css.headTop}>
          <div>
            <span className={css.eyebrow}><i />Connectors</span>
            <h1 className={css.title}>连接器 <em>/ 能接什么</em></h1>
            <p className={css.sub}>精选 MCP 连接器，装一个就能让模型用上它。国内国外都有。</p>
          </div>
          <div className={css.headRight}>
            <span className={css.count}>
              {catalog === null ? '' : String(filtered.length) + ' / ' + String(catalog.counts.total)}
            </span>
            <div className={css.segmented} role="group" aria-label="按安装状态筛选">
              {SEGMENTS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={item.key === installFilter ? css.segBtn + ' ' + css.segBtnOn : css.segBtn}
                  onClick={() => { setInstallFilter(item.key) }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={css.search}>
          <SearchIcon />
          <input
            className={css.searchInput}
            value={query}
            placeholder="搜索连接器（高德、飞书、GitHub、Notion…）"
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </div>

        <div className={css.chips}>
          {chips.map((name) => (
            <button
              key={name}
              type="button"
              className={name === chip ? css.chip + ' ' + css.chipOn : css.chip}
              onClick={() => { setChip(name) }}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className={css.scroll} ref={scrollRef}>
        {phase === 'loading' && <div className={css.empty}>正在读取连接器目录…</div>}
        {phase === 'error' && <div className={css.empty + ' ' + css.error}>{error}</div>}
        {phase === 'ready' && filtered.length === 0 && (
          <div className={css.empty}>没有符合条件的连接器</div>
        )}
        {phase === 'ready' && groups.map((group) => (
          <div key={group.label === '' ? '_all' : group.label} className={css.section}>
            {group.label !== '' && (
              <div className={css.sectionHead}>
                <span className={css.sectionTitle}>{group.label}</span>
                <span className={css.count}>{String(group.items.length)}</span>
              </div>
            )}
            <div className={css.grid}>
              {group.items.map((entry) => {
                const isInstalled = installedState[entry.id] !== undefined
                return (
                  <div
                    key={entry.id}
                    className={css.card}
                    role="button"
                    tabIndex={0}
                    onClick={() => { openDetail(entry) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(entry) }
                    }}
                  >
                    <CardIcon entry={entry} size={40} />
                    <div className={css.cardBody}>
                      <span className={css.cardName}>{entry.name}</span>
                      <span className={css.cardTag}>{entry.tagline ?? entry.description ?? ''}</span>
                    </div>
                    <div className={css.cardAction}>
                      {isInstalled
                        ? <span className={css.installedBtn}>已安装</span>
                        : <span className={css.addBtn}>添加</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {detail !== null && (
        <div className={css.drawerMask} onClick={closeDetail} role="presentation">
          <div className={css.drawer} onClick={(event) => { event.stopPropagation() }} role="dialog" aria-label={detail.name}>
            <div className={css.drawerHead}>
              <CardIcon entry={detail} size={48} />
              <div className={css.drawerTitles}>
                <div className={css.drawerName}>{detail.name}</div>
                <div className={css.drawerAuthor}>
                  {(detail.author ?? '') + (detail.category === undefined ? '' : ' · ' + detail.category)}
                </div>
              </div>
              <button type="button" className={css.closeBtn} onClick={closeDetail} aria-label="关闭">×</button>
            </div>

            <div className={css.drawerBody}>
              <p className={css.desc}>{detail.description ?? detail.tagline ?? ''}</p>

              <div className={css.metaRow}>
                <span className={css.metaKey}>连接方式</span>
                <span className={css.metaVal}>{installSummary(detail)}</span>
              </div>
              {detail.install.auth === 'oauth' && (
                <div className={css.metaRow}>
                  <span className={css.metaKey}>授权</span>
                  <span className={css.metaVal}>首次连接时浏览器 OAuth 授权</span>
                </div>
              )}
              {detail.repo !== undefined && detail.repo !== '' && (
                <div className={css.metaRow}>
                  <span className={css.metaKey}>来源</span>
                  <span className={css.metaVal}>{detail.repo}</span>
                </div>
              )}

              {(detail.install.env ?? []).length > 0 && (
                <div>
                  {(detail.install.env ?? []).map((field) => (
                    <div key={field.name} className={css.field} style={{ marginBottom: 10 }}>
                      <label className={css.fieldLabel} htmlFor={'env-' + field.name}>
                        {(field.label ?? field.name) + (field.required === true ? ' *' : '')}
                      </label>
                      <input
                        id={'env-' + field.name}
                        className={css.fieldInput}
                        type={field.secret === true ? 'password' : 'text'}
                        value={envDraft[field.name] ?? ''}
                        placeholder={field.name}
                        onChange={(event) => {
                          const next = event.target.value
                          setEnvDraft((prev) => ({ ...prev, [field.name]: next }))
                        }}
                      />
                      {field.url !== undefined && (
                        <span className={css.fieldHint}>获取地址：{field.url}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {detail.authorize !== undefined && (
                <div className={css.authBox}>
                  <div className={css.authHead}>需要登录一次</div>
                  <div className={css.authHint}>
                    这个连接器要授权你的第三方账号。点下面按钮会拉起浏览器，凭据只存在本机
                    {detail.authorize.requiresFile !== undefined ? '（' + detail.authorize.requiresFile + '）' : ''}
                    ，不会上传。
                  </div>
                  <div className={css.authRow}>
                    <button
                      type="button"
                      className={css.primaryBtn}
                      disabled={authBusy}
                      onClick={() => { void doAuthorize() }}
                    >
                      {authBusy ? '正在拉起浏览器…' : '打开浏览器授权'}
                    </button>
                    {detail.authorize.setupUrl !== undefined && (
                      <button
                        type="button"
                        className={css.linkBtn}
                        onClick={() => { window.open(detail.authorize?.setupUrl ?? '', '_blank', 'noopener') }}
                      >
                        先去准备凭据 ↗
                      </button>
                    )}
                  </div>
                  {authResult !== null && (
                    <div className={css.notice + (authResult.ok ? '' : ' ' + css.error)} style={{ margin: '8px 0 0' }}>
                      {authResult.message}
                      {authResult.needsSetup === true && authResult.setupUrl !== undefined && (
                        <>
                          {' '}
                          <a
                            href={authResult.setupUrl}
                            target="_blank"
                            rel="noreferrer"
                            className={css.authLink}
                          >
                            去获取
                          </a>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {installMsg !== '' && (
                <div className={css.notice + (installOk ? '' : ' ' + css.error)}>
                  {installMsg}
                </div>
              )}
            </div>

            <div className={css.drawerFoot}>
              <button
                type="button"
                className={css.primaryBtn}
                disabled={installing || !requiredFilled}
                onClick={() => { void doInstall() }}
              >
                {installing ? '正在保存…' : isDetailInstalled ? '保存配置' : '安装连接器'}
              </button>
              {isDetailInstalled && (
                <button
                  type="button"
                  className={css.dangerBtn}
                  disabled={installing}
                  onClick={() => { void doUninstall() }}
                >
                  卸载
                </button>
              )}
              <button type="button" className={css.ghostBtn} onClick={closeDetail}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
