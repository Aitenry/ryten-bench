import type { PluginToolContribution } from '../../plugins/tool-contract'
import { materialsToolContributions } from './materials'

/**
 * Tools the materials library provides to the AI assistant.
 *
 * Since 2026-11-28 the materials surface is a set of domain tools — document tools split by intent
 * (`materials_docs_search` / `_read` / `_write` / `_edit`), to-do tools with the same granularity
 * (`materials_todos_search` / `_read` / `_write` / `_edit`) — plus `materials_wikis` /
 * `materials_graph`, that the user selects as a single `materials-tools` entry, the same pattern as
 * `schedule-tasks` and `web-tools`. Each domain's implementation stays split by file
 * (docs/todos/wikis/graph). Old tool names (`manage_materials`, and the pre-merge `manage_docs` /
 * `manage_todos` / `manage_wikis` / `search_graph`) are migrated to the group entry when config is
 * read (see shared/harness/mcp.ts).
 *
 * `src/main/system/notes.ts` registers this into the harness tool registry at startup
 * (`registerBuiltinHarnessTools`) and unregisters it on exit. It goes through the same consumption
 * point as third-party plugins; the only difference is that this is a built-in source compiled
 * into the app.
 */
export const notesToolContributions: PluginToolContribution[] = [...materialsToolContributions]
