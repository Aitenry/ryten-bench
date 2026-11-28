import logger from 'electron-log'
import { mainMessages } from '../../i18n'
import type { IpcHandlerMap } from '../register'
import { deleteNodePosition } from '../../database/mapper/notes/node-position'
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
} from '../../database/mapper/notes/todo'
import {
  addDependency,
  deleteDependency,
  deleteAllDependenciesForTask,
  getAllDependencies,
  getAllTasksWithDependencies
} from '../../database/mapper/notes/todo-dependencies'

/**
 * Todo items + task dependency IPC handler map (the library's first domain).
 *
 * All channel names are `notes:<channel>`; they are mounted at startup by
 * `src/main/system/notes.ts` and removed on exit.
 *
 * Migration note: the 14 flat channels (`todo-items-*` / `task-deps-*`) of the old
 * `src/main/ipc/todo.ts` were renamed one by one, with parameters and return types unchanged and
 * only ipcMain's `_event` parameter dropped.
 */
export const todoIpcHandlers: IpcHandlerMap = {
  'notes:todo-items-get-by-id': async (id: number) => {
    try {
      return await getTodoItemById(id)
    } catch (error) {
      logger.error('Error in notes:todo-items-get-by-id:', error)
      throw error
    }
  },

  'notes:todo-items-get-by-title': async (title: string) => {
    try {
      return await getTodoItemByTitle(title)
    } catch (error) {
      logger.error('Error in notes:todo-items-get-by-title:', error)
      throw error
    }
  },

  'notes:todo-items-get-by-priority': async (priority: number) => {
    try {
      return await getTodoItemsByPriority(priority)
    } catch (error) {
      logger.error('Error in notes:todo-items-get-by-priority:', error)
      throw error
    }
  },

  'notes:todo-items-get-by-completed-status': async (status: number | boolean) => {
    try {
      // Fix: this was previously wired to getTodoItemsByPriority (a priority query), corrupting the
      // semantics; accepts both booleans (true=completed=2 / false=incomplete=0) and numbers
      const normalized = typeof status === 'boolean' ? (status ? 2 : 0) : status
      if (![0, 1, 2].includes(normalized)) {
        throw new Error(mainMessages().error.invalidStatus)
      }
      return await getTodoItemsByStatus(normalized)
    } catch (error) {
      logger.error('Error in notes:todo-items-get-by-completed-status:', error)
      throw error
    }
  },

  'notes:todo-items-get-schedule': async () => {
    try {
      return await getAllTodoItems()
    } catch (error) {
      logger.error('Error in notes:todo-items-get-schedule:', error)
      throw error
    }
  },

  'notes:todo-items-get-paginated': async (page: number, pageSize: number) => {
    try {
      return await getTodoItemsPaginated(page, pageSize)
    } catch (error) {
      logger.error('Error in notes:todo-items-get-paginated:', error)
      throw error
    }
  },

  'notes:todo-items-get-by-due-date': async (dueDate: string) => {
    try {
      return await getTodoItemsByDueDate(dueDate)
    } catch (error) {
      logger.error('Error in notes:todo-items-get-by-due-date:', error)
      throw error
    }
  },

  'notes:todo-items-add': async (todoItem: Omit<TodoItemRow, 'id'>) => {
    try {
      return await addTodoItem(todoItem)
    } catch (error) {
      logger.error('Error in notes:todo-items-add:', error)
      throw error
    }
  },

  'notes:todo-items-update': async (id: number, updates: Partial<Omit<TodoItemRow, 'id'>>) => {
    try {
      // Status enum validation (fix: any integer used to be writable while the frontend only
      // accepts 0/1/2; null is rejected too)
      if (updates.status !== undefined && ![0, 1, 2].includes(updates.status ?? -1)) {
        throw new Error(mainMessages().error.invalidStatus)
      }
      return await updateTodoItem(id, updates)
    } catch (error) {
      logger.error('Error in notes:todo-items-update:', error)
      throw error
    }
  },

  'notes:todo-items-delete': async (id: number) => {
    try {
      const result = await deleteTodoItem(id)
      // Also clean up all dependency relations of this task
      deleteAllDependenciesForTask(id).catch((err) =>
        logger.error('Failed to delete dependencies for todo:', err)
      )
      deleteNodePosition(`todo-${id}`).catch((err) =>
        logger.error('Failed to delete node position for todo:', err)
      )
      return result
    } catch (error) {
      logger.error('Error in notes:todo-items-delete:', error)
      throw error
    }
  },

  // --- Task dependencies ---
  'notes:task-deps-add': async (taskId: number, dependsOnTaskId: number) => {
    try {
      return await addDependency(taskId, dependsOnTaskId)
    } catch (error) {
      logger.error('Error in notes:task-deps-add:', error)
      throw error
    }
  },

  'notes:task-deps-delete': async (taskId: number, dependsOnTaskId: number) => {
    try {
      return await deleteDependency(taskId, dependsOnTaskId)
    } catch (error) {
      logger.error('Error in notes:task-deps-delete:', error)
      throw error
    }
  },

  'notes:task-deps-get-all': async () => {
    try {
      return await getAllDependencies()
    } catch (error) {
      logger.error('Error in notes:task-deps-get-all:', error)
      throw error
    }
  },

  'notes:task-deps-get-with-tasks': async () => {
    try {
      return await getAllTasksWithDependencies()
    } catch (error) {
      logger.error('Error in notes:task-deps-get-with-tasks:', error)
      throw error
    }
  }
}

export default todoIpcHandlers
