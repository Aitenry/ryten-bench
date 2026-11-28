import React, { useEffect, useMemo, useRef } from 'react'
import { HashRouter } from 'react-router-dom'
import { MessageContext } from '@renderer/contexts/MessageContext'
import { NotificationProvider } from '@renderer/contexts/NotificationContext'
import { composeProviders } from '@renderer/utils/composeProviders'
import AppContent from '@renderer/components/system/AppContent'
import AppErrorBoundary from '@renderer/components/system/AppErrorBoundary'
import SettingsHost from '@renderer/components/system/settings/SettingsHost'
import {
  PluginHostProvider,
  usePluginHost,
  usePluginProviders
} from '@renderer/plugin-host/PluginHostContext'
import type { Plugin } from '@renderer/plugin-host/types'
import type { PluginListEntry } from '@shared/plugin/types'
import { vendorModules } from '@renderer/plugin-host/host-ui'
import { loadExternalPlugin } from '@renderer/plugin-host/external-loader'
import { PluginBoundary } from '@renderer/plugin-host/PluginBoundary'
import { HarnessProvider } from '@renderer/contexts/harness/HarnessContext'
import BuildProgressProvider from '@renderer/providers/notes/BuildProgressProvider'
import SystemEffects from '@renderer/components/system/SystemEffects'
import { LatticeProvider } from '@renderer/lattice/LatticeContext'

// Shell-resident providers (the app skeleton layer outside the plugin system).
// Plugins register their own providers (e.g. the music player's AudioProvider, the home page's
// graph build progress) with the plugin; see PluginProvidersShell: disabling a plugin unmounts
// its state too, and shell components no longer hold any plugin state.
const CoreProviders = composeProviders(
  [
    MessageContext.Provider,
    {
      value: {
        viewMessage: () => {}
      }
    }
  ],
  [NotificationProvider]
)

// Plugin provider layer: a module-level stable component that nests the plugin-registered
// providers inline. Key constraint: never dynamically compose a new component type — previously
// useMemo(composeProviders(...)) produced a new component type on every host state bump, which
// unmounted and remounted the whole AppContent/CustomFrame subtree and cleared local state such as
// settingsOpen/currentKey, showing up as "settings/menu clicks stop working". Here p.Provider is a
// stable component reference exported by the plugin, so a host version change only triggers a
// re-render (same-type reconciliation) and no remount; adding/removing providers when
// enabling/disabling plugins is itself the intended refactor.
const PluginProvidersShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const pluginProviders = usePluginProviders()
  // Each provider gets its own boundary: when one plugin's provider throws during render, only
  // that one is skipped and the subtree it wraps (fallback = the same subtree) still renders — one
  // broken provider must not turn the whole AppContent into an error card. The composition order
  // and nesting of the three remain unchanged.
  const nested = pluginProviders.reduceRight(
    (acc, p) => (
      <PluginBoundary
        key={p.pluginId}
        pluginId={p.pluginId}
        surface="provider"
        quiet
        fallback={acc}
      >
        <p.Provider>{acc}</p.Provider>
      </PluginBoundary>
    ),
    children
  )
  return <>{nested}</>
}

/**
 * System feature provider layer (AI assistant / notes).
 *
 * They are not plugins and have no enable state, so they must permanently wrap the shell and
 * pages: HarnessProvider on the outside (session/topic state), BuildProgressProvider on the inside
 * (graph build progress). The order is hardcoded here because it is the shell's assembly order, no
 * longer a registrable runtime table.
 */
const SystemProvidersShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <HarnessProvider>
    <BuildProgressProvider>{children}</BuildProgressProvider>
  </HarnessProvider>
)

// Enable-state sync bridge: the main process's plugins-list is the persisted source of truth; the
// bridge does three things: remove plugins that disappeared/were disabled (including those
// "physically uninstalled") → load the renderer modules of enabled plugins → apply the list diff
// to the host (load/unload) and subscribe to enable/disable broadcasts to replay immediately.
const PluginStateBridge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const host = usePluginHost()
  /**
   * **Package content stamp** (`PluginListEntry.stamp`) of each loaded plugin.
   *
   * Why it is needed: after the main process swaps the on-disk package (upgrade/reinstall/install
   * again), the renderer must `fetch('plugin://<id>/renderer.mjs')` again and re-inject
   * `plugin.css`; checking only "the id is registered" skips the reload and the user still sees the
   * old UI (observed 2026-09-26: neither styles nor UI updated after an upgrade).
   */
  const loadedStamps = useRef(new Map<string, string>())
  useEffect(() => {
    let disposed = false
    const sync = async (): Promise<void> => {
      try {
        const list = await window.api.plugin.list()
        if (disposed) return

        // 1) Disposal: ① no longer in the main-process list (uninstalled / directory deleted) → forgetPlugin;
        //    ② **merely disabled** → disable (keep the registration; re-enabling goes through the host's enable() and a fresh install).
        //
        //    Why ① must use forgetPlugin: dropping the registration makes step 2 fetch + install
        //    from the **new on-disk package**; applyEnabled's diff alone cannot do that (it only
        //    handles ids that appear in the list).
        const liveIds = new Set(list.map((e) => e.id))
        for (const descriptor of host.getDescriptors()) {
          const id = descriptor.manifest.id
          const entry = list.find((e) => e.id === id)
          if (!liveIds.has(id) || !entry) {
            await host
              .forgetPlugin(id)
              .catch((err) => console.error(`[plugins] Failed to remove plugin: ${id}`, err))
            continue
          }
          // ③ The package changed (upgrade / reinstall / "reinstall" in the panel): the content
          //    stamp or version differs from what was registered → drop the registration and the
          //    loading loop below fetches + installs from the **new on-disk package** (new
          //    renderer.mjs, new plugin.css; otherwise the user still sees the old UI after upgrading).
          const stamp = entry.stamp ?? ''
          const loadedStamp = loadedStamps.current.get(id)
          if (
            (loadedStamp !== undefined && loadedStamp !== stamp) ||
            (entry.version && descriptor.manifest.version !== entry.version)
          ) {
            loadedStamps.current.delete(id)
            await host
              .forgetPlugin(id)
              .catch((err) => console.error(`[plugins] Failed to reload plugin: ${id}`, err))
            continue
          }
          if (!entry.enabled) {
            await host
              .disable(id)
              .catch((err) => console.error(`[plugins] Failed to disable plugin: ${id}`, err))
          }
        }

        // 2) Load: renderer modules of plugins enabled in the list but not registered yet.
        //    The renderer entry of an on-disk package plugin is always `plugin://<id>/renderer.mjs`
        //    (+ the host UI bridge).
        for (const e of list) {
          if (!e.enabled) continue
          if (host.getDescriptor(e.id)) continue
          try {
            const plugin = await loadExternalPlugin({
              id: e.id,
              name: e.name,
              version: e.version,
              description: e.description,
              icon: e.icon,
              entry: e.entry
            })
            if (!disposed) host.addExternal(plugin)
            if (!disposed) loadedStamps.current.set(e.id, e.stamp ?? '')
          } catch (err) {
            console.error(`[plugins] Plugin '${e.id}' failed to load renderer module:`, err)
          }
        }

        // 3) Apply the enable state uniformly (all registered plugins; the host skips unregistered ids)
        const map: Record<string, boolean> = {}
        for (const entry of list) map[entry.id] = entry.enabled
        await host.applyEnabled(map)
      } catch (err) {
        console.error('[plugins] Failed to sync enabled state:', err)
      }
    }
    void sync()
    const unsub = window.api.plugin.onStateChanged(() => {
      void sync()
    })
    return () => {
      disposed = true
      unsub()
    }
  }, [host])
  return <>{children}</>
}

const App: React.FC = () => {
  /**
   * Authoritative list for the first frame: the app has no static plugins — plugins only really
   * register after their renderer module has loaded from `plugin://<id>/renderer.mjs`. So the
   * main-process list must be obtained **at the same moment the host is constructed**:
   * - metadata (`routes`/`menu`): the host uses it to **declaratively pre-register** menus and
   *   routes for the first frame, otherwise the sidebar is empty and clicking a menu navigates to
   *   an empty route (see declare() in plugin-host/host.ts);
   * - enable state is applied uniformly by `PluginStateBridge` after the renderer modules load.
   * Returns null when unavailable, and consumers fall back to "no declarations, no initial
   * plugins" (the asynchronous list still loads them afterwards).
   */
  const syncEntries = useMemo<PluginListEntry[] | null>(() => {
    try {
      const list = window.api.plugin.listSync()
      return Array.isArray(list) ? list : null
    } catch (err) {
      console.warn('[plugins] Failed to sync plugin manifest, loading with default enabled state:', err)
      return null
    }
  }, [])

  /**
   * **Initial** plugin set handed to the host: always an empty array.
   *
   * The app has no static import of any plugin code: everything is loaded by PluginStateBridge
   * below from `plugin://<id>/renderer.mjs`; the first frame's menus/routes are carried by the
   * **declarative pre-registration** of the list metadata (see declare in plugin-host/host.ts and
   * syncEntries above).
   */
  const initialPlugins = useMemo<Plugin[]>(() => [], [])

  return (
    <HashRouter>
      {/* Global error boundary: a render error no longer turns the whole app into a blank screen; it shows a recoverable message card instead */}
      <AppErrorBoundary>
        {/*
          Plugin hub (Lattice) state sits above the shell: the sidebar account area, login page,
          plugin repository page and plugin detail page share the same status / sync state /
          upload progress. When main-process channels are missing the provider degrades safely by
          itself and does not block the rest of the app.
        */}
        <LatticeProvider>
          {/* Plugin host root: plugins load according to enable state; routes/menus/settings pages/providers are all registry-driven */}
          <PluginHostProvider
            plugins={initialPlugins}
            entries={syncEntries ?? undefined}
            vendorModules={vendorModules}
          >
            <PluginStateBridge>
              <CoreProviders>
                <SystemProvidersShell>
                  <SystemEffects />
                  <PluginProvidersShell>
                    <AppContent />
                  </PluginProvidersShell>
                  {/* The settings dialog sits outside the plugin provider chain: enabling/disabling plugins does not rebuild it (see SettingsHost.tsx) */}
                  <SettingsHost />
                </SystemProvidersShell>
              </CoreProviders>
            </PluginStateBridge>
          </PluginHostProvider>
        </LatticeProvider>
      </AppErrorBoundary>
    </HashRouter>
  )
}

export default App
