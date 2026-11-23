import { sql } from 'drizzle-orm'
import logger from 'electron-log'
import { withOrm } from '@host/main/database/orm'

/**
 * ${vars.title} **自带建表**（独立插件的 DDL 归插件自己）。
 *
 * 三条约束：
 * - **幂等**：一律 `IF NOT EXISTS`，插件每次装载都会跑一遍；
 * - **升级只做加法**：以后加列就往下补一条 `ALTER TABLE … ADD COLUMN IF NOT EXISTS`，
 *   数据迁移写成带 `WHERE` 保护的幂等 UPDATE；**不删列、不改列类型**（旧数据会丢）；
 * - **只动自己的表**：表名带插件前缀，绝不碰别的插件或宿主的表；
 * - **装载期就可以调用**：插件主模块是在**数据库初始化之前**被宿主装载的
 *   （`initPluginHost()` 早于 `createLoadingWindow()`），所以这里不能在装载期假设库已就绪。
 *   宿主的 `withOrm` 会等库就绪（宿主侧 `database/instance.ts` 的保证），因此下面这个
 *   立即执行的承诺是安全的——但**别在装载期同步等它**，也不要「先读库再导出同步状态」。
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

/** 建表承诺：mapper / purge 都先 await 它，保证不会有访问跑到建表之前 */
export const schemaReady: Promise<void> = (async () => {
  await withOrm('${vars.id}.ensureSchema', async (db) => {
    for (const statement of DDL) await db.execute(sql.raw(statement))
  })
  logger.info('[${vars.id}] Schema ready (${vars.itemsToolName})')
})().catch((err) => {
  logger.error('[${vars.id}] Failed to create tables, plugin cannot read or write data:', err)
  throw err
})
