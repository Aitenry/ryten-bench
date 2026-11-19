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
import { workspace } from '../../../../../main/database/schema/workspace'
import { harness_topic } from './harness'

/**
 * 文件改动类型：
 * - create  新增文件（before 不存在，撤销 = 删除该文件）
 * - modify  内容修改
 * - delete  文件被删除（after 不存在）
 */
export type FileChangeKind = 'create' | 'modify' | 'delete'

/**
 * 文件改动审查状态：
 * - pending   待用户审查（界面显示徽标 + 打开文件时默认进差异视图）
 * - kept      用户已确认保留
 * - reverted  用户已撤销（文件已回到改动前的内容）
 * - obsolete  因更早的改动被撤销而失效（不再可单独回溯）
 */
export type FileChangeStatus = 'pending' | 'kept' | 'reverted' | 'obsolete'

/**
 * 改动来源：
 * - write_file / edit_file  模型通过内置文件工具写入（有精确的前后快照）
 * - execute                 模型执行命令期间被文件监听捕获（无快照，只能提示）
 * - external                工作区外部的改动（用户在别的编辑器里保存、git 切换分支等）
 * - review                  用户在差异视图里逐处取舍后落盘（审查结果本身也是一次改动）
 */
export type FileChangeSource = 'write_file' | 'edit_file' | 'execute' | 'external' | 'review'

/**
 * 文件改动记录表：模型（或外部程序）每改一次文件落一行，供「可追溯 / 可回溯」使用。
 *
 * 设计取舍：
 * - **正文快照放磁盘**（userData/file-history/<workspaceId>/…），库里只存元信息与统计：
 *   一次 write_file 可能写入几十 KB，长期驻留 PGlite 会明显抬高库体积；
 * - `has_before` 标记是否有可回溯的快照；为 false 时只能提示「文件被改过」，不能撤销；
 * - topic_id 外键 onDelete set null：删会话不该抹掉「这个文件当时被谁改的」这笔记账；
 * - workspace_id 外键级联：删工作区时连同它的改动历史一起清理。
 */
export const file_change = pgTable(
  'file_change',
  {
    id: serial().primaryKey().notNull(),
    /** 所属工作区 */
    workspace_id: integer().notNull(),
    /** 文件绝对路径 */
    path: text().notNull(),
    /** 工作区相对路径（展示用，统一正斜杠） */
    rel_path: text().notNull(),
    /** 改动类型 */
    kind: text().$type<FileChangeKind>().default('modify').notNull(),
    /** 改动来源 */
    source: text().$type<FileChangeSource>().notNull(),
    /** 会话 id（外部改动为 null；会话被删除后置空） */
    topic_id: integer(),
    /** 工具调用 id（可回连聊天里的那张工具卡片） */
    call_id: text(),
    /** 审查状态 */
    status: text().$type<FileChangeStatus>().default('pending').notNull(),
    /** 是否有可回溯的前置快照 */
    has_before: integer().default(0).notNull(),
    /** 是否有改动后快照（重建差异视图用） */
    has_after: integer().default(0).notNull(),
    /** 差异统计：新增行数 / 删除行数 */
    added: integer().default(0).notNull(),
    removed: integer().default(0).notNull(),
    /** 改动前后字节数 */
    before_bytes: integer().default(0).notNull(),
    after_bytes: integer().default(0).notNull(),
    /** 模型给出的改动理由（可选，取自工具入参/会话上下文，当前留空） */
    note: text(),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    /** 用户审查（保留/撤销）时间 */
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
