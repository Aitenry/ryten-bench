/**
 * `materials_wikis` — knowledge-base domain of the materials-organization tools.
 *
 * One of the four tools the single `manage_materials` entry was split into (2026-11-28). Covers
 * knowledge bases, their directory tree, and archiving / moving documents between directories;
 * document bodies are handled by the `materials_docs_*` tools. The UI still shows one selectable
 * item (`materials-tools`).
 */
import * as z from 'zod/v4'
import { tool } from '../../ai/tools'
import type { StructuredToolInterface } from '../../ai/tools'
import {
  archiveDocsHandler,
  createDirectoryHandler,
  createWikiHandler,
  deleteDirectoryHandler,
  deleteWikiHandler,
  getDirectoryDocsHandler,
  getWikiDirectoriesHandler,
  getWikiHandler,
  listWikisHandler,
  moveDocHandler,
  removeDocHandler,
  updateDirectoryHandler,
  updateWikiHandler
} from './wikis'
import { missingParamText } from './materials-shared'

export const MATERIALS_WIKIS_TOOL = 'materials_wikis'

const COMMANDS = [
  'kb.list',
  'kb.get',
  'kb.directories',
  'kb.docs',
  'kb.create',
  'kb.update',
  'kb.delete',
  'kb.create_dir',
  'kb.rename_dir',
  'kb.delete_dir',
  'kb.archive',
  'kb.remove_doc',
  'kb.move_doc'
] as const

const DESCRIPTION = `「资料整理 · 知识库」知识库、目录树与文档归档关系（文档正文本身用 materials_docs_read / materials_docs_edit）。

  kb.list           知识库列表：page?, pageSize?
  kb.get            知识库详情：wikiId
  kb.directories    目录树（含文档数）：wikiId
  kb.docs           目录下的文档：directoryId
  kb.create         新建知识库：title, summary?, tags?
  kb.update         更新知识库：wikiId, title?, summary?, tags?
  kb.delete         删除知识库：wikiId
  kb.create_dir     新建目录：wikiId, name, parentId?
  kb.rename_dir     重命名目录：directoryId, name
  kb.delete_dir     删除目录：directoryId
  kb.archive        归档文档到目录：directoryId, docIds
  kb.remove_doc     从目录移除文档（文档本身保留）：directoryId, docId
  kb.move_doc       在同一知识库内移动文档到另一目录：docId, fromDirectoryId, toDirectoryId`

const schema = z.object({
  command: z.enum(COMMANDS).describe('Operation to run; see the tool description'),
  wikiId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('[kb.get/directories/create_dir/update/delete] Wiki ID'),
  directoryId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('[kb.docs/create_dir/rename_dir/delete_dir/archive/remove_doc] Directory ID'),
  docId: z.number().int().positive().optional().describe('[kb.remove_doc/kb.move_doc] Document ID'),
  docIds: z.array(z.number().int().positive()).optional().describe('[kb.archive] Document IDs'),
  page: z.number().int().min(1).optional().describe('[kb.list] Page number (default 1)'),
  pageSize: z.number().int().min(1).max(100).optional().describe('[kb.list] Page size'),
  title: z.string().optional().describe('[kb.create/update] Title'),
  summary: z.string().optional().describe('[kb.create/update] Summary/description'),
  tags: z.string().optional().describe('Tags as a JSON array string, e.g. \'["tag1","tag2"]\''),
  name: z.string().optional().describe('[kb.create_dir/rename_dir] Directory name'),
  parentId: z.number().int().positive().optional().describe('[kb.create_dir] Parent directory ID'),
  fromDirectoryId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('[kb.move_doc] Current directory ID'),
  toDirectoryId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('[kb.move_doc] Target directory ID (must be in the same wiki)')
})

type WikisParams = z.infer<typeof schema>

async function dispatch(params: WikisParams): Promise<string> {
  const p = params as Record<string, unknown>
  switch (params.command) {
    case 'kb.list':
      return listWikisHandler({ page: params.page, pageSize: params.pageSize })
    case 'kb.get':
      return missingParamText(p, ['wikiId']) || getWikiHandler({ wikiId: params.wikiId! })
    case 'kb.directories':
      return (
        missingParamText(p, ['wikiId']) || getWikiDirectoriesHandler({ wikiId: params.wikiId! })
      )
    case 'kb.docs':
      return (
        missingParamText(p, ['directoryId']) ||
        getDirectoryDocsHandler({ directoryId: params.directoryId! })
      )
    case 'kb.create':
      return (
        missingParamText(p, ['title']) ||
        createWikiHandler({ title: params.title!, summary: params.summary, tags: params.tags })
      )
    case 'kb.update':
      return (
        missingParamText(p, ['wikiId']) ||
        updateWikiHandler({
          wikiId: params.wikiId!,
          title: params.title,
          summary: params.summary,
          tags: params.tags
        })
      )
    case 'kb.delete':
      return missingParamText(p, ['wikiId']) || deleteWikiHandler({ wikiId: params.wikiId! })
    case 'kb.create_dir':
      return (
        missingParamText(p, ['wikiId', 'name']) ||
        createDirectoryHandler({
          wikiId: params.wikiId!,
          name: params.name!,
          parentId: params.parentId
        })
      )
    case 'kb.rename_dir':
      return (
        missingParamText(p, ['directoryId', 'name']) ||
        updateDirectoryHandler({ directoryId: params.directoryId!, name: params.name! })
      )
    case 'kb.delete_dir':
      return (
        missingParamText(p, ['directoryId']) ||
        deleteDirectoryHandler({ directoryId: params.directoryId! })
      )
    case 'kb.archive':
      return (
        missingParamText(p, ['directoryId', 'docIds']) ||
        archiveDocsHandler({ directoryId: params.directoryId!, docIds: params.docIds! })
      )
    case 'kb.remove_doc':
      return (
        missingParamText(p, ['directoryId', 'docId']) ||
        removeDocHandler({ directoryId: params.directoryId!, docId: params.docId! })
      )
    case 'kb.move_doc':
      return (
        missingParamText(p, ['docId', 'fromDirectoryId', 'toDirectoryId']) ||
        moveDocHandler({
          docId: params.docId!,
          fromDirectoryId: params.fromDirectoryId!,
          toDirectoryId: params.toDirectoryId!
        })
      )
    default:
      return `Unknown command: ${String(params.command)}`
  }
}

export function buildMaterialsWikisTool(): StructuredToolInterface {
  return tool(dispatch, {
    name: MATERIALS_WIKIS_TOOL,
    description: DESCRIPTION,
    schema
  })
}
