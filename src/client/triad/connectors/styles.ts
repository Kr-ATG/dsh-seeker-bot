/**
 * dsh-seeker-bot — 「连接器」页样式（运行时注入 style 标签，幂等）。
 *
 * 视觉取向照 ChatGPT Connectors：一行搜索框 + 一条分类胶囊 + 双列图标卡。
 * 卡片的信息密度压到最低（图标 / 名称 / 一句 tagline / 右侧状态），
 * 细节全部留给点开后的详情抽屉。
 *
 * 颜色一律走 --dsw-alias-* token，深浅主题自动跟随；不写死任何色值。
 *
 * ⚠ 本文件的整张样式表是一个模板字面量：注释里绝对不能出现反引号，
 * 否则模板提前闭合（build.mjs 有源码级守卫）。
 */

/** 类名表（组件侧统一从这里取）。 */
export const css = {
  root: 'dsh-mc',
  head: 'dsh-mc-head',
  headTop: 'dsh-mc-head-top',
  eyebrow: 'dsh-mc-eyebrow',
  title: 'dsh-mc-title',
  sub: 'dsh-mc-sub',
  search: 'dsh-mc-search',
  searchInput: 'dsh-mc-search-input',
  chips: 'dsh-mc-chips',
  chip: 'dsh-mc-chip',
  chipOn: 'dsh-mc-chip-on',
  count: 'dsh-mc-count',
  scroll: 'dsh-mc-scroll',
  section: 'dsh-mc-section',
  sectionHead: 'dsh-mc-section-head',
  sectionTitle: 'dsh-mc-section-title',
  grid: 'dsh-mc-grid',
  card: 'dsh-mc-card',
  cardIcon: 'dsh-mc-card-icon',
  cardIconFallback: 'dsh-mc-card-icon-fallback',
  cardBody: 'dsh-mc-card-body',
  cardName: 'dsh-mc-card-name',
  cardTag: 'dsh-mc-card-tag',
  cardAction: 'dsh-mc-card-action',
  addBtn: 'dsh-mc-add',
  installedBtn: 'dsh-mc-installed',
  empty: 'dsh-mc-empty',
  notice: 'dsh-mc-notice',
  drawerMask: 'dsh-mc-mask',
  drawer: 'dsh-mc-drawer',
  drawerHead: 'dsh-mc-drawer-head',
  drawerIcon: 'dsh-mc-drawer-icon',
  drawerTitles: 'dsh-mc-drawer-titles',
  drawerName: 'dsh-mc-drawer-name',
  drawerAuthor: 'dsh-mc-drawer-author',
  closeBtn: 'dsh-mc-close',
  drawerBody: 'dsh-mc-drawer-body',
  desc: 'dsh-mc-desc',
  fieldLabel: 'dsh-mc-field-label',
  field: 'dsh-mc-field',
  fieldInput: 'dsh-mc-field-input',
  fieldHint: 'dsh-mc-field-hint',
  code: 'dsh-mc-code',
  metaRow: 'dsh-mc-meta-row',
  metaKey: 'dsh-mc-meta-key',
  metaVal: 'dsh-mc-meta-val',
  drawerFoot: 'dsh-mc-drawer-foot',
  primaryBtn: 'dsh-mc-primary',
  dangerBtn: 'dsh-mc-danger',
  ghostBtn: 'dsh-mc-ghost',
  error: 'dsh-mc-error',
}

const STYLE_ID = 'dsh-mcp-connectors-style'

const CSS_TEXT = [
  '.dsh-mc{display:flex;flex-direction:column;gap:0;height:100%;min-height:0;box-sizing:border-box;padding:22px 26px 0;}',
  '.dsh-mc-head{flex:none;padding:0 0 14px;display:flex;flex-direction:column;gap:10px;}',
  '.dsh-mc-head-top{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;}',
  '.dsh-mc-eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
  '.dsh-mc-eyebrow i{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3d6be5);display:inline-block;}',
  '.dsh-mc-title{font-size:26px;line-height:34px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);margin:0;}',
  '.dsh-mc-title em{font-style:normal;font-weight:400;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:15px;margin-left:6px;}',
  '.dsh-mc-sub{margin:0;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
  '.dsh-mc-count{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums;}',
  '.dsh-mc-search{position:relative;display:flex;align-items:center;}',
  '.dsh-mc-search svg{position:absolute;left:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);pointer-events:none;}',
  '.dsh-mc-search-input{width:100%;height:38px;padding:0 14px 0 36px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-l2,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:13px;outline:none;transition:border-color .15s,background .15s;}',
  '.dsh-mc-search-input:focus{border-color:var(--dsw-alias-state-business-primary,#3d6be5);background:var(--dsw-alias-bg-base,#fff);}',
  '.dsh-mc-chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none;}',
  '.dsh-mc-chips::-webkit-scrollbar{display:none;}',
  '.dsh-mc-chip{flex:none;height:30px;padding:0 13px;border-radius:15px;border:1px solid transparent;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,#5c5c5c);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s;}',
  '.dsh-mc-chip:hover{background:var(--dsw-alias-bg-l3,rgba(127,127,127,.14));}',
  '.dsh-mc-chip-on{background:var(--dsw-alias-label-primary,#1a1a1a);color:var(--dsw-alias-bg-base,#fff);}',
  '.dsh-mc-chip-on:hover{background:var(--dsw-alias-label-primary,#1a1a1a);}',
  '.dsh-mc-scroll{flex:1;min-height:0;overflow-y:auto;padding:2px 2px 26px;}',
  '.dsh-mc-section{margin-top:14px;}',
  '.dsh-mc-section:first-child{margin-top:2px;}',
  '.dsh-mc-section-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}',
  '.dsh-mc-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);}',
  '.dsh-mc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;}',
  '.dsh-mc-card{display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:13px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));background:var(--dsw-alias-bg-base,#fff);cursor:pointer;transition:border-color .15s,transform .15s,box-shadow .15s;text-align:left;font:inherit;}',
  '.dsh-mc-card:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.3));transform:translateY(-1px);box-shadow:0 3px 12px rgba(0,0,0,.06);}',
  '.dsh-mc-card-icon{flex:none;width:40px;height:40px;border-radius:10px;object-fit:contain;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.07));padding:3px;}',
  '.dsh-mc-card-icon-fallback{flex:none;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:#fff;background:linear-gradient(135deg,#5b8def,#3d6be5);}',
  '.dsh-mc-card-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}',
  '.dsh-mc-card-name{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
  '.dsh-mc-card-tag{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
  '.dsh-mc-card-action{flex:none;}',
  '.dsh-mc-add{height:28px;padding:0 12px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}',
  '.dsh-mc-add:hover{border-color:var(--dsw-alias-state-business-primary,#3d6be5);color:var(--dsw-alias-state-business-primary,#3d6be5);}',
  '.dsh-mc-installed{height:28px;padding:0 12px;border-radius:14px;border:1px solid transparent;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.1));color:var(--dsw-alias-label-tertiary,#8a8a8a);font:inherit;font-size:12px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;}',
  '.dsh-mc-empty{padding:48px 16px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:13px;}',
  '.dsh-mc-notice{margin:0 0 12px;padding:9px 12px;border-radius:10px;font-size:12.5px;line-height:19px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,#5c5c5c);}',
  '.dsh-mc-error{color:var(--dsw-alias-state-error-primary,#d14343);}',
  '.dsh-mc-mask{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;padding:24px;animation:dsh-mc-fade .16s ease;}',
  '.dsh-mc-drawer{width:min(520px,100%);max-height:min(620px,86vh);display:flex;flex-direction:column;border-radius:16px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));box-shadow:0 18px 50px rgba(0,0,0,.24);overflow:hidden;animation:dsh-mc-pop .18s cubic-bezier(.2,.9,.3,1);}',
  '.dsh-mc-drawer-head{flex:none;display:flex;align-items:center;gap:12px;padding:16px 16px 12px;}',
  '.dsh-mc-drawer-icon{flex:none;width:48px;height:48px;border-radius:12px;object-fit:contain;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.07));padding:4px;}',
  '.dsh-mc-drawer-titles{flex:1;min-width:0;}',
  '.dsh-mc-drawer-name{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);}',
  '.dsh-mc-drawer-author{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-top:2px;}',
  '.dsh-mc-close{flex:none;width:28px;height:28px;border-radius:8px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer;font-size:18px;line-height:1;}',
  '.dsh-mc-close:hover{background:var(--dsw-alias-bg-l2,rgba(127,127,127,.1));}',
  '.dsh-mc-drawer-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 16px 8px;display:flex;flex-direction:column;gap:12px;}',
  '.dsh-mc-desc{font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary,#4a4a4a);margin:0;}',
  '.dsh-mc-meta-row{display:flex;gap:8px;font-size:12px;line-height:18px;}',
  '.dsh-mc-meta-key{flex:none;width:64px;color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
  '.dsh-mc-meta-val{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#4a4a4a);word-break:break-all;}',
  '.dsh-mc-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.07));color:var(--dsw-alias-label-secondary,#4a4a4a);word-break:break-all;white-space:pre-wrap;}',
  '.dsh-mc-field-label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#4a4a4a);margin-bottom:5px;}',
  '.dsh-mc-field{display:flex;flex-direction:column;gap:0;}',
  '.dsh-mc-field-input{width:100%;height:34px;padding:0 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:12.5px;outline:none;}',
  '.dsh-mc-field-input:focus{border-color:var(--dsw-alias-state-business-primary,#3d6be5);}',
  '.dsh-mc-field-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-top:4px;}',
  '.dsh-mc-drawer-foot{flex:none;display:flex;gap:8px;align-items:center;padding:12px 16px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));}',
  '.dsh-mc-drawer-foot .dsh-mc-ghost{margin-left:auto;}',
  '.dsh-mc-primary{height:34px;padding:0 18px;border-radius:9px;border:none;background:var(--dsw-alias-state-business-primary,#3d6be5);color:#fff;font:inherit;font-size:13px;font-weight:500;cursor:pointer;}',
  '.dsh-mc-primary:disabled{opacity:.55;cursor:default;}',
  '.dsh-mc-danger{height:34px;padding:0 16px;border-radius:9px;border:1px solid var(--dsw-alias-state-error-primary,rgba(209,67,67,.45));background:transparent;color:var(--dsw-alias-state-error-primary,#d14343);font:inherit;font-size:13px;cursor:pointer;}',
  '.dsh-mc-danger:hover{background:rgba(209,67,67,.08);}',
  '.dsh-mc-danger:disabled{opacity:.55;cursor:default;}',
  '.dsh-mc-ghost{height:34px;padding:0 16px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);font:inherit;font-size:13px;cursor:pointer;}',
  '@media (max-width:760px){.dsh-mc{padding:16px 14px 0;}}',
  '@keyframes dsh-mc-fade{from{opacity:0}to{opacity:1}}',
  '@keyframes dsh-mc-pop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}',
].join('')

/** 注入样式（幂等：同一份文档只插一次）。 */
export function ensureConnectorsStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS_TEXT
  document.head.appendChild(el)
}
