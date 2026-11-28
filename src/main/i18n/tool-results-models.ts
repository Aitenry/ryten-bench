import { getMainLanguage } from './index'

/**
 * Texts for the `list_subagent_models` tool (model route list).
 *
 * Chinese is the source language and the English tree is checked with `typeof` for key parity.
 * Provider and model names are configuration data and are not translated.
 */
export const zhCNModelRoutesTexts = {
  header: '## 可用的模型路由（{{count}}）',
  empty: '当前没有已启用的模型供应商。请先在「设置 → 模型」里添加并启用一个。',
  item: '- {{spec}}（{{name}} · {{capabilities}}）{{defaultTag}}',
  capabilities: '能力',
  defaultTag: '[默认]',
  hint: '在 agent_create 或子代理配置里把 `model` 设为上面的 `provider:model` 即可指定路由；留空则继承主模型。',
  none: '能力未知',
  image: '图片输入',
  tools: '工具调用',
  reasoning: '推理',
  failed: '读取模型路由失败：{{message}}'
}

export const enUSModelRoutesTexts: typeof zhCNModelRoutesTexts = {
  header: '## Available model routes ({{count}})',
  empty: 'No provider is enabled. Add and enable one in Settings → Model first.',
  item: '- {{spec}} ({{name}} · {{capabilities}}){{defaultTag}}',
  capabilities: 'capabilities',
  defaultTag: '[default]',
  hint: 'Set `model` to one of the `provider:model` specs above in agent_create or a subagent configuration; leave it empty to inherit the main model.',
  none: 'capabilities unknown',
  image: 'image input',
  tools: 'tool calling',
  reasoning: 'reasoning',
  failed: 'Failed to read model routes: {{message}}'
}

/** Return the model route texts for the current UI language */
export function getModelRoutesTexts(): typeof zhCNModelRoutesTexts {
  return getMainLanguage() === 'en-US' ? enUSModelRoutesTexts : zhCNModelRoutesTexts
}
