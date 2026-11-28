import type {
  DirectoryDocRef,
  DocListItem,
  DocRow,
  DocWithContent,
  GraphAppendResult,
  GraphBuildComplete,
  GraphBuildError,
  GraphBuildJob,
  GraphBuildProgress,
  GraphData,
  GraphEntity,
  NodePositionRow,
  PaginatedResult,
  TaskDependencyRow,
  TaskWithDependencies,
  TodoItemRow,
  WikiDirectoryRow,
  WikiRow
} from '../../../shared/notes/types'

/**
 * Thin wrapper over the notes plugin's main-process channels.
 *
 * The six namespaces previously scattered in `src/preload/index.ts` (`todoItems` /
 * `taskDependencies` / `docs` / `wikis` / `graph` / `nodePositions`) have all been removed; the
 * method grouping here matches them one by one in **names, parameters and return types** (the
 * grouping is kept so `add` / `delete` / `getAll` do not collide across domains), while the
 * implementation goes through the single generic bridge exposed by preload
 * (`window.api.system.invoke/on`, channel names `notes:*`).
 *
 * The contract lives in src/main/plugins/context.ts; types come from shared/types.ts
 * (cross-process DTOs with zero runtime dependencies).
 */
const invoke = window.api.system.invoke

export const notesApi = {
  /* ── To-do items ── */
  todoItems: {
    getById: (id: number) => invoke('notes:todo-items-get-by-id', id) as Promise<TodoItemRow[]>,
    getByTitle: (title: string) =>
      invoke('notes:todo-items-get-by-title', title) as Promise<TodoItemRow[]>,
    getByPriority: (priority: number) =>
      invoke('notes:todo-items-get-by-priority', priority) as Promise<TodoItemRow[]>,
    getByCompletedStatus: (status: number | boolean) =>
      invoke('notes:todo-items-get-by-completed-status', status) as Promise<TodoItemRow[]>,
    getAll: () => invoke('notes:todo-items-get-schedule') as Promise<TodoItemRow[]>,
    getAllPaginated: (page?: number, pageSize?: number) =>
      invoke('notes:todo-items-get-paginated', page, pageSize) as Promise<
        PaginatedResult<TodoItemRow>
      >,
    getByDueDate: (dueDate: string) =>
      invoke('notes:todo-items-get-by-due-date', dueDate) as Promise<TodoItemRow[]>,
    add: (
      todoItem: Omit<
        TodoItemRow,
        'id' | 'created_at' | 'updated_at' | 'completed_at' | 'started_at'
      >
    ) => invoke('notes:todo-items-add', todoItem) as Promise<number>,
    update: (id: number, updates: Partial<Omit<TodoItemRow, 'id'>>) =>
      invoke('notes:todo-items-update', id, updates) as Promise<boolean>,
    delete: (id: number) => invoke('notes:todo-items-delete', id) as Promise<boolean>
  },

  /* ── Task dependencies ── */
  taskDependencies: {
    add: (taskId: number, dependsOnTaskId: number) =>
      invoke('notes:task-deps-add', taskId, dependsOnTaskId) as Promise<number>,
    delete: (taskId: number, dependsOnTaskId: number) =>
      invoke('notes:task-deps-delete', taskId, dependsOnTaskId) as Promise<boolean>,
    getAll: () => invoke('notes:task-deps-get-all') as Promise<TaskDependencyRow[]>,
    getTasksWithDeps: () =>
      invoke('notes:task-deps-get-with-tasks') as Promise<TaskWithDependencies[]>
  },

  /* ── Document library ── */
  docs: {
    getById: (id: number) => invoke('notes:doc-get-by-id', id) as Promise<DocWithContent | null>,
    getAll: (page?: number, pageSize?: number, excludeWikiId?: number, search?: string) =>
      invoke('notes:doc-get-all', page, pageSize, excludeWikiId, search) as Promise<
        PaginatedResult<DocListItem>
      >,
    getPage: (query: string, page?: number, pageSize?: number) =>
      invoke('notes:doc-page-get', query, page, pageSize) as Promise<PaginatedResult<DocListItem>>,
    add: (
      doc: Omit<DocRow, 'id' | 'created_at' | 'updated_at'> & {
        image?: string | null
        content?: string | null
      }
    ) => invoke('notes:doc-add', doc) as Promise<number>,
    update: (
      id: number,
      updates: Partial<Omit<DocRow, 'id' | 'created_at'>> & {
        image?: string | null
        content?: string | null
      }
    ) => invoke('notes:doc-update', id, updates) as Promise<boolean>,
    delete: (id: number) => invoke('notes:doc-delete', id) as Promise<boolean>,
    deleteByTimeRange: (startTime: string, endTime: string) =>
      invoke('notes:doc-delete-by-time-range', startTime, endTime) as Promise<number>,
    importDocument: () =>
      invoke('notes:doc-import') as Promise<{ title: string; content: string } | null>,
    exportDocument: (id: number) => invoke('notes:doc-export', id) as Promise<boolean>
  },

  /* ── Knowledge bases and directories ── */
  wikis: {
    getById: (id: number) => invoke('notes:wiki-get-by-id', id) as Promise<WikiRow | null>,
    getAll: (page?: number, pageSize?: number) =>
      invoke('notes:wiki-get-all', page, pageSize) as Promise<PaginatedResult<WikiRow>>,
    add: (wiki: Omit<WikiRow, 'id' | 'doc_count' | 'created_at' | 'updated_at'>) =>
      invoke('notes:wiki-add', wiki) as Promise<number>,
    update: (id: number, updates: Partial<Omit<WikiRow, 'id' | 'doc_count' | 'created_at'>>) =>
      invoke('notes:wiki-update', id, updates) as Promise<boolean>,
    delete: (id: number) => invoke('notes:wiki-delete', id) as Promise<boolean>,
    getDirectories: (wikiId: number) =>
      invoke('notes:wiki-directories-get', wikiId) as Promise<WikiDirectoryRow[]>,
    addDirectory: (directory: Omit<WikiDirectoryRow, 'id' | 'created_at' | 'updated_at'>) =>
      invoke('notes:wiki-directory-add', directory) as Promise<number>,
    updateDirectory: (id: number, updates: Partial<Omit<WikiDirectoryRow, 'id' | 'created_at'>>) =>
      invoke('notes:wiki-directory-update', id, updates) as Promise<boolean>,
    deleteDirectory: (id: number) => invoke('notes:wiki-directory-delete', id) as Promise<boolean>,
    getNotesByDirectory: (directoryId: number) =>
      invoke('notes:wiki-directory-docs-get', directoryId) as Promise<DirectoryDocRef[]>,
    addNoteToDirectory: (directoryId: number, noteId: number, sortOrder?: number) =>
      invoke('notes:wiki-directory-note-add', directoryId, noteId, sortOrder) as Promise<number>,
    removeNoteFromDirectory: (directoryId: number, noteId: number) =>
      invoke('notes:wiki-directory-doc-remove', directoryId, noteId) as Promise<boolean>,
    getDirectoriesByNote: (noteId: number) =>
      invoke('notes:wiki-doc-directories-get', noteId) as Promise<WikiDirectoryRow[]>
  },

  /* ── Knowledge graph (data query / build / append + three event channels) ── */
  graph: {
    getData: (wikiId: number, typeFilter?: string, docIds?: number[]) =>
      invoke('notes:graph-data-get', wikiId, typeFilter, docIds) as Promise<GraphData>,
    getEntity: (entityId: number) =>
      invoke('notes:graph-entity-get', entityId) as Promise<GraphEntity | null>,
    searchEntities: (wikiId: number, query: string) =>
      invoke('notes:graph-entity-search', wikiId, query) as Promise<GraphEntity[]>,
    updateEntity: (id: number, updates: Record<string, unknown>) =>
      invoke('notes:graph-entity-update', id, updates) as Promise<boolean>,
    deleteEntity: (id: number) => invoke('notes:graph-entity-delete', id) as Promise<boolean>,
    deleteRelation: (id: number) => invoke('notes:graph-relation-delete', id) as Promise<boolean>,
    getBuildStatus: (wikiId: number) =>
      invoke('notes:graph-build-status', wikiId) as Promise<GraphBuildJob | null>,
    /**
     * Start a graph build. Migration note: the main-process side used to be
     * `ipcMain.on('graph-build-start')`; it now goes through ctx.registerIpc (handle only), so
     * this changed from send to invoke; progress/complete/error are still delivered through the
     * three notes:graph-build-* event channels.
     */
    buildGraph: (wikiId: number, config?: Record<string, unknown>) =>
      invoke('notes:graph-build-start', wikiId, config) as Promise<void>,
    appendDocs: (wikiId: number, docIds: number[]) =>
      invoke('notes:graph-docs-append', wikiId, docIds) as Promise<GraphAppendResult>,
    getProcessedDocIds: (wikiId: number) =>
      invoke('notes:graph-processed-docs-get', wikiId) as Promise<number[]>,
    /**
     * Subscribe to build progress/complete/error (main process → renderer).
     * Goes through the generic bridge `window.api.system.on`: channels must be declared by the
     * plugin via `ctx.registerEvent` to enter the preload allowlist, and **this call throws when
     * the plugin is disabled** — callers (BuildProgressProvider) must try/catch and degrade,
     * otherwise the exception escapes useEffect and unmounts the whole render tree (blank screen).
     */
    onBuildProgress: (callback: (progress: GraphBuildProgress) => void) =>
      window.api.system.on('notes:graph-build-progress', (data) =>
        callback(data as GraphBuildProgress)
      ),
    onBuildComplete: (callback: (result: GraphBuildComplete) => void) =>
      window.api.system.on('notes:graph-build-complete', (data) =>
        callback(data as GraphBuildComplete)
      ),
    onBuildError: (callback: (error: GraphBuildError) => void) =>
      window.api.system.on('notes:graph-build-error', (data) => callback(data as GraphBuildError))
  },

  /* ── Graph / board node positions ── */
  nodePositions: {
    getAll: () => invoke('notes:node-positions-get-all') as Promise<NodePositionRow[]>,
    save: (nodeId: string, x: number, y: number) =>
      invoke('notes:node-position-save', nodeId, x, y) as Promise<void>,
    saveBatch: (positions: { node_id: string; x: number; y: number }[]) =>
      invoke('notes:node-positions-save-batch', positions) as Promise<void>,
    delete: (nodeId: string) => invoke('notes:node-position-delete', nodeId) as Promise<boolean>
  }
}

export default notesApi
