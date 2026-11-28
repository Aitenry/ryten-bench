import * as path from 'path'
import { settingsStore } from '../context'
import { emitAppEvent } from '../plugins/app-events'
import { APP_EVENT_WORKSPACE_CHANGED } from '../plugins/app-hooks'
import type { HarnessSettings } from '../types/settings'

/**
 * **Machine-level settings reset** after a plugin draft is deleted (active workspace /
 * content remembered by plugin mode).
 *
 * Why a separate file: `workshop/workspace.ts` depends only on the database and paths, so
 * offline tests can use it directly to verify "plugin workspace rows"; this layer needs the
 * electron settings store and the event bus, is only called by main-process IPC / AI tools,
 * and should not force pure logic modules to import electron-store.
 */

/**
 * After a draft source directory is deleted, reset the active workspace if it is the
 * **currently active one**.
 *
 * Why this is required: the plugin workspace row and its sessions must be kept (deleting
 * source is not deleting conversations), but while `harness.workspacePath` still points at
 * the deleted directory, the AI file tools, the file explorer, and the file watcher all
 * report ENOENT for a nonexistent path, so the user sees "a pile of errors on the chat page
 * after deleting a plugin / new sessions do nothing".
 *
 * Only `workspacePath` / `activeWorkspaceId` are cleared (the same reset as "deleting the
 * last user workspace"); the workspace row and its sessions are preserved and become usable
 * again once a draft with the same name is rebuilt.
 *
 * @returns Whether a reset actually happened
 */
export function clearActiveWorkspaceIfRemoved(dir: string): boolean {
  try {
    const target = path.resolve(dir)
    const harness = settingsStore.get('harness') as HarnessSettings | undefined
    const active = typeof harness?.workspacePath === 'string' ? harness.workspacePath.trim() : ''
    if (!active) return false
    const activePath = path.resolve(active)
    if (activePath !== target && !activePath.startsWith(target + path.sep)) return false
    settingsStore.set('harness', {
      ...(harness ?? ({} as HarnessSettings)),
      workspacePath: '',
      activeWorkspaceId: undefined
    })
    emitAppEvent(APP_EVENT_WORKSPACE_CHANGED, {})
    return true
  } catch {
    return false
  }
}

/**
 * After a draft is deleted, clear its reference from "the content plugin mode last viewed"
 * (regardless of whether it is the active workspace).
 *
 * Otherwise: after the user deletes a plugin's source in work mode and later switches to
 * plugin mode, the sidebar still tries to open the remembered `pluginId` of a plugin that no
 * longer exists (one error notice) instead of falling back to the first available plugin.
 */
export function clearRememberedPluginContent(pluginId: string): void {
  try {
    const harness = settingsStore.get('harness') as HarnessSettings | undefined
    if (!harness?.pluginContent || harness.pluginContent.pluginId !== pluginId) return
    settingsStore.set('harness', { ...harness, pluginContent: null })
  } catch {
    // A settings read/write failure does not affect the deletion itself
  }
}
