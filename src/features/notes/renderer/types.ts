import type React from 'react'
import type {
  DocListItem,
  GraphData,
  GraphEntity,
  GraphRelation,
  TodoItemRow,
  WikiRow
} from '../shared/types'

/**
 * notes 插件的渲染层类型：**纯前端**的形状与常量，跨进程 DTO 在 ../shared/types.ts。
 *
 * 内容来源（本轮迁移的三处 core 收编，原文件已删除）：
 * - `@renderer/types/knowledge.ts` → 图谱图表数据、实体类型配色与词条键映射；
 * - `@renderer/types/models.ts` → 文档/待办/知识库的渲染层包装类型；
 * - `@renderer/types/components.ts` 里 notes 自己的组件 props；
 * - `@renderer/plugins/notes/types.ts` → 首页三栏布局的选中态类型。
 *
 * core 不再反向 import 这些类型：插件专属类型必须留在插件里，否则「插件可停用」的边界失真。
 */

/* ──────────── 首页（三栏布局）选中态 ──────────── */

/** 左侧树中打开文档时携带的来源信息（用于面包屑） */
export interface DocSourceInfo {
  wikiId: number
  dirId?: number
  wikiTitle?: string
  dirName?: string
}

export type Selection =
  | { kind: 'doc'; docId: number; source?: DocSourceInfo }
  | { kind: 'todo'; todoId: number }
  | { kind: 'wiki-graph'; wikiId: number }
  | { kind: 'doc-graph'; wikiId: number; docId: number }
  | null

/* ──────────── 文档 / 待办 / 知识库的渲染层包装 ──────────── */

/** 待办事项（等价于主进程行类型，保留旧名以减少改动面） */
export type TodoItem = TodoItemRow

/** 文档项（含内容和置顶），用于 DocumentCard 和 DocumentPreviewModal */
export interface DocItem extends DocListItem {
  content?: string | null
  isPinned?: boolean
}

/** 目录下的文档详情 */
export interface DirectoryDocWithDetail extends DocListItem {
  directory_id: number
  content?: string | null
}

/** 树节点（首页左侧树、选择器共用） */
export interface TreeNode {
  key: number
  title: string
  children: TreeNode[]
}

/** 文档选项（用于知识图谱工具栏） */
export interface DocOption {
  id: number
  title: string
}

/** 目录树节点（antd Tree 友好形状） */
export interface TreeNodeData {
  key: React.Key
  title: React.ReactNode
  children?: TreeNodeData[]
}

/** 带子节点的目录 */
export interface DirectoryWithChildren {
  id: number
  wiki_id: number
  parent_id: number | null
  name: string
  sort_order: number
  level: number
  created_at: string
  updated_at: string
  children?: DirectoryWithChildren[]
}

/** 百科编辑数据 */
export interface WikiEditData {
  title: string
  summary: string | null
  tags: string | null
  image: string | null
}

/* ──────────── 知识图谱：图表数据与类型映射 ──────────── */

export interface GraphChartNode {
  id: string
  name: string
  category: number
  symbolSize: number
  original: GraphEntity
}

export interface GraphChartLink {
  source: string
  target: string
  label: string
  description?: string | null
}

export interface GraphChartCategory {
  name: string
  itemStyle: { color: string }
}

export interface GraphChartData {
  nodes: GraphChartNode[]
  links: GraphChartLink[]
  categories: GraphChartCategory[]
}

/** 实体类型 → 颜色映射 */
export const ENTITY_TYPE_COLORS: Record<string, string> = {
  person: '#FF6B6B',
  organization: '#4ECDC4',
  concept: '#96CEB4',
  event: '#D4A017',
  location: '#DDA0DD',
  other: '#BDC3C7',
  technology: '#45B7D1',
  product: '#98D8C8',
  system: '#3498DB',
  document: '#E67E22',
  standard: '#1ABC9C',
  facility: '#7F8C8D',
  substance: '#9B59B6',
  process: '#2ECC71',
  role: '#F39C12',
  skill: '#FF8C42',
  measure: '#E74C3C',
  artifact: '#FFD700',
  creature: '#8E44AD',
  realm: '#17A589'
}

/**
 * 实体类型 → 词条键映射。
 * 本模块不持有 `t`，而 i18next 的 `t()` 只接受字面量键，所以这里存「数据值 → 字面量词条键」，
 * 由调用方（GraphView / EntityDetail）用 `t()` 求值；表里未收录的类型回退成原始 type 字符串。
 */
export type GraphEntityTypeLabelKey =
  | 'graph.entityType.person'
  | 'graph.entityType.organization'
  | 'graph.entityType.concept'
  | 'graph.entityType.event'
  | 'graph.entityType.location'
  | 'graph.entityType.other'
  | 'graph.entityType.technology'
  | 'graph.entityType.product'
  | 'graph.entityType.system'
  | 'graph.entityType.document'
  | 'graph.entityType.standard'
  | 'graph.entityType.facility'
  | 'graph.entityType.substance'
  | 'graph.entityType.process'
  | 'graph.entityType.role'
  | 'graph.entityType.skill'
  | 'graph.entityType.measure'
  | 'graph.entityType.artifact'
  | 'graph.entityType.creature'
  | 'graph.entityType.realm'

export const ENTITY_TYPE_LABEL_KEYS: Partial<Record<string, GraphEntityTypeLabelKey>> = {
  person: 'graph.entityType.person',
  organization: 'graph.entityType.organization',
  concept: 'graph.entityType.concept',
  event: 'graph.entityType.event',
  location: 'graph.entityType.location',
  other: 'graph.entityType.other',
  technology: 'graph.entityType.technology',
  product: 'graph.entityType.product',
  system: 'graph.entityType.system',
  document: 'graph.entityType.document',
  standard: 'graph.entityType.standard',
  facility: 'graph.entityType.facility',
  substance: 'graph.entityType.substance',
  process: 'graph.entityType.process',
  role: 'graph.entityType.role',
  skill: 'graph.entityType.skill',
  measure: 'graph.entityType.measure',
  artifact: 'graph.entityType.artifact',
  creature: 'graph.entityType.creature',
  realm: 'graph.entityType.realm'
}

/** 关系类型 → 词条键映射（同上，取值同样收窄成字面量联合） */
export type GraphRelationTypeLabelKey =
  | 'graph.relationType.contains'
  | 'graph.relationType.part_of'
  | 'graph.relationType.is_a'
  | 'graph.relationType.located_in'
  | 'graph.relationType.depends_on'
  | 'graph.relationType.related_to'
  | 'graph.relationType.leads_to'
  | 'graph.relationType.uses'
  | 'graph.relationType.creates'
  | 'graph.relationType.produces'
  | 'graph.relationType.operates'
  | 'graph.relationType.owns'
  | 'graph.relationType.acquires'
  | 'graph.relationType.belongs_to'
  | 'graph.relationType.governs'
  | 'graph.relationType.monitors'
  | 'graph.relationType.employs'
  | 'graph.relationType.mentors'
  | 'graph.relationType.friend_of'
  | 'graph.relationType.enemy_of'
  | 'graph.relationType.loves'
  | 'graph.relationType.family_of'
  | 'graph.relationType.fights'
  | 'graph.relationType.kills'

export const RELATION_TYPE_LABEL_KEYS: Partial<Record<string, GraphRelationTypeLabelKey>> = {
  contains: 'graph.relationType.contains',
  part_of: 'graph.relationType.part_of',
  is_a: 'graph.relationType.is_a',
  located_in: 'graph.relationType.located_in',
  depends_on: 'graph.relationType.depends_on',
  related_to: 'graph.relationType.related_to',
  leads_to: 'graph.relationType.leads_to',
  uses: 'graph.relationType.uses',
  creates: 'graph.relationType.creates',
  produces: 'graph.relationType.produces',
  operates: 'graph.relationType.operates',
  owns: 'graph.relationType.owns',
  acquires: 'graph.relationType.acquires',
  belongs_to: 'graph.relationType.belongs_to',
  governs: 'graph.relationType.governs',
  monitors: 'graph.relationType.monitors',
  employs: 'graph.relationType.employs',
  mentors: 'graph.relationType.mentors',
  friend_of: 'graph.relationType.friend_of',
  enemy_of: 'graph.relationType.enemy_of',
  loves: 'graph.relationType.loves',
  family_of: 'graph.relationType.family_of',
  fights: 'graph.relationType.fights',
  kills: 'graph.relationType.kills'
}

/* ──────────── 组件 props（原先混在 core 的 @renderer/types/components.ts 里） ──────────── */

/** 文档预览弹窗（图谱里点来源文档时打开） */
export interface DocPreviewModalProps {
  open: boolean
  onCancel: () => void
  currentDoc: DocItem | null
}

export interface WikiEditModalProps {
  open: boolean
  isNew: boolean
  initialTitle?: string
  initialSummary?: string
  initialTags?: string
  initialImage?: string | null
  onSave: (data: WikiEditData) => Promise<void>
  onCancel: () => void
}

export interface WikiCardProps {
  item: WikiRow
  onSelect: () => void
  onEdit?: () => void
  onDelete?: () => void
}

export interface GraphCanvasProps {
  data: GraphChartData
  onEntityClick: (entity: GraphEntity) => void
  onEntityDblClick?: (entity: GraphEntity) => void
  searchQuery?: string
}

export interface GraphToolbarProps {
  wikiTitle: string
  isLoading: boolean
  searchQuery: string
  typeFilter: string | undefined
  entityCount: number
  relationCount: number
  docs: DocOption[]
  addedDocIds: Set<number>
  isAppending: boolean
  docFilter: number[]
  /** 文档级子图模式：隐藏搜索框右侧的文档筛选/追加/重建操作 */
  isDocGraph?: boolean
  onSearchChange: (value: string) => void
  onTypeFilterChange: (value: string | undefined) => void
  onAppendDocs: (docIds: number[]) => void
  onDocFilterChange: (docIds: number[]) => void
  onBuildGraph: () => void
}

export interface EntityDetailProps {
  entity: GraphEntity | null
  entities: GraphEntity[]
  relations: GraphRelation[]
  onRelationClick?: (entityId: number) => void
  onDocClick?: (docId: number) => void
  onClose?: () => void
}

export interface GraphViewProps {
  selectedWiki: WikiRow
  /** 点击来源文档时直接打开文档编辑器（由宿主传入；不传则回退预览弹窗） */
  onOpenDocInEditor?: (docId: number) => void
  /** 初始文档筛选（文档级子图：只显示指定文档抽取的实体） */
  initialDocFilter?: number[]
}

/** 待办列表（可选初始数据；不传则自行加载） */
export interface TodoListProps {
  initialTodos?: TodoItemRow[]
}

/** 图谱构建进度弹窗 */
export interface BuildProgressProps {
  open: boolean
  wikiId: number
  wikiTitle: string
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
  onMinimize: () => void
}

/** 图谱视图内部复用的图谱数据别名（与主进程 mapper 同源） */
export type { GraphData }
