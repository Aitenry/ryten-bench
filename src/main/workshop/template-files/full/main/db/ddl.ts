import { sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'

/**
 * ${vars.title} **creates its own tables** (an independent plugin owns its DDL).
 *
 * Three constraints:
 * - **Idempotent**: always `IF NOT EXISTS`; it runs on every plugin load;
 * - **Upgrades only add**: to add a column later, append an `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
 *   and write data migrations as idempotent UPDATEs guarded by `WHERE`; **never drop columns or
 *   change column types** (old data would be lost);
 * - **Only touch your own tables**: table names carry the plugin prefix; never touch other
 *   plugins' tables or the host's;
 * - **Callable during loading**: the host loads the plugin main module **before database
 *   initialization** (`initPluginHost()` runs before `createLoadingWindow()`), so you cannot
 *   assume the database is ready here at load time. The host's `withOrm` waits for the database
 *   to be ready (guaranteed on the host side by `database/instance.ts`), so the immediately
 *   executed promise below is safe — but **do not await it synchronously during loading**, and do
 *   not "read the database first, then export synchronous state".
 */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ${vars.itemsToolName} (
     id         SERIAL PRIMARY KEY,
     title      TEXT NOT NULL,
     note       TEXT,
     done       BOOLEAN DEFAULT FALSE,
     created_at TIMESTAMP DEFAULT NOW(),
     updated_at TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_${vars.itemsToolName}_created ON ${vars.itemsToolName}(created_at DESC)`
]

/** Schema promise: mapper / purge both await it first so no access runs before the tables exist */
export const schemaReady: Promise<void> = (async () => {
  await withOrm('${vars.id}.ensureSchema', async (db) => {
    for (const statement of DDL) await db.execute(sql.raw(statement))
  })
  logger.info('[${vars.id}] Schema ready (${vars.itemsToolName})')
})().catch((err) => {
  logger.error('[${vars.id}] Failed to create tables, plugin cannot read or write data:', err)
  throw err
})
