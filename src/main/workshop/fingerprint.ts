import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { draftDir } from './paths'

/**
 * Draft source fingerprint: the **single source of truth** for whether a build output or
 * verification report belongs to the current source.
 *
 * Why mtime cannot be used (root cause of the 2026-11-23 user incident): after `buildDraft`
 * writes the output into `dist/<id>/`, `patchDraftMeta` also writes `workshop.json` back into
 * the draft (`builtAt` / `updatedAt`). That file is always newer than
 * `dist/<id>/plugin.json`, so the old rule "newest mtime in the draft > output mtime = stale"
 * held **immediately after every build**: `plugin_publish install` reported forever that the
 * output was older than the source, the model could only retry repeatedly, and it eventually
 * got stopped by the loop guard, leaving the user to copy the output into the plugin
 * directory by hand (which is not the production flow).
 *
 * A content fingerprint has no such ordering problem: the fingerprint changes only when the
 * **content of files involved in building/verification** actually changes. Therefore
 * `workshop.json` (the workshop's own timestamps/display name) does not participate in the
 * fingerprint; its `css` mode does affect the output, so it is prepended to the fingerprint
 * separately.
 *
 * The included set deliberately covers only extensions that "can affect the output or the
 * verification result": editing pure documentation such as `WORKSHOP.md` should not make the
 * plugin "need a rebuild".
 */

/** File extensions included in the fingerprint (build inputs + smoke tests) */
const SOURCE_EXT: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.svg'
])

/** Directories excluded from the build (output, dependencies, VCS, editor caches, workshop backups) */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.cache',
  'backups'
])

/** Collect the files in the draft that participate in the build (posix relative paths, stable order) */
function buildInputs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // Skip anything starting with a dot: .git/.vscode/.DS_Store are not plugin source
      // (.vscode/settings.json has a .json extension; without this skip, touching an editor
      // config would mark the output as stale)
      if (entry.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full, rel)
        continue
      }
      if (!entry.isFile()) continue
      // Workshop metadata is maintained by the workshop itself (written after every build); it is not a build input
      if (rel === 'workshop.json') continue
      if (!SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) continue
      out.push(rel)
    }
  }
  walk(root, '')
  return out.sort((a, b) => a.localeCompare(b, 'en'))
}

/**
 * Compute the draft source fingerprint (`sha256`, stable, cross-platform, independent of mtime).
 *
 * The prefix carries the algorithm version and the css mode: changing `css` in
 * `workshop.json` from `auto` to `file` also changes the output, so the fingerprint must
 * follow; bump `v1` when the metadata structure or the included file set changes later.
 *
 * A file read failure throws: callers (build/verify/publish gate) must either treat it as a
 * fatal error or handle it themselves — never silently return a fingerprint that "looks the same".
 */
export function draftSourceHash(id: string, cssMode: string): string {
  const root = draftDir(id)
  const hash = createHash('sha256')
  hash.update(`rb-workshop-source-v1\ncss=${cssMode}\n`)
  for (const rel of buildInputs(root)) {
    const content = fs.readFileSync(path.join(root, ...rel.split('/')))
    hash.update(rel)
    hash.update('\0')
    hash.update(String(content.byteLength))
    hash.update('\0')
    hash.update(content)
    hash.update('\n')
  }
  return hash.digest('hex')
}
