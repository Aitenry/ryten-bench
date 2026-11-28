import type { PluginToolContribution } from '../../plugins/tool-contract'
import { materialsToolContributions } from './materials'

/**
 * Tools the materials library provides to the AI assistant.
 *
 * Since 2026-11 the four domains (documents / to-dos / knowledge bases / graph) are unified into
 * one `manage_materials` tool, matching "materials organization" in the UI language; each domain's
 * implementation stays split by file (docs/todos/wikis/graph) and is dispatched by materials.ts.
 * Old tool names (manage_docs / manage_todos / manage_wikis / search_graph) are migrated to the
 * new name when the config is read (see shared/harness/mcp.ts).
 *
 * `src/main/system/notes.ts` registers this into the harness tool registry at startup
 * (`registerBuiltinHarnessTools`) and unregisters it on exit. It goes through the same consumption
 * point as third-party plugins; the only difference is that this is a built-in source compiled
 * into the app.
 */
export const notesToolContributions: PluginToolContribution[] = [...materialsToolContributions]
