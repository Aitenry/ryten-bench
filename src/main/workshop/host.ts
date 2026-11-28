import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'node:module'
import type { WorkshopRendererProbe } from '../../shared/harness/workshop'
import type { ModuleLoader } from './css'
import { configureWorkshopRoot, distDir, draftDir, isWorkshopReady } from './paths'
import { draftSourceHash } from './fingerprint'
import { readDraftMeta } from './store'

/**
 * **Host wiring** for the workshop: the service itself does not import electron (so offline
 * tooling can run the whole pipeline); every capability that "only exists in the app" is
 * injected from here.
 *
 * Injection has three layers; a missing layer only degrades the corresponding feature and
 * does not block the rest:
 * - **Module loader** (`loader`): esbuild / tailwindcss / jszip — when unavailable, build/style/export each report a readable error;
 * - **Host tables** (`hostMainKeys` / `hostUiKeys`): the verification battery uses them to check that every host specifier in the output actually resolves;
 * - **Install actions** (`installPackage` / `enable` / `uninstall` / `notify`): publish and uninstall go through the host's existing plugin-loading chain (**exactly the same code** as install/uninstall in the panel); the workshop does not build a second one.
 */

/** Installation result of a host plugin package (a subset of core `installPackageDir`) */
export interface InstalledPackageLike {
  id: string
  name: string
  version: string
  upgraded: boolean
  dest: string
  files: number
}

export interface WorkshopHost {
  /** Workshop root directory (`<userData>/plugin-workshop`) */
  root: string
  /** Keys of the host main-process runtime table (`@host/main/**`, `@host/shared/**`) */
  hostMainKeys: () => string[]
  /** Keys of the host renderer UI table; `null` = the renderer has not reported yet (skip the corresponding check) */
  hostUiKeys: () => string[] | null
  /** Whether it is installed (`userData/plugins/<id>` exists) */
  isInstalled: (id: string) => boolean
  /** Whether it is enabled (includes "installed but disabled") */
  isEnabled: (id: string) => boolean
  /**
   * Channel namespaces already in use (name-collision check).
   *
   * `exceptId` is the **plugin id to exclude**: a namespace is the plugin id with the
   * `plugin.` segment removed, so "the draft `twin` itself is already installed" and
   * "another plugin `plugin.twin` occupies `plugin:twin:`" must be distinguished — the
   * former is not a conflict, the latter is. The host filters by id; the workshop only
   * compares namespaces.
   */
  usedNamespaces: (exceptId?: string) => string[]
  /** Module loader (esbuild / tailwindcss / jszip are taken from it) */
  loader: ModuleLoader
  /** Install (or upgrade) a plugin package directory already written to disk */
  installPackage: (dir: string) => InstalledPackageLike
  /** Enable: write the enabled override + load the main module */
  enable: (id: string) => void
  /** Disable: unload only the main module, keep the installed directory */
  disable: (id: string) => void
  /** Uninstall: unload the main module + delete the directory + clear the override (data is handled by the plugin's own purge contribution) */
  uninstall: (id: string) => void
  /** Persist the "plugin storage path" (the harness `pluginsPath` setting) */
  setPluginsRoot: (dir: string) => void
  /** Broadcast a plugin state change (the renderer re-fetches plugin modules and styles based on it) */
  notify: () => void
  /** Live renderer probe (`skip` when no window is available) */
  probeRenderer?: (id: string) => Promise<WorkshopRendererProbe>
}

let host: WorkshopHost | null = null

/** Wire up (called in the plugin install effect; null = turn the workshop off) */
export function configureWorkshopHost(next: WorkshopHost | null): void {
  host = next
  configureWorkshopRoot(next?.root)
}

/** Whether the workshop is available (tools and channels use it for readable errors) */
export function isWorkshopConfigured(): boolean {
  return host !== null && isWorkshopReady()
}

/** Get the host wiring (throws a readable error when not wired) */
export function workshopHost(): WorkshopHost {
  if (!host) {
    throw new Error('插件工坊尚未接线（宿主未注入工坊能力）')
  }
  return host
}

/** Get the host wiring (may be null; for callers that can degrade gracefully) */
export function workshopHostOrNull(): WorkshopHost | null {
  return host
}

/**
 * Build a module loader from Node resolution paths (the app uses bases such as
 * `app.getAppPath()`).
 *
 * Why try candidate bases one by one: in dev, esbuild/tailwindcss live in the repo
 * `node_modules`; after packaging, only the copy unpacked by `asarUnpack` under
 * `app.asar.unpacked` can be `spawn`ed or read from disk. Resolving one by one until a hit
 * is more reliable than "guessing a path".
 */
export function createNodeLoader(bases: string[]): ModuleLoader {
  const clean = [...new Set(bases.filter((b): b is string => typeof b === 'string' && b !== ''))]
  const requires = clean.map((base) =>
    createRequire(base.endsWith('package.json') ? base : path.join(base, 'package.json'))
  )
  const find = (id: string): NodeRequire | null => {
    for (const req of requires) {
      try {
        req.resolve(id)
        return req
      } catch {
        // Try the next base
      }
    }
    return null
  }
  const fail = (id: string): never => {
    throw new Error(
      `解析不到模块 '${id}'（尝试的基准：${clean.join(' / ') || '（空）'}）。` +
        `插件构建需要 esbuild（样式生成还需要 tailwindcss）：` +
        `开发环境由仓库 node_modules 提供；打包后的应用需要把它们放进 dependencies 并加入 asarUnpack。`
    )
  }
  return {
    require: (id) => {
      const req = find(id)
      if (!req) return fail(id)
      return req(id)
    },
    resolve: (id) => {
      const req = find(id)
      if (!req) return fail(id)
      return req.resolve(id)
    }
  }
}

/** Whether the output directory has build results (a plugin.json counts) */
export function hasBuild(id: string): boolean {
  try {
    return fs.existsSync(path.join(distDir(id), 'plugin.json'))
  } catch {
    return false
  }
}

/**
 * Fingerprint of the current draft source (reads the css mode from `workshop.json`, then
 * hands it to `draftSourceHash`).
 *
 * This is the same measure used by the publish gate and by build output: if the fingerprint
 * recorded in the output/report differs from it, the source changed after that point (or the
 * output was not built from this source).
 */
export function currentSourceHash(id: string): string {
  const meta = readDraftMeta(id)
  return draftSourceHash(id, meta?.css ?? 'auto')
}

/**
 * Whether the output lags behind the draft source (used before publish/verify to suggest a
 * rebuild first).
 *
 * **Compares content fingerprints, not mtime**: the build writes `workshop.json` back at the
 * end, and the mtime measure would declare staleness immediately after every build
 * (`plugin_publish` then refuses to install forever, the 2026-11-23 user incident).
 *
 * Old outputs without a recorded fingerprint fall back to mtime (excluding `workshop.json`) —
 * the first build after the upgrade writes the fingerprint, and afterwards it is always a
 * content comparison.
 */
export function isBuildStale(id: string): boolean {
  try {
    if (!hasBuild(id)) return false
    const meta = readDraftMeta(id)
    if (typeof meta?.sourceHash === 'string' && meta.sourceHash !== '') {
      return meta.sourceHash !== draftSourceHash(id, meta.css)
    }
    return legacyMtimeStale(id)
  } catch {
    // Do not block when the source cannot be read (directory moved/permissions): the publish gate first rejects for "no verification report / no output"
    return false
  }
}

/** Fallback for old outputs (no sourceHash): compare mtime, but exclude the workshop.json the workshop writes back */
function legacyMtimeStale(id: string): boolean {
  const out = path.join(distDir(id), 'plugin.json')
  if (!fs.existsSync(out)) return false
  const builtAt = fs.statSync(out).mtimeMs
  let newest = 0
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (['node_modules', '.git', 'dist', '.cache', 'backups'].includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      // This file is written back by the workshop after the build (builtAt/updatedAt); it does not count as a source change
      if (entry.name === 'workshop.json') continue
      newest = Math.max(newest, fs.statSync(full).mtimeMs)
    }
  }
  walk(draftDir(id))
  return newest > builtAt
}
