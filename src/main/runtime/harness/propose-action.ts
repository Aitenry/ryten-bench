/**
 * `propose_action`: renders clickable action cards under the reply; clicking one sends it back as
 * the next user message.
 *
 * The tool itself has no side effects: it only returns the action list to the renderer (persisted
 * with the tool input) and gives the model a "already displayed, waiting for the user to click"
 * confirmation text, so the model neither continues on its own nor asks again.
 *
 * Renderer-side clicks are handed to the session send logic through the `harness-propose-action`
 * window event (see `useHarnessHandlers`) and take the same path as a manual send (including
 * queueing while generating).
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

/** Build the propose_action tool */
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
