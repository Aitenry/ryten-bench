// 本工具（manage_todos）归属 notes 插件：待办数据全部走本插件的 mapper，不再跨插件直读。
// 经 harness 的**工具贡献点**（HARNESS_TOOL_CONTRIBUTION，契约见
// src/main/plugins/tool-contract.ts）注册给 AI：插件未启用时 harness 拉不到这条贡献，
// 工具自然不出现在模型面前。
import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import * as z from 'zod/v4'
import { mainFormat, mainPlural } from '../../../../main/i18n'
import { getTodoToolTexts } from '../../../../main/i18n/tool-results-todos'
import type { PluginToolContribution } from '../../../../main/plugins/tool-contract'

// ============================================================================
// Todo Handlers
// ============================================================================

async function listTodosHandler(params: {
  status?: number
  priority?: number
  page?: number
  pageSize?: number
}): Promise<string> {
  const tr = getTodoToolTexts()
  const { getAllTodoItems, getTodoItemsPaginated, getTodoItemsByStatus, getTodoItemsByPriority } =
    await import('../db/mapper/todo')
  const { page = 1, pageSize = 20, status, priority } = params
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.max(1, Math.floor(pageSize))
  let items: Array<{
    id: number
    title: string
    status: number | null
    priority: number | null
    due_date: string | null
    category: string | null
  }>
  if (status !== undefined) {
    // 修复：此前「先分页后客户端过滤」只扫第一页,命中项在后续页即漏报；
    // 且分页 SQL 恒排除已完成(status!=2),查「已完成」永远为空。
    // 改为按状态全量查询后在内存分页（口径与不带过滤的 list 一致,含已完成）
    const rows = await getTodoItemsByStatus(status)
    items = rows.slice((safePage - 1) * safePageSize, safePage * safePageSize)
  } else if (priority !== undefined) {
    const rows = await getTodoItemsByPriority(priority)
    items = rows.slice((safePage - 1) * safePageSize, safePage * safePageSize)
  } else if (safePage > 1) {
    const result = await getTodoItemsPaginated(safePage, safePageSize)
    items = result.items
  } else {
    items = await getAllTodoItems()
  }
  if (!items.length) return tr.todos.empty
  const statusLabels = [
    tr.todos.statusLabels.todo,
    tr.todos.statusLabels.inProgress,
    tr.todos.statusLabels.done
  ]
  const priorityLabels = [
    tr.todos.priorityLabels.none,
    tr.todos.priorityLabels.p0,
    tr.todos.priorityLabels.p1,
    tr.todos.priorityLabels.p2,
    tr.todos.priorityLabels.p3
  ]
  const lines = [mainPlural(tr.todos.listHeader_one, tr.todos.listHeader_other, items.length)]
  for (const t of items) {
    // 两列在库里有 DEFAULT 0，只有历史脏数据才可能为 null；null 一律按默认值（待办 / 无优先级）呈现
    const status = t.status ?? 0
    const priority = t.priority ?? 0
    const s = statusLabels[status] ?? mainFormat(tr.todos.statusLabels.unknown, { status })
    const p = priorityLabels[priority] ?? `P${priority}`
    lines.push(`  [${t.id}] ${t.title}`)
    const meta: string[] = [
      mainFormat(tr.todos.meta.status, { status: s }),
      mainFormat(tr.todos.meta.priority, { priority: p })
    ]
    if (t.due_date) meta.push(mainFormat(tr.todos.meta.due, { dueDate: t.due_date }))
    if (t.category) meta.push(mainFormat(tr.todos.meta.category, { category: t.category }))
    lines.push(`    ${meta.join(' | ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function addTodoHandler(params: {
  title: string
  content?: string
  priority?: number
  due_date?: string
  category?: string
}): Promise<string> {
  const tr = getTodoToolTexts()
  const { addTodoItem, getTodoItemById } = await import('../db/mapper/todo')
  const newId = await addTodoItem({
    title: params.title,
    content: params.content || '',
    due_date: params.due_date || null,
    priority: params.priority ?? 2,
    status: 0,
    category: params.category || null,
    completed_at: null,
    started_at: null
  })
  const rows = await getTodoItemById(newId)
  const todo = rows[0]
  return mainFormat(tr.todos.created, {
    id: todo.id,
    title: todo.title,
    priority: todo.priority,
    due: todo.due_date ? mainFormat(tr.todos.createdDue, { dueDate: todo.due_date }) : ''
  })
}

async function updateTodoHandler(params: {
  id: number
  title?: string
  content?: string
  status?: number
  priority?: number
  due_date?: string | null
  category?: string
}): Promise<string> {
  const tr = getTodoToolTexts()
  const { updateTodoItem, getTodoItemById } = await import('../db/mapper/todo')
  const rows = await getTodoItemById(params.id)
  if (!rows.length) return mainFormat(tr.todos.notFound, { id: params.id })
  const existing = rows[0]
  const updates: Record<string, unknown> = {}
  if (params.title !== undefined) updates.title = params.title
  if (params.content !== undefined) updates.content = params.content
  if (params.status !== undefined) updates.status = params.status
  if (params.priority !== undefined) updates.priority = params.priority
  if (params.due_date !== undefined) updates.due_date = params.due_date
  if (params.category !== undefined) updates.category = params.category
  updates.updated_at = new Date().toISOString()
  await updateTodoItem(params.id, updates as Parameters<typeof updateTodoItem>[1])
  return mainFormat(tr.todos.updated, { id: params.id, title: params.title ?? existing.title })
}

async function deleteTodoHandler(params: { id: number }): Promise<string> {
  const tr = getTodoToolTexts()
  const { deleteTodoItem, getTodoItemById } = await import('../db/mapper/todo')
  const rows = await getTodoItemById(params.id)
  if (!rows.length) return mainFormat(tr.todos.notFound, { id: params.id })
  await deleteTodoItem(params.id)
  return mainFormat(tr.todos.deleted, { id: params.id, title: rows[0].title })
}

// ============================================================================
// Tool Builder
// ============================================================================

export function buildManageTodosTool(): StructuredToolInterface {
  return tool(
    async ({ command, ...params }) => {
      switch (command) {
        case 'list':
          return listTodosHandler(params as Parameters<typeof listTodosHandler>[0])
        case 'add':
          return addTodoHandler(params as Parameters<typeof addTodoHandler>[0])
        case 'update':
          return updateTodoHandler(params as Parameters<typeof updateTodoHandler>[0])
        case 'delete':
          return deleteTodoHandler(params as Parameters<typeof deleteTodoHandler>[0])
        default:
          return mainFormat(getTodoToolTexts().common.unknownCommand, {
            command,
            supported: 'list, add, update, delete'
          })
      }
    },
    {
      name: 'manage_todos',
      description:
        'Manage todo items.\n' +
        '  Commands:\n' +
        '    list - List todos; optional status (0=todo/1=in progress/2=done), priority (1=urgent/2=high/3=medium/4=low), page, pageSize\n' +
        '    add - Create a todo; requires title, optional content (Markdown body), priority, due_date (YYYY-MM-DD), category\n' +
        '    update - Update a todo; requires id, optional title, content, status, priority, due_date, category\n' +
        '    delete - Delete a todo; requires id',
      schema: z.object({
        command: z.enum(['list', 'add', 'update', 'delete']).describe('Operation type'),
        // list 参数
        status: z
          .number()
          .optional()
          .describe('[list] Filter by status: 0=todo, 1=in progress, 2=done'),
        priority: z
          .number()
          .optional()
          .describe('[list/add/update] Priority: 1=urgent, 2=high, 3=medium, 4=low'),
        page: z.number().optional().default(1).describe('[list] Page number'),
        pageSize: z.number().optional().default(20).describe('[list] Number of items per page'),
        // add/update 参数
        id: z.number().optional().describe('[update/delete] Todo ID'),
        title: z.string().optional().describe('[add/update] Todo title'),
        content: z.string().optional().describe('[add/update] Body content (Markdown)'),
        due_date: z.string().optional().describe('[add/update] Due date, format YYYY-MM-DD'),
        category: z
          .string()
          .optional()
          .describe('[add/update] Category label, e.g. "work", "personal"')
      })
    }
  )
}

// ============================================================================
// Harness 工具贡献
// ============================================================================

/** 本插件贡献给 harness 的 AI 工具（由 main/index.ts 经 ctx.contribute 注册） */
export const todoToolContributions: PluginToolContribution[] = [
  {
    name: 'manage_todos',
    info: {
      name: 'manage_todos',
      label: 'To-dos',
      description: 'View, create, update and delete to-dos',
      icon: 'RiListCheck3',
      color: '#fa8c16'
    },
    build: buildManageTodosTool
  }
]
