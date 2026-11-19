import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  index,
  foreignKey,
  unique
} from 'drizzle-orm/pg-core'
import { workspace } from '../../../../../main/database/schema/workspace'

/** 子代理（助手）配置表：按工作区隔离，同一工作区内 name 唯一 */
export const agent_config = pgTable(
  'agent_config',
  {
    id: serial().primaryKey().notNull(),
    workspace_id: integer().notNull(),
    name: text().notNull(),
    rename: text(),
    prompt: text(),
    description: text(),
    skills: text(),
    model: text(),
    tools: text(),
    enable: boolean().default(true),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    index('idx_agent_config_enable').using('btree', table.enable.asc().nullsLast().op('bool_ops')),
    index('idx_agent_config_workspace').using(
      'btree',
      table.workspace_id.asc().nullsLast().op('int4_ops')
    ),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: 'agent_config_workspace_id_fkey'
    }).onDelete('cascade'),
    unique('agent_config_workspace_id_name_key').on(table.workspace_id, table.name)
  ]
)
