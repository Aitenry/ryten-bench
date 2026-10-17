import { index, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core'

/**
 * 工作区种类：
 * - `user`：用户在「工作」模式下自己选目录建的工作区（默认，老数据一律按它算）；
 * - `plugin`：插件会话的工作目录（= 插件源码目录，见 harness 的 main/workshop/workspace.ts）；
 * - `chat`：**「对话」模式**的工作目录（应用自己按系统初始化的目录，见 main/chat/workspace.ts）。
 *
 * 为什么要显式记一列，而不是像原来那样靠「路径是不是插件根的直接子目录」现算：
 * 侧栏要把后两种都从「工作」列表里滤掉，判据必须是行自己的属性——否则插件根一改配置、
 * 或者用户恰好把工作区选在插件根下面，同一条记录就会被两个列表都说成是自己那一类。
 */
export type WorkspaceKind = 'user' | 'plugin' | 'chat'

/** 工作区表：harness_topic / agent_config 通过 workspace_id 外键挂在其下并被级联删除 */
export const workspace = pgTable(
  'workspace',
  {
    id: serial().primaryKey().notNull(),
    name: text().notNull(),
    path: text().notNull(),
    /** 工作区种类（见 WorkspaceKind）；建表默认 'user'，老数据不必回填 */
    kind: text().$type<WorkspaceKind>().default('user'),
    created_at: timestamp({ mode: 'string' }).defaultNow(),
    updated_at: timestamp({ mode: 'string' }).defaultNow()
  },
  (table) => [
    unique('workspace_path_key').on(table.path),
    index('idx_workspace_kind').using('btree', table.kind.asc().nullsLast().op('text_ops'))
  ]
)
