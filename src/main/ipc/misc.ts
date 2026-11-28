import { ipcMain } from 'electron'
import logger from 'electron-log'
import { sql } from 'drizzle-orm'
import { getOrm } from '../database/orm'
import { listContributions } from '../plugins/contributions'
import { appEventListenerCount } from '../plugins/app-events'
import {
  APP_BEFORE_QUIT,
  APP_PRELOAD,
  APP_RENDERER_MEMORY_DUMP,
  APP_EVENT_WORKSPACE_CHANGED,
  type AppHook
} from '../plugins/app-hooks'

/**
 * Miscellaneous IPC (core): heartbeat, initialization progress logging, and **read-only host
 * lifecycle probes**.
 *
 * `harness-get-tools` (the tool dropdown list) belongs to the AI assistant and lives in
 * `src/main/ipc/harness/harness.ts` under the channel name `harness:harness-get-tools` (it reads
 * the tool registry = local tools + built-in/plugin contributions).
 *
 * Lifecycle probes: `app.preload` / `app.before-quit` / `app.renderer-memory-dump` contributed by
 * third-party plugins exist only in main-process memory and cannot be observed directly by the
 * renderer, yet "these hooks must no longer run after a plugin is disabled" is a core acceptance
 * point of the plugin host, and verifying it through logs is too brittle. This provides a
 * **read-only** diagnostic channel (it changes no behavior, exposes no plugin content, and only
 * reports counts and labels).
 * Hooks of built-in features (AI assistant / library) do not go through contribution points and are
 * not in this list.
 *
 *   - `preload` / `beforeQuit` / `memoryDump`: current plugin contribution counts and labels;
 *   - `workspaceListeners`: number of `app.workspace-changed` subscribers (including the AI
 *     assistant and third-party plugins).
 */
export function registerMiscIpc(): void {
  ipcMain.on('ping', () => logger.info('pong'))

  ipcMain.handle('app-lifecycle-hooks', () => ({
    preload: listContributions<AppHook>(APP_PRELOAD).map((h) => h.label),
    beforeQuit: listContributions<AppHook>(APP_BEFORE_QUIT).map((h) => h.label),
    memoryDump: listContributions<AppHook>(APP_RENDERER_MEMORY_DUMP).map((h) => h.label),
    workspaceListeners: appEventListenerCount(APP_EVENT_WORKSPACE_CHANGED)
  }))

  /**
   * Read-only diagnostic: row counts of a few tables (**whitelist**; the core carries no plugin
   * table-name semantics).
   *
   * Why the core has this: the physical-uninstall acceptance test must assert that `music_folders`
   * / `music_tracks` have 0 rows after uninstalling and clearing data, yet once the plugin is
   * uninstalled its channels are gone and the renderer has no other way to read the database.
   * This exposes only "table name -> count"; the table names come from the caller and must be in
   * the whitelist at the **call site** — the core itself does not know which plugin owns these
   * tables (`music_*` is a string passed in by the test harness, not a core constant).
   */
  ipcMain.handle('app-table-counts', async (_event, tables: unknown) => {
    if (!Array.isArray(tables)) throw new Error('app-table-counts 需要表名数组')
    const orm = await getOrm()
    const out: Record<string, number> = {}
    for (const table of tables) {
      if (typeof table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        throw new Error(`非法表名: ${String(table)}`)
      }
      // Table names are whitelisted against the identifier pattern, so injection is impossible;
      // values always use parameter binding
      const result = await orm.execute<{ count: string | number }>(
        sql.raw(`SELECT count(*)::int AS count FROM "${table}"`)
      )
      const row = (result as unknown as { rows: { count: string | number }[] }).rows?.[0]
      out[table] = Number(row?.count ?? 0)
    }
    return out
  })
}
