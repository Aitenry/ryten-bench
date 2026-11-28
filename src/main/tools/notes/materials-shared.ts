/**
 * Small helpers shared by the materials-organization tools (`materials_docs_search` / `_read` /
 * `_write` / `_edit`, `materials_todos_search` / `_read` / `_write` / `_edit`, and
 * `materials_wikis` / `materials_graph`).
 *
 * The tools are split by domain (2026-11-28, user feedback: a single 36-command entry made both
 * the model and the user guess which command belonged to which task, and every parameter was
 * flattened into one schema). The result texts stay in `i18n/tool-results-*`; only the
 * argument-guard copy is shared here.
 */
import { mainFormat } from '../../i18n'
import { getDocsToolTexts } from '../../i18n/tool-results-docs'

/**
 * First missing required parameter → localized "missing param" text; `null` when all are present.
 *
 * `undefined` / `null` / a blank string count as missing, mirroring the previous unified tool.
 * Note: commands where an empty string is meaningful (e.g. `doc.replace_lines` with `newText: ""`
 * to delete lines) simply do not list that parameter here.
 */
export function missingParamText(params: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = params[name]
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      return mainFormat(getDocsToolTexts().docs.missingParam, { param: name })
    }
  }
  return null
}
