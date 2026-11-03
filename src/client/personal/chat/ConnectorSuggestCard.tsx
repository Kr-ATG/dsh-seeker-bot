/**
 * Personal Agent — 「连接你的应用」推荐卡。
 *
 * 助手在对话里主动推荐几个可连接的 MCP 应用（Gmail / 日历 / Notion …），每条是
 * 一行「彩色图标 + 名称 + 一句说明」。点任意一行 → 打开 MCP 服务器弹窗卡片
 * （2026-11-03 起连接器页就是那颗居中弹窗，不再走工作台页）去安装 / 授权，
 * 并当场把这一行标成「已打开」。
 *
 * 为什么不做成 `interactive` 那种要作答的卡：推荐不是提问，用户不需要在对话里
 * 选一个再提交——他只是被指了一条路。所以这里没有提交语义、不回写 store，
 * 点击标记只活在组件 state 里（消息落库时宿主仍可带上 `picked` 作为历史提示）。
 *
 * 图标来自宿主路由 `/api/chat-flow/mcp-icons/<iconFile>`（与连接器市场同源）；
 * 没有图标名或加载失败时一律落到首字母占位块，不留空白、不出现破图标。
 */
import { useState } from 'react'
import { IconCheck, IconChevronRight, IconCircleCheck } from '../icons.tsx'
import type { ConnectorItem, MessageBlock } from '../types.ts'
import { openConnectorModal } from '../../triad/connectors/ConnectorModal.tsx'
import { ensureConnectorSuggestStyles } from './connector-suggest.css.ts'

export interface ConnectorSuggestCardProps {
  block: Extract<MessageBlock, { type: 'connectors' }>
}

/** 图标地址（宿主路由，按文件名精确匹配）。 */
function iconUrl(file: string | undefined): string {
  if (file === undefined || file === '') return ''
  return '/api/chat-flow/mcp-icons/' + encodeURIComponent(file)
}

/**
 * 首字母占位。
 *
 * 用名称首字而不是问号：推荐卡里一排应用的名字往往是「Gmail / 飞书 / Notion」，
 * 首字本身就有辨识度，比一个通用符号更能让用户对上号。中文取首字、英文取首字母
 * 大写（toUpperCase 对中文无副作用）。
 */
function initialOf(name: string): string {
  const first = name.trim().slice(0, 1)
  return first === '' ? '?' : first.toUpperCase()
}

/**
 * 一个图标位。
 *
 * 占位块常驻在底层、`<img>` 叠在上面：图片加载成功后才收起占位字母（透明图标
 * 的透明区域会透出字母，看起来像重影）；加载失败则干脆不渲染 `<img>`，露出
 * 的就是占位——而不是浏览器默认的破图。
 */
function ConnectorIcon({ item }: { item: ConnectorItem }): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [broken, setBroken] = useState(false)
  const url = iconUrl(item.icon)
  return (
    <span className="pa-con__icon" data-loaded={loaded ? 'true' : 'false'} aria-hidden="true">
      <span className="pa-con__icon-fallback">{initialOf(item.name)}</span>
      {url !== '' && !broken ? (
        <img
          className="pa-con__icon-img"
          src={url}
          alt=""
          loading="lazy"
          draggable={false}
          onLoad={() => { setLoaded(true) }}
          onError={() => { setBroken(true) }}
        />
      ) : null}
    </span>
  )
}

interface ConnectorRowProps {
  item: ConnectorItem
  picked: boolean
  onOpen: (item: ConnectorItem) => void
}

/** 一行连接器。整行是按钮：点击目标是「去连接」，不是某个小图标。 */
function ConnectorRow({ item, picked, onOpen }: ConnectorRowProps): JSX.Element {
  /*
   * 右侧状态二选一：本轮点过 →「已打开」（操作反馈，优先）；目录里已装 →「已连接」。
   * 两者都没有就什么都不显示，让名称和说明独占空间。
   */
  const tone: 'picked' | 'installed' | null = picked ? 'picked' : item.installed === true ? 'installed' : null
  const description = item.description !== undefined && item.description !== '' ? item.description : undefined
  return (
    <button
      type="button"
      className="pa-con__row"
      data-installed={item.installed === true ? 'true' : 'false'}
      data-picked={picked ? 'true' : 'false'}
      /* 说明被单行省略时，悬浮仍能读全（窄屏 / 长 tagline） */
      title={description}
      onClick={() => { onOpen(item) }}
    >
      <ConnectorIcon item={item} />
      <span className="pa-con__body">
        <span className="pa-con__name">{item.name}</span>
        {description !== undefined ? <span className="pa-con__desc">{description}</span> : null}
      </span>
      {tone !== null ? (
        <span className="pa-con__state" data-tone={tone}>
          {tone === 'installed' ? <IconCircleCheck size={12} /> : <IconCheck size={12} />}
          {tone === 'installed' ? '已连接' : '已打开'}
        </span>
      ) : null}
      <span className="pa-con__chevron" aria-hidden="true"><IconChevronRight size={14} /></span>
    </button>
  )
}

export function ConnectorSuggestCard({ block }: ConnectorSuggestCardProps): JSX.Element {
  ensureConnectorSuggestStyles()

  /*
   * 初始值取宿主给的 `picked`（历史消息里「上次点过哪条」），之后只由本地点击改写。
   * 不回写 store 是刻意的：点完已经跳到工作台，再为一条消息落一次盘没有收益。
   */
  const [picked, setPicked] = useState<string | null>(block.picked ?? null)

  /* 宿主理论上只会发非空推荐，但脏数据不该把整条消息渲染成一张空卡 */
  const items = block.items ?? []
  if (items.length === 0) return <></>

  const title = block.title !== undefined && block.title !== '' ? block.title : '连接你的应用'
  const prompt = block.prompt !== undefined && block.prompt !== '' ? block.prompt : undefined

  const open = (item: ConnectorItem): void => {
    /* 先记再弹：弹窗会盖住对话流，用户关掉回来时这一行还亮着「已打开」，
       否则他会怀疑刚才那一下有没有点中。 */
    setPicked(item.id)
    openConnectorModal()
  }

  return (
    <div className="pa-con">
      <div className="pa-con__title">{title}</div>
      {prompt !== undefined ? <div className="pa-con__prompt">{prompt}</div> : null}
      <div className="pa-con__list">
        {items.map((item) => (
          <ConnectorRow key={item.id} item={item} picked={picked === item.id} onOpen={open} />
        ))}
      </div>
    </div>
  )
}
