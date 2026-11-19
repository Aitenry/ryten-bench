import { EditorState } from '@codemirror/state'

/**
 * CodeMirror 内置界面（查找面板 / 合并视图按钮 / 无障碍朗读）的中英文案。
 *
 * CodeMirror 的所有内置 UI 文案都走 EditorState.phrases 这个 Facet，
 * 不覆盖的话界面上会出现中英混排（面板里是英文 Find/Replace，旁边的应用界面是中文）。
 * 键名取自 @codemirror/search 与 @codemirror/merge 的 phrase() 调用，一处集中维护。
 */
type Phrases = Record<string, string>

const ZH: Phrases = {
  // 查找 / 替换面板
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全选匹配',
  'match case': '区分大小写',
  regexp: '正则表达式',
  'by word': '全词匹配',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'on line': '位于第',
  'Go to line': '跳转到行',
  go: '跳转',
  'replaced $ matches': '已替换 $ 处',
  'replaced match on line $': '已替换第 $ 行的匹配',
  // 合并视图（差异）
  Accept: '保留',
  Reject: '撤销',
  'Revert this chunk': '撤销这一处',
  '$ unchanged lines': '$ 行未改动',
  // 自动补全
  Completions: '补全',
  Diagnostics: '诊断'
}

const EN: Phrases = {
  Find: 'Find',
  Replace: 'Replace',
  next: 'next',
  previous: 'previous',
  all: 'all',
  'match case': 'match case',
  regexp: 'regexp',
  'by word': 'by word',
  replace: 'replace',
  'replace all': 'replace all',
  close: 'close',
  'current match': 'current match',
  'on line': 'on line',
  'Go to line': 'Go to line',
  go: 'go',
  'replaced $ matches': 'replaced $ matches',
  'replaced match on line $': 'replaced match on line $',
  Accept: 'Keep',
  Reject: 'Revert',
  'Revert this chunk': 'Revert this chunk',
  '$ unchanged lines': '$ unchanged lines',
  Completions: 'Completions',
  Diagnostics: 'Diagnostics'
}

/** 按界面语言取 CodeMirror 文案扩展 */
export function editorPhrases(language: string): ReturnType<typeof EditorState.phrases.of> {
  return EditorState.phrases.of(language.startsWith('zh') ? ZH : EN)
}
