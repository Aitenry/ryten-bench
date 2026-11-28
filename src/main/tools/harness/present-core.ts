/**
 * Pure path validation for `present` (no electron / i18n dependencies, so it can be tested offline).
 *
 * Rules (deliverables must be **existing workspace files**):
 * - only workspace virtual paths (`/docs/a.pdf`) or workspace-relative paths (`docs/a.pdf`, with
 *   the leading `/` added automatically) are accepted;
 * - absolute disk paths are rejected (`C:\...` and `/home/...` would be treated as relative paths
 *   on Windows, hence the per-segment validation);
 * - `..` escaping the workspace is rejected;
 * - the file must exist and be a regular file.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export type PresentPathFailure =
  | { code: 'empty' }
  | { code: 'no-workspace' }
  | { code: 'escape'; path: string }
  | { code: 'missing'; path: string }
  | { code: 'not-file'; path: string }

export type PresentPathResult =
  | { ok: true; virtualPath: string; realPath: string }
  | { ok: false; failure: PresentPathFailure }

/** Normalize a user/model supplied path into a workspace virtual path; on failure returns the reason */
export function normalizePresentPath(raw: string, workspaceRoot?: string): PresentPathResult {
  const input = (raw ?? '').trim()
  if (!input) return { ok: false, failure: { code: 'empty' } }

  // Unify separators; reject any absolute disk path (including a drive letter)
  const unified = input.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(unified)) {
    return { ok: false, failure: { code: 'escape', path: input } }
  }

  const withoutLeading = unified.replace(/^\/+/, '')
  const segments = withoutLeading
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return { ok: false, failure: { code: 'empty' } }
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, failure: { code: 'escape', path: input } }
  }

  const virtualPath = `/${segments.join('/')}`
  if (!workspaceRoot) return { ok: false, failure: { code: 'no-workspace' } }

  const realPath = path.join(workspaceRoot, ...segments)
  const relative = path.relative(workspaceRoot, realPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, failure: { code: 'escape', path: input } }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(realPath)
  } catch {
    return { ok: false, failure: { code: 'missing', path: virtualPath } }
  }
  if (!stat.isFile()) return { ok: false, failure: { code: 'not-file', path: virtualPath } }
  return { ok: true, virtualPath, realPath }
}
