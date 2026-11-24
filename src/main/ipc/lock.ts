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
 * 锁屏 IPC（core）。
 *
 * 通道边界：**解锁码摘要永远不出主进程**。
 * 渲染层只能拿到快照（开关 / 是否有码 / 是否仍为默认码 / 自动锁屏时长 / 当前是否已锁），
 * 解锁、改码、开关都由主进程校验与落盘。
 */
export function registerLockIpc(): void {
  // 自动锁屏监听只启动一次（与窗口重建无关）
  startLockScreenWatcher()

  ipcMain.handle('lock-screen-state', () => getLockScreenSnapshot())

  /** 手动锁屏（Esc）。未启用 / 没有解锁码时返回当前快照，不做任何事 */
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
