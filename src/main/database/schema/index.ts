/**
 * Database schema (drizzle ORM single source of truth).
 *
 * Conventions:
 * - Column names are always omitted (`serial()` instead of `serial('id')`); the TS key name is
 *   the database column name, kept snake_case. Therefore do **not** pass `casing: 'camelCase'`
 *   to `drizzle()`, or column names will be rewritten.
 * - Foreign key dependencies between domain modules are resolved via imports; mind the
 *   declaration order (referenced tables must be defined first).
 * - After changing the structure, run `pnpm drizzle-kit generate`; the generated SQL goes into
 *   the drizzle/ directory and is applied by the migrator at startup.
 * - Tables for system features (AI assistant / knowledge base) also live in this repository; the
 *   single source of truth is `src/main/database/schema/{harness,notes}/*.ts`, aggregated here via
 *   export *; drizzle-kit does not resolve tsconfig paths, so `drizzle.config.ts` lists them
 *   explicitly with relative paths.
 * - **Tables of standalone (third-party) plugins are not here**: `task-planner` /
 *   `music-player` have been moved out of the application repository, so their tables are
 *   created idempotently by the plugins themselves on load (each in its own `main/db/ddl.ts`).
 *   Those two table groups still exist in old databases (created back then by this repository's
 *   baseline migration), so upgrades lose no data; a fresh install only creates them once the
 *   plugins are installed.
 *   ⚠️ They are deliberately kept in the migration snapshots (see drizzle/0007_*: the drop-table
 *   statements were manually commented out), otherwise `drizzle-kit generate` would emit
 *   `DROP TABLE` and delete user data.
 */
export * from './common'
export * from './workspace'
// System feature tables (AI assistant / knowledge base): ordered by foreign key dependency
// AI assistant (file-change depends on harness_topic, agent depends on workspace)
export * from './harness/harness'
export * from './harness/file-change'
export * from './harness/agent'
export * from './harness/subagent-session'
export * from './harness/team-board'
export * from './harness/team-task-event'
export * from './harness/scheduled'
export * from './harness/topic-agent-config'
// Knowledge base (document depends on wiki, graph depends on wiki)
export * from './notes/todo'
export * from './notes/wiki'
export * from './notes/document'
export * from './notes/graph'
export * from './provider'
export * from './search'



