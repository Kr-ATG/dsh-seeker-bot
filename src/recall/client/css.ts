/**
 * dsh-recall-plugin — client CSS（纯常量，无闭包依赖）
 *
 * 从原 lib/client.js apply 内的 css 数组原样抽出：所有撤回气泡、确认面板、
 * toast、设置卡片的样式表。styles 服务可用时经 stylesSvc.insert 注入，否则
 * 降级为直接 <style> 注入（静态 bundle 的 ctx 可能不提供 styles 服务）。
 */
export const CSS = [
  // 语义变量集中声明（V1-5）：btn-danger 的 hover 亮度是令牌体系外补丁，
  // 集中成单一来源避免散落硬编码；前景色用官方实证配对 bg-layer-3（error
  // primary 底色上文本随主题翻转，见 plan-settings-ui V1 核验记录）。
  ':root{--dsh-recall-btn-danger-hover:brightness(1.08);--dsh-recall-tree-indent:24px;--dsh-recall-space-1:4px;--dsh-recall-space-2:8px;--dsh-recall-space-3:12px;--dsh-recall-input-w:120px;--dsh-recall-switch-w:36px}',
  '.dsh-recall-row{flex-direction:column;align-items:flex-end;gap:6px;display:flex}',
  // 新面（factory）本层包裹官方 UserContent，官方 `.userStack` 自带
  // max-width:min(calc(chat*0.702),82%)；外层再限一次即双层收缩，故全宽只在
  // 官方面放开。legacy 自绘面（0.1.x / factory 回落）仍靠原 cap 约束长文本。
  '.dsh-recall-stack{flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%);display:flex}',
  '.dsh-recall-stack-official{width:100%;max-width:100%}',
  '.dsh-recall-bubble{background:var(--dsw-specific-bubble);max-width:100%;color:var(--dsw-alias-label-primary);border-radius:22px;padding:10px 16px;font-size:16px;line-height:1.5;white-space:pre-wrap;word-break:break-word}',
  '.dsh-recall-json{margin:0;max-width:100%;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-markdown-code-block)}',
  // 文件卡片（消息里的 file 块，非图片附件）：复刻官方 UserStyleBubble 的附件卡
  // ——品牌色扩展名徽标 + 文件名（单行省略）+ 「MD 6.7KB」元信息行；令牌沿用
  // 卡片体系（layer-3 底 + 发丝描边），与图片附件的「附件在上」布局并列。
  '.dsh-recall-filecard{display:flex;align-items:center;gap:10px;max-width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:8px 12px}',
  '.dsh-recall-filecard-icon{flex:none;width:34px;height:34px;border-radius:8px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:11px;font-weight:600;line-height:1;letter-spacing:.02em;display:flex;align-items:center;justify-content:center}',
  '.dsh-recall-filecard-body{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.dsh-recall-filecard-name{color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-recall-filecard-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4}',
  '.dsh-recall-actions{align-items:center;gap:10px;height:28px;display:flex}',
  '.dsh-recall-time{color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px;font-size:14px;line-height:1.5}',
  '.dsh-recall-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;corner-shape:round;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
  '.dsh-recall-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '@media (hover:hover){[data-time-hover-root] .dsh-recall-time{opacity:0;transition:opacity 80ms}[data-time-hover-root]:hover .dsh-recall-time,[data-time-hover-root]:focus-within .dsh-recall-time{opacity:1}}',
  '.dsh-recall-panel{width:min(480px,100%);box-sizing:border-box;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;text-align:left;box-shadow:0 8px 28px rgba(0,0,0,.22)}',
  '.dsh-recall-panel-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:1.5}',
  '.dsh-recall-panel-note{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;word-break:break-word}',
  // 消息位置的编辑卡（issue #26）：官方不允许第二个 composer 实例，这张卡是
  // 插件自绘的「官方同款」——外框逐字对齐官方 composer 卡片（panel 圆角 /
  // input-major 底 / soft 阴影 / 14-24 字号行高），底部官方输入框保持原样
  '.dsh-recall-stack-editing{width:100%;max-width:100%}',
  '.dsh-recall-composer{width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:10px 12px 8px;border-radius:var(--dsw-radius-panel);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
  // 卡内文本区：透明无环（外框已给足层次），随内容增高到 260px 后内部滚动；
  // 高度由 edit-node 按 scrollHeight 写成内联样式
  '.dsh-recall-composer .dsh-recall-edit-area{width:100%;box-sizing:border-box;min-height:48px;max-height:260px;padding:2px 2px 0;background:0 0;color:var(--dsw-alias-label-primary);border:0;border-radius:0;font-size:inherit;line-height:inherit;font-family:inherit;resize:none;overflow-y:auto;box-shadow:none}',
  // 官方输入区聚焦时没有边框/描边变化（只有光标），编辑区跟随
  '.dsh-recall-edit-area:focus,.dsh-recall-edit-area:focus-visible{outline:none;border:0}',
  '.dsh-recall-edit-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}',
  '.dsh-recall-composer-attachments{display:flex;flex-wrap:wrap;gap:6px}',
  '.dsh-recall-composer-attach{display:inline-flex;align-items:center;gap:2px;max-width:100%;padding:2px 4px 2px 10px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
  '.dsh-recall-composer-attach-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-recall-composer-attach-x{border:0;background:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1;padding:2px 6px;border-radius:999px;corner-shape:round}',
  '.dsh-recall-composer-attach-x:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
  // 图片附件：固定 56px 缩略图，删除键做成角标，避免名字挤占宽度
  '.dsh-recall-composer-attach-image{position:relative;width:56px;height:56px;padding:0;border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-3)}',
  '.dsh-recall-composer-thumb{display:block;width:100%;height:100%;object-fit:cover}',
  '.dsh-recall-composer-attach-x-badge{position:absolute;top:2px;right:2px;width:18px;height:18px;padding:0;display:grid;place-items:center;font-size:12px;line-height:1;color:#fff;background:rgba(0,0,0,.55)}',
  '.dsh-recall-composer-attach-x-badge:hover{background:var(--dsw-alias-state-error-primary);color:#fff}',
  // 底行：加号 → 只读 chip → 提示 → 发送。发送键对齐官方（圆形 brand 底）
  '.dsh-recall-composer-foot{display:flex;align-items:center;gap:8px;min-height:32px}',
  '.dsh-recall-composer-add{position:relative;flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:50%;corner-shape:round;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.dsh-recall-composer-add:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-composer-add[aria-disabled="true"]{opacity:.4;cursor:default}',
  // 视觉隐藏但可聚焦：label 点击开选择框，键盘也能 Tab 进来
  '.dsh-recall-composer-file{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
  '.dsh-recall-composer-chip{flex:none;max-width:180px;padding:2px 8px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  // 模型 chip 是按钮：菜单锚在它上方，打开时不改变底行高度
  '.dsh-recall-composer-model{position:relative;flex:none;display:inline-flex;min-width:0}',
  // chip 内部与官方 trigger 同构：模型名（常规色）+ 档位（caption 色）+ chevron
  // 静止态不加底色（官方 trigger 同样透明），只在 hover/展开时给一层 hover 底
  '.dsh-recall-composer-chip-btn{display:inline-flex;align-items:center;gap:4px;height:28px;max-width:260px;padding:0 6px 0 10px;border:0;font-family:inherit;cursor:pointer;background:0 0}',
  '.dsh-recall-composer-chip-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-composer-chip-btn.is-open{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-composer-chip-btn:disabled{opacity:.6;cursor:default}',
  '.dsh-recall-composer-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
  '.dsh-recall-composer-chip-effort{flex:none;color:var(--dsw-alias-label-caption)}',
  '.dsh-recall-composer-chip-chevron{flex:none;display:grid;place-items:center;color:var(--dsw-alias-label-caption);transition:transform .12s}',
  '.dsh-recall-composer-chip-btn.is-open .dsh-recall-composer-chip-chevron{transform:rotate(180deg)}',
  // 模型菜单：度量对齐官方（4px 内边距、34px 行高、13px 名字、md 圆角、prominent 阴影）。
  // 底色用不透明 bg-base——官方那层半透明材质是构建期哈希类名，跨版本不可依赖
  '.dsh-recall-menu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:7;display:flex;flex-direction:column;width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100vh - 96px);padding:4px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}',
  '.dsh-recall-menu-cell{display:flex;align-items:center;gap:6px;width:100%;height:34px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
  '.dsh-recall-menu-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-menu-cell-label{flex:none;white-space:nowrap}',
  '.dsh-recall-menu-cell-value{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:13px}',
  '.dsh-recall-menu-cell-chevron{flex:none;display:grid;place-items:center;color:var(--dsw-alias-menu-icon,var(--dsw-alias-label-tertiary))}',
  '.dsh-recall-menu-search-row{flex:none;margin:2px 0 3px}',
  '.dsh-recall-menu-search{display:flex;align-items:center;padding:5px 7px;border-radius:var(--dsw-radius-md)}',
  '.dsh-recall-menu-search input{flex:1;min-width:0;border:0;background:0 0;outline:none;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary)}',
  '.dsh-recall-menu-search input::placeholder{color:var(--dsw-alias-label-caption)}',
  '.dsh-recall-menu-groups{min-height:0;overflow-y:auto}',
  // 分组标题吸顶：长列表滚动时保持「当前是哪家」可见，与官方一致
  '.dsh-recall-menu-heading{position:sticky;top:0;z-index:1;padding:4px 7px 2px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
  '.dsh-recall-menu-option{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:5px 7px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}',
  '.dsh-recall-menu-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-menu-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-recall-menu-option-active{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-menu-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-recall-menu-check{flex:0 0 14px;display:grid;place-items:center;color:var(--dsw-alias-label-primary)}',
  '.dsh-recall-menu-empty{padding:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
  '.dsh-recall-composer-hint{margin-left:auto;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-recall-composer-send{flex:none;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:50%;corner-shape:round;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);cursor:pointer}',
  '.dsh-recall-composer-send:disabled{opacity:.4;cursor:default}',
  '.dsh-recall-composer-dot{width:8px;height:8px;border-radius:50%;corner-shape:round;background:currentColor;animation:dsh-recall-pulse 1.2s ease-in-out infinite}',
  // 窄屏：提示让位，否则 chip 与发送键会被挤到换行
  '@media (max-width:480px){.dsh-recall-composer-hint{display:none}.dsh-recall-composer-chip{max-width:120px}}',
  // 编辑态隐藏底部输入框的统计 dock（回合/步骤、tok/s、缓存、Trace）：编辑焦点
  // 在消息处的卡片上，dock 属全局概览，留着只会分心；挂在既有的 data-editing 上
  'body:has(.dsh-recall-row[data-editing="true"]) [data-composer-dock]{display:none}',
  // 版本翻页器（‹ X/N ›）：灰字 + 无边框的轻量控件，附在回合操作区末尾，
  // 视觉重量低于复制/重试等官方动作，不抢注意力
  '.dsh-recall-pager{display:inline-flex;align-items:center;gap:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1}',
  '.dsh-recall-pager-btn{border:0;background:0;color:inherit;cursor:pointer;padding:3px 6px;border-radius:6px;font-size:13px;line-height:1}',
  '.dsh-recall-pager-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-pager-btn:disabled{opacity:.35;cursor:default}',
  '.dsh-recall-pager-count{min-width:30px;text-align:center;font-variant-numeric:tabular-nums}',
  '.dsh-recall-pager[data-busy=true]{opacity:.6;pointer-events:none}',
  // 无家族可翻时容器是空的：:empty 让占位为 0，不在操作区留一段空隙
  '.dsh-recall-pager:empty{display:none}',
  '.dsh-recall-list{max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:4px 0}',
  '.dsh-recall-file{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:1.5}',
  '.dsh-recall-badge{flex:none;font-size:12px;line-height:1.5;padding:0 6px;border-radius:6px}',
  '.dsh-recall-badge-modified{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}',
  '.dsh-recall-badge-restored{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-badge-added{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-rel{min-width:0;color:var(--dsw-alias-label-primary);word-break:break-all;font-family:var(--dsw-font-code, ui-monospace, SFMono-Regular, Consolas, monospace)}',
  // grid-column 对非 grid 祖先（exclude/快照卡片的 flex 布局）自动无效，无害；
  // 在 cfg-grid 内则保证操作区/占满行不被 auto-placement 塞进第一列撑爆列宽。
  '.dsh-recall-panel-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:2px;grid-column:1/-1}',
  // scope radio 组（撤回范围二选一）：原生 input 保留 UA 交互（键盘方向键切换、
  // 空格选中），accent-color 走品牌令牌让选中态随主题翻转；label 整体可点扩大
  // 命中区，字色与 panel-note 同层级（secondary），hover 提亮示意可交互
  '.dsh-recall-scope{display:flex;flex-wrap:wrap;gap:4px 16px;padding:2px 0}',
  '.dsh-recall-scope-item{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
  '.dsh-recall-scope-item:hover{color:var(--dsw-alias-label-primary)}',
  '.dsh-recall-scope-item input{accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}',
  // 焦点可见性对齐按钮类约定（brand-primary 2px outline）：UA 默认环跨引擎不一，
  // 统一收敛到与面板内其他控件同一套焦点语言
  '.dsh-recall-scope-item input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
  // 按钮体系对齐官方设置卡（dsh-client-ui-settings-plugins PluginCard 底部按钮
  // 组实测产物）：次级 = 描边幽灵（discard 逐字配方——l2 描边 + 透明底，hover
  // 升 label-dimmed 描边 + primary 字色）；官方 discard/save 同高靠 save 也带
  // 1px 描边，故变体统一 border-color:transparent 保同盒模型。hover 用
  // :not(:disabled) 收口后，disabled 的 hover 抵消规则不再需要；disabled 透明度
  // 随官方 .4。
  '.dsh-recall-btn{border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
  '.dsh-recall-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
  '.dsh-recall-btn:disabled,.dsh-recall-ex-chip:disabled{opacity:.4;cursor:default}',
  // 按下确认感：hover 只表示「可点」，active 才表示「已触发」；位移 .5px 不引
  // 发布局抖动，对 primary/danger 实心变体同样生效（它们 hover 无视觉变化，
  // 此前点击全程零反馈）
  '.dsh-recall-btn:active:not(:disabled){transform:translateY(.5px)}',
  // 危险按钮与前一按钮的物理间隔：panel-actions 的 gap:8px 对常规按钮是分组，
  // 对危险按钮不够——误点「全部删除」的代价不可逆，再加 8px 拉开
  '.dsh-recall-btn-gap{margin-left:8px}',
  // 危险/主按钮的 hover 须显式重申文字与描边——基础 ghost hover 带伪类、优先级
  // 更高，会把它们的字色刷回 label-primary 并描出亮边
  '.dsh-recall-btn-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}',
  '.dsh-recall-btn-danger:hover:not(:disabled){color:var(--dsw-alias-bg-layer-3);border-color:transparent;filter:var(--dsh-recall-btn-danger-hover)}',
  // 主按钮（保存）改用官方插件设置卡 save 的逐字配方：label-primary 反色实心 +
  // bg-layer-3 前景（同列官方插件卡的保存即此形态，比 button-primary-fill 更贴
  // 设置页语境）；官方 save 无 hover 态，这里的 hover 规则只做「不被基础 ghost
  // hover 污染」的抵消，视觉变化为零即是官方行为。只挂「保存」，主次分明。
  '.dsh-recall-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}',
  '.dsh-recall-btn-primary:hover:not(:disabled){color:var(--dsw-alias-bg-layer-3);border-color:transparent}',
  // 焦点可见性对齐官方设置页实测写法（同上产物）：按钮类 = brand-primary 2px
  // outline（卡片头 offset -2px 内收，其余 +1px）；输入类 = brand-primary 描边
  // 变色、不套 ring。替换 V2-5 的 border-l3 环方案（当时核验的是旧版写法）。
  '.dsh-recall-btn:focus-visible,.dsh-recall-ex-chip:focus-visible,.dsh-recall-tree-toggle:focus-visible,.dsh-recall-cfg-switch:focus-visible,.dsh-recall-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
  '.dsh-recall-cardbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.dsh-recall-ex-input:focus-visible,.dsh-recall-cfg-input:focus-visible,.dsh-recall-cfg-select:focus-visible,.dsh-recall-ex-area:focus-visible,.dsh-recall-cfg-area:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
  // 输入类 hover 中间态：rest l4 → hover l3 → focus brand 三级递进，与按钮的
  // 描边 hover 逻辑同语言；:not(:focus-visible) 收口是防 hover 伪类（特异性更
  // 高）把 focus 的品牌色描边刷回 l3
  '.dsh-recall-ex-input:hover:not(:disabled):not(:focus-visible),.dsh-recall-cfg-input:hover:not(:disabled):not(:focus-visible),.dsh-recall-cfg-select:hover:not(:disabled):not(:focus-visible),.dsh-recall-ex-area:hover:not(:disabled):not(:focus-visible),.dsh-recall-cfg-area:hover:not(:disabled):not(:focus-visible){border-color:var(--dsw-alias-border-l3)}',
  '.dsh-recall-toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:10000;max-width:min(560px,86vw);box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 16px;font-size:13px;line-height:1.5;box-shadow:0 8px 28px rgba(0,0,0,.22);display:flex;align-items:baseline;gap:8px;opacity:0;transition:opacity .25s ease;pointer-events:auto}',
  '.dsh-recall-toast.dsh-recall-toast-in{opacity:1}',
  '.dsh-recall-toast-tag{flex:none;font-weight:600;color:var(--dsw-alias-state-error-primary)}',
  '.dsh-recall-ex-card{display:flex;flex-direction:column;gap:8px}',
  // 分区折叠头标题：与表单分组标题（cfg-group）同款 14px/700 + label-primary——
  // 折叠头在视觉上是「下一个分组」的入口，同款排版 + 同一条左缘线，扫读时与
  // 上方分组标题连成一体（用户实测反馈：13px/600 secondary 看起来是另一套层级、
  // 且左缘错位）
  '.dsh-recall-section-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5;font-weight:700}',
  '.dsh-recall-ex-note{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;word-break:break-word}',
  // 存储路径独立行：等宽字体 + break-all，Windows 长路径整齐折行；12px tertiary
  // 降为辅助信息层级（与说明正文同色系但更轻），margin-top 收紧与上一行说明的
  // 归属关系（ex-card 统一 gap 8px 对「说明→其路径」偏松）。
  '.dsh-recall-ex-path{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-family:var(--dsw-font-code, ui-monospace, SFMono-Regular, Consolas, monospace);word-break:break-all;margin-top:-4px}',
  // 输入类控件统一官方 field input 配方（At1oFq_input 逐字）：.5px l4 发丝描边 +
  // layer-3 底 + 8px 圆角 + 0/12px 内边距（单行框 34px 高）；卡片打开态底色是
  // layer-2，layer-3 输入框在其上恰好与官方插件配置卡同层叠关系
  '.dsh-recall-ex-area{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.5;font-family:var(--dsw-font-code, ui-monospace, SFMono-Regular, Consolas, monospace);resize:vertical;min-height:120px}',
  '.dsh-recall-ex-quick{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
  '.dsh-recall-ex-input{flex:1;min-width:180px;box-sizing:border-box;height:34px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
  // 快照管理搜索行：框高 34px × 1.2 ≈ 41px（搜索是卡片首屏的主入口，加高后
  // 命中区更大）；图标绝对定位在框内左侧、pointer-events:none 不挡点击，输入框
  // 用 padding-left 让出图标位（覆写只 scope 到 .dsh-recall-search 内，排除配置的
  // 快速添加框维持原高）
  '.dsh-recall-search{position:relative;display:flex;align-items:center}',
  '.dsh-recall-search .dsh-recall-ex-input{height:41px;padding-left:38px}',
  '.dsh-recall-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--dsw-alias-label-tertiary);pointer-events:none}',
  // chip 改官方 badge 丸形配方（bg-module-platform + 999px）——树内小操作与
  // 排除建议属「标签级动作」，与状态徽章同形态更一致；hover 用 :not(:disabled)
  // 收口（与按钮同法）
  '.dsh-recall-ex-chip{border:none;border-radius:999px;corner-shape:round;padding:1px 10px;font-size:12px;line-height:1.5;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}',
  '.dsh-recall-ex-chip:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
  // V9 确认按钮 danger chip：红色文字 + 官方失败状态行底，与 .btn-danger 同义
  // 但保持 chip 尺寸层级（确认条内部不出现大按钮）
  '.dsh-recall-ex-chip-danger{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}',
  // 基础 chip hover 带伪类、优先级更高，会把危险 chip 的红字刷回普通色——
  // 显式重申保持 hover 下仍是红字（危险语义在悬停确认时最不能丢）
  '.dsh-recall-ex-chip-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
  // 树行内图标按钮（删除）：20px 方盒保证命中区，静息 tertiary 不抢读、hover
  // 转 error 色 + 危险底色（危险语义在悬停确认时显现，安全兜底是行内确认条）。
  // align-self:center 抵消 tree-label 的 baseline 对齐——SVG 的基线在底边，
  // 随基线摆会浮在文字上方
  '.dsh-recall-icon-btn{flex:none;align-self:center;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:0 0;cursor:pointer;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-recall-icon-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
  '.dsh-recall-ex-status{margin-right:auto;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-recall-ex-status-error{color:var(--dsw-alias-state-error-primary)}',
  // 空状态（无快照/搜索无匹配）：居中 + 24px 上下留白，与官方空列表形态
  // 对齐；此前复用 ex-note 左对齐正文样式，空列表区显得是「缺了一行」而非
  // 一个状态
  '.dsh-recall-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;text-align:center;padding:24px 0}',
  // 列表读取失败条（issue #30 遗留项）：error 前景 + 换行不裁切，右侧带重试 chip。
  // 与空态区分开——「没有快照」和「读不到快照」在用户眼里必须是两件事
  '.dsh-recall-list-error{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}',
  '.dsh-recall-list-error-text{flex:1;min-width:0;word-break:break-word}',
  '.dsh-recall-ex-status-success{color:var(--dsw-alias-state-success-primary)}',
  // V6 健康徽章（git 可用性）：pill 配色直接复用官方状态行配对——成功用
  // success-tertiary 底、失败用 interactive-bg-hover-danger 底（error 无
  // tertiary 令牌，官方失败状态行即用此搭配，主题感知）。
  '.dsh-recall-health-pill{display:inline-flex;align-items:center;padding:1px 10px;border-radius:999px;corner-shape:round;font-size:12px;line-height:1.5}',
  '.dsh-recall-health-pill-ok{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
  '.dsh-recall-health-pill-bad{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
  // V6 错误区标题：error 色 + 条数，错误不再是灰色小字（fail-loud 可见性）
  '.dsh-recall-errors-title{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;font-weight:600}',
  '.dsh-recall-tree{display:flex;flex-direction:column;gap:2px;padding:4px 0}',
  '.dsh-recall-tree-node{display:flex;flex-direction:column;gap:1px}',
  '.dsh-recall-tree-row{display:flex;gap:6px;align-items:center;min-width:0;padding:2px 4px;border-radius:6px;cursor:default}',
  '.dsh-recall-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  // 可展开的行整行可点（仅快照管理树）：只命中 18px 折叠钮太难，cursor 也跟着
  // 变指针，提示「这一行都是命中区」
  '.dsh-recall-tree-row-toggle{cursor:pointer}',
  // V2 树折叠钮 span→button 的 UA 默认样式重置：button 自带 appearance/背景/边框/
  // 内边距，与 span 形态差异在此抹平，保证纯键盘可达不引入视觉回归。
  '.dsh-recall-tree-toggle{appearance:none;background:0 0;border:0;padding:0;font:inherit;flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:4px;font-size:12px;line-height:1.5;user-select:none}',
  '.dsh-recall-tree-toggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-recall-tree-toggle-placeholder{flex:none;width:18px;height:18px}',
  '.dsh-recall-tree-label{flex:1;min-width:0;display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:1.5;overflow:hidden}',
  '.dsh-recall-tree-name{flex:none;font-weight:600;color:var(--dsw-alias-label-secondary)}',
  '.dsh-recall-tree-title{min-width:0;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  // issue #31：仅消息条目的静态标记——与 ex-chip 同丸形，但非按钮、无 hover
  '.dsh-recall-tree-tag{flex:none;border-radius:999px;corner-shape:round;padding:0 8px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);white-space:nowrap}',
  // tabular-nums：树 meta 列（「3 会话 / 28 快照」「v2/3」）多行纵向扫描时
  // 数字等宽，个位对齐不跳动
  '.dsh-recall-tree-meta{flex:none;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}',
  // V4 树缩进契约化：总缩进 = --dsh-recall-tree-indent（折叠钮 18px + gap 6px），
  // children 按 2/3（16px margin）与 1/3（8px padding）拆分，恰好让子行文字
  // 与父行折叠钮右缘对齐——把「16+8 恰等于 18+6」的巧合变成单一事实源。
  '.dsh-recall-tree-children{display:flex;flex-direction:column;gap:1px;margin-left:calc(var(--dsh-recall-tree-indent)*2/3);border-left:1px solid var(--dsw-alias-border-l1);padding-left:calc(var(--dsh-recall-tree-indent)/3);animation:dsh-recall-unfold .16s ease-out}',
  '.dsh-recall-tree-confirm{display:flex;gap:8px;align-items:center;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);animation:dsh-recall-unfold .16s ease-out}',
  // V9 展开动效：opacity + 2px 上移入场（确认条/树展开共用一个 keyframes）。
  // 弃用 max-height 过渡：树展开高度可变（长列表数百 px），固定上限会裁切；
  // opacity+位移给出同等显隐反馈且零裁切风险。
  '@keyframes dsh-recall-unfold{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}',
  '@media (prefers-reduced-motion:reduce){.dsh-recall-tree-children,.dsh-recall-tree-confirm,.dsh-recall-settings-body,.dsh-recall-section-body{animation:none}}',
  // 设置块容器：插件设置项直接平铺在设置页上（用户实测反馈——先去掉外层折叠头、
  // 再去掉卡片外框，两层包裹皆属冗余）：无描边、无底色、无圆角，只做纵向排版
  // 与 list-style 归零（li 默认圆点/缩进须清）
  '.dsh-recall-settings{list-style:none;display:flex;flex-direction:column;text-align:left}',
  // settings-body 挂载即播放一次 unfold 入场（opacity + 2px 上移，.16s）：随设置页
  // 进入即挂载，入场动画起到「内容就位」的引导作用；内部两个分区（排除/快照管理）
  // 展开时另有 section-body 容器承载
  '.dsh-recall-settings-body{display:flex;flex-direction:column;gap:12px;animation:dsh-recall-unfold .16s ease-out}',
  // SectionToggle 仍复用卡片头按钮形态（可点整行 + 焦点环），仅在设置块内覆写
  // 内边距：14/16px 会让折叠头相对表单标签右缩进 16px（用户实测与分组标题/
  // 表单内容错位）；纵向 8px 给标题级排版留呼吸，与 cfg-group 的 8px 节奏同档
  '.dsh-recall-settings-body .dsh-recall-cardbtn{padding:8px 0}',
  '.dsh-recall-cardbtn{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
  // 折叠分区列表与上方表单的分界线，挂在首个折叠头上（「高级：基础排除表」）：
  // .5px l2 + 上下各 8px，与 cfg-group 的组间线同规格，整列排版只有一种分割语言。
  // 线用绝对定位的伪元素画，不用 border-top——cardbtn 带 12px 圆角，border-top
  // 会沿圆角走、两端上翘（实测）；伪元素横贯全宽且保持按钮圆角不被破坏（焦点环
  // 仍沿圆角）。双类选择器压过 `.dsh-recall-settings-body .dsh-recall-cardbtn` 的
  // padding 覆写（同为 0,2,0 时靠后取胜）
  '.dsh-recall-cardbtn.dsh-recall-section-divider{position:relative;margin-top:8px;padding-top:8px}',
  '.dsh-recall-cardbtn.dsh-recall-section-divider::before{content:"";position:absolute;top:0;left:0;right:0;height:.5px;background:var(--dsw-alias-border-l2)}',
  // 展开分区的内容容器（排除配置/快照管理）：不再自带描边/底色/圆角——外层
  // 卡片框去掉后，内容区再套一层框等于把「去包裹」又加回来（用户实测反馈）；
  // 容器只保留纵向间距与展开入场动画
  '.dsh-recall-section-body{display:flex;flex-direction:column;gap:12px;animation:dsh-recall-unfold .16s ease-out}',
  // 折叠头 chevron 收在行尾（margin-left:auto 顶到右缘，官方卡片头同布局）：
  // 向下字形，收起态向下、展开态 rotate(180deg) 朝上，transition .16s 与官方
  // 卡片 chevron 同一动效语言。树内折叠钮（snapshot-manager chevronIcon）同枚
  // SVG、在 18px 盒内左侧、旋转挂内联 style，不受这两条类规则约束
  '.dsh-recall-section-chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);transition:transform .16s}',
  '.dsh-recall-section-chevron-open{transform:rotate(180deg)}',
  // hover 反馈只提亮 chevron：标题保持 label-primary（已是最高层级，再变无可变），
  // 可点提示由尾部箭头承担
  '.dsh-recall-settings-body .dsh-recall-cardbtn:hover .dsh-recall-section-chevron{color:var(--dsw-alias-label-primary)}',
  // cfg-grid：ConfigForm 全部行共享的单一 grid 容器。此前每行 cfg-row 是独立
  // grid，「第一列 max-content」各行各算，跨行对齐从未成立（checkbox/输入框
  // 列参差）；cfg-row 改 display:contents 透明化后，label/控件行/hint 直接成为
  // 本容器的 item，第一列列宽由全表单最长 label 决定——跨行对齐自此成立。
  // 三列：标签 | 控件 | 说明。控件列 max-content 取全表单最宽的一行（输入框 120px
  // + 该行 tag），说明列起点因此由列宽统一决定，不随各行 tag 宽度（条/小时/MB/天）
  // 逐行漂移；column-gap 12px（space-3 档）与卡片内其他 12px 节奏同档
  '.dsh-recall-cfg-grid{display:grid;grid-template-columns:max-content max-content minmax(0,1fr);column-gap:12px;row-gap:4px;align-items:start}',
  '.dsh-recall-cfg-row{display:contents}',
  '.dsh-recall-cfg-grid > .dsh-recall-cardbtn{grid-column:1/-1}',
  // V5 表单分组小标题：语义分组分隔符。组间用整行分隔线 + 加倍留白划界
  // （「快照行为」「自动治理」是两个配置维度，仅小标题用户实测分不清组界）；
  // 首组（紧跟卡片头）不需要分隔线，三件套清零。
  // 组间分隔线随官方发丝线规格（.5px l2，与官方卡体/字段分隔同粗细）；
  // 分隔线上下各 8px、总节奏 16px（4 的倍数），替代原 10px 非标准档。
  // 14px/700 + label-primary：分组标题与字段标签（13px/500）必须一眼可辨，
  // 13px/600 secondary 与字段标签只差字重，用户实测反馈「分不清小标题」
  '.dsh-recall-cfg-group{color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5;font-weight:700;grid-column:1/-1;margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2)}',
  '.dsh-recall-cfg-group:first-child{margin-top:0;padding-top:0;border-top:none}',
  // 控件行 min-height:34px 与输入框等高——开关行（20px 滑钮）与输入行因此同高，
  // 第一列 label 的垂直居中基准统一，不随控件形态跳动。占第二列（grid-column:2
  // 是显式定位：每字段的 label/控件/说明落在同一行，靠它锚定）
  '.dsh-recall-cfg-line{grid-column:2;display:flex;align-items:center;gap:8px;min-width:0;min-height:34px}',
  // 开关行变体：滑钮右缘对齐数字行输入框的右边框（不是控件列右缘——列右缘由
  // 最宽的单位 tag 决定，`条`/`天` 行的输入框右缘本来就追不上它）。滑钮左推
  // (输入框宽 - 滑钮宽) 后，它占据的正是输入框那一段槽位，其后的状态 tag 也就
  // 与数字行的单位 tag 同起点——两行的「控件 + tag」结构遂逐列对齐
  '.dsh-recall-cfg-line-switch .dsh-recall-cfg-switch{margin-left:calc(var(--dsh-recall-input-w) - var(--dsh-recall-switch-w))}',
  // 主标签用 label-primary + 官方字段标签字重 500（At1oFq_label），与 12px
  // tertiary 的说明文字拉开层级；说明固定在控件下方第二行，不混排进主标签行。
  // line-height:34px 让标签文字在行首 34px 高度内垂直居中——与同排 34px 的
  // 输入框/开关行共用同一中轴（align-self:start 顶到行首，不能靠 grid 居中：
  // 行高由「控件 + 多行 hint」决定，居中的话标签会跟着 hint 高度漂移）
  '.dsh-recall-cfg-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:34px;align-self:start}',
  // 数字输入框 = 官方 field input 配方（.5px l4 发丝描边 + layer-3 底 + 34px
  // 高 + 0/12px 内边距）叠加本插件既有约定：定宽 120px + 右对齐（不定宽时框宽
  // 随行内 tag 有无伸缩，实测参差）；tabular-nums 让同列数字等宽、纵向扫描
  // 小数位整齐。120px 足够容纳「0.01」~「1000000」区间。
  '.dsh-recall-cfg-input{flex:none;width:var(--dsh-recall-input-w);box-sizing:border-box;height:34px;font:inherit;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:0 12px}',
  // disabled 随官方 input：文字降 tertiary，不动透明度（整框变淡会让「框还在
  // 只是不可写」的语义变含糊）
  '.dsh-recall-cfg-input:disabled,.dsh-recall-cfg-select:disabled,.dsh-recall-cfg-area:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  // 数字输入框隐藏原生加减微调按钮（spinner）：34px 高的定宽框里 spinner 挤占
  // 右侧数字区、跨引擎渲染不一（Chromium 上下箭头 / Firefox 无），与「右对齐
  // 数字」的纵向扫描相冲；隐藏后键盘 ↑↓ 与直接输入仍可用，步进语义不丢。
  // scope 到 cfg-input，不外溢影响宿主或其他插件的 number 输入。
  '.dsh-recall-cfg-input::-webkit-inner-spin-button,.dsh-recall-cfg-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}',
  '.dsh-recall-cfg-input{-moz-appearance:textfield;appearance:textfield}',
  // 语言下拉（A4）：与数字输入框同一套描边/底色/高度配方，差异只在文本左对齐
  // 与宽度自适应——select 的选项文本长度不可控（Follow system (auto) 最长），
  // 定宽会截断；min-width 与输入框同宽保住「控件列」的视觉对齐基线
  '.dsh-recall-cfg-select{flex:none;box-sizing:border-box;height:34px;min-width:var(--dsh-recall-input-w);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:0 8px 0 10px}',
  '.dsh-recall-cfg-area{font-family:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:6px 8px;min-height:64px;box-sizing:border-box;width:100%;grid-column:2}',
  // 布尔开关：官方设置表单的布尔字段用 role=switch 滑钮而非原生 checkbox
  //（vCGm7G_switch 逐字配方：36×20 轨道 border-l3 底、开=brand-primary、
  // 16px 拇指 label-primary-foreground 滑动 16px、transition .12s）
  // 跨引擎一致性的加固（用户实测：同一开关在不同浏览器观感不同）：button 各
  // 引擎自带 UA appearance（Safari 的 -webkit-appearance:button 会覆写圆角与
  // 内边距、Firefox 另有 ::-moz-focus-inner 内衬）与各自的字体度量（匿名行盒
  // 会参与内容高度计算）——故显式收敛为 inline-flex + font:inherit + line-height:0。
  // corner-shape:round 见拇指处的说明（DSH 主题的全局超椭圆圆角）
  '.dsh-recall-cfg-switch{appearance:none;-webkit-appearance:none;box-sizing:border-box;flex:none;display:inline-flex;align-items:center;width:var(--dsh-recall-switch-w);height:20px;padding:2px;margin:0;border:0;border-radius:10px;corner-shape:round;background:var(--dsw-alias-border-l3);font:inherit;line-height:0;cursor:pointer;position:relative}',
  '.dsh-recall-cfg-switch::-moz-focus-inner{border:0;padding:0}',
  '.dsh-recall-cfg-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
  '.dsh-recall-cfg-switch:disabled{opacity:.4;cursor:default}',
  // switch hover 微提亮（官方 switch 无 hover 态，此处补上不伤一致性）：开态
  // brand 底与关态 border-l3 底同用 brightness，两态反馈强度一致
  '.dsh-recall-cfg-switch:hover:not(:disabled){filter:brightness(1.05)}',
  // corner-shape:round 是必须的：DSH 主题包在支持该属性的浏览器里给「所有元素」
  // 下发 --dsw-corner-shape: superellipse(1.5)（`*,:before,:after{corner-shape:
  // var(--dsw-corner-shape)}`），圆形/胶囊会被渲染成超椭圆（squircle，观感更方）。
  // 官方同样在 104 处圆形/胶囊元素上显式写回 round（含本开关的轨道与拇指）；
  // 不写回则新版 Edge 与旧内核（如 IDE 内置浏览器，不认该属性）观感不一致
  '.dsh-recall-cfg-switch-thumb{flex:none;display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s}',
  '.dsh-recall-cfg-switch[aria-checked="true"] .dsh-recall-cfg-switch-thumb{transform:translateX(16px)}',
  // 说明列（第三列）：padding-top 8px 把首行文字的视觉中线抬到 34px 控件行的
  // 中线上（12px × 1.5 = 18px 行盒，居中需上移 (34-18)/2 = 8px），与标签的
  // line-height:34px 是同一个中轴的两种写法；padding-bottom 即字段间距的单一
  // 事实源（网格 row-gap 只管行缝），行间节奏维持 8+4=12px
  '.dsh-recall-cfg-hint{grid-column:3;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;min-width:0;padding-top:8px;padding-bottom:8px}',
  // 基础排除表通栏（baseExcludes textarea/hint）：折叠展开后内容顶满卡片宽度，
  // 消除左侧 label 列竖直死区。必须定义在 480px media 之前——media 内的
  // grid-column:auto 同特异性、后出现，窄屏下仍能正确回落单列堆叠。
  '.dsh-recall-cfg-span{grid-column:1/-1}',
  // V4/V8 共用 480px 断点：cfg 表单单列堆叠（V4）；exclude quick 行输入框独占
  // 一行（flex:1 1 100%，basis 100% 强制换行，添加按钮与芯片建议另起一行）、
  // panel-actions 长状态文案不再挤压按钮（wrap 已在基础规则，此处无需重复）。
  // 窄屏单列堆叠：三列回落为逐行堆叠（控件行/说明列各自独占一行）。label 的
  // 34px 行高是为「与同排控件共用中轴」而设，堆叠后 label 独占一行、行高与
  // 说明的上边距都要复位，否则标签与控件之间空出一大截
  '@media (max-width:480px){.dsh-recall-cfg-grid{grid-template-columns:minmax(0,1fr);row-gap:2px}.dsh-recall-cfg-line,.dsh-recall-cfg-hint,.dsh-recall-cfg-area{grid-column:auto}.dsh-recall-cfg-label{align-self:auto;line-height:1.5}.dsh-recall-cfg-hint{padding-top:0}.dsh-recall-cfg-line-switch .dsh-recall-cfg-switch{margin-left:0}.dsh-recall-ex-quick .dsh-recall-ex-input{flex:1 1 100%}}',
  '.dsh-recall-cfg-tag{flex:none;font-size:12px;line-height:1.4;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}',
  // 已修改（用户改了配置）用 warn 底色提示「有未保存变更」——修改不是错误，
  // warn 家族来自 V1 核验的官方配对（tertiary 底 + label 文）。
  '.dsh-recall-cfg-tag-modified{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}',
  // 环境变量锁定：系统锁住不可写，区别于「已覆盖」（值被更高优先源覆盖）——
  // 两者同属中性，用左边框做结构级区分，不引入第三色。
  '.dsh-recall-cfg-tag-locked{border-left:2px solid var(--dsw-alias-border-l2)}',
  // V3 快照树加载骨架：items===null 时的 5 条占位行，pulse 明暗呼吸模拟加载。
  '.dsh-recall-tree-skeleton{display:flex;flex-direction:column;gap:2px;padding:4px 0}',
  '.dsh-recall-tree-skeleton-row{height:20px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);animation:dsh-recall-pulse 1.2s ease-in-out infinite}',
  '@keyframes dsh-recall-pulse{0%,100%{opacity:1}50%{opacity:.45}}'
].join('')
