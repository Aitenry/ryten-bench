import type React from 'react'
import type {
  DocListItem,
  GraphData,
  GraphEntity,
  GraphRelation,
  TodoItemRow,
  WikiRow
} from '../../../shared/notes/types'

/**
 * Renderer-layer types for the notes plugin: **pure frontend** shapes and constants; cross-process
 * DTOs live in ../shared/types.ts.
 *
 * Content origins (three pieces absorbed from core in this migration; the original files were
 * deleted):
 * - `@renderer/types/knowledge.ts` → graph chart data, entity type colors and entry key mappings;
 * - `@renderer/types/models.ts` → renderer-layer wrapper types for documents / todos / wikis;
 * - the notes component props that were mixed into `@renderer/types/components.ts`;
 * - `@renderer/plugins/notes/types.ts` → selection state types for the three-column home layout.
 *
 * core no longer imports these types in reverse: plugin-specific types must stay in the plugin,
 * otherwise the "plugins are disableable" boundary is blurred.
 */

/* ──────────── Home page (three-column layout) selection state ──────────── */

/** Source info carried when a document is opened in the left tree (used for the breadcrumb) */
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

/* ──────────── Renderer-layer wrappers for documents / todos / wikis ──────────── */

/** Todo item (equivalent to the main-process row type; the old name is kept to limit churn) */
export type TodoItem = TodoItemRow

/** Document item (including content and pinned state), used by DocumentCard and DocumentPreviewModal */
export interface DocItem extends DocListItem {
  content?: string | null
  isPinned?: boolean
}

/** Details of a document within a directory */
export interface DirectoryDocWithDetail extends DocListItem {
  directory_id: number
  content?: string | null
}

/** Tree node (shared by the home page left tree and selectors) */
export interface TreeNode {
  key: number
  title: string
  children: TreeNode[]
}

/** Document option (used by the knowledge graph toolbar) */
export interface DocOption {
  id: number
  title: string
}

/** Directory tree node (shape friendly to antd Tree) */
export interface TreeNodeData {
  key: React.Key
  title: React.ReactNode
  children?: TreeNodeData[]
}

/** Directory with child nodes */
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

/** Wiki edit data */
export interface WikiEditData {
  title: string
  summary: string | null
  tags: string | null
  image: string | null
}

/* ──────────── Knowledge graph: chart data and type mappings ──────────── */

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

/** Entity type → color mapping */
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
 * Entity type → entry key mapping.
 * This module does not hold `t`, and i18next's `t()` only accepts literal keys, so this stores
 * "data value → literal entry key" and lets callers (GraphView / EntityDetail) resolve it with
 * `t()`; types not listed in the table fall back to the raw type string.
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

/** Relation type → entry key mapping (same as above; the values are narrowed to a literal union too) */
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

/* ──────────── Component props (previously mixed into core's @renderer/types/components.ts) ──────────── */

/** Document preview modal (opened when a source document is clicked in the graph) */
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
  /** Document-level subgraph mode: hides the document filter / append / rebuild actions on the right of the search box */
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
  /** Open the document editor directly when a source document is clicked (provided by the host; falls back to the preview modal when omitted) */
  onOpenDocInEditor?: (docId: number) => void
  /** Initial document filter (document-level subgraph: only show entities extracted from the given documents) */
  initialDocFilter?: number[]
}

/** Todo list (optional initial data; loads on its own when omitted) */
export interface TodoListProps {
  initialTodos?: TodoItemRow[]
}

/** Graph build progress modal */
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

/** Graph data alias reused inside the graph view (same source as the main-process mapper) */
export type { GraphData }
