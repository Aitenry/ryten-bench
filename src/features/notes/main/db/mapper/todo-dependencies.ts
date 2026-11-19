import { and, asc, eq, getTableColumns, or } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '../../../../../main/database/orm'
import { task_dependencies, todo_items } from '../../../../../main/database/schema'
import type { TodoItemRow } from './todo'

/** 待办依赖关系行（字段由 schema 推导） */
export type TaskDependencyRow = typeof task_dependencies.$inferSelect

/** 带依赖关系的任务信息 */
export interface TaskWithDependencies extends TodoItemRow {
  dependencies: number[] // 该任务依赖的前置任务 ID 列表
  dependents: number[] // 依赖该任务的后置任务 ID 列表
}

// --- 添加依赖关系 ---
async function addDependency(taskId: number, dependsOnTaskId: number): Promise<number> {
  return withOrm('addDependency', async (db) => {
    const rows = await db
      .insert(task_dependencies)
      .values({ task_id: taskId, depends_on_task_id: dependsOnTaskId })
      .returning({ id: task_dependencies.id })
    const newId = rows[0].id
    logger.info(`Added dependency: task ${taskId} depends on ${dependsOnTaskId}, id=${newId}`)
    return newId
  })
}

// --- 删除依赖关系 ---
async function deleteDependency(taskId: number, dependsOnTaskId: number): Promise<boolean> {
  return withOrm('deleteDependency', async (db) => {
    const deleted = await db
      .delete(task_dependencies)
      .where(
        and(
          eq(task_dependencies.task_id, taskId),
          eq(task_dependencies.depends_on_task_id, dependsOnTaskId)
        )
      )
      .returning({ id: task_dependencies.id })
    logger.info(
      `Deleted dependency: task ${taskId} -> depends on ${dependsOnTaskId}, ${deleted.length} row(s) affected.`
    )
    return deleted.length > 0
  })
}

// --- 删除某个任务的所有依赖（作为前置或后置） ---
async function deleteAllDependenciesForTask(taskId: number): Promise<number> {
  return withOrm('deleteAllDependenciesForTask', async (db) => {
    const deleted = await db
      .delete(task_dependencies)
      .where(
        or(eq(task_dependencies.task_id, taskId), eq(task_dependencies.depends_on_task_id, taskId))
      )
      .returning({ id: task_dependencies.id })
    logger.info(`Deleted ${deleted.length} dependency row(s) for task ${taskId}.`)
    return deleted.length
  })
}

// --- 获取某个任务的直接前置依赖 ---
async function getDirectDependencies(taskId: number): Promise<TaskDependencyRow[]> {
  return withOrm('getDirectDependencies', async (db) => {
    return db.select().from(task_dependencies).where(eq(task_dependencies.task_id, taskId))
  })
}

// --- 获取某个任务的后置依赖（哪些任务依赖它） ---
async function getDependents(taskId: number): Promise<TaskDependencyRow[]> {
  return withOrm('getDependents', async (db) => {
    return db
      .select()
      .from(task_dependencies)
      .where(eq(task_dependencies.depends_on_task_id, taskId))
  })
}

// --- 获取所有依赖关系 ---
async function getAllDependencies(): Promise<TaskDependencyRow[]> {
  return withOrm('getAllDependencies', async (db) => {
    // INNER JOIN 仅用于滤掉任务已删除的悬空依赖（待办已改为全局数据，不再按工作区过滤）
    return db
      .select({ ...getTableColumns(task_dependencies) })
      .from(task_dependencies)
      .innerJoin(todo_items, eq(todo_items.id, task_dependencies.task_id))
      .orderBy(asc(task_dependencies.task_id))
  })
}

// --- 获取所有任务及其依赖关系（用于甘特图） ---
async function getAllTasksWithDependencies(): Promise<TaskWithDependencies[]> {
  return withOrm('getAllTasksWithDependencies', async (db) => {
    const tasks = await db
      .select()
      .from(todo_items)
      .orderBy(asc(todo_items.priority), asc(todo_items.due_date))

    const allDeps = await db
      .select({ ...getTableColumns(task_dependencies) })
      .from(task_dependencies)
      .innerJoin(todo_items, eq(todo_items.id, task_dependencies.task_id))

    const taskMap = new Map<number, TaskWithDependencies>()
    for (const task of tasks) {
      taskMap.set(task.id, {
        ...task,
        dependencies: [],
        dependents: []
      })
    }

    for (const dep of allDeps) {
      const task = taskMap.get(dep.task_id)
      if (task) {
        task.dependencies.push(dep.depends_on_task_id)
      }
      const predecessor = taskMap.get(dep.depends_on_task_id)
      if (predecessor) {
        predecessor.dependents.push(dep.task_id)
      }
    }

    logger.info(
      `Loaded ${tasks.length} tasks with ${allDeps.length} dependency relations for Gantt chart.`
    )
    return Array.from(taskMap.values())
  })
}

export {
  addDependency,
  deleteDependency,
  deleteAllDependenciesForTask,
  getDirectDependencies,
  getDependents,
  getAllDependencies,
  getAllTasksWithDependencies
}
