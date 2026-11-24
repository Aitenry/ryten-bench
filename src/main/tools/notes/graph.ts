// 图谱域处理器（统一由 manage_materials 工具调度）。
//
// 2026-11 资料整理改造：
// - 搜索不再只给「名字」：补实体 ID、类型、别名、置信度、来源文档，模型拿到结果后
//   可以直接用 doc.get 打开来源，或用 graph.entity 看关系；
// - 修复「只搜前 10 个知识库」：getAllWikis 默认 pageSize=10，旧实现没传参，
//   第 11 个及之后的知识库永远搜不到；
// - 新增 graph.entity：实体详情 + 出入关系 + 来源文档，补上图谱「查到之后怎么用」这一环。
import { mainFormat, mainPlural } from '../../i18n'
import { getDocsToolTexts } from '../../i18n/tool-results-docs'

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function parseNumberArray(value: string | null | undefined): number[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
      : []
  } catch {
    return []
  }
}

function clip(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

function confidenceText(confidence: number | null | undefined): string {
  return mainFormat(getDocsToolTexts().graph.confidenceValue, {
    percent: ((confidence ?? 1) * 100).toFixed(0)
  })
}

async function sourceDocsText(sourceIds: number[], max = 5): Promise<string> {
  if (!sourceIds.length) return ''
  const { getDocTitlesByIds } = await import('../../database/mapper/notes/document')
  const shownIds = sourceIds.slice(0, max)
  const titles = await getDocTitlesByIds(shownIds)
  const docs = shownIds.map((id) => `[${id}] ${titles.get(id) ?? '?'}`)
  const suffix = sourceIds.length > max ? ` …(+${sourceIds.length - max})` : ''
  return mainFormat(getDocsToolTexts().graph.sourceDocsLabel, {
    docs: docs.join(getDocsToolTexts().listSeparator) + suffix
  })
}

// ============================================================================
// 搜索
// ============================================================================

export async function searchGraphHandler(params: {
  query: string
  wikiId?: number
  type?: string
  limit?: number
}): Promise<string> {
  const tr = getDocsToolTexts()
  if (!params.query?.trim()) {
    return mainFormat(tr.docs.missingParam, { param: 'query' })
  }
  const { getAllWikis, getWikiById } = await import('../../database/mapper/notes/wiki')
  const { searchEntities } = await import('../../database/mapper/notes/graph')

  const wikis = params.wikiId
    ? [await getWikiById(params.wikiId)].filter((wiki): wiki is NonNullable<typeof wiki> =>
        Boolean(wiki)
      )
    : (await getAllWikis(1, 1000)).items
  if (params.wikiId && wikis.length === 0) {
    return mainFormat(tr.wikis.notFound, { wikiId: params.wikiId })
  }

  const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? 20)))
  const query = params.query.trim()
  const lines: string[] = []
  let total = 0
  let matchedWikis = 0

  for (const wiki of wikis) {
    const entities = (await searchEntities(wiki.id, query)).filter(
      (entity) => !params.type || entity.type === params.type
    )
    if (entities.length === 0) continue
    matchedWikis++
    lines.push(
      mainFormat(tr.graph.wikiTitleLabel, {
        wikiId: wiki.id,
        title: wiki.title
      })
    )
    for (const entity of entities) {
      if (total >= limit) break
      total++
      const aliases = parseStringArray(entity.aliases)
      const aliasText = aliases.length
        ? mainFormat(tr.graph.aliasSuffix, { aliases: aliases.join(', ') })
        : ''
      const sourceText = await sourceDocsText(parseNumberArray(entity.source_note_ids))
      lines.push(
        `    [${entity.id}] [${entity.type}] ${entity.name}${aliasText}` +
          `（${confidenceText(entity.confidence)}）`
      )
      if (entity.description)
        lines.push(`      ${tr.graph.descriptionLabel}${clip(entity.description)}`)
      if (sourceText) lines.push(`      ${sourceText}`)
    }
    if (total >= limit) break
  }

  if (total === 0) return mainFormat(tr.graph.searchEmpty, { query })
  const header = [
    mainFormat(tr.graph.searchHeader, { query }),
    mainFormat(tr.graph.searchSummary, {
      count: mainPlural(tr.graph.entityCount_one, tr.graph.entityCount_other, total),
      wikis: matchedWikis
    })
  ]
  return [...header, '', ...lines].join('\n')
}

// ============================================================================
// 实体详情
// ============================================================================

export async function getGraphEntityHandler(params: {
  entityId: number
  includeRelations?: boolean
  limit?: number
}): Promise<string> {
  const tr = getDocsToolTexts()
  const { getEntityById, getRelationsByWikiId } = await import('../../database/mapper/notes/graph')
  const { getWikiById } = await import('../../database/mapper/notes/wiki')
  const entity = await getEntityById(params.entityId)
  if (!entity) return mainFormat(tr.graph.entityNotFound, { entityId: params.entityId })

  const wiki = await getWikiById(entity.wiki_id)
  const aliases = parseStringArray(entity.aliases)
  const sourceIds = parseNumberArray(entity.source_note_ids)
  const lines: string[] = [
    mainFormat(tr.graph.entityHeader, {
      entityId: entity.id,
      name: entity.name,
      wikiId: entity.wiki_id,
      wikiTitle: wiki?.title ?? ''
    }),
    mainFormat(tr.graph.entityMeta, {
      type: entity.type,
      confidence: confidenceText(entity.confidence)
    })
  ]
  if (aliases.length) {
    lines.push(mainFormat(tr.graph.aliasLine, { aliases: aliases.join(', ') }))
  }
  const sourceText = await sourceDocsText(sourceIds, 20)
  if (sourceText) lines.push(sourceText)
  const properties = entity.properties?.trim()
  if (properties)
    lines.push(mainFormat(tr.graph.propertiesLine, { properties: clip(properties, 500) }))
  if (entity.description) {
    lines.push('', tr.graph.descriptionTitle, entity.description)
  }

  if (params.includeRelations !== false) {
    const limit = Math.min(200, Math.max(1, Math.floor(params.limit ?? 50)))
    const relations = (await getRelationsByWikiId(entity.wiki_id)).filter(
      (relation) => relation.source_id === entity.id || relation.target_id === entity.id
    )
    if (relations.length === 0) {
      lines.push('', tr.graph.noRelations)
    } else {
      lines.push('', mainFormat(tr.graph.relationsHeader, { count: relations.length }))
      const shown = relations.slice(0, limit)
      for (const relation of shown) {
        const outgoing = relation.source_id === entity.id
        const otherId = outgoing ? relation.target_id : relation.source_id
        const other = await getEntityById(otherId)
        const arrow = outgoing ? '→' : '←'
        const name = other ? `[${other.id}] ${other.name}` : `[${otherId}] ?`
        const description = relation.description
          ? mainFormat(tr.graph.relationDescription, {
              description: clip(relation.description, 120)
            })
          : ''
        lines.push(
          mainFormat(tr.graph.relationLine, {
            arrow,
            type: relation.relation_type,
            peer: name,
            description
          })
        )
      }
      if (relations.length > shown.length) {
        lines.push(
          mainFormat(tr.graph.relationsTruncated, { shown: shown.length, total: relations.length })
        )
      }
    }
  }

  return lines.join('\n')
}
