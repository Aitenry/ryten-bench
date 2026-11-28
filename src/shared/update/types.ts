/**
 * Shared contract between the main-process update service, the preload bridge and the renderer.
 *
 * The renderer only ever sees this snapshot; it does not know whether the bytes came from GitHub
 * or (later) Lattice. That is the job of the `UpdateSource` abstraction in `src/main/update`.
 */
export type AppUpdateStage = 'idle' | 'available' | 'downloading' | 'ready' | 'restarting'

export interface AppUpdateState {
  stage: AppUpdateStage
  /** Version currently running (app.getVersion()). */
  currentVersion: string
  /** Version offered by the update source, when known. */
  version?: string
  /**
   * True when the source offers the **same version** with different content (a same-version
   * rebuild). The UI labels it "content update" instead of showing an identical version arrow.
   */
  contentUpdate?: boolean
  /** Download progress, 0–100 (rounded in the UI as needed). */
  progress?: number
  /** Updater source id, e.g. "github" / "lattice". Useful for diagnostics. */
  source?: string
  /** Last (non-fatal) updater failure. The renderer can show it in the tooltip. */
  error?: string
  /** ISO timestamp of the last successful update check. */
  checkedAt?: string
}

export const APP_UPDATE_CHANNELS = {
  getState: 'app-update-get-state',
  check: 'app-update-check',
  download: 'app-update-download',
  restart: 'app-update-restart',
  /** Main -> renderer snapshot push */
  stateChanged: 'app-update-state-changed'
} as const
