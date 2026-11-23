import * as fs from 'fs'
import logger from 'electron-log'
import { deleteAllItems } from './db/mapper'
import { settingsFilePath } from './ipc'

/**
 * ${vars.title} 的清数据实现（`plugin.purge` 贡献）。
 *
 * 用户卸载插件并勾了「同时删除该插件的全部数据」时由宿主调用，做两件事：
 * 1. **删自己的表行**（绝不碰别的表）；
 * 2. **删应用托管的数据**（这里是设置文件；如果你还托管了目录，也只删自己建的那一层，
 *    用户自己选的原始文件一律不动）。
 *
 * 表结构不动：迁移由宿主统一管，卸载后迁移记录必须保持一致。
 */
export async function purgePluginData(): Promise<void> {
  const removed = await deleteAllItems()
  let removedFile = false
  try {
    const file = settingsFilePath()
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      removedFile = true
    }
  } catch (err) {
    // 文件被占用：只告警，不阻塞卸载（表行已经删干净了）
    logger.warn('[${vars.id}] Failed to clean up settings file:', err)
  }
  logger.info(
    '[${vars.id}] Purged plugin data: ' + removed + ' records, settings file ' + (removedFile ? 'deleted' : 'not found')
  )
}
