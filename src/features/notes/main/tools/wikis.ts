// 本工具（manage_wikis）归属 notes 插件：知识库/目录/归档文档全部走本插件的 wiki 与
// document mapper，不再跨插件直读。经 harness 的**工具贡献点**（HARNESS_TOOL_CONTRIBUTION，
// 契约见 src/main/plugins/tool-contract.ts）注册给 AI：插件未启用时 harness 拉不到这条贡献，
// 工具自然不出现在模型面前。
import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import * as z from 'zod/v4'
import { mainFormat, mainPlural } from '../../../../main/i18n'
import { getDocsToolTexts } from '../../../../main/i18n/tool-results-docs'
import type { PluginToolContribution } from '../../../../main/plugins/tool-contract'

// ============================================================================
// Wiki Handlers — 渐进式披露：列表 → 目录 → 文档
// 同时支持 CRUD：创建/编辑/删除 知识库、目录，以及文档归档/移除
// ============================================================================

// ── 查询 ──

async function listWikisHandler(): Promise<string> {
  const { getAllWikis } = await import('../db/mapper/wiki')
  const result = await getAllWikis()
  const tr = getDocsToolTexts()
  if (!result.items.length) return tr.wikis.listEmpty
  const lines = [mainFormat(tr.wikis.listHeader, { count: result.items.length })]
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

async function getWikiHandler(params: { wikiId: number }): Promise<string> {
  const { getWikiById } = await import('../db/mapper/wiki')
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

async function getWikiDirectoriesHandler(params: { wikiId: number }): Promise<string> {
  const { getWikiById, getDirectoriesByWikiId, getDocsByDirectoryId } =
    await import('../db/mapper/wiki')
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

  // sort_order 库列为可空（DEFAULT 0），null 按默认值参与排序
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

async function getDirectoryDocsHandler(params: { directoryId: number }): Promise<string> {
  const { getDocsByDirectoryId } = await import('../db/mapper/wiki')
  const { getDocById } = await import('../db/mapper/document')
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

async function createWikiHandler(params: {
  title: string
  summary?: string
  tags?: string
}): Promise<string> {
  const { addWiki } = await import('../db/mapper/wiki')
  const id = await addWiki({
    title: params.title,
    summary: params.summary ?? null,
    tags: params.tags ?? null,
    image: null
  })
  return mainFormat(getDocsToolTexts().wikis.created, { id, title: params.title })
}

async function updateWikiHandler(params: {
  wikiId: number
  title?: string
  summary?: string
  tags?: string
}): Promise<string> {
  const { updateWiki, getWikiById } = await import('../db/mapper/wiki')
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

async function deleteWikiHandler(params: { wikiId: number }): Promise<string> {
  const { deleteWiki, getWikiById } = await import('../db/mapper/wiki')
  const wiki = await getWikiById(params.wikiId)
  const tr = getDocsToolTexts()
  if (!wiki) return mainFormat(tr.wikis.notFound, { wikiId: params.wikiId })
  await deleteWiki(params.wikiId)
  return mainFormat(tr.wikis.deleted, { wikiId: params.wikiId, title: wiki.title })
}

// ── 目录 CRUD ──

async function createDirectoryHandler(params: {
  wikiId: number
  parentId?: number
  name: string
}): Promise<string> {
  const { getWikiById, addDirectory, getDirectoriesByWikiId } = await import('../db/mapper/wiki')
  const wiki = await getWikiById(params.wikiId)
  const tr = getDocsToolTexts()
  if (!wiki) return mainFormat(tr.wikis.notFound, { wikiId: params.wikiId })

  let level = 0
  if (params.parentId) {
    const dirs = await getDirectoriesByWikiId(params.wikiId)
    const parent = dirs.find((d) => d.id === params.parentId)
    if (!parent) {
      // 修复：父目录不存在/不属于本知识库时,parent_id 仍原值写入会造出跨库/悬空父节点
      return mainFormat(tr.wikis.parentNotFound, { wikiId: params.wikiId })
    }
    // level 库列为可空（DEFAULT 0），null 按 0 处理
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

async function updateDirectoryHandler(params: {
  directoryId: number
  name: string
}): Promise<string> {
  const { updateDirectory } = await import('../db/mapper/wiki')
  await updateDirectory(params.directoryId, { name: params.name })
  return mainFormat(getDocsToolTexts().wikis.directoryUpdated, {
    directoryId: params.directoryId,
    name: params.name
  })
}

async function deleteDirectoryHandler(params: { directoryId: number }): Promise<string> {
  const { deleteDirectory } = await import('../db/mapper/wiki')
  await deleteDirectory(params.directoryId)
  return mainFormat(getDocsToolTexts().wikis.directoryDeleted, { directoryId: params.directoryId })
}

// ── 文档归档 / 移除 ──

async function archiveDocsHandler(params: {
  directoryId: number
  docIds: number[]
}): Promise<string> {
  const { addDocToDirectory } = await import('../db/mapper/wiki')
  const tr = getDocsToolTexts()
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

async function removeDocHandler(params: { directoryId: number; docId: number }): Promise<string> {
  const { removeDocFromDirectory } = await import('../db/mapper/wiki')
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

// ============================================================================
// Tool Builder
// ============================================================================

export function buildManageWikisTool(): StructuredToolInterface {
  return tool(
    async ({ command, ...params }) => {
      switch (command) {
        // 查询
        case 'list':
          return listWikisHandler()
        case 'get':
          return getWikiHandler(params as Parameters<typeof getWikiHandler>[0])
        case 'directories':
          return getWikiDirectoriesHandler(
            params as unknown as Parameters<typeof getWikiDirectoriesHandler>[0]
          )
        case 'docs':
          return getDirectoryDocsHandler(
            params as unknown as Parameters<typeof getDirectoryDocsHandler>[0]
          )
        // Wiki CRUD
        case 'create':
          return createWikiHandler(params as unknown as Parameters<typeof createWikiHandler>[0])
        case 'update':
          return updateWikiHandler(params as unknown as Parameters<typeof updateWikiHandler>[0])
        case 'delete':
          return deleteWikiHandler(params as unknown as Parameters<typeof deleteWikiHandler>[0])
        // 目录 CRUD
        case 'create_directory':
          return createDirectoryHandler(
            params as unknown as Parameters<typeof createDirectoryHandler>[0]
          )
        case 'update_directory':
          return updateDirectoryHandler(
            params as unknown as Parameters<typeof updateDirectoryHandler>[0]
          )
        case 'delete_directory':
          return deleteDirectoryHandler(
            params as unknown as Parameters<typeof deleteDirectoryHandler>[0]
          )
        // 归档 / 移除
        case 'archive':
          return archiveDocsHandler(params as unknown as Parameters<typeof archiveDocsHandler>[0])
        case 'remove_doc':
          return removeDocHandler(params as unknown as Parameters<typeof removeDocHandler>[0])
        default:
          return mainFormat(getDocsToolTexts().wikis.unknownCommand, { command })
      }
    },
    {
      name: 'manage_wikis',
      description:
        'Manage wikis (progressive browsing + CRUD).\n' +
        '  Browsing commands:\n' +
        '    list - List all wikis (id, title, tags, description, document count)\n' +
        '    get - Get the details of one wiki; requires wikiId\n' +
        '    directories - Get the hierarchical directory tree of a wiki (id, name, document count); requires wikiId\n' +
        '    docs - List the documents in a directory (id, title, tags, description); requires directoryId\n' +
        '  Wiki CRUD:\n' +
        '    create - Create a wiki; requires title, optional summary, tags\n' +
        '    update - Update a wiki; requires wikiId, optional title, summary, tags\n' +
        '    delete - Delete a wiki; requires wikiId\n' +
        '  Directory CRUD:\n' +
        '    create_directory - Create a directory; requires wikiId, name, optional parentId (parent directory ID)\n' +
        '    update_directory - Rename a directory; requires directoryId, name\n' +
        '    delete_directory - Delete a directory; requires directoryId\n' +
        '  Document management:\n' +
        '    archive - Archive documents into a directory; requires directoryId, docIds (array of document IDs)\n' +
        '    remove_doc - Remove a document from a directory (the document itself is kept); requires directoryId, docId\n' +
        '  Typical workflow: list → get → directories → docs, then use the manage_docs tool with the returned docId to read document content.',
      schema: z.object({
        command: z
          .enum([
            'list',
            'get',
            'directories',
            'docs',
            'create',
            'update',
            'delete',
            'create_directory',
            'update_directory',
            'delete_directory',
            'archive',
            'remove_doc'
          ])
          .describe('Operation type'),
        wikiId: z.number().optional().describe('[get/directories/create_directory] Wiki ID'),
        directoryId: z
          .number()
          .optional()
          .describe('[docs/archive/remove_doc/update_directory/delete_directory] Directory ID'),
        title: z.string().optional().describe('[create/update] Wiki title'),
        summary: z.string().optional().describe('[create/update] Wiki description'),
        tags: z
          .string()
          .optional()
          .describe('[create/update] Wiki tags (JSON array string, e.g. \'["tag1","tag2"]\')'),
        name: z.string().optional().describe('[create_directory/update_directory] Directory name'),
        parentId: z
          .number()
          .optional()
          .describe('[create_directory] Parent directory ID (used when creating a subdirectory)'),
        docIds: z.array(z.number()).optional().describe('[archive] Document IDs to archive'),
        docId: z.number().optional().describe('[remove_doc] Document ID to remove')
      })
    }
  )
}

// ============================================================================
// Harness 工具贡献
// ============================================================================

/** 本插件贡献给 harness 的 AI 工具（由 main/index.ts 经 ctx.contribute 注册） */
export const wikiToolContributions: PluginToolContribution[] = [
  {
    name: 'manage_wikis',
    info: {
      name: 'manage_wikis',
      label: 'Knowledge base',
      description: 'Browse and manage knowledge bases, folders and archived documents',
      icon: 'RiBook2Line',
      color: '#13c2c2'
    },
    build: buildManageWikisTool
  }
]
