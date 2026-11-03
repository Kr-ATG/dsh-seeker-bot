/**
 * dsh-seeker-bot — MCP 与 Skill 能力调用清单弹窗（卡头动作弹窗）。
 *
 * 遵循用户要求重构（2026-11-01）：
 * 1. 明确展示是什么 MCP（例如「高德地图」），而非生硬的英文底层工具名；
 * 2. 当 MCP 多时按 MCP 服务进行优雅的分组与手风琴折叠展示；
 * 3. 移除「所属会话」列，布局更舒展；
 * 4. 采用专属的 MCP（连接器）与 Skill（闪电）图标；
 * 5. 严格继承 Git 大盘（GitRosterModal）840px 现代宽幅低饱和设计风格。
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { MODAL_ANIM_MS } from '../modal-animation.ts'
import { getCapabilitiesStore, useCapabilitiesSnapshot } from './capabilities-store.ts'
import type { CapabilityItem } from './capabilities-store.ts'

/** 常见 MCP 服务的友好中文显示名与描述 */
export const KNOWN_MCP_SERVERS: Record<string, { label: string; desc: string }> = {
  amap: { label: '高德地图', desc: '地图检索、天气预报、地理与逆地理编码、周边搜索、路径规划' },
  'playwright-mcp': { label: 'Playwright 浏览器', desc: '浏览器自动化操控、页面访问、点击与截图' },
  filesystem: { label: '本地文件系统', desc: '本地文件读写、目录浏览与文件搜索' },
  github: { label: 'GitHub 代码仓', desc: '仓库、提交历史、Issue 与 PR 协作' },
  database: { label: '数据库服务', desc: 'SQL 执行与数据库查询交互' },
  slack: { label: 'Slack 通讯', desc: '团队频道消息与通知管理' },
  fetch: { label: '网络抓取', desc: '外部 HTTP/HTTPS 网页内容提取' },
  websearch: { label: '网络搜索', desc: '实时网页内容搜索与问答' },
  puppeteer: { label: 'Puppeteer 浏览器', desc: 'Chrome/Chromium 自动化操控' },
  git: { label: 'Git 仓库', desc: '本地版本库与提交操作' },
  memory: { label: '长期记忆', desc: '知识库记忆检索与存储' },
}

export function getMcpServerInfo(server: string | undefined): { label: string; desc: string } {
  if (!server) return { label: '未知服务', desc: '' }
  const lower = server.toLowerCase()
  const hit = KNOWN_MCP_SERVERS[lower]
  if (hit) return hit
  // 智能格式化兜底
  const clean = server.replace(/-mcp$/i, '').replace(/[-_]/g, ' ')
  const label = clean.charAt(0).toUpperCase() + clean.slice(1)
  return { label: `${label} 服务`, desc: '' }
}

/** 常见工具名称的友好中文释义 */
export const TOOL_FRIENDLY_NAMES: Record<string, string> = {
  maps_text_search: '关键字搜索',
  maps_around_search: '周边地点搜索',
  maps_geo: '地理编码 (地址转坐标)',
  maps_regeocode: '逆地理编码 (坐标转地址)',
  maps_weather: '天气查询',
  maps_direction_driving: '驾车路线规划',
  maps_direction_walking: '步行路线规划',
  maps_direction_transit_integrated: '公交路线规划',
  maps_direction_bicycling: '骑行路线规划',
  maps_distance: '距离测量',
  maps_search_detail: '地点详情查询',
  maps_ip_location: 'IP 地址定位',
  browser_click: '点击页面元素',
  browser_navigate: '导航访问网页',
  browser_screenshot: '屏幕截图',
  browser_type: '输入表单内容',
  browser_fill: '表单填写',
  browser_select: '选择下拉选项',
  browser_hover: '悬停在元素',
}

export function getToolFriendlyName(tool: string | undefined): string {
  if (!tool) return ''
  return TOOL_FRIENDLY_NAMES[tool] || ''
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return '-'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

export function CapabilitiesModal(): ReactElement | null {
  const store = getCapabilitiesStore()
  const snapshot = useCapabilitiesSnapshot()
  const [activeTab, setActiveTab] = useState<'all' | 'mcp' | 'skill'>('all')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  const open = snapshot.open
  const loading = snapshot.loading
  const items = snapshot.items
  const mcpCount = snapshot.mcpCount
  const skillCount = snapshot.skillCount
  const mcpTotalCalls = snapshot.mcpTotalCalls
  const skillTotalCalls = snapshot.skillTotalCalls

  const onClose = useCallback(() => {
    store.setOpen(false)
  }, [store])

  /*
   * 退场动画状态机（与 GitRosterModal 同一套）：置 closing 让样式表播 240ms 收回
   * 动画，播完才执行真正的 onClose。两个弹窗共用 kr-git-roster-overlay /
   * kr-git-roster-modal 两个 class，所以退场 keyframes 也共用一份，样式只改一处。
   */
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  const requestClose = useCallback((): void => {
    if (closeTimerRef.current !== null) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setClosing(false)
      onClose()
    }, MODAL_ANIM_MS)
  }, [onClose])

  // 卸载时清掉未完成的定时器，避免回调打到已卸载的组件上。
  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
  }, [])

  const onRefresh = useCallback(() => {
    void store.refresh()
  }, [store])

  const toggleGroupCollapse = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupKey]: !prev[groupKey],
    }))
  }, [])

  // 支持 Escape 键关闭（走 requestClose，退场动画播完才真正关）
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, requestClose])

  // 按 MCP 服务（server）进行分组聚合
  const mcpGroups = useMemo(() => {
    const groupsMap = new Map<string, {
      server: string
      label: string
      desc: string
      totalCalls: number
      items: CapabilityItem[]
      latestTime: number
    }>()

    for (const item of items) {
      if (item.kind !== 'mcp') continue
      const serverKey = item.server || 'other'
      const existing = groupsMap.get(serverKey)
      if (existing) {
        existing.totalCalls += item.callCount
        existing.items.push(item)
        if (item.lastTime > existing.latestTime) existing.latestTime = item.lastTime
      } else {
        const info = getMcpServerInfo(item.server)
        groupsMap.set(serverKey, {
          server: serverKey,
          label: info.label,
          desc: info.desc,
          totalCalls: item.callCount,
          items: [item],
          latestTime: item.lastTime,
        })
      }
    }

    // 组内排序：按最近调用时间降序
    for (const group of groupsMap.values()) {
      group.items.sort((a, b) => b.lastTime - a.lastTime)
    }

    // 各组排序：按该组最近活跃时间降序
    return [...groupsMap.values()].sort((a, b) => b.latestTime - a.latestTime)
  }, [items])

  const skillItems = useMemo(() => {
    return items.filter((i) => i.kind === 'skill').sort((a, b) => b.lastTime - a.lastTime)
  }, [items])

  if (!open) return null

  return (
    <div
      className="kr-git-roster-overlay kr-capabilities-overlay"
      data-closing={closing ? '1' : undefined}
      onClick={requestClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kr-capabilities-title"
    >
      <div
        className="kr-git-roster-modal kr-capabilities-modal"
        onClick={(e: ReactMouseEvent) => e.stopPropagation()}
      >
        {/* 顶部 Header：参考 Git 大盘样式 */}
        <div className="kr-git-roster-modal__header">
          <div className="kr-git-roster-modal__title-row">
            {/* 能力图标 */}
            <svg
              className="kr-git-roster-modal__git-icon kr-capabilities-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 22v-5" />
              <path d="M9 8V2" /><path d="M15 8V2" />
              <path d="M18 8v3a6 6 0 0 1-12 0V8Z" />
            </svg>

            <span id="kr-capabilities-title" className="kr-git-roster-modal__title">
              MCP 与 Skill 调用明细
            </span>

            {/* 顶栏全局统计微胶囊 */}
            <div className="kr-git-roster-modal__stats">
              <span className="kr-git-roster-stat kr-git-roster-stat--pending">
                <span className="kr-git-roster-stat__dot" />
                <span>{mcpGroups.length} 个 MCP 服务 ({mcpCount} 个工具) · {mcpTotalCalls} 次调用</span>
              </span>
              <span className="kr-git-roster-stat kr-cap-stat--skill">
                <span className="kr-git-roster-stat__dot" />
                <span>{skillCount} 个 Skill · {skillTotalCalls} 次调用</span>
              </span>
            </div>
          </div>

          <div className="kr-git-roster-modal__header-tools">
            {/* 刷新 */}
            <button
              type="button"
              className={`kr-git-roster-modal__tool-btn ${loading ? 'kr-git-roster-modal__spin' : ''}`}
              onClick={onRefresh}
              disabled={loading}
              title="重新统计会话与子代理调用记录"
              aria-label="刷新统计"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2v4h-4M2 14v-4h4" />
                <path d="M2.5 6a6 6 0 0 1 9.5-2.5L14 6M13.5 10a6 6 0 0 1-9.5 2.5L2 10" />
              </svg>
            </button>

            {/* 关闭 */}
            <button
              type="button"
              className="kr-git-roster-modal__tool-btn"
              onClick={requestClose}
              title="关闭 (Esc)"
              aria-label="关闭窗口"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
                <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
              </svg>
            </button>
          </div>
        </div>

        {/* 分段控制条 (Segmented Control) */}
        <div className="kr-git-roster-modal__nav-bar">
          <div className="kr-git-roster-segmented">
            <button
              type="button"
              className={`kr-git-roster-segmented__btn ${activeTab === 'all' ? 'kr-git-roster-segmented__btn--active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              <span>全部</span>
              <span className="kr-git-roster-segmented__num">{mcpCount + skillCount}</span>
            </button>
            <button
              type="button"
              className={`kr-git-roster-segmented__btn ${activeTab === 'mcp' ? 'kr-git-roster-segmented__btn--active' : ''}`}
              onClick={() => setActiveTab('mcp')}
            >
              {/* 插头图标 */}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v3a6 6 0 0 1-12 0V8Z" />
              </svg>
              <span>MCP 服务 ({mcpGroups.length})</span>
              <span className="kr-git-roster-segmented__num">{mcpCount}</span>
            </button>
            <button
              type="button"
              className={`kr-git-roster-segmented__btn ${activeTab === 'skill' ? 'kr-git-roster-segmented__btn--active' : ''}`}
              onClick={() => setActiveTab('skill')}
            >
              {/* 闪电图标 */}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <span>Skill 技能</span>
              <span className="kr-git-roster-segmented__num">{skillCount}</span>
            </button>
          </div>
        </div>

        {/* 舒展宽幅列表区 */}
        <div className="kr-git-roster-modal__list-area">
          {loading && items.length === 0 ? (
            <div className="kr-git-roster-modal__state-box">
              <svg
                className="kr-git-roster-modal__spin"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6" strokeDasharray="28" strokeDashoffset="10" />
              </svg>
              <span>正在分析本会话与子代理调用记录...</span>
            </div>
          ) : (activeTab === 'mcp' && mcpGroups.length === 0) ||
            (activeTab === 'skill' && skillItems.length === 0) ||
            (activeTab === 'all' && items.length === 0) ? (
            <div className="kr-git-roster-modal__state-box">
              <span>本会话与子代理暂无被调用的 {activeTab === 'mcp' ? 'MCP 服务' : activeTab === 'skill' ? 'Skill 技能' : '能力'}</span>
            </div>
          ) : (
            <div className="kr-cap-groups">
              {/* 1. MCP 服务分组展示 */}
              {(activeTab === 'all' || activeTab === 'mcp') &&
                mcpGroups.map((group) => {
                  const isCollapsed = collapsedGroups[group.server] === true

                  return (
                    <div
                      key={group.server}
                      className="kr-cap-group"
                      data-collapsed={isCollapsed ? 'true' : undefined}
                    >
                      {/* 分组头部：展示是什么 MCP，如【高德地图】 */}
                      <div
                        className="kr-cap-group__header"
                        onClick={() => toggleGroupCollapse(group.server)}
                        title={isCollapsed ? '点击展开该 MCP 服务' : '点击收起'}
                      >
                        <div className="kr-cap-group__left">
                          {/* 旋转箭头 */}
                          <svg
                            className="kr-cap-group__chevron"
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="m4 6 4 4 4-4" />
                          </svg>

                          {/* 插头图标 */}
                          <svg
                            className="kr-cap-group__icon"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M12 22v-5" />
                            <path d="M9 8V2" /><path d="M15 8V2" />
                            <path d="M18 8v3a6 6 0 0 1-12 0V8Z" />
                          </svg>

                          {/* 人类友好名称（例：高德地图） */}
                          <span className="kr-cap-group__title">{group.label}</span>

                          {/* 原始 Server 英文标识 */}
                          <span className="kr-cap-group__tag">{group.server}</span>

                          {/* 服务描述 */}
                          {group.desc && (
                            <span className="kr-cap-group__desc" title={group.desc}>
                              {group.desc}
                            </span>
                          )}
                        </div>

                        <div className="kr-cap-group__right">
                          <span className="kr-cap-group__badge">
                            {group.items.length} 个工具 · 累计 {group.totalCalls} 次调用
                          </span>
                        </div>
                      </div>

                      {/* 分组内各具体工具列表 */}
                      {!isCollapsed && (
                        <div className="kr-cap-group__body">
                          <div className="kr-git-roster-table">
                            <div className="kr-git-roster-table__header">
                              <div className="kr-git-roster-col kr-cap-col--func">工具功能 / 接口名称</div>
                              <div className="kr-git-roster-col kr-cap-col--count">调用频次</div>
                              <div className="kr-git-roster-col kr-cap-col--status">状态</div>
                              <div className="kr-git-roster-col kr-cap-col--detail">最近调用 / 参数摘要</div>
                            </div>

                            <div className="kr-git-roster-table__body">
                              {group.items.map((item, idx) => {
                                const friendlyName = getToolFriendlyName(item.tool)

                                return (
                                  <div key={idx} className="kr-git-roster-item-row kr-cap-item-row">
                                    {/* 1. 工具功能与名称 */}
                                    <div className="kr-git-roster-col kr-cap-col--func">
                                      {friendlyName ? (
                                        <>
                                          <span className="kr-cap-tool-friendly" title={item.tool}>
                                            {friendlyName}
                                          </span>
                                          <span className="kr-cap-tool-raw" title={item.name}>
                                            {item.tool}
                                          </span>
                                        </>
                                      ) : (
                                        <span className="kr-cap-tool-friendly" title={item.name}>
                                          {item.tool || item.name}
                                        </span>
                                      )}
                                    </div>

                                    {/* 2. 调用频次 */}
                                    <div className="kr-git-roster-col kr-cap-col--count">
                                      <span className="kr-cap-count-badge">
                                        {item.callCount} 次
                                      </span>
                                    </div>

                                    {/* 3. 状态 */}
                                    <div className="kr-git-roster-col kr-cap-col--status">
                                      {item.status === 'running' ? (
                                        <span className="kr-git-status-tag kr-git-status-tag--pending" title="正在执行中">
                                          <span className="kr-git-status-tag__dot" />
                                          <span>执行中</span>
                                        </span>
                                      ) : item.status === 'failed' ? (
                                        <span className="kr-git-status-tag kr-git-status-tag--conflict" title="最近调用报错">
                                          <span className="kr-git-status-tag__dot" />
                                          <span>失败</span>
                                        </span>
                                      ) : (
                                        <span className="kr-git-status-tag kr-git-status-tag--clean" title="调用成功">
                                          <span className="kr-git-status-tag__dot" />
                                          <span>正常</span>
                                        </span>
                                      )}
                                    </div>

                                    {/* 4. 最近调用时间与参数摘要 */}
                                    <div className="kr-git-roster-col kr-cap-col--detail">
                                      <div className="kr-git-roster-item__commit-cell">
                                        <span className="kr-git-roster-item__commit-time">
                                          {formatRelativeTime(item.lastTime)}
                                        </span>
                                        <span
                                          className="kr-git-roster-item__commit-subject kr-cap-args-text"
                                          title={item.argsSummary || item.name}
                                        >
                                          {item.argsSummary || '-'}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}

              {/* 2. Skill 技能列表展示 */}
              {(activeTab === 'all' || activeTab === 'skill') && skillItems.length > 0 && (
                <div
                  className="kr-cap-group"
                  data-collapsed={collapsedGroups['skill-section'] === true ? 'true' : undefined}
                >
                  <div
                    className="kr-cap-group__header"
                    onClick={() => toggleGroupCollapse('skill-section')}
                    title={collapsedGroups['skill-section'] === true ? '点击展开技能列表' : '点击收起'}
                  >
                    <div className="kr-cap-group__left">
                      <svg
                        className="kr-cap-group__chevron"
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m4 6 4 4 4-4" />
                      </svg>

                      {/* 闪电图标 */}
                      <svg
                        className="kr-cap-group__icon kr-cap-group__icon--skill"
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                      </svg>

                      <span className="kr-cap-group__title">Skill 技能库指令</span>
                      <span className="kr-cap-group__tag">skills</span>
                      <span className="kr-cap-group__desc">会话与子代理按需调用的专业技能</span>
                    </div>

                    <div className="kr-cap-group__right">
                      <span className="kr-cap-group__badge">
                        {skillItems.length} 个技能 · 累计 {skillTotalCalls} 次调用
                      </span>
                    </div>
                  </div>

                  {collapsedGroups['skill-section'] !== true && (
                    <div className="kr-cap-group__body">
                      <div className="kr-git-roster-table">
                        <div className="kr-git-roster-table__header">
                          <div className="kr-git-roster-col kr-cap-col--func">技能名称</div>
                          <div className="kr-git-roster-col kr-cap-col--count">调用频次</div>
                          <div className="kr-git-roster-col kr-cap-col--status">状态</div>
                          <div className="kr-git-roster-col kr-cap-col--detail">最近调用 / 参数摘要</div>
                        </div>

                        <div className="kr-git-roster-table__body">
                          {skillItems.map((item, idx) => (
                            <div key={idx} className="kr-git-roster-item-row kr-cap-item-row">
                              {/* 1. 技能名称 */}
                              <div className="kr-git-roster-col kr-cap-col--func">
                                <span className="kr-cap-tool-friendly" title={item.name}>
                                  {item.displayName}
                                </span>
                              </div>

                              {/* 2. 调用频次 */}
                              <div className="kr-git-roster-col kr-cap-col--count">
                                <span className="kr-cap-count-badge">
                                  {item.callCount} 次
                                </span>
                              </div>

                              {/* 3. 状态 */}
                              <div className="kr-git-roster-col kr-cap-col--status">
                                {item.status === 'running' ? (
                                  <span className="kr-git-status-tag kr-git-status-tag--pending" title="正在执行中">
                                    <span className="kr-git-status-tag__dot" />
                                    <span>执行中</span>
                                  </span>
                                ) : item.status === 'failed' ? (
                                  <span className="kr-git-status-tag kr-git-status-tag--conflict" title="最近调用报错">
                                    <span className="kr-git-status-tag__dot" />
                                    <span>失败</span>
                                  </span>
                                ) : (
                                  <span className="kr-git-status-tag kr-git-status-tag--clean" title="调用成功">
                                    <span className="kr-git-status-tag__dot" />
                                    <span>正常</span>
                                  </span>
                                )}
                              </div>

                              {/* 4. 最近调用时间与参数摘要 */}
                              <div className="kr-git-roster-col kr-cap-col--detail">
                                <div className="kr-git-roster-item__commit-cell">
                                  <span className="kr-git-roster-item__commit-time">
                                    {formatRelativeTime(item.lastTime)}
                                  </span>
                                  <span
                                    className="kr-git-roster-item__commit-subject kr-cap-args-text"
                                    title={item.argsSummary || item.name}
                                  >
                                    {item.argsSummary || '-'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
