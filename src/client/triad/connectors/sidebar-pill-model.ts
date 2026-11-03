/**
 * dsh-seeker-bot — 「MCP服务器」胶囊的纯数据模型（无 React / 无 DOM）。
 *
 * 单独拆出来的唯一理由：胶囊的图标清单来自两份宿主接口的合并，规则里最容易
 * 出错的是「目录 id → serverName 的换算」。这条换算必须与宿主
 * src/triad/mcp-catalog.ts 的 toServerName() 逐字一致——不一致的表现是
 * 已装条目的图标全部退回首字母，而且不报任何错。放在纯模块里，回归测试
 * 可以直接 import 断言，不需要搭 DOM 桩或连真实宿主。
 *
 * 数据口径：
 *   - /api/triad/mcp-status 是「已安装 MCP」的唯一真相（patch 条目 ∪ 运行时注册）；
 *   - /api/triad/mcp-catalog 提供图标文件名（iconFile）。
 */

/** 一颗已安装 MCP 的展示信息（图标 URL 可能为空 = 用首字母回落）。 */
export interface InstalledMcpIcon {
  /** 唯一键（serverName）。 */
  key: string
  /** 展示名（目录里的中文名优先，其次 serverName）。 */
  name: string
  /** 图标地址；null = 目录里没有这一条，用首字母圆标。 */
  iconUrl: string | null
  /** 首字母回落（中文名取第一个字）。 */
  fallback: string
  /** 条目在 patch 里被 disabled（仍然算已安装，只是画成半透明）。 */
  disabled: boolean
}

/** /api/triad/mcp-status 里本模块用到的字段（其余字段忽略）。 */
export interface McpStatusPayload {
  servers?: Array<{
    serverName?: unknown
    scope?: unknown
    config?: { disabled?: unknown }
  }>
}

/** /api/triad/mcp-catalog 里本模块用到的字段。 */
export interface McpCatalogPayload {
  entries?: Array<{
    id?: unknown
    name?: unknown
    iconFile?: unknown
  }>
}

/**
 * 目录 id → serverName（**必须与宿主 src/triad/mcp-catalog.ts 的 toServerName 一致**）：
 * 非 [A-Za-z0-9_-] 的字符换成短横线、截断 32 位。宿主安装时用这条规则写 patch，
 * 这里用同一条规则反查图标；两处不一致会让已装条目的图标全部退回首字母。
 * @param id 目录条目 id。
 * @returns 对应的 serverName。
 */
export function toServerName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32)
}

/**
 * 把两份接口数据合并成胶囊要画的图标清单。
 *
 * 顺序沿用宿主 /mcp-status 的顺序（宿主已按 serverName 排序）；同一 serverName
 * 只取第一条（理论上不会重复，防御脏数据）。目录里没有的 server 保留，用
 * serverName 当展示名、首字母当图标。
 * @param status /api/triad/mcp-status 的 JSON。
 * @param catalog /api/triad/mcp-catalog 的 JSON（拉不到时传空对象）。
 * @returns 已安装 MCP 的展示清单。
 */
export function mergeInstalledIcons(
  status: McpStatusPayload,
  catalog: McpCatalogPayload,
): InstalledMcpIcon[] {
  const servers = Array.isArray(status.servers) ? status.servers : []
  const entries = Array.isArray(catalog.entries) ? catalog.entries : []
  const byServer = new Map<string, { name: string; iconFile: string }>()
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || entry.id === '') continue
    const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id
    const iconFile = typeof entry.iconFile === 'string' ? entry.iconFile : ''
    byServer.set(toServerName(entry.id), { name, iconFile })
  }
  const out: InstalledMcpIcon[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    const serverName = typeof server.serverName === 'string' ? server.serverName : ''
    if (serverName === '' || seen.has(serverName)) continue
    seen.add(serverName)
    const hit = byServer.get(serverName)
    const name = hit?.name ?? serverName
    out.push({
      key: serverName,
      name,
      iconUrl: hit !== undefined && hit.iconFile !== ''
        ? '/api/chat-flow/mcp-icons/' + encodeURIComponent(hit.iconFile)
        : null,
      fallback: name.slice(0, 1).toUpperCase(),
      disabled: server.config?.disabled === true,
    })
  }
  return out
}
