import { asc, count, desc, eq, ne, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import logger from 'electron-log'
import { withOrm } from '../../../../../main/database/orm'
import { todo_items } from '../../../../../main/database/schema'

/** 待办事项行（字段由 schema 推导） */
export type TodoItemRow = typeof todo_items.$inferSelect

export interface PaginatedResult<T> {
  items: T[]
  hasMore: boolean
  total: number
}

// --- 根据 id 查询 ---
async function getTodoItemById(id: number): Promise<TodoItemRow[]> {
  return withOrm('getTodoItemById', async (db) => {
    const rows = await db.select().from(todo_items).where(eq(todo_items.id, id))
    logger.info(`Query by id=${id} returned ${rows.length} rows.`)
    return rows
  })
}

// --- 根据 title 查询 ---
async function getTodoItemByTitle(title: string): Promise<TodoItemRow[]> {
  return withOrm('getTodoItemByTitle', async (db) => {
    const rows = await db.select().from(todo_items).where(eq(todo_items.title, title))
    logger.info(`Query by title="${title}" returned ${rows.length} rows.`)
    return rows
  })
}

// --- 根据 priority 查询 ---
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

// --- 根据 status 查询 ---
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

// --- 获取所有待办事项 ---
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

// --- 分页获取待办事项（按 updated_at 降序） ---
async function getTodoItemsPaginated(
  page: number = 1,
  pageSize: number = 10
): Promise<PaginatedResult<TodoItemRow>> {
  return withOrm('getTodoItemsPaginated', async (db) => {
    // 页码/页大小钳制（修复：pageSize 传 0/负数 → LIMIT 0 空页且 hasMore 恒真）
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

// --- 根据 due_date 查询 ---
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

// --- 根据 category 查询 ---
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

// --- 添加待办事项 ---
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

// --- 修改待办事项 ---
async function updateTodoItem(
  id: number,
  updates: Partial<Omit<TodoItemRow, 'id' | 'created_at'>>
): Promise<boolean> {
  return withOrm('updateTodoItem', async (db) => {
    // PgUpdateSetSource 允许每个字段取字面值或 SQL 表达式（now() 等）
    const patch: PgUpdateSetSource<typeof todo_items> = {}

    if (updates.title !== undefined) patch.title = updates.title
    if (updates.content !== undefined) patch.content = updates.content
    if (updates.due_date !== undefined) patch.due_date = updates.due_date
    if (updates.priority !== undefined) patch.priority = updates.priority
    if (updates.status !== undefined) {
      patch.status = updates.status
      // 时间戳随状态推进/回退（修复：①status=1 时调用方若同传 started_at 会 SET 同列两次
      // 导致整条 UPDATE 失败；②状态回退时时间戳残留，前端按时间戳判状态会错）
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
    // 与原实现一致：updated_at 未显式给出时一律刷新（原实现的「无字段可更新」早退分支因此不可达）
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

// --- 删除待办事项 ---
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
