/**
 * Settings modal state (a module-level subscribable snapshot).
 *
 * Why not in `CustomFrame` / `SettingsModal` useState: a plugin's own Provider is mounted and
 * unmounted with the plugin (`ctx.use('appProvider')`), and adding/removing a Provider remounts the
 * entire shell subtree under `PluginProvidersShell` (React's type reconciliation semantics, see the
 * comment on PluginProvidersShell in App.tsx). With the state kept inside the component:
 * - disabling any plugin that registers a Provider (music / harness) closes the settings modal the
 *   user is looking at;
 * - less obviously, the **current tab** is reset as well — `tab` is undefined when the gear opens,
 *   so after a remount it falls back to the first available tab (observed by the user on
 *   2026-09-26: "toggling a plugin switch refreshes the settings content and jumps back to
 *   General").
 *
 * So both "is it open" and "which page" are kept outside the component here: `SettingsModal` only
 * resolves `tab` against the registry into an actually available tab (tabs come and go with plugin
 * enablement).
 */
export interface SettingsModalState {
  open: boolean
  /** Current tab (undefined = let SettingsModal resolve it to the first available tab) */
  tab: string | undefined
}

let state: SettingsModalState = { open: false, tab: undefined }
const listeners = new Set<() => void>()

export function getSettingsModalState(): SettingsModalState {
  return state
}

export function subscribeSettingsModalState(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

function publish(patch: Partial<SettingsModalState>): void {
  state = { ...state, ...patch }
  for (const onChange of [...listeners]) {
    try {
      onChange()
    } catch (err) {
      console.error('[settings] Error in modal state subscription callback:', err)
    }
  }
}

/** Open the settings modal (tab defaults to the first available tab) */
export function openSettingsModal(tab?: string): void {
  publish({ open: true, tab })
}

/**
 * Switch the current tab (sidebar nav click).
 *
 * This must be a module-level write: a shell subtree remount rebuilds `SettingsModal`, and a tab
 * kept only in component state would be lost.
 * Tabs themselves come and go with plugin enablement; a stale tab falls back to the first available
 * one through `SettingsModal`'s resolution logic.
 */
export function setSettingsModalTab(tab: string | undefined): void {
  if (state.tab === tab) return
  publish({ tab })
}

export function closeSettingsModal(): void {
  publish({ open: false })
}
