/**
 * Oldest-file pruning inside a directory (async, best-effort, no third-party dependencies).
 *
 * Why it lives on its own: the tool-detail directory and the spill directory both enforce a file
 * count cap by pruning after writing. The original implementation used `readdirSync` plus a
 * `statSync` and `unlinkSync` per file, which blocked the main-process event loop under heavy tool
 * use (performance audit P19). This is one shared async implementation, also easy to assert
 * offline (it returns the deleted files; serial merge relies on the caller's own flag).
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Dirent } from 'node:fs'

export interface PruneOldestOptions {
  /** Only process files that match (e.g. extension or file-name prefix) */
  match: (fileName: string) => boolean
  /** How many of the newest files to keep */
  keep: number
}

/**
 * Delete the oldest files in ascending mtime order until at most `keep` matching files remain.
 *
 * @returns Paths of the files actually deleted (failures are skipped and never thrown)
 */
export async function pruneOldestFiles(
  dir: string,
  options: PruneOldestOptions
): Promise<string[]> {
  if (options.keep < 0) return []
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    // Directory missing (nothing written yet) or unreadable: nothing to prune
    return []
  }
  const files: Array<{ full: string; mtime: number }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !options.match(entry.name)) continue
    const full = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(full)
      files.push({ full, mtime: stat.mtimeMs })
    } catch {
      // Already deleted concurrently or no permission: skip
    }
  }
  files.sort((a, b) => a.mtime - b.mtime)
  const removed: string[] = []
  for (let i = 0; i < files.length - options.keep; i += 1) {
    try {
      await fs.unlink(files[i].full)
      removed.push(files[i].full)
    } catch {
      // A failed delete must not block writes
    }
  }
  return removed
}
