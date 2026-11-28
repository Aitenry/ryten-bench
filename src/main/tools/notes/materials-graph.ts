/**
 * `materials_graph` — knowledge-graph domain of the materials-organization tools.
 *
 * One of the four tools the single `manage_materials` entry was split into (2026-11-28). Graph
 * search returns entity IDs (not just names) so a hit can be opened with `graph.entity` or its
 * source document read with `materials_docs_read`. The UI still shows one selectable item
 * (`materials-tools`).
 */
import * as z from 'zod/v4'
import { tool } from '../../ai/tools'
import type { StructuredToolInterface } from '../../ai/tools'
import { getGraphEntityHandler, searchGraphHandler } from './graph'
import { missingParamText } from './materials-shared'

export const MATERIALS_GRAPH_TOOL = 'materials_graph'

const COMMANDS = ['graph.search', 'graph.entity'] as const

const DESCRIPTION = `「资料整理 · 图谱」知识图谱实体与关系。

  graph.search      搜索实体（返回实体 ID/类型/别名/置信度/来源文档）：query?, wikiId?, type?, limit?
                    （省略 query 或传空串时列出实体，可按 wikiId/type 过滤）
  graph.entity      实体详情 + 出入关系 + 来源文档：entityId, includeRelations?, limit?

命中后可用 graph.entity 查看关系与来源文档；来源文档的正文用 materials_docs_read 读取。`

const schema = z.object({
  command: z.enum(COMMANDS).describe('Operation to run; see the tool description'),
  entityId: z.number().int().positive().optional().describe('[graph.entity] Entity ID'),
  query: z
    .string()
    .optional()
    .describe('[graph.search] Search text; omit or leave empty to list entities'),
  wikiId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('[graph.search] Restrict the search to one wiki'),
  type: z
    .string()
    .optional()
    .describe('[graph.search] Entity type filter (e.g. person/organization/concept)'),
  includeRelations: z
    .boolean()
    .optional()
    .describe('[graph.entity] Include incoming/outgoing relations (default true)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('[graph.search/graph.entity] Max results/relations')
})

type GraphParams = z.infer<typeof schema>

async function dispatch(params: GraphParams): Promise<string> {
  const p = params as Record<string, unknown>
  switch (params.command) {
    case 'graph.search':
      return searchGraphHandler({
        query: params.query,
        wikiId: params.wikiId,
        type: params.type,
        limit: params.limit
      })
    case 'graph.entity':
      return (
        missingParamText(p, ['entityId']) ||
        getGraphEntityHandler({
          entityId: params.entityId!,
          includeRelations: params.includeRelations,
          limit: params.limit
        })
      )
    default:
      return `Unknown command: ${String(params.command)}`
  }
}

export function buildMaterialsGraphTool(): StructuredToolInterface {
  return tool(dispatch, {
    name: MATERIALS_GRAPH_TOOL,
    description: DESCRIPTION,
    schema
  })
}
