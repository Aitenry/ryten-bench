/**
 * Document tools of the materials organization — split into four by **intent**, not just domain.
 *
 * History: `manage_materials` (one 35-command entry) → four domain tools (`materials_docs` +
 * todos / wikis / graph) on 2026-11-28 → `materials_docs` split again into search / read / write /
 * edit because its 14 commands still mixed four very different parameter sets (search paging,
 * whole-document writes, line/column edits, batch patches). Now each document tool only declares
 * the fields its commands actually use, and the model can pick the tool from the verb alone.
 *
 * All four, like the other domains, stay behind the single `materials-tools` picker entry
 * (see MATERIALS_TOOL_GROUP in shared/harness/mcp.ts); the UI never shows them one by one.
 */
import * as z from 'zod/v4'
import { tool } from '../../ai/tools'
import type { StructuredToolInterface } from '../../ai/tools'
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
import { missingParamText } from './materials-shared'

export const MATERIALS_DOCS_SEARCH_TOOL = 'materials_docs_search'
export const MATERIALS_DOCS_READ_TOOL = 'materials_docs_read'
export const MATERIALS_DOCS_WRITE_TOOL = 'materials_docs_write'
export const MATERIALS_DOCS_EDIT_TOOL = 'materials_docs_edit'

// ============================================================================
// Search — cross-document full-text search (no command: the tool is the operation)
// ============================================================================

const SEARCH_DESCRIPTION = `「资料整理 · 文档搜索」全文搜索资料库文档（标题/摘要/标签/正文），返回文档 ID、标题与摘要。

省略 query（或传空串）时按最近更新列出文档，可当索引用；拿到 docId 后用 materials_docs_read 打开正文 /
标题树，用 materials_docs_edit 按行或文本片段精修。分页用 page / pageSize（默认 1 / 10，pageSize 最大 50）。`

const searchSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Search text (title/summary/tags/body); omit or leave empty to list documents'),
  page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  pageSize: z.number().int().min(1).max(100).optional().describe('Page size (default 10)')
})

type SearchParams = z.infer<typeof searchSchema>

async function dispatchSearch(params: SearchParams): Promise<string> {
  return searchDocsHandler({ query: params.query, page: params.page, pageSize: params.pageSize })
}

export function buildMaterialsDocsSearchTool(): StructuredToolInterface {
  return tool(dispatchSearch, {
    name: MATERIALS_DOCS_SEARCH_TOOL,
    isConcurrencySafe: () => true,
    description: SEARCH_DESCRIPTION,
    schema: searchSchema
  })
}

// ============================================================================
// Read — outline / body / find inside one document
// ============================================================================

const COMMANDS = ['doc.toc', 'doc.get', 'doc.find'] as const

const READ_DESCRIPTION = `「资料整理 · 文档读取」打开一篇文档，或在文档内定位。

  doc.toc   标题树，带行号与 revision：docId
  doc.get   读取正文（默认带行号并返回 revision）：docId, headingId? 或 startLine?/endLine?, maxChars?
  doc.find  文档内查找，返回行/列（码点）与上下文：docId, query, regex?, caseSensitive?, contextLines?, maxMatches?

大文档用 startLine/endLine 或 headingId 分段读取；doc.get / doc.find 返回的 revision 可以传给
materials_docs_write / materials_docs_edit 的 expectedRevision，避免覆盖并发修改。行号、列号都从 1 开始，
列按 Unicode 字符计。`

const readSchema = z.object({
  command: z.enum(COMMANDS).describe('Operation to run; see the tool description'),
  docId: z.number().int().positive().optional().describe('Document ID'),
  headingId: z.string().optional().describe('[doc.get] Heading ID from doc.toc (e.g. h-2)'),
  startLine: z.number().int().min(1).optional().describe('[doc.get] Start line (1-based)'),
  endLine: z.number().int().min(1).optional().describe('[doc.get] End line (1-based, inclusive)'),
  maxChars: z
    .number()
    .int()
    .min(1000)
    .max(200000)
    .optional()
    .describe('[doc.get] Max output characters (default 30000)'),
  query: z.string().optional().describe('[doc.find] Search text'),
  regex: z.boolean().optional().describe('[doc.find] Treat query as a regular expression'),
  caseSensitive: z
    .boolean()
    .optional()
    .describe('[doc.find] Case-sensitive search (default false)'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe('[doc.find] Context lines around each match'),
  maxMatches: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('[doc.find] Max matches to show (default 20)')
})

type ReadParams = z.infer<typeof readSchema>

async function dispatchRead(params: ReadParams): Promise<string> {
  const p = params as Record<string, unknown>
  switch (params.command) {
    case 'doc.toc':
      return missingParamText(p, ['docId']) || getDocTocHandler({ docId: params.docId! })
    case 'doc.get':
      return (
        missingParamText(p, ['docId']) ||
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
        missingParamText(p, ['docId', 'query']) ||
        findInDocHandler({
          docId: params.docId!,
          query: params.query!,
          regex: params.regex,
          caseSensitive: params.caseSensitive,
          maxMatches: params.maxMatches,
          contextLines: params.contextLines
        })
      )
    default:
      return `Unknown command: ${String(params.command)}`
  }
}

export function buildMaterialsDocsReadTool(): StructuredToolInterface {
  return tool(dispatchRead, {
    name: MATERIALS_DOCS_READ_TOOL,
    isConcurrencySafe: () => true,
    description: READ_DESCRIPTION,
    schema: readSchema
  })
}

// ============================================================================
// Write — create / whole-document update / delete
// ============================================================================

const WRITE_COMMANDS = ['doc.create', 'doc.update', 'doc.delete'] as const

const WRITE_DESCRIPTION = `「资料整理 · 文档写入」新建整篇文档、整篇/元数据更新、删除文档。

  doc.create  新建：title, summary?, tags?(JSON 数组字符串), content?
  doc.update  整篇或元数据更新：docId, title?, summary?, tags?, content?, expectedRevision?
  doc.delete  删除（不可恢复）：docId

只想改一行或一个片段时不要重写全文，用 materials_docs_edit。doc.update 可带 expectedRevision
（materials_docs_read 返回），不一致会拒绝写入，避免覆盖编辑器或其它工具的并发修改。`

const writeSchema = z.object({
  command: z.enum(WRITE_COMMANDS).describe('Operation to run; see the tool description'),
  docId: z.number().int().positive().optional().describe('[doc.update/doc.delete] Document ID'),
  title: z.string().optional().describe('[doc.create/doc.update] Title'),
  summary: z.string().optional().describe('[doc.create/doc.update] Summary/description'),
  tags: z.string().optional().describe('Tags as a JSON array string, e.g. \'["tag1","tag2"]\''),
  content: z.string().optional().describe('[doc.create/doc.update] Full body content (Markdown)'),
  expectedRevision: z
    .string()
    .optional()
    .describe(
      '[doc.update] Revision from materials_docs_read; mismatches abort to avoid overwriting concurrent edits'
    )
})

type WriteParams = z.infer<typeof writeSchema>

async function dispatchWrite(params: WriteParams): Promise<string> {
  const p = params as Record<string, unknown>
  switch (params.command) {
    case 'doc.create':
      return (
        missingParamText(p, ['title']) ||
        createDocHandler({
          title: params.title!,
          summary: params.summary,
          tags: params.tags,
          content: params.content
        })
      )
    case 'doc.update':
      return (
        missingParamText(p, ['docId']) ||
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
      return missingParamText(p, ['docId']) || deleteDocHandler({ docId: params.docId! })
    default:
      return `Unknown command: ${String(params.command)}`
  }
}

export function buildMaterialsDocsWriteTool(): StructuredToolInterface {
  return tool(dispatchWrite, {
    name: MATERIALS_DOCS_WRITE_TOOL,
    description: WRITE_DESCRIPTION,
    schema: writeSchema
  })
}

// ============================================================================
// Edit — fine-grained line / range / text-fragment edits + atomic batch patch
// ============================================================================

const EDIT_COMMANDS = [
  'doc.replace_lines',
  'doc.replace_text',
  'doc.replace_range',
  'doc.insert',
  'doc.delete_lines',
  'doc.delete_range',
  'doc.patch'
] as const

const EDIT_DESCRIPTION = `「资料整理 · 文档精修」按行 / 行内列区间 / 文本片段精修文档，不必重写全文。

  doc.replace_lines 替换整行区间：docId, startLine, endLine, newText（空串=删除这些行）, expectedOld?
  doc.replace_text  替换文本片段：docId, oldText, newText, all?/occurrence?, startLine?/endLine?, regex?, caseSensitive?
  doc.replace_range 替换一行内的列区间：docId, line, startColumn?, endColumn?, newText, expectedOld?
  doc.insert        插入文本：docId, position(at|before|after|start|end), line?, column?, newText
  doc.delete_lines  删除整行区间：docId, startLine, endLine, expectedOld?
  doc.delete_range  删除行内列区间：docId, line, startColumn?, endColumn?, expectedOld?
  doc.patch         批量编辑（原子）：docId, edits:[{type,...}], expectedRevision?, dryRun?

推荐流程：materials_docs_read 的 doc.get（记下 revision 与行号）→ doc.find 定位 → replace_lines /
replace_text / replace_range（带 expectedOld 更稳）；多处修改用 doc.patch 一次提交（按顺序应用，
行号指上一处编辑后的状态）。所有编辑支持 dryRun=true 只预览；可带 expectedRevision（doc.get/doc.find
返回），不一致会拒绝写入。行号、列号都从 1 开始；列按 Unicode 字符计。`

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

const editSchema = z.object({
  command: z.enum(EDIT_COMMANDS).describe('Operation to run; see the tool description'),
  docId: z.number().int().positive().optional().describe('Document ID'),
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
  regex: z
    .boolean()
    .optional()
    .describe('[doc.replace_text] Treat oldText as a regular expression'),
  caseSensitive: z
    .boolean()
    .optional()
    .describe('[doc.replace_text] Case-sensitive search (default false)'),
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
      '[doc.edit/patch] Revision from materials_docs_read; mismatches abort to avoid overwriting concurrent edits'
    ),
  dryRun: z.boolean().optional().describe('[doc.edit/patch] Preview only, do not write'),
  edits: z
    .array(docEditSchema)
    .optional()
    .describe('[doc.patch] Ordered edits (line numbers refer to the document after previous edits)')
})

type EditParams = z.infer<typeof editSchema>

async function dispatchEdit(params: EditParams): Promise<string> {
  const p = params as Record<string, unknown>
  switch (params.command) {
    case 'doc.replace_lines':
      return (
        missingParamText(p, ['docId', 'startLine', 'endLine']) ||
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
        missingParamText(p, ['docId', 'oldText']) ||
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
        missingParamText(p, ['docId', 'line']) ||
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
        missingParamText(p, ['docId', 'newText']) ||
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
        missingParamText(p, ['docId', 'startLine', 'endLine']) ||
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
        missingParamText(p, ['docId', 'line']) ||
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
        missingParamText(p, ['docId']) ||
        patchDocHandler({
          docId: params.docId,
          edits: params.edits as unknown as DocEdit[],
          expectedRevision: params.expectedRevision,
          dryRun: params.dryRun
        })
      )
    default:
      return `Unknown command: ${String(params.command)}`
  }
}

export function buildMaterialsDocsEditTool(): StructuredToolInterface {
  return tool(dispatchEdit, {
    name: MATERIALS_DOCS_EDIT_TOOL,
    description: EDIT_DESCRIPTION,
    schema: editSchema
  })
}
