import * as path from 'path'
import { app } from 'electron'
import { PGlite } from '@electric-sql/pglite'
import * as fs from 'fs/promises'
import logger from 'electron-log'

// 注意：不要在数据库模块里改 `logger.transports.file.fileName`。
// electron-log 是全进程单例，这里若再设一次（历史上曾设成 database.log），
// 最终落盘文件会取决于模块求值顺序；统一由 src/main/index.ts 配置 main.log。

/**
 * 数据库数据目录（备份/重建时由启动流程使用）。
 *
 * 必须**每次现取**，不能在模块顶层算成常量：userData 由 `src/main/environment`
 * 在启动最早期按环境改写（开发态 `ryten-bench-dev`、打包态 `ryten-bench`），
 * 模块求值顺序一变，常量就会把路径钉在另一套环境的目录上。
 */
export function getDatabaseDir(): string {
  return path.join(app.getPath('userData'), 'RytenBenchDB')
}

export class Database {
  private db: PGlite | null = null

  constructor() {
    // 构造函数不自动初始化
  }

  /** 连接数据库（创建 PGlite 实例并确保数据目录存在） */
  async connect(): Promise<void> {
    if (this.db) {
      logger.warn('Database already connected')
      return
    }

    // 确保目录存在（路径在这一刻才取，见 getDatabaseDir 的说明）
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
 * 工厂函数 - 创建并连接数据库。
 * 建表结构由 `runMigrations()` 按 drizzle 迁移文件应用（见 ./orm.ts），本类只负责连接生命周期。
 */
export async function createDatabase(): Promise<Database> {
  const database = new Database()
  await database.connect()
  return database
}
