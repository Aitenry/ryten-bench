/**
 * `present` tool: declares existing workspace files as the "deliverables of this turn".
 *
 * The model uses it to tell the user "these are the final artifacts", and the UI then shows
 * clickable file cards under the reply. Nothing is copied or modified here — only an existence
 * plus workspace-boundary check is performed, followed by a confirmation text; the deliverable
 * list itself is persisted as tool input with the conversation, so cards can be restored after
 * the history is reloaded.
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getPresentToolTexts } from '../../i18n/tool-results-present'
import { normalizePresentPath } from './present-core'

/** Maximum number of files declared at once (usually 1-2, hard limit 4) */
export const MAX_PRESENT_FILES = 4

/** Only the workspace root matters from the tool invoke config (injected by Runtime as configurable.workspaceRoot) */
interface PresentInvokeConfig {
  configurable?: { workspaceRoot?: unknown }
}

/** Build the present tool */
export function buildPresentTool(): StructuredToolInterface {
  return tool(
    async ({ files }, config) => {
      const texts = getPresentToolTexts()
      const list = Array.isArray(files) ? files : []
      if (list.length === 0) return texts.empty
      if (list.length > MAX_PRESENT_FILES) {
        return mainFormat(texts.tooMany, { max: MAX_PRESENT_FILES, count: list.length })
      }

      const cfg = config as PresentInvokeConfig | undefined
      const workspaceRoot =
        typeof cfg?.configurable?.workspaceRoot === 'string'
          ? cfg.configurable.workspaceRoot
          : undefined

      const lines: string[] = []
      for (const file of list) {
        const resolved = normalizePresentPath(file?.path ?? '', workspaceRoot)
        if (!resolved.ok) {
          const failure = resolved.failure
          const message =
            failure.code === 'empty'
              ? texts.empty
              : failure.code === 'no-workspace'
                ? texts.noWorkspace
                : failure.code === 'missing'
                  ? mainFormat(texts.missing, { path: failure.path })
                  : failure.code === 'not-file'
                    ? mainFormat(texts.notFile, { path: failure.path })
                    : mainFormat(texts.escape, { path: failure.path })
          return `${message}\n${texts.hint}`
        }
        const description = file.description?.trim()
        lines.push(
          mainFormat(texts.item, {
            path: resolved.virtualPath,
            description: description ? ` — ${description}` : ''
          })
        )
      }

      return mainFormat(texts.presented, {
        count: list.length,
        list: lines.join('\n')
      })
    },
    {
      name: 'present',
      isConcurrencySafe: () => true,
      description:
        'Declare existing workspace files as the final deliverables of this turn, so the UI shows clickable file cards under your reply. Pass 1-4 files, each with a workspace virtual path (e.g. /docs/report.md) and an optional one-line description; usually the 1-2 most important ones. The files must already exist inside the workspace — present does not create or copy anything, and the user only sees the cards after your turn ends.',
      schema: z.object({
        files: z
          .array(
            z.object({
              path: z.string().describe('Workspace virtual path of an existing file, e.g. /docs/a.md'),
              description: z
                .string()
                .optional()
                .describe('One short line telling the user what this file is')
            })
          )
          .min(1)
          .describe('Deliverable files, usually 1-2 and at most 4')
      })
    }
  )
}
