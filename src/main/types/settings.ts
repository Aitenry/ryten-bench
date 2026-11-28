/**
 * Lock screen settings (persisted form).
 *
 * `code` is the **unlock code digest**, used only in the main process: the renderer receives a
 * `LockScreenSnapshot` through the `lock-screen-*` channels (hasCode only, never the digest
 * itself), so it cannot be brute-forced offline (see `src/main/lock/credentials.ts`).
 *
 * `code` stays optional to remain compatible with old settings files from before the lock screen
 * was ever initialized; if it cannot be read, treat the code as unset.
 */
export interface Lock {
  /**
   * `scrypt$N$r$p$salt$hash`; older versions stored a bare MD5 of a 6-digit code and are upgraded
   * automatically after the first successful verification.
   */
  code?: string
  /** Whether the lock screen is enabled (manual lock via Esc / idle auto-lock) */
  view: boolean
  /** Idle minutes before auto-locking; 0 = off, 5 minutes when unset (see lock/constants.ts) */
  autoLockMinutes?: number
}

/** Lock screen snapshot readable by the renderer (**never contains** the unlock code digest) */
export interface LockScreenSnapshot {
  /** The "enable lock screen" setting (expresses user intent only, not the current lock state) */
  enabled: boolean
  /** Whether an unlock code has been set (without one, locking is refused so the UI stays reachable) */
  hasCode: boolean
  /** Whether the factory default code 123456 is still in use (the settings page prompts to change it) */
  usingDefaultCode: boolean
  /** Auto-lock duration in minutes, 0 = off; values defined in lock/constants.ts */
  autoLockMinutes: number
  /** Whether the lock screen is currently active (owned by the main process, survives reload/crash) */
  locked: boolean
}

export type LockUnlockFailure = 'invalid' | 'throttled' | 'unavailable'

export interface LockUnlockResult {
  ok: boolean
  reason?: LockUnlockFailure
  /** How long to wait when reason=throttled (milliseconds) */
  retryAfterMs?: number
  /** Remaining attempts that do not wait after this failure */
  attemptsLeft?: number
}

export type LockCodeChangeFailure = 'wrong-old' | 'invalid-new' | 'unavailable'

export interface LockCodeChangeResult {
  ok: boolean
  reason?: LockCodeChangeFailure
}

export interface GraphSettings {
  maxConcurrency: number
  enableGleaning: boolean
  gleaningThreshold: number
  maxChunkSize: number
}

/**
 * The sidebar's "current entry" for one side: workspace id (for the plugin side, its plugin
 * workspace id) plus the selected session id.
 * `topicId` null = a blank session in that workspace (no message sent yet, topic row not persisted).
 */
export interface HarnessContentRef {
  workspaceId: number
  topicId: number | null
}

/**
 * Which side the sidebar is on:
 * - `work`: work (workspace → session);
 * - `chat`: **chat** (no workspace concept, just one session list; the app ships a directory
 *   initialized by the system);
 * - `plugin`: plugins (drafts in the plugin workshop).
 *
 * History: the `work` value used to be called `'chat'` (before chat mode existed). After the
 * rename, old `'chat'` values may still be stored on disk — the renderer normalizes them to
 * `'work'` on read (see restoreLastContent in HarnessSidebar), so no data migration is needed.
 */
export type HarnessSidebarMode = 'work' | 'chat' | 'plugin'

export interface HarnessSettings {
  /**
   * Skills storage directory; empty/unset means disabled. Every subdirectory containing SKILL.md
   * is one skill.
   * Pre-seeded on first launch as `<install dir>/data/skills` (falls back to
   * `<userData>/data/skills` when the install directory is not writable); when the user points it
   * elsewhere, existing skills are migrated to the new location.
   */
  skillsPath?: string
  /** Enabled skill IDs; undefined = all enabled, [] = all disabled */
  enabledSkills?: string[]
  /** AI workspace directory, mounted as the FilesystemBackend root (virtual /); falls back to skillsPath when unset */
  workspacePath?: string
  /** Currently active workspace ID, used to filter topics by workspace */
  activeWorkspaceId?: number
  /**
   * Which side the sidebar is on plus each side's "current entry" — **restored after a restart**.
   *
   * Supersedes the earlier "the mode toggle is not persisted" decision: back then the content
   * could not be restored, so persisting the mode alone would let the toggle disagree with the
   * main area (the sidebar listed plugins while the content was still a work session); now each
   * side's content is stored too, so the toggle follows the restored content and both stay
   * consistent. When a reference no longer resolves (deleted session/workspace/plugin), fall back
   * to that side's default target without raising an error.
   */
  activeMode?: HarnessSidebarMode
  /** Current entry of work mode (null if never selected) */
  workContent?: HarnessContentRef | null
  /** Current entry of chat mode (its workspaceId is the chat workspace initialized by the app) */
  chatContent?: HarnessContentRef | null
  /** Current entry of plugin mode (includes which plugin; null if never selected) */
  pluginContent?: (HarnessContentRef & { pluginId: string }) | null
  /**
   * Memory storage root; empty/unset means disabled. Memories are isolated per workspace ID
   * (`workspace-<id>/`), one independent set per workspace.
   * Pre-seeded on first launch as `<install dir>/data/memory` (falls back to
   * `<userData>/data/memory` when the install directory is not writable); when the user points it
   * elsewhere, all existing memories are migrated to the new location.
   */
  memoryPath?: string
  /**
   * **Plugin storage path** (source root of all plugins in the plugin workshop).
   *
   * Pre-seeded on first launch as `<install dir>/data/plugins` (falls back to
   * `<userData>/data/plugins` when the install directory is not writable), so the workshop works
   * out of the box; the user may point it at any writable directory, and plugin sources are
   * migrated there from the old path (a file with the same name keeps the target copy, the old one
   * is kept as `*.migrated-*`, never overwritten).
   *
   * Each plugin occupies one subdirectory (`<pluginsPath>/<plugin id>/`); the root itself is never
   * deleted.
   */
  pluginsPath?: string
  /**
   * Internal flag: whether the **default storage layout based on the install directory** has been
   * applied.
   *
   * Written only once. With it, after the user clears a path in settings (= disables that
   * capability), later launches no longer force the default back in; existing users upgrading
   * with memory/skills directories already configured only get the still-empty entries filled in,
   * and an existing choice is never overridden.
   */
  storageDefaultsApplied?: boolean
}

export type ThemeMode = 'light' | 'dark' | 'auto'

/**
 * UI language. Only "Simplified Chinese / English": when never chosen, the entry matching the OS
 * language is selected by default, so there is no separate "follow system" option.
 */
export type AppLanguage = 'zh-CN' | 'en-US'

/** System tray settings */
export interface TraySettings {
  /** Minimize to the system tray on window close (default on); when off, the app quits completely */
  closeToTray: boolean
}

export interface SystemSettings {
  ip?: Record<string, unknown>
  lock: Lock
  graph: GraphSettings
  harness: HarnessSettings
  defaultModelId?: number
  defaultEmbeddingModelId?: number
  musicDirectory?: string
  theme?: ThemeMode
  /** UI language; when unset, the entry matching the OS language is used */
  language?: AppLanguage
  /** System tray settings */
  tray?: TraySettings
  /** Cached weather data */
  weatherData?: Record<string, unknown>
  /** Automatic weather refresh interval in minutes, default 60 */
  weatherRefreshInterval?: number
  /** Timestamp of the last weather data fetch */
  weatherLastFetched?: number
}
