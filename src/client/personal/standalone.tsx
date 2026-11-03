/**
 * Personal Agent — 独立演示入口。
 *
 * 由 scripts/build-personal-demo.mjs 打包成单文件 dist/personal-agent/index.html，
 * 不依赖 DSH 也能打开验收所有交互（数据存 localStorage）。
 */
import { createRoot } from 'react-dom/client'
import { PersonalProvider } from './store.tsx'
import { PersonalApp } from './index.tsx'
import { ensureOverlayMotionStyles } from '../motion/overlay-motion.ts'
import { injectPersonalBaseStyles } from './base.css.ts'
import { injectShellStyles } from './shell/shell.css.ts'
import { injectOutputsStyles } from './shell/outputs.css.ts'
import { injectSettingsStyles } from './shell/settings.css.ts'
import { injectTaskStyles } from './shell/tasks.css.ts'
import { injectChatStyles } from './chat/chat.css.ts'
import { injectCallStyles } from './call/call.css.ts'
import { injectJournalStyles } from './journal/journal.css.ts'

/*
 * 全局动效样式（浮层 + 页面转场）：正式插件里由 client/index.ts 注入，
 * 独立演示页没有那条 apply 链，必须自己注入一次——否则页面转场属性在
 * 演示页上完全没有效果（验收时会被误判成「没做」）。
 */
ensureOverlayMotionStyles()
injectPersonalBaseStyles()
injectShellStyles()
injectOutputsStyles()
injectSettingsStyles()
injectTaskStyles()
injectChatStyles()
injectCallStyles()
injectJournalStyles()

document.body.setAttribute('data-skb-mode', 'bot')
document.documentElement.setAttribute('data-ds-dark-theme', '')
document.body.style.margin = '0'
document.body.style.overflow = 'hidden'

const host = document.getElementById('app')
if (host !== null) {
  createRoot(host).render(
    <PersonalProvider>
      <PersonalApp forceMode />
    </PersonalProvider>,
  )
}
