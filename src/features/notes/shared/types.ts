/**
 * notes 插件的跨进程 DTO：主进程 IPC 的入参/出参形状，渲染层只读同一份定义。
 *
 * 沿袭 planner 插件的做法——行类型由**主进程 mapper 推导**（mapper 内部再用 drizzle
 * schema 的 `$inferSelect` 推导），不手工维护第二份字段表，schema 改一处即两端口径一致。
 *
 * 只有 `export type` / `import type`，编译后不留任何运行期依赖：
 * 渲染层不会因此把 drizzle、main 目录或 electron 打进产物
 * （契约见 src/plugins/README.md）。
 */

/* ── 待办（todo）与任务依赖 ── */

export type { TodoItemRow } from '../main/db/mapper/todo'
export type { TaskDependencyRow, TaskWithDependencies } from '../main/db/mapper/todo-dependencies'

/* ── 文档库（document） ── */

export type {
  DocListItem,
  DocRow,
  DocWithContent,
  PaginatedResult
} from '../main/db/mapper/document'

/* ── 知识库（wiki） ── */

export type { WikiBaseRow, WikiDirectoryRow, WikiRow } from '../main/db/mapper/wiki'

/* ── 知识图谱（graph） ── */

export type { GraphBuildJob, GraphData, GraphEntity, GraphRelation } from '../main/db/mapper/graph'

/**
 * 图谱构建进度事件（主进程 → 渲染层的 `plugin:notes:graph-build-progress` 载荷）。
 * 事件载荷没有 mapper 可推导，按 ipc/graph.ts 的广播形状显式声明。
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

/** 图谱构建完成事件载荷 */
export interface GraphBuildComplete {
  wikiId: number
  entityCount: number
  relationCount: number
}

/** 图谱构建失败事件载荷 */
export interface GraphBuildError {
  wikiId: number
  error: string
}

/** 图谱追加文档的返回值 */
export interface GraphAppendResult {
  entitiesAdded: number
  relationsAdded: number
}

/** 知识库目录下的文档引用（`wiki-directory-docs-get`） */
export interface DirectoryDocRef {
  doc_id: number
  sort_order: number | null
}

/** 图谱节点坐标行（`node-positions-get-all`） */
export interface NodePositionRow {
  node_id: string
  x: number
  y: number
  updated_at: string
}
