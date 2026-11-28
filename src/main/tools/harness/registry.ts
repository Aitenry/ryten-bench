/**
 * **Pure logic** of the AI tool registry (zero imports, loadable directly by node for offline
 * regression testing).
 *
 * Why it was extracted from `builders.ts`: the registry merges three sources (local tools / plugin
 * contributions / MCP servers), and the rules for "who wins on duplicate names, list order,
 * prefixed naming" are exactly the ones most prone to drift, so they must be assertable offline.
 * builders.ts depends on runtime modules such as the AI layer/electron (and uses **extensionless
 * relative imports**, which Node cannot load directly), so the rules live here: nothing is
 * imported, and tests can simply `import` this file.
 */

/**
 * Display metadata for a tool in the settings page/list.
 *
 * **Structurally identical** to core's `ToolInfo` (`src/main/plugins/tool-contract.ts`): that
 * definition is deliberately not imported here, only to keep this module zero-dependency (see the
 * file header). The assignment direction is safe — identical structure means compatible.
 */
export interface ToolInfoLike {
  name: string
  label: string
  description: string
  icon: string
  color: string
  /**
   * Source label: `system` / `plugin` / `mcp` (same values as core's `ToolSourceKind`).
   * This module stays zero-dependency, so that type is not imported; the field is passed through
   * and the merge rules don't care about it.
   */
  source?: 'system' | 'plugin' | 'mcp'
}

/** One tool source: name + display metadata, plus a factory that yields a callable instance */
export interface ToolSource<T = unknown> {
  info: ToolInfoLike
  /** Actually builds the tool instance (called lazily when needed) */
  build: () => T
}

/** Duplicate names already warned about (collisions recur on every assembly round; warn once to avoid log spam) */
const warnedConflicts = new Set<string>()

/** Record and warn once about a duplicate-name conflict (local tools win over everything, first come first served) */
export function warnConflict(name: string, onWarn?: (message: string) => void): void {
  if (warnedConflicts.has(name)) return
  warnedConflicts.add(name)
  const message = `[Harness] Tool name conflict: '${name}' is already taken by an earlier tool with the same name (local tools take priority), ignoring later contributions`
  if (onWarn) onWarn(message)
  else console.warn(message)
}

/** Merge result: callable instance map + display list (same order and same dedup rules) */
export interface MergedTools<T> {
  builders: Record<string, () => T>
  infos: ToolInfoLike[]
}

/**
 * Merge the three tool sources (order is priority):
 *  1. `local` — local tools (weather / time), always first;
 *  2. `contributed` — tools registered by plugins through the `harness.tool` contribution point,
 *     **sorted by name** (registry order depends on plugin load order; without sorting, toggling a
 *     plugin once would change the dropdown order in the settings page);
 *  3. `mcp` — tools currently exposed by external MCP servers, also sorted by name
 *     (full names carry the server namespace prefix, so one server's tools naturally stay together).
 *
 * Duplicate names are first come first served; later ones emit a conflict warning and are dropped —
 * **never throw**: a server or plugin colliding with a built-in tool should only cost one tool, not
 * keep the whole conversation from starting.
 */
export function mergeToolSources<T>(sources: {
  local: ToolSource<T>[]
  contributed?: ToolSource<T>[]
  mcp?: ToolSource<T>[]
  onWarn?: (message: string) => void
}): MergedTools<T> {
  const builders: Record<string, () => T> = {}
  const infos: ToolInfoLike[] = []
  const seen = new Set<string>()

  const pushAll = (list: ToolSource<T>[], sort: boolean): void => {
    const accepted: ToolSource<T>[] = []
    for (const source of sort
      ? [...list].sort((a, b) => a.info.name.localeCompare(b.info.name, 'en'))
      : list) {
      const name = source.info.name
      if (seen.has(name)) {
        warnConflict(name, sources.onWarn)
        continue
      }
      seen.add(name)
      builders[name] = source.build
      accepted.push(source)
    }
    for (const source of accepted) infos.push(source.info)
  }

  pushAll(sources.local, false)
  pushAll(sources.contributed ?? [], true)
  pushAll(sources.mcp ?? [], true)

  return { builders, infos }
}
