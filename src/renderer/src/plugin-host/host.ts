import { i18n } from '@renderer/i18n'
import { PluginError, PLUGIN_ERROR } from '@shared/plugin/errors'
import type { PluginDescriptor, PluginManifest, PluginState } from '@shared/plugin/types'
import { HOST_KEYS } from './keys'
import { PluginContext } from './context'
import { installPluginCss, removePluginCss } from './plugin-css'
import type {
  AppProviderRegistration,
  BottomBarItemRegistration,
  GlobalComponentRegistration,
  HostServiceKey,
  HostServices,
  Plugin,
  PluginDeclaration,
  RegisteredMenuItem,
  RegisteredRoute,
  SettingsSectionRegistration
} from './types'

/**
 * Renderer-side plugin host (a lightweight lifecycle state machine).
 *
 * Lifecycle: inactive →(enable)→ active →(disable)→ inactive;
 * - enable: validates inject dependencies first (MISSING_DEP); if install throws, rolls back the
 *   registered effects in reverse order and restores error;
 * - disable: unloads in withdrawal order (dependents before providers), rolling back registries +
 *   effects + install dispose;
 * - every register/unregister bumps the version counter, and React re-renders reactively through
 *   useSyncExternalStore.
 */

type FiberState = PluginState

/**
 * Settings tabs owned by the host core itself (see `STATIC_TABS` in
 * `components/system/settings/SettingsModal.tsx`).
 *
 * A plugin registering these keys would collide with core tabs (`tabMeta` is last-write-wins),
 * showing up as "the general settings page turned into some plugin page" — not allowed, so the
 * plugin's enable fails outright.
 */
const CORE_SETTINGS_TABS: ReadonlySet<string> = new Set(['general', 'model', 'system', 'plugins'])

/** A registry wrapped with pluginId: register returns an unregister function; the host can clear a whole group */
class ScopedRegistry<T extends { pluginId: string }> {
  private items = new Map<string, T[]>()

  register(pluginId: string, item: Omit<T, 'pluginId'>, bump: () => void): () => void {
    const full = { ...item, pluginId } as unknown as T
    const list = this.items.get(pluginId) ?? []
    list.push(full)
    this.items.set(pluginId, list)
    bump()
    return () => {
      const cur = this.items.get(pluginId)
      if (!cur) return
      const next = cur.filter((x) => x !== full)
      if (next.length > 0) this.items.set(pluginId, next)
      else this.items.delete(pluginId)
      bump()
    }
  }

  removeAll(pluginId: string, bump: () => void): void {
    if (this.items.delete(pluginId)) bump()
  }

  /** Who already occupies this registration (null if none; used for cross-plugin conflict detection) */
  ownerOf(predicate: (item: T) => boolean): string | null {
    for (const [pluginId, list] of this.items) {
      if (list.some(predicate)) return pluginId
    }
    return null
  }

  getAll(): T[] {
    return [...this.items.values()].flat()
  }
}

type EventHandler = (data?: unknown) => void

export class PluginHost {
  /** Version counter: incremented on any registry change; used as the useSyncExternalStore snapshot */
  version = 0

  private listeners = new Set<() => void>()
  private plugins: Plugin[] = []
  private readonly ctxs = new Map<string, PluginContext>()
  private readonly states = new Map<string, FiberState>()
  private readonly errors = new Map<string, string>()
  private readonly enabled = new Set<string>()
  /** Custom key → provider plugin id (used for MISSING_DEP validation and withdrawal ordering) */
  /** Custom key → provider plugin id and its provided value (the registry itself is the source of truth for provide) */
  private readonly provides = new Map<string, { pluginId: string; value: unknown }>()

  /**
   * Declarative pre-registration table (id → routes/menu metadata from the manifest), **not** the
   * real registry.
   *
   * See `declare()`: a disk plugin's renderer module installs only after an async import, so this
   * declaration makes its menu/routes available on the first frame; once real registrations appear
   * they override the declaration by key/path (`getMenus`/`getRoutes`).
   */
  private readonly declarations = new Map<string, PluginDeclaration>()

  private readonly routeRegistry = new ScopedRegistry<RegisteredRoute>()
  private readonly menuRegistry = new ScopedRegistry<RegisteredMenuItem>()
  private readonly settingsRegistry = new ScopedRegistry<SettingsSectionRegistration>()
  private readonly providerRegistry = new ScopedRegistry<AppProviderRegistration>()
  private readonly globalRegistry = new ScopedRegistry<GlobalComponentRegistration>()
  private readonly bottomBarRegistry = new ScopedRegistry<BottomBarItemRegistration>()
  private readonly eventHandlers = new Map<string, Set<EventHandler>>()

  constructor(plugins: Plugin[], initialEnabled?: Record<string, boolean>) {
    plugins.forEach((p) => this.registerPlugin(p))
    // Startup race fix: plugins marked "enabled" in the manifest are pre-installed synchronously in
    // the constructor — routes/menus are registered before the first frame renders. Otherwise
    // usePluginRoutes/usePluginMenus are empty on the first frame, and clicking a menu early in
    // startup navigates to a route-less location ("No routes matched", click does nothing).
    for (const p of plugins) {
      if (initialEnabled?.[p.manifest.id] === true) this.syncInstall(p.manifest.id)
    }
  }

  /**
   * Synchronous install: plugins whose install returns synchronously are registered on the spot
   * (active). When install returns a Promise (async plugin), roll back and let enable()'s async path
   * do the loading.
   */
  private syncInstall(id: string): boolean {
    if (this.enabled.has(id)) return true
    const plugin = this.findPlugin(id)
    if (this.checkDeps(plugin).length > 0) return false
    const ctx = new PluginContext(id, this, plugin.manifest, undefined)
    this.ctxs.set(id, ctx)
    this.states.set(id, 'reloading')
    try {
      const ret = plugin.install(ctx) as
        void | (() => void) | Promise<void | (() => void)> | undefined
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        this.ctxs.delete(id)
        this.states.set(id, 'inactive')
        return false
      }
      ctx.attachInstallDispose(ret as void | (() => void) | undefined)
      this.enabled.add(id)
      this.states.set(id, 'active')
      this.errors.delete(id)
      return true
    } catch (err) {
      this.ctxs.delete(id)
      const msg = err instanceof Error ? err.message : String(err)
      this.errors.set(id, msg)
      this.states.set(id, 'error')
      return false
    } finally {
      this.bump()
    }
  }

  /**
   * Register a plugin (built-in statics at construction; disk plugins that finish loading at runtime
   * go through here too).
   *
   * Re-registering the same id **replaces** the old entry: after reinstalling a plugin you get a new
   * `Plugin` object (`forgetPlugin` may also leave an old entry behind if some path was skipped), and
   * the new install function must be used, otherwise routes/menus are "not found" after reinstall.
   */
  registerPlugin(plugin: Plugin): void {
    const existing = this.plugins.findIndex((p) => p.manifest.id === plugin.manifest.id)
    if (existing >= 0) {
      this.plugins[existing] = plugin
    } else {
      this.plugins.push(plugin)
    }
    if (!this.states.has(plugin.manifest.id)) {
      this.states.set(plugin.manifest.id, 'inactive')
    }
    this.bump()
  }

  /** Register an external plugin (entry point once runtime loading completes; the enabled state is still driven by applyEnabled) */
  addExternal(plugin: Plugin): void {
    this.registerPlugin(plugin)
  }

  /** Remove an external plugin (unload first, then unregister) */
  async removeExternal(id: string): Promise<void> {
    const plugin = this.plugins.find((p) => p.manifest.id === id)
    if (!plugin) return
    await this.disable(id).catch(() => undefined)
    this.declarations.delete(id)
    this.plugins = this.plugins.filter((p) => p.manifest.id !== id)
    this.states.delete(id)
    this.errors.delete(id)
    this.bump()
  }

  /**
   * Completely remove a registered plugin (disable first, then unregister).
   *
   * Differs from `removeExternal`: ignores the enabled state and always removes it from the registry.
   * Use this when the main process manifest no longer has it (uninstalled) or the bundle changed (an
   * upgrade needs a reload); otherwise a zombie plugin remains with "menus/routes still there,
   * main-process channels already unregistered" (clicking it only reports channel-not-registered).
   * Doing this via the `applyEnabled` diff is impossible: it only handles ids present in the manifest.
   */
  async forgetPlugin(id: string): Promise<void> {
    if (!this.plugins.some((p) => p.manifest.id === id)) return
    await this.disable(id).catch(() => undefined)
    // disable returns early for ids that were never enabled, so delete the declaration here again (idempotent)
    this.declarations.delete(id)
    this.plugins = this.plugins.filter((p) => p.manifest.id !== id)
    this.states.delete(id)
    this.errors.delete(id)
    this.ctxs.delete(id)
    this.removeAllProvides(id)
    this.bump()
  }

  // ---------- Reactivity ----------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private bump(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }

  // ---------- Service access ----------

  /**
   * Slot conflict check: **only one plugin may occupy a given position**.
   *
   * Why not "later registration overrides earlier": plugins are third-party code, and silent
   * overriding means plugin A could take over plugin B's routes/menus (e.g. point `/notes` at its
   * own page) with no way for the user to tell which plugin did it. Failing enable outright (the
   * plugin panel shows state error with a readable message) is far better than "the UI was quietly
   * swapped".
   *
   * A plugin re-registering the same item is allowed (reload/hot-replace path); declarative
   * placeholders do not participate in this check.
   */
  private claimSlot<T extends { pluginId: string }>(
    registry: ScopedRegistry<T>,
    pluginId: string,
    kind: string,
    key: string,
    match: (item: T) => boolean
  ): void {
    const owner = registry.ownerOf(match)
    if (owner && owner !== pluginId) {
      throw new PluginError(
        PLUGIN_ERROR.SERVICE_MISSING,
        `插件 '${pluginId}' 的${kind} '${key}' 已被插件 '${owner}' 占用（宿主不允许两个插件占同一个位置）`
      )
    }
  }

  /** Build the scoped service for a given key for one plugin only (registered via an effect by default, rolled back on unload) */
  serviceFor<K extends HostServiceKey>(key: K, pluginId: string): HostServices[K] {
    switch (key) {
      case 'route':
        return {
          register: (r) => {
            const item = r as Omit<RegisteredRoute, 'pluginId'>
            // Routes may only be **concrete paths**: `*` would swallow all other plugins' routes and
            // `:` would grab their parameter segments; either lets one plugin "take over" the whole
            // UI (React Router takes the first match).
            if (
              typeof item.path !== 'string' ||
              !item.path.startsWith('/') ||
              item.path.includes('*') ||
              item.path.includes(':')
            ) {
              throw new PluginError(
                PLUGIN_ERROR.SERVICE_MISSING,
                `插件 '${pluginId}' 的路由 '${String(item.path)}' 不合法：必须以 / 开头，且不能含 * 或 :（占位与参数会抢别的插件的路由）`
              )
            }
            this.claimSlot(
              this.routeRegistry,
              pluginId,
              '路由',
              item.path,
              (x) => x.path === item.path
            )
            return this.routeRegistry.register(pluginId, item, () => this.bump())
          }
        } as HostServices[K]
      case 'menu':
        return {
          register: (m) => {
            const item = m as Omit<RegisteredMenuItem, 'pluginId'>
            this.claimSlot(
              this.menuRegistry,
              pluginId,
              '菜单键',
              item.key,
              (x) => x.key === item.key
            )
            return this.menuRegistry.register(pluginId, item, () => this.bump())
          }
        } as HostServices[K]
      case 'settingsSection':
        return {
          register: (s) => {
            const item = s as Omit<SettingsSectionRegistration, 'pluginId'>
            if (CORE_SETTINGS_TABS.has(item.tabKey)) {
              throw new PluginError(
                PLUGIN_ERROR.SERVICE_MISSING,
                `设置页键 '${item.tabKey}' 是宿主内核页签，插件不能占用（换一个 tabKey）`
              )
            }
            this.claimSlot(
              this.settingsRegistry,
              pluginId,
              '设置页键',
              item.tabKey,
              (x) => x.tabKey === item.tabKey
            )
            return this.settingsRegistry.register(pluginId, item, () => this.bump())
          }
        } as HostServices[K]
      case 'appProvider':
        return {
          register: (p) =>
            this.providerRegistry.register(
              pluginId,
              p as Omit<AppProviderRegistration, 'pluginId'>,
              () => this.bump()
            )
        } as HostServices[K]
      case 'globalComponent':
        return {
          register: (g) =>
            this.globalRegistry.register(
              pluginId,
              g as Omit<GlobalComponentRegistration, 'pluginId'>,
              () => this.bump()
            )
        } as HostServices[K]
      case 'bottomBar':
        return {
          register: (b) =>
            this.bottomBarRegistry.register(
              pluginId,
              b as Omit<BottomBarItemRegistration, 'pluginId'>,
              () => this.bump()
            )
        } as HostServices[K]
      case 'api':
        return {
          invoke: async (channel, ...args) => window.api.plugin.invoke(channel, ...args)
        } as unknown as HostServices[K]
      case 'i18n':
        return {
          addResources: (ns, resources) => {
            for (const lang of Object.keys(resources)) {
              i18n.addResourceBundle(lang, ns, resources[lang], true, true)
            }
          }
        } as HostServices[K]
      case 'events':
        return {
          on: (channel, cb) => {
            let set = this.eventHandlers.get(channel)
            if (!set) {
              set = new Set()
              this.eventHandlers.set(channel, set)
            }
            set.add(cb)
            return () => {
              set.delete(cb)
            }
          },
          emit: (channel, data) => {
            const set = this.eventHandlers.get(channel)
            if (!set) return
            for (const cb of [...set]) {
              try {
                cb(data)
              } catch (err) {
                console.error(`[plugin-host] Error in handler for event ${channel}:`, err)
              }
            }
          }
        } as unknown as HostServices[K]
      case 'storage': {
        const prefix = `rb.plugin.${pluginId}.`
        return {
          get: <T>(key: string): T | null => {
            try {
              const raw = window.localStorage.getItem(prefix + key)
              return raw === null ? null : (JSON.parse(raw) as T)
            } catch {
              return null
            }
          },
          set: (key: string, value: unknown): void => {
            window.localStorage.setItem(prefix + key, JSON.stringify(value))
          },
          remove: (key: string): void => {
            window.localStorage.removeItem(prefix + key)
          }
        } as HostServices[K]
      }
      default:
        throw new PluginError(PLUGIN_ERROR.SERVICE_MISSING, `未知宿主服务键 '${String(key)}'`)
    }
  }

  // ---------- Declarative pre-registration (first-frame placeholder) ----------

  /**
   * Pre-register a plugin's menu and routes from **manifest metadata** (synchronously, independent of
   * whether the plugin's renderer module has loaded).
   *
   * Why needed: a disk plugin's renderer module installs only after `fetch` + `import` +
   * `install(ctx)`, so on the first frame the sidebar had only the three static built-in menus and
   * the music menu "popped in" a few hundred milliseconds later (measured 2026-09-26: the early menu
   * assertions in the workshop harness failed outright). The main-process manifest
   * (`PluginListEntry.routes/menu`) already carries this metadata, so the host declares it during
   * construction and the first frame is complete; once the plugin module finishes loading, its real
   * registrations override the declaration by `key`/`path` (the `getMenus`/`getRoutes` merging
   * rules), so **a declaration is always just a placeholder**.
   *
   * Metadata only, no components or loaders: declared routes land in `PluginRouteView` of
   * `MainRoutes` through the "neither `load` nor `Component`" branch, rendering `<RouteSkeleton/>`
   * (the skeleton variant comes from the manifest's `skeleton`). Menu icons are resolved by the
   * caller with `declaredMenuIcon()` first.
   *
   * Cleanup: `disable()` (including withdrawal-driven unloads) and
   * `forgetPlugin()`/`removeExternal()` all delete that id's declarations; otherwise menus would
   * linger until the next launch after disable/uninstall.
   */
  declare(id: string, declaration: PluginDeclaration): void {
    // Declarations come from plugin.json on disk (no TS type validation), so they cannot be
    // catch-all routes either: `*` / `:` would grab other plugins' routes even as a first-frame
    // placeholder (real registration enforces the same check).
    const routes = (declaration.routes ?? []).filter(
      (route) =>
        typeof route.path === 'string' &&
        route.path.startsWith('/') &&
        !route.path.includes('*') &&
        !route.path.includes(':')
    )
    this.declarations.set(id, {
      ...(declaration.menu ? { menu: declaration.menu } : {}),
      ...(routes.length > 0 ? { routes } : {})
    })
    this.bump()
  }

  /** Get a vendored module instance for an external plugin */
  requireVendor(name: string): unknown {
    return (this.vendorModules ?? {})[name]
  }

  setVendorModules(modules: Record<string, unknown>): void {
    this.vendorModules = modules
  }

  private vendorModules?: Record<string, unknown>

  // ---------- provide registration (custom keys) ----------

  /** Register a custom key provided by a plugin (the host records the provider and value so other plugins can inject and use it) */
  registerProvide(pluginId: string, key: string, value: unknown): void {
    this.provides.set(key, { pluginId, value })
  }

  /** Get the value currently provided for a custom key (undefined when not provided) */
  getProvided<T>(key: string): T | undefined {
    return this.provides.get(key)?.value as T | undefined
  }

  private removeAllProvides(pluginId: string): void {
    for (const [key, entry] of [...this.provides]) {
      if (entry.pluginId === pluginId) this.provides.delete(key)
    }
  }

  // ---------- Lifecycle ----------

  private findPlugin(id: string): Plugin {
    const plugin = this.plugins.find((p) => p.manifest.id === id)
    if (!plugin) throw new PluginError(PLUGIN_ERROR.NOT_FOUND, `插件 '${id}' 不存在`)
    return plugin
  }

  /** Validate whether declared dependencies can be satisfied: host root keys are always available, custom keys need an active provider */
  private checkDeps(plugin: Plugin): string[] {
    const inject = plugin.manifest.inject ?? []
    return inject.filter(
      (k) => !(HOST_KEYS as readonly string[]).includes(k) && !this.provides.has(k)
    )
  }

  async enable(id: string): Promise<void> {
    if (this.enabled.has(id)) return
    const plugin = this.findPlugin(id)
    const missing = this.checkDeps(plugin)
    if (missing.length > 0) {
      const msg = `[plugin:${id}] 依赖未满足: ${missing.join(', ')}`
      this.errors.set(id, msg)
      this.states.set(id, 'error')
      this.bump()
      throw new PluginError(PLUGIN_ERROR.MISSING_DEP, msg)
    }
    const ctx = new PluginContext(id, this, plugin.manifest, undefined)
    this.ctxs.set(id, ctx)
    this.states.set(id, 'reloading')
    this.bump()
    try {
      // Inject the plugin's own stylesheet into the DOM first: otherwise the plugin's first frame
      // renders once without styles (see plugin-css.ts: the host's Tailwind cannot see external
      // plugin sources installed at runtime)
      await installPluginCss(id)
      const dispose = await plugin.install(ctx)
      ctx.attachInstallDispose(dispose)
      this.enabled.add(id)
      this.states.set(id, 'active')
      this.errors.delete(id)
    } catch (err) {
      removePluginCss(id)
      await ctx.dispose().catch(() => undefined)
      this.ctxs.delete(id)
      const msg = err instanceof Error ? err.message : String(err)
      this.errors.set(id, msg)
      this.states.set(id, 'error')
      this.bump()
      throw err
    }
    this.bump()
  }

  async disable(id: string): Promise<void> {
    if (!this.enabled.has(id)) {
      // Even when not enabled, clear the declarations: a declaration is a first-frame placeholder
      // (it may exist before enable), and a disabled plugin should have no menu.
      if (this.declarations.delete(id)) this.bump()
      // Same for styles: after disable, this plugin's CSS should not remain in `document`.
      removePluginCss(id)
      return
    }
    for (const pid of this.withdrawalOrder(id)) {
      const ctx = this.ctxs.get(pid)
      this.states.set(pid, 'unloading')
      this.bump()
      // 1) Remove registry entries first (menus/routes/settings pages disappear immediately)
      this.routeRegistry.removeAll(pid, () => this.bump())
      this.menuRegistry.removeAll(pid, () => this.bump())
      this.settingsRegistry.removeAll(pid, () => this.bump())
      this.providerRegistry.removeAll(pid, () => this.bump())
      this.globalRegistry.removeAll(pid, () => this.bump())
      this.bottomBarRegistry.removeAll(pid, () => this.bump())
      // 1.5) Clear declarations too: otherwise the first-frame declaration restores the menu after
      // "disable plugin" (lingering until the next launch)
      this.declarations.delete(pid)
      // 2) Roll back effects + install dispose in reverse order
      await ctx?.dispose().catch(() => undefined)
      this.removeAllProvides(pid)
      this.ctxs.delete(pid)
      this.enabled.delete(pid)
      this.states.set(pid, 'inactive')
      // Styles are removed together with the plugin (the UI only repaints after this.bump() below,
      // so no unstyled frame flickers)
      removePluginCss(pid)
    }
    this.bump()
  }

  /**
   * Withdrawal order: dependents unload before providers (leave/unload ordering).
   * Affected set = the target plugin + every enabled plugin that (transitively) injects a key
   * provided by an affected plugin; each step unloads a plugin that is no longer depended on by the
   * remaining affected plugins.
   */
  private withdrawalOrder(root: string): string[] {
    const affected = new Set<string>([root])
    let changed = true
    while (changed) {
      changed = false
      for (const [pid, ctx] of [...this.ctxs]) {
        if (affected.has(pid)) continue
        const providedByAffected = [...affected].some((aid) => {
          const aCtx = this.ctxs.get(aid)
          return aCtx ? ctx.injects().some((k) => aCtx.provided().includes(k)) : false
        })
        if (providedByAffected) {
          affected.add(pid)
          changed = true
        }
      }
    }

    const order: string[] = []
    const remaining = new Set(affected)
    const dependsOn = (n: string, m: string): boolean => {
      const ctxN = this.ctxs.get(n)
      const ctxM = this.ctxs.get(m)
      if (!ctxN || !ctxM) return false
      return ctxN.injects().some((k) => ctxM.provided().includes(k))
    }
    while (remaining.size > 0) {
      const next = [...remaining].find((n) =>
        [...remaining].every((m) => m === n || !dependsOn(n, m))
      )
      if (!next) {
        // Cycle fallback: unload the rest directly (circular custom-key dependencies should not
        // happen; if they do, any order works)
        for (const pid of remaining) order.push(pid)
        break
      }
      order.push(next)
      remaining.delete(next)
    }
    return order
  }

  // ---------- Queries ----------

  getRoutes(): RegisteredRoute[] {
    return this.cached('routes', () => this.mergeDeclaredRoutes(this.routeRegistry.getAll()))
  }

  getMenus(): RegisteredMenuItem[] {
    return this.cached('menus', () => this.mergeDeclaredMenus(this.menuRegistry.getAll()))
  }

  /**
   * Merge real registrations + declarations: for the same `key`/`path`, **real registrations win**.
   *
   * Once a plugin's renderer module finishes loading it registers its own entry, so the declaration
   * is filtered out here by the same key/path check; order still follows `order` (then key as a
   * tiebreaker), so declarations never disturb sidebar ordering.
   */
  private mergeDeclaredMenus(real: RegisteredMenuItem[]): RegisteredMenuItem[] {
    const seen = new Set(real.map((m) => m.key))
    const merged = [...real]
    for (const [pluginId, declaration] of this.declarations) {
      const d = declaration.menu
      if (!d || seen.has(d.key)) continue
      seen.add(d.key)
      merged.push({
        pluginId,
        key: d.key,
        labelKey: d.labelKey,
        icon: d.icon,
        order: d.order ?? 0
      })
    }
    return merged.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
  }

  /** Route version of the merge rule (same `path`: real registration wins); declared routes have no load/Component and land on the skeleton screen */
  private mergeDeclaredRoutes(real: RegisteredRoute[]): RegisteredRoute[] {
    const seen = new Set(real.map((r) => r.path))
    const merged = [...real]
    for (const [pluginId, declaration] of this.declarations) {
      for (const d of declaration.routes ?? []) {
        if (seen.has(d.path)) continue
        seen.add(d.path)
        merged.push({ pluginId, path: d.path, skeleton: d.skeleton })
      }
    }
    return merged
  }

  getMenuKeys(): string[] {
    return this.cached('menuKeys', () => this.getMenus().map((m) => m.key))
  }

  getSettingsSections(): SettingsSectionRegistration[] {
    return this.cached('settingsSections', () =>
      this.settingsRegistry
        .getAll()
        .sort((a, b) => a.order - b.order || a.tabKey.localeCompare(b.tabKey))
    )
  }

  getProviders(): AppProviderRegistration[] {
    return this.cached('providers', () =>
      this.providerRegistry
        .getAll()
        .sort((a, b) => a.order - b.order || a.pluginId.localeCompare(b.pluginId))
    )
  }

  getGlobalComponents(slot: string): GlobalComponentRegistration[] {
    return this.cached(`globalComponents:${slot}`, () =>
      this.globalRegistry.getAll().filter((g) => g.slot === slot)
    )
  }

  /** Bottom bar slot items (sorted by order; the host only sorts and does not decide visibility) */
  getBottomBarItems(): BottomBarItemRegistration[] {
    return this.cached('bottomBarItems', () =>
      this.bottomBarRegistry.getAll().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    )
  }

  getDescriptor(id: string): PluginDescriptor | undefined {
    const plugin = this.plugins.find((p) => p.manifest.id === id)
    if (!plugin) return undefined
    return this.toDescriptor(plugin)
  }

  getDescriptors(): PluginDescriptor[] {
    return this.cached('descriptors', () => this.plugins.map((p) => this.toDescriptor(p)))
  }

  /**
   * Versioned result cache: repeated calls within the same version return the same reference.
   * Fixes "fresh array reference jitter" — when useMemo/useEffect depend on these getter results, a
   * new array on every render replays effects repeatedly (e.g. SettingsModal's activeTab being reset
   * after opening, App providers remounting).
   */
  private readonly getterCache = new Map<string, { version: number; value: unknown }>()

  private cached<T>(key: string, compute: () => T): T {
    const hit = this.getterCache.get(key)
    if (hit && hit.version === this.version) return hit.value as T
    const value = compute()
    this.getterCache.set(key, { version: this.version, value })
    return value
  }

  private toDescriptor(plugin: Plugin): PluginDescriptor {
    const m: PluginManifest = plugin.manifest
    return {
      manifest: m,
      source: 'external',
      enabled: this.enabled.has(m.id),
      state: this.states.get(m.id) ?? 'inactive',
      error: this.errors.get(m.id)
    }
  }

  /** Apply enabled states in bulk (diff-driven): enabled plugins enable in order, disabled ones unload in withdrawal order */
  async applyEnabled(map: Record<string, boolean>): Promise<void> {
    const want: Array<[string, boolean]> = []
    for (const key of Object.keys(map)) {
      // Skip unregistered ids (e.g. external plugins not yet loaded); the bridge replays them once loading completes
      if (!this.plugins.some((p) => p.manifest.id === key)) continue
      const wantEnabled = Boolean(map[key])
      const current = this.enabled.has(key)
      if (wantEnabled !== current) want.push([key, wantEnabled])
    }
    // Disable first (dependents unload first), then enable
    for (const [id, on] of want) {
      if (!on)
        await this.disable(id).catch((err) => console.error(`[plugin-host] Failed to disable ${id}:`, err))
    }
    for (const [id, on] of want) {
      if (on)
        await this.enable(id).catch((err) => console.error(`[plugin-host] Failed to enable ${id}:`, err))
    }
  }

  isEnabled(id: string): boolean {
    return this.enabled.has(id)
  }

  /** Whether every registered plugin has finished loading per its enabled state (used by the Provider for first-screen decisions) */
  hasLoaded(): boolean {
    for (const p of this.plugins) {
      const st = this.states.get(p.manifest.id)
      if (st === 'reloading' || st === 'unloading') return false
    }
    return true
  }
}
