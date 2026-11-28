/**
 * "Materials organization" unified tool (manage_materials) — consolidates the previously separate
 * manage_docs / manage_todos / manage_wikis / search_graph tools into **one entry point**.
 *
 * Why consolidate (user feedback, 2026-11):
 * - The four entries in the tool dropdown each owned a slice, so users and the model both had to
 *   guess "which tool should handle this task";
 * - Document editing only had whole-document update, so changing one line still required
 *   rewriting the whole text — the granularity was too coarse;
 * - Graph search returned only names, no IDs, so after a hit you could not open the source
 *   document or inspect relations.
 *
 * Now: one tool, domains split by command; document reads return line numbers and the revision,
 * and support precise edits by line / in-line column range / text fragment, while writes can
 * carry expectedRevision / expectedOld / dryRun.
 * Old tool names are migrated to manage_materials (see LEGACY_TOOL_ALIASES in
 * shared/harness/mcp.ts).
 */
import { mainFormat } from '../../i18n'
import { getDocsToolTexts } from '../../i18n/tool-results-docs'
import { tool } from '../../ai/tools'
import type { StructuredToolInterface } from '../../ai/tools'
import * as z from 'zod/v4'
import type { PluginToolContribution } from '../../plugins/tool-contract'
import type { DocEdit } from './doc-edit'
import {
  createDocHandler,
  deleteDocHandler,
  deleteDocLinesHandler,
  deleteDocRangeHandler,
  findInDocHandler,
  getDocHandler,
  getDocTocHandler,
  insertDocTextHandler,
  patchDocHandler,
  replaceDocLinesHandler,
  replaceDocRangeHandler,
  replaceDocTextHandler,
  searchDocsHandler,
  updateDocHandler
} from './docs'
import {
  addTodoHandler,
  bulkUpdateTodosHandler,
  deleteTodoHandler,
  getTodoHandler,
  listTodosHandler,
  updateTodoHandler
} from './todos'
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
import { getGraphEntityHandler, searchGraphHandler } from './graph'

/** Unified tool name (old-name migration: see shared/harness/mcp.ts) */
export const MANAGE_MATERIALS_TOOL = 'manage_materials'

const COMMANDS = [
  // Document reads
  'doc.search',
  'doc.toc',
  'doc.get',
  'doc.find',
  // Document writes
  'doc.create',
  'doc.update',
  'doc.delete',
  'doc.replace_lines',
  'doc.replace_text',
  'doc.replace_range',
  'doc.insert',
  'doc.delete_lines',
  'doc.delete_range',
  'doc.patch',
  // To-dos
  'todo.list',
  'todo.get',
  'todo.add',
  'todo.update',
  'todo.bulk_update',
  'todo.delete',
  // Knowledge bases
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
  'kb.move_doc',
  // Graph
  'graph.search',
  'graph.entity'
] as const

const COMMAND_DESCRIPTION = `「资料整理」统一入口：文档 / 待办 / 知识库 / 知识图谱。

【文档读取】
  doc.search        全文搜索文档（标题/摘要/标签/正文）：query, page?, pageSize?
  doc.toc           标题树，带行号与 revision：docId
  doc.get           读取正文（默认带行号并返回 revision）：docId, headingId? 或 startLine?/endLine?, maxChars?
  doc.find          文档内查找，返回行/列（码点）与上下文：docId, query, regex?, caseSensitive?, contextLines?, maxMatches?
【文档写入】
  doc.create        新建：title, summary?, tags?(JSON 字符串), content?
  doc.update        整篇或元数据更新：docId, title?, summary?, tags?, content?, expectedRevision?
  doc.delete        删除（不可恢复）：docId
  doc.replace_lines 替换整行区间：docId, startLine, endLine, newText（空串=删除这些行）, expectedOld?
  doc.replace_text  替换文本片段：docId, oldText, newText, all?/occurrence?, startLine?/endLine?, regex?, caseSensitive?
  doc.replace_range 替换一行内的列区间：docId, line, startColumn?, endColumn?, newText, expectedOld?
  doc.insert        插入文本：docId, position(at|before|after|start|end), line?, column?, newText
  doc.delete_lines  删除整行区间：docId, startLine, endLine, expectedOld?
  doc.delete_range  删除行内列区间：docId, line, startColumn?, endColumn?, expectedOld?
  doc.patch         批量编辑（原子）：docId, edits:[{type,...}], expectedRevision?, dryRun?
【待办】0=P0 最高 … 7=P7 最低；status: 0=待办/1=进行中/2=已完成
  todo.list         列表：status?, priority?, category?, query?, includeDone?, page?, pageSize?
  todo.get          详情（含正文与时间戳）：todoId
  todo.add          新建：title, content?, priority?, due_date?(YYYY-MM-DD), category?
  todo.update       更新：todoId, title?, content?, status?, priority?, due_date?, category?
  todo.bulk_update  批量更新：ids, status?, priority?, due_date?, category?
  todo.delete       删除：todoId
【知识库】
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
  kb.move_doc       在同一知识库内移动文档到另一目录：docId, fromDirectoryId, toDirectoryId
【图谱】
  graph.search      搜索实体（返回实体 ID/类型/别名/置信度/来源文档）：query, wikiId?, type?, limit?
  graph.entity      实体详情 + 出入关系 + 来源文档：entityId, includeRelations?, limit?

文档精修推荐流程：doc.get（记下 revision 与行号）→ doc.find 定位 → doc.replace_lines / doc.replace_text /
doc.replace_range（带 expectedOld 更稳）；多处修改用 doc.patch 一次提交（按顺序应用，行号指上一处编辑后的状态）。
所有细粒度编辑（replace_*/insert/delete_*/patch）支持 dryRun=true 只预览；写操作可带 expectedRevision
（doc.get/doc.find 返回），不一致会拒绝写入，避免覆盖编辑器或其它工具的并发修改。行号、列号都从 1 开始；
列按 Unicode 字符计。`

const docEditSchema = z.object({
  type: z
    .enum([
      'replace_lines',
      'replace_text',
      'replace_range',
      'insert',
      'delete_lines',
      'delete_range'
    ])
    .describe(
      'Edit type. replace_lines: startLine/endLine/newText; replace_text: oldText/newText (+all/occurrence/startLine/endLine); replace_range: line/startColumn/endColumn/newText; insert: position/line/column/newText; delete_lines: startLine/endLine; delete_range: line/startColumn/endColumn'
    ),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[replace_lines/delete_lines/replace_text] First line (1-based)'),
  endLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[replace_lines/delete_lines/replace_text] Last line (1-based, inclusive)'),
  line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[replace_range/delete_range/insert] Target line (1-based)'),
  startColumn: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[replace_range/delete_range] First character (1-based)'),
  endColumn: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[replace_range/delete_range] Last character (1-based, inclusive)'),
  position: z
    .enum(['at', 'before', 'after', 'start', 'end'])
    .optional()
    .describe(
      '[insert] at=inside line at column; before/after=insert whole line(s); start/end=document start/end'
    ),
  oldText: z.string().optional().describe('[replace_text] Exact text to find'),
  newText: z
    .string()
    .optional()
    .describe('Replacement/inserted text (may contain newlines; empty deletes, but do not omit)'),
  expectedOld: z
    .string()
    .optional()
    .describe('Optional exact current text of the edited range; mismatches abort the edit'),
  all: z.boolean().optional().describe('[replace_text] Replace all matches'),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[replace_text] Replace only the Nth match')
})

const schema = z.object({
  command: z
    .enum(COMMANDS)
    .describe('Operation to run; see the tool description for the command list'),
  // ── IDs ──
  docId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('[doc.*/kb.remove_doc/kb.move_doc] Document ID'),
  todoId: z.number().int().positive().optional().describe('[todo.get/update/delete] Todo ID'),
  wikiId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('[kb.get/directories/create_dir/update/delete/graph.search] Wiki ID'),
  directoryId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('[kb.docs/create_dir/rename_dir/delete_dir/archive/remove_doc] Directory ID'),
  entityId: z.number().int().positive().optional().describe('[graph.entity] Entity ID'),
  ids: z.array(z.number().int().positive()).optional().describe('[todo.bulk_update] Todo IDs'),
  docIds: z.array(z.number().int().positive()).optional().describe('[kb.archive] Document IDs'),
  // ── Queries / pagination ──
  query: z.string().optional().describe('[doc.search/doc.find/todo.list/graph.search] Search text'),
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[doc.search/kb.list/todo.list] Page number (default 1)'),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('[doc.search/kb.list/todo.list] Page size'),
  headingId: z.string().optional().describe('[doc.get] Heading ID from doc.toc (e.g. h-2)'),
  startLine: z.number().int().min(1).optional().describe('[doc.get/edit] Start line (1-based)'),
  endLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[doc.get/edit] End line (1-based, inclusive)'),
  maxChars: z
    .number()
    .int()
    .min(1000)
    .max(200000)
    .optional()
    .describe('[doc.get] Max output characters (default 30000)'),
  maxMatches: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('[doc.find] Max matches to show (default 20)'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe('[doc.find] Context lines around each match'),
  regex: z
    .boolean()
    .optional()
    .describe('[doc.find/doc.replace_text] Treat query/oldText as a regular expression'),
  caseSensitive: z
    .boolean()
    .optional()
    .describe('[doc.find/doc.replace_text] Case-sensitive search (default false)'),
  // ── Document content / editing ──
  title: z
    .string()
    .optional()
    .describe('[doc.create/update, todo.add/update, kb.create/update] Title'),
  summary: z
    .string()
    .optional()
    .describe('[doc.create/update, kb.create/update] Summary/description'),
  tags: z.string().optional().describe('Tags as a JSON array string, e.g. \'["tag1","tag2"]\''),
  content: z
    .string()
    .optional()
    .describe('[doc.create/update, todo.add/update] Full body content (Markdown)'),
  oldText: z.string().optional().describe('[doc.replace_text] Exact text to find'),
  newText: z
    .string()
    .optional()
    .describe(
      '[doc.replace_*/insert] Replacement or inserted text; pass an empty string to delete, but do not omit it'
    ),
  all: z.boolean().optional().describe('[doc.replace_text] Replace all matches'),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[doc.replace_text] Replace only the Nth match'),
  line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[doc.replace_range/delete_range/insert] Target line (1-based)'),
  startColumn: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[doc.replace_range/delete_range] First character (1-based)'),
  endColumn: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[doc.replace_range/delete_range] Last character (1-based, inclusive)'),
  column: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('[doc.insert] Insertion column (1-based; line length+1 appends)'),
  position: z
    .enum(['at', 'before', 'after', 'start', 'end'])
    .optional()
    .describe(
      '[doc.insert] at=inside line at column; before/after=insert whole line(s); start/end=document start/end'
    ),
  expectedOld: z
    .string()
    .optional()
    .describe(
      '[doc.replace_*/delete_*] Optional exact current text of the range; mismatches abort'
    ),
  expectedRevision: z
    .string()
    .optional()
    .describe(
      '[doc.edit/update/patch] Revision from doc.get/doc.find; mismatches abort to avoid overwriting concurrent edits'
    ),
  dryRun: z.boolean().optional().describe('[doc.edit/patch] Preview only, do not write'),
  edits: z
    .array(docEditSchema)
    .optional()
    .describe(
      '[doc.patch] Ordered edits (line numbers refer to the document after previous edits)'
    ),
  // ── To-dos ──
  status: z
    .number()
    .int()
    .min(0)
    .max(2)
    .optional()
    .describe('[todo.list/update/bulk_update] 0=todo, 1=in progress, 2=done'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(7)
    .optional()
    .describe('[todo] 0=P0 (highest) … 7=P7 (lowest)'),
  due_date: z.string().nullable().optional().describe('[todo] Due date YYYY-MM-DD; null clears'),
  category: z.string().nullable().optional().describe('[todo] Category; null clears'),
  includeDone: z
    .boolean()
    .optional()
    .describe('[todo.list] Include completed items (default true)'),
  // ── Knowledge bases ──
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
    .describe('[kb.move_doc] Target directory ID (must be in the same wiki)'),
  // ── Graph ──
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

function missing(params: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = params[name]
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      return mainFormat(getDocsToolTexts().docs.missingParam, { param: name })
    }
  }
  return null
}

type MaterialParams = z.infer<typeof schema>

async function dispatch(params: MaterialParams): Promise<string> {
  const p: Record<string, unknown> = params
  const command = params.command
  switch (command) {
    // ── Document reads ──
    case 'doc.search':
      return (
        missing(p, ['query']) ||
        searchDocsHandler({ query: params.query!, page: params.page, pageSize: params.pageSize })
      )
    case 'doc.toc':
      return missing(p, ['docId']) || getDocTocHandler({ docId: params.docId! })
    case 'doc.get':
      return (
        missing(p, ['docId']) ||
        getDocHandler({
          docId: params.docId!,
          headingId: params.headingId,
          startLine: params.startLine,
          endLine: params.endLine,
          maxChars: params.maxChars
        })
      )
    case 'doc.find':
      return (
        missing(p, ['docId', 'query']) ||
        findInDocHandler({
          docId: params.docId!,
          query: params.query!,
          regex: params.regex,
          caseSensitive: params.caseSensitive,
          maxMatches: params.maxMatches,
          contextLines: params.contextLines
        })
      )
    // ── Document writes ──
    case 'doc.create':
      return (
        missing(p, ['title']) ||
        createDocHandler({
          title: params.title!,
          summary: params.summary,
          tags: params.tags,
          content: params.content
        })
      )
    case 'doc.update':
      return (
        missing(p, ['docId']) ||
        updateDocHandler({
          docId: params.docId!,
          title: params.title,
          summary: params.summary,
          tags: params.tags,
          content: params.content,
          expectedRevision: params.expectedRevision
        })
      )
    case 'doc.delete':
      return missing(p, ['docId']) || deleteDocHandler({ docId: params.docId! })
    case 'doc.replace_lines':
      return (
        missing(p, ['docId', 'startLine', 'endLine']) ||
        replaceDocLinesHandler({
          docId: params.docId,
          startLine: params.startLine,
          endLine: params.endLine,
          newText: params.newText,
          expectedOld: params.expectedOld,
          expectedRevision: params.expectedRevision,
          dryRun: params.dryRun
        })
      )
    case 'doc.replace_text':
      return (
        missing(p, ['docId', 'oldText']) ||
        replaceDocTextHandler({
          docId: params.docId,
          oldText: params.oldText,
          newText: params.newText,
          all: params.all,
          occurrence: params.occurrence,
          startLine: params.startLine,
          endLine: params.endLine,
          regex: params.regex,
          caseSensitive: params.caseSensitive,
          expectedRevision: params.expectedRevision,
          dryRun: params.dryRun
        })
      )
    case 'doc.replace_range':
      return (
        missing(p, ['docId', 'line']) ||
        replaceDocRangeHandler({
          docId: params.docId,
          line: params.line,
          startColumn: params.startColumn,
          endColumn: params.endColumn,
          newText: params.newText,
          expectedOld: params.expectedOld,
          expectedRevision: params.expectedRevision,
          dryRun: params.dryRun
        })
      )
    case 'doc.insert':
      return (
        missing(p, ['docId', 'newText']) ||
        insertDocTextHandler({
          docId: params.docId,
          position: params.position,
          line: params.line,
          column: params.column,
          newText: params.newText,
          expectedRevision: params.expectedRevision,
          dryRun: params.dryRun
        })
      )
    case 'doc.delete_lines':
      return (
        missing(p, ['docId', 'startLine', 'endLine']) ||
        deleteDocLinesHandler({
          docId: params.docId,
          startLine: params.startLine,
          endLine: params.endLine,
          expectedOld: params.expectedOld,
          expectedRevision: params.expectedRevision,
          dryRun: params.dryRun
        })
      )
    case 'doc.delete_range':
      return (
        missing(p, ['docId', 'line']) ||
        deleteDocRangeHandler({
          docId: params.docId,
          line: params.line,
          startColumn: params.startColumn,
          endColumn: params.endColumn,
          expectedOld: params.expectedOld,
          expectedRevision: params.expectedRevision,
          dryRun: params.dryRun
        })
      )
    case 'doc.patch':
      return (
        missing(p, ['docId']) ||
        patchDocHandler({
          docId: params.docId,
          edits: params.edits as unknown as DocEdit[],
          expectedRevision: params.expectedRevision,
          dryRun: params.dryRun
        })
      )
    // ── To-dos ──
    case 'todo.list':
      return listTodosHandler({
        status: params.status,
        priority: params.priority,
        category: params.category ?? undefined,
        query: params.query,
        includeDone: params.includeDone,
        page: params.page,
        pageSize: params.pageSize
      })
    case 'todo.get':
      return missing(p, ['todoId']) || getTodoHandler({ todoId: params.todoId! })
    case 'todo.add':
      return (
        missing(p, ['title']) ||
        addTodoHandler({
          title: params.title!,
          content: params.content,
          priority: params.priority,
          due_date: params.due_date,
          category: params.category
        })
      )
    case 'todo.update':
      return (
        missing(p, ['todoId']) ||
        updateTodoHandler({
          todoId: params.todoId!,
          title: params.title,
          content: params.content,
          status: params.status,
          priority: params.priority,
          due_date: params.due_date,
          category: params.category
        })
      )
    case 'todo.bulk_update':
      return (
        missing(p, ['ids']) ||
        bulkUpdateTodosHandler({
          ids: params.ids!,
          status: params.status,
          priority: params.priority,
          due_date: params.due_date,
          category: params.category
        })
      )
    case 'todo.delete':
      return missing(p, ['todoId']) || deleteTodoHandler({ todoId: params.todoId! })
    // ── Knowledge bases ──
    case 'kb.list':
      return listWikisHandler({ page: params.page, pageSize: params.pageSize })
    case 'kb.get':
      return missing(p, ['wikiId']) || getWikiHandler({ wikiId: params.wikiId! })
    case 'kb.directories':
      return missing(p, ['wikiId']) || getWikiDirectoriesHandler({ wikiId: params.wikiId! })
    case 'kb.docs':
      return (
        missing(p, ['directoryId']) || getDirectoryDocsHandler({ directoryId: params.directoryId! })
      )
    case 'kb.create':
      return (
        missing(p, ['title']) ||
        createWikiHandler({ title: params.title!, summary: params.summary, tags: params.tags })
      )
    case 'kb.update':
      return (
        missing(p, ['wikiId']) ||
        updateWikiHandler({
          wikiId: params.wikiId!,
          title: params.title,
          summary: params.summary,
          tags: params.tags
        })
      )
    case 'kb.delete':
      return missing(p, ['wikiId']) || deleteWikiHandler({ wikiId: params.wikiId! })
    case 'kb.create_dir':
      return (
        missing(p, ['wikiId', 'name']) ||
        createDirectoryHandler({
          wikiId: params.wikiId!,
          name: params.name!,
          parentId: params.parentId
        })
      )
    case 'kb.rename_dir':
      return (
        missing(p, ['directoryId', 'name']) ||
        updateDirectoryHandler({ directoryId: params.directoryId!, name: params.name! })
      )
    case 'kb.delete_dir':
      return (
        missing(p, ['directoryId']) || deleteDirectoryHandler({ directoryId: params.directoryId! })
      )
    case 'kb.archive':
      return (
        missing(p, ['directoryId', 'docIds']) ||
        archiveDocsHandler({ directoryId: params.directoryId!, docIds: params.docIds! })
      )
    case 'kb.remove_doc':
      return (
        missing(p, ['directoryId', 'docId']) ||
        removeDocHandler({ directoryId: params.directoryId!, docId: params.docId! })
      )
    case 'kb.move_doc':
      return (
        missing(p, ['docId', 'fromDirectoryId', 'toDirectoryId']) ||
        moveDocHandler({
          docId: params.docId!,
          fromDirectoryId: params.fromDirectoryId!,
          toDirectoryId: params.toDirectoryId!
        })
      )
    // ── Graph ──
    case 'graph.search':
      return (
        missing(p, ['query']) ||
        searchGraphHandler({
          query: params.query!,
          wikiId: params.wikiId,
          type: params.type,
          limit: params.limit
        })
      )
    case 'graph.entity':
      return (
        missing(p, ['entityId']) ||
        getGraphEntityHandler({
          entityId: params.entityId!,
          includeRelations: params.includeRelations,
          limit: params.limit
        })
      )
    default:
      return `Unknown command: ${String(command)}`
  }
}

export function buildManageMaterialsTool(): StructuredToolInterface {
  return tool(dispatch, {
    name: MANAGE_MATERIALS_TOOL,
    description: COMMAND_DESCRIPTION,
    schema
  })
}

/** This tool is the only entry point the notes (materials) library provides to the AI */
export const materialsToolContributions: PluginToolContribution[] = [
  {
    name: MANAGE_MATERIALS_TOOL,
    info: {
      name: MANAGE_MATERIALS_TOOL,
      label: 'Materials',
      description: 'Organize documents, to-dos, knowledge bases and graph entities',
      icon: 'RiFoldersLine',
      color: '#722ed1'
    },
    build: buildManageMaterialsTool
  }
]
