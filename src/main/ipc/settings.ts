import { ipcMain } from 'electron'
import logger from 'electron-log'
import { settingsStore } from '../context'
import { awaitInitialized } from '../database/instance'
import { HarnessSettings, SystemSettings } from '../types/settings'
import { getPublicLockSettings } from '../lock/service'
import { syncTrayState } from '../tray'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED, type AppWorkspaceChangedPayload } from '../plugins/app-hooks'
import { configurePluginsRoot } from '../workshop/paths'
import { isSamePath, migrateChangedStoragePaths, storagePathOf } from '../storage'
import { remapWorkspacePathsUnderRoot } from '../storage/workspace-refs'
import { getAllWorkspaces } from '../database/mapper/harness/harness'
import { isUserSelectedRoot, workspacePathKey } from '../workspace/selected-roots'

/** Current active workspace (read after settings are persisted; null/empty string when not configured) */
function workspaceChangedPayload(): AppWorkspaceChangedPayload {
  const harness = settingsStore.get('harness') as
    { activeWorkspaceId?: number; workspacePath?: string } | undefined
  return {
    workspaceId: harness?.activeWorkspaceId ?? null,
    workspacePath: harness?.workspacePath ?? ''
  }
}

/**
 * Trust validation for the workspace root / active workspace id (security audit S03).
 *
 * The renderer can call `system-settings-update` to change `harness.workspacePath`, and every
 * file-related IPC uses that value as the root of `assertInsideWorkspace` — once it is changed to
 * `C:\` arbitrary files can be read and written. So this narrows it down to: the directory must be
 * one the **user picked by hand through a system dialog** or an already registered workspace row;
 * `activeWorkspaceId` must correspond to a real workspace row. Clearing (switching away / deleting
 * a workspace) is always allowed.
 */
async function validateWorkspacePatch(
  next: HarnessSettings,
  previous: HarnessSettings | undefined,
  patch: Partial<HarnessSettings>
): Promise<void> {
  let cachedRows: Promise<Awaited<ReturnType<typeof getAllWorkspaces>>> | null = null
  const rows = (): Promise<Awaited<ReturnType<typeof getAllWorkspaces>>> => {
    cachedRows ??= getAllWorkspaces()
    return cachedRows
  }

  if ('workspacePath' in patch) {
    const nextPath = typeof next.workspacePath === 'string' ? next.workspacePath.trim() : ''
    if (nextPath) {
      let known = isUserSelectedRoot(nextPath)
      if (!known) {
        try {
          known = (await rows()).some(
            (row) => workspacePathKey(row.path) === workspacePathKey(nextPath)
          )
        } catch (err) {
          // Treat it as rejected when the database is unavailable (fail closed) so validation cannot be bypassed
          logger.warn('[Settings] Workspace path validation failed (database unavailable):', err)
        }
      }
      if (!known) {
        logger.warn('[Settings] Rejected harness.workspacePath that was not picked by the user')
        next.workspacePath = previous?.workspacePath ?? ''
      }
    }
  }

  if ('activeWorkspaceId' in patch) {
    const nextId = next.activeWorkspaceId
    if (typeof nextId === 'number' && Number.isFinite(nextId)) {
      let exists = false
      try {
        exists = (await rows()).some((row) => row.id === nextId)
      } catch (err) {
        logger.warn('[Settings] activeWorkspaceId validation failed (database unavailable):', err)
      }
      if (!exists) {
        logger.warn('[Settings] Rejected harness.activeWorkspaceId that does not exist')
        next.activeWorkspaceId = previous?.activeWorkspaceId
      }
    }
  }
}

/** System settings IPC (lock screen uses a dedicated channel, see ipc/lock.ts: the digest must not be sent or rewritten through the generic settings channel) */
export function registerSettingsIpc(): void {
  ipcMain.handle('system-settings-get-all', async () => {
    try {
      await awaitInitialized()
      const all = settingsStore.store
      // Do not expose provider-keystore internal data to the frontend;
      // lock only exposes "switch + auto-lock duration" — the unlock code digest stays in the main
      // process (see ipc/lock.ts)
      return {
        ip: all.ip,
        lock: getPublicLockSettings(),
        graph: all.graph,
        harness: all.harness,
        defaultModelId: all.defaultModelId,
        defaultEmbeddingModelId: all.defaultEmbeddingModelId,
        musicDirectory: all.musicDirectory,
        theme: all.theme,
        language: all.language,
        tray: all.tray,
        weatherRefreshInterval: all.weatherRefreshInterval,
        weatherLastFetched: all.weatherLastFetched,
        weatherData: all.weatherData
      } as SystemSettings
    } catch (error) {
      logger.error('Error in system-settings-get-all:', error)
      throw error
    }
  })

  ipcMain.handle('system-settings-update', async (_event, updates: Partial<SystemSettings>) => {
    try {
      // Key whitelist (fix: previously any top-level key/type was persisted directly — a typo'd
      // key was stored forever, or a whole lock/harness/graph key could be written as a non-object
      // with no fallback downstream)
      const ALLOWED_KEYS: Array<keyof SystemSettings> = [
        'ip',
        'graph',
        'harness',
        'defaultModelId',
        'defaultEmbeddingModelId',
        'musicDirectory',
        'theme',
        'language',
        'tray',
        'weatherRefreshInterval',
        'weatherLastFetched',
        'weatherData'
      ]
      const nextUpdates: Partial<SystemSettings> = { ...updates }

      // Lock screen does **not go through the generic settings channel**: allowing it here would
      // let the renderer change `lock.code` freely (as the original implementation did, without
      // even knowing the old code when changing the password). Toggle / auto-lock / code change
      // each have a dedicated channel (see ipc/lock.ts).
      if ('lock' in nextUpdates) {
        logger.warn('[Settings] Rejected lock settings through generic update channel')
        delete nextUpdates.lock
      }

      // Storage path (memory / plugins / skills) changes: migrate the old directory's data to the
      // new one first, and only persist the settings on success. On failure it throws and the
      // settings keep their old values — never "settings point at the new directory while the data
      // is still in the old one".
      let previousHarness: HarnessSettings | undefined
      let nextHarness: HarnessSettings | undefined
      if (
        nextUpdates.harness &&
        typeof nextUpdates.harness === 'object' &&
        !Array.isArray(nextUpdates.harness)
      ) {
        const rawPreviousHarness = settingsStore.get('harness')
        previousHarness =
          rawPreviousHarness &&
          typeof rawPreviousHarness === 'object' &&
          !Array.isArray(rawPreviousHarness)
            ? (rawPreviousHarness as HarnessSettings)
            : {}
        nextHarness = { ...previousHarness, ...nextUpdates.harness }
        await validateWorkspacePatch(nextHarness, previousHarness, nextUpdates.harness)
        await migrateChangedStoragePaths(previousHarness, nextHarness)
        nextUpdates.harness = nextHarness
      }

      for (const [key, value] of Object.entries(nextUpdates)) {
        if (value === undefined) continue
        if (!ALLOWED_KEYS.includes(key as keyof SystemSettings)) {
          logger.warn(`[Settings] Rejected unknown setting key: ${key}`)
          continue
        }
        // For object-valued settings (e.g. harness), merge with the existing value instead of replacing it
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const existing = settingsStore.get(key as keyof SystemSettings) as
            Record<string, unknown> | undefined
          settingsStore.set(key as keyof SystemSettings, { ...(existing ?? {}), ...value } as never)
        } else {
          settingsStore.set(key as keyof SystemSettings, value)
        }
      }

      // The plugin storage path changed: the runtime-injected root must switch immediately
      // (without a restart). The settings page itself does not go through this channel (it uses
      // workshop-set-root), but probes/external calls may write the setting directly.
      if (previousHarness && nextHarness) {
        const beforePlugins = storagePathOf(previousHarness, 'plugins')
        const afterPlugins = storagePathOf(nextHarness, 'plugins')
        if (!isSamePath(beforePlugins, afterPlugins)) {
          // The plugin source directory moved as a whole: remap the old plugin workspace rows /
          // active workspace to the new root, otherwise old sessions keep pointing at a directory
          // that no longer exists.
          await remapWorkspacePathsUnderRoot(beforePlugins, afterPlugins)
          configurePluginsRoot(afterPlugins)
          logger.info(
            `[Settings] Plugins storage root applied at runtime: ${afterPlugins || '(cleared)'}`
          )
        }
      }
      // Sync the tray immediately when tray settings change (close behavior / menu check state);
      // refresh the tray hint copy when the language changes
      if ('tray' in updates || 'language' in updates) {
        syncTrayState()
      }
      // After a workspace switch (create / select / rebuild) notify subscribers (event bus): the
      // workspace file watcher's root switch belongs to the AI assistant
      // (`src/main/system/harness.ts`); core only emits the event after the settings are persisted.
      // Third-party plugins can subscribe to the same event (see src/main/plugins/app-hooks.ts)
      if ('harness' in updates) {
        emitAppEvent(APP_EVENT_WORKSPACE_CHANGED, workspaceChangedPayload())
      }
      logger.info('System settings updated:', Object.keys(updates).join(', '))
      return true
    } catch (error) {
      logger.error('Error in system-settings-update:', error)
      throw error
    }
  })
}
