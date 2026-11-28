import { getMainLanguage } from './index'

/**
 * Result texts for the **todo tools** (used by the manage_materials todo.* commands; they are
 * rendered on tool cards and follow the UI language).
 *
 * Priority numbering matches the UI: 0=P0 (highest) ... 7=P7 (lowest); the old "1=urgent"
 * mapping is gone.
 */
export const zhCNTodoToolTexts = {
  /** Fallback hint for an unknown command */
  common: {
    unknownCommand: '未知命令：{{command}}。支持：{{supported}}'
  },

  todos: {
    listHeader_one: '**待办列表**（共 {{count}} 项）\n',
    listHeader_other: '**待办列表**（共 {{count}} 项）\n',
    listPage: '（第 {{page}}/{{pages}} 页，共 {{total}} 项）',
    pageEmpty: '第 {{page}} 页没有待办（共 {{total}} 项；用 page 参数翻页）。',
    empty: '没有找到待办事项。',
    /** Status labels; the index is the numeric value stored in the database */
    statusLabels: {
      todo: '待办',
      inProgress: '进行中',
      done: '已完成',
      unknown: '状态{{status}}'
    },
    priorityValue: 'P{{priority}}',
    meta: {
      status: '状态：{{status}}',
      priority: '优先级：{{priority}}',
      due: '截止：{{dueDate}}',
      category: '分类：{{category}}',
      created: '创建：{{createdAt}}',
      updated: '更新：{{updatedAt}}',
      started: '开始：{{startedAt}}',
      completed: '完成：{{completedAt}}'
    },
    getHeader: '**{{title}}** [{{todoId}}]',
    noContent: '（无正文）',
    titleRequired: '待办标题不能为空。',
    invalidPriority: '优先级必须是 0–7 的整数（0=P0 最高，7=P7 最低）。',
    invalidStatus: '状态必须是 0（待办）、1（进行中）或 2（已完成）。',
    invalidDueDate: '截止日期格式必须是 YYYY-MM-DD。',
    noFieldsToUpdate: '没有需要更新的字段。',
    idsRequired: '没有提供待办 ID。',
    created: '已创建待办：[{{id}}] {{title}}（优先级 P{{priority}}{{due}}）',
    createdDue: '，截止 {{dueDate}}',
    updated: '已更新待办 [{{id}}] {{title}}',
    deleted: '已删除待办 [{{id}}] {{title}}',
    notFound: '未找到 ID 为 {{id}} 的待办事项。',
    bulkUpdated: '已批量更新 {{count}} 项待办。{{missing}}',
    bulkMissing: '未找到：{{ids}}'
  }
}

export const enUSTodoToolTexts: typeof zhCNTodoToolTexts = {
  common: {
    unknownCommand: 'Unknown command: {{command}}. Supported: {{supported}}'
  },

  todos: {
    listHeader_one: '**Todo list** ({{count}} item)\n',
    listHeader_other: '**Todo list** ({{count}} items)\n',
    listPage: '(page {{page}}/{{pages}}, {{total}} items)',
    pageEmpty: 'No todos on page {{page}} ({{total}} items total; use the page parameter).',
    empty: 'No todo items found.',
    statusLabels: {
      todo: 'To do',
      inProgress: 'In progress',
      done: 'Done',
      unknown: 'Status {{status}}'
    },
    priorityValue: 'P{{priority}}',
    meta: {
      status: 'Status: {{status}}',
      priority: 'Priority: {{priority}}',
      due: 'Due: {{dueDate}}',
      category: 'Category: {{category}}',
      created: 'Created: {{createdAt}}',
      updated: 'Updated: {{updatedAt}}',
      started: 'Started: {{startedAt}}',
      completed: 'Completed: {{completedAt}}'
    },
    getHeader: '**{{title}}** [{{todoId}}]',
    noContent: '(no body)',
    titleRequired: 'Todo title cannot be empty.',
    invalidPriority: 'Priority must be an integer from 0 to 7 (0=P0 highest, 7=P7 lowest).',
    invalidStatus: 'Status must be 0 (todo), 1 (in progress) or 2 (done).',
    invalidDueDate: 'Due date must use the YYYY-MM-DD format.',
    noFieldsToUpdate: 'No fields to update.',
    idsRequired: 'No todo IDs were provided.',
    created: 'Created todo: [{{id}}] {{title}} (priority P{{priority}}{{due}})',
    createdDue: ', due {{dueDate}}',
    updated: 'Updated todo [{{id}}] {{title}}',
    deleted: 'Deleted todo [{{id}}] {{title}}',
    notFound: 'No todo item found with ID {{id}}.',
    bulkUpdated: 'Updated {{count}} todo items.{{missing}}',
    bulkMissing: ' Not found: {{ids}}'
  }
}

export function getTodoToolTexts(): typeof zhCNTodoToolTexts {
  return getMainLanguage() === 'en-US' ? enUSTodoToolTexts : zhCNTodoToolTexts
}
