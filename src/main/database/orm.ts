import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { PGlite } from '@electric-sql/pglite'
import logger from 'electron-log'
import { getDatabaseInstance } from './instance'
import * as schema from './schema'

/** drizzle 实例类型（已挂 schema，可用 db.query.xxx 关系查询） */
export type Orm = PgliteDatabase<typeof schema>
// drizzle 只是 PGlite 客户端之上的一层薄封装，按客户端缓存即可；
// 客户端被重建（close 后重连）时缓存自动失效，不会出现指向旧连接的问题。
let cached: { client: PGlite; orm: Orm } | null = null

function ormFor(client: PGlite): Orm {
  if (!cached || cached.client !== client) {
    cached = { client, orm: drizzle(client, { schema }) }
  }
  return cached.orm
}

/**
 * 用指定客户端取 drizzle 实例。
 * 初始化阶段（数据库尚未对外暴露）的迁移代码用这个入口，避免依赖 getDatabaseInstance()。
 */
export function ormForClient(client: PGlite): Orm {
  return ormFor(client)
}

/**
 * 取当前数据库的 drizzle 实例。
 * 与 `getDatabaseInstance()` 一样会等待初始化完成，因此只能在初始化结束后调用。
 */
export async function getOrm(): Promise<Orm> {
  return ormFor((await getDatabaseInstance()).getDatabase())
}

/**
 * 迁移目录：开发模式读仓库根目录的 drizzle/；打包后随 extraResources 复制到 resources/database/drizzle。
 */
export function getMigrationsFolder(): string {
  /**
   * 优先用随包分发的迁移目录；不存在时回退到仓库根目录的 drizzle/。
   *
   * 为什么需要回退：某些启动方式（`electron .` / preview）下 `app.isPackaged`
   * 仍可能为 true，但 `process.resourcesPath` 指向的是 Electron 自己的 resources，
   * 里面没有本项目迁移文件——只按 isPackaged 判断会让启动停在「迁移缺失」，
   * 而不是真正跑起来。迁移目录存在与否是更可靠的判据。
   */
  const packaged = path.join(process.resourcesPath, 'database', 'drizzle')
  if (fs.existsSync(path.join(packaged, 'meta', '_journal.json'))) return packaged
  return path.join(app.getAppPath(), 'drizzle')
}

/**
 * 应用所有待执行的迁移（幂等）。
 *
 * 已应用的迁移记录在 drizzle.__drizzle_migrations 中，重复调用不会重复执行；
 * 全过程在单个事务里完成，失败会整体回滚，不会留下半截结构。
 * 初始化阶段直接用已连接但尚未对外暴露的客户端，避免依赖 getDatabaseInstance()。
 */
export async function runMigrations(client: PGlite): Promise<void> {
  const folder = getMigrationsFolder()
  logger.info(`[Database] Applying migrations from ${folder}`)
  await migrate(ormFor(client), { migrationsFolder: folder })
  logger.info('[Database] Migrations up to date')
}

/**
 * mapper 统一入口：注入 drizzle 实例并兜住异常日志。
 *
 * 替代原先每个函数各写一遍的 `const db = (await getDatabaseInstance()).getDatabase()`
 * 与 `try { ... } catch (error) { logger.error(...); throw error }` 样板；
 * 异常仍然向上抛（IPC 层需要拿到原始错误），只是在这里统一记录一次。
 *
 * @param op 操作名，仅用于日志，例如 'saveImage'
 */
export async function withOrm<T>(op: string, fn: (db: Orm) => Promise<T>): Promise<T> {
  try {
    return await fn(await getOrm())
  } catch (error) {
    logger.error(`[Database] ${op} failed:`, error)
    throw error
  }
}
