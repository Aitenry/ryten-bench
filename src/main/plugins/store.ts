import _Store from 'electron-store'
import logger from 'electron-log'

/**
 * Plugin enabled-state persistence (userData/plugins.json).
 *
 * Only **explicit overrides** are stored: plugins are disabled by default (installing does not mean
 * letting them run code), and enabling by the user writes true; ids not written default to false.
 *
 * The same file also stores one kind of **install state**:
 * - `removedInstalls`: ids of plugins the user uninstalled on this machine (skipped by the plugin
 *   center's new-machine auto-backfill).
 */
export const Store = _Store['default'] || _Store

export const pluginsStore = new Store<{
  states?: Record<string, boolean>
  /**
   * Ids of plugins the user explicitly uninstalled on this machine.
   *
   * What it prevents is not "the app package resurrecting them" (the app ships no plugins), but the
   * **plugin center's new-machine auto-backfill** - the platform saves install records per user,
   * and a pull that finds the plugin missing locally installs it back automatically; without this
   * note at uninstall time, an uninstalled plugin "comes back on its own" at the next sync. It is
   * cleared when the user reinstalls the plugin (see installPackageDir in package-install).
   */
  removedInstalls?: string[]
}>({
  name: 'plugins'
})

/** Read a plugin's explicit enabled override; undefined = no override (defaults to false) */
export function getEnabledOverride(id: string): boolean | undefined {
  const states = pluginsStore.get('states') ?? {}
  return states[id]
}

/** Write the explicit enabled override */
export function setEnabledOverride(id: string, enabled: boolean): void {
  const states = pluginsStore.get('states') ?? {}
  pluginsStore.set('states', { ...states, [id]: enabled })
}

/** Clear the explicit override (back to the default: disabled) */
export function clearEnabledOverride(id: string): void {
  const states = pluginsStore.get('states') ?? {}
  if (!(id in states)) return
  const rest = { ...states }
  delete rest[id]
  pluginsStore.set('states', rest)
  logger.info(`[Plugins] Cleared enabled override for ${id}`)
}

// ---------- Explicit uninstall records (new-machine auto-backfill must skip them) ----------

/**
 * Ids of plugins the user explicitly uninstalled on this machine.
 *
 * It has exactly one purpose: **stop the plugin center's new-machine auto-backfill from bringing
 * back a plugin that was just uninstalled**. The platform saves install records per user, and a
 * pull that finds "a platform record but no local package" installs automatically; after an
 * explicit uninstall the user must leave a local mark, otherwise it comes back at the next
 * sync/restart. Cleared when the plugin is reinstalled (`installPackageDir` ->
 * `clearInstallRemoved`).
 */
export function getRemovedInstalls(): string[] {
  const list = pluginsStore.get('removedInstalls') ?? []
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
}

/** Whether the user explicitly uninstalled a plugin (new-machine auto-backfill must skip it) */
export function isInstallRemoved(id: string): boolean {
  return getRemovedInstalls().includes(id)
}

/** Record that "the user uninstalled the plugin id on this machine" */
export function markInstallRemoved(id: string): void {
  const list = getRemovedInstalls()
  if (list.includes(id)) return
  pluginsStore.set('removedInstalls', [...list, id])
  logger.info(`[Plugins] Marked ${id} as explicitly uninstalled (auto-restore will skip it)`)
}

/** Clear the "explicitly uninstalled" mark (called when the user reinstalls) */
export function clearInstallRemoved(id: string): void {
  const list = getRemovedInstalls()
  if (!list.includes(id)) return
  pluginsStore.set(
    'removedInstalls',
    list.filter((x) => x !== id)
  )
  logger.info(`[Plugins] Cleared explicit-uninstall mark for ${id}`)
}
