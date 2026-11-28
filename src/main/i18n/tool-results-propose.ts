import { getMainLanguage } from './index'

/**
 * Texts for the `propose_action` tool.
 *
 * Chinese is the source language and the English tree is checked with `typeof` for key parity.
 * Action labels and descriptions come from the model (already generated in the user's language);
 * this module only provides the framing text for "shown / awaiting a pick".
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

/** Return the propose_action texts for the current UI language */
export function getProposeActionTexts(): typeof zhCNProposeActionTexts {
  return getMainLanguage() === 'en-US' ? enUSProposeActionTexts : zhCNProposeActionTexts
}
