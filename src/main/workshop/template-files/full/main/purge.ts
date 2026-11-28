import * as fs from 'fs'
import logger from 'electron-log'
import { deleteAllItems } from './db/mapper'
import { settingsFilePath } from './ipc'

/**
 * Data purge implementation for ${vars.title} (the `plugin.purge` contribution).
 *
 * The host calls this when the user uninstalls the plugin with "delete all data for this plugin"
 * checked. It does two things:
 * 1. **Deletes its own table rows** (never touches other tables);
 * 2. **Deletes app-managed data** (here the settings file; if you also manage directories, delete
 *    only the layer you created — the user's own source files are never touched).
 *
 * The table schema stays untouched: migrations are managed by the host, and the migration records
 * must remain consistent after uninstall.
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
    // File is locked: warn only, do not block uninstall (the table rows are already gone)
    logger.warn('[${vars.id}] Failed to clean up settings file:', err)
  }
  logger.info(
    '[${vars.id}] Purged plugin data: ' + removed + ' records, settings file ' + (removedFile ? 'deleted' : 'not found')
  )
}
