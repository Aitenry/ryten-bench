// 本工具（search_graph）归属 notes 插件：实体检索走本插件的 wiki 与 graph mapper，不再跨插件直读。
// 经 harness 的**工具贡献点**（HARNESS_TOOL_CONTRIBUTION，契约见
// src/main/plugins/tool-contract.ts）注册给 AI：插件未启用时 harness 拉不到这条贡献，
// 工具自然不出现在模型面前。
import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import * as z from 'zod/v4'
import { mainFormat } from '../../../../main/i18n'
import { getDocsToolTexts } from '../../../../main/i18n/tool-results-docs'
import type { PluginToolContribution } from '../../../../main/plugins/tool-contract'

// ============================================================================
// Graph Handler
// ============================================================================

async function searchGraphHandler(params: { wikiId?: number; query: string }): Promise<string> {
  // 同插件内取数据：wiki/graph 的 mapper 与工具同属 notes
  const { getAllWikis } = await import('../db/mapper/wiki')
  const { searchEntities } = await import('../db/mapper/graph')
  const tr = getDocsToolTexts()
  const wikis = params.wikiId ? [{ id: params.wikiId }] : (await getAllWikis()).items
  const lines: string[] = [mainFormat(tr.graph.searchHeader, { query: params.query })]
  let totalFound = 0
  for (const wiki of wikis) {
    const entities = await searchEntities(wiki.id, params.query)
    if (entities.length > 0) {
      lines.push(mainFormat(tr.graph.wikiLabel, { wikiId: wiki.id }))
      for (const e of entities) {
        const aliases = e.aliases
          ? mainFormat(tr.graph.aliasSuffix, {
              aliases: (JSON.parse(e.aliases) as string[]).join(', ')
            })
          : ''
        const desc = e.description ? ` - ${e.description.slice(0, 100)}` : ''
        lines.push(
          // confidence 库列为可空（DEFAULT 1），null 按默认置信度 1 呈现
          `    [${e.type}] ${e.name}${aliases}${mainFormat(tr.graph.confidenceSuffix, {
            percent: ((e.confidence ?? 1) * 100).toFixed(0)
          })}${desc}`
        )
      }
      totalFound += entities.length
    }
  }
  if (totalFound === 0) return mainFormat(tr.graph.searchEmpty, { query: params.query })
  return lines.join('\n')
}

// ============================================================================
// Tool Builder
// ============================================================================

export function buildSearchGraphTool(): StructuredToolInterface {
  return tool(async (params) => searchGraphHandler(params), {
    name: 'search_graph',
    description:
      'Search entities in the knowledge graph (people, places, concepts, organizations, etc.). The knowledge graph is a network of entities and relations automatically extracted from documents.',
    schema: z.object({
      query: z.string().describe('Search keywords'),
      wikiId: z
        .number()
        .optional()
        .describe('Restrict the search to a single wiki (omit to search all wikis)')
    })
  })
}

// ============================================================================
// Harness 工具贡献
// ============================================================================

/** 本插件贡献给 harness 的 AI 工具（由 main/index.ts 经 ctx.contribute 注册） */
export const graphToolContributions: PluginToolContribution[] = [
  {
    name: 'search_graph',
    info: {
      name: 'search_graph',
      label: 'Graph search',
      description: 'Search entities in the knowledge graph',
      icon: 'RiMindMap',
      color: '#eb2f96'
    },
    build: buildSearchGraphTool
  }
]
