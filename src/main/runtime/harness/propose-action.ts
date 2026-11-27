/**
 * `propose_action`：在回答下方渲染可点选的动作卡，用户点选即作为下一条消息回传。
 *
 * 对照 DSH 的 `propose_action`。工具本身无副作用：它只把动作清单回给渲染层（随工具入参
 * 落库），并给模型一段「已展示、等用户点选」的确认文本，避免模型自行继续执行或重复追问。
 *
 * 渲染侧的点击通过 `harness-propose-action` 窗口事件交给会话发送逻辑
 * （见 `useHarnessHandlers`），与手动发送走同一条路径（含生成中入队）。
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getProposeActionTexts } from '../../i18n/tool-results-propose'
import {
  MAX_ACTION_DESCRIPTION_CHARS,
  MAX_ACTION_LABEL_CHARS,
  MAX_ACTION_REPLY_CHARS,
  MAX_PROPOSED_ACTIONS,
  formatProposedActions,
  normalizeProposedActions
} from './propose-action-core'

/** 构造 propose_action 工具 */
export function buildProposeActionTool(): StructuredToolInterface {
  return tool(
    async ({ question, actions }) => {
      const texts = getProposeActionTexts()
      const normalized = normalizeProposedActions(actions)
      if (!normalized) {
        return texts.hint
      }
      void question
      return formatProposedActions(mainFormat, texts, normalized)
    },
    {
      name: 'propose_action',
      isConcurrencySafe: () => true,
      timeoutMs: 10_000,
      description:
        `Offer up to ${MAX_PROPOSED_ACTIONS} clickable actions under this reply instead of asking an open question. Each action becomes a button; when the user clicks one, its reply text is sent back as the next user message. Use short labels (max ${MAX_ACTION_LABEL_CHARS} chars), an optional one-line description, and an optional reply when the button text should not be the message.`,
      schema: z.object({
        question: z
          .string()
          .max(300)
          .optional()
          .describe('Optional short prompt shown above the buttons'),
        actions: z
          .array(
            z.object({
              label: z
                .string()
                .min(1)
                .max(MAX_ACTION_LABEL_CHARS)
                .describe('Button text; also the default message sent back'),
              description: z
                .string()
                .max(MAX_ACTION_DESCRIPTION_CHARS)
                .optional()
                .describe('Optional one-line explanation shown next to the button'),
              reply: z
                .string()
                .max(MAX_ACTION_REPLY_CHARS)
                .optional()
                .describe('Optional message sent back instead of the label')
            })
          )
          .min(1)
          .max(MAX_PROPOSED_ACTIONS)
          .describe('Actions the user can pick from')
      })
    }
  )
}
