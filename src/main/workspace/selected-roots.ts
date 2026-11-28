/**
 * Registry of directories "personally selected by the user through a system dialog".
 *
 * Background (security audit S03): the renderer can point `harness.workspacePath` at any
 * directory, and the file IPC handlers use that value as the workspace root for
 * `assertInsideWorkspace` — thus allowing arbitrary files to be read/written beyond the
 * intended scope. Checking only "the path is in the database" is not enough: `workspace-create`
 * itself also accepts an arbitrary path passed from the renderer.
 *
 * So the trust sources for workspace directories are narrowed to two:
 * 1. directories the user **picked in person** in the system directory chooser
 *    (`dialog.showOpenDialog`), recorded by this module;
 * 2. workspace rows already stored in the `workspace` table (written by the main process; the
 *    renderer can only reference their id/path).
 *
 * This is an in-memory allowlist: a restart requires picking the directory again — acceptable,
 * because creating a workspace has to show the dialog first anyway; existing user workspaces go
 * through source 2 and are unaffected.
 */
import { basename, dirname, join, resolve, sep } from 'path'
import * as fs from 'fs'

/** Maximum number of remembered directories (prevents the renderer from growing memory by repeated dialog opens; the dialog itself needs user action, so the cap is rarely reached) */
const MAX_REMEMBERED_ROOTS = 64

const selectedRoots = new Set<string>()

/** Path comparison key: strips trailing separators and is case-insensitive on Windows */
export function workspacePathKey(input: string): string {
  const normalized = resolve(input).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Record a directory the user picked in person (evicting the oldest by LRU cap) */
export function rememberSelectedRoot(dir: string): void {
  if (typeof dir !== 'string' || !dir.trim()) return
  const key = workspacePathKey(dir)
  selectedRoots.delete(key)
  selectedRoots.add(key)
  while (selectedRoots.size > MAX_REMEMBERED_ROOTS) {
    const oldest = selectedRoots.values().next().value
    if (oldest === undefined) break
    selectedRoots.delete(oldest)
  }
}

/** Whether the directory was picked by the user in person through a system dialog */
export function isUserSelectedRoot(dir: string): boolean {
  if (typeof dir !== 'string' || !dir.trim()) return false
  return selectedRoots.has(workspacePathKey(dir))
}

/**
 * Whether the target path falls inside the given root directory (string level; the caller adds
 * the symlink realpath check). Extracted because the IPC layer and the file tool layer both need
 * the same boundary semantics, avoiding two drifting copies of `isPathInside`.
 */
export function isPathInsideRoot(target: string, root: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  const key = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const r = key(normalizedRoot)
  const t = key(normalizedTarget)
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Resolve the real path; when the target does not exist (new file/directory), walk up to the
 * nearest existing ancestor and append the missing tail back.
 *
 * Why this is needed (security audit S06): a string-level `path.relative` check cannot stop
 * symlinks — if the workspace contains a symlink/junction pointing outside the root, writes
 * follow the link and land outside. realpath resolves links first and the boundary comparison
 * happens afterwards; "the target does not exist yet" is the normal case when writing files, so
 * the missing tail must be handled.
 */
export function realpathWithMissingTail(input: string): string {
  let current = resolve(input)
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(current)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(input)
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * Real-path level boundary check: realpath first, then compare, so symlinks cannot escape the
 * root directory. For nonexistent paths the result of `realpathWithMissingTail` is compared
 * (still blocking parent-directory links).
 */
export function isReallyInsideRoot(target: string, root: string): boolean {
  return isPathInsideRoot(realpathWithMissingTail(target), realpathWithMissingTail(root))
}
