import logger from 'electron-log'
import { mainMessages } from '../../../../main/i18n'
import type { MainIpcHandlers } from '../../../../main/plugins/context'
import { deleteNodePosition } from '../db/mapper/node-position'
import {
  getTodoItemById,
  getTodoItemByTitle,
  getTodoItemsByPriority,
  getTodoItemsByStatus,
  getAllTodoItems,
  getTodoItemsPaginated,
  getTodoItemsByDueDate,
  deleteTodoItem,
  updateTodoItem,
  addTodoItem,
  TodoItemRow
} from '../db/mapper/todo'
import {
  addDependency,
  deleteDependency,
  deleteAllDependenciesForTask,
  getAllDependencies,
  getAllTasksWithDependencies
} from '../db/mapper/todo-dependencies'

/**
 * 待办事项 + 任务依赖关系 IPC 处理器表（notes 插件的第 1 个域）。
 *
 * 通道名一律 `plugin:notes:<channel>`（命名空间 = manifest.id）；由 `main/index.ts`
 * 交给 `ctx.registerIpc`，插件停用时随 ctx.dispose() 一次性摘除。
 *
 * 迁移说明：原 `src/main/ipc/todo.ts` 的 14 个扁平通道（`todo-items-*` / `task-deps-*`）
 * 逐个改名，参数与返回类型不变，只去掉 ipcMain 的 `_event` 形参。
 */
export const todoIpcHandlers: MainIpcHandlers = {
  'plugin:notes:todo-items-get-by-id': async (id: number) => {
    try {
      return await getTodoItemById(id)
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-get-by-id:', error)
      throw error
    }
  },

  'plugin:notes:todo-items-get-by-title': async (title: string) => {
    try {
      return await getTodoItemByTitle(title)
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-get-by-title:', error)
      throw error
    }
  },

  'plugin:notes:todo-items-get-by-priority': async (priority: number) => {
    try {
      return await getTodoItemsByPriority(priority)
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-get-by-priority:', error)
      throw error
    }
  },

  'plugin:notes:todo-items-get-by-completed-status': async (status: number | boolean) => {
    try {
      // 修复：此前错接成 getTodoItemsByPriority（按优先级查询），语义损坏；
      // 兼容布尔（true=已完成=2 / false=未完成=0）与数字两种口径
      const normalized = typeof status === 'boolean' ? (status ? 2 : 0) : status
      if (![0, 1, 2].includes(normalized)) {
        throw new Error(mainMessages().error.invalidStatus)
      }
      return await getTodoItemsByStatus(normalized)
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-get-by-completed-status:', error)
      throw error
    }
  },

  'plugin:notes:todo-items-get-schedule': async () => {
    try {
      return await getAllTodoItems()
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-get-schedule:', error)
      throw error
    }
  },

  'plugin:notes:todo-items-get-paginated': async (page: number, pageSize: number) => {
    try {
      return await getTodoItemsPaginated(page, pageSize)
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-get-paginated:', error)
      throw error
    }
  },

  'plugin:notes:todo-items-get-by-due-date': async (dueDate: string) => {
    try {
      return await getTodoItemsByDueDate(dueDate)
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-get-by-due-date:', error)
      throw error
    }
  },

  'plugin:notes:todo-items-add': async (todoItem: Omit<TodoItemRow, 'id'>) => {
    try {
      return await addTodoItem(todoItem)
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-add:', error)
      throw error
    }
  },

  'plugin:notes:todo-items-update': async (
    id: number,
    updates: Partial<Omit<TodoItemRow, 'id'>>
  ) => {
    try {
      // 状态枚举校验（修复：此前可写任意整数,前端只认 0/1/2；null 同样拒绝）
      if (updates.status !== undefined && ![0, 1, 2].includes(updates.status ?? -1)) {
        throw new Error(mainMessages().error.invalidStatus)
      }
      return await updateTodoItem(id, updates)
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-update:', error)
      throw error
    }
  },

  'plugin:notes:todo-items-delete': async (id: number) => {
    try {
      const result = await deleteTodoItem(id)
      // 同时清理该任务的所有依赖关系
      deleteAllDependenciesForTask(id).catch((err) =>
        logger.error('Failed to delete dependencies for todo:', err)
      )
      deleteNodePosition(`todo-${id}`).catch((err) =>
        logger.error('Failed to delete node position for todo:', err)
      )
      return result
    } catch (error) {
      console.error('Error in plugin:notes:todo-items-delete:', error)
      throw error
    }
  },

  // --- 任务依赖关系 ---
  'plugin:notes:task-deps-add': async (taskId: number, dependsOnTaskId: number) => {
    try {
      return await addDependency(taskId, dependsOnTaskId)
    } catch (error) {
      console.error('Error in plugin:notes:task-deps-add:', error)
      throw error
    }
  },

  'plugin:notes:task-deps-delete': async (taskId: number, dependsOnTaskId: number) => {
    try {
      return await deleteDependency(taskId, dependsOnTaskId)
    } catch (error) {
      console.error('Error in plugin:notes:task-deps-delete:', error)
      throw error
    }
  },

  'plugin:notes:task-deps-get-all': async () => {
    try {
      return await getAllDependencies()
    } catch (error) {
      console.error('Error in plugin:notes:task-deps-get-all:', error)
      throw error
    }
  },

  'plugin:notes:task-deps-get-with-tasks': async () => {
    try {
      return await getAllTasksWithDependencies()
    } catch (error) {
      console.error('Error in plugin:notes:task-deps-get-with-tasks:', error)
      throw error
    }
  }
}

export default todoIpcHandlers
