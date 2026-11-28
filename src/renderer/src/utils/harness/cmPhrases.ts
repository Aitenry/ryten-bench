import { EditorState } from '@codemirror/state'

/**
 * Chinese and English copy for CodeMirror's built-in UI (search panel / merge view buttons /
 * accessibility announcements).
 *
 * All CodeMirror built-in UI text goes through the `EditorState.phrases` facet; without
 * overriding it the UI mixes languages (English Find/Replace in the panel while the surrounding
 * app UI is Chinese). Keys are taken from the `phrase()` calls in @codemirror/search and
 * @codemirror/merge, maintained in one place.
 */
type Phrases = Record<string, string>

const ZH: Phrases = {
  // Find / replace panel
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
  // Merge view (diff)
  Accept: '保留',
  Reject: '撤销',
  'Revert this chunk': '撤销这一处',
  '$ unchanged lines': '$ 行未改动',
  // Autocomplete
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

/** Pick the CodeMirror phrase extension for the UI language */
export function editorPhrases(language: string): ReturnType<typeof EditorState.phrases.of> {
  return EditorState.phrases.of(language.startsWith('zh') ? ZH : EN)
}
