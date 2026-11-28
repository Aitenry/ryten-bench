import { defineConfig } from 'drizzle-kit'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * drizzle-kit config (development only, not part of the packaged output).
 *
 * - schema: the TS schema is the single source of truth for the structure; after changing it run
 *   `pnpm drizzle-kit generate` to produce incremental SQL.
 *   The array lists both the core schema directory and the schema files of **system features**
 *   (AI assistant / knowledge base, under `src/main/database/schema/{harness,notes}`) — drizzle-kit
 *   does not resolve tsconfig paths, so their schemas can only be re-exported by core through
 *   relative paths (see database/schema/index.ts); listing them explicitly here keeps drizzle-kit's
 *   TS entry discovery independent of directory traversal order.
 *   **Third-party plugins (task-planner / music-player) are not listed here**: their tables are
 *   created by the plugins themselves (each has its own ddl.ts), and the migration chain only
 *   guarantees that no DROP is generated (see the comment on that migration in drizzle/).
 * - out: migration SQL and snapshot directory, shipped into the installer via extraResources
 *   (database/drizzle) and applied in order at startup by the migrator.
 * - dbCredentials: only used by commands that **need a database connection**, such as `push` /
 *   `pull` / `studio`.
 *
 * ⚠️ Never point this at the data directory the app is using
 * (`app.getPath('userData')/RytenBenchDB`). PGlite is embedded Postgres and has **no
 * cross-process lock**: two processes opening the same data directory at once each write to the
 * same pg_wal / pg_control, producing torn checkpoint records — the 2026-09-18
 * "Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"" incident came from exactly this (the
 * corrupt database diagnosed `invalid xl_info in checkpoint record` /
 * `PANIC: could not locate a valid checkpoint record`).
 * So by default a **separate scratch directory** is provided; when you really need to connect to
 * the real database, pass DRIZZLE_DB_DIR explicitly and quit the app first:
 *
 *   DRIZZLE_DB_DIR="C:\Users\<you>\AppData\Roaming\ryten-bench\RytenBenchDB" pnpm drizzle-kit studio
 *
 * Note the directory differs per environment (see `src/main/environment/`): the release build uses
 * `...\Roaming\ryten-bench\RytenBenchDB`, while `pnpm dev` / `electron .` writes to
 * `...\Roaming\ryten-bench-dev\RytenBenchDB` — don't connect to the wrong one.
 */
export default defineConfig({
  dialect: 'postgresql',
  driver: 'pglite',
  schema: [
    './src/main/database/schema',
    './src/main/database/schema/harness/harness.ts',
    './src/main/database/schema/harness/file-change.ts',
    './src/main/database/schema/harness/agent.ts',
    './src/main/database/schema/harness/subagent-session.ts',
    './src/main/database/schema/harness/team-board.ts',
    './src/main/database/schema/harness/team-task-event.ts',
    './src/main/database/schema/notes/todo.ts',
    './src/main/database/schema/notes/wiki.ts',
    './src/main/database/schema/notes/document.ts',
    './src/main/database/schema/notes/graph.ts'
  ],
  out: './drizzle',
  dbCredentials: {
    // Scratch database: fully isolated from the local app data directory (defaults to the system temp dir)
    url: process.env.DRIZZLE_DB_DIR ?? join(tmpdir(), 'ryten-bench-drizzle-scratch')
  },
  introspect: { casing: 'preserve' },
  migrations: { table: '__drizzle_migrations', schema: 'drizzle' },
  verbose: true
})



