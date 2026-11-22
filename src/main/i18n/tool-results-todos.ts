import { getMainLanguage } from './index'

/**
 * **待办工具**的返回文案（`manage_todos`，属于 notes 插件，会显示在工具卡片上、跟随界面语言）。
 *
 * 文件名说明：这个模块原先叫 `tool-results-planner.ts`，里面塞了 planner / todos / music 三块
 * ——因为历史上三者都在同一个「计划」工具里。现在 planner 与 music 各自变成独立插件
 * （`task-planner` / `music-player`，发布在 Lattice 插件中心），它们的文案随之搬走，
 * 这里只留 notes 的 `todos`（以及共用的「未知命令」提示），模块名也改成实至名归的 todos。
 *
 * 第三方插件不从这里取文案：它们自带一份自己的（见各插件 `main/tool-texts.ts`）。
 */
export const zhCNTodoToolTexts = {
  /** 未知命令的兜底提示 */
  common: {
    unknownCommand: '未知命令：{{command}}。支持：{{supported}}'
  },

  todos: {
    listHeader_one: '**待办列表**（共 {{count}} 项）\n',
    listHeader_other: '**待办列表**（共 {{count}} 项）\n',
    empty: '没有找到待办事项。',
    /** 状态/优先级标签，下标即库里的数值 */
    statusLabels: {
      todo: '待办',
      inProgress: '进行中',
      done: '已完成',
      unknown: '状态{{status}}'
    },
    priorityLabels: {
      none: '',
      p0: 'P0-紧急',
      p1: 'P1-高',
      p2: 'P2-中',
      p3: 'P3-低'
    },
    meta: {
      status: '状态：{{status}}',
      priority: '优先级：{{priority}}',
      due: '截止：{{dueDate}}',
      category: '分类：{{category}}'
    },
    created: '已创建待办：[{{id}}] {{title}}（优先级 P{{priority}}{{due}}）',
    createdDue: '，截止 {{dueDate}}',
    updated: '已更新待办 [{{id}}] {{title}}',
    deleted: '已删除待办 [{{id}}] {{title}}',
    notFound: '未找到 ID 为 {{id}} 的待办事项。'
  }
}

export const enUSTodoToolTexts: typeof zhCNTodoToolTexts = {
  common: {
    unknownCommand: 'Unknown command: {{command}}. Supported: {{supported}}'
  },

  todos: {
    listHeader_one: '**Todo list** ({{count}} item)\n',
    listHeader_other: '**Todo list** ({{count}} items)\n',
    empty: 'No todo items found.',
    statusLabels: {
      todo: 'To do',
      inProgress: 'In progress',
      done: 'Done',
      unknown: 'Status {{status}}'
    },
    priorityLabels: {
      none: '',
      p0: 'P0-Urgent',
      p1: 'P1-High',
      p2: 'P2-Medium',
      p3: 'P3-Low'
    },
    meta: {
      status: 'Status: {{status}}',
      priority: 'Priority: {{priority}}',
      due: 'Due: {{dueDate}}',
      category: 'Category: {{category}}'
    },
    created: 'Created todo: [{{id}}] {{title}} (priority P{{priority}}{{due}})',
    createdDue: ', due {{dueDate}}',
    updated: 'Updated todo [{{id}}] {{title}}',
    deleted: 'Deleted todo [{{id}}] {{title}}',
    notFound: 'No todo item found with ID {{id}}.'
  }
}

export function getTodoToolTexts(): typeof zhCNTodoToolTexts {
  return getMainLanguage() === 'en-US' ? enUSTodoToolTexts : zhCNTodoToolTexts
}
