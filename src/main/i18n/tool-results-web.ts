import { getMainLanguage } from './index'

/**
 * Result texts for the web tools (web_fetch / web_search).
 *
 * Same convention as the other `tool-results-*` modules: Chinese is the source language and the
 * English tree is constrained by `typeof zhCNWebToolTexts` (missing/extra keys are compile
 * errors); interpolation is uniformly `{{name}}`. Fetched page bodies are external data, returned
 * verbatim and never translated; only the tools' own messages live here.
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
    resultLine: '{{index}}. {{title}}\n   {{url}}\n   {{snippet}}',
    contentLine: '正文摘要: {{content}}',
    fallbackLine: '（{{provider}} 暂不可用，已回退到内置搜索）',
    providerLabels: {
      builtin: '内置搜索',
      deepseek: 'DeepSeek 搜索',
      tavily: 'Tavily 搜索'
    },
    errorLabels: {
      'not-configured': '搜索服务尚未配置',
      unauthorized: '密钥无效或已过期',
      'rate-limited': '搜索服务限流，请稍后重试',
      timeout: '搜索服务超时',
      network: '网络错误，无法连接搜索服务',
      'provider-error': '搜索服务返回错误',
      'invalid-response': '搜索服务返回了无法解析的内容',
      'invalid-query': '搜索词无效'
    }
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
    resultLine: '{{index}}. {{title}}\n   {{url}}\n   {{snippet}}',
    contentLine: 'Content excerpt: {{content}}',
    fallbackLine: '({{provider}} is unavailable; fell back to the built-in search)',
    providerLabels: {
      builtin: 'Built-in search',
      deepseek: 'DeepSeek search',
      tavily: 'Tavily search'
    },
    errorLabels: {
      'not-configured': 'The search service is not configured',
      unauthorized: 'The API key is invalid or expired',
      'rate-limited': 'The search service is rate limited, please retry later',
      timeout: 'The search service timed out',
      network: 'Network error: cannot reach the search service',
      'provider-error': 'The search service returned an error',
      'invalid-response': 'The search service returned unreadable content',
      'invalid-query': 'Invalid search query'
    }
  }
}

/** Return the web tool texts for the current UI language */
export function getWebToolTexts(): typeof zhCNWebToolTexts {
  return getMainLanguage() === 'en-US' ? enUSWebToolTexts : zhCNWebToolTexts
}
