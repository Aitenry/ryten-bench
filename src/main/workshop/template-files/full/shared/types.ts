/**
 * ${vars.title} 的跨进程契约（主进程 mapper 与渲染层组件共用）。
 *
 * 规矩：**不 import drizzle / electron / node**——渲染层也要 import 它，
 * 带上任何一端的东西都会把那一端打进另一端的产物。
 */

/** 一条记录（表 ${vars.itemsToolName} 的一行） */
export interface ${vars.pascal}Item {
  id: number
  title: string
  note: string
  done: boolean
  createdAt: string | null
  updatedAt: string | null
}

/** 新建/修改的入参（id 与时间戳由数据库管） */
export interface ${vars.pascal}ItemInput {
  title: string
  note?: string
}

/** 设置页里的开关（与应用数据分开存：它是配置，不是记录） */
export interface ${vars.pascal}Settings {
  enabled: boolean
  note: string
}

/** 页面一次拉全的量（记录 + 设置） */
export interface ${vars.pascal}State {
  items: ${vars.pascal}Item[]
  settings: ${vars.pascal}Settings
}
