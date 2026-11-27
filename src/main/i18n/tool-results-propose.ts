import { getMainLanguage } from './index'

/**
 * `propose_action` 工具文案。
 *
 * 中文是源语言，英文树用 `typeof` 约束键一致。动作 label/description 来自模型（已按用户语言
 * 生成），这里只负责「已展示 / 等点选」的框架文案。
 */
export const zhCNProposeActionTexts = {
  shown: '已在回答下方展示 {{count}} 个可选动作：',
  item: '- {{label}} {{description}}',
  hint: '等待用户点选。用户点选后，该动作会作为下一条用户消息发给你；不要重复追问或自行继续执行这些动作。'
}

export const enUSProposeActionTexts: typeof zhCNProposeActionTexts = {
  shown: 'Shown {{count}} selectable action(s) under the reply:',
  item: '- {{label}} {{description}}',
  hint: 'Waiting for the user to pick one. The picked action arrives as the next user message; do not repeat the question or execute the actions yourself.'
}

/** 按当前界面语言取 propose_action 文案 */
export function getProposeActionTexts(): typeof zhCNProposeActionTexts {
  return getMainLanguage() === 'en-US' ? enUSProposeActionTexts : zhCNProposeActionTexts
}
