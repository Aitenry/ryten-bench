import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { PGlite } from '@electric-sql/pglite'
import logger from 'electron-log'
import { getDatabaseInstance } from './instance'
import * as schema from './schema'

/** Drizzle instance type (schema attached, so `db.query.xxx` relational queries work) */
export type Orm = PgliteDatabase<typeof schema>
// Drizzle is just a thin wrapper over the PGlite client, so caching per client is enough;
// when the client is rebuilt (reconnect after close) the cache invalidates automatically,
// so it never points at a stale connection.
let cached: { client: PGlite; orm: Orm } | null = null

function ormFor(client: PGlite): Orm {
  if (!cached || cached.client !== client) {
    cached = { client, orm: drizzle(client, { schema }) }
  }
  return cached.orm
}

/**
 * Get the drizzle instance for the given client.
 * Migration code during initialization (before the database is exposed to the rest of the app)
 * uses this entry point to avoid depending on getDatabaseInstance().
 */
export function ormForClient(client: PGlite): Orm {
  return ormFor(client)
}

/**
 * Get the drizzle instance for the current database.
 * Like `getDatabaseInstance()` it waits for initialization to finish, so call it only after
 * initialization.
 */
export async function getOrm(): Promise<Orm> {
  return ormFor((await getDatabaseInstance()).getDatabase())
}

/**
 * Migrations directory: in development it reads drizzle/ at the repo root; after packaging it is
 * copied via extraResources to resources/database/drizzle.
 */
export function getMigrationsFolder(): string {
  /**
   * Prefer the migrations directory shipped with the package; fall back to drizzle/ at the repo
   * root when it does not exist.
   *
   * Why the fallback: under some launch modes (`electron .` / preview) `app.isPackaged` can still
   * be true while `process.resourcesPath` points at Electron's own resources, which contain no
   * migration files for this project — judging only by isPackaged would stop startup at
   * "migrations missing" instead of actually running. Whether the directory exists is a more
   * reliable criterion.
   */
  const packaged = path.join(process.resourcesPath, 'database', 'drizzle')
  if (fs.existsSync(path.join(packaged, 'meta', '_journal.json'))) return packaged
  return path.join(app.getAppPath(), 'drizzle')
}

/**
 * Apply all pending migrations (idempotent).
 *
 * Applied migrations are recorded in drizzle.__drizzle_migrations, so repeated calls do not run
 * them again; the whole run happens in a single transaction and rolls back entirely on failure,
 * leaving no half-applied structure.
 * During initialization it uses the already-connected but not-yet-exposed client, avoiding a
 * dependency on getDatabaseInstance().
 */
export async function runMigrations(client: PGlite): Promise<void> {
  const folder = getMigrationsFolder()
  logger.info(`[Database] Applying migrations from ${folder}`)
  await migrate(ormFor(client), { migrationsFolder: folder })
  logger.info('[Database] Migrations up to date')
}

/**
 * Unified mapper entry point: injects the drizzle instance and handles exception logging.
 *
 * Replaces the `const db = (await getDatabaseInstance()).getDatabase()` and
 * `try { ... } catch (error) { logger.error(...); throw error }` boilerplate that every function
 * used to repeat; exceptions are still rethrown (the IPC layer needs the original error), they are
 * just logged once here.
 *
 * @param op operation name, used for logging only, e.g. 'saveImage'
 */
export async function withOrm<T>(op: string, fn: (db: Orm) => Promise<T>): Promise<T> {
  try {
    return await fn(await getOrm())
  } catch (error) {
    logger.error(`[Database] ${op} failed:`, error)
    throw error
  }
}
