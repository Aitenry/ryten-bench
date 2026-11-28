import * as path from 'path'
import { app } from 'electron'
import { PGlite } from '@electric-sql/pglite'
import * as fs from 'fs/promises'
import logger from 'electron-log'

// Note: do not change `logger.transports.file.fileName` inside database modules.
// electron-log is a process-wide singleton; setting it again here (historically to database.log)
// would make the final on-disk file depend on module evaluation order. Configure it centrally
// in src/main/index.ts (main.log) instead.

/**
 * Database data directory (used by the startup flow for backup/rebuild).
 *
 * It must be read **fresh each time** and not computed as a module-level constant: userData is
 * rewritten by `src/main/environment` at the very beginning of startup depending on the
 * environment (dev `ryten-bench-dev`, packaged `ryten-bench`), so a change in module evaluation
 * order would pin the constant to another environment's directory.
 */
export function getDatabaseDir(): string {
  return path.join(app.getPath('userData'), 'RytenBenchDB')
}

export class Database {
  private db: PGlite | null = null

  constructor() {
    // The constructor does not initialize automatically
  }

  /** Connect to the database (creates the PGlite instance and ensures the data directory exists) */
  async connect(): Promise<void> {
    if (this.db) {
      logger.warn('Database already connected')
      return
    }

    // Ensure the directory exists (the path is resolved at this moment; see the note on getDatabaseDir)
    const dbDir = getDatabaseDir()
    await fs.mkdir(dbDir, { recursive: true })

    this.db = new PGlite(dbDir)
    logger.info('Connected to PGLite database at:', dbDir)
  }

  getDatabase(): PGlite {
    if (!this.db) {
      throw new Error('Database not initialized. Call connect() first.')
    }
    return this.db
  }

  isInitialized(): boolean {
    return this.db !== null
  }

  async close(): Promise<void> {
    if (!this.db) {
      logger.warn('Database not initialized, nothing to close')
      return
    }

    await this.db.close()
    logger.info('Database connection closed.')
    this.db = null
  }
}

/**
 * Factory function - creates and connects the database.
 * Table structure is applied by `runMigrations()` from the drizzle migration files (see ./orm.ts);
 * this class only manages the connection lifecycle.
 */
export async function createDatabase(): Promise<Database> {
  const database = new Database()
  await database.connect()
  return database
}
