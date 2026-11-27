import { getMainLanguage } from './index'

/**
 * `list_subagent_models` 工具文案（模型路由清单）。
 *
 * 中文是源语言，英文树用 `typeof` 约束键一致。供应商名/模型名属于配置数据，不翻译。
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

/** 按当前界面语言取模型路由文案 */
export function getModelRoutesTexts(): typeof zhCNModelRoutesTexts {
  return getMainLanguage() === 'en-US' ? enUSModelRoutesTexts : zhCNModelRoutesTexts
}
