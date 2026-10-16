// hudlite's own strings (its two rows and `/hud` replies) in the language
// claude-hud draws in: Traditional or Simplified Chinese, else English.
import { getCanonicalLanguage, interpolate } from './hud/i18n/index.js'

export type LiteLanguage = 'en' | 'zh-Hant' | 'zh-Hans'

const EN = {
  context: 'Context',
  cache: 'Cache',
  hit: 'hit {p}',
  validUntil: 'valid until {t}',
  expired: 'expired',
  rewrite: ', next message rewrites {n}',
  session: 'Session',
  input: 'in {n}',
  output: 'out {n}',
  estimate: "this machine's Claude Code, at API prices",
  counting: 'counting…',
  read: 'read {n}',
  write: 'write {n}',
  written: 'written {t}',
  lastResponse: 'last response',
  noResponse: 'no response yet',
  subagents: 'incl. subagents',
  note: ' ({s})',
  movedAbove: 'Moved above the prompt',
  movedBelow: 'Moved below the prompt',
  langSet: 'Language: {name}',
  langList: 'Language: {name}. /hud lang en | zh-TW | zh-CN | auto',
  langUnknown: 'Unknown language "{name}". /hud lang en | zh-TW | zh-CN | auto',
  description: 'hudlite: /hud shows or hides it (off, on); above, below move it; lang en|zh-TW|zh-CN|auto; detail opens the details pane',
}

type Key = keyof typeof EN

const TABLES: Record<LiteLanguage, Record<Key, string>> = {
  en: EN,
  'zh-Hant': {
    context: '上下文',
    cache: '快取',
    hit: '命中 {p}',
    validUntil: '{t} 前有效',
    expired: '已過期',
    rewrite: '，下則重寫 {n}',
    session: '本 session',
    input: '輸入 {n}',
    output: '輸出 {n}',
    estimate: '本機 Claude Code 估算，API 定價',
    counting: '統計中…',
    read: '讀 {n}',
    write: '寫 {n}',
    written: '{t} 寫入',
    lastResponse: '上一次回應',
    noResponse: '尚無回應',
    subagents: '含子代理',
    note: '（{s}）',
    movedAbove: '已移到輸入框上方',
    movedBelow: '已移到輸入框下方',
    langSet: '語言：{name}',
    langList: '語言：{name}。/hud lang en | zh-TW | zh-CN | auto',
    langUnknown: '不認得「{name}」。/hud lang en | zh-TW | zh-CN | auto',
    description: 'hudlite：/hud 顯示或隱藏（off、on）；above、below 放到輸入框上方或下方；lang en|zh-TW|zh-CN|auto 切換語言；detail 開啟詳細面板',
  },
  'zh-Hans': {
    context: '上下文',
    cache: '缓存',
    hit: '命中 {p}',
    validUntil: '{t} 前有效',
    expired: '已过期',
    rewrite: '，下条重写 {n}',
    session: '本 session',
    input: '输入 {n}',
    output: '输出 {n}',
    estimate: '本机 Claude Code 估算，API 定价',
    counting: '统计中…',
    read: '读 {n}',
    write: '写 {n}',
    written: '{t} 写入',
    lastResponse: '上一次响应',
    noResponse: '尚无响应',
    subagents: '含子代理',
    note: '（{s}）',
    movedAbove: '已移到输入框上方',
    movedBelow: '已移到输入框下方',
    langSet: '语言：{name}',
    langList: '语言：{name}。/hud lang en | zh-TW | zh-CN | auto',
    langUnknown: '不认识「{name}」。/hud lang en | zh-TW | zh-CN | auto',
    description: 'hudlite：/hud 显示或隐藏（off、on）；above、below 放到输入框上方或下方；lang en|zh-TW|zh-CN|auto 切换语言；detail 打开详情面板',
  },
}

export function liteLanguage(): LiteLanguage {
  const canon = getCanonicalLanguage()
  return canon === 'zh-Hant' || canon === 'zh-Hans' ? canon : 'en'
}

export function L(key: Key, params: Record<string, string | number> = {}): string {
  return interpolate(TABLES[liteLanguage()][key], params)
}

/** `/hud lang`'s argument: a language, `auto` (claude-hud's own setting), or null when unknown. */
export function parseLanguage(arg: string): LiteLanguage | 'auto' | null {
  const a = arg.toLowerCase()
  if (a === 'auto') return 'auto'
  if (a === 'en' || a === 'english') return 'en'
  if (['zh-tw', 'zh-hant', 'tw', 'zht', '繁中', '繁體'].includes(a)) return 'zh-Hant'
  if (['zh-cn', 'zh-hans', 'cn', 'zhs', '简中', '简体'].includes(a)) return 'zh-Hans'
  return null
}

export const LANGUAGE_NAMES: Record<LiteLanguage | 'auto', string> = {
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
  auto: 'auto (claude-hud)',
}
