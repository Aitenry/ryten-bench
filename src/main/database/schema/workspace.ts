import { index, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core'

/**
 * Workspace kinds:
 * - `user`: workspace created by the user picking their own directory in "Work" mode (default; legacy rows all count as this);
 * - `plugin`: working directory of a plugin session (= the plugin source directory, see main/workshop/workspace.ts);
 * - `chat`: working directory of **"Chat" mode** (a directory the app initializes itself, see main/chat/workspace.ts).
 *
 * Why record this explicitly instead of deriving it at runtime from "is the path a direct child of
 * the plugin root": the sidebar must filter the latter two out of the "Work" list, so the criterion
 * must be a property of the row itself — otherwise, once the plugin root config changes, or the user
 * happens to pick a workspace under the plugin root, the same row would be claimed as its own by both lists.
 */
export type WorkspaceKind = 'user' | 'plugin' | 'chat'

/** Workspace table: harness_topic / agent_config hang under it via the workspace_id foreign key and are cascade-deleted */
export const workspace = pgTable(
  'workspace',
  {
    id: serial().primaryKey().notNull(),
    name: text().notNull(),
    path: text().notNull(),
    /** Workspace kind (see WorkspaceKind); table default is 'user', legacy rows need no backfill */
    kind: text().$type<WorkspaceKind>().default('user'),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    unique('workspace_path_key').on(table.path),
    index('idx_workspace_kind').using('btree', table.kind.asc().nullsLast().op('text_ops'))
  ]
)
