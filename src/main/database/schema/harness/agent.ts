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
import { workspace } from '../workspace'

/** Subagent (assistant) config table: isolated per workspace; name is unique within a workspace */
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
    /** Config revision: incremented on every update (a lightweight counterpart of agent preset revisions; keeps session snapshots traceable) */
    revision: integer().notNull().default(0),
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
