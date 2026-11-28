import logger from 'electron-log'
import { startHarness, stopHarness } from './harness'
import { startNotes, stopNotes } from './notes'

/**
 * Assembly entry point for the system-level features (AI assistant / library).
 *
 * These two are **not plugins**: they start and stop with the app, with no install/enable/disable
 * layer. Their main-process code lives in `src/main` (`system/` only orders the assembly), and
 * their channels are ordinary `harness:*` / `notes:*` channels that do not go through the plugin
 * host.
 */
const SYSTEM_MODULE_IDS = ['harness', 'notes'] as const

/**
 * IDs owned by system-level features: third-party plugin scans and the plugin panel must skip
 * them, so a plugin with the same name cannot take them over.
 */
export const SYSTEM_MODULE_IDS_SET: ReadonlySet<string> = new Set(SYSTEM_MODULE_IDS)

let started = false

/** Start the system-level features (must run before preload channel queries and window creation) */
export function startSystemModules(): void {
  if (started) return
  started = true

  // Install harness first: notes registers its AI tools into the harness tool registry
  startHarness()
  startNotes()

  logger.info('[System] AI assistant / library started as system features')
}

/** Tear down the assembly (called on app quit; reverse of the startup order) */
export function stopSystemModules(): void {
  if (!started) return
  started = false
  stopNotes()
  stopHarness()
}
