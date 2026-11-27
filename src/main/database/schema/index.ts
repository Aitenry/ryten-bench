/**
 * 数据库 schema（drizzle ORM 单一真源）。
 *
 * 约定：
 * - 列名一律省略（`serial()` 而不是 `serial('id')`），TS 键名即数据库列名，保持 snake_case。
 *   因此**不要**给 `drizzle()` 传 `casing: 'camelCase'`，否则列名会被改写。
 * - 各领域模块之间的外键依赖靠 import 解决，注意声明顺序（被引用表必须先定义）。
 * - 改结构后执行 `pnpm drizzle-kit generate`，生成的 SQL 进 drizzle/ 目录，启动时由迁移器应用。
 * - 系统功能（AI 助手 / 资料库）的表也在本仓库里，唯一真源是
 *   `src/main/database/schema/{harness,notes}/*.ts`，这里用 export * 汇总；
 *   drizzle-kit 不解析 tsconfig paths，`drizzle.config.ts` 里用相对路径显式列出。
 * - **独立插件（第三方）的表不在这里**：`task-planner` / `music-player` 已移出应用仓库，
 *   它们的建表由插件自己在装载时幂等执行（各自 `main/db/ddl.ts`）。老库里这两组表仍存在
 *   （当年由本仓库的 baseline 迁移建过），因此升级不丢数据；新装则等插件装上才建表。
 *   ⚠️ 迁移链上它们被刻意保留在快照里（见 drizzle/0007_*：删表语句被手工注释掉），
 *   否则 `drizzle-kit generate` 会生成 `DROP TABLE` 把用户数据删掉。
 */
export * from './common'
export * from './workspace'
// 系统功能表（AI 助手 / 资料库）：按外键依赖排序
// AI 助手（file-change 依赖 harness_topic，agent 依赖 workspace）
export * from './harness/harness'
export * from './harness/file-change'
export * from './harness/agent'
export * from './harness/subagent-session'
export * from './harness/team-board'
export * from './harness/team-task-event'
export * from './harness/scheduled'
// 资料库（document 依赖 wiki，graph 依赖 wiki）
export * from './notes/todo'
export * from './notes/wiki'
export * from './notes/document'
export * from './notes/graph'
export * from './provider'
export * from './search'



