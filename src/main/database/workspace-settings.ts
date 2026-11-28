import logger from 'electron-log'
import type { PGlite } from '@electric-sql/pglite'
import { settingsStore } from '../context'
import type { HarnessSettings } from '../types/settings'
import { migrateWorkspaceData } from './workspace-migration'

/**
 * Reconcile the "workspace" runtime config layer with a given account database.
 *
 * Why it is a separate file: this logic used to be inlined in the startup flow and ran only once early on. Now the account data space
 * can be switched in place at runtime (logout / account switch / base URL change, see `profiles/live.ts`), and it must run again
 * after switching — `harness.activeWorkspaceId` lives in the **machine-level** `settings.json`, while workspace rows live in the
 * **account-level** database: after switching to another account that id likely points to a nonexistent row, and failing to re-align
 * causes cross-account symptoms such as "no active workspace in the sidebar / the open session belongs to the previous account".
 *
 * Idempotent: repeated calls only reset the settings to values consistent with the current database.
 */
export async function applyWorkspaceSettings(db: PGlite): Promise<void> {
  const result = await migrateWorkspaceData(
    db,
    () => {
      const harness = settingsStore.get('harness') as HarnessSettings | undefined
      return harness?.activeWorkspaceId
    },
    // Plugin storage path: used to classify historical plugin workspaces (kind='plugin'); skip that step when unset
    (settingsStore.get('harness') as HarnessSettings | undefined)?.pluginsPath
  )

  // Write the active workspace determined by migration back to settings (sync the id and path together)
  const harness = settingsStore.get('harness') as HarnessSettings | undefined
  const next: HarnessSettings = { ...(harness ?? ({} as HarnessSettings)) }
  if (result.activeWorkspaceId == null) {
    // No workspace at all: clear leftover config and return to "not configured", letting the chat page guide the user to pick a directory
    if (next.activeWorkspaceId != null || next.workspacePath) {
      delete next.activeWorkspaceId
      next.workspacePath = ''
      settingsStore.set('harness', next)
    }
  } else if (
    next.activeWorkspaceId !== result.activeWorkspaceId ||
    next.workspacePath !== result.activeWorkspacePath
  ) {
    next.activeWorkspaceId = result.activeWorkspaceId
    next.workspacePath = result.activeWorkspacePath ?? ''
    settingsStore.set('harness', next)
  }
  logger.info(
    `[Workspace] Settings reconciled, active workspace=${result.activeWorkspaceId ?? 'none'}`
  )
}
