import { getMainLanguage } from './index'

/**
 * 联网工具（web_fetch / web_search）的返回文案。
 *
 * 与其它 `tool-results-*` 模块同一约定：中文是源语言，英文树用
 * `typeof zhCNWebToolTexts` 约束（缺键/多键编译期报错），插值统一 `{{name}}`。
 * 抓取到的网页正文属于外部数据，不做翻译、原样返回；这里只负责工具自身的提示语。
 */
export const zhCNWebToolTexts = {
  fetch: {
    invalidUrl: '无效的 URL（只支持 http/https）: {{url}}',
    blockedPrivate: '出于安全考虑，拒绝访问本地/内网地址: {{host}}',
    requestFailed: '抓取失败: {{url}}\n{{message}}',
    httpStatus: '目标返回 HTTP {{status}}{{statusText}}: {{url}}',
    unsupportedType: '不支持的内容类型 {{type}}（支持 HTML / JSON / 纯文本）: {{url}}',
    tooLarge: '响应超过 {{limit}} 字节上限，已拒绝读取: {{url}}',
    truncated: '\n\n（内容超过 {{total}} 字符，已截断。可改用更具体的页面或让用户提供文件。）',
    header: 'URL: {{url}}\n标题: {{title}}\n\n{{content}}',
    headerNoTitle: 'URL: {{url}}\n\n{{content}}'
  },
  search: {
    queryFailed: '搜索「{{query}}」失败: {{message}}',
    noResults: '搜索「{{query}}」没有返回结果。',
    header: '## 搜索: {{query}}',
    resultLine: '{{index}}. {{title}}\n   {{url}}\n   {{snippet}}'
  }
}

export const enUSWebToolTexts: typeof zhCNWebToolTexts = {
  fetch: {
    invalidUrl: 'Invalid URL (only http/https are supported): {{url}}',
    blockedPrivate: 'Refused to access a local or private address for safety: {{host}}',
    requestFailed: 'Fetch failed: {{url}}\n{{message}}',
    httpStatus: 'The target returned HTTP {{status}}{{statusText}}: {{url}}',
    unsupportedType: 'Unsupported content type {{type}} (HTML / JSON / plain text only): {{url}}',
    tooLarge: 'The response exceeds the {{limit}} byte limit and was refused: {{url}}',
    truncated:
      '\n\n(Content exceeded {{total}} characters and was truncated. Use a more specific page or ask the user for the file.)',
    header: 'URL: {{url}}\nTitle: {{title}}\n\n{{content}}',
    headerNoTitle: 'URL: {{url}}\n\n{{content}}'
  },
  search: {
    queryFailed: 'Search for "{{query}}" failed: {{message}}',
    noResults: 'Search for "{{query}}" returned no results.',
    header: '## Search: {{query}}',
    resultLine: '{{index}}. {{title}}\n   {{url}}\n   {{snippet}}'
  }
}

/** 按当前界面语言取联网工具文案 */
export function getWebToolTexts(): typeof zhCNWebToolTexts {
  return getMainLanguage() === 'en-US' ? enUSWebToolTexts : zhCNWebToolTexts
}
