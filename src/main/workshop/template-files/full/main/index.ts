import { PLUGIN_PURGE } from '@host/main/plugins/contributions'
import { HARNESS_TOOL_CONTRIBUTION } from '@host/main/plugins/tool-contract'
// Side-effect import: triggers **this plugin's own table creation** on load (idempotent)
import { schemaReady } from './db/ddl'
import { ITEMS_CHANGED, createIpcHandlers, initSettings } from './ipc'
import { purgePluginData } from './purge'
import { createToolContribution } from './tools'
import type { MainPluginContext } from './context'

/**
 * Main-process entry point for ${vars.title} (**assembly only**; implementations live in ./ipc,
 * ./tools, ./purge and ./db).
 *
 * - `./db/ddl`: this plugin's own table creation (the host knows nothing about the
 *   `${vars.itemsToolName}` table), idempotent;
 * - `ctx.registerIpc`: the six `plugin:${vars.id}:*` channels (record CRUD + settings read/write);
 *   they are removed with `ctx.dispose()` when the plugin is disabled or uninstalled;
 * - `ctx.registerEvent`: main process -> renderer event channel (**sender only**; the renderer
 *   cannot subscribe unless it is declared there);
 * - `ctx.contribute(HARNESS_TOOL_CONTRIBUTION, …)`: the AI tool for the assistant (reads and
 *   writes the same data);
 * - `ctx.contribute(PLUGIN_PURGE, …)`: clears this plugin's table rows and files when
 *   "delete data as well" is checked during uninstall.
 *
 * Plugins with business tables should also contribute `PLUGIN_SYNC_SNAPSHOT`
 * (export/import/hasData/count); when the two sides must be merged, implement
 * `merge(remote, { base })` with three-way merge-base semantics and declare `mergeBase: true`.
 *
 * Every side effect goes through `ctx.effect` and returns a rollback function: the host undoes
 * them in reverse order when the plugin is disabled.
 */
export function install(ctx: MainPluginContext): void {
  // Table creation is async: this only starts it early; the mapper and purge each await its promise
  void schemaReady

  initSettings(ctx)

  ctx.registerEvent(ITEMS_CHANGED)
  ctx.registerIpc(createIpcHandlers())

  ctx.contribute(HARNESS_TOOL_CONTRIBUTION, createToolContribution())

  ctx.contribute(PLUGIN_PURGE, {
    label: '本插件的记录与设置（表 ${vars.itemsToolName} + plugin-state/${vars.id}.json）',
    run: purgePluginData
  })
}
