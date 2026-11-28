// Graph domain handlers (dispatched by the materials_graph tool).
//
// 2026-11 materials organization rework:
// - Search no longer returns only "names": it adds entity ID, type, aliases, confidence and source
//   documents, so after getting results the model can open the source via doc.get or inspect
//   relations via graph.entity;
// - Fix for "only the first 10 knowledge bases are searched": getAllWikis defaults to pageSize=10
//   and the old implementation passed no arguments, so the 11th and later knowledge bases could
//   never be found;
// - New graph.entity: entity details + incoming/outgoing relations + source documents, completing
//   the "what to do after a graph lookup" step.
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
// Search
// ============================================================================

export async function searchGraphHandler(params: {
  query?: string
  wikiId?: number
  type?: string
  limit?: number
}): Promise<string> {
  const tr = getDocsToolTexts()
  // Like materials_docs_search: an omitted / blank query lists entities (across the selected wiki
  // or all wikis) instead of failing with "missing query". The mapper matches everything on an
  // empty pattern, so no separate list query is needed.
  const query = params.query?.trim() ?? ''
  const isList = query === ''
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

  if (total === 0) {
    return isList ? tr.graph.listEmpty : mainFormat(tr.graph.searchEmpty, { query })
  }
  const header = [
    isList ? tr.graph.listHeader : mainFormat(tr.graph.searchHeader, { query }),
    mainFormat(tr.graph.searchSummary, {
      count: mainPlural(tr.graph.entityCount_one, tr.graph.entityCount_other, total),
      wikis: matchedWikis
    })
  ]
  return [...header, '', ...lines].join('\n')
}

// ============================================================================
// Entity details
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
