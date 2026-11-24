import { app } from 'electron'
import logger from 'electron-log'
import { currentUserDataDir } from './environment'
import { restoreSettingsFile, writeSettingsBackup, type SettingsRecovery } from './settings-file'

/**
 * `settings.json` 的启动自愈与持续备份（Electron 侧胶水）。
 *
 * 纯文件逻辑在 `settings-file.ts`（可单测）；这里只负责：
 * - 在 `context.ts` 构造 electron-store **之前**修复缺失/损坏的设置文件；
 * - store 每次变更后刷新 `settings.backup.json`；
 * - 退出前再补一次，避免最后一次变更还没来得及备份。
 *
 * 恢复结果会交给启动流程：如果是「设置文件丢了、从备份恢复」且锁屏仍启用，
 * 启动时必须直接锁屏（见 windows/startup.ts），否则删文件仍然等于绕过锁屏。
 */

let recovery: SettingsRecovery | null = null
let watcherStarted = false

/** 在 `new Store()` 之前调用（幂等） */
export function recoverSettingsAtStartup(): SettingsRecovery {
  if (recovery) return recovery
  try {
    const result = restoreSettingsFile(currentUserDataDir())
    recovery = result
    if (result.quarantined) {
      logger.warn(`[Settings] Invalid settings.json archived: ${result.quarantined}`)
    }
    if (result.restoredFromBackup) {
      logger.warn(
        '[Settings] settings.json was missing or invalid; restored from settings.backup.json'
      )
    }
    if (result.backupInvalid) {
      logger.warn(
        '[Settings] settings.backup.json is not valid JSON; settings started from defaults'
      )
    }
    return result
  } catch (error) {
    logger.error('[Settings] Failed to inspect settings.json at startup:', error)
    recovery = {
      settingsExisted: false,
      quarantined: null,
      restoredFromBackup: false,
      backupInvalid: false
    }
    return recovery
  }
}

/** 启动时是否发生过「设置文件丢失/损坏」的恢复（启动流程据此强制锁屏） */
export function getSettingsRecovery(): SettingsRecovery | null {
  return recovery
}

/** store 构造完成后挂上备份：初始一份 + 每次变更一份 + 退出前一份 */
export function startSettingsBackupWatcher(store: {
  onDidAnyChange?: (callback: () => void) => unknown
}): void {
  if (watcherStarted) return
  watcherStarted = true

  const backup = (): void => {
    // 启动早期 store 可能还没有落盘（loadConfig 尚未写默认值），这不是错误；
    // 写失败只在文件存在却备份不了时值得排查，所以这里只记 debug。
    if (!writeSettingsBackup(currentUserDataDir())) {
      logger.debug(
        '[Settings] settings.backup.json not written yet (settings.json missing or invalid)'
      )
    }
  }

  backup()
  try {
    store.onDidAnyChange?.(backup)
  } catch (error) {
    logger.warn('[Settings] Failed to subscribe settings backup watcher:', error)
  }
  app.on('before-quit', backup)
}
