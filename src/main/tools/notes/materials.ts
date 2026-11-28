/**
 * "Materials organization" tools — one selectable entry (`materials-tools`), several real tools.
 *
 * History / why it looks like this:
 * - 2026-11: the four domain tools `manage_docs` / `manage_todos` / `manage_wikis` /
 *   `search_graph` were merged into a single `manage_materials` entry;
 * - 2026-11-28 (user feedback): that one entry had 35 commands and a single flat schema with every
 *   domain's parameters, so the model had to guess which fields applied. It was split by domain —
 *   `materials_docs` + `materials_todos` / `materials_wikis` / `materials_graph`;
 * - same day, further split: `materials_docs` still mixed searching, reading, whole-document
 *   writes and fine-grained edits, so it became `materials_docs_search` / `_read` / `_write` /
 *   `_edit`. To-dos were split with the same granularity: `materials_todos_search` / `_read` /
 *   `_write` / `_edit`. Knowledge bases and the graph stay one tool each.
 *
 * Like scheduled tasks (`schedule-tasks`) and web tools (`web-tools`), the picker still shows
 * **one** item, `materials-tools`, expanded into the real tools when a turn is assembled.
 *
 * Each domain's implementation stays in its own file (`docs.ts` / `todos.ts` / `wikis.ts` /
 * `graph.ts`); the tool definitions live in `materials-{docs,todos,wikis,graph}.ts`. Old names
 * (`manage_materials` and the four pre-merge names) are migrated to the group entry in
 * `shared/harness/mcp.ts` (`canonicalToolName`).
 */
import type { PluginToolContribution } from '../../plugins/tool-contract'
import type { StructuredToolInterface } from '../../ai/tools'
import { MATERIALS_TOOL_NAMES } from '../../../shared/harness/mcp'
import {
  buildMaterialsDocsEditTool,
  buildMaterialsDocsReadTool,
  buildMaterialsDocsSearchTool,
  buildMaterialsDocsWriteTool,
  MATERIALS_DOCS_EDIT_TOOL,
  MATERIALS_DOCS_READ_TOOL,
  MATERIALS_DOCS_SEARCH_TOOL,
  MATERIALS_DOCS_WRITE_TOOL
} from './materials-docs'
import { buildMaterialsGraphTool, MATERIALS_GRAPH_TOOL } from './materials-graph'
import {
  buildMaterialsTodosEditTool,
  buildMaterialsTodosReadTool,
  buildMaterialsTodosSearchTool,
  buildMaterialsTodosWriteTool,
  MATERIALS_TODOS_EDIT_TOOL,
  MATERIALS_TODOS_READ_TOOL,
  MATERIALS_TODOS_SEARCH_TOOL,
  MATERIALS_TODOS_WRITE_TOOL
} from './materials-todos'
import { buildMaterialsWikisTool, MATERIALS_WIKIS_TOOL } from './materials-wikis'

const BUILDERS = {
  [MATERIALS_DOCS_SEARCH_TOOL]: buildMaterialsDocsSearchTool,
  [MATERIALS_DOCS_READ_TOOL]: buildMaterialsDocsReadTool,
  [MATERIALS_DOCS_WRITE_TOOL]: buildMaterialsDocsWriteTool,
  [MATERIALS_DOCS_EDIT_TOOL]: buildMaterialsDocsEditTool,
  [MATERIALS_TODOS_SEARCH_TOOL]: buildMaterialsTodosSearchTool,
  [MATERIALS_TODOS_READ_TOOL]: buildMaterialsTodosReadTool,
  [MATERIALS_TODOS_WRITE_TOOL]: buildMaterialsTodosWriteTool,
  [MATERIALS_TODOS_EDIT_TOOL]: buildMaterialsTodosEditTool,
  [MATERIALS_WIKIS_TOOL]: buildMaterialsWikisTool,
  [MATERIALS_GRAPH_TOOL]: buildMaterialsGraphTool
} as const

/**
 * Display metadata for the real tools. They are hidden from the picker (only the group entry is
 * shown), but the metadata is still used by `list_capabilities` details and as a fallback before
 * the i18n override in `ipc/harness/harness.ts`.
 */
const MATERIALS_INFOS = {
  [MATERIALS_DOCS_SEARCH_TOOL]: {
    label: 'Materials: document search',
    description: 'Full-text search across documents',
    icon: 'RiSearchLine',
    color: '#722ed1'
  },
  [MATERIALS_DOCS_READ_TOOL]: {
    label: 'Materials: document read',
    description: 'Read a document outline, body or search inside one document',
    icon: 'RiFileTextLine',
    color: '#722ed1'
  },
  [MATERIALS_DOCS_WRITE_TOOL]: {
    label: 'Materials: document write',
    description: 'Create, update or delete a whole document',
    icon: 'RiFileEditLine',
    color: '#722ed1'
  },
  [MATERIALS_DOCS_EDIT_TOOL]: {
    label: 'Materials: document edit',
    description: 'Fine-grained line, range and text-fragment edits',
    icon: 'RiPencilLine',
    color: '#722ed1'
  },
  [MATERIALS_TODOS_SEARCH_TOOL]: {
    label: 'Materials: todo search',
    description: 'List and filter to-do items',
    icon: 'RiSearchLine',
    color: '#722ed1'
  },
  [MATERIALS_TODOS_READ_TOOL]: {
    label: 'Materials: todo detail',
    description: 'Read one to-do item in full',
    icon: 'RiListCheck',
    color: '#722ed1'
  },
  [MATERIALS_TODOS_WRITE_TOOL]: {
    label: 'Materials: todo write',
    description: 'Add, update or delete a single to-do item',
    icon: 'RiFileEditLine',
    color: '#722ed1'
  },
  [MATERIALS_TODOS_EDIT_TOOL]: {
    label: 'Materials: todo batch edit',
    description: 'Batch update the status / priority / due date / category of several items',
    icon: 'RiPencilLine',
    color: '#722ed1'
  },
  [MATERIALS_WIKIS_TOOL]: {
    label: 'Materials: knowledge bases',
    description: 'Manage knowledge bases, directories and archived documents',
    icon: 'RiFoldersLine',
    color: '#722ed1'
  },
  [MATERIALS_GRAPH_TOOL]: {
    label: 'Materials: graph',
    description: 'Search graph entities and read their relations',
    icon: 'RiShareLine',
    color: '#722ed1'
  }
} as const

/**
 * The real tool contributions registered by the notes library (`system/notes.ts`).
 *
 * The picker shows only the `materials-tools` group entry built by `listAvailableTools`; these are
 * hidden there but must still be registered so `buildTools` can resolve them by name.
 */
export const materialsToolContributions: PluginToolContribution[] = MATERIALS_TOOL_NAMES.map(
  (name) => ({
    name,
    info: { name, ...MATERIALS_INFOS[name] },
    build: BUILDERS[name]
  })
)

/** Build all real tools (used by tests and by anything that needs the complete set) */
export function buildMaterialsTools(): StructuredToolInterface[] {
  return MATERIALS_TOOL_NAMES.map((name) => BUILDERS[name]())
}
