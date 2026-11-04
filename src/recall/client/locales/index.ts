/**
 * dsh-recall-plugin — client i18n 词典层（A4）
 *
 * 两层分工：本文件是纯逻辑（locale 解析 / 插值 / 查表），零模块级可变状态；
 * 「当前用哪种语言」这份状态归 buildUtil() 工厂持有（locale 偏好是 apply 级
 * 会话状态，与 HMR 假设一致——重载后由下一次 init / config-get 重新解析）。
 * 需要渲染文案的模块统一经 util.t 取词，不直接 import 词典。
 *
 * 兜底链（对齐同类插件的「不显语义 ID」原则）：当前语言缺 key → zh 原文 →
 * key 本身。parity 单测已钉两语言 key 集合相等，前两级只兜开发期失误；最后
 * 一级让漏配在界面上直接可见（显示成语义 ID），而不是静默变空白。
 */

import { zh } from './zh.js'
import { en } from './en.js'

export type Locale = 'zh' | 'en'
export type DictParams = Record<string, string | number>
export type Translate = (key: string, params?: DictParams) => string

const DICTS: Record<Locale, Record<string, string>> = { zh, en }

// locale 偏好解析：显式 zh/en 直取；'auto' 与一切非法值按 navigator.language
// 判——zh 开头用中文，其余用英文（默认 auto 要给非中文用户英文界面）；无
// navigator 的环境（node 单测）回落 zh，与替换前的单语文案行为等价。
// navigator 访问整体 try/catch：嵌入式 webview 上偶有抛错的宿主实现。
export function resolveLocale(pref: unknown): Locale {
  if (pref === 'zh' || pref === 'en') return pref
  try {
    const nav = typeof navigator === 'undefined' ? null : navigator
    const lang = nav && typeof nav.language === 'string' ? nav.language : ''
    if (!lang) return 'zh'
    return lang.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
  } catch (error) {
    // 宿主 navigator 异常按中文兜底（见上）
    return 'zh'
  }
}

// 插值：只替换字典显式声明的 {name} 槽位；缺参保留原样——渲染成 "{n}" 比
// 渲染成 "undefined" 更容易被认出是调用点漏传，且不会把 undefined 写进界面
export function interpolate(template: string, params?: DictParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (raw, name: string) => {
    const value = params[name]
    return value === undefined ? raw : String(value)
  })
}

// 查表 + 兜底链（见文件头）。纯函数，locale 由调用方给定
export function translate(locale: Locale, key: string, params?: DictParams): string {
  const dict = DICTS[locale]
  const hit = dict[key] !== undefined ? dict[key] : zh[key]
  return interpolate(hit !== undefined ? hit : key, params)
}

// zh 词表直取：模块级纯函数（summaryText / buildTree 等）与单测的缺省词表——
// 不传 t 时按 zh 渲染，等价于替换前的单语文案，也让纯函数不依赖 util 实例
export const zhTranslate: Translate = (key, params) => translate('zh', key, params)

// key 是否在表内（查 zh 即可：parity 单测保证两语言 key 集合相等）。供
// 「字典命中才用本地文案、否则回落 host message」的错误码分流使用
export function hasTranslation(key: string): boolean {
  return zh[key] !== undefined
}