/**
 * **Routing decision** for `plugin://` requests (pure function, zero imports: loadable directly by
 * Node for offline regression).
 *
 * Why it was extracted from `src/main/plugins/protocol.ts`: this file only describes "which URL
 * gets which status code" - the security boundary (path traversal), enabled state, host reserved
 * id, missing optional resources all live in these branches, and previously it could only be
 * verified by booting the whole Electron app. As a dependency-free pure function,
 * `test/verify-plugin-protocol-404.mjs` runs the real code directly with
 * `node --experimental-strip-types` (the protocol handler only keeps "fetch the file per the
 * decision").
 */

/** Parse result: hand it to the handler to read the file */
export interface PluginFileDecision {
  kind: 'file'
  /** Plugin id (for logging) */
  id: string
  /** Resolved absolute path */
  abs: string
  /** Path relative to the plugin root (for logging) */
  relPath: string
}

/** Parse result: hand it to the host UI bridge to generate ESM (no disk read) */
export interface PluginBridgeDecision {
  kind: 'bridge'
  key: string
  /** Raw query (including the leading `?`) */
  search: string
}

/** Parse result: return a status code directly without reading the disk */
export interface PluginErrorDecision {
  kind: 'error'
  status: number
  /** Reason for in-process diagnostics (not put in the response body, to avoid leaking disk paths) */
  reason:
    | 'bad-url'
    | 'bad-bridge-path'
    | 'missing-key'
    | 'not-found'
    | 'disabled'
    | 'forbidden'
    | 'not-a-file'
}

export type PluginRequestDecision = PluginFileDecision | PluginBridgeDecision | PluginErrorDecision

/** Host capabilities the handler needs (injected so it can be tested offline) */
export interface PluginRequestDeps {
  /** Plugin root directory (null when not installed) */
  pluginDir: (id: string) => string | null
  /** Whether the plugin is enabled (a disabled plugin cannot access any file) */
  isEnabled: (id: string) => boolean
  /** Whether the directory / file exists (injected so offline tooling can run without a real filesystem) */
  exists: (abs: string) => boolean
}

const PLUGIN_ID_RE = /^[A-Za-z0-9._-]+$/

/**
 * Fixed path of the host UI bridge.
 *
 * It is the **same value** as `HOST_UI_BRIDGE_PATH` in `host-ui-bridge.ts`, deliberately
 * duplicated instead of imported: this module must have zero imports (see the file header).
 * Drift is caught by tooling - `test/verify-plugin-protocol-404.mjs` asserts that both constants
 * equal `ui.js`.
 */
export const PLUGIN_BRIDGE_PATH = 'ui.js'

/**
 * Normalize a path: unify separators, drop `.` segments and repeated separators.
 *
 * Why not `path.resolve` (which the previous handler used): this module deliberately has **zero
 * imports** so Node can load it for offline regression (see the file header). Normalization must
 * be done here, and it must be at the **string** level - `..` is collapsed too, so decoded
 * `%2e%2e%2f` cannot escape the plugin directory either.
 */
function normalizePath(input: string): string {
  const unified = input.replace(/\\/g, '/')
  const isAbsolute = unified.startsWith('/')
  const out: string[] = []
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(seg)
  }
  return (isAbsolute ? '/' : '') + out.join('/')
}

/** Join the plugin directory and a relative path (the result is normalized; `..` cannot escape) */
function joinPath(dir: string, rel: string): string {
  const base = dir.replace(/[/\\]+$/, '').replace(/\\/g, '/')
  const joined = rel ? `${base}/${rel}` : base
  return normalizePath(joined)
}

/** Whether `abs` falls inside `dir` (traversal guard; pure string comparison, no filesystem access) */
export function isInsideDir(dir: string, abs: string): boolean {
  const base = normalizePath(dir)
  // After normalization `..` is already collapsed, so only the "same prefix" check remains; the
  // root directory (`/`) passes directly
  if (base === '/' || base === '') return true
  return abs === base || abs.startsWith(`${base}/`)
}

/**
 * Resolve a `plugin://` request -> a decision.
 *
 * Branch order matters; changing it changes semantics:
 * 1. invalid URL -> 400;
 * 2. host reserved id `host` -> serve only the UI bridge path, and `?m=<key>` is required
 *    (otherwise 400);
 * 3. plugin not found -> 404; **4. disabled -> 403** (before the file check: disallow probing
 *    whether a file exists in a disabled plugin);
 * 5. path escapes the plugin directory after normalization -> 403 (note: `new URL` already
 *    collapses **unencoded** `..` first, so what really hits this guard is encoded traversal such
 *    as `%2e%2e%2f` - measured by tooling on 2026-09-26);
 * 6. **file not found -> 404** (absence is an expected state, not a 5xx; see the measured notes in
 *    protocol.ts);
 * 7. everything else -> hand to the handler to read.
 */
export function resolvePluginRequest(input: {
  url: string
  /** The bridge key parsed from `?m=<key>` (parsed by the handler with its own rules; null if absent) */
  bridgeKey: string | null
  deps: PluginRequestDeps
}): PluginRequestDecision {
  const { deps } = input
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return { kind: 'error', status: 400, reason: 'bad-url' }
  }
  if (parsed.protocol !== 'plugin:') return { kind: 'error', status: 400, reason: 'bad-url' }

  const id = parsed.hostname || parsed.pathname.replace(/^\/+/, '').split('/')[0] || ''
  if (!PLUGIN_ID_RE.test(id)) return { kind: 'error', status: 400, reason: 'bad-url' }
  // For `plugin://<id>/a.js` the hostname is the id; for `plugin:///<id>/a.js` (no authority)
  // strip the id segment
  const rawPath = parsed.hostname
    ? parsed.pathname
    : parsed.pathname.replace(new RegExp(`^/+${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
  let relPath = rawPath
  try {
    relPath = decodeURIComponent(rawPath)
  } catch {
    // Invalid encoding: keep the raw text (downstream treats it as a normal path)
  }
  relPath = relPath.replace(/^\/+/, '')

  if (id === 'host') {
    if (relPath !== PLUGIN_BRIDGE_PATH) {
      return { kind: 'error', status: 404, reason: 'bad-bridge-path' }
    }
    if (!input.bridgeKey) return { kind: 'error', status: 400, reason: 'missing-key' }
    return { kind: 'bridge', key: input.bridgeKey, search: parsed.search }
  }

  const dir = deps.pluginDir(id)
  if (!dir) return { kind: 'error', status: 404, reason: 'not-found' }
  if (!deps.isEnabled(id)) return { kind: 'error', status: 403, reason: 'disabled' }

  const abs = joinPath(dir, relPath)
  if (!isInsideDir(dir, abs)) return { kind: 'error', status: 403, reason: 'forbidden' }
  if (!deps.exists(abs)) return { kind: 'error', status: 404, reason: 'not-a-file' }
  return { kind: 'file', id, abs, relPath }
}
