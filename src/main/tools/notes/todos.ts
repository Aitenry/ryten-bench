// Todo domain handlers (dispatched by the materials_todos_* tools).
//
// 2026-11 materials organization rework:
// - List filtering is now done in memory (the old implementation queried the DB by status, missing
//   historical rows whose status is NULL, and ignored pageSize when page=1, returning everything);
//   supports category / keyword / include-completed;
// - New todo.get: the list only shows summaries, use get for the body/timestamps so all bodies are
//   not listed at once;
// - New todo.bulk_update: update status/priority/due date/category for several items at once;
// - Priority scale matches the UI: 0=P0 (highest) … 7=P7 (lowest); 1 is no longer treated as the
//   highest.
import { mainFormat, mainPlural } from '../../i18n'
import { getTodoToolTexts } from '../../i18n/tool-results-todos'

const MIN_PRIORITY = 0
const MAX_PRIORITY = 7
const MAX_PAGE_SIZE = 100

function priorityText(priority: number | null | undefined): string {
  return mainFormat(getTodoToolTexts().todos.priorityValue, { priority: priority ?? 0 })
}

function validPriority(priority: number): boolean {
  return Number.isInteger(priority) && priority >= MIN_PRIORITY && priority <= MAX_PRIORITY
}

function validStatus(status: number): boolean {
  return status === 0 || status === 1 || status === 2
}

function validDueDate(due: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return false
  const [year, month, day] = due.split('-').map((part) => Number(part))
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

// ============================================================================
// Queries
// ============================================================================

export async function listTodosHandler(params: {
  status?: number
  priority?: number
  category?: string
  query?: string
  includeDone?: boolean
  page?: number
  pageSize?: number
}): Promise<string> {
  const tr = getTodoToolTexts()
  const { getAllTodoItems } = await import('../../database/mapper/notes/todo')
  const all = await getAllTodoItems()

  const includeDone = params.includeDone ?? true
  const query = params.query?.trim().toLowerCase()
  const category = params.category?.trim()
  const filtered = all.filter((item) => {
    const status = item.status ?? 0
    if (!includeDone && status === 2) return false
    if (params.status !== undefined && status !== params.status) return false
    if (params.priority !== undefined && (item.priority ?? 0) !== params.priority) return false
    if (category && (item.category ?? '') !== category) return false
    if (query) {
      const haystack = [item.title, item.content, item.category]
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
        .toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })

  const total = filtered.length
  if (total === 0) return tr.todos.empty
  const page = Math.max(1, Math.floor(params.page ?? 1))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(params.pageSize ?? 20)))
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)
  if (items.length === 0) {
    return mainFormat(tr.todos.pageEmpty, { page, total })
  }

  const statusLabels = [
    tr.todos.statusLabels.todo,
    tr.todos.statusLabels.inProgress,
    tr.todos.statusLabels.done
  ]
  const lines = [mainPlural(tr.todos.listHeader_one, tr.todos.listHeader_other, total)]
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages > 1) {
    lines.push(mainFormat(tr.todos.listPage, { page, pages, total }))
  }
  for (const t of items) {
    const status = t.status ?? 0
    const priority = t.priority ?? 0
    const s = statusLabels[status] ?? mainFormat(tr.todos.statusLabels.unknown, { status })
    const meta: string[] = [
      mainFormat(tr.todos.meta.status, { status: s }),
      mainFormat(tr.todos.meta.priority, { priority: priorityText(priority) })
    ]
    if (t.due_date) meta.push(mainFormat(tr.todos.meta.due, { dueDate: t.due_date }))
    if (t.category) meta.push(mainFormat(tr.todos.meta.category, { category: t.category }))
    lines.push(`  [${t.id}] ${t.title}`)
    lines.push(`    ${meta.join(' | ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

export async function getTodoHandler(params: { todoId: number }): Promise<string> {
  const tr = getTodoToolTexts()
  const { getTodoItemById } = await import('../../database/mapper/notes/todo')
  const rows = await getTodoItemById(params.todoId)
  if (!rows.length) return mainFormat(tr.todos.notFound, { id: params.todoId })
  const todo = rows[0]

  const statusLabels = [
    tr.todos.statusLabels.todo,
    tr.todos.statusLabels.inProgress,
    tr.todos.statusLabels.done
  ]
  const status = todo.status ?? 0
  const priority = todo.priority ?? 0
  const meta = [
    mainFormat(tr.todos.meta.status, {
      status: statusLabels[status] ?? mainFormat(tr.todos.statusLabels.unknown, { status })
    }),
    mainFormat(tr.todos.meta.priority, { priority: priorityText(priority) }),
    mainFormat(tr.todos.meta.created, { createdAt: todo.created_at ?? '—' }),
    mainFormat(tr.todos.meta.updated, { updatedAt: todo.updated_at ?? '—' })
  ]
  if (todo.due_date) meta.push(mainFormat(tr.todos.meta.due, { dueDate: todo.due_date }))
  if (todo.category) meta.push(mainFormat(tr.todos.meta.category, { category: todo.category }))
  if (todo.started_at) meta.push(mainFormat(tr.todos.meta.started, { startedAt: todo.started_at }))
  if (todo.completed_at) {
    meta.push(mainFormat(tr.todos.meta.completed, { completedAt: todo.completed_at }))
  }

  return [
    mainFormat(tr.todos.getHeader, { todoId: todo.id, title: todo.title }),
    meta.join(' | '),
    '',
    '---',
    todo.content?.trim() ? todo.content : tr.todos.noContent,
    '---'
  ].join('\n')
}

// ============================================================================
// Write operations
// ============================================================================

export async function addTodoHandler(params: {
  title: string
  content?: string
  priority?: number
  due_date?: string | null
  category?: string | null
}): Promise<string> {
  const tr = getTodoToolTexts()
  if (!params.title?.trim()) return tr.todos.titleRequired
  const priority = params.priority ?? 2
  if (!validPriority(priority)) return tr.todos.invalidPriority
  if (params.due_date && !validDueDate(params.due_date)) return tr.todos.invalidDueDate

  const { addTodoItem, getTodoItemById } = await import('../../database/mapper/notes/todo')
  const newId = await addTodoItem({
    title: params.title,
    content: params.content || '',
    due_date: params.due_date || null,
    priority,
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

export async function updateTodoHandler(params: {
  todoId: number
  title?: string
  content?: string
  status?: number
  priority?: number
  due_date?: string | null
  category?: string | null
}): Promise<string> {
  const tr = getTodoToolTexts()
  if (params.title !== undefined && !params.title.trim()) return tr.todos.titleRequired
  if (params.priority !== undefined && !validPriority(params.priority)) {
    return tr.todos.invalidPriority
  }
  if (params.status !== undefined && !validStatus(params.status)) return tr.todos.invalidStatus
  if (typeof params.due_date === 'string' && !validDueDate(params.due_date)) {
    return tr.todos.invalidDueDate
  }

  const { updateTodoItem, getTodoItemById } = await import('../../database/mapper/notes/todo')
  const rows = await getTodoItemById(params.todoId)
  if (!rows.length) return mainFormat(tr.todos.notFound, { id: params.todoId })
  const existing = rows[0]

  const updates: Record<string, unknown> = {}
  if (params.title !== undefined) updates.title = params.title
  if (params.content !== undefined) updates.content = params.content
  if (params.status !== undefined) updates.status = params.status
  if (params.priority !== undefined) updates.priority = params.priority
  if (params.due_date !== undefined) updates.due_date = params.due_date || null
  if (params.category !== undefined) updates.category = params.category || null
  if (Object.keys(updates).length === 0) return tr.todos.noFieldsToUpdate

  updates.updated_at = new Date().toISOString()
  await updateTodoItem(params.todoId, updates as Parameters<typeof updateTodoItem>[1])
  return mainFormat(tr.todos.updated, {
    id: params.todoId,
    title: params.title ?? existing.title
  })
}

export async function bulkUpdateTodosHandler(params: {
  ids: number[]
  status?: number
  priority?: number
  due_date?: string | null
  category?: string | null
}): Promise<string> {
  const tr = getTodoToolTexts()
  if (!params.ids.length) return tr.todos.idsRequired
  if (params.priority !== undefined && !validPriority(params.priority)) {
    return tr.todos.invalidPriority
  }
  if (params.status !== undefined && !validStatus(params.status)) return tr.todos.invalidStatus
  if (typeof params.due_date === 'string' && !validDueDate(params.due_date)) {
    return tr.todos.invalidDueDate
  }

  const updates: Record<string, unknown> = {}
  if (params.status !== undefined) updates.status = params.status
  if (params.priority !== undefined) updates.priority = params.priority
  if (params.due_date !== undefined) updates.due_date = params.due_date || null
  if (params.category !== undefined) updates.category = params.category || null
  if (Object.keys(updates).length === 0) return tr.todos.noFieldsToUpdate
  updates.updated_at = new Date().toISOString()

  const { updateTodoItem, getTodoItemById } = await import('../../database/mapper/notes/todo')
  const missing: number[] = []
  let updated = 0
  for (const id of params.ids) {
    const rows = await getTodoItemById(id)
    if (!rows.length) {
      missing.push(id)
      continue
    }
    await updateTodoItem(id, updates as Parameters<typeof updateTodoItem>[1])
    updated++
  }
  const missingText = missing.length
    ? mainFormat(tr.todos.bulkMissing, { ids: missing.join(', ') })
    : ''
  return mainFormat(tr.todos.bulkUpdated, { count: updated, missing: missingText })
}

export async function deleteTodoHandler(params: { todoId: number }): Promise<string> {
  const tr = getTodoToolTexts()
  const { deleteTodoItem, getTodoItemById } = await import('../../database/mapper/notes/todo')
  const rows = await getTodoItemById(params.todoId)
  if (!rows.length) return mainFormat(tr.todos.notFound, { id: params.todoId })
  await deleteTodoItem(params.todoId)
  return mainFormat(tr.todos.deleted, { id: params.todoId, title: rows[0].title })
}
