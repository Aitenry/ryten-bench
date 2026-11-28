import { and, asc, eq, getTableColumns, or } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '../../orm'
import { task_dependencies, todo_items } from '../../schema'
import type { TodoItemRow } from './todo'

/** Todo dependency row (fields inferred from schema) */
export type TaskDependencyRow = typeof task_dependencies.$inferSelect

/** Task info with dependencies */
export interface TaskWithDependencies extends TodoItemRow {
  dependencies: number[] // IDs of prerequisite tasks this task depends on
  dependents: number[] // IDs of tasks that depend on this task
}

// --- Add a dependency ---
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

// --- Delete a dependency ---
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

// --- Delete all dependencies of a task (as either prerequisite or dependent) ---
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

// --- Get the direct prerequisites of a task ---
async function getDirectDependencies(taskId: number): Promise<TaskDependencyRow[]> {
  return withOrm('getDirectDependencies', async (db) => {
    return db.select().from(task_dependencies).where(eq(task_dependencies.task_id, taskId))
  })
}

// --- Get the dependents of a task (tasks that depend on it) ---
async function getDependents(taskId: number): Promise<TaskDependencyRow[]> {
  return withOrm('getDependents', async (db) => {
    return db
      .select()
      .from(task_dependencies)
      .where(eq(task_dependencies.depends_on_task_id, taskId))
  })
}

// --- Get all dependencies ---
async function getAllDependencies(): Promise<TaskDependencyRow[]> {
  return withOrm('getAllDependencies', async (db) => {
    // INNER JOIN only filters out dangling dependencies whose task has been deleted (todos are now global data and no longer filtered by workspace)
    return db
      .select({ ...getTableColumns(task_dependencies) })
      .from(task_dependencies)
      .innerJoin(todo_items, eq(todo_items.id, task_dependencies.task_id))
      .orderBy(asc(task_dependencies.task_id))
  })
}

// --- Get all tasks with their dependencies (for the Gantt chart) ---
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
