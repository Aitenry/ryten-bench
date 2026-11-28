/**
 * Cross-process shared types for the plugin system (shared by main / preload / renderer).
 *
 * The model treats a component as a plugin:
 * - inject  = dependency declaration (coeffect): the plugin declares through context keys which
 *   host capabilities it needs;
 * - provide = provision declaration: the plugin declares through context keys what it provides;
 * - install(ctx) => dispose is a reversible effect: registered inverse operations go onto a
 *   rollback stack and run in reverse order on uninstall.
 *
 * Note: this file must not import electron / node / react dependencies; both build targets must be
 * able to bundle it directly.
 */

/** Plugin manifest (plugin.json; third-party plugins only — the built-in plugin mechanism distributed with the app has been removed) */
export interface PluginManifest {
  /**
   * Stable unique identifier (`plugin.<author>.<name>`, or a neutral short name without a prefix).
   *
   * Namespace rule: the id with its leading `plugin.` segment removed is the IPC namespace
   * (`plugin:<namespace>:*`), so `plugin.demo` and `demo` collide on the same namespace and the
   * host rejects the second one (see `channelNamespace`).
   */
  id: string
  /** Display name */
  name: string
  /** semver version */
  version: string
  description?: string
  /** Plugin icon: plugin://<id>/icon.svg or a data: URI */
  icon?: string
  /** Entry points (all required; the build output is written by the workshop) */
  entry?: {
    /** Renderer entry (ESM), usually `renderer.mjs` */
    renderer?: string
    /** Main process entry (CJS), usually `main.cjs` */
    main?: string
  }
  /** Dependency declaration: context keys accessible in install. Accessing an undeclared key → UNDECLARED_ACCESS */
  inject?: string[]
  /** Provision declaration: keys produced by ctx.set in install. Used for the dependency graph and uninstall order (withdrawal) */
  provide?: string[]
  /** Route metadata */
  routes?: { path: string; skeleton?: string }[]
  /** Sidebar menu metadata (absent means no menu item appears) */
  menu?: { key: string; labelKey: string; icon: string; order?: number }
  /** Capability declaration allowlist (this version declares them and validates main-process channels; enforcement is a later enhancement) */
  permissions?: string[]
}

/** Plugin runtime state (a descriptor shared across the three processes) */
export interface PluginDescriptor {
  manifest: PluginManifest
  source: 'external'
  /** Absolute path of the plugin directory */
  dir?: string
  /** Final enabled state after merging persisted overrides */
  enabled: boolean
  state: PluginState
  error?: string
}

/** Renderer fiber lifecycle state (two simplified states plus failure recovery) */
export type PluginState = 'inactive' | 'reloading' | 'active' | 'unloading' | 'error'

/** Minimal manifest data seen by the plugin admin/renderer (processed and broadcast by the main process; installed plugins only) */
export interface PluginListEntry {
  id: string
  name: string
  version: string
  description?: string
  icon?: string
  enabled: boolean
  state: PluginState
  error?: string
  /**
   * **Content stamp** of this plugin package on disk (the maximum mtime of the entry files and
   * `plugin.css`).
   *
   * Why not `version`: reinstalling or upgrading a local package often leaves the version number
   * unchanged, yet the renderer must know that "the code on disk changed, so renderer.mjs has to be
   * re-fetched and plugin.css re-injected" — otherwise the user still sees the old UI after
   * upgrading (observed in practice on 2026-09-26).
   */
  stamp?: string
  /** Plugin entry (the basis for the renderer loader and for main-process loading) */
  entry?: { renderer?: string; main?: string }
  /**
   * Route metadata (same shape as `PluginManifest.routes`, taken straight from the manifest).
   *
   * Its purpose is **declarative pre-registration for the first frame**: a disk-package plugin's
   * renderer module is only installed after fetch + import, so the first frame would otherwise have
   * an empty sidebar/route table (the menu "pops up a few hundred milliseconds late"). The renderer
   * uses this metadata to register synchronously during host construction, and the plugin's own
   * real registration overrides it once the module has loaded (see `declare()` in
   * `renderer/src/plugin-host/host.ts`).
   */
  routes?: { path: string; skeleton?: string }[]
  /** Sidebar menu metadata (as above; `icon` is a remixicon name string, and declared items are resolved to nodes by name) */
  menu?: { key: string; labelKey: string; icon: string; order?: number }
  /**
   * A one-sentence claim contributed by the plugin's `plugin.purge` about what it will delete
   * (e.g. "the music library and the managed playlist directory").
   *
   * Only used to make the "data deleted at the same time" line concrete in the uninstall
   * confirmation dialog — the contribution itself exists only while the plugin is still loaded, so
   * it may be undefined right after startup or while the plugin is disabled; the UI needs fallback
   * copy.
   */
  purgeLabel?: string
}

/** Validate that the minimal manifest fields are present (invalid plugins are silently skipped / rejected at install) */
export function isValidManifest(m: unknown): m is PluginManifest {
  if (typeof m !== 'object' || m === null) return false
  const o = m as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    /^[A-Za-z][A-Za-z0-9._-]*$/.test(o.id) &&
    typeof o.name === 'string' &&
    typeof o.version === 'string' &&
    typeof o.entry === 'object' &&
    o.entry !== null
  )
}
