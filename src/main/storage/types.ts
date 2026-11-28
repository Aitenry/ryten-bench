import type { HarnessSettings } from '../types/settings'

/**
 * The three built-in "user data storage" kinds: memory / plugins / skills.
 *
 * Each is an absolute path in `HarnessSettings`; empty means that capability is disabled.
 * On first launch they are seeded under the **software install directory** (`<install dir>/data/<kind>`),
 * and when the user changes a path the data in the old directory is migrated to the new one
 * (see `./migration.ts`).
 */
export const STORAGE_KINDS = ['memory', 'plugins', 'skills'] as const

export type StorageKind = (typeof STORAGE_KINDS)[number]

/**
 * Directory name of each kind under the default data root (matching the user-facing layout:
 * data/memory, data/plugins, data/skills)
 */
export const STORAGE_DIR_NAMES: Record<StorageKind, string> = {
  memory: 'memory',
  plugins: 'plugins',
  skills: 'skills'
}

/**
 * The `HarnessSettings` field for each kind (single source of truth — do not hand-write the strings
 * again)
 */
export const STORAGE_SETTING_KEYS = {
  memory: 'memoryPath',
  plugins: 'pluginsPath',
  skills: 'skillsPath'
} as const

/** Can only be one of these three keys (used for narrow-typed `harness[key]` indexing) */
export type StorageSettingKey = (typeof STORAGE_SETTING_KEYS)[StorageKind]

/** Human-readable names for errors/logs */
export const STORAGE_LABELS: Record<StorageKind, string> = {
  memory: '记忆',
  plugins: '插件',
  skills: '技能'
}

/**
 * Read the currently configured path for a kind (empty string = not configured; trims whitespace so
 * blanks are not treated as a path)
 */
export function storagePathOf(
  harness: HarnessSettings | null | undefined,
  kind: StorageKind
): string {
  const value = harness?.[STORAGE_SETTING_KEYS[kind]]
  return typeof value === 'string' ? value.trim() : ''
}
