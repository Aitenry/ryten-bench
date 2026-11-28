import type { ComponentType, ReactNode } from 'react'
import type { PluginManifest } from '@shared/plugin/types'
import type { PluginContext } from './context'

/**
 * Renderer-side plugin host type system.
 *
 * Context keys (ContextKeys) map mount points such as routes, menus, settings pages, providers, and
 * global components to keys in a shared context: plugins declare dependencies by key (inject), and
 * the host consumes them through registries.
 */

/** Lazy loader factory: returns the default-exported page component (built-in plugins use a vite dynamic import chunk) */
export type LazyLoader = () => Promise<{ default: ComponentType }>

export interface RegisteredRoute {
  pluginId: string
  path: string
  /** Skeleton variant (string; unknown values fall back to the generic skeleton) */
  skeleton?: string
  /** Lazily loaded; mutually exclusive with Component */
  load?: LazyLoader
  /** Render immediately (e.g. built-in pages used on the first screen); mutually exclusive with load */
  Component?: ComponentType
}

export interface RegisteredMenuItem {
  pluginId: string
  key: string
  labelKey: string
  icon: ReactNode
  order: number
}

/**
 * **Declarative pre-registration item**: pure metadata from the main-process list
 * (`PluginListEntry.routes/menu`), with no components or loaders.
 *
 * Difference from a real registration: the real registration is supplied by the plugin's
 * `install(ctx)` (with `Component`/`load` and a component-shaped `icon`) and is authoritative; the
 * declaration is only a first-frame placeholder and is overridden by the real registration on the
 * same `key`/`path` (see `declare()` and `getMenus`/`getRoutes` in `host.ts`).
 */
export interface PluginDeclaration {
  /** Sidebar menu (`icon` already resolved to a node by `declaredMenuIcon()` from the name in the manifest) */
  menu?: { key: string; labelKey: string; icon: ReactNode; order?: number }
  /** Routes (without `load`/`Component` → `MainRoutes` renders the `RouteSkeleton` skeleton) */
  routes?: { path: string; skeleton?: string }[]
}

export interface SettingsSectionRegistration {
  pluginId: string
  tabKey: string
  labelKey: string
  icon: ReactNode
  group: string
  order: number
  Component: ComponentType
}

export type ProviderComponent = ComponentType<{ children: ReactNode }>

export interface AppProviderRegistration {
  pluginId: string
  Provider: ProviderComponent
  order: number
}

export interface GlobalComponentRegistration {
  pluginId: string
  id: string
  slot: string
  Component: ComponentType
}

/**
 * Bottom bar (shell slot `bottomBar`) item registration.
 *
 * Why not a plain globalComponent: the bottom bar is a **carousel** (music ⇄ weather), so the host
 * must know "whether this item should join the carousel now" and must re-render when visibility
 * changes — hence the registration carries `isVisible()` (read by the host on every render) and
 * `subscribe()` (plugin-side subscription to visibility changes). The shell only knows this
 * registry and imports no plugin modules.
 */
export interface BottomBarItemRegistration {
  pluginId: string
  id: string
  /** Carousel order: lower values first (music 10 before weather) */
  order: number
  /** Whether it currently joins the carousel (read by the host on every render; plugins trigger re-renders through subscriptions) */
  isVisible: () => boolean
  /** Subscribe to visibility changes (optional) */
  subscribe?: (onChange: () => void) => () => void
  /** The bottom bar row (title with icon) */
  Tab: ComponentType
  /** Hover popup content */
  Popup: ComponentType
}

/** Registry service: register returns a dispose function (reversible effect); the host clears the whole group when a plugin unloads */
export interface RegistryService<T extends { pluginId: string }> {
  register(item: Omit<T, 'pluginId'>): () => void

  getAll(): T[]
}

/** Fixed service keys built into the host (cannot be provided by plugins) */
export interface HostServices {
  route: RegistryService<RegisteredRoute>
  menu: RegistryService<RegisteredMenuItem>
  settingsSection: RegistryService<SettingsSectionRegistration>
  appProvider: RegistryService<AppProviderRegistration>
  globalComponent: RegistryService<GlobalComponentRegistration>
  /** Bottom bar slot: the shell carousels visible items by order (the music item is filled in by the music plugin) */
  bottomBar: RegistryService<BottomBarItemRegistration>
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> }
  i18n: { addResources: (ns: string, resources: Record<string, unknown>) => void }
  events: {
    on: (channel: string, cb: (data?: unknown) => void) => () => void
    emit: (channel: string, data?: unknown) => void
  }
  /** Plugin-private persistence (namespace isolated by plugin id) */
  storage: {
    get<T>(key: string): T | null
    set(key: string, value: unknown): void
    remove(key: string): void
  }
}

export type HostServiceKey = keyof HostServices

/** Plugin: manifest + install (the implementation-layer entry point) */
export interface Plugin {
  manifest: PluginManifest

  /** Reversible install: inverse operations of registrations go onto the ctx.effect rollback stack; the returned dispose runs last */
  install(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>
}
