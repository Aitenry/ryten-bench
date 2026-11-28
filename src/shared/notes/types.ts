/**
 * Cross-process DTOs for the notes plugin: the input/output shapes of main-process IPC; the
 * renderer reads the same definitions.
 *
 * Follows the planner plugin's approach — row types are **derived by the main-process mapper**
 * (which in turn derives them from the drizzle schema's `$inferSelect`), so there is no second
 * hand-maintained field table; changing the schema once keeps both ends consistent.
 *
 * Only `export type` / `import type`, so nothing remains at runtime after compilation:
 * the renderer won't pull drizzle, the main directory or electron into its bundle because of
 * this file (see src/main/plugins/context.ts).
 */

/* ── Todos and task dependencies ── */

export type { TodoItemRow } from '../../main/database/mapper/notes/todo'
export type { TaskDependencyRow, TaskWithDependencies } from '../../main/database/mapper/notes/todo-dependencies'

/* ── Document library ── */

export type {
  DocListItem,
  DocRow,
  DocWithContent,
  PaginatedResult
} from '../../main/database/mapper/notes/document'

/* ── Wiki ── */

export type { WikiBaseRow, WikiDirectoryRow, WikiRow } from '../../main/database/mapper/notes/wiki'

/* ── Knowledge graph ── */

export type { GraphBuildJob, GraphData, GraphEntity, GraphRelation } from '../../main/database/mapper/notes/graph'

/**
 * Graph build progress event (main process → renderer payload of `notes:graph-build-progress`).
 * The payload has no mapper to derive from, so it is declared explicitly to match the shape
 * broadcast by ipc/graph.ts.
 */
export interface GraphBuildProgress {
  wikiId: number
  phase: string
  phaseLabel: string
  phaseProgress: number
  overallProgress: number
  processedDocs: number
  totalDocs: number
  processedChunks: number
  totalChunks: number
  entityCount: number
  relationCount: number
  message: string
  needsRefresh?: boolean
}

/** Graph build completion event payload */
export interface GraphBuildComplete {
  wikiId: number
  entityCount: number
  relationCount: number
}

/** Graph build failure event payload */
export interface GraphBuildError {
  wikiId: number
  error: string
}

/** Return value of appending documents to a graph */
export interface GraphAppendResult {
  entitiesAdded: number
  relationsAdded: number
}

/** Document reference under a wiki directory (`wiki-directory-docs-get`) */
export interface DirectoryDocRef {
  doc_id: number
  sort_order: number | null
}

/** Graph node position row (`node-positions-get-all`) */
export interface NodePositionRow {
  node_id: string
  x: number
  y: number
  updated_at: string
}
