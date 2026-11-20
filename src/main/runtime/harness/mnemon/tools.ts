import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import logger from 'electron-log'
import { mainFormat, mainPlural, mainToolMessages } from '../../../i18n'
import type { MnemonService } from './service'
import type { RuntimeMemoryController } from './runtime-memory'
import type { DocumentController } from './documents'
import {
  MNEMON_CATEGORIES,
  MNEMON_EDGE_TYPES,
  MNEMON_SOURCES,
  type RuntimeMemoryTarget
} from './types'

/**
 * mnemon_* 模型工具集
 *
 * 移植自 dsh-mnemon 的工具面：
 * - 只读：mnemon_memory_bodies / mnemon_recall / mnemon_related / mnemon_status / mnemon_document_search
 * - 写：mnemon_runtime_memory / mnemon_document_manage / mnemon_remember / mnemon_link /
 *       mnemon_forget / mnemon_memory_body_create / mnemon_memory_body_update / mnemon_memory_body_merge
 *
 * 与 dsh-mnemon 的差异：本实现不区分 root/worker 路径（RytenBench 无 worker 体系），
 * 全部直接调用确定性服务层。
 */

export interface MnemonToolContext {
  service: MnemonService
  runtimeMemory: RuntimeMemoryController
  documents: DocumentController
  /** 当前工作区名（用于默认记忆空间命名） */
  workspaceName?: string
}

const categoryEnum = z.enum(MNEMON_CATEGORIES)
const sourceEnum = z.enum(MNEMON_SOURCES)
const edgeTypeEnum = z.enum(MNEMON_EDGE_TYPES)
const targetEnum = z.enum(['user', 'memory'])

/** 构建全部 mnemon 工具 */
export function buildMnemonTools(ctx: MnemonToolContext): StructuredToolInterface[] {
  const { service, runtimeMemory, documents } = ctx

  return [
    // ========================================================================
    // 只读工具
    // ========================================================================

    tool(
      async () => {
        const catalog = await service.bodies()
        return JSON.stringify({
          total: catalog.total,
          activeCount: catalog.activeCount,
          directory: catalog.directory,
          bodies: catalog.items.map((b) => ({
            id: b.id,
            name: b.name,
            description: b.description,
            active: b.active,
            totalInsights: b.stats?.totalInsights ?? 0,
            edgeCount: b.stats?.edgeCount ?? 0
          }))
        })
      },
      {
        name: 'mnemon_memory_bodies',
        description:
          'List the full Memory Space catalog: name, description, activation state, and statistics. Use it before a recall to confirm which Memory Spaces are available.',
        schema: z.object({})
      }
    ),

    tool(
      async ({ query, mode, limit, category, memory_body_ids }) => {
        const result = await service.search({
          query,
          mode: (mode as 'smart' | 'keyword' | 'basic' | undefined) ?? 'smart',
          limit: limit ?? 10,
          category: category as never,
          memoryBodyIds: memory_body_ids
        })
        const summary = result.results.map((r) => ({
          id: r.id,
          memory_body_id: r.memoryBodyId,
          memory_body_name: r.memoryBodyName,
          category: r.category,
          importance: r.importance,
          score: r.score,
          content: r.content
        }))
        return JSON.stringify({
          query: result.query,
          mode: result.mode,
          total: result.results.length,
          hint: result.hint,
          results: summary
        })
      },
      {
        name: 'mnemon_recall',
        description:
          'Recall historical memory evidence from active Memory Spaces. Use it when the question depends on earlier conversations, on decisions, preferences, or facts recorded earlier, or when cross-session memory is needed.',
        schema: z.object({
          query: z.string().describe('Focused recall query (natural language or keywords)'),
          mode: z
            .enum(['smart', 'keyword', 'basic'])
            .optional()
            .describe(
              'smart=token-overlap scoring (default), keyword=every token must match, basic=LIKE substring match'
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(12)
            .optional()
            .describe('Maximum number of results to return; defaults to 10'),
          category: categoryEnum.optional().describe('Filter results by category'),
          memory_body_ids: z
            .array(z.string())
            .optional()
            .describe('Memory Space IDs to restrict the recall to; omit to use every active space')
        })
      }
    ),

    tool(
      async ({ id, depth, edge, memory_body_id }) => {
        const results = await service.related(id, depth ?? 2, edge as never, memory_body_id)
        return JSON.stringify({
          source_id: id,
          total: results.length,
          results: results.map((r) => ({
            id: r.id,
            depth: r.depth,
            edge_type: r.edgeType,
            content: r.content,
            memory_body_id: r.memoryBodyId
          }))
        })
      },
      {
        name: 'mnemon_related',
        description:
          'Traverse the relation graph from a known memory ID to reach related memories (temporal/semantic/causal/entity). To explain how memories relate to each other, call mnemon_recall first to get the exact ID, then use this tool.',
        schema: z.object({
          id: z.string().describe('Exact ID of the starting memory'),
          depth: z.number().int().min(1).max(2).optional().describe('Traversal depth; default 2'),
          edge: edgeTypeEnum.optional().describe('Filter by relation type'),
          memory_body_id: z.string().optional().describe('Memory Space that holds the memory')
        })
      }
    ),

    tool(
      async () => {
        const catalog = await service.bodies()
        const active = catalog.items.filter((b) => b.active)
        return JSON.stringify({
          storage_root: service.storageRoot,
          memory_bodies_total: catalog.total,
          memory_bodies_active: catalog.activeCount,
          active_spaces: active.map((b) => ({
            id: b.id,
            name: b.name,
            totalInsights: b.stats?.totalInsights ?? 0
          })),
          runtime_memory_configured: runtimeMemory.snapshot().entries.length > 0,
          documents_configured: documents.snapshot().total > 0
        })
      },
      {
        name: 'mnemon_status',
        description:
          'Aggregate memory-system status: storage root, Memory Spaces, and overviews of runtime memory and documents.',
        schema: z.object({})
      }
    ),

    tool(
      async ({ query, include_archived, limit }) => {
        const result = await documents.search(query, {
          includeArchived: include_archived ?? false,
          limit: limit ?? 10
        })
        return JSON.stringify({
          query: result.query,
          total: result.total,
          results: result.results.map((d) => ({
            id: d.id,
            title: d.title,
            description: d.description,
            status: d.status,
            updated_at: d.updatedAt,
            excerpt: d.excerpt,
            content: d.content.slice(0, 2000)
          }))
        })
      },
      {
        name: 'mnemon_document_search',
        description:
          'Deterministically search Project Documents. Documents are more complete than a single memory (design documents, procedures, investigation findings, handover notes); use this when you need to read one in full, fast.',
        schema: z.object({
          query: z.string().describe('Search keywords'),
          include_archived: z
            .boolean()
            .optional()
            .describe('Include archived documents; defaults to false'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe('Maximum number of results to return; defaults to 10')
        })
      }
    ),

    // ========================================================================
    // 写工具
    // ========================================================================

    tool(
      async ({ action, target, content, old_text, importance }) => {
        const tm = mainToolMessages().mnemon
        if (action === 'add') {
          const result = await runtimeMemory.mutate({
            action: 'add',
            target: target as RuntimeMemoryTarget,
            content,
            importance: importance as never
          })
          if (!result.success) return result.message
          const usage = result.usage
          const vars = {
            target: target === 'user' ? tm.targets.user : tm.targets.memory,
            used: usage.used,
            limit: usage.limit,
            entryCount: mainPlural(tm.entryCount_one, tm.entryCount_other, result.entryCount)
          }
          if (result.maintenance) {
            return mainFormat(tm.addedWithMaintenance, {
              ...vars,
              summary: result.maintenance.summary
            })
          }
          return mainFormat(tm.added, vars)
        }
        if (action === 'replace') {
          const result = await runtimeMemory.mutate({
            action: 'replace',
            target: target as RuntimeMemoryTarget,
            content,
            oldText: old_text,
            importance: importance as never
          })
          if (!result.success) return result.message
          return tm.replaced
        }
        const result = await runtimeMemory.mutate({
          action: 'remove',
          target: target as RuntimeMemoryTarget,
          oldText: old_text
        })
        if (!result.success) return result.message
        return tm.removed
      },
      {
        name: 'mnemon_runtime_memory',
        description:
          'Maintain runtime hot memory, the compact memory injected directly into the prompt every turn: user = user profile (identity/preferences/habits, 4 KiB), memory = project memory (decisions/conventions/environment facts/lessons, 10 KiB). add stores one independent new fact (identical content is never added twice); replace/remove locate an entry by a unique substring. Best for explicit preferences, stable conventions, environment facts, and frequently reused lessons.',
        schema: z.object({
          action: z.enum(['add', 'replace', 'remove']).describe('Operation to perform'),
          target: targetEnum.describe('user = user profile, memory = project memory'),
          content: z.string().optional().describe('New content for add/replace'),
          old_text: z
            .string()
            .optional()
            .describe('Unique substring that locates the entry for replace/remove'),
          importance: z
            .enum(['critical', 'normal', 'low'])
            .optional()
            .describe(
              'Retention priority: critical=must keep, normal=default, low=may be compacted or archived'
            )
        })
      }
    ),

    tool(
      async ({ action, id, title, description, content, source_paths, archive_summary }) => {
        const dm = mainToolMessages().mnemon.document
        if (action === 'create') {
          if (!title || !content) return dm.createRequires
          const result = await documents.mutate({
            action: 'create',
            title,
            description,
            content,
            sourcePaths: source_paths
          })
          return mainFormat(dm.created, { title: result.document.title, id: result.document.id })
        }
        if (action === 'update') {
          if (!id) return dm.updateRequiresId
          const result = await documents.mutate({
            action: 'update',
            id,
            title,
            description,
            content
          })
          return mainFormat(dm.updated, {
            title: result.document.title,
            revision: result.document.revision
          })
        }
        // archive
        if (!id) return dm.archiveRequiresId
        const doc = documents.get(id)
        if (!doc) return mainFormat(dm.notFound, { id })
        const summary = archive_summary ?? dm.defaultArchiveSummary
        const result = await documents.archive(id, { summary })
        return mainFormat(dm.archived, { title: result.document.title, summary })
      },
      {
        name: 'mnemon_document_manage',
        description:
          'Create, update, or archive Project Documents. Documents suit designs, investigation findings, procedures, and handover notes that need complete structure and rationale — they are more complete than a single memory. Never write ordinary chat, temporary progress, or secrets into a document.',
        schema: z.object({
          action: z.enum(['create', 'update', 'archive']).describe('Operation to perform'),
          id: z.string().optional().describe('Document ID for update/archive'),
          title: z.string().optional().describe('Required for create: document title'),
          description: z.string().optional().describe('Document description (used for search)'),
          content: z.string().optional().describe('Markdown body for create/update'),
          source_paths: z
            .array(z.string())
            .optional()
            .describe('Source file paths (read-only references; never modified)'),
          archive_summary: z.string().optional().describe('Archive summary (for archive)')
        })
      }
    ),

    tool(
      async ({ content, category, importance, tags, entities, source, memory_body_id }) => {
        try {
          const insight = await service.remember({
            content,
            category: category as never,
            importance,
            tags,
            entities,
            source: source as never,
            memoryBodyId: memory_body_id
          })
          return JSON.stringify({
            success: true,
            id: insight.id,
            memory_body_id: insight.memoryBodyId,
            memory_body_name: insight.memoryBodyName,
            category: insight.category,
            importance: insight.importance
          })
        } catch (err) {
          return mainFormat(mainToolMessages().mnemon.rememberFailed, {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      },
      {
        name: 'mnemon_remember',
        description:
          'Archive one insight into a long-term Memory Space. Use it for stable insights that must persist across tasks, or that benefit from graph relations and deep recall. Writes are deduplicated by exact content. Do not store questions, guesses, temporary progress, completed-work logs, secrets, or repository facts that are easy to rediscover.',
        schema: z.object({
          content: z.string().describe('Insight content to archive (self-contained, one entry)'),
          category: categoryEnum
            .optional()
            .describe('Category: preference, decision, fact, insight, context, or general'),
          importance: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe('Importance from 1 to 5; defaults to 3'),
          tags: z.array(z.string()).optional().describe('Tags (for easier retrieval)'),
          entities: z
            .array(z.string())
            .optional()
            .describe('Named entities (people, projects, technologies, ...)'),
          source: sourceEnum.optional().describe('Source: user, agent, or external'),
          memory_body_id: z
            .string()
            .optional()
            .describe('Target Memory Space ID; defaults to the first active space')
        })
      }
    ),

    tool(
      async ({ source_id, target_id, type, weight, reason, memory_body_id }) => {
        try {
          const result = await service.link(
            source_id,
            target_id,
            type as never,
            weight ?? 1,
            reason,
            memory_body_id
          )
          return mainFormat(mainToolMessages().mnemon.linked, {
            type: result.type,
            sourceId: result.sourceId,
            targetId: result.targetId
          })
        } catch (err) {
          return mainFormat(mainToolMessages().mnemon.linkFailed, {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      },
      {
        name: 'mnemon_link',
        description:
          'Create a typed relation between two known memory IDs (temporal=time order/semantic=meaning overlap/causal=cause and effect/entity=shared entity). Create a relation only when it materially improves future recall.',
        schema: z.object({
          source_id: z.string().describe('Source memory ID'),
          target_id: z.string().describe('Target memory ID'),
          type: edgeTypeEnum.describe('Relation type'),
          weight: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe('Relation confidence from 0 to 1; defaults to 1'),
          reason: z.string().optional().describe('Reason for creating the relation'),
          memory_body_id: z.string().optional().describe('Memory Space that holds the memories')
        })
      }
    ),

    tool(
      async ({ id, memory_body_id }) => {
        try {
          await service.forget(id, memory_body_id)
          return mainFormat(mainToolMessages().mnemon.forgotten, { id })
        } catch (err) {
          return mainFormat(mainToolMessages().mnemon.forgetFailed, {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      },
      {
        name: 'mnemon_forget',
        description:
          'Soft-delete one long-term memory by exact ID (a destructive semantic operation). Use it only when the user explicitly asks for the deletion, or when the content is verified to be wrong or obsolete.',
        schema: z.object({
          id: z.string().describe('Exact ID of the memory to delete'),
          memory_body_id: z.string().optional().describe('Memory Space that holds the memory')
        })
      }
    ),

    tool(
      async ({ name, description }) => {
        try {
          const body = await service.createBody({ name, description })
          return mainFormat(mainToolMessages().mnemon.createBody, { name: body.name, id: body.id })
        } catch (err) {
          return mainFormat(mainToolMessages().mnemon.createBodyFailed, {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      },
      {
        name: 'mnemon_memory_body_create',
        description:
          'Create a separate Memory Space. Create one only for a recurring, clearly bounded domain of its own; ordinary memories belong in an existing space.',
        schema: z.object({
          name: z
            .string()
            .describe('Space name (human-readable, e.g. "Blog project", "DSH environment")'),
          description: z
            .string()
            .describe('Routing boundary: what content belongs here and when to recall it')
        })
      }
    ),

    tool(
      async ({ id, name, description, active }) => {
        try {
          const body = service.updateBody(id, { name, description, active })
          return mainFormat(mainToolMessages().mnemon.updateBody, {
            name: body.name,
            active: String(body.active)
          })
        } catch (err) {
          return mainFormat(mainToolMessages().mnemon.updateBodyFailed, {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      },
      {
        name: 'mnemon_memory_body_update',
        description:
          'Update a Memory Space name, routing description, or activation state (activation controls whether the space participates in recall).',
        schema: z.object({
          id: z.string().describe('Memory Space ID'),
          name: z.string().optional().describe('New name'),
          description: z.string().optional().describe('New routing description'),
          active: z.boolean().optional().describe('Whether the space participates in recall')
        })
      }
    ),

    tool(
      async ({ target_body_id, source_body_ids, deactivate_sources }) => {
        try {
          const deactivated = deactivate_sources ?? true
          const tm = mainToolMessages().mnemon
          const result = await service.mergeBodies(target_body_id, source_body_ids, deactivated)
          return mainFormat(deactivated ? tm.mergeBodiesDeactivated : tm.mergeBodies, {
            imported: result.imported,
            skipped: result.skippedDuplicates
          })
        } catch (err) {
          return mainFormat(mainToolMessages().mnemon.mergeBodiesFailed, {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      },
      {
        name: 'mnemon_memory_body_merge',
        description:
          'Non-destructively import the content of source Memory Spaces into a target Memory Space (deduplicated by content hash); source spaces are deactivated by default. Use it to consolidate spaces.',
        schema: z.object({
          target_body_id: z.string().describe('Target Memory Space ID'),
          source_body_ids: z.array(z.string()).describe('Source Memory Space IDs'),
          deactivate_sources: z
            .boolean()
            .optional()
            .describe('Whether to deactivate the source spaces; defaults to true')
        })
      }
    )
  ]
}

/** 工具错误统一记录（供调用方诊断） */
export function logToolError(name: string, err: unknown): void {
  logger.warn(`[Mnemon] 工具 ${name} 失败:`, err)
}
