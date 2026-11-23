import { boolean, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * ${vars.title} 的表。
 *
 * - 表名必须带**本插件的前缀**（`${vars.sqlName}_`）：一个库里装着所有插件的表，撞名就是事故；
 * - 列名 snake_case（与宿主同规矩）；行类型的单一真源就是这里（`$inferSelect`）；
 * - 建表语句在 `./ddl.ts`（独立插件的 DDL 归插件自己，宿主不认识这张表）。
 */
export const ${vars.itemsToolName} = pgTable('${vars.itemsToolName}', {
  id: serial().primaryKey().notNull(),
  title: text().notNull(),
  note: text(),
  done: boolean().default(false),
  created_at: timestamp({ mode: 'string' }).defaultNow(),
  updated_at: timestamp({ mode: 'string' }).defaultNow()
})

/** 一行（mapper 内部用；跨进程一律转成 shared/types.ts 的 DTO） */
export type ${vars.pascal}ItemRow = typeof ${vars.itemsToolName}.$inferSelect
