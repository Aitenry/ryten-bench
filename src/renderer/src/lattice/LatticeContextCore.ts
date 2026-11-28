import { createContext } from 'react'
import { EMPTY_HUB_LIST, EMPTY_LATTICE_STATUS, emptySyncResult } from './types'
import type {
  HubDetailV2,
  HubListResultV2,
  LatticeAutoInstallSettingResult,
  LatticeDownloadKind,
  LatticeDownloadResult,
  LatticeImportLocalDirResult,
  LatticeInstallResultV2,
  LatticeListQuery,
  LatticeLoginInput,
  LatticeLoginResult,
  LatticeOpenSourceResult,
  LatticeRepublishInput,
  LatticeRepublishResult,
  LatticeSourcePathResult,
  LatticeStatus,
  LatticeSyncDetails,
  LatticeSyncDirection,
  LatticeSyncResult,
  LatticeUploadProgress,
  LatticeUploadResult,
  LatticeUser
} from './types'
import type { LatticeV2Capabilities } from './source'
import { LATTICE_BRIDGE_MISSING } from './api'

/**
 * The **contract** of the plugin center context (the provider's consumer surface).
 *
 * Kept in a separate file (same convention as `contexts/ThemeContextCore.ts`) for two reasons:
 * 1. `react-refresh/only-export-components` only hot-reloads files that export components, so the
 *    context object cannot live in the same module as `<LatticeProvider>`;
 * 2. Pages depend only on this type/context, not on the provider implementation.
 *
 * Responsibilities: the provider holds all `window.api.lattice` state (login, sync, upload
 * progress, catalog data) and wraps each IPC method (refreshing status after login/logout/sync).
 * When the main-process channel is not registered yet, `available=false` and every method returns
 * an "unavailable" fallback result, so the UI degrades safely.
 */
export interface LatticeContextValue {
  /** Whether the main process exposes `window.api.lattice` (false = plugin center not ready, UI must degrade) */
  available: boolean
  /** Whether the first status read has completed (false shows "connecting…" in the account area instead of flashing logged-out) */
  ready: boolean
  status: LatticeStatus
  loggedIn: boolean
  user: LatticeUser | undefined
  role: string | undefined
  /**
   * Account avatar (a normalized view of `user.avatar`): non-empty = platform avatar URL
   * (https/data:image), null = no avatar (the UI falls back to the initial). An older main
   * process without the avatar field also yields null instead of an error.
   */
  avatar: string | null
  /** A sync action is in progress (the account area shows a small spinner) */
  syncing: boolean
  /** Latest upload progress (consumed by the upload modal; null when nothing is uploading) */
  uploadProgress: LatticeUploadProgress | null
  clearUploadProgress: () => void
  refresh: () => Promise<LatticeStatus>
  login: (input: LatticeLoginInput) => Promise<LatticeLoginResult>
  logout: () => Promise<{ ok: boolean }>
  /** Manual sync (direction defaults to both; `installMissing` defaults to the setting, auto-fill enabled by default) */
  sync: (
    direction?: LatticeSyncDirection,
    options?: { installMissing?: boolean }
  ) => Promise<LatticeSyncResult>
  /** Sync details: per-item auto-fill success/failure from the last sync + orphaned records (failure reasons are viewable) */
  syncDetails: () => Promise<LatticeSyncDetails>
  /** Persist the "auto-install missing plugins" toggle (default on) */
  setAutoInstallMissing: (enabled: boolean) => Promise<LatticeAutoInstallSettingResult>
  listHub: (params?: LatticeListQuery) => Promise<HubListResultV2>
  detailHub: (pluginId: string) => Promise<HubDetailV2 | null>
  installFromHub: (pluginId: string, version?: string) => Promise<LatticeInstallResultV2>
  /** Publish a locally installed plugin directly (package + source, no directory picker) */
  publishInstalled: (pluginId: string) => Promise<LatticeUploadResult>
  pickAndUpload: () => Promise<LatticeUploadResult>
  /** Publish by picking a .zip package (an alternative entry point to directory upload) */
  pickAndUploadZip: () => Promise<LatticeUploadResult>
  /** Publish by picking "package directory + source directory": package and source are two different zips */
  pickAndUploadWithSource: () => Promise<LatticeUploadResult>
  /** Publish from explicit paths: `source` is the package directory/zip; when `sourcePath` is given, the source uploads separately */
  uploadSource: (source: string, sourcePath?: string) => Promise<LatticeUploadResult>

  // ---- v2 API: source / republish / import local plugin directory ----
  /** Which v2 capabilities the current main process supports (false = older main process; the matching entries are disabled with a hint) */
  capabilities: LatticeV2Capabilities
  /** Locally downloaded source directory (not downloaded / no source → path:null) */
  sourcePath: (pluginId: string) => Promise<LatticeSourcePathResult>
  /** Local install directory (`userData/plugins/<id>`, used to publish a locally installed plugin; null when unavailable) */
  localSource: (pluginId: string) => Promise<string | null>
  /** Open source: prefer creating/reusing a workspace and plugin conversation, falling back to the file manager on failure */
  openSource: (pluginId: string) => Promise<LatticeOpenSourceResult>
  /** Read the local source directory, repackage the package + source, and publish a new version */
  republish: (input: LatticeRepublishInput) => Promise<LatticeRepublishResult>
  /** Download a version's package / source archive (the main process shows a save dialog and writes to disk) */
  downloadAsset: (
    pluginId: string,
    version: string,
    kind: LatticeDownloadKind
  ) => Promise<LatticeDownloadResult>
  /** Show a directory picker and publish every plugin.json plugin under it to the plugin center in bulk */
  importLocalDir: () => Promise<LatticeImportLocalDirResult>
}

/** Safe to call without a provider (or before it initializes): always takes the "unavailable" branch */
const LATTICE_FALLBACK: LatticeContextValue = {
  available: false,
  ready: false,
  status: EMPTY_LATTICE_STATUS,
  loggedIn: false,
  user: undefined,
  role: undefined,
  avatar: null,
  syncing: false,
  uploadProgress: null,
  clearUploadProgress: () => {},
  refresh: async () => EMPTY_LATTICE_STATUS,
  login: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  logout: async () => ({ ok: false }),
  sync: async () => emptySyncResult(LATTICE_BRIDGE_MISSING),
  syncDetails: async () => ({ last: null, conflicts: [], orphaned: [] }),
  setAutoInstallMissing: async () => ({ ok: false, enabled: true, error: LATTICE_BRIDGE_MISSING }),
  listHub: async () => EMPTY_HUB_LIST,
  detailHub: async () => null,
  installFromHub: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  publishInstalled: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  pickAndUpload: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  pickAndUploadZip: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  pickAndUploadWithSource: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  uploadSource: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  capabilities: {
    publishInstalled: false,
    sourcePath: false,
    openSource: false,
    republish: false,
    localSource: false,
    downloadAsset: false,
    importLocalDir: false
  },
  sourcePath: async () => ({ path: null }),
  localSource: async () => null,
  openSource: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  republish: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  downloadAsset: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING }),
  importLocalDir: async () => ({ ok: false, error: LATTICE_BRIDGE_MISSING })
}

export const LatticeContext = createContext<LatticeContextValue>(LATTICE_FALLBACK)
