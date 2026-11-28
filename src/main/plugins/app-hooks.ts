/**
 * **Host contract** for app-level lifecycle hooks (main-process side, owned by core).
 *
 * Why it exists: several fixed moments in core's app flow need plugins to take part too —
 * prefetching data on the loading page, releasing resources before quit, dumping a memory snapshot
 * when the renderer crashes, and restarting listeners after a workspace switch. The implementations
 * live in plugins (e.g. `preloadHarnessData` / `closeAllMnemon` belong to harness), but the moments
 * belong to core. If core imported plugin modules directly, plugins would no longer be removable
 * content but code grafted into the shell (removing exactly that dependency is the goal).
 *
 * Approach: **reuse the multi-value contribution points** (`src/main/plugins/contributions.ts`)
 * instead of building a separate mechanism for each moment.
 * - `APP_PRELOAD` / `APP_BEFORE_QUIT` / `APP_RENDERER_MEMORY_DUMP` are multi-value contribution
 *   points: a plugin does `ctx.contribute(KEY, hook)` in `install(ctx)`, and core runs them one by
 *   one at the fixed moment after `listContributions<AppHook>(KEY)` (each with its own try/catch, so
 *   one plugin failing does not affect the others);
 * - contributions are removed with `ctx.dispose()` ⇒ **hooks no longer run after a plugin is
 *   disabled** (one of the acceptance criteria);
 * - moments where core actively notifies (e.g. workspace switch) use the event bus
 *   (`app-events.ts`): plugins subscribe with `ctx.effect(() => onAppEvent(KEY, handler))` and the
 *   effect is rolled back with the plugin.
 *
 * Note: these keys only describe "who is called at which moment", never plugin identity — core
 * therefore knows nothing about plugins.
 */

/**
 * Hook: `label` is only used for logging, `run` is the plugin's own action (may be async).
 *
 * The arguments of `run` vary by contribution point: `app.renderer-memory-dump` receives
 * `(reason, exitCode)` (the renderer exit reason) while other hooks ignore arguments — the type
 * makes them optional uniformly, so callers pass what they need and implementations declare what
 * they need.
 */
export interface AppHook {
  run: (reason?: string, exitCode?: number) => void | Promise<void>
  label: string
}

/** Loading page: prefetch moment after app init and before the main window takes over (multiple plugins may contribute) */
export const APP_PRELOAD = 'app.preload'

/** Before quit: core's before-quit cleanup phase (async supported; awaited and caught one by one) */
export const APP_BEFORE_QUIT = 'app.before-quit'

/** Moment to dump a diagnostic snapshot when the renderer exits abnormally (crash/OOM) */
export const APP_RENDERER_MEMORY_DUMP = 'app.renderer-memory-dump'

/**
 * App event names from core → plugins (within the main process, unrelated to the renderer host event
 * bus). Payloads are in `AppWorkspaceChangedPayload`; consumers read only what they need and need not
 * depend on the payload.
 */
export const APP_EVENT_WORKSPACE_CHANGED = 'app.workspace-changed'

/**
 * The user checked "clear local data" on uninstall and the plugin's `plugin.purge` has run.
 *
 * **This only means local data was cleared**: the cloud install record/data snapshot are kept.
 * The plugin hub (`lattice/sync`) uses this to drop the local `data_rev` cache so the next pull
 * writes the cloud data back to this machine (otherwise the local rev would stay at the old value
 * and wrongly assume "already up to date").
 */
export const APP_EVENT_PLUGIN_DATA_PURGED = 'app.plugin-data-purged'

/** `app.plugin-data-purged` payload */
export interface AppPluginDataPurgedPayload {
  pluginId: string
}

/** `app.workspace-changed` payload: the active workspace after the switch (null when not configured) */
export interface AppWorkspaceChangedPayload {
  /** Active workspace id (not configured = null) */
  workspaceId: number | null
  /** Active workspace absolute path (not configured = empty string) */
  workspacePath: string
}
