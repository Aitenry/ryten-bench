/**
 * Cross-process contract for the plugin workshop (shared by the main-process service,
 * AI tools and the settings page).
 *
 * Why a separate file: the workshop's three consumption paths (IPC → settings page,
 * tool → model, service → build/verify) must agree on what a draft looks like and what
 * one verify run consists of. This file **must not** import react / electron / node
 * (same rule as shared/types.ts) so all three builds can bundle it directly.
 *
 * Terms:
 * - **draft**: a plugin source directory under `<userData>/plugin-workshop/drafts/<id>/`;
 *   the assistant reads and writes it with the `plugin_draft` tool, users don't edit it directly;
 * - **package**: the built installable plugin bundle `.../dist/<id>/{plugin.json,main.cjs,
 *   renderer.mjs,chunk-*.mjs,plugin.css}`, structurally identical to `dist/<id>` in the
 *   plugin repository;
 * - **verify**: run the automated test battery against the package and produce a
 *   `WorkshopReport`.
 */

/**
 * Draft template: decides which skeleton `plugin_draft create` generates.
 *
 * `full` is the **default** (the user's wording: "the default is all content"): page +
 * settings page + AI tools + channel/event push + uninstall cleanup. The other four are
 * narrow templates for "only one part is needed", used by the assistant when it knows only
 * one form is required (the new-draft entry in the UI offers no choice).
 */
export type WorkshopTemplate = 'full' | 'page' | 'tool' | 'panel' | 'minimal'

/**
 * Source of the plugin's own stylesheet.
 *
 * - `auto`: at build time, Tailwind (theme + utilities, **no preflight**) scans the draft
 *   source and generates it — exactly the manual approach `plugin.css` prescribes (see
 *   src/main/workshop/css.ts); the workshop automates it;
 * - `file`: a hand-written `plugin.css` in the draft goes into the package as-is (for plain CSS);
 * - `off`: no stylesheet (use inline styles / antd components only).
 *
 * In every mode, verify flags any class name used in the package that has no matching rule —
 * this is the regression gate for the incident where external plugin UIs got deformed.
 */
export type WorkshopCssMode = 'auto' | 'file' | 'off'

/** Outcome of a single check */
export type WorkshopCheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

/** One check in the verify battery (the panel shows them one by one; the model decides what to fix next) */
export interface WorkshopCheck {
  /** Stable id (comparable across versions, e.g. `pkg.manifest`, `main.smoke`) */
  id: string
  /** One-line title (shown in the panel) */
  title: string
  status: WorkshopCheckStatus
  /** Result details (informative even when passing: channel count, size, how many class names were covered) */
  detail?: string
  /** Actionable next step for the model when failing/warning */
  hint?: string
  /** true = the plugin is unusable (fatal failure); false/absent = advisory */
  fatal?: boolean
  durationMs?: number
}

/** Build result (package manifest + diagnostics) */
export interface WorkshopBuildInfo {
  ok: boolean
  /** Package directory (dist/<id>), undefined on failure */
  outDir?: string
  at?: number
  /**
   * Fingerprint of the draft sources this package was built from (written on a successful build).
   *
   * A mismatch with the current source fingerprint means the package is older than the
   * sources. **mtime is no longer used**: after a build finishes the workshop writes
   * `workshop.json` back, which is always newer than the package, so an mtime-based rule
   * would mark every build as stale immediately.
   */
  sourceHash?: string
  durationMs: number
  files: { path: string; size: number }[]
  /** Fatal errors (no package can be produced) */
  errors: string[]
  /** Non-fatal warnings (package works but has issues) */
  warnings: string[]
  /** Stylesheet output */
  css?: {
    mode: WorkshopCssMode
    bytes: number
    /** Number of candidate class names scanned from the package */
    candidates: number
    /** Class names with no rule in the generated CSS (first few) */
    missing: string[]
  }
}

/** Main-process smoke result (drives the package's main.cjs through the real install(ctx) contract) */
export interface WorkshopMainSmoke {
  /** Registered IPC channels */
  channels: string[]
  /** Declared event channels (send side only) */
  events: string[]
  /** Contribution points (key → entry labels) */
  contributions: { key: string; labels: string[] }[]
  /** Number of reversible effects registered via `ctx.effect` */
  effects: number
  /** Results of the draft's own smoke cases (workshop.smoke.mjs) */
  cases: { name: string; ok: boolean; detail?: string; durationMs?: number }[]
  /** Load duration */
  durationMs: number
}

/** Renderer live probe result (import + install the plugin's renderer module inside the real host) */
export interface WorkshopRendererProbe {
  status: 'pass' | 'fail' | 'skip'
  detail?: string
  /** Registrations recorded by the probe (`route:/demo`, `menu:demo`, `i18n`…) */
  registrations?: string[]
  durationMs?: number
}

/** Full report of one verify run */
export interface WorkshopReport {
  id: string
  /** Manifest version that was verified (the panel shows which version passed) */
  version?: string
  at: number
  durationMs: number
  /** true = all fatal checks passed */
  ok: boolean
  /**
   * Fingerprint of the draft sources at verify time (after the build).
   *
   * The publish gate uses it to decide whether this report represents the current sources:
   * if the sources changed after a passing report, a fresh verify is required even after a
   * rebuild (the package is new) — unverified new code must not be installed.
   */
  sourceHash?: string
  checks: WorkshopCheck[]
  build: WorkshopBuildInfo
  main?: WorkshopMainSmoke
  renderer?: WorkshopRendererProbe
}

/** One file in the draft directory */
export interface WorkshopDraftFile {
  /** POSIX path relative to the draft root */
  path: string
  size: number
  mtime: number
}

/** Draft metadata (`drafts/<id>/workshop.json`, maintained by the workshop; the assistant doesn't edit it) */
export interface WorkshopDraftMeta {
  id: string
  title: string
  template: WorkshopTemplate
  description?: string
  css: WorkshopCssMode
  createdAt: number
  updatedAt: number
  /** Last successful build time (written on a successful build) */
  builtAt?: number
  /**
   * Which sources the current `dist/<id>` was built from (fingerprint written on a
   * successful build).
   *
   * Only covers "package vs sources"; the verify report carries its own `sourceHash` —
   * publishing is allowed only when both equal the current source fingerprint (a fresh
   * package without a fresh verify is still not installable).
   */
  sourceHash?: string
}

/** Publish-gate verdict (shared by the tool and the panel) */
export interface WorkshopPublishGate {
  /** true = can publish */
  ready: boolean
  /** Reason why not (stable enum so callers can give different prompts) */
  reason?:
    | 'no-report'
    | 'report-failed'
    | 'no-build'
    | 'stale-report'
    | 'sources-changed'
    | 'stale-build'
  /** Actionable explanation for the model/user (empty when ready) */
  detail: string
}

/** Draft list item (shared by the settings-page list and the tool's list action) */
export interface WorkshopDraftSummary {
  id: string
  title: string
  template: WorkshopTemplate
  version: string
  description?: string
  createdAt: number
  updatedAt: number
  fileCount: number
  /** Whether a package exists (dist/<id>/plugin.json) */
  built: boolean
  builtAt?: number
  /** Whether it is already installed into userData/plugins/<id> */
  installed: boolean
  enabled: boolean
  /**
   * The user-configured **plugin storage path** (root of all plugin sources,
   * `<pluginsPath>/<plugin id>/`).
   *
   * On first launch it defaults to `<installDir>/data/plugins` (falling back to
   * `<userData>/data/plugins` when not writable); the user can change it in settings
   * (data in the old path is migrated). Once the user clears it, the workshop lists no
   * drafts and cannot create new ones. The workshop's own package/report directory (under
   * userData) does not appear in the UI.
   */
  pluginsPath?: string
  /**
   * Absolute path of the draft root (`<pluginsPath>/<plugin id>/`).
   *
   * The sidebar uses it to match a plugin row with its plugin workspace: the plugin
   * conversation's working directory is this directory (see main/workshop/workspace.ts),
   * and the conversation follows this workspace.
   */
  dir: string
  /** Summary of the latest verify run (absent when there is none) */
  lastReport?: { at: number; ok: boolean; failed: number; total: number }
  /** Whether the package is structurally identical to the app bundle / installed copy (undefined when it cannot be determined) */
  distBytes?: number
}

/** Draft details (for the settings-page drawer: list item + file list + raw manifest) */
export interface WorkshopDraftDetail extends WorkshopDraftSummary {
  files: WorkshopDraftFile[]
  /** Parsed plugin.json (null when invalid; the error shows up in the lint check) */
  manifest: Record<string, unknown> | null
  css: WorkshopCssMode
}

/** Unified return value of workshop actions (failures don't throw; the panel prompts accordingly) */
export interface WorkshopActionResult<T = unknown> {
  ok: boolean
  error?: string
  data?: T
}

/** Install (publish) result */
export interface WorkshopPublishResult {
  id: string
  version: string
  /** true = overwrote an existing install with the same id */
  upgraded: boolean
  /** Final directory (userData/plugins/<id>) */
  dest: string
  files: number
  enabled: boolean
  /** Reports honestly when the package is older than the draft sources (the panel can suggest rebuilding) */
  staleBuild?: boolean
  /**
   * Renderer re-check result taken right after installing (present only if it actually ran:
   * install succeeded but the renderer crashed → it was rolled back automatically, and this
   * throws instead of returning a result).
   */
  rendererProbe?: WorkshopRendererProbe
}

/**
 * Whether two filesystem paths point to the same location.
 *
 * Single but critical purpose: match a **plugin row** with its plugin workspace — the main
 * process stores `<plugin storage path>/<plugin id>/` when creating the workspace, while the
 * renderer compares using the draft's `dir`; both sides must use the same rule, otherwise a
 * plugin row cannot recognise its own conversation (see main/workshop/workspace.ts and
 * HarnessSidebar).
 *
 * Deliberately avoids node:path (the renderer doesn't have it): it only trims trailing
 * separators and ignores case for Windows paths, which is enough and consistent on both
 * sides. Relative paths and case-sensitive platforms are left to the caller.
 */
export function isSameFsPath(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const norm = (p: string): string => p.trim().replace(/[\\/]+$/, '')
  const left = norm(a)
  const right = norm(b)
  if (!left || !right) return false
  // If either side looks like a Windows path (has a backslash), compare case-insensitively:
  // the same directory must not have two spellings
  return left.includes('\\') || right.includes('\\')
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}
