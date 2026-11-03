# 浮层与卡片的动效规范

> 这份文档是「插件里所有浮层卡片都要有划入 + 划出动效」这条要求的落地记录：
> 统一规格是什么、现有几套体系、哪些组件改过、哪些是刻意例外。
>
> 起因：用户反馈「卡片退出时没有动效」「点外面关闭很生硬」——审计后发现
> 全插件 60 个浮层里有 **39 个只有入场、没有退场**（条件渲染一置 null 就硬消失）。

---

## 一、统一规格

所有新写的浮层动效都按这张表来，不要再自创参数。

| 项 | 值 | 说明 |
|---|---|---|
| 入场时长 | 240ms（大卡可 340ms） | 与 `modal-animation.ts` 的 `MODAL_ANIM_MS` 对齐 |
| 入场曲线 | `cubic-bezier(0.2, 0.8, 0.2, 1)` | 减速语义：从视线外进入 |
| 退场时长 | 240ms（小 popover 120–160ms） | 比入场短一截，进出不对称才像「被收回去」 |
| 退场曲线 | `cubic-bezier(0.4, 0, 0.2, 1)` | 加速语义：从静止启动、峰值速度结束 |
| 遮罩 | 淡入淡出，`ease` | 不位移，避免「背景在动」的廉价感 |
| 位移量 | modal 下移 14px / drawer 右移 46px / popover 缩回 10px | 幅度小才不抢戏 |
| 缩放 | 退场 `scale(.97)` | 只给一点「收」的感觉 |
| 减弱动效 | 必须进 `prefers-reduced-motion` 的 `animation:none` 列表 | 系统开了就全部关掉 |

两条硬规矩：

1. **退场不是立刻卸载**：先置 `closing` 让 CSS 播完，再真正 `setOpen(false)` / 调 store 的关闭动作。
2. **所有关闭入口都走同一条 `requestClose`**：关闭按钮 / Esc / 点遮罩 / 点外面 / 「选完就关」的确认路径。审计里最典型的一处 bug 就是「✕ 有动效、点外面没有」——因为点外面那条写的是裸 `setOpen(false)`。

---

## 二、全局唯一来源：`src/client/motion/overlay-motion.ts`

**所有浮层动效只此一份**。它做三件事：

1. **一份样式表**（`ensureOverlayMotionStyles()`，apply 期由 `client/index.ts` 注入一次，id `dsh-overlay-motion-styles`）；
2. **两套用法**：
   - 老 API：`.dsh-modal-slide-in` / `-slide-out` / `-side-*` / `-drawer-*` / `-mask-*` 这类 class —— 已有组件继续用，行为不变；
   - 新 API：`data-motion` + `data-motion-kind` + `data-motion-mask` **属性驱动** —— 新增浮层一个 keyframes 都不用写；
3. **一个 hook**：`useOverlayMotion(open, onClose, kind)`，返回 `{ closing, requestClose, cancelClose, cardAttrs, maskAttrs }`。

### 新增一个浮层（零 CSS）

```tsx
import { useOverlayMotion, ensureOverlayMotionStyles } from '../../motion/overlay-motion'

const { closing, requestClose, cardAttrs, maskAttrs } = useOverlayMotion(
  open,
  () => setOpen(false),
  'modal',            // modal | popover | drawer | sheet | toast
)

// 所有关闭入口（✕ / Esc / 点遮罩 / 确认后关闭）都调 requestClose
return open || closing ? createPortal(
  <div className="my-mask" {...maskAttrs}>
    <div className="my-card" {...cardAttrs}>…</div>
  </div>,
  document.body,
) : null
```

要换形态只改第三个参数：`'drawer'` 自右滑入、`'popover'` 缩放淡入、`'toast'` 上浮淡入。

### 两份老模块现在是薄壳

`modal-animation.ts` 与 `triad/triad-modal-animation.ts` 的 keyframes 已删除，只保留
API 薄壳（`modalAnimClass` / `modalMaskAnimClass` / `modalDrawerAnimClass` / `useModalClose`），
内部统一调 `ensureOverlayMotionStyles()`。历史遗留的「改一处务必同步另一处」问题消失。

---

## 三、标准实现模式

```tsx
const [closing, setClosing] = useState(false)
const closeTimerRef = useRef<number | null>(null)

/** 关闭：先播 240ms 退场，再真正卸载（直接置 null 会硬消失）。 */
const requestClose = useCallback((): void => {
  if (closeTimerRef.current !== null) return   // 防重入
  setClosing(true)
  closeTimerRef.current = window.setTimeout(() => {
    closeTimerRef.current = null
    setClosing(false)
    actions.closeXxx()                          // 原来的关闭动作
  }, 240)
}, [actions])

useEffect(() => () => {                         // 卸载时清定时器
  if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
}, [])
```

渲染根节点加 `data-closing={closing ? '1' : undefined}`，样式表：

```css
.xxx-overlay[data-closing='1'] { animation: xxx-fade-out 240ms ease both; }
.xxx-overlay[data-closing='1'] .xxx-card { animation: xxx-out 240ms cubic-bezier(0.4, 0, 0.2, 1) both; }
@keyframes xxx-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes xxx-out { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(14px) scale(0.97); } }
```

**组件被父级卸载**（切换会话 / 换形态 / 关功能开关）时 React 不给播动画的机会，
参考 `done-pill/brief-card.tsx` 的「幽灵副本」做法：cleanup 里 clone 当前节点到
`document.body`，加 `data-closing` 播完再 remove。

---

## 四、改造清单

> 状态：`✅` 已改并验证 / `✅` 改造中 / `⏸` 刻意不改（附理由）

### personal（Bot 模式）

| 组件 | 类型 | 状态 |
|---|---|---|
| journal/JournalOverlay | 全屏面板 | ✅ 整层淡出 + 纸张下沉缩小 |
| journal/JournalRulePanel | 右抽屉 | ✅ |
| call/CallOverlay | 全屏 modal | ✅ |
| shell/BotSettingsCard | 居中弹窗 | ✅ |
| shell/GroupSettings | 居中弹窗 | ✅ |
| shell/Sidebar 设置抽屉 | 右贴边 drawer | ✅ |
| shell/Sidebar Bot 菜单 / 新建菜单 | popover ×2 | ✅ |
| shell/TaskDetailModal | 大卡 | ✅ |
| shell/PagesCard / BotOutputsCard | 预览灯箱 ×2 | ✅ |
| chat/ArtifactCard | 灯箱 | ✅ |
| chat/ChatPanel 清空确认 / 更多菜单 | confirm + popover | ✅ |
| chat/MessageList 撤回确认 | confirm | ✅ |
| chat/Composer @ 提及气泡 | popover | ✅ |
| shared/PaSelect 下拉 | popover | ✅ |
| shell/NewBotModal / NewRoomModal | modal ×2 | ✅ |
| index.tsx toast | toast | ✅ |

### 工作台（triad）

| 组件 | 类型 | 状态 |
|---|---|---|
| vault/Shell VaultModal | 弹窗壳（覆盖 4 处） | ✅ |
| vault/Panel 原地展开 + modal 壳 | 展开卡 | ✅ |
| vault/PhotoGrid 灯箱 | lightbox | ✅ |
| connectors/Panel 详情抽屉 | drawer | ✅ |
| hub/row-flyout Flyout | 浮卡 | ✅ |
| gallery/GalleryPanel 时间筛选 | popover | ✅ |
| skills/SkillsPanel toast 栈 | toast | ✅ |
| memory/Panel 窄屏详情 | 浮层 | ✅ 已改（顺带补了窄屏关闭按钮） |
| popover-shell page 形态 | 整页视图 | ⏸ 不是浮层；加退场会与官方 main 槽位切页打架 |
| gallery/media-lightbox | lightbox | ⏸ 已有自建退场（170ms），本轮不动 |

### 大盘 / 卡片 / 其它

| 组件 | 类型 | 状态 |
|---|---|---|
| kr-chat/GitRosterModal | modal | ✅ 已改（顺带补 Esc 关闭） |
| kr-chat/CapabilitiesModal | modal | ✅ 已改（与上面共用 class） |
| kr-chat/KrOutputsCard 右键菜单 | popover | ✅ |
| kr-chat/KrLiveActivityCard 头像气泡 | popover | ✅ |
| iu/IuCard 全屏灯箱 | lightbox | ✅ |
| shot/Panel 遮罩 | mask | ✅ 已改（只补遮罩淡入淡出） |
| provider/ModelListEditor 拉取弹窗 + 预设 listbox | modal + popover | ✅ |
| generated-images/GeneratedImageStrip 灯箱 | lightbox | ✅ |
| done-pill/sidebar-card 对话动态 | popover | ✅ |
| done-pill/rec-picker-panel | picker | ✅ |
| done-pill/rec-region-overlay 取消/Esc | overlay | ✅ |
| done-pill/brief-card 期刊大卡 | modal | ✅ 260ms 退场 + 卸载幽灵副本 |
| kr-chat/KrPanelSettings | modal | ⏸ 常驻 DOM，`data-open` 反向 transition 已完整 |
| kr-chat/KrLiveActivityCard 迷你浮卡 | toast | ⏸ 自研 980ms 双层退场，刻意更慢 |
| thinking/live-stack 思考轨道 | 轨道 | ⏸ 自研 reclaim 两阶段退场 |
| tool-summary/activity-drawer | dialog | ⏸ 本来就是标杆实现 |
| session-delete/confirm-dialog | confirm | ⏸ 标杆实现 |

---

## 五、已知坑

1. **`animation-fill-mode: both` 会残留 transform**：动画结束后该元素仍是后代 `position:fixed` 元素的包含块，浮层会整体偏移。入场动画用 `backwards`。
2. **两份 `modal-animation` 注入同名 keyframes**：靠各自的 `STYLE_ID` 去重，改一处务必同步另一处（或者干脆合并）。
3. **主区那份缺 drawer 变体**：抽屉要自右滑入时只能用 triad 那份，或先给主区补 keyframes。
4. **宿主 primitives 的 Modal / Menu / Tooltip 插件侧改不了**：没有 closing 钩子，只能换壳或推给宿主。
---

## 六、本轮改造结果

| 范围 | 浮层数 | 改造前缺退场 | 改造后 |
|---|---|---|---|
| personal（Bot 模式） | 20 | 20 | 20 个全部补齐 |
| 工作台 triad | 12 | 8 | 8 个补齐（4 个本来就有） |
| 大盘 kr-chat / iu / shot | 13 | 5 + 1 部分 | 全部补齐（顺带补了 GitRosterModal 的 Esc、memory 窄屏详情的关闭按钮） |
| 胶囊 done-pill / provider / 生图 | 15 | 6 | 全部补齐 |

同时收敛的架构问题：

1. 三份动效实现 → **一份**（`motion/overlay-motion.ts`），两份老模块降级为薄壳；
2. 入场时长从 120–380ms 散乱 → 统一 **240ms**（小 popover 120–160ms 为刻意保留）；
3. 新增浮层不再需要写 keyframes（属性驱动）。

未改造（刻意）：`popover-shell` 的 page 形态（是视图不是浮层）、`media-lightbox`（已有自建退场）、
`KrPanelSettings`（常驻 DOM + 反向 transition）、`KrLiveActivityCard` 迷你浮卡（980ms 双层退场，刻意更慢）、
`live-stack` 思考轨道（reclaim 两阶段退场）、`activity-drawer` 与 `confirm-dialog`（本来就是标杆）。
---

## 七、入场统一（第二轮）

退场补齐后，入场也统一到同一套参数：**240ms + `cubic-bezier(0.2, 0.8, 0.2, 1)`**。

| 范围 | 统一条数 | 说明 |
|---|---|---|
| personal（Bot 模式） | 35 | 8 份样式表 |
| done-pill（胶囊） | 23 | 含 `brief-card` 的大卡从 340ms 收到 240ms |
| triad / kr-chat / iu / shot / provider / 生图 | 88 | 18 个文件 |
| **合计** | **146 条** | 入场时长不再散落 |

刻意保留的节奏（不是「忘了改」）：

- `KrLiveActivityCard` 迷你浮卡（入场 360ms / 退场 980ms）——它是一张「慢慢展开」的活动卡，整体节奏刻意更慢；
- `activity-drawer` 420ms（标杆实现，本来就慢一点）；
- 组件内部微动效：图片揭示 550ms、主题页 620ms、任务完成闪 420–900ms、数字脉冲 320–380ms——这些是**状态反馈**不是浮层入场，统一成 240ms 反而会让反馈来不及被看见；
- 遮罩一律 240ms `ease`（只做 opacity，不需要位移曲线）。

剩余可选项：iu 的 `dtt-iu-rise`（340ms）、vault 的 `dsh-vault-rise`（320ms）、gallery 灯箱 `glb-fade`（200–260ms）这类「命名不带 `-in`」的入场还没统一，属于第二批，需要时按同一规格扫一遍即可。
---

## 八、页面转场（第三轮）

浮层之外，用户要求「进入页面也要有减速动效」。这类动效和浮层不同：**没有关闭态，只有入场**，
所以不复用 `useOverlayMotion`，而是在全局层加了一组属性：

| 属性 | 用途 | 效果 |
|---|---|---|
| `data-page-motion="in"`（`PAGE_MOTION_IN`） | 整页/主区/面板页容器入场 | 240ms 减速 + 上浮 10px + 淡入 |
| `data-page-motion="stagger"`（`PAGE_MOTION_STAGGER`） | 首屏卡片组 / 分区列表错峰 | 子块按 `--i` 每 22ms 依次上浮 |

```tsx
import { PAGE_MOTION_IN, PAGE_MOTION_STAGGER } from '../../motion/overlay-motion'

<section className="my-page" key={viewId} {...PAGE_MOTION_IN}>      // key 变化 → 重播
  <div className="my-cards" {...PAGE_MOTION_STAGGER}>
    {cards.map((c, i) => <div key={c.id} style={{ '--i': i } as CSSProperties}>…</div>)}
  </div>
</section>
```

### 挂上的页面

| 页面 | 重播方式 |
|---|---|
| ~~Bot 模式主区 + 侧栏~~ | **不加**（整层替换，见下「刻意不挂的」） |
| Bot 右栏面板（`.pa-right`） | 条件渲染，每次拉开重挂载 |
| 工作台空态页 | 进入时挂载 |
| 记忆页主区 | `key={tab}`，切 all / changes / revisions / trash / settings 重播 |
| 画廊页 | `key={viewKey}`，网格 ⇄ 时间轴切换重播 |
| 系统提示词页 | `key={view}`，全文 / 详细切换重播 |
| 档案页 / SKILL 页 / 同步设置页 | 进入页面时重播 |
| 胶囊弹出面板的两分区 | 行级 22ms 错峰 |

### 刻意不挂的（都有理由）

- **`.pa-root` 本身**：铺满视口的定层，opacity 入场前几帧会透出底下的 Work 界面——正是仓库一直在治的「切模式一闪」。挂在内层有自己底色的列上。
- **期刊全屏层**：已有整层 240ms 淡入 + 纸张入场，再挂会叠两层。
- **各浮层**：已由浮层动效统一，重复挂等于双重位移。
- **聊天主区换 Bot / 换群聊**：容器不卸载且 Composer 草稿在本地 state，加 `key` 会丢字；消息行本身已有入场。
- **长列表**（画廊 100+ 卡片、记忆条目）：卡片已有逐项入场，再叠错峰会双重位移且拖慢首帧。
- **Work 模式官方界面**：宿主 DOM，插件不改宿主布局与动画。

### 两个变体：`in` 与 `slide`

| 变体 | 用在哪 | 为什么 |
|---|---|---|
| `data-page-motion="in"`（`PAGE_MOTION_IN`） | 父级不透明的页面（工作台各页、右栏面板） | 有淡入，切换更有「换了一页」的感觉 |
| `data-page-motion="slide"`（`PAGE_MOTION_SLIDE`） | **整层替换**的容器（Work ⇄ Bot 的主列与侧栏） | **不碰 opacity**：这类容器铺满视口，淡入会在前几帧透出底下另一套界面 |

Work ⇄ Bot 那一对必须用 `slide` —— 用 `in` 就是用户报的「切模式闪一下」。

### 踩过的坑

0. **整层替换不能用淡入**：Bot 主列 / 侧栏如果用 `in`（带 opacity），切回来那 240ms 会透出底下的 Work 界面；再加上 `.pa-root` 的兜底底色当时是比主区深一档的 `--pa-bg`（#141517 vs #181819），观感就是「先暗一下再亮起来」。两处一起修：兜底底色改成 `--pa-main`（与主区同色）+ 容器改用 `slide` 变体。
1. **同特异性的本地 keyframes 会静默压掉全局属性规则**：hub 样式表注入晚于 apply 期的全局表，原来的 `.wb-body > * { animation: wb-page-in }` 会让新挂的 `[data-page-motion]` 不播——已删掉本地那条，只留全局一个来源。
2. **不能给常驻容器加 `key`**：重挂会丢组件内部 state（Composer 草稿）。常驻容器靠 `display:none` 打断动画时间轴来重播。
3. **不要给「常驻不卸载」的元素挂页面转场**：它永远不重播，等于白加。
---

## 九、以后新增页面 / 弹窗时怎么提需求

### 最短说法（够用）

> 加一个新页面「XXX」，动效按 MOTION.md 的规范来。

> 加一个弹窗「XXX」，动效按 MOTION.md 的规范来。

就这两句。剩下的（用哪个属性、多长、什么曲线、要不要退场）都由规范决定，不需要你再说。

### 想更精确时，加一句「形态」

| 你要做的东西 | 说成 | 实际用 |
|---|---|---|
| 整页 / 主区 / 菜单页 | 「**页面**」 | `PAGE_MOTION_IN`（240ms 减速入场，无退场） |
| 居中的对话框 | 「**弹窗**」 | `useOverlayMotion(..., 'modal')` |
| 贴右边缘滑出的设置/详情 | 「**抽屉**」 | `useOverlayMotion(..., 'drawer')` |
| 贴按钮/指针弹出的小卡 | 「**气泡**」或「popover」 | `useOverlayMotion(..., 'popover')` |
| 底部弹出 | 「**底部弹层**」 | `useOverlayMotion(..., 'sheet')` |
| 右下角提示 | 「**toast**」 | `useOverlayMotion(..., 'toast')` |

例：

> 加一个设置页「音色管理」（页面），动效按规范来。
>
> 加一个「导入配置」弹窗，点遮罩和 Esc 都要能关，动效按规范来。

### 我会自动做、不用你交代的

- 入场 240ms 减速曲线、退场 240ms 加速曲线；
- 关闭路径统一（✕ / Esc / 点遮罩 / 确认后关闭）都走退场再卸载；
- 点外面关闭也带动效；
- `prefers-reduced-motion` 下全部关掉；
- 页面切换用 `key` 重播动画；
- 样式只往全局表加（不新写 keyframes）。

### 只有这些情况需要你额外说明

1. **想要特殊节奏**（比 240ms 慢/快）——比如「这个弹窗要慢一点，像期刊那样展开」，我会单独给它时长并写进文档。
2. **列表要错峰**——「卡片要一个一个出来」，我才会挂 `PAGE_MOTION_STAGGER`（长列表默认不加，会卡）。
3. **要跟手/拖拽**——「拖动要跟手」「松手要有回弹」，这属于手势动效，另走一套（速度继承 + 弹簧），不是转场动效。
4. **要共享元素转场**（点卡片放大成详情页，一镜到底）——这个成本高，要单独设计。

### 一句话记忆

**「页面」只入场，「浮层」进 + 出都要；不确定就写「按 MOTION.md 规范」，我会按上下文判断。**