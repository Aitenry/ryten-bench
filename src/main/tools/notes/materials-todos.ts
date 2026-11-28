/**
 * To-do tools of the materials organization — split with the same granularity as the document
 * tools (`materials_docs_search` / `_read` / `_write` / `_edit`).
 *
 * Why: the documents domain was split by intent on 2026-11-28 (search / read / write / edit) and
 * one `materials_todos` tool with six commands still had the same problem — `todo.list` filters,
 * a single-item update and a multi-id bulk update shared one flat schema. The to-do surface now
 * mirrors the document surface:
 * - `materials_todos_search` — list/filter (like `materials_docs_search`);
 * - `materials_todos_read`   — one item in full (like `materials_docs_read`);
 * - `materials_todos_write`  — add / update / delete (like `materials_docs_write`);
 * - `materials_todos_edit`   — batch update of several items (like `materials_docs_edit`).
 *
 * Single-operation tools do not take a `command` argument: the tool itself is the operation.
 * All of them stay behind the single `materials-tools` picker entry (MATERIALS_TOOL_GROUP).
 */
import * as z from 'zod/v4'
import { tool } from '../../ai/tools'
import type { StructuredToolInterface } from '../../ai/tools'
import {
  addTodoHandler,
  bulkUpdateTodosHandler,
  deleteTodoHandler,
  getTodoHandler,
  listTodosHandler,
  updateTodoHandler
} from './todos'
import { missingParamText } from './materials-shared'

export const MATERIALS_TODOS_SEARCH_TOOL = 'materials_todos_search'
export const MATERIALS_TODOS_READ_TOOL = 'materials_todos_read'
export const MATERIALS_TODOS_WRITE_TOOL = 'materials_todos_write'
export const MATERIALS_TODOS_EDIT_TOOL = 'materials_todos_edit'

// ============================================================================
// Search — list/filter to-dos (no command: the tool is the operation)
// ============================================================================

const SEARCH_DESCRIPTION = `「资料整理 · 待办搜索」按状态 / 优先级 / 分类 / 关键字筛选待办列表，返回 ID 与摘要。

拿到 todoId 后用 materials_todos_read 查看正文与时间戳。优先级 0=P0 最高 … 7=P7 最低；
状态 0=待办 / 1=进行中 / 2=已完成。分页用 page / pageSize。`

const searchSchema = z.object({
  query: z.string().optional().describe('Search text (title / content / category)'),
  status: z
    .number()
    .int()
    .min(0)
    .max(2)
    .optional()
    .describe('Filter by status: 0=todo, 1=in progress, 2=done'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(7)
    .optional()
    .describe('Filter by priority: 0=P0 (highest) … 7=P7 (lowest)'),
  category: z.string().optional().describe('Filter by category'),
  includeDone: z.boolean().optional().describe('Include completed items (default true)'),
  page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  pageSize: z.number().int().min(1).max(100).optional().describe('Page size')
})

type SearchParams = z.infer<typeof searchSchema>

async function dispatchSearch(params: SearchParams): Promise<string> {
  return listTodosHandler({
    status: params.status,
    priority: params.priority,
    category: params.category,
    query: params.query,
    includeDone: params.includeDone,
    page: params.page,
    pageSize: params.pageSize
  })
}

export function buildMaterialsTodosSearchTool(): StructuredToolInterface {
  return tool(dispatchSearch, {
    name: MATERIALS_TODOS_SEARCH_TOOL,
    isConcurrencySafe: () => true,
    description: SEARCH_DESCRIPTION,
    schema: searchSchema
  })
}

// ============================================================================
// Read — one to-do in full
// ============================================================================

const READ_DESCRIPTION = `「资料整理 · 待办详情」查看单条待办的正文与时间戳：todoId。

列表 / 筛选请用 materials_todos_search。`

const readSchema = z.object({
  todoId: z.number().int().positive().optional().describe('Todo ID')
})

type ReadParams = z.infer<typeof readSchema>

async function dispatchRead(params: ReadParams): Promise<string> {
  return (
    missingParamText(params as Record<string, unknown>, ['todoId']) ||
    getTodoHandler({ todoId: params.todoId! })
  )
}

export function buildMaterialsTodosReadTool(): StructuredToolInterface {
  return tool(dispatchRead, {
    name: MATERIALS_TODOS_READ_TOOL,
    isConcurrencySafe: () => true,
    description: READ_DESCRIPTION,
    schema: readSchema
  })
}

// ============================================================================
// Write — add / update / delete one to-do
// ============================================================================

const WRITE_COMMANDS = ['todo.add', 'todo.update', 'todo.delete'] as const

const WRITE_DESCRIPTION = `「资料整理 · 待办写入」新建、更新或删除单条待办。

  todo.add     新建：title, content?, priority?, due_date?(YYYY-MM-DD), category?
  todo.update  更新：todoId, title?, content?, status?, priority?, due_date?, category?
  todo.delete  删除：todoId

优先级 0=P0 最高 … 7=P7 最低；状态 0=待办 / 1=进行中 / 2=已完成；due_date 为 YYYY-MM-DD，
传 null 可清空到期日或分类。一次修改多条（状态 / 优先级 / 到期日 / 分类）请用 materials_todos_edit。`

const writeSchema = z.object({
  command: z.enum(WRITE_COMMANDS).describe('Operation to run; see the tool description'),
  todoId: z.number().int().positive().optional().describe('[todo.update/todo.delete] Todo ID'),
  title: z.string().optional().describe('[todo.add/todo.update] Title'),
  content: z.string().optional().describe('[todo.add/todo.update] Full body content (Markdown)'),
  status: z
    .number()
    .int()
    .min(0)
    .max(2)
    .optional()
    .describe('[todo.update] 0=todo, 1=in progress, 2=done'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(7)
    .optional()
    .describe('[todo] 0=P0 (highest) … 7=P7 (lowest)'),
  due_date: z.string().nullable().optional().describe('[todo] Due date YYYY-MM-DD; null clears'),
  category: z.string().nullable().optional().describe('[todo] Category; null clears')
})

type WriteParams = z.infer<typeof writeSchema>

async function dispatchWrite(params: WriteParams): Promise<string> {
  const p = params as Record<string, unknown>
  switch (params.command) {
    case 'todo.add':
      return (
        missingParamText(p, ['title']) ||
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
        missingParamText(p, ['todoId']) ||
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
    case 'todo.delete':
      return missingParamText(p, ['todoId']) || deleteTodoHandler({ todoId: params.todoId! })
    default:
      return `Unknown command: ${String(params.command)}`
  }
}

export function buildMaterialsTodosWriteTool(): StructuredToolInterface {
  return tool(dispatchWrite, {
    name: MATERIALS_TODOS_WRITE_TOOL,
    description: WRITE_DESCRIPTION,
    schema: writeSchema
  })
}

// ============================================================================
// Edit — batch update several to-dos (no command: one atomic batch operation)
// ============================================================================

const EDIT_DESCRIPTION = `「资料整理 · 待办批量编辑」一次更新多条待办的共同字段，只改传入的字段。

参数：ids（必填）, status?, priority?, due_date?, category?
状态 0=待办 / 1=进行中 / 2=已完成；优先级 0=P0 最高 … 7=P7 最低；due_date 为 YYYY-MM-DD，
传 null 可清空。单条更新请用 materials_todos_write 的 todo.update。`

const editSchema = z.object({
  ids: z.array(z.number().int().positive()).optional().describe('Todo IDs to update'),
  status: z.number().int().min(0).max(2).optional().describe('New status for every listed item'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(7)
    .optional()
    .describe('New priority for every listed item (0=P0 highest … 7=P7 lowest)'),
  due_date: z
    .string()
    .nullable()
    .optional()
    .describe('New due date YYYY-MM-DD for every listed item; null clears'),
  category: z
    .string()
    .nullable()
    .optional()
    .describe('New category for every listed item; null clears')
})

type EditParams = z.infer<typeof editSchema>

async function dispatchEdit(params: EditParams): Promise<string> {
  const p = params as Record<string, unknown>
  return (
    missingParamText(p, ['ids']) ||
    bulkUpdateTodosHandler({
      ids: params.ids!,
      status: params.status,
      priority: params.priority,
      due_date: params.due_date,
      category: params.category
    })
  )
}

export function buildMaterialsTodosEditTool(): StructuredToolInterface {
  return tool(dispatchEdit, {
    name: MATERIALS_TODOS_EDIT_TOOL,
    description: EDIT_DESCRIPTION,
    schema: editSchema
  })
}
