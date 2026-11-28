import { registerMiscIpc } from './misc'
import { registerLockIpc } from './lock'
import { registerSettingsIpc } from './settings'
import { registerProviderIpc } from './provider'
import { registerDialogIpc } from './dialog'
import { registerPluginsIpc } from './plugins'
import { registerLatticeIpc } from './lattice'

/**
 * core (shell) IPC: window misc / system settings / lock screen / model providers / dialogs /
 * plugin management / Lattice plugin center (login, catalog, upload, download-install, data
 * sync).
 *
 * Ownership boundary:
 * - **only** shell capabilities live here;
 * - system feature channels (AI assistant `harness:*` / knowledge base `notes:*`) are in
 *   `src/main/ipc/harness/**` and `src/main/ipc/notes/**`, registered at startup by
 *   `src/main/system/` — they are part of core, not plugins;
 * - third-party plugin channels go through the plugin's own `main/index.ts` `install(ctx)` +
 *   `ctx.registerIpc`, registered and removed by the plugin host according to enabled state.
 *
 * Ownership change log:
 * - `workspace-*` (9 channels) moved into the AI assistant together with
 *   harness/harness-topic/mnemon;
 * - `agent-*` / `main-agent-*` moved from `provider.ts` into `ipc/harness/agent.ts`, leaving
 *   only the model provider's own channels here.
 */
export function registerCoreIpc(): void {
  registerMiscIpc()
  registerLockIpc()
  registerSettingsIpc()
  registerDialogIpc()
  registerProviderIpc()
  registerPluginsIpc()
  // Plugin center: channel registration + restore login state / fetch cloud install records at
  // startup (initializes lattice/index.ts internally)
  registerLatticeIpc()
}
