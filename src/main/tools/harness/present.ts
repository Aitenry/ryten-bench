/**
 * `present` 工具：把已存在的工作区文件声明为「本轮交付物」。
 *
 * 对照 DSH 的 `@deepseek-ai/dsh-tool-present`：模型用它告诉用户「这些就是最终产物」，
 * 界面据此在回复下方展示可点击的文件卡。这里不做文件复制、也不改文件，只做
 * 「存在性 + 工作区边界」校验后回一段确认文本；交付列表本身作为工具入参随对话落库，
 * 历史重载后卡片仍能还原。
 */
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '../../ai/tools'
import { mainFormat } from '../../i18n'
import { getPresentToolTexts } from '../../i18n/tool-results-present'
import { normalizePresentPath } from './present-core'

/** 一次最多声明的交付文件数（与 DSH 一致：通常 1～2 个，上限 4 个） */
export const MAX_PRESENT_FILES = 4

/** 工具运行配置里只关心工作区根（由 Runtime 注入 configurable.workspaceRoot） */
interface PresentInvokeConfig {
  configurable?: { workspaceRoot?: unknown }
}

/** 构造 present 工具 */
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
