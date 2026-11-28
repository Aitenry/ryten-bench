import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react'
import { i18n } from '@renderer/i18n'
import { PluginHost } from './host'
import { declaredMenuIcon } from './declared-icons'
import type {
  AppProviderRegistration,
  BottomBarItemRegistration,
  GlobalComponentRegistration,
  Plugin,
  PluginDeclaration,
  RegisteredMenuItem,
  RegisteredRoute,
  SettingsSectionRegistration
} from './types'
import type { PluginDescriptor, PluginListEntry } from '@shared/plugin/types'

const PluginHostCtx = createContext<PluginHost | null>(null)

interface PluginHostProviderProps {
  plugins: Plugin[]
  /** Enabled-state override: id → enabled; default = disabled (the app does not distribute plugins, so being installed does not mean running) */
  enabledOverride?: Record<string, boolean>
  /**
   * Main-process **synchronous** plugin list (`api.plugin.listSync()`).
   * Metadata source for first-frame declarative pre-registration (`routes`/`menu`), see
   * `declarationsFromEntries`.
   */
  entries?: PluginListEntry[]
  /** Vendor modules for external plugins (the host's single react/antd instances) */
  vendorModules?: Record<string, unknown>
  children: React.ReactNode
}

/**
 * Main-process list → declarative pre-registration items (only `enabled` entries).
 *
 * Why: a disk-package plugin's render module needs `fetch` + `import` before `install(ctx)`, so on
 * the first frame it is missing from the sidebar and route table (in practice the music menu takes
 * a few hundred ms to "pop in"). The metadata in the list is enough to put the menu/skeleton routes
 * up first; the real registration, once the plugin module finishes loading, overrides by
 * `key`/`path` (see the host's `declare()`).
 *
 * Three filters, all so that it "only holds a place without making trouble":
 * - Only `enabled` entries are processed (a disabled plugin should have no menu);
 * - Field shape validation: plugin.json comes from disk with no runtime type checking, so dirty
 *   data must not enter the registry;
 * - `labelKey` must be **translatable right now** (`i18n.exists`): for external plugins (such as a
 *   plugin package's `demo.menu.title`) the entry is registered by the plugin itself in install, so
 *   no entry exists yet at this point, and declaring it would only flash raw key names — such items
 *   wait for the real registration, which loses nothing.
 */
function declarationsFromEntries(
  entries: PluginListEntry[] | undefined
): Array<{ id: string; declaration: PluginDeclaration }> {
  if (!entries || entries.length === 0) return []
  const out: Array<{ id: string; declaration: PluginDeclaration }> = []
  for (const entry of entries) {
    if (!entry.enabled) continue
    const declaration: PluginDeclaration = {}

    const menu = entry.menu
    if (
      menu &&
      typeof menu.key === 'string' &&
      menu.key.length > 0 &&
      typeof menu.labelKey === 'string' &&
      i18n.exists(menu.labelKey)
    ) {
      declaration.menu = {
        key: menu.key,
        labelKey: menu.labelKey,
        icon: declaredMenuIcon(menu.icon),
        order: typeof menu.order === 'number' ? menu.order : undefined
      }
    }

    const routes = (entry.routes ?? []).filter(
      (r) => r && typeof r.path === 'string' && r.path.startsWith('/')
    )
    if (routes.length > 0) {
      declaration.routes = routes.map((r) => ({
        path: r.path,
        skeleton: typeof r.skeleton === 'string' ? r.skeleton : undefined
      }))
    }

    if (declaration.menu || declaration.routes) out.push({ id: entry.id, declaration })
  }
  return out
}

/**
 * Plugin host root Provider:
 * - Creates the PluginHost singleton;
 * - Loads plugins per enabledOverride (unspecified = disabled);
 * - Uses metadata from the synchronous list for **first-frame declarative pre-registration**
 *   (construction time, before any child renders);
 * - On enabledOverride change, replays as a diff (enable/disable takes effect immediately).
 */
export const PluginHostProvider: React.FC<PluginHostProviderProps> = ({
  plugins,
  enabledOverride,
  entries,
  vendorModules,
  children
}) => {
  // Default value beyond explicit overrides: always disabled
  const enabledMap = useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {}
    for (const p of plugins) {
      map[p.manifest.id] =
        enabledOverride && p.manifest.id in enabledOverride
          ? Boolean(enabledOverride[p.manifest.id])
          : false
    }
    return map
  }, [plugins, enabledOverride])

  // The host synchronously preloads default-enabled plugins at construction (routes/menus are registered on the first frame)
  const hostRef = useRef<PluginHost | null>(null)
  if (!hostRef.current) {
    hostRef.current = new PluginHost(plugins, enabledMap)
    // First-frame declarative pre-registration (must happen before any child renders): plugin
    // render modules are still loading asynchronously; with this declaration the first-frame
    // sidebar/route table is complete.
    for (const d of declarationsFromEntries(entries)) hostRef.current.declare(d.id, d.declaration)
  }
  const host = hostRef.current
  if (vendorModules) host.setVendorModules(vendorModules)

  const enabledJson = JSON.stringify(enabledMap)

  const applyRef = useRef<string>('')
  useEffect(() => {
    // Built-in plugins loaded synchronously at construction are a no-op here (the diff skips
    // them); external plugins and runtime enable/disable (bridge replay) go through async
    // enable/disable
    if (applyRef.current === enabledJson) return
    applyRef.current = enabledJson
    // The result drives re-rendering through the host version (useSyncExternalStore subscription), with no extra local state
    void host.applyEnabled(enabledMap)
  }, [host, enabledMap, enabledJson])

  return <PluginHostCtx.Provider value={host}>{children}</PluginHostCtx.Provider>
}

export function usePluginHost(): PluginHost {
  const host = useContext(PluginHostCtx)
  if (!host) throw new Error('usePluginHost 必须在 PluginHostProvider 内使用')
  return host
}

/**
 * Subscribe to the host version: any registry change (enable/disable/register/unregister) triggers
 * a re-render of subscribing components. Registry data read by each usePlugin* hook is consistent
 * with the version within the same render cycle.
 */
function useHostVersion(): number {
  const host = usePluginHost()
  return useSyncExternalStore(
    (cb) => host.subscribe(cb),
    () => host.version
  )
}

export function usePlugins(): PluginDescriptor[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getDescriptors()
}

export function usePluginRoutes(): RegisteredRoute[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getRoutes()
}

export function usePluginMenus(): RegisteredMenuItem[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getMenus()
}

/** Set of valid sidebar menu keys (registry-driven version of AppContent's highlight whitelist) */
export function usePluginMenuKeys(): string[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getMenuKeys()
}

export function usePluginSettingsSections(): SettingsSectionRegistration[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getSettingsSections()
}

export function usePluginProviders(): AppProviderRegistration[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getProviders()
}

export function useGlobalComponents(slot: string): GlobalComponentRegistration[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getGlobalComponents(slot)
}

/**
 * Bottom bar slot items (sorted by order).
 * Visibility is not part of the registry: the host reads each item's `isVisible()` on every render,
 * and plugins trigger re-renders through `subscribe`.
 */
export function useBottomBarItems(): BottomBarItemRegistration[] {
  const host = usePluginHost()
  useHostVersion()
  return host.getBottomBarItems()
}

export function useIsPluginEnabled(): (id: string) => boolean {
  const host = usePluginHost()
  useHostVersion()
  return (id: string) => host.isEnabled(id)
}
