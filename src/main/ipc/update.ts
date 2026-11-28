import { APP_UPDATE_CHANNELS } from '../../shared/update/types'
import { updateService } from '../update/service'
import { registerIpcHandlers } from './register'

/**
 * Update IPC (core shell).
 *
 * The renderer can only read the snapshot, request a check, download an already-offered update,
 * and restart into an already-downloaded one. It cannot point the updater at an arbitrary URL or
 * skip checksum verification — that stays in the main-process service.
 */
export function registerUpdateIpc(): void {
  registerIpcHandlers({
    [APP_UPDATE_CHANNELS.getState]: () => updateService.getState(),
    [APP_UPDATE_CHANNELS.check]: () => updateService.checkForUpdates(),
    [APP_UPDATE_CHANNELS.download]: () => updateService.download(),
    [APP_UPDATE_CHANNELS.restart]: () => updateService.restartAndInstall()
  })
}
