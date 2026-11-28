import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  foreignKey,
  check
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { workspace } from '../workspace'
import { harness_topic } from './harness'

/**
 * File change kinds:
 * - create  new file (no before state; undo = delete the file)
 * - modify  content changed
 * - delete  file removed (no after state)
 */
export type FileChangeKind = 'create' | 'modify' | 'delete'

/**
 * File change review status:
 * - pending   awaiting user review (shows a badge in the UI; opening the file goes to the diff view
 *             by default)
 * - kept      user confirmed the change
 * - reverted  user reverted it (the file is back to its pre-change content)
 * - obsolete  invalidated because an earlier change was reverted (no longer individually traceable)
 */
export type FileChangeStatus = 'pending' | 'kept' | 'reverted' | 'obsolete'

/**
 * Change sources:
 * - write_file / edit_file  written by the model through built-in file tools (exact before/after
 *                           snapshots)
 * - execute                 captured by the file watcher while the model ran a command (no
 *                           snapshot, notice only)
 * - external                changes from outside the workspace (user saving in another editor, git
 *                           branch switch, etc.)
 * - review                  written after the user picked changes one by one in the diff view (the
 *                           review result is itself a change)
 */
export type FileChangeSource = 'write_file' | 'edit_file' | 'execute' | 'external' | 'review'

/**
 * File change record table: one row per file modification by the model (or an external program),
 * used for traceability and rollback.
 *
 * Design tradeoffs:
 * - **Content snapshots live on disk** (userData/file-history/<workspaceId>/…); the database only
 *   keeps metadata and statistics: a single write_file can write tens of KB, and keeping that in
 *   PGlite permanently would noticeably grow the database;
 * - `has_before` marks whether a rollback snapshot exists; when false we can only report that the
 *   file was changed, not revert it;
 * - topic_id foreign key onDelete set null: deleting a session should not erase the record of who
 *   changed this file at the time;
 * - workspace_id foreign key cascades: deleting a workspace clears its change history too.
 */
export const file_change = pgTable(
  'file_change',
  {
    id: serial().primaryKey().notNull(),
    /** Owning workspace */
    workspace_id: integer().notNull(),
    /** Absolute file path */
    path: text().notNull(),
    /** Workspace-relative path (for display; always forward slashes) */
    rel_path: text().notNull(),
    /** Change kind */
    kind: text().$type<FileChangeKind>().default('modify').notNull(),
    /** Change source */
    source: text().$type<FileChangeSource>().notNull(),
    /** Session id (null for external changes; cleared when the session is deleted) */
    topic_id: integer(),
    /** Tool call id (links back to the tool card in the chat) */
    call_id: text(),
    /** Review status */
    status: text().$type<FileChangeStatus>().default('pending').notNull(),
    /** Whether a before snapshot exists for rollback */
    has_before: integer().default(0).notNull(),
    /** Whether an after snapshot exists (used to rebuild the diff view) */
    has_after: integer().default(0).notNull(),
    /** Diff statistics: lines added / lines removed */
    added: integer().default(0).notNull(),
    removed: integer().default(0).notNull(),
    /** Byte sizes before and after the change */
    before_bytes: integer().default(0).notNull(),
    after_bytes: integer().default(0).notNull(),
    /** Change rationale given by the model (optional; from tool input/session context, currently left empty) */
    note: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    /** Time of user review (keep/revert) */
    reviewed_at: timestamp({ mode: 'string' })
  },
  (table) => [
    index('idx_file_change_workspace_status').using(
      'btree',
      table.workspace_id.asc().nullsLast().op('int4_ops'),
      table.status.asc().nullsLast().op('text_ops')
    ),
    index('idx_file_change_path_created').using(
      'btree',
      table.path.asc().nullsLast().op('text_ops'),
      table.created_at.asc().nullsLast().op('timestamp_ops')
    ),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: 'file_change_workspace_id_fkey'
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.topic_id],
      foreignColumns: [harness_topic.id],
      name: 'file_change_topic_id_fkey'
    }).onDelete('set null'),
    check(
      'file_change_kind_check',
      sql`kind = ANY (ARRAY['create'::text, 'modify'::text, 'delete'::text])`
    ),
    check(
      'file_change_status_check',
      sql`status = ANY (ARRAY['pending'::text, 'kept'::text, 'reverted'::text, 'obsolete'::text])`
    ),
    check(
      'file_change_source_check',
      sql`source = ANY (ARRAY['write_file'::text, 'edit_file'::text, 'execute'::text, 'external'::text, 'review'::text])`
    )
  ]
)
