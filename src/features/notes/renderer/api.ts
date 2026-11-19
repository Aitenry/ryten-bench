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
} from '../shared/types'

/**
 * notes 插件主进程通道的薄封装。
 *
 * 原先散在 `src/preload/index.ts` 的六个命名空间（`todoItems` / `taskDependencies` /
 * `docs` / `wikis` / `graph` / `nodePositions`）已整体删除；这里的方法分组与
 * **名称、参数、返回类型**逐一对应（分组结构保留，避免 `add` / `delete` / `getAll`
 * 在不同域之间重名），实现改为走 preload 唯一暴露的通用桥
 * （`window.api.plugin.invoke/on`，通道名 `plugin:notes:*`）。
 *
 * 契约见 src/plugins/README.md；类型取自 shared/types.ts（跨进程 DTO，运行期零依赖）。
 */
const invoke = window.api.plugin.invoke

export const notesApi = {
  /* ── 待办事项 ── */
  todoItems: {
    getById: (id: number) =>
      invoke('plugin:notes:todo-items-get-by-id', id) as Promise<TodoItemRow[]>,
    getByTitle: (title: string) =>
      invoke('plugin:notes:todo-items-get-by-title', title) as Promise<TodoItemRow[]>,
    getByPriority: (priority: number) =>
      invoke('plugin:notes:todo-items-get-by-priority', priority) as Promise<TodoItemRow[]>,
    getByCompletedStatus: (status: number | boolean) =>
      invoke('plugin:notes:todo-items-get-by-completed-status', status) as Promise<TodoItemRow[]>,
    getAll: () => invoke('plugin:notes:todo-items-get-schedule') as Promise<TodoItemRow[]>,
    getAllPaginated: (page?: number, pageSize?: number) =>
      invoke('plugin:notes:todo-items-get-paginated', page, pageSize) as Promise<
        PaginatedResult<TodoItemRow>
      >,
    getByDueDate: (dueDate: string) =>
      invoke('plugin:notes:todo-items-get-by-due-date', dueDate) as Promise<TodoItemRow[]>,
    add: (
      todoItem: Omit<
        TodoItemRow,
        'id' | 'created_at' | 'updated_at' | 'completed_at' | 'started_at'
      >
    ) => invoke('plugin:notes:todo-items-add', todoItem) as Promise<number>,
    update: (id: number, updates: Partial<Omit<TodoItemRow, 'id'>>) =>
      invoke('plugin:notes:todo-items-update', id, updates) as Promise<boolean>,
    delete: (id: number) => invoke('plugin:notes:todo-items-delete', id) as Promise<boolean>
  },

  /* ── 任务依赖 ── */
  taskDependencies: {
    add: (taskId: number, dependsOnTaskId: number) =>
      invoke('plugin:notes:task-deps-add', taskId, dependsOnTaskId) as Promise<number>,
    delete: (taskId: number, dependsOnTaskId: number) =>
      invoke('plugin:notes:task-deps-delete', taskId, dependsOnTaskId) as Promise<boolean>,
    getAll: () => invoke('plugin:notes:task-deps-get-all') as Promise<TaskDependencyRow[]>,
    getTasksWithDeps: () =>
      invoke('plugin:notes:task-deps-get-with-tasks') as Promise<TaskWithDependencies[]>
  },

  /* ── 文档库 ── */
  docs: {
    getById: (id: number) =>
      invoke('plugin:notes:doc-get-by-id', id) as Promise<DocWithContent | null>,
    getAll: (page?: number, pageSize?: number, excludeWikiId?: number, search?: string) =>
      invoke('plugin:notes:doc-get-all', page, pageSize, excludeWikiId, search) as Promise<
        PaginatedResult<DocListItem>
      >,
    getPage: (query: string, page?: number, pageSize?: number) =>
      invoke('plugin:notes:doc-page-get', query, page, pageSize) as Promise<
        PaginatedResult<DocListItem>
      >,
    add: (
      doc: Omit<DocRow, 'id' | 'created_at' | 'updated_at'> & {
        image?: string | null
        content?: string | null
      }
    ) => invoke('plugin:notes:doc-add', doc) as Promise<number>,
    update: (
      id: number,
      updates: Partial<Omit<DocRow, 'id' | 'created_at'>> & {
        image?: string | null
        content?: string | null
      }
    ) => invoke('plugin:notes:doc-update', id, updates) as Promise<boolean>,
    delete: (id: number) => invoke('plugin:notes:doc-delete', id) as Promise<boolean>,
    deleteByTimeRange: (startTime: string, endTime: string) =>
      invoke('plugin:notes:doc-delete-by-time-range', startTime, endTime) as Promise<number>,
    importDocument: () =>
      invoke('plugin:notes:doc-import') as Promise<{ title: string; content: string } | null>,
    exportDocument: (id: number) => invoke('plugin:notes:doc-export', id) as Promise<boolean>
  },

  /* ── 知识库与目录 ── */
  wikis: {
    getById: (id: number) => invoke('plugin:notes:wiki-get-by-id', id) as Promise<WikiRow | null>,
    getAll: (page?: number, pageSize?: number) =>
      invoke('plugin:notes:wiki-get-all', page, pageSize) as Promise<PaginatedResult<WikiRow>>,
    add: (wiki: Omit<WikiRow, 'id' | 'doc_count' | 'created_at' | 'updated_at'>) =>
      invoke('plugin:notes:wiki-add', wiki) as Promise<number>,
    update: (id: number, updates: Partial<Omit<WikiRow, 'id' | 'doc_count' | 'created_at'>>) =>
      invoke('plugin:notes:wiki-update', id, updates) as Promise<boolean>,
    delete: (id: number) => invoke('plugin:notes:wiki-delete', id) as Promise<boolean>,
    getDirectories: (wikiId: number) =>
      invoke('plugin:notes:wiki-directories-get', wikiId) as Promise<WikiDirectoryRow[]>,
    addDirectory: (directory: Omit<WikiDirectoryRow, 'id' | 'created_at' | 'updated_at'>) =>
      invoke('plugin:notes:wiki-directory-add', directory) as Promise<number>,
    updateDirectory: (id: number, updates: Partial<Omit<WikiDirectoryRow, 'id' | 'created_at'>>) =>
      invoke('plugin:notes:wiki-directory-update', id, updates) as Promise<boolean>,
    deleteDirectory: (id: number) =>
      invoke('plugin:notes:wiki-directory-delete', id) as Promise<boolean>,
    getNotesByDirectory: (directoryId: number) =>
      invoke('plugin:notes:wiki-directory-docs-get', directoryId) as Promise<DirectoryDocRef[]>,
    addNoteToDirectory: (directoryId: number, noteId: number, sortOrder?: number) =>
      invoke(
        'plugin:notes:wiki-directory-note-add',
        directoryId,
        noteId,
        sortOrder
      ) as Promise<number>,
    removeNoteFromDirectory: (directoryId: number, noteId: number) =>
      invoke('plugin:notes:wiki-directory-doc-remove', directoryId, noteId) as Promise<boolean>,
    getDirectoriesByNote: (noteId: number) =>
      invoke('plugin:notes:wiki-doc-directories-get', noteId) as Promise<WikiDirectoryRow[]>
  },

  /* ── 知识图谱（数据查询 / 构建 / 追加 + 三个事件通道） ── */
  graph: {
    getData: (wikiId: number, typeFilter?: string, docIds?: number[]) =>
      invoke('plugin:notes:graph-data-get', wikiId, typeFilter, docIds) as Promise<GraphData>,
    getEntity: (entityId: number) =>
      invoke('plugin:notes:graph-entity-get', entityId) as Promise<GraphEntity | null>,
    searchEntities: (wikiId: number, query: string) =>
      invoke('plugin:notes:graph-entity-search', wikiId, query) as Promise<GraphEntity[]>,
    updateEntity: (id: number, updates: Record<string, unknown>) =>
      invoke('plugin:notes:graph-entity-update', id, updates) as Promise<boolean>,
    deleteEntity: (id: number) =>
      invoke('plugin:notes:graph-entity-delete', id) as Promise<boolean>,
    deleteRelation: (id: number) =>
      invoke('plugin:notes:graph-relation-delete', id) as Promise<boolean>,
    getBuildStatus: (wikiId: number) =>
      invoke('plugin:notes:graph-build-status', wikiId) as Promise<GraphBuildJob | null>,
    /**
     * 启动图谱构建。迁移说明：主进程侧原为 `ipcMain.on('graph-build-start')`，
     * 现统一走 ctx.registerIpc（只有 handle），因此这里从 send 改为 invoke；
     * 进度/完成/错误仍由三个 plugin:notes:graph-build-* 事件通道下发。
     */
    buildGraph: (wikiId: number, config?: Record<string, unknown>) =>
      invoke('plugin:notes:graph-build-start', wikiId, config) as Promise<void>,
    appendDocs: (wikiId: number, docIds: number[]) =>
      invoke('plugin:notes:graph-docs-append', wikiId, docIds) as Promise<GraphAppendResult>,
    getProcessedDocIds: (wikiId: number) =>
      invoke('plugin:notes:graph-processed-docs-get', wikiId) as Promise<number[]>,
    /**
     * 订阅构建进度/完成/错误（主进程 → 渲染层）。
     * 走通用桥 `window.api.plugin.on`：通道必须由插件 `ctx.registerEvent` 声明才进
     * preload 白名单，**插件停用时本调用抛错**——调用方（BuildProgressProvider）
     * 必须 try/catch 降级，否则异常会从 useEffect 逃逸、卸载整棵渲染树（白屏）。
     */
    onBuildProgress: (callback: (progress: GraphBuildProgress) => void) =>
      window.api.plugin.on('plugin:notes:graph-build-progress', (data) =>
        callback(data as GraphBuildProgress)
      ),
    onBuildComplete: (callback: (result: GraphBuildComplete) => void) =>
      window.api.plugin.on('plugin:notes:graph-build-complete', (data) =>
        callback(data as GraphBuildComplete)
      ),
    onBuildError: (callback: (error: GraphBuildError) => void) =>
      window.api.plugin.on('plugin:notes:graph-build-error', (data) =>
        callback(data as GraphBuildError)
      )
  },

  /* ── 图谱 / 看板节点坐标 ── */
  nodePositions: {
    getAll: () => invoke('plugin:notes:node-positions-get-all') as Promise<NodePositionRow[]>,
    save: (nodeId: string, x: number, y: number) =>
      invoke('plugin:notes:node-position-save', nodeId, x, y) as Promise<void>,
    saveBatch: (positions: { node_id: string; x: number; y: number }[]) =>
      invoke('plugin:notes:node-positions-save-batch', positions) as Promise<void>,
    delete: (nodeId: string) =>
      invoke('plugin:notes:node-position-delete', nodeId) as Promise<boolean>
  }
}

export default notesApi
