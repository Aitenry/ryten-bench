// Knowledge base domain handlers (dispatched uniformly by the manage_materials tool): knowledge
// bases, directories and archived documents all go through notes' own wiki and document mappers,
// no longer reading across domains.
import { mainFormat, mainPlural } from '../../i18n'
import { getDocsToolTexts } from '../../i18n/tool-results-docs'

// ============================================================================
// Wiki Handlers — progressive disclosure: list → directory → document
// Also supports CRUD: create/edit/delete knowledge bases and directories, plus document
// archiving/removal
// ============================================================================

// ── Queries ──

export async function listWikisHandler(
  params: {
    page?: number
    pageSize?: number
  } = {}
): Promise<string> {
  const { getAllWikis } = await import('../../database/mapper/notes/wiki')
  const page = Math.max(1, Math.floor(params.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 20)))
  const result = await getAllWikis(page, pageSize)
  const tr = getDocsToolTexts()
  if (!result.items.length) return tr.wikis.listEmpty
  const lines = [mainFormat(tr.wikis.listHeader, { count: result.total })]
  const pages = Math.max(1, Math.ceil(result.total / pageSize))
  if (pages > 1) {
    lines.push(mainFormat(tr.wikis.listPage, { page, pages, total: result.total }))
  }
  for (const wiki of result.items) {
    lines.push(`  [${wiki.id}] **${wiki.title}**`)
    if (wiki.tags) {
      const tagList = JSON.parse(wiki.tags) as string[]
      lines.push(`    ${mainFormat(tr.wikis.tagsLabel, { tags: tagList.join(tr.listSeparator) })}`)
    }
    if (wiki.summary) {
      lines.push(`    ${mainFormat(tr.wikis.descriptionLabel, { summary: wiki.summary })}`)
    }
    lines.push(`    ${mainFormat(tr.wikis.docCountLabel, { count: wiki.doc_count })}`)
    lines.push('')
  }
  return lines.join('\n')
}

export async function getWikiHandler(params: { wikiId: number }): Promise<string> {
  const { getWikiById } = await import('../../database/mapper/notes/wiki')
  const wiki = await getWikiById(params.wikiId)
  const tr = getDocsToolTexts()
  if (!wiki) return mainFormat(tr.wikis.notFound, { wikiId: params.wikiId })
  const tags = wiki.tags
    ? `\n${mainFormat(tr.wikis.wikiTagsLabel, {
        tags: (JSON.parse(wiki.tags) as string[]).join(tr.listSeparator)
      })}`
    : ''
  const summary = wiki.summary
    ? `\n${mainFormat(tr.wikis.wikiDescriptionLabel, { summary: wiki.summary })}`
    : ''
  const image = wiki.image ? `\n${tr.wikis.wikiHasImage}` : ''
  return `**${wiki.title}**[${wiki.id}]${tags}${summary}\n${mainFormat(tr.wikis.docTotalLabel, {
    count: wiki.doc_count
  })}${image}\n${mainFormat(tr.wikis.createdAtLabel, {
    createdAt: wiki.created_at
  })}\n${mainFormat(tr.wikis.updatedAtLabel, { updatedAt: wiki.updated_at })}`
}

export async function getWikiDirectoriesHandler(params: { wikiId: number }): Promise<string> {
  const { getWikiById, getDirectoriesByWikiId, getDocsByDirectoryId } =
    await import('../../database/mapper/notes/wiki')
  const wiki = await getWikiById(params.wikiId)
  const tr = getDocsToolTexts()
  if (!wiki) return mainFormat(tr.wikis.notFound, { wikiId: params.wikiId })
  const directories = await getDirectoriesByWikiId(params.wikiId)
  if (!directories.length) return mainFormat(tr.wikis.directoriesEmpty, { title: wiki.title })

  const docCountMap = new Map<number, number>()
  await Promise.all(
    directories.map(async (dir) => {
      const docs = await getDocsByDirectoryId(dir.id)
      docCountMap.set(dir.id, docs.length)
    })
  )

  // The sort_order column is nullable (DEFAULT 0); null participates in sorting as the default
  const sorted = [...directories].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  interface DirNode {
    id: number
    name: string
    parent_id: number | null
    doc_count: number
    children: DirNode[]
  }

  const nodeMap = new Map<number, DirNode>()
  for (const d of sorted) {
    nodeMap.set(d.id, {
      id: d.id,
      name: d.name,
      parent_id: d.parent_id,
      doc_count: docCountMap.get(d.id) ?? 0,
      children: []
    })
  }
  const roots: DirNode[] = []
  for (const node of nodeMap.values()) {
    if (node.parent_id !== null && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const lines = [
    mainFormat(tr.wikis.directoriesHeader, {
      title: wiki.title,
      count: mainPlural(
        tr.wikis.directoryCount_one,
        tr.wikis.directoryCount_other,
        directories.length
      )
    })
  ]

  function render(node: DirNode, depth: number, isLast: boolean): void {
    const indent = '  '.repeat(depth)
    const branch = depth > 0 ? (isLast ? '  └─ ' : '  ├─ ') : ''
    const countStr =
      node.doc_count > 0
        ? mainFormat(tr.wikis.directoryDocCount, { count: node.doc_count })
        : tr.wikis.directoryEmpty
    lines.push(`${indent}${branch}[${node.id}] ${node.name} ${countStr}`)
    for (let i = 0; i < node.children.length; i++) {
      render(node.children[i], depth + 1, i === node.children.length - 1)
    }
  }

  for (let i = 0; i < roots.length; i++) {
    render(roots[i], 1, i === roots.length - 1)
  }

  return lines.join('\n')
}

export async function getDirectoryDocsHandler(params: { directoryId: number }): Promise<string> {
  const { getDocsByDirectoryId } = await import('../../database/mapper/notes/wiki')
  const { getDocById } = await import('../../database/mapper/notes/document')
  const docRefs = await getDocsByDirectoryId(params.directoryId)
  const tr = getDocsToolTexts()
  if (!docRefs.length) return tr.wikis.directoryDocsEmpty
  const docs = await Promise.all(docRefs.map((ref) => getDocById(ref.doc_id)))
  const validDocs = docs.filter((d): d is NonNullable<typeof d> => d !== null)
  const lines = [mainFormat(tr.wikis.directoryDocsHeader, { count: validDocs.length })]
  for (const doc of validDocs) {
    lines.push(`  [${doc.id}] **${doc.title}**`)
    if (doc.tags) {
      const tagList = JSON.parse(doc.tags) as string[]
      lines.push(
        `    ${mainFormat(tr.wikis.docTagsLabel, { tags: tagList.join(tr.listSeparator) })}`
      )
    }
    if (doc.summary) {
      lines.push(`    ${mainFormat(tr.wikis.docDescriptionLabel, { summary: doc.summary })}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ── Wiki CRUD ──

export async function createWikiHandler(params: {
  title: string
  summary?: string
  tags?: string
}): Promise<string> {
  const { addWiki } = await import('../../database/mapper/notes/wiki')
  const id = await addWiki({
    title: params.title,
    summary: params.summary ?? null,
    tags: params.tags ?? null,
    image: null
  })
  return mainFormat(getDocsToolTexts().wikis.created, { id, title: params.title })
}

export async function updateWikiHandler(params: {
  wikiId: number
  title?: string
  summary?: string
  tags?: string
}): Promise<string> {
  const { updateWiki, getWikiById } = await import('../../database/mapper/notes/wiki')
  const wiki = await getWikiById(params.wikiId)
  const tr = getDocsToolTexts()
  if (!wiki) return mainFormat(tr.wikis.notFound, { wikiId: params.wikiId })

  const updates: Record<string, string | null> = {}
  if (params.title !== undefined) updates.title = params.title
  if (params.summary !== undefined) updates.summary = params.summary
  if (params.tags !== undefined) updates.tags = params.tags

  if (Object.keys(updates).length === 0) return tr.wikis.noFieldsToUpdate

  await updateWiki(params.wikiId, updates)
  return mainFormat(tr.wikis.updated, { wikiId: params.wikiId, title: wiki.title })
}

export async function deleteWikiHandler(params: { wikiId: number }): Promise<string> {
  const { deleteWiki, getWikiById } = await import('../../database/mapper/notes/wiki')
  const wiki = await getWikiById(params.wikiId)
  const tr = getDocsToolTexts()
  if (!wiki) return mainFormat(tr.wikis.notFound, { wikiId: params.wikiId })
  await deleteWiki(params.wikiId)
  return mainFormat(tr.wikis.deleted, { wikiId: params.wikiId, title: wiki.title })
}

// ── Directory CRUD ──

export async function createDirectoryHandler(params: {
  wikiId: number
  parentId?: number
  name: string
}): Promise<string> {
  const { getWikiById, addDirectory, getDirectoriesByWikiId } =
    await import('../../database/mapper/notes/wiki')
  const wiki = await getWikiById(params.wikiId)
  const tr = getDocsToolTexts()
  if (!wiki) return mainFormat(tr.wikis.notFound, { wikiId: params.wikiId })

  let level = 0
  if (params.parentId) {
    const dirs = await getDirectoriesByWikiId(params.wikiId)
    const parent = dirs.find((d) => d.id === params.parentId)
    if (!parent) {
      // Fix: if the parent directory does not exist or belongs to another knowledge base, writing
      // parent_id as-is would create a cross-wiki or dangling parent node
      return mainFormat(tr.wikis.parentNotFound, { wikiId: params.wikiId })
    }
    // The level column is nullable (DEFAULT 0); null is treated as 0
    level = (parent.level ?? 0) + 1
  }

  const id = await addDirectory({
    wiki_id: params.wikiId,
    parent_id: params.parentId ?? null,
    name: params.name,
    sort_order: 0,
    level
  })
  return mainFormat(tr.wikis.directoryCreated, {
    id,
    name: params.name,
    wikiTitle: wiki.title
  })
}

export async function updateDirectoryHandler(params: {
  directoryId: number
  name: string
}): Promise<string> {
  const { updateDirectory } = await import('../../database/mapper/notes/wiki')
  await updateDirectory(params.directoryId, { name: params.name })
  return mainFormat(getDocsToolTexts().wikis.directoryUpdated, {
    directoryId: params.directoryId,
    name: params.name
  })
}

export async function deleteDirectoryHandler(params: { directoryId: number }): Promise<string> {
  const { deleteDirectory } = await import('../../database/mapper/notes/wiki')
  await deleteDirectory(params.directoryId)
  return mainFormat(getDocsToolTexts().wikis.directoryDeleted, { directoryId: params.directoryId })
}

// ── Document archiving / removal ──

export async function archiveDocsHandler(params: {
  directoryId: number
  docIds: number[]
}): Promise<string> {
  const { addDocToDirectory } = await import('../../database/mapper/notes/wiki')
  const tr = getDocsToolTexts()
  if (!params.docIds.length) return tr.wikis.archiveEmpty
  const results: string[] = []
  for (const docId of params.docIds) {
    try {
      await addDocToDirectory(params.directoryId, docId)
      results.push(mainFormat(tr.wikis.archivedDoc, { docId }))
    } catch {
      results.push(mainFormat(tr.wikis.archiveFailedDoc, { docId }))
    }
  }
  return mainFormat(tr.wikis.archiveDone, { results: results.join('\n') })
}

export async function removeDocHandler(params: {
  directoryId: number
  docId: number
}): Promise<string> {
  const { removeDocFromDirectory } = await import('../../database/mapper/notes/wiki')
  const ok = await removeDocFromDirectory(params.directoryId, params.docId)
  const tr = getDocsToolTexts()
  return ok
    ? mainFormat(tr.wikis.docRemoved, {
        docId: params.docId,
        directoryId: params.directoryId
      })
    : mainFormat(tr.wikis.removeFailed, {
        docId: params.docId,
        directoryId: params.directoryId
      })
}

/**
 * Move a document from one directory to another (within the same knowledge base).
 *
 * Combines the two atomic operations remove + archive: if writing the target fails, the source
 * association is restored, so the document does not disappear from the knowledge base when "the
 * source was removed but the target was not written".
 */
export async function moveDocHandler(params: {
  docId: number
  fromDirectoryId: number
  toDirectoryId: number
}): Promise<string> {
  const { getDirectoryById, removeDocFromDirectory, addDocToDirectory } =
    await import('../../database/mapper/notes/wiki')
  const tr = getDocsToolTexts()
  const [from, to] = await Promise.all([
    getDirectoryById(params.fromDirectoryId),
    getDirectoryById(params.toDirectoryId)
  ])
  if (!from || !to) {
    return mainFormat(tr.wikis.directoryNotFound, {
      ids: [from ? '' : params.fromDirectoryId, to ? '' : params.toDirectoryId]
        .filter(Boolean)
        .join(', ')
    })
  }
  if (from.wiki_id !== to.wiki_id) return tr.wikis.moveCrossWiki

  const removed = await removeDocFromDirectory(params.fromDirectoryId, params.docId)
  if (!removed) {
    return mainFormat(tr.wikis.moveNotInSource, {
      docId: params.docId,
      fromDirectoryId: params.fromDirectoryId
    })
  }
  try {
    await addDocToDirectory(params.toDirectoryId, params.docId)
  } catch {
    // Writing the target failed (usually the same document already exists there): restore the
    // source association
    await addDocToDirectory(params.fromDirectoryId, params.docId).catch(() => undefined)
    return mainFormat(tr.wikis.moveFailed, {
      docId: params.docId,
      toDirectoryId: params.toDirectoryId
    })
  }
  return mainFormat(tr.wikis.moved, {
    docId: params.docId,
    fromDirectoryId: params.fromDirectoryId,
    toDirectoryId: params.toDirectoryId
  })
}
