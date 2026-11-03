/**
 * Personal Agent — 独立演示入口。
 *
 * 由 scripts/build-personal-demo.mjs 打包成单文件 dist/personal-agent/index.html，
 * 不依赖 DSH 也能打开验收所有交互（数据存 localStorage）。
 */
import { createRoot } from 'react-dom/client'
import { PersonalProvider } from './store.tsx'
import { PersonalApp } from './index.tsx'
import { injectPersonalBaseStyles } from './base.css.ts'
import { injectShellStyles } from './shell/shell.css.ts'
import { injectOutputsStyles } from './shell/outputs.css.ts'
import { injectSettingsStyles } from './shell/settings.css.ts'
import { injectTaskStyles } from './shell/tasks.css.ts'
import { injectChatStyles } from './chat/chat.css.ts'
import { injectCallStyles } from './call/call.css.ts'
import { injectJournalStyles } from './journal/journal.css.ts'

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
