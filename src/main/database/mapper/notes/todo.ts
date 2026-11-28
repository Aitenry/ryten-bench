import { asc, count, desc, eq, ne, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import { withOrm } from '../../orm'
import { todo_items } from '../../schema'

/** Todo item row (fields inferred from schema) */
export type TodoItemRow = typeof todo_items.$inferSelect

export interface PaginatedResult<T> {
  items: T[]
  hasMore: boolean
  total: number
}

// --- Query by id ---
async function getTodoItemById(id: number): Promise<TodoItemRow[]> {
  return withOrm('getTodoItemById', async (db) => {
    const rows = await db.select().from(todo_items).where(eq(todo_items.id, id))
    logger.info(`Query by id=${id} returned ${rows.length} rows.`)
    return rows
  })
}

// --- Query by title ---
async function getTodoItemByTitle(title: string): Promise<TodoItemRow[]> {
  return withOrm('getTodoItemByTitle', async (db) => {
    const rows = await db.select().from(todo_items).where(eq(todo_items.title, title))
    logger.info(`Query by title="${title}" returned ${rows.length} rows.`)
    return rows
  })
}

// --- Query by priority ---
async function getTodoItemsByPriority(priority: number): Promise<TodoItemRow[]> {
  return withOrm('getTodoItemsByPriority', async (db) => {
    const rows = await db
      .select()
      .from(todo_items)
      .where(eq(todo_items.priority, priority))
      .orderBy(asc(todo_items.due_date))
    logger.info(`Query by priority=${priority} returned ${rows.length} rows.`)
    return rows
  })
}

// --- Query by status ---
async function getTodoItemsByStatus(status: number): Promise<TodoItemRow[]> {
  return withOrm('getTodoItemsByStatus', async (db) => {
    const rows = await db
      .select()
      .from(todo_items)
      .where(eq(todo_items.status, status))
      .orderBy(asc(todo_items.priority), asc(todo_items.due_date))
    logger.info(`Query by status=${status} returned ${rows.length} rows.`)
    return rows
  })
}

// --- Get all todo items ---
async function getAllTodoItems(): Promise<TodoItemRow[]> {
  return withOrm('getAllTodoItems', async (db) => {
    const rows = await db
      .select()
      .from(todo_items)
      .orderBy(asc(todo_items.priority), asc(todo_items.due_date))
    logger.info(`Query for all todo items returned ${rows.length} rows.`)
    return rows
  })
}

// --- Get todo items paginated (sorted by updated_at descending) ---
async function getTodoItemsPaginated(
  page: number = 1,
  pageSize: number = 10
): Promise<PaginatedResult<TodoItemRow>> {
  return withOrm('getTodoItemsPaginated', async (db) => {
    // Clamp page number/page size (fix: a pageSize of 0 or a negative number produced LIMIT 0 empty pages with hasMore always true)
    const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1)
    const safePageSize = Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 10)
    const offset = (safePage - 1) * safePageSize

    const countRows = await db
      .select({ total: count() })
      .from(todo_items)
      .where(ne(todo_items.status, 2))
    const total = Number(countRows[0]?.total) || 0

    const rows = await db
      .select()
      .from(todo_items)
      .where(ne(todo_items.status, 2))
      .orderBy(desc(todo_items.updated_at))
      .limit(safePageSize)
      .offset(offset)

    const hasMore = offset + rows.length < total
    logger.info(
      `Paginated todo items page=${page} pageSize=${pageSize}: ${rows.length} rows, total=${total}, hasMore=${hasMore}`
    )
    return { items: rows, hasMore, total }
  })
}

// --- Query by due_date ---
async function getTodoItemsByDueDate(dueDate: string): Promise<TodoItemRow[]> {
  return withOrm('getTodoItemsByDueDate', async (db) => {
    const rows = await db
      .select()
      .from(todo_items)
      .where(eq(todo_items.due_date, dueDate))
      .orderBy(asc(todo_items.priority))
    logger.info(`Query by due_date="${dueDate}" returned ${rows.length} rows.`)
    return rows
  })
}

// --- Query by category ---
async function getTodoItemsByCategory(category: string): Promise<TodoItemRow[]> {
  return withOrm('getTodoItemsByCategory', async (db) => {
    const rows = await db
      .select()
      .from(todo_items)
      .where(eq(todo_items.category, category))
      .orderBy(asc(todo_items.priority), asc(todo_items.due_date))
    logger.info(`Query by category="${category}" returned ${rows.length} rows.`)
    return rows
  })
}

// --- Add a todo item ---
async function addTodoItem(
  todoItem: Omit<TodoItemRow, 'id' | 'created_at' | 'updated_at'>
): Promise<number> {
  return withOrm('addTodoItem', async (db) => {
    const { title, content, due_date, priority, status, category, started_at } = todoItem
    const rows = await db
      .insert(todo_items)
      .values({ title, content, due_date, priority, status, category, started_at })
      .returning({ id: todo_items.id })
    const newId = rows[0].id
    logger.info(`Inserted new todo item with ID: ${newId}`)
    return newId
  })
}

// --- Update a todo item ---
async function updateTodoItem(
  id: number,
  updates: Partial<Omit<TodoItemRow, 'id' | 'created_at'>>
): Promise<boolean> {
  return withOrm('updateTodoItem', async (db) => {
    // PgUpdateSetSource allows each field to hold either a literal value or a SQL expression (e.g. now())
    const patch: PgUpdateSetSource<typeof todo_items> = {}

    if (updates.title !== undefined) patch.title = updates.title
    if (updates.content !== undefined) patch.content = updates.content
    if (updates.due_date !== undefined) patch.due_date = updates.due_date
    if (updates.priority !== undefined) patch.priority = updates.priority
    if (updates.status !== undefined) {
      patch.status = updates.status
      // Timestamps advance/roll back with status (fix: (1) when status=1, a caller passing started_at also set the same column, which made the whole UPDATE fail; (2) rolling the status back left stale timestamps, so the frontend's timestamp-based status check was wrong)
      if (updates.status === 2) {
        patch.completed_at = sql`now()`
      } else if (updates.completed_at === undefined) {
        patch.completed_at = null
      }
      if (updates.status === 1) {
        if (updates.started_at === undefined) patch.started_at = sql`now()`
      } else if (updates.started_at === undefined) {
        patch.started_at = null
      }
    }
    if (updates.category !== undefined) patch.category = updates.category
    if (updates.started_at !== undefined) patch.started_at = updates.started_at
    // Same as the previous implementation: updated_at is always refreshed unless explicitly provided (which made the old "no fields to update" early-exit branch unreachable)
    patch.updated_at = updates.updated_at !== undefined ? updates.updated_at : sql`now()`

    const updated = await db
      .update(todo_items)
      .set(patch)
      .where(eq(todo_items.id, id))
      .returning({ id: todo_items.id })

    if (updated.length > 0) {
      logger.info(`Updated todo item with ID: ${id}, ${updated.length} row(s) affected.`)
      return true
    }
    logger.warn(`No rows updated for todo item with ID: ${id}`)
    return false
  })
}

// --- Delete a todo item ---
async function deleteTodoItem(id: number): Promise<boolean> {
  return withOrm('deleteTodoItem', async (db) => {
    const deleted = await db
      .delete(todo_items)
      .where(eq(todo_items.id, id))
      .returning({ id: todo_items.id })
    if (deleted.length > 0) {
      logger.info(`Deleted todo item with ID: ${id}, ${deleted.length} row(s) affected.`)
      return true
    }
    logger.warn(`No rows deleted for todo item with ID: ${id}`)
    return false
  })
}

export {
  getTodoItemById,
  getTodoItemByTitle,
  getTodoItemsByPriority,
  getTodoItemsByStatus,
  getAllTodoItems,
  getTodoItemsPaginated,
  getTodoItemsByDueDate,
  getTodoItemsByCategory,
  addTodoItem,
  updateTodoItem,
  deleteTodoItem
}
