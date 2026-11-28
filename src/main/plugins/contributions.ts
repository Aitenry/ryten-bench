/**
 * Main-process plugin **multi-value contribution point** registry (core side; plugins exchange
 * through the host instead of importing each other).
 *
 * Semantics:
 * - **multi-value**: the same key may be contributed by several plugins (e.g. `harness.tool` is
 *   contributed by planner / notes / music with their own tools), and one plugin may contribute
 *   several entries;
 * - **pull**: the registry neither notifies nor dispatches. Consumers (e.g. harness assembling a
 *   tool set) call `listContributions(key)` **at the moment they need it** to get everything
 *   currently contributed, **order-independently** — it works no matter whose install ran first;
 * - **removed with the plugin**: contributions are tracked by pluginId; when a plugin is disabled
 *   the host calls `removeContributions(pluginId)` and clears all of its contributions at once; the
 *   next pull no longer sees them (consumers need not be aware that "the plugin is gone");
 * - **stored in plugin load order**: values are arrays and entries within a key keep contribution
 *   order (consumers needing stable output should sort by name themselves rather than rely on load
 *   order).
 *
 * This follows the same idea as the renderer `plugin-host` slots (multi-value, reversible), except
 * that the main-process side currently only has the "contribute → host consumes" relationship, so
 * there is no single-value provide/use.
 */

/** One mounted contribution: whose it is and what the value is */
interface ContributionEntry {
  pluginId: string
  value: unknown
}

/** key → contribution list in load order */
const registry = new Map<string, ContributionEntry[]>()

/** Mounts a contribution (the same plugin may call this several times for the same key; each is appended) */
export function addContribution(pluginId: string, key: string, value: unknown): void {
  const list = registry.get(key)
  if (list) list.push({ pluginId, value })
  else registry.set(key, [{ pluginId, value }])
}

/**
 * Removes **all** contributions of one plugin (called on disable/uninstall; idempotent).
 * Lists that become empty are deleted too, so the registry keeps no unconsumed empty slots.
 */
export function removeContributions(pluginId: string): void {
  for (const [key, list] of [...registry]) {
    const kept = list.filter((entry) => entry.pluginId !== pluginId)
    if (kept.length === 0) registry.delete(key)
    else if (kept.length !== list.length) registry.set(key, kept)
  }
}

/**
 * Reads all contributions for a contribution point (pull semantics: a snapshot at call time;
 * later plugin enable/disable does not rewrite the array already handed out).
 * Unknown keys return an empty array and **never throw** — "nobody contributes" is a normal state.
 */
export function listContributions<T>(key: string): T[] {
  return (registry.get(key) ?? []).map((entry) => entry.value as T)
}

/** Contribution point keys currently in the registry (for logging/diagnostics only; values excluded) */
export function contributionKeys(): string[] {
  return [...registry.keys()]
}

/**
 * Contribution point key: **plugin self-purge** (`plugin.purge`).
 *
 * Purpose: when uninstalling a plugin, its data is only really removed if the user checked "also
 * delete all data of this plugin"; the host then calls this contribution so the **plugin itself**
 * deletes its data — the tables live in core's schema and the rows in the same PGlite database, but
 * only the plugin knows which tables / managed directories belong to it, and core should not
 * hard-code any plugin table name.
 *
 * Contract (isomorphic to the hooks in `app-hooks.ts`, except the single-value semantics fit better
 * — a plugin has exactly one cleanup routine):
 * - the plugin does `ctx.contribute(PLUGIN_PURGE, { run, label })` in `install(ctx)`;
 * - the host calls `run()` while the plugin is **still loaded** (it needs to read its own mappers /
 *   managed directories), so `run` may safely import its own plugin modules (it never gets a
 *   disposed context);
 * - `run` deletes **data only**: not the table structure (migrations are untouched, so a database
 *   whose migrations no longer line up after uninstall cannot appear), and it does not touch the
 *   user's own original files (e.g. music only deletes the app-managed playlist directory, not the
 *   user's music);
 * - `label` is shown in the uninstall confirmation checkbox via `PluginListEntry.purgeLabel`
 *   ("including: …"), so it must be a phrase users understand.
 */
export const PLUGIN_PURGE = 'plugin.purge'

/** Value of a `plugin.purge` contribution: `label` is only for logs/confirmation dialogs, `run` is the plugin's own cleanup action */
export interface PluginPurgeContribution {
  run: () => void | Promise<void>
  label: string
}

/**
 * Gets a plugin's cleanup action (null when not contributed).
 *
 * Uses the **last** entry: a repeated contribution from the same plugin takes effect, while different
 * plugins do not affect each other (the registry tracks contributions by pluginId, so disabling only
 * removes its own).
 */
export function pluginPurge(id: string): PluginPurgeContribution | null {
  const all = (registry.get(PLUGIN_PURGE) ?? []).filter((entry) => entry.pluginId === id)
  const value = all[all.length - 1]?.value as Partial<PluginPurgeContribution> | undefined
  if (!value || typeof value.run !== 'function') return null
  return { run: value.run, label: typeof value.label === 'string' ? value.label : id }
}

/**
 * Contribution point key: **cloud sync snapshot** (`plugin.sync.snapshot`).
 *
 * Background: `lattice/sync` used to sync only `userData/plugin-state/<id>.json`, while per the host
 * convention (app data in tables, settings in JSON) business data lives in the plugin's own tables —
 * so the cloud only got settings. This contribution point lets each plugin decide **what to sync**:
 *
 * Contract:
 * - the plugin does `ctx.contribute(PLUGIN_SYNC_SNAPSHOT, { export, import })` in `install(ctx)`;
 * - `export()` returns a **JSON-serializable** object (the platform limit is 256KiB; the host skips
 *   the whole snapshot when over the limit instead of truncating it), with content defined by the
 *   plugin: settings, a combined snapshot of settings + business tables, anything;
 * - `import(data)` must be **replace semantics and idempotent**: applying the same snapshot twice
 *   must not produce duplicate rows (the host may call it several times on pull / when "use cloud" is
 *   chosen for a conflict); throwing counts as failure and the host does not advance `data_rev`;
 * - while the contribution exists the host **no longer** reads/writes `plugin-state/<id>.json` as the
 *   sync payload (that file is settings only; using it as a snapshot would overwrite cloud data with
 *   settings); when the plugin is not loaded (disabled) cloud data is kept but not written to disk,
 *   and is applied once the plugin is enabled again (`requestSync` triggers a sync);
 * - `label` is only for logs/troubleshooting.
 */
export const PLUGIN_SYNC_SNAPSHOT = 'plugin.sync.snapshot'

/** Value of a `plugin.sync.snapshot` contribution */
export interface PluginSyncSnapshotContribution {
  /** Exports the currently syncable data (settings + business tables); the host serializes and uploads it */
  export: () => unknown | Promise<unknown>
  /** Applies a cloud snapshot (**replace + idempotent**; when not implemented the host refuses to write the snapshot into plugin-state) */
  import?: (data: unknown) => void | Promise<void>
  /**
   * Merge: merges the cloud snapshot into local data (without overwriting local-only data, deduping
   * by the plugin's natural keys).
   *
   * Returns a summary text for UI hints; after a successful merge the host pushes "the merged local
   * snapshot" back to the cloud (with `data_rev`, without force), so the plugin only has to make
   * local data the union of both sides and need not call the network itself.
   *
   * **New contract (since 2026-11-25)**: the host calls it only when the plugin also declares
   * `mergeBase: true`, passing `opts.base` (the cloud snapshot from the last successful sync). The
   * plugin must implement a three-way merge: rows deleted locally relative to the base must not be
   * pulled back from the cloud, and rows edited locally must not be appended twice; the old
   * unconditional union brought back data the user had deleted/edited (user report: "I deleted/
   * edited it and it still got pushed back to me").
   */
  merge?: (
    data: unknown,
    opts?: { base?: unknown }
  ) => void | Promise<{ summary?: string; rows?: number }>
  /**
   * Declares that `merge()` is upgraded to **merge-base three-way merging**.
   *
   * Without the declaration (older plugins) the host only does fast-forward (push / pull) and
   * explicit conflict selection, never calls `merge()`, and never shows "merge both" — better to lose
   * one feature than to silently merge deleted data back.
   *
   * Implementation checklist (distilled from the 2026-11-25 data incident):
   * - use `opts.base` to work out the rows **deleted/changed away** locally since the last sync, and
   *   do not add stale remote rows back;
   * - when ids match, decide edits by id: unchanged locally → accept the cloud; changed on both
   *   sides → local wins (do not append a second copy);
   * - collections in settings (members/rules/templates) must also be filtered by the base, otherwise
   *   deletions come back through the union;
   * - before importing/merging, null out dangling accountId/categoryId/merchantId/refundOfId rather
   *   than rejecting the whole snapshot;
   * - a pure function merge(local, remote, base), idempotent, ignoring volatile fields like
   *   exportedAt.
   */
  mergeBase?: boolean
  /**
   * Whether local business data already exists (optional; the host uses it to decide that when "the
   * snapshot has never been pushed and local has data" it must not overwrite with the cloud directly,
   * but record a conflict for the user to choose/merge first).
   */
  hasData?: () => boolean | Promise<boolean>
  /**
   * Counts business data rows in a snapshot (optional; used in sync results/UI to show "how many rows
   * pulled/pushed"). Returns a number; the plugin decides how to count (e.g. the sum of row counts of
   * ten tables).
   */
  count?: (data: unknown) => number | Promise<number>
  /** Description text, for logs/troubleshooting only */
  label?: string
}

/**
 * Gets a plugin's sync snapshot contribution (null when not contributed / plugin not loaded).
 *
 * Same "last entry wins" rule as `pluginPurge`; `export` is required, `import` optional.
 */
export function pluginSyncSnapshot(id: string): PluginSyncSnapshotContribution | null {
  const all = (registry.get(PLUGIN_SYNC_SNAPSHOT) ?? []).filter((entry) => entry.pluginId === id)
  const value = all[all.length - 1]?.value as Partial<PluginSyncSnapshotContribution> | undefined
  if (!value || typeof value.export !== 'function') return null
  return {
    export: value.export,
    ...(typeof value.import === 'function' ? { import: value.import } : {}),
    ...(typeof value.merge === 'function' ? { merge: value.merge } : {}),
    ...(value.mergeBase === true ? { mergeBase: true } : {}),
    ...(typeof value.hasData === 'function' ? { hasData: value.hasData } : {}),
    ...(typeof value.count === 'function' ? { count: value.count } : {}),
    ...(typeof value.label === 'string' ? { label: value.label } : {})
  }
}
