/**
 * Lattice plugin center: renderer-side types.
 *
 * **The source of truth for the DTOs is `src/main/lattice/types.ts`** (types shared by main /
 * preload / renderer); this file only re-exports types so the renderer and the main process do
 * not drift into two separate definitions (type-only imports are fully erased at build time, so
 * no main-process code ends up in the renderer bundle).
 *
 * The v2 DTOs (source package / republish / asset download / import local plugin directory) have
 * landed in `src/main/lattice/types.ts`, so the renderer reuses them directly;
 * `lattice/source.ts` keeps only the **runtime capability detection** (on an older main process /
 * preload these methods may still be undefined, and the UI disables entries based on capabilities).
 *
 * This file additionally provides:
 * - `LatticeApi`: takes the official preload bridge type directly, so a preload signature change
 *   fails compilation here immediately;
 * - `LatticeV2Methods` / `LatticeV2CapabilityKey`: the optional shape of the v2 methods, used only
 *   for runtime capability detection;
 * - `EMPTY_LATTICE_STATUS` / `EMPTY_HUB_LIST` / `emptySyncResult()`: safe fallback values when the
 *   main-process channel is missing.
 */
import type {
  HubDetail,
  HubEntry,
  HubListResult,
  HubVersion,
  LatticeDownloadAssetKind,
  LatticeDownloadAssetResult,
  LatticeImportLocalDirResult,
  LatticeInstallResult,
  LatticeLocalSourcePathResult,
  LatticeOpenSourceResult,
  LatticeRepublishInput,
  LatticeRepublishResult,
  LatticeSourcePathResult,
  LatticeStatus,
  LatticeSyncResult,
  LatticeUploadResult
} from '../../../main/lattice/types'

export type {
  HubDetail,
  HubEntry,
  HubListResult,
  HubVersion,
  LatticeAutoInstallSettingResult,
  LatticeDownloadAssetKind,
  LatticeDownloadAssetResult,
  LatticeImportLocalDirResult,
  LatticeImportLocalItem,
  LatticeImportLocalSkipped,
  LatticeInstallResult,
  LatticeInstallSummary,
  LatticeListQuery,
  LatticeLocalSourcePathResult,
  LatticeLoginInput,
  LatticeLoginResult,
  LatticeMeResult,
  LatticeOpenSourceResult,
  LatticeRepublishInput,
  LatticeRepublishResult,
  LatticeSetBaseUrlResult,
  LatticeSourceManaged,
  LatticeSourcePathResult,
  LatticeStatus,
  LatticeSyncAutoInstallFailure,
  LatticeSyncAutoInstallItem,
  LatticeSyncAutoInstallResult,
  LatticeSyncDetails,
  LatticeSyncDirection,
  LatticeSyncInput,
  LatticeSyncOrphanedItem,
  LatticeSyncOrphanReason,
  LatticeSyncOptions,
  LatticeSyncResult,
  LatticeSyncConflict,
  LatticeResolveConflictResult,
  LatticeSyncSummary,
  LatticeUploadProgress,
  LatticeUploadResult,
  LatticeUser
} from '../../../main/lattice/types'

/**
 * Shape of the `window.api.lattice` bridge: **the official preload type is used directly**
 * (`Window['api']['lattice']`, declared by `src/preload/index.d.ts`, with the DTOs sourced from
 * `src/main/lattice/types.ts`).
 *
 * This way the renderer does not hand-write a bridge interface: a preload signature change (for
 * example `sourcePath(pluginId)`) fails compilation here immediately instead of surfacing at
 * runtime. `getLatticeBridge()` handles runtime bridge detection (null when the main process has
 * not registered the channel / an older preload is running, and the UI degrades safely).
 */
export type LatticeApi = Window['api']['lattice']

/** v1 bridge + v2 additions (the v2 methods are required in the main-process types; runtime capability detection still treats them as optional) */
export type LatticeBridgeV2 = LatticeApi

// ---------------------------------------------------------------------------
// Page aliases for the v2 API: reuse the main-process / preload types once they land, avoiding
// two DTO sets drifting apart
// ---------------------------------------------------------------------------

/** Catalog entry (including the v2 `has_source` field) */
export type HubEntryV2 = HubEntry
/** Version object (including v2 source package metadata) */
export type HubVersionV2 = HubVersion
/** Details (readme + version list + my install records) */
export type HubDetailV2 = HubDetail
/** Catalog page result */
export type HubListResultV2 = HubListResult
/** Install result (v2 adds sourcePath / sourceManaged / sourceError; a source failure does not affect the install) */
export type LatticeInstallResultV2 = LatticeInstallResult
/** Asset kind to download (package / source archive) */
export type LatticeDownloadKind = LatticeDownloadAssetKind
/** Asset download result */
export type LatticeDownloadResult = LatticeDownloadAssetResult
/** Local install directory (`lattice:local-source-path`) */
export type LatticeLocalSourceResult = LatticeLocalSourcePathResult

/**
 * Incremental bridge methods for the v2 API (**optional shape, used only for runtime capability
 * detection**).
 *
 * Once the main-process types land these methods are required on `window.api.lattice`; a
 * **running older main process / preload** still lacks them. `detectLatticeV2Capabilities()`
 * checks `typeof === 'function'` per method, and pages disable entries with a hint based on the
 * result instead of hitting a runtime `not a function`.
 */
export interface LatticeV2Methods {
  /** Publish a locally installed plugin directly (package + source, no directory picker) */
  publishInstalled?: (pluginId: string) => Promise<LatticeUploadResult>
  /** Local source directory (path/version/managed) */
  sourcePath?: (pluginId: string) => Promise<LatticeSourcePathResult>
  /** Local installed plugin package directory (userData/plugins/<id>) */
  localSource?: (pluginId: string) => Promise<LatticeLocalSourceResult>
  /** Open source: prefer a plugin conversation, falling back to the file manager */
  openSource?: (pluginId: string) => Promise<LatticeOpenSourceResult>
  /** Read the local source directory, repackage (package + source), and publish a new version */
  republish?: (input: LatticeRepublishInput) => Promise<LatticeRepublishResult>
  /** Download a version's package / source archive (the main process shows a save dialog) */
  downloadAsset?: (
    pluginId: string,
    version: string,
    kind: LatticeDownloadKind
  ) => Promise<LatticeDownloadResult>
  /** Show a directory picker and publish every plugin.json plugin under it to the plugin center in bulk */
  importLocalDir?: () => Promise<LatticeImportLocalDirResult>
}

/** v2 capability keys (the key set of `LatticeV2Capabilities`) */
export type LatticeV2CapabilityKey = keyof LatticeV2Methods

/** Safe fallback status when the main process has not registered the lattice channel (not an error: the UI degrades to "plugin center not ready") */
export const EMPTY_LATTICE_STATUS: LatticeStatus = {
  configured: false,
  baseUrl: '',
  loggedIn: false
}

export const EMPTY_HUB_LIST: HubListResultV2 = {
  items: [],
  total: 0,
  page: 1,
  page_size: 0
}

/** Fallback result for a failed/unavailable sync (all fields present; the UI checks error before showing counts) */
export function emptySyncResult(error?: string): LatticeSyncResult {
  return { at: 0, pushed: 0, pulled: 0, conflicts: 0, error }
}
