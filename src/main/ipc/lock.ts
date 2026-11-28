import { ipcMain } from 'electron'
import logger from 'electron-log'
import {
  changeLockCode,
  configureLock,
  getLockScreenSnapshot,
  lockNow,
  startLockScreenWatcher,
  unlockWithCode
} from '../lock/service'

/**
 * Lock screen IPC (core).
 *
 * Channel boundary: **the unlock code digest never leaves the main process**.
 * The renderer only receives a snapshot (enabled / whether a code is set / whether it is still the
 * default code / auto-lock timeout / whether it is currently locked); unlocking, changing the code
 * and toggling are all validated and persisted by the main process.
 */
export function registerLockIpc(): void {
  // The auto-lock watcher starts only once, independent of window recreation
  startLockScreenWatcher()

  ipcMain.handle('lock-screen-state', () => getLockScreenSnapshot())

  /**
   * Manual lock (Esc). When disabled / no unlock code is set, returns the current snapshot and does
   * nothing.
   */
  ipcMain.handle('lock-screen-lock', () => {
    lockNow('manual')
    return getLockScreenSnapshot()
  })

  ipcMain.handle('lock-screen-unlock', async (_event, code: unknown) => {
    try {
      return await unlockWithCode(typeof code === 'string' ? code : '')
    } catch (error) {
      logger.error('[LockScreen] Unlock handler failed:', error)
      return { ok: false, reason: 'unavailable' as const }
    }
  })

  ipcMain.handle('lock-screen-configure', (_event, patch: unknown) => {
    const input = (patch ?? {}) as { enabled?: unknown; autoLockMinutes?: unknown }
    return configureLock({
      enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
      autoLockMinutes: typeof input.autoLockMinutes === 'number' ? input.autoLockMinutes : undefined
    })
  })

  ipcMain.handle('lock-screen-change-code', async (_event, oldCode: unknown, newCode: unknown) => {
    try {
      return await changeLockCode(
        typeof oldCode === 'string' ? oldCode : '',
        typeof newCode === 'string' ? newCode : ''
      )
    } catch (error) {
      logger.error('[LockScreen] Change-code handler failed:', error)
      return { ok: false, reason: 'unavailable' as const }
    }
  })
}
