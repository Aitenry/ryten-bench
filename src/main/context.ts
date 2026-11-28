import _Store from 'electron-store'
import { HarnessSettings } from './types/settings'
import { setActiveWorkspaceIdProvider } from './database/workspace-context'
import { recoverSettingsAtStartup, startSettingsBackupWatcher } from './settings-backup'

// electron-store instance: global settings (shared by the IPC layer and the AI tool layer)
// Self-check settings.json before construction: if missing/corrupt, restore it from
// settings.backup.json (see settings-file.ts)
export const settingsStartupRecovery = recoverSettingsAtStartup()
export const Store = _Store['default'] || _Store
export const settingsStore = new Store({ name: 'settings' })
// Refresh the backup in the same directory after every settings change; do one more pass before exit
startSettingsBackupWatcher(settingsStore)

// Global active-workspace reader (shared by the IPC layer and the AI tool layer)
setActiveWorkspaceIdProvider(() => {
  const harness = settingsStore.get('harness') as HarnessSettings | undefined
  return harness?.activeWorkspaceId ?? 0
})

// Streaming output cancellation controllers (keyed by renderer sender.id)
export const streamAbortControllers = new Map<number, AbortController>()
// In-flight conversation streams (must finish persisting data before exit; includes goal auto-continuation rounds)
export const activeHarnessStreams = new Set<Promise<unknown>>()
// The in-progress interruption queue (harnessQueue) belongs to the harness plugin: both the
// implementation and its consumers live in src/main/services/harness/queue-store.ts
// (ipc/harness, ipc/harness-topic); core takes no part, so nothing is re-exported here.
