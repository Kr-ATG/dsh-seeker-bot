/**
 * settings 接缝注册接线：两代面分派 + 旧面三分支 + 新面 volatile 热更挂接。
 *
 * dshSettings 经参数注入（deps.dshSettings），模块本体不 import 私有 peer
 * '@deepseek-ai/dsh-settings'——单测（tests/unit/settings-bridge.test.js）得以在
 * CI 直测三条旧面注册路径收到的 entry 是否为解过 volatile ref 的普通值
 * （c3cc8a7：schemastery ≥3.18.3 下带 ref 的 entry 会让旧 provider 的 schema
 * 校验入口即抛，namespace 永不注册、设置卡片读写全废；该路径此前只有
 * 依赖本机 dsh 的 verify-host 与 M5 实弹能覆盖）。index.ts 保留 dshSettings
 * 裸导入并注入进来，生产路径不变。
 * ↳ 接缝适配 ①（移植进 dsh-seeker-bot 后）：那一行裸导入已删除，改由 index.ts
 *   传一个空模块桩（原因见 index.ts 接缝适配 ① 的注释）。本文件的逻辑、分支
 *   与函数签名一字未改——它收到的仍然是一个「模块面对象」，只是桩上没有
 *   installSettingsSection（旧面独立函数路径因此跳过，属预期降级）。
 *
 * 两代接缝分派：
 * - 新面（0.1.7+）：ctx.settings 变成 SettingsForms，整个 SettingsProvider 被
 *   移除——installSection/register 双双缺席，三分支旧接线会静默 no-op（无异常、
 *   无日志，namespace 永不注册、配置卡片读不到覆盖字段、保存必失败）。新面
 *   下配置所有权在 profile：按 settings ns（= profile entry id）经
 *   describe/update/replace 读写，可写字段必须有 schema .volatile() 声明，热更
 *   经 loader 提交 volatile 值后派发的 loader/volatile-update（值已先行提交）。
 * - 旧面（≤0.1.6）：三分支原样保留——installSettingsSection 独立函数
 *   （0.1.1-rc.2 及以前）→ SettingsProvider.installSection（0.1.2-alpha.2 起）
 *   → register 核心 API（手动复刻独立函数接线语义：注册 namespace、源指向
 *   scope、卸载回退入口 config、watch 热更新）。
 * - 分流判据必须含「旧注册入口缺席」：describe/update 旧面同样有
 *   （routes-manage 一直用它们读写已注册的 namespace），只看读写方法会把
 *   0.1.6 误判成新面——namespace 不注册即用户配置卡片失联，违反「未升级用户
 *   不变砖」。分支判断也不能只看静态导入包（插件 node_modules 固定为最新版
 *   dsh-settings，旧版 DSH 运行时会注入旧版实例），故按运行时注入实例的实际
 *   API 分派。
 */

import { Config, LEGACY_SETTINGS_NS, isLegacySettingsFace, resolveSettingsNs, unwrapConfig } from './config.js'
import type { HostContext, SettingsService, SettingsSectionHooks } from '../types/dsh-contract.js'
import type { ResolvedConfig } from '../types/config.js'

// dshSettings 模块面：仅 installSettingsSection 独立函数辅助（0.1.1-rc.2 及
// 以前；0.1.2-alpha.2 起被官方移除）。类型走 ambient 声明
// （types/ambient-modules.d.ts），不要求本机安装该包。
//
// 接缝适配 ①（移植进 dsh-seeker-bot）：由 `type` 改为 `export type`。
// 为什么：index.ts 不能再裸 import '@deepseek-ai/dsh-settings'（会留在 host 产物
// 里，撞 build.mjs 的 assertHostExternals），改成传空模块桩后需要这个类型名来
// 标注桩。`typeof import(...)` 是**纯类型位置**，esbuild 打包时整体剥离，不会在
// 产物里生成任何 import——类型面照旧由 ambient 声明兜底。
export type DshSettingsModule = typeof import('@deepseek-ai/dsh-settings')

export interface SettingsBridgeDeps {
  ctx: HostContext
  dshSettings: DshSettingsModule
  config: ResolvedConfig
  settingsHooks: SettingsSectionHooks<unknown>
  applyResolvedConfig: (resolved: unknown) => void
  recordError: (message: string) => void
}

// 新面探针：返回可用的 ns，null = 未命中新面（交回旧三分支）。ns 解析见
// config.resolveSettingsNs（apply 期 describe 看不到自身，回退首候选）。
function newSettingsNs(ctx: HostContext, settings: SettingsService | null | undefined): string | null {
  if (!settings) return null
  if (isLegacySettingsFace(settings)) return null
  if (typeof settings.describe !== 'function' || typeof settings.update !== 'function') return null
  try {
    return resolveSettingsNs(ctx, settings)
  } catch (error) {
    // 解析抛错按未命中新面：交回旧三分支注册路径兜底
    return null
  }
}

export function installSettingsNamespace(deps: SettingsBridgeDeps): void {
  const { ctx, dshSettings, config, settingsHooks, applyResolvedConfig, recordError } = deps
  try {
    // 旧面注册的 entry 必须先解 volatile ref：schemastery ≥3.18.3 的 .volatile()
    // 是「标记即生效」——插件 node_modules 一旦解析到带 volatile 的 schemastery，
    // 入口 config 就会被 loader 解析成 Volatile ref（与 settings 面无关，0.1.6 的
    // 旧 provider 拿到的是同一批 ref）。旧 provider 的 installSection/register 会
    // 用 schema 校验 entry，ref 不是合法值直接 ValidationError → namespace 永不
    // 注册、设置卡片读写全废（M5-5 降级回归实锤：报 is not registered）。
    // unwrapConfig 对普通值恒等（旧 schemastery 树无感），对新面 ref 解一层。
    const legacyEntry = unwrapConfig(config)
    if (typeof dshSettings.installSettingsSection === 'function') {
      // 包解析到旧版 dsh-settings：独立函数辅助
      dshSettings.installSettingsSection(ctx, LEGACY_SETTINGS_NS, Config, legacyEntry, settingsHooks)
    } else if (typeof ctx.inject === 'function') {
      ctx.inject(['settings'], (settingsCtx) => {
        const settingsService = settingsCtx.settings
        if (newSettingsNs(ctx, settingsService)) {
          // 新面：没有 namespace 可注册（配置所有权在 profile），改挂 volatile
          // 热更——loader 把新值提交进运行中 fiber 的 ref 后派发本事件，此刻直接
          // 重读 config 即拿到新值（读的是同一批 ref，与 fiber.config 同对象）。
          // ns 不缓存在这里：端点每次调用都重新解析（routes-manage），apply 期的
          // 回退候选与端点期 describe 的交集结论可能不同。
          ctx.on('loader/volatile-update', () => applyResolvedConfig(config))
        } else if (typeof settingsService.installSection === 'function') {
          // 0.1.2-alpha.2 起：settings 服务方法（inject 声明后取实例，方法
          // 与独立函数同签名——register 语义/组合 base/卸载回退/onChange
          // 触发全一致）
          settingsService.installSection(ctx, LEGACY_SETTINGS_NS, Config, legacyEntry, settingsHooks)
        } else if (typeof settingsService.register === 'function') {
          // 0.1.1-rc.2 及以前：仅 register 核心 API，复刻独立函数接线语义
          const scope = settingsService.register(LEGACY_SETTINGS_NS, Config, { base: legacyEntry })
          settingsHooks.setSource(() => scope.get())
          settingsHooks.onChange()
          scope.watch(() => settingsHooks.onChange())
          settingsCtx.effect(() => () => {
            settingsHooks.setSource(() => legacyEntry)
            settingsHooks.onChange()
          })
        }
      })
    }
  } catch (error) {
    // 注册失败已告警；设置面降级不可用，快照/撤回主链不受影响
    recordError('recall settings namespace skipped: ' + String(error))
  }
}
